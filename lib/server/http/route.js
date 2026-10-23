// The wrapper every API route handler goes through.
//
// In the Express version these concerns were app-level middleware: rate
// limits mounted per path prefix, a cookie parser, express.json(), the admin
// session check, and a final error handler. Next.js route handlers have no
// middleware chain, so `route()` applies the same steps, in the same order,
// to each handler that opts in. A route file then reads like:
//
//   export const POST = route(async (ctx) => { ... return json(...) }, {
//     limit: [writeLimiter],
//     body: 'json'
//   });
//
// The handler receives a request context (`ctx`):
//   ctx.request  the Web Request
//   ctx.method   HTTP method
//   ctx.query    URLSearchParams of the URL
//   ctx.params   resolved dynamic route params ({ id: '12' })
//   ctx.headers  request Headers
//   ctx.cookies  parsed cookies (null-prototype object)
//   ctx.ip       client IP as resolved by server.js -- never persisted
//   ctx.body     parsed JSON body when `body: 'json'`, otherwise {}
'use strict';

const { HttpError, errorJson } = require('./errors');
const { parseCookies } = require('./cookies');
const { readJson } = require('./body');
const { CLIENT_IP_HEADER } = require('./client-ip');
const { limiterKey, limitHeaders } = require('../security/ratelimit');
const { isAdminRequest } = require('../security/auth');

/**
 * @param {(ctx: object) => Promise<Response>|Response} handler
 * @param {object}   [opts]
 * @param {object[]} [opts.limit] limiters to apply, in order (security/ratelimit.js)
 * @param {boolean}  [opts.admin] require a valid admin session
 * @param {'json'}   [opts.body]  parse the body as JSON into ctx.body
 */
function route(handler, { limit = [], admin = false, body } = {}) {
  return async function handle(request, context) {
    const url = new URL(request.url);
    const ctx = {
      request,
      method: request.method,
      query: url.searchParams,
      params: (context && context.params ? await context.params : null) || {},
      headers: request.headers,
      cookies: parseCookies(request.headers.get('cookie')),
      ip: request.headers.get(CLIENT_IP_HEADER) || 'unknown',
      body: {}
    };

    // 1. Rate limits, before any work is done for the request. When several
    //    apply, the last one's headers win, as with stacked middleware.
    const rateHeaders = {};
    for (const limiter of limit) {
      const result = limiter.hit(limiterKey(ctx.ip));
      Object.assign(rateHeaders, limitHeaders(result, limiter.windowMs));
      if (!result.ok) return withHeaders(errorJson(429, limiter.message), rateHeaders);
    }

    try {
      // 2. Authentication for admin-only endpoints.
      if (admin && !isAdminRequest(ctx)) {
        return withHeaders(errorJson(401, 'admin authentication required'), rateHeaders);
      }

      // 3. Body parsing (size-limited; see body.js).
      if (body === 'json') ctx.body = await readJson(request);

      // 4. The handler itself.
      const response = await handler(ctx);
      return withHeaders(response, rateHeaders);
    } catch (err) {
      if (err instanceof HttpError) {
        return withHeaders(errorJson(err.status, err.message, err.extra), rateHeaders);
      }
      // The message can carry file paths and internal state -- it belongs
      // in the server's own log, not in the response.
      console.error(err);
      return withHeaders(errorJson(500, 'internal server error'), rateHeaders);
    }
  };
}

/** Copies extra headers onto a response. */
function withHeaders(response, headers) {
  for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
  return response;
}

module.exports = { route };
