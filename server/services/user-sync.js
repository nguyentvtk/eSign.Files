/* ═══════════════════════════════════════════════════════════
   USER SYNC — Upsert user từ Google Sheet vào DB
   Dùng chung bởi auth route (login) và middleware (resync).
═══════════════════════════════════════════════════════════ */
const bcrypt = require('bcryptjs');
const sheets = require('./google-sheets');

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

module.exports = { upsertFromSheet, ensureUser };
