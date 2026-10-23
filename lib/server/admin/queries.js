// Read-only queries behind the admin panel's views.
//
// One function per panel view. They return plain objects and know nothing
// about HTTP; the routes under app/api/admin/ just call them and serialize
// the result.
'use strict';

const fs = require('fs');
const db = require('../core/db');
const settings = require('../core/settings');
const { DB_PATH } = require('../core/paths');
const { isBanned } = require('../security/bans');
const { verifyChain } = require('../content/ledger');
const { LIVE_DIR, PENDING_DIR, QUARANTINE_DIR, dirStats, adminMediaUrl } = require('../media/storage');

// --- dashboard ----------------------------------------------------------------

function dashboard() {
  const counts = db.prepare('SELECT status, COUNT(*) AS n FROM posts GROUP BY status').all();
  return {
    totalPosts: counts.reduce((s, r) => s + r.n, 0),
    byStatus: Object.fromEntries(counts.map((r) => [r.status, r.n])),
    totalComments: db.prepare("SELECT COUNT(*) AS n FROM comments WHERE status = 'live'").get().n,
    totalReports: db.prepare('SELECT COUNT(*) AS n FROM reports').get().n,
    uploadsLast24h: db.prepare('SELECT COUNT(*) AS n FROM posts WHERE created_at > ?').get(Date.now() - 86400000).n,
    settings: settings.getAll()
  };
}

// --- posts --------------------------------------------------------------------

/** Posts in one moderation state, newest first, with admin-only fields
 * (scores, report count, admin media URLs) attached. */
function listPostsByStatus(status) {
  const rows = db.prepare('SELECT * FROM posts WHERE status = ? ORDER BY created_at DESC LIMIT 200').all(status);
  const reportCount = db.prepare('SELECT COUNT(*) AS n FROM reports WHERE post_id = ?');
  return rows.map((row) => ({
    ...row,
    nsfw_scores: row.nsfw_scores ? JSON.parse(row.nsfw_scores) : null,
    mediaUrl: adminMediaUrl(row.file_path),
    thumbUrl: adminMediaUrl(row.thumb_path),
    reportCount: reportCount.get(row.id).n
  }));
}

// --- reports ------------------------------------------------------------------

/** Reported posts awaiting a decision, most-reported first. With
 * `includeResolved`, also posts whose reports were already handled. */
function listReports(includeResolved) {
  const rows = db.prepare(`
    SELECT p.id AS post_id, p.status, p.kind, p.body, p.media_type, p.addr, p.created_at,
           p.file_path, p.thumb_path, p.reviewed_by,
           SUM(CASE WHEN r.resolved = 0 THEN 1 ELSE 0 END) AS open_count,
           COUNT(r.id) AS total_count
    FROM reports r JOIN posts p ON p.id = r.post_id
    GROUP BY p.id
    HAVING ${includeResolved ? '1=1' : 'open_count > 0'}
    ORDER BY open_count DESC, total_count DESC, p.created_at DESC
    LIMIT 200
  `).all();

  const reasonsFor = db.prepare(
    'SELECT reason, note, created_at, resolved FROM reports WHERE post_id = ? ORDER BY created_at DESC LIMIT 50'
  );

  return {
    reports: rows.map((r) => ({
      post_id: r.post_id,
      status: r.status,
      kind: r.kind,
      body: r.body,
      media_type: r.media_type,
      addr: r.addr,
      created_at: r.created_at,
      openCount: r.open_count,
      totalCount: r.total_count,
      autoBlacklisted: r.reviewed_by === 'mass-report',
      mediaUrl: adminMediaUrl(r.file_path),
      thumbUrl: adminMediaUrl(r.thumb_path),
      reasons: reasonsFor.all(r.post_id)
    })),
    blacklistThreshold: settings.get('report_auto_blacklist_count')
  };
}

// --- audit + ledger -----------------------------------------------------------

function auditLog() {
  const rows = db.prepare('SELECT * FROM admin_audit ORDER BY id DESC LIMIT 300').all();
  return rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
}

// This app's "chain" is a real hash-linked ledger table (see
// content/ledger.js), not a blockchain -- there is no wallet, gas, or smart
// contract layer to monitor. This surfaces exactly what does exist: the
// block list and the tamper-evidence check.
function ledgerOverview(limit) {
  const blocks = db.prepare('SELECT * FROM ledger ORDER BY seq DESC LIMIT ?').all(limit);
  const totals = db.prepare('SELECT COUNT(*) AS total, SUM(redacted) AS redacted FROM ledger').get();
  const byType = db.prepare('SELECT type, COUNT(*) AS n FROM ledger GROUP BY type').all();
  return {
    blocks,
    totalBlocks: totals.total,
    redactedBlocks: totals.redacted || 0,
    byType: Object.fromEntries(byType.map((r) => [r.type, r.n])),
    verify: verifyChain()
  };
}

// --- storage ------------------------------------------------------------------
// Stands in for "IPFS Storage" -- there's no distributed pinning here, just
// local disk under uploads/, but disk usage, file counts and per-status
// breakdown are real and worth surfacing.

function storageOverview() {
  const dirs = {
    live: dirStats(LIVE_DIR),
    quarantine: dirStats(QUARANTINE_DIR),
    pending: dirStats(PENDING_DIR)
  };
  const byMediaType = db.prepare(`
    SELECT media_type, COUNT(*) AS n FROM posts WHERE file_path != '' GROUP BY media_type
  `).all();
  let dbBytes = 0;
  try { dbBytes = fs.statSync(DB_PATH).size; } catch { /* not yet created */ }

  return {
    dirs,
    totalBytes: dirs.live.bytes + dirs.quarantine.bytes + dirs.pending.bytes,
    totalFiles: dirs.live.count + dirs.quarantine.count + dirs.pending.count,
    byMediaType: Object.fromEntries(byMediaType.map((r) => [r.media_type, r.n])),
    purgedMediaCount: db.prepare("SELECT COUNT(*) AS n FROM posts WHERE file_path = '' AND status = 'blacklisted'").get().n,
    dbBytes,
    quarantineRetentionHours: settings.get('quarantine_retention_hours')
  };
}

// --- security center ----------------------------------------------------------

function securityOverview() {
  const since24h = Date.now() - 86400000;
  const since7d = Date.now() - 7 * 86400000;

  const loginStats = (since) => db.prepare(`
    SELECT SUM(success) AS ok, SUM(1 - success) AS fail, COUNT(DISTINCT iphash) AS uniqIp
    FROM admin_login_attempts WHERE created_at > ?
  `).get(since);

  const banCounts = db.prepare('SELECT kind, COUNT(*) AS n FROM bans GROUP BY kind').all();

  return {
    logins24h: loginStats(since24h),
    logins7d: loginStats(since7d),
    recentFailedLogins: db.prepare(`
      SELECT iphash, created_at FROM admin_login_attempts
      WHERE success = 0 AND created_at > ? ORDER BY created_at DESC LIMIT 25
    `).all(since7d),
    activeSessions: db.prepare('SELECT COUNT(*) AS n FROM admin_sessions WHERE expires_at > ?').get(Date.now()).n,
    bansByKind: Object.fromEntries(banCounts.map((r) => [r.kind, r.n])),
    rateLimits: {
      uploadPerHour: settings.get('upload_limit_per_hour'),
      readPer15Min: settings.get('read_limit_per_15min'),
      writePerMin: settings.get('write_limit_per_min'),
      reportPerHour: settings.get('report_limit_per_hour'),
      adminLoginPer15Min: 5
    }
  };
}

// --- reputation ---------------------------------------------------------------
// A per-address behaviour summary built entirely from this app's own tables
// -- there's no separate reputation/trust oracle, so "trust" here just means
// "what has this address actually done."

function reputation() {
  const addrs = db.prepare(`
    SELECT addr FROM posts
    UNION SELECT addr FROM comments
    UNION SELECT addr FROM reports
  `).all().map((r) => r.addr);

  const q = {
    posts: db.prepare("SELECT COUNT(*) AS n FROM posts WHERE addr = ? AND status != 'removed'"),
    blacklisted: db.prepare("SELECT COUNT(*) AS n FROM posts WHERE addr = ? AND status = 'blacklisted'"),
    reportsReceived: db.prepare('SELECT COUNT(*) AS n FROM reports r JOIN posts p ON p.id = r.post_id WHERE p.addr = ?'),
    reportsFiled: db.prepare('SELECT COUNT(*) AS n FROM reports WHERE addr = ?'),
    comments: db.prepare("SELECT COUNT(*) AS n FROM comments WHERE addr = ? AND status = 'live'"),
    likesReceived: db.prepare('SELECT COUNT(*) AS n FROM likes l JOIN posts p ON p.id = l.post_id WHERE p.addr = ?'),
    firstSeen: db.prepare(`
      SELECT MIN(ts) AS ts FROM (
        SELECT MIN(created_at) AS ts FROM posts WHERE addr = ?
        UNION SELECT MIN(created_at) FROM comments WHERE addr = ?
      )
    `)
  };

  const rows = addrs.map((addr) => ({
    addr,
    posts: q.posts.get(addr).n,
    blacklisted: q.blacklisted.get(addr).n,
    comments: q.comments.get(addr).n,
    reportsReceived: q.reportsReceived.get(addr).n,
    reportsFiled: q.reportsFiled.get(addr).n,
    likesReceived: q.likesReceived.get(addr).n,
    firstSeen: q.firstSeen.get(addr, addr).ts,
    bannedAddr: isBanned('addr', addr)
  }));

  // Worst first: reports received, softened slightly by genuine engagement.
  const badness = (a) => a.reportsReceived - a.likesReceived * 0.1;
  rows.sort((a, b) => badness(b) - badness(a));
  return rows.slice(0, 150);
}

// --- analytics ----------------------------------------------------------------
// Real counts from this app's own tables, bucketed by UTC day. "Active" here
// means "posted, commented, or voted" -- there are no sessions to count.

/** The last `days` UTC dates as YYYY-MM-DD, oldest first. */
function dayBuckets(days) {
  const out = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// Table names are interpolated into SQL, so only these fixed names are
// accepted -- never anything derived from a request.
const ANALYTICS_TABLES = new Set(['posts', 'comments', 'likes', 'dislikes', 'reports']);

function countsByDay(table, days, extraSelect = '') {
  if (!ANALYTICS_TABLES.has(table)) throw new Error(`not an analytics table: ${table}`);
  const rows = db.prepare(`
    SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day,
           COUNT(*) AS n ${extraSelect}
    FROM ${table} WHERE created_at > ?
    GROUP BY day
  `).all(Date.now() - days * 86400000);
  return Object.fromEntries(rows.map((r) => [r.day, r]));
}

function analytics(days) {
  const posts = countsByDay('posts', days, ', COUNT(DISTINCT addr) AS uniq');
  const comments = countsByDay('comments', days);
  const likes = countsByDay('likes', days);
  const dislikes = countsByDay('dislikes', days);
  const reports = countsByDay('reports', days);

  const series = dayBuckets(days).map((day) => ({
    day,
    posts: posts[day]?.n || 0,
    uniquePosters: posts[day]?.uniq || 0,
    comments: comments[day]?.n || 0,
    likes: likes[day]?.n || 0,
    dislikes: dislikes[day]?.n || 0,
    reports: reports[day]?.n || 0
  }));

  const reasonBreakdown = db.prepare('SELECT reason, COUNT(*) AS n FROM reports GROUP BY reason').all();

  return {
    series,
    reasonBreakdown: Object.fromEntries(reasonBreakdown.map((r) => [r.reason, r.n])),
    totals: {
      addresses: db.prepare(`
        SELECT COUNT(DISTINCT addr) AS n FROM (
          SELECT addr FROM posts UNION SELECT addr FROM comments UNION SELECT addr FROM likes
        )
      `).get().n,
      posts: db.prepare('SELECT COUNT(*) AS n FROM posts').get().n,
      comments: db.prepare('SELECT COUNT(*) AS n FROM comments').get().n,
      likes: db.prepare('SELECT COUNT(*) AS n FROM likes').get().n
    }
  };
}

module.exports = {
  dashboard,
  listPostsByStatus,
  listReports,
  auditLog,
  ledgerOverview,
  storageOverview,
  securityOverview,
  reputation,
  dayBuckets,
  analytics
};
