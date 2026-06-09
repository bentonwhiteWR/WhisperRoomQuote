// DataForSEO Google Organic SERP ETL (SEO Intel tab, Phase 1). For each of our
// commercial keywords it pulls the LIVE Google results page — the thing GSC
// structurally can't show: who actually ranks 1-N, our true current position,
// and whether an AI Overview is present (and whether whisperroom.com is cited in
// it). Upserts one row per (keyword, location, day) into marketing_serp_snapshots.
//
// Auth: HTTP basic with DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD (set in Railway).
// If those aren't set the sync no-ops with a clear error (mirrors gsc-etl's
// envReady gate) so the app never crashes for lack of a key.
//
// HTTP: Node built-in `https` (same rationale as gsc-etl.js / hubspot-etl.js).
// Endpoint: POST /v3/serp/google/organic/live/advanced — "advanced" returns the
// AI Overview element + its cited references alongside the organic results.
//
// Cost control: keyword list is capped (MAX_SERP_KEYWORDS) and built ONLY from
// commercially-relevant terms (our converting paid search terms + booth-intent
// GSC queries + a hand-seeded head list). A 7-day per-keyword cache skips any
// keyword already fetched this week, so re-running Sync SERP is cheap/idempotent.

const https = require('https');

const OUR_DOMAIN          = (process.env.SERP_OUR_DOMAIN || 'whisperroom.com').toLowerCase();
const LOCATION_CODE       = parseInt(process.env.SERP_LOCATION_CODE || '2840', 10); // 2840 = United States
const LANGUAGE_CODE       = process.env.SERP_LANGUAGE_CODE || 'en';
const MAX_SERP_KEYWORDS   = parseInt(process.env.SERP_MAX_KEYWORDS || '250', 10);
const SERP_DEPTH          = parseInt(process.env.SERP_DEPTH || '20', 10);   // top-N organic to capture
const LOAD_AI_OVERVIEW    = process.env.SERP_LOAD_AI_OVERVIEW !== 'false';   // default on
const CACHE_DAYS          = parseInt(process.env.SERP_CACHE_DAYS || '7', 10); // skip kws fetched within N days
const BATCH               = 20;  // tasks per live POST

// Hand-seeded commercial head terms + competitor brands. These always get
// tracked even if they're not yet in GSC/Ads data. Editable.
const SEED_KEYWORDS = [
  'vocal booth', 'soundproof booth', 'recording booth', 'isolation booth',
  'audiology booth', 'audiometric booth', 'sound booth', 'voice over booth',
  'podcast booth', 'office phone booth', 'sound isolation booth', 'whisperroom',
  'vocal booth for sale', 'soundproof booth for sale', 'recording studio booth',
  // competitor brands — to see where they outrank us
  'studiobricks', 'isovox', 'vocalbooth', 'wenger booth', 'sound booth manufacturers',
];

const REQUIRED_ENV = ['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD'];
function envReady()       { return REQUIRED_ENV.every(k => !!process.env[k]); }
function missingEnvVars() { return REQUIRED_ENV.filter(k => !process.env[k]); }

function _authHeader() {
  const token = Buffer.from(`${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`).toString('base64');
  return 'Basic ' + token;
}

// Promise-wrapped HTTPS POST → parsed JSON. Throws on transport 4xx/5xx AND on
// DataForSEO's top-level status_code (it returns HTTP 200 with a 4xxxx body for
// auth/quota errors), so failures surface in marketing_syncs.error.
function _post(path, bodyStr) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.dataforseo.com', path, method: 'POST',
      headers: {
        'Authorization': _authHeader(),
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let parsed; try { parsed = JSON.parse(raw); } catch { parsed = { raw }; }
        if (res.statusCode >= 400) {
          return reject(new Error(`DataForSEO HTTP ${res.statusCode}: ${(parsed.status_message || raw.slice(0, 200))}`));
        }
        if (parsed.status_code && parsed.status_code !== 20000) {
          return reject(new Error(`DataForSEO ${parsed.status_code}: ${parsed.status_message || 'error'}`));
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function _domain(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return ''; }
}

// Build the keyword universe from our OWN revenue data + the seed list, so we
// only ever pay to track terms that matter. Deduped, lowercased, capped.
async function _buildKeywordList(db) {
  const set = new Map();  // normalized -> original-ish (we store normalized)
  const add = k => {
    const n = String(k || '').trim().toLowerCase();
    if (n && n.length <= 80 && !set.has(n)) set.set(n, n);
  };
  SEED_KEYWORDS.forEach(add);

  if (db) {
    // Converting paid search terms (proven commercial intent), last 180d.
    try {
      const r = await db.query(`
        SELECT LOWER(TRIM(search_term)) AS term, SUM(conversions)::float AS conv
        FROM marketing_search_terms
        WHERE date >= CURRENT_DATE - INTERVAL '180 days' AND search_term IS NOT NULL
        GROUP BY LOWER(TRIM(search_term))
        HAVING SUM(conversions) >= 1
        ORDER BY conv DESC
        LIMIT 120
      `);
      r.rows.forEach(row => add(row.term));
    } catch (e) { /* table may be empty pre-sync */ }

    // Booth-intent organic queries we already rank for at an improvable
    // position (4-20), by impressions. The regex is a coarse commercial gate.
    try {
      const r = await db.query(`
        SELECT query,
               SUM(impressions)::bigint AS imp,
               SUM(position * impressions) / NULLIF(SUM(impressions),0) AS pos
        FROM marketing_gsc_queries
        WHERE date >= CURRENT_DATE - INTERVAL '180 days' AND query IS NOT NULL
        GROUP BY query
        HAVING SUM(impressions) >= 50
           AND SUM(position * impressions) / NULLIF(SUM(impressions),0) BETWEEN 4 AND 20
           AND query ~* '(booth|soundproof|sound proof|isolation|vocal|audiolog|audiometric|recording|podcast|voice ?over|sound room|sound booth)'
        ORDER BY imp DESC
        LIMIT 150
      `);
      r.rows.forEach(row => add(row.query));
    } catch (e) { /* table may be empty pre-sync */ }
  }

  return Array.from(set.keys()).slice(0, MAX_SERP_KEYWORDS);
}

// Parse one DataForSEO organic/advanced result block into our snapshot row.
function _parseResult(keyword, result) {
  const items = (result && result.items) || [];
  const organic = items
    .filter(it => it.type === 'organic')
    .map(it => ({
      rank:   it.rank_absolute || it.rank_group || null,
      domain: (it.domain || _domain(it.url) || '').toLowerCase(),
      url:    it.url || '',
      title:  it.title || '',
    }))
    .filter(it => it.rank != null)
    .sort((a, b) => a.rank - b.rank);

  const ours = organic.find(o => o.domain.includes(OUR_DOMAIN));

  // AI Overview element (when present): pull the cited reference links.
  const aiEl = items.find(it => it.type === 'ai_overview');
  let aiRefs = [];
  if (aiEl) {
    const rawRefs = aiEl.references
      || (aiEl.items || []).flatMap(s => s.references || [])
      || [];
    aiRefs = rawRefs.map(ref => ({
      domain: (ref.domain || _domain(ref.url) || '').toLowerCase(),
      url:    ref.url || '',
      title:  ref.title || ref.text || '',
    })).filter(r => r.domain);
  }

  const featureTypes = (result && result.item_types) || [...new Set(items.map(it => it.type))];
  const serpFeatures = {};
  featureTypes.forEach(t => { if (t !== 'organic') serpFeatures[t] = true; });

  return {
    keyword,
    our_rank:          ours ? ours.rank : null,
    our_url:           ours ? ours.url : null,
    top_results:       organic.slice(0, 10),
    ai_overview:       !!aiEl,
    ai_overview_cited: aiRefs.some(r => r.domain.includes(OUR_DOMAIN)),
    ai_overview_refs:  aiRefs.slice(0, 12),
    serp_features:     serpFeatures,
  };
}

async function _upsert(db, row) {
  await db.query(`
    INSERT INTO marketing_serp_snapshots
      (keyword, location_code, checked_on, our_rank, our_url, top_results,
       ai_overview, ai_overview_cited, ai_overview_refs, serp_features, fetched_at)
    VALUES ($1, $2, CURRENT_DATE, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9::jsonb, NOW())
    ON CONFLICT (keyword, location_code, checked_on) DO UPDATE SET
      our_rank          = EXCLUDED.our_rank,
      our_url           = EXCLUDED.our_url,
      top_results       = EXCLUDED.top_results,
      ai_overview       = EXCLUDED.ai_overview,
      ai_overview_cited = EXCLUDED.ai_overview_cited,
      ai_overview_refs  = EXCLUDED.ai_overview_refs,
      serp_features     = EXCLUDED.serp_features,
      fetched_at        = NOW()
  `, [
    row.keyword, LOCATION_CODE, row.our_rank, row.our_url,
    JSON.stringify(row.top_results), row.ai_overview, row.ai_overview_cited,
    JSON.stringify(row.ai_overview_refs), JSON.stringify(row.serp_features),
  ]);
}

// ── syncSerp ────────────────────────────────────────────────────────────
// Builds the keyword list, skips anything fetched in the last CACHE_DAYS,
// pulls the live SERP for the rest in batches, and upserts. `force:true`
// bypasses the 7-day cache (full refresh). Recorded under report_type 'serp'.
async function syncSerp({ db, force = false } = {}) {
  if (!envReady()) {
    throw new Error('DataForSEO credentials not configured. Missing: ' + missingEnvVars().join(', '));
  }

  let keywords = await _buildKeywordList(db);

  // 7-day cache: drop keywords already fetched recently (unless forced).
  if (db && !force && CACHE_DAYS > 0) {
    try {
      const r = await db.query(
        `SELECT DISTINCT keyword FROM marketing_serp_snapshots
          WHERE location_code = $1 AND checked_on >= CURRENT_DATE - ($2 || ' days')::interval`,
        [LOCATION_CODE, String(CACHE_DAYS)]
      );
      const fresh = new Set(r.rows.map(x => x.keyword));
      keywords = keywords.filter(k => !fresh.has(k));
    } catch (e) { /* table not created yet → nothing cached */ }
  }

  if (!keywords.length) {
    await _recordSync(db, 'serp', 0, null);
    return { ok: true, report: 'serp', rows: 0, note: 'All tracked keywords are fresh (within cache window). Use force to refresh.' };
  }

  let upserted = 0, errors = 0;
  try {
    for (let i = 0; i < keywords.length; i += BATCH) {
      const batch = keywords.slice(i, i + BATCH);
      const tasks = batch.map(keyword => ({
        keyword,
        location_code: LOCATION_CODE,
        language_code: LANGUAGE_CODE,
        device: 'desktop',
        os: 'windows',
        depth: SERP_DEPTH,
        ...(LOAD_AI_OVERVIEW ? { load_async_ai_overview: true } : {}),
      }));
      const resp = await _post('/v3/serp/google/organic/live/advanced', JSON.stringify(tasks));
      for (const task of (resp.tasks || [])) {
        const kw = task.data && task.data.keyword;
        if (task.status_code !== 20000 || !task.result || !task.result[0]) { errors++; continue; }
        try {
          await _upsert(db, _parseResult(kw, task.result[0]));
          upserted++;
        } catch (e) { errors++; }
      }
    }
  } catch (e) {
    const msg = e.message || String(e);
    await _recordSync(db, 'serp', upserted, msg);
    return { ok: false, report: 'serp', rows: upserted, error: msg };
  }

  await _recordSync(db, 'serp', upserted, errors ? `${errors} keyword(s) failed to parse` : null);
  return { ok: true, report: 'serp', rows: upserted, errors, checked: keywords.length };
}

async function _recordSync(db, reportType, rows, error) {
  if (!db) return;
  try {
    await db.query(`
      INSERT INTO marketing_syncs (report_type, last_synced_at, rows_synced, date_from, date_to, error)
      VALUES ($1, NOW(), $2, NULL, NULL, $3)
      ON CONFLICT (report_type) DO UPDATE SET
        last_synced_at = NOW(), rows_synced = EXCLUDED.rows_synced, error = EXCLUDED.error
    `, [reportType, rows, error]);
  } catch (e) { console.warn('[serp-etl] sync record failed:', e.message); }
}

module.exports = { envReady, missingEnvVars, syncSerp, SEED_KEYWORDS, MAX_SERP_KEYWORDS };
