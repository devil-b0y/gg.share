// The client IP contract between server.js and the route handlers.
//
// Next.js does not expose the socket to route handlers, and the
// X-Forwarded-For it synthesizes keeps whatever value the client sent
// (`headers['x-forwarded-for'] ??= socket.remoteAddress`), so reading XFF
// directly would let any client choose its own IP -- and with it its own
// rate-limit bucket and iphash, defeating bans.
//
// Instead, server.js resolves the address from the socket using proxy-addr
// (the same library and the same TRUST_PROXY semantics Express used),
// deletes any client-supplied copy of CLIENT_IP_HEADER, and sets it itself.
// Route handlers read only this header.
'use strict';

const proxyaddr = require('proxy-addr');

/** Internal header carrying the server-resolved client address. Clients
 * cannot set it: server.js overwrites it on every request. */
const CLIENT_IP_HEADER = 'x-anon-client-ip';

/** Compiles a TRUST_PROXY value (see core/env.js#parseTrustProxy) into a
 * proxy-addr trust function, as Express's `trust proxy` setting did. */
function compileTrust(trust) {
  if (trust === true) return () => true;
  if (trust === false || trust == null) return () => false;
  if (typeof trust === 'number') return (_addr, i) => i < trust;
  return proxyaddr.compile(trust);
}

/** The client address for a Node IncomingMessage under a trust function. */
function resolveClientIp(req, trustFn) {
  try {
    return proxyaddr(req, trustFn) || 'unknown';
  } catch {
    return req.socket?.remoteAddress || 'unknown';
  }
}

module.exports = { CLIENT_IP_HEADER, compileTrust, resolveClientIp };
