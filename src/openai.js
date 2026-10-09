// Forwards a WAV upload to OpenAI's transcription endpoint without buffering
// it: the multipart body is streamed straight from the browser's request.

export const MAX_UPLOAD_BYTES = 24 * 1024 * 1024; // OpenAI accepts up to 25 MB
const SAMPLE_RATE = 16000;

// Accepts only the exact format the site's browser code produces:
// PCM, 1 channel, 16 kHz, 16 bit, 44-byte header. Returns { seconds } or null.
export function parseWavHeader(head, totalLength) {
  if (head.byteLength < 44) return null;
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const tag = o => String.fromCharCode(head[o], head[o + 1], head[o + 2], head[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || tag(12) !== 'fmt ' || tag(36) !== 'data') return null;
  if (v.getUint32(16, true) !== 16) return null;          // fmt chunk size
  if (v.getUint16(20, true) !== 1) return null;           // PCM
  if (v.getUint16(22, true) !== 1) return null;           // mono
  if (v.getUint32(24, true) !== SAMPLE_RATE) return null;
  if (v.getUint16(34, true) !== 16) return null;          // bits per sample
  const dataSize = v.getUint32(40, true);
  if (dataSize !== totalLength - 44 || dataSize === 0) return null;
  return { seconds: dataSize / (SAMPLE_RATE * 2) };
}

export async function transcribeWav(env, { model, language, prompt, head, reader, body, length }) {
  const enc = new TextEncoder();
  const boundary = 'timlul' + crypto.randomUUID().replace(/-/g, '');
  const field = (name, value) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;

  let pre = field('model', model) + field('response_format', 'json');
  if (language) pre += field('language', language);
  if (prompt) pre += field('prompt', prompt);
  pre += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`;
  const preBytes = enc.encode(pre);
  const postBytes = enc.encode(`\r\n--${boundary}--\r\n`);

  const { readable, writable } = new FixedLengthStream(preBytes.byteLength + length + postBytes.byteLength);
  const pump = (async () => {
    let writer = writable.getWriter();
    await writer.write(preBytes);
    await writer.write(head);
    writer.releaseLock();
    reader.releaseLock();
    await body.pipeTo(writable, { preventClose: true });
    writer = writable.getWriter();
    await writer.write(postBytes);
    await writer.close();
  })().catch(e => {
    writable.abort(e).catch(() => {});
    throw new Error('ההעלאה נקטעה');
  });

  const request = fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.OPENAI_API_KEY,
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
    },
    body: readable,
  });
  const [res] = await Promise.all([request, pump]);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error('OpenAI: ' + (data?.error?.message || res.status));
  return (data?.text || '').trim();
}
