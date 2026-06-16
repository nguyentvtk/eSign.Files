-- eSign Database Schema — Tuân thủ TT22/2020 & Luật GDĐT 2023
-- Map theo cấu trúc Google Sheets: Nguoi_Dung, Phan_Quyen, Data
-- LƯU Ý: KHÔNG đặt PRAGMA ở đây — remote Turso báo "Sqlite3UnsupportedStatement"
-- và HỦY toàn bộ batch exec(schema) → không bảng nào được tạo. Pragmas set bằng
-- code trong database.js (journal_mode cho file local; foreign_keys mọi nơi).

-- ═══════════════════════════════════════════════════════════
-- NGƯỜI DÙNG (Sheet: Nguoi_Dung)
-- A: Mã NV | B: Họ tên | C: Email | D: SĐT | E: Chức vụ | F: Phòng ban | G: Phân quyền | H: Mật khẩu | I: Hình đại diện
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ma_nv         TEXT    NOT NULL UNIQUE,
  ho_ten        TEXT    NOT NULL,
  email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  phone         TEXT    DEFAULT '',
  chuc_vu       TEXT    DEFAULT '',
  phong_ban     TEXT    DEFAULT '',
  phan_quyen    TEXT    NOT NULL DEFAULT 'Người dùng' CHECK(phan_quyen IN ('Admin','Quản lý','Người dùng')),
  password_hash TEXT    NOT NULL,
  otp_secret    TEXT    DEFAULT NULL,
  otp_enabled   INTEGER NOT NULL DEFAULT 0,
  avatar_url    TEXT    DEFAULT '',
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ═══════════════════════════════════════════════════════════
-- PHIÊN ĐĂNG NHẬP
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  token_hash    TEXT    NOT NULL,
  refresh_hash  TEXT    DEFAULT NULL,
  ip_address    TEXT    DEFAULT '',
  user_agent    TEXT    DEFAULT '',
  expires_at    TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);

-- ═══════════════════════════════════════════════════════════
-- DỰ ÁN (Sổ công văn đi — phục vụ quyết toán)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS projects (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ma_du_an      TEXT    NOT NULL UNIQUE,
  ten_du_an     TEXT    NOT NULL,
  chu_dau_tu    TEXT    DEFAULT '',
  tong_muc_dau_tu REAL  DEFAULT 0,
  ngay_bat_dau  TEXT    DEFAULT NULL,
  ngay_ket_thuc TEXT    DEFAULT NULL,
  trang_thai    TEXT    NOT NULL DEFAULT 'Đang thực hiện' CHECK(trang_thai IN ('Đang thực hiện','Tạm dừng','Hoàn thành','Đã quyết toán')),
  mo_ta         TEXT    DEFAULT '',
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_phases (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ten_giai_doan TEXT    NOT NULL,
  thu_tu        INTEGER NOT NULL DEFAULT 0,
  mo_ta         TEXT    DEFAULT '',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_phases_project ON project_phases(project_id);

-- Seed danh sách giai đoạn mặc định cho từng dự án mới (template, có thể tuỳ chỉnh)
-- Các giai đoạn này sẽ được copy khi tạo dự án mới

-- ═══════════════════════════════════════════════════════════
-- TÀI LIỆU (Sheet: Data)
-- A: Mã TL | B: Tên tài liệu | C: Loại tài liệu | D: Trích yếu
-- E: Người tạo (Mã NV) | F: Ngày tạo | G: Trạng thái | H: URL file chính
-- Thêm: file đính kèm (tối đa 5), Dropbox paths
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS documents (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ma_doc          TEXT    NOT NULL UNIQUE,
  ten_tai_lieu    TEXT    NOT NULL,
  loai_tai_lieu   TEXT    NOT NULL DEFAULT 'van-ban-hc',
  trich_yeu       TEXT    DEFAULT '',
  -- Sổ công văn đi
  project_id      INTEGER REFERENCES projects(id),
  phase_id        INTEGER REFERENCES project_phases(id),
  loai_van_ban    TEXT    DEFAULT '',
  so_van_ban      TEXT    DEFAULT '',
  so_van_ban_mode TEXT    DEFAULT 'auto' CHECK(so_van_ban_mode IN ('auto','manual')),
  nguoi_duyet_id  INTEGER REFERENCES users(id),
  -- Tổ chức
  nguoi_tao_id    INTEGER NOT NULL REFERENCES users(id),
  trang_thai      TEXT    NOT NULL DEFAULT 'Chờ ký' CHECK(trang_thai IN ('Nháp','Chờ ký','Đã ký','Từ chối')),
  -- File PDF chính (trình ký)
  file_name       TEXT    DEFAULT '',
  file_size       INTEGER DEFAULT 0,
  file_hash_sha256 TEXT   DEFAULT '',
  file_url        TEXT    DEFAULT '',
  dropbox_path    TEXT    DEFAULT '',
  -- File đã ký (sau khi lãnh đạo duyệt)
  signed_file_url TEXT    DEFAULT '',
  signed_dropbox_path TEXT DEFAULT '',
  -- Lý do từ chối
  ly_do_tu_choi   TEXT    DEFAULT '',
  nguoi_ky_id     INTEGER REFERENCES users(id),
  ngay_ky         TEXT    DEFAULT NULL,
  ghi_chu         TEXT    DEFAULT '',
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_docs_trang_thai ON documents(trang_thai);
CREATE INDEX IF NOT EXISTS idx_docs_nguoi_tao ON documents(nguoi_tao_id);

-- ═══════════════════════════════════════════════════════════
-- FILE ĐÍNH KÈM (tối đa 5 file DOCX/PDF per document)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id   INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  file_name     TEXT    NOT NULL,
  file_size     INTEGER DEFAULT 0,
  file_type     TEXT    DEFAULT '',
  file_url      TEXT    DEFAULT '',
  dropbox_path  TEXT    DEFAULT '',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attach_doc ON attachments(document_id);

-- ═══════════════════════════════════════════════════════════
-- CHỮ KÝ SỐ (TT22)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS signatures (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id           INTEGER NOT NULL REFERENCES documents(id),
  signer_id             INTEGER NOT NULL REFERENCES users(id),
  certificate_subject   TEXT    DEFAULT '',
  certificate_serial    TEXT    DEFAULT '',
  certificate_issuer    TEXT    DEFAULT '',
  certificate_valid_from TEXT   DEFAULT '',
  certificate_valid_to  TEXT    DEFAULT '',
  signature_algorithm   TEXT    DEFAULT 'SHA256withRSA',
  document_hash_at_sign TEXT    NOT NULL,
  signature_value       TEXT    DEFAULT '',
  sign_method           TEXT    NOT NULL DEFAULT 'usb_token' CHECK(sign_method IN ('usb_token','remote','vgca')),
  signed_at             TEXT    NOT NULL DEFAULT (datetime('now')),
  ip_address            TEXT    DEFAULT '',
  user_agent            TEXT    DEFAULT '',
  otp_verified          INTEGER NOT NULL DEFAULT 0,
  signed_file_path      TEXT    DEFAULT '',
  signed_file_hash      TEXT    DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sig_doc ON signatures(document_id);

-- ═══════════════════════════════════════════════════════════
-- NHẬT KÝ GIAO DỊCH (Immutable — chống chối bỏ)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id),
  user_email  TEXT    DEFAULT '',
  action      TEXT    NOT NULL,
  target_type TEXT    DEFAULT '',
  target_id   TEXT    DEFAULT '',
  detail      TEXT    DEFAULT '{}',
  ip_address  TEXT    DEFAULT '',
  user_agent  TEXT    DEFAULT '',
  timestamp   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs(timestamp);

-- ═══════════════════════════════════════════════════════════
-- PHÂN QUYỀN (Sheet: Phan_Quyen)
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS permissions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  feature_name  TEXT    NOT NULL,
  role          TEXT    NOT NULL,
  allowed       INTEGER NOT NULL DEFAULT 0,
  UNIQUE(feature_name, role)
);

INSERT OR IGNORE INTO permissions (feature_name, role, allowed) VALUES
  ('Bảng điều khiển',       'Admin', 1), ('Bảng điều khiển',       'Quản lý', 1), ('Bảng điều khiển',       'Người dùng', 1),
  ('Quản lý người dùng',    'Admin', 1), ('Quản lý người dùng',    'Quản lý', 0), ('Quản lý người dùng',    'Người dùng', 0),
  ('Khởi tạo tài liệu',    'Admin', 1), ('Khởi tạo tài liệu',    'Quản lý', 1), ('Khởi tạo tài liệu',    'Người dùng', 1),
  ('Tài liệu chờ ký',      'Admin', 1), ('Tài liệu chờ ký',      'Quản lý', 1), ('Tài liệu chờ ký',      'Người dùng', 0),
  ('Tra cứu tài liệu',     'Admin', 1), ('Tra cứu tài liệu',     'Quản lý', 1), ('Tra cứu tài liệu',     'Người dùng', 1),
  ('Nhật ký giao dịch',     'Admin', 1), ('Nhật ký giao dịch',     'Quản lý', 1), ('Nhật ký giao dịch',     'Người dùng', 0),
  ('Quản lý phân quyền',    'Admin', 1), ('Quản lý phân quyền',    'Quản lý', 0), ('Quản lý phân quyền',    'Người dùng', 0),
  ('Xác minh tài liệu',    'Admin', 1), ('Xác minh tài liệu',    'Quản lý', 1), ('Xác minh tài liệu',    'Người dùng', 1),
  ('Quản lý dự án',         'Admin', 1), ('Quản lý dự án',         'Quản lý', 1), ('Quản lý dự án',         'Người dùng', 0),
  ('Sổ công văn đi',        'Admin', 1), ('Sổ công văn đi',        'Quản lý', 1), ('Sổ công văn đi',        'Người dùng', 1);
