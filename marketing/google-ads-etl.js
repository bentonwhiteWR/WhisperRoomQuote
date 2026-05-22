// Google Ads ETL — fetches reports from the Google Ads API and upserts
// them into the marketing_* Postgres tables.
//
// STATUS: scaffolding. The fetch logic is stubbed pending Gabe getting:
//   1. A Google Ads developer token (apply at ads.google.com/aw/apicenter)
//   2. An OAuth2 client_id + client_secret (Google Cloud Console)
//   3. A refresh_token (one-time OAuth dance against the customer account)
//   4. The customer_id (the WhisperRoom Google Ads account number,
//      10 digits, no dashes)
//
// When ready, set these in Railway env:
//   GOOGLE_ADS_DEVELOPER_TOKEN
//   GOOGLE_ADS_CLIENT_ID
//   GOOGLE_ADS_CLIENT_SECRET
//   GOOGLE_ADS_REFRESH_TOKEN
//   GOOGLE_ADS_CUSTOMER_ID
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID  (optional — only if using a Manager/MCC
//                                   account; this is the MCC id)
//
// The `google-ads-api` npm package is pre-installed (see package.json).
// Reference: https://github.com/Opteo/google-ads-api

const REQUIRED_ENV = [
  'GOOGLE_ADS_DEVELOPER_TOKEN',
  'GOOGLE_ADS_CLIENT_ID',
  'GOOGLE_ADS_CLIENT_SECRET',
  'GOOGLE_ADS_REFRESH_TOKEN',
  'GOOGLE_ADS_CUSTOMER_ID',
];

function envReady() {
  return REQUIRED_ENV.every(k => !!process.env[k]);
}

function missingEnvVars() {
  return REQUIRED_ENV.filter(k => !process.env[k]);
}

// Helper — build the customer client. Cached per-process. Callers should
// check envReady() first; if creds are wrong the failure surfaces as a
// GoogleAdsApi auth error on the first request, which the sync runners
// catch and record into marketing_syncs.error.
let _customer = null;
function _getCustomer() {
  if (_customer) return _customer;
  const { GoogleAdsApi } = require('google-ads-api');
  const client = new GoogleAdsApi({
    client_id:       process.env.GOOGLE_ADS_CLIENT_ID,
    client_secret:   process.env.GOOGLE_ADS_CLIENT_SECRET,
    developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
  });
  _customer = client.Customer({
    customer_id:       process.env.GOOGLE_ADS_CUSTOMER_ID,
    refresh_token:     process.env.GOOGLE_ADS_REFRESH_TOKEN,
    login_customer_id: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || undefined,
  });
  return _customer;
}

// Date helpers — Google Ads expects YYYY-MM-DD strings.
function toGoogleDate(d) { return d.toISOString().slice(0, 10); }
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

// ── Sync runners ─────────────────────────────────────────────────────
//
// Each `sync*` function:
//   1. Fetches the relevant report from Google Ads for the last N days
//   2. Upserts each row into the corresponding marketing_* table
//   3. Records the run in marketing_syncs
//
// Idempotent — re-running for the same date range overwrites rows
// thanks to the ON CONFLICT clauses on the composite PKs.

async function syncCampaigns({ db, daysBack = 90 }) {
  if (!envReady()) {
    const miss = missingEnvVars().join(', ');
    throw new Error(`Google Ads credentials not configured. Missing: ${miss}`);
  }
  const dateTo   = toGoogleDate(new Date());
  const dateFrom = toGoogleDate(daysAgo(daysBack));

  // Fetch the daily campaign report from Google Ads. Passing from_date /
  // to_date makes the library add the segments.date BETWEEN constraint.
  let rows;
  try {
    const customer = _getCustomer();
    rows = await customer.report({
      entity: 'campaign',
      attributes: ['campaign.id', 'campaign.name', 'campaign.status'],
      metrics: [
        'metrics.impressions', 'metrics.clicks',
        'metrics.cost_micros', 'metrics.conversions',
        'metrics.conversions_value',
      ],
      segments: ['segments.date'],
      from_date: dateFrom,
      to_date:   dateTo,
    });
  } catch (e) {
    // Google Ads API failure — bad credentials, developer token not yet
    // approved for Basic access, wrong customer_id, etc. Record it so the
    // dashboard status bar shows the reason instead of a bare 500.
    const msg = e.message || String(e);
    await _recordSync(db, 'campaigns', 0, dateFrom, dateTo, msg);
    return { ok: false, report: 'campaigns', rows: 0, error: msg };
  }

  // Upsert each campaign/date row. The (campaign_id, date) composite PK
  // makes re-running the same range overwrite instead of duplicating.
  for (const r of rows) {
    await db.query(`
      INSERT INTO marketing_campaigns
        (campaign_id, campaign_name, status, date, impressions, clicks, cost_micros, conversions, conversion_value, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      ON CONFLICT (campaign_id, date) DO UPDATE SET
        campaign_name    = EXCLUDED.campaign_name,
        status           = EXCLUDED.status,
        impressions      = EXCLUDED.impressions,
        clicks           = EXCLUDED.clicks,
        cost_micros      = EXCLUDED.cost_micros,
        conversions      = EXCLUDED.conversions,
        conversion_value = EXCLUDED.conversion_value,
        updated_at       = NOW()
    `, [
      r.campaign.id, r.campaign.name, r.campaign.status,
      r.segments.date, r.metrics.impressions, r.metrics.clicks,
      r.metrics.cost_micros, r.metrics.conversions, r.metrics.conversions_value,
    ]);
  }

  await _recordSync(db, 'campaigns', rows.length, dateFrom, dateTo, null);
  return { ok: true, report: 'campaigns', rows: rows.length, date_from: dateFrom, date_to: dateTo };
}

async function syncKeywords({ db, daysBack = 90 }) {
  if (!envReady()) {
    const miss = missingEnvVars().join(', ');
    throw new Error(`Google Ads credentials not configured. Missing: ${miss}`);
  }
  const dateTo   = toGoogleDate(new Date());
  const dateFrom = toGoogleDate(daysAgo(daysBack));

  // keyword_view rows carry the bid keyword's criterion id, text and
  // match type alongside campaign / ad group ids — the four parts of
  // the marketing_keywords composite PK.
  let rows;
  try {
    const customer = _getCustomer();
    rows = await customer.report({
      entity: 'keyword_view',
      attributes: [
        'campaign.id', 'ad_group.id',
        'ad_group_criterion.criterion_id',
        'ad_group_criterion.keyword.text',
        'ad_group_criterion.keyword.match_type',
      ],
      metrics: [
        'metrics.impressions', 'metrics.clicks',
        'metrics.cost_micros', 'metrics.conversions',
      ],
      segments: ['segments.date'],
      from_date: dateFrom,
      to_date:   dateTo,
    });
  } catch (e) {
    const msg = e.message || String(e);
    await _recordSync(db, 'keywords', 0, dateFrom, dateTo, msg);
    return { ok: false, report: 'keywords', rows: 0, error: msg };
  }

  for (const r of rows) {
    await db.query(`
      INSERT INTO marketing_keywords
        (campaign_id, ad_group_id, keyword_id, keyword_text, match_type, date, impressions, clicks, cost_micros, conversions, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      ON CONFLICT (campaign_id, ad_group_id, keyword_id, date) DO UPDATE SET
        keyword_text = EXCLUDED.keyword_text,
        match_type   = EXCLUDED.match_type,
        impressions  = EXCLUDED.impressions,
        clicks       = EXCLUDED.clicks,
        cost_micros  = EXCLUDED.cost_micros,
        conversions  = EXCLUDED.conversions,
        updated_at   = NOW()
    `, [
      r.campaign.id, r.ad_group.id, r.ad_group_criterion.criterion_id,
      r.ad_group_criterion.keyword.text, r.ad_group_criterion.keyword.match_type,
      r.segments.date, r.metrics.impressions, r.metrics.clicks,
      r.metrics.cost_micros, r.metrics.conversions,
    ]);
  }

  await _recordSync(db, 'keywords', rows.length, dateFrom, dateTo, null);
  return { ok: true, report: 'keywords', rows: rows.length, date_from: dateFrom, date_to: dateTo };
}

async function syncSearchTerms({ db, daysBack = 90 }) {
  if (!envReady()) {
    const miss = missingEnvVars().join(', ');
    throw new Error(`Google Ads credentials not configured. Missing: ${miss}`);
  }
  const dateTo   = toGoogleDate(new Date());
  const dateFrom = toGoogleDate(daysAgo(daysBack));

  // search_term_view = what people actually typed (vs. the keywords we
  // bid on), keyed on (campaign, ad group, search term, date).
  let rows;
  try {
    const customer = _getCustomer();
    rows = await customer.report({
      entity: 'search_term_view',
      attributes: [
        'campaign.id', 'ad_group.id',
        'search_term_view.search_term',
      ],
      metrics: [
        'metrics.impressions', 'metrics.clicks',
        'metrics.cost_micros', 'metrics.conversions',
      ],
      segments: ['segments.date'],
      from_date: dateFrom,
      to_date:   dateTo,
    });
  } catch (e) {
    const msg = e.message || String(e);
    await _recordSync(db, 'search_terms', 0, dateFrom, dateTo, msg);
    return { ok: false, report: 'search_terms', rows: 0, error: msg };
  }

  for (const r of rows) {
    await db.query(`
      INSERT INTO marketing_search_terms
        (campaign_id, ad_group_id, search_term, date, impressions, clicks, cost_micros, conversions, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      ON CONFLICT (campaign_id, ad_group_id, search_term, date) DO UPDATE SET
        impressions = EXCLUDED.impressions,
        clicks      = EXCLUDED.clicks,
        cost_micros = EXCLUDED.cost_micros,
        conversions = EXCLUDED.conversions,
        updated_at  = NOW()
    `, [
      r.campaign.id, r.ad_group.id, r.search_term_view.search_term,
      r.segments.date, r.metrics.impressions, r.metrics.clicks,
      r.metrics.cost_micros, r.metrics.conversions,
    ]);
  }

  await _recordSync(db, 'search_terms', rows.length, dateFrom, dateTo, null);
  return { ok: true, report: 'search_terms', rows: rows.length, date_from: dateFrom, date_to: dateTo };
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
  } catch(e) { console.warn('[marketing-etl] sync record failed:', e.message); }
}

module.exports = {
  envReady,
  missingEnvVars,
  syncCampaigns,
  syncKeywords,
  syncSearchTerms,
};
