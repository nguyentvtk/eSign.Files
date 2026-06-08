const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { sha256Buffer } = require('../utils/crypto');
const config = require('../config');

/**
 * Stamp chữ ký lên PDF tại vị trí chỉ định.
 *
 * @param {string} pdfPath - Đường dẫn PDF gốc
 * @param {Object} info - Thông tin chữ ký
 * @param {Object} pos  - Vị trí stamp: { page (1-based), x, y, width, height }
 *                        Toạ độ tính theo PDF coordinate (origin = bottom-left)
 * @param {Buffer} [signatureImage] - Ảnh PNG/JPG chữ ký (optional)
 */
async function stampSignatureOnPdf(pdfPath, info, pos = null, signatureImage = null) {
  const pdfBytes = fs.readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pages = pdfDoc.getPages();

  // Embed Helvetica + Unicode font fallback (Helvetica không hỗ trợ tiếng Việt — dùng để demo)
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // Xác định trang đích
  const pageIdx = pos?.page ? Math.min(Math.max(0, pos.page - 1), pages.length - 1) : pages.length - 1;
  const targetPage = pages[pageIdx];
  const { width: pageW, height: pageH } = targetPage.getSize();

  // Toạ độ stamp
  const stampW = pos?.width  || 220;
  const stampH = pos?.height || 90;
  const stampX = pos?.x !== undefined ? pos.x : pageW - stampW - 30;
  const stampY = pos?.y !== undefined ? pos.y : 30;

  // Vẽ khung viền + nền
  targetPage.drawRectangle({
    x: stampX, y: stampY,
    width: stampW, height: stampH,
    borderColor: rgb(0.86, 0.15, 0.15),
    borderWidth: 1.2,
    color: rgb(1, 1, 1),
    opacity: 0.95,
  });

  // Nếu có ảnh chữ ký (từ USB Token đã setup sẵn) → embed
  if (signatureImage) {
    try {
      let img;
      // Detect PNG vs JPG
      if (signatureImage[0] === 0x89 && signatureImage[1] === 0x50) {
        img = await pdfDoc.embedPng(signatureImage);
      } else {
        img = await pdfDoc.embedJpg(signatureImage);
      }
      const imgScale = Math.min((stampW - 10) / img.width, (stampH - 30) / img.height);
      targetPage.drawImage(img, {
        x: stampX + 5,
        y: stampY + stampH - 5 - img.height * imgScale,
        width: img.width * imgScale,
        height: img.height * imgScale,
      });
    } catch (e) {
      console.error('[Stamp] embed image failed:', e.message);
    }
  }

  // Vẽ thông tin chữ ký (text)
  const textLines = [
    `Ky boi: ${_ascii(info.signerName || 'N/A')}`,
    `Thoi gian: ${info.signedAt || new Date().toISOString()}`,
    `Phuong thuc: ${info.method || 'USB Token'}`,
  ];
  if (info.issuer) textLines.push(`CA: ${_ascii(info.issuer).substring(0, 35)}`);
  if (info.serial) textLines.push(`Serial: ${String(info.serial).substring(0, 18)}`);

  const fontSize = 7.5;
  const lineHeight = 9;
  textLines.forEach((line, i) => {
    targetPage.drawText(line, {
      x: stampX + 5,
      y: stampY + 5 + (textLines.length - 1 - i) * lineHeight,
      size: fontSize,
      font,
      color: rgb(0.12, 0.12, 0.12),
    });
  });

  // Lưu PDF mới
  const stampedBytes = await pdfDoc.save();
  const signedDir = path.join(config.upload.dir, 'signed');
  if (!fs.existsSync(signedDir)) fs.mkdirSync(signedDir, { recursive: true });
  const signedFileName = `signed_${Date.now()}_${path.basename(pdfPath)}`;
  const signedPath = path.join(signedDir, signedFileName);
  fs.writeFileSync(signedPath, stampedBytes);

  return {
    path: signedPath,
    fileName: signedFileName,
    hash: sha256Buffer(Buffer.from(stampedBytes)),
    size: stampedBytes.length,
  };
}

function verifyDocumentIntegrity(filePath, expectedHash) {
  const buf = fs.readFileSync(filePath);
  const currentHash = sha256Buffer(buf);
  return { currentHash, expectedHash, isIntact: currentHash === expectedHash };
}

// Loại bỏ dấu tiếng Việt để Helvetica render được (PDF-lib không hỗ trợ Unicode trong font built-in)
function _ascii(str) {
  return String(str || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

module.exports = { stampSignatureOnPdf, verifyDocumentIntegrity };
