// WhisperRoom Quote Builder
// Node.js server with HubSpot, TaxJar, and ABF integration

const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const url     = require('url');
const crypto  = require('crypto');

// ── Puppeteer PDF generation ──────────────────────────────────────
let puppeteer;
try {
  puppeteer = require('puppeteer');
  console.log('Puppeteer loaded');
} catch(e) {
  console.warn('Puppeteer not available:', e.message);
}

// Semaphore — only one PDF at a time to stay within Hobby memory limits
let _pdfBusy = false;
async function generatePdf(pageUrl, filename, res, req) {
  if (!puppeteer) {
    res.writeHead(503); res.end('PDF generation not available'); return;
  }
  let waited = 0;
  while (_pdfBusy) {
    await new Promise(r => setTimeout(r, 300));
    waited += 300;
    if (waited > 30000) { res.writeHead(503); res.end('PDF busy — try again'); return; }
  }
  _pdfBusy = true;
  let browser;
  try {
    const cookies = req.headers.cookie || '';
    const sessionCookie = cookies.split(';')
      .map(c => c.trim())
      .find(c => c.startsWith('wr_qt_session=') || c.startsWith('wr_oauth_session='));

    browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox',
             '--disable-dev-shm-usage', '--disable-gpu',
             '--single-process', '--no-zygote'],
      defaultViewport: { width: 1200, height: 900 },
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });

    const page = await browser.newPage();

    if (sessionCookie) {
      const eqIdx = sessionCookie.indexOf('=');
      const name  = sessionCookie.slice(0, eqIdx).trim();
      const value = sessionCookie.slice(eqIdx + 1).trim();
      await page.setCookie({ name, value, domain: 'whisperroomquote.up.railway.app', path: '/', httpOnly: true });
    }

    await page.goto(pageUrl, { waitUntil: 'networkidle0', timeout: 25000 });
    await page.addStyleTag({ content: '.action-bar{display:none!important}body{padding-bottom:0!important}' });

    const pdfBuffer = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });

    const asciiName = filename.replace(/[^\x20-\x7E]/g, '-');
    const encodedName = encodeURIComponent(filename);
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
      'Content-Length': pdfBuffer.length,
    });
    res.end(pdfBuffer);
  } finally {
    _pdfBusy = false;
    if (browser) await browser.close().catch(() => {});
  }
}
// ── PostgreSQL Database (optional — falls back to HubSpot Notes) ──
let Pool, db;
try {
  Pool = require('pg').Pool;
  if (process.env.DATABASE_URL) {
    db = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    console.log('PostgreSQL connected');
  } else {
    console.log('No DATABASE_URL — using HubSpot Notes for history');
  }
} catch(e) {
  console.log('pg module not available — using HubSpot Notes for history');
  db = null;
}

async function initDb() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS quotes (
        id            SERIAL PRIMARY KEY,
        quote_number  TEXT UNIQUE NOT NULL,
        deal_id       TEXT,
        contact_id    TEXT,
        deal_name     TEXT,
        customer_name TEXT,
        company       TEXT,
        rep_id        TEXT,
        total         NUMERIC(12,2),
        date          TEXT,
        quote_link    TEXT,
        json_snapshot JSONB NOT NULL,
        payment_link  TEXT,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_quotes_quote_number ON quotes(quote_number)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_quotes_deal_id      ON quotes(deal_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_quotes_contact_id   ON quotes(contact_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_quotes_rep_id       ON quotes(rep_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_quotes_created_at   ON quotes(created_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_quotes_company      ON quotes(lower(company))`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_quotes_customer_name ON quotes(lower(customer_name))`);
    console.log('Database ready');
  } catch(e) {
    console.warn('DB init skipped (no DATABASE_URL?):', e.message);
  }
}





// Rep notified via HubSpot task

async function saveQuoteToDb(quoteData) {
  if (!db || !process.env.DATABASE_URL) return null;
  try {
    const { quoteNumber, dealId, contactId, dealName, customer, total, date, ownerId } = quoteData;
    const customerName = customer ? [customer.firstName, customer.lastName].filter(Boolean).join(' ') : '';
    const company = customer ? (customer.company || '') : '';
    const quoteLink = quoteNumber ? `https://whisperroomquote.up.railway.app/q/${quoteNumber}` : null;

    const res = await db.query(`
      INSERT INTO quotes
        (quote_number, deal_id, contact_id, deal_name, customer_name, company, rep_id, total, date, quote_link, json_snapshot)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (quote_number) DO UPDATE SET
        deal_id       = EXCLUDED.deal_id,
        contact_id    = EXCLUDED.contact_id,
        deal_name     = EXCLUDED.deal_name,
        customer_name = EXCLUDED.customer_name,
        company       = EXCLUDED.company,
        rep_id        = EXCLUDED.rep_id,
        total         = EXCLUDED.total,
        date          = EXCLUDED.date,
        quote_link    = EXCLUDED.quote_link,
        payment_link  = COALESCE(EXCLUDED.payment_link, quotes.payment_link),
        json_snapshot = EXCLUDED.json_snapshot
      RETURNING id
    `, [
      quoteNumber, dealId || null, contactId || null, dealName || null,
      customerName, company, ownerId || null,
      total ? parseFloat(total) : null,
      date || null, quoteLink, JSON.stringify(quoteData)
    ]);

    return res.rows[0]?.id;
  } catch(e) {
    console.warn('DB save failed:', e.message);
    return null;
  }
}

async function getQuoteFromDb(quoteNumber) {
  if (!db || !process.env.DATABASE_URL) return null;
  try {
    const res = await db.query(
      'SELECT json_snapshot FROM quotes WHERE quote_number = $1',
      [quoteNumber]
    );
    if (res.rows.length === 0) return null;
    return res.rows[0].json_snapshot;
  } catch(e) {
    console.warn('DB get failed:', e.message);
    return null;
  }
}

async function searchQuotesInDb(query, repId, limit = 100, offset = 0) {
  if (!db || !process.env.DATABASE_URL) return null;
  try {
    let where = 'WHERE 1=1';
    const params = [];
    let p = 1;

    if (query) {
      params.push(`%${query.toLowerCase()}%`);
      where += ` AND (lower(customer_name) LIKE $${p} OR lower(company) LIKE $${p} OR lower(deal_name) LIKE $${p} OR quote_number LIKE $${p})`;
      p++;
    }
    if (repId) {
      params.push(repId);
      where += ` AND rep_id = $${p}`;
      p++;
    }

    params.push(limit, offset);
    const res = await db.query(`
      SELECT id, quote_number, deal_id, deal_name, customer_name, company, rep_id, total, date, quote_link, created_at, json_snapshot
      FROM quotes
      ${where}
      ORDER BY created_at DESC
      LIMIT $${p} OFFSET $${p+1}
    `, params);

    const countRes = await db.query(`SELECT COUNT(*) FROM quotes ${where}`, params.slice(0, p-1));
    return { results: res.rows, total: parseInt(countRes.rows[0].count) };
  } catch(e) {
    console.warn('DB search failed:', e.message);
    return null;
  }
}

// ── Quote History via HubSpot Notes ──────────────────────────────
async function fetchQuoteHistory() {
  // DB-only — notes system removed
  if (!db) return [];
  try {
    const res = await db.query(`
      SELECT quote_number, deal_id, deal_name, customer_name, company,
             rep_id, total, date, quote_link, json_snapshot, created_at
      FROM quotes ORDER BY created_at DESC LIMIT 200
    `);
    return res.rows.map(r => ({
      id: r.json_snapshot?.id || r.quote_number,
      quoteNumber: r.quote_number,
      dealId: r.deal_id,
      dealName: r.deal_name,
      customer: {
        firstName: r.customer_name?.split(' ')[0] || '',
        lastName:  r.customer_name?.split(' ').slice(1).join(' ') || '',
        company:   r.company || ''
      },
      ownerId: r.rep_id,
      total: r.total,
      date: r.date,
      quoteLink: r.quote_link,
      savedAt: r.created_at,
      ...r.json_snapshot
    }));
  } catch(e) {
    console.warn('fetchQuoteHistory:', e.message);
    return [];
  }
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

const sessions      = new Set();
const oauthSessions = new Map(); // token → { email, name, ownerId, expiresAt }
const oauthStates   = new Set(); // CSRF state tokens

const HS_CLIENT_ID     = process.env.HS_CLIENT_ID     || '';
const HS_CLIENT_SECRET = process.env.HS_CLIENT_SECRET || '';
const HS_REDIRECT_URI  = process.env.HS_REDIRECT_URI  || 'https://whisperroomquote.up.railway.app/auth/callback';

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
function httpsRequest(options, body, rawBody) {
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
    if (rawBody) req.write(rawBody);
    else if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
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
    properties: ['name', 'price', 'hs_sku', 'description', 'weight'],
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
async function calculateTaxProper(toState, toZip, toCity, amount, shipping) {
  const stateUpper = toStateAbbr(toState);
  const inNexus = NEXUS_STATES[stateUpper];
  if (!inNexus) return { tax: 0, rate: 0, inNexus: false };

  const taxableShipping = inNexus.taxFreight ? shipping : 0;
  const body = {
    from_country: 'US', from_state: 'TN', from_zip: '37813', from_city: 'Morristown',
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
  if (c.wr_oauth_session && oauthSessions.has(c.wr_oauth_session)) {
    const s = oauthSessions.get(c.wr_oauth_session);
    if (s.expiresAt > Date.now()) return true;
    oauthSessions.delete(c.wr_oauth_session);
  }
  return c.wr_qt_session && sessions.has(c.wr_qt_session);
}

function getSession(req) {
  const c = parseCookies(req);
  if (c.wr_oauth_session && oauthSessions.has(c.wr_oauth_session)) {
    const s = oauthSessions.get(c.wr_oauth_session);
    if (s.expiresAt > Date.now()) return s;
  }
  return null;
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
<title>WhisperRoom — Login</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='6' fill='%231a1a1a'/><text x='50%25' y='54%25' dominant-baseline='middle' text-anchor='middle' font-family='Arial Black,sans-serif' font-size='18' font-weight='900' fill='%23e8531a'>W</text></svg>">
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@800&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0a0a;color:#f0ede8;font-family:'DM Mono',monospace;min-height:100vh;display:flex;align-items:center;justify-content:center}
.box{width:360px;padding:40px}
.logo{font-family:'Syne',sans-serif;font-size:30px;font-weight:800;margin-bottom:4px}
.logo span{color:#e8531a}
.sub{font-size:11px;color:#7a7672;text-transform:uppercase;letter-spacing:.1em;margin-bottom:32px}
.hs-btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:13px 20px;background:#ff7a59;border:none;border-radius:6px;color:#fff;font-family:'Syne',sans-serif;font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;text-decoration:none;margin-bottom:20px;transition:background .15s}
.hs-btn:hover{background:#ff6a45}
.divider{display:flex;align-items:center;gap:12px;margin-bottom:20px;color:#444;font-size:11px;text-transform:uppercase;letter-spacing:.08em}
.divider::before,.divider::after{content:'';flex:1;height:1px;background:#2e2e2e}
label{font-size:11px;color:#7a7672;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:6px}
input{width:100%;background:#181818;border:1px solid #2e2e2e;border-radius:4px;color:#f0ede8;font-family:'DM Mono',monospace;font-size:14px;padding:12px;outline:none}
input:focus{border-color:#e8531a}
.pw-btn{margin-top:16px;width:100%;padding:14px;background:#333;border:none;border-radius:4px;color:#f0ede8;font-family:'Syne',sans-serif;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;transition:background .15s}
.pw-btn:hover{background:#444}
.err{margin-top:12px;color:#e74c3c;font-size:12px;text-align:center}
</style></head><body>
<div class="box">
  <div class="logo">Whisper<span>Room</span></div>
  <div class="sub">Internal Tools</div>
  {{HS_BTN}}
  <div class="divider">or password</div>
  <form method="POST" action="/login">
    <label>Password</label>
    <input type="password" name="password" placeholder="Enter password" autofocus>
    <button type="submit" class="pw-btn">Sign In</button>
    {{ERROR}}
  </form>
</div></body></html>`;

// ── Main HTML (served from file) ──────────────────────────────────
const HSO_BTN = `<a href="/auth/hubspot" class="hs-btn"><svg width="18" height="18" viewBox="0 0 512 512" fill="white"><path d="M267.4 211.6c-25.1 23.7-40.8 57-40.8 93.8 0 29.3 9.7 56.3 26 78L203.1 434c-4.4-1.6-9.1-2.5-14-2.5-21.9 0-39.7 17.8-39.7 39.7S167.2 511 189.1 511s39.7-17.8 39.7-39.7c0-4.9-.9-9.6-2.5-14l49.2-50.4c22 16.4 49.2 26.1 78.7 26.1 73.5 0 133.1-59.6 133.1-133.1 0-67.7-50.6-123.5-116.1-131.8v-65.2c13.4-6.8 22.6-20.7 22.6-36.7 0-22.8-18.5-41.3-41.3-41.3-22.8 0-41.3 18.5-41.3 41.3 0 16 9.2 29.9 22.6 36.7v65.7c-22.5 2.9-43.1 11.5-60.4 24.6zM354.2 439.8c-46.6 0-84.4-37.8-84.4-84.4s37.8-84.4 84.4-84.4 84.4 37.8 84.4 84.4-37.8 84.4-84.4 84.4z"/></svg> Sign in with HubSpot</a>`;
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

  // ── HubSpot OAuth: Initiate ──────────────────────────────────────
  if (pathname === '/auth/hubspot') {
    if (!HS_CLIENT_ID) { res.writeHead(302, { Location: '/' }); res.end(); return; }
    const state = generateToken();
    oauthStates.add(state);
    setTimeout(() => oauthStates.delete(state), 600000);
    const scopes = 'crm.objects.contacts.read crm.objects.deals.read crm.objects.deals.write oauth';
    const authUrl = `https://app.hubspot.com/oauth/authorize?client_id=${HS_CLIENT_ID}&redirect_uri=${encodeURIComponent(HS_REDIRECT_URI)}&scope=${encodeURIComponent(scopes)}&state=${state}`;
    res.writeHead(302, { Location: authUrl });
    res.end();
    return;
  }

  // ── HubSpot OAuth: Callback ───────────────────────────────────────
  if (pathname === '/auth/callback') {
    const { code, state, error } = parsed.query;
    if (error || !code || !oauthStates.has(state)) {
      res.writeHead(302, { Location: '/?auth_error=1' }); res.end(); return;
    }
    oauthStates.delete(state);
    try {
      // Exchange code for tokens
      const tokenRes = await httpsRequest({
        hostname: 'api.hubapi.com', path: '/oauth/v1/token', method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }, null, `grant_type=authorization_code&client_id=${HS_CLIENT_ID}&client_secret=${HS_CLIENT_SECRET}&redirect_uri=${encodeURIComponent(HS_REDIRECT_URI)}&code=${code}`);
      const { access_token, expires_in } = tokenRes.body;

      // Get user info from token
      const tokenInfoRes = await httpsRequest({
        hostname: 'api.hubapi.com', path: `/oauth/v1/access-tokens/${access_token}`,
        method: 'GET', headers: { 'Authorization': `Bearer ${access_token}` }
      });
      const { user, hub_id } = tokenInfoRes.body;

      // Verify correct portal
      if (String(hub_id) !== '5764220') {
        res.writeHead(302, { Location: '/?auth_error=wrong_portal' }); res.end(); return;
      }

      // Look up their owner record for name + ownerId
      let ownerId = null; let displayName = user.split('@')[0];
      try {
        const ownerRes = await httpsRequest({
          hostname: 'api.hubapi.com',
          path: `/crm/v3/owners?email=${encodeURIComponent(user)}&limit=1`,
          method: 'GET', headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
        });
        const owners = ownerRes.body?.results || [];
        if (owners.length) {
          ownerId = owners[0].id;
          displayName = [owners[0].firstName, owners[0].lastName].filter(Boolean).join(' ') || displayName;
        }
      } catch(e) { /* non-fatal */ }

      const sessionToken = generateToken();
      oauthSessions.set(sessionToken, {
        email: user, name: displayName, ownerId,
        expiresAt: Date.now() + ((expires_in || 21600) * 1000)
      });
      res.writeHead(302, {
        'Set-Cookie': `wr_oauth_session=${sessionToken}; HttpOnly; Path=/; Max-Age=28800`,
        'Location': '/'
      });
      res.end();
    } catch(e) {
      console.error('OAuth error:', e.message);
      res.writeHead(302, { Location: '/?auth_error=1' }); res.end();
    }
    return;
  }

  // ── Logout ────────────────────────────────────────────────────────
  if (pathname === '/auth/logout') {
    const c = parseCookies(req);
    if (c.wr_oauth_session) oauthSessions.delete(c.wr_oauth_session);
    if (c.wr_qt_session)    sessions.delete(c.wr_qt_session);
    res.writeHead(302, {
      'Set-Cookie': ['wr_oauth_session=; HttpOnly; Path=/; Max-Age=0', 'wr_qt_session=; HttpOnly; Path=/; Max-Age=0'],
      'Location': '/'
    });
    res.end(); return;
  }

  // ── Session info ──────────────────────────────────────────────────
  if (pathname === '/api/me' && req.method === 'GET') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    const sess = getSession(req);
    json({ name: sess?.name || 'User', email: sess?.email || '', ownerId: sess?.ownerId || null });
    return;
  }

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
      res.end(LOGIN_HTML.replace('{{ERROR}}', '<div class="err">Incorrect password.</div>').replace('{{HS_BTN}}', HS_CLIENT_ID ? HSO_BTN : ''));
    }
    return;
  }

  // ── Auth gate ──
  if (!isAuth(req) && pathname !== '/login') {
    if (pathname.startsWith('/api/')) {
      json({ error: 'Unauthorized' }, 401); return;
    }
    res.writeHead(200, {'Content-Type':'text/html'});
    res.end(LOGIN_HTML.replace('{{ERROR}}','').replace('{{HS_BTN}}', HS_CLIENT_ID ? HSO_BTN : ''));
    return;
  }

  // ── Main app ──
  // ── Static assets for quote page ────────────────────────────────
  if (pathname === '/assets/favicon.avif') {
    const buf = Buffer.from('data:image/avif;base64,AAAAHGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZgAAAOptZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAAA5waXRtAAAAAAABAAAAImlsb2MAAAAAREAAAQABAAAAAAEOAAEAAAAAAAAEWwAAACNpaW5mAAAAAAABAAAAFWluZmUCAAAAAAEAAGF2MDEAAAAAamlwcnAAAABLaXBjbwAAABNjb2xybmNseAACAAIABoAAAAAMYXYxQ4EgAgAAAAAUaXNwZQAAAAAAAAEAAAABAAAAABBwaXhpAAAAAAMICAgAAAAXaXBtYQAAAAAAAAABAAEEgYIDhAAABGNtZGF0EgAKBjgd///YJDLOCBIABBAw8UAGIRbCP2Gqdn8HfO9TMEGnJGRjZw9Mb4mjfTDfVN2dM0jWqVBVM57Ct5rAa+QHMLcTkDkeJZHGUtBBisuhTaGr7Vbbzf1zOAH8Jt+Lvxl4eFr/5y1jvQIR4rT41ZvevOW/lr+WJs2HE4IxxBb0urDK0cbBMfHONPepkSfipaigF7bTe38Ne9FYwYrL6Yuk4EHkb1emHCOQ5sOmJ3HLMHz8hSlqgpypL2w8PHxIuv5VuyC0O1r0BF1M2zA6jwcwuldU0eDx53zZla8iWoxfa+dHo0gr1YyLov4eROg5HMBzXg7LzSL45gAKWDxrakGCg3dmmsDqifhUOcbsg9MyiU2EoWDQ+fkAKt3oFJ4iYtiBIu1hixAJOgEev6dPpTCltdruOMP+jFreCXzwSU7CW/kpQ/LhmIvgUsdagyPqzaxkrTv8X4LxHwcyt+IBwNefMcY7tmp3r16AUoSa91HL3pZgNaURVZ8s8ZAyBJwfD1GkAXHyYaqORZXZQWdEfQaRHMn1+4ly4za3SgC7X6YlaMeBlmf7rHURLiDlEFtCY/Qa5Rc6KCf2zbR9LRSxAd2rAN9/0PcawKuxXUhaf0lOTokdEa3nxjtOV0iAUgGBdddT+eDwgY+GQKs5O4o9B+GkQdX0ERjgZQ9f8zXIwVPa9Pe30y9V2JF3hzX1dpAztS8MwKshyk9wFy9j22Cwhj69vkNRpWXMlsG8dKxPRKHOEPH1GXN8or60LAwsKQhjlrbxeabgdLLrRwOiJfnGbZBW1f+6CioMN9TqldFA+11ymwUsVnGCIFBz85PwO2l3Y6sH+1X8CsbwOWC0WG/qDSqLhVUc9DopKPblZkHzjX/bwFeDwj6bgkHgAkTC8Up3v44GOSJf+hktbhMQEqyN20zsEbIHrPO6zwMWRUli2a3QrYFJsKCruYYWYK4EkcuaIamnvLzJBavF9s06wOfHEhg/FQVcd8MRQSp79s4NHTjfSRmi/yE5qYh1RRdnY03Pyo+wFu3lWuXAII9QUsOeOfLuM8GW2W/W7m05ohBuwDTzBLKfze/RgvYwXv9BXaGrhMsPjMNE99mEy33QJLu1SeqTddTIJMz71/0o6jci4IIPHSwqsNLZyb94rL8uI2N2q6Q+He6VuK6C2jUYHDrvAM6f9JchrctvJT2N36jE1i5U5ap3dkACxGFcaohpXr8v8LGWQ4WuzgQXL2H4iKs5GGSiOOPDobB6yNn71fV1y5OPWHF1aEDoZxMa6ra/QKM5ktIqxE8DJarBhSRm53jkfAH/HgGwB43N4PrLyCkNePgQ03mcl2FA2ZXY0jNfh/TG9rsVDH4SlRGcFP5SSFa5BtYYwbU86KptE6B4eU+Cq+6vgZpNfTL/J30LXl2VRWnHspTqu1epSDbmVe2/CgONQysTmbbwdbinnpOxC5zhuylSEimmAIjBWbqGB5uQUlW+mY2rnt+vXgKk69Q='.replace('data:image/avif;base64,',''), 'base64');
    res.writeHead(200, {'Content-Type':'image/avif','Cache-Control':'public,max-age=86400'});
    res.end(buf); return;
  }
  if (pathname === '/assets/logo-orange.svg') {
    const buf = Buffer.from('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTUwIiBoZWlnaHQ9IjMxIiB2aWV3Qm94PSIwIDAgMTUwIDMxIiBmaWxsPSJub25lIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPgo8cGF0aCBkPSJNNDMuNzg4NiAxNC45NjdDNDMuNjI0MiAxNC43OTgzIDQzLjUwOTEgMTQuNTQ1MSA0My40NTk4IDE0LjMwODhDNDMuMzYxMSAxMy44MzYzIDQzLjQ3NjIgMTMuMzYzNyA0My42NzM2IDEyLjk0MThDNDQuMDAyNCAxMi4yNDk4IDQ0LjU5NDMgMTEuNzA5OCA0NS4yNTIgMTEuMzcyM0M0NS43NDUzIDExLjEzNiA0Ni4yODc5IDExLjAwMSA0Ni44MzA1IDExLjA1MTZDNDcuMjQxNiAxMS4xMDIyIDQ3LjY2OTEgMTEuMjU0MSA0Ny45NDg2IDExLjU0MUM0OC4xMjk1IDExLjcyNjcgNDguMjYxMSAxMS45Nzk4IDQ4LjMyNjggMTIuMjMzQzQ4LjQ0MTkgMTIuNzM5MyA0OC4zMTA0IDEzLjMzIDQ4LjAzMDkgMTMuNzY4OEM0Ny43NTEzIDE0LjIyNDQgNDcuMzA3NCAxNC41MjgyIDQ2Ljg0NyAxNC43ODE0QzQ2LjI3MTUgMTUuMDg1MiA0NS42Nzk2IDE1LjMwNDYgNDUuMDA1NCAxNS4zMzgzQzQ0LjU3NzkgMTUuMzU1MiA0NC4wODQ2IDE1LjI4NzcgNDMuNzg4NiAxNC45NjdaIiBmaWxsPSIjZWU2MjE2Ii8+CjxwYXRoIGQ9Ik0zMi4xMzc3IDEyLjM1MjdDMzIuMjIxNCAxMi4zMzYxIDMyLjMyMTggMTIuMzE5NSAzMi4zODg3IDEyLjM1MjdDMzIuNTIyNSAxMi40MDI1IDMyLjU3MjggMTIuNTg1MSAzMi42MDYyIDEyLjczNDZDMzIuNjM5NyAxMi44Njc0IDMyLjY1NjQgMTIuOTgzNiAzMi42NzMxIDEzLjA5OTlDMzIuNzA2NiAxMy40MTU0IDMyLjc0MDEgMTMuNzQ3NSAzMi43NTY4IDE0LjA3OTVDMzIuODIzNyAxNC45NTk2IDMyLjg0MDUgMTUuODIzIDMyLjg3MzkgMTYuNjg2NEMzMi45MDc0IDE4LjE2NDIgMzIuOTQwOSAxOS42NDIgMzIuOTI0MSAyMS4xMTk4QzMyLjkyNDEgMjEuODY3IDMyLjkwNzQgMjIuNTk3NiAzMi44OTA3IDIzLjM0NDhDMzIuODkwNyAyMy42MTA1IDMyLjg5MDcgMjMuODc2MSAzMi44NzM5IDI0LjE0MThDMzIuODU3MiAyNC4zMDc4IDMyLjg1NzIgMjQuNDkwNSAzMi44MjM3IDI0LjY1NjVDMzIuODA3IDI0LjgyMjYgMzIuNzU2OCAyNC45ODg2IDMyLjY4OTkgMjUuMTIxNUMzMi42MjMgMjUuMjcwOSAzMi41MDU4IDI1LjQwMzcgMzIuMzg4NyAyNS41MkMzMi4zMDUgMjUuNjAzIDMyLjIyMTQgMjUuNjg2IDMyLjEzNzcgMjUuNzY5QzMzLjg3NzkgMjUuNzY5IDM1LjYwMTQgMjUuNzY5IDM3LjM0MTYgMjUuNzY5QzM3LjIwNzcgMjUuNjUyOCAzNy4wOTA2IDI1LjUyIDM2Ljk3MzUgMjUuMzg3MUMzNi44NTYzIDI1LjI1NDMgMzYuNzU1OSAyNS4xMDQ5IDM2LjcwNTcgMjQuOTM4OEMzNi42NTU1IDI0Ljc1NjIgMzYuNjM4OCAyNC41NzM1IDM2LjYzODggMjQuMzkwOUMzNi42Mzg4IDIzLjk5MjQgMzYuNjM4OCAyMy42MTA1IDM2LjY1NTUgMjMuMjI4NkMzNi42NzIzIDIyLjQ4MTQgMzYuNjU1NSAyMS43MTc2IDM2LjY1NTUgMjAuOTcwNEMzNi42NTU1IDIwLjUzODYgMzYuNjcyMyAyMC4xMjM1IDM2LjY1NTUgMTkuNjkxOEMzNi42NTU1IDE5LjU1OSAzNi42NTU1IDE5LjQyNjEgMzYuNjU1NSAxOS4yNzY3QzM2LjY3MjMgMTkuMTEwNyAzNi42ODkgMTguOTQ0NiAzNi43NTU5IDE4Ljc5NTJDMzYuODIyOSAxOC42NDU3IDM2LjkyMzMgMTguNTEyOSAzNy4wNDA0IDE4LjM5NjdDMzcuMjU3OSAxOC4xOTc0IDM3LjU1OTEgMTguMTE0NCAzNy44NjAzIDE4LjA5NzhDMzguMDc3OCAxOC4wOTc4IDM4LjI5NTQgMTguMTMxIDM4LjQ3OTQgMTguMjMwNkMzOC42ODAyIDE4LjMzMDMgMzguODQ3NSAxOC40OTYzIDM4Ljk0NzkgMTguNjk1NkMzOS4wNjUxIDE4LjkxMTQgMzkuMDk4NSAxOS4xNDM5IDM5LjExNTMgMTkuMzkyOUMzOS4xMzIgMTkuNTU5IDM5LjExNTMgMTkuNzI1IDM5LjExNTMgMTkuODkxMUMzOS4xMTUzIDIwLjIwNjYgMzkuMTE1MyAyMC41MDU0IDM5LjExNTMgMjAuODIwOUMzOS4xMTUzIDIxLjE4NjIgMzkuMTE1MyAyMS41NjgxIDM5LjExNTMgMjEuOTMzNEMzOS4xMTUzIDIyLjM2NTEgMzkuMTE1MyAyMi44MTM0IDM5LjExNTMgMjMuMjQ1MkMzOS4xMTUzIDIzLjYxMDUgMzkuMTE1MyAyMy45NTkxIDM5LjExNTMgMjQuMzI0NEMzOS4xMTUzIDI0LjQ3MzkgMzkuMTE1MyAyNC42MjMzIDM5LjA4MTggMjQuNzcyOEMzOS4wNDgzIDI0LjkzODggMzguOTY0NyAyNS4wODgyIDM4Ljg2NDMgMjUuMjIxMUMzOC43NDcxIDI1LjM4NzEgMzguNjMgMjUuNTM2NiAzOC40Nzk0IDI1LjY2OTRDMzguNDQ1OSAyNS43MDI2IDM4LjM5NTcgMjUuNzM1OCAzOC4zNjIzIDI1Ljc2OUM0MC44ODg5IDI1Ljc2OSA0My40MzIzIDI1Ljc2OSA0NS45NTkgMjUuNzY5QzQ2LjQ5NDQgMjUuNzY5IDQ3LjAxMzEgMjUuNzY5IDQ3LjU0ODYgMjUuNzY5QzQ3Ljk1MDIgMjUuNzY5IDQ4LjMzNSAyNS43NjkgNDguNzM2NiAyNS43NjlDNDguODcwNCAyNS43NjkgNDguOTg3NiAyNS43NjkgNDkuMTIxNCAyNS43NjlDNDkuMDcxMiAyNS42ODYgNDkuMDIxIDI1LjYwMyA0OC45NzA4IDI1LjUzNjZDNDguODg3MiAyNS40MjAzIDQ4Ljc3MDEgMjUuMzIwNyA0OC42ODY0IDI1LjIyMTFDNDguNjE5NSAyNS4xNTQ3IDQ4LjU2OTMgMjUuMDcxNiA0OC41MzU4IDI0Ljk4ODZDNDguNDM1NCAyNC43NTYyIDQ4LjQwMTkgMjQuNTA3MSA0OC4zODUyIDI0LjI1OEM0OC4zODUyIDI0LjE3NSA0OC4zNjg1IDI0LjA5MiA0OC4zNjg1IDI0LjAwOUM0OC4zNTE3IDIzLjgwOTcgNDguMzY4NSAyMy41OTM4IDQ4LjM2ODUgMjMuMzk0NkM0OC4zNjg1IDIzLjA0NTkgNDguMzY4NSAyMi43MTM4IDQ4LjM2ODUgMjIuMzY1MUM0OC4zNTE3IDIwLjgyMDkgNDguMzY4NSAxOS4yNjAxIDQ4LjM2ODUgMTcuNzE1OUM0OC4zNjg1IDE3LjU4MzEgNDguMzY4NSAxNy40NTAyIDQ4LjM2ODUgMTcuMzE3NEM0OC4zNjg1IDE3LjA2ODMgNDguMzg1MiAxNi44MTkzIDQ4LjQxODcgMTYuNTcwMkM0OC40MzU0IDE2LjQzNzQgNDguNDUyMSAxNi4zMDQ1IDQ4LjQ2ODkgMTYuMTU1MUM0OC40ODU2IDE2LjAyMjMgNDguNTAyMyAxNS44NzI4IDQ4LjQzNTQgMTUuNzU2NkM0OC4zODUyIDE1LjY1NyA0OC4yODQ4IDE1LjU5MDUgNDguMTY3NyAxNS41NTczQzQ4LjAzMzggMTUuNTI0MSA0Ny44ODMyIDE1LjU1NzMgNDcuNzQ5NCAxNS41OTA1QzQ3LjU0ODYgMTUuNjQwMyA0Ny4zODEyIDE1LjY3MzYgNDcuMTYzNyAxNS42OTAyQzQ3LjA2MzMgMTUuNzA2OCA0Ni45NDYyIDE1LjcwNjggNDYuODI5MSAxNS43MDY4QzQ2LjE1OTcgMTUuNzQgNDUuNTc0MSAxNS43NTY2IDQ0Ljk3MTcgMTUuNzU2NkM0NC43NTQyIDE1Ljc1NjYgNDQuNTUzNCAxNS43NTY2IDQ0LjMzNTkgMTUuNzU2NkM0NC4yMDIgMTUuNzU2NiA0NC4wNjgxIDE1Ljc1NjYgNDMuOTM0MyAxNS43NTY2QzQzLjg1MDYgMTUuNzU2NiA0My43NjcgMTUuNzU2NiA0My42ODMzIDE1Ljc3MzJDNDMuNjE2NCAxNS43ODk4IDQzLjU0OTQgMTUuNzg5OCA0My40OTkyIDE1LjgzOTZDNDMuNDMyMyAxNS45MDYgNDMuMzk4OCAxNi4wMDU2IDQzLjM5ODggMTYuMTA1M0M0My40MTU2IDE2LjI3MTMgNDMuNTE2IDE2LjM4NzUgNDMuNjE2NCAxNi41MDM4QzQzLjczMzUgMTYuNjUzMiA0My44MzM5IDE2Ljc4NiA0My45MTc2IDE2LjkxODlDNDMuOTY3OCAxNi45ODUzIDQ0LjAxOCAxNy4wNTE3IDQ0LjA1MTQgMTcuMjE3OEM0NC4wNjgxIDE3LjMzNCA0NC4wODQ5IDE3LjUxNjYgNDQuMTAxNiAxNy42NjYxQzQ0LjEzNTEgMTguMDQ4IDQ0LjExODQgMTguMTgwOCA0NC4xMTg0IDE4LjMzMDNDNDQuMTAxNiAxOS4wNDQyIDQ0LjExODQgMjAuMDU3MSA0NC4xMTg0IDIxLjA1MzRDNDQuMTE4NCAyMS4zODU1IDQ0LjExODQgMjEuNzAxIDQ0LjExODQgMjIuMDMzQzQ0LjExODQgMjIuNTQ3OCA0NC4xMTg0IDIzLjA0NTkgNDQuMTE4NCAyMy41NjA2QzQ0LjExODQgMjMuNjkzNSA0NC4xMTg0IDIzLjgyNjMgNDQuMTE4NCAyMy45NDI1QzQ0LjExODQgMjQuMDkyIDQ0LjEwMTYgMjQuMjQxNCA0NC4wNjgyIDI0LjM5MDlDNDQuMDM0NyAyNC41NTY5IDQ0LjAwMTIgMjQuNzA2MyA0My45MTc2IDI0Ljg3MjRDNDMuODE3MiAyNS4wNTUgNDMuNjY2NiAyNS4yNTQzIDQzLjUzMjcgMjUuMjU0M0M0My4zOTg4IDI1LjIzNzcgNDMuMjgxNyAyNS4wMzg0IDQzLjE5OCAyNC44NzI0QzQzLjEzMTEgMjQuNzIzIDQzLjA5NzYgMjQuNTkwMSA0My4wOTc2IDI0LjQ1NzNDNDMuMDgwOSAyNC4zMDc4IDQzLjA4MDkgMjQuMTI1MiA0My4wODA5IDIzLjk1OTFDNDMuMDgwOSAyMi44NjMzIDQzLjA4MDkgMjEuODAwNiA0My4wODA5IDIwLjczNzlDNDMuMDgwOSAyMC4zMDYyIDQzLjA4MDkgMTkuODU3OSA0My4wODA5IDE5LjQyNjFDNDMuMDgwOSAxOS4yNzY3IDQzLjA4MDkgMTkuMTQzOSA0My4wODA5IDE4Ljk5NDRDNDMuMDY0MiAxOC41NDYxIDQzLjAxNCAxOC4wOTc4IDQyLjg0NjcgMTcuNjgyN0M0Mi41NDU1IDE2Ljk2ODcgNDEuODkyOSAxNi4zODc1IDQxLjE1NjcgMTYuMDM4OUM0MC42NzE0IDE1LjgwNjQgNDAuMTUyNyAxNS42OTAyIDM5LjYxNzIgMTUuNjU3QzM4Ljk5ODEgMTUuNjIzNyAzOC4zNjIzIDE1LjcwNjggMzcuNzU5OSAxNS44NzI4QzM3LjQwODUgMTUuOTU1OCAzNy4wNzM5IDE2LjA3MjEgMzYuNzU1OSAxNi4yMDQ5QzM2Ljc1NTkgMTUuNDkwOSAzNi43NzI3IDE0Ljc3NjkgMzYuNzcyNyAxNC4wNzk1QzM2Ljc3MjcgMTMuNzgwNyAzNi43NzI3IDEzLjQ5ODQgMzYuNzg5NCAxMy4xOTk1QzM2Ljc4OTQgMTMuMDgzMyAzNi44MDYxIDEyLjk4MzYgMzYuODA2MSAxMi44Njc0QzM2LjgyMjkgMTIuNjY4MiAzNi44MjI5IDEyLjQ2ODkgMzYuODU2MyAxMi4yNjk3QzM2Ljg3MzEgMTIuMDcwNCAzNi45MDY1IDExLjg1NDUgMzYuODM5NiAxMS43MzgzQzM2LjgwNjEgMTEuNjcxOSAzNi43NTU5IDExLjYzODcgMzYuNjcyMyAxMS42MDU1QzM2LjUzODQgMTEuNTU1NyAzNi4zNzExIDExLjU4ODkgMzYuMjAzOCAxMS42MjIxQzM2LjA1MzIgMTEuNjU1MyAzNS45MTkzIDExLjY3MTkgMzUuNzY4NyAxMS43MDUxQzM1LjYwMTQgMTEuNzM4MyAzNS40MzQgMTEuNzM4MyAzNS4yNjY3IDExLjc1NDlDMzQuOTMyMSAxMS43NzE1IDM0LjYxNDIgMTEuNzcxNSAzNC4yNzk1IDExLjc3MTVDMzMuNjQzNyAxMS43ODgxIDMzLjAwNzggMTEuNzg4MSAzMi4zNzIgMTEuNzg4MUMzMi4yNTQ4IDExLjk3MDggMzIuMjA0NiAxMi4xNTM0IDMyLjEzNzcgMTIuMzUyN1oiIGZpbGw9IiNlZTYyMTYiLz4KPHBhdGggZD0iTTEyLjg0ODYgMTguMDkyOEMxMy40NDMgMTUuODc4NyAxNC4wMTM3IDEzLjY4ODMgMTQuNTM2OCAxMS40NzQyQzE0LjY1NTcgMTAuOTc0MiAxNC43NzQ2IDEwLjQ3NDMgMTQuODkzNSA5Ljk5ODExQzE1LjA2IDkuMzU1MjkgMTUuMjI2NCA4LjczNjI4IDE1LjM5MjkgOC4xMTcyN0MxNS41MTE3IDcuNjY0OTIgMTUuNjA2OSA3LjIxMjU3IDE1LjcyNTcgNi43NjAyMkMxNS43OTcxIDYuNDUwNzIgMTUuODY4NCA2LjE2NTAyIDE1LjkxNiA1Ljg1NTUxQzE1Ljk2MzUgNS41OTM2MiAxNi4wMTExIDUuMzU1NTUgMTYuMDExMSA1LjA5MzY2QzE2LjAxMTEgNC43ODQxNiAxNS45NjM1IDQuNDUwODQgMTUuODkyMiA0LjE0MTM0QzE1LjgyMDkgMy43ODQyMiAxNS43MjU3IDMuNDUwOSAxNS41ODMxIDMuMTE3NTlDMTUuMjc0IDIuMzA4MTIgMTQuNzc0NiAxLjU3MDA3IDE0LjE1NjQgMC45NzQ4NzNDMTYuOTg2IDAuOTc0ODczIDE5LjgzOTQgMC45NzQ4NzMgMjIuNjY5IDAuOTc0ODczQzIyLjU5NzYgMS4wOTM5MSAyMi41MjYzIDEuMjEyOTUgMjIuNTAyNSAxLjM1NThDMjIuNDMxMiAxLjYxNzY5IDIyLjQwNzQgMS44Nzk1OCAyMi40MDc0IDIuMTY1MjdDMjIuNDMxMiAyLjg3OTUxIDIyLjU3MzkgMy41Njk5NSAyMi43NjQxIDQuMjM2NTdDMjIuOTc4MSA1LjA0NjA0IDIzLjIxNTkgNS44NTU1MiAyMy40NTM3IDYuNjY0OTlDMjMuODEwMyA3Ljg1NTM5IDI0LjE5MDggOS4wNjk1OSAyNC41NDc1IDEwLjI2QzI1LjMwODQgMTIuNzU5OCAyNi4wMjE3IDE1LjI1OTcgMjYuNzM1IDE3Ljc1OTVDMjcuMzUzMyAxNS4zNTQ5IDI3Ljk5NTMgMTIuOTUwMyAyOC43MzI0IDEwLjU2OTVDMjguODUxMyAxMC4xNDEgMjguOTk0IDkuNzEyNDEgMjkuMTEyOSA5LjI4Mzg3QzI5LjMyNjkgOC41NDU4MiAyOS41MTcxIDcuNzgzOTYgMjkuNzMxMSA3LjA0NTkxQzI5Ljg3MzggNi41Njk3NSAzMC4wMTY0IDYuMDkzNTkgMzAuMTM1MyA1LjYxNzQzQzMwLjIzMDQgNS4xODg4OSAzMC4zMjU2IDQuNzYwMzUgMzAuMzQ5MyA0LjMzMThDMzAuMzczMSAzLjk5ODQ5IDMwLjM3MzEgMy42NjUxOCAzMC4zMjU2IDMuMzMxODdDMzAuMjU0MiAyLjkyNzEzIDMwLjA4NzggMi41MjI0IDI5Ljg3MzggMi4xNDE0N0MyOS43MDczIDEuODc5NTggMjkuNTQwOSAxLjYxNzY5IDI5LjMyNjkgMS4zNzk2MUMyOS4yMDggMS4yMTI5NiAyOS4wNjUzIDEuMDcwMTEgMjguOTIyNiAwLjkyNzI2MkMzMC42MzQ3IDAuOTI3MjYyIDMyLjMyMjkgMC45MjcyNjIgMzQuMDM1IDAuOTI3MjYyQzM0LjMyMDMgMC45MjcyNjIgMzQuNTgxOSAwLjkyNzI2MiAzNC44NjcyIDAuOTI3MjYyQzM1LjEyODggMC45MjcyNjIgMzUuMzY2NSAwLjkwMzQ1MSAzNS42MjgxIDAuOTk4NjgzQzM1LjY3NTcgMS4wMjI0OSAzNS43MjMyIDEuMDIyNDkgMzUuNzQ3IDEuMDQ2M0MzNS44NDIxIDEuMTQxNTMgMzUuNzcwOCAxLjMzMiAzNS43MjMyIDEuNDk4NjVDMzUuNjI4MSAxLjc4NDM1IDM1LjU1NjggMi4wMjI0MyAzNS40NjE3IDIuMjM2N0MzMy4zNDU0IDguNjY0ODYgMzAuOTQzOCAxNi40NzM5IDI4Ljc4IDIzLjYxNjNDMjguNjYxMSAyNC4wNDQ4IDI4LjUxODQgMjQuNDQ5NiAyOC4zOTk1IDI0Ljg3ODFDMjguMzI4MiAyNS4wOTI0IDI4LjI4MDYgMjUuMzA2NiAyOC4yMDkzIDI1LjQ5NzFDMjguMTYxNyAyNS42MTYxIDI4LjExNDIgMjUuNzM1MiAyOC4wNjY2IDI1Ljg1NDJDMjguMDE5MSAyNS45NzMzIDI3Ljk3MTUgMjYuMTE2MSAyNy44NzY0IDI2LjE2MzdDMjcuNzU3NSAyNi4yMzUyIDI3LjU2NzMgMjYuMTg3NSAyNy40MDA4IDI2LjEzOTlDMjYuODc3NyAyNS45OTcxIDI2LjQ5NzMgMjUuODU0MiAyNi4wNjkzIDI1LjY2MzhDMjUuMzU1OSAyNS4zNTQzIDI0LjU5NSAyNC45NzMzIDIzLjg4MTcgMjQuNTQ0OEMyMy4yODcyIDI0LjE4NzcgMjIuNjkyOCAyMy44MDY3IDIyLjI2NDcgMjMuMjgzQzIxLjkwODEgMjIuODU0NCAyMS42NzAzIDIyLjMzMDYgMjEuNDU2MyAyMS44MDY5QzIxLjA3NTggMjAuOTAyMiAyMC43OTA1IDE5Ljk3MzcgMjAuNDgxNCAxOS4wNDUxQzIwLjA3NzIgMTcuODA3MSAxOS42NzI5IDE2LjU0NTMgMTkuMjkyNSAxNS4zMDczQzE4Ljg4ODIgMTMuOTc0IDE4LjUwNzggMTIuNjQwOCAxOC4xNzQ5IDExLjI4MzdDMTcuOTg0NyAxMS45NTA0IDE3Ljc5NDQgMTIuNjQwOCAxNy42MDQyIDEzLjMwNzRDMTcuMjk1MSAxNC40MDI2IDE3LjAwOTggMTUuNDczOSAxNi43MjQ0IDE2LjU2OTFDMTYuNDYyOSAxNy41NjkgMTYuMjI1MSAxOC41NDUyIDE1Ljk2MzUgMTkuNTQ1MUMxNS43NDk1IDIwLjQwMjIgMTUuNTExNyAyMS4yNTkzIDE1LjI3NCAyMi4wOTI2QzE1LjEwNzUgMjIuNzExNiAxNC45NjQ4IDIzLjMzMDYgMTQuODIyMiAyMy45MjU4QzE0Ljc1MDggMjQuMjM1MyAxNC42NTU3IDI0LjU2ODYgMTQuNTg0NCAyNC44NzgxQzE0LjUzNjggMjUuMTE2MiAxNC40NjU1IDI1LjMzMDUgMTQuNDE3OSAyNS41Njg1QzE0LjM5NDIgMjUuNjYzOCAxNC4zNzA0IDI1LjczNTIgMTQuMzQ2NiAyNS44MDY2QzE0LjMyMjggMjUuODU0MiAxNC4yNzUzIDI1LjkwMTggMTQuMjI3NyAyNS45NDk1QzE0LjA4NTEgMjYuMDY4NSAxMy44NDczIDI2LjA0NDcgMTMuNjA5NSAyNS45OTcxQzEzLjAzODggMjUuODc4IDEyLjU2MzIgMjUuNzExNCAxMi4wODc3IDI1LjQ5NzFDMTEuMjMxNyAyNS4xNCAxMC4zNTE5IDI0LjY4NzYgOS41NDM0MSAyNC4xNDAxQzkuMTg2NzQgMjMuOTAyIDguODUzODQgMjMuNjE2MyA4LjU2ODUgMjMuMzA2OEM4LjE4ODA1IDIyLjkwMiA3Ljg1NTE2IDIyLjQwMjEgNy41OTM2IDIxLjkwMjFDNy4xMTgwMyAyMS4wMjEyIDYuODA4OTIgMjAuMDkyNyA2LjQ3NjAzIDE5LjE0MDRDNi4wOTU1NyAxOC4wNDUyIDUuNzE1MTIgMTYuOTczOCA1LjMzNDY3IDE1Ljg3ODdDNC40MDczMiAxMy4xNDA4IDMuNTk4ODYgMTAuMzU1MiAyLjk1Njg1IDcuNTQ1ODhDMi43OTA0IDYuODU1NDUgMi42NDc3MyA2LjE2NTAyIDIuNTI4ODQgNS40NzQ1OUMyLjQ4MTI5IDUuMjEyNyAyLjQzMzczIDQuOTc0NjIgMi4zNjIzOSA0LjcxMjczQzIuMjY3MjggNC40MDMyMyAyLjEyNDYyIDQuMTQxMzQgMS45ODE5NSAzLjg1NTY0QzEuNjQ5MDUgMy4xODkwMiAxLjMzOTkzIDIuNDk4NTkgMC44NjQzNjggMS45NTFDMC42NzQxNDIgMS43MzY3MyAwLjQ2MDEzNiAxLjUyMjQ2IDAuMjIyMzU0IDEuMzMxOTlDMC4xNTEwMTkgMS4yNjA1NyAwLjA3OTY4ODcgMS4yMTI5NSAwLjA1NTkxMDUgMS4xMTc3MkMwLjAwODM1NDEzIDEuMDIyNDkgLTAuMDE1NDI3IDAuOTI3MjYzIDAuMDA4MzUxMjMgMC44MzIwMzFDMS43Njc5NCAwLjgzMjAzMSAzLjUwMzc1IDAuODMyMDMxIDUuMjYzMzQgMC44MzIwMzFDNS45MjkxMiAwLjgzMjAzMSA2LjU3MTE0IDAuODMyMDMxIDcuMjEzMTUgMC44MzIwMzFDNy40MDMzOCAwLjgzMjAzMSA3LjU5MzYgMC44MzIwMzEgNy44MDc2MSAwLjgzMjAzMUM3Ljk1MDI3IDAuODMyMDMxIDguMDkyOTQgMC44MzIwMjcgOC4yMTE4MyAwLjg3OTY0M0M4LjMzMDcyIDAuOTI3MjU5IDguNDI1ODQgMS4wNDYzIDguNDk3MTcgMS4xODkxNUM4LjYxNjA2IDEuMzc5NjIgOC42NjM2MiAxLjYxNzY5IDguNzExMTcgMS44MzE5NkM4LjkyNTE4IDIuNzEyODYgOS4xNjI5NiAzLjU0NjE0IDkuNDI0NTIgNC4zNzk0MkMxMC43MzIzIDkuMDIxOTggMTEuNjgzNCAxMy41OTMxIDEyLjg0ODYgMTguMDkyOFoiIGZpbGw9IiNlZTYyMTYiLz4KPHBhdGggZD0iTTQ4LjY4OTUgMjMuMTUzOUM0OS4wMzg0IDIzLjM0NyA0OS40MjYgMjMuNTQwMSA0OS43NzQ5IDIzLjY5NDZDNTAuMDQ2MyAyMy44NDkgNTAuMzU2NCAyMy45NjQ5IDUwLjYyNzggMjQuMDgwN0M1MS4wMTU1IDI0LjE5NjYgNTEuNDAzMSAyNC4yNzM4IDUxLjc5MDggMjQuMzEyNEM1Mi4yOTQ4IDI0LjM4OTcgNTIuODM3NSAyNC40MjgzIDUzLjM0MTUgMjQuMjM1MkM1My41MzUzIDI0LjE1OCA1My43MjkyIDI0LjA4MDcgNTMuODQ1NSAyMy45MjYzQzUzLjkyMyAyMy43NzE4IDUzLjk2MTggMjMuNjE3MyA1My45NjE4IDIzLjQyNDJDNTMuOTYxOCAyMy4yNjk4IDUzLjg4NDIgMjMuMTE1MyA1My44MDY3IDIyLjk5OTRDNTMuNjkwNCAyMi44NDUgNTMuNDk2NiAyMi43Njc3IDUzLjMwMjcgMjIuNjkwNUM1Mi43OTg4IDIyLjQ1ODggNTIuMzMzNiAyMi4yMjcxIDUxLjg2ODMgMjEuOTk1NEM1MS40NDE5IDIxLjgwMjMgNTAuOTc2NyAyMS42MDkyIDUwLjU1MDMgMjEuMzc3NUM1MC4yNDAxIDIxLjE4NDQgNDkuOTMgMjAuOTkxMyA0OS42NTg2IDIwLjcyMUM0OS4zNDg1IDIwLjQxMjEgNDkuMTE1OSAyMC4wMjU5IDQ4Ljk5OTYgMTkuNjAxMUM0OC44ODMzIDE5LjE3NjMgNDguOTIyMSAxOC43MTI5IDQ5LjAzODQgMTguMjQ5NUM0OS4xOTM0IDE3Ljc4NjEgNDkuNDY0OCAxNy4zNjEzIDQ5Ljc3NDkgMTcuMDEzN0M1MC4zOTUyIDE2LjM5NTggNTEuMjA5MyAxNi4wMDk3IDUyLjA2MjIgMTUuODE2NkM1Mi42NDM3IDE1LjcwMDcgNTMuMTg2NCAxNS42NjIxIDUzLjc2NzkgMTUuNjYyMUM1NC4zNDk0IDE1LjY2MjEgNTQuOTY5NyAxNS43MDA3IDU1LjQ3MzcgMTUuNzc4QzU1LjY2NzUgMTUuODE2NiA1NS44NjEzIDE1Ljg1NTIgNTYuMTMyNyAxNS44OTM4QzU2LjMyNjYgMTUuOTMyNCA1Ni41NTkyIDE2LjAwOTcgNTYuNzE0MiAxNi4wODY5QzU2Ljc5MTggMTYuMTI1NSA1Ni44NjkzIDE2LjIwMjggNTYuOTQ2OCAxNi4zMTg2QzU2Ljk4NTYgMTYuMzk1OCA1Ny4wMjQ0IDE2LjQ3MzEgNTcuMDI0NCAxNi41ODg5QzU3LjAyNDQgMTYuNjY2MiA1Ny4wMjQ0IDE2Ljc0MzQgNTcuMDI0NCAxNi44MjA2QzU3LjAyNDQgMTcuMzk5OSA1Ny4wMjQ0IDE3Ljk0MDYgNTcuMDI0NCAxOC41MTk4QzU2Ljc5MTcgMTguMzY1MyA1Ni41OTc5IDE4LjI0OTUgNTYuMzY1MyAxOC4xMzM2QzU2LjA5MzkgMTguMDE3OCA1NS44MjI2IDE3LjkwMTkgNTUuNTUxMiAxNy44MjQ3QzU1LjA4NiAxNy43MDg4IDU0LjY1OTYgMTcuNjcwMiA1NC4xOTQ0IDE3LjY3MDJDNTMuOTYxOCAxNy42NzAyIDUzLjcyOTIgMTcuNzA4OCA1My40OTY2IDE3Ljc4NjFDNTMuMzAyNyAxNy44NjMzIDUzLjEwODkgMTguMDE3OCA1My4wNzAxIDE4LjIxMDlDNTMuMDMxMyAxOC4zNjUzIDUzLjEwODkgMTguNTk3IDUzLjE4NjQgMTguNzEyOUM1My4zNDE1IDE4Ljk0NDYgNTMuNjEyOSAxOS4wMjE4IDUzLjg4NDIgMTkuMTM3N0M1NC40MjcgMTkuMzMwOCA1NC45Njk3IDE5LjQ4NTMgNTUuNTEyNSAxOS42NzgzQzU1LjkzODkgMTkuODMyOCA1Ni4zNjUzIDIwLjAyNTkgNTYuNzUzIDIwLjI1NzZDNTcuMjk1NyAyMC42MDUyIDU3Ljc5OTcgMjEuMTA3MiA1OC4wNzExIDIxLjcyNTFDNTguMzQyNCAyMi4zODE2IDU4LjMwMzcgMjMuMTUzOSA1OC4wMzIzIDIzLjc3MThDNTcuNzYwOSAyNC4zODk3IDU3LjI1NyAyNC44OTE3IDU2LjY3NTUgMjUuMjM5M0M1Ni4xMzI3IDI1LjU4NjggNTUuNTEyNCAyNS43Nzk5IDU0Ljg5MjIgMjUuODk1N0M1NC4xOTQ0IDI2LjA1MDIgNTMuNDU3OCAyNi4wODg4IDUyLjc2IDI2LjA4ODhDNTEuOTQ1OSAyNi4wODg4IDUxLjEzMTggMjUuOTczIDUwLjM5NTIgMjUuODU3MUM1MC4xMjM4IDI1LjgxODUgNDkuODUyNSAyNS43Nzk5IDQ5LjU0MjMgMjUuNzAyN0M0OS40MjYgMjUuNjY0IDQ5LjM0ODUgMjUuNjI1NCA0OS4yNzEgMjUuNTQ4MkM0OS4yMzIyIDI1LjQ3MSA0OS4xOTM0IDI1LjM1NTEgNDkuMTkzNCAyNS4yNzc5QzQ5LjE1NDcgMjUuMTIzNCA0OS4xNTQ3IDI1LjAwNzYgNDkuMTE1OSAyNC44OTE3QzQ4Ljk5OTYgMjQuNDI4MyA0OC44NDQ1IDIzLjg0OSA0OC42ODk1IDIzLjE1MzlaIiBmaWxsPSIjZWU2MjE2Ii8+CjxwYXRoIGQ9Ik02Mi44ODM3IDI0LjAwMTVDNjMuMDI0NiAyNC4zNzg0IDYzLjE2NTQgMjQuNzU1MyA2My4zMDYyIDI1LjEzMjJDNjMuMzUzMiAyNS4zMjA3IDYzLjQ0NzEgMjUuNDYyIDYzLjQ5NCAyNS42NTA1QzYzLjU0MSAyNS43NDQ3IDYzLjU4NzkgMjUuODg2MSA2My42ODE4IDI1LjkzMzJDNjMuODIyNiAyNi4wMjc0IDY0LjAxMDQgMjYuMDc0NSA2NC4xOTgyIDI2LjA3NDVDNjQuNDc5OSAyNi4wNzQ1IDY0LjcxNDYgMjYuMDc0NSA2NC45OTYzIDI2LjA3NDVDNjUuMjMxIDI2LjA3NDUgNjUuNDY1NyAyNi4wNzQ1IDY1LjY1MzUgMjYuMDc0NUM2Ni4wNzYgMjYuMDI3NCA2Ni40NTE2IDI1Ljg4NjEgNjYuODI3MiAyNS42OTc2QzY3LjIwMjcgMjUuNTA5MiA2Ny41MzEzIDI1LjMyMDcgNjcuODYgMjUuMDM4QzY4LjMyOTQgMjQuNjE0IDY4Ljc1MTkgMjQuMDk1NyA2OC45ODY2IDIzLjUzMDNDNjkuMzYyMiAyMi43Mjk0IDY5LjU1IDIxLjc4NzEgNjkuNTUgMjAuODkxOUM2OS41NSAyMC4yMzIzIDY5LjUwMyAxOS42MTk4IDY5LjMxNTMgMTkuMDA3M0M2OS4xMjc1IDE4LjQ0MTkgNjguODkyNyAxNy44NzY1IDY4LjUxNzIgMTcuNDA1NEM2OC4wOTQ3IDE2Ljg0IDY3LjU3ODMgMTYuMzY4OCA2Ni45NjggMTYuMDM5QzY2LjQwNDYgMTUuODAzNSA2NS43OTQ0IDE1LjcwOTIgNjUuMTg0MSAxNS42NjIxQzY0LjgwODUgMTUuNjYyMSA2NC40MzI5IDE1LjY2MjEgNjQuMTA0MyAxNS43NTYzQzYzLjkxNjUgMTUuODAzNSA2My42ODE4IDE1Ljg5NzcgNjMuNDk0IDE2LjAzOUM2My4zMDYyIDE2LjEzMzMgNjMuMTE4NSAxNi4yMjc1IDYyLjkzMDcgMTYuMjI3NUM2Mi44MzY4IDE2LjIyNzUgNjIuNjk1OSAxNi4xMzMzIDYyLjY0OSAxNi4wODYyQzYyLjYwMiAxNS45OTE5IDYyLjYwMjEgMTUuODUwNiA2Mi41MDgyIDE1Ljc1NjNDNjIuNDYxMiAxNS43MDkyIDYyLjM2NzMgMTUuNjYyMSA2Mi4yNzM0IDE1LjY2MjFDNjIuMTc5NSAxNS42NjIxIDYyLjA4NTcgMTUuNzU2MyA2MS45OTE4IDE1LjgwMzVDNjEuODA0IDE1Ljg5NzcgNjEuNjE2MiAxNS44OTc3IDYxLjQyODQgMTUuOTQ0OEM2MS4yNDA2IDE1Ljk0NDggNjEuMDk5OCAxNS45NDQ4IDYwLjkxMiAxNS45NDQ4QzYwLjIwNzggMTUuOTQ0OCA1OS41MDM3IDE1Ljk0NDggNTguODQ2NCAxNS45NDQ4QzU4LjcwNTYgMTUuOTQ0OCA1OC42MTE3IDE1Ljk0NDggNTguNDcwOSAxNS45NDQ4QzU4LjMzIDE1Ljk0NDggNTguMTg5MiAxNS45NDQ4IDU4LjE0MjIgMTUuOTkxOUM1OC4wOTUzIDE2LjAzOSA1OC4wNDgzIDE2LjA4NjEgNTguMDQ4MyAxNi4xODA0QzU4LjA0ODMgMTYuMjI3NSA1OC4wOTUzIDE2LjI3NDYgNTguMTQyMiAxNi4zNjg4QzU4LjIzNjEgMTYuNTU3MyA1OC4zNzcgMTYuNjk4NiA1OC41MTc4IDE2Ljg4NzFDNTguNjExNyAxNy4wMjg0IDU4LjcwNTYgMTcuMTIyNyA1OC43NTI1IDE3LjI2NEM1OC44NDY0IDE3LjQ1MjUgNTguNzk5NSAxNy42ODgxIDU4Ljc5OTUgMTcuOTIzNkM1OC43OTk1IDE4LjA2NSA1OC43OTk1IDE4LjIwNjMgNTguNzk5NSAxOC4zOTQ4QzU4Ljc5OTUgMTguOTEzMSA1OC43OTk1IDE5LjQzMTMgNTguNzk5NSAxOS45NDk2QzU4Ljc5OTUgMjAuNTYyMSA1OC43OTk1IDIxLjEyNzUgNTguNzk5NSAyMS43NEM1OC43OTk1IDIzLjY3MTcgNTguNzUyNSAyNS42NTA1IDU4Ljc5OTUgMjcuNTgyMkM1OC43OTk1IDI3LjkxMiA1OC43OTk1IDI4LjI0MTggNTguNzk5NSAyOC41NzE2QzU4Ljc5OTUgMjguNzYwMSA1OC43OTk1IDI4Ljk0ODUgNTguNzUyNSAyOS4wODk5QzU4LjcwNTYgMjkuMjc4MyA1OC42MTE3IDI5LjQ2NjggNTguNDcwOSAyOS42NTUzQzU4LjMzIDI5Ljg0MzcgNTguMjM2MSAyOS45ODUxIDU4LjA0ODMgMzAuMTczNUM1OS43ODUzIDMwLjE3MzUgNjEuNDc1NCAzMC4xNzM1IDYzLjIxMjMgMzAuMTczNUM2My4xMTg1IDMwLjA3OTMgNjMuMDI0NiAyOS45ODUxIDYyLjkzMDcgMjkuODkwOEM2Mi43NDI5IDI5LjcwMjQgNjIuNjAyMSAyOS40NjY4IDYyLjUwODIgMjkuMTg0MUM2Mi40NjEyIDI4Ljk5NTcgNjIuNDE0MyAyOC44MDcyIDYyLjQxNDMgMjguNjE4N0M2Mi40MTQzIDI4LjM4MzIgNjIuNDE0MyAyOC4xMDA1IDYyLjQxNDMgMjcuODY0OUM2Mi40MTQzIDI3LjQ4OCA2Mi40MTQzIDI3LjE1ODIgNjIuNDE0MyAyNi43ODEyQzYyLjQxNDMgMjQuNzU1MyA2Mi40MTQzIDIyLjc3NjUgNjIuNDE0MyAyMC43NTA1QzYyLjQxNDMgMjAuNTYyMSA2Mi40MTQzIDIwLjM3MzYgNjIuNDE0MyAyMC4xODUyQzYyLjQxNDMgMTkuOTQ5NiA2Mi40MTQzIDE5LjcxNCA2Mi40NjEyIDE5LjUyNTVDNjIuNTA4MiAxOS4yOSA2Mi41NTUxIDE5LjA1NDQgNjIuNjQ5IDE4Ljg2NTlDNjIuNzQyOSAxOC42MzA0IDYyLjkzMDcgMTguNDQxOSA2My4xNjU0IDE4LjM0NzdDNjMuMzUzMiAxOC4yNTM0IDYzLjU0MSAxOC4yMDYzIDYzLjcyODcgMTguMjA2M0M2My45MTY1IDE4LjIwNjMgNjQuMTUxMyAxOC4yMDYzIDY0LjMzOSAxOC4zMDA2QzY0LjYyMDcgMTguMzk0OCA2NC44MDg1IDE4LjU4MzIgNjQuOTk2MyAxOC44MTg4QzY1LjEzNzEgMTkuMDU0NCA2NS4yMzEgMTkuMzM3MSA2NS4zMjQ5IDE5LjYxOThDNjUuNDE4OCAxOS45OTY3IDY1LjUxMjcgMjAuMzczNiA2NS41NTk2IDIwLjc5NzdDNjUuNjA2NiAyMS4yNjg4IDY1LjYwNjYgMjEuNzM5OSA2NS41MTI3IDIyLjI1ODJDNjUuNDY1NyAyMi42ODIyIDY1LjM3MTggMjMuMDU5MiA2NS4xODQxIDIzLjM4OUM2NS4wOTAyIDIzLjU3NzQgNjQuOTAyNCAyMy43NjU5IDY0LjcxNDYgMjMuOTA3MkM2NC40Nzk5IDI0LjA0ODYgNjQuMTk4MiAyNC4xNDI4IDYzLjkxNjUgMjQuMTg5OUM2My41ODc5IDI0LjA5NTcgNjMuMjU5MyAyNC4wOTU3IDYyLjg4MzcgMjQuMDAxNVoiIGZpbGw9IiNlZTYyMTYiLz4KPHBhdGggZD0iTTgwLjQ5NzUgMjMuMDExMkM4MC40OTM2IDIzLjAzMzEgODAuNDkzNiAyMy4wNTEgODAuNDg5NiAyMy4wNjY5QzgwLjQ1NzggMjMuMTYyMyA4MC40MjYgMjMuMjU1NyA4MC4zOTQyIDIzLjM1MTFDODAuMzY0MyAyMy40Mzg2IDgwLjMzMDYgMjMuNTI2MSA4MC4zMDA3IDIzLjYxNTVDODAuMjcwOSAyMy43MDMgODAuMjQ1MSAyMy43OTI0IDgwLjIxNTMgMjMuODgxOUM4MC4xNzM1IDI0LjAwMzEgODAuMTI3OCAyNC4xMjQ0IDgwLjA4NDEgMjQuMjQ1N0M4MC4wNDIzIDI0LjM2MjkgODAuMDAwNiAyNC40NzgyIDc5Ljk1NjkgMjQuNTk1NUM3OS45MjExIDI0LjY5NDkgNzkuODgxMyAyNC43OTQzIDc5Ljg0NTUgMjQuODkzN0M3OS44MTU3IDI0Ljk3OTEgNzkuNzgzOSAyNS4wNjI2IDc5Ljc2MDEgMjUuMTUwMUM3OS43MDQ0IDI1LjM0MjkgNzkuNTg5MSAyNS40ODYgNzkuNDEwMiAyNS41Nzc1Qzc5LjI1NTIgMjUuNjU5IDc5LjA5NjEgMjUuNzMwNSA3OC45MzEyIDI1Ljc5MjFDNzguODQxNyAyNS44MjU5IDc4Ljc1MDMgMjUuODQ5OCA3OC42NTg4IDI1Ljg3OTZDNzguNTgxMyAyNS45MDM1IDc4LjUwNTggMjUuOTI5MyA3OC40MjgyIDI1Ljk1MTJDNzguMzY4NiAyNS45NjkxIDc4LjMwNyAyNS45ODMgNzguMjQ3NCAyNS45OTY5Qzc4LjE3OTggMjYuMDE0OCA3OC4xMTQyIDI2LjAzMjcgNzguMDQ2NiAyNi4wNDg2Qzc4LjAwNjggMjYuMDU4NSA3Ny45NjcxIDI2LjA2NjUgNzcuOTI1MyAyNi4wNzQ0Qzc3Ljg3MzcgMjYuMDg2MyA3Ny44MjIgMjYuMDk2MyA3Ny43NzAzIDI2LjEwODJDNzcuNzMyNSAyNi4xMTYyIDc3LjY5NjcgMjYuMTI0MSA3Ny42NTkgMjYuMTMwMUM3Ny42MDMzIDI2LjE0IDc3LjU0NzcgMjYuMTQ2IDc3LjQ5MiAyNi4xNTU5Qzc3LjQyNDQgMjYuMTY1OCA3Ny4zNTg4IDI2LjE3NzggNzcuMjkxMiAyNi4xODc3Qzc3LjI4NzMgMjYuMTg3NyA3Ny4yODEzIDI2LjE4OTcgNzcuMjc3MyAyNi4xODk3Qzc3LjE5NTggMjYuMTk3NyA3Ny4xMTIzIDI2LjIwNTYgNzcuMDMwOCAyNi4yMTU1Qzc2LjkzMTQgMjYuMjI1NSA3Ni44MzAxIDI2LjIzNTQgNzYuNzMwNyAyNi4yNDczQzc2LjcyMDcgMjYuMjQ5MyA3Ni43MTA4IDI2LjI0OTMgNzYuNzAwOSAyNi4yNTEzQzc2LjQwNDcgMjYuMjYxMyA3Ni4xMDg1IDI2LjI4MzEgNzUuODEyMyAyNi4yNzEyQzc1LjY4MTEgMjYuMjY1MiA3NS41NDk5IDI2LjI2MTMgNzUuNDIwNyAyNi4yNTEzQzc1LjMxNTQgMjYuMjQzNCA3NS4yMSAyNi4yMjk1IDc1LjEwNDcgMjYuMjE5NUM3NS4wMjMyIDI2LjIxMTYgNzQuOTM5NyAyNi4yMDU2IDc0Ljg1ODIgMjYuMTk1N0M3NC43ODg2IDI2LjE4NzcgNzQuNzE5IDI2LjE3MzggNzQuNjQ3NSAyNi4xNjE5Qzc0LjYwMzggMjYuMTUzOSA3NC41NiAyNi4xNDYgNzQuNTE2MyAyNi4xNEM3NC40NjQ2IDI2LjEzMjEgNzQuNDEwOSAyNi4xMjQxIDc0LjM1OTMgMjYuMTE0MkM3NC4zMTE1IDI2LjEwNjIgNzQuMjY1OCAyNi4wOTIzIDc0LjIyMDEgMjYuMDgyNEM3NC4xODQzIDI2LjA3NDQgNzQuMTQ4NiAyNi4wNjY1IDc0LjExNDggMjYuMDU4NUM3NC4wMTU0IDI2LjAzMjcgNzMuOTE0IDI2LjAwODggNzMuODE0NiAyNS45ODFDNzMuNzE5MiAyNS45NTUxIDczLjYyMTggMjUuOTI3MyA3My41MjY0IDI1Ljg5NTVDNzMuNDI1IDI1Ljg2MTcgNzMuMzIzNiAyNS44MjIgNzMuMjIyMiAyNS43ODIyQzczLjEwMyAyNS43MzQ1IDcyLjk4MzcgMjUuNjg4OCA3Mi44Njg0IDI1LjYzNTFDNzIuNTc2MiAyNS40OTk5IDcyLjI5MzkgMjUuMzQ0OSA3Mi4wMjc2IDI1LjE2QzcxLjY5MzYgMjQuOTI5NCA3MS4zODU1IDI0LjY2OSA3MS4xMjEyIDI0LjM2MDlDNzAuODkyNiAyNC4wOTQ2IDcwLjY5OTcgMjMuODAyNCA3MC41NDY3IDIzLjQ4NjNDNzAuNDc1MSAyMy4zMzcyIDcwLjQxMTUgMjMuMTg0MiA3MC4zNTU5IDIzLjAyOTFDNzAuMzIyMSAyMi45MzU3IDcwLjI5NjIgMjIuODM4MyA3MC4yNzA0IDIyLjc0MDlDNzAuMjQ0NSAyMi42NDk1IDcwLjIxODcgMjIuNTU4IDcwLjE5NjggMjIuNDY0NkM3MC4xNzg5IDIyLjM4MTEgNzAuMTY1IDIyLjI5NTYgNzAuMTUxMSAyMi4yMTIxQzcwLjE0MTIgMjIuMTUyNSA3MC4xMjkzIDIyLjA5MjkgNzAuMTE5MyAyMi4wMzEzQzcwLjExOTMgMjIuMDI3MyA3MC4xMTczIDIyLjAyNTMgNzAuMTE3MyAyMi4wMjEzQzcwLjEwOTQgMjEuOTU5NyA3MC4xMDE0IDIxLjg5NjEgNzAuMDk1NSAyMS44MzQ1QzcwLjA2OTYgMjEuNTg0IDcwLjA2NzYgMjEuMzMxNiA3MC4wNzM2IDIxLjA4MTFDNzAuMDc3NiAyMC45NDM5IDcwLjA4NTUgMjAuODA2OCA3MC4wOTc0IDIwLjY2OTZDNzAuMTA1NCAyMC41NjIzIDcwLjExOTMgMjAuNDU2OSA3MC4xMzcyIDIwLjM0OTZDNzAuMTUxMSAyMC4yNTQyIDcwLjE3MyAyMC4xNTg4IDcwLjE5MDkgMjAuMDYzNEM3MC4yMDQ4IDE5Ljk4NTggNzAuMjE4NyAxOS45MDgzIDcwLjIzNjYgMTkuODMwOEM3MC4yNTI1IDE5Ljc2MzIgNzAuMjcyNCAxOS42OTc2IDcwLjI5MDMgMTkuNjNDNzAuMzEyMSAxOS41NDg1IDcwLjMzMiAxOS40NjcgNzAuMzU1OSAxOS4zODc1QzcwLjM3NzcgMTkuMzE0IDcwLjQwMzYgMTkuMjQwNCA3MC40Mjc0IDE5LjE2ODlDNzAuNDUzMyAxOS4wOTEzIDcwLjQ4MTEgMTkuMDEzOCA3MC41MDg5IDE4LjkzODNDNzAuNTU2NiAxOC44MTcgNzAuNjAwNCAxOC42OTE4IDcwLjY1NiAxOC41NzQ1QzcwLjczNzUgMTguMzk5NiA3MC44MjEgMTguMjI0NyA3MC45MTY0IDE4LjA1NzdDNzEuMTQzIDE3LjY1NjIgNzEuNDE5MyAxNy4yODg0IDcxLjc1MzMgMTYuOTY4NEM3Mi4wOTEyIDE2LjY0MjQgNzIuNDY4OSAxNi4zNzIgNzIuODgyMyAxNi4xNTM0QzczLjA0MTQgMTYuMDY5OSA3My4yMDQ0IDE1Ljk5MjQgNzMuMzcxMyAxNS45MjQ4QzczLjQ5MDYgMTUuODc3MSA3My42MTE4IDE1LjgzNzMgNzMuNzMzMSAxNS43OTc2QzczLjgzNjUgMTUuNzYzOCA3My45Mzk4IDE1LjczMiA3NC4wNDMyIDE1LjcwNDFDNzQuMTE0OCAxNS42ODQzIDc0LjE4ODMgMTUuNjcyMyA3NC4yNTk5IDE1LjY1ODRDNzQuMzQ5MyAxNS42NDA1IDc0LjQ0MDggMTUuNjIwNyA3NC41MzAyIDE1LjYwNDhDNzQuNTkzOCAxNS41OTQ4IDc0LjY1NzQgMTUuNTg2OSA3NC43MjEgMTUuNTgwOUM3NC44NjAyIDE1LjU2OSA3NS4wMDEzIDE1LjU1OSA3NS4xNDI0IDE1LjU1MzFDNzUuMjUzOCAxNS41NDkxIDc1LjM2NTEgMTUuNTUxMSA3NS40NzQ0IDE1LjU1MzFDNzUuNTA4MiAxNS41NTMxIDc1LjU0NCAxNS41NTUxIDc1LjU3NzggMTUuNTU5Qzc1LjY5NSAxNS41NjcgNzUuODEyMyAxNS41NzEgNzUuOTI5NiAxNS41ODQ5Qzc2LjAzNSAxNS41OTY4IDc2LjEzODMgMTUuNjE4NyA3Ni4yNDE3IDE1LjYzNjZDNzYuMjg5NCAxNS42NDQ1IDc2LjMzOTEgMTUuNjUyNSA3Ni4zODY4IDE1LjY2MjRDNzYuNDI4NSAxNS42NzA0IDc2LjQ3MDMgMTUuNjgyMyA3Ni41MTIgMTUuNjkyMkM3Ni41NDc4IDE1LjcwMDIgNzYuNTgxNiAxNS43MTAxIDc2LjYxNzQgMTUuNzIwMUM3Ni43MDQ4IDE1Ljc0MzkgNzYuNzkwMyAxNS43Njc4IDc2Ljg3NzggMTUuNzk1NkM3Ni45NTkzIDE1LjgyMTQgNzcuMDM4OCAxNS44NTEyIDc3LjEyMDMgMTUuODc5MUM3Ny4yNTc0IDE1LjkyNDggNzcuMzg4NiAxNS45ODI0IDc3LjUxNzggMTYuMDQ0MUM3Ny43NDY0IDE2LjE1MzQgNzcuOTY3MSAxNi4yNzY2IDc4LjE3NzggMTYuNDE5N0M3OC41NDk1IDE2LjY3MDIgNzguODg1NCAxNi45NjI0IDc5LjE4MTYgMTcuMzAyM0M3OS40NTIgMTcuNjEyNCA3OS42Nzg2IDE3Ljk1MDMgNzkuODU3NSAxOC4zMjIxQzc5LjkzMSAxOC40NzUxIDc5Ljk5MjYgMTguNjMwMiA4MC4wNDgzIDE4Ljc4OTJDODAuMDg2MSAxOC44OTY1IDgwLjExNzkgMTkuMDA3OCA4MC4xNDc3IDE5LjExOTJDODAuMTczNSAxOS4yMTg1IDgwLjE5MzQgMTkuMzIxOSA4MC4yMTMzIDE5LjQyMzNDODAuMjMxMiAxOS41MTQ3IDgwLjI0OTEgMTkuNjA4MiA4MC4yNjY5IDE5LjY5OTZDODAuMjc2OSAxOS43NDkzIDgwLjI4MjggMTkuODAxIDgwLjI4ODggMTkuODUwN0M4MC4yOTg4IDE5Ljk0NjEgODAuMzAyNyAyMC4wNDE1IDgwLjMxNDcgMjAuMTM2OUM4MC4zMzI1IDIwLjI4NiA4MC4zMzQ1IDIwLjQzNTEgODAuMzM0NSAyMC41ODIyQzgwLjMzNDUgMjAuNzE1MyA4MC4zMzI1IDIwLjg1MDUgODAuMzMyNSAyMC45ODM3QzgwLjMzMjUgMjEuMDAzNiA4MC4zMjg2IDIxLjAyMzUgODAuMzI2NiAyMS4wNDUzQzgwLjMwMDcgMjEuMDQ3MyA4MC4yNzY5IDIxLjA0OTMgODAuMjU1IDIxLjA0OTNDNzkuMTUzOCAyMS4wNDkzIDc4LjA1MjYgMjEuMDQ5MyA3Ni45NTEzIDIxLjA1MTNDNzUuOTI5NiAyMS4wNTEzIDc0LjkwNzkgMjEuMDUzMyA3My44ODYyIDIxLjA1NTNDNzMuODA0NyAyMS4wNTUzIDczLjgwNDcgMjEuMDU3MiA3My44MDA3IDIxLjEzODdDNzMuNzkwNyAyMS4yODc4IDczLjgwODYgMjEuNDM2OSA3My44MjA2IDIxLjU4NEM3My44Mjg1IDIxLjY4MzQgNzMuODUyNCAyMS43ODI4IDczLjg3NDIgMjEuODgwMkM3My44OTQxIDIxLjk2OTYgNzMuOTEyIDIyLjA2MTEgNzMuOTM5OCAyMi4xNDY2Qzc0LjAwOTQgMjIuMzYxMiA3NC4xMDI4IDIyLjU2NCA3NC4yMjQxIDIyLjc1NDhDNzQuNDYwNiAyMy4xMjQ1IDc0Ljc2NjggMjMuNDIwNyA3NS4xMzQ1IDIzLjY1OTNDNzUuMjk3NSAyMy43NjQ2IDc1LjQ2ODQgMjMuODUyMSA3NS42NDczIDIzLjkyMzZDNzUuNzU2NyAyMy45Njc0IDc1Ljg2OCAyNC4wMDUxIDc1Ljk4NTMgMjQuMDMxQzc2LjA1NjggMjQuMDQ2OSA3Ni4xMjg0IDI0LjA2ODcgNzYuMTk5OSAyNC4wODI3Qzc2LjI1NzYgMjQuMDk0NiA3Ni4zMTcyIDI0LjEwMDUgNzYuMzc2OSAyNC4xMDg1Qzc2LjQ3NjIgMjQuMTIwNCA3Ni41NzM2IDI0LjEzMDQgNzYuNjczIDI0LjEzODNDNzYuODA0MiAyNC4xNDgyIDc2LjkzNzQgMjQuMTQ4MiA3Ny4wNzA2IDI0LjEzNjNDNzcuMTA2NCAyNC4xMzIzIDc3LjE0NDEgMjQuMTMwNCA3Ny4xNzk5IDI0LjEyODRDNzcuMjc1MyAyNC4xMjA0IDc3LjM3MDcgMjQuMTE2NCA3Ny40NjYyIDI0LjEwMjVDNzcuNTYzNiAyNC4wODg2IDc3LjY2MSAyNC4wNjg3IDc3Ljc1NjQgMjQuMDUwOEM3Ny44MzM5IDI0LjAzNjkgNzcuOTExNCAyNC4wMjMgNzcuOTg4OSAyNC4wMDUxQzc4LjA1NDUgMjMuOTkxMiA3OC4xMTgyIDIzLjk3MTMgNzguMTgzNyAyMy45NTM0Qzc4LjI0MTQgMjMuOTM3NSA3OC4zMDEgMjMuOTIzNiA3OC4zNTg3IDIzLjkwNzdDNzguNDEwNCAyMy44OTM4IDc4LjQ2MiAyMy44Nzc5IDc4LjUxMzcgMjMuODZDNzguNTgzMyAyMy44MzgyIDc4LjY1MDkgMjMuODE0MyA3OC43MTg1IDIzLjc5MDRDNzguNzkgMjMuNzY0NiA3OC44NTk2IDIzLjczODggNzguOTI5MiAyMy43MTI5Qzc5LjAwMjcgMjMuNjg1MSA3OS4wNzYzIDIzLjY1OTMgNzkuMTQ5OCAyMy42MzE0Qzc5LjI1NTIgMjMuNTg5NyA3OS4zNjA1IDIzLjU0NzkgNzkuNDYzOSAyMy41MDQyQzc5LjU3NzIgMjMuNDU2NSA3OS42ODg1IDIzLjQwNjggNzkuNzk3OCAyMy4zNTMxQzc5Ljk3MDggMjMuMjcxNiA4MC4xNDE3IDIzLjE4NjIgODAuMzE0NyAyMy4xMDI3QzgwLjM2ODMgMjMuMDc2OCA4MC40MTggMjMuMDQ3IDgwLjQ3MTcgMjMuMDIxMkM4MC40NzM3IDIzLjAxMzIgODAuNDgxNiAyMy4wMTUyIDgwLjQ5NzUgMjMuMDExMlpNNzMuNzc0OCAxOS4yMzA1Qzc0Ljc1ODggMTkuMjMwNSA3NS43MzQ4IDE5LjIzMDUgNzYuNzE0OCAxOS4yMzA1Qzc2LjcxNjggMTkuMjEwNiA3Ni43MTg4IDE5LjE5NDcgNzYuNzIyNyAxOS4xNzg4Qzc2LjczMjcgMTkuMDk5MyA3Ni43MjI3IDE5LjAxOTggNzYuNzIwNyAxOC45NDAzQzc2LjcxNjggMTguODQ0OCA3Ni42OTY5IDE4Ljc1MzQgNzYuNjc1IDE4LjY2MkM3Ni42NDcyIDE4LjU1NjYgNzYuNjA5NCAxOC40NTUyIDc2LjU1OTcgMTguMzU5OEM3Ni40NzYyIDE4LjE5MjkgNzYuMzY2OSAxOC4wNDc3IDc2LjIxOTggMTcuOTMwNUM3Ni4xNTQyIDE3Ljg3ODggNzYuMDg0NyAxNy44MzUxIDc2LjAwOTEgMTcuNzk3M0M3NS45MzU2IDE3Ljc2MTUgNzUuODYyIDE3LjcyNzcgNzUuNzg2NSAxNy42OTk5Qzc1LjcxMjkgMTcuNjc0IDc1LjYzNTQgMTcuNjU0MiA3NS41NTc5IDE3LjYzODNDNzUuNDcyNCAxNy42MjA0IDc1LjM4NSAxNy42MTI0IDc1LjI5NzUgMTcuNjA4NEM3NS4yNDk4IDE3LjYwNjUgNzUuMjAyMSAxNy42MTg0IDc1LjE1NDQgMTcuNjIwNEM3NS4wNzA5IDE3LjYyNDMgNzQuOTkxNCAxNy42NDQyIDc0LjkxMTkgMTcuNjY4MUM3NC43NzI3IDE3LjcwOTggNzQuNjM3NSAxNy43Njc1IDc0LjUxNDMgMTcuODQ1Qzc0LjI4OTcgMTcuOTgyMSA3NC4xMTQ4IDE4LjE2NSA3My45OTM1IDE4LjM5NzZDNzMuOTQ1OCAxOC40OTEgNzMuOTAwMSAxOC41ODQ0IDczLjg3MjIgMTguNjg1OEM3My44NTQ0IDE4Ljc0OTQgNzMuODMyNSAxOC44MTExIDczLjgxODYgMTguODc0N0M3My44MDI3IDE4Ljk0NjIgNzMuNzkyNyAxOS4wMTk4IDczLjc4MjggMTkuMDkzM0M3My43NzY4IDE5LjEzOSA3My43NzY4IDE5LjE4MjggNzMuNzc0OCAxOS4yMzA1WiIgZmlsbD0iI2VlNjIxNiIvPgo8cGF0aCBkPSJNODAuNTA2OCAyNS43NjY0QzgwLjYwNTggMjUuNjc5NSA4MC42OTkgMjUuNTg2OCA4MC43ODY0IDI1LjQ4ODNDODAuOTI2MSAyNS4zMjYxIDgxLjA0ODQgMjUuMTUyMyA4MS4xMjk5IDI0Ljk2MTFDODEuMjU4MSAyNC42NDgzIDgxLjI1ODEgMjQuMzAwNyA4MS4yNjM5IDIzLjk1MzFDODEuMjY5NyAyMy4xODI1IDgxLjI2MzkgMjIuNDQ2OCA4MS4yNjM5IDIxLjY5OTVDODEuMjYzOSAyMC42MjE5IDgxLjI2OTcgMTkuNTI3IDgxLjI2MzkgMTguNDM3OEM4MS4yNjM5IDE4LjI1ODIgODEuMjYzOSAxOC4wNzg2IDgxLjI2MzkgMTcuOTA0OEM4MS4yNjM5IDE3Ljc4MzIgODEuMjY5NyAxNy42NjE1IDgxLjI2MzkgMTcuNTM5OUM4MS4yNjM5IDE3LjQ2NDYgODEuMjU4MSAxNy4zODkyIDgxLjIzNDggMTcuMzEzOUM4MS4xODgyIDE3LjE0MDEgODEuMDQ4NCAxNy4wMDExIDgwLjkyNjEgMTYuODU2M0M4MC44MDk3IDE2LjcyMyA4MC43MDQ4IDE2LjU4NCA4MC42NDA4IDE2LjQyMThDODAuNTg4NCAxNi4yODg1IDgwLjU3NjcgMTYuMTM3OSA4MC41ODI1IDE1LjkzNTFDODEuMjM0OCAxNS45MzUxIDgxLjg4MTIgMTUuOTM1MSA4Mi41MzM0IDE1LjkzNTFDODIuODAxMiAxNS45MzUxIDgzLjA2OTEgMTUuOTM1MSA4My4zMTM3IDE1LjkzNTFDODMuNTE3NSAxNS45MzUxIDgzLjcwOTcgMTUuOTM1MSA4My45MzY4IDE1Ljg5NDZDODQuMTExNSAxNS44NjU2IDg0LjMxNTMgMTUuODEzNSA4NC40OTU4IDE1Ljc3ODdDODQuNjEyMyAxNS43NTU1IDg0LjcyMyAxNS43MzgyIDg0LjgzOTQgMTUuNzQzOUM4NC45MDkzIDE1Ljc0OTcgODQuOTc5MiAxNS43NjEzIDg1LjAzMTYgMTUuODAxOUM4NS4wNzgyIDE1Ljg0MjQgODUuMTAxNSAxNS45MDYyIDg1LjExODkgMTUuOTY0MUM4NS4xMzA2IDE2LjAxNjIgODUuMTMwNiAxNi4wNjg0IDg1LjEzMDYgMTYuMTI2M0M4NS4xMzY0IDE2LjI4ODUgODUuMTQyMiAxNi40NTA3IDg1LjEzMDYgMTYuNjEyOUM4NS4yMzU0IDE2LjUwMjkgODUuMzQ2MSAxNi4zOTg2IDg1LjQ2MjUgMTYuMjk0M0M4NS42MTM5IDE2LjE2MTEgODUuNzc3IDE2LjAzOTQgODUuOTUxNyAxNS45NDY3Qzg2LjEzMjIgMTUuODU0IDg2LjMzMDIgMTUuNzkwMyA4Ni41MjI0IDE1Ljc0MzlDODYuNzg0NCAxNS42ODYgODcuMDQwNyAxNS42NTcgODcuMzI2IDE1LjY2MjhDODcuNTI0IDE1LjY2MjggODcuNzM5NSAxNS42ODAyIDg3Ljg3MzQgMTUuODA3N0M4Ny45NDkxIDE1Ljg4MyA4Ny45OTU3IDE1Ljk4NzMgODguMDEzMiAxNi4wOTczQzg4LjAzNjUgMTYuMTk1OCA4OC4wMzA2IDE2LjMwMDEgODguMDMwNiAxNi4zOTg2Qzg4LjAzMDYgMTYuNjY1MSA4OC4wMzA2IDE2LjkzMTYgODguMDMwNiAxNy4yMDM5Qzg4LjAzMDYgMTcuNjI2OCA4OC4wMjQ4IDE4LjA0MzkgODguMDI0OCAxOC40MjYyQzg3LjQ4MzIgMTguNDIwNSA4Ny4wNzU2IDE4LjM5NzMgODYuNzAyOSAxOC40MTQ3Qzg2LjQ5MzMgMTguNDI2MiA4Ni4zMDExIDE4LjQ0OTQgODYuMDk3MyAxOC41MTg5Qzg1LjkxMDkgMTguNTgyNyA4NS43MTI5IDE4LjY4MTEgODUuNTQ5OSAxOC44MjAyQzg1LjM3NTIgMTguOTY1IDg1LjIzNTQgMTkuMTU2MiA4NS4xNDgxIDE5LjM2NDhDODUuMDQzMiAxOS42MjU1IDg1LjAzMTYgMTkuOTIwOSA4NS4wMzE2IDIwLjIwNDhDODUuMDMxNiAyMC40MTMzIDg1LjAzMTYgMjAuNjE2MSA4NS4wMzE2IDIwLjgxODlDODUuMDM3NCAyMS41MzE1IDg1LjA0OTEgMjIuMjQ0IDg1LjAzMTYgMjIuOTE2MUM4NS4wMTk5IDIzLjM4NTMgODQuOTk2NyAyMy44MzcyIDg1LjA1NDkgMjQuMzkzM0M4NS4wNzI0IDI0LjU0OTggODUuMDg5OCAyNC43MTIgODUuMTM2NCAyNC44NTY4Qzg1LjIwMDUgMjUuMDc3IDg1LjMxMTEgMjUuMjUwOCA4NS40Mjc2IDI1LjQxODhDODUuNTA5MSAyNS41MzQ2IDg1LjU5NjUgMjUuNjQ0NyA4NS42ODk2IDI1Ljc0OUM4My45NjAxIDI1Ljc2NjQgODIuMjM2NCAyNS43NjY0IDgwLjUwNjggMjUuNzY2NFoiIGZpbGw9IiNlZTYyMTYiLz4KPHBhdGggZD0iTTk4LjIwNzMgMjUuNzU4MkM5NC43ODA5IDI1Ljc1ODIgOTEuMzU0NiAyNS43NTgyIDg3LjkxNSAyNS43NTgyQzg3Ljk0MTQgMjUuNzI1MiA4Ny45NjEzIDI1LjY5MjEgODcuOTgxMSAyNS42Nzg5Qzg4LjMxMTkgMjUuNDA3NyA4OC41ODk3IDI1LjA5MDIgODguODM0NCAyNC43Mzk2Qzg4Ljk5MzIgMjQuNTE0NyA4OS4xMTg4IDI0LjI4MzIgODkuMjExNCAyNC4wMzE4Qzg5LjI3NzYgMjMuODQ2NiA4OS4zMTczIDIzLjY1NDggODkuMzYzNiAyMy40NjNDODkuNDI5NyAyMy4yMDUgODkuNDI5NyAyMi45NDA0IDg5LjQ1NjIgMjIuNjc1OUM4OS41MDkxIDIyLjE4NjQgODkuNDg5MyAyMS43MDM1IDg5LjQ4OTMgMjEuMjE0Qzg5LjQ4OTMgMjAuMDk2MiA4OS40ODkzIDE4Ljk3ODMgODkuNDc2IDE3Ljg2MDRDODkuNDY5NCAxNi45MDEzIDg5LjQ0OTYgMTUuOTQ4OCA4OS40Mjk3IDE0Ljk4OTdDODkuNDE2NSAxNC4zMzQ5IDg5LjQxNjUgMTMuNjggODkuMzkgMTMuMDE4NkM4OS4zNTcgMTIuMDI2NCA4OS4zNzAyIDExLjAyNzYgODkuMzM3MSAxMC4wMzU0Qzg5LjI4NDIgOC4zMzU0NiA4OS4zMTczIDYuNjI4OSA4OS4zMDQgNC45Mjg5NUM4OS4zMDQgNC42NjQzNyA4OS4zMTczIDQuNDA2NCA4OS4yNzEgNC4xNDE4MkM4OS4yNTc3IDQuMDgyMjkgODkuMjY0NCA0LjAxNjE0IDg5LjI2NDQgMy45NDk5OUM4OS4yNjQ0IDMuNzQ0OTQgODkuMjMxMyAzLjUzOTg5IDg5LjE4NSAzLjM0MTQ1Qzg5LjE1MTkgMy4yMDI1NSA4OS4xMjU1IDMuMDU3MDMgODkuMDg1OCAyLjkxODEyQzg4Ljk2MDEgMi40NzQ5NCA4OC43NjgzIDIuMDc4MDcgODguNDE3NyAxLjc2NzE4Qzg4LjI4NTQgMS42NDgxMiA4OC4xNTk3IDEuNTI5MDYgODguMDIwOCAxLjQxNjYxQzg3Ljk0MTQgMS4zNTA0NiA4Ny44ODE5IDEuMjcxMDkgODcuODQyMiAxLjE3ODQ5Qzg3Ljc3NjEgMS4wMTMxMiA4Ny44MTU4IDAuOTAwNjc0IDg4LjAyNzQgMC44Njc2MDFDODguMDg3IDAuODU0MzcyIDg4LjE0NjUgMC44NjA5ODYgODguMjA2IDAuODYwOTg2Qzg5LjI4NDIgMC44NjA5ODYgOTAuMzYyNCAwLjg2NzYwMiA5MS40MzM5IDAuODQ3NzU4QzkxLjkzIDAuODQxMTQzIDkyLjQzMjcgMC44MjEyOTkgOTIuOTI4OCAwLjgzNDUyOEM5NS40MjkxIDAuODk0MDU5IDk3LjkyOTUgMC44NDExNDMgMTAwLjQzNiAwLjg2NzYwMUMxMDAuNTYyIDAuODY3NjAxIDEwMC42ODEgMC44ODc0NDUgMTAwLjgwNyAwLjkwMDY3NEMxMDAuODQgMC45MDA2NzQgMTAwLjg2NiAwLjkwNzI4OSAxMDAuODk5IDAuOTA3Mjg5QzEwMS4xMzEgMC45MjcxMzMgMTAxLjM2MiAwLjk0MDM2MSAxMDEuNTk0IDAuOTY2ODJDMTAxLjcyNiAwLjk4MDA0OSAxMDEuODU5IDEuMDE5NzQgMTAxLjk4NCAxLjAzOTU4QzEwMi4wOTcgMS4wNTk0MiAxMDIuMjAyIDEuMDcyNjUgMTAyLjMxNSAxLjA5MjVDMTAyLjQxNCAxLjExMjM0IDEwMi41MDcgMS4xMzg4IDEwMi42MDYgMS4xNjUyNkMxMDIuNjcyIDEuMTg1MSAxMDIuNzMyIDEuMjA0OTQgMTAyLjc5OCAxLjIxODE3QzEwMy4xMDkgMS4yOTA5MyAxMDMuNDA2IDEuNDEgMTAzLjY5NyAxLjUzNTY3QzEwNC4yODYgMS43ODcwMyAxMDQuODE1IDIuMTMwOTkgMTA1LjI5OCAyLjU1NDMyQzEwNS43NzQgMi45NzEwNCAxMDYuMTg0IDMuNDQ3MjkgMTA2LjUyOCAzLjk3NjQ1QzEwNi43MzMgNC4yOTM5NSAxMDYuOTE5IDQuNjI0NjggMTA3LjA1OCA0Ljk3NTI1QzEwNy4xMyA1LjE2MDQ2IDEwNy4yMDMgNS4zNDU2NyAxMDcuMjY5IDUuNTM3NDlDMTA3LjMxNiA1LjY3NjQgMTA3LjM0MiA1LjgyMTkyIDEwNy4zNzUgNS45Njc0NEMxMDcuNDIxIDYuMTc5MTEgMTA3LjQ1NCA2LjM5MDc3IDEwNy40OTQgNi42MDI0NEMxMDcuNDk0IDYuNjE1NjcgMTA3LjUwMSA2LjYyMjI4IDEwNy41MDEgNi42MzU1MUMxMDcuNTE0IDYuOTU5NjMgMTA3LjUzNCA3LjI4Mzc0IDEwNy41NCA3LjYxNDQ3QzEwNy41NCA3LjgxOTUyIDEwNy41MjcgOC4wMTc5NiAxMDcuNTAxIDguMjIzMDFDMTA3LjQ3NCA4LjQ0MTI5IDEwNy40MjEgOC42NTk1NyAxMDcuMzgyIDguODg0NDdDMTA3LjMzNSA5LjE2ODg5IDEwNy4yNDMgOS40NDAwOSAxMDcuMTQ0IDkuNzA0NjdDMTA2LjkzMiAxMC4yNTM3IDEwNi42NDEgMTAuNzYzIDEwNi4yNjQgMTEuMjE5NEMxMDUuOTk5IDExLjU0MzUgMTA1LjY4OCAxMS44MjEzIDEwNS4zNzEgMTIuMDkyNUMxMDQuODY4IDEyLjUyMjUgMTA0LjMzMiAxMi45MDYxIDEwMy43NTcgMTMuMjQzNUMxMDMuNTUyIDEzLjM2MjUgMTAzLjMzNCAxMy40NjE4IDEwMy4xMjIgMTMuNTY3NkMxMDMuMDQ5IDEzLjYwMDcgMTAzLjA0MyAxMy42MTM5IDEwMy4wODIgMTMuNjhDMTAzLjMwNyAxNC4wMzA2IDEwMy41MzIgMTQuMzg3OCAxMDMuNzU3IDE0LjczODRDMTAzLjkyMiAxNS4wMDMgMTA0LjA5NCAxNS4yNjc1IDEwNC4yNTMgMTUuNTMyMUMxMDQuNTQ0IDE2LjAwODQgMTA0LjgzNSAxNi40NzggMTA1LjExOSAxNi45NTQzQzEwNS4zODQgMTcuMzkwOCAxMDUuNjU1IDE3LjgzNCAxMDUuOTIgMTguMjc3MkMxMDYuMjExIDE4Ljc2IDEwNi41MDIgMTkuMjQ5NSAxMDYuNzkzIDE5LjczOUMxMDcuMTgzIDIwLjM4NzIgMTA3LjU2NyAyMS4wMzU0IDEwNy45NTcgMjEuNjgzN0MxMDguMjIyIDIyLjEyNjggMTA4LjQ5MyAyMi41NjM0IDEwOC43NzEgMjNDMTA5LjA2MiAyMy40NDMxIDEwOS4zOTkgMjMuODUzMyAxMDkuNzUgMjQuMjUwMUMxMTAuMTczIDI0LjcxOTggMTEwLjYyMyAyNS4xNTYzIDExMS4xMTIgMjUuNTU5OEMxMTEuMTE5IDI1LjU2NjQgMTExLjExOSAyNS41NzMgMTExLjEzOSAyNS41ODYzQzExMS4wNzMgMjUuNjA2MSAxMTEuMDA2IDI1LjYzMjYgMTEwLjk0NyAyNS42MzI2QzExMC42ODkgMjUuNjUyNCAxMTAuNDMxIDI1LjY1OSAxMTAuMTggMjUuNjkyMUMxMDkuOTc1IDI1LjcxODYgMTA5Ljc3IDI1LjcwNTMgMTA5LjU2NCAyNS43Mzg0QzEwOS4zOTMgMjUuNzY0OSAxMDkuMjIxIDI1Ljc1MTYgMTA5LjA0OSAyNS43NzgxQzEwOC43OTEgMjUuODE3OCAxMDguNTMzIDI1Ljc5MTMgMTA4LjI3NSAyNS44MzFDMTA3LjkzNyAyNS44NzczIDEwNy42IDI1Ljg1MDkgMTA3LjI2MyAyNS44NzA3QzEwNi4yNjQgMjUuOTQzNSAxMDUuMjcyIDI1Ljg5MDUgMTA0LjI3MyAyNS45MDM4QzEwNC4wNzQgMjUuOTAzOCAxMDMuODY5IDI1Ljg5MDUgMTAzLjY3MSAyNS44NTA5QzEwMy4wNDkgMjUuNzM4NCAxMDIuNTEzIDI1LjQ1NCAxMDIuMDM3IDI1LjAzNzNDMTAxLjcgMjQuNzM5NiAxMDEuNDIyIDI0LjM5NTYgMTAxLjE5NyAyNC4wMTJDMTAwLjk5MiAyMy42NzQ3IDEwMC44IDIzLjMyNDEgMTAwLjYwOCAyMi45ODAxQzEwMC40NDMgMjIuNjg5MSAxMDAuMjc4IDIyLjM5OCAxMDAuMTE5IDIyLjEwN0M5OS44NjA5IDIxLjYzNzQgOTkuNjAyOSAyMS4xNjExIDk5LjM1MTYgMjAuNjkxNUM5OS4wNDczIDIwLjEyMjYgOTguNzQ5NyAxOS41NTM4IDk4LjQ1MiAxOC45ODQ5Qzk4LjEzNDUgMTguMzgzIDk3LjgxNyAxNy43ODc3IDk3LjQ3MyAxNy4yMDU2Qzk3LjE2MjIgMTYuNjc2NCA5Ni44NjQ1IDE2LjEzNCA5Ni41NjAyIDE1LjU5ODNDOTYuNTQ3IDE1LjU3ODQgOTYuNTMzOCAxNS41NjUyIDk2LjQ5NDEgMTUuNTU4NkM5Ni40OTQxIDE1LjU5MTYgOTYuNDk0MSAxNS42MjQ3IDk2LjQ5NDEgMTUuNjU3OEM5Ni40OTQxIDE3LjY4ODUgOTYuNDk0MSAxOS43MjU4IDk2LjQ5NDEgMjEuNzU2NEM5Ni40OTQxIDIyLjEzMzUgOTYuNTAwNyAyMi41MDM5IDk2LjUyMDUgMjIuODgwOUM5Ni41MjcyIDIzLjA0NjMgOTYuNTY2OSAyMy4yMDUgOTYuNTkzMyAyMy4zNzA0Qzk2LjYxMzIgMjMuNDgyOCA5Ni42MjY0IDIzLjU4ODcgOTYuNjU5NSAyMy43MDExQzk2LjY5OTEgMjMuODQgOTYuNzQ1NCAyMy45ODU1IDk2LjgwNSAyNC4xMTc4Qzk2LjkxNzQgMjQuMzgyNCA5Ny4wNTYzIDI0LjYzMzggOTcuMjI4MyAyNC44NjUzQzk3LjQ3OTcgMjUuMTg5NCA5Ny43NjQxIDI1LjQ2NzIgOTguMTE0NyAyNS42ODU1Qzk4LjE0NzcgMjUuNzA1MyA5OC4xODA4IDI1LjczMTggOTguMjEzOSAyNS43NTE2Qzk4LjIxMzkgMjUuNzQ1IDk4LjIxMzkgMjUuNzUxNiA5OC4yMDczIDI1Ljc1ODJaTTk2LjQ0MTIgNC42MTE0NUM5Ni40MTQ3IDQuNzcwMiA5Ni40MTQ3IDEzLjAzMTggOTYuNDQxMiAxMy4xMTEyQzk2LjQ1NDQgMTMuMTExMiA5Ni40Njc2IDEzLjExNzggOTYuNDgwOSAxMy4xMTc4Qzk2LjU2MDIgMTMuMTA0NiA5Ni42Mzk2IDEzLjA5MTMgOTYuNzE5IDEzLjA3MTVDOTYuODExNiAxMy4wNTE3IDk2LjkxMDggMTMuMDQ1IDk3LjAwMzQgMTMuMDE4NkM5Ny4xNjg4IDEyLjk2NTcgOTcuMzI3NSAxMi45MDYxIDk3LjQ5MjkgMTIuODUzMkM5Ny43NDQyIDEyLjc2NzIgOTcuOTgyNCAxMi42NDgyIDk4LjIxMzkgMTIuNTA5M0M5OC42NDM4IDEyLjI1MTMgOTkuMDIwOSAxMS45MjcyIDk5LjM1MTYgMTEuNTU2OEM5OS43MDIyIDExLjE1OTkgOTkuOTg2NiAxMC43Mjk5IDEwMC4xOTggMTAuMjQ3MUMxMDAuMjc4IDEwLjA2ODUgMTAwLjMzNyA5Ljg4MzI3IDEwMC4zOTcgOS42OTE0NUMxMDAuNDM2IDkuNTY1NzcgMTAwLjQ2MyA5LjQzMzQ4IDEwMC40OTYgOS4zMDExOUMxMDAuNTM2IDkuMTIyNTkgMTAwLjU3NSA4Ljk0NCAxMDAuNTc1IDguNzU4NzlDMTAwLjU3NSA4LjY5MjY0IDEwMC41ODIgOC42MjY1IDEwMC41ODIgOC41NTM3NEMxMDAuNTg5IDguMTYzNDggMTAwLjU4OSA3Ljc3MzIyIDEwMC40ODkgNy4zOTYxOUMxMDAuNDM2IDcuMjEwOTggMTAwLjQwMyA3LjAxOTE2IDEwMC4zMzcgNi44NDA1NkMxMDAuMjExIDYuNDg5OTkgMTAwLjAzMyA2LjE2NTg4IDk5Ljc5NDggNS44NjgyMkM5OS41NTY2IDUuNTc3MTggOTkuMjg1NCA1LjMyNTgzIDk4Ljk1NDcgNS4xMjczOUM5OC43Njk1IDUuMDE0OTQgOTguNTcxMSA0LjkyODk1IDk4LjM3MjYgNC44NDI5NkM5OC4yNzM0IDQuNzk2NjYgOTguMTYxIDQuNzcwMiA5OC4wNTUxIDQuNzQzNzRDOTcuOTY5MSA0LjcyMzkgOTcuODgzMiA0LjcwNDA1IDk3Ljc5NzIgNC42OTA4M0M5Ny42NzE1IDQuNjY0MzcgOTcuNTUyNCA0LjYxODA3IDk3LjQyNjcgNC42MTgwN0M5Ny4xMDkyIDQuNTk4MjIgOTYuNzc4NSA0LjYxMTQ1IDk2LjQ0MTIgNC42MTE0NVoiIGZpbGw9IiNlZTYyMTYiLz4KPHBhdGggZD0iTTExNC43ODcgMTUuNzcxOEMxMTUuMDU5IDE1Ljc2MzkgMTE1LjMyOCAxNS43NzcgMTE1LjU5NSAxNS44MDU4QzExNS43OTkgMTUuODI5MyAxMTYuMDAzIDE1Ljg2MzMgMTE2LjIwNyAxNS45QzExNi4zNDMgMTUuOTIzNSAxMTYuNDgyIDE1Ljk1MjMgMTE2LjYxNiAxNS45ODg5QzExNi44NTYgMTYuMDU0MyAxMTcuMDkyIDE2LjEzOCAxMTcuMzE5IDE2LjI0QzExNy43ODcgMTYuNDQ2NyAxMTguMjE3IDE2LjcxNjEgMTE4LjU5OCAxNy4wNTFDMTE4Ljk5MyAxNy4zOTYzIDExOS4zMiAxNy43OTkyIDExOS41ODUgMTguMjU0NEMxMTkuNzEzIDE4LjQ3MTUgMTE5LjgyMyAxOC42OTkxIDExOS45MTcgMTguOTMxOUMxMTkuOTcyIDE5LjA2NTMgMTIwLjAxNCAxOS4yMDQgMTIwLjA1NiAxOS4zNDI2QzEyMC4wOTIgMTkuNDU1MSAxMjAuMTI0IDE5LjU3MDIgMTIwLjE1MiAxOS42ODUzQzEyMC4xNjggMTkuNzQ1NSAxMjAuMTc2IDE5LjgwODMgMTIwLjE4NiAxOS44NzFDMTIwLjIwMiAxOS45NDY5IDEyMC4yMTUgMjAuMDIyOCAxMjAuMjMxIDIwLjEwMTJDMTIwLjIzMyAyMC4xMDkxIDEyMC4yMzMgMjAuMTE5NiAxMjAuMjM2IDIwLjEyNzRDMTIwLjI0NCAyMC4xOTU0IDEyMC4yNTcgMjAuMjY2MSAxMjAuMjYgMjAuMzM0MUMxMjAuMjY1IDIwLjU2OTUgMTIwLjMwMSAyMC44MDIzIDEyMC4yNzMgMjEuMDM3OEMxMjAuMjY3IDIxLjA3OTYgMTIwLjI3IDIxLjEyMTUgMTIwLjI2NyAyMS4xNjA3QzEyMC4yNTcgMjEuMjkxNSAxMjAuMjUyIDIxLjQyMjMgMTIwLjIzMyAyMS41NTA1QzEyMC4yMTggMjEuNjc2MSAxMjAuMTg5IDIxLjc5NjQgMTIwLjE2NSAyMS45MjJDMTIwLjE0NyAyMi4wMTYyIDEyMC4xMjkgMjIuMTEyOSAxMjAuMTA1IDIyLjIwNzFDMTIwLjA3NiAyMi4zMTQ0IDEyMC4wNDUgMjIuNDE5IDEyMC4wMDggMjIuNTIzN0MxMTkuOTY3IDIyLjY0OTIgMTE5LjkyMiAyMi43NzIyIDExOS44NzUgMjIuODk1MUMxMTkuNzcgMjMuMTY0NiAxMTkuNjQyIDIzLjQyMDkgMTE5LjQ5IDIzLjY2OTVDMTE5LjAwNyAyNC40NTQzIDExOC4zMzkgMjUuMDM1IDExNy41MSAyNS40M0MxMTcuMjIyIDI1LjU2ODcgMTE2LjkyNCAyNS42ODEyIDExNi42MTggMjUuNzY3NUMxMTYuNDE0IDI1LjgyMjQgMTE2LjIwNyAyNS44Nzc0IDExNS45OTggMjUuOTIxOEMxMTUuODI4IDI1Ljk1ODUgMTE1LjY1OCAyNS45OTI1IDExNS40ODUgMjYuMDE2QzExNS4xMzcgMjYuMDYwNSAxMTQuNzg3IDI2LjA5NDUgMTE0LjQzNiAyNi4wNjgzQzExNC4xOSAyNi4wNSAxMTMuOTQ3IDI2LjAyMzkgMTEzLjcwNCAyNS45ODk5QzExMy40NzYgMjUuOTU1OCAxMTMuMjQ5IDI1LjkxNjYgMTEzLjAyNCAyNS44NjE3QzExMi40ODcgMjUuNzMzNSAxMTEuOTcyIDI1LjU1MDQgMTExLjUwNCAyNS4yNDk1QzExMS4wNDEgMjQuOTQ4NyAxMTAuNjQzIDI0LjU4MjQgMTEwLjMwNiAyNC4xNDU2QzExMC4wODkgMjMuODYwNCAxMDkuOTA1IDIzLjU1NDQgMTA5Ljc1MSAyMy4yM0MxMDkuNjY3IDIzLjA1MjEgMTA5LjU5NCAyMi44NzE2IDEwOS41MjkgMjIuNjg1OUMxMDkuNDkyIDIyLjU4OTEgMTA5LjQ2OSAyMi40ODcgMTA5LjQ0IDIyLjM4NzZDMTA5LjQwNiAyMi4yNjk5IDEwOS4zNzQgMjIuMTQ5NiAxMDkuMzQ2IDIyLjAzMTlDMTA5LjMzIDIxLjk3MTcgMTA5LjMyMiAyMS45MDg5IDEwOS4zMTIgMjEuODQ2MUMxMDkuMjk5IDIxLjc3MDMgMTA5LjI4MyAyMS42OTE4IDEwOS4yNyAyMS42MTU5QzEwOS4yNyAyMS42MTA3IDEwOS4yNjcgMjEuNjAyOCAxMDkuMjY1IDIxLjU5NzZDMTA5LjI1NCAyMS40OTMgMTA5LjI0MSAyMS4zODU3IDEwOS4yMzMgMjEuMjgxMUMxMDkuMjIzIDIxLjEwMzIgMTA5LjIxIDIwLjkyNTMgMTA5LjIxMiAyMC43NDc0QzEwOS4yMTIgMjAuNTk1NyAxMDkuMjI1IDIwLjQ0MzkgMTA5LjI0MSAyMC4yOTIyQzEwOS4yNTEgMjAuMTc3MSAxMDkuMjcgMjAuMDY0NiAxMDkuMjkzIDE5Ljk1MjFDMTA5LjMyIDE5LjgyNCAxMDkuMzU0IDE5LjY5NTggMTA5LjM4OCAxOS41Njc2QzEwOS40MTkgMTkuNDUyNSAxMDkuNDU4IDE5LjM0MjYgMTA5LjQ5NSAxOS4yMzAxQzEwOS41NTIgMTkuMDU0OCAxMDkuNjI4IDE4Ljg4NDggMTA5LjcxNSAxOC43MkMxMTAuMDI4IDE4LjExMDUgMTEwLjQ0NCAxNy41Nzk0IDExMC45NTcgMTcuMTI0MkMxMTEuMzg5IDE2LjczOTcgMTExLjg2NyAxNi40MzM2IDExMi4zOTkgMTYuMjA2QzExMi42NDIgMTYuMTAxNCAxMTIuODkzIDE2LjAxNzcgMTEzLjE1MiAxNS45NTc1QzExMy4zODUgMTUuOTA1MiAxMTMuNjIgMTUuODYwNyAxMTMuODU4IDE1LjgyOTNDMTE0LjE2NCAxNS43Nzk2IDExNC40NzYgMTUuNzY5MiAxMTQuNzg3IDE1Ljc3MThaTTExNi42NjUgMjEuMjUyM0MxMTYuNjYzIDIxLjI1MjMgMTE2LjY2IDIxLjI1MjMgMTE2LjY1NyAyMS4yNTIzQzExNi42NTcgMjEuMDE5NSAxMTYuNjYgMjAuNzg2NiAxMTYuNjU3IDIwLjU1MzhDMTE2LjY1NSAyMC4zNzU5IDExNi42MzkgMjAuMTk4IDExNi42MjkgMjAuMDIwMkMxMTYuNjI5IDIwLjAwOTcgMTE2LjYyNiAxOS45OTkyIDExNi42MjMgMTkuOTg4OEMxMTYuNjA4IDE5LjkwNSAxMTYuNTk1IDE5LjgyMTMgMTE2LjU3OSAxOS43NDAyQzExNi41NjEgMTkuNjQzNCAxMTYuNTQ4IDE5LjU0NCAxMTYuNTE5IDE5LjQ0NzJDMTE2LjQ3OSAxOS4zMDYgMTE2LjQzIDE5LjE2NzMgMTE2LjM3MiAxOS4wMzM5QzExNi4yNTIgMTguNzUxNCAxMTYuMDg3IDE4LjQ5NzYgMTE1Ljg3IDE4LjI3NzlDMTE1LjcwOCAxOC4xMTMxIDExNS41MjIgMTcuOTgyMyAxMTUuMzA4IDE3Ljg5ODZDMTE1LjA0NiAxNy43OTY2IDExNC43NzEgMTcuNzcwNCAxMTQuNDk0IDE3Ljc3M0MxMTQuNDI2IDE3Ljc3MyAxMTQuMzU1IDE3Ljc4MDkgMTE0LjI4NyAxNy43OTM5QzExNC4xNDMgMTcuODI1MyAxMTQuMDA3IDE3Ljg3NzcgMTEzLjg4NCAxNy45NTYxQzExMy41OTEgMTguMTQ0NSAxMTMuMzY2IDE4LjM5MyAxMTMuMjA3IDE4LjY5OTFDMTEzLjA4NCAxOC45MzE5IDExMi45OSAxOS4xNzc4IDExMi45NCAxOS40Mzk0QzExMi45MTQgMTkuNTcwMiAxMTIuODg1IDE5LjcwMzYgMTEyLjg2OSAxOS44MzQ0QzExMi44NTEgMjAuMDIwMiAxMTIuODMgMjAuMjA1OSAxMTIuODMzIDIwLjM5NDJDMTEyLjgzMyAyMC41MDQxIDExMi44MjUgMjAuNjExNCAxMTIuODIyIDIwLjcyMTJDMTEyLjgyIDIwLjgyODUgMTEyLjgxMiAyMC45MzU3IDExMi44MjIgMjEuMDQwNEMxMTIuODQzIDIxLjIyODcgMTEyLjgzMyAyMS40MTk3IDExMi44NTkgMjEuNjA4MUMxMTIuODc3IDIxLjczMzYgMTEyLjg5IDIxLjg2MTggMTEyLjkxNCAyMS45ODc0QzExMi45MzUgMjIuMTA3NyAxMTIuOTU4IDIyLjIyODEgMTEyLjk5NSAyMi4zNDg0QzExMy4wMzQgMjIuNDgxOCAxMTMuMDY2IDIyLjYxNTIgMTEzLjExIDIyLjc0NkMxMTMuMTYyIDIyLjkwMDQgMTEzLjIzIDIzLjA0OTUgMTEzLjMxNCAyMy4xOTA3QzExMy40MjcgMjMuMzc5MSAxMTMuNTYzIDIzLjU0OTEgMTEzLjc0NiAyMy42NzczQzExNC4xMiAyMy45MzM3IDExNC41MzYgMjQuMDYxOSAxMTQuOTg4IDI0LjA2OTdDMTE1LjE2NiAyNC4wNzIzIDExNS4zMzQgMjQuMDM1NyAxMTUuNDk4IDIzLjk3MjlDMTE1LjgxIDIzLjg1MjYgMTE2LjA1MyAyMy42NDU5IDExNi4yNDQgMjMuMzc2NUMxMTYuNDA0IDIzLjE1MTUgMTE2LjUgMjIuOTAwNCAxMTYuNTU4IDIyLjYzMDlDMTE2LjU2OCAyMi41ODEyIDExNi41ODIgMjIuNTI4OSAxMTYuNTg5IDIyLjQ3OTJDMTE2LjYwNSAyMi4zOTI5IDExNi42MjYgMjIuMzAzOSAxMTYuNjMxIDIyLjIxNUMxMTYuNjQyIDIxLjg5MzIgMTE2LjY1MiAyMS41NzQxIDExNi42NjUgMjEuMjUyM1oiIGZpbGw9IiNlZTYyMTYiLz4KPHBhdGggZD0iTTEyNi4zOTQgMTUuNzcxOEMxMjYuNjY2IDE1Ljc2MzkgMTI2LjkzNiAxNS43NzcgMTI3LjIwMyAxNS44MDU4QzEyNy40MDcgMTUuODI5MyAxMjcuNjExIDE1Ljg2MzMgMTI3LjgxNSAxNS45QzEyNy45NTEgMTUuOTIzNSAxMjguMDkgMTUuOTUyMyAxMjguMjIzIDE1Ljk4ODlDMTI4LjQ2NCAxNi4wNTQzIDEyOC42OTkgMTYuMTM4IDEyOC45MjcgMTYuMjRDMTI5LjM5NSAxNi40NDY3IDEyOS44MjQgMTYuNzE2MSAxMzAuMjA2IDE3LjA1MUMxMzAuNjAxIDE3LjM5NjMgMTMwLjkyOCAxNy43OTkyIDEzMS4xOTIgMTguMjU0NEMxMzEuMzIgMTguNDcxNSAxMzEuNDMgMTguNjk5MSAxMzEuNTI0IDE4LjkzMTlDMTMxLjU3OSAxOS4wNjUzIDEzMS42MjEgMTkuMjA0IDEzMS42NjMgMTkuMzQyNkMxMzEuNyAxOS40NTUxIDEzMS43MzEgMTkuNTcwMiAxMzEuNzYgMTkuNjg1M0MxMzEuNzc1IDE5Ljc0NTUgMTMxLjc4MyAxOS44MDgzIDEzMS43OTQgMTkuODcxQzEzMS44MDkgMTkuOTQ2OSAxMzEuODIzIDIwLjAyMjggMTMxLjgzOCAyMC4xMDEyQzEzMS44NDEgMjAuMTA5MSAxMzEuODQxIDIwLjExOTYgMTMxLjg0MyAyMC4xMjc0QzEzMS44NTEgMjAuMTk1NCAxMzEuODY0IDIwLjI2NjEgMTMxLjg2NyAyMC4zMzQxQzEzMS44NzIgMjAuNTY5NSAxMzEuOTA5IDIwLjgwMjMgMTMxLjg4IDIxLjAzNzhDMTMxLjg3NSAyMS4wNzk2IDEzMS44NzcgMjEuMTIxNSAxMzEuODc1IDIxLjE2MDdDMTMxLjg2NCAyMS4yOTE1IDEzMS44NTkgMjEuNDIyMyAxMzEuODQxIDIxLjU1MDVDMTMxLjgyNSAyMS42NzYxIDEzMS43OTYgMjEuNzk2NCAxMzEuNzczIDIxLjkyMkMxMzEuNzU1IDIyLjAxNjIgMTMxLjczNiAyMi4xMTI5IDEzMS43MTMgMjIuMjA3MUMxMzEuNjg0IDIyLjMxNDQgMTMxLjY1MyAyMi40MTkgMTMxLjYxNiAyMi41MjM3QzEzMS41NzQgMjIuNjQ5MiAxMzEuNTMgMjIuNzcyMiAxMzEuNDgyIDIyLjg5NTFDMTMxLjM3OCAyMy4xNjQ2IDEzMS4yNSAyMy40MjA5IDEzMS4wOTggMjMuNjY5NUMxMzAuNjE0IDI0LjQ1NDMgMTI5Ljk0NyAyNS4wMzUgMTI5LjExOCAyNS40M0MxMjguODMgMjUuNTY4NyAxMjguNTMyIDI1LjY4MTIgMTI4LjIyNiAyNS43Njc1QzEyOC4wMjIgMjUuODIyNCAxMjcuODE1IDI1Ljg3NzQgMTI3LjYwNiAyNS45MjE4QzEyNy40MzYgMjUuOTU4NSAxMjcuMjY1IDI1Ljk5MjUgMTI3LjA5MyAyNi4wMTZDMTI2Ljc0NSAyNi4wNjA1IDEyNi4zOTQgMjYuMDk0NSAxMjYuMDQ0IDI2LjA2ODNDMTI1Ljc5OCAyNi4wNSAxMjUuNTU1IDI2LjAyMzkgMTI1LjMxMSAyNS45ODk5QzEyNS4wODQgMjUuOTU1OCAxMjQuODU2IDI1LjkxNjYgMTI0LjYzMSAyNS44NjE3QzEyNC4wOTUgMjUuNzMzNSAxMjMuNTggMjUuNTUwNCAxMjMuMTExIDI1LjI0OTVDMTIyLjY0OCAyNC45NDg3IDEyMi4yNTEgMjQuNTgyNCAxMjEuOTEzIDI0LjE0NTZDMTIxLjY5NiAyMy44NjA0IDEyMS41MTMgMjMuNTU0NCAxMjEuMzU5IDIzLjIzQzEyMS4yNzUgMjMuMDUyMSAxMjEuMjAyIDIyLjg3MTYgMTIxLjEzNiAyMi42ODU5QzEyMS4xIDIyLjU4OTEgMTIxLjA3NiAyMi40ODcgMTIxLjA0NyAyMi4zODc2QzEyMS4wMTMgMjIuMjY5OSAxMjAuOTgyIDIyLjE0OTYgMTIwLjk1MyAyMi4wMzE5QzEyMC45MzcgMjEuOTcxNyAxMjAuOTMgMjEuOTA4OSAxMjAuOTE5IDIxLjg0NjFDMTIwLjkwNiAyMS43NzAzIDEyMC44OSAyMS42OTE4IDEyMC44NzcgMjEuNjE1OUMxMjAuODc3IDIxLjYxMDcgMTIwLjg3NSAyMS42MDI4IDEyMC44NzIgMjEuNTk3NkMxMjAuODYyIDIxLjQ5MyAxMjAuODQ4IDIxLjM4NTcgMTIwLjg0MSAyMS4yODExQzEyMC44MyAyMS4xMDMyIDEyMC44MTcgMjAuOTI1MyAxMjAuODIgMjAuNzQ3NEMxMjAuODIgMjAuNTk1NyAxMjAuODMzIDIwLjQ0MzkgMTIwLjg0OCAyMC4yOTIyQzEyMC44NTkgMjAuMTc3MSAxMjAuODc3IDIwLjA2NDYgMTIwLjkwMSAxOS45NTIxQzEyMC45MjcgMTkuODI0IDEyMC45NjEgMTkuNjk1OCAxMjAuOTk1IDE5LjU2NzZDMTIxLjAyNiAxOS40NTI1IDEyMS4wNjYgMTkuMzQyNiAxMjEuMTAyIDE5LjIzMDFDMTIxLjE2IDE5LjA1NDggMTIxLjIzNiAxOC44ODQ4IDEyMS4zMjIgMTguNzJDMTIxLjYzNiAxOC4xMTA1IDEyMi4wNTIgMTcuNTc5NCAxMjIuNTY1IDE3LjEyNDJDMTIyLjk5NiAxNi43Mzk3IDEyMy40NzUgMTYuNDMzNiAxMjQuMDA2IDE2LjIwNkMxMjQuMjQ5IDE2LjEwMTQgMTI0LjUgMTYuMDE3NyAxMjQuNzU5IDE1Ljk1NzVDMTI0Ljk5MiAxNS45MDUyIDEyNS4yMjggMTUuODYwNyAxMjUuNDY2IDE1LjgyOTNDMTI1Ljc3MiAxNS43Nzk2IDEyNi4wODMgMTUuNzY5MiAxMjYuMzk0IDE1Ljc3MThaTTEyOC4yNzMgMjEuMjUyM0MxMjguMjcgMjEuMjUyMyAxMjguMjY3IDIxLjI1MjMgMTI4LjI2NSAyMS4yNTIzQzEyOC4yNjUgMjEuMDE5NSAxMjguMjY3IDIwLjc4NjYgMTI4LjI2NSAyMC41NTM4QzEyOC4yNjIgMjAuMzc1OSAxMjguMjQ2IDIwLjE5OCAxMjguMjM2IDIwLjAyMDJDMTI4LjIzNiAyMC4wMDk3IDEyOC4yMzMgMTkuOTk5MiAxMjguMjMxIDE5Ljk4ODhDMTI4LjIxNSAxOS45MDUgMTI4LjIwMiAxOS44MjEzIDEyOC4xODYgMTkuNzQwMkMxMjguMTY4IDE5LjY0MzQgMTI4LjE1NSAxOS41NDQgMTI4LjEyNiAxOS40NDcyQzEyOC4wODcgMTkuMzA2IDEyOC4wMzcgMTkuMTY3MyAxMjcuOTggMTkuMDMzOUMxMjcuODU5IDE4Ljc1MTQgMTI3LjY5NSAxOC40OTc2IDEyNy40NzcgMTguMjc3OUMxMjcuMzE1IDE4LjExMzEgMTI3LjEyOSAxNy45ODIzIDEyNi45MTUgMTcuODk4NkMxMjYuNjUzIDE3Ljc5NjYgMTI2LjM3OSAxNy43NzA0IDEyNi4xMDEgMTcuNzczQzEyNi4wMzMgMTcuNzczIDEyNS45NjMgMTcuNzgwOSAxMjUuODk1IDE3Ljc5MzlDMTI1Ljc1MSAxNy44MjUzIDEyNS42MTUgMTcuODc3NyAxMjUuNDkyIDE3Ljk1NjFDMTI1LjE5OSAxOC4xNDQ1IDEyNC45NzQgMTguMzkzIDEyNC44MTQgMTguNjk5MUMxMjQuNjkxIDE4LjkzMTkgMTI0LjU5NyAxOS4xNzc4IDEyNC41NDcgMTkuNDM5NEMxMjQuNTIxIDE5LjU3MDIgMTI0LjQ5MyAxOS43MDM2IDEyNC40NzcgMTkuODM0NEMxMjQuNDU5IDIwLjAyMDIgMTI0LjQzOCAyMC4yMDU5IDEyNC40NCAyMC4zOTQyQzEyNC40NCAyMC41MDQxIDEyNC40MzIgMjAuNjExNCAxMjQuNDMgMjAuNzIxMkMxMjQuNDI3IDIwLjgyODUgMTI0LjQxOSAyMC45MzU3IDEyNC40MyAyMS4wNDA0QzEyNC40NTEgMjEuMjI4NyAxMjQuNDQgMjEuNDE5NyAxMjQuNDY2IDIxLjYwODFDMTI0LjQ4NSAyMS43MzM2IDEyNC40OTggMjEuODYxOCAxMjQuNTIxIDIxLjk4NzRDMTI0LjU0MiAyMi4xMDc3IDEyNC41NjYgMjIuMjI4MSAxMjQuNjAyIDIyLjM0ODRDMTI0LjY0MiAyMi40ODE4IDEyNC42NzMgMjIuNjE1MiAxMjQuNzE4IDIyLjc0NkMxMjQuNzcgMjIuOTAwNCAxMjQuODM4IDIzLjA0OTUgMTI0LjkyMiAyMy4xOTA3QzEyNS4wMzQgMjMuMzc5MSAxMjUuMTcgMjMuNTQ5MSAxMjUuMzUzIDIzLjY3NzNDMTI1LjcyNyAyMy45MzM3IDEyNi4xNDMgMjQuMDYxOSAxMjYuNTk2IDI0LjA2OTdDMTI2Ljc3NCAyNC4wNzIzIDEyNi45NDEgMjQuMDM1NyAxMjcuMTA2IDIzLjk3MjlDMTI3LjQxNyAyMy44NTI2IDEyNy42NjEgMjMuNjQ1OSAxMjcuODUxIDIzLjM3NjVDMTI4LjAxMSAyMy4xNTE1IDEyOC4xMDggMjIuOTAwNCAxMjguMTY1IDIyLjYzMDlDMTI4LjE3NiAyMi41ODEyIDEyOC4xODkgMjIuNTI4OSAxMjguMTk3IDIyLjQ3OTJDMTI4LjIxMiAyMi4zOTI5IDEyOC4yMzMgMjIuMzAzOSAxMjguMjM5IDIyLjIxNUMxMjguMjQ5IDIxLjg5MzIgMTI4LjI2IDIxLjU3NDEgMTI4LjI3MyAyMS4yNTIzWiIgZmlsbD0iI2VlNjIxNiIvPgo8cGF0aCBkPSJNMTMyLjEwOCAyNS43MjY0QzEzMi4yMjkgMjUuNjE5OSAxMzIuMzM1IDI1LjUxMzQgMTMyLjQ0MiAyNS4zOTM2QzEzMi41NjIgMjUuMjYwNSAxMzIuNjU2IDI1LjExNCAxMzIuNzM2IDI0Ljk1NDNDMTMyLjgwMyAyNC44MjEyIDEzMi44NDMgMjQuNjYxNSAxMzIuODY5IDI0LjUxNUMxMzIuOTEgMjQuMjYyMSAxMzIuOTEgMjQuMDA5MiAxMzIuOTEgMjMuNzQzQzEzMi45MSAyMi40Nzg0IDEzMi45MSAyMS4yMjcxIDEzMi45MSAxOS45NjI2QzEzMi45MSAxOS40NTY4IDEzMi44OTYgMTguOTUwOSAxMzIuOTEgMTguNDQ1MUMxMzIuOTEgMTguMTc4OSAxMzIuOTIzIDE3LjkxMjYgMTMyLjg5NiAxNy42NDY0QzEzMi44ODMgMTcuNDA2OCAxMzIuODQzIDE3LjE2NzIgMTMyLjc0OSAxNi45NTQyQzEzMi42NTYgMTYuNzU0NiAxMzIuNTA5IDE2LjU2ODIgMTMyLjM3NSAxNi4zOTUyQzEzMi4yOTUgMTYuMjg4NyAxMzIuMjE1IDE2LjE5NTUgMTMyLjEzNSAxNi4xMDIzQzEzMi4zMjIgMTYuMTAyMyAxMzIuNTIyIDE2LjExNTYgMTMyLjcwOSAxNi4xMTU2QzEzMy4xNjMgMTYuMTI4OSAxMzMuNjA0IDE2LjEyODkgMTM0LjA1OCAxNi4xMjg5QzEzNC40NTggMTYuMTI4OSAxMzQuODU5IDE2LjExNTYgMTM1LjI1OSAxNi4wNzU3QzEzNS40NzMgMTYuMDYyNCAxMzUuNjg3IDE2LjAzNTggMTM1LjkgMTUuOTgyNUMxMzYuMTI3IDE1LjkyOTMgMTM2LjM1NCAxNS44NjI3IDEzNi41ODEgMTUuNzY5NUMxMzYuNTgxIDE2LjE0MjIgMTM2LjU4MSAxNi41MTUgMTM2LjU4MSAxNi44NzQ0QzEzNi42MjEgMTYuODg3NyAxMzYuNjQ4IDE2Ljg4NzcgMTM2LjY4OCAxNi44NzQ0QzEzNi43MjggMTYuODYxMSAxMzYuNzY4IDE2LjgzNDQgMTM2LjgwOCAxNi44MDc4QzEzNi45OTUgMTYuNjYxNCAxMzcuMTQyIDE2LjQ3NSAxMzcuMzE2IDE2LjM0MTlDMTM3LjUyOSAxNi4xNjg5IDEzNy43OTYgMTYuMDQ5MSAxMzguMDYzIDE1Ljk2OTJDMTM4LjQxMSAxNS44NjI3IDEzOC43NTggMTUuODIyOCAxMzkuMTMyIDE1LjgyMjhDMTM5LjU5OSAxNS44MjI4IDE0MC4wOCAxNS44NzYgMTQwLjQ1MyAxNi4wNDkxQzE0MC42NCAxNi4xNDIyIDE0MC44MDEgMTYuMjYyMSAxNDAuOTg3IDE2LjQyMThDMTQxLjE4OCAxNi41OTQ4IDE0MS40NDEgMTYuODA3OCAxNDEuNjQyIDE2Ljk2NzVDMTQxLjgyOSAxNi43OTQ1IDE0Mi4wMjkgMTYuNjM0OCAxNDIuMjQzIDE2LjUwMTdDMTQyLjYwMyAxNi4yNzU0IDE0Mi45OSAxNi4xMDIzIDE0My40MDQgMTYuMDA5MUMxNDMuNzc4IDE1LjkxNiAxNDQuMTY1IDE1Ljg2MjcgMTQ0LjU1MiAxNS44NjI3QzE0NC45NjYgMTUuODQ5NCAxNDUuMzk0IDE1Ljg4OTMgMTQ1LjgwOCAxNS45ODI1QzE0Ni4zNTUgMTYuMTE1NiAxNDYuODc2IDE2LjM1NTIgMTQ3LjMwMyAxNi43MTQ2QzE0Ny41NTcgMTYuOTE0MyAxNDcuNzcgMTcuMTUzOSAxNDcuOTQ0IDE3LjQyMDFDMTQ4LjExNyAxNy42ODY0IDE0OC4yMzggMTcuOTkyNSAxNDguMjkxIDE4LjMxMkMxNDguMzMxIDE4LjU2NDkgMTQ4LjMzMSAxOC44MzExIDE0OC4zMzEgMTkuMDg0QzE0OC4zMzEgMTkuODQyOCAxNDguMzMxIDIwLjU4ODIgMTQ4LjMzMSAyMS4zMzM2QzE0OC4zMzEgMjEuNjUzMSAxNDguMzMxIDIxLjk3MjYgMTQ4LjMzMSAyMi4zMDU0QzE0OC4zMzEgMjIuNjM4MSAxNDguMzMxIDIyLjk1NzYgMTQ4LjMzMSAyMy4yOTA0QzE0OC4zMzEgMjMuNTU2NiAxNDguMzMxIDIzLjgwOTUgMTQ4LjMzMSAyNC4wNzU4QzE0OC4zMzEgMjQuMzE1NCAxNDguMzQ0IDI0LjU2ODMgMTQ4LjQxMSAyNC43OTQ2QzE0OC40NzggMjUuMDA3NiAxNDguNjI1IDI1LjIwNzIgMTQ4Ljc1OCAyNS4zOTM2QzE0OC44MzggMjUuNTAwMSAxNDguOTMyIDI1LjYwNjYgMTQ5LjA5MiAyNS43Mzk3QzE0Ny4zNTYgMjUuNzM5NyAxNDUuNjIxIDI1LjczOTcgMTQzLjg3MiAyNS43Mzk3QzE0My45OTIgMjUuNjE5OSAxNDQuMDk4IDI1LjUwMDEgMTQ0LjIwNSAyNS4zODAzQzE0NC4zMTIgMjUuMjQ3MiAxNDQuNDA2IDI1LjEyNzQgMTQ0LjQ3MiAyNC45ODA5QzE0NC41MzkgMjQuODQ3OCAxNDQuNTY2IDI0LjY4ODEgMTQ0LjU5MyAyNC41MjgzQzE0NC42MDYgMjQuNDM1MiAxNDQuNjE5IDI0LjMyODcgMTQ0LjYxOSAyNC4yMzU1QzE0NC42MTkgMjQuMTQyMyAxNDQuNjE5IDI0LjA0OTEgMTQ0LjYxOSAyMy45NTZDMTQ0LjYwNiAyMy4xNDQgMTQ0LjYxOSAyMi4zMTg3IDE0NC42MTkgMjEuNTA2N0MxNDQuNjE5IDIxLjE0NzMgMTQ0LjYxOSAyMC44MDEyIDE0NC42MTkgMjAuNDQxOEMxNDQuNjE5IDIwLjA4MjQgMTQ0LjYzMyAxOS43MDk3IDE0NC42MTkgMTkuMzUwM0MxNDQuNjE5IDE5LjIxNzIgMTQ0LjYwNiAxOS4wOTczIDE0NC41OTMgMTguOTc3NUMxNDQuNTY2IDE4LjgxNzggMTQ0LjQ4NiAxOC42NTgxIDE0NC4zOTIgMTguNTI1QzE0NC4yODUgMTguMzc4NSAxNDQuMTUyIDE4LjI1ODcgMTQ0LjAwNSAxOC4xNzg5QzE0My44NDUgMTguMDk5IDE0My42NDUgMTguMDU5MSAxNDMuNDcxIDE4LjA3MjRDMTQzLjIzMSAxOC4wODU3IDE0My4wMDQgMTguMTkyMiAxNDIuODQzIDE4LjM1MTlDMTQyLjY5NyAxOC40OTgzIDE0Mi41OSAxOC42ODQ3IDE0Mi41MzYgMTguODg0NEMxNDIuNDk2IDE5LjA0NDEgMTQyLjQ5NiAxOS4yMDM4IDE0Mi40OTYgMTkuMzYzNkMxNDIuNDk2IDE5LjUxIDE0Mi40OTYgMTkuNjQzMSAxNDIuNDk2IDE5Ljc4OTVDMTQyLjQ5NiAyMC4xNzU2IDE0Mi40OTYgMjAuNTc0OSAxNDIuNDk2IDIwLjk2MDlDMTQyLjQ5NiAyMS45NDYgMTQyLjUxIDIyLjkzMSAxNDIuNDk2IDIzLjkwMjdDMTQyLjQ5NiAyNC4wMzU4IDE0Mi40OTYgMjQuMTgyMyAxNDIuNDk2IDI0LjMxNTRDMTQyLjUxIDI0LjUwMTcgMTQyLjUyMyAyNC43MDE0IDE0Mi42MDMgMjQuODc0NEMxNDIuNjgzIDI1LjA3NDEgMTQyLjgxNyAyNS4yNDcyIDE0Mi45NjQgMjUuNDIwMkMxNDMuMDU3IDI1LjU0IDE0My4xNjQgMjUuNjQ2NSAxNDMuMjcxIDI1Ljc1M0MxNDEuNTIyIDI1Ljc1MyAxMzkuNzg2IDI1Ljc1MyAxMzguMDM3IDI1Ljc1M0MxMzguMTU3IDI1LjYzMzIgMTM4LjI2NCAyNS41MTM0IDEzOC4zNyAyNS4zOTM2QzEzOC40NzcgMjUuMjYwNSAxMzguNTcxIDI1LjE0MDcgMTM4LjYzOCAyNC45OTQyQzEzOC43MDQgMjQuODYxMSAxMzguNzMxIDI0LjcwMTQgMTM4Ljc1OCAyNC41NDE3QzEzOC43NzEgMjQuNDQ4NSAxMzguNzg0IDI0LjM0MiAxMzguNzg0IDI0LjI0ODhDMTM4Ljc4NCAyNC4xNTU2IDEzOC43ODQgMjQuMDYyNCAxMzguNzg0IDIzLjk2OTNDMTM4Ljc3MSAyMy4xNTczIDEzOC43ODQgMjIuMzMyIDEzOC43ODQgMjEuNTJDMTM4Ljc4NCAyMS4xNjA2IDEzOC43ODQgMjAuODE0NSAxMzguNzg0IDIwLjQ1NTFDMTM4Ljc4NCAyMC4wOTU3IDEzOC43OTggMTkuNzIzIDEzOC43ODQgMTkuMzYzNkMxMzguNzg0IDE5LjIzMDUgMTM4Ljc3MSAxOS4xMTA3IDEzOC43NTggMTguOTkwOUMxMzguNzMxIDE4LjgzMTEgMTM4LjY1MSAxOC42NzE0IDEzOC41NTcgMTguNTM4M0MxMzguNDUxIDE4LjM5MTkgMTM4LjMxNyAxOC4yNzIxIDEzOC4xNyAxOC4xOTIyQzEzOC4wMSAxOC4xMTIzIDEzNy44MSAxOC4wNzI0IDEzNy42MzYgMTguMDg1N0MxMzcuMzk2IDE4LjA5OSAxMzcuMTY5IDE4LjIwNTUgMTM3LjAwOSAxOC4zNjUyQzEzNi44NjIgMTguNTExNyAxMzYuNzU1IDE4LjY5OCAxMzYuNzAxIDE4Ljg5NzdDMTM2LjY2MSAxOS4wNTc0IDEzNi42NjEgMTkuMjE3MSAxMzYuNjYxIDE5LjM3NjlDMTM2LjY2MSAxOS41MjMzIDEzNi42NjEgMTkuNjU2NCAxMzYuNjYxIDE5LjgwMjhDMTM2LjY2MSAyMC4xODg5IDEzNi42NjEgMjAuNTg4MiAxMzYuNjYxIDIwLjk3NDJDMTM2LjY2MSAyMS45NTkzIDEzNi42NzUgMjIuOTQ0MyAxMzYuNjYxIDIzLjkxNkMxMzYuNjYxIDI0LjA0OTEgMTM2LjY2MSAyNC4xOTU2IDEzNi42NjEgMjQuMzI4N0MxMzYuNjc1IDI0LjUxNSAxMzYuNjg4IDI0LjcxNDcgMTM2Ljc2OCAyNC44ODc3QzEzNi44NDggMjUuMDg3NCAxMzYuOTgyIDI1LjI2MDUgMTM3LjEyOSAyNS40MzM1QzEzNy4yMjIgMjUuNTUzMyAxMzcuMzI5IDI1LjY1OTggMTM3LjQzNiAyNS43NjYzQzEzNS42MDcgMjUuNzI2NCAxMzMuODU4IDI1LjcyNjQgMTMyLjEwOCAyNS43MjY0WiIgZmlsbD0iI2VlNjIxNiIvPgo8L3N2Zz4='.replace('data:image/svg+xml;base64,',''), 'base64');
    res.writeHead(200, {'Content-Type':'image/svg+xml','Cache-Control':'public,max-age=86400'});
    res.end(buf); return;
  }
  if (pathname === '/assets/logo-black.svg') {
    const buf = Buffer.from('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMTUwIiBoZWlnaHQ9IjMxIiB2aWV3Qm94PSIwIDAgMTUwIDMxIiBmaWxsPSJub25lIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPgo8cGF0aCBkPSJNNDMuNzg4NiAxNC45NjdDNDMuNjI0MiAxNC43OTgzIDQzLjUwOTEgMTQuNTQ1MSA0My40NTk4IDE0LjMwODhDNDMuMzYxMSAxMy44MzYzIDQzLjQ3NjIgMTMuMzYzNyA0My42NzM2IDEyLjk0MThDNDQuMDAyNCAxMi4yNDk4IDQ0LjU5NDMgMTEuNzA5OCA0NS4yNTIgMTEuMzcyM0M0NS43NDUzIDExLjEzNiA0Ni4yODc5IDExLjAwMSA0Ni44MzA1IDExLjA1MTZDNDcuMjQxNiAxMS4xMDIyIDQ3LjY2OTEgMTEuMjU0MSA0Ny45NDg2IDExLjU0MUM0OC4xMjk1IDExLjcyNjcgNDguMjYxMSAxMS45Nzk4IDQ4LjMyNjggMTIuMjMzQzQ4LjQ0MTkgMTIuNzM5MyA0OC4zMTA0IDEzLjMzIDQ4LjAzMDkgMTMuNzY4OEM0Ny43NTEzIDE0LjIyNDQgNDcuMzA3NCAxNC41MjgyIDQ2Ljg0NyAxNC43ODE0QzQ2LjI3MTUgMTUuMDg1MiA0NS42Nzk2IDE1LjMwNDYgNDUuMDA1NCAxNS4zMzgzQzQ0LjU3NzkgMTUuMzU1MiA0NC4wODQ2IDE1LjI4NzcgNDMuNzg4NiAxNC45NjdaIiBmaWxsPSIjMjYyNjI2Ii8+CjxwYXRoIGQ9Ik0zMi4xMzc3IDEyLjM1MjdDMzIuMjIxNCAxMi4zMzYxIDMyLjMyMTggMTIuMzE5NSAzMi4zODg3IDEyLjM1MjdDMzIuNTIyNSAxMi40MDI1IDMyLjU3MjggMTIuNTg1MSAzMi42MDYyIDEyLjczNDZDMzIuNjM5NyAxMi44Njc0IDMyLjY1NjQgMTIuOTgzNiAzMi42NzMxIDEzLjA5OTlDMzIuNzA2NiAxMy40MTU0IDMyLjc0MDEgMTMuNzQ3NSAzMi43NTY4IDE0LjA3OTVDMzIuODIzNyAxNC45NTk2IDMyLjg0MDUgMTUuODIzIDMyLjg3MzkgMTYuNjg2NEMzMi45MDc0IDE4LjE2NDIgMzIuOTQwOSAxOS42NDIgMzIuOTI0MSAyMS4xMTk4QzMyLjkyNDEgMjEuODY3IDMyLjkwNzQgMjIuNTk3NiAzMi44OTA3IDIzLjM0NDhDMzIuODkwNyAyMy42MTA1IDMyLjg5MDcgMjMuODc2MSAzMi44NzM5IDI0LjE0MThDMzIuODU3MiAyNC4zMDc4IDMyLjg1NzIgMjQuNDkwNSAzMi44MjM3IDI0LjY1NjVDMzIuODA3IDI0LjgyMjYgMzIuNzU2OCAyNC45ODg2IDMyLjY4OTkgMjUuMTIxNUMzMi42MjMgMjUuMjcwOSAzMi41MDU4IDI1LjQwMzcgMzIuMzg4NyAyNS41MkMzMi4zMDUgMjUuNjAzIDMyLjIyMTQgMjUuNjg2IDMyLjEzNzcgMjUuNzY5QzMzLjg3NzkgMjUuNzY5IDM1LjYwMTQgMjUuNzY5IDM3LjM0MTYgMjUuNzY5QzM3LjIwNzcgMjUuNjUyOCAzNy4wOTA2IDI1LjUyIDM2Ljk3MzUgMjUuMzg3MUMzNi44NTYzIDI1LjI1NDMgMzYuNzU1OSAyNS4xMDQ5IDM2LjcwNTcgMjQuOTM4OEMzNi42NTU1IDI0Ljc1NjIgMzYuNjM4OCAyNC41NzM1IDM2LjYzODggMjQuMzkwOUMzNi42Mzg4IDIzLjk5MjQgMzYuNjM4OCAyMy42MTA1IDM2LjY1NTUgMjMuMjI4NkMzNi42NzIzIDIyLjQ4MTQgMzYuNjU1NSAyMS43MTc2IDM2LjY1NTUgMjAuOTcwNEMzNi42NTU1IDIwLjUzODYgMzYuNjcyMyAyMC4xMjM1IDM2LjY1NTUgMTkuNjkxOEMzNi42NTU1IDE5LjU1OSAzNi42NTU1IDE5LjQyNjEgMzYuNjU1NSAxOS4yNzY3QzM2LjY3MjMgMTkuMTEwNyAzNi42ODkgMTguOTQ0NiAzNi43NTU5IDE4Ljc5NTJDMzYuODIyOSAxOC42NDU3IDM2LjkyMzMgMTguNTEyOSAzNy4wNDA0IDE4LjM5NjdDMzcuMjU3OSAxOC4xOTc0IDM3LjU1OTEgMTguMTE0NCAzNy44NjAzIDE4LjA5NzhDMzguMDc3OCAxOC4wOTc4IDM4LjI5NTQgMTguMTMxIDM4LjQ3OTQgMTguMjMwNkMzOC42ODAyIDE4LjMzMDMgMzguODQ3NSAxOC40OTYzIDM4Ljk0NzkgMTguNjk1NkMzOS4wNjUxIDE4LjkxMTQgMzkuMDk4NSAxOS4xNDM5IDM5LjExNTMgMTkuMzkyOUMzOS4xMzIgMTkuNTU5IDM5LjExNTMgMTkuNzI1IDM5LjExNTMgMTkuODkxMUMzOS4xMTUzIDIwLjIwNjYgMzkuMTE1MyAyMC41MDU0IDM5LjExNTMgMjAuODIwOUMzOS4xMTUzIDIxLjE4NjIgMzkuMTE1MyAyMS41NjgxIDM5LjExNTMgMjEuOTMzNEMzOS4xMTUzIDIyLjM2NTEgMzkuMTE1MyAyMi44MTM0IDM5LjExNTMgMjMuMjQ1MkMzOS4xMTUzIDIzLjYxMDUgMzkuMTE1MyAyMy45NTkxIDM5LjExNTMgMjQuMzI0NEMzOS4xMTUzIDI0LjQ3MzkgMzkuMTE1MyAyNC42MjMzIDM5LjA4MTggMjQuNzcyOEMzOS4wNDgzIDI0LjkzODggMzguOTY0NyAyNS4wODgyIDM4Ljg2NDMgMjUuMjIxMUMzOC43NDcxIDI1LjM4NzEgMzguNjMgMjUuNTM2NiAzOC40Nzk0IDI1LjY2OTRDMzguNDQ1OSAyNS43MDI2IDM4LjM5NTcgMjUuNzM1OCAzOC4zNjIzIDI1Ljc2OUM0MC44ODg5IDI1Ljc2OSA0My40MzIzIDI1Ljc2OSA0NS45NTkgMjUuNzY5QzQ2LjQ5NDQgMjUuNzY5IDQ3LjAxMzEgMjUuNzY5IDQ3LjU0ODYgMjUuNzY5QzQ3Ljk1MDIgMjUuNzY5IDQ4LjMzNSAyNS43NjkgNDguNzM2NiAyNS43NjlDNDguODcwNCAyNS43NjkgNDguOTg3NiAyNS43NjkgNDkuMTIxNCAyNS43NjlDNDkuMDcxMiAyNS42ODYgNDkuMDIxIDI1LjYwMyA0OC45NzA4IDI1LjUzNjZDNDguODg3MiAyNS40MjAzIDQ4Ljc3MDEgMjUuMzIwNyA0OC42ODY0IDI1LjIyMTFDNDguNjE5NSAyNS4xNTQ3IDQ4LjU2OTMgMjUuMDcxNiA0OC41MzU4IDI0Ljk4ODZDNDguNDM1NCAyNC43NTYyIDQ4LjQwMTkgMjQuNTA3MSA0OC4zODUyIDI0LjI1OEM0OC4zODUyIDI0LjE3NSA0OC4zNjg1IDI0LjA5MiA0OC4zNjg1IDI0LjAwOUM0OC4zNTE3IDIzLjgwOTcgNDguMzY4NSAyMy41OTM4IDQ4LjM2ODUgMjMuMzk0NkM0OC4zNjg1IDIzLjA0NTkgNDguMzY4NSAyMi43MTM4IDQ4LjM2ODUgMjIuMzY1MUM0OC4zNTE3IDIwLjgyMDkgNDguMzY4NSAxOS4yNjAxIDQ4LjM2ODUgMTcuNzE1OUM0OC4zNjg1IDE3LjU4MzEgNDguMzY4NSAxNy40NTAyIDQ4LjM2ODUgMTcuMzE3NEM0OC4zNjg1IDE3LjA2ODMgNDguMzg1MiAxNi44MTkzIDQ4LjQxODcgMTYuNTcwMkM0OC40MzU0IDE2LjQzNzQgNDguNDUyMSAxNi4zMDQ1IDQ4LjQ2ODkgMTYuMTU1MUM0OC40ODU2IDE2LjAyMjMgNDguNTAyMyAxNS44NzI4IDQ4LjQzNTQgMTUuNzU2NkM0OC4zODUyIDE1LjY1NyA0OC4yODQ4IDE1LjU5MDUgNDguMTY3NyAxNS41NTczQzQ4LjAzMzggMTUuNTI0MSA0Ny44ODMyIDE1LjU1NzMgNDcuNzQ5NCAxNS41OTA1QzQ3LjU0ODYgMTUuNjQwMyA0Ny4zODEyIDE1LjY3MzYgNDcuMTYzNyAxNS42OTAyQzQ3LjA2MzMgMTUuNzA2OCA0Ni45NDYyIDE1LjcwNjggNDYuODI5MSAxNS43MDY4QzQ2LjE1OTcgMTUuNzQgNDUuNTc0MSAxNS43NTY2IDQ0Ljk3MTcgMTUuNzU2NkM0NC43NTQyIDE1Ljc1NjYgNDQuNTUzNCAxNS43NTY2IDQ0LjMzNTkgMTUuNzU2NkM0NC4yMDIgMTUuNzU2NiA0NC4wNjgxIDE1Ljc1NjYgNDMuOTM0MyAxNS43NTY2QzQzLjg1MDYgMTUuNzU2NiA0My43NjcgMTUuNzU2NiA0My42ODMzIDE1Ljc3MzJDNDMuNjE2NCAxNS43ODk4IDQzLjU0OTQgMTUuNzg5OCA0My40OTkyIDE1LjgzOTZDNDMuNDMyMyAxNS45MDYgNDMuMzk4OCAxNi4wMDU2IDQzLjM5ODggMTYuMTA1M0M0My40MTU2IDE2LjI3MTMgNDMuNTE2IDE2LjM4NzUgNDMuNjE2NCAxNi41MDM4QzQzLjczMzUgMTYuNjUzMiA0My44MzM5IDE2Ljc4NiA0My45MTc2IDE2LjkxODlDNDMuOTY3OCAxNi45ODUzIDQ0LjAxOCAxNy4wNTE3IDQ0LjA1MTQgMTcuMjE3OEM0NC4wNjgxIDE3LjMzNCA0NC4wODQ5IDE3LjUxNjYgNDQuMTAxNiAxNy42NjYxQzQ0LjEzNTEgMTguMDQ4IDQ0LjExODQgMTguMTgwOCA0NC4xMTg0IDE4LjMzMDNDNDQuMTAxNiAxOS4wNDQyIDQ0LjExODQgMjAuMDU3MSA0NC4xMTg0IDIxLjA1MzRDNDQuMTE4NCAyMS4zODU1IDQ0LjExODQgMjEuNzAxIDQ0LjExODQgMjIuMDMzQzQ0LjExODQgMjIuNTQ3OCA0NC4xMTg0IDIzLjA0NTkgNDQuMTE4NCAyMy41NjA2QzQ0LjExODQgMjMuNjkzNSA0NC4xMTg0IDIzLjgyNjMgNDQuMTE4NCAyMy45NDI1QzQ0LjExODQgMjQuMDkyIDQ0LjEwMTYgMjQuMjQxNCA0NC4wNjgyIDI0LjM5MDlDNDQuMDM0NyAyNC41NTY5IDQ0LjAwMTIgMjQuNzA2MyA0My45MTc2IDI0Ljg3MjRDNDMuODE3MiAyNS4wNTUgNDMuNjY2NiAyNS4yNTQzIDQzLjUzMjcgMjUuMjU0M0M0My4zOTg4IDI1LjIzNzcgNDMuMjgxNyAyNS4wMzg0IDQzLjE5OCAyNC44NzI0QzQzLjEzMTEgMjQuNzIzIDQzLjA5NzYgMjQuNTkwMSA0My4wOTc2IDI0LjQ1NzNDNDMuMDgwOSAyNC4zMDc4IDQzLjA4MDkgMjQuMTI1MiA0My4wODA5IDIzLjk1OTFDNDMuMDgwOSAyMi44NjMzIDQzLjA4MDkgMjEuODAwNiA0My4wODA5IDIwLjczNzlDNDMuMDgwOSAyMC4zMDYyIDQzLjA4MDkgMTkuODU3OSA0My4wODA5IDE5LjQyNjFDNDMuMDgwOSAxOS4yNzY3IDQzLjA4MDkgMTkuMTQzOSA0My4wODA5IDE4Ljk5NDRDNDMuMDY0MiAxOC41NDYxIDQzLjAxNCAxOC4wOTc4IDQyLjg0NjcgMTcuNjgyN0M0Mi41NDU1IDE2Ljk2ODcgNDEuODkyOSAxNi4zODc1IDQxLjE1NjcgMTYuMDM4OUM0MC42NzE0IDE1LjgwNjQgNDAuMTUyNyAxNS42OTAyIDM5LjYxNzIgMTUuNjU3QzM4Ljk5ODEgMTUuNjIzNyAzOC4zNjIzIDE1LjcwNjggMzcuNzU5OSAxNS44NzI4QzM3LjQwODUgMTUuOTU1OCAzNy4wNzM5IDE2LjA3MjEgMzYuNzU1OSAxNi4yMDQ5QzM2Ljc1NTkgMTUuNDkwOSAzNi43NzI3IDE0Ljc3NjkgMzYuNzcyNyAxNC4wNzk1QzM2Ljc3MjcgMTMuNzgwNyAzNi43NzI3IDEzLjQ5ODQgMzYuNzg5NCAxMy4xOTk1QzM2Ljc4OTQgMTMuMDgzMyAzNi44MDYxIDEyLjk4MzYgMzYuODA2MSAxMi44Njc0QzM2LjgyMjkgMTIuNjY4MiAzNi44MjI5IDEyLjQ2ODkgMzYuODU2MyAxMi4yNjk3QzM2Ljg3MzEgMTIuMDcwNCAzNi45MDY1IDExLjg1NDUgMzYuODM5NiAxMS43MzgzQzM2LjgwNjEgMTEuNjcxOSAzNi43NTU5IDExLjYzODcgMzYuNjcyMyAxMS42MDU1QzM2LjUzODQgMTEuNTU1NyAzNi4zNzExIDExLjU4ODkgMzYuMjAzOCAxMS42MjIxQzM2LjA1MzIgMTEuNjU1MyAzNS45MTkzIDExLjY3MTkgMzUuNzY4NyAxMS43MDUxQzM1LjYwMTQgMTEuNzM4MyAzNS40MzQgMTEuNzM4MyAzNS4yNjY3IDExLjc1NDlDMzQuOTMyMSAxMS43NzE1IDM0LjYxNDIgMTEuNzcxNSAzNC4yNzk1IDExLjc3MTVDMzMuNjQzNyAxMS43ODgxIDMzLjAwNzggMTEuNzg4MSAzMi4zNzIgMTEuNzg4MUMzMi4yNTQ4IDExLjk3MDggMzIuMjA0NiAxMi4xNTM0IDMyLjEzNzcgMTIuMzUyN1oiIGZpbGw9IiMyNjI2MjYiLz4KPHBhdGggZD0iTTEyLjg0ODYgMTguMDkyOEMxMy40NDMgMTUuODc4NyAxNC4wMTM3IDEzLjY4ODMgMTQuNTM2OCAxMS40NzQyQzE0LjY1NTcgMTAuOTc0MiAxNC43NzQ2IDEwLjQ3NDMgMTQuODkzNSA5Ljk5ODExQzE1LjA2IDkuMzU1MjkgMTUuMjI2NCA4LjczNjI4IDE1LjM5MjkgOC4xMTcyN0MxNS41MTE3IDcuNjY0OTIgMTUuNjA2OSA3LjIxMjU3IDE1LjcyNTcgNi43NjAyMkMxNS43OTcxIDYuNDUwNzIgMTUuODY4NCA2LjE2NTAyIDE1LjkxNiA1Ljg1NTUxQzE1Ljk2MzUgNS41OTM2MiAxNi4wMTExIDUuMzU1NTUgMTYuMDExMSA1LjA5MzY2QzE2LjAxMTEgNC43ODQxNiAxNS45NjM1IDQuNDUwODQgMTUuODkyMiA0LjE0MTM0QzE1LjgyMDkgMy43ODQyMiAxNS43MjU3IDMuNDUwOSAxNS41ODMxIDMuMTE3NTlDMTUuMjc0IDIuMzA4MTIgMTQuNzc0NiAxLjU3MDA3IDE0LjE1NjQgMC45NzQ4NzNDMTYuOTg2IDAuOTc0ODczIDE5LjgzOTQgMC45NzQ4NzMgMjIuNjY5IDAuOTc0ODczQzIyLjU5NzYgMS4wOTM5MSAyMi41MjYzIDEuMjEyOTUgMjIuNTAyNSAxLjM1NThDMjIuNDMxMiAxLjYxNzY5IDIyLjQwNzQgMS44Nzk1OCAyMi40MDc0IDIuMTY1MjdDMjIuNDMxMiAyLjg3OTUxIDIyLjU3MzkgMy41Njk5NSAyMi43NjQxIDQuMjM2NTdDMjIuOTc4MSA1LjA0NjA0IDIzLjIxNTkgNS44NTU1MiAyMy40NTM3IDYuNjY0OTlDMjMuODEwMyA3Ljg1NTM5IDI0LjE5MDggOS4wNjk1OSAyNC41NDc1IDEwLjI2QzI1LjMwODQgMTIuNzU5OCAyNi4wMjE3IDE1LjI1OTcgMjYuNzM1IDE3Ljc1OTVDMjcuMzUzMyAxNS4zNTQ5IDI3Ljk5NTMgMTIuOTUwMyAyOC43MzI0IDEwLjU2OTVDMjguODUxMyAxMC4xNDEgMjguOTk0IDkuNzEyNDEgMjkuMTEyOSA5LjI4Mzg3QzI5LjMyNjkgOC41NDU4MiAyOS41MTcxIDcuNzgzOTYgMjkuNzMxMSA3LjA0NTkxQzI5Ljg3MzggNi41Njk3NSAzMC4wMTY0IDYuMDkzNTkgMzAuMTM1MyA1LjYxNzQzQzMwLjIzMDQgNS4xODg4OSAzMC4zMjU2IDQuNzYwMzUgMzAuMzQ5MyA0LjMzMThDMzAuMzczMSAzLjk5ODQ5IDMwLjM3MzEgMy42NjUxOCAzMC4zMjU2IDMuMzMxODdDMzAuMjU0MiAyLjkyNzEzIDMwLjA4NzggMi41MjI0IDI5Ljg3MzggMi4xNDE0N0MyOS43MDczIDEuODc5NTggMjkuNTQwOSAxLjYxNzY5IDI5LjMyNjkgMS4zNzk2MUMyOS4yMDggMS4yMTI5NiAyOS4wNjUzIDEuMDcwMTEgMjguOTIyNiAwLjkyNzI2MkMzMC42MzQ3IDAuOTI3MjYyIDMyLjMyMjkgMC45MjcyNjIgMzQuMDM1IDAuOTI3MjYyQzM0LjMyMDMgMC45MjcyNjIgMzQuNTgxOSAwLjkyNzI2MiAzNC44NjcyIDAuOTI3MjYyQzM1LjEyODggMC45MjcyNjIgMzUuMzY2NSAwLjkwMzQ1MSAzNS42MjgxIDAuOTk4NjgzQzM1LjY3NTcgMS4wMjI0OSAzNS43MjMyIDEuMDIyNDkgMzUuNzQ3IDEuMDQ2M0MzNS44NDIxIDEuMTQxNTMgMzUuNzcwOCAxLjMzMiAzNS43MjMyIDEuNDk4NjVDMzUuNjI4MSAxLjc4NDM1IDM1LjU1NjggMi4wMjI0MyAzNS40NjE3IDIuMjM2N0MzMy4zNDU0IDguNjY0ODYgMzAuOTQzOCAxNi40NzM5IDI4Ljc4IDIzLjYxNjNDMjguNjYxMSAyNC4wNDQ4IDI4LjUxODQgMjQuNDQ5NiAyOC4zOTk1IDI0Ljg3ODFDMjguMzI4MiAyNS4wOTI0IDI4LjI4MDYgMjUuMzA2NiAyOC4yMDkzIDI1LjQ5NzFDMjguMTYxNyAyNS42MTYxIDI4LjExNDIgMjUuNzM1MiAyOC4wNjY2IDI1Ljg1NDJDMjguMDE5MSAyNS45NzMzIDI3Ljk3MTUgMjYuMTE2MSAyNy44NzY0IDI2LjE2MzdDMjcuNzU3NSAyNi4yMzUyIDI3LjU2NzMgMjYuMTg3NSAyNy40MDA4IDI2LjEzOTlDMjYuODc3NyAyNS45OTcxIDI2LjQ5NzMgMjUuODU0MiAyNi4wNjkzIDI1LjY2MzhDMjUuMzU1OSAyNS4zNTQzIDI0LjU5NSAyNC45NzMzIDIzLjg4MTcgMjQuNTQ0OEMyMy4yODcyIDI0LjE4NzcgMjIuNjkyOCAyMy44MDY3IDIyLjI2NDcgMjMuMjgzQzIxLjkwODEgMjIuODU0NCAyMS42NzAzIDIyLjMzMDYgMjEuNDU2MyAyMS44MDY5QzIxLjA3NTggMjAuOTAyMiAyMC43OTA1IDE5Ljk3MzcgMjAuNDgxNCAxOS4wNDUxQzIwLjA3NzIgMTcuODA3MSAxOS42NzI5IDE2LjU0NTMgMTkuMjkyNSAxNS4zMDczQzE4Ljg4ODIgMTMuOTc0IDE4LjUwNzggMTIuNjQwOCAxOC4xNzQ5IDExLjI4MzdDMTcuOTg0NyAxMS45NTA0IDE3Ljc5NDQgMTIuNjQwOCAxNy42MDQyIDEzLjMwNzRDMTcuMjk1MSAxNC40MDI2IDE3LjAwOTggMTUuNDczOSAxNi43MjQ0IDE2LjU2OTFDMTYuNDYyOSAxNy41NjkgMTYuMjI1MSAxOC41NDUyIDE1Ljk2MzUgMTkuNTQ1MUMxNS43NDk1IDIwLjQwMjIgMTUuNTExNyAyMS4yNTkzIDE1LjI3NCAyMi4wOTI2QzE1LjEwNzUgMjIuNzExNiAxNC45NjQ4IDIzLjMzMDYgMTQuODIyMiAyMy45MjU4QzE0Ljc1MDggMjQuMjM1MyAxNC42NTU3IDI0LjU2ODYgMTQuNTg0NCAyNC44NzgxQzE0LjUzNjggMjUuMTE2MiAxNC40NjU1IDI1LjMzMDUgMTQuNDE3OSAyNS41Njg1QzE0LjM5NDIgMjUuNjYzOCAxNC4zNzA0IDI1LjczNTIgMTQuMzQ2NiAyNS44MDY2QzE0LjMyMjggMjUuODU0MiAxNC4yNzUzIDI1LjkwMTggMTQuMjI3NyAyNS45NDk1QzE0LjA4NTEgMjYuMDY4NSAxMy44NDczIDI2LjA0NDcgMTMuNjA5NSAyNS45OTcxQzEzLjAzODggMjUuODc4IDEyLjU2MzIgMjUuNzExNCAxMi4wODc3IDI1LjQ5NzFDMTEuMjMxNyAyNS4xNCAxMC4zNTE5IDI0LjY4NzYgOS41NDM0MSAyNC4xNDAxQzkuMTg2NzQgMjMuOTAyIDguODUzODQgMjMuNjE2MyA4LjU2ODUgMjMuMzA2OEM4LjE4ODA1IDIyLjkwMiA3Ljg1NTE2IDIyLjQwMjEgNy41OTM2IDIxLjkwMjFDNy4xMTgwMyAyMS4wMjEyIDYuODA4OTIgMjAuMDkyNyA2LjQ3NjAzIDE5LjE0MDRDNi4wOTU1NyAxOC4wNDUyIDUuNzE1MTIgMTYuOTczOCA1LjMzNDY3IDE1Ljg3ODdDNC40MDczMiAxMy4xNDA4IDMuNTk4ODYgMTAuMzU1MiAyLjk1Njg1IDcuNTQ1ODhDMi43OTA0IDYuODU1NDUgMi42NDc3MyA2LjE2NTAyIDIuNTI4ODQgNS40NzQ1OUMyLjQ4MTI5IDUuMjEyNyAyLjQzMzczIDQuOTc0NjIgMi4zNjIzOSA0LjcxMjczQzIuMjY3MjggNC40MDMyMyAyLjEyNDYyIDQuMTQxMzQgMS45ODE5NSAzLjg1NTY0QzEuNjQ5MDUgMy4xODkwMiAxLjMzOTkzIDIuNDk4NTkgMC44NjQzNjggMS45NTFDMC42NzQxNDIgMS43MzY3MyAwLjQ2MDEzNiAxLjUyMjQ2IDAuMjIyMzU0IDEuMzMxOTlDMC4xNTEwMTkgMS4yNjA1NyAwLjA3OTY4ODcgMS4yMTI5NSAwLjA1NTkxMDUgMS4xMTc3MkMwLjAwODM1NDEzIDEuMDIyNDkgLTAuMDE1NDI3IDAuOTI3MjYzIDAuMDA4MzUxMjMgMC44MzIwMzFDMS43Njc5NCAwLjgzMjAzMSAzLjUwMzc1IDAuODMyMDMxIDUuMjYzMzQgMC44MzIwMzFDNS45MjkxMiAwLjgzMjAzMSA2LjU3MTE0IDAuODMyMDMxIDcuMjEzMTUgMC44MzIwMzFDNy40MDMzOCAwLjgzMjAzMSA3LjU5MzYgMC44MzIwMzEgNy44MDc2MSAwLjgzMjAzMUM3Ljk1MDI3IDAuODMyMDMxIDguMDkyOTQgMC44MzIwMjcgOC4yMTE4MyAwLjg3OTY0M0M4LjMzMDcyIDAuOTI3MjU5IDguNDI1ODQgMS4wNDYzIDguNDk3MTcgMS4xODkxNUM4LjYxNjA2IDEuMzc5NjIgOC42NjM2MiAxLjYxNzY5IDguNzExMTcgMS44MzE5NkM4LjkyNTE4IDIuNzEyODYgOS4xNjI5NiAzLjU0NjE0IDkuNDI0NTIgNC4zNzk0MkMxMC43MzIzIDkuMDIxOTggMTEuNjgzNCAxMy41OTMxIDEyLjg0ODYgMTguMDkyOFoiIGZpbGw9IiMyNjI2MjYiLz4KPHBhdGggZD0iTTQ4LjY4OTUgMjMuMTUzOUM0OS4wMzg0IDIzLjM0NyA0OS40MjYgMjMuNTQwMSA0OS43NzQ5IDIzLjY5NDZDNTAuMDQ2MyAyMy44NDkgNTAuMzU2NCAyMy45NjQ5IDUwLjYyNzggMjQuMDgwN0M1MS4wMTU1IDI0LjE5NjYgNTEuNDAzMSAyNC4yNzM4IDUxLjc5MDggMjQuMzEyNEM1Mi4yOTQ4IDI0LjM4OTcgNTIuODM3NSAyNC40MjgzIDUzLjM0MTUgMjQuMjM1MkM1My41MzUzIDI0LjE1OCA1My43MjkyIDI0LjA4MDcgNTMuODQ1NSAyMy45MjYzQzUzLjkyMyAyMy43NzE4IDUzLjk2MTggMjMuNjE3MyA1My45NjE4IDIzLjQyNDJDNTMuOTYxOCAyMy4yNjk4IDUzLjg4NDIgMjMuMTE1MyA1My44MDY3IDIyLjk5OTRDNTMuNjkwNCAyMi44NDUgNTMuNDk2NiAyMi43Njc3IDUzLjMwMjcgMjIuNjkwNUM1Mi43OTg4IDIyLjQ1ODggNTIuMzMzNiAyMi4yMjcxIDUxLjg2ODMgMjEuOTk1NEM1MS40NDE5IDIxLjgwMjMgNTAuOTc2NyAyMS42MDkyIDUwLjU1MDMgMjEuMzc3NUM1MC4yNDAxIDIxLjE4NDQgNDkuOTMgMjAuOTkxMyA0OS42NTg2IDIwLjcyMUM0OS4zNDg1IDIwLjQxMjEgNDkuMTE1OSAyMC4wMjU5IDQ4Ljk5OTYgMTkuNjAxMUM0OC44ODMzIDE5LjE3NjMgNDguOTIyMSAxOC43MTI5IDQ5LjAzODQgMTguMjQ5NUM0OS4xOTM0IDE3Ljc4NjEgNDkuNDY0OCAxNy4zNjEzIDQ5Ljc3NDkgMTcuMDEzN0M1MC4zOTUyIDE2LjM5NTggNTEuMjA5MyAxNi4wMDk3IDUyLjA2MjIgMTUuODE2NkM1Mi42NDM3IDE1LjcwMDcgNTMuMTg2NCAxNS42NjIxIDUzLjc2NzkgMTUuNjYyMUM1NC4zNDk0IDE1LjY2MjEgNTQuOTY5NyAxNS43MDA3IDU1LjQ3MzcgMTUuNzc4QzU1LjY2NzUgMTUuODE2NiA1NS44NjEzIDE1Ljg1NTIgNTYuMTMyNyAxNS44OTM4QzU2LjMyNjYgMTUuOTMyNCA1Ni41NTkyIDE2LjAwOTcgNTYuNzE0MiAxNi4wODY5QzU2Ljc5MTggMTYuMTI1NSA1Ni44NjkzIDE2LjIwMjggNTYuOTQ2OCAxNi4zMTg2QzU2Ljk4NTYgMTYuMzk1OCA1Ny4wMjQ0IDE2LjQ3MzEgNTcuMDI0NCAxNi41ODg5QzU3LjAyNDQgMTYuNjY2MiA1Ny4wMjQ0IDE2Ljc0MzQgNTcuMDI0NCAxNi44MjA2QzU3LjAyNDQgMTcuMzk5OSA1Ny4wMjQ0IDE3Ljk0MDYgNTcuMDI0NCAxOC41MTk4QzU2Ljc5MTcgMTguMzY1MyA1Ni41OTc5IDE4LjI0OTUgNTYuMzY1MyAxOC4xMzM2QzU2LjA5MzkgMTguMDE3OCA1NS44MjI2IDE3LjkwMTkgNTUuNTUxMiAxNy44MjQ3QzU1LjA4NiAxNy43MDg4IDU0LjY1OTYgMTcuNjcwMiA1NC4xOTQ0IDE3LjY3MDJDNTMuOTYxOCAxNy42NzAyIDUzLjcyOTIgMTcuNzA4OCA1My40OTY2IDE3Ljc4NjFDNTMuMzAyNyAxNy44NjMzIDUzLjEwODkgMTguMDE3OCA1My4wNzAxIDE4LjIxMDlDNTMuMDMxMyAxOC4zNjUzIDUzLjEwODkgMTguNTk3IDUzLjE4NjQgMTguNzEyOUM1My4zNDE1IDE4Ljk0NDYgNTMuNjEyOSAxOS4wMjE4IDUzLjg4NDIgMTkuMTM3N0M1NC40MjcgMTkuMzMwOCA1NC45Njk3IDE5LjQ4NTMgNTUuNTEyNSAxOS42NzgzQzU1LjkzODkgMTkuODMyOCA1Ni4zNjUzIDIwLjAyNTkgNTYuNzUzIDIwLjI1NzZDNTcuMjk1NyAyMC42MDUyIDU3Ljc5OTcgMjEuMTA3MiA1OC4wNzExIDIxLjcyNTFDNTguMzQyNCAyMi4zODE2IDU4LjMwMzcgMjMuMTUzOSA1OC4wMzIzIDIzLjc3MThDNTcuNzYwOSAyNC4zODk3IDU3LjI1NyAyNC44OTE3IDU2LjY3NTUgMjUuMjM5M0M1Ni4xMzI3IDI1LjU4NjggNTUuNTEyNCAyNS43Nzk5IDU0Ljg5MjIgMjUuODk1N0M1NC4xOTQ0IDI2LjA1MDIgNTMuNDU3OCAyNi4wODg4IDUyLjc2IDI2LjA4ODhDNTEuOTQ1OSAyNi4wODg4IDUxLjEzMTggMjUuOTczIDUwLjM5NTIgMjUuODU3MUM1MC4xMjM4IDI1LjgxODUgNDkuODUyNSAyNS43Nzk5IDQ5LjU0MjMgMjUuNzAyN0M0OS40MjYgMjUuNjY0IDQ5LjM0ODUgMjUuNjI1NCA0OS4yNzEgMjUuNTQ4MkM0OS4yMzIyIDI1LjQ3MSA0OS4xOTM0IDI1LjM1NTEgNDkuMTkzNCAyNS4yNzc5QzQ5LjE1NDcgMjUuMTIzNCA0OS4xNTQ3IDI1LjAwNzYgNDkuMTE1OSAyNC44OTE3QzQ4Ljk5OTYgMjQuNDI4MyA0OC44NDQ1IDIzLjg0OSA0OC42ODk1IDIzLjE1MzlaIiBmaWxsPSIjMjYyNjI2Ii8+CjxwYXRoIGQ9Ik02Mi44ODM3IDI0LjAwMTVDNjMuMDI0NiAyNC4zNzg0IDYzLjE2NTQgMjQuNzU1MyA2My4zMDYyIDI1LjEzMjJDNjMuMzUzMiAyNS4zMjA3IDYzLjQ0NzEgMjUuNDYyIDYzLjQ5NCAyNS42NTA1QzYzLjU0MSAyNS43NDQ3IDYzLjU4NzkgMjUuODg2MSA2My42ODE4IDI1LjkzMzJDNjMuODIyNiAyNi4wMjc0IDY0LjAxMDQgMjYuMDc0NSA2NC4xOTgyIDI2LjA3NDVDNjQuNDc5OSAyNi4wNzQ1IDY0LjcxNDYgMjYuMDc0NSA2NC45OTYzIDI2LjA3NDVDNjUuMjMxIDI2LjA3NDUgNjUuNDY1NyAyNi4wNzQ1IDY1LjY1MzUgMjYuMDc0NUM2Ni4wNzYgMjYuMDI3NCA2Ni40NTE2IDI1Ljg4NjEgNjYuODI3MiAyNS42OTc2QzY3LjIwMjcgMjUuNTA5MiA2Ny41MzEzIDI1LjMyMDcgNjcuODYgMjUuMDM4QzY4LjMyOTQgMjQuNjE0IDY4Ljc1MTkgMjQuMDk1NyA2OC45ODY2IDIzLjUzMDNDNjkuMzYyMiAyMi43Mjk0IDY5LjU1IDIxLjc4NzEgNjkuNTUgMjAuODkxOUM2OS41NSAyMC4yMzIzIDY5LjUwMyAxOS42MTk4IDY5LjMxNTMgMTkuMDA3M0M2OS4xMjc1IDE4LjQ0MTkgNjguODkyNyAxNy44NzY1IDY4LjUxNzIgMTcuNDA1NEM2OC4wOTQ3IDE2Ljg0IDY3LjU3ODMgMTYuMzY4OCA2Ni45NjggMTYuMDM5QzY2LjQwNDYgMTUuODAzNSA2NS43OTQ0IDE1LjcwOTIgNjUuMTg0MSAxNS42NjIxQzY0LjgwODUgMTUuNjYyMSA2NC40MzI5IDE1LjY2MjEgNjQuMTA0MyAxNS43NTYzQzYzLjkxNjUgMTUuODAzNSA2My42ODE4IDE1Ljg5NzcgNjMuNDk0IDE2LjAzOUM2My4zMDYyIDE2LjEzMzMgNjMuMTE4NSAxNi4yMjc1IDYyLjkzMDcgMTYuMjI3NUM2Mi44MzY4IDE2LjIyNzUgNjIuNjk1OSAxNi4xMzMzIDYyLjY0OSAxNi4wODYyQzYyLjYwMiAxNS45OTE5IDYyLjYwMjEgMTUuODUwNiA2Mi41MDgyIDE1Ljc1NjNDNjIuNDYxMiAxNS43MDkyIDYyLjM2NzMgMTUuNjYyMSA2Mi4yNzM0IDE1LjY2MjFDNjIuMTc5NSAxNS42NjIxIDYyLjA4NTcgMTUuNzU2MyA2MS45OTE4IDE1LjgwMzVDNjEuODA0IDE1Ljg5NzcgNjEuNjE2MiAxNS44OTc3IDYxLjQyODQgMTUuOTQ0OEM2MS4yNDA2IDE1Ljk0NDggNjEuMDk5OCAxNS45NDQ4IDYwLjkxMiAxNS45NDQ4QzYwLjIwNzggMTUuOTQ0OCA1OS41MDM3IDE1Ljk0NDggNTguODQ2NCAxNS45NDQ4QzU4LjcwNTYgMTUuOTQ0OCA1OC42MTE3IDE1Ljk0NDggNTguNDcwOSAxNS45NDQ4QzU4LjMzIDE1Ljk0NDggNTguMTg5MiAxNS45NDQ4IDU4LjE0MjIgMTUuOTkxOUM1OC4wOTUzIDE2LjAzOSA1OC4wNDgzIDE2LjA4NjEgNTguMDQ4MyAxNi4xODA0QzU4LjA0ODMgMTYuMjI3NSA1OC4wOTUzIDE2LjI3NDYgNTguMTQyMiAxNi4zNjg4QzU4LjIzNjEgMTYuNTU3MyA1OC4zNzcgMTYuNjk4NiA1OC41MTc4IDE2Ljg4NzFDNTguNjExNyAxNy4wMjg0IDU4LjcwNTYgMTcuMTIyNyA1OC43NTI1IDE3LjI2NEM1OC44NDY0IDE3LjQ1MjUgNTguNzk5NSAxNy42ODgxIDU4Ljc5OTUgMTcuOTIzNkM1OC43OTk1IDE4LjA2NSA1OC43OTk1IDE4LjIwNjMgNTguNzk5NSAxOC4zOTQ4QzU4Ljc5OTUgMTguOTEzMSA1OC43OTk1IDE5LjQzMTMgNTguNzk5NSAxOS45NDk2QzU4Ljc5OTUgMjAuNTYyMSA1OC43OTk1IDIxLjEyNzUgNTguNzk5NSAyMS43NEM1OC43OTk1IDIzLjY3MTcgNTguNzUyNSAyNS42NTA1IDU4Ljc5OTUgMjcuNTgyMkM1OC43OTk1IDI3LjkxMiA1OC43OTk1IDI4LjI0MTggNTguNzk5NSAyOC41NzE2QzU4Ljc5OTUgMjguNzYwMSA1OC43OTk1IDI4Ljk0ODUgNTguNzUyNSAyOS4wODk5QzU4LjcwNTYgMjkuMjc4MyA1OC42MTE3IDI5LjQ2NjggNTguNDcwOSAyOS42NTUzQzU4LjMzIDI5Ljg0MzcgNTguMjM2MSAyOS45ODUxIDU4LjA0ODMgMzAuMTczNUM1OS43ODUzIDMwLjE3MzUgNjEuNDc1NCAzMC4xNzM1IDYzLjIxMjMgMzAuMTczNUM2My4xMTg1IDMwLjA3OTMgNjMuMDI0NiAyOS45ODUxIDYyLjkzMDcgMjkuODkwOEM2Mi43NDI5IDI5LjcwMjQgNjIuNjAyMSAyOS40NjY4IDYyLjUwODIgMjkuMTg0MUM2Mi40NjEyIDI4Ljk5NTcgNjIuNDE0MyAyOC44MDcyIDYyLjQxNDMgMjguNjE4N0M2Mi40MTQzIDI4LjM4MzIgNjIuNDE0MyAyOC4xMDA1IDYyLjQxNDMgMjcuODY0OUM2Mi40MTQzIDI3LjQ4OCA2Mi40MTQzIDI3LjE1ODIgNjIuNDE0MyAyNi43ODEyQzYyLjQxNDMgMjQuNzU1MyA2Mi40MTQzIDIyLjc3NjUgNjIuNDE0MyAyMC43NTA1QzYyLjQxNDMgMjAuNTYyMSA2Mi40MTQzIDIwLjM3MzYgNjIuNDE0MyAyMC4xODUyQzYyLjQxNDMgMTkuOTQ5NiA2Mi40MTQzIDE5LjcxNCA2Mi40NjEyIDE5LjUyNTVDNjIuNTA4MiAxOS4yOSA2Mi41NTUxIDE5LjA1NDQgNjIuNjQ5IDE4Ljg2NTlDNjIuNzQyOSAxOC42MzA0IDYyLjkzMDcgMTguNDQxOSA2My4xNjU0IDE4LjM0NzdDNjMuMzUzMiAxOC4yNTM0IDYzLjU0MSAxOC4yMDYzIDYzLjcyODcgMTguMjA2M0M2My45MTY1IDE4LjIwNjMgNjQuMTUxMyAxOC4yMDYzIDY0LjMzOSAxOC4zMDA2QzY0LjYyMDcgMTguMzk0OCA2NC44MDg1IDE4LjU4MzIgNjQuOTk2MyAxOC44MTg4QzY1LjEzNzEgMTkuMDU0NCA2NS4yMzEgMTkuMzM3MSA2NS4zMjQ5IDE5LjYxOThDNjUuNDE4OCAxOS45OTY3IDY1LjUxMjcgMjAuMzczNiA2NS41NTk2IDIwLjc5NzdDNjUuNjA2NiAyMS4yNjg4IDY1LjYwNjYgMjEuNzM5OSA2NS41MTI3IDIyLjI1ODJDNjUuNDY1NyAyMi42ODIyIDY1LjM3MTggMjMuMDU5MiA2NS4xODQxIDIzLjM4OUM2NS4wOTAyIDIzLjU3NzQgNjQuOTAyNCAyMy43NjU5IDY0LjcxNDYgMjMuOTA3MkM2NC40Nzk5IDI0LjA0ODYgNjQuMTk4MiAyNC4xNDI4IDYzLjkxNjUgMjQuMTg5OUM2My41ODc5IDI0LjA5NTcgNjMuMjU5MyAyNC4wOTU3IDYyLjg4MzcgMjQuMDAxNVoiIGZpbGw9IiMyNjI2MjYiLz4KPHBhdGggZD0iTTgwLjQ5NzUgMjMuMDExMkM4MC40OTM2IDIzLjAzMzEgODAuNDkzNiAyMy4wNTEgODAuNDg5NiAyMy4wNjY5QzgwLjQ1NzggMjMuMTYyMyA4MC40MjYgMjMuMjU1NyA4MC4zOTQyIDIzLjM1MTFDODAuMzY0MyAyMy40Mzg2IDgwLjMzMDYgMjMuNTI2MSA4MC4zMDA3IDIzLjYxNTVDODAuMjcwOSAyMy43MDMgODAuMjQ1MSAyMy43OTI0IDgwLjIxNTMgMjMuODgxOUM4MC4xNzM1IDI0LjAwMzEgODAuMTI3OCAyNC4xMjQ0IDgwLjA4NDEgMjQuMjQ1N0M4MC4wNDIzIDI0LjM2MjkgODAuMDAwNiAyNC40NzgyIDc5Ljk1NjkgMjQuNTk1NUM3OS45MjExIDI0LjY5NDkgNzkuODgxMyAyNC43OTQzIDc5Ljg0NTUgMjQuODkzN0M3OS44MTU3IDI0Ljk3OTEgNzkuNzgzOSAyNS4wNjI2IDc5Ljc2MDEgMjUuMTUwMUM3OS43MDQ0IDI1LjM0MjkgNzkuNTg5MSAyNS40ODYgNzkuNDEwMiAyNS41Nzc1Qzc5LjI1NTIgMjUuNjU5IDc5LjA5NjEgMjUuNzMwNSA3OC45MzEyIDI1Ljc5MjFDNzguODQxNyAyNS44MjU5IDc4Ljc1MDMgMjUuODQ5OCA3OC42NTg4IDI1Ljg3OTZDNzguNTgxMyAyNS45MDM1IDc4LjUwNTggMjUuOTI5MyA3OC40MjgyIDI1Ljk1MTJDNzguMzY4NiAyNS45NjkxIDc4LjMwNyAyNS45ODMgNzguMjQ3NCAyNS45OTY5Qzc4LjE3OTggMjYuMDE0OCA3OC4xMTQyIDI2LjAzMjcgNzguMDQ2NiAyNi4wNDg2Qzc4LjAwNjggMjYuMDU4NSA3Ny45NjcxIDI2LjA2NjUgNzcuOTI1MyAyNi4wNzQ0Qzc3Ljg3MzcgMjYuMDg2MyA3Ny44MjIgMjYuMDk2MyA3Ny43NzAzIDI2LjEwODJDNzcuNzMyNSAyNi4xMTYyIDc3LjY5NjcgMjYuMTI0MSA3Ny42NTkgMjYuMTMwMUM3Ny42MDMzIDI2LjE0IDc3LjU0NzcgMjYuMTQ2IDc3LjQ5MiAyNi4xNTU5Qzc3LjQyNDQgMjYuMTY1OCA3Ny4zNTg4IDI2LjE3NzggNzcuMjkxMiAyNi4xODc3Qzc3LjI4NzMgMjYuMTg3NyA3Ny4yODEzIDI2LjE4OTcgNzcuMjc3MyAyNi4xODk3Qzc3LjE5NTggMjYuMTk3NyA3Ny4xMTIzIDI2LjIwNTYgNzcuMDMwOCAyNi4yMTU1Qzc2LjkzMTQgMjYuMjI1NSA3Ni44MzAxIDI2LjIzNTQgNzYuNzMwNyAyNi4yNDczQzc2LjcyMDcgMjYuMjQ5MyA3Ni43MTA4IDI2LjI0OTMgNzYuNzAwOSAyNi4yNTEzQzc2LjQwNDcgMjYuMjYxMyA3Ni4xMDg1IDI2LjI4MzEgNzUuODEyMyAyNi4yNzEyQzc1LjY4MTEgMjYuMjY1MiA3NS41NDk5IDI2LjI2MTMgNzUuNDIwNyAyNi4yNTEzQzc1LjMxNTQgMjYuMjQzNCA3NS4yMSAyNi4yMjk1IDc1LjEwNDcgMjYuMjE5NUM3NS4wMjMyIDI2LjIxMTYgNzQuOTM5NyAyNi4yMDU2IDc0Ljg1ODIgMjYuMTk1N0M3NC43ODg2IDI2LjE4NzcgNzQuNzE5IDI2LjE3MzggNzQuNjQ3NSAyNi4xNjE5Qzc0LjYwMzggMjYuMTUzOSA3NC41NiAyNi4xNDYgNzQuNTE2MyAyNi4xNEM3NC40NjQ2IDI2LjEzMjEgNzQuNDEwOSAyNi4xMjQxIDc0LjM1OTMgMjYuMTE0MkM3NC4zMTE1IDI2LjEwNjIgNzQuMjY1OCAyNi4wOTIzIDc0LjIyMDEgMjYuMDgyNEM3NC4xODQzIDI2LjA3NDQgNzQuMTQ4NiAyNi4wNjY1IDc0LjExNDggMjYuMDU4NUM3NC4wMTU0IDI2LjAzMjcgNzMuOTE0IDI2LjAwODggNzMuODE0NiAyNS45ODFDNzMuNzE5MiAyNS45NTUxIDczLjYyMTggMjUuOTI3MyA3My41MjY0IDI1Ljg5NTVDNzMuNDI1IDI1Ljg2MTcgNzMuMzIzNiAyNS44MjIgNzMuMjIyMiAyNS43ODIyQzczLjEwMyAyNS43MzQ1IDcyLjk4MzcgMjUuNjg4OCA3Mi44Njg0IDI1LjYzNTFDNzIuNTc2MiAyNS40OTk5IDcyLjI5MzkgMjUuMzQ0OSA3Mi4wMjc2IDI1LjE2QzcxLjY5MzYgMjQuOTI5NCA3MS4zODU1IDI0LjY2OSA3MS4xMjEyIDI0LjM2MDlDNzAuODkyNiAyNC4wOTQ2IDcwLjY5OTcgMjMuODAyNCA3MC41NDY3IDIzLjQ4NjNDNzAuNDc1MSAyMy4zMzcyIDcwLjQxMTUgMjMuMTg0MiA3MC4zNTU5IDIzLjAyOTFDNzAuMzIyMSAyMi45MzU3IDcwLjI5NjIgMjIuODM4MyA3MC4yNzA0IDIyLjc0MDlDNzAuMjQ0NSAyMi42NDk1IDcwLjIxODcgMjIuNTU4IDcwLjE5NjggMjIuNDY0NkM3MC4xNzg5IDIyLjM4MTEgNzAuMTY1IDIyLjI5NTYgNzAuMTUxMSAyMi4yMTIxQzcwLjE0MTIgMjIuMTUyNSA3MC4xMjkzIDIyLjA5MjkgNzAuMTE5MyAyMi4wMzEzQzcwLjExOTMgMjIuMDI3MyA3MC4xMTczIDIyLjAyNTMgNzAuMTE3MyAyMi4wMjEzQzcwLjEwOTQgMjEuOTU5NyA3MC4xMDE0IDIxLjg5NjEgNzAuMDk1NSAyMS44MzQ1QzcwLjA2OTYgMjEuNTg0IDcwLjA2NzYgMjEuMzMxNiA3MC4wNzM2IDIxLjA4MTFDNzAuMDc3NiAyMC45NDM5IDcwLjA4NTUgMjAuODA2OCA3MC4wOTc0IDIwLjY2OTZDNzAuMTA1NCAyMC41NjIzIDcwLjExOTMgMjAuNDU2OSA3MC4xMzcyIDIwLjM0OTZDNzAuMTUxMSAyMC4yNTQyIDcwLjE3MyAyMC4xNTg4IDcwLjE5MDkgMjAuMDYzNEM3MC4yMDQ4IDE5Ljk4NTggNzAuMjE4NyAxOS45MDgzIDcwLjIzNjYgMTkuODMwOEM3MC4yNTI1IDE5Ljc2MzIgNzAuMjcyNCAxOS42OTc2IDcwLjI5MDMgMTkuNjNDNzAuMzEyMSAxOS41NDg1IDcwLjMzMiAxOS40NjcgNzAuMzU1OSAxOS4zODc1QzcwLjM3NzcgMTkuMzE0IDcwLjQwMzYgMTkuMjQwNCA3MC40Mjc0IDE5LjE2ODlDNzAuNDUzMyAxOS4wOTEzIDcwLjQ4MTEgMTkuMDEzOCA3MC41MDg5IDE4LjkzODNDNzAuNTU2NiAxOC44MTcgNzAuNjAwNCAxOC42OTE4IDcwLjY1NiAxOC41NzQ1QzcwLjczNzUgMTguMzk5NiA3MC44MjEgMTguMjI0NyA3MC45MTY0IDE4LjA1NzdDNzEuMTQzIDE3LjY1NjIgNzEuNDE5MyAxNy4yODg0IDcxLjc1MzMgMTYuOTY4NEM3Mi4wOTEyIDE2LjY0MjQgNzIuNDY4OSAxNi4zNzIgNzIuODgyMyAxNi4xNTM0QzczLjA0MTQgMTYuMDY5OSA3My4yMDQ0IDE1Ljk5MjQgNzMuMzcxMyAxNS45MjQ4QzczLjQ5MDYgMTUuODc3MSA3My42MTE4IDE1LjgzNzMgNzMuNzMzMSAxNS43OTc2QzczLjgzNjUgMTUuNzYzOCA3My45Mzk4IDE1LjczMiA3NC4wNDMyIDE1LjcwNDFDNzQuMTE0OCAxNS42ODQzIDc0LjE4ODMgMTUuNjcyMyA3NC4yNTk5IDE1LjY1ODRDNzQuMzQ5MyAxNS42NDA1IDc0LjQ0MDggMTUuNjIwNyA3NC41MzAyIDE1LjYwNDhDNzQuNTkzOCAxNS41OTQ4IDc0LjY1NzQgMTUuNTg2OSA3NC43MjEgMTUuNTgwOUM3NC44NjAyIDE1LjU2OSA3NS4wMDEzIDE1LjU1OSA3NS4xNDI0IDE1LjU1MzFDNzUuMjUzOCAxNS41NDkxIDc1LjM2NTEgMTUuNTUxMSA3NS40NzQ0IDE1LjU1MzFDNzUuNTA4MiAxNS41NTMxIDc1LjU0NCAxNS41NTUxIDc1LjU3NzggMTUuNTU5Qzc1LjY5NSAxNS41NjcgNzUuODEyMyAxNS41NzEgNzUuOTI5NiAxNS41ODQ5Qzc2LjAzNSAxNS41OTY4IDc2LjEzODMgMTUuNjE4NyA3Ni4yNDE3IDE1LjYzNjZDNzYuMjg5NCAxNS42NDQ1IDc2LjMzOTEgMTUuNjUyNSA3Ni4zODY4IDE1LjY2MjRDNzYuNDI4NSAxNS42NzA0IDc2LjQ3MDMgMTUuNjgyMyA3Ni41MTIgMTUuNjkyMkM3Ni41NDc4IDE1LjcwMDIgNzYuNTgxNiAxNS43MTAxIDc2LjYxNzQgMTUuNzIwMUM3Ni43MDQ4IDE1Ljc0MzkgNzYuNzkwMyAxNS43Njc4IDc2Ljg3NzggMTUuNzk1NkM3Ni45NTkzIDE1LjgyMTQgNzcuMDM4OCAxNS44NTEyIDc3LjEyMDMgMTUuODc5MUM3Ny4yNTc0IDE1LjkyNDggNzcuMzg4NiAxNS45ODI0IDc3LjUxNzggMTYuMDQ0MUM3Ny43NDY0IDE2LjE1MzQgNzcuOTY3MSAxNi4yNzY2IDc4LjE3NzggMTYuNDE5N0M3OC41NDk1IDE2LjY3MDIgNzguODg1NCAxNi45NjI0IDc5LjE4MTYgMTcuMzAyM0M3OS40NTIgMTcuNjEyNCA3OS42Nzg2IDE3Ljk1MDMgNzkuODU3NSAxOC4zMjIxQzc5LjkzMSAxOC40NzUxIDc5Ljk5MjYgMTguNjMwMiA4MC4wNDgzIDE4Ljc4OTJDODAuMDg2MSAxOC44OTY1IDgwLjExNzkgMTkuMDA3OCA4MC4xNDc3IDE5LjExOTJDODAuMTczNSAxOS4yMTg1IDgwLjE5MzQgMTkuMzIxOSA4MC4yMTMzIDE5LjQyMzNDODAuMjMxMiAxOS41MTQ3IDgwLjI0OTEgMTkuNjA4MiA4MC4yNjY5IDE5LjY5OTZDODAuMjc2OSAxOS43NDkzIDgwLjI4MjggMTkuODAxIDgwLjI4ODggMTkuODUwN0M4MC4yOTg4IDE5Ljk0NjEgODAuMzAyNyAyMC4wNDE1IDgwLjMxNDcgMjAuMTM2OUM4MC4zMzI1IDIwLjI4NiA4MC4zMzQ1IDIwLjQzNTEgODAuMzM0NSAyMC41ODIyQzgwLjMzNDUgMjAuNzE1MyA4MC4zMzI1IDIwLjg1MDUgODAuMzMyNSAyMC45ODM3QzgwLjMzMjUgMjEuMDAzNiA4MC4zMjg2IDIxLjAyMzUgODAuMzI2NiAyMS4wNDUzQzgwLjMwMDcgMjEuMDQ3MyA4MC4yNzY5IDIxLjA0OTMgODAuMjU1IDIxLjA0OTNDNzkuMTUzOCAyMS4wNDkzIDc4LjA1MjYgMjEuMDQ5MyA3Ni45NTEzIDIxLjA1MTNDNzUuOTI5NiAyMS4wNTEzIDc0LjkwNzkgMjEuMDUzMyA3My44ODYyIDIxLjA1NTNDNzMuODA0NyAyMS4wNTUzIDczLjgwNDcgMjEuMDU3MiA3My44MDA3IDIxLjEzODdDNzMuNzkwNyAyMS4yODc4IDczLjgwODYgMjEuNDM2OSA3My44MjA2IDIxLjU4NEM3My44Mjg1IDIxLjY4MzQgNzMuODUyNCAyMS43ODI4IDczLjg3NDIgMjEuODgwMkM3My44OTQxIDIxLjk2OTYgNzMuOTEyIDIyLjA2MTEgNzMuOTM5OCAyMi4xNDY2Qzc0LjAwOTQgMjIuMzYxMiA3NC4xMDI4IDIyLjU2NCA3NC4yMjQxIDIyLjc1NDhDNzQuNDYwNiAyMy4xMjQ1IDc0Ljc2NjggMjMuNDIwNyA3NS4xMzQ1IDIzLjY1OTNDNzUuMjk3NSAyMy43NjQ2IDc1LjQ2ODQgMjMuODUyMSA3NS42NDczIDIzLjkyMzZDNzUuNzU2NyAyMy45Njc0IDc1Ljg2OCAyNC4wMDUxIDc1Ljk4NTMgMjQuMDMxQzc2LjA1NjggMjQuMDQ2OSA3Ni4xMjg0IDI0LjA2ODcgNzYuMTk5OSAyNC4wODI3Qzc2LjI1NzYgMjQuMDk0NiA3Ni4zMTcyIDI0LjEwMDUgNzYuMzc2OSAyNC4xMDg1Qzc2LjQ3NjIgMjQuMTIwNCA3Ni41NzM2IDI0LjEzMDQgNzYuNjczIDI0LjEzODNDNzYuODA0MiAyNC4xNDgyIDc2LjkzNzQgMjQuMTQ4MiA3Ny4wNzA2IDI0LjEzNjNDNzcuMTA2NCAyNC4xMzIzIDc3LjE0NDEgMjQuMTMwNCA3Ny4xNzk5IDI0LjEyODRDNzcuMjc1MyAyNC4xMjA0IDc3LjM3MDcgMjQuMTE2NCA3Ny40NjYyIDI0LjEwMjVDNzcuNTYzNiAyNC4wODg2IDc3LjY2MSAyNC4wNjg3IDc3Ljc1NjQgMjQuMDUwOEM3Ny44MzM5IDI0LjAzNjkgNzcuOTExNCAyNC4wMjMgNzcuOTg4OSAyNC4wMDUxQzc4LjA1NDUgMjMuOTkxMiA3OC4xMTgyIDIzLjk3MTMgNzguMTgzNyAyMy45NTM0Qzc4LjI0MTQgMjMuOTM3NSA3OC4zMDEgMjMuOTIzNiA3OC4zNTg3IDIzLjkwNzdDNzguNDEwNCAyMy44OTM4IDc4LjQ2MiAyMy44Nzc5IDc4LjUxMzcgMjMuODZDNzguNTgzMyAyMy44MzgyIDc4LjY1MDkgMjMuODE0MyA3OC43MTg1IDIzLjc5MDRDNzguNzkgMjMuNzY0NiA3OC44NTk2IDIzLjczODggNzguOTI5MiAyMy43MTI5Qzc5LjAwMjcgMjMuNjg1MSA3OS4wNzYzIDIzLjY1OTMgNzkuMTQ5OCAyMy42MzE0Qzc5LjI1NTIgMjMuNTg5NyA3OS4zNjA1IDIzLjU0NzkgNzkuNDYzOSAyMy41MDQyQzc5LjU3NzIgMjMuNDU2NSA3OS42ODg1IDIzLjQwNjggNzkuNzk3OCAyMy4zNTMxQzc5Ljk3MDggMjMuMjcxNiA4MC4xNDE3IDIzLjE4NjIgODAuMzE0NyAyMy4xMDI3QzgwLjM2ODMgMjMuMDc2OCA4MC40MTggMjMuMDQ3IDgwLjQ3MTcgMjMuMDIxMkM4MC40NzM3IDIzLjAxMzIgODAuNDgxNiAyMy4wMTUyIDgwLjQ5NzUgMjMuMDExMlpNNzMuNzc0OCAxOS4yMzA1Qzc0Ljc1ODggMTkuMjMwNSA3NS43MzQ4IDE5LjIzMDUgNzYuNzE0OCAxOS4yMzA1Qzc2LjcxNjggMTkuMjEwNiA3Ni43MTg4IDE5LjE5NDcgNzYuNzIyNyAxOS4xNzg4Qzc2LjczMjcgMTkuMDk5MyA3Ni43MjI3IDE5LjAxOTggNzYuNzIwNyAxOC45NDAzQzc2LjcxNjggMTguODQ0OCA3Ni42OTY5IDE4Ljc1MzQgNzYuNjc1IDE4LjY2MkM3Ni42NDcyIDE4LjU1NjYgNzYuNjA5NCAxOC40NTUyIDc2LjU1OTcgMTguMzU5OEM3Ni40NzYyIDE4LjE5MjkgNzYuMzY2OSAxOC4wNDc3IDc2LjIxOTggMTcuOTMwNUM3Ni4xNTQyIDE3Ljg3ODggNzYuMDg0NyAxNy44MzUxIDc2LjAwOTEgMTcuNzk3M0M3NS45MzU2IDE3Ljc2MTUgNzUuODYyIDE3LjcyNzcgNzUuNzg2NSAxNy42OTk5Qzc1LjcxMjkgMTcuNjc0IDc1LjYzNTQgMTcuNjU0MiA3NS41NTc5IDE3LjYzODNDNzUuNDcyNCAxNy42MjA0IDc1LjM4NSAxNy42MTI0IDc1LjI5NzUgMTcuNjA4NEM3NS4yNDk4IDE3LjYwNjUgNzUuMjAyMSAxNy42MTg0IDc1LjE1NDQgMTcuNjIwNEM3NS4wNzA5IDE3LjYyNDMgNzQuOTkxNCAxNy42NDQyIDc0LjkxMTkgMTcuNjY4MUM3NC43NzI3IDE3LjcwOTggNzQuNjM3NSAxNy43Njc1IDc0LjUxNDMgMTcuODQ1Qzc0LjI4OTcgMTcuOTgyMSA3NC4xMTQ4IDE4LjE2NSA3My45OTM1IDE4LjM5NzZDNzMuOTQ1OCAxOC40OTEgNzMuOTAwMSAxOC41ODQ0IDczLjg3MjIgMTguNjg1OEM3My44NTQ0IDE4Ljc0OTQgNzMuODMyNSAxOC44MTExIDczLjgxODYgMTguODc0N0M3My44MDI3IDE4Ljk0NjIgNzMuNzkyNyAxOS4wMTk4IDczLjc4MjggMTkuMDkzM0M3My43NzY4IDE5LjEzOSA3My43NzY4IDE5LjE4MjggNzMuNzc0OCAxOS4yMzA1WiIgZmlsbD0iIzI2MjYyNiIvPgo8cGF0aCBkPSJNODAuNTA2OCAyNS43NjY0QzgwLjYwNTggMjUuNjc5NSA4MC42OTkgMjUuNTg2OCA4MC43ODY0IDI1LjQ4ODNDODAuOTI2MSAyNS4zMjYxIDgxLjA0ODQgMjUuMTUyMyA4MS4xMjk5IDI0Ljk2MTFDODEuMjU4MSAyNC42NDgzIDgxLjI1ODEgMjQuMzAwNyA4MS4yNjM5IDIzLjk1MzFDODEuMjY5NyAyMy4xODI1IDgxLjI2MzkgMjIuNDQ2OCA4MS4yNjM5IDIxLjY5OTVDODEuMjYzOSAyMC42MjE5IDgxLjI2OTcgMTkuNTI3IDgxLjI2MzkgMTguNDM3OEM4MS4yNjM5IDE4LjI1ODIgODEuMjYzOSAxOC4wNzg2IDgxLjI2MzkgMTcuOTA0OEM4MS4yNjM5IDE3Ljc4MzIgODEuMjY5NyAxNy42NjE1IDgxLjI2MzkgMTcuNTM5OUM4MS4yNjM5IDE3LjQ2NDYgODEuMjU4MSAxNy4zODkyIDgxLjIzNDggMTcuMzEzOUM4MS4xODgyIDE3LjE0MDEgODEuMDQ4NCAxNy4wMDExIDgwLjkyNjEgMTYuODU2M0M4MC44MDk3IDE2LjcyMyA4MC43MDQ4IDE2LjU4NCA4MC42NDA4IDE2LjQyMThDODAuNTg4NCAxNi4yODg1IDgwLjU3NjcgMTYuMTM3OSA4MC41ODI1IDE1LjkzNTFDODEuMjM0OCAxNS45MzUxIDgxLjg4MTIgMTUuOTM1MSA4Mi41MzM0IDE1LjkzNTFDODIuODAxMiAxNS45MzUxIDgzLjA2OTEgMTUuOTM1MSA4My4zMTM3IDE1LjkzNTFDODMuNTE3NSAxNS45MzUxIDgzLjcwOTcgMTUuOTM1MSA4My45MzY4IDE1Ljg5NDZDODQuMTExNSAxNS44NjU2IDg0LjMxNTMgMTUuODEzNSA4NC40OTU4IDE1Ljc3ODdDODQuNjEyMyAxNS43NTU1IDg0LjcyMyAxNS43MzgyIDg0LjgzOTQgMTUuNzQzOUM4NC45MDkzIDE1Ljc0OTcgODQuOTc5MiAxNS43NjEzIDg1LjAzMTYgMTUuODAxOUM4NS4wNzgyIDE1Ljg0MjQgODUuMTAxNSAxNS45MDYyIDg1LjExODkgMTUuOTY0MUM4NS4xMzA2IDE2LjAxNjIgODUuMTMwNiAxNi4wNjg0IDg1LjEzMDYgMTYuMTI2M0M4NS4xMzY0IDE2LjI4ODUgODUuMTQyMiAxNi40NTA3IDg1LjEzMDYgMTYuNjEyOUM4NS4yMzU0IDE2LjUwMjkgODUuMzQ2MSAxNi4zOTg2IDg1LjQ2MjUgMTYuMjk0M0M4NS42MTM5IDE2LjE2MTEgODUuNzc3IDE2LjAzOTQgODUuOTUxNyAxNS45NDY3Qzg2LjEzMjIgMTUuODU0IDg2LjMzMDIgMTUuNzkwMyA4Ni41MjI0IDE1Ljc0MzlDODYuNzg0NCAxNS42ODYgODcuMDQwNyAxNS42NTcgODcuMzI2IDE1LjY2MjhDODcuNTI0IDE1LjY2MjggODcuNzM5NSAxNS42ODAyIDg3Ljg3MzQgMTUuODA3N0M4Ny45NDkxIDE1Ljg4MyA4Ny45OTU3IDE1Ljk4NzMgODguMDEzMiAxNi4wOTczQzg4LjAzNjUgMTYuMTk1OCA4OC4wMzA2IDE2LjMwMDEgODguMDMwNiAxNi4zOTg2Qzg4LjAzMDYgMTYuNjY1MSA4OC4wMzA2IDE2LjkzMTYgODguMDMwNiAxNy4yMDM5Qzg4LjAzMDYgMTcuNjI2OCA4OC4wMjQ4IDE4LjA0MzkgODguMDI0OCAxOC40MjYyQzg3LjQ4MzIgMTguNDIwNSA4Ny4wNzU2IDE4LjM5NzMgODYuNzAyOSAxOC40MTQ3Qzg2LjQ5MzMgMTguNDI2MiA4Ni4zMDExIDE4LjQ0OTQgODYuMDk3MyAxOC41MTg5Qzg1LjkxMDkgMTguNTgyNyA4NS43MTI5IDE4LjY4MTEgODUuNTQ5OSAxOC44MjAyQzg1LjM3NTIgMTguOTY1IDg1LjIzNTQgMTkuMTU2MiA4NS4xNDgxIDE5LjM2NDhDODUuMDQzMiAxOS42MjU1IDg1LjAzMTYgMTkuOTIwOSA4NS4wMzE2IDIwLjIwNDhDODUuMDMxNiAyMC40MTMzIDg1LjAzMTYgMjAuNjE2MSA4NS4wMzE2IDIwLjgxODlDODUuMDM3NCAyMS41MzE1IDg1LjA0OTEgMjIuMjQ0IDg1LjAzMTYgMjIuOTE2MUM4NS4wMTk5IDIzLjM4NTMgODQuOTk2NyAyMy44MzcyIDg1LjA1NDkgMjQuMzkzM0M4NS4wNzI0IDI0LjU0OTggODUuMDg5OCAyNC43MTIgODUuMTM2NCAyNC44NTY4Qzg1LjIwMDUgMjUuMDc3IDg1LjMxMTEgMjUuMjUwOCA4NS40Mjc2IDI1LjQxODhDODUuNTA5MSAyNS41MzQ2IDg1LjU5NjUgMjUuNjQ0NyA4NS42ODk2IDI1Ljc0OUM4My45NjAxIDI1Ljc2NjQgODIuMjM2NCAyNS43NjY0IDgwLjUwNjggMjUuNzY2NFoiIGZpbGw9IiMyNjI2MjYiLz4KPHBhdGggZD0iTTk4LjIwNzMgMjUuNzU4MkM5NC43ODA5IDI1Ljc1ODIgOTEuMzU0NiAyNS43NTgyIDg3LjkxNSAyNS43NTgyQzg3Ljk0MTQgMjUuNzI1MiA4Ny45NjEzIDI1LjY5MjEgODcuOTgxMSAyNS42Nzg5Qzg4LjMxMTkgMjUuNDA3NyA4OC41ODk3IDI1LjA5MDIgODguODM0NCAyNC43Mzk2Qzg4Ljk5MzIgMjQuNTE0NyA4OS4xMTg4IDI0LjI4MzIgODkuMjExNCAyNC4wMzE4Qzg5LjI3NzYgMjMuODQ2NiA4OS4zMTczIDIzLjY1NDggODkuMzYzNiAyMy40NjNDODkuNDI5NyAyMy4yMDUgODkuNDI5NyAyMi45NDA0IDg5LjQ1NjIgMjIuNjc1OUM4OS41MDkxIDIyLjE4NjQgODkuNDg5MyAyMS43MDM1IDg5LjQ4OTMgMjEuMjE0Qzg5LjQ4OTMgMjAuMDk2MiA4OS40ODkzIDE4Ljk3ODMgODkuNDc2IDE3Ljg2MDRDODkuNDY5NCAxNi45MDEzIDg5LjQ0OTYgMTUuOTQ4OCA4OS40Mjk3IDE0Ljk4OTdDODkuNDE2NSAxNC4zMzQ5IDg5LjQxNjUgMTMuNjggODkuMzkgMTMuMDE4NkM4OS4zNTcgMTIuMDI2NCA4OS4zNzAyIDExLjAyNzYgODkuMzM3MSAxMC4wMzU0Qzg5LjI4NDIgOC4zMzU0NiA4OS4zMTczIDYuNjI4OSA4OS4zMDQgNC45Mjg5NUM4OS4zMDQgNC42NjQzNyA4OS4zMTczIDQuNDA2NCA4OS4yNzEgNC4xNDE4MkM4OS4yNTc3IDQuMDgyMjkgODkuMjY0NCA0LjAxNjE0IDg5LjI2NDQgMy45NDk5OUM4OS4yNjQ0IDMuNzQ0OTQgODkuMjMxMyAzLjUzOTg5IDg5LjE4NSAzLjM0MTQ1Qzg5LjE1MTkgMy4yMDI1NSA4OS4xMjU1IDMuMDU3MDMgODkuMDg1OCAyLjkxODEyQzg4Ljk2MDEgMi40NzQ5NCA4OC43NjgzIDIuMDc4MDcgODguNDE3NyAxLjc2NzE4Qzg4LjI4NTQgMS42NDgxMiA4OC4xNTk3IDEuNTI5MDYgODguMDIwOCAxLjQxNjYxQzg3Ljk0MTQgMS4zNTA0NiA4Ny44ODE5IDEuMjcxMDkgODcuODQyMiAxLjE3ODQ5Qzg3Ljc3NjEgMS4wMTMxMiA4Ny44MTU4IDAuOTAwNjc0IDg4LjAyNzQgMC44Njc2MDFDODguMDg3IDAuODU0MzcyIDg4LjE0NjUgMC44NjA5ODYgODguMjA2IDAuODYwOTg2Qzg5LjI4NDIgMC44NjA5ODYgOTAuMzYyNCAwLjg2NzYwMiA5MS40MzM5IDAuODQ3NzU4QzkxLjkzIDAuODQxMTQzIDkyLjQzMjcgMC44MjEyOTkgOTIuOTI4OCAwLjgzNDUyOEM5NS40MjkxIDAuODk0MDU5IDk3LjkyOTUgMC44NDExNDMgMTAwLjQzNiAwLjg2NzYwMUMxMDAuNTYyIDAuODY3NjAxIDEwMC42ODEgMC44ODc0NDUgMTAwLjgwNyAwLjkwMDY3NEMxMDAuODQgMC45MDA2NzQgMTAwLjg2NiAwLjkwNzI4OSAxMDAuODk5IDAuOTA3Mjg5QzEwMS4xMzEgMC45MjcxMzMgMTAxLjM2MiAwLjk0MDM2MSAxMDEuNTk0IDAuOTY2ODJDMTAxLjcyNiAwLjk4MDA0OSAxMDEuODU5IDEuMDE5NzQgMTAxLjk4NCAxLjAzOTU4QzEwMi4wOTcgMS4wNTk0MiAxMDIuMjAyIDEuMDcyNjUgMTAyLjMxNSAxLjA5MjVDMTAyLjQxNCAxLjExMjM0IDEwMi41MDcgMS4xMzg4IDEwMi42MDYgMS4xNjUyNkMxMDIuNjcyIDEuMTg1MSAxMDIuNzMyIDEuMjA0OTQgMTAyLjc5OCAxLjIxODE3QzEwMy4xMDkgMS4yOTA5MyAxMDMuNDA2IDEuNDEgMTAzLjY5NyAxLjUzNTY3QzEwNC4yODYgMS43ODcwMyAxMDQuODE1IDIuMTMwOTkgMTA1LjI5OCAyLjU1NDMyQzEwNS43NzQgMi45NzEwNCAxMDYuMTg0IDMuNDQ3MjkgMTA2LjUyOCAzLjk3NjQ1QzEwNi43MzMgNC4yOTM5NSAxMDYuOTE5IDQuNjI0NjggMTA3LjA1OCA0Ljk3NTI1QzEwNy4xMyA1LjE2MDQ2IDEwNy4yMDMgNS4zNDU2NyAxMDcuMjY5IDUuNTM3NDlDMTA3LjMxNiA1LjY3NjQgMTA3LjM0MiA1LjgyMTkyIDEwNy4zNzUgNS45Njc0NEMxMDcuNDIxIDYuMTc5MTEgMTA3LjQ1NCA2LjM5MDc3IDEwNy40OTQgNi42MDI0NEMxMDcuNDk0IDYuNjE1NjcgMTA3LjUwMSA2LjYyMjI4IDEwNy41MDEgNi42MzU1MUMxMDcuNTE0IDYuOTU5NjMgMTA3LjUzNCA3LjI4Mzc0IDEwNy41NCA3LjYxNDQ3QzEwNy41NCA3LjgxOTUyIDEwNy41MjcgOC4wMTc5NiAxMDcuNTAxIDguMjIzMDFDMTA3LjQ3NCA4LjQ0MTI5IDEwNy40MjEgOC42NTk1NyAxMDcuMzgyIDguODg0NDdDMTA3LjMzNSA5LjE2ODg5IDEwNy4yNDMgOS40NDAwOSAxMDcuMTQ0IDkuNzA0NjdDMTA2LjkzMiAxMC4yNTM3IDEwNi42NDEgMTAuNzYzIDEwNi4yNjQgMTEuMjE5NEMxMDUuOTk5IDExLjU0MzUgMTA1LjY4OCAxMS44MjEzIDEwNS4zNzEgMTIuMDkyNUMxMDQuODY4IDEyLjUyMjUgMTA0LjMzMiAxMi45MDYxIDEwMy43NTcgMTMuMjQzNUMxMDMuNTUyIDEzLjM2MjUgMTAzLjMzNCAxMy40NjE4IDEwMy4xMjIgMTMuNTY3NkMxMDMuMDQ5IDEzLjYwMDcgMTAzLjA0MyAxMy42MTM5IDEwMy4wODIgMTMuNjhDMTAzLjMwNyAxNC4wMzA2IDEwMy41MzIgMTQuMzg3OCAxMDMuNzU3IDE0LjczODRDMTAzLjkyMiAxNS4wMDMgMTA0LjA5NCAxNS4yNjc1IDEwNC4yNTMgMTUuNTMyMUMxMDQuNTQ0IDE2LjAwODQgMTA0LjgzNSAxNi40NzggMTA1LjExOSAxNi45NTQzQzEwNS4zODQgMTcuMzkwOCAxMDUuNjU1IDE3LjgzNCAxMDUuOTIgMTguMjc3MkMxMDYuMjExIDE4Ljc2IDEwNi41MDIgMTkuMjQ5NSAxMDYuNzkzIDE5LjczOUMxMDcuMTgzIDIwLjM4NzIgMTA3LjU2NyAyMS4wMzU0IDEwNy45NTcgMjEuNjgzN0MxMDguMjIyIDIyLjEyNjggMTA4LjQ5MyAyMi41NjM0IDEwOC43NzEgMjNDMTA5LjA2MiAyMy40NDMxIDEwOS4zOTkgMjMuODUzMyAxMDkuNzUgMjQuMjUwMUMxMTAuMTczIDI0LjcxOTggMTEwLjYyMyAyNS4xNTYzIDExMS4xMTIgMjUuNTU5OEMxMTEuMTE5IDI1LjU2NjQgMTExLjExOSAyNS41NzMgMTExLjEzOSAyNS41ODYzQzExMS4wNzMgMjUuNjA2MSAxMTEuMDA2IDI1LjYzMjYgMTEwLjk0NyAyNS42MzI2QzExMC42ODkgMjUuNjUyNCAxMTAuNDMxIDI1LjY1OSAxMTAuMTggMjUuNjkyMUMxMDkuOTc1IDI1LjcxODYgMTA5Ljc3IDI1LjcwNTMgMTA5LjU2NCAyNS43Mzg0QzEwOS4zOTMgMjUuNzY0OSAxMDkuMjIxIDI1Ljc1MTYgMTA5LjA0OSAyNS43NzgxQzEwOC43OTEgMjUuODE3OCAxMDguNTMzIDI1Ljc5MTMgMTA4LjI3NSAyNS44MzFDMTA3LjkzNyAyNS44NzczIDEwNy42IDI1Ljg1MDkgMTA3LjI2MyAyNS44NzA3QzEwNi4yNjQgMjUuOTQzNSAxMDUuMjcyIDI1Ljg5MDUgMTA0LjI3MyAyNS45MDM4QzEwNC4wNzQgMjUuOTAzOCAxMDMuODY5IDI1Ljg5MDUgMTAzLjY3MSAyNS44NTA5QzEwMy4wNDkgMjUuNzM4NCAxMDIuNTEzIDI1LjQ1NCAxMDIuMDM3IDI1LjAzNzNDMTAxLjcgMjQuNzM5NiAxMDEuNDIyIDI0LjM5NTYgMTAxLjE5NyAyNC4wMTJDMTAwLjk5MiAyMy42NzQ3IDEwMC44IDIzLjMyNDEgMTAwLjYwOCAyMi45ODAxQzEwMC40NDMgMjIuNjg5MSAxMDAuMjc4IDIyLjM5OCAxMDAuMTE5IDIyLjEwN0M5OS44NjA5IDIxLjYzNzQgOTkuNjAyOSAyMS4xNjExIDk5LjM1MTYgMjAuNjkxNUM5OS4wNDczIDIwLjEyMjYgOTguNzQ5NyAxOS41NTM4IDk4LjQ1MiAxOC45ODQ5Qzk4LjEzNDUgMTguMzgzIDk3LjgxNyAxNy43ODc3IDk3LjQ3MyAxNy4yMDU2Qzk3LjE2MjIgMTYuNjc2NCA5Ni44NjQ1IDE2LjEzNCA5Ni41NjAyIDE1LjU5ODNDOTYuNTQ3IDE1LjU3ODQgOTYuNTMzOCAxNS41NjUyIDk2LjQ5NDEgMTUuNTU4NkM5Ni40OTQxIDE1LjU5MTYgOTYuNDk0MSAxNS42MjQ3IDk2LjQ5NDEgMTUuNjU3OEM5Ni40OTQxIDE3LjY4ODUgOTYuNDk0MSAxOS43MjU4IDk2LjQ5NDEgMjEuNzU2NEM5Ni40OTQxIDIyLjEzMzUgOTYuNTAwNyAyMi41MDM5IDk2LjUyMDUgMjIuODgwOUM5Ni41MjcyIDIzLjA0NjMgOTYuNTY2OSAyMy4yMDUgOTYuNTkzMyAyMy4zNzA0Qzk2LjYxMzIgMjMuNDgyOCA5Ni42MjY0IDIzLjU4ODcgOTYuNjU5NSAyMy43MDExQzk2LjY5OTEgMjMuODQgOTYuNzQ1NCAyMy45ODU1IDk2LjgwNSAyNC4xMTc4Qzk2LjkxNzQgMjQuMzgyNCA5Ny4wNTYzIDI0LjYzMzggOTcuMjI4MyAyNC44NjUzQzk3LjQ3OTcgMjUuMTg5NCA5Ny43NjQxIDI1LjQ2NzIgOTguMTE0NyAyNS42ODU1Qzk4LjE0NzcgMjUuNzA1MyA5OC4xODA4IDI1LjczMTggOTguMjEzOSAyNS43NTE2Qzk4LjIxMzkgMjUuNzQ1IDk4LjIxMzkgMjUuNzUxNiA5OC4yMDczIDI1Ljc1ODJaTTk2LjQ0MTIgNC42MTE0NUM5Ni40MTQ3IDQuNzcwMiA5Ni40MTQ3IDEzLjAzMTggOTYuNDQxMiAxMy4xMTEyQzk2LjQ1NDQgMTMuMTExMiA5Ni40Njc2IDEzLjExNzggOTYuNDgwOSAxMy4xMTc4Qzk2LjU2MDIgMTMuMTA0NiA5Ni42Mzk2IDEzLjA5MTMgOTYuNzE5IDEzLjA3MTVDOTYuODExNiAxMy4wNTE3IDk2LjkxMDggMTMuMDQ1IDk3LjAwMzQgMTMuMDE4NkM5Ny4xNjg4IDEyLjk2NTcgOTcuMzI3NSAxMi45MDYxIDk3LjQ5MjkgMTIuODUzMkM5Ny43NDQyIDEyLjc2NzIgOTcuOTgyNCAxMi42NDgyIDk4LjIxMzkgMTIuNTA5M0M5OC42NDM4IDEyLjI1MTMgOTkuMDIwOSAxMS45MjcyIDk5LjM1MTYgMTEuNTU2OEM5OS43MDIyIDExLjE1OTkgOTkuOTg2NiAxMC43Mjk5IDEwMC4xOTggMTAuMjQ3MUMxMDAuMjc4IDEwLjA2ODUgMTAwLjMzNyA5Ljg4MzI3IDEwMC4zOTcgOS42OTE0NUMxMDAuNDM2IDkuNTY1NzcgMTAwLjQ2MyA5LjQzMzQ4IDEwMC40OTYgOS4zMDExOUMxMDAuNTM2IDkuMTIyNTkgMTAwLjU3NSA4Ljk0NCAxMDAuNTc1IDguNzU4NzlDMTAwLjU3NSA4LjY5MjY0IDEwMC41ODIgOC42MjY1IDEwMC41ODIgOC41NTM3NEMxMDAuNTg5IDguMTYzNDggMTAwLjU4OSA3Ljc3MzIyIDEwMC40ODkgNy4zOTYxOUMxMDAuNDM2IDcuMjEwOTggMTAwLjQwMyA3LjAxOTE2IDEwMC4zMzcgNi44NDA1NkMxMDAuMjExIDYuNDg5OTkgMTAwLjAzMyA2LjE2NTg4IDk5Ljc5NDggNS44NjgyMkM5OS41NTY2IDUuNTc3MTggOTkuMjg1NCA1LjMyNTgzIDk4Ljk1NDcgNS4xMjczOUM5OC43Njk1IDUuMDE0OTQgOTguNTcxMSA0LjkyODk1IDk4LjM3MjYgNC44NDI5NkM5OC4yNzM0IDQuNzk2NjYgOTguMTYxIDQuNzcwMiA5OC4wNTUxIDQuNzQzNzRDOTcuOTY5MSA0LjcyMzkgOTcuODgzMiA0LjcwNDA1IDk3Ljc5NzIgNC42OTA4M0M5Ny42NzE1IDQuNjY0MzcgOTcuNTUyNCA0LjYxODA3IDk3LjQyNjcgNC42MTgwN0M5Ny4xMDkyIDQuNTk4MjIgOTYuNzc4NSA0LjYxMTQ1IDk2LjQ0MTIgNC42MTE0NVoiIGZpbGw9IiMyNjI2MjYiLz4KPHBhdGggZD0iTTExNC43ODcgMTUuNzcxOEMxMTUuMDU5IDE1Ljc2MzkgMTE1LjMyOCAxNS43NzcgMTE1LjU5NSAxNS44MDU4QzExNS43OTkgMTUuODI5MyAxMTYuMDAzIDE1Ljg2MzMgMTE2LjIwNyAxNS45QzExNi4zNDMgMTUuOTIzNSAxMTYuNDgyIDE1Ljk1MjMgMTE2LjYxNiAxNS45ODg5QzExNi44NTYgMTYuMDU0MyAxMTcuMDkyIDE2LjEzOCAxMTcuMzE5IDE2LjI0QzExNy43ODcgMTYuNDQ2NyAxMTguMjE3IDE2LjcxNjEgMTE4LjU5OCAxNy4wNTFDMTE4Ljk5MyAxNy4zOTYzIDExOS4zMiAxNy43OTkyIDExOS41ODUgMTguMjU0NEMxMTkuNzEzIDE4LjQ3MTUgMTE5LjgyMyAxOC42OTkxIDExOS45MTcgMTguOTMxOUMxMTkuOTcyIDE5LjA2NTMgMTIwLjAxNCAxOS4yMDQgMTIwLjA1NiAxOS4zNDI2QzEyMC4wOTIgMTkuNDU1MSAxMjAuMTI0IDE5LjU3MDIgMTIwLjE1MiAxOS42ODUzQzEyMC4xNjggMTkuNzQ1NSAxMjAuMTc2IDE5LjgwODMgMTIwLjE4NiAxOS44NzFDMTIwLjIwMiAxOS45NDY5IDEyMC4yMTUgMjAuMDIyOCAxMjAuMjMxIDIwLjEwMTJDMTIwLjIzMyAyMC4xMDkxIDEyMC4yMzMgMjAuMTE5NiAxMjAuMjM2IDIwLjEyNzRDMTIwLjI0NCAyMC4xOTU0IDEyMC4yNTcgMjAuMjY2MSAxMjAuMjYgMjAuMzM0MUMxMjAuMjY1IDIwLjU2OTUgMTIwLjMwMSAyMC44MDIzIDEyMC4yNzMgMjEuMDM3OEMxMjAuMjY3IDIxLjA3OTYgMTIwLjI3IDIxLjEyMTUgMTIwLjI2NyAyMS4xNjA3QzEyMC4yNTcgMjEuMjkxNSAxMjAuMjUyIDIxLjQyMjMgMTIwLjIzMyAyMS41NTA1QzEyMC4yMTggMjEuNjc2MSAxMjAuMTg5IDIxLjc5NjQgMTIwLjE2NSAyMS45MjJDMTIwLjE0NyAyMi4wMTYyIDEyMC4xMjkgMjIuMTEyOSAxMjAuMTA1IDIyLjIwNzFDMTIwLjA3NiAyMi4zMTQ0IDEyMC4wNDUgMjIuNDE5IDEyMC4wMDggMjIuNTIzN0MxMTkuOTY3IDIyLjY0OTIgMTE5LjkyMiAyMi43NzIyIDExOS44NzUgMjIuODk1MUMxMTkuNzcgMjMuMTY0NiAxMTkuNjQyIDIzLjQyMDkgMTE5LjQ5IDIzLjY2OTVDMTE5LjAwNyAyNC40NTQzIDExOC4zMzkgMjUuMDM1IDExNy41MSAyNS40M0MxMTcuMjIyIDI1LjU2ODcgMTE2LjkyNCAyNS42ODEyIDExNi42MTggMjUuNzY3NUMxMTYuNDE0IDI1LjgyMjQgMTE2LjIwNyAyNS44Nzc0IDExNS45OTggMjUuOTIxOEMxMTUuODI4IDI1Ljk1ODUgMTE1LjY1OCAyNS45OTI1IDExNS40ODUgMjYuMDE2QzExNS4xMzcgMjYuMDYwNSAxMTQuNzg3IDI2LjA5NDUgMTE0LjQzNiAyNi4wNjgzQzExNC4xOSAyNi4wNSAxMTMuOTQ3IDI2LjAyMzkgMTEzLjcwNCAyNS45ODk5QzExMy40NzYgMjUuOTU1OCAxMTMuMjQ5IDI1LjkxNjYgMTEzLjAyNCAyNS44NjE3QzExMi40ODcgMjUuNzMzNSAxMTEuOTcyIDI1LjU1MDQgMTExLjUwNCAyNS4yNDk1QzExMS4wNDEgMjQuOTQ4NyAxMTAuNjQzIDI0LjU4MjQgMTEwLjMwNiAyNC4xNDU2QzExMC4wODkgMjMuODYwNCAxMDkuOTA1IDIzLjU1NDQgMTA5Ljc1MSAyMy4yM0MxMDkuNjY3IDIzLjA1MjEgMTA5LjU5NCAyMi44NzE2IDEwOS41MjkgMjIuNjg1OUMxMDkuNDkyIDIyLjU4OTEgMTA5LjQ2OSAyMi40ODcgMTA5LjQ0IDIyLjM4NzZDMTA5LjQwNiAyMi4yNjk5IDEwOS4zNzQgMjIuMTQ5NiAxMDkuMzQ2IDIyLjAzMTlDMTA5LjMzIDIxLjk3MTcgMTA5LjMyMiAyMS45MDg5IDEwOS4zMTIgMjEuODQ2MUMxMDkuMjk5IDIxLjc3MDMgMTA5LjI4MyAyMS42OTE4IDEwOS4yNyAyMS42MTU5QzEwOS4yNyAyMS42MTA3IDEwOS4yNjcgMjEuNjAyOCAxMDkuMjY1IDIxLjU5NzZDMTA5LjI1NCAyMS40OTMgMTA5LjI0MSAyMS4zODU3IDEwOS4yMzMgMjEuMjgxMUMxMDkuMjIzIDIxLjEwMzIgMTA5LjIxIDIwLjkyNTMgMTA5LjIxMiAyMC43NDc0QzEwOS4yMTIgMjAuNTk1NyAxMDkuMjI1IDIwLjQ0MzkgMTA5LjI0MSAyMC4yOTIyQzEwOS4yNTEgMjAuMTc3MSAxMDkuMjcgMjAuMDY0NiAxMDkuMjkzIDE5Ljk1MjFDMTA5LjMyIDE5LjgyNCAxMDkuMzU0IDE5LjY5NTggMTA5LjM4OCAxOS41Njc2QzEwOS40MTkgMTkuNDUyNSAxMDkuNDU4IDE5LjM0MjYgMTA5LjQ5NSAxOS4yMzAxQzEwOS41NTIgMTkuMDU0OCAxMDkuNjI4IDE4Ljg4NDggMTA5LjcxNSAxOC43MkMxMTAuMDI4IDE4LjExMDUgMTEwLjQ0NCAxNy41Nzk0IDExMC45NTcgMTcuMTI0MkMxMTEuMzg5IDE2LjczOTcgMTExLjg2NyAxNi40MzM2IDExMi4zOTkgMTYuMjA2QzExMi42NDIgMTYuMTAxNCAxMTIuODkzIDE2LjAxNzcgMTEzLjE1MiAxNS45NTc1QzExMy4zODUgMTUuOTA1MiAxMTMuNjIgMTUuODYwNyAxMTMuODU4IDE1LjgyOTNDMTE0LjE2NCAxNS43Nzk2IDExNC40NzYgMTUuNzY5MiAxMTQuNzg3IDE1Ljc3MThaTTExNi42NjUgMjEuMjUyM0MxMTYuNjYzIDIxLjI1MjMgMTE2LjY2IDIxLjI1MjMgMTE2LjY1NyAyMS4yNTIzQzExNi42NTcgMjEuMDE5NSAxMTYuNjYgMjAuNzg2NiAxMTYuNjU3IDIwLjU1MzhDMTE2LjY1NSAyMC4zNzU5IDExNi42MzkgMjAuMTk4IDExNi42MjkgMjAuMDIwMkMxMTYuNjI5IDIwLjAwOTcgMTE2LjYyNiAxOS45OTkyIDExNi42MjMgMTkuOTg4OEMxMTYuNjA4IDE5LjkwNSAxMTYuNTk1IDE5LjgyMTMgMTE2LjU3OSAxOS43NDAyQzExNi41NjEgMTkuNjQzNCAxMTYuNTQ4IDE5LjU0NCAxMTYuNTE5IDE5LjQ0NzJDMTE2LjQ3OSAxOS4zMDYgMTE2LjQzIDE5LjE2NzMgMTE2LjM3MiAxOS4wMzM5QzExNi4yNTIgMTguNzUxNCAxMTYuMDg3IDE4LjQ5NzYgMTE1Ljg3IDE4LjI3NzlDMTE1LjcwOCAxOC4xMTMxIDExNS41MjIgMTcuOTgyMyAxMTUuMzA4IDE3Ljg5ODZDMTE1LjA0NiAxNy43OTY2IDExNC43NzEgMTcuNzcwNCAxMTQuNDk0IDE3Ljc3M0MxMTQuNDI2IDE3Ljc3MyAxMTQuMzU1IDE3Ljc4MDkgMTE0LjI4NyAxNy43OTM5QzExNC4xNDMgMTcuODI1MyAxMTQuMDA3IDE3Ljg3NzcgMTEzLjg4NCAxNy45NTYxQzExMy41OTEgMTguMTQ0NSAxMTMuMzY2IDE4LjM5MyAxMTMuMjA3IDE4LjY5OTFDMTEzLjA4NCAxOC45MzE5IDExMi45OSAxOS4xNzc4IDExMi45NCAxOS40Mzk0QzExMi45MTQgMTkuNTcwMiAxMTIuODg1IDE5LjcwMzYgMTEyLjg2OSAxOS44MzQ0QzExMi44NTEgMjAuMDIwMiAxMTIuODMgMjAuMjA1OSAxMTIuODMzIDIwLjM5NDJDMTEyLjgzMyAyMC41MDQxIDExMi44MjUgMjAuNjExNCAxMTIuODIyIDIwLjcyMTJDMTEyLjgyIDIwLjgyODUgMTEyLjgxMiAyMC45MzU3IDExMi44MjIgMjEuMDQwNEMxMTIuODQzIDIxLjIyODcgMTEyLjgzMyAyMS40MTk3IDExMi44NTkgMjEuNjA4MUMxMTIuODc3IDIxLjczMzYgMTEyLjg5IDIxLjg2MTggMTEyLjkxNCAyMS45ODc0QzExMi45MzUgMjIuMTA3NyAxMTIuOTU4IDIyLjIyODEgMTEyLjk5NSAyMi4zNDg0QzExMy4wMzQgMjIuNDgxOCAxMTMuMDY2IDIyLjYxNTIgMTEzLjExIDIyLjc0NkMxMTMuMTYyIDIyLjkwMDQgMTEzLjIzIDIzLjA0OTUgMTEzLjMxNCAyMy4xOTA3QzExMy40MjcgMjMuMzc5MSAxMTMuNTYzIDIzLjU0OTEgMTEzLjc0NiAyMy42NzczQzExNC4xMiAyMy45MzM3IDExNC41MzYgMjQuMDYxOSAxMTQuOTg4IDI0LjA2OTdDMTE1LjE2NiAyNC4wNzIzIDExNS4zMzQgMjQuMDM1NyAxMTUuNDk4IDIzLjk3MjlDMTE1LjgxIDIzLjg1MjYgMTE2LjA1MyAyMy42NDU5IDExNi4yNDQgMjMuMzc2NUMxMTYuNDA0IDIzLjE1MTUgMTE2LjUgMjIuOTAwNCAxMTYuNTU4IDIyLjYzMDlDMTE2LjU2OCAyMi41ODEyIDExNi41ODIgMjIuNTI4OSAxMTYuNTg5IDIyLjQ3OTJDMTE2LjYwNSAyMi4zOTI5IDExNi42MjYgMjIuMzAzOSAxMTYuNjMxIDIyLjIxNUMxMTYuNjQyIDIxLjg5MzIgMTE2LjY1MiAyMS41NzQxIDExNi42NjUgMjEuMjUyM1oiIGZpbGw9IiMyNjI2MjYiLz4KPHBhdGggZD0iTTEyNi4zOTQgMTUuNzcxOEMxMjYuNjY2IDE1Ljc2MzkgMTI2LjkzNiAxNS43NzcgMTI3LjIwMyAxNS44MDU4QzEyNy40MDcgMTUuODI5MyAxMjcuNjExIDE1Ljg2MzMgMTI3LjgxNSAxNS45QzEyNy45NTEgMTUuOTIzNSAxMjguMDkgMTUuOTUyMyAxMjguMjIzIDE1Ljk4ODlDMTI4LjQ2NCAxNi4wNTQzIDEyOC42OTkgMTYuMTM4IDEyOC45MjcgMTYuMjRDMTI5LjM5NSAxNi40NDY3IDEyOS44MjQgMTYuNzE2MSAxMzAuMjA2IDE3LjA1MUMxMzAuNjAxIDE3LjM5NjMgMTMwLjkyOCAxNy43OTkyIDEzMS4xOTIgMTguMjU0NEMxMzEuMzIgMTguNDcxNSAxMzEuNDMgMTguNjk5MSAxMzEuNTI0IDE4LjkzMTlDMTMxLjU3OSAxOS4wNjUzIDEzMS42MjEgMTkuMjA0IDEzMS42NjMgMTkuMzQyNkMxMzEuNyAxOS40NTUxIDEzMS43MzEgMTkuNTcwMiAxMzEuNzYgMTkuNjg1M0MxMzEuNzc1IDE5Ljc0NTUgMTMxLjc4MyAxOS44MDgzIDEzMS43OTQgMTkuODcxQzEzMS44MDkgMTkuOTQ2OSAxMzEuODIzIDIwLjAyMjggMTMxLjgzOCAyMC4xMDEyQzEzMS44NDEgMjAuMTA5MSAxMzEuODQxIDIwLjExOTYgMTMxLjg0MyAyMC4xMjc0QzEzMS44NTEgMjAuMTk1NCAxMzEuODY0IDIwLjI2NjEgMTMxLjg2NyAyMC4zMzQxQzEzMS44NzIgMjAuNTY5NSAxMzEuOTA5IDIwLjgwMjMgMTMxLjg4IDIxLjAzNzhDMTMxLjg3NSAyMS4wNzk2IDEzMS44NzcgMjEuMTIxNSAxMzEuODc1IDIxLjE2MDdDMTMxLjg2NCAyMS4yOTE1IDEzMS44NTkgMjEuNDIyMyAxMzEuODQxIDIxLjU1MDVDMTMxLjgyNSAyMS42NzYxIDEzMS43OTYgMjEuNzk2NCAxMzEuNzczIDIxLjkyMkMxMzEuNzU1IDIyLjAxNjIgMTMxLjczNiAyMi4xMTI5IDEzMS43MTMgMjIuMjA3MUMxMzEuNjg0IDIyLjMxNDQgMTMxLjY1MyAyMi40MTkgMTMxLjYxNiAyMi41MjM3QzEzMS41NzQgMjIuNjQ5MiAxMzEuNTMgMjIuNzcyMiAxMzEuNDgyIDIyLjg5NTFDMTMxLjM3OCAyMy4xNjQ2IDEzMS4yNSAyMy40MjA5IDEzMS4wOTggMjMuNjY5NUMxMzAuNjE0IDI0LjQ1NDMgMTI5Ljk0NyAyNS4wMzUgMTI5LjExOCAyNS40M0MxMjguODMgMjUuNTY4NyAxMjguNTMyIDI1LjY4MTIgMTI4LjIyNiAyNS43Njc1QzEyOC4wMjIgMjUuODIyNCAxMjcuODE1IDI1Ljg3NzQgMTI3LjYwNiAyNS45MjE4QzEyNy40MzYgMjUuOTU4NSAxMjcuMjY1IDI1Ljk5MjUgMTI3LjA5MyAyNi4wMTZDMTI2Ljc0NSAyNi4wNjA1IDEyNi4zOTQgMjYuMDk0NSAxMjYuMDQ0IDI2LjA2ODNDMTI1Ljc5OCAyNi4wNSAxMjUuNTU1IDI2LjAyMzkgMTI1LjMxMSAyNS45ODk5QzEyNS4wODQgMjUuOTU1OCAxMjQuODU2IDI1LjkxNjYgMTI0LjYzMSAyNS44NjE3QzEyNC4wOTUgMjUuNzMzNSAxMjMuNTggMjUuNTUwNCAxMjMuMTExIDI1LjI0OTVDMTIyLjY0OCAyNC45NDg3IDEyMi4yNTEgMjQuNTgyNCAxMjEuOTEzIDI0LjE0NTZDMTIxLjY5NiAyMy44NjA0IDEyMS41MTMgMjMuNTU0NCAxMjEuMzU5IDIzLjIzQzEyMS4yNzUgMjMuMDUyMSAxMjEuMjAyIDIyLjg3MTYgMTIxLjEzNiAyMi42ODU5QzEyMS4xIDIyLjU4OTEgMTIxLjA3NiAyMi40ODcgMTIxLjA0NyAyMi4zODc2QzEyMS4wMTMgMjIuMjY5OSAxMjAuOTgyIDIyLjE0OTYgMTIwLjk1MyAyMi4wMzE5QzEyMC45MzcgMjEuOTcxNyAxMjAuOTMgMjEuOTA4OSAxMjAuOTE5IDIxLjg0NjFDMTIwLjkwNiAyMS43NzAzIDEyMC44OSAyMS42OTE4IDEyMC44NzcgMjEuNjE1OUMxMjAuODc3IDIxLjYxMDcgMTIwLjg3NSAyMS42MDI4IDEyMC44NzIgMjEuNTk3NkMxMjAuODYyIDIxLjQ5MyAxMjAuODQ4IDIxLjM4NTcgMTIwLjg0MSAyMS4yODExQzEyMC44MyAyMS4xMDMyIDEyMC44MTcgMjAuOTI1MyAxMjAuODIgMjAuNzQ3NEMxMjAuODIgMjAuNTk1NyAxMjAuODMzIDIwLjQ0MzkgMTIwLjg0OCAyMC4yOTIyQzEyMC44NTkgMjAuMTc3MSAxMjAuODc3IDIwLjA2NDYgMTIwLjkwMSAxOS45NTIxQzEyMC45MjcgMTkuODI0IDEyMC45NjEgMTkuNjk1OCAxMjAuOTk1IDE5LjU2NzZDMTIxLjAyNiAxOS40NTI1IDEyMS4wNjYgMTkuMzQyNiAxMjEuMTAyIDE5LjIzMDFDMTIxLjE2IDE5LjA1NDggMTIxLjIzNiAxOC44ODQ4IDEyMS4zMjIgMTguNzJDMTIxLjYzNiAxOC4xMTA1IDEyMi4wNTIgMTcuNTc5NCAxMjIuNTY1IDE3LjEyNDJDMTIyLjk5NiAxNi43Mzk3IDEyMy40NzUgMTYuNDMzNiAxMjQuMDA2IDE2LjIwNkMxMjQuMjQ5IDE2LjEwMTQgMTI0LjUgMTYuMDE3NyAxMjQuNzU5IDE1Ljk1NzVDMTI0Ljk5MiAxNS45MDUyIDEyNS4yMjggMTUuODYwNyAxMjUuNDY2IDE1LjgyOTNDMTI1Ljc3MiAxNS43Nzk2IDEyNi4wODMgMTUuNzY5MiAxMjYuMzk0IDE1Ljc3MThaTTEyOC4yNzMgMjEuMjUyM0MxMjguMjcgMjEuMjUyMyAxMjguMjY3IDIxLjI1MjMgMTI4LjI2NSAyMS4yNTIzQzEyOC4yNjUgMjEuMDE5NSAxMjguMjY3IDIwLjc4NjYgMTI4LjI2NSAyMC41NTM4QzEyOC4yNjIgMjAuMzc1OSAxMjguMjQ2IDIwLjE5OCAxMjguMjM2IDIwLjAyMDJDMTI4LjIzNiAyMC4wMDk3IDEyOC4yMzMgMTkuOTk5MiAxMjguMjMxIDE5Ljk4ODhDMTI4LjIxNSAxOS45MDUgMTI4LjIwMiAxOS44MjEzIDEyOC4xODYgMTkuNzQwMkMxMjguMTY4IDE5LjY0MzQgMTI4LjE1NSAxOS41NDQgMTI4LjEyNiAxOS40NDcyQzEyOC4wODcgMTkuMzA2IDEyOC4wMzcgMTkuMTY3MyAxMjcuOTggMTkuMDMzOUMxMjcuODU5IDE4Ljc1MTQgMTI3LjY5NSAxOC40OTc2IDEyNy40NzcgMTguMjc3OUMxMjcuMzE1IDE4LjExMzEgMTI3LjEyOSAxNy45ODIzIDEyNi45MTUgMTcuODk4NkMxMjYuNjUzIDE3Ljc5NjYgMTI2LjM3OSAxNy43NzA0IDEyNi4xMDEgMTcuNzczQzEyNi4wMzMgMTcuNzczIDEyNS45NjMgMTcuNzgwOSAxMjUuODk1IDE3Ljc5MzlDMTI1Ljc1MSAxNy44MjUzIDEyNS42MTUgMTcuODc3NyAxMjUuNDkyIDE3Ljk1NjFDMTI1LjE5OSAxOC4xNDQ1IDEyNC45NzQgMTguMzkzIDEyNC44MTQgMTguNjk5MUMxMjQuNjkxIDE4LjkzMTkgMTI0LjU5NyAxOS4xNzc4IDEyNC41NDcgMTkuNDM5NEMxMjQuNTIxIDE5LjU3MDIgMTI0LjQ5MyAxOS43MDM2IDEyNC40NzcgMTkuODM0NEMxMjQuNDU5IDIwLjAyMDIgMTI0LjQzOCAyMC4yMDU5IDEyNC40NCAyMC4zOTQyQzEyNC40NCAyMC41MDQxIDEyNC40MzIgMjAuNjExNCAxMjQuNDMgMjAuNzIxMkMxMjQuNDI3IDIwLjgyODUgMTI0LjQxOSAyMC45MzU3IDEyNC40MyAyMS4wNDA0QzEyNC40NTEgMjEuMjI4NyAxMjQuNDQgMjEuNDE5NyAxMjQuNDY2IDIxLjYwODFDMTI0LjQ4NSAyMS43MzM2IDEyNC40OTggMjEuODYxOCAxMjQuNTIxIDIxLjk4NzRDMTI0LjU0MiAyMi4xMDc3IDEyNC41NjYgMjIuMjI4MSAxMjQuNjAyIDIyLjM0ODRDMTI0LjY0MiAyMi40ODE4IDEyNC42NzMgMjIuNjE1MiAxMjQuNzE4IDIyLjc0NkMxMjQuNzcgMjIuOTAwNCAxMjQuODM4IDIzLjA0OTUgMTI0LjkyMiAyMy4xOTA3QzEyNS4wMzQgMjMuMzc5MSAxMjUuMTcgMjMuNTQ5MSAxMjUuMzUzIDIzLjY3NzNDMTI1LjcyNyAyMy45MzM3IDEyNi4xNDMgMjQuMDYxOSAxMjYuNTk2IDI0LjA2OTdDMTI2Ljc3NCAyNC4wNzIzIDEyNi45NDEgMjQuMDM1NyAxMjcuMTA2IDIzLjk3MjlDMTI3LjQxNyAyMy44NTI2IDEyNy42NjEgMjMuNjQ1OSAxMjcuODUxIDIzLjM3NjVDMTI4LjAxMSAyMy4xNTE1IDEyOC4xMDggMjIuOTAwNCAxMjguMTY1IDIyLjYzMDlDMTI4LjE3NiAyMi41ODEyIDEyOC4xODkgMjIuNTI4OSAxMjguMTk3IDIyLjQ3OTJDMTI4LjIxMiAyMi4zOTI5IDEyOC4yMzMgMjIuMzAzOSAxMjguMjM5IDIyLjIxNUMxMjguMjQ5IDIxLjg5MzIgMTI4LjI2IDIxLjU3NDEgMTI4LjI3MyAyMS4yNTIzWiIgZmlsbD0iIzI2MjYyNiIvPgo8cGF0aCBkPSJNMTMyLjEwOCAyNS43MjY0QzEzMi4yMjkgMjUuNjE5OSAxMzIuMzM1IDI1LjUxMzQgMTMyLjQ0MiAyNS4zOTM2QzEzMi41NjIgMjUuMjYwNSAxMzIuNjU2IDI1LjExNCAxMzIuNzM2IDI0Ljk1NDNDMTMyLjgwMyAyNC44MjEyIDEzMi44NDMgMjQuNjYxNSAxMzIuODY5IDI0LjUxNUMxMzIuOTEgMjQuMjYyMSAxMzIuOTEgMjQuMDA5MiAxMzIuOTEgMjMuNzQzQzEzMi45MSAyMi40Nzg0IDEzMi45MSAyMS4yMjcxIDEzMi45MSAxOS45NjI2QzEzMi45MSAxOS40NTY4IDEzMi44OTYgMTguOTUwOSAxMzIuOTEgMTguNDQ1MUMxMzIuOTEgMTguMTc4OSAxMzIuOTIzIDE3LjkxMjYgMTMyLjg5NiAxNy42NDY0QzEzMi44ODMgMTcuNDA2OCAxMzIuODQzIDE3LjE2NzIgMTMyLjc0OSAxNi45NTQyQzEzMi42NTYgMTYuNzU0NiAxMzIuNTA5IDE2LjU2ODIgMTMyLjM3NSAxNi4zOTUyQzEzMi4yOTUgMTYuMjg4NyAxMzIuMjE1IDE2LjE5NTUgMTMyLjEzNSAxNi4xMDIzQzEzMi4zMjIgMTYuMTAyMyAxMzIuNTIyIDE2LjExNTYgMTMyLjcwOSAxNi4xMTU2QzEzMy4xNjMgMTYuMTI4OSAxMzMuNjA0IDE2LjEyODkgMTM0LjA1OCAxNi4xMjg5QzEzNC40NTggMTYuMTI4OSAxMzQuODU5IDE2LjExNTYgMTM1LjI1OSAxNi4wNzU3QzEzNS40NzMgMTYuMDYyNCAxMzUuNjg3IDE2LjAzNTggMTM1LjkgMTUuOTgyNUMxMzYuMTI3IDE1LjkyOTMgMTM2LjM1NCAxNS44NjI3IDEzNi41ODEgMTUuNzY5NUMxMzYuNTgxIDE2LjE0MjIgMTM2LjU4MSAxNi41MTUgMTM2LjU4MSAxNi44NzQ0QzEzNi42MjEgMTYuODg3NyAxMzYuNjQ4IDE2Ljg4NzcgMTM2LjY4OCAxNi44NzQ0QzEzNi43MjggMTYuODYxMSAxMzYuNzY4IDE2LjgzNDQgMTM2LjgwOCAxNi44MDc4QzEzNi45OTUgMTYuNjYxNCAxMzcuMTQyIDE2LjQ3NSAxMzcuMzE2IDE2LjM0MTlDMTM3LjUyOSAxNi4xNjg5IDEzNy43OTYgMTYuMDQ5MSAxMzguMDYzIDE1Ljk2OTJDMTM4LjQxMSAxNS44NjI3IDEzOC43NTggMTUuODIyOCAxMzkuMTMyIDE1LjgyMjhDMTM5LjU5OSAxNS44MjI4IDE0MC4wOCAxNS44NzYgMTQwLjQ1MyAxNi4wNDkxQzE0MC42NCAxNi4xNDIyIDE0MC44MDEgMTYuMjYyMSAxNDAuOTg3IDE2LjQyMThDMTQxLjE4OCAxNi41OTQ4IDE0MS40NDEgMTYuODA3OCAxNDEuNjQyIDE2Ljk2NzVDMTQxLjgyOSAxNi43OTQ1IDE0Mi4wMjkgMTYuNjM0OCAxNDIuMjQzIDE2LjUwMTdDMTQyLjYwMyAxNi4yNzU0IDE0Mi45OSAxNi4xMDIzIDE0My40MDQgMTYuMDA5MUMxNDMuNzc4IDE1LjkxNiAxNDQuMTY1IDE1Ljg2MjcgMTQ0LjU1MiAxNS44NjI3QzE0NC45NjYgMTUuODQ5NCAxNDUuMzk0IDE1Ljg4OTMgMTQ1LjgwOCAxNS45ODI1QzE0Ni4zNTUgMTYuMTE1NiAxNDYuODc2IDE2LjM1NTIgMTQ3LjMwMyAxNi43MTQ2QzE0Ny41NTcgMTYuOTE0MyAxNDcuNzcgMTcuMTUzOSAxNDcuOTQ0IDE3LjQyMDFDMTQ4LjExNyAxNy42ODY0IDE0OC4yMzggMTcuOTkyNSAxNDguMjkxIDE4LjMxMkMxNDguMzMxIDE4LjU2NDkgMTQ4LjMzMSAxOC44MzExIDE0OC4zMzEgMTkuMDg0QzE0OC4zMzEgMTkuODQyOCAxNDguMzMxIDIwLjU4ODIgMTQ4LjMzMSAyMS4zMzM2QzE0OC4zMzEgMjEuNjUzMSAxNDguMzMxIDIxLjk3MjYgMTQ4LjMzMSAyMi4zMDU0QzE0OC4zMzEgMjIuNjM4MSAxNDguMzMxIDIyLjk1NzYgMTQ4LjMzMSAyMy4yOTA0QzE0OC4zMzEgMjMuNTU2NiAxNDguMzMxIDIzLjgwOTUgMTQ4LjMzMSAyNC4wNzU4QzE0OC4zMzEgMjQuMzE1NCAxNDguMzQ0IDI0LjU2ODMgMTQ4LjQxMSAyNC43OTQ2QzE0OC40NzggMjUuMDA3NiAxNDguNjI1IDI1LjIwNzIgMTQ4Ljc1OCAyNS4zOTM2QzE0OC44MzggMjUuNTAwMSAxNDguOTMyIDI1LjYwNjYgMTQ5LjA5MiAyNS43Mzk3QzE0Ny4zNTYgMjUuNzM5NyAxNDUuNjIxIDI1LjczOTcgMTQzLjg3MiAyNS43Mzk3QzE0My45OTIgMjUuNjE5OSAxNDQuMDk4IDI1LjUwMDEgMTQ0LjIwNSAyNS4zODAzQzE0NC4zMTIgMjUuMjQ3MiAxNDQuNDA2IDI1LjEyNzQgMTQ0LjQ3MiAyNC45ODA5QzE0NC41MzkgMjQuODQ3OCAxNDQuNTY2IDI0LjY4ODEgMTQ0LjU5MyAyNC41MjgzQzE0NC42MDYgMjQuNDM1MiAxNDQuNjE5IDI0LjMyODcgMTQ0LjYxOSAyNC4yMzU1QzE0NC42MTkgMjQuMTQyMyAxNDQuNjE5IDI0LjA0OTEgMTQ0LjYxOSAyMy45NTZDMTQ0LjYwNiAyMy4xNDQgMTQ0LjYxOSAyMi4zMTg3IDE0NC42MTkgMjEuNTA2N0MxNDQuNjE5IDIxLjE0NzMgMTQ0LjYxOSAyMC44MDEyIDE0NC42MTkgMjAuNDQxOEMxNDQuNjE5IDIwLjA4MjQgMTQ0LjYzMyAxOS43MDk3IDE0NC42MTkgMTkuMzUwM0MxNDQuNjE5IDE5LjIxNzIgMTQ0LjYwNiAxOS4wOTczIDE0NC41OTMgMTguOTc3NUMxNDQuNTY2IDE4LjgxNzggMTQ0LjQ4NiAxOC42NTgxIDE0NC4zOTIgMTguNTI1QzE0NC4yODUgMTguMzc4NSAxNDQuMTUyIDE4LjI1ODcgMTQ0LjAwNSAxOC4xNzg5QzE0My44NDUgMTguMDk5IDE0My42NDUgMTguMDU5MSAxNDMuNDcxIDE4LjA3MjRDMTQzLjIzMSAxOC4wODU3IDE0My4wMDQgMTguMTkyMiAxNDIuODQzIDE4LjM1MTlDMTQyLjY5NyAxOC40OTgzIDE0Mi41OSAxOC42ODQ3IDE0Mi41MzYgMTguODg0NEMxNDIuNDk2IDE5LjA0NDEgMTQyLjQ5NiAxOS4yMDM4IDE0Mi40OTYgMTkuMzYzNkMxNDIuNDk2IDE5LjUxIDE0Mi40OTYgMTkuNjQzMSAxNDIuNDk2IDE5Ljc4OTVDMTQyLjQ5NiAyMC4xNzU2IDE0Mi40OTYgMjAuNTc0OSAxNDIuNDk2IDIwLjk2MDlDMTQyLjQ5NiAyMS45NDYgMTQyLjUxIDIyLjkzMSAxNDIuNDk2IDIzLjkwMjdDMTQyLjQ5NiAyNC4wMzU4IDE0Mi40OTYgMjQuMTgyMyAxNDIuNDk2IDI0LjMxNTRDMTQyLjUxIDI0LjUwMTcgMTQyLjUyMyAyNC43MDE0IDE0Mi42MDMgMjQuODc0NEMxNDIuNjgzIDI1LjA3NDEgMTQyLjgxNyAyNS4yNDcyIDE0Mi45NjQgMjUuNDIwMkMxNDMuMDU3IDI1LjU0IDE0My4xNjQgMjUuNjQ2NSAxNDMuMjcxIDI1Ljc1M0MxNDEuNTIyIDI1Ljc1MyAxMzkuNzg2IDI1Ljc1MyAxMzguMDM3IDI1Ljc1M0MxMzguMTU3IDI1LjYzMzIgMTM4LjI2NCAyNS41MTM0IDEzOC4zNyAyNS4zOTM2QzEzOC40NzcgMjUuMjYwNSAxMzguNTcxIDI1LjE0MDcgMTM4LjYzOCAyNC45OTQyQzEzOC43MDQgMjQuODYxMSAxMzguNzMxIDI0LjcwMTQgMTM4Ljc1OCAyNC41NDE3QzEzOC43NzEgMjQuNDQ4NSAxMzguNzg0IDI0LjM0MiAxMzguNzg0IDI0LjI0ODhDMTM4Ljc4NCAyNC4xNTU2IDEzOC43ODQgMjQuMDYyNCAxMzguNzg0IDIzLjk2OTNDMTM4Ljc3MSAyMy4xNTczIDEzOC43ODQgMjIuMzMyIDEzOC43ODQgMjEuNTJDMTM4Ljc4NCAyMS4xNjA2IDEzOC43ODQgMjAuODE0NSAxMzguNzg0IDIwLjQ1NTFDMTM4Ljc4NCAyMC4wOTU3IDEzOC43OTggMTkuNzIzIDEzOC43ODQgMTkuMzYzNkMxMzguNzg0IDE5LjIzMDUgMTM4Ljc3MSAxOS4xMTA3IDEzOC43NTggMTguOTkwOUMxMzguNzMxIDE4LjgzMTEgMTM4LjY1MSAxOC42NzE0IDEzOC41NTcgMTguNTM4M0MxMzguNDUxIDE4LjM5MTkgMTM4LjMxNyAxOC4yNzIxIDEzOC4xNyAxOC4xOTIyQzEzOC4wMSAxOC4xMTIzIDEzNy44MSAxOC4wNzI0IDEzNy42MzYgMTguMDg1N0MxMzcuMzk2IDE4LjA5OSAxMzcuMTY5IDE4LjIwNTUgMTM3LjAwOSAxOC4zNjUyQzEzNi44NjIgMTguNTExNyAxMzYuNzU1IDE4LjY5OCAxMzYuNzAxIDE4Ljg5NzdDMTM2LjY2MSAxOS4wNTc0IDEzNi42NjEgMTkuMjE3MSAxMzYuNjYxIDE5LjM3NjlDMTM2LjY2MSAxOS41MjMzIDEzNi42NjEgMTkuNjU2NCAxMzYuNjYxIDE5LjgwMjhDMTM2LjY2MSAyMC4xODg5IDEzNi42NjEgMjAuNTg4MiAxMzYuNjYxIDIwLjk3NDJDMTM2LjY2MSAyMS45NTkzIDEzNi42NzUgMjIuOTQ0MyAxMzYuNjYxIDIzLjkxNkMxMzYuNjYxIDI0LjA0OTEgMTM2LjY2MSAyNC4xOTU2IDEzNi42NjEgMjQuMzI4N0MxMzYuNjc1IDI0LjUxNSAxMzYuNjg4IDI0LjcxNDcgMTM2Ljc2OCAyNC44ODc3QzEzNi44NDggMjUuMDg3NCAxMzYuOTgyIDI1LjI2MDUgMTM3LjEyOSAyNS40MzM1QzEzNy4yMjIgMjUuNTUzMyAxMzcuMzI5IDI1LjY1OTggMTM3LjQzNiAyNS43NjYzQzEzNS42MDcgMjUuNzI2NCAxMzMuODU4IDI1LjcyNjQgMTMyLjEwOCAyNS43MjY0WiIgZmlsbD0iIzI2MjYyNiIvPgo8L3N2Zz4='.replace('data:image/svg+xml;base64,',''), 'base64');
    res.writeHead(200, {'Content-Type':'image/svg+xml','Cache-Control':'public,max-age=86400'});
    res.end(buf); return;
  }

    // ── Shipping Dashboard ──────────────────────────────────────────
  if (pathname === '/shipping') {
    if (!isAuth(req)) { res.writeHead(302, {Location: '/'}); res.end(); return; }
    try {
      const html = fs.readFileSync(path.join(__dirname, 'shipping-dashboard.html'), 'utf8');
      res.writeHead(200, {'Content-Type':'text/html'});
      res.end(html);
    } catch(e) {
      res.writeHead(500); res.end('shipping-dashboard.html not found');
    }
    return;
  }

  // ── Live Tracking Status ─────────────────────────────────────────
  if (pathname === '/api/track' && req.method === 'GET') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    const carrier  = parsed.query.carrier  || '';
    const tracking = parsed.query.tracking || '';
    if (!tracking) { json({ error: 'No tracking number' }, 400); return; }

    const AFTERSHIP_KEY = process.env.AFTERSHIP_API_KEY || '';
    if (!AFTERSHIP_KEY) {
      json({ status: null, label: null, error: 'AfterShip not configured' });
      return;
    }

    const AS_BASE = '/tracking/2026-01';

    // Map our carrier codes to AfterShip slugs
    const slugMap = {
      'ABF':   'abf-freight',
      'OD':    'old-dominion-freight-line',
      'UPS':   'ups',
      'FedEx': 'fedex',
      'USPS':  'usps',
    };
    const slug = slugMap[carrier] || null;

    try {
      // 1. Try to create the tracking (registers it in AfterShip if new)
      const createBody = { tracking_number: tracking };
      if (slug) createBody.slug = slug;
      const createRes = await httpsRequest({
        hostname: 'api.aftership.com',
        path: `${AS_BASE}/trackings`,
        method: 'POST',
        headers: { 'as-api-key': AFTERSHIP_KEY, 'Content-Type': 'application/json' }
      }, { tracking: createBody });

      // 201 = created, 4018 = already exists — both are fine, proceed to fetch
      const createCode = createRes.body?.meta?.code;
      console.log(`AfterShip create: ${createCode} for ${tracking}`);

      // 2. Fetch tracking data
      let trackingData = null;

      // AfterShip 2026-01 API: GET by tracking_number (+ optional slug) via query params
      const fetchParams = `tracking_number=${encodeURIComponent(tracking)}${slug ? '&slug=' + encodeURIComponent(slug) : ''}`;
      const listRes = await httpsRequest({
        hostname: 'api.aftership.com',
        path: `${AS_BASE}/trackings?${fetchParams}`,
        method: 'GET',
        headers: { 'as-api-key': AFTERSHIP_KEY }
      });
      console.log(`AfterShip GET (${fetchParams}): status=${listRes.status} meta=${JSON.stringify(listRes.body?.meta)} dataKeys=${Object.keys(listRes.body?.data || {}).join(',')}`);
      // AfterShip 2026-01 returns data.trackings array
      const items = listRes.body?.data?.trackings || listRes.body?.data?.tracking ? [listRes.body.data.tracking] : [];
      if (items.length) trackingData = items[0];

      // If slug search found nothing, retry without slug (carrier may differ from what HubSpot has)
      if (!trackingData && slug) {
        const retryRes = await httpsRequest({
          hostname: 'api.aftership.com',
          path: `${AS_BASE}/trackings?tracking_number=${encodeURIComponent(tracking)}`,
          method: 'GET',
          headers: { 'as-api-key': AFTERSHIP_KEY }
        });
        console.log(`AfterShip retry (no slug): status=${retryRes.status} meta=${JSON.stringify(retryRes.body?.meta)} dataKeys=${Object.keys(retryRes.body?.data || {}).join(',')}`);
        const retryItems = retryRes.body?.data?.trackings || retryRes.body?.data?.tracking ? [retryRes.body?.data?.tracking].filter(Boolean) : [];
        if (retryItems.length) trackingData = retryItems[0];
      }

      // Last resort: try direct GET by slug/tracking path (older but sometimes works)
      if (!trackingData && slug) {
        const directRes = await httpsRequest({
          hostname: 'api.aftership.com',
          path: `${AS_BASE}/trackings/${encodeURIComponent(slug)}/${encodeURIComponent(tracking)}`,
          method: 'GET',
          headers: { 'as-api-key': AFTERSHIP_KEY }
        });
        console.log(`AfterShip direct path GET: status=${directRes.status} meta=${JSON.stringify(directRes.body?.meta)}`);
        if (directRes.body?.data?.tracking) trackingData = directRes.body.data.tracking;
      }

      if (!trackingData) {
        json({ status: 'pending', label: 'Registered', location: null, eta: null, deliveredAt: null });
        return;
      }

      // Normalize AfterShip tag → our status
      const tag = trackingData.tag || '';
      const statusMap = {
        'Delivered':          { status: 'delivered',        label: 'Delivered' },
        'OutForDelivery':     { status: 'out_for_delivery', label: 'Out for Delivery' },
        'InTransit':          { status: 'in_transit',       label: 'In Transit' },
        'AttemptFail':        { status: 'exception',        label: 'Attempt Failed' },
        'Exception':          { status: 'exception',        label: 'Exception' },
        'InfoReceived':       { status: 'pending',          label: 'Info Received' },
        'Pending':            { status: 'pending',          label: 'Pending' },
        'AvailableForPickup': { status: 'pickup',           label: 'Available for Pickup' },
      };
      const normalized = statusMap[tag] || { status: 'in_transit', label: tag || 'In Transit' };

      // Get last checkpoint
      const checkpoints = trackingData.checkpoints || [];
      const lastCheck = checkpoints[checkpoints.length - 1];
      let location = null;
      if (lastCheck) {
        const parts = [lastCheck.city, lastCheck.state, lastCheck.country_iso3].filter(Boolean);
        if (parts.length) location = parts.join(', ');
        normalized.detail = lastCheck.message || null;
      }

      const eta = trackingData.expected_delivery || trackingData.aftership_estimated_delivery_date || null;
      const deliveredAt = tag === 'Delivered' ? (trackingData.delivery_time || lastCheck?.checkpoint_time || null) : null;

      json({
        ...normalized,
        location,
        eta:         eta          ? eta.split('T')[0]          : null,
        deliveredAt: deliveredAt  ? deliveredAt.split('T')[0]  : null,
        signedBy:    trackingData.signed_by || null,
        lastEvent:   lastCheck?.message || null,
        lastEventTime: lastCheck?.checkpoint_time ? lastCheck.checkpoint_time.split('T')[0] : null,
      });
    } catch(e) {
      console.warn('AfterShip track error:', e.message);
      json({ status: null, label: null, error: e.message });
    }
    return;
  }

  // ── Shipping Board API ───────────────────────────────────────────
  if (pathname === '/api/shipping-board' && req.method === 'GET') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    try {
      // Fetch shipped deals with tracking from HubSpot
      const searchRes = await httpsRequest({
        hostname: 'api.hubapi.com',
        path: '/crm/v3/objects/deals/search',
        method: 'POST',
        headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
      }, {
        // OR across 4 scenarios: any Shipped-stage deal in last 30 days, whether it
        // has tracking/carrier set or not, using either date_shipped or closedate.
        // This ensures deals show up on the board even if Jeromy hasn't filled in
        // carrier/tracking yet — they'll show as "No tracking" rows.
        filterGroups: [
          {
            // Has date_shipped in last 30 days (fully filled out)
            filters: [
              { propertyName: 'dealstage', operator: 'EQ', value: '845719' },
              { propertyName: 'date_shipped', operator: 'GTE', value: String(Date.now() - 30 * 24 * 60 * 60 * 1000) }
            ]
          },
          {
            // No date_shipped but closedate in last 30 days
            filters: [
              { propertyName: 'dealstage', operator: 'EQ', value: '845719' },
              { propertyName: 'date_shipped', operator: 'NOT_HAS_PROPERTY' },
              { propertyName: 'closedate', operator: 'GTE', value: String(Date.now() - 30 * 24 * 60 * 60 * 1000) }
            ]
          }
        ],
        properties: ['dealname','amount','freight_carrier','tracking_number','date_shipped','hubspot_owner_id',
                     'shipping_address','shipping_city','shipping_state','shipping_zipcode','closedate'],
        sorts: [{ propertyName: 'date_shipped', direction: 'DESCENDING' }],
        limit: 100
      });

      // Keep all shipped deals — those without carrier/tracking show as "No tracking" rows
      const deals = searchRes.body.results || [];

      // Map owner IDs to names
      const ownerMap = {
        '36303670': 'Benton White',
        '36320208': 'Gabe White',
        '36330944': 'Jill Holdway',
        '38143901': 'Sarah Smith',
        '38732178': 'Kim Dalton',
        '38732186': 'Jeromy Packwood',
        '38900892': 'Chet Burgess',
        '117442978': 'Travis Singleton',
      };

      const results = deals.map(d => {
        const p = d.properties;
        const carrier = p.freight_carrier || '';
        const tracking = p.tracking_number || '';
        let trackingUrl = '';
        if (carrier === 'ABF')  trackingUrl = `https://view.arcb.com/nlo/tools/tracking/${tracking}`;
        if (carrier === 'OD')   trackingUrl = `https://www.odfl.com/us/en/tools/trace-track-ltl-freight.html?pro=${tracking}`;
        if (carrier === 'UPS')  trackingUrl = `https://www.ups.com/track?tracknum=${tracking}`;
        if (carrier === 'FedEx') trackingUrl = `https://www.fedex.com/en-us/tracking.html?tracknumbers=${tracking}`;
        if (carrier === 'USPS') trackingUrl = `https://tools.usps.com/go/TrackConfirmAction?tLabels=${tracking}`;

        return {
          dealId: d.id,
          dealName: p.dealname,
          amount: p.amount ? parseFloat(p.amount) : null,
          carrier,
          tracking,
          trackingUrl,
          dateShipped: p.date_shipped || p.closedate?.split('T')[0],
          address: [p.shipping_address, p.shipping_city, p.shipping_state, p.shipping_zipcode].filter(Boolean).join(', '),
          rep: ownerMap[p.hubspot_owner_id] || 'Unknown',
          dealUrl: `https://app.hubspot.com/contacts/5764220/deal/${d.id}`,
        };
      });

      json({ success: true, shipments: results, total: results.length });
    } catch(e) { json({ error: e.message }, 500); }
    return;
  }

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
      const q = parsed.query.q || '';
      const repId = parsed.query.rep || '';
      const limit = Math.min(parseInt(parsed.query.limit || '100'), 200);
      const offset = parseInt(parsed.query.offset || '0');

      // Try DB first, fall back to HubSpot Notes
      const dbResults = await searchQuotesInDb(q, repId, limit, offset);
      if (dbResults) {
        json({ results: dbResults.results.map(r => r.json_snapshot), total: dbResults.total, source: 'db' });
      } else {
        const history = await fetchQuoteHistory();
        json({ results: history, source: 'hubspot' });
      }
    } catch(e) { json({error: e.message}, 500); }
    return;
  }

  // ── API: Save quote to history (DB only) ─────────────────────────
  if (pathname === '/api/history' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      await saveQuoteToDb(body);
      json({ success: true });
    } catch(e) { json({error: e.message}, 500); }
    return;
  }

  // ── API: Get deals associated with a contact ──────────────────
  if (pathname.startsWith('/api/contact-deals/') && req.method === 'GET') {
    try {
      const contactId = pathname.replace('/api/contact-deals/', '').trim();
      if (!contactId) { json({ deals: [] }); return; }

      // Step 1: Get deal IDs via associations endpoint
      // NOTE: The search API's associations.contact filter is not supported —
      // must use the dedicated associations endpoint instead.
      const assocRes = await httpsRequest({
        hostname: 'api.hubapi.com',
        path: `/crm/v3/objects/contacts/${contactId}/associations/deals`,
        method: 'GET',
        headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
      });

      const dealIds = (assocRes.body?.results || []).map(r => r.id);
      if (!dealIds.length) { json({ deals: [] }); return; }

      // Step 2: Batch fetch deal details (cap at 10 most-recent by ID descending)
      const batchRes = await httpsRequest({
        hostname: 'api.hubapi.com',
        path: '/crm/v3/objects/deals/batch/read',
        method: 'POST',
        headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
      }, {
        inputs: dealIds.slice(0, 10).map(id => ({ id })),
        properties: ['dealname', 'amount', 'dealstage', 'hubspot_owner_id', 'hs_lastmodifieddate', 'closedate']
      });

      const deals = (batchRes.body?.results || [])
        .sort((a, b) => new Date(b.properties.hs_lastmodifieddate || 0) - new Date(a.properties.hs_lastmodifieddate || 0))
        .map(d => ({
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
      const { customer, lineItems, freight, tax, discount, total, ownerId, dealName, existingDealId, existingContactId, quoteNumber, billing, isRevision, linkedDealId: bodyLinkedDealId, confirmContactOverride } = body;

      // Find or create contact
      let contactId;
      if (existingContactId) {
        // Rep chose to use an existing contact from the duplicate check
        contactId = String(existingContactId);
      } else {
        const existing = await hsSearchContact(customer.email);
        if (existing.results && existing.results.length > 0) {
          contactId = existing.results[0].id;
          // Selectively update contact — only overwrite fields that are blank
          // in HubSpot, or where the quote has a value and HubSpot doesn't.
          // Never overwrite existing data blindly.
          try {
            const existingProps = existing.results[0].properties || {};
            const updateProps = {};

            if (confirmContactOverride) {
              // Rep confirmed — update all address fields
              if (customer.address) updateProps.address = customer.address;
              if (customer.city)    updateProps.city    = customer.city;
              if (customer.state)   updateProps.state   = toStateFull(customer.state);
              if (customer.zip)     updateProps.zip     = customer.zip;
              if (customer.phone)   updateProps.phone   = customer.phone;
            } else {
              // Only fill blanks — never overwrite existing data
              if (customer.address && !existingProps.address) updateProps.address = customer.address;
              if (customer.city    && !existingProps.city)    updateProps.city    = customer.city;
              if (customer.state   && !existingProps.state)   updateProps.state   = toStateFull(customer.state);
              if (customer.zip     && !existingProps.zip)     updateProps.zip     = customer.zip;
              if (customer.phone   && !existingProps.phone)   updateProps.phone   = customer.phone;
            }

            if (Object.keys(updateProps).length > 0) {
              await httpsRequest({
                hostname: 'api.hubapi.com',
                path: `/crm/v3/objects/contacts/${contactId}`,
                method: 'PATCH',
                headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
              }, { properties: updateProps });
            }
          } catch(e) {
            console.warn('Contact update skipped:', e.message);
          }
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
          dealstage: isRevision ? 'qualifiedtobuy' : 'appointmentscheduled',
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

      // Save to PostgreSQL DB (primary storage)
      try {
        await saveQuoteToDb({
          quoteNumber, dealId, contactId, dealName, ownerId, total,
          date: new Date().toLocaleDateString('en-US', {month:'short',day:'numeric',year:'numeric'}),
          customer, lineItems, discount, freight, tax,
        });
      } catch(e) { console.warn('DB save error:', e.message); }

      // HubSpot Notes write removed — DB is primary storage

      json({
        success: true,
        dealId,
        contactId,
        quoteNumber,
        dealUrl: `https://app.hubspot.com/contacts/5764220/record/0-3/${dealId}`
      });

    } catch(e) {
      json({error: e.message}, 500);
    }
    return;
  }

  // ── Shareable Quote Page ─────────────────────────────────────────

  // ── Invoice Page (/i/:quoteNumber) ──────────────────────────────
  if (pathname.startsWith('/i/') && req.method === 'GET') {
    const quoteId = decodeURIComponent(pathname.replace('/i/', '').trim());
    if (!quoteId) { res.writeHead(404); res.end('Not found'); return; }
    try {
      let quoteData = await getQuoteFromDb(quoteId);
      if (!quoteData) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><head><title>Invoice Not Found</title><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;background:#f5f5f5}div{text-align:center}</style></head><body><div><h2 style="color:#ee6216">Invoice Not Found</h2><p style="color:#888">This link may have expired or the invoice number is incorrect.</p></div></body></html>');
        return;
      }

      // Get payment link from DB
      let paymentUrl = null;
      if (db) {
        try {
          const pr = await db.query('SELECT payment_link FROM quotes WHERE quote_number = $1', [quoteId]);
          paymentUrl = pr.rows[0]?.payment_link || null;
        } catch(e) {}
      }

      const q = quoteData;
      const fmt = n => '$' + parseFloat(n||0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,',');
      const sub = (q.lineItems||[]).reduce((s,i)=>s+(i.price*i.qty),0);
      const disc = q.discount && q.discount.value > 0
        ? (q.discount.type==='pct' ? sub*q.discount.value/100 : q.discount.value) : 0;
      const freightAmt = q.freight ? q.freight.total : 0;
      const taxAmt = q.tax ? q.tax.tax : 0;
      const total = sub - disc + freightAmt + taxAmt;
      const c = q.customer || {};

      const lineRows = (q.lineItems||[]).map(item =>
        `<tr>
          <td style="padding:12px 0;border-bottom:1px solid #f5f5f5;padding-right:16px">
            <div class="item-name">${item.name}</div>
            ${item.description?`<div class="item-desc">${item.description}</div>`:''}
          </td>
          <td style="padding:12px 0;border-bottom:1px solid #f5f5f5;text-align:center;color:#888;width:50px">${item.qty}</td>
          <td style="padding:12px 0;border-bottom:1px solid #f5f5f5;text-align:right;color:#888;width:110px">${fmt(item.price)}</td>
          <td style="padding:12px 0;border-bottom:1px solid #f5f5f5;text-align:right;font-weight:700;color:#1a1a1a;width:110px">${fmt(item.price*item.qty)}</td>
        </tr>`
      ).join('');

      const issueDate = q.date || new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhisperRoom Invoice ${q.quoteNumber||''}</title>
<link rel="icon" href="/assets/favicon.avif">
<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f2f2f2;color:#333;-webkit-font-smoothing:antialiased}
.page{max-width:820px;margin:0 auto;padding:28px 16px 120px}
.header-card{background:#1a1a1a;padding:28px 40px 24px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:16px}
.logo-img{height:22px;display:block;filter:brightness(0) invert(1)}
.header-right{text-align:right}
.quote-type{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.14em;color:#ee6216;margin-bottom:6px}
.quote-num{font-size:28px;font-weight:800;color:#ffffff;letter-spacing:-.5px;font-variant-numeric:tabular-nums;line-height:1}
.quote-meta{font-size:11px;color:rgba(255,255,255,.35);margin-top:5px}
.accent-strip{height:3px;background:linear-gradient(90deg,#ee6216,#ff8c42);margin-bottom:20px}
.card{background:#fff;border-radius:10px;padding:28px 32px;margin:0 16px 12px;box-shadow:0 1px 4px rgba(0,0,0,.07)}
.card-label{font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.14em;color:#ee6216;margin-bottom:16px}
.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.info-item label{font-size:10px;color:#aaa;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:3px}
.info-item span{font-size:14px;font-weight:600;color:#1a1a1a}
table{width:100%;border-collapse:collapse}
thead th{font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:#bbb;padding:0 0 14px;border-bottom:1px solid #f0f0f0;text-align:left}
thead th:nth-child(2){text-align:center}
thead th:nth-child(3),thead th:nth-child(4){text-align:right}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover td{background:#fafafa}
.item-name{font-weight:700;color:#1a1a1a;font-size:14px}
.item-desc{font-size:11px;color:#aaa;margin-top:3px;line-height:1.5}
.totals{max-width:320px;margin-left:auto;margin-top:24px;padding-top:20px;border-top:1px solid #eee}
.tot{display:flex;justify-content:space-between;padding:6px 0;font-size:13px;color:#888}
.tot.grand{font-size:22px;font-weight:800;color:#1a1a1a;padding-top:16px;margin-top:8px;border-top:2px solid #1a1a1a}
.tot.grand span:last-child{color:#ee6216}
.discount-val{color:#1a7a4a!important;font-weight:600}
.terms{font-size:11px;color:#aaa;line-height:1.9}
.action-bar{position:fixed;bottom:0;left:0;right:0;background:rgba(26,26,26,.97);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-top:1px solid rgba(255,255,255,.08);padding:14px 24px;display:flex;gap:10px;justify-content:center;z-index:100}
.btn{padding:13px 30px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;border:none;letter-spacing:.04em;font-family:inherit;transition:all .15s}
.btn-pay{background:#ee6216;color:white;font-size:14px;padding:13px 36px}
.btn-pay:hover{background:#d4561a;transform:translateY(-1px);box-shadow:0 4px 20px rgba(238,98,22,.45)}
.btn-secondary{background:rgba(255,255,255,.06);color:rgba(255,255,255,.5);border:1px solid rgba(255,255,255,.08)}
.btn-secondary:hover{background:rgba(255,255,255,.1);color:rgba(255,255,255,.7)}
.footer{text-align:center;margin:20px 16px 0;padding:20px 0;font-size:11px;color:#aaa;line-height:2;border-top:1px solid #e0e0e0}
.footer a{color:#ee6216;text-decoration:none}
.footer strong{color:#555;font-weight:600}
@media(max-width:560px){
  .header-card{padding:22px 20px}
  .header-right{text-align:left}
  .quote-num{font-size:22px}
  .card{padding:20px;margin:0 10px 10px}
  .info-grid{grid-template-columns:1fr}
  .action-bar{flex-direction:column;padding:12px 16px}
  .btn{width:100%;text-align:center}
}
@media print{
  body{background:white}
  .action-bar{display:none!important}
  .page{padding-bottom:20px}
  .header-card{background:#1a1a1a!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .card{box-shadow:none;border:1px solid #eee;margin:0 0 10px}
}
</style>
</head>
<body>
<div class="page">

  <div class="header-card">
    <img src="/assets/logo-orange.svg" alt="WhisperRoom" class="logo-img">
    <div class="header-right">
      <div class="quote-type">Invoice</div>
      <div class="quote-num">${q.quoteNumber||'INV'}</div>
      <div class="quote-meta">Issued ${issueDate}</div>
    </div>
  </div>
  <div class="accent-strip"></div>

  ${c.firstName ? `<div class="card">
    <div class="card-label">Billed To</div>
    <div class="info-grid">
      <div class="info-item"><label>Name</label><span>${c.firstName} ${c.lastName}</span></div>
      ${c.company?`<div class="info-item"><label>Company</label><span>${c.company}</span></div>`:''}
      ${c.email?`<div class="info-item"><label>Email</label><span>${c.email}</span></div>`:''}
      ${c.address?`<div class="info-item"><label>Ship To</label><span>${c.address}, ${c.city}, ${c.state} ${c.zip}</span></div>`:''}
    </div>
  </div>` : ''}

  <div class="card">
    <div class="card-label">Products &amp; Services</div>
    <table>
      <thead><tr><th>Item</th><th style="text-align:center">Qty</th><th style="text-align:right">Unit Price</th><th style="text-align:right">Total</th></tr></thead>
      <tbody>${lineRows}</tbody>
    </table>
    <div class="totals">
      <div class="tot"><span>Subtotal</span><span>${fmt(sub)}</span></div>
      ${disc>0?`<div class="tot"><span>Discount${q.discount.type==='pct'?' ('+q.discount.value+'%)':''}</span><span class="discount-val">-${fmt(disc)}</span></div>`:''}
      ${freightAmt>0?`<div class="tot"><span>Freight</span><span>${fmt(freightAmt)}</span></div>`:''}
      ${taxAmt>0?`<div class="tot"><span>Sales Tax</span><span>${fmt(taxAmt)}</span></div>`:''}
      <div class="tot grand"><span>Amount Due</span><span>${fmt(total)}</span></div>
    </div>
  </div>

  <div class="card">
    <div class="card-label">Payment Terms</div>
    <p class="terms">Payment is due upon receipt. We accept ACH bank transfer and major credit/debit cards. For questions regarding this invoice, contact us at <a href="mailto:info@whisperroom.com" style="color:#ee6216">info@whisperroom.com</a> or (865) 558-5364.</p>
  </div>

  <div class="footer">
    <strong>WhisperRoom, Inc.</strong> &middot; 322 Nancy Lynn Lane, Suite 14 &middot; Knoxville, TN 37919<br>
    <a href="tel:18002008168">1-800-200-8168</a> &middot; <a href="mailto:info@whisperroom.com">info@whisperroom.com</a> &middot; <a href="https://www.whisperroom.com" target="_blank">whisperroom.com</a>
  </div>

</div>

<div class="action-bar" id="action-bar">
  ${paymentUrl
    ? `<button class="btn btn-pay" onclick="window.open('${paymentUrl}','_blank')">&#x1F4B3;&nbsp;&nbsp;Pay Now — ${fmt(total)}</button>`
    : `<button class="btn btn-pay" style="opacity:.5;cursor:not-allowed" title="Payment link not available">&#x1F4B3;&nbsp;&nbsp;Pay Now — ${fmt(total)}</button>`
  }
  <button class="btn btn-secondary" onclick="window.print()">&#x2B07;&nbsp;&nbsp;Download PDF</button>
</div>

<script>
  document.title = 'Invoice ${q.quoteNumber||''}${q.dealName ? ' — ' + q.dealName.replace(/[<>]/g,'') : ''}';
</script>
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

    if (pathname.startsWith('/q/') && req.method === 'GET') {
    const quoteId = decodeURIComponent(pathname.replace('/q/', '').trim());
    if (!quoteId) { res.writeHead(404); res.end('Not found'); return; }
    try {
      let quoteData = await getQuoteFromDb(quoteId);

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
        `<tr>
          <td style="padding:12px 0;border-bottom:1px solid #f5f5f5;padding-right:16px">
            <div class="item-name">${item.name}</div>
            ${item.description?`<div class="item-desc">${item.description}</div>`:''}
          </td>
          <td style="padding:12px 0;border-bottom:1px solid #f5f5f5;text-align:center;color:#888;width:50px">${item.qty}</td>
          <td style="padding:12px 0;border-bottom:1px solid #f5f5f5;text-align:right;color:#888;width:110px">${fmt(item.price)}</td>
          <td style="padding:12px 0;border-bottom:1px solid #f5f5f5;text-align:right;font-weight:700;color:#1a1a1a;width:110px">${fmt(item.price*item.qty)}</td>
        </tr>`
      ).join('');

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhisperRoom Quote ${q.quoteNumber||''}</title>
<link rel="icon" href="/assets/favicon.avif">
<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;0,9..40,800;1,9..40,400&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f7f6f4;color:#1a1a1a;-webkit-font-smoothing:antialiased}
.page{max-width:840px;margin:0 auto;padding:0 0 110px}

/* Header — white with orange left border */
.header-card{background:#ffffff;padding:32px 40px 28px;margin-bottom:0;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:20px;border-left:6px solid transparent;border-image:linear-gradient(to bottom,#ee6216 0%,rgba(238,98,22,.15) 70%,transparent 100%) 1;box-shadow:0 2px 12px rgba(0,0,0,.08)}
.logo-img{height:40px;display:block}
.header-right{text-align:right}
.quote-type{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.16em;color:#ee6216;margin-bottom:8px}
.quote-num{font-size:34px;font-weight:800;color:#1a1a1a;letter-spacing:-.8px;font-variant-numeric:tabular-nums;line-height:1}
.quote-meta{font-size:12px;color:#aaa;margin-top:6px}
.quote-valid-tag{display:inline-block;margin-top:8px;background:#ee6216;color:white;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;padding:4px 12px;border-radius:3px}

/* Divider */
.accent-strip{height:1px;background:#eee;margin-bottom:20px}

/* Cards */
.card{background:#fff;border-radius:10px;padding:30px 36px;margin:0 0 12px;box-shadow:0 1px 4px rgba(0,0,0,.06);border:1px solid #f0f0f0}
.card-label{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;color:#ee6216;margin-bottom:18px}
.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.info-item label{font-size:10px;color:#bbb;text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:4px}
.info-item span{font-size:14px;font-weight:600;color:#1a1a1a}

/* Table */
table{width:100%;border-collapse:collapse}
thead th{font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;color:#ccc;padding:0 0 16px;border-bottom:2px solid #f5f5f5;text-align:left}
thead th:nth-child(2){text-align:center}
thead th:nth-child(3),thead th:nth-child(4){text-align:right}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover td{background:#fdfcfb}
.item-name{font-weight:700;color:#1a1a1a;font-size:14px}
.item-desc{font-size:11px;color:#bbb;margin-top:4px;line-height:1.6}

/* Totals */
.totals{max-width:320px;margin-left:auto;margin-top:28px;padding-top:20px;border-top:2px solid #f5f5f5}
.tot{display:flex;justify-content:space-between;padding:7px 0;font-size:13px;color:#999}
.tot.grand{font-size:26px;font-weight:800;color:#1a1a1a;padding-top:18px;margin-top:10px;border-top:2px solid #1a1a1a}
.tot.grand span:last-child{color:#ee6216}
.discount-val{color:#1a7a4a!important;font-weight:600}

/* Terms */
.terms{font-size:11px;color:#bbb;line-height:1.9}

/* Bottom bar */
.action-bar{position:fixed;bottom:0;left:0;right:0;background:rgba(20,20,20,.97);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-top:1px solid rgba(255,255,255,.06);padding:16px 28px;display:flex;gap:12px;justify-content:center;align-items:center;z-index:100}
.btn{padding:13px 32px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;border:none;letter-spacing:.04em;font-family:inherit;transition:all .15s}
.btn-primary{background:rgba(255,255,255,.08);color:rgba(255,255,255,.65);border:1px solid rgba(255,255,255,.12)}
.btn-primary:hover{background:rgba(255,255,255,.14);color:white}
.btn-secondary{background:rgba(255,255,255,.05);color:rgba(255,255,255,.45);border:1px solid rgba(255,255,255,.08)}
.btn-secondary:hover{background:rgba(255,255,255,.09);color:rgba(255,255,255,.65)}
.btn-accept{background:#ee6216;color:white;font-size:14px;font-weight:800;padding:14px 40px;letter-spacing:.02em}
.btn-accept:hover{background:#d4561a;transform:translateY(-1px);box-shadow:0 6px 24px rgba(238,98,22,.5)}

/* Footer */
.footer{text-align:center;margin:24px 0 0;padding:24px 32px;font-size:11px;color:#bbb;line-height:2.1;border-top:1px solid #ece9e4}
.footer a{color:#ee6216;text-decoration:none}
.footer strong{color:#888;font-weight:600}

@media(max-width:600px){
  .header-card{padding:24px 20px;border-left:4px solid transparent;border-image:linear-gradient(to bottom,#ee6216 0%,rgba(238,98,22,.15) 70%,transparent 100%) 1}
  .logo-img{height:30px}
  .header-right{text-align:left}
  .quote-num{font-size:26px}
  .card{padding:22px 20px}
  .info-grid{grid-template-columns:1fr}
  .action-bar{flex-direction:column;padding:14px 16px}
  .btn{width:100%;text-align:center}
}
@media print{
  body{background:white}
  .action-bar{display:none!important}
  .page{padding-bottom:20px}
  .header-card{border-left:6px solid #ee6216!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;border-image:none!important}
  .card{box-shadow:none}
}
</style>
</head>
<body>
<div class="page">

  <div class="header-card">
    <img src="/assets/logo-black.svg" alt="WhisperRoom" class="logo-img">
    <div class="header-right">
      <div class="quote-type">Price Quote</div>
      <div class="quote-num">${q.quoteNumber||'QUOTE'}</div>
      <div class="quote-meta">Issued ${q.date||new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</div>
      <div class="quote-valid-tag">Valid 30 Days</div>
    </div>
  </div>
  <div class="accent-strip"></div>

  ${c.firstName ? `<div class="card">
    <div class="card-label">Prepared For</div>
    <div class="info-grid">
      <div class="info-item"><label>Name</label><span>${c.firstName} ${c.lastName}</span></div>
      ${c.company?`<div class="info-item"><label>Company</label><span>${c.company}</span></div>`:''}
      ${c.email?`<div class="info-item"><label>Email</label><span>${c.email}</span></div>`:''}
      ${c.address?`<div class="info-item"><label>Ship To</label><span>${c.address}, ${c.city}, ${c.state} ${c.zip}</span></div>`:''}
    </div>
  </div>` : ''}

  <div class="card">
    <div class="card-label">Products &amp; Services</div>
    <table>
      <thead><tr><th>Item</th><th style="text-align:center">Qty</th><th style="text-align:right">Unit Price</th><th style="text-align:right">Total</th></tr></thead>
      <tbody>${lineRows}</tbody>
    </table>
    <div class="totals">
      <div class="tot"><span>Subtotal</span><span>${fmt(sub)}</span></div>
      ${disc>0?`<div class="tot"><span>Discount${q.discount.type==='pct'?' ('+q.discount.value+'%)':''}</span><span class="discount-val">-${fmt(disc)}</span></div>`:''}
      ${freight>0?`<div class="tot"><span>Freight</span><span>${fmt(freight)}</span></div>`:''}
      ${tax>0?`<div class="tot"><span>Sales Tax${q.tax&&q.tax.rate?' ('+( q.tax.rate*100).toFixed(2).replace(/\.?0+$/,'')+')%':''}</span><span>${fmt(tax)}</span></div>`:''}
      <div class="tot grand"><span>Total</span><span>${fmt(total)}</span></div>
    </div>
  </div>

  <div class="card">
    <div class="card-label">Terms &amp; Conditions</div>
    <p class="terms">I understand that WhisperRooms are not 100% soundproof. I understand that all products manufactured by WhisperRoom, Inc. are for indoor use only. Any returns will be at the sole discretion of WhisperRoom, Inc. and are subject to a restocking fee and freight charges. Any damage during shipping must be reported within five business days. Compliance with local, state and national building codes is my responsibility. Any alterations to the WhisperRoom will void the warranty.</p>
  </div>

  <div class="footer">
    <strong>WhisperRoom, Inc.</strong> &middot; 322 Nancy Lynn Lane, Suite 14 &middot; Knoxville, TN 37919<br>
    <a href="tel:18002008168">1-800-200-8168</a> &middot; <a href="mailto:info@whisperroom.com">info@whisperroom.com</a> &middot; <a href="https://www.whisperroom.com" target="_blank">whisperroom.com</a><br>
    Shipping charges are based on the zip code provided and may vary. Quote valid 30 days from issue date.
  </div>

</div>

<!-- Foam/Hinge selection modal -->
<div id="accept-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:200;align-items:center;justify-content:center;padding:16px">
  <div style="background:white;border-radius:14px;padding:32px;max-width:440px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.3)">
    <h2 style="font-size:18px;font-weight:800;color:#1a1a1a;margin-bottom:6px">One last step!</h2>
    <p style="font-size:13px;color:#888;margin-bottom:24px">Please answer the following before accepting your quote. These are required before your order ships — you can choose <em>Undecided</em> if you need more time.</p>

    <div style="margin-bottom:20px">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#555;margin-bottom:10px">Foam Color</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px" id="foam-grid">
        ${['Gray','Blue','Purple','Orange','Burgundy','Undecided'].map(c => `
        <label class="sel-label" style="display:flex;align-items:center;gap:8px;padding:10px 12px;border:2px solid #eee;border-radius:8px;cursor:pointer;font-size:14px;font-weight:500;transition:all .15s">
          <input type="radio" name="foam" value="${c}" style="accent-color:#ee6216" onchange="updateLabels()"> ${c}
        </label>`).join('')}
      </div>
    </div>

    <div style="margin-bottom:28px">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#555;margin-bottom:10px">Door Hinge</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px" id="hinge-grid">
        ${['Left Hand','Right Hand','Undecided'].map(h => `
        <label class="sel-label" style="display:flex;align-items:center;gap:8px;padding:10px 12px;border:2px solid #eee;border-radius:8px;cursor:pointer;font-size:14px;font-weight:500;transition:all .15s">
          <input type="radio" name="hinge" value="${h}" style="accent-color:#ee6216" onchange="updateLabels()"> ${h}
        </label>`).join('')}
      </div>
    </div>

    <div style="margin-bottom:20px">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#555;margin-bottom:8px">Message to WhisperRoom <span style="font-weight:400;text-transform:none;letter-spacing:0;color:#bbb">(optional)</span></div>
      <textarea id="customer-note" rows="3" placeholder="Any questions, special instructions, or delivery notes..." style="width:100%;padding:10px 12px;border:2px solid #eee;border-radius:8px;font-size:14px;font-family:inherit;resize:vertical;box-sizing:border-box"></textarea>
    </div>

    <p style="font-size:12px;color:#bbb;margin:0 0 16px;text-align:center">These selections are required before your order ships. Choose <em>Undecided</em> if you need more time — a WhisperRoom rep will follow up.</p>

    <div style="display:flex;gap:10px">
      <button onclick="submitAcceptance()" style="flex:1;padding:13px;background:#ee6216;color:white;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer">
        ✓ Accept Quote
      </button>
      <button onclick="document.getElementById('accept-modal').style.display='none'" style="padding:13px 18px;background:#f0f0f0;color:#555;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">
        Cancel
      </button>
    </div>
  </div>
</div>

<div class="action-bar" id="action-bar">
  <button class="btn btn-accept" id="accept-btn" onclick="acceptQuote()">&#x2713;&nbsp;&nbsp;Accept This Quote</button>
  <button class="btn btn-primary" onclick="window.print()">&#x2B07;&nbsp;&nbsp;Download PDF</button>
  <button class="btn btn-secondary" id="share-btn" onclick="(function(b){if(navigator.clipboard){navigator.clipboard.writeText(window.location.href).then(function(){b.textContent='\u2713 Copied!';setTimeout(function(){b.textContent='Share Link'},2000)}).catch(function(){prompt('Copy link:',window.location.href)})}else{prompt('Copy link:',window.location.href)}})(this)">Share Link</button>
</div>

<div id="accepted-bar" style="display:none;position:fixed;bottom:0;left:0;right:0;background:#1a7a4a;color:white;text-align:center;padding:20px;font-size:15px;font-weight:700;z-index:100;font-family:inherit">
  &#x2713;&nbsp;&nbsp;Quote Accepted &mdash; A WhisperRoom representative will be in touch shortly.
</div>

<script>
  document.title = 'Quote ${q.quoteNumber||''}${q.dealName ? ' - ' + q.dealName.replace(/[<>]/g,'') : ''}';

  function updateLabels() {
    // Reset all label borders, then highlight only the selected one per group
    document.querySelectorAll('.sel-label').forEach(l => {
      l.style.borderColor = '#eee';
      l.style.background = 'white';
    });
    document.querySelectorAll('input[name="foam"]:checked, input[name="hinge"]:checked').forEach(inp => {
      const label = inp.closest('.sel-label');
      if (label) {
        label.style.borderColor = '#ee6216';
        label.style.background = '#fff8f0';
      }
    });
  }

  async function acceptQuote() {
    const btn = document.getElementById('accept-btn');
    if (!btn) return;

    // Show foam/hinge selection modal first
    const modal = document.getElementById('accept-modal');
    if (modal) { modal.style.display = 'flex'; return; }
  }

  async function submitAcceptance() {
    const foam  = document.querySelector('input[name="foam"]:checked')?.value  || '';
    const hinge = document.querySelector('input[name="hinge"]:checked')?.value || '';
    const customerNote = (document.getElementById('customer-note')?.value || '').trim();
    // Foam and hinge are optional — no validation required

    document.getElementById('accept-modal').style.display = 'none';
    const btn = document.getElementById('accept-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = 'Processing…'; }

    try {
      const res = await fetch('/api/accept-quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteNumber: '${q.quoteNumber || ""}',
          dealId: '${q.dealId || ""}',
          contactEmail: '${q.customer ? (q.customer.email || "") : ""}',
          foamColor: foam,
          hingePreference: hinge,
          customerNote: customerNote,
        })
      });
      const data = await res.json();
      if (data.success) {
        document.getElementById('action-bar').style.display = 'none';
        document.getElementById('accepted-bar').style.display = 'block';
        window.scrollTo(0, 0);
      } else {
        if (btn) { btn.disabled = false; btn.innerHTML = '✓  Accept This Quote'; }
        alert('Something went wrong. Please contact WhisperRoom at (865) 558-5364.');
      }
    } catch(e) {
      if (btn) { btn.disabled = false; btn.innerHTML = '✓  Accept This Quote'; }
    }
  }
</script>
</body>
</html>`;;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end('<h2 style="font-family:sans-serif;padding:40px">Error: ' + e.message + '</h2>');
    }
    return;
  }

  // ── API: Batch check current prices for line items ──────────────
  if (pathname === '/api/check-prices' && req.method === 'POST') {
    try {
      const { items } = JSON.parse(await readBody(req));
      if (!items || !items.length) { json({ results: [] }); return; }

      // Only check items that have a productId
      const toCheck = items.filter(i => i.productId);
      if (!toCheck.length) { json({ results: [] }); return; }

      // Fetch current prices in parallel
      const checks = await Promise.all(toCheck.map(async item => {
        try {
          const res = await httpsRequest({
            hostname: 'api.hubapi.com',
            path: `/crm/v3/objects/products/${item.productId}?properties=name,price`,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
          });
          const current = parseFloat(res.body?.properties?.price || 0);
          const quoted  = parseFloat(item.price || 0);
          return {
            productId: item.productId,
            name: item.name,
            quotedPrice: quoted,
            currentPrice: current,
            changed: Math.abs(current - quoted) > 0.01
          };
        } catch(e) {
          return { productId: item.productId, name: item.name, error: true };
        }
      }));

      json({ results: checks });
    } catch(e) { json({ error: e.message }, 500); }
    return;
  }

  // ── API: Accept Quote (from shareable link page) ──────────────
  if (pathname === '/api/accept-quote' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const { quoteNumber } = body;
      // dealId comes from the quote snapshot in DB or HubSpot — more reliable than embedded template
      let dealId = body.dealId;

      // If dealId is missing or empty, look it up from the DB or HubSpot snapshot
      if (!dealId) {
        const snapshot = await getQuoteFromDb(quoteNumber);
        if (snapshot && snapshot.dealId) {
          dealId = snapshot.dealId;
        }
      }

      console.log(`Accept quote #${quoteNumber} → dealId: ${dealId}`);
      const results = { quoteNumber, resolvedDealId: dealId };

      // 1. Advance deal stage to Verbal Confirmation
      if (dealId) {
        const stageRes = await httpsRequest({
          hostname: 'api.hubapi.com',
          path: `/crm/v3/objects/deals/${dealId}`,
          method: 'PATCH',
          headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
        }, { properties: { dealstage: 'contractsent' } });
        results.stageUpdated = !stageRes.body.error;
        if (stageRes.body.error) console.warn('Stage update failed:', stageRes.body.message);
      } else {
        results.warning = 'No dealId found — stage not updated';
        console.warn(`Accept quote #${quoteNumber}: no dealId found`);
      }

      // 2. Create a HubSpot task for the deal owner
      if (dealId) {
        // Get deal owner first
        const dealData = await httpsRequest({
          hostname: 'api.hubapi.com',
          path: `/crm/v3/objects/deals/${dealId}?properties=hubspot_owner_id,dealname`,
          method: 'GET',
          headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
        });
        const ownerId = dealData.body?.properties?.hubspot_owner_id;
        const dealName = dealData.body?.properties?.dealname || 'Deal';

        if (ownerId) {
          const dueDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
          await httpsRequest({
            hostname: 'api.hubapi.com',
            path: '/crm/v3/objects/tasks',
            method: 'POST',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
          }, {
            properties: {
              hs_task_subject: `🔔 ACCEPTED — ${dealName} — Quote #${quoteNumber}`,
              hs_task_body: `Customer accepted quote #${quoteNumber} for ${dealName}. Ready to create invoice.\n\nFoam Color: ${body.foamColor || 'Not selected'}\nHinge: ${body.hingePreference || 'Not selected'}${body.customerNote ? '\n\nCustomer Note: "' + body.customerNote + '"' : ''}`,
              hubspot_owner_id: ownerId,
              hs_task_status: 'NOT_STARTED',
              hs_task_type: 'TODO',
              hs_timestamp: new Date().toISOString(),
              hs_task_priority: 'HIGH',
            },
            associations: dealId ? [{ to: { id: dealId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 216 }] }] : []
          });
          results.taskCreated = true;
        }

        // Rep notified via HubSpot task (see below)
      }

      // 3. Log a plain note on the deal (NOT a WR_QUOTE_DATA note — just an activity log)
      if (dealId) {
        const acceptNote = await httpsRequest({
          hostname: 'api.hubapi.com',
          path: '/crm/v3/objects/notes',
          method: 'POST',
          headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
        }, {
          properties: {
            hs_note_body: `✓ Quote #${quoteNumber} accepted by customer on ${new Date().toLocaleDateString('en-US', {month:'long',day:'numeric',year:'numeric'})}.\n\nFoam Color: ${body.foamColor || 'Not selected'}\nHinge Preference: ${body.hingePreference || 'Not selected'}${body.customerNote ? '\n\nCustomer Note: "' + body.customerNote + '"' : ''}`,
            hs_timestamp: new Date().toISOString(),
          },
          associations: [{
            to: { id: dealId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }]
          }]
        });
        results.noteLogged = !!acceptNote.body?.id;
      }

      json({ success: true, results });
    } catch(e) { json({ error: e.message }, 500); }
    return;
  }

  // ── Batch register tracking numbers with AfterShip ───────────────
  if (pathname === '/api/register-trackings' && req.method === 'POST') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    const AFTERSHIP_KEY = process.env.AFTERSHIP_API_KEY || '';
    if (!AFTERSHIP_KEY) { json({ ok: true, skipped: 'no key' }); return; }

    try {
      const items = JSON.parse(await readBody(req));
      const AS_BASE = '/tracking/2026-01';
      const slugMap = { ABF: 'abf-freight', OD: 'old-dominion-freight-line', UPS: 'ups', FedEx: 'fedex', USPS: 'usps' };

      // Register in parallel batches of 5
      const results = [];
      for (let i = 0; i < items.length; i += 5) {
        const batch = items.slice(i, i + 5);
        await Promise.all(batch.map(async item => {
          if (!item.tracking) return;
          const slug = slugMap[item.carrier] || null;
          const body = { tracking: { tracking_number: item.tracking } };
          if (slug) body.tracking.slug = slug;
          try {
            const res = await httpsRequest({
              hostname: 'api.aftership.com',
              path: `${AS_BASE}/trackings`,
              method: 'POST',
              headers: { 'as-api-key': AFTERSHIP_KEY, 'Content-Type': 'application/json' }
            }, body);
            const code = res.body?.meta?.code;
            // 201 = created, 4018 = already exists — both fine
            results.push({ tracking: item.tracking, code });
          } catch(e) {
            results.push({ tracking: item.tracking, error: e.message });
          }
        }));
      }

      const created = results.filter(r => r.code === 201).length;
      const existing = results.filter(r => r.code === 4018).length;
      console.log(`AfterShip batch register: ${created} new, ${existing} existing`);
      json({ ok: true, created, existing, total: results.length });
    } catch(e) {
      console.warn('Batch register error:', e.message);
      json({ ok: false, error: e.message });
    }
    return;
  }

  // ── HubSpot Webhook: tracking_number property changed ───────────
  // HubSpot calls this when tracking_number is set on a deal
  if (pathname === '/api/webhooks/tracking-updated' && req.method === 'POST') {
    try {
      const events = JSON.parse(await readBody(req));
      const AFTERSHIP_KEY = process.env.AFTERSHIP_API_KEY || '';

      // Process in background — respond immediately to HubSpot
      json({ received: true });

      if (!AFTERSHIP_KEY) return;

      const AS_BASE = '/tracking/2026-01';

      // HubSpot sends an array of property change events
      const items = Array.isArray(events) ? events : [events];
      for (const event of items) {
        const tracking = event.propertyValue || event.value || '';
        const dealId   = event.objectId || event.dealId || '';
        if (!tracking || tracking.trim() === '') continue;

        // Get the deal's freight_carrier to determine slug
        let slug = null;
        try {
          const dealRes = await httpsRequest({
            hostname: 'api.hubapi.com',
            path: `/crm/v3/objects/deals/${dealId}?properties=freight_carrier,dealname`,
            method: 'GET',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}` }
          });
          const carrier = dealRes.body?.properties?.freight_carrier || '';
          const dealName = dealRes.body?.properties?.dealname || dealId;
          const slugMap = { ABF: 'abf-freight', OD: 'old-dominion-freight-line', UPS: 'ups', FedEx: 'fedex', USPS: 'usps' };
          slug = slugMap[carrier] || null;
          console.log(`Webhook: registering ${tracking} (${carrier}/${slug}) for "${dealName}"`);
        } catch(e) { console.warn('Webhook deal lookup failed:', e.message); }

        // Register with AfterShip
        try {
          const body = { tracking: { tracking_number: tracking } };
          if (slug) body.tracking.slug = slug;
          const asRes = await httpsRequest({
            hostname: 'api.aftership.com',
            path: `${AS_BASE}/trackings`,
            method: 'POST',
            headers: { 'as-api-key': AFTERSHIP_KEY, 'Content-Type': 'application/json' }
          }, body);
          const code = asRes.body?.meta?.code;
          // 201 = created, 4018 = already exists — both fine
          console.log(`AfterShip register ${tracking}: code ${code}`);
        } catch(e) { console.warn('AfterShip register failed:', e.message); }
      }
    } catch(e) {
      console.warn('Webhook error:', e.message);
      json({ error: e.message }, 500);
    }
    return;
  }

  // ── Admin: Backfill tracking numbers via contact email lookup ────
  if (pathname === '/api/admin/backfill-tracking' && req.method === 'POST') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    // Fire and forget — return immediately, run in background
    json({ success: true, message: 'Backfill started in background. Check /api/admin/backfill-status for progress.' });
    try {
      // Map: customer email → tracking number + carrier
      const emailToTracking = {
  "timothy.j.masi@us.mcd.com": { tracking: "78077872246", carrier: "OD" },
  "jon.olivier@grainger.com": { tracking: "248007092", carrier: "ABF" },
  "nedad@wardenwoods.com": { tracking: "248007097", carrier: "ABF" },
  "michael.yanez@microsoft.com": { tracking: "248007084", carrier: "ABF" },
  "catherine.massengale@ttu.edu": { tracking: "78078696057", carrier: "OD" },
  "jcortner@missionmobilemed.com": { tracking: "78078524150", carrier: "OD" },
  "riley.w@hellohearingstudios.com": { tracking: "78078713803", carrier: "OD" },
  "admin@kavnhealth.com": { tracking: "248006552", carrier: "ABF" },
  "noahstern00@gmail.com": { tracking: "78078096381", carrier: "OD" },
  "macguarnieri@aol.com": { tracking: "248007091", carrier: "ABF" },
  "realminseok@hotmail.com": { tracking: "248859712", carrier: "OD" },
  "jperez2@bartonhealth.org": { tracking: "248007093", carrier: "ABF" },
  "brady.lorenzen@mayo.edu": { tracking: "248006553", carrier: "ABF" },
  "nathan@tshmt.com": { tracking: "78078144215", carrier: "OD" },
  "randall.turner@morrisjenkins.com": { tracking: "78078494438", carrier: "OD" },
  "vo@jordankilgore.com": { tracking: "248007081", carrier: "ABF" },
  "drapp@offscriptsociety.com": { tracking: "248007098", carrier: "ABF" },
  "jill@digitalvideogroup.com": { tracking: "78077745905", carrier: "OD" },
  "fmaurer@midjourney.com": { tracking: "248007064", carrier: "ABF" },
  "clint.rollett@rd.nestle.com": { tracking: "78076246681", carrier: "OD" },
  "ousteventhomas@gmail.com": { tracking: "78077656458", carrier: "OD" },
  "emovshin@unitedhearing.com": { tracking: "78076411889", carrier: "OD" },
  "mflan25@gmail.com": { tracking: "248007072", carrier: "ABF" },
  "sara.frazier@donegalsd.org": { tracking: "248007076", carrier: "ABF" },
  "drnnenna@reenglobalhealth.com": { tracking: "78076484027", carrier: "OD" },
  "igor@fortell.com": { tracking: "80999169362", carrier: "OD" },
  "raybrown742@gmail.com": { tracking: "78077495626", carrier: "OD" },
  "noah.malone@mannasupply.com": { tracking: "248007054", carrier: "ABF" },
  "robert.mentzer.contractor@pepsico.com": { tracking: "248007055", carrier: "ABF" },
  "nspann@whisperroomguys.com": { tracking: "248890542", carrier: "ABF" },
  "garrett.kenehan@chaffey.edu": { tracking: "248007077", carrier: "ABF" },
  "t.peterson@asu.edu": { tracking: "78077484554", carrier: "OD" },
  "adavidson@nmrevents.com": { tracking: "248007075", carrier: "ABF" },
  "rvanormer@ithacavoice.org": { tracking: "248006856", carrier: "ABF" },
  "dmgray@oxfordsc.org": { tracking: "78076726732", carrier: "OD" },
  "aminidmaynard@state.gov": { tracking: "78076884051", carrier: "OD" },
  "heather_lydon@baxter.com": { tracking: "248007059", carrier: "ABF" },
  "kelly.zimbelman@unlv.edu": { tracking: "78077248041", carrier: "OD" },
  "emounts@modernhearing.net": { tracking: "248007065", carrier: "ABF" },
  "ktr.adams@gmail.com": { tracking: "78077570642", carrier: "OD" },
  "margaret.keating@audionova.com": { tracking: "248890538", carrier: "ABF" },
  "coastalhearingcenter@yahoo.com": { tracking: "78076256086", carrier: "OD" }
};

      // Run all lookups in parallel (5 at a time to avoid rate limits)
      async function processOne(customerEmail, info) {
        try {
          const contactSearch = await httpsRequest({
            hostname: 'api.hubapi.com',
            path: '/crm/v3/objects/contacts/search',
            method: 'POST',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
          }, {
            filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: customerEmail }] }],
            properties: ['email'], limit: 1
          });
          const contacts = contactSearch.body?.results || [];
          if (!contacts.length) return { email: customerEmail, skipped: 'contact not found' };
          const contactId = contacts[0].id;

          const dealSearch = await httpsRequest({
            hostname: 'api.hubapi.com',
            path: '/crm/v3/objects/deals/search',
            method: 'POST',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
          }, {
            filterGroups: [{
              filters: [{ propertyName: 'dealstage', operator: 'EQ', value: '845719' }],
              associatedWith: [{ objectType: 'contacts', operator: 'EQUAL', objectIdValues: [parseInt(contactId)] }]
            }],
            properties: ['dealname', 'tracking_number'],
            sorts: [{ propertyName: 'closedate', direction: 'DESCENDING' }], limit: 1
          });
          const deals = dealSearch.body?.results || [];
          if (!deals.length) return { email: customerEmail, contactId, skipped: 'no shipped deal' };
          const deal = deals[0];
          if (deal.properties?.tracking_number) return { email: customerEmail, dealId: deal.id, skipped: 'already has tracking: ' + deal.properties.tracking_number };

          await httpsRequest({
            hostname: 'api.hubapi.com',
            path: `/crm/v3/objects/deals/${deal.id}`,
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
          }, { properties: { tracking_number: info.tracking, freight_carrier: info.carrier } });
          return { email: customerEmail, dealId: deal.id, tracking: info.tracking, carrier: info.carrier, success: true };
        } catch(e) { return { email: customerEmail, error: e.message }; }
      }

      // Run in parallel batches of 8
      const entries = Object.entries(emailToTracking);
      const results = [];
      for (let i = 0; i < entries.length; i += 8) {
        const batch = entries.slice(i, i + 8);
        const batchResults = await Promise.all(batch.map(([email, info]) => processOne(email, info)));
        results.push(...batchResults);
      }

      const written = results.filter(r => r.success).length;
      const skipped = results.filter(r => r.skipped).length;
      const errors  = results.filter(r => r.error).length;
      global._backfillStatus = { done: true, total: entries.length, written, skipped, errors, results };
      console.log(`Backfill complete: ${written} written, ${skipped} skipped, ${errors} errors`);
    } catch(e) {
      global._backfillStatus = { done: true, error: e.message };
      console.error('Backfill error:', e.message);
    }
    return;
  }

  // ── Admin: Backfill status ────────────────────────────────────────
  if (pathname === '/api/admin/backfill-status' && req.method === 'GET') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    json(global._backfillStatus || { done: false, message: 'Not started or still running' });
    return;
  }


  // ── API: Search Closed Won deals (for Add Shipment modal) ────────
  if (pathname === '/api/deals/closed-won' && req.method === 'GET') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    try {
      const q = parsed.query.q || '';
      // Build request body — filter by stage always, optionally add text search
      const reqBody = {
        filterGroups: [{
          filters: [{ propertyName: 'dealstage', operator: 'EQ', value: 'closedwon' }]
        }],
        properties: ['dealname', 'amount', 'hubspot_owner_id'],
        sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
        limit: 100
      };
      if (q.trim().length >= 2) reqBody.query = q.trim();

      const searchRes = await httpsRequest({
        hostname: 'api.hubapi.com',
        path: '/crm/v3/objects/deals/search',
        method: 'POST',
        headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
      }, reqBody);

      const results = (searchRes.body.results || []).map(d => ({
        id: d.id,
        name: d.properties.dealname || 'Untitled',
        amount: d.properties.amount || null,
        ownerId: d.properties.hubspot_owner_id || null,
      }));
      json({ results });
    } catch(e) { json({ error: e.message }, 500); }
    return;
  }

  // ── API: Ship Deal (from Add Shipment modal) ─────────────────────
  if (pathname === '/api/ship-deal' && req.method === 'POST') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    try {
      const body = JSON.parse(await readBody(req));
      const { dealId, carrier, tracking, dateShipped } = body;
      if (!dealId || !carrier || !tracking) {
        json({ error: 'Missing required fields' }, 400); return;
      }

      // 1. Patch deal: set tracking, carrier, date_shipped, advance stage to Shipped
      await httpsRequest({
        hostname: 'api.hubapi.com',
        path: `/crm/v3/objects/deals/${dealId}`,
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
      }, {
        properties: {
          tracking_number: tracking,
          freight_carrier: carrier,
          date_shipped: dateShipped || new Date().toISOString().split('T')[0],
          dealstage: '845719'  // Shipped
        }
      });

      // 2. Register with AfterShip
      const AFTERSHIP_KEY = process.env.AFTERSHIP_API_KEY || '';
      if (AFTERSHIP_KEY) {
        const slugMap = { ABF: 'abf-freight', OD: 'old-dominion-freight-line', UPS: 'ups', FedEx: 'fedex', USPS: 'usps' };
        const slug = slugMap[carrier] || null;
        const asBody = { tracking: { tracking_number: tracking } };
        if (slug) asBody.tracking.slug = slug;
        try {
          await httpsRequest({
            hostname: 'api.aftership.com',
            path: '/tracking/2026-01/trackings',
            method: 'POST',
            headers: { 'as-api-key': AFTERSHIP_KEY, 'Content-Type': 'application/json' }
          }, asBody);
        } catch(e) { console.warn('AfterShip register on ship-deal:', e.message); }
      }

      json({ success: true });
    } catch(e) { json({ error: e.message }, 500); }
    return;
  }

  // ── API: Create Invoice ──────────────────────────────────────────
  // ── API: Create Payment Link (replaces invoice flow) ────────────
  if (pathname === '/api/create-invoice' && req.method === 'POST') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    try {
      const body = JSON.parse(await readBody(req));
      const { dealId, quoteNumber, lineItems, freight, tax, discount, advanceStage, ownerId } = body;

      if (!dealId) { json({ error: 'No deal ID' }, 400); return; }

      // 1. Optionally advance deal stage to Verbal Confirmation
      if (advanceStage) {
        await httpsRequest({
          hostname: 'api.hubapi.com',
          path: `/crm/v3/objects/deals/${dealId}`,
          method: 'PATCH',
          headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
        }, { properties: { dealstage: 'contractsent' } });
      }

      // 2. Calculate total
      const sub = (lineItems || []).reduce((s, i) => s + (parseFloat(i.price) * parseInt(i.qty)), 0);
      const discAmt = discount && discount.value > 0
        ? (discount.type === 'pct' ? sub * discount.value / 100 : discount.value) : 0;
      const freightTotal = freight ? parseFloat(freight.total || 0) : 0;
      const taxTotal = tax ? parseFloat(tax.tax || 0) : 0;
      const total = Math.round((sub - discAmt + freightTotal + taxTotal) * 100) / 100;

      // 3. Create HubSpot payment link
      const paymentRes = await httpsRequest({
        hostname: 'api.hubapi.com',
        path: '/crm/v3/objects/commerce_payments',
        method: 'POST',
        headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
      }, {
        properties: {
          hs_currency_code:  'USD',
          hs_initial_amount: total.toFixed(2),
          hs_initiated_date: new Date().toISOString(),
        }
      });

      console.log('Payment link response:', JSON.stringify(paymentRes.body));

      const paymentId = paymentRes.body?.id;
      const paymentUrl = paymentRes.body?.properties?.hs_payment_link_url
        || paymentRes.body?.properties?.hs_url
        || null;

      if (!paymentId) {
        console.error('Payment link failed:', JSON.stringify(paymentRes.body));
        // Fall back to invoice page without payment link
        const invoicePageUrl = `https://whisperroomquote.up.railway.app/i/${quoteNumber}`;
        json({ success: true, invoiceUrl: invoicePageUrl, paymentUrl: null, warning: 'Payment link creation failed — invoice page created without pay button' });
        return;
      }

      // 4. Associate payment link with deal
      try {
        await httpsRequest({
          hostname: 'api.hubapi.com',
          path: `/crm/v3/objects/commerce_payments/${paymentId}/associations/deals/${dealId}/commerce_payment_to_deal`,
          method: 'PUT',
          headers: { 'Authorization': `Bearer ${HS_TOKEN}`, 'Content-Type': 'application/json' }
        });
      } catch(e) { console.warn('Payment link→deal assoc failed:', e.message); }

      // 5. Save payment link URL to quote record in DB
      if (quoteNumber && paymentUrl) {
        try {
          await db.query(
            'UPDATE quotes SET payment_link = $1 WHERE quote_number = $2',
            [paymentUrl, quoteNumber]
          );
        } catch(e) { console.warn('DB payment_link save failed:', e.message); }
      }

      // 6. Return the invoice page URL (/i/ route) — this is what the rep copies and sends
      const invoicePageUrl = `https://whisperroomquote.up.railway.app/i/${quoteNumber}`;
      json({ success: true, invoiceUrl: invoicePageUrl, paymentUrl });

    } catch(e) {
      console.error('Create payment link error:', e.message);
      json({ error: e.message }, 500);
    }
    return;
  }




  // ── PDF Download: Quote ──────────────────────────────────────────
  if (pathname.startsWith('/api/download-quote/') && req.method === 'GET') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    const quoteNumber = decodeURIComponent(pathname.replace('/api/download-quote/', '').trim());
    if (!quoteNumber) { json({ error: 'No quote number' }, 400); return; }

    try {
      // Verify quote exists first
      const quoteData = await getQuoteFromDb(quoteNumber);
      if (!quoteData) { res.writeHead(404); res.end('Quote not found'); return; }

      const dealName = quoteData.dealName || quoteData.customer?.company || quoteData.customer?.lastName || 'Quote';
      const safeName = dealName.replace(/[<>:"/\|?*]/g, '').trim();
      const filename = `${quoteNumber} — ${safeName}.pdf`;

      await generatePdf(
        `https://whisperroomquote.up.railway.app/q/${encodeURIComponent(quoteNumber)}`,
        filename, res, req
      );
    } catch(e) {
      console.error('Quote PDF error:', e.message);
      if (!res.headersSent) { res.writeHead(500); res.end('PDF generation failed: ' + e.message); }
    }
    return;
  }

  // ── PDF Download: Invoice ─────────────────────────────────────────
  if (pathname.startsWith('/api/download-invoice/') && req.method === 'GET') {
    if (!isAuth(req)) { json({ error: 'Unauthorized' }, 401); return; }
    const quoteNumber = decodeURIComponent(pathname.replace('/api/download-invoice/', '').trim());
    if (!quoteNumber) { json({ error: 'No quote number' }, 400); return; }

    try {
      const quoteData = await getQuoteFromDb(quoteNumber);
      if (!quoteData) { res.writeHead(404); res.end('Invoice not found'); return; }

      const dealName = quoteData.dealName || quoteData.customer?.company || quoteData.customer?.lastName || 'Invoice';
      const safeName = dealName.replace(/[<>:"/\|?*]/g, '').trim();
      const filename = `${quoteNumber} — ${safeName} (Invoice).pdf`;

      await generatePdf(
        `https://whisperroomquote.up.railway.app/i/${encodeURIComponent(quoteNumber)}`,
        filename, res, req
      );
    } catch(e) {
      console.error('Invoice PDF error:', e.message);
      if (!res.headersSent) { res.writeHead(500); res.end('PDF generation failed: ' + e.message); }
    }
    return;
  }

    res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  initDb();
  console.log(`WhisperRoom Quote Builder running on port ${PORT}`);
  console.log(`HubSpot token: ${HS_TOKEN ? HS_TOKEN.substring(0,12) + '...' : 'NOT SET'}`);
  console.log(`TaxJar key: ${TAXJAR_KEY ? TAXJAR_KEY.substring(0,8) + '...' : 'NOT SET'}`);
  console.log(`HubSpot OAuth: ${HS_CLIENT_ID ? 'configured' : 'password-only mode'}`);
});
