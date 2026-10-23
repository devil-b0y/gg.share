// Minimal cookie parsing and serialization.
//
// Only the admin session cookie is ever set on this site, so a full cookie
// library isn't needed -- but the parser still has to be safe against
// whatever a client sends.
'use strict';

const MAX_COOKIE_HEADER = 8 * 1024;

/** Parses a Cookie header into a null-prototype object. */
function parseCookies(header) {
  // Null-prototype, so a cookie literally named "__proto__" or "constructor"
  // is just a key here and can't shadow anything on Object.prototype.
  const cookies = Object.create(null);
  if (!header || header.length > MAX_COOKIE_HEADER) return cookies;

  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    // A stray '%' makes decodeURIComponent throw, and an uncaught throw
    // here would turn any malformed cookie into a failed request.
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

/**
 * Builds a Set-Cookie header value.
 * @param {object} opts { maxAge (ms), httpOnly, sameSite: 'strict'|'lax'|'none', secure }
 */
function serializeCookie(name, value, opts = {}) {
  const segments = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge) segments.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
  segments.push('Path=/');
  if (opts.httpOnly) segments.push('HttpOnly');
  if (opts.sameSite) segments.push(`SameSite=${opts.sameSite[0].toUpperCase()}${opts.sameSite.slice(1)}`);
  if (opts.secure) segments.push('Secure');
  return segments.join('; ');
}

/** A Set-Cookie value that deletes `name`. */
function clearCookie(name) {
  return `${name}=; Path=/; Max-Age=0`;
}

module.exports = { parseCookies, serializeCookie, clearCookie };
