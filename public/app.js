import { decodeToMono, planChunks, encodeWav } from './audio.js';

const $ = id => document.getElementById(id);
const CONCURRENCY = 3;
const HISTORY_KEY = 'timlul:history';

let config = null;
let auth = null;
let me = null;
let currentFile = null;
let busy = false;
let catalog = null; // the plans for sale, from reem.bi (auth.billing.catalog())
let coupon = null;  // an applied coupon, from auth.billing.checkCoupon()
const PENDING_COUPON = 'timlul:coupon';

// ---------- startup ----------

init();

async function init() {
  try {
    config = await (await fetch('/api/config')).json();
  } catch {
    config = { ssoClientId: 'timlul', strongWeight: 2, planDefaults: {} };
  }
  renderStaticConfig();

  if (!window.ReemAuth) {
    $('authLoading').hidden = true;
    $('sdkError').hidden = false;
    return;
  }
  auth = window.ReemAuth.init({ clientId: config.ssoClientId });
  auth.billing.catalog().then(c => { catalog = c; renderStaticConfig(); renderPlans(); })
    .catch(() => { $('plansGrid').textContent = 'לא הצלחנו לטעון את התוכניות. נסו לרענן.'; });
  auth.onChange(onUser);

  $('loginBtn').onclick = () => auth.login();
  $('heroLogin').onclick = () => auth.login();
  $('logoutBtn').onclick = () => auth.logout();
  bindWorkspace();
  bindCoupon();
}

function renderStaticConfig() {
  document.querySelectorAll('.strong-weight').forEach(el => { el.textContent = config.strongWeight; });
  $('strongNote').textContent = `המודל החזק ביותר. דקה = ${config.strongWeight} דקות מהמכסה`;
  const free = catalog && catalog.free && planInfo(catalog.free);
  if (free) {
    $('heroCta').querySelector('.small').textContent = `${free.credits} דקות חינם בכל חודש, בלי כרטיס אשראי`;
  }
}

async function onUser(user) {
  if (user === undefined) return; // still loading
  $('authLoading').hidden = true;
  $('loginBtn').hidden = !!user;
  $('userMenu').hidden = !user;
  $('heroCta').hidden = !!user;
  $('workspace').hidden = !user;

  if (!user) {
    me = null;
    renderPlans();
    return;
  }
  $('accountLink').textContent = user.name || user.email;
  $('accountLink').href = auth.accountUrl();
  await refreshMe();
  renderHistory();
  applyPendingCoupon();
}

// ---------- API ----------

async function api(path, options = {}) {
  const token = await auth.getToken();
  const headers = { ...(options.headers || {}), Authorization: 'Bearer ' + token };
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    options = { ...options, body: JSON.stringify(options.json) };
  }
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || 'שגיאה (' + res.status + ')');
    err.status = res.status;
    err.code = data.error;
    err.data = data;
    if (res.status === 401) auth.login();
    throw err;
  }
  return data;
}

// fresh: right after a payment / coupon / cancel, skip the server's one-minute cache.
async function refreshMe(fresh) {
  try {
    me = await api('/api/me' + (fresh ? '?fresh=1' : ''));
  } catch (e) {
    toast(e.message);
    return;
  }
  renderQuota();
  if (planSignature() !== plansSignature) renderPlans();
  $('adminLink').hidden = !me.isAdmin;
}

// ---------- quota card ----------

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' });
}

function fmtMinutes(n) {
  return n >= 10 ? Math.floor(n).toLocaleString('he-IL') : (Math.floor(n * 10) / 10).toLocaleString('he-IL');
}

function renderQuota() {
  if (!me) return;
  $('planName').textContent = me.plan.name;
  $('remaining').textContent = me.unlimited ? '∞' : fmtMinutes(me.remaining);
  const pct = me.unlimited ? 0 : me.plan.credits ? Math.min(100, (me.used / me.plan.credits) * 100) : 100;
  $('quotaBar').style.width = pct + '%';

  const sub = me.subscription;
  const active = sub && sub.status === 'ACTIVE';
  let detail = me.unlimited
    ? `נוצלו ${fmtMinutes(me.used)} דקות. ללא הגבלה. `
    : `נוצלו ${fmtMinutes(me.used)} מתוך ${me.plan.credits} דקות. `;
  if (active) detail += `המנוי מתחדש ב-${fmtDate(sub.paid_until * 1000 - 86400000)}. `;
  else if (sub && sub.status === 'CANCELLED') detail += `המנוי בוטל ופעיל עד ${fmtDate(sub.paid_until * 1000)}. `;
  else if (me.planExpiresAt) detail += `התוכנית בתוקף עד ${fmtDate(me.planExpiresAt)}. `;
  if (!me.unlimited) detail += `המכסה מתחדשת ב-${fmtDate(me.periodEnd)}`;
  $('quotaDetail').textContent = detail;
  $('cancelBtn').hidden = !active;
  applyFeatures();
}

// The free plan has no accurate model and no email.
function applyFeatures() {
  const strong = document.querySelector('input[name="model"][value="strong"]');
  const canStrong = !!me?.features?.strong;
  strong.disabled = !canStrong;
  strong.closest('.model').classList.toggle('locked', !canStrong);
  if (!canStrong && strong.checked) document.querySelector('input[name="model"][value="fast"]').checked = true;
  $('strongNote').textContent = canStrong
    ? `המודל החזק ביותר. דקה = ${config.strongWeight} דקות מהמכסה`
    : '🔒 זמין בתוכניות בתשלום';
  $('emailBtn').textContent = me?.features?.email ? 'שליחה למייל שלי' : '🔒 שליחה למייל שלי';
}

// ---------- plans & PayPal (central billing of reem.bi, through the SDK) ----------

let plansSignature = null;

function planSignature() {
  return me ? [me.plan.key, me.subscription?.status || '', coupon?.code || '', me.unlimited].join(':') : null;
}

const planKey = id => String(id || '').split(':').pop();
const money = (v, c) => ({ ILS: '₪', USD: '$', EUR: '€' }[c] || (c || '') + ' ') + v;

// A catalog plan with its minutes and features (from its JSON in the dashboard, or the defaults).
function planInfo(p) {
  const key = planKey(p.id);
  const def = (config.planDefaults || {})[key] || (p.price ? { credits: 180, strong: true, email: true } : { credits: 10, strong: false, email: false });
  const f = p.features || {};
  return {
    ...p, key,
    credits: Number.isFinite(Number(f.minutes)) && f.minutes !== null && f.minutes !== '' && Number(f.minutes) >= 0 ? Number(f.minutes) : def.credits,
    strong: typeof f.strong === 'boolean' ? f.strong : def.strong,
    email: typeof f.email === 'boolean' ? f.email : def.email,
  };
}

function renderPlans() {
  if (!catalog) return;
  plansSignature = planSignature();
  const grid = $('plansGrid');
  grid.textContent = '';
  const subActive = me?.subscription?.status === 'ACTIVE';
  const plans = [...(catalog.free ? [{ ...catalog.free, price: 0 }] : []), ...catalog.plans].map(planInfo);
  const featured = plans.length > 2 ? plans[Math.min(2, plans.length - 1)].id : null;

  for (const plan of plans) {
    const card = document.createElement('div');
    const mine = me && !me.unlimited && me.plan.key === plan.key;
    card.className = 'plan' + (plan.id === featured ? ' featured' : '') + (mine ? ' current' : '');
    if (plan.id === featured) card.append(el('span', 'plan-badge', 'הכי משתלם'));
    card.append(el('h3', '', plan.name));
    const offer = coupon?.offers?.[plan.id] && !mine ? coupon.offers[plan.id] : null;
    const price = el('div', 'price', money(offer ? offer.first_price : plan.price, plan.currency || catalog.currency));
    if (offer) price.prepend(el('s', 'old-price', money(plan.price, plan.currency)));
    if (plan.price) price.append(el('small', '', ' / חודש'));
    card.append(price);
    if (offer) {
      card.append(el('div', 'offer', offer.months ? `${coupon.label}, אחר כך ${money(offer.regular_price, plan.currency)} לחודש` : coupon.label));
    }
    if (plan.description) card.append(el('div', 'muted small', plan.description));

    const ul = document.createElement('ul');
    const hours = plan.credits >= 120 ? ` (${+(plan.credits / 60).toFixed(1)} שעות)` : '';
    ul.append(el('li', '', `${plan.credits.toLocaleString('he-IL')} דקות תמלול בחודש${hours}`));
    ul.append(el('li', '', plan.strong ? 'מודל מהיר ומודל מדויק' : 'מודל מהיר בלבד'));
    ul.append(el('li', '', plan.email ? 'הורדה כ-TXT ושליחה למייל' : 'הורדה כ-TXT'));
    if (plan.price && plan.credits) ul.append(el('li', '', `כ-${(plan.price / plan.credits * 100).toFixed(0)} אג׳ לדקה`));
    card.append(ul);

    if (me?.unlimited) {
      if (plan.price) card.append(el('div', 'state', 'יש לך גישה ללא הגבלה'));
    } else if (mine) {
      card.append(el('div', 'state', 'התוכנית הנוכחית שלך'));
    } else if (plan.price) {
      const slot = el('div', 'pp', '');
      card.append(slot);
      const ppId = offer ? offer.paypal_plan_id : plan.paypal_plan_id;
      if (!me) {
        const b = el('button', 'btn btn-ghost btn-block', 'התחברות להרשמה');
        b.onclick = () => auth ? auth.login() : null;
        slot.append(b);
      } else if (!catalog.paypal || !ppId) {
        slot.append(el('div', 'muted small center', 'ההרשמה תיפתח בקרוב'));
      } else {
        auth.billing.button(slot, ppId, {
          onSuccess: async () => {
            clearCoupon();
            await refreshMe(true);
            renderPlans();
            toast('המנוי הופעל! תודה 🎉');
            $('workspace').scrollIntoView({ behavior: 'smooth' });
          },
          onError: err => showPlanNote(err && err.message && err.message !== 'login'
            ? 'התשלום לא הושלם: ' + err.message : 'התשלום לא הושלם. נסו שוב או בחרו אמצעי תשלום אחר.'),
        }).catch(e => slot.append(el('div', 'muted small center', e.message)));
        if (subActive) slot.append(el('div', 'muted small center', 'המנוי הנוכחי יבוטל אוטומטית'));
      }
    }
    grid.append(card);
  }
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

function showPlanNote(text) {
  $('planNote').textContent = text;
  $('planNote').hidden = false;
}

// ---------- workspace ----------

function bindWorkspace() {
  const input = $('fileInput');
  const drop = $('drop');
  input.onchange = () => input.files[0] && pickFile(input.files[0]);
  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, () => drop.classList.remove('over')));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    if (e.dataTransfer.files[0]) pickFile(e.dataTransfer.files[0]);
  });

  $('startBtn').onclick = start;
  $('downloadBtn').onclick = () => download($('resultText').value, $('resultText').dataset.name || 'transcript');
  $('copyBtn').onclick = async () => {
    try { await navigator.clipboard.writeText($('resultText').value); toast('הועתק'); }
    catch { $('resultText').select(); document.execCommand('copy'); toast('הועתק'); }
  };
  $('emailBtn').onclick = () => {
    if (!me?.features?.email) {
      toast('שליחה במייל זמינה בתוכניות בתשלום');
      $('plans').scrollIntoView({ behavior: 'smooth' });
      return;
    }
    sendEmail();
  };
  $('cancelBtn').onclick = cancelSubscription;

  window.addEventListener('beforeunload', e => { if (busy) { e.preventDefault(); e.returnValue = ''; } });
}

function pickFile(file) {
  if (busy) return;
  currentFile = file;
  const mb = (file.size / 1024 / 1024).toFixed(1);
  $('fileInfo').textContent = `${file.name} · ${mb} MB`;
  $('fileInfo').hidden = false;
  $('startBtn').disabled = false;
  $('workError').hidden = true;
}

function setProgress(pct, text) {
  $('progress').hidden = false;
  $('progressBar').style.width = Math.round(pct) + '%';
  $('progressText').textContent = text;
}

function showError(text) {
  $('workError').textContent = text;
  $('workError').hidden = false;
}

async function start() {
  if (!currentFile || busy) return;
  busy = true;
  $('startBtn').disabled = true;
  $('workError').hidden = true;
  $('resultCard').hidden = true;
  let wakeLock = null;
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not supported */ }

  try {
    const kind = document.querySelector('input[name="model"]:checked').value;
    const lang = $('lang').value;
    const hint = $('hint').value.trim();
    const weight = kind === 'strong' ? config.strongWeight : 1;

    setProgress(2, 'מכין את הקובץ… (בקבצים גדולים זה יכול לקחת דקה)');
    await new Promise(r => setTimeout(r, 30));
    let samples;
    try {
      samples = await decodeToMono(currentFile);
    } catch (e) {
      throw new Error(e instanceof RangeError
        ? 'הקובץ גדול מדי לעיבוד במכשיר הזה. נסו קובץ אודיו (MP3/M4A) או מחשב.'
        : 'לא הצלחנו לקרוא את הקובץ. ודאו שזה קובץ אודיו או וידאו תקין, או המירו אותו ל-MP3.');
    }

    const chunks = planChunks(samples);
    const totalSeconds = chunks.reduce((s, c) => s + c.seconds, 0);
    if (!chunks.length) throw new Error('לא נמצא דיבור בקובץ.');
    const needed = (totalSeconds / 60) * weight;

    await refreshMe();
    if (me && !me.unlimited && needed > me.remaining + 0.01) {
      throw new Error(`הקובץ צריך ${fmtMinutes(needed)} דקות מהמכסה, ונותרו לך ${fmtMinutes(me.remaining)}. ` +
        (kind === 'strong' ? 'אפשר לנסות את המודל המהיר, או ' : '') + 'לשדרג תוכנית למטה.');
    }

    const texts = new Array(chunks.length).fill(null);
    let done = 0;
    let stopped = null;
    const total = chunks.length;
    setProgress(5, `מתמלל… 0 מתוך ${total} חלקים`);

    let next = 0;
    async function worker() {
      while (next < total && !stopped) {
        const i = next++;
        const c = chunks[i];
        const blob = encodeWav(samples, c.start, c.end);
        try {
          texts[i] = await uploadChunk(blob, { kind, lang, hint });
        } catch (e) {
          stopped = stopped || e;
          return;
        }
        done++;
        setProgress(5 + (done / total) * 95, `מתמלל… ${done} מתוך ${total} חלקים`);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));

    const text = texts.filter(t => t !== null).join('\n').trim();
    const name = currentFile.name.replace(/\.[^.]+$/, '');
    if (text) showResult(text, name, totalSeconds, !!stopped);
    if (stopped) throw stopped;
    setProgress(100, 'הסתיים ✓');
  } catch (e) {
    showError(e.message || 'משהו השתבש');
  } finally {
    busy = false;
    $('startBtn').disabled = !currentFile;
    try { await wakeLock?.release(); } catch { /* ignore */ }
    refreshMe();
  }
}

async function uploadChunk(blob, { kind, lang, hint }) {
  const params = new URLSearchParams({ model: kind, lang });
  if (hint) params.set('prompt', hint);
  for (let attempt = 0; ; attempt++) {
    try {
      const data = await api('/api/transcribe?' + params, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: blob,
      });
      return data.text;
    } catch (e) {
      const retryable = !e.status || e.status >= 500 || e.status === 429;
      if (!retryable || attempt >= 2) throw e;
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

function showResult(text, name, seconds, partial) {
  $('resultText').value = text;
  $('resultText').dataset.name = name;
  const mins = Math.round(seconds / 60);
  $('resultMeta').textContent = `${name} · ${mins ? mins + ' דקות' : 'פחות מדקה'}`;
  $('resultNote').hidden = !partial;
  $('resultNote').textContent = partial ? 'התמלול חלקי: חלק מהקובץ לא תומלל (ראו את השגיאה למעלה).' : '';
  $('resultCard').hidden = false;
  $('resultCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  saveHistory(name, text);
}

function download(text, name) {
  const blob = new Blob(['﻿' + text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name + '.txt';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function sendEmail() {
  const btn = $('emailBtn');
  btn.disabled = true;
  try {
    const r = await api('/api/email', {
      method: 'POST',
      json: { text: $('resultText').value, filename: $('resultText').dataset.name || 'transcript' },
    });
    toast('נשלח ל-' + r.to);
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
}

async function cancelSubscription() {
  if (!confirm('לבטל את המנוי? התוכנית תמשיך לעבוד עד סוף התקופה ששולמה, ולא יהיו חיובים נוספים.')) return;
  try {
    await auth.billing.cancel();
    await refreshMe(true);
    renderQuota();
    renderPlans();
    toast('המנוי בוטל');
  } catch (e) {
    toast(e.message);
  }
}

// ---------- coupons ----------

function bindCoupon() {
  const fromUrl = new URLSearchParams(location.search).get('coupon');
  if (fromUrl) {
    $('couponInput').value = fromUrl;
    try { sessionStorage.setItem(PENDING_COUPON, fromUrl); } catch { /* ignore */ }
  }
  $('couponBtn').onclick = () => applyCoupon($('couponInput').value);
  $('couponInput').onkeydown = e => { if (e.key === 'Enter') applyCoupon($('couponInput').value); };
}

function applyPendingCoupon() {
  let code = null;
  try { code = sessionStorage.getItem(PENDING_COUPON); sessionStorage.removeItem(PENDING_COUPON); } catch { /* ignore */ }
  if (code) {
    $('couponInput').value = code;
    applyCoupon(code);
  }
}

function couponMessage(text, isError) {
  const box = $('couponMsg');
  box.textContent = text;
  box.className = 'notice center' + (isError ? ' notice-error' : '');
  box.hidden = !text;
}

async function applyCoupon(code) {
  code = (code || '').trim();
  if (!code) return;
  if (!me) {
    try { sessionStorage.setItem(PENDING_COUPON, code); } catch { /* ignore */ }
    auth?.login();
    return;
  }
  $('couponBtn').disabled = true;
  try {
    coupon = await auth.billing.checkCoupon(code);
    if (coupon.type === 'gift') {
      couponMessage('🎁 ' + coupon.label);
      const btn = el('button', 'btn btn-primary', 'הפעלת המתנה');
      btn.style.marginInlineStart = '10px';
      btn.onclick = redeemGift;
      $('couponMsg').append(btn);
    } else {
      couponMessage('✓ ' + coupon.label + '. המחירים המעודכנים מופיעים בכרטיסים.');
    }
    renderPlans();
  } catch (e) {
    coupon = null;
    couponMessage(e.message, true);
    renderPlans();
  } finally {
    $('couponBtn').disabled = false;
  }
}

async function redeemGift(e) {
  e.currentTarget.disabled = true;
  try {
    await auth.billing.redeem(coupon.code);
    clearCoupon();
    await refreshMe(true);
    renderQuota();
    renderPlans();
    toast('המתנה הופעלה! 🎉');
    $('workspace').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    couponMessage(err.message, true);
  }
}

function clearCoupon() {
  coupon = null;
  $('couponInput').value = '';
  couponMessage('');
}

// ---------- local history ----------

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; }
}

function saveHistory(name, text) {
  const list = loadHistory().filter(h => h.text !== text);
  list.unshift({ name, text: text.slice(0, 300000), date: Date.now() });
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 5))); } catch { /* storage full or blocked */ }
  renderHistory();
}

function renderHistory() {
  const list = loadHistory();
  $('historyCard').hidden = !list.length;
  const ul = $('historyList');
  ul.textContent = '';
  list.forEach((h, i) => {
    const li = document.createElement('li');
    const name = el('div', 'name', '');
    name.append(el('div', '', h.name));
    name.append(el('div', 'muted small', fmtDate(h.date)));
    const btns = el('div', 'btns', '');
    const open = el('button', 'btn btn-ghost btn-sm', 'פתיחה');
    open.onclick = () => {
      $('resultText').value = h.text;
      $('resultText').dataset.name = h.name;
      $('resultMeta').textContent = h.name;
      $('resultNote').hidden = true;
      $('resultCard').hidden = false;
      $('resultCard').scrollIntoView({ behavior: 'smooth' });
    };
    const del = el('button', 'btn btn-ghost btn-sm', 'מחיקה');
    del.onclick = () => {
      const all = loadHistory();
      all.splice(i, 1);
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(all)); } catch { /* ignore */ }
      renderHistory();
    };
    btns.append(open, del);
    li.append(name, btns);
    ul.append(li);
  });
}

let toastTimer;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}
