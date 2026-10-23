'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('../db');
const config = require('../config');
const auth = require('../lib/auth');
const { verifyChain } = require('../lib/ledger');
const { ban, unban, listBans, isBanned } = require('../lib/bans');
const { moveFile, LIVE_DIR, QUARANTINE_DIR, purgeExpiredQuarantine } = require('../lib/queue');
const { adminLoginLimiter } = require('../lib/ratelimit');
const { hashIp, clientIp } = require('../lib/iphash');

const router = express.Router();

function audit(req, action, target, detail) {
  db.prepare('INSERT INTO admin_audit (admin, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('admin', action, target || null, detail ? JSON.stringify(detail) : null, Date.now());
}

// --- auth -------------------------------------------------------------

router.post('/login', adminLoginLimiter, async (req, res) => {
  const { password } = req.body || {};
  const iphash = hashIp(clientIp(req));
  // A non-string password (`{"password": {...}}`) must fail as a wrong
  // password, not reach scrypt and throw.
  const ok = typeof password === 'string' && await auth.checkAdminPassword(password);
  db.prepare('INSERT INTO admin_login_attempts (iphash, created_at, success) VALUES (?, ?, ?)')
    .run(iphash, Date.now(), ok ? 1 : 0);
  if (!ok) return res.status(401).json({ error: 'invalid password' });

  const token = auth.createSession();
  res.cookie(auth.COOKIE_NAME, token, auth.sessionCookieOptions(req));
  audit(req, 'login', null, null);
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  const token = req.cookies?.[auth.COOKIE_NAME];
  if (token) auth.destroySession(token);
  res.clearCookie(auth.COOKIE_NAME);
  res.json({ ok: true });
});

router.get('/session', (req, res) => {
  const token = req.cookies?.[auth.COOKIE_NAME];
  res.json({ authenticated: auth.isValidSession(token) });
});

// Everything below requires a valid admin session.
router.use(auth.requireAdmin);

// Serves media that isn't in the public /media static mount (pending
// review or quarantined) so the admin can see what they're moderating.
// Restricted to admin sessions only, and confined to the uploads tree.
// Every stored name is the content's own SHA-256 plus a known suffix, so the
// filename can be matched exactly rather than merely filtered for dangerous
// characters -- nothing that isn't a name this server itself wrote can get
// past the pattern. The resolved path is still re-checked against each
// directory below as a second line of defence.
const MEDIA_NAME = /^[0-9a-f]{64}(\.thumb\.jpg|\.webp|\.mp4|\.jpg)$/;

router.get('/media/:file', (req, res) => {
  const file = req.params.file;
  if (!MEDIA_NAME.test(file)) return res.status(400).end();
  for (const dir of [LIVE_DIR, QUARANTINE_DIR, path.join(__dirname, '..', '..', 'uploads', 'pending')]) {
    const full = path.resolve(dir, file);
    if (!full.startsWith(path.resolve(dir) + path.sep)) continue;
    if (fs.existsSync(full)) return res.sendFile(full);
  }
  res.status(404).end();
});

// --- dashboard ----------------------------------------------------------

router.get('/dashboard', (req, res) => {
  const counts = db.prepare(`
    SELECT status, COUNT(*) AS n FROM posts GROUP BY status
  `).all();
  const totals = Object.fromEntries(counts.map((r) => [r.status, r.n]));
  const totalPosts = counts.reduce((s, r) => s + r.n, 0);
  const totalComments = db.prepare("SELECT COUNT(*) AS n FROM comments WHERE status = 'live'").get().n;
  const totalReports = db.prepare('SELECT COUNT(*) AS n FROM reports').get().n;
  const uploadsLast24h = db.prepare('SELECT COUNT(*) AS n FROM posts WHERE created_at > ?').get(Date.now() - 86400000).n;
  res.json({
    totalPosts,
    byStatus: totals,
    totalComments,
    totalReports,
    uploadsLast24h,
    settings: config.getAll()
  });
});

// --- posts (live browse + manual removal) -------------------------------

router.get('/posts', (req, res) => {
  const status = req.query.status || 'live';
  const rows = db.prepare('SELECT * FROM posts WHERE status = ? ORDER BY created_at DESC LIMIT 200').all(status);
  res.json({ posts: rows.map(decoratePost) });
});

function decoratePost(row) {
  return {
    ...row,
    nsfw_scores: row.nsfw_scores ? JSON.parse(row.nsfw_scores) : null,
    mediaUrl: row.file_path ? `/api/admin/media/${path.basename(row.file_path)}` : null,
    thumbUrl: row.thumb_path ? `/api/admin/media/${path.basename(row.thumb_path)}` : null,
    reportCount: db.prepare('SELECT COUNT(*) AS n FROM reports WHERE post_id = ?').get(row.id).n
  };
}

/** Any admin decision on a post also settles its outstanding reports, so a
 * handled post stops reappearing in the Reports queue. */
function resolveReportsFor(postId) {
  db.prepare('UPDATE reports SET resolved = 1, resolved_at = ? WHERE post_id = ? AND resolved = 0')
    .run(Date.now(), postId);
}

router.post('/posts/:id/remove', (req, res) => {
  const id = req.params.id;
  db.prepare("UPDATE posts SET status = 'removed', reviewed_at = ?, reviewed_by = 'admin' WHERE id = ?")
    .run(Date.now(), id);
  resolveReportsFor(id);
  audit(req, 'remove_post', id, null);
  res.json({ ok: true });
});

router.post('/posts/:id/approve', (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'not found' });
  const newFile = post.file_path ? moveFile(post.file_path, path.join(LIVE_DIR, path.basename(post.file_path))) : null;
  const newThumb = post.thumb_path ? moveFile(post.thumb_path, path.join(LIVE_DIR, path.basename(post.thumb_path))) : null;
  db.prepare("UPDATE posts SET status = 'live', file_path = COALESCE(?, file_path), thumb_path = COALESCE(?, thumb_path), reviewed_at = ?, reviewed_by = 'admin' WHERE id = ?")
    .run(newFile, newThumb, Date.now(), req.params.id);
  resolveReportsFor(req.params.id);
  audit(req, 'approve_post', req.params.id, null);
  res.json({ ok: true });
});

router.post('/posts/:id/blacklist', (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'not found' });
  const newFile = post.file_path ? moveFile(post.file_path, path.join(QUARANTINE_DIR, path.basename(post.file_path))) : null;
  const newThumb = post.thumb_path ? moveFile(post.thumb_path, path.join(QUARANTINE_DIR, path.basename(post.thumb_path))) : null;
  db.prepare("UPDATE posts SET status = 'blacklisted', file_path = COALESCE(?, file_path), thumb_path = COALESCE(?, thumb_path), reviewed_at = ?, reviewed_by = 'admin' WHERE id = ?")
    .run(newFile, newThumb, Date.now(), req.params.id);
  resolveReportsFor(req.params.id);
  audit(req, 'blacklist_post', req.params.id, null);
  res.json({ ok: true });
});

router.post('/posts/:id/restore', (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'not found' });

  // Text posts have no file to move -- only a media post that's had its
  // file purged is genuinely unrestorable. Checking `kind` first is what
  // was missing: every text post has file_path = NULL by definition
  // (never had media to begin with), which used to be indistinguishable
  // from "media was purged" and made restore always fail for them.
  if (post.kind !== 'text' && !post.file_path) {
    return res.status(410).json({ error: 'media already purged, cannot restore' });
  }

  const newFile = post.file_path ? moveFile(post.file_path, path.join(LIVE_DIR, path.basename(post.file_path))) : null;
  const newThumb = post.thumb_path ? moveFile(post.thumb_path, path.join(LIVE_DIR, path.basename(post.thumb_path))) : null;
  db.prepare("UPDATE posts SET status = 'live', file_path = COALESCE(?, file_path), thumb_path = COALESCE(?, thumb_path), reviewed_at = ?, reviewed_by = 'admin' WHERE id = ?")
    .run(newFile, newThumb, Date.now(), req.params.id);
  audit(req, 'restore_post', req.params.id, null);
  res.json({ ok: true });
});

router.post('/posts/:id/purge', (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'not found' });
  for (const p of [post.file_path, post.thumb_path]) {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
  }
  const { redactRef } = require('../lib/ledger');
  db.prepare("UPDATE posts SET file_path = '', thumb_path = '', status = 'removed', reviewed_at = ?, reviewed_by = 'admin' WHERE id = ?")
    .run(Date.now(), req.params.id);
  redactRef('post', req.params.id);
  audit(req, 'purge_post', req.params.id, null);
  res.json({ ok: true });
});

// --- reports --------------------------------------------------------------

// Reported posts awaiting a decision, most-reported first. `?include=all`
// also returns posts whose reports the admin has already resolved.
router.get('/reports', (req, res) => {
  const includeResolved = req.query.include === 'all';
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

  const reports = rows.map((r) => ({
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
    mediaUrl: r.file_path ? `/api/admin/media/${path.basename(r.file_path)}` : null,
    thumbUrl: r.thumb_path ? `/api/admin/media/${path.basename(r.thumb_path)}` : null,
    reasons: db.prepare(
      'SELECT reason, note, created_at, resolved FROM reports WHERE post_id = ? ORDER BY created_at DESC LIMIT 50'
    ).all(r.post_id)
  }));

  res.json({ reports, blacklistThreshold: config.get('report_auto_blacklist_count') });
});

// "Keep this post" -- clears the open reports without touching the post, so
// it drops out of the queue. If a mass report had auto-blacklisted it, this
// also restores it to the live feed.
router.post('/reports/:postId/dismiss', (req, res) => {
  const postId = req.params.postId;
  db.prepare('UPDATE reports SET resolved = 1, resolved_at = ? WHERE post_id = ? AND resolved = 0')
    .run(Date.now(), postId);

  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  let restored = false;
  if (post && post.status === 'blacklisted' && post.reviewed_by === 'mass-report' && post.file_path) {
    const newFile = moveFile(post.file_path, path.join(LIVE_DIR, path.basename(post.file_path)));
    const newThumb = post.thumb_path
      ? moveFile(post.thumb_path, path.join(LIVE_DIR, path.basename(post.thumb_path)))
      : null;
    db.prepare(`
      UPDATE posts SET status = 'live',
                       file_path = COALESCE(?, file_path),
                       thumb_path = COALESCE(?, thumb_path),
                       reviewed_at = ?, reviewed_by = 'admin'
      WHERE id = ?
    `).run(newFile, newThumb, Date.now(), postId);
    restored = true;
  }

  audit(req, 'dismiss_reports', postId, { restored });
  res.json({ ok: true, restored });
});

// --- bans -------------------------------------------------------------

router.get('/bans', (req, res) => {
  res.json({ bans: listBans() });
});

router.post('/bans', (req, res) => {
  const { kind, value, reason } = req.body || {};
  if (!['addr', 'iphash'].includes(kind) || !value) return res.status(400).json({ error: 'bad kind/value' });
  ban(kind, value, reason, 'admin');
  audit(req, 'ban', value, { kind, reason });
  res.json({ ok: true });
});

router.delete('/bans/:kind/:value', (req, res) => {
  unban(req.params.kind, req.params.value);
  audit(req, 'unban', req.params.value, { kind: req.params.kind });
  res.json({ ok: true });
});

// --- settings -----------------------------------------------------------

router.get('/settings', (req, res) => {
  res.json({ settings: config.getAll(), defaults: config.DEFAULTS, rules: config.RULES });
});

router.post('/settings', (req, res) => {
  const updates = req.body || {};
  if (typeof updates !== 'object' || Array.isArray(updates)) {
    return res.status(400).json({ error: 'expected an object of settings' });
  }

  // Validate the whole batch first, then apply. A half-applied update would
  // leave the moderation thresholds in a combination the admin never chose.
  const accepted = [];
  for (const key of Object.keys(updates)) {
    if (!config.isKnownSetting(key)) return res.status(400).json({ error: `unknown setting: ${key}` });
    if (!config.isValid(key, updates[key])) {
      const rule = config.RULES[key];
      const range = rule.type === 'boolean' ? 'true or false' : `${rule.type} between ${rule.min} and ${rule.max}`;
      return res.status(400).json({ error: `invalid value for ${key} (expected ${range})` });
    }
    accepted.push(key);
  }

  for (const key of accepted) config.set(key, updates[key]);
  audit(req, 'update_settings', null, Object.fromEntries(accepted.map((k) => [k, updates[k]])));
  res.json({ ok: true, settings: config.getAll() });
});

// --- chain integrity ------------------------------------------------------

router.get('/chain-verify', (req, res) => {
  res.json(verifyChain());
});

router.post('/purge-sweep', (req, res) => {
  purgeExpiredQuarantine();
  audit(req, 'manual_purge_sweep', null, null);
  res.json({ ok: true });
});

// --- audit log ------------------------------------------------------------

router.get('/audit', (req, res) => {
  const rows = db.prepare('SELECT * FROM admin_audit ORDER BY id DESC LIMIT 300').all();
  res.json({ audit: rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null })) });
});

// --- ledger monitor ---------------------------------------------------
// This app's "chain" is a real hash-linked ledger table (see
// server/lib/ledger.js), not a blockchain -- there is no wallet, gas, or
// smart contract layer to monitor. This surfaces exactly what does exist:
// the block list and the tamper-evidence check.

router.get('/ledger', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const blocks = db.prepare('SELECT * FROM ledger ORDER BY seq DESC LIMIT ?').all(limit);
  const totals = db.prepare(`
    SELECT COUNT(*) AS total, SUM(redacted) AS redacted FROM ledger
  `).get();
  const byType = db.prepare('SELECT type, COUNT(*) AS n FROM ledger GROUP BY type').all();
  res.json({
    blocks,
    totalBlocks: totals.total,
    redactedBlocks: totals.redacted || 0,
    byType: Object.fromEntries(byType.map((r) => [r.type, r.n])),
    verify: verifyChain()
  });
});

// --- storage ------------------------------------------------------------
// Stands in for "IPFS Storage" -- there's no distributed pinning here, just
// local disk under uploads/, but disk usage, file counts and per-status
// breakdown are real and worth surfacing.

function dirStats(dir) {
  let count = 0, bytes = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch { return { count: 0, bytes: 0 }; }
  for (const name of entries) {
    try {
      const stat = fs.statSync(path.join(dir, name));
      if (stat.isFile()) { count++; bytes += stat.size; }
    } catch { /* file vanished mid-scan, e.g. purge sweep -- skip it */ }
  }
  return { count, bytes };
}

router.get('/storage', (req, res) => {
  const uploadsRoot = path.join(__dirname, '..', '..', 'uploads');
  const dirs = {
    live: dirStats(LIVE_DIR),
    quarantine: dirStats(QUARANTINE_DIR),
    pending: dirStats(path.join(uploadsRoot, 'pending'))
  };
  const byMediaType = db.prepare(`
    SELECT media_type, COUNT(*) AS n FROM posts WHERE file_path != '' GROUP BY media_type
  `).all();
  const dbFile = path.join(__dirname, '..', '..', 'data', 'app.db');
  let dbBytes = 0;
  try { dbBytes = fs.statSync(dbFile).size; } catch { /* not yet created */ }
  const purged = db.prepare("SELECT COUNT(*) AS n FROM posts WHERE file_path = '' AND status = 'blacklisted'").get().n;

  res.json({
    dirs,
    totalBytes: dirs.live.bytes + dirs.quarantine.bytes + dirs.pending.bytes,
    totalFiles: dirs.live.count + dirs.quarantine.count + dirs.pending.count,
    byMediaType: Object.fromEntries(byMediaType.map((r) => [r.media_type, r.n])),
    purgedMediaCount: purged,
    dbBytes,
    quarantineRetentionHours: config.get('quarantine_retention_hours')
  });
});

// --- security center --------------------------------------------------

router.get('/security', (req, res) => {
  const since24h = Date.now() - 86400000;
  const since7d = Date.now() - 7 * 86400000;

  const loginStats = (since) => db.prepare(`
    SELECT SUM(success) AS ok, SUM(1 - success) AS fail, COUNT(DISTINCT iphash) AS uniqIp
    FROM admin_login_attempts WHERE created_at > ?
  `).get(since);

  const recentFailed = db.prepare(`
    SELECT iphash, created_at FROM admin_login_attempts
    WHERE success = 0 AND created_at > ? ORDER BY created_at DESC LIMIT 25
  `).all(since7d);

  const activeSessions = db.prepare(
    'SELECT COUNT(*) AS n FROM admin_sessions WHERE expires_at > ?'
  ).get(Date.now()).n;

  const banCounts = db.prepare('SELECT kind, COUNT(*) AS n FROM bans GROUP BY kind').all();

  res.json({
    logins24h: loginStats(since24h),
    logins7d: loginStats(since7d),
    recentFailedLogins: recentFailed,
    activeSessions,
    bansByKind: Object.fromEntries(banCounts.map((r) => [r.kind, r.n])),
    rateLimits: {
      uploadPerHour: config.get('upload_limit_per_hour'),
      readPer15Min: config.get('read_limit_per_15min'),
      writePerMin: config.get('write_limit_per_min'),
      reportPerHour: config.get('report_limit_per_hour'),
      adminLoginPer15Min: 5
    }
  });
});

// --- reputation -----------------------------------------------------------
// A per-address behaviour summary built entirely from this app's own
// tables -- there's no separate reputation/trust oracle, so "trust" here
// just means "what has this address actually done."

router.get('/reputation', (req, res) => {
  const addrs = db.prepare(`
    SELECT addr FROM posts
    UNION SELECT addr FROM comments
    UNION SELECT addr FROM reports
  `).all().map((r) => r.addr);

  const postCount = db.prepare("SELECT COUNT(*) AS n FROM posts WHERE addr = ? AND status != 'removed'");
  const blacklistedCount = db.prepare("SELECT COUNT(*) AS n FROM posts WHERE addr = ? AND status = 'blacklisted'");
  const reportsReceived = db.prepare(`
    SELECT COUNT(*) AS n FROM reports r JOIN posts p ON p.id = r.post_id WHERE p.addr = ?
  `);
  const reportsFiled = db.prepare('SELECT COUNT(*) AS n FROM reports WHERE addr = ?');
  const commentCount = db.prepare("SELECT COUNT(*) AS n FROM comments WHERE addr = ? AND status = 'live'");
  const likesReceived = db.prepare(`
    SELECT COUNT(*) AS n FROM likes l JOIN posts p ON p.id = l.post_id WHERE p.addr = ?
  `);
  const firstSeen = db.prepare(`
    SELECT MIN(ts) AS ts FROM (
      SELECT MIN(created_at) AS ts FROM posts WHERE addr = ?
      UNION SELECT MIN(created_at) FROM comments WHERE addr = ?
    )
  `);

  const rows = addrs.map((addr) => ({
    addr,
    posts: postCount.get(addr).n,
    blacklisted: blacklistedCount.get(addr).n,
    comments: commentCount.get(addr).n,
    reportsReceived: reportsReceived.get(addr).n,
    reportsFiled: reportsFiled.get(addr).n,
    likesReceived: likesReceived.get(addr).n,
    firstSeen: firstSeen.get(addr, addr).ts,
    bannedAddr: isBanned('addr', addr)
  }));

  rows.sort((a, b) => (b.reportsReceived - b.likesReceived * 0.1) - (a.reportsReceived - a.likesReceived * 0.1));
  res.json({ addresses: rows.slice(0, 150) });
});

// --- analytics --------------------------------------------------------
// Real counts from this app's own tables, bucketed by day. No DAU in the
// wallet-connect sense (there are no sessions to speak of) -- "active" here
// means "posted, commented, or voted."

function dailySeries(days = 14) {
  const buckets = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    buckets.push(d.toISOString().slice(0, 10));
  }
  return buckets;
}

function bucketCounts(table, days, extraSelect = '') {
  const since = Date.now() - days * 86400000;
  const rows = db.prepare(`
    SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day,
           COUNT(*) AS n ${extraSelect}
    FROM ${table} WHERE created_at > ?
    GROUP BY day
  `).all(since);
  return Object.fromEntries(rows.map((r) => [r.day, r]));
}

router.get('/analytics', (req, res) => {
  const days = Math.min(parseInt(req.query.days, 10) || 14, 60);
  const buckets = dailySeries(days);

  const posts = bucketCounts('posts', days, ', COUNT(DISTINCT addr) AS uniq');
  const comments = bucketCounts('comments', days);
  const likes = bucketCounts('likes', days);
  const dislikes = bucketCounts('dislikes', days);
  const reports = bucketCounts('reports', days);

  const series = buckets.map((day) => ({
    day,
    posts: posts[day]?.n || 0,
    uniquePosters: posts[day]?.uniq || 0,
    comments: comments[day]?.n || 0,
    likes: likes[day]?.n || 0,
    dislikes: dislikes[day]?.n || 0,
    reports: reports[day]?.n || 0
  }));

  const reasonBreakdown = db.prepare('SELECT reason, COUNT(*) AS n FROM reports GROUP BY reason').all();

  res.json({
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
  });
});

module.exports = router;
