// Sends the transcript as a .txt attachment to the signed-in user, through reem.bi
// (one Resend account for all sites; the sender address is set in the reem.bi admin).

function toBase64(text) {
  const bytes = new TextEncoder().encode('﻿' + text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function sendTranscriptEmail(env, { authorization, text, filename }) {
  const base = filename.replace(/\.[^.]+$/, '') || 'transcript';
  const preview = text.length > 3000 ? text.slice(0, 3000) + '…' : text;
  const res = await fetch((env.SSO_URL || 'https://login.reembir.com') + '/api/email/me', {
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subject: 'התמלול שלך: ' + base,
      html: `<div dir="rtl" style="font-family:Arial,sans-serif;line-height:1.6">
        <p>שלום,</p>
        <p>התמלול של <b>${escapeHtml(base)}</b> מצורף לקובץ הזה כקובץ טקסט.</p>
        <hr><div style="white-space:pre-wrap">${escapeHtml(preview)}</div></div>`,
      text: 'התמלול מצורף כקובץ טקסט.\n\n' + preview,
      attachments: [{ filename: base + '.txt', content: toBase64(text) }],
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    const err = new Error('שליחת המייל נכשלה: ' + (data?.message || res.status));
    err.status = 502;
    throw err;
  }
}
