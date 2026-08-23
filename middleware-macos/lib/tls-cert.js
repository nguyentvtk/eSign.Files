/* ═══════════════════════════════════════════════════════════
   TLS CERT — Chứng chỉ tự ký cho dịch vụ chạy tại 127.0.0.1
   ─────────────────────────────────────────────────────────
   Thư viện vgcaplugin.js của VGCA ép dùng wss://, nên dịch vụ
   cục bộ bắt buộc phải chạy TLS. Không CA công cộng nào cấp
   chứng chỉ cho 127.0.0.1, nên tự ký là cách duy nhất.

   KHÔNG cài vào kho tin cậy của hệ thống — việc đó cần quyền
   quản trị và ảnh hưởng tới mọi ứng dụng. Thay vào đó người
   dùng ghé https://127.0.0.1:8987 một lần và chấp nhận ngoại
   lệ; Chrome nhớ riêng cho hồ sơ của họ, và từ đó wss:// chạy.
═══════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const THU_MUC = path.join(__dirname, '..', 'certs');
const CERT = path.join(THU_MUC, 'cert.pem');
const KEY = path.join(THU_MUC, 'key.pem');

/** Còn hạn ít nhất 30 ngày nữa không? */
function conHan(certPath) {
  try {
    execFileSync('openssl', ['x509', '-in', certPath, '-noout', '-checkend', String(30 * 86400)], { stdio: 'pipe' });
    return true;
  } catch {
    return false;   // hết hạn, sắp hết hạn, hoặc file hỏng
  }
}

/**
 * Trả { cert, key } dạng Buffer. Tự sinh nếu chưa có hoặc sắp hết hạn.
 * @returns {{cert: Buffer, key: Buffer, moiTao: boolean}}
 */
function layChungChi() {
  const daCo = fs.existsSync(CERT) && fs.existsSync(KEY) && conHan(CERT);

  if (!daCo) {
    fs.mkdirSync(THU_MUC, { recursive: true, mode: 0o700 });
    try {
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048',
        '-keyout', KEY, '-out', CERT,
        '-days', '825', '-nodes',
        '-subj', '/CN=127.0.0.1/O=VGCA Sign Service (macOS)',
        '-addext', 'subjectAltName=IP:127.0.0.1,IP:0:0:0:0:0:0:0:1,DNS:localhost',
      ], { stdio: 'pipe' });
    } catch (e) {
      throw new Error('Không tạo được chứng chỉ TLS: ' + ((e.stderr && e.stderr.toString().trim()) || e.message));
    }
    fs.chmodSync(KEY, 0o600);   // khoá riêng chỉ chủ máy đọc được
  }

  return { cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY), moiTao: !daCo };
}

module.exports = { layChungChi, CERT, KEY, THU_MUC };
