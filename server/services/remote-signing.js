const config = require('../config');

async function requestRemoteSign({ documentHash, userId, otpToken }) {
  if (!config.remoteCa.url) {
    throw new Error('Remote CA chưa được cấu hình. Vui lòng thiết lập REMOTE_CA_URL trong .env');
  }

  const resp = await fetch(config.remoteCa.url + '/sign', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.remoteCa.apiKey}`,
    },
    body: JSON.stringify({
      hash: documentHash,
      hashAlgorithm: 'SHA-256',
      userId,
      otpToken,
      provider: config.remoteCa.provider,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Remote CA lỗi (${resp.status}): ${err}`);
  }

  const result = await resp.json();
  return {
    signatureValue: result.signature,
    certificate: result.certificate,
    signedAt: result.timestamp || new Date().toISOString(),
    algorithm: result.algorithm || 'SHA256withRSA',
  };
}

function isConfigured() {
  return !!(config.remoteCa.url && config.remoteCa.apiKey);
}

module.exports = { requestRemoteSign, isConfigured };
