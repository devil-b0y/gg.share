'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const config = require('./config');
require('./db'); // ensures schema is created before anything else touches it

// Ensure the full uploads/ tree exists before any route module loads. On a
// fresh checkout none of these directories exist yet -- without this, the
// first upload crashes with ENOENT the moment posts.js writes into
// uploads/pending/.
const UPLOADS_ROOT = path.join(__dirname, '..', 'uploads');
for (const dir of ['live', 'pending', 'quarantine']) {
  fs.mkdirSync(path.join(UPLOADS_ROOT, dir), { recursive: true });
}

const app = express();
if (config.TRUST_PROXY) app.set('trust proxy', config.TRUST_PROXY);

// --- security headers ------------------------------------------------------
// Strict, self-only CSP: nothing on this site ever needs to load from a
// third-party origin (no CDN fonts, no analytics, no external scripts).
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      mediaSrc: ["'self'", 'blob:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"]
    }
  },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  referrerPolicy: { policy: 'no-referrer' }
}));
app.disable('x-powered-by');

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));

// Minimal built-in cookie parser -- only the admin session cookie is ever
// set on this site, so a full cookie-parser dependency isn't needed.
app.use((req, res, next) => {
  req.cookies = {};
  const header = req.headers.cookie;
  if (header) {
    for (const part of header.split(';')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k) req.cookies[k] = decodeURIComponent(v);
    }
  }
  next();
});
app.use((req, res, next) => {
  res.cookie = (name, value, opts = {}) => {
    const segments = [`${name}=${encodeURIComponent(value)}`];
    if (opts.maxAge) segments.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
    segments.push('Path=/');
    if (opts.httpOnly) segments.push('HttpOnly');
    if (opts.sameSite) segments.push(`SameSite=${opts.sameSite[0].toUpperCase()}${opts.sameSite.slice(1)}`);
    if (opts.secure) segments.push('Secure');
    res.append('Set-Cookie', segments.join('; '));
    return res;
  };
  res.clearCookie = (name) => {
    res.append('Set-Cookie', `${name}=; Path=/; Max-Age=0`);
    return res;
  };
  next();
});

// No access logging by default -- keeps request metadata (paths, UAs,
// timing) out of any log file. Enable Express's own logger manually if you
// need debugging, understanding this trades off the anonymity guarantee.

const { readLimiter, writeLimiter, reportLimiter } = require('./lib/ratelimit');

app.use('/api/posts', readLimiter);
app.use('/api/comments', readLimiter);
app.use('/api/likes', writeLimiter);
app.use('/api/dislikes', writeLimiter);
app.use('/api/reports', reportLimiter);

app.use('/api/posts', require('./routes/posts'));
app.use('/api/comments', require('./routes/comments'));
app.use('/api/likes', require('./routes/likes'));
app.use('/api/dislikes', require('./routes/dislikes'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/chain', require('./routes/chain'));
app.use('/api/admin', require('./routes/admin'));

// Public media: only the "live" directory is exposed here. Anything still
// pending, in review, or quarantined is only reachable through the
// authenticated admin media route.
const LIVE_DIR = path.join(UPLOADS_ROOT, 'live');
// Media filenames are the content's own SHA-256, so a given URL can never
// change meaning -- safe to cache immutably and skip revalidation entirely.
app.use('/media', express.static(LIVE_DIR, {
  maxAge: '365d',
  immutable: true,
  fallthrough: false
}));

// Static frontend
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.use((req, res) => res.status(404).json({ error: 'not found' }));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'request too large' });
  }
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

const { startPurgeSweep } = require('./lib/queue');
startPurgeSweep();

app.listen(config.PORT, () => {
  console.log(`anon-share listening on http://localhost:${config.PORT}`);
  const { hasAdminPassword } = require('./lib/auth');
  if (!hasAdminPassword()) {
    console.warn('No admin password set yet. Run: npm run setup');
  }
});
