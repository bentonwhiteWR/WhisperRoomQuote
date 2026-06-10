// Visual harness for the v1.91 renderer features: Enhanced double wall,
// VSS extra ducts, EFS 10″ silencer + "w/ EFS" dims, roof-mounted vent,
// full-thickness window glass. Writes optspreview.html for headless Chrome.
// Usage: node bot/specsheet-work/optspreview.js
const fs = require('fs');
const path = require('path');
const { renderLayoutSvg, renderElevationSvg } = require('../../assets/layout-render.js');

const BL = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'pl-data', 'booth-layouts.json'), 'utf8')).layouts;

function resolve(name, variant, opts) {
  const base = BL[name];
  const v = base.variants[variant] || base.variants.S;
  return Object.assign({}, base, v, { variant, foamColor: 'Gray' }, opts || {});
}
const eachSlot = (l, fn) => ['N', 'S', 'E', 'W'].forEach(sd => (l.walls[sd] || { slots: [] }).slots.forEach(sl => fn(sl, sd)));
function defaultAssign(layout, roof) {
  const a = {};
  eachSlot(layout, slot => {
    const k = slot.kind || (slot.prefers && slot.prefers[0]) || 'SOLID';
    const real = [16, 22, 28, 40, 43, 46].reduce((b, w) => Math.abs(w - slot.size) < Math.abs(b - slot.size) ? w : b, 16);
    let pack = k === 'VNT' ? `STDWL${real} VNT` : k === 'DRFRM' ? `STDWL${real} DRFRM R` : `STDWL${real}`;
    if (roof && k === 'VNT') pack = `STDWL${real} CBL`;
    a[slot.id] = { code: '', pack };
  });
  return a;
}
function withWindow(layout, a) {
  // put a window on the first ≥36″ solid E/W slot
  let done = false;
  eachSlot(layout, (slot, side) => {
    if (done || slot.size < 36 || (side !== 'E' && side !== 'W')) return;
    if (!/^STDWL\d+$/.test(a[slot.id].pack)) return;
    a[slot.id] = { code: '', pack: a[slot.id].pack + ' WDO3236' };
    done = true;
  });
  return a;
}

const CASES = [
  ['MDL 4872 S — baseline', resolve('MDL 4872', 'S')],
  ['MDL 4872 E — ENHANCED double wall', resolve('MDL 4872', 'E')],
  ['MDL 4872 S — VSS (4 ducts + hoses)', resolve('MDL 4872', 'S', { vss: true })],
  ['MDL 4872 S — EFS (10″ box + w/ EFS dim)', resolve('MDL 4872', 'S', { efs: true })],
  ['MDL 4872 S — VSS + EFS', resolve('MDL 4872', 'S', { vss: true, efs: true })],
  ['MDL 4872 S — ROOF VENT', resolve('MDL 4872', 'S', { roofVent: true })],
  ['MDL 9696 E — Enhanced + window', resolve('MDL 9696', 'E')],
];

let cards = '';
for (const [title, layout] of CASES) {
  const roof = !!layout.roofVent;
  let a = defaultAssign(layout, roof);
  if (/window/i.test(title)) a = withWindow(layout, a);
  cards += `<div class="card"><h3>${title}</h3>${renderLayoutSvg(layout, a)}${renderElevationSvg(layout, a, 'N')}</div>`;
}

fs.writeFileSync(path.join(__dirname, 'optspreview.html'),
  `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  body{margin:0;background:#fff;font-family:system-ui}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:10px}
  .card{border:1px solid #e6e6e6;border-radius:10px;padding:8px}
  .card h3{font-size:12px;color:#444;margin:0 0 4px}
  </style></head><body><div class="grid">${cards}</div></body></html>`);
console.log('wrote optspreview.html with', CASES.length, 'cases');
