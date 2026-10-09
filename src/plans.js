// Plans and prices. Prices live here (PayPal needs them); after changing a price,
// deploy and click "יצירת תוכניות ב-PayPal" in /admin.html.
//
// Minutes and features can also be managed from the reem.bi dashboard: a plan there
// called "timlul:<key>" with JSON like {"minutes": 180, "strong": true, "email": true}
// overrides the defaults below (see docs/SETUP-HE.md).
//
// Usage is counted in "credits": one minute of audio with the fast model
// costs 1 credit, with the accurate model STRONG_WEIGHT credits.

export const CURRENCY_DEFAULT = 'ILS';

export const PLANS = {
  free:     { name: 'חינם',   price: 0,  credits: 10,   strong: false, email: false },
  basic:    { name: 'בסיסי',  price: 9,  credits: 180,  strong: true,  email: true },
  pro:      { name: 'מקצועי', price: 19, credits: 600,  strong: true,  email: true },
  business: { name: 'עסקי',   price: 39, credits: 1500, strong: true,  email: true },
};

export const PLAN_ORDER = Object.keys(PLANS);
export const PAID_PLAN_KEYS = PLAN_ORDER.filter(k => PLANS[k].price > 0);
export const rank = key => PLAN_ORDER.indexOf(key);

export const STRONG_WEIGHT = 2;

// Approximate OpenAI cost in USD per audio minute, only used for the admin stats.
export const COST_PER_MINUTE = { fast: 0.003, strong: 0.006 };

export function modelIds(env) {
  return {
    fast: env.MODEL_FAST || 'gpt-4o-mini-transcribe',
    strong: env.MODEL_STRONG || 'gpt-4o-transcribe',
  };
}
