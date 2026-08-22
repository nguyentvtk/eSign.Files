#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════
   eSignFiles — Ký rời bằng USB Token VGCA trên macOS
   ─────────────────────────────────────────────────────────
   Đi theo luồng "Ký rời" mà server đã hỗ trợ sẵn và đánh dấu
   khuyến nghị (`vgca_detached`):

     1. Đăng nhập, lấy danh sách tài liệu đang "Chờ ký".
     2. Tải PDF gốc về máy.
     3. Ký PAdES bằng khoá nằm trong token (PIN nhập tại đây).
     4. Nộp lại qua POST /api/signing/upload-signed.

   Server tự xác minh chữ ký nhúng và chuỗi tin cậy rồi lưu
   file NGUYÊN TRẠNG — không đóng dấu đè, nên chữ ký vẫn hợp lệ.

   Không cần trình duyệt làm trung gian, không cần chứng chỉ
   TLS cục bộ, và không phải sửa gì trên ứng dụng đã triển khai.
═══════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const forge = require('node-forge');

const { CardSession } = require('./lib/card');
const { readCertificates } = require('./lib/pkcs15');
const { askPin } = require('./lib/pin');
const { askText, chooseFromList, alert } = require('./lib/prompt');
const { signPdf } = require('./lib/pades');

const BASE = (process.env.ESIGN_URL || 'https://e-sign-files.vercel.app').replace(/\/$/, '');
// --dry-run: làm đủ mọi bước nhưng KHÔNG nộp lên máy chủ. Dùng để
// kiểm tra toàn tuyến mà không đổi trạng thái tài liệu thật.
const DRY_RUN = process.argv.includes('--dry-run');
const TOKEN_DIR = path.join(os.homedir(), '.esign-files');
const TOKEN_FILE = path.join(TOKEN_DIR, 'session.json');
const PARAMS_FILE = path.join(__dirname, 'card-params.json');

const utf8 = s => Buffer.from(s || '', 'binary').toString('utf8');

/* ── Phiên đăng nhập ────────────────────────────────────── */

function loadSession() {
  try {
    const s = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (s.expiresAt && new Date(s.expiresAt) > new Date(Date.now() + 60000)) return s;
  } catch { /* chưa có phiên hoặc đã hỏng */ }
  return null;
}

function saveSession(s) {
  fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(s), { mode: 0o600 });
}

async function login() {
  const cached = loadSession();
  if (cached) return cached;

  const identifier = await askText({
    title: 'eSignFiles — Đăng nhập',
    message: `Máy chủ: ${BASE}\n\nTài khoản (email hoặc mã nhân viên):`,
    okLabel: 'Tiếp',
  });
  const password = await askText({
    title: 'eSignFiles — Đăng nhập',
    message: `Mật khẩu của ${identifier}:`,
    hidden: true,
    okLabel: 'Đăng nhập',
  });

  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.success) throw new Error(d.error || `Đăng nhập thất bại (HTTP ${r.status}).`);

  const session = { token: d.token, expiresAt: d.expiresAt, user: d.user };
  saveSession(session);
  return session;
}

const authHeaders = s => ({ Authorization: 'Bearer ' + s.token });

/* ── Tài liệu ───────────────────────────────────────────── */

async function fetchPending(session) {
  const r = await fetch(`${BASE}/api/documents/pending`, { headers: authHeaders(session) });
  if (r.status === 401) {
    try { fs.unlinkSync(TOKEN_FILE); } catch { /* không sao */ }
    throw new Error('Phiên đăng nhập đã hết hạn. Chạy lại để đăng nhập mới.');
  }
  const d = await r.json().catch(() => ({}));
  if (!d.success) throw new Error(d.error || 'Không lấy được danh sách tài liệu chờ ký.');
  return d.data || [];
}

/** Dropbox chặn tải chéo miền nên đi qua proxy của chính server. */
async function downloadPdf(session, doc) {
  const url = /^https?:\/\//.test(doc.file_url)
    ? `${BASE}/api/documents/proxy?url=${encodeURIComponent(doc.file_url)}`
    : `${BASE}${doc.file_url}`;

  const r = await fetch(url, { headers: authHeaders(session) });
  if (!r.ok) throw new Error(`Không tải được PDF gốc (HTTP ${r.status}).`);

  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.subarray(0, 5).toString() !== '%PDF-') {
    throw new Error('File tải về không phải PDF hợp lệ.');
  }
  return buf;
}

async function uploadSigned(session, doc, pdf, otpToken) {
  const form = new FormData();
  form.append('document_id', String(doc.id));
  if (otpToken) form.append('otp_token', otpToken);
  form.append(
    'signed_file',
    new Blob([pdf], { type: 'application/pdf' }),
    `${doc.ma_doc || 'tai-lieu'}_signed.pdf`
  );

  const r = await fetch(`${BASE}/api/signing/upload-signed`, {
    method: 'POST',
    headers: authHeaders(session),
    body: form,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.success) {
    const detail = d.detail ? '\n' + JSON.stringify(d.detail) : '';
    throw new Error((d.error || `Nộp file thất bại (HTTP ${r.status}).`) + detail);
  }
  return d.data;
}

/* ── Luồng chính ────────────────────────────────────────── */

(async () => {
  console.log(`Máy chủ: ${BASE}${DRY_RUN ? '  [CHẠY THỬ — không nộp]' : ''}`);

  const session = await login();
  console.log(`Đã đăng nhập: ${session.user?.ho_ten || session.user?.email || ''}`);

  const docs = await fetchPending(session);
  if (!docs.length) {
    console.log('Không có tài liệu nào đang chờ ký.');
    await alert({ title: 'eSignFiles', message: 'Không có tài liệu nào đang chờ ký.' });
    return;
  }
  console.log(`Có ${docs.length} tài liệu chờ ký.`);

  const labels = docs.map(d =>
    `${d.ma_doc || '(không mã)'} — ${d.ten_tai_lieu || '(không tên)'}`
  );
  const idx = await chooseFromList({
    title: 'Chọn tài liệu để ký',
    message: `Có ${docs.length} tài liệu đang chờ ký:`,
    items: labels,
  });
  const doc = docs[idx];
  console.log(`Đã chọn: ${labels[idx]}`);

  console.log('Đang tải PDF gốc…');
  const original = await downloadPdf(session, doc);
  console.log(`  ${original.length} byte`);

  const card = new CardSession();
  await card.open();
  try {
    const certs = await readCertificates(card);
    const ee = certs.find(c => !c.authority);
    if (!ee) throw new Error('Không tìm thấy chứng thư người ký trên token.');

    const x509 = forge.pki.certificateFromAsn1(forge.asn1.fromDer(ee.der.toString('binary')));
    const cn = utf8((x509.subject.getField('CN') || {}).value);

    const now = new Date();
    if (now > x509.validity.notAfter) throw new Error('Chứng thư số đã hết hạn.');
    if (now < x509.validity.notBefore) throw new Error('Chứng thư số chưa tới hạn hiệu lực.');

    console.log(`Chứng thư: ${cn} (hết hạn ${x509.validity.notAfter.toISOString().slice(0, 10)})`);

    const retries = await card.pinRetries();
    const pin = await askPin({
      title: 'Ký số bằng USB Token VGCA',
      message: [
        `Tài liệu: ${doc.ten_tai_lieu || '(không tên)'}`,
        `Mã văn bản: ${doc.ma_doc || '(không mã)'}`,
        `Người ký: ${cn}`,
        '',
        'Nhập mã PIN của USB Token:',
      ].join('\n'),
      retries,
    });

    await card.verifyPin(pin);
    console.log('PIN đúng. Đang ký…');

    const known = (() => {
      try { return JSON.parse(fs.readFileSync(PARAMS_FILE, 'utf8')); } catch { return null; }
    })();

    const signed = await signPdf(original, {
      signerCertDer: ee.der,
      chainDer: certs.filter(c => c.authority).map(c => c.der),
      signerName: cn,
      reason: `Ký số tài liệu ${doc.ma_doc || ''}`.trim(),
      contactInfo: session.user?.email || '',
      sign: async (digestInfo, hash) => (await card.signHash(digestInfo, hash, known)).signature,
    });
    console.log(`Đã ký: ${signed.length} byte`);

    // OTP chỉ hỏi khi tài khoản có bật — hỏi thừa chỉ gây phiền.
    let otpToken = null;
    if (session.user?.otp_enabled && !DRY_RUN) {
      otpToken = await askText({
        title: 'Xác thực 2 lớp',
        message: 'Nhập mã OTP 6 số:',
        okLabel: 'Xác nhận',
      });
    }

    if (DRY_RUN) {
      const out = `/tmp/esign-dryrun-${doc.ma_doc || doc.id}.pdf`;
      fs.writeFileSync(out, signed);
      console.log(`CHẠY THỬ — không nộp lên máy chủ. File đã ký: ${out}`);
      await alert({
        title: 'Chạy thử — đã ký, chưa nộp',
        message: [
          `Đã ký thành công tài liệu ${doc.ma_doc || ''}.`,
          'KHÔNG nộp lên máy chủ, trạng thái tài liệu giữ nguyên.',
          '',
          `File: ${out}`,
        ].join('\n'),
      });
      return;
    }

    console.log('Đang nộp lên máy chủ…');
    const result = await uploadSigned(session, doc, signed, otpToken);

    console.log(`Xong: ${result.ma_doc} → ${result.trang_thai}`);
    await alert({
      title: 'Ký số thành công',
      message: [
        `Tài liệu ${result.ma_doc} đã được ký.`,
        `Trạng thái: ${result.trang_thai}`,
        `Người ký: ${result.signer || cn}`,
      ].join('\n'),
    });
  } finally {
    card.close();
  }
})().catch(async e => {
  if (e.code === 'USER_CANCELLED') {
    console.log('Đã huỷ.');
    process.exit(0);
  }
  console.error('LỖI:', e.message);
  await alert({ title: 'Ký số thất bại', message: e.message, ok: false });
  process.exit(1);
});
