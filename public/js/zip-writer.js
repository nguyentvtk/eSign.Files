/* ═══════════════════════════════════════════════════════════
   ZIP WRITER — Đóng gói tệp ngay trong trình duyệt
   ─────────────────────────────────────────────────────────
   Viết theo APPNOTE của PKWARE, chỉ dùng phương thức "store"
   (không nén). Tệp trong hệ thống hầu hết là PDF — vốn đã nén
   sẵn — nên nén thêm gần như không giảm dung lượng mà lại tốn
   thời gian và bộ nhớ.

   Tự cài đặt thay vì nạp thư viện ngoài: mã ngắn, không thêm
   phụ thuộc vào kho, và không phải tin một tệp JS bên thứ ba
   trong hệ thống xử lý văn bản có chữ ký số.

   Giới hạn: chưa hỗ trợ ZIP64, nên tổng gói phải dưới 4 GB.
═══════════════════════════════════════════════════════════ */
window.ZipWriter = (() => {
  'use strict';

  /* ── CRC-32 ───────────────────────────────────────────── */
  const BANG_CRC = (() => {
    const b = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      b[i] = c >>> 0;
    }
    return b;
  })();

  function crc32(u8) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = BANG_CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* ── Ngày giờ kiểu MS-DOS ─────────────────────────────── */
  function gioDos(d) {
    return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2)) & 0xFFFF;
  }
  function ngayDos(d) {
    return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
  }

  /* ── Ghi số ít byte ───────────────────────────────────── */
  function bo(...phan) {
    const tong = phan.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(tong);
    let o = 0;
    for (const p of phan) { out.set(p, o); o += p.length; }
    return out;
  }
  const u16 = n => new Uint8Array([n & 0xFF, (n >>> 8) & 0xFF]);
  const u32 = n => new Uint8Array([n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]);

  /**
   * Tạo file ZIP.
   * @param {Array<{path: string, data: Uint8Array}>} muc
   * @returns {Blob}
   */
  function taoZip(muc) {
    const bo_ma = new TextEncoder();
    const phan = [];
    const mucLuc = [];
    let viTri = 0;
    const luc = new Date();
    const gio = gioDos(luc), ngay = ngayDos(luc);

    for (const m of muc) {
      const ten = bo_ma.encode(m.path);          // UTF-8
      const crc = crc32(m.data);
      const cd = m.data.length;

      // Local file header
      const lfh = bo(
        u32(0x04034b50),
        u16(20),        // cần phiên bản 2.0
        u16(0x0800),    // cờ: tên tệp mã hoá UTF-8
        u16(0),         // phương thức: store
        u16(gio), u16(ngay),
        u32(crc), u32(cd), u32(cd),
        u16(ten.length), u16(0)
      );
      phan.push(lfh, ten, m.data);

      mucLuc.push({ ten, crc, cd, offset: viTri });
      viTri += lfh.length + ten.length + cd;
    }

    // Central directory
    const batDauCD = viTri;
    for (const e of mucLuc) {
      const cdh = bo(
        u32(0x02014b50),
        u16(20), u16(20),
        u16(0x0800), u16(0),
        u16(gio), u16(ngay),
        u32(e.crc), u32(e.cd), u32(e.cd),
        u16(e.ten.length), u16(0), u16(0),
        u16(0), u16(0), u32(0),
        u32(e.offset)
      );
      phan.push(cdh, e.ten);
      viTri += cdh.length + e.ten.length;
    }

    // End of central directory
    phan.push(bo(
      u32(0x06054b50),
      u16(0), u16(0),
      u16(mucLuc.length), u16(mucLuc.length),
      u32(viTri - batDauCD), u32(batDauCD),
      u16(0)
    ));

    return new Blob(phan, { type: 'application/zip' });
  }

  return { taoZip, crc32 };
})();
