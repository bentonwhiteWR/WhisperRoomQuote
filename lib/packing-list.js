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
// Hinge side AND foam color are REAL BOM swaps (see HINGE_R_TO_L below and
// FOAM_BY_SIZE_COLOR, plus the hinge / foam post-process steps in generate()).
// The defaults below are what the base BOM ships with — Left + Gray — and a
// non-default selection rewrites the affected component rows after feature
// subs run.

const fs   = require('fs');
const path = require('path');

let BASE_BOM   = {};   // model → { size, variant, net, components }
let COMPONENTS = {};   // code  → { desc, pack, lb, L, W, T }
let STD_WALL_BY_SIZE = {}; // wallSize (e.g. 46) → bare-wall code (e.g. C101)
let WINDOW_WALL = {};      // "<wall>:<wdo>[:JACK]" → window-wall code (e.g. C104)
// Inner-shell (E/ENV double-shell) IEP wall maps:
let IEP_WALL_BY_SIZE = {};      // "35.5" → "K01" (bare IEPWL35.5)
let IEP_WINDOW_TOP = {};        // "35.5:2648" → "K05" (TOP-only window)
let IEP_WINDOW_SINGLE = {};     // "35.5:2630" → "K02" (one-piece window bundle)
let IEP_WALL_BOT_BY_SIZE = {};  // "35.5" → "K06" (bottom-half of split window)
let FOAM_BY_SIZE_COLOR = {};    // "4:Gray" → "E03", "4:Purple" → "E06", etc.
let RM_CEILING_MAP = {};        // baseCeilingCode → RM-variant code (A06 → A34, I06 → I30)
let CBL_WALL_MAP = {};          // VNT-wall code → CBL-wall code (C102 → C117, K102 → K117)
let BOOTH_LAYOUTS = {};         // "MDL 4872 S" → top-down layout (see lib/pl-data/booth-layouts.json)
// Feature rules derived from the HX+CP+SL feature PLs (lib/pl-data/feature-rules.json):
let FEATURE_SEAM_SWAP = {};     // base seam-seal code → Tall "(T)" variant (HX swaps all seams)
let HX_HARDWARE_SWAP  = {};     // base HDWR code → "... W/ HX" code (built at init from HDWR packs)
let CP_BY_MODEL = {};           // model → { caster-plate / casters code: qty } (CP add)
let SL_BY_MODEL = {};           // model → { remove:{T01:n}, add:{T07:a,T08:b} } (Studio Light swap)
let HX_EXT_BY_MODEL = {};       // model → { wall-height-extension code: boxes } (HX add)
let ADA_BY_MODEL = {};          // model → { add:{...}, remove:{...} } — full ADA package per booth (default WA type)
let ADA_WA_VARIANTS = {};       // dual-option ADA booths → { "4646":{add,remove}, "4622":{...} }
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
  try {
    const bl = JSON.parse(fs.readFileSync(path.join(__dirname, 'pl-data', 'booth-layouts.json'), 'utf8'));
    BOOTH_LAYOUTS = bl.layouts || {};
    _meta.boothLayouts = bl._meta || {};
  } catch (e) { console.warn('[packing-list] booth-layouts.json load failed:', e.message); }
  try {
    const fr = JSON.parse(fs.readFileSync(path.join(__dirname, 'pl-data', 'feature-rules.json'), 'utf8'));
    FEATURE_SEAM_SWAP = fr.seam_swap || {};
    CP_BY_MODEL       = fr.cp_by_model || {};
    SL_BY_MODEL       = fr.sl_by_model || {};
    HX_EXT_BY_MODEL   = fr.hx_ext_by_model || {};
    ADA_BY_MODEL      = fr.ada_by_model || {};
    ADA_WA_VARIANTS   = fr.ada_wa_variants || {};
    _meta.featureRules = fr._meta || {};
  } catch (e) { console.warn('[packing-list] feature-rules.json load failed:', e.message); }
  buildWallMaps();
  buildIepMaps();
  buildFoamMap();
  buildRmMaps();
  buildHardwareSwap();
}

// Look up the top-down layout for a booth name. Layouts are keyed by SIZE
// ("MDL 4872"); the S/E/SNV/ENV variant is parsed off the name and resolved
// here — the returned object is a shallow copy with the variant's own
// wallThickness + interior attached (E booths have thicker walls / a smaller
// interior than S). SNV→S, ENV→E. Single-wall (S) is the default when a name
// carries no variant suffix.
function boothLayout(name) {
  const raw = String(name || '');
  const m = raw.match(/^(MDL\s+.+?)(?:\s+(S|E|SNV|ENV))?$/i);
  if (!m) return null;
  const sizeKey = m[1];
  const variant = (m[2] || 'S').toUpperCase();
  const base = BOOTH_LAYOUTS[sizeKey] || BOOTH_LAYOUTS[raw];
  if (!base) return null;
  // Old schema (no `variants` block) — return as-is for safety.
  if (!base.variants) return base;
  const vKey = (variant === 'E' || variant === 'ENV') ? 'E' : 'S';
  const v = base.variants[vKey] || base.variants.S;
  return Object.assign({}, base, {
    variant,                       // S / E / SNV / ENV (as requested)
    variantKey: vKey,              // S or E (resolved)
    hasVent: variant !== 'SNV' && variant !== 'ENV',   // NV booths have no vent
    wallThickness: v.wallThickness,
    interior: v.interior,
  });
}

// RM (Roof Mount Ventilation) swaps:
//   RM_CEILING_MAP: every ceiling (STD or IEP, ends in `CL`/`CL SIDE`/`CL CTR`)
//     → its `... RM` variant. Small-booth outer ceilings (e.g. STD4242CL) map
//     to a "... SIDE RM" pack — same code family, just inconsistent naming.
//   CBL_WALL_MAP: every `STDWL{N} VNT` (outer) or `IEPWL{size} VNT` (inner)
//     → the matching `... CBL` wall of the same size. Sizes without a CBL
//     counterpart (e.g. STDWL16) silently stay VNT — data gap, not a bug.
// NV variants (`VNT NV`) are intentionally NOT swapped here — they're for
// SNV/ENV booths and don't have a CBL NV counterpart; leaving them in place
// is a deliberate "best-effort" until Benton confirms the RM+SNV behavior.
function buildRmMaps() {
  RM_CEILING_MAP = {};
  CBL_WALL_MAP = {};
  const packToCode = {};
  for (const [code, c] of Object.entries(COMPONENTS)) {
    const pack = String(c?.pack || '').trim();
    if (pack && !packToCode[pack]) packToCode[pack] = code;
  }
  // Ceilings: any pack containing "CL" but NOT already ending in " RM".
  for (const [code, c] of Object.entries(COMPONENTS)) {
    const pack = String(c?.pack || '').trim();
    if (!pack || /\sRM$/.test(pack)) continue;
    if (!/CL(\s|$)/.test(pack)) continue;
    const rmCode = packToCode[pack + ' RM'] || packToCode[pack + ' SIDE RM'];
    if (rmCode) RM_CEILING_MAP[code] = rmCode;
  }
  // VNT walls (outer + inner). Match exact "VNT" — not "VNT NV".
  for (const [code, c] of Object.entries(COMPONENTS)) {
    const pack = String(c?.pack || '').trim();
    let m = pack.match(/^(STDWL\d+)\s+VNT$/);
    if (m) {
      const cbl = packToCode[m[1] + ' CBL'];
      if (cbl) CBL_WALL_MAP[code] = cbl;
      continue;
    }
    m = pack.match(/^(IEPWL[\d.]+)\s+VNT$/);
    if (m) {
      const cbl = packToCode[m[1] + ' CBL'];
      if (cbl) CBL_WALL_MAP[code] = cbl;
    }
  }
}

// HX hardware swap. Every booth hardware kit ships as a `HDWR <model>` pack with
// two codes — a base "HARDWARE" and a "HARDWARE W/ HX" variant. Pair them so the
// HX rule can swap the booth's base hardware to its HX counterpart. Covers all
// four variants (S/E/SNV/ENV) since each has its own HDWR <model> pack.
function buildHardwareSwap() {
  HX_HARDWARE_SWAP = {};
  const byPack = {};
  for (const [code, c] of Object.entries(COMPONENTS)) {
    const pack = String(c?.pack || '').trim();
    if (!/^HDWR\b/.test(pack)) continue;
    (byPack[pack] = byPack[pack] || []).push(code);
  }
  for (const codes of Object.values(byPack)) {
    if (codes.length < 2) continue;
    const isHx = c => /W\/\s*HX/i.test(COMPONENTS[c]?.desc || '');
    const hx   = codes.find(isHx);
    const base = codes.find(c => c !== hx && !isHx(c));
    if (hx && base) HX_HARDWARE_SWAP[base] = hx;
  }
}

// Per-model feature tables (CP / SL / HX extensions) were derived from the S & E
// feature PLs. NV variants get the same feature components as their vented twin,
// so map SNV→S and ENV→E for the lookup.
function featureModelKey(key) {
  return String(key || '').replace(/\bSNV$/, 'S').replace(/\bENV$/, 'E');
}

// FOAM_BY_SIZE_COLOR: key `<size>:<Color>` → component code. Each foam pack
// size (FOAM2 / FOAM3 / FOAM4) ships in five colors; Gray is bare, the rest
// have a suffix (PUR / OR / BUR / BL). Built once from the components master.
function buildFoamMap() {
  FOAM_BY_SIZE_COLOR = {};
  for (const [code, c] of Object.entries(COMPONENTS)) {
    const m = String(c?.pack || '').match(/^FOAM(\d+)(?:\s+(PUR|OR|BUR|BL))?$/);
    if (!m) continue;
    const size = m[1];
    const color = FOAM_SUFFIX_TO_COLOR[(m[2] || '').toUpperCase()];
    if (!color) continue;
    FOAM_BY_SIZE_COLOR[size + ':' + color] = code;
  }
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

// Inner-shell (IEP) wall maps for E/ENV double-shell booths.
//   IEP_WALL_BY_SIZE:     bare IEPWL{N} pack → code (e.g. "35.5" → K01)
//   IEP_WINDOW_TOP:       size:wdo[:JACK] → "TOP COMPONENT ONLY" code (K05)
//   IEP_WINDOW_SINGLE:    size:wdo → bundled "single-piece" code (K02 etc.)
//   IEP_WALL_BOT_BY_SIZE: size → matching BOT component (K06)
// "Single-piece" is the smallest window in each IEP wall-size family — it
// bundles solid-bottom + window-top into one component. Larger windows
// ship as TOP + BOT (two separate boxes/codes).
function buildIepMaps() {
  IEP_WALL_BY_SIZE = {};
  IEP_WINDOW_TOP = {};
  IEP_WINDOW_SINGLE = {};
  IEP_WALL_BOT_BY_SIZE = {};
  for (const [code, c] of Object.entries(COMPONENTS)) {
    const pack = String(c?.pack || '').trim();
    const desc = String(c?.desc || '').trim();
    let m;
    if ((m = pack.match(/^IEPWL(\d+(?:\.\d+)?)$/))) {
      IEP_WALL_BY_SIZE[m[1]] = code;
      continue;
    }
    if ((m = pack.match(/^IEPWL(\d+(?:\.\d+)?)\s+WDO\s+BOT$/))) {
      IEP_WALL_BOT_BY_SIZE[m[1]] = code;
      continue;
    }
    if ((m = pack.match(/^IEPWL(\d+(?:\.\d+)?)\s+WDO\s*(\d+)(\s+JACK)?$/))) {
      const sz = m[1], wdo = m[2], jack = !!m[3];
      const key = sz + ':' + wdo + (jack ? ':JACK' : '');
      const isSingle  = /SINGLE\s*PIECE/i.test(desc) || (/SOLID/i.test(desc) && /WINDOW/i.test(desc));
      const isTopOnly = /TOP\s*COMPONENT\s*ONLY/i.test(desc);
      if (isSingle && !isTopOnly) IEP_WINDOW_SINGLE[key] = code;
      else IEP_WINDOW_TOP[key] = code;
    }
  }
}

// Outer→inner wall size relationship: inner = outer − 4.5 (consistent across
// the entire STDWL{N} ↔ IEPWL{N-4.5} family).
function outerToInnerWallSize(outer) {
  if (outer == null) return null;
  return (Number(outer) - 4.5).toFixed(1);
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
const FOAM_OPTIONS  = ['Gray', 'Purple', 'Orange', 'Burgundy', 'Blue'];

// Foam color suffix in pack names → display name. Gray ships as bare `FOAM{N}`
// (no suffix); the others append one of these abbreviations.
const FOAM_SUFFIX_TO_COLOR = { '': 'Gray', PUR: 'Purple', OR: 'Orange', BUR: 'Burgundy', BL: 'Blue' };

// Hinge swap. Every base BOM ships R-default (the door and matching
// doorframe are right-hinged). When the room's hinge is Left, each of these
// codes flips to its L counterpart. Pairs verified against components-master:
//   STD door / wall:  C113↔C115 (door 30), C114↔C116 (DRFRM 46),
//                     C14↔C15  (door 24),  C07↔C08  (DRFRM 40),
//                     C16↔C17  (generic).
//   IEP inner door:   M01↔M02  (small-wall E booths),
//                     K114↔K115 (46"-wall E booths).
//   Inswing DRFRM:    L02↔L03 (46"), L04↔L05 (40").
// Jambs (L01, K116) are bare/non-handed and don't swap.
// Runs AFTER feature subs so WA/ADA (which already pick L/R via ctx.hinge)
// don't get double-flipped; this only catches base BOM rows that no rule
// removed.
const HINGE_R_TO_L = {
  C113: 'C115', C114: 'C116',
  C14:  'C15',  C07:  'C08',
  C16:  'C17',
  M01:  'M02',
  K114: 'K115',
  L02:  'L03',  L04:  'L05',
};

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
  // STEP — Exterior Step. Always one S01 per quote line × line qty;
  // never appears in a base BOM. Exact-match only — quote presets use
  // bare "STEP"; anything else (e.g. "STEP UP" if ever introduced) stays
  // unmapped until we have a rule for it.
  { name: 'STEP', code: 'S01', perVent: false,
    test: s => /^STEP\s*$/i.test(s) },
  // RFU — Remote Fan Unit. ADDITIVE: most E/ENV booth BOMs already include
  // one F14 (the inner-shell RFU) by default. This rule fires only when
  // "RFU" appears as an explicit quote line — e.g. ordering a replacement
  // for an existing booth, or doubling up — and adds another F14 per line.
  { name: 'RFU', code: 'F14', perVent: false,
    test: s => /^RFU\s*$/i.test(s) },
  // BASS TRAPS — each quote line adds one E16 (BASS TRAP 2 W/ VELCRO, 5 lb;
  // pack contains 2 bass traps). Some presets bump line qty (Practice/Drum
  // → qty 3 or 4), which multiplies through here.
  { name: 'BASS TRAPS', code: 'E16', perVent: false,
    test: s => /^BASS\s+TRAPS?\s*$/i.test(s) },
  // Audimute acoustic panels (the standalone AUDI BL/GR panels — NOT the AP
  // acoustic-treatment package). Quote line "AUDI BL 2 / BL 3 / GR 2 / GR 3" →
  // the matching AUDIMUTE pack: E18 (BL 2) / E19 (BL 3) / E20 (GR 2) / E21 (GR 3).
  // One pack per line × line qty — the "2"/"3" is the panel count in the pack,
  // not a multiplier.
  { name: 'AUDI', perVent: false,
    test: s => /^AUDI\s+(BL|GR)\s+[23]\b/i.test(s),
    code: s => {
      const m = /^AUDI\s+(BL|GR)\s+([23])/i.exec(s);
      return { BL2: 'E18', BL3: 'E19', GR2: 'E20', GR3: 'E21' }[m[1].toUpperCase() + m[2]];
    } },
  // AP (Acoustic Package) is dropshipped by Audimute — it never ships on the
  // booth PL. Recognize it so it isn't flagged as an unmapped "add manually"
  // feature, but add nothing. (Its quote weight is excluded from the PL weight
  // check too — see /api/packing-list.)
  { name: 'AP', test: s => /^AP\b/i.test(s),
    resolve: () => ({ additions: [], removals: [] }) },
  // RM (Roof Mount Ventilation). Quote line is "RM <booth-size> <variant>"
  // (e.g. "RM 4260 E") or bare "RM". Triggers two BOM transformations:
  //   1. Every ceiling component in the booth's BOM swaps to its `... RM`
  //      variant (outer + inner shell). RM_CEILING_MAP handles both STD
  //      A-codes and IEP I-codes.
  //   2. Every plain VNT wall (outer C* / inner K*) swaps to the matching
  //      CBL wall of the same size. VNT NV is intentionally left alone.
  //   3. Adds one EFS (F03) per vent set (booth's F01 qty). An exhaust-fan
  //      silencer ships with each vent set under Roof Mount to prevent noise
  //      transfer into the booth — it isn't in the base BOM, so RM adds it.
  //      NV booths have 0 vent sets, so nothing is added there.
  // Fires once regardless of line qty (the transform is qty-invariant — a
  // booth either has roof-mount or it doesn't). If two RM lines somehow
  // both appear, only one swap happens because the second pass finds nothing
  // to remove.
  { name: 'RM',
    test: s => /^RM(\s+\d|\s*$)/i.test(s),
    resolve: (name, _lineQty, ctx) => {
      const additions = [];
      const removals = [];
      const swapped = new Set();
      for (const code of Object.keys(ctx.bomComponents || {})) {
        const qty = ctx.bomComponents[code] || 0;
        if (qty <= 0 || swapped.has(code)) continue;
        const rmCode = RM_CEILING_MAP[code] || CBL_WALL_MAP[code];
        if (!rmCode) continue;
        for (let i = 0; i < qty; i++) {
          removals.push(code);
          additions.push({ code: rmCode, fromFeature: name });
        }
        swapped.add(code);
      }
      // EFS (F03) — one per vent set, comes with RM ventilation.
      const ventSets = Math.max(0, ctx.ventCount || 0);
      for (let i = 0; i < ventSets; i++) additions.push({ code: 'F03', fromFeature: name });
      return { additions, removals };
    } },
  // RAMP — 3-box ramp system (matches the ENT PL example: rows 26–28).
  // Quote line "RAMP" or "WA RAMP" → Z62 + Z63 + Z64 as three rows
  // (RAMP WITH ADAPTER + 2 MIDDLE RAMPS + 3 LOWER RAMPS = 6 ramp pieces in
  // 3 boxes). The future ADA rule will cascade through this same code-set.
  // Z07/Z08 (Type-A/B small ramps) and Z39 (single-piece ADA RAMP) are
  // retired and intentionally unused. "RAMP SYS" stays unmapped.
  { name: 'RAMP',
    test: s => /^(WA\s+)?RAMP\s*$/i.test(s),
    resolve: (name, lineQty, _ctx) => {
      const additions = [];
      for (let i = 0; i < lineQty; i++) {
        ['Z62','Z63','Z64'].forEach(code => additions.push({ code, fromFeature: name }));
      }
      return { additions, removals: [] };
    } },
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
  // WA Door (Wide-Access upgrade). Quote line looks like
  //   "WA UPG STD 40" / "WA UPG STD 46" / "WA UPG ENH 40" / "WA UPG ENH 46"
  // (size = outer wall size; STD = single-shell, ENH = double-shell). Bare
  // "WA UPG" falls back to booth's primary wall + variant.
  //
  // The wide-access door IS the ADA door: the old WA-only door codes Z03–Z11
  // are RETIRED — pull the ADA door components (the same ones the oracle-verified
  // ADA package uses; a 46" booth here reproduces that package's door section
  // byte-for-byte).
  //
  // Outer-shell swap (always):
  //   • std door (any of C113 / C115 / C14 / C15 / C16 / C17) →
  //       Z32 (R) or Z33 (L) — ADA STD DOOR W/WINDOW, picked from room hinge.
  //   • std doorframe wall (any of C07 / C08 / C114 / C116) →
  //       Z30 (R) or Z31 (L) — ADA STD DOOR FRAME.
  //   • add ONE ADA DOOR FRAME ADAPTOR: Z37 for 40" walls, Z38 for 46" walls.
  //
  // Inner-shell swap (only if booth variant is E/ENV — has IEP shell):
  //   • IEP door (M01 / M02 / K114 / K115) → Z35 (R) or Z36 (L) — ADA IEP DOOR.
  //   • IEP jamb (L01 / K116) → Z34 — ADA IEP DOOR JAMB.
  //   • add ONE Z19 (WA JAMB ADPTR / IEP MID-WALL SEAM SEAL) — ONLY on 4016.
  //
  // Excludes "WA RAMP" (separate feature, doesn't match the UPG anchor).
  { name: 'WA',
    test: s => /^WA\s+UPG\b/i.test(s),
    resolve: (name, lineQty, ctx) => {
      const m = /^WA\s+UPG(?:\s+(STD|ENH))?(?:\s+(\d{2}))?/i.exec(name);
      const featureWall = m && m[2] ? parseInt(m[2], 10) : null;
      const wallSize = featureWall || ctx.primaryWallSize;
      if (wallSize !== 40 && wallSize !== 46) return null;   // 43" booths don't have WA

      // First STD door / DRFRM the booth's BOM carries — pick whichever
      // L/R is present (today base BOMs ship R-default; future hinge swap
      // rule may flip them).
      const doorCodes  = ['C113','C115','C14','C15','C16','C17'];
      const drfrmCodes = ['C07','C08','C114','C116'];
      const doorToRemove  = doorCodes.find(c  => (ctx.bomComponents[c]  || 0) > 0) || null;
      const drfrmToRemove = drfrmCodes.find(c => (ctx.bomComponents[c] || 0) > 0) || null;
      if (!doorToRemove || !drfrmToRemove) return null;

      const isLeft = String(ctx.hinge || '').toLowerCase() === 'left';
      // Retired WA codes Z03–Z11 → ADA door codes (the WA door is the ADA door).
      const waDoor   = isLeft ? 'Z33' : 'Z32';   // ADA STD DOOR W/WINDOW
      const waDrfrm  = isLeft ? 'Z31' : 'Z30';   // ADA STD DOOR FRAME
      const adapter  = wallSize === 46 ? 'Z38' : 'Z37';   // ADA DOOR FRAME ADAPTOR (B/A)

      const additions = [];
      const removals = [];
      for (let i = 0; i < lineQty; i++) {
        additions.push({ code: waDoor,  fromFeature: name });
        additions.push({ code: waDrfrm, fromFeature: name });
        additions.push({ code: adapter, fromFeature: name });
        removals.push(doorToRemove);
        removals.push(drfrmToRemove);
      }

      // Narrow-wall shrink. WA STDDRFRM is 49" wide, so an adjacent narrow
      // wall on the same long side has to flip to keep the booth interior
      // length conserved:
      //   • 46" booths: C111 STDWL22 (22") → C112 STDWL19 (19"). 3" shrink.
      //                 46+22 = 49+19 = 68". Inner: K112 → K113 (E/ENV).
      //   • 40" booths: C10  STDWL16 (16") → Z02 STDWL7 / WL16 — a 2-piece
      //                 bundle (7" + 16" walls shipped together, 45 lb).
      //                 The 7" piece becomes the new narrow on the WA side
      //                 (40+16=56 → 49+7=56); the 16" piece in the bundle
      //                 replaces the inventory of the C10 that was removed,
      //                 so total 16"-wall count stays the same.
      //                 Inner shell: NO IEP bundle equivalent exists in the
      //                 components master (Z02-style packs only exist for
      //                 height-extension EXT codes — no plain wall bundles),
      //                 so K09 IEPWL11.5 stays put on 40" E/ENV booths.
      // The door-adjacent wall that shrinks depends on the WA Type. Both wall
      // families are dual-option: 46" booths are 4646 (door-adjacent 46"→43",
      // C101→C109) or 4622 (22"→19", C111→C112); 40" booths (42/60/84/102 series)
      // are 4040 (40"→31", C01→Z01 — this makes the 31" wall a "WDO 31\" 1648"
      // window swaps) or 4016 (16"→7", C10→Z02). The quote's WA Type
      // (ctx.adaWaType, from repWaType) OVERRIDES; absent that, default from the
      // booth — the narrow variant (4622/4016) only if it actually carries the
      // 22"/16" wall, else the 46/40-pair variant (4646/4040).
      let narrow = null, waType = null;
      if (wallSize === 46) {
        waType = (ctx.adaWaType === '4646' || ctx.adaWaType === '4622') ? ctx.adaWaType
               : ((ctx.bomComponents['C111'] || 0) > 0 ? '4622' : '4646');
        narrow = waType === '4646'
          ? { stdOuter: 'C101', waOuter: 'C109', stdInner: 'K101', waInner: 'K110' }
          : { stdOuter: 'C111', waOuter: 'C112', stdInner: 'K112', waInner: 'K113' };
      } else if (wallSize === 40) {
        waType = (ctx.adaWaType === '4040' || ctx.adaWaType === '4016') ? ctx.adaWaType
               : ((ctx.bomComponents['C10'] || 0) > 0 ? '4016' : '4040');
        narrow = waType === '4040'
          ? { stdOuter: 'C01', waOuter: 'Z01', stdInner: 'K01', waInner: 'Z15' }
          : { stdOuter: 'C10', waOuter: 'Z02', stdInner: null,  waInner: null };
      }
      if (narrow && (ctx.bomComponents[narrow.stdOuter] || 0) > 0) {
        for (let i = 0; i < lineQty; i++) {
          removals.push(narrow.stdOuter);
          additions.push({ code: narrow.waOuter, fromFeature: name });
        }
      }

      // Inner shell on E / ENV. The inner-door code family depends on outer
      // wall size:
      //   • 40" outer (IEPWL35.5 family) → M01 (R) / M02 (L) door + L01 jamb
      //   • 46" outer (IEPWL41.5 family) → K114 (R) / K115 (L) door + K116 jamb
      // We just look for whichever is actually in the BOM.
      if (ctx.variant === 'E' || ctx.variant === 'ENV') {
        const iepDoorCodes = ['M01','M02','K114','K115'];
        const iepJambCodes = ['L01','K116'];
        const iepDoorToRemove = iepDoorCodes.find(c => (ctx.bomComponents[c] || 0) > 0) || null;
        const iepJambToRemove = iepJambCodes.find(c => (ctx.bomComponents[c] || 0) > 0) || null;
        const waIepDoor = isLeft ? 'Z36' : 'Z35';   // ADA IEP DOOR W/WINDOW (R/L)
        for (let i = 0; i < lineQty; i++) {
          if (iepDoorToRemove) {
            additions.push({ code: waIepDoor, fromFeature: name });
            removals.push(iepDoorToRemove);
          }
          if (iepJambToRemove) {
            additions.push({ code: 'Z34', fromFeature: name });   // ADA IEP DOOR JAMB
            removals.push(iepJambToRemove);
          }
          // Z19 (WA JAMB ADPTR / 1-IEP MID-WALL SEAM SEAL) is added ONLY on the
          // 4016 WA Type (40" enhanced). On 4040 and the 46" types the inner jamb
          // swap above (Z34) is all that's needed — the ADA package never ships
          // Z19. On 4016 the inner 11.5" wall (K09) and one mid-wall seam seal
          // (O01) are so small they merge INTO the combined Z19, so drop one K09 +
          // one O01 when we add it. (Benton.)
          if (waType === '4016') {
            additions.push({ code: 'Z19', fromFeature: name });
            if ((ctx.bomComponents['K09'] || 0) > 0) removals.push('K09');
            if ((ctx.bomComponents['O01'] || 0) > 0) removals.push('O01');
          }
          // Inner narrow-wall shrink (paired with the outer narrow swap above).
          // Fires when narrow.stdInner is set: 46" booths, and 40" booths on the
          // 4040 WA Type (K01 IEPWL35.5 → Z15 IEPWL26.5).
          if (narrow && narrow.stdInner && (ctx.bomComponents[narrow.stdInner] || 0) > 0) {
            removals.push(narrow.stdInner);
            additions.push({ code: narrow.waInner, fromFeature: name });
          }
        }
      }

      return { additions, removals };
    } },
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
      if (!stdCode || !winCode) return null;
      // Normally the wall must be in the booth's base BOM. But for an EXPLICIT
      // wall size ("WDO 43\" 2636", "WDO 31\" 1648") the 43"/31" wall is created
      // by ADA/WA this same build — proceed and let the removal cancel that
      // feature's pending wall addition (see generate()).
      const hasStd = ctx.bomComponents && (ctx.bomComponents[stdCode] || 0) > 0;
      if (!hasStd && explicitWall == null) return null;
      const additions = [], removals = [];
      for (let i = 0; i < lineQty; i++) {
        additions.push({ code: winCode, fromFeature: name });
        removals.push(stdCode);
      }

      // E / ENV double-shell variants: also swap the INNER IEP wall.
      // Inner wall size = outer − 4.5. Single-piece bundle handles the
      // smallest WDO size in each IEP family (e.g. K02 for 2630); larger
      // WDO sizes need TOP + BOT (e.g. K05 + K06). If the BOM doesn't carry
      // the bare IEP wall, leave the inner shell alone (the outer swap
      // still runs — the user can hand-fix the IEP side from the flag).
      if (ctx.variant === 'E' || ctx.variant === 'ENV') {
        const inner = outerToInnerWallSize(wallSize);
        const iepStd = inner ? ctx.iepWallBySize[inner] : null;
        if (iepStd && ((ctx.bomComponents[iepStd] || 0) > 0 || explicitWall != null)) {
          const jack = /\bJACK\b/i.test(name);
          const key = inner + ':' + wdoSize + (jack ? ':JACK' : '');
          const iepSingle = ctx.iepWindowSingle[key];
          const iepTop    = ctx.iepWindowTop[key];
          const iepBot    = ctx.iepWallBotBySize[inner];
          for (let i = 0; i < lineQty; i++) {
            if (iepSingle) {
              additions.push({ code: iepSingle, fromFeature: name });
              removals.push(iepStd);
            } else if (iepTop && iepBot) {
              additions.push({ code: iepTop, fromFeature: name });
              additions.push({ code: iepBot, fromFeature: name });
              removals.push(iepStd);
            }
            // If neither lookup hit, skip the inner swap silently — the
            // outer wall is still corrected; inner shell stays as-is.
          }
        }
      }

      return { additions, removals };
    } },
  // CP — Caster Plate. Quote line "CP <size>" (e.g. "CP 7272"). Pure ADD of the
  // model's caster-plate panels (G*) + casters/hardware (H*), from CP_BY_MODEL.
  // Fire-once per booth (the set is a property of the model, not the line qty).
  { name: 'CP', once: true,
    test: s => /^CP\b/i.test(s),
    resolve: (name, _lineQty, ctx) => {
      const set = CP_BY_MODEL[featureModelKey(ctx.bomKey)];
      if (!set) return null;   // unknown model → leave the feature flagged
      const additions = [];
      for (const [code, qty] of Object.entries(set))
        for (let i = 0; i < qty; i++) additions.push({ code, fromFeature: name });
      return { additions, removals: [] };
    } },
  // SL — Studio Lights. Quote line "SL <size>". REPLACE: removes the regular
  // light(s) (T01) and adds the model's sized studio lights (T07 29" / T08 52"),
  // from SL_BY_MODEL. Net is a weight GAIN (SL heavier than the light it
  // replaces). Fire-once per booth.
  { name: 'SL', once: true,
    test: s => /^SL\b/i.test(s),
    resolve: (name, _lineQty, ctx) => {
      const rec = SL_BY_MODEL[featureModelKey(ctx.bomKey)];
      if (!rec) return null;
      const additions = [], removals = [];
      for (const [code, qty] of Object.entries(rec.remove || {}))
        for (let i = 0; i < qty; i++) removals.push(code);
      for (const [code, qty] of Object.entries(rec.add || {}))
        for (let i = 0; i < qty; i++) additions.push({ code, fromFeature: name });
      return { additions, removals };
    } },
  // HX — Height Extension. Quote line "HX <size> <variant>" / "HX <size> IEP".
  // Three transforms, all fire-once per booth:
  //   1. Seam seals → Tall: every base seam in the BOM (D01/D02/N01/O01 + LP/
  //      single variants) swaps to its "(T)" code via FEATURE_SEAM_SWAP.
  //   2. Hardware → HX: the booth's HDWR kit swaps to its "W/ HX" code
  //      (HX_HARDWARE_SWAP, built from packs — covers S/E/SNV/ENV).
  //   3. Extensions: add the model's wall-height-extension boxes (C*/K*, 2 per
  //      box) from HX_EXT_BY_MODEL.
  // Qty-invariant (a booth either has HX or not). The "HX … IEP" line that some
  // quotes carry alongside "HX … S/E" is swallowed by the fire-once guard.
  // (HX+WA extension re-sizing to the shrunken WA walls is a deferred combo.)
  { name: 'HX', once: true,
    test: s => /^HX\b/i.test(s),
    resolve: (name, _lineQty, ctx) => {
      const bom = ctx.bomComponents || {};
      const additions = [], removals = [];
      const swap = (map) => {
        const done = new Set();
        for (const code of Object.keys(bom)) {
          const to = map[code];
          if (!to || done.has(code)) continue;
          const qty = bom[code] || 0;
          for (let i = 0; i < qty; i++) { removals.push(code); additions.push({ code: to, fromFeature: name }); }
          done.add(code);
        }
      };
      swap(FEATURE_SEAM_SWAP);   // 1. seams → Tall
      swap(HX_HARDWARE_SWAP);    // 2. hardware → W/ HX
      const ext = HX_EXT_BY_MODEL[featureModelKey(ctx.bomKey)];   // 3. extension boxes
      if (ext) for (const [code, qty] of Object.entries(ext))
        for (let i = 0; i < qty; i++) additions.push({ code, fromFeature: name });
      if (!additions.length && !removals.length) return null;   // nothing matched → flag
      return { additions, removals };
    } },
  // ADA — Quote line "ADA <size> <variant>" (only on the 72 & 96 series). The full
  // ADA package per booth, from ADA_BY_MODEL: ADA door swap (std C113/C114 →
  // Z30/Z32/Z38; inner E K114/K116 → Z34/Z35), WA narrow-wall shrink (4646
  // C101→C109 / K101→K110, 4622 C111→C112 / K112→K113), the 3-box ramp
  // (Z62/Z63/Z64), and the elevated floor (corner Z40 + center Z42/Z43 + side
  // Z44/Z45/Z46, sized to the footprint, + the standard-only perimeter strips
  // Z48–Z55). Fire-once. WA Type follows ADAType's per-model default (7296=4622).
  // Codes are R-hinge (base default); L-hinge ADA (Z31/Z33 family) is a follow-up.
  { name: 'ADA', once: true,
    test: s => /^ADA\b/i.test(s),
    resolve: (name, _lineQty, ctx) => {
      const fkey = featureModelKey(ctx.bomKey);
      // Dual-option booths (7296 / 96120 / 96168) carry both WA-Type variants; the
      // order's WA Type (ctx.adaWaType, from the quote's repWaType) picks 4646 vs
      // 4622. Single-option booths and the no-WA-Type case use the default.
      const variants = ADA_WA_VARIANTS[fkey];
      const rec = (variants && ctx.adaWaType && variants[ctx.adaWaType]) || ADA_BY_MODEL[fkey];
      if (!rec) return null;   // not an ADA-eligible model → leave flagged
      const additions = [], removals = [];
      for (const [code, qty] of Object.entries(rec.remove || {}))
        for (let i = 0; i < qty; i++) removals.push(code);
      for (const [code, qty] of Object.entries(rec.add || {}))
        for (let i = 0; i < qty; i++) additions.push({ code, fromFeature: name });
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
  const firedOnce = new Set();   // booth-level rules (CP/SL/HX) apply once per booth
  (features || []).forEach(f => {
    const name = String(f?.name || '').trim();
    const lineQty = Math.max(1, parseInt(f.qty, 10) || 1);
    const rule = FEATURE_SUBS.find(r => r.test(name));
    if (!rule) { remaining.push(f); return; }
    // Fire-once rules: a booth may list the same feature twice (e.g. "HX … S"
    // + "HX … IEP"); apply the transform only once, swallow the duplicate.
    if (rule.once && firedOnce.has(rule.name)) return;
    // Custom resolver — full control over additions + removals.
    if (typeof rule.resolve === 'function') {
      const res = rule.resolve(name, lineQty, ctx);
      if (!res) { remaining.push(f); return; }
      (res.additions || []).forEach(a => additions.push(a));
      (res.removals || []).forEach(r => removals.push(r));
      if (rule.once) firedOnce.add(rule.name);
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
        bomKey: key,
        adaWaType: opts.adaWaType,
        ventCount: (BASE_BOM[key]?.components?.F01) || 0,
        primaryWallSize: primaryWallSize(key),
        variant: BASE_BOM[key]?.variant || '',
        hinge: (opts.hinge || DEFAULTS.hinge),
        stdWallBySize: STD_WALL_BY_SIZE,
        windowMap: WINDOW_WALL,
        iepWallBySize: IEP_WALL_BY_SIZE,
        iepWindowTop: IEP_WINDOW_TOP,
        iepWindowSingle: IEP_WINDOW_SINGLE,
        iepWallBotBySize: IEP_WALL_BOT_BY_SIZE,
        bomComponents: BASE_BOM[key]?.components || {},
      };
      const { remaining, additions, removals } = applyFeatureSubs(room.features, ctx);
      // Removals first — each takes out ONE matching line (each line = 1 item).
      // If the code isn't in the base BOM, cancel a pending ADDITION of the same
      // code instead — this lets one feature swap a wall ANOTHER feature created
      // in the same build (e.g. WDO 43" puts a window in the 43" wall ADA made).
      removals.forEach(rmCode => {
        const idx = lines.findIndex(l => l.code === rmCode);
        if (idx >= 0) {
          const removed = lines.splice(idx, 1)[0];
          if (removed && removed.eachLb != null) netLb = (netLb || 0) - removed.eachLb;
          return;
        }
        const ai = additions.findIndex(a => a.code === rmCode);
        if (ai >= 0) additions.splice(ai, 1);
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
      // Foam color swap — config-driven, like hinge. Base BOMs ship Gray
      // (bare FOAM{N}). Any other color rewrites the foam line(s) to the
      // matching colored variant. Same size, same dims, same weight (only
      // the pack name + desc differ across colors).
      const foamColor = String(opts.foam || DEFAULTS.foam);
      if (foamColor && foamColor !== 'Gray') {
        lines = lines.map(line => {
          const pack = String(COMPONENTS[line.code]?.pack || '');
          const m = pack.match(/^FOAM(\d+)$/);   // only swap Gray-default
          if (!m) return line;
          const newCode = FOAM_BY_SIZE_COLOR[m[1] + ':' + foamColor];
          if (!newCode || newCode === line.code) return line;
          const newC = COMPONENTS[newCode] || {};
          const newLb = (newC.lb == null) ? null : Number(newC.lb);
          if (line.eachLb != null && newLb != null) {
            netLb = (netLb || 0) - line.eachLb + newLb;
          }
          return {
            ...line,
            code: newCode,
            desc: newC.desc || line.desc,
            pack: newC.pack || line.pack,
            eachLb: newLb,
            L: newC.L ?? line.L, W: newC.W ?? line.W, T: newC.T ?? line.T,
            known: !!COMPONENTS[newCode],
            foamColored: foamColor,
          };
        });
      }

      // Hinge swap — config-driven (no quote feature line triggers it).
      // Walk the post-substitution lines and flip any remaining R-default
      // codes to their L counterparts. WA/ADA already picked L/R via
      // ctx.hinge, so this only affects untouched base BOM rows.
      if (String(ctx.hinge || '').toLowerCase() === 'left') {
        lines = lines.map(line => {
          const lCode = HINGE_R_TO_L[line.code];
          if (!lCode) return line;
          const c = COMPONENTS[lCode] || {};
          const newLb = (c.lb == null) ? null : Number(c.lb);
          if (line.eachLb != null && newLb != null) {
            netLb = (netLb || 0) - line.eachLb + newLb;
          }
          return {
            ...line,
            code: lCode,
            desc: c.desc || line.desc,
            pack: c.pack || line.pack,
            eachLb: newLb,
            L: c.L ?? null, W: c.W ?? null, T: c.T ?? null,
            known: !!COMPONENTS[lCode],
            hingeFlipped: true,
          };
        });
      }

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
  // A booth LINE with qty N is N physical booths — expand to one PL per unit so
  // each gets its own page, S/N, and label set (e.g. 5× the same model = 5 PLs,
  // not one ×5 page). Lines are identical across units; the client gets an
  // independent copy of each via JSON serialization.
  const units = [];
  out.forEach(r => {
    const n = Math.max(1, r.qty || 1);
    for (let u = 1; u <= n; u++) units.push({ ...r, qty: 1, unit: n > 1 ? { n: u, of: n } : null });
  });
  units.forEach((r, i) => { r.index = i + 1; });

  const grandNet = units.reduce((s, r) => s + (r.netLb || 0), 0);
  // Box count = total PL rows across all booths (each row = one numbered box).
  // Hardware Box # = the 1-based row number of the booth hardware kit (the
  // HDWR <model> pack, not HDWR EXP) in the FIRST booth's PL — the PL's "#"
  // column is the box numbering, and the rows are code-sorted.
  let boxCount = 0;
  units.forEach(r => { r.boxCount = (r.lines || []).length; boxCount += r.boxCount; });
  let hardwareBox = null;
  const firstRoom = units[0];
  if (firstRoom && Array.isArray(firstRoom.lines)) {
    const isHdwr = l => /^HDWR\s+(?!EXP)/i.test(COMPONENTS[l.code]?.pack || '');
    let hi = firstRoom.lines.findIndex(isHdwr);
    if (hi < 0) hi = firstRoom.lines.findIndex(l => /^HDWR\b/i.test(COMPONENTS[l.code]?.pack || ''));
    if (hi >= 0) hardwareBox = hi + 1;
  }
  // Ship only the layouts referenced by this quote's rooms (keyed by full booth
  // name; the frontend doesn't need to know about variant fallback).
  const layouts = {};
  units.forEach(r => {
    if (!r.boothName || layouts[r.boothName]) return;
    const l = boothLayout(r.boothName);
    if (l) layouts[r.boothName] = l;
  });
  return {
    rooms: units,
    orphanFeatures,
    totals: { rooms: units.length, netLb: Math.round(grandNet * 100) / 100, boxCount, hardwareBox },
    defaults: DEFAULTS,
    options: { hinge: HINGE_OPTIONS, foam: FOAM_OPTIONS },
    layouts,
  };
}

// Lightweight component dictionary for the viewer's "add a component" picker.
function componentDict() { return COMPONENTS; }

module.exports = { init, generate, parseRooms, applyFeatureSubs, componentDict, boothLayout, DEFAULTS, HINGE_OPTIONS, FOAM_OPTIONS, FEATURE_SUBS };
