// Turns a request's IP address into an unlinkable-over-time token: an
// HMAC-SHA256 keyed by a salt that rotates every hour. This is the ONLY
// thing derived from an IP that this app ever stores -- the raw address is
// used for a single synchronous computation per request and then dropped.
'use strict';

const crypto = require('crypto');
const net = require('net');
const env = require('../core/env');

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
    .createHmac('sha256', env.IP_SALT_SEED)
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

/** The client IP for a request context. server.js resolves it from the
 * socket and the TRUST_PROXY setting (see lib/server/http/client-ip.js) and
 * route handlers receive it as `ctx.ip`; it is never persisted. */
function clientIp(ctx) {
  return (ctx && ctx.ip) || 'unknown';
}

/**
 * Collapses an address to the unit a rate limit should apply to:
 *   - IPv4-mapped IPv6 ("::ffff:1.2.3.4") becomes plain IPv4, so a dual-stack
 *     listener doesn't give one client two identities;
 *   - real IPv6 is truncated to its /56 prefix, because a single subscriber
 *     typically controls a whole /64 or more, and per-address limits on IPv6
 *     would hand each of them billions of fresh buckets.
 * Replaces express-rate-limit's ipKeyGenerator().
 */
function normalizeIp(ip) {
  if (!ip || ip === 'unknown') return 'unknown';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1];
  const bare = ip.split('%')[0]; // drop a zone id like fe80::1%eth0
  if (!net.isIPv6(bare)) return ip;
  return `${ipv6Prefix(bare, 56)}/56`;
}

/** Expands an IPv6 address to eight 16-bit groups and zeroes everything after
 * the first `bits` bits. */
function ipv6Prefix(ip, bits) {
  let groups = ip;
  // An embedded IPv4 tail ("::1.2.3.4") stands for the last two groups.
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(groups);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    groups = groups.slice(0, v4.index) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = groups.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = tail !== undefined ? 8 - headParts.length - tailParts.length : 0;
  const words = [...headParts, ...Array(fill).fill('0'), ...tailParts].map((g) => parseInt(g, 16) || 0);

  return words.map((word, i) => {
    const keep = Math.max(0, Math.min(16, bits - i * 16));
    const mask = keep === 0 ? 0 : (0xffff << (16 - keep)) & 0xffff;
    return (word & mask).toString(16);
  }).join(':');
}

module.exports = { hashIp, hashIpBothPeriods, clientIp, normalizeIp };
