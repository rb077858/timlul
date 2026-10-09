const $ = id => document.getElementById(id);
let auth;

init();

async function init() {
  const config = await (await fetch('/api/config')).json();
  if (!window.ReemAuth) return message('מערכת ההתחברות לא זמינה כרגע');
  auth = window.ReemAuth.init({ clientId: config.ssoClientId });
  $('loginBtn').onclick = () => auth.login();
  $('ppSetup').onclick = setupPayPal;
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

async function api(path, method = 'GET') {
  const res = await fetch(path, { method, headers: { Authorization: 'Bearer ' + await auth.getToken() } });
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
