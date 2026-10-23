// The upload pipeline: raw bytes in, sanitized media on disk out.
//
//   1. sniff the real type from magic bytes (the client's MIME is ignored)
//   2. enforce the per-type size cap from admin settings
//   3. refuse exact duplicates (by SHA-256)
//   4. re-encode: images through sharp, videos through ffmpeg -- which is
//      what strips EXIF/GPS and container metadata
//   5. write the result plus a thumbnail into uploads/pending/
//
// The post then waits there for the moderation queue (./queue.js).
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const db = require('../core/db');
const settings = require('../core/settings');
const { PENDING_DIR } = require('./storage');
const {
  sniffType, sha256Buffer, sanitizeImage, imageThumbnail, sanitizeVideo, videoThumbnail
} = require('./processing');

/**
 * Processes an uploaded file. Returns either
 *   { ok: true, mediaType, fileHash, filePath, thumbPath, width, height }
 * or
 *   { ok: false, status, error, extra? }
 */
async function ingestUpload(buffer) {
  const reject = (status, error, extra) => ({ ok: false, status, error, extra });

  const sniffed = sniffType(buffer);
  if (!sniffed) return reject(400, 'unrecognized or unsupported file type');

  const maxMb = sniffed.kind === 'image' ? settings.get('max_image_mb') : settings.get('max_video_mb');
  if (buffer.length > maxMb * 1024 * 1024) return reject(413, `file too large (max ${maxMb} MB)`);

  const fileHash = sha256Buffer(buffer);
  const dup = db.prepare('SELECT id FROM posts WHERE file_hash = ?').get(fileHash);
  if (dup) return reject(409, 'this exact file has already been posted', { postId: dup.id });

  const thumbPath = path.join(PENDING_DIR, `${fileHash}.thumb.jpg`);
  let filePath;

  // A file that passes the magic-byte sniff can still be malformed, or a
  // header-only "pixel bomb" that trips sharp's input cap. That's a rejected
  // upload, not a server fault: report it as one, and don't leave
  // half-written files behind in pending/.
  try {
    if (sniffed.kind === 'image') {
      filePath = path.join(PENDING_DIR, `${fileHash}.webp`);
      const clean = await sanitizeImage(buffer);
      fs.writeFileSync(filePath, clean);
      fs.writeFileSync(thumbPath, await imageThumbnail(buffer));
      const { width, height } = await sharp(clean).metadata();
      return { ok: true, mediaType: 'image', fileHash, filePath, thumbPath, width: width || null, height: height || null };
    }

    filePath = path.join(PENDING_DIR, `${fileHash}.mp4`);
    const rawPath = path.join(PENDING_DIR, `${fileHash}.raw.upload`);
    fs.writeFileSync(rawPath, buffer);
    try {
      await sanitizeVideo(rawPath, filePath);
      await videoThumbnail(filePath, thumbPath);
    } finally {
      fs.unlink(rawPath, () => {});
    }
    // ffmpeg-static ships no ffprobe, but the thumbnail was scaled with `-2`
    // height so it keeps the source aspect ratio -- reading it back gives
    // usable proportions for reserving space in the feed.
    const { width, height } = await sharp(thumbPath).metadata();
    return { ok: true, mediaType: 'video', fileHash, filePath, thumbPath, width: width || null, height: height || null };
  } catch (err) {
    for (const p of [filePath, thumbPath]) {
      if (p) fs.unlink(p, () => {});
    }
    console.warn(`[upload] rejected unprocessable ${sniffed.kind}: ${err.message}`);
    return reject(400, sniffed.kind === 'image'
      ? 'this image could not be processed (corrupt, or too large to decode)'
      : 'this video could not be processed (corrupt, or in an unsupported encoding)');
  }
}

module.exports = { ingestUpload };
