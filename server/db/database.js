/**
 * DB adapter — dùng `libsql` package (drop-in của better-sqlite3, sync API).
 *
 * Production (Vercel + Turso):
 *   • Replica file trong /tmp + sync 2-way với Turso
 *   • Pragma journal_mode WAL không apply trên remote replica → wrap try/catch
 *
 * Local dev: file SQLite tại config.db.path
 */
const fs = require('fs');
const path = require('path');
const Database = require('libsql');
const config = require('../config');

let _db = null;
let _schemaApplied = false;

function getDb() {
  if (_db) return _db;

  const isCloud = !!process.env.TURSO_DATABASE_URL;

  try {
    if (isCloud) {
      const replicaPath = process.env.VERCEL ? '/tmp/esign-replica.db' : config.db.path;
      const dir = path.dirname(replicaPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      _db = new Database(replicaPath, {
        syncUrl: process.env.TURSO_DATABASE_URL,
        authToken: process.env.TURSO_AUTH_TOKEN,
      });
      try { _db.sync(); } catch (e) { console.error('[DB sync]', e.message); }
    } else {
      const dir = path.dirname(config.db.path);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      _db = new Database(config.db.path);
    }

    // Pragmas — silent fail nếu Turso replica không support
    try { _db.pragma('journal_mode = WAL'); } catch {}
    try { _db.pragma('foreign_keys = ON'); } catch {}

    // Apply schema chỉ 1 lần / cold start
    if (!_schemaApplied) {
      try {
        const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
        _db.exec(schema);
        _schemaApplied = true;
      } catch (e) {
        console.error('[DB schema]', e.message);
        // Schema có thể đã apply rồi (idempotent CREATE TABLE IF NOT EXISTS) — không throw
      }
    }

    return _db;
  } catch (err) {
    console.error('[DB init]', err.message, err.stack);
    throw err;
  }
}

function close() {
  if (_db && _db.close) try { _db.close(); } catch {}
  _db = null;
  _schemaApplied = false;
}

module.exports = { getDb, close };
