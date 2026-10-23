'use strict';

const path = require('path');
const express = require('express');
const db = require('../db');
const config = require('../config');
const { moveFile, QUARANTINE_DIR } = require('../lib/queue');
const { appendBlock } = require('../lib/ledger');
const { authenticateAction, toRowId } = require('../lib/signed');

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
  const action = authenticateAction(req, res, 'report');
  if (!action) return;
  const { addr, payload, iphash } = action;

  if (!REASONS.includes(payload.reason)) return res.status(400).json({ error: 'invalid reason' });

  const postId = toRowId(payload.postId);
  if (!postId) return res.status(400).json({ error: 'invalid post id' });

  const post = db.prepare('SELECT id, status FROM posts WHERE id = ?').get(postId);
  if (!post) return res.status(404).json({ error: 'post not found' });

  const existing = db.prepare('SELECT id FROM reports WHERE post_id = ? AND addr = ?').get(postId, addr);
  if (existing) return res.status(409).json({ error: 'you already reported this post' });

  const note = typeof payload.note === 'string' ? payload.note.slice(0, 500) : '';
  const info = db.prepare(`
    INSERT INTO reports (post_id, addr, reason, note, iphash, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(postId, addr, payload.reason, note, iphash, Date.now());

  appendBlock({ type: 'report', addr, refId: info.lastInsertRowid, payload });

  // A reported post stays live. It shows up in the admin Reports queue for a
  // human decision -- a few reports must never be enough to hide something,
  // or a small group could suppress any post before an admin ever sees it.
  // Only a mass pile-on trips the automatic blacklist below.
  const { count } = db.prepare(
    'SELECT COUNT(*) AS count FROM reports WHERE post_id = ? AND resolved = 0'
  ).get(postId);

  const blacklistAt = config.get('report_auto_blacklist_count');
  let autoBlacklisted = false;
  if (count >= blacklistAt && post.status === 'live') {
    massReportBlacklist(postId);
    autoBlacklisted = true;
  }

  res.status(201).json({ id: info.lastInsertRowid, reportCount: count, autoBlacklisted });
});

module.exports = router;
