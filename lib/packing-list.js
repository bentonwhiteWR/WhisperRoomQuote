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

// Feature → component substitution rules.
//   - `code`: the component added per "unit" of the feature.
//   - Sized feature line (e.g. "VSS 4230") = one component per vent set in the
//     booth's base BOM (F01 qty). Bare feature ("VSS" / "EFS") = exactly 1.
//   - Feature line's own qty (>1 on the quote) multiplies whatever the above
//     resolves to.
const FEATURE_SUBS = {
  VSS: { code: 'F02' },   // Ventilation Silencing System
  EFS: { code: 'F03' },   // Exterior Fan Silencer
};
const FEATURE_TYPE_RX = new RegExp('^(' + Object.keys(FEATURE_SUBS).join('|') + ')\\b', 'i');

// Apply VSS/EFS-style rules to a room. Returns the components to ADD (each
// expanded to one entry per physical item) plus the features that didn't
// match any rule (so the UI can still flag them).
function applyFeatureSubs(features, ventCount) {
  const remaining = [];
  const additions = [];
  (features || []).forEach(f => {
    const name = String(f?.name || '').trim();
    const m = FEATURE_TYPE_RX.exec(name);
    if (!m) { remaining.push(f); return; }
    const type = m[1].toUpperCase();
    const rule = FEATURE_SUBS[type];
    if (!rule) { remaining.push(f); return; }
    // "VSS 4230" → has trailing tokens → multiply by vent count.
    // bare "VSS" → no trailing tokens → exactly 1.
    const sized = name.length > type.length;
    const perFeature = sized ? Math.max(1, ventCount || 1) : 1;
    const total = perFeature * Math.max(1, parseInt(f.qty, 10) || 1);
    for (let i = 0; i < total; i++) additions.push({ code: rule.code, fromFeature: name });
  });
  return { remaining, additions };
}

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

// Expand a base-bom model into PL line rows. Each row = ONE physical item,
// so a component with bom qty=N becomes N adjacent rows (the PL is a
// per-package picklist, not a summary). Each row carries weight=eachLb.
function boothLines(key) {
  const bom = BASE_BOM[key];
  if (!bom) return null;
  const rows = [];
  let net = 0;
  for (const [code, qty] of Object.entries(bom.components)) {
    const c = COMPONENTS[code] || {};
    const eachLb = (c.lb == null) ? null : Number(c.lb);
    const n = Math.max(1, parseInt(qty, 10) || 1);
    for (let i = 0; i < n; i++) {
      if (eachLb != null) net += eachLb;
      rows.push({
        code,
        desc: c.desc || '(unknown component)',
        pack: c.pack || '',
        eachLb,
        L: c.L ?? null, W: c.W ?? null, T: c.T ?? null,
        known: !!COMPONENTS[code],
      });
    }
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
    let lines = resolved?.rows ? resolved.rows.slice() : [];
    let netLb = resolved?.net ?? null;
    let unmappedFeatures = room.features;

    if (resolved) {
      const ventCount = (BASE_BOM[key]?.components?.F01) || 0;
      const { remaining, additions } = applyFeatureSubs(room.features, ventCount);
      additions.forEach(a => {
        const c = COMPONENTS[a.code] || {};
        const eachLb = (c.lb == null) ? null : Number(c.lb);
        if (eachLb != null) netLb = (netLb || 0) + eachLb;
        lines.push({
          code: a.code,
          desc: c.desc || '(unknown component)',
          pack: c.pack || '',
          eachLb,
          L: c.L ?? null, W: c.W ?? null, T: c.T ?? null,
          known: !!COMPONENTS[a.code],
          addedFrom: a.fromFeature,
        });
      });
      lines.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
      unmappedFeatures = remaining;
      if (netLb != null) netLb = Math.round(netLb * 100) / 100;
    }

    return {
      index: idx + 1,
      boothName: room.boothName,
      matchedModel: key,
      found: !!resolved,
      qty: room.qty,
      size: resolved?.size || '',
      variant: resolved?.variant || '',
      header: { hinge: opts.hinge || DEFAULTS.hinge, foam: opts.foam || DEFAULTS.foam },
      lines,
      netLb,
      unmappedFeatures,   // feature lines that didn't match any substitution rule
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

module.exports = { init, generate, parseRooms, applyFeatureSubs, componentDict, DEFAULTS, HINGE_OPTIONS, FOAM_OPTIONS, FEATURE_SUBS };
