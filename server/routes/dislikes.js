'use strict';

const express = require('express');
const db = require('../db');
const { appendBlock } = require('../lib/ledger');
const { authenticateAction, toRowId } = require('../lib/signed');

const router = express.Router();

// POST /api/dislikes -- body: { addr, pubkey, signature, payload:{type:'dislike', postId, ts, nonce} }
// Dislike and like are mutually exclusive (like Reddit's up/down vote):
// disliking a post you'd previously liked removes the like, and vice versa
// (see server/routes/likes.js).
router.post('/', (req, res) => {
  const action = authenticateAction(req, res, 'dislike');
  if (!action) return;
  const { addr, payload } = action;

  const postId = toRowId(payload.postId);
  if (!postId) return res.status(400).json({ error: 'invalid post id' });

  const post = db.prepare("SELECT id FROM posts WHERE id = ? AND status = 'live'").get(postId);
  if (!post) return res.status(404).json({ error: 'post not found' });

  const existing = db.prepare('SELECT id FROM dislikes WHERE post_id = ? AND addr = ?').get(postId, addr);
  if (existing) {
    db.prepare('DELETE FROM dislikes WHERE id = ?').run(existing.id);
    return res.json({ disliked: false });
  }

  db.prepare('DELETE FROM likes WHERE post_id = ? AND addr = ?').run(postId, addr);
  const info = db.prepare('INSERT INTO dislikes (post_id, addr, created_at) VALUES (?, ?, ?)')
    .run(postId, addr, Date.now());
  appendBlock({ type: 'dislike', addr, refId: info.lastInsertRowid, payload });
  res.json({ disliked: true });
});

router.get('/:postId/mine', (req, res) => {
  const { addr } = req.query;
  const postId = toRowId(req.params.postId);
  if (!postId || typeof addr !== 'string' || !addr) return res.json({ disliked: false });
  const existing = db.prepare('SELECT id FROM dislikes WHERE post_id = ? AND addr = ?').get(postId, addr);
  res.json({ disliked: !!existing });
});

module.exports = router;
