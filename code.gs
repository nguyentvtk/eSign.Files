// =============================================================================
// ỨNG DỤNG KÝ TÀI LIỆU ĐIỆN TỬ - GOOGLE APPS SCRIPT BACKEND
// File: Code.gs
// Phiên bản: 2.0.0
// Mô tả: Backend chính xử lý kết nối Google Sheets, phân quyền, dữ liệu ký số
// =============================================================================


// -----------------------------------------------------------------------------
// PHẦN 1: CẤU HÌNH TOÀN CỤC (GLOBAL CONFIGURATION)
// -----------------------------------------------------------------------------

/**
 * ID của Google Spreadsheet chứa toàn bộ dữ liệu ứng dụng.
 * Cách lấy: Mở file Sheets → nhìn URL:
 * https://docs.google.com/spreadsheets/d/[SPREADSHEET_ID]/edit
 * Thay chuỗi bên dưới bằng ID thật của bạn.
 */
// [FIX] Thay placeholder bằng ID thật từ Google Sheets URL
const SPREADSHEET_ID = "1VdOy7h5YSF0xIYkw285qBIQot-eCNySXSCA4dNdPdWc";

/**
 * Tên các Sheet trong Spreadsheet.
 * Đặt là hằng số (const) để tránh lỗi đánh máy khi tham chiếu nhiều nơi.
 */
const SHEET_NAMES = {
  DATA       : "Data",        // Lưu tài liệu cần ký & lịch sử ký
  PHAN_QUYEN : "Phan_Quyen",  // Ma trận phân quyền theo vai trò
  NGUOI_DUNG : "Nguoi_Dung",  // Danh sách người dùng & thông tin tài khoản
};

/**
 * Cache đối tượng Spreadsheet để tránh gọi SpreadsheetApp nhiều lần
 * trong cùng một phiên thực thi (giảm quota API).
 * Dùng hàm getSpreadsheet() thay vì truy cập trực tiếp.
 */
let _spreadsheetCache = null;


// -----------------------------------------------------------------------------
// PHẦN 2: HÀM KHỞI TẠO & TIỆN ÍCH NỘI BỘ (INTERNAL HELPERS)
// -----------------------------------------------------------------------------

/**
 * Lấy đối tượng Spreadsheet (có cache).
 * Ném lỗi rõ ràng nếu ID chưa được cấu hình hoặc không tìm thấy file.
 *
 * @returns {GoogleAppsScript.Spreadsheet.Spreadsheet}
 * @throws {Error} Nếu SPREADSHEET_ID chưa thay thế hoặc file không tồn tại
 */
function getSpreadsheet() {
  if (_spreadsheetCache) return _spreadsheetCache;

  if (SPREADSHEET_ID === "YOUR_SPREADSHEET_ID_HERE") {
    throw new Error(
      "[Cấu hình] Vui lòng thay SPREADSHEET_ID trong Code.gs bằng ID thật của Google Sheets."
    );
  }

  try {
    _spreadsheetCache = SpreadsheetApp.openById(SPREADSHEET_ID);
    return _spreadsheetCache;
  } catch (err) {
    throw new Error(
      `[Kết nối] Không thể mở Spreadsheet với ID "${SPREADSHEET_ID}". ` +
      `Kiểm tra ID và quyền truy cập. Chi tiết: ${err.message}`
    );
  }
}

/**
 * Lấy đối tượng Sheet theo tên.
 *
 * @param {string} sheetName - Tên sheet cần lấy (dùng hằng SHEET_NAMES)
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 * @throws {Error} Nếu sheet không tồn tại trong Spreadsheet
 */
function getSheet(sheetName) {
  const ss    = getSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);

  if (!sheet) {
    throw new Error(
      `[Sheet] Không tìm thấy sheet "${sheetName}" trong Spreadsheet. ` +
      `Kiểm tra tên sheet (phân biệt chữ hoa/thường).`
    );
  }

  return sheet;
}


// -----------------------------------------------------------------------------
// PHẦN 3: HÀM ENTRY POINT - doGet(e)
// -----------------------------------------------------------------------------

/**
 * Điểm vào chính của WebApp khi người dùng truy cập URL.
 * Google Apps Script gọi hàm này tự động với mỗi HTTP GET request.
 *
 * Luồng xử lý:
 *   1. Nhận request (e.parameter có thể chứa query string)
 *   2. Tải file index.html từ project
 *   3. Trả về HtmlOutput để trình duyệt render
 *
 * @param {GoogleAppsScript.Events.DoGet} e - Đối tượng event của GET request
 * @returns {GoogleAppsScript.HTML.HtmlOutput}
 */
function doGet(e) {
  Logger.log("[doGet] Nhận request: " + JSON.stringify(e.parameter));

  // [VGCA] Worker gọi ?action=vgca_download&fileId=xxx → trả base64 PDF
  if (e.parameter.action === "vgca_download" && e.parameter.fileId) {
    try {
      const file = DriveApp.getFileById(e.parameter.fileId);
      const blob = file.getBlob();
      const b64  = Utilities.base64Encode(blob.getBytes());
      return ContentService.createTextOutput(b64).setMimeType(ContentService.MimeType.TEXT);
    } catch (err) {
      Logger.log("[doGet/vgca_download] Lỗi: " + err.message);
      return ContentService.createTextOutput("ERROR:" + err.message).setMimeType(ContentService.MimeType.TEXT);
    }
  }

  const htmlOutput = HtmlService
    .createHtmlOutputFromFile("index")
    .setTitle("Hệ Thống Ký Tài Liệu Điện Tử — eSign")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);

  return htmlOutput;
}

/**
 * [VGCA] FileUploadHandler — nhận PDF đã ký từ app VGCASignService POST về.
 * App VGCA POST multipart 'uploadfile'. GAS doPost xử lý multipart hạn chế,
 * nên hỗ trợ 2 kiểu: (a) form field base64 'filedata' + 'filename' + 'maTL'
 * (khuyến nghị cấu hình app gửi base64), (b) raw postData.
 * Trả JSON đúng hợp đồng tài liệu: {Status, Message, FileName, FileServer}.
 */
function doPost(e) {
  try {
    const p = (e && e.parameter) || {};
    const maTL = String(p.maTL || p.MaTL || p.DocNumber || "").trim();
    let blob = null, fileName = String(p.filename || p.FileName || "signed.pdf").trim();

    if (e && e.postData && /base64/i.test(p.encoding || "") && p.filedata) {
      blob = Utilities.newBlob(Utilities.base64Decode(p.filedata), "application/pdf", fileName);
    } else if (p.filedata) {
      blob = Utilities.newBlob(Utilities.base64Decode(p.filedata), "application/pdf", fileName);
    } else if (e && e.postData && e.postData.contents) {
      // Fallback: lưu nguyên contents (có thể là multipart thô — cần endpoint chuyên dụng để parse chuẩn)
      blob = Utilities.newBlob(e.postData.contents, "application/pdf", fileName);
    }

    if (!blob) {
      return ContentService.createTextOutput(JSON.stringify({
        Status: 1, Message: "Không nhận được dữ liệu file đã ký.", FileName: "", FileServer: ""
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // Lưu vào Drive (thư mục tài liệu đã ký) — dùng folder gốc cho gọn
    const folder = DriveApp.getRootFolder();
    const saved  = folder.createFile(blob);
    saved.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    const fileId = saved.getId();
    const url    = "ht" + "tps://drive.google.com/file/d/" + fileId + "/view";

    // Cập nhật trạng thái "Đã ký" theo Mã TL (nếu có)
    if (maTL) {
      try {
        const ctx = _readDataSheetContext();
        const found = _findDocByMaDoc(ctx, maTL);
        if (found && found.colMap[DATA_COLS.TRANG_THAI] !== undefined) {
          found.sheet.getRange(found.sheetRow, found.colMap[DATA_COLS.TRANG_THAI] + 1).setValue("Đã ký");
          if (found.colMap[DATA_COLS.FILE_URL] !== undefined)
            found.sheet.getRange(found.sheetRow, found.colMap[DATA_COLS.FILE_URL] + 1).setValue(url);
        }
      } catch (uErr) { Logger.log("[doPost] Cập nhật trạng thái lỗi: " + uErr.message); }
    }

    Logger.log("[doPost] ✅ Nhận file ký VGCA: " + fileId + " (Mã TL: " + maTL + ")");
    return ContentService.createTextOutput(JSON.stringify({
      Status: 0, Message: "", FileName: fileName, FileServer: url
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    Logger.log("[doPost] LỖI: " + err.message);
    return ContentService.createTextOutput(JSON.stringify({
      Status: 1, Message: String(err.message), FileName: "", FileServer: ""
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

/** [VGCA] Trả URL Web App (exec) để frontend dùng làm FileUploadHandler. */
function getWebAppUrl() {
  try { return { success: true, url: ScriptApp.getService().getUrl() }; }
  catch (e) { return { success: false, url: "", error: e.message }; }
}

/**
 * Hàm tiện ích: Nhúng nội dung file HTML khác vào index.html.
 * Dùng trong scriptlet: <?!= include('stylesheet') ?>
 *
 * @param {string} filename - Tên file HTML trong project (không cần .html)
 * @returns {string} Nội dung HTML dạng chuỗi
 */
function include(filename) {
  // QUAN TRỌNG: Phải dùng createTemplateFromFile().evaluate().getContent()
  // thay vì createHtmlOutputFromFile().getContent().
  //
  // Lý do: createHtmlOutputFromFile() SANITIZE HTML — tự động xóa các thẻ
  // <script> và <style> khỏi nội dung trả về. Kết quả là khi include
  // _javascript.html và _stylesheet.html vào index.html, các thẻ bao ngoài
  // bị mất → JS/CSS bị dump ra HTML không có wrapper tag → browser báo
  // "SyntaxError: Unexpected identifier https" (thấy JS code như text thô).
  //
  // createTemplateFromFile().evaluate().getContent() KHÔNG sanitize,
  // trả về raw content giữ nguyên <script> và <style> tags.
  return HtmlService.createTemplateFromFile(filename).evaluate().getContent();
}


// -----------------------------------------------------------------------------
// PHẦN 4: HÀM ĐỌC DỮ LIỆU TỔNG QUÁT (GENERIC DATA READER)
// -----------------------------------------------------------------------------

/**
 * ★ HÀM HELPER CHÍNH ★
 * Đọc toàn bộ dữ liệu từ một sheet và chuyển thành mảng JSON object.
 *
 * Quy ước: Hàng đầu tiên của sheet là HEADER (tên cột).
 * Mỗi hàng tiếp theo là một record, được map thành object với key là header.
 *
 * Ví dụ sheet "Nguoi_Dung":
 * ┌────────┬──────────┬───────┐
 * │ MaNV   │ HoTen    │ Email │  ← Hàng 1: Header
 * ├────────┼──────────┼───────┤
 * │ NV001  │ Nguyễn A │ a@... │  ← Hàng 2: Record 1
 * │ NV002  │ Trần B   │ b@... │  ← Hàng 3: Record 2
 * └────────┴──────────┴───────┘
 *
 * Kết quả trả về:
 * [
 *   { "MaNV": "NV001", "HoTen": "Nguyễn A", "Email": "a@..." },
 *   { "MaNV": "NV002", "HoTen": "Trần B",   "Email": "b@..." }
 * ]
 *
 * @param {string} sheetName - Tên sheet cần đọc (dùng hằng SHEET_NAMES)
 * @returns {{ success: boolean, data: Object[]|null, error: string|null, meta: Object }}
 *          Luôn trả về object bọc (wrapper) để frontend xử lý lỗi nhất quán
 */
function getSheetDataAsJson(sheetName) {
  try {
    const sheet = getSheet(sheetName);

    // Lấy toàn bộ dữ liệu có nội dung (tự động bỏ vùng trống cuối)
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();

    // Sheet rỗng hoặc chỉ có header
    if (lastRow < 2) {
      Logger.log(`[getSheetDataAsJson] Sheet "${sheetName}" không có dữ liệu (lastRow=${lastRow}).`);
      return _successResponse([], sheetName, 0);
    }

    // Đọc toàn bộ vùng dữ liệu một lần (tối ưu quota)
    const range  = sheet.getRange(1, 1, lastRow, lastCol);
    const values = range.getValues(); // Array 2D: [[header...], [row1...], [row2...]]

    // Hàng đầu tiên là headers → lấy và chuẩn hóa
    const headers = values[0].map(h => String(h).trim());

    // Validate: headers không được rỗng
    const validHeaders = headers.filter(h => h !== "");
    if (validHeaders.length === 0) {
      throw new Error(`Sheet "${sheetName}" có hàng đầu tiên rỗng (không tìm thấy header).`);
    }

    // Map từng hàng dữ liệu thành object
    const records = [];
    for (let rowIdx = 1; rowIdx < values.length; rowIdx++) {
      const row = values[rowIdx];

      // Bỏ qua hàng hoàn toàn rỗng
      const isEmptyRow = row.every(cell => cell === "" || cell === null || cell === undefined);
      if (isEmptyRow) continue;

      const record = {};
      headers.forEach((header, colIdx) => {
        if (header === "") return; // Bỏ cột không có header
        record[header] = _normalizeCell(row[colIdx]);
      });

      // Gắn thêm số thứ tự hàng gốc trong sheet (hữu ích khi cần update)
      record["_rowIndex"] = rowIdx + 1; // +1 vì index sheet bắt đầu từ 1

      records.push(record);
    }

    Logger.log(`[getSheetDataAsJson] Sheet "${sheetName}": đọc ${records.length} records.`);
    return _successResponse(records, sheetName, records.length);

  } catch (err) {
    Logger.log(`[getSheetDataAsJson] LỖI sheet "${sheetName}": ${err.message}`);
    return _errorResponse(err.message, sheetName);
  }
}


// -----------------------------------------------------------------------------
// PHẦN 5: HÀM ĐỌC DỮ LIỆU TỪNG SHEET CỤ THỂ (PUBLIC API CHO FRONTEND)
// -----------------------------------------------------------------------------

/**
 * Lấy toàn bộ dữ liệu tài liệu & lịch sử ký từ sheet "Data".
 * Frontend gọi qua: google.script.run.getDataSheet()
 *
 * @returns {Object} Wrapper response với data là mảng JSON
 */
function getDataSheet() {
  return getSheetDataAsJson(SHEET_NAMES.DATA);
}

/**
 * Lấy ma trận phân quyền từ sheet "Phan_Quyen".
 * Frontend gọi qua: google.script.run.getPhanQuyenSheet()
 *
 * @returns {Object} Wrapper response với data là mảng JSON
 */
function getPhanQuyenSheet() {
  return getSheetDataAsJson(SHEET_NAMES.PHAN_QUYEN);
}

/**
 * Lấy danh sách người dùng từ sheet "Nguoi_Dung".
 * Frontend gọi qua: google.script.run.getNguoiDungSheet()
 *
 * @returns {Object} Wrapper response với data là mảng JSON
 */
function getNguoiDungSheet() {
  return getSheetDataAsJson(SHEET_NAMES.NGUOI_DUNG);
}

/**
 * Hàm tổng hợp: Tải cả 3 sheet cùng lúc để giảm số lần round-trip.
 * Hữu ích khi frontend cần khởi tạo toàn bộ dữ liệu lúc load trang.
 * Frontend gọi qua: google.script.run.loadAllSheets()
 *
 * @returns {{ data: Object, phanQuyen: Object, nguoiDung: Object }}
 */
function loadAllSheets() {
  return {
    data       : getDataSheet(),
    phanQuyen  : getPhanQuyenSheet(),
    nguoiDung  : getNguoiDungSheet(),
  };
}


// -----------------------------------------------------------------------------
// PHẦN 6: HÀM KIỂM TRA KẾT NỐI (UTILITY - DÙNG ĐỂ DEBUG)
// -----------------------------------------------------------------------------

/**
 * Kiểm tra kết nối tới Spreadsheet và sự tồn tại của các sheet.
 * Chạy hàm này trong Apps Script Editor để xác nhận cấu hình đúng.
 *
 * @returns {Object} Kết quả kiểm tra từng sheet
 */
function testConnection() {
  const result = {
    spreadsheetId   : SPREADSHEET_ID,
    spreadsheetName : null,
    sheets          : {},
    timestamp       : new Date().toISOString(),
    overallStatus   : "OK",
  };

  try {
    const ss = getSpreadsheet();
    result.spreadsheetName = ss.getName();

    // Kiểm tra từng sheet
    Object.entries(SHEET_NAMES).forEach(([key, name]) => {
      try {
        const sheet   = getSheet(name);
        const lastRow = sheet.getLastRow();
        const lastCol = sheet.getLastColumn();
        result.sheets[name] = {
          status  : "✅ OK",
          rows    : lastRow,
          columns : lastCol,
          dataRows: Math.max(0, lastRow - 1), // Trừ hàng header
        };
      } catch (sheetErr) {
        result.sheets[name]  = { status: "❌ LỖI", error: sheetErr.message };
        result.overallStatus = "ERROR";
      }
    });

  } catch (ssErr) {
    result.overallStatus = "ERROR";
    result.error = ssErr.message;
  }

  Logger.log("[testConnection] Kết quả:\n" + JSON.stringify(result, null, 2));
  return result;
}


// -----------------------------------------------------------------------------
// PHẦN 7: HÀM NỘI BỘ - CHUẨN HÓA & ĐÓNG GÓI RESPONSE
// -----------------------------------------------------------------------------

/**
 * Chuẩn hóa giá trị ô: chuyển Date thành ISO string, trim chuỗi, giữ số.
 *
 * @param {*} cellValue - Giá trị thô từ getValues()
 * @returns {string|number|boolean|null}
 */
function _normalizeCell(cellValue) {
  if (cellValue instanceof Date) {
    // Chuyển Date → ISO 8601 string (frontend dễ parse)
    return cellValue.toISOString();
  }
  if (typeof cellValue === "string") {
    return cellValue.trim();
  }
  if (cellValue === "" || cellValue === null || cellValue === undefined) {
    return null;
  }
  return cellValue; // number, boolean giữ nguyên
}

/**
 * Tạo response thành công chuẩn hóa.
 *
 * @param {Object[]} data       - Mảng dữ liệu
 * @param {string}   sheetName  - Tên sheet nguồn
 * @param {number}   count      - Số bản ghi
 * @returns {Object}
 */
function _successResponse(data, sheetName, count) {
  return {
    success   : true,
    data      : data,
    error     : null,
    meta      : {
      sheet     : sheetName,
      count     : count,
      timestamp : new Date().toISOString(),
    },
  };
}

/**
 * Tạo response lỗi chuẩn hóa.
 *
 * @param {string} errorMessage - Thông báo lỗi
 * @param {string} sheetName    - Tên sheet gây lỗi
 * @returns {Object}
 */
function _errorResponse(errorMessage, sheetName) {
  return {
    success : false,
    data    : null,
    error   : errorMessage,
    meta    : {
      sheet     : sheetName,
      count     : 0,
      timestamp : new Date().toISOString(),
    },
  };
}


// =============================================================================
// MODULE XÁC THỰC NGƯỜI DÙNG (AUTHENTICATION MODULE)
// Thêm vào phiên bản 2.0.0
// =============================================================================


// -----------------------------------------------------------------------------
// PHẦN 8: HẰNG SỐ & CẤU HÌNH XÁC THỰC
// -----------------------------------------------------------------------------

/**
 * Tên chính xác các cột trong sheet "Nguoi_Dung".
 * Phải khớp 100% với header hàng đầu của sheet (kể cả dấu cách).
 *
 * Sheet layout:
 * | Mã NV | Họ tên | Email | Số điện thoại | Chức vụ | Phòng ban | Phân quyền | Mật khẩu | Hình đại diện |
 */
const COL = {
  MA_NV         : "Mã NV",
  HO_TEN        : "Họ tên",
  EMAIL         : "Email",
  SO_DIEN_THOAI : "Số điện thoại",
  CHUC_VU       : "Chức vụ",
  PHONG_BAN     : "Phòng ban",
  PHAN_QUYEN    : "Phân quyền",
  MAT_KHAU      : "Mật khẩu",
  HINH_DAI_DIEN : "Hình đại diện",
};

/**
 * Cấu hình phiên làm việc (Session).
 *
 * TOKEN_PREFIX   : Tiền tố key khi lưu vào CacheService (tránh va chạm key)
 * TOKEN_TTL_SEC  : Thời gian sống của token tính bằng giây
 *                  CacheService tối đa 21600s (6 giờ) — đây là hard limit của GAS
 * TOKEN_LENGTH   : Số byte ngẫu nhiên khi tạo token (32 byte → 64 ký tự hex)
 */
const SESSION_CONFIG = {
  TOKEN_PREFIX  : "esign_session_",
  TOKEN_TTL_SEC : 3600,    // 1 giờ (đổi thành 21600 nếu muốn 6 giờ)
  TOKEN_LENGTH  : 32,      // bytes → hex string dài 64 ký tự
};

/**
 * Các trường bị loại bỏ khi trả về thông tin user cho frontend.
 * Bao giờ cũng phải loại Mật khẩu; có thể thêm trường nhạy cảm khác.
 */
const SENSITIVE_FIELDS = [
  COL.MAT_KHAU,   // Không bao giờ gửi mật khẩu ra frontend
  "_rowIndex",    // Metadata nội bộ GAS, frontend không cần
];


// -----------------------------------------------------------------------------
// PHẦN 9: HÀM DANH SÁCH NGƯỜI DÙNG (PUBLIC API)
// -----------------------------------------------------------------------------

/**
 * Lấy danh sách người dùng (không bao gồm mật khẩu).
 *
 * Dùng cho màn hình quản trị người dùng.
 * Chỉ trả về khi token hợp lệ (kiểm tra phiên đăng nhập).
 *
 * Frontend gọi:
 *   google.script.run
 *     .withSuccessHandler(res => console.log(res))
 *     .getUserList(sessionToken);
 *
 * @param {string} sessionToken - Token phiên đăng nhập từ frontend
 * @returns {Object} Wrapper response chứa mảng user (không có mật khẩu)
 */
function getUserList(sessionToken) {
  // ── Xác thực phiên ──────────────────────────────────────────────────────────
  const session = _verifySession(sessionToken);
  if (!session.valid) {
    return _authErrorResponse("Phiên đăng nhập không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập lại.");
  }

  // ── Kiểm tra quyền: chỉ admin/quản lý mới xem được toàn bộ danh sách ───────
  const allowedRoles = ["Admin", "Quản lý"];
  if (!allowedRoles.includes(session.user[COL.PHAN_QUYEN])) {
    return _authErrorResponse(`Bạn không có quyền xem danh sách người dùng. Yêu cầu: ${allowedRoles.join(", ")}.`);
  }

  // ── Đọc dữ liệu ─────────────────────────────────────────────────────────────
  try {
    const result = getSheetDataAsJson(SHEET_NAMES.NGUOI_DUNG);
    if (!result.success) return result;

    // Loại bỏ trường nhạy cảm (mật khẩu) nhưng GIỮ LẠI _rowIndex để frontend
    // định danh đúng dòng khi Sửa/Xem/Xóa. (_sanitizeUser mặc định xóa _rowIndex
    // theo SENSITIVE_FIELDS → phải gắn lại; không lộ mật khẩu.)
    const sanitizedUsers = result.data.map(user => {
      const clean = _sanitizeUser(user);
      clean["_rowIndex"] = user["_rowIndex"];
      return clean;
    });

    Logger.log(`[getUserList] Trả về ${sanitizedUsers.length} người dùng cho "${session.user[COL.EMAIL]}".`);

    return {
      success : true,
      data    : sanitizedUsers,
      error   : null,
      meta    : {
        sheet     : SHEET_NAMES.NGUOI_DUNG,
        count     : sanitizedUsers.length,
        timestamp : new Date().toISOString(),
        requestBy : session.user[COL.EMAIL],
      },
    };
  } catch (err) {
    Logger.log(`[getUserList] Lỗi: ${err.message}`);
    return _authErrorResponse(err.message);
  }
}


// -----------------------------------------------------------------------------
// PHẦN 10: HÀM XÁC THỰC & QUẢN LÝ PHIÊN (AUTHENTICATION CORE)
// -----------------------------------------------------------------------------

/**
 * ★ HÀM ĐĂNG NHẬP CHÍNH ★
 *
 * Luồng xử lý:
 *   1. Validate đầu vào (email & password không rỗng)
 *   2. Tìm user theo Email trong sheet Nguoi_Dung
 *   3. So khớp mật khẩu (SHA-256 hash hoặc plaintext tuỳ cấu hình)
 *   4. Tạo session token ngẫu nhiên, lưu vào CacheService kèm thông tin user
 *   5. Trả về thông tin user (đã loại mật khẩu) + token
 *
 * ⚠️  LƯU Ý BẢO MẬT:
 *   - Mật khẩu lưu trong Sheets NÊN được hash SHA-256 trước khi lưu.
 *   - Hàm hỗ trợ cả 2 chế độ: hash (khuyến nghị) và plaintext (demo).
 *   - Đặt USE_HASHED_PASSWORD = true khi đưa vào production.
 *   - CacheService của GAS là server-side, không phải cookie browser.
 *   - Token không được lưu trên client (localStorage); frontend chỉ giữ trong
 *     bộ nhớ JS (biến) hoặc sessionStorage để tự xóa khi đóng tab.
 *
 * Frontend gọi:
 *   google.script.run
 *     .withSuccessHandler(handleLoginResult)
 *     .withFailureHandler(handleError)
 *     .login({ email: "a@b.com", password: "123456" });
 *
 * @param {{ email: string, password: string }} credentials - Thông tin đăng nhập
 * @returns {{
 *   success   : boolean,
 *   token     : string|null,
 *   user      : Object|null,
 *   error     : string|null,
 *   expiresAt : string|null
 * }}
 */
function login(credentials) {
  const USE_HASHED_PASSWORD = false; // ← Đổi thành true khi lưu hash trong Sheets

  // ── Bước 1: Validate đầu vào ─────────────────────────────────────────────────
  if (!credentials || typeof credentials !== "object") {
    return _loginError("Dữ liệu đăng nhập không hợp lệ.");
  }

  const email    = (credentials.email    || "").trim().toLowerCase();
  const password = (credentials.password || "").trim();

  if (!email || !password) {
    return _loginError("Email và mật khẩu không được để trống.");
  }

  if (!_isValidEmail(email)) {
    return _loginError("Định dạng email không hợp lệ.");
  }

  Logger.log(`[login] Yêu cầu đăng nhập: ${email}`);

  // ── Bước 2: Đọc sheet Nguoi_Dung & tìm user theo email ───────────────────────
  let allUsers;
  try {
    const result = getSheetDataAsJson(SHEET_NAMES.NGUOI_DUNG);
    if (!result.success) {
      return _loginError("Không thể đọc dữ liệu người dùng. Vui lòng thử lại.");
    }
    allUsers = result.data;
  } catch (err) {
    Logger.log(`[login] Lỗi đọc sheet: ${err.message}`);
    return _loginError("Lỗi hệ thống khi truy vấn dữ liệu.");
  }

  // Tìm user (so sánh email không phân biệt hoa/thường)
  const matchedUser = allUsers.find(
    u => (u[COL.EMAIL] || "").trim().toLowerCase() === email
  );

  if (!matchedUser) {
    // Không tiết lộ rằng email không tồn tại (tránh user enumeration attack)
    Logger.log(`[login] Không tìm thấy email: ${email}`);
    return _loginError("Email hoặc mật khẩu không chính xác.");
  }

  // ── Bước 3: Kiểm tra mật khẩu ───────────────────────────────────────────────
  const storedPassword = String(matchedUser[COL.MAT_KHAU] || "").trim();
  let passwordMatch    = false;

  if (USE_HASHED_PASSWORD) {
    // So sánh SHA-256: hash mật khẩu nhập vào rồi so với hash đã lưu
    const inputHash = _sha256(password);
    passwordMatch   = (inputHash === storedPassword);
    Logger.log(`[login] Chế độ HASH — inputHash: ${inputHash.substring(0, 8)}...`);
  } else {
    // So sánh plaintext (chỉ dùng cho môi trường demo/test)
    passwordMatch = (password === storedPassword);
    Logger.log("[login] Chế độ PLAINTEXT — chỉ dùng cho demo.");
  }

  if (!passwordMatch) {
    Logger.log(`[login] Sai mật khẩu cho email: ${email}`);
    return _loginError("Email hoặc mật khẩu không chính xác.");
  }

  // ── Bước 4: Tạo Session Token & lưu vào Cache ────────────────────────────────
  const token     = _generateToken();
  const expiresAt = new Date(Date.now() + SESSION_CONFIG.TOKEN_TTL_SEC * 1000).toISOString();

  // Dữ liệu user sạch (không mật khẩu) để lưu vào cache
  const safeUser = _sanitizeUser(matchedUser);

  // Payload lưu trong cache: thông tin user + metadata phiên
  const sessionPayload = {
    user      : safeUser,
    createdAt : new Date().toISOString(),
    expiresAt : expiresAt,
    email     : email,   // Dư phòng để verify nhanh
  };

  try {
    const cache    = CacheService.getScriptCache();
    const cacheKey = SESSION_CONFIG.TOKEN_PREFIX + token;

    cache.put(
      cacheKey,
      JSON.stringify(sessionPayload),
      SESSION_CONFIG.TOKEN_TTL_SEC
    );

    Logger.log(`[login] ✅ Đăng nhập thành công: ${email} | Token: ${token.substring(0, 8)}... | TTL: ${SESSION_CONFIG.TOKEN_TTL_SEC}s`);
  } catch (cacheErr) {
    Logger.log(`[login] Lỗi lưu cache: ${cacheErr.message}`);
    return _loginError("Không thể tạo phiên làm việc. Vui lòng thử lại.");
  }

  // ── Bước 5: Trả về kết quả đăng nhập ─────────────────────────────────────────
  return {
    success   : true,
    token     : token,
    user      : safeUser,
    error     : null,
    expiresAt : expiresAt,
    ttlSeconds: SESSION_CONFIG.TOKEN_TTL_SEC,
  };
}

/**
 * Đăng xuất: Xóa token khỏi CacheService ngay lập tức.
 *
 * Frontend gọi:
 *   google.script.run
 *     .withSuccessHandler(() => redirectToLogin())
 *     .logout(sessionToken);
 *
 * @param {string} sessionToken - Token cần hủy
 * @returns {{ success: boolean, message: string }}
 */
function logout(sessionToken) {
  if (!sessionToken) {
    return { success: false, message: "Token không hợp lệ." };
  }

  try {
    const cache    = CacheService.getScriptCache();
    const cacheKey = SESSION_CONFIG.TOKEN_PREFIX + sessionToken;
    cache.remove(cacheKey);

    Logger.log(`[logout] ✅ Đã xóa token: ${sessionToken.substring(0, 8)}...`);
    return { success: true, message: "Đã đăng xuất thành công." };
  } catch (err) {
    Logger.log(`[logout] Lỗi: ${err.message}`);
    return { success: false, message: "Lỗi khi đăng xuất." };
  }
}

/**
 * Kiểm tra token có hợp lệ không và trả về thông tin user hiện tại.
 * Dùng khi frontend cần refresh lại trạng thái đăng nhập (F5, mở lại tab).
 *
 * Frontend gọi:
 *   google.script.run
 *     .withSuccessHandler(res => { if (res.valid) updateUI(res.user); })
 *     .validateSession(token);
 *
 * @param {string} token - Session token cần kiểm tra
 * @returns {{ valid: boolean, user: Object|null, expiresAt: string|null, error: string|null }}
 */
function validateSession(token) {
  const session = _verifySession(token);

  if (!session.valid) {
    return {
      valid     : false,
      user      : null,
      expiresAt : null,
      error     : "Phiên đăng nhập không hợp lệ hoặc đã hết hạn.",
    };
  }

  return {
    valid     : true,
    user      : session.user,
    expiresAt : session.expiresAt,
    error     : null,
  };
}

/**
 * Gia hạn token: Đọc session cũ → tạo token mới → xóa token cũ.
 * Gọi trước khi token hết hạn (ví dụ: còn 5 phút thì gọi refresh).
 *
 * Frontend gọi:
 *   google.script.run
 *     .withSuccessHandler(res => { if (res.success) saveNewToken(res.token); })
 *     .refreshSession(oldToken);
 *
 * @param {string} oldToken - Token hiện tại cần gia hạn
 * @returns {{ success: boolean, token: string|null, expiresAt: string|null, error: string|null }}
 */
function refreshSession(oldToken) {
  const session = _verifySession(oldToken);

  if (!session.valid) {
    return { success: false, token: null, expiresAt: null, error: "Token gốc đã hết hạn, cần đăng nhập lại." };
  }

  // Tạo token mới
  const newToken  = _generateToken();
  const expiresAt = new Date(Date.now() + SESSION_CONFIG.TOKEN_TTL_SEC * 1000).toISOString();

  const newPayload = {
    user      : session.user,
    createdAt : new Date().toISOString(),
    expiresAt : expiresAt,
    email     : session.user[COL.EMAIL],
  };

  try {
    const cache      = CacheService.getScriptCache();
    const newKey     = SESSION_CONFIG.TOKEN_PREFIX + newToken;
    const oldKey     = SESSION_CONFIG.TOKEN_PREFIX + oldToken;

    cache.put(newKey, JSON.stringify(newPayload), SESSION_CONFIG.TOKEN_TTL_SEC);
    cache.remove(oldKey); // Hủy token cũ ngay

    Logger.log(`[refreshSession] ✅ Gia hạn thành công: ${session.user[COL.EMAIL]} | NewToken: ${newToken.substring(0, 8)}...`);
    return { success: true, token: newToken, expiresAt: expiresAt, error: null };
  } catch (err) {
    Logger.log(`[refreshSession] Lỗi cache: ${err.message}`);
    return { success: false, token: null, expiresAt: null, error: "Lỗi gia hạn phiên." };
  }
}


// -----------------------------------------------------------------------------
// PHẦN 11: HÀM NỘI BỘ - XÁC THỰC & BẢO MẬT (PRIVATE HELPERS)
// -----------------------------------------------------------------------------

/**
 * Xác minh token từ CacheService.
 * Trả về thông tin session nếu hợp lệ, { valid: false } nếu không.
 *
 * @param {string} token - Token cần kiểm tra
 * @returns {{ valid: boolean, user: Object|null, expiresAt: string|null }}
 */
function _verifySession(token) {
  if (!token || typeof token !== "string" || token.trim() === "") {
    return { valid: false, user: null, expiresAt: null };
  }

  try {
    const cache    = CacheService.getScriptCache();
    const cacheKey = SESSION_CONFIG.TOKEN_PREFIX + token.trim();
    const raw      = cache.get(cacheKey);

    if (!raw) {
      Logger.log(`[_verifySession] Token không tìm thấy trong cache: ${token.substring(0, 8)}...`);
      return { valid: false, user: null, expiresAt: null };
    }

    const payload = JSON.parse(raw);

    // Kiểm tra thêm thời gian hết hạn (phòng trường hợp cache TTL chưa kick)
    if (payload.expiresAt && new Date(payload.expiresAt) < new Date()) {
      cache.remove(cacheKey);
      Logger.log(`[_verifySession] Token đã hết hạn: ${token.substring(0, 8)}...`);
      return { valid: false, user: null, expiresAt: null };
    }

    return { valid: true, user: payload.user, expiresAt: payload.expiresAt };

  } catch (err) {
    Logger.log(`[_verifySession] Lỗi kiểm tra cache: ${err.message}`);
    return { valid: false, user: null, expiresAt: null };
  }
}

/**
 * Tạo token ngẫu nhiên dạng hex string.
 *
 * GAS không có crypto.getRandomValues(), nên dùng Utilities.getUuid()
 * kết hợp timestamp để tăng entropy. Đủ an toàn cho WebApp nội bộ.
 * Nếu cần security cao hơn: ghép nhiều UUID + hash SHA-256.
 *
 * @returns {string} Token hex 64 ký tự (hoặc UUID-based 72+ ký tự)
 */
function _generateToken() {
  // 2 UUID (mỗi cái 36 ký tự) + timestamp → đủ entropy cho session nội bộ
  const part1    = Utilities.getUuid().replace(/-/g, ""); // 32 hex chars
  const part2    = Utilities.getUuid().replace(/-/g, ""); // 32 hex chars
  const timePart = Date.now().toString(16);               // ~11 hex chars
  return part1 + part2 + timePart;                        // ~75 hex chars
}

/**
 * Tính SHA-256 của một chuỗi, trả về hex string.
 * Dùng để so sánh mật khẩu khi USE_HASHED_PASSWORD = true.
 *
 * @param {string} input - Chuỗi cần hash (mật khẩu plaintext từ form)
 * @returns {string} SHA-256 hex string (64 ký tự)
 */
function _sha256(input) {
  const bytes  = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    input,
    Utilities.Charset.UTF_8
  );
  // Chuyển byte array → hex string, đảm bảo mỗi byte là 2 ký tự hex
  return bytes.map(b => ("0" + (b & 0xFF).toString(16)).slice(-2)).join("");
}

/**
 * Loại bỏ các trường nhạy cảm khỏi object user trước khi gửi ra ngoài.
 * Luôn gọi hàm này trước khi trả user về frontend hoặc lưu vào cache.
 *
 * @param {Object} user - Object user thô từ sheet (có mật khẩu)
 * @returns {Object} User sạch (không có mật khẩu và metadata nội bộ)
 */
function _sanitizeUser(user) {
  const clean = Object.assign({}, user); // Shallow copy, không mutate bản gốc
  SENSITIVE_FIELDS.forEach(field => delete clean[field]);
  return clean;
}

/**
 * Validate định dạng email đơn giản (không dùng regex phức tạp).
 *
 * @param {string} email - Email cần kiểm tra
 * @returns {boolean}
 */
function _isValidEmail(email) {
  return typeof email === "string"
    && email.includes("@")
    && email.includes(".")
    && email.length >= 5
    && email.length <= 254;
}

/**
 * Tạo response lỗi đăng nhập chuẩn hóa.
 *
 * @param {string} message - Thông báo lỗi hiển thị cho user
 * @returns {Object}
 */
function _loginError(message) {
  return {
    success   : false,
    token     : null,
    user      : null,
    error     : message,
    expiresAt : null,
  };
}

/**
 * Tạo response lỗi xác thực/phân quyền chuẩn hóa.
 *
 * @param {string} message - Thông báo lỗi
 * @returns {Object}
 */
function _authErrorResponse(message) {
  return {
    success : false,
    data    : null,
    error   : message,
    meta    : {
      sheet     : SHEET_NAMES.NGUOI_DUNG,
      count     : 0,
      timestamp : new Date().toISOString(),
    },
  };
}


// -----------------------------------------------------------------------------
// PHẦN 12: HÀM TIỆN ÍCH - DEBUG & TEST XÁC THỰC
// -----------------------------------------------------------------------------

/**
 * Test thủ công luồng đăng nhập → lấy danh sách → đăng xuất.
 * Chạy trong Apps Script Editor để xác nhận toàn bộ module hoạt động.
 * KHÔNG deploy hàm này ra production (chỉ dùng nội bộ editor).
 */
function testAuthFlow() {
  Logger.log("=== BẮT ĐẦU TEST AUTH FLOW ===\n");

  // ── Test 1: Đăng nhập sai mật khẩu ─────────────────────────────────────────
  Logger.log("--- Test 1: Đăng nhập sai mật khẩu ---");
  const failResult = login({ email: "test@example.com", password: "wrongpassword" });
  Logger.log("Kết quả: " + JSON.stringify(failResult));
  Logger.log("✅ Đúng nếu success=false\n");

  // ── Test 2: Đăng nhập thiếu email ───────────────────────────────────────────
  Logger.log("--- Test 2: Đăng nhập thiếu email ---");
  const emptyResult = login({ email: "", password: "123456" });
  Logger.log("Kết quả: " + JSON.stringify(emptyResult));
  Logger.log("✅ Đúng nếu success=false, error về trống\n");

  // ── Test 3: Validate session với token giả ────────────────────────────────
  Logger.log("--- Test 3: Validate token giả ---");
  const fakeValidate = validateSession("fake_token_12345");
  Logger.log("Kết quả: " + JSON.stringify(fakeValidate));
  Logger.log("✅ Đúng nếu valid=false\n");

  // ── Test 4: Test _sha256 ────────────────────────────────────────────────────
  Logger.log("--- Test 4: SHA-256 hash ---");
  const hash = _sha256("matkhau_demo_123");
  Logger.log(`SHA-256 của "matkhau_demo_123": ${hash}`);
  Logger.log(`Độ dài: ${hash.length} ký tự (phải là 64)\n`);

  // ── Test 5: Test _generateToken ─────────────────────────────────────────────
  Logger.log("--- Test 5: Generate token ---");
  const token1 = _generateToken();
  const token2 = _generateToken();
  Logger.log(`Token 1: ${token1}`);
  Logger.log(`Token 2: ${token2}`);
  Logger.log(`Unique: ${token1 !== token2 ? "✅ Có" : "❌ TRÙNG (lỗi!)"}\n`);

  Logger.log("=== KẾT THÚC TEST AUTH FLOW ===");
}

/**
 * Hàm tiện ích: Hash mật khẩu để lưu vào Sheets (dùng 1 lần khi setup).
 * Chạy trong Editor, copy kết quả hash vào cột "Mật khẩu" của sheet.
 *
 * Ví dụ: hashPasswordForSetup("matkhau123") → copy hash vào Sheets
 *
 * @param {string} plainPassword - Mật khẩu plaintext cần hash
 */
function hashPasswordForSetup(plainPassword) {
  if (!plainPassword) {
    Logger.log("⚠️  Vui lòng truyền mật khẩu vào hàm.");
    return;
  }
  const hash = _sha256(plainPassword);
  Logger.log(`Mật khẩu gốc : "${plainPassword}"`);
  Logger.log(`SHA-256 hash  : ${hash}`);
  Logger.log(`→ Copy hash này vào cột "Mật khẩu" trong sheet Nguoi_Dung.`);
}


// =============================================================================
// MODULE PHÂN QUYỀN (PERMISSION MODULE)
// Thêm vào phiên bản 3.0.0
// =============================================================================


// -----------------------------------------------------------------------------
// PHẦN 13: HẰNG SỐ CẤU HÌNH PHÂN QUYỀN
// -----------------------------------------------------------------------------

/**
 * Tên chính xác các cột trong sheet "Phan_Quyen".
 * Phải khớp 100% với header hàng đầu của sheet.
 *
 * Sheet layout:
 * | Nội dung              | Admin | Quản lý | Người dùng |
 * |-----------------------|-------|---------|------------|
 * | Bảng điều khiển       | TRUE  | TRUE    | TRUE       |
 * | Quản lý người dùng    | TRUE  | FALSE   | FALSE      |
 * | ...                   | ...   | ...     | ...        |
 */
const PERM_COL = {
  NOI_DUNG    : "Nội dung",
  ADMIN       : "Admin",
  QUAN_LY     : "Quản lý",
  NGUOI_DUNG  : "Người dùng",
};

/**
 * Danh sách vai trò hợp lệ trong hệ thống.
 * Phải khớp với giá trị trong cột "Phân quyền" của sheet Nguoi_Dung
 * VÀ với tên cột trong sheet Phan_Quyen.
 */
const VALID_ROLES = [
  PERM_COL.ADMIN,
  PERM_COL.QUAN_LY,
  PERM_COL.NGUOI_DUNG,
];

/**
 * Cache nội bộ cấu hình phân quyền trong phiên thực thi GAS.
 * Tránh đọc sheet Phan_Quyen nhiều lần trong cùng một request.
 */
let _permConfigCache = null;


// -----------------------------------------------------------------------------
// PHẦN 14: HÀM LẤY CẤU HÌNH PHÂN QUYỀN (PUBLIC API CHO FRONTEND)
// -----------------------------------------------------------------------------

/**
 * Lấy toàn bộ cấu hình phân quyền từ sheet "Phan_Quyen" và trả về
 * dạng mảng JSON để frontend xây dựng ma trận kiểm tra quyền.
 *
 * Response shape:
 * {
 *   success: true,
 *   data: [
 *     { "Nội dung": "Bảng điều khiển", "Admin": true, "Quản lý": true, "Người dùng": true },
 *     { "Nội dung": "Quản lý người dùng", "Admin": true, "Quản lý": false, "Người dùng": false },
 *     ...
 *   ],
 *   error: null,
 *   meta: { sheet: "Phan_Quyen", count: N, timestamp: "..." }
 * }
 *
 * Frontend gọi qua:
 *   google.script.run
 *     .withSuccessHandler(res => buildPermMatrix(res.data))
 *     .getPhanQuyenConfig();
 *
 * KHÔNG yêu cầu session token vì:
 *   - Dữ liệu quyền không nhạy cảm (chỉ là TRUE/FALSE)
 *   - Frontend cần biết quyền để ẩn/hiện menu TRƯỚC khi gọi các API khác
 *   - Việc kiểm tra quyền thực sự (enforce) phải luôn xảy ra ở BACKEND
 *
 * @returns {{ success: boolean, data: Object[]|null, error: string|null, meta: Object }}
 */
function getPhanQuyenConfig() {
  // Dùng cache nội bộ nếu đã đọc trong phiên thực thi này
  if (_permConfigCache) {
    Logger.log("[getPhanQuyenConfig] Dùng cache nội bộ.");
    return _permConfigCache;
  }

  try {
    const sheet   = getSheet(SHEET_NAMES.PHAN_QUYEN);
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();

    if (lastRow < 2) {
      Logger.log("[getPhanQuyenConfig] Sheet Phan_Quyen trống.");
      return _successResponse([], SHEET_NAMES.PHAN_QUYEN, 0);
    }

    const values  = sheet.getRange(1, 1, lastRow, lastCol).getValues();
    const headers = values[0].map(h => String(h).trim());

    // Validate: phải có đủ cột bắt buộc
    const missingCols = Object.values(PERM_COL).filter(col => !headers.includes(col));
    if (missingCols.length > 0) {
      throw new Error(
        `Sheet "Phan_Quyen" thiếu cột: ${missingCols.join(", ")}. ` +
        `Kiểm tra tên header (phân biệt dấu tiếng Việt).`
      );
    }

    // Index của từng cột để đọc nhanh (tránh indexOf trong vòng lặp)
    const colIdx = {};
    Object.values(PERM_COL).forEach(col => {
      colIdx[col] = headers.indexOf(col);
    });

    // Map từng hàng thành object chuẩn hóa
    const records = [];
    for (let r = 1; r < values.length; r++) {
      const row     = values[r];
      const noiDung = String(row[colIdx[PERM_COL.NOI_DUNG]] ?? "").trim();

      // Bỏ hàng rỗng hoặc hàng không có Nội dung
      if (!noiDung) continue;

      const record = {
        [PERM_COL.NOI_DUNG]   : noiDung,
        [PERM_COL.ADMIN]      : _parseBool(row[colIdx[PERM_COL.ADMIN]]),
        [PERM_COL.QUAN_LY]    : _parseBool(row[colIdx[PERM_COL.QUAN_LY]]),
        [PERM_COL.NGUOI_DUNG] : _parseBool(row[colIdx[PERM_COL.NGUOI_DUNG]]),
      };

      records.push(record);
    }

    Logger.log(`[getPhanQuyenConfig] Đọc ${records.length} tính năng từ sheet Phan_Quyen.`);

    // Lưu vào cache nội bộ
    _permConfigCache = _successResponse(records, SHEET_NAMES.PHAN_QUYEN, records.length);
    return _permConfigCache;

  } catch (err) {
    Logger.log(`[getPhanQuyenConfig] LỖI: ${err.message}`);
    return _errorResponse(err.message, SHEET_NAMES.PHAN_QUYEN);
  }
}

/**
 * Ghi đè cấu hình phân quyền vào sheet Phan_Quyen từ ma trận do UI gửi lên.
 *
 * @param {string} sessionToken
 * @param {Array<{'Nội dung':string,'Admin':boolean,'Quản lý':boolean,'Người dùng':boolean}>} records
 * @returns {{success:boolean, error:string|null}}
 */
function savePhanQuyenConfig(sessionToken, records) {
  const auth = requirePermission(sessionToken, "Quản lý phân quyền");
  if (!auth.allowed) return _buildResponse(false, null, auth.error, "PERM_SAVE_UNAUTHORIZED");

  if (!Array.isArray(records) || !records.length) {
    return _buildResponse(false, null, "Dữ liệu phân quyền rỗng.", "PERM_SAVE_NO_DATA");
  }

  try {
    const sheet = getSheet(SHEET_NAMES.PHAN_QUYEN);
    const header = [PERM_COL.NOI_DUNG, PERM_COL.ADMIN, PERM_COL.QUAN_LY, PERM_COL.NGUOI_DUNG];

    const rows = records
      .filter(r => String(r[PERM_COL.NOI_DUNG] ?? "").trim())
      .map(r => [
        String(r[PERM_COL.NOI_DUNG]).trim(),
        r[PERM_COL.ADMIN]      === true ? "TRUE" : "FALSE",
        r[PERM_COL.QUAN_LY]    === true ? "TRUE" : "FALSE",
        r[PERM_COL.NGUOI_DUNG] === true ? "TRUE" : "FALSE",
      ]);

    // Xóa nội dung cũ rồi ghi lại header + toàn bộ rows
    sheet.clearContents();
    const all = [header].concat(rows);
    sheet.getRange(1, 1, all.length, 4).setValues(all);

    _permConfigCache = null;  // Xóa cache nội bộ để lần đọc sau lấy dữ liệu mới
    Logger.log(`[savePhanQuyenConfig] ✅ Đã ghi ${rows.length} tính năng bởi ${auth.role}.`);
    return _buildResponse(true, { count: rows.length }, null, "PERM_SAVE_SUCCESS");

  } catch (err) {
    Logger.log(`[savePhanQuyenConfig] LỖI: ${err.message}`);
    return _buildResponse(false, null, `Lỗi ghi sheet Phan_Quyen: ${err.message}`, "PERM_SAVE_ERROR");
  }
}


// -----------------------------------------------------------------------------
// PHẦN 15: HÀM KIỂM TRA QUYỀN PHÍA SERVER (SERVER-SIDE ENFORCEMENT)
// -----------------------------------------------------------------------------

/**
 * ★ QUAN TRỌNG: Kiểm tra quyền phía SERVER ★
 *
 * Client-side checkPermission() chỉ là UX (ẩn/hiện UI).
 * Mọi API quan trọng PHẢI gọi hàm này trước khi thực thi.
 * Đây là lớp bảo vệ thực sự — không thể bypass từ browser.
 *
 * Sử dụng:
 *   // Trong bất kỳ hàm API nào
 *   function deleteDocument(sessionToken, docId) {
 *     const authCheck = requirePermission(sessionToken, "Xóa tài liệu");
 *     if (!authCheck.allowed) return authCheck; // { success: false, error: "..." }
 *     // ... tiến hành xóa
 *   }
 *
 * @param {string} sessionToken - Token phiên đăng nhập của user
 * @param {string} featureName  - Tên tính năng cần kiểm tra (khớp cột "Nội dung")
 * @returns {{ allowed: boolean, role: string|null, error: string|null }}
 */
function requirePermission(sessionToken, featureName) {
  // 1. Verify session
  const session = _verifySession(sessionToken);
  if (!session.valid) {
    return {
      allowed : false,
      role    : null,
      error   : "Phiên đăng nhập không hợp lệ hoặc đã hết hạn.",
    };
  }

  const userRole = session.user[COL.PHAN_QUYEN] || "";

  // [FIX Lỗi #2 — SERVER SAFETY NET] Admin = superuser.
  // Khớp với safety-net phía client: nếu sheet Phan_Quyen thiếu/sai dòng,
  // Admin vẫn được phép mọi tính năng (tránh khóa sạch hệ thống).
  // Các vai trò khác vẫn bị enforce nghiêm ngặt theo sheet (deny-by-default).
  if (String(userRole).trim().toLowerCase() === "admin") {
    Logger.log(`[requirePermission] Admin superuser bypass → feature "${featureName}" ✅ ĐƯỢC PHÉP.`);
    return { allowed: true, role: userRole, error: null };
  }

  // 2. Lấy config phân quyền
  const config = getPhanQuyenConfig();
  if (!config.success) {
    Logger.log(`[requirePermission] Không load được Phan_Quyen: ${config.error}`);
    return {
      allowed : false,
      role    : userRole,
      error   : "Không thể tải cấu hình phân quyền. Vui lòng thử lại.",
    };
  }

  // 3. Tìm record của feature này
  const featureRow = config.data.find(
    row => row[PERM_COL.NOI_DUNG].toLowerCase() === featureName.trim().toLowerCase()
  );

  if (!featureRow) {
    Logger.log(`[requirePermission] Không tìm thấy feature "${featureName}" trong Phan_Quyen.`);
    return {
      allowed : false,
      role    : userRole,
      error   : `Tính năng "${featureName}" chưa được cấu hình phân quyền.`,
    };
  }

  // 4. Kiểm tra quyền theo vai trò
  const allowed = featureRow[userRole] === true;

  Logger.log(
    `[requirePermission] User "${session.user[COL.EMAIL]}" (${userRole}) ` +
    `→ feature "${featureName}": ${allowed ? "✅ ĐƯỢC PHÉP" : "❌ BỊ TỪ CHỐI"}`
  );

  return {
    allowed : allowed,
    role    : userRole,
    error   : allowed ? null : `Vai trò "${userRole}" không có quyền thực hiện "${featureName}".`,
  };
}


// -----------------------------------------------------------------------------
// PHẦN 16: HÀM TIỆN ÍCH PHÂN QUYỀN
// -----------------------------------------------------------------------------

/**
 * Chuyển đổi giá trị ô sang boolean.
 * Sheets lưu TRUE/FALSE dạng boolean hoặc string "TRUE"/"FALSE".
 *
 * @param {*} value - Giá trị thô từ getValues()
 * @returns {boolean}
 */
function _parseBool(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string")  return value.trim().toUpperCase() === "TRUE";
  return false;
}

/**
 * Lấy danh sách tất cả tính năng mà một vai trò cụ thể được phép thực hiện.
 * Hữu ích để debug hoặc hiển thị tóm tắt quyền.
 *
 * Frontend gọi:
 *   google.script.run.getPermissionsForRole(token, "Quản lý")
 *
 * @param {string} sessionToken - Token phiên (yêu cầu quyền Admin)
 * @param {string} roleName     - Tên vai trò cần xem quyền
 * @returns {Object} Danh sách features được phép / không được phép
 */
function getPermissionsForRole(sessionToken, roleName) {
  // Chỉ Admin mới được xem cấu hình quyền của người khác
  const authCheck = requirePermission(sessionToken, "Quản lý phân quyền");
  if (!authCheck.allowed) {
    return _authErrorResponse(authCheck.error);
  }

  if (!VALID_ROLES.includes(roleName)) {
    return _authErrorResponse(`Vai trò "${roleName}" không hợp lệ. Vai trò hợp lệ: ${VALID_ROLES.join(", ")}.`);
  }

  const config = getPhanQuyenConfig();
  if (!config.success) return config;

  const allowed  = [];
  const denied   = [];

  config.data.forEach(row => {
    const feature = row[PERM_COL.NOI_DUNG];
    const perm    = row[roleName] === true;
    (perm ? allowed : denied).push(feature);
  });

  Logger.log(`[getPermissionsForRole] Vai trò "${roleName}": ${allowed.length} được phép, ${denied.length} bị từ chối.`);

  return {
    success  : true,
    data     : { role: roleName, allowed, denied },
    error    : null,
    meta     : { timestamp: new Date().toISOString() },
  };
}

/**
 * Xóa cache phân quyền nội bộ (script cache).
 * Gọi sau khi Admin cập nhật sheet Phan_Quyen để buộc reload.
 * Frontend gọi: google.script.run.invalidatePermissionCache(token)
 *
 * @param {string} sessionToken - Token phiên (yêu cầu quyền Admin)
 * @returns {Object}
 */
function invalidatePermissionCache(sessionToken) {
  const authCheck = requirePermission(sessionToken, "Quản lý phân quyền");
  if (!authCheck.allowed) return _authErrorResponse(authCheck.error);

  _permConfigCache = null;
  Logger.log("[invalidatePermissionCache] ✅ Cache phân quyền đã được xóa.");
  return { success: true, message: "Cache phân quyền đã được làm mới." };
}

/**
 * Test toàn bộ module phân quyền.
 * Chạy trong Apps Script Editor để xác nhận cấu hình đúng.
 */
function testPermissionModule() {
  Logger.log("=== BẮT ĐẦU TEST PERMISSION MODULE ===\n");
  _permConfigCache = null; // Reset cache trước khi test

  // Test 1: Load config
  Logger.log("--- Test 1: getPhanQuyenConfig() ---");
  const config = getPhanQuyenConfig();
  Logger.log(`success: ${config.success}`);
  Logger.log(`Số features: ${config.meta?.count}`);
  if (config.data) {
    config.data.forEach(row => {
      Logger.log(`  → "${row["Nội dung"]}": Admin=${row["Admin"]}, QL=${row["Quản lý"]}, ND=${row["Người dùng"]}`);
    });
  }
  Logger.log("✅ Đúng nếu success=true và có dữ liệu\n");

  // Test 2: _parseBool
  Logger.log("--- Test 2: _parseBool() ---");
  Logger.log(`true  → ${_parseBool(true)}`);
  Logger.log(`false → ${_parseBool(false)}`);
  Logger.log(`"TRUE" → ${_parseBool("TRUE")}`);
  Logger.log(`"FALSE" → ${_parseBool("FALSE")}`);
  Logger.log(`"true" → ${_parseBool("true")}`);
  Logger.log(`0 → ${_parseBool(0)}\n`);

  // Test 3: requirePermission với token giả
  Logger.log("--- Test 3: requirePermission() với token giả ---");
  const fakeCheck = requirePermission("invalid_token", "Bảng điều khiển");
  Logger.log(`allowed: ${fakeCheck.allowed} (phải là false)`);
  Logger.log(`error: ${fakeCheck.error}\n`);

  Logger.log("=== KẾT THÚC TEST PERMISSION MODULE ===");
}


// =============================================================================
// MODULE CRUD NGƯỜI DÙNG — PHIÊN BẢN 5.0  (Thay thế v4.0)
// Đặc điểm:
//   ① Tìm dòng theo Mã NV hoặc Email — không phụ thuộc _rowIndex dễ lỗi
//   ② Đọc header động — an toàn khi thứ tự cột thay đổi
//   ③ Chuẩn hóa từng loại dữ liệu trước khi ghi (số điện thoại, email, …)
//   ④ Lớp validation đầy đủ + audit log mỗi thao tác
//   ⑤ Mọi hàm công khai đều qua requirePermission() — không thể bypass
// =============================================================================


// -----------------------------------------------------------------------------
// PHẦN 17: CẤU HÌNH CỘT SHEET NGUOI_DUNG
// -----------------------------------------------------------------------------

/**
 * Thứ tự cột CHUẨN của sheet Nguoi_Dung.
 * Mảng này là nguồn sự thật duy nhất — thay đổi ở đây là đủ nếu sheet thay đổi.
 *
 * Sheet layout:
 * Col A      B        C       D                E        F          G           H          I
 * Mã NV | Họ tên | Email | Số điện thoại | Chức vụ | Phòng ban | Phân quyền | Mật khẩu | Hình đại diện
 */
const ND_COLS = [
  "Mã NV",          // A — khoá chính chính
  "Họ tên",         // B
  "Email",          // C — khoá phụ (duy nhất)
  "Số điện thoại",  // D
  "Chức vụ",        // E
  "Phòng ban",      // F
  "Phân quyền",     // G
  "Mật khẩu",       // H — nhạy cảm, không bao giờ trả về frontend
  "Hình đại diện",  // I
];

/** Trường nhận dạng — dùng để tìm dòng khi update */
const ND_KEY_MA_NV = "Mã NV";
const ND_KEY_EMAIL = "Email";

/** Danh sách giá trị hợp lệ cho cột Phân quyền */
const ND_VALID_ROLES = ["Admin", "Quản lý", "Người dùng"];


// -----------------------------------------------------------------------------
// PHẦN 18: HELPER NỘI BỘ — ĐỌC SHEET VÀ TÌM DÒNG
// -----------------------------------------------------------------------------

/**
 * Đọc toàn bộ dữ liệu sheet Nguoi_Dung và trả về đối tượng ngữ cảnh gồm:
 *   - headers      : mảng tên cột thực tế từ hàng 1 của sheet (đã trim)
 *   - colMap       : { "Mã NV": 0, "Họ tên": 1, … } — index 0-based
 *   - values       : mảng 2D toàn bộ giá trị (bao gồm hàng header ở index 0)
 *   - dataValues   : values.slice(1) — chỉ dữ liệu (bỏ header)
 *   - sheet        : đối tượng Sheet để ghi lại
 *
 * ⚠️  Hàm đọc một lần duy nhất — không gọi nhiều lần trong cùng luồng.
 *
 * @returns {{ headers, colMap, values, dataValues, sheet }}
 * @throws  {Error} Nếu thiếu cột bắt buộc trong sheet
 */
function _readNguoiDungContext() {
  const sheet   = getSheet(SHEET_NAMES.NGUOI_DUNG);
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();

  if (lastRow < 1 || lastCol < 1) {
    throw new Error("Sheet Nguoi_Dung trống hoặc chưa có header.");
  }

  // Đọc toàn bộ một lần — tối ưu quota API
  const values  = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = values[0].map(h => String(h).trim());

  // Xây dựng map tên cột → index 0-based
  const colMap = {};
  headers.forEach((h, i) => { if (h) colMap[h] = i; });

  // Kiểm tra các cột bắt buộc phải tồn tại
  const required = [ND_KEY_MA_NV, ND_KEY_EMAIL, "Họ tên", "Phân quyền", "Mật khẩu"];
  const missing  = required.filter(c => !(c in colMap));
  if (missing.length > 0) {
    throw new Error(
      `Sheet Nguoi_Dung thiếu cột: ${missing.join(", ")}.\n` +
      `Cột thực tế trong sheet: ${headers.filter(Boolean).join(", ")}`
    );
  }

  return {
    sheet,
    headers,
    colMap,
    values,
    dataValues: values.slice(1), // index 0 = hàng dữ liệu đầu tiên (sheet row 2)
  };
}

/**
 * Tìm hàng của một nhân viên theo Mã NV hoặc Email.
 * Trả về số hàng sheet (1-based) hoặc -1 nếu không tìm thấy.
 *
 * Ưu tiên tìm theo Mã NV trước (chính xác hơn), fallback sang Email.
 *
 * @param {{ colMap, dataValues }} ctx - Ngữ cảnh từ _readNguoiDungContext()
 * @param {string}  maNV              - Mã NV cần tìm (có thể trống)
 * @param {string}  email             - Email cần tìm (có thể trống)
 * @returns {{ sheetRow: number, rowData: any[] }|null}
 *          sheetRow = số hàng trong sheet (2-based), null nếu không tìm thấy
 */
function _findNguoiDungRow(ctx, maNV, email) {
  const { colMap, dataValues } = ctx;
  const maNVIdx  = colMap[ND_KEY_MA_NV];
  const emailIdx = colMap[ND_KEY_EMAIL];

  const normMaNV  = (maNV  || "").trim();
  const normEmail = (email || "").trim().toLowerCase();

  for (let i = 0; i < dataValues.length; i++) {
    const row          = dataValues[i];
    const rowMaNV      = String(row[maNVIdx]  ?? "").trim();
    const rowEmail     = String(row[emailIdx] ?? "").trim().toLowerCase();
    const sheetRow     = i + 2; // +1 header, +1 vì 1-based

    // Ưu tiên khớp Mã NV (chính xác, không phân biệt hoa/thường)
    if (normMaNV && rowMaNV.toLowerCase() === normMaNV.toLowerCase()) {
      return { sheetRow, rowData: row };
    }
    // Fallback: khớp Email
    if (normEmail && rowEmail === normEmail) {
      return { sheetRow, rowData: row };
    }
  }

  return null; // Không tìm thấy
}

/**
 * Chuyển payload object thành mảng giá trị theo đúng thứ tự cột sheet thực tế.
 * Áp dụng chuẩn hóa định dạng cho từng loại dữ liệu.
 *
 * @param {Object}  payload    - Dữ liệu từ frontend
 * @param {Object}  colMap     - Map tên cột → index 0-based
 * @param {any[]}   existingRow- Dữ liệu hàng hiện tại (dùng để giữ lại ô không đổi)
 * @param {boolean} isUpdate   - true = merge với existingRow; false = new row
 * @returns {any[]}  Mảng 1 chiều ghi vào sheet
 */
function _buildRowFromPayload(payload, colMap, existingRow, isUpdate) {
  // Số cột thực tế của sheet (bằng số header có nội dung)
  const numCols = Object.keys(colMap).length;
  // Khởi tạo với giá trị hiện tại (hoặc rỗng nếu thêm mới)
  const row = existingRow
    ? existingRow.slice(0, numCols)
    : new Array(numCols).fill("");

  // Map từ tên cột → giá trị đã format
  const formatted = _formatPayload(payload, isUpdate, existingRow, colMap);

  // Điền vào đúng vị trí cột
  Object.entries(colMap).forEach(([colName, colIdx]) => {
    if (colIdx >= numCols) return; // index ngoài vùng
    if (colName in formatted) {
      row[colIdx] = formatted[colName];
    }
    // Nếu trường không có trong formatted → giữ nguyên giá trị hiện tại
  });

  return row;
}


// -----------------------------------------------------------------------------
// PHẦN 19: CHUẨN HÓA VÀ ĐỊNH DẠNG DỮ LIỆU
// -----------------------------------------------------------------------------

/**
 * Chuẩn hóa toàn bộ payload — áp dụng quy tắc format cho từng cột.
 * Trả về object { "tên cột": "giá trị đã format" }.
 *
 * QUY TẮC ĐỊNH DẠNG:
 *  Mã NV          → UPPERCASE, trim, loại ký tự đặc biệt ngoài chữ-số-gạch
 *  Họ tên         → Viết hoa chữ cái đầu mỗi từ (Title Case tiếng Việt)
 *  Email          → lowercase, trim
 *  Số điện thoại  → chỉ giữ số và dấu + ở đầu, chuẩn hóa 10 số
 *  Chức vụ        → trim, Title Case nhẹ
 *  Phòng ban      → trim
 *  Phân quyền     → phải nằm trong ND_VALID_ROLES
 *  Mật khẩu       → trim (KHÔNG hash ở đây — để hàm gọi tự quyết định)
 *  Hình đại diện  → trim URL
 *
 * @param {Object}  payload     - Raw payload từ frontend
 * @param {boolean} isUpdate    - Nếu true: bỏ qua trường undefined (giữ cũ)
 * @param {any[]}   existingRow - Dữ liệu hàng hiện tại (dùng khi isUpdate)
 * @param {Object}  colMap      - Map cột
 * @returns {Object} Payload đã format
 */
function _formatPayload(payload, isUpdate, existingRow, colMap) {
  const out = {};

  /**
   * Helper: lấy giá trị từ payload; nếu isUpdate & undefined → lấy từ hàng cũ
   * @param {string} field - Tên cột
   * @returns {string}
   */
  const raw = field => {
    if (field in payload) return String(payload[field] ?? "").trim();
    if (isUpdate && existingRow && field in colMap) {
      return String(existingRow[colMap[field]] ?? "").trim();
    }
    return "";
  };

  // ── Mã NV ─────────────────────────────────────────────────────────────────
  const maNV = raw(ND_KEY_MA_NV)
    .toUpperCase()
    .replace(/[^A-Z0-9\-_]/g, "") // Chỉ giữ chữ cái, số, gạch
    .substring(0, 20);            // Tối đa 20 ký tự
  if (maNV) out[ND_KEY_MA_NV] = maNV;

  // ── Họ tên ────────────────────────────────────────────────────────────────
  const hoTen = _toVietnameseTitleCase(raw("Họ tên")).substring(0, 100);
  if (hoTen) out["Họ tên"] = hoTen;

  // ── Email ─────────────────────────────────────────────────────────────────
  const email = raw(ND_KEY_EMAIL).toLowerCase().substring(0, 254);
  if (email) out[ND_KEY_EMAIL] = email;

  // ── Số điện thoại ─────────────────────────────────────────────────────────
  const rawSdt = raw("Số điện thoại");
  out["Số điện thoại"] = rawSdt ? _formatPhoneVN(rawSdt) : "";

  // ── Chức vụ ───────────────────────────────────────────────────────────────
  out["Chức vụ"] = _toVietnameseTitleCase(raw("Chức vụ")).substring(0, 100);

  // ── Phòng ban ──────────────────────────────────────────────────────────────
  out["Phòng ban"] = raw("Phòng ban").substring(0, 100);

  // ── Phân quyền ────────────────────────────────────────────────────────────
  const role = raw("Phân quyền");
  out["Phân quyền"] = ND_VALID_ROLES.includes(role) ? role : "Người dùng";

  // ── Mật khẩu ──────────────────────────────────────────────────────────────
  // Không format mật khẩu — hàm gọi quyết định hash hay plaintext
  const pwd = raw("Mật khẩu");
  if (pwd) out["Mật khẩu"] = pwd;
  // Nếu pwd rỗng khi isUpdate → KHÔNG set để caller giữ nguyên

  // ── Hình đại diện ─────────────────────────────────────────────────────────
  const avatar = raw("Hình đại diện").substring(0, 500);
  // Chỉ chấp nhận URL bắt đầu bằng http/https hoặc rỗng
  out["Hình đại diện"] = _isValidHttpUrl(avatar) ? avatar : "";

  return out;
}

/**
 * Chuyển chuỗi tiếng Việt sang Title Case: mỗi từ viết hoa chữ cái đầu.
 * Xử lý đúng với dấu tiếng Việt (ắ, ể, ộ, …).
 *
 * @param {string} str
 * @returns {string}
 */
function _toVietnameseTitleCase(str) {
  if (!str) return "";
  return str
    .trim()
    .toLowerCase()
    .replace(/(?:^|\s)\S/g, c => c.toUpperCase());
}

/**
 * Chuẩn hóa số điện thoại Việt Nam.
 * Input:  "0 901 234 567", "+84901234567", "84-901.234.567"
 * Output: "0901234567" (10 chữ số) hoặc "+84901234567" (quốc tế)
 *
 * @param {string} phone
 * @returns {string}
 */
function _formatPhoneVN(phone) {
  if (!phone) return "";

  // Giữ lại chỉ số và dấu + ở đầu
  let digits = phone.replace(/[^\d+]/g, "");

  // Chuyển +84 → 0
  if (digits.startsWith("+84")) {
    digits = "0" + digits.slice(3);
  } else if (digits.startsWith("84") && digits.length === 11) {
    digits = "0" + digits.slice(2);
  }

  // Giữ nguyên nếu đã đúng dạng 10 số (bắt đầu bằng 0)
  if (/^0\d{9}$/.test(digits)) return digits;

  // Nếu có + ở đầu (số quốc tế) → trả về nguyên
  if (/^\+\d{8,15}$/.test(digits)) return digits;

  // Không nhận dạng được → trả về chuỗi đã lọc (không làm mất dữ liệu)
  return digits.substring(0, 15);
}

/**
 * Kiểm tra cơ bản URL hợp lệ (http/https).
 *
 * @param {string} url
 * @returns {boolean}
 */
function _isValidHttpUrl(url) {
  if (!url) return true; // rỗng là hợp lệ (không bắt buộc)
  return /^https?:\/\/.+/.test(url);
}


// -----------------------------------------------------------------------------
// PHẦN 20: VALIDATION ĐẦY ĐỦ
// -----------------------------------------------------------------------------

/**
 * Validate payload Nguoi_Dung trước khi ghi vào sheet.
 *
 * @param {Object}  payload   - Dữ liệu từ frontend (chưa format)
 * @param {boolean} isUpdate  - true = đang update (mật khẩu không bắt buộc)
 * @returns {string|null}     - Thông báo lỗi, hoặc null nếu hợp lệ
 */
function _validateNguoiDungPayload(payload, isUpdate) {
  if (!payload || typeof payload !== "object") {
    return "Dữ liệu không hợp lệ (không phải object).";
  }

  const get = field => String(payload[field] ?? "").trim();

  // ── Trường bắt buộc ─────────────────────────────────────────────────────
  const requiredFields = [
    [ND_KEY_MA_NV,  "Mã nhân viên"],
    ["Họ tên",      "Họ và tên"],
    [ND_KEY_EMAIL,  "Email"],
    ["Chức vụ",     "Chức vụ"],
    ["Phòng ban",   "Phòng ban"],
    ["Phân quyền",  "Phân quyền"],
  ];

  for (const [field, label] of requiredFields) {
    if (!get(field)) return `"${label}" không được để trống.`;
  }

  // ── Độ dài tối đa ───────────────────────────────────────────────────────
  const maxLengths = {
    [ND_KEY_MA_NV] : [20,  "Mã nhân viên không được dài hơn 20 ký tự."],
    "Họ tên"       : [100, "Họ tên không được dài hơn 100 ký tự."],
    [ND_KEY_EMAIL] : [254, "Email không được dài hơn 254 ký tự."],
    "Chức vụ"      : [100, "Chức vụ không được dài hơn 100 ký tự."],
    "Phòng ban"    : [100, "Phòng ban không được dài hơn 100 ký tự."],
  };
  for (const [field, [max, msg]] of Object.entries(maxLengths)) {
    if (get(field).length > max) return msg;
  }

  // ── Mã NV: chỉ chứa chữ-số-gạch ──────────────────────────────────────
  if (!/^[A-Za-z0-9\-_]+$/.test(get(ND_KEY_MA_NV))) {
    return "Mã nhân viên chỉ được chứa chữ cái, chữ số, dấu gạch ngang và gạch dưới.";
  }

  // ── Email format ─────────────────────────────────────────────────────────
  const email = get(ND_KEY_EMAIL);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return `Email "${email}" không đúng định dạng (VD: ten@domain.com).`;
  }

  // ── Số điện thoại (tuỳ chọn) ────────────────────────────────────────────
  const sdt = get("Số điện thoại");
  if (sdt) {
    const sdtClean = sdt.replace(/[\s\-\.]/g, "");
    if (!/^(\+84|84|0)\d{8,10}$/.test(sdtClean)) {
      return `Số điện thoại "${sdt}" không đúng định dạng VN (VD: 0901234567 hoặc +84901234567).`;
    }
  }

  // ── Phân quyền ──────────────────────────────────────────────────────────
  const role = get("Phân quyền");
  if (!ND_VALID_ROLES.includes(role)) {
    return `Phân quyền "${role}" không hợp lệ. Giá trị được phép: ${ND_VALID_ROLES.join(", ")}.`;
  }

  // ── Mật khẩu ────────────────────────────────────────────────────────────
  const pwd = get("Mật khẩu");
  if (!isUpdate) {
    if (!pwd) return "Mật khẩu không được để trống khi thêm nhân viên mới.";
    if (pwd.length < 6) return "Mật khẩu phải có ít nhất 6 ký tự.";
    if (pwd.length > 128) return "Mật khẩu không được dài hơn 128 ký tự.";
  } else if (pwd) {
    // Khi update: chỉ validate nếu có nhập
    if (pwd.length < 6)   return "Mật khẩu mới phải có ít nhất 6 ký tự.";
    if (pwd.length > 128) return "Mật khẩu không được dài hơn 128 ký tự.";
  }

  // ── URL hình đại diện (tuỳ chọn) ────────────────────────────────────────
  const avatar = get("Hình đại diện");
  if (avatar && !_isValidHttpUrl(avatar)) {
    return `URL hình đại diện không hợp lệ. Phải bắt đầu bằng http:// hoặc https://.`;
  }

  return null; // ✅ Hợp lệ
}


// -----------------------------------------------------------------------------
// PHẦN 21: HÀM THÊM NHÂN VIÊN MỚI
// -----------------------------------------------------------------------------

/**
 * Thêm một nhân viên mới vào cuối sheet Nguoi_Dung.
 *
 * Payload shape từ frontend:
 * {
 *   "Mã NV":          "NV010",
 *   "Họ tên":         "Nguyễn Văn An",
 *   "Email":          "an@congty.vn",
 *   "Số điện thoại":  "0901234567",       // tuỳ chọn
 *   "Chức vụ":        "Chuyên viên",
 *   "Phòng ban":      "Phòng Kỹ thuật",
 *   "Phân quyền":     "Người dùng",
 *   "Mật khẩu":       "matkhau123",       // bắt buộc khi thêm mới
 *   "Hình đại diện":  "https://..."       // tuỳ chọn
 * }
 *
 * Các kiểm tra trước khi ghi:
 *   ① Quyền "Quản lý người dùng" (server-side)
 *   ② Validate tất cả trường
 *   ③ Email chưa tồn tại trong sheet
 *   ④ Mã NV chưa tồn tại trong sheet
 *
 * @param {string} sessionToken - Token phiên đăng nhập
 * @param {Object} payload      - Dữ liệu nhân viên mới (chưa format)
 * @returns {{
 *   success  : boolean,
 *   data     : { rowIndex: number, maNV: string, hoTen: string }|null,
 *   error    : string|null,
 *   meta     : { timestamp: string, action: string }
 * }}
 */
function addNguoiDung(sessionToken, payload) {

  // ══ BƯỚC 1: Xác thực phiên & quyền ═════════════════════════════════════════
  const auth = requirePermission(sessionToken, "Quản lý người dùng");
  if (!auth.allowed) {
    return _buildResponse(false, null, auth.error, "ADD_UNAUTHORIZED");
  }

  // ══ BƯỚC 2: Validate dữ liệu đầu vào ═══════════════════════════════════════
  const validErr = _validateNguoiDungPayload(payload, false);
  if (validErr) {
    return _buildResponse(false, null, validErr, "ADD_VALIDATION_FAILED");
  }

  // ══ BƯỚC 3: Đọc sheet & kiểm tra trùng lặp ═════════════════════════════════
  let ctx;
  try {
    ctx = _readNguoiDungContext();
  } catch (readErr) {
    Logger.log(`[addNguoiDung] Lỗi đọc sheet: ${readErr.message}`);
    return _buildResponse(false, null, `Lỗi đọc sheet: ${readErr.message}`, "ADD_READ_ERROR");
  }

  const inputMaNV  = String(payload[ND_KEY_MA_NV]  ?? "").trim().toUpperCase();
  const inputEmail = String(payload[ND_KEY_EMAIL]   ?? "").trim().toLowerCase();

  // Kiểm tra trùng Email
  const dupByEmail = _findNguoiDungRow(ctx, "", inputEmail);
  if (dupByEmail) {
    return _buildResponse(
      false, null,
      `Email "${inputEmail}" đã tồn tại tại hàng ${dupByEmail.sheetRow}.`,
      "ADD_DUPLICATE_EMAIL"
    );
  }

  // Kiểm tra trùng Mã NV
  const dupByMaNV = _findNguoiDungRow(ctx, inputMaNV, "");
  if (dupByMaNV) {
    return _buildResponse(
      false, null,
      `Mã NV "${inputMaNV}" đã tồn tại tại hàng ${dupByMaNV.sheetRow}.`,
      "ADD_DUPLICATE_MANV"
    );
  }

  // ══ BƯỚC 4: Chuẩn hóa dữ liệu ═══════════════════════════════════════════════
  const newRowData = _buildRowFromPayload(payload, ctx.colMap, null, false);

  // ══ BƯỚC 5: Ghi vào sheet ════════════════════════════════════════════════════
  try {
    const newSheetRow = ctx.sheet.getLastRow() + 1;

    // Ghi một lần duy nhất — tránh nhiều lần setValues()
    ctx.sheet
      .getRange(newSheetRow, 1, 1, newRowData.length)
      .setValues([newRowData]);

    // Xác nhận bằng cách đọc lại
    const verifyData = ctx.sheet
      .getRange(newSheetRow, ctx.colMap[ND_KEY_MA_NV] + 1, 1, 1)
      .getValue();

    Logger.log(
      `[addNguoiDung] ✅ Thêm thành công: "${payload["Họ tên"]}" ` +
      `(${inputMaNV}) tại hàng ${newSheetRow}. ` +
      `Thực hiện bởi: ${auth.role} / ${_verifySession(sessionToken).user?.["Email"]}`
    );

    return _buildResponse(true, {
      rowIndex : newSheetRow,
      maNV     : inputMaNV,
      hoTen    : String(payload["Họ tên"] ?? "").trim(),
      email    : inputEmail,
    }, null, "ADD_SUCCESS");

  } catch (writeErr) {
    Logger.log(`[addNguoiDung] Lỗi ghi sheet: ${writeErr.message}`);
    return _buildResponse(false, null, `Lỗi ghi dữ liệu: ${writeErr.message}`, "ADD_WRITE_ERROR");
  }
}


// -----------------------------------------------------------------------------
// PHẦN 22: HÀM CẬP NHẬT NHÂN VIÊN — TÌM DÒNG THEO MÃ NV HOẶC EMAIL
// -----------------------------------------------------------------------------

/**
 * Cập nhật thông tin nhân viên đã tồn tại trong sheet.
 *
 * Chiến lược tìm dòng:
 *   1. Nếu payload có "Mã NV" → tìm theo Mã NV trước
 *   2. Fallback sang Email nếu không tìm thấy theo Mã NV
 *   3. Nếu cả hai đều không tìm thấy → trả lỗi rõ ràng
 *
 * Quy tắc mật khẩu:
 *   - Payload có "Mật khẩu" (không rỗng) → ghi đè mật khẩu mới
 *   - Payload không có hoặc để trống "Mật khẩu" → GIỮ NGUYÊN mật khẩu cũ
 *
 * Trường không gửi lên (undefined/null):
 *   → GIỮ NGUYÊN giá trị hiện tại của ô đó trong sheet
 *
 * @param {string} sessionToken - Token phiên đăng nhập
 * @param {Object} payload      - Dữ liệu cập nhật (phải có Mã NV hoặc Email để tìm dòng)
 * @returns {{
 *   success : boolean,
 *   data    : { rowIndex: number, maNV: string, changes: string[] }|null,
 *   error   : string|null,
 *   meta    : { timestamp: string, action: string }
 * }}
 */
function updateNguoiDung(sessionToken, payload) {

  // ══ BƯỚC 1: Xác thực phiên & quyền ═════════════════════════════════════════
  const auth = requirePermission(sessionToken, "Quản lý người dùng");
  if (!auth.allowed) {
    return _buildResponse(false, null, auth.error, "UPDATE_UNAUTHORIZED");
  }

  // ══ BƯỚC 2: Kiểm tra có identifier để tìm dòng không ══════════════════════
  // Frontend gửi "_searchMaNV" = Mã NV GỐC (trước khi sửa) để tìm dòng chính xác
  // Nếu không có → dùng "Mã NV" hoặc "Email" trong payload
  const searchMaNV  = String(payload["_searchMaNV"] ?? payload[ND_KEY_MA_NV] ?? "").trim();
  const searchEmail = String(payload[ND_KEY_EMAIL]  ?? "").trim().toLowerCase();

  if (!searchMaNV && !searchEmail) {
    return _buildResponse(
      false, null,
      'Payload phải có "Mã NV" hoặc "Email" để xác định dòng cần cập nhật.',
      "UPDATE_NO_IDENTIFIER"
    );
  }

  // ══ BƯỚC 3: Validate dữ liệu (isUpdate = true → mật khẩu tuỳ chọn) ════════
  const validErr = _validateNguoiDungPayload(payload, true);
  if (validErr) {
    return _buildResponse(false, null, validErr, "UPDATE_VALIDATION_FAILED");
  }

  // ══ BƯỚC 4: Đọc sheet & tìm dòng ════════════════════════════════════════════
  let ctx;
  try {
    ctx = _readNguoiDungContext();
  } catch (readErr) {
    return _buildResponse(false, null, `Lỗi đọc sheet: ${readErr.message}`, "UPDATE_READ_ERROR");
  }

  const found = _findNguoiDungRow(ctx, searchMaNV, searchEmail);

  if (!found) {
    const searchDesc = searchMaNV
      ? `Mã NV "${searchMaNV}"`
      : `Email "${searchEmail}"`;
    return _buildResponse(
      false, null,
      `Không tìm thấy nhân viên với ${searchDesc} trong sheet. Kiểm tra lại thông tin.`,
      "UPDATE_NOT_FOUND"
    );
  }

  const { sheetRow, rowData: existingRow } = found;

  // ══ BƯỚC 5: Kiểm tra Email mới không trùng với nhân viên KHÁC ══════════════
  const newEmail = String(payload[ND_KEY_EMAIL] ?? "").trim().toLowerCase();
  if (newEmail && newEmail !== searchEmail) {
    const dupEmail = _findNguoiDungRow(ctx, "", newEmail);
    if (dupEmail && dupEmail.sheetRow !== sheetRow) {
      return _buildResponse(
        false, null,
        `Email mới "${newEmail}" đã được dùng bởi nhân viên khác (hàng ${dupEmail.sheetRow}).`,
        "UPDATE_DUPLICATE_EMAIL"
      );
    }
  }

  // ══ BƯỚC 6: Kiểm tra Mã NV mới không trùng với nhân viên KHÁC ═════════════
  const newMaNV = String(payload[ND_KEY_MA_NV] ?? "").trim().toUpperCase();
  if (newMaNV && newMaNV !== searchMaNV.toUpperCase()) {
    const dupMaNV = _findNguoiDungRow(ctx, newMaNV, "");
    if (dupMaNV && dupMaNV.sheetRow !== sheetRow) {
      return _buildResponse(
        false, null,
        `Mã NV mới "${newMaNV}" đã được dùng bởi nhân viên khác (hàng ${dupMaNV.sheetRow}).`,
        "UPDATE_DUPLICATE_MANV"
      );
    }
  }

  // ══ BƯỚC 7: Xử lý Mật khẩu — giữ cũ nếu payload không cung cấp ═══════════
  const pwdIdx     = ctx.colMap["Mật khẩu"];
  const existingPwd = pwdIdx !== undefined ? String(existingRow[pwdIdx] ?? "") : "";
  const newPwdRaw   = String(payload["Mật khẩu"] ?? "").trim();

  // Nếu payload không gửi mật khẩu → inject lại mật khẩu cũ để _buildRowFromPayload giữ nguyên
  const mergedPayload = { ...payload };
  if (!newPwdRaw) {
    mergedPayload["Mật khẩu"] = existingPwd; // giữ nguyên mật khẩu cũ
  }

  // ══ BƯỚC 8: Build hàng mới và theo dõi thay đổi (change tracking) ══════════
  const newRowData  = _buildRowFromPayload(mergedPayload, ctx.colMap, existingRow, true);
  const changedCols = _detectChanges(existingRow, newRowData, ctx.headers, ["Mật khẩu"]);

  // ══ BƯỚC 9: Ghi vào sheet ════════════════════════════════════════════════════
  try {
    ctx.sheet
      .getRange(sheetRow, 1, 1, newRowData.length)
      .setValues([newRowData]);

    const session = _verifySession(sessionToken);
    Logger.log(
      `[updateNguoiDung] ✅ Cập nhật hàng ${sheetRow} ` +
      `(Mã NV: ${newMaNV || searchMaNV}). ` +
      `Thay đổi: [${changedCols.join(", ")}]. ` +
      `Thực hiện bởi: ${session.user?.["Email"] ?? "?"}`
    );

    return _buildResponse(true, {
      rowIndex   : sheetRow,
      maNV       : newMaNV || searchMaNV,
      hoTen      : String(mergedPayload["Họ tên"] ?? "").trim(),
      changes    : changedCols,
      changesCount: changedCols.length,
    }, null, "UPDATE_SUCCESS");

  } catch (writeErr) {
    Logger.log(`[updateNguoiDung] Lỗi ghi sheet: ${writeErr.message}`);
    return _buildResponse(false, null, `Lỗi ghi dữ liệu: ${writeErr.message}`, "UPDATE_WRITE_ERROR");
  }
}


// -----------------------------------------------------------------------------
// PHẦN 23: HÀM XÓA NHÂN VIÊN
// -----------------------------------------------------------------------------

/**
 * Xóa nhân viên khỏi sheet — tìm dòng theo Mã NV hoặc Email.
 *
 * Biện pháp bảo vệ (theo thứ tự):
 *   ① Chỉ Admin được xóa
 *   ② Không thể xóa tài khoản đang đăng nhập
 *   ③ Không thể xóa Admin duy nhất còn lại
 *
 * ⚠️  Dùng deleteRow() — toàn bộ dữ liệu phía dưới dịch lên 1.
 *     Frontend phải reload danh sách sau khi xóa thành công.
 *
 * @param {string} sessionToken - Token phiên đăng nhập
 * @param {string} maNV         - Mã NV của nhân viên cần xóa (ưu tiên)
 * @param {string} [email]      - Email (dùng nếu không có Mã NV)
 * @returns {{ success: boolean, data: Object|null, error: string|null }}
 */
function deleteNguoiDung(sessionToken, maNV, email) {

  // ══ BƯỚC 1: Xác thực & quyền ════════════════════════════════════════════════
  const auth = requirePermission(sessionToken, "Quản lý người dùng");
  if (!auth.allowed) return _buildResponse(false, null, auth.error, "DELETE_UNAUTHORIZED");

  if (auth.role !== "Admin") {
    return _buildResponse(false, null, "Chỉ Admin mới có quyền xóa nhân viên.", "DELETE_NOT_ADMIN");
  }

  if (!maNV && !email) {
    return _buildResponse(false, null, 'Phải cung cấp "Mã NV" hoặc "Email" để xóa.', "DELETE_NO_IDENTIFIER");
  }

  // ══ BƯỚC 2: Đọc sheet & tìm dòng ════════════════════════════════════════════
  let ctx;
  try {
    ctx = _readNguoiDungContext();
  } catch (e) {
    return _buildResponse(false, null, `Lỗi đọc sheet: ${e.message}`, "DELETE_READ_ERROR");
  }

  const found = _findNguoiDungRow(
    ctx,
    String(maNV  ?? "").trim(),
    String(email ?? "").trim().toLowerCase()
  );

  if (!found) {
    return _buildResponse(
      false, null,
      `Không tìm thấy nhân viên với Mã NV "${maNV}" hoặc Email "${email}".`,
      "DELETE_NOT_FOUND"
    );
  }

  const { sheetRow, rowData } = found;
  const emailIdx   = ctx.colMap[ND_KEY_EMAIL];
  const roleIdx    = ctx.colMap["Phân quyền"];
  const nameIdx    = ctx.colMap["Họ tên"];
  const deletedEmail = String(rowData[emailIdx] ?? "");
  const deletedRole  = String(rowData[roleIdx]  ?? "");
  const deletedName  = String(rowData[nameIdx]  ?? "");

  // ══ BƯỚC 3: Bảo vệ — không tự xóa chính mình ═══════════════════════════════
  const session = _verifySession(sessionToken);
  if (session.valid && session.user[ND_KEY_EMAIL]?.toLowerCase() === deletedEmail.toLowerCase()) {
    return _buildResponse(false, null, "Không thể xóa tài khoản đang đăng nhập.", "DELETE_SELF");
  }

  // ══ BƯỚC 4: Bảo vệ — không xóa Admin duy nhất ══════════════════════════════
  if (deletedRole === "Admin") {
    const adminCount = ctx.dataValues.filter(
      row => String(row[roleIdx] ?? "") === "Admin"
    ).length;
    if (adminCount <= 1) {
      return _buildResponse(
        false, null,
        "Không thể xóa Admin duy nhất trong hệ thống.",
        "DELETE_LAST_ADMIN"
      );
    }
  }

  // ══ BƯỚC 5: Xóa dòng ════════════════════════════════════════════════════════
  try {
    ctx.sheet.deleteRow(sheetRow);

    Logger.log(
      `[deleteNguoiDung] ✅ Xóa hàng ${sheetRow}: "${deletedName}" (${deletedEmail}). ` +
      `Thực hiện bởi: ${session.user?.["Email"] ?? "?"}`
    );

    return _buildResponse(true, {
      deletedRow  : sheetRow,
      deletedMaNV : String(rowData[ctx.colMap[ND_KEY_MA_NV]] ?? ""),
      deletedName,
      deletedEmail,
    }, null, "DELETE_SUCCESS");

  } catch (e) {
    Logger.log(`[deleteNguoiDung] Lỗi xóa dòng: ${e.message}`);
    return _buildResponse(false, null, `Lỗi xóa dữ liệu: ${e.message}`, "DELETE_WRITE_ERROR");
  }
}


// -----------------------------------------------------------------------------
// PHẦN 24: HELPERS CHUNG CHO MODULE CRUD
// -----------------------------------------------------------------------------

/**
 * Tạo response chuẩn hóa cho toàn bộ module CRUD.
 *
 * @param {boolean}     success
 * @param {Object|null} data
 * @param {string|null} error
 * @param {string}      action  - Code hành động để frontend/log tra cứu
 * @returns {Object}
 */
function _buildResponse(success, data, error, action) {
  return {
    success,
    data   : data  ?? null,
    error  : error ?? null,
    meta   : {
      action,
      timestamp : new Date().toISOString(),
    },
  };
}

/**
 * So sánh hàng cũ và hàng mới để phát hiện ô nào thực sự thay đổi.
 * Dùng để ghi audit log chính xác.
 *
 * @param {any[]}    oldRow       - Dữ liệu hàng cũ
 * @param {any[]}    newRow       - Dữ liệu hàng mới
 * @param {string[]} headers      - Tên các cột
 * @param {string[]} excludeCols  - Cột không theo dõi (VD: "Mật khẩu")
 * @returns {string[]} Danh sách tên cột đã thay đổi
 */
function _detectChanges(oldRow, newRow, headers, excludeCols) {
  const changed = [];
  const excluded = new Set(excludeCols);
  const maxLen = Math.max(oldRow.length, newRow.length);

  for (let i = 0; i < maxLen; i++) {
    const colName = headers[i] || `col_${i}`;
    if (excluded.has(colName)) continue;

    const oldVal = String(oldRow[i] ?? "").trim();
    const newVal = String(newRow[i] ?? "").trim();

    if (oldVal !== newVal) changed.push(colName);
  }

  return changed;
}


// -----------------------------------------------------------------------------
// PHẦN 25: HÀM TEST TOÀN BỘ MODULE
// -----------------------------------------------------------------------------

/**
 * Test toàn bộ module CRUD Nguoi_Dung.
 * Chạy thủ công trong Apps Script Editor — KHÔNG deploy.
 *
 * Kiểm tra:
 *   T01: _formatPhoneVN — nhiều định dạng số
 *   T02: _toVietnameseTitleCase — viết hoa chuẩn
 *   T03: _validateNguoiDungPayload — tất cả rule
 *   T04: _readNguoiDungContext — kết nối thật với sheet
 *   T05: _findNguoiDungRow — tìm theo Mã NV và Email
 */
function testNguoiDungModule() {
  Logger.log("════════════════════════════════════\n" +
             "  TEST NGUOI_DUNG MODULE  v5.0\n" +
             "════════════════════════════════════\n");

  // ── T01: _formatPhoneVN ───────────────────────────────────────────────────
  Logger.log("── T01: _formatPhoneVN ──");
  const phoneCases = [
    ["0901234567",    "0901234567"],
    ["+84901234567",  "0901234567"],
    ["84901234567",   "0901234567"],
    ["0 901 234 567", "0901234567"],
    ["090-123-4567",  "0901234567"],
    ["invalid",       "invalid"],
  ];
  phoneCases.forEach(([input, expected]) => {
    const result = _formatPhoneVN(input);
    const ok     = result === expected;
    Logger.log(`  ${ok ? "✅" : "❌"} "${input}" → "${result}" (expected: "${expected}")`);
  });

  // ── T02: _toVietnameseTitleCase ───────────────────────────────────────────
  Logger.log("\n── T02: _toVietnameseTitleCase ──");
  const titleCases = [
    ["nguyễn văn an",       "Nguyễn Văn An"],
    ["TRẦN THỊ HOA",        "Trần Thị Hoa"],
    ["lê MINH ĐỨC",         "Lê Minh Đức"],
    ["phòng kỹ thuật phần mềm", "Phòng Kỹ Thuật Phần Mềm"],
  ];
  titleCases.forEach(([input, expected]) => {
    const result = _toVietnameseTitleCase(input);
    Logger.log(`  ${result === expected ? "✅" : "❌"} "${input}" → "${result}"`);
  });

  // ── T03: _validateNguoiDungPayload ────────────────────────────────────────
  Logger.log("\n── T03: _validateNguoiDungPayload ──");

  const validPayload = {
    "Mã NV": "NV001", "Họ tên": "Nguyễn Văn An",
    "Email": "an@co.vn", "Chức vụ": "Dev", "Phòng ban": "IT",
    "Phân quyền": "Người dùng", "Mật khẩu": "abc123",
  };

  Logger.log("  Payload hợp lệ: " + (_validateNguoiDungPayload(validPayload, false) ?? "null ✅"));
  Logger.log("  Email sai: "      + _validateNguoiDungPayload({ ...validPayload, "Email": "bad" }, false));
  Logger.log("  Role sai: "       + _validateNguoiDungPayload({ ...validPayload, "Phân quyền": "God" }, false));
  Logger.log("  Mã NV sai: "      + _validateNguoiDungPayload({ ...validPayload, "Mã NV": "NV 001!" }, false));
  Logger.log("  Pwd ngắn: "       + _validateNguoiDungPayload({ ...validPayload, "Mật khẩu": "123" }, false));
  Logger.log("  Pwd trống khi thêm: " + _validateNguoiDungPayload({ ...validPayload, "Mật khẩu": "" }, false));
  Logger.log("  Pwd trống khi update: " + (_validateNguoiDungPayload({ ...validPayload, "Mật khẩu": "" }, true) ?? "null ✅"));
  Logger.log("  SĐT sai: " + _validateNguoiDungPayload({ ...validPayload, "Số điện thoại": "12345" }, false));

  // ── T04 & T05: Kết nối sheet thực ─────────────────────────────────────────
  Logger.log("\n── T04: _readNguoiDungContext ──");
  try {
    const ctx = _readNguoiDungContext();
    Logger.log(`  ✅ Đọc OK. Headers: [${ctx.headers.filter(Boolean).join(", ")}]`);
    Logger.log(`  Số dòng dữ liệu: ${ctx.dataValues.length}`);
    Logger.log(`  colMap: ${JSON.stringify(ctx.colMap)}`);

    // ── T05: Tìm dòng ─────────────────────────────────────────────────────
    Logger.log("\n── T05: _findNguoiDungRow ──");
    if (ctx.dataValues.length > 0) {
      const firstMaNV  = String(ctx.dataValues[0][ctx.colMap[ND_KEY_MA_NV]]  ?? "").trim();
      const firstEmail = String(ctx.dataValues[0][ctx.colMap[ND_KEY_EMAIL]]   ?? "").trim();
      Logger.log(`  Tìm theo Mã NV "${firstMaNV}":`);
      const r1 = _findNguoiDungRow(ctx, firstMaNV, "");
      Logger.log(`    → sheetRow: ${r1?.sheetRow ?? "không tìm thấy"} ${r1 ? "✅" : "❌"}`);
      Logger.log(`  Tìm theo Email "${firstEmail}":`);
      const r2 = _findNguoiDungRow(ctx, "", firstEmail);
      Logger.log(`    → sheetRow: ${r2?.sheetRow ?? "không tìm thấy"} ${r2 ? "✅" : "❌"}`);
      Logger.log(`  Tìm không tồn tại:`);
      const r3 = _findNguoiDungRow(ctx, "KHONGTONTAI", "");
      Logger.log(`    → ${r3 === null ? "null ✅" : "tìm thấy (SAI) ❌"}`);
    } else {
      Logger.log("  ⚠️  Sheet trống, bỏ qua T05.");
    }
  } catch (e) {
    Logger.log(`  ❌ Lỗi: ${e.message}`);
  }

  Logger.log("\n════════════════════════════════════\n  TEST HOÀN TẤT\n════════════════════════════════════");
}



// =============================================================================
// MODULE UPLOAD FILE — PHIÊN BẢN 1.0
// Nhận file PDF (base64) từ frontend → giải mã → lưu Google Drive
// =============================================================================


// -----------------------------------------------------------------------------
// PHẦN 26: CẤU HÌNH GOOGLE DRIVE
// -----------------------------------------------------------------------------

/**
 * Tên thư mục gốc trên Google Drive để chứa file PDF chờ ký.
 * Thư mục con sẽ được tạo theo tháng: Tai_Lieu_Cho_Ky/2025-07/
 * Thay đổi hằng này để dùng tên thư mục khác mà không ảnh hưởng code.
 */
const DRIVE_FOLDER_NAME = "Tai_Lieu_Cho_Ky";

/**
 * Kích thước file tối đa chấp nhận (bytes).
 * 20 MB = 20 * 1024 * 1024 = 20971520 bytes.
 * GAS Apps Script có giới hạn URL Fetch 50 MB, nhưng base64 inflate ~33%,
 * nên giới hạn thực tế an toàn là ~14 MB raw = ~20 MB base64.
 */
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * Danh sách MIME type được phép tải lên.
 * Hiện tại chỉ PDF; mở rộng nếu cần DOCX, XLSX trong tương lai.
 */
const ALLOWED_MIME_TYPES = [
  "application/pdf",
];

/**
 * Thời gian file tạm tồn tại trên Drive (mili giây).
 * Sau khi ký xong, file "tạm" nên được xóa hoặc chuyển vào thư mục lưu trữ.
 * Giá trị này chỉ dùng để ghi metadata, KHÔNG tự động xóa.
 */
const TEMP_FILE_TTL_HOURS = 24;


// -----------------------------------------------------------------------------
// PHẦN 27: HÀM CHÍNH — uploadTempFile
// -----------------------------------------------------------------------------

/**
 * ★ HÀM UPLOAD CHÍNH ★
 *
 * Nhận dữ liệu file PDF ở định dạng base64 từ frontend (gửi qua
 * google.script.run), giải mã, tạo file PDF thực tế trên Google Drive,
 * lưu vào thư mục "Tai_Lieu_Cho_Ky/<YYYY-MM>" và trả về File ID + URL.
 *
 * QUY TRÌNH XỬ LÝ:
 *   1.  Xác thực phiên đăng nhập (requirePermission)
 *   2.  Validate metadata và base64 string
 *   3.  Lấy / tạo thư mục đích trên Drive
 *   4.  Giải mã base64 → Blob PDF
 *   5.  Kiểm tra kích thước & tên file
 *   6.  Tạo file trên Drive với metadata đầy đủ
 *   7.  Đặt quyền xem cho người dùng trong tổ chức (optional)
 *   8.  Ghi metadata vào sheet "Data" (optional)
 *   9.  Trả về fileId, fileUrl, driveUrl, metadata
 *
 * ⚠️  LƯU Ý QUOTA GAS:
 *   - UrlFetch / Blob giới hạn ~50 MB per call (base64 ~33% overhead)
 *   - Drive.Files tạo file: không giới hạn số lần, nhưng quota 24h
 *   - Script runtime tối đa 6 phút — file lớn có thể timeout
 *   → Với file > 15 MB, nên dùng Resumable Upload qua Drive REST API
 *
 * @param {string} base64Data - Chuỗi base64 thuần (KHÔNG có "data:...;base64,")
 * @param {string} fileName   - Tên file gốc (VD: "HopDong_Q3.pdf")
 * @param {Object} metaData   - Metadata bổ sung từ frontend:
 *   {
 *     sessionToken  : string,   // Token phiên đăng nhập (BẮT BUỘC)
 *     loaiTaiLieu   : string,   // Loại: 'hop-dong' | 'bien-ban' | 'van-ban-hc'
 *     tenTaiLieu    : string,   // Tên tài liệu (hiển thị)
 *     tenDuAn       : string,   // Tên dự án (tuỳ chọn)
 *     mimeType      : string,   // MIME type (mặc định: 'application/pdf')
 *     fileSizeBytes : number,   // Kích thước gốc để cross-check
 *     signerConfig  : Object,   // Cấu hình người ký từ SignerConfig
 *   }
 *
 * @returns {{
 *   success      : boolean,
 *   fileId       : string|null,
 *   fileUrl      : string|null,  // URL xem trực tiếp (preview)
 *   driveUrl     : string|null,  // URL Drive (mở trong Drive UI)
 *   downloadUrl  : string|null,  // URL tải xuống trực tiếp
 *   uploadedName : string|null,  // Tên file đã được đặt trên Drive
 *   folderPath   : string|null,  // Đường dẫn thư mục Drive
 *   error        : string|null,
 *   meta         : Object
 * }}
 */
function uploadTempFile(base64Data, fileName, metaData) {

  // ══ BƯỚC 1: Validate đầu vào cơ bản ═════════════════════════════════════════
  if (!base64Data || typeof base64Data !== "string" || base64Data.trim() === "") {
    return _uploadError("Dữ liệu file base64 không được để trống.", "UPLOAD_NO_DATA");
  }
  if (!fileName || typeof fileName !== "string") {
    return _uploadError("Tên file không hợp lệ.", "UPLOAD_NO_FILENAME");
  }
  if (!metaData || typeof metaData !== "object") {
    return _uploadError("Metadata không hợp lệ.", "UPLOAD_NO_METADATA");
  }

  // ══ BƯỚC 2: Xác thực phiên & quyền ═════════════════════════════════════════
  const token = metaData.sessionToken || "";
  if (!token) {
    return _uploadError("Thiếu sessionToken trong metadata.", "UPLOAD_NO_TOKEN");
  }

  const auth = requirePermission(token, "Tạo tài liệu");
  if (!auth.allowed) {
    return _uploadError(auth.error, "UPLOAD_UNAUTHORIZED");
  }

  // Thông tin người upload
  const session    = _verifySession(token);
  const uploaderEmail = session.user?.["Email"] ?? "unknown";
  const uploaderMaNV  = session.user?.["Mã NV"]  ?? "unknown";
  const uploaderName  = session.user?.["Họ tên"] ?? session.user?.["Email"] ?? uploaderMaNV;

  Logger.log(`[uploadTempFile] Bắt đầu upload: "${fileName}" bởi ${uploaderEmail}`);

  // ══ BƯỚC 3: Validate metadata & tên file ════════════════════════════════════
  const safeName = _sanitizeFileName(fileName);
  if (!safeName) {
    return _uploadError(
      `Tên file "${fileName}" không hợp lệ. Chỉ chấp nhận ký tự chữ-số, dấu cách, gạch ngang, dấu chấm.`,
      "UPLOAD_INVALID_FILENAME"
    );
  }

  // Kiểm tra đuôi file
  if (!safeName.toLowerCase().endsWith(".pdf")) {
    return _uploadError(
      `File "${safeName}" không phải định dạng PDF. Chỉ chấp nhận file .pdf.`,
      "UPLOAD_WRONG_FORMAT"
    );
  }

  // MIME type
  const mimeType = (metaData.mimeType || "application/pdf").trim();
  if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
    return _uploadError(
      `MIME type "${mimeType}" không được phép. Chỉ chấp nhận: ${ALLOWED_MIME_TYPES.join(", ")}.`,
      "UPLOAD_WRONG_MIME"
    );
  }

  // ══ BƯỚC 4: Giải mã base64 → Blob ═══════════════════════════════════════════
  let fileBlob;
  try {
    // Xóa tiền tố "data:...;base64," nếu frontend gửi nhầm định dạng data URL
    const cleanBase64 = base64Data.includes(",")
      ? base64Data.split(",")[1]
      : base64Data.trim();

    fileBlob = Utilities.newBlob(
      Utilities.base64Decode(cleanBase64),
      mimeType,
      safeName
    );
  } catch (decodeErr) {
    Logger.log(`[uploadTempFile] Lỗi giải mã base64: ${decodeErr.message}`);
    return _uploadError(
      "Không thể giải mã dữ liệu file. Dữ liệu base64 có thể bị hỏng.",
      "UPLOAD_DECODE_ERROR"
    );
  }

  // ══ BƯỚC 5: Kiểm tra kích thước file sau khi giải mã ════════════════════════
  const actualSizeBytes = fileBlob.getBytes().length;

  if (actualSizeBytes === 0) {
    return _uploadError("File rỗng (0 bytes) sau khi giải mã.", "UPLOAD_EMPTY_FILE");
  }

  if (actualSizeBytes > MAX_FILE_SIZE_BYTES) {
    return _uploadError(
      `File quá lớn: ${_formatFileSize(actualSizeBytes)}. Giới hạn tối đa ${_formatFileSize(MAX_FILE_SIZE_BYTES)}.`,
      "UPLOAD_FILE_TOO_LARGE"
    );
  }

  // Cross-check kích thước với metadata nếu frontend gửi lên
  if (metaData.fileSizeBytes) {
    const declaredSize = parseInt(metaData.fileSizeBytes, 10);
    const deviation    = Math.abs(actualSizeBytes - declaredSize);
    const threshold    = 100; // Cho phép sai số nhỏ (encoding overhead)
    if (deviation > threshold) {
      Logger.log(
        `[uploadTempFile] ⚠️  Kích thước khai báo ${declaredSize} ≠ thực tế ${actualSizeBytes} ` +
        `(sai số ${deviation} bytes)`
      );
      // Không block — chỉ cảnh báo log
    }
  }

  Logger.log(
    `[uploadTempFile] File blob OK: "${safeName}" · ${_formatFileSize(actualSizeBytes)} · ${mimeType}`
  );

  // ══ BƯỚC 6: Lấy / tạo thư mục đích trên Google Drive ══════════════════════
  let targetFolder;
  try {
    targetFolder = _getOrCreateUploadFolder();
  } catch (folderErr) {
    Logger.log(`[uploadTempFile] Lỗi thư mục: ${folderErr.message}`);
    return _uploadError(
      `Không thể truy cập thư mục Drive: ${folderErr.message}`,
      "UPLOAD_FOLDER_ERROR"
    );
  }

  // ══ BƯỚC 7: Tạo tên file duy nhất (timestamp + mã NV) ══════════════════════
  const uniqueName = _buildUniqueFileName(safeName, uploaderMaNV, metaData);

  // ══ BƯỚC 8: Tạo file trên Google Drive ═════════════════════════════════════
  let driveFile;
  try {
    driveFile = targetFolder.createFile(fileBlob.setName(uniqueName));
  } catch (createErr) {
    Logger.log(`[uploadTempFile] Lỗi tạo file Drive: ${createErr.message}`);
    return _uploadError(
      `Không thể tạo file trên Google Drive: ${createErr.message}`,
      "UPLOAD_CREATE_ERROR"
    );
  }

  // ══ BƯỚC 9: Đặt quyền & mô tả file ════════════════════════════════════════
  try {
    // Mô tả file — hiển thị trong Drive UI
    driveFile.setDescription(
      `eSign Upload | Loại: ${metaData.loaiTaiLieu || "N/A"} | ` +
      `Tài liệu: ${metaData.tenTaiLieu || "N/A"} | ` +
      `Dự án: ${metaData.tenDuAn || "N/A"} | ` +
      `Người upload: ${uploaderEmail} | ` +
      `Thời điểm: ${new Date().toLocaleString("vi-VN")}`
    );

    // [VGCA FIX] App VGCASignService là HTTP client KHÔNG đăng nhập Google →
    // phải chia sẻ "Bất kỳ ai có link" để app tải được PDF gốc qua
    // uc?export=download. Nếu không → lỗi 0x0023 "Tải tệp ký số không thành công".
    driveFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  } catch (permErr) {
    // Không block upload vì quyền có thể cấu hình sau
    Logger.log(`[uploadTempFile] ⚠️  Không đặt được quyền: ${permErr.message}`);
  }

  // ══ BƯỚC 10: Lấy các URL cần thiết ════════════════════════════════════════
  const fileId      = driveFile.getId();
  const fileUrl     = `https://drive.google.com/file/d/${fileId}/preview`;      // Embed preview
  const driveUrl    = `https://drive.google.com/file/d/${fileId}/view`;          // Drive viewer
  const downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`; // Direct download
  const folderPath  = `${DRIVE_FOLDER_NAME}/${_getMonthFolderName()}`;

  // ══ BƯỚC 11: Ghi log vào sheet "Data" (nếu có) ═════════════════════════════
  try {
    _logUploadToSheet(fileId, uniqueName, actualSizeBytes, uploaderEmail, metaData, driveUrl, uploaderName);
  } catch (logErr) {
    // Không block — log thất bại không ảnh hưởng upload
    Logger.log(`[uploadTempFile] ⚠️  Ghi log sheet thất bại: ${logErr.message}`);
  }

  Logger.log(
    `[uploadTempFile] ✅ Upload thành công: "${uniqueName}" | ` +
    `ID: ${fileId} | ${_formatFileSize(actualSizeBytes)} | ` +
    `Folder: ${folderPath} | Uploader: ${uploaderEmail}`
  );

  // ══ BƯỚC 12: Trả về kết quả ════════════════════════════════════════════════
  return {
    success      : true,
    fileId       : fileId,
    fileUrl      : fileUrl,
    driveUrl     : driveUrl,
    downloadUrl  : downloadUrl,
    uploadedName : uniqueName,
    folderPath   : folderPath,
    error        : null,
    meta         : {
      action        : "UPLOAD_SUCCESS",
      originalName  : safeName,
      sizeBytes     : actualSizeBytes,
      sizeHuman     : _formatFileSize(actualSizeBytes),
      mimeType      : mimeType,
      uploaderEmail : uploaderEmail,
      uploaderMaNV  : uploaderMaNV,
      timestamp     : new Date().toISOString(),
      ttlHours      : TEMP_FILE_TTL_HOURS,
    },
  };
}


// -----------------------------------------------------------------------------
// PHẦN 28: HÀM QUẢN LÝ THƯ MỤC GOOGLE DRIVE
// -----------------------------------------------------------------------------

/**
 * Lấy thư mục đích để lưu file, tạo mới nếu chưa tồn tại.
 *
 * Cấu trúc thư mục:
 *   My Drive/
 *   └── Tai_Lieu_Cho_Ky/           ← DRIVE_FOLDER_NAME
 *       └── 2025-07/               ← Thư mục tháng (tự tạo)
 *
 * Dùng thư mục con theo tháng để dễ quản lý & tránh thư mục gốc quá nhiều file.
 *
 * @returns {GoogleAppsScript.Drive.Folder}
 * @throws  {Error} Nếu không thể tạo hoặc truy cập thư mục
 */
function _getOrCreateUploadFolder() {
  const monthFolder = _getMonthFolderName(); // "2025-07"
  const rootFolder  = _getOrCreateFolder(null, DRIVE_FOLDER_NAME);
  return _getOrCreateFolder(rootFolder, monthFolder);
}

/**
 * Tên thư mục tháng hiện tại theo định dạng "YYYY-MM".
 * @returns {string} VD: "2025-07"
 */
function _getMonthFolderName() {
  const now = new Date();
  const y   = now.getFullYear();
  const m   = String(now.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * Lấy thư mục con theo tên trong parent folder, tạo mới nếu chưa có.
 * Nếu có nhiều thư mục cùng tên → lấy thư mục đầu tiên (tránh tạo trùng).
 *
 * @param {GoogleAppsScript.Drive.Folder|null} parent - null = My Drive (root)
 * @param {string} folderName                         - Tên thư mục cần lấy/tạo
 * @returns {GoogleAppsScript.Drive.Folder}
 */
function _getOrCreateFolder(parent, folderName) {
  const searchIn  = parent || DriveApp.getRootFolder();
  const existing  = searchIn.getFoldersByName(folderName);

  if (existing.hasNext()) {
    return existing.next(); // Lấy thư mục đã có
  }

  // Tạo thư mục mới
  const newFolder = searchIn.createFolder(folderName);
  Logger.log(`[_getOrCreateFolder] ✅ Tạo thư mục mới: "${folderName}" trong "${searchIn.getName()}"`);
  return newFolder;
}


// -----------------------------------------------------------------------------
// PHẦN 29: HÀM TIỆN ÍCH — TÊN FILE & ĐỊNH DẠNG
// -----------------------------------------------------------------------------

/**
 * Tạo tên file duy nhất để tránh trùng lặp trên Drive.
 *
 * Pattern: {LoaiDoc}_{MaNV}_{Timestamp}_{TenFile}.pdf
 * Ví dụ:   HD_NV001_20250710-143022_HopDong_Q3_2025.pdf
 *
 * @param {string} safeName     - Tên file đã được sanitize
 * @param {string} uploaderMaNV - Mã NV người upload
 * @param {Object} metaData     - Metadata từ frontend
 * @returns {string}
 */
function _buildUniqueFileName(safeName, uploaderMaNV, metaData) {
  // Prefix loại tài liệu
  const typePrefix = {
    "hop-dong"  : "HD",
    "bien-ban"  : "BB",
    "van-ban-hc": "VB",
  }[metaData.loaiTaiLieu ?? ""] ?? "TL";

  // Timestamp dạng YYYYMMdd-HHmmss (múi giờ Việt Nam UTC+7)
  const now      = new Date();
  const vnOffset = 7 * 60 * 60 * 1000;
  const vnTime   = new Date(now.getTime() + vnOffset);
  const ts       = vnTime.toISOString()
    .replace(/T/, "-")
    .replace(/:/g, "")
    .slice(0, 15);           // "20250710-143022"

  // Bỏ đuôi .pdf khỏi safeName để ghép lại
  const baseName = safeName.replace(/\.pdf$/i, "");

  // Rút gọn baseName nếu quá dài (Drive giới hạn 255 ký tự tổng)
  const maxBase  = 80;
  const trimmed  = baseName.length > maxBase ? baseName.substring(0, maxBase) : baseName;

  const maNVPart = (uploaderMaNV || "XX").replace(/[^A-Za-z0-9]/g, "");

  return `${typePrefix}_${maNVPart}_${ts}_${trimmed}.pdf`;
}

/**
 * Làm sạch tên file — loại bỏ ký tự nguy hiểm, giữ ký tự an toàn.
 * Trả về null nếu tên file sau khi làm sạch bị rỗng.
 *
 * @param {string} raw - Tên file gốc từ người dùng
 * @returns {string|null}
 */
function _sanitizeFileName(raw) {
  if (!raw || typeof raw !== "string") return null;

  const trimmed = raw.trim();

  // Chỉ giữ: chữ cái (kể cả Unicode tiếng Việt), số, dấu cách, -, _, .
  // Loại bỏ: /, \, :, *, ?, ", <, >, |, và các ký tự điều khiển
  const safe = trimmed
    .replace(/[\/\\:*?"<>|]/g, "")   // Ký tự cấm trong tên file Windows/Drive
    .replace(/[\x00-\x1F\x7F]/g, "") // Ký tự điều khiển ASCII
    .replace(/\.{2,}/g, ".")          // Nhiều dấu chấm liên tiếp → 1 dấu chấm
    .replace(/\s+/g, "_")             // Khoảng trắng → gạch dưới
    .trim();

  return safe.length > 0 ? safe : null;
}

/**
 * Format bytes thành chuỗi đọc được.
 *
 * @param {number} bytes
 * @returns {string} VD: "2.45 MB"
 */
function _formatFileSize(bytes) {
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1048576)     return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824)  return `${(bytes / 1048576).toFixed(2)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

/**
 * Tạo response lỗi chuẩn hóa cho module Upload.
 *
 * @param {string} message - Thông báo lỗi
 * @param {string} code    - Mã lỗi để frontend xử lý
 * @returns {Object}
 */
function _uploadError(message, code) {
  Logger.log(`[uploadTempFile] ❌ Lỗi [${code}]: ${message}`);
  return {
    success      : false,
    fileId       : null,
    fileUrl      : null,
    driveUrl     : null,
    downloadUrl  : null,
    uploadedName : null,
    folderPath   : null,
    error        : message,
    meta         : {
      action    : code,
      timestamp : new Date().toISOString(),
    },
  };
}


// -----------------------------------------------------------------------------
// PHẦN 30: GHI LOG VÀO SHEET DATA
// -----------------------------------------------------------------------------

const DATA_SHEET_HEADERS = [
  "Ngày tạo", "Mã TL", "Tên TL", "Loại", "Dự án",
  "Thực hiện", "URL", "Kích thước", "Người tạo", "Trạng thái",
  "Cấu hình người ký", "Bước hiện tại", "Lịch sử ký", "Vị trí ký", "File ID"
];

function _ensureDataSheetHeaders() {
  const sheet = getSheet(SHEET_NAMES.DATA);
  const numCols = DATA_SHEET_HEADERS.length;
  const existing = sheet.getRange(1, 1, 1, numCols).getValues()[0];
  let changed = false;
  for (let i = 0; i < numCols; i++) {
    if (String(existing[i]).trim() === "") {
      existing[i] = DATA_SHEET_HEADERS[i];
      changed = true;
    }
  }
  if (changed) {
    sheet.getRange(1, 1, 1, numCols).setValues([existing]);
    Logger.log("[_ensureDataSheetHeaders] Đã bổ sung header thiếu cho sheet Data.");
  }
}

/**
 * Ghi thông tin file vừa upload vào sheet "Data" để tracking.
 * Hàng mới gồm: Ngày | Mã TL | Tên TL | Loại | File ID | URL | Người upload | Trạng thái
 *
 * Hàm này KHÔNG ném lỗi — mọi exception được bắt và chỉ log.
 *
 * @param {string} fileId         - Google Drive File ID
 * @param {string} fileName       - Tên file đã lưu trên Drive
 * @param {number} sizeBytes      - Kích thước thực tế
 * @param {string} uploaderEmail  - Email người upload
 * @param {Object} metaData       - Metadata từ frontend
 * @param {string} fileUrl        - URL preview
 */
function _logUploadToSheet(fileId, fileName, sizeBytes, uploaderEmail, metaData, driveUrl, uploaderName) {
  try {
    _ensureDataSheetHeaders();
    const sheet = getSheet(SHEET_NAMES.DATA);
    const lastRow = sheet.getLastRow();

    // [MỚI] Ưu tiên Mã TL do người dùng tự đặt; rỗng → tự sinh
    const userMaTL = String(metaData.maTL ?? "").trim();
    const maDoc = userMaTL || _generateDocumentCode(metaData.loaiTaiLieu);

    // [LAYOUT sheet Data — GIỮ "Cấu hình người ký" trong Data vì luồng ký
    //  (getPendingDocsForUser/signDocument) phụ thuộc chặt vào cột này]
    //  A Logs/Ngày  B Mã TL  C Tên TL  D Loại  E Dự án
    //  F Thực hiện = TÊN NGƯỜI/TỔ CHỨC GỬI (không phải tên file)
    //  G URL       = URL file trên Drive (gộp, bỏ cột File ID & cột URL trùng)
    //  H Kích thước  I Người tạo (email)  J Trạng thái
    //  K Cấu hình người ký (JSON)  L Bước hiện tại  M Lịch sử ký (JSON)
    //  N Vị trí ký (sigFrames JSON)  O File ID (ẩn, phục vụ tra cứu/ký)
    const signerConfigStr = metaData.signerConfig
      ? JSON.stringify(metaData.signerConfig)
      : "";

    const newRow = [
      new Date(),                          // A — Logs / Ngày tạo
      maDoc,                               // B — Mã tài liệu (STT)
      metaData.tenTaiLieu  || "",          // C — Tên tài liệu
      metaData.loaiTaiLieu || "",          // D — Loại tài liệu
      metaData.tenDuAn     || "",          // E — Tên dự án
      uploaderName || uploaderEmail || "", // F — Thực hiện (người/tổ chức gửi)
      driveUrl,                            // G — URL file trên Drive
      _formatFileSize(sizeBytes),          // H — Kích thước
      uploaderEmail,                       // I — Người tạo (email)
      "Chờ ký",                            // J — Trạng thái ban đầu
      signerConfigStr,                     // K — Cấu hình người ký (JSON)
      0,                                   // L — Bước hiện tại
      "[]",                                // M — Lịch sử ký (JSON)
      metaData.sigFrames                   // N — Vị trí ký (sigFrames JSON)
        ? JSON.stringify(metaData.sigFrames) : "[]",
      fileId || "",                        // O — File ID (tra cứu / xử lý ký)
    ];

    sheet.getRange(lastRow + 1, 1, 1, newRow.length).setValues([newRow]);

    Logger.log(`[_logUploadToSheet] ✅ Ghi log hàng ${lastRow + 1}: Mã ${maDoc}`);
    return maDoc;

  } catch (err) {
    Logger.log(`[_logUploadToSheet] ⚠️  Lỗi ghi sheet: ${err.message}`);
    return null;
  }
}

/**
 * Sinh mã tài liệu chính thức theo định dạng: {PREFIX}-{YYYY}-{SEQ5}.
 * Đọc sheet Data để lấy số thứ tự tăng dần.
 *
 * Ví dụ: HĐ-2025-00042
 *
 * @param {string} loaiTaiLieu - Loại tài liệu từ frontend
 * @returns {string} Mã tài liệu duy nhất
 */
function _generateDocumentCode(loaiTaiLieu) {
  const prefixMap = {
    "hop-dong"  : "HĐ",
    "bien-ban"  : "BB",
    "van-ban-hc": "VB",
  };
  const prefix = prefixMap[loaiTaiLieu] ?? "TL";
  const year   = new Date().getFullYear();

  try {
    const sheet   = getSheet(SHEET_NAMES.DATA);
    const lastRow = Math.max(sheet.getLastRow(), 1); // Header ở row 1
    const seq     = String(lastRow).padStart(5, "0"); // 00001, 00002, ...
    return `${prefix}-${year}-${seq}`;
  } catch (_) {
    // Fallback nếu sheet không đọc được
    const rand = String(Math.floor(Math.random() * 99000) + 1000).padStart(5, "0");
    return `${prefix}-${year}-${rand}`;
  }
}


// -----------------------------------------------------------------------------
// PHẦN 31: QUẢN LÝ FILE DRIVE — XÓA & THÔNG TIN
// -----------------------------------------------------------------------------

/**
 * Xóa file tạm trên Drive sau khi quy trình ký hoàn tất hoặc bị hủy.
 * Chỉ Admin hoặc người upload mới được xóa.
 *
 * Frontend gọi:
 *   google.script.run
 *     .withSuccessHandler(res => console.log(res))
 *     .deleteTempFile(token, fileId);
 *
 * @param {string} sessionToken - Token phiên
 * @param {string} fileId       - Google Drive File ID cần xóa
 * @returns {{ success: boolean, error: string|null }}
 */
function deleteTempFile(sessionToken, fileId) {
  const auth = requirePermission(sessionToken, "Tạo tài liệu");
  if (!auth.allowed) return _buildResponse(false, null, auth.error, "DELETE_FILE_UNAUTHORIZED");

  if (!fileId || typeof fileId !== "string") {
    return _buildResponse(false, null, "File ID không hợp lệ.", "DELETE_FILE_NO_ID");
  }

  try {
    const file = DriveApp.getFileById(fileId);

    // Kiểm tra quyền sở hữu: chỉ Admin hoặc chủ file được xóa
    const session     = _verifySession(sessionToken);
    const userEmail   = session.user?.["Email"] ?? "";
    const fileOwner   = file.getOwner()?.getEmail() ?? "";
    const isAdmin     = auth.role === "Admin";
    const isOwner     = userEmail.toLowerCase() === fileOwner.toLowerCase();

    if (!isAdmin && !isOwner) {
      return _buildResponse(false, null, "Bạn không có quyền xóa file này.", "DELETE_FILE_FORBIDDEN");
    }

    const fileName = file.getName();
    file.setTrashed(true); // Chuyển vào Thùng rác thay vì xóa vĩnh viễn

    Logger.log(`[deleteTempFile] ✅ Đã xóa (trash) "${fileName}" (${fileId}) bởi ${userEmail}`);
    return _buildResponse(true, { fileId, fileName }, null, "DELETE_FILE_SUCCESS");

  } catch (err) {
    Logger.log(`[deleteTempFile] ❌ Lỗi: ${err.message}`);
    return _buildResponse(false, null, `Không thể xóa file: ${err.message}`, "DELETE_FILE_ERROR");
  }
}

/**
 * Lấy thông tin file từ Drive theo File ID.
 * Hữu ích để frontend verify file vẫn tồn tại trước khi ký.
 *
 * @param {string} sessionToken
 * @param {string} fileId
 * @returns {Object}
 */
function getDriveFileInfo(sessionToken, fileId) {
  const auth = requirePermission(sessionToken, "Xem tài liệu");
  if (!auth.allowed) return _buildResponse(false, null, auth.error, "GET_FILE_UNAUTHORIZED");

  if (!fileId) return _buildResponse(false, null, "Thiếu File ID.", "GET_FILE_NO_ID");

  try {
    const file = DriveApp.getFileById(fileId);
    return _buildResponse(true, {
      fileId       : file.getId(),
      name         : file.getName(),
      mimeType     : file.getMimeType(),
      sizeBytes    : file.getSize(),
      sizeHuman    : _formatFileSize(file.getSize()),
      createdDate  : file.getDateCreated().toISOString(),
      modifiedDate : file.getLastUpdated().toISOString(),
      owner        : file.getOwner()?.getEmail() ?? "—",
      url          : `https://drive.google.com/file/d/${file.getId()}/view`,
      downloadUrl  : `https://drive.google.com/uc?export=download&id=${file.getId()}`,
      isTrashed    : file.isTrashed(),
    }, null, "GET_FILE_SUCCESS");
  } catch (err) {
    return _buildResponse(false, null, `Không tìm thấy file (ID: ${fileId}).`, "GET_FILE_NOT_FOUND");
  }
}

/**
 * Trả về nội dung file Drive dạng base64 (để frontend nạp PDF vào pdf-lib
 * cho luồng ký — vì sandbox GAS không fetch trực tiếp Drive được do CORS).
 *
 * @param {string} sessionToken
 * @param {string} fileId
 * @returns {{success:boolean, data:{base64,mimeType,name,sizeBytes}|null, error}}
 */
function getDriveFileBase64(sessionToken, fileId) {
  const auth = requirePermission(sessionToken, "Xem tài liệu");
  if (!auth.allowed) return _buildResponse(false, null, auth.error, "GET_B64_UNAUTHORIZED");

  if (!fileId) return _buildResponse(false, null, "Thiếu File ID.", "GET_B64_NO_ID");

  try {
    const file = DriveApp.getFileById(fileId);
    const blob = file.getBlob();
    const base64 = Utilities.base64Encode(blob.getBytes());
    Logger.log(`[getDriveFileBase64] ✅ ${file.getName()} → ${base64.length} chars base64.`);
    return _buildResponse(true, {
      base64    : base64,
      mimeType  : file.getMimeType(),
      name      : file.getName(),
      sizeBytes : file.getSize(),
    }, null, "GET_B64_SUCCESS");
  } catch (err) {
    Logger.log(`[getDriveFileBase64] Lỗi: ${err.message}`);
    return _buildResponse(false, null, `Không đọc được file (ID: ${fileId}): ${err.message}`, "GET_B64_ERROR");
  }
}


// -----------------------------------------------------------------------------
// PHẦN 32: HÀM TEST MODULE UPLOAD
// -----------------------------------------------------------------------------

/**
 * Test module upload — chạy trong Apps Script Editor.
 * Tạo một file PDF nhỏ thật sự trên Drive để verify toàn bộ luồng.
 * ⚠️  Chỉ chạy trong Editor, KHÔNG deploy.
 */
function testUploadModule() {
  Logger.log("════════════════════════════════════════\n  TEST UPLOAD MODULE  v1.0\n════════════════════════════════════════\n");

  // ── T01: _sanitizeFileName ────────────────────────────────────────────────
  Logger.log("── T01: _sanitizeFileName ──");
  const fileTests = [
    ["Hợp Đồng Q3.pdf",             "Hợp_Đồng_Q3.pdf"],
    ["file/with\\slash.pdf",         "filewithslash.pdf"],
    ["normal-file_name (2).pdf",     "normal-file_name_(2).pdf"],
    ["../../../etc/passwd",           "......etcpasswd"],
    ["   spaces   .pdf",             "spaces___.pdf"],
    ["",                              null],
  ];
  fileTests.forEach(([input, expected]) => {
    const result = _sanitizeFileName(input);
    const ok     = result === expected;
    Logger.log(`  ${ok?"✅":"❌"} "${input}" → "${result}" (expect: "${expected}")`);
  });

  // ── T02: _formatFileSize ──────────────────────────────────────────────────
  Logger.log("\n── T02: _formatFileSize ──");
  [[512,"512 B"],[1536,"1.5 KB"],[2097152,"2.00 MB"],[1073741824,"1.00 GB"]].forEach(([n,e])=>{
    const r=_formatFileSize(n); Logger.log(`  ${r===e?"✅":"❌"} ${n} → "${r}"`);
  });

  // ── T03: _buildUniqueFileName ─────────────────────────────────────────────
  Logger.log("\n── T03: _buildUniqueFileName ──");
  const uName = _buildUniqueFileName("HopDong_Q3_2025.pdf", "NV001", { loaiTaiLieu:"hop-dong" });
  Logger.log(`  Kết quả: "${uName}"`);
  Logger.log(`  ✅ Bắt đầu bằng "HD_": ${uName.startsWith("HD_")}`);
  Logger.log(`  ✅ Chứa NV001: ${uName.includes("NV001")}`);
  Logger.log(`  ✅ Kết thúc bằng .pdf: ${uName.endsWith(".pdf")}`);

  // ── T04: _getOrCreateFolder ───────────────────────────────────────────────
  Logger.log("\n── T04: _getOrCreateFolder (tạo thư mục thật) ──");
  try {
    const testFolderName = "eSign_Test_" + Date.now();
    const folder = _getOrCreateFolder(null, testFolderName);
    Logger.log(`  ✅ Tạo thư mục: "${folder.getName()}" (ID: ${folder.getId()})`);
    folder.setTrashed(true); // Dọn dẹp
    Logger.log("  ✅ Đã xóa thư mục test.");
  } catch (e) {
    Logger.log(`  ❌ Lỗi: ${e.message}`);
  }

  // ── T05: uploadTempFile với PDF nhỏ (không cần auth) ─────────────────────
  Logger.log("\n── T05: _generateDocumentCode ──");
  ["hop-dong","bien-ban","van-ban-hc","unknown"].forEach(type => {
    Logger.log(`  ${type} → ${_generateDocumentCode(type)}`);
  });

  // ── T06: Giải mã base64 PDF tối thiểu ────────────────────────────────────
  Logger.log("\n── T06: Giải mã base64 PDF 1-trang tối thiểu ──");
  try {
    // PDF hợp lệ tối thiểu (1 trang trắng, ~700 bytes)
    const minPdfB64 = "JVBERi0xLjAKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSA+PgplbmRvYmoKeHJlZgowIDQKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNjIgMDAwMDAgbiAKMDAwMDAwMDExOCAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDQgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjE5NgolJUVPRgo=";
    const blob = Utilities.newBlob(Utilities.base64Decode(minPdfB64), "application/pdf", "test.pdf");
    Logger.log(`  ✅ Giải mã OK. Kích thước: ${_formatFileSize(blob.getBytes().length)}`);
  } catch (e) {
    Logger.log(`  ❌ Lỗi giải mã: ${e.message}`);
  }

  Logger.log("\n════════════════════════════════════════\n  TEST HOÀN TẤT\n════════════════════════════════════════");
}


// =============================================================================
// MODULE TÀI LIỆU CHỜ KÝ (PENDING SIGNATURE MODULE)  v1.0
// =============================================================================


// -----------------------------------------------------------------------------
// PHẦN 33: HẰNG SỐ VÀ CẤU HÌNH
// -----------------------------------------------------------------------------

/**
 * Trạng thái tài liệu trong sheet Data.
 * Hệ thống tracking dựa hoàn toàn vào cột Trạng thái + cột Cấu hình người ký.
 */
const DOC_STATUS = {
  CHO_KY      : "Chờ ký",        // Đang trong quy trình ký
  DA_KY       : "Đã ký",         // Tất cả các bên đã ký
  TU_CHOI     : "Từ chối",       // Có người ký từ chối
  NHAP        : "Nháp",          // Chưa gửi đi ký
  HUY         : "Đã hủy",        // Đã bị hủy
};

/**
 * Tên cột trong sheet Data (sẽ đọc header động — chỉ dùng làm tham chiếu).
 * Thứ tự: Ngày tạo | Mã TL | Tên TL | Loại | DA | Tên file | File ID | URL | Size | Người tạo | Trạng thái | Cấu hình người ký
 * Thêm cột bổ sung: Bước hiện tại | Lịch sử ký | Deadline | Ghi chú
 */
const DATA_COLS = {
  NGAY_TAO       : "Ngày tạo",
  MA_DOC         : "Mã TL",
  TEN_TAI_LIEU   : "Tên TL",
  LOAI_TAI_LIEU  : "Loại",
  TEN_DU_AN      : "Dự án",
  TEN_FILE       : "Tên file",
  DRIVE_FILE_ID  : "File ID",
  FILE_URL       : "URL",
  FILE_SIZE      : "Kích thước",
  NGUOI_TAO      : "Người tạo",
  TRANG_THAI     : "Trạng thái",
  SIGNER_CONFIG  : "Cấu hình người ký",
  SIG_FRAMES     : "Vị trí ký",        // JSON array sigFrames
  BUOC_HIEN_TAI  : "Bước hiện tại",    // Số bước đang chờ (0-based)
  LICH_SU_KY     : "Lịch sử ký",       // JSON array log ký
  DEADLINE       : "Deadline",          // ISO date
  GHI_CHU        : "Ghi chú",
};


// -----------------------------------------------------------------------------
// PHẦN 33B: HÀM TẠO BẢN GHI TÀI LIỆU MỚI (createDocument)
// -----------------------------------------------------------------------------

/**
 * Tạo bản ghi tài liệu mới trong sheet "Data" sau khi file đã upload Drive.
 *
 * Frontend gọi (Pha 3 của NewDocModule):
 *   GAS.call('createDocument', sessionToken, payload)
 *
 * payload = {
 *   loaiTaiLieu, tenTaiLieu, tenDuAn, ghiChu, signerConfig, sigFrames,
 *   nguoiTao, driveFileId, driveUrl, downloadUrl, uploadedName,
 *   fileSizeBytes, fileName
 * }
 *
 * @param {string} sessionToken
 * @param {Object} payload
 * @returns {{success:boolean, data:{maDoc,rowIndex,tenTaiLieu}|null, error:string|null, meta:Object}}
 */
function createDocument(sessionToken, payload) {

  // ── Bước 1: Xác thực phiên & quyền ──────────────────────────────────────────
  const auth = requirePermission(sessionToken, "Tạo tài liệu");
  if (!auth.allowed) {
    return _buildResponse(false, null, auth.error, "CREATE_UNAUTHORIZED");
  }

  // ── Bước 2: Validate ────────────────────────────────────────────────────────
  if (!payload || typeof payload !== "object") {
    return _buildResponse(false, null, "payload không hợp lệ.", "CREATE_INVALID_DATA");
  }
  const tenTaiLieu  = String(payload.tenTaiLieu  ?? "").trim();
  const driveFileId = String(payload.driveFileId ?? "").trim();

  // QUAN TRỌNG: Dòng tài liệu ĐÃ được tạo ở Pha 2 (uploadTempFile →
  // _logUploadToSheet). createDocument (Pha 3) KHÔNG ghi thêm dòng nữa
  // (tránh dòng rác) — chỉ tra cứu lại Mã TL của dòng vừa tạo trong sheet
  // "Data": khớp File ID (cột O, index 14) hoặc URL chứa File ID.
  try {
    const sheet = getSheet(SHEET_NAMES.DATA);
    const values = sheet.getDataRange().getValues();
    let maDoc = "";

    if (driveFileId && values.length > 1) {
      // Cột (0-based): B=1 Mã TL, G=6 URL, O=14 File ID
      for (let r = values.length - 1; r >= 1; r--) {            // quét từ dưới lên (mới nhất)
        const fileIdCell = String(values[r][14] ?? "").trim();
        const urlCell    = String(values[r][6]  ?? "");
        if (fileIdCell === driveFileId || urlCell.indexOf(driveFileId) !== -1) {
          maDoc = String(values[r][1] ?? "").trim();
          break;
        }
      }
    }

    if (!maDoc) {
      // Fallback: không tra được vẫn coi là thành công (dòng đã tạo ở Pha 2),
      // chỉ là không lấy được Mã TL để hiển thị.
      Logger.log(`[createDocument] ⚠️ Không tra được Mã TL theo File ID "${driveFileId}".`);
      return _buildResponse(true, { maDoc: "(đã tạo)", tenTaiLieu }, null, "CREATE_SUCCESS_NO_CODE");
    }

    Logger.log(`[createDocument] ✅ Xác nhận tài liệu "${tenTaiLieu}" → Mã TL ${maDoc}.`);
    return _buildResponse(true, { maDoc, tenTaiLieu }, null, "CREATE_SUCCESS");

  } catch (err) {
    Logger.log(`[createDocument] Lỗi tra cứu Mã TL: ${err.message}`);
    // Vẫn trả thành công vì dòng đã được tạo ở Pha 2.
    return _buildResponse(true, { maDoc: "(đã tạo)", tenTaiLieu }, null, "CREATE_SUCCESS_LOOKUP_ERR");
  }
}


// -----------------------------------------------------------------------------
// PHẦN 34: HÀM LẤY DANH SÁCH TÀI LIỆU CHỜ KÝ CỦA USER
// -----------------------------------------------------------------------------

/**
 * Lấy danh sách tài liệu đang đến lượt user hiện tại ký.
 *
 * Cơ chế tracking:
 *   1. Đọc toàn bộ sheet Data
 *   2. Lọc tài liệu có Trạng thái = "Chờ ký"
 *   3. Với mỗi tài liệu, parse cột "Cấu hình người ký" (JSON)
 *   4. Tìm bước ký hiện tại (Bước hiện tại), kiểm tra xem user có
 *      khớp với người ký tại bước đó không (so sánh Mã NV)
 *   5. Trả về danh sách tài liệu đang đến lượt user
 *
 * Frontend gọi:
 *   google.script.run
 *     .withSuccessHandler(res => renderPendingList(res.data))
 *     .getPendingDocsForUser(token);
 *
 * @param {string} sessionToken
 * @returns {{ success: boolean, data: Object[], meta: Object }}
 */
function getPendingDocsForUser(sessionToken) {

  // ── Xác thực phiên ─────────────────────────────────────────────────────────
  const auth = requirePermission(sessionToken, "Ký tài liệu");
  if (!auth.allowed) return _buildResponse(false, null, auth.error, "PENDING_UNAUTHORIZED");

  const session = _verifySession(sessionToken);
  const userEmail = session.user?.["Email"] ?? "";
  const userMaNV  = session.user?.["Mã NV"]  ?? "";

  if (!userEmail && !userMaNV) {
    return _buildResponse(false, null, "Không xác định được user.", "PENDING_NO_USER");
  }

  // ── Đảm bảo header đầy đủ trước khi đọc ────────────────────────────────────
  _ensureDataSheetHeaders();

  // ── Đọc sheet Data ──────────────────────────────────────────────────────────
  let allData;
  try {
    allData = getSheetDataAsJson(SHEET_NAMES.DATA);
    if (!allData.success) return _buildResponse(false, null, allData.error, "PENDING_READ_ERROR");
  } catch (err) {
    return _buildResponse(false, null, `Lỗi đọc sheet Data: ${err.message}`, "PENDING_READ_ERROR");
  }

  // ── Lọc tài liệu đến lượt user ký ─────────────────────────────────────────
  const pendingDocs = [];

  for (const row of allData.data) {
    // Chỉ xét tài liệu đang "Chờ ký"
    const trangThai = String(row[DATA_COLS.TRANG_THAI] ?? "").trim();
    if (trangThai !== DOC_STATUS.CHO_KY) continue;

    // Parse cấu hình người ký
    const signerConfigRaw = row[DATA_COLS.SIGNER_CONFIG];
    if (!signerConfigRaw) continue;

    let signerConfig;
    try {
      signerConfig = typeof signerConfigRaw === "string"
        ? JSON.parse(signerConfigRaw)
        : signerConfigRaw;
    } catch (_) { continue; }

    // Xác định bước hiện tại
    const buocHienTai = parseInt(row[DATA_COLS.BUOC_HIEN_TAI] ?? "0", 10) || 0;

    // Kiểm tra user có phải người ký tại bước này không
    let isMyTurn = false;

    if (signerConfig.mode === "single" && signerConfig.single) {
      const s = signerConfig.single;
      isMyTurn = (s.maNV === userMaNV) || ((s.email ?? "").toLowerCase() === userEmail.toLowerCase());
    } else if (signerConfig.mode === "multi" && Array.isArray(signerConfig.steps)) {
      const stepData = signerConfig.steps[buocHienTai];
      if (stepData) {
        isMyTurn = (stepData.maNV === userMaNV) ||
                   ((stepData.email ?? "").toLowerCase() === userEmail.toLowerCase());
      }
    }

    if (!isMyTurn) continue;

    // Build response object — loại bỏ thông tin nhạy cảm
    pendingDocs.push({
      maDoc         : row[DATA_COLS.MA_DOC]         ?? "",
      tenTaiLieu    : row[DATA_COLS.TEN_TAI_LIEU]   ?? "",
      loaiTaiLieu   : row[DATA_COLS.LOAI_TAI_LIEU]  ?? "",
      tenDuAn       : row[DATA_COLS.TEN_DU_AN]      ?? "",
      nguoiTao      : row[DATA_COLS.NGUOI_TAO]      ?? "",
      ngayTao       : row[DATA_COLS.NGAY_TAO]       ?? "",
      ngayCapNhat   : null,
      tenFile       : row[DATA_COLS.TEN_FILE]       ?? "",
      fileSize      : row[DATA_COLS.FILE_SIZE]      ?? "",
      fileId        : row[DATA_COLS.DRIVE_FILE_ID]  ?? "",
      fileUrl       : row[DATA_COLS.FILE_URL]       ?? "",
      driveUrl      : row[DATA_COLS.DRIVE_FILE_ID]
                      ? `https://drive.google.com/file/d/${row[DATA_COLS.DRIVE_FILE_ID]}/view`
                      : null,
      deadline      : row[DATA_COLS.DEADLINE]       ?? null,
      signerConfig  : signerConfigRaw,
      sigFrames     : row[DATA_COLS.SIG_FRAMES]     ?? "[]",
      completedSteps: buocHienTai,
      trangThai,
      _rowIndex     : row["_rowIndex"],
    });
  }

  Logger.log(
    `[getPendingDocsForUser] User "${userEmail}" có ${pendingDocs.length} tài liệu chờ ký.`
  );

  return _buildResponse(true, pendingDocs, null, "PENDING_SUCCESS");
}


// -----------------------------------------------------------------------------
// PHẦN 35: HÀM THỰC HIỆN KÝ TÀI LIỆU
// -----------------------------------------------------------------------------

/**
 * Ghi nhận chữ ký của user và chuyển trạng thái tài liệu.
 *
 * Logic xử lý:
 *   1. Xác thực quyền & phiên
 *   2. Tìm dòng tài liệu trong sheet Data theo Mã TL
 *   3. Kiểm tra user có thực sự đến lượt ký không (server-side verify)
 *   4. Ghi log vào cột "Lịch sử ký"
 *   5. Tăng "Bước hiện tại" lên 1
 *   6. Nếu đây là bước cuối → đổi Trạng thái = "Đã ký"
 *      Nếu chưa phải bước cuối → giữ "Chờ ký" (bước tiếp theo sẽ đến lượt)
 *
 * @param {string} sessionToken
 * @param {{ maDoc: string, ghiChuKy: string, ngayKy: string }} payload
 * @returns {Object}
 */
function signDocument(sessionToken, payload) {

  // ── Xác thực phiên & quyền ─────────────────────────────────────────────────
  const auth = requirePermission(sessionToken, "Ký tài liệu");
  if (!auth.allowed) return _buildResponse(false, null, auth.error, "SIGN_UNAUTHORIZED");

  const session   = _verifySession(sessionToken);
  const userEmail = session.user?.["Email"] ?? "";
  const userMaNV  = session.user?.["Mã NV"]  ?? "";
  const userHoTen = session.user?.["Họ tên"] ?? "";
  const maDoc     = (payload?.maDoc ?? "").trim();

  if (!maDoc) return _buildResponse(false, null, "Thiếu Mã TL.", "SIGN_NO_DOC_ID");

  // ── Đọc sheet Data & tìm dòng ──────────────────────────────────────────────
  let ctx;
  try {
    ctx = _readDataSheetContext();
  } catch (err) {
    return _buildResponse(false, null, `Lỗi đọc sheet Data: ${err.message}`, "SIGN_READ_ERROR");
  }

  const found = _findDocByMaDoc(ctx, maDoc);
  if (!found) {
    return _buildResponse(false, null, `Không tìm thấy tài liệu "${maDoc}".`, "SIGN_DOC_NOT_FOUND");
  }

  const { sheetRow, rowData, colMap } = found;

  // ── Kiểm tra trạng thái ─────────────────────────────────────────────────────
  const trangThai = String(rowData[colMap[DATA_COLS.TRANG_THAI]] ?? "").trim();
  if (trangThai !== DOC_STATUS.CHO_KY) {
    return _buildResponse(false, null,
      `Tài liệu đang ở trạng thái "${trangThai}" — không thể ký.`, "SIGN_WRONG_STATUS");
  }

  // ── Server-side verify: user đúng lượt không ─────────────────────────────
  const signerConfigRaw = String(rowData[colMap[DATA_COLS.SIGNER_CONFIG]] ?? "");
  const buocHienTai     = parseInt(rowData[colMap[DATA_COLS.BUOC_HIEN_TAI]] ?? "0", 10) || 0;
  let   totalSteps      = 1;
  let   isMyTurn        = false;

  try {
    const cfg = JSON.parse(signerConfigRaw);
    if (cfg.mode === "single" && cfg.single) {
      totalSteps = 1;
      isMyTurn   = (cfg.single.maNV === userMaNV) ||
                   ((cfg.single.email ?? "").toLowerCase() === userEmail.toLowerCase());
    } else if (cfg.mode === "multi" && Array.isArray(cfg.steps)) {
      totalSteps = cfg.steps.length;
      const step = cfg.steps[buocHienTai];
      if (step) {
        isMyTurn = (step.maNV === userMaNV) ||
                   ((step.email ?? "").toLowerCase() === userEmail.toLowerCase());
      }
    }
  } catch (parseErr) {
    return _buildResponse(false, null, "Dữ liệu cấu hình người ký bị lỗi.", "SIGN_CONFIG_ERROR");
  }

  if (!isMyTurn) {
    return _buildResponse(false, null,
      "Chưa đến lượt bạn ký tài liệu này.", "SIGN_NOT_YOUR_TURN");
  }

  // ── Ghi log chữ ký ────────────────────────────────────────────────────────
  const ngayKy = payload?.ngayKy ?? new Date().toISOString();
  const logEntry = {
    buoc      : buocHienTai + 1,
    maNV      : userMaNV,
    email     : userEmail,
    hoTen     : userHoTen,
    ngayKy    : ngayKy,
    ghiChu    : payload?.ghiChuKy ?? "",
  };

  const lichSuKyRaw = String(rowData[colMap[DATA_COLS.LICH_SU_KY]] ?? "");
  let lichSuKy      = [];
  try { lichSuKy = lichSuKyRaw ? JSON.parse(lichSuKyRaw) : []; } catch (_) {}
  lichSuKy.push(logEntry);

  // ── Tính trạng thái mới ────────────────────────────────────────────────────
  const newBuoc      = buocHienTai + 1;
  const isLastStep   = newBuoc >= totalSteps;
  const newStatus    = isLastStep ? DOC_STATUS.DA_KY : DOC_STATUS.CHO_KY;

  // ── Ghi vào sheet ─────────────────────────────────────────────────────────
  try {
    const sheet = ctx.sheet;

    // Ghi từng ô cần cập nhật (tránh ghi đè toàn dòng)
    const updates = [
      [DATA_COLS.TRANG_THAI,      newStatus],
      [DATA_COLS.BUOC_HIEN_TAI,   newBuoc],
      [DATA_COLS.LICH_SU_KY,      JSON.stringify(lichSuKy)],
    ];

    updates.forEach(([colName, value]) => {
      const colIdx = colMap[colName];
      if (colIdx !== undefined) {
        sheet.getRange(sheetRow, colIdx + 1).setValue(value);
      }
    });

    Logger.log(
      `[signDocument] ✅ Ký thành công: "${maDoc}" Bước ${buocHienTai+1}/${totalSteps} ` +
      `bởi ${userEmail}. Trạng thái mới: ${newStatus}`
    );

    return _buildResponse(true, {
      maDoc,
      buocDaKy    : newBuoc,
      totalSteps,
      trangThai   : newStatus,
      isComplete  : isLastStep,
      ngayKy,
    }, null, "SIGN_SUCCESS");

  } catch (writeErr) {
    Logger.log(`[signDocument] ❌ Lỗi ghi sheet: ${writeErr.message}`);
    return _buildResponse(false, null, `Lỗi ghi dữ liệu: ${writeErr.message}`, "SIGN_WRITE_ERROR");
  }
}


// -----------------------------------------------------------------------------
// PHẦN 36: HÀM TỪ CHỐI KÝ TÀI LIỆU
// -----------------------------------------------------------------------------

/**
 * Người ký từ chối — cập nhật trạng thái tài liệu thành "Từ chối" và ghi lý do.
 *
 * @param {string} sessionToken
 * @param {{ maDoc: string, lyDo: string }} payload
 * @returns {Object}
 */
function rejectDocument(sessionToken, payload) {
  const auth = requirePermission(sessionToken, "Ký tài liệu");
  if (!auth.allowed) return _buildResponse(false, null, auth.error, "REJECT_UNAUTHORIZED");

  const session   = _verifySession(sessionToken);
  const userEmail = session.user?.["Email"] ?? "";
  const userMaNV  = session.user?.["Mã NV"]  ?? "";
  const maDoc     = (payload?.maDoc ?? "").trim();
  const lyDo      = (payload?.lyDo ?? "Không có lý do.").trim();

  if (!maDoc) return _buildResponse(false, null, "Thiếu Mã TL.", "REJECT_NO_DOC_ID");

  let ctx;
  try { ctx = _readDataSheetContext(); }
  catch (err) { return _buildResponse(false, null, err.message, "REJECT_READ_ERROR"); }

  const found = _findDocByMaDoc(ctx, maDoc);
  if (!found) return _buildResponse(false, null, `Không tìm thấy "${maDoc}".`, "REJECT_NOT_FOUND");

  const { sheetRow, rowData, colMap } = found;

  const trangThai = String(rowData[colMap[DATA_COLS.TRANG_THAI]] ?? "");
  if (trangThai !== DOC_STATUS.CHO_KY) {
    return _buildResponse(false, null,
      `Tài liệu đang ở trạng thái "${trangThai}" — không thể từ chối.`, "REJECT_WRONG_STATUS");
  }

  // Ghi log từ chối
  const lichSuKyRaw = String(rowData[colMap[DATA_COLS.LICH_SU_KY]] ?? "");
  let lichSuKy = [];
  try { lichSuKy = lichSuKyRaw ? JSON.parse(lichSuKyRaw) : []; } catch (_) {}
  lichSuKy.push({
    action   : "TU_CHOI",
    maNV     : userMaNV,
    email    : userEmail,
    ngayKy   : new Date().toISOString(),
    lyDo,
  });

  try {
    const sheet = ctx.sheet;
    const updates = [
      [DATA_COLS.TRANG_THAI,    DOC_STATUS.TU_CHOI],
      [DATA_COLS.LICH_SU_KY,   JSON.stringify(lichSuKy)],
      [DATA_COLS.GHI_CHU,      `Từ chối bởi ${userEmail}: ${lyDo}`],
    ];
    updates.forEach(([col, val]) => {
      const idx = colMap[col];
      if (idx !== undefined) sheet.getRange(sheetRow, idx + 1).setValue(val);
    });

    Logger.log(`[rejectDocument] ✅ "${maDoc}" bị từ chối bởi ${userEmail}. Lý do: ${lyDo}`);
    return _buildResponse(true, { maDoc, trangThai: DOC_STATUS.TU_CHOI }, null, "REJECT_SUCCESS");
  } catch (err) {
    return _buildResponse(false, null, `Lỗi ghi sheet: ${err.message}`, "REJECT_WRITE_ERROR");
  }
}


// -----------------------------------------------------------------------------
// PHẦN 37: HELPER ĐỌC SHEET DATA CONTEXT VÀ TÌM DÒNG
// -----------------------------------------------------------------------------

/**
 * Đọc toàn bộ sheet Data thành context object (giống _readNguoiDungContext).
 * @returns {{ sheet, headers, colMap, values, dataValues }}
 */
function _readDataSheetContext() {
  const sheet   = getSheet(SHEET_NAMES.DATA);
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();

  if (lastRow < 2) return { sheet, headers:[], colMap:{}, values:[[]], dataValues:[] };

  const values  = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = values[0].map(h => String(h).trim());
  const colMap  = {};
  headers.forEach((h, i) => { if (h) colMap[h] = i; });

  return { sheet, headers, colMap, values, dataValues: values.slice(1) };
}

/**
 * Tìm dòng tài liệu theo Mã TL trong sheet Data.
 * @param {{ colMap, dataValues, sheet }} ctx
 * @param {string} maDoc
 * @returns {{ sheetRow, rowData, colMap }|null}
 */
function _findDocByMaDoc(ctx, maDoc) {
  const { colMap, dataValues, sheet } = ctx;
  const maIdx = colMap[DATA_COLS.MA_DOC];
  if (maIdx === undefined) return null;

  for (let i = 0; i < dataValues.length; i++) {
    const rowMa = String(dataValues[i][maIdx] ?? "").trim();
    if (rowMa === maDoc) {
      return { sheetRow: i + 2, rowData: dataValues[i], colMap, sheet };
    }
  }
  return null;
}


// =============================================================================
// MODULE LƯU TÀI LIỆU ĐÃ KÝ CHÍNH THỨC (FINAL SIGNED FILE MODULE)  v1.0
// =============================================================================


// -----------------------------------------------------------------------------
// PHẦN 38: CẤU HÌNH THƯ MỤC TÀI LIỆU ĐÃ KÝ
// -----------------------------------------------------------------------------

/**
 * Tên thư mục chứa tài liệu đã được ký hoàn tất.
 * Khác với DRIVE_FOLDER_NAME ("Tai_Lieu_Cho_Ky") — thư mục tạm trong lúc ký.
 * Cấu trúc: My Drive/Tai_Lieu_Da_Ky/YYYY-MM/
 */
const SIGNED_FOLDER_NAME = "Tai_Lieu_Da_Ky";

/**
 * Quyền chia sẻ mặc định cho file đã ký.
 * "DOMAIN"  → Mọi người trong tổ chức (Google Workspace) có thể xem.
 * "PRIVATE" → Chỉ người tạo và người được chia sẻ trực tiếp.
 * Đặt "PRIVATE" nếu file chứa thông tin nhạy cảm.
 */
const SIGNED_FILE_SHARING = "PRIVATE";

/**
 * Kích thước tối đa PDF đã ký có thể nhận (bytes).
 * Lớn hơn file gốc một chút vì đã nhúng stamp + metadata XMP.
 * 30 MB = thoải mái cho PDF tối đa 20 MB sau khi nhúng.
 */
const MAX_SIGNED_FILE_BYTES = 30 * 1024 * 1024; // 30 MB


// -----------------------------------------------------------------------------
// PHẦN 39: HÀM CHÍNH — saveFinalSignedFile
// -----------------------------------------------------------------------------

/**
 * ★ HÀM LƯU FILE ĐÃ KÝ CHÍNH THỨC ★
 *
 * Nhận PDF đã ký (base64, đã có stamp visual từ PdfStamper + chữ ký số từ
 * USB Token), lưu vào thư mục "Tai_Lieu_Da_Ky/<YYYY-MM>" trên Google Drive,
 * thiết lập quyền chia sẻ phù hợp, cập nhật trạng thái trong sheet Data,
 * và trả về URL file đích.
 *
 * Luồng:
 *   1.  Xác thực phiên & quyền
 *   2.  Validate base64 + tên file
 *   3.  Giải mã base64 → Blob PDF
 *   4.  Kiểm tra kích thước
 *   5.  Lấy / tạo thư mục "Tai_Lieu_Da_Ky/<YYYY-MM>"
 *   6.  Tạo tên file duy nhất (tránh trùng lặp)
 *   7.  Tạo file trên Drive
 *   8.  Thiết lập quyền chia sẻ (Domain hoặc Private)
 *   9.  Xóa file tạm trong "Tai_Lieu_Cho_Ky" (nếu có fileId tạm)
 *  10.  Cập nhật dòng tương ứng trong sheet Data
 *  11.  Trả về metadata đầy đủ
 *
 * Frontend gọi:
 *   google.script.run
 *     .withSuccessHandler(res => showCompletionUI(res))
 *     .saveFinalSignedFile(base64Data, docName, metaData);
 *
 * @param {string} base64Data  - PDF đã ký dạng base64 (không có data URL prefix)
 * @param {string} docName     - Tên tài liệu gốc (VD: "Hợp đồng dịch vụ Q3")
 * @param {Object} metaData    - Metadata bổ sung:
 *   {
 *     sessionToken  : string,   // BẮT BUỘC
 *     maDoc         : string,   // Mã tài liệu (VD: "HĐ-2025-001")
 *     signerName    : string,   // Tên người ký
 *     signerEmail   : string,
 *     ngayKy        : string,   // ISO datetime
 *     phuongThuc    : string,   // 'usb_token' | 'pin' | 'otp'
 *     certSerial    : string,   // Serial chứng thư số
 *     certIssuer    : string,   // CA name
 *     tempFileId    : string,   // File ID tạm (để xóa sau khi lưu xong)
 *   }
 *
 * @returns {{
 *   success       : boolean,
 *   fileId        : string|null,
 *   fileUrl       : string|null,
 *   driveUrl      : string|null,
 *   downloadUrl   : string|null,
 *   viewerUrl     : string|null,
 *   uploadedName  : string|null,
 *   folderPath    : string|null,
 *   sizeHuman     : string|null,
 *   error         : string|null,
 *   meta          : Object
 * }}
 */
function saveFinalSignedFile(base64Data, docName, metaData) {

  const startTime = Date.now();

  // ══ BƯỚC 1: Xác thực phiên & quyền ══════════════════════════════════════
  if (!metaData || !metaData.sessionToken) {
    return _signedFileError("Thiếu sessionToken trong metadata.", "SAVE_NO_TOKEN");
  }

  const auth = requirePermission(metaData.sessionToken, "Ký tài liệu");
  if (!auth.allowed) {
    return _signedFileError(auth.error, "SAVE_UNAUTHORIZED");
  }

  const session      = _verifySession(metaData.sessionToken);
  const uploaderEmail = session.user?.["Email"] ?? "";
  const uploaderMaNV  = session.user?.["Mã NV"]  ?? "";

  Logger.log(`[saveFinalSignedFile] Bắt đầu: "${docName}" bởi ${uploaderEmail}`);

  // ══ BƯỚC 2: Validate đầu vào ═════════════════════════════════════════════
  if (!base64Data || typeof base64Data !== "string" || base64Data.length < 100) {
    return _signedFileError("Dữ liệu PDF không hợp lệ hoặc quá ngắn.", "SAVE_INVALID_DATA");
  }

  if (!docName || typeof docName !== "string") {
    return _signedFileError("Tên tài liệu không được để trống.", "SAVE_NO_DOCNAME");
  }

  const maDoc = (metaData.maDoc ?? "").trim() || "UNKNOWN";

  // ══ BƯỚC 3: Giải mã base64 → Blob ════════════════════════════════════════
  let fileBlob;
  try {
    // Strip data URL prefix nếu frontend gửi nhầm
    const clean = base64Data.includes(",") ? base64Data.split(",")[1] : base64Data.trim();
    fileBlob = Utilities.newBlob(
      Utilities.base64Decode(clean),
      "application/pdf",
      "temp.pdf"
    );
  } catch (decodeErr) {
    Logger.log(`[saveFinalSignedFile] Lỗi giải mã: ${decodeErr.message}`);
    return _signedFileError(
      "Không thể giải mã PDF. Dữ liệu base64 có thể bị hỏng hoặc bị cắt ngắn.",
      "SAVE_DECODE_ERROR"
    );
  }

  // ══ BƯỚC 4: Kiểm tra kích thước ══════════════════════════════════════════
  const actualBytes = fileBlob.getBytes().length;

  if (actualBytes === 0) {
    return _signedFileError("File PDF rỗng (0 bytes).", "SAVE_EMPTY_FILE");
  }

  if (actualBytes > MAX_SIGNED_FILE_BYTES) {
    return _signedFileError(
      `File quá lớn: ${_formatFileSize(actualBytes)}. Tối đa ${_formatFileSize(MAX_SIGNED_FILE_BYTES)}.`,
      "SAVE_FILE_TOO_LARGE"
    );
  }

  // Verify magic bytes PDF (%PDF-)
  const firstBytes = fileBlob.getBytes().slice(0, 5);
  const pdfMagic   = [0x25, 0x50, 0x44, 0x46, 0x2D]; // %PDF-
  const isPdf      = pdfMagic.every((b, i) => firstBytes[i] === b);
  if (!isPdf) {
    return _signedFileError(
      "Dữ liệu không phải PDF hợp lệ (thiếu magic bytes %PDF-).",
      "SAVE_NOT_PDF"
    );
  }

  Logger.log(`[saveFinalSignedFile] File hợp lệ: ${_formatFileSize(actualBytes)}`);

  // ══ BƯỚC 5: Tạo / lấy thư mục đích ═════════════════════════════════════
  let targetFolder;
  try {
    const rootFolder = _getOrCreateFolder(null, SIGNED_FOLDER_NAME);
    targetFolder     = _getOrCreateFolder(rootFolder, _getMonthFolderName());
  } catch (folderErr) {
    Logger.log(`[saveFinalSignedFile] Lỗi thư mục: ${folderErr.message}`);
    return _signedFileError(`Không thể tạo thư mục Drive: ${folderErr.message}`, "SAVE_FOLDER_ERROR");
  }

  // ══ BƯỚC 6: Tạo tên file duy nhất ════════════════════════════════════════
  const safeName    = _sanitizeFileName(docName) ?? "TaiLieu";
  const ngayKy      = metaData.ngayKy
    ? new Date(metaData.ngayKy)
    : new Date();
  const ngayKyStr   = Utilities.formatDate(ngayKy, "Asia/Ho_Chi_Minh", "yyyyMMdd-HHmmss");
  const uniqueName  = `[SIGNED]_${maDoc}_${safeName}_${ngayKyStr}.pdf`;

  // ══ BƯỚC 7: Tạo file trên Drive ══════════════════════════════════════════
  let driveFile;
  try {
    fileBlob.setName(uniqueName);
    driveFile = targetFolder.createFile(fileBlob);
  } catch (createErr) {
    Logger.log(`[saveFinalSignedFile] Lỗi tạo file: ${createErr.message}`);
    return _signedFileError(`Không thể tạo file trên Drive: ${createErr.message}`, "SAVE_CREATE_ERROR");
  }

  const fileId = driveFile.getId();

  // ══ BƯỚC 8: Thiết lập quyền chia sẻ ═════════════════════════════════════
  try {
    // Đặt mô tả file — hiện trong Drive UI
    driveFile.setDescription(
      `[ĐÃ KÝ] ${docName} | Mã TL: ${maDoc} | ` +
      `Người ký: ${metaData.signerName ?? uploaderEmail} | ` +
      `Ngày ký: ${Utilities.formatDate(ngayKy, "Asia/Ho_Chi_Minh", "dd/MM/yyyy HH:mm")} | ` +
      `CA: ${metaData.certIssuer ?? "N/A"} | ` +
      `Phương thức: ${metaData.phuongThuc ?? "N/A"}`
    );

    if (SIGNED_FILE_SHARING === "DOMAIN") {
      // Cho phép mọi người trong domain xem (chỉ VIEW, không EDIT)
      driveFile.setSharing(DriveApp.Access.DOMAIN, DriveApp.Permission.VIEW);
      Logger.log(`[saveFinalSignedFile] Quyền: DOMAIN VIEW`);
    } else {
      // PRIVATE: chỉ chủ file truy cập
      driveFile.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
      Logger.log(`[saveFinalSignedFile] Quyền: PRIVATE`);
    }

    // Chia sẻ với người ký (nếu email hợp lệ và khác chủ file)
    const signerEmail = (metaData.signerEmail ?? "").trim();
    if (signerEmail && signerEmail !== uploaderEmail) {
      driveFile.addViewer(signerEmail);
      Logger.log(`[saveFinalSignedFile] Thêm viewer: ${signerEmail}`);
    }

  } catch (permErr) {
    // Không block — quyền có thể cấu hình sau
    Logger.log(`[saveFinalSignedFile] ⚠️  Không đặt được quyền: ${permErr.message}`);
  }

  // ══ BƯỚC 9: Xóa file tạm trong Tai_Lieu_Cho_Ky ═══════════════════════════
  const tempFileId = (metaData.tempFileId ?? "").trim();
  let tempDeleteStatus = "N/A";
  if (tempFileId && tempFileId !== "mock_drive_" + tempFileId.split("_")[2]) {
    try {
      DriveApp.getFileById(tempFileId).setTrashed(true);
      tempDeleteStatus = "Đã xóa";
      Logger.log(`[saveFinalSignedFile] ✅ Xóa file tạm: ${tempFileId}`);
    } catch (delErr) {
      tempDeleteStatus = `Lỗi: ${delErr.message}`;
      Logger.log(`[saveFinalSignedFile] ⚠️  Không xóa được file tạm: ${delErr.message}`);
    }
  }

  // ══ BƯỚC 10: Cập nhật sheet Data ═════════════════════════════════════════
  let updatedRow = null;
  try {
    updatedRow = _updateDataSheetAfterSign(maDoc, {
      signedFileId   : fileId,
      signedFileUrl  : `https://drive.google.com/file/d/${fileId}/view`,
      signedFileName : uniqueName,
      sizeHuman      : _formatFileSize(actualBytes),
      signerEmail    : metaData.signerEmail ?? uploaderEmail,
      signerName     : metaData.signerName  ?? "",
      ngayKy         : ngayKy.toISOString(),
      certSerial     : metaData.certSerial  ?? "",
      phuongThuc     : metaData.phuongThuc  ?? "",
    });
  } catch (updateErr) {
    Logger.log(`[saveFinalSignedFile] ⚠️  Không cập nhật được sheet Data: ${updateErr.message}`);
  }

  // ══ BƯỚC 11: Tổng hợp URLs và trả về ════════════════════════════════════
  const elapsedMs = Date.now() - startTime;

  Logger.log(
    `[saveFinalSignedFile] ✅ Hoàn tất: "${uniqueName}" | ` +
    `ID: ${fileId} | ${_formatFileSize(actualBytes)} | ${elapsedMs}ms`
  );

  return {
    success      : true,
    fileId       : fileId,
    fileUrl      : `https://drive.google.com/file/d/${fileId}/preview`,
    driveUrl     : `https://drive.google.com/file/d/${fileId}/view`,
    downloadUrl  : `https://drive.google.com/uc?export=download&id=${fileId}`,
    viewerUrl    : `https://docs.google.com/viewer?url=https://drive.google.com/uc?id=${fileId}`,
    uploadedName : uniqueName,
    folderPath   : `${SIGNED_FOLDER_NAME}/${_getMonthFolderName()}`,
    sizeHuman    : _formatFileSize(actualBytes),
    maDoc        : maDoc,
    tempDelete   : tempDeleteStatus,
    rowUpdated   : updatedRow !== null,
    error        : null,
    meta         : {
      action        : "SAVE_SUCCESS",
      timestamp     : new Date().toISOString(),
      elapsedMs,
      uploaderEmail,
      uploaderMaNV,
      signerName    : metaData.signerName ?? "",
      phuongThuc    : metaData.phuongThuc ?? "",
      certSerial    : metaData.certSerial ?? "",
    },
  };
}


// -----------------------------------------------------------------------------
// PHẦN 40: CẬP NHẬT SHEET DATA SAU KHI KÝ HOÀN TẤT
// -----------------------------------------------------------------------------

/**
 * Cập nhật dòng tài liệu trong sheet Data sau khi ký hoàn tất:
 *   - URL file đã ký chính thức
 *   - Trạng thái = "Đã ký" (nếu chưa set bởi signDocument)
 *   - Thêm metadata ký vào lịch sử
 *
 * @param {string} maDoc   - Mã tài liệu để tìm dòng
 * @param {Object} updates - Các giá trị cần cập nhật
 * @returns {number|null}  - Số hàng đã cập nhật, null nếu lỗi
 */
function _updateDataSheetAfterSign(maDoc, updates) {
  try {
    const ctx   = _readDataSheetContext();
    const found = _findDocByMaDoc(ctx, maDoc);
    if (!found) {
      Logger.log(`[_updateDataSheetAfterSign] Không tìm thấy mã "${maDoc}"`);
      return null;
    }

    const { sheetRow, colMap, sheet } = found;

    // Map tên cột → giá trị cần ghi
    const updateMap = {};

    // URL file đã ký (overwrite URL cũ nếu có)
    if (updates.signedFileUrl && colMap[DATA_COLS.FILE_URL] !== undefined) {
      updateMap[DATA_COLS.FILE_URL] = updates.signedFileUrl;
    }

    // File ID đã ký (overwrite)
    if (updates.signedFileId && colMap[DATA_COLS.DRIVE_FILE_ID] !== undefined) {
      updateMap[DATA_COLS.DRIVE_FILE_ID] = updates.signedFileId;
    }

    // Tên file đã ký
    if (updates.signedFileName && colMap[DATA_COLS.TEN_FILE] !== undefined) {
      updateMap[DATA_COLS.TEN_FILE] = updates.signedFileName;
    }

    // Kích thước
    if (updates.sizeHuman && colMap[DATA_COLS.FILE_SIZE] !== undefined) {
      updateMap[DATA_COLS.FILE_SIZE] = updates.sizeHuman;
    }

    // Đảm bảo trạng thái là "Đã ký"
    if (colMap[DATA_COLS.TRANG_THAI] !== undefined) {
      updateMap[DATA_COLS.TRANG_THAI] = DOC_STATUS.DA_KY;
    }

    // Ghi từng ô
    Object.entries(updateMap).forEach(([colName, value]) => {
      const idx = colMap[colName];
      if (idx !== undefined) {
        sheet.getRange(sheetRow, idx + 1).setValue(value);
      }
    });

    Logger.log(
      `[_updateDataSheetAfterSign] ✅ Cập nhật hàng ${sheetRow} cho "${maDoc}": ` +
      Object.keys(updateMap).join(", ")
    );

    return sheetRow;

  } catch (err) {
    Logger.log(`[_updateDataSheetAfterSign] LỖI: ${err.message}`);
    return null;
  }
}


// -----------------------------------------------------------------------------
// PHẦN 41: HELPER ERROR RESPONSE CHO MODULE NÀY
// -----------------------------------------------------------------------------

/**
 * Tạo response lỗi chuẩn hóa cho saveFinalSignedFile.
 * @param {string} message
 * @param {string} code
 * @returns {Object}
 */
function _signedFileError(message, code) {
  Logger.log(`[saveFinalSignedFile] ❌ [${code}]: ${message}`);
  return {
    success      : false,
    fileId       : null,
    fileUrl      : null,
    driveUrl     : null,
    downloadUrl  : null,
    viewerUrl    : null,
    uploadedName : null,
    folderPath   : null,
    sizeHuman    : null,
    error        : message,
    meta         : {
      action    : code,
      timestamp : new Date().toISOString(),
    },
  };
}


// -----------------------------------------------------------------------------
// PHẦN 42: HÀM TIỆN ÍCH — LẤY DANH SÁCH TÀI LIỆU ĐÃ KÝ
// -----------------------------------------------------------------------------

/**
 * Lấy danh sách file đã ký trong thư mục Tai_Lieu_Da_Ky.
 * Hữu ích cho trang "Tài liệu đã hoàn thành".
 *
 * @param {string} sessionToken
 * @param {{ month: string }} [options] - month = "2025-07" (tuỳ chọn)
 * @returns {Object}
 */
function getSignedFilesList(sessionToken, options) {
  const auth = requirePermission(sessionToken, "Xem tài liệu");
  if (!auth.allowed) return _buildResponse(false, null, auth.error, "LIST_UNAUTHORIZED");

  try {
    const rootFolders = DriveApp.getFoldersByName(SIGNED_FOLDER_NAME);
    if (!rootFolders.hasNext()) {
      return _buildResponse(true, [], null, "LIST_EMPTY");
    }
    const root    = rootFolders.next();
    const month   = options?.month ?? _getMonthFolderName();
    const subFolders = root.getFoldersByName(month);

    if (!subFolders.hasNext()) {
      return _buildResponse(true, [], null, "LIST_EMPTY");
    }

    const folder  = subFolders.next();
    const files   = folder.getFiles();
    const results = [];

    while (files.hasNext()) {
      const f = files.next();
      results.push({
        fileId      : f.getId(),
        name        : f.getName(),
        size        : _formatFileSize(f.getSize()),
        createdDate : f.getDateCreated().toISOString(),
        modifiedDate: f.getLastUpdated().toISOString(),
        driveUrl    : `https://drive.google.com/file/d/${f.getId()}/view`,
        downloadUrl : `https://drive.google.com/uc?export=download&id=${f.getId()}`,
      });
    }

    results.sort((a, b) => new Date(b.createdDate) - new Date(a.createdDate));
    return _buildResponse(true, results, null, "LIST_SUCCESS");

  } catch (err) {
    return _buildResponse(false, null, `Lỗi liệt kê file: ${err.message}`, "LIST_ERROR");
  }
}


// -----------------------------------------------------------------------------
// PHẦN 43: TEST MODULE
// -----------------------------------------------------------------------------

/**
 * Test saveFinalSignedFile với PDF tối thiểu.
 * Chạy trong Apps Script Editor — KHÔNG deploy.
 */
function testSaveFinalSignedFile() {
  Logger.log("════════ TEST saveFinalSignedFile ════════\n");

  // PDF tối thiểu hợp lệ 1 trang trắng
  const minPdfB64 = "JVBERi0xLjAKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSA+PgplbmRvYmoKeHJlZgowIDQKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNjIgMDAwMDAgbiAKMDAwMDAwMDExOCAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDQgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjE5NgolJUVPRgo=";

  // ── T01: Validate thiếu token ──────────────────────────────────────────
  Logger.log("── T01: Thiếu sessionToken ──");
  const r1 = saveFinalSignedFile(minPdfB64, "Test Doc", {});
  Logger.log(`  success: ${r1.success} (phải false) | code: ${r1.meta.action}`);

  // ── T02: Base64 rỗng ──────────────────────────────────────────────────
  Logger.log("── T02: Base64 rỗng ──");
  const r2 = saveFinalSignedFile("", "Test Doc", { sessionToken: "fake" });
  Logger.log(`  success: ${r2.success} (phải false) | code: ${r2.meta.action}`);

  // ── T03: _signedFileError shape ────────────────────────────────────────
  Logger.log("── T03: _signedFileError shape ──");
  const err = _signedFileError("Test error", "TEST_CODE");
  Logger.log(`  Keys: ${Object.keys(err).join(", ")}`);
  Logger.log(`  success: ${err.success} | error: ${err.error}`);

  // ── T04: _updateDataSheetAfterSign với mã không tồn tại ───────────────
  Logger.log("── T04: _updateDataSheetAfterSign (mã không tồn tại) ──");
  const r4 = _updateDataSheetAfterSign("KHONG_TON_TAI_999", { signedFileUrl: "https://test.com" });
  Logger.log(`  result: ${r4} (phải null)`);

  // ── T05: Kiểm tra thư mục tồn tại ────────────────────────────────────
  Logger.log("── T05: _getOrCreateFolder kiểm tra ──");
  try {
    const testFolder = _getOrCreateFolder(null, "eSign_Test_" + Date.now());
    Logger.log(`  ✅ Tạo thư mục: "${testFolder.getName()}"`);
    testFolder.setTrashed(true);
    Logger.log("  ✅ Đã dọn dẹp thư mục test.");
  } catch (e) {
    Logger.log(`  ❌ ${e.message}`);
  }

  Logger.log("\n════════ TEST HOÀN TẤT ════════");
}


// =============================================================================
// MODULE GHI NHẬT KÝ GIAO DỊCH (TRANSACTION LOG MODULE)  v1.0
// =============================================================================


// -----------------------------------------------------------------------------
// PHẦN 44: CẤU HÌNH LOG SHEET
// -----------------------------------------------------------------------------

/**
 * Tên sheet để ghi log giao dịch (có thể dùng riêng sheet "Log" hoặc chung "Data").
 * Theo yêu cầu: ghi vào sheet 'Data' — thay đổi tại đây nếu cần tách sheet.
 */
const LOG_SHEET_NAME = SHEET_NAMES.DATA;  // "Data"

/**
 * Tên các cột log theo đúng thứ tự A→G (0-indexed 0→6).
 * QUAN TRỌNG: Thứ tự này phải khớp với layout sheet thực tế.
 * Nếu sheet đã có nhiều cột hơn, các cột log vẫn được ghi đúng vị trí A-G
 * bằng cách đọc header hiện tại và tìm đúng index.
 */
const LOG_COLS_ORDER = [
  "Logs_Timestamp",    // Cột A  — dd/MM/yyyy HH:mm:ss (chuẩn VN)
  "Logs_STT",          // Cột B  — Số thứ tự tự tăng
  "Logs_TenTaiLieu",   // Cột C  — Tên tài liệu
  "Logs_LoaiTaiLieu",  // Cột D  — Loại tài liệu
  "Logs_TenDA",        // Cột E  — Tên dự án
  "Logs_ThucHien",     // Cột F  — Tên cá nhân/tổ chức ký
  "Logs_URLFinal",     // Cột G  — URL file Final trên Drive
];

/**
 * Nhãn hiển thị tương ứng với LOG_COLS_ORDER.
 * Dùng để tạo header nếu sheet trống hoặc chưa có cột log.
 */
const LOG_COLS_LABELS = [
  "Timestamp",         // A — Hiển thị rõ ràng hơn LOG_COLS_ORDER
  "STT",               // B
  "Tên Tài Liệu",      // C
  "Loại Tài Liệu",     // D
  "Tên Dự Án",         // E
  "Người/Tổ Chức Ký",  // F
  "URL File Final",    // G
];

/**
 * Múi giờ Việt Nam để format thời gian.
 */
const VN_TIMEZONE = "Asia/Ho_Chi_Minh";


// -----------------------------------------------------------------------------
// PHẦN 45: HÀM CHÍNH — logTransaction
// -----------------------------------------------------------------------------

/**
 * ★ HÀM GHI NHẬT KÝ GIAO DỊCH ★
 *
 * Sau khi saveFinalSignedFile thành công, frontend gọi hàm này để ghi
 * một dòng log vào sheet 'Data' gồm 7 cột A→G.
 *
 * Chiến lược ghi:
 *   - Đọc header hàng 1 của sheet
 *   - Nếu sheet chưa có cột log (Logs_Timestamp…) → ghi vào 7 cột cuối cùng
 *     tính từ cột A (ghi đè nếu cần, hoặc thêm cột mới bằng cách mở rộng sheet)
 *   - Thực tế với sheet Data hiện tại (12+ cột) → tìm cột A-G theo index cứng
 *     (cột 1-7) vì đây là sheet tracking transaction riêng
 *   - STT tự tăng = (số dòng dữ liệu hiện có)
 *   - Timestamp format: dd/MM/yyyy HH:mm:ss (VN timezone)
 *
 * ⚠️  LƯU Ý THIẾT KẾ: Theo yêu cầu ghi vào cột A-G của sheet Data.
 *     Nếu sheet Data đã có dữ liệu theo schema khác → nên tạo sheet Log riêng.
 *     Hàm hỗ trợ cả hai chế độ qua LOG_SHEET_NAME.
 *
 * Frontend gọi:
 *   google.script.run
 *     .withSuccessHandler(res => console.log('Logged:', res))
 *     .logTransaction(token, logData);
 *
 * @param {string} sessionToken - Token phiên đăng nhập
 * @param {Object} logData      - Dữ liệu cần ghi:
 *   {
 *     tenTaiLieu   : string,   // Tên tài liệu
 *     loaiTaiLieu  : string,   // Loại: 'hop-dong' | 'bien-ban' | 'van-ban-hc'
 *     tenDuAn      : string,   // Tên dự án (có thể rỗng)
 *     thucHien     : string,   // Tên người ký / tổ chức ký
 *     urlFinal     : string,   // URL file PDF Final trên Drive
 *     maDoc        : string,   // Mã tài liệu (dùng để tham chiếu)
 *     phuongThuc   : string,   // Phương thức ký (tuỳ chọn, ghi vào ghi chú)
 *   }
 *
 * @returns {{
 *   success   : boolean,
 *   data      : { stt: number, sheetRow: number, timestamp: string }|null,
 *   error     : string|null,
 *   meta      : { action: string, timestamp: string }
 * }}
 */
function logTransaction(sessionToken, logData) {

  // ══ Xác thực phiên ═══════════════════════════════════════════════════════
  const session = _verifySession(sessionToken);
  if (!session.valid) {
    return _buildResponse(false, null,
      "Phiên đăng nhập không hợp lệ. Không thể ghi log.",
      "LOG_UNAUTHORIZED"
    );
  }

  // ══ Validate dữ liệu tối thiểu ════════════════════════════════════════════
  if (!logData || typeof logData !== "object") {
    return _buildResponse(false, null, "logData không hợp lệ.", "LOG_INVALID_DATA");
  }

  const tenTaiLieu  = String(logData.tenTaiLieu  ?? "").trim();
  const loaiTaiLieu = String(logData.loaiTaiLieu ?? "").trim();
  const tenDuAn     = String(logData.tenDuAn     ?? "").trim();
  const thucHien    = String(logData.thucHien    ?? "").trim();
  const urlFinal    = String(logData.urlFinal    ?? "").trim();
  const maDoc       = String(logData.maDoc       ?? "").trim();

  if (!tenTaiLieu) {
    return _buildResponse(false, null, "Tên tài liệu không được để trống.", "LOG_NO_DOCNAME");
  }
  if (!urlFinal) {
    return _buildResponse(false, null, "URL file Final không được để trống.", "LOG_NO_URL");
  }

  // ══ Lấy sheet & tính STT ══════════════════════════════════════════════════
  let sheet;
  try {
    sheet = getSheet(LOG_SHEET_NAME);
  } catch (err) {
    return _buildResponse(false, null,
      `Không tìm thấy sheet "${LOG_SHEET_NAME}": ${err.message}`,
      "LOG_NO_SHEET"
    );
  }

  const lastRow = sheet.getLastRow();
  const stt     = Math.max(1, lastRow); // STT = tổng số hàng hiện có (kể cả header)

  // ══ Format timestamp chuẩn Việt Nam ═══════════════════════════════════════
  const now        = new Date();
  const timestamp  = _formatVnTimestamp(now);

  // ══ Chuẩn hóa nhãn loại tài liệu ════════════════════════════════════════
  const loaiLabel  = _getLoaiLabel(loaiTaiLieu);

  // ══ Build dòng log đúng thứ tự cột A→G ═══════════════════════════════════
  const logRow = [
    timestamp,    // Cột A — Timestamp VN
    stt,          // Cột B — STT tự tăng
    tenTaiLieu,   // Cột C — Tên tài liệu
    loaiLabel,    // Cột D — Loại tài liệu (nhãn đọc được)
    tenDuAn,      // Cột E — Tên dự án
    thucHien,     // Cột F — Người/Tổ chức thực hiện ký
    urlFinal,     // Cột G — URL file Final
  ];

  // ══ Ghi vào sheet ══════════════════════════════════════════════════════════
  const newRow = lastRow + 1;

  try {
    // Ghi 7 ô vào cột A-G (1-7) của dòng mới
    sheet.getRange(newRow, 1, 1, logRow.length).setValues([logRow]);

    // Định dạng cột A (timestamp) → text để không bị Excel tự convert
    sheet.getRange(newRow, 1).setNumberFormat("@");

    // Định dạng cột B (STT) → số nguyên
    sheet.getRange(newRow, 2).setNumberFormat("0");

    // Định dạng cột G (URL) → link hiperlink (màu xanh, có thể click)
    const urlCell = sheet.getRange(newRow, 7);
    if (urlFinal.startsWith("http")) {
      urlCell.setFormula(`=HYPERLINK("${urlFinal.replace(/"/g, '""')}","Xem file")`);
    }

    Logger.log(
      `[logTransaction] ✅ Ghi log hàng ${newRow}: ` +
      `STT=${stt} | "${tenTaiLieu}" | ${loaiLabel} | ${thucHien} | ${timestamp}`
    );

    return _buildResponse(true, {
      stt,
      sheetRow   : newRow,
      timestamp,
      logRow,
    }, null, "LOG_SUCCESS");

  } catch (writeErr) {
    Logger.log(`[logTransaction] ❌ Lỗi ghi sheet: ${writeErr.message}`);
    return _buildResponse(false, null,
      `Không thể ghi vào sheet: ${writeErr.message}`,
      "LOG_WRITE_ERROR"
    );
  }
}


// -----------------------------------------------------------------------------
// PHẦN 46: HÀM GHI LOG HÀNG LOẠT (BATCH LOG)
// -----------------------------------------------------------------------------

/**
 * Ghi nhiều log entry cùng một lúc (batch).
 * Hiệu quả hơn gọi logTransaction nhiều lần liên tiếp.
 * Ví dụ: log danh sách tất cả người đã ký trong một phiên.
 *
 * @param {string}   sessionToken
 * @param {Object[]} logDataArray - Mảng logData objects
 * @returns {Object}
 */
function logTransactionBatch(sessionToken, logDataArray) {
  const session = _verifySession(sessionToken);
  if (!session.valid) {
    return _buildResponse(false, null, "Phiên không hợp lệ.", "LOG_BATCH_UNAUTHORIZED");
  }

  if (!Array.isArray(logDataArray) || logDataArray.length === 0) {
    return _buildResponse(false, null, "logDataArray phải là mảng không rỗng.", "LOG_BATCH_INVALID");
  }

  let sheet;
  try {
    sheet = getSheet(LOG_SHEET_NAME);
  } catch (err) {
    return _buildResponse(false, null, `Không tìm thấy sheet: ${err.message}`, "LOG_BATCH_NO_SHEET");
  }

  const lastRowBefore = sheet.getLastRow();
  const batchRows     = [];
  const now           = new Date();
  const startStt      = lastRowBefore; // STT bắt đầu

  logDataArray.forEach((logData, idx) => {
    const timestamp = _formatVnTimestamp(new Date(now.getTime() + idx * 1000));
    const loaiLabel = _getLoaiLabel(logData.loaiTaiLieu ?? "");

    batchRows.push([
      timestamp,
      startStt + idx + 1,
      String(logData.tenTaiLieu  ?? "").trim(),
      loaiLabel,
      String(logData.tenDuAn     ?? "").trim(),
      String(logData.thucHien    ?? "").trim(),
      String(logData.urlFinal    ?? "").trim(),
    ]);
  });

  try {
    const startRow = lastRowBefore + 1;
    sheet.getRange(startRow, 1, batchRows.length, 7).setValues(batchRows);

    // Định dạng batch
    sheet.getRange(startRow, 1, batchRows.length, 1).setNumberFormat("@"); // Timestamp text
    sheet.getRange(startRow, 2, batchRows.length, 1).setNumberFormat("0"); // STT số

    Logger.log(`[logTransactionBatch] ✅ Ghi ${batchRows.length} log từ hàng ${startRow}`);
    return _buildResponse(true, {
      count    : batchRows.length,
      startRow,
      endRow   : startRow + batchRows.length - 1,
    }, null, "LOG_BATCH_SUCCESS");

  } catch (err) {
    Logger.log(`[logTransactionBatch] ❌ ${err.message}`);
    return _buildResponse(false, null, `Lỗi ghi batch: ${err.message}`, "LOG_BATCH_WRITE_ERROR");
  }
}


// -----------------------------------------------------------------------------
// PHẦN 47: HELPER — FORMAT VÀ TIỆN ÍCH LOG
// -----------------------------------------------------------------------------

/**
 * Format Date thành chuỗi chuẩn Việt Nam: dd/MM/yyyy HH:mm:ss
 * Dùng Utilities.formatDate() của GAS (không dùng toLocaleString — không đáng tin).
 *
 * @param {Date} date
 * @returns {string}  VD: "10/07/2025 14:30:45"
 */
function _formatVnTimestamp(date) {
  if (!(date instanceof Date) || isNaN(date.getTime())) {
    date = new Date();
  }
  return Utilities.formatDate(date, VN_TIMEZONE, "dd/MM/yyyy HH:mm:ss");
}

/**
 * Chuyển mã loại tài liệu thành nhãn tiếng Việt đọc được.
 *
 * @param {string} loaiCode - 'hop-dong' | 'bien-ban' | 'van-ban-hc' | ...
 * @returns {string}
 */
function _getLoaiLabel(loaiCode) {
  const map = {
    "hop-dong"  : "Hợp đồng",
    "bien-ban"  : "Biên bản",
    "van-ban-hc": "Văn bản hành chính",
  };
  return map[loaiCode] ?? (loaiCode || "Không xác định");
}

/**
 * Tạo / kiểm tra header của log sheet.
 * Gọi 1 lần khi setup, không cần gọi trong mỗi request.
 * Chạy thủ công trong Apps Script Editor.
 */
function setupLogSheetHeader() {
  const sheet = getSheet(LOG_SHEET_NAME);

  // Kiểm tra hàng 1 đã có header chưa
  const firstCell = sheet.getRange(1, 1).getValue();
  if (String(firstCell).includes("Timestamp") || String(firstCell).includes("Logs")) {
    Logger.log("[setupLogSheetHeader] Header đã tồn tại, bỏ qua.");
    return;
  }

  // Sheet trống hoàn toàn → chèn header mới ở hàng 1
  // (HOẶC nếu sheet đã có data, header sẽ bị ghi đè — chỉ chạy khi chắc chắn sheet trống)
  sheet.getRange(1, 1, 1, LOG_COLS_LABELS.length).setValues([LOG_COLS_LABELS]);

  // Định dạng header
  const headerRange = sheet.getRange(1, 1, 1, LOG_COLS_LABELS.length);
  headerRange.setBackground("#0F172A");
  headerRange.setFontColor("#FFFFFF");
  headerRange.setFontWeight("bold");
  headerRange.setFontSize(11);
  headerRange.setHorizontalAlignment("center");

  // Đặt chiều rộng cột
  const colWidths = [160, 60, 250, 140, 200, 220, 300];
  colWidths.forEach((w, i) => sheet.setColumnWidth(i + 1, w));

  // Freeze hàng header
  sheet.setFrozenRows(1);

  Logger.log("[setupLogSheetHeader] ✅ Header đã được tạo.");
}


// -----------------------------------------------------------------------------
// PHẦN 48: TEST LOGTRANSACTION
// -----------------------------------------------------------------------------

/**
 * Test logTransaction với dữ liệu mẫu.
 * Chạy trong Apps Script Editor.
 */
function testLogTransaction() {
  Logger.log("════════ TEST logTransaction ════════\n");

  // ── T01: Validate thiếu token ──────────────────────────────────────────
  Logger.log("── T01: Thiếu token ──");
  const r1 = logTransaction("", { tenTaiLieu: "Test", urlFinal: "https://x.com" });
  Logger.log(`  success: ${r1.success} | code: ${r1.meta.action}`);

  // ── T02: Thiếu urlFinal ────────────────────────────────────────────────
  Logger.log("── T02: Thiếu urlFinal ──");
  const r2 = logTransaction("fake_token", { tenTaiLieu: "Test" });
  Logger.log(`  success: ${r2.success} | code: ${r2.meta.action}`);

  // ── T03: _formatVnTimestamp ────────────────────────────────────────────
  Logger.log("── T03: _formatVnTimestamp ──");
  const ts = _formatVnTimestamp(new Date("2025-07-10T07:30:45.000Z"));
  Logger.log(`  Result: "${ts}" (phải là "10/07/2025 14:30:45" UTC+7)`);

  // ── T04: _getLoaiLabel ─────────────────────────────────────────────────
  Logger.log("── T04: _getLoaiLabel ──");
  [
    ["hop-dong",   "Hợp đồng"],
    ["bien-ban",   "Biên bản"],
    ["van-ban-hc", "Văn bản hành chính"],
    ["unknown",    "unknown"],
    ["",           "Không xác định"],
  ].forEach(([code, expected]) => {
    const got = _getLoaiLabel(code);
    Logger.log(`  "${code}" → "${got}" ${got === expected ? "✅" : "❌ (expected: "+expected+")"}`);
  });

  // ── T05: Ghi thật vào sheet (cần sheet Data tồn tại) ──────────────────
  Logger.log("── T05: Ghi thật vào sheet Data (cần token hợp lệ) ──");
  Logger.log("  → Không test ghi thật ở đây, cần session token thật.");
  Logger.log("  → Sử dụng testAuthFlow() để tạo token, rồi gọi logTransaction.");

  Logger.log("\n════════ TEST HOÀN TẤT ════════");
}


// =============================================================================
// MODULE TRA CỨU TÀI LIỆU (DOC SEARCH MODULE)  v1.0
// =============================================================================

/**
 * Lấy toàn bộ dữ liệu tài liệu từ sheet Data để tra cứu.
 *
 * Khác getPendingDocsForUser: trả về TẤT CẢ tài liệu (không lọc theo user),
 * để module Tra cứu hiển thị toàn bộ hệ thống.
 * Quyền: "Xem tài liệu" (tất cả vai trò đều có).
 *
 * @param {string} sessionToken
 * @param {Object} [options]  - { status, loai, dateFrom, dateTo } (tuỳ chọn filter server-side)
 * @returns {Object}
 */
function getAllDocsData(sessionToken, options) {
  const auth = requirePermission(sessionToken, "Xem tài liệu");
  if (!auth.allowed) return _buildResponse(false, null, auth.error, "SEARCH_UNAUTHORIZED");

  try {
    const result = getSheetDataAsJson(SHEET_NAMES.DATA);
    if (!result.success) return result;

    let docs = result.data ?? [];

    // Server-side filter (tuỳ chọn)
    if (options) {
      const { status, loai, dateFrom, dateTo } = options;
      if (status)   docs = docs.filter(d => String(d["Trạng thái"] ?? "").trim() === status);
      if (loai)     docs = docs.filter(d => String(d["Loại"]       ?? "").trim() === loai);
      if (dateFrom) docs = docs.filter(d => d["Ngày tạo"] && new Date(d["Ngày tạo"]) >= new Date(dateFrom));
      if (dateTo)   docs = docs.filter(d => d["Ngày tạo"] && new Date(d["Ngày tạo"]) <= new Date(dateTo + "T23:59:59"));
    }

    // Loại bỏ trường nhạy cảm (Mật khẩu không có trong sheet Data, nhưng bỏ signerConfig nếu cần)
    // Giữ lại signerConfig để frontend có thể hiển thị thông tin người ký

    Logger.log(`[getAllDocsData] Trả về ${docs.length} tài liệu.`);
    return _buildResponse(true, docs, null, "SEARCH_SUCCESS");

  } catch (err) {
    Logger.log(`[getAllDocsData] Lỗi: ${err.message}`);
    return _buildResponse(false, null, `Lỗi đọc dữ liệu: ${err.message}`, "SEARCH_READ_ERROR");
  }
}
