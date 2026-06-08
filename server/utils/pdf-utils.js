const fs = require('fs');
const { sha256Buffer } = require('./crypto');

function hashPdfFile(filePath) {
  const buf = fs.readFileSync(filePath);
  return sha256Buffer(buf);
}

function getFileSize(filePath) {
  return fs.statSync(filePath).size;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(2) + ' MB';
}

module.exports = { hashPdfFile, getFileSize, formatFileSize };
