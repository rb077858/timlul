import { STRONG_WEIGHT, COST_PER_MINUTE, PLAN_DEFAULTS, PACKS, PACK_PLANS, PACK_CURRENCY, modelIds } from './plans.js';
import { createOrder, captureOrder, paypalEnv } from './paypal.js';
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
  if (path === '/api/packs/order' && method === 'POST') return packOrder(request, env, store, user);
  if (path === '/api/packs/capture' && method === 'POST') return packCapture(request, env, store, user);

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
    packs: {
      plans: PACK_PLANS,
      currency: PACK_CURRENCY,
      list: Object.entries(PACKS).map(([key, p]) => ({ key, credits: p.credits, price: p.price })),
      // The same PayPal account as reem.bi; the site needs its keys only for the packs.
      paypal: env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET ? { clientId: env.PAYPAL_CLIENT_ID, env: paypalEnv(env) } : null,
    },
  };
}

// Packs are for the top plan only (lower plans should upgrade), never with unlimited.
function packsAllowed(plan) {
  if (plan.unlimited) return false;
  if (typeof plan.packs === 'boolean') return plan.packs;
  return PACK_PLANS.includes(plan.key);
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
  const allowed = packsAllowed(ent.plan);
  const balance = Math.round((await store.packBalance(user.email)) * 100) / 100;
  const planRemaining = unlimited ? null : Math.max(0, Math.round((ent.plan.credits - used) * 100) / 100);
  return {
    user: { email: user.email, name: user.name },
    plan: { key: ent.plan.key, name: ent.plan.name, credits: unlimited ? null : ent.plan.credits },
    unlimited,
    features: { strong: !!ent.plan.strong, email: !!ent.plan.email },
    used: Math.round(used * 100) / 100,
    // What can be transcribed now: the month's quota plus usable pack minutes.
    remaining: unlimited ? null : Math.round((planRemaining + (allowed ? balance : 0)) * 100) / 100,
    planRemaining,
    // Pack minutes stay while the plan doesn't allow packs, but can't be used until it does again.
    packs: { allowed, balance },
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
  const usePacks = packsAllowed(ent.plan);
  const reservation = await store.reserve(user.email, ent.periodStart, limit, kind, seconds, credits, usePacks);
  if (!reservation.ok) {
    reader.cancel().catch(() => {});
    const message = usePacks
      ? 'נגמרו הדקות לחודש הזה. אפשר לקנות חבילת דקות נוספות בדף המחירים'
      : 'נגמרו הדקות בתוכנית שלך לחודש הזה';
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

// ---------- extra-minute packs (one-time PayPal payments) ----------

function packError() {
  return json({ error: 'not_configured', message: 'רכישת חבילות עוד לא הופעלה' }, 503);
}

async function packOrder(request, env, store, user) {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) return packError();
  const { pack } = await readJson(request);
  const p = PACKS[pack];
  if (!p) return json({ error: 'bad_request', message: 'חבילה לא קיימת' }, 400);
  const ent = await entitlement(env, store, user);
  if (!packsAllowed(ent.plan)) {
    return json({ error: 'upgrade', message: 'חבילות דקות זמינות למנויי התוכנית העסקית' }, 403);
  }
  const order = await createOrder(env, {
    referenceId: 'pack-' + pack,
    customId: `${clientId(env)}:${user.id}:${pack}`,
    description: `תמלול: ${p.credits} דקות נוספות`,
    value: p.price,
    currency: PACK_CURRENCY,
  });
  return json({ id: order.id });
}

// After the buyer approves in PayPal: capture, check it's this user's paid order, add the minutes.
// Safe to retry: an order is added once.
async function packCapture(request, env, store, user) {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) return packError();
  const { orderId } = await readJson(request);
  if (typeof orderId !== 'string' || !/^[A-Za-z0-9-]{5,64}$/.test(orderId)) {
    return json({ error: 'bad_request', message: 'הזמנה לא תקינה' }, 400);
  }
  const order = await captureOrder(env, orderId);
  const unit = order.purchase_units?.[0] || {};
  const parts = String(unit.custom_id || '').split(':');
  const site = parts.shift(), pack = parts.pop(), userId = parts.join(':');
  const p = PACKS[pack];
  if (site !== clientId(env) || userId !== String(user.id) || !p) {
    return json({ error: 'forbidden', message: 'ההזמנה לא שייכת לחשבון הזה' }, 403);
  }
  const capture = unit.payments?.captures?.[0];
  const paid = order.status === 'COMPLETED' && capture?.status === 'COMPLETED' &&
    capture.amount?.currency_code === PACK_CURRENCY && Number(capture.amount?.value) >= p.price;
  if (!paid) {
    console.error('pack order not paid', orderId, order.status, capture?.status);
    return json({ error: 'not_paid', message: 'התשלום לא הושלם' }, 402);
  }
  await store.addPack(user.email, orderId, pack, p.credits, Number(capture.amount.value), PACK_CURRENCY);
  return json(await accountState(env, store, user));
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
    PAYPAL_CLIENT_ID: !!env.PAYPAL_CLIENT_ID,
    PAYPAL_CLIENT_SECRET: !!env.PAYPAL_CLIENT_SECRET,
  };
  return {
    version: 1,
    name: 'תמלול',
    stats: [
      { label: 'השתמשו החודש', value: d.activeUsers },
      { label: 'דקות החודש (מהיר)', value: minutes('fast') },
      { label: 'דקות החודש (מדויק)', value: minutes('strong') },
      { label: 'עלות OpenAI החודש', value: '$' + Math.round(costUsd * 100) / 100 },
      { label: 'חבילות דקות החודש', value: d.packs.n },
      { label: 'הכנסה מחבילות החודש', value: '₪' + Math.round(d.packs.revenue * 100) / 100 },
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
