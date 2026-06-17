const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const router = express.Router();
const config = require('../config');
const { getDb } = require('../db/database');
const { authenticate, requireRole } = require('../middleware/auth');
const auditLog = require('../services/audit-log');
const otpService = require('../services/otp');
const { stampSignatureOnPdf, verifyDocumentIntegrity } = require('../services/signing');
const { parseCertificateBase64, getSignerName } = require('../services/certificate');
const { verifyPdfBuffer } = require('../services/pdf-signature-verify');
const remoteSigning = require('../services/remote-signing');
const dropbox = require('../services/dropbox');
const { hashPdfFile } = require('../utils/pdf-utils');
const sheetsData = require('../services/google-sheets-data');

// Multer cho upload PDF đã ký (ký rời) — lưu tạm rồi đọc buffer để verify
const signedUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(config.upload.dir, 'temp');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, Date.now() + '_signed.pdf'),
  }),
  limits: { fileSize: (config.upload.maxSizeMB || 25) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') return cb(new Error('File phải là PDF đã ký.'));
    cb(null, true);
  },
}).single('signed_file');

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
    // Thử tải từ URL gốc (Dropbox hoặc URL khác). Với link Dropbox phải ép
    // dl=1 — nếu để ?dl=0, Dropbox trả TRANG HTML preview (không phải PDF),
    // khiến pdf-lib báo "No PDF header found" khi stamp.
    let downloadUrl = doc.file_url?.startsWith('http') ? doc.file_url : null;
    if (downloadUrl) {
      try {
        const u = new URL(downloadUrl);
        if (/(^|\.)dropbox(usercontent)?\.com$/i.test(u.hostname)) {
          u.searchParams.set('dl', '1');
          downloadUrl = u.toString();
        }
      } catch {}
      console.log('[SIGN] Local file missing, downloading from:', downloadUrl.substring(0, 80) + '...');
      try {
        const resp = await fetch(downloadUrl, { redirect: 'follow' });
        if (resp.ok) {
          const buf = Buffer.from(await resp.arrayBuffer());
          // Chặn trường hợp tải nhầm HTML (link sai) → báo lỗi rõ thay vì stamp lỗi
          if (buf.slice(0, 5).toString('latin1') !== '%PDF-') {
            console.error('[SIGN] downloaded file không phải PDF (5 byte đầu):', buf.slice(0, 5).toString('latin1'));
          } else {
            const tempDir = pathMod.join(config_.upload.dir, 'temp');
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
            const tempPath = pathMod.join(tempDir, `${Date.now()}_${doc.file_name}`);
            fs.writeFileSync(tempPath, buf);
            localPath = tempPath;
          }
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
    const toBuf = (dataUrl) => dataUrl
      ? Buffer.from(String(dataUrl).replace(/^data:image\/\w+;base64,/, ''), 'base64')
      : null;

    // Ảnh chữ ký tay & con dấu của lãnh đạo (đã upload trong hồ sơ). Nếu request
    // gửi kèm signature_image_base64 thì ưu tiên (vd vẽ tại chỗ).
    const signerImgs = db.prepare('SELECT chu_ky_image, con_dau_image FROM users WHERE id = ?').get(req.user.id) || {};
    const sigImage = toBuf(signature_image_base64) || toBuf(signerImgs.chu_ky_image);
    const sealImage = toBuf(signerImgs.con_dau_image);

    const stampResult = await stampSignatureOnPdf(localPath, {
      signerName,
      signedAt: new Date(signedAt).toLocaleString('vi-VN'),
      method: method === 'remote' ? 'Remote Signing' : 'USB Token',
      issuer: certInfo.issuer || 'N/A',
      serial: certInfo.serial || 'N/A',
    }, stamp_position || null, sigImage, sealImage);

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

// POST /signing/upload-signed — Ký rời: upload PDF đã ký bằng app desktop (VGCA Ban Cơ yếu…)
// Server XÁC MINH chữ ký số nhúng (PKCS#7/PAdES) rồi lưu file nguyên trạng (KHÔNG stamp đè).
router.post('/upload-signed', authenticate, requireRole('Admin', 'Quản lý'), (req, res) => {
  signedUpload(req, res, async (uploadErr) => {
    if (uploadErr) {
      return res.status(400).json({ success: false, error: uploadErr.message || 'Lỗi upload file.' });
    }
    const { document_id, otp_token } = req.body;
    const tmpPath = req.file?.path;
    const cleanup = () => { try { if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {} };

    try {
      if (!document_id) { cleanup(); return res.status(400).json({ success: false, error: 'Thiếu document_id.' }); }
      if (!tmpPath) return res.status(400).json({ success: false, error: 'Chưa nhận được file PDF đã ký.' });

      const db = getDb();
      const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(document_id);
      if (!doc) { cleanup(); return res.status(404).json({ success: false, error: 'Không tìm thấy tài liệu.' }); }
      if (doc.trang_thai !== 'Chờ ký') { cleanup(); return res.status(400).json({ success: false, error: 'Tài liệu không ở trạng thái "Chờ ký".' }); }

      // OTP 2 lớp (nếu user bật) — đồng bộ với luồng /approve
      const user = db.prepare('SELECT otp_enabled, otp_secret FROM users WHERE id = ?').get(req.user.id);
      let otpVerified = 0;
      if (user.otp_enabled) {
        if (!otp_token) { cleanup(); return res.status(400).json({ success: false, error: 'Xác thực 2 lớp bắt buộc. Vui lòng nhập mã OTP.' }); }
        if (!otpService.verifyToken(user.otp_secret, otp_token)) {
          auditLog.log({ userId: req.user.id, userEmail: req.user.email, action: 'SIGN_OTP_FAILED', targetType: 'document', targetId: doc.ma_doc, ip: req.ip, userAgent: req.get('user-agent') });
          cleanup();
          return res.status(401).json({ success: false, error: 'Mã OTP không chính xác.' });
        }
        otpVerified = 1;
      }

      // ── XÁC MINH chữ ký số nhúng ──
      const verifyResult = verifyPdfBuffer(fs.readFileSync(tmpPath));
      if (!verifyResult.valid) {
        auditLog.log({
          userId: req.user.id, userEmail: req.user.email, action: 'SIGN_VERIFY_FAILED',
          targetType: 'document', targetId: doc.ma_doc,
          detail: { reason: verifyResult.reason, signatureCount: verifyResult.signatureCount },
          ip: req.ip, userAgent: req.get('user-agent'),
        });
        cleanup();
        return res.status(400).json({
          success: false,
          error: 'Chữ ký số không hợp lệ: ' + (verifyResult.reason || 'không xác minh được.'),
          detail: { contentIntegrity: verifyResult.contentIntegrity, cryptoVerified: verifyResult.cryptoVerified },
        });
      }

      // ── Bắt buộc chuỗi chứng thư neo vào Root CA tin cậy (VGCA) ──
      // Có thể nới lỏng bằng env ALLOW_UNTRUSTED_CA=1 (môi trường dev / CA chưa nạp).
      const allowUntrusted = process.env.ALLOW_UNTRUSTED_CA === '1';
      if (verifyResult.trustConfigured && !verifyResult.trusted && !allowUntrusted) {
        auditLog.log({
          userId: req.user.id, userEmail: req.user.email, action: 'SIGN_CHAIN_UNTRUSTED',
          targetType: 'document', targetId: doc.ma_doc,
          detail: { reason: verifyResult.chainReason, chain: verifyResult.chain },
          ip: req.ip, userAgent: req.get('user-agent'),
        });
        cleanup();
        return res.status(400).json({
          success: false,
          error: 'Chứng thư không thuộc chuỗi tin cậy: ' + (verifyResult.chainReason || 'không neo vào Root CA tin cậy.'),
          detail: { chain: verifyResult.chain },
        });
      }

      const certInfo = verifyResult.signer || {};
      const signerName = certInfo.subject ? getSignerName(certInfo) : req.user.ho_ten;
      const signedAt = verifyResult.signingTime || new Date().toISOString();

      // Upload file đã ký NGUYÊN TRẠNG lên Dropbox (không stamp đè để giữ chữ ký hợp lệ)
      let signedFileUrl;
      try {
        const uploaded = await dropbox.uploadFile(tmpPath, `${doc.ma_doc}_signed.pdf`, `${doc.ma_doc}_da-ky`);
        signedFileUrl = uploaded.url;
        console.log('[SIGN-UPLOAD] Uploaded signed file:', signedFileUrl);
      } catch (e) {
        console.error('[SIGN-UPLOAD]', e);
        cleanup();
        return res.status(500).json({ success: false, error: 'Lỗi khi lưu file đã ký: ' + e.message });
      }

      // Lưu chữ ký với thông tin chứng thư THẬT trích từ file
      db.prepare(`INSERT INTO signatures
        (document_id, signer_id, certificate_subject, certificate_serial, certificate_issuer,
         certificate_valid_from, certificate_valid_to, signature_algorithm, document_hash_at_sign,
         signature_value, sign_method, signed_at, ip_address, user_agent, otp_verified)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        document_id, req.user.id,
        certInfo.subject || '', certInfo.serial || '', certInfo.issuer || '',
        certInfo.validFrom || '', certInfo.validTo || '',
        certInfo.algorithm || 'SHA256withRSA', doc.file_hash_sha256,
        `PAdES detached | integrity=${verifyResult.contentIntegrity} crypto=${verifyResult.cryptoVerified} trusted=${verifyResult.trusted} | anchor=${verifyResult.trustAnchor || 'N/A'} | sigs=${verifyResult.signatureCount}`,
        'vgca_detached', signedAt,
        req.ip, req.get('user-agent') || '', otpVerified
      );

      db.prepare("UPDATE documents SET trang_thai = 'Đã ký', signed_file_url = ?, nguoi_ky_id = ?, ngay_ky = ?, updated_at = datetime('now') WHERE id = ?")
        .run(signedFileUrl, req.user.id, signedAt, document_id);

      auditLog.log({
        userId: req.user.id, userEmail: req.user.email, action: 'DOCUMENT_APPROVED',
        targetType: 'document', targetId: doc.ma_doc,
        detail: { method: 'vgca_detached', otpVerified, signerName, digestAlgorithm: verifyResult.digestAlgorithm },
        ip: req.ip, userAgent: req.get('user-agent'),
      });

      try {
        const notify = require('../services/notify');
        const sender = db.prepare('SELECT ho_ten, email FROM users WHERE id = ?').get(doc.nguoi_tao_id);
        notify.notifyDocumentSigned({ doc, sender, approver: req.user, status: 'Đã ký' })
          .catch(e => console.error('[Notify upload-signed]', e.message));
      } catch (e) {}

      try {
        await sheetsData.updateDocumentStatus(doc.ma_doc, {
          'Trạng thái': 'Đã ký', 'URL': signedFileUrl,
          'Ghi chú': `Ký số (ký rời) bởi ${signerName} lúc ${new Date(signedAt).toLocaleString('vi-VN')}`,
        });
      } catch (e) { console.error('[sheets-data upload-signed]', e.message); }

      cleanup();
      res.json({
        success: true,
        data: {
          ma_doc: doc.ma_doc, trang_thai: 'Đã ký', signed_file_url: signedFileUrl,
          signer: signerName, signedAt,
          certificate: certInfo, digestAlgorithm: verifyResult.digestAlgorithm,
          trusted: verifyResult.trusted, trustAnchor: verifyResult.trustAnchor, chain: verifyResult.chain,
        },
      });
    } catch (e) {
      console.error('[upload-signed]', e);
      cleanup();
      res.status(500).json({ success: false, error: e.message || 'Lỗi xử lý file đã ký.' });
    }
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
    { id: 'vgca_detached', name: 'Ký rời bằng VGCA / app desktop (upload PDF đã ký)', available: true, recommended: true },
    { id: 'usb_token', name: 'USB Token qua middleware (thử nghiệm)', available: true },
  ];
  if (remoteSigning.isConfigured()) {
    methods.push({ id: 'remote', name: 'Remote Signing (Cloud CA)', available: true });
  }
  res.json({ success: true, data: methods });
});

module.exports = router;
