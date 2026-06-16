/* ═══════════════════════════════════════════════════════════
   GOOGLE SHEETS DATA — Ghi thông tin tài liệu vào sheet "Data"
   ─────────────────────────────────────────────────────────
   Sử dụng Google Apps Script Web App làm proxy ghi dữ liệu.
   Cấu hình: GAS_WEBAPP_URL = URL deploy của Apps Script
═══════════════════════════════════════════════════════════ */

const SHEET_ID = process.env.GOOGLE_SHEET_ID || '';
const GAS_WEBAPP_URL = process.env.GAS_WEBAPP_URL || '';
const DATA_SHEET_NAME = process.env.DATA_SHEET_NAME || 'Data';
const DATA_SHEET_GID = process.env.DATA_SHEET_GID || '1726022895';

function isConfigured() {
  return !!GAS_WEBAPP_URL;
}

async function appendDocumentRow(docInfo) {
  if (!isConfigured()) {
    console.warn('[sheets-data] GAS_WEBAPP_URL chưa cấu hình — bỏ qua ghi sheet Data. Set GAS_WEBAPP_URL env var trên Vercel Dashboard.');
    return false;
  }
  console.log('[sheets-data] Bắt đầu ghi row vào sheet Data cho:', docInfo.maDoc);

  const row = {
    action: 'append_data',
    sheetName: DATA_SHEET_NAME,
    data: {
      'Ngày tạo': docInfo.ngayTao || new Date().toISOString(),
      'Mã TL': docInfo.maDoc || '',
      'Tên TL': docInfo.tenTaiLieu || '',
      'Loại': docInfo.loaiTaiLieu || '',
      'Dự án': docInfo.tenDuAn || '',
      'Tên file': docInfo.tenFile || '',
      'File ID': docInfo.fileId || '',
      'URL': docInfo.fileUrl || '',
      'Kích thước': docInfo.fileSize || '',
      'Người tạo': docInfo.nguoiTao || '',
      'Trạng thái': docInfo.trangThai || 'Chờ ký',
      'Ghi chú': docInfo.ghiChu || '',
    },
  };

  try {
    const resp = await fetch(GAS_WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(row),
      redirect: 'follow',
    });
    if (!resp.ok) {
      console.error('[sheets-data] GAS append failed:', resp.status, await resp.text());
      return false;
    }
    const result = await resp.json().catch(() => ({}));
    console.log('[sheets-data] Đã ghi vào sheet Data:', docInfo.maDoc, result);
    return true;
  } catch (e) {
    console.error('[sheets-data] Lỗi ghi sheet Data:', e.message);
    return false;
  }
}

async function updateDocumentStatus(maDoc, updates) {
  if (!isConfigured()) {
    console.warn('[sheets-data] GAS_WEBAPP_URL chưa cấu hình — bỏ qua cập nhật sheet Data. Set GAS_WEBAPP_URL env var trên Vercel Dashboard.');
    return false;
  }
  console.log('[sheets-data] Bắt đầu cập nhật sheet Data cho:', maDoc, 'updates:', JSON.stringify(updates));

  try {
    const resp = await fetch(GAS_WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'update_data',
        sheetName: DATA_SHEET_NAME,
        maDoc,
        data: updates,
      }),
      redirect: 'follow',
    });
    if (!resp.ok) {
      console.error('[sheets-data] GAS update failed:', resp.status);
      return false;
    }
    console.log('[sheets-data] Cập nhật sheet Data:', maDoc, updates);
    return true;
  } catch (e) {
    console.error('[sheets-data] Lỗi cập nhật sheet Data:', e.message);
    return false;
  }
}

module.exports = { isConfigured, appendDocumentRow, updateDocumentStatus };
