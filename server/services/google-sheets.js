/* ═══════════════════════════════════════════════════════════
   GOOGLE SHEETS — Nguồn dữ liệu người dùng (Nguoi_Dung)
   ─────────────────────────────────────────────────────────
   Đọc sheet "Nguoi_Dung" của Google Spreadsheet làm nguồn
   xác thực chính. Sheet phải ở chế độ "Anyone with link can view".

   Layout Nguoi_Dung:
     A: Mã NV | B: Họ tên | C: Email | D: SĐT | E: Chức vụ
     F: Phòng ban | G: Phân quyền | H: Mật khẩu | I: Hình đại diện

   Phân quyền trong sheet: "Admin" / "User" / "Quản lý"
   → map sang DB role: Admin / Người dùng / Quản lý
═══════════════════════════════════════════════════════════ */

const SHEET_ID = process.env.GOOGLE_SHEET_ID || '1VdOy7h5YSF0xIYkw285qBIQot-eCNySXSCA4dNdPdWc';
const CACHE_TTL_MS = parseInt(process.env.SHEET_CACHE_TTL_MS, 10) || 5 * 60 * 1000; // 5 phút

let _cache = { data: null, at: 0 };

function isConfigured() {
  return !!SHEET_ID;
}

/* ── CSV parser (hỗ trợ field có dấu phẩy, xuống dòng, escape "") ── */
function _parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (inQuotes) {
      if (c === '"' && next === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else { field += c; }
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/* ── Tải & parse sheet Nguoi_Dung ── */
async function _fetchSheet(sheetName) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok) throw new Error(`Google Sheet HTTP ${resp.status}`);
  const text = await resp.text();
  return _parseCsv(text);
}

/**
 * Lấy danh sách người dùng từ sheet Nguoi_Dung (có cache).
 * @param {boolean} force - bỏ qua cache
 * @returns {Promise<Array<{maNV,hoTen,email,phone,chucVu,phongBan,phanQuyen,matKhau,avatar}>>}
 */
async function getNguoiDung(force = false) {
  const now = Date.now();
  if (!force && _cache.data && (now - _cache.at) < CACHE_TTL_MS) {
    return _cache.data;
  }
  const rows = await _fetchSheet('Nguoi_Dung');
  if (!rows.length) return [];

  // Hàng 0 là header → bỏ. Map theo vị trí cột (robust hơn tên).
  const users = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const maNV = (r[0] || '').trim();
    if (!maNV) continue;
    users.push({
      maNV,
      hoTen: (r[1] || '').trim(),
      email: (r[2] || '').trim(),
      phone: (r[3] || '').trim(),
      chucVu: (r[4] || '').trim(),
      phongBan: (r[5] || '').trim(),
      phanQuyen: (r[6] || '').trim(),
      matKhau: (r[7] || '').trim(),
      avatar: (r[8] || '').trim(),
    });
  }
  _cache = { data: users, at: now };
  return users;
}

/* ── Tìm user theo identifier (Mã NV / Email / SĐT / Họ tên) ── */
async function findUser(identifier) {
  const id = String(identifier || '').trim().toLowerCase();
  if (!id) return null;
  const users = await getNguoiDung();
  return users.find(u =>
    (u.maNV || '').toLowerCase() === id ||
    (u.email || '').toLowerCase() === id ||
    (u.phone || '') === identifier.trim() ||
    (u.hoTen || '').toLowerCase() === id
  ) || null;
}

/* ── Map phân quyền sheet → DB role ── */
function mapRole(raw) {
  const r = String(raw || '').trim().toLowerCase();
  if (r === 'admin') return 'Admin';
  if (['quản lý', 'quan ly', 'quanly', 'manager', 'ql', 'lãnh đạo', 'lanh dao'].includes(r)) return 'Quản lý';
  return 'Người dùng'; // user, người dùng, nhân viên, ...
}

/* ── So khớp mật khẩu (sheet lưu plaintext; hỗ trợ cả bcrypt hash) ── */
function verifyPassword(input, stored) {
  const s = String(stored || '');
  const i = String(input || '');
  if (!s) return false;
  if (s.startsWith('$2a$') || s.startsWith('$2b$') || s.startsWith('$2y$')) {
    try { return require('bcryptjs').compareSync(i, s); } catch { return false; }
  }
  return i === s;
}

function invalidateCache() {
  _cache = { data: null, at: 0 };
}

module.exports = { isConfigured, getNguoiDung, findUser, mapRole, verifyPassword, invalidateCache, SHEET_ID };
