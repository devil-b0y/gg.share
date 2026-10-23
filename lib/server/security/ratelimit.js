// Traffic restriction layer.
//
// General-purpose limits are fixed-window counters keyed by the rotating
// IP-hash (never the raw IP), held in memory. The upload quota is a separate
// SQLite-backed rolling window because it must survive server restarts and
// an in-memory store does not.
//
// This replaces express-rate-limit. Route handlers apply a limiter through
// the `limit` option of lib/server/http/route.js, which also writes the
// standard draft-6 RateLimit-* headers that express-rate-limit used to send.
'use strict';

const db = require('../core/db');
const settings = require('../core/settings');
const { hashIp, hashIpBothPeriods, normalizeIp } = require('./iphash');

// Counters live on globalThis so every route bundle Next.js produces shares
// one set of buckets. Separate copies would multiply every limit by the
// number of bundles a client spreads its requests across.
const STORES_KEY = Symbol.for('anon-share.ratelimit-stores');
const stores = globalThis[STORES_KEY] || (globalThis[STORES_KEY] = new Map());

/**
 * Creates a named fixed-window limiter.
 *
 * @param {object}              opts
 * @param {string}              opts.name     unique store name
 * @param {number}              opts.windowMs window length
 * @param {number|() => number} opts.limit    max hits per window; a function
 *                                            is re-read on every hit so admin
 *                                            setting changes apply immediately
 * @param {string}              opts.message  error text for the 429 response
 */
function createLimiter({ name, windowMs, limit, message }) {
  if (!stores.has(name)) stores.set(name, { buckets: new Map(), lastSweep: 0 });
  const store = stores.get(name);

  /** Records one hit for `key` and reports whether it is within the limit. */
  function hit(key, now = Date.now()) {
    sweep(now);
    let bucket = store.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      store.buckets.set(key, bucket);
    }
    bucket.count++;

    const max = typeof limit === 'function' ? limit() : limit;
    return {
      ok: bucket.count <= max,
      limit: max,
      remaining: Math.max(0, max - bucket.count),
      resetMs: bucket.resetAt - now
    };
  }

  /** Expired buckets are dropped once per window, so memory tracks recent
   * clients rather than every client ever seen. */
  function sweep(now) {
    if (now - store.lastSweep < windowMs) return;
    store.lastSweep = now;
    for (const [key, bucket] of store.buckets) {
      if (bucket.resetAt <= now) store.buckets.delete(key);
    }
  }

  /** Clears every bucket. Used by tests. */
  function reset() {
    store.buckets.clear();
  }

  return { name, windowMs, message, hit, reset };
}

/** The bucket key for a client: its normalized address, hashed with the
 * rotating salt so raw IPs never sit in memory as map keys. */
function limiterKey(ip) {
  return hashIp(normalizeIp(ip));
}

/** draft-6 RateLimit headers (what express-rate-limit's `standardHeaders:
 * true` produced), plus Retry-After when the request was refused. */
function limitHeaders(result, windowMs) {
  const resetSec = Math.ceil(result.resetMs / 1000);
  const headers = {
    'RateLimit-Policy': `${result.limit};w=${Math.ceil(windowMs / 1000)}`,
    'RateLimit-Limit': String(result.limit),
    'RateLimit-Remaining': String(result.remaining),
    'RateLimit-Reset': String(resetSec)
  };
  if (!result.ok) headers['Retry-After'] = String(resetSec);
  return headers;
}

// --- the limiters this app uses ---------------------------------------------

const readLimiter = createLimiter({
  name: 'read',
  windowMs: 15 * 60 * 1000,
  limit: () => settings.get('read_limit_per_15min'),
  message: 'Too many requests. Please slow down.'
});

const writeLimiter = createLimiter({
  name: 'write',
  windowMs: 60 * 1000,
  limit: () => settings.get('write_limit_per_min'),
  message: 'Too many requests. Please slow down.'
});

const reportLimiter = createLimiter({
  name: 'report',
  windowMs: 60 * 60 * 1000,
  limit: () => settings.get('report_limit_per_hour'),
  message: 'Too many reports. Please slow down.'
});

const adminLoginLimiter = createLimiter({
  name: 'admin-login',
  windowMs: 15 * 60 * 1000,
  limit: 5,
  message: 'Too many login attempts. Try again later.'
});

// Blanket ceiling for the admin API. Login has its own much tighter limit;
// this one bounds everything behind the session check, so a stolen or
// guessed-at session cookie can't be used to hammer the panel's heavier
// endpoints (analytics, reputation, chain verification) unthrottled. Set
// well above what a human clicking through the panel generates.
const adminApiLimiter = createLimiter({
  name: 'admin-api',
  windowMs: 15 * 60 * 1000,
  limit: 600,
  message: 'Too many admin requests. Please slow down.'
});

// --- durable upload quota ---------------------------------------------------

const insertUploadEvent = db.prepare('INSERT INTO upload_events (iphash, created_at) VALUES (?, ?)');
const countUploadEvents = db.prepare(
  'SELECT COUNT(*) AS n FROM upload_events WHERE iphash IN (?, ?) AND created_at > ?'
);
const pruneUploadEvents = db.prepare('DELETE FROM upload_events WHERE created_at < ?');

/**
 * Enforces "N uploads per rolling hour per IP-hash" using a durable SQLite
 * counter. Checked *before* the multipart body is read, so an over-quota
 * client can't make the server buffer a 100 MB upload first.
 *
 * Returns { allowed, limit, record }. Call `record()` only once the upload
 * has actually been accepted -- rejected uploads don't count against the
 * quota.
 */
function checkUploadQuota(ip) {
  const [curHash, prevHash] = hashIpBothPeriods(normalizeIp(ip));
  const windowStart = Date.now() - 60 * 60 * 1000;
  pruneUploadEvents.run(windowStart - 60 * 60 * 1000); // keep ~2h of history max
  const { n } = countUploadEvents.get(curHash, prevHash || curHash, windowStart);
  const limit = settings.get('upload_limit_per_hour');
  return {
    allowed: n < limit,
    limit,
    record: () => insertUploadEvent.run(curHash, Date.now())
  };
}

module.exports = {
  createLimiter,
  limiterKey,
  limitHeaders,
  readLimiter,
  writeLimiter,
  reportLimiter,
  adminLoginLimiter,
  adminApiLimiter,
  checkUploadQuota
};
