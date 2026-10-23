// Replay protection for signed client actions.
//
// Every signed payload already carries a `ts` and a `nonce`, but a signature
// alone only proves *who* produced a request -- not that it is being made
// now, or for the first time. Without this module a captured envelope stays
// valid forever: replaying a like toggles it back off, replaying a comment
// duplicates it, replaying a report re-files it. Here the timestamp bounds
// how long an envelope is usable and the nonce makes it single-use.
'use strict';

const db = require('../core/db');

// How stale a payload may be before it's refused. Generous enough to survive
// a slow upload or a phone waking from sleep, short enough that a burned
// nonce only has to be remembered for minutes.
const MAX_AGE_MS = 5 * 60 * 1000;
// Clients sign with their own clock, which may run ahead of the server's.
const MAX_FUTURE_SKEW_MS = 2 * 60 * 1000;

// The client builds nonces out of Math.random() + Date.now() in base36. The
// pattern is deliberately permissive about the alphabet but strict about
// length, so a caller can't burn storage with a megabyte-long "nonce".
const NONCE_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

const insertNonce = db.prepare('INSERT INTO used_nonces (addr, nonce, expires_at) VALUES (?, ?, ?)');
const pruneNonces = db.prepare('DELETE FROM used_nonces WHERE expires_at < ?');

// Pruning on every request would be pure overhead; once a minute is enough
// to keep the table proportional to recent traffic rather than to all of it.
const PRUNE_INTERVAL_MS = 60 * 1000;
let lastPrune = 0;
function pruneIfDue(now) {
  if (now - lastPrune < PRUNE_INTERVAL_MS) return;
  lastPrune = now;
  pruneNonces.run(now);
}

/**
 * Checks that `payload` is fresh and its nonce unused, then burns the nonce.
 * Returns { ok: true } or { ok: false, status, error }. Must be called only
 * after the signature has been verified -- otherwise anyone could burn
 * another address's nonces.
 */
function consume(addr, payload) {
  const now = Date.now();
  pruneIfDue(now);

  const ts = payload?.ts;
  if (!Number.isSafeInteger(ts) || ts <= 0) {
    return { ok: false, status: 400, error: 'payload is missing a valid timestamp' };
  }
  if (ts - now > MAX_FUTURE_SKEW_MS) {
    return { ok: false, status: 400, error: 'payload timestamp is too far in the future' };
  }
  if (now - ts > MAX_AGE_MS) {
    return { ok: false, status: 400, error: 'this action expired before it reached the server, please retry' };
  }

  const nonce = payload?.nonce;
  if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) {
    return { ok: false, status: 400, error: 'payload is missing a valid nonce' };
  }

  // The PRIMARY KEY is what actually enforces single use -- checking for the
  // row first and inserting after would leave a window for two concurrent
  // replays to both pass.
  try {
    insertNonce.run(addr, nonce, now + MAX_AGE_MS + MAX_FUTURE_SKEW_MS);
  } catch (err) {
    if (typeof err?.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT')) {
      return { ok: false, status: 409, error: 'this action was already submitted' };
    }
    throw err;
  }

  return { ok: true };
}

module.exports = { consume, MAX_AGE_MS, MAX_FUTURE_SKEW_MS };
