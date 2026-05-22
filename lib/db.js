// DB schema init + quote-row CRUD + quote-number generator
// Host must call init({ getDb, publicBaseUrl, onAfterInit }) before use.
//
// - getDb: () => pg.Pool | null   (lazy getter for the pool)
// - publicBaseUrl: base URL for saved quote_link column (defaults to prod)
// - onAfterInit: async fn called once migrations succeed (used to kick off
//                tracking cache + poller, which live in lib/freight)

const crypto = require('crypto');

let _getDb;
let _publicBaseUrl = 'https://sales.whisperroom.com';
let _onAfterInit = null;

function init(deps) {
  _getDb         = deps.getDb;
  if (deps.publicBaseUrl) _publicBaseUrl = deps.publicBaseUrl.replace(/\/+$/, '');
  if (deps.onAfterInit)   _onAfterInit   = deps.onAfterInit;
}

// Rep-ID → numeric prefix used in quote numbers (W-RRMMDDYYSS)
const SERVER_REP_NUMBERS = {
  '36303670':  '16', // Benton White
  '38732178':  '17', // Kim Dalton
  '36330944':  '11', // Jill Holdway
  '38143901':  '18', // Sarah Smith
  '117442978': '13', // Travis Singleton
  '36320208':  '19', // Gabe White
};

async function initDb() {
  const db = _getDb();
  if (!db) {
    console.log('DB init skipped (no pool)');
    return;
  }
  try {
    await db.query(`ALTER TABLE quotes ADD COLUMN IF NOT EXISTS payment_link  TEXT`).catch(() => {});
    await db.query(`ALTER TABLE quotes ADD COLUMN IF NOT EXISTS order_link    TEXT`).catch(() => {});
    await db.query(`ALTER TABLE quotes ADD COLUMN IF NOT EXISTS share_token      TEXT`).catch(() => {});
    await db.query(`ALTER TABLE quotes ADD COLUMN IF NOT EXISTS gdrive_folder_id TEXT`).catch(() => {});

    await db.query(`
      CREATE TABLE IF NOT EXISTS quotes (
        id            SERIAL PRIMARY KEY,
        quote_number  TEXT UNIQUE NOT NULL,
        deal_id       TEXT,
        contact_id    TEXT,
        deal_name     TEXT,
        customer_name TEXT,
        company       TEXT,
        rep_id        TEXT,
        total         NUMERIC(12,2),
        date          TEXT,
        quote_link    TEXT,
        json_snapshot JSONB NOT NULL,
        payment_link  TEXT,
        order_link    TEXT,
        share_token      TEXT,
        gdrive_folder_id TEXT,
        created_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_quotes_quote_number ON quotes(quote_number)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_quotes_deal_id      ON quotes(deal_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_quotes_contact_id   ON quotes(contact_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_quotes_rep_id       ON quotes(rep_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_quotes_created_at   ON quotes(created_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_quotes_company      ON quotes(lower(company))`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_quotes_customer_name ON quotes(lower(customer_name))`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        token      TEXT PRIMARY KEY,
        email      TEXT,
        name       TEXT,
        owner_id   TEXT,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(()=>{});
    await db.query(`CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`).catch(()=>{});
    await db.query(`DELETE FROM sessions WHERE expires_at < NOW()`).catch(()=>{});

    await db.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id         SERIAL PRIMARY KEY,
        owner_id   TEXT NOT NULL,
        type       TEXT NOT NULL,
        title      TEXT NOT NULL,
        body       TEXT,
        deal_id    TEXT,
        deal_name  TEXT,
        quote_num  TEXT,
        read       BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(()=>{});
    await db.query(`CREATE INDEX IF NOT EXISTS idx_notif_owner ON notifications(owner_id, read, created_at DESC)`).catch(()=>{});

    await db.query(`
      CREATE TABLE IF NOT EXISTS logs (
        id        SERIAL PRIMARY KEY,
        at        TIMESTAMPTZ DEFAULT NOW(),
        level     TEXT NOT NULL DEFAULT 'info',
        event     TEXT NOT NULL,
        rep       TEXT,
        quote_num TEXT,
        deal_id   TEXT,
        deal_name TEXT,
        message   TEXT NOT NULL,
        meta      JSONB
      )
    `).catch(()=>{});
    await db.query(`CREATE INDEX IF NOT EXISTS idx_logs_at    ON logs(at DESC)`).catch(()=>{});
    await db.query(`CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level, at DESC)`).catch(()=>{});
    await db.query(`CREATE INDEX IF NOT EXISTS idx_logs_event ON logs(event, at DESC)`).catch(()=>{});

    // `version` column was added later — ensure it exists
    await db.query(`ALTER TABLE logs ADD COLUMN IF NOT EXISTS version TEXT`).catch(() => {});

    await db.query(`
      CREATE TABLE IF NOT EXISTS kv_store (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    await db.query(`
      CREATE TABLE IF NOT EXISTS reconcile_links (
        id            SERIAL PRIMARY KEY,
        hs_deal_id    TEXT NOT NULL,
        qb_invoice_id TEXT NOT NULL,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(hs_deal_id, qb_invoice_id)
      )
    `).catch(() => {});

    // Migrate older deployments that had UNIQUE(hs_deal_id) only — that
    // constraint blocks linking one HS deal to multiple QB invoices.
    await db.query(`ALTER TABLE reconcile_links DROP CONSTRAINT IF EXISTS reconcile_links_hs_deal_id_key`).catch(() => {});
    await db.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'reconcile_links_hs_deal_id_qb_invoice_id_key'
        ) THEN
          ALTER TABLE reconcile_links
            ADD CONSTRAINT reconcile_links_hs_deal_id_qb_invoice_id_key
            UNIQUE (hs_deal_id, qb_invoice_id);
        END IF;
      END $$;
    `).catch(() => {});

    await db.query(`
      CREATE TABLE IF NOT EXISTS reconcile_blocks (
        hs_deal_id    TEXT NOT NULL,
        qb_invoice_id TEXT NOT NULL,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (hs_deal_id, qb_invoice_id)
      )
    `).catch(() => {});

    await db.query(`
      CREATE TABLE IF NOT EXISTS supplier_pos (
        id                 SERIAL PRIMARY KEY,
        po_number          TEXT UNIQUE NOT NULL,
        quote_number       TEXT NOT NULL,
        deal_id            TEXT,
        deal_name          TEXT,
        supplier           TEXT NOT NULL DEFAULT 'audimute',
        supplier_email     TEXT NOT NULL,
        share_token        TEXT UNIQUE NOT NULL,
        status             TEXT NOT NULL DEFAULT 'pending',
        po_data            JSONB,
        sent_at            TIMESTAMPTZ,
        expected_ship_date DATE,
        tracking_number    TEXT,
        shipped_at         TIMESTAMPTZ,
        notes              TEXT,
        created_by         TEXT,
        created_at         TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});
    await db.query(`CREATE INDEX IF NOT EXISTS idx_supplier_pos_quote ON supplier_pos(quote_number)`).catch(() => {});
    await db.query(`CREATE INDEX IF NOT EXISTS idx_supplier_pos_status ON supplier_pos(status, created_at DESC)`).catch(() => {});
    // Stamped once the overdue-ship-date sweep has fired a notification
    // for a given PO so we don't re-notify on every sweep cycle. Set
    // back to NULL when the rep saves a new expected_ship_date (handled
    // in the PATCH endpoint).
    await db.query(`ALTER TABLE supplier_pos ADD COLUMN IF NOT EXISTS overdue_notified_at TIMESTAMPTZ`).catch(() => {});

    // Per-deal payment state mirrored from HubSpot Commerce Payments.
    // Populated by the existing invoice-paid webhook (instant on the happy
    // path) AND by a 30-min polling sync (catches everything else: ACH
    // pending updates, failed/fraudulent payments, missed webhooks).
    // Drives the deal-card payment chip and the Process Order soft warning
    // for "ACH still clearing" cases. estimated_payout_date comes straight
    // from HubSpot's `hs_estimated_payout_date` — we don't compute the
    // 3-vs-4-weekday math ourselves, HubSpot already does.
    await db.query(`
      CREATE TABLE IF NOT EXISTS deal_payment_status (
        deal_id                TEXT PRIMARY KEY,
        hs_invoice_id          TEXT,
        hs_payment_id          TEXT,
        payment_method         TEXT,
        bank_or_issuer         TEXT,
        last_4                 TEXT,
        amount                 NUMERIC,
        initiated_at           TIMESTAMPTZ,
        estimated_payout_date  DATE,
        latest_status          TEXT,
        latest_status_at       TIMESTAMPTZ,
        cleared_notified_at    TIMESTAMPTZ,
        failed_notified_at     TIMESTAMPTZ,
        updated_at             TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});
    await db.query(`CREATE INDEX IF NOT EXISTS idx_dps_status_payout ON deal_payment_status(latest_status, estimated_payout_date)`).catch(() => {});
    await db.query(`CREATE INDEX IF NOT EXISTS idx_dps_invoice ON deal_payment_status(hs_invoice_id)`).catch(() => {});

    // Tracks Shopify-parts deals (ecommerce-owned, <$5k) that have been
    // QB-invoiced. Two write paths:
    //   - POST /api/shopify-parts/create-invoice (mode='auto') — actually
    //     creates a QB invoice + payment and stores the IDs
    //   - POST /api/shopify-parts/mark-already-invoiced (mode='backfill') —
    //     Kim used to invoice these manually; this records that she's
    //     already handled it so the auto button hides. qb_invoice_id is
    //     NULL on backfill rows.
    // Presence of a row (any mode) = "do not show the auto button".
    await db.query(`
      CREATE TABLE IF NOT EXISTS shopify_qb_invoices (
        deal_id        TEXT PRIMARY KEY,
        qb_invoice_id  TEXT,
        qb_doc_number  TEXT,
        qb_payment_id  TEXT,
        total_amount   NUMERIC,
        mode           TEXT NOT NULL DEFAULT 'auto',
        created_by     TEXT,
        created_at     TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    // Every call to /api/email-reply logs here so we can review what the
    // model produced vs. what reps actually sent. v1 is logging + viewer
    // only — feedback capture (thumbs up/down, edited final) is v2.
    await db.query(`
      CREATE TABLE IF NOT EXISTS email_reply_logs (
        id                    SERIAL PRIMARY KEY,
        created_at            TIMESTAMPTZ DEFAULT NOW(),
        rep_id                TEXT,
        rep_name              TEXT,
        rep_email             TEXT,
        voice                 TEXT,
        input                 TEXT NOT NULL,
        output                TEXT,
        model                 TEXT,
        input_tokens          INTEGER,
        output_tokens         INTEGER,
        cache_read_tokens     INTEGER,
        cache_creation_tokens INTEGER,
        duration_ms           INTEGER,
        status                TEXT,
        error                 TEXT
      )
    `).catch(() => {});
    await db.query(`CREATE INDEX IF NOT EXISTS idx_email_reply_logs_created ON email_reply_logs (created_at DESC)`).catch(() => {});

    console.log('Database ready');
    if (_onAfterInit) await _onAfterInit();

    // Clean expired sessions every hour
    setInterval(async () => {
      const d = _getDb(); if (!d) return;
      try { await d.query('DELETE FROM sessions WHERE expires_at < NOW()'); } catch(e) {}
    }, 3600000);

    // Backfill missing share tokens for any old quotes
    try {
      const missing = await db.query(
        `SELECT id FROM quotes WHERE share_token IS NULL OR share_token = ''`
      );
      if (missing.rows.length > 0) {
        for (const row of missing.rows) {
          const tok = crypto.randomBytes(6).toString('hex');
          await db.query(`UPDATE quotes SET share_token = $1 WHERE id = $2`, [tok, row.id]);
        }
        console.log(`[startup] backfilled share tokens for ${missing.rows.length} quotes`);
      }
    } catch(e) { console.warn('[startup] token backfill error:', e.message); }
  } catch(e) {
    console.warn('DB init skipped (no DATABASE_URL?):', e.message);
  }
}

async function generateFreeQuoteNumber(clientNumber, ownerId, dealId, contactId) {
  const db = _getDb();
  if (!db) return clientNumber;
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const yy = String(now.getFullYear()).slice(-2);
  const repNum = SERVER_REP_NUMBERS[String(ownerId)] || '00';
  const dateKey = repNum + mm + dd + yy;

  // Format is W-{8-char dateKey}{seq}. Slice off the dateKey portion instead
  // of regex-matching trailing digits — greedy trailing-digit matches grab
  // part of the year when seq is only 2 digits (e.g. "W-1604162626" → seq=626
  // instead of 26). Also robust to TZ mismatches where client's dateKey
  // differs from server's.
  //
  // Only seed from clientNumber's seq when its dateKey matches today's.
  // When a rep revises a previous-day quote (e.g. loads W-1605122602 and
  // changes the price), the loaded quote's seq has nothing to do with
  // today's sequence counter — it belongs to yesterday's dateKey. Seeding
  // from it makes today's first new quote land at seq=02 instead of 01
  // (W-1605132602 instead of W-1605132601). previewNextQuoteNumber below
  // already handles this correctly (always starts at 1).
  let seq = 1;
  if (clientNumber) {
    const digits = String(clientNumber).replace(/^W-/, '');
    if (digits.length > 8 && digits.slice(0, 8) === dateKey) {
      const parsed = parseInt(digits.slice(8));
      if (!isNaN(parsed) && parsed > 0) seq = parsed;
    }
  }

  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = `W-${dateKey}${String(seq).padStart(2, '0')}`;
    const existing = await db.query(
      `SELECT deal_id, contact_id FROM quotes WHERE quote_number = $1 LIMIT 1`,
      [candidate]
    );
    if (existing.rows.length === 0) return candidate;
    const ex = existing.rows[0];
    const sameDeal = dealId && ex.deal_id && ex.deal_id === dealId;
    if (sameDeal) return candidate;
    seq++;
  }
  for (let attempt = 0; attempt < 80; attempt++) {
    const candidate = `W-${dateKey}${String(seq).padStart(2, '0')}`;
    const existing = await db.query(
      `SELECT deal_id, contact_id FROM quotes WHERE quote_number = $1 LIMIT 1`,
      [candidate]
    );
    if (existing.rows.length === 0) return candidate;
    const ex = existing.rows[0];
    const sameDeal = dealId && ex.deal_id && ex.deal_id === dealId;
    if (sameDeal) return candidate;
    seq++;
  }
  return `W-${dateKey}${String(seq).padStart(2, '0')}`;
}

// Dry-run version of generateFreeQuoteNumber: returns the next slot without
// reserving it. Used by /api/quote-number/preview so the rep can see what
// number their next quote will get before they submit.
async function previewNextQuoteNumber(ownerId, dealId) {
  const db = _getDb();
  if (!db) return null;
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const yy = String(now.getFullYear()).slice(-2);
  const repNum = SERVER_REP_NUMBERS[String(ownerId)] || '00';
  const dateKey = repNum + mm + dd + yy;
  let seq = 1;
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = `W-${dateKey}${String(seq).padStart(2, '0')}`;
    const existing = await db.query(
      `SELECT deal_id FROM quotes WHERE quote_number = $1 LIMIT 1`,
      [candidate]
    );
    if (existing.rows.length === 0) return candidate;
    const ex = existing.rows[0];
    if (dealId && ex.deal_id && ex.deal_id === dealId) return candidate;
    seq++;
  }
  return `W-${dateKey}${String(seq).padStart(2, '0')}`;
}

async function saveQuoteToDb(quoteData) {
  const db = _getDb();
  if (!db || !process.env.DATABASE_URL) return null;
  try {
    const { quoteNumber, dealId, contactId, dealName, customer, total, date, ownerId } = quoteData;
    const customerName = customer ? [customer.firstName, customer.lastName].filter(Boolean).join(' ') : '';
    const company = customer ? (customer.company || '') : '';
    const quoteLink = quoteNumber ? `${_publicBaseUrl}/q/${quoteNumber}` : null;

    if (quoteNumber) {
      const existing = await db.query(
        `SELECT deal_id, contact_id, customer_name FROM quotes WHERE quote_number = $1 LIMIT 1`,
        [quoteNumber]
      );
      if (existing.rows.length > 0) {
        const ex = existing.rows[0];
        const sameDeal = dealId && ex.deal_id && ex.deal_id === dealId;
        if (!sameDeal) {
          console.error(`[saveQuoteToDb] COLLISION: quote ${quoteNumber} already exists for "${ex.customer_name}" (deal ${ex.deal_id}). Rejecting save.`);
          throw new Error(`Quote number ${quoteNumber} already exists for a different customer. Please refresh and push again to get a new number.`);
        }
      }
    }

    const res = await db.query(`
      INSERT INTO quotes
        (quote_number, deal_id, contact_id, deal_name, customer_name, company, rep_id, total, date, quote_link, json_snapshot, share_token)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (quote_number) DO UPDATE SET
        deal_id       = EXCLUDED.deal_id,
        contact_id    = EXCLUDED.contact_id,
        deal_name     = EXCLUDED.deal_name,
        customer_name = EXCLUDED.customer_name,
        company       = EXCLUDED.company,
        rep_id        = EXCLUDED.rep_id,
        total         = EXCLUDED.total,
        date          = EXCLUDED.date,
        quote_link    = EXCLUDED.quote_link,
        payment_link  = COALESCE(EXCLUDED.payment_link, quotes.payment_link),
        order_link    = COALESCE(EXCLUDED.order_link, quotes.order_link),
        share_token   = COALESCE(quotes.share_token, EXCLUDED.share_token),
        json_snapshot = EXCLUDED.json_snapshot
      RETURNING id
    `, (() => {
      const { shareToken: _s1, _shareToken: _s2, ...snapData } = quoteData;
      return [
        quoteNumber, dealId || null, contactId || null, dealName || null,
        customerName, company, ownerId || null,
        total ? parseFloat(total) : null,
        date || null, quoteLink, JSON.stringify(snapData),
        quoteData.shareToken || crypto.randomBytes(6).toString('hex')
      ];
    })());

    return res.rows[0]?.id;
  } catch(e) {
    console.warn('DB save failed:', e.message);
    return null;
  }
}

async function getQuoteFromDb(quoteNumber) {
  const db = _getDb();
  if (!db || !process.env.DATABASE_URL) return null;
  try {
    const res = await db.query(
      'SELECT json_snapshot, share_token, deal_id FROM quotes WHERE quote_number = $1',
      [quoteNumber]
    );
    if (res.rows.length === 0 || !res.rows[0]) return null;
    const snap = res.rows[0].json_snapshot || {};
    snap._shareToken = res.rows[0].share_token;
    if (res.rows[0].deal_id && !snap.dealId) snap.dealId = res.rows[0].deal_id;
    return snap;
  } catch(e) {
    console.warn('DB get failed:', e.message);
    return null;
  }
}

async function searchQuotesInDb(query, repId, limit = 100, offset = 0) {
  const db = _getDb();
  if (!db || !process.env.DATABASE_URL) return null;
  try {
    let where = 'WHERE 1=1';
    const params = [];
    let p = 1;

    if (query) {
      params.push(`%${query.toLowerCase()}%`);
      where += ` AND (lower(customer_name) LIKE $${p} OR lower(company) LIKE $${p} OR lower(deal_name) LIKE $${p} OR quote_number LIKE $${p})`;
      p++;
    }
    if (repId) {
      params.push(repId);
      where += ` AND rep_id = $${p}`;
      p++;
    }

    params.push(limit, offset);
    const res = await db.query(`
      SELECT id, quote_number, deal_id, deal_name, customer_name, company, rep_id, total, date, quote_link, share_token, created_at, json_snapshot
      FROM quotes
      ${where}
      ORDER BY created_at DESC
      LIMIT $${p} OFFSET $${p+1}
    `, params);

    const countRes = await db.query(`SELECT COUNT(*) FROM quotes ${where}`, params.slice(0, p-1));
    return { results: res.rows, total: parseInt(countRes.rows[0].count) };
  } catch(e) {
    console.warn('DB search failed:', e.message);
    return null;
  }
}

async function fetchQuoteHistory() {
  const db = _getDb();
  if (!db) return [];
  try {
    const res = await db.query(`
      SELECT quote_number, deal_id, deal_name, customer_name, company,
             rep_id, total, date, quote_link, share_token, json_snapshot, created_at
      FROM quotes ORDER BY created_at DESC LIMIT 200
    `);
    return res.rows.map(r => {
      const snap = r.json_snapshot || {};
      return {
        id:          snap.id || r.quote_number,
        quoteNumber: r.quote_number,
        dealId:      r.deal_id,
        dealName:    r.deal_name,
        customer: {
          firstName: r.customer_name?.split(' ')[0] || '',
          lastName:  r.customer_name?.split(' ').slice(1).join(' ') || '',
          company:   r.company || '',
          ...snap.customer,
        },
        ownerId:    r.rep_id,
        total:      r.total,
        date:       r.date,
        quoteLink:  r.quote_link,
        shareToken: r.share_token,
        savedAt:    r.created_at,
        ...snap,
        shareToken: r.share_token,
      };
    });
  } catch(e) {
    console.warn('fetchQuoteHistory:', e.message);
    return [];
  }
}

module.exports = {
  init,
  SERVER_REP_NUMBERS,
  initDb,
  generateFreeQuoteNumber,
  previewNextQuoteNumber,
  saveQuoteToDb,
  getQuoteFromDb,
  searchQuotesInDb,
  fetchQuoteHistory,
};
