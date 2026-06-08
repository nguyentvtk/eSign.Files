const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

// Lazy load libreoffice-convert (optional dep). Nếu không có sẽ disable feature.
let convertAsync = null;
try {
  const libre = require('libreoffice-convert');
  convertAsync = promisify(libre.convert);
} catch (e) {
  console.warn('[docx-convert] libreoffice-convert not installed. Server-side DOCX→PDF disabled.');
}

/**
 * Chuyển DOCX → PDF dùng LibreOffice headless.
 * Yêu cầu LibreOffice cài trên máy chủ.
 * Cài: brew install --cask libreoffice (macOS) hoặc apt install libreoffice (Linux)
 */
async function docxToPdf(docxPath, outputPath) {
  if (!convertAsync) {
    throw new Error('LibreOffice không được cài trên server. Vui lòng tải file DOCX về máy, mở bằng Word/LibreOffice, chỉnh sửa rồi Save As PDF, sau đó dùng nút "Tải PDF thay thế".');
  }
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
