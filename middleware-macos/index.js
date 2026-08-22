#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════
   eSignFiles — Middleware ký số VGCA cho macOS
   ─────────────────────────────────────────────────────────
   Nói đúng giao thức mà public/js/usb-token.js đã định nghĩa
   cho nhà cung cấp "vgca", nên phía trình duyệt không phải
   sửa gì:

     WebSocket  ws://127.0.0.1:9090
       → {type:'DETECT_TOKEN'}   ← {type:'TOKEN_DETECTED', cert}
       → {type:'SIGN_PDF', …}    ← {type:'SIGN_COMPLETE', signedBase64}

     HTTP dự phòng http://127.0.0.1:9090
       GET  /api/token/status
       GET  /api/token/detect
       POST /api/pdf/sign

   Chỉ lắng nghe trên loopback và chỉ nhận yêu cầu từ các
   origin trong danh sách cho phép — không trang web bất kỳ
   nào cũng sai khiến được token.
═══════════════════════════════════════════════════════════ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const forge = require('node-forge');

const { CardSession } = require('./lib/card');
const { readCertificates } = require('./lib/pkcs15');
const { askPin } = require('./lib/pin');
const { signPdf } = require('./lib/pades');
const ws = require('./lib/wsserver');

const PORT = Number(process.env.VGCA_PORT || 9090);
const HOST = '127.0.0.1';
const PARAMS_FILE = path.join(__dirname, 'card-params.json');

const ALLOWED_ORIGINS = (
  process.env.VGCA_ORIGINS ||
  'https://e-sign-files.vercel.app,http://localhost:3000,http://127.0.0.1:3000'
).split(',').map(s => s.trim()).filter(Boolean);

const isOriginAllowed = origin => !origin || ALLOWED_ORIGINS.includes(origin);

const log = (...a) => console.log(new Date().toLocaleTimeString('vi-VN'), ...a);

/* ── Thẻ ────────────────────────────────────────────────── */

function loadParams() {
  try { return JSON.parse(fs.readFileSync(PARAMS_FILE, 'utf8')); }
  catch { return null; }
}

function saveParams(p) {
  try { fs.writeFileSync(PARAMS_FILE, JSON.stringify(p, null, 2)); }
  catch { /* không lưu được thì lần sau dò lại, không sao */ }
}

/** Mở phiên, đọc chứng thư. Người gọi có trách nhiệm đóng phiên. */
async function openCard() {
  const session = new CardSession();
  await session.open();

  const certs = await readCertificates(session);
  const signer = certs.find(c => !c.authority);
  if (!signer) {
    session.close();
    throw new Error('Không tìm thấy chứng thư người ký trên token.');
  }

  const x509 = forge.pki.certificateFromAsn1(
    forge.asn1.fromDer(signer.der.toString('binary'))
  );

  return {
    session,
    signerDer: signer.der,
    chainDer: certs.filter(c => c.authority).map(c => c.der),
    x509,
  };
}

/** node-forge trả chuỗi dưới dạng byte thô — cần dựng lại UTF-8. */
const utf8 = s => Buffer.from(s || '', 'binary').toString('utf8');

const dnToString = dn =>
  dn.attributes.map(a => `${a.shortName || a.type}=${utf8(a.value)}`).join(', ');

function certInfo(x509, der) {
  return {
    subject: dnToString(x509.subject),
    issuer: dnToString(x509.issuer),
    serial: x509.serialNumber.toUpperCase(),
    validFrom: x509.validity.notBefore.toISOString(),
    validTo: x509.validity.notAfter.toISOString(),
    algorithm: 'SHA256withRSA',
    // Server gọi parseCertificateBase64() nên cần base64 của DER
    certBase64: der.toString('base64').replace(/(.{64})/g, '$1\n'),
    simulated: false,
  };
}

/* ── Nghiệp vụ ──────────────────────────────────────────── */

async function detectToken() {
  const { session, signerDer, x509 } = await openCard();
  try {
    const now = new Date();
    if (now > x509.validity.notAfter) throw new Error('Chứng thư số đã hết hạn.');
    if (now < x509.validity.notBefore) throw new Error('Chứng thư số chưa tới hạn hiệu lực.');
    return certInfo(x509, signerDer);
  } finally {
    session.close();
  }
}

async function doSignPdf({ pdfBase64, meta = {} }, onProgress = () => {}) {
  if (!pdfBase64) throw new Error('Thiếu dữ liệu PDF để ký.');
  const pdf = Buffer.from(pdfBase64, 'base64');
  if (pdf.subarray(0, 5).toString() !== '%PDF-') {
    throw new Error('Dữ liệu nhận được không phải file PDF.');
  }

  const { session, signerDer, chainDer, x509 } = await openCard();

  try {
    const cn = utf8((x509.subject.getField('CN') || {}).value);
    const retries = await session.pinRetries();

    onProgress(30, 'Chờ nhập mã PIN…');

    // Nêu rõ đang ký cái gì — người dùng phải thấy được điều đó
    // trước khi mở khoá token.
    const lines = [
      meta.tenTaiLieu ? `Tài liệu: ${meta.tenTaiLieu}` : null,
      meta.maDoc ? `Mã văn bản: ${meta.maDoc}` : null,
      `Người ký: ${cn}`,
    ].filter(Boolean);

    const pin = await askPin({
      title: 'Ký số bằng USB Token VGCA',
      message: lines.join('\n') + '\n\nNhập mã PIN của USB Token:',
      retries,
    });

    onProgress(45, 'Xác thực PIN…');
    await session.verifyPin(pin);

    onProgress(60, 'Đang ký trên thiết bị…');
    const known = loadParams();
    let usedParams = null;

    const signed = await signPdf(pdf, {
      signerCertDer: signerDer,
      chainDer,
      signerName: cn,
      reason: meta.tenTaiLieu ? `Ký số tài liệu ${meta.maDoc || ''}`.trim() : 'Ký số tài liệu',
      contactInfo: meta.signerEmail || '',
      sign: async (digestInfo, hash) => {
        const r = await session.signHash(digestInfo, hash, known);
        usedParams = r.params;
        return r.signature;
      },
    });

    if (usedParams && (!known || known.algRef !== usedParams.algRef ||
        known.keyRef !== usedParams.keyRef || known.mode !== usedParams.mode)) {
      saveParams(usedParams);
    }

    onProgress(95, 'Hoàn tất chữ ký…');
    return { signedBase64: signed.toString('base64'), cert: certInfo(x509, signerDer) };
  } finally {
    session.close();
  }
}

/* ── HTTP ───────────────────────────────────────────────── */

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Private Network Access: Chrome chặn trang công khai (https) gọi
  // vào địa chỉ loopback trừ khi chính máy chủ nội bộ đồng ý. Không
  // có header này thì mọi request từ trang web đều "Failed to fetch".
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('Dữ liệu gửi lên quá lớn.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    return json(res, 403, { error: 'Origin không được phép: ' + origin });
  }

  const url = (req.url || '').split('?')[0];

  try {
    if (url === '/api/token/status') {
      return json(res, 200, { status: 'ready', provider: 'VGCA', platform: 'macOS' });
    }

    if (url === '/api/token/detect') {
      const cert = await detectToken();
      return json(res, 200, { status: 'detected', cert });
    }

    if (url === '/api/pdf/sign' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      log('HTTP ký:', body.maDoc || '(không rõ mã)');
      const r = await doSignPdf({
        pdfBase64: body.pdfBase64,
        meta: { maDoc: body.maDoc, signerName: body.signerName, tenTaiLieu: body.tenTaiLieu },
      });
      return json(res, 200, { signedBase64: r.signedBase64, cert: r.cert });
    }

    json(res, 404, { error: 'Không có endpoint này.' });
  } catch (e) {
    log('Lỗi HTTP:', e.message);
    json(res, 500, { error: e.message, code: e.code });
  }
});

/* ── WebSocket ──────────────────────────────────────────── */

ws.attach(server, conn => {
  log('Trình duyệt đã kết nối.');

  conn.on('message', async text => {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }

    const fail = e => {
      log('Lỗi:', e.message);
      conn.send(JSON.stringify({ type: 'ERROR', message: e.message, code: e.code }));
    };

    try {
      if (msg.type === 'DETECT_TOKEN') {
        const cert = await detectToken();
        log('Đã đọc chứng thư:', cert.subject);
        conn.send(JSON.stringify({ type: 'TOKEN_DETECTED', cert }));
        return;
      }

      if (msg.type === 'SIGN_PDF') {
        log('Yêu cầu ký:', msg.maDoc || '(không rõ mã)');
        const r = await doSignPdf(
          {
            pdfBase64: msg.pdfBase64,
            meta: {
              maDoc: msg.maDoc,
              tenTaiLieu: msg.tenTaiLieu,
              signerName: msg.signerName,
              signerEmail: msg.signerEmail,
            },
          },
          (percent, message) =>
            conn.send(JSON.stringify({ type: 'SIGN_PROGRESS', percent, message }))
        );
        log('Ký xong.');
        conn.send(JSON.stringify({ type: 'SIGN_COMPLETE', signedBase64: r.signedBase64, cert: r.cert }));
        return;
      }

      conn.send(JSON.stringify({ type: 'ERROR', message: 'Lệnh không hỗ trợ: ' + msg.type }));
    } catch (e) {
      fail(e);
    }
  });

  conn.on('close', () => log('Trình duyệt đã ngắt kết nối.'));
}, isOriginAllowed);

/* ── Khởi động ──────────────────────────────────────────── */

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Middleware ký số VGCA — macOS');
  console.log('  ─────────────────────────────────────────');
  console.log(`  WebSocket : ws://${HOST}:${PORT}`);
  console.log(`  HTTP      : http://${HOST}:${PORT}`);
  console.log(`  Origin cho phép: ${ALLOWED_ORIGINS.join(', ')}`);
  console.log('');
  console.log('  Cắm USB Token rồi bấm "Ký số" trên trang web.');
  console.log('  Hộp thoại nhập PIN sẽ hiện ra từ chính máy này.');
  console.log('  Dừng: Ctrl+C');
  console.log('');
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\nCổng ${PORT} đang bị chiếm. Đóng tiến trình đó rồi chạy lại.\n`);
  } else {
    console.error('\nLỗi máy chủ:', e.message, '\n');
  }
  process.exit(1);
});
