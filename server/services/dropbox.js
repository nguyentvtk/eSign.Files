const fs = require('fs');
const path = require('path');
const config = require('../config');

const DROPBOX_TOKEN = process.env.DROPBOX_ACCESS_TOKEN || '';
const DROPBOX_FOLDER = process.env.DROPBOX_FOLDER || '/eSign/TaiLieuTrinhKy';
const DROPBOX_SHARED_LINK = process.env.DROPBOX_SHARED_LINK || '';

function isConfigured() {
  return !!DROPBOX_TOKEN;
}

function getSharedFolderLink() {
  return DROPBOX_SHARED_LINK;
}

/**
 * Upload file lên Dropbox của lãnh đạo.
 * Cấu trúc thư mục:
 *   /eSign/TaiLieuTrinhKy/
 *     └── 2026-06/
 *         └── VB-2026-1234_NV001_NguyenVanA/
 *             ├── VanBan_TrinhKy.pdf          (file chính)
 *             ├── dinh-kem/
 *             │   ├── PhuLuc1.docx
 *             │   └── BangKe.pdf
 *             └── da-ky/
 *                 └── VB-2026-1234_signed.pdf  (file đã ký)
 */
async function uploadFile(localPath, remoteName, subfolder = '') {
  if (!isConfigured()) {
    return _localFallback(localPath, remoteName, subfolder);
  }

  const fileData = fs.readFileSync(localPath);
  const monthFolder = new Date().toISOString().slice(0, 7); // 2026-06
  const dropboxPath = `${DROPBOX_FOLDER}/${monthFolder}/${subfolder}/${remoteName}`.replace(/\/+/g, '/');

  try {
    const resp = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DROPBOX_TOKEN}`,
        'Dropbox-API-Arg': JSON.stringify({
          path: dropboxPath,
          mode: 'add',
          autorename: true,
          mute: false,
        }),
        'Content-Type': 'application/octet-stream',
      },
      body: fileData,
    });

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

async function createShareLink(dropboxPath) {
  if (!isConfigured()) return '';
  try {
    const resp = await fetch('https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DROPBOX_TOKEN}`,
        'Content-Type': 'application/json',
      },
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

async function getAccountInfo() {
  if (!isConfigured()) return null;
  try {
    const resp = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${DROPBOX_TOKEN}` },
    });
    if (resp.ok) return resp.json();
  } catch {}
  return null;
}

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

module.exports = { uploadFile, createShareLink, isConfigured, getAccountInfo, getSharedFolderLink };
