// Static config comes from environment variables (.env). Dynamic, admin-
// editable config (NSFW thresholds, rate limits, retention) lives in the
// `settings` DB table and is read/written through get()/set() below so the
// admin panel can change it without a restart.
'use strict';

require('dotenv').config();
const db = require('./db');

const DEFAULTS = {
  nsfw_block_threshold: 0.70,     // porn+hentai >= this -> auto-blacklist
  nsfw_review_threshold: 0.45,    // porn+hentai >= this -> hold for review
  nsfw_sexy_review_threshold: 0.85,
  quarantine_retention_hours: 24,
  upload_limit_per_hour: 10,
  read_limit_per_15min: 300,
  write_limit_per_min: 30,        // likes/comments
  report_limit_per_hour: 5,
  max_image_mb: 20,
  max_video_mb: 100,
  // Text posts cost no bandwidth, so they're throttled by a per-address
  // cooldown rather than the upload quota.
  text_post_cooldown_seconds: 20,
  // Mass-report threshold. A handful of reports never hides anything -- a
  // reported post stays live and simply surfaces in the admin Reports queue
  // for a human decision. Only a genuine pile-on this large auto-blacklists
  // the post (hidden from the public feed, still fully visible to the admin).
  report_auto_blacklist_count: 40,
  uploads_enabled: true
};

const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setStmt = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ' +
  'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

function seedDefaults() {
  const tx = db.transaction(() => {
    for (const [key, value] of Object.entries(DEFAULTS)) {
      const row = getStmt.get(key);
      if (!row) setStmt.run(key, JSON.stringify(value));
    }
  });
  tx();
}
seedDefaults();

// One-off migrations for settings whose stored value must be corrected on
// existing installs. seedDefaults() only fills in *missing* keys, so raising
// a default alone would leave older databases on the old value forever.
// Each entry runs at most once, tracked by its own marker key.
const SETTINGS_MIGRATIONS = [
  { marker: '_migrated_image_20mb', apply: () => setStmt.run('max_image_mb', JSON.stringify(20)) },
  {
    // Replaces the old "hide at 5 reports" behaviour with the mass-report
    // threshold, and clears the retired key so it stops showing in the
    // admin Settings page.
    marker: '_migrated_mass_report_threshold',
    apply: () => {
      setStmt.run('report_auto_blacklist_count', JSON.stringify(40));
      db.prepare('DELETE FROM settings WHERE key = ?').run('report_auto_hide_count');
    }
  }
];

function runSettingsMigrations() {
  const tx = db.transaction(() => {
    for (const { marker, apply } of SETTINGS_MIGRATIONS) {
      if (getStmt.get(marker)) continue;
      apply();
      setStmt.run(marker, JSON.stringify(true));
    }
  });
  tx();
}
runSettingsMigrations();

function get(key) {
  const row = getStmt.get(key);
  if (!row) return DEFAULTS[key];
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

function getAll() {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) out[key] = get(key);
  return out;
}

function set(key, value) {
  if (!(key in DEFAULTS)) throw new Error(`unknown setting: ${key}`);
  setStmt.run(key, JSON.stringify(value));
}

module.exports = {
  PORT: parseInt(process.env.PORT, 10) || 3000,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',
  IP_SALT_SEED: process.env.IP_SALT_SEED || 'dev-only-insecure-seed',
  SESSION_SECRET: process.env.SESSION_SECRET || 'dev-only-insecure-secret',
  TRUST_PROXY: process.env.TRUST_PROXY || false,
  FORCE_TFJS_CPU: /^true$/i.test(process.env.FORCE_TFJS_CPU || ''),
  DEFAULTS,
  get,
  getAll,
  set
};
