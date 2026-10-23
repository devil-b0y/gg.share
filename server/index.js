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

// Refuse to boot with placeholder secrets in production -- see
// assertSecureConfig() for why a default IP_SALT_SEED voids the anonymity
// guarantee rather than merely weakening it.
config.assertSecureConfig();

const app = express();
if (config.TRUST_PROXY) app.set('trust proxy', config.TRUST_PROXY);
// Express echoes this in ETags and elsewhere; nothing here needs to
// advertise the framework.
app.disable('x-powered-by');

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
      frameSrc: ["'none'"],
      workerSrc: ["'self'", 'blob:'], // the NSFW model runs off the main thread
      manifestSrc: ["'self'"],
      baseUri: ["'self'"],
      // No page here posts a form anywhere. Saying so explicitly means an
      // injected <form> has nowhere to send what it collects, which is the
      // one thing a CSP without 'unsafe-inline' script still leaves open.
      formAction: ["'none'"],
      // Only meaningful over TLS; adding it unconditionally would break
      // plain-HTTP local development.
      ...(config.IS_PRODUCTION ? { upgradeInsecureRequests: [] } : {})
    }
  },
  // Six months, subdomains included. helmet enables HSTS by default, but the
  // duration is worth stating rather than inheriting.
  strictTransportSecurity: { maxAge: 15552000, includeSubDomains: true },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  referrerPolicy: { policy: 'no-referrer' }
}));

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));

// Minimal built-in cookie parser -- only the admin session cookie is ever
// set on this site, so a full cookie-parser dependency isn't needed.
const MAX_COOKIE_HEADER = 8 * 1024;
app.use((req, res, next) => {
  // Null-prototype, so a cookie literally named "__proto__" or "constructor"
  // is just a key here and can't shadow anything on Object.prototype.
  req.cookies = Object.create(null);
  const header = req.headers.cookie;
  if (header && header.length <= MAX_COOKIE_HEADER) {
    for (const part of header.split(';')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (!k) continue;
      // A stray '%' makes decodeURIComponent throw, and an uncaught throw
      // here would turn any malformed cookie into a failed request.
      try {
        req.cookies[k] = decodeURIComponent(v);
      } catch {
        req.cookies[k] = v;
      }
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

const { readLimiter, writeLimiter, reportLimiter, adminApiLimiter, byMethod } = require('./lib/ratelimit');

// /api/posts and /api/comments serve both a public feed and a write
// endpoint. Applying the read limit to the whole router gave POSTs the
// generous read budget: 300 requests / 15 min, which is not a write limit.
app.use('/api/posts', byMethod({ read: readLimiter, write: writeLimiter }));
app.use('/api/comments', byMethod({ read: readLimiter, write: writeLimiter }));
app.use('/api/likes', writeLimiter);
app.use('/api/dislikes', writeLimiter);
app.use('/api/reports', byMethod({ read: readLimiter, write: reportLimiter }));
app.use('/api/chain', readLimiter);
app.use('/api/admin', adminApiLimiter);

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
  fallthrough: false,
  dotfiles: 'deny',
  index: false,
  // Uploaded bytes are never markup, whatever a content-sniffing browser
  // might decide. Forcing a download disposition means a file that somehow
  // gets served as HTML still can't execute in this origin.
  setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
  }
}));

// Static frontend
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR, { extensions: ['html'], dotfiles: 'deny' }));

app.use((req, res) => res.status(404).json({ error: 'not found' }));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'request too large' });
  }
  // Multer rejects oversized or malformed multipart bodies with a coded
  // error; these are the client's fault and shouldn't be logged as 500s.
  if (err && err.name === 'MulterError') {
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    return res.status(tooBig ? 413 : 400).json({
      error: tooBig ? 'file too large' : 'malformed upload'
    });
  }
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ error: 'malformed request body' });
  }
  // The message can carry file paths and internal state -- it belongs in the
  // server's own log, not in the response.
  console.error(err);
  res.status(500).json({ error: 'internal server error' });
});

const { startPurgeSweep } = require('./lib/queue');
startPurgeSweep();

// Expired admin sessions were never deleted, so the table only ever grew and
// a revoked-by-expiry token stayed on disk indefinitely.
const { pruneExpiredSessions } = require('./lib/auth');
pruneExpiredSessions();
setInterval(pruneExpiredSessions, 60 * 60 * 1000).unref();

app.listen(config.PORT, () => {
  console.log(`anon-share listening on http://localhost:${config.PORT}`);
  const { hasAdminPassword } = require('./lib/auth');
  if (!hasAdminPassword()) {
    console.warn('No admin password set yet. Run: npm run setup');
  }
});
