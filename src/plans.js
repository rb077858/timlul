// Plans, prices, coupons and subscriptions are all managed in the reem.bi admin
// (login.reembir.com/admin → אתרים → תמלול). This file only has the defaults used when a
// plan in the dashboard doesn't say otherwise in its JSON: {"minutes": 180, "strong": true, "email": true}.
//
// Usage is counted in "credits": one minute of audio with the fast model
// costs 1 credit, with the accurate model STRONG_WEIGHT credits.

export const PLAN_DEFAULTS = {
  free:     { credits: 10,   strong: false, email: false },
  basic:    { credits: 180,  strong: true,  email: true },
  pro:      { credits: 600,  strong: true,  email: true },
  business: { credits: 1500, strong: true,  email: true },
};
// Any other paid plan created in the dashboard without "minutes":
export const PAID_DEFAULT = { credits: 180, strong: true, email: true };

export const STRONG_WEIGHT = 2;

// Approximate OpenAI cost in USD per audio minute, only used for the admin stats.
export const COST_PER_MINUTE = { fast: 0.003, strong: 0.006 };

export function modelIds(env) {
  return {
    fast: env.MODEL_FAST || 'gpt-4o-mini-transcribe',
    strong: env.MODEL_STRONG || 'gpt-4o-transcribe',
  };
}
