/* ═══════════════════════════════════════════════════════════
   CA TRUST STORE — Kho chứng thư CA tin cậy + kiểm tra chuỗi
   ─────────────────────────────────────────────────────────
   Nạp tất cả cert (.crt/.cer/.pem/.der) trong server/trust/**,
   dựng caStore (node-forge) và validate chuỗi chứng thư của
   người ký lên tới Root CA tin cậy (VGCA — Ban Cơ yếu).

   Cert trung gian/root KHÔNG nằm trong file PDF (PKCS#7 chỉ chứa
   cert lá) → ta tự dựng chuỗi bằng pool = (CA trong trust store
   + cert nhúng trong PKCS#7).

   Nguồn cert (public): http://ca.gov.vn/pki/pub/crt/
     • rootcag2.crt — RootCA chuyên dùng Chính phủ G2 (self-signed)
     • cpcag2.crt   — CA phục vụ các cơ quan Nhà nước G2 (intermediate)
═══════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const forge = require('node-forge');

const TRUST_DIR = path.join(__dirname, '..', 'trust');
let _cache = null;

function _loadCertFile(file) {
  const buf = fs.readFileSync(file);
  const txt = buf.toString('utf8');
  if (txt.includes('-----BEGIN CERTIFICATE-----')) {
    const blocks = txt.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
    return blocks.map(p => forge.pki.certificateFromPem(p));
  }
  // DER
  return [forge.pki.certificateFromAsn1(forge.asn1.fromDer(buf.toString('binary')))];
}

function _fp(cert) {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const md = forge.md.sha256.create();
  md.update(der);
  return md.digest().toHex();
}

function _dnEq(dn1, dn2) {
  const norm = (dn) => dn.attributes.map(a => `${a.type}=${String(a.value).trim().toLowerCase()}`).sort().join('|');
  return norm(dn1) === norm(dn2);
}

function _isSelfSigned(cert) {
  return _dnEq(cert.subject, cert.issuer);
}

function _cn(cert) {
  const f = cert.subject.getField('CN');
  return f ? Buffer.from(String(f.value), 'binary').toString('utf8') : cert.subject.attributes.map(a => a.value).join(',');
}

function load() {
  if (_cache) return _cache;
  const certs = [];
  if (fs.existsSync(TRUST_DIR)) {
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) walk(f);
        else if (/\.(crt|cer|pem|der)$/i.test(e.name)) {
          try { _loadCertFile(f).forEach(c => certs.push(c)); }
          catch (err) { console.error('[trust] Không nạp được', f, err.message); }
        }
      }
    })(TRUST_DIR);
  }
  const caStore = forge.pki.createCaStore();
  const rootFps = new Set();
  for (const c of certs) {
    caStore.addCertificate(c);
    if (_isSelfSigned(c)) rootFps.add(_fp(c));
  }
  if (!certs.length) console.warn('[trust] Trust store rỗng — chain validation sẽ bị bỏ qua. Thêm CA cert vào', TRUST_DIR);
  _cache = { certs, caStore, rootFps };
  return _cache;
}

function isConfigured() {
  return load().certs.length > 0;
}

/**
 * Dựng + verify chuỗi chứng thư của người ký tới Root CA tin cậy.
 * @param {Object} leaf — forge cert người ký
 * @param {Array}  embeddedCerts — các cert kèm trong PKCS#7 (có thể chứa intermediate)
 * @returns {{ valid:boolean, anchor:string|null, chain:string[], reason:string|null, configured:boolean }}
 */
function validateChain(leaf, embeddedCerts = []) {
  const store = load();
  if (!store.certs.length) {
    return { valid: false, anchor: null, chain: [_cn(leaf)], reason: 'Trust store chưa có CA cert.', configured: false };
  }

  // Pool ứng viên issuer = CA trong trust store + cert nhúng (trừ chính leaf)
  const leafFp = _fp(leaf);
  const pool = [...store.certs, ...embeddedCerts].filter(c => _fp(c) !== leafFp);

  // Dựng chuỗi leaf → … → root
  const chain = [leaf];
  const used = new Set([leafFp]);
  let cur = leaf;
  for (let i = 0; i < 10; i++) {
    if (_isSelfSigned(cur)) break;
    const issuer = pool.find(c => _dnEq(c.subject, cur.issuer) && !used.has(_fp(c)));
    if (!issuer) break;
    chain.push(issuer);
    used.add(_fp(issuer));
    cur = issuer;
  }

  const chainCNs = chain.map(_cn);

  // Verify chuỗi với caStore (forge kiểm tra cả chữ ký issuer lẫn hạn hiệu lực)
  try {
    forge.pki.verifyCertificateChain(store.caStore, chain);
  } catch (err) {
    const msg = (err && (err.message || err.error)) || 'Chuỗi chứng thư không hợp lệ.';
    return { valid: false, anchor: null, chain: chainCNs, reason: String(msg), configured: true };
  }

  // Xác nhận chuỗi neo vào Root CA self-signed tin cậy (pin theo fingerprint)
  const top = chain[chain.length - 1];
  const anchorFp = _isSelfSigned(top) ? _fp(top) : (() => {
    // top là intermediate → root nằm trong caStore; tìm root đã ký top
    const root = store.certs.find(c => _isSelfSigned(c) && _dnEq(c.subject, top.issuer));
    return root ? _fp(root) : null;
  })();

  if (!anchorFp || !store.rootFps.has(anchorFp)) {
    return { valid: false, anchor: null, chain: chainCNs, reason: 'Chuỗi không neo vào Root CA tin cậy.', configured: true };
  }

  const anchorCert = store.certs.find(c => _fp(c) === anchorFp);
  return { valid: true, anchor: anchorCert ? _cn(anchorCert) : null, chain: chainCNs, reason: null, configured: true };
}

module.exports = { validateChain, isConfigured, load };
