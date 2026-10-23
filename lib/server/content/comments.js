// Comments on posts: listing and creation.
'use strict';

const db = require('../core/db');
const { appendBlock } = require('./ledger');
const { toRowId } = require('../security/signed');
const { isLivePost } = require('./posts');

const MAX_COMMENT_LEN = 1000;

// Hard ceiling on one response. A busy post could otherwise return every
// comment it has ever received in a single unbounded payload.
const MAX_COMMENTS_PER_RESPONSE = 500;

/** Live comments on a post, newest first. */
function listComments(postId) {
  return db.prepare(`
    SELECT id, addr, body, parent_id, created_at FROM comments
    WHERE post_id = ? AND status = 'live'
    ORDER BY created_at DESC
    LIMIT ?
  `).all(postId, MAX_COMMENTS_PER_RESPONSE);
}

/**
 * Validates and stores a comment from a verified signed action.
 * Returns { ok: true, id } or { ok: false, status, error }.
 */
function createComment({ addr, pubkey, payload, iphash }) {
  const fail = (status, error) => ({ ok: false, status, error });

  const postId = toRowId(payload.postId);
  if (!postId) return fail(400, 'invalid post id');

  const body = typeof payload.body === 'string' ? payload.body.trim() : '';
  if (!body || body.length > MAX_COMMENT_LEN) return fail(400, `comment must be 1-${MAX_COMMENT_LEN} chars`);

  if (!isLivePost(postId)) return fail(404, 'post not found');

  // Replies must point at a comment on the same post -- otherwise a reply
  // could graft itself onto an unrelated thread.
  let parentId = null;
  if (payload.parentId !== undefined && payload.parentId !== null) {
    parentId = toRowId(payload.parentId);
    if (!parentId) return fail(400, 'invalid parent comment id');
    const parent = db.prepare('SELECT id FROM comments WHERE id = ? AND post_id = ?').get(parentId, postId);
    if (!parent) return fail(400, 'parent comment not found');
  }

  const info = db.prepare(`
    INSERT INTO comments (post_id, addr, pubkey, body, parent_id, status, iphash, created_at)
    VALUES (?, ?, ?, ?, ?, 'live', ?, ?)
  `).run(postId, addr, pubkey, body, parentId, iphash, Date.now());

  appendBlock({ type: 'comment', addr, refId: info.lastInsertRowid, payload });
  return { ok: true, id: info.lastInsertRowid };
}

module.exports = { listComments, createComment, MAX_COMMENT_LEN };
