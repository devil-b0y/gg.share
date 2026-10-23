// Post queries and their public representation.
//
// Everything the public API needs to read posts lives here: the feed query
// (filters, sort modes, pagination), single-post lookup, and the mapping
// from a database row to the JSON shape the browser receives. Route handlers
// only parse the query string and call these.
'use strict';

const db = require('../core/db');
const { scoreExpr } = require('./rank');
const { tagsFor } = require('./text');
const { publicMediaUrl } = require('../media/storage');

// Search terms go into a LIKE '%...%' scan, which has no index to fall back
// on -- an unbounded needle is an easy way to make every query expensive.
const MAX_SEARCH_LEN = 100;
const MAX_TAG_LEN = 50;
const MAX_PAGE_SIZE = 50;
const MAX_RANKED_OFFSET = 1000;

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

// The two viewer placeholders let each post carry the viewer's own
// like/dislike state inline. Without them the client had to fire two extra
// requests per card -- 20 round-trips for a 10-post page -- before the feed
// settled. The viewer's `addr` is already public on every post it appears
// on, so passing it reveals nothing new.
const SELECT_COLUMNS = `
  p.id, p.addr, p.kind, p.body, p.media_type, p.file_path, p.thumb_path, p.caption,
  p.created_at, p.width, p.height,
  (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count,
  (SELECT COUNT(*) FROM dislikes d WHERE d.post_id = p.id) AS dislike_count,
  (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.status = 'live') AS comment_count,
  EXISTS(SELECT 1 FROM likes l2 WHERE l2.post_id = p.id AND l2.addr = ?) AS viewer_liked,
  EXISTS(SELECT 1 FROM dislikes d2 WHERE d2.post_id = p.id AND d2.addr = ?) AS viewer_disliked
`;

/**
 * Normalizes raw query-string values into a safe feed query. Anything
 * unrecognised falls back to a default instead of erroring, so a stale or
 * hand-edited URL still shows a feed.
 *
 * @param {URLSearchParams} qs
 */
function parseFeedQuery(qs) {
  const get = (k) => qs.get(k);
  const sort = Object.prototype.hasOwnProperty.call(SORTS, get('sort')) ? get('sort') : 'latest';
  const rawTag = get('tag');
  return {
    limit: Math.min(parseInt(get('limit'), 10) || 20, MAX_PAGE_SIZE),
    viewer: get('addr') || '',
    sort,
    kind: ['media', 'text'].includes(get('kind')) ? get('kind') : null,
    tag: rawTag ? rawTag.toLowerCase().replace(/^#/, '').slice(0, MAX_TAG_LEN) : null,
    q: (get('q') || '').trim().slice(0, MAX_SEARCH_LEN),
    before: parseInt(get('before'), 10) || Number.MAX_SAFE_INTEGER,
    offset: Math.min(Math.max(0, parseInt(get('offset'), 10) || 0), MAX_RANKED_OFFSET)
  };
}

/** Runs a feed query. Returns { posts, nextBefore, nextOffset, sort }. */
function listFeed(query) {
  const { limit, viewer, sort, kind, tag, q } = query;

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
    rows = db.prepare(`
      SELECT ${SELECT_COLUMNS} FROM posts p
      WHERE ${filters.join(' AND ')} AND p.id < ?
      ORDER BY p.id DESC LIMIT ?
    `).all(viewer, viewer, ...filterParams, query.before, limit);
    nextBefore = rows.length ? rows[rows.length - 1].id : null;
  } else {
    const { order, params } = SORTS[sort](Date.now());
    rows = db.prepare(`
      SELECT ${SELECT_COLUMNS} FROM posts p
      WHERE ${filters.join(' AND ')}
      ORDER BY ${order} LIMIT ? OFFSET ?
    `).all(viewer, viewer, ...filterParams, ...params, limit, query.offset);
    nextOffset = rows.length === limit ? query.offset + limit : null;
  }

  return { posts: rows.map(toPublicPost), nextBefore, nextOffset, sort };
}

/** A single live post as the public sees it, or null. */
function getPublicPost(id, viewer = '') {
  const row = db.prepare(`
    SELECT ${SELECT_COLUMNS} FROM posts p WHERE p.id = ? AND p.status = 'live'
  `).get(viewer, viewer, id);
  return row ? toPublicPost(row) : null;
}

/** True if `id` is a live post (the precondition for votes and comments). */
function isLivePost(id) {
  return !!db.prepare("SELECT 1 FROM posts WHERE id = ? AND status = 'live'").get(id);
}

/** Maps a row to the public JSON shape. Never exposes iphash, pubkey,
 * filesystem paths or moderation scores. */
function toPublicPost(row) {
  return {
    id: row.id,
    addr: row.addr,
    kind: row.kind || 'media',
    body: row.body,
    tags: tagsFor(row.id),
    mediaType: row.media_type,
    mediaUrl: publicMediaUrl(row.file_path),
    thumbUrl: publicMediaUrl(row.thumb_path),
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

module.exports = {
  SORTS,
  parseFeedQuery,
  listFeed,
  getPublicPost,
  isLivePost,
  toPublicPost
};
