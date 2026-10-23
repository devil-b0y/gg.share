// Security response headers -- the set helmet used to apply in the Express
// version -- plus the Content-Security-Policy builder.
//
// server.js applies these to every response. The CSP carries a fresh nonce
// per request: Next.js emits small inline <script> tags to boot the React
// app, and a strict `script-src 'self'` would block them. Next reads the
// nonce back out of the *request's* Content-Security-Policy header and stamps
// it onto its own scripts, which is why server.js sets the header on the
// request as well as the response.
'use strict';

/**
 * Builds the CSP. Nothing on this site ever needs to load from a third-party
 * origin (no CDN fonts, no analytics, no external scripts), so every source
 * is 'self'.
 *
 * @param {string}  nonce
 * @param {object}  opts
 * @param {boolean} opts.dev        dev mode needs eval (React refresh) and the HMR socket
 * @param {boolean} opts.production adds upgrade-insecure-requests
 */
function buildCsp(nonce, { dev, production }) {
  const directives = {
    'default-src': ["'self'"],
    'script-src': ["'self'", `'nonce-${nonce}'`, ...(dev ? ["'unsafe-eval'"] : [])],
    // React writes inline style attributes (e.g. aspect-ratio reservations).
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'media-src': ["'self'", 'blob:'],
    'connect-src': ["'self'", ...(dev ? ['ws:'] : [])],
    'object-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'frame-src': ["'none'"],
    'worker-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
    'base-uri': ["'self'"],
    // No page here posts a form anywhere. Saying so explicitly means an
    // injected <form> has nowhere to send what it collects.
    'form-action': ["'none'"]
  };
  const parts = Object.entries(directives).map(([k, v]) => `${k} ${v.join(' ')}`);
  // Only meaningful over TLS; adding it unconditionally would break
  // plain-HTTP local development.
  if (production) parts.push('upgrade-insecure-requests');
  return parts.join('; ');
}

/** Static headers sent on every response (helmet's defaults, with the
 * stricter choices the Express version made explicit). */
const SECURITY_HEADERS = {
  // Six months, subdomains included.
  'Strict-Transport-Security': 'max-age=15552000; includeSubDomains',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Origin-Agent-Cluster': '?1',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-DNS-Prefetch-Control': 'off',
  'X-Download-Options': 'noopen',
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Permitted-Cross-Domain-Policies': 'none',
  'X-XSS-Protection': '0'
};

module.exports = { buildCsp, SECURITY_HEADERS };
