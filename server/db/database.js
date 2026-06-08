/**
 * DB adapter: dùng Turso (libSQL) khi có TURSO_DATABASE_URL,
 * ngược lại dùng better-sqlite3 local (dev).
 *
 * Cung cấp API tương thích better-sqlite3:
 *   db.prepare(sql).get(...) / .all(...) / .run(...)
 *   db.exec(sql)
 *   db.transaction(fn)
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

let _db = null;
const isCloud = !!process.env.TURSO_DATABASE_URL;

function getDb() {
  if (_db) return _db;
  if (isCloud) _db = _initTurso();
  else _db = _initLocal();
  return _db;
}

function close() {
  if (_db && _db.close) try { _db.close(); } catch {}
  _db = null;
}

/* ─── Local (better-sqlite3) ─── */
function _initLocal() {
  const Database = require('better-sqlite3');
  const dir = path.dirname(config.db.path);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(config.db.path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  return db;
}

/* ─── Cloud (Turso) ─── */
function _initTurso() {
  const { createClient } = require('@libsql/client');
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  // Run schema (sync at startup) — Turso supports executeMultiple
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  client.executeMultiple(schema).catch(e => console.error('[Turso schema]', e.message));

  // Wrap to mimic better-sqlite3 API. Use synchronous via deasync-style: but Turso is async only.
  // Workaround: build a sync-like wrapper for queries already executed. For simplicity
  // we expose prepare(sql) that returns { get/all/run } using deasync (avoid heavy lib).
  // Better: refactor routes to async — but that's huge. Use blocking approach with Atomics.

  // We use a different approach: build sync proxy by buffering — only safe if all queries are tiny.
  // Simpler: use deasync. Install if missing.
  let deasync;
  try { deasync = require('deasync'); } catch { deasync = null; }

  function runSync(promise) {
    if (deasync) {
      let done = false, val, err;
      promise.then(v => { val = v; done = true; }).catch(e => { err = e; done = true; });
      deasync.loopWhile(() => !done);
      if (err) throw err;
      return val;
    }
    throw new Error('Turso adapter requires `deasync` package. Run: npm install deasync');
  }

  return {
    prepare(sql) {
      return {
        get(...params) {
          const r = runSync(client.execute({ sql, args: params }));
          if (!r.rows.length) return undefined;
          return _rowToObj(r.rows[0], r.columns);
        },
        all(...params) {
          const r = runSync(client.execute({ sql, args: params }));
          return r.rows.map(row => _rowToObj(row, r.columns));
        },
        run(...params) {
          const r = runSync(client.execute({ sql, args: params }));
          return { changes: r.rowsAffected, lastInsertRowid: Number(r.lastInsertRowid || 0) };
        },
      };
    },
    exec(sql) {
      runSync(client.executeMultiple(sql));
    },
    transaction(fn) {
      return (...args) => {
        // Turso không hỗ trợ sync transaction qua deasync ổn định.
        // Chạy tuần tự (chấp nhận risk consistency yếu hơn local).
        return fn(...args);
      };
    },
    pragma() { /* noop on Turso */ },
    close() { /* libsql client tự đóng */ },
  };
}

function _rowToObj(row, columns) {
  const obj = {};
  for (let i = 0; i < columns.length; i++) obj[columns[i]] = row[i];
  return obj;
}

module.exports = { getDb, close, isCloud };
