'use strict';

const express = require('express');
const db = require('../db');
const { verifySignedPayload } = require('../lib/crypto');
const { appendBlock } = require('../lib/ledger');
const { isBanned } = require('../lib/bans');
const { hashIp, clientIp } = require('../lib/iphash');

const router = express.Router();

router.get('/:postId', (req, res) => {
  const rows = db.prepare(`
    SELECT id, addr, body, parent_id, created_at FROM comments
    WHERE post_id = ? AND status = 'live'
    ORDER BY created_at DESC
  `).all(req.params.postId);
  res.json({ comments: rows });
});

// POST /api/comments -- body: { addr, pubkey, signature, payload:{type:'comment', postId, body, parentId, ts, nonce} }
router.post('/', (req, res) => {
  const { addr, pubkey, signature, payload } = req.body || {};
  const verification = verifySignedPayload({ addr, pubkey, signature, payload });
  if (!verification.ok) return res.status(401).json({ error: verification.error });
  if (payload.type !== 'comment') return res.status(400).json({ error: 'payload type mismatch' });
  if (isBanned('addr', addr)) return res.status(403).json({ error: 'this address is banned' });

  const body = (payload.body || '').trim();
  if (!body || body.length > 1000) return res.status(400).json({ error: 'comment must be 1-1000 chars' });

  const post = db.prepare("SELECT id FROM posts WHERE id = ? AND status = 'live'").get(payload.postId);
  if (!post) return res.status(404).json({ error: 'post not found' });

  if (payload.parentId) {
    const parent = db.prepare("SELECT id FROM comments WHERE id = ? AND post_id = ?").get(payload.parentId, payload.postId);
    if (!parent) return res.status(400).json({ error: 'parent comment not found' });
  }

  const iphash = hashIp(clientIp(req));
  const info = db.prepare(`
    INSERT INTO comments (post_id, addr, pubkey, body, parent_id, status, iphash, created_at)
    VALUES (?, ?, ?, ?, ?, 'live', ?, ?)
  `).run(payload.postId, addr, pubkey, body, payload.parentId || null, iphash, Date.now());

  appendBlock({ type: 'comment', addr, refId: info.lastInsertRowid, payload });
  res.status(201).json({ id: info.lastInsertRowid });
});

module.exports = router;
