// Translation of a transcript into another language (OpenAI, the same key as the summaries).
//
// The browser cuts the transcript into parts (a speaker's turn, or a line) and sends a few thousand characters at a
// time; each part comes back translated, in the same order, so the structure (speakers, times) stays. It is paid from
// the same quota as transcription, by what it really cost (like a summary): the worst case is reserved first and the
// row is set to the real cost afterwards. One credit = $0.003.
import { COST_PER_MINUTE } from './plans.js';

const CREDIT_USD = COST_PER_MINUTE.fast;
export const TRANSLATE_LANGS = {
  en: 'אנגלית', he: 'עברית', ar: 'ערבית', ru: 'רוסית', fr: 'צרפתית', es: 'ספרדית', de: 'גרמנית',
  pt: 'פורטוגזית', it: 'איטלקית', uk: 'אוקראינית', tr: 'טורקית', zh: 'סינית', hi: 'הינדית',
};
const ENGLISH_NAMES = {
  en: 'English', he: 'Hebrew', ar: 'Arabic', ru: 'Russian', fr: 'French', es: 'Spanish', de: 'German',
  pt: 'Portuguese', it: 'Italian', uk: 'Ukrainian', tr: 'Turkish', zh: 'Chinese (Simplified)', hi: 'Hindi',
};
export const MAX_REQUEST_CHARS = 12000;
export const MAX_ITEMS = 300;

const model = env => env.TRANSLATE_MODEL || env.SUMMARY_MODEL || 'gpt-5-mini';
const prices = env => ({ input: Number(env.SUMMARY_PRICE_IN) || 0.25, output: Number(env.SUMMARY_PRICE_OUT) || 2 }); // $ per 1M tokens
const err = (status, error, message) => ({ status, data: { error, message } });

/** POST /api/translate { to: 'en', items: [text, ...] } -> { items: [translated, ...], credits } */
export async function translate(request, env, store, user, ent, reserveFor) {
  if (ent.plan.translate === false) return err(403, 'upgrade', 'התרגום לא כלול בתוכנית שלך');
  const body = await request.json().catch(() => ({}));
  const to = String(body.to || '');
  if (!ENGLISH_NAMES[to]) return err(400, 'bad_language', 'שפה לא נתמכת');
  const items = Array.isArray(body.items) ? body.items.map(x => (typeof x === 'string' ? x : '')) : [];
  if (!items.some(x => x.trim())) return err(400, 'bad_request', 'אין טקסט לתרגום');
  if (items.length > MAX_ITEMS) return err(413, 'too_large', 'יותר מדי חלקים בבקשה אחת');
  const chars = items.reduce((a, t) => a + t.length, 0);
  if (chars > MAX_REQUEST_CHARS) return err(413, 'too_large', 'הטקסט גדול מדי לבקשה אחת');

  // The worst case, reserved before calling OpenAI: about two characters a token in, as many out (plus the JSON around them).
  const p = prices(env);
  const maxOut = Math.min(30000, Math.ceil(chars * 0.9) + items.length * 8 + 1500);
  const worst = ((chars / 2 + items.length * 6 + 400) * p.input + maxOut * p.output) / 1e6;
  const reservation = await reserveFor(Math.max(1, Math.ceil(worst / CREDIT_USD)));
  if (!reservation.ok) return err(402, 'quota', 'אין מספיק דקות במכסה לתרגום הזה');

  const instructions = [
    `Translate every item of the JSON array the user sends into ${ENGLISH_NAMES[to]}.`,
    'The items are consecutive parts of an automatic transcript of a recording (a lesson, a meeting, an interview), so the wording can contain small recognition mistakes: translate what was meant.',
    'Keep names, numbers, dates and technical terms. Do not summarize, explain, shorten or add anything. If an item is already in the target language, return it as it is.',
    'Return exactly the same number of items, in the same order. An empty item stays an empty string.',
  ].join('\n');
  const call = async () => {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model(env), instructions, input: [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify(items) }] }],
        reasoning: { effort: 'low' }, max_output_tokens: maxOut, store: false,
        text: { format: { type: 'json_schema', name: 'translation', strict: true, schema: { type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', items: { type: 'string' } } } } } },
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error('OpenAI: ' + (data?.error?.message || res.status));
    const out = (data.output || []).flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('');
    let parsed;
    try { parsed = JSON.parse(out); } catch { throw new Error('OpenAI: the translation could not be read'); }
    if (!Array.isArray(parsed.items) || parsed.items.length !== items.length) throw new Error('OpenAI: the translation does not match the text');
    const usd = ((data.usage?.input_tokens || 0) * p.input + (data.usage?.output_tokens || 0) * p.output) / 1e6;
    return { items: parsed.items.map(String), usd, partial: data.status === 'incomplete' };
  };
  try {
    let r;
    let spent = 0;
    try { r = await call(); } catch (e) { if (!/does not match|could not be read/.test(e.message)) throw e; r = await call(); }
    spent += r.usd;
    if (r.partial) throw new Error('OpenAI: the translation was cut');
    const credits = Math.max(1, Math.ceil(spent / CREDIT_USD));
    await store.settle(reservation.id, credits);
    return { status: 200, data: { items: r.items, credits } };
  } catch (e) {
    await store.release(reservation.id);
    console.error('translation failed', e.message);
    return err(502, 'translate_failed', 'התרגום נכשל. לא ירדו דקות. נסו שוב');
  }
}
