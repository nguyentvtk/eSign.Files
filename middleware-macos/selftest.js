/* Tự kiểm tra: đọc chứng thư → nhập PIN → ký thử → đối chiếu chữ ký. */
'use strict';

const fs = require('fs');
const path = require('path');
const forge = require('node-forge');
const { CardSession } = require('./lib/card');
const { readCertificates } = require('./lib/pkcs15');
const { askPin } = require('./lib/pin');

const PARAMS_FILE = path.join(__dirname, 'card-params.json');

const SHA256_PREFIX = Buffer.from('3031300d060960864801650304020105000420', 'hex');

(async () => {
  const s = new CardSession();
  await s.open();
  console.log('Đầu đọc :', s.readerName);
  console.log('ATR     :', await s.atr());

  const certs = await readCertificates(s);
  const ee = certs.find(c => !c.authority);
  if (!ee) throw new Error('Không tìm thấy chứng thư người ký trên token.');

  const cert = forge.pki.certificateFromAsn1(forge.asn1.fromDer(ee.der.toString('binary')));
  const cn = (cert.subject.getField('CN') || {}).value || '';
  console.log('Người ký:', Buffer.from(cn, 'binary').toString('utf8'));
  console.log('Hiệu lực:', cert.validity.notBefore.toISOString().slice(0, 10),
              '→', cert.validity.notAfter.toISOString().slice(0, 10));

  const retries = await s.pinRetries();
  console.log('PIN còn :', retries === null ? '(không rõ)' : retries + ' lần thử');

  const pin = await askPin({
    title: 'Tự kiểm tra ký số VGCA',
    message: 'Đây là bài kiểm tra khả năng ký của token trên máy này.\n'
           + 'Không có tài liệu nào bị thay đổi.\n\nNhập mã PIN của USB Token:',
    retries,
  });

  await s.verifyPin(pin);
  console.log('PIN     : đúng ✓');

  const data = Buffer.from('kiem-tra-ky-so-vgca-' + new Date().toISOString());
  const md = forge.md.sha256.create();
  md.update(data.toString('binary'));
  const hash = Buffer.from(md.digest().toHex(), 'hex');
  const digestInfo = Buffer.concat([SHA256_PREFIX, hash]);

  const { signature, params } = await s.signHash(digestInfo, hash);
  console.log('Chữ ký  :', signature.length, 'byte, tham số', JSON.stringify(params));

  const ok = cert.publicKey.verify(md.digest().bytes(), signature.toString('binary'));
  console.log('Đối chiếu với public key của chứng thư:', ok ? 'HỢP LỆ ✓' : 'SAI ✗');

  if (ok) {
    fs.writeFileSync(PARAMS_FILE, JSON.stringify(params, null, 2));
    console.log('Đã lưu tham số ký vào', path.basename(PARAMS_FILE));
  } else {
    process.exitCode = 1;
  }

  s.close();
})().catch(e => {
  console.error('LỖI:', e.message);
  process.exit(1);
});
