// Serial in-process moderation worker, plus the quarantine purge sweep.
//
// Uploads are classified one at a time (a queue, not parallel workers)
// because CPU-bound TF inference on the pure-JS backend saturates a core;
// running many in parallel would just make every request slower with no
// throughput gain.
//
// The queue state lives on globalThis: Next.js can load this module once per
// route bundle, and two copies of the queue would mean two "serial" workers
// running inference side by side.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../core/db');
const settings = require('../core/settings');
const { redactRef } = require('../content/ledger');
const { classifyImageBuffer, classifyVideoFrames } = require('./nsfw');
const { extractSampleFrames } = require('./processing');
const { LIVE_DIR, QUARANTINE_DIR, moveInto } = require('./storage');

const getPost = db.prepare('SELECT * FROM posts WHERE id = ?');
const updatePost = db.prepare(`
  UPDATE posts SET status = ?, file_path = ?, thumb_path = ?, nsfw_scores = ?, reviewed_at = ?, reviewed_by = ?
  WHERE id = ?
`);

const STATE_KEY = Symbol.for('anon-share.moderation-queue');
const state = globalThis[STATE_KEY] || (globalThis[STATE_KEY] = { queue: [], running: false });

/** Schedules a pending post for classification. Returns immediately. */
function enqueueModeration(postId) {
  state.queue.push(postId);
  drain();
}

async function drain() {
  if (state.running) return;
  state.running = true;
  try {
    while (state.queue.length) {
      const postId = state.queue.shift();
      try {
        await processPost(postId);
      } catch (err) {
        console.error(`[moderation] failed to process post ${postId}:`, err);
      }
    }
  } finally {
    state.running = false;
  }
}

/**
 * Maps classifier scores to a moderation status using the admin-configured
 * thresholds. Pure, so it can be unit-tested without a model.
 */
function decideStatus(scores, thresholds) {
  const adultMetric = scores.porn + scores.hentai;
  if (adultMetric >= thresholds.block) return 'blacklisted';
  if (adultMetric >= thresholds.review || scores.sexy >= thresholds.sexyReview) return 'review';
  return 'live';
}

async function processPost(postId) {
  const post = getPost.get(postId);
  if (!post || post.status !== 'pending') return;

  let scores;
  if (post.media_type === 'image') {
    scores = await classifyImageBuffer(fs.readFileSync(post.file_path));
  } else {
    const frameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anon-frames-'));
    try {
      const frames = await extractSampleFrames(post.file_path, frameDir, 2, 15);
      scores = frames.length
        ? await classifyVideoFrames(frames)
        : { porn: 0, hentai: 0, sexy: 0, neutral: 1, drawing: 0 };
    } finally {
      fs.rmSync(frameDir, { recursive: true, force: true });
    }
  }

  const status = decideStatus(scores, {
    block: settings.get('nsfw_block_threshold'),
    review: settings.get('nsfw_review_threshold'),
    sexyReview: settings.get('nsfw_sexy_review_threshold')
  });

  // Blacklisted media goes to quarantine/; everything else to live/. Note
  // that 'review' media also lands in live/ (unchanged from the Express
  // version): the post row's status, not the directory, is what keeps it off
  // the public feed until an admin approves it.
  const targetDir = status === 'blacklisted' ? QUARANTINE_DIR : LIVE_DIR;
  const newFilePath = moveInto(post.file_path, targetDir) || post.file_path;
  const newThumbPath = post.thumb_path ? moveInto(post.thumb_path, targetDir) || post.thumb_path : null;

  updatePost.run(
    status,
    newFilePath,
    newThumbPath,
    JSON.stringify(scores),
    status === 'blacklisted' ? Date.now() : null,
    status === 'blacklisted' ? 'system' : null,
    postId
  );

  const adultMetric = scores.porn + scores.hentai;
  console.log(`[moderation] post ${postId} -> ${status} (adult=${adultMetric.toFixed(3)}, sexy=${scores.sexy.toFixed(3)})`);
}

/** Permanently deletes media for quarantined posts older than the
 * configured retention window. The post row and its ledger entry are kept
 * (redacted) so the moderation history and chain integrity survive. */
function purgeExpiredQuarantine() {
  const retentionMs = settings.get('quarantine_retention_hours') * 60 * 60 * 1000;
  const cutoff = Date.now() - retentionMs;
  // Only the NSFW classifier's own decisions (reviewed_by = 'system') are
  // auto-purged. Posts blacklisted by an admin, or automatically by mass
  // report, are kept until the admin explicitly purges them -- otherwise a
  // brigaded post would have its evidence destroyed before anyone reviewed it.
  const rows = db.prepare(`
    SELECT * FROM posts
    WHERE status = 'blacklisted' AND reviewed_by = 'system'
      AND reviewed_at IS NOT NULL AND reviewed_at < ? AND file_path != ''
  `).all(cutoff);
  for (const row of rows) {
    for (const p of [row.file_path, row.thumb_path]) {
      if (p && fs.existsSync(p)) fs.unlink(p, () => {});
    }
    db.prepare("UPDATE posts SET file_path = '', thumb_path = '' WHERE id = ?").run(row.id);
    redactRef('post', row.id);
  }
  if (rows.length) console.log(`[moderation] purged media for ${rows.length} expired blacklisted post(s)`);
}

/** Runs the purge now and then on an interval. The timer is unref'd so it
 * never keeps a test or a shutting-down process alive on its own. */
function startPurgeSweep(intervalMs = 30 * 60 * 1000) {
  purgeExpiredQuarantine();
  return setInterval(purgeExpiredQuarantine, intervalMs).unref();
}

module.exports = {
  enqueueModeration,
  decideStatus,
  purgeExpiredQuarantine,
  startPurgeSweep
};
