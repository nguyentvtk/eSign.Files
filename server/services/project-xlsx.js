/* ═══════════════════════════════════════════════════════════
   PROJECT XLSX — Bảng danh mục hồ sơ dự án
   ─────────────────────────────────────────────────────────
   Một sheet duy nhất, đọc từ trên xuống như bản kê giấy:

     • Khối tiêu đề: tên dự án, chủ đầu tư, ngày kết xuất
     • Dòng tiêu đề cột (cố định khi cuộn)
     • Mỗi GIAI ĐOẠN là một dải gộp ô, in đậm
     • Trong đó mỗi THỦ TỤC là một dải gộp ô nhạt hơn
     • Rồi tới từng tài liệu, đánh số lại từ 1 trong mỗi thủ tục
═══════════════════════════════════════════════════════════ */
'use strict';

const ExcelJS = require('exceljs');

const COT = [
  { key: 'stt',        ten: 'STT',            rong: 6  },
  { key: 'so_van_ban', ten: 'Số văn bản',     rong: 18 },
  { key: 'loai',       ten: 'Loại VB',        rong: 16 },
  { key: 'ten',        ten: 'Tên tài liệu',   rong: 46 },
  { key: 'trich_yeu',  ten: 'Trích yếu',      rong: 34 },
  { key: 'nguoi_tao',  ten: 'Người tạo',      rong: 20 },
  { key: 'nguoi_ky',   ten: 'Người ký',       rong: 20 },
  { key: 'ngay_tao',   ten: 'Ngày tạo',       rong: 12 },
  { key: 'ngay_ky',    ten: 'Ngày ký',        rong: 12 },
  { key: 'trang_thai', ten: 'Trạng thái',     rong: 12 },
  { key: 'so_tep',     ten: 'Số tệp',         rong: 8  },
];

const VIEN_MONG = {
  top:    { style: 'thin', color: { argb: 'FFD0D5DD' } },
  left:   { style: 'thin', color: { argb: 'FFD0D5DD' } },
  bottom: { style: 'thin', color: { argb: 'FFD0D5DD' } },
  right:  { style: 'thin', color: { argb: 'FFD0D5DD' } },
};

const ngay = (s) => {
  if (!s) return '';
  const d = new Date(s);
  return isNaN(d) ? String(s).slice(0, 10) : d.toLocaleDateString('vi-VN');
};

/**
 * @param {{project, phases}} cay  kết quả của project-export.dungCay()
 * @returns {Promise<Buffer>} nội dung file .xlsx
 */
async function taoWorkbook(cay) {
  const { project, phases } = cay;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'eSignFiles';
  wb.created = new Date();

  const ws = wb.addWorksheet('Danh mục hồ sơ', {
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
    views: [{ state: 'frozen', ySplit: 6 }],
  });

  ws.columns = COT.map(c => ({ key: c.key, width: c.rong }));
  const soCot = COT.length;
  const gopCaDong = (dong) => ws.mergeCells(dong, 1, dong, soCot);

  /* ── Tiêu đề ─────────────────────────────────────────── */
  ws.getCell('A1').value = 'DANH MỤC HỒ SƠ TRÌNH KÝ';
  ws.getCell('A1').font = { bold: true, size: 15 };
  ws.getCell('A1').alignment = { horizontal: 'center' };
  gopCaDong(1);

  ws.getCell('A2').value = `Dự án: ${project.ten_du_an}  (Mã: ${project.ma_du_an})`;
  ws.getCell('A2').font = { bold: true, size: 12 };
  ws.getCell('A2').alignment = { horizontal: 'center' };
  gopCaDong(2);

  const phu = [];
  if (project.chu_dau_tu) phu.push(`Chủ đầu tư: ${project.chu_dau_tu}`);
  phu.push(`Trạng thái: ${project.trang_thai}`);
  ws.getCell('A3').value = phu.join('     •     ');
  ws.getCell('A3').alignment = { horizontal: 'center' };
  ws.getCell('A3').font = { size: 10, color: { argb: 'FF667085' } };
  gopCaDong(3);

  ws.getCell('A4').value = `Kết xuất lúc ${new Date().toLocaleString('vi-VN')}`;
  ws.getCell('A4').alignment = { horizontal: 'center' };
  ws.getCell('A4').font = { size: 9, italic: true, color: { argb: 'FF98A2B3' } };
  gopCaDong(4);

  ws.addRow([]);   // dòng 5 để trống

  /* ── Tiêu đề cột (dòng 6) ────────────────────────────── */
  const dongTieuDe = ws.addRow(COT.map(c => c.ten));
  dongTieuDe.eachCell(c => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } };
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    c.border = VIEN_MONG;
  });
  dongTieuDe.height = 26;

  /* ── Thân bảng ───────────────────────────────────────── */
  let tongTaiLieu = 0, tongDaKy = 0, tongTep = 0;

  phases.forEach((gd, i) => {
    const soTaiLieuGD = gd.thuTucs.reduce((n, tt) => n + tt.taiLieu.length, 0);

    const dongGD = ws.addRow([`GIAI ĐOẠN ${i + 1}: ${gd.ten.toUpperCase()}   —   ${soTaiLieuGD} tài liệu`]);
    ws.mergeCells(dongGD.number, 1, dongGD.number, soCot);
    dongGD.getCell(1).font = { bold: true, size: 12, color: { argb: 'FF1D4ED8' } };
    dongGD.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } };
    dongGD.getCell(1).alignment = { vertical: 'middle' };
    dongGD.height = 22;
    for (let c = 1; c <= soCot; c++) dongGD.getCell(c).border = VIEN_MONG;

    gd.thuTucs.forEach((tt, j) => {
      const dongTT = ws.addRow([`${i + 1}.${j + 1}  ${tt.ten}   (${tt.taiLieu.length} tài liệu)`]);
      ws.mergeCells(dongTT.number, 1, dongTT.number, soCot);
      dongTT.getCell(1).font = { bold: true, italic: true, color: { argb: 'FF344054' } };
      dongTT.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F4F7' } };
      dongTT.getCell(1).alignment = { vertical: 'middle', indent: 1 };
      for (let c = 1; c <= soCot; c++) dongTT.getCell(c).border = VIEN_MONG;

      tt.taiLieu.forEach((d, k) => {
        const soTep = (d.file_url ? 1 : 0) + (d.signed_file_url ? 1 : 0) + d.attachments.length;
        tongTep += soTep;
        tongTaiLieu++;
        if (d.trang_thai === 'Đã ký') tongDaKy++;

        const r = ws.addRow({
          stt: k + 1,
          so_van_ban: d.so_van_ban || '',
          loai: d.loai_van_ban || d.loai_tai_lieu || '',
          ten: d.ten_tai_lieu || '',
          trich_yeu: d.trich_yeu || '',
          nguoi_tao: d.nguoi_tao_name || '',
          nguoi_ky: d.nguoi_ky_name || d.nguoi_duyet_name || '',
          ngay_tao: ngay(d.created_at),
          ngay_ky: ngay(d.ngay_ky),
          trang_thai: d.trang_thai || '',
          so_tep: soTep,
        });
        r.eachCell(c => {
          c.border = VIEN_MONG;
          c.alignment = { vertical: 'top', wrapText: true };
        });
        r.getCell('stt').alignment = { horizontal: 'center', vertical: 'top' };
        r.getCell('so_tep').alignment = { horizontal: 'center', vertical: 'top' };

        // Tô màu trạng thái để soát nhanh hồ sơ còn thiếu chữ ký
        const o = r.getCell('trang_thai');
        o.alignment = { horizontal: 'center', vertical: 'top' };
        if (d.trang_thai === 'Đã ký') o.font = { color: { argb: 'FF027A48' }, bold: true };
        else if (d.trang_thai === 'Từ chối') o.font = { color: { argb: 'FFB42318' }, bold: true };
        else o.font = { color: { argb: 'FFB54708' } };
      });
    });
  });

  /* ── Dòng tổng ───────────────────────────────────────── */
  ws.addRow([]);
  const tong = ws.addRow([
    `TỔNG CỘNG: ${tongTaiLieu} tài liệu  •  ${tongDaKy} đã ký  •  ${tongTaiLieu - tongDaKy} chưa ký  •  ${tongTep} tệp tin`,
  ]);
  ws.mergeCells(tong.number, 1, tong.number, soCot);
  tong.getCell(1).font = { bold: true, size: 11 };
  tong.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF0C7' } };
  tong.getCell(1).alignment = { horizontal: 'center' };
  tong.height = 22;

  if (tongTaiLieu === 0) {
    const trong = ws.addRow(['Dự án chưa có tài liệu nào trong sổ công văn.']);
    ws.mergeCells(trong.number, 1, trong.number, soCot);
    trong.getCell(1).alignment = { horizontal: 'center' };
    trong.getCell(1).font = { italic: true, color: { argb: 'FF98A2B3' } };
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { taoWorkbook };
