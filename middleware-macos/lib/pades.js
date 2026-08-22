/* ═══════════════════════════════════════════════════════════
   PAdES — Nhúng chữ ký số vào PDF
   ─────────────────────────────────────────────────────────
   Quy trình chuẩn ISO 32000:
     1. Chèn "chỗ trống" cho chữ ký: một dict /Sig với
        /ByteRange và /Contents toàn số 0.
     2. Tính vị trí thật của hai vùng dữ liệu được ký (mọi
        byte của file TRỪ phần /Contents), ghi lại /ByteRange.
     3. Băm hai vùng đó, dựng CMS, ký trên token.
     4. Ghi CMS dạng hex vào đúng chỗ trống đã chừa.

   Độ dài chuỗi /ByteRange sau khi ghi phải khớp từng byte với
   chuỗi giữ chỗ, nếu không mọi offset phía sau sẽ lệch.
═══════════════════════════════════════════════════════════ */
'use strict';

const { PDFDocument, PDFName, PDFString, PDFHexString } = require('pdf-lib');
const { buildSignedData, sha256 } = require('./cms');

const BYTE_RANGE_PLACEHOLDER = '**********';
const SIGNATURE_BYTES = 16384;   // chỗ chừa cho CMS, dư dả cho chuỗi 3 chứng thư

/* ── Bước 1: chèn chỗ trống ─────────────────────────────── */

async function addPlaceholder(pdfBuffer, { reason, location, contactInfo, signerName, signingTime }) {
  const doc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true, updateMetadata: false });
  const page = doc.getPages()[0];
  if (!page) throw new Error('PDF không có trang nào.');

  const sigDict = doc.context.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'adbe.pkcs7.detached',
    // ByteRange phải đứng TRƯỚC Contents: giá trị của nó được
    // tính từ vị trí của Contents trong file đã xuất.
    ByteRange: [
      0,
      PDFName.of(BYTE_RANGE_PLACEHOLDER),
      PDFName.of(BYTE_RANGE_PLACEHOLDER),
      PDFName.of(BYTE_RANGE_PLACEHOLDER),
    ],
    Contents: PDFHexString.of('0'.repeat(SIGNATURE_BYTES * 2)),
    Reason: PDFString.of(reason || 'Ký số tài liệu'),
    Name: PDFString.of(signerName || ''),
    Location: PDFString.of(location || ''),
    ContactInfo: PDFString.of(contactInfo || ''),
    M: PDFString.fromDate(signingTime || new Date()),
  });
  const sigRef = doc.context.register(sigDict);

  const widgetRef = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Sig',
      Rect: [0, 0, 0, 0],       // trường ẩn: phần hiển thị do app tự đóng dấu
      V: sigRef,
      T: PDFString.of('ChuKySo_' + Date.now()),
      F: 132,                    // Print + Locked
      P: page.ref,
    })
  );

  // Giữ nguyên annotation sẵn có của trang
  const annots = page.node.lookupMaybe(PDFName.of('Annots'), require('pdf-lib').PDFArray);
  if (annots) annots.push(widgetRef);
  else page.node.set(PDFName.of('Annots'), doc.context.obj([widgetRef]));

  doc.catalog.set(
    PDFName.of('AcroForm'),
    doc.context.obj({ SigFlags: 3, Fields: [widgetRef] })
  );

  // useObjectStreams: false — dict chữ ký phải nằm thẳng trong
  // file để tìm và vá được bằng thao tác byte.
  const bytes = await doc.save({ useObjectStreams: false });
  return Buffer.from(bytes);
}

/* ── Bước 2: xác định vị trí và ghi ByteRange ───────────── */

function locateSignatureSlots(pdf) {
  const brTag = pdf.indexOf('/ByteRange');
  if (brTag < 0) throw new Error('Không tìm thấy /ByteRange trong PDF.');

  const brOpen = pdf.indexOf('[', brTag);
  const brClose = pdf.indexOf(']', brOpen);
  if (brOpen < 0 || brClose < 0) throw new Error('/ByteRange hỏng.');

  const cTag = pdf.indexOf('/Contents', brClose);
  const cOpen = pdf.indexOf('<', cTag);
  const cClose = pdf.indexOf('>', cOpen);
  if (cTag < 0 || cOpen < 0 || cClose < 0) throw new Error('/Contents hỏng.');

  return {
    brOpen,
    brLength: brClose - brOpen + 1,
    contentsStart: cOpen,
    contentsLength: cClose - cOpen + 1,
  };
}

function writeByteRange(pdf, slots) {
  const after = slots.contentsStart + slots.contentsLength;
  const byteRange = [0, slots.contentsStart, after, pdf.length - after];

  let text = `[${byteRange.join(' ')}]`;
  if (text.length > slots.brLength) {
    throw new Error('Chuỗi ByteRange dài hơn chỗ giữ — không vá được.');
  }
  text = text.padEnd(slots.brLength, ' ');

  Buffer.from(text, 'latin1').copy(pdf, slots.brOpen);
  return byteRange;
}

function digestSignedRanges(pdf, byteRange) {
  return sha256(
    Buffer.concat([
      pdf.subarray(byteRange[0], byteRange[0] + byteRange[1]),
      pdf.subarray(byteRange[2], byteRange[2] + byteRange[3]),
    ])
  );
}

/* ── Bước 4: ghi CMS vào chỗ trống ──────────────────────── */

function embedSignature(pdf, slots, cmsDer) {
  const room = slots.contentsLength - 2;   // trừ hai dấu < >
  const hex = cmsDer.toString('hex').toUpperCase();
  if (hex.length > room) {
    throw new Error(
      `Chữ ký ${cmsDer.length} byte vượt chỗ chừa ${SIGNATURE_BYTES} byte.`
    );
  }
  const padded = hex.padEnd(room, '0');
  Buffer.from('<' + padded + '>', 'latin1').copy(pdf, slots.contentsStart);
  return pdf;
}

/* ── Hàm tổng ───────────────────────────────────────────── */

/**
 * Ký số một file PDF bằng khoá nằm trong token.
 *
 * @param {Buffer} pdfBuffer      PDF gốc
 * @param {Object} o
 *   - signerCertDer  Buffer     chứng thư người ký
 *   - chainDer       Buffer[]   chứng thư CA
 *   - sign           async fn   ký trên thẻ
 *   - reason/location/contactInfo/signerName
 * @returns {Promise<Buffer>} PDF đã ký
 */
async function signPdf(pdfBuffer, o) {
  const signingTime = o.signingTime || new Date();

  const withSlot = await addPlaceholder(pdfBuffer, { ...o, signingTime });
  const slots = locateSignatureSlots(withSlot);
  const byteRange = writeByteRange(withSlot, slots);
  const contentDigest = digestSignedRanges(withSlot, byteRange);

  const cms = await buildSignedData({
    contentDigest,
    signerCertDer: o.signerCertDer,
    chainDer: o.chainDer || [],
    signingTime,
    sign: o.sign,
  });

  return embedSignature(withSlot, slots, cms);
}

module.exports = {
  signPdf,
  addPlaceholder,
  locateSignatureSlots,
  writeByteRange,
  digestSignedRanges,
  embedSignature,
  SIGNATURE_BYTES,
};
