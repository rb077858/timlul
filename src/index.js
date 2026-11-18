import { STRONG_WEIGHT, COST_PER_MINUTE, PLAN_DEFAULTS, modelIds } from './plans.js';
import { transcribeWav, diarizeWav, parseWavHeader, MAX_UPLOAD_BYTES, MAX_REFS, REF_MIN_SECONDS, REF_MAX_SECONDS } from './openai.js';
import { youtubeAudio, youtubeConfigured } from './youtube.js';
import { translate, TRANSLATE_LANGS } from './translate.js';
import { sendTranscriptEmail } from './mail.js';
import { authenticate, userPlan, clientId } from './sso.js';
import { adminManifest, adminAction } from './admin.js';
import { uploadFile, summarize, summaryLevel, addonLeft, MAX_FILE_BYTES } from './summary.js';
import { SUMMARY_STYLES, SUMMARY_LEVELS, ADDON_FILE_PAGES } from './plans.js';

export { Store } from './store.js';

const EMAILS_PER_DAY = 20;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    // The site is managed from the reem.bi admin (login.reembir.com/admin), which calls /api/admin/* from its page.
    const cors = adminCors(request, env, url);
    if (cors && request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let res;
    try {
      res = await route(request, env, url);
    } catch (e) {
      console.error(e);
      res = json({ error: 'server', message: e.message || 'שגיאת שרת' }, e.status && e.status < 500 ? e.status : 500);
    }
    if (cors) for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },
};

function adminCors(request, env, url) {
  const origin = request.headers.get('Origin');
  if (!origin || !url.pathname.startsWith('/api/admin/')) return null;
  if (origin !== new URL(env.SSO_URL || 'https://login.reembir.com').origin) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

async function route(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/config' && method === 'GET') return json(publicConfig(env));

  const user = await authenticate(request, env, { fresh: url.searchParams.get('fresh') === '1' });
  if (!user) return json({ error: 'unauthorized', message: 'צריך להתחבר' }, 401);
  const store = getStore(env);
  await store.touchUser(user.email, user.name);

  if (path === '/api/me' && method === 'GET') return json(await accountState(env, store, user));
  if (path === '/api/transcribe' && method === 'POST') return transcribe(request, env, store, user, url);
  if (path === '/api/youtube' && method === 'GET') return youtubeFetch(request, env, store, user, url);
  if (path === '/api/email' && method === 'POST') return email(request, env, store, user);
  if (path === '/api/summary/file' && method === 'POST') {
    const ent = await entitlement(env, store, user);
    const r = await uploadFile(request, env, store, user, ent.plan, await addonLeft(store, user.email, ent.addons));
    return json(r.data, r.status);
  }
  if (path === '/api/summarize' && method === 'POST') {
    const ent = await entitlement(env, store, user);
    // Paid from the quota like transcription (monthly minutes first, then extra minutes).
    const reserveFor = credits => store.reserve(user.email, ent.periodStart, ent.plan.credits, 'summary', 0, credits, extraTotals(ent).usable);
    const r = await summarize(request, env, store, user, ent, reserveFor);
    return json(r.data, r.status);
  }

  if (path === '/api/translate' && method === 'POST') {
    const ent = await entitlement(env, store, user);
    const reserveFor = credits => store.reserve(user.email, ent.periodStart, ent.plan.credits, 'summary', 0, credits, extraTotals(ent).usable);
    const r = await translate(request, env, store, user, ent, reserveFor);
    return json(r.data, r.status);
  }

  if (path.startsWith('/api/admin/')) {
    if (!isAdmin(env, user)) return json({ error: 'forbidden', message: 'אין הרשאת מנהל' }, 403);
    if (path === '/api/admin/manifest' && method === 'GET') return json(await adminManifest(env, store));
    const act = path.match(/^\/api\/admin\/actions\/([a-z0-9-]+)$/);
    if (act && method === 'POST') {
      const r = await adminAction(env, store, act[1], await request.json().catch(() => ({})));
      return json(r.data, r.status);
    }
  }
  return json({ error: 'not_found' }, 404);
}

// ---------- helpers ----------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function getStore(env) {
  return env.STORE.get(env.STORE.idFromName('main'));
}

function isAdmin(env, user) {
  return (env.ADMIN_EMAILS || '').toLowerCase().split(/[\s,;]+/).filter(Boolean).includes(user.email);
}

function monthStart(now = Date.now()) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function nextMonthStart(now = Date.now()) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function publicConfig(env) {
  return {
    ssoClientId: clientId(env),
    strongWeight: STRONG_WEIGHT,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    // A link to a YouTube video can be transcribed when a download service is connected (src/youtube.js).
    youtube: youtubeConfigured(env),
    translateLanguages: TRANSLATE_LANGS,
    // Fallbacks for plans whose JSON in the dashboard doesn't set minutes/strong/email.
    planDefaults: PLAN_DEFAULTS,
    // AI summary styles: { id: label }, and how big a file may be.
    summaryStyles: Object.fromEntries(Object.entries(SUMMARY_STYLES).map(([k, v]) => [k, v.label])),
    summaryLevels: SUMMARY_LEVELS,
    addonFilePages: ADDON_FILE_PAGES,
    maxSummaryFileBytes: MAX_FILE_BYTES,
  };
}

// ---------- what the user may do ----------

// The minutes renew at the start of every calendar month.
async function entitlement(env, store, user) {
  const { plan, expiresAt, subscription, packs, affiliate, affiliateProgram, addons } = userPlan(env, user);
  return { plan, expiresAt, subscription, packs, affiliate, affiliateProgram, addons, periodStart: monthStart(), periodEnd: nextMonthStart() };
}

// Extra minutes (packs + partner-program gifts) form one pool, used after the monthly quota.
// Pack minutes count only while the plan allows packs; gift minutes always count.
function extraTotals(ent) {
  return { all: ent.packs.bought + ent.packs.bonus, usable: (ent.packs.eligible ? ent.packs.bought : 0) + ent.packs.bonus };
}

async function accountState(env, store, user) {
  const ent = await entitlement(env, store, user);
  const used = await store.usedSince(user.email, ent.periodStart);
  const hasSummarized = await store.hasSummarized(user.email);
  const addons = await addonLeft(store, user.email, ent.addons);
  const unlimited = !!ent.plan.unlimited;
  const allowed = ent.packs.eligible;
  const extra = extraTotals(ent);
  const balance = Math.round((await store.packBalance(user.email, extra.all)) * 100) / 100;
  const usable = Math.round((await store.packBalance(user.email, extra.usable)) * 100) / 100;
  const planRemaining = unlimited ? null : Math.max(0, Math.round((ent.plan.credits - used) * 100) / 100);
  return {
    user: { email: user.email, name: user.name },
    plan: { key: ent.plan.key, name: ent.plan.name, credits: unlimited ? null : ent.plan.credits },
    unlimited,
    features: { strong: !!ent.plan.strong, email: !!ent.plan.email, diarize: !!ent.plan.diarize, translate: ent.plan.translate !== false },
    // AI summaries: what this plan may do, and whether the one trial summary is still there.
    summary: (l => {
      // addons: what is left of the summaries / attachable files the site gave this user on top of the plan.
      return { level: l.level, styles: l.styles, files: l.files, pages: l.pages, texts: l.texts, trialLeft: l.trial ? !hasSummarized : false, addons };
    })(summaryLevel(ent.plan)),
    used: Math.round(used * 100) / 100,
    // What can be transcribed now: the month's quota plus usable pack minutes.
    remaining: unlimited ? null : Math.round((planRemaining + usable) * 100) / 100,
    planRemaining,
    // Pack minutes stay while the plan doesn't allow packs, but can't be used until it does again.
    packs: { allowed, balance, usable, bonus: ent.packs.bonus },
    affiliate: ent.affiliate,
    // Users may join the partner program by themselves (reem.bi dashboard → Partners).
    partnerProgram: ent.affiliateProgram && ent.affiliateProgram.self_join ? {
      label: String(ent.affiliateProgram.label || ''),
      rewardMinutes: Number(ent.affiliateProgram.reward?.minutes) > 0 ? Number(ent.affiliateProgram.reward.minutes) : 0,
      rewardOn: ent.affiliateProgram.reward_on === 'paid' ? 'paid' : 'signup',
    } : null,
    periodEnd: ent.periodEnd,
    planExpiresAt: ent.expiresAt,
    subscription: ent.subscription,
    isAdmin: isAdmin(env, user),
  };
}

// ---------- transcription ----------

async function transcribe(request, env, store, user, url) {
  if (!env.OPENAI_API_KEY) return json({ error: 'not_configured', message: 'מפתח OpenAI לא הוגדר' }, 500);
  if (url.searchParams.get('diarize') === '1') return transcribeBySpeaker(request, env, store, user, url);

  const kind = url.searchParams.get('model') === 'strong' ? 'strong' : 'fast';
  const lang = /^[a-z]{2}$/.test(url.searchParams.get('lang') || '') ? url.searchParams.get('lang') : '';
  const prompt = (url.searchParams.get('prompt') || '').slice(0, 800);
  const length = Number(request.headers.get('Content-Length'));
  if (!request.body || !Number.isFinite(length) || length <= 44) return json({ error: 'bad_request', message: 'קובץ ריק' }, 400);
  if (length > MAX_UPLOAD_BYTES) return json({ error: 'too_large', message: 'קטע גדול מדי' }, 413);

  const ent = await entitlement(env, store, user);
  if (kind === 'strong' && !ent.plan.strong) {
    request.body.cancel().catch(() => {});
    return json({ error: 'upgrade', message: 'המודל המדויק זמין בתוכניות בתשלום' }, 403);
  }

  // The browser always sends 16 kHz mono 16-bit WAV, so the length tells the duration.
  const reader = request.body.getReader();
  const head = await readAtLeast(reader, 44);
  const wav = parseWavHeader(head, length);
  if (!wav) {
    reader.cancel().catch(() => {});
    return json({ error: 'bad_format', message: 'פורמט שמע לא תקין' }, 400);
  }

  const seconds = wav.seconds;
  const credits = (seconds / 60) * (kind === 'strong' ? STRONG_WEIGHT : 1);
  const limit = ent.plan.credits;
  const usePacks = ent.packs.eligible;
  const reservation = await store.reserve(user.email, ent.periodStart, limit, kind, seconds, credits, extraTotals(ent).usable);
  if (!reservation.ok) {
    reader.cancel().catch(() => {});
    const message = usePacks
      ? 'נגמרו הדקות לחודש הזה. אפשר לקנות חבילת דקות נוספות בדף המחירים'
      : limit > 0 ? 'נגמרו הדקות בתוכנית שלך לחודש הזה' : 'נגמרו דקות המתנה. כדי להמשיך לתמלל, בחרו תוכנית';
    return json({ error: 'quota', message, used: reservation.used, limit, packs: reservation.packs }, 402);
  }

  try {
    const text = await transcribeWav(env, {
      model: modelIds(env)[kind], language: lang, prompt, head, reader, body: request.body, length,
    });
    return json({ text, used: reservation.used, limit });
  } catch (e) {
    await store.release(reservation.id);
    console.error('transcription failed', e.message);
    return json({ error: 'transcription_failed', message: e.message }, 502);
  }
}

// By speaker: the browser sends a form (the audio piece, and clips of speakers heard before). Costs like the
// accurate model, and is for the plans that have it ("diarize" in the plan's JSON, by default whoever has "strong").
async function transcribeBySpeaker(request, env, store, user, url) {
  const lang = /^[a-z]{2}$/.test(url.searchParams.get('lang') || '') ? url.searchParams.get('lang') : '';
  const length = Number(request.headers.get('Content-Length'));
  if (!request.body || !Number.isFinite(length) || length <= 44) return json({ error: 'bad_request', message: 'קובץ ריק' }, 400);
  if (length > MAX_UPLOAD_BYTES + (MAX_REFS + 1) * 340000) return json({ error: 'too_large', message: 'קטע גדול מדי' }, 413);
  const ent = await entitlement(env, store, user);
  if (!ent.plan.diarize) {
    request.body.cancel().catch(() => {});
    return json({ error: 'upgrade', message: 'זיהוי דוברים זמין בתוכניות בתשלום' }, 403);
  }
  let form;
  try { form = await request.formData(); } catch { return json({ error: 'bad_request', message: 'הבקשה לא תקינה' }, 400); }
  const file = form.get('file');
  if (!file || typeof file === 'string' || file.size > MAX_UPLOAD_BYTES) return json({ error: 'bad_request', message: 'קובץ חסר או גדול מדי' }, 400);
  const wav = parseWavHeader(new Uint8Array(await file.slice(0, 44).arrayBuffer()), file.size);
  if (!wav) return json({ error: 'bad_format', message: 'פורמט שמע לא תקין' }, 400);

  const known = [];
  const names = form.getAll('ref_name'), refs = form.getAll('ref');
  for (let i = 0; i < Math.min(MAX_REFS, refs.length); i++) {
    const f = refs[i];
    if (!f || typeof f === 'string' || !/^spk[1-9]$/.test(String(names[i]))) continue;
    const bytes = new Uint8Array(await f.arrayBuffer());
    const w = parseWavHeader(bytes, bytes.length);
    if (w && w.seconds >= REF_MIN_SECONDS && w.seconds <= REF_MAX_SECONDS) known.push({ name: String(names[i]), bytes });
  }

  const credits = (wav.seconds / 60) * STRONG_WEIGHT;
  const reservation = await store.reserve(user.email, ent.periodStart, ent.plan.credits, 'strong', wav.seconds, credits, extraTotals(ent).usable);
  if (!reservation.ok) {
    const message = ent.packs.eligible
      ? 'נגמרו הדקות לחודש הזה. אפשר לקנות חבילת דקות נוספות בדף המחירים'
      : ent.plan.credits > 0 ? 'נגמרו הדקות בתוכנית שלך לחודש הזה' : 'נגמרו דקות המתנה. כדי להמשיך לתמלל, בחרו תוכנית';
    return json({ error: 'quota', message, used: reservation.used, limit: ent.plan.credits, packs: reservation.packs }, 402);
  }
  try {
    const r = await diarizeWav(env, { model: modelIds(env).diarize, language: lang, file, known });
    return json({ ...r, used: reservation.used, limit: ent.plan.credits });
  } catch (e) {
    await store.release(reservation.id);
    console.error('diarized transcription failed', e.message);
    return json({ error: 'transcription_failed', message: e.message }, 502);
  }
}

// A YouTube link: the audio comes from the download service (src/youtube.js) and goes to the browser, which
// prepares and transcribes it like an uploaded file (so the quota, the model and the speakers work the same).
async function youtubeFetch(request, env, store, user, url) {
  if (!youtubeConfigured(env)) return json({ error: 'not_configured', message: 'היבוא מיוטיוב עוד לא מופעל באתר' }, 501);
  const ent = await entitlement(env, store, user);
  const unlimited = !!ent.plan.unlimited;
  const used = await store.usedSince(user.email, ent.periodStart);
  const left = unlimited ? Infinity : ent.plan.credits - used + (await store.packBalance(user.email, extraTotals(ent).usable));
  if (left <= 0.01) return json({ error: 'quota', message: 'נגמרו הדקות. כדי לתמלל סרטון, בחרו תוכנית' }, 402);
  if (!(await store.allowEmail('yt:' + user.email, 30))) return json({ error: 'rate_limited', message: 'הבאת יותר מדי סרטונים היום' }, 429);
  const r = await youtubeAudio(env, url.searchParams.get('url') || '', unlimited ? 0 : Math.ceil(left * 60));
  if (r.error) return json({ error: r.code || 'youtube', message: r.error }, r.status || 502);
  return new Response(r.body, { headers: { ...r.headers, 'Cache-Control': 'no-store' } });
}

async function readAtLeast(reader, n) {
  const parts = [];
  let total = 0;
  while (total < n) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.byteLength; }
  return out;
}

// ---------- email ----------

async function email(request, env, store, user) {
  const ent = await entitlement(env, store, user);
  if (!ent.plan.email) return json({ error: 'upgrade', message: 'שליחה במייל זמינה בתוכניות בתשלום' }, 403);
  const { text, filename } = await readJson(request);
  if (typeof text !== 'string' || !text.trim()) return json({ error: 'bad_request', message: 'אין טקסט לשליחה' }, 400);
  if (text.length > 2000000) return json({ error: 'too_large', message: 'הטקסט ארוך מדי לשליחה במייל' }, 413);
  if (!(await store.allowEmail(user.email, EMAILS_PER_DAY))) {
    return json({ error: 'rate_limited', message: 'שלחת יותר מדי מיילים היום' }, 429);
  }
  await sendTranscriptEmail(env, { authorization: request.headers.get('Authorization'), text, filename: String(filename || 'transcript').slice(0, 120) });
  return json({ ok: true, to: user.email });
}

// ---------- admin ----------
//
// What the reem.bi admin shows on this site's page (login.reembir.com/admin → אתרים → תמלולי):
// usage and cost stats and the state of the settings. Plans, coupons and subscriptions are
// managed there directly, so they're not here.
