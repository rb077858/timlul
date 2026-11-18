// A YouTube link: the audio of the video, so that it can be transcribed like an uploaded file.
//
// A Cloudflare Worker can't download from YouTube itself (YouTube turns away data-center addresses, and the tool that
// does this, yt-dlp, is a program that needs a real machine). So a small download service runs somewhere else
// (tools/youtube-audio: a Dockerfile and a README for a few cheap hosts), and the Worker asks it for the audio:
//
//   YT_AUDIO_URL    the address of that service, e.g. https://yt-audio.example.com
//   YT_AUDIO_TOKEN  a secret both sides know (the service checks it, so only this site can use it)
//
// Without both, the site doesn't offer the YouTube option at all.

const HOSTS = /^(www\.|m\.|music\.)?youtube\.com$/;
const ID = /^[A-Za-z0-9_-]{11}$/;

export const youtubeConfigured = env => !!(env.YT_AUDIO_URL && env.YT_AUDIO_TOKEN);

/** The 11-character video id from any YouTube address (watch, youtu.be, shorts, live, embed), or null. */
export function videoId(input) {
  let u;
  try { u = new URL(String(input || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  let id = null;
  if (u.hostname === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (HOSTS.test(u.hostname)) {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else { const m = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/]+)/); id = m ? m[1] : null; }
  }
  return id && ID.test(id) ? id : null;
}

const MAX_BYTES = 180 * 1024 * 1024; // the audio stream of a couple of hours, the lowest quality that is still clear

/** Fetches the audio. maxSeconds: refuse videos longer than what the user could transcribe (0 = no limit from the quota).
 *  Returns { body, headers } or { error, code, status }. */
export async function youtubeAudio(env, input, maxSeconds = 0) {
  const id = videoId(input);
  if (!id) return { error: 'זה לא נראה כמו קישור לסרטון ביוטיוב', code: 'bad_url', status: 400 };
  let res;
  try {
    const q = new URLSearchParams({ v: id });
    if (maxSeconds > 0) q.set('max', String(maxSeconds));
    res = await fetch(`${String(env.YT_AUDIO_URL).replace(/\/+$/, '')}/audio?${q}`, { headers: { Authorization: 'Bearer ' + env.YT_AUDIO_TOKEN } });
  } catch {
    return { error: 'שירות ההורדה לא זמין כרגע. נסו שוב בעוד כמה דקות', code: 'youtube_down', status: 502 };
  }
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    const code = data?.error || 'youtube';
    const messages = {
      too_long: 'הסרטון ארוך ממה שנשאר לכם במכסה, או ארוך מדי (עד שעתיים)',
      private: 'הסרטון פרטי, חסום באזור או דורש התחברות, ואי אפשר להביא אותו',
      live: 'אי אפשר לתמלל שידור חי. אפשר אחרי שהוא מסתיים',
      unavailable: 'הסרטון לא זמין (נמחק, פרטי או חסום)',
    };
    return { error: messages[code] || data?.message || 'לא הצלחנו להביא את הסרטון', code, status: res.status === 401 || res.status === 403 ? 502 : res.status >= 500 ? 502 : 422 };
  }
  const length = Number(res.headers.get('content-length'));
  if (length > MAX_BYTES) { res.body?.cancel().catch(() => {}); return { error: 'הסרטון גדול מדי', code: 'too_large', status: 413 }; }
  const headers = { 'Content-Type': res.headers.get('content-type') || 'audio/mp4' };
  for (const h of ['content-length', 'x-title', 'x-duration']) if (res.headers.get(h)) headers[h] = res.headers.get(h);
  return { body: res.body, headers };
}
