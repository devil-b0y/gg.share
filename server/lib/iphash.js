// Turns a request's IP address into an unlinkable-over-time token: an
// HMAC-SHA256 keyed by a salt that rotates every hour. This is the ONLY
// thing derived from an IP that this app ever stores -- the raw address is
// used for a single synchronous computation per request and then dropped.
'use strict';

const crypto = require('crypto');
const config = require('../config');

const ROTATE_MS = 60 * 60 * 1000; // 1 hour

// Keep the current and previous hour's salt so a rolling window that spans
// an hour boundary still resolves consistently for requests made just
// before/after rotation.
let currentPeriod = -1;
let currentSalt = null;
let previousSalt = null;

function periodFor(tsMs) {
  return Math.floor(tsMs / ROTATE_MS);
}

function deriveSalt(period) {
  return crypto
    .createHmac('sha256', config.IP_SALT_SEED)
    .update(String(period))
    .digest();
}

function rotateIfNeeded() {
  const period = periodFor(Date.now());
  if (period !== currentPeriod) {
    previousSalt = currentSalt;
    currentSalt = deriveSalt(period);
    currentPeriod = period;
  }
}

function hmac(ip, salt) {
  return crypto.createHmac('sha256', salt).update(ip).digest('hex');
}

/** Returns the current-period hash for an IP. Two calls for the same IP
 * within the same rotation period always match; across a rotation they
 * won't -- that's intentional, it's what makes the token non-permanent. */
function hashIp(ip) {
  rotateIfNeeded();
  return hmac(ip || 'unknown', currentSalt);
}

/** Returns [currentHash, previousHash-or-null] so rolling-window queries
 * (e.g. "uploads in the last hour") work across a rotation boundary. */
function hashIpBothPeriods(ip) {
  rotateIfNeeded();
  const cur = hmac(ip || 'unknown', currentSalt);
  const prev = previousSalt ? hmac(ip || 'unknown', previousSalt) : null;
  return [cur, prev].filter(Boolean);
}

/** Extracts the client IP the way Express would with the configured
 * trust-proxy setting, without persisting it anywhere. */
function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

module.exports = { hashIp, hashIpBothPeriods, clientIp };
