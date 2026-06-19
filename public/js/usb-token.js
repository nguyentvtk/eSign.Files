/* ═══════════════════════════════════════════════════════════
   USB TOKEN SIGNER — Tích hợp Middleware ký số nhà cung cấp VN
   ─────────────────────────────────────────────────────────
   Hỗ trợ:
     • VNPT-CA   (Middleware Plugin chạy ws://localhost:9000)
     • VGCA      (Ban Cơ yếu Chính phủ — VGCASignService:9090)
     • Viettel-CA(VTToken ws://localhost:9001)
     • BKAV-CA   (BkavCA ws://localhost:9002)
     • FPT-CA    (ws://localhost:9003)

   Mô hình giao tiếp:
     1. WebSocket  ws://localhost:<port>  (ưu tiên)
     2. HTTP REST  http://localhost:<port> (fallback)
     3. Simulation — demo mode khi không có Middleware

   Trên macOS, các Middleware này cần cài app của nhà cung cấp.
   eSignFiles không phụ thuộc cụ thể Middleware nào — sẽ tự
   probe tất cả ports khi user bấm "Ký số".
═══════════════════════════════════════════════════════════ */
window.UsbTokenSigner = (() => {
  'use strict';

  /* ── Cấu hình Middleware endpoints ────────────────────── */
  const PROVIDERS = {
    vnpt: { ws: 'wss://127.0.0.1:4433/plugin', http: 'http://127.0.0.1:8080', name: 'VNPT-CA', icon: 'bi-shield-check' },
    vgca: { ws: 'wss://localhost:8987', http: 'https://localhost:8987', name: 'VGCA (Ban Cơ yếu)', icon: 'bi-shield-lock' },
    viettel: { ws: 'ws://127.0.0.1:9001', http: 'http://127.0.0.1:8081', name: 'Viettel-CA', icon: 'bi-shield' },
    bkav: { ws: 'ws://127.0.0.1:9002', http: 'http://127.0.0.1:8082', name: 'BKAV-CA', icon: 'bi-shield-fill' },
    fpt: { ws: 'ws://127.0.0.1:9003', http: 'http://127.0.0.1:8083', name: 'FPT-CA', icon: 'bi-shield-fill-check' },
  };

  const TIMEOUT_WS_CONNECT = 2500;   // ms — chờ WS handshake
  const TIMEOUT_DETECT = 60000;       // ms — chờ user cắm token
  const TIMEOUT_SIGN = 120000;        // ms — chờ ký xong

  let _provider = 'vnpt';
  let _isCancelled = false;
  let _certInfo = null;
  let _activeTransport = null;
  let _onProgress = null;

  /* ── Public API ───────────────────────────────────────── */

  function setProvider(p) {
    if (PROVIDERS[p]) _provider = p;
  }

  function getProviders() {
    return Object.keys(PROVIDERS).map(k => ({ id: k, ...PROVIDERS[k] }));
  }

  function cancel() {
    _isCancelled = true;
    if (_activeTransport?.ws) try { _activeTransport.ws.close(); } catch {}
    _activeTransport = null;
  }

  /**
   * Probe tất cả providers, trả về provider đầu tiên có middleware chạy.
   * Hoặc null nếu không có cái nào.
   */
  async function detectAvailableProvider() {
    const results = await Promise.all(
      Object.keys(PROVIDERS).map(async (k) => {
        const ok = await _probeProvider(k);
        return ok ? k : null;
      })
    );
    return results.find(r => r !== null) || null;
  }

  async function _probeProvider(providerId) {
    const p = PROVIDERS[providerId];
    // Thử WebSocket
    try {
      await _tryWebSocket(p.ws, 1500);
      return true;
    } catch {}
    // Thử HTTP
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const r = await fetch(p.http + '/api/token/status', { signal: ctrl.signal, mode: 'cors' });
      clearTimeout(t);
      return r.ok;
    } catch {}
    return false;
  }

  /**
   * ★ Main API ★
   * Ký PDF với USB Token.
   *
   * @param {Object} args
   *   - pdfBase64: base64 PDF gốc (hoặc null nếu Middleware tự đọc từ fileId)
   *   - coordinates: [{page, xPt, yPt, wPt, hPt}] — vị trí stamp
   *   - meta: {maDoc, tenTaiLieu, signerName, signerEmail, fileId}
   *   - onProgress: function(phase, percent, message)
   *   - providerId: 'vnpt'|'vgca'|... (optional, default = _provider)
   * @returns {Promise<{signedBase64, cert}>}
   */
  async function signPdf({ pdfBase64, coordinates, meta = {}, onProgress, providerId }) {
    if (providerId) setProvider(providerId);
    _isCancelled = false;
    _certInfo = null;
    _onProgress = onProgress;

    // ── VNPT-CA Plugin: dùng thư viện vnpt-plugin.js chính thức (giao thức thật,
    //    wss://localhost:4433/plugin). Trả về PDF đã ký PAdES thật → server verify. ──
    if (_provider === 'vnpt') {
      return _signWithVnptPlugin({ pdfBase64, coordinates, meta });
    }

    _emit('connecting', 5, 'Kết nối Middleware…');

    const transport = await _connectMiddleware();
    _activeTransport = transport;

    if (_isCancelled) throw new Error('USER_CANCELLED');
    if (transport.type === 'simulation') {
      _emit('detecting', 15, 'Chế độ giả lập — không tìm thấy Middleware');
    } else {
      _emit('detecting', 15, `Đã kết nối ${PROVIDERS[_provider].name}. Chờ cắm USB Token…`);
    }

    const cert = await _detectToken(transport);
    _certInfo = cert;

    if (_isCancelled) throw new Error('USER_CANCELLED');
    _emit('pin', 40, 'Nhập PIN trên Middleware…');

    _emit('signing', 60, 'Đang ký số tài liệu…');
    const signedBase64 = await _requestSign(transport, pdfBase64, coordinates, cert, meta);

    if (_isCancelled) throw new Error('USER_CANCELLED');
    _emit('success', 100, 'Ký số thành công!');

    if (transport.ws) try { transport.ws.close(); } catch {}
    _activeTransport = null;

    return { signedBase64, cert };
  }

  /* ── VNPT-CA Plugin (thư viện vnpt-plugin.js chính thức) ─────────────────
     Plugin chạy nền tại wss://localhost:4433/plugin. Website phải nằm trong
     whitelist domainConfig.txt của máy client (vd e-sign-files.vercel.app).
     signPdf(base64, null, pdfSigner) → Promise resolve chuỗi JSON
       { "code":0, "data":"<base64 PDF đã ký>", "error":"" }
     code 0 = OK, 11 = người dùng huỷ. Các mã khác = lỗi.
  ──────────────────────────────────────────────────────────────────────── */
  async function _signWithVnptPlugin({ pdfBase64, coordinates, meta = {} }) {
    const vp = window.vnpt_plugin;
    if (!vp || typeof vp.signPdf !== 'function') {
      const err = new Error('NO_MIDDLEWARE');
      err.code = 'NO_MIDDLEWARE';
      err.provider = PROVIDERS.vnpt.name;
      throw err;
    }

    _emit('connecting', 8, 'Kiểm tra VNPT-CA Plugin…');
    let ready;
    try {
      ready = await vp.checkPlugin(null);
    } catch (e) {
      const err = new Error('NO_MIDDLEWARE');
      err.code = 'NO_MIDDLEWARE';
      err.provider = PROVIDERS.vnpt.name;
      throw err;
    }
    if (String(ready) !== '1') {
      const err = new Error('NO_MIDDLEWARE');
      err.code = 'NO_MIDDLEWARE';
      err.provider = PROVIDERS.vnpt.name;
      throw err;
    }
    if (_isCancelled) throw new Error('USER_CANCELLED');

    // ── Cài license cho plugin (BẮT BUỘC để đọc cert & ký). License là chuỗi XML
    //    do VNPT-CA cấp, gắn với domain gọi (vd e-sign-files.vercel.app). Lưu ở env
    //    VNPT_PLUGIN_LICENSE phía server, frontend lấy qua /api/signing/vnpt-config. ──
    const license = await _getVnptLicense();
    if (license) {
      _emit('connecting', 20, 'Cài đặt license VNPT-CA Plugin…');
      let licRes;
      try { licRes = JSON.parse(await vp.setLicenseKey(license, null)); } catch { licRes = null; }
      if (!licRes || (licRes.code !== 1 && licRes.code !== 0)) {
        throw new Error('License VNPT-CA Plugin không hợp lệ cho tên miền này: '
          + (licRes && licRes.error ? licRes.error : 'the license not correspond')
          + '. Cần xin license VNPT-CA cấp cho ' + location.hostname + '.');
      }
    } else {
      throw new Error('Chưa cấu hình license VNPT-CA Plugin. '
        + 'Đặt biến môi trường VNPT_PLUGIN_LICENSE (license do VNPT-CA cấp cho '
        + location.hostname + ') rồi thử lại.');
    }
    if (_isCancelled) throw new Error('USER_CANCELLED');

    // Toạ độ ký: coordinates[] dùng gốc bottom-left (điểm PDF) — khớp llx/lly/urx/ury
    const c = (coordinates && coordinates[0]) || null;
    const pdfSigner = {
      Signer: meta.signerName || '',
      Description: meta.maDoc ? `Ký số: ${meta.maDoc}` : '',
      SigningTime: _formatVnptTime(new Date()),
    };
    if (c) {
      pdfSigner.page = c.page || 1;
      pdfSigner.llx = Math.round(c.xPt);
      pdfSigner.lly = Math.round(c.yPt);
      pdfSigner.urx = Math.round(c.xPt + c.wPt);
      pdfSigner.ury = Math.round(c.yPt + c.hPt);
    }

    _emit('pin', 45, 'Chọn chứng thư & nhập mã PIN trên cửa sổ VNPT-CA Plugin…');
    _emit('signing', 60, 'Đang ký số tài liệu bằng USB Token…');

    let resStr;
    try {
      resStr = await vp.signPdf(pdfBase64, null, pdfSigner);
    } catch (e) {
      throw new Error('VNPT-CA Plugin lỗi khi ký: ' + (e && e.message ? e.message : e));
    }
    if (_isCancelled) throw new Error('USER_CANCELLED');

    let res;
    try { res = JSON.parse(resStr); } catch { throw new Error('Không đọc được kết quả từ VNPT-CA Plugin.'); }

    if (res.code === 11) throw new Error('USER_CANCELLED');
    if (res.code !== 0 || !res.data) {
      throw new Error(_vnptErrorText(res.code, res.error));
    }

    _emit('success', 100, 'Ký số VNPT-CA thành công!');
    // realSigned = true → sign-workflow sẽ gửi PDF này lên /upload-signed để server XÁC MINH
    return { signedBase64: res.data, cert: null, realSigned: true, provider: 'vnpt' };
  }

  let _vnptLicenseCache;
  async function _getVnptLicense() {
    if (_vnptLicenseCache !== undefined) return _vnptLicenseCache;
    try {
      const token = localStorage.getItem('esign_token') || sessionStorage.getItem('esign_token');
      const r = await fetch('/api/signing/vnpt-config', { headers: token ? { 'Authorization': 'Bearer ' + token } : {} });
      const d = await r.json();
      _vnptLicenseCache = (d && d.success && d.data && d.data.license) ? d.data.license : '';
    } catch { _vnptLicenseCache = ''; }
    return _vnptLicenseCache;
  }

  function _formatVnptTime(d) {
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
  }

  function _vnptErrorText(code, error) {
    const MAP = {
      1: 'Dữ liệu đầu vào rỗng hoặc không đúng định dạng.',
      2: 'Không tìm thấy chứng thư số. Hãy cắm USB Token.',
      3: 'Ký thất bại.',
      4: 'Không tìm thấy private key trên token.',
      5: 'Lỗi không xác định.',
      6: 'Thiếu tham số số trang.',
      7: 'Trang đặt chữ ký không hợp lệ.',
      8: 'Không tìm thấy thẻ ký số.',
      10: 'Dữ liệu chứa chữ ký không hợp lệ.',
    };
    return (MAP[code] || ('Mã lỗi ' + code)) + (error ? ` (${error})` : '');
  }

  function _emit(phase, percent, message) {
    if (typeof _onProgress === 'function') {
      try { _onProgress(phase, percent, message); } catch {}
    }
  }

  /* ── Connection layer ─────────────────────────────────── */

  async function _connectMiddleware() {
    const prov = PROVIDERS[_provider];
    try {
      const ws = await _tryWebSocket(prov.ws, TIMEOUT_WS_CONNECT);
      return { type: 'ws', ws };
    } catch {}
    try {
      await _checkHttpMiddleware(prov.http);
      return { type: 'http', baseUrl: prov.http };
    } catch {}
    // KHÔNG giả lập nữa: nếu thiếu middleware → báo lỗi rõ để người dùng cài plugin.
    // Cho phép bật demo có chủ đích qua localStorage('esign_allow_sim') = '1'.
    if (typeof localStorage !== 'undefined' && localStorage.getItem('esign_allow_sim') === '1') {
      return { type: 'simulation' };
    }
    const err = new Error('NO_MIDDLEWARE');
    err.code = 'NO_MIDDLEWARE';
    err.provider = prov.name;
    throw err;
  }

  function _tryWebSocket(url, timeoutMs = 2500) {
    return new Promise((resolve, reject) => {
      let done = false;
      let ws;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try { ws?.close(); } catch {}
        reject(new Error('WS timeout'));
      }, timeoutMs);
      try {
        ws = new WebSocket(url);
        ws.onopen = () => { if (!done) { done = true; clearTimeout(timer); resolve(ws); } };
        ws.onerror = () => { if (!done) { done = true; clearTimeout(timer); reject(new Error('WS refused')); } };
      } catch (e) {
        if (!done) { done = true; clearTimeout(timer); reject(e); }
      }
    });
  }

  async function _checkHttpMiddleware(baseUrl) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const r = await fetch(baseUrl + '/api/token/status', { signal: ctrl.signal, mode: 'cors' });
    clearTimeout(t);
    if (!r.ok) throw new Error('HTTP ' + r.status);
  }

  /* ── Token detection ──────────────────────────────────── */

  async function _detectToken(transport) {
    if (transport.type === 'ws') return _detectTokenWS(transport.ws);
    if (transport.type === 'http') return _detectTokenHTTP(transport.baseUrl);
    return _simulateCert();
  }

  function _detectTokenWS(ws) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Hết thời gian chờ USB Token')), TIMEOUT_DETECT);
      ws.send(JSON.stringify({ type: 'DETECT_TOKEN' }));
      ws.onmessage = evt => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === 'TOKEN_DETECTED') { clearTimeout(timer); resolve(msg.cert); }
          if (msg.type === 'ERROR') { clearTimeout(timer); reject(new Error(msg.message)); }
        } catch {}
      };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket lỗi khi phát hiện token')); };
    });
  }

  function _detectTokenHTTP(baseUrl) {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const max = TIMEOUT_DETECT / 2000;
      const poll = setInterval(async () => {
        if (_isCancelled) { clearInterval(poll); reject(new Error('USER_CANCELLED')); return; }
        try {
          const r = await fetch(baseUrl + '/api/token/detect', { mode: 'cors' });
          const d = await r.json();
          if (d.status === 'detected') { clearInterval(poll); resolve(d.cert); return; }
        } catch {}
        if (++attempts > max) { clearInterval(poll); reject(new Error('Timeout HTTP polling')); }
      }, 2000);
    });
  }

  function _simulateCert() {
    return new Promise(resolve => setTimeout(() => {
      resolve({
        subject: 'CN=DEMO USER, O=eSign Demo, C=VN',
        issuer: 'DEMO Root Certificate Authority',
        serial: 'DEMO:' + Math.random().toString(16).slice(2, 18).toUpperCase(),
        validFrom: new Date(Date.now() - 86400000 * 365).toISOString(),
        validTo: new Date(Date.now() + 86400000 * 365).toISOString(),
        algorithm: 'SHA256withRSA',
        simulated: true,
      });
    }, 1500));
  }

  /* ── Sign request ─────────────────────────────────────── */

  async function _requestSign(transport, pdfBase64, coordinates, cert, meta) {
    if (transport.type === 'ws') return _signPdfWS(transport.ws, pdfBase64, coordinates, cert, meta);
    if (transport.type === 'http') return _signPdfHTTP(transport.baseUrl, pdfBase64, coordinates, cert, meta);
    return _simulateSign(pdfBase64);
  }

  function _signPdfWS(ws, pdfBase64, coordinates, cert, meta) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Hết thời gian ký số')), TIMEOUT_SIGN);
      ws.send(JSON.stringify({
        type: 'SIGN_PDF',
        fileId: meta.fileId || '',
        pdfBase64: pdfBase64 || '',
        coordinates: coordinates || [],
        certSerial: cert.serial,
        signerName: meta.signerName || '',
        signerEmail: meta.signerEmail || '',
        maDoc: meta.maDoc || '',
        timestamp: new Date().toISOString(),
      }));
      ws.onmessage = evt => {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === 'SIGN_PROGRESS') _emit('signing', 60 + (msg.percent * 0.3), msg.message || `Đang ký… ${msg.percent}%`);
          if (msg.type === 'SIGN_COMPLETE') { clearTimeout(timer); resolve(msg.signedBase64); }
          if (msg.type === 'ERROR') { clearTimeout(timer); reject(new Error(msg.message)); }
        } catch {}
      };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket lỗi khi ký số')); };
    });
  }

  async function _signPdfHTTP(baseUrl, pdfBase64, coordinates, cert, meta) {
    const r = await fetch(baseUrl + '/api/pdf/sign', {
      method: 'POST', mode: 'cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileId: meta.fileId || '', pdfBase64: pdfBase64 || '',
        coordinates: coordinates || [], certSerial: cert.serial,
        signerName: meta.signerName || '', maDoc: meta.maDoc || '',
        timestamp: new Date().toISOString(),
      }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (!d.signedBase64) throw new Error(d.error || 'Không nhận được PDF đã ký');
    return d.signedBase64;
  }

  function _simulateSign(pdfBase64) {
    // Giả lập: stamp sẽ được server thực hiện qua API approve
    return new Promise(resolve => setTimeout(() => resolve(pdfBase64 || ''), 1200));
  }

  return { signPdf, setProvider, getProviders, cancel, detectAvailableProvider };
})();
