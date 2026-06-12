// ✨ Pulse AI summaries (v1.106.0) — "tell me more" for the 📊 Pulse tab.
// One Claude call per (focus, days) window, grounded in the EXACT aggregate
// pack the charts render from (router passes _pulseAggregates through), so
// the narrative can never disagree with the numbers on screen.
//
// Design rules (same school as defense.js "see fix" / digest.js):
//   - Quote real numbers from the supplied data; never invent a trend.
//   - DESCRIPTIVE, not prescriptive: no spend/bid/SEO recommendations —
//     those live in Growth Engine / Paid Defense where the live-SERP +
//     slow-close brain can veto them (Gabe's one-brain principle). "watch"
//     items are patterns to keep an eye on, not actions.
//   - Caveats must name what this data CANNOT show (first-touch basis,
//     first-conversion form counts, primary-contact deal joins, partial
//     trailing week).
//   - Output schema arrays are bare type+items — Claude's structured-output
//     validator rejects minItems>1/maxItems (learned v1.102.1/.2); counts
//     live in the prompt.
//
// Cache: marketing_ai_outputs, kind = 'pulse-ai:<focus>:<days>'. Regenerate
// overwrites; the dashboard shows the generated-at stamp + a ↻.

const claude = require('./claude');

// Trim helpers — keep the prompt payload lean. Weekly series stay whole
// (≤53 buckets); per-form tables cap at the top N by volume.
const topN = (rows, n, key) => [...(rows || [])].sort((a, b) => (b[key] || 0) - (a[key] || 0)).slice(0, n);
function formTotals(formsWeekly, n = 10) {
  const t = {};
  (formsWeekly || []).forEach(r => { t[r.form] = (t[r.form] || 0) + r.submissions; });
  return Object.entries(t).map(([form, submissions]) => ({ form, submissions }))
    .sort((a, b) => b.submissions - a.submissions).slice(0, n);
}

// What each ✨ button sends + what to focus the read on. `pick` selects the
// data slice (smaller slice = sharper read + fewer tokens); `ask` is the
// section-specific framing appended to the user prompt.
const FOCUS = {
  overview: {
    title: 'Overview',
    pick: a => ({ kpis: a.kpis, contactsWeekly: a.contactsWeekly, funnel: a.funnel,
                  sourceRevenue: a.sourceRevenue, dealsWeekly: a.dealsWeekly, wonWeekly: a.wonWeekly,
                  wonReasons: a.wonReasons, lostReasons: a.lostReasons, velocity: a.velocity,
                  formTotals: formTotals(a.formsWeekly) }),
    ask: 'Give the overall read: how is marketing→pipeline health trending across leads, sources, deals, revenue, and sales velocity? Lead with the single most important thing.',
  },
  leads: {
    title: 'Leads & traffic sources',
    pick: a => ({ kpis: { contacts_cur: a.kpis.contacts_cur, contacts_prev: a.kpis.contacts_prev },
                  contactsWeekly: a.contactsWeekly, funnel: a.funnel }),
    ask: 'Focus on lead flow: volume trend week to week, which first-touch sources are growing or shrinking, the source mix, and how the cohort distributes across lifecycle stages.',
  },
  forms: {
    title: 'Form conversions',
    pick: a => ({ kpis: { forms_cur: a.kpis.forms_cur, forms_prev: a.kpis.forms_prev },
                  formsWeekly: a.formsWeekly, formsBySource: topN(a.formsBySource, 25, 'submissions') }),
    ask: 'Focus on form conversions: which forms convert the most contacts, the weekly trend, and which channels feed which forms. Note any form whose source mix differs sharply from the rest.',
  },
  funnel: {
    title: 'Lifecycle funnel',
    pick: a => ({ kpis: { contacts_cur: a.kpis.contacts_cur }, funnel: a.funnel }),
    ask: 'Focus on the lifecycle funnel: where the window\'s cohort sits, where the biggest drop-off is, and the share that has reached opportunity/customer.',
  },
  revenue: {
    title: 'Revenue by source',
    pick: a => ({ kpis: { revenue_cur: a.kpis.revenue_cur, revenue_prev: a.kpis.revenue_prev, won_cur: a.kpis.won_cur },
                  sourceRevenue: a.sourceRevenue, wonWeekly: a.wonWeekly }),
    ask: 'Focus on won revenue by first-touch source: concentration vs spread, average deal size per source (derive from won_revenue/won_deals), and the size of the Unattributed/UNKNOWN share.',
  },
  rhythm: {
    title: 'Pipeline rhythm',
    pick: a => ({ kpis: { deals_cur: a.kpis.deals_cur, deals_prev: a.kpis.deals_prev,
                          won_cur: a.kpis.won_cur, revenue_cur: a.kpis.revenue_cur,
                          median_close_cur: a.kpis.median_close_cur },
                  dealsWeekly: a.dealsWeekly, wonWeekly: a.wonWeekly }),
    ask: 'Focus on the deal pipeline rhythm: deal-creation cadence vs when revenue actually closes, the visible lag between the two, and any week that stands out on either series.',
  },
  reasons: {
    title: 'Win/loss reasons',
    pick: a => ({ kpis: { won_cur: a.kpis.won_cur, lost_cur: a.kpis.lost_cur },
                  wonReasons: a.wonReasons, lostReasons: a.lostReasons }),
    ask: 'Focus on why deals close and why they are lost: the dominant reasons by count AND by dollars (they can rank differently), and what share of closed deals even carry a reason.',
  },
  velocity: {
    title: 'Sales velocity',
    pick: a => ({ kpis: { median_close_cur: a.kpis.median_close_cur, median_close_prev: a.kpis.median_close_prev, won_cur: a.kpis.won_cur },
                  velocity: a.velocity }),
    ask: 'Focus on time-to-close: the shape of the distribution (fast pile vs long tail), the median and how it moved vs the prior period, and how big the 90-day-plus tail is.',
  },
};

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'observations', 'caveats', 'watch'],
  properties: {
    headline:     { type: 'string', description: 'One-sentence plain-English read of this data, leading with the most important fact.' },
    observations: { type: 'array', items: { type: 'string' } },
    caveats:      { type: 'array', items: { type: 'string' } },
    watch:        { type: 'array', items: { type: 'string' } },
  },
};

const SYSTEM = `You are the in-house marketing analyst for WhisperRoom, a US manufacturer of modular sound-isolation booths sold to studios, voice-over artists, audiologists, offices, and schools. You write short, grounded reads of the company's HubSpot marketing data for the founder's dashboard.

You will receive a JSON snapshot of pre-aggregated HubSpot data — the exact numbers a dashboard chart renders — plus the date window in days.

HARD RULES:
1. Every observation must quote at least one real number from the supplied data (counts, dollars, percentages you compute from it). Never invent or extrapolate numbers that are not derivable from the snapshot.
2. Only name sources, forms, lifecycle stages, and reasons that literally appear in the data.
3. You are DESCRIPTIVE, not prescriptive. Do NOT recommend budget moves, bidding changes, or SEO actions — other dashboard panels own those decisions with live-SERP context this snapshot does not have. "watch" items are patterns worth keeping an eye on, phrased as observations ("X is worth watching because Y"), never instructions.
4. Weekly buckets are Monday-start; the FIRST and LAST buckets are usually partial weeks — never call a trailing-week drop a decline without flagging it as a partial bucket.
5. caveats must name what this data cannot show. Relevant limits: source splits are FIRST-touch attribution (a paid-assisted deal can show as Organic/Direct); form counts are each contact's FIRST form submission, not total submission volume; deal→source joins go through the deal's primary contact only; "prev" KPI values compare the same-length window immediately before this one.
6. Produce 3-5 observations, 1-3 caveats, 1-3 watch items. Write complete sentences, plain English, no headers or markdown. Never describe the product as "soundproof" (brand rule: sound isolation).
7. If a dataset is empty or too thin to read, say exactly that in the headline rather than stretching weak data.`;

async function summarize({ db, days, focus, force, getAggregates }) {
  const f = FOCUS[focus];
  if (!f) return { ok: false, status: 400, error: `Unknown focus '${focus}'.` };
  const kind = `pulse-ai:${focus}:${days}`;

  if (!force) {
    try {
      const r = await db.query(`SELECT result, model, created_at FROM marketing_ai_outputs WHERE kind = $1`, [kind]);
      if (r.rows.length) {
        return { ok: true, cached: true, focus, days, summary: r.rows[0].result, model: r.rows[0].model, created_at: r.rows[0].created_at };
      }
    } catch {}
  }

  const aggregates = await getAggregates();
  const data = f.pick(aggregates);
  const user = `Window: the last ${days} days (vs the ${days} days before it for any *_prev KPI).
Section: ${f.title}.
${f.ask}

DATA (pre-aggregated, exactly what the chart shows):
${JSON.stringify(data)}`;

  const out = await claude.jsonCall({ system: SYSTEM, user, schema: SCHEMA, maxTokens: 1400 });
  if (!out.ok) return out;

  try {
    await db.query(`
      INSERT INTO marketing_ai_outputs (kind, result, model, created_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (kind) DO UPDATE SET result = EXCLUDED.result, model = EXCLUDED.model, created_at = NOW()
    `, [kind, JSON.stringify(out.data), out.model]);
  } catch (e) {
    console.warn('[pulse-ai] cache write failed (serving uncached):', e.message);
  }
  return { ok: true, cached: false, focus, days, summary: out.data, model: out.model, created_at: new Date().toISOString() };
}

module.exports = { summarize, FOCUS };
