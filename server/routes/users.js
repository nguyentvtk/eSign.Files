const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { authenticate, requireRole } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { hashPassword } = require('../utils/crypto');

const SAFE_COLS = 'id, ma_nv, ho_ten, email, phone, chuc_vu, phong_ban, phan_quyen, otp_enabled, avatar_url, is_active, created_at, updated_at';

router.get('/', authenticate, requireRole('Admin', 'Quản lý'), (req, res) => {
  const db = getDb();
  const users = db.prepare(`SELECT ${SAFE_COLS} FROM users ORDER BY id`).all();
  res.json({ success: true, data: users, meta: { count: users.length } });
});

router.get('/:id', authenticate, (req, res) => {
  const db = getDb();
  const user = db.prepare(`SELECT ${SAFE_COLS} FROM users WHERE id = ?`).get(req.params.id);
  if (!user) return res.status(404).json({ success: false, error: 'Không tìm thấy người dùng.' });
  res.json({ success: true, data: user });
});

router.post('/', authenticate, requireRole('Admin'), audit('USER_CREATE', 'user'), async (req, res) => {
  const { ma_nv, ho_ten, email, phone, chuc_vu, phong_ban, phan_quyen, password } = req.body;
  if (!ma_nv || !ho_ten || !email || !password) {
    return res.status(400).json({ success: false, error: 'Thiếu thông tin bắt buộc: Mã NV, Họ tên, Email, Mật khẩu.' });
  }

  const db = getDb();
  const exists = db.prepare('SELECT id FROM users WHERE ma_nv = ? OR email = ? COLLATE NOCASE').get(ma_nv, email);
  if (exists) return res.status(409).json({ success: false, error: 'Mã NV hoặc Email đã tồn tại.' });

  const hash = await hashPassword(password);
  const result = db.prepare(
    'INSERT INTO users (ma_nv, ho_ten, email, phone, chuc_vu, phong_ban, phan_quyen, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(ma_nv.trim(), ho_ten.trim(), email.trim().toLowerCase(), phone || '', chuc_vu || '', phong_ban || '', phan_quyen || 'Người dùng', hash);

  res.status(201).json({ success: true, data: { id: result.lastInsertRowid, ma_nv } });
});

router.put('/:id', authenticate, requireRole('Admin'), audit('USER_UPDATE', 'user'), async (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ success: false, error: 'Không tìm thấy người dùng.' });

  const { ho_ten, email, phone, chuc_vu, phong_ban, phan_quyen, password, is_active } = req.body;
  const updates = [];
  const params = [];

  if (ho_ten !== undefined) { updates.push('ho_ten = ?'); params.push(ho_ten.trim()); }
  if (email !== undefined) { updates.push('email = ?'); params.push(email.trim().toLowerCase()); }
  if (phone !== undefined) { updates.push('phone = ?'); params.push(phone); }
  if (chuc_vu !== undefined) { updates.push('chuc_vu = ?'); params.push(chuc_vu); }
  if (phong_ban !== undefined) { updates.push('phong_ban = ?'); params.push(phong_ban); }
  if (phan_quyen !== undefined) { updates.push('phan_quyen = ?'); params.push(phan_quyen); }
  if (is_active !== undefined) { updates.push('is_active = ?'); params.push(is_active ? 1 : 0); }
  if (password) { updates.push('password_hash = ?'); params.push(await hashPassword(password)); }

  if (updates.length === 0) return res.status(400).json({ success: false, error: 'Không có dữ liệu cập nhật.' });

  updates.push("updated_at = datetime('now')");
  params.push(req.params.id);
  db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  res.json({ success: true, message: 'Cập nhật thành công.' });
});

router.delete('/:id', authenticate, requireRole('Admin'), audit('USER_DELETE', 'user'), (req, res) => {
  const db = getDb();
  if (parseInt(req.params.id) === req.user.id) {
    return res.status(400).json({ success: false, error: 'Không thể xóa chính mình.' });
  }
  db.prepare('UPDATE users SET is_active = 0, updated_at = datetime("now") WHERE id = ?').run(req.params.id);
  res.json({ success: true, message: 'Đã vô hiệu hóa người dùng.' });
});

module.exports = router;
