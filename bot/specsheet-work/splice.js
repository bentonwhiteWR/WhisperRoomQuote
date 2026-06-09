// Splice the verified renderer (KIND_META + renderLayoutSvg from
// layout-render.js) plus a fresh renderLegend / renderLayoutTab / drag handlers
// into packing-list.html, replacing the old WALL_COLORS…renderLayoutTab block.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const mod = fs.readFileSync(path.join(__dirname, 'layout-render.js'), 'utf8');

// Extract verified pieces from the module (indented 2 spaces to match the page).
const kmStart = mod.indexOf('// Friendly type names');
const rsStart = mod.indexOf('// ── The renderer');
const meStart = mod.indexOf('module.exports');
const indent = block => block.split('\n').map(l => l.length ? '  ' + l : l).join('\n');
const kindMeta = indent(mod.slice(kmStart, rsStart).trim());
const renderSvg = indent(mod.slice(rsStart, meStart).trim());

const tail = `
  function renderLegend() {
    const sw = { DRFRM:'#ee6216', WDO:'#9ec4e6', VNT:'#54575f', SOLID:'#54575f' };
    const items = ['SOLID','VNT','DRFRM','WDO'].map(k =>
      '<span><span class="ld-sw" style="background:' + sw[k] + '"></span>' + KIND_META[k].label + '</span>'
    ).join('');
    return '<div class="layout-legend">' + items + ' <span class="ld-hint">↔ drag a panel onto another to swap</span></div>';
  }

  // ── Drag-to-rearrange: per-room placement state + pointer handlers ──
  // LAYOUT_STATE holds each room's current slot→line assignment so a customer
  // can drag panels around (e.g. move the door to a different wall) and see it
  // re-render live. Reset on every full render(); swaps mutate it in place.
  const LAYOUT_STATE = {};
  let _ldDrag = null;
  const ldRoomOf = el => { const w = el && el.closest && el.closest('[data-layout-room]'); return w ? +w.getAttribute('data-layout-room') : null; };

  function renderLayoutTab(rm, ri) {
    let st = LAYOUT_STATE[ri];
    if (!st || st.rm !== rm) {
      const layout = (DATA && DATA.layouts) ? DATA.layouts[rm.boothName] : null;
      if (!layout) {
        return '<div class="layout-wrap" data-layout-room="' + ri + '"><div class="layout-empty">'
          + 'Top-down layout not yet defined for <b>' + esc(rm.boothName) + '</b>.'
          + '</div></div>';
      }
      const placed = placeBom(layout, rm.lines).placement;
      st = LAYOUT_STATE[ri] = { rm, layout, assign: placed };
    }
    const layout = st.layout;
    const placedSet = new Set(Object.values(st.assign).filter(Boolean));
    const leftover = (rm.lines || []).filter(l => isWallPanel(l.pack) && !placedSet.has(l));
    let html = '<div class="layout-wrap" data-layout-room="' + ri + '">'
      + '<div class="layout-title">' + esc(rm.boothName) + ' · ' + esc(layout.label || '')
      +   ' <span class="layout-sub">' + esc(layout.variant || 'S') + '</span></div>'
      + renderLayoutSvg(layout, st.assign)
      + renderLegend();
    if (leftover.length) {
      html += '<div class="layout-empty" style="margin-top:12px;text-align:left;color:#5a3a18;background:rgba(245,158,11,.08);border-color:rgba(245,158,11,.4)">'
        + '<b>⚠ ' + leftover.length + ' wall component' + (leftover.length === 1 ? '' : 's') + ' not placed:</b> '
        + leftover.map(l => esc(l.code) + ' (' + esc(l.pack || '') + ')').join(', ') + '.</div>';
    }
    return html + '</div>';
  }

  function ldDown(e) {
    const g = e.target.closest && e.target.closest('.ld-panel');
    if (!g) return;
    const ri = ldRoomOf(g); if (ri == null) return;
    _ldDrag = { ri, from: g.getAttribute('data-slot'), g };
    g.classList.add('ld-grabbing');
    document.body.classList.add('ld-dragging');
    e.preventDefault();
  }
  function ldMove(e) {
    if (!_ldDrag) return;
    const pt = (e.touches && e.touches[0]) || e;
    const el = document.elementFromPoint(pt.clientX, pt.clientY);
    const tgt = el && el.closest && el.closest('.ld-panel');
    document.querySelectorAll('.ld-panel.ld-target').forEach(n => n.classList.remove('ld-target'));
    if (tgt && tgt !== _ldDrag.g && ldRoomOf(tgt) === _ldDrag.ri) tgt.classList.add('ld-target');
  }
  function ldUp(e) {
    if (!_ldDrag) return;
    const pt = (e.changedTouches && e.changedTouches[0]) || e;
    const el = document.elementFromPoint(pt.clientX, pt.clientY);
    const tgt = el && el.closest && el.closest('.ld-panel');
    if (tgt && tgt !== _ldDrag.g && ldRoomOf(tgt) === _ldDrag.ri) {
      ldSwap(_ldDrag.ri, _ldDrag.from, tgt.getAttribute('data-slot'));
    }
    document.querySelectorAll('.ld-panel.ld-target').forEach(n => n.classList.remove('ld-target'));
    document.body.classList.remove('ld-dragging');
    _ldDrag = null;
  }
  function ldSwap(ri, a, b) {
    const st = LAYOUT_STATE[ri]; if (!st || a === b) return;
    const A = st.assign[a] || null, B = st.assign[b] || null;
    if (B == null) delete st.assign[a]; else st.assign[a] = B;
    if (A == null) delete st.assign[b]; else st.assign[b] = A;
    const wrap = document.querySelector('[data-layout-room="' + ri + '"]');
    if (wrap) wrap.outerHTML = renderLayoutTab(st.rm, ri);
  }
  document.addEventListener('pointerdown', ldDown);
  document.addEventListener('pointermove', ldMove);
  document.addEventListener('pointerup', ldUp);

`;

// Re-splice mode: replace only the changed KIND_META + renderLayoutSvg region,
// leaving the already-present tail (renderLegend / renderLayoutTab / drag) in
// place. Falls back to inserting the tail too on a first run.
void tail;
const newBlock = kindMeta + '\n\n' + renderSvg;

const file = path.join(root, 'packing-list.html');
let html = fs.readFileSync(file, 'utf8');
const startMarker = '// Friendly type names for the panel';
const endMarker = '  function renderLegend(';
const i = html.indexOf(startMarker);
const j = html.indexOf(endMarker);
if (i < 0 || j < 0 || j < i) { console.error('markers not found', i, j); process.exit(1); }
html = html.slice(0, i) + newBlock.trimStart() + '\n\n' + html.slice(j);
fs.writeFileSync(file, html);
console.log('re-spliced KIND_META+renderLayoutSvg: removed', j - i, 'chars, inserted', newBlock.length);
