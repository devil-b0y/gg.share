// Helpers for short text posts: validation and hashtag extraction.
'use strict';

const db = require('../db');

const MIN_LEN = 1;
const MAX_LEN = 500;

// A tag is "#" followed by letters/digits/underscore. The leading boundary
// check stops it matching mid-word (so "c#" and "abc#def" are not tags) and
// the length cap keeps a wall of "#aaaa..." from becoming an index entry.
const TAG_PATTERN = /(^|[^0-9A-Za-z_#])#([0-9A-Za-z_]{1,50})/g;

function validateBody(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'body must be a string' };
  const body = raw.replace(/\r\n/g, '\n').trim();
  if (body.length < MIN_LEN) return { ok: false, error: 'post cannot be empty' };
  if (body.length > MAX_LEN) return { ok: false, error: `post is too long (max ${MAX_LEN} characters)` };
  return { ok: true, body };
}

/** Returns the unique lowercase tags in a string, capped so one post can't
 * spam the tag index. */
function extractTags(text, max = 10) {
  if (!text) return [];
  const found = new Set();
  for (const match of String(text).matchAll(TAG_PATTERN)) {
    found.add(match[2].toLowerCase());
    if (found.size >= max) break;
  }
  return [...found];
}

const insertTag = db.prepare('INSERT OR IGNORE INTO post_tags (post_id, tag) VALUES (?, ?)');
const clearTags = db.prepare('DELETE FROM post_tags WHERE post_id = ?');

function saveTags(postId, text) {
  const tags = extractTags(text);
  const tx = db.transaction(() => {
    clearTags.run(postId);
    for (const tag of tags) insertTag.run(postId, tag);
  });
  tx();
  return tags;
}

function tagsFor(postId) {
  return db.prepare('SELECT tag FROM post_tags WHERE post_id = ? ORDER BY tag').all(postId).map((r) => r.tag);
}

/** Most-used tags across live posts, for the trending sidebar. */
function trendingTags(limit = 12, sinceMs = 7 * 86400000) {
  return db.prepare(`
    SELECT t.tag, COUNT(*) AS n
    FROM post_tags t JOIN posts p ON p.id = t.post_id
    WHERE p.status = 'live' AND p.created_at > ?
    GROUP BY t.tag
    ORDER BY n DESC, t.tag ASC
    LIMIT ?
  `).all(Date.now() - sinceMs, limit);
}

module.exports = { MAX_LEN, validateBody, extractTags, saveTags, tagsFor, trendingTags };
