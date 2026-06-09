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
const https = require('https');
const etl    = require('./google-ads-etl');
const hsEtl  = require('./hubspot-etl');
const gscEtl = require('./gsc-etl');

// Empty array = open to everyone (allowlist disabled). Populate with
// ownerIds to re-lock — e.g. ['36303670', '36320208'] for Benton + Gabe.
const MARKETING_ALLOWLIST = [];

// WhisperRoom's HubSpot portal/account id (from get_user_details / record
// URLs). Used to build deep links to contact (0-1) and deal (0-3) records
// for the drill-down popups. Single place to change if the portal ever moves.
const HS_PORTAL_ID = '5764220';

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
  // v1.84.1 — Gabe-confirmed historical renames (2026-06-09 source-data2 diag).
  // These paid contacts carry old campaign names with no current Google Ads
  // match; redirecting them recovers their deals out of the "Unattributed"
  // reconciliation row and into the live parent campaign.
  { hsName: '**lp portable general (us/can) - a',     gaName: '**LP General (US/CAN) - Combined' },
  { hsName: 'display remarketing - search remarketing', gaName: '2025 WR Active User Remarketing' },
  { hsName: 'zoom booth - search remarketing',          gaName: '2025 WR Active User Remarketing' },
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
  // v1.61.2 — Gabe's call: campaigns that match no rule/signal fall into
  // Mixed rather than a separate Unclassified bucket, so the share-of-revenue
  // rollup + segment table bundle them with the other un-segmented spend.
  return { segment: 'Mixed', rule: 'default' };
}

// ── Funnel: Quote stage (v1.51.2) ────────────────────────────────────
// Sales Pipeline (pipeline='default') stages that mean "a quote was sent or
// beyond" — i.e. the deal reached the funnel's Quote leg. Stage values read
// from the live pipeline 2026-05-29 (HubSpot keeps legacy internal ids like
// 'appointmentscheduled' = the "Sent Quote" stage). Deliberately EXCLUDES the
// pre-quote 'Bid' stage ('1169840404'). Closed-lost is included — those deals
// were quoted, then lost. Used by both the per-campaign funnel and the
// top-line funnel strip so "Quotes" means the same thing everywhere.
const QUOTE_STAGES = [
  'appointmentscheduled', // Sent Quote
  'qualifiedtobuy',       // Updated Quote
  'contractsent',         // Verbal Confirmation
  'closedwon',            // Closed won
  '845719',               // Shipped (post-won)
  'closedlost',           // Closed lost (quoted, then lost)
  '895819',               // Refund (post-won)
  '1021560863',           // Return In Progress
  '1846401',              // COVID-19 Delay
];

// Human labels for the (legacy-id) dealstage values above — used by the
// drill-down popup so a Quotes-row reads "Sent Quote", not "appointmentscheduled".
// Anything not listed falls back to the raw stage id.
const STAGE_LABELS = {
  appointmentscheduled: 'Sent Quote',
  qualifiedtobuy:       'Updated Quote',
  contractsent:         'Verbal Confirmation',
  closedwon:            'Closed won',
  '845719':             'Shipped',
  closedlost:           'Closed lost',
  '895819':             'Refund',
  '1021560863':         'Return In Progress',
  '1846401':            'COVID-19 Delay',
};

// Brand-intent markers for the ad-acquisition-quality strip (v1.59.6). A
// captured paid touch counts as "branded" when its search term contains one
// of these, or its campaign name looks branded — i.e. the customer was
// searching for us by name, the least-incremental kind of paid click. Edit
// here (or add branded campaign names) if the brand string ever changes.
// Matched case-insensitively as a substring (ILIKE '%term%'). (v1.59.6)
const BRAND_TERMS = ['whisper'];

// Pre-sync disk guard (v1.65.2). A runaway GSC sync once filled the SHARED
// Postgres volume (0.5GB → 98%) and took the whole app down. Before any sync
// we check the DB size (pg_database_size) against a soft limit — env
// PG_SOFT_LIMIT_MB, default 4500 (~90% of the current 5GB volume) — and refuse
// the sync with a clear message instead of crashing the disk. Never blocks on
// its own failure (returns ok:true) so a check error can't wedge syncing.
async function _capacityCheck(db) {
  if (!db) return { ok: true, usedMb: null, limitMb: null };
  try {
    const limitMb = parseInt(process.env.PG_SOFT_LIMIT_MB) || 4500;
    const { rows } = await db.query('SELECT pg_database_size(current_database()) AS bytes');
    const usedMb = Math.round(Number(rows[0].bytes) / 1048576);
    return { ok: usedMb < limitMb, usedMb, limitMb };
  } catch (e) {
    console.warn('[marketing] capacity check failed (allowing sync):', e.message);
    return { ok: true, usedMb: null, limitMb: null };
  }
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

    // v1.65.2 — refuse the sync if the DB is already near the volume's soft
    // limit, rather than letting a big pull fill the disk and crash the app.
    const cap = await _capacityCheck(ctx.db);
    if (!cap.ok) {
      ctx.json({ ok: false, error: `Postgres is at ${cap.usedMb} MB of the ${cap.limitMb} MB soft limit — grow the volume or trim data (e.g. TRUNCATE marketing_gsc_queries, marketing_gsc_pages) before syncing.` }, 507);
      return true;
    }

    try {
      let result;
      if      (report === 'campaigns')        result = await etl.syncCampaigns({   db: ctx.db, daysBack: gaDays });
      else if (report === 'keywords')         result = await etl.syncKeywords({    db: ctx.db, daysBack: gaDays });
      else if (report === 'search_terms')     result = await etl.syncSearchTerms({ db: ctx.db, daysBack: gaDays });
      else if (report === 'gsc')              result = await gscEtl.syncGsc({      db: ctx.db, daysBack: gaDays });
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
        const g = await gscEtl.syncGsc({          db: ctx.db, daysBack: Math.min(gaDays, 120) });
        const d = await hsEtl.syncHubSpotContacts({ db: ctx.db, daysBack: hsDays });
        const e = await hsEtl.syncHubSpotDeals({    db: ctx.db, daysBack: hsDays });
        result = { ok: a.ok && b.ok && c.ok && g.ok && d.ok && e.ok, parts: [a, b, c, g, d, e] };
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
               conversions, conversion_value,
               search_impression_share, search_budget_lost_is, search_rank_lost_is
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
               conversions,
               quality_score, qs_expected_ctr, qs_ad_relevance, qs_landing_page
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
          -- v1.51.2 funnel legs. Quotes = deals that reached a quote stage,
          -- by quote/create date in window. Closes + revenue = closed-won by
          -- CLOSE date in window (matches the closedate KPI cards). deals_total
          -- stays all-time for the "0 / N" context display.
          COUNT(DISTINCT CASE WHEN d.dealstage = ANY($4::text[])
                               AND d.created_at >= CURRENT_DATE - INTERVAL '1 day' * $3 THEN d.deal_id END) AS quotes,
          COUNT(DISTINCT d.deal_id)                                                               AS deals_total,
          COUNT(DISTINCT CASE WHEN d.is_closed_won
                               AND d.closed_at >= CURRENT_DATE - INTERVAL '1 day' * $3 THEN d.deal_id END)  AS deals_won,
          COUNT(DISTINCT CASE WHEN d.is_closed_lost THEN d.deal_id END)                           AS deals_lost,
          COUNT(DISTINCT CASE WHEN d.deal_id IS NOT NULL AND NOT d.is_closed THEN d.deal_id END)  AS deals_open,
          COALESCE(SUM(CASE WHEN d.is_closed_won
                             AND d.closed_at >= CURRENT_DATE - INTERVAL '1 day' * $3 THEN d.amount ELSE 0 END), 0)::float AS revenue_won
        FROM campaign_names cn
        LEFT JOIN marketing_hubspot_contacts c ON (
          ${am.campMatch}
          AND ${am.contactDate} >= CURRENT_DATE - INTERVAL '1 day' * $3
        )
        LEFT JOIN marketing_hubspot_deals d ON d.primary_contact_id = c.contact_id
        GROUP BY cn.campaign_id, cn.campaign_name
        ORDER BY revenue_won DESC, leads DESC
      `, [aliasHsNames, aliasGaNames, days, QUOTE_STAGES])).rows : [];
      // Tag each campaign with its buyer segment (same classifier as the
      // /segments/proposed diagnostic) so the table + segment rollup share
      // one source of truth.
      const segMap = _loadSegmentMap();
      for (const r of rows) r.segment = _classifyCampaign(r.campaign_name, segMap).segment;
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
          (SELECT COUNT(*) FROM marketing_hubspot_deals d
             JOIN marketing_hubspot_contacts c ON c.contact_id = d.primary_contact_id
             WHERE d.created_at >= CURRENT_DATE - INTERVAL '1 day' * $1
               AND d.dealstage = ANY($2::text[])
               AND ${am.contactPaid})                                                                                AS quotes_selected,
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
      `, [days, QUOTE_STAGES])).rows[0] : {};
      ctx.json({ ...(r || {}), model: am.model });
    } catch(e) { ctx.json({ error: e.message }, 500); }
    return true;
  }

  // ── GET /api/marketing/drill ──────────────────────────────────────
  // Backs the drill-down popups (v1.59.2). Returns the ACTUAL records behind
  // the four model-windowed numbers shown by attribution-coverage, each with a
  // deep link to its HubSpot record so a click can land on the contact/deal:
  //   type=contacts → paid-attributed contacts created in window (kpiHsContacts)
  //   type=quotes   → paid deals that reached a Quote stage, created in window
  //   type=closed   → paid closed-won deals, closed in window (deals_won_selected)
  //   type=revenue  → same closed-won set as `closed`, ordered by amount DESC
  //                   (the records summing to revenue_selected)
  // Uses the SAME ?days= window + ?model= attribution as the cards, so the
  // modal's row count matches the number the user clicked. Capped at 500 rows
  // (no realistic window approaches that; the cap just protects the browser).
  // Contact records are HubSpot object type 0-1, deals 0-3.
  //
  // v1.61.2 adds five more types so the strips + search-term table are also
  // drillable, each reusing the SAME join/window as the number it backs:
  //   type=ad-quality&bucket=prospecting|branded|unknown → closed-won deals in
  //        that ad-acquisition-quality bucket (mirrors /ad-quality, close-date
  //        windowed).
  //   type=segment-revenue&segment=<name> → closed-won deals whose attributed
  //        campaign maps to that buyer segment (mirrors the share-of-revenue
  //        rollup; close-date windowed; segment resolved in JS via the same
  //        _classifyCampaign the table uses, then deduped by deal).
  //   type=term-leads|term-deals|term-closed&term=<term> → the contacts / all
  //        deals / closed-won deals behind a search term's Leads / Deals / True
  //        ROAS cell. Mirrors /search-term-attribution: contact windowed by the
  //        model date, deals NOT date-windowed (so term-closed reconciles with
  //        the all-time-revenue basis of the True ROAS column).
  if (pathname === '/api/marketing/drill' && req.method === 'GET') {
    try {
      const days = _parseDays(req);
      const am   = _attrModel(req);
      const url  = new URL(req.url, 'http://localhost');
      const type = (url.searchParams.get('type') || '').toLowerCase();
      const bucket  = (url.searchParams.get('bucket')  || '').toLowerCase();        // ad-quality drill
      const segment =  url.searchParams.get('segment') || '';                       // share-of-revenue drill
      const term    = (url.searchParams.get('term')    || '').trim().toLowerCase(); // search-term drills
      const organicPred = am.model === 'last'                                       // organic drills
        ? `c.latest_source = 'ORGANIC_SEARCH'`
        : am.model === 'all'
          ? `(c.first_source = 'ORGANIC_SEARCH' OR c.latest_source = 'ORGANIC_SEARCH')`
          : `c.first_source = 'ORGANIC_SEARCH'`;
      const rec  = `https://app.hubspot.com/contacts/${HS_PORTAL_ID}/record`;
      if (!ctx.db) { ctx.json({ rows: [], type }); return true; }

      let rows = [];
      if (type === 'contacts') {
        rows = (await ctx.db.query(`
          SELECT c.contact_id AS id,
                 COALESCE(NULLIF(c.email, ''), 'Contact ' || c.contact_id) AS label,
                 COALESCE(c.lifecycle_stage, '—')                          AS sublabel,
                 NULL::float                                               AS amount
            FROM marketing_hubspot_contacts c
           WHERE ${am.contactDate} >= CURRENT_DATE - INTERVAL '1 day' * $1
             AND ${am.contactPaid}
           ORDER BY ${am.contactDate} DESC
           LIMIT 500
        `, [days])).rows.map(r => ({ ...r, url: `${rec}/0-1/${r.id}` }));
      } else if (type === 'quotes') {
        rows = (await ctx.db.query(`
          SELECT d.deal_id AS id,
                 COALESCE(NULLIF(d.deal_name, ''), 'Deal ' || d.deal_id) AS label,
                 d.dealstage                                             AS stage,
                 d.amount::float                                         AS amount
            FROM marketing_hubspot_deals d
            JOIN marketing_hubspot_contacts c ON c.contact_id = d.primary_contact_id
           WHERE d.created_at >= CURRENT_DATE - INTERVAL '1 day' * $1
             AND d.dealstage = ANY($2::text[])
             AND ${am.contactPaid}
           ORDER BY d.created_at DESC
           LIMIT 500
        `, [days, QUOTE_STAGES])).rows.map(r => ({
          id: r.id, label: r.label, amount: r.amount,
          sublabel: STAGE_LABELS[r.stage] || r.stage,
          url: `${rec}/0-3/${r.id}`,
        }));
      } else if (type === 'closed' || type === 'revenue') {
        rows = (await ctx.db.query(`
          SELECT d.deal_id AS id,
                 COALESCE(NULLIF(d.deal_name, ''), 'Deal ' || d.deal_id) AS label,
                 to_char(d.closed_at, 'Mon DD, YYYY')                    AS sublabel,
                 d.amount::float                                         AS amount
            FROM marketing_hubspot_deals d
            JOIN marketing_hubspot_contacts c ON c.contact_id = d.primary_contact_id
           WHERE d.closed_at >= CURRENT_DATE - INTERVAL '1 day' * $1 AND d.is_closed_won
             AND ${am.contactPaid}
           ORDER BY ${type === 'revenue' ? 'd.amount' : 'd.closed_at'} DESC
           LIMIT 500
        `, [days])).rows.map(r => ({ ...r, url: `${rec}/0-3/${r.id}` }));
      } else if (type === 'ad-quality') {
        // Mirrors /api/marketing/ad-quality's bucket classification exactly, so
        // the drill count == the pill count. Brand fragments inline BRAND_TERMS
        // (controlled config, not user input — safe).
        const VALID = ['prospecting', 'branded', 'unknown'];
        if (!VALID.includes(bucket)) { ctx.json({ rows: [], error: 'unknown bucket' }, 400); return true; }
        const brandLike    = col => BRAND_TERMS.map(t => `COALESCE(${col}, '') ILIKE '%${t}%'`).join(' OR ');
        const touchBranded = (tm, camp) => `((${brandLike(tm)}) OR COALESCE(${camp}, '') ILIKE '%brand%')`;
        const prospect = (src, tm, camp) =>
          `(${src} = 'PAID_SEARCH' AND (${camp} IS NOT NULL OR ${tm} IS NOT NULL) AND NOT ${touchBranded(tm, camp)})`;
        const brandedPaid = (src, tm, camp) => `(${src} = 'PAID_SEARCH' AND ${touchBranded(tm, camp)})`;
        const hasProspect =
          `(${prospect('c.first_source', 'c.first_source_data_2', 'c.first_source_data_1')} ` +
          `OR ${prospect('c.latest_source', 'c.latest_source_data_2', 'c.latest_source_data_1')})`;
        const hasBranded =
          `(${brandedPaid('c.first_source', 'c.first_source_data_2', 'c.first_source_data_1')} ` +
          `OR ${brandedPaid('c.latest_source', 'c.latest_source_data_2', 'c.latest_source_data_1')})`;
        rows = (await ctx.db.query(`
          WITH classified AS (
            SELECT d.deal_id, d.deal_name, d.amount, d.closed_at,
                   CASE WHEN ${hasProspect} THEN 'prospecting'
                        WHEN ${hasBranded}  THEN 'branded'
                        ELSE 'unknown' END AS bucket
              FROM marketing_hubspot_deals d
              JOIN marketing_hubspot_contacts c ON c.contact_id = d.primary_contact_id
             WHERE d.closed_at >= CURRENT_DATE - INTERVAL '1 day' * $1 AND d.is_closed_won
               AND ${am.contactPaid}
          )
          SELECT deal_id AS id,
                 COALESCE(NULLIF(deal_name, ''), 'Deal ' || deal_id) AS label,
                 to_char(closed_at, 'Mon DD, YYYY')                  AS sublabel,
                 amount::float                                       AS amount
            FROM classified
           WHERE bucket = $2
           ORDER BY amount DESC NULLS LAST
           LIMIT 500
        `, [days, bucket])).rows.map(r => ({ ...r, url: `${rec}/0-3/${r.id}` }));
      } else if (type === 'segment-revenue') {
        // Mirrors the share-of-closed-revenue rollup: closed-won deals (close-
        // date windowed) attributed to a campaign, classified to a buyer segment
        // in JS via the SAME _classifyCampaign the table uses, then filtered to
        // the requested segment and deduped by deal (a deal can match >1 campaign
        // under the 'all' model).
        if (!segment) { ctx.json({ rows: [], error: 'missing segment' }, 400); return true; }
        const aliasHsNames = HUBSPOT_CAMPAIGN_ALIASES.map(a => a.hsName);
        const aliasGaNames = HUBSPOT_CAMPAIGN_ALIASES.map(a => a.gaName);
        const raw = (await ctx.db.query(`
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
          SELECT DISTINCT d.deal_id AS id,
                 COALESCE(NULLIF(d.deal_name, ''), 'Deal ' || d.deal_id) AS label,
                 to_char(d.closed_at, 'Mon DD, YYYY')                    AS sublabel,
                 d.amount::float                                         AS amount,
                 cn.campaign_name                                        AS campaign_name
            FROM campaign_names cn
            JOIN marketing_hubspot_contacts c ON (
              ${am.campMatch}
              AND ${am.contactDate} >= CURRENT_DATE - INTERVAL '1 day' * $3
            )
            JOIN marketing_hubspot_deals d ON d.primary_contact_id = c.contact_id
           WHERE d.is_closed_won AND d.closed_at >= CURRENT_DATE - INTERVAL '1 day' * $3
           ORDER BY amount DESC NULLS LAST
        `, [aliasHsNames, aliasGaNames, days])).rows;
        const segMap = _loadSegmentMap();
        const seen = new Set();
        rows = [];
        for (const r of raw) {
          if (_classifyCampaign(r.campaign_name, segMap).segment !== segment) continue;
          if (seen.has(r.id)) continue;
          seen.add(r.id);
          rows.push({ id: r.id, label: r.label, sublabel: r.sublabel, amount: r.amount, url: `${rec}/0-3/${r.id}` });
        }
      } else if (type === 'campaign-closed') {
        // Closed-won deals attributed to ONE campaign — the per-campaign table's
        // "Closed" column drill. Mirrors segment-revenue's campMatch + alias JOIN
        // but pins campaign_names to the requested campaign_name, so the popup's
        // deal set + count match the cell exactly (same is_closed_won + closed_at
        // and contact-date windows as campaign-attribution's deals_won).
        const campaign = url.searchParams.get('campaign') || '';
        if (!campaign) { ctx.json({ rows: [], error: 'missing campaign' }, 400); return true; }
        const aliasHsNames = HUBSPOT_CAMPAIGN_ALIASES.map(a => a.hsName);
        const aliasGaNames = HUBSPOT_CAMPAIGN_ALIASES.map(a => a.gaName);
        rows = (await ctx.db.query(`
          WITH campaign_names AS (
            SELECT DISTINCT campaign_id, campaign_name
            FROM marketing_campaigns
            WHERE date >= CURRENT_DATE - INTERVAL '1 day' * $3
              AND campaign_name = $4
          ),
          aliases AS (
            SELECT hs_name, ga_name
            FROM unnest($1::text[], $2::text[]) AS t(hs_name, ga_name)
          )
          SELECT DISTINCT d.deal_id AS id,
                 COALESCE(NULLIF(d.deal_name, ''), 'Deal ' || d.deal_id) AS label,
                 to_char(d.closed_at, 'Mon DD, YYYY')                    AS sublabel,
                 d.amount::float                                         AS amount
            FROM campaign_names cn
            JOIN marketing_hubspot_contacts c ON (
              ${am.campMatch}
              AND ${am.contactDate} >= CURRENT_DATE - INTERVAL '1 day' * $3
            )
            JOIN marketing_hubspot_deals d ON d.primary_contact_id = c.contact_id
           WHERE d.is_closed_won AND d.closed_at >= CURRENT_DATE - INTERVAL '1 day' * $3
           ORDER BY amount DESC NULLS LAST
           LIMIT 500
        `, [aliasHsNames, aliasGaNames, days, campaign])).rows.map(r => ({ ...r, url: `${rec}/0-3/${r.id}` }));
      } else if (type === 'paid-unattributed') {
        // The Campaigns table's "Unattributed to a specific campaign" remainder
        // row (v1.84.6). Paid closed-won deals (closed in window) whose contact
        // matches NO current campaign via campMatch — i.e. the headline
        // deals_won_selected set minus the per-campaign resolved set. Uses the
        // SAME is_closed_won + closed_at window as the headline, and the SAME
        // campMatch + contact-date window as campaign-attribution, so the popup's
        // count == the number in the remainder row.
        const aliasHsNames = HUBSPOT_CAMPAIGN_ALIASES.map(a => a.hsName);
        const aliasGaNames = HUBSPOT_CAMPAIGN_ALIASES.map(a => a.gaName);
        rows = (await ctx.db.query(`
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
          SELECT DISTINCT d.deal_id AS id,
                 COALESCE(NULLIF(d.deal_name, ''), 'Deal ' || d.deal_id) AS label,
                 to_char(d.closed_at, 'Mon DD, YYYY')                    AS sublabel,
                 d.amount::float                                         AS amount
            FROM marketing_hubspot_deals d
            JOIN marketing_hubspot_contacts c ON c.contact_id = d.primary_contact_id
           WHERE d.is_closed_won
             AND d.closed_at >= CURRENT_DATE - INTERVAL '1 day' * $3
             AND ${am.contactPaid}
             AND NOT EXISTS (
               SELECT 1 FROM campaign_names cn
                WHERE ${am.campMatch}
                  AND ${am.contactDate} >= CURRENT_DATE - INTERVAL '1 day' * $3
             )
           ORDER BY amount DESC NULLS LAST
           LIMIT 500
        `, [aliasHsNames, aliasGaNames, days])).rows.map(r => ({ ...r, url: `${rec}/0-3/${r.id}` }));
      } else if (type === 'paid-unattributed-term') {
        // The Search-Terms table's "Unattributed to a specific search term"
        // remainder row (v1.84.6). Paid closed-won deals (closed in window) whose
        // contact's first_source_data_2 matches NO synced search term. Mirrors
        // search-term-attribution's term set + termMatch + contact-date window.
        rows = (await ctx.db.query(`
          WITH search_terms AS (
            SELECT DISTINCT LOWER(TRIM(search_term)) AS search_term
            FROM marketing_search_terms
            WHERE date >= CURRENT_DATE - INTERVAL '1 day' * $1
              AND search_term IS NOT NULL
              AND TRIM(search_term) <> ''
          )
          SELECT DISTINCT d.deal_id AS id,
                 COALESCE(NULLIF(d.deal_name, ''), 'Deal ' || d.deal_id) AS label,
                 to_char(d.closed_at, 'Mon DD, YYYY')                    AS sublabel,
                 d.amount::float                                         AS amount
            FROM marketing_hubspot_deals d
            JOIN marketing_hubspot_contacts c ON c.contact_id = d.primary_contact_id
           WHERE d.is_closed_won
             AND d.closed_at >= CURRENT_DATE - INTERVAL '1 day' * $1
             AND ${am.contactPaid}
             AND NOT EXISTS (
               SELECT 1 FROM search_terms st
                WHERE ${am.termMatch}
                  AND ${am.contactDate} >= CURRENT_DATE - INTERVAL '1 day' * $1
             )
           ORDER BY amount DESC NULLS LAST
           LIMIT 500
        `, [days])).rows.map(r => ({ ...r, url: `${rec}/0-3/${r.id}` }));
      } else if (type === 'term-leads' || type === 'term-deals' || type === 'term-closed') {
        // Search-term drills. A one-row `st` CTE feeds am.termMatch (which compares
        // LOWER(TRIM(...)) = st.search_term); the contact is windowed by the model
        // date and deals are NOT date-windowed — so term-closed sums the same
        // all-time closed-won revenue as the search-term table's True ROAS column.
        if (!term) { ctx.json({ rows: [], error: 'missing term' }, 400); return true; }
        if (type === 'term-leads') {
          rows = (await ctx.db.query(`
            WITH st AS (SELECT $2::text AS search_term)
            SELECT c.contact_id AS id,
                   COALESCE(NULLIF(c.email, ''), 'Contact ' || c.contact_id) AS label,
                   COALESCE(c.lifecycle_stage, '—')                          AS sublabel,
                   NULL::float                                               AS amount
              FROM st
              JOIN marketing_hubspot_contacts c ON (
                ${am.termMatch}
                AND ${am.contactDate} >= CURRENT_DATE - INTERVAL '1 day' * $1
              )
             ORDER BY ${am.contactDate} DESC
             LIMIT 500
          `, [days, term])).rows.map(r => ({ ...r, url: `${rec}/0-1/${r.id}` }));
        } else if (type === 'term-deals') {
          rows = (await ctx.db.query(`
            WITH st AS (SELECT $2::text AS search_term)
            SELECT DISTINCT d.deal_id AS id,
                   COALESCE(NULLIF(d.deal_name, ''), 'Deal ' || d.deal_id) AS label,
                   d.dealstage                                             AS stage,
                   d.amount::float                                         AS amount
              FROM st
              JOIN marketing_hubspot_contacts c ON (
                ${am.termMatch}
                AND ${am.contactDate} >= CURRENT_DATE - INTERVAL '1 day' * $1
              )
              JOIN marketing_hubspot_deals d ON d.primary_contact_id = c.contact_id
             ORDER BY amount DESC NULLS LAST
             LIMIT 500
          `, [days, term])).rows.map(r => ({
            id: r.id, label: r.label, amount: r.amount,
            sublabel: STAGE_LABELS[r.stage] || r.stage,
            url: `${rec}/0-3/${r.id}`,
          }));
        } else { // term-closed — the deals behind the term's True ROAS / Revenue
          rows = (await ctx.db.query(`
            WITH st AS (SELECT $2::text AS search_term)
            SELECT DISTINCT d.deal_id AS id,
                   COALESCE(NULLIF(d.deal_name, ''), 'Deal ' || d.deal_id) AS label,
                   to_char(d.closed_at, 'Mon DD, YYYY')                    AS sublabel,
                   d.amount::float                                         AS amount
              FROM st
              JOIN marketing_hubspot_contacts c ON (
                ${am.termMatch}
                AND ${am.contactDate} >= CURRENT_DATE - INTERVAL '1 day' * $1
              )
              JOIN marketing_hubspot_deals d ON d.primary_contact_id = c.contact_id
             WHERE d.is_closed_won
             ORDER BY amount DESC NULLS LAST
             LIMIT 500
          `, [days, term])).rows.map(r => ({ ...r, url: `${rec}/0-3/${r.id}` }));
        }
      } else if (type === 'organic-leads') {
        // Organic-source contacts (the Organic Leads card), created in window.
        rows = (await ctx.db.query(`
          SELECT c.contact_id AS id,
                 COALESCE(NULLIF(c.email, ''), 'Contact ' || c.contact_id) AS label,
                 COALESCE(c.lifecycle_stage, '—')                          AS sublabel,
                 NULL::float                                               AS amount
            FROM marketing_hubspot_contacts c
           WHERE ${am.contactDate} >= CURRENT_DATE - INTERVAL '1 day' * $1
             AND ${organicPred}
           ORDER BY ${am.contactDate} DESC
           LIMIT 500
        `, [days])).rows.map(r => ({ ...r, url: `${rec}/0-1/${r.id}` }));
      } else if (type === 'organic-closed' || type === 'organic-revenue') {
        // Closed-won deals from organic-source contacts (the Organic Closed Rev card).
        rows = (await ctx.db.query(`
          SELECT d.deal_id AS id,
                 COALESCE(NULLIF(d.deal_name, ''), 'Deal ' || d.deal_id) AS label,
                 to_char(d.closed_at, 'Mon DD, YYYY')                    AS sublabel,
                 d.amount::float                                         AS amount
            FROM marketing_hubspot_deals d
            JOIN marketing_hubspot_contacts c ON c.contact_id = d.primary_contact_id
           WHERE d.closed_at >= CURRENT_DATE - INTERVAL '1 day' * $1 AND d.is_closed_won
             AND ${organicPred}
           ORDER BY ${type === 'organic-revenue' ? 'd.amount' : 'd.closed_at'} DESC NULLS LAST
           LIMIT 500
        `, [days])).rows.map(r => ({ ...r, url: `${rec}/0-3/${r.id}` }));
      } else {
        ctx.json({ rows: [], error: 'unknown drill type' }, 400);
        return true;
      }
      ctx.json({ rows, type, model: am.model });
    } catch(e) { ctx.json({ rows: [], error: e.message }, 500); }
    return true;
  }

  // ── GET /api/marketing/ad-quality ─────────────────────────────────
  // Backs the "ad-acquisition quality" strip (v1.59.6). Splits the SAME
  // closed-won deal set as the funnel's Closed/Revenue (closedate-windowed,
  // attributed to paid under the selected model) into three buckets by what
  // the captured ad touches look like:
  //   prospecting → ≥1 captured touch is a NON-branded paid search (real
  //                 acquisition beyond brand) — the number that makes the
  //                 all-interactions ROAS a defensible incremental read.
  //   branded     → every captured paid touch is branded (searching for us
  //                 by name — least incremental).
  //   unknown     → qualifies via a gclid only, with no campaign/term detail
  //                 to judge.
  // IMPORTANT (honesty): we store only the FIRST and LATEST touch per contact,
  // not the full event history — so a branded-only-looking contact may have
  // had a non-branded MIDDLE touch we never captured. That means `prospecting`
  // is a FLOOR (genuine ad acquisition is ≥ this), never an overcount. The
  // brand heuristic (BRAND_TERMS) is config Gabe should eyeball, like
  // segment_map.json. Returns one row per non-empty bucket: {bucket,deals,revenue}.
  if (pathname === '/api/marketing/ad-quality' && req.method === 'GET') {
    try {
      const days = _parseDays(req);
      const am   = _attrModel(req);
      if (!ctx.db) { ctx.json({ rows: [], model: am.model }); return true; }

      // Brand-intent SQL fragments. BRAND_TERMS is controlled config (not user
      // input), so inlining as ILIKE substrings is safe. A touch is "branded"
      // when its term matches a brand word OR its campaign name looks branded.
      const brandLike = col => BRAND_TERMS.map(t => `COALESCE(${col}, '') ILIKE '%${t}%'`).join(' OR ');
      const touchBranded = (term, camp) => `((${brandLike(term)}) OR COALESCE(${camp}, '') ILIKE '%brand%')`;
      // A non-branded paid touch: paid-search, has some campaign/term detail, and isn't branded.
      const prospect = (src, term, camp) =>
        `(${src} = 'PAID_SEARCH' AND (${camp} IS NOT NULL OR ${term} IS NOT NULL) AND NOT ${touchBranded(term, camp)})`;
      const brandedPaid = (src, term, camp) => `(${src} = 'PAID_SEARCH' AND ${touchBranded(term, camp)})`;

      const hasProspect =
        `(${prospect('c.first_source', 'c.first_source_data_2', 'c.first_source_data_1')} ` +
        `OR ${prospect('c.latest_source', 'c.latest_source_data_2', 'c.latest_source_data_1')})`;
      const hasBranded =
        `(${brandedPaid('c.first_source', 'c.first_source_data_2', 'c.first_source_data_1')} ` +
        `OR ${brandedPaid('c.latest_source', 'c.latest_source_data_2', 'c.latest_source_data_1')})`;

      const rows = (await ctx.db.query(`
        WITH classified AS (
          SELECT d.deal_id, d.amount,
                 CASE WHEN ${hasProspect} THEN 'prospecting'
                      WHEN ${hasBranded}  THEN 'branded'
                      ELSE 'unknown' END AS bucket
            FROM marketing_hubspot_deals d
            JOIN marketing_hubspot_contacts c ON c.contact_id = d.primary_contact_id
           WHERE d.closed_at >= CURRENT_DATE - INTERVAL '1 day' * $1 AND d.is_closed_won
             AND ${am.contactPaid}
        )
        SELECT bucket,
               COUNT(*)::int                  AS deals,
               COALESCE(SUM(amount), 0)::float AS revenue
          FROM classified
         GROUP BY bucket
      `, [days])).rows;
      ctx.json({ rows, model: am.model });
    } catch(e) { ctx.json({ rows: [], error: e.message }, 500); }
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

  // ── GET /api/marketing/gsc-queries ────────────────────────────────
  // Organic queries aggregated over the window. ctr = clicks/impressions;
  // position = impression-weighted mean of the daily average positions.
  if (pathname === '/api/marketing/gsc-queries' && req.method === 'GET') {
    try {
      const days = _parseDays(req);
      const rows = ctx.db ? (await ctx.db.query(`
        SELECT query,
               SUM(clicks)::bigint      AS clicks,
               SUM(impressions)::bigint AS impressions,
               CASE WHEN SUM(impressions) > 0 THEN SUM(clicks)::float / SUM(impressions) ELSE 0 END        AS ctr,
               CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions) / SUM(impressions) ELSE 0 END AS position
        FROM marketing_gsc_queries
        WHERE date >= CURRENT_DATE - INTERVAL '1 day' * $1
        GROUP BY query
        ORDER BY clicks DESC NULLS LAST
        LIMIT 50000
      `, [days])).rows : [];
      ctx.json({ rows });
    } catch(e) { ctx.json({ rows: [], error: e.message }, 500); }
    return true;
  }

  // ── GET /api/marketing/gsc-pages ──────────────────────────────────
  // Organic landing pages aggregated over the window (SEO/content view), now
  // LEFT-JOINed to **which content closes revenue**: organic-source HubSpot
  // contacts grouped by their first-touch URL (hs_analytics_first_url) →
  // leads / closed-won deals / revenue, matched to GSC pages on a normalized
  // path (scheme+host stripped, trailing slash trimmed). Best-effort match
  // (HubSpot first_url vs GSC page formats differ slightly); pages with no
  // matching organic contacts show 0. Model-aware (?model=).
  if (pathname === '/api/marketing/gsc-pages' && req.method === 'GET') {
    try {
      const days = _parseDays(req);
      const am   = _attrModel(req);
      const organicPred = am.model === 'last'
        ? `c.latest_source = 'ORGANIC_SEARCH'`
        : am.model === 'all'
          ? `(c.first_source = 'ORGANIC_SEARCH' OR c.latest_source = 'ORGANIC_SEARCH')`
          : `c.first_source = 'ORGANIC_SEARCH'`;
      const rows = ctx.db ? (await ctx.db.query(`
        WITH gp AS (
          SELECT page,
                 rtrim(regexp_replace(lower(page), '^(https?://)?([^/]*)', ''), '/') AS path,
                 SUM(clicks)::bigint      AS clicks,
                 SUM(impressions)::bigint AS impressions,
                 CASE WHEN SUM(impressions) > 0 THEN SUM(clicks)::float / SUM(impressions) ELSE 0 END        AS ctr,
                 CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions) / SUM(impressions) ELSE 0 END AS position
          FROM marketing_gsc_pages
          WHERE date >= CURRENT_DATE - INTERVAL '1 day' * $1
          GROUP BY page
        ),
        rev AS (
          SELECT rtrim(regexp_replace(lower(c.first_url), '^(https?://)?([^/]*)', ''), '/') AS path,
                 COUNT(DISTINCT c.contact_id)                                                                       AS leads,
                 COUNT(DISTINCT CASE WHEN d.is_closed_won AND d.closed_at >= CURRENT_DATE - INTERVAL '1 day' * $1 THEN d.deal_id END) AS deals_won,
                 COALESCE(SUM(CASE WHEN d.is_closed_won AND d.closed_at >= CURRENT_DATE - INTERVAL '1 day' * $1 THEN d.amount ELSE 0 END), 0)::float AS revenue_won
          FROM marketing_hubspot_contacts c
          LEFT JOIN marketing_hubspot_deals d ON d.primary_contact_id = c.contact_id
          WHERE c.first_url IS NOT NULL
            AND ${am.contactDate} >= CURRENT_DATE - INTERVAL '1 day' * $1
            AND ${organicPred}
          GROUP BY 1
        )
        SELECT gp.page, gp.clicks, gp.impressions, gp.ctr, gp.position,
               COALESCE(rev.leads, 0)::int        AS leads,
               COALESCE(rev.deals_won, 0)::int    AS deals_won,
               COALESCE(rev.revenue_won, 0)::float AS revenue_won
        FROM gp
        LEFT JOIN rev ON gp.path = rev.path
        ORDER BY gp.clicks DESC NULLS LAST
        LIMIT 50000
      `, [days])).rows : [];
      ctx.json({ rows, model: am.model });
    } catch(e) { ctx.json({ rows: [], error: e.message }, 500); }
    return true;
  }

  // ── GET /api/marketing/gsc-overlap ────────────────────────────────
  // The hero view: paid (marketing_search_terms) FULL-JOIN organic
  // (marketing_gsc_queries) on the normalized term, so the client can tag
  // each as branded-cannibalization (paying + strong organic), organic-gap
  // (paying + ~no organic), or covered. Anchored on paid spend, but keeps
  // high-click organic-only rows too. Position is impression-weighted.
  if (pathname === '/api/marketing/gsc-overlap' && req.method === 'GET') {
    try {
      const days = _parseDays(req);
      const rows = ctx.db ? (await ctx.db.query(`
        WITH org AS (
          SELECT LOWER(TRIM(query)) AS term,
                 SUM(clicks)::bigint AS clicks,
                 CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions) / SUM(impressions) ELSE NULL END AS position
          FROM marketing_gsc_queries
          WHERE date >= CURRENT_DATE - INTERVAL '1 day' * $1
          GROUP BY LOWER(TRIM(query))
        ),
        paid AS (
          SELECT LOWER(TRIM(search_term)) AS term,
                 (SUM(cost_micros)::float / 1000000) AS cost,
                 SUM(clicks)::bigint AS clicks
          FROM marketing_search_terms
          WHERE date >= CURRENT_DATE - INTERVAL '1 day' * $1 AND search_term IS NOT NULL
          GROUP BY LOWER(TRIM(search_term))
        )
        SELECT COALESCE(p.term, o.term)      AS term,
               COALESCE(p.cost, 0)::float    AS paid_cost,
               COALESCE(p.clicks, 0)::bigint AS paid_clicks,
               COALESCE(o.clicks, 0)::bigint AS organic_clicks,
               o.position                    AS organic_position
        FROM paid p
        FULL OUTER JOIN org o ON p.term = o.term
        WHERE COALESCE(p.cost, 0) > 0 OR COALESCE(o.clicks, 0) >= 5
        ORDER BY paid_cost DESC NULLS LAST, organic_clicks DESC
        LIMIT 5000
      `, [days])).rows : [];
      ctx.json({ rows });
    } catch(e) { ctx.json({ rows: [], error: e.message }, 500); }
    return true;
  }

  // ── GET /api/marketing/gsc-summary ────────────────────────────────
  // Organic KPI strip. Headline totals (clicks/impressions/position) come from
  // marketing_gsc_daily — the date-only report Google does NOT anonymize — so
  // they match the GSC UI. The branded split can only come from the query table
  // (it's the only source with query text), which DOES drop anonymized rows; so
  // branded% is reported "of identified queries" and organic_identified_clicks
  // is returned alongside so the client can show coverage. Plus the channel-
  // level HubSpot tie (leads/deals/revenue from ORGANIC_SEARCH contacts).
  if (pathname === '/api/marketing/gsc-summary' && req.method === 'GET') {
    try {
      const days = _parseDays(req);
      const am   = _attrModel(req);
      const organicPred = am.model === 'last'
        ? `c.latest_source = 'ORGANIC_SEARCH'`
        : am.model === 'all'
          ? `(c.first_source = 'ORGANIC_SEARCH' OR c.latest_source = 'ORGANIC_SEARCH')`
          : `c.first_source = 'ORGANIC_SEARCH'`;
      let out = { leads: 0, deals_won: 0, revenue_won: 0, organic_clicks: 0, organic_impressions: 0,
                  organic_position: null, organic_identified_clicks: 0, organic_branded_clicks: 0,
                  organic_totals_source: 'daily', model: am.model };
      if (ctx.db) {
        const hs = (await ctx.db.query(`
          SELECT
            (SELECT COUNT(*) FROM marketing_hubspot_contacts c
               WHERE ${am.contactDate} >= CURRENT_DATE - INTERVAL '1 day' * $1 AND ${organicPred})               AS leads,
            (SELECT COUNT(*) FROM marketing_hubspot_deals d
               JOIN marketing_hubspot_contacts c ON c.contact_id = d.primary_contact_id
               WHERE d.closed_at >= CURRENT_DATE - INTERVAL '1 day' * $1 AND d.is_closed_won AND ${organicPred}) AS deals_won,
            (SELECT COALESCE(SUM(d.amount), 0)::float FROM marketing_hubspot_deals d
               JOIN marketing_hubspot_contacts c ON c.contact_id = d.primary_contact_id
               WHERE d.closed_at >= CURRENT_DATE - INTERVAL '1 day' * $1 AND d.is_closed_won AND ${organicPred}) AS revenue_won
        `, [days])).rows[0] || {};
        // Un-anonymized totals (match the GSC UI).
        const daily = (await ctx.db.query(`
          SELECT COALESCE(SUM(clicks), 0)::bigint      AS clicks,
                 COALESCE(SUM(impressions), 0)::bigint AS impressions,
                 CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions) / SUM(impressions) ELSE NULL END AS position
          FROM marketing_gsc_daily WHERE date >= CURRENT_DATE - INTERVAL '1 day' * $1
        `, [days])).rows[0] || {};
        // Query-dimension data — identified (named) clicks + branded subset.
        const q = (await ctx.db.query(`
          SELECT COALESCE(SUM(clicks), 0)::bigint      AS identified_clicks,
                 COALESCE(SUM(impressions), 0)::bigint AS identified_impressions,
                 COALESCE(SUM(clicks) FILTER (WHERE query ILIKE '%whisper%'), 0)::bigint AS branded_clicks,
                 CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions) / SUM(impressions) ELSE NULL END AS q_position
          FROM marketing_gsc_queries WHERE date >= CURRENT_DATE - INTERVAL '1 day' * $1
        `, [days])).rows[0] || {};
        const hasDaily = (+daily.clicks > 0) || (+daily.impressions > 0);
        out = {
          leads: +hs.leads || 0, deals_won: +hs.deals_won || 0, revenue_won: +hs.revenue_won || 0,
          organic_clicks:      hasDaily ? +daily.clicks      : +q.identified_clicks,
          organic_impressions: hasDaily ? +daily.impressions : +q.identified_impressions,
          organic_position:    hasDaily ? daily.position     : q.q_position,
          organic_identified_clicks: +q.identified_clicks || 0,
          organic_branded_clicks:    +q.branded_clicks || 0,
          organic_totals_source: hasDaily ? 'daily' : 'queries',
          model: am.model,
        };
      }
      ctx.json(out);
    } catch(e) { ctx.json({ error: e.message }, 500); }
    return true;
  }

  // ── GET /api/marketing/gsc-timeseries ─────────────────────────────
  // Daily organic clicks / impressions / ctr / position for the chart. Reads
  // the un-anonymized date-only totals (marketing_gsc_daily) so the chart and
  // KPI cards match the GSC UI. Falls back to the query-dimension rollup only
  // when the daily table hasn't been synced yet (avoids a blank chart).
  if (pathname === '/api/marketing/gsc-timeseries' && req.method === 'GET') {
    try {
      const days = _parseDays(req);
      let rows = ctx.db ? (await ctx.db.query(`
        SELECT to_char(date, 'YYYY-MM-DD') AS date,
               clicks::bigint AS clicks, impressions::bigint AS impressions,
               ctr AS ctr, position AS position
        FROM marketing_gsc_daily
        WHERE date >= CURRENT_DATE - INTERVAL '1 day' * $1
        ORDER BY date ASC
      `, [days])).rows : [];
      if (ctx.db && !rows.length) {
        rows = (await ctx.db.query(`
          SELECT to_char(date, 'YYYY-MM-DD') AS date, SUM(clicks)::bigint AS clicks,
                 SUM(impressions)::bigint AS impressions,
                 CASE WHEN SUM(impressions) > 0 THEN SUM(clicks)::float / SUM(impressions) ELSE 0 END            AS ctr,
                 CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions) / SUM(impressions) ELSE NULL END AS position
          FROM marketing_gsc_queries
          WHERE date >= CURRENT_DATE - INTERVAL '1 day' * $1
          GROUP BY date ORDER BY date ASC
        `, [days])).rows;
      }
      ctx.json({ rows });
    } catch(e) { ctx.json({ rows: [], error: e.message }, 500); }
    return true;
  }

  // ── GET /api/marketing/gsc-striking-distance ──────────────────────
  // Queries ranking on page 2 (impression-weighted avg position 10–20) with
  // real impression volume — the "almost ranking" list. Nudging the page
  // behind one of these a few spots onto page 1 is the highest-ROI organic
  // move. `?minImpr=` (default 20) trims long-tail noise.
  if (pathname === '/api/marketing/gsc-striking-distance' && req.method === 'GET') {
    try {
      const days    = _parseDays(req);
      const sp      = new URL(req.url, 'http://localhost').searchParams;
      const minImpr = Math.max(0, parseInt(sp.get('minImpr')) || 20);
      const rows = ctx.db ? (await ctx.db.query(`
        SELECT query,
               SUM(clicks)::bigint      AS clicks,
               SUM(impressions)::bigint AS impressions,
               CASE WHEN SUM(impressions) > 0 THEN SUM(clicks)::float / SUM(impressions) ELSE 0 END AS ctr,
               SUM(position * impressions) / NULLIF(SUM(impressions), 0)                            AS position
        FROM marketing_gsc_queries
        WHERE date >= CURRENT_DATE - INTERVAL '1 day' * $1
        GROUP BY query
        HAVING SUM(impressions) >= $2
           AND SUM(position * impressions) / NULLIF(SUM(impressions), 0) >  10
           AND SUM(position * impressions) / NULLIF(SUM(impressions), 0) <= 20
        ORDER BY impressions DESC
        LIMIT 50000
      `, [days, minImpr])).rows : [];
      ctx.json({ rows, minImpr });
    } catch(e) { ctx.json({ rows: [], error: e.message }, 500); }
    return true;
  }

  // ── GET /api/marketing/gsc-movers ─────────────────────────────────
  // Period-over-period: current window vs the immediately-preceding equal
  // window, per query (or ?dim=page). Surfaces the biggest organic-click
  // gainers and losers — the daily granularity we store but otherwise
  // aggregate flat. delta_clicks drives the default sort; pos_now/pos_prev
  // let the client show whether rank improved (lower = better).
  if (pathname === '/api/marketing/gsc-movers' && req.method === 'GET') {
    try {
      const days  = _parseDays(req);
      const sp    = new URL(req.url, 'http://localhost').searchParams;
      const dim   = sp.get('dim') === 'page' ? 'page' : 'query';
      const table = dim === 'page' ? 'marketing_gsc_pages' : 'marketing_gsc_queries';
      // dim/table are whitelisted literals (never raw request text) → safe to interpolate.
      const rows = ctx.db ? (await ctx.db.query(`
        WITH cur AS (
          SELECT ${dim} AS k, SUM(clicks)::bigint AS clicks, SUM(impressions)::bigint AS impressions,
                 SUM(position * impressions) / NULLIF(SUM(impressions), 0) AS position
          FROM ${table}
          WHERE date >= CURRENT_DATE - INTERVAL '1 day' * $1
          GROUP BY ${dim}
        ),
        prev AS (
          SELECT ${dim} AS k, SUM(clicks)::bigint AS clicks, SUM(impressions)::bigint AS impressions,
                 SUM(position * impressions) / NULLIF(SUM(impressions), 0) AS position
          FROM ${table}
          WHERE date >= CURRENT_DATE - INTERVAL '1 day' * ($1 * 2)
            AND date <  CURRENT_DATE - INTERVAL '1 day' * $1
          GROUP BY ${dim}
        )
        SELECT COALESCE(cur.k, prev.k)                                       AS key,
               COALESCE(cur.clicks, 0)::bigint                               AS clicks_now,
               COALESCE(prev.clicks, 0)::bigint                              AS clicks_prev,
               (COALESCE(cur.clicks, 0) - COALESCE(prev.clicks, 0))::bigint  AS delta_clicks,
               COALESCE(cur.impressions, 0)::bigint                          AS impr_now,
               COALESCE(prev.impressions, 0)::bigint                         AS impr_prev,
               cur.position                                                  AS pos_now,
               prev.position                                                 AS pos_prev
        FROM cur
        FULL OUTER JOIN prev ON cur.k = prev.k
        WHERE COALESCE(cur.clicks, 0) + COALESCE(prev.clicks, 0) >= 3
        ORDER BY ABS(COALESCE(cur.clicks, 0) - COALESCE(prev.clicks, 0)) DESC
        LIMIT 50000
      `, [days])).rows : [];
      ctx.json({ rows, dim });
    } catch(e) { ctx.json({ rows: [], error: e.message }, 500); }
    return true;
  }

  // ── GET /api/marketing/gsc-ctr-opportunity ────────────────────────
  // Page-1 pages (or ?dim=query) whose actual CTR trails the expected CTR
  // for their average position — title / meta-description rewrite candidates.
  // exp_ctr is an industry-standard organic CTR-by-position curve (approx);
  // missed_clicks = impressions × (expected − actual), the click upside if
  // CTR rose to par. Only below-par page-1 rows with enough volume
  // (`?minImpr=`, default 30).
  if (pathname === '/api/marketing/gsc-ctr-opportunity' && req.method === 'GET') {
    try {
      const days    = _parseDays(req);
      const sp      = new URL(req.url, 'http://localhost').searchParams;
      const dim     = sp.get('dim') === 'query' ? 'query' : 'page';
      const table   = dim === 'query' ? 'marketing_gsc_queries' : 'marketing_gsc_pages';
      const minImpr = Math.max(0, parseInt(sp.get('minImpr')) || 30);
      const rows = ctx.db ? (await ctx.db.query(`
        SELECT key, clicks, impressions, ctr, position, exp_ctr,
               (exp_ctr - ctr)                AS gap,
               (impressions * (exp_ctr - ctr)) AS missed_clicks
        FROM (
          SELECT k AS key, clicks, impressions, ctr, position,
                 CASE
                   WHEN position < 1.5 THEN 0.280
                   WHEN position < 2.5 THEN 0.150
                   WHEN position < 3.5 THEN 0.100
                   WHEN position < 4.5 THEN 0.075
                   WHEN position < 5.5 THEN 0.058
                   WHEN position < 6.5 THEN 0.045
                   WHEN position < 7.5 THEN 0.035
                   WHEN position < 8.5 THEN 0.030
                   WHEN position < 9.5 THEN 0.026
                   ELSE 0.022
                 END AS exp_ctr
          FROM (
            SELECT ${dim} AS k,
                   SUM(clicks)::bigint      AS clicks,
                   SUM(impressions)::bigint AS impressions,
                   CASE WHEN SUM(impressions) > 0 THEN SUM(clicks)::float / SUM(impressions) ELSE 0 END AS ctr,
                   SUM(position * impressions) / NULLIF(SUM(impressions), 0)                            AS position
            FROM ${table}
            WHERE date >= CURRENT_DATE - INTERVAL '1 day' * $1
            GROUP BY ${dim}
            HAVING SUM(impressions) >= $2
          ) agg
        ) z
        WHERE position IS NOT NULL AND position <= 10.5 AND (exp_ctr - ctr) > 0.005
        ORDER BY missed_clicks DESC
        LIMIT 50000
      `, [days, minImpr])).rows : [];
      ctx.json({ rows, dim, minImpr });
    } catch(e) { ctx.json({ rows: [], error: e.message }, 500); }
    return true;
  }

  // ── GET /api/marketing/gsc-revenue-opportunity ────────────────────
  // The Revenue Opportunity Engine. Fuses three sources to rank organic
  // queries by the *additional revenue* likely from improving their rank:
  //   • GSC (marketing_gsc_queries) — current position / impressions / CTR.
  //   • Google Ads (marketing_search_terms) — the SAME query's PAID conversion
  //     rate, used as a per-query "how well does this intent monetize" signal
  //     (organic query→deal can't be joined — Google withholds the organic
  //     term — but the paid term IS the same string, so its CVR is a valid
  //     proxy). Falls back to the channel baseline when a term has no paid data.
  //   • HubSpot — channel-level organic closed revenue ÷ true organic clicks =
  //     $/organic-click, the dollar value the score multiplies into.
  //
  // Score = click_upside × rev_per_click × cvr_multiplier × reachability, where
  //   click_upside  = impressions × max(0, top3_CTR − current_CTR)   (volume + headroom)
  //   cvr_multiplier= clamp(paid_CVR / avg_paid_CVR, 0.25, 4)         (intent quality)
  //   reachability  = clamp((18 − position)/14, 0.25, 1)              (closer rank = likelier win)
  // Filtered to positions 4–15 (the realistically-improvable band) with
  // impressions ≥ ?minImpr (default 30). Model-aware (?model=) for the HubSpot
  // organic revenue/leads constants. revenue_opportunity is a dollar estimate;
  // the client also derives a 0–100 score (normalized to the top row).
  if (pathname === '/api/marketing/gsc-revenue-opportunity' && req.method === 'GET') {
    try {
      const days    = _parseDays(req);
      const am      = _attrModel(req);
      const sp      = new URL(req.url, 'http://localhost').searchParams;
      const minImpr = Math.max(0, parseInt(sp.get('minImpr')) || 30);
      const organicPred = am.model === 'last'
        ? `c.latest_source = 'ORGANIC_SEARCH'`
        : am.model === 'all'
          ? `(c.first_source = 'ORGANIC_SEARCH' OR c.latest_source = 'ORGANIC_SEARCH')`
          : `c.first_source = 'ORGANIC_SEARCH'`;
      const TARGET_CTR = 0.11;   // ~average CTR at positions 1–3
      const result = ctx.db ? (await ctx.db.query(`
        WITH consts AS (
          SELECT
            GREATEST(
              (SELECT COALESCE(SUM(clicks),0) FROM marketing_gsc_daily   WHERE date >= CURRENT_DATE - INTERVAL '1 day' * $1),
              (SELECT COALESCE(SUM(clicks),0) FROM marketing_gsc_queries WHERE date >= CURRENT_DATE - INTERVAL '1 day' * $1)
            )::float AS organic_clicks,
            (SELECT COALESCE(SUM(d.amount),0)::float FROM marketing_hubspot_deals d
               JOIN marketing_hubspot_contacts c ON c.contact_id = d.primary_contact_id
               WHERE d.closed_at >= CURRENT_DATE - INTERVAL '1 day' * $1 AND d.is_closed_won AND ${organicPred}) AS organic_rev,
            (SELECT COUNT(*) FROM marketing_hubspot_contacts c
               WHERE ${am.contactDate} >= CURRENT_DATE - INTERVAL '1 day' * $1 AND ${organicPred})              AS organic_leads,
            (SELECT COALESCE(SUM(conversions),0)::float FROM marketing_search_terms WHERE date >= CURRENT_DATE - INTERVAL '1 day' * $1) AS paid_conv_total,
            (SELECT COALESCE(SUM(clicks),0)::float      FROM marketing_search_terms WHERE date >= CURRENT_DATE - INTERVAL '1 day' * $1) AS paid_clicks_total
        ),
        cz AS (
          SELECT organic_clicks, organic_rev, organic_leads,
                 CASE WHEN organic_clicks > 0 THEN organic_rev / organic_clicks ELSE 0 END AS rev_per_click,
                 CASE WHEN paid_clicks_total > 0 THEN paid_conv_total / paid_clicks_total ELSE 0 END AS avg_paid_cvr
          FROM consts
        ),
        org AS (
          SELECT query,
                 SUM(clicks)::bigint AS clicks, SUM(impressions)::bigint AS impressions,
                 CASE WHEN SUM(impressions) > 0 THEN SUM(clicks)::float / SUM(impressions) ELSE 0 END AS ctr,
                 SUM(position * impressions) / NULLIF(SUM(impressions),0) AS position
          FROM marketing_gsc_queries
          WHERE date >= CURRENT_DATE - INTERVAL '1 day' * $1
          GROUP BY query
          HAVING SUM(impressions) >= $2
             AND SUM(position * impressions) / NULLIF(SUM(impressions),0) >  4
             AND SUM(position * impressions) / NULLIF(SUM(impressions),0) <= 15
        ),
        paid AS (
          SELECT LOWER(TRIM(search_term)) AS term,
                 SUM(clicks)::bigint AS p_clicks, SUM(conversions)::float AS p_conv,
                 CASE WHEN SUM(clicks) > 0 THEN SUM(conversions)::float / SUM(clicks) ELSE NULL END AS p_cvr
          FROM marketing_search_terms
          WHERE date >= CURRENT_DATE - INTERVAL '1 day' * $1 AND search_term IS NOT NULL
          GROUP BY LOWER(TRIM(search_term))
        ),
        scored AS (
          SELECT o.query, o.clicks, o.impressions, o.ctr, o.position,
                 p.p_clicks, p.p_conv, p.p_cvr,
                 (p.p_clicks IS NOT NULL AND p.p_clicks >= 10) AS has_paid_signal,
                 GREATEST(0, o.impressions * (${TARGET_CTR} - o.ctr))                       AS extra_clicks,
                 cz.rev_per_click,
                 CASE WHEN p.p_clicks >= 10 AND cz.avg_paid_cvr > 0 AND p.p_cvr IS NOT NULL
                      THEN LEAST(4, GREATEST(0.25, p.p_cvr / cz.avg_paid_cvr)) ELSE 1 END   AS cvr_mult,
                 LEAST(1, GREATEST(0.25, (18 - o.position) / 14.0))                          AS reach,
                 -- The real page Google ranks for this query (top by clicks), from
                 -- the query×page snapshot. Replaces keyword-overlap guessing.
                 rp.page         AS actual_page,
                 rp.clicks       AS page_clicks,
                 rp.impressions  AS page_impr,
                 rp.ctr          AS page_ctr,
                 rp.position     AS page_position
          FROM org o
          CROSS JOIN cz
          LEFT JOIN paid p ON p.term = LOWER(TRIM(o.query))
          LEFT JOIN LATERAL (
            SELECT qp.page, qp.clicks, qp.impressions, qp.ctr, qp.position
            FROM marketing_gsc_query_pages qp
            WHERE qp.query = o.query
            ORDER BY qp.clicks DESC NULLS LAST, qp.impressions DESC NULLS LAST
            LIMIT 1
          ) rp ON TRUE
        )
        SELECT *,
               (extra_clicks * rev_per_click * cvr_mult * reach) AS revenue_opportunity
        FROM scored
        ORDER BY revenue_opportunity DESC NULLS LAST
        LIMIT 50000
      `, [days, minImpr])).rows : [];
      ctx.json({ rows: result, model: am.model, minImpr });
    } catch(e) { ctx.json({ rows: [], error: e.message }, 500); }
    return true;
  }

  // ── POST /api/marketing/ad-rewrite ────────────────────────────────
  // Rewrites a Google Ads responsive search ad for a campaign with Claude,
  // grounded in the campaign's real high-converting search terms + (optional)
  // current ad copy. WhisperRoom brand voice. Uses ANTHROPIC_API_KEY (Railway).
  if (pathname === '/api/marketing/ad-rewrite' && req.method === 'POST') {
    try {
      const key = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
      if (!key) { ctx.json({ ok: false, error: 'Ad rewrites need ANTHROPIC_API_KEY set in Railway.' }, 503); return true; }
      let body = {};
      try {
        const chunks = [];
        await new Promise((res, rej) => { req.on('data', c => chunks.push(c)); req.on('end', res); req.on('error', rej); });
        body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      } catch {}
      const campaign = String(body.campaign || body.topic || '').slice(0, 120);
      const terms    = Array.isArray(body.terms) ? body.terms.slice(0, 15).map(t => String(t).slice(0, 80)) : [];
      const cur      = body.current || {};
      const curHeads = Array.isArray(cur.headlines)    ? cur.headlines.slice(0, 15).map(h => String(h).slice(0, 60))    : [];
      const curDescs = Array.isArray(cur.descriptions) ? cur.descriptions.slice(0, 4).map(d => String(d).slice(0, 120)) : [];
      const userMsg =
        `Campaign: ${campaign || '(unnamed booth campaign)'}\n` +
        (terms.length    ? `\nHigh-volume / converting search terms people actually typed:\n${terms.map(t => '- ' + t).join('\n')}\n` : '') +
        (curHeads.length ? `\nCurrent headlines (improve on these, don't repeat them):\n${curHeads.map(h => '- ' + h).join('\n')}\n` : '') +
        (curDescs.length ? `\nCurrent descriptions:\n${curDescs.map(d => '- ' + d).join('\n')}\n` : '') +
        `\nWrite 8 fresh headlines (each 30 characters or fewer) and 4 descriptions (each 90 characters or fewer), plus a one-sentence rationale.`;
      const payload = JSON.stringify({
        model: AD_REWRITE_MODEL,
        max_tokens: 1500,
        system: [{ type: 'text', text: AD_REWRITE_SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userMsg }],
        output_config: { format: { type: 'json_schema', schema: {
          type: 'object',
          properties: {
            headlines:    { type: 'array', items: { type: 'string' } },
            descriptions: { type: 'array', items: { type: 'string' } },
            rationale:    { type: 'string' },
          },
          required: ['headlines', 'descriptions', 'rationale'],
          additionalProperties: false,
        } } },
      });
      const out = await _anthropicMessages(key, payload);
      if (!out.ok) { ctx.json({ ok: false, error: out.error }, out.status || 502); return true; }
      let parsed;
      try {
        const txt = (out.json.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
        parsed = JSON.parse(txt);
      } catch { ctx.json({ ok: false, error: 'Could not parse the model output as JSON.' }, 502); return true; }
      ctx.json({ ok: true, headlines: parsed.headlines || [], descriptions: parsed.descriptions || [], rationale: parsed.rationale || '' });
    } catch(e) { ctx.json({ ok: false, error: e.message }, 500); }
    return true;
  }

  return false;
}

// ── Claude ad-copy generation (v1.7x) ──────────────────────────────────
// claude-opus-4-8 per the project's model default. Raw HTTPS to match the
// marketing module's no-SDK pattern. System prompt is static (cached).
const AD_REWRITE_MODEL = 'claude-opus-4-8';
const AD_REWRITE_SYSTEM = [
  'You are a senior Google Ads copywriter for WhisperRoom, a US manufacturer of modular sound-isolation booths (recording, vocal, podcast, audiology, office, broadcast, drum).',
  'Write responsive-search-ad assets that earn clicks and qualified booth inquiries.',
  'Hard rules:',
  '- Never use the word "soundproof". Say "sound isolation" or "sound-isolating".',
  '- Never use em dashes.',
  '- Headlines are 30 characters or fewer. Descriptions are 90 characters or fewer. Count characters and stay under the limit.',
  '- Lead with the searcher\'s intent and a concrete benefit: made in the USA, modular sizes, pro-grade isolation, fast quote, configurable, built to order.',
  '- Vary the angles across assets (product, use-case, proof, offer, call to action). No clichés, no filler, no fake urgency.',
  '- Output only ad copy in the requested JSON. No commentary outside the rationale field.',
].join('\n');

function _anthropicMessages(key, payloadStr) {
  return new Promise((resolve) => {
    const r = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payloadStr),
      },
      timeout: 30000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let j; try { j = JSON.parse(raw); } catch { j = {}; }
        if (res.statusCode >= 400) {
          const m = (j.error && j.error.message) || raw.slice(0, 200);
          resolve({ ok: false, status: res.statusCode, error: `Claude ${res.statusCode}: ${m}` });
        } else resolve({ ok: true, json: j });
      });
    });
    r.on('error', e => resolve({ ok: false, status: 502, error: 'Claude request failed: ' + e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ ok: false, status: 504, error: 'Claude request timed out.' }); });
    r.write(payloadStr); r.end();
  });
}

module.exports = { handle, MARKETING_ALLOWLIST };
