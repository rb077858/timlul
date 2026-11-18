// Translating a transcript into another language. The text is cut into parts (a speaker's turn, or a line), sent a few
// thousand characters at a time, and put back together in the same shape, so speakers and times stay where they are.
// Paid from the minutes quota by what it cost (src/translate.js).
import { SPEAKER_HEAD, RTL_LANGS, buildDoc } from './export.js';

export const SPEAKER_WORD = {
  he: 'דובר', en: 'Speaker', ar: 'المتحدث', ru: 'Спикер', fr: 'Intervenant', es: 'Orador', de: 'Sprecher',
  pt: 'Orador', it: 'Interlocutore', uk: 'Спікер', tr: 'Konuşmacı', zh: '发言人', hi: 'वक्ता',
};
const MAX_BATCH_CHARS = 8000, MAX_BATCH_ITEMS = 120, MAX_PART_CHARS = 5000;
const PRICE = { input: 0.25, output: 2 }, CREDIT_USD = 0.003;

/** About how many minutes of the quota translating this much text takes (the real cost is set after). */
export const estimateCredits = chars => Math.max(1, Math.ceil(((chars / 2) * PRICE.input + chars * 0.4 * PRICE.output) / 1e6 / CREDIT_USD));

// A part that is too long for one request is cut at a sentence end (or a space), and joined again afterwards.
function slices(text) {
  if (text.length <= MAX_PART_CHARS) return [text];
  const out = [];
  let rest = text;
  while (rest.length > MAX_PART_CHARS) {
    const window = rest.slice(0, MAX_PART_CHARS);
    let cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! ')) + 1;
    if (cut < MAX_PART_CHARS / 2) cut = window.lastIndexOf(' ') + 1;
    if (cut < 1) cut = MAX_PART_CHARS;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** -> { parts: [text to translate], rebuild(translatedParts): the whole text again, in language `to` }. */
export function splitForTranslation(text, to) {
  const word = SPEAKER_WORD[to] || SPEAKER_WORD.en;
  const flat = [], owners = []; // flat: what is sent; owners[i]: which unit it belongs to
  const units = [];             // { head?, body } or { line }
  const turns = String(text).split(/\n{2,}/).map(b => b.replace(/\s+$/, '')).filter(Boolean);
  const bySpeaker = turns.some(b => SPEAKER_HEAD.test(b.split('\n')[0].trim()));
  if (bySpeaker) {
    for (const b of turns) {
      const lines = b.split('\n');
      const m = lines[0].trim().match(SPEAKER_HEAD);
      units.push(m ? { head: [m[1], m[2]], body: lines.slice(1).join(' ').trim() } : { body: b.replace(/\n+/g, ' ') });
    }
  } else {
    for (const line of String(text).split('\n')) units.push({ line, body: line.trim() });
  }
  units.forEach((u, i) => { if (u.body) for (const s of slices(u.body)) { flat.push(s); owners.push(i); } });
  const localName = name => { const m = /^דובר (\d+)$/.exec(name); return m ? `${word} ${m[1]}` : name; };
  return {
    parts: flat,
    rebuild(translated) {
      const bodies = units.map(() => []);
      owners.forEach((o, i) => bodies[o].push(String(translated[i] ?? flat[i]).trim()));
      return units.map((u, i) => {
        const body = bodies[i].join(' ');
        if (bySpeaker) return u.head ? `${localName(u.head[0])} · ${u.head[1]}\n${body}` : body;
        return u.line === undefined || !u.body ? (u.line || '') : body;
      }).join(bySpeaker ? '\n\n' : '\n');
    },
  };
}

/** Groups of indexes of `parts`, each small enough for one request. */
export function batchParts(parts) {
  const batches = [];
  let cur = [], chars = 0;
  parts.forEach((p, i) => {
    if (cur.length && (chars + p.length > MAX_BATCH_CHARS || cur.length >= MAX_BATCH_ITEMS)) { batches.push(cur); cur = []; chars = 0; }
    cur.push(i); chars += p.length;
  });
  if (cur.length) batches.push(cur);
  return batches;
}

/** send(items) -> { items, credits }. Returns { text, credits, stopped } (stopped: the error, with what was translated so far). */
export async function translateText({ text, to, send, onProgress = () => {}, concurrency = 3 }) {
  const { parts, rebuild } = splitForTranslation(text, to);
  const batches = batchParts(parts);
  const done = new Array(parts.length).fill(null);
  let next = 0, finished = 0, credits = 0, stopped = null;
  const worker = async () => {
    while (next < batches.length && !stopped) {
      const idx = batches[next++];
      try {
        const r = await send(idx.map(i => parts[i]));
        idx.forEach((i, k) => { done[i] = r.items[k]; });
        credits += r.credits || 0;
      } catch (e) { stopped = stopped || e; return; }
      onProgress(++finished, batches.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  return { text: rebuild(done.map((t, i) => (t === null ? parts[i] : t))), credits, stopped, translated: done.filter(t => t !== null).length };
}

/** The language of a text when it can be told from the letters: 'he', 'ar', 'cyrillic', 'zh', 'en' (Latin letters with
 *  English's little words), or null. Used to default the target and to say "this is already in English". */
export function detectSource(text) {
  const t = String(text).replace(/^.{1,40}? · \d{1,2}:\d{2}(?::\d{2})?$/gm, ''); // speaker lines are ours, not the text
  const count = re => (t.match(re) || []).length;
  const n = { he: count(/[\u0590-\u05FF]/g), ar: count(/[\u0600-\u06FF]/g), cyrillic: count(/[\u0400-\u04FF]/g), zh: count(/[\u4E00-\u9FFF]/g), latin: count(/[A-Za-z]/g) };
  const total = Object.values(n).reduce((a, b) => a + b, 0);
  if (total < 10) return null;
  const [top, size] = Object.entries(n).sort((a, b) => b[1] - a[1])[0];
  if (size / total < 0.7) return null;
  if (top !== 'latin') return top;
  const words = t.toLowerCase().match(/[a-z']+/g) || [];
  const little = words.filter(w => ['the', 'and', 'of', 'to', 'is', 'in', 'that', 'it', 'for', 'you', 'with', 'this', 'are', 'was'].includes(w)).length;
  return little / words.length > 0.12 ? 'en' : null;
}
const SAME = { he: 'he', ar: 'ar', en: 'en' }; // detected script -> the target code it equals (Cyrillic could be ru or uk)
export const sameLanguage = (source, to) => !!source && (SAME[source] === to || (source === 'cyrillic' && (to === 'ru' || to === 'uk')) || (source === 'zh' && to === 'zh'));

// ---------------------------------------------------------------- the card

export function initTranslate(d) {
  const $ = d.$;
  let lastCredits = 0;
  const select = $('trLang');
  const names = () => d.config()?.translateLanguages || {};
  const source = () => $('resultText').value;
  const nameOf = () => $('resultText').dataset.name || 'תמלול';

  function fillLanguages() {
    if (select.options.length) return;
    for (const [code, label] of Object.entries(names())) select.append(new Option(label, code));
    select.value = 'en';
  }
  // The target is not the language the text is in already: a Hebrew text goes to English, anything else to Hebrew.
  function pickDefault() {
    const src = detectSource(source());
    select.value = src === 'he' ? 'en' : src ? 'he' : select.value;
  }
  function updateCost() {
    const n = source().length;
    const free = d.me()?.unlimited;
    $('trCost').textContent = free ? '' : (c => `יורד מהמכסה בערך ${c === 1 ? 'דקה אחת' : c + ' דקות'} (לפי אורך התמלול)`)(estimateCredits(n));
  }
  function open() {
    if (d.me()?.features && d.me().features.translate === false) return d.toast('התרגום לא כלול בתוכנית שלך');
    fillLanguages();
    pickDefault();
    $('trFor').textContent = nameOf();
    $('trError').hidden = true;
    $('trProgress').hidden = true;
    $('translateCard').hidden = false;
    updateCost();
    $('translateCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $('translateOpen').onclick = open;
  $('trClose').onclick = () => { $('translateCard').hidden = true; };
  select.onchange = updateCost;

  $('trBtn').onclick = async () => {
    const text = source().trim();
    const to = select.value;
    if (!text) return;
    const me = d.me();
    const need = estimateCredits(text.length);
    $('trError').hidden = true;
    if (sameLanguage(detectSource(text), to)) {
      $('trError').textContent = `התמלול כבר ב${names()[to]}, אז אין מה לתרגם. בחרו שפה אחרת בשדה "לתרגם ל".`;
      $('trError').hidden = false;
      return;
    }
    if (me && !me.unlimited && need > me.remaining + 0.01) {
      $('trError').textContent = `התרגום צריך בערך ${need} דקות מהמכסה, ונותרו לך ${Math.floor(me.remaining)}.`;
      $('trError').hidden = false;
      return;
    }
    const btn = $('trBtn');
    btn.disabled = true;
    $('trOut').hidden = true;
    $('trProgress').hidden = false;
    $('trProgressBar').style.width = '4%';
    $('trProgressText').textContent = 'מתרגם…';
    try {
      const r = await translateText({
        text, to, concurrency: 3,
        send: items => send(items, to),
        onProgress: (n, of) => { $('trProgressBar').style.width = Math.round(4 + (n / of) * 96) + '%'; $('trProgressText').textContent = `מתרגם… ${n} מתוך ${of}`; },
      });
      lastCredits = r.credits;
      if (r.translated) show(r.text, to, !!r.stopped);
      if (r.stopped) throw r.stopped;
    } catch (e) {
      $('trError').textContent = e.message || 'התרגום נכשל';
      $('trError').hidden = false;
    } finally {
      btn.disabled = false;
      $('trProgress').hidden = true;
      d.refreshMe(true).then(d.renderQuota);
    }
  };

  async function send(items, to) {
    for (let attempt = 0; ; attempt++) {
      try { return await d.api('/api/translate', { method: 'POST', json: { to, items } }); } catch (e) {
        const retryable = !e.status || e.status >= 500 || e.status === 429;
        if (!retryable || e.code === 'translate_failed' && attempt >= 1 || attempt >= 2) throw e;
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
  }

  function show(text, to, partial) {
    const out = $('trText');
    out.value = text;
    out.dir = RTL_LANGS.includes(to) ? 'rtl' : 'ltr';
    out.dataset.to = to;
    $('trOut').hidden = false;
    $('trMeta').textContent = (partial ? 'התרגום חלקי: חלק מהטקסט נשאר בשפת המקור. ' : '') + (d.me()?.unlimited ? '' : `ירדו ${lastCredits} דקות מהמכסה`);
    d.bindExportOnce($('trExport'), () => buildDoc('transcript', $('trText').value, {
      title: `${nameOf()} (${names()[$('trText').dataset.to] || ''})`, lang: $('trText').dataset.to, seconds: Number($('resultText').dataset.seconds) || 0,
    }));
  }
  $('trCopy').onclick = async () => {
    try { await navigator.clipboard.writeText($('trText').value); d.toast('הועתק'); } catch { $('trText').select(); document.execCommand('copy'); d.toast('הועתק'); }
  };
}
