// HubSpot CRM integration
// Extracted from quote-server.js — named exports, no behavior changes.
// Host must call `init({ httpsRequest })` once before any HubSpot function is invoked.

let _httpsRequest;

function init(deps) {
  _httpsRequest = deps.httpsRequest;
}

const HS_TOKEN = process.env.HS_TOKEN || '';

// Map full carrier names to HubSpot freight_carrier enum values
function hsCarrierEnum(carrier) {
  if (!carrier) return '';
  const c = carrier.toLowerCase();
  if (c.includes('abf'))          return 'ABF';
  if (c.includes('old dominion') || c === 'od') return 'OD';
  if (c.includes('fedex'))        return 'FedEx';
  if (c.includes('ups'))          return 'UPS';
  if (c.includes('usps'))         return 'USPS';
  if (c.includes('saia'))         return 'SAIA';
  if (c.includes('yrc'))          return 'YRC';
  return 'Other';
}

// ── Fix 4: Detect HubSpot 401 and force re-auth ──────────────────────
// Wrap httpsRequest responses — if HubSpot returns 401, invalidate session
async function hsRequest(options, body, rawBody) {
  const res = await _httpsRequest(options, body, rawBody);
  if (res.status === 401 && options.hostname === 'api.hubapi.com') {
    console.warn('[HubSpot] 401 received — private app token may be expired');
    // Don't throw — let callers handle gracefully
  }
  return res;
}

// ── Products cache (avoids hammering HubSpot on every price book open) ──
let _productsCache     = null;
let _productsCacheTime = 0;
const PRODUCTS_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

async function fetchAllProducts() {
  let all = [], after = null, page = 0;
  do {
    let path = '/crm/v3/objects/products?limit=100&properties=name,price,description,weight,hs_sku,category';
    if (after) path += `&after=${encodeURIComponent(after)}`;
    const r = await _httpsRequest({
      hostname: 'api.hubapi.com', path, method: 'GET',
      headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
    });
    const results = r.body?.results || [];
    all.push(...results);
    after = r.body?.paging?.next?.after || null;
    page++;
    if (!after || results.length === 0) break;
  } while (page < 20);
  all.sort((a,b) => (a.properties?.name||'').localeCompare(b.properties?.name||''));
  console.log(`[products cache] loaded ${all.length} products`);
  return all;
}

async function getProductsCached() {
  const now = Date.now();
  if (_productsCache && (now - _productsCacheTime) < PRODUCTS_CACHE_TTL) {
    return _productsCache;
  }
  _productsCache = await fetchAllProducts();
  _productsCacheTime = Date.now();
  return _productsCache;
}

// Warm cache on startup (after a short delay to let DB connect first)
setTimeout(async () => {
  if (!HS_TOKEN) return;
  try { await getProductsCached(); }
  catch(e) { console.warn('[products cache] warm failed:', e.message); }
}, 8000);

// Auto-refresh every 15 minutes
setInterval(async () => {
  if (!HS_TOKEN) return;
  try {
    _productsCache = await fetchAllProducts();
    _productsCacheTime = Date.now();
  } catch(e) { console.warn('[products cache] refresh failed:', e.message); }
}, PRODUCTS_CACHE_TTL);


// ── HubSpot API ───────────────────────────────────────────────────
async function hsSearchProducts(query, limit = 100, offset = 0) {
  const body = {
    limit,
    after: offset,
    properties: ['name', 'price', 'hs_sku', 'description', 'weight', 'category'],
    sorts: [{ propertyName: 'name', direction: 'ASCENDING' }]
  };
  if (query && query.trim()) body.query = query.trim();
  const res = await _httpsRequest({
    hostname: 'api.hubapi.com',
    path: '/crm/v3/objects/products/search',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${HS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  }, body);
  return res.body;
}

// Search deals by name
async function hsSearchDeals(query) {
  const DEAL_PROPS = ['dealname', 'dealstage', 'amount', 'hubspot_owner_id', 'pipeline', 'closedate'];

  // 1. Direct deal name search
  const dealRes = await _httpsRequest({
    hostname: 'api.hubapi.com',
    path: '/crm/v3/objects/deals/search',
    method: 'POST',
    headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
  }, {
    query: query.trim(),
    limit: 20,
    properties: DEAL_PROPS,
    sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }]
  });
  const dealResults = dealRes.body?.results || [];
  const seen = new Set(dealResults.map(d => d.id));

  // 2. Also search contacts by name → associated deals
  // This catches old deals where the deal name doesn't match but the contact name does
  try {
    const contactRes = await _httpsRequest({
      hostname: 'api.hubapi.com',
      path: '/crm/v3/objects/contacts/search',
      method: 'POST',
      headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
    }, {
      query: query.trim(),
      limit: 10,
      properties: ['firstname', 'lastname', 'email', 'company'],
    });
    const contacts = contactRes.body?.results || [];
    if (contacts.length) {
      const contactIds = contacts.map(c => c.id);
      // Fetch deals associated with those contacts
      const assocRes = await _httpsRequest({
        hostname: 'api.hubapi.com',
        path: '/crm/v4/associations/contacts/deals/batch/read',
        method: 'POST',
        headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
      }, { inputs: contactIds.map(id => ({ id: String(id) })) });
      const assocDealIds = [];
      (assocRes.body?.results || []).forEach(r => {
        (r.to || []).forEach(t => {
          if (!seen.has(String(t.toObjectId))) assocDealIds.push(String(t.toObjectId));
        });
      });
      if (assocDealIds.length) {
        const dealsById = await _httpsRequest({
          hostname: 'api.hubapi.com',
          path: '/crm/v3/objects/deals/batch/read',
          method: 'POST',
          headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
        }, {
          inputs: assocDealIds.slice(0, 20).map(id => ({ id })),
          properties: DEAL_PROPS,
        });
        (dealsById.body?.results || []).forEach(d => {
          if (!seen.has(d.id)) { seen.add(d.id); dealResults.push(d); }
        });
      }
    }
  } catch(e) { /* contact lookup failure is non-fatal */ }

  return { results: dealResults, total: dealResults.length };
}

async function hsSearchContacts(query) {
  const body = {
    query: query.trim(),
    limit: 10,
    properties: ['firstname', 'lastname', 'email', 'phone', 'company', 'address', 'city', 'state', 'zip'],
    sorts: [{ propertyName: 'lastname', direction: 'ASCENDING' }]
  };
  const res = await _httpsRequest({
    hostname: 'api.hubapi.com',
    path: '/crm/v3/objects/contacts/search',
    method: 'POST',
    headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
  }, body);

  if (!res.body || !res.body.results) return res.body;

  // For contacts missing company name, fetch associated company
  const enriched = await Promise.all(res.body.results.map(async contact => {
    if (contact.properties.company) return contact;
    try {
      const assoc = await _httpsRequest({
        hostname: 'api.hubapi.com',
        path: `/crm/v3/objects/contacts/${contact.id}/associations/companies`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
      });
      if (assoc.body && assoc.body.results && assoc.body.results.length > 0) {
        const companyId = assoc.body.results[0].id;
        const company = await _httpsRequest({
          hostname: 'api.hubapi.com',
          path: `/crm/v3/objects/companies/${companyId}?properties=name`,
          method: 'GET',
          headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
        });
        if (company.body && company.body.properties && company.body.properties.name) {
          contact.properties.company = company.body.properties.name;
        }
      }
    } catch(e) {}
    return contact;
  }));

  return { ...res.body, results: enriched };
}

// Get deal with associated contact and owner
async function hsGetDealWithDetails(dealId) {
  const deal = await _httpsRequest({
    hostname: 'api.hubapi.com',
    path: `/crm/v3/objects/deals/${dealId}?properties=dealname,hubspot_owner_id,dealstage,amount`,
    method: 'GET',
    headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
  });

  if (!deal.body || !deal.body.id) return null;

  // Get associated contacts
  let contact = null;
  try {
    const assoc = await _httpsRequest({
      hostname: 'api.hubapi.com',
      path: `/crm/v3/objects/deals/${dealId}/associations/contacts`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
    });
    if (assoc.body && assoc.body.results && assoc.body.results.length > 0) {
      const contactId = assoc.body.results[0].id;
      const contactRes = await _httpsRequest({
        hostname: 'api.hubapi.com',
        path: `/crm/v3/objects/contacts/${contactId}?properties=firstname,lastname,email,phone,company,address,city,state,zip`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
      });
      if (contactRes.body && contactRes.body.properties) {
        contact = contactRes.body;
        // Fetch company if missing
        if (!contact.properties.company) {
          const compAssoc = await _httpsRequest({
            hostname: 'api.hubapi.com',
            path: `/crm/v3/objects/contacts/${contactId}/associations/companies`,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
          });
          if (compAssoc.body && compAssoc.body.results && compAssoc.body.results.length > 0) {
            const compRes = await _httpsRequest({
              hostname: 'api.hubapi.com',
              path: `/crm/v3/objects/companies/${compAssoc.body.results[0].id}?properties=name`,
              method: 'GET',
              headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
            });
            if (compRes.body && compRes.body.properties && compRes.body.properties.name) {
              contact.properties.company = compRes.body.properties.name;
            }
          }
        }
      }
    }
  } catch(e) {}

  return { deal: deal.body, contact };
}

async function hsCreateContact(data) {
  const res = await _httpsRequest({
    hostname: 'api.hubapi.com',
    path: '/crm/v3/objects/contacts',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${HS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  }, { properties: data });
  return res.body;
}

async function hsSearchContact(email) {
  const body = {
    filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
    properties: ['firstname', 'lastname', 'email', 'phone', 'company', 'address', 'city', 'state', 'zip', 'hubspot_owner_id'],
    limit: 1
  };
  const res = await _httpsRequest({
    hostname: 'api.hubapi.com',
    path: '/crm/v3/objects/contacts/search',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${HS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  }, body);
  return res.body;
}

async function hsCreateDeal(data) {
  const res = await _httpsRequest({
    hostname: 'api.hubapi.com',
    path: '/crm/v3/objects/deals',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${HS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  }, { properties: data });
  return res.body;
}

async function hsCreateLineItem(data) {
  const res = await _httpsRequest({
    hostname: 'api.hubapi.com',
    path: '/crm/v3/objects/line_items',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${HS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  }, { properties: data });
  return res.body;
}

async function hsAssociate(fromType, fromId, toType, toId, assocType) {
  const res = await _httpsRequest({
    hostname: 'api.hubapi.com',
    path: `/crm/v3/objects/${fromType}/${fromId}/associations/${toType}/${toId}/${assocType}`,
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${HS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
  return res;
}

async function hsBatchAssociateLineItems(dealId, lineItemIds) {
  const inputs = lineItemIds.map(id => ({
    from: { id: String(id) },
    to: { id: String(dealId) },
    type: 'line_item_to_deal'
  }));
  const res = await _httpsRequest({
    hostname: 'api.hubapi.com',
    path: '/crm/v3/associations/line_items/deals/batch/create',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${HS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  }, { inputs });
  return res.body;
}

// Fetch and delete all existing line items on a deal — call before creating new ones
async function hsClearDealLineItems(dealId) {
  try {
    // Fetch associated line item IDs
    const assocRes = await _httpsRequest({
      hostname: 'api.hubapi.com',
      path: `/crm/v3/objects/deals/${dealId}/associations/line_items`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
    });
    const ids = (assocRes.body?.results || []).map(r => r.id).filter(Boolean);
    if (!ids.length) return;
    // Batch delete all line items
    await _httpsRequest({
      hostname: 'api.hubapi.com',
      path: '/crm/v3/objects/line_items/batch/archive',
      method: 'POST',
      headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
    }, { inputs: ids.map(id => ({ id: String(id) })) });
    console.log(`[line items] cleared ${ids.length} from deal ${dealId}`);
  } catch(e) {
    console.warn(`[line items] clear failed for deal ${dealId}: ${e.message}`);
  }
}

module.exports = {
  init,
  HS_TOKEN,
  hsCarrierEnum,
  hsRequest,
  fetchAllProducts,
  getProductsCached,
  hsSearchProducts,
  hsSearchDeals,
  hsSearchContacts,
  hsGetDealWithDetails,
  hsCreateContact,
  hsSearchContact,
  hsCreateDeal,
  hsCreateLineItem,
  hsAssociate,
  hsBatchAssociateLineItems,
  hsClearDealLineItems,
};
