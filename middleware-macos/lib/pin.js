/* ═══════════════════════════════════════════════════════════
   PIN — Hộp thoại nhập PIN gốc của macOS
   ─────────────────────────────────────────────────────────
   Trình duyệt KHÔNG bao giờ nhìn thấy mã PIN. Hộp thoại do
   chính middleware bật lên, PIN đi thẳng từ bàn phím tới thẻ.
   Giá trị PIN không được ghi log ở bất kỳ đâu.
═══════════════════════════════════════════════════════════ */
'use strict';

const { execFile } = require('child_process');

/**
 * Hỏi PIN người dùng.
 * @param {Object} opts
 *   - title    tiêu đề cửa sổ
 *   - message  dòng mô tả (tên tài liệu, người ký…)
 *   - retries  số lần thử còn lại, hiển thị để cảnh báo
 * @returns {Promise<string>} PIN, hoặc ném lỗi code USER_CANCELLED
 */
function askPin({ title = 'Ký số VGCA', message = '', retries = null } = {}) {
  let prompt = message || 'Nhập mã PIN của USB Token để ký tài liệu.';
  if (retries !== null && retries <= 2) {
    prompt += `\n\n⚠️ Chỉ còn ${retries} lần thử. Token sẽ bị khoá nếu nhập sai hết.`;
  }

  const script = `
    set dlg to display dialog ¬
      ${JSON.stringify(prompt)} ¬
      with title ${JSON.stringify(title)} ¬
      default answer "" ¬
      with hidden answer ¬
      buttons {"Huỷ", "Ký"} ¬
      default button "Ký" ¬
      with icon caution
    return text returned of dlg
  `;

  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: 180000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || '').toString();
        if (/User canceled|-128/.test(msg)) {
          const e = new Error('Người dùng đã huỷ nhập PIN.');
          e.code = 'USER_CANCELLED';
          return reject(e);
        }
        return reject(new Error('Không mở được hộp thoại PIN: ' + msg.trim()));
      }
      const pin = stdout.toString().replace(/\r?\n$/, '');
      if (!pin) {
        const e = new Error('Chưa nhập mã PIN.');
        e.code = 'USER_CANCELLED';
        return reject(e);
      }
      resolve(pin);
    });
  });
}

module.exports = { askPin };
