// Weekly marketing digest — "the 5 things that matter this week" (layer 2's
// push-narrative half). Gathers a compact, numbers-first data pack from the
// tables the ETLs already populate (zero external API spend besides one Claude
// call), has Claude write a decision-ready briefing, stores it in
// marketing_digests, and fires one bell summary to the marketing owners.
//
// Cadence: the radar scheduler (alerts.js ensureScheduler tick) calls
// maybeRunDigest() — runs when the last digest is >6.5 days old. Auto mode is
// ON by default (one small Claude call/week on our own key); disable with
// MARKETING_DIGEST_AUTO=off. "Generate now" on the dashboard runs it via the
// existing /sync plumbing (report: 'digest').

const { jsonCall } = require('./claude');
const { createNotification } = require('../lib/notify');

const DIGEST_OWNERS = (process.env.MARKETING_ALERT_OWNERS || '36320208').split(',').map(s => s.trim()).filter(Boolean);

// Every source individually guarded — a missing table never kills the digest,
// it just leaves that section out of the pack (and the model is told so).
async function _buildPack(db) {
  const pack = { generated: null, window: 'last 7 days vs the prior period' };
  const q = async (label, sql, params) => {
    try { pack[label] = (await db.query(sql, params || [])).rows; }
    catch (e) { pack[label] = { unavailable: e.message.slice(0, 120) }; }
  };

  // Radar: what fired this week, by type/severity + the high-sev headlines.
  await q('alertCounts', `
    SELECT type, severity, COUNT(*)::int AS n FROM marketing_alerts
    WHERE created_at >= NOW() - INTERVAL '7 days'
    GROUP BY type, severity ORDER BY n DESC`);
  await q('alertHighlights', `
    SELECT type, title FROM marketing_alerts
    WHERE created_at >= NOW() - INTERVAL '7 days' AND severity = 'high'
    ORDER BY created_at DESC LIMIT 12`);

  // SERP state of the world (latest snapshot per keyword).
  await q('serpState', `
    WITH latest AS (
      SELECT DISTINCT ON (keyword) keyword, our_rank, our_rank_abs, ai_overview,
             ai_overview_cited, popular_products, search_volume
      FROM marketing_serp_snapshots ORDER BY keyword, checked_on DESC
    )
    SELECT COUNT(*)::int AS tracked,
           COUNT(*) FILTER (WHERE our_rank <= 3)::int  AS top3,
           COUNT(*) FILTER (WHERE our_rank <= 10)::int AS top10,
           COUNT(*) FILTER (WHERE our_rank IS NULL)::int AS not_ranking,
           COUNT(*) FILTER (WHERE our_rank <= 5 AND our_rank_abs - our_rank >= 3)::int AS buried,
           COUNT(*) FILTER (WHERE ai_overview)::int AS aio,
           COUNT(*) FILTER (WHERE ai_overview AND ai_overview_cited)::int AS aio_cited,
           COUNT(*) FILTER (WHERE (popular_products->>'present')::boolean)::int AS shopping_grid,
           COUNT(*) FILTER (WHERE (popular_products->>'present')::boolean
                              AND NOT (popular_products->>'ours')::boolean
                              AND our_rank <= 10)::int AS grid_absent_top10
    FROM latest`);

  // Rank movement vs the previous snapshot (biggest moves both directions).
  await q('rankMoves', `
    WITH ranked AS (
      SELECT keyword, our_rank, search_volume,
             ROW_NUMBER() OVER (PARTITION BY keyword ORDER BY checked_on DESC) AS rn
      FROM marketing_serp_snapshots
    ),
    pairs AS (
      SELECT c.keyword, c.search_volume, p.our_rank AS prev, c.our_rank AS cur
      FROM ranked c JOIN ranked p ON p.keyword = c.keyword AND p.rn = 2
      WHERE c.rn = 1 AND c.our_rank IS DISTINCT FROM p.our_rank
    )
    SELECT keyword, prev, cur, search_volume,
           COALESCE(prev, 30) - COALESCE(cur, 30) AS delta
    FROM pairs
    WHERE prev IS NOT NULL OR cur IS NOT NULL
    ORDER BY ABS(COALESCE(prev, 30) - COALESCE(cur, 30)) DESC
    LIMIT 12`);

  // Ads: spend + conversions, 7d vs prior 7d, plus the biggest spend movers.
  await q('adsTotals', `
    SELECT CASE WHEN date >= CURRENT_DATE - 7 THEN 'last7' ELSE 'prior7' END AS period,
           ROUND(SUM(cost_micros)::numeric / 1e6) AS spend,
           ROUND(SUM(conversions)::numeric, 1) AS conversions,
           SUM(clicks)::int AS clicks
    FROM marketing_campaigns
    WHERE date >= CURRENT_DATE - 14
    GROUP BY 1`);
  await q('adsMovers', `
    WITH per AS (
      SELECT campaign_id, MAX(campaign_name) AS name,
             SUM(CASE WHEN date >= CURRENT_DATE - 7 THEN cost_micros ELSE 0 END)::float/1e6 AS cost7,
             SUM(CASE WHEN date <  CURRENT_DATE - 7 THEN cost_micros ELSE 0 END)::float/1e6 AS prior7,
             SUM(CASE WHEN date >= CURRENT_DATE - 7 THEN conversions ELSE 0 END) AS conv7
      FROM marketing_campaigns WHERE date >= CURRENT_DATE - 14 GROUP BY campaign_id
    )
    SELECT name, ROUND(cost7::numeric) AS spend_7d, ROUND(prior7::numeric) AS spend_prior7d, ROUND(conv7::numeric, 1) AS conversions_7d
    FROM per WHERE cost7 + prior7 > 50
    ORDER BY ABS(cost7 - prior7) DESC LIMIT 8`);

  // GSC organic: commercial-query clicks 14d vs prior 14d + the biggest movers.
  await q('gscTotals', `
    SELECT CASE WHEN date >= CURRENT_DATE - 14 THEN 'last14' ELSE 'prior14' END AS period,
           SUM(clicks)::int AS clicks, SUM(impressions)::int AS impressions
    FROM marketing_gsc_queries WHERE date >= CURRENT_DATE - 28 GROUP BY 1`);
  await q('gscMovers', `
    WITH per AS (
      SELECT query,
             SUM(CASE WHEN date >= CURRENT_DATE - 14 THEN clicks ELSE 0 END) AS cur,
             SUM(CASE WHEN date <  CURRENT_DATE - 14 THEN clicks ELSE 0 END) AS prev
      FROM marketing_gsc_queries WHERE date >= CURRENT_DATE - 28 GROUP BY query
    )
    SELECT query, prev::int AS clicks_prior14, cur::int AS clicks_last14
    FROM per WHERE GREATEST(cur, prev) >= 8 AND cur <> prev
    ORDER BY ABS(cur - prev) DESC LIMIT 10`);

  // Revenue pulse: closed-won deals, 7d vs prior 7d (all pipelines — context,
  // not attribution; the dashboard's funnel handles attribution properly).
  await q('dealsPulse', `
    SELECT CASE WHEN closed_at >= NOW() - INTERVAL '7 days' THEN 'last7' ELSE 'prior7' END AS period,
           COUNT(*)::int AS won, ROUND(SUM(amount)::numeric) AS revenue
    FROM marketing_hubspot_deals
    WHERE is_closed_won AND closed_at >= NOW() - INTERVAL '14 days'
    GROUP BY 1`);

  return pack;
}

const DIGEST_SYSTEM = [
  'You are the marketing analyst for WhisperRoom, a US manufacturer of modular sound-isolation booths (recording, vocal, podcast, audiology, telehealth, office, broadcast, drum).',
  'You write a weekly briefing for the owner of marketing: the 5 things that matter most this week, from the data pack provided. Always produce 5 items (4 only if the data is genuinely thin).',
  'Rules:',
  '- Every item must be grounded in specific numbers from the data pack. Quote them.',
  '- Prioritize by money and momentum: revenue risk, wasted spend, organic threats with one shared root cause, then opportunities.',
  '- When many findings share ONE root cause (e.g. dozens of shopping-grid absences = one Merchant Center feed problem), report them as ONE item with the count, not many.',
  '- "action" must be a single concrete next step someone can do this week, imperative voice.',
  '- Be direct and plain. No filler, no hedging, no marketing jargon.',
  '- If a data section is marked unavailable, work with what exists; never invent numbers.',
].join('\n');

const DIGEST_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'One sentence: the single most important thing this week.' },
    items: {
      // Claude's structured-output validator rejects array length constraints
      // (minItems>1 AND maxItems) — the "exactly 5" expectation lives in the
      // system prompt instead.
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title:    { type: 'string' },
          why:      { type: 'string', description: '2-3 sentences with the numbers behind it.' },
          action:   { type: 'string', description: 'One concrete step, imperative.' },
          area:     { type: 'string', enum: ['ads', 'seo', 'ai-visibility', 'shopping', 'content', 'revenue', 'site'] },
          severity: { type: 'string', enum: ['high', 'med', 'info'] },
        },
        required: ['title', 'why', 'action', 'area', 'severity'],
        additionalProperties: false,
      },
    },
  },
  required: ['headline', 'items'],
  additionalProperties: false,
};

async function runDigest({ db }) {
  if (!db) return { ok: false, error: 'no db' };
  const pack = await _buildPack(db);
  const res = await jsonCall({
    system: DIGEST_SYSTEM,
    user: 'Data pack for this week (JSON):\n' + JSON.stringify(pack) + '\n\nWrite the weekly briefing.',
    schema: DIGEST_SCHEMA,
    maxTokens: 2500,
  });

  // Record the attempt either way so the scheduler doesn't hot-loop a failure.
  const error = res.ok ? null : res.error;
  await db.query(
    `INSERT INTO marketing_syncs (report_type, last_synced_at, rows_synced, error)
     VALUES ('digest', NOW(), $1, $2)
     ON CONFLICT (report_type) DO UPDATE SET last_synced_at = NOW(), rows_synced = $1, error = $2`,
    [res.ok ? (res.data.items || []).length : 0, error]
  );
  if (!res.ok) {
    console.warn('[marketing-digest] failed:', res.error);
    return { ok: false, error: res.error };
  }

  const d = res.data;
  const ins = await db.query(
    `INSERT INTO marketing_digests (period_start, period_end, headline, items, data, model)
     VALUES (CURRENT_DATE - 7, CURRENT_DATE, $1, $2, $3, $4) RETURNING id, created_at`,
    [d.headline || '', JSON.stringify(d.items || []), JSON.stringify(pack), res.model]
  );

  const body = (d.items || []).map((it, i) => `${i + 1}. ${it.title}`).join('\n')
    + '\n\nOpen /marketing → 📡 Radar for the full briefing.';
  for (const ownerId of DIGEST_OWNERS) {
    try { await createNotification(ownerId, 'marketing-digest', `🗞 Weekly marketing digest: ${d.headline || 'this week'}`, body, {}); }
    catch (e) { console.warn('[marketing-digest] notify failed:', e.message); }
  }
  console.log(`[marketing-digest] generated #${ins.rows[0].id} — ${(d.items || []).length} items`);
  return { ok: true, id: ins.rows[0].id, headline: d.headline, items: (d.items || []).length };
}

// Called by the radar scheduler tick. Weekly cadence that survives restarts;
// 6.5-day threshold so a 12h tick can't drift the digest later every week.
async function maybeRunDigest(db) {
  if ((process.env.MARKETING_DIGEST_AUTO || 'on') === 'off') return;
  if (!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY)) return;
  const r = await db.query(`SELECT last_synced_at FROM marketing_syncs WHERE report_type = 'digest'`);
  const last = r.rows[0] && r.rows[0].last_synced_at;
  if (!last || (Date.now() - new Date(last).getTime()) > 6.5 * 86400000) {
    console.log('[marketing-digest] weekly auto-run');
    await runDigest({ db });
  }
}

module.exports = { runDigest, maybeRunDigest };
