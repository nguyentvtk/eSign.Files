# Trust Store — Chứng thư CA tin cậy

Các chứng thư CA công khai dùng để xác minh **chuỗi tin cậy** của tài liệu ký số.
Nạp tự động (đệ quy) bởi [`server/services/ca-trust-store.js`](../services/ca-trust-store.js).
Cert self-signed = trust anchor (Root CA tin cậy).

## Cây thư mục

```
server/trust/
├── vgca/        — Chữ ký số chuyên dùng Chính phủ (Ban Cơ yếu)
│   ├── rootcag2.crt   RootCA chuyên dùng Chính phủ G2 (root, hết hạn 2048)
│   └── cpcag2.crt     CA phục vụ các cơ quan Nhà nước G2 (intermediate)
└── national/    — Hạ tầng CA công cộng quốc gia (NEAC / rootca.gov.vn)
    └── vnrca256.crt   Vietnam National Root CA (root)
```

## Phạm vi tin cậy

| Trust anchor | Bao phủ |
|---|---|
| RootCA chuyên dùng Chính phủ G2 | Chữ ký VGCA (Ban Cơ yếu) — cơ quan Nhà nước |
| Vietnam National Root CA | **Mọi CA công cộng được cấp phép**: VNPT-CA, Viettel-CA, FPT-CA, BKAV-CA, MISA… (tất cả đều là CA con của gốc quốc gia này) |

## Nguồn (public)
- VGCA: http://ca.gov.vn/pki/pub/crt/rootcag2.crt , /cpcag2.crt
- Quốc gia: https://rootca.gov.vn/crt/vnrca256.p7b (PKCS#7 bundle — đã trích lấy cert root)

SHA-256 fingerprint (pin):
- rootcag2: `f04ba4b459a7c9a1b971ad9b1cb833e695a80c79aea63b174b66a70edfe2fdb8`
- vnrca256: `bac8bf609ab420a8ee1780d74f4de5c7f7184959d2a7375b0a75e4c29f0908e7`

## Thêm CA mới
Bỏ file `.crt`/`.cer`/`.pem`/`.der` vào bất kỳ thư mục con nào dưới `server/trust/`.

## Ghi chú
- Endpoint `POST /api/signing/upload-signed` chấp nhận mọi PDF có chữ ký hợp lệ +
  chuỗi neo vào một trong các Root CA trên — **không phụ thuộc nhà cung cấp**.
- Hỗ trợ digest SHA-1/256/384/512 và chữ ký RSA PKCS#1 v1.5 lẫn RSASSA-PSS.
- Nới lỏng bắt buộc chuỗi tin cậy: env `ALLOW_UNTRUSTED_CA=1` (dev).
- **Chưa** kiểm tra thu hồi (CRL/OCSP).
