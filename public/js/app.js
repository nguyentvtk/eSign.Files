/* ═══════════════════════════════════════════════════════════
   eSign App v3.0 — Tuân thủ TT22/2020 & Luật GDĐT 2023
   Login: Mã NV / Email / SĐT / Họ tên + Mật khẩu
   Phân quyền: User thấy tài liệu mình, Admin/QL thấy tất cả
   File: PDF chính + tối đa 5 đính kèm (PDF/DOCX) → Dropbox
═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const Toast = {
    _container: () => document.getElementById('esign-toast-container'),
    _id: 0,
    show(type, msg, delay = 4000) {
      const id = 'toast_' + (++this._id);
      const icons = { success: 'bi-check-circle-fill', error: 'bi-x-circle-fill', warning: 'bi-exclamation-triangle-fill', info: 'bi-info-circle-fill' };
      const colors = { success: '#059669', error: '#EF4444', warning: '#D97706', info: '#3F83F8' };
      const el = document.createElement('div');
      el.id = id;
      el.style.cssText = `pointer-events:all;background:#1F2937;border-left:4px solid ${colors[type]};border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.25);padding:14px 16px;display:flex;align-items:flex-start;gap:10px;animation:toastSlideIn .3s ease;min-width:280px`;
      el.innerHTML = `<i class="bi ${icons[type]}" style="color:${colors[type]};font-size:17px;margin-top:1px"></i><div style="flex:1;font-size:13px;color:#D1D5DB;line-height:1.5">${msg}</div><button style="background:none;border:none;color:#9CA3AF;cursor:pointer;font-size:14px" onclick="this.parentElement.remove()"><i class="bi bi-x-lg"></i></button>`;
      this._container()?.appendChild(el);
      if (delay > 0) setTimeout(() => el.remove(), delay);
      return id;
    },
    success(m) { return this.show('success', m); },
    error(m) { return this.show('error', m, 6000); },
    warning(m) { return this.show('warning', m, 5000); },
    info(m) { return this.show('info', m, 3500); },
  };

  window.Toast = Toast;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const esc = (s) => String(s ?? '').replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
  const fmtDate = (d) => d ? new Date(d).toLocaleDateString('vi-VN', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '—';
  const fmtSize = (b) => b < 1024 ? b+' B' : b < 1048576 ? (b/1024).toFixed(1)+' KB' : (b/1048576).toFixed(2)+' MB';
  const initials = (n) => (n||'U').split(' ').map(w=>w[0]).join('').substring(0,2).toUpperCase();
  const loaiLabel = (l) => ({'hop-dong':'Hợp đồng','bien-ban':'Biên bản','van-ban-hc':'Văn bản HC','to-trinh':'Tờ trình','cong-van':'Công văn'}[l]||l);
  const statusBadge = (s) => {
    const m = {'Chờ ký':'pending','Đã ký':'signed','Từ chối':'rejected','Nháp':'draft'};
    return `<span class="badge-status ${m[s]||'draft'}">${esc(s)}</span>`;
  };
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(()=>fn(...a), ms); }; }

  // ── Auth ──
  function showLogin() { $('#app-login').style.display='flex'; $('#app-dashboard').style.display='none'; }
  function showDashboard() { $('#app-login').style.display='none'; $('#app-dashboard').style.display='block'; updateUserUI(); loadDashboard(); applyPermissions(); }

  function updateUserUI() {
    const u = API.getUser(); if (!u) return;
    const ini = initials(u.ho_ten);
    ['#sb-avatar','#hdr-avatar'].forEach(s=>{const e=$(s);if(e)e.textContent=ini;});
    ['#sb-name','#hdr-name'].forEach(s=>{const e=$(s);if(e)e.textContent=u.ho_ten;});
    ['#sb-role','#hdr-role'].forEach(s=>{const e=$(s);if(e)e.textContent=u.phan_quyen;});
  }

  function applyPermissions() {
    const u = API.getUser(); if (!u) return;
    const role = u.phan_quyen;
    // Ẩn menu theo quyền
    if (role === 'Người dùng') {
      $$('[data-feature="Quản lý người dùng"],[data-feature="Tài liệu chờ ký"],[data-feature="Nhật ký giao dịch"]').forEach(el => el.style.display = 'none');
    }
  }

  // ── Login Form ──
  $('#login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#btn-login'); btn.classList.add('loading'); btn.disabled = true;
    const alert = $('#login-alert'); alert.className = 'alert-login';
    try {
      const identifier = $('#login-identifier').value.trim();
      const pw = $('#login-password').value;
      const remember = $('#remember-me')?.checked;
      const res = await API.auth.login(identifier, pw, remember);
      if (res.success) {
        alert.className = 'alert-login success visible';
        alert.innerHTML = '<i class="bi bi-check-circle-fill"></i> Đăng nhập thành công!';
        setTimeout(showDashboard, 500);
      } else {
        alert.className = 'alert-login error visible';
        alert.innerHTML = `<i class="bi bi-exclamation-circle-fill"></i> ${esc(res.error)}`;
      }
    } catch (err) {
      alert.className = 'alert-login error visible';
      alert.innerHTML = '<i class="bi bi-exclamation-circle-fill"></i> Lỗi kết nối máy chủ.';
    } finally { btn.classList.remove('loading'); btn.disabled = false; }
  });

  $('#toggle-pw')?.addEventListener('click', () => {
    const inp = $('#login-password'); const icon = $('#toggle-pw i');
    if (inp.type==='password'){inp.type='text';icon.className='bi bi-eye-slash';}
    else{inp.type='password';icon.className='bi bi-eye';}
  });

  $('#btn-logout')?.addEventListener('click', async (e) => {
    e.preventDefault(); await API.auth.logout(); showLogin(); Toast.info('Đã đăng xuất.');
  });

  // ── API.auth.login update: use identifier instead of email ──
  const _origLogin = API.auth.login;
  API.auth.login = async function(identifier, password, remember) {
    const resp = await fetch('/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ identifier, password }) });
    const data = await resp.json();
    if (data.success) {
      const store = remember ? localStorage : sessionStorage;
      store.setItem('esign_token', data.token);
      store.setItem('esign_refresh', data.refreshToken);
      store.setItem('esign_user', JSON.stringify(data.user));
      store.setItem('esign_expires', data.expiresAt);
    }
    return data;
  };

  // ── Navigation ──
  const pages = ['dashboard','users','new-doc','pending','all-docs','verify','projects','register','audit','settings'];
  const pageNames = {dashboard:'Bảng điều khiển',users:'Quản lý người dùng','new-doc':'Khởi tạo tài liệu',pending:'Tài liệu chờ ký','all-docs':'Tài liệu của tôi',verify:'Xác minh tài liệu',projects:'Quản lý dự án',register:'Sổ công văn đi',audit:'Nhật ký giao dịch',settings:'Cài đặt bảo mật'};

  function navigateTo(page) {
    pages.forEach(p => { const el=$(`#page-${p}`); if(el) el.classList.toggle('active', p===page); });
    $$('.nav-link[data-page]').forEach(a => a.classList.toggle('active', a.dataset.page===page));
    $('#breadcrumb-page').textContent = pageNames[page]||page;
    if(page==='dashboard') loadDashboard();
    else if(page==='users') loadUsers();
    else if(page==='pending') loadPending();
    else if(page==='all-docs') loadAllDocs();
    else if(page==='new-doc') initNewDocForm();
    else if(page==='projects') loadProjects();
    else if(page==='register') initRegister();
    else if(page==='audit') loadAuditLog();
    else if(page==='settings') loadOtpSettings();
    if(window.innerWidth<992){$('#sidebar')?.classList.remove('mobile-open');$('#sidebar-overlay')?.classList.remove('visible');}
  }

  document.addEventListener('click', (e) => { const l=e.target.closest('[data-page]'); if(l){e.preventDefault();navigateTo(l.dataset.page);} });
  $('#btn-toggle-sidebar')?.addEventListener('click', () => {
    const sb=$('#sidebar');
    if(window.innerWidth<992){sb.classList.toggle('mobile-open');$('#sidebar-overlay').classList.toggle('visible',sb.classList.contains('mobile-open'));}
    else{sb.classList.toggle('collapsed');document.body.classList.toggle('sidebar-collapsed');}
  });
  $('#sidebar-overlay')?.addEventListener('click', () => { $('#sidebar').classList.remove('mobile-open');$('#sidebar-overlay').classList.remove('visible'); });

  // ── Dashboard ──
  async function loadDashboard() {
    try {
      const res = await API.documents.list({ limit: 1000 });
      if (!res.success) return;
      const all = res.data||[];
      let pending=0, signed=0, rejected=0;
      all.forEach(d => { if(d.trang_thai==='Chờ ký') pending++; else if(d.trang_thai==='Đã ký') signed++; else if(d.trang_thai==='Từ chối') rejected++; });
      $('#stat-total').textContent = all.length;
      $('#stat-pending').textContent = pending;
      $('#stat-signed').textContent = signed;
      $('#stat-rejected').textContent = rejected;
      $('#pending-count').textContent = pending;

      const recent = all.slice(0, 5);
      const tbody = $('#recent-docs-body');
      if(!recent.length){tbody.innerHTML='<tr><td colspan="5" class="text-center text-muted py-4">Chưa có tài liệu</td></tr>';return;}
      tbody.innerHTML = recent.map(d=>`<tr>
        <td><div class="doc-name-cell"><div class="doc-file-icon pdf"><i class="bi bi-file-earmark-pdf"></i></div><div><div class="doc-name">${esc(d.ten_tai_lieu)}</div><div class="doc-meta">${esc(d.ma_doc)}</div></div></div></td>
        <td>${esc(loaiLabel(d.loai_tai_lieu))}</td>
        <td>${statusBadge(d.trang_thai)}</td>
        <td style="font-size:12.5px;color:var(--text-secondary)">${fmtDate(d.created_at)}</td>
        <td><button class="tbl-action" title="Xem" onclick="App.viewDoc(${d.id})"><i class="bi bi-eye"></i></button></td>
      </tr>`).join('');
    } catch(e) { console.error('[Dashboard]',e); }
  }

  // ── Users ──
  let _users = [];
  async function loadUsers() {
    try { const res = await API.users.list(); if(!res.success){Toast.error(res.error);return;} _users=res.data; renderUsers(_users); } catch{Toast.error('Không thể tải người dùng.');}
  }
  function renderUsers(list) {
    const tbody=$('#users-body');
    if(!list.length){tbody.innerHTML='<tr><td colspan="7" class="text-center text-muted py-4">Không có người dùng</td></tr>';return;}
    tbody.innerHTML = list.map(u=>`<tr>
      <td><div class="usr-avatar-cell"><div class="usr-av">${initials(u.ho_ten)}</div><div><div class="usr-fullname">${esc(u.ho_ten)}</div><div class="usr-maNV">${esc(u.ma_nv)}</div></div></div></td>
      <td>${esc(u.email)}</td><td>${esc(u.phong_ban)}</td><td>${esc(u.chuc_vu)}</td>
      <td><span class="role-badge ${u.phan_quyen==='Admin'?'admin':u.phan_quyen==='Quản lý'?'manager':'user'}">${esc(u.phan_quyen)}</span></td>
      <td>${u.otp_enabled?'<i class="bi bi-shield-check text-success"></i>':'<i class="bi bi-shield-x text-muted"></i>'}</td>
      <td><button class="tbl-action" title="Sửa" onclick="App.editUser(${u.id})"><i class="bi bi-pencil"></i></button>
      <button class="tbl-action" title="Xóa" onclick="App.deleteUser(${u.id},'${esc(u.ho_ten)}')"><i class="bi bi-trash"></i></button></td>
    </tr>`).join('');
  }
  $('#user-search')?.addEventListener('input', (e) => { const q=e.target.value.toLowerCase(); renderUsers(_users.filter(u=>(u.ho_ten+u.email+u.ma_nv+u.phong_ban).toLowerCase().includes(q))); });
  $('#btn-add-user')?.addEventListener('click', () => {
    $('#userModalTitle').textContent='Thêm người dùng'; $('#user-form').reset(); $('#uf-id').value=''; $('#uf-manv').disabled=false;
    new bootstrap.Modal($('#userModal')).show();
  });
  $('#btn-sync-sheet')?.addEventListener('click', async () => {
    const btn=$('#btn-sync-sheet'); const old=btn.innerHTML;
    btn.disabled=true; btn.innerHTML='<i class="bi bi-arrow-repeat"></i> Đang đồng bộ…';
    try {
      const token=localStorage.getItem('esign_token')||sessionStorage.getItem('esign_token');
      const res=await (await fetch('/api/users/sync-sheet',{method:'POST',headers:{'Authorization':'Bearer '+token}})).json();
      if(res.success){Toast.success(res.message);loadUsers();}else Toast.error(res.error||'Đồng bộ thất bại.');
    }catch(e){Toast.error('Lỗi đồng bộ: '+e.message);}
    finally{btn.disabled=false;btn.innerHTML=old;}
  });
  $('#btn-save-user')?.addEventListener('click', async () => {
    const id=$('#uf-id').value;
    const data={ma_nv:$('#uf-manv').value.trim(),ho_ten:$('#uf-name').value.trim(),email:$('#uf-email').value.trim(),phone:$('#uf-phone').value.trim(),chuc_vu:$('#uf-chucvu').value.trim(),phong_ban:$('#uf-phongban').value.trim(),phan_quyen:$('#uf-role').value};
    const pw=$('#uf-password').value; if(pw) data.password=pw;
    try{
      const res = id ? await API.users.update(id,data) : await API.users.create({...data,password:pw||'esign123'});
      if(res.success){Toast.success(id?'Cập nhật thành công.':'Thêm người dùng thành công.');bootstrap.Modal.getInstance($('#userModal')).hide();loadUsers();}
      else Toast.error(res.error);
    }catch{Toast.error('Lỗi lưu người dùng.');}
  });

  // ── New Document (với file đính kèm) ──
  let _attachFiles = [];

  const dz = $('#drop-zone');
  const fileInput = $('#nd-file');
  if (dz) {
    ['dragover','dragenter'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add('drag-hover');}));
    ['dragleave','drop'].forEach(ev=>dz.addEventListener(ev,()=>dz.classList.remove('drag-hover')));
    dz.addEventListener('drop',e=>{e.preventDefault();if(e.dataTransfer.files[0]){fileInput.files=e.dataTransfer.files;handleFileSelect(e.dataTransfer.files[0]);}});
    fileInput?.addEventListener('change',()=>{if(fileInput.files[0])handleFileSelect(fileInput.files[0]);});
  }

  function handleFileSelect(file) {
    if(file.type!=='application/pdf'){Toast.error('File trình ký phải là PDF.');return;}
    dz.classList.add('has-file');
    $('#fp-name').textContent=file.name; $('#fp-meta').textContent=fmtSize(file.size);
    $('#sum-file').textContent=file.name;
    file.arrayBuffer().then(buf=>{
      crypto.subtle.digest('SHA-256',buf).then(hash=>{
        const hex=Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,'0')).join('');
        $('#sum-hash').textContent=hex;
      });
    });
    updateSummary();
  }

  $('#fp-remove')?.addEventListener('click',()=>{fileInput.value='';dz.classList.remove('has-file');$('#sum-file').textContent='Chưa tải';$('#sum-hash').textContent='—';updateSummary();});

  // Attachments
  $('#btn-add-attach')?.addEventListener('click', () => {
    if (_attachFiles.length >= 5) { Toast.warning('Tối đa 5 file đính kèm.'); return; }
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.pdf,.docx';
    inp.addEventListener('change', () => {
      const f = inp.files[0]; if (!f) return;
      const ext = f.name.split('.').pop().toLowerCase();
      if (!['pdf','docx'].includes(ext)) { Toast.error('Chỉ chấp nhận PDF hoặc DOCX.'); return; }
      if (_attachFiles.length >= 5) { Toast.warning('Tối đa 5 file đính kèm.'); return; }
      _attachFiles.push(f);
      renderAttachList();
      updateSummary();
    });
    inp.click();
  });

  function renderAttachList() {
    const container = $('#attach-list');
    if (!_attachFiles.length) { container.innerHTML = ''; return; }
    container.innerHTML = _attachFiles.map((f, i) => {
      const ext = f.name.split('.').pop().toLowerCase();
      const icon = ext === 'pdf' ? 'bi-file-earmark-pdf' : 'bi-file-earmark-word';
      const color = ext === 'pdf' ? '#DC2626' : '#1A56DB';
      return `<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:#F9FAFB;border:1px solid #E5E7EB;border-radius:8px;margin-bottom:6px">
        <i class="bi ${icon}" style="font-size:18px;color:${color}"></i>
        <div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(f.name)}</div>
        <div style="font-size:11px;color:#9CA3AF">${fmtSize(f.size)} • ${ext.toUpperCase()}</div></div>
        <button type="button" style="background:none;border:none;color:#9CA3AF;cursor:pointer;font-size:14px" onclick="App.removeAttach(${i})"><i class="bi bi-x-lg"></i></button>
      </div>`;
    }).join('');
  }

  function updateSummary() {
    $('#sum-name').textContent = $('#nd-name')?.value || '—';
    const typeMap = {'van-ban-hc':'Văn bản HC','hop-dong':'Hợp đồng','bien-ban':'Biên bản','to-trinh':'Tờ trình','cong-van':'Công văn'};
    $('#sum-type').textContent = typeMap[$('#nd-type')?.value]||'—';
    $('#sum-attach').textContent = _attachFiles.length + ' file';
  }
  $('#nd-name')?.addEventListener('input', updateSummary);
  $('#nd-type')?.addEventListener('change', updateSummary);

  $('#new-doc-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn=$('#btn-submit-doc'); btn.classList.add('loading'); btn.disabled=true;
    try {
      const formData = new FormData();
      formData.append('file', fileInput.files[0]);
      formData.append('ten_tai_lieu', $('#nd-name').value.trim());
      formData.append('loai_tai_lieu', $('#nd-type').value);
      formData.append('ngay_phat_hanh', $('#nd-ngay-ph')?.value || '');
      // Sổ công văn
      const pid = $('#nd-project')?.value;
      const phid = $('#nd-phase')?.value;
      const loaiVB = $('#nd-loai-vb')?.value;
      const soVB = $('#nd-so-vb')?.value?.trim();
      const mode = document.querySelector('input[name="vb-mode"]:checked')?.value || 'auto';
      const approver = $('#nd-approver')?.value;
      if (!pid) { Toast.warning('Vui lòng chọn dự án.'); btn.classList.remove('loading'); btn.disabled=false; return; }
      if (!loaiVB) { Toast.warning('Vui lòng chọn loại văn bản.'); btn.classList.remove('loading'); btn.disabled=false; return; }
      if (!approver) { Toast.warning('Vui lòng chọn người duyệt.'); btn.classList.remove('loading'); btn.disabled=false; return; }
      formData.append('project_id', pid);
      if (phid) formData.append('phase_id', phid);
      formData.append('loai_van_ban', loaiVB);
      formData.append('so_van_ban', soVB);
      formData.append('so_van_ban_mode', mode);
      formData.append('nguoi_duyet_id', approver);
      _attachFiles.forEach(f => formData.append('attachments', f));

      const res = await API.documents.create(formData);
      if (res.success) {
        Toast.success(`Tài liệu ${res.data.ma_doc} đã được gửi trình ký!`);
        $('#new-doc-form').reset(); dz.classList.remove('has-file'); _attachFiles=[]; renderAttachList(); updateSummary();
        navigateTo('all-docs');
      } else Toast.error(res.error);
    } catch(err) { Toast.error('Lỗi tạo tài liệu: '+err.message); }
    finally { btn.classList.remove('loading'); btn.disabled=false; }
  });

  $('#btn-reset-doc')?.addEventListener('click',()=>{$('#new-doc-form').reset();dz.classList.remove('has-file');_attachFiles=[];renderAttachList();updateSummary();const d=$('#nd-ngay-ph');if(d)d.value=new Date().toISOString().slice(0,10);});

  // ── Pending Documents (for Admin/Quản lý) ──
  async function loadPending() {
    const container = $('#pending-list');
    container.innerHTML = '<div class="text-center text-muted py-5">Đang tải...</div>';
    try {
      const res = await API.documents.pending();
      if(!res.success){Toast.error(res.error);return;}
      const docs=res.data||[];
      if(!docs.length){
        container.innerHTML=`<div class="pending-empty"><div class="pending-empty-icon"><i class="bi bi-check-circle"></i></div><div class="pending-empty-title">Không có tài liệu chờ ký</div><div class="pending-empty-desc">Tất cả tài liệu đã được xử lý.</div></div>`;
        return;
      }
      container.innerHTML = docs.map(d => {
        const attachHtml = (d.attachments||[]).length ? `<div class="dic-meta"><div class="dic-meta-item"><i class="bi bi-paperclip"></i> ${d.attachments.length} file đính kèm</div></div>` : '';
        return `<div class="doc-item-card normal mb-3">
          <div class="dic-body">
            <div class="dic-type-icon" style="background:#FEF2F2;color:#DC2626"><i class="bi bi-file-earmark-pdf"></i></div>
            <div>
              <div class="dic-title">${esc(d.ten_tai_lieu)}</div>
              <div class="dic-meta">
                <div class="dic-meta-item"><i class="bi bi-hash"></i> ${esc(d.ma_doc)}</div>
                <div class="dic-meta-item"><i class="bi bi-person"></i> ${esc(d.nguoi_tao_name)} (${esc(d.nguoi_tao_manv)})</div>
                <div class="dic-meta-item"><i class="bi bi-building"></i> ${esc(d.nguoi_tao_phongban||'')}</div>
                <div class="dic-meta-item"><i class="bi bi-calendar3"></i> ${fmtDate(d.created_at)}</div>
              </div>
              ${d.trich_yeu?`<div style="font-size:13px;color:var(--text-secondary);margin-top:6px">${esc(d.trich_yeu)}</div>`:''}
              ${attachHtml}
            </div>
            <div class="dic-actions">
              <button class="btn-do-sign" onclick="App.openSignModal(${d.id})"><i class="bi bi-check-circle"></i> <span class="sign-txt">Xem & Duyệt</span></button>
            </div>
          </div>
        </div>`;
      }).join('');
    } catch{Toast.error('Không thể tải tài liệu chờ ký.');}
  }

  // ── All Documents (user sees own, admin sees all) ──
  async function loadAllDocs() {
    const params = {};
    const search = $('#doc-search')?.value?.trim();
    const status = $('#doc-status-filter')?.value;
    if(search) params.search=search; if(status) params.status=status;
    try {
      const res = await API.documents.list(params);
      if(!res.success){Toast.error(res.error);return;}
      const docs=res.data||[];
      const tbody=$('#all-docs-body');
      if(!docs.length){tbody.innerHTML='<tr><td colspan="6" class="text-center text-muted py-4">Không tìm thấy tài liệu</td></tr>';return;}
      tbody.innerHTML = docs.map(d=>`<tr>
        <td><div class="ds-doc-cell"><div class="ds-doc-icon" style="background:#FEF2F2;color:#DC2626"><i class="bi bi-file-earmark-pdf"></i></div><div><div class="ds-doc-name">${esc(d.ten_tai_lieu)}</div><div class="ds-doc-id">${esc(d.ma_doc)}</div></div></div></td>
        <td>${esc(loaiLabel(d.loai_tai_lieu))}</td>
        <td>${esc(d.nguoi_tao_name||'—')}</td>
        <td>${statusBadge(d.trang_thai)}</td>
        <td style="font-size:12.5px;color:var(--text-secondary)">${fmtDate(d.created_at)}</td>
        <td>
          <button class="tbl-action" title="Xem chi tiết" onclick="App.viewDoc(${d.id})"><i class="bi bi-eye"></i></button>
          ${d.file_url?`<a class="tbl-action" title="Tải file" href="${esc(d.file_url)}" target="_blank"><i class="bi bi-download"></i></a>`:''}
          ${d.signed_file_url?`<a class="tbl-action sign" title="File đã ký" href="${esc(d.signed_file_url)}" target="_blank"><i class="bi bi-file-earmark-check"></i></a>`:''}
        </td>
      </tr>`).join('');
    } catch{Toast.error('Không thể tải tài liệu.');}
  }
  $('#doc-search')?.addEventListener('input', debounce(loadAllDocs, 400));
  $('#doc-status-filter')?.addEventListener('change', loadAllDocs);

  // ── Verify Document ──
  $('#btn-verify')?.addEventListener('click', async () => {
    const input=$('#verify-doc-id').value.trim();
    if(!input){Toast.warning('Vui lòng nhập mã tài liệu.');return;}
    const container=$('#verify-result');
    container.innerHTML='<div class="text-center text-muted py-3"><i class="bi bi-hourglass-split"></i> Đang xác minh...</div>';
    try {
      const listRes = await API.documents.list({search:input});
      if(!listRes.success||!listRes.data?.length){container.innerHTML='<div class="alert alert-warning mt-3">Không tìm thấy tài liệu.</div>';return;}
      const doc=listRes.data[0];
      const res = await API.documents.verify(doc.id);
      if(!res.success){container.innerHTML=`<div class="alert alert-danger mt-3">${esc(res.error)}</div>`;return;}
      const v=res.data;
      let html=`<div class="verify-result-card mt-3">
        <div class="verify-status"><div class="verify-icon valid"><i class="bi bi-patch-check"></i></div>
        <div><div style="font-size:16px;font-weight:700">${esc(v.document.ten_tai_lieu)}</div>
        <div style="font-size:13px;color:var(--text-secondary)">${esc(v.document.ma_doc)} — ${statusBadge(v.document.trang_thai)}</div></div></div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:16px">SHA-256: <code>${esc(v.document.file_hash)}</code></div>`;
      if(v.signatures.length){
        html+=`<h6 style="font-size:14px;font-weight:700;margin-bottom:12px"><i class="bi bi-pen"></i> Chữ ký số (${v.signatures.length})</h6>`;
        v.signatures.forEach(sig=>{
          html+=`<div class="verify-sig-card"><div class="verify-sig-header"><div class="verify-sig-step">✓</div><div><div style="font-weight:600">${esc(sig.signerName)}</div><div style="font-size:12px;color:var(--text-muted)">${fmtDate(sig.signedAt)}</div></div></div>
          <div class="verify-sig-grid">
            <div class="verify-sig-item"><div class="verify-sig-key">Phương thức</div><div class="verify-sig-val">${esc(sig.signMethod)}</div></div>
            <div class="verify-sig-item"><div class="verify-sig-key">Thuật toán</div><div class="verify-sig-val">${esc(sig.algorithm)}</div></div>
            <div class="verify-sig-item"><div class="verify-sig-key">OTP</div><div class="verify-sig-val">${sig.otpVerified?'Có':'Không'}</div></div>
          </div></div>`;
        });
      }
      if(v.attachments?.length){
        html+=`<h6 style="font-size:14px;font-weight:700;margin:16px 0 12px"><i class="bi bi-paperclip"></i> File đính kèm (${v.attachments.length})</h6>`;
        v.attachments.forEach(a=>{ html+=`<div style="font-size:13px;margin-bottom:4px">• ${esc(a.file_name)} (${fmtSize(a.file_size)})</div>`; });
      }
      html+='</div>';
      container.innerHTML=html;
    } catch(e){container.innerHTML=`<div class="alert alert-danger mt-3">Lỗi: ${esc(e.message)}</div>`;}
  });

  // ── Signing (Approve/Reject) ──
  let _signDocId=null, _signDocData=null;

  window.App = window.App || {};

  App.openSignModal = (docId) => {
    // Mở workflow ký số đầy đủ (PDF preview + edit DOCX + đặt stamp + USB Token)
    if (window.SignWorkflow) {
      window.SignWorkflow.open(docId);
    } else {
      Toast.error('Chưa tải xong module ký số.');
    }
  };
  App.loadPending = loadPending;

  $('#btn-confirm-sign')?.addEventListener('click', async () => {
    const btn=$('#btn-confirm-sign'); btn.classList.add('loading'); btn.disabled=true;
    try {
      const data = { document_id:_signDocId, sign_method:$('#sign-method').value, otp_token:$('#sign-otp').value.trim()||undefined };
      const res = await API.signing.approve(data);
      if(res.success){
        Toast.success(`Đã phê duyệt tài liệu ${res.data.ma_doc}!`);
        bootstrap.Modal.getInstance($('#signModal')).hide();
        loadPending(); loadDashboard();
      } else Toast.error(res.error);
    } catch(e){Toast.error('Lỗi: '+e.message);}
    finally{btn.classList.remove('loading');btn.disabled=false;}
  });

  $('#btn-reject-sign')?.addEventListener('click', async () => {
    const reason = prompt('Nhập lý do từ chối:');
    if(!reason) return;
    try {
      const res = await API.signing.reject({document_id:_signDocId, ly_do:reason});
      if(res.success){Toast.info('Đã từ chối tài liệu.');bootstrap.Modal.getInstance($('#signModal')).hide();loadPending();loadDashboard();}
      else Toast.error(res.error);
    } catch{Toast.error('Lỗi từ chối.');}
  });

  // Update API signing methods
  API.signing.approve = async function(data) {
    const token = localStorage.getItem('esign_token')||sessionStorage.getItem('esign_token');
    const resp = await fetch('/api/signing/approve',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify(data)});
    return resp.json();
  };
  API.signing.reject = async function(data) {
    const token = localStorage.getItem('esign_token')||sessionStorage.getItem('esign_token');
    const resp = await fetch('/api/signing/reject',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify(data)});
    return resp.json();
  };

  App.viewDoc = (id) => { navigateTo('verify'); API.documents.get(id).then(res=>{if(res.success){$('#verify-doc-id').value=res.data.ma_doc;$('#btn-verify').click();}}); };
  App.editUser = (id) => {
    const u=_users.find(x=>x.id===id);if(!u)return;
    $('#userModalTitle').textContent='Sửa người dùng';$('#uf-id').value=u.id;$('#uf-manv').value=u.ma_nv;$('#uf-manv').disabled=true;
    $('#uf-name').value=u.ho_ten;$('#uf-email').value=u.email;$('#uf-phone').value=u.phone||'';$('#uf-chucvu').value=u.chuc_vu||'';$('#uf-phongban').value=u.phong_ban||'';$('#uf-role').value=u.phan_quyen;$('#uf-password').value='';
    new bootstrap.Modal($('#userModal')).show();
  };
  App.deleteUser = async (id,name) => {if(!confirm(`Xóa người dùng "${name}"?`))return;const res=await API.users.remove(id);if(res.success){Toast.success('Đã xóa.');loadUsers();}else Toast.error(res.error);};
  App.removeAttach = (i) => { _attachFiles.splice(i,1); renderAttachList(); updateSummary(); };

  // ── Audit Log ──
  async function loadAuditLog() {
    try {
      const actRes = await API.audit.actions();
      if(actRes.success){const sel=$('#audit-action-filter');const cur=sel.value;sel.innerHTML='<option value="">Tất cả hành động</option>'+actRes.data.map(a=>`<option value="${esc(a)}">${esc(a)}</option>`).join('');sel.value=cur;}
      const params={};
      if($('#audit-action-filter')?.value) params.action=$('#audit-action-filter').value;
      if($('#audit-from')?.value) params.from=$('#audit-from').value;
      if($('#audit-to')?.value) params.to=$('#audit-to').value;
      const res = await API.audit.list(params);
      if(!res.success){Toast.error(res.error);return;}
      const tbody=$('#audit-body');
      if(!res.data?.length){tbody.innerHTML='<tr><td colspan="7" class="text-center text-muted py-4">Không có nhật ký</td></tr>';return;}
      const actionClass=(a)=>{if(a.includes('LOGIN'))return'login';if(a.includes('APPROVE')||a.includes('SIGN'))return'sign';if(a.includes('REJECT'))return'reject';return'default';};
      tbody.innerHTML = res.data.map(l=>`<tr>
        <td style="font-size:12px;color:var(--text-muted)">${l.id}</td>
        <td style="font-size:12.5px;white-space:nowrap">${fmtDate(l.timestamp)}</td>
        <td>${esc(l.user_email||'—')}</td>
        <td><span class="audit-action-badge ${actionClass(l.action)}">${esc(l.action)}</span></td>
        <td style="font-size:12.5px">${esc(l.target_type?l.target_type+':'+l.target_id:'—')}</td>
        <td style="font-size:12px;font-family:monospace">${esc(l.ip_address)}</td>
        <td style="font-size:11px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(l.detail)}">${esc(l.detail)}</td>
      </tr>`).join('');
    } catch{Toast.error('Không thể tải nhật ký.');}
  }
  $('#btn-audit-filter')?.addEventListener('click', loadAuditLog);
  $('#btn-export-audit')?.addEventListener('click', (e) => { e.preventDefault(); const p={}; if($('#audit-from')?.value)p.from=$('#audit-from').value; if($('#audit-to')?.value)p.to=$('#audit-to').value; window.open(API.audit.exportUrl(p),'_blank'); });

  // ── OTP Settings ──
  async function loadOtpSettings() {
    const status=$('#otp-status'),area=$('#otp-setup-area'),user=API.getUser();
    if(user?.otp_enabled){
      status.className='otp-status enabled';status.innerHTML='<i class="bi bi-shield-check"></i> Xác thực 2 lớp đã được kích hoạt';
      area.innerHTML='<p style="font-size:13px;color:var(--text-secondary)">Xác thực 2 lớp (TOTP) đang hoạt động. Mã OTP sẽ được yêu cầu khi lãnh đạo ký tài liệu.</p>';
    } else {
      status.className='otp-status disabled';status.innerHTML='<i class="bi bi-shield-exclamation"></i> Xác thực 2 lớp chưa được kích hoạt';
      area.innerHTML=`<p style="font-size:13px;color:var(--text-secondary);margin-bottom:16px">Kích hoạt xác thực 2 lớp để bảo vệ chữ ký số theo yêu cầu Luật GDĐT 2023.</p>
        <button class="btn-primary-custom" id="btn-setup-otp"><i class="bi bi-qr-code"></i> Thiết lập OTP</button>`;
      $('#btn-setup-otp')?.addEventListener('click', async () => {
        area.innerHTML='<div class="text-center py-3">Đang tạo QR code...</div>';
        try{
          const res=await API.auth.setupOtp();if(!res.success){Toast.error(res.error);return;}
          area.innerHTML=`<div class="otp-qr-wrap"><img src="${res.qrDataUrl}" alt="QR"></div><p style="font-size:13px;text-align:center;color:var(--text-secondary)">Quét mã QR bằng Google Authenticator</p><div class="otp-secret-box">${esc(res.secret)}</div><div class="nd-form-group"><label class="nd-label">Nhập mã OTP để xác nhận</label><input type="text" class="otp-verify-input" id="otp-confirm-input" maxlength="6" placeholder="000000"></div><button class="btn-primary-custom w-100 mt-2" id="btn-confirm-otp"><i class="bi bi-check-circle"></i> Xác nhận kích hoạt</button>`;
          $('#btn-confirm-otp')?.addEventListener('click', async ()=>{
            const token=$('#otp-confirm-input').value.trim();if(!token||token.length<6){Toast.warning('Nhập mã OTP 6 số.');return;}
            const vr=await API.auth.verifyOtp(token);if(vr.success){Toast.success('Đã kích hoạt OTP!');const u=API.getUser();if(u){u.otp_enabled=1;const s=localStorage.getItem('esign_user')?localStorage:sessionStorage;s.setItem('esign_user',JSON.stringify(u));}loadOtpSettings();}else Toast.error(vr.error);
          });
        }catch{Toast.error('Lỗi thiết lập OTP.');}
      });
    }
  }

  // ════════════════════════════════════════════════════════════
  // SỔ CÔNG VĂN — Dự án, Giai đoạn, Loại VB, Số VB, Người duyệt
  // ════════════════════════════════════════════════════════════

  let _projects = [], _approvers = [];

  async function _fetchAuth(url, opts={}) {
    const token = localStorage.getItem('esign_token') || sessionStorage.getItem('esign_token');
    const resp = await fetch(url, { ...opts, headers: { ...(opts.headers||{}), 'Authorization': 'Bearer ' + token } });
    return resp.json();
  }

  // ── New Doc Form: load projects, approvers ──
  async function initNewDocForm() {
    // Pre-fill "Ngày phát hành" with today
    const dateEl = $('#nd-ngay-ph');
    if (dateEl) dateEl.value = new Date().toISOString().slice(0, 10);
    try {
      const [projRes, apprRes] = await Promise.all([
        _fetchAuth('/api/projects'),       // server tự lọc theo quyền phụ trách
        _fetchAuth('/api/users/approvers'),
      ]);
      if (projRes.success) {
        _projects = projRes.data;
        const sel = $('#nd-project');
        const usable = _projects.filter(p => p.trang_thai !== 'Đã quyết toán');
        if (sel) {
          if (!usable.length) {
            sel.innerHTML = '<option value="">— Bạn chưa được phân công dự án nào —</option>';
          } else {
            sel.innerHTML = '<option value="">— Chọn dự án —</option>' +
              usable.map(p => `<option value="${p.id}">${esc(p.ma_du_an)} — ${esc(p.ten_du_an)}</option>`).join('');
          }
        }
      }
      if (apprRes.success) {
        _approvers = apprRes.data;
        const sel = $('#nd-approver');
        if (sel) sel.innerHTML = '<option value="">— Chọn người duyệt —</option>' +
          _approvers.map(u => `<option value="${u.id}">${esc(u.ho_ten)} — ${esc(u.chuc_vu||u.phan_quyen)} (${esc(u.phong_ban||'')})</option>`).join('');
      }
    } catch(e) { console.error('[InitNewDoc]', e); }
  }

  // Load phases khi đổi project
  document.addEventListener('change', async (e) => {
    if (e.target.id === 'nd-project') {
      const pid = e.target.value;
      const sel = $('#nd-phase');
      if (!pid) { sel.disabled = true; sel.innerHTML = '<option value="">— Hãy chọn dự án trước —</option>'; return; }
      sel.disabled = true;
      sel.innerHTML = '<option>Đang tải…</option>';
      const r = await _fetchAuth(`/api/projects/${pid}/phases`);
      if (r.success) {
        sel.innerHTML = '<option value="">— Chọn giai đoạn —</option>' +
          r.data.map(p => `<option value="${p.id}">${esc(p.ten_giai_doan)}</option>`).join('');
        sel.disabled = false;
      }
    }
    if (e.target.id === 'nd-loai-vb' || e.target.id === 'nd-project') {
      _autoGenerateNumber();
    }
    if (e.target.name === 'vb-mode') {
      const mode = e.target.value;
      const inp = $('#nd-so-vb');
      if (mode === 'manual') { inp.readOnly = false; inp.placeholder = 'Nhập số văn bản'; inp.value = ''; }
      else { inp.readOnly = true; _autoGenerateNumber(); }
    }
  });

  async function _autoGenerateNumber() {
    const mode = document.querySelector('input[name="vb-mode"]:checked')?.value;
    if (mode !== 'auto') return;
    const loai = $('#nd-loai-vb')?.value;
    const pid = $('#nd-project')?.value;
    if (!loai) return;
    const qs = new URLSearchParams({ loai });
    if (pid) qs.set('project_id', pid);
    const r = await _fetchAuth(`/api/documents/next-number?${qs}`);
    if (r.success) $('#nd-so-vb').value = r.data.so_van_ban;
  }

  // Auto-fill tên tài liệu khi chọn file
  const _origHandleFileSelect = window._origHandleFileSelect || null;
  // Override handleFileSelect to auto-set name
  document.addEventListener('change', (e) => {
    if (e.target.id === 'nd-file') {
      const f = e.target.files[0];
      if (f && !$('#nd-name').value.trim()) {
        $('#nd-name').value = f.name.replace(/\.pdf$/i, '');
        updateSummary?.();
      }
    }
  });

  // Patch form submit để thêm các fields mới
  const _origForm = $('#new-doc-form');
  if (_origForm) {
    _origForm.addEventListener('submit', async (e) => {
      // Hook chạy SAU handler chính — nhưng vì handler đã submit, ta cần wrap
    }, true);
  }

  // ── Projects Page ──
  let _projModal = null;
  const _money = (n) => n ? Number(n).toLocaleString('vi-VN') + ' đ' : '—';

  async function loadProjects() {
    try {
      const r = await _fetchAuth('/api/projects');
      if (!r.success) { Toast.error(r.error); return; }
      const tbody = $('#projects-body');
      if (!r.data.length) { tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted py-4">Chưa có dự án</td></tr>'; return; }
      tbody.innerHTML = r.data.map(p => `<tr>
        <td><strong style="color:var(--brand-primary)">${esc(p.ma_du_an)}</strong>${p.nam_thuc_hien?`<div style="font-size:11px;color:var(--text-muted)">Năm ${esc(p.nam_thuc_hien)}</div>`:''}</td>
        <td><div style="font-weight:500">${esc(p.ten_du_an)}</div>${p.chu_dau_tu?`<div style="font-size:11.5px;color:var(--text-muted)">${esc(p.chu_dau_tu)}</div>`:''}</td>
        <td style="font-size:12.5px">${esc(p.nv_ky_thuat||'—')}${p.nv_ky_thuat_id?' <i class="bi bi-check-circle-fill text-success" title="Đã liên kết tài khoản"></i>':''}</td>
        <td style="font-size:12.5px">${esc(p.nv_ke_toan||'—')}${p.nv_ke_toan_id?' <i class="bi bi-check-circle-fill text-success"></i>':''}</td>
        <td style="font-size:13px">${_money(p.tong_muc_dau_tu)}</td>
        <td><span class="badge-status signed">${p.so_da_ky}/${p.so_van_ban}</span></td>
        <td>${statusBadge(p.trang_thai)}</td>
        <td style="white-space:nowrap">
          <button class="tbl-action" title="Sửa" onclick="App.editProject(${p.id})"><i class="bi bi-pencil"></i></button>
          <button class="tbl-action" title="Xem danh mục" onclick="App.viewProjectDocs(${p.id})"><i class="bi bi-list-ul"></i></button>
          <button class="tbl-action" title="Xuất HS" onclick="App.exportProject(${p.id})"><i class="bi bi-download"></i></button>
          <button class="tbl-action" title="Xoá" onclick="App.deleteProject(${p.id},'${esc(p.ma_du_an)}')"><i class="bi bi-trash"></i></button>
        </td>
      </tr>`).join('');
    } catch(e) { Toast.error('Lỗi tải dự án.'); }
  }

  // ── Tab switching ──
  function _switchProjTab(tab) {
    $('#proj-tab-import').style.display = tab === 'import' ? 'block' : 'none';
    $('#proj-tab-manual').style.display = tab === 'manual' ? 'block' : 'none';
    $('#tab-import-btn').classList.toggle('active', tab === 'import');
    $('#tab-manual-btn').classList.toggle('active', tab === 'manual');
    // Nút Lưu chỉ hiện ở tab thủ công
    $('#btn-save-project').style.display = tab === 'manual' ? 'inline-block' : 'none';
  }
  $('#tab-import-btn')?.addEventListener('click', () => _switchProjTab('import'));
  $('#tab-manual-btn')?.addEventListener('click', () => _switchProjTab('manual'));

  $('#btn-add-project')?.addEventListener('click', () => {
    $('#projectModalTitle').textContent = 'Thêm dự án';
    $('#project-form').reset(); $('#pf-id').value = '';
    $('#pf-ma').disabled = false;
    $('#imp-mapping').style.display = 'none';
    $('#imp-preview').innerHTML = ''; $('#imp-count').textContent = '';
    // Prefill URL sheet dự án mặc định
    if (!$('#imp-url').value) $('#imp-url').value = 'https://docs.google.com/spreadsheets/d/1LsaccoqTu3sRaElEWVdCZjXlzRL_2N2DPPP3UiInDEk/edit?gid=0';
    _switchProjTab('import');
    _projModal = new bootstrap.Modal($('#projectModal')); _projModal.show();
  });

  // ── Import từ Sheet: tải cột ──
  const MAP_FIELDS = [
    { key:'ma_du_an', label:'Mã dự án', req:true },
    { key:'ten_du_an', label:'Tên dự án', req:true },
    { key:'chu_dau_tu', label:'Chủ đầu tư' },
    { key:'nam_thuc_hien', label:'Năm thực hiện' },
    { key:'loai_du_an', label:'Loại dự án' },
    { key:'nv_ky_thuat', label:'Phụ trách kỹ thuật ⚑' },
    { key:'nv_ke_toan', label:'Phụ trách kế toán ⚑' },
    { key:'tong_muc_dau_tu', label:'Tổng mức đầu tư' },
    { key:'tong_gt_quyet_toan', label:'Tổng GT quyết toán' },
    { key:'so_giai_ngan', label:'Số giải ngân' },
    { key:'ngay_bat_dau', label:'Ngày bắt đầu' },
    { key:'ngay_ket_thuc', label:'Ngày kết thúc' },
    { key:'mo_ta', label:'Mô tả' },
    { key:'trang_thai', label:'Trạng thái' },
  ];
  let _impHeaders = [], _impSuggested = {};

  $('#btn-load-cols')?.addEventListener('click', async () => {
    const url = $('#imp-url').value.trim();
    const sheetName = $('#imp-sheet').value.trim();
    if (!url) { Toast.warning('Nhập URL Google Sheet.'); return; }
    const btn = $('#btn-load-cols'); const old = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<i class="bi bi-hourglass-split"></i>';
    try {
      const r = await _fetchAuth('/api/projects/sheet-preview', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ url, sheetName })
      });
      if (!r.success) { Toast.error(r.error); return; }
      _impHeaders = r.data.headers; _impSuggested = r.data.mapping;
      $('#imp-count').textContent = `${r.data.total} dòng dữ liệu`;
      _renderMappingFields();
      $('#imp-mapping').style.display = 'block';
      Toast.success(`Đã tải ${_impHeaders.length} cột. Kiểm tra ánh xạ rồi Import.`);
    } catch(e) { Toast.error('Lỗi tải cột: ' + e.message); }
    finally { btn.disabled = false; btn.innerHTML = old; }
  });

  function _renderMappingFields() {
    const opts = (sel) => '<option value="">— Không dùng —</option>' +
      _impHeaders.map(h => `<option value="${esc(h)}" ${h===sel?'selected':''}>${esc(h)}</option>`).join('');
    $('#imp-mapping-fields').innerHTML = MAP_FIELDS.map(f => `
      <div class="col-md-6">
        <label class="form-label" style="font-size:12.5px;margin-bottom:2px">${f.label}${f.req?' <span style="color:#DC2626">*</span>':''}</label>
        <select class="form-select form-select-sm imp-map" data-key="${f.key}">${opts(_impSuggested[f.key]||'')}</select>
      </div>`).join('');
  }

  function _collectMapping() {
    const m = {};
    document.querySelectorAll('.imp-map').forEach(s => { if (s.value) m[s.dataset.key] = s.value; });
    return m;
  }

  $('#btn-preview-import')?.addEventListener('click', async () => {
    const url = $('#imp-url').value.trim(), sheetName = $('#imp-sheet').value.trim();
    const m = _collectMapping();
    if (!m.ma_du_an || !m.ten_du_an) { Toast.warning('Phải chọn cột Mã DA & Tên dự án.'); return; }
    const r = await _fetchAuth('/api/projects/sheet-preview', {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url, sheetName })
    });
    if (!r.success) { Toast.error(r.error); return; }
    const rows = r.data.sample;
    const cols = ['ma_du_an','ten_du_an','nv_ky_thuat','nv_ke_toan','tong_muc_dau_tu'];
    const labels = {ma_du_an:'Mã DA',ten_du_an:'Tên DA',nv_ky_thuat:'PT Kỹ thuật',nv_ke_toan:'PT Kế toán',tong_muc_dau_tu:'TMĐT'};
    $('#imp-preview').innerHTML = `<table class="doc-table" style="font-size:12px"><thead><tr>${cols.map(c=>`<th>${labels[c]}</th>`).join('')}</tr></thead><tbody>${
      rows.map(row => `<tr>${cols.map(c => `<td>${esc(row[m[c]]||'')}</td>`).join('')}</tr>`).join('')
    }</tbody></table><div style="font-size:11.5px;color:var(--text-muted);margin-top:4px">Hiển thị ${rows.length} dòng đầu.</div>`;
  });

  $('#btn-do-import')?.addEventListener('click', async () => {
    const url = $('#imp-url').value.trim(), sheetName = $('#imp-sheet').value.trim();
    const mapping = _collectMapping();
    if (!mapping.ma_du_an || !mapping.ten_du_an) { Toast.warning('Phải chọn cột Mã DA & Tên dự án.'); return; }
    const btn = $('#btn-do-import'); const old = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<i class="bi bi-hourglass-split"></i> Đang import…';
    try {
      const r = await _fetchAuth('/api/projects/import-sheet', {
        method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url, sheetName, mapping })
      });
      if (r.success) {
        Toast.success(r.message);
        _projModal?.hide();
        loadProjects();
      } else Toast.error(r.error);
    } catch(e) { Toast.error('Lỗi import: ' + e.message); }
    finally { btn.disabled = false; btn.innerHTML = old; }
  });

  // ── Lưu thủ công (thêm/sửa) ──
  $('#btn-save-project')?.addEventListener('click', async () => {
    const id = $('#pf-id').value;
    const data = {
      ma_du_an: $('#pf-ma').value.trim(),
      ten_du_an: $('#pf-ten').value.trim(),
      chu_dau_tu: $('#pf-cdt').value.trim(),
      nam_thuc_hien: $('#pf-nam').value.trim(),
      loai_du_an: $('#pf-loai').value.trim(),
      nv_ky_thuat: $('#pf-kt').value.trim(),
      nv_ke_toan: $('#pf-ketoan').value.trim(),
      tong_muc_dau_tu: parseFloat($('#pf-tmdt').value) || 0,
      ngay_bat_dau: $('#pf-start').value || null,
      ngay_ket_thuc: $('#pf-end').value || null,
      trang_thai: $('#pf-status').value,
      mo_ta: $('#pf-desc').value.trim(),
    };
    if (!data.ma_du_an || !data.ten_du_an) { Toast.warning('Vui lòng nhập Mã & Tên dự án.'); return; }
    const r = id
      ? await _fetchAuth(`/api/projects/${id}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(data) })
      : await _fetchAuth('/api/projects', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(data) });
    if (r.success) {
      Toast.success(id ? 'Đã cập nhật dự án.' : `Đã tạo dự án ${data.ma_du_an}`);
      _projModal?.hide();
      loadProjects();
    } else Toast.error(r.error);
  });

  App.editProject = async (id) => {
    const r = await _fetchAuth(`/api/projects/${id}`);
    if (!r.success) { Toast.error(r.error); return; }
    const p = r.data;
    $('#projectModalTitle').textContent = 'Sửa dự án';
    $('#pf-id').value = p.id;
    $('#pf-ma').value = p.ma_du_an; $('#pf-ma').disabled = true;
    $('#pf-ten').value = p.ten_du_an || '';
    $('#pf-cdt').value = p.chu_dau_tu || '';
    $('#pf-nam').value = p.nam_thuc_hien || '';
    $('#pf-loai').value = p.loai_du_an || '';
    $('#pf-kt').value = p.nv_ky_thuat || '';
    $('#pf-ketoan').value = p.nv_ke_toan || '';
    $('#pf-tmdt').value = p.tong_muc_dau_tu || '';
    $('#pf-start').value = (p.ngay_bat_dau||'').slice(0,10);
    $('#pf-end').value = (p.ngay_ket_thuc||'').slice(0,10);
    $('#pf-status').value = p.trang_thai || 'Đang thực hiện';
    $('#pf-desc').value = p.mo_ta || '';
    _projModal = new bootstrap.Modal($('#projectModal'));
    _switchProjTab('manual');
    _projModal.show();
  };

  App.deleteProject = async (id, ma) => {
    if (!confirm(`Xoá dự án "${ma}"? (chỉ xoá được khi chưa có tài liệu)`)) return;
    const r = await _fetchAuth(`/api/projects/${id}`, { method:'DELETE' });
    if (r.success) { Toast.success('Đã xoá dự án.'); loadProjects(); }
    else Toast.error(r.error);
  };

  App.viewProjectDocs = (id) => {
    navigateTo('register');
    setTimeout(() => {
      const sel = $('#reg-project-filter');
      if (sel) { sel.value = id; sel.dispatchEvent(new Event('change')); }
    }, 200);
  };

  App.exportProject = (id) => {
    const token = localStorage.getItem('esign_token') || sessionStorage.getItem('esign_token');
    fetch(`/api/projects/${id}/export`, { headers: { 'Authorization': 'Bearer ' + token } })
      .then(r => r.blob())
      .then(b => {
        const url = URL.createObjectURL(b);
        const a = document.createElement('a');
        a.href = url; a.download = `DanhMucHS_${id}_${new Date().toISOString().slice(0,10)}.csv`;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
        Toast.success('Đã tải xuống danh mục HS quyết toán.');
      });
  };

  // ── Register (Sổ công văn đi) ──
  async function initRegister() {
    const sel = $('#reg-project-filter');
    if (!sel) return;
    if (sel.options.length < 2) {
      const r = await _fetchAuth('/api/projects');
      if (r.success) sel.innerHTML = '<option value="">— Chọn dự án —</option>' +
        r.data.map(p => `<option value="${p.id}">${esc(p.ma_du_an)} — ${esc(p.ten_du_an)}</option>`).join('');
    }
    sel.onchange = async () => {
      const pid = sel.value;
      if (!pid) { $('#register-body').innerHTML = '<tr><td colspan="8" class="text-center text-muted py-4">Chọn dự án để xem danh mục</td></tr>'; return; }
      $('#register-body').innerHTML = '<tr><td colspan="8" class="text-center text-muted py-4">Đang tải…</td></tr>';
      const r = await _fetchAuth(`/api/projects/${pid}/documents`);
      if (!r.success) { Toast.error(r.error); return; }
      const docs = r.data.documents || [];
      if (!docs.length) { $('#register-body').innerHTML = '<tr><td colspan="8" class="text-center text-muted py-4">Chưa có văn bản</td></tr>'; return; }
      $('#register-body').innerHTML = docs.map((d, i) => `<tr>
        <td style="text-align:center">${i+1}</td>
        <td>${esc(d.ten_giai_doan||'—')}</td>
        <td><span class="role-badge user">${esc(d.loai_van_ban||d.loai_tai_lieu)}</span></td>
        <td><strong>${esc(d.so_van_ban||'—')}</strong></td>
        <td><div style="font-weight:500">${esc(d.ten_tai_lieu)}</div><div style="font-size:11px;color:var(--text-muted)">${esc(d.ma_doc)}</div></td>
        <td>${esc(d.nguoi_duyet_name||'—')}</td>
        <td style="font-size:12.5px">${d.ngay_ky?fmtDate(d.ngay_ky):'—'}</td>
        <td>${statusBadge(d.trang_thai)}</td>
      </tr>`).join('');
    };
  }

  $('#btn-export-register')?.addEventListener('click', () => {
    const pid = $('#reg-project-filter')?.value;
    if (!pid) { Toast.warning('Vui lòng chọn dự án.'); return; }
    App.exportProject(pid);
  });

  // ── Dropbox Status ──
  async function loadDropboxStatus() {
    const area = $('#dropbox-status-area');
    if (!area) return;
    try {
      const token = localStorage.getItem('esign_token') || sessionStorage.getItem('esign_token');
      const resp = await fetch('/api/dropbox/status', { headers: { 'Authorization': 'Bearer ' + token } });
      const res = await resp.json();
      if (!res.success) { area.innerHTML = `<div class="text-muted">${esc(res.error)}</div>`; return; }
      const d = res.data;
      if (d.configured) {
        area.innerHTML = `
          <div class="otp-status enabled" style="margin-bottom:12px"><i class="bi bi-cloud-check"></i> Dropbox đã kết nối</div>
          <div style="font-size:13px;color:var(--text-secondary);margin-bottom:8px">Tài liệu trình ký được lưu vào Dropbox của lãnh đạo.</div>
          <div style="font-size:12px;margin-bottom:6px"><strong>Thư mục:</strong> <code>${esc(d.folder)}</code></div>
          ${d.sharedLink ? `<a href="${esc(d.sharedLink)}" target="_blank" class="btn-outline-custom" style="margin-top:8px"><i class="bi bi-box-arrow-up-right"></i> Mở thư mục Dropbox</a>` : ''}`;
      } else {
        area.innerHTML = `
          <div class="otp-status disabled" style="margin-bottom:12px"><i class="bi bi-cloud-slash"></i> Dropbox chưa kết nối</div>
          <div style="font-size:13px;color:var(--text-secondary);margin-bottom:12px">Tài liệu đang được lưu trữ cục bộ trên server. Để lưu vào Dropbox của lãnh đạo, cần cấu hình token.</div>
          <div style="background:#F8FAFD;border:1px solid var(--card-border);border-radius:8px;padding:14px;font-size:12.5px;line-height:1.8">
            <strong>Hướng dẫn cấu hình:</strong><br>
            1. Truy cập <a href="https://www.dropbox.com/developers/apps" target="_blank">dropbox.com/developers/apps</a><br>
            2. Tạo App mới → Chọn "Full Dropbox"<br>
            3. Tab Permissions → Bật: files.content.write, files.content.read, sharing.write<br>
            4. Tab Settings → Generate access token<br>
            5. Thêm token vào file <code>.env</code> trên server:<br>
            <code style="display:block;background:#1F2937;color:#E5E7EB;padding:8px 12px;border-radius:6px;margin-top:4px">DROPBOX_ACCESS_TOKEN=sl.xxxxxxxxxxxxx</code>
          </div>`;
      }
    } catch { area.innerHTML = '<div class="text-muted">Không thể kiểm tra trạng thái Dropbox.</div>'; }
  }

  // Gọi loadDropboxStatus khi vào trang settings
  const _origLoadSettings = loadOtpSettings;
  async function loadSettingsPage() { await _origLoadSettings(); await loadDropboxStatus(); }
  // Patch navigateTo
  const _origNav = navigateTo;
  navigateTo = function(page) {
    _origNav(page);
    if (page === 'settings') { loadDropboxStatus(); loadSignatureSettings(); }
  };

  // ── Chữ ký số: ảnh chữ ký tay + con dấu ──
  let _sigImage = null, _sealImage = null; // data URL hiện tại

  async function loadSignatureSettings() {
    try {
      const r = await _fetchAuth('/api/users/me/signature');
      if (!r.success) return;
      _sigImage = r.data.chu_ky_image || null;
      _sealImage = r.data.con_dau_image || null;
      _renderSigPreview('sig', _sigImage);
      _renderSigPreview('seal', _sealImage);
    } catch {}
  }

  function _renderSigPreview(kind, dataUrl) {
    const img = $(`#${kind}-preview`), empty = $(`#${kind}-empty`);
    if (!img) return;
    if (dataUrl) { img.src = dataUrl; img.style.display = 'block'; if (empty) empty.style.display = 'none'; }
    else { img.removeAttribute('src'); img.style.display = 'none'; if (empty) empty.style.display = 'block'; }
  }

  // Nén ảnh về PNG ≤ maxW để giữ nền trong & dung lượng nhỏ
  function _fileToPng(file, maxW = 600) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => {
        const im = new Image();
        im.onload = () => {
          const scale = Math.min(1, maxW / im.width);
          const c = document.createElement('canvas');
          c.width = Math.round(im.width * scale); c.height = Math.round(im.height * scale);
          c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/png'));
        };
        im.onerror = () => reject(new Error('Ảnh không hợp lệ'));
        im.src = fr.result;
      };
      fr.onerror = () => reject(new Error('Không đọc được file'));
      fr.readAsDataURL(file);
    });
  }

  document.addEventListener('change', async (e) => {
    if (e.target.id === 'sig-file' || e.target.id === 'seal-file') {
      const f = e.target.files[0]; if (!f) return;
      try {
        const dataUrl = await _fileToPng(f);
        if (e.target.id === 'sig-file') { _sigImage = dataUrl; _renderSigPreview('sig', dataUrl); }
        else { _sealImage = dataUrl; _renderSigPreview('seal', dataUrl); }
      } catch (err) { Toast.error(err.message); }
    }
  });

  document.addEventListener('click', async (e) => {
    if (e.target.closest('#btn-save-signature')) {
      const r = await _fetchAuth('/api/users/me/signature', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chu_ky_image: _sigImage || '', con_dau_image: _sealImage || '' }),
      });
      if (r.success) Toast.success('Đã lưu chữ ký số.'); else Toast.error(r.error || 'Lỗi lưu.');
    }
    if (e.target.closest('#btn-clear-signature')) {
      _sigImage = null; _sealImage = null;
      _renderSigPreview('sig', null); _renderSigPreview('seal', null);
      const sf = $('#sig-file'), slf = $('#seal-file'); if (sf) sf.value = ''; if (slf) slf.value = '';
      const r = await _fetchAuth('/api/users/me/signature', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chu_ky_image: '', con_dau_image: '' }),
      });
      if (r.success) Toast.success('Đã xoá ảnh chữ ký.');
    }
  });

  // ── Init ──
  if(API.isLoggedIn()) showDashboard(); else showLogin();
})();
