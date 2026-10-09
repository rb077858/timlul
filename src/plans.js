// Plans and prices. Change here, deploy, then in /admin.html click
// "יצירת תוכניות ב-PayPal" so PayPal gets the new prices.
//
// Usage is counted in "credits": one minute of audio with the fast model
// costs 1 credit, with the accurate model STRONG_WEIGHT credits.

export const CURRENCY_DEFAULT = 'ILS';

export const PLANS = {
  free:     { name: 'חינם',   price: 0,  credits: 10 },
  basic:    { name: 'בסיסי',  price: 19, credits: 180 },
  pro:      { name: 'מקצועי', price: 49, credits: 600 },
  business: { name: 'עסקי',   price: 99, credits: 1500 },
};

export const PAID_PLAN_KEYS = Object.keys(PLANS).filter(k => PLANS[k].price > 0);

export const STRONG_WEIGHT = 2;

// Approximate OpenAI cost in USD per audio minute, only used for the admin stats.
export const COST_PER_MINUTE = { fast: 0.003, strong: 0.006 };

export function modelIds(env) {
  return {
    fast: env.MODEL_FAST || 'gpt-4o-mini-transcribe',
    strong: env.MODEL_STRONG || 'gpt-4o-transcribe',
  };
}
