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
 * Validates the signed envelope on `req` and returns { addr, pubkey, payload,
 * iphash }, or null if the request was rejected -- in which case the response
 * has already been sent and the caller must simply return.
 *
 * `parsedPayload` is for multipart routes, where the payload arrives as a
 * JSON string field and the caller has already parsed it. JSON routes leave
 * it undefined and the payload is read from the body.
 */
function authenticateAction(req, res, expectedType, parsedPayload) {
  const body = req.body || {};
  const { addr, pubkey, signature } = body;
  const payload = parsedPayload !== undefined ? parsedPayload : body.payload;

  // Shape first: verifySignedPayload() would reject these anyway, but a
  // non-object payload reaches canonicalJSON() and the ban lookups as an
  // arbitrary type, and rejecting it up front keeps that from mattering.
  if (typeof addr !== 'string' || !addr || typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    res.status(400).json({ error: 'malformed request envelope' });
    return null;
  }

  const verification = verifySignedPayload({ addr, pubkey, signature, payload });
  if (!verification.ok) {
    res.status(401).json({ error: verification.error });
    return null;
  }

  if (payload.type !== expectedType) {
    res.status(400).json({ error: 'payload type mismatch' });
    return null;
  }

  if (isBanned('addr', addr)) {
    res.status(403).json({ error: 'this address is banned' });
    return null;
  }

  const iphash = hashIp(clientIp(req));
  if (isBanned('iphash', iphash)) {
    res.status(403).json({ error: 'this network is banned' });
    return null;
  }

  // Last, so an unverified caller can never burn a nonce that belongs to
  // someone else's address.
  const fresh = replay.consume(addr, payload);
  if (!fresh.ok) {
    res.status(fresh.status).json({ error: fresh.error });
    return null;
  }

  return { addr, pubkey, payload, iphash };
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
