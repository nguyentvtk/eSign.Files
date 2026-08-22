/* Ký thử một PDF và xuất phần tử để OpenSSL kiểm chứng độc lập. */
'use strict';
const fs = require('fs');
const path = require('path');
const forge = require('node-forge');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { CardSession } = require('./lib/card');
const { readCertificates } = require('./lib/pkcs15');
const { askPin } = require('./lib/pin');
const { signPdf, locateSignatureSlots } = require('./lib/pades');

const OUT = process.argv[2] || '/tmp/vgca-test';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // PDF mẫu
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Tai lieu kiem tra chu ky so VGCA', { x: 60, y: 760, size: 16, font });
  page.drawText('Ngay tao: ' + new Date().toISOString(), { x: 60, y: 730, size: 10, font });
  const original = Buffer.from(await doc.save());
  fs.writeFileSync(path.join(OUT, 'goc.pdf'), original);

  const s = new CardSession();
  await s.open();
  const certs = await readCertificates(s);
  const ee = certs.find(c => !c.authority);
  const chain = certs.filter(c => c.authority).map(c => c.der);

  const x509 = forge.pki.certificateFromAsn1(forge.asn1.fromDer(ee.der.toString('binary')));
  const cn = Buffer.from((x509.subject.getField('CN') || {}).value || '', 'binary').toString('utf8');

  const retries = await s.pinRetries();
  const pin = await askPin({
    title: 'Ký thử PDF — VGCA',
    message: `Ký thử một tài liệu mẫu bằng chứng thư của ${cn}.\nKhông đụng tới tài liệu thật nào.\n\nMã PIN:`,
    retries,
  });
  await s.verifyPin(pin);

  const params = JSON.parse(fs.readFileSync(path.join(__dirname, 'card-params.json'), 'utf8'));

  const signed = await signPdf(original, {
    signerCertDer: ee.der,
    chainDer: chain,
    signerName: cn,
    reason: 'Kiểm tra khả năng ký số trên macOS',
    location: 'Tây Ninh',
    sign: async (digestInfo, hash) => {
      const { signature } = await s.signHash(digestInfo, hash, params);
      return signature;
    },
  });
  s.close();

  const signedPath = path.join(OUT, 'da-ky.pdf');
  fs.writeFileSync(signedPath, signed);
  console.log('PDF đã ký :', signedPath, `(${signed.length} byte)`);

  // Bóc tách để OpenSSL kiểm chứng
  const slots = locateSignatureSlots(signed);
  const brText = signed.subarray(slots.brOpen, slots.brOpen + slots.brLength).toString('latin1');
  const br = brText.replace(/[\[\]]/g, '').trim().split(/\s+/).map(Number);
  console.log('ByteRange :', JSON.stringify(br));

  const content = Buffer.concat([
    signed.subarray(br[0], br[0] + br[1]),
    signed.subarray(br[2], br[2] + br[3]),
  ]);
  fs.writeFileSync(path.join(OUT, 'noidung.bin'), content);

  const hex = signed
    .subarray(slots.contentsStart + 1, slots.contentsStart + slots.contentsLength - 1)
    .toString('latin1')
    .replace(/0+$/, '');
  fs.writeFileSync(path.join(OUT, 'chuky.der'), Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex'));

  const pem = d => forge.pki.certificateToPem(
    forge.pki.certificateFromAsn1(forge.asn1.fromDer(d.toString('binary')))
  );
  fs.writeFileSync(path.join(OUT, 'ca.pem'), chain.map(pem).join(''));
  console.log('Đã xuất   :', OUT + '/{noidung.bin, chuky.der, ca.pem}');
})().catch(e => { console.error('LỖI:', e.message); process.exit(1); });
