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
const CONCURRENCY         = 12;  // parallel live requests (ONE keyword each — see syncSerp)

// Hand-seeded keywords we always track regardless of what's in GSC/Ads data.
// Focused on CORE + contested commercial booth terms we can realistically rank
// and fight for — NOT competitor brand names (we'll never rank for "studiobricks",
// and competitors still surface as top_results on every term below). Editable.
const SEED_KEYWORDS = [
  // Brand — confirm we own it (#1).
  'whisperroom', 'whisperroom booth',
  // Core head commercial terms.
  'vocal booth', 'soundproof booth', 'recording booth', 'isolation booth',
  'sound isolation booth', 'sound booth', 'audiology booth', 'audiometric booth',
  'voice over booth', 'podcast booth', 'office phone booth', 'recording studio booth',
  'vocal isolation booth', 'soundproof room', 'soundproof booth office',
  // Use-case / application.
  'vocal recording booth', 'home recording booth', 'music practice room',
  'drum booth', 'broadcast booth', 'telehealth booth', 'hearing test booth',
  'audiology sound booth', 'podcast recording booth', 'soundproof podcast booth',
  'soundproof office pod', 'soundproof phone booth', 'office privacy booth',
  // Buying / commercial intent.
  'vocal booth for sale', 'soundproof booth for sale', 'recording booth for sale',
  'isolation booth for sale', 'portable vocal booth', 'modular sound booth',
  'professional recording booth', 'prefab recording booth', 'vocal booth price',
  'soundproof booth cost', 'sound booth for sale', 'modular soundproof booth',
  'professional vocal booth', 'soundproof recording studio', 'sound booth manufacturers',
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
    // Source limits scale with the cap so SERP_MAX_KEYWORDS actually controls how
    // wide we cast. Pull generously from each source; the final slice enforces
    // the cap. (Paid converting terms first, then commercial organic queries.)
    const paidLimit = Math.max(150, Math.round(MAX_SERP_KEYWORDS * 0.6));
    const gscLimit  = Math.max(200, MAX_SERP_KEYWORDS);

    // Converting paid search terms (proven commercial intent), last 180d.
    try {
      const r = await db.query(`
        SELECT LOWER(TRIM(search_term)) AS term, SUM(conversions)::float AS conv
        FROM marketing_search_terms
        WHERE date >= CURRENT_DATE - INTERVAL '180 days' AND search_term IS NOT NULL
        GROUP BY LOWER(TRIM(search_term))
        HAVING SUM(conversions) >= 1
        ORDER BY conv DESC
        LIMIT $1
      `, [paidLimit]);
      r.rows.forEach(row => add(row.term));
    } catch (e) { /* table may be empty pre-sync */ }

    // Commercial organic queries. For a WIDER net we no longer restrict to the
    // 4-20 "improvable" band — we want everything booth-commercial we have any
    // visibility on (incl. terms we already rank #1 for defense, and weak/page-2
    // terms for opportunity). The commercial regex keeps out informational junk;
    // impressions ≥ 20 keeps out noise. Ordered by impressions, capped to gscLimit.
    try {
      const r = await db.query(`
        SELECT query
        FROM marketing_gsc_queries
        WHERE date >= CURRENT_DATE - INTERVAL '180 days' AND query IS NOT NULL
        GROUP BY query
        HAVING SUM(impressions) >= 20
           AND query ~* '(booth|soundproof|sound proof|isolation|vocal|audiolog|audiometric|recording|podcast|voice ?over|sound room|sound booth|practice room|office pod|phone booth|drum)'
        ORDER BY SUM(impressions) DESC
        LIMIT $1
      `, [gscLimit]);
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
      // Keep BOTH: rank (organic position among organic results — what "#3"
      // means to a user) and rankAbs (position among ALL SERP elements incl.
      // ads + AI Overview + featured snippet + PAA + video). The gap between
      // them = how much stuff sits above us on the page (a CTR-suppression
      // signal we'll use in the recommendation logic).
      rank:    it.rank_group != null ? it.rank_group : it.rank_absolute,
      rankAbs: it.rank_absolute != null ? it.rank_absolute : it.rank_group,
      domain:  (it.domain || _domain(it.url) || '').toLowerCase(),
      url:     it.url || '',
      title:   it.title || '',
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

  // Paid / shopping units above us — WHO is advertising on this term. The gap
  // between our organic rank and absolute rank is partly THESE. Knowing the
  // advertiser domains powers the "Defend vs Pull-Back" call: a competitor ad
  // above our organic #1 is a defend signal; nobody bidding = don't waste spend.
  const PAID_TYPES = ['paid', 'shopping', 'commercial_units', 'popular_products', 'google_shopping'];
  const paidMap = new Map();
  items.forEach(it => {
    const ty = it.type || '';
    if (!PAID_TYPES.some(t => ty.includes(t))) return;
    const push = (dom, url, title) => {
      const d = (dom || _domain(url) || '').toLowerCase();
      if (d && !paidMap.has(d)) paidMap.set(d, { domain: d, url: url || '', title: title || '', unit: ty });
    };
    if (it.domain || it.url) push(it.domain, it.url, it.title);
    (it.items || []).forEach(p => push(p.domain || p.seller, p.url, p.title)); // nested shopping products
  });
  const paidResults = Array.from(paidMap.values()).slice(0, 10);

  // Free "Popular products" shopping grid — captured SEPARATELY from
  // paid_results (which mixes it with ads, dedupes by domain and caps at 10,
  // so it can't answer "were WE in the grid?"). This is free Merchant Center
  // real estate above the blue links; the radar's shopping-grid check fires
  // on present-without-us for terms we rank top-10 on. null = no grid.
  const ppEl = items.find(it => (it.type || '') === 'popular_products');
  let popularProducts = null;
  if (ppEl) {
    const OURS_RX = /whisper\s*-?room/i;
    const raw = ppEl.items || [];
    popularProducts = {
      present: true,
      ours: raw.some(p => OURS_RX.test(p.domain || '') || OURS_RX.test(p.seller || '') || OURS_RX.test(p.url || '')),
      items: raw.map(p => ({
        domain: ((p.domain || _domain(p.url) || '')).toLowerCase(),
        seller: p.seller || '',
        title:  p.title || '',
      })).slice(0, 12),
    };
  }

  // People-Also-Ask questions — a content roadmap (the questions buyers ask that
  // we can answer to win PAA boxes + featured snippets). Free: already in items.
  const paaEl = items.find(it => it.type === 'people_also_ask');
  const paaQuestions = paaEl
    ? (paaEl.items || []).map(q => q.title || q.question || '').filter(Boolean).slice(0, 8)
    : [];

  // Featured snippet (position-zero) owner — who Google quotes. If it's not us,
  // it's a capture target; if it is us, defend it.
  const fsEl = items.find(it => it.type === 'featured_snippet');
  const featuredSnippet = fsEl
    ? { domain: (fsEl.domain || _domain(fsEl.url) || '').toLowerCase(), url: fsEl.url || '', title: fsEl.title || '' }
    : null;

  return {
    keyword,
    our_rank:          ours ? ours.rank : null,      // organic position
    our_rank_abs:      ours ? ours.rankAbs : null,   // position among ALL SERP elements
    our_url:           ours ? ours.url : null,
    top_results:       organic.slice(0, 10),          // each carries rank + rankAbs
    paid_results:      paidResults,                    // advertisers running on this term
    popular_products:  popularProducts,                // free shopping grid {present, ours, items} or null
    paa_questions:     paaQuestions,                   // People-Also-Ask questions (content roadmap)
    featured_snippet:  featuredSnippet,                // position-zero owner (capture target / defend)
    ai_overview:       !!aiEl,
    ai_overview_cited: aiRefs.some(r => r.domain.includes(OUR_DOMAIN)),
    ai_overview_refs:  aiRefs.slice(0, 12),
    serp_features:     serpFeatures,
  };
}

async function _upsert(db, row) {
  await db.query(`
    INSERT INTO marketing_serp_snapshots
      (keyword, location_code, checked_on, our_rank, our_rank_abs, our_url, top_results,
       paid_results, popular_products, paa_questions, featured_snippet, search_volume, keyword_difficulty, cpc,
       ai_overview, ai_overview_cited, ai_overview_refs, serp_features, fetched_at)
    VALUES ($1, $2, CURRENT_DATE, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13, $14, $15, $16::jsonb, $17::jsonb, NOW())
    ON CONFLICT (keyword, location_code, checked_on) DO UPDATE SET
      our_rank           = EXCLUDED.our_rank,
      our_rank_abs       = EXCLUDED.our_rank_abs,
      our_url            = EXCLUDED.our_url,
      top_results        = EXCLUDED.top_results,
      paid_results       = EXCLUDED.paid_results,
      popular_products   = EXCLUDED.popular_products,
      paa_questions      = EXCLUDED.paa_questions,
      featured_snippet   = EXCLUDED.featured_snippet,
      search_volume      = EXCLUDED.search_volume,
      keyword_difficulty = EXCLUDED.keyword_difficulty,
      cpc                = EXCLUDED.cpc,
      ai_overview        = EXCLUDED.ai_overview,
      ai_overview_cited  = EXCLUDED.ai_overview_cited,
      ai_overview_refs   = EXCLUDED.ai_overview_refs,
      serp_features      = EXCLUDED.serp_features,
      fetched_at         = NOW()
  `, [
    row.keyword, LOCATION_CODE, row.our_rank, row.our_rank_abs, row.our_url,
    JSON.stringify(row.top_results), JSON.stringify(row.paid_results),
    JSON.stringify(row.popular_products || null),
    JSON.stringify(row.paa_questions || []), JSON.stringify(row.featured_snippet || null),
    row.search_volume, row.keyword_difficulty, row.cpc,
    row.ai_overview, row.ai_overview_cited,
    JSON.stringify(row.ai_overview_refs), JSON.stringify(row.serp_features),
  ]);
}

// Search volume + CPC for a batch of keywords (Keywords Data: Google Ads).
// One task per ≤1000 keywords (~$0.05/task). Returns { keyword: {volume, cpc} }.
// Non-fatal: any failure just leaves those keywords without volume.
//
// Google Ads rejects the WHOLE task when ANY keyword breaks its rules (>80
// chars, >10 words, special/UTF symbols) — and GSC-sourced queries routinely
// do. That silently nulled every volume while KD (Labs, no such rules) kept
// working. Defense in two layers: pre-filter keywords Google Ads would reject
// (they keep null volume), and if a task still fails on a keyword complaint,
// bisect the chunk so one bad keyword can't take down the rest.
const ADS_KW_OK = /^[a-z0-9\s'.&-]+$/i;
const _adsSafe = kw => kw.length <= 80 && kw.trim().split(/\s+/).length <= 10 && ADS_KW_OK.test(kw);

async function _volumeTask(chunk, out) {
  const resp = await _post('/v3/keywords_data/google_ads/search_volume/live',
    JSON.stringify([{ keywords: chunk, location_code: LOCATION_CODE, language_code: LANGUAGE_CODE }]));
  const t = (resp.tasks || [])[0];
  if (!t || t.status_code !== 20000 || !t.result) {
    const msg = t ? `${t.status_code}: ${t.status_message || 'no result'}` : 'no task returned';
    if (chunk.length > 1 && /invalid|field|keyword/i.test(msg)) {
      console.warn(`[serp-etl] volume task rejected (${msg}) — bisecting ${chunk.length} keywords`);
      const mid = Math.floor(chunk.length / 2);
      await _volumeTask(chunk.slice(0, mid), out);
      await _volumeTask(chunk.slice(mid), out);
      return;
    }
    console.warn(chunk.length === 1
      ? `[serp-etl] volume: Google Ads rejected keyword ${JSON.stringify(chunk[0])} (${msg}) — add its pattern to ADS_KW_OK pre-filter`
      : `[serp-etl] volume task failed for ${chunk.length} keyword(s): ${msg}`);
    return;
  }
  (t.result || []).forEach(it => {
    if (it && it.keyword) out[String(it.keyword).toLowerCase()] = {
      volume: it.search_volume != null ? it.search_volume : null,
      cpc:    it.cpc != null ? it.cpc : null,
    };
  });
}

async function _fetchVolumes(keywords) {
  const out = {};
  const safe = keywords.filter(_adsSafe);
  const skipped = keywords.filter(k => !_adsSafe(k));
  if (skipped.length) console.warn(`[serp-etl] volumes: skipping ${skipped.length} keyword(s) Google Ads would reject, e.g.: ${skipped.slice(0, 5).map(k => JSON.stringify(k)).join(', ')}`);
  for (let i = 0; i < safe.length; i += 1000) {
    try { await _volumeTask(safe.slice(i, i + 1000), out); } catch (e) { console.warn('[serp-etl] volume fetch failed:', e.message); }
  }
  console.log(`[serp-etl] volumes: ${Object.keys(out).length}/${keywords.length} keywords returned`);
  return out;
}

// Keyword difficulty 0-100 for a batch (DataForSEO Labs bulk_keyword_difficulty).
// Returns { keyword: difficulty }. Non-fatal.
async function _fetchDifficulty(keywords) {
  const out = {};
  for (let i = 0; i < keywords.length; i += 1000) {
    const chunk = keywords.slice(i, i + 1000);
    try {
      const resp = await _post('/v3/dataforseo_labs/google/bulk_keyword_difficulty/live',
        JSON.stringify([{ keywords: chunk, location_code: LOCATION_CODE, language_code: LANGUAGE_CODE }]));
      const t = (resp.tasks || [])[0];
      if (!t || t.status_code !== 20000) console.warn(`[serp-etl] KD task failed for ${chunk.length} keyword(s): ${t ? t.status_code + ': ' + (t.status_message || 'no result') : 'no task returned'}`);
      const items = (t && t.result && t.result[0] && t.result[0].items) || [];
      items.forEach(it => { if (it && it.keyword) out[String(it.keyword).toLowerCase()] = it.keyword_difficulty != null ? it.keyword_difficulty : null; });
    } catch (e) { console.warn('[serp-etl] KD fetch failed:', e.message); }
  }
  return out;
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

  // Volume + CPC + difficulty for the keywords we're about to sync — batch calls
  // (cheap), merged onto each snapshot so the rank tracker becomes prioritizable
  // (prize × winnability), not just a scoreboard.
  const [volMap, kdMap] = await Promise.all([_fetchVolumes(keywords), _fetchDifficulty(keywords)]);

  // ONE keyword per request. DataForSEO's live endpoint only returns the FIRST
  // task synchronously when handed an array, so a 20-task array silently yielded
  // a single row (v1.84.16 bug). We POST one task each and parallelize with a
  // small concurrency cap so 250 keywords finish in seconds, not minutes. Cost
  // is per-SERP either way, so single-task requests cost the same. (v1.84.17)
  let upserted = 0, errors = 0, firstError = null;
  const fetchOne = async (keyword) => {
    const body = JSON.stringify([{
      keyword,
      location_code: LOCATION_CODE,
      language_code: LANGUAGE_CODE,
      device: 'desktop',
      os: 'windows',
      depth: SERP_DEPTH,
      ...(LOAD_AI_OVERVIEW ? { load_async_ai_overview: true } : {}),
    }]);
    const resp = await _post('/v3/serp/google/organic/live/advanced', body);
    const t = (resp.tasks || [])[0];
    if (!t || t.status_code !== 20000 || !t.result || !t.result[0]) {
      throw new Error(t ? `task ${t.status_code}: ${t.status_message || 'no result'}` : 'no task returned');
    }
    return _parseResult(keyword, t.result[0]);  // pass the known keyword, not the echoed one
  };

  for (let i = 0; i < keywords.length; i += CONCURRENCY) {
    const chunk = keywords.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(chunk.map(fetchOne));
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        const row = s.value;
        const v = volMap[row.keyword] || {};
        row.search_volume = v.volume != null ? v.volume : null;
        row.cpc = v.cpc != null ? v.cpc : null;
        row.keyword_difficulty = kdMap[row.keyword] != null ? kdMap[row.keyword] : null;
        try { await _upsert(db, row); upserted++; }
        catch (e) { errors++; if (!firstError) firstError = 'upsert: ' + e.message; }
      } else {
        errors++; if (!firstError) firstError = (s.reason && s.reason.message) || String(s.reason);
      }
    }
  }

  // All failed → surface it as an error (likely bad creds or quota).
  if (upserted === 0 && errors > 0) {
    await _recordSync(db, 'serp', 0, firstError || 'all keywords failed');
    return { ok: false, report: 'serp', rows: 0, errors, error: firstError || 'all keywords failed' };
  }
  await _recordSync(db, 'serp', upserted, errors ? `${errors} failed${firstError ? ': ' + firstError : ''}` : null);
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

// dfsPost / location constants exported for gap-etl.js (content gap shares the
// same DataForSEO account + request plumbing).
module.exports = { envReady, missingEnvVars, syncSerp, SEED_KEYWORDS, MAX_SERP_KEYWORDS, dfsPost: _post, LOCATION_CODE, LANGUAGE_CODE };
