// Competitor content gap (intel-roadmap layer 4). Pulls each competitor's
// ranked keywords from DataForSEO Labs, subtracts everything WhisperRoom
// already covers (SERP snapshots where we rank + our own ranked keywords +
// GSC queries with clicks), and scores what's left by BUSINESS value — segment
// family weight × commercial intent × volume — not raw volume, so audiology
// terms that close five-figure booth deals outrank generic DIY noise.
//
// Cost-metered like the SERP sync: manual "Sync gap" only (never in 'all'),
// ~5 Labs ranked_keywords calls per run (one per domain + ours) — roughly a
// dollar at current pricing. Results land in marketing_content_gap (full
// refresh per sync; it's derived data).

const serpEtl = require('./serp-etl');

// Editable: who we measure against. Office-pod players included deliberately —
// they own the office-booth SERPs we're expanding into. Env override:
// GAP_COMPETITORS=a.com,b.com in Railway.
const GAP_COMPETITORS = (process.env.GAP_COMPETITORS || 'vocalbooth.com,studiobricks.com,vocalboothtogo.com,zenbooth.com')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const GAP_LIMIT     = parseInt(process.env.GAP_LIMIT || '700', 10);   // rows per competitor pull
const OUR_GAP_LIMIT = 2000;                                            // rows for our own coverage pull

// Only keep keywords in our universe — competitors also rank for brand junk,
// careers pages, blog tangents. Editable.
const RELEVANT_RX = /\b(booth|booths|pod|pods|room|rooms|studio|vocal|record|recording|sound|acoustic|audio|noise|quiet|isolat\w*|podcast|audiolog\w*|audiometr\w*|hearing|drum|practice|voice|broadcast|telehealth|whisper\w*|enclosure|cabin)\b/i;

// Segment families + business-value weights. v1: hand-seeded from what closes
// (audiology/telehealth booths are the five-figure deals; office pods are the
// growth bet). Revisit with revenue-derived weights once the gap content has
// attribution history. First match wins, top to bottom.
const FAMILIES = [
  { key: 'audiology',  rx: /audiolog|audiometr|hearing|tympan/i,                          weight: 3.0 },
  { key: 'medical',    rx: /telehealth|therap|medical|clinic|counsel/i,                   weight: 3.0 },
  { key: 'office',     rx: /office|phone booth|privacy|meeting|work\s?pod|call booth/i,   weight: 2.0 },
  { key: 'podcast',    rx: /podcast/i,                                                    weight: 1.6 },
  { key: 'broadcast',  rx: /broadcast|radio/i,                                            weight: 1.6 },
  { key: 'drum-music', rx: /drum|music practice|practice room|piano|instrument|rehears/i, weight: 1.6 },
  { key: 'vocal-rec',  rx: /vocal|sing|record|voice\s?over|studio/i,                      weight: 1.4 },
  { key: 'general',    rx: /./,                                                           weight: 1.0 },
];
const INTENTS = [
  { key: 'buy',    rx: /for sale|price|prices|cost|buy|cheap|best|near me|kit|order/i, mult: 1.5 },
  { key: 'info',   rx: /how to|diy|what is|what's|why|build|make|plans|ideas|free/i,   mult: 0.4 },
  { key: 'browse', rx: /./,                                                            mult: 1.0 },
];
const _family = kw => FAMILIES.find(f => f.rx.test(kw));
const _intent = kw => INTENTS.find(i => i.rx.test(kw));

// One Labs ranked_keywords pull: keywords `target` ranks top-20 for, by volume.
async function _rankedKeywords(target, limit) {
  const resp = await serpEtl.dfsPost('/v3/dataforseo_labs/google/ranked_keywords/live', JSON.stringify([{
    target,
    location_code: serpEtl.LOCATION_CODE,
    language_code: serpEtl.LANGUAGE_CODE,
    limit,
    order_by: ['keyword_data.keyword_info.search_volume,desc'],
    filters: [
      ['ranked_serp_element.serp_item.rank_group', '<=', 20], 'and',
      ['keyword_data.keyword_info.search_volume', '>=', 10],
    ],
  }]));
  const t = (resp.tasks || [])[0];
  if (!t || t.status_code !== 20000) {
    throw new Error(`ranked_keywords(${target}) task ${t ? t.status_code + ': ' + (t.status_message || '') : 'missing'}`);
  }
  const items = (t.result && t.result[0] && t.result[0].items) || [];
  return items.map(it => {
    const kd = it.keyword_data || {};
    const info = kd.keyword_info || {};
    const props = kd.keyword_properties || {};
    const serp = (it.ranked_serp_element && it.ranked_serp_element.serp_item) || {};
    return {
      keyword: String(kd.keyword || '').toLowerCase().trim(),
      volume:  info.search_volume != null ? info.search_volume : null,
      cpc:     info.cpc != null ? info.cpc : null,
      kdiff:   props.keyword_difficulty != null ? props.keyword_difficulty : null,
      rank:    serp.rank_group != null ? serp.rank_group : null,
      url:     serp.url || '',
    };
  }).filter(x => x.keyword);
}

// Everything we already cover — gap means NONE of these sets contain it.
async function _ourCoverage(db) {
  const covered = new Set();
  try {
    (await db.query(`SELECT DISTINCT keyword FROM marketing_serp_snapshots WHERE our_rank IS NOT NULL`))
      .rows.forEach(r => covered.add(r.keyword.toLowerCase().trim()));
  } catch {}
  try {
    (await db.query(`SELECT query FROM marketing_gsc_queries WHERE date >= CURRENT_DATE - 180 GROUP BY query HAVING SUM(clicks) >= 2 LIMIT 20000`))
      .rows.forEach(r => covered.add(String(r.query).toLowerCase().trim()));
  } catch {}
  try {
    (await _rankedKeywords('whisperroom.com', OUR_GAP_LIMIT)).forEach(x => covered.add(x.keyword));
  } catch (e) { console.warn('[gap-etl] our ranked_keywords pull failed (coverage falls back to snapshots+GSC):', e.message); }
  return covered;
}

async function syncGap({ db }) {
  if (!serpEtl.envReady()) {
    throw new Error('DataForSEO credentials not configured. Missing: ' + serpEtl.missingEnvVars().join(', '));
  }
  if (!db) return { ok: false, error: 'no db' };

  const covered = await _ourCoverage(db);

  // Pull competitors sequentially (5 calls total — politeness over speed).
  const byKeyword = new Map();
  const errors = [];
  for (const dom of GAP_COMPETITORS) {
    try {
      for (const x of await _rankedKeywords(dom, GAP_LIMIT)) {
        if (covered.has(x.keyword)) continue;
        if (!RELEVANT_RX.test(x.keyword)) continue;
        const cur = byKeyword.get(x.keyword) || {
          keyword: x.keyword, volume: x.volume, cpc: x.cpc, kdiff: x.kdiff, competitors: [],
        };
        cur.volume = cur.volume != null ? cur.volume : x.volume;
        cur.cpc    = cur.cpc    != null ? cur.cpc    : x.cpc;
        cur.kdiff  = cur.kdiff  != null ? cur.kdiff  : x.kdiff;
        cur.competitors.push({ domain: dom, rank: x.rank, url: x.url });
        byKeyword.set(x.keyword, cur);
      }
    } catch (e) { errors.push(e.message); }
  }

  const rows = [...byKeyword.values()].map(r => {
    const fam = _family(r.keyword), int = _intent(r.keyword);
    r.family = fam.key; r.intent = int.key;
    r.score = Math.round((r.volume || 0) * fam.weight * int.mult);
    return r;
  }).sort((a, b) => b.score - a.score);

  // Derived data → full refresh.
  await db.query(`DELETE FROM marketing_content_gap`);
  for (const r of rows) {
    await db.query(`
      INSERT INTO marketing_content_gap (keyword, competitors, search_volume, cpc, keyword_difficulty, family, intent, score)
      VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (keyword) DO NOTHING`,
      [r.keyword, JSON.stringify(r.competitors), r.volume, r.cpc, r.kdiff, r.family, r.intent, r.score]);
  }

  const error = errors.length ? errors.join(' | ') : null;
  await db.query(
    `INSERT INTO marketing_syncs (report_type, last_synced_at, rows_synced, error)
     VALUES ('gap', NOW(), $1, $2)
     ON CONFLICT (report_type) DO UPDATE SET last_synced_at = NOW(), rows_synced = $1, error = $2`,
    [rows.length, error]
  );
  console.log(`[gap-etl] content gap: ${rows.length} keywords across ${GAP_COMPETITORS.length} competitors${error ? ' — errors: ' + error : ''}`);
  return { ok: !error || rows.length > 0, report: 'gap', rows: rows.length, competitors: GAP_COMPETITORS, error };
}

module.exports = { syncGap, GAP_COMPETITORS };
