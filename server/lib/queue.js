// Serial in-process moderation worker. Uploads are classified one at a
// time (a queue, not parallel workers) because CPU-bound TF inference on
// the pure-JS backend saturates a core; running many in parallel would
// just make every request slower with no throughput gain.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const db = require('../db');
const config = require('../config');
const { classifyImageBuffer, classifyVideoFrames } = require('./nsfw');
const { extractSampleFrames } = require('./media');

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
const LIVE_DIR = path.join(UPLOADS_DIR, 'live');
const QUARANTINE_DIR = path.join(UPLOADS_DIR, 'quarantine');

const getPost = db.prepare('SELECT * FROM posts WHERE id = ?');
const updatePost = db.prepare(`
  UPDATE posts SET status = ?, file_path = ?, thumb_path = ?, nsfw_scores = ?, reviewed_at = ?, reviewed_by = ?
  WHERE id = ?
`);

const queue = [];
let running = false;

function enqueueModeration(postId) {
  queue.push(postId);
  drain();
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const postId = queue.shift();
      try {
        await processPost(postId);
      } catch (err) {
        console.error(`[moderation] failed to process post ${postId}:`, err);
      }
    }
  } finally {
    running = false;
  }
}

function moveFile(from, to) {
  if (!from || !fs.existsSync(from)) return null;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  return to;
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

  const blockThreshold = config.get('nsfw_block_threshold');
  const reviewThreshold = config.get('nsfw_review_threshold');
  const sexyReviewThreshold = config.get('nsfw_sexy_review_threshold');
  const adultMetric = scores.porn + scores.hentai;

  let status;
  if (adultMetric >= blockThreshold) status = 'blacklisted';
  else if (adultMetric >= reviewThreshold || scores.sexy >= sexyReviewThreshold) status = 'review';
  else status = 'live';

  const targetDir = status === 'blacklisted' ? QUARANTINE_DIR : LIVE_DIR;
  const newFilePath = moveFile(post.file_path, path.join(targetDir, path.basename(post.file_path))) || post.file_path;
  const newThumbPath = post.thumb_path
    ? moveFile(post.thumb_path, path.join(targetDir, path.basename(post.thumb_path))) || post.thumb_path
    : null;

  updatePost.run(
    status,
    newFilePath,
    newThumbPath,
    JSON.stringify(scores),
    status === 'blacklisted' ? Date.now() : null,
    status === 'blacklisted' ? 'system' : null,
    postId
  );

  console.log(`[moderation] post ${postId} -> ${status} (adult=${adultMetric.toFixed(3)}, sexy=${scores.sexy.toFixed(3)})`);
}

/** Permanently deletes media for quarantined posts older than the
 * configured retention window. The post row and its ledger entry are kept
 * (redacted) so the moderation history and chain integrity survive. */
function purgeExpiredQuarantine() {
  const retentionMs = config.get('quarantine_retention_hours') * 60 * 60 * 1000;
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
  const { redactRef } = require('./ledger');
  for (const row of rows) {
    for (const p of [row.file_path, row.thumb_path]) {
      if (p && fs.existsSync(p)) fs.unlink(p, () => {});
    }
    db.prepare("UPDATE posts SET file_path = '', thumb_path = '' WHERE id = ?").run(row.id);
    redactRef('post', row.id);
  }
  if (rows.length) console.log(`[moderation] purged media for ${rows.length} expired blacklisted post(s)`);
}

function startPurgeSweep(intervalMs = 30 * 60 * 1000) {
  purgeExpiredQuarantine();
  return setInterval(purgeExpiredQuarantine, intervalMs);
}

module.exports = {
  enqueueModeration,
  purgeExpiredQuarantine,
  startPurgeSweep,
  moveFile,
  LIVE_DIR,
  QUARANTINE_DIR
};
