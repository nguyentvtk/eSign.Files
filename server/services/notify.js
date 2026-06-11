/* ═══════════════════════════════════════════════════════════
   Notification service — Telegram + Email
═══════════════════════════════════════════════════════════ */

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TELEGRAM_TOPIC_ID = process.env.TELEGRAM_TOPIC_ID || '';

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';

async function sendTelegram(text, opts = {}) {
  if (!TELEGRAM_TOKEN) return { sent: false, reason: 'no-token' };
  try {
    const body = {
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...opts,
    };
    if (TELEGRAM_TOPIC_ID) body.message_thread_id = parseInt(TELEGRAM_TOPIC_ID);

    const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (data.ok) {
      console.log(`[Telegram] ✓ Sent message_id=${data.result?.message_id}`);
    } else {
      console.error(`[Telegram] ✗ Error: ${data.description || JSON.stringify(data)}`);
    }
    return { sent: !!data.ok, response: data };
  } catch (e) {
    console.error('[Telegram] error:', e.message);
    return { sent: false, error: e.message };
  }
}

async function sendEmail(to, subject, html) {
  // Stub: chỉ log nếu chưa cấu hình SMTP (cho MVP). Có thể tích hợp nodemailer khi cần.
  if (!SMTP_HOST) {
    console.log(`[Email->Stub] To=${to} | ${subject}`);
    return { sent: false, reason: 'no-smtp' };
  }
  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
    await transporter.sendMail({ from: SMTP_USER, to, subject, html });
    return { sent: true };
  } catch (e) {
    console.error('[Email] error:', e.message);
    return { sent: false, error: e.message };
  }
}

/**
 * Thông báo tài liệu mới được gửi trình ký.
 * Gửi cả Telegram + Email cho người gửi & người duyệt.
 */
async function notifyDocumentSubmitted({ doc, sender, approver, projectName, phaseName }) {
  const msg = `📋 <b>Tài liệu trình ký mới</b>
━━━━━━━━━━━━━━━
🔹 <b>Mã VB:</b> <code>${doc.ma_doc}</code>
🔹 <b>Số văn bản:</b> ${escapeHtml(doc.so_van_ban || '—')}
🔹 <b>Tên:</b> ${escapeHtml(doc.ten_tai_lieu)}
🔹 <b>Loại:</b> ${escapeHtml(doc.loai_van_ban || doc.loai_tai_lieu)}
${projectName ? `🔹 <b>Dự án:</b> ${escapeHtml(projectName)}\n` : ''}${phaseName ? `🔹 <b>Giai đoạn:</b> ${escapeHtml(phaseName)}\n` : ''}🔹 <b>Người gửi:</b> ${escapeHtml(sender?.ho_ten)} (${escapeHtml(sender?.ma_nv)})
🔹 <b>Người duyệt:</b> ${escapeHtml(approver?.ho_ten || 'Chưa chỉ định')}
🔹 <b>Trạng thái:</b> ⏳ <i>Chờ ký</i>
━━━━━━━━━━━━━━━
🕒 ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`;

  const tg = await sendTelegram(msg);

  const emailHtml = `<h3>Tài liệu trình ký mới</h3>
<p><b>Mã VB:</b> ${escapeHtml(doc.ma_doc)}<br>
<b>Số VB:</b> ${escapeHtml(doc.so_van_ban || '—')}<br>
<b>Tên tài liệu:</b> ${escapeHtml(doc.ten_tai_lieu)}<br>
<b>Loại VB:</b> ${escapeHtml(doc.loai_van_ban || doc.loai_tai_lieu)}<br>
${projectName ? `<b>Dự án:</b> ${escapeHtml(projectName)}<br>` : ''}<b>Người gửi:</b> ${escapeHtml(sender?.ho_ten)}<br>
<b>Người duyệt:</b> ${escapeHtml(approver?.ho_ten || '')}<br>
<b>Trạng thái:</b> Chờ ký</p>`;

  const emails = [];
  if (sender?.email) emails.push(sendEmail(sender.email, `[eSign] Đã gửi tài liệu ${doc.ma_doc}`, emailHtml));
  if (approver?.email) emails.push(sendEmail(approver.email, `[eSign] Tài liệu mới chờ ký: ${doc.ma_doc}`, emailHtml));
  await Promise.all(emails);

  return { telegram: tg };
}

async function notifyDocumentSigned({ doc, sender, approver, status, reason }) {
  const emoji = status === 'Đã ký' ? '✅' : '❌';
  const action = status === 'Đã ký' ? 'đã được PHÊ DUYỆT & KÝ SỐ' : 'đã bị TỪ CHỐI';
  const msg = `${emoji} <b>Tài liệu ${action}</b>
━━━━━━━━━━━━━━━
🔹 <b>Mã VB:</b> <code>${doc.ma_doc}</code>
🔹 <b>Tên:</b> ${escapeHtml(doc.ten_tai_lieu)}
🔹 <b>Người duyệt:</b> ${escapeHtml(approver?.ho_ten)}
🔹 <b>Người gửi:</b> ${escapeHtml(sender?.ho_ten)}
${reason ? `🔹 <b>Lý do từ chối:</b> ${escapeHtml(reason)}\n` : ''}━━━━━━━━━━━━━━━
🕒 ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`;

  await sendTelegram(msg);

  const emailHtml = `<h3>Tài liệu ${escapeHtml(action)}</h3>
<p><b>Mã VB:</b> ${escapeHtml(doc.ma_doc)}<br>
<b>Tên:</b> ${escapeHtml(doc.ten_tai_lieu)}<br>
${reason ? `<b>Lý do:</b> ${escapeHtml(reason)}<br>` : ''}</p>`;

  if (sender?.email) await sendEmail(sender.email, `[eSign] ${doc.ma_doc} ${status}`, emailHtml);
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
}

module.exports = { sendTelegram, sendEmail, notifyDocumentSubmitted, notifyDocumentSigned };
