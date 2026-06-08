/**
 * Cloudflare Worker — eSign VGCA FileUploadHandler proxy.
 *
 * Routes:
 *   GET  /vgca/:fileId/:maTL  → tải PDF gốc từ Drive (hoặc fallback qua GAS) → trả binary cho VGCASignService
 *   POST /vgca/:fileId/:maTL  → nhận PDF đã ký → chuyển về GAS doPost
 *   GET  /                    → health check
 *
 * Environment variables (Cloudflare Worker Settings > Variables):
 *   GAS_WEB_APP_URL  — URL Web App GAS (https://script.google.com/macros/s/.../exec)
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/' || url.pathname === '') {
      return new Response('eSign VGCA proxy OK', { status: 200 });
    }

    // Parse /vgca/:fileId/:maTL
    const match = url.pathname.match(/^\/vgca\/([^/]+)\/([^/]*)$/);
    if (!match) {
      return new Response('Not found', { status: 404 });
    }

    const fileId = decodeURIComponent(match[1]);
    const maTL = decodeURIComponent(match[2]);

    if (request.method === 'GET') {
      return handleDownload(fileId, maTL, env);
    }
    if (request.method === 'POST') {
      return handleUpload(request, fileId, maTL, env);
    }

    return new Response('Method not allowed', { status: 405 });
  },
};

async function handleDownload(fileId, maTL, env) {
  // Thử tải trực tiếp từ Google Drive
  const driveUrls = [
    `https://drive.usercontent.google.com/download?id=${fileId}&export=download&authuser=0&confirm=t`,
    `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`,
  ];

  for (const driveUrl of driveUrls) {
    try {
      const resp = await fetch(driveUrl, {
        redirect: 'follow',
        headers: { 'User-Agent': 'VGCASignService/1.0' },
      });

      if (resp.ok) {
        const ct = resp.headers.get('content-type') || '';
        // Kiểm tra có phải PDF thật (tránh nhận trang HTML xác nhận của Google)
        if (ct.includes('application/pdf') || ct.includes('application/octet-stream')) {
          const body = await resp.arrayBuffer();
          return buildPdfResponse(body, maTL);
        }
        // Nếu nhận HTML (trang xác nhận) → thử URL tiếp theo
      }
    } catch (_) {
      // Bỏ qua, thử URL tiếp
    }
  }

  // Fallback: tải qua GAS doGet (base64)
  if (env.GAS_WEB_APP_URL) {
    try {
      const gasUrl = env.GAS_WEB_APP_URL + '?action=vgca_download&fileId=' + encodeURIComponent(fileId);
      const gasResp = await fetch(gasUrl, { redirect: 'follow' });

      if (gasResp.ok) {
        const text = await gasResp.text();
        if (text.startsWith('ERROR:')) {
          return new Response(JSON.stringify({ Status: 1, Message: text }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        // Decode base64 → binary
        const binary = Uint8Array.from(atob(text), c => c.charCodeAt(0));
        return buildPdfResponse(binary.buffer, maTL);
      }
    } catch (_) {
      // Fallback cũng thất bại
    }
  }

  return new Response(
    JSON.stringify({ Status: 1, Message: 'Không tải được file từ Drive. FileId: ' + fileId }),
    { status: 502, headers: { 'Content-Type': 'application/json' } },
  );
}

async function handleUpload(request, fileId, maTL, env) {
  const gasUrl = env.GAS_WEB_APP_URL;
  if (!gasUrl) {
    return new Response(
      JSON.stringify({ Status: 1, Message: 'Chưa cấu hình GAS_WEB_APP_URL.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  try {
    const body = await request.arrayBuffer();
    const b64 = arrayBufferToBase64(body);

    const params = new URLSearchParams();
    params.set('filedata', b64);
    params.set('encoding', 'base64');
    params.set('filename', (maTL || 'signed') + '.pdf');
    params.set('maTL', maTL);
    params.set('fileId', fileId);

    const gasResp = await fetch(gasUrl, {
      method: 'POST',
      body: params.toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      redirect: 'follow',
    });

    const result = await gasResp.text();
    return new Response(result, {
      status: gasResp.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ Status: 1, Message: 'Lỗi chuyển file ký về GAS: ' + err.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
}

function buildPdfResponse(arrayBuffer, maTL) {
  const filename = (maTL || 'document') + '.pdf';
  return new Response(arrayBuffer, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(arrayBuffer.byteLength),
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-cache, no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    },
  });
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
