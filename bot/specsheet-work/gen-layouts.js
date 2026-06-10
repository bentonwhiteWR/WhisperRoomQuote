// Generate lib/pl-data/booth-layouts.json (v2 schema) from the spec-sheet
// digitization. Raw data below was extracted from the page-3 top-down views of
// the 52 MDL spec sheets (C:\Users\bento\Documents\Claude\WR PO System\SpecSheets).
//
// Schema v2 (keyed by SIZE, variant resolved at lookup):
//   "MDL 4872": {
//     label, module(40|46), exterior{w,h},
//     variants: { S:{wallThickness,interior{w,h}}, E:{wallThickness,interior{w,h}} },
//     door:{wall,swing},
//     walls: { N/S/E/W: { label, slots:[{id,size,kind,prefers}] } }
//   }
// SNV→S, ENV→E (no vent) handled by the renderer (vent drawn only where a VNT
// pack actually places). Panels stored from the S geometry and scaled to the
// active variant's interior at render time.
const fs = require('fs');
const path = require('path');

// kind: V=vent, D=door, S=solid.  Each wall = array of [size, kindChar].
const RAW = {
  // ── 40" module, 102-series (ext height 104) ──────────────────────
  '102102': { mod:40, ext:[104,104], door:24,
    N:[[40,'V'],[16,'S'],[40,'V']], S:[[40,'D'],[16,'S'],[40,'S']], E:[[40,'V'],[16,'S'],[40,'S']], W:[[40,'S'],[16,'S'],[40,'S']] },
  '102126': { mod:40, ext:[128,104], door:24,
    N:[[40,'V'],[40,'V'],[44,'V']], S:[[40,'D'],[40,'S'],[44,'S']], E:[[40,'V'],[16,'S'],[40,'S']], W:[[40,'S'],[16,'S'],[40,'S']] },
  '102144': { mod:40, ext:[146,104], door:24,
    N:[[40,'V'],[40,'V'],[22,'S'],[40,'V']], S:[[40,'D'],[40,'S'],[22,'S'],[40,'S']], E:[[40,'V'],[16,'S'],[40,'S']], W:[[40,'S'],[16,'S'],[40,'S']] },
  '102168': { mod:40, ext:[170,104], door:24,
    N:[[40,'V'],[40,'V'],[40,'V'],[46,'V']], S:[[40,'D'],[40,'S'],[40,'S'],[46,'S']], E:[[40,'S'],[16,'S'],[40,'S']], W:[[40,'S'],[16,'S'],[40,'S']] },
  '102186': { mod:40, ext:[188,104], door:24,
    N:[[40,'V'],[40,'V'],[24,'S'],[40,'V'],[40,'V']], S:[[40,'D'],[40,'S'],[24,'S'],[40,'S'],[40,'S']], E:[[40,'S'],[16,'S'],[40,'S']], W:[[40,'S'],[16,'S'],[40,'S']] },
  '10284': { mod:40, ext:[86,104], door:24,
    N:[[41,'V'],[41,'V']], S:[[41,'D'],[41,'S']], E:[[40,'V'],[16,'S'],[40,'S']], W:[[40,'S'],[16,'S'],[40,'S']] },

  // ── 40" module, small / mid ──────────────────────────────────────
  '4230': { mod:40, ext:[44,32], door:24,
    N:[[40,'V']], S:[[40,'D']], E:[[28,'S']], W:[[28,'S']] },
  '4242': { mod:40, ext:[44,44], door:24,
    N:[[40,'V']], S:[[40,'D']], E:[[40,'S']], W:[[40,'S']] },
  '4260': { mod:40, ext:[62,44], door:24,
    N:[[40,'V'],[18,'S']], S:[[40,'D'],[18,'S']], E:[[40,'S']], W:[[40,'S']] },
  '4284': { mod:40, ext:[86,44], door:24,
    N:[[41,'V'],[41,'V']], S:[[41,'D'],[41,'S']], E:[[40,'S']], W:[[40,'S']] },
  '6060': { mod:40, ext:[62,62], door:24,
    N:[[40,'V'],[18,'S']], S:[[40,'D'],[18,'S']], E:[[40,'V'],[18,'S']], W:[[40,'S'],[18,'S']] },
  '6084': { mod:40, ext:[86,62], door:24,
    N:[[40,'V'],[42,'V']], S:[[40,'D'],[42,'S']], E:[[40,'S'],[18,'S']], W:[[40,'S'],[18,'S']] },
  '84102': { mod:40, ext:[104,86], door:24,
    N:[[40,'V'],[16,'S'],[40,'V']], S:[[40,'S'],[16,'S'],[40,'D']], E:[[40,'V'],[42,'S']], W:[[40,'S'],[42,'S']] },
  '84126': { mod:40, ext:[128,86], door:24,
    N:[[40,'V'],[40,'V'],[44,'V']], S:[[40,'S'],[40,'D'],[44,'S']], E:[[40,'V'],[42,'S']], W:[[40,'S'],[42,'S']] },
  '8484': { mod:40, ext:[86,86], door:24,
    N:[[40,'V'],[42,'V']], S:[[40,'D'],[42,'S']], E:[[40,'V'],[42,'S']], W:[[40,'S'],[42,'S']] },

  // ── 46" module, 48 / 72 / 96-series ──────────────────────────────
  '4848': { mod:46, ext:[50,50], door:30,
    N:[[46,'V']], S:[[46,'D']], E:[[46,'S']], W:[[46,'S']] },
  '4872': { mod:46, ext:[74,50], door:30,
    N:[[46,'V'],[24,'S']], S:[[46,'D'],[24,'S']], E:[[46,'S']], W:[[46,'S']] },
  '4896': { mod:46, ext:[98,50], door:30,
    N:[[46,'V'],[48,'V']], S:[[46,'D'],[48,'S']], E:[[46,'S']], W:[[46,'S']] },
  '7272': { mod:46, ext:[74,74], door:30,
    N:[[46,'V'],[24,'S']], S:[[46,'D'],[24,'S']], E:[[46,'V'],[24,'S']], W:[[46,'S'],[24,'S']] },
  '7296': { mod:46, ext:[98,74], door:30,
    N:[[46,'V'],[48,'V']], S:[[46,'D'],[48,'S']], E:[[46,'S'],[24,'S']], W:[[46,'S'],[24,'S']] },
  '9696': { mod:46, ext:[98,98], door:30,
    N:[[47,'V'],[47,'V']], S:[[47,'D'],[47,'S']], E:[[47,'V'],[47,'S']], W:[[47,'S'],[47,'S']] },
  '96120': { mod:46, ext:[122,98], door:30,
    N:[[46,'V'],[22,'S'],[46,'V']], S:[[46,'D'],[22,'S'],[46,'S']], E:[[47,'V'],[47,'S']], W:[[47,'S'],[47,'S']] },
  '96144': { mod:46, ext:[146,98], door:30,
    N:[[47.5,'V'],[47,'V'],[47.5,'V']], S:[[47.5,'D'],[47,'S'],[47.5,'S']], E:[[47,'V'],[47,'S']], W:[[47,'S'],[47,'S']] },
  '96168': { mod:46, ext:[170,98], door:30,
    N:[[46,'V'],[46,'V'],[28,'V'],[46,'S']], S:[[46,'D'],[46,'S'],[28,'S'],[46,'S']], E:[[47,'V'],[47,'S']], W:[[47,'S'],[47,'S']] },
  '96192': { mod:46, ext:[194,98], door:30,
    N:[[47.5,'V'],[47.5,'V'],[47.5,'V'],[47.5,'V']], S:[[47.5,'D'],[47.5,'S'],[47.5,'S'],[47.5,'S']], E:[[47,'S'],[47,'S']], W:[[47,'S'],[47,'S']] },
};

const SIZELABEL = {
  '4230':"3.5'×2.5'", '4242':"3.5'×3.5'", '4260':"3.5'×5'", '4284':"3.5'×7'",
  '4848':"4'×4'", '4872':"4'×6'", '4896':"4'×8'",
  '6060':"5'×5'", '6084':"5'×7'", '6060':"5'×5'",
  '7272':"6'×6'", '7296':"6'×8'", '8484':"7'×7'", '84102':"7'×8.5'", '84126':"7'×10.5'",
  '9696':"8'×8'", '96120':"8'×10'", '96144':"8'×12'", '96168':"8'×14'", '96192':"8'×16'",
  '10284':"8.5'×7'", '102102':"8.5'×8.5'", '102126':"8.5'×10.5'", '102144':"8.5'×12'",
  '102168':"8.5'×14'", '102186':"8.5'×15.5'",
};
const KINDNAME = { V:'VNT', D:'DRFRM', S:'SOLID' };
const PREFERS  = { V:['VNT'], D:['DRFRM'], S:['SOLID'] };

// Single-wall (S) interior = exterior − 4 (2" wall each side).
// Double-wall (E) interior = exterior − 8.5 (4.25" wall each side).
const S_OFFSET = 4, E_OFFSET = 8.5;
const round = n => Math.round(n * 100) / 100;

// Panels keep their TRUE SKU sizes verbatim (40/46/16/22...) — the renderers
// normalize per-wall at draw time, and the PL places by closest width, so
// true sizes beat span-scaled nominals (a 40 scaled to 41.67 would snap to
// the 43 wall family). Matches the v1.85.2 hand-fix that centered the real
// 16"/22" smalls between modules; sums may run a touch under the span.
function normWall(panels, span, sidePrefix) {
  return panels.map((p, i) => ({
    id: sidePrefix + i,
    size: round(p[0]),
    kind: KINDNAME[p[1]],
    prefers: PREFERS[p[1]],
  }));
}

const WALLLABEL = { N:'Back', S:'Front', E:'Right', W:'Left' };
const layouts = {};
for (const [size, d] of Object.entries(RAW)) {
  const [ew, eh] = d.ext;
  const intS = { w: ew - S_OFFSET, h: eh - S_OFFSET };
  const intE = { w: round(ew - E_OFFSET), h: round(eh - E_OFFSET) };
  const walls = {};
  for (const side of ['N', 'S', 'E', 'W']) {
    const span = (side === 'N' || side === 'S') ? intS.w : intS.h;
    walls[side] = { label: WALLLABEL[side], slots: normWall(d[side], span, side) };
  }
  layouts['MDL ' + size] = {
    label: 'Sound Booth' + (SIZELABEL[size] ? ' · ' + SIZELABEL[size] : ''),
    module: d.mod,
    exterior: { w: ew, h: eh },
    variants: {
      S: { wallThickness: S_OFFSET / 2, interior: intS },
      E: { wallThickness: round(E_OFFSET / 2), interior: intE },
    },
    door: { wall: 'S', swing: d.door },
    walls,
  };
}

const out = {
  _meta: {
    _source: 'Digitized from the 52 MDL spec-sheet top-down views (SpecSheets/, page 3), 2026-06-09.',
    _schema: {
      keyed_by: 'Size only (e.g. "MDL 4872"). boothLayout() in lib/packing-list.js resolves the S/E/SNV/ENV variant and attaches the resolved wallThickness + interior.',
      module: 'Wall panel module width: 40 or 46 inches. All wall panels of a module are interchangeable (per spec sheet).',
      exterior: 'Outer shell footprint in inches (same for S and E). w = horizontal (long axis as drawn), h = vertical.',
      variants: 'S (single-wall) and E (double-wall) each carry their own wallThickness + interior dims. SNV→S, ENV→E.',
      door: 'wall = which side holds the door (S = front). swing = door-leaf opening width in inches; the door opens OUTWARD.',
      walls: 'Keyed N(back/vent) S(front/door) E(right) W(left). Each slot: id, size(in, sums to that wall interior span), kind(SOLID/VNT/DRFRM/WDO), prefers(placement preference).',
    },
  },
  layouts,
};

const dest = path.join(__dirname, '..', '..', 'lib', 'pl-data', 'booth-layouts.json');
fs.writeFileSync(dest, JSON.stringify(out, null, 2));
console.log('Wrote ' + Object.keys(layouts).length + ' layouts to ' + dest);
// Validation: panel sums vs interior span
let warn = 0;
for (const [name, L] of Object.entries(layouts)) {
  for (const side of ['N','S','E','W']) {
    const span = (side==='N'||side==='S') ? L.variants.S.interior.w : L.variants.S.interior.h;
    const sum = L.walls[side].slots.reduce((a,s)=>a+s.size,0);
    if (Math.abs(sum - span) > 6) { console.log('  WARN ' + name + ' ' + side + ': panels=' + sum + ' span=' + span); warn++; }
  }
}
console.log(warn ? (warn + ' warnings') : 'All panel sums reconcile with interior spans.');
