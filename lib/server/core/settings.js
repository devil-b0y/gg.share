// Admin-editable runtime settings (NSFW thresholds, rate limits, retention).
//
// These live in the `settings` DB table and are read/written through get()/
// set() below, so the admin panel can change them without a restart. Static
// configuration from environment variables is a separate concern -- see
// ./env.js.
'use strict';

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

// Bounds for every admin-editable setting. Without these, a typo in the
// admin panel could store a string where a number belongs -- and several of
// these values feed the rate limiters, so a bad value doesn't just look
// wrong, it switches a limit off. Anything outside its range is refused, and
// anything that somehow got into the database anyway is ignored on read.
const RULES = {
  nsfw_block_threshold: { type: 'number', min: 0, max: 1 },
  nsfw_review_threshold: { type: 'number', min: 0, max: 1 },
  nsfw_sexy_review_threshold: { type: 'number', min: 0, max: 1 },
  quarantine_retention_hours: { type: 'integer', min: 1, max: 24 * 365 },
  upload_limit_per_hour: { type: 'integer', min: 0, max: 10000 },
  read_limit_per_15min: { type: 'integer', min: 1, max: 100000 },
  write_limit_per_min: { type: 'integer', min: 1, max: 10000 },
  report_limit_per_hour: { type: 'integer', min: 1, max: 1000 },
  max_image_mb: { type: 'integer', min: 1, max: 100 },
  max_video_mb: { type: 'integer', min: 1, max: 100 },
  text_post_cooldown_seconds: { type: 'integer', min: 0, max: 86400 },
  report_auto_blacklist_count: { type: 'integer', min: 1, max: 100000 },
  uploads_enabled: { type: 'boolean' }
};

function isValid(key, value) {
  const rule = RULES[key];
  if (!rule) return false;
  if (rule.type === 'boolean') return typeof value === 'boolean';
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (rule.type === 'integer' && !Number.isInteger(value)) return false;
  return value >= rule.min && value <= rule.max;
}

/** True only for keys this app actually defines. `key in DEFAULTS` would
 * also answer true for anything inherited from Object.prototype
 * ('constructor', 'toString', '__proto__'), which is how an unknown key
 * could otherwise slip past a settings-update guard. */
function isKnownSetting(key) {
  return Object.prototype.hasOwnProperty.call(DEFAULTS, key);
}

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
  if (!isKnownSetting(key)) return undefined;
  const row = getStmt.get(key);
  if (!row) return DEFAULTS[key];
  let parsed;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return DEFAULTS[key];
  }
  // A stored value that no longer satisfies its rule (hand-edited database,
  // a value written before these bounds existed) falls back to the default
  // rather than propagating into a rate limit or a moderation threshold.
  return isValid(key, parsed) ? parsed : DEFAULTS[key];
}

function getAll() {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) out[key] = get(key);
  return out;
}

function set(key, value) {
  if (!isKnownSetting(key)) throw new Error(`unknown setting: ${key}`);
  if (!isValid(key, value)) throw new Error(`invalid value for ${key}`);
  setStmt.run(key, JSON.stringify(value));
}

module.exports = {
  DEFAULTS,
  RULES,
  isKnownSetting,
  isValid,
  get,
  getAll,
  set
};
