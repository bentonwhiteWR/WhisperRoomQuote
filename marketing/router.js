// Marketing dashboard request handler. Mounted by quote-server.js via
// a single `if (await marketing.handle(...)) return;` block — keeping
// all marketing routes isolated to this folder so Gabe can iterate
// without touching shared app files.
//
// Routes handled here:
//   GET  /marketing                       → the dashboard HTML page
//   GET  /api/marketing/status            → sync status + env readiness
//   POST /api/marketing/sync              → kick off a Google Ads or HubSpot pull
//   GET  /api/marketing/campaigns         → all rows from marketing_campaigns
//   GET  /api/marketing/keywords          → all rows from marketing_keywords
//   GET  /api/marketing/search-terms      → all rows from marketing_search_terms
//
// HubSpot ingestion (v1.44.0) shares the same /api/marketing/sync POST
// endpoint — pass `report: 'hubspot_contacts' | 'hubspot_deals' | 'hubspot_all'`
// to pull from HubSpot instead of Google Ads. The default `'all'` runs
// everything (3 Google Ads reports + 2 HubSpot objects).
//
// Access: temporarily open to all authenticated reps while the allowlist
// hydration is being sorted out (v1.42.0 — Gabe was being rejected by the
// ownerId check). Re-lock by setting MARKETING_ALLOWLIST below to a non-
// empty array; an empty array disables the check.

const fs    = require('fs');
const path  = require('path');
const etl   = require('./google-ads-etl');
const hsEtl = require('./hubspot-etl');

// Empty array = open to everyone (allowlist disabled). Populate with
// ownerIds to re-lock — e.g. ['36303670', '36320208'] for Benton + Gabe.
const MARKETING_ALLOWLIST = [];

let _schemaInitialized = false;
async function _initSchema(db) {
  if (_schemaInitialized || !db) return;
  try {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await db.query(sql);
    _schemaInitialized = true;
    console.log('[marketing] schema initialized');
  } catch(e) {
    console.warn('[marketing] schema init failed:', e.message);
  }
}

function isAllowed(sess) {
  if (MARKETING_ALLOWLIST.length === 0) return !!sess;  // open to any auth'd user
  return !!(sess && MARKETING_ALLOWLIST.includes(String(sess.ownerId || '')));
}

// Entry point. Returns true if the request was handled (caller stops
// dispatching), false otherwise. ctx provides everything from
// quote-server.js's request handler closure: { db, getSession, json,
// parsed, req, res } — we destructure what we need.
async function handle(req, res, ctx) {
  const { pathname } = ctx.parsed;

  // Fast bail for unrelated routes.
  if (pathname !== '/marketing' && !pathname.startsWith('/api/marketing/')) {
    return false;
  }

  await _initSchema(ctx.db);

  const sess = ctx.getSession(req);
  if (!isAllowed(sess)) {
    if (pathname === '/marketing') {
      // Page route: send them home rather than 403-ing in the browser.
      res.writeHead(302, { Location: '/deals' });
      res.end();
      return true;
    }
    ctx.json({ error: 'Forbidden' }, 403);
    return true;
  }

  // ── GET /marketing — serve the dashboard page ─────────────────────
  if (pathname === '/marketing' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(path.join(__dirname, '..', 'marketing-dashboard.html'), 'utf8'));
    return true;
  }

  // ── GET /api/marketing/status ─────────────────────────────────────
  // Returns: env-readiness flag + last-sync timestamp per report type.
  // Used by the dashboard header to show "Last synced 5 min ago" etc.
  // The top-level envReady / missingEnv keys reflect Google Ads readiness
  // only (preserves existing dashboard behavior — Sync All button gates on
  // Google). HubSpot readiness is reported separately as `hubspot.envReady`
  // so the dashboard can show it without blocking the Google sync.
  if (pathname === '/api/marketing/status' && req.method === 'GET') {
    try {
      const syncs = ctx.db ? (await ctx.db.query('SELECT * FROM marketing_syncs')).rows : [];
      ctx.json({
        envReady:    etl.envReady(),
        missingEnv:  etl.missingEnvVars(),
        hubspot:     { envReady: hsEtl.envReady(), missingEnv: hsEtl.missingEnvVars() },
        allowlist:   MARKETING_ALLOWLIST,
        syncs,
      });
    } catch(e) { ctx.json({ envReady: false, syncs: [], error: e.message }); }
    return true;
  }

  // ── POST /api/marketing/sync ──────────────────────────────────────
  // Body: { report: 'campaigns' | 'keywords' | 'search_terms'
  //               | 'hubspot_contacts' | 'hubspot_deals' | 'hubspot_all'
  //               | 'all',
  //         daysBack: number (optional) }
  // Triggers the corresponding ETL function(s). Returns the result.
  //
  // `daysBack` semantics differ by ETL family: Google Ads defaults to 90
  // (daily aggregates, 90d window matches the dashboard view); HubSpot
  // defaults to 365 (we want long lookback for slow-closing deals + first-
  // touch contacts). The `'all'` shortcut uses each family's default.
  if (pathname === '/api/marketing/sync' && req.method === 'POST') {
    let body = {};
    try {
      const chunks = [];
      await new Promise((resolve, reject) => {
        req.on('data', c => chunks.push(c));
        req.on('end', resolve);
        req.on('error', reject);
      });
      body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    } catch(e) {}

    const report   = body.report || 'campaigns';
    const daysBack = body.daysBack != null ? parseInt(body.daysBack) : null;
    const gaDays   = daysBack != null ? daysBack : 90;
    const hsDays   = daysBack != null ? daysBack : 365;
    try {
      let result;
      if      (report === 'campaigns')        result = await etl.syncCampaigns({   db: ctx.db, daysBack: gaDays });
      else if (report === 'keywords')         result = await etl.syncKeywords({    db: ctx.db, daysBack: gaDays });
      else if (report === 'search_terms')     result = await etl.syncSearchTerms({ db: ctx.db, daysBack: gaDays });
      else if (report === 'hubspot_contacts') result = await hsEtl.syncHubSpotContacts({ db: ctx.db, daysBack: hsDays });
      else if (report === 'hubspot_deals')    result = await hsEtl.syncHubSpotDeals({    db: ctx.db, daysBack: hsDays });
      else if (report === 'hubspot_all') {
        const a = await hsEtl.syncHubSpotContacts({ db: ctx.db, daysBack: hsDays });
        const b = await hsEtl.syncHubSpotDeals({    db: ctx.db, daysBack: hsDays });
        result = { ok: a.ok && b.ok, parts: [a, b] };
      }
      else if (report === 'all') {
        // Full refresh: Google Ads (3) + HubSpot (2). Run sequentially to
        // avoid concurrent writes to marketing_syncs and to keep request
        // memory bounded. Each runner records its own error to marketing_syncs
        // even when failing, so a partial run still leaves useful state.
        const a = await etl.syncCampaigns({       db: ctx.db, daysBack: gaDays });
        const b = await etl.syncKeywords({        db: ctx.db, daysBack: gaDays });
        const c = await etl.syncSearchTerms({     db: ctx.db, daysBack: gaDays });
        const d = await hsEtl.syncHubSpotContacts({ db: ctx.db, daysBack: hsDays });
        const e = await hsEtl.syncHubSpotDeals({    db: ctx.db, daysBack: hsDays });
        result = { ok: a.ok && b.ok && c.ok && d.ok && e.ok, parts: [a, b, c, d, e] };
      }
      else {
        ctx.json({ ok: false, error: `Unknown report type: ${report}` }, 400);
        return true;
      }
      ctx.json(result);
    } catch(e) {
      ctx.json({ ok: false, error: e.message }, 500);
    }
    return true;
  }

  // ── GET /api/marketing/campaigns ──────────────────────────────────
  // Returns daily rows for charting. cost_micros converted to cost_usd
  // here so the client doesn't have to do micros math.
  if (pathname === '/api/marketing/campaigns' && req.method === 'GET') {
    try {
      const rows = ctx.db ? (await ctx.db.query(`
        SELECT campaign_id, campaign_name, status, date,
               impressions, clicks,
               (cost_micros::float / 1000000) AS cost_usd,
               conversions, conversion_value
        FROM marketing_campaigns
        ORDER BY date DESC, cost_micros DESC NULLS LAST
        LIMIT 5000
      `)).rows : [];
      ctx.json({ rows });
    } catch(e) { ctx.json({ rows: [], error: e.message }, 500); }
    return true;
  }

  // ── GET /api/marketing/keywords ───────────────────────────────────
  if (pathname === '/api/marketing/keywords' && req.method === 'GET') {
    try {
      const rows = ctx.db ? (await ctx.db.query(`
        SELECT campaign_id, ad_group_id, keyword_id, keyword_text, match_type, date,
               impressions, clicks,
               (cost_micros::float / 1000000) AS cost_usd,
               conversions
        FROM marketing_keywords
        ORDER BY date DESC, cost_micros DESC NULLS LAST
        LIMIT 5000
      `)).rows : [];
      ctx.json({ rows });
    } catch(e) { ctx.json({ rows: [], error: e.message }, 500); }
    return true;
  }

  // ── GET /api/marketing/search-terms ───────────────────────────────
  if (pathname === '/api/marketing/search-terms' && req.method === 'GET') {
    try {
      const rows = ctx.db ? (await ctx.db.query(`
        SELECT campaign_id, ad_group_id, search_term, date,
               impressions, clicks,
               (cost_micros::float / 1000000) AS cost_usd,
               conversions
        FROM marketing_search_terms
        ORDER BY date DESC, cost_micros DESC NULLS LAST
        LIMIT 5000
      `)).rows : [];
      ctx.json({ rows });
    } catch(e) { ctx.json({ rows: [], error: e.message }, 500); }
    return true;
  }

  return false;
}

module.exports = { handle, MARKETING_ALLOWLIST };
