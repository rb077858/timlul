// Integration tests: runs the built Worker in Miniflare with every outside
// service (reem.bi, OpenAI, Resend) mocked. `npm test` builds first.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { encodeWav, planChunks, SAMPLE_RATE } from '../public/audio.js';

const calls = [];
let openaiFails = false;

// PayPal (sandbox): one-time orders for the minute packs.
const orders = {}; // id -> { body, captured }
let paypalPays = true;
let orderSeq = 0;

// reem.bi: the plans of the site and each user's access, as /api/userinfo reports them.
const PLANS = {
  'timlul:free': { name: 'חינם', features: { minutes: 10, strong: false, email: false } },
  'timlul:basic': { name: 'בסיסי', features: { minutes: 180, strong: true, email: true } },
  'timlul:pro': { name: 'מקצועי', features: { minutes: 700 } },
  'timlul:team': { name: 'צוות', features: { minutes: 5000, strong: true, email: true } },
  'timlul:business': { name: 'עסקי', features: { minutes: 3, strong: true, email: true } },
  'timlul:unlimited': { name: 'ללא הגבלה', features: { unlimited: true } },
};
const dash = {}; // email -> { plan, expires, override, subscription }

function accessFor(email) {
  const a = dash[email] || {};
  const planId = a.plan || 'timlul:free';
  return {
    status: 'active',
    plan: { id: planId, name: PLANS[planId].name },
    plan_expires_at: a.expires || null,
    features: { ...PLANS[planId].features, ...(a.override || {}) },
    subscription: a.subscription || null,
  };
}

async function mock(req) {
  const url = new URL(req.url);
  const auth = req.headers.get('authorization') || '';
  calls.push({ url: req.url, method: req.method });
  if (url.host === 'login.reembir.com' && url.pathname === '/api/userinfo') {
    const m = auth.match(/^Bearer tok-(.+)$/);
    if (!m) return new Response('no', { status: 401 });
    const email = m[1].toLowerCase();
    return Response.json({ user: { id: 'u-' + email, email: email.toUpperCase(), name: 'Test' }, access: accessFor(email) });
  }
  if (url.host === 'api.openai.com') {
    const body = new Uint8Array(await req.arrayBuffer());
    calls.at(-1).body = body;
    calls.at(-1).contentType = req.headers.get('content-type');
    if (openaiFails) return Response.json({ error: { message: 'boom' } }, { status: 500 });
    return Response.json({ text: ' שלום עולם ' });
  }
  if (url.host === 'api-m.sandbox.paypal.com') {
    if (url.pathname === '/v1/oauth2/token') {
      assert.equal(auth, 'Basic ' + btoa('pp-id:pp-secret'));
      return Response.json({ access_token: 'pp-token', expires_in: 3600 });
    }
    if (auth !== 'Bearer pp-token') return Response.json({ message: 'no' }, { status: 401 });
    const view = (id, o) => {
      const u = o.body.purchase_units[0];
      return {
        id, status: o.captured ? 'COMPLETED' : 'APPROVED',
        purchase_units: [{ ...u, payments: o.captured ? { captures: [{ status: 'COMPLETED', amount: u.amount }] } : undefined }],
      };
    };
    if (url.pathname === '/v2/checkout/orders' && req.method === 'POST') {
      const id = 'ORDER' + (++orderSeq);
      orders[id] = { body: await req.json(), captured: false };
      return Response.json({ id, status: 'CREATED' }, { status: 201 });
    }
    const m = url.pathname.match(/^\/v2\/checkout\/orders\/([^/]+)(\/capture)?$/);
    const o = m && orders[m[1]];
    if (!o) return Response.json({ message: 'not found' }, { status: 404 });
    if (m[2]) {
      if (o.captured) return Response.json({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] }, { status: 422 });
      if (!paypalPays) return Response.json({ name: 'UNPROCESSABLE_ENTITY', message: 'INSTRUMENT_DECLINED', details: [{ issue: 'INSTRUMENT_DECLINED' }] }, { status: 422 });
      o.captured = true;
    }
    return Response.json(view(m[1], o));
  }
  if (url.host === 'login.reembir.com' && url.pathname === '/api/email/me') {
    if (!/^Bearer tok-/.test(auth)) return Response.json({ message: 'no' }, { status: 401 });
    calls.at(-1).json = await req.json();
    calls.at(-1).auth = auth;
    return Response.json({ ok: true, to: auth.slice(11) });
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
      OPENAI_API_KEY: 'sk-test', ADMIN_EMAILS: 'boss@example.com',
      PAYPAL_CLIENT_ID: 'pp-id', PAYPAL_CLIENT_SECRET: 'pp-secret', PAYPAL_ENV: 'sandbox',
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

const me = async (email, fresh) => (await mf.dispatchFetch(BASE + '/api/me' + (fresh ? '?fresh=1' : ''), { headers: as(email) })).json();

test('config is public and assets fall through', async () => {
  const c = await (await mf.dispatchFetch(BASE + '/api/config')).json();
  assert.equal(c.ssoClientId, 'timlul');
  assert.equal(c.planDefaults.free.credits, 10);
  assert.equal(await (await mf.dispatchFetch(BASE + '/')).text(), 'asset');
});

test('requires login', async () => {
  assert.equal((await mf.dispatchFetch(BASE + '/api/me')).status, 401);
  assert.equal((await mf.dispatchFetch(BASE + '/api/me', { headers: { Authorization: 'Bearer nope-123456789' } })).status, 401);
  for (const old of ['/api/subscription/activate', '/api/coupon/check']) {
    assert.equal((await post(old, 'a@example.com')).status, 404, 'billing moved to reem.bi');
  }
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

  assert.equal((await transcribe(user, 30, 'strong')).status, 403, 'accurate model is for paid plans');
  assert.equal((await transcribe(user, 240)).status, 200);
  assert.equal((await me(user)).used, 5);
  assert.equal((await transcribe(user, 360)).status, 402);
  assert.equal((await me(user)).used, 5);
});

test('free plan cannot email; paid plans can', async () => {
  const send = email => post('/api/email', email, { text: 'תמלול לדוגמה', filename: 'meeting' });
  assert.equal((await send('d@example.com')).status, 403);
  dash['d2@example.com'] = { plan: 'timlul:basic' };
  const res = await send('d2@example.com');
  assert.equal(res.status, 200);
  const call = calls.findLast(c => c.url.includes('/api/email/me'));
  const sent = call.json;
  assert.equal(call.auth, 'Bearer tok-d2@example.com', 'sent as the user, so reem.bi mails only them');
  assert.equal(sent.to, undefined);
  assert.equal(sent.attachments[0].filename, 'meeting.txt');
  assert.equal(Buffer.from(sent.attachments[0].content, 'base64').toString('utf8'), '﻿תמלול לדוגמה');
});

test('the plan, its minutes and its features come from reem.bi', async () => {
  const exp = Math.floor(Date.now() / 1000) + 10 * 86400;
  dash['e@example.com'] = { plan: 'timlul:pro', expires: exp, subscription: { status: 'ACTIVE', plan_id: 'timlul:pro', paid_until: exp } };
  let m = await me('e@example.com');
  assert.equal(m.plan.key, 'pro');
  assert.equal(m.plan.name, 'מקצועי');
  assert.equal(m.plan.credits, 700, 'minutes from the plan JSON');
  assert.deepEqual(m.features, { strong: true, email: true }, 'defaults for pro');
  assert.equal(m.planExpiresAt, exp * 1000);
  assert.equal(m.subscription.status, 'ACTIVE');
  assert.equal((await transcribe('e@example.com', 60, 'strong')).status, 200);

  dash['f@example.com'] = { plan: 'timlul:team' };
  m = await me('f@example.com');
  assert.equal(m.plan.credits, 5000, 'a plan created only in the dashboard works too');

  dash['g@example.com'] = { override: { minutes: 50, email: true } };
  m = await me('g@example.com');
  assert.equal(m.plan.credits, 50, 'personal permissions');
  assert.deepEqual(m.features, { strong: false, email: true });

  // After paying, the site asks with ?fresh=1 and sees the new plan right away.
  dash['g@example.com'] = { plan: 'timlul:basic' };
  assert.equal((await me('g@example.com')).plan.credits, 50, 'cached for a minute');
  assert.equal((await me('g@example.com', true)).plan.credits, 180);
});

test('unlimited: the hidden plan or a personal permission', async () => {
  dash['vip@example.com'] = { plan: 'timlul:unlimited' };
  let m = await me('vip@example.com');
  assert.equal(m.unlimited, true);
  assert.equal(m.plan.name, 'ללא הגבלה');
  assert.equal(m.remaining, null);
  assert.deepEqual(m.features, { strong: true, email: true });
  for (let i = 0; i < 4; i++) assert.equal((await transcribe('vip@example.com', 5 * 60, 'strong')).status, 200);
  assert.equal((await me('vip@example.com')).used, 40, 'usage is still recorded for the cost stats');

  dash['vip2@example.com'] = { override: { minutes: -1 } };
  assert.equal((await me('vip2@example.com')).unlimited, true);
  assert.equal((await me('a@example.com')).unlimited, false);
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

test('config lists the packs, each pricier per minute than any monthly plan', async () => {
  const c = await (await mf.dispatchFetch(BASE + '/api/config')).json();
  assert.deepEqual(c.packs.plans, ['business']);
  assert.equal(c.packs.currency, 'ILS');
  assert.deepEqual(c.packs.paypal, { clientId: 'pp-id', env: 'sandbox' });
  assert.deepEqual(c.packs.list.map(p => [p.credits, p.price]), [[100, 8], [300, 21], [1000, 60]]);
  // Monthly plans: basic ₪9/180, pro ₪19/600, business ₪39/1500. The cheapest is 5 ag a minute.
  for (const p of c.packs.list) assert.ok(p.price / p.credits > 9 / 180, `pack ${p.key} must cost more per minute`);
});

test('packs: only the business plan can buy; minutes are used after the monthly quota', async () => {
  const user = 'biz@example.com';
  // A lower plan gets "upgrade" and no order is created.
  dash[user] = { plan: 'timlul:pro' };
  let res = await post('/api/packs/order', user, { pack: '100' });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'upgrade');
  assert.equal((await me(user)).packs.allowed, false);
  assert.equal(orderSeq, 0);

  dash[user] = { plan: 'timlul:business' };
  let m = await me(user, true);
  assert.deepEqual(m.packs, { allowed: true, balance: 0 });
  assert.equal(m.remaining, 3);
  assert.equal((await post('/api/packs/order', user, { pack: '42' })).status, 400);

  res = await post('/api/packs/order', user, { pack: '100' });
  assert.equal(res.status, 200);
  const { id } = await res.json();
  const unit = orders[id].body.purchase_units[0];
  assert.deepEqual(unit.amount, { currency_code: 'ILS', value: '8' });
  assert.equal(unit.custom_id, 'timlul:u-biz@example.com:100');
  assert.equal(orders[id].body.intent, 'CAPTURE');

  // Someone else can't claim this order.
  dash['other@example.com'] = { plan: 'timlul:business' };
  assert.equal((await post('/api/packs/capture', 'other@example.com', { orderId: id })).status, 403);
  assert.equal((await me('other@example.com')).packs.balance, 0);

  res = await post('/api/packs/capture', user, { orderId: id });
  assert.equal(res.status, 200);
  m = await res.json();
  assert.equal(m.packs.balance, 100);
  assert.equal(m.remaining, 103);
  assert.equal(m.planRemaining, 3);
  // A retry of the same order doesn't add the minutes twice.
  assert.equal((await post('/api/packs/capture', user, { orderId: id })).status, 200);
  assert.equal((await me(user)).packs.balance, 100);

  // 2 minutes from the quota; then 2 minutes accurate = 4: 1 from the quota, 3 from the pack.
  assert.equal((await transcribe(user, 120)).status, 200);
  assert.equal((await transcribe(user, 120, 'strong')).status, 200);
  m = await me(user);
  assert.equal(m.used, 3);
  assert.equal(m.planRemaining, 0);
  assert.equal(m.packs.balance, 97);
  assert.equal(m.remaining, 97);

  // A failed transcription gives the pack minutes back.
  openaiFails = true;
  assert.equal((await transcribe(user, 60)).status, 502);
  openaiFails = false;
  assert.equal((await me(user)).packs.balance, 97);

  // More than the quota and the packs left: refused, nothing charged, and told about packs.
  res = await transcribe('other@example.com', 4 * 60);
  assert.equal(res.status, 402);
  assert.match((await res.json()).message, /חבילת דקות/);
  assert.equal((await me('other@example.com')).used, 0);

  // Without the business plan the pack minutes are kept but can't be used.
  dash[user] = { plan: 'timlul:basic' };
  m = await me(user, true);
  assert.deepEqual(m.packs, { allowed: false, balance: 97 });
  assert.equal(m.remaining, m.planRemaining);
  dash[user] = { plan: 'timlul:free' };
  await me(user, true);
  res = await transcribe(user, 11 * 60);
  assert.equal(res.status, 402, 'the free quota is 10 and packs are frozen');
  dash[user] = { plan: 'timlul:business' };
  assert.equal((await me(user, true)).remaining, 97, 'back with the plan');
});

test('packs: unpaid orders add nothing; JSON {"packs": true} allows another plan', async () => {
  const user = 'team@example.com';
  dash[user] = { plan: 'timlul:team', override: { packs: true } };
  const { id } = await (await post('/api/packs/order', user, { pack: '300' })).json();
  paypalPays = false;
  const res = await post('/api/packs/capture', user, { orderId: id });
  paypalPays = true;
  assert.ok(res.status >= 400);
  assert.equal((await me(user)).packs.balance, 0);
  assert.equal((await post('/api/packs/capture', user, { orderId: 'ORDER999' })).status, 404);
  assert.equal((await post('/api/packs/capture', user, { orderId: id })).status, 200);
  assert.equal((await me(user)).packs.balance, 300);

  dash['vip@example.com'] = { plan: 'timlul:unlimited' };
  assert.equal((await post('/api/packs/order', 'vip@example.com', { pack: '100' })).status, 403, 'unlimited never needs packs');
});

test('admin manifest for the reem.bi dashboard, with CORS only for login.reembir.com', async () => {
  const admin = 'boss@example.com';
  const SSO = 'https://login.reembir.com';
  const pre = await mf.dispatchFetch(BASE + '/api/admin/manifest', {
    method: 'OPTIONS', headers: { Origin: SSO, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' },
  });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), SSO);

  const res = await mf.dispatchFetch(BASE + '/api/admin/manifest', { headers: { ...as(admin), Origin: SSO } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), SSO);
  const m = await res.json();
  assert.equal(m.version, 1);
  assert.ok(m.stats.find(s => s.label === 'עלות OpenAI החודש'));
  assert.equal(m.stats.find(s => s.label === 'חבילות דקות החודש').value, 2);
  assert.equal(m.stats.find(s => s.label === 'הכנסה מחבילות החודש').value, '₪29');
  assert.ok(m.checks.find(c => c.label === 'PAYPAL_CLIENT_SECRET').ok);
  assert.ok(m.checks.find(c => c.label === 'OPENAI_API_KEY').ok);
  assert.equal(m.coupons, undefined, 'coupons are managed by reem.bi now');
  assert.ok(m.lists[0].items.some(i => i.title === 'vip@example.com'));

  const evil = await mf.dispatchFetch(BASE + '/api/admin/manifest', { headers: { ...as(admin), Origin: 'https://evil.example' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  assert.equal((await mf.dispatchFetch(BASE + '/api/admin/manifest', { headers: { ...as('a@example.com'), Origin: SSO } })).status, 403);
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
