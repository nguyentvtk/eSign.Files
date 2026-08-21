/* ═══════════════════════════════════════════════════════════
   PHÂN LOẠI LỖI & CHE CHI TIẾT KỸ THUẬT TRONG RESPONSE
   ─────────────────────────────────────────────────────────
   Trước đây cờ debug là `process.env.VERCEL || NODE_ENV !== 'production'`.
   Trên Vercel biến VERCEL luôn = "1" kể cả ở production, nên vế đầu luôn
   đúng → chi tiết lỗi nội bộ (chuỗi lỗi Turso/libSQL, tên class exception)
   bị trả về cho cả người gọi CHƯA ĐĂNG NHẬP.

   Ở đây cờ debug fail-closed: mặc định TẮT trên mọi môi trường triển khai,
   chỉ bật lại có chủ đích bằng env DEBUG_ERRORS=1 khi cần chẩn đoán.
═══════════════════════════════════════════════════════════ */

// Dấu hiệu lỗi hạ tầng dữ liệu (token Turso hết hạn, mất mạng, SQLite hỏng…)
// — phân biệt với lỗi nghiệp vụ như sai mật khẩu.
const DB_ERROR_PATTERN = /unauthorized|token expired|invalid jwt|hrana|libsql|sqlite|econnrefused|enotfound|etimedout|fetch failed|socket hang up/i;

function isDebugEnabled() {
  if (process.env.DEBUG_ERRORS === '1') return true;   // bật thủ công khi cần
  if (process.env.VERCEL) return false;                // môi trường triển khai → luôn tắt
  return process.env.NODE_ENV !== 'production';        // máy dev
}

function isDatabaseError(err) {
  if (!err) return false;
  return DB_ERROR_PATTERN.test(`${err.message || ''} ${err.code || ''}`);
}

/** Đính kèm { debug } vào body CHỈ KHI cờ debug đang bật. */
function withDebug(body, err, extra) {
  if (!isDebugEnabled() || !err) return body;
  return {
    ...body,
    debug: { message: err.message, type: err.constructor?.name, ...(extra || {}) },
  };
}

module.exports = { isDebugEnabled, isDatabaseError, withDebug };
