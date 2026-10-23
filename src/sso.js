// reem.bi (login.reembir.com): who the user is and which plan they have on this site.
// Payments, coupons and plan changes all happen in reem.bi; the plan arrives here in userinfo.
import { PLAN_DEFAULTS, PAID_DEFAULT } from './plans.js';

const ssoUrl = env => env.SSO_URL || 'https://login.reembir.com';
export const clientId = env => env.SSO_CLIENT_ID || 'timlul';

const userCache = new Map(); // Authorization header -> { user, expires }

// fresh = skip the one-minute cache (right after a payment or a coupon).
export async function authenticate(request, env, { fresh = false } = {}) {
  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Bearer ') || header.length < 15) return null;
  const cached = userCache.get(header);
  if (!fresh && cached && cached.expires > Date.now()) return cached.user;

  const res = await fetch(ssoUrl(env) + '/api/userinfo', { headers: { Authorization: header } });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data?.user?.email) return null;
  const user = {
    id: data.user.id,
    email: String(data.user.email).toLowerCase(),
    name: data.user.name || '',
    access: data.access || {},
  };
  if (userCache.size > 500) userCache.clear();
  userCache.set(header, { user, expires: Date.now() + 60000 });
  return user;
}

// Unlimited minutes: {"unlimited": true} (or {"minutes": -1}) in the plan's JSON or in the
// user's personal permissions in the dashboard.
export function isUnlimited(f) {
  return f.unlimited === true || Number(f.minutes) === -1;
}

function pickFeatures(f) {
  const out = {};
  if (f.minutes !== null && f.minutes !== '' && Number.isFinite(Number(f.minutes)) && Number(f.minutes) >= 0) out.credits = Number(f.minutes);
  if (typeof f.strong === 'boolean') out.strong = f.strong;
  if (typeof f.email === 'boolean') out.email = f.email;
  return out;
}

// What the user may do: their plan in the dashboard + its JSON + their personal permissions.
export function userPlan(env, user) {
  const access = user.access || {};
  const id = access.plan?.id || '';
  const prefix = clientId(env) + ':';
  const key = id.startsWith(prefix) ? id.slice(prefix.length) : 'free';
  const features = access.features && typeof access.features === 'object' ? access.features : {};
  const base = PLAN_DEFAULTS[key] || (key === 'free' ? PLAN_DEFAULTS.free : PAID_DEFAULT);
  let plan = { key, name: access.plan?.name || 'חינם', ...base, ...pickFeatures(features) };
  if (isUnlimited(features)) plan = { ...plan, name: 'ללא הגבלה', credits: Infinity, strong: true, email: true, unlimited: true };
  return {
    plan,
    expiresAt: access.plan_expires_at ? access.plan_expires_at * 1000 : null,
    subscription: access.subscription || null,
  };
}
