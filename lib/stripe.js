// Stripe wrapper — Customer + Invoice creation, webhook signature verification.
// Follows the lib/* init({ deps }) pattern. Hard-locked to sk_test_ keys for now;
// drop that guard once we've run staging in parallel for a few weeks.

const crypto = require('crypto');

let _httpsRequest, _writelog, _getDb;

function init(deps) {
  _httpsRequest = deps.httpsRequest;
  _writelog     = deps.writelog || (() => {});
  _getDb        = deps.getDb    || (() => null);
}

// ── On/Off toggle (kv_store backed, 10s memory cache) ─────────────
// Default ON. When false:
//   - /api/create-invoice skips Stripe creation entirely
//   - /i/:quoteNumber falls back to HubSpot payment_link even if a
//     prior Stripe hostedUrl is on the snapshot
//   - Webhook handler stays active (in-flight Stripe invoices still
//     get their paid events processed)
const TOGGLE_KEY = 'stripe_enabled';
const TOGGLE_CACHE_MS = 10000;
let _toggleValue = null;
let _toggleUntil = 0;

async function isEnabled() {
  const now = Date.now();
  if (_toggleValue !== null && now < _toggleUntil) return _toggleValue;
  const db = _getDb();
  if (!db) { _toggleValue = true; _toggleUntil = now + TOGGLE_CACHE_MS; return true; }
  try {
    const r = await db.query(`SELECT value FROM kv_store WHERE key = $1 LIMIT 1`, [TOGGLE_KEY]);
    _toggleValue = r.rows.length ? r.rows[0].value === 'true' : true; // default ON
  } catch(e) {
    _toggleValue = true; // fail-open
  }
  _toggleUntil = now + TOGGLE_CACHE_MS;
  return _toggleValue;
}

async function setEnabled(enabled) {
  const db = _getDb();
  if (!db) throw new Error('No DB available for stripe toggle');
  const val = enabled ? 'true' : 'false';
  await db.query(
    `INSERT INTO kv_store (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [TOGGLE_KEY, val]
  );
  _toggleValue = !!enabled;
  _toggleUntil = Date.now() + TOGGLE_CACHE_MS;
  return _toggleValue;
}

// ── Stripe API helper ─────────────────────────────────────────────
// Stripe expects application/x-www-form-urlencoded bodies (NOT JSON),
// with nested keys flattened to bracket notation: address[line1]=...

function encodeForm(obj, prefix) {
  const parts = [];
  for (const [key, val] of Object.entries(obj || {})) {
    if (val === undefined || val === null || val === '') continue;
    const k = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(val)) {
      val.forEach((item, idx) => {
        if (item && typeof item === 'object') {
          const enc = encodeForm(item, `${k}[${idx}]`);
          if (enc) parts.push(enc);
        } else if (item !== undefined && item !== null) {
          parts.push(`${k}[${idx}]=${encodeURIComponent(item)}`);
        }
      });
    } else if (typeof val === 'object') {
      const enc = encodeForm(val, k);
      if (enc) parts.push(enc);
    } else {
      parts.push(`${k}=${encodeURIComponent(val)}`);
    }
  }
  return parts.join('&');
}

function getKey() {
  const k = process.env.STRIPE_SECRET_KEY || '';
  if (!k) throw new Error('STRIPE_SECRET_KEY env var not set');
  if (!k.startsWith('sk_test_')) {
    throw new Error('STRIPE_SECRET_KEY must start with sk_test_ — refusing to run against live keys until parallel observation passes');
  }
  return k;
}

async function stripeReq(apiPath, params, method = 'POST') {
  const key = getKey();
  const isWrite = method !== 'GET';
  const body = isWrite && params ? encodeForm(params) : '';
  const headers = { 'Authorization': `Bearer ${key}` };
  if (isWrite) {
    headers['Content-Type']   = 'application/x-www-form-urlencoded';
    headers['Content-Length'] = Buffer.byteLength(body);
  }
  const r = await _httpsRequest({
    hostname: 'api.stripe.com',
    path:     '/v1' + apiPath,
    method,
    headers,
  }, isWrite ? body : null);
  if (r.status >= 400) {
    const msg = r.body?.error?.message || (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)).slice(0, 300);
    throw new Error(`Stripe ${method} ${apiPath} → ${r.status}: ${msg}`);
  }
  return r.body;
}

// ── Address helpers ───────────────────────────────────────────────
// Stripe wants ISO country codes (US, CA) — our quote snapshots store
// the display name. Map the common cases; default US.
const COUNTRY_ISO = {
  'united states': 'US', 'usa': 'US', 'us': 'US',
  'canada': 'CA', 'ca': 'CA',
};
function toIso(country) {
  if (!country) return 'US';
  const k = String(country).trim().toLowerCase();
  if (COUNTRY_ISO[k]) return COUNTRY_ISO[k];
  return k.length === 2 ? k.toUpperCase() : 'US';
}

// ── Customer (find-or-create by email) ────────────────────────────
// Stripe doesn't dedup customers natively. We list by email first to
// avoid piling up duplicates during repeated rep testing. The free-text
// `?email=` filter on /v1/customers still works on existing accounts;
// if Stripe ever sunsets it we'll fall back to always-create.
async function findOrCreateCustomer({ email, name, phone, address }) {
  if (!email) throw new Error('Customer email required for Stripe invoice');
  const list = await stripeReq(`/customers?email=${encodeURIComponent(email)}&limit=1`, null, 'GET');
  if (list?.data?.length) return list.data[0];
  const params = { email };
  if (name)  params.name  = name;
  if (phone) params.phone = phone;
  params.description = 'WhisperRoom sales customer';
  if (address && address.line1) {
    params.address = {
      line1:       address.line1,
      city:        address.city,
      state:       address.state,
      postal_code: address.postal_code,
      country:     toIso(address.country),
    };
  }
  return await stripeReq('/customers', params);
}

// ── Invoice creation ──────────────────────────────────────────────
// Takes the same flat invoiceLineItems array the create-invoice route
// already builds for HubSpot (after install/freight/tax/credits are
// resolved). Each entry: { name, qty, price, description, isCredit? }.
// Zero-price descriptor lines are dropped — Stripe rejects $0 items.
//
// collection_method=send_invoice + auto_advance=false means:
//   - Customer must pay via the hosted page (not auto-charged)
//   - Stripe doesn't send its own reminder emails; OUR email/PDF is
//     the customer's only path to the link.
async function createInvoiceForQuote({ quoteNumber, dealId, customer, lineItems, daysUntilDue = 7, expectedTotalCents }) {
  const stripeCustomer = await findOrCreateCustomer({
    email: customer.email,
    name:  [customer.firstName, customer.lastName].filter(Boolean).join(' ').trim() || customer.company || customer.email,
    phone: customer.phone,
    address: {
      line1:       customer.address,
      city:        customer.city,
      state:       customer.state,
      postal_code: customer.zip,
      country:     customer.country,
    },
  });

  // Stripe's /v1/invoiceitems endpoint does NOT accept price_data.product_data
  // (that's a Checkout Sessions field). For inline pricing here, you'd need an
  // existing Stripe Product ID via price_data.product — but we don't want to
  // create/cache Products yet. So we use the simpler `amount` form (qty pre-
  // multiplied into the cents amount). Trade-off: invoice shows "$7,000.00"
  // rather than "2 × $3,500". Acceptable for v1; revisit if reps need the
  // explicit qty display.
  const TO_CENTS = n => Math.round(parseFloat(n) * 100);
  const itemsToCharge = (lineItems || []).filter(i => parseFloat(i.price || 0) > 0 && !i.isCredit);
  for (const item of itemsToCharge) {
    const qty = parseInt(item.qty || 1, 10) || 1;
    const totalCents = TO_CENTS(item.price) * qty;
    if (totalCents <= 0) continue;
    const itemName = (item.name || 'Item').slice(0, 250);
    const qtyPrefix = qty > 1 ? `${qty} × ` : '';
    // Stripe shows `description` as the line title on the hosted invoice.
    // Bake qty into the description so the customer still sees "2 × Foo".
    const lineText = item.description
      ? `${qtyPrefix}${itemName} — ${String(item.description).slice(0, 400)}`
      : `${qtyPrefix}${itemName}`;
    await stripeReq('/invoiceitems', {
      customer:    stripeCustomer.id,
      currency:    'usd',
      amount:      String(totalCents),
      description: lineText.slice(0, 500),
    });
  }

  // pending_invoice_items_behavior defaults to 'exclude' in Stripe API
  // versions ≥ 2022-11-15. Without 'include' the pending invoiceitems we
  // just created don't attach to this draft and the invoice finalizes at $0.
  const draft = await stripeReq('/invoices', {
    customer:                       stripeCustomer.id,
    collection_method:              'send_invoice',
    days_until_due:                 String(daysUntilDue),
    auto_advance:                   'false',
    pending_invoice_items_behavior: 'include',
    description:                    `WhisperRoom Order — Quote ${quoteNumber || ''}`.trim(),
    metadata: {
      wr_quote_number: quoteNumber || '',
      wr_deal_id:      dealId || '',
    },
  });

  const finalized = await stripeReq(`/invoices/${draft.id}/finalize`, { auto_advance: 'false' });

  // Fail loud if Stripe finalizes at $0 when the caller expected a positive total —
  // means invoiceitems didn't attach to the draft (the bug v1.20.3 fixed). Without
  // this assertion the customer sees an "already paid" hosted page on a $0 invoice.
  if (typeof expectedTotalCents === 'number' && expectedTotalCents > 0 && !finalized.amount_due) {
    throw new Error(`Stripe invoice ${finalized.id} finalized at $0 but expected ${expectedTotalCents} cents — invoiceitems likely did not attach`);
  }

  return {
    customerId:   stripeCustomer.id,
    invoiceId:    finalized.id,
    hostedUrl:    finalized.hosted_invoice_url,
    invoicePdf:   finalized.invoice_pdf,
    amountDue:    finalized.amount_due,
    status:       finalized.status,
    finalizedAt:  new Date().toISOString(),
  };
}

async function voidInvoice(invoiceId) {
  return await stripeReq(`/invoices/${invoiceId}/void`, {});
}

async function getInvoice(invoiceId) {
  return await stripeReq(`/invoices/${invoiceId}`, null, 'GET');
}

// ── Webhook signature verification ────────────────────────────────
// Stripe-Signature header: t=<unix>,v1=<hex>[,v1=<hex>...]
// Signed payload: `${t}.${rawBody}` → HMAC-SHA256 with the endpoint secret.
// Tolerance window prevents replay of captured webhooks.
function verifyWebhookSignature(rawBody, signatureHeader, secret, toleranceSec = 300) {
  if (!signatureHeader || !secret || rawBody == null) return false;
  const fields = {};
  for (const part of String(signatureHeader).split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't') fields.t = v;
    else if (k === 'v1') (fields.v1 = fields.v1 || []).push(v);
  }
  if (!fields.t || !fields.v1 || !fields.v1.length) return false;
  const ts = parseInt(fields.t, 10);
  if (!ts || Math.abs(Math.floor(Date.now() / 1000) - ts) > toleranceSec) return false;
  const signed = `${fields.t}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(signed, 'utf8').digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  return fields.v1.some(sig => {
    let sigBuf;
    try { sigBuf = Buffer.from(sig, 'hex'); } catch { return false; }
    if (sigBuf.length !== expectedBuf.length) return false;
    try { return crypto.timingSafeEqual(sigBuf, expectedBuf); }
    catch { return false; }
  });
}

module.exports = {
  init,
  createInvoiceForQuote,
  voidInvoice,
  getInvoice,
  verifyWebhookSignature,
  isEnabled,
  setEnabled,
  // Exported for the existing /api/debug/stripe-diagnostic route if we
  // want to migrate it to use this helper later.
  _stripeReq: stripeReq,
};
