require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const PROJECT_ROOT = path.join(__dirname, '..');

function _resolveRelative(p, fallback) {
  if (!p) return path.join(PROJECT_ROOT, fallback);
  if (path.isAbsolute(p)) return p;
  return path.join(PROJECT_ROOT, p);
}

module.exports = {
  port: parseInt(process.env.PORT, 10) || 3000,
  db: {
    path: _resolveRelative(process.env.DB_PATH, 'data/esign.db'),
  },
  jwt: {
    // Fallback ngẫu nhiên (auto-generated mỗi lần khởi động) — đảm bảo app không crash khi env chưa set.
    // ⚠️  Trên production PHẢI set env var JWT_SECRET cố định, nếu không user sẽ bị logout mỗi cold start!
    secret: process.env.JWT_SECRET || (() => {
      const fallback = require('crypto').randomBytes(32).toString('hex');
      console.warn('[CONFIG] ⚠️  JWT_SECRET chưa được cấu hình — dùng fallback random (token sẽ invalid sau mỗi cold start). Cấu hình env var JWT_SECRET trên Vercel.');
      return fallback;
    })(),
    refreshSecret: process.env.JWT_REFRESH_SECRET || (() => {
      return require('crypto').randomBytes(32).toString('hex');
    })(),
    accessTtl: parseInt(process.env.JWT_ACCESS_TTL, 10) || 900,
    refreshTtl: parseInt(process.env.JWT_REFRESH_TTL, 10) || 604800,
  },
  otp: {
    issuer: process.env.OTP_ISSUER || 'eSign',
  },
  upload: {
    // Vercel serverless: chỉ /tmp writable. Tự dùng /tmp/uploads nếu chạy trên Vercel.
    dir: process.env.VERCEL ? '/tmp/uploads' : _resolveRelative(process.env.UPLOAD_DIR, 'uploads'),
    maxSizeMB: parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 25,
  },
  remoteCa: {
    url: process.env.REMOTE_CA_URL || '',
    apiKey: process.env.REMOTE_CA_API_KEY || '',
    provider: process.env.REMOTE_CA_PROVIDER || '',
  },
};
