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
      // Remote-only: kết nối THẲNG tới Turso, KHÔNG dùng embedded replica.
      // Trên serverless (Vercel) file replica /tmp bị xóa liên tục & diverge
      // khỏi WAL của primary → mọi lệnh ghi báo lỗi "WalConflict". Remote-only
      // cho read/write đi thẳng tới primary: luôn mới, bền vững, không xung đột.
      _db = new Database(process.env.TURSO_DATABASE_URL, {
        authToken: process.env.TURSO_AUTH_TOKEN,
      });
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

    // Pragmas — chỉ áp dụng cho file SQLite local. Remote Turso & /tmp ephemeral
    // không hưởng lợi từ WAL (remote không hỗ trợ; /tmp gây slow/lock) → skip.
    if (!isCloud && !process.env.VERCEL) {
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

module.exports = { getDb, close };
