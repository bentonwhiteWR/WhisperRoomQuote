// Top-down booth layout renderer (v2) — spec-sheet-faithful SVG.
// This module is the source of truth for the renderer; the same functions are
// pasted into packing-list.html. Kept standalone so it can be previewed by
// rendering to PNG via headless Chrome (see preview.js).
//
// Public: renderLayoutSvg(layout, assign), placeBom(layout, lines),
//         classifyWall, panelInteriorWidth, isWallPanel.

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ── BOM wall-panel helpers ────────────────────────────────────────
function classifyWall(pack) {
  pack = String(pack || '');
  if (/^WA\s+STDDRFRM/i.test(pack)) return 'DRFRM';
  if (/DRFRM/i.test(pack))          return 'DRFRM';
  if (/WDO/i.test(pack))            return 'WDO';
  if (/CBL/i.test(pack))            return 'CBL';
  if (/VNT/i.test(pack))            return 'VNT';
  return 'SOLID';
}
function panelInteriorWidth(pack) {
  pack = String(pack || '');
  if (/^(FR\s+)?(WA\s+|ADA\s+)?STDDRFRM/i.test(pack)) return 49;
  if (/^STDWL\s*7\s*\/\s*WL?16/i.test(pack))  return 7;
  const m = pack.match(/^(?:FR\s+)?STDWL(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}
function isWallPanel(pack) {
  pack = String(pack || '');
  if (/STD\s*DOOR/i.test(pack))            return false;   // door leaf — lives inside the frame wall
  if (/\bIN\s+(STD)?DRFRM/i.test(pack))    return false;   // inner-shell door frames (IEP IN / ADA IN)
  if (/DRFRM\s+ADAPT/i.test(pack))         return false;   // jamb adapters — hardware, not a wall
  // exterior door-frame walls: STDWL46 DRFRM R, WA STDDRFRM R, ADA STDDRFRM L, FR …
  if (/^(FR\s+)?(WA\s+|ADA\s+)?STDDRFRM/i.test(pack)) return true;
  return /^(FR\s+)?STDWL\d+/i.test(pack);
}

// ── Placement: kind-preference + closest-width, two passes ────────
// Pass 1 fills the "special" slots (vent, door, window) with a BOM panel of the
// matching kind. Pass 2 fills the rest by closest width. NV booths (no vent
// pack) simply leave the vent slots to be filled with a solid in pass 2 — which
// is exactly right (an SNV booth's back wall is solid).
function placeBom(layout, lines) {
  const pool = (lines || []).filter(l => isWallPanel(l.pack)).map(l => ({
    line: l, used: false, kind: classifyWall(l.pack), w: panelInteriorWidth(l.pack),
  }));
  const placement = {};
  const pick = (pred, size) => {
    let best = null, bd = Infinity;
    for (const p of pool) {
      if (!pred(p)) continue;
      const w = (p.w == null ? size : p.w);
      const d = Math.abs(w - size);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  };
  const sides = ['N', 'S', 'E', 'W'];
  // Pass 1 — special kinds (VNT/DRFRM/WDO) to their preferred slots.
  for (const side of sides) {
    const wall = layout.walls[side]; if (!wall) continue;
    for (const slot of wall.slots) {
      const want = (slot.prefers && slot.prefers[0]) || 'SOLID';
      if (want === 'SOLID') continue;
      const c = pick(p => !p.used && p.kind === want, slot.size);
      if (c) { c.used = true; placement[slot.id] = c.line; }
    }
  }
  // Pass 2 — everything else by closest width (same-kind → solid → any).
  for (const side of sides) {
    const wall = layout.walls[side]; if (!wall) continue;
    for (const slot of wall.slots) {
      if (placement[slot.id]) continue;
      const want = (slot.prefers && slot.prefers[0]) || 'SOLID';
      const c = pick(p => !p.used && p.kind === want, slot.size)
             || pick(p => !p.used && p.kind === 'SOLID', slot.size)
             || pick(p => !p.used, slot.size);
      if (c) { c.used = true; placement[slot.id] = c.line; }
    }
  }
  const leftover = pool.filter(p => !p.used).map(p => p.line);
  return { placement, leftover };
}

// Friendly type names for the panel + legend.
const KIND_META = {
  SOLID: { label: 'Wall',        accent: null },
  VNT:   { label: 'Ventilation', accent: '#6aa9d6' },
  CBL:   { label: 'Cable',       accent: '#6aa9d6' },
  DRFRM: { label: 'Door',        accent: '#ee6216' },
  WDO:   { label: 'Window',      accent: '#9ec4e6' },
  EMPTY: { label: '',            accent: null },
};

// Inches → feet-and-inches, the way the client proposal drawings dimension
// (74 → 6′ 2″, 55.5 → 4′ 7.5″, 11 → 11″). Halves survive.
function ftIn(n) {
  n = Math.round(n * 2) / 2;
  const f = Math.floor(n / 12), i = Math.round((n - f * 12) * 2) / 2;
  return f ? (f + '′' + (i ? ' ' + i + '″' : '')) : (i + '″');
}

// ── The renderer ──────────────────────────────────────────────────
function renderLayoutSvg(layout, assign) {
  const ext = layout.exterior;
  const interior = layout.interior || { w: ext.w - 2 * layout.wallThickness, h: ext.h - 2 * layout.wallThickness };
  const PX = Math.max(3, Math.min(600 / ext.w, 470 / ext.h, 11));
  const W = ext.w * PX, H = ext.h * PX, t = layout.wallThickness * PX;
  const VPROT = 5.5;        // a vent set protrudes 5.5″ beyond its wall (spec)
  const VOUT = VPROT * PX;  // drawn at TRUE scale so the "w/ vent" dim reads honestly
  // Ventilation upgrades (catalog p.29 + proposal drawings):
  //   VSS  — Ventilation Silencing System: TWO extra silencer ducts beside the
  //          standard pair, hose-connected (same 5.5″ protrusion).
  //   EFS  — Exterior Fan Silencer: a floor-level silencer box that wraps the
  //          fan OUTSIDE the booth, sticking out 10″ from the wall face — the
  //          proposals dim it, so the drawing and the "w/ EFS" line must too.
  //   ROOF — roof-mounted vent set (RM): ducts ride on the roof, the vent wall
  //          becomes a cable wall, no wall protrusion at all.
  const VSS = !!layout.vss, EFS = !!layout.efs, ROOF = !!layout.roofVent;
  const EPROT = EFS ? 10 : VPROT;       // how far the vent assembly reaches
  const EOUT = EPROT * PX;
  const DBL = /^E/i.test(String(layout.variant || 'S'));   // Enhanced double wall
  // Effective drawn width of a slot: normally the slot nominal, BUT the WA/ADA
  // door swap replaces a module pair with 49″ + a 7/19/31/43″ companion — the
  // pair conserves total width while the JOINT between them (and its seam
  // seal) shifts 3″ (4646/4622) or 9″ (4040/4016). Drawing those two at their
  // real placed widths moves the panel boundary + seam seal to the true spot.
  // Everything else keeps its nominal (digitized slots run ~1.5–2″ over the
  // real SKU, which the per-wall normalization already absorbs).
  const effSize = slot => {
    const ln = assign[slot.id]; if (!ln) return slot.size;
    const w = panelInteriorWidth(ln.pack);
    if (w == null) return slot.size;
    if (w >= 49) return w;                       // WA/ADA frame: always true 49″
    return (Math.abs(w - slot.size) >= 3 && [7, 19, 31, 43].indexOf(w) >= 0) ? w : slot.size;
  };
  // Which walls currently hold a door / vent — computed from the LIVE placement
  // (not hard-coded to S/N), so a dragged door or vent draws its swing/ducts on
  // whatever wall it now sits on, and the margins expand to fit. The door is
  // drawn OPEN at 90° (proposal-drawing style), so its margin is the full open
  // leaf length — compute it here, at this wall's px scale.
  const sideHasDoor = { N: false, S: false, E: false, W: false };
  const sideHasVent = { N: false, S: false, E: false, W: false };
  // ADA ramp: pairs with the WA door, protrudes 3′ 9⅝″ from the door wall —
  // drawn AND dimensioned (the proposals always dim what sticks out)
  const RAMP = !!layout.ramp;
  const RAMP_PROT = 45.625;
  let waDoorSide = null;
  let doorLeafPx = 0;
  for (const sd of ['N', 'S', 'E', 'W']) {
    const wallM = layout.walls[sd] || { slots: [] };
    const horizM = (sd === 'N' || sd === 'S');
    const spanM = horizM ? (W - 2 * t) : (H - 2 * t);
    const nomM = wallM.slots.reduce((a, sl) => a + effSize(sl), 0) || 1;
    for (const slot of wallM.slots) {
      const ln = assign[slot.id]; if (!ln) continue;
      const k = classifyWall(ln.pack);
      if (k === 'DRFRM') {
        sideHasDoor[sd] = true;
        if (panelInteriorWidth(ln.pack) >= 49) waDoorSide = sd;
        const lenM = effSize(slot) * (spanM / nomM);
        // WA/ADA frame (49″) carries a 32″ leaf regardless of the model default
        const swingM = (panelInteriorWidth(ln.pack) >= 49 ? 32 : (layout.door && layout.door.swing)) || 30;
        doorLeafPx = Math.max(doorLeafPx, Math.min(swingM * PX, lenM * 0.94));
      } else if (k === 'VNT' && layout.hasVent !== false && !ROOF) sideHasVent[sd] = true;
    }
  }
  const rampOn = sd => RAMP && waDoorSide === sd;
  const extra = sd => sideHasDoor[sd]
    ? Math.max(doorLeafPx, rampOn(sd) ? RAMP_PROT * PX : 0) + 14
    : (sideHasVent[sd] ? EOUT + 18 : 0);
  const BASE = 50;
  // extra room for the "w/ vent" overall-dim line: left of the height dim for
  // a N/S vent, below the width dim for an E/W vent
  const ventDimL = (sideHasVent.N || sideHasVent.S || rampOn('N') || rampOn('S')) ? 28 : 0;
  const ventDimB = (sideHasVent.E || sideHasVent.W || rampOn('E') || rampOn('W')) ? 28 : 0;
  const mTop = BASE + extra('N'), mBottom = BASE + extra('S') + ventDimB, mLeft = BASE + extra('W') + ventDimL, mRight = BASE + extra('E');
  const x0 = mLeft, y0 = mTop;
  const totalW = W + mLeft + mRight, totalH = H + mTop + mBottom;

  let s = `<svg class="ld-svg" viewBox="0 0 ${totalW} ${totalH}" preserveAspectRatio="xMidYMid meet" `
        + `style="width:100%;max-width:760px;display:block;margin:0 auto;font-family:'DM Sans',sans-serif;touch-action:none">`;

  // defs — gradients, shadow, carpet
  s += `<defs>`
    + `<linearGradient id="ldBg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#eef0f3"/><stop offset="1" stop-color="#f8f9fa"/></linearGradient>`
    + `<pattern id="ldCarpet" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" fill="#46464a"/><rect width="7" height="1" fill="#3f3f43"/><rect width="1" height="7" fill="#4e4e52"/></pattern>`
    + `<pattern id="ldSeal" width="5" height="5" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="#26272b"/><circle cx="1.2" cy="1.8" r="0.8" fill="#15161a"/><circle cx="3.7" cy="3.7" r="0.8" fill="#43454d"/><circle cx="3.6" cy="0.9" r="0.6" fill="#0e0f12"/><circle cx="0.8" cy="4.2" r="0.5" fill="#50535c"/></pattern>`
    + `<filter id="ldShadow" x="-15%" y="-15%" width="130%" height="135%"><feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#5a5f66" flood-opacity="0.35"/></filter>`
    + `</defs>`;

  s += `<rect x="0" y="0" width="${totalW}" height="${totalH}" fill="url(#ldBg)"/>`;

  // Booth shell shadow + carpet floor
  s += `<rect x="${x0}" y="${y0}" width="${W}" height="${H}" rx="2" fill="#2a2b30" filter="url(#ldShadow)"/>`;
  s += `<rect x="${x0 + t}" y="${y0 + t}" width="${W - 2 * t}" height="${H - 2 * t}" fill="url(#ldCarpet)"/>`;
  s += `<rect x="${x0 + t}" y="${y0 + t}" width="${W - 2 * t}" height="${H - 2 * t}" fill="none" stroke="#000" stroke-opacity="0.25" stroke-width="1"/>`;

  // ── foam lining + seam seals ────────────────────────────────────
  // Foam lining = a fine, subtle sawtooth along each interior wall face (the
  // acoustic wedge — NOT a seal). Seam seals are the bold connectors:
  //   • panel-joint seal: an I-beam — the seam line running wall-to-wall with a
  //     bar cap where it meets each wall (the "T" you see in the spec); and
  //   • corner seal: an L-bracket hugging each of the four interior corners.
  // Foam lining tint follows the chosen studiofoam color (booth-builder /
  // quote preference); default reads as the standard gray foam.
  const FOAM_COLORS = { Gray: '#2c2d33', Orange: '#a8430f', Blue: '#1e3a8a', Purple: '#5b21b6', Burgundy: '#6d1f2c' };
  const FOAM = FOAM_COLORS[layout.foamColor] || FOAM_COLORS.Gray;
  const SEAL = '#0d0e11';
  function foamComb(ax, ay, bx, by, nx, ny) {
    const len = Math.hypot(bx - ax, by - ay); if (len < 4) return '';
    const ux = (bx - ax) / len, uy = (by - ay) / len;
    const teeth = Math.max(4, Math.round(len / 5));
    const tw = len / teeth, dep = Math.min(4, Math.max(2.5, t * 0.4));
    let g = '';
    for (let i = 0; i < teeth; i++) {
      const sx = ax + ux * tw * i,         sy = ay + uy * tw * i;
      const mx = ax + ux * tw * (i + 0.5), my = ay + uy * tw * (i + 0.5);
      const ex = ax + ux * tw * (i + 1),   ey = ay + uy * tw * (i + 1);
      g += `<path d="M ${sx} ${sy} L ${mx + nx * dep} ${my + ny * dep} L ${ex} ${ey} Z" fill="${FOAM}"/>`;
    }
    return g;
  }
  const SEAL_STROKE = '#0d0e11';
  const SEAL_HALO = 'rgba(238,239,242,0.85)';   // light halo so the dark speckle pops off the carpet
  // glyph scale follows the wall-band thickness so seals stay legible on big booths
  const SG = Math.max(10, Math.min(t, 20));
  const sealPoly = pts => `<polygon points="${pts}" stroke="${SEAL_HALO}" stroke-width="4.5" stroke-linejoin="round" fill="none"/>`
    + `<polygon points="${pts}" fill="url(#ldSeal)" stroke="${SEAL_STROKE}" stroke-width="1.2" stroke-linejoin="round"/>`;
  // mid-wall seam seal: a T-profile at each panel joint — the STEM sits in
  // the joint BETWEEN the two wall panels (the panels butt into it), spanning
  // the full wall thickness; the CAP bar sits proud of the exterior face,
  // covering the joint. (jx,jy = joint on the exterior face; nx,ny = outward
  // normal.) Per Benton 2026-06-09: the old plinth pointed the tab outward —
  // the real seal's tab runs through the wall, with the walls butting into it.
  function midSeal(jx, jy, nx, ny) {
    const tx = -ny, ty = nx;                 // tangent = along the wall
    const capHalf = SG * 1.5, capDepth = SG * 0.45, stemHalf = SG * 0.22;
    const P = (a, n) => (jx + tx * a + nx * n) + ',' + (jy + ty * a + ny * n);
    const pts = [
      P(-capHalf, capDepth), P(capHalf, capDepth), P(capHalf, 0), P(stemHalf, 0),
      P(stemHalf, -t), P(-stemHalf, -t), P(-stemHalf, 0), P(-capHalf, 0),
    ].join(' ');
    return sealPoly(pts);
  }
  // corner seam seal: a filled L-bracket hugging an interior corner, with a
  // chamfered outer corner — the profile from the spec diagram (right).
  // (ax,ay)/(bx,by) = the two along-wall unit directions away from the corner.
  function cornerSeal(cx, cy, ax, ay, bx, by) {
    const L = SG * 1.7, Tk = SG * 0.55, ch = Tk * 0.6;
    const P = (a, b) => (cx + a * ax + b * bx) + ',' + (cy + a * ay + b * by);
    const pts = [
      P(ch, 0), P(L, 0), P(L, Tk), P(Tk, Tk), P(Tk, L), P(0, L), P(0, ch),
    ].join(' ');   // chamfer = the implicit edge from (0,ch) back to (ch,0)
    return sealPoly(pts);
  }
  function seamPieces() {
    const fx0 = x0 + t, fy0 = y0 + t, fx1 = x0 + W - t, fy1 = y0 + H - t;
    const spanW = W - 2 * t, spanH = H - 2 * t;
    let g = '';
    // foam lining on the four interior faces (the sawtooth in the spec views)
    g += foamComb(fx0, fy0, fx1, fy0, 0, 1) + foamComb(fx0, fy1, fx1, fy1, 0, -1)
       + foamComb(fx0, fy0, fx0, fy1, 1, 0) + foamComb(fx1, fy0, fx1, fy1, -1, 0);
    // panel-joint seals — one per adjacency on EACH wall, placed from that
    // wall's own slot widths (EFFECTIVE widths, so the WA-door pair's joint
    // sits 3″/9″ over where the module pair's joint was), mounted on the
    // EXTERIOR face with the tab protruding outward (matches the spec sheets).
    for (const side of ['N', 'S', 'E', 'W']) {
      const wall = layout.walls[side]; if (!wall || wall.slots.length < 2) continue;
      const nom = wall.slots.reduce((a, sl) => a + effSize(sl), 0) || 1;
      const horiz = (side === 'N' || side === 'S');
      let o = 0;
      for (let i = 0; i < wall.slots.length - 1; i++) {
        o += effSize(wall.slots[i]);
        const f = o / nom;
        if (horiz) {
          const x = fx0 + f * spanW;
          g += midSeal(x, side === 'N' ? y0 : y0 + H, 0, side === 'N' ? -1 : 1);
        } else {
          const y = fy0 + f * spanH;
          g += midSeal(side === 'W' ? x0 : x0 + W, y, side === 'W' ? -1 : 1, 0);
        }
      }
    }
    // corner seals — chamfered L-brackets WRAPPING each exterior corner (the
    // spec view shows them proud of both outer faces). Anchor is the outer
    // corner pushed outward by `o`; legs run inward along both walls.
    const o2 = SG * 0.35;
    g += cornerSeal(x0 - o2,     y0 - o2,     1, 0, 0, 1) + cornerSeal(x0 + W + o2, y0 - o2,     -1, 0, 0, 1)
       + cornerSeal(x0 - o2,     y0 + H + o2, 1, 0, 0, -1) + cornerSeal(x0 + W + o2, y0 + H + o2, -1, 0, 0, -1);
    // Enhanced: the INNER wall set has its own seam seals — a tab at every
    // inner-panel joint plus inner corner posts (E spec top-downs show both).
    if (DBL) {
      const tIn = t * 0.40;
      const tw = SG * 0.5;
      for (const side of ['N', 'S', 'E', 'W']) {
        const wall = layout.walls[side]; if (!wall || wall.slots.length < 2) continue;
        const nom = wall.slots.reduce((a, sl) => a + effSize(sl), 0) || 1;
        const horiz = (side === 'N' || side === 'S');
        let o = 0;
        for (let i = 0; i < wall.slots.length - 1; i++) {
          o += effSize(wall.slots[i]);
          const f = o / nom;
          if (horiz) {
            const x = fx0 + f * spanW;
            const yI = side === 'N' ? y0 + t - tIn : y0 + H - t;
            g += `<rect x="${x - tw / 2}" y="${yI}" width="${tw}" height="${tIn}" fill="url(#ldSeal)" stroke="${SEAL_STROKE}" stroke-width="0.9"/>`;
          } else {
            const y = fy0 + f * spanH;
            const xI = side === 'W' ? x0 + t - tIn : x0 + W - t;
            g += `<rect x="${xI}" y="${y - tw / 2}" width="${tIn}" height="${tw}" fill="url(#ldSeal)" stroke="${SEAL_STROKE}" stroke-width="0.9"/>`;
          }
        }
      }
      for (const [icx, icy] of [[x0 + t - tIn, y0 + t - tIn], [x0 + W - t, y0 + t - tIn], [x0 + t - tIn, y0 + H - t], [x0 + W - t, y0 + H - t]])
        g += `<rect x="${icx}" y="${icy}" width="${tIn}" height="${tIn}" fill="url(#ldSeal)" stroke="#0d0e11" stroke-width="0.8"/>`;
    }
    return g;
  }

  // Outer-edge midpoint + outward/along unit vectors for a panel on `side`.
  function edgeGeom(side, px, py, pw, ph) {
    if (side === 'N') return { omx: px + pw / 2, omy: py,      ox: 0, oy: -1, ax: 1, ay: 0, horiz: true };
    if (side === 'S') return { omx: px + pw / 2, omy: py + ph, ox: 0, oy: 1,  ax: 1, ay: 0, horiz: true };
    if (side === 'W') return { omx: px,          omy: py + ph / 2, ox: -1, oy: 0, ax: 0, ay: 1, horiz: false };
    return            { omx: px + pw, omy: py + ph / 2, ox: 1, oy: 0, ax: 0, ay: 1, horiz: false };
  }

  // ── vent assembly: TWO boxes (one plain, one with a fan), spread along the
  // wall, protruding OUTWARD from whatever wall holds the vent. The outward
  // depth is exactly 5.5″ at scale (VOUT) so the drawn footprint matches the
  // "w/ vent" dimension line. ──
  function ventDuct(side, px, py, pw, ph) {
    const { omx, omy, ox, oy, ax, ay, horiz } = edgeGeom(side, px, py, pw, ph);
    const panelLen = horiz ? pw : ph;
    // four boxes have to fit when VSS is on — shrink the per-box width
    const B = Math.max(14, Math.min(panelLen * (VSS ? 0.19 : 0.30), VSS ? 32 : 44));
    const G = Math.max(7, B * 0.4), PL = 4;
    const off = B / 2 + G / 2;
    let g = '';
    // EFS: floor-level silencer box that wraps the fan OUTSIDE the booth —
    // sticks out a full 10″ (EOUT) where the ducts only reach 5.5″. Drawn
    // first so the duct boxes sit on top of it, like the proposal back views.
    if (EFS) {
      const L = Math.min(B * 1.9, panelLen * 0.55);
      const fcx = omx + ax * off, fcy = omy + ay * off;     // fan box center
      const rx = horiz ? fcx - L / 2 : (ox < 0 ? omx - EOUT : omx);
      const ry = horiz ? (oy < 0 ? omy - EOUT : omy) : fcy - L / 2;
      const bw = horiz ? L : EOUT, bh = horiz ? EOUT : L;
      g += `<rect x="${rx}" y="${ry}" width="${bw}" height="${bh}" rx="3" fill="#2c2d33" stroke="#0d0e11" stroke-width="1.1"/>`;
      g += `<rect x="${rx + 2.5}" y="${ry + 2.5}" width="${bw - 5}" height="${bh - 5}" rx="2" fill="none" stroke="#4a4d55" stroke-width="0.8"/>`;
    }
    // mounting plate hugging the wall edge under all the boxes
    const plate = (VSS ? 4 * B + G + 14 : 2 * B + G) + 6;
    if (horiz) g += `<rect x="${omx - plate / 2}" y="${oy < 0 ? omy - PL : omy}" width="${plate}" height="${PL}" rx="1.5" fill="#3a3b42"/>`;
    else       g += `<rect x="${ox < 0 ? omx - PL : omx}" y="${omy - plate / 2}" width="${PL}" height="${plate}" rx="1.5" fill="#3a3b42"/>`;
    // standard pair at ±off; VSS adds a second silencer duct outboard of each,
    // hose-connected to its neighbor (catalog: "two exhaust ducts" per system)
    const seats = [{ k: -1, o: off, fan: false }, { k: 1, o: off, fan: true }];
    if (VSS) seats.push({ k: -1, o: off + B + 5, vss: true }, { k: 1, o: off + B + 5, vss: true });
    for (const s2 of seats) {
      const ccx = omx + ax * s2.k * s2.o, ccy = omy + ay * s2.k * s2.o;
      const rx = horiz ? (ccx - B / 2) : (ox < 0 ? omx - VOUT : omx);
      const ry = horiz ? (oy < 0 ? omy - VOUT : omy) : (ccy - B / 2);
      const bw = horiz ? B : VOUT, bh = horiz ? VOUT : B;
      g += `<rect x="${rx}" y="${ry}" width="${bw}" height="${bh}" rx="2" fill="#34363d" stroke="#1b1c20" stroke-width="1"/>`;
      if (s2.fan) {    // fan box
        const fr = Math.min(bw, bh);
        g += `<circle cx="${rx + bw / 2}" cy="${ry + bh / 2}" r="${fr * 0.32}" fill="#22242a" stroke="#54585f" stroke-width="0.9"/>`;
        g += `<circle cx="${rx + bw / 2}" cy="${ry + bh / 2}" r="${fr * 0.11}" fill="#62666f"/>`;
      } else {         // plain box (no hole) — same box, just an inset panel line
        g += `<rect x="${rx + bw * 0.2}" y="${ry + bh * 0.2}" width="${bw * 0.6}" height="${bh * 0.6}" rx="1" fill="none" stroke="#4a4d55" stroke-width="0.9"/>`;
      }
      if (s2.vss) {    // hose from the VSS duct to its inboard neighbor
        const d75 = VOUT * 0.55;
        const hx1 = horiz ? ccx - s2.k * (B / 2 + 5) : omx + ox * d75;
        const hy1 = horiz ? omy + oy * d75 : ccy - s2.k * (B / 2 + 5);
        const hx2 = horiz ? ccx - s2.k * (B / 2) : hx1;
        const hy2 = horiz ? hy1 : ccy - s2.k * (B / 2);
        const bow = 4.5;
        g += `<path d="M ${hx1} ${hy1} Q ${(hx1 + hx2) / 2 + (horiz ? 0 : ox * bow)} ${(hy1 + hy2) / 2 + (horiz ? oy * bow : 0)} ${hx2} ${hy2}" fill="none" stroke="#0d0e11" stroke-width="2.4" stroke-linecap="round"/>`;
      }
    }
    return g;
  }

  // ── roof-mounted vent set: duct pair ON the roof, just inside whatever
  // wall holds the (now cable) vent panel — no wall protrusion. ──
  function roofDuct(side, px, py, pw, ph) {
    const horiz = (side === 'N' || side === 'S');
    const inX = side === 'W' ? 1 : side === 'E' ? -1 : 0;   // inward normal
    const inY = side === 'N' ? 1 : side === 'S' ? -1 : 0;
    const bx = horiz ? px + pw / 2 : (inX > 0 ? px + pw : px);
    const by = horiz ? (inY > 0 ? py + ph : py) : py + ph / 2;
    const panelLen = horiz ? pw : ph;
    const B2 = Math.max(16, Math.min(panelLen * 0.26, 36)), G2 = Math.max(6, B2 * 0.35);
    const D2 = Math.min(10 * PX, 56);
    let g = '';
    for (const k of [-1, 1]) {
      const ax2 = horiz ? 1 : 0, ay2 = horiz ? 0 : 1;
      const ccx = bx + ax2 * k * (B2 / 2 + G2 / 2), ccy = by + ay2 * k * (B2 / 2 + G2 / 2);
      const rx = horiz ? ccx - B2 / 2 : (inX > 0 ? bx + 3 : bx - D2 - 3);
      const ry = horiz ? (inY > 0 ? by + 3 : by - D2 - 3) : ccy - B2 / 2;
      const bw = horiz ? B2 : D2, bh = horiz ? D2 : B2;
      // soft shadow so the boxes read as sitting ON the roof plane
      g += `<rect x="${rx + 2}" y="${ry + 3}" width="${bw}" height="${bh}" rx="2.5" fill="#000" opacity="0.30"/>`;
      g += `<rect x="${rx}" y="${ry}" width="${bw}" height="${bh}" rx="2.5" fill="url(#ldSeal)" stroke="#0d0e11" stroke-width="1"/>`;
      if (k === 1) {
        const fr = Math.min(bw, bh);
        g += `<circle cx="${rx + bw / 2}" cy="${ry + bh / 2}" r="${fr * 0.30}" fill="#22242a" stroke="#54585f" stroke-width="0.9"/>`;
        g += `<circle cx="${rx + bw / 2}" cy="${ry + bh / 2}" r="${fr * 0.10}" fill="#62666f"/>`;
      } else {
        g += `<rect x="${rx + bw * 0.22}" y="${ry + bh * 0.22}" width="${bw * 0.56}" height="${bh * 0.56}" rx="1" fill="none" stroke="#4a4d55" stroke-width="0.9"/>`;
      }
    }
    // small caption so the on-roof boxes aren't mistaken for furniture
    const lx2 = horiz ? bx : (inX > 0 ? bx + D2 / 2 + 3 : bx - D2 / 2 - 3);
    const ly2 = horiz ? (inY > 0 ? by + D2 + 14 : by - D2 - 8) : by + B2 + G2 / 2 + 12;
    g += `<text x="${lx2}" y="${ly2}" text-anchor="middle" font-size="8" font-weight="700" letter-spacing="0.08em" fill="#cfd3da" opacity="0.85" style="pointer-events:none">ROOF VENT</text>`;
    return g;
  }

  // ── door: OPEN leaf at 90° + dashed swing arc, matching the client proposal
  // top-down drawings (door always opens outward). The doorway itself reads as
  // a light threshold gap across the frame wall. Hinge side follows the pack
  // (DRFRM R/L) so a left-hinge door pivots from the other end. ─────
  function doorSwing(side, px, py, pw, ph, swingIn, pack) {
    const { omx, omy, ox, oy, ax, ay, horiz } = edgeGeom(side, px, py, pw, ph);
    // leaf = the actual door width (swingIn inches, e.g. 30″ in a 46″ frame)
    const leafW = Math.min(swingIn * PX, (horiz ? pw : ph) * 0.94);
    // hinge end: same booth-fixed convention as the elevation renderer —
    // an R-hinge door pivots from the +axis end of its wall (east end on a
    // front/back wall, south end on a side wall); L mirrors it.
    const hingeR = !/\sL\b/i.test(String(pack || ''));
    const flip = hingeR ? -1 : 1;
    const hx = omx - ax * flip * leafW / 2, hy = omy - ay * flip * leafW / 2;   // hinge end
    const cX = omx + ax * flip * leafW / 2, cY = omy + ay * flip * leafW / 2;   // closed-tip end
    const eX = hx + ox * leafW, eY = hy + oy * leafW;                           // open tip (90° out)
    const sweep = ((cX - hx) * (eY - hy) - (cY - hy) * (eX - hx)) > 0 ? 1 : 0;
    const DL = Math.max(5, t * 0.4);                             // leaf thickness (px)
    let g = '';
    // doorway threshold: light gap across the wall band where the opening is
    const thr = 1.2;
    if (horiz) g += `<rect x="${Math.min(hx, cX) + 1}" y="${py + thr}" width="${leafW - 2}" height="${ph - 2 * thr}" fill="#e2e4e9" opacity="0.92"/>`;
    else       g += `<rect x="${px + thr}" y="${Math.min(hy, cY) + 1}" width="${pw - 2 * thr}" height="${leafW - 2}" fill="#e2e4e9" opacity="0.92"/>`;
    // swing arc: dashed quarter-circle from the closed position to the open
    // leaf, plus a faint chord marking the closed position
    g += `<path d="M ${cX} ${cY} A ${leafW} ${leafW} 0 0 ${sweep} ${eX} ${eY}" fill="none" stroke="rgba(238,98,22,0.55)" stroke-width="1.2" stroke-dasharray="5,3"/>`;
    g += `<line x1="${hx}" y1="${hy}" x2="${cX}" y2="${cY}" stroke="rgba(238,98,22,0.25)" stroke-width="1" stroke-dasharray="2,3"/>`;
    // the leaf, drawn closed then rotated 90° outward about the hinge pin
    const rot = ((side === 'S' || side === 'W') ? 90 : -90) * flip;
    const lx = horiz ? Math.min(hx, cX) : (ox < 0 ? omx - DL : omx);
    const ly = horiz ? (oy < 0 ? omy - DL : omy) : Math.min(hy, cY);
    const lw = horiz ? leafW : DL, lh = horiz ? DL : leafW;
    g += `<g transform="rotate(${rot} ${hx} ${hy})">`;
    // the leaf is the same black carpet as the walls (real product: door is
    // carpet-covered too) — hardware drawn light so it reads on the dark leaf
    g += `<rect x="${lx}" y="${ly}" width="${lw}" height="${lh}" rx="1" fill="url(#ldSeal)" stroke="#000" stroke-width="1"/>`;
    // hinge dot pairs near the hinge end, handle nub at the free end
    for (const f of [0.08, 0.22]) {
      const d1x = hx + ax * flip * leafW * f + ox * DL * 0.32, d1y = hy + ay * flip * leafW * f + oy * DL * 0.32;
      const d2x = hx + ax * flip * leafW * f + ox * DL * 0.68, d2y = hy + ay * flip * leafW * f + oy * DL * 0.68;
      g += `<circle cx="${d1x}" cy="${d1y}" r="1.3" fill="#c9ccd3"/><circle cx="${d2x}" cy="${d2y}" r="1.3" fill="#c9ccd3"/>`;
    }
    const hbx = cX - ax * flip * leafW * 0.06, hby = cY - ay * flip * leafW * 0.06;   // handle base on the leaf
    g += `<line x1="${hbx + ox * DL * 0.5}" y1="${hby + oy * DL * 0.5}" x2="${hbx + ox * (DL + 5)}" y2="${hby + oy * (DL + 5)}" stroke="#9ba0a9" stroke-width="2" stroke-linecap="round"/>`;
    g += `<line x1="${hbx + ox * (DL + 5)}" y1="${hby + oy * (DL + 5)}" x2="${hbx + ox * (DL + 5) - ax * flip * 7}" y2="${hby + oy * (DL + 5) - ay * flip * 7}" stroke="#9ba0a9" stroke-width="2" stroke-linecap="round"/>`;
    g += `</g>`;
    // hinge pin marker at the pivot
    g += `<circle cx="${hx}" cy="${hy}" r="2" fill="#c9ccd3"/>`;
    return g;
  }

  // ── draw one wall side's panels ─────────────────────────────────
  const vents = [];   // {side,px,py,pw,ph} — drawn after walls
  const roofs = [];   // roof-vent host panels (the former vent wall) under ROOF
  let door = null;    // {side,px,py,pw,ph,swing}

  function drawWall(side) {
    const wall = layout.walls[side]; if (!wall) return '';
    const horiz = (side === 'N' || side === 'S');
    const span = horiz ? (W - 2 * t) : (H - 2 * t);
    // effective widths: the WA-door pair draws at its real 49″ + companion
    // sizes, shifting the panel boundary (and the seam seal on it) 3″/9″
    const nominal = wall.slots.reduce((a, sl) => a + effSize(sl), 0) || 1;
    const scale = span / nominal;
    let off = 0, g = '';
    for (const slot of wall.slots) {
      const line = assign[slot.id];
      const kind = line ? classifyWall(line.pack) : 'EMPTY';
      const meta = KIND_META[kind] || KIND_META.EMPTY;
      const len = effSize(slot) * scale;
      // panel rect geometry per side
      let px, py, pw, ph;
      if (side === 'N') { px = x0 + t + off; py = y0;             pw = len; ph = t; }
      else if (side === 'S') { px = x0 + t + off; py = y0 + H - t; pw = len; ph = t; }
      else if (side === 'W') { px = x0;          py = y0 + t + off; pw = t; ph = len; }
      else { px = x0 + W - t; py = y0 + t + off; pw = t; ph = len; }
      g += `<g class="ld-panel" data-slot="${esc(slot.id)}">`;
      // invisible hit-pad: extends the grab target well past the thin wall
      // band — 26px into the interior AND 14px outside the shell — so fingers
      // and quick mouse drags land (team kept missing the 15px pad). Drawn
      // first (under the visuals).
      const HPI = 26, HPO = 14;
      let hx = px, hy = py, hw = pw, hh = ph;
      if (side === 'N')      { hy = py - HPO; hh = ph + HPI + HPO; }
      else if (side === 'S') { hy = py - HPI; hh = ph + HPI + HPO; }
      else if (side === 'W') { hx = px - HPO; hw = pw + HPI + HPO; }
      else                   { hx = px - HPI; hw = pw + HPI + HPO; }
      g += `<rect class="ld-hit" x="${hx}" y="${hy}" width="${hw}" height="${hh}" fill="#000" fill-opacity="0" style="pointer-events:all"/>`;
      // Wall panels are the SAME carpet as the seam seals (one material on
      // the real product — the spec-sheet top-downs draw them identically).
      if (DBL) {
        // Enhanced = a complete SECOND wall set nested inside the standard
        // one (E spec top-downs: outer wall · air gap · inner wall). Split
        // the composite band — outer 42% · gap · inner 40% — with the gap
        // near-black so the two shells read separately.
        const tOut = t * 0.42, tIn = t * 0.40;
        let ox2, oy2, ow2, oh2, ix2, iy2, iw2, ih2;
        if (side === 'N')      { ox2 = px; oy2 = py;             ow2 = pw; oh2 = tOut; ix2 = px; iy2 = py + ph - tIn;  iw2 = pw;  ih2 = tIn; }
        else if (side === 'S') { ox2 = px; oy2 = py + ph - tOut; ow2 = pw; oh2 = tOut; ix2 = px; iy2 = py;            iw2 = pw;  ih2 = tIn; }
        else if (side === 'W') { ox2 = px; oy2 = py;             ow2 = tOut; oh2 = ph; ix2 = px + pw - tIn; iy2 = py; iw2 = tIn; ih2 = ph; }
        else                   { ox2 = px + pw - tOut; oy2 = py; ow2 = tOut; oh2 = ph; ix2 = px; iy2 = py;            iw2 = tIn; ih2 = ph; }
        g += `<rect x="${px}" y="${py}" width="${pw}" height="${ph}" fill="#101114"/>`;   // air gap between the shells
        g += `<rect class="ld-wall" x="${ox2}" y="${oy2}" width="${ow2}" height="${oh2}" fill="url(#ldSeal)" stroke="#15161a" stroke-width="0.8"/>`;
        g += `<rect class="ld-wall" x="${ix2}" y="${iy2}" width="${iw2}" height="${ih2}" fill="url(#ldSeal)" stroke="#15161a" stroke-width="0.8"/>`;
        g += `<rect x="${ix2 + 0.6}" y="${iy2 + 0.6}" width="${iw2 - 1.2}" height="${ih2 - 1.2}" fill="none" stroke="#5e616c" stroke-opacity="0.6" stroke-width="0.6"/>`;
      } else {
        g += `<rect class="ld-wall" x="${px}" y="${py}" width="${pw}" height="${ph}" fill="url(#ldSeal)" stroke="#15161a" stroke-width="0.8"/>`;
        // interior bevel highlight (brighter than the old slate — panel edges
        // need it to read on the near-black carpet)
        g += `<rect x="${px + 0.6}" y="${py + 0.6}" width="${pw - 1.2}" height="${ph - 1.2}" fill="none" stroke="#5e616c" stroke-opacity="0.6" stroke-width="0.6"/>`;
      }
      // kind accent line on the interior edge
      if (meta.accent) {
        if (side === 'N') g += `<rect x="${px + 1}" y="${py + ph - 2}" width="${pw - 2}" height="1.6" fill="${meta.accent}" opacity="0.8"/>`;
        else if (side === 'S') g += `<rect x="${px + 1}" y="${py + 0.4}" width="${pw - 2}" height="1.6" fill="${meta.accent}" opacity="0.8"/>`;
        else if (side === 'W') g += `<rect x="${px + pw - 2}" y="${py + 1}" width="1.6" height="${ph - 2}" fill="${meta.accent}" opacity="0.8"/>`;
        else g += `<rect x="${px + 0.4}" y="${py + 1}" width="1.6" height="${ph - 2}" fill="${meta.accent}" opacity="0.8"/>`;
      }
      // window: a bright glass band through the FULL wall thickness (both
      // shells on Enhanced — the real window pierces both), framed + glinted,
      // so it visibly reads as "you can see into the booth"
      if (kind === 'WDO') {
        const GLF = 0.62;
        if (horiz) {
          const gx = px + pw * (1 - GLF) / 2, gw = pw * GLF;
          g += `<rect x="${gx}" y="${py + 0.8}" width="${gw}" height="${ph - 1.6}" fill="#cfe7fa" opacity="0.96" rx="1"/>`;
          g += `<line x1="${gx + 2.5}" y1="${py + ph - 2}" x2="${gx + gw - 2.5}" y2="${py + 2}" stroke="#fff" stroke-opacity="0.75" stroke-width="1.4"/>`;
          g += `<rect x="${gx}" y="${py + 0.8}" width="${gw}" height="${ph - 1.6}" fill="none" stroke="#1b1c20" stroke-width="1" rx="1"/>`;
        } else {
          const gy2 = py + ph * (1 - GLF) / 2, gh = ph * GLF;
          g += `<rect x="${px + 0.8}" y="${gy2}" width="${pw - 1.6}" height="${gh}" fill="#cfe7fa" opacity="0.96" rx="1"/>`;
          g += `<line x1="${px + 2}" y1="${gy2 + gh - 2.5}" x2="${px + pw - 2}" y2="${gy2 + 2.5}" stroke="#fff" stroke-opacity="0.75" stroke-width="1.4"/>`;
          g += `<rect x="${px + 0.8}" y="${gy2}" width="${pw - 1.6}" height="${gh}" fill="none" stroke="#1b1c20" stroke-width="1" rx="1"/>`;
        }
      }
      g += `</g>`;
      // collect vent / door for later overlay — on WHATEVER wall they sit
      if (kind === 'VNT' && layout.hasVent !== false && !ROOF) vents.push({ side, px, py, pw, ph });
      if (ROOF && (kind === 'CBL' || kind === 'VNT')) roofs.push({ side, px, py, pw, ph });
      if (kind === 'DRFRM') door = { side, px, py, pw, ph, swing: (panelInteriorWidth(line.pack) >= 49 ? 32 : (layout.door && layout.door.swing)) || 30, pack: line.pack };
      // panel label (width + type + code) just inside the wall on the floor
      g += panelLabel(side, px, py, pw, ph, kind, line, slot);
      off += len;
    }
    return g;
  }

  function panelLabel(side, px, py, pw, ph, kind, line, slot) {
    const meta = KIND_META[kind] || KIND_META.EMPTY;
    const horiz = (side === 'N' || side === 'S');
    const big = horiz ? pw : ph;
    if (big < 22) return '';   // too small to label
    let lx, ly, anchor = 'middle', rot = 0;
    const pad = 13;
    if (side === 'N') { lx = px + pw / 2; ly = py + t + pad; }
    else if (side === 'S') { lx = px + pw / 2; ly = py - 7; }
    else if (side === 'W') { lx = px + t + 7; ly = py + ph / 2; anchor = 'start'; rot = 0; }
    else { lx = px - 7; ly = py + ph / 2; anchor = 'end'; }
    // Lead with the panel width, like the spec sheets' "46\" Wall Panel"
    // callouts — the placed pack's real width when known, slot nominal else.
    const wIn = line ? (panelInteriorWidth(line.pack) != null ? panelInteriorWidth(line.pack) : slot.size) : slot.size;
    const typ = kind === 'EMPTY' ? '(empty)' : (wIn + '″ ' + meta.label);
    const col = kind === 'EMPTY' ? '#aab' : '#eef';
    let out = `<text x="${lx}" y="${ly}" text-anchor="${anchor}" font-size="9.5" font-weight="700" fill="${col}" opacity="0.92" style="pointer-events:none">${esc(typ)}</text>`;
    if (line && line.code) {
      const cy2 = (side === 'S') ? ly - 10 : ly + 11;
      out += `<text x="${lx}" y="${cy2}" text-anchor="${anchor}" font-size="8" fill="#cfd3da" opacity="0.7" style="pointer-events:none">${esc(line.code)}</text>`;
    }
    return out;
  }

  // walls
  s += drawWall('N');
  s += drawWall('S');
  s += drawWall('E');
  s += drawWall('W');

  // corner posts (on top of wall ends) — same seal carpet as the walls
  for (const [cx, cy] of [[x0, y0], [x0 + W - t, y0], [x0, y0 + H - t], [x0 + W - t, y0 + H - t]]) {
    s += `<rect x="${cx}" y="${cy}" width="${t}" height="${t}" fill="url(#ldSeal)" stroke="#000" stroke-width="0.8"/>`;
  }

  // seam seals: comb on each interior face + corner pieces + T pieces at joints
  s += seamPieces();

  // vent ducts + roof-vent boxes + ramp + door overlays (follow their panels)
  vents.forEach(v => s += ventDuct(v.side, v.px, v.py, v.pw, v.ph));
  roofs.forEach(v => s += roofDuct(v.side, v.px, v.py, v.pw, v.ph));
  if (RAMP && door && panelInteriorWidth(door.pack) >= 49) {
    // ramp plan view, centered on the WA door, protruding 3′ 9⅝″ from the
    // wall face (the sill strip at the image top overlaps the wall ~2″).
    // Drawn before the door so the open leaf swings out OVER the ramp.
    const rt = ELEV_ART.rampTop;
    const { omx, omy } = edgeGeom(door.side, door.px, door.py, door.pw, door.ph);
    const hIn2 = rt.protIn + rt.sillIn, wIn2 = hIn2 * rt.aspect;
    const ang = { S: 0, N: 180, W: 90, E: -90 }[door.side];
    s += `<g transform="rotate(${ang} ${omx} ${omy})">`
      + `<image href="${ART_BASE + rt.file}" x="${omx - wIn2 * PX / 2}" y="${omy - rt.sillIn * PX}" width="${wIn2 * PX}" height="${hIn2 * PX}" preserveAspectRatio="none"/></g>`;
  }
  if (door) s += doorSwing(door.side, door.px, door.py, door.pw, door.ph, door.swing, door.pack);

  // ── dimension lines (exterior) ──────────────────────────────────
  function tick(x, y, vert) {
    return vert ? `<line x1="${x - 4}" y1="${y}" x2="${x + 4}" y2="${y}" stroke="#9097a0" stroke-width="1"/>`
                : `<line x1="${x}" y1="${y - 4}" x2="${x}" y2="${y + 4}" stroke="#9097a0" stroke-width="1"/>`;
  }
  const dimY = y0 + H + extra('S') + 24;
  s += `<line x1="${x0}" y1="${dimY}" x2="${x0 + W}" y2="${dimY}" stroke="#9097a0" stroke-width="1"/>`;
  s += tick(x0, dimY, false) + tick(x0 + W, dimY, false);
  s += `<rect x="${x0 + W / 2 - 28}" y="${dimY - 9}" width="56" height="16" rx="3" fill="url(#ldBg)"/>`;
  s += `<text x="${x0 + W / 2}" y="${dimY + 3}" text-anchor="middle" font-size="11" font-weight="700" fill="#4a4f57">${ftIn(ext.w)}</text>`;
  const dimX = x0 - extra('W') - 24;
  s += `<line x1="${dimX}" y1="${y0}" x2="${dimX}" y2="${y0 + H}" stroke="#9097a0" stroke-width="1"/>`;
  s += tick(dimX, y0, true) + tick(dimX, y0 + H, true);
  s += `<rect x="${dimX - 8}" y="${y0 + H / 2 - 28}" width="16" height="56" fill="url(#ldBg)"/>`;
  s += `<text x="${dimX}" y="${y0 + H / 2}" text-anchor="middle" font-size="11" font-weight="700" fill="#4a4f57" transform="rotate(-90 ${dimX} ${y0 + H / 2})">${ftIn(ext.h)}</text>`;

  // ── "w/ vent" overall dims ──────────────────────────────────────
  // A vent set adds 5.5″ to the axis it protrudes on: a 4872 with the vent on
  // the 72″ wall has a 50″ exterior side that totals 55.5″ overall. Drawn only
  // on axes that actually carry a vent, and follows a dragged vent to its new
  // wall. Spans wall face → duct outer face (the ducts are drawn at true scale).
  const VDIM = '#c9762e';
  const fmtIn = v => ftIn(v);
  const vtick = (x, y, vert) =>
    vert ? `<line x1="${x - 4}" y1="${y}" x2="${x + 4}" y2="${y}" stroke="${VDIM}" stroke-width="1"/>`
         : `<line x1="${x}" y1="${y - 4}" x2="${x}" y2="${y + 4}" stroke="${VDIM}" stroke-width="1"/>`;
  // per-side protrusion: vent set 5.5″ / EFS 10″ / ramp 45.625″ — whatever
  // sticks out gets dimmed, labeled with what's doing the sticking
  const protOf = sd => Math.max(sideHasVent[sd] ? EPROT : 0, rampOn(sd) ? RAMP_PROT : 0);
  const axisLabel = (a, b) => {
    const bits = [];
    if (sideHasVent[a] || sideHasVent[b]) bits.push(EFS ? 'EFS' : 'vent');
    if (rampOn(a) || rampOn(b)) bits.push('ramp');
    return 'w/ ' + bits.join(' + ');
  };
  if (protOf('N') || protOf('S')) {
    const yA = y0 - protOf('N') * PX, yB = y0 + H + protOf('S') * PX;
    const tot = ext.h + protOf('N') + protOf('S');
    const vx = dimX - 22, vmy = (yA + yB) / 2;
    s += `<line x1="${vx}" y1="${yA}" x2="${vx}" y2="${yB}" stroke="${VDIM}" stroke-width="1"/>` + vtick(vx, yA, true) + vtick(vx, yB, true);
    s += `<rect x="${vx - 8}" y="${vmy - 44}" width="16" height="88" fill="url(#ldBg)"/>`;
    s += `<text x="${vx}" y="${vmy + 3}" text-anchor="middle" font-size="10" font-weight="700" fill="${VDIM}" transform="rotate(-90 ${vx} ${vmy})">${fmtIn(tot)} ${axisLabel('N', 'S')}</text>`;
  }
  if (protOf('E') || protOf('W')) {
    const xA = x0 - protOf('W') * PX, xB = x0 + W + protOf('E') * PX;
    const tot = ext.w + protOf('W') + protOf('E');
    const vy = dimY + 34, vmx = (xA + xB) / 2;
    s += `<line x1="${xA}" y1="${vy}" x2="${xB}" y2="${vy}" stroke="${VDIM}" stroke-width="1"/>` + vtick(xA, vy, false) + vtick(xB, vy, false);
    s += `<rect x="${vmx - 44}" y="${vy - 8}" width="88" height="15" rx="3" fill="url(#ldBg)"/>`;
    s += `<text x="${vmx}" y="${vy + 3}" text-anchor="middle" font-size="10" font-weight="700" fill="${VDIM}">${fmtIn(tot)} ${axisLabel('E', 'W')}</text>`;
  }

  // ── interior callout (centered pill, inches + proposal-style ft-in) ─
  const cw = 150, chh = 36;
  const ccx = x0 + W / 2, ccy = y0 + H / 2;
  s += `<rect x="${ccx - cw / 2}" y="${ccy - chh / 2}" width="${cw}" height="${chh}" rx="14" fill="rgba(255,255,255,0.92)" stroke="#cfd3da" stroke-width="1"/>`;
  s += `<text x="${ccx}" y="${ccy - 6}" text-anchor="middle" font-size="9.5" font-weight="700" letter-spacing="0.08em" fill="#8a8f97">INTERIOR</text>`;
  // short axis first — matches the spec sheets ("46″ x 70″") and the model
  // naming convention (4872 = 48″ × 72″)
  s += `<text x="${ccx}" y="${ccy + 5}" text-anchor="middle" font-size="11" font-weight="800" fill="#2a2d33">${interior.h}″ × ${interior.w}″</text>`;
  s += `<text x="${ccx}" y="${ccy + 14.5}" text-anchor="middle" font-size="8" fill="#8a8f97">${ftIn(interior.h)} × ${ftIn(interior.w)}</text>`;

  // ── orientation captions (booth orientation is fixed; components can move) ─
  s += `<text x="${x0 + W / 2}" y="${y0 - extra('N') - 8}" text-anchor="middle" font-size="9" font-weight="700" letter-spacing="0.12em" fill="#9097a0">BACK</text>`;
  s += `<text x="${x0 + W / 2}" y="${dimY + 22}" text-anchor="middle" font-size="9" font-weight="700" letter-spacing="0.12em" fill="#9097a0">FRONT</text>`;

  s += `</svg>`;
  return s;
}

// ── Component art: SketchUp face-on renders of the REAL parts ──────
// (Z:\Sketchup\BoothBuilderClaude\Components → assets/booth-art/*.webp,
// alpha-cropped + exposure-normalized + WebP'd by the import pass.) The
// elevation composites these at true scale; the vector drawing stays
// underneath as a loading fallback, and parts with no art yet keep their
// vector look. compWIn = the component's real width in inches; aspect =
// image w/h — the renders are parallel-projection face-on, so the aspect IS
// the real proportion and heights derive as compWIn/aspect (≈80.7″ wall).
// Seal widths derive the same way (~7.9″ mid cap, ~4.9″ corner leg). The
// seals deliberately OVERLAP the wall edges — that's where the bolt holes
// on the wall sides bind into them on the real product.
const ART_BASE = (typeof window !== 'undefined' && window.BB_ART_BASE)
  || (typeof global !== 'undefined' && global.BB_ART_BASE) || '/assets/booth-art/';
const ELEV_ART = {
  SOLID:  { file: 'wall-46.webp',         compWIn: 46, aspect: 0.5687 },
  VNT:    { file: 'wall-46-vnt.webp',     compWIn: 46, aspect: 0.5625, packOk: /\bVNT\b/i },
  WDO:    { file: 'wall-46-wdo3236.webp', compWIn: 46, aspect: 0.5700, packOk: /WDO\s*3236\b/i },
  // door: dedicated art per hinge — fileR is the mirrored render with the
  // logo plate re-pasted unmirrored (a blind flip would mirror the text)
  DRFRM:  { file: 'door-30-left.webp', fileR: 'door-30-right.webp', compWIn: 46, aspect: 0.5675, packOk: /^(FR\s+)?STDWL\d+\s+DRFRM/i },  // std frames — WA/ADA (49″) stays vector
  // WA (wide-access) door — 49″ frame, 32″ leaf, 16×48 window; the with-ramp
  // variants show the ramp foot at the sill. Right files have the logo fixed.
  DRFRM_WA:      { file: 'door-wa-left.webp',      fileR: 'door-wa-right.webp',      compWIn: 49, aspect: 0.6050 },
  DRFRM_WA_RAMP: { file: 'door-wa-ramp-left.webp', fileR: 'door-wa-ramp-right.webp', compWIn: 49, aspect: 0.5975 },
  // ADA ramp — protrudes 3′ 9⅝″ (45.625″) from the door wall. rampTop is the
  // plan view (sill strip at the top of the image overlaps the wall ~2″);
  // rampSide is the floor wedge seen edge-on.
  rampTop:  { file: 'ramp-top.webp',  aspect: 1.0012, protIn: 45.625, sillIn: 2 },
  rampSide: { file: 'ramp-side.webp', aspect: 0.6175, protIn: 45.625, compHIn: 80.7 },
  midSeal:    { file: 'seal-mid.webp',    widthIn: 7.9 },
  cornerSeal: { file: 'seal-corner.webp', widthIn: 4.9 },
  // side view of a vent wall (wall edge + protruding ducts + fan) — used when
  // the vent sits on a wall ADJACENT to the facing one. The ducts reach 5.5″
  // past the booth edge; the rest of the image overlaps the booth face and
  // the corner seal draws over that overlap, like the real assembly.
  ventSide: { fileL: 'vent-side-left.webp', aspectL: 0.1388, fileR: 'vent-side-right.webp', aspectR: 0.1275, protIn: 5.5, compHIn: 80.7 },
};
// windows: full render set — 32-series sits in a 46″ wall, 26-series in a
// 40″ wall. 43″/31″ host walls have no dedicated renders; per Benton the
// 26-series art stands in (those panels are just slightly thinner than 43″).
const WDO_ART = {
  '3230': { file: 'wall-46-wdo3230.webp', compWIn: 46, aspect: 0.5687 },
  '3236': { file: 'wall-46-wdo3236.webp', compWIn: 46, aspect: 0.5687 },
  '3242': { file: 'wall-46-wdo3242.webp', compWIn: 46, aspect: 0.5687 },
  '3248': { file: 'wall-46-wdo3248.webp', compWIn: 46, aspect: 0.5675 },
  '2630': { file: 'wall-40-wdo2630.webp', compWIn: 40, aspect: 0.4950 },
  '2636': { file: 'wall-40-wdo2636.webp', compWIn: 40, aspect: 0.4938 },
  '2642': { file: 'wall-40-wdo2642.webp', compWIn: 40, aspect: 0.4938 },
  '2648': { file: 'wall-40-wdo2648.webp', compWIn: 40, aspect: 0.4938 },
};
function elevArtFor(kind, line, layout) {
  if (!line) return null;
  const pack = String(line.pack || '');
  if (kind === 'DRFRM' && /^WA\s+STDDRFRM/i.test(pack))
    return (layout && layout.ramp) ? ELEV_ART.DRFRM_WA_RAMP : ELEV_ART.DRFRM_WA;
  if (kind === 'WDO') {
    const m = pack.match(/WDO\s*(\d{2})(\d{2})/i);
    if (!m) return null;
    const host = +((pack.match(/^(?:FR\s+)?STDWL(\d+)/i) || [])[1] || 46);
    const series = host < 46 ? '26' : '32';
    const want = +m[2];
    const h = [30, 36, 42, 48].reduce((b, x) => Math.abs(x - want) < Math.abs(b - want) ? x : b, 30);
    return WDO_ART[series + h] || null;
  }
  const art = ELEV_ART[kind];
  if (!art) return null;
  if (art.packOk && !art.packOk.test(pack)) return null;
  return art;
}

// ── Elevation renderer: one wall viewed face-on from OUTSIDE ────────
// Skeleton of the booth-builder front/side view (plan Phase C): correct
// proportions and per-panel features — door with window/hinges/handle, wall
// windows at their real WDO sizes, vent ducts (intake low, exhaust high —
// "fresh air flows in at the floor and out at the ceiling"), cable passages.
// `facing` = which exterior wall you're looking at: S front, E right, N back,
// W left. N and E render mirrored so left/right match what a viewer standing
// OUTSIDE that wall actually sees. Heights: 83″ standard / 85″ enhanced.
function renderElevationSvg(layout, assign, facing) {
  const ext = layout.exterior;
  const wall = layout.walls[facing] || { slots: [] };
  const lenIn = (facing === 'N' || facing === 'S') ? ext.w : ext.h;
  // 6′11″ standard / 7′1″ enhanced, +10″ with the height extension
  const hIn = (/^E/i.test(String(layout.variant || 'S')) ? 85 : 83) + (layout.heightExt ? 10 : 0);
  const lift = layout.casters ? 5 : 0;          // caster plate raises the booth ~5″
  const PX2 = Math.max(2.4, Math.min(340 / lenIn, 280 / (hIn + lift), 5.5));
  const Wp = lenIn * PX2, Hp = hIn * PX2, liftPx = lift * PX2;
  // Vents on the walls ADJACENT to the facing wall protrude 5.5″ past the
  // booth edge — from this view you see the SIDE of those duct boxes hanging
  // off the left/right edge. Adjacency respects the viewer's left/right
  // (standing outside the facing wall).
  const ADJ = { S: { left: 'W', right: 'E' }, N: { left: 'E', right: 'W' }, E: { left: 'S', right: 'N' }, W: { left: 'N', right: 'S' } };
  // ventilation upgrades (mirror the top-down): VSS extra ducts, EFS 10″
  // floor silencer, ROOF = ducts on the roof / no wall protrusion
  const VSS = !!layout.vss, EFS = !!layout.efs, ROOF = !!layout.roofVent;
  const hasVentOn = sd => {
    if (layout.hasVent === false || ROOF) return false;
    const w2 = layout.walls[sd]; if (!w2) return false;
    return w2.slots.some(sl => { const ln = assign[sl.id]; return ln && classifyWall(ln.pack) === 'VNT'; });
  };
  const leftVent = hasVentOn(ADJ[facing].left), rightVent = hasVentOn(ADJ[facing].right);
  // ADA ramp on an adjacent wall: its wedge reaches 3′ 9⅝″ past the edge
  const RAMP = !!layout.ramp;
  const RAMP_PROT2 = 45.625;
  const hasRampDoorOn = sd => {
    if (!RAMP) return false;
    const w2 = layout.walls[sd]; if (!w2) return false;
    return w2.slots.some(sl => { const ln = assign[sl.id]; return ln && classifyWall(ln.pack) === 'DRFRM' && panelInteriorWidth(ln.pack) >= 49; });
  };
  const leftRamp = hasRampDoorOn(ADJ[facing].left), rightRamp = hasRampDoorOn(ADJ[facing].right);
  const VOUT2 = 5.5 * PX2;
  const EPROT2 = EFS ? 10 : 5.5;                 // EFS reaches 10″ past the edge
  const EOUT2 = EPROT2 * PX2;
  const lProtIn = Math.max(leftVent ? EPROT2 : 0, leftRamp ? RAMP_PROT2 : 0);
  const rProtIn = Math.max(rightVent ? EPROT2 : 0, rightRamp ? RAMP_PROT2 : 0);
  const roofPad = ROOF ? 9 * PX2 : 0;            // headroom for the on-roof ducts
  const M = 46;
  const totalW = Wp + M * 2 + (lProtIn + rProtIn) * PX2;
  const totalH = Hp + liftPx + 34 + 30 + 5 + ((lProtIn || rProtIn) ? 16 : 0) + roofPad;
  const x0 = M + lProtIn * PX2, y0 = 24 + roofPad;
  const fb = y0 + Hp;                          // booth floor (bottom of the walls)
  const FLOORH = 4.5;                          // floor platform peeking below the walls
  const gy = fb + FLOORH + liftPx;             // ground line (floor strip, then casters)
  const iy = v => fb - v * PX2;                // inches above the BOOTH FLOOR → px

  let s = `<svg class="ld-elev-svg" viewBox="0 0 ${totalW} ${totalH}" preserveAspectRatio="xMidYMid meet" `
        + `style="width:100%;max-width:520px;display:block;margin:0 auto;font-family:'DM Sans',sans-serif">`;
  // same defs/ids as the top-down — identical content, so document-wide id
  // resolution is harmless, and standalone renders still work
  s += `<defs>`
    + `<linearGradient id="ldBg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#eef0f3"/><stop offset="1" stop-color="#f8f9fa"/></linearGradient>`
    + `<pattern id="ldSeal" width="5" height="5" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="#26272b"/><circle cx="1.2" cy="1.8" r="0.8" fill="#15161a"/><circle cx="3.7" cy="3.7" r="0.8" fill="#43454d"/><circle cx="3.6" cy="0.9" r="0.6" fill="#0e0f12"/><circle cx="0.8" cy="4.2" r="0.5" fill="#50535c"/></pattern>`
    // seam seals sit PROUD of the wall plane — a soft cast shadow on both
    // sides gives the joint the depth Benton's assembly render shows (the
    // flat composites read "very plain together" without it)
    + `<pattern id="ldCarpetArt" patternUnits="userSpaceOnUse" width="${46 * PX2}" height="${(46 / 0.5687) * PX2}"><image href="${ART_BASE}wall-46.webp" width="${46 * PX2}" height="${(46 / 0.5687) * PX2}" preserveAspectRatio="none"/></pattern>`
    + `<filter id="ldSealShadow" x="-150%" y="-8%" width="400%" height="116%">`
    +   `<feDropShadow dx="-2.4" dy="0" stdDeviation="2" flood-color="#000" flood-opacity="0.5"/>`
    +   `<feDropShadow dx="2.4" dy="1.5" stdDeviation="2" flood-color="#000" flood-opacity="0.45"/>`
    + `</filter>`
    + `</defs>`;
  s += `<rect x="0" y="0" width="${totalW}" height="${totalH}" fill="url(#ldBg)"/>`;
  // ground line + soft shadow
  s += `<ellipse cx="${x0 + Wp / 2}" cy="${gy + 5}" rx="${Wp * 0.55}" ry="5" fill="#5a5f66" opacity="0.16"/>`;
  s += `<rect x="${x0 - 16}" y="${gy}" width="${Wp + 32}" height="1.2" fill="#c4c8ce"/>`;

  // slots left→right as seen from outside (N + E mirrored)
  const slots = wall.slots.slice();
  const mirrored = (facing === 'N' || facing === 'E');
  if (mirrored) slots.reverse();
  // same effective-width rule as the top-down: the WA-door pair draws at its
  // real 49″ + companion widths, so the batten (seam seal) between them
  // shifts 3″/9″ to the true joint
  const effSize = sl => {
    const ln = assign[sl.id]; if (!ln) return sl.size;
    const w = panelInteriorWidth(ln.pack);
    if (w == null) return sl.size;
    if (w >= 49) return w;                       // WA/ADA frame: always true 49″
    return (Math.abs(w - sl.size) >= 3 && [7, 19, 31, 43].indexOf(w) >= 0) ? w : sl.size;
  };
  const nominal = slots.reduce((a, sl) => a + effSize(sl), 0) || 1;
  const scale = Wp / nominal;

  // per-panel features, drawn after all strips + battens. hasArt = the slot
  // is covered by a component render — skip whatever the photo already shows.
  function elevFeatures(kind, line, sx, w, hasArt) {
    const cx2 = sx + w / 2;
    let g = '';
    if (kind === 'DRFRM' && line) {
      const frameW = panelInteriorWidth(line.pack) || 46;
      const doorW = (frameW >= 49 ? 32 : Math.max(20, frameW - 16)) * PX2;  // 32″ WA/ADA, 30″ std
      const doorH = 78 * PX2;
      const dx = cx2 - doorW / 2, dy = fb - 2 - doorH;
      let hingeRight = /\sR\b/i.test(line.pack || '');
      if (mirrored) hingeRight = !hingeRight;
      g += `<rect x="${dx}" y="${dy}" width="${doorW}" height="${doorH}" rx="1.5" fill="url(#ldSeal)" stroke="#0d0e11" stroke-width="1.3"/>`;
      g += `<rect x="${dx + 2}" y="${dy + 2}" width="${doorW - 4}" height="${doorH - 4}" fill="none" stroke="#8a8e98" stroke-opacity="0.45" stroke-width="0.7"/>`;
      // door window: WA/ADA 16×48; else 16×30 on 46-module, 12×30 on 40-module
      const wdw = (frameW >= 49 ? 16 : (layout.module === 40 ? 12 : 16)) * PX2;
      const wdh = (frameW >= 49 ? 48 : 30) * PX2;
      g += `<rect x="${cx2 - wdw / 2 - 1.5}" y="${iy(70) - 1.5}" width="${wdw + 3}" height="${wdh + 3}" rx="1.5" fill="#1b1c20"/>`;
      g += `<rect x="${cx2 - wdw / 2}" y="${iy(70)}" width="${wdw}" height="${wdh}" fill="#aecde8"/>`;
      g += `<line x1="${cx2 - wdw / 2 + 2}" y1="${iy(70) + wdh * 0.75}" x2="${cx2 + wdw / 2 - 2}" y2="${iy(70) + wdh * 0.25}" stroke="#fff" stroke-opacity="0.55" stroke-width="1.5"/>`;
      // handle on the latch side (~38″), hinges on the other
      const latchX = hingeRight ? dx + 5 : dx + doorW - 5;
      const hingeX = hingeRight ? dx + doorW : dx;
      g += `<rect x="${latchX - 5}" y="${iy(38) - 1.6}" width="10" height="3.2" rx="1.6" fill="#caccd2" stroke="#6a6e76" stroke-width="0.6"/>`;
      for (const hh of [14, 40, 66])
        g += `<rect x="${hingeX - 1.6}" y="${iy(hh) - 4}" width="3.2" height="8" rx="1" fill="#caccd2" stroke="#6a6e76" stroke-width="0.5"/>`;
      // threshold
      g += `<rect x="${dx - 2}" y="${fb - 3}" width="${doorW + 4}" height="3" fill="#caccd2" stroke="#8a8e98" stroke-width="0.5"/>`;
    } else if (kind === 'WDO' && line) {
      const m2 = String(line.pack || '').match(/WDO\s*(\d{2})(\d{2})/i);
      const ww = (m2 ? +m2[1] : 32) * PX2, wh = (m2 ? +m2[2] : 36) * PX2;
      g += `<rect x="${cx2 - ww / 2 - 2.5}" y="${iy(72) - 2.5}" width="${ww + 5}" height="${wh + 5}" rx="2" fill="#1b1c20"/>`;
      g += `<rect x="${cx2 - ww / 2}" y="${iy(72)}" width="${ww}" height="${wh}" fill="#aecde8"/>`;
      g += `<line x1="${cx2 - ww / 2 + 3}" y1="${iy(72) + wh * 0.8}" x2="${cx2 + ww / 2 - 3}" y2="${iy(72) + wh * 0.2}" stroke="#fff" stroke-opacity="0.55" stroke-width="2"/>`;
    } else if (kind === 'VNT' && layout.hasVent !== false && !ROOF) {
      // intake duct low, exhaust duct high, remote fan unit at the floor
      // (a notch lighter than the carpet so they read on the dark walls)
      const dw = 8 * PX2, dh = 30 * PX2;
      const ductAt = (fx, hIn2) => `<rect x="${fx - dw / 2}" y="${iy(hIn2)}" width="${dw}" height="${dh}" rx="1.5" fill="#3e414a" stroke="#0d0e11" stroke-width="0.9"/>`;
      if (!hasArt) {
        g += ductAt(sx + w * 0.26, 34);
        g += ductAt(sx + w * 0.72, 76);
      }
      if (VSS) {
        // VSS = a second silencer duct beside each, hose-connected (catalog)
        const ix2 = sx + w * 0.26 + dw + 3, ex2 = sx + w * 0.72 - dw - 3;
        g += ductAt(ix2, 34) + ductAt(ex2, 76);
        g += `<path d="M ${sx + w * 0.26 + dw / 2} ${iy(34) + 3} Q ${(sx + w * 0.26 + ix2) / 2 + dw / 2} ${iy(34) - 4} ${ix2 - dw / 2 + 1} ${iy(34) + 3}" fill="none" stroke="#0d0e11" stroke-width="2" stroke-linecap="round"/>`;
        g += `<path d="M ${sx + w * 0.72 - dw / 2} ${iy(76) + dh - 3} Q ${(sx + w * 0.72 + ex2) / 2 - dw / 2} ${iy(76) + dh + 4} ${ex2 + dw / 2 - 1} ${iy(76) + dh - 3}" fill="none" stroke="#0d0e11" stroke-width="2" stroke-linecap="round"/>`;
      }
      if (EFS) {
        // EFS wraps the fan in a floor-level silencer box (10″ tall footprint)
        g += `<rect x="${sx + w * 0.72 - 8 * PX2}" y="${iy(13)}" width="${16 * PX2}" height="${13 * PX2 - 1}" rx="2.5" fill="#2c2d33" stroke="#0d0e11" stroke-width="1"/>`;
        g += `<rect x="${sx + w * 0.72 - 8 * PX2 + 2.5}" y="${iy(13) + 2.5}" width="${16 * PX2 - 5}" height="${13 * PX2 - 6}" rx="2" fill="none" stroke="#4a4d55" stroke-width="0.8"/>`;
      } else if (!hasArt) {   // the vent art already shows the fan unit
        g += `<rect x="${sx + w * 0.72 - 3.5 * PX2}" y="${iy(10)}" width="${7 * PX2}" height="${10 * PX2 - 2}" rx="2" fill="#383b43" stroke="#0d0e11" stroke-width="0.9"/>`;
        g += `<circle cx="${sx + w * 0.72}" cy="${iy(5.2)}" r="${2.4 * PX2}" fill="#22242a" stroke="#54585f" stroke-width="0.8"/>`;
        g += `<circle cx="${sx + w * 0.72}" cy="${iy(5.2)}" r="${0.8 * PX2}" fill="#62666f"/>`;
      }
    } else if (kind === 'CBL' && line) {
      for (const chh of [14, 64]) {
        g += `<circle cx="${cx2}" cy="${iy(chh)}" r="${2.6 * PX2}" fill="#26282d" stroke="#0d0e11" stroke-width="0.8"/>`;
        g += `<circle cx="${cx2}" cy="${iy(chh)}" r="${1.1 * PX2}" fill="#0d0e11"/>`;
      }
    } else if (!line) {
      g += `<text x="${cx2}" y="${iy(40)}" text-anchor="middle" font-size="9" fill="#aab" font-style="italic">(empty)</text>`;
    }
    return g;
  }

  // composite a component render over its slot box. Full components stretch
  // to the box (carpet tolerates it; HX just stretches taller) — EXCEPT
  // narrower solid walls, which CROP the 46″ art horizontally so the carpet
  // texture stays at true scale instead of squishing.
  function artPanel(art, kind, line, sx, wPx, wIn) {
    let href = ART_BASE + art.file;
    const artHIn = art.compWIn / art.aspect;
    if (kind === 'SOLID' && wIn < art.compWIn - 1) {
      const cx2 = (art.compWIn - wIn) / 2;
      return `<svg x="${sx}" y="${y0}" width="${wPx}" height="${Hp}" viewBox="${cx2} 0 ${wIn} ${artHIn}" preserveAspectRatio="none">`
        + `<image href="${href}" x="0" y="0" width="${art.compWIn}" height="${artHIn}" preserveAspectRatio="none"/></svg>`;
    }
    if (kind === 'DRFRM' && art.fileR) {
      // hinge-specific art (the right variant keeps the logo readable)
      let hingeRight = /\sR\b/i.test(String(line.pack || ''));
      if (mirrored) hingeRight = !hingeRight;
      if (hingeRight) href = ART_BASE + art.fileR;
    }
    // SketchUp exports glass as TRANSPARENT pixels — tint the slot behind the
    // art so windows read as glass instead of holes into the dark carpet
    const under = (kind === 'WDO' || kind === 'DRFRM')
      ? `<rect x="${sx}" y="${y0}" width="${wPx}" height="${Hp}" fill="#bdd9ef"/>` : '';
    return under + `<image href="${href}" x="${sx}" y="${y0}" width="${wPx}" height="${Hp}" preserveAspectRatio="none"/>`;
  }

  let off = 0, feats = '';
  for (const slot of slots) {
    const w = effSize(slot) * scale;
    const line = assign[slot.id];
    const kind = line ? classifyWall(line.pack) : 'EMPTY';
    s += `<rect x="${x0 + off}" y="${y0}" width="${w}" height="${Hp}" fill="${line ? 'url(#ldSeal)' : '#e9e9ec'}" stroke="#15161a" stroke-width="0.8"/>`;
    const art = elevArtFor(kind, line, layout);
    if (art) s += artPanel(art, kind, line, x0 + off, w, effSize(slot));
    // vector details: everything when there's no art; with VNT art the photo
    // already shows the ducts/hose/fan, so only the VSS/EFS extras draw
    if (!art || kind === 'VNT') feats += elevFeatures(kind, line, x0 + off, w, !!art);
    off += w;
  }
  // roof cap + floor platform — the SAME carpet as the wall renders (the old
  // speckle pattern read as a different fabric). The floor peeks out just
  // below the walls, mirroring the cap, like the real booth base.
  s += `<rect x="${x0 - 2.5}" y="${y0 - 3.5}" width="${Wp + 5}" height="4.5" rx="1.8" fill="url(#ldCarpetArt)" stroke="#15161a" stroke-width="0.8"/>`;
  s += `<rect x="${x0 - 2.5}" y="${fb - 1}" width="${Wp + 5}" height="${FLOORH + 1}" rx="1.8" fill="url(#ldCarpetArt)" stroke="#15161a" stroke-width="0.8"/>`;
  // roof-mounted vent set: the duct boxes ride ON the roof — visible from
  // every side, so they always draw when the booth is roof-vented
  if (ROOF) {
    const bw2 = Math.min(16 * PX2, Wp * 0.22), bh2 = 8 * PX2, gp2 = Math.max(5 * PX2, 8);
    for (const k of [-1, 1]) {
      const bx2 = x0 + Wp * 0.62 + k * (bw2 / 2 + gp2 / 2) - bw2 / 2;
      const by2 = y0 - 3.5 - bh2;
      s += `<rect x="${bx2}" y="${by2}" width="${bw2}" height="${bh2}" rx="2" fill="url(#ldSeal)" stroke="#0d0e11" stroke-width="0.9"/>`;
      if (k === 1) {
        s += `<circle cx="${bx2 + bw2 / 2}" cy="${by2 + bh2 / 2}" r="${Math.min(bw2, bh2) * 0.30}" fill="#22242a" stroke="#54585f" stroke-width="0.8"/>`;
        s += `<circle cx="${bx2 + bw2 / 2}" cy="${by2 + bh2 / 2}" r="${Math.min(bw2, bh2) * 0.10}" fill="#62666f"/>`;
      } else {
        s += `<rect x="${bx2 + bw2 * 0.22}" y="${by2 + bh2 * 0.22}" width="${bw2 * 0.56}" height="${bh2 * 0.56}" rx="1" fill="none" stroke="#4a4d55" stroke-width="0.8"/>`;
      }
    }
  }
  // caster plate + wheels (booth raised ~5″ off the ground)
  if (lift > 0) {
    s += `<rect x="${x0 - 1}" y="${fb + FLOORH}" width="${Wp + 2}" height="${liftPx * 0.38}" rx="1.5" fill="#26282d" stroke="#15161a" stroke-width="0.8"/>`;
    for (const f of [0.08, 0.36, 0.64, 0.92]) {
      const wx = x0 + Wp * f;
      s += `<circle cx="${wx}" cy="${gy - liftPx * 0.32}" r="${liftPx * 0.34}" fill="#1b1c20" stroke="#000" stroke-width="0.8"/>`;
      s += `<circle cx="${wx}" cy="${gy - liftPx * 0.32}" r="${liftPx * 0.12}" fill="#54585f"/>`;
    }
  }
  // side profile of an adjacent wall's vent set — Benton's side-view renders
  // (vent-side-left/right), composited so the ducts protrude 5.5″ past the
  // booth edge and the wall-edge part of the image overlaps the booth face
  // (the corner seal draws over that overlap, like the real assembly).
  // The old gray vector duct bands are GONE — they drew wider than the art
  // and peeked out from behind it.
  function ventSideProfile(atLeft) {
    let g = '';
    const vs = ELEV_ART.ventSide;
    if (vs) {
      const wIn = vs.compHIn * (atLeft ? vs.aspectL : vs.aspectR);
      const wPx = wIn * PX2;
      const vx = atLeft ? x0 - vs.protIn * PX2 : x0 + Wp + vs.protIn * PX2 - wPx;
      g += `<image href="${ART_BASE + (atLeft ? vs.fileL : vs.fileR)}" x="${vx}" y="${y0}" width="${wPx}" height="${Hp}" preserveAspectRatio="none"/>`;
    }
    if (EFS) {
      // EFS silencer box at the floor — protrudes a full 10″ past the edge
      const ebx = atLeft ? x0 - EOUT2 : x0 + Wp;
      g += `<rect x="${ebx}" y="${iy(13)}" width="${EOUT2}" height="${13 * PX2 - 1}" rx="2.5" fill="#2c2d33" stroke="#0d0e11" stroke-width="1"/>`;
      g += `<rect x="${ebx + 2}" y="${iy(13) + 2}" width="${EOUT2 - 4}" height="${13 * PX2 - 5}" rx="2" fill="none" stroke="#4a4d55" stroke-width="0.8"/>`;
    }
    return g;
  }
  if (leftVent) s += ventSideProfile(true);
  if (rightVent) s += ventSideProfile(false);
  // ramp wedge seen edge-on, reaching 3′ 9⅝″ past the booth edge at the
  // floor (the art's wall-edge sliver tucks behind the corner seal)
  function rampSideProfile(atLeft) {
    const rs = ELEV_ART.rampSide;
    const wIn = rs.compHIn * rs.aspect;
    const wPx = wIn * PX2;
    const vx = atLeft ? x0 - rs.protIn * PX2 : x0 + Wp + rs.protIn * PX2 - wPx;
    const img = `<image href="${ART_BASE + rs.file}" x="${vx}" y="${y0}" width="${wPx}" height="${Hp}" preserveAspectRatio="none"/>`;
    // art has the wall at the right / wedge running left — mirror for the right side
    return atLeft ? img : `<g transform="translate(${2 * vx + wPx} 0) scale(-1 1)">${img}</g>`;
  }
  if (leftRamp) s += rampSideProfile(true);
  if (rightRamp) s += rampSideProfile(false);
  // seam-seal battens: full-height at every panel joint, wrapping both corners
  // (effective widths — a WA-door joint sits 3″/9″ off the module midline)
  const SB = Math.max(4.5, 3 * PX2);
  off = 0;
  for (let i = 0; i < slots.length - 1; i++) {
    off += effSize(slots[i]) * scale;
    s += `<rect x="${x0 + off - SB / 2}" y="${y0}" width="${SB}" height="${Hp}" fill="url(#ldSeal)" stroke="#0d0e11" stroke-width="0.9"/>`;
  }
  s += `<rect x="${x0 - SB * 0.45}" y="${y0}" width="${SB}" height="${Hp}" rx="1" fill="url(#ldSeal)" stroke="#0d0e11" stroke-width="0.9"/>`;
  s += `<rect x="${x0 + Wp - SB * 0.55}" y="${y0}" width="${SB}" height="${Hp}" rx="1" fill="url(#ldSeal)" stroke="#0d0e11" stroke-width="0.9"/>`;
  // …then the REAL seal renders on top, at art-derived widths, overlapping
  // the wall edges (that's where the walls' bolt holes bind into the seals —
  // the seals are SUPPOSED to cover part of each panel). Vector battens above
  // remain as the loading fallback.
  {
    const ms = ELEV_ART.midSeal, cs = ELEV_ART.cornerSeal;
    const mw = ms.widthIn * PX2, cw3 = cs.widthIn * PX2, outset = 1.2 * PX2;
    off = 0;
    for (let i = 0; i < slots.length - 1; i++) {
      off += effSize(slots[i]) * scale;
      s += `<image href="${ART_BASE + ms.file}" x="${x0 + off - mw / 2}" y="${y0}" width="${mw}" height="${Hp}" preserveAspectRatio="none" filter="url(#ldSealShadow)"/>`;
    }
    // corner seals: proud of the booth edge (outset) so they break the
    // silhouette like the real part, with the same cast shadow for depth.
    // Both corners draw the SAME image, unmirrored — the negative-scale
    // transform broke the right one (filter + flip rendered nothing), and
    // per Benton the right corner should look just like the left anyway.
    s += `<image href="${ART_BASE + cs.file}" x="${x0 - outset}" y="${y0}" width="${cw3}" height="${Hp}" preserveAspectRatio="none" filter="url(#ldSealShadow)"/>`;
    s += `<image href="${ART_BASE + cs.file}" x="${x0 + Wp + outset - cw3}" y="${y0}" width="${cw3}" height="${Hp}" preserveAspectRatio="none" filter="url(#ldSealShadow)"/>`;
  }
  s += feats;

  // dims: width below the ground line, height on the left
  const dy2 = gy + 18;
  s += `<line x1="${x0}" y1="${dy2}" x2="${x0 + Wp}" y2="${dy2}" stroke="#9097a0" stroke-width="1"/>`
    + `<line x1="${x0}" y1="${dy2 - 4}" x2="${x0}" y2="${dy2 + 4}" stroke="#9097a0" stroke-width="1"/>`
    + `<line x1="${x0 + Wp}" y1="${dy2 - 4}" x2="${x0 + Wp}" y2="${dy2 + 4}" stroke="#9097a0" stroke-width="1"/>`;
  s += `<rect x="${x0 + Wp / 2 - 26}" y="${dy2 - 8}" width="52" height="15" rx="3" fill="url(#ldBg)"/>`;
  s += `<text x="${x0 + Wp / 2}" y="${dy2 + 3}" text-anchor="middle" font-size="10" font-weight="700" fill="#4a4f57">${ftIn(lenIn)}</text>`;
  const dx2 = x0 - lProtIn * PX2 - 20;
  s += `<line x1="${dx2}" y1="${y0}" x2="${dx2}" y2="${fb}" stroke="#9097a0" stroke-width="1"/>`
    + `<line x1="${dx2 - 4}" y1="${y0}" x2="${dx2 + 4}" y2="${y0}" stroke="#9097a0" stroke-width="1"/>`
    + `<line x1="${dx2 - 4}" y1="${fb}" x2="${dx2 + 4}" y2="${fb}" stroke="#9097a0" stroke-width="1"/>`;
  s += `<rect x="${dx2 - 8}" y="${y0 + Hp / 2 - 26}" width="16" height="52" fill="url(#ldBg)"/>`;
  s += `<text x="${dx2}" y="${y0 + Hp / 2 + 3}" text-anchor="middle" font-size="10" font-weight="700" fill="#4a4f57" transform="rotate(-90 ${dx2} ${y0 + Hp / 2})">${ftIn(hIn)}</text>`;

  // overall width including adjacent-wall vent / EFS / ramp protrusion(s)
  if (lProtIn || rProtIn) {
    const VD = '#c9762e';
    const xA = x0 - lProtIn * PX2, xB = x0 + Wp + rProtIn * PX2;
    const tot = ftIn(lenIn + lProtIn + rProtIn);
    const bits = [];
    if (leftVent || rightVent) bits.push(EFS ? 'EFS' : 'vent');
    if (leftRamp || rightRamp) bits.push('ramp');
    const vy2 = dy2 + 16, vmx = (xA + xB) / 2;
    s += `<line x1="${xA}" y1="${vy2}" x2="${xB}" y2="${vy2}" stroke="${VD}" stroke-width="1"/>`
      + `<line x1="${xA}" y1="${vy2 - 4}" x2="${xA}" y2="${vy2 + 4}" stroke="${VD}" stroke-width="1"/>`
      + `<line x1="${xB}" y1="${vy2 - 4}" x2="${xB}" y2="${vy2 + 4}" stroke="${VD}" stroke-width="1"/>`;
    s += `<rect x="${vmx - 44}" y="${vy2 - 8}" width="88" height="15" rx="3" fill="url(#ldBg)"/>`;
    s += `<text x="${vmx}" y="${vy2 + 3}" text-anchor="middle" font-size="10" font-weight="700" fill="${VD}">${tot} w/ ${bits.join(' + ')}</text>`;
  }

  s += `</svg>`;
  return s;
}

// ── WA-Type-aware initial seating ───────────────────────────────────
// Greedy placeBom seats the 49″ WA/ADA door by slot preference (front wall)
// and the shrunken companion by closest width — neither knows the WA Type.
// But the companion's width ENCODES the type (7→4016 · 31→4040 · 19→4622 ·
// 43→4646), and the rule is: door slot + directly-adjacent companion seat
// conserve the displaced pair (slot + seat ≈ 49 + companion). If the greedy
// result violates that, relocate door + companion to the first conserving
// pair — preferring the door's current wall, then S, E, N, W. So a 4016
// quote on a 102126 loads with the door already on the 102″ side, 7″ wall
// beside it; a 4040 loads with the door on the 126″ side, 31″ beside it.
function waSeatDoor(layout, assign) {
  let doorSlot = null, doorSide = null, comp = null, compSide = null;
  for (const side of ['N', 'S', 'E', 'W']) {
    const wall = layout.walls[side]; if (!wall) continue;
    for (const slot of wall.slots) {
      const ln = assign[slot.id]; if (!ln) continue;
      const w = panelInteriorWidth(ln.pack);
      if (w == null) continue;
      if (classifyWall(ln.pack) === 'DRFRM' && w >= 49) { doorSlot = slot; doorSide = side; }
      else if ([7, 19, 31, 43].indexOf(w) >= 0 && Math.abs(w - slot.size) >= 3) { comp = { slot: slot, w: w }; compSide = side; }
    }
  }
  if (!doorSlot || !comp) return;
  const conserve = (a, b) => Math.abs(a.size + b.size - (49 + comp.w)) <= 3;
  const adjacent = (side, slot) => {
    const slots = layout.walls[side].slots;
    const i = slots.findIndex(s2 => s2.id === slot.id);
    return [slots[i - 1], slots[i + 1]].filter(Boolean);
  };
  // already valid? (companion directly adjacent + pair conserves)
  if (doorSide === compSide && adjacent(doorSide, doorSlot).some(s2 => s2.id === comp.slot.id && conserve(doorSlot, s2))) return;
  const swapIds = (x, y) => {
    if (x === y) return;
    const X = assign[x] || null, Y = assign[y] || null;
    if (Y == null) delete assign[x]; else assign[x] = Y;
    if (X == null) delete assign[y]; else assign[y] = X;
  };
  const order = [doorSide].concat(['S', 'E', 'N', 'W'].filter(s2 => s2 !== doorSide));
  for (const side of order) {
    const wall = layout.walls[side]; if (!wall) continue;
    const slots = wall.slots;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (Math.abs(slot.size - doorSlot.size) > 3) continue;   // door stays on its module size
      if (slot.id === comp.slot.id) continue;                  // never seat the door ON the companion
      for (const j of [i - 1, i + 1]) {
        const seat = slots[j];
        if (!seat || !conserve(slot, seat)) continue;
        swapIds(doorSlot.id, slot.id);
        swapIds(comp.slot.id, seat.id);
        return;
      }
    }
  }
}

// ── exports ──
// Node (preview/mktest harnesses + splice) gets module.exports; in the browser
// (served as /assets/layout-render.js for the Booth Builder) the top-level
// function declarations are simply globals.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { renderLayoutSvg, renderElevationSvg, placeBom, waSeatDoor, classifyWall, panelInteriorWidth, isWallPanel, KIND_META };
}
