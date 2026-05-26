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

// HubSpot's CRM Search API has a HARD limit of 10,000 results per query,
// regardless of how many `after` cursors it returns. A single sync of
// "last 365 days" silently truncates once it hits 10k — and because we
// sort ascending, the truncation drops the most-recently-modified records
// (the most attribution-relevant ones). The fix: split the lookback
// window into smaller date buckets, each sized so the per-bucket result
// count stays under 10k, and process them newest-first so the most
// useful data lands even if the request times out partway through.
//
// Default bucket size = ~30 days. For WhisperRoom's volume (~26k contacts
// modified per year ≈ ~2.2k/month) this is comfortably under the cap. If
// a single bucket ever hits 10k (e.g. a viral month), we'd need to chunk
// finer — that's a future improvement; for now we log a warning so the
// next-run dashboard reflects the truncation.
const BUCKET_DAYS = 30;

// Build an array of non-overlapping {from, to} Date ranges that together
// cover the last `daysBack` days, ordered newest-bucket-first. Each
// bucket is up to BUCKET_DAYS long; the final bucket is shorter if
// daysBack isn't a multiple of BUCKET_DAYS.
function _dateBuckets(daysBack) {
  const buckets = [];
  const now = new Date();
  for (let offset = 0; offset < daysBack; offset += BUCKET_DAYS) {
    const to = new Date(now);
    to.setDate(to.getDate() - offset);
    const from = new Date(now);
    from.setDate(from.getDate() - Math.min(offset + BUCKET_DAYS, daysBack));
    buckets.push({ from, to });
  }
  return buckets;
}

// ── syncHubSpotContacts ───────────────────────────────────────────────
// Pulls contacts modified in the last `daysBack` days, in ~monthly date
// buckets, newest-first. Each bucket runs its own search query (with its
// own 10k cap headroom) so the cumulative coverage scales linearly with
// the lookback window. Bucket errors are recorded but don't abort the
// remaining buckets — partial coverage is better than nothing.

async function syncHubSpotContacts({ db, daysBack = 365 }) {
  if (!envReady()) {
    throw new Error('HubSpot credentials not configured. Missing: HS_TOKEN');
  }
  const buckets   = _dateBuckets(daysBack);
  const dateFrom  = buckets[buckets.length - 1].from.toISOString().slice(0, 10);
  const dateTo    = buckets[0].to.toISOString().slice(0, 10);

  let totalRows  = 0;
  let firstError = null;
  let truncated  = 0;  // count of buckets that hit the 10k cap
  const startedAt = Date.now();

  for (let i = 0; i < buckets.length; i++) {
    const { from, to } = buckets[i];
    const bucketStart  = Date.now();
    const label        = `${from.toISOString().slice(0,10)}..${to.toISOString().slice(0,10)}`;
    try {
      const { rows, capped } = await _fetchContactsBucket(db, from, to);
      totalRows += rows;
      if (capped) truncated++;
      // v1.46.1 — per-bucket progress: console for Railway logs + intermediate
      // marketing_syncs write so the dashboard count climbs in real time
      // instead of staying frozen until the whole multi-hour sync finishes.
      const secs = ((Date.now() - bucketStart) / 1000).toFixed(1);
      console.log(`[hubspot-etl] contacts ${i+1}/${buckets.length} ${label}: ${rows} rows in ${secs}s${capped ? ' (CAPPED at 10k)' : ''} · total=${totalRows}`);
      await _recordSync(db, 'hubspot_contacts', totalRows, dateFrom, dateTo, truncated > 0 ? `${truncated} bucket(s) capped at 10k` : null);
    } catch (e) {
      const msg = e.message || String(e);
      console.warn(`[hubspot-etl] contacts ${i+1}/${buckets.length} ${label} FAILED: ${msg}`);
      if (!firstError) firstError = msg;
      // continue to next bucket
    }
  }

  const errNote = truncated > 0
    ? `${truncated} bucket(s) hit the 10k cap — narrow BUCKET_DAYS or daysBack`
    : null;
  const finalError = firstError || errNote;
  await _recordSync(db, 'hubspot_contacts', totalRows, dateFrom, dateTo, finalError);
  const totalSecs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[hubspot-etl] contacts SYNC DONE: ${totalRows} rows across ${buckets.length} buckets in ${totalSecs}s${truncated ? ` (${truncated} capped)` : ''}${firstError ? ` · first error: ${firstError}` : ''}`);
  return {
    ok: !firstError,
    report: 'hubspot_contacts',
    rows: totalRows,
    buckets: buckets.length,
    truncated_buckets: truncated,
    date_from: dateFrom,
    date_to: dateTo,
    error: finalError,
  };
}

// Fetch a single contact bucket: all contacts with lastmodifieddate in
// [from, to). Returns {rows, capped} so the caller can detect 10k truncation.
async function _fetchContactsBucket(db, from, to) {
  let rows  = 0;
  let after;
  let capped = false;
  for (let page = 0; page < 100; page++) {
    const body = {
      filterGroups: [{
        filters: [
          { propertyName: 'lastmodifieddate', operator: 'GTE', value: _hsTime(from) },
          { propertyName: 'lastmodifieddate', operator: 'LT',  value: _hsTime(to)   },
        ],
      }],
      properties: CONTACT_PROPS,
      sorts:      [{ propertyName: 'lastmodifieddate', direction: 'DESCENDING' }],
      limit:      100,
      ...(after ? { after } : {}),
    };
    const r = await _request('/crm/v3/objects/contacts/search', 'POST', body);
    const results = r.results || [];
    for (const c of results) {
      await _upsertContact(db, c);
      rows++;
    }
    after = r.paging && r.paging.next && r.paging.next.after;
    if (!after || results.length === 0) break;
    // If we exit via the page cap (100 × 100 = 10k), we hit HubSpot's
    // search ceiling. Mark capped so the caller surfaces a warning.
    if (page === 99 && after) capped = true;
  }
  return { rows, capped };
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
// Same bucketed pattern as syncHubSpotContacts. Sales Pipeline only
// (pipeline = 'default'); Test + Ecommerce pipelines excluded. Per-deal
// extra call to /crm/v4/objects/deal/{id}/associations/contact resolves
// the primary contact — slowest part of the sync. Future improvement:
// batch the association calls via /crm/v4/associations/.../batch/read.

async function syncHubSpotDeals({ db, daysBack = 365 }) {
  if (!envReady()) {
    throw new Error('HubSpot credentials not configured. Missing: HS_TOKEN');
  }
  const buckets   = _dateBuckets(daysBack);
  const dateFrom  = buckets[buckets.length - 1].from.toISOString().slice(0, 10);
  const dateTo    = buckets[0].to.toISOString().slice(0, 10);

  let totalRows  = 0;
  let firstError = null;
  let truncated  = 0;
  const startedAt = Date.now();

  for (let i = 0; i < buckets.length; i++) {
    const { from, to } = buckets[i];
    const bucketStart  = Date.now();
    const label        = `${from.toISOString().slice(0,10)}..${to.toISOString().slice(0,10)}`;
    try {
      const { rows, capped } = await _fetchDealsBucket(db, from, to);
      totalRows += rows;
      if (capped) truncated++;
      const secs = ((Date.now() - bucketStart) / 1000).toFixed(1);
      console.log(`[hubspot-etl] deals ${i+1}/${buckets.length} ${label}: ${rows} rows in ${secs}s${capped ? ' (CAPPED at 10k)' : ''} · total=${totalRows}`);
      await _recordSync(db, 'hubspot_deals', totalRows, dateFrom, dateTo, truncated > 0 ? `${truncated} bucket(s) capped at 10k` : null);
    } catch (e) {
      const msg = e.message || String(e);
      console.warn(`[hubspot-etl] deals ${i+1}/${buckets.length} ${label} FAILED: ${msg}`);
      if (!firstError) firstError = msg;
    }
  }

  const errNote = truncated > 0
    ? `${truncated} bucket(s) hit the 10k cap — narrow BUCKET_DAYS or daysBack`
    : null;
  const finalError = firstError || errNote;
  await _recordSync(db, 'hubspot_deals', totalRows, dateFrom, dateTo, finalError);
  const totalSecs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[hubspot-etl] deals SYNC DONE: ${totalRows} rows across ${buckets.length} buckets in ${totalSecs}s${truncated ? ` (${truncated} capped)` : ''}${firstError ? ` · first error: ${firstError}` : ''}`);
  return {
    ok: !firstError,
    report: 'hubspot_deals',
    rows: totalRows,
    buckets: buckets.length,
    truncated_buckets: truncated,
    date_from: dateFrom,
    date_to: dateTo,
    error: finalError,
  };
}

async function _fetchDealsBucket(db, from, to) {
  let rows  = 0;
  let after;
  let capped = false;
  for (let page = 0; page < 100; page++) {
    const body = {
      filterGroups: [{
        filters: [
          { propertyName: 'hs_lastmodifieddate', operator: 'GTE', value: _hsTime(from) },
          { propertyName: 'hs_lastmodifieddate', operator: 'LT',  value: _hsTime(to)   },
          { propertyName: 'pipeline',            operator: 'EQ',  value: SALES_PIPELINE_ID },
        ],
      }],
      properties: DEAL_PROPS,
      sorts:      [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
      limit:      100,
      ...(after ? { after } : {}),
    };
    const r = await _request('/crm/v3/objects/deals/search', 'POST', body);
    const results = r.results || [];
    for (const d of results) {
      const primaryContactId = await _resolvePrimaryContact(d.id);
      await _upsertDeal(db, d, primaryContactId);
      rows++;
    }
    after = r.paging && r.paging.next && r.paging.next.after;
    if (!after || results.length === 0) break;
    if (page === 99 && after) capped = true;
  }
  return { rows, capped };
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
