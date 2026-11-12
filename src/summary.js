// AI summaries of transcripts, with the lecture's slides or other material (OpenAI, the same key).
//
// What each plan may do is its "summary" level (plans.js SUMMARY_LEVELS, or {"summary": n} in the
// plan's JSON in the reem.bi dashboard). A summary is paid from the same quota as transcription,
// by what it really cost: one credit = $0.003, the price of a fast-model minute, so every plan
// and pack keeps its margin. Before calling OpenAI the worst case is reserved; afterwards the
// row is set to the real cost from the response's token counts.
//
// Files (PDF, images) are streamed to OpenAI's file storage without buffering here, used by id
// in the summary, and deleted right after (or within the hour if never used).
import { COST_PER_MINUTE, SUMMARY_LEVELS, SUMMARY_STYLES } from './plans.js';

const CREDIT_USD = COST_PER_MINUTE.fast;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const FILE_TYPES = { 'application/pdf': 'pdf', 'image/png': 'image', 'image/jpeg': 'image', 'image/webp': 'image' };
const MAX_TEXT_CHARS = 400000;
const TRIAL_CHARS = 30000;

const model = env => env.SUMMARY_MODEL || 'gpt-5-mini';
const prices = env => ({ input: Number(env.SUMMARY_PRICE_IN) || 0.25, output: Number(env.SUMMARY_PRICE_OUT) || 2 }); // $ per 1M tokens
export const summaryLevel = plan => SUMMARY_LEVELS[Math.max(0, Math.min(3, Math.round(Number(plan.summary) || 0)))];

const err = (status, error, message) => ({ status, data: { error, message } });

// ---------- files ----------

async function deleteFiles(env, ids) {
  await Promise.all(ids.map(id => fetch('https://api.openai.com/v1/files/' + encodeURIComponent(id), {
    method: 'DELETE', headers: { Authorization: 'Bearer ' + env.OPENAI_API_KEY },
  }).catch(() => {})));
}

/** POST /api/summary/file: the raw file in the body, its name in X-Filename. */
export async function uploadFile(request, env, store, user, plan) {
  const level = summaryLevel(plan);
  if (!level.files) return err(403, 'upgrade', 'העלאת מצגות וחומרים זמינה בתוכנית מקצועי ומעלה');
  const type = FILE_TYPES[(request.headers.get('Content-Type') || '').split(';')[0].trim()];
  if (!type) return err(400, 'bad_type', 'אפשר להעלות PDF או תמונה. מצגת PowerPoint נקראת בדפדפן');
  const length = Number(request.headers.get('Content-Length'));
  if (!request.body || !Number.isFinite(length) || length <= 0) return err(400, 'bad_request', 'קובץ ריק');
  if (length > MAX_FILE_BYTES) return err(413, 'too_large', 'הקובץ גדול מדי (עד 20MB)');
  const name = (decodeURIComponent(request.headers.get('X-Filename') || '') || 'file').replace(/["\r\n\\]/g, '').slice(0, 100) || 'file';

  // Files that were uploaded but never summarized are deleted after an hour.
  const stale = await store.staleSummaryFiles(Date.now() - 3600000);
  if (stale.length) deleteFiles(env, stale);

  const enc = new TextEncoder();
  const boundary = 'timlul' + crypto.randomUUID().replace(/-/g, '');
  const pre = enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nuser_data\r\n`
    + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${request.headers.get('Content-Type')}\r\n\r\n`);
  const post = enc.encode(`\r\n--${boundary}--\r\n`);
  const { readable, writable } = new FixedLengthStream(pre.byteLength + length + post.byteLength);
  const pump = (async () => {
    let w = writable.getWriter();
    await w.write(pre);
    w.releaseLock();
    await request.body.pipeTo(writable, { preventClose: true });
    w = writable.getWriter();
    await w.write(post);
    await w.close();
  })().catch(e => { writable.abort(e).catch(() => {}); throw new Error('ההעלאה נקטעה'); });
  try {
    const [res] = await Promise.all([fetch('https://api.openai.com/v1/files', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.OPENAI_API_KEY, 'Content-Type': 'multipart/form-data; boundary=' + boundary },
      body: readable,
    }), pump]);
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.id) throw new Error('OpenAI: ' + (data?.error?.message || res.status));
    await store.addSummaryFile(user.email, data.id, type);
    return { status: 200, data: { id: data.id, type } };
  } catch (e) {
    console.error('summary file upload failed', e.message);
    return err(502, 'upload_failed', 'העלאת הקובץ נכשלה, נסו שוב');
  }
}

// ---------- the summary ----------

function instructions(style, multi) {
  return [
    'אתה עוזר לימוד שמסכם הקלטות שתומללו (שיעורים, הרצאות, פגישות, ראיונות).',
    'כתוב בשפה של התמלול (בדרך כלל עברית), בצורה ברורה ומסודרת, בלי להמציא דברים שלא נאמרו.',
    'התמלול נעשה אוטומטית ועלול להכיל שגיאות; כשיש חומרים מצורפים (מצגת, מסמך), השתמש בהם כדי לתקן מונחים ושמות ולהשלים את המבנה.',
    multi ? 'יש כמה תמלולים, למשל כמה שיעורים מאותו קורס: חבר אותם לסיכום אחד מסודר לפי נושאים.' : '',
    'פורמט: Markdown פשוט בלבד: כותרות עם ##, רשימות עם -, הדגשה עם **. בלי טבלאות ובלי קוד.',
    SUMMARY_STYLES[style].prompt,
  ].filter(Boolean).join('\n');
}

/** POST /api/summarize: { style, texts: [{ title, text }], files: [ids], extra: [{ name, text }], pages } */
export async function summarize(request, env, store, user, ent, reserveFor) {
  const level = summaryLevel(ent.plan);
  const body = await request.json().catch(() => ({}));
  const style = String(body.style || 'short');
  if (!SUMMARY_STYLES[style]) return err(400, 'bad_style', 'סוג סיכום לא מוכר');
  const trial = level.trial;
  if (trial && (await store.hasSummarized(user.email))) return err(403, 'upgrade', 'סיכום הניסיון כבר נוצל. סיכומים זמינים בכל התוכניות בתשלום');
  if (!level.styles.includes(style)) return err(403, 'upgrade', `"${SUMMARY_STYLES[style].label}" זמין בתוכנית מקצועי ומעלה`);

  const texts = (Array.isArray(body.texts) ? body.texts : []).filter(t => t && typeof t.text === 'string' && t.text.trim());
  const extra = (Array.isArray(body.extra) ? body.extra : []).filter(t => t && typeof t.text === 'string' && t.text.trim());
  const files = Array.isArray(body.files) ? body.files.map(String) : [];
  if (!texts.length) return err(400, 'bad_request', 'אין תמלול לסכם');
  if (texts.length > level.texts) return err(403, 'upgrade', 'סיכום של כמה תמלולים יחד זמין בתוכנית העסקית');
  if (files.length + extra.length > level.files) {
    return err(403, 'upgrade', level.files ? `אפשר לצרף עד ${level.files} קבצים` : 'צירוף מצגות וחומרים זמין בתוכנית מקצועי ומעלה');
  }
  const pages = Math.max(0, Math.round(Number(body.pages) || 0));
  if (pages > level.pages && level.files) return err(403, 'too_large', `אפשר לצרף עד ${level.pages} עמודים`);
  if (files.length && !(await store.ownsSummaryFiles(user.email, files))) return err(400, 'bad_request', 'הקובץ לא נמצא. העלו אותו שוב');
  const chars = [...texts, ...extra].reduce((a, t) => a + t.text.length, 0);
  if (chars > (trial ? TRIAL_CHARS : MAX_TEXT_CHARS)) return err(413, 'too_large', trial ? 'סיכום הניסיון מיועד לתמלול קצר' : 'הטקסט ארוך מדי לסיכום אחד');

  // The worst case, reserved from the quota before calling OpenAI.
  const p = prices(env);
  const maxOut = trial ? 3000 : 9000;
  // Hebrew is about 2 characters a token; a PDF page sends its text and its picture.
  const estIn = chars / 2 + (pages ? pages * 1500 : files.length * 1500) + 1500;
  const worst = (estIn * p.input + maxOut * p.output) / 1e6;
  const reservation = await reserveFor(Math.max(1, Math.ceil(worst / CREDIT_USD)));
  if (!reservation.ok) return err(402, 'quota', 'אין מספיק דקות במכסה לסיכום הזה');

  const types = await store.summaryFileTypes(files);
  const content = [];
  texts.forEach((t, i) => content.push({ type: 'input_text', text: `${texts.length > 1 ? `תמלול ${i + 1}` : 'התמלול'}${t.title ? ': ' + String(t.title).slice(0, 120) : ''}\n\n${t.text}` }));
  extra.forEach(t => content.push({ type: 'input_text', text: `חומר מצורף: ${String(t.name || '').slice(0, 120)}\n\n${t.text}` }));
  files.forEach(id => content.push(types[id] === 'image' ? { type: 'input_image', file_id: id, detail: 'auto' } : { type: 'input_file', file_id: id }));

  try {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model(env), instructions: instructions(style, texts.length > 1), input: [{ role: 'user', content }],
        reasoning: { effort: 'low' }, max_output_tokens: maxOut, store: false,
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error('OpenAI: ' + (data?.error?.message || res.status));
    const text = (data.output || []).flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('\n').trim();
    if (!text) throw new Error('OpenAI: empty summary');
    const usd = ((data.usage?.input_tokens || 0) * p.input + (data.usage?.output_tokens || 0) * p.output) / 1e6;
    const credits = Math.max(1, Math.ceil(usd / CREDIT_USD));
    await store.settle(reservation.id, credits);
    return { status: 200, data: { text, credits, partial: data.status === 'incomplete' } };
  } catch (e) {
    await store.release(reservation.id);
    console.error('summary failed', e.message);
    return err(502, 'summary_failed', 'הסיכום נכשל. לא ירדו דקות. נסו שוב');
  } finally {
    if (files.length) {
      await store.dropSummaryFiles(files);
      await deleteFiles(env, files);
    }
  }
}
