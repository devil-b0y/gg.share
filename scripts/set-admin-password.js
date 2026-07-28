// Run via `npm run setup` (or standalone) to (re)hash ADMIN_PASSWORD from
// .env into the database. Safe to re-run any time to rotate the password.
'use strict';

require('dotenv').config();
const { setAdminPassword } = require('../server/lib/auth');

const password = process.env.ADMIN_PASSWORD;
if (!password || password === 'change-me-now') {
  console.error('Set a real ADMIN_PASSWORD in .env before running setup.');
  process.exit(1);
}

setAdminPassword(password);
console.log('Admin password hash stored in data/app.db. You can now start the server with `npm start`.');
