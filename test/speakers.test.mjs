// The browser side of "by speaker": the first piece goes alone, then the clips of its voices go with the rest,
// and the turns are numbered by who spoke first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcribeBySpeaker } from '../public/speakers.js';
import { speakersOf, buildDoc, buildDocx, fmtTime, plainText } from '../public/export.js';
import { SAMPLE_RATE } from '../public/audio.js';

const samples = new Float32Array(SAMPLE_RATE * 40).fill(0.2);
const chunks = [{ start: 0, end: SAMPLE_RATE * 20 }, { start: SAMPLE_RATE * 20, end: SAMPLE_RATE * 40 }];

test('the first piece goes alone; the others carry clips of the voices found in it', async () => {
  const seen = [];
  const upload = async (blob, refs) => {
    seen.push(refs.map(r => r.name));
    if (!seen.length || seen.length === 1) {
      return { usedKnown: false, segments: [{ speaker: 'A', start: 0, end: 6, text: 'שלום' }, { speaker: 'B', start: 6, end: 9, text: 'היי' }, { speaker: 'A', start: 9, end: 12, text: 'מה נשמע' }] };
    }
    // in the second piece OpenAI answers with the names it was given, and one new voice
    return { usedKnown: true, segments: [{ speaker: 'spk2', start: 1, end: 4, text: 'טוב' }, { speaker: 'A', start: 5, end: 9, text: 'אני חדש' }, { speaker: 'spk1', start: 10, end: 14, text: 'יופי' }] };
  };
  const r = await transcribeBySpeaker({ chunks, samples, upload });
  assert.deepEqual(seen[0], [], 'nothing known yet');
  assert.deepEqual(seen[1].sort(), ['spk1', 'spk2'], 'a clip for each voice of the first piece');
  assert.equal(r.speakers, 3);
  assert.equal(r.stopped, null);
  assert.equal(r.inconsistent, false);
  assert.equal(r.text, [
    'דובר 1 · 00:00\nשלום', 'דובר 2 · 00:06\nהיי', 'דובר 1 · 00:09\nמה נשמע',
    'דובר 2 · 00:21\nטוב', 'דובר 3 · 00:25\nאני חדש', 'דובר 1 · 00:30\nיופי',
  ].join('\n\n'));
  assert.deepEqual(speakersOf(r.text), ['דובר 1', 'דובר 2', 'דובר 3']);
});

test('one speaker twice in a row is one turn; a refusal of the clips is reported; a failure keeps what there is', async () => {
  let calls = 0;
  const upload = async () => {
    calls++;
    if (calls === 1) return { usedKnown: false, segments: [{ speaker: 'A', start: 0, end: 5, text: 'אחד' }, { speaker: 'A', start: 5, end: 9, text: 'שניים' }] };
    return { usedKnown: false, segments: [{ speaker: 'A', start: 0, end: 4, text: 'שלוש' }] };
  };
  const r = await transcribeBySpeaker({ chunks, samples, upload });
  assert.equal(r.inconsistent, true, 'OpenAI did not take the clips, so the voices of the pieces may not match');
  assert.match(r.text, /^דובר 1 · 00:00\nאחד שניים\n\nדובר 2 · 00:20\nשלוש$/);
  calls = 0;
  const failing = async () => { if (++calls > 1) throw new Error('boom'); return { usedKnown: false, segments: [{ speaker: 'A', start: 0, end: 5, text: 'אחד' }] }; };
  const p = await transcribeBySpeaker({ chunks, samples, upload: failing });
  assert.equal(p.stopped.message, 'boom');
  assert.match(p.text, /אחד/);
  const dead = await transcribeBySpeaker({ chunks, samples, upload: async () => { throw new Error('no'); } });
  assert.equal(dead.text, '');
  assert.equal(dead.stopped.message, 'no');
});

test('a short recording (one piece) works without clips', async () => {
  const r = await transcribeBySpeaker({ chunks: [chunks[0]], samples, upload: async (b, refs) => { assert.deepEqual(refs, []); return { segments: [{ speaker: 'A', start: 0, end: 5, text: 'רק אחד' }] }; } });
  assert.equal(r.text, 'דובר 1 · 00:00\nרק אחד');
});

test('export: the model, plain text, and a valid Word file', async () => {
  const text = 'דובר 1 · 00:00\nשלום **עולם** & <b>\n\nדובר 2 · 1:02:03\nהיי';
  const doc = buildDoc('transcript', text, { title: 'שיעור "1"', seconds: 4000 });
  assert.deepEqual(doc.blocks.map(b => b.t), ['turn', 'turn']);
  assert.equal(doc.blocks[1].time, '1:02:03');
  assert.match(doc.meta.map(m => m.join('=')).join('|'), /משך=1 שעות ו-7 דקות/);
  assert.equal(fmtTime(3725), '1:02:05');
  assert.match(plainText(doc), /^דובר 1 · 00:00\nשלום \*\*עולם\*\* & <b>/, 'a transcript keeps its asterisks');
  assert.equal(plainText(buildDoc('summary', '- **נקודה** א', {})), '• נקודה א');
  const bytes = await buildDocx(doc);
  assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 3, 4], 'a zip');
  const plain = buildDoc('transcript', 'שורה אחת\nשורה שתיים', { title: 'x' });
  assert.deepEqual(plain.blocks.map(b => b.t), ['p', 'p']);
  const sum = buildDoc('summary', '# כותרת\n- **נקודה** א\n1. ב\nפסקה', { title: 's' });
  assert.deepEqual(sum.blocks.map(b => b.t), ['h', 'li', 'li', 'p']);
});

import { splitForTranslation, batchParts, translateText, estimateCredits } from '../public/translate.js';

test('translation: the parts keep the speakers and times, long parts are cut and joined, batches stay small', async () => {
  const text = 'דובר 1 · 00:00\nשלום לכולם\n\nדובר 2 · 00:05\nמה נשמע\n\nדנה · 00:09\nטוב';
  const { parts, rebuild } = splitForTranslation(text, 'en');
  assert.deepEqual(parts, ['שלום לכולם', 'מה נשמע', 'טוב']);
  assert.equal(rebuild(['Hello everyone', "How's it going", 'Good']), 'Speaker 1 · 00:00\nHello everyone\n\nSpeaker 2 · 00:05\nHow\'s it going\n\nדנה · 00:09\nGood');
  // plain text: line by line, blank lines stay
  const plain = splitForTranslation('שורה א\n\nשורה ב', 'fr');
  assert.deepEqual(plain.parts, ['שורה א', 'שורה ב']);
  assert.equal(plain.rebuild(['Ligne A', 'Ligne B']), 'Ligne A\n\nLigne B');
  // a very long line is cut at sentence ends and joined again
  const long = ('זה משפט ארוך אחד. ').repeat(600).trim();
  const l = splitForTranslation(long, 'en');
  assert.ok(l.parts.length > 1 && l.parts.every(p => p.length <= 5000));
  assert.equal(l.rebuild(l.parts), long);
  // batches
  const many = Array.from({ length: 10 }, () => 'א'.repeat(3000));
  assert.deepEqual(batchParts(many).map(b => b.length), [2, 2, 2, 2, 2]);
  assert.ok(estimateCredits(54000) > 5);
  // the whole run: three requests at most in parallel, in order
  let calls = 0;
  const r = await translateText({ text: many.map((m, i) => i + m).join('\n'), to: 'en', send: async items => { calls++; return { items: items.map(x => 'T' + x.slice(0, 1)), credits: 2 }; } });
  assert.equal(calls, 5);
  assert.equal(r.credits, 10);
  assert.equal(r.stopped, null);
  assert.equal(r.text.split('\n').join(' '), '0 T1 T2 T3 T4 T5 T6 T7 T8 T9'.replace('0 ', 'T0 '));
  // a failure keeps the rest in the original language
  let n = 0;
  const f = await translateText({ text: many.join('\n'), to: 'en', concurrency: 1, send: async items => { if (++n > 1) throw new Error('boom'); return { items: items.map(() => 'X'), credits: 1 }; } });
  assert.equal(f.stopped.message, 'boom');
  assert.equal(f.translated, 2);
});
