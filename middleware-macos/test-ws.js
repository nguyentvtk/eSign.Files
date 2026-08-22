/* Client WebSocket tối giản để kiểm tra giao thức của middleware. */
'use strict';
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');

const HOST = '127.0.0.1', PORT = 9090;
const ORIGIN = 'https://e-sign-files.vercel.app';

function connect() {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, HOST, () => {
      const key = crypto.randomBytes(16).toString('base64');
      sock.write(
        `GET / HTTP/1.1\r\nHost: ${HOST}:${PORT}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\nOrigin: ${ORIGIN}\r\n\r\n`
      );
      let buf = Buffer.alloc(0);
      const onHandshake = d => {
        buf = Buffer.concat([buf, d]);
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        const head = buf.subarray(0, i).toString();
        if (!/101/.test(head)) { sock.destroy(); return reject(new Error('Bắt tay thất bại: ' + head.split('\r\n')[0])); }
        sock.removeListener('data', onHandshake);
        resolve({ sock, rest: buf.subarray(i + 4) });
      };
      sock.on('data', onHandshake);
    });
    sock.on('error', reject);
  });
}

function frame(text) {
  const p = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);
  let head;
  if (p.length < 126) head = Buffer.from([0x81, 0x80 | p.length]);
  else if (p.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0xfe; head.writeUInt16BE(p.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0xff; head.writeUInt32BE(0, 2); head.writeUInt32BE(p.length, 6); }
  const masked = Buffer.from(p);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, masked]);
}

function makeReader(onMessage) {
  let buf = Buffer.alloc(0), frags = [];
  return d => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0, op = buf[0] & 0x0f;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = buf.readUInt32BE(6); off = 10; }
      if (buf.length < off + len) return;
      const payload = buf.subarray(off, off + len);
      buf = buf.subarray(off + len);
      if (op === 0x8) return;
      frags.push(Buffer.from(payload));
      if (fin) { onMessage(Buffer.concat(frags).toString('utf8')); frags = []; }
    }
  };
}

(async () => {
  const { sock, rest } = await connect();
  console.log('Bắt tay WebSocket: OK');

  const pending = [];
  const reader = makeReader(text => {
    const m = JSON.parse(text);
    if (m.type === 'SIGN_PROGRESS') { console.log(`  … ${m.percent}% ${m.message}`); return; }
    const w = pending.shift(); if (w) w(m);
  });
  sock.on('data', reader);
  if (rest.length) reader(rest);

  const send = (obj) => new Promise(res => { pending.push(res); sock.write(frame(JSON.stringify(obj))); });

  const det = await send({ type: 'DETECT_TOKEN' });
  console.log('DETECT_TOKEN →', det.type);
  if (det.type === 'ERROR') { console.log('  ', det.message); sock.destroy(); return; }
  console.log('  người ký:', (det.cert.subject.match(/CN=([^,]+)/) || [])[1]);

  const pdfPath = process.argv[2];
  if (!pdfPath) { console.log('\n(bỏ qua bước ký — truyền đường dẫn PDF để thử ký)'); sock.destroy(); return; }

  console.log('\nSIGN_PDF:', pdfPath);
  const r = await send({
    type: 'SIGN_PDF',
    pdfBase64: fs.readFileSync(pdfPath).toString('base64'),
    maDoc: 'TEST-001',
    tenTaiLieu: 'Tài liệu kiểm tra middleware',
    signerName: 'Nguyễn Ngọc Nguyên',
    coordinates: [],
  });
  console.log('SIGN_PDF →', r.type);
  if (r.type === 'ERROR') { console.log('  ', r.message); }
  else {
    const out = '/tmp/vgca-ws-signed.pdf';
    fs.writeFileSync(out, Buffer.from(r.signedBase64, 'base64'));
    console.log('  PDF đã ký:', out, fs.statSync(out).size, 'byte');
  }
  sock.destroy();
})().catch(e => { console.error('LỖI:', e.message); process.exit(1); });
