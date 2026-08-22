/* ═══════════════════════════════════════════════════════════
   PKCS#15 — Đọc thư mục chứng thư trên token
   ─────────────────────────────────────────────────────────
   CDF (EF 7005) chứa danh sách CertificateObject. Mỗi mục cho
   biết nhãn, ID khoá, cờ "authority" (true = chứng thư CA) và
   đường dẫn tới EF chứa chứng thư X.509 thật.
═══════════════════════════════════════════════════════════ */
'use strict';

const forge = require('node-forge');
const { EF_CDF, derTotalLength } = require('./card');

const asn1 = forge.asn1;

/** Duyệt cây ASN.1, trả về mọi node thoả điều kiện */
function findAll(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (pred(node)) out.push(node);
  if (Array.isArray(node.value)) for (const c of node.value) findAll(c, pred, out);
  return out;
}

const isOctetString = n =>
  n.tagClass === asn1.Class.UNIVERSAL && n.type === asn1.Type.OCTETSTRING;
const isUtf8 = n =>
  n.tagClass === asn1.Class.UNIVERSAL && n.type === asn1.Type.UTF8;
const isBoolean = n =>
  n.tagClass === asn1.Class.UNIVERSAL && n.type === asn1.Type.BOOLEAN;

/**
 * Phân tích CDF thành danh sách mục chứng thư.
 * @returns {Array<{label, authority, efId, idHex}>}
 */
function parseCdf(buf) {
  const entries = [];
  let off = 0;

  while (off + 4 <= buf.length) {
    // Vùng đệm 0x00 phía sau dữ liệu thật -> hết danh sách
    if (buf[off] !== 0x30) break;

    const total = derTotalLength(buf.subarray(off));
    if (!total || off + total > buf.length) break;

    const slice = buf.subarray(off, off + total);
    off += total;

    let obj;
    try {
      obj = asn1.fromDer(forge.util.createBuffer(slice.toString('binary')));
    } catch {
      continue;
    }

    // typeAttributes nằm trong thẻ ngữ cảnh [1]
    const ctx1 = (obj.value || []).find(
      n => n.tagClass === asn1.Class.CONTEXT_SPECIFIC && n.type === 1
    );
    if (!ctx1) continue;

    const paths = findAll(ctx1, isOctetString)
      .map(n => Buffer.from(n.value, 'binary'))
      .filter(b => b.length === 2);
    if (!paths.length) continue;

    const labels = findAll(obj, isUtf8);
    const bools = findAll(obj, isBoolean);
    const ids = findAll(obj, isOctetString)
      .map(n => Buffer.from(n.value, 'binary'))
      .filter(b => b.length > 2);

    entries.push({
      label: labels.length ? labels[0].value : '',
      authority: bools.length ? bools[0].value.charCodeAt(0) !== 0 : false,
      efId: paths[0].readUInt16BE(0),
      idHex: ids.length ? ids[0].toString('hex').toUpperCase() : '',
    });
  }

  return entries;
}

/**
 * Đọc toàn bộ chứng thư trên token.
 * @returns {Promise<Array<{label, authority, efId, der: Buffer}>>}
 */
async function readCertificates(session) {
  const cdf = await session.readEF(EF_CDF);
  const entries = parseCdf(cdf);

  const certs = [];
  for (const e of entries) {
    try {
      const raw = await session.readEF(e.efId);
      const total = derTotalLength(raw);
      const der = total ? raw.subarray(0, total) : raw;
      if (der.length > 100 && der[0] === 0x30) certs.push({ ...e, der });
    } catch {
      // Bỏ qua mục đọc lỗi, vẫn dùng được các mục còn lại
    }
  }
  return certs;
}

module.exports = { parseCdf, readCertificates };
