import { PLANS, PAID_PLAN_KEYS, STRONG_WEIGHT, COST_PER_MINUTE, CURRENCY_DEFAULT, modelIds } from './plans.js';
import { paypalEnv, getSubscription, cancelSubscription, createProductAndPlans } from './paypal.js';
import { transcribeWav, parseWavHeader, MAX_UPLOAD_BYTES } from './openai.js';
import { sendTranscriptEmail } from './mail.js';

export { Store } from './store.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const EMAILS_PER_DAY = 20;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await route(request, env, url);
    } catch (e) {
      console.error(e);
      return json({ error: 'server', message: e.message || 'שגיאת שרת' }, e.status && e.status < 500 ? e.status : 500);
    }
  },
};

async function route(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/config' && method === 'GET') return json(await publicConfig(env));

  const user = await authenticate(request, env);
  if (!user) return json({ error: 'unauthorized', message: 'צריך להתחבר' }, 401);
  const store = getStore(env);
  await store.touchUser(user.email, user.name);

  if (path === '/api/me' && method === 'GET') return json(await accountState(env, store, user));
  if (path === '/api/transcribe' && method === 'POST') return transcribe(request, env, store, user, url);
  if (path === '/api/email' && method === 'POST') return email(request, env, store, user);
  if (path === '/api/subscription/activate' && method === 'POST') return activate(request, env, store, user);
  if (path === '/api/subscription/cancel' && method === 'POST') return cancel(env, store, user);

  if (path.startsWith('/api/admin/')) {
    if (!isAdmin(env, user)) return json({ error: 'forbidden', message: 'אין הרשאת מנהל' }, 403);
    if (path === '/api/admin/stats' && method === 'GET') return adminStats(env, store);
    if (path === '/api/admin/paypal-setup' && method === 'POST') return adminPaypalSetup(env, store);
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

// ---------- authentication (reem.bi SSO) ----------

const userCache = new Map(); // token -> { user, expires }

async function authenticate(request, env) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ') || header.length < 15) return null;
  const cached = userCache.get(header);
  if (cached && cached.expires > Date.now()) return cached.user;

  const res = await fetch((env.SSO_URL || 'https://login.reembir.com') + '/api/userinfo', {
    headers: { Authorization: header },
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data?.user?.email) return null;
  const user = { id: data.user.id, email: String(data.user.email).toLowerCase(), name: data.user.name || '' };

  if (userCache.size > 500) userCache.clear();
  userCache.set(header, { user, expires: Date.now() + 60000 });
  return user;
}

// ---------- config ----------

async function publicConfig(env) {
  const store = getStore(env);
  const pp = await store.getSetting('paypal:' + paypalEnv(env));
  return {
    ssoClientId: env.SSO_CLIENT_ID || 'timlul',
    currency: env.CURRENCY || CURRENCY_DEFAULT,
    strongWeight: STRONG_WEIGHT,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    plans: Object.entries(PLANS).map(([key, p]) => ({ key, ...p, paypalPlanId: pp?.plans?.[key] || null })),
    paypal: env.PAYPAL_CLIENT_ID && pp ? { clientId: env.PAYPAL_CLIENT_ID, env: paypalEnv(env) } : null,
  };
}

// ---------- subscriptions & quota ----------

function addMonth(ts) {
  const d = new Date(ts);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.getTime();
}

// Builds our record of a PayPal subscription.
function subRecord(email, sub, planKey, prev) {
  const same = prev && prev.sub_id === sub.id;
  const next = Date.parse(sub.billing_info?.next_billing_time || '') || null;
  const lastPay = Date.parse(sub.billing_info?.last_payment?.time || '') || null;
  const start = lastPay || Date.parse(sub.start_time || '') || Date.now();

  let periodStart = same ? prev.period_start : null;
  let paidUntil = same ? prev.paid_until : null;
  if (sub.status === 'ACTIVE') {
    periodStart = start;
    if (next) paidUntil = next + DAY; // a day of grace for the renewal charge
  }
  if (!periodStart) periodStart = start;
  if (!paidUntil) paidUntil = addMonth(periodStart) + DAY;

  return { email, sub_id: sub.id, plan_key: planKey, status: sub.status, period_start: periodStart, paid_until: paidUntil };
}

function subIsActive(sub, now = Date.now()) {
  if (!sub || !PLANS[sub.plan_key]) return false;
  if (sub.status === 'ACTIVE') return true;
  // A cancelled subscription keeps working until the end of the month it paid for.
  if (sub.status === 'CANCELLED') return sub.paid_until > now;
  return false;
}

async function refreshSub(env, store, email, prev) {
  const sub = await getSubscription(env, prev.sub_id);
  const planKey = (await store.planKeyFor(sub.plan_id)) || prev.plan_key;
  return store.saveSub(subRecord(email, sub, planKey, prev));
}

async function entitlement(env, store, email) {
  const now = Date.now();
  let sub = await store.getSub(email);
  if (sub && !['CANCELLED', 'EXPIRED'].includes(sub.status)) {
    const stale = sub.status === 'ACTIVE' && now < sub.paid_until ? 6 * HOUR : 10 * 60000;
    if (now - sub.checked_at > stale) {
      try { sub = await refreshSub(env, store, email, sub); } catch (e) { console.error('refresh failed', e.message); }
    }
  }
  if (subIsActive(sub, now)) {
    return { planKey: sub.plan_key, periodStart: sub.period_start, periodEnd: sub.paid_until, sub };
  }
  return { planKey: 'free', periodStart: monthStart(now), periodEnd: nextMonthStart(now), sub };
}

async function accountState(env, store, user) {
  const ent = await entitlement(env, store, user.email);
  const plan = PLANS[ent.planKey];
  const used = await store.usedSince(user.email, ent.periodStart);
  return {
    user: { email: user.email, name: user.name },
    plan: { key: ent.planKey, name: plan.name, credits: plan.credits },
    used: Math.round(used * 100) / 100,
    remaining: Math.max(0, Math.round((plan.credits - used) * 100) / 100),
    periodEnd: ent.periodEnd,
    subscription: ent.sub ? { status: ent.sub.status, planKey: ent.sub.plan_key, paidUntil: ent.sub.paid_until } : null,
    isAdmin: isAdmin(env, user),
  };
}

async function activate(request, env, store, user) {
  const { subscriptionId } = await readJson(request);
  if (!subscriptionId || typeof subscriptionId !== 'string') return json({ error: 'bad_request' }, 400);

  const sub = await getSubscription(env, subscriptionId);
  if ((sub.custom_id || '').toLowerCase() !== user.email) {
    return json({ error: 'forbidden', message: 'המנוי הזה לא שייך לחשבון שלך' }, 403);
  }
  const planKey = await store.planKeyFor(sub.plan_id);
  if (!planKey) return json({ error: 'unknown_plan', message: 'תוכנית לא מוכרת' }, 400);

  const prev = await store.getSub(user.email);
  if (prev && prev.sub_id !== sub.id && prev.status === 'ACTIVE') {
    // Switching plans: stop billing the old subscription.
    try { await cancelSubscription(env, prev.sub_id, 'Switched to another plan'); }
    catch (e) { console.error('cancel old sub failed', e.message); }
  }
  await store.saveSub(subRecord(user.email, sub, planKey, prev));
  return json(await accountState(env, store, user));
}

async function cancel(env, store, user) {
  const sub = await store.getSub(user.email);
  if (!sub || sub.status !== 'ACTIVE') return json({ error: 'no_subscription', message: 'אין מנוי פעיל' }, 400);
  await cancelSubscription(env, sub.sub_id, 'Cancelled by the user');
  try { await refreshSub(env, store, user.email, sub); }
  catch { await store.saveSub({ ...sub, status: 'CANCELLED' }); }
  return json(await accountState(env, store, user));
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
  const ent = await entitlement(env, store, user.email);
  const plan = PLANS[ent.planKey];
  const reservation = await store.reserve(user.email, ent.periodStart, plan.credits, kind, seconds, credits);
  if (!reservation.ok) {
    reader.cancel().catch(() => {});
    return json({ error: 'quota', message: 'נגמרו הדקות בתוכנית שלך לחודש הזה', used: reservation.used, limit: plan.credits }, 402);
  }

  try {
    const text = await transcribeWav(env, {
      model: modelIds(env)[kind], language: lang, prompt, head, reader, body: request.body, length,
    });
    return json({ text, used: reservation.used, limit: plan.credits });
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
  const { text, filename } = await readJson(request);
  if (typeof text !== 'string' || !text.trim()) return json({ error: 'bad_request', message: 'אין טקסט לשליחה' }, 400);
  if (text.length > 2000000) return json({ error: 'too_large', message: 'הטקסט ארוך מדי לשליחה במייל' }, 413);
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return json({ error: 'not_configured', message: 'שליחת מייל לא הוגדרה' }, 500);
  if (!(await store.allowEmail(user.email, EMAILS_PER_DAY))) {
    return json({ error: 'rate_limited', message: 'שלחת יותר מדי מיילים היום' }, 429);
  }
  await sendTranscriptEmail(env, { to: user.email, text, filename: String(filename || 'transcript').slice(0, 120) });
  return json({ ok: true, to: user.email });
}

// ---------- admin ----------

async function adminStats(env, store) {
  const stats = await store.stats(monthStart());
  const ids = modelIds(env);
  let costUsd = 0;
  for (const row of stats.usage) costUsd += (row.seconds / 60) * (COST_PER_MINUTE[row.model] || 0);
  return json({
    ...stats,
    models: ids,
    estimatedOpenAiCostUsd: Math.round(costUsd * 100) / 100,
    paypalEnv: paypalEnv(env),
    paypal: await store.getSetting('paypal:' + paypalEnv(env)),
    plans: PLANS,
    currency: env.CURRENCY || CURRENCY_DEFAULT,
    configured: {
      OPENAI_API_KEY: !!env.OPENAI_API_KEY,
      PAYPAL_CLIENT_ID: !!env.PAYPAL_CLIENT_ID,
      PAYPAL_CLIENT_SECRET: !!env.PAYPAL_CLIENT_SECRET,
      RESEND_API_KEY: !!env.RESEND_API_KEY,
      MAIL_FROM: !!env.MAIL_FROM,
    },
  });
}

async function adminPaypalSetup(env, store) {
  const currency = env.CURRENCY || CURRENCY_DEFAULT;
  const paid = PAID_PLAN_KEYS.map(k => [k, PLANS[k]]);
  const result = await createProductAndPlans(env, paid, currency);
  for (const [key, id] of Object.entries(result.plans)) await store.mapPlan(id, key);
  const setting = {
    ...result,
    currency,
    prices: Object.fromEntries(paid.map(([k, p]) => [k, p.price])),
    createdAt: Date.now(),
  };
  await store.setSetting('paypal:' + paypalEnv(env), setting);
  return json(setting);
}
