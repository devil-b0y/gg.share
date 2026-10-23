// Streams a file from disk as an HTTP response, with Range support.
//
// Replaces express.static / res.sendFile for media. Range requests are not
// optional here: browsers seek in video by requesting byte ranges, and
// Safari refuses to play an MP4 at all from a server that ignores them.
'use strict';

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const CONTENT_TYPES = {
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4'
};

/**
 * Parses a single-range `Range: bytes=...` header against a file size.
 * Returns { start, end } (inclusive), 'unsatisfiable', or null when there is
 * no usable range (serve the whole file). Multi-range requests are answered
 * with the whole file, which RFC 9110 permits.
 */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;

  let start, end;
  if (rawStart === '') {
    // "bytes=-500" -- the last 500 bytes.
    const suffix = Number(rawEnd);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

/**
 * Builds a Response for `fullPath`. The caller is responsible for having
 * validated the path (see media/storage.js#resolveMediaFile).
 *
 * @param {Request} request
 * @param {string}  fullPath
 * @param {object}  [opts]
 * @param {boolean} [opts.immutable] long-lived immutable caching. Safe for
 *   public media because filenames are the content's own SHA-256, so a URL
 *   can never change meaning.
 */
function fileResponse(request, fullPath, { immutable = false } = {}) {
  const stat = fs.statSync(fullPath);
  const headers = {
    'Content-Type': CONTENT_TYPES[path.extname(fullPath).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Last-Modified': stat.mtime.toUTCString(),
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=0',
    // Uploaded bytes are never markup, whatever a content-sniffing browser
    // might decide; inline disposition plus nosniff means a file that
    // somehow gets served as HTML still can't execute in this origin.
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'inline'
  };

  const range = parseRange(request.headers.get('range'), stat.size);
  if (range === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${stat.size}` } });
  }

  const isHead = request.method === 'HEAD';
  if (range) {
    const length = range.end - range.start + 1;
    const body = isHead ? null : Readable.toWeb(fs.createReadStream(fullPath, range));
    return new Response(body, {
      status: 206,
      headers: {
        ...headers,
        'Content-Length': String(length),
        'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`
      }
    });
  }

  const body = isHead ? null : Readable.toWeb(fs.createReadStream(fullPath));
  return new Response(body, { status: 200, headers: { ...headers, 'Content-Length': String(stat.size) } });
}

module.exports = { fileResponse, parseRange, CONTENT_TYPES };
