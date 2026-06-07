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
let STD_WALL_BY_SIZE = {}; // wallSize (e.g. 46) → bare-wall code (e.g. C101)
let WINDOW_WALL = {};      // "<wall>:<wdo>[:JACK]" → window-wall code (e.g. C104)
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
  buildWallMaps();
}

// Derive wall-size → code maps from COMPONENTS. Run once at init.
//   STD_WALL_BY_SIZE: "STDWL46" → C101 (the bare wall, no door/vent/window)
//   WINDOW_WALL:      "46:3236" → C104 (STDWL46 WDO3236)
//                     "46:3236:JACK" → C107
// C-codes take precedence over Z-codes (Z* are ADA/swap-variants).
function buildWallMaps() {
  STD_WALL_BY_SIZE = {};
  WINDOW_WALL = {};
  for (const [code, c] of Object.entries(COMPONENTS)) {
    const pack = String(c?.pack || '').trim();
    const bare = pack.match(/^STDWL(\d+)$/);
    if (bare) {
      const size = parseInt(bare[1], 10);
      if (STD_WALL_BY_SIZE[size] == null || (/^C/.test(code) && !/^C/.test(STD_WALL_BY_SIZE[size]))) {
        STD_WALL_BY_SIZE[size] = code;
      }
      continue;
    }
    const win = pack.match(/^STDWL(\d+)\s+WDO(\d+)(\s+JACK)?$/);
    if (win) {
      const key = win[1] + ':' + win[2] + (win[3] ? ':JACK' : '');
      WINDOW_WALL[key] = code;
    }
  }
}

// Find a booth's "primary" wall — the largest bare STDWL{N} actually present
// in the BOM. Windows go in the longest wall when no explicit wall hint is
// given on the feature.
function primaryWallSize(bomKey) {
  const bom = BASE_BOM[bomKey];
  if (!bom) return 0;
  let best = 0;
  for (const code of Object.keys(bom.components || {})) {
    const pack = COMPONENTS[code]?.pack || '';
    const m = /^STDWL(\d+)$/.exec(pack);
    if (m) {
      const size = parseInt(m[1], 10);
      if (size > best) best = size;
    }
  }
  return best;
}

const DEFAULTS = { hinge: 'Left', foam: 'Gray' };
const HINGE_OPTIONS = ['Left', 'Right'];
const FOAM_OPTIONS  = ['Gray', 'Black', 'Beige', 'Blue', 'Burgundy'];

// Feature → component substitution rules.
//   test:     predicate against the quote feature's raw name
//   code:     component code (string) OR a resolver fn(name) → code
//   perVent:  if true, sized feature ("VSS 4230") → one component per vent set
//             (booth's F01 qty); bare ("VSS") → 1.
//             if false, always 1 component per feature line (× line qty).
//   prefix:   used to distinguish "sized" vs "bare" for perVent rules — the
//             feature name's prefix that, if alone, means "bare"
//   The exclusion `!ADPT|EXT` filters MJP ADPT / MJP EXT etc, which are
//   distinct hardware items not the same as the base feature.
const FEATURE_SUBS = [
  { name: 'VSS',  code: 'F02', perVent: true,  prefix: 'VSS',
    test: s => /^VSS(?:\s|$)/i.test(s) && !/\b(ADPT|EXT)\b/i.test(s) },
  { name: 'EFS',  code: 'F03', perVent: true,  prefix: 'EFS',
    test: s => /^EFS(?:\s|$)/i.test(s) && !/\b(ADPT|EXT)\b/i.test(s) },
  { name: 'MJP',  code: 'F09', perVent: false,
    test: s => /^MJP(?:\s|$)/i.test(s) && !/\b(ADPT|EXT)\b/i.test(s) },
  // Office Desk → S02 (Small) or S03 (Large). Bare "Office Desk" with no
  // size defaults to Small (rare in quotes; presets always include S or L).
  { name: 'DESK', perVent: false,
    test: s => /^OFFICE\s*DESK\b/i.test(s),
    code: s => /\b(L|LARGE)\b/i.test(s) ? 'S03' : 'S02' },
  // Window — swap a bare STDWL{N} wall for the matching STDWL{N} WDO{size}
  // window-wall component. "WDO 3236 S" → use booth's primary (largest)
  // STDWL{N} wall. "WDO 43\" 2636 S" → explicit 43" wall override. If the
  // booth's BOM has no matching bare wall to swap, fall through to the
  // unmapped flag for manual adjustment (covers ADA-modified configs).
  // IEP-prefixed lookalikes ("IEP WDO 2636") are caught by the leading
  // ^WDO\s+ anchor — they don't match.
  { name: 'WDO',
    test: s => /^WDO\s+\S/i.test(s),
    resolve: (name, lineQty, ctx) => {
      const m = /^WDO\s+(?:(\d+)["”]?\s+)?(\d{3,4})\b/i.exec(name);
      if (!m) return null;
      const explicitWall = m[1] ? parseInt(m[1], 10) : null;
      const wdoSize = m[2];
      const wallSize = explicitWall || ctx.primaryWallSize;
      if (!wallSize) return null;
      const stdCode = ctx.stdWallBySize[wallSize];
      const winCode = ctx.windowMap[wallSize + ':' + wdoSize];
      // Need both: the wall to take OUT and the window-wall to put IN.
      // If the booth doesn't have the std wall in its BOM, swap can't happen.
      if (!stdCode || !winCode) return null;
      const hasStd = ctx.bomComponents && (ctx.bomComponents[stdCode] || 0) > 0;
      if (!hasStd) return null;
      const additions = [], removals = [];
      for (let i = 0; i < lineQty; i++) {
        additions.push({ code: winCode, fromFeature: name });
        removals.push(stdCode);
      }
      return { additions, removals };
    } },
];

// Apply substitution rules to a room. Returns components to ADD (one entry
// per physical item), components to REMOVE (one entry per item, applied
// first), and the features that didn't match any rule (still flagged).
//
// ctx: { ventCount, primaryWallSize, stdWallBySize, windowMap, bomComponents }
function applyFeatureSubs(features, ctx) {
  ctx = ctx || {};
  const remaining = [];
  const additions = [];
  const removals = [];
  (features || []).forEach(f => {
    const name = String(f?.name || '').trim();
    const lineQty = Math.max(1, parseInt(f.qty, 10) || 1);
    const rule = FEATURE_SUBS.find(r => r.test(name));
    if (!rule) { remaining.push(f); return; }
    // Custom resolver — full control over additions + removals.
    if (typeof rule.resolve === 'function') {
      const res = rule.resolve(name, lineQty, ctx);
      if (!res) { remaining.push(f); return; }
      (res.additions || []).forEach(a => additions.push(a));
      (res.removals || []).forEach(r => removals.push(r));
      return;
    }
    // Simple add rule (code is a string or fn returning a code).
    const code = typeof rule.code === 'function' ? rule.code(name) : rule.code;
    let perFeature = 1;
    if (rule.perVent) {
      // "VSS 4230" → has tokens past the prefix → multiply by vent count.
      // bare "VSS" → just the prefix → 1.
      const sized = name.length > (rule.prefix || rule.name || '').length;
      perFeature = sized ? Math.max(1, ctx.ventCount || 1) : 1;
    }
    const total = perFeature * lineQty;
    for (let i = 0; i < total; i++) additions.push({ code, fromFeature: name });
  });
  return { remaining, additions, removals };
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
      const ctx = {
        ventCount: (BASE_BOM[key]?.components?.F01) || 0,
        primaryWallSize: primaryWallSize(key),
        stdWallBySize: STD_WALL_BY_SIZE,
        windowMap: WINDOW_WALL,
        bomComponents: BASE_BOM[key]?.components || {},
      };
      const { remaining, additions, removals } = applyFeatureSubs(room.features, ctx);
      // Removals first — each takes out ONE matching line (each line = 1 item).
      removals.forEach(rmCode => {
        const idx = lines.findIndex(l => l.code === rmCode);
        if (idx >= 0) {
          const removed = lines.splice(idx, 1)[0];
          if (removed && removed.eachLb != null) netLb = (netLb || 0) - removed.eachLb;
        }
      });
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
