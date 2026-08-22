# Middleware ký số VGCA cho macOS

Chạy trên máy người ký, cho phép trang **https://e-sign-files.vercel.app** ký số
bằng USB Token VGCA trên macOS Apple Silicon.

## Vì sao cần cái này

Phần mềm chính chủ không dùng được trên máy này, vì hai lý do độc lập nhau:

1. **Driver macOS của VGCA là Intel-only.** `VGCA VCTKManager.app` (bản 1.0,
   2023) có extension CryptoTokenKit `VCTKToken.appex` biên dịch cho x86_64.
   Tiến trình hệ thống nạp nó (`ctkd`) chạy native arm64 nên không nạp được,
   và Rosetta không giúp vì đó là daemon của hệ thống. Hệ quả:
   `security list-smartcards` luôn báo *No smartcards found*.

2. **VGCA không có middleware web cho macOS.** Phần mềm mở cổng `9090` mà
   `public/js/usb-token.js` cần là **VGCA Sign Service**, chỉ phát hành bản
   Windows (.msi). VCTKManager trên macOS chỉ là trình quản lý token, không
   mở cổng nào.

Middleware này thay thế cả hai: nói chuyện thẳng với thẻ bằng APDU ISO 7816
qua PC/SC (driver CCID có sẵn của macOS), và phục vụ đúng giao thức mà
frontend đã định nghĩa — **không phải sửa một dòng nào ở phía trình duyệt**.

## Thông số thẻ đã khảo sát

| Mục | Giá trị |
|---|---|
| Thiết bị | Bit4id TokenME EVO v2 (VID `0x25DD`, PID `0x2371`) |
| ATR | `3BDF18FF8191FE1FC30031B8640C01ECC173940180829000B3` |
| Applet | IAS-ECC "ChipDoc" |
| AID | `E828BD080FD25047656E65726963` |
| PKCS#15 | ODF `5031`, PrKDF `7002`, CDF `7005`, AODF `7001` |
| Chứng thư | EF `0003` (người ký), `0002` + `0001` (chuỗi CA) |
| Khoá | RSA 2048, keyRef `0x81` |
| PIN | pinRef `0x01`, dài 4–16, đệm `0xFF` cho đủ 8 byte |
| Tham số ký | MSE `algRef=0x8A`, PSO nhận DigestInfo đầy đủ |

OpenSC không dùng được: nó nhận ra thẻ là IAS-ECC nhưng driver chọn AID 7 byte
của Gemalto, còn thẻ này dùng AID 14 byte, nên `pkcs15-tool` báo *Unsupported
card*. Tham số `algRef` được tìm bằng cách quét (xem `sweep.js`) rồi đối chiếu
chữ ký thu được với public key trong chứng thư.

## Cách dùng — ký rời (khuyến nghị)

```bash
node sign-cli.js
```

Lần chạy đầu, cầu nối PC/SC (`native/pcsc-pipe`) được biên dịch tự động từ
`native/pcsc-pipe.c` — không cần bước thủ công nào. Máy chỉ cần sẵn Xcode
Command Line Tools (`xcode-select --install`).

Công cụ sẽ: đăng nhập → liệt kê tài liệu đang *Chờ ký* → cho bạn chọn → tải PDF
gốc → hỏi PIN → ký bằng token → nộp lại qua `/api/signing/upload-signed`.
Server tự xác minh chữ ký và chuỗi tin cậy rồi lưu file **nguyên trạng**.

Không cần trình duyệt làm trung gian, không cần chứng chỉ TLS cục bộ, và
**không phải sửa hay triển khai lại ứng dụng**.

Chạy thử toàn tuyến mà không đổi trạng thái tài liệu:

```bash
node sign-cli.js --dry-run
```

Trỏ sang máy chủ khác: `ESIGN_URL=http://localhost:3000 node sign-cli.js`

Phiên đăng nhập lưu ở `~/.esign-files/session.json` (quyền `600`). Xoá file đó
để đăng nhập lại.

## Cách dùng — middleware cho trình duyệt

```bash
./start.sh
```

Phục vụ giao thức JSON chung ở `ws://127.0.0.1:9090`, đúng như `PROVIDERS.vgca`
trong bản `public/js/usb-token.js` **của thư mục này**.

⚠️ Bản đang chạy trên Vercel đã đổi sang API chính thức của VGCA SignService
(`wss://127.0.0.1:8987`), nên nó **không gọi tới middleware này**. Muốn dùng
đường trình duyệt thì phải thêm một provider trỏ về `ws://127.0.0.1:9090` rồi
triển khai lại. Đã kiểm chứng: từ chính origin `https://e-sign-files.vercel.app`
trong Chrome 151, cả WebSocket lẫn HTTP đều kết nối được tới cổng 9090.

Muốn chạy tự động mỗi lần đăng nhập: xem hướng dẫn trong
`com.esignfiles.vgca-middleware.plist`.

## Giao thức

WebSocket `ws://127.0.0.1:9090` (ưu tiên) và HTTP `http://127.0.0.1:9090`
(dự phòng), đúng như `PROVIDERS.vgca` trong `public/js/usb-token.js`.

```
→ {type:'DETECT_TOKEN'}          ← {type:'TOKEN_DETECTED', cert}
→ {type:'SIGN_PDF', pdfBase64…}  ← {type:'SIGN_PROGRESS'…} {type:'SIGN_COMPLETE', signedBase64}

GET  /api/token/status
GET  /api/token/detect
POST /api/pdf/sign
```

## An toàn

- Chỉ lắng nghe trên `127.0.0.1`, không mở ra mạng.
- Chỉ nhận yêu cầu từ origin trong danh sách cho phép (`VGCA_ORIGINS`), nên
  một trang web bất kỳ không sai khiến được token của bạn.
- Hộp thoại PIN nêu rõ **đang ký tài liệu nào** trước khi bạn mở khoá token.
- PIN không được ghi log ở bất kỳ đâu và không rời khỏi máy.
- Chỉ thử PIN đúng một lần mỗi yêu cầu; sai là dừng và báo số lượt còn lại,
  không bao giờ dò lặp.

Chrome cho phép trang HTTPS gọi vào `127.0.0.1` nhờ header
`Access-Control-Allow-Private-Network`. **Safari chặn** — hãy dùng Chrome/Edge.

## Công cụ kèm theo

| File | Việc |
|---|---|
| `selftest.js` | Đọc chứng thư, ký thử một chuỗi, đối chiếu với public key |
| `test-pades.js` | Ký một PDF mẫu và xuất phần tử cho OpenSSL kiểm chứng |
| `test-ws.js` | Client WebSocket thử toàn bộ giao thức |
| `sweep.js` | Dò lại tham số ký nếu đổi sang token khác |
| `sign-cli.js` | Công cụ ký rời — đường dùng chính |

Kiểm chứng chữ ký bằng OpenSSL:

```bash
openssl cms -verify -inform DER -in chuky.der -content noidung.bin -binary -CAfile ca.pem
```

## Biến môi trường

| Biến | Mặc định |
|---|---|
| `VGCA_PORT` | `9090` |
| `VGCA_ORIGINS` | `https://e-sign-files.vercel.app,http://localhost:3000,http://127.0.0.1:3000` |
