// Google Search Console (Search Analytics) ETL. Pulls daily ORGANIC query +
// page performance for the whisperroom.com property and upserts into
// marketing_gsc_queries / marketing_gsc_pages. Powers the dashboard's
// "Google Search Console" tab (organic KPIs + paid×organic overlap).
//
// Auth: reuses the SAME OAuth client + refresh token as google-ads-etl.js
// (GOOGLE_ADS_CLIENT_ID / _CLIENT_SECRET / _REFRESH_TOKEN). The refresh token
// must carry the https://www.googleapis.com/auth/webmasters.readonly scope in
// addition to the adwords scope (re-minted 2026-06 to cover both). No new env.
//
// HTTP: Node built-in `https` — same rationale as hubspot-etl.js (marketing/
// modules aren't passed lib/*'s httpsRequest via init({deps})).
//
// Property: GSC_SITE_URL env, default the domain property sc-domain:whisperroom.com.
// Idempotent: (date, query|page) composite PKs + ON CONFLICT DO UPDATE. Daily
// granularity so the dashboard's ?days=N filter sub-windows the same way the
// Google Ads tables do. GSC data lags ~2-3 days; recent days return whatever
// is finalized.

const https = require('https');

const GSC_SITE_URL = process.env.GSC_SITE_URL || 'sc-domain:whisperroom.com';
const REQUIRED_ENV = ['GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REFRESH_TOKEN'];

function envReady()       { return REQUIRED_ENV.every(k => !!process.env[k]); }
function missingEnvVars() { return REQUIRED_ENV.filter(k => !process.env[k]); }

function _gDate(d)   { return d.toISOString().slice(0, 10); }
function _daysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return d; }

// Promise-wrapped HTTPS POST → parsed JSON; throws on 4xx/5xx with the error
// detail so it surfaces in marketing_syncs.error.
function _post(hostname, path, headers, bodyStr) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(bodyStr) } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let parsed; try { parsed = JSON.parse(raw); } catch { parsed = { raw }; }
        if (res.statusCode >= 400) {
          const e = parsed.error;
          const detail = (e && (e.message || e)) || parsed.message || raw.slice(0, 200);
          return reject(new Error(`GSC ${res.statusCode}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`));
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// Exchange the refresh token for a short-lived access token.
async function _accessToken() {
  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     process.env.GOOGLE_ADS_CLIENT_ID,
    client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
  }).toString();
  const j = await _post('oauth2.googleapis.com', '/token',
    { 'Content-Type': 'application/x-www-form-urlencoded' }, body);
  if (!j.access_token) throw new Error('OAuth token refresh failed (no access_token returned)');
  return j.access_token;
}

// Query the Search Analytics API for `dimensions` over [from,to], paginating
// in 25k-row pages (the API max) until a short page returns.
async function _searchAnalytics(token, from, to, dimensions) {
  const ROW_LIMIT = 25000;
  const out = [];
  const path = '/webmasters/v3/sites/' + encodeURIComponent(GSC_SITE_URL) + '/searchAnalytics/query';
  for (let startRow = 0; ; startRow += ROW_LIMIT) {
    const body = JSON.stringify({ startDate: from, endDate: to, dimensions, rowLimit: ROW_LIMIT, startRow });
    const j = await _post('searchconsole.googleapis.com', path,
      { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body);
    const rows = j.rows || [];
    out.push(...rows);
    if (rows.length < ROW_LIMIT) break;
  }
  return out;
}

// ── syncGsc ────────────────────────────────────────────────────────────
// Pulls daily (date×query) and (date×page) organic rows for the last
// `daysBack` days and upserts them. Recorded under report_type 'gsc'.
async function syncGsc({ db, daysBack = 90 }) {
  if (!envReady()) {
    throw new Error('GSC credentials not configured. Missing: ' + missingEnvVars().join(', '));
  }
  const dateTo   = _gDate(new Date());
  const dateFrom = _gDate(_daysAgo(daysBack));

  let queryRows = [], pageRows = [], dailyRows = [], queryPageRows = [];
  try {
    const token = await _accessToken();
    queryRows = await _searchAnalytics(token, dateFrom, dateTo, ['date', 'query']);
    pageRows  = await _searchAnalytics(token, dateFrom, dateTo, ['date', 'page']);
    // Date-only totals (NO query/page dimension → not anonymized). These match
    // the GSC UI "Total clicks/impressions". The query/page tables above drop
    // anonymized long-tail rows, so summing them undercounts the true total
    // (often 60-70% short on clicks). The KPI cards + performance chart read
    // marketing_gsc_daily so the headline numbers reconcile with Search Console.
    dailyRows = await _searchAnalytics(token, dateFrom, dateTo, ['date']);
    // Query × page (NO date) → which page Google actually ranks for each query.
    // Powers the real "ranking page" in the Revenue/Action engines. No date
    // dimension keeps it small (bounded by distinct pairs, not pairs × days).
    queryPageRows = await _searchAnalytics(token, dateFrom, dateTo, ['query', 'page']);
  } catch (e) {
    const msg = e.message || String(e);
    await _recordSync(db, 'gsc', 0, dateFrom, dateTo, msg);
    return { ok: false, report: 'gsc', rows: 0, error: msg };
  }

  await _bulkUpsert(db, 'marketing_gsc_queries', 'query', queryRows);
  await _bulkUpsert(db, 'marketing_gsc_pages',   'page',  pageRows);
  await _upsertDaily(db, dailyRows);
  await _upsertQueryPages(db, queryPageRows);

  const total = queryRows.length + pageRows.length + dailyRows.length + queryPageRows.length;
  await _recordSync(db, 'gsc', total, dateFrom, dateTo, null);
  return { ok: true, report: 'gsc', rows: total, queries: queryRows.length, pages: pageRows.length, daily: dailyRows.length, query_pages: queryPageRows.length, date_from: dateFrom, date_to: dateTo };
}

// Chunked multi-row upsert (~500 rows/statement). GSC daily data can be
// hundreds of thousands of rows; row-by-row awaited INSERTs would crawl and
// risk timing out the sync. `table`/`keyCol` are controlled literals (not user
// input), so interpolating them is safe.
async function _bulkUpsert(db, table, keyCol, rows) {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const tuples = [], params = [];
    chunk.forEach((r, j) => {
      const b = j * 6;
      tuples.push(`($${b+1}, $${b+2}, $${b+3}, $${b+4}, $${b+5}, $${b+6})`);
      const [date, key] = r.keys;
      params.push(date, key, r.clicks || 0, r.impressions || 0, r.ctr || 0, r.position || 0);
    });
    await db.query(
      `INSERT INTO ${table} (date, ${keyCol}, clicks, impressions, ctr, position) VALUES ${tuples.join(', ')}
       ON CONFLICT (date, ${keyCol}) DO UPDATE SET
         clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions,
         ctr = EXCLUDED.ctr, position = EXCLUDED.position, updated_at = NOW()`,
      params
    );
  }
}

// Date-only totals upsert (marketing_gsc_daily). Tiny table (≤1 row/day) so no
// chunking needed. Keys = [date]; clicks/impressions/ctr/position are the true
// daily totals straight from the API's date-dimension report (un-anonymized).
async function _upsertDaily(db, rows) {
  if (!db) return;
  for (const r of rows) {
    const date = r.keys && r.keys[0];
    if (!date) continue;
    await db.query(
      `INSERT INTO marketing_gsc_daily (date, clicks, impressions, ctr, position)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (date) DO UPDATE SET
         clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions,
         ctr = EXCLUDED.ctr, position = EXCLUDED.position, updated_at = NOW()`,
      [date, r.clicks || 0, r.impressions || 0, r.ctr || 0, r.position || 0]
    );
  }
}

// Query × page upsert (marketing_gsc_query_pages). Keys = [query, page].
// Chunked like the daily-segmented tables — can be tens of thousands of pairs.
async function _upsertQueryPages(db, rows) {
  if (!db) return;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const tuples = [], params = [];
    chunk.forEach((r, j) => {
      const b = j * 6;
      tuples.push(`($${b+1}, $${b+2}, $${b+3}, $${b+4}, $${b+5}, $${b+6})`);
      const [query, page] = r.keys;
      params.push(query, page, r.clicks || 0, r.impressions || 0, r.ctr || 0, r.position || 0);
    });
    await db.query(
      `INSERT INTO marketing_gsc_query_pages (query, page, clicks, impressions, ctr, position) VALUES ${tuples.join(', ')}
       ON CONFLICT (query, page) DO UPDATE SET
         clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions,
         ctr = EXCLUDED.ctr, position = EXCLUDED.position, updated_at = NOW()`,
      params
    );
  }
}

async function _recordSync(db, reportType, rows, dateFrom, dateTo, error) {
  if (!db) return;
  try {
    await db.query(`
      INSERT INTO marketing_syncs (report_type, last_synced_at, rows_synced, date_from, date_to, error)
      VALUES ($1, NOW(), $2, $3, $4, $5)
      ON CONFLICT (report_type) DO UPDATE SET
        last_synced_at = NOW(), rows_synced = EXCLUDED.rows_synced,
        date_from = EXCLUDED.date_from, date_to = EXCLUDED.date_to, error = EXCLUDED.error
    `, [reportType, rows, dateFrom, dateTo, error]);
  } catch (e) { console.warn('[gsc-etl] sync record failed:', e.message); }
}

module.exports = { envReady, missingEnvVars, syncGsc, GSC_SITE_URL };
