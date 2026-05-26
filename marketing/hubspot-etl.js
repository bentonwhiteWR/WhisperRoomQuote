// HubSpot ETL — fetches contacts + Sales Pipeline deals from HubSpot's
// CRM API and upserts them into the marketing_hubspot_* Postgres tables.
// First leg of marketing closed-loop attribution: pairs with the Google
// Ads ETL so we can join click (gclid in marketing_campaigns/keywords)
// to revenue (amount in marketing_hubspot_deals) via the
// marketing_hubspot_contacts.gclid bridge in the next PR.
//
// Auth: HS_TOKEN env var (HubSpot private app token, same one lib/hubspot.js
// uses for the rest of the app). Single Bearer header.
//
// HTTP: Node built-in `https` — kept local to this file because the
// project rule forbids touching lib/* (Benton owns those). Mirrors the
// shape of lib/hubspot.js's httpsRequest helper; no new deps.
//
// Sync model: incremental via `hs_lastmodifieddate` filter + cursor
// pagination. Default 365-day lookback for the first sync; subsequent
// syncs naturally narrow to "what's changed" because we re-pull the
// same window but only modified rows surface. Idempotent: contact_id /
// deal_id primary keys + ON CONFLICT DO UPDATE.

const https = require('https');

const HS_TOKEN    = process.env.HS_TOKEN || '';
const HS_HOSTNAME = 'api.hubapi.com';

// Only the Sales Pipeline counts for marketing reporting. The Test +
// Ecommerce pipelines exist in this tenant but are noise here. ID looked
// up via HubSpot API; named 'default' because it's the legacy default
// pipeline that pre-existed the multi-pipeline rollout.
const SALES_PIPELINE_ID = 'default';

// Contact properties pulled on every sync. Kept tight — every property
// adds payload weight and any custom property has tenant-specific risk.
// If you add fields here, also add columns to marketing_hubspot_contacts
// and the upsert below; otherwise the data silently drops.
const CONTACT_PROPS = [
  'email',
  'hs_google_click_id',
  'hs_facebook_click_id',
  'hs_analytics_source',
  'hs_analytics_source_data_1',
  'hs_analytics_source_data_2',
  'hs_analytics_first_touch_converting_campaign',
  'hs_latest_source',
  'hs_latest_source_data_1',
  'hs_latest_source_data_2',
  'hs_latest_source_timestamp',
  'lifecyclestage',
  'hs_lead_status',
  'createdate',
  'lastmodifieddate',
];

const DEAL_PROPS = [
  'dealname',
  'pipeline',
  'dealstage',
  'amount_in_home_currency',  // USD (matches the tenant's company currency)
  'hs_is_closed',
  'hs_is_closed_won',
  'hs_is_closed_lost',
  'createdate',
  'closedate',
  'days_to_close',
  'hs_lastmodifieddate',
  'closed_won_reason',
  'closed_lost_reason',
];

function envReady()       { return !!HS_TOKEN; }
function missingEnvVars() { return HS_TOKEN ? [] : ['HS_TOKEN']; }

// Minimal Promise-wrapped HTTPS client. Local to marketing/ (we can't use
// the lib/hubspot.js httpsRequest helper since this module isn't passed
// it via init({deps}) — quote-server.js wires lib/* modules, not us).
// Mirrors the same shape: returns parsed JSON; throws on 4xx/5xx with the
// HubSpot error message attached so it surfaces in marketing_syncs.error.
function _request(path, method, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: HS_HOSTNAME,
      path,
      method,
      headers: {
        'Authorization': `Bearer ${HS_TOKEN}`,
        'Content-Type':  'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = { raw }; }
        if (res.statusCode >= 400) {
          const detail = parsed.message || parsed.error || raw.slice(0, 200);
          return reject(new Error(`HubSpot ${res.statusCode}: ${detail}`));
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// HubSpot's search API expects modified-date filters as ms-since-epoch
// strings. Other date fields in responses come back as ISO 8601.
function _hsTime(d) { return String(d.getTime()); }
function _daysAgoDate(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}
function _parseHsDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

// ── syncHubSpotContacts ───────────────────────────────────────────────
// Pulls contacts modified in the last `daysBack` days. Pages via the
// `paging.next.after` cursor, 100 per page, hard-capped at 100 pages
// (10k contacts) per run as a safety net — sufficient for a daily sync
// of a B2B-sized tenant. If you ever hit that ceiling, narrow daysBack.

async function syncHubSpotContacts({ db, daysBack = 365 }) {
  if (!envReady()) {
    throw new Error('HubSpot credentials not configured. Missing: HS_TOKEN');
  }
  const sinceDate = _daysAgoDate(daysBack);
  const dateFrom  = sinceDate.toISOString().slice(0, 10);
  const dateTo    = new Date().toISOString().slice(0, 10);

  let rowsSynced = 0;
  let after;
  try {
    for (let page = 0; page < 100; page++) {
      const body = {
        filterGroups: [{
          filters: [{
            propertyName: 'lastmodifieddate',
            operator:     'GTE',
            value:        _hsTime(sinceDate),
          }],
        }],
        properties: CONTACT_PROPS,
        sorts:      [{ propertyName: 'lastmodifieddate', direction: 'ASCENDING' }],
        limit:      100,
        ...(after ? { after } : {}),
      };
      const r = await _request('/crm/v3/objects/contacts/search', 'POST', body);
      const results = r.results || [];
      for (const c of results) {
        await _upsertContact(db, c);
        rowsSynced++;
      }
      after = r.paging && r.paging.next && r.paging.next.after;
      if (!after || results.length === 0) break;
    }
  } catch (e) {
    const msg = e.message || String(e);
    await _recordSync(db, 'hubspot_contacts', rowsSynced, dateFrom, dateTo, msg);
    return { ok: false, report: 'hubspot_contacts', rows: rowsSynced, error: msg };
  }

  await _recordSync(db, 'hubspot_contacts', rowsSynced, dateFrom, dateTo, null);
  return { ok: true, report: 'hubspot_contacts', rows: rowsSynced, date_from: dateFrom, date_to: dateTo };
}

async function _upsertContact(db, c) {
  const p = c.properties || {};
  await db.query(`
    INSERT INTO marketing_hubspot_contacts
      (contact_id, email, gclid, fbclid,
       first_source, first_source_data_1, first_source_data_2, first_converting_campaign,
       latest_source, latest_source_data_1, latest_source_data_2, latest_source_at,
       lifecycle_stage, lead_status,
       created_at, last_modified_at, synced_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())
    ON CONFLICT (contact_id) DO UPDATE SET
      email                     = EXCLUDED.email,
      gclid                     = EXCLUDED.gclid,
      fbclid                    = EXCLUDED.fbclid,
      first_source              = EXCLUDED.first_source,
      first_source_data_1       = EXCLUDED.first_source_data_1,
      first_source_data_2       = EXCLUDED.first_source_data_2,
      first_converting_campaign = EXCLUDED.first_converting_campaign,
      latest_source             = EXCLUDED.latest_source,
      latest_source_data_1      = EXCLUDED.latest_source_data_1,
      latest_source_data_2      = EXCLUDED.latest_source_data_2,
      latest_source_at          = EXCLUDED.latest_source_at,
      lifecycle_stage           = EXCLUDED.lifecycle_stage,
      lead_status               = EXCLUDED.lead_status,
      created_at                = EXCLUDED.created_at,
      last_modified_at          = EXCLUDED.last_modified_at,
      synced_at                 = NOW()
  `, [
    parseInt(c.id),
    p.email || null,
    p.hs_google_click_id   || null,
    p.hs_facebook_click_id || null,
    p.hs_analytics_source                          || null,
    p.hs_analytics_source_data_1                   || null,
    p.hs_analytics_source_data_2                   || null,
    p.hs_analytics_first_touch_converting_campaign || null,
    p.hs_latest_source         || null,
    p.hs_latest_source_data_1  || null,
    p.hs_latest_source_data_2  || null,
    _parseHsDate(p.hs_latest_source_timestamp),
    p.lifecyclestage || null,
    p.hs_lead_status || null,
    _parseHsDate(p.createdate),
    _parseHsDate(p.lastmodifieddate),
  ]);
}

// ── syncHubSpotDeals ──────────────────────────────────────────────────
// Pulls deals from the Sales Pipeline only (pipeline = 'default'),
// modified in the last `daysBack` days. For each deal, makes one extra
// call to /crm/v4/objects/deal/{id}/associations/contact to resolve the
// primary contact — denormalized onto the deal row so attribution
// queries don't need to traverse association tables. ~one extra API
// call per deal; fine at the hundreds-per-sync volume we expect.

async function syncHubSpotDeals({ db, daysBack = 365 }) {
  if (!envReady()) {
    throw new Error('HubSpot credentials not configured. Missing: HS_TOKEN');
  }
  const sinceDate = _daysAgoDate(daysBack);
  const dateFrom  = sinceDate.toISOString().slice(0, 10);
  const dateTo    = new Date().toISOString().slice(0, 10);

  let rowsSynced = 0;
  let after;
  try {
    for (let page = 0; page < 100; page++) {
      const body = {
        filterGroups: [{
          filters: [
            { propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: _hsTime(sinceDate) },
            { propertyName: 'pipeline',            operator: 'EQ',  value: SALES_PIPELINE_ID },
          ],
        }],
        properties: DEAL_PROPS,
        sorts:      [{ propertyName: 'hs_lastmodifieddate', direction: 'ASCENDING' }],
        limit:      100,
        ...(after ? { after } : {}),
      };
      const r = await _request('/crm/v3/objects/deals/search', 'POST', body);
      const results = r.results || [];
      for (const d of results) {
        const primaryContactId = await _resolvePrimaryContact(d.id);
        await _upsertDeal(db, d, primaryContactId);
        rowsSynced++;
      }
      after = r.paging && r.paging.next && r.paging.next.after;
      if (!after || results.length === 0) break;
    }
  } catch (e) {
    const msg = e.message || String(e);
    await _recordSync(db, 'hubspot_deals', rowsSynced, dateFrom, dateTo, msg);
    return { ok: false, report: 'hubspot_deals', rows: rowsSynced, error: msg };
  }

  await _recordSync(db, 'hubspot_deals', rowsSynced, dateFrom, dateTo, null);
  return { ok: true, report: 'hubspot_deals', rows: rowsSynced, date_from: dateFrom, date_to: dateTo };
}

// Resolve the primary associated contact for a deal. Prefers an
// association labeled with /primary/i (matches "Primary buyer", "Primary
// contact", etc.); falls back to the first associated contact if no
// label matches. Returns null on lookup failure so the deal still gets
// upserted — we just won't be able to attribute it.
async function _resolvePrimaryContact(dealId) {
  try {
    const r = await _request(`/crm/v4/objects/deal/${dealId}/associations/contact`, 'GET', null);
    const results = r.results || [];
    if (results.length === 0) return null;
    for (const assoc of results) {
      const types = assoc.associationTypes || [];
      if (types.some(t => t.label && /primary/i.test(t.label))) {
        return parseInt(assoc.toObjectId);
      }
    }
    return parseInt(results[0].toObjectId);
  } catch (e) {
    console.warn(`[hubspot-etl] primary contact lookup failed for deal ${dealId}: ${e.message}`);
    return null;
  }
}

async function _upsertDeal(db, d, primaryContactId) {
  const p = d.properties || {};
  await db.query(`
    INSERT INTO marketing_hubspot_deals
      (deal_id, deal_name, pipeline, dealstage, amount,
       is_closed, is_closed_won, is_closed_lost,
       created_at, closed_at, days_to_close, last_modified_at,
       closed_won_reason, closed_lost_reason, primary_contact_id, synced_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
    ON CONFLICT (deal_id) DO UPDATE SET
      deal_name          = EXCLUDED.deal_name,
      pipeline           = EXCLUDED.pipeline,
      dealstage          = EXCLUDED.dealstage,
      amount             = EXCLUDED.amount,
      is_closed          = EXCLUDED.is_closed,
      is_closed_won      = EXCLUDED.is_closed_won,
      is_closed_lost     = EXCLUDED.is_closed_lost,
      created_at         = EXCLUDED.created_at,
      closed_at          = EXCLUDED.closed_at,
      days_to_close      = EXCLUDED.days_to_close,
      last_modified_at   = EXCLUDED.last_modified_at,
      closed_won_reason  = EXCLUDED.closed_won_reason,
      closed_lost_reason = EXCLUDED.closed_lost_reason,
      primary_contact_id = EXCLUDED.primary_contact_id,
      synced_at          = NOW()
  `, [
    parseInt(d.id),
    p.dealname  || null,
    p.pipeline  || null,
    p.dealstage || null,
    p.amount_in_home_currency ? parseFloat(p.amount_in_home_currency) : null,
    p.hs_is_closed      === 'true',
    p.hs_is_closed_won  === 'true',
    p.hs_is_closed_lost === 'true',
    _parseHsDate(p.createdate),
    _parseHsDate(p.closedate),
    p.days_to_close ? parseInt(p.days_to_close) : null,
    _parseHsDate(p.hs_lastmodifieddate),
    p.closed_won_reason  || null,
    p.closed_lost_reason || null,
    primaryContactId,
  ]);
}

async function _recordSync(db, reportType, rows, dateFrom, dateTo, error) {
  if (!db) return;
  try {
    await db.query(`
      INSERT INTO marketing_syncs (report_type, last_synced_at, rows_synced, date_from, date_to, error)
      VALUES ($1, NOW(), $2, $3, $4, $5)
      ON CONFLICT (report_type) DO UPDATE SET
        last_synced_at = NOW(),
        rows_synced    = EXCLUDED.rows_synced,
        date_from      = EXCLUDED.date_from,
        date_to        = EXCLUDED.date_to,
        error          = EXCLUDED.error
    `, [reportType, rows, dateFrom, dateTo, error]);
  } catch(e) { console.warn('[hubspot-etl] sync record failed:', e.message); }
}

module.exports = {
  envReady,
  missingEnvVars,
  syncHubSpotContacts,
  syncHubSpotDeals,
  SALES_PIPELINE_ID,
};
