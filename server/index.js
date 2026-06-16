const express = require('express');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const { getDb, close } = require('./db/database');
const { hashPassword } = require('./utils/crypto');

const app = express();

// Vercel/Cloudflare/Nginx có proxy phía trước — cần trust để rate-limit & req.ip hoạt động đúng
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { success: false, error: 'Quá nhiều lần thử. Vui lòng đợi 15 phút.' } }));

// Database health check trước mọi route /api/*
app.use('/api', (req, res, next) => {
  if (req.path === '/health') return next();
  try {
    const dbMod = require('./db/database');
    dbMod.getDb();
    // Kéo dữ liệu mới từ Turso về replica (throttled) → instance "ấm" thấy
    // được ghi từ instance khác. Force sync với các method ghi để chắc chắn
    // request đọc ngay sau đó (cùng/khác instance) thấy thay đổi.
    const isWrite = req.method !== 'GET' && req.method !== 'HEAD';
    dbMod.syncReplica(isWrite);
    next();
  }
  catch (e) {
    console.error('[DB pre-check]', e.message, e.stack);
    return res.status(503).json({
      success: false,
      error: 'Database không kết nối được.',
      debug: { message: e.message, hasTurso: !!process.env.TURSO_DATABASE_URL, hasToken: !!process.env.TURSO_AUTH_TOKEN },
    });
  }
});

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(config.upload.dir));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/documents', require('./routes/documents'));
app.use('/api/signing', require('./routes/signing'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/permissions', require('./routes/permissions'));
app.use('/api/projects', require('./routes/projects'));

app.get('/api/health', (req, res) => {
  const sheetsData = require('./services/google-sheets-data');
  const projectSync = require('./services/project-sync');
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: {
      vercel: !!process.env.VERCEL,
      turso: !!process.env.TURSO_DATABASE_URL,
      dropbox: dropbox.isConfigured(),
      gasWebapp: !!process.env.GAS_WEBAPP_URL,
      sheetsData: sheetsData.isConfigured(),
      projectSync: projectSync.isConfigured(),
      googleSheetId: !!process.env.GOOGLE_SHEET_ID,
    },
  });
});

// Dropbox config API (Admin only)
const { authenticate, requireRole } = require('./middleware/auth');
const dropbox = require('./services/dropbox');

app.get('/api/dropbox/status', authenticate, (req, res) => {
  res.json({
    success: true,
    data: {
      configured: dropbox.isConfigured(),
      sharedLink: dropbox.getSharedFolderLink(),
      folder: process.env.DROPBOX_FOLDER || '/eSign/TaiLieuTrinhKy',
    },
  });
});

app.get('/api/dropbox/account', authenticate, requireRole('Admin'), async (req, res) => {
  if (!dropbox.isConfigured()) {
    return res.json({ success: false, error: 'Dropbox chưa được cấu hình. Thêm DROPBOX_ACCESS_TOKEN vào file .env trên server.' });
  }
  const info = await dropbox.getAccountInfo();
  if (info) {
    res.json({ success: true, data: { name: info.name?.display_name, email: info.email } });
  } else {
    res.json({ success: false, error: 'Không thể kết nối Dropbox. Token có thể đã hết hạn.' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err, req, res, _next) => {
  console.error('[Error]', err.message, err.stack);
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ success: false, error: `File vượt quá ${config.upload.maxSizeMB}MB.` });
  }
  // Expose error trên Vercel để debug nhanh (có thể tắt sau khi ổn định)
  const debug = process.env.VERCEL || process.env.NODE_ENV !== 'production';
  res.status(500).json({
    success: false,
    error: 'Lỗi máy chủ nội bộ.',
    ...(debug ? { debug: { message: err.message, type: err.constructor?.name } } : {}),
  });
});


function seedAdmin() {
  const db = getDb();
  const exists = db.prepare("SELECT id FROM users WHERE email = 'admin@esign.local'").get();
  if (!exists) {
    db.prepare(
      "INSERT INTO users (ma_nv, ho_ten, email, phan_quyen, password_hash) VALUES ('ADMIN001', 'Quản trị viên', 'admin@esign.local', 'Admin', '$2b$04$H48PbHXQ6fGf3d1k/GFJlOspm2q/A8wl89.EkWRIeMGSjwSMOed6G')"
    ).run();
    console.log('[Seed] Tài khoản admin mặc định: admin@esign.local / admin123');
  }
}

try { seedAdmin(); } catch (e) { console.error('[Seed]', e.message); }

// Trên Vercel (serverless), không gọi listen — export app.
if (!process.env.VERCEL) {
  app.listen(config.port, () => {
    console.log(`[eSign] Server đang chạy tại http://localhost:${config.port}`);
  });
}

process.on('SIGINT', () => { close(); process.exit(0); });
process.on('SIGTERM', () => { close(); process.exit(0); });
process.on('uncaughtException', (err) => { console.error('[Uncaught]', err.message); });
process.on('unhandledRejection', (err) => { console.error('[Unhandled]', err); });

module.exports = app;
