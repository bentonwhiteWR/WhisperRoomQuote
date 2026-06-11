-- Marketing analytics tables. All prefixed with `marketing_` to keep
-- them visually separate from the main app schema (orders, quotes,
-- notifications, etc.) while sharing the same Postgres instance so
-- cross-system attribution joins (e.g. cost-per-quote) stay trivial.
--
-- Costs stored as `cost_micros` to match Google Ads API native format:
-- 1 USD = 1,000,000 micros. Convert in queries: cost_micros / 1000000.
--
-- All tables use upsert-friendly composite primary keys so re-running
-- a sync for the same date range overwrites instead of duplicating.

-- Daily campaign-level performance
CREATE TABLE IF NOT EXISTS marketing_campaigns (
  campaign_id      TEXT NOT NULL,
  campaign_name    TEXT,
  status           TEXT,
  date             DATE NOT NULL,
  impressions      BIGINT,
  clicks           BIGINT,
  cost_micros      BIGINT,
  conversions      NUMERIC,
  conversion_value NUMERIC,
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (campaign_id, date)
);
CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_date ON marketing_campaigns(date DESC);
-- Impression Share (v1.7x) — the RIGHT signal for budget vs rank decisions.
-- search_impression_share = % of available impressions you got; budget/rank
-- lost-IS attribute the gap to budget caps vs bid/Quality Score. 0-1 fractions.
ALTER TABLE marketing_campaigns ADD COLUMN IF NOT EXISTS search_impression_share      NUMERIC;
ALTER TABLE marketing_campaigns ADD COLUMN IF NOT EXISTS search_budget_lost_is         NUMERIC;
ALTER TABLE marketing_campaigns ADD COLUMN IF NOT EXISTS search_rank_lost_is           NUMERIC;

-- Daily keyword-level performance (search campaigns only)
CREATE TABLE IF NOT EXISTS marketing_keywords (
  campaign_id  TEXT NOT NULL,
  ad_group_id  TEXT NOT NULL,
  keyword_id   TEXT NOT NULL,
  keyword_text TEXT,
  match_type   TEXT,
  date         DATE NOT NULL,
  impressions  BIGINT,
  clicks       BIGINT,
  cost_micros  BIGINT,
  conversions  NUMERIC,
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (campaign_id, ad_group_id, keyword_id, date)
);
CREATE INDEX IF NOT EXISTS idx_marketing_keywords_date ON marketing_keywords(date DESC);
-- Quality Score (v1.7x) + its 3 components. QS is a CURRENT attribute (Google
-- returns the same value per day), so the engines read the latest date's value.
-- Components are buckets (BELOW_AVERAGE / AVERAGE / ABOVE_AVERAGE) telling you
-- WHICH lever is the constraint: expected CTR → ad copy, ad relevance → keyword
-- ↔ ad match, landing page → the page. Replaces our CTR-vs-conv guess.
ALTER TABLE marketing_keywords ADD COLUMN IF NOT EXISTS quality_score    INTEGER;
ALTER TABLE marketing_keywords ADD COLUMN IF NOT EXISTS qs_expected_ctr  TEXT;
ALTER TABLE marketing_keywords ADD COLUMN IF NOT EXISTS qs_ad_relevance  TEXT;
ALTER TABLE marketing_keywords ADD COLUMN IF NOT EXISTS qs_landing_page  TEXT;

-- What people actually typed (vs. the keywords we bid on)
CREATE TABLE IF NOT EXISTS marketing_search_terms (
  campaign_id TEXT NOT NULL,
  ad_group_id TEXT NOT NULL,
  search_term TEXT NOT NULL,
  date        DATE NOT NULL,
  impressions BIGINT,
  clicks      BIGINT,
  cost_micros BIGINT,
  conversions NUMERIC,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (campaign_id, ad_group_id, search_term, date)
);
CREATE INDEX IF NOT EXISTS idx_marketing_search_terms_date ON marketing_search_terms(date DESC);

-- Google Search Console — daily ORGANIC search performance (v1.65.1).
-- Pulled from the Search Analytics API for the whisperroom.com property.
-- ctr is a 0-1 fraction, position is the average rank that day. Stored daily
-- so the dashboard's ?days=N filter sub-windows it like the Google Ads tables;
-- GET endpoints re-aggregate (clicks/impressions summed; ctr = clicks/impr;
-- position = impression-weighted mean). NOTE: organic query data CANNOT be
-- joined to HubSpot deals at the query level (Google withholds the organic
-- query, "not provided") — the HubSpot tie is channel-level (ORGANIC_SEARCH).
CREATE TABLE IF NOT EXISTS marketing_gsc_queries (
  date        DATE NOT NULL,
  query       TEXT NOT NULL,
  clicks      BIGINT,
  impressions BIGINT,
  ctr         NUMERIC,
  position    NUMERIC,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (date, query)
);
CREATE INDEX IF NOT EXISTS idx_marketing_gsc_queries_date ON marketing_gsc_queries(date DESC);

CREATE TABLE IF NOT EXISTS marketing_gsc_pages (
  date        DATE NOT NULL,
  page        TEXT NOT NULL,
  clicks      BIGINT,
  impressions BIGINT,
  ctr         NUMERIC,
  position    NUMERIC,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (date, page)
);
CREATE INDEX IF NOT EXISTS idx_marketing_gsc_pages_date ON marketing_gsc_pages(date DESC);

-- Date-only organic totals. Pulled with dimension=['date'] (NO query/page
-- breakdown), so Google does NOT anonymize/drop rows — these match the GSC UI
-- "Total clicks / impressions / CTR / position" exactly. The query/page tables
-- above omit anonymized long-tail rows and therefore undercount the true total
-- (often 60-70% short on clicks); the KPI cards + Organic Performance chart read
-- THIS table for accurate headline numbers, and the query/page tables only for
-- per-term/-page breakdowns. One row per day → trivially small.
CREATE TABLE IF NOT EXISTS marketing_gsc_daily (
  date        DATE PRIMARY KEY,
  clicks      BIGINT,
  impressions BIGINT,
  ctr         NUMERIC,
  position    NUMERIC,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Query × page pairs. Pulled with dimensions=['query','page'] (NO date), so
-- this is "which page does Google actually rank for each query," aggregated
-- over the sync window. Replaces keyword-overlap guessing in the Revenue /
-- Action engines with the real ranking page. Not date-segmented (the mapping
-- is slowly-changing), so row count is bounded by distinct pairs — far smaller
-- than the daily tables. Upserted (no date key), so a stale pair can linger if
-- a query's ranking page changes; the engines pick the top page by clicks, so
-- the current winner still surfaces.
CREATE TABLE IF NOT EXISTS marketing_gsc_query_pages (
  query       TEXT NOT NULL,
  page        TEXT NOT NULL,
  clicks      BIGINT,
  impressions BIGINT,
  ctr         NUMERIC,
  position    NUMERIC,
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (query, page)
);
CREATE INDEX IF NOT EXISTS idx_marketing_gsc_qp_query ON marketing_gsc_query_pages(query);

-- Sync runbook — tracks when each report type was last pulled, how
-- many rows came back, and any error. Powers the "Last synced X
-- minutes ago" UI on the dashboard.
CREATE TABLE IF NOT EXISTS marketing_syncs (
  report_type    TEXT PRIMARY KEY,   -- 'campaigns' | 'keywords' | 'search_terms' | 'hubspot_contacts' | 'hubspot_deals'
  last_synced_at TIMESTAMPTZ,
  rows_synced    INTEGER,
  date_from      DATE,
  date_to        DATE,
  error          TEXT
);

-- HubSpot contacts mirror — minimum fields needed for marketing
-- attribution + reporting. Pulled from /crm/v3/objects/contacts/search
-- with `lastmodifieddate >= sinceDate` filter (incremental). gclid lives
-- in the standard `hs_google_click_id` property when HubSpot auto-captures
-- it from a tracked landing page. First-touch / latest-touch source pairs
-- come from `hs_analytics_*` and `hs_latest_source*` — both pulled so the
-- attribution layer can choose its model per query without re-syncing.
CREATE TABLE IF NOT EXISTS marketing_hubspot_contacts (
  contact_id                BIGINT PRIMARY KEY,
  email                     TEXT,
  -- Click IDs (paid attribution)
  gclid                     TEXT,         -- hs_google_click_id
  fbclid                    TEXT,         -- hs_facebook_click_id (future expansion)
  -- First-touch attribution
  first_source              TEXT,         -- hs_analytics_source              (e.g. "PAID_SEARCH")
  first_source_data_1       TEXT,         -- hs_analytics_source_data_1       (e.g. "google")
  first_source_data_2       TEXT,         -- hs_analytics_source_data_2       (often campaign name or gclid)
  first_converting_campaign TEXT,         -- hs_analytics_first_touch_converting_campaign
  first_url                 TEXT,         -- hs_analytics_first_url (entry page — for organic page→revenue join)
  -- Latest-touch attribution
  latest_source             TEXT,         -- hs_latest_source
  latest_source_data_1      TEXT,         -- hs_latest_source_data_1
  latest_source_data_2      TEXT,         -- hs_latest_source_data_2
  latest_source_at          TIMESTAMPTZ,  -- hs_latest_source_timestamp
  -- Lifecycle
  lifecycle_stage           TEXT,         -- lifecyclestage (subscriber/lead/MQL/SQL/opportunity/customer/...)
  lead_status               TEXT,         -- hs_lead_status
  -- Timestamps
  created_at                TIMESTAMPTZ,  -- createdate
  last_modified_at          TIMESTAMPTZ,  -- lastmodifieddate
  synced_at                 TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mkt_hs_contacts_gclid   ON marketing_hubspot_contacts(gclid) WHERE gclid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mkt_hs_contacts_email   ON marketing_hubspot_contacts(email);
CREATE INDEX IF NOT EXISTS idx_mkt_hs_contacts_created ON marketing_hubspot_contacts(created_at);
-- first_url added after initial deploy — CREATE IF NOT EXISTS won't add a column
-- to an already-created table, so ALTER it in idempotently.
ALTER TABLE marketing_hubspot_contacts ADD COLUMN IF NOT EXISTS first_url TEXT;

-- HubSpot deals mirror — Sales Pipeline only (pipeline ID = 'default';
-- Test + Ecommerce pipelines are excluded so marketing reporting stays
-- clean). primary_contact_id is resolved per-deal via the v4 associations
-- API and stored denormalized so attribution joins are a single lookup.
-- Foreign key is DEFERRABLE so contacts/deals sync order doesn't matter
-- (deal can be inserted before its contact lands in the next sync run).
CREATE TABLE IF NOT EXISTS marketing_hubspot_deals (
  deal_id            BIGINT PRIMARY KEY,
  deal_name          TEXT,
  pipeline           TEXT,           -- 'default' = Sales Pipeline
  dealstage          TEXT,
  amount             NUMERIC(12,2),  -- amount_in_home_currency (USD)
  -- Status flags
  is_closed          BOOLEAN,
  is_closed_won      BOOLEAN,
  is_closed_lost     BOOLEAN,
  -- Timestamps
  created_at         TIMESTAMPTZ,    -- createdate
  closed_at          TIMESTAMPTZ,    -- closedate (expected for open, actual for closed)
  days_to_close      INTEGER,
  last_modified_at   TIMESTAMPTZ,
  -- Reasons (where filled)
  closed_won_reason  TEXT,
  closed_lost_reason TEXT,
  -- Attribution join key — resolved via /crm/v4/objects/deal/{id}/associations/contact,
  -- preferring association labels matching /primary/i, falling back to the first
  -- associated contact. NULL for deals with no associated contact.
  primary_contact_id BIGINT,
  synced_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mkt_hs_deals_contact  ON marketing_hubspot_deals(primary_contact_id);
CREATE INDEX IF NOT EXISTS idx_mkt_hs_deals_pipeline ON marketing_hubspot_deals(pipeline);
CREATE INDEX IF NOT EXISTS idx_mkt_hs_deals_created  ON marketing_hubspot_deals(created_at);
CREATE INDEX IF NOT EXISTS idx_mkt_hs_deals_closed   ON marketing_hubspot_deals(closed_at) WHERE closed_at IS NOT NULL;

-- ── DataForSEO SERP snapshots (SEO Intel tab, Phase 1) ──────────────────
-- One row per (keyword, location, day) capturing the LIVE Google results page
-- that GSC can't show: our organic rank + URL, the top-N competitors (JSONB),
-- and AI Overview presence/citation. Populated by serp-etl.js on a weekly
-- "Sync SERP". location_code 2840 = United States. Idempotent upsert on the
-- composite PK so a same-day re-sync overwrites rather than duplicates.
CREATE TABLE IF NOT EXISTS marketing_serp_snapshots (
  keyword            TEXT NOT NULL,
  location_code      INTEGER NOT NULL DEFAULT 2840,
  checked_on         DATE NOT NULL,
  our_rank           NUMERIC,        -- whisperroom.com best ORGANIC position (rank_group; NULL = not found)
  our_rank_abs       NUMERIC,        -- our ABSOLUTE position (rank_absolute — counts ads/AIO/features above)
  our_url            TEXT,
  top_results        JSONB,          -- [{rank, rankAbs, domain, url, title}] top organic results
  paid_results       JSONB,          -- [{domain, url, title, unit}] advertisers (text/shopping ads) on the term
  popular_products   JSONB,          -- {present, ours, items:[{domain, seller, title}]} free shopping grid; null = no grid / pre-column snapshot
  paa_questions      JSONB,          -- ["question", ...] People-Also-Ask questions (content roadmap)
  featured_snippet   JSONB,          -- {domain, url, title} position-zero owner, or null
  search_volume      INTEGER,        -- monthly Google search volume (Keywords Data)
  keyword_difficulty NUMERIC,        -- 0-100 ranking difficulty (DataForSEO Labs)
  cpc                NUMERIC,        -- avg cost-per-click (Keywords Data)
  ai_overview        BOOLEAN DEFAULT FALSE,
  ai_overview_cited  BOOLEAN DEFAULT FALSE,   -- is whisperroom.com a cited source in the AI Overview?
  ai_overview_refs   JSONB,          -- [{domain, url, title}] sources the AI Overview cites
  serp_features      JSONB,          -- {featured_snippet, shopping, people_also_ask, ...} present
  fetched_at         TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (keyword, location_code, checked_on)
);
-- Added after the table first shipped — idempotent so the already-deployed
-- staging table picks up the new columns on next boot.
ALTER TABLE marketing_serp_snapshots ADD COLUMN IF NOT EXISTS our_rank_abs NUMERIC;
ALTER TABLE marketing_serp_snapshots ADD COLUMN IF NOT EXISTS paid_results JSONB;  -- [{domain,url,title,unit}] advertisers on the term
ALTER TABLE marketing_serp_snapshots ADD COLUMN IF NOT EXISTS paa_questions JSONB;
ALTER TABLE marketing_serp_snapshots ADD COLUMN IF NOT EXISTS featured_snippet JSONB;
ALTER TABLE marketing_serp_snapshots ADD COLUMN IF NOT EXISTS search_volume INTEGER;
ALTER TABLE marketing_serp_snapshots ADD COLUMN IF NOT EXISTS keyword_difficulty NUMERIC;
ALTER TABLE marketing_serp_snapshots ADD COLUMN IF NOT EXISTS cpc NUMERIC;
ALTER TABLE marketing_serp_snapshots ADD COLUMN IF NOT EXISTS popular_products JSONB;  -- {present, ours, items} free shopping grid (v1.101.0)
CREATE INDEX IF NOT EXISTS idx_mkt_serp_keyword ON marketing_serp_snapshots(keyword);
CREATE INDEX IF NOT EXISTS idx_mkt_serp_checked ON marketing_serp_snapshots(checked_on);

-- ── Marketing radar alerts (📡 Radar tab, v1.99.0) ──────────────────────
-- Server-detected changes worth acting on (rank drops, brand-term competitor
-- ads, uncited AI Overviews, lost snippets, budget-lost spikes, spend with no
-- conversions, organic decay). Written by alerts.js daily scans; deduped on
-- (type, key) — the key carries a date/week component where periodic re-fire
-- is intended. status: new → seen (ack) → dismissed.
CREATE TABLE IF NOT EXISTS marketing_alerts (
  id         SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  type       TEXT NOT NULL,
  key        TEXT NOT NULL,
  severity   TEXT NOT NULL DEFAULT 'info',   -- high | med | info
  title      TEXT NOT NULL,
  detail     TEXT,
  data       JSONB,
  status     TEXT NOT NULL DEFAULT 'new'     -- new | seen | dismissed
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mkt_alerts_type_key ON marketing_alerts(type, key);
CREATE INDEX IF NOT EXISTS idx_mkt_alerts_status ON marketing_alerts(status, created_at DESC);

-- ── Weekly digest (🗞 This Week panel, v1.102.0) ────────────────────────
-- One row per generated briefing: Claude's "5 things that matter this week"
-- over a data pack assembled from the already-synced tables. `data` keeps the
-- exact pack the model saw (auditability: every number in the briefing should
-- trace back to it).
CREATE TABLE IF NOT EXISTS marketing_digests (
  id           SERIAL PRIMARY KEY,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  period_start DATE,
  period_end   DATE,
  headline     TEXT,
  items        JSONB,   -- [{title, why, action, area, severity}]
  data         JSONB,   -- the data pack fed to the model
  model        TEXT
);
CREATE INDEX IF NOT EXISTS idx_mkt_digests_created ON marketing_digests(created_at DESC);

-- ── AI citability results (SEO Intel section, v1.102.0) ────────────────
-- One row per keyword: the generated fix (answer-first rewrite, FAQ, JSON-LD,
-- heading restructure) for an uncited-AI-Overview term. Regenerate overwrites.
CREATE TABLE IF NOT EXISTS marketing_citability (
  keyword    TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  our_url    TEXT,
  result     JSONB,
  model      TEXT
);

-- ── Competitor content gap (SEO Intel section, v1.102.0) ───────────────
-- Keywords competitors rank top-20 for that WhisperRoom doesn't cover at all,
-- scored by segment-family weight × intent × volume. Full refresh per Sync gap.
CREATE TABLE IF NOT EXISTS marketing_content_gap (
  keyword            TEXT PRIMARY KEY,
  competitors        JSONB,    -- [{domain, rank, url}]
  search_volume      INTEGER,
  cpc                NUMERIC,
  keyword_difficulty NUMERIC,
  family             TEXT,
  intent             TEXT,     -- buy | browse | info
  score              NUMERIC,
  fetched_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mkt_gap_score ON marketing_content_gap(score DESC);

-- ── Action log (📋 Receipts, v1.103.0 — intel-roadmap layer 5) ──────────
-- One row per recommendation Gabe acted on (or skipped). `baseline` is the
-- metric snapshot at action time; the scheduler re-measures into check14 /
-- check28 and writes a plain-English `outcome`. Dedup on (source, source_key)
-- so a double click updates instead of duplicating.
CREATE TABLE IF NOT EXISTS marketing_actions (
  id          SERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  source      TEXT NOT NULL,            -- alert | digest | defense | citability | manual
  source_key  TEXT NOT NULL,            -- alert:<id> / digest:<id>:<i> / defense:<kind>:<kw> / cit:<kw>
  title       TEXT NOT NULL,
  action      TEXT,
  status      TEXT NOT NULL DEFAULT 'done',   -- done | skipped
  metric_kind TEXT,                     -- serp-rank | gsc-clicks | campaign-spend | grid-presence | aio-cited
  metric_key  TEXT,
  baseline    JSONB,
  check14     JSONB,
  check28     JSONB,
  outcome     TEXT,
  notes       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mkt_actions_key ON marketing_actions(source, source_key);
CREATE INDEX IF NOT EXISTS idx_mkt_actions_created ON marketing_actions(created_at DESC);

-- ── Learned non-competitors (v1.103.0) ──────────────────────────────────
-- Domains the brand-threat check should ignore (e.g. bookstores advertising
-- the NOVEL "Whisper Room"). Fed by the alert feed's "✗ not competitors".
CREATE TABLE IF NOT EXISTS marketing_ignored_advertisers (
  domain     TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  note       TEXT
);

-- ── Paid Defense implementation plans (v1.103.1) ────────────────────────
-- One row per (keyword, kind): the Claude-written Google Ads plan for a
-- Defend / Pull-Back call, grounded in this account's real data. Regenerate
-- overwrites.
CREATE TABLE IF NOT EXISTS marketing_defense_fixes (
  keyword    TEXT NOT NULL,
  kind       TEXT NOT NULL,            -- defend | pullback
  created_at TIMESTAMPTZ DEFAULT NOW(),
  result     JSONB,
  model      TEXT,
  PRIMARY KEY (keyword, kind)
);

-- ── Small AI outputs keyed by kind (v1.102.0) ───────────────────────────
-- Latest content plan etc. — one row per kind, regenerate overwrites.
CREATE TABLE IF NOT EXISTS marketing_ai_outputs (
  kind       TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  result     JSONB,
  model      TEXT
);
