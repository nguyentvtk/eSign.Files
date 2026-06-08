const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const SALT_ROUNDS = process.env.NODE_ENV === 'production' ? 10 : 4;

async function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

module.exports = { hashPassword, verifyPassword, sha256, sha256Buffer, randomToken };
