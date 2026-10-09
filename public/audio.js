// Browser-side audio preparation: decode any audio/video file, convert it to
// 16 kHz mono, and cut it into WAV pieces small enough for the API.

export const SAMPLE_RATE = 16000;
export const CHUNK_SECONDS = 300;
const SEARCH_SECONDS = 15; // look this far back for a quiet spot to cut at

export async function decodeToMono(file) {
  const data = await file.arrayBuffer();
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Ctx) throw new Error('הדפדפן הזה לא תומך בעיבוד שמע. נסה Chrome, Edge, Firefox או Safari עדכני.');
  let ctx;
  try { ctx = new Ctx(1, SAMPLE_RATE, SAMPLE_RATE); }
  catch { ctx = new Ctx(1, 44100, 44100); } // old Safari: decode at 44.1k and resample below

  const buffer = await new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(data, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });

  let mono;
  if (buffer.numberOfChannels === 1) {
    mono = buffer.getChannelData(0);
  } else {
    mono = new Float32Array(buffer.length);
    const n = buffer.numberOfChannels;
    for (let c = 0; c < n; c++) {
      const ch = buffer.getChannelData(c);
      for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / n;
    }
  }
  return buffer.sampleRate === SAMPLE_RATE ? mono : resample(mono, buffer.sampleRate, SAMPLE_RATE);
}

function resample(input, from, to) {
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

// Returns [{ start, end, seconds }] in samples, cutting at quiet moments.
export function planChunks(samples) {
  const target = CHUNK_SECONDS * SAMPLE_RATE;
  const chunks = [];
  let start = 0;
  while (samples.length - start > target) {
    const cut = quietestPoint(samples, start + target - SEARCH_SECONDS * SAMPLE_RATE, start + target);
    chunks.push({ start, end: cut });
    start = cut;
  }
  if (samples.length > start) chunks.push({ start, end: samples.length });
  return chunks
    .map(c => ({ ...c, seconds: (c.end - c.start) / SAMPLE_RATE }))
    .filter(c => c.seconds >= 0.3 && !isSilent(samples, c.start, c.end));
}

function quietestPoint(samples, from, to) {
  const frame = SAMPLE_RATE / 10; // 100 ms
  let best = to, bestEnergy = Infinity;
  for (let f = from; f + frame <= to; f += frame / 2) {
    let e = 0;
    for (let i = f; i < f + frame; i += 4) e += samples[i] * samples[i];
    if (e < bestEnergy) { bestEnergy = e; best = f + frame / 2; }
  }
  return Math.round(best);
}

function isSilent(samples, start, end) {
  let peak = 0, sum = 0, n = 0;
  for (let i = start; i < end; i += 8) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
    sum += a * a;
    n++;
  }
  return peak < 0.02 && Math.sqrt(sum / Math.max(1, n)) < 0.001;
}

export function encodeWav(samples, start, end) {
  const n = end - start;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SAMPLE_RATE, true); v.setUint32(28, SAMPLE_RATE * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  const pcm = new Int16Array(buf, 44, n);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[start + i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return new Blob([buf], { type: 'audio/wav' });
}
