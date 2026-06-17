/* ═══════════════════════════════════════════════════════════
   PDF SIGNATURE VERIFIER — Xác minh chữ ký số nhúng trong PDF
   ─────────────────────────────────────────────────────────
   Dùng cho luồng "ký rời": người dùng ký PDF bằng phần mềm
   desktop (VGCA Ban Cơ yếu, FoxitReader, v.v.) rồi upload lại.
   Service này:
     1. Trích các trường chữ ký (/ByteRange + /Contents) trong PDF
     2. Parse khối PKCS#7 / CMS SignedData để lấy chứng thư người ký
     3. Kiểm tra TOÀN VẸN: hash vùng ByteRange == messageDigest
        đã ký trong PKCS#7
     4. Verify mật mã chữ ký RSA trên SignedAttributes bằng public
        key của chứng thư người ký

   node-forge parse được SignedData nhưng KHÔNG có hàm verify sẵn
   cho detached signature → ta tự verify ở đây.

   Trả về cấu trúc rõ ràng để caller quyết định chấp nhận hay không;
   các bước verify có graceful-degradation kèm `reason` thay vì
   ném lỗi mơ hồ.
═══════════════════════════════════════════════════════════ */
const fs = require('fs');
const forge = require('node-forge');
const caTrust = require('./ca-trust-store');

const OID_MESSAGE_DIGEST = '1.2.840.113549.1.9.4';
const OID_SIGNING_TIME = '1.2.840.113549.1.9.5';
const OID_RSA_PKCS1 = '1.2.840.113549.1.1.1';   // rsaEncryption (PKCS#1 v1.5)
const OID_RSA_PSS = '1.2.840.113549.1.1.10';     // RSASSA-PSS

// Map digestAlgorithm OID → forge.md factory
const DIGEST_BY_OID = {
  '1.3.14.3.2.26': () => forge.md.sha1.create(),
  '2.16.840.1.101.3.4.2.1': () => forge.md.sha256.create(),
  '2.16.840.1.101.3.4.2.2': () => forge.md.sha384.create(),
  '2.16.840.1.101.3.4.2.3': () => forge.md.sha512.create(),
};

const DIGEST_NAME_BY_OID = {
  '1.3.14.3.2.26': 'SHA-1',
  '2.16.840.1.101.3.4.2.1': 'SHA-256',
  '2.16.840.1.101.3.4.2.2': 'SHA-384',
  '2.16.840.1.101.3.4.2.3': 'SHA-512',
};

/**
 * Trích tất cả các trường chữ ký từ buffer PDF.
 * @returns {Array<{byteRange:number[], der:string}>}
 */
function extractSignatures(pdfBuffer) {
  const latin1 = pdfBuffer.toString('latin1');
  const sigs = [];
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  let m;
  while ((m = re.exec(latin1)) !== null) {
    const byteRange = [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10), parseInt(m[4], 10)];
    const [a, b, c] = byteRange;
    // Theo chuẩn PAdES: vùng (a+b .. c) bị loại khỏi dải ký, chính là giá trị
    // hex của /Contents (dấu '<' '>' nằm ngay ngoài hai dải). Lấy hex thuần.
    let hex = pdfBuffer.slice(a + b, c).toString('latin1');
    hex = hex.replace(/[^0-9a-fA-F]/g, '');      // bỏ '<' '>' / khoảng trắng nếu có
    hex = hex.replace(/(00)+$/i, '');            // bỏ padding zero cuối
    if (hex.length % 2 !== 0) hex = hex.slice(0, hex.length - 1);
    if (!hex) continue;
    sigs.push({ byteRange, der: hex });
  }
  return sigs;
}

// Giá trị DN trong cert thường là UTF8String nhưng node-forge trả bytes thô
// (binary string) → decode UTF-8 để hiển thị tiếng Việt đúng.
function _utf8(v) {
  try { return Buffer.from(String(v), 'binary').toString('utf8'); } catch { return v; }
}

function certToInfo(cert) {
  const fmt = (attrs) => attrs.map(a => `${a.shortName || a.name || a.type}=${_utf8(a.value)}`).join(', ');
  return {
    subject: fmt(cert.subject.attributes),
    issuer: fmt(cert.issuer.attributes),
    serial: cert.serialNumber,
    validFrom: cert.validity.notBefore.toISOString(),
    validTo: cert.validity.notAfter.toISOString(),
    algorithm: forge.pki.oids[cert.siginfo.algorithmOid] || cert.siginfo.algorithmOid,
    isExpired: new Date() > cert.validity.notAfter,
    isNotYetValid: new Date() < cert.validity.notBefore,
  };
}

/**
 * Chọn chứng thư người ký từ danh sách certs trong PKCS#7,
 * khớp theo serialNumber trong SignerInfo (rawCapture.serial là hex).
 */
function pickSignerCert(certs, rawSerialHex) {
  if (rawSerialHex) {
    const want = String(rawSerialHex).replace(/^0+/, '').toLowerCase();
    const hit = certs.find(c => String(c.serialNumber).replace(/^0+/, '').toLowerCase() === want);
    if (hit) return hit;
  }
  // Fallback: chứng thư "lá" — không phải CA (basicConstraints cA=false / không có)
  const leaf = certs.find(c => {
    const bc = c.getExtension && c.getExtension('basicConstraints');
    return !bc || !bc.cA;
  });
  return leaf || certs[0];
}

function _intFromBytes(bytes) {
  let n = 0;
  for (let i = 0; i < bytes.length; i++) n = (n * 256) + bytes.charCodeAt(i);
  return n;
}

/**
 * Phát hiện scheme chữ ký từ SignerInfo.signatureAlgorithm.
 * Trả về { isPss, hashFactory, parsedSalt }.
 * Hỗ trợ RSA PKCS#1 v1.5 (1.2.840.113549.1.1.1) và RSASSA-PSS (…1.1.10).
 */
function _detectScheme(rc, defaultMdFactory) {
  let oid = null;
  try { oid = forge.asn1.derToOid(rc.signatureAlgorithm[0].value); } catch {}
  if (oid !== OID_RSA_PSS) return { isPss: false, hashFactory: defaultMdFactory, parsedSalt: null, oid };

  // Parse RSASSA-PSS-params: hashAlgorithm [0], maskGen [1], saltLength [2]
  let hashFactory = () => forge.md.sha256.create();
  let parsedSalt = null;
  try {
    const params = rc.signatureAlgorithm[1];
    for (const child of (params.value || [])) {
      if (child.type === 0) { // [0] hashAlgorithm (EXPLICIT) → AlgorithmIdentifier
        const hashOid = forge.asn1.derToOid(child.value[0].value[0].value);
        if (DIGEST_BY_OID[hashOid]) hashFactory = DIGEST_BY_OID[hashOid];
      } else if (child.type === 2) { // [2] saltLength (EXPLICIT INTEGER)
        const intNode = child.value[0];
        parsedSalt = _intFromBytes(intNode.value);
      }
    }
  } catch {}
  return { isPss: true, hashFactory, parsedSalt, oid };
}

/** Verify PSS, thử các saltLength phổ biến nếu giá trị parse không khớp. */
function _verifyPss(cert, digestBytes, signature, hashFactory, parsedSalt) {
  const hlen = hashFactory().digestLength;
  const candidates = [];
  if (Number.isInteger(parsedSalt) && parsedSalt >= 0) candidates.push(parsedSalt);
  [hlen, 32, 48, 64, 20, 0].forEach(s => { if (!candidates.includes(s)) candidates.push(s); });
  for (const saltLength of candidates) {
    try {
      const pss = forge.pss.create({
        md: hashFactory(),
        mgf: forge.mgf.mgf1.create(hashFactory()),
        saltLength,
      });
      if (cert.publicKey.verify(digestBytes, signature, pss)) return true;
    } catch {}
  }
  return false;
}

/**
 * Verify một trường chữ ký.
 * @returns {Object} kết quả chi tiết
 */
function verifyOneSignature(pdfBuffer, sig) {
  const result = {
    hasSignature: true,
    certInfo: null,
    digestAlgorithm: null,
    contentIntegrity: false,   // hash vùng ByteRange == messageDigest đã ký
    cryptoVerified: false,     // verify RSA trên SignedAttributes
    chainValid: false,         // chuỗi chứng thư neo vào Root CA tin cậy
    chainAnchor: null,         // CN của Root CA tin cậy
    chain: null,               // [CN] chuỗi từ leaf → root
    signingTime: null,
    reason: null,
  };

  let p7;
  try {
    const der = forge.util.hexToBytes(sig.der);
    const asn1 = forge.asn1.fromDer(der);
    p7 = forge.pkcs7.messageFromAsn1(asn1);
  } catch (e) {
    result.reason = 'Không parse được khối PKCS#7/CMS: ' + e.message;
    return result;
  }

  const certs = p7.certificates || [];
  if (!certs.length) {
    result.reason = 'Khối chữ ký không chứa chứng thư số.';
    return result;
  }

  const rc = p7.rawCapture || {};
  // rawCapture.serial / digestAlgorithm là bytes thô → convert
  const serialHex = rc.serial ? forge.util.bytesToHex(rc.serial) : null;
  const signerCert = pickSignerCert(certs, serialHex);
  result.certInfo = certToInfo(signerCert);

  // ── Kiểm tra chuỗi chứng thư tới Root CA tin cậy (VGCA) ──
  try {
    const chainRes = caTrust.validateChain(signerCert, certs);
    result.chainValid = chainRes.valid;
    result.chainAnchor = chainRes.anchor;
    result.chain = chainRes.chain;
    result.chainConfigured = chainRes.configured;
    if (!chainRes.valid) result.chainReason = chainRes.reason;
  } catch (e) {
    result.chainReason = 'Lỗi kiểm tra chuỗi: ' + e.message;
  }

  let digestOid;
  try { digestOid = forge.asn1.derToOid(rc.digestAlgorithm); } catch { digestOid = rc.digestAlgorithm; }
  result.digestAlgorithm = DIGEST_NAME_BY_OID[digestOid] || digestOid || 'unknown';

  // ── Tính hash vùng ByteRange (nội dung được ký) ──
  const [a, b, c, d] = sig.byteRange;
  const signedBytes = Buffer.concat([pdfBuffer.slice(a, a + b), pdfBuffer.slice(c, c + d)]);

  const mdFactory = DIGEST_BY_OID[digestOid];
  if (!mdFactory) {
    result.reason = `Thuật toán băm không hỗ trợ (OID ${digestOid}).`;
    return result;
  }

  // ── Kiểm tra toàn vẹn: hash(ByteRange) == messageDigest trong SignedAttributes ──
  const attrs = rc.authenticatedAttributes || [];
  let messageDigestAttr = null;
  for (const attr of attrs) {
    try {
      const oid = forge.asn1.derToOid(attr.value[0].value);
      if (oid === OID_MESSAGE_DIGEST) {
        messageDigestAttr = attr.value[1].value[0].value; // OCTET STRING bytes
      }
      if (oid === OID_SIGNING_TIME) {
        const tNode = attr.value[1].value[0];
        let parsed = null;
        try {
          if (tNode.type === forge.asn1.Type.UTCTIME) parsed = forge.asn1.utcTimeToDate(tNode.value);
          else if (tNode.type === forge.asn1.Type.GENERALIZEDTIME) parsed = forge.asn1.generalizedTimeToDate(tNode.value);
        } catch {}
        if (parsed) result.signingTime = parsed.toISOString();
      }
    } catch {}
  }

  if (messageDigestAttr != null) {
    const md = mdFactory();
    md.update(signedBytes.toString('binary'));
    const contentDigest = md.digest().getBytes();
    result.contentIntegrity = (contentDigest === messageDigestAttr);
  } else {
    // Không có SignedAttributes → chữ ký ký trực tiếp lên nội dung (hiếm)
    result.reason = 'Không tìm thấy messageDigest trong SignedAttributes.';
  }

  // ── Verify mật mã chữ ký (PKCS#1 v1.5 hoặc RSASSA-PSS) ──
  try {
    const scheme = _detectScheme(rc, mdFactory);
    result.signatureScheme = scheme.isPss ? 'RSASSA-PSS' : 'RSA-PKCS1-v1.5';

    let toVerify;
    if (attrs.length > 0) {
      // SignedAttributes được ký dưới dạng SET (tag 0x31), không phải [0] IMPLICIT
      const attrSet = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs);
      toVerify = forge.asn1.toDer(attrSet).getBytes();
    } else {
      // Không có SignedAttributes: chữ ký trực tiếp trên nội dung
      toVerify = signedBytes.toString('binary');
    }

    if (rc.signature) {
      const md = scheme.hashFactory();
      md.update(toVerify);
      const digestBytes = md.digest().getBytes();
      result.cryptoVerified = scheme.isPss
        ? _verifyPss(signerCert, digestBytes, rc.signature, scheme.hashFactory, scheme.parsedSalt)
        : signerCert.publicKey.verify(digestBytes, rc.signature);
      if (attrs.length === 0) result.contentIntegrity = result.cryptoVerified;
    }
  } catch (e) {
    result.reason = (result.reason ? result.reason + ' | ' : '') + 'Verify chữ ký lỗi: ' + e.message;
  }

  return result;
}

/**
 * ★ Main API ★ — Xác minh PDF đã ký.
 * @param {Buffer} pdfBuffer
 * @returns {Object} {
 *   valid, signatureCount, signatures:[...], signer:{certInfo, ...}, reason
 * }
 */
function verifyPdfBuffer(pdfBuffer) {
  if (!pdfBuffer || pdfBuffer.slice(0, 5).toString('latin1') !== '%PDF-') {
    return { valid: false, signatureCount: 0, signatures: [], reason: 'File không phải PDF hợp lệ.' };
  }

  const rawSigs = extractSignatures(pdfBuffer);
  if (!rawSigs.length) {
    return { valid: false, signatureCount: 0, signatures: [], reason: 'PDF chưa có chữ ký số (không tìm thấy /ByteRange).' };
  }

  const signatures = rawSigs.map(s => verifyOneSignature(pdfBuffer, s));

  // Chọn chữ ký "tốt nhất" (verify đầy đủ nhất) làm đại diện người ký
  const score = (s) => Number(s.chainValid) * 4 + Number(s.cryptoVerified) * 2 + Number(s.contentIntegrity);
  const ranked = [...signatures].sort((x, y) => score(y) - score(x));
  const best = ranked[0];

  const valid = best.cryptoVerified && best.contentIntegrity &&
    best.certInfo && !best.certInfo.isExpired && !best.certInfo.isNotYetValid;

  const trustConfigured = caTrust.isConfigured();

  return {
    valid,
    trusted: best.chainValid,            // chuỗi neo vào Root CA tin cậy (VGCA)
    trustConfigured,
    trustAnchor: best.chainAnchor,
    chain: best.chain,
    chainReason: best.chainReason || null,
    signatureCount: signatures.length,
    signatures,
    signer: best.certInfo,
    digestAlgorithm: best.digestAlgorithm,
    signingTime: best.signingTime,
    contentIntegrity: best.contentIntegrity,
    cryptoVerified: best.cryptoVerified,
    reason: valid ? null : (best.reason || _explain(best)),
  };
}

function _explain(s) {
  if (!s.certInfo) return 'Không trích được chứng thư số.';
  if (s.certInfo.isExpired) return 'Chứng thư số đã hết hạn.';
  if (s.certInfo.isNotYetValid) return 'Chứng thư số chưa có hiệu lực.';
  if (!s.contentIntegrity) return 'Toàn vẹn nội dung không khớp (file có thể đã bị sửa sau khi ký).';
  if (!s.cryptoVerified) return 'Không verify được chữ ký mật mã.';
  return 'Chữ ký không hợp lệ.';
}

function verifyPdfFile(filePath) {
  return verifyPdfBuffer(fs.readFileSync(filePath));
}

module.exports = { verifyPdfBuffer, verifyPdfFile, extractSignatures };
