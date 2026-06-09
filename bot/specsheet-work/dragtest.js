// Build dragtest.html: real page script + mock DATA, then SIMULATE a pointer
// drag (down on panel A → move to panel B → up) and report whether the swap
// happened. Reveals why drag isn't working in the live page.
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
    else if (kind === 'DRFRM') { pack = 'STDWL' + sz + ' DRFRM R'; code = 'D' + (++n); }
    else { pack = 'STDWL' + sz; code = 'C' + String(++n).padStart(2, '0'); }
    lines.push({ code, pack, desc: pack, L: sz, W: 2, T: 80, eachLb: 40, known: true });
  }
  return lines;
}

const name = 'MDL 4872 S';   // has 46" + 24" slots → can test the size constraint
const layout = pl.boothLayout(name);
const DATA = {
  quoteNumber: 'TEST-001', meta: { dealName: 'Acme' },
  rooms: [{ boothName: name, found: true, lines: synth(layout), unmappedFeatures: [], flags: [], boxCount: 0 }],
  layouts: { [name]: layout }, components: {}, totals: { netLb: 0 }, quoteWeight: 0,
};
const pageHtml = fs.readFileSync(path.join(root, 'packing-list.html'), 'utf8');
const scriptInner = pageHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
const styleInner = pageHtml.match(/<style>([\s\S]*?)<\/style>/)[1];   // include the page CSS (pointer-events rules!)

const test = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${styleInner}</style></head><body>
<div id="out" style="position:fixed;top:0;left:0;right:0;background:#111;color:#0f0;font:14px monospace;padding:8px;z-index:9999;white-space:pre-wrap"></div>
<span id="snStatus"></span><div id="rooms"></div>
<script>window.__log=[]; window.onerror=function(m,s,l,c){window.__log.push('ERR '+m+' @'+l+':'+c);};</script>
<script>${scriptInner}</script>
<script>
function P(t,el,x,y){ el.dispatchEvent(new PointerEvent(t,{bubbles:true,cancelable:true,clientX:x,clientY:y,pointerId:1,pointerType:'mouse'})); }
function go(){
  const log = window.__log;
  try{
    DATA = ${JSON.stringify(DATA)}; COMPONENTS = DATA.components; serialLines=[''];
    render();
    document.querySelectorAll('.tab-panel[data-tab=layout]').forEach(p=>p.classList.add('active'));
    log.push('panels in DOM: '+document.querySelectorAll('.ld-panel').length);
    log.push('sizes: N0='+ldSlotSize(0,'N0')+' N1='+ldSlotSize(0,'N1')+' S0='+ldSlotSize(0,'S0'));
    log.push('compat N0<->N1 (46 vs 24): '+ldCompatible(0,'N0','N1')+'   N0<->S0 (46 vs 46): '+ldCompatible(0,'N0','S0'));
    function center(slot){ const el=document.querySelector('.ld-panel[data-slot="'+slot+'"]'); const r=el.getBoundingClientRect(); return {x:r.x+r.width/2, y:r.y+r.height/2}; }
    function slotAt(p){ const e=document.elementFromPoint(p.x,p.y); const pn=e&&e.closest&&e.closest('.ld-panel'); return pn?pn.getAttribute('data-slot'):(e?e.tagName:'null'); }
    function drag(a,b){
      const pa=center(a), pb=center(b);
      const before=(LAYOUT_STATE[0].assign[a]||{}).code;
      log.push('   pa='+Math.round(pa.x)+','+Math.round(pa.y)+' ->'+slotAt(pa)+'  pb='+Math.round(pb.x)+','+Math.round(pb.y)+' ->'+slotAt(pb));
      P('pointerdown',document.elementFromPoint(pa.x,pa.y),pa.x,pa.y);
      P('pointermove',document.elementFromPoint(pb.x,pb.y),pb.x,pb.y);
      P('pointerup',document.elementFromPoint(pb.x,pb.y),pb.x,pb.y);
      const after=(LAYOUT_STATE[0].assign[a]||{}).code;
      return before!==after;
    }
    log.push('drag N0->N1 (incompatible) SWAPPED='+drag('N0','N1')+'  (expect false)');
    log.push('drag N0->S0 (compatible)   SWAPPED='+drag('N0','S0')+'  (expect true)');
  }catch(e){ log.push('THROW '+e.message); }
  done();
}
function done(){ document.getElementById('out').textContent = window.__log.join('\\n'); }
go();
</script>
</body></html>`;
fs.writeFileSync(path.join(__dirname, 'dragtest.html'), test);
console.log('wrote dragtest.html');
