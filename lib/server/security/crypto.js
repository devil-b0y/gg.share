// Server-side crypto for the identity/ledger system. Verification uses
// Node's built-in `crypto` module (Ed25519 has been natively supported
// since Node 12), so the server has zero extra dependency for this even
// though the browser side uses WebCrypto / vendored @noble/ed25519.
'use strict';

const crypto = require('crypto');

// Fixed DER prefix for an Ed25519 SubjectPublicKeyInfo wrapping a raw
// 32-byte public key. This is the standard/constant ASN.1 header for
// Ed25519 SPKI (RFC 8410) -- only the 32 key bytes ever vary.
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** Deterministic JSON stringify: object keys sorted, used so client and
 * server hash/sign the exact same bytes for a given logical payload. */
function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
}

/** address = "anon:" + first 16 chars of base32(sha256(pubkey)) */
function deriveAddress(pubkeyHex) {
  const raw = crypto.createHash('sha256').update(Buffer.from(pubkeyHex, 'hex')).digest();
  return 'anon:' + base32Encode(raw).slice(0, 16).toLowerCase();
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function isValidPubkeyHex(pubkeyHex) {
  return typeof pubkeyHex === 'string' && /^[0-9a-fA-F]{64}$/.test(pubkeyHex);
}

function isValidSigHex(sigHex) {
  return typeof sigHex === 'string' && /^[0-9a-fA-F]{128}$/.test(sigHex);
}

/** Verifies `signatureHex` (raw 64-byte Ed25519 sig, hex) over the UTF-8
 * bytes of `message` against `pubkeyHex` (raw 32-byte key, hex). */
function verifySignature(pubkeyHex, message, signatureHex) {
  if (!isValidPubkeyHex(pubkeyHex) || !isValidSigHex(signatureHex)) return false;
  try {
    const keyObj = crypto.createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(pubkeyHex, 'hex')]),
      format: 'der',
      type: 'spki'
    });
    return crypto.verify(
      null,
      Buffer.from(message, 'utf8'),
      keyObj,
      Buffer.from(signatureHex, 'hex')
    );
  } catch {
    return false;
  }
}

/** Verifies that `addr` really is derived from `pubkeyHex`, and that the
 * signature over the canonical payload is valid. Returns {ok, error?}. */
function verifySignedPayload({ addr, pubkey, signature, payload }) {
  if (!isValidPubkeyHex(pubkey)) return { ok: false, error: 'bad pubkey' };
  if (deriveAddress(pubkey) !== addr) return { ok: false, error: 'address does not match pubkey' };
  const message = canonicalJSON(payload);
  if (!verifySignature(pubkey, message, signature)) return { ok: false, error: 'bad signature' };
  return { ok: true, message };
}

module.exports = {
  sha256Hex,
  canonicalJSON,
  deriveAddress,
  verifySignature,
  verifySignedPayload,
  isValidPubkeyHex,
  isValidSigHex
};
