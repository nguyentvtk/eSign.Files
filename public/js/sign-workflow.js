/* ═══════════════════════════════════════════════════════════
   SIGN WORKFLOW — Luồng ký số cho lãnh đạo
   1. Preview PDF (PDF.js)
   2. Tải DOCX về sửa → tải PDF thay thế
   3. Đặt vị trí stamp chữ ký
   4. Ký USB Token với progress bar
═══════════════════════════════════════════════════════════ */
window.SignWorkflow = (() => {
  'use strict';

  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
  const fmtSize = b => b < 1024 ? b+' B' : b < 1048576 ? (b/1024).toFixed(1)+' KB' : (b/1048576).toFixed(2)+' MB';

  let _doc = null;       // Doc data
  let _pdfDoc = null;    // PDF.js document
  let _currentPage = 1;
  let _zoom = 1.2;
  let _modal = null;
  let _sigMode = false;
  let _sigBox = null;    // { page, x, y, width, height } trong toạ độ PDF viewer
  let _dragStart = null;
  let _draggingBox = false;

  /* ─── Public API ─── */
  async function open(docId) {
    try {
      const res = await API.documents.get(docId);
      if (!res.success) { window.Toast?.error(res.error); return; }
      _doc = res.data;

      $('#sw-title').textContent = `Phê duyệt: ${_doc.ten_tai_lieu}`;
      $('#sw-subtitle').textContent = `${_doc.ma_doc} • Người gửi: ${_doc.nguoi_tao_name || ''}`;
      $('#sw-attach-count').textContent = _doc.attachments?.length || 0;

      _modal = new bootstrap.Modal($('#signWorkflowModal'));
      _modal.show();

      _renderAttachments();
      setTimeout(() => _loadPdf(_doc.file_url), 300);
    } catch (e) {
      console.error('[SignWorkflow]', e);
      window.Toast?.error('Không thể tải tài liệu: ' + e.message);
    }
  }

  function close() { _modal?.hide(); _reset(); }

  function _reset() {
    _doc = null; _pdfDoc = null; _currentPage = 1; _zoom = 1.2;
    _sigMode = false; _sigBox = null;
    $('#sw-canvas-wrapper').classList.remove('sig-mode');
    $('#sw-sig-banner').style.display = 'none';
    $('#sw-attach-panel').style.display = 'none';
    document.querySelectorAll('.sw-sig-box').forEach(el => el.remove());
    _setStep(1);
  }

  /* ─── Steps UI ─── */
  function _setStep(n) {
    document.querySelectorAll('.sw-step').forEach(el => {
      const s = parseInt(el.dataset.step);
      el.classList.toggle('active', s === n);
      el.classList.toggle('done', s < n);
    });
  }

  /* ─── PDF Loading ─── */
  async function _loadPdf(url) {
    if (!window.pdfjsLib) {
      $('#sw-loading-text').textContent = 'PDF.js chưa tải xong, vui lòng đợi…';
      setTimeout(() => _loadPdf(url), 500);
      return;
    }
    $('#sw-loading').style.display = 'flex';
    $('#sw-loading-text').textContent = 'Đang tải PDF…';
    try {
      // Nếu URL là Dropbox direct link với ?dl=1, fetch về dạng arraybuffer
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const buf = await resp.arrayBuffer();
      _pdfDoc = await window.pdfjsLib.getDocument({ data: buf }).promise;
      $('#sw-total-pages').textContent = _pdfDoc.numPages;
      _currentPage = 1;
      $('#sw-page-input').value = 1;
      await _renderPage(1);
      $('#sw-loading').style.display = 'none';
    } catch (e) {
      $('#sw-loading-text').innerHTML = `<i class="bi bi-exclamation-circle"></i> Lỗi tải PDF: ${esc(e.message)}<br><small>Có thể do CORS, kiểm tra URL Dropbox.</small>`;
    }
  }

  async function _renderPage(num) {
    if (!_pdfDoc) return;
    const page = await _pdfDoc.getPage(num);
    const viewport = page.getViewport({ scale: _zoom });
    const canvas = $('#sw-canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = viewport.width + 'px';
    canvas.style.height = viewport.height + 'px';
    $('#sw-sig-layer').style.width = viewport.width + 'px';
    $('#sw-sig-layer').style.height = viewport.height + 'px';
    await page.render({ canvasContext: ctx, viewport }).promise;
    $('#sw-zoom-label').textContent = Math.round(_zoom * 100) + '%';
    _refreshSigBox();
  }

  /* ─── Attachments ─── */
  function _renderAttachments() {
    const list = $('#sw-attach-list');
    if (!_doc.attachments?.length) {
      list.innerHTML = '<div style="font-size:13px;color:var(--text-muted)">Không có file đính kèm.</div>';
      return;
    }
    const hasDocx = _doc.attachments.some(a => (a.file_type||'').toUpperCase() === 'DOCX');
    const hint = hasDocx ? `<div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;padding:10px 12px;font-size:12.5px;color:#92400E;margin-bottom:10px;width:100%">
      <i class="bi bi-info-circle"></i> <b>Cách sửa file DOCX:</b> Tải file về máy → mở bằng Word/LibreOffice → chỉnh sửa → Save As <b>PDF</b> → quay lại bấm nút <b>"Tải PDF thay thế"</b> để cập nhật file chính.
    </div>` : '';
    list.innerHTML = hint + _doc.attachments.map(a => {
      const ext = (a.file_type || '').toUpperCase();
      const icon = ext === 'PDF' ? 'bi-file-earmark-pdf' : 'bi-file-earmark-word';
      const color = ext === 'PDF' ? '#DC2626' : '#1A56DB';
      const isDocx = ext === 'DOCX';
      return `<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:#F9FAFB;border:1px solid #E5E7EB;border-radius:8px;min-width:240px">
        <i class="bi ${icon}" style="font-size:20px;color:${color}"></i>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.file_name)}</div>
          <div style="font-size:11px;color:#9CA3AF">${fmtSize(a.file_size)} • ${ext}</div>
        </div>
        <a href="${esc(a.file_url)}" target="_blank" download class="btn-outline-custom" style="padding:5px 10px;font-size:12px" title="${isDocx?'Tải DOCX về máy để sửa, sau đó dùng nút \"Tải PDF thay thế\" để upload PDF sau khi sửa':'Tải về'}"><i class="bi bi-download"></i>${isDocx?' Tải về sửa':''}</a>
      </div>`;
    }).join('');
  }

  async function _convertAndReplace(attId) {
    const tid = window.Toast?.show('info', 'Đang chuyển DOCX → PDF…', 0);
    try {
      const token = localStorage.getItem('esign_token') || sessionStorage.getItem('esign_token');
      const resp = await fetch(`/api/documents/${_doc.id}/convert-attachment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ attachment_id: attId }),
      });
      const data = await resp.json();
      if (tid) document.getElementById(tid)?.remove();
      if (!data.success) { window.Toast?.error(data.error); return; }

      // Hỏi xác nhận thay thế file chính
      if (!confirm(`Đã chuyển DOCX → PDF thành công.\nThay thế file chính bằng: ${data.data.file_name}?`)) return;

      // Tải PDF vừa convert về và upload làm file chính
      const pdfResp = await fetch(data.data.file_url);
      const blob = await pdfResp.blob();
      const file = new File([blob], data.data.file_name, { type: 'application/pdf' });
      await _replaceMainFile(file);
    } catch (e) {
      if (tid) document.getElementById(tid)?.remove();
      window.Toast?.error('Lỗi chuyển đổi: ' + e.message);
    }
  }

  async function _replaceMainFile(file) {
    const tid = window.Toast?.show('info', 'Đang thay thế file chính…', 0);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const token = localStorage.getItem('esign_token') || sessionStorage.getItem('esign_token');
      const resp = await fetch(`/api/documents/${_doc.id}/replace-main`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token },
        body: formData,
      });
      const data = await resp.json();
      if (tid) document.getElementById(tid)?.remove();
      if (!data.success) { window.Toast?.error(data.error); return; }
      _doc.file_url = data.data.file_url;
      _doc.file_name = data.data.file_name;
      window.Toast?.success('Đã thay thế file chính. Tải lại preview…');
      _setStep(2);
      await _loadPdf(_doc.file_url);
    } catch (e) {
      if (tid) document.getElementById(tid)?.remove();
      window.Toast?.error('Lỗi thay thế file: ' + e.message);
    }
  }

  /* ─── Signature placement ─── */
  function _enterSignMode() {
    _sigMode = true;
    $('#sw-canvas-wrapper').classList.add('sig-mode');
    $('#sw-sig-banner').style.display = 'block';
    $('#sw-attach-panel').style.display = 'none';
    _setStep(3);
  }

  function _exitSignMode() {
    _sigMode = false;
    _sigBox = null;
    $('#sw-canvas-wrapper').classList.remove('sig-mode');
    $('#sw-sig-banner').style.display = 'none';
    document.querySelectorAll('.sw-sig-box').forEach(el => el.remove());
    $('#sw-confirm-sign').disabled = true;
    _setStep(1);
  }

  function _refreshSigBox() {
    document.querySelectorAll('.sw-sig-box').forEach(el => el.remove());
    if (_sigBox && _sigBox.page === _currentPage) {
      const div = document.createElement('div');
      div.className = 'sw-sig-box placed';
      div.style.left = _sigBox.x + 'px';
      div.style.top = _sigBox.y + 'px';
      div.style.width = _sigBox.width + 'px';
      div.style.height = _sigBox.height + 'px';
      div.innerHTML = '<div class="sw-sig-label"><i class="bi bi-check-circle"></i> Vị trí chữ ký</div>';
      $('#sw-sig-layer').appendChild(div);
      $('#sw-sig-layer').style.pointerEvents = 'all';
    } else {
      $('#sw-sig-layer').style.pointerEvents = 'none';
    }
  }

  /* ─── USB Token Signing Simulation ─── */
  async function _signWithToken() {
    if (!_sigBox) { window.Toast?.warning('Chưa đặt vị trí chữ ký.'); return; }
    _setStep(4);
    $('#token-progress-overlay').style.display = 'flex';

    const steps = [
      { id: 1, label: 'Kết nối USB Token', title: 'Đang kết nối USB Token…', desc: 'Kiểm tra thiết bị USB Token', icon: 'bi-usb-drive', color: '#1A56DB', delay: 800 },
      { id: 2, label: 'Đọc chứng thư số', title: 'Đọc thông tin chứng thư…', desc: 'Đọc certificate từ USB Token', icon: 'bi-shield-lock', color: '#7C3AED', delay: 700 },
      { id: 3, label: 'Xác thực PIN', title: 'Xác thực PIN…', desc: 'Đang kiểm tra PIN người dùng', icon: 'bi-key', color: '#D97706', delay: 600 },
      { id: 4, label: 'Ký số tài liệu', title: 'Đang thực hiện ký số…', desc: 'Tạo chữ ký số trên tài liệu', icon: 'bi-pen', color: '#1A56DB', delay: 1200 },
      { id: 5, label: 'Tải lên Dropbox', title: 'Đang lưu vào Dropbox…', desc: 'Đẩy file đã ký lên kho lưu trữ', icon: 'bi-cloud-upload', color: '#059669', delay: 800 },
    ];

    for (const s of steps) {
      document.querySelectorAll('.tp-step').forEach(el => {
        const sid = parseInt(el.dataset.step);
        if (sid < s.id) { el.classList.add('done'); el.classList.remove('active'); el.querySelector('i').className = 'bi bi-check-circle-fill'; }
        else if (sid === s.id) { el.classList.add('active'); el.querySelector('i').className = 'bi bi-arrow-right-circle-fill'; }
      });
      $('#tp-icon').style.background = s.color + '22';
      $('#tp-icon').style.color = s.color;
      $('#tp-icon').innerHTML = `<i class="bi ${s.icon}"></i>`;
      $('#tp-title').textContent = s.title;
      $('#tp-desc').textContent = s.desc;
      $('#tp-step-label').textContent = `Bước ${s.id}/5`;
      $('#tp-progress').style.width = (s.id * 20) + '%';
      $('#tp-percent').textContent = (s.id * 20) + '%';
      await new Promise(r => setTimeout(r, s.delay));

      // Gọi API ký số khi tới bước 4
      if (s.id === 4) {
        const result = await _callSignApi();
        if (!result.success) {
          $('#tp-icon').style.background = '#FEF2F2';
          $('#tp-icon').style.color = '#DC2626';
          $('#tp-icon').innerHTML = '<i class="bi bi-x-circle"></i>';
          $('#tp-title').textContent = 'Ký thất bại';
          $('#tp-desc').textContent = result.error || 'Lỗi không xác định';
          $('#tp-close').style.display = 'block';
          $('#tp-close').textContent = 'Đóng';
          $('#tp-close').style.background = '#DC2626';
          $('#tp-close').onclick = () => { $('#token-progress-overlay').style.display = 'none'; $('#tp-close').style.display = 'none'; };
          return;
        }
        _signResult = result.data;
      }
    }

    // Completed
    document.querySelectorAll('.tp-step').forEach(el => {
      el.classList.remove('active');
      el.classList.add('done');
      el.querySelector('i').className = 'bi bi-check-circle-fill';
    });
    $('#tp-icon').style.background = '#DCFCE7';
    $('#tp-icon').style.color = '#059669';
    $('#tp-icon').innerHTML = '<i class="bi bi-check-circle-fill"></i>';
    $('#tp-title').textContent = 'Ký số thành công!';
    $('#tp-desc').innerHTML = `Tài liệu <strong>${esc(_doc.ma_doc)}</strong> đã được ký và lưu vào Dropbox.`;
    $('#tp-progress').style.width = '100%';
    $('#tp-percent').textContent = '100%';
    $('#tp-close').style.display = 'block';
    $('#tp-close').style.background = '#059669';
    $('#tp-close').textContent = 'Hoàn tất';
    $('#tp-close').onclick = () => {
      $('#token-progress-overlay').style.display = 'none';
      $('#tp-close').style.display = 'none';
      _modal?.hide();
      window.App?.loadPending?.();
      window.location.reload();
    };
  }

  let _signResult = null;

  async function _callSignApi() {
    // Chuyển toạ độ viewer → PDF coordinate
    const canvas = $('#sw-canvas');
    const ratio = canvas.width / parseFloat(canvas.style.width || canvas.width);
    const page = await _pdfDoc.getPage(_sigBox.page);
    const viewport = page.getViewport({ scale: 1 });
    const pdfX = (_sigBox.x / _zoom);
    const pdfY = viewport.height - (_sigBox.y / _zoom) - (_sigBox.height / _zoom);
    const pdfW = _sigBox.width / _zoom;
    const pdfH = _sigBox.height / _zoom;

    const data = {
      document_id: _doc.id,
      sign_method: 'usb_token',
      stamp_position: { page: _sigBox.page, x: pdfX, y: pdfY, width: pdfW, height: pdfH },
    };

    const token = localStorage.getItem('esign_token') || sessionStorage.getItem('esign_token');
    const resp = await fetch('/api/signing/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify(data),
    });
    return resp.json();
  }

  /* ─── Event Bindings ─── */
  document.addEventListener('DOMContentLoaded', () => {
    $('#sw-prev-page')?.addEventListener('click', () => { if (_currentPage > 1) { _currentPage--; $('#sw-page-input').value = _currentPage; _renderPage(_currentPage); } });
    $('#sw-next-page')?.addEventListener('click', () => { if (_currentPage < _pdfDoc?.numPages) { _currentPage++; $('#sw-page-input').value = _currentPage; _renderPage(_currentPage); } });
    $('#sw-page-input')?.addEventListener('change', (e) => { const n = parseInt(e.target.value); if (n >= 1 && n <= _pdfDoc?.numPages) { _currentPage = n; _renderPage(n); } });
    $('#sw-zoom-in')?.addEventListener('click', () => { _zoom = Math.min(3, _zoom + 0.2); _renderPage(_currentPage); });
    $('#sw-zoom-out')?.addEventListener('click', () => { _zoom = Math.max(0.4, _zoom - 0.2); _renderPage(_currentPage); });

    $('#sw-tab-attach')?.addEventListener('click', () => {
      const p = $('#sw-attach-panel');
      p.style.display = p.style.display === 'none' ? 'block' : 'none';
    });

    $('#sw-replace-pdf')?.addEventListener('click', () => $('#sw-replace-input').click());
    $('#sw-replace-input')?.addEventListener('change', (e) => { if (e.target.files[0]) _replaceMainFile(e.target.files[0]); });

    $('#sw-enter-sign-mode')?.addEventListener('click', _enterSignMode);
    $('#sw-cancel-sign-mode')?.addEventListener('click', _exitSignMode);
    $('#sw-confirm-sign')?.addEventListener('click', _signWithToken);

    $('#sw-reject')?.addEventListener('click', async () => {
      const reason = prompt('Lý do từ chối:');
      if (!reason) return;
      const token = localStorage.getItem('esign_token') || sessionStorage.getItem('esign_token');
      const resp = await fetch('/api/signing/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ document_id: _doc.id, ly_do: reason }),
      });
      const d = await resp.json();
      if (d.success) { window.Toast?.info('Đã từ chối tài liệu.'); _modal?.hide(); window.location.reload(); }
      else window.Toast?.error(d.error);
    });

    // Mouse events for signature placement
    const wrapper = $('#sw-canvas-wrapper');
    if (wrapper) {
      wrapper.addEventListener('mousedown', (e) => {
        if (!_sigMode) return;
        const rect = wrapper.getBoundingClientRect();
        _dragStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        _draggingBox = true;

        // Tạo box mới
        document.querySelectorAll('.sw-sig-box').forEach(el => el.remove());
        const div = document.createElement('div');
        div.className = 'sw-sig-box';
        div.id = 'sw-drag-box';
        div.style.left = _dragStart.x + 'px';
        div.style.top = _dragStart.y + 'px';
        div.style.width = '0px';
        div.style.height = '0px';
        div.innerHTML = '<div class="sw-sig-label">Đang vẽ…</div>';
        $('#sw-sig-layer').appendChild(div);
        $('#sw-sig-layer').style.pointerEvents = 'all';
      });

      wrapper.addEventListener('mousemove', (e) => {
        if (!_sigMode || !_draggingBox || !_dragStart) return;
        const rect = wrapper.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const box = $('#sw-drag-box');
        if (!box) return;
        const left = Math.min(_dragStart.x, x);
        const top = Math.min(_dragStart.y, y);
        const w = Math.abs(x - _dragStart.x);
        const h = Math.abs(y - _dragStart.y);
        box.style.left = left + 'px';
        box.style.top = top + 'px';
        box.style.width = w + 'px';
        box.style.height = h + 'px';
      });

      wrapper.addEventListener('mouseup', (e) => {
        if (!_sigMode || !_draggingBox) return;
        _draggingBox = false;
        const box = $('#sw-drag-box');
        if (!box) return;
        const w = parseFloat(box.style.width);
        const h = parseFloat(box.style.height);
        if (w < 50 || h < 20) {
          box.remove();
          window.Toast?.warning('Vùng chữ ký quá nhỏ. Vui lòng vẽ vùng lớn hơn.');
          return;
        }
        box.classList.add('placed');
        box.querySelector('.sw-sig-label').innerHTML = '<i class="bi bi-check-circle"></i> Vị trí chữ ký';
        _sigBox = {
          page: _currentPage,
          x: parseFloat(box.style.left),
          y: parseFloat(box.style.top),
          width: w,
          height: h,
        };
        $('#sw-confirm-sign').disabled = false;
        window.Toast?.success('Đã đặt vị trí chữ ký. Bấm "Hoàn thành & Ký" để tiếp tục.');
      });
    }
  });

  return { open, close, _convertAndReplace };
})();
