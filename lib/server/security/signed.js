// One gate for every signed write action.
//
// Each write route used to repeat the same sequence by hand -- verify the
// signature, check the payload type, check the ban list -- which is how the
// iphash ban ended up enforced on uploads only, and how nothing enforced
// replay protection at all. Routing all of them through authenticateAction()
// means a new endpoint cannot silently skip a check.
'use strict';

const { verifySignedPayload } = require('./crypto');
const { isBanned } = require('./bans');
const { hashIp, clientIp } = require('./iphash');
const replay = require('./replay');

/**
 * Validates the signed envelope on a request and returns either
 *   { ok: true, addr, pubkey, payload, iphash }
 * or
 *   { ok: false, status, error }
 * which the route turns into its error response. Framework-free on purpose:
 * this is the security core, and it shouldn't care how HTTP is spoken.
 *
 * @param {object} ctx            request context from http/route.js
 * @param {object} body           the parsed request body (JSON routes) or the
 *                                multipart fields (upload route)
 * @param {string} expectedType   payload.type this endpoint accepts
 * @param {object} [parsedPayload] for multipart routes, where the payload
 *                                arrives as a JSON string field and the
 *                                caller has already parsed it
 */
function authenticateAction(ctx, body, expectedType, parsedPayload) {
  const fail = (status, error) => ({ ok: false, status, error });
  const { addr, pubkey, signature } = body || {};
  const payload = parsedPayload !== undefined ? parsedPayload : body?.payload;

  // Shape first: verifySignedPayload() would reject these anyway, but a
  // non-object payload reaches canonicalJSON() and the ban lookups as an
  // arbitrary type, and rejecting it up front keeps that from mattering.
  if (typeof addr !== 'string' || !addr || typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return fail(400, 'malformed request envelope');
  }

  const verification = verifySignedPayload({ addr, pubkey, signature, payload });
  if (!verification.ok) return fail(401, verification.error);

  if (payload.type !== expectedType) return fail(400, 'payload type mismatch');

  if (isBanned('addr', addr)) return fail(403, 'this address is banned');

  const iphash = hashIp(clientIp(ctx));
  if (isBanned('iphash', iphash)) return fail(403, 'this network is banned');

  // Last, so an unverified caller can never burn a nonce that belongs to
  // someone else's address.
  const fresh = replay.consume(addr, payload);
  if (!fresh.ok) return fail(fresh.status, fresh.error);

  return { ok: true, addr, pubkey, payload, iphash };
}

/** Coerces an untrusted row id to a positive integer, or null. Payload and
 * query fields reach SQL bindings directly; better-sqlite3 throws on an
 * object or array, which would surface as a 500 rather than a 400. */
function toRowId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== 'string' || !/^[0-9]{1,15}$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

module.exports = { authenticateAction, toRowId };
