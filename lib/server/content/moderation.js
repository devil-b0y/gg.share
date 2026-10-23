// Moderation actions: every way a post's status can change after upload.
//
// A status change is never just a column update -- the media has to move to
// the directory that matches the new status (see media/storage.js), and an
// admin decision also settles the post's open reports. Keeping those steps
// together here is what stops one code path from forgetting one of them.
'use strict';

const fs = require('fs');
const db = require('../core/db');
const { redactRef } = require('./ledger');
const { LIVE_DIR, QUARANTINE_DIR, moveInto } = require('../media/storage');

const getPost = db.prepare('SELECT * FROM posts WHERE id = ?');

/** Who made a decision. 'system' (the NSFW classifier) is the only reviewer
 * whose quarantined media the purge sweep deletes automatically. */
const REVIEWERS = { ADMIN: 'admin', SYSTEM: 'system', MASS_REPORT: 'mass-report' };

/**
 * Moves a post's media into `targetDir` and records the new status.
 * Returns false if the post doesn't exist.
 */
function relocateAndSetStatus(postId, status, targetDir, reviewer) {
  const post = getPost.get(postId);
  if (!post) return false;
  const newFile = moveInto(post.file_path, targetDir);
  const newThumb = moveInto(post.thumb_path, targetDir);
  db.prepare(`
    UPDATE posts SET status = ?,
                     file_path = COALESCE(?, file_path),
                     thumb_path = COALESCE(?, thumb_path),
                     reviewed_at = ?, reviewed_by = ?
    WHERE id = ?
  `).run(status, newFile, newThumb, Date.now(), reviewer, postId);
  return true;
}

/** Any admin decision on a post also settles its outstanding reports, so a
 * handled post stops reappearing in the Reports queue. */
function resolveReportsFor(postId) {
  db.prepare('UPDATE reports SET resolved = 1, resolved_at = ? WHERE post_id = ? AND resolved = 0')
    .run(Date.now(), postId);
}

// --- admin actions ------------------------------------------------------------
// Each returns { ok: true } or { ok: false, status, error } so the route can
// answer without knowing the rules.

const notFound = { ok: false, status: 404, error: 'not found' };

/** Hides a post. Media stays where it is; the status alone takes it off the
 * feed, and restore can bring it straight back. */
function removePost(postId) {
  db.prepare("UPDATE posts SET status = 'removed', reviewed_at = ?, reviewed_by = 'admin' WHERE id = ?")
    .run(Date.now(), postId);
  resolveReportsFor(postId);
  return { ok: true };
}

function approvePost(postId) {
  if (!relocateAndSetStatus(postId, 'live', LIVE_DIR, REVIEWERS.ADMIN)) return notFound;
  resolveReportsFor(postId);
  return { ok: true };
}

function blacklistPost(postId) {
  if (!relocateAndSetStatus(postId, 'blacklisted', QUARANTINE_DIR, REVIEWERS.ADMIN)) return notFound;
  resolveReportsFor(postId);
  return { ok: true };
}

/** Brings a blacklisted post back. Deliberately leaves its reports alone:
 * restoring is a reversal, not a judgement on what reporters said. */
function restorePost(postId) {
  const post = getPost.get(postId);
  if (!post) return notFound;

  // Text posts have no file to move -- only a media post that's had its
  // file purged is genuinely unrestorable. Checking `kind` first matters:
  // every text post has file_path = NULL by definition, which would
  // otherwise be indistinguishable from "media was purged".
  if (post.kind !== 'text' && !post.file_path) {
    return { ok: false, status: 410, error: 'media already purged, cannot restore' };
  }
  relocateAndSetStatus(postId, 'live', LIVE_DIR, REVIEWERS.ADMIN);
  return { ok: true };
}

/** Deletes a post's media from disk for good. The row and its ledger block
 * survive (redacted) so the hash chain stays intact. */
function purgePost(postId) {
  const post = getPost.get(postId);
  if (!post) return notFound;
  for (const p of [post.file_path, post.thumb_path]) {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  }
  db.prepare("UPDATE posts SET file_path = '', thumb_path = '', status = 'removed', reviewed_at = ?, reviewed_by = 'admin' WHERE id = ?")
    .run(Date.now(), postId);
  redactRef('post', postId);
  return { ok: true };
}

/** The admin actions reachable at POST /api/admin/posts/:id/:action. */
const POST_ACTIONS = {
  remove: { run: removePost, audit: 'remove_post' },
  approve: { run: approvePost, audit: 'approve_post' },
  blacklist: { run: blacklistPost, audit: 'blacklist_post' },
  restore: { run: restorePost, audit: 'restore_post' },
  purge: { run: purgePost, audit: 'purge_post' }
};

// --- reports ------------------------------------------------------------------

/** Hides a mass-reported post from the public feed and moves its media to
 * quarantine. Marked `reviewed_by = 'mass-report'` rather than 'system' so
 * the automatic quarantine purge leaves it alone -- community reports can be
 * a brigade, so the admin must be the one to decide its fate, however long
 * they take to get to it. */
function massReportBlacklist(postId) {
  if (!relocateAndSetStatus(postId, 'blacklisted', QUARANTINE_DIR, REVIEWERS.MASS_REPORT)) return;
  console.log(`[reports] post ${postId} auto-blacklisted by mass report`);
}

/** "Keep this post" -- clears the open reports without touching the post,
 * so it drops out of the queue. If a mass report had auto-blacklisted it,
 * this also restores it to the live feed. Returns { restored }. */
function dismissReports(postId) {
  resolveReportsFor(postId);
  const post = getPost.get(postId);
  if (post && post.status === 'blacklisted' && post.reviewed_by === REVIEWERS.MASS_REPORT && post.file_path) {
    relocateAndSetStatus(postId, 'live', LIVE_DIR, REVIEWERS.ADMIN);
    return { restored: true };
  }
  return { restored: false };
}

// --- audit trail --------------------------------------------------------------

/** Records an admin action. There is a single operator account, so `admin`
 * is a constant rather than a username. */
function audit(action, target, detail) {
  db.prepare('INSERT INTO admin_audit (admin, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('admin', action, target ?? null, detail ? JSON.stringify(detail) : null, Date.now());
}

module.exports = {
  REVIEWERS,
  POST_ACTIONS,
  removePost,
  approvePost,
  blacklistPost,
  restorePost,
  purgePost,
  resolveReportsFor,
  massReportBlacklist,
  dismissReports,
  audit
};
