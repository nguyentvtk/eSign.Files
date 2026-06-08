const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { authenticate, requirePermission } = require('../middleware/auth');

const DEFAULT_PHASES = [
  'Chuẩn bị đầu tư',
  'Thực hiện đầu tư',
  'Đấu thầu',
  'Thi công',
  'Nghiệm thu',
  'Quyết toán',
];

router.get('/', authenticate, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT p.*, u.ho_ten as created_by_name,
      (SELECT COUNT(*) FROM documents WHERE project_id = p.id) as so_van_ban,
      (SELECT COUNT(*) FROM documents WHERE project_id = p.id AND trang_thai = 'Đã ký') as so_da_ky
    FROM projects p
    LEFT JOIN users u ON p.created_by = u.id
    ORDER BY p.created_at DESC
  `).all();
  res.json({ success: true, data: rows });
});

router.get('/:id', authenticate, (req, res) => {
  const db = getDb();
  const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!proj) return res.status(404).json({ success: false, error: 'Không tìm thấy dự án.' });
  proj.phases = db.prepare('SELECT * FROM project_phases WHERE project_id = ? ORDER BY thu_tu').all(proj.id);
  res.json({ success: true, data: proj });
});

router.post('/', authenticate, requirePermission('Quản lý dự án'), (req, res) => {
  const { ma_du_an, ten_du_an, chu_dau_tu, tong_muc_dau_tu, ngay_bat_dau, ngay_ket_thuc, mo_ta, phases } = req.body;
  if (!ma_du_an || !ten_du_an) {
    return res.status(400).json({ success: false, error: 'Mã & tên dự án bắt buộc.' });
  }
  const db = getDb();
  const exists = db.prepare('SELECT id FROM projects WHERE ma_du_an = ?').get(ma_du_an);
  if (exists) return res.status(409).json({ success: false, error: 'Mã dự án đã tồn tại.' });

  const insertProj = db.prepare(`INSERT INTO projects
    (ma_du_an, ten_du_an, chu_dau_tu, tong_muc_dau_tu, ngay_bat_dau, ngay_ket_thuc, mo_ta, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertPhase = db.prepare('INSERT INTO project_phases (project_id, ten_giai_doan, thu_tu) VALUES (?, ?, ?)');

  const tx = db.transaction(() => {
    const r = insertProj.run(ma_du_an.trim(), ten_du_an.trim(), chu_dau_tu || '', parseFloat(tong_muc_dau_tu) || 0,
      ngay_bat_dau || null, ngay_ket_thuc || null, mo_ta || '', req.user.id);
    const projId = r.lastInsertRowid;
    const phaseList = (Array.isArray(phases) && phases.length) ? phases : DEFAULT_PHASES;
    phaseList.forEach((p, i) => insertPhase.run(projId, typeof p === 'string' ? p : p.ten_giai_doan, i + 1));
    return projId;
  });
  const id = tx();

  res.status(201).json({ success: true, data: { id, ma_du_an } });
});

router.put('/:id', authenticate, requirePermission('Quản lý dự án'), (req, res) => {
  const db = getDb();
  const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!proj) return res.status(404).json({ success: false, error: 'Không tìm thấy.' });

  const { ten_du_an, chu_dau_tu, tong_muc_dau_tu, trang_thai, ngay_bat_dau, ngay_ket_thuc, mo_ta } = req.body;
  const fields = [];
  const values = [];
  if (ten_du_an !== undefined) { fields.push('ten_du_an = ?'); values.push(ten_du_an); }
  if (chu_dau_tu !== undefined) { fields.push('chu_dau_tu = ?'); values.push(chu_dau_tu); }
  if (tong_muc_dau_tu !== undefined) { fields.push('tong_muc_dau_tu = ?'); values.push(parseFloat(tong_muc_dau_tu) || 0); }
  if (trang_thai !== undefined) { fields.push('trang_thai = ?'); values.push(trang_thai); }
  if (ngay_bat_dau !== undefined) { fields.push('ngay_bat_dau = ?'); values.push(ngay_bat_dau); }
  if (ngay_ket_thuc !== undefined) { fields.push('ngay_ket_thuc = ?'); values.push(ngay_ket_thuc); }
  if (mo_ta !== undefined) { fields.push('mo_ta = ?'); values.push(mo_ta); }
  if (!fields.length) return res.status(400).json({ success: false, error: 'Không có dữ liệu cập nhật.' });

  fields.push("updated_at = datetime('now')");
  values.push(req.params.id);
  db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  res.json({ success: true });
});

router.delete('/:id', authenticate, requirePermission('Quản lý dự án'), (req, res) => {
  const db = getDb();
  const cnt = db.prepare('SELECT COUNT(*) as c FROM documents WHERE project_id = ?').get(req.params.id);
  if (cnt.c > 0) return res.status(400).json({ success: false, error: `Không thể xóa: ${cnt.c} tài liệu đang thuộc dự án.` });
  db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// GET /projects/:id/phases
router.get('/:id/phases', authenticate, (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM project_phases WHERE project_id = ? ORDER BY thu_tu').all(req.params.id);
  res.json({ success: true, data: rows });
});

router.post('/:id/phases', authenticate, requirePermission('Quản lý dự án'), (req, res) => {
  const { ten_giai_doan } = req.body;
  if (!ten_giai_doan) return res.status(400).json({ success: false, error: 'Tên giai đoạn bắt buộc.' });
  const db = getDb();
  const maxOrder = db.prepare('SELECT MAX(thu_tu) as m FROM project_phases WHERE project_id = ?').get(req.params.id);
  const r = db.prepare('INSERT INTO project_phases (project_id, ten_giai_doan, thu_tu) VALUES (?, ?, ?)').run(
    req.params.id, ten_giai_doan.trim(), (maxOrder.m || 0) + 1
  );
  res.json({ success: true, data: { id: r.lastInsertRowid } });
});

// GET /projects/:id/documents — danh mục HS theo dự án (phục vụ quyết toán)
router.get('/:id/documents', authenticate, (req, res) => {
  const db = getDb();
  const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!proj) return res.status(404).json({ success: false, error: 'Không tìm thấy.' });
  const docs = db.prepare(`
    SELECT d.*, ph.ten_giai_doan, u.ho_ten as nguoi_tao_name, u.ma_nv as nguoi_tao_manv,
      u2.ho_ten as nguoi_duyet_name
    FROM documents d
    LEFT JOIN project_phases ph ON d.phase_id = ph.id
    LEFT JOIN users u ON d.nguoi_tao_id = u.id
    LEFT JOIN users u2 ON d.nguoi_duyet_id = u2.id
    WHERE d.project_id = ?
    ORDER BY ph.thu_tu, d.created_at
  `).all(req.params.id);
  res.json({ success: true, data: { project: proj, documents: docs } });
});

// GET /projects/:id/export?format=csv — Xuất danh mục HS quyết toán
router.get('/:id/export', authenticate, (req, res) => {
  const db = getDb();
  const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!proj) return res.status(404).json({ success: false, error: 'Không tìm thấy.' });
  const docs = db.prepare(`
    SELECT d.*, ph.ten_giai_doan, u.ho_ten as nguoi_tao_name, u2.ho_ten as nguoi_duyet_name
    FROM documents d
    LEFT JOIN project_phases ph ON d.phase_id = ph.id
    LEFT JOIN users u ON d.nguoi_tao_id = u.id
    LEFT JOIN users u2 ON d.nguoi_duyet_id = u2.id
    WHERE d.project_id = ?
    ORDER BY ph.thu_tu, d.created_at
  `).all(req.params.id);

  const header = ['STT', 'Giai đoạn', 'Loại VB', 'Số VB', 'Tên tài liệu', 'Trích yếu', 'Người tạo', 'Người duyệt', 'Ngày tạo', 'Ngày ký', 'Trạng thái', 'Link gốc', 'Link đã ký'];
  const rows = docs.map((d, i) => [
    i + 1,
    d.ten_giai_doan || '',
    d.loai_van_ban || d.loai_tai_lieu || '',
    d.so_van_ban || '',
    d.ten_tai_lieu || '',
    d.trich_yeu || '',
    d.nguoi_tao_name || '',
    d.nguoi_duyet_name || '',
    d.created_at || '',
    d.ngay_ky || '',
    d.trang_thai || '',
    d.file_url || '',
    d.signed_file_url || '',
  ]);

  const escapeCsv = (v) => {
    const s = String(v ?? '');
    return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = '﻿' + [header, ...rows].map(r => r.map(escapeCsv).join(',')).join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="DanhMucHS_${proj.ma_du_an}_${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(csv);
});

module.exports = router;
