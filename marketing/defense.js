// Paid Defense "see fix" (v1.103.1) — turns a Defend / Pull-Back call into a
// truthful, step-by-step Google Ads implementation plan grounded in THIS
// account's real data. The server pulls everything we actually know about the
// term — live SERP state, 90d search-term spend per campaign, the bid keywords
// that match (with match type + Quality Score components), the owning
// campaigns' totals (spend, conversions, budget-lost IS) — and Claude writes
// the plan with hard honesty rules: cite only campaigns/keywords that exist in
// the data, quote their real numbers, and say plainly what the data does NOT
// show. Cached per (keyword, kind); regenerate overwrites.

const { jsonCall } = require('./claude');

const _kwKey = s => String(s || '').toLowerCase().replace(/['"\[\]+]/g, '').replace(/\s+/g, ' ').trim();

async function _gather(db, keyword) {
  const out = {};
  const kw = _kwKey(keyword);

  // Live SERP state — what the buyer actually sees on this term.
  try {
    const s = (await db.query(`
      SELECT our_rank, our_rank_abs, our_url, paid_results, popular_products,
             ai_overview, ai_overview_cited, featured_snippet, search_volume, keyword_difficulty, checked_on
      FROM marketing_serp_snapshots WHERE keyword = $1 ORDER BY checked_on DESC LIMIT 1`, [keyword])).rows[0];
    if (s) out.serp = {
      as_of: s.checked_on, organic_rank: s.our_rank, absolute_rank: s.our_rank_abs,
      monthly_volume: s.search_volume, keyword_difficulty: s.keyword_difficulty,
      advertisers_on_serp: (s.paid_results || []).map(a => ({ domain: a.domain, unit: a.unit })),
      free_shopping_grid: s.popular_products ? { present: !!s.popular_products.present, whisperroom_in_it: !!s.popular_products.ours } : null,
      ai_overview: s.ai_overview ? { present: true, cites_whisperroom: !!s.ai_overview_cited } : { present: false },
    };
  } catch (e) { out.serp = { unavailable: e.message.slice(0, 100) }; }

  // 90d search-term spend: every campaign this exact term triggered in.
  try {
    out.search_term_spend_90d = (await db.query(`
      SELECT st.campaign_id, MAX(c.campaign_name) AS campaign_name,
             ROUND(SUM(st.cost_micros)::numeric / 1e6) AS cost,
             SUM(st.clicks)::int AS clicks, ROUND(SUM(st.conversions)::numeric, 1) AS conversions
      FROM marketing_search_terms st
      LEFT JOIN marketing_campaigns c ON c.campaign_id = st.campaign_id
      WHERE LOWER(TRIM(st.search_term)) = $1 AND st.date >= CURRENT_DATE - 90
      GROUP BY st.campaign_id ORDER BY SUM(st.cost_micros) DESC LIMIT 6`, [kw])).rows;
  } catch (e) { out.search_term_spend_90d = { unavailable: e.message.slice(0, 100) }; }

  // Bid keywords whose normalized text matches the term (latest QS attached).
  try {
    out.matching_bid_keywords = (await db.query(`
      WITH agg AS (
        SELECT campaign_id, ad_group_id, keyword_id, MAX(keyword_text) AS keyword_text, MAX(match_type) AS match_type,
               ROUND(SUM(cost_micros)::numeric / 1e6) AS cost_90d, ROUND(SUM(conversions)::numeric, 1) AS conversions_90d
        FROM marketing_keywords
        WHERE date >= CURRENT_DATE - 90
          AND LOWER(REGEXP_REPLACE(REGEXP_REPLACE(keyword_text, '[''"\\[\\]+]', '', 'g'), '\\s+', ' ', 'g')) = $1
        GROUP BY campaign_id, ad_group_id, keyword_id
      ), qs AS (
        SELECT DISTINCT ON (campaign_id, ad_group_id, keyword_id)
               campaign_id, ad_group_id, keyword_id, quality_score, qs_expected_ctr, qs_ad_relevance, qs_landing_page
        FROM marketing_keywords WHERE quality_score IS NOT NULL
        ORDER BY campaign_id, ad_group_id, keyword_id, date DESC
      )
      SELECT a.keyword_text, a.match_type, a.cost_90d, a.conversions_90d,
             MAX(c.campaign_name) AS campaign_name,
             q.quality_score, q.qs_expected_ctr, q.qs_ad_relevance, q.qs_landing_page
      FROM agg a
      LEFT JOIN qs q USING (campaign_id, ad_group_id, keyword_id)
      LEFT JOIN marketing_campaigns c ON c.campaign_id = a.campaign_id
      GROUP BY a.keyword_text, a.match_type, a.cost_90d, a.conversions_90d,
               q.quality_score, q.qs_expected_ctr, q.qs_ad_relevance, q.qs_landing_page
      LIMIT 8`, [kw])).rows;
  } catch (e) { out.matching_bid_keywords = { unavailable: e.message.slice(0, 100) }; }

  // Owning campaigns' 90d totals — the budget/IS context for any bid move.
  try {
    const ids = Array.isArray(out.search_term_spend_90d) ? out.search_term_spend_90d.map(r => r.campaign_id) : [];
    out.campaign_totals_90d = ids.length ? (await db.query(`
      SELECT campaign_id, MAX(campaign_name) AS campaign_name,
             ROUND(SUM(cost_micros)::numeric / 1e6) AS spend,
             ROUND(SUM(conversions)::numeric, 1) AS conversions,
             ROUND((SUM(search_budget_lost_is * impressions) / NULLIF(SUM(impressions), 0))::numeric, 3) AS budget_lost_is,
             ROUND((SUM(search_impression_share * impressions) / NULLIF(SUM(impressions), 0))::numeric, 3) AS impression_share
      FROM marketing_campaigns
      WHERE campaign_id = ANY($1) AND date >= CURRENT_DATE - 90
      GROUP BY campaign_id`, [ids])).rows : [];
  } catch (e) { out.campaign_totals_90d = { unavailable: e.message.slice(0, 100) }; }

  // Organic clicks on the same query (GSC) — what a pull-back is betting on.
  try {
    const g = (await db.query(`
      SELECT COALESCE(SUM(clicks), 0)::int AS clicks, COALESCE(SUM(impressions), 0)::int AS impressions
      FROM marketing_gsc_queries WHERE query = $1 AND date >= CURRENT_DATE - 90`, [kw])).rows[0];
    out.organic_90d = { clicks: g.clicks, impressions: g.impressions };
  } catch (e) { out.organic_90d = { unavailable: e.message.slice(0, 100) }; }

  return out;
}

const DEF_SYSTEM = [
  'You are a senior Google Ads operator working inside WhisperRoom\'s real account (US manufacturer of modular sound-isolation booths). You receive the account data we actually have for one search term plus a Defend-or-Pull-Back call, and you write the implementation plan.',
  'HARD HONESTY RULES:',
  '- Only reference campaigns, keywords, and match types that appear in the provided data, by their exact names. Never invent entities, settings, or numbers.',
  '- Quote the real numbers (spend, conversions, QS, budget-lost IS, organic rank/clicks) in the step that relies on them.',
  '- If the data shows NO spend on the term, say so and plan accordingly (a pull-back is moot; the question becomes whether to add coverage).',
  '- The caveats field must name what this data does NOT show (e.g. search-term rows only capture what actually triggered; HubSpot revenue is first-touch; organic query data can\'t be joined to deals; QS may be missing on low-volume keywords).',
  'PLAYBOOK CONTEXT (apply judgment, not dogma):',
  '- DEFEND = our organic result is suppressed (competitor ads above, buried under SERP features, uncited AI Overview) on a commercial term: typically add/keep exact-match coverage in the most relevant existing campaign, with a bid sized to sit above the suppressors; fix the weakest QS component if one is flagged.',
  '- PULL BACK = we rank top-3 with a clean SERP and are paying for clicks organic would catch: typically add the exact term as a negative (exact match) in the campaign(s) actually spending on it, or lower the bid — never pause a whole campaign for one term.',
  '- Every plan ends with a measurable guardrail: what to watch (organic clicks for that query in GSC, the radar\'s rank-drop check, weekly spend), the revert condition, and the timeline. Recommend they log it with the dashboard\'s "✓ did it" so the 14/28-day measurement runs.',
  'steps[].where must be a concrete navigation path in Google Ads (e.g. "Google Ads → Campaigns → [campaign name] → Keywords → Negative search keywords"). steps[].what is the exact change. steps[].why ties it to the quoted data. 2-5 steps.',
].join('\n');

const DEF_SCHEMA = {
  type: 'object',
  properties: {
    verdict:         { type: 'string', description: 'One or two sentences: is the call right given this data, and the core move.' },
    steps:           { type: 'array', items: { type: 'object', properties: { where: { type: 'string' }, what: { type: 'string' }, why: { type: 'string' } }, required: ['where', 'what', 'why'], additionalProperties: false } },
    guardrails:      { type: 'array', items: { type: 'string' }, description: 'What to watch, the revert condition, the timeline. 2-3 entries.' },
    expected_impact: { type: 'string' },
    caveats:         { type: 'string', description: 'What this data does not show. Plain and honest.' },
  },
  required: ['verdict', 'steps', 'guardrails', 'expected_impact', 'caveats'],
  additionalProperties: false,
};

async function runDefenseFix({ db, keyword, kind, context = {}, force = false }) {
  if (!db) return { ok: false, error: 'no db' };
  keyword = String(keyword || '').trim().toLowerCase();
  kind = kind === 'pullback' ? 'pullback' : 'defend';
  if (!keyword) return { ok: false, status: 400, error: 'keyword required' };

  if (!force) {
    const c = await db.query(`SELECT * FROM marketing_defense_fixes WHERE keyword = $1 AND kind = $2`, [keyword, kind]);
    if (c.rows[0]) return { ok: true, cached: true, keyword, kind, result: c.rows[0].result, created_at: c.rows[0].created_at };
  }

  const data = await _gather(db, keyword);
  const user = [
    `Term: "${keyword}" — the dashboard's call is ${kind === 'defend' ? 'DEFEND' : 'PULL BACK'}.`,
    context.why ? `Dashboard's reasoning: ${String(context.why).slice(0, 400)}` : '',
    context.roas != null ? `Owning campaign True ROAS (HubSpot closed-won ÷ spend, dashboard-computed): ${context.roas}×.` : '',
    '',
    'Account + SERP data (JSON, all real):',
    JSON.stringify(data),
    '',
    'Write the implementation plan.',
  ].filter(Boolean).join('\n');

  const res = await jsonCall({ system: DEF_SYSTEM, user, schema: DEF_SCHEMA, maxTokens: 2500 });
  if (!res.ok) return res;

  const result = Object.assign({}, res.data, { kind, data_as_of: new Date().toISOString() });
  await db.query(`
    INSERT INTO marketing_defense_fixes (keyword, kind, result, model)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (keyword, kind) DO UPDATE SET result = $3, model = $4, created_at = NOW()`,
    [keyword, kind, JSON.stringify(result), res.model]);
  return { ok: true, cached: false, keyword, kind, result };
}

module.exports = { runDefenseFix };
