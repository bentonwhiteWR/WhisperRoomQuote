// Inventory — Packing-List migration Phase 2 (replaces the Excel Inventory
// sheet + Z:\ Inventory.csv round-trip).
//
// Host must call init({ getDb, writelog }) before use.
//
// Semantics ported from PackingList.xlsm SalesMacros.bas:
//   - Ship (Allocated → Shipped) deducts on-hand per PL line; un-ship restores.
//     The Excel macro did −1 per repeated component line; here the PL
//     generator's rooms[].lines[] already expand to one line per physical box,
//     so the per-code counts are identical — but transactional and audited.
//   - The hardcoded vent-set remap F12/F07 → F01 is preserved (VBA comment:
//     "For vent set modifications below").
//   - Unknown codes are NOT silently skipped (the Excel bug that caused
//     invisible shrinkage) — a row auto-creates at 0 and goes negative, which
//     the dashboard flags.
//   - Idempotency: a quote's ship deduction only applies when its net
//     ship/unship delta is zero (never deducted, or fully restored). No
//     double-deducts when a rep re-saves a shipped order.
//
// Every on_hand change writes an inventory_transactions row (append-only
// audit: who/when/why + resulting level). Manual grid edits arrive as
// 'adjust'; Excel paste-imports as 'sync'; startup seed as 'seed'.

let _getDb = () => null;
let _writelog = () => {};

function init(deps) {
  _getDb = deps.getDb;
  if (deps.writelog) _writelog = deps.writelog;
}

// Vent-set remap, verbatim from SalesMacros Subtract()/Add()
function remapCode(code) {
  return (code === 'F12' || code === 'F07') ? 'F01' : code;
}

// Flatten a packingList.generate() result into [{ code, name, qty }] —
// rooms[] are already per-unit (qty 1) and each line = one physical box.
function linesFromPl(pl) {
  const counts = new Map();
  for (const room of (pl?.rooms || [])) {
    for (const line of (room.lines || [])) {
      const code = remapCode(String(line.code || '').trim());
      if (!code) continue;
      const cur = counts.get(code) || { code, name: line.desc || '', qty: 0 };
      cur.qty += 1;
      if (!cur.name && line.desc) cur.name = line.desc;
      counts.set(code, cur);
    }
  }
  return [...counts.values()];
}

// Upsert the row and apply a delta inside an open client transaction.
// Returns the resulting on_hand.
async function _applyDelta(client, { code, name, delta, reason, quoteNumber, rep, note }) {
  await client.query(
    `INSERT INTO components_inventory (code, name) VALUES ($1, $2)
     ON CONFLICT (code) DO NOTHING`,
    [code, name || null]
  );
  const r = await client.query(
    `UPDATE components_inventory
        SET on_hand = on_hand + $2, updated_at = NOW()
      WHERE code = $1
      RETURNING on_hand`,
    [code, delta]
  );
  const after = r.rows[0]?.on_hand ?? null;
  await client.query(
    `INSERT INTO inventory_transactions (code, delta, on_hand_after, reason, quote_number, rep, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [code, delta, after, reason, quoteNumber || null, rep || null, note || null]
  );
  return after;
}

// Net ship/unship delta already recorded for a quote. 0 = not currently
// deducted (never shipped, or shipped + fully restored).
async function _shipNet(client, quoteNumber) {
  const r = await client.query(
    `SELECT COALESCE(SUM(delta), 0) AS net
       FROM inventory_transactions
      WHERE quote_number = $1 AND reason IN ('ship', 'unship')`,
    [quoteNumber]
  );
  return parseInt(r.rows[0]?.net, 10) || 0;
}

// Deduct a shipped order's PL from on-hand. lines = linesFromPl(pl).
// Returns { applied, skipped, lines } — skipped=true when already deducted.
async function deductForOrder(quoteNumber, lines, rep) {
  const db = _getDb();
  if (!db || !lines?.length) return { applied: 0, skipped: !lines?.length };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if ((await _shipNet(client, quoteNumber)) !== 0) {
      await client.query('ROLLBACK');
      _writelog('info', 'inventory.ship.skip', `inventory already deducted for ${quoteNumber} — skipping`, { quoteNum: quoteNumber });
      return { applied: 0, skipped: true };
    }
    const negative = [];
    for (const l of lines) {
      const after = await _applyDelta(client, {
        code: l.code, name: l.name, delta: -l.qty,
        reason: 'ship', quoteNumber, rep,
      });
      if (after != null && after < 0) negative.push(`${l.code}:${after}`);
    }
    await client.query('COMMIT');
    _writelog('info', 'inventory.ship', `deducted ${lines.length} component codes for ${quoteNumber}`,
      { quoteNum: quoteNumber, rep, meta: { codes: lines.length, units: lines.reduce((s, l) => s + l.qty, 0), negative: negative.length ? negative : undefined } });
    if (negative.length) {
      _writelog('warn', 'inventory.negative', `on-hand went negative on ship of ${quoteNumber}: ${negative.join(', ')}`, { quoteNum: quoteNumber });
    }
    return { applied: lines.length, skipped: false };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Reverse a quote's recorded ship deduction (un-ship / order deleted after
// ship). Restores EXACTLY what was deducted — reads the audit rows rather
// than regenerating the PL, so a BOM rule change between ship and un-ship
// can't corrupt stock. (Excel's "delete a shipped order" never restored.)
async function restoreForOrder(quoteNumber, rep) {
  const db = _getDb();
  if (!db) return { applied: 0, skipped: true };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `SELECT code, SUM(delta) AS net
         FROM inventory_transactions
        WHERE quote_number = $1 AND reason IN ('ship', 'unship')
        GROUP BY code
        HAVING SUM(delta) != 0`,
      [quoteNumber]
    );
    if (!r.rows.length) {
      await client.query('ROLLBACK');
      return { applied: 0, skipped: true };
    }
    for (const row of r.rows) {
      await _applyDelta(client, {
        code: row.code, delta: -parseInt(row.net, 10),
        reason: 'unship', quoteNumber, rep,
      });
    }
    await client.query('COMMIT');
    _writelog('info', 'inventory.unship', `restored ${r.rows.length} component codes for ${quoteNumber}`, { quoteNum: quoteNumber, rep });
    return { applied: r.rows.length, skipped: false };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Manual grid save / Excel paste-sync. changes = [{ code, name?, on_hand?,
// build_point?, build_qty?, finished_qty?, in_process_qty?, active? }] — only
// provided fields update. on_hand changes are written as audited deltas (row locked so
// a concurrent ship deduction can't be clobbered — the Excel last-writer-wins
// bug this system exists to kill).
async function applyChanges(changes, { reason = 'adjust', rep = null, note = null } = {}) {
  const db = _getDb();
  if (!db || !changes?.length) return { updated: 0, adjusted: 0, created: 0 };
  const FIELDS = ['name', 'build_point', 'build_qty', 'finished_qty', 'in_process_qty'];
  const client = await db.connect();
  let updated = 0, adjusted = 0, created = 0;
  try {
    await client.query('BEGIN');
    for (const ch of changes) {
      const code = String(ch.code || '').trim();
      if (!code) continue;
      const ins = await client.query(
        `INSERT INTO components_inventory (code, name) VALUES ($1, $2)
         ON CONFLICT (code) DO NOTHING`,
        [code, ch.name || null]
      );
      if (ins.rowCount > 0) created++;
      // Field updates (no audit row — they're not stock moves)
      const sets = [], vals = [code];
      for (const f of FIELDS) {
        if (ch[f] !== undefined) { vals.push(ch[f] === '' ? null : ch[f]); sets.push(`${f} = $${vals.length}`); }
      }
      if (sets.length) {
        await client.query(
          `UPDATE components_inventory SET ${sets.join(', ')}, updated_at = NOW() WHERE code = $1`, vals);
        updated++;
      }
      // archive / restore (dashboard cleanup). Boolean-only on purpose: the
      // Excel paste-sync never sends `active`, so a sync can't resurrect
      // archived rows. Not a stock move, but it makes rows disappear from the
      // grid — so it gets an audit row (delta 0) for the "where did C26 go?" case.
      if (typeof ch.active === 'boolean') {
        const cur = await client.query(
          `SELECT active, on_hand FROM components_inventory WHERE code = $1 FOR UPDATE`, [code]);
        if ((cur.rows[0]?.active !== false) !== ch.active) {
          await client.query(
            `UPDATE components_inventory SET active = $2, updated_at = NOW() WHERE code = $1`, [code, ch.active]);
          await client.query(
            `INSERT INTO inventory_transactions (code, delta, on_hand_after, reason, rep, note)
             VALUES ($1, 0, $2, $3, $4, $5)`,
            [code, cur.rows[0]?.on_hand ?? null, reason, rep, ch.active ? 'restored from archive' : 'archived']);
          updated++;
        }
      }
      // on_hand: lock, diff, audit
      if (ch.on_hand !== undefined && ch.on_hand !== null && ch.on_hand !== '') {
        const target = parseInt(ch.on_hand, 10);
        if (Number.isNaN(target)) continue;
        const cur = await client.query(
          `SELECT on_hand FROM components_inventory WHERE code = $1 FOR UPDATE`, [code]);
        const delta = target - (cur.rows[0]?.on_hand ?? 0);
        if (delta !== 0) {
          await _applyDelta(client, { code, name: ch.name, delta, reason, rep, note });
          adjusted++;
        }
      }
    }
    await client.query('COMMIT');
    if (adjusted || created) {
      _writelog('info', `inventory.${reason}`, `${reason}: ${adjusted} on-hand changes, ${created} new codes`, { rep, meta: { adjusted, updated, created } });
    }
    return { updated, adjusted, created };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Full grid, code-sorted (numeric-aware so A2 < A10).
async function getGrid() {
  const db = _getDb();
  if (!db) return [];
  const r = await db.query(
    `SELECT code, name, on_hand, build_point, build_qty, finished_qty, in_process_qty, active, updated_at
       FROM components_inventory
      ORDER BY code`
  );
  return r.rows.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
}

// Audit trail — optionally filtered by code or quote.
async function getTransactions({ code, quoteNumber, limit = 200 } = {}) {
  const db = _getDb();
  if (!db) return [];
  const wh = [], vals = [];
  if (code)        { vals.push(code);        wh.push(`code = $${vals.length}`); }
  if (quoteNumber) { vals.push(quoteNumber); wh.push(`quote_number = $${vals.length}`); }
  vals.push(Math.min(parseInt(limit, 10) || 200, 1000));
  const r = await db.query(
    `SELECT id, code, delta, on_hand_after, reason, quote_number, rep, note, created_at
       FROM inventory_transactions
       ${wh.length ? 'WHERE ' + wh.join(' AND ') : ''}
      ORDER BY created_at DESC, id DESC
      LIMIT $${vals.length}`,
    vals
  );
  return r.rows;
}

// One-time startup seed from lib/pl-data/inventory-seed.json (extracted from
// the PackingList.xlsm Inventory sheet). Only runs when the table is EMPTY —
// after that, the paste-sync on the dashboard is the way to re-align with
// Excel during the parallel run.
async function seedIfEmpty(seed) {
  const db = _getDb();
  if (!db || !seed?.rows?.length) return false;
  const r = await db.query(`SELECT COUNT(*)::int AS n FROM components_inventory`);
  if (r.rows[0].n > 0) return false;
  await applyChanges(seed.rows, {
    reason: 'seed',
    note: `seed from PackingList.xlsm (saved ${seed._meta?.workbook_saved || '?'})`,
  });
  _writelog('info', 'inventory.seed', `seeded ${seed.rows.length} components from Excel extract`, { meta: seed._meta });
  return true;
}

module.exports = {
  init,
  remapCode,
  linesFromPl,
  deductForOrder,
  restoreForOrder,
  applyChanges,
  getGrid,
  getTransactions,
  seedIfEmpty,
};
