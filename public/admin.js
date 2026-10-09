const $ = id => document.getElementById(id);
let auth;

init();

async function init() {
  const config = await (await fetch('/api/config')).json();
  if (!window.ReemAuth) return message('מערכת ההתחברות לא זמינה כרגע');
  auth = window.ReemAuth.init({ clientId: config.ssoClientId });
  $('loginBtn').onclick = () => auth.login();
  $('ppSetup').onclick = setupPayPal;
  bindCouponForm();
  auth.onChange(user => {
    if (user === undefined) return;
    $('loginBtn').hidden = !!user;
    $('who').textContent = user ? user.email : '';
    if (user) load();
    else message('התחברו עם חשבון מנהל');
  });
}

function message(text) {
  $('msg').textContent = text;
  $('msg').hidden = !text;
}

async function api(path, method = 'GET', body) {
  const headers = { Authorization: 'Bearer ' + await auth.getToken() };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || 'שגיאה ' + res.status);
  return data;
}

function cell(tag, text, className) {
  const e = document.createElement(tag);
  e.textContent = text;
  if (className) e.className = className;
  return e;
}

function tile(label, value, className) {
  const d = document.createElement('div');
  d.append(cell('b', value, className), cell('span', label, 'muted small'));
  return d;
}

async function load() {
  let s;
  try { s = await api('/api/admin/stats'); }
  catch (e) { return message(e.message + '. ודאו שהמייל שלך מופיע ב-ADMIN_EMAILS.'); }
  message('');
  $('panel').hidden = false;

  const conf = $('configured');
  conf.textContent = '';
  for (const [k, v] of Object.entries(s.configured)) conf.append(tile(k, v ? '✓ מוגדר' : '✗ חסר', v ? 'ok' : 'bad'));

  $('ppEnv').textContent = s.paypalEnv === 'sandbox' ? 'בדיקות - sandbox' : 'אמיתי - live';
  const st = $('ppState');
  st.textContent = '';
  if (!s.paypal) {
    st.append(cell('p', 'עדיין לא נוצרו תוכניות. לחצו על הכפתור.', 'bad'));
  } else {
    const changed = Object.entries(s.plans).some(([k, p]) => p.price > 0 && s.paypal.prices[k] !== p.price);
    st.append(cell('p', changed ? 'המחירים בקוד השתנו מאז יצירת התוכניות. לחצו שוב כדי לעדכן.' : '✓ התוכניות קיימות ומעודכנות', changed ? 'bad' : 'ok'));
    for (const [k, id] of Object.entries(s.paypal.plans)) {
      st.append(cell('div', `${s.plans[k]?.name || k}: ${s.paypal.prices[k]} ${s.paypal.currency} · ${id}`, 'muted small'));
    }
  }

  renderDashboard(s);
  plansCache = s.plans;
  renderPlanChecks();
  renderCoupons((await api('/api/admin/coupons')).coupons);

  const stats = $('stats');
  stats.textContent = '';
  const minutes = model => Math.round((s.usage.find(u => u.model === model)?.seconds || 0) / 60);
  stats.append(
    tile('משתמשים רשומים', s.users),
    tile('השתמשו החודש', s.activeUsers),
    tile('דקות במודל המהיר', minutes('fast')),
    tile('דקות במודל המדויק', minutes('strong')),
    tile('עלות OpenAI משוערת', '$' + s.estimatedOpenAiCostUsd),
  );
  const active = {};
  for (const r of s.subs) if (r.status === 'ACTIVE') active[r.plan_key] = (active[r.plan_key] || 0) + r.n;
  let revenue = 0;
  for (const [k, n] of Object.entries(active)) {
    stats.append(tile('מנויים פעילים: ' + (s.plans[k]?.name || k), n));
    revenue += n * (s.plans[k]?.price || 0);
  }
  stats.append(tile('הכנסה חודשית (ברוטו)', revenue + ' ' + s.currency));

  const table = $('subs');
  table.textContent = '';
  const head = document.createElement('tr');
  ['מייל', 'תוכנית', 'סטטוס', 'בתוקף עד'].forEach(h => head.append(cell('th', h)));
  table.append(head);
  for (const r of s.recentSubs) {
    const tr = document.createElement('tr');
    tr.append(cell('td', r.email), cell('td', s.plans[r.plan_key]?.name || r.plan_key), cell('td', r.status),
      cell('td', r.paid_until ? new Date(r.paid_until).toLocaleDateString('he-IL') : ''));
    table.append(tr);
  }
}

async function setupPayPal() {
  if (!confirm('ליצור מוצר ותוכניות חדשים ב-PayPal לפי המחירים בקוד?')) return;
  $('ppSetup').disabled = true;
  try {
    await api('/api/admin/paypal-setup', 'POST');
    message('✓ התוכניות נוצרו ב-PayPal. כפתורי ההרשמה פעילים באתר.');
    await load();
  } catch (e) {
    message('שגיאה: ' + e.message);
  } finally {
    $('ppSetup').disabled = false;
  }
}

// ---------- reem.bi ----------

function renderDashboard(s) {
  const box = $('dashState');
  box.textContent = '';
  const d = s.dashboard;
  if (d.error) {
    box.append(cell('p', '✗ ' + d.error, 'bad'));
    box.append(cell('p', 'בלי החיבור האתר עובד, אבל המנויים לא יופיעו בדשבורד, וקודי מתנה לא יעבדו. ראו שלב 7 במדריך.', 'muted small'));
    return;
  }
  box.append(cell('p', '✓ מחובר. מנויים ששילמו מופיעים בדשבורד reem.bi עם תאריך תפוגה.', 'ok'));
  if (d.missing.length) box.append(cell('p', 'חסרות בדשבורד התוכניות: ' + d.missing.join(', '), 'bad'));
  if (d.defaultPlan !== d.expectedDefault) box.append(cell('p', `מומלץ לבחור בדשבורד את ${d.expectedDefault} כתוכנית ברירת המחדל`, 'muted small'));
  const list = Object.entries(s.plans).map(([k, p]) => `${p.name}: ${p.credits} דקות${p.strong ? '' : ', בלי מודל מדויק'}${p.email ? '' : ', בלי מייל'}`);
  box.append(cell('p', 'הגדרות פעילות: ' + list.join(' · '), 'muted small'));
}

// ---------- coupons ----------

let plansCache = {};
const TYPE_HELP = {
  percent: ['אחוז הנחה', 'לכמה חודשים (0 = לתמיד)', 'הלקוח משלם מחיר מוזל בחודשים הראשונים, ואחר כך מחיר רגיל. 0 חודשים = הנחה לכל תקופת המנוי.'],
  amount: ['הנחה בשקלים לחודש', 'לכמה חודשים (0 = לתמיד)', 'כמה שקלים יורדים מהמחיר החודשי. אם ההנחה גדולה מהמחיר, החודשים האלה חינם.'],
  trial: [null, 'כמה חודשים חינם', 'הלקוח נרשם ב-PayPal עם כרטיס, לא משלם בחודשים האלה, ואחר כך מחויב במחיר הרגיל (אלא אם ביטל).'],
  gift: [null, 'כמה חודשים', 'הלקוח מקבל את התוכנית בלי לשלם ובלי כרטיס. בסוף התקופה חוזר לחינם. מופיע בדשבורד reem.bi.'],
};

function bindCouponForm() {
  const form = $('couponForm');
  form.type.onchange = updateCouponForm;
  $('randCode').onclick = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    form.code.value = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => chars[b % chars.length]).join('');
  };
  form.onsubmit = async e => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const plan_keys = [...form.querySelectorAll('input[name=plan]:checked')].map(i => i.value);
      const expires = form.expires.value ? new Date(form.expires.value + 'T23:59:59').getTime() : null;
      const r = await api('/api/admin/coupons', 'POST', {
        code: form.code.value, type: form.type.value, value: form.value.value, months: form.months.value,
        plan_keys, max_uses: form.max_uses.value, expires_at: expires, note: form.note.value,
      });
      renderCoupons(r.coupons);
      message('✓ הקוד נוצר');
      form.code.value = '';
      form.note.value = '';
    } catch (err) {
      message('שגיאה: ' + err.message);
    } finally {
      btn.disabled = false;
    }
  };
  updateCouponForm();
}

function updateCouponForm() {
  const form = $('couponForm');
  const [valueLabel, monthsLabel, help] = TYPE_HELP[form.type.value];
  $('valueField').hidden = !valueLabel;
  if (valueLabel) $('valueLabel').textContent = valueLabel;
  $('monthsLabel').textContent = monthsLabel;
  $('couponHelp').textContent = help;
  if (form.type.value !== 'percent' && form.type.value !== 'amount' && Number(form.months.value) < 1) form.months.value = 1;
  renderPlanChecks();
}

function renderPlanChecks() {
  const box = $('planChecks');
  const gift = $('couponForm').type.value === 'gift';
  $('plansLabel').textContent = gift ? 'איזו תוכנית מקבלים במתנה' : 'לאילו תוכניות (בלי סימון = כולן)';
  box.textContent = '';
  for (const [key, p] of Object.entries(plansCache)) {
    if (!p.price) continue;
    const label = document.createElement('label');
    label.className = 'small';
    label.style.display = 'flex';
    label.style.gap = '6px';
    label.style.alignItems = 'center';
    const input = document.createElement('input');
    input.type = gift ? 'radio' : 'checkbox';
    input.name = 'plan';
    input.value = key;
    label.append(input, document.createTextNode(`${p.name} (${p.price})`));
    box.append(label);
  }
}

function renderCoupons(list) {
  const table = $('couponTable');
  table.textContent = '';
  if (!list.length) { table.append(cell('caption', 'עוד אין קודים', 'muted small')); return; }
  const head = document.createElement('tr');
  ['קוד', 'מה הוא נותן', 'שימושים', 'בתוקף עד', 'מצב', ''].forEach(h => head.append(cell('th', h)));
  table.append(head);
  for (const c of list) {
    const tr = document.createElement('tr');
    const plans = c.type === 'gift' ? '' : ' · ' + c.plan_keys.map(k => plansCache[k]?.name || k).join(', ');
    const label = cell('td', c.label + plans);
    if (c.note) label.title = c.note;
    tr.append(
      cell('td', c.code),
      label,
      cell('td', c.uses + (c.max_uses ? ' / ' + c.max_uses : '')),
      cell('td', c.expires_at ? new Date(c.expires_at).toLocaleDateString('he-IL') : 'ללא'),
      cell('td', c.active ? 'פעיל' : 'מושבת', c.active ? 'ok' : 'bad'),
    );
    const actions = document.createElement('td');
    const link = cell('button', 'קישור', 'btn btn-ghost btn-sm');
    link.onclick = () => {
      const url = location.origin + '/?coupon=' + encodeURIComponent(c.code);
      navigator.clipboard.writeText(url).then(() => message('הקישור הועתק: ' + url), () => message(url));
    };
    const toggle = cell('button', c.active ? 'השבתה' : 'הפעלה', 'btn btn-ghost btn-sm');
    toggle.onclick = async () => renderCoupons((await api(`/api/admin/coupons/${c.code}/${c.active ? 'disable' : 'enable'}`, 'POST')).coupons);
    actions.append(link, toggle);
    if (!c.uses) {
      const del = cell('button', 'מחיקה', 'btn btn-ghost btn-sm');
      del.onclick = async () => {
        if (!confirm(`למחוק את ${c.code}?`)) return;
        try { renderCoupons((await api('/api/admin/coupons/' + c.code, 'DELETE')).coupons); }
        catch (e) { message(e.message); }
      };
      actions.append(del);
    }
    actions.style.display = 'flex';
    actions.style.gap = '6px';
    tr.append(actions);
    table.append(tr);
  }
}
