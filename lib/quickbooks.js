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

// Diagnostic alias — returns the full query envelope including QueryResponse
async function qbQueryRaw(qoql) {
  return qbQuery(qoql);
}

async function getPreferences() {
  const { accessToken, realmId } = await getAccessToken();
  const r = await _httpsRequest({
    hostname: QB_API_HOST,
    path:     `/v3/company/${realmId}/preferences?minorversion=65`,
    method:   'GET',
    headers:  { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' },
  });
  if (r.status >= 400) throw new Error(`QB preferences (${r.status}): ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body;
}

// Fetch all open (unpaid) invoices — Balance > 0, regardless of date.
// Used by the Accounts Receivable view.
async function fetchOpenInvoices() {
  const all = [];
  let startPos = 1;
  const PAGE = 500;
  for (let page = 0; page < 40; page++) {
    const qoql = `SELECT * FROM Invoice WHERE Balance > '0' STARTPOSITION ${startPos} MAXRESULTS ${PAGE}`;
    const data = await qbQuery(qoql);
    const rows = data?.QueryResponse?.Invoice || [];
    all.push(...rows);
    if (rows.length < PAGE) break;
    startPos += PAGE;
  }
  return all;
}

// Fetch invoices in a date range, or all invoices when fromDate/toDate are null.
async function fetchInvoices(fromDate, toDate) {
  const all = [];
  let startPos = 1;
  const PAGE = 500;
  const dateClause = (fromDate && toDate)
    ? ` WHERE TxnDate >= '${fromDate}' AND TxnDate <= '${toDate}'`
    : '';
  for (let page = 0; page < 40; page++) {
    const qoql = `SELECT * FROM Invoice${dateClause} STARTPOSITION ${startPos} MAXRESULTS ${PAGE}`;
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

// In-memory caches — avoid re-querying QB for the same name within a process
const _itemCache     = new Map(); // name → { value, name } | null (null = negative cache)
const _termCache     = new Map(); // name → Term object | null
let   _defaultItemCache = null;
let   _taxCodeCache     = null;   // any active, taxable TaxCode (for TxnTaxCodeRef)
let   _taxRateCache     = null;   // any active TaxRate (for TaxRateRef in override)

async function findItemByName(name) {
  if (!name) return null;
  if (_itemCache.has(name)) return _itemCache.get(name);
  const data = await qbQuery(`SELECT * FROM Item WHERE Name = '${name.replace(/'/g, "''")}'`);
  const item = data?.QueryResponse?.Item?.[0];
  const ref  = item ? { value: item.Id, name: item.Name } : null;
  _itemCache.set(name, ref);
  return ref;
}

async function findTermByName(name) {
  if (!name) return null;
  if (_termCache.has(name)) return _termCache.get(name);
  const data = await qbQuery(`SELECT * FROM Term WHERE Name = '${name.replace(/'/g, "''")}'`);
  const term = data?.QueryResponse?.Term?.[0] || null;
  _termCache.set(name, term);
  return term;
}

async function getDefaultItem() {
  if (_defaultItemCache) return _defaultItemCache;
  const name = process.env.QB_SALES_ITEM_NAME || 'Product';
  const ref  = await findItemByName(name);
  if (!ref) throw new Error(`QB fallback item "${name}" not found — set QB_SALES_ITEM_NAME to an existing QB Item name`);
  _defaultItemCache = ref;
  return _defaultItemCache;
}

// AST companies auto-generate TaxCodes/TaxRates per jurisdiction. We just need
// any valid Active ones to attach to TxnTaxDetail when overriding the tax amount.
async function findAnyActiveTaxCode() {
  if (_taxCodeCache) return _taxCodeCache;
  const data  = await qbQuery(`SELECT * FROM TaxCode WHERE Active = true MAXRESULTS 100`);
  const codes = data?.QueryResponse?.TaxCode || [];
  const real  = codes.find(c => c.Name !== 'NON' && c.Taxable !== false) || codes[0] || null;
  if (real) _taxCodeCache = real;
  return real;
}

async function findAnyActiveTaxRate() {
  if (_taxRateCache) return _taxRateCache;
  const data = await qbQuery(`SELECT * FROM TaxRate WHERE Active = true MAXRESULTS 5`);
  const rate = data?.QueryResponse?.TaxRate?.[0] || null;
  if (rate) _taxRateCache = rate;
  return rate;
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

async function createCustomer({ displayName, givenName, familyName, email, companyName, billAddr, shipAddr }) {
  const { accessToken, realmId } = await getAccessToken();
  const payload = {
    DisplayName: displayName,
    ...(givenName   ? { GivenName:   givenName }   : {}),
    ...(familyName  ? { FamilyName:  familyName }  : {}),
    ...(companyName ? { CompanyName: companyName } : {}),
    ...(email       ? { PrimaryEmailAddr: { Address: email } } : {}),
    ...(billAddr    ? { BillAddr: billAddr } : {}),
    ...(shipAddr    ? { ShipAddr: shipAddr } : {}),
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

async function findOrCreateCustomer({ displayName, givenName, familyName, email, companyName, billAddr, shipAddr }) {
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
    givenName, familyName, email, companyName, billAddr, shipAddr,
  });
  if (!created?.Id) throw new Error('QB createCustomer returned no Id');
  return { Id: created.Id, DisplayName: created.DisplayName };
}

async function createInvoice({ customerRef, docNumber, txnDate, lines, memo, billAddr, shipAddr, billEmail, customFields, salesTermRef, globalTaxCalc, txnTaxDetail, applyTaxAfterDiscount }) {
  const { accessToken, realmId } = await getAccessToken();
  const payload = {
    CustomerRef: customerRef,
    ...(docNumber ? { DocNumber: String(docNumber).slice(0, 21) } : {}),
    TxnDate: txnDate || new Date().toISOString().split('T')[0],
    Line:    lines,
    ...(memo ? { CustomerMemo: { value: String(memo).slice(0, 1000) } } : {}),
    ...(billAddr ? { BillAddr: billAddr } : {}),
    ...(shipAddr ? { ShipAddr: shipAddr } : {}),
    ...(billEmail ? { BillEmail: { Address: String(billEmail) } } : {}),
    ...(customFields && customFields.length ? { CustomField: customFields } : {}),
    ...(salesTermRef ? { SalesTermRef: salesTermRef } : {}),
    ...(globalTaxCalc ? { GlobalTaxCalculation: globalTaxCalc } : {}),
    ...(txnTaxDetail ? { TxnTaxDetail: txnTaxDetail } : {}),
    ...(applyTaxAfterDiscount !== undefined ? { ApplyTaxAfterDiscount: !!applyTaxAfterDiscount } : {}),
  };
  const r = await _httpsRequest({
    hostname: QB_API_HOST,
    path:     `/v3/company/${realmId}/invoice?minorversion=65`,
    method:   'POST',
    headers:  { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
  }, JSON.stringify(payload));
  if (r.status >= 400) {
    console.error('[QB createInvoice] PAYLOAD SENT:', JSON.stringify(payload));
    console.error('[QB createInvoice] FULL ERROR RESPONSE:', JSON.stringify(r.body));
    throw new Error(`QB createInvoice (${r.status}): ${JSON.stringify(r.body).slice(0, 600)}`);
  }
  return r.body?.Invoice;
}

async function getInvoice(invoiceId) {
  const { accessToken, realmId } = await getAccessToken();
  const r = await _httpsRequest({
    hostname: QB_API_HOST,
    path:     `/v3/company/${realmId}/invoice/${invoiceId}?minorversion=65`,
    method:   'GET',
    headers:  { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' },
  });
  if (r.status >= 400) throw new Error(`QB getInvoice (${r.status}): ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body?.Invoice;
}

// Sparse update: pass only the fields you want to change. Fetches the invoice
// first to get SyncToken, and merges CustomField by DefinitionId so we don't
// blow away custom fields set at creation time (QB replaces arrays wholesale
// in sparse updates, so merging is required).
async function updateInvoice(invoiceId, fields) {
  const inv = await getInvoice(invoiceId);
  if (!inv) throw new Error(`QB invoice ${invoiceId} not found`);
  const finalFields = { ...fields };
  if (Array.isArray(fields.CustomField)) {
    const existing = inv.CustomField || [];
    const newIds   = new Set(fields.CustomField.map(cf => String(cf.DefinitionId)));
    finalFields.CustomField = [
      ...existing.filter(cf => !newIds.has(String(cf.DefinitionId))),
      ...fields.CustomField,
    ];
  }
  const { accessToken, realmId } = await getAccessToken();
  const payload = { Id: String(invoiceId), SyncToken: inv.SyncToken, sparse: true, ...finalFields };
  const r = await _httpsRequest({
    hostname: QB_API_HOST,
    path:     `/v3/company/${realmId}/invoice?minorversion=65`,
    method:   'POST',
    headers:  { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
  }, JSON.stringify(payload));
  if (r.status >= 400) throw new Error(`QB updateInvoice (${r.status}): ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body?.Invoice;
}

// Delete a QB invoice. Requires the current SyncToken.
// QB endpoint: POST /v3/company/{realm}/invoice?operation=delete
async function deleteInvoice(invoiceId) {
  const inv = await getInvoice(invoiceId);
  if (!inv) throw new Error(`QB invoice ${invoiceId} not found`);
  const { accessToken, realmId } = await getAccessToken();
  const payload = { Id: String(invoiceId), SyncToken: inv.SyncToken };
  const r = await _httpsRequest({
    hostname: QB_API_HOST,
    path:     `/v3/company/${realmId}/invoice?operation=delete&minorversion=65`,
    method:   'POST',
    headers:  { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
  }, JSON.stringify(payload));
  if (r.status >= 400) throw new Error(`QB deleteInvoice (${r.status}): ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body?.Invoice;
}

// ── Credit Memos ──────────────────────────────────────────────────
// Mirrors createInvoice but POSTs to /creditmemo. Used for net-negative
// order addendums (e.g. customer is owed money back for an undelivered
// upgrade). Same line structure as invoices — SalesItemLineDetail with
// positive amounts (the credit nature comes from the CreditMemo object
// type, not negative line amounts). The credit can later be applied to
// an invoice via QB's UI or the LinkedTxn field.
async function createCreditMemo({ customerRef, docNumber, txnDate, lines, memo, billAddr, shipAddr, billEmail, customFields, salesTermRef, globalTaxCalc, txnTaxDetail }) {
  const { accessToken, realmId } = await getAccessToken();
  const payload = {
    CustomerRef: customerRef,
    ...(docNumber ? { DocNumber: String(docNumber).slice(0, 21) } : {}),
    TxnDate: txnDate || new Date().toISOString().split('T')[0],
    Line:    lines,
    ...(memo ? { CustomerMemo: { value: String(memo).slice(0, 1000) } } : {}),
    ...(billAddr ? { BillAddr: billAddr } : {}),
    ...(shipAddr ? { ShipAddr: shipAddr } : {}),
    ...(billEmail ? { BillEmail: { Address: String(billEmail) } } : {}),
    ...(customFields && customFields.length ? { CustomField: customFields } : {}),
    ...(salesTermRef ? { SalesTermRef: salesTermRef } : {}),
    ...(globalTaxCalc ? { GlobalTaxCalculation: globalTaxCalc } : {}),
    ...(txnTaxDetail ? { TxnTaxDetail: txnTaxDetail } : {}),
  };
  const r = await _httpsRequest({
    hostname: QB_API_HOST,
    path:     `/v3/company/${realmId}/creditmemo?minorversion=65`,
    method:   'POST',
    headers:  { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
  }, JSON.stringify(payload));
  if (r.status >= 400) {
    console.error('[QB createCreditMemo] PAYLOAD SENT:', JSON.stringify(payload));
    console.error('[QB createCreditMemo] FULL ERROR RESPONSE:', JSON.stringify(r.body));
    throw new Error(`QB createCreditMemo (${r.status}): ${JSON.stringify(r.body).slice(0, 600)}`);
  }
  return r.body?.CreditMemo;
}

async function getCreditMemo(creditMemoId) {
  const { accessToken, realmId } = await getAccessToken();
  const r = await _httpsRequest({
    hostname: QB_API_HOST,
    path:     `/v3/company/${realmId}/creditmemo/${creditMemoId}?minorversion=65`,
    method:   'GET',
    headers:  { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' },
  });
  if (r.status >= 400) throw new Error(`QB getCreditMemo (${r.status}): ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body?.CreditMemo;
}

async function deleteCreditMemo(creditMemoId) {
  const cm = await getCreditMemo(creditMemoId);
  if (!cm) throw new Error(`QB credit memo ${creditMemoId} not found`);
  const { accessToken, realmId } = await getAccessToken();
  const payload = { Id: String(creditMemoId), SyncToken: cm.SyncToken };
  const r = await _httpsRequest({
    hostname: QB_API_HOST,
    path:     `/v3/company/${realmId}/creditmemo?operation=delete&minorversion=65`,
    method:   'POST',
    headers:  { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
  }, JSON.stringify(payload));
  if (r.status >= 400) throw new Error(`QB deleteCreditMemo (${r.status}): ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body?.CreditMemo;
}

// ── Payment methods + accounts (lookup + cache) ──────────────────
const _qbCache = { paymentMethods: new Map(), accounts: new Map() };

async function findPaymentMethodByName(name) {
  if (!name) return null;
  if (_qbCache.paymentMethods.has(name)) return _qbCache.paymentMethods.get(name);
  const safe = String(name).replace(/'/g, "\\'");
  const data = await qbQuery(`SELECT * FROM PaymentMethod WHERE Name = '${safe}' MAXRESULTS 1`);
  const pm = data?.QueryResponse?.PaymentMethod?.[0] || null;
  if (pm) _qbCache.paymentMethods.set(name, pm);
  return pm;
}

async function findAccountByName(name) {
  if (!name) return null;
  if (_qbCache.accounts.has(name)) return _qbCache.accounts.get(name);
  const safe = String(name).replace(/'/g, "\\'");
  const data = await qbQuery(`SELECT * FROM Account WHERE Name = '${safe}' MAXRESULTS 1`);
  const acct = data?.QueryResponse?.Account?.[0] || null;
  if (acct) _qbCache.accounts.set(name, acct);
  return acct;
}

// Create a Payment record applied to one invoice. Mirrors the QB
// "Receive Payment" screen.
async function createPayment({ customerRef, invoiceId, amount, paymentMethodRef, depositToAccountRef, txnDate, paymentRefNum, privateNote }) {
  const { accessToken, realmId } = await getAccessToken();
  const payload = {
    CustomerRef: customerRef,
    TotalAmt:    Number(amount),
    TxnDate:     txnDate || new Date().toISOString().split('T')[0],
    Line: [{
      Amount: Number(amount),
      LinkedTxn: [{ TxnId: String(invoiceId), TxnType: 'Invoice' }],
    }],
    ...(paymentMethodRef    ? { PaymentMethodRef:    paymentMethodRef    } : {}),
    ...(depositToAccountRef ? { DepositToAccountRef: depositToAccountRef } : {}),
    ...(paymentRefNum       ? { PaymentRefNum:       String(paymentRefNum).slice(0, 21) } : {}),
    ...(privateNote         ? { PrivateNote:         String(privateNote).slice(0, 4000) } : {}),
  };
  const r = await _httpsRequest({
    hostname: QB_API_HOST,
    path:     `/v3/company/${realmId}/payment?minorversion=65`,
    method:   'POST',
    headers:  { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
  }, JSON.stringify(payload));
  if (r.status >= 400) {
    console.error('[QB createPayment] PAYLOAD SENT:', JSON.stringify(payload));
    console.error('[QB createPayment] FULL ERROR RESPONSE:', JSON.stringify(r.body));
    throw new Error(`QB createPayment (${r.status}): ${JSON.stringify(r.body).slice(0, 600)}`);
  }
  return r.body?.Payment;
}

// Fetch a single QB Payment by Id (for SyncToken on delete).
async function getPayment(paymentId) {
  const { accessToken, realmId } = await getAccessToken();
  const r = await _httpsRequest({
    hostname: QB_API_HOST,
    path:     `/v3/company/${realmId}/payment/${paymentId}?minorversion=65`,
    method:   'GET',
    headers:  { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/json' },
  });
  if (r.status === 404) return null;
  if (r.status >= 400) throw new Error(`QB getPayment (${r.status}): ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body?.Payment;
}

// Delete a QB Payment. Mirrors deleteInvoice — fetch for SyncToken, then
// POST operation=delete. Returns the deleted Payment stub on success, or
// null if the payment was already gone (404 on fetch).
async function deletePayment(paymentId) {
  const pmt = await getPayment(paymentId);
  if (!pmt) return null;
  const { accessToken, realmId } = await getAccessToken();
  const payload = { Id: String(paymentId), SyncToken: pmt.SyncToken };
  const r = await _httpsRequest({
    hostname: QB_API_HOST,
    path:     `/v3/company/${realmId}/payment?operation=delete&minorversion=65`,
    method:   'POST',
    headers:  { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
  }, JSON.stringify(payload));
  if (r.status >= 400) throw new Error(`QB deletePayment (${r.status}): ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body?.Payment;
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

// ── Reports API ──────────────────────────────────────────────────
// Generic wrapper around QB's /reports/<ReportName> endpoint. Returns
// the raw report JSON (Header / Columns / Rows tree). Use a specific
// helper below (fetchExpensesByVendorSummary, etc.) rather than calling
// this directly, so call sites stay readable.
async function fetchReport(reportName, params = {}) {
  const { accessToken, realmId } = await getAccessToken();
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  });
  qs.set('minorversion', '65');
  const r = await _httpsRequest({
    hostname: QB_API_HOST,
    path:     `/v3/company/${realmId}/reports/${reportName}?${qs}`,
    method:   'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept':        'application/json',
    },
  });
  if (r.status >= 400) {
    throw new Error(`QB report ${reportName} (${r.status}): ${JSON.stringify(r.body).slice(0, 400)}`);
  }
  return r.body;
}

// Sum of expenses (Bills + Cash purchases + Credit-card purchases, minus
// vendor credits) grouped by vendor, between startDate and endDate
// (YYYY-MM-DD, inclusive). QB Online's API renamed this report from
// `ExpensesByVendorSummary` → `VendorExpenses` — using the old name now
// returns a misleading "Permission Denied" (5020) instead of 404.
// accountingMethod = 'Accrual' (default) or 'Cash'.
async function fetchExpensesByVendorSummary({ startDate, endDate, accountingMethod = 'Accrual' } = {}) {
  return fetchReport('VendorExpenses', {
    start_date:        startDate,
    end_date:          endDate,
    accounting_method: accountingMethod,
  });
}

// Per-vendor transaction-level detail for the same date range. Used by
// the supplier-spend drilldown — click vendor → list every Bill/Purchase
// that rolled up into that vendor's total. `TransactionListByVendor` is
// QB's dedicated report for this (vs. the generic `TransactionList`).
async function fetchExpensesByVendorDetail({ startDate, endDate, vendorId, accountingMethod = 'Accrual' } = {}) {
  return fetchReport('TransactionListByVendor', {
    start_date:        startDate,
    end_date:          endDate,
    accounting_method: accountingMethod,
    ...(vendorId ? { vendor: vendorId } : {}),
  });
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
  fetchOpenInvoices,
  fetchCreditMemos,
  fetchRefundReceipts,
  fetchPayments,
  getStatus,
  getCompanyInfo,
  getDefaultItem,
  findItemByName,
  findTermByName,
  findAnyActiveTaxCode,
  findAnyActiveTaxRate,
  findCustomerByDisplayName,
  findOrCreateCustomer,
  fetchReport,
  fetchExpensesByVendorSummary,
  fetchExpensesByVendorDetail,
  createInvoice,
  getInvoice,
  updateInvoice,
  deleteInvoice,
  createCreditMemo,
  getCreditMemo,
  deleteCreditMemo,
  getPayment,
  deletePayment,
  findPaymentMethodByName,
  findAccountByName,
  createPayment,
  qbQueryRaw,
  getPreferences,
};
