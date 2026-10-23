// Append-only hash-chained ledger. This is the site's "blockchain" layer:
// every write action gets one row, and each row's hash commits to the
// previous row's hash, so tampering with any past row is detectable.
'use strict';

const db = require('../core/db');
const { sha256Hex, canonicalJSON } = require('../security/crypto');

const GENESIS_PREV_HASH = '0'.repeat(64);

const insertStmt = db.prepare(`
  INSERT INTO ledger (type, addr, ref_id, payload_hash, prev_hash, hash, ts, redacted)
  VALUES (@type, @addr, @ref_id, @payload_hash, @prev_hash, @hash, @ts, 0)
`);
const lastStmt = db.prepare('SELECT * FROM ledger ORDER BY seq DESC LIMIT 1');
const allStmt = db.prepare('SELECT * FROM ledger ORDER BY seq ASC');
const redactStmt = db.prepare('UPDATE ledger SET redacted = 1 WHERE ref_id = ? AND type = ?');

function ensureGenesis() {
  const last = lastStmt.get();
  if (last) return;
  const ts = Date.now();
  const payloadHash = sha256Hex('genesis');
  const hash = sha256Hex(payloadHash + GENESIS_PREV_HASH + ts);
  insertStmt.run({
    type: 'genesis',
    addr: 'anon:genesis',
    ref_id: null,
    payload_hash: payloadHash,
    prev_hash: GENESIS_PREV_HASH,
    hash,
    ts
  });
}
ensureGenesis();

/** Appends one block for a write action. `payload` is the exact canonical
 * object that was signed by the client (already verified by the caller). */
function appendBlock({ type, addr, refId, payload }) {
  const last = lastStmt.get();
  const prevHash = last ? last.hash : GENESIS_PREV_HASH;
  const ts = Date.now();
  const payloadHash = sha256Hex(canonicalJSON(payload));
  const hash = sha256Hex(payloadHash + prevHash + ts);
  insertStmt.run({ type, addr, ref_id: refId ?? null, payload_hash: payloadHash, prev_hash: prevHash, hash, ts });
  return { hash, ts };
}

/** Marks the ledger row for a given (type, refId) as redacted -- used when
 * a post's media is deleted for policy reasons. The row itself is never
 * removed, since that would break the hash chain. */
function redactRef(type, refId) {
  redactStmt.run(refId, type);
}

/** Walks the whole chain from genesis and re-derives every hash. Returns
 * { ok: true } or { ok: false, brokenAtSeq, reason }. */
function verifyChain() {
  const rows = allStmt.all();
  if (rows.length === 0) return { ok: true, blocks: 0 };
  let expectedPrev = GENESIS_PREV_HASH;
  for (const row of rows) {
    if (row.prev_hash !== expectedPrev) {
      return { ok: false, brokenAtSeq: row.seq, reason: 'prev_hash mismatch' };
    }
    const recomputed = sha256Hex(row.payload_hash + row.prev_hash + row.ts);
    if (recomputed !== row.hash) {
      return { ok: false, brokenAtSeq: row.seq, reason: 'hash mismatch (row tampered)' };
    }
    expectedPrev = row.hash;
  }
  return { ok: true, blocks: rows.length, headHash: rows[rows.length - 1].hash };
}

module.exports = { appendBlock, redactRef, verifyChain };
