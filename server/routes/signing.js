const express = require('express');
const fs = require('fs');
const router = express.Router();
const { getDb } = require('../db/database');
const { authenticate, requireRole } = require('../middleware/auth');
const auditLog = require('../services/audit-log');
const otpService = require('../services/otp');
const { stampSignatureOnPdf, verifyDocumentIntegrity } = require('../services/signing');
const { parseCertificateBase64, getSignerName } = require('../services/certificate');
const remoteSigning = require('../services/remote-signing');
const dropbox = require('../services/dropbox');
const { hashPdfFile } = require('../utils/pdf-utils');
const sheetsData = require('../services/google-sheets-data');

// POST /signing/approve — Lãnh đạo phê duyệt (ký) tài liệu
router.post('/approve', authenticate, requireRole('Admin', 'Quản lý'), async (req, res) => {
  const { document_id, otp_token, sign_method, certificate_base64, signature_value, stamp_position, signature_image_base64 } = req.body;
  if (!document_id) return res.status(400).json({ success: false, error: 'Thiếu document_id.' });

  const db = getDb();
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(document_id);
  if (!doc) return res.status(404).json({ success: false, error: 'Không tìm thấy tài liệu.' });
  if (doc.trang_thai !== 'Chờ ký') return res.status(400).json({ success: false, error: 'Tài liệu không ở trạng thái "Chờ ký".' });

  // OTP check
  const user = db.prepare('SELECT otp_enabled, otp_secret FROM users WHERE id = ?').get(req.user.id);
  let otpVerified = 0;
  if (user.otp_enabled) {
    if (!otp_token) return res.status(400).json({ success: false, error: 'Xác thực 2 lớp bắt buộc. Vui lòng nhập mã OTP.' });
    if (!otpService.verifyToken(user.otp_secret, otp_token)) {
      auditLog.log({ userId: req.user.id, userEmail: req.user.email, action: 'SIGN_OTP_FAILED', targetType: 'document', targetId: doc.ma_doc, ip: req.ip, userAgent: req.get('user-agent') });
      return res.status(401).json({ success: false, error: 'Mã OTP không chính xác.' });
    }
    otpVerified = 1;
  }

  const method = sign_method || 'usb_token';
  let certInfo = { subject: '', serial: '', issuer: '', validFrom: '', validTo: '' };

  if (certificate_base64) {
    try {
      certInfo = parseCertificateBase64(certificate_base64);
      if (certInfo.isExpired) return res.status(400).json({ success: false, error: 'Chứng thư số đã hết hạn.' });
    } catch (e) {
      return res.status(400).json({ success: false, error: 'Không thể đọc chứng thư số.' });
    }
  }

  const docHash = doc.file_hash_sha256;
  const signerName = certInfo.subject ? getSignerName(certInfo) : req.user.ho_ten;
  const signedAt = new Date().toISOString();

  // Stamp signature lên PDF
  let signedFileUrl = doc.file_url;
  const config_ = require('../config');
  const pathMod = require('path');

  // Tìm file PDF gốc (local hoặc tải về từ Dropbox)
  let localPath = '';
  if (doc.file_url?.startsWith('/uploads')) {
    localPath = pathMod.join(config_.upload.dir, doc.file_url.replace('/uploads/', ''));
  }
  // Nếu file local không tồn tại (Vercel ephemeral) hoặc URL là HTTP, tải về
  if (!localPath || !fs.existsSync(localPath)) {
    // Thử tải từ URL gốc (Dropbox hoặc URL khác)
    const downloadUrl = doc.file_url?.startsWith('http') ? doc.file_url : null;
    if (downloadUrl) {
      console.log('[SIGN] Local file missing, downloading from:', downloadUrl.substring(0, 80) + '...');
      try {
        const resp = await fetch(downloadUrl);
        if (resp.ok) {
          const buf = Buffer.from(await resp.arrayBuffer());
          const tempDir = pathMod.join(config_.upload.dir, 'temp');
          if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
          const tempPath = pathMod.join(tempDir, `${Date.now()}_${doc.file_name}`);
          fs.writeFileSync(tempPath, buf);
          localPath = tempPath;
        } else {
          console.error('[SIGN] download original failed: HTTP', resp.status);
        }
      } catch (e) { console.error('[SIGN] download original:', e.message); }
    }
  }

  if (!localPath || !fs.existsSync(localPath)) {
    return res.status(400).json({
      success: false,
      error: 'Không tìm thấy file PDF gốc để ký. File có thể đã bị xóa hoặc không tải được từ Dropbox. Vui lòng tải lại tài liệu.',
    });
  }

  try {
    const sigImage = signature_image_base64
      ? Buffer.from(signature_image_base64.replace(/^data:image\/\w+;base64,/, ''), 'base64')
      : null;

    const stampResult = await stampSignatureOnPdf(localPath, {
      signerName,
      signedAt: new Date(signedAt).toLocaleString('vi-VN'),
      method: method === 'remote' ? 'Remote Signing' : 'USB Token',
      issuer: certInfo.issuer || 'N/A',
      serial: certInfo.serial || 'N/A',
    }, stamp_position || null, sigImage);

    // Upload file đã ký lên Dropbox
    const subfolder = `${doc.ma_doc}_da-ky`;
    const uploaded = await dropbox.uploadFile(stampResult.path, `${doc.ma_doc}_signed.pdf`, subfolder);
    signedFileUrl = uploaded.url;
    console.log('[SIGN] Uploaded signed file:', signedFileUrl);
  } catch (e) {
    console.error('[SIGN_STAMP]', e);
    return res.status(500).json({
      success: false,
      error: 'Lỗi khi stamp chữ ký hoặc upload file đã ký: ' + e.message,
    });
  }

  // Lưu chữ ký
  db.prepare(`INSERT INTO signatures
    (document_id, signer_id, certificate_subject, certificate_serial, certificate_issuer,
     certificate_valid_from, certificate_valid_to, signature_algorithm, document_hash_at_sign,
     signature_value, sign_method, signed_at, ip_address, user_agent, otp_verified)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    document_id, req.user.id,
    certInfo.subject, certInfo.serial, certInfo.issuer,
    certInfo.validFrom, certInfo.validTo,
    'SHA256withRSA', docHash, signature_value || '', method, signedAt,
    req.ip, req.get('user-agent') || '', otpVerified
  );

  // Cập nhật trạng thái → "Đã ký" + URL file đã ký
  db.prepare("UPDATE documents SET trang_thai = 'Đã ký', signed_file_url = ?, nguoi_ky_id = ?, ngay_ky = ?, updated_at = datetime('now') WHERE id = ?")
    .run(signedFileUrl, req.user.id, signedAt, document_id);

  auditLog.log({
    userId: req.user.id, userEmail: req.user.email, action: 'DOCUMENT_APPROVED',
    targetType: 'document', targetId: doc.ma_doc,
    detail: { method, otpVerified, signerName },
    ip: req.ip, userAgent: req.get('user-agent'),
  });

  // Notification
  try {
    const notify = require('../services/notify');
    const sender = db.prepare('SELECT ho_ten, email FROM users WHERE id = ?').get(doc.nguoi_tao_id);
    notify.notifyDocumentSigned({
      doc, sender, approver: req.user, status: 'Đã ký',
    }).catch(e => console.error('[Notify approve]', e.message));
  } catch (e) {}

  // Cập nhật trạng thái trên sheet Data
  try {
    const sheetResult = await sheetsData.updateDocumentStatus(doc.ma_doc, {
      'Trạng thái': 'Đã ký',
      'URL': signedFileUrl,
      'Kích thước': '', // giữ nguyên
      'Ghi chú': `Ký bởi ${signerName} lúc ${new Date(signedAt).toLocaleString('vi-VN')}`,
    });
    if (!sheetResult) {
      console.warn('[sheets-data] Không ghi được vào sheet Data cho', doc.ma_doc,
        '— kiểm tra GAS_WEBAPP_URL:', !!process.env.GAS_WEBAPP_URL);
    }
  } catch (e) {
    console.error('[sheets-data update]', e.message);
  }

  res.json({
    success: true,
    data: { ma_doc: doc.ma_doc, trang_thai: 'Đã ký', signed_file_url: signedFileUrl, signer: signerName, signedAt },
  });
});

// POST /signing/reject — Từ chối ký
router.post('/reject', authenticate, requireRole('Admin', 'Quản lý'), (req, res) => {
  const { document_id, ly_do } = req.body;
  if (!document_id) return res.status(400).json({ success: false, error: 'Thiếu document_id.' });
  if (!ly_do || !ly_do.trim()) return res.status(400).json({ success: false, error: 'Vui lòng nhập lý do từ chối.' });

  const db = getDb();
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(document_id);
  if (!doc) return res.status(404).json({ success: false, error: 'Không tìm thấy tài liệu.' });
  if (doc.trang_thai !== 'Chờ ký') return res.status(400).json({ success: false, error: 'Tài liệu không ở trạng thái "Chờ ký".' });

  db.prepare("UPDATE documents SET trang_thai = 'Từ chối', ly_do_tu_choi = ?, nguoi_ky_id = ?, updated_at = datetime('now') WHERE id = ?")
    .run(ly_do.trim(), req.user.id, document_id);

  auditLog.log({
    userId: req.user.id, userEmail: req.user.email, action: 'DOCUMENT_REJECTED',
    targetType: 'document', targetId: doc.ma_doc,
    detail: { reason: ly_do },
    ip: req.ip, userAgent: req.get('user-agent'),
  });

  try {
    const notify = require('../services/notify');
    const sender = db.prepare('SELECT ho_ten, email FROM users WHERE id = ?').get(doc.nguoi_tao_id);
    notify.notifyDocumentSigned({
      doc, sender, approver: req.user, status: 'Từ chối', reason: ly_do,
    }).catch(e => console.error('[Notify reject]', e.message));
  } catch (e) {}

  // Cập nhật trạng thái trên sheet Data
  sheetsData.updateDocumentStatus(doc.ma_doc, {
    'Trạng thái': 'Từ chối',
    'Ghi chú': `Từ chối bởi ${req.user.ho_ten}: ${ly_do}`,
  }).catch(e => console.error('[sheets-data reject]', e.message));

  res.json({ success: true, message: 'Đã từ chối tài liệu.', data: { ma_doc: doc.ma_doc, trang_thai: 'Từ chối' } });
});

// GET /signing/methods
router.get('/methods', authenticate, (req, res) => {
  const methods = [
    { id: 'usb_token', name: 'USB Token', available: true },
    { id: 'vgca', name: 'VGCA Sign Service', available: true },
  ];
  if (remoteSigning.isConfigured()) {
    methods.push({ id: 'remote', name: 'Remote Signing (Cloud CA)', available: true });
  }
  res.json({ success: true, data: methods });
});

module.exports = router;
