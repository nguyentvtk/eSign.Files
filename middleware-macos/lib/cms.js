/* ═══════════════════════════════════════════════════════════
   CMS — Dựng SignedData (PKCS#7 detached) cho chữ ký PAdES
   ─────────────────────────────────────────────────────────
   node-forge chỉ ký được khi có khoá riêng trong bộ nhớ, mà
   khoá của ta nằm trong token và không bao giờ rời khỏi đó.
   Vì vậy cấu trúc CMS được dựng thủ công bằng ASN.1: ta tự
   tính phần signedAttrs, đưa bản băm của nó cho thẻ ký, rồi
   ráp chữ ký thu được vào đúng chỗ.
═══════════════════════════════════════════════════════════ */
'use strict';

const forge = require('node-forge');
const asn1 = forge.asn1;

const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  sha256: '2.16.840.1.101.3.4.2.1',
  rsaEncryption: '1.2.840.113549.1.1.1',
};

const SHA256_DIGESTINFO_PREFIX =
  Buffer.from('3031300d060960864801650304020105000420', 'hex');

/* ── Tiện ích ASN.1 ─────────────────────────────────────── */

const U = asn1.Class.UNIVERSAL;
const C = asn1.Class.CONTEXT_SPECIFIC;

const seq = value => asn1.create(U, asn1.Type.SEQUENCE, true, value);
const set = value => asn1.create(U, asn1.Type.SET, true, value);
const oid = o => asn1.create(U, asn1.Type.OID, false, asn1.oidToDer(o).getBytes());
const int = n => asn1.create(U, asn1.Type.INTEGER, false, asn1.integerToDer(n).getBytes());
const octet = buf => asn1.create(U, asn1.Type.OCTETSTRING, false, buf.toString('binary'));
const nullTag = () => asn1.create(U, asn1.Type.NULL, false, '');
const ctx = (n, constructed, value) => asn1.create(C, n, constructed, value);

const algId = (o, withNull = true) => seq(withNull ? [oid(o), nullTag()] : [oid(o)]);

const attribute = (o, values) => seq([oid(o), set(values)]);

const derOf = node => Buffer.from(asn1.toDer(node).getBytes(), 'binary');

const sha256 = buf => {
  const md = forge.md.sha256.create();
  md.update(buf.toString('binary'));
  return Buffer.from(md.digest().toHex(), 'hex');
};

/* ── signedAttrs ────────────────────────────────────────── */

/**
 * Dựng tập signedAttrs và trả về bản DER cần đưa cho thẻ ký.
 *
 * Lưu ý về mã hoá: khi băm để ký, signedAttrs phải mang thẻ
 * SET (0x31); còn khi nhúng vào SignerInfo lại mang thẻ ngầm
 * định [0] (0xA0). Cùng nội dung, khác thẻ — sai chỗ này là
 * chữ ký không bao giờ kiểm tra được.
 */
function buildSignedAttrs({ contentDigest, certDer, signingTime }) {
  const attrs = [
    attribute(OID.contentType, [oid(OID.data)]),
    attribute(OID.signingTime, [
      asn1.create(U, asn1.Type.UTCTIME, false, asn1.dateToUtcTime(signingTime)),
    ]),
    attribute(OID.messageDigest, [octet(contentDigest)]),
    // signingCertificateV2 — ràng buộc chữ ký với đúng chứng thư,
    // yêu cầu của PAdES-BES.
    attribute(OID.signingCertificateV2, [
      seq([seq([seq([octet(sha256(certDer))])])]),
    ]),
  ];

  const forSigning = set(attrs);         // thẻ SET, dùng để băm
  const forEmbedding = ctx(0, true, attrs); // thẻ [0], dùng để nhúng

  return {
    attrs,
    derToSign: derOf(forSigning),
    embedded: forEmbedding,
  };
}

/* ── Định danh người ký ─────────────────────────────────── */

/**
 * Lấy issuer và serialNumber NGUYÊN XI từ chứng thư.
 *
 * Không dựng lại từ đối tượng đã phân tích của node-forge: nó
 * có thể chọn kiểu chuỗi khác bản gốc (UTF8String ↔ PrintableString),
 * khiến DN lệch vài byte. Khi đó trình kiểm tra không ghép được
 * SignerInfo với chứng thư và báo "signer certificate not found".
 */
function extractIssuerAndSerial(certDer) {
  const cert = asn1.fromDer(certDer.toString('binary'));
  const tbs = cert.value[0];

  // tbsCertificate mở đầu bằng [0] version nếu là v2/v3
  const hasVersion =
    tbs.value[0].tagClass === C && tbs.value[0].type === 0;
  const serial = tbs.value[hasVersion ? 1 : 0];
  const issuer = tbs.value[hasVersion ? 3 : 2];

  return { issuer, serial };
}

/* ── SignedData ─────────────────────────────────────────── */

/**
 * Ráp CMS SignedData dạng detached.
 *
 * @param {Object} a
 *   - contentDigest  Buffer  SHA-256 của vùng dữ liệu PDF được ký
 *   - signerCertDer  Buffer  chứng thư người ký (DER)
 *   - chainDer       Buffer[] chứng thư CA kèm theo
 *   - signingTime    Date
 *   - sign           async (digestInfo, hash) => Buffer  — hàm ký trên thẻ
 * @returns {Promise<Buffer>} ContentInfo DER
 */
async function buildSignedData({ contentDigest, signerCertDer, chainDer = [], signingTime, sign }) {
  const { derToSign, embedded } = buildSignedAttrs({
    contentDigest,
    certDer: signerCertDer,
    signingTime,
  });

  // Thẻ ký trên bản băm của signedAttrs, không phải trên PDF
  const attrsHash = sha256(derToSign);
  const digestInfo = Buffer.concat([SHA256_DIGESTINFO_PREFIX, attrsHash]);
  const signature = await sign(digestInfo, attrsHash);

  const { issuer, serial } = extractIssuerAndSerial(signerCertDer);

  const signerInfo = seq([
    int(1),
    seq([issuer, serial]),
    algId(OID.sha256),
    embedded,
    algId(OID.rsaEncryption),
    octet(signature),
  ]);

  const allCerts = [signerCertDer, ...chainDer].map(d =>
    asn1.fromDer(d.toString('binary'))
  );

  const signedData = seq([
    int(1),
    set([algId(OID.sha256)]),
    seq([oid(OID.data)]),              // detached: không nhúng nội dung
    ctx(0, true, allCerts),
    set([signerInfo]),
  ]);

  return derOf(seq([oid(OID.signedData), ctx(0, true, [signedData])]));
}

module.exports = { buildSignedData, buildSignedAttrs, sha256, SHA256_DIGESTINFO_PREFIX, OID };
