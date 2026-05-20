// Shopify Admin API client. Read-only — we never write back to Shopify.
//
// Used to pull canonical order data (customer, ship-to, line items, tax,
// shipping) for the Shopify-parts QB auto-invoice flow. HubSpot's Shopify
// integration only mirrors deal name + amount, so without this we couldn't
// build a proper QB invoice for parts orders.
//
// Auth: Custom App access token (shpat_...) from Shopify admin →
// Settings → Apps and sales channels → Develop apps → install. Token
// goes in env var SHOPIFY_ACCESS_TOKEN. Store URL in SHOPIFY_STORE_DOMAIN
// (the canonical xxxxx.myshopify.com URL, not the custom domain).

const https = require('https');

const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || '';
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || '';
const API_VERSION          = process.env.SHOPIFY_API_VERSION || '2024-10';

function isConfigured() {
  return !!(SHOPIFY_ACCESS_TOKEN && SHOPIFY_STORE_DOMAIN);
}

function shopifyRequest(apiPath, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!isConfigured()) return reject(new Error('Shopify not configured (set SHOPIFY_ACCESS_TOKEN + SHOPIFY_STORE_DOMAIN)'));
    const req = https.request({
      hostname: SHOPIFY_STORE_DOMAIN,
      path:     `/admin/api/${API_VERSION}${apiPath}`,
      method:   'GET',
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
        'Accept':       'application/json',
        'Content-Type': 'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`Shopify API timeout: ${apiPath}`)); });
    req.on('error', reject);
    req.end();
  });
}

// Look up an order by its display name (e.g. "#2146"). Shopify's `orders`
// endpoint supports `name` filter — accepts both with and without leading #.
// Returns the first match (display names are unique within a store), or null.
async function findOrderByName(rawName) {
  if (!rawName) return null;
  const clean = String(rawName).trim().replace(/^#/, '');
  if (!clean) return null;
  const r = await shopifyRequest(`/orders.json?name=${encodeURIComponent('#' + clean)}&status=any&limit=1`);
  if (r.status >= 400) {
    const msg = (r.body && r.body.errors) || `Shopify ${r.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return r.body?.orders?.[0] || null;
}

// Extract a Shopify order # from a HubSpot deal name. The Shopify→HubSpot
// integration creates deals with names like:
//   "Shopify #2146 - $349.85"
//   "Shopify #2146"
// Returns "2146" or null if no match.
function parseOrderNumberFromDealName(dealName) {
  if (!dealName) return null;
  const m = String(dealName).match(/#(\d+)/);
  return m ? m[1] : null;
}

module.exports = {
  isConfigured,
  shopifyRequest,
  findOrderByName,
  parseOrderNumberFromDealName,
};
