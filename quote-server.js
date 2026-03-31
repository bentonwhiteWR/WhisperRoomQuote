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
  const snapshotData = {
    ...quoteData,
    dealId: dealId,   // save so history restore can link directly
    id: crypto.randomBytes(8).toString('hex'),
    savedAt: new Date().toISOString()
  };
  // WR_QUOTE_DATA markers allow the /q/:quoteNumber route to find this note
  const noteBody = 'WR_QUOTE_DATA:' + JSON.stringify(snapshotData) + ':END_WR_QUOTE';

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
  // Search for notes in BOTH old (QUOTE_SNAPSHOT::) and new (WR_QUOTE_DATA:) formats
  const res = await httpsRequest({
    hostname: 'api.hubapi.com',
    path: '/crm/v3/objects/notes/search',
    method: 'POST',
    headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
  }, {
    filterGroups: [
      { filters: [{ propertyName: 'hs_note_body', operator: 'CONTAINS_TOKEN', value: 'QUOTE_SNAPSHOT::' }] },
      { filters: [{ propertyName: 'hs_note_body', operator: 'CONTAINS_TOKEN', value: 'WR_QUOTE_DATA:' }] },
    ],
    properties: ['hs_note_body', 'hs_timestamp'],
    sorts: [{ propertyName: 'hs_timestamp', direction: 'DESCENDING' }],
    limit: 200
  });

  if (!res.body || !res.body.results) return [];

  return res.body.results.map(note => {
    try {
      const body = note.properties.hs_note_body || '';
      let parsed = null;
      // New format: WR_QUOTE_DATA:{...}:END_WR_QUOTE
      const newMatch = body.match(/WR_QUOTE_DATA:(.+):END_WR_QUOTE/s);
      if (newMatch) {
        parsed = JSON.parse(newMatch[1]);
      } else if (body.includes('QUOTE_SNAPSHOT::')) {
        // Old format: QUOTE_SNAPSHOT::{...}
        parsed = JSON.parse(body.replace('QUOTE_SNAPSHOT::', ''));
      }
      return parsed;
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

// Bidirectional state lookup
const STATE_ABBR_MAP = {
  'alabama':'AL','alaska':'AK','arizona':'AZ','arkansas':'AR','california':'CA',
  'colorado':'CO','connecticut':'CT','delaware':'DE','florida':'FL','georgia':'GA',
  'hawaii':'HI','idaho':'ID','illinois':'IL','indiana':'IN','iowa':'IA',
  'kansas':'KS','kentucky':'KY','louisiana':'LA','maine':'ME','maryland':'MD',
  'massachusetts':'MA','michigan':'MI','minnesota':'MN','mississippi':'MS',
  'missouri':'MO','montana':'MT','nebraska':'NE','nevada':'NV','new hampshire':'NH',
  'new jersey':'NJ','new mexico':'NM','new york':'NY','north carolina':'NC',
  'north dakota':'ND','ohio':'OH','oklahoma':'OK','oregon':'OR','pennsylvania':'PA',
  'rhode island':'RI','south carolina':'SC','south dakota':'SD','tennessee':'TN',
  'texas':'TX','utah':'UT','vermont':'VT','virginia':'VA','washington':'WA',
  'west virginia':'WV','wisconsin':'WI','wyoming':'WY','washington dc':'DC',
  'alberta':'AB','british columbia':'BC','manitoba':'MB','new brunswick':'NB',
  'newfoundland and labrador':'NL','newfoundland':'NL','nova scotia':'NS',
  'ontario':'ON','prince edward island':'PE','quebec':'QC','saskatchewan':'SK',
};

const STATE_FULL_NAME = {
  'AL':'Alabama','AK':'Alaska','AZ':'Arizona','AR':'Arkansas','CA':'California',
  'CO':'Colorado','CT':'Connecticut','DE':'Delaware','FL':'Florida','GA':'Georgia',
  'HI':'Hawaii','ID':'Idaho','IL':'Illinois','IN':'Indiana','IA':'Iowa',
  'KS':'Kansas','KY':'Kentucky','LA':'Louisiana','ME':'Maine','MD':'Maryland',
  'MA':'Massachusetts','MI':'Michigan','MN':'Minnesota','MS':'Mississippi',
  'MO':'Missouri','MT':'Montana','NE':'Nebraska','NV':'Nevada','NH':'New Hampshire',
  'NJ':'New Jersey','NM':'New Mexico','NY':'New York','NC':'North Carolina',
  'ND':'North Dakota','OH':'Ohio','OK':'Oklahoma','OR':'Oregon','PA':'Pennsylvania',
  'RI':'Rhode Island','SC':'South Carolina','SD':'South Dakota','TN':'Tennessee',
  'TX':'Texas','UT':'Utah','VT':'Vermont','VA':'Virginia','WA':'Washington',
  'WV':'West Virginia','WI':'Wisconsin','WY':'Wyoming','DC':'Washington DC',
  'AB':'Alberta','BC':'British Columbia','MB':'Manitoba','NB':'New Brunswick',
  'NL':'Newfoundland and Labrador','NS':'Nova Scotia','ON':'Ontario',
  'PE':'Prince Edward Island','QC':'Quebec','SK':'Saskatchewan',
};

// Always returns 2-letter abbreviation - used for freight/tax APIs
function toStateAbbr(val) {
  if (!val) return '';
  const trimmed = val.trim();
  if (trimmed.length === 2) return trimmed.toUpperCase();
  return STATE_ABBR_MAP[trimmed.toLowerCase()] || trimmed.toUpperCase();
}

// Always returns full name - used for HubSpot contact creation
function toStateFull(val) {
  if (!val) return '';
  const trimmed = val.trim();
  // Already a full name
  if (trimmed.length > 2) {
    // Capitalize properly and return as-is if not in our map
    const lower = trimmed.toLowerCase();
    const abbr = STATE_ABBR_MAP[lower];
    if (abbr) return STATE_FULL_NAME[abbr] || trimmed;
    return trimmed;
  }
  // It's an abbreviation
  const upper = trimmed.toUpperCase();
  return STATE_FULL_NAME[upper] || trimmed;
}

// Search contacts by name or email, with associated company
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
    headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
  }, body);

  if (!res.body || !res.body.results) return res.body;

  // For contacts missing company name, fetch associated company
  const enriched = await Promise.all(res.body.results.map(async contact => {
    if (contact.properties.company) return contact;
    try {
      const assoc = await httpsRequest({
        hostname: 'api.hubapi.com',
        path: `/crm/v3/objects/contacts/${contact.id}/associations/companies`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
      });
      if (assoc.body && assoc.body.results && assoc.body.results.length > 0) {
        const companyId = assoc.body.results[0].id;
        const company = await httpsRequest({
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
  const deal = await httpsRequest({
    hostname: 'api.hubapi.com',
    path: `/crm/v3/objects/deals/${dealId}?properties=dealname,hubspot_owner_id,dealstage,amount`,
    method: 'GET',
    headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
  });

  if (!deal.body || !deal.body.id) return null;

  // Get associated contacts
  let contact = null;
  try {
    const assoc = await httpsRequest({
      hostname: 'api.hubapi.com',
      path: `/crm/v3/objects/deals/${dealId}/associations/contacts`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
    });
    if (assoc.body && assoc.body.results && assoc.body.results.length > 0) {
      const contactId = assoc.body.results[0].id;
      const contactRes = await httpsRequest({
        hostname: 'api.hubapi.com',
        path: `/crm/v3/objects/contacts/${contactId}?properties=firstname,lastname,email,phone,company,address,city,state,zip`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
      });
      if (contactRes.body && contactRes.body.properties) {
        contact = contactRes.body;
        // Fetch company if missing
        if (!contact.properties.company) {
          const compAssoc = await httpsRequest({
            hostname: 'api.hubapi.com',
            path: `/crm/v3/objects/contacts/${contactId}/associations/companies`,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
          });
          if (compAssoc.body && compAssoc.body.results && compAssoc.body.results.length > 0) {
            const compRes = await httpsRequest({
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
  const stateUpper = toStateAbbr(toState);
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
  const stateUpper = toStateAbbr(toState);
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

  // ── API: Get deals associated with a contact ──────────────────
  if (pathname.startsWith('/api/contact-deals/') && req.method === 'GET') {
    try {
      const contactId = pathname.replace('/api/contact-deals/', '').trim();
      if (!contactId) { json({ deals: [] }); return; }

      // Search for deals associated with this contact
      const res = await httpsRequest({
        hostname: 'api.hubapi.com',
        path: '/crm/v3/objects/deals/search',
        method: 'POST',
        headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
      }, {
        filterGroups: [{
          filters: [{
            propertyName: 'associations.contact',
            operator: 'EQ',
            value: contactId
          }]
        }],
        properties: ['dealname', 'amount', 'dealstage', 'hubspot_owner_id', 'hs_lastmodifieddate', 'closedate'],
        sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
        limit: 10
      });

      const deals = (res.body.results || []).map(d => ({
        id: d.id,
        name: d.properties.dealname || 'Untitled Deal',
        amount: d.properties.amount || null,
        stage: d.properties.dealstage || null,
        ownerId: d.properties.hubspot_owner_id || null,
        modified: d.properties.hs_lastmodifieddate || null,
      }));

      json({ deals });
    } catch(e) { json({ deals: [], error: e.message }); }
    return;
  }

  // ── API: Get deal with contact details ──
  if (pathname.startsWith('/api/deal/') && req.method === 'GET') {
    try {
      const dealId = pathname.split('/api/deal/')[1];
      const data = await hsGetDealWithDetails(dealId);
      json(data || { error: 'Deal not found' });
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
      const { pallets, totalWeight, city, state: rawFreightState, zip, canadian, accessories } = body;
      const state = toStateAbbr(rawFreightState);
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
      const { state: rawState, zip, city, subtotal, shipping } = body;
      const state = toStateAbbr(rawState);
      const result = await calculateTaxProper(state, zip, city, subtotal, shipping);
      json(result);
    } catch(e) { json({error: e.message}, 500); }
    return;
  }

  // ── API: Push to HubSpot ──
  if (pathname === '/api/create-deal' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const { customer, lineItems, freight, tax, discount, total, ownerId, dealName, existingDealId, existingContactId, quoteNumber, billing } = body;

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
            state: toStateFull(customer.state),
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
          tax_rate: tax && tax.rate ? String((tax.rate * 100).toFixed(3)) : '',
          quote_number: quoteNumber || '',
          freight_cost: freight && freight.total ? String(freight.total) : '',
          discount: discount && discount.value ? String(discount.value) : '',
          shipping_address: customer.address || '',
          shipping_city: customer.city || '',
          shipping_state: toStateFull(customer.state) || '',
          billing_address: billing ? billing.address || '' : customer.address || '',
          billing_city: billing ? billing.city || '' : customer.city || '',
          billing_state: billing ? toStateFull(billing.state) || '' : toStateFull(customer.state) || '',
          shipping_zipcode: customer.zip || '',
          billing_zipcode: billing ? billing.zip || '' : customer.zip || '',
          // quote_links set separately below
          pipeline: 'default',
          dealstage: 'appointmentscheduled',
          amount: total.toFixed(2),
          hubspot_owner_id: String(ownerId),
          closedate: new Date(Date.now() + 30*24*60*60*1000).toISOString().split('T')[0],
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
          hs_discount_percentage: item.lineDiscount && item.lineDiscount > 0 ? String(item.lineDiscount) : undefined,
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

      // Append quote link to deal (preserves all previous links)
      if (quoteNumber) {
        try {
          const newLink = `https://whisperroomquote.up.railway.app/q/${quoteNumber}`;
          const datestamp = new Date().toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'});

          // Read existing links
          const existingDeal = await httpsRequest({
            hostname: 'api.hubapi.com',
            path: `/crm/v3/objects/deals/${dealId}?properties=quote_link`,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
          });
          const existingLinks = existingDeal.body?.properties?.quote_link || '';
          const totalFmt = total ? ' — $' + parseFloat(total).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '';
          const newEntry = `${datestamp}${totalFmt} — #${quoteNumber}: ${newLink}`;
          const updatedLinks = existingLinks
            ? newEntry + '\n' + existingLinks   // prepend newest
            : newEntry;

          await httpsRequest({
            hostname: 'api.hubapi.com',
            path: `/crm/v3/objects/deals/${dealId}`,
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
          }, { properties: { quote_link: updatedLinks } });
        } catch(e) { console.warn('quote_link append failed:', e.message); }
      }

      // Append quote history to contact record
      if (quoteNumber && contactId) {
        try {
          const newLink = `https://whisperroomquote.up.railway.app/q/${quoteNumber}`;
          const datestamp = new Date().toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'});
          const totalFmt = total ? ' — $' + parseFloat(total).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '';
          const dealLabel = dealName ? ` — ${dealName}` : '';

          // Read existing contact quote history
          const existingContact = await httpsRequest({
            hostname: 'api.hubapi.com',
            path: `/crm/v3/objects/contacts/${contactId}?properties=quote_links,all_quote_numbers`,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
          });
          const existingLinks = existingContact.body?.properties?.quote_links || '';
          const existingNums  = existingContact.body?.properties?.all_quote_numbers || '';

          const newEntry = `${datestamp}${totalFmt}${dealLabel} — #${quoteNumber}: ${newLink}`;
          const updatedLinks = existingLinks ? newEntry + '\n' + existingLinks : newEntry;

          // all_quote_numbers: prepend newest, comma-separated
          const numList = existingNums
            ? quoteNumber + ', ' + existingNums
            : quoteNumber;

          await httpsRequest({
            hostname: 'api.hubapi.com',
            path: `/crm/v3/objects/contacts/${contactId}`,
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
          }, {
            properties: {
              quote_links:        updatedLinks,
              quote_number:       quoteNumber,   // latest
              all_quote_numbers:  numList,
            }
          });
        } catch(e) { console.warn('Contact quote history update failed:', e.message); }
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

  // ── Shareable Quote Page ─────────────────────────────────────────
  if (pathname.startsWith('/q/') && req.method === 'GET') {
    const quoteId = decodeURIComponent(pathname.replace('/q/', '').trim());
    if (!quoteId) { res.writeHead(404); res.end('Not found'); return; }
    try {
      const notesRes = await httpsRequest({
        hostname: 'api.hubapi.com',
        path: '/crm/v3/objects/notes/search',
        method: 'POST',
        headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
      }, {
        filterGroups: [{ filters: [{ propertyName: 'hs_note_body', operator: 'CONTAINS_TOKEN', value: quoteId }] }],
        properties: ['hs_note_body', 'hs_timestamp'],
        limit: 10
      });

      const notes = notesRes.body.results || [];
      let quoteData = null;
      for (const note of notes) {
        try {
          const body = note.properties.hs_note_body || '';
          const m = body.match(/WR_QUOTE_DATA:(.+):END_WR_QUOTE/s);
          if (m) {
            const parsed = JSON.parse(m[1]);
            if (String(parsed.quoteNumber) === String(quoteId)) { quoteData = parsed; break; }
          }
        } catch(e) { continue; }
      }

      if (!quoteData) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><head><title>Quote Not Found</title><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;background:#f5f5f5}div{text-align:center}</style></head><body><div><h2 style="color:#ee6216">Quote Not Found</h2><p style="color:#888">This link may have expired or the quote number is incorrect.</p></div></body></html>');
        return;
      }

      const q = quoteData;
      const fmt = n => '$' + parseFloat(n||0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,',');
      const sub = (q.lineItems||[]).reduce((s,i)=>s+(i.price*i.qty),0);
      const disc = q.discount && q.discount.value > 0
        ? (q.discount.type==='pct' ? sub*q.discount.value/100 : q.discount.value) : 0;
      const freight = q.freight ? q.freight.total : 0;
      const tax = q.tax ? q.tax.tax : 0;
      const total = sub - disc + freight + tax;
      const c = q.customer || {};

      const lineRows = (q.lineItems||[]).map(item =>
        `<tr><td style="padding:10px 12px;border-bottom:1px solid #f0f0f0"><div style="font-weight:600">${item.name}</div>${item.description?`<div style="font-size:12px;color:#999;margin-top:2px">${item.description}</div>`:''}</td><td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:center;color:#666">${item.qty}</td><td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:right;color:#666">${fmt(item.price)}</td><td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:right;font-weight:600">${fmt(item.price*item.qty)}</td></tr>`
      ).join('');

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhisperRoom Quote ${q.quoteNumber||''}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f4f4f4;color:#333}
.page{max-width:760px;margin:0 auto;padding:24px 16px 60px}
.card{background:#fff;border-radius:12px;padding:28px 32px;margin-bottom:16px;box-shadow:0 1px 4px rgba(0,0,0,.07)}
.header{display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:16px}
.logo h1{font-size:20px;font-weight:800;color:#1a1a1a}
.logo p{font-size:12px;color:#999;margin-top:4px;line-height:1.6}
.qnum{font-size:26px;font-weight:800;color:#ee6216;letter-spacing:-.5px}
.qdate{font-size:12px;color:#bbb;margin-top:3px}
.section-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#bbb;margin-bottom:14px}
.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.info-item label{font-size:10px;color:#bbb;text-transform:uppercase;letter-spacing:.05em;display:block;margin-bottom:2px}
.info-item span{font-size:14px;font-weight:500;color:#1a1a1a}
table{width:100%;border-collapse:collapse}
thead th{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#bbb;padding:0 12px 10px;border-bottom:2px solid #f0f0f0;text-align:left}
thead th:nth-child(2){text-align:center}
thead th:nth-child(3),thead th:nth-child(4){text-align:right}
.tot{display:flex;justify-content:space-between;padding:8px 0;font-size:14px;border-bottom:1px solid #f7f7f7;color:#666}
.tot.grand{font-size:18px;font-weight:800;color:#1a1a1a;border:none;padding-top:16px}
.tot.grand span:last-child{color:#ee6216}
.terms{font-size:11px;color:#999;line-height:1.75}
.footer{text-align:center;margin-top:32px;font-size:11px;color:#ccc;line-height:1.8}
@media(max-width:500px){.header{flex-direction:column}.info-grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="page">

  <div class="card">
    <div class="header">
      <div class="logo">
        <h1>WhisperRoom, Inc.</h1>
        <p>322 Nancy Lynn Lane, Suite 14<br>Knoxville, TN 37919 USA<br>(865) 558-5364 · info@whisperroom.com</p>
      </div>
      <div style="text-align:right">
        <div class="qnum">${q.quoteNumber||'QUOTE'}</div>
        <div class="qdate">Issued ${q.date||new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</div>
        <div class="qdate" style="color:#ee6216;font-weight:600">Valid 30 days</div>
      </div>
    </div>
  </div>

  ${c.firstName ? `<div class="card">
    <div class="section-label">Prepared For</div>
    <div class="info-grid">
      <div class="info-item"><label>Name</label><span>${c.firstName} ${c.lastName}</span></div>
      ${c.company?`<div class="info-item"><label>Company</label><span>${c.company}</span></div>`:''}
      ${c.email?`<div class="info-item"><label>Email</label><span>${c.email}</span></div>`:''}
      ${c.address?`<div class="info-item"><label>Ship To</label><span>${c.address}, ${c.city}, ${c.state} ${c.zip}</span></div>`:''}
    </div>
  </div>` : ''}

  <div class="card">
    <div class="section-label">Products &amp; Services</div>
    <table>
      <thead><tr><th>Item</th><th>Qty</th><th>Unit Price</th><th>Total</th></tr></thead>
      <tbody>${lineRows}</tbody>
    </table>
    <div style="max-width:320px;margin-left:auto;margin-top:20px;padding-top:4px;border-top:2px solid #f0f0f0">
      <div class="tot"><span>Subtotal</span><span>${fmt(sub)}</span></div>
      ${disc>0?`<div class="tot"><span>Discount${q.discount.type==='pct'?' ('+q.discount.value+'%)':''}</span><span style="color:#1a7a4a">-${fmt(disc)}</span></div>`:''}
      ${freight>0?`<div class="tot"><span>Freight Estimate</span><span>${fmt(freight)}</span></div>`:''}
      ${tax>0?`<div class="tot"><span>Sales Tax</span><span>${fmt(tax)}</span></div>`:''}
      <div class="tot grand"><span>Total</span><span>${fmt(total)}</span></div>
    </div>
  </div>

  <div class="card">
    <div class="section-label">Terms &amp; Conditions</div>
    <p class="terms">I understand that WhisperRooms are not 100% soundproof. I understand that all products manufactured by WhisperRoom, Inc. are for indoor use only. Any returns will be at the sole discretion of WhisperRoom, Inc. and are subject to a restocking fee and freight charges. Any damage during shipping must be reported within five business days. Compliance with local, state and national building codes is my responsibility. Any alterations to the WhisperRoom will void the warranty.</p>
  </div>

  <div class="footer">
    WhisperRoom, Inc. · 322 Nancy Lynn Lane, Suite 14 · Knoxville, TN 37919<br>
    (865) 558-5364 · info@whisperroom.com · <a href="https://www.whisperroom.com" style="color:#ee6216">whisperroom.com</a><br><br>
    Shipping charges are estimated based on the zip code provided. Quote valid 30 days from issue date.
  </div>

</div>
</body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end('<h2 style="font-family:sans-serif;padding:40px">Error: ' + e.message + '</h2>');
    }
    return;
  }

  // ── One-time property setup endpoint ─────────────────────────────
  if (pathname === '/api/ensure-properties' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    if (body.password !== process.env.WR_PASSWORD) { json({ error: 'Unauthorized' }, 401); return; }
    await ensureHubSpotProperties();
    json({ ok: true, message: 'Properties ensured' });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// Ensure quote_link deal property exists on startup
async function ensureHubSpotProperties() {
  // Properties to ensure exist, keyed by objectType
  const propsToCreate = {
    deals: [
      {
        name: 'quote_link',
        label: 'Quote Links',
        type: 'string',
        fieldType: 'textarea',
        groupName: 'dealinformation',
        description: 'All shareable customer quote links for this deal (newest first, with date and amount)'
      },
      {
        name: 'quote_number',
        label: 'Quote Number',
        type: 'string',
        fieldType: 'text',
        groupName: 'dealinformation',
        description: 'WhisperRoom internal quote number — searchable in deal pipeline'
      },
    ],
    contacts: [
      {
        name: 'quote_links',
        label: 'Quote History',
        type: 'string',
        fieldType: 'textarea',
        groupName: 'contactinformation',
        description: 'All WhisperRoom quotes sent to this contact across all deals (newest first)'
      },
      {
        name: 'quote_number',
        label: 'Latest Quote Number',
        type: 'string',
        fieldType: 'text',
        groupName: 'contactinformation',
        description: 'Most recent WhisperRoom quote number for this contact — searchable'
      },
      {
        name: 'all_quote_numbers',
        label: 'All Quote Numbers',
        type: 'string',
        fieldType: 'text',
        groupName: 'contactinformation',
        description: 'All WhisperRoom quote numbers for this contact, comma-separated'
      },
    ],
  };

  for (const [objectType, props] of Object.entries(propsToCreate)) {
    for (const prop of props) {
      try {
        const check = await httpsRequest({
          hostname: 'api.hubapi.com',
          path: `/crm/v3/properties/${objectType}/${prop.name}`,
          method: 'GET',
          headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
        });
        if (check.status === 200) { console.log(`${objectType}.${prop.name} exists`); continue; }
        await httpsRequest({
          hostname: 'api.hubapi.com',
          path: `/crm/v3/properties/${objectType}`,
          method: 'POST',
          headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
        }, prop);
        console.log(`${objectType}.${prop.name} created`);
      } catch(e) {
        console.log(`${objectType}.${prop.name} skipped:`, e.message);
      }
    }
  }
}

server.listen(PORT, '0.0.0.0', () => {
  ensureHubSpotProperties();
  console.log(`WhisperRoom Quote Builder running on port ${PORT}`);
  console.log(`HubSpot token: ${HS_TOKEN ? HS_TOKEN.substring(0,12) + '...' : 'NOT SET'}`);
  console.log(`TaxJar key: ${TAXJAR_KEY ? TAXJAR_KEY.substring(0,8) + '...' : 'NOT SET'}`);
});
