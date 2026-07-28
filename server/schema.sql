-- Anon-share database schema.
-- Notes:
--  * No table anywhere stores a raw IP address. Only iphash (rotating salted
--    HMAC) values are ever persisted -- see server/lib/iphash.js.
--  * addr = "anon:" + base32(sha256(publicKey))[0:16], derived from a
--    client-held Ed25519 keypair. It is a pseudonymous, not a real, identity.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- A post is either a media post (image/video, the original format) or a
-- short text post. The media columns are nullable because text posts have
-- no file; `kind` is what tells the two apart.
CREATE TABLE IF NOT EXISTS posts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  addr          TEXT NOT NULL,
  pubkey        TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'media' CHECK (kind IN ('media','text')),
  body          TEXT,               -- text-post content (null for media posts)
  media_type    TEXT CHECK (media_type IS NULL OR media_type IN ('image', 'video')),
  file_hash     TEXT UNIQUE,
  file_path     TEXT,
  thumb_path    TEXT,
  caption       TEXT,
  width         INTEGER,            -- media dimensions, so the feed can
  height        INTEGER,            -- reserve space and avoid layout shift
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','live','review','blacklisted','removed')),
  nsfw_scores   TEXT,               -- JSON blob of the raw classifier output
  iphash        TEXT NOT NULL,      -- rotating salted hash, uploader's IP
  created_at    INTEGER NOT NULL,   -- unix ms
  reviewed_at   INTEGER,
  reviewed_by   TEXT                -- admin username / 'system'
);

-- Hashtags, extracted from text-post bodies and media captions at write
-- time so tag pages are a plain indexed lookup rather than a LIKE scan.
CREATE TABLE IF NOT EXISTS post_tags (
  post_id       INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  tag           TEXT NOT NULL,      -- lowercase, no leading '#'
  PRIMARY KEY (post_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_post_tags_tag ON post_tags(tag);

CREATE INDEX IF NOT EXISTS idx_posts_status_created ON posts(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_addr ON posts(addr);

CREATE TABLE IF NOT EXISTS comments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id       INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  addr          TEXT NOT NULL,
  pubkey        TEXT NOT NULL,
  body          TEXT NOT NULL,
  parent_id     INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live','removed')),
  iphash        TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, created_at DESC);

CREATE TABLE IF NOT EXISTS likes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id       INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  addr          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  UNIQUE(post_id, addr)
);

CREATE INDEX IF NOT EXISTS idx_likes_post ON likes(post_id);

CREATE TABLE IF NOT EXISTS dislikes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id       INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  addr          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  UNIQUE(post_id, addr)
);

CREATE INDEX IF NOT EXISTS idx_dislikes_post ON dislikes(post_id);

CREATE TABLE IF NOT EXISTS reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id       INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  addr          TEXT NOT NULL,
  reason        TEXT NOT NULL CHECK (reason IN ('adult','violence','spam','illegal','other')),
  note          TEXT,
  iphash        TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  -- Set once an admin has judged this report. Resolved reports stop
  -- counting toward the mass-report auto-blacklist threshold, so a post
  -- the admin has already cleared can't be re-hidden by the same pile-on.
  resolved      INTEGER NOT NULL DEFAULT 0,
  resolved_at   INTEGER,
  UNIQUE(post_id, addr)
);

CREATE INDEX IF NOT EXISTS idx_reports_post ON reports(post_id);
-- idx_reports_unresolved is created in db.js, after the column migrations,
-- since on a pre-existing database the `resolved` column it indexes does not
-- exist yet at the time this file runs.

-- Append-only hash-chained ledger. This is the "blockchain" layer: every
-- write action (post/comment/like/report) gets one row here, chained by
-- hash so any retroactive edit is detectable via verifyChain().
CREATE TABLE IF NOT EXISTS ledger (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT NOT NULL,       -- 'post' | 'comment' | 'like' | 'report' | 'genesis'
  addr          TEXT NOT NULL,
  ref_id        INTEGER,             -- id of the row in posts/comments/etc, if any
  payload_hash  TEXT NOT NULL,       -- sha256 of the canonical signed payload
  prev_hash     TEXT NOT NULL,
  hash          TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  redacted      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bans (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL CHECK (kind IN ('addr','iphash')),
  value         TEXT NOT NULL,
  reason        TEXT,
  created_at    INTEGER NOT NULL,
  created_by    TEXT NOT NULL,
  UNIQUE(kind, value)
);

-- Rolling-window upload quota tracking, keyed by iphash. One row per
-- upload event; old rows are pruned once outside the 1h window.
CREATE TABLE IF NOT EXISTS upload_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  iphash        TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_upload_events_iphash_time ON upload_events(iphash, created_at);

CREATE TABLE IF NOT EXISTS settings (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_audit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  admin         TEXT NOT NULL,
  action        TEXT NOT NULL,
  target        TEXT,
  detail        TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_auth (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token         TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_login_attempts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  iphash        TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  success       INTEGER NOT NULL
);
