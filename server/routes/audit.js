const express = require('express');
const router = express.Router();
const { authenticate, requirePermission } = require('../middleware/auth');
const auditLog = require('../services/audit-log');

router.get('/', authenticate, requirePermission('Nhật ký giao dịch'), (req, res) => {
  const { user_id, action, from, to, limit = 100, offset = 0 } = req.query;
  const result = auditLog.query({
    userId: user_id ? parseInt(user_id) : null,
    action: action || null,
    from: from || null,
    to: to || null,
    limit: Math.min(parseInt(limit) || 100, 500),
    offset: parseInt(offset) || 0,
  });
  res.json({ success: true, data: result.rows, meta: { total: result.total } });
});

router.get('/actions', authenticate, requirePermission('Nhật ký giao dịch'), (req, res) => {
  res.json({ success: true, data: auditLog.getActions() });
});

router.get('/export', authenticate, requirePermission('Nhật ký giao dịch'), (req, res) => {
  const { from, to, format = 'json' } = req.query;
  const result = auditLog.query({ from, to, limit: 10000, offset: 0 });

  if (format === 'csv') {
    const header = 'ID,Thời gian,Người dùng,Email,Hành động,Loại,Đối tượng,IP,Chi tiết\n';
    const rows = result.rows.map(r =>
      `${r.id},"${r.timestamp}","${r.user_id || ''}","${r.user_email}","${r.action}","${r.target_type}","${r.target_id}","${r.ip_address}","${(r.detail || '').replace(/"/g, '""')}"`
    ).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=audit_log.csv');
    return res.send('﻿' + header + rows);
  }

  res.json({ success: true, data: result.rows, meta: { total: result.total } });
});

module.exports = router;
