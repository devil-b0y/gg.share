// User reports against posts.
//
// A reported post stays live. It shows up in the admin Reports queue for a
// human decision -- a few reports must never be enough to hide something,
// or a small group could suppress any post before an admin ever sees it.
// Only a genuine pile-on (the admin-configured mass-report threshold)
// auto-blacklists it, and even then the admin has the final say.
'use strict';

const db = require('../core/db');
const settings = require('../core/settings');
const { appendBlock } = require('./ledger');
const { toRowId } = require('../security/signed');
const { massReportBlacklist } = require('./moderation');

const REASONS = ['adult', 'violence', 'spam', 'illegal', 'other'];
const MAX_NOTE_LEN = 500;

/**
 * Files a report from a verified signed action. Returns
 *   { ok: true, id, reportCount, autoBlacklisted }
 * or { ok: false, status, error }.
 */
function fileReport({ addr, payload, iphash }) {
  const fail = (status, error) => ({ ok: false, status, error });

  if (!REASONS.includes(payload.reason)) return fail(400, 'invalid reason');

  const postId = toRowId(payload.postId);
  if (!postId) return fail(400, 'invalid post id');

  const post = db.prepare('SELECT id, status FROM posts WHERE id = ?').get(postId);
  if (!post) return fail(404, 'post not found');

  const existing = db.prepare('SELECT id FROM reports WHERE post_id = ? AND addr = ?').get(postId, addr);
  if (existing) return fail(409, 'you already reported this post');

  const note = typeof payload.note === 'string' ? payload.note.slice(0, MAX_NOTE_LEN) : '';
  const info = db.prepare(`
    INSERT INTO reports (post_id, addr, reason, note, iphash, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(postId, addr, payload.reason, note, iphash, Date.now());

  appendBlock({ type: 'report', addr, refId: info.lastInsertRowid, payload });

  const { count } = db.prepare(
    'SELECT COUNT(*) AS count FROM reports WHERE post_id = ? AND resolved = 0'
  ).get(postId);

  let autoBlacklisted = false;
  if (count >= settings.get('report_auto_blacklist_count') && post.status === 'live') {
    massReportBlacklist(postId);
    autoBlacklisted = true;
  }

  return { ok: true, id: info.lastInsertRowid, reportCount: count, autoBlacklisted };
}

module.exports = { fileReport, REASONS };
