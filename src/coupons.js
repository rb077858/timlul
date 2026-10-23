// Coupon codes, managed from the reem.bi admin (login.reembir.com/admin → אתרים → תמלול → לוח ניהול).
//
//   percent  value% off the monthly price, for `months` months (0 = for as long as the subscription lasts)
//   amount   value (in the site's currency) off the monthly price, same `months` rule
//   trial    the first `months` months free, then the regular price (PayPal still asks for a card)
//   gift     `months` months of one plan with no payment at all (written to reem.bi)
//
// Discounted subscriptions are separate PayPal plans with a trial period, created
// automatically per coupon and per plan.
import { PLANS, PAID_PLAN_KEYS } from './plans.js';

export const COUPON_TYPES = ['percent', 'amount', 'trial', 'gift'];

const round2 = n => Math.round(n * 100) / 100;

export function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
}

// Validates admin input; returns the coupon row or throws an Error with a Hebrew message.
export function validateCoupon(input) {
  const code = normalizeCode(input.code);
  if (!/^[A-Z0-9_-]{3,30}$/.test(code)) throw new Error('קוד: 3-30 תווים, אותיות באנגלית, ספרות, מקף או קו תחתון');
  const type = input.type;
  if (!COUPON_TYPES.includes(type)) throw new Error('סוג קופון לא מוכר');
  const value = Number(input.value) || 0;
  const months = Math.round(Number(input.months) || 0);
  let planKeys = (Array.isArray(input.plan_keys) ? input.plan_keys : []).filter(k => PAID_PLAN_KEYS.includes(k));

  if (type === 'percent' && !(value > 0 && value <= 100)) throw new Error('אחוז ההנחה צריך להיות בין 1 ל-100');
  if (type === 'amount' && !(value > 0)) throw new Error('סכום ההנחה צריך להיות גדול מ-0');
  if ((type === 'percent' || type === 'amount') && (months < 0 || months > 24)) throw new Error('מספר החודשים: 0 (לתמיד) עד 24');
  if (type === 'percent' && value === 100 && months === 0) throw new Error('100% לתמיד זה מתנה. בחרו סוג "מתנה" עם מספר חודשים');
  if (type === 'trial' && (months < 1 || months > 12)) throw new Error('חודשים חינם: 1 עד 12');
  if (type === 'gift') {
    if (months < 1 || months > 24) throw new Error('מתנה: 1 עד 24 חודשים');
    if (planKeys.length !== 1) throw new Error('במתנה בוחרים תוכנית אחת בדיוק');
  }
  if (type !== 'gift' && !planKeys.length) planKeys = [...PAID_PLAN_KEYS];

  const maxUses = Math.max(0, Math.round(Number(input.max_uses) || 0));
  const expiresAt = input.expires_at ? Number(input.expires_at) : null;
  if (expiresAt !== null && !(expiresAt > Date.now())) throw new Error('תאריך התפוגה כבר עבר');

  return {
    code, type, value: type === 'trial' || type === 'gift' ? 0 : value, months,
    plan_keys: planKeys, max_uses: maxUses, expires_at: expiresAt,
    note: String(input.note || '').slice(0, 200),
  };
}

// What a coupon does to one plan: { firstPrice, months, regularPrice } or null if it doesn't apply.
// months = 0 means the first price lasts for the whole subscription.
export function couponOffer(coupon, planKey) {
  const plan = PLANS[planKey];
  if (!plan || !plan.price || coupon.type === 'gift' || !coupon.plan_keys.includes(planKey)) return null;
  let first;
  if (coupon.type === 'percent') first = round2(plan.price * (1 - coupon.value / 100));
  else if (coupon.type === 'amount') first = round2(Math.max(0, plan.price - coupon.value));
  else first = 0;
  if (coupon.months === 0 && first <= 0) return null; // can't be free forever
  return {
    firstPrice: first,
    months: coupon.months,
    regularPrice: coupon.months === 0 ? first : plan.price,
  };
}

export function couponLabel(coupon, currency) {
  const cur = currency === 'ILS' ? '₪' : currency + ' ';
  const period = m => (m === 1 ? 'לחודש הראשון' : `ל-${m} החודשים הראשונים`);
  switch (coupon.type) {
    case 'percent': return `${coupon.value}% הנחה ${coupon.months ? period(coupon.months) : 'לכל תקופת המנוי'}`;
    case 'amount': return `${cur}${coupon.value} הנחה בחודש ${coupon.months ? period(coupon.months) : 'לכל תקופת המנוי'}`;
    case 'trial': return coupon.months === 1 ? 'חודש ראשון חינם' : `${coupon.months} חודשים ראשונים חינם`;
    case 'gift': return `מתנה: ${coupon.months === 1 ? 'חודש' : coupon.months + ' חודשים'} בתוכנית ${PLANS[coupon.plan_keys[0]]?.name || ''}, בלי תשלום`;
    default: return '';
  }
}

// The reason a coupon can't be used right now, or null.
export function couponProblem(coupon, now = Date.now()) {
  if (!coupon || !coupon.active) return 'הקוד לא קיים או לא פעיל';
  if (coupon.expires_at && coupon.expires_at < now) return 'תוקף הקוד פג';
  if (coupon.max_uses && coupon.uses >= coupon.max_uses) return 'הקוד כבר נוצל עד הסוף';
  return null;
}

// PayPal billing cycles for a discounted subscription.
export function billingCycles(offer, currency) {
  const price = v => ({ fixed_price: { value: String(v), currency_code: currency } });
  const month = { interval_unit: 'MONTH', interval_count: 1 };
  if (offer.months === 0) {
    return [{ frequency: month, tenure_type: 'REGULAR', sequence: 1, total_cycles: 0, pricing_scheme: price(offer.firstPrice) }];
  }
  const trial = { frequency: month, tenure_type: 'TRIAL', sequence: 1, total_cycles: offer.months };
  if (offer.firstPrice > 0) trial.pricing_scheme = price(offer.firstPrice);
  return [trial, { frequency: month, tenure_type: 'REGULAR', sequence: 2, total_cycles: 0, pricing_scheme: price(offer.regularPrice) }];
}
