import { STRONG_WEIGHT, COST_PER_MINUTE, PLAN_DEFAULTS, modelIds } from './plans.js';
import { transcribeWav, parseWavHeader, MAX_UPLOAD_BYTES } from './openai.js';
import { sendTranscriptEmail } from './mail.js';
import { authenticate, userPlan, clientId } from './sso.js';

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
  if (path === '/api/email' && method === 'POST') return email(request, env, store, user);

  if (path.startsWith('/api/admin/')) {
    if (!isAdmin(env, user)) return json({ error: 'forbidden', message: 'אין הרשאת מנהל' }, 403);
    if (path === '/api/admin/manifest' && method === 'GET') return json(await adminManifest(env, store, url));
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
    // Fallbacks for plans whose JSON in the dashboard doesn't set minutes/strong/email.
    planDefaults: PLAN_DEFAULTS,
  };
}

// ---------- what the user may do ----------

// The minutes renew at the start of every calendar month.
async function entitlement(env, store, user) {
  const { plan, expiresAt, subscription } = userPlan(env, user);
  return { plan, expiresAt, subscription, periodStart: monthStart(), periodEnd: nextMonthStart() };
}

async function accountState(env, store, user) {
  const ent = await entitlement(env, store, user);
  const used = await store.usedSince(user.email, ent.periodStart);
  const unlimited = !!ent.plan.unlimited;
  return {
    user: { email: user.email, name: user.name },
    plan: { key: ent.plan.key, name: ent.plan.name, credits: unlimited ? null : ent.plan.credits },
    unlimited,
    features: { strong: !!ent.plan.strong, email: !!ent.plan.email },
    used: Math.round(used * 100) / 100,
    remaining: unlimited ? null : Math.max(0, Math.round((ent.plan.credits - used) * 100) / 100),
    periodEnd: ent.periodEnd,
    planExpiresAt: ent.expiresAt,
    subscription: ent.subscription,
    isAdmin: isAdmin(env, user),
  };
}

// ---------- transcription ----------

async function transcribe(request, env, store, user, url) {
  if (!env.OPENAI_API_KEY) return json({ error: 'not_configured', message: 'מפתח OpenAI לא הוגדר' }, 500);

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
  const reservation = await store.reserve(user.email, ent.periodStart, limit, kind, seconds, credits);
  if (!reservation.ok) {
    reader.cancel().catch(() => {});
    return json({ error: 'quota', message: 'נגמרו הדקות בתוכנית שלך לחודש הזה', used: reservation.used, limit }, 402);
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
// What the reem.bi admin shows on this site's page (login.reembir.com/admin → אתרים → תמלול):
// usage and cost stats and the state of the settings. Plans, coupons and subscriptions are
// managed there directly, so they're not here.
async function adminManifest(env, store) {
  const d = await store.stats(monthStart());
  let costUsd = 0;
  for (const row of d.usage) costUsd += (row.seconds / 60) * (COST_PER_MINUTE[row.model] || 0);
  const minutes = model => Math.round((d.usage.find(u => u.model === model)?.seconds || 0) / 60);
  const ids = modelIds(env);
  const configured = {
    OPENAI_API_KEY: !!env.OPENAI_API_KEY,
    ADMIN_EMAILS: !!env.ADMIN_EMAILS,
  };
  return {
    version: 1,
    name: 'תמלול',
    stats: [
      { label: 'השתמשו החודש', value: d.activeUsers },
      { label: 'דקות החודש (מהיר)', value: minutes('fast') },
      { label: 'דקות החודש (מדויק)', value: minutes('strong') },
      { label: 'עלות OpenAI החודש', value: '$' + Math.round(costUsd * 100) / 100 },
    ],
    checks: [
      ...Object.entries(configured).map(([k, ok]) => ({ label: k, ok, detail: ok ? 'מוגדר' : 'חסר ב-Cloudflare ← Worker timlul ← Variables and Secrets' })),
      { label: 'מודלים', ok: true, detail: `מהיר: ${ids.fast} · מדויק: ${ids.strong}` },
    ],
    lists: [{
      title: 'הכי הרבה שימוש החודש',
      empty: 'עוד אין שימוש החודש',
      items: d.topUsers.map(u => ({
        title: u.email,
        subtitle: `${Math.round(u.seconds / 60)} דקות הקלטה · ${Math.round(u.credits)} דקות מהמכסה`,
      })),
    }],
  };
}
