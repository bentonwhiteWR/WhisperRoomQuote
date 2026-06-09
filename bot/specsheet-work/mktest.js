// Build an integration test page: the REAL packing-list.html inline script,
// driven with mock DATA (no server), with an error trap + a programmatic
// drag-swap, so headless Chrome exercises render()→renderLayoutTab()→
// renderLayoutSvg() and the drag code exactly as the browser would.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const pl = require(path.join(root, 'lib', 'packing-list.js'));
if (pl.init) pl.init();

function synth(layout) {
  const lines = []; let n = 0;
  for (const side of ['N', 'S', 'E', 'W']) for (const slot of layout.walls[side].slots) {
    const sz = Math.round(slot.size);
    const k = (slot.prefers && slot.prefers[0]) || 'SOLID';
    const kind = (k === 'VNT' && layout.hasVent === false) ? 'SOLID' : k;
    let pack, code;
    if (kind === 'VNT') { pack = 'STDWL' + sz + ' VNT'; code = 'V' + (++n); }
    else if (kind === 'DRFRM') { pack = 'STDWL' + sz + ' DRFRM R'; code = 'C113'; }
    else { pack = 'STDWL' + sz; code = 'C' + String(++n).padStart(2, '0'); }
    lines.push({ code, pack, desc: pack, L: sz, W: 2, T: 80, eachLb: 40, known: true });
  }
  return lines;
}

const name = process.argv[2] || 'MDL 9696 S';
const layout = pl.boothLayout(name);
const DATA = {
  quoteNumber: 'TEST-001',
  meta: { dealName: 'Acme Studios', company: 'Acme Studios' },
  rooms: [{ boothName: name, found: true, lines: synth(layout), unmappedFeatures: [], flags: [], boxCount: 0 }],
  layouts: { [name]: layout },
  components: {}, totals: { netLb: 0 }, quoteWeight: 0,
};

const html = fs.readFileSync(path.join(root, 'packing-list.html'), 'utf8');
const scriptInner = html.match(/<script>([\s\S]*?)<\/script>/)[1];

const test = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  body{font-family:'Segoe UI',sans-serif;background:#f8f8f8;padding:20px}
  #err{position:fixed;top:0;left:0;right:0;background:#b91c1c;color:#fff;padding:6px;font:13px monospace;z-index:9999;display:none}
</style></head><body>
<div id="err"></div>
<span id="snStatus"></span>
<div id="rooms"></div>
<script>
  window.onerror = function(m,s,l,c){ var e=document.getElementById('err'); e.style.display='block'; e.textContent='JS ERROR: '+m+' @'+l+':'+c; return false; };
</script>
<script>${scriptInner}</script>
<script>
  try {
    DATA = ${JSON.stringify(DATA)};
    COMPONENTS = DATA.components; serialLines = [''];
    render();
    // show the layout tab
    document.querySelectorAll('.tab-panel[data-tab=layout]').forEach(p=>p.classList.add('active'));
    document.querySelectorAll('.tab-panel[data-tab=pl]').forEach(p=>p.classList.remove('active'));
    document.querySelectorAll('.pl-tab[data-tab=layout]').forEach(b=>b.classList.add('active'));
    document.querySelectorAll('.pl-tab[data-tab=pl]').forEach(b=>b.classList.remove('active'));
    // exercise the drag-swap code path (swap two N panels) — must not throw
    if (typeof ldSwap === 'function') {
      var slots = Object.keys(LAYOUT_STATE[0].assign);
      window.__swapOK = false;
      ldSwap(0, slots[0], slots[1]);
      window.__swapOK = true;
    }
  } catch(e) {
    var el=document.getElementById('err'); el.style.display='block'; el.textContent='THROW: '+e.message;
  }
</script>
</body></html>`;

fs.writeFileSync(path.join(__dirname, 'test.html'), test);
console.log('wrote test.html for', name, '(', DATA.rooms[0].lines.length, 'lines )');
