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
      OPENAI_API_KEY: 'sk-test', RESEND_API_KEY: 're-test', MAIL_FROM: 'Timlul <t@example.com>', ADMIN_EMAILS: 'boss@example.com',
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
  const sent = calls.findLast(c => c.url.includes('resend')).json;
  assert.deepEqual(sent.to, ['d2@example.com']);
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
