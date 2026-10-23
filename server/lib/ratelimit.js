// Traffic restriction layer. General-purpose limits use express-rate-limit
// keyed by the rotating IP-hash (never the raw IP). The upload quota is a
// separate SQLite-backed rolling window because it must survive server
// restarts and express-rate-limit's in-memory store does not.
'use strict';

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const db = require('../db');
const config = require('../config');
const { hashIp, hashIpBothPeriods } = require('./iphash');

// express-rate-limit calls keyGenerator(req, res); we only need req.
// Routing the raw IP through their ipKeyGenerator() first normalizes IPv6
// addresses to a /56 subnet (avoiding the "every address in a /64 gets its
// own limit" bypass) before we hash it into our rotating IP-hash token.
function ipHashKeyGenerator(req) {
  const rawIp = req.ip || req.socket?.remoteAddress || 'unknown';
  const normalized = rawIp === 'unknown' ? rawIp : ipKeyGenerator(rawIp);
  return hashIp(normalized);
}

const readLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: (req, res) => config.get('read_limit_per_15min'),
  keyGenerator: ipHashKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' }
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: (req, res) => config.get('write_limit_per_min'),
  keyGenerator: ipHashKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' }
});

const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: (req, res) => config.get('report_limit_per_hour'),
  keyGenerator: ipHashKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many reports. Please slow down.' }
});

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  keyGenerator: ipHashKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.' }
});

// Blanket ceiling for the admin API. Login has its own much tighter limit;
// this one bounds everything behind the session check, so a stolen or
// guessed-at session cookie can't be used to hammer the panel's heavier
// endpoints (analytics, reputation, chain verification) unthrottled. Set
// well above what a human clicking through the panel generates.
const adminApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  keyGenerator: ipHashKeyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many admin requests. Please slow down.' }
});

/** Picks a limiter by HTTP method. Routers that serve both a public feed and
 * a write endpoint need the generous read budget for GETs without handing
 * that same budget to POSTs. */
function byMethod({ read, write }) {
  return (req, res, next) =>
    (req.method === 'GET' || req.method === 'HEAD' ? read : write)(req, res, next);
}

const insertUploadEvent = db.prepare('INSERT INTO upload_events (iphash, created_at) VALUES (?, ?)');
const countUploadEvents = db.prepare(
  'SELECT COUNT(*) AS n FROM upload_events WHERE iphash IN (?, ?) AND created_at > ?'
);
const pruneUploadEvents = db.prepare('DELETE FROM upload_events WHERE created_at < ?');

/** Middleware: enforces "N uploads per rolling hour per IP-hash" using a
 * durable SQLite counter (so it survives restarts, unlike an in-memory
 * limiter). Records the event only after the handler succeeds -- call
 * `req.recordUpload()` from the route once the upload is accepted. */
function uploadQuota(req, res, next) {
  const rawIp = req.ip || req.socket?.remoteAddress || 'unknown';
  const ip = rawIp === 'unknown' ? rawIp : ipKeyGenerator(rawIp);
  const [curHash, prevHash] = hashIpBothPeriods(ip);
  const windowStart = Date.now() - 60 * 60 * 1000;
  pruneUploadEvents.run(windowStart - 60 * 60 * 1000); // keep ~2h of history max
  const { n } = countUploadEvents.get(curHash, prevHash || curHash, windowStart);
  const limit = config.get('upload_limit_per_hour');
  if (n >= limit) {
    return res.status(429).json({ error: `Upload limit reached (${limit} per hour). Try again later.` });
  }
  req.recordUpload = () => insertUploadEvent.run(curHash, Date.now());
  next();
}

module.exports = {
  readLimiter,
  writeLimiter,
  reportLimiter,
  adminLoginLimiter,
  adminApiLimiter,
  byMethod,
  uploadQuota
};
