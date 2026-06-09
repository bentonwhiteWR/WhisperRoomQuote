const fs = require('fs');
const path = require('path');
const { renderLayoutSvg, placeBom } = require('./layout-render.js');

const BL = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'pl-data', 'booth-layouts.json'), 'utf8')).layouts;

// Resolve a "MDL <size> <variant>" name into a render-ready layout (mirrors
// boothLayout() in lib/packing-list.js).
function resolve(name) {
  const m = name.match(/^(MDL\s+.+?)(?:\s+(S|E|SNV|ENV))?$/i);
  const base = BL[m[1]]; if (!base) return null;
  const variant = (m[2] || 'S').toUpperCase();
  const vKey = (variant === 'E' || variant === 'ENV') ? 'E' : 'S';
  const v = base.variants[vKey];
  return Object.assign({}, base, {
    variant, variantKey: vKey,
    hasVent: variant !== 'SNV' && variant !== 'ENV',
    wallThickness: v.wallThickness, interior: v.interior,
  });
}

// Synthesize a BOM (one wall line per slot, matching its kind) so placeBom
// reproduces the spec layout — stand-in for a real quote's resolved PL lines.
let codeN = 0;
function synthLines(layout) {
  const lines = [];
  for (const side of ['N', 'S', 'E', 'W']) {
    for (const slot of layout.walls[side].slots) {
      const sz = Math.round(slot.size);
      const k = (slot.prefers && slot.prefers[0]) || 'SOLID';
      // SNV/ENV: no vent packs exist → emit a solid instead.
      const kind = (k === 'VNT' && layout.hasVent === false) ? 'SOLID' : k;
      let pack, code;
      if (kind === 'VNT')      { pack = `STDWL${sz} VNT`;  code = 'C0' + (++codeN); }
      else if (kind === 'DRFRM'){ pack = `STDWL${sz} DRFRM R`; code = 'C113'; }
      else if (kind === 'WDO') { pack = `STDWL${sz} WDO`;  code = 'C104'; }
      else                     { pack = `STDWL${sz}`;      code = 'C' + String(++codeN).padStart(2, '0'); }
      lines.push({ code, pack, L: sz, W: 2, T: 80, eachLb: 40, desc: pack });
    }
  }
  return lines;
}

const SHOW = process.argv.slice(2);
const booths = SHOW.length ? SHOW : [
  'MDL 4242 S', 'MDL 4872 S', 'MDL 4872 E', 'MDL 9696 S',
  'MDL 102186 S', 'MDL 6084 S', 'MDL 96168 S', 'MDL 8484 S',
];

let cards = '';
for (const name of booths) {
  const layout = resolve(name);
  if (!layout) { cards += `<div class="card"><h3>${name} — NOT FOUND</h3></div>`; continue; }
  const { placement } = placeBom(layout, synthLines(layout));
  cards += `<div class="card"><h3>${name} · ${layout.label}</h3>${renderLayoutSvg(layout, placement)}</div>`;
}

const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  body{margin:0;background:#fff;font-family:'Segoe UI',system-ui,sans-serif}
  .grid{display:grid;grid-template-columns:${booths.length<=3?'1fr':'1fr 1fr'};gap:8px;padding:10px}
  .card{border:1px solid #e6e6e6;border-radius:10px;padding:8px;background:#fff}
  .card h3{font-size:12px;color:#444;margin:0 0 4px;font-weight:700}
</style></head><body><div class="grid">${cards}</div></body></html>`;

fs.writeFileSync(path.join(__dirname, 'preview.html'), html);
console.log('wrote preview.html with', booths.length, 'booths');
