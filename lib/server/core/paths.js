// Filesystem layout for runtime state.
//
// Every module that touches disk resolves its paths through here rather than
// through __dirname: route handlers are bundled by Next.js, so __dirname no
// longer points at the source tree once the code is built. The project root
// is the process's working directory (both `npm run dev` and `npm start` run
// from it), and tests override the two data roots with environment variables
// so they never touch a real database or real uploads.
'use strict';

const path = require('path');

const ROOT = process.cwd();

/** SQLite database lives here (app.db plus its WAL/SHM side files). */
const DATA_DIR = process.env.ANON_DATA_DIR || path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'app.db');

/** Uploaded media. Only LIVE_DIR is ever served publicly (see app/media). */
const UPLOADS_DIR = process.env.ANON_UPLOADS_DIR || path.join(ROOT, 'uploads');
const LIVE_DIR = path.join(UPLOADS_DIR, 'live');
const PENDING_DIR = path.join(UPLOADS_DIR, 'pending');
const QUARANTINE_DIR = path.join(UPLOADS_DIR, 'quarantine');

/** The schema ships next to db.js as source, not as a build artefact. */
const SCHEMA_PATH = path.join(ROOT, 'lib', 'server', 'core', 'schema.sql');

module.exports = {
  ROOT,
  DATA_DIR,
  DB_PATH,
  UPLOADS_DIR,
  LIVE_DIR,
  PENDING_DIR,
  QUARANTINE_DIR,
  SCHEMA_PATH
};
