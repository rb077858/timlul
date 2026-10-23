// Integration tests: runs the built Worker in Miniflare with every outside
// service (reem.bi, OpenAI, PayPal, Resend) mocked. `npm test` builds first.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { encodeWav, planChunks, SAMPLE_RATE } from '../public/audio.js';

const calls = [];
let openaiFails = false;
const subs = {};
const createdPlans = {};
let planCounter = 0;

// reem.bi state: plans of the site and each user's access.
const DASH_PLANS = [
  { id: 'timlul:free', features: { minutes: 10, strong: false, email: false } },
  { id: 'timlul:basic', features: { minutes: 180 } },
  { id: 'timlul:pro', features: { minutes: 700 } }, // the dashboard overrides the 600 in plans.js
  { id: 'timlul:business', features: {} },
  { id: 'timlul:unlimited', features: { unlimited: true } }, // hidden plan, given by hand
];
const dashAccess = {}; // email -> { plan_id, plan_expires_at }

function accessFor(email) {
  const a = dashAccess[email] || {};
  const expired = a.plan_id && a.plan_expires_at && a.plan_expires_at * 1000 < Date.now();
  const planId = a.plan_id && !expired ? a.plan_id : 'timlul:free';
  const plan = DASH_PLANS.find(p => p.id === planId);
  return {
    status: 'active',
    plan: { id: planId, name: planId },
    plan_expires_at: a.plan_id && !expired ? a.plan_expires_at : null,
    features: { ...plan.features, ...(a.override || {}) },
  };
}

async function mock(req) {
  const url = new URL(req.url);
  const auth = req.headers.get('authorization') || '';
  calls.push({ url: req.url, method: req.method });

  if (url.host === 'login.reembir.com') {
    if (url.pathname === '/api/userinfo') {
      const m = auth.match(/^Bearer tok-(.+)$/);
      if (!m) return new Response('no', { status: 401 });
      const email = m[1].toLowerCase();
      return Response.json({ user: { id: 'u-' + email, email: email.toUpperCase(), name: 'Test' }, access: accessFor(email) });
    }
    if (req.headers.get('x-site-key') !== 'rsk_test') return Response.json({ message: 'bad key' }, { status: 401 });
    if (url.pathname === '/api/site/plans') {
      return Response.json({ site: { id: 'timlul', default_plan: 'timlul:free' }, plans: DASH_PLANS });
    }
    if (url.pathname === '/api/site/access' && req.method === 'PUT') {
      const body = await req.json();
      dashAccess[body.email] = { ...(dashAccess[body.email] || {}), plan_id: body.plan_id, plan_expires_at: body.expires_at };
      return Response.json({ email: body.email, ...dashAccess[body.email] });
    }
  }
  if (url.host === 'api.openai.com') {
    const body = new Uint8Array(await req.arrayBuffer());
    calls.at(-1).body = body;
    calls.at(-1).contentType = req.headers.get('content-type');
    if (openaiFails) return Response.json({ error: { message: 'boom' } }, { status: 500 });
    return Response.json({ text: ' שלום עולם ' });
  }
  if (url.host === 'api-m.paypal.com') {
    if (url.pathname === '/v1/oauth2/token') return Response.json({ access_token: 'pp', expires_in: 3600 });
    if (url.pathname === '/v1/catalogs/products') return Response.json({ id: 'PROD-1' });
    if (url.pathname === '/v1/billing/plans') {
      const body = await req.json();
      const cycles = body.billing_cycles;
      const id = cycles.length === 1 && !body.name.includes('(')
        ? 'P-' + cycles[0].pricing_scheme.fixed_price.value
        : 'PC-' + ++planCounter;
      createdPlans[id] = body;
      return Response.json({ id });
    }
    const m = url.pathname.match(/^\/v1\/billing\/subscriptions\/([^/]+)(\/cancel)?$/);
    if (m && m[2]) { subs[m[1]].status = 'CANCELLED'; delete subs[m[1]].billing_info.next_billing_time; return new Response(null, { status: 204 }); }
    if (m) return subs[m[1]] ? Response.json(subs[m[1]]) : Response.json({ message: 'not found' }, { status: 404 });
  }
  if (url.host === 'api.resend.com') {
    calls.at(-1).json = await req.json();
    return Response.json({ id: 'email-1' });
  }
  return new Response('unexpected ' + req.url, { status: 599 });
}

let mf;
before(async () => {
  mf = new Miniflare({
    modules: true,
    scriptPath: 'dist/index.js',
    compatibilityDate: '2025-09-01',
    durableObjects: { STORE: { className: 'Store', useSQLite: true } },
    bindings: {
      OPENAI_API_KEY: 'sk-test', PAYPAL_CLIENT_ID: 'cid', PAYPAL_CLIENT_SECRET: 'secret',
      RESEND_API_KEY: 're-test', MAIL_FROM: 'Timlul <t@example.com>', ADMIN_EMAILS: 'boss@example.com',
      SSO_SITE_KEY: 'rsk_test',
    },
    serviceBindings: { ASSETS: () => new Response('asset') },
    outboundService: mock,
  });
});
after(() => mf?.dispose());

const BASE = 'http://localhost';
const as = email => ({ Authorization: 'Bearer tok-' + email });
const post = (path, email, body) => mf.dispatchFetch(BASE + path, {
  method: 'POST', headers: { ...as(email), 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
});

function tone(seconds) {
  const n = Math.round(seconds * SAMPLE_RATE);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = 0.3 * Math.sin(i / 5);
  return s;
}

async function wav(seconds) {
  return new Uint8Array(await encodeWav(tone(seconds), 0, Math.round(seconds * SAMPLE_RATE)).arrayBuffer());
}

async function transcribe(email, seconds, model = 'fast', bytes) {
  const body = bytes || await wav(seconds);
  return mf.dispatchFetch(`${BASE}/api/transcribe?model=${model}&lang=he&prompt=${encodeURIComponent('רשימת מילים')}`, {
    method: 'POST', headers: { ...as(email), 'Content-Type': 'audio/wav', 'Content-Length': String(body.byteLength) }, body,
  });
}

const me = async email => (await mf.dispatchFetch(BASE + '/api/me', { headers: as(email) })).json();

function activeSub(id, planId, email) {
  const now = new Date().toISOString();
  subs[id] = { id, status: 'ACTIVE', plan_id: planId, custom_id: email, start_time: now,
    billing_info: { next_billing_time: new Date(Date.now() + 30 * 86400000).toISOString(), last_payment: { time: now } } };
}

test('config is public, uses dashboard minutes, and assets fall through', async () => {
  const c = await (await mf.dispatchFetch(BASE + '/api/config')).json();
  assert.equal(c.ssoClientId, 'timlul');
  assert.equal(c.paypal, null);
  assert.deepEqual(c.plans.map(p => p.key), ['free', 'basic', 'pro', 'business']);
  assert.equal(c.plans.find(p => p.key === 'pro').credits, 700);
  assert.equal(c.plans.find(p => p.key === 'business').credits, 1500, 'falls back to plans.js');
  assert.equal(c.plans.find(p => p.key === 'free').strong, false);
  assert.equal(await (await mf.dispatchFetch(BASE + '/')).text(), 'asset');
});

test('requires login', async () => {
  assert.equal((await mf.dispatchFetch(BASE + '/api/me')).status, 401);
  assert.equal((await mf.dispatchFetch(BASE + '/api/me', { headers: { Authorization: 'Bearer nope-123456789' } })).status, 401);
});

test('free plan: quota, fast model only, streaming to OpenAI', async () => {
  const user = 'a@example.com';
  let m = await me(user);
  assert.equal(m.plan.key, 'free');
  assert.equal(m.remaining, 10);
  assert.deepEqual(m.features, { strong: false, email: false });

  let res = await transcribe(user, 60);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).text, 'שלום עולם');
  const call = calls.findLast(c => c.url.includes('openai'));
  const bodyText = new TextDecoder('latin1').decode(call.body);
  assert.match(call.contentType, /^multipart\/form-data; boundary=/);
  assert.match(bodyText, /name="model"\r\n\r\ngpt-4o-mini-transcribe\r\n/);
  assert.match(bodyText, /name="language"\r\n\r\nhe\r\n/);
  assert.ok(call.body.byteLength > 60 * 32000, 'whole file was forwarded');
  assert.ok(bodyText.endsWith('--\r\n'));

  res = await transcribe(user, 30, 'strong');
  assert.equal(res.status, 403, 'accurate model is for paid plans');

  res = await transcribe(user, 240);
  assert.equal(res.status, 200);
  assert.equal((await me(user)).used, 5);

  res = await transcribe(user, 360);
  assert.equal(res.status, 402);
  assert.equal((await me(user)).used, 5);
});

test('free plan cannot email; paid plans can', async () => {
  const send = email => post('/api/email', email, { text: 'תמלול לדוגמה', filename: 'meeting' });
  assert.equal((await send('d@example.com')).status, 403);

  dashAccess['d2@example.com'] = { plan_id: 'timlul:basic', plan_expires_at: Math.floor(Date.now() / 1000) + 86400 };
  const res = await send('d2@example.com');
  assert.equal(res.status, 200);
  const sent = calls.findLast(c => c.url.includes('resend')).json;
  assert.deepEqual(sent.to, ['d2@example.com']);
  assert.equal(sent.attachments[0].filename, 'meeting.txt');
  assert.equal(Buffer.from(sent.attachments[0].content, 'base64').toString('utf8'), '﻿תמלול לדוגמה');
});

test('plans granted in the reem.bi dashboard apply, with dashboard minutes', async () => {
  const user = 'e@example.com';
  dashAccess[user] = { plan_id: 'timlul:pro', plan_expires_at: Math.floor(Date.now() / 1000) + 10 * 86400 };
  let m = await me(user);
  assert.equal(m.plan.key, 'pro');
  assert.equal(m.plan.source, 'dashboard');
  assert.equal(m.plan.credits, 700);
  assert.ok(m.planExpiresAt > Date.now());
  assert.equal((await transcribe(user, 60, 'strong')).status, 200);

  // A personal override set on the user in the dashboard.
  dashAccess['e2@example.com'] = { plan_id: 'timlul:pro', plan_expires_at: null, override: { minutes: 5000 } };
  m = await me('e2@example.com');
  assert.equal(m.plan.credits, 5000);
  assert.equal(m.planExpiresAt, null);
});

test('rejects audio that is not the expected WAV', async () => {
  const bytes = await wav(5);
  new DataView(bytes.buffer).setUint16(22, 2, true); // claim stereo
  assert.equal((await transcribe('b@example.com', 5, 'fast', bytes)).status, 400);
});

test('failed transcription is not charged', async () => {
  openaiFails = true;
  const res = await transcribe('c@example.com', 60);
  openaiFails = false;
  assert.equal(res.status, 502);
  assert.equal((await me('c@example.com')).used, 0);
});

test('PayPal: setup, subscribe (synced to reem.bi), switch and cancel', async () => {
  assert.equal((await mf.dispatchFetch(BASE + '/api/admin/stats', { headers: as('a@example.com') })).status, 403);
  const setup = await (await post('/api/admin/paypal-setup', 'boss@example.com')).json();
  assert.deepEqual(setup.plans, { basic: 'P-9', pro: 'P-19', business: 'P-39' });
  const c = await (await mf.dispatchFetch(BASE + '/api/config')).json();
  assert.equal(c.paypal.clientId, 'cid');
  assert.equal(c.plans.find(p => p.key === 'pro').paypalPlanId, 'P-19');

  const user = 'a@example.com';
  activeSub('I-1', 'P-9', user);
  activeSub('I-2', 'P-19', 'other@example.com');
  const activate = id => post('/api/subscription/activate', user, { subscriptionId: id });
  assert.equal((await activate('I-2')).status, 403, 'someone else\'s subscription');

  let m = await (await activate('I-1')).json();
  assert.equal(m.plan.key, 'basic');
  assert.equal(m.plan.source, 'paypal');
  assert.equal(m.remaining, 180, 'usage from before the payment does not count');
  assert.equal(dashAccess[user].plan_id, 'timlul:basic');
  assert.ok(dashAccess[user].plan_expires_at * 1000 > Date.now() + 29 * 86400000, 'expiry = paid until');

  // Upgrade: the old subscription gets cancelled at PayPal.
  subs['I-2'].custom_id = user;
  m = await (await activate('I-2')).json();
  assert.equal(m.plan.key, 'pro');
  assert.equal(subs['I-1'].status, 'CANCELLED');
  assert.equal(dashAccess[user].plan_id, 'timlul:pro');

  m = await (await post('/api/subscription/cancel', user)).json();
  assert.equal(m.subscription.status, 'CANCELLED');
  assert.equal(m.plan.key, 'pro', 'keeps working until the paid month ends');

  const stats = await (await mf.dispatchFetch(BASE + '/api/admin/stats', { headers: as('boss@example.com') })).json();
  assert.ok(stats.users >= 3);
  assert.equal(stats.configured.SSO_SITE_KEY, true);
  assert.deepEqual(stats.dashboard.missing, []);
});

test('coupons: validation, discounts, free months, once per person', async () => {
  const admin = 'boss@example.com';
  const create = body => post('/api/admin/coupons', admin, body);
  assert.equal((await create({ code: 'X', type: 'percent', value: 10 })).status, 400, 'code too short');
  assert.equal((await create({ code: 'FOREVER100', type: 'percent', value: 100, months: 0 })).status, 400);
  assert.equal((await create({ code: 'GIFTNOPLAN', type: 'gift', months: 1 })).status, 400);
  assert.equal((await post('/api/admin/coupons', 'a@example.com', { code: 'HACK', type: 'gift' })).status, 403);

  assert.equal((await create({ code: 'half3', type: 'percent', value: 50, months: 3, plan_keys: ['pro'] })).status, 200);
  assert.equal((await create({ code: 'HALF3', type: 'percent', value: 50, months: 3 })).status, 400, 'duplicate');
  assert.equal((await create({ code: 'FREE1', type: 'trial', months: 1 })).status, 200);
  assert.equal((await create({ code: 'MINUS5', type: 'amount', value: 5, months: 0, max_uses: 1 })).status, 200);

  const user = 'f@example.com';
  const check = async code => post('/api/coupon/check', user, { code });

  let r = await (await check('half3')).json();
  assert.deepEqual(Object.keys(r.offers), ['pro']);
  assert.equal(r.offers.pro.firstPrice, 9.5);
  assert.equal(r.offers.pro.regularPrice, 19);
  const halfPlan = createdPlans[r.offers.pro.paypalPlanId];
  assert.equal(halfPlan.billing_cycles[0].tenure_type, 'TRIAL');
  assert.equal(halfPlan.billing_cycles[0].total_cycles, 3);
  assert.equal(halfPlan.billing_cycles[0].pricing_scheme.fixed_price.value, '9.5');
  assert.equal(halfPlan.billing_cycles[1].pricing_scheme.fixed_price.value, '19');
  const again = await (await check('HALF3')).json();
  assert.equal(again.offers.pro.paypalPlanId, r.offers.pro.paypalPlanId, 'PayPal plan is reused');

  r = await (await check('FREE1')).json();
  assert.deepEqual(Object.keys(r.offers), ['basic', 'pro', 'business']);
  const trial = createdPlans[r.offers.basic.paypalPlanId].billing_cycles;
  assert.equal(trial[0].pricing_scheme, undefined, 'free trial month');
  assert.equal(r.offers.basic.firstPrice, 0);

  r = await (await check('MINUS5')).json();
  assert.equal(r.offers.basic.firstPrice, 4);
  assert.equal(createdPlans[r.offers.basic.paypalPlanId].billing_cycles.length, 1, 'discount forever');

  // Subscribe with the discounted plan: counted once, can't be used again.
  activeSub('I-C1', r.offers.basic.paypalPlanId, user);
  let m = await (await post('/api/subscription/activate', user, { subscriptionId: 'I-C1' })).json();
  assert.equal(m.plan.key, 'basic');
  assert.equal((await check('MINUS5')).status, 400);
  assert.equal((await post('/api/coupon/check', 'g@example.com', { code: 'MINUS5' })).status, 400, 'max uses reached');

  // Same coupon plan on a second subscription by the same person is refused and cancelled.
  activeSub('I-C2', r.offers.basic.paypalPlanId, user);
  assert.equal((await post('/api/subscription/activate', user, { subscriptionId: 'I-C2' })).status, 400);
  assert.equal(subs['I-C2'].status, 'CANCELLED');

  assert.equal((await check('NOPE')).status, 400);
  await post('/api/admin/coupons/FREE1/disable', admin);
  assert.equal((await check('FREE1')).status, 400, 'disabled');

  const list = (await (await mf.dispatchFetch(BASE + '/api/admin/coupons', { headers: as(admin) })).json()).coupons;
  assert.equal(list.find(c => c.code === 'MINUS5').uses, 1);
  assert.equal(list.find(c => c.code === 'HALF3').label, '50% הנחה ל-3 החודשים הראשונים');
  assert.equal((await mf.dispatchFetch(BASE + '/api/admin/coupons/MINUS5', { method: 'DELETE', headers: as(admin) })).status, 400, 'used codes stay');
});

test('gift coupons give a plan through reem.bi without payment', async () => {
  await post('/api/admin/coupons', 'boss@example.com', { code: 'GIFT2', type: 'gift', months: 2, plan_keys: ['pro'] });
  const user = 'h@example.com';
  assert.equal((await post('/api/coupon/check', user, { code: 'GIFT2' })).status, 200);
  const m = await (await post('/api/coupon/redeem', user, { code: 'gift2' })).json();
  assert.equal(m.plan.key, 'pro');
  assert.equal(m.plan.source, 'dashboard');
  const days = (dashAccess[user].plan_expires_at * 1000 - Date.now()) / 86400000;
  assert.ok(days > 58 && days < 63, 'two months');
  assert.equal((await post('/api/coupon/redeem', user, { code: 'GIFT2' })).status, 400, 'once per person');

  // Someone paying for pro gets nothing from a pro gift.
  assert.equal((await post('/api/coupon/redeem', 'a@example.com', { code: 'GIFT2' })).status, 400);
});

test('chunking cuts at quiet moments and skips silence', () => {
  const sr = SAMPLE_RATE;
  const s = new Float32Array(12 * 60 * sr);
  for (let i = 0; i < s.length; i++) s[i] = 0.3 * Math.sin(i / 5);
  s.fill(0, Math.round(292 * sr), Math.round(293 * sr)); // a pause just before the 5-minute mark
  const chunks = planChunks(s);
  assert.equal(chunks.length, 3);
  assert.ok(chunks[0].end / sr > 292 && chunks[0].end / sr < 293, 'cut inside the pause');
  assert.equal(chunks.at(-1).end, s.length);
  assert.equal(planChunks(new Float32Array(120 * sr)).length, 0, 'silence is skipped');
  assert.ok(chunks.every(c => c.seconds <= 300));
});

test('the one-time cleanup removed the TEST coupon and a new TEST can be created', async () => {
  const admin = 'boss@example.com';
  assert.equal((await post('/api/admin/coupons', admin, { code: 'TEST', type: 'percent', value: 10, months: 1 })).status, 200);
  const list = (await (await mf.dispatchFetch(BASE + '/api/admin/coupons', { headers: as(admin) })).json()).coupons;
  assert.ok(list.some(c => c.code === 'TEST'), 'cleanup runs once, not on every start');
});

test('a hidden per-user "unlimited" permission gives unlimited minutes and all features', async () => {
  const user = 'vip@example.com';
  dashAccess[user] = { plan_id: null, override: { unlimited: true } }; // on the free default plan
  const m = await me(user);
  assert.equal(m.unlimited, true);
  assert.equal(m.remaining, null);
  assert.equal(m.plan.key, 'free', 'not a plan: the user stays on their plan');
  assert.deepEqual(m.features, { strong: true, email: true });
  for (let i = 0; i < 4; i++) { // 4 pieces of 5 minutes on the accurate model = 40 credits, far over the free 10
    assert.equal((await transcribe(user, 5 * 60, 'strong')).status, 200);
  }
  assert.equal((await me(user)).used, 40, 'usage is still recorded for the cost stats');

  dashAccess['vip2@example.com'] = { plan_id: null, override: { minutes: -1 } };
  assert.equal((await me('vip2@example.com')).unlimited, true);
  assert.equal((await me('a@example.com')).unlimited, false);
});

test('the hidden timlul:unlimited dashboard plan: named "ללא הגבלה", never offered or overwritten', async () => {
  const user = 'boss2@example.com';
  dashAccess[user] = { plan_id: 'timlul:unlimited', plan_expires_at: Math.floor(Date.now() / 1000) + 86400 };
  let m = await me(user);
  assert.ok(m.planExpiresAt > Date.now(), 'shows until when');
  assert.equal(m.unlimited, true);
  assert.equal(m.plan.name, 'ללא הגבלה');
  assert.equal(m.remaining, null);

  const c = await (await mf.dispatchFetch(BASE + '/api/config')).json();
  assert.ok(!c.plans.some(p => p.key === 'unlimited'), 'not on the pricing page');
  const stats = await (await mf.dispatchFetch(BASE + '/api/admin/stats', { headers: as('boss@example.com') })).json();
  assert.ok(!('unlimited' in stats.plans));

  // Paying for a plan doesn't replace the unlimited plan in the dashboard.
  activeSub('I-U1', 'P-9', user);
  m = await (await post('/api/subscription/activate', user, { subscriptionId: 'I-U1' })).json();
  assert.equal(m.unlimited, true);
  assert.equal(dashAccess[user].plan_id, 'timlul:unlimited');

  await post('/api/admin/coupons', 'boss@example.com', { code: 'GIFTU', type: 'gift', months: 1, plan_keys: ['basic'] });
  assert.equal((await post('/api/coupon/redeem', user, { code: 'GIFTU' })).status, 400);
  assert.equal(dashAccess[user].plan_id, 'timlul:unlimited');
});
