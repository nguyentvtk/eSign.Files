const jwt = require('jsonwebtoken');
const config = require('../config');
const { getDb } = require('../db/database');
const { sha256 } = require('../utils/crypto');

// Stateless JWT auth — KHÔNG phụ thuộc bảng sessions (để hoạt động ổn định trên
// serverless ephemeral, nơi mỗi instance có DB /tmp riêng). Load user theo EMAIL
// (định danh ổn định) thay vì userId (autoincrement, khác nhau giữa instance).
// Nếu user chưa có trong DB instance hiện tại → tái đồng bộ từ Google Sheet.
async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Token không được cung cấp.' });
  }

  const token = header.slice(7);
  let payload;
  try {
    payload = jwt.verify(token, config.jwt.secret);
  } catch (err) {
    return res.status(401).json({
      success: false,
      error: err.name === 'TokenExpiredError' ? 'Token đã hết hạn. Vui lòng đăng nhập lại.' : 'Token không hợp lệ.',
    });
  }

  try {
    const db = getDb();
    const { ensureUser } = require('../services/user-sync');
    const user = await ensureUser(db, { email: payload.email, maNV: payload.maNV });
    if (!user) {
      return res.status(401).json({ success: false, error: 'Tài khoản không tồn tại hoặc đã bị vô hiệu hóa.' });
    }
    // Chuẩn hoá object (loại field nhạy cảm)
    req.user = {
      id: user.id, ma_nv: user.ma_nv, ho_ten: user.ho_ten, email: user.email,
      phone: user.phone, chuc_vu: user.chuc_vu, phong_ban: user.phong_ban,
      phan_quyen: user.phan_quyen, otp_enabled: user.otp_enabled, avatar_url: user.avatar_url,
    };
    req.sessionId = null;
    next();
  } catch (err) {
    console.error('[authenticate]', err.message);
    return res.status(500).json({ success: false, error: 'Lỗi xác thực: ' + err.message });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.phan_quyen)) {
      return res.status(403).json({ success: false, error: `Yêu cầu quyền: ${roles.join(', ')}` });
    }
    next();
  };
}

function requirePermission(featureName) {
  return (req, res, next) => {
    if (req.user.phan_quyen === 'Admin') return next();

    const db = getDb();
    const perm = db.prepare('SELECT allowed FROM permissions WHERE feature_name = ? AND role = ?').get(featureName, req.user.phan_quyen);
    if (!perm || !perm.allowed) {
      return res.status(403).json({ success: false, error: `Không có quyền: "${featureName}"` });
    }
    next();
  };
}

module.exports = { authenticate, requireRole, requirePermission };
