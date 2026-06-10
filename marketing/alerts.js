// Marketing radar — server-side alert scans + the daily scheduler (v1.99.0).
// Layer 2 of the marketing-intelligence roadmap: the system PUSHES instead of
// waiting to be read. Every check runs pure SQL against tables the ETLs already
// populate (no new API spend); new alerts land in marketing_alerts (deduped by
// type+key) and fire ONE notification-bell summary per scan to the marketing
// owners. The dashboard's 📡 Radar tab reads GET /api/marketing/alerts.
//
// Checks:
//   serp-rank-drop      — organic rank worsened ≥3 (or fell out of top-10) vs
//                         the previous snapshot, on a tracked keyword
//   serp-brand-comp-ad  — a competitor ad appeared on a BRAND term that wasn't
//                         advertising there in the previous snapshot
//   serp-aio-uncited    — an AI Overview appeared (or our citation was lost) on
//                         a term we rank top-10 for
//   serp-snippet-lost   — a featured snippet we owned is now someone else's
//   ads-budget-lost     — campaign losing ≥20% of impressions to budget (7d,
//                         impression-weighted) after a sub-10% baseline
//   ads-spend-no-conv   — ≥$300 spend in 28d with zero Google conversions
//   gsc-decay           — commercial query clicks down ≥40% (14d vs prior 14d)
//
// Scheduler: ensureScheduler() is armed on the first marketing request (called
// from router.handle — no quote-server.js changes). Every 12h tick it scans if
// the last scan is >20h old, so the cadence is daily regardless of restarts.
// SERP-based checks only see new data when a Sync SERP runs; set
// SERP_AUTO_SYNC_DAYS=7 in Railway to let the scheduler refresh stale keywords
// weekly (cost-metered by the ETL's own 7-day per-keyword cache; unset = off,
// honoring the never-auto-spend default).

const { createNotification } = require('../lib/notify');

// Bell recipients — HubSpot owner ids (Gabe). Comma-separated env override.
const ALERT_OWNERS = (process.env.MARKETING_ALERT_OWNERS || '36320208').split(',').map(s => s.trim()).filter(Boolean);

// Mirrors the dashboard's SERP_NON_COMPETITOR / serpIsCompetitor (marketing-
// dashboard.html) — marketplaces/social/reference aren't booth sellers. Keep
// the two lists in sync when editing.
const NON_COMPETITOR = ['amazon','ebay','walmart','etsy','reddit','youtube','instagram','facebook','pinterest','twitter','x.com','tiktok','wikipedia','quora','medium','linkedin','yelp','google','github','kickstarter','indiegogo','vimeo','soundcloud','spotify','homedepot','lowes','target','aliexpress','alibaba'];
function isCompetitor(dom) {
  const d = (dom || '').toLowerCase();
  if (!d || d.includes('whisperroom')) return false;
  if (/\.(edu|gov)(\/|$)/.test(d) || d.includes('lib.')) return false;
  return !NON_COMPETITOR.some(n => d.includes(n));
}
const isBrandTerm = kw => /whisper\s*-?room/i.test(kw || '');
const INFORMATIONAL_RX = /\b(how to|diy|build|tips|guide|ideas|what is|review)\b/i;

// Editable thresholds (mirror the dashboard's Gabe-editable consts style).
const RANK_DROP_MIN      = 3;     // organic positions lost to alert
const BUDGET_LOST_HI     = 0.20;  // 7d impression-weighted budget-lost IS
const BUDGET_LOST_BASE   = 0.10;  // ...only when the prior-28d baseline was under this
const BUDGET_LOST_MINCOST = 100;  // 7d spend floor for the budget-lost alert
const SPEND_NO_CONV_MIN  = 300;   // 28d spend with zero conversions
const DECAY_DROP_PCT     = 0.40;  // 14d-vs-prior-14d click drop to alert
const DECAY_MIN_CLICKS   = 10;    // prior-period click floor

// ── per-keyword latest + previous SERP snapshot pairs ────────────────────
async function _serpPairs(db) {
  const r = await db.query(`
    WITH ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY keyword, location_code ORDER BY checked_on DESC) AS rn
      FROM marketing_serp_snapshots
    )
    SELECT cur.keyword, cur.checked_on AS cur_on, prev.checked_on AS prev_on,
           cur.our_rank  AS cur_rank,  prev.our_rank  AS prev_rank,
           cur.search_volume, cur.keyword_difficulty,
           cur.paid_results   AS cur_ads,  prev.paid_results   AS prev_ads,
           cur.ai_overview    AS cur_aio,  prev.ai_overview    AS prev_aio,
           cur.ai_overview_cited AS cur_cited, prev.ai_overview_cited AS prev_cited,
           cur.ai_overview_refs  AS cur_refs,
           cur.featured_snippet  AS cur_fs, prev.featured_snippet AS prev_fs
    FROM ranked cur
    JOIN ranked prev ON prev.keyword = cur.keyword AND prev.location_code = cur.location_code AND prev.rn = 2
    WHERE cur.rn = 1 AND cur.checked_on > prev.checked_on
  `);
  return r.rows;
}

// Each check returns [{type, key, severity, title, detail, data}]. Keys carry a
// date-ish component where a re-fire later is wanted; dedup is on (type, key).
function _checkSerp(pairs) {
  const alerts = [];
  for (const p of pairs) {
    const vol = p.search_volume != null ? `${p.search_volume} vol` : null;

    // Rank drop — worsened ≥3, or held top-10 and fell out (incl. → not ranking).
    const had = p.prev_rank != null, has = p.cur_rank != null;
    const fellOut = had && p.prev_rank <= 10 && (!has || p.cur_rank > 10);
    const worsened = had && has && (p.cur_rank - p.prev_rank) >= RANK_DROP_MIN;
    if (fellOut || worsened) {
      alerts.push({
        type: 'serp-rank-drop', key: `rank-drop:${p.keyword}:${p.cur_on}`,
        severity: (p.prev_rank <= 5 || (p.search_volume || 0) >= 100) ? 'high' : 'med',
        title: `Rank drop: “${p.keyword}” #${p.prev_rank} → ${has ? '#' + p.cur_rank : 'not ranking'}`,
        detail: [vol, p.keyword_difficulty != null ? `KD ${Math.round(p.keyword_difficulty)}` : null, `previous snapshot ${p.prev_on}`].filter(Boolean).join(' · '),
        data: { keyword: p.keyword, prev: p.prev_rank, cur: p.cur_rank },
      });
    }

    // New competitor ad on a brand term.
    if (isBrandTerm(p.keyword)) {
      const prevDoms = new Set(((p.prev_ads || [])).map(a => (a.domain || '').toLowerCase()));
      const fresh = (p.cur_ads || []).filter(a => isCompetitor(a.domain) && !prevDoms.has((a.domain || '').toLowerCase()));
      if (fresh.length) {
        alerts.push({
          type: 'serp-brand-comp-ad', key: `brand-ad:${p.keyword}:${fresh.map(a => a.domain).sort().join(',')}`,
          severity: 'high',
          title: `${fresh.map(a => a.domain).join(', ')} now advertising on your brand term “${p.keyword}”`,
          detail: 'A competitor is buying your branded clicks — the textbook defend-with-ads case. Check the Paid Defense panel.',
          data: { keyword: p.keyword, domains: fresh.map(a => a.domain) },
        });
      }
    }

    // AI Overview appeared uncited (or our citation was lost) on a top-10 term.
    const aioNowBad = p.cur_aio && !p.cur_cited && has && p.cur_rank <= 10;
    const aioWasOk  = !p.prev_aio || p.prev_cited;
    if (aioNowBad && aioWasOk) {
      const cites = (p.cur_refs || []).map(x => x.domain).filter(Boolean).slice(0, 3);
      alerts.push({
        type: 'serp-aio-uncited', key: `aio:${p.keyword}:${p.cur_on}`,
        severity: 'high',
        title: `${p.prev_aio ? 'AI Overview citation LOST' : 'New uncited AI Overview'} on “${p.keyword}” (you rank #${p.cur_rank})`,
        detail: cites.length ? `The AI cites ${cites.join(', ')} — not you. Get cited: answer-first restructure + FAQ/Product schema.` : 'You are not a cited source. Get cited: answer-first restructure + FAQ/Product schema.',
        data: { keyword: p.keyword, cites },
      });
    }

    // Featured snippet we owned now belongs to someone else.
    const prevFsOurs = p.prev_fs && ((p.prev_fs.domain || '').includes('whisperroom'));
    const curFsTheirs = p.cur_fs && !((p.cur_fs.domain || '').includes('whisperroom'));
    if (prevFsOurs && curFsTheirs) {
      alerts.push({
        type: 'serp-snippet-lost', key: `snippet:${p.keyword}:${p.cur_on}`,
        severity: 'med',
        title: `Featured snippet lost on “${p.keyword}” to ${p.cur_fs.domain}`,
        detail: 'Position zero changed hands — re-answer the question better than their page does.',
        data: { keyword: p.keyword, to: p.cur_fs.domain },
      });
    }
  }
  return alerts;
}

async function _checkAds(db) {
  const alerts = [];
  // Budget-lost IS spike: 7d impression-weighted ≥20% (with real spend) after a
  // <10% prior-28d baseline — the campaign just became genuinely budget-capped.
  const bl = await db.query(`
    WITH last7 AS (
      SELECT campaign_id, MAX(campaign_name) AS name,
             SUM(cost_micros)::float/1e6 AS cost,
             SUM(search_budget_lost_is * impressions) / NULLIF(SUM(impressions), 0) AS bud_lost
      FROM marketing_campaigns
      WHERE date >= CURRENT_DATE - 7 AND search_budget_lost_is IS NOT NULL
      GROUP BY campaign_id
    ), base AS (
      SELECT campaign_id,
             SUM(search_budget_lost_is * impressions) / NULLIF(SUM(impressions), 0) AS bud_lost
      FROM marketing_campaigns
      WHERE date < CURRENT_DATE - 7 AND date >= CURRENT_DATE - 35 AND search_budget_lost_is IS NOT NULL
      GROUP BY campaign_id
    )
    SELECT l.campaign_id, l.name, l.cost, l.bud_lost, b.bud_lost AS base_lost
    FROM last7 l LEFT JOIN base b USING (campaign_id)
    WHERE l.bud_lost >= $1 AND l.cost >= $2 AND COALESCE(b.bud_lost, 0) < $3
  `, [BUDGET_LOST_HI, BUDGET_LOST_MINCOST, BUDGET_LOST_BASE]);
  for (const r of bl.rows) {
    alerts.push({
      type: 'ads-budget-lost', key: `budlost:${r.campaign_id}:${new Date().toISOString().slice(0, 7)}`,
      severity: 'med',
      title: `“${r.name}” now losing ${(r.bud_lost * 100).toFixed(0)}% of impressions to budget`,
      detail: `$${Math.round(r.cost)} spent last 7d; baseline was ${((r.base_lost || 0) * 100).toFixed(0)}%. If its ROAS holds on the Budget board, this is the raise-budget case.`,
      data: { campaignId: r.campaign_id, budLost: r.bud_lost },
    });
  }
  // Real spend, zero Google conversions, 28d.
  const nc = await db.query(`
    SELECT campaign_id, MAX(campaign_name) AS name,
           SUM(cost_micros)::float/1e6 AS cost, SUM(conversions) AS conv
    FROM marketing_campaigns
    WHERE date >= CURRENT_DATE - 28
    GROUP BY campaign_id
    HAVING SUM(cost_micros)::float/1e6 >= $1 AND COALESCE(SUM(conversions), 0) < 1
  `, [SPEND_NO_CONV_MIN]);
  for (const r of nc.rows) {
    alerts.push({
      type: 'ads-spend-no-conv', key: `noconv:${r.campaign_id}:${new Date().toISOString().slice(0, 7)}`,
      severity: 'med',
      title: `“${r.name}”: $${Math.round(r.cost)} in 28 days, zero conversions`,
      detail: 'No Google conversions at all (CRM attribution aside). Review on the Budget board — pause or restructure candidate.',
      data: { campaignId: r.campaign_id, cost: r.cost },
    });
  }
  return alerts;
}

async function _checkGscDecay(db) {
  const r = await db.query(`
    WITH cur AS (
      SELECT query, SUM(clicks) AS clicks FROM marketing_gsc_queries
      WHERE date >= CURRENT_DATE - 14 GROUP BY query
    ), prev AS (
      SELECT query, SUM(clicks) AS clicks FROM marketing_gsc_queries
      WHERE date < CURRENT_DATE - 14 AND date >= CURRENT_DATE - 28 GROUP BY query
    )
    SELECT p.query, p.clicks AS prev_clicks, COALESCE(c.clicks, 0) AS cur_clicks
    FROM prev p LEFT JOIN cur c USING (query)
    WHERE p.clicks >= $1 AND COALESCE(c.clicks, 0) <= p.clicks * (1 - $2::float)
    ORDER BY p.clicks DESC LIMIT 25
  `, [DECAY_MIN_CLICKS, DECAY_DROP_PCT]);
  return r.rows
    .filter(x => !INFORMATIONAL_RX.test(x.query))
    .map(x => ({
      type: 'gsc-decay', key: `decay:${x.query}:${_isoWeek()}`,
      severity: x.prev_clicks >= 50 ? 'high' : 'med',
      title: `Organic clicks down ${Math.round((1 - x.cur_clicks / x.prev_clicks) * 100)}% on “${x.query}”`,
      detail: `${x.prev_clicks} clicks → ${x.cur_clicks} (14d vs prior 14d). Check the SERP for new ads/AI Overview, then the query's ranking page.`,
      data: { query: x.query, prev: +x.prev_clicks, cur: +x.cur_clicks },
    }));
}

function _isoWeek() {
  const d = new Date(); const onejan = new Date(d.getFullYear(), 0, 1);
  return `${d.getFullYear()}w${Math.ceil((((d - onejan) / 86400000) + onejan.getDay() + 1) / 7)}`;
}

// ── the scan ─────────────────────────────────────────────────────────────
async function runAlertScan({ db }) {
  if (!db) return { error: 'no db' };
  const found = [];
  const errors = [];
  try { found.push(..._checkSerp(await _serpPairs(db))); } catch (e) { errors.push('serp: ' + e.message); }
  try { found.push(...await _checkAds(db)); } catch (e) { errors.push('ads: ' + e.message); }
  try { found.push(...await _checkGscDecay(db)); } catch (e) { errors.push('gsc: ' + e.message); }

  // Dedup on (type, key) and insert only the new ones.
  const fresh = [];
  for (const a of found) {
    const ins = await db.query(
      `INSERT INTO marketing_alerts (type, key, severity, title, detail, data)
       SELECT $1, $2, $3, $4, $5, $6
       WHERE NOT EXISTS (SELECT 1 FROM marketing_alerts WHERE type = $1 AND key = $2)
       RETURNING id`,
      [a.type, a.key, a.severity, a.title, a.detail || null, a.data ? JSON.stringify(a.data) : null]
    );
    if (ins.rows.length) fresh.push(a);
  }

  // One bell summary per scan with new findings (high severity leads).
  if (fresh.length) {
    const order = { high: 0, med: 1, info: 2 };
    const top = fresh.slice().sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9)).slice(0, 5);
    const body = top.map(a => `• ${a.title}`).join('\n') + (fresh.length > 5 ? `\n…and ${fresh.length - 5} more` : '') + '\n\nOpen /marketing → 📡 Radar for the full feed.';
    for (const ownerId of ALERT_OWNERS) {
      await createNotification(ownerId, 'marketing-radar', `📡 Marketing radar: ${fresh.length} new alert${fresh.length > 1 ? 's' : ''}`, body, {});
    }
  }

  const error = errors.length ? errors.join(' | ') : null;
  await db.query(
    `INSERT INTO marketing_syncs (report_type, last_synced_at, rows_synced, error)
     VALUES ('alerts', NOW(), $1, $2)
     ON CONFLICT (report_type) DO UPDATE SET last_synced_at = NOW(), rows_synced = $1, error = $2`,
    [fresh.length, error]
  );
  console.log(`[marketing-alerts] scan: ${found.length} matched, ${fresh.length} new${error ? ' — errors: ' + error : ''}`);
  return { ok: !error, matched: found.length, fresh: fresh.length, error };
}

// ── scheduler — armed by router.handle on the first marketing request ────
// 12h tick, scans when the last scan is >20h old → daily cadence that survives
// restarts without double-firing (dedup makes a double scan harmless anyway).
let _schedulerArmed = false;
function ensureScheduler(getDb, serpEtl) {
  if (_schedulerArmed) return;
  _schedulerArmed = true;
  const tick = async () => {
    const db = getDb(); if (!db) return;
    try {
      // Optional weekly SERP refresh so the SERP checks see fresh data without
      // a manual Sync SERP. OPT-IN by env (never-auto-spend default): set
      // SERP_AUTO_SYNC_DAYS=7. The ETL's own 7-day per-keyword cache meters cost.
      const autoDays = parseInt(process.env.SERP_AUTO_SYNC_DAYS || '0');
      if (autoDays > 0 && serpEtl) {
        const s = await db.query(`SELECT last_synced_at FROM marketing_syncs WHERE report_type = 'serp'`);
        const last = s.rows[0] && s.rows[0].last_synced_at;
        if (!last || (Date.now() - new Date(last).getTime()) > autoDays * 86400000) {
          console.log('[marketing-alerts] auto SERP sync (SERP_AUTO_SYNC_DAYS=' + autoDays + ')');
          await serpEtl.syncSerp({ db, force: false }).catch(e => console.warn('[marketing-alerts] auto serp sync failed:', e.message));
        }
      }
      const a = await db.query(`SELECT last_synced_at FROM marketing_syncs WHERE report_type = 'alerts'`);
      const last = a.rows[0] && a.rows[0].last_synced_at;
      if (!last || (Date.now() - new Date(last).getTime()) > 20 * 3600000) await runAlertScan({ db });
    } catch (e) { console.warn('[marketing-alerts] tick failed:', e.message); }
  };
  setTimeout(tick, 90 * 1000);              // first pass shortly after boot
  setInterval(tick, 12 * 3600000);          // then every 12h
  console.log('[marketing-alerts] scheduler armed (daily scan; SERP auto-sync ' + (parseInt(process.env.SERP_AUTO_SYNC_DAYS || '0') > 0 ? 'ON, ' + process.env.SERP_AUTO_SYNC_DAYS + 'd' : 'off') + ')');
}

module.exports = { runAlertScan, ensureScheduler, ALERT_OWNERS };
