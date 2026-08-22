/* Dò tham số ký của thẻ. PSO sai không trừ lượt PIN nên quét an toàn. */
'use strict';
const forge = require('node-forge');
const { CardSession } = require('./lib/card');
const { readCertificates } = require('./lib/pkcs15');
const { askPin } = require('./lib/pin');

const SHA256_PREFIX = Buffer.from('3031300d060960864801650304020105000420', 'hex');
const h2 = n => n.toString(16).padStart(2, '0').toUpperCase();
const h4 = n => n.toString(16).padStart(4, '0').toUpperCase();

(async () => {
  const s = new CardSession();
  await s.open();
  const certs = await readCertificates(s);
  const ee = certs.find(c => !c.authority);
  const cert = forge.pki.certificateFromAsn1(forge.asn1.fromDer(ee.der.toString('binary')));

  const retries = await s.pinRetries();
  const pin = await askPin({
    title: 'Dò tham số ký — VGCA',
    message: 'Nhập PIN một lần để dò tham số ký của thẻ.\nKhông có tài liệu nào bị thay đổi.\n\nMã PIN:',
    retries,
  });
  await s.verifyPin(pin);
  console.log('PIN đúng ✓ — bắt đầu quét\n');

  const md = forge.md.sha256.create();
  md.update('probe');
  const hash = Buffer.from(md.digest().toHex(), 'hex');
  const digestInfo = Buffer.concat([SHA256_PREFIX, hash]);

  const keyRefs = [0x01, 0x81, 0x02, 0x82, 0x83, 0x88];
  const mseOk = [];

  // Bước 1: tổ hợp (keyRef, algRef) nào được MSE chấp nhận
  for (const kr of keyRefs) {
    for (let alg = 0; alg <= 0xff; alg++) {
      await s.selectApp();
      const r = await s.apdu(`002241B6068001${h2(alg)}8401${h2(kr)}`);
      if (r.sw === 0x9000) mseOk.push({ kr, alg });
    }
  }
  console.log(`MSE chấp nhận ${mseOk.length} tổ hợp.`);
  const byKr = {};
  for (const m of mseOk) (byKr[m.kr] ||= []).push(m.alg);
  for (const kr of Object.keys(byKr)) {
    const list = byKr[kr];
    console.log(`  keyRef ${h2(+kr)}: algRef ${list.slice(0, 24).map(h2).join(' ')}${list.length > 24 ? ' …(' + list.length + ')' : ''}`);
  }

  // Bước 2: tổ hợp nào thực sự ký được
  console.log('\nThử PSO trên các tổ hợp hợp lệ…');
  const wins = [];
  const swSeen = {};
  for (const { kr, alg } of mseOk) {
    for (const mode of ['digestinfo', 'hash']) {
      const payload = mode === 'hash' ? hash : digestInfo;
      await s.selectApp();
      const m = await s.apdu(`002241B6068001${h2(alg)}8401${h2(kr)}`);
      if (m.sw !== 0x9000) continue;
      const r = await s.apdu(`002A9E9A${h2(payload.length)}${payload.toString('hex').toUpperCase()}00`);
      swSeen[h4(r.sw)] = (swSeen[h4(r.sw)] || 0) + 1;
      if (r.sw === 0x9000 && r.data.length >= 128) {
        const ok = cert.publicKey.verify(md.digest().bytes(), r.data.toString('binary'));
        console.log(`  ✓ keyRef=${h2(kr)} algRef=${h2(alg)} mode=${mode} → ${r.data.length} byte, đối chiếu: ${ok ? 'HỢP LỆ' : 'sai'}`);
        if (ok) wins.push({ keyRef: kr, algRef: alg, mode });
      }
    }
  }

  console.log('\nPhân bố mã trả về của PSO:', JSON.stringify(swSeen));
  console.log(wins.length ? `\nTổ hợp ký được: ${JSON.stringify(wins)}` : '\nKhông tổ hợp nào ký được.');
  s.close();
})().catch(e => { console.error('LỖI:', e.message); process.exit(1); });
