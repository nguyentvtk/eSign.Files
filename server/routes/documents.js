const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const config = require('../config');
const { getDb } = require('../db/database');
const { authenticate, requirePermission } = require('../middleware/auth');
const { audit } = require('../middleware/audit');
const { hashPdfFile } = require('../utils/pdf-utils');
const dropbox = require('../services/dropbox');
const sheetsData = require('../services/google-sheets-data');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(config.upload.dir, 'temp');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const safeName = Buffer.from(file.originalname, 'latin1').toString('utf8').replace(/[^a-zA-Z0-9._\-À-ɏḀ-ỿ]/g, '_');
    cb(null, unique + '_' + safeName);
  },
});

const ALLOWED_TYPES = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];

const upload = multer({
  storage,
  limits: { fileSize: config.upload.maxSizeMB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'file' && file.mimetype !== 'application/pdf') {
      return cb(new Error('File trình ký phải là PDF.'));
    }
    if (file.fieldname === 'attachments' && !ALLOWED_TYPES.includes(file.mimetype)) {
      return cb(new Error('File đính kèm chỉ chấp nhận PDF hoặc DOCX.'));
    }
    cb(null, true);
  },
});

const uploadFields = upload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'attachments', maxCount: 5 },
]);

function generateDocCode(loai) {
  const prefix = { 'hop-dong': 'HĐ', 'bien-ban': 'BB', 'van-ban-hc': 'VB', 'to-trinh': 'TT', 'cong-van': 'CV' }[loai] || 'TL';
  const year = new Date().getFullYear();
  const seq = String(Math.floor(Math.random() * 9000) + 1000);
  return `${prefix}-${year}-${seq}`;
}

// Sinh số văn bản tự động theo loại + năm + project
function generateAutoNumber(loai_van_ban, project_id) {
  const db = getDb();
  const year = new Date().getFullYear();
  const prefix = ({
    'Quyết định': 'QĐ', 'Tờ trình': 'TTr', 'Công văn': 'CV', 'Báo cáo': 'BC',
    'Kế hoạch': 'KH', 'Hợp đồng': 'HĐ', 'Phụ lục Hợp đồng': 'PL', 'Biên bản': 'BB',
    'Thông báo': 'TB', 'Nghị quyết': 'NQ',
  })[loai_van_ban] || 'VB';

  let sql = `SELECT COUNT(*) as c FROM documents WHERE loai_van_ban = ? AND strftime('%Y', created_at) = ?`;
  const params = [loai_van_ban, String(year)];
  if (project_id) { sql += ' AND project_id = ?'; params.push(project_id); }
  const { c } = db.prepare(sql).get(...params);
  const seq = String(c + 1).padStart(3, '0');
  return `${seq}/${prefix}-${year}`;
}

// GET /documents/next-number?loai=Quyết định&project_id=1
router.get('/next-number', authenticate, (req, res) => {
  const { loai, project_id } = req.query;
  if (!loai) return res.status(400).json({ success: false, error: 'Thiếu tham số loai.' });
  const num = generateAutoNumber(loai, project_id ? parseInt(project_id) : null);
  res.json({ success: true, data: { so_van_ban: num } });
});

// GET /documents — Admin/QL thấy tất cả, Người dùng chỉ thấy tài liệu của mình
router.get('/', authenticate, (req, res) => {
  const db = getDb();
  const { status, search, limit = 50, offset = 0 } = req.query;
  const isAdmin = req.user.phan_quyen === 'Admin' || req.user.phan_quyen === 'Quản lý';

  let sql = 'SELECT d.*, u.ho_ten as nguoi_tao_name, u.ma_nv as nguoi_tao_manv FROM documents d LEFT JOIN users u ON d.nguoi_tao_id = u.id WHERE 1=1';
  const params = [];

  if (!isAdmin) {
    sql += ' AND d.nguoi_tao_id = ?';
    params.push(req.user.id);
  }
  if (status) { sql += ' AND d.trang_thai = ?'; params.push(status); }
  if (search) { sql += ' AND (d.ten_tai_lieu LIKE ? OR d.ma_doc LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }

  const countSql = sql.replace('SELECT d.*, u.ho_ten as nguoi_tao_name, u.ma_nv as nguoi_tao_manv', 'SELECT COUNT(*) as total');
  const { total } = db.prepare(countSql).get(...params);

  sql += ' ORDER BY d.created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), parseInt(offset));

  const docs = db.prepare(sql).all(...params);
  docs.forEach(doc => {
    doc.attachments = db.prepare('SELECT id, file_name, file_size, file_type, file_url FROM attachments WHERE document_id = ?').all(doc.id);
  });

  res.json({ success: true, data: docs, meta: { total } });
});

// GET /documents/pending — tài liệu chờ ký (cho Admin/Quản lý duyệt)
router.get('/pending', authenticate, requirePermission('Tài liệu chờ ký'), (req, res) => {
  const db = getDb();
  const docs = db.prepare(`
    SELECT d.*, u.ho_ten as nguoi_tao_name, u.ma_nv as nguoi_tao_manv, u.phong_ban as nguoi_tao_phongban
    FROM documents d
    JOIN users u ON d.nguoi_tao_id = u.id
    WHERE d.trang_thai = 'Chờ ký'
    ORDER BY d.created_at DESC
  `).all();

  docs.forEach(doc => {
    doc.attachments = db.prepare('SELECT id, file_name, file_size, file_type, file_url FROM attachments WHERE document_id = ?').all(doc.id);
  });

  res.json({ success: true, data: docs });
});

// GET /documents/proxy?url=<dropbox url> — stream file qua server để tránh CORS
// trên trình duyệt (Dropbox không cho fetch cross-origin & ?dl=0 trả HTML preview).
// Giới hạn host Dropbox để không thành open-proxy. PHẢI khai báo trước route /:id.
router.get('/proxy', authenticate, async (req, res) => {
  const raw = req.query.url;
  if (!raw || !/^https?:\/\//i.test(raw)) {
    return res.status(400).json({ success: false, error: 'Thiếu hoặc sai URL.' });
  }
  let u;
  try { u = new URL(raw); } catch { return res.status(400).json({ success: false, error: 'URL không hợp lệ.' }); }
  if (!/(^|\.)dropbox(usercontent)?\.com$/i.test(u.hostname)) {
    return res.status(403).json({ success: false, error: 'Chỉ hỗ trợ proxy file Dropbox.' });
  }
  try {
    u.searchParams.set('dl', '1'); // ép tải file thô thay vì trang preview
    const r = await fetch(u.toString(), { redirect: 'follow' });
    if (!r.ok) return res.status(502).json({ success: false, error: 'Không tải được file nguồn: HTTP ' + r.status });
    const ct = r.headers.get('content-type') || '';
    // Dropbox trả HTML khi link sai → chặn để client báo lỗi rõ ràng
    res.setHeader('Content-Type', ct.includes('html') ? 'application/pdf' : (ct || 'application/pdf'));
    res.setHeader('Cache-Control', 'private, max-age=300');
    const ab = await r.arrayBuffer();
    res.send(Buffer.from(ab));
  } catch (e) {
    console.error('[doc proxy]', e.message);
    res.status(502).json({ success: false, error: e.message });
  }
});

// GET /documents/:id
router.get('/:id', authenticate, (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT d.*, u.ho_ten as nguoi_tao_name, u.ma_nv as nguoi_tao_manv FROM documents d LEFT JOIN users u ON d.nguoi_tao_id = u.id WHERE d.id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ success: false, error: 'Không tìm thấy tài liệu.' });

  const isAdmin = req.user.phan_quyen === 'Admin' || req.user.phan_quyen === 'Quản lý';
  if (!isAdmin && doc.nguoi_tao_id !== req.user.id) {
    return res.status(403).json({ success: false, error: 'Bạn không có quyền xem tài liệu này.' });
  }

  doc.attachments = db.prepare('SELECT * FROM attachments WHERE document_id = ?').all(doc.id);
  doc.signatures = db.prepare(
    'SELECT s.*, u.ho_ten as signer_name FROM signatures s LEFT JOIN users u ON s.signer_id = u.id WHERE s.document_id = ? ORDER BY s.signed_at'
  ).all(doc.id);

  res.json({ success: true, data: doc });
});

// POST /documents — tạo tài liệu trình ký
router.post('/', authenticate, requirePermission('Khởi tạo tài liệu'), (req, res, next) => {
  uploadFields(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ success: false, error: `File vượt quá ${config.upload.maxSizeMB}MB.` });
      if (err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ success: false, error: 'Tối đa 5 file đính kèm.' });
      return res.status(400).json({ success: false, error: err.message });
    }

    if (!req.files?.file?.[0]) {
      return res.status(400).json({ success: false, error: 'Vui lòng tải lên file PDF trình ký.' });
    }

    const { ten_tai_lieu, loai_tai_lieu, trich_yeu, ghi_chu,
            project_id, phase_id, loai_van_ban, so_van_ban, so_van_ban_mode, nguoi_duyet_id,
            ngay_phat_hanh } = req.body;
    if (!ten_tai_lieu) return res.status(400).json({ success: false, error: 'Tên tài liệu không được để trống.' });

    try {
      const db = getDb();
      const mainFile = req.files.file[0];
      const maDoc = generateDocCode(loai_tai_lieu || 'van-ban-hc');
      const fileHash = hashPdfFile(mainFile.path);

      // Sinh số văn bản tự động nếu cần
      let finalSoVanBan = so_van_ban || '';
      if (so_van_ban_mode === 'auto' && loai_van_ban) {
        finalSoVanBan = generateAutoNumber(loai_van_ban, project_id ? parseInt(project_id) : null);
      }

      // Upload file chính lên Dropbox
      const subfolder = `${maDoc}_${req.user.ma_nv}`;
      const mainUpload = await dropbox.uploadFile(mainFile.path, mainFile.originalname, subfolder);

      const result = db.prepare(`INSERT INTO documents
        (ma_doc, ten_tai_lieu, loai_tai_lieu, trich_yeu, nguoi_tao_id, file_name, file_size, file_hash_sha256, file_url, dropbox_path, ghi_chu,
         project_id, phase_id, loai_van_ban, so_van_ban, so_van_ban_mode, nguoi_duyet_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        maDoc, ten_tai_lieu.trim(), loai_tai_lieu || 'van-ban-hc', trich_yeu || '',
        req.user.id, mainFile.originalname, mainFile.size, fileHash,
        mainUpload.url, mainUpload.dropboxPath, ghi_chu || '',
        project_id ? parseInt(project_id) : null,
        phase_id ? parseInt(phase_id) : null,
        loai_van_ban || '',
        finalSoVanBan,
        so_van_ban_mode || 'auto',
        nguoi_duyet_id ? parseInt(nguoi_duyet_id) : null
      );

      const docId = result.lastInsertRowid;

      // Upload file đính kèm (tối đa 5)
      const attachFiles = req.files.attachments || [];
      if (attachFiles.length > 5) {
        return res.status(400).json({ success: false, error: 'Tối đa 5 file đính kèm.' });
      }

      const insertAttach = db.prepare('INSERT INTO attachments (document_id, file_name, file_size, file_type, file_url, dropbox_path) VALUES (?, ?, ?, ?, ?, ?)');
      for (const att of attachFiles) {
        const attUpload = await dropbox.uploadFile(att.path, att.originalname, subfolder + '/dinh-kem');
        const ext = path.extname(att.originalname).toLowerCase();
        insertAttach.run(docId, att.originalname, att.size, ext === '.pdf' ? 'PDF' : 'DOCX', attUpload.url, attUpload.dropboxPath);
      }

      // Cleanup temp files
      [mainFile, ...attachFiles].forEach(f => { try { fs.unlinkSync(f.path); } catch {} });

      const auditLog = require('../services/audit-log');
      auditLog.log({
        userId: req.user.id, userEmail: req.user.email, action: 'DOC_CREATE',
        targetType: 'document', targetId: maDoc,
        detail: { ten_tai_lieu, loai_tai_lieu, attachments: attachFiles.length, project_id, phase_id, so_van_ban: finalSoVanBan },
        ip: req.ip, userAgent: req.get('user-agent'),
      });

      // Gửi thông báo Telegram + Email cho người gửi & người duyệt
      try {
        const notify = require('../services/notify');
        const approver = nguoi_duyet_id ? db.prepare('SELECT id, ho_ten, email, ma_nv FROM users WHERE id = ?').get(parseInt(nguoi_duyet_id)) : null;
        const project = project_id ? db.prepare('SELECT ten_du_an FROM projects WHERE id = ?').get(parseInt(project_id)) : null;
        const phase = phase_id ? db.prepare('SELECT ten_giai_doan FROM project_phases WHERE id = ?').get(parseInt(phase_id)) : null;
        notify.notifyDocumentSubmitted({
          doc: { ma_doc: maDoc, ten_tai_lieu, loai_van_ban, loai_tai_lieu, so_van_ban: finalSoVanBan },
          sender: req.user,
          approver,
          projectName: project?.ten_du_an,
          phaseName: phase?.ten_giai_doan,
        }).catch(e => console.error('[Notify]', e.message));
      } catch (e) { console.error('[Notify wrap]', e.message); }

      // Ghi thông tin vào sheet Data
      try {
        const project = project_id ? db.prepare('SELECT ten_du_an FROM projects WHERE id = ?').get(parseInt(project_id)) : null;
        const approverRow = nguoi_duyet_id ? db.prepare('SELECT ho_ten FROM users WHERE id = ?').get(parseInt(nguoi_duyet_id)) : null;
        sheetsData.appendDocumentRow({
          ngayTao: new Date().toISOString(),
          maDoc,
          soVanBan: finalSoVanBan,
          tenTaiLieu: ten_tai_lieu,
          loaiTaiLieu: loai_van_ban || loai_tai_lieu || '',
          tenDuAn: project?.ten_du_an || '',
          tenFile: mainFile.originalname,
          fileUrl: mainUpload.url,
          fileSize: mainFile.size,
          nguoiTao: req.user.email || req.user.ho_ten,
          nguoiKy: approverRow?.ho_ten || '',
          trangThai: 'Chờ ký',
          ghiChu: ghi_chu || '',
          ngayPhatHanh: ngay_phat_hanh || '',
        }).catch(e => console.error('[sheets-data write]', e.message));
      } catch (e) { console.error('[sheets-data wrap]', e.message); }

      res.status(201).json({ success: true, data: { id: docId, ma_doc: maDoc, so_van_ban: finalSoVanBan, file_url: mainUpload.url } });
    } catch (e) {
      console.error('[DOC_CREATE]', e);
      res.status(500).json({ success: false, error: 'Lỗi tạo tài liệu: ' + e.message });
    }
  });
});

// POST /documents/:id/replace-main — Lãnh đạo thay thế file PDF chính (sau khi sửa DOCX→PDF)
const singleUpload = multer({
  storage,
  limits: { fileSize: config.upload.maxSizeMB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') return cb(new Error('Chỉ chấp nhận PDF.'));
    cb(null, true);
  },
}).single('file');

router.post('/:id/replace-main', authenticate, (req, res, next) => {
  if (!['Admin', 'Quản lý'].includes(req.user.phan_quyen)) {
    return res.status(403).json({ success: false, error: 'Chỉ Admin/Quản lý được phép sửa tài liệu.' });
  }
  singleUpload(req, res, async (err) => {
    if (err) return res.status(400).json({ success: false, error: err.message });
    if (!req.file) return res.status(400).json({ success: false, error: 'Chưa có file PDF.' });

    try {
      const db = getDb();
      const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
      if (!doc) return res.status(404).json({ success: false, error: 'Không tìm thấy tài liệu.' });
      if (doc.trang_thai !== 'Chờ ký') return res.status(400).json({ success: false, error: 'Chỉ thay thế được tài liệu ở trạng thái "Chờ ký".' });

      const newHash = hashPdfFile(req.file.path);
      const newName = req.file.originalname;
      const subfolder = `${doc.ma_doc}_replaced`;
      const uploaded = await dropbox.uploadFile(req.file.path, newName, subfolder);

      db.prepare(`UPDATE documents SET file_name=?, file_size=?, file_hash_sha256=?, file_url=?, dropbox_path=?, updated_at=datetime('now') WHERE id=?`)
        .run(newName, req.file.size, newHash, uploaded.url, uploaded.dropboxPath, doc.id);

      try { fs.unlinkSync(req.file.path); } catch {}

      require('../services/audit-log').log({
        userId: req.user.id, userEmail: req.user.email, action: 'DOC_REPLACE_MAIN',
        targetType: 'document', targetId: doc.ma_doc,
        detail: { old_file: doc.file_name, new_file: newName, old_hash: doc.file_hash_sha256, new_hash: newHash },
        ip: req.ip, userAgent: req.get('user-agent'),
      });

      res.json({ success: true, data: { file_url: uploaded.url, file_name: newName, file_hash: newHash } });
    } catch (e) {
      console.error('[REPLACE_MAIN]', e);
      res.status(500).json({ success: false, error: 'Lỗi thay thế file: ' + e.message });
    }
  });
});

// POST /documents/:id/convert-attachment — Chuyển DOCX đính kèm sang PDF
router.post('/:id/convert-attachment', authenticate, async (req, res) => {
  if (!['Admin', 'Quản lý'].includes(req.user.phan_quyen)) {
    return res.status(403).json({ success: false, error: 'Không có quyền.' });
  }
  const { attachment_id } = req.body;
  if (!attachment_id) return res.status(400).json({ success: false, error: 'Thiếu attachment_id.' });

  const db = getDb();
  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(attachment_id);
  if (!att) return res.status(404).json({ success: false, error: 'Không tìm thấy file đính kèm.' });

  const docxConvert = require('../services/docx-convert');

  // Tải file đính kèm về local
  let localDocx = '';
  if (att.file_url?.startsWith('/uploads')) {
    localDocx = path.join(config.upload.dir, att.file_url.replace('/uploads/', ''));
  } else if (att.file_url?.startsWith('http')) {
    try {
      const r = await fetch(att.file_url);
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        localDocx = path.join(config.upload.dir, 'temp', `${Date.now()}_${att.file_name}`);
        fs.mkdirSync(path.dirname(localDocx), { recursive: true });
        fs.writeFileSync(localDocx, buf);
      }
    } catch (e) { return res.status(500).json({ success: false, error: 'Không tải được file: ' + e.message }); }
  }

  if (!localDocx || !fs.existsSync(localDocx)) {
    return res.status(500).json({ success: false, error: 'Không tìm thấy file local.' });
  }

  try {
    const pdfPath = localDocx.replace(/\.docx$/i, '.pdf');
    await docxConvert.docxToPdf(localDocx, pdfPath);
    const pdfHash = hashPdfFile(pdfPath);
    const newName = att.file_name.replace(/\.docx$/i, '.pdf');

    // Upload PDF vừa convert
    const doc = db.prepare('SELECT ma_doc FROM documents WHERE id = ?').get(req.params.id);
    const subfolder = `${doc.ma_doc}_converted`;
    const uploaded = await dropbox.uploadFile(pdfPath, newName, subfolder);

    res.json({ success: true, data: { file_url: uploaded.url, file_name: newName, file_hash: pdfHash, size: fs.statSync(pdfPath).size } });
    try { fs.unlinkSync(pdfPath); } catch {}
  } catch (e) {
    console.error('[CONVERT_DOCX]', e);
    res.status(500).json({
      success: false,
      error: 'LibreOffice chưa được cài trên máy chủ. Vui lòng cài LibreOffice hoặc tải DOCX về máy để chuyển PDF thủ công. Lỗi: ' + e.message,
    });
  }
});

// GET /documents/:id/download
router.get('/:id/download', authenticate, (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ success: false, error: 'Không tìm thấy.' });

  if (doc.file_url && doc.file_url.startsWith('http')) {
    return res.redirect(doc.file_url);
  }
  const localPath = path.join(config.upload.dir, doc.file_url?.replace('/uploads/', '') || '');
  if (fs.existsSync(localPath)) return res.download(localPath, doc.file_name);
  res.status(404).json({ success: false, error: 'File không tồn tại.' });
});

// GET /documents/:id/verify — xác minh tính toàn vẹn
router.get('/:id/verify', authenticate, requirePermission('Xác minh tài liệu'), (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ success: false, error: 'Không tìm thấy tài liệu.' });

  const signatures = db.prepare(
    'SELECT s.*, u.ho_ten as signer_name FROM signatures s LEFT JOIN users u ON s.signer_id = u.id WHERE s.document_id = ?'
  ).all(doc.id);

  const attachments = db.prepare('SELECT * FROM attachments WHERE document_id = ?').all(doc.id);

  res.json({
    success: true,
    data: {
      document: { ma_doc: doc.ma_doc, ten_tai_lieu: doc.ten_tai_lieu, trang_thai: doc.trang_thai, file_hash: doc.file_hash_sha256 },
      signatures: signatures.map(sig => ({
        signerName: sig.signer_name,
        signedAt: sig.signed_at,
        algorithm: sig.signature_algorithm,
        certSubject: sig.certificate_subject,
        certIssuer: sig.certificate_issuer,
        certSerial: sig.certificate_serial,
        certValidTo: sig.certificate_valid_to,
        certExpired: sig.certificate_valid_to ? new Date(sig.certificate_valid_to) < new Date() : null,
        signMethod: sig.sign_method,
        documentHashAtSign: sig.document_hash_at_sign,
        otpVerified: !!sig.otp_verified,
      })),
      attachments,
    },
  });
});

module.exports = router;
