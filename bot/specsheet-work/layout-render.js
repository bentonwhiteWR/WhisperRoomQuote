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

// ── The renderer ──────────────────────────────────────────────────
function renderLayoutSvg(layout, assign) {
  const ext = layout.exterior;
  const interior = layout.interior || { w: ext.w - 2 * layout.wallThickness, h: ext.h - 2 * layout.wallThickness };
  const PX = Math.max(3, Math.min(600 / ext.w, 470 / ext.h, 11));
  const W = ext.w * PX, H = ext.h * PX, t = layout.wallThickness * PX;
  const VOUT = 52;        // vent protrusion estimate (px) for margin sizing (boxes scale with panel)
  const DOORR = 92;       // max door-swing radius (px symbol)
  // Which walls currently hold a door / vent — computed from the LIVE placement
  // (not hard-coded to S/N), so a dragged door or vent draws its swing/ducts on
  // whatever wall it now sits on, and the margins expand to fit.
  const sideHasDoor = { N: false, S: false, E: false, W: false };
  const sideHasVent = { N: false, S: false, E: false, W: false };
  for (const sd of ['N', 'S', 'E', 'W']) for (const slot of ((layout.walls[sd] || { slots: [] }).slots)) {
    const ln = assign[slot.id]; if (!ln) continue;
    const k = classifyWall(ln.pack);
    if (k === 'DRFRM') sideHasDoor[sd] = true;
    else if (k === 'VNT' && layout.hasVent !== false) sideHasVent[sd] = true;
  }
  const extra = sd => sideHasDoor[sd] ? DOORR + 10 : (sideHasVent[sd] ? VOUT + 18 : 0);
  const BASE = 50;
  const mTop = BASE + extra('N'), mBottom = BASE + extra('S'), mLeft = BASE + extra('W'), mRight = BASE + extra('E');
  const x0 = mLeft, y0 = mTop;
  const totalW = W + mLeft + mRight, totalH = H + mTop + mBottom;

  let s = `<svg class="ld-svg" viewBox="0 0 ${totalW} ${totalH}" preserveAspectRatio="xMidYMid meet" `
        + `style="width:100%;max-width:760px;display:block;margin:0 auto;font-family:'DM Sans',sans-serif;touch-action:none">`;

  // defs — gradients, shadow, carpet
  s += `<defs>`
    + `<linearGradient id="ldBg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#eef0f3"/><stop offset="1" stop-color="#f8f9fa"/></linearGradient>`
    + `<pattern id="ldCarpet" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" fill="#6d6d6b"/><rect width="7" height="1" fill="#656563"/><rect width="1" height="7" fill="#757573"/></pattern>`
    + `<pattern id="ldSeal" width="5" height="5" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="#54575f"/><circle cx="1.2" cy="1.8" r="0.8" fill="#33353b"/><circle cx="3.7" cy="3.7" r="0.8" fill="#7d818b"/><circle cx="3.6" cy="0.9" r="0.6" fill="#2a2c31"/><circle cx="0.8" cy="4.2" r="0.5" fill="#8a8e98"/></pattern>`
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
  const FOAM = '#2c2d33';
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
  // mid-wall seam seal (plinth): a flat base bar along the wall at the joint
  // (jx,jy on the interior face; nx,ny inward) with a centered tab protruding
  // into the booth — the profile from the spec diagram (left). Base ≈ 4× the
  // tab width, tab ≈ as deep as the base, matching the spec proportions.
  function midSeal(jx, jy, nx, ny) {
    const tx = -ny, ty = nx;                 // tangent = along the wall
    const baseHalf = SG * 1.5, baseDepth = SG * 0.45, tabHalf = SG * 0.38, tabExtra = SG * 0.5;
    const P = (a, n) => (jx + tx * a + nx * n) + ',' + (jy + ty * a + ny * n);
    const pts = [
      P(-baseHalf, 0), P(-baseHalf, baseDepth), P(-tabHalf, baseDepth),
      P(-tabHalf, baseDepth + tabExtra), P(tabHalf, baseDepth + tabExtra), P(tabHalf, baseDepth),
      P(baseHalf, baseDepth), P(baseHalf, 0),
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
    // wall's own slot widths, mounted on the EXTERIOR face with the tab
    // protruding outward (matches the spec-sheet top-down views).
    for (const side of ['N', 'S', 'E', 'W']) {
      const wall = layout.walls[side]; if (!wall || wall.slots.length < 2) continue;
      const nom = wall.slots.reduce((a, sl) => a + sl.size, 0) || 1;
      const horiz = (side === 'N' || side === 'S');
      let o = 0;
      for (let i = 0; i < wall.slots.length - 1; i++) {
        o += wall.slots[i].size;
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
    return g;
  }

  // Outer-edge midpoint + outward/along unit vectors for a panel on `side`.
  function edgeGeom(side, px, py, pw, ph) {
    if (side === 'N') return { omx: px + pw / 2, omy: py,      ox: 0, oy: -1, ax: 1, ay: 0, horiz: true };
    if (side === 'S') return { omx: px + pw / 2, omy: py + ph, ox: 0, oy: 1,  ax: 1, ay: 0, horiz: true };
    if (side === 'W') return { omx: px,          omy: py + ph / 2, ox: -1, oy: 0, ax: 0, ay: 1, horiz: false };
    return            { omx: px + pw, omy: py + ph / 2, ox: 1, oy: 0, ax: 0, ay: 1, horiz: false };
  }

  // ── vent assembly: TWO square boxes (one plain, one with a fan), spread
  // along the wall, protruding OUTWARD from whatever wall holds the vent ──
  function ventDuct(side, px, py, pw, ph) {
    const { omx, omy, ox, oy, ax, ay, horiz } = edgeGeom(side, px, py, pw, ph);
    const panelLen = horiz ? pw : ph;
    const B = Math.max(18, Math.min(panelLen * 0.30, 44));   // box scales with the wall panel (46" walls → big)
    const G = Math.max(7, B * 0.4), PL = 4;
    const off = B / 2 + G / 2;
    let g = '';
    // mounting plate hugging the wall edge under both boxes
    const plate = G + 2 * B + 6;
    if (horiz) g += `<rect x="${omx - plate / 2}" y="${oy < 0 ? omy - PL : omy}" width="${plate}" height="${PL}" rx="1.5" fill="#3a3b42"/>`;
    else       g += `<rect x="${ox < 0 ? omx - PL : omx}" y="${omy - plate / 2}" width="${PL}" height="${plate}" rx="1.5" fill="#3a3b42"/>`;
    for (const k of [-1, 1]) {
      const ccx = omx + ax * k * off, ccy = omy + ay * k * off;
      const rx = horiz ? (ccx - B / 2) : (ox < 0 ? omx - B : omx);
      const ry = horiz ? (oy < 0 ? omy - B : omy) : (ccy - B / 2);
      g += `<rect x="${rx}" y="${ry}" width="${B}" height="${B}" rx="2" fill="#34363d" stroke="#1b1c20" stroke-width="1"/>`;
      if (k === 1) {   // fan box
        g += `<circle cx="${rx + B / 2}" cy="${ry + B / 2}" r="${B * 0.32}" fill="#22242a" stroke="#54585f" stroke-width="0.9"/>`;
        g += `<circle cx="${rx + B / 2}" cy="${ry + B / 2}" r="${B * 0.11}" fill="#62666f"/>`;
      } else {         // plain box (no hole) — same square, just an inset panel line
        g += `<rect x="${rx + B * 0.2}" y="${ry + B * 0.2}" width="${B * 0.6}" height="${B * 0.6}" rx="1" fill="none" stroke="#4a4d55" stroke-width="0.9"/>`;
      }
    }
    return g;
  }

  // ── door: closed light leaf on the OUTER face (hinge dots + handle, like
  // the spec top-down) + a subtle dashed outward-swing arc ─────────
  function doorSwing(side, px, py, pw, ph, swingIn) {
    const { omx, omy, ox, oy, ax, ay, horiz } = edgeGeom(side, px, py, pw, ph);
    // leaf = the actual door width (swingIn inches, e.g. 30″ in a 46″ frame);
    // the dashed arc sweeps only until it protrudes DOORR px (≈ the spec's
    // partial-swing arc), so big doors don't blow out the margins.
    const leafW = Math.min(swingIn * PX, (horiz ? pw : ph) * 0.94);
    const hx = omx - ax * leafW / 2, hy = omy - ay * leafW / 2;  // hinge end
    const cX = omx + ax * leafW / 2, cY = omy + ay * leafW / 2;  // handle end
    const th = Math.asin(Math.min(1, DOORR / leafW));            // shown swing angle
    const eX = hx + leafW * (ax * Math.cos(th) + ox * Math.sin(th));
    const eY = hy + leafW * (ay * Math.cos(th) + oy * Math.sin(th));
    const sweep = ((cX - hx) * (eY - hy) - (cY - hy) * (eX - hx)) > 0 ? 1 : 0;
    const DL = Math.max(5, t * 0.4);                             // leaf thickness (px)
    let g = '';
    // swing arc, dashed + subtle (door opens outward)
    g += `<path d="M ${cX} ${cY} A ${leafW} ${leafW} 0 0 ${sweep} ${eX} ${eY}" fill="none" stroke="rgba(238,98,22,0.5)" stroke-width="1.2" stroke-dasharray="5,3"/>`;
    // closed door leaf hugging the outer face
    const lx = horiz ? omx - leafW / 2 : (ox < 0 ? omx - DL : omx);
    const ly = horiz ? (oy < 0 ? omy - DL : omy) : omy - leafW / 2;
    const lw = horiz ? leafW : DL, lh = horiz ? DL : leafW;
    g += `<rect x="${lx}" y="${ly}" width="${lw}" height="${lh}" rx="1" fill="#e9eaee" stroke="#1b1c20" stroke-width="1"/>`;
    // hinge dot pairs near the hinge end, handle nub at the closing end
    for (const f of [0.08, 0.22]) {
      const d1x = hx + ax * leafW * f + ox * DL * 0.32, d1y = hy + ay * leafW * f + oy * DL * 0.32;
      const d2x = hx + ax * leafW * f + ox * DL * 0.68, d2y = hy + ay * leafW * f + oy * DL * 0.68;
      g += `<circle cx="${d1x}" cy="${d1y}" r="1.3" fill="#26272c"/><circle cx="${d2x}" cy="${d2y}" r="1.3" fill="#26272c"/>`;
    }
    const hbx = cX - ax * leafW * 0.06, hby = cY - ay * leafW * 0.06;   // handle base on the leaf
    g += `<line x1="${hbx + ox * DL * 0.5}" y1="${hby + oy * DL * 0.5}" x2="${hbx + ox * (DL + 5)}" y2="${hby + oy * (DL + 5)}" stroke="#26272c" stroke-width="2" stroke-linecap="round"/>`;
    g += `<line x1="${hbx + ox * (DL + 5)}" y1="${hby + oy * (DL + 5)}" x2="${hbx + ox * (DL + 5) - ax * 7}" y2="${hby + oy * (DL + 5) - ay * 7}" stroke="#26272c" stroke-width="2" stroke-linecap="round"/>`;
    return g;
  }

  // ── draw one wall side's panels ─────────────────────────────────
  const vents = [];   // {side,px,py,pw,ph} — drawn after walls
  let door = null;    // {side,px,py,pw,ph,swing}

  function drawWall(side) {
    const wall = layout.walls[side]; if (!wall) return '';
    const horiz = (side === 'N' || side === 'S');
    const span = horiz ? (W - 2 * t) : (H - 2 * t);
    const nominal = wall.slots.reduce((a, sl) => a + sl.size, 0) || 1;
    const scale = span / nominal;
    let off = 0, g = '';
    for (const slot of wall.slots) {
      const line = assign[slot.id];
      const kind = line ? classifyWall(line.pack) : 'EMPTY';
      const meta = KIND_META[kind] || KIND_META.EMPTY;
      const len = slot.size * scale;
      // panel rect geometry per side
      let px, py, pw, ph;
      if (side === 'N') { px = x0 + t + off; py = y0;             pw = len; ph = t; }
      else if (side === 'S') { px = x0 + t + off; py = y0 + H - t; pw = len; ph = t; }
      else if (side === 'W') { px = x0;          py = y0 + t + off; pw = t; ph = len; }
      else { px = x0 + W - t; py = y0 + t + off; pw = t; ph = len; }
      g += `<g class="ld-panel" data-slot="${esc(slot.id)}">`;
      // invisible hit-pad: extends the grab target ~15px into the interior so
      // the thin wall bands are easy to drag. Drawn first (under the visuals).
      const HP = 15;
      let hx = px, hy = py, hw = pw, hh = ph;
      if (side === 'N')      { hh = ph + HP; }
      else if (side === 'S') { hy = py - HP; hh = ph + HP; }
      else if (side === 'W') { hw = pw + HP; }
      else                   { hx = px - HP; hw = pw + HP; }
      g += `<rect class="ld-hit" x="${hx}" y="${hy}" width="${hw}" height="${hh}" fill="#000" fill-opacity="0" style="pointer-events:all"/>`;
      // Wall panels are the SAME carpet as the seam seals (one material on
      // the real product — the spec-sheet top-downs draw them identically).
      g += `<rect class="ld-wall" x="${px}" y="${py}" width="${pw}" height="${ph}" fill="url(#ldSeal)" stroke="#15161a" stroke-width="0.8"/>`;
      // interior bevel highlight
      g += `<rect x="${px + 0.6}" y="${py + 0.6}" width="${pw - 1.2}" height="${ph - 1.2}" fill="none" stroke="#4a4c55" stroke-opacity="0.5" stroke-width="0.6"/>`;
      // kind accent line on the interior edge
      if (meta.accent) {
        if (side === 'N') g += `<rect x="${px + 1}" y="${py + ph - 2}" width="${pw - 2}" height="1.6" fill="${meta.accent}" opacity="0.8"/>`;
        else if (side === 'S') g += `<rect x="${px + 1}" y="${py + 0.4}" width="${pw - 2}" height="1.6" fill="${meta.accent}" opacity="0.8"/>`;
        else if (side === 'W') g += `<rect x="${px + pw - 2}" y="${py + 1}" width="1.6" height="${ph - 2}" fill="${meta.accent}" opacity="0.8"/>`;
        else g += `<rect x="${px + 0.4}" y="${py + 1}" width="1.6" height="${ph - 2}" fill="${meta.accent}" opacity="0.8"/>`;
      }
      // window glass inset
      if (kind === 'WDO') {
        if (horiz) g += `<rect x="${px + pw * 0.2}" y="${py + ph * 0.28}" width="${pw * 0.6}" height="${ph * 0.44}" fill="#9ec4e6" opacity="0.8" rx="1"/>`;
        else       g += `<rect x="${px + pw * 0.28}" y="${py + ph * 0.2}" width="${pw * 0.44}" height="${ph * 0.6}" fill="#9ec4e6" opacity="0.8" rx="1"/>`;
      }
      g += `</g>`;
      // collect vent / door for later overlay — on WHATEVER wall they sit
      if (kind === 'VNT' && layout.hasVent !== false) vents.push({ side, px, py, pw, ph });
      if (kind === 'DRFRM') door = { side, px, py, pw, ph, swing: (layout.door && layout.door.swing) || 30 };
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

  // vent ducts + door overlays (follow whatever wall currently holds them)
  vents.forEach(v => s += ventDuct(v.side, v.px, v.py, v.pw, v.ph));
  if (door) s += doorSwing(door.side, door.px, door.py, door.pw, door.ph, door.swing);

  // ── dimension lines (exterior) ──────────────────────────────────
  function tick(x, y, vert) {
    return vert ? `<line x1="${x - 4}" y1="${y}" x2="${x + 4}" y2="${y}" stroke="#9097a0" stroke-width="1"/>`
                : `<line x1="${x}" y1="${y - 4}" x2="${x}" y2="${y + 4}" stroke="#9097a0" stroke-width="1"/>`;
  }
  const dimY = y0 + H + extra('S') + 24;
  s += `<line x1="${x0}" y1="${dimY}" x2="${x0 + W}" y2="${dimY}" stroke="#9097a0" stroke-width="1"/>`;
  s += tick(x0, dimY, false) + tick(x0 + W, dimY, false);
  s += `<rect x="${x0 + W / 2 - 24}" y="${dimY - 9}" width="48" height="16" rx="3" fill="url(#ldBg)"/>`;
  s += `<text x="${x0 + W / 2}" y="${dimY + 3}" text-anchor="middle" font-size="11" font-weight="700" fill="#4a4f57">${ext.w}″</text>`;
  const dimX = x0 - extra('W') - 24;
  s += `<line x1="${dimX}" y1="${y0}" x2="${dimX}" y2="${y0 + H}" stroke="#9097a0" stroke-width="1"/>`;
  s += tick(dimX, y0, true) + tick(dimX, y0 + H, true);
  s += `<rect x="${dimX - 8}" y="${y0 + H / 2 - 9}" width="16" height="18" fill="url(#ldBg)"/>`;
  s += `<text x="${dimX}" y="${y0 + H / 2}" text-anchor="middle" font-size="11" font-weight="700" fill="#4a4f57" transform="rotate(-90 ${dimX} ${y0 + H / 2})">${ext.h}″</text>`;

  // ── interior callout (centered pill) ────────────────────────────
  const cw = 150, chh = 26;
  const ccx = x0 + W / 2, ccy = y0 + H / 2;
  s += `<rect x="${ccx - cw / 2}" y="${ccy - chh / 2}" width="${cw}" height="${chh}" rx="13" fill="rgba(255,255,255,0.92)" stroke="#cfd3da" stroke-width="1"/>`;
  s += `<text x="${ccx}" y="${ccy - 1}" text-anchor="middle" font-size="9.5" font-weight="700" letter-spacing="0.08em" fill="#8a8f97">INTERIOR</text>`;
  // short axis first — matches the spec sheets ("46″ x 70″") and the model
  // naming convention (4872 = 48″ × 72″)
  s += `<text x="${ccx}" y="${ccy + 10}" text-anchor="middle" font-size="11" font-weight="800" fill="#2a2d33">${interior.h}″ × ${interior.w}″</text>`;

  // ── orientation captions (booth orientation is fixed; components can move) ─
  s += `<text x="${x0 + W / 2}" y="${y0 - extra('N') - 8}" text-anchor="middle" font-size="9" font-weight="700" letter-spacing="0.12em" fill="#9097a0">BACK</text>`;
  s += `<text x="${x0 + W / 2}" y="${dimY + 22}" text-anchor="middle" font-size="9" font-weight="700" letter-spacing="0.12em" fill="#9097a0">FRONT</text>`;

  s += `</svg>`;
  return s;
}

module.exports = { renderLayoutSvg, placeBom, classifyWall, panelInteriorWidth, isWallPanel, KIND_META };
