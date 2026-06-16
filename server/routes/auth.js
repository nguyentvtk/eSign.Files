const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const config = require('../config');
const { getDb } = require('../db/database');
const { hashPassword, verifyPassword, sha256, randomToken } = require('../utils/crypto');
const { authenticate } = require('../middleware/auth');
const auditLog = require('../services/audit-log');
const otpService = require('../services/otp');
const sheets = require('../services/google-sheets');
const { upsertFromSheet } = require('../services/user-sync');
const projectSync = require('../services/project-sync');
// Alias giữ tương thích tên gọi cũ trong route login
const _upsertUserFromSheet = (db, su) => upsertFromSheet(db, su);

router.post('/login', async (req, res) => {
  const T0 = Date.now();
  const dbg = (msg) => console.log(`[login ${Date.now() - T0}ms] ${msg}`);
  try {
    dbg('start');
    const { identifier, password } = req.body || {};
    if (!identifier || !password) {
      return res.status(400).json({ success: false, error: 'Vui lòng nhập thông tin đăng nhập và mật khẩu.' });
    }

    dbg('getDb');
    const db = getDb();
    const id = identifier.trim();

    let user = null;

    // ── (1) Ưu tiên xác thực qua Google Sheet Nguoi_Dung (nguồn chính) ──
    if (sheets.isConfigured()) {
      try {
        dbg('sheet lookup');
        const su = await sheets.findUser(id);
        if (su) {
          if (!sheets.verifyPassword(password, su.matKhau)) {
            dbg('sheet password mismatch');
            try { auditLog.log({ userEmail: su.email, action: 'LOGIN_FAILED', detail: { reason: 'wrong_password', source: 'sheet' }, ip: req.ip, userAgent: req.get('user-agent') }); } catch {}
            return res.status(401).json({ success: false, error: 'Thông tin đăng nhập hoặc mật khẩu không chính xác.' });
          }
          dbg('sheet match → upsert');
          user = await _upsertUserFromSheet(db, su);
        }
      } catch (e) {
        console.error('[login sheet]', e.message);
        // Lỗi đọc sheet → fallback sang DB bên dưới
      }
    }

    // ── (2) Fallback: tra DB (tài khoản admin seed + user tạo trực tiếp) ──
    if (!user) {
      dbg('query DB user');
      const dbUser = db.prepare(
        'SELECT * FROM users WHERE is_active = 1 AND (email = ? COLLATE NOCASE OR ma_nv = ? COLLATE NOCASE OR phone = ? OR ho_ten = ? COLLATE NOCASE)'
      ).get(id, id, id, id);
      if (!dbUser) {
        dbg('no user found');
        return res.status(401).json({ success: false, error: 'Thông tin đăng nhập hoặc mật khẩu không chính xác.' });
      }
      dbg('verifyPassword (DB)');
      const match = await verifyPassword(password, dbUser.password_hash);
      if (!match) {
        dbg('password mismatch');
        try { auditLog.log({ userId: dbUser.id, userEmail: dbUser.email, action: 'LOGIN_FAILED', detail: { reason: 'wrong_password', source: 'db' }, ip: req.ip, userAgent: req.get('user-agent') }); } catch {}
        return res.status(401).json({ success: false, error: 'Thông tin đăng nhập hoặc mật khẩu không chính xác.' });
      }
      user = dbUser;
    }

    dbg('jwt sign');
    // JWT chứa email + maNV (định danh ổn định across serverless instances)
    const accessToken = jwt.sign(
      { userId: user.id, email: user.email, maNV: user.ma_nv },
      config.jwt.secret, { expiresIn: config.jwt.accessTtl }
    );
    const refreshToken = randomToken(48);
    const expiresAt = new Date(Date.now() + config.jwt.accessTtl * 1000).toISOString();

    // Lưu session best-effort (không bắt buộc cho auth — chỉ phục vụ audit/revoke khi có Turso)
    try {
      db.prepare('INSERT INTO sessions (user_id, token_hash, refresh_hash, ip_address, user_agent, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        user.id, sha256(accessToken), sha256(refreshToken), req.ip, req.get('user-agent') || '', expiresAt
      );
    } catch (e) { /* ephemeral DB — bỏ qua */ }

    try { auditLog.log({ userId: user.id, userEmail: user.email, action: 'LOGIN_SUCCESS', ip: req.ip, userAgent: req.get('user-agent') }); } catch {}

    // Auto-resync dự án từ Google Sheet nếu DB ephemeral (Vercel) bị mất data
    // Await để đảm bảo dữ liệu dự án sẵn sàng khi client load trang
    try {
      dbg('project-sync start');
      await projectSync.syncIfEmpty(db);
      dbg('project-sync done');
    } catch (e) {
      console.error('[login project-sync]', e.message);
    }

    const { password_hash, otp_secret, ...safeUser } = user;
    dbg('respond ok');
    res.json({
      success: true,
      token: accessToken,
      refreshToken,
      user: safeUser,
      expiresAt,
    });
  } catch (err) {
    console.error('[login FATAL]', err.message, err.stack);
    res.status(500).json({ success: false, error: 'Lỗi đăng nhập.', debug: { message: err.message } });
  }
});

router.post('/logout', authenticate, (req, res) => {
  try {
    const db = getDb();
    if (req.sessionId) db.prepare('DELETE FROM sessions WHERE id = ?').run(req.sessionId);
  } catch {}
  try { auditLog.log({ userId: req.user.id, userEmail: req.user.email, action: 'LOGOUT', ip: req.ip, userAgent: req.get('user-agent') }); } catch {}
  res.json({ success: true, message: 'Đã đăng xuất.' });
});

router.post('/refresh', (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ success: false, error: 'Refresh token không được cung cấp.' });

  const db = getDb();
  const session = db.prepare('SELECT * FROM sessions WHERE refresh_hash = ?').get(sha256(refreshToken));
  if (!session) return res.status(401).json({ success: false, error: 'Refresh token không hợp lệ.' });

  const user = db.prepare('SELECT id, email FROM users WHERE id = ? AND is_active = 1').get(session.user_id);
  if (!user) return res.status(401).json({ success: false, error: 'Tài khoản không tồn tại.' });

  const newAccessToken = jwt.sign({ userId: user.id, email: user.email }, config.jwt.secret, { expiresIn: config.jwt.accessTtl });
  const newRefreshToken = randomToken(48);
  const expiresAt = new Date(Date.now() + config.jwt.accessTtl * 1000).toISOString();

  db.prepare('UPDATE sessions SET token_hash = ?, refresh_hash = ?, expires_at = ? WHERE id = ?').run(
    sha256(newAccessToken), sha256(newRefreshToken), expiresAt, session.id
  );

  res.json({ success: true, token: newAccessToken, refreshToken: newRefreshToken, expiresAt });
});

router.get('/me', authenticate, (req, res) => {
  res.json({ success: true, user: req.user });
});

router.post('/otp/setup', authenticate, async (req, res) => {
  const secret = otpService.generateSecret();
  const qrDataUrl = await otpService.generateQRDataUrl(req.user.email, secret);

  const db = getDb();
  db.prepare('UPDATE users SET otp_secret = ? WHERE id = ?').run(secret, req.user.id);

  res.json({ success: true, secret, qrDataUrl });
});

router.post('/otp/verify', authenticate, (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ success: false, error: 'Mã OTP không được để trống.' });

  const db = getDb();
  const user = db.prepare('SELECT otp_secret FROM users WHERE id = ?').get(req.user.id);
  if (!user?.otp_secret) return res.status(400).json({ success: false, error: 'OTP chưa được thiết lập.' });

  const valid = otpService.verifyToken(user.otp_secret, token);
  if (!valid) return res.status(401).json({ success: false, error: 'Mã OTP không chính xác.' });

  db.prepare('UPDATE users SET otp_enabled = 1 WHERE id = ?').run(req.user.id);
  auditLog.log({ userId: req.user.id, userEmail: req.user.email, action: 'OTP_ENABLED', ip: req.ip, userAgent: req.get('user-agent') });

  res.json({ success: true, message: 'Xác thực 2 lớp đã được kích hoạt.' });
});

router.post('/otp/validate', authenticate, (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ success: false, error: 'Mã OTP không được để trống.' });

  const db = getDb();
  const user = db.prepare('SELECT otp_secret, otp_enabled FROM users WHERE id = ?').get(req.user.id);
  if (!user?.otp_enabled || !user?.otp_secret) {
    return res.json({ success: true, message: 'OTP chưa bật — bỏ qua xác thực.' });
  }

  const valid = otpService.verifyToken(user.otp_secret, token);
  if (!valid) {
    auditLog.log({ userId: req.user.id, userEmail: req.user.email, action: 'OTP_VERIFY_FAILED', ip: req.ip, userAgent: req.get('user-agent') });
    return res.status(401).json({ success: false, error: 'Mã OTP không chính xác.' });
  }

  res.json({ success: true, verified: true });
});

module.exports = router;
