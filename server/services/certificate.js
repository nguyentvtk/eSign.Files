const forge = require('node-forge');

function parseCertificatePem(pem) {
  const cert = forge.pki.certificateFromPem(pem);
  return {
    subject: cert.subject.attributes.map(a => `${a.shortName}=${a.value}`).join(', '),
    issuer: cert.issuer.attributes.map(a => `${a.shortName}=${a.value}`).join(', '),
    serial: cert.serialNumber,
    validFrom: cert.validity.notBefore.toISOString(),
    validTo: cert.validity.notAfter.toISOString(),
    algorithm: cert.siginfo.algorithmOid,
    isExpired: new Date() > cert.validity.notAfter,
    isNotYetValid: new Date() < cert.validity.notBefore,
  };
}

function parseCertificateBase64(b64) {
  const pem = `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----`;
  return parseCertificatePem(pem);
}

function getSignerName(certInfo) {
  const match = certInfo.subject.match(/CN=([^,]+)/);
  return match ? match[1].trim() : certInfo.subject;
}

module.exports = { parseCertificatePem, parseCertificateBase64, getSignerName };
