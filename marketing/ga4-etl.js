// GA4 (Google Analytics Data API) ETL — pulls daily traffic + on-site
// conversion metrics for whisperroom.com and upserts into
// marketing_ga4_daily (date × default channel group) and
// marketing_ga4_pages (date × landing page). This is the post-click /
// pre-form middle of the funnel the other ETLs can't see: GSC + Ads show
// clicks IN, HubSpot shows form conversions OUT — GA4 supplies sessions,
// engagement, and key events in between (landing-page conversion rates,
// pacing denominators).
//
// Auth: the SAME OAuth client + refresh token as google-ads-etl.js /
// gsc-etl.js (GOOGLE_ADS_CLIENT_ID / _CLIENT_SECRET / _REFRESH_TOKEN). The
// refresh token must carry https://www.googleapis.com/auth/analytics.readonly
// in addition to adwords + webmasters.readonly — re-mint with
// whisperroom-os scripts/mint_google_token.py (2026-06, three scopes). The
// Google Cloud project that owns the OAuth client must have the "Google
// Analytics Data API" enabled, and the Google account behind the token
// needs Viewer (or higher) on the GA4 property.
//
// Property: GA4_PROPERTY_ID env — the NUMERIC id from GA4 Admin → Property
// settings (not the "G-XXXXXXX" measurement id).
//
// HTTP: Node built-in `https`, same rationale as the sibling ETLs.
// Idempotent: composite PKs + ON CONFLICT DO UPDATE; GA4 data for recent
// days firms up over ~24-48h, so re-syncs overwrite with fresher numbers.

const https = require('https');

const REQUIRED_ENV = ['GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REFRESH_TOKEN', 'GA4_PROPERTY_ID'];

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
          return reject(new Error(`GA4 ${res.statusCode}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`));
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// Exchange the refresh token for a short-lived access token (same flow as
// gsc-etl.js — one token, three APIs).
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

// runReport with offset pagination. GA4 caps `limit` at 250k/request; we use
// 100k pages and loop until a short page. Dates come back as 'YYYYMMDD'.
async function _runReport(token, body) {
  const PAGE = 100000;
  const path = `/v1beta/properties/${process.env.GA4_PROPERTY_ID}:runReport`;
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const j = await _post('analyticsdata.googleapis.com', path,
      { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      JSON.stringify({ ...body, limit: PAGE, offset }));
    const rows = j.rows || [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

const _ga4Date = s => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;  // YYYYMMDD → YYYY-MM-DD
const _num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

// GA4 renamed the conversions metric to keyEvents (2024). Request keyEvents
// first; if the API rejects the metric name (older property semantics), fall
// back to 'conversions' once so the sync degrades instead of dying.
async function _reportWithKeyEvents(token, base, otherMetrics) {
  try {
    return { rows: await _runReport(token, { ...base, metrics: [...otherMetrics, { name: 'keyEvents' }] }), metric: 'keyEvents' };
  } catch (e) {
    if (!/keyEvents/i.test(e.message)) throw e;
    return { rows: await _runReport(token, { ...base, metrics: [...otherMetrics, { name: 'conversions' }] }), metric: 'conversions' };
  }
}

// ── syncGa4 ────────────────────────────────────────────────────────────
// Report A: date × sessionDefaultChannelGroup (sessions, users, engaged,
//           key events) over the full daysBack window — site trend + channel
//           mix, the pacing denominators.
// Report B: date × landingPage (sessions, engaged, key events) capped at 120
//           days (same row-volume cap policy as GSC in Sync All) — the
//           landing-page conversion-rate join against HubSpot forms.
// Recorded under report_type 'ga4'.
async function syncGa4({ db, daysBack = 365 }) {
  if (!envReady()) {
    throw new Error('GA4 not configured. Missing: ' + missingEnvVars().join(', '));
  }
  const dateTo       = _gDate(new Date());
  const dateFrom     = _gDate(_daysAgo(daysBack));
  const pagesFrom    = _gDate(_daysAgo(Math.min(daysBack, 120)));
  let total = 0;

  try {
    const token = await _accessToken();

    // Report A — daily channels.
    const a = await _reportWithKeyEvents(token, {
      dateRanges: [{ startDate: dateFrom, endDate: dateTo }],
      dimensions: [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }],
    }, [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'engagedSessions' }]);
    for (const r of a.rows) {
      const d = r.dimensionValues, m = r.metricValues;
      await db.query(`
        INSERT INTO marketing_ga4_daily (date, channel, sessions, total_users, engaged_sessions, key_events, synced_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (date, channel) DO UPDATE SET
          sessions = EXCLUDED.sessions, total_users = EXCLUDED.total_users,
          engaged_sessions = EXCLUDED.engaged_sessions, key_events = EXCLUDED.key_events, synced_at = NOW()
      `, [_ga4Date(d[0].value), d[1].value || '(other)', _num(m[0].value), _num(m[1].value), _num(m[2].value), _num(m[3].value)]);
    }
    total += a.rows.length;

    // Report B — daily landing pages ('landingPage' has no query string, so
    // cardinality stays sane; '(not set)' rows are app/utility hits).
    const b = await _reportWithKeyEvents(token, {
      dateRanges: [{ startDate: pagesFrom, endDate: dateTo }],
      dimensions: [{ name: 'date' }, { name: 'landingPage' }],
    }, [{ name: 'sessions' }, { name: 'engagedSessions' }]);
    for (const r of b.rows) {
      const d = r.dimensionValues, m = r.metricValues;
      await db.query(`
        INSERT INTO marketing_ga4_pages (date, landing_page, sessions, engaged_sessions, key_events, synced_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (date, landing_page) DO UPDATE SET
          sessions = EXCLUDED.sessions, engaged_sessions = EXCLUDED.engaged_sessions,
          key_events = EXCLUDED.key_events, synced_at = NOW()
      `, [_ga4Date(d[0].value), d[1].value || '(not set)', _num(m[0].value), _num(m[1].value), _num(m[2].value)]);
    }
    total += b.rows.length;

    await _recordSync(db, 'ga4', total, dateFrom, dateTo, null);
    return { ok: true, report: 'ga4', rows: total, channelsRows: a.rows.length, pagesRows: b.rows.length, keyEventMetric: a.metric, dateFrom, dateTo };
  } catch (e) {
    await _recordSync(db, 'ga4', total, dateFrom, dateTo, e.message);
    return { ok: false, report: 'ga4', rows: total, error: e.message };
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
  } catch (e) { console.warn('[ga4-etl] sync record failed:', e.message); }
}

module.exports = { envReady, missingEnvVars, syncGa4 };
