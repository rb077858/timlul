// Integration tests: runs the built Worker in Miniflare with every outside
// service (reem.bi, OpenAI, Resend) mocked. `npm test` builds first.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { encodeWav, planChunks, SAMPLE_RATE } from '../public/audio.js';

const calls = [];
let openaiFails = false;

// reem.bi: the plans of the site and each user's access, as /api/userinfo reports them.
const PLANS = {
  'timlul:free': { name: 'חינם', features: { minutes: 10, strong: false, email: false } },
  'timlul:basic': { name: 'בסיסי', features: { minutes: 180, strong: true, email: true } },
  'timlul:pro': { name: 'מקצועי', features: { minutes: 700 } },
  'timlul:team': { name: 'צוות', features: { minutes: 5000, strong: true, email: true } },
  'timlul:business': { name: 'עסקי', features: { minutes: 3, strong: true, email: true } },
  'timlul:unlimited': { name: 'ללא הגבלה', features: { unlimited: true } },
};
const dash = {}; // email -> { plan, expires, override, subscription, packs, bonus, affiliate }
// reem.bi's packs: the business plan may buy them; userinfo reports the minutes bought in total.
const PACK_PLANS = ['timlul:business'];

function accessFor(email) {
  const a = dash[email] || {};
  // plan: null = the site has no plan for new users (no free plan).
  const planId = a.plan === null ? null : a.plan || 'timlul:free';
  return {
    status: 'active',
    plan: planId ? { id: planId, name: PLANS[planId].name } : null,
    plan_expires_at: a.expires || null,
    features: { ...(planId ? PLANS[planId].features : {}), ...(a.override || {}) },
    subscription: a.subscription || null,
    packs: { eligible: PACK_PLANS.includes(planId), totals: a.packs ? { minutes: a.packs } : {}, count: a.packs ? 1 : 0 },
    rewards: { totals: a.bonus ? { minutes: a.bonus } : {}, count: a.bonus ? 1 : 0 },
    affiliate: a.affiliate || null,
    affiliate_program: a.program || null,
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
  assert.equal(c.planDefaults.free.credits, 0, 'no free plan: only the welcome gift');
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

test('packs bought in reem.bi: used after the monthly quota, only on the plan they are for', async () => {
  const user = 'biz@example.com';
  dash[user] = { plan: 'timlul:business' };
  let m = await me(user);
  assert.deepEqual(m.packs, { allowed: true, balance: 0, usable: 0, bonus: 0 });
  assert.equal(m.remaining, 3);

  // Bought 100 minutes (reem.bi reports it; the site asks fresh right after paying).
  dash[user].packs = 100;
  m = await me(user, true);
  assert.deepEqual(m.packs, { allowed: true, balance: 100, usable: 100, bonus: 0 });
  assert.equal(m.remaining, 103);
  assert.equal(m.planRemaining, 3);

  // 2 minutes from the quota; then 2 minutes accurate = 4: 1 from the quota, 3 from the pack.
  assert.equal((await transcribe(user, 120)).status, 200);
  assert.equal((await transcribe(user, 120, 'strong')).status, 200);
  m = await me(user);
  assert.equal(m.used, 3);
  assert.equal(m.planRemaining, 0);
  assert.deepEqual(m.packs, { allowed: true, balance: 97, usable: 97, bonus: 0 });
  assert.equal(m.remaining, 97);

  // A failed transcription gives the pack minutes back.
  openaiFails = true;
  assert.equal((await transcribe(user, 60)).status, 502);
  openaiFails = false;
  assert.equal((await me(user)).packs.balance, 97);

  // Another pack adds up with what's left.
  dash[user].packs = 400;
  assert.equal((await me(user, true)).packs.balance, 397);

  // Off the business plan the pack minutes are kept but can't be used.
  dash[user].plan = 'timlul:basic';
  m = await me(user, true);
  assert.deepEqual(m.packs, { allowed: false, balance: 397, usable: 0, bonus: 0 });
  assert.equal(m.remaining, m.planRemaining);
  dash[user].plan = 'timlul:free';
  await me(user, true);
  assert.equal((await transcribe(user, 11 * 60)).status, 402, 'the free quota is 10 and packs are frozen');
  dash[user].plan = 'timlul:business';
  assert.equal((await me(user, true)).remaining, 397, 'back with the plan');
});

test('partner program: gift minutes work on every plan, and a partner sees their link', async () => {
  const user = 'friend@example.com';
  dash[user] = { plan: 'timlul:free', override: { minutes: 1 }, bonus: 5 };
  let m = await me(user);
  assert.deepEqual(m.packs, { allowed: false, balance: 5, usable: 5, bonus: 5 });
  assert.equal(m.remaining, 6);
  assert.equal(m.affiliate, null);
  assert.equal((await transcribe(user, 3 * 60)).status, 200, '1 from the quota, 2 from the gift');
  m = await me(user);
  assert.equal(m.packs.usable, 3);
  assert.equal((await transcribe(user, 4 * 60)).status, 402, 'only 3 left');

  // A business user with packs and gift minutes; off the plan only the gift part is usable.
  const biz = 'bizfriend@example.com';
  dash[biz] = { plan: 'timlul:business', override: { minutes: 0 }, packs: 100, bonus: 50 };
  m = await me(biz);
  assert.deepEqual(m.packs, { allowed: true, balance: 150, usable: 150, bonus: 50 });
  dash[biz].plan = 'timlul:basic';
  dash[biz].override = { minutes: 0 };
  m = await me(biz, true);
  assert.deepEqual(m.packs, { allowed: false, balance: 150, usable: 50, bonus: 50 });
  assert.equal(m.remaining, 50);

  assert.equal(m.partnerProgram, null, 'no program');
  dash[user].program = { self_join: false, label: 'מתנה: 30 דקות', reward: { minutes: 300 }, reward_on: 'paid' };
  assert.equal((await me(user, true)).partnerProgram, null, 'the program is on, but joining is by the admin');
  dash[user].program.self_join = true;
  assert.deepEqual((await me(user, true)).partnerProgram, { label: 'מתנה: 30 דקות', rewardMinutes: 300, rewardOn: 'paid' });

  dash[user].affiliate = { code: 'DANA', link: 'https://login.reembir.com/join/DANA', active: true, referrals: 2, paid: 1 };
  m = await me(user, true);
  assert.equal(m.affiliate.link, 'https://login.reembir.com/join/DANA');
});

test('no free plan: a new user has only the welcome gift, fast model, no email', async () => {
  const user = 'newcomer@example.com';
  dash[user] = { plan: null, bonus: 10 };
  let m = await me(user);
  assert.equal(m.plan.name, 'ללא מנוי');
  assert.equal(m.plan.credits, 0);
  assert.equal(m.remaining, 10);
  assert.deepEqual(m.features, { strong: false, email: false });
  assert.equal((await transcribe(user, 60, 'strong')).status, 403, 'fast model only');
  assert.equal((await transcribe(user, 9 * 60)).status, 200);
  m = await me(user);
  assert.equal(m.remaining, 1);
  const res = await transcribe(user, 2 * 60);
  assert.equal(res.status, 402);
  assert.match((await res.json()).message, /נגמרו דקות המתנה/);

  dash['nogift@example.com'] = { plan: null };
  assert.equal((await me('nogift@example.com')).remaining, 0);
  assert.equal((await transcribe('nogift@example.com', 30)).status, 402);
});

test('out of minutes: business users are told about packs, others are not', async () => {
  dash['biz2@example.com'] = { plan: 'timlul:business' };
  let res = await transcribe('biz2@example.com', 4 * 60);
  assert.equal(res.status, 402);
  assert.match((await res.json()).message, /חבילת דקות/);
  assert.equal((await me('biz2@example.com')).used, 0, 'nothing charged');

  dash['pro2@example.com'] = { plan: 'timlul:pro', override: { minutes: 1 } };
  res = await transcribe('pro2@example.com', 2 * 60);
  assert.equal(res.status, 402);
  assert.doesNotMatch((await res.json()).message, /חבילת/);

  dash['vip@example.com'] = { plan: 'timlul:unlimited' };
  assert.equal((await me('vip@example.com')).packs.allowed, false, 'unlimited never needs packs');
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
  assert.equal(m.stats.find(s => s.label === 'דקות נוספות החודש (חבילות ומתנות)').value, 14);
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
