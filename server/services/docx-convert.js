const libre = require('libreoffice-convert');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const convertAsync = promisify(libre.convert);

/**
 * Chuyển DOCX → PDF dùng LibreOffice headless.
 * Yêu cầu LibreOffice cài trên máy chủ.
 * Cài: brew install --cask libreoffice (macOS) hoặc apt install libreoffice (Linux)
 */
async function docxToPdf(docxPath, outputPath) {
  const docxBuf = fs.readFileSync(docxPath);
  const pdfBuf = await convertAsync(docxBuf, '.pdf', undefined);
  fs.writeFileSync(outputPath, pdfBuf);
  return { path: outputPath, size: pdfBuf.length };
}

async function isAvailable() {
  // Test conversion với buffer nhỏ
  try {
    const testDocx = Buffer.from([0x50, 0x4B, 0x03, 0x04]); // ZIP header
    await convertAsync(testDocx, '.pdf', undefined);
    return true;
  } catch (e) {
    // Kiểm tra thông báo lỗi để xác định LibreOffice có không
    return !/Could not find soffice binary/i.test(e.message);
  }
}

module.exports = { docxToPdf, isAvailable };
