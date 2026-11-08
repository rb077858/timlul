// Minimal PayPal REST client: one-time orders for the extra-minute packs.
// (Monthly subscriptions go through reem.bi; this uses the same PayPal account keys.)

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

// One-time payments (extra-minute packs), PayPal Orders v2.
export function createOrder(env, { referenceId, customId, description, value, currency }) {
  return paypal(env, 'POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: referenceId,
      custom_id: customId,
      description,
      amount: { currency_code: currency, value: String(value) },
    }],
    application_context: { brand_name: 'תמלול', shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW' },
  });
}

export function getOrder(env, id) {
  return paypal(env, 'GET', '/v2/checkout/orders/' + encodeURIComponent(id));
}

// Captures an approved order. If it was already captured (a retry), returns the order as is.
export async function captureOrder(env, id) {
  try {
    return await paypal(env, 'POST', '/v2/checkout/orders/' + encodeURIComponent(id) + '/capture', {});
  } catch (e) {
    if (e.details?.details?.some(d => d.issue === 'ORDER_ALREADY_CAPTURED')) return getOrder(env, id);
    throw e;
  }
}
