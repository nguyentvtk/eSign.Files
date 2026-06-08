/**
 * DB adapter — dùng `libsql` package (drop-in của better-sqlite3, sync API).
 *
 * 2 chế độ:
 *   - Local (dev): file SQLite tại config.db.path
 *   - Cloud (production): kết nối Turso qua syncUrl + authToken
 *     • Local replica caching trong /tmp (Vercel writable)
 *     • Sync 2-way với Turso server
 *
 * API tương thích better-sqlite3:
 *   db.prepare(sql).get/all/run(...)
 *   db.exec(sql), db.transaction(fn), db.pragma(...)
 */
const fs = require('fs');
const path = require('path');
const Database = require('libsql');
const config = require('../config');

let _db = null;

function getDb() {
  if (_db) return _db;

  const isCloud = !!process.env.TURSO_DATABASE_URL;

  if (isCloud) {
    // Vercel: /tmp writable, dùng làm local replica
    const replicaPath = process.env.VERCEL ? '/tmp/esign-replica.db' : config.db.path;
    const dir = path.dirname(replicaPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    _db = new Database(replicaPath, {
      syncUrl: process.env.TURSO_DATABASE_URL,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
    // Sync ngay khi khởi động (cold start)
    try { _db.sync(); } catch (e) { console.error('[Turso sync]', e.message); }
  } else {
    // Local dev
    const dir = path.dirname(config.db.path);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    _db = new Database(config.db.path);
  }

  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  // Áp dụng schema (idempotent)
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  _db.exec(schema);

  return _db;
}

function close() {
  if (_db && _db.close) try { _db.close(); } catch {}
  _db = null;
}

module.exports = { getDb, close };
