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
  buildWallMaps();
  buildIepMaps();
  buildFoamMap();
  buildRmMaps();
}

// Look up the top-down layout for a booth name. Tries exact match first, then
// falls back to variant-stripped match (S/E/SNV/ENV share the same outer shell,
// so a single "MDL 4872 S" entry covers all four variants by default).
function boothLayout(name) {
  const exact = BOOTH_LAYOUTS[name];
  if (exact) return exact;
  const m = String(name || '').match(/^(MDL\s+\S+)\s+(S|E|SNV|ENV)$/i);
  if (m) {
    const stripped = m[1] + ' S';   // canonical fallback key is the S variant
    if (BOOTH_LAYOUTS[stripped]) return BOOTH_LAYOUTS[stripped];
    const stripped2 = m[1];
    if (BOOTH_LAYOUTS[stripped2]) return BOOTH_LAYOUTS[stripped2];
  }
  return null;
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
  // RM (Roof Mount Ventilation). Quote line is "RM <booth-size> <variant>"
  // (e.g. "RM 4260 E") or bare "RM". Triggers two BOM transformations:
  //   1. Every ceiling component in the booth's BOM swaps to its `... RM`
  //      variant (outer + inner shell). RM_CEILING_MAP handles both STD
  //      A-codes and IEP I-codes.
  //   2. Every plain VNT wall (outer C* / inner K*) swaps to the matching
  //      CBL wall of the same size. VNT NV is intentionally left alone.
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
  // Outer-shell swap (always):
  //   • std door (any of C113 / C115 / C14 / C15 / C16 / C17) →
  //       Z05 (R) or Z06 (L) — picked from room hinge.
  //   • std doorframe wall (any of C07 / C08 / C114 / C116) →
  //       Z03 (R) or Z04 (L).
  //   • add ONE adapter: Z25 for 40" walls, Z120 for 46" walls.
  //
  // Inner-shell swap (only if booth variant is E/ENV — has IEP shell):
  //   • IEP door (M01 / M02) → Z10 (R) or Z11 (L).
  //   • IEP jamb (L01) → Z09.
  //   • add ONE Z19 (WAJMBAD/IEPSSMID).
  //   (Z20–Z24 are HX/extension variants — defer to a later rule.)
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
      const waDoor   = isLeft ? 'Z06' : 'Z05';
      const waDrfrm  = isLeft ? 'Z04' : 'Z03';
      const adapter  = wallSize === 46 ? 'Z120' : 'Z25';

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
      const narrow = wallSize === 46
        ? { stdOuter: 'C111', waOuter: 'C112', stdInner: 'K112', waInner: 'K113' }
        : wallSize === 40
          ? { stdOuter: 'C10',  waOuter: 'Z02',  stdInner: null,   waInner: null }
          : null;
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
        const waIepDoor = isLeft ? 'Z11' : 'Z10';
        for (let i = 0; i < lineQty; i++) {
          if (iepDoorToRemove) {
            additions.push({ code: waIepDoor, fromFeature: name });
            removals.push(iepDoorToRemove);
          }
          if (iepJambToRemove) {
            additions.push({ code: 'Z09', fromFeature: name });
            removals.push(iepJambToRemove);
          }
          additions.push({ code: 'Z19', fromFeature: name });
          // Inner narrow-wall shrink (paired with the outer narrow swap above).
          // 46" only — see narrow definition comment for the 40" rationale.
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
      // If the booth doesn't have the std wall in its BOM, swap can't happen.
      if (!stdCode || !winCode) return null;
      const hasStd = ctx.bomComponents && (ctx.bomComponents[stdCode] || 0) > 0;
      if (!hasStd) return null;
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
        if (iepStd && (ctx.bomComponents[iepStd] || 0) > 0) {
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
  const grandNet = out.reduce((s, r) => s + ((r.netLb || 0) * (r.qty || 1)), 0);
  // Ship only the layouts referenced by this quote's rooms (keeps the wire
  // payload small as more layouts are added). Keyed by full booth name so
  // the frontend doesn't have to know about variant fallback.
  const layouts = {};
  out.forEach(r => {
    if (!r.boothName || layouts[r.boothName]) return;
    const l = boothLayout(r.boothName);
    if (l) layouts[r.boothName] = l;
  });
  return {
    rooms: out,
    orphanFeatures,
    totals: { rooms: out.length, netLb: Math.round(grandNet * 100) / 100 },
    defaults: DEFAULTS,
    options: { hinge: HINGE_OPTIONS, foam: FOAM_OPTIONS },
    layouts,
  };
}

// Lightweight component dictionary for the viewer's "add a component" picker.
function componentDict() { return COMPONENTS; }

module.exports = { init, generate, parseRooms, applyFeatureSubs, componentDict, boothLayout, DEFAULTS, HINGE_OPTIONS, FOAM_OPTIONS, FEATURE_SUBS };
