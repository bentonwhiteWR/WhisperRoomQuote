// Packing List generator.
// Turns a quote's line items into a structured packing list:
//   1. Group lines into ROOMS — each "MDL …" booth line starts a room, the
//      lines under it attach as that room's feature lines (the team's quote
//      ordering: booth, then its options, then the next booth, etc.).
//   2. Resolve each booth to its full bill-of-materials from the base BOM +
//      components master (code → description / weight / dims / pack code).
//   3. Apply header defaults (hinge Left, foam Gray — overridable).
//   4. Surface feature lines that don't yet have a substitution rule, rather
//      than silently dropping or mis-applying them.
//
// Data lives in lib/pl-data/ (committed, regenerated from PackingList.xlsm):
//   base-bom.json        model → { size, variant, net, components{code:qty} }
//   components-master.json  code → { desc, pack, lb, L, W, T }
//
// IMPORTANT: hinge side + foam color are NOT BOM components — they're PL header
// instructions (default Left / Gray). They do not change the component list.

const fs   = require('fs');
const path = require('path');

let BASE_BOM   = {};   // model → { size, variant, net, components }
let COMPONENTS = {};   // code  → { desc, pack, lb, L, W, T }
let _meta = {};

function init() {
  try {
    const bb = JSON.parse(fs.readFileSync(path.join(__dirname, 'pl-data', 'base-bom.json'), 'utf8'));
    BASE_BOM = bb.models || {};
    _meta.baseBom = bb._meta || {};
  } catch (e) { console.warn('[packing-list] base-bom.json load failed:', e.message); }
  try {
    const cm = JSON.parse(fs.readFileSync(path.join(__dirname, 'pl-data', 'components-master.json'), 'utf8'));
    COMPONENTS = cm.components || {};
    _meta.components = cm._meta || {};
  } catch (e) { console.warn('[packing-list] components-master.json load failed:', e.message); }
}

const DEFAULTS = { hinge: 'Left', foam: 'Gray' };
const HINGE_OPTIONS = ['Left', 'Right'];
const FOAM_OPTIONS  = ['Gray', 'Black', 'Beige', 'Blue', 'Burgundy'];

function isBooth(name) { return /^MDL\s+\d/i.test(String(name || '').trim()); }

// Map a quote booth line ("MDL 4848 E") to a base-bom key. Tolerates spacing
// and case; peels any trailing qualifiers after the variant token.
function boothKey(name) {
  const s = String(name || '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (BASE_BOM[s]) return s;
  const m = /^MDL\s+(.+?)\s+(SNV|ENV|S|E)\b/.exec(s);
  if (m) {
    const k = `MDL ${m[1].trim()} ${m[2]}`;
    if (BASE_BOM[k]) return k;
  }
  return null;
}

// Walk line items into rooms. Booth line → new room; following non-booth lines
// → that room's features. Lines before the first booth are returned separately.
function parseRooms(lineItems) {
  const items = Array.isArray(lineItems) ? lineItems : [];
  const rooms = [];
  const orphanFeatures = [];
  let current = null;
  for (const it of items) {
    const name = String(it?.name || it?.productName || it?.title || it?.product || '').trim();
    if (!name) continue;
    const qty = Math.max(1, parseInt(it?.qty, 10) || 1);
    if (isBooth(name)) {
      current = { boothName: name, qty, features: [] };
      rooms.push(current);
    } else if (current) {
      current.features.push({ name, qty });
    } else {
      orphanFeatures.push({ name, qty });
    }
  }
  return { rooms, orphanFeatures };
}

// Expand a base-bom model into PL line rows.
function boothLines(key) {
  const bom = BASE_BOM[key];
  if (!bom) return null;
  const rows = [];
  let net = 0;
  for (const [code, qty] of Object.entries(bom.components)) {
    const c = COMPONENTS[code] || {};
    const eachLb = (c.lb == null) ? null : Number(c.lb);
    const totalLb = (eachLb == null) ? null : Math.round(eachLb * qty * 100) / 100;
    if (totalLb != null) net += totalLb;
    rows.push({
      code, qty,
      desc: c.desc || '(unknown component)',
      pack: c.pack || '',
      eachLb,
      totalLb,
      L: c.L ?? null, W: c.W ?? null, T: c.T ?? null,
      known: !!COMPONENTS[code],
    });
  }
  rows.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  return { rows, net: Math.round(net * 100) / 100, size: bom.size, variant: bom.variant };
}

// Build the full PL for a quote's line items.
function generate(lineItems, opts = {}) {
  const { rooms, orphanFeatures } = parseRooms(lineItems);
  const out = rooms.map((room, idx) => {
    const key = boothKey(room.boothName);
    const resolved = key ? boothLines(key) : null;
    return {
      index: idx + 1,
      boothName: room.boothName,
      matchedModel: key,
      found: !!resolved,
      qty: room.qty,
      size: resolved?.size || '',
      variant: resolved?.variant || '',
      header: { hinge: opts.hinge || DEFAULTS.hinge, foam: opts.foam || DEFAULTS.foam },
      lines: resolved?.rows || [],
      netLb: resolved?.net ?? null,
      unmappedFeatures: room.features,   // feature lines without a substitution rule yet
    };
  });
  const grandNet = out.reduce((s, r) => s + ((r.netLb || 0) * (r.qty || 1)), 0);
  return {
    rooms: out,
    orphanFeatures,
    totals: { rooms: out.length, netLb: Math.round(grandNet * 100) / 100 },
    defaults: DEFAULTS,
    options: { hinge: HINGE_OPTIONS, foam: FOAM_OPTIONS },
  };
}

// Lightweight component dictionary for the viewer's "add a component" picker.
function componentDict() { return COMPONENTS; }

module.exports = { init, generate, parseRooms, componentDict, DEFAULTS, HINGE_OPTIONS, FOAM_OPTIONS };
