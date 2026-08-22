/* ═══════════════════════════════════════════════════════════
   CARD — Truy cập USB Token VGCA (Bit4id TokenME EVO v2)
   ─────────────────────────────────────────────────────────
   Thẻ chạy applet IAS-ECC "ChipDoc" với cấu trúc PKCS#15
   chuẩn. Driver VCTKManager của VGCA cho macOS chỉ có bản
   Intel nên không nạp được trên Apple Silicon; module này
   nói chuyện thẳng với thẻ bằng APDU ISO 7816 qua PC/SC.

   Tham số đã khảo sát được từ chính thẻ:
     AID    E828BD080FD25047656E65726963   ("ChipDoc")
     ODF    5031    TokenInfo 5032
     PrKDF  7002    CDF 7005    AODF 7001
     keyRef 0x01    pinRef 0x01   RSA 2048
═══════════════════════════════════════════════════════════ */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const PIPE = path.join(__dirname, '..', 'native', 'pcsc-pipe');

const AID = 'E828BD080FD25047656E65726963';
const EF_ODF = 0x5031;
const EF_PRKDF = 0x7002;
const EF_CDF = 0x7005;
const EF_AODF = 0x7001;

/*
 * Tham số MSE cho lệnh ký.
 *
 * Bộ tham số của IAS-ECC không thống nhất giữa các nhà sản xuất và
 * thẻ này chấp nhận MỌI giá trị ở bước MSE mà không kiểm tra — sai
 * hay đúng chỉ lộ ra khi PSO chạy. Giá trị đầu bảng là tổ hợp đã dò
 * được trên token VGCA/Bit4id TokenME EVO v2 và đã đối chiếu khớp
 * public key của chứng thư; phần còn lại là dự phòng cho thẻ khác.
 */
const SIGN_COMBOS = [
  { keyRef: 0x81, algRef: 0x8a, mode: 'digestinfo' },
  { keyRef: 0x81, algRef: 0x02, mode: 'digestinfo' },
  { keyRef: 0x01, algRef: 0x02, mode: 'digestinfo' },
  { keyRef: 0x81, algRef: 0x42, mode: 'hash' },
  { keyRef: 0x01, algRef: 0x12, mode: 'digestinfo' },
];

/* ── Phiên làm việc với thẻ ────────────────────────────── */

class CardSession {
  constructor() {
    this._proc = null;
    this._queue = [];
    this._buf = '';
    this.readerName = '';
  }

  /**
   * Mở phiên với thẻ.
   *
   * Có thử lại vài lượt: tiến trình VCTKToken.appex của VGCA vẫn
   * chạy nền và thỉnh thoảng giữ đầu đọc trong chốc lát, khiến
   * SCardConnect trượt dù thẻ vẫn cắm bình thường.
   */
  async open(attempts = 5, delayMs = 400) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this._openOnce();
      } catch (e) {
        lastErr = e;
        this.close();
        if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs));
      }
    }
    throw lastErr;
  }

  _openOnce() {
    return new Promise((resolve, reject) => {
      const proc = spawn(PIPE, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      this._proc = proc;

      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('error', err => reject(new Error(`Không chạy được pcsc-pipe: ${err.message}`)));

      let ready = false;
      proc.stdout.on('data', chunk => {
        this._buf += chunk.toString('latin1');
        let idx;
        while ((idx = this._buf.indexOf('\n')) >= 0) {
          const line = this._buf.slice(0, idx).trim();
          this._buf = this._buf.slice(idx + 1);

          if (!ready) {
            ready = true;
            if (line.startsWith('READY ')) {
              this.readerName = line.slice(6);
              resolve(this);
            } else {
              reject(new Error(line.replace(/^ERR /, '')));
            }
            continue;
          }
          const waiter = this._queue.shift();
          if (waiter) waiter(line);
        }
      });

      proc.on('exit', code => {
        // Đánh thức mọi lệnh còn treo để không kẹt vô hạn
        while (this._queue.length) this._queue.shift()('ERR pcsc-pipe đã thoát (mã ' + code + ')' + (stderr ? ': ' + stderr.trim() : ''));
        this._proc = null;
      });
    });
  }

  close() {
    if (this._proc) {
      try { this._proc.stdin.write('QUIT\n'); } catch { /* đã đóng */ }
      try { this._proc.stdin.end(); } catch { /* đã đóng */ }
      this._proc = null;
    }
  }

  _cmd(text) {
    return new Promise((resolve, reject) => {
      if (!this._proc) return reject(new Error('Phiên thẻ đã đóng'));
      this._queue.push(line => {
        if (line.startsWith('OK')) resolve(line.slice(2).trim());
        else reject(new Error(line.replace(/^ERR /, '')));
      });
      this._proc.stdin.write(text + '\n');
    });
  }

  async atr() {
    return this._cmd('ATR');
  }

  /** Gửi APDU, trả { data: Buffer, sw: number } */
  async apdu(hex) {
    const out = await this._cmd('APDU ' + hex);
    const parts = out.split(/\s+/).filter(Boolean);
    const sw = parseInt(parts[parts.length - 1], 16);
    const dataHex = parts.length > 1 ? parts[0] : '';
    return { data: Buffer.from(dataHex, 'hex'), sw };
  }

  /** APDU bắt buộc trả 0x9000, ngược lại ném lỗi */
  async apduOk(hex, what) {
    const r = await this.apdu(hex);
    if (r.sw !== 0x9000) throw new Error(`${what} thất bại (SW=${hex4(r.sw)})`);
    return r.data;
  }

  /* ── Chọn ứng dụng & đọc file ───────────────────────── */

  async selectApp() {
    const lc = (AID.length / 2).toString(16).padStart(2, '0');
    await this.apduOk(`00A4040C${lc}${AID}`, 'Chọn ứng dụng trên token');
  }

  async selectEF(fid) {
    const hex = fid.toString(16).padStart(4, '0').toUpperCase();
    await this.apduOk(`00A4020C02${hex}`, `Chọn file ${hex}`);
  }

  /**
   * Đọc trọn một EF. Thẻ trả tối đa ~231 byte mỗi lần nên phải
   * lặp theo offset cho tới khi hết dữ liệu.
   *
   * Trả về nguyên vẹn cả phần đệm 0x00 phía sau: CDF là nhiều
   * cấu trúc DER nối tiếp nhau nên không thể cắt theo cấu trúc
   * đầu tiên. Nơi dùng tự cắt bằng derTotalLength khi cần.
   */
  async readEF(fid) {
    await this.selectApp();
    await this.selectEF(fid);

    const chunks = [];
    let off = 0;

    while (off < 0x8000) {
      const hi = (off >> 8) & 0xff, lo = off & 0xff;
      const r = await this.apdu(`00B0${hex2(hi)}${hex2(lo)}00`);
      if (r.sw !== 0x9000 || r.data.length === 0) break;
      chunks.push(r.data);
      off += r.data.length;
    }

    return Buffer.concat(chunks);
  }

  /* ── PIN ────────────────────────────────────────────── */

  /** Số lần nhập PIN còn lại. Truy vấn rỗng — KHÔNG tốn lượt. */
  async pinRetries() {
    await this.selectApp();
    const r = await this.apdu('0020000100');
    if ((r.sw & 0xfff0) === 0x63c0) return r.sw & 0x0f;
    if (r.sw === 0x9000) return null;      // PIN đang mở sẵn
    if (r.sw === 0x6983) return 0;         // đã khoá
    return null;
  }

  /**
   * Xác thực PIN. Đệm 0xFF cho đủ storedLength = 8 (mặc định
   * của IAS-ECC khi PKCS#15 không khai báo padChar).
   *
   * Chỉ thử ĐÚNG MỘT LẦN. Token khoá sau 3 lần sai nên tuyệt
   * đối không dò tìm cách đệm bằng cách thử lặp.
   */
  async verifyPin(pin) {
    await this.selectApp();

    const before = await this.pinRetries();
    if (before === 0) {
      const e = new Error('Token đã bị khoá. Cần dùng mã PUK để mở.');
      e.code = 'PIN_LOCKED';
      throw e;
    }

    const body = Buffer.alloc(8, 0xff);
    Buffer.from(pin, 'utf8').copy(body, 0);
    const r = await this.apdu(`00200001${hex2(body.length)}${body.toString('hex').toUpperCase()}`);

    if (r.sw === 0x9000) return true;

    if ((r.sw & 0xfff0) === 0x63c0) {
      const left = r.sw & 0x0f;
      const e = new Error(`Mã PIN không đúng. Còn ${left} lần thử.`);
      e.code = 'PIN_WRONG';
      e.retriesLeft = left;
      throw e;
    }
    if (r.sw === 0x6983) {
      const e = new Error('Token đã bị khoá. Cần dùng mã PUK để mở.');
      e.code = 'PIN_LOCKED';
      throw e;
    }
    throw new Error(`Xác thực PIN thất bại (SW=${hex4(r.sw)})`);
  }

  /* ── Ký ─────────────────────────────────────────────── */

  /**
   * Ký RSA PKCS#1 v1.5 trên thẻ.
   *
   * @param {Buffer} digestInfo  DER DigestInfo của SHA-256 (51 byte)
   * @param {Buffer} hash        SHA-256 thô (32 byte)
   * @param {Object} known       Tham số đã dò được lần trước (nếu có)
   * @returns {{signature: Buffer, params: {algRef: number, mode: string}}}
   *
   * Bộ tham số MSE của IAS-ECC không thống nhất giữa các nhà sản
   * xuất, nên lần đầu ta thử lần lượt vài tổ hợp. Việc thử này an
   * toàn: chỉ VERIFY PIN mới trừ lượt, PSO sai chỉ trả mã lỗi.
   * Chữ ký thu được luôn được đối chiếu với public key của chứng
   * thư ở lớp trên trước khi dùng.
   */
  async signHash(digestInfo, hash, known = null) {
    await this.selectApp();

    const combos = known ? [known, ...SIGN_COMBOS] : SIGN_COMBOS;
    const errs = [];
    const tried = new Set();

    for (const c of combos) {
      const key = `${c.keyRef}/${c.algRef}/${c.mode}`;
      if (tried.has(key)) continue;
      tried.add(key);

      const payload = c.mode === 'hash' ? hash : digestInfo;
      try {
        // MSE: SET — Digital Signature Template.
        // Thẻ chấp nhận mọi giá trị ở bước này mà không kiểm tra,
        // sai hay đúng chỉ lộ ra khi PSO chạy.
        await this.apduOk(
          `002241B6068001${hex2(c.algRef)}8401${hex2(c.keyRef)}`,
          'Thiết lập môi trường ký'
        );
        // PSO: COMPUTE DIGITAL SIGNATURE
        const r = await this.apdu(
          `002A9E9A${hex2(payload.length)}${payload.toString('hex').toUpperCase()}00`
        );
        if (r.sw === 0x9000 && r.data.length >= 128) {
          return { signature: r.data, params: { ...c } };
        }
        errs.push(`${key}: SW=${hex4(r.sw)}`);
      } catch (e) {
        errs.push(`${key}: ${e.message}`);
      }
    }

    throw new Error('Thẻ từ chối mọi tổ hợp tham số ký — ' + errs.join('; '));
  }
}

/* ── Tiện ích ───────────────────────────────────────────── */

function hex2(n) { return n.toString(16).padStart(2, '0').toUpperCase(); }
function hex4(n) { return n.toString(16).padStart(4, '0').toUpperCase(); }

/** Tổng độ dài (header + nội dung) của cấu trúc DER đứng đầu buffer */
function derTotalLength(buf) {
  if (buf.length < 2) return 0;
  const first = buf[1];
  if (first < 0x80) return 2 + first;
  const nBytes = first & 0x7f;
  if (nBytes === 0 || buf.length < 2 + nBytes) return 0;
  let len = 0;
  for (let i = 0; i < nBytes; i++) len = (len << 8) | buf[2 + i];
  return 2 + nBytes + len;
}

module.exports = { CardSession, AID, EF_ODF, EF_PRKDF, EF_CDF, EF_AODF, derTotalLength };
