// Session & auth helpers — password sessions, OAuth sessions, CSRF state
// Host must call init({ getDb, parseCookies }) before use.

let _getDb;
let _parseCookies;

function init(deps) {
  _getDb        = deps.getDb;
  _parseCookies = deps.parseCookies;
}

// In-memory password sessions (rarely used, survive only while process runs)
const sessions    = new Set();
// Short-lived CSRF state tokens for OAuth start → callback handoff
const oauthStates = new Set();
// In-memory cache of DB-backed OAuth sessions to avoid a DB hit per request
const _sessionCache = new Map();

async function dbSessionSet(token, data) {
  const db = _getDb();
  if (!db) return;
  try {
    await db.query(
      `INSERT INTO sessions (token, email, name, owner_id, expires_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (token) DO UPDATE SET expires_at=$5`,
      [token, data.email||'', data.name||'', data.ownerId||null, new Date(data.expiresAt)]
    );
  } catch(e) { console.warn('dbSessionSet:', e.message); }
}

async function dbSessionGet(token) {
  const db = _getDb();
  if (!db) return null;
  try {
    const r = await db.query(
      'SELECT email, name, owner_id, expires_at FROM sessions WHERE token=$1 AND expires_at > NOW()',
      [token]
    );
    if (!r.rows.length) return null;
    const row = r.rows[0];
    return { email: row.email, name: row.name, ownerId: row.owner_id, expiresAt: new Date(row.expires_at).getTime() };
  } catch(e) { return null; }
}

async function dbSessionDelete(token) {
  const db = _getDb();
  if (!db) return;
  try { await db.query('DELETE FROM sessions WHERE token=$1', [token]); } catch(e) {}
}

function isAuth(req) {
  const c = _parseCookies(req);
  if (c.wr_qt_session && sessions.has(c.wr_qt_session)) return true;
  if (c.wr_oauth_session) {
    const cached = _sessionCache.get(c.wr_oauth_session);
    if (cached) {
      if (cached.expiresAt > Date.now()) return true;
      _sessionCache.delete(c.wr_oauth_session);
    }
    return _sessionCache.has(c.wr_oauth_session);
  }
  return false;
}

async function isAuthAsync(req) {
  const c = _parseCookies(req);
  if (c.wr_qt_session && sessions.has(c.wr_qt_session)) return true;
  if (c.wr_oauth_session) {
    const cached = _sessionCache.get(c.wr_oauth_session);
    if (cached && cached.expiresAt > Date.now()) return true;
    const sess = await dbSessionGet(c.wr_oauth_session);
    if (sess) { _sessionCache.set(c.wr_oauth_session, sess); return true; }
  }
  return false;
}

function getSession(req) {
  const c = _parseCookies(req);
  if (c.wr_oauth_session) {
    const cached = _sessionCache.get(c.wr_oauth_session);
    if (cached && cached.expiresAt > Date.now()) return cached;
  }
  return null;
}

async function getSessionAsync(req) {
  const c = _parseCookies(req);
  if (c.wr_oauth_session) {
    const cached = _sessionCache.get(c.wr_oauth_session);
    if (cached && cached.expiresAt > Date.now()) return cached;
    const sess = await dbSessionGet(c.wr_oauth_session);
    if (sess) { _sessionCache.set(c.wr_oauth_session, sess); return sess; }
  }
  return null;
}

// Returns ownerId string for writelog rep field, never throws.
// Accepts optional pre-parsed body so error handlers can pass ownerId directly.
function getRepFromReq(req, body) {
  try {
    const fromSession = getSession(req)?.ownerId || null;
    if (fromSession) return fromSession;
    if (body?.ownerId) return String(body.ownerId);
    return null;
  } catch(e) { return null; }
}

module.exports = {
  init,
  sessions,
  oauthStates,
  _sessionCache,
  dbSessionSet,
  dbSessionGet,
  dbSessionDelete,
  isAuth,
  isAuthAsync,
  getSession,
  getSessionAsync,
  getRepFromReq,
};
