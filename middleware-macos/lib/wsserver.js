/* ═══════════════════════════════════════════════════════════
   WEBSOCKET — Cài đặt tối thiểu theo RFC 6455
   ─────────────────────────────────────────────────────────
   Middleware chỉ cần khung văn bản JSON, nên tự cài đặt thay
   vì thêm phụ thuộc: gói `ws` không có sẵn trong dự án và ta
   muốn chạy được ngay mà không phải cài thêm gì.

   Có xử lý khung phân mảnh vì PDF mã hoá base64 dễ vượt 64 KB.
═══════════════════════════════════════════════════════════ */
'use strict';

const crypto = require('crypto');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

class WebSocketConnection {
  constructor(socket) {
    this.socket = socket;
    this._buf = Buffer.alloc(0);
    this._fragOp = null;
    this._frags = [];
    this._handlers = { message: [], close: [] };

    socket.on('data', chunk => this._onData(chunk));
    socket.on('close', () => this._emit('close'));
    socket.on('error', () => this._emit('close'));
  }

  on(evt, fn) { (this._handlers[evt] ||= []).push(fn); return this; }
  _emit(evt, ...args) { for (const fn of this._handlers[evt] || []) fn(...args); }

  send(text) {
    const payload = Buffer.from(text, 'utf8');
    this.socket.write(Buffer.concat([this._header(OP.TEXT, payload.length), payload]));
  }

  close(code = 1000) {
    const body = Buffer.alloc(2);
    body.writeUInt16BE(code, 0);
    try {
      this.socket.write(Buffer.concat([this._header(OP.CLOSE, body.length), body]));
      this.socket.end();
    } catch { /* đã đóng */ }
  }

  _header(opcode, len) {
    if (len < 126) return Buffer.from([0x80 | opcode, len]);
    if (len < 65536) {
      const h = Buffer.alloc(4);
      h[0] = 0x80 | opcode; h[1] = 126; h.writeUInt16BE(len, 2);
      return h;
    }
    const h = Buffer.alloc(10);
    h[0] = 0x80 | opcode; h[1] = 127;
    h.writeUInt32BE(0, 2);
    h.writeUInt32BE(len, 6);
    return h;
  }

  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);

    for (;;) {
      const frame = this._readFrame();
      if (!frame) break;

      const { fin, opcode, payload } = frame;

      if (opcode === OP.CLOSE) { this.close(); return; }
      if (opcode === OP.PING) {
        this.socket.write(Buffer.concat([this._header(OP.PONG, payload.length), payload]));
        continue;
      }
      if (opcode === OP.PONG) continue;

      if (opcode === OP.CONT) {
        this._frags.push(payload);
      } else {
        this._fragOp = opcode;
        this._frags = [payload];
      }

      if (fin) {
        const full = Buffer.concat(this._frags);
        this._frags = [];
        if (this._fragOp === OP.TEXT) this._emit('message', full.toString('utf8'));
        this._fragOp = null;
      }
    }
  }

  _readFrame() {
    const b = this._buf;
    if (b.length < 2) return null;

    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;

    if (len === 126) {
      if (b.length < off + 2) return null;
      len = b.readUInt16BE(off); off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return null;
      const hi = b.readUInt32BE(off);
      const lo = b.readUInt32BE(off + 4);
      if (hi !== 0) throw new Error('Khung WebSocket quá lớn');
      len = lo; off += 8;
    }

    let mask = null;
    if (masked) {
      if (b.length < off + 4) return null;
      mask = b.subarray(off, off + 4); off += 4;
    }

    if (b.length < off + len) return null;

    const payload = Buffer.from(b.subarray(off, off + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];

    this._buf = b.subarray(off + len);
    return { fin, opcode, payload };
  }
}

/**
 * Gắn xử lý nâng cấp WebSocket vào một http.Server sẵn có.
 * @param {http.Server} server
 * @param {(conn, req) => void} onConnection
 * @param {(origin: string) => boolean} isOriginAllowed
 */
function attach(server, onConnection, isOriginAllowed) {
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const origin = req.headers.origin || '';

    if (!key) { socket.destroy(); return; }
    if (!isOriginAllowed(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.setNoDelay(true);
    onConnection(new WebSocketConnection(socket), req);
  });
}

module.exports = { attach, WebSocketConnection };
