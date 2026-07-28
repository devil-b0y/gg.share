// Admin authentication: scrypt-hashed password, opaque random session
// tokens stored server-side (not JWTs, so a session can be revoked
// instantly by deleting its row), httpOnly + SameSite=Strict cookie.
'use strict';

const crypto = require('crypto');
const db = require('../db');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const COOKIE_NAME = 'anon_admin_session';

function scryptHash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${scryptHash(password, salt)}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = (stored || '').split(':');
  if (!salt || !hash) return false;
  const candidate = scryptHash(password, salt);
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function setAdminPassword(password) {
  const hash = hashPassword(password);
  db.prepare(`
    INSERT INTO admin_auth (id, password_hash) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash
  `).run(hash);
}

function hasAdminPassword() {
  return !!db.prepare('SELECT 1 FROM admin_auth WHERE id = 1').get();
}

function checkAdminPassword(password) {
  const row = db.prepare('SELECT password_hash FROM admin_auth WHERE id = 1').get();
  if (!row) return false;
  return verifyPassword(password, row.password_hash);
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
  if (!token) return false;
  const row = db.prepare('SELECT expires_at FROM admin_sessions WHERE token = ?').get(token);
  if (!row) return false;
  if (row.expires_at < Date.now()) {
    destroySession(token);
    return false;
  }
  return true;
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
  setAdminPassword,
  hasAdminPassword,
  checkAdminPassword,
  createSession,
  destroySession,
  isValidSession,
  requireAdmin
};
