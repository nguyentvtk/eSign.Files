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

// Throttle cho việc kéo (pull) dữ liệu mới từ Turso về replica /tmp.
// Mỗi lambda instance giữ replica riêng; nếu không sync lại, instance "ấm"
// sẽ phục vụ dữ liệu cũ do instance khác đã ghi → dự án/giai đoạn "biến mất".
let _lastReplicaSyncAt = 0;
const REPLICA_SYNC_THROTTLE_MS = parseInt(process.env.REPLICA_SYNC_THROTTLE_MS, 10) || 1500;

/**
 * Kéo dữ liệu mới từ Turso primary về replica local (no-op nếu không dùng Turso).
 * Writes của libsql embedded replica là write-through (tự đẩy lên primary),
 * nhưng READS chỉ thấy dữ liệu local → cần sync() định kỳ để thấy ghi từ instance khác.
 * @param {boolean} force - bỏ qua throttle (dùng sau khi vừa ghi để read-your-writes chắc chắn).
 */
function syncReplica(force = false) {
  if (!_db || !process.env.TURSO_DATABASE_URL) return;
  const now = Date.now();
  if (!force && now - _lastReplicaSyncAt < REPLICA_SYNC_THROTTLE_MS) return;
  try {
    _db.sync();
    _lastReplicaSyncAt = now;
  } catch (e) {
    console.error('[DB sync]', e.message);
  }
}

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
      try { _db.sync(); _lastReplicaSyncAt = Date.now(); } catch (e) { console.error('[DB sync]', e.message); }
    } else {
      // Local mode. Vercel: /tmp writable; dev: dùng config.db.path
      const dbPath = process.env.VERCEL ? '/tmp/esign-local.db' : config.db.path;
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      _db = new Database(dbPath);
      if (process.env.VERCEL) {
        console.warn('[DB] ⚠️  TURSO_DATABASE_URL missing — using ephemeral /tmp SQLite (data sẽ mất khi function restart). Cấu hình Turso env vars trên Vercel Dashboard.');
      }
    }

    // Pragmas — silent fail nếu Turso replica không support
    // Trên Vercel /tmp (ephemeral), WAL gây slow/lock → skip
    if (!process.env.VERCEL) {
      try { _db.pragma('journal_mode = WAL'); } catch {}
    }
    try { _db.pragma('foreign_keys = ON'); } catch {}

    // libsql có thể trả về _metadata trong row — strip để response sạch
    _wrapPrepareToStripMetadata(_db);

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
      _migrate(_db);
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

/**
 * Migration nhẹ — thêm cột mới vào bảng có sẵn (SQLite không có ADD COLUMN IF NOT EXISTS).
 */
function _migrate(db) {
  try {
    const cols = db.prepare("PRAGMA table_info(projects)").all().map(c => c.name);
    const add = (name, def) => {
      if (!cols.includes(name)) {
        try { db.exec(`ALTER TABLE projects ADD COLUMN ${name} ${def}`); } catch (e) { console.error('[migrate]', name, e.message); }
      }
    };
    add('nam_thuc_hien', 'TEXT');
    add('nv_ky_thuat', 'TEXT');           // tên NV phụ trách kỹ thuật (từ sheet)
    add('nv_ky_thuat_id', 'INTEGER');     // resolve → users.id
    add('nv_ke_toan', 'TEXT');            // tên NV phụ trách kế toán
    add('nv_ke_toan_id', 'INTEGER');
    add('loai_du_an', 'TEXT');
    add('tong_gt_quyet_toan', 'REAL');
    add('so_giai_ngan', 'REAL');
    add('sheet_source', 'TEXT');          // JSON config nguồn sheet (để re-sync)
  } catch (e) {
    console.error('[migrate] failed:', e.message);
  }
}

/**
 * Wrap db.prepare(...) → strip libsql `_metadata` từ kết quả .get()/.all()
 * để response API sạch (không leak metadata internal).
 */
function _wrapPrepareToStripMetadata(db) {
  if (db.__metaPatched) return;
  const origPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const stmt = origPrepare(sql);
    const origGet = stmt.get.bind(stmt);
    const origAll = stmt.all.bind(stmt);
    stmt.get = (...args) => {
      const r = origGet(...args);
      if (r && typeof r === 'object' && '_metadata' in r) delete r._metadata;
      return r;
    };
    stmt.all = (...args) => {
      const rows = origAll(...args);
      if (Array.isArray(rows)) rows.forEach(r => { if (r && typeof r === 'object') delete r._metadata; });
      return rows;
    };
    return stmt;
  };
  db.__metaPatched = true;
}

module.exports = { getDb, close, syncReplica };
