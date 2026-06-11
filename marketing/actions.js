// Action log (intel-roadmap layer 5) — closes the recommendation loop. Every
// recommendation surface (radar alerts, digest items, Paid Defense calls,
// citability fixes) gets a "done" button; marking done snapshots the relevant
// metric AT THAT MOMENT (rank / clicks / spend / grid presence / AI citation),
// then the scheduler re-measures at 14 and 28 days and writes a plain-English
// outcome. The Receipts panel on the Radar tab shows what your actions earned.
//
// Pure SQL over already-synced tables — measuring costs nothing. Outcomes are
// computed in code (no model call): the numbers speak for themselves.

// ── metric snapshots ─────────────────────────────────────────────────────
// Each kind returns a small JSONB-able object or null when no data exists.
const SNAPSHOTS = {
  // Organic position on a tracked keyword (latest snapshot).
  'serp-rank': async (db, key) => {
    const r = await db.query(`
      SELECT our_rank, our_rank_abs, checked_on FROM marketing_serp_snapshots
      WHERE keyword = $1 ORDER BY checked_on DESC LIMIT 1`, [key]);
    const s = r.rows[0]; if (!s) return null;
    return { rank: s.our_rank != null ? +s.our_rank : null, rank_abs: s.our_rank_abs != null ? +s.our_rank_abs : null, as_of: s.checked_on };
  },
  // Organic clicks on a GSC query, trailing 14 days.
  'gsc-clicks': async (db, key) => {
    const r = await db.query(`
      SELECT COALESCE(SUM(clicks), 0)::int AS clicks FROM marketing_gsc_queries
      WHERE query = $1 AND date >= CURRENT_DATE - 14`, [key]);
    return { clicks_14d: r.rows[0].clicks };
  },
  // Weekly spend + conversions for a campaign (by campaign_id).
  'campaign-spend': async (db, key) => {
    const r = await db.query(`
      SELECT ROUND(SUM(cost_micros)::numeric / 1e6) AS spend, ROUND(SUM(conversions)::numeric, 1) AS conv
      FROM marketing_campaigns WHERE campaign_id = $1 AND date >= CURRENT_DATE - 7`, [key]);
    const s = r.rows[0]; if (!s || s.spend == null) return null;
    return { spend_7d: +s.spend, conversions_7d: +s.conv };
  },
  // Are we in the free Popular-products grid on this keyword?
  'grid-presence': async (db, key) => {
    const r = await db.query(`
      SELECT popular_products, our_rank, checked_on FROM marketing_serp_snapshots
      WHERE keyword = $1 ORDER BY checked_on DESC LIMIT 1`, [key]);
    const s = r.rows[0]; if (!s) return null;
    const pp = s.popular_products || {};
    return { grid_present: !!pp.present, in_grid: !!pp.ours, rank: s.our_rank != null ? +s.our_rank : null, as_of: s.checked_on };
  },
  // Does the AI Overview cite us on this keyword?
  'aio-cited': async (db, key) => {
    const r = await db.query(`
      SELECT ai_overview, ai_overview_cited, our_rank, checked_on FROM marketing_serp_snapshots
      WHERE keyword = $1 ORDER BY checked_on DESC LIMIT 1`, [key]);
    const s = r.rows[0]; if (!s) return null;
    return { aio: !!s.ai_overview, cited: !!s.ai_overview_cited, rank: s.our_rank != null ? +s.our_rank : null, as_of: s.checked_on };
  },
};

async function _snapshot(db, kind, key) {
  if (!kind || !key || !SNAPSHOTS[kind]) return null;
  try {
    const v = await SNAPSHOTS[kind](db, key);
    return v ? Object.assign({ captured_at: new Date().toISOString() }, v) : null;
  } catch (e) { return null; }
}

// Plain-English verdict from baseline → latest. Honest, not salesy.
function _outcome(kind, base, cur) {
  if (!base || !cur) return null;
  try {
    if (kind === 'serp-rank') {
      if (base.rank == null && cur.rank == null) return 'Still not ranking.';
      if (base.rank == null) return `Now ranking #${cur.rank} (was unranked).`;
      if (cur.rank == null) return `Fell out of the rankings (was #${base.rank}).`;
      const d = base.rank - cur.rank;
      return d > 0 ? `Rank improved #${base.rank} → #${cur.rank}.` : d < 0 ? `Rank slipped #${base.rank} → #${cur.rank}.` : `Rank held at #${cur.rank}.`;
    }
    if (kind === 'gsc-clicks') {
      const b = base.clicks_14d, c = cur.clicks_14d;
      if (!b && !c) return 'No organic clicks before or after.';
      const pct = b ? Math.round(((c - b) / b) * 100) : null;
      return pct == null ? `Clicks now ${c}/14d (was 0).` : pct >= 0 ? `Organic clicks up ${pct}% (${b} → ${c}/14d).` : `Organic clicks down ${-pct}% (${b} → ${c}/14d).`;
    }
    if (kind === 'campaign-spend') {
      const ds = cur.spend_7d - base.spend_7d;
      const conv = `conversions ${base.conversions_7d} → ${cur.conversions_7d}/wk`;
      return ds < 0 ? `Spend down $${-ds}/wk (${base.spend_7d} → ${cur.spend_7d}); ${conv}.` : ds > 0 ? `Spend up $${ds}/wk; ${conv}.` : `Spend unchanged at $${cur.spend_7d}/wk; ${conv}.`;
    }
    if (kind === 'grid-presence') {
      if (!base.in_grid && cur.in_grid) return 'Now IN the free shopping grid. 🎉';
      if (base.in_grid && !cur.in_grid) return 'Dropped back out of the shopping grid.';
      return cur.grid_present ? (cur.in_grid ? 'Still in the grid.' : 'Still absent from the grid.') : 'Grid no longer shows on this SERP.';
    }
    if (kind === 'aio-cited') {
      if (!base.cited && cur.cited) return 'AI Overview now cites WhisperRoom. 🎉';
      if (base.cited && !cur.cited) return 'Citation lost again.';
      return cur.aio ? (cur.cited ? 'Still cited.' : 'Still not cited.') : 'AI Overview no longer shows on this SERP.';
    }
  } catch (e) { /* fall through */ }
  return null;
}

// What a radar alert's "done" should measure, derived from type + data.
const ALERT_METRICS = {
  'serp-rank-drop':       d => ({ kind: 'serp-rank',      key: d.keyword }),
  'serp-aio-uncited':     d => ({ kind: 'aio-cited',      key: d.keyword }),
  'serp-snippet-lost':    d => ({ kind: 'serp-rank',      key: d.keyword }),
  'serp-shopping-absent': d => ({ kind: 'grid-presence',  key: d.keyword }),
  'gsc-decay':            d => ({ kind: 'gsc-clicks',     key: d.query }),
  'ads-budget-lost':      d => ({ kind: 'campaign-spend', key: d.campaignId != null ? String(d.campaignId) : null }),
  'ads-spend-no-conv':    d => ({ kind: 'campaign-spend', key: d.campaignId != null ? String(d.campaignId) : null }),
  // brand-comp-ad has no single metric — logged untracked.
};

// ── log an action ────────────────────────────────────────────────────────
async function logAction({ db, source, sourceKey, title, action, status = 'done', metricKind, metricKey }) {
  if (!db) return { ok: false, error: 'no db' };
  if (!source || !sourceKey || !title) return { ok: false, status: 400, error: 'source, sourceKey, title required' };
  const baseline = status === 'done' ? await _snapshot(db, metricKind, metricKey) : null;
  const r = await db.query(`
    INSERT INTO marketing_actions (source, source_key, title, action, status, metric_kind, metric_key, baseline)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (source, source_key) DO UPDATE SET status = $5, title = $3, action = $4
    RETURNING id, baseline`, [
    source, String(sourceKey).slice(0, 200), String(title).slice(0, 300), action ? String(action).slice(0, 500) : null,
    status, metricKind || null, metricKey || null, baseline ? JSON.stringify(baseline) : null,
  ]);
  return { ok: true, id: r.rows[0].id, tracked: !!baseline };
}

// Done-button path for a radar alert: derive the metric, log, dismiss.
async function logAlertAction({ db, alertId }) {
  const a = (await db.query(`SELECT * FROM marketing_alerts WHERE id = $1`, [alertId])).rows[0];
  if (!a) return { ok: false, status: 404, error: 'alert not found' };
  const data = a.data || {};
  const m = ALERT_METRICS[a.type] ? ALERT_METRICS[a.type](data) : null;
  const out = await logAction({
    db, source: 'alert', sourceKey: `alert:${a.id}`, title: a.title, action: a.detail,
    metricKind: m && m.key ? m.kind : null, metricKey: m ? m.key : null,
  });
  if (out.ok) await db.query(`UPDATE marketing_alerts SET status = 'dismissed' WHERE id = $1`, [alertId]);
  return out;
}

// ── re-measure due actions (scheduler tick + manual) ─────────────────────
async function measureActions(db) {
  if (!db) return { ok: false };
  let measured = 0;
  const due = (await db.query(`
    SELECT id, metric_kind, metric_key, baseline, check14, check28, created_at FROM marketing_actions
    WHERE status = 'done' AND metric_kind IS NOT NULL AND baseline IS NOT NULL AND (
      (check14 IS NULL AND created_at <= NOW() - INTERVAL '14 days') OR
      (check28 IS NULL AND created_at <= NOW() - INTERVAL '28 days'))
    LIMIT 100`)).rows;
  for (const a of due) {
    const snap = await _snapshot(db, a.metric_kind, a.metric_key);
    if (!snap) continue;
    const col = (!a.check28 && new Date(a.created_at) <= new Date(Date.now() - 28 * 86400000)) ? 'check28'
              : (!a.check14 ? 'check14' : null);
    if (!col) continue;
    const outcome = _outcome(a.metric_kind, a.baseline, snap);
    await db.query(`UPDATE marketing_actions SET ${col} = $1, outcome = COALESCE($2, outcome) WHERE id = $3`,
      [JSON.stringify(snap), outcome, a.id]);
    measured++;
  }
  if (measured) console.log(`[marketing-actions] measured ${measured} action(s)`);
  return { ok: true, measured };
}

module.exports = { logAction, logAlertAction, measureActions, _outcome, _snapshot };
