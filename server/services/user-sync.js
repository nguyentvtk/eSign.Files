/* ═══════════════════════════════════════════════════════════
   USER SYNC — Upsert user từ Google Sheet vào DB
   Dùng chung bởi auth route (login) và middleware (resync).
═══════════════════════════════════════════════════════════ */
const bcrypt = require('bcryptjs');
const sheets = require('./google-sheets');

let _lastSyncAllAt = 0;
const SYNC_ALL_COOLDOWN_MS = 60 * 1000; // 60s cooldown tránh spam

/**
 * Upsert 1 user (object từ google-sheets.findUser) vào DB.
 * @returns DB row đầy đủ
 */
function upsertFromSheet(db, su) {
  const role = sheets.mapRole(su.phanQuyen);
  const pwHash = bcrypt.hashSync(su.matKhau || 'esign123', 8);
  const email = su.email || `${su.maNV}@esign.local`;
  const existing = db.prepare(
    'SELECT id FROM users WHERE ma_nv = ? COLLATE NOCASE OR email = ? COLLATE NOCASE'
  ).get(su.maNV, email);

  if (existing) {
    db.prepare(`UPDATE users SET ho_ten=?, email=?, phone=?, chuc_vu=?, phong_ban=?,
        phan_quyen=?, password_hash=?, avatar_url=?, is_active=1, updated_at=datetime('now') WHERE id=?`)
      .run(su.hoTen, email, su.phone, su.chucVu, su.phongBan, role, pwHash, su.avatar || '', existing.id);
    return db.prepare('SELECT * FROM users WHERE id=?').get(existing.id);
  }
  const r = db.prepare(`INSERT INTO users
      (ma_nv, ho_ten, email, phone, chuc_vu, phong_ban, phan_quyen, password_hash, avatar_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(su.maNV, su.hoTen, email, su.phone, su.chucVu, su.phongBan, role, pwHash, su.avatar || '');
  return db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid);
}

/**
 * Đồng bộ TẤT CẢ users từ Google Sheet khi DB trống/thiếu.
 * Gọi khi cần danh sách approvers hoặc trước khi resolveUserId.
 */
async function syncAllUsersIfEmpty(db) {
  if (!sheets.isConfigured()) return;

  const { c } = db.prepare('SELECT COUNT(*) as c FROM users WHERE is_active = 1').get();
  // Nếu đã có >= 2 user → skip (đủ để hoạt động)
  if (c >= 2) return;

  // Cooldown tránh gọi liên tục
  const now = Date.now();
  if (now - _lastSyncAllAt < SYNC_ALL_COOLDOWN_MS) return;

  console.log('[user-sync] DB thiếu users — bắt đầu sync tất cả từ Google Sheet...');
  try {
    const list = await sheets.getNguoiDung(true);
    let created = 0, updated = 0;
    const upsert = db.transaction((users) => {
      for (const su of users) {
        if (!su.maNV) continue;
        const role = sheets.mapRole(su.phanQuyen);
        const pwHash = bcrypt.hashSync(su.matKhau || 'esign123', 8);
        const email = su.email || `${su.maNV}@esign.local`;
        const existing = db.prepare('SELECT id FROM users WHERE ma_nv = ? COLLATE NOCASE OR email = ? COLLATE NOCASE')
          .get(su.maNV, email);
        if (existing) {
          db.prepare(`UPDATE users SET ho_ten=?, email=?, phone=?, chuc_vu=?, phong_ban=?,
              phan_quyen=?, password_hash=?, avatar_url=?, is_active=1, updated_at=datetime('now') WHERE id=?`)
            .run(su.hoTen, email, su.phone, su.chucVu, su.phongBan, role, pwHash, su.avatar || '', existing.id);
          updated++;
        } else {
          db.prepare(`INSERT INTO users (ma_nv, ho_ten, email, phone, chuc_vu, phong_ban, phan_quyen, password_hash, avatar_url)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(su.maNV, su.hoTen, email, su.phone, su.chucVu, su.phongBan, role, pwHash, su.avatar || '');
          created++;
        }
      }
    });
    upsert(list);
    _lastSyncAllAt = Date.now();
    console.log(`[user-sync] Sync xong: ${created} thêm mới, ${updated} cập nhật.`);
  } catch (e) {
    _lastSyncAllAt = Date.now(); // Tránh retry liên tục
    console.error('[user-sync] Lỗi:', e.message);
  }
}

/**
 * Đảm bảo user (theo email/maNV) tồn tại trong DB instance hiện tại.
 * Nếu chưa có → tra Google Sheet và upsert. Trả về DB row hoặc null.
 */
async function ensureUser(db, { email, maNV }) {
  // 1. Thử DB theo email
  let user = null;
  if (email) {
    user = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE AND is_active = 1').get(email);
  }
  if (!user && maNV) {
    user = db.prepare('SELECT * FROM users WHERE ma_nv = ? COLLATE NOCASE AND is_active = 1').get(maNV);
  }
  if (user) return user;

  // 2. Chưa có trong DB instance này (ephemeral) → tra Google Sheet
  if (sheets.isConfigured()) {
    try {
      const su = await sheets.findUser(email || maNV);
      if (su) return upsertFromSheet(db, su);
    } catch (e) {
      console.error('[ensureUser] sheet lookup:', e.message);
    }
  }
  return null;
}

module.exports = { upsertFromSheet, ensureUser, syncAllUsersIfEmpty };
