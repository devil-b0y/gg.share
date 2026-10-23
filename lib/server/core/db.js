// SQLite connection + schema bootstrap. better-sqlite3 is synchronous, so no
// promises/callbacks are needed anywhere this module is used.
//
// One connection per process: Next.js may evaluate this module more than once
// (each route bundle can carry its own copy), so the handle is cached on
// globalThis and every copy shares it. The migrations below then run exactly
// once per process instead of once per bundle.
'use strict';

const fs = require('fs');
const Database = require('better-sqlite3');
const { DATA_DIR, DB_PATH, SCHEMA_PATH } = require('./paths');

const GLOBAL_KEY = Symbol.for('anon-share.db');

function open() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // `next build` evaluates route modules in several worker processes at once,
  // and each of them opens this database. Waiting on a lock briefly is far
  // better than failing the build with SQLITE_BUSY.
  db.pragma('busy_timeout = 5000');

  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  migrate(db);
  return db;
}

/** Brings an existing database up to the current schema. Every step is
 * idempotent, so this is safe to run on every boot. */
function migrate(db) {
  addColumnIfMissing(db, 'reports', 'resolved', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'reports', 'resolved_at', 'INTEGER');
  // Media dimensions let the feed reserve exact space before an image loads,
  // which is what stops cards from jumping around as you scroll.
  addColumnIfMissing(db, 'posts', 'width', 'INTEGER');
  addColumnIfMissing(db, 'posts', 'height', 'INTEGER');

  // Indexes over migrated columns must be created after the ALTERs above.
  db.exec('CREATE INDEX IF NOT EXISTS idx_reports_unresolved ON reports(resolved, post_id)');

  migratePostsForTextKind(db);
}

// `CREATE TABLE IF NOT EXISTS` in schema.sql only creates missing tables --
// it will not add a new column to a table that already exists. These
// idempotent ALTERs bring older databases up to date without a rebuild.
function addColumnIfMissing(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`[db] migrated: added ${table}.${column}`);
}

// Text posts need media_type/file_hash/file_path to be nullable, and SQLite
// cannot relax a NOT NULL constraint with ALTER TABLE -- the only supported
// route is the documented rebuild: create the new shape, copy rows across,
// drop the old table, rename. Foreign keys are disabled for the swap so the
// child tables that reference posts(id) survive the drop, and re-enabled
// straight after.
function migratePostsForTextKind(db) {
  const columns = db.prepare('PRAGMA table_info(posts)').all();
  if (columns.length === 0 || columns.some((c) => c.name === 'kind')) return;

  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE posts_rebuilt (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          addr          TEXT NOT NULL,
          pubkey        TEXT NOT NULL,
          kind          TEXT NOT NULL DEFAULT 'media' CHECK (kind IN ('media','text')),
          body          TEXT,
          media_type    TEXT CHECK (media_type IS NULL OR media_type IN ('image', 'video')),
          file_hash     TEXT UNIQUE,
          file_path     TEXT,
          thumb_path    TEXT,
          caption       TEXT,
          width         INTEGER,
          height        INTEGER,
          status        TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','live','review','blacklisted','removed')),
          nsfw_scores   TEXT,
          iphash        TEXT NOT NULL,
          created_at    INTEGER NOT NULL,
          reviewed_at   INTEGER,
          reviewed_by   TEXT
        );

        INSERT INTO posts_rebuilt
          (id, addr, pubkey, kind, body, media_type, file_hash, file_path, thumb_path,
           caption, width, height, status, nsfw_scores, iphash, created_at, reviewed_at, reviewed_by)
        SELECT
           id, addr, pubkey, 'media', NULL, media_type, file_hash, file_path, thumb_path,
           caption, width, height, status, nsfw_scores, iphash, created_at, reviewed_at, reviewed_by
        FROM posts;

        DROP TABLE posts;
        ALTER TABLE posts_rebuilt RENAME TO posts;

        CREATE INDEX IF NOT EXISTS idx_posts_status_created ON posts(status, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_posts_addr ON posts(addr);
      `);
    })();
    console.log('[db] migrated: posts table rebuilt for text posts');
  } finally {
    db.pragma('foreign_keys = ON');
  }

  const check = db.pragma('foreign_key_check');
  if (check.length) console.warn('[db] foreign key issues after posts rebuild:', check);
}
if (!globalThis[GLOBAL_KEY]) globalThis[GLOBAL_KEY] = open();

module.exports = globalThis[GLOBAL_KEY];
