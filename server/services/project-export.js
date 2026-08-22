/* ═══════════════════════════════════════════════════════════
   PROJECT EXPORT — Kết xuất hồ sơ dự án
   ─────────────────────────────────────────────────────────
   Gom tài liệu của một dự án theo hai cấp:

       Giai đoạn (project_phases.thu_tu)
         └── Thủ tục (documents.thu_tuc)
               └── từng tài liệu

   Dùng chung cho cả bảng Excel và danh mục tệp để tải về, nhờ
   vậy thứ tự trong file Excel luôn khớp với cây thư mục trong
   file ZIP — người lưu trữ đối chiếu được từng dòng.
═══════════════════════════════════════════════════════════ */
'use strict';

const KHONG_GIAI_DOAN = '(Chưa phân giai đoạn)';
const KHONG_THU_TUC = '(Chưa phân thủ tục)';

/** Đọc toàn bộ tài liệu của dự án, kèm tên giai đoạn và người liên quan. */
function layTaiLieu(db, projectId) {
  return db.prepare(`
    SELECT d.*, ph.ten_giai_doan, ph.thu_tu AS phase_order,
           u.ho_ten  AS nguoi_tao_name,
           u2.ho_ten AS nguoi_duyet_name,
           u3.ho_ten AS nguoi_ky_name
    FROM documents d
    LEFT JOIN project_phases ph ON d.phase_id = ph.id
    LEFT JOIN users u  ON d.nguoi_tao_id  = u.id
    LEFT JOIN users u2 ON d.nguoi_duyet_id = u2.id
    LEFT JOIN users u3 ON d.nguoi_ky_id   = u3.id
    WHERE d.project_id = ?
    ORDER BY COALESCE(ph.thu_tu, 9999), d.thu_tuc, d.created_at
  `).all(projectId);
}

/** Tệp đính kèm, gom theo document_id để tránh N+1 truy vấn. */
function layDinhKem(db, docIds) {
  if (!docIds.length) return {};
  const holes = docIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT * FROM attachments WHERE document_id IN (${holes}) ORDER BY id`
  ).all(...docIds);

  const theoDoc = {};
  for (const r of rows) (theoDoc[r.document_id] ||= []).push(r);
  return theoDoc;
}

/**
 * Dựng cây Giai đoạn → Thủ tục → Tài liệu.
 * @returns {{project, phases: Array}}
 */
function dungCay(db, project) {
  const docs = layTaiLieu(db, project.id);
  const dinhKem = layDinhKem(db, docs.map(d => d.id));

  const phases = [];
  const chiMucPhase = new Map();

  for (const d of docs) {
    const tenGD = d.ten_giai_doan || KHONG_GIAI_DOAN;
    const tenTT = (d.thu_tuc || '').trim() || KHONG_THU_TUC;

    if (!chiMucPhase.has(tenGD)) {
      chiMucPhase.set(tenGD, { ten: tenGD, thuTu: d.phase_order ?? 9999, thuTucs: [], chiMuc: new Map() });
      phases.push(chiMucPhase.get(tenGD));
    }
    const gd = chiMucPhase.get(tenGD);

    if (!gd.chiMuc.has(tenTT)) {
      gd.chiMuc.set(tenTT, { ten: tenTT, taiLieu: [] });
      gd.thuTucs.push(gd.chiMuc.get(tenTT));
    }
    gd.chiMuc.get(tenTT).taiLieu.push({ ...d, attachments: dinhKem[d.id] || [] });
  }

  phases.sort((a, b) => a.thuTu - b.thuTu);
  return { project, phases };
}

/**
 * Danh mục tệp để trình duyệt tải và nén ZIP.
 *
 * Đường dẫn trong ZIP phản chiếu đúng cây Giai đoạn/Thủ tục. Tên tệp
 * được làm sạch vì tên tài liệu tiếng Việt hay chứa ký tự mà một số
 * hệ điều hành không nhận (dấu /, :, ?…).
 */
function danhMucTep(cay) {
  const tep = [];
  let tongDungLuong = 0;

  cay.phases.forEach((gd, i) => {
    const thuMucGD = `${String(i + 1).padStart(2, '0')}. ${lamSachTen(gd.ten)}`;

    gd.thuTucs.forEach((tt, j) => {
      const thuMucTT = `${String(j + 1).padStart(2, '0')}. ${lamSachTen(tt.ten)}`;

      tt.taiLieu.forEach(d => {
        const goc = `${thuMucGD}/${thuMucTT}/${lamSachTen(d.ma_doc)}`;

        const them = (url, ten, loai) => {
          if (!url) return;
          tep.push({ path: `${goc}/${ten}`, url, loai, maDoc: d.ma_doc });
        };

        them(d.file_url, `GOC_${lamSachTen(d.file_name || d.ma_doc + '.pdf')}`, 'goc');
        them(d.signed_file_url, `DAKY_${lamSachTen(d.ma_doc)}.pdf`, 'da-ky');
        d.attachments.forEach(a =>
          them(a.file_url, `DINHKEM_${lamSachTen(a.file_name)}`, 'dinh-kem'));

        tongDungLuong += (d.file_size || 0);
        d.attachments.forEach(a => { tongDungLuong += (a.file_size || 0); });
      });
    });
  });

  return { tep, tongDungLuong };
}

/** Bỏ ký tự không hợp lệ cho tên tệp/thư mục, giữ nguyên tiếng Việt. */
function lamSachTen(s) {
  return String(s || '')
    .replace(/[\/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'khong-ten';
}

module.exports = { dungCay, danhMucTep, lamSachTen, KHONG_GIAI_DOAN, KHONG_THU_TUC };
