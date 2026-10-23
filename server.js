// Process entry point: a minimal Node HTTP server in front of Next.js.
//
//   npm run dev    -> node server.js          (development, hot reload)
//   npm start      -> node server.js --prod   (production; run `npm run build` first)
//
// Next.js serves every page and API route. This file exists for the few
// things that must happen per process or per socket, which Next cannot do
// on its own:
//
//   1. Refuse to boot in production with placeholder secrets.
//   2. Resolve the client IP from the socket under TRUST_PROXY, and hand it
//      to route handlers in a header clients cannot forge
//      (see lib/server/http/client-ip.js for why this matters).
//   3. Apply security headers, including a per-request CSP nonce.
//   4. Start the background jobs: quarantine purge and session pruning.
'use strict';

// The mode must be fixed before anything reads NODE_ENV -- including the
// .env loader, which would otherwise let a NODE_ENV line in .env flip a dev
// server into production mode.
const isProd = process.argv.includes('--prod');
process.env.NODE_ENV = isProd ? 'production' : 'development';

const { loadEnvConfig } = require('@next/env');
loadEnvConfig(process.cwd(), !isProd);

const http = require('http');
const crypto = require('crypto');
const next = require('next');
const env = require('./lib/server/core/env');
const { CLIENT_IP_HEADER, compileTrust, resolveClientIp } = require('./lib/server/http/client-ip');
const { buildCsp, SECURITY_HEADERS } = require('./lib/server/http/security-headers');

// --- 1. configuration gate ----------------------------------------------------
try {
  env.assertSecureConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const trustProxy = compileTrust(env.TRUST_PROXY);
const app = next({ dev: !isProd, port: env.PORT });
const handle = app.getRequestHandler();

// --- 2 + 3. per-request preparation -------------------------------------------
function prepareRequest(req, res) {
  // Whatever the client sent under our internal header is discarded; only
  // the socket-derived address is ever trusted.
  req.headers[CLIENT_IP_HEADER] = resolveClientIp(req, trustProxy);

  const nonce = crypto.randomBytes(16).toString('base64');
  const csp = buildCsp(nonce, { dev: !isProd, production: isProd });
  // Next.js reads the nonce from the request header (see security-headers.js).
  req.headers['content-security-policy'] = csp;
  delete req.headers['content-security-policy-report-only'];

  res.setHeader('Content-Security-Policy', csp);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
}

// --- 4. background jobs -------------------------------------------------------
function startBackgroundJobs() {
  const { ensureUploadDirs } = require('./lib/server/media/storage');
  const { startPurgeSweep } = require('./lib/server/media/queue');
  const { pruneExpiredSessions, hasAdminPassword } = require('./lib/server/security/auth');

  ensureUploadDirs();
  startPurgeSweep();

  // Expired admin sessions are deleted on a timer; otherwise the table only
  // grows and a revoked-by-expiry token stays on disk indefinitely.
  pruneExpiredSessions();
  setInterval(pruneExpiredSessions, 60 * 60 * 1000).unref();

  if (!hasAdminPassword()) console.warn('No admin password set yet. Run: npm run setup');
}

app.prepare().then(() => {
  startBackgroundJobs();

  http.createServer((req, res) => {
    prepareRequest(req, res);
    handle(req, res);
  }).listen(env.PORT, () => {
    console.log(`anon-share listening on http://localhost:${env.PORT} (${isProd ? 'production' : 'development'})`);
  });
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
