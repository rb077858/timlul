// reem.bi (login.reembir.com): who the user is, which plan the dashboard gives
// them, and writing plans back with the site's server key (SSO_SITE_KEY).
import { PLANS } from './plans.js';

const ssoUrl = env => env.SSO_URL || 'https://login.reembir.com';
export const clientId = env => env.SSO_CLIENT_ID || 'timlul';

const userCache = new Map(); // Authorization header -> { user, expires }

export async function authenticate(request, env) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ') || header.length < 15) return null;
  const cached = userCache.get(header);
  if (cached && cached.expires > Date.now()) return cached.user;

  const res = await fetch(ssoUrl(env) + '/api/userinfo', { headers: { Authorization: header } });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data?.user?.email) return null;
  const user = {
    id: data.user.id,
    email: String(data.user.email).toLowerCase(),
    name: data.user.name || '',
    access: data.access || {},
    cacheKey: header,
  };
  if (userCache.size > 500) userCache.clear();
  userCache.set(header, { user, expires: Date.now() + 60000 });
  return user;
}

export function forgetUser(user) {
  userCache.delete(user.cacheKey);
}

// The plan the reem.bi dashboard gives this user on this site: { key, expiresAt, features }.
// key is null when the dashboard has no timlul plan for them.
export function ssoPlan(env, user) {
  const access = user.access || {};
  const id = access.plan?.id || '';
  const prefix = clientId(env) + ':';
  const key = id.startsWith(prefix) && PLANS[id.slice(prefix.length)] ? id.slice(prefix.length) : null;
  return {
    key,
    expiresAt: key && access.plan_expires_at ? access.plan_expires_at * 1000 : null,
    features: access.features && typeof access.features === 'object' ? access.features : {},
  };
}

// Only these feature names are read from the dashboard JSON.
// Unlimited minutes for one user: {"unlimited": true} (or {"minutes": -1}) in their
// personal permissions in the dashboard. Not a plan, nobody else sees it.
export function isUnlimited(f) {
  return f.unlimited === true || Number(f.minutes) === -1;
}

export function pickFeatures(f) {
  const out = {};
  if (Number.isFinite(Number(f.minutes)) && f.minutes !== null && f.minutes !== '' && Number(f.minutes) >= 0) out.credits = Number(f.minutes);
  if (typeof f.strong === 'boolean') out.strong = f.strong;
  if (typeof f.email === 'boolean') out.email = f.email;
  return out;
}

let plansCache = { at: 0, env: null, data: null };

// The site's plans as defined in the dashboard (for minutes/features), cached for 5 minutes.
// Returns { plans: { key: {credits?, strong?, email?} }, ids: [...] } or { error }.
export async function dashboardPlans(env, { fresh = false } = {}) {
  if (!env.SSO_SITE_KEY) return { error: 'SSO_SITE_KEY חסר' };
  if (!fresh && plansCache.data && plansCache.env === env.SSO_SITE_KEY && Date.now() - plansCache.at < 300000) return plansCache.data;
  let data;
  try {
    const res = await fetch(ssoUrl(env) + '/api/site/plans', { headers: { 'x-site-key': env.SSO_SITE_KEY } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      data = { error: body.message || 'reem.bi: ' + res.status };
    } else {
      const prefix = clientId(env) + ':';
      const plans = {};
      for (const p of body.plans || []) {
        if (p.id.startsWith(prefix) && PLANS[p.id.slice(prefix.length)]) plans[p.id.slice(prefix.length)] = pickFeatures(p.features || {});
      }
      data = { plans, ids: (body.plans || []).map(p => p.id), defaultPlan: body.site?.default_plan || null };
    }
  } catch (e) {
    data = { error: 'reem.bi לא זמין: ' + e.message };
  }
  plansCache = { at: Date.now(), env: env.SSO_SITE_KEY, data };
  return data;
}

// PLANS merged with the minutes/features set in the dashboard.
export async function planDefs(env) {
  const dash = await dashboardPlans(env);
  const out = {};
  for (const [key, p] of Object.entries(PLANS)) out[key] = { ...p, ...(dash.plans?.[key] || {}) };
  return out;
}

// Sets the user's timlul plan in reem.bi (planKey null = back to the default plan).
export async function setDashboardPlan(env, email, planKey, expiresAtMs) {
  if (!env.SSO_SITE_KEY) throw new Error('SSO_SITE_KEY לא הוגדר');
  const res = await fetch(ssoUrl(env) + '/api/site/access', {
    method: 'PUT',
    headers: { 'x-site-key': env.SSO_SITE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      plan_id: planKey ? clientId(env) + ':' + planKey : null,
      expires_at: expiresAtMs ? Math.floor(expiresAtMs / 1000) : null,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('reem.bi: ' + (body.message || res.status));
  return body;
}
