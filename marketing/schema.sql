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

-- Sync runbook — tracks when each report type was last pulled, how
-- many rows came back, and any error. Powers the "Last synced X
-- minutes ago" UI on the dashboard.
CREATE TABLE IF NOT EXISTS marketing_syncs (
  report_type    TEXT PRIMARY KEY,   -- 'campaigns' | 'keywords' | 'search_terms'
  last_synced_at TIMESTAMPTZ,
  rows_synced    INTEGER,
  date_from      DATE,
  date_to        DATE,
  error          TEXT
);
