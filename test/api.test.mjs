// Integration tests: runs the built Worker in Miniflare with every outside
// service (SSO, OpenAI, PayPal, Resend) mocked. Run `npm run check` first.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { encodeWav, planChunks, SAMPLE_RATE } from '../public/audio.js';

const calls = [];
let openaiFails = false;
const subs = {};

async function mock(req) {
  const url = new URL(req.url);
  const auth = req.headers.get('authorization') || '';
  calls.push({ url: req.url, method: req.method });

  if (url.host === 'login.reembir.com' && url.pathname === '/api/userinfo') {
    const m = auth.match(/^Bearer tok-(.+)$/);
    if (!m) return new Response('no', { status: 401 });
    return Response.json({ user: { id: 'u-' + m[1], email: m[1].toUpperCase(), name: 'Test' }, access: {} });
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
      return Response.json({ id: 'P-' + body.billing_cycles[0].pricing_scheme.fixed_price.value });
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
    },
    serviceBindings: { ASSETS: () => new Response('asset') },
    outboundService: mock,
  });
});
after(() => mf?.dispose());

const BASE = 'http://localhost';
const as = email => ({ Authorization: 'Bearer tok-' + email });

function tone(seconds, silent = false) {
  const n = Math.round(seconds * SAMPLE_RATE);
  const s = new Float32Array(n);
  if (!silent) for (let i = 0; i < n; i++) s[i] = 0.3 * Math.sin(i / 5);
  return s;
}

async function wav(seconds, opts) {
  return new Uint8Array(await encodeWav(tone(seconds), 0, Math.round(seconds * SAMPLE_RATE)).arrayBuffer());
}

async function transcribe(email, seconds, model = 'fast', bytes) {
  const body = bytes || await wav(seconds);
  return mf.dispatchFetch(`${BASE}/api/transcribe?model=${model}&lang=he&prompt=${encodeURIComponent('רשימת מילים')}`, {
    method: 'POST', headers: { ...as(email), 'Content-Type': 'audio/wav', 'Content-Length': String(body.byteLength) }, body,
  });
}

const me = async email => (await mf.dispatchFetch(BASE + '/api/me', { headers: as(email) })).json();

test('config is public and assets fall through', async () => {
  const c = await (await mf.dispatchFetch(BASE + '/api/config')).json();
  assert.equal(c.ssoClientId, 'timlul');
  assert.equal(c.paypal, null);
  assert.deepEqual(c.plans.map(p => p.key), ['free', 'basic', 'pro', 'business']);
  assert.equal(await (await mf.dispatchFetch(BASE + '/')).text(), 'asset');
});

test('requires login', async () => {
  assert.equal((await mf.dispatchFetch(BASE + '/api/me')).status, 401);
  assert.equal((await mf.dispatchFetch(BASE + '/api/me', { headers: { Authorization: 'Bearer nope-123456789' } })).status, 401);
});

test('free plan quota, model weights and streaming to OpenAI', async () => {
  const user = 'a@example.com';
  let m = await me(user);
  assert.equal(m.plan.key, 'free');
  assert.equal(m.remaining, 10);

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

  res = await transcribe(user, 240, 'strong');
  assert.equal(res.status, 200);
  assert.ok(calls.findLast(c => c.url.includes('openai')).body.includes(0));
  m = await me(user);
  assert.equal(m.used, 9); // 1 + 4*2

  res = await transcribe(user, 120);
  assert.equal(res.status, 402);
  assert.equal((await me(user)).used, 9);
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

test('admin, PayPal setup, subscribe, switch and cancel', async () => {
  assert.equal((await mf.dispatchFetch(BASE + '/api/admin/stats', { headers: as('a@example.com') })).status, 403);
  const setup = await (await mf.dispatchFetch(BASE + '/api/admin/paypal-setup', { method: 'POST', headers: as('boss@example.com') })).json();
  assert.deepEqual(setup.plans, { basic: 'P-19', pro: 'P-49', business: 'P-99' });
  const c = await (await mf.dispatchFetch(BASE + '/api/config')).json();
  assert.equal(c.paypal.clientId, 'cid');
  assert.equal(c.plans.find(p => p.key === 'pro').paypalPlanId, 'P-49');

  const user = 'a@example.com';
  const now = new Date().toISOString();
  const next = new Date(Date.now() + 30 * 86400000).toISOString();
  subs['I-1'] = { id: 'I-1', status: 'ACTIVE', plan_id: 'P-19', custom_id: user, start_time: now,
    billing_info: { next_billing_time: next, last_payment: { time: now } } };
  subs['I-2'] = { ...subs['I-1'], id: 'I-2', plan_id: 'P-49', custom_id: 'other@example.com', billing_info: { ...subs['I-1'].billing_info } };

  const activate = (id, email = user) => mf.dispatchFetch(BASE + '/api/subscription/activate', {
    method: 'POST', headers: { ...as(email), 'Content-Type': 'application/json' }, body: JSON.stringify({ subscriptionId: id }),
  });
  assert.equal((await activate('I-2')).status, 403, 'someone else\'s subscription');

  let m = await (await activate('I-1')).json();
  assert.equal(m.plan.key, 'basic');
  assert.equal(m.remaining, 180, 'usage from before the payment does not count');

  // Upgrade: the old subscription gets cancelled at PayPal.
  subs['I-2'].custom_id = user;
  m = await (await activate('I-2')).json();
  assert.equal(m.plan.key, 'pro');
  assert.equal(subs['I-1'].status, 'CANCELLED');

  m = await (await mf.dispatchFetch(BASE + '/api/subscription/cancel', { method: 'POST', headers: as(user) })).json();
  assert.equal(m.subscription.status, 'CANCELLED');
  assert.equal(m.plan.key, 'pro', 'keeps working until the paid month ends');

  const stats = await (await mf.dispatchFetch(BASE + '/api/admin/stats', { headers: as('boss@example.com') })).json();
  assert.equal(stats.users >= 3, true);
  assert.equal(stats.configured.OPENAI_API_KEY, true);
});

test('email sends the transcript as an attachment to the account address', async () => {
  const res = await mf.dispatchFetch(BASE + '/api/email', {
    method: 'POST', headers: { ...as('d@example.com'), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'תמלול לדוגמה', filename: 'meeting' }),
  });
  assert.equal(res.status, 200);
  const sent = calls.findLast(c => c.url.includes('resend')).json;
  assert.deepEqual(sent.to, ['d@example.com']);
  assert.equal(sent.attachments[0].filename, 'meeting.txt');
  assert.equal(Buffer.from(sent.attachments[0].content, 'base64').toString('utf8'), '﻿תמלול לדוגמה');
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
