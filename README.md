# eSign.Files

Hệ thống ký tài liệu điện tử — Tuân thủ Thông tư 22/2020/TT-BTTTT & Luật Giao dịch điện tử 2023.

## Tính năng

- 🔐 **Xác thực mạnh**: Đăng nhập đa định danh (Mã NV / Email / SĐT / Họ tên) + bcrypt + JWT + OTP 2 lớp (TOTP)
- 📄 **Ký số PDF**: USB Token, VGCA, Remote Signing (Cloud CA). Stamp signature tại vị trí kéo-thả
- 🗂️ **Sổ công văn đi**: Tổ chức tài liệu theo dự án/giai đoạn, số văn bản tự động hoặc thủ công
- 📊 **Xuất danh mục HS quyết toán**: CSV với BOM UTF-8 (Excel mở được tiếng Việt)
- 🔔 **Thông báo**: Telegram bot + Email tự động khi gửi/duyệt/từ chối tài liệu
- 🛡️ **Audit log immutable**: Nhật ký giao dịch chống chối bỏ theo Luật GDĐT 2023
- ☁️ **Lưu trữ Dropbox**: File chính + tối đa 5 đính kèm (PDF/DOCX) lưu vào Dropbox lãnh đạo
- ✅ **Xác minh toàn vẹn**: Kiểm tra SHA-256 hash + thông tin chứng thư số

## Stack

- **Backend**: Node.js + Express
- **DB**: SQLite (local dev) hoặc Turso/libSQL (production)
- **Auth**: JWT + bcrypt + TOTP (otplib)
- **PDF**: pdf-lib + PDF.js viewer
- **DOCX→PDF**: LibreOffice headless
- **Storage**: Dropbox API (fallback local)
- **Notification**: Telegram Bot API + nodemailer SMTP

## Chạy local

```bash
npm install
cp .env.example .env  # Cấu hình env
npm start
# Truy cập http://localhost:3000
# Admin mặc định: admin@esign.local / admin123
```

## Deploy Vercel

1. **Tạo Turso database** (free 9GB): https://turso.tech
   ```bash
   turso db create esign
   turso db show esign --url     # → TURSO_DATABASE_URL
   turso db tokens create esign  # → TURSO_AUTH_TOKEN
   ```

2. **Cài Vercel CLI & deploy**:
   ```bash
   npm i -g vercel
   vercel
   ```

3. **Cấu hình env trên Vercel Dashboard**:
   - `JWT_SECRET`, `JWT_REFRESH_SECRET` (random 64-char)
   - `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`
   - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_TOPIC_ID`
   - `DROPBOX_ACCESS_TOKEN`, `DROPBOX_FOLDER`

## Pháp lý tuân thủ

| Yêu cầu | Tính năng |
|---|---|
| TT22 Điều 8 — Thông tin chữ ký | Subject, Issuer, Serial, Valid Period hiển thị đầy đủ |
| TT22 — Toàn vẹn tài liệu | SHA-256 hash lưu tại thời điểm ký, có API verify |
| TT22 — Định dạng PDF chuẩn | pdf-lib xuất PDF tuân chuẩn ISO 32000 |
| ATTT — Xác thực mạnh | Password + OTP 2 lớp |
| Luật GDĐT 2023 Điều 22 — Chống chối bỏ | Audit log immutable, ghi IP/UA/timestamp mọi thao tác |
| ATTT — Bảo vệ khóa | USB Token / HSM / Cloud CA |

## License

MIT
