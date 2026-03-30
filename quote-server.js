// WhisperRoom Quote Builder
// Node.js server with HubSpot, TaxJar, and ABF integration

const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const url     = require('url');
const crypto  = require('crypto');

// ── Quote History via HubSpot Notes ──────────────────────────────
// Stored as notes on deals - persistent, visible in HubSpot, never wiped

async function saveQuoteNote(dealId, quoteData) {
  const noteBody = 'QUOTE_SNAPSHOT::' + JSON.stringify({
    ...quoteData,
    id: crypto.randomBytes(8).toString('hex'),
    savedAt: new Date().toISOString()
  });

  // Create note
  const note = await httpsRequest({
    hostname: 'api.hubapi.com',
    path: '/crm/v3/objects/notes',
    method: 'POST',
    headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
  }, {
    properties: {
      hs_note_body: noteBody,
      hs_timestamp: new Date().toISOString(),
    }
  });

  if (note.body && note.body.id) {
    // Associate note with deal
    await httpsRequest({
      hostname: 'api.hubapi.com',
      path: `/crm/v3/objects/notes/${note.body.id}/associations/deals/${dealId}/note_to_deal`,
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
    });
  }
  return note.body;
}

async function fetchQuoteHistory() {
  // Search for notes that are quote snapshots
  const res = await httpsRequest({
    hostname: 'api.hubapi.com',
    path: '/crm/v3/objects/notes/search',
    method: 'POST',
    headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
  }, {
    filterGroups: [{
      filters: [{
        propertyName: 'hs_note_body',
        operator: 'CONTAINS_TOKEN',
        value: 'QUOTE_SNAPSHOT::'
      }]
    }],
    properties: ['hs_note_body', 'hs_timestamp'],
    sorts: [{ propertyName: 'hs_timestamp', direction: 'DESCENDING' }],
    limit: 200
  });

  if (!res.body || !res.body.results) return [];

  return res.body.results.map(note => {
    try {
      const body = note.properties.hs_note_body || '';
      const jsonStr = body.replace('QUOTE_SNAPSHOT::', '');
      return JSON.parse(jsonStr);
    } catch(e) { return null; }
  }).filter(Boolean);
}

const PORT         = process.env.PORT || 3457;
const PASSWORD     = process.env.WR_PASSWORD || 'whisperroom';
const HS_TOKEN     = process.env.HS_TOKEN || 'pat-na1-46b267e5-120c-42fa-95a6-14eb28460a85';
const TAXJAR_KEY   = process.env.TAXJAR_KEY || 'a432e28eece47221d3176cfc1a7d2dae';
const ABF_ID       = 'Q8MZK7K1';
const ABF_ACCT     = '189059-248A';
const SHIP_CITY    = 'Morristown';
const SHIP_STATE   = 'TN';
const SHIP_ZIP     = '37813';
const NMFC_ITEM    = '027880';
const NMFC_SUB     = '02';
const FREIGHT_CLASS = '100';

const sessions = new Set();

// ── Nexus states (freight taxability per state) ───────────────────
const NEXUS_STATES = {
  CA: { taxFreight: true  },
  CO: { taxFreight: true  },
  FL: { taxFreight: false },
  GA: { taxFreight: false },
  IL: { taxFreight: true  },
  MA: { taxFreight: false },
  NC: { taxFreight: true  },
  OH: { taxFreight: true  },
  PA: { taxFreight: true  },
  TN: { taxFreight: true  },
  TX: { taxFreight: true  },
  VA: { taxFreight: false },
  WI: { taxFreight: true  },
  WA: { taxFreight: true  },
};

// ── HTTPS helper ──────────────────────────────────────────────────
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function httpsGet(urlStr) {
  return new Promise((resolve, reject) => {
    https.get(urlStr, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

// ── HubSpot API ───────────────────────────────────────────────────
async function hsSearchProducts(query, limit = 100, offset = 0) {
  const body = {
    limit,
    after: offset,
    properties: ['name', 'price', 'hs_sku', 'description'],
    sorts: [{ propertyName: 'name', direction: 'ASCENDING' }]
  };
  if (query && query.trim()) body.query = query.trim();
  const res = await httpsRequest({
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
  const body = {
    query: query.trim(),
    limit: 10,
    properties: ['dealname', 'dealstage', 'amount', 'hubspot_owner_id', 'pipeline', 'closedate'],
    sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }]
  };
  const res = await httpsRequest({
    hostname: 'api.hubapi.com',
    path: '/crm/v3/objects/deals/search',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${HS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  }, body);
  return res.body;
}

// Search contacts by name or email
async function hsSearchContacts(query) {
  const body = {
    query: query.trim(),
    limit: 10,
    properties: ['firstname', 'lastname', 'email', 'phone', 'company', 'address', 'city', 'state', 'zip'],
    sorts: [{ propertyName: 'lastname', direction: 'ASCENDING' }]
  };
  const res = await httpsRequest({
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

async function hsCreateContact(data) {
  const res = await httpsRequest({
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
    properties: ['firstname', 'lastname', 'email', 'phone'],
    limit: 1
  };
  const res = await httpsRequest({
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
  const res = await httpsRequest({
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
  const res = await httpsRequest({
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
  const res = await httpsRequest({
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
  const res = await httpsRequest({
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

// ── TaxJar API ────────────────────────────────────────────────────
async function calculateTax(toState, toZip, toCity, amount, shipping) {
  const stateUpper = (toState || '').toUpperCase();
  const inNexus = NEXUS_STATES[stateUpper];
  if (!inNexus) return { tax: 0, rate: 0, inNexus: false };

  const taxableShipping = inNexus.taxFreight ? shipping : 0;

  const params = new URLSearchParams({
    from_country: 'US', from_state: 'TN', from_zip: '37813', from_city: 'Knoxville',
    to_country: 'US', to_state: stateUpper, to_zip: toZip, to_city: toCity || '',
    amount: amount.toFixed(2),
    shipping: taxableShipping.toFixed(2)
  });

  const res = await httpsGet(
    `https://api.taxjar.com/v2/taxes?${params.toString()}`
  );

  try {
    const data = JSON.parse(res.body);
    if (data.tax) {
      return {
        tax: data.tax.amount_to_collect || 0,
        rate: data.tax.rate || 0,
        inNexus: true,
        freightTaxed: inNexus.taxFreight
      };
    }
  } catch(e) {}

  // Fallback if TaxJar fails
  return { tax: 0, rate: 0, inNexus: true, error: 'TaxJar API error' };
}

// TaxJar requires Authorization header - let's use proper request
async function calculateTaxProper(toState, toZip, toCity, amount, shipping) {
  const stateUpper = (toState || '').toUpperCase();
  const inNexus = NEXUS_STATES[stateUpper];
  if (!inNexus) return { tax: 0, rate: 0, inNexus: false };

  const taxableShipping = inNexus.taxFreight ? shipping : 0;
  const body = {
    from_country: 'US', from_state: 'TN', from_zip: '37813', from_city: 'Knoxville',
    to_country: 'US', to_state: stateUpper, to_zip: toZip, to_city: toCity || '',
    amount: parseFloat(amount.toFixed(2)),
    shipping: parseFloat(taxableShipping.toFixed(2))
  };

  const res = await httpsRequest({
    hostname: 'api.taxjar.com',
    path: '/v2/taxes',
    method: 'POST',
    headers: {
      'Authorization': `Token token="${TAXJAR_KEY}"`,
      'Content-Type': 'application/json'
    }
  }, body);

  if (res.body && res.body.tax) {
    return {
      tax: res.body.tax.amount_to_collect || 0,
      rate: res.body.tax.rate || 0,
      inNexus: true,
      freightTaxed: inNexus.taxFreight,
      stateRate: res.body.tax.breakdown && res.body.tax.breakdown.state_tax_rate || 0
    };
  }
  // Log the error for debugging
  console.error('TaxJar error response:', JSON.stringify(res.body));
  return { tax: 0, rate: 0, inNexus: true, error: typeof res.body === 'object' ? (res.body.error || res.body.detail || JSON.stringify(res.body)) : String(res.body) };
}

// ── ABF Freight ───────────────────────────────────────────────────
function buildAbfUrl(pallets, totalWeight, consCity, consState, consZip, isCanadian, accessories) {
  const today = new Date();
  const parts = [
    'DL=2', `ID=${ABF_ID}`, `ShipAcct=${ABF_ACCT}`,
    'ShipPay=Y', 'Acc=ARR=Y'
  ];
  if (accessories.residential)   parts.push('Acc_RDEL=Y');
  if (accessories.liftgate)      parts.push('Acc_LGATE=Y');
  if (accessories.limitedaccess) parts.push('Acc_LAPU=Y');
  if (accessories.loadingdock)   parts.push('Acc_DOCK=Y');

  parts.push(
    `ShipCity=${encodeURIComponent(SHIP_CITY)}`, `ShipState=${SHIP_STATE}`,
    `ShipZip=${SHIP_ZIP}`, 'ShipCountry=US',
    `ConsCity=${encodeURIComponent(consCity)}`, `ConsState=${consState}`,
    `ConsZip=${consZip}`, `ConsCountry=${isCanadian ? 'CA' : 'US'}`,
    'FrtLWHType=IN'
  );

  pallets.forEach((pl, i) => {
    const n = i + 1;
    parts.push(
      `FrtLng${n}=${pl.l}`, `FrtWdth${n}=${pl.w}`, `FrtHght${n}=${pl.h}`,
      `UnitType${n}=PLT`, `Wgt${n}=${pl.weight}`, `UnitNo${n}=1`,
      `Class${n}=${FREIGHT_CLASS}`, `NMFCItem${n}=${NMFC_ITEM}`, `NMFCSub${n}=${NMFC_SUB}`
    );
  });

  parts.push('ShipAff=Y', `ShipMonth=${today.getMonth()+1}`,
    `ShipDay=${today.getDate()}`, `ShipYear=${today.getFullYear()}`);

  return 'https://www.abfs.com/xml/aquotexml.asp?' + parts.join('&');
}

function parseAbfXml(xmlText) {
  let cost = 0, dynDisc = 0, transit = '—';
  const itemRe = /<ITEM[^>]+FOR="([^"]*)"[^>]+AMOUNT="([^"]*)"[^>]*/gi;
  let m;
  while ((m = itemRe.exec(xmlText)) !== null) {
    const forAttr = m[1].toUpperCase();
    const amount = parseFloat(m[2]);
    if (forAttr === 'DYNDISC') dynDisc = Math.abs(amount);
    else cost += amount;
  }
  const tMatch = xmlText.match(/<ADVERTISEDTRANSIT>([^<]*)<\/ADVERTISEDTRANSIT>/i);
  if (tMatch) transit = tMatch[1].trim();
  if (cost === 0) throw new Error('Could not extract freight rate from ABF response');
  return { cost: Math.round(cost * 100) / 100, dynDisc, transit };
}

// ── Auth ──────────────────────────────────────────────────────────
function generateToken() { return crypto.randomBytes(32).toString('hex'); }
function parseCookies(req) {
  const list = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const parts = p.split('=');
    if (parts[0]) list[parts[0].trim()] = (parts[1] || '').trim();
  });
  return list;
}
function isAuth(req) {
  const c = parseCookies(req);
  return c.wr_qt_session && sessions.has(c.wr_qt_session);
}

// ── Request body parser ───────────────────────────────────────────
function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
  });
}

// ── Login page HTML ───────────────────────────────────────────────
const LOGIN_HTML = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhisperRoom Quote Builder</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Mono:wght@400;500&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0a0a;color:#f0ede8;font-family:'DM Mono',monospace;min-height:100vh;display:flex;align-items:center;justify-content:center}
.box{width:360px;padding:40px}
.logo{font-family:'Syne',sans-serif;font-size:30px;font-weight:800;margin-bottom:4px}
.logo span{color:#e8531a}
.sub{font-size:11px;color:#7a7672;text-transform:uppercase;letter-spacing:.1em;margin-bottom:40px}
label{font-size:11px;color:#7a7672;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:6px}
input{width:100%;background:#181818;border:1px solid #2e2e2e;border-radius:4px;color:#f0ede8;font-family:'DM Mono',monospace;font-size:14px;padding:12px;outline:none}
input:focus{border-color:#e8531a}
button{margin-top:16px;width:100%;padding:14px;background:#e8531a;border:none;border-radius:4px;color:white;font-family:'Syne',sans-serif;font-size:14px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;cursor:pointer}
button:hover{background:#d4450e}
.err{margin-top:12px;color:#e74c3c;font-size:12px;text-align:center}
</style></head><body>
<div class="box">
  <div class="logo">Whisper<span>Room</span></div>
  <div class="sub">Quote Builder — Internal</div>
  <label>Password</label>
  <form method="POST" action="/login">
    <input type="password" name="password" placeholder="Enter password" autofocus>
    <button type="submit">Access Tool</button>
    {{ERROR}}
  </form>
</div></body></html>`;

// ── Main HTML (served from file) ──────────────────────────────────
const MAIN_HTML_PATH = path.join(__dirname, 'quote-builder.html');

// ── Server ────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const json = (data, status=200) => {
    res.writeHead(status, {'Content-Type':'application/json'});
    res.end(JSON.stringify(data));
  };

  // ── Login ──
  if (pathname === '/login' && req.method === 'POST') {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    if (params.get('password') === PASSWORD) {
      const token = generateToken();
      sessions.add(token);
      res.writeHead(302, {
        'Set-Cookie': `wr_qt_session=${token}; HttpOnly; Path=/; Max-Age=86400`,
        'Location': '/'
      });
      res.end();
    } else {
      res.writeHead(200, {'Content-Type':'text/html'});
      res.end(LOGIN_HTML.replace('{{ERROR}}', '<div class="err">Incorrect password.</div>'));
    }
    return;
  }

  // ── Auth gate ──
  if (!isAuth(req) && pathname !== '/login') {
    if (pathname.startsWith('/api/')) {
      json({ error: 'Unauthorized' }, 401); return;
    }
    res.writeHead(200, {'Content-Type':'text/html'});
    res.end(LOGIN_HTML.replace('{{ERROR}}',''));
    return;
  }

  // ── Main app ──
  if (pathname === '/' || pathname === '/index.html') {
    try {
      const html = fs.readFileSync(MAIN_HTML_PATH, 'utf8');
      res.writeHead(200, {'Content-Type':'text/html'});
      res.end(html);
    } catch(e) {
      res.writeHead(500); res.end('quote-builder.html not found');
    }
    return;
  }

  // ── API: Search products ──
  if (pathname === '/api/products' && req.method === 'GET') {
    try {
      const q = parsed.query.q || '';
      const offset = parseInt(parsed.query.after || '0');
      const data = await hsSearchProducts(q, 100, offset);
      json(data);
    } catch(e) { json({error: e.message}, 500); }
    return;
  }

  // ── API: Search contacts ──
  if (pathname === '/api/contacts' && req.method === 'GET') {
    try {
      const q = parsed.query.q || '';
      if (q.length < 2) { json({ results: [] }); return; }
      const data = await hsSearchContacts(q);
      json(data);
    } catch(e) { json({error: e.message}, 500); }
    return;
  }

  // ── API: Get quote history ──
  if (pathname === '/api/history' && req.method === 'GET') {
    try {
      const history = await fetchQuoteHistory();
      json({ results: history });
    } catch(e) { json({error: e.message}, 500); }
    return;
  }

  // ── API: Save quote to history (called after deal creation) ──
  if (pathname === '/api/history' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      // Save as note on the deal if dealId provided
      if (body.dealId) {
        await saveQuoteNote(body.dealId, body);
      }
      json({ success: true });
    } catch(e) { json({error: e.message}, 500); }
    return;
  }

  // ── API: Search deals ──
  if (pathname === '/api/deals' && req.method === 'GET') {
    try {
      const q = parsed.query.q || '';
      if (q.length < 2) { json({ results: [] }); return; }
      const data = await hsSearchDeals(q);
      json(data);
    } catch(e) { json({error: e.message}, 500); }
    return;
  }

  // ── API: Get freight quote ──
  if (pathname === '/api/freight' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const { pallets, totalWeight, city, state, zip, canadian, accessories } = body;
      const abfUrl = buildAbfUrl(pallets, totalWeight, city, state, zip, canadian, accessories || {});
      const res2 = await httpsGet(abfUrl);
      const result = parseAbfXml(res2.body);
      json({ ...result, markup: Math.round(result.cost * 0.25 * 100) / 100 });
    } catch(e) { json({error: e.message}, 500); }
    return;
  }

  // ── API: Calculate tax ──
  if (pathname === '/api/tax' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const { state, zip, city, subtotal, shipping } = body;
      const result = await calculateTaxProper(state, zip, city, subtotal, shipping);
      json(result);
    } catch(e) { json({error: e.message}, 500); }
    return;
  }

  // ── API: Push to HubSpot ──
  if (pathname === '/api/create-deal' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const { customer, lineItems, freight, tax, discount, total, ownerId, dealName, existingDealId } = body;

      // Find or create contact
      let contactId;
      if (existingContactId) {
        // Rep chose to use an existing contact from the duplicate check
        contactId = String(existingContactId);
      } else {
        const existing = await hsSearchContact(customer.email);
        if (existing.results && existing.results.length > 0) {
          contactId = existing.results[0].id;
        } else {
          const newContact = await hsCreateContact({
            firstname: customer.firstName,
            lastname: customer.lastName,
            email: customer.email,
            phone: customer.phone,
            company: customer.company,
            address: customer.address,
            city: customer.city,
            state: customer.state,
            zip: customer.zip,
          });
          contactId = newContact.id;
          if (!contactId) throw new Error('Failed to create contact: ' + JSON.stringify(newContact));
        }
      }

      // Use existing deal or create new one
      let dealId;
      if (existingDealId) {
        dealId = existingDealId;
        // Update amount on existing deal
        await httpsRequest({
          hostname: 'api.hubapi.com',
          path: `/crm/v3/objects/deals/${dealId}`,
          method: 'PATCH',
          headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
        }, { properties: { amount: total.toFixed(2) } });
      } else {
        const deal = await hsCreateDeal({
          dealname: dealName || `${customer.company || customer.lastName} - ${quoteNumber || 'Quote'}`,
          pipeline: 'default',
          dealstage: 'appointmentscheduled',
          amount: total.toFixed(2),
          hubspot_owner_id: String(ownerId),
          closedate: new Date(Date.now() + 30*24*60*60*1000).toISOString().split('T')[0],
          description: `Ship to: ${customer.address}, ${customer.city}, ${customer.state} ${customer.zip}`
        });
        dealId = deal.id;
        if (!dealId) throw new Error('Failed to create deal: ' + JSON.stringify(deal));
      }

      // Associate contact with deal
      await hsAssociate('deals', dealId, 'contacts', contactId, 'deal_to_contact');

      // Create line items
      const lineItemIds = [];
      for (const item of lineItems) {
        const li = await hsCreateLineItem({
          name: item.name,
          quantity: String(item.qty),
          price: String(item.price),
          hs_product_id: item.productId ? String(item.productId) : undefined,
          description: item.description || '',
          discount: item.lineDiscount ? String(item.lineDiscount) : '0',
        });
        if (li.id) lineItemIds.push(li.id);
      }

      // Add freight line item
      if (freight && freight.total > 0) {
        const fli = await hsCreateLineItem({
          name: 'Freight',
          quantity: '1',
          price: String(freight.total.toFixed(2)),
          description: `LTL freight estimate. Transit: ${freight.transit || '—'}. ${freight.dynDisc > 0 ? `Dynamic discount of $${freight.dynDisc} excluded.` : ''}`,
        });
        if (fli.id) lineItemIds.push(fli.id);
      }

      // Add tax line item if applicable
      if (tax && tax.tax > 0) {
        const tli = await hsCreateLineItem({
          name: `Sales Tax (${(tax.rate * 100).toFixed(3)}%)`,
          quantity: '1',
          price: String(tax.tax.toFixed(2)),
          description: `State: ${customer.state}. ${tax.freightTaxed ? 'Includes freight.' : 'Product only.'}`,
        });
        if (tli.id) lineItemIds.push(tli.id);
      }

      // Associate all line items with deal
      if (lineItemIds.length > 0) {
        await hsBatchAssociateLineItems(dealId, lineItemIds);
      }

      // Save quote snapshot as note on the deal
      try {
        await saveQuoteNote(dealId, {
          dealName, quoteNumber,
          ownerId, total,
          date: new Date().toLocaleDateString('en-US', {month:'short',day:'numeric',year:'numeric'}),
          customer, lineItems, discount, freight, tax,
        });
      } catch(e) { console.error('Note save error:', e.message); }

      json({
        success: true,
        dealId,
        contactId,
        dealUrl: `https://app.hubspot.com/contacts/5764220/record/0-3/${dealId}`
      });

    } catch(e) {
      json({error: e.message}, 500);
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`WhisperRoom Quote Builder running on port ${PORT}`);
  console.log(`HubSpot token: ${HS_TOKEN ? HS_TOKEN.substring(0,12) + '...' : 'NOT SET'}`);
  console.log(`TaxJar key: ${TAXJAR_KEY ? TAXJAR_KEY.substring(0,8) + '...' : 'NOT SET'}`);
});
