/* ═══════════════════════════════════════════════════════════
   PROMPT — Hộp thoại gốc của macOS
   ─────────────────────────────────────────────────────────
   Mọi thông tin nhạy cảm (mật khẩu, PIN, mã OTP) đi thẳng từ
   bàn phím vào tiến trình này rồi tới nơi cần đến. Không ghi
   log, không truyền qua tham số dòng lệnh.
═══════════════════════════════════════════════════════════ */
'use strict';

const { execFile } = require('child_process');

function osa(script, timeout = 300000) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || '').toString();
        if (/User canceled|-128/.test(msg)) {
          const e = new Error('Đã huỷ.');
          e.code = 'USER_CANCELLED';
          return reject(e);
        }
        return reject(new Error('Lỗi hộp thoại: ' + msg.trim()));
      }
      resolve(stdout.toString().replace(/\r?\n$/, ''));
    });
  });
}

const q = s => JSON.stringify(String(s));

/** Ô nhập một dòng. hidden = true cho mật khẩu / PIN. */
async function askText({ title, message, hidden = false, defaultValue = '', okLabel = 'OK' }) {
  const value = await osa(`
    set dlg to display dialog ${q(message)} ¬
      with title ${q(title)} ¬
      default answer ${q(defaultValue)} ¬
      ${hidden ? 'with hidden answer ¬' : '¬'}
      buttons {"Huỷ", ${q(okLabel)}} ¬
      default button ${q(okLabel)}
    return text returned of dlg
  `);
  if (!value) {
    const e = new Error('Chưa nhập gì.');
    e.code = 'USER_CANCELLED';
    throw e;
  }
  return value;
}

/** Danh sách để chọn. Trả về chỉ số của mục được chọn. */
async function chooseFromList({ title, message, items }) {
  const list = items.map(q).join(', ');
  const picked = await osa(`
    set opts to {${list}}
    set r to choose from list opts ¬
      with title ${q(title)} ¬
      with prompt ${q(message)} ¬
      OK button name "Chọn" ¬
      cancel button name "Huỷ"
    if r is false then error "USER_CANCELLED" number -128
    return item 1 of r
  `);
  const idx = items.indexOf(picked);
  if (idx < 0) throw new Error('Không nhận diện được lựa chọn.');
  return idx;
}

/** Thông báo kết quả. */
async function alert({ title, message, ok = true }) {
  await osa(`
    display dialog ${q(message)} ¬
      with title ${q(title)} ¬
      buttons {"Đóng"} default button "Đóng" ¬
      with icon ${ok ? 'note' : 'stop'}
  `).catch(() => {});
}

module.exports = { askText, chooseFromList, alert };
