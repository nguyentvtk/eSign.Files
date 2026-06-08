const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { authenticate, requireRole } = require('../middleware/auth');
const { audit } = require('../middleware/audit');

router.get('/', authenticate, (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM permissions ORDER BY feature_name, role').all();
  const grouped = {};
  rows.forEach(r => {
    if (!grouped[r.feature_name]) grouped[r.feature_name] = {};
    grouped[r.feature_name][r.role] = !!r.allowed;
  });
  res.json({ success: true, data: grouped });
});

router.put('/', authenticate, requireRole('Admin'), audit('PERM_UPDATE', 'permissions'), (req, res) => {
  const { permissions } = req.body;
  if (!permissions || typeof permissions !== 'object') {
    return res.status(400).json({ success: false, error: 'Dữ liệu phân quyền không hợp lệ.' });
  }

  const db = getDb();
  const upsert = db.prepare('INSERT INTO permissions (feature_name, role, allowed) VALUES (?, ?, ?) ON CONFLICT(feature_name, role) DO UPDATE SET allowed = ?');
  const tx = db.transaction((perms) => {
    for (const [feature, roles] of Object.entries(perms)) {
      for (const [role, allowed] of Object.entries(roles)) {
        upsert.run(feature, role, allowed ? 1 : 0, allowed ? 1 : 0);
      }
    }
  });
  tx(permissions);

  res.json({ success: true, message: 'Cập nhật phân quyền thành công.' });
});

module.exports = router;
