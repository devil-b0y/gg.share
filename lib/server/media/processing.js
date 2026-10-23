// Media validation and sanitization. Type is determined from file magic
// bytes (never trusts the client-supplied MIME/extension). Images are
// re-encoded through sharp, which strips all EXIF/IPTC/XMP metadata
// (including embedded GPS) by default unless .withMetadata() is called --
// we never call it. Videos are remuxed through ffmpeg with
// -map_metadata -1 to drop container-level metadata.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const sharp = require('sharp');
const ffmpegPath = require('ffmpeg-static');

// Magic-byte signatures for the formats we accept. Checked against the
// first bytes of the uploaded buffer regardless of what the client claims.
const SIGNATURES = [
  { kind: 'image', ext: 'jpg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { kind: 'image', ext: 'png', test: (b) => b.length > 8 && b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { kind: 'image', ext: 'gif', test: (b) => b.length > 6 && (b.slice(0, 6).toString('ascii') === 'GIF87a' || b.slice(0, 6).toString('ascii') === 'GIF89a') },
  { kind: 'image', ext: 'webp', test: (b) => b.length > 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP' },
  { kind: 'video', ext: 'mp4', test: (b) => b.length > 12 && b.slice(4, 8).toString('ascii') === 'ftyp' },
  { kind: 'video', ext: 'webm', test: (b) => b.length > 4 && b.slice(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) },
  { kind: 'video', ext: 'mov', test: (b) => b.length > 12 && ['ftyp', 'moov', 'free', 'mdat', 'wide'].includes(b.slice(4, 8).toString('ascii')) }
];

function sniffType(buffer) {
  for (const sig of SIGNATURES) {
    if (sig.test(buffer)) return { kind: sig.kind, ext: sig.ext };
  }
  return null;
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/** Re-encodes an image to WebP, discarding all metadata and baking in
 * EXIF orientation before stripping it. Handles animated GIF/WebP input by
 * preserving frames. Returns the sanitized buffer. */
// A few kilobytes of PNG can declare a canvas of billions of pixels; the
// decoder allocates for the declared size, not the compressed size. Every
// sharp pipeline that touches an upload has to carry this cap, or the one
// that doesn't becomes the way in.
const MAX_INPUT_PIXELS = 60_000_000;

async function sanitizeImage(inputBuffer) {
  const img = sharp(inputBuffer, { animated: true, limitInputPixels: MAX_INPUT_PIXELS });
  const meta = await img.metadata();
  const pipeline = sharp(inputBuffer, {
    animated: !!meta.pages && meta.pages > 1,
    limitInputPixels: MAX_INPUT_PIXELS
  })
    .rotate() // bake in EXIF orientation, then it's discarded like the rest
    .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true });
  return pipeline.webp({ quality: 85 }).toBuffer();
}

/** Generates a small JPEG thumbnail (first frame only) from an image
 * buffer -- used for the feed grid regardless of the source format. */
async function imageThumbnail(inputBuffer) {
  return sharp(inputBuffer, { animated: false, limitInputPixels: MAX_INPUT_PIXELS })
    .resize(480, 480, { fit: 'cover' })
    .jpeg({ quality: 72 })
    .toBuffer();
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-800)}`));
    });
  });
}

/** Remuxes a video, stripping all container-level metadata (GPS, device
 * info, timestamps beyond what the container needs). Re-encodes rather
 * than stream-copies so timestamps/metadata are fully rebuilt, and caps
 * duration/size to keep the moderation pipeline bounded. */
async function sanitizeVideo(inputPath, outputPath) {
  await runFfmpeg([
    '-y', '-i', inputPath,
    '-map_metadata', '-1',
    '-map', '0:v:0', '-map', '0:a:0?',
    '-t', '300', // hard cap: 5 minutes
    '-vf', "scale='min(1280,iw)':-2",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    outputPath
  ]);
}

/** Extracts a single JPEG thumbnail frame (~1s in) from a video file. */
async function videoThumbnail(inputPath, outputPath) {
  await runFfmpeg(['-y', '-ss', '1', '-i', inputPath, '-frames:v', '1', '-vf', 'scale=480:-2', outputPath]);
}

/** Extracts up to `maxFrames` JPEG frames, one every `intervalSec` seconds,
 * into `outDir` as frame-0001.jpg, frame-0002.jpg, ... Used by the NSFW
 * moderation pipeline to sample a video without decoding every frame. */
async function extractSampleFrames(inputPath, outDir, intervalSec = 2, maxFrames = 15) {
  fs.mkdirSync(outDir, { recursive: true });
  await runFfmpeg([
    '-y', '-i', inputPath,
    '-vf', `fps=1/${intervalSec},scale=224:224:force_original_aspect_ratio=increase,crop=224:224`,
    '-frames:v', String(maxFrames),
    path.join(outDir, 'frame-%04d.jpg')
  ]);
  return fs.readdirSync(outDir).filter((f) => f.endsWith('.jpg')).sort().map((f) => path.join(outDir, f));
}

module.exports = {
  sniffType,
  sha256Buffer,
  sha256File,
  sanitizeImage,
  imageThumbnail,
  sanitizeVideo,
  videoThumbnail,
  extractSampleFrames
};
