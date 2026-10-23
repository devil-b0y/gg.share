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
if (password.length < 12) {
  console.error('ADMIN_PASSWORD must be at least 12 characters. This one password is the only ' +
    'thing guarding the moderation panel, the media queue and the ban list.');
  process.exit(1);
}

setAdminPassword(password).then(() => {
  console.log('Admin password hash stored in data/app.db. Existing admin sessions have been ' +
    'signed out. You can now start the server with `npm start`.');
  console.log('Delete ADMIN_PASSWORD from .env once you have confirmed the new password works.');
}).catch((err) => {
  console.error('Failed to store the admin password:', err.message);
  process.exit(1);
});
