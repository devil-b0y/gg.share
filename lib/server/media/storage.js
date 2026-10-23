// On-disk media storage: the three upload directories and the few file
// operations everything else needs (create, move between them, measure).
//
// A post's media physically moves between directories as its moderation
// status changes, because the directory *is* the access control: only
// uploads/live/ is reachable from the public /media route.
'use strict';

const fs = require('fs');
const path = require('path');
const { UPLOADS_DIR, LIVE_DIR, PENDING_DIR, QUARANTINE_DIR } = require('../core/paths');

/** Creates the uploads tree. On a fresh checkout none of these directories
 * exist yet, and the first upload would crash with ENOENT without this. */
function ensureUploadDirs() {
  for (const dir of [LIVE_DIR, PENDING_DIR, QUARANTINE_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Moves a file, creating the target directory if needed. Returns the new
 * path, or null when there was nothing to move (missing or already purged). */
function moveFile(from, to) {
  if (!from || !fs.existsSync(from)) return null;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  return to;
}

/** Moves a file into `dir`, keeping its name. */
function moveInto(from, dir) {
  return from ? moveFile(from, path.join(dir, path.basename(from))) : null;
}

/** File count and total bytes of the regular files directly inside `dir`. */
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

/** Public URL for a file in LIVE_DIR, or the admin-only URL for any file. */
function publicMediaUrl(filePath) {
  return filePath ? `/media/${path.basename(filePath)}` : null;
}
function adminMediaUrl(filePath) {
  return filePath ? `/api/admin/media/${path.basename(filePath)}` : null;
}

// Every stored name is the content's own SHA-256 plus a known suffix, so a
// requested filename can be matched exactly rather than merely filtered for
// dangerous characters -- nothing that isn't a name this server itself wrote
// can get past the pattern.
const MEDIA_NAME = /^[0-9a-f]{64}(\.thumb\.jpg|\.webp|\.mp4|\.jpg)$/;

/**
 * Resolves a requested media filename inside one of `dirs`, or returns null.
 * The resolved path is re-checked against each directory as a second line of
 * defence behind MEDIA_NAME.
 */
function resolveMediaFile(name, dirs) {
  if (typeof name !== 'string' || !MEDIA_NAME.test(name)) return null;
  for (const dir of dirs) {
    const root = path.resolve(dir);
    const full = path.resolve(root, name);
    if (!full.startsWith(root + path.sep)) continue;
    if (fs.existsSync(full)) return full;
  }
  return null;
}

module.exports = {
  UPLOADS_DIR,
  LIVE_DIR,
  PENDING_DIR,
  QUARANTINE_DIR,
  MEDIA_NAME,
  ensureUploadDirs,
  moveFile,
  moveInto,
  dirStats,
  publicMediaUrl,
  adminMediaUrl,
  resolveMediaFile
};
