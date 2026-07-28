'use strict';

const express = require('express');
const db = require('../db');
const { verifySignedPayload } = require('../lib/crypto');
const { appendBlock } = require('../lib/ledger');
const { isBanned } = require('../lib/bans');

const router = express.Router();

// POST /api/dislikes -- body: { addr, pubkey, signature, payload:{type:'dislike', postId, ts, nonce} }
// Dislike and like are mutually exclusive (like Reddit's up/down vote):
// disliking a post you'd previously liked removes the like, and vice versa
// (see server/routes/likes.js).
router.post('/', (req, res) => {
  const { addr, pubkey, signature, payload } = req.body || {};
  const verification = verifySignedPayload({ addr, pubkey, signature, payload });
  if (!verification.ok) return res.status(401).json({ error: verification.error });
  if (payload.type !== 'dislike') return res.status(400).json({ error: 'payload type mismatch' });
  if (isBanned('addr', addr)) return res.status(403).json({ error: 'this address is banned' });

  const post = db.prepare("SELECT id FROM posts WHERE id = ? AND status = 'live'").get(payload.postId);
  if (!post) return res.status(404).json({ error: 'post not found' });

  const existing = db.prepare('SELECT id FROM dislikes WHERE post_id = ? AND addr = ?').get(payload.postId, addr);
  if (existing) {
    db.prepare('DELETE FROM dislikes WHERE id = ?').run(existing.id);
    return res.json({ disliked: false });
  }

  db.prepare('DELETE FROM likes WHERE post_id = ? AND addr = ?').run(payload.postId, addr);
  const info = db.prepare('INSERT INTO dislikes (post_id, addr, created_at) VALUES (?, ?, ?)')
    .run(payload.postId, addr, Date.now());
  appendBlock({ type: 'dislike', addr, refId: info.lastInsertRowid, payload });
  res.json({ disliked: true });
});

router.get('/:postId/mine', (req, res) => {
  const { addr } = req.query;
  if (!addr) return res.json({ disliked: false });
  const existing = db.prepare('SELECT id FROM dislikes WHERE post_id = ? AND addr = ?').get(req.params.postId, addr);
  res.json({ disliked: !!existing });
});

module.exports = router;
