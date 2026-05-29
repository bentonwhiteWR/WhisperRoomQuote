// Marketing dashboard request handler. Mounted by quote-server.js via
// a single `if (await marketing.handle(...)) return;` block — keeping
// all marketing routes isolated to this folder so Gabe can iterate
// without touching shared app files.
//
// Routes handled here:
//   GET  /marketing                       → the dashboard HTML page
//   GET  /api/marketing/status            → sync status + env readiness
//   POST /api/marketing/sync              → kick off a Google Ads or HubSpot pull
//   GET  /api/marketing/campaigns                → all rows from marketing_campaigns
//   GET  /api/marketing/keywords                 → all rows from marketing_keywords
//   GET  /api/marketing/search-terms             → all rows from marketing_search_terms
//   GET  /api/marketing/campaign-attribution     → per-campaign leads/deals/revenue (v1.46.1)
//   GET  /api/marketing/attribution-coverage     → % of contacts + deals + revenue attributable (v1.46.1)
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

// HubSpot's first_source_data_1 stores the campaign name at the time of
// first touch. When a Google Ads campaign is renamed (e.g. A/B variants
// merged into a "Combined" parent), historical HubSpot contacts retain
// the OLD name forever. This alias table redirects known historical names
// back to the current campaign_name so the attribution JOIN doesn't lose
// them. Add an entry when a campaign rename leaves a visible gap on the
// per-campaign table (real spend but zero leads/deals).
//
// hsName: the value stored in HubSpot, AFTER normalization (lowercased,
//         '+' replaced with single space). Match against
//         LOWER(REPLACE(first_source_data_1, '+', ' ')).
// gaName: the current Google Ads campaign_name, VERBATIM (case-sensitive,
//         matched exactly against marketing_campaigns.campaign_name).
const HUBSPOT_CAMPAIGN_ALIASES = [
  { hsName: '**lp general (us/can) - b', gaName: '**LP General (US/CAN) - Combined' },
  { hsName: '**lp testing (us/can) - a', gaName: '**LP Testing (US/CAN) - Combined' },
];

// v1.46.10 — parse ?days=N from the request URL. Used by every data
// endpoint so the dashboard date-range selector can drive all six queries
// from a single URL param. Bounded [1, 730] so a bad client can't ask
// for an unbounded window; falls back to 90 (current dashboard default).
function _parseDays(req) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const n = parseInt(url.searchParams.get('days'));
    if (!Number.isFinite(n)) return 90;
    return Math.min(Math.max(n, 1), 730);
  } catch { return 90; }
}

// v1.50.8 — attribution-model selector. Lets the dashboard switch the
// closed-loop layer between three definitions, ALL backed by fields the
// ETL already ingests (schema.sql deliberately pulls the first_* AND
// latest_* source pairs + gclid so the model can change per-query with
// NO re-sync):
//
//   'first' (default) — first_source = 'PAID_SEARCH'. The customer's FIRST
//        interaction was a paid-search ad. Matches HubSpot's "First ad
//        interaction" report. Strict / most conservative.
//   'last'  — latest_source = 'PAID_SEARCH'. The customer's MOST-RECENT
//        source was paid search. Matches HubSpot's last-interaction lens.
//        Windowed on latest_source_at (when the last touch happened), not
//        createdate, so a long-known contact re-engaged by an ad counts.
//   'all'   — first OR latest source is PAID_SEARCH, OR a gclid is present.
//        Any KNOWN ad touch. Approximates HubSpot's "All ad interactions"
//        report. Caveat: we store first + latest + gclid, NOT the full
//        event history, so a contact whose only ad touch was a middle
//        interaction with no gclid is missed — close to HubSpot's number,
//        not guaranteed exact.
//
// Returns SQL fragments referencing the contact alias `c` (and, for
// campMatch, the `cn` campaign-names CTE + `aliases` CTE that the
// attribution queries already define). `model` is whitelisted to three
// literals and never interpolates raw request text, so building the SQL
// by string concat here is injection-safe.
function _attrModel(req) {
  let model = 'first';
  try {
    const m = (new URL(req.url, 'http://localhost').searchParams.get('model') || '').toLowerCase();
    if (m === 'last' || m === 'all') model = m;
  } catch {}

  // Campaign-name match for one (source, data_1) column pair. Mirrors the
  // v1.46.7 first-touch join: case-insensitive, '+'→space normalized, with
  // the historical-rename alias fallback.
  const campMatch = (src, d1) => `(${src} = 'PAID_SEARCH' AND (
            LOWER(REPLACE(${d1}, '+', ' ')) = LOWER(REPLACE(cn.campaign_name, '+', ' '))
            OR EXISTS (SELECT 1 FROM aliases a
                         WHERE a.ga_name = cn.campaign_name
                           AND a.hs_name = LOWER(REPLACE(${d1}, '+', ' ')))))`;
  // Search-term match for one (source, data_2) column pair. HubSpot stores
  // the literal typed term in *_source_data_2 for PAID_SEARCH (v1.46.9).
  const termMatch = (src, d2) => `(${src} = 'PAID_SEARCH' AND LOWER(TRIM(${d2})) = st.search_term)`;

  const MODELS = {
    first: {
      contactPaid: `c.first_source = 'PAID_SEARCH'`,
      contactDate: `c.created_at`,
      campMatch:   campMatch('c.first_source', 'c.first_source_data_1'),
      termMatch:   termMatch('c.first_source', 'c.first_source_data_2'),
    },
    last: {
      contactPaid: `c.latest_source = 'PAID_SEARCH'`,
      contactDate: `COALESCE(c.latest_source_at, c.created_at)`,
      campMatch:   campMatch('c.latest_source', 'c.latest_source_data_1'),
      termMatch:   termMatch('c.latest_source', 'c.latest_source_data_2'),
    },
    all: {
      contactPaid: `(c.first_source = 'PAID_SEARCH' OR c.latest_source = 'PAID_SEARCH' OR c.gclid IS NOT NULL)`,
      contactDate: `c.created_at`,
      campMatch:   `(${campMatch('c.first_source', 'c.first_source_data_1')} OR ${campMatch('c.latest_source', 'c.latest_source_data_1')})`,
      termMatch:   `(${termMatch('c.first_source', 'c.first_source_data_2')} OR ${termMatch('c.latest_source', 'c.latest_source_data_2')})`,
    },
  };
  return { model, ...MODELS[model] };
}

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

// ── Segment classifier (v1.50.10) ─────────────────────────────────────
// Maps a Google Ads campaign_name to a buyer segment using marketing/
// segment_map.json (Gabe-editable config — NOT hardcoded). Resolution
// order: exact override → first matching segment rule → mixed_signals →
// 'Unclassified'. Read by the read-only /segments/proposed diagnostic now;
// the Segment Performance UI will reuse the exact same classifier so the
// table and the diagnostic can never drift. Map is cached after first load;
// editing the file requires a redeploy/restart to pick up (fine — it's a
// reviewed config, not live data).
let _segmentMap = null;
function _loadSegmentMap() {
  if (_segmentMap) return _segmentMap;
  try {
    _segmentMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'segment_map.json'), 'utf8'));
  } catch (e) {
    console.warn('[marketing] segment_map.json load failed:', e.message);
    _segmentMap = { segments: [], rules: [], mixed_signals: [], overrides: {} };
  }
  return _segmentMap;
}

// Classify one campaign name. Returns { segment, rule, split? }. `rule` is a
// short provenance string so the diagnostic can show WHY each campaign landed
// where it did (override / rule:<frag> / mixed:<frag> / null).
function _classifyCampaign(name, map) {
  if (!name) return { segment: 'Unclassified', rule: null };
  if (map.overrides && Object.prototype.hasOwnProperty.call(map.overrides, name)) {
    const ov = map.overrides[name];
    if (ov && typeof ov === 'object') return { segment: 'Mixed', rule: 'override:split', split: ov.allocation || null };
    return { segment: ov, rule: 'override' };
  }
  const test = (frag) => {
    try { return new RegExp(frag, 'i').test(name); }
    catch { return name.toLowerCase().includes(String(frag).toLowerCase()); }
  };
  for (const r of (map.rules || [])) {
    for (const frag of (r.match_any || [])) {
      if (test(frag)) return { segment: r.segment, rule: `rule:${frag}` };
    }
  }
  for (const frag of (map.mixed_signals || [])) {
    if (test(frag)) return { segment: 'Mixed', rule: `mixed:${frag}` };
  }
  return { segment: 'Unclassified', rule: null };
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
    // v1.46.12 — Google Ads default bumped 90 → 365 to match HubSpot's
    // window. Prior 90d default + 365d HubSpot meant the dashboard's
    // 365d view divided 365d of revenue by 90d of spend, inflating ROAS
    // by ~4x. ON CONFLICT upserts make the longer pull idempotent.
    const gaDays   = daysBack != null ? daysBack : 365;
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
  // here so the client doesn't have to do micros math. v1.46.10: accepts
  // ?days=N (1-730, default 90) so the dashboard date picker can drive
  // the window. Note: ETL only pulls 90 days by default, so 180/365
  // queries return whatever is loaded (still useful — just doesn't extend
  // beyond the ETL window without a longer sync).
  if (pathname === '/api/marketing/campaigns' && req.method === 'GET') {
    try {
      const days = _parseDays(req);
      const rows = ctx.db ? (await ctx.db.query(`
        SELECT campaign_id, campaign_name, status, date,
               impressions, clicks,
               (cost_micros::float / 1000000) AS cost_usd,
               conversions, conversion_value
        FROM marketing_campaigns
        WHERE date >= CURRENT_DATE - INTERVAL '1 day' * $1
        ORDER BY date DESC, cost_micros DESC NULLS LAST
        LIMIT 50000
      `, [days])).rows : [];
      ctx.json({ rows });
    } catch(e) { ctx.json({ rows: [], error: e.message }, 500); }
    return true;
  }

  // ── GET /api/marketing/keywords ───────────────────────────────────
  if (pathname === '/api/marketing/keywords' && req.method === 'GET') {
    try {
      const days = _parseDays(req);
      const rows = ctx.db ? (await ctx.db.query(`
        SELECT campaign_id, ad_group_id, keyword_id, keyword_text, match_type, date,
               impressions, clicks,
               (cost_micros::float / 1000000) AS cost_usd,
               conversions
        FROM marketing_keywords
        WHERE date >= CURRENT_DATE - INTERVAL '1 day' * $1
        ORDER BY date DESC, cost_micros DESC NULLS LAST
        LIMIT 200000
      `, [days])).rows : [];
      ctx.json({ rows });
    } catch(e) { ctx.json({ rows: [], error: e.message }, 500); }
    return true;
  }

  // ── GET /api/marketing/search-terms ───────────────────────────────
  if (pathname === '/api/marketing/search-terms' && req.method === 'GET') {
    try {
      const days = _parseDays(req);
      const rows = ctx.db ? (await ctx.db.query(`
        SELECT campaign_id, ad_group_id, search_term, date,
               impressions, clicks,
               (cost_micros::float / 1000000) AS cost_usd,
               conversions
        FROM marketing_search_terms
        WHERE date >= CURRENT_DATE - INTERVAL '1 day' * $1
        ORDER BY date DESC, cost_micros DESC NULLS LAST
        LIMIT 200000
      `, [days])).rows : [];
      ctx.json({ rows });
    } catch(e) { ctx.json({ rows: [], error: e.message }, 500); }
    return true;
  }

  // ── GET /api/marketing/campaign-attribution ───────────────────────
  // First-touch campaign attribution. For each Google Ads campaign active
  // in the last 90 days, count attributed leads (HubSpot contacts whose
  // first-touch was that campaign) and their deals (open/won/lost) +
  // closed-won revenue.
  //
  // Attribution join (v1.46.7 — rewritten). The original v1.46.1 JOIN
  // assumed first_source_data_2 held the campaign name and data_1 held
  // 'google'. The 2026-05-27 diagnostic proved both wrong:
  //   - For PAID_SEARCH contacts, HubSpot stores the CAMPAIGN NAME in
  //     first_source_data_1 (lowercased, e.g. "**lp branded - a").
  //   - first_source_data_2 holds the SEARCH KEYWORD ("sound booth").
  //   - hs_analytics_first_touch_converting_campaign is essentially
  //     unpopulated (25 of 22534 contacts) — dropped from the join.
  //
  // Match: case-insensitive on first_source_data_1 with '+' normalized
  // to space (handles "Office Booth - Privacy + Competitors" vs HubSpot's
  // "office booth - privacy   competitors"). Known gap: campaigns
  // renamed in Google Ads (e.g. A/B variants merged into "Combined")
  // leave historical HubSpot contacts unmatched against the new name.
  //
  // Single-touch only — we don't have full event/session history. Under the
  // default 'first' model our `leads` count matches HubSpot's "First ad
  // interaction" report. v1.50.8 — `?model=first|last|all` swaps the
  // contact-side predicate (see _attrModel). gclid-only contacts under 'all'
  // can't be mapped to a specific campaign without click_view resolution, so
  // they raise the KPI contact count but don't join to a campaign row here.
  if (pathname === '/api/marketing/campaign-attribution' && req.method === 'GET') {
    try {
      const days = _parseDays(req);
      const am   = _attrModel(req);
      const aliasHsNames = HUBSPOT_CAMPAIGN_ALIASES.map(a => a.hsName);
      const aliasGaNames = HUBSPOT_CAMPAIGN_ALIASES.map(a => a.gaName);
      const rows = ctx.db ? (await ctx.db.query(`
        WITH campaign_names AS (
          SELECT DISTINCT campaign_id, campaign_name
          FROM marketing_campaigns
          WHERE date >= CURRENT_DATE - INTERVAL '1 day' * $3
            AND campaign_name IS NOT NULL
        ),
        aliases AS (
          SELECT hs_name, ga_name
          FROM unnest($1::text[], $2::text[]) AS t(hs_name, ga_name)
        )
        SELECT
          cn.campaign_id,
          cn.campaign_name,
          COUNT(DISTINCT c.contact_id)                                                            AS leads,
          COUNT(DISTINCT d.deal_id)                                                               AS deals_total,
          COUNT(DISTINCT CASE WHEN d.is_closed_won  THEN d.deal_id END)                           AS deals_won,
          COUNT(DISTINCT CASE WHEN d.is_closed_lost THEN d.deal_id END)                           AS deals_lost,
          COUNT(DISTINCT CASE WHEN d.deal_id IS NOT NULL AND NOT d.is_closed THEN d.deal_id END)  AS deals_open,
          COALESCE(SUM(CASE WHEN d.is_closed_won THEN d.amount ELSE 0 END), 0)::float             AS revenue_won
        FROM campaign_names cn
        LEFT JOIN marketing_hubspot_contacts c ON (
          ${am.campMatch}
          AND ${am.contactDate} >= CURRENT_DATE - INTERVAL '1 day' * $3
        )
        LEFT JOIN marketing_hubspot_deals d ON d.primary_contact_id = c.contact_id
        GROUP BY cn.campaign_id, cn.campaign_name
        ORDER BY revenue_won DESC, leads DESC
      `, [aliasHsNames, aliasGaNames, days])).rows : [];
      ctx.json({ rows, model: am.model });
    } catch(e) { ctx.json({ rows: [], error: e.message }, 500); }
    return true;
  }

  // ── GET /api/marketing/debug/source-data2 ─────────────────────────
  // Diagnostic for the v1.46.1 per-campaign-zeros issue. Confirms what
  // HubSpot actually stores in first_source_data_2 for PAID_SEARCH/google
  // contacts: gclid (the failure mode that breaks the string JOIN in
  // campaign-attribution) vs an actual campaign name (the assumed shape).
  // Remove once the click_view-based attribution fix lands.
  if (pathname === '/api/marketing/debug/source-data2' && req.method === 'GET') {
    try {
      if (!ctx.db) { ctx.json({ error: 'no db' }, 500); return true; }
      const paidGoogle = `first_source = 'PAID_SEARCH' AND first_source_data_1 = 'google'`;
      const [patterns, samples, campaignCov, campaigns, matches] = await Promise.all([
        ctx.db.query(`
          SELECT
            CASE
              WHEN first_source_data_2 IS NULL                                            THEN '1_null'
              WHEN first_source_data_2 LIKE '% %'                                         THEN '4_has_spaces_likely_campaign'
              WHEN char_length(first_source_data_2) >= 40                                 THEN '2_long_string_likely_gclid'
              WHEN char_length(first_source_data_2) BETWEEN 20 AND 39                     THEN '3_medium_string'
              ELSE                                                                             '5_short_string'
            END AS pattern,
            COUNT(*)::int AS contacts
          FROM marketing_hubspot_contacts
          WHERE ${paidGoogle}
          GROUP BY 1
          ORDER BY 1
        `),
        ctx.db.query(`
          SELECT first_source_data_2 AS value,
                 char_length(first_source_data_2) AS len,
                 COUNT(*)::int AS n
          FROM marketing_hubspot_contacts
          WHERE ${paidGoogle} AND first_source_data_2 IS NOT NULL
          GROUP BY first_source_data_2
          ORDER BY n DESC
          LIMIT 20
        `),
        ctx.db.query(`
          SELECT
            COUNT(*) FILTER (WHERE first_converting_campaign IS NOT NULL)::int AS with_campaign,
            COUNT(*) FILTER (WHERE first_converting_campaign IS NULL)::int     AS without_campaign,
            COUNT(*)::int                                                       AS total
          FROM marketing_hubspot_contacts
          WHERE ${paidGoogle}
        `),
        ctx.db.query(`
          SELECT DISTINCT campaign_name
          FROM marketing_campaigns
          WHERE campaign_name IS NOT NULL
          ORDER BY campaign_name
        `),
        ctx.db.query(`
          SELECT
            mc.campaign_name,
            COUNT(DISTINCT c.contact_id) FILTER (WHERE c.first_converting_campaign = mc.campaign_name)::int AS matched_via_converting_campaign,
            COUNT(DISTINCT c.contact_id) FILTER (WHERE c.first_source_data_2       = mc.campaign_name)::int AS matched_via_source_data_2
          FROM (SELECT DISTINCT campaign_name FROM marketing_campaigns WHERE campaign_name IS NOT NULL) mc
          LEFT JOIN marketing_hubspot_contacts c
            ON (c.first_converting_campaign = mc.campaign_name OR c.first_source_data_2 = mc.campaign_name)
           AND c.first_source = 'PAID_SEARCH' AND c.first_source_data_1 = 'google'
          GROUP BY mc.campaign_name
          ORDER BY matched_via_converting_campaign DESC, matched_via_source_data_2 DESC
        `),
      ]);
      // Broader breakdown — `paid_search_google` returned empty in the first
      // run, so we need to see what first_source / first_source_data_1
      // values HubSpot actually stores (case mismatch suspected).
      const [overall, sources, data1ForTopSources, sampleRows] = await Promise.all([
        ctx.db.query(`
          SELECT
            COUNT(*)::int                                                   AS total_contacts,
            COUNT(*) FILTER (WHERE first_source IS NOT NULL)::int           AS with_first_source,
            COUNT(*) FILTER (WHERE gclid IS NOT NULL)::int                  AS with_gclid,
            COUNT(*) FILTER (WHERE first_converting_campaign IS NOT NULL)::int AS with_converting_campaign
          FROM marketing_hubspot_contacts
        `),
        ctx.db.query(`
          SELECT first_source, COUNT(*)::int AS n
          FROM marketing_hubspot_contacts
          GROUP BY first_source
          ORDER BY n DESC
          LIMIT 30
        `),
        ctx.db.query(`
          SELECT first_source, first_source_data_1, COUNT(*)::int AS n
          FROM marketing_hubspot_contacts
          WHERE first_source IS NOT NULL
          GROUP BY first_source, first_source_data_1
          ORDER BY n DESC
          LIMIT 50
        `),
        ctx.db.query(`
          SELECT contact_id, first_source, first_source_data_1, first_source_data_2, first_converting_campaign, gclid
          FROM marketing_hubspot_contacts
          WHERE gclid IS NOT NULL
          ORDER BY contact_id DESC
          LIMIT 5
        `),
      ]);
      ctx.json({
        note: 'paid_search_google.* came back empty — broader breakdown below shows what HubSpot ACTUALLY stores.',
        overall: overall.rows[0],
        first_source_distribution: sources.rows,
        first_source_x_data1: data1ForTopSources.rows,
        sample_rows_with_gclid: sampleRows.rows,
        paid_search_google_filter_check: {
          patterns_breakdown:           patterns.rows,
          top_source_data_2_values:     samples.rows,
          converting_campaign_coverage: campaignCov.rows[0],
        },
        google_ads_campaign_names:    campaigns.rows.map(r => r.campaign_name),
        join_matches_per_campaign:    matches.rows,
      });
    } catch(e) { ctx.json({ error: e.message }, 500); }
    return true;
  }

  // ── GET /api/marketing/search-term-attribution ────────────────────
  // Per-search-term first-touch attribution (v1.46.9). The 2026-05-27
  // diagnostic proved HubSpot stores the LITERAL SEARCH TERM users typed
  // in first_source_data_2 (previously assumed to be a gclid). That makes
  // search-term-level closed-loop attribution trivial — just JOIN on the
  // normalized term.
  //
  // Match: case-insensitive + trim on both sides. Mirrors campaign-
  // attribution's shape so the frontend can merge attribution data onto
  // the existing search-terms table the same way it does for campaigns.
  //
  // Aliases are NOT applied here — search terms are user-typed strings,
  // not renamed marketing assets, so there's nothing to alias. PAID_SEARCH
  // only (organic-search keyword attribution would need referrer parsing
  // on the HubSpot side, which we don't pull).
  if (pathname === '/api/marketing/search-term-attribution' && req.method === 'GET') {
    try {
      const days = _parseDays(req);
      const am   = _attrModel(req);  // v1.50.8 — first/last/all, matched on the matching *_source_data_2
      const rows = ctx.db ? (await ctx.db.query(`
        WITH search_terms AS (
          SELECT DISTINCT LOWER(TRIM(search_term)) AS search_term
          FROM marketing_search_terms
          WHERE date >= CURRENT_DATE - INTERVAL '1 day' * $1
            AND search_term IS NOT NULL
            AND TRIM(search_term) <> ''
        )
        SELECT
          st.search_term,
          COUNT(DISTINCT c.contact_id)                                                            AS leads,
          COUNT(DISTINCT d.deal_id)                                                               AS deals_total,
          COUNT(DISTINCT CASE WHEN d.is_closed_won  THEN d.deal_id END)                           AS deals_won,
          COUNT(DISTINCT CASE WHEN d.is_closed_lost THEN d.deal_id END)                           AS deals_lost,
          COUNT(DISTINCT CASE WHEN d.deal_id IS NOT NULL AND NOT d.is_closed THEN d.deal_id END)  AS deals_open,
          COALESCE(SUM(CASE WHEN d.is_closed_won THEN d.amount ELSE 0 END), 0)::float             AS revenue_won
        FROM search_terms st
        LEFT JOIN marketing_hubspot_contacts c ON (
          ${am.termMatch}
          AND ${am.contactDate} >= CURRENT_DATE - INTERVAL '1 day' * $1
        )
        LEFT JOIN marketing_hubspot_deals d ON d.primary_contact_id = c.contact_id
        GROUP BY st.search_term
        ORDER BY revenue_won DESC, leads DESC
      `, [days])).rows : [];
      ctx.json({ rows, model: am.model });
    } catch(e) { ctx.json({ rows: [], error: e.message }, 500); }
    return true;
  }

  // ── GET /api/marketing/attribution-coverage ───────────────────────
  // The "trust thermometer" + paid-revenue numbers. v1.46.7 splits the
  // single `revenue_attributed` into two paid-attribution definitions so
  // the dashboard can show first-touch and any-touch ROAS side by side:
  //
  //   FIRST-TOUCH (strict): first_source = 'PAID_SEARCH'. Matches HubSpot's
  //   "First ad interaction" report. Conservative — credits the ad only
  //   when it was the customer's first interaction with WhisperRoom.
  //
  //   ANY-TOUCH (last-click leaning): first_source = 'PAID_SEARCH' OR
  //   gclid IS NOT NULL. Catches customers who first found us via organic
  //   / referral / offline but did click a Google Ad somewhere along the
  //   way (a gclid is irrefutable proof of an ad click). Roughly matches
  //   Google Ads' own default last-click attribution.
  //
  //   Showing both surfaces the gap — if first-touch < 1x but any-touch
  //   > 3x, paid is profitable as a closer, not as an acquisition channel.
  //
  // The existing `revenue_attributed` / `deals_won_attributed` keys stay
  // as the "any source set" definition (used by the coverage thermometer
  // panel) for backward compatibility.
  if (pathname === '/api/marketing/attribution-coverage' && req.method === 'GET') {
    try {
      const days = _parseDays(req);
      const am   = _attrModel(req);
      // The trust-thermometer keys (contacts_with_source, *_attributed) stay
      // model-INDEPENDENT — they answer "how much is attributable at all?".
      // The *_selected keys + contacts_attributed are model-DRIVEN and feed
      // the Closed Revenue / HubSpot Contacts / True ROAS cards (v1.50.8).
      //
      // v1.50.9 — DEAL metrics window on closed_at (closedate), NOT created_at:
      // "Closed Revenue (90d)" must mean revenue that *closed* in the window,
      // matching HubSpot's Ads-tool basis (full deal amount per ad-touched
      // closed-won deal). CONTACT metrics stay on created_at — that's a cohort
      // question ("new contacts attributable"), and matches how first-touch was
      // validated against HubSpot's "First ad interaction" report.
      const r = ctx.db ? (await ctx.db.query(`
        SELECT
          (SELECT COUNT(*) FROM marketing_hubspot_contacts
             WHERE created_at >= CURRENT_DATE - INTERVAL '1 day' * $1)                                               AS contacts_total,
          (SELECT COUNT(*) FROM marketing_hubspot_contacts c
             WHERE ${am.contactDate} >= CURRENT_DATE - INTERVAL '1 day' * $1
               AND ${am.contactPaid})                                                                                AS contacts_attributed,
          (SELECT COUNT(*) FROM marketing_hubspot_deals d
             JOIN marketing_hubspot_contacts c ON c.contact_id = d.primary_contact_id
             WHERE d.closed_at >= CURRENT_DATE - INTERVAL '1 day' * $1 AND d.is_closed_won
               AND ${am.contactPaid})                                                                                AS deals_won_selected,
          (SELECT COALESCE(SUM(d.amount), 0)::float FROM marketing_hubspot_deals d
             JOIN marketing_hubspot_contacts c ON c.contact_id = d.primary_contact_id
             WHERE d.closed_at >= CURRENT_DATE - INTERVAL '1 day' * $1 AND d.is_closed_won
               AND ${am.contactPaid})                                                                                AS revenue_selected,
          (SELECT COUNT(*) FROM marketing_hubspot_contacts
             WHERE created_at >= CURRENT_DATE - INTERVAL '1 day' * $1
               AND (first_source IS NOT NULL OR gclid IS NOT NULL))                                                  AS contacts_with_source,
          (SELECT COUNT(*) FROM marketing_hubspot_contacts
             WHERE created_at >= CURRENT_DATE - INTERVAL '1 day' * $1
               AND gclid IS NOT NULL)                                                                                AS contacts_with_gclid,
          (SELECT COUNT(*) FROM marketing_hubspot_deals
             WHERE closed_at >= CURRENT_DATE - INTERVAL '1 day' * $1 AND is_closed_won)                             AS deals_won_total,
          (SELECT COUNT(*) FROM marketing_hubspot_deals d
             JOIN marketing_hubspot_contacts c ON c.contact_id = d.primary_contact_id
             WHERE d.closed_at >= CURRENT_DATE - INTERVAL '1 day' * $1 AND d.is_closed_won
               AND (c.first_source IS NOT NULL OR c.gclid IS NOT NULL))                                              AS deals_won_attributed,
          (SELECT COALESCE(SUM(amount), 0)::float FROM marketing_hubspot_deals
             WHERE closed_at >= CURRENT_DATE - INTERVAL '1 day' * $1 AND is_closed_won)                             AS revenue_total,
          (SELECT COALESCE(SUM(d.amount), 0)::float FROM marketing_hubspot_deals d
             JOIN marketing_hubspot_contacts c ON c.contact_id = d.primary_contact_id
             WHERE d.closed_at >= CURRENT_DATE - INTERVAL '1 day' * $1 AND d.is_closed_won
               AND (c.first_source IS NOT NULL OR c.gclid IS NOT NULL))                                              AS revenue_attributed,
          (SELECT COUNT(*) FROM marketing_hubspot_deals d
             JOIN marketing_hubspot_contacts c ON c.contact_id = d.primary_contact_id
             WHERE d.closed_at >= CURRENT_DATE - INTERVAL '1 day' * $1 AND d.is_closed_won
               AND c.first_source = 'PAID_SEARCH')                                                                   AS deals_won_first_touch,
          (SELECT COALESCE(SUM(d.amount), 0)::float FROM marketing_hubspot_deals d
             JOIN marketing_hubspot_contacts c ON c.contact_id = d.primary_contact_id
             WHERE d.closed_at >= CURRENT_DATE - INTERVAL '1 day' * $1 AND d.is_closed_won
               AND c.first_source = 'PAID_SEARCH')                                                                   AS revenue_first_touch,
          (SELECT COUNT(*) FROM marketing_hubspot_deals d
             JOIN marketing_hubspot_contacts c ON c.contact_id = d.primary_contact_id
             WHERE d.closed_at >= CURRENT_DATE - INTERVAL '1 day' * $1 AND d.is_closed_won
               AND (c.first_source = 'PAID_SEARCH' OR c.gclid IS NOT NULL))                                          AS deals_won_any_touch,
          (SELECT COALESCE(SUM(d.amount), 0)::float FROM marketing_hubspot_deals d
             JOIN marketing_hubspot_contacts c ON c.contact_id = d.primary_contact_id
             WHERE d.closed_at >= CURRENT_DATE - INTERVAL '1 day' * $1 AND d.is_closed_won
               AND (c.first_source = 'PAID_SEARCH' OR c.gclid IS NOT NULL))                                          AS revenue_any_touch
      `, [days])).rows[0] : {};
      ctx.json({ ...(r || {}), model: am.model });
    } catch(e) { ctx.json({ error: e.message }, 500); }
    return true;
  }

  // ── GET /api/marketing/segments/proposed ──────────────────────────
  // Read-only diagnostic (v1.50.10). Classifies EVERY distinct campaign in
  // marketing_campaigns (all-time, no date window — we want the full
  // campaign universe) via segment_map.json, so Gabe can review + edit the
  // mapping before the Segment Performance UI is built. No writes, no schema
  // change. Spend/clicks/conversions are lifetime totals per campaign purely
  // to sort by materiality. Returns by-segment rollups + the Mixed and
  // Unclassified lists called out for review.
  if (pathname === '/api/marketing/segments/proposed' && req.method === 'GET') {
    try {
      const map  = _loadSegmentMap();
      const rows = ctx.db ? (await ctx.db.query(`
        SELECT campaign_name,
               (SUM(cost_micros)::float / 1000000) AS spend,
               SUM(clicks)::bigint                 AS clicks,
               SUM(conversions)::float             AS conversions,
               MIN(date)                           AS first_date,
               MAX(date)                           AS last_date
        FROM marketing_campaigns
        WHERE campaign_name IS NOT NULL
        GROUP BY campaign_name
        ORDER BY spend DESC NULLS LAST
      `)).rows : [];
      const campaigns = rows.map(r => {
        const c = _classifyCampaign(r.campaign_name, map);
        return {
          campaign_name: r.campaign_name,
          spend:       Math.round((r.spend || 0) * 100) / 100,
          clicks:      Number(r.clicks) || 0,
          conversions: r.conversions || 0,
          segment:     c.segment,
          rule:        c.rule,
          split:       c.split || null,
          first_date:  r.first_date,
          last_date:   r.last_date,
        };
      });
      // Roll up by segment (spend + campaign count) for an at-a-glance review.
      const bySeg = {};
      for (const c of campaigns) {
        (bySeg[c.segment] = bySeg[c.segment] || { segment: c.segment, campaigns: 0, spend: 0 });
        bySeg[c.segment].campaigns += 1;
        bySeg[c.segment].spend     += c.spend;
      }
      const by_segment = Object.values(bySeg)
        .map(s => ({ ...s, spend: Math.round(s.spend * 100) / 100 }))
        .sort((a, b) => b.spend - a.spend);
      ctx.json({
        note: 'PROPOSED campaign→segment mapping for review. Edit marketing/segment_map.json, redeploy, reload. Resolution: override → rule → mixed_signals → Unclassified.',
        total_campaigns: campaigns.length,
        segments_defined: map.segments || [],
        by_segment,
        unclassified: campaigns.filter(c => c.segment === 'Unclassified'),
        mixed:        campaigns.filter(c => c.segment === 'Mixed'),
        campaigns,
      });
    } catch(e) { ctx.json({ error: e.message }, 500); }
    return true;
  }

  return false;
}

module.exports = { handle, MARKETING_ALLOWLIST };
