const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { authenticate, requireRole, requirePermission } = require('../middleware/auth');
const auditLog = require('../services/audit-log');
const projectExport = require('../services/project-export');
const projectXlsx = require('../services/project-xlsx');
const sheets = require('../services/google-sheets');
const projectSync = require('../services/project-sync');

const DEFAULT_PHASES = [
  'Chuẩn bị đầu tư',
  'Thực hiện đầu tư',
  'Đấu thầu',
  'Thi công',
  'Nghiệm thu',
  'Quyết toán',
];

const VALID_STATUS = ['Đang thực hiện', 'Tạm dừng', 'Hoàn thành', 'Đã quyết toán'];
function normStatus(s) {
  const v = String(s || '').trim();
  return VALID_STATUS.includes(v) ? v : 'Đang thực hiện';
}

// Đoán mapping cột dựa theo tên header (gần đúng)
function suggestMapping(headers) {
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
  const find = (...keys) => {
    for (const h of headers) {
      const nh = norm(h);
      if (keys.some(k => nh.includes(k))) return h;
    }
    return '';
  };
  return {
    ma_du_an: find('ma da', 'ma du an', 'ma_da', 'madự', 'ma '),
    ten_du_an: find('ten du an', 'ten da', 'ten '),
    mo_ta: find('mo ta', 'mota'),
    nam_thuc_hien: find('nam thuc hien', 'nam '),
    nv_ky_thuat: find('ky thuat', 'phu trach ky thuat', 'kythuat'),
    nv_ke_toan: find('ke toan', 'phu trach ke toan', 'ketoan'),
    chu_dau_tu: find('chu dau tu', 'cdt'),
    ngay_bat_dau: find('ngay bat dau', 'bat dau'),
    ngay_ket_thuc: find('ngay ket thuc', 'ket thuc'),
    trang_thai: find('trang thai'),
    tong_muc_dau_tu: find('tong muc dau tu', 'tmdt', 'muc dau tu'),
    tong_gt_quyet_toan: find('quyet toan'),
    so_giai_ngan: find('giai ngan'),
    loai_du_an: find('loai du an', 'loai da', 'loai'),
  };
}

// Tìm user theo tên (ho_ten) → id
function resolveUserId(db, name) {
  if (!name || !name.trim()) return null;
  const u = db.prepare('SELECT id FROM users WHERE ho_ten = ? COLLATE NOCASE').get(name.trim());
  return u ? u.id : null;
}

router.get('/', authenticate, async (req, res) => {
  const db = getDb();
  // Sync users trước để resolveUserId chính xác khi resync projects
  const { syncAllUsersIfEmpty } = require('../services/user-sync');
  await syncAllUsersIfEmpty(db);
  await projectSync.syncIfEmpty(db);
  const isManager = req.user.phan_quyen === 'Admin' || req.user.phan_quyen === 'Quản lý';

  // Người dùng thường: chỉ thấy dự án mình phụ trách kỹ thuật/kế toán (quyền trình VB).
  // Admin/Quản lý: thấy tất cả.
  let where = '';
  const params = [];
  if (!isManager) {
    where = 'WHERE p.nv_ky_thuat_id = ? OR p.nv_ke_toan_id = ?';
    params.push(req.user.id, req.user.id);
  }

  const rows = db.prepare(`
    SELECT p.*, u.ho_ten as created_by_name,
      (SELECT COUNT(*) FROM documents WHERE project_id = p.id) as so_van_ban,
      (SELECT COUNT(*) FROM documents WHERE project_id = p.id AND trang_thai = 'Đã ký') as so_da_ky
    FROM projects p
    LEFT JOIN users u ON p.created_by = u.id
    ${where}
    ORDER BY p.created_at DESC
  `).all(...params);
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

// POST /projects/sheet-preview — đọc header + vài dòng mẫu để người dùng map cột
router.post('/sheet-preview', authenticate, requirePermission('Quản lý dự án'), async (req, res) => {
  const { url, sheetName } = req.body;
  if (!url) return res.status(400).json({ success: false, error: 'Vui lòng nhập URL hoặc ID Google Sheet.' });
  try {
    const ref = sheets.parseSheetRef(url);
    if (!ref.id) return res.status(400).json({ success: false, error: 'Không nhận diện được Sheet ID từ URL.' });
    const { headers, rows } = await sheets.fetchAnySheet(ref.id, { gid: ref.gid, sheetName });
    if (!headers.length) return res.status(400).json({ success: false, error: 'Sheet rỗng hoặc không đọc được.' });

    const sample = rows.slice(0, 8).map(r => {
      const o = {};
      headers.forEach((h, i) => { o[h] = r[i] || ''; });
      return o;
    });
    res.json({
      success: true,
      data: { sheetId: ref.id, gid: ref.gid, headers, sample, total: rows.length, mapping: suggestMapping(headers) },
    });
  } catch (e) {
    console.error('[sheet-preview]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /projects/import-sheet — import toàn bộ dự án theo mapping
router.post('/import-sheet', authenticate, requirePermission('Quản lý dự án'), async (req, res) => {
  const { url, sheetName, mapping } = req.body;
  if (!url || !mapping || !mapping.ma_du_an || !mapping.ten_du_an) {
    return res.status(400).json({ success: false, error: 'Thiếu URL hoặc chưa map cột Mã DA / Tên dự án.' });
  }
  try {
    const db = getDb();
    // Sync tất cả users trước để resolveUserId hoạt động chính xác
    const { syncAllUsersIfEmpty } = require('../services/user-sync');
    await syncAllUsersIfEmpty(db);
    const ref = sheets.parseSheetRef(url);
    const { headers, rows } = await sheets.fetchAnySheet(ref.id, { gid: ref.gid, sheetName });
    const colIdx = {};
    headers.forEach((h, i) => { colIdx[h] = i; });
    const val = (row, header) => (header && colIdx[header] !== undefined) ? (row[colIdx[header]] || '').trim() : '';

    const sheetSource = JSON.stringify({ sheetId: ref.id, gid: ref.gid, sheetName: sheetName || '', mapping });

    let created = 0, updated = 0;
    const insertPhase = db.prepare('INSERT INTO project_phases (project_id, ten_giai_doan, thu_tu) VALUES (?, ?, ?)');

    const tx = db.transaction(() => {
      for (const row of rows) {
        const maDA = val(row, mapping.ma_du_an);
        const tenDA = val(row, mapping.ten_du_an);
        if (!maDA || !tenDA) continue;

        const nvKT = val(row, mapping.nv_ky_thuat);
        const nvKToan = val(row, mapping.nv_ke_toan);
        const data = {
          ma_du_an: maDA,
          ten_du_an: tenDA,
          mo_ta: val(row, mapping.mo_ta),
          chu_dau_tu: val(row, mapping.chu_dau_tu),
          nam_thuc_hien: val(row, mapping.nam_thuc_hien),
          nv_ky_thuat: nvKT,
          nv_ky_thuat_id: resolveUserId(db, nvKT),
          nv_ke_toan: nvKToan,
          nv_ke_toan_id: resolveUserId(db, nvKToan),
          ngay_bat_dau: val(row, mapping.ngay_bat_dau) || null,
          ngay_ket_thuc: val(row, mapping.ngay_ket_thuc) || null,
          trang_thai: normStatus(val(row, mapping.trang_thai)),
          loai_du_an: val(row, mapping.loai_du_an),
          tong_muc_dau_tu: sheets.parseMoney(val(row, mapping.tong_muc_dau_tu)),
          tong_gt_quyet_toan: sheets.parseMoney(val(row, mapping.tong_gt_quyet_toan)),
          so_giai_ngan: sheets.parseMoney(val(row, mapping.so_giai_ngan)),
          sheet_source: sheetSource,
        };

        const existing = db.prepare('SELECT id FROM projects WHERE ma_du_an = ? COLLATE NOCASE').get(maDA);
        if (existing) {
          db.prepare(`UPDATE projects SET ten_du_an=?, mo_ta=?, chu_dau_tu=?, nam_thuc_hien=?,
              nv_ky_thuat=?, nv_ky_thuat_id=?, nv_ke_toan=?, nv_ke_toan_id=?, ngay_bat_dau=?, ngay_ket_thuc=?,
              trang_thai=?, loai_du_an=?, tong_muc_dau_tu=?, tong_gt_quyet_toan=?, so_giai_ngan=?, sheet_source=?,
              updated_at=datetime('now') WHERE id=?`)
            .run(data.ten_du_an, data.mo_ta, data.chu_dau_tu, data.nam_thuc_hien,
                 data.nv_ky_thuat, data.nv_ky_thuat_id, data.nv_ke_toan, data.nv_ke_toan_id,
                 data.ngay_bat_dau, data.ngay_ket_thuc, data.trang_thai, data.loai_du_an,
                 data.tong_muc_dau_tu, data.tong_gt_quyet_toan, data.so_giai_ngan, data.sheet_source, existing.id);
          updated++;
        } else {
          const r = db.prepare(`INSERT INTO projects
              (ma_du_an, ten_du_an, mo_ta, chu_dau_tu, nam_thuc_hien, nv_ky_thuat, nv_ky_thuat_id,
               nv_ke_toan, nv_ke_toan_id, ngay_bat_dau, ngay_ket_thuc, trang_thai, loai_du_an,
               tong_muc_dau_tu, tong_gt_quyet_toan, so_giai_ngan, sheet_source, created_by)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(data.ma_du_an, data.ten_du_an, data.mo_ta, data.chu_dau_tu, data.nam_thuc_hien,
                 data.nv_ky_thuat, data.nv_ky_thuat_id, data.nv_ke_toan, data.nv_ke_toan_id,
                 data.ngay_bat_dau, data.ngay_ket_thuc, data.trang_thai, data.loai_du_an,
                 data.tong_muc_dau_tu, data.tong_gt_quyet_toan, data.so_giai_ngan, data.sheet_source, req.user.id);
          // Tạo giai đoạn mặc định cho dự án mới
          DEFAULT_PHASES.forEach((p, i) => insertPhase.run(r.lastInsertRowid, p, i + 1));
          created++;
        }
      }
    });
    tx();

    require('../services/audit-log').log({
      userId: req.user.id, userEmail: req.user.email, action: 'PROJECT_IMPORT_SHEET',
      detail: { total: rows.length, created, updated }, ip: req.ip, userAgent: req.get('user-agent'),
    });

    res.json({ success: true, message: `Import thành công: ${created} dự án mới, ${updated} cập nhật.`, data: { created, updated, total: rows.length } });
  } catch (e) {
    console.error('[import-sheet]', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.put('/:id', authenticate, requirePermission('Quản lý dự án'), (req, res) => {
  const db = getDb();
  const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!proj) return res.status(404).json({ success: false, error: 'Không tìm thấy.' });

  const b = req.body;
  const fields = [];
  const values = [];
  const set = (col, v) => { fields.push(`${col} = ?`); values.push(v); };

  if (b.ten_du_an !== undefined) set('ten_du_an', b.ten_du_an);
  if (b.chu_dau_tu !== undefined) set('chu_dau_tu', b.chu_dau_tu);
  if (b.tong_muc_dau_tu !== undefined) set('tong_muc_dau_tu', parseFloat(b.tong_muc_dau_tu) || 0);
  if (b.trang_thai !== undefined) set('trang_thai', normStatus(b.trang_thai));
  if (b.ngay_bat_dau !== undefined) set('ngay_bat_dau', b.ngay_bat_dau || null);
  if (b.ngay_ket_thuc !== undefined) set('ngay_ket_thuc', b.ngay_ket_thuc || null);
  if (b.mo_ta !== undefined) set('mo_ta', b.mo_ta);
  if (b.nam_thuc_hien !== undefined) set('nam_thuc_hien', b.nam_thuc_hien);
  if (b.loai_du_an !== undefined) set('loai_du_an', b.loai_du_an);
  if (b.nv_ky_thuat !== undefined) { set('nv_ky_thuat', b.nv_ky_thuat); set('nv_ky_thuat_id', resolveUserId(db, b.nv_ky_thuat)); }
  if (b.nv_ke_toan !== undefined) { set('nv_ke_toan', b.nv_ke_toan); set('nv_ke_toan_id', resolveUserId(db, b.nv_ke_toan)); }
  if (b.tong_gt_quyet_toan !== undefined) set('tong_gt_quyet_toan', parseFloat(b.tong_gt_quyet_toan) || 0);
  if (b.so_giai_ngan !== undefined) set('so_giai_ngan', parseFloat(b.so_giai_ngan) || 0);

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

// GET /projects/:id/export — Xuất danh mục HS dạng CSV.
// Chỉ Admin: bảng này lộ toàn bộ link tài liệu của dự án.
router.get('/:id/export', authenticate, requireRole('Admin'), (req, res) => {
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

/* ── Kết xuất hồ sơ dự án (chỉ Admin) ─────────────────────
   Hai đầu ra dùng chung một cây dữ liệu nên thứ tự dòng trong
   file Excel khớp với cây thư mục trong file ZIP.
──────────────────────────────────────────────────────────── */

// GET /projects/:id/export.xlsx — bảng danh mục theo Giai đoạn → Thủ tục
router.get('/:id/export.xlsx', authenticate, requireRole('Admin'), async (req, res) => {
  try {
    const db = getDb();
    const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!proj) return res.status(404).json({ success: false, error: 'Không tìm thấy dự án.' });

    const cay = projectExport.dungCay(db, proj);
    const buf = await projectXlsx.taoWorkbook(cay);

    const ten = `DanhMucHoSo_${projectExport.lamSachTen(proj.ma_du_an)}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(ten)}`);
    res.send(buf);
  } catch (e) {
    console.error('[export.xlsx]', e);
    res.status(500).json({ success: false, error: 'Không tạo được file Excel: ' + e.message });
  }
});

// GET /projects/:id/files — danh mục tệp để trình duyệt tải rồi nén ZIP.
// Nén phía trình duyệt vì hàm serverless bị cắt ở 30 giây, không đủ cho
// dự án nhiều tệp.
router.get('/:id/files', authenticate, requireRole('Admin'), (req, res) => {
  try {
    const db = getDb();
    const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
    if (!proj) return res.status(404).json({ success: false, error: 'Không tìm thấy dự án.' });

    const cay = projectExport.dungCay(db, proj);
    const { tep, tongDungLuong } = projectExport.danhMucTep(cay);

    res.json({
      success: true,
      data: {
        project: { id: proj.id, ma_du_an: proj.ma_du_an, ten_du_an: proj.ten_du_an, trang_thai: proj.trang_thai },
        files: tep,
        soTep: tep.length,
        tongDungLuong,
      },
    });
  } catch (e) {
    console.error('[project files]', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// PATCH /projects/:id/documents/thu-tuc — điền/sửa Thủ tục cho tài liệu đã tạo.
//
// Nhận cả loạt trong một lần gọi vì việc chính là điền bù cho tài liệu tạo
// từ trước khi có trường này — sửa từng cái một sẽ rất mệt.
//
// Chỉ nhận tài liệu THUỘC ĐÚNG dự án trên URL: nếu không kiểm, người có
// quyền ở một dự án sẽ sửa được tài liệu của dự án khác.
router.patch('/:id/documents/thu-tuc', authenticate, requirePermission('Quản lý dự án'), (req, res) => {
  const db = getDb();
  const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!proj) return res.status(404).json({ success: false, error: 'Không tìm thấy dự án.' });

  const updates = Array.isArray(req.body?.updates) ? req.body.updates : null;
  if (!updates || !updates.length) {
    return res.status(400).json({ success: false, error: 'Không có dữ liệu cần cập nhật.' });
  }
  if (updates.length > 500) {
    return res.status(400).json({ success: false, error: 'Mỗi lần chỉ cập nhật tối đa 500 tài liệu.' });
  }

  const thuocDuAn = new Set(
    db.prepare('SELECT id FROM documents WHERE project_id = ?').all(proj.id).map(r => r.id)
  );

  const hopLe = [];
  const boQua = [];
  for (const u of updates) {
    const id = parseInt(u?.id);
    if (!id || !thuocDuAn.has(id)) { boQua.push(u?.id); continue; }
    hopLe.push({ id, thu_tuc: String(u.thu_tuc ?? '').trim().slice(0, 200) });
  }

  if (!hopLe.length) {
    return res.status(400).json({ success: false, error: 'Không tài liệu nào thuộc dự án này.' });
  }

  const stmt = db.prepare("UPDATE documents SET thu_tuc = ?, updated_at = datetime('now') WHERE id = ? AND project_id = ?");
  const tx = db.transaction(() => {
    for (const u of hopLe) stmt.run(u.thu_tuc, u.id, proj.id);
  });
  tx();

  auditLog.log({
    userId: req.user.id, userEmail: req.user.email,
    action: 'DOCUMENT_THU_TUC_UPDATE', targetType: 'project', targetId: proj.ma_du_an,
    detail: { soTaiLieu: hopLe.length, boQua: boQua.length },
    ip: req.ip, userAgent: req.get('user-agent'),
  });

  res.json({
    success: true,
    message: `Đã cập nhật thủ tục cho ${hopLe.length} tài liệu.`,
    data: { daCapNhat: hopLe.length, boQua: boQua.length },
  });
});

module.exports = router;
