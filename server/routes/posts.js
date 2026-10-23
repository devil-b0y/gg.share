'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const db = require('../db');
const config = require('../config');
const { appendBlock } = require('../lib/ledger');
const { sniffType, sha256Buffer, sanitizeImage, imageThumbnail, sanitizeVideo, videoThumbnail } = require('../lib/media');
const { uploadQuota } = require('../lib/ratelimit');
const { enqueueModeration } = require('../lib/queue');
const { authenticateAction, toRowId } = require('../lib/signed');
const { validateBody, saveTags, tagsFor, trendingTags } = require('../lib/text');
const { scoreExpr } = require('../lib/rank');

const router = express.Router();
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');

// The whole upload is buffered in memory before it can be sniffed and
// re-encoded, so these limits are what bound this endpoint's memory use.
// `files`/`parts`/`fieldSize` matter as much as `fileSize`: without them a
// single request can carry thousands of parts, and the per-file cap does
// nothing to stop the total from being enormous.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024, // absolute ceiling; the configured per-type cap is enforced below
    files: 1,
    parts: 12,
    fields: 10,
    fieldNameSize: 100,
    fieldSize: 64 * 1024
  }
});

// Search terms go into a LIKE '%...%' scan, which has no index to fall back
// on -- an unbounded needle is an easy way to make every query expensive.
const MAX_SEARCH_LEN = 100;
const MAX_TAG_LEN = 50;

// GET /api/posts -- public feed, only 'live' posts, newest first, cursor
// pagination by id.
// The optional `addr` query parameter is the viewer's own public address, so
// each post can carry that viewer's like/dislike state inline. Without it the
// client had to fire two extra requests per card -- 20 round-trips for a
// 10-post page -- before the feed settled. `addr` is already public on every
// post it appears on, so passing it here reveals nothing new.
// Sort modes. "latest" uses keyset pagination on id (fast, stable). The
// ranked modes need a computed ORDER BY, so they page by offset instead --
// acceptable because they're capped to a shallow window; nobody deep-scrolls
// "most liked".
const SORTS = {
  latest: null, // special-cased: keyset paginated
  trending: (now) => ({ order: `${scoreExpr('p')} DESC, p.id DESC`, params: [now] }),
  top: () => ({ order: '(SELECT COUNT(*) FROM likes l3 WHERE l3.post_id = p.id) DESC, p.id DESC', params: [] }),
  discussed: () => ({ order: "(SELECT COUNT(*) FROM comments c3 WHERE c3.post_id = p.id AND c3.status = 'live') DESC, p.id DESC", params: [] }),
  controversial: () => ({ order: '(SELECT COUNT(*) FROM dislikes d3 WHERE d3.post_id = p.id) DESC, p.id DESC', params: [] })
};

const SELECT_COLUMNS = `
  p.id, p.addr, p.kind, p.body, p.media_type, p.file_path, p.thumb_path, p.caption,
  p.created_at, p.width, p.height,
  (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
  (SELECT COUNT(*) FROM dislikes d WHERE d.post_id = p.id) AS dislike_count,
  (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.status = 'live') AS comment_count,
  EXISTS(SELECT 1 FROM likes l2 WHERE l2.post_id = p.id AND l2.addr = ?) AS viewer_liked,
  EXISTS(SELECT 1 FROM dislikes d2 WHERE d2.post_id = p.id AND d2.addr = ?) AS viewer_disliked
`;

router.get('/', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
  const viewer = typeof req.query.addr === 'string' ? req.query.addr : '';
  const sort = SORTS[req.query.sort] !== undefined ? req.query.sort : 'latest';
  const kind = ['media', 'text'].includes(req.query.kind) ? req.query.kind : null;
  const tag = typeof req.query.tag === 'string' && req.query.tag
    ? req.query.tag.toLowerCase().replace(/^#/, '').slice(0, MAX_TAG_LEN)
    : null;
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, MAX_SEARCH_LEN) : '';

  const filters = ["p.status = 'live'"];
  const filterParams = [];
  if (kind) { filters.push('p.kind = ?'); filterParams.push(kind); }
  if (tag) { filters.push('EXISTS(SELECT 1 FROM post_tags pt WHERE pt.post_id = p.id AND pt.tag = ?)'); filterParams.push(tag); }
  if (q) {
    // Escape LIKE wildcards so a literal % or _ in the query doesn't match everything.
    // SQLite string literals don't honour backslash escapes, so the ESCAPE
    // clause needs a literal single backslash: '\' , i.e. "'\\'" in JS.
    const needle = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
    filters.push("(COALESCE(p.body,'') LIKE ? ESCAPE '\\' OR COALESCE(p.caption,'') LIKE ? ESCAPE '\\')");
    filterParams.push(needle, needle);
  }

  let rows;
  let nextBefore = null;
  let nextOffset = null;

  if (sort === 'latest') {
    const before = parseInt(req.query.before, 10) || Number.MAX_SAFE_INTEGER;
    rows = db.prepare(`
      SELECT ${SELECT_COLUMNS} FROM posts p
      WHERE ${filters.join(' AND ')} AND p.id < ?
      ORDER BY p.id DESC LIMIT ?
    `).all(viewer, viewer, ...filterParams, before, limit);
    nextBefore = rows.length ? rows[rows.length - 1].id : null;
  } else {
    // Ranked sorts page by offset, and a deep offset makes SQLite walk every
    // skipped row. These windows are shallow by design, so cap it.
    const offset = Math.min(Math.max(0, parseInt(req.query.offset, 10) || 0), 1000);
    const { order, params } = SORTS[sort](Date.now());
    rows = db.prepare(`
      SELECT ${SELECT_COLUMNS} FROM posts p
      WHERE ${filters.join(' AND ')}
      ORDER BY ${order} LIMIT ? OFFSET ?
    `).all(viewer, viewer, ...filterParams, ...params, limit, offset);
    nextOffset = rows.length === limit ? offset + limit : null;
  }

  res.json({
    posts: rows.map(toPublicPost),
    nextBefore,
    nextOffset,
    sort
  });
});

// Most-used hashtags across recent live posts.
router.get('/tags/trending', (req, res) => {
  res.json({ tags: trendingTags(12) });
});

router.get('/:id', (req, res) => {
  const viewer = typeof req.query.addr === 'string' ? req.query.addr : '';
  const id = toRowId(req.params.id);
  if (!id) return res.status(404).json({ error: 'not found' });
  const row = db.prepare(`
    SELECT ${SELECT_COLUMNS} FROM posts p WHERE p.id = ? AND p.status = 'live'
  `).get(viewer, viewer, id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(toPublicPost(row));
});

function toPublicPost(row) {
  return {
    id: row.id,
    addr: row.addr,
    kind: row.kind || 'media',
    body: row.body,
    tags: tagsFor(row.id),
    mediaType: row.media_type,
    mediaUrl: row.file_path ? `/media/${path.basename(row.file_path)}` : null,
    thumbUrl: row.thumb_path ? `/media/${path.basename(row.thumb_path)}` : null,
    caption: row.caption,
    createdAt: row.created_at,
    width: row.width,
    height: row.height,
    likeCount: row.like_count,
    dislikeCount: row.dislike_count,
    commentCount: row.comment_count,
    viewerLiked: !!row.viewer_liked,
    viewerDisliked: !!row.viewer_disliked
  };
}

// POST /api/posts/text -- a short text post. Signed exactly like a media
// post, but there's no file, so it skips the upload quota (which is about
// bandwidth and disk) and the NSFW image pipeline (nothing to scan) and
// goes live immediately. Text still passes through reports and moderation.
router.post('/text', (req, res) => {
  if (!config.get('uploads_enabled')) {
    return res.status(503).json({ error: 'Posting is temporarily disabled by the administrator.' });
  }

  const action = authenticateAction(req, res, 'text_post');
  if (!action) return;
  const { addr, pubkey, payload, iphash } = action;

  const checked = validateBody(payload.body);
  if (!checked.ok) return res.status(400).json({ error: checked.error });

  // Cooldown: text posts are cheap to produce, so the guard is a short gap
  // between posts from the same address rather than a bandwidth quota.
  const lastPost = db.prepare(
    "SELECT created_at FROM posts WHERE addr = ? AND kind = 'text' ORDER BY id DESC LIMIT 1"
  ).get(addr);
  const cooldownMs = config.get('text_post_cooldown_seconds') * 1000;
  if (lastPost && Date.now() - lastPost.created_at < cooldownMs) {
    const wait = Math.ceil((cooldownMs - (Date.now() - lastPost.created_at)) / 1000);
    return res.status(429).json({ error: `Please wait ${wait}s before posting again.` });
  }

  const now = Date.now();
  const info = db.prepare(`
    INSERT INTO posts (addr, pubkey, kind, body, status, iphash, created_at)
    VALUES (?, ?, 'text', ?, 'live', ?, ?)
  `).run(addr, pubkey, checked.body, iphash, now);

  const postId = info.lastInsertRowid;
  const tags = saveTags(postId, checked.body);
  appendBlock({ type: 'post', addr, refId: postId, payload });

  res.status(201).json({ id: postId, status: 'live', tags });
});

// POST /api/posts -- multipart upload: fields addr, pubkey, signature,
// payload (JSON string of the signed envelope), caption (optional), file.
router.post('/', uploadQuota, upload.single('file'), async (req, res) => {
  try {
    if (!config.get('uploads_enabled')) {
      return res.status(503).json({ error: 'Uploads are temporarily disabled by the administrator.' });
    }
    if (!req.file) return res.status(400).json({ error: 'no file provided' });

    let parsedPayload;
    try {
      parsedPayload = JSON.parse(req.body.payload);
    } catch { return res.status(400).json({ error: 'bad payload JSON' }); }

    const action = authenticateAction(req, res, 'post', parsedPayload);
    if (!action) return;
    const { addr, pubkey, iphash } = action;

    // Multipart fields arrive as arrays when a key is repeated, so the type
    // has to be checked rather than assumed -- an array reaches the SQL
    // binding as an array and fails there instead of here.
    const caption = typeof req.body.caption === 'string' ? req.body.caption.slice(0, 500) : '';

    const sniffed = sniffType(req.file.buffer);
    if (!sniffed) return res.status(400).json({ error: 'unrecognized or unsupported file type' });

    const maxBytes = (sniffed.kind === 'image' ? config.get('max_image_mb') : config.get('max_video_mb')) * 1024 * 1024;
    if (req.file.buffer.length > maxBytes) {
      return res.status(413).json({ error: `file too large (max ${sniffed.kind === 'image' ? config.get('max_image_mb') : config.get('max_video_mb')} MB)` });
    }

    const fileHash = sha256Buffer(req.file.buffer);
    const dup = db.prepare('SELECT id, status FROM posts WHERE file_hash = ?').get(fileHash);
    if (dup) return res.status(409).json({ error: 'this exact file has already been posted', postId: dup.id });

    let finalPath, thumbPath, mediaType;
    let width = null, height = null;
    // A file that passes the magic-byte sniff can still be malformed, or a
    // header-only "pixel bomb" that trips sharp's input cap. That's a
    // rejected upload, not a server fault: report it as one, and don't leave
    // half-written files behind in pending/.
    try {
      if (sniffed.kind === 'image') {
        mediaType = 'image';
        const clean = await sanitizeImage(req.file.buffer);
        const thumb = await imageThumbnail(req.file.buffer);
        finalPath = path.join(UPLOADS_DIR, 'pending', `${fileHash}.webp`);
        thumbPath = path.join(UPLOADS_DIR, 'pending', `${fileHash}.thumb.jpg`);
        fs.writeFileSync(finalPath, clean);
        fs.writeFileSync(thumbPath, thumb);
        const meta = await sharp(clean).metadata();
        width = meta.width || null;
        height = meta.height || null;
      } else {
        mediaType = 'video';
        const rawPath = path.join(UPLOADS_DIR, 'pending', `${fileHash}.raw.upload`);
        fs.writeFileSync(rawPath, req.file.buffer);
        finalPath = path.join(UPLOADS_DIR, 'pending', `${fileHash}.mp4`);
        thumbPath = path.join(UPLOADS_DIR, 'pending', `${fileHash}.thumb.jpg`);
        try {
          await sanitizeVideo(rawPath, finalPath);
          await videoThumbnail(finalPath, thumbPath);
          // ffmpeg-static ships no ffprobe, but the thumbnail was scaled with
          // `-2` height so it keeps the source aspect ratio -- reading it back
          // gives us usable proportions for reserving space in the feed.
          const meta = await sharp(thumbPath).metadata();
          width = meta.width || null;
          height = meta.height || null;
        } finally {
          fs.unlink(rawPath, () => {});
        }
      }
    } catch (err) {
      for (const p of [finalPath, thumbPath]) {
        if (p) fs.unlink(p, () => {});
      }
      console.warn(`[upload] rejected unprocessable ${sniffed.kind}: ${err.message}`);
      return res.status(400).json({
        error: sniffed.kind === 'image'
          ? 'this image could not be processed (corrupt, or too large to decode)'
          : 'this video could not be processed (corrupt, or in an unsupported encoding)'
      });
    }

    const now = Date.now();
    const info = db.prepare(`
      INSERT INTO posts (addr, pubkey, media_type, file_hash, file_path, thumb_path, caption, width, height, status, iphash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(addr, pubkey, mediaType, fileHash, finalPath, thumbPath, caption, width, height, iphash, now);

    const postId = info.lastInsertRowid;
    appendBlock({ type: 'post', addr, refId: postId, payload: parsedPayload });
    req.recordUpload();

    enqueueModeration(postId);

    res.status(202).json({ id: postId, status: 'pending', message: 'Uploaded. Awaiting automated moderation.' });
  } catch (err) {
    console.error('upload error', err);
    res.status(500).json({ error: 'upload failed' });
  }
});

module.exports = router;
