'use strict';

const express = require('express');
const db = require('../db');
const { appendBlock } = require('../lib/ledger');
const { authenticateAction, toRowId } = require('../lib/signed');

const router = express.Router();

// POST /api/likes -- body: { addr, pubkey, signature, payload:{type:'like', postId, ts, nonce} }
router.post('/', (req, res) => {
  const action = authenticateAction(req, res, 'like');
  if (!action) return;
  const { addr, payload } = action;

  const postId = toRowId(payload.postId);
  if (!postId) return res.status(400).json({ error: 'invalid post id' });

  const post = db.prepare("SELECT id FROM posts WHERE id = ? AND status = 'live'").get(postId);
  if (!post) return res.status(404).json({ error: 'post not found' });

  const existing = db.prepare('SELECT id FROM likes WHERE post_id = ? AND addr = ?').get(postId, addr);
  if (existing) {
    db.prepare('DELETE FROM likes WHERE id = ?').run(existing.id);
    return res.json({ liked: false });
  }

  db.prepare('DELETE FROM dislikes WHERE post_id = ? AND addr = ?').run(postId, addr);
  const info = db.prepare('INSERT INTO likes (post_id, addr, created_at) VALUES (?, ?, ?)')
    .run(postId, addr, Date.now());
  appendBlock({ type: 'like', addr, refId: info.lastInsertRowid, payload });
  res.json({ liked: true });
});

router.get('/:postId/mine', (req, res) => {
  const { addr } = req.query;
  const postId = toRowId(req.params.postId);
  if (!postId || typeof addr !== 'string' || !addr) return res.json({ liked: false });
  const existing = db.prepare('SELECT id FROM likes WHERE post_id = ? AND addr = ?').get(postId, addr);
  res.json({ liked: !!existing });
});

module.exports = router;
