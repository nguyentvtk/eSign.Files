const sheets = require('./google-sheets');
const { syncAllUsersIfEmpty } = require('./user-sync');

const PROJECT_SHEET_URL = process.env.PROJECT_SHEET_URL || '';
const PROJECT_SHEET_NAME = process.env.PROJECT_SHEET_NAME || '';

let _lastSyncAt = 0;
const SYNC_COOLDOWN_MS = 60 * 1000;

function isConfigured() {
  return !!PROJECT_SHEET_URL;
}

async function syncIfEmpty(db) {
  if (!isConfigured()) return;

  const { c } = db.prepare('SELECT COUNT(*) as c FROM projects').get();
  if (c > 0) {
    _lastSyncAt = Date.now();
    return;
  }

  // Cooldown chỉ áp dụng khi DB trống (tránh spam import lặp lại khi lỗi liên tục)
  const now = Date.now();
  if (now - _lastSyncAt < SYNC_COOLDOWN_MS) return;

  console.log('[project-sync] DB trống — bắt đầu resync dự án từ Google Sheet...');
  try {
    // Sync users trước để resolveUserId hoạt động chính xác
    await syncAllUsersIfEmpty(db);
    await _importFromSheet(db);
    _lastSyncAt = Date.now();
  } catch (e) {
    _lastSyncAt = Date.now(); // Tránh retry liên tục khi lỗi
    console.error('[project-sync] Lỗi:', e.message);
  }
}

async function _importFromSheet(db) {
  const ref = sheets.parseSheetRef(PROJECT_SHEET_URL);
  if (!ref.id) {
    console.error('[project-sync] Không parse được Sheet ID từ PROJECT_SHEET_URL');
    return;
  }

  const { headers, rows } = await sheets.fetchAnySheet(ref.id, {
    gid: ref.gid,
    sheetName: PROJECT_SHEET_NAME,
  });
  if (!headers.length || !rows.length) return;

  const mapping = _suggestMapping(headers);
  if (!mapping.ma_du_an || !mapping.ten_du_an) {
    console.error('[project-sync] Không tìm được cột Mã DA / Tên dự án trong header:', headers);
    return;
  }

  const colIdx = {};
  headers.forEach((h, i) => { colIdx[h] = i; });
  const val = (row, header) => (header && colIdx[header] !== undefined) ? (row[colIdx[header]] || '').trim() : '';

  const DEFAULT_PHASES = [
    'Chuẩn bị đầu tư', 'Thực hiện đầu tư', 'Đấu thầu',
    'Thi công', 'Nghiệm thu', 'Quyết toán',
  ];
  const VALID_STATUS = ['Đang thực hiện', 'Tạm dừng', 'Hoàn thành', 'Đã quyết toán'];
  const normStatus = (s) => {
    const v = String(s || '').trim();
    return VALID_STATUS.includes(v) ? v : 'Đang thực hiện';
  };

  const resolveUserId = (name) => {
    if (!name || !name.trim()) return null;
    const u = db.prepare('SELECT id FROM users WHERE ho_ten = ? COLLATE NOCASE').get(name.trim());
    return u ? u.id : null;
  };

  const sheetSource = JSON.stringify({ sheetId: ref.id, gid: ref.gid, sheetName: PROJECT_SHEET_NAME || '', mapping });
  const insertPhase = db.prepare('INSERT INTO project_phases (project_id, ten_giai_doan, thu_tu) VALUES (?, ?, ?)');

  let created = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      const maDA = val(row, mapping.ma_du_an);
      const tenDA = val(row, mapping.ten_du_an);
      if (!maDA || !tenDA) continue;

      const existing = db.prepare('SELECT id FROM projects WHERE ma_du_an = ? COLLATE NOCASE').get(maDA);
      if (existing) continue;

      const nvKT = val(row, mapping.nv_ky_thuat);
      const nvKToan = val(row, mapping.nv_ke_toan);

      const r = db.prepare(`INSERT INTO projects
          (ma_du_an, ten_du_an, mo_ta, chu_dau_tu, nam_thuc_hien, nv_ky_thuat, nv_ky_thuat_id,
           nv_ke_toan, nv_ke_toan_id, ngay_bat_dau, ngay_ket_thuc, trang_thai, loai_du_an,
           tong_muc_dau_tu, tong_gt_quyet_toan, so_giai_ngan, sheet_source, created_by)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          maDA, tenDA,
          val(row, mapping.mo_ta),
          val(row, mapping.chu_dau_tu),
          val(row, mapping.nam_thuc_hien),
          nvKT, resolveUserId(nvKT),
          nvKToan, resolveUserId(nvKToan),
          val(row, mapping.ngay_bat_dau) || null,
          val(row, mapping.ngay_ket_thuc) || null,
          normStatus(val(row, mapping.trang_thai)),
          val(row, mapping.loai_du_an),
          sheets.parseMoney(val(row, mapping.tong_muc_dau_tu)),
          sheets.parseMoney(val(row, mapping.tong_gt_quyet_toan)),
          sheets.parseMoney(val(row, mapping.so_giai_ngan)),
          sheetSource,
          null,
        );
      DEFAULT_PHASES.forEach((p, i) => insertPhase.run(r.lastInsertRowid, p, i + 1));
      created++;
    }
  });
  tx();
  console.log(`[project-sync] Resync xong: ${created} dự án đã import.`);
}

function _suggestMapping(headers) {
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
  const find = (...keys) => {
    for (const h of headers) {
      const nh = norm(h);
      if (keys.some(k => nh.includes(k))) return h;
    }
    return '';
  };
  return {
    ma_du_an: find('ma da', 'ma du an', 'ma_da', 'ma '),
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

module.exports = { syncIfEmpty, isConfigured };
