// Visual harness for the booth-builder renderer: renders top-down + elevation
// for a few booths in BOTH standard-door and WA-door trim, so the WA seam-seal
// shift (3″ on 4646/4622 pairs, 9″ on 4040/4016) and the carpet recolor can be
// eyeballed side by side. Writes wapreview.html for headless-Chrome screenshots.
// Usage: node bot/specsheet-work/wapreview.js  [then chrome --headless ...]
const fs = require('fs');
const path = require('path');
const { renderLayoutSvg, renderElevationSvg, classifyWall } = require('../../assets/layout-render.js');

const BL = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'pl-data', 'booth-layouts.json'), 'utf8')).layouts;

function resolve(name, variant) {
  const base = BL[name]; if (!base) return null;
  const v = base.variants[variant] || base.variants.S;
  return Object.assign({}, base, v, { variant, foamColor: 'Gray' });
}
const eachSlot = (layout, fn) => ['N', 'S', 'E', 'W'].forEach(sd => {
  (layout.walls[sd] || { slots: [] }).slots.forEach(sl => fn(sl, sd));
});
function defaultAssign(layout) {
  const a = {};
  eachSlot(layout, slot => {
    const k = slot.kind || (slot.prefers && slot.prefers[0]) || 'SOLID';
    const real = [16, 22, 28, 40, 43, 46].reduce((b, w) => Math.abs(w - slot.size) < Math.abs(b - slot.size) ? w : b, 16);
    a[slot.id] = { code: '', pack: k === 'VNT' ? `STDWL${real} VNT` : k === 'DRFRM' ? `STDWL${real} DRFRM R` : `STDWL${real}` };
  });
  return a;
}
// same pair rule as the page: door slot + adjacent seat conserve 49 + companion
function applyWa(layout, assign) {
  for (const side of ['S', 'E', 'N', 'W']) {
    const slots = (layout.walls[side] || { slots: [] }).slots;
    for (let i = 0; i < slots.length; i++) {
      if (slots[i].size < 36) continue;
      for (const j of [i - 1, i + 1]) {
        const seat = slots[j]; if (!seat) continue;
        for (const w of [7, 19, 31, 43]) {
          if (Math.abs(slots[i].size + seat.size - (49 + w)) > 3) continue;
          // clear any existing door, then seat the WA pair here
          eachSlot(layout, sl => { if (classifyWall(assign[sl.id].pack) === 'DRFRM') assign[sl.id] = { code: '', pack: 'STDWL46' }; });
          assign[slots[i].id] = { code: '', pack: 'WA STDDRFRM R' };
          assign[seat.id] = { code: '', pack: w === 7 ? 'STDWL7 / WL16' : 'STDWL' + w };
          return w;
        }
      }
    }
  }
  return null;
}

let cards = '';
for (const name of ['MDL 4872', 'MDL 9696', 'MDL 96120']) {
  const std = resolve(name, 'S');
  const a1 = defaultAssign(std);
  cards += `<div class="card"><h3>${name} S — standard door</h3>${renderLayoutSvg(std, a1)}${renderElevationSvg(std, a1, 'S')}</div>`;
  const wa = resolve(name, 'S');
  const a2 = defaultAssign(wa);
  const w = applyWa(wa, a2);
  cards += `<div class="card"><h3>${name} S — WA door (companion ${w}″ → seam shifts ${w != null ? Math.abs(49 - (49 + w) / 2 - 0) : '?'})</h3>${renderLayoutSvg(wa, a2)}${renderElevationSvg(wa, a2, 'S')}</div>`;
}

fs.writeFileSync(path.join(__dirname, 'wapreview.html'),
  `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  body{margin:0;background:#fff;font-family:system-ui}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:10px}
  .card{border:1px solid #e6e6e6;border-radius:10px;padding:8px}
  .card h3{font-size:12px;color:#444;margin:0 0 4px}
  </style></head><body><div class="grid">${cards}</div></body></html>`);
console.log('wrote wapreview.html');
