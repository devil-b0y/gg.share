'use strict';

const express = require('express');
const db = require('../db');
const { verifySignedPayload } = require('../lib/crypto');
const { appendBlock } = require('../lib/ledger');
const { isBanned } = require('../lib/bans');

const router = express.Router();

// POST /api/likes -- body: { addr, pubkey, signature, payload:{type:'like', postId, ts, nonce} }
router.post('/', (req, res) => {
  const { addr, pubkey, signature, payload } = req.body || {};
  const verification = verifySignedPayload({ addr, pubkey, signature, payload });
  if (!verification.ok) return res.status(401).json({ error: verification.error });
  if (payload.type !== 'like') return res.status(400).json({ error: 'payload type mismatch' });
  if (isBanned('addr', addr)) return res.status(403).json({ error: 'this address is banned' });

  const post = db.prepare("SELECT id FROM posts WHERE id = ? AND status = 'live'").get(payload.postId);
  if (!post) return res.status(404).json({ error: 'post not found' });

  const existing = db.prepare('SELECT id FROM likes WHERE post_id = ? AND addr = ?').get(payload.postId, addr);
  if (existing) {
    db.prepare('DELETE FROM likes WHERE id = ?').run(existing.id);
    return res.json({ liked: false });
  }

  db.prepare('DELETE FROM dislikes WHERE post_id = ? AND addr = ?').run(payload.postId, addr);
  const info = db.prepare('INSERT INTO likes (post_id, addr, created_at) VALUES (?, ?, ?)')
    .run(payload.postId, addr, Date.now());
  appendBlock({ type: 'like', addr, refId: info.lastInsertRowid, payload });
  res.json({ liked: true });
});

router.get('/:postId/mine', (req, res) => {
  const { addr } = req.query;
  if (!addr) return res.json({ liked: false });
  const existing = db.prepare('SELECT id FROM likes WHERE post_id = ? AND addr = ?').get(req.params.postId, addr);
  res.json({ liked: !!existing });
});

module.exports = router;
