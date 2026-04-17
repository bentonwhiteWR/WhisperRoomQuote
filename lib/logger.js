// Activity/error log writer — writes to Postgres `logs` table
// Host must call init({ getDb, appVersion }) before writelog is invoked.

let _getDb;
let _appVersion = '1.0.0';

function init(deps) {
  _getDb      = deps.getDb;
  _appVersion = deps.appVersion || '1.0.0';
}

function writelog(level, event, message, opts) {
  setImmediate(() => {
    const db = _getDb && _getDb();
    if (!db) return;
    const o = opts || {};
    db.query(
      `INSERT INTO logs (version,level,event,rep,quote_num,deal_id,deal_name,message,meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [ _appVersion, level, event,
        o.rep      || null,
        o.quoteNum || null,
        o.dealId   || null,
        o.dealName || null,
        message,
        o.meta ? JSON.stringify(o.meta) : null ]
    ).catch(() => {});
  });
}

module.exports = { init, writelog };
