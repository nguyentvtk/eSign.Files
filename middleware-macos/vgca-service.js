#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════
   VGCA Sign Service — bản cho macOS
   ─────────────────────────────────────────────────────────
   Nói đúng giao thức mà thư viện chính thức vgcaplugin.js của
   Ban Cơ yếu dùng, nên trang web KHÔNG phải sửa gì: bấm "Ký số"
   là hộp thoại PIN bật lên ngay, y như trên Windows.

   Giao thức rất đơn giản — mỗi thao tác mở một WebSocket tới
   wss://127.0.0.1:8987/<Tên>, gửi một chuỗi, nhận một chuỗi,
   rồi đóng kết nối.

   Luồng /SignApproved (server-mediated):
     1. Trang web xin server cấp cặp URL tải/nộp kèm signToken.
     2. Trang gọi vgca_sign_approved(...) → tới đây.
     3. Dịch vụ tải PDF gốc, hỏi PIN, ký PAdES bằng USB Token,
        rồi NỘP THẲNG lên server — trình duyệt không đụng tới file.
     4. Trả {Status:0, FileServer:…} để trang biết đã lưu xong.

   Chạy TLS vì plugin ép wss://. Lần đầu hãy mở
   https://127.0.0.1:8987 và chấp nhận cảnh báo chứng chỉ.
═══════════════════════════════════════════════════════════ */
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const forge = require('node-forge');

const { CardSession } = require('./lib/card');
const { readCertificates } = require('./lib/pkcs15');
const { askPin } = require('./lib/pin');
const { signPdf } = require('./lib/pades');
const { layChungChi, CERT } = require('./lib/tls-cert');
const ws = require('./lib/wsserver');

const PORT = Number(process.env.VGCA_SERVICE_PORT || 8987);
const HOST = '127.0.0.1';
const PARAMS_FILE = path.join(__dirname, 'card-params.json');
const PHIEN_BAN = 'VGCA Sign Service for macOS 1.0';

// Trang nào được phép sai khiến token. Mỗi lần ký vẫn phải nhập PIN và
// hộp thoại có nêu tên trang, nhưng chặn từ vòng ngoài vẫn hơn: không có
// danh sách này thì bất kỳ web nào bạn mở cũng bật được hộp thoại PIN.
const ORIGIN_CHO_PHEP = (process.env.VGCA_ORIGINS ||
  'https://e-sign-files.vercel.app,https://vbdh.tayninh.gov.vn,http://localhost:3000,http://127.0.0.1:3000'
).split(',').map(s => s.trim()).filter(Boolean);

const log = (...a) => console.log(new Date().toLocaleTimeString('vi-VN'), ...a);
const utf8 = s => Buffer.from(s || '', 'binary').toString('utf8');
const SHA256_PREFIX = Buffer.from('3031300d060960864801650304020105000420', 'hex');

/* ── Thẻ ────────────────────────────────────────────────── */

async function moThe() {
  const session = new CardSession();
  await session.open();
  const certs = await readCertificates(session);
  const signer = certs.find(c => !c.authority);
  if (!signer) { session.close(); throw new Error('Không tìm thấy chứng thư người ký trên token.'); }
  const x509 = forge.pki.certificateFromAsn1(forge.asn1.fromDer(signer.der.toString('binary')));
  return { session, signerDer: signer.der, chainDer: certs.filter(c => c.authority).map(c => c.der), x509 };
}

const dnToString = dn =>
  dn.attributes.map(a => `${a.shortName || a.type}=${utf8(a.value)}`).join(', ');

/* ── Các endpoint ───────────────────────────────────────── */

async function xuLyGetVersion() {
  return PHIEN_BAN;
}

async function xuLyGetCertInfo() {
  const { session, signerDer, x509 } = await moThe();
  try {
    return JSON.stringify({
      Status: 0,
      Subject: dnToString(x509.subject),
      Issuer: dnToString(x509.issuer),
      SerialNumber: x509.serialNumber.toUpperCase(),
      ValidFrom: x509.validity.notBefore.toISOString(),
      ValidTo: x509.validity.notAfter.toISOString(),
      Certificate: signerDer.toString('base64'),
    });
  } finally {
    session.close();
  }
}

async function xuLySignApproved(thamSoJson, origin) {
  let p;
  try { p = JSON.parse(thamSoJson); }
  catch { return JSON.stringify({ Status: 1, Message: 'Tham số không phải JSON hợp lệ.', FileServer: '' }); }

  const urlTai = p.FileName;
  const urlNop = p.FileUploadHandler;
  if (!urlTai || !urlNop) {
    return JSON.stringify({ Status: 1, Message: 'Thiếu FileName hoặc FileUploadHandler.', FileServer: '' });
  }

  // 1. Tải PDF gốc
  log('  tải PDF gốc…');
  const rTai = await fetch(urlTai);
  if (!rTai.ok) {
    return JSON.stringify({ Status: 1, Message: `Không tải được PDF gốc (HTTP ${rTai.status}).`, FileServer: '' });
  }
  const pdf = Buffer.from(await rTai.arrayBuffer());
  if (pdf.subarray(0, 5).toString() !== '%PDF-') {
    return JSON.stringify({ Status: 1, Message: 'Dữ liệu tải về không phải PDF.', FileServer: '' });
  }

  // 2. Đọc thẻ + hỏi PIN
  const { session, signerDer, chainDer, x509 } = await moThe();
  try {
    const cn = utf8((x509.subject.getField('CN') || {}).value);
    const now = new Date();
    if (now > x509.validity.notAfter) throw new Error('Chứng thư số đã hết hạn.');
    if (now < x509.validity.notBefore) throw new Error('Chứng thư số chưa tới hạn hiệu lực.');

    const retries = await session.pinRetries();
    const pin = await askPin({
      title: 'Ký số bằng USB Token VGCA',
      message: [
        `Trang web yêu cầu: ${origin || '(không rõ)'}`,
        `Người ký: ${cn}`,
        `Kích thước tài liệu: ${(pdf.length / 1024).toFixed(0)} KB`,
        '',
        'Nhập mã PIN của USB Token:',
      ].join('\n'),
      retries,
    });
    await session.verifyPin(pin);

    // 3. Ký PAdES
    log('  đang ký…');
    const known = (() => { try { return JSON.parse(fs.readFileSync(PARAMS_FILE, 'utf8')); } catch { return null; } })();
    const daKy = await signPdf(pdf, {
      signerCertDer: signerDer,
      chainDer,
      signerName: cn,
      reason: 'Ký số tài liệu',
      sign: async (digestInfo, hash) => (await session.signHash(digestInfo, hash, known)).signature,
    });

    // 4. Nộp lại cho máy chủ
    log('  nộp file đã ký…');
    const form = new FormData();
    form.append('uploadfile', new Blob([daKy], { type: 'application/pdf' }), 'signed.pdf');
    const rNop = await fetch(urlNop, { method: 'POST', body: form });
    const kq = await rNop.json().catch(() => null);

    if (!kq) {
      return JSON.stringify({ Status: 1, Message: `Máy chủ trả phản hồi không đọc được (HTTP ${rNop.status}).`, FileServer: '' });
    }
    // FileUploadHandler của VGCA trả Status kiểu boolean
    if (kq.Status !== true) {
      return JSON.stringify({ Status: 1, Message: kq.Message || 'Máy chủ từ chối file đã ký.', FileServer: '' });
    }

    log('  xong.');
    return JSON.stringify({
      Status: 0,
      Message: kq.Message || 'Ký số thành công.',
      FileName: kq.FileName || '',
      FileServer: kq.FileServer || kq.FileName || 'stored',
    });
  } finally {
    session.close();
  }
}

async function xuLyConfig() {
  const { alert } = require('./lib/prompt');
  await alert({
    title: 'VGCA Sign Service — macOS',
    message: [
      PHIEN_BAN,
      '',
      `Cổng: ${PORT}`,
      `Chứng chỉ: ${CERT}`,
      '',
      'Trang được phép gọi:',
      ...ORIGIN_CHO_PHEP.map(o => '  • ' + o),
    ].join('\n'),
  });
  return JSON.stringify({ Status: 0, Message: 'OK' });
}

const BANG_XU_LY = {
  '/GetVersion': xuLyGetVersion,
  '/GetCertInfo': xuLyGetCertInfo,
  '/SignApproved': xuLySignApproved,
  '/Config': xuLyConfig,
};

/* ── Máy chủ ────────────────────────────────────────────── */

const { cert, key, moiTao } = layChungChi();

const server = https.createServer({ cert, key }, (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8">
    <title>VGCA Sign Service — macOS</title>
    <style>body{font:15px/1.7 -apple-system,sans-serif;max-width:640px;margin:60px auto;padding:0 20px;color:#1f2937}
    code{background:#f3f4f6;padding:2px 6px;border-radius:4px}</style>
    <h2>VGCA Sign Service — macOS</h2>
    <p><strong>Dịch vụ đang chạy.</strong> Nếu bạn thấy trang này mà không gặp cảnh báo chứng chỉ,
    nghĩa là trình duyệt đã tin chứng chỉ cục bộ — các trang web giờ gọi được dịch vụ ký.</p>
    <p>Cổng <code>${PORT}</code> • Phiên bản ${PHIEN_BAN}</p>
    <p>Trang được phép gọi:</p><ul>${ORIGIN_CHO_PHEP.map(o => `<li><code>${o}</code></li>`).join('')}</ul>`);
});

ws.attach(server, (conn, req) => {
  const duong = (req.url || '/').split('?')[0];
  const origin = req.headers.origin || '';
  log(`← ${duong}  từ ${origin || '(không có origin)'}`);

  conn.on('message', async (text) => {
    const xuLy = BANG_XU_LY[duong];
    if (!xuLy) {
      conn.send(JSON.stringify({ Status: 500, Message: 'Dịch vụ macOS chưa cài đặt endpoint: ' + duong }));
      return;
    }
    try {
      conn.send(await xuLy(text, origin));
    } catch (e) {
      const huy = e.code === 'USER_CANCELLED';
      log('  lỗi:', e.message);
      conn.send(JSON.stringify({
        Status: huy ? 11 : 1,               // 11 = người dùng huỷ, theo quy ước VGCA
        Message: huy ? 'Người dùng đã huỷ.' : e.message,
        FileServer: '',
      }));
    }
  });
}, (origin) => !origin || ORIGIN_CHO_PHEP.includes(origin));

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  VGCA Sign Service — macOS');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  Địa chỉ  : wss://${HOST}:${PORT}`);
  console.log(`  Endpoint : ${Object.keys(BANG_XU_LY).join(', ')}`);
  console.log(`  Origin   : ${ORIGIN_CHO_PHEP.join(', ')}`);
  if (moiTao) console.log(`  Đã tạo chứng chỉ mới: ${CERT}`);
  console.log('');
  console.log(`  ► Lần đầu: mở https://${HOST}:${PORT} rồi bấm "Nâng cao → Tiếp tục"`);
  console.log('    để trình duyệt chấp nhận chứng chỉ cục bộ.');
  console.log('');
  console.log('  Dừng: Ctrl+C');
  console.log('');
});

server.on('error', e => {
  console.error(e.code === 'EADDRINUSE'
    ? `\nCổng ${PORT} đang bị chiếm. Đóng tiến trình đó rồi chạy lại.\n`
    : `\nLỗi máy chủ: ${e.message}\n`);
  process.exit(1);
});
