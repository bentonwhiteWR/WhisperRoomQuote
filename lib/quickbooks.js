// QuickBooks Online OAuth 2.0 + API client
// Call init({ getDb }) once at server startup.

const https  = require('https');
const crypto = require('crypto');

const QB_CLIENT_ID     = process.env.QB_CLIENT_ID     || '';
const QB_CLIENT_SECRET = process.env.QB_CLIENT_SECRET || '';
const QB_SCOPE         = 'com.intuit.quickbooks.accounting';
const QB_AUTH_HOST     = 'appcenter.intuit.com';
const QB_AUTH_PATH     = '/connect/oauth2';
const QB_TOKEN_HOST    = 'oauth.platform.intuit.com';
const QB_TOKEN_PATH    = '/oauth2/v1/tokens/bearer';
const QB_API_HOST      = 'quickbooks.api.intuit.com';

// CSRF state store (in-memory, short-lived — only used during the OAuth redirect round-trip)
const _pendingStates = new Map(); // state → { redirectUri, ts }

let _getDb;
function init(deps) { _getDb = deps.getDb; }

// ── OAuth ─────────────────────────────────────────────────────────

function getAuthUrl(redirectUri) {
  const state = crypto.randomBytes(16).toString('hex');
  _pendingStates.set(state, { redirectUri, ts: Date.now() });
  // Expire states older than 10 minutes
  for (const [k, v] of _pendingStates) {
    if (Date.now() - v.ts > 600_000) _pendingStates.delete(k);
  }
  const params = new URLSearchParams({
    client_id:     QB_CLIENT_ID,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         QB_SCOPE,
    state,
  });
  return `https://${QB_AUTH_HOST}${QB_AUTH_PATH}?${params}`;
}

async function exchangeCode(code, state) {
  const pending = _pendingStates.get(state);
  if (!pending) throw new Error('Invalid or expired OAuth state');
  _pendingStates.delete(state);

  const body = new URLSearchParams({
    grant_type:   'authorization_code',
    code,
    redirect_uri: pending.redirectUri,
  }).toString();

  const r = await _tokenRequest(body);
  if (r.status >= 400) throw new Error(`QB token exchange failed (${r.status}): ${JSON.stringify(r.body)}`);
  return { tokens: r.body, redirectUri: pending.redirectUri };
}

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken,
  }).toString();
  const r = await _tokenRequest(body);
  if (r.status >= 400) throw new Error(`QB token refresh failed (${r.status}): ${JSON.stringify(r.body)}`);
  return r.body;
}

function _tokenRequest(body) {
  const auth = Buffer.from(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`).toString('base64');
  return _httpsRequest({
    hostname: QB_TOKEN_HOST,
    path:     QB_TOKEN_PATH,
    method:   'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type':  'application/x-www-form-urlencoded',
      'Accept':        'application/json',
    },
  }, body);
}

// ── Token persistence (kv_store table) ───────────────────────────

async function saveTokens({ realmId, accessToken, refreshToken, accessExpiresAt, refreshExpiresAt }) {
  const db = _getDb();
  if (!db) throw new Error('No DB');
  await db.query(
    `INSERT INTO kv_store (key, value) VALUES ('qb_tokens', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [JSON.stringify({ realmId, accessToken, refreshToken, accessExpiresAt, refreshExpiresAt })]
  );
}

async function getTokens() {
  const db = _getDb();
  if (!db) return null;
  const r = await db.query(`SELECT value FROM kv_store WHERE key = 'qb_tokens' LIMIT 1`);
  return r.rows.length ? JSON.parse(r.rows[0].value) : null;
}

async function clearTokens() {
  const db = _getDb();
  if (!db) return;
  await db.query(`DELETE FROM kv_store WHERE key = 'qb_tokens'`);
}

// Returns { accessToken, realmId }, refreshing if needed
async function getAccessToken() {
  const tokens = await getTokens();
  if (!tokens) throw new Error('QuickBooks not connected');

  const now = Date.now();

  if (tokens.refreshExpiresAt && now > tokens.refreshExpiresAt) {
    await clearTokens();
    throw new Error('QuickBooks refresh token expired — please reconnect');
  }

  // Refresh if access token expires in <5 minutes
  if (!tokens.accessExpiresAt || now > tokens.accessExpiresAt - 300_000) {
    const fresh = await refreshAccessToken(tokens.refreshToken);
    const updated = {
      realmId:          tokens.realmId,
      accessToken:      fresh.access_token,
      refreshToken:     fresh.refresh_token || tokens.refreshToken,
      accessExpiresAt:  now + (fresh.expires_in                  || 3600)    * 1000,
      refreshExpiresAt: now + (fresh.x_refresh_token_expires_in  || 8726400) * 1000,
    };
    await saveTokens(updated);
    return { accessToken: updated.accessToken, realmId: updated.realmId };
  }

  return { accessToken: tokens.accessToken, realmId: tokens.realmId };
}

// ── QB Query API ──────────────────────────────────────────────────

async function qbQuery(qoql) {
  const { accessToken, realmId } = await getAccessToken();
  const r = await _httpsRequest({
    hostname: QB_API_HOST,
    path:     `/v3/company/${realmId}/query?query=${encodeURIComponent(qoql)}&minorversion=65`,
    method:   'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept':        'application/json',
    },
  });
  if (r.status >= 400) throw new Error(`QB API ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body;
}

// Fetch all invoices in a date range (handles QB's 1000-row page limit)
async function fetchInvoices(fromDate, toDate) {
  const all = [];
  let startPos = 1;
  const PAGE = 500;
  for (let page = 0; page < 20; page++) {
    const qoql = `SELECT * FROM Invoice WHERE TxnDate >= '${fromDate}' AND TxnDate <= '${toDate}' STARTPOSITION ${startPos} MAXRESULTS ${PAGE}`;
    const data = await qbQuery(qoql);
    const rows = data?.QueryResponse?.Invoice || [];
    all.push(...rows);
    if (rows.length < PAGE) break;
    startPos += PAGE;
  }
  return all;
}

// Fetch all payments in a date range (for matching against QB invoices)
async function fetchPayments(fromDate, toDate) {
  const all = [];
  let startPos = 1;
  const PAGE = 500;
  for (let page = 0; page < 20; page++) {
    const qoql = `SELECT * FROM Payment WHERE TxnDate >= '${fromDate}' AND TxnDate <= '${toDate}' STARTPOSITION ${startPos} MAXRESULTS ${PAGE}`;
    const data = await qbQuery(qoql);
    const rows = data?.QueryResponse?.Payment || [];
    all.push(...rows);
    if (rows.length < PAGE) break;
    startPos += PAGE;
  }
  return all;
}

async function fetchCreditMemos(fromDate, toDate) {
  const all = [];
  let startPos = 1;
  const PAGE = 500;
  for (let page = 0; page < 20; page++) {
    const qoql = `SELECT * FROM CreditMemo WHERE TxnDate >= '${fromDate}' AND TxnDate <= '${toDate}' STARTPOSITION ${startPos} MAXRESULTS ${PAGE}`;
    const data = await qbQuery(qoql);
    const rows = data?.QueryResponse?.CreditMemo || [];
    all.push(...rows);
    if (rows.length < PAGE) break;
    startPos += PAGE;
  }
  return all;
}

async function fetchRefundReceipts(fromDate, toDate) {
  const all = [];
  let startPos = 1;
  const PAGE = 500;
  for (let page = 0; page < 20; page++) {
    const qoql = `SELECT * FROM RefundReceipt WHERE TxnDate >= '${fromDate}' AND TxnDate <= '${toDate}' STARTPOSITION ${startPos} MAXRESULTS ${PAGE}`;
    const data = await qbQuery(qoql);
    const rows = data?.QueryResponse?.RefundReceipt || [];
    all.push(...rows);
    if (rows.length < PAGE) break;
    startPos += PAGE;
  }
  return all;
}



// ── QB Write API ──────────────────────────────────────────────────

// In-memory cache for the default QB sales item — avoids a query on every order
let _defaultItemCache = null;

async function getDefaultItem() {
  if (_defaultItemCache) return _defaultItemCache;
  const name = process.env.QB_SALES_ITEM_NAME || 'Non-Inventory';
  const data = await qbQuery(`SELECT * FROM Item WHERE Name = '${name.replace(/'/g, "''")}'`);
  const item  = data?.QueryResponse?.Item?.[0];
  if (!item) throw new Error(`QB item "${name}" not found — set QB_SALES_ITEM_NAME to a valid QB Item name`);
  _defaultItemCache = { value: item.Id, name: item.Name };
  return _defaultItemCache;
}

async function findCustomerByEmail(email) {
  if (!email) return null;
  const data = await qbQuery(`SELECT * FROM Customer WHERE PrimaryEmailAddr = '${email.replace(/'/g, "''")}'`);
  return data?.QueryResponse?.Customer?.[0] || null;
}

async function findCustomerByDisplayName(displayName) {
  const data = await qbQuery(`SELECT * FROM Customer WHERE DisplayName = '${displayName.replace(/'/g, "''")}'`);
  return data?.QueryResponse?.Customer?.[0] || null;
}

async function createCustomer({ displayName, givenName, familyName, email, companyName }) {
  const { accessToken, realmId } = await getAccessToken();
  const payload = {
    DisplayName: displayName,
    ...(givenName   ? { GivenName:   givenName }   : {}),
    ...(familyName  ? { FamilyName:  familyName }  : {}),
    ...(companyName ? { CompanyName: companyName } : {}),
    ...(email       ? { PrimaryEmailAddr: { Address: email } } : {}),
  };
  const r = await _httpsRequest({
    hostname: QB_API_HOST,
    path:     `/v3/company/${realmId}/customer?minorversion=65`,
    method:   'POST',
    headers:  { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
  }, JSON.stringify(payload));
  if (r.status >= 400) throw new Error(`QB createCustomer (${r.status}): ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body?.Customer;
}

async function findOrCreateCustomer({ displayName, givenName, familyName, email, companyName }) {
  if (email) {
    const c = await findCustomerByEmail(email);
    if (c) return { Id: c.Id, DisplayName: c.DisplayName };
  }
  if (displayName) {
    const c = await findCustomerByDisplayName(displayName);
    if (c) return { Id: c.Id, DisplayName: c.DisplayName };
  }
  const created = await createCustomer({
    displayName: displayName || email || 'Unknown Customer',
    givenName, familyName, email, companyName,
  });
  if (!created?.Id) throw new Error('QB createCustomer returned no Id');
  return { Id: created.Id, DisplayName: created.DisplayName };
}

async function createInvoice({ customerRef, docNumber, txnDate, lines, memo }) {
  const { accessToken, realmId } = await getAccessToken();
  const payload = {
    CustomerRef: customerRef,
    ...(docNumber ? { DocNumber: String(docNumber).slice(0, 21) } : {}),
    TxnDate: txnDate || new Date().toISOString().split('T')[0],
    Line:    lines,
    ...(memo ? { CustomerMemo: { value: String(memo).slice(0, 1000) } } : {}),
  };
  const r = await _httpsRequest({
    hostname: QB_API_HOST,
    path:     `/v3/company/${realmId}/invoice?minorversion=65`,
    method:   'POST',
    headers:  { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
  }, JSON.stringify(payload));
  if (r.status >= 400) throw new Error(`QB createInvoice (${r.status}): ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body?.Invoice;
}

function _httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch  { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.setTimeout(20_000, () => { req.destroy(); reject(new Error('QB request timeout')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Connection status ─────────────────────────────────────────────

async function getStatus() {
  const tokens = await getTokens();
  if (!tokens) return { connected: false };
  const now = Date.now();
  return {
    connected:        true,
    realmId:          tokens.realmId,
    accessExpiresAt:  tokens.accessExpiresAt,
    refreshExpiresAt: tokens.refreshExpiresAt,
    accessExpired:    tokens.accessExpiresAt  ? now > tokens.accessExpiresAt  : false,
    refreshExpired:   tokens.refreshExpiresAt ? now > tokens.refreshExpiresAt : false,
  };
}

// Quick diagnostic: fetch CompanyInfo (smallest API call possible)
async function getCompanyInfo() {
  const { accessToken, realmId } = await getAccessToken();
  const r = await _httpsRequest({
    hostname: QB_API_HOST,
    path:     `/v3/company/${realmId}/companyinfo/${realmId}?minorversion=65`,
    method:   'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept':        'application/json',
    },
  });
  return { status: r.status, body: r.body, realmId };
}

module.exports = {
  init,
  getAuthUrl,
  exchangeCode,
  saveTokens,
  getTokens,
  clearTokens,
  getAccessToken,
  fetchInvoices,
  fetchCreditMemos,
  fetchRefundReceipts,
  fetchPayments,
  getStatus,
  getCompanyInfo,
  getDefaultItem,
  findOrCreateCustomer,
  createInvoice,
};
