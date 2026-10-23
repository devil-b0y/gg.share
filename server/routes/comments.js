'use strict';

const express = require('express');
const db = require('../db');
const { appendBlock } = require('../lib/ledger');
const { authenticateAction, toRowId } = require('../lib/signed');

const router = express.Router();

// Hard ceiling on one response. A busy post could otherwise return every
// comment it has ever received in a single unbounded payload.
const MAX_COMMENTS_PER_RESPONSE = 500;

router.get('/:postId', (req, res) => {
  const postId = toRowId(req.params.postId);
  if (!postId) return res.status(400).json({ error: 'invalid post id' });
  const rows = db.prepare(`
    SELECT id, addr, body, parent_id, created_at FROM comments
    WHERE post_id = ? AND status = 'live'
    ORDER BY created_at DESC
    LIMIT ?
  `).all(postId, MAX_COMMENTS_PER_RESPONSE);
  res.json({ comments: rows });
});

// POST /api/comments -- body: { addr, pubkey, signature, payload:{type:'comment', postId, body, parentId, ts, nonce} }
router.post('/', (req, res) => {
  const action = authenticateAction(req, res, 'comment');
  if (!action) return;
  const { addr, pubkey, payload, iphash } = action;

  const postId = toRowId(payload.postId);
  if (!postId) return res.status(400).json({ error: 'invalid post id' });

  const body = typeof payload.body === 'string' ? payload.body.trim() : '';
  if (!body || body.length > 1000) return res.status(400).json({ error: 'comment must be 1-1000 chars' });

  const post = db.prepare("SELECT id FROM posts WHERE id = ? AND status = 'live'").get(postId);
  if (!post) return res.status(404).json({ error: 'post not found' });

  let parentId = null;
  if (payload.parentId !== undefined && payload.parentId !== null) {
    parentId = toRowId(payload.parentId);
    if (!parentId) return res.status(400).json({ error: 'invalid parent comment id' });
    const parent = db.prepare('SELECT id FROM comments WHERE id = ? AND post_id = ?').get(parentId, postId);
    if (!parent) return res.status(400).json({ error: 'parent comment not found' });
  }

  const info = db.prepare(`
    INSERT INTO comments (post_id, addr, pubkey, body, parent_id, status, iphash, created_at)
    VALUES (?, ?, ?, ?, ?, 'live', ?, ?)
  `).run(postId, addr, pubkey, body, parentId, iphash, Date.now());

  appendBlock({ type: 'comment', addr, refId: info.lastInsertRowid, payload });
  res.status(201).json({ id: info.lastInsertRowid });
});

module.exports = router;
