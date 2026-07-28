'use strict';

const path = require('path');
const express = require('express');
const db = require('../db');
const config = require('../config');
const { moveFile, QUARANTINE_DIR } = require('../lib/queue');
const { verifySignedPayload } = require('../lib/crypto');
const { appendBlock } = require('../lib/ledger');
const { isBanned } = require('../lib/bans');
const { hashIp, clientIp } = require('../lib/iphash');

const router = express.Router();
const REASONS = ['adult', 'violence', 'spam', 'illegal', 'other'];

/** Hides a mass-reported post from the public feed and moves its media to
 * quarantine. Marked `reviewed_by = 'mass-report'` rather than 'system' so
 * the automatic quarantine purge leaves it alone -- community reports can be
 * a brigade, so the admin must be the one to decide its fate, however long
 * they take to get to it. */
function massReportBlacklist(postId) {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!post) return;
  const newFile = post.file_path
    ? moveFile(post.file_path, path.join(QUARANTINE_DIR, path.basename(post.file_path)))
    : null;
  const newThumb = post.thumb_path
    ? moveFile(post.thumb_path, path.join(QUARANTINE_DIR, path.basename(post.thumb_path)))
    : null;
  db.prepare(`
    UPDATE posts SET status = 'blacklisted',
                     file_path = COALESCE(?, file_path),
                     thumb_path = COALESCE(?, thumb_path),
                     reviewed_at = ?, reviewed_by = 'mass-report'
    WHERE id = ?
  `).run(newFile, newThumb, Date.now(), postId);
  console.log(`[reports] post ${postId} auto-blacklisted by mass report`);
}

// POST /api/reports -- body: { addr, pubkey, signature, payload:{type:'report', postId, reason, note, ts, nonce} }
router.post('/', (req, res) => {
  const { addr, pubkey, signature, payload } = req.body || {};
  const verification = verifySignedPayload({ addr, pubkey, signature, payload });
  if (!verification.ok) return res.status(401).json({ error: verification.error });
  if (payload.type !== 'report') return res.status(400).json({ error: 'payload type mismatch' });
  if (isBanned('addr', addr)) return res.status(403).json({ error: 'this address is banned' });
  if (!REASONS.includes(payload.reason)) return res.status(400).json({ error: 'invalid reason' });

  const post = db.prepare("SELECT id, status FROM posts WHERE id = ?").get(payload.postId);
  if (!post) return res.status(404).json({ error: 'post not found' });

  const existing = db.prepare('SELECT id FROM reports WHERE post_id = ? AND addr = ?').get(payload.postId, addr);
  if (existing) return res.status(409).json({ error: 'you already reported this post' });

  const iphash = hashIp(clientIp(req));
  const info = db.prepare(`
    INSERT INTO reports (post_id, addr, reason, note, iphash, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(payload.postId, addr, payload.reason, (payload.note || '').slice(0, 500), iphash, Date.now());

  appendBlock({ type: 'report', addr, refId: info.lastInsertRowid, payload });

  // A reported post stays live. It shows up in the admin Reports queue for a
  // human decision -- a few reports must never be enough to hide something,
  // or a small group could suppress any post before an admin ever sees it.
  // Only a mass pile-on trips the automatic blacklist below.
  const { count } = db.prepare(
    'SELECT COUNT(*) AS count FROM reports WHERE post_id = ? AND resolved = 0'
  ).get(payload.postId);

  const blacklistAt = config.get('report_auto_blacklist_count');
  let autoBlacklisted = false;
  if (count >= blacklistAt && post.status === 'live') {
    massReportBlacklist(payload.postId);
    autoBlacklisted = true;
  }

  res.status(201).json({ id: info.lastInsertRowid, reportCount: count, autoBlacklisted });
});

module.exports = router;
