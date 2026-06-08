const jwt = require('jsonwebtoken');
const config = require('../config');
const { getDb } = require('../db/database');
const { sha256 } = require('../utils/crypto');

function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Token không được cung cấp.' });
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, config.jwt.secret);
    const db = getDb();
    const now = new Date().toISOString();
    const session = db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?').get(sha256(token), now);
    if (!session) {
      return res.status(401).json({ success: false, error: 'Phiên đăng nhập đã hết hạn.' });
    }
    const user = db.prepare('SELECT id, ma_nv, ho_ten, email, phone, chuc_vu, phong_ban, phan_quyen, otp_enabled, avatar_url FROM users WHERE id = ? AND is_active = 1').get(payload.userId);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Tài khoản không tồn tại hoặc đã bị vô hiệu hóa.' });
    }
    req.user = user;
    req.sessionId = session.id;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, error: 'Token đã hết hạn.' });
    }
    return res.status(401).json({ success: false, error: 'Token không hợp lệ.' });
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
