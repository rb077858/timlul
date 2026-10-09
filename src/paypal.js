// Minimal PayPal REST client (subscriptions).

let cachedToken = null; // { key, token, expires }

export function paypalEnv(env) {
  return env.PAYPAL_ENV === 'sandbox' ? 'sandbox' : 'live';
}

function apiBase(env) {
  return paypalEnv(env) === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
}

async function accessToken(env) {
  const key = env.PAYPAL_CLIENT_ID + paypalEnv(env);
  if (cachedToken && cachedToken.key === key && cachedToken.expires > Date.now()) return cachedToken.token;
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) throw new Error('PayPal לא מוגדר (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET)');
  const res = await fetch(apiBase(env) + '/v1/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(env.PAYPAL_CLIENT_ID + ':' + env.PAYPAL_CLIENT_SECRET),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error('PayPal: התחברות נכשלה (' + res.status + '). בדוק את המפתחות ואת PAYPAL_ENV');
  const data = await res.json();
  cachedToken = { key, token: data.access_token, expires: Date.now() + (data.expires_in - 60) * 1000 };
  return cachedToken.token;
}

export async function paypal(env, method, path, body) {
  const res = await fetch(apiBase(env) + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + await accessToken(env),
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error('PayPal ' + path + ': ' + (data?.message || res.status));
    err.status = res.status;
    err.details = data;
    throw err;
  }
  return data;
}

export function getSubscription(env, id) {
  return paypal(env, 'GET', '/v1/billing/subscriptions/' + encodeURIComponent(id));
}

export function cancelSubscription(env, id, reason) {
  return paypal(env, 'POST', '/v1/billing/subscriptions/' + encodeURIComponent(id) + '/cancel', { reason });
}

export async function createProductAndPlans(env, plans, currency) {
  const product = await paypal(env, 'POST', '/v1/catalogs/products', {
    name: 'תמלול אודיו ווידאו',
    description: 'מנוי חודשי לשירות תמלול',
    type: 'SERVICE',
    category: 'SOFTWARE',
  });
  const created = {};
  for (const [key, plan] of plans) {
    const p = await paypal(env, 'POST', '/v1/billing/plans', {
      product_id: product.id,
      name: 'תמלול - ' + plan.name,
      description: plan.credits + ' דקות תמלול בחודש',
      status: 'ACTIVE',
      billing_cycles: [{
        frequency: { interval_unit: 'MONTH', interval_count: 1 },
        tenure_type: 'REGULAR',
        sequence: 1,
        total_cycles: 0,
        pricing_scheme: { fixed_price: { value: String(plan.price), currency_code: currency } },
      }],
      payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 1 },
    });
    created[key] = p.id;
  }
  return { productId: product.id, plans: created };
}
