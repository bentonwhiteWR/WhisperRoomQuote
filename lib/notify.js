// Rep notifications (DB + email logging)
// Extracted from quote-server.js — named exports, no behavior changes.
// Host must call `init({ getDb })` before any notify function is invoked.

let _getDb;

function init(deps) {
  _getDb = deps.getDb;
}

// Rep email addresses for notifications
const REP_EMAILS = {
  '36330944': 'jill@whisperroom.com',
  '38143901': 'sarah@whisperroom.com',
  '117442978':'travis@whisperroom.com',
  '36303670': 'bentonwhite@whisperroom.com',
  '36320208': 'gabe@whisperroom.com',
  '38732178': 'kim@whisperroom.com',
  '38900892': 'chet@whisperroom.com',
  '38732186': 'jeromy@whisperroom.com',
};

async function createNotification(ownerId, type, title, body, { dealId, dealName, quoteNum } = {}) {
  const db = _getDb();
  if (!db || !ownerId) return;
  try {
    await db.query(
      `INSERT INTO notifications (owner_id, type, title, body, deal_id, deal_name, quote_num)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [String(ownerId), type, title, body || null, dealId || null, dealName || null, quoteNum || null]
    );
  } catch(e) { console.warn('[notify] DB insert failed:', e.message); }
}

async function notifyRep(ownerId, subject, bodyText, meta = {}) {
  if (!ownerId) return;
  // Create internal notification
  await createNotification(ownerId, meta.type || 'info', subject, bodyText, meta);
  // Log email intent (add SMTP later if needed)
  const email = REP_EMAILS[String(ownerId)];
  if (email) console.log(`[notify] ${email} — ${subject}`);
}

module.exports = {
  init,
  REP_EMAILS,
  createNotification,
  notifyRep,
};
