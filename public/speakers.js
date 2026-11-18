// Transcription by speaker, for a recording cut into pieces. OpenAI labels the voices inside one piece only ("A", "B"),
// so the first piece goes first: from the voices found in it a short clip of each (up to four) is cut out and sent with
// every other piece, which lets OpenAI call the same voice by the same name. A voice that appears only later gets a new
// number. At the end the numbers are renumbered by who spoke first, and the turns are written as the page shows them:
//
//   דובר 1 · 00:12
//   what they said
import { encodeWav, SAMPLE_RATE } from './audio.js';
import { fmtTime } from './export.js';

export const MAX_REFS = 4;
const CLIP_MAX = 8, CLIP_MIN = 1.6; // seconds; OpenAI wants 2 to 10 for a reference

function clipOf(samples, chunk, segs) {
  let best = null;
  for (const s of segs) if (s.end - s.start >= CLIP_MIN && (!best || s.end - s.start > best.end - best.start)) best = s;
  if (!best) return null;
  const from = chunk.start + Math.floor(best.start * SAMPLE_RATE);
  const to = Math.min(chunk.end, from + Math.floor(Math.min(best.end - best.start, CLIP_MAX) * SAMPLE_RATE));
  return to - from >= CLIP_MIN * SAMPLE_RATE ? encodeWav(samples, from, to) : null;
}

/**
 * chunks: [{ start, end }] in samples; upload(blob, refs: [{ name, blob }]) -> { segments: [{ speaker, start, end, text }], usedKnown }
 * onProgress(done, total). Returns { text, speakers, stopped, inconsistent }; `stopped` is the error that ended it early.
 */
export async function transcribeBySpeaker({ chunks, samples, upload, onProgress = () => {}, concurrency = 3 }) {
  const total = chunks.length;
  const turns = []; // { gid, start, end, text } with absolute seconds
  let nextGid = 1, done = 0, stopped = null, inconsistent = false;
  const add = (i, segments, gidOf) => {
    const offset = chunks[i].start / SAMPLE_RATE;
    for (const s of segments) turns.push({ gid: gidOf(s.speaker), start: offset + s.start, end: offset + s.end, text: s.text });
  };

  // the first piece, alone
  let refs = [];
  let first;
  try {
    first = await upload(encodeWav(samples, chunks[0].start, chunks[0].end), []);
  } catch (e) { return { text: '', speakers: 0, stopped: e, inconsistent }; }
  const firstIds = new Map(), spoken = new Map();
  for (const s of first.segments) {
    if (!firstIds.has(s.speaker)) firstIds.set(s.speaker, nextGid++);
    spoken.set(s.speaker, (spoken.get(s.speaker) || 0) + (s.end - s.start));
  }
  add(0, first.segments, label => firstIds.get(label));
  const byTime = [...spoken.entries()].sort((a, b) => b[1] - a[1]);
  for (const [label] of byTime) {
    const gid = firstIds.get(label);
    if (refs.length >= MAX_REFS || gid > 9 || total === 1) continue;
    const blob = clipOf(samples, chunks[0], first.segments.filter(s => s.speaker === label));
    if (blob) refs.push({ name: 'spk' + gid, blob, gid });
  }
  done = 1;
  onProgress(done, total);

  // the rest, a few at a time
  let next = 1;
  const worker = async () => {
    while (next < total && !stopped) {
      const i = next++;
      let r;
      try { r = await upload(encodeWav(samples, chunks[i].start, chunks[i].end), refs); } catch (e) { stopped = stopped || e; return; }
      if (refs.length && !r.usedKnown) inconsistent = true;
      const local = new Map();
      add(i, r.segments, label => {
        const m = /^spk([1-9])$/.exec(label);
        if (m && refs.some(x => x.gid === Number(m[1]))) return Number(m[1]);
        if (!local.has(label)) local.set(label, nextGid++);
        return local.get(label);
      });
      done++;
      onProgress(done, total);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(0, total - 1)) }, worker));

  // in the order of the talk; the same speaker one after the other is one turn; numbered by who spoke first
  turns.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const t of turns) {
    const last = merged.at(-1);
    if (last && last.gid === t.gid) { last.text += ' ' + t.text; last.end = t.end; } else merged.push({ ...t });
  }
  const numbers = new Map();
  for (const t of merged) if (!numbers.has(t.gid)) numbers.set(t.gid, numbers.size + 1);
  const text = merged.map(t => `דובר ${numbers.get(t.gid)} · ${fmtTime(t.start)}\n${t.text.trim()}`).join('\n\n');
  return { text, speakers: numbers.size, stopped, inconsistent };
}
