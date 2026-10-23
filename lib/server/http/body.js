// Size-limited JSON body reader.
//
// Mirrors what `express.json({ limit: '256kb' })` did: bodies over the limit
// are 413, malformed JSON is 400, and a request that isn't JSON at all
// yields an empty object rather than an error (logout, for example, posts
// with no body).
'use strict';

const { HttpError } = require('./errors');

const DEFAULT_LIMIT = 256 * 1024;

/**
 * Reads and parses the request body as JSON.
 * @param {Request} request
 * @param {number}  [limit] maximum body size in bytes
 */
async function readJson(request, limit = DEFAULT_LIMIT) {
  const type = request.headers.get('content-type') || '';
  if (!/^application\/([\w.+-]+\+)?json\b/i.test(type)) return {};

  // A declared length over the limit is refused before reading anything.
  const declared = Number(request.headers.get('content-length'));
  if (declared > limit) throw new HttpError(413, 'request too large');

  const text = await readTextCapped(request, limit);
  if (!text.trim()) return {};

  // Strict mode, like express.json(): only objects and arrays are bodies.
  // A bare string or number is almost certainly a client bug.
  const first = text.trimStart()[0];
  if (first !== '{' && first !== '[') throw new HttpError(400, 'malformed request body');

  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'malformed request body');
  }
}

/** Reads the body stream, aborting as soon as it passes `limit` bytes --
 * Content-Length can be absent (chunked) or simply wrong. */
async function readTextCapped(request, limit) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      reader.cancel().catch(() => {});
      throw new HttpError(413, 'request too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

module.exports = { readJson, DEFAULT_LIMIT };
