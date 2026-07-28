'use strict';

const db = require('../db');

const checkStmt = db.prepare('SELECT 1 FROM bans WHERE kind = ? AND value = ?');
const insertStmt = db.prepare(
  'INSERT INTO bans (kind, value, reason, created_at, created_by) VALUES (?, ?, ?, ?, ?) ' +
  'ON CONFLICT(kind, value) DO UPDATE SET reason = excluded.reason'
);
const deleteStmt = db.prepare('DELETE FROM bans WHERE kind = ? AND value = ?');
const listStmt = db.prepare('SELECT * FROM bans ORDER BY created_at DESC');

function isBanned(kind, value) {
  return !!checkStmt.get(kind, value);
}

function ban(kind, value, reason, admin) {
  insertStmt.run(kind, value, reason || null, Date.now(), admin);
}

function unban(kind, value) {
  deleteStmt.run(kind, value);
}

function listBans() {
  return listStmt.all();
}

module.exports = { isBanned, ban, unban, listBans };
