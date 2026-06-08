const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const config = require('../config');

function generateSecret() {
  return authenticator.generateSecret();
}

function verifyToken(secret, token) {
  return authenticator.verify({ token, secret });
}

async function generateQRDataUrl(email, secret) {
  const otpauth = authenticator.keyuri(email, config.otp.issuer, secret);
  return QRCode.toDataURL(otpauth);
}

module.exports = { generateSecret, verifyToken, generateQRDataUrl };
