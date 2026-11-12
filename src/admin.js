// What this site shares with the reem.bi dashboard (Sites → תמלול → נתונים), through
// GET /api/admin/manifest, and the forms it offers there (POST /api/admin/actions/<id>).
//
// OpenAI has no API for the prepaid credit balance, so the balance is kept here: the admin types
// the balance shown in OpenAI's billing page ("עדכון יתרה") and any top-up after it ("טענתי
// קרדיטים"); what was spent since is subtracted. Spending comes from OpenAI's Costs API when an
// admin key is set (OPENAI_ADMIN_KEY, the whole organization), otherwise it is estimated from the
// minutes transcribed here (COST_PER_MINUTE).
import { COST_PER_MINUTE, modelIds } from './plans.js';

const DAY = 86400000;
const USD_ILS = 3.2;
const round2 = n => Math.round(n * 100) / 100;
const usd = n => '$' + round2(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const heDate = ms => new Date(ms).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', timeZone: 'Asia/Jerusalem' });
const dayKey = ms => new Date(ms).toISOString().slice(0, 10);

function monthStart(now = Date.now()) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

// ---------- OpenAI Costs API (optional) ----------

async function openaiCosts(env, store, sinceMs) {
  if (!env.OPENAI_ADMIN_KEY) return null;
  const cached = await store.cacheGet('openai-costs', 30 * 60 * 1000);
  if (cached && cached.since <= sinceMs) return cached;
  const days = {};
  let page = null;
  try {
    for (let i = 0; i < 4; i++) {
      const q = new URLSearchParams({ start_time: String(Math.floor(sinceMs / 1000)), bucket_width: '1d', limit: '31' });
      if (page) q.set('page', page);
      const res = await fetch('https://api.openai.com/v1/organization/costs?' + q, { headers: { Authorization: 'Bearer ' + env.OPENAI_ADMIN_KEY } });
      if (!res.ok) throw new Error('OpenAI ' + res.status);
      const d = await res.json();
      for (const b of d.data || []) {
        const k = dayKey(b.start_time * 1000);
        days[k] = (days[k] || 0) + (b.results || []).reduce((a, r) => a + Number(r.amount?.value || 0), 0);
      }
      if (!d.has_more || !d.next_page) break;
      page = d.next_page;
    }
  } catch (e) {
    return { error: e.message };
  }
  const out = { since: sinceMs, days, at: Date.now() };
  await store.cachePut('openai-costs', out);
  return out;
}

// ---------- the manifest ----------

export async function adminManifest(env, store) {
  const now = Date.now();
  const month = monthStart(now);
  const from30 = now - 30 * DAY;
  const ledger = await store.ledger();
  const reading = ledger.find(e => e.kind === 'balance') || null;
  const readingDayEnd = reading ? Date.parse(dayKey(reading.ts) + 'T00:00:00Z') + DAY : 0;
  const d = await store.adminData({ month, from30, day: now - DAY, readingTs: reading ? reading.ts : null, readingDayEnd });
  const costOf = m => m.fast * COST_PER_MINUTE.fast + m.strong * COST_PER_MINUTE.strong + (m.summary || 0) * COST_PER_MINUTE.fast;
  const ids = modelIds(env);

  // Estimated cost per day and model, from the minutes transcribed here.
  const labels = [];
  for (let t = now - 29 * DAY; t <= now; t += DAY) labels.push(dayKey(t));
  const est = { fast: labels.map(() => 0), strong: labels.map(() => 0), summary: labels.map(() => 0) };
  const mins = { fast: labels.map(() => 0), strong: labels.map(() => 0) };
  for (const r of d.daily) {
    const i = labels.indexOf(r.day);
    if (i < 0 || !est[r.model]) continue;
    if (r.model === 'summary') { est.summary[i] += r.credits * COST_PER_MINUTE.fast; continue; }
    est[r.model][i] += (r.seconds / 60) * COST_PER_MINUTE[r.model];
    mins[r.model][i] += r.seconds / 60;
  }
  const estDay = labels.map((_, i) => est.fast[i] + est.strong[i] + est.summary[i]);

  // Real spending from OpenAI when there is an admin key.
  const costs = await openaiCosts(env, store, Math.min(from30, reading ? reading.ts - DAY : from30));
  const real = costs && !costs.error ? costs : null;
  const dayCost = real ? labels.map(k => real.days[k] || 0) : estDay;
  const sum = arr => arr.reduce((a, b) => a + b, 0);
  const monthCost = real
    ? Object.entries(real.days).filter(([k]) => k >= dayKey(month)).reduce((a, [, v]) => a + v, 0)
    : costOf(d.monthMinutes);
  const cost30 = sum(dayCost);
  const avg14 = sum(dayCost.slice(-14)) / 14;

  // Balance: the last reading, plus top-ups after it, minus what was spent since.
  let balance = null;
  if (reading) {
    const topups = ledger.filter(e => e.kind === 'topup' && e.ts > reading.ts).reduce((a, e) => a + e.usd, 0);
    let spent;
    if (real) {
      const k0 = dayKey(reading.ts);
      // Whole days after the reading from OpenAI; the rest of the reading's own day from here.
      spent = Object.entries(real.days).filter(([k]) => k > k0).reduce((a, [, v]) => a + v, 0);
      spent += costOf(d.readingDayRest);
    } else {
      spent = costOf(d.sinceReading);
    }
    const total = reading.usd + topups;
    const left = Math.max(0, total - spent);
    const days = avg14 > 0 ? left / avg14 : null;
    balance = { total, left, spent, days, end: days !== null ? now + days * DAY : null, at: reading.ts };
  }

  const tone = balance ? (balance.left <= 0 ? 'bad' : balance.days !== null && balance.days < 14 ? 'warn' : 'good') : 'warn';
  const totalMin = sum(mins.fast) + sum(mins.strong);
  const monthMin = d.monthMinutes;

  return {
    version: 2,
    name: 'תמלול',
    finance: { cost_month_usd: round2(monthCost), cost_30d_usd: round2(cost30), source: real ? 'openai' : 'estimate', usd_ils: USD_ILS },
    // Short numbers for the site's overview tab (the dashboard shows everything else under "נתונים").
    stats: [
      { label: 'השתמשו החודש', value: d.activeUsers },
      { label: 'דקות תמלול החודש', value: Math.round(monthMin.fast + monthMin.strong).toLocaleString('he-IL') },
      { label: 'עלות OpenAI החודש', value: usd(monthCost) },
      ...(balance ? [{ label: 'יתרה ב-OpenAI', value: usd(balance.left) }] : []),
    ],
    sections: [
      {
        title: 'OpenAI',
        subtitle: real ? 'העלויות לפי OpenAI (כל הארגון)' : 'הערכה לפי הדקות שתומללו כאן. למספרים מדויקים: OPENAI_ADMIN_KEY',
        items: [
          balance
            ? {
              type: 'meter', label: 'יתרת קרדיטים', value: round2(balance.left), max: round2(balance.total), display: usd(balance.left),
              sub: balance.days === null ? 'אין עדיין שימוש לחשב לפיו'
                : `מספיק לעוד כ-${Math.round(balance.days)} ימים, עד ${heDate(balance.end)} בערך`,
              note: `מתוך ${usd(balance.total)} מאז ${heDate(balance.at)} · נוצלו ${usd(balance.spent)}`,
              tone,
            }
            : { type: 'note', tone: 'warn', text: 'היתרה עוד לא ידועה. העתיקו את היתרה מדף החיוב של OpenAI לטופס "עדכון יתרה" למטה, ומכאן היא תתעדכן לבד.' },
          { type: 'kpi', label: 'עלות החודש', value: usd(monthCost), sub: '≈ ₪' + Math.round(monthCost * USD_ILS * 10) / 10 },
          { type: 'kpi', label: 'עלות 30 יום', value: usd(cost30), sub: '≈ ₪' + Math.round(cost30 * USD_ILS * 10) / 10 },
          { type: 'kpi', label: 'ממוצע ליום', value: usd(avg14), sub: 'לפי 14 הימים האחרונים' },
          { type: 'kpi', label: 'עלות לשעת תמלול', value: totalMin ? usd(cost30 / totalMin * 60) : '—', sub: 'בפועל, ב-30 יום' },
          real
            ? { type: 'chart', label: 'עלות ליום, 30 יום', unit: '$', labels, series: [{ name: 'OpenAI', values: dayCost.map(round2) }] }
            : { type: 'chart', label: 'עלות ליום (הערכה), 30 יום', unit: '$', labels, stacked: true,
              series: [{ name: 'מהיר', values: est.fast.map(v => Math.round(v * 1000) / 1000) }, { name: 'מדויק', values: est.strong.map(v => Math.round(v * 1000) / 1000) }, { name: 'סיכומים', values: est.summary.map(v => Math.round(v * 1000) / 1000) }] },
        ],
      },
      {
        title: 'שימוש',
        subtitle: 'החודש, מתחילת החודש הקלנדרי',
        items: [
          { type: 'kpi', label: 'משתמשים פעילים', value: d.activeUsers, sub: `מתוך ${d.users} שנרשמו` },
          { type: 'kpi', label: 'משתמשים חדשים', value: d.newUsers },
          { type: 'kpi', label: 'דקות תמלול', value: Math.round(monthMin.fast + monthMin.strong).toLocaleString('he-IL') },
          { type: 'kpi', label: 'קבצים שתומללו', value: d.monthChunks.toLocaleString('he-IL'), sub: 'קטעים שנשלחו ל-OpenAI' },
          { type: 'kpi', label: 'סיכומי AI', value: d.monthSummaries.toLocaleString('he-IL'), sub: `≈ ${usd(d.monthMinutes.summary * COST_PER_MINUTE.fast)}` },
          { type: 'kpi', label: 'דקות מחבילות ומתנות', value: Math.round(d.packMinutes) },
          { type: 'kpi', label: 'מיילים ב-24 שעות', value: d.emails24 },
          { type: 'chart', label: 'דקות תמלול ליום, 30 יום', unit: 'דק׳', labels, stacked: true,
            series: [{ name: 'מהיר', values: mins.fast.map(Math.round) }, { name: 'מדויק', values: mins.strong.map(Math.round) }] },
          { type: 'split', label: 'מודלים החודש', unit: 'דקות', parts: [
            { label: 'מהיר', value: Math.round(monthMin.fast) },
            { label: 'מדויק', value: Math.round(monthMin.strong) },
          ] },
        ],
      },
    ],
    checks: [
      ...['OPENAI_API_KEY', 'ADMIN_EMAILS'].map(k => ({ label: k, ok: !!env[k], detail: env[k] ? 'מוגדר' : 'חסר ב-Cloudflare ← Worker timlul ← Variables and Secrets' })),
      {
        // Optional: only a key that is set and fails needs attention.
        label: 'OPENAI_ADMIN_KEY', ok: !costs?.error,
        detail: real ? 'העלויות מגיעות מ-OpenAI' : costs?.error ? `לא עובד: ${costs.error}` : 'לא חובה. בלעדיו העלויות הן הערכה לפי הדקות. יוצרים ב-OpenAI ← Settings ← Admin keys',
      },
      { label: 'מודלים', ok: true, detail: `מהיר: ${ids.fast} · מדויק: ${ids.strong}` },
    ],
    actions: [
      {
        id: 'openai-balance', label: 'עדכון יתרה', primary: true,
        description: 'מעתיקים את היתרה מ-platform.openai.com ← Settings ← Billing. מכאן היא יורדת לבד לפי השימוש.',
        fields: [{ name: 'usd', label: 'יתרה כרגע ($)', type: 'number', step: '0.01', min: '0', required: true }],
      },
      {
        id: 'openai-topup', label: 'טענתי קרדיטים',
        description: 'כשטוענים קרדיטים ב-OpenAI, רושמים כאן כמה, והיתרה עולה בהתאם.',
        fields: [{ name: 'usd', label: 'כמה טענתי ($)', type: 'number', step: '0.01', min: '0.01', required: true }],
      },
    ],
    lists: [
      {
        title: 'הכי הרבה שימוש החודש',
        empty: 'עוד אין שימוש החודש',
        items: d.topUsers.map(u => ({
          title: u.email,
          subtitle: `${Math.round(u.seconds / 60)} דקות הקלטה · ${Math.round(u.credits)} דקות מהמכסה`,
        })),
      },
      {
        title: 'יתרה וטעינות',
        empty: 'עוד לא נרשמה יתרה',
        items: ledger.slice(0, 10).map(e => ({
          title: (e.kind === 'balance' ? 'יתרה: ' : 'טעינה: ') + usd(e.usd), date: e.ts, dateLabel: '',
          badge: e.kind === 'balance' ? 'עדכון' : 'טעינה', badgeLevel: e.kind === 'topup' ? 'green' : '',
        })),
      },
    ],
  };
}

export async function adminAction(env, store, id, body) {
  const v = Number(body && body.usd);
  if (id === 'openai-balance') {
    if (!Number.isFinite(v) || v < 0 || v > 100000) return { status: 400, data: { error: 'bad_amount', message: 'כתבו את היתרה בדולרים, למשל 12.40' } };
    await store.addLedger('balance', v);
    return { status: 200, data: { message: `היתרה עודכנה: ${usd(v)}` } };
  }
  if (id === 'openai-topup') {
    if (!Number.isFinite(v) || v <= 0 || v > 100000) return { status: 400, data: { error: 'bad_amount', message: 'כתבו כמה דולר טענתם, למשל 20' } };
    if (!(await store.hasBalance())) return { status: 400, data: { error: 'no_balance', message: 'קודם עדכנו את היתרה הנוכחית ב"עדכון יתרה"' } };
    await store.addLedger('topup', v);
    return { status: 200, data: { message: `נרשמה טעינה של ${usd(v)}` } };
  }
  return { status: 404, data: { error: 'not_found', message: 'פעולה לא מוכרת' } };
}
