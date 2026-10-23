// Likes and dislikes.
//
// The two are mutually exclusive, like Reddit's up/down vote: casting one
// removes the other, and casting the same vote again takes it back. They
// were two near-identical route files in the Express version; both now go
// through toggleVote().
'use strict';

const db = require('../core/db');
const { appendBlock } = require('./ledger');

// Table names are interpolated into SQL, so they come only from this map.
const VOTE_TABLES = {
  like: { table: 'likes', opposite: 'dislikes', resultKey: 'liked' },
  dislike: { table: 'dislikes', opposite: 'likes', resultKey: 'disliked' }
};

/**
 * Toggles `kind` ('like' | 'dislike') on a post for an address.
 * Returns `{ liked: bool }` or `{ disliked: bool }` -- the new state.
 * `payload` is the verified signed payload, recorded in the ledger.
 */
function toggleVote(kind, postId, addr, payload) {
  const { table, opposite, resultKey } = VOTE_TABLES[kind];

  const existing = db.prepare(`SELECT id FROM ${table} WHERE post_id = ? AND addr = ?`).get(postId, addr);
  if (existing) {
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(existing.id);
    return { [resultKey]: false };
  }

  db.prepare(`DELETE FROM ${opposite} WHERE post_id = ? AND addr = ?`).run(postId, addr);
  const info = db.prepare(`INSERT INTO ${table} (post_id, addr, created_at) VALUES (?, ?, ?)`)
    .run(postId, addr, Date.now());
  appendBlock({ type: kind, addr, refId: info.lastInsertRowid, payload });
  return { [resultKey]: true };
}

/** Whether `addr` currently holds a `kind` vote on a post. */
function hasVote(kind, postId, addr) {
  const { table } = VOTE_TABLES[kind];
  return !!db.prepare(`SELECT 1 FROM ${table} WHERE post_id = ? AND addr = ?`).get(postId, addr);
}

module.exports = { toggleVote, hasVote, VOTE_TABLES };
