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
 * @param {Buffer} [signatureImage] - Ảnh PNG/JPG chữ ký tay của lãnh đạo (optional)
 * @param {Buffer} [sealImage] - Ảnh PNG/JPG con dấu đỏ (optional)
 */
async function stampSignatureOnPdf(pdfPath, info, pos = null, signatureImage = null, sealImage = null) {
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

  const hasSignature = !!signatureImage;
  const hasSeal = !!sealImage;
  const hasImages = hasSignature || hasSeal;

  const embedImg = async (buf) => {
    if (!buf) return null;
    try {
      return (buf[0] === 0x89 && buf[1] === 0x50) ? await pdfDoc.embedPng(buf) : await pdfDoc.embedJpg(buf);
    } catch (e) { console.error('[Stamp] embed image failed:', e.message); return null; }
  };

  // Khung viền: ẩn khi đã có ảnh chữ ký/con dấu (để chữ ký số nhìn tự nhiên như ký tay);
  // chỉ vẽ khung khi không có ảnh (fallback text-only).
  if (!hasImages) {
    targetPage.drawRectangle({
      x: stampX, y: stampY, width: stampW, height: stampH,
      borderColor: rgb(0.86, 0.15, 0.15), borderWidth: 1.2,
      color: rgb(1, 1, 1), opacity: 0.95,
    });
  }

  // 1) Con dấu đỏ — vẽ làm lớp nền (hơi mờ) để chữ ký tay đè lên, giống dấu giáp văn bản
  const sealPng = await embedImg(sealImage);
  if (sealPng) {
    const sealMax = Math.min(stampW, stampH) * 0.95;
    const sScale = Math.min(sealMax / sealPng.width, sealMax / sealPng.height);
    const sw = sealPng.width * sScale, sh = sealPng.height * sScale;
    targetPage.drawImage(sealPng, {
      x: stampX + (stampW - sw) / 2,
      y: stampY + (stampH - sh) / 2,
      width: sw, height: sh,
      opacity: 0.9,
    });
  }

  // 2) Ảnh chữ ký tay của lãnh đạo — vẽ phía trên, chiếm ~60% chiều cao
  const sigPng = await embedImg(signatureImage);
  if (sigPng) {
    const areaW = stampW - 10, areaH = stampH * (hasSeal ? 0.55 : 0.62);
    const iScale = Math.min(areaW / sigPng.width, areaH / sigPng.height);
    const iw = sigPng.width * iScale, ih = sigPng.height * iScale;
    targetPage.drawImage(sigPng, {
      x: stampX + (stampW - iw) / 2,
      y: stampY + stampH - ih - 4,
      width: iw, height: ih,
    });
  }

  // 3) Text thông tin ký số — gọn ở đáy. Khi có ảnh: chỉ tên + thời gian (nền chữ ký đã rõ);
  //    khi không ảnh: đủ thông tin CA/Serial (fallback).
  const textLines = [`Ky boi: ${_ascii(info.signerName || 'N/A')}`,
                     `Thoi gian: ${info.signedAt || new Date().toISOString()}`];
  if (!hasImages) {
    textLines.push(`Phuong thuc: ${info.method || 'USB Token'}`);
    if (info.issuer) textLines.push(`CA: ${_ascii(info.issuer).substring(0, 35)}`);
    if (info.serial) textLines.push(`Serial: ${String(info.serial).substring(0, 18)}`);
  }

  const fontSize = hasImages ? 6.5 : 7.5;
  const lineHeight = hasImages ? 7.5 : 9;
  textLines.forEach((line, i) => {
    targetPage.drawText(line, {
      x: stampX + 4,
      y: stampY + 3 + (textLines.length - 1 - i) * lineHeight,
      size: fontSize,
      font,
      color: rgb(0.12, 0.12, 0.45),
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
