import { PLANS, PAID_PLAN_KEYS, STRONG_WEIGHT, COST_PER_MINUTE, CURRENCY_DEFAULT, modelIds, rank } from './plans.js';
import {
  paypalEnv, getSubscription, cancelSubscription, createProductAndPlans, createPlan,
} from './paypal.js';
import { transcribeWav, parseWavHeader, MAX_UPLOAD_BYTES } from './openai.js';
import { sendTranscriptEmail } from './mail.js';
import {
  authenticate, forgetUser, ssoPlan, pickFeatures, planDefs, dashboardPlans, setDashboardPlan, clientId,
} from './sso.js';
import {
  validateCoupon, couponOffer, couponLabel, couponProblem, billingCycles, normalizeCode,
} from './coupons.js';

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
  if (path === '/api/coupon/check' && method === 'POST') return checkCoupon(request, env, store, user);
  if (path === '/api/coupon/redeem' && method === 'POST') return redeemGift(request, env, store, user);

  if (path.startsWith('/api/admin/')) {
    if (!isAdmin(env, user)) return json({ error: 'forbidden', message: 'אין הרשאת מנהל' }, 403);
    if (path === '/api/admin/stats' && method === 'GET') return adminStats(env, store);
    if (path === '/api/admin/paypal-setup' && method === 'POST') return adminPaypalSetup(env, store);
    if (path === '/api/admin/coupons' && method === 'GET') return json({ coupons: await couponList(env, store) });
    if (path === '/api/admin/coupons' && method === 'POST') return adminCreateCoupon(request, env, store);
    const m = path.match(/^\/api\/admin\/coupons\/([A-Za-z0-9_-]+)(\/(enable|disable))?$/);
    if (m && method === 'POST' && m[3]) {
      await store.setCouponActive(m[1], m[3] === 'enable');
      return json({ coupons: await couponList(env, store) });
    }
    if (m && method === 'DELETE' && !m[2]) {
      const r = await store.deleteCoupon(m[1]);
      if (r === 'used') return json({ error: 'used', message: 'אי אפשר למחוק קוד שכבר נוצל. אפשר להשבית אותו' }, 400);
      return json({ coupons: await couponList(env, store) });
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

const currencyOf = env => env.CURRENCY || CURRENCY_DEFAULT;

function monthStart(now = Date.now()) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function nextMonthStart(now = Date.now()) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

function addMonths(ts, n = 1) {
  const d = new Date(ts);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.getTime();
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

// ---------- config ----------

async function publicConfig(env) {
  const store = getStore(env);
  const pp = await store.getSetting('paypal:' + paypalEnv(env));
  const defs = await planDefs(env);
  return {
    ssoClientId: clientId(env),
    currency: currencyOf(env),
    strongWeight: STRONG_WEIGHT,
    maxUploadBytes: MAX_UPLOAD_BYTES,
    plans: Object.entries(defs).map(([key, p]) => ({ key, ...p, paypalPlanId: pp?.plans?.[key] || null })),
    paypal: env.PAYPAL_CLIENT_ID && pp ? { clientId: env.PAYPAL_CLIENT_ID, env: paypalEnv(env) } : null,
  };
}

// ---------- PayPal subscriptions ----------

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
  if (!paidUntil) paidUntil = addMonths(periodStart) + DAY;

  return { email, sub_id: sub.id, plan_key: planKey, status: sub.status, period_start: periodStart, paid_until: paidUntil };
}

function subIsActive(sub, now = Date.now()) {
  if (!sub || !PLANS[sub.plan_key]) return false;
  if (sub.status === 'ACTIVE') return true;
  // A cancelled subscription keeps working until the end of the month it paid for.
  if (sub.status === 'CANCELLED') return sub.paid_until > now;
  return false;
}

// Saves a subscription and mirrors it to reem.bi, so the dashboard shows who pays
// for which plan until when. A failed or skipped sync is retried on the next refresh.
async function saveSub(env, store, user, rec) {
  const saved = await store.saveSub(rec);
  const signature = rec.plan_key + ':' + rec.paid_until;
  if (saved.synced !== signature && env.SSO_SITE_KEY && (rec.status === 'ACTIVE' || rec.status === 'CANCELLED')) {
    const dash = ssoPlan(env, user);
    // Don't overwrite a better plan the admin granted by hand.
    const better = dash.key && rank(dash.key) > rank(rec.plan_key) && (!dash.expiresAt || dash.expiresAt > rec.paid_until);
    if (!better) {
      try {
        await setDashboardPlan(env, user.email, rec.plan_key, rec.paid_until);
        await store.markSynced(user.email, signature);
        forgetUser(user);
      } catch (e) {
        console.error('reem.bi sync failed', e.message);
      }
    }
  }
  return saved;
}

async function refreshSub(env, store, user, prev) {
  const sub = await getSubscription(env, prev.sub_id);
  const planKey = (await store.planKeyFor(sub.plan_id)) || prev.plan_key;
  return saveSub(env, store, user, subRecord(user.email, sub, planKey, prev));
}

async function paypalEntitlement(env, store, user) {
  const now = Date.now();
  let sub = await store.getSub(user.email);
  if (sub && !['CANCELLED', 'EXPIRED'].includes(sub.status)) {
    const stale = sub.status === 'ACTIVE' && now < sub.paid_until ? 6 * HOUR : 10 * 60000;
    if (now - sub.checked_at > stale) {
      try { sub = await refreshSub(env, store, user, sub); } catch (e) { console.error('refresh failed', e.message); }
    }
  }
  return { sub, active: subIsActive(sub, now) };
}

// ---------- what the user may do ----------

// Combines the PayPal subscription and the plan set in the reem.bi dashboard; the better one wins.
async function entitlement(env, store, user) {
  const now = Date.now();
  const defs = await planDefs(env);
  const { sub, active } = await paypalEntitlement(env, store, user);
  const dash = ssoPlan(env, user);

  let key = 'free', source = 'free', periodStart = monthStart(now), periodEnd = nextMonthStart(now), planExpiresAt = null;
  if (active && (!dash.key || rank(sub.plan_key) >= rank(dash.key))) {
    key = sub.plan_key; source = 'paypal'; periodStart = sub.period_start; periodEnd = sub.paid_until;
  } else if (dash.key && dash.key !== 'free') {
    key = dash.key; source = 'dashboard'; planExpiresAt = dash.expiresAt;
  }

  // Per-plan settings, plus whatever the dashboard sets for this user on this plan
  // (or the user's personal overrides when they're on the default plan).
  const sameAsDashboard = dash.key === key || (!dash.key && key === 'free');
  const plan = { ...defs[key], ...(sameAsDashboard ? pickFeatures(dash.features) : {}) };
  return { key, plan, source, periodStart, periodEnd, planExpiresAt, sub };
}

async function accountState(env, store, user) {
  const ent = await entitlement(env, store, user);
  const used = await store.usedSince(user.email, ent.periodStart);
  return {
    user: { email: user.email, name: user.name },
    plan: { key: ent.key, name: ent.plan.name, credits: ent.plan.credits, source: ent.source },
    features: { strong: !!ent.plan.strong, email: !!ent.plan.email },
    used: Math.round(used * 100) / 100,
    remaining: Math.max(0, Math.round((ent.plan.credits - used) * 100) / 100),
    periodEnd: ent.periodEnd,
    planExpiresAt: ent.planExpiresAt,
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

  // A discounted plan: the coupon may be used once per person.
  const couponPlan = await store.couponForPlan(sub.plan_id);
  if (couponPlan && !(await store.redeem(couponPlan.code, user.email, sub.id))) {
    try { await cancelSubscription(env, sub.id, 'Coupon already used'); } catch { /* ignore */ }
    return json({ error: 'coupon_used', message: 'כבר השתמשת בקוד הקופון הזה. המנוי בוטל' }, 400);
  }

  const prev = await store.getSub(user.email);
  if (prev && prev.sub_id !== sub.id && prev.status === 'ACTIVE') {
    // Switching plans: stop billing the old subscription.
    try { await cancelSubscription(env, prev.sub_id, 'Switched to another plan'); }
    catch (e) { console.error('cancel old sub failed', e.message); }
  }
  await saveSub(env, store, user, subRecord(user.email, sub, planKey, prev));
  return json(await accountState(env, store, user));
}

async function cancel(env, store, user) {
  const sub = await store.getSub(user.email);
  if (!sub || sub.status !== 'ACTIVE') return json({ error: 'no_subscription', message: 'אין מנוי פעיל' }, 400);
  await cancelSubscription(env, sub.sub_id, 'Cancelled by the user');
  try { await refreshSub(env, store, user, sub); }
  catch { await store.saveSub({ ...sub, status: 'CANCELLED' }); }
  return json(await accountState(env, store, user));
}

// ---------- coupons ----------

async function usableCoupon(store, code, email) {
  const coupon = await store.getCoupon(normalizeCode(code));
  const problem = couponProblem(coupon);
  if (problem) return { problem };
  if (await store.redemption(coupon.code, email)) return { problem: 'כבר השתמשת בקוד הזה' };
  return { coupon };
}

// Makes sure the coupon has a PayPal plan for every plan it applies to, at today's prices.
async function ensureCouponPlans(env, store, coupon) {
  const ppEnv = paypalEnv(env);
  const currency = currencyOf(env);
  const setting = await store.getSetting('paypal:' + ppEnv);
  if (!setting?.productId) throw Object.assign(new Error('התשלומים עוד לא הופעלו באתר'), { status: 400 });
  const existing = await store.couponPlans(coupon.code, ppEnv);
  const out = {};
  for (const key of coupon.plan_keys) {
    const offer = couponOffer(coupon, key);
    if (!offer) continue;
    let row = existing.find(r => r.plan_key === key && r.price === PLANS[key].price && r.currency === currency);
    if (!row) {
      const id = await createPlan(env, {
        productId: setting.productId,
        name: `תמלול - ${PLANS[key].name} (${coupon.code})`,
        description: couponLabel(coupon, currency),
        cycles: billingCycles(offer, currency),
      });
      row = { paypal_plan_id: id, code: coupon.code, plan_key: key, env: ppEnv, price: PLANS[key].price, currency };
      await store.saveCouponPlan(row);
    }
    out[key] = { ...offer, paypalPlanId: row.paypal_plan_id };
  }
  return out;
}

async function checkCoupon(request, env, store, user) {
  const { code } = await readJson(request);
  const { coupon, problem } = await usableCoupon(store, code, user.email);
  if (problem) return json({ error: 'bad_coupon', message: problem }, 400);
  const base = { code: coupon.code, type: coupon.type, label: couponLabel(coupon, currencyOf(env)) };
  if (coupon.type === 'gift') return json({ ...base, planKey: coupon.plan_keys[0], months: coupon.months });
  const offers = await ensureCouponPlans(env, store, coupon);
  if (!Object.keys(offers).length) return json({ error: 'bad_coupon', message: 'הקוד לא מתאים לאף תוכנית' }, 400);
  return json({ ...base, offers });
}

async function redeemGift(request, env, store, user) {
  const { code } = await readJson(request);
  const { coupon, problem } = await usableCoupon(store, code, user.email);
  if (problem) return json({ error: 'bad_coupon', message: problem }, 400);
  if (coupon.type !== 'gift') return json({ error: 'bad_coupon', message: 'הקוד הזה הוא הנחה למנוי. בחרו תוכנית למטה' }, 400);
  if (!env.SSO_SITE_KEY) return json({ error: 'not_configured', message: 'מתנות עוד לא הופעלו באתר' }, 500);

  const key = coupon.plan_keys[0];
  const ent = await entitlement(env, store, user);
  if (ent.source === 'paypal' && rank(ent.key) >= rank(key)) {
    return json({ error: 'has_plan', message: 'כבר יש לך מנוי בתשלום לתוכנית הזו או לתוכנית גבוהה יותר' }, 400);
  }
  const dash = ssoPlan(env, user);
  if (dash.key && rank(dash.key) > rank(key) && (!dash.expiresAt || dash.expiresAt > Date.now())) {
    return json({ error: 'has_plan', message: 'כבר יש לך תוכנית גבוהה יותר' }, 400);
  }
  // Another gift of the same plan adds on top of the time left.
  const base = dash.key === key && dash.expiresAt && dash.expiresAt > Date.now() ? dash.expiresAt : Date.now();
  if (!(await store.redeem(coupon.code, user.email, null))) return json({ error: 'bad_coupon', message: 'כבר השתמשת בקוד הזה' }, 400);
  try {
    await setDashboardPlan(env, user.email, key, addMonths(base, coupon.months));
  } catch (e) {
    await store.unredeem(coupon.code, user.email);
    throw e;
  }
  forgetUser(user);
  const fresh = await authenticate(new Request('https://x/', { headers: { Authorization: user.cacheKey } }), env);
  return json(await accountState(env, store, fresh || user));
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
  let costUsd = 0;
  for (const row of stats.usage) costUsd += (row.seconds / 60) * (COST_PER_MINUTE[row.model] || 0);
  const dash = await dashboardPlans(env, { fresh: true }); // the admin page always shows the current state
  const wanted = Object.keys(PLANS).map(k => clientId(env) + ':' + k);
  return json({
    ...stats,
    models: modelIds(env),
    estimatedOpenAiCostUsd: Math.round(costUsd * 100) / 100,
    paypalEnv: paypalEnv(env),
    paypal: await store.getSetting('paypal:' + paypalEnv(env)),
    plans: await planDefs(env),
    currency: currencyOf(env),
    dashboard: dash.error
      ? { error: dash.error }
      : { missing: wanted.filter(id => !dash.ids.includes(id)), found: dash.ids, defaultPlan: dash.defaultPlan, expectedDefault: clientId(env) + ':free' },
    configured: {
      OPENAI_API_KEY: !!env.OPENAI_API_KEY,
      PAYPAL_CLIENT_ID: !!env.PAYPAL_CLIENT_ID,
      PAYPAL_CLIENT_SECRET: !!env.PAYPAL_CLIENT_SECRET,
      RESEND_API_KEY: !!env.RESEND_API_KEY,
      MAIL_FROM: !!env.MAIL_FROM,
      SSO_SITE_KEY: !!env.SSO_SITE_KEY,
    },
  });
}

async function adminPaypalSetup(env, store) {
  const currency = currencyOf(env);
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

async function couponList(env, store) {
  return (await store.listCoupons()).map(c => ({ ...c, label: couponLabel(c, currencyOf(env)) }));
}

async function adminCreateCoupon(request, env, store) {
  let coupon;
  try { coupon = validateCoupon(await readJson(request)); }
  catch (e) { return json({ error: 'bad_coupon', message: e.message }, 400); }
  if (!(await store.createCoupon(coupon))) return json({ error: 'exists', message: 'כבר קיים קוד כזה' }, 400);
  return json({ coupons: await couponList(env, store) });
}
