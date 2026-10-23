// Admin authentication: scrypt-hashed password, opaque random session
// tokens stored server-side (not JWTs, so a session can be revoked
// instantly by deleting its row), httpOnly + SameSite=Strict cookie.
'use strict';

const crypto = require('crypto');
const db = require('../db');
const config = require('../config');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const COOKIE_NAME = 'anon_admin_session';

// Cost parameters for new hashes. Node's scrypt defaults (N=16384, r=8) are
// on the low side for a password that guards the whole moderation surface;
// N=2^17 with r=8 puts one hash at roughly a tenth of a second and ~128 MB,
// which a login can afford and a bulk offline guesser cannot. `maxmem` has
// to be raised to match, or scryptSync refuses the parameters outright.
const SCRYPT = { N: 1 << 17, r: 8, p: 1, keylen: 64, maxmem: 256 * 1024 * 1024 };
const SCRYPT_PREFIX = 'scrypt';

// Async, not scryptSync. At this cost one hash takes ~200ms, and the sync
// call would spend all of that blocking the event loop -- turning a handful
// of login attempts into a stall for every other request on the server. The
// callback form runs on libuv's threadpool instead, so a slow hash costs the
// attacker time without costing everyone else theirs.
function scryptHash(password, salt, params = SCRYPT) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password, salt, params.keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: params.maxmem },
      (err, derived) => (err ? reject(err) : resolve(derived.toString('hex')))
    );
  });
}

/** Encodes the cost parameters alongside the hash, so they can be raised
 * later without invalidating existing passwords. */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const { N, r, p } = SCRYPT;
  return `${SCRYPT_PREFIX}$${N}$${r}$${p}$${salt}$${await scryptHash(password, salt)}`;
}

async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string' || !stored) return false;

  let salt, hash, params;
  if (stored.startsWith(`${SCRYPT_PREFIX}$`)) {
    const [, n, r, p, s, h] = stored.split('$');
    params = { N: Number(n), r: Number(r), p: Number(p), keylen: 64, maxmem: SCRYPT.maxmem };
    if (!Number.isInteger(params.N) || !Number.isInteger(params.r) || !Number.isInteger(params.p)) return false;
    salt = s;
    hash = h;
  } else {
    // Legacy "salt:hash" format, written before the cost parameters were
    // recorded. Verified with the old defaults; the row is upgraded to the
    // current format on the next successful login (see checkAdminPassword).
    [salt, hash] = stored.split(':');
    params = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: SCRYPT.maxmem };
  }
  if (!salt || !hash) return false;

  let candidate;
  try {
    candidate = await scryptHash(password, salt, params);
  } catch {
    return false; // unusable stored parameters
  }
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function setAdminPassword(password) {
  const hash = await hashPassword(password);
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO admin_auth (id, password_hash) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash
    `).run(hash);
    // Changing the password must end every session opened with the old one --
    // otherwise rotating a password that may have leaked doesn't actually
    // lock anyone out.
    db.prepare('DELETE FROM admin_sessions').run();
  });
  tx();
}

function hasAdminPassword() {
  return !!db.prepare('SELECT 1 FROM admin_auth WHERE id = 1').get();
}

async function checkAdminPassword(password) {
  const row = db.prepare('SELECT password_hash FROM admin_auth WHERE id = 1').get();
  if (!row) return false;
  if (!await verifyPassword(password, row.password_hash)) return false;

  // Correct password stored in the legacy format: re-hash it at the current
  // cost now that we have the plaintext in hand. Skips the session wipe that
  // setAdminPassword() does -- the password itself hasn't changed.
  if (!row.password_hash.startsWith(`${SCRYPT_PREFIX}$`)) {
    db.prepare('UPDATE admin_auth SET password_hash = ? WHERE id = 1').run(await hashPassword(password));
  }
  return true;
}

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO admin_sessions (token, created_at, expires_at) VALUES (?, ?, ?)')
    .run(token, now, now + SESSION_TTL_MS);
  return token;
}

function destroySession(token) {
  db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
}

function isValidSession(token) {
  // Tokens are 64 hex chars from randomBytes(32). Rejecting anything else
  // before it reaches the database keeps a malformed or oversized cookie
  // from becoming a query.
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return false;
  const row = db.prepare('SELECT expires_at FROM admin_sessions WHERE token = ?').get(token);
  if (!row) return false;
  if (row.expires_at < Date.now()) {
    destroySession(token);
    return false;
  }
  return true;
}

/** Deletes sessions that have already expired. Nothing removed them before,
 * so the table only ever grew. Called at startup and on a timer. */
function pruneExpiredSessions() {
  const { changes } = db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(Date.now());
  return changes;
}

/** Cookie options for the admin session. `secure` follows the actual
 * connection, but is forced on in production: behind a TLS-terminating
 * proxy without TRUST_PROXY set, req.secure reads false and the session
 * cookie would be allowed onto a plaintext hop. */
function sessionCookieOptions(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.IS_PRODUCTION || req.secure || forwardedProto === 'https',
    maxAge: SESSION_TTL_MS
  };
}

/** Express middleware: requires a valid admin session cookie. */
function requireAdmin(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!isValidSession(token)) return res.status(401).json({ error: 'admin authentication required' });
  req.adminToken = token;
  next();
}

module.exports = {
  COOKIE_NAME,
  SESSION_TTL_MS,
  hashPassword,
  verifyPassword,
  setAdminPassword,
  hasAdminPassword,
  checkAdminPassword,
  createSession,
  destroySession,
  isValidSession,
  pruneExpiredSessions,
  sessionCookieOptions,
  requireAdmin
};
