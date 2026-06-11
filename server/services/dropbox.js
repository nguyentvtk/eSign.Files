/* ═══════════════════════════════════════════════════════════
   DROPBOX SERVICE — Lưu trữ tài liệu trong tài khoản LÃNH ĐẠO
   ─────────────────────────────────────────────────────────
   Hỗ trợ 2 cơ chế auth:
     1. Access Token tĩnh (DROPBOX_ACCESS_TOKEN) — short-lived 4h
     2. Refresh Token flow (DROPBOX_REFRESH_TOKEN + APP_KEY + APP_SECRET)
        → tự động lấy access_token mới khi hết hạn

   Khi token hết hạn (401), service sẽ:
     • Nếu có refresh_token → tự refresh và retry
     • Nếu chỉ có static token → fallback local + log warning
═══════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const config = require('../config');

const STATIC_TOKEN = process.env.DROPBOX_ACCESS_TOKEN || '';
const REFRESH_TOKEN = process.env.DROPBOX_REFRESH_TOKEN || '';
const APP_KEY = process.env.DROPBOX_APP_KEY || '';
const APP_SECRET = process.env.DROPBOX_APP_SECRET || '';
const DROPBOX_FOLDER = process.env.DROPBOX_FOLDER || '/eSign/TaiLieuTrinhKy';
const DROPBOX_SHARED_LINK = process.env.DROPBOX_SHARED_LINK || '';

let _activeToken = STATIC_TOKEN;
let _tokenExpiresAt = 0;     // ms epoch

function isConfigured() {
  return !!STATIC_TOKEN || !!(REFRESH_TOKEN && APP_KEY && APP_SECRET);
}

function getSharedFolderLink() {
  return DROPBOX_SHARED_LINK;
}

/* ── Token refresh ───────────────────────────────────── */
async function _refreshAccessToken() {
  if (!REFRESH_TOKEN || !APP_KEY || !APP_SECRET) {
    throw new Error('Refresh token chưa được cấu hình (cần DROPBOX_REFRESH_TOKEN + DROPBOX_APP_KEY + DROPBOX_APP_SECRET)');
  }
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: REFRESH_TOKEN,
    client_id: APP_KEY,
    client_secret: APP_SECRET,
  });
  const resp = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Refresh token failed: HTTP ${resp.status} ${txt}`);
  }
  const data = await resp.json();
  _activeToken = data.access_token;
  _tokenExpiresAt = Date.now() + (data.expires_in || 14400) * 1000 - 60000; // buffer 1 phút
  console.log('[Dropbox] Access token refreshed, expires in', data.expires_in, 's');
  return _activeToken;
}

async function _getValidToken(forceRefresh = false) {
  // Nếu có refresh_token và token sắp hết hạn → refresh
  if ((forceRefresh || Date.now() >= _tokenExpiresAt) && REFRESH_TOKEN && APP_KEY && APP_SECRET) {
    try { await _refreshAccessToken(); } catch (e) { console.error('[Dropbox refresh]', e.message); }
  }
  return _activeToken;
}

/* ── Dropbox API wrapper với auto-retry on 401 ────── */
async function _dropboxApiCall(url, options, isUpload = false) {
  let token = await _getValidToken();
  if (!token) throw new Error('No Dropbox token');

  let resp = await _doCall(url, options, token);

  // Nếu 401, thử refresh và retry 1 lần
  if (resp.status === 401 && REFRESH_TOKEN && APP_KEY && APP_SECRET) {
    console.log('[Dropbox] 401 — refresh token và retry');
    try {
      token = await _refreshAccessToken();
      resp = await _doCall(url, options, token);
    } catch (e) {
      console.error('[Dropbox] Refresh failed:', e.message);
    }
  }
  return resp;
}

function _doCall(url, options, token) {
  const headers = { ...(options.headers || {}), 'Authorization': `Bearer ${token}` };
  return fetch(url, { ...options, headers });
}

/* ── Upload file ──────────────────────────────────── */
async function uploadFile(localPath, remoteName, subfolder = '') {
  if (!isConfigured()) {
    return _localFallback(localPath, remoteName, subfolder);
  }
  const fileData = fs.readFileSync(localPath);
  const monthFolder = new Date().toISOString().slice(0, 7);
  const dropboxPath = `${DROPBOX_FOLDER}/${monthFolder}/${subfolder}/${remoteName}`.replace(/\/+/g, '/');

  try {
    const resp = await _dropboxApiCall('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        'Dropbox-API-Arg': JSON.stringify({ path: dropboxPath, mode: 'add', autorename: true, mute: false }),
        'Content-Type': 'application/octet-stream',
      },
      body: fileData,
    }, true);

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('[Dropbox] Upload failed:', resp.status, errText);
      return _localFallback(localPath, remoteName, subfolder);
    }
    const result = await resp.json();
    const shareLink = await createShareLink(result.path_display);
    return {
      dropboxPath: result.path_display,
      url: shareLink || `dropbox://${result.path_display}`,
      size: result.size,
      name: result.name,
    };
  } catch (err) {
    console.error('[Dropbox] Upload error:', err.message);
    return _localFallback(localPath, remoteName, subfolder);
  }
}

/* ── Share link ───────────────────────────────────── */
async function createShareLink(dropboxPath) {
  if (!isConfigured()) return '';
  try {
    const resp = await _dropboxApiCall('https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: dropboxPath,
        settings: { requested_visibility: 'public', audience: 'public' },
      }),
    });

    if (resp.ok) {
      const data = await resp.json();
      return data.url.replace('?dl=0', '?dl=1');
    }
    const errBody = await resp.json().catch(() => ({}));
    if (errBody?.error?.shared_link_already_exists) {
      return errBody.error.shared_link_already_exists.metadata.url.replace('?dl=0', '?dl=1');
    }
  } catch (e) {
    console.error('[Dropbox] Share link error:', e.message);
  }
  return '';
}

/* ── Account info ─────────────────────────────────── */
async function getAccountInfo() {
  if (!isConfigured()) return null;
  try {
    const resp = await _dropboxApiCall('https://api.dropboxapi.com/2/users/get_current_account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'null',
    });
    if (resp.ok) return resp.json();
  } catch {}
  return null;
}

/* ── Local fallback ───────────────────────────────── */
function _localFallback(localPath, remoteName, subfolder) {
  const monthFolder = new Date().toISOString().slice(0, 7);
  const dir = path.join(config.upload.dir, 'files', monthFolder, subfolder || '');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, remoteName);
  fs.copyFileSync(localPath, dest);
  const relPath = path.relative(config.upload.dir, dest);
  return {
    dropboxPath: '',
    url: `/uploads/${relPath}`,
    size: fs.statSync(dest).size,
    name: remoteName,
  };
}

module.exports = {
  uploadFile,
  createShareLink,
  isConfigured,
  getAccountInfo,
  getSharedFolderLink,
  refreshAccessToken: _refreshAccessToken,
};
