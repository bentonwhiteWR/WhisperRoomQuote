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

const name = 'MDL 9696 S';
const layout = pl.boothLayout(name);
const DATA = {
  quoteNumber: 'TEST-001', meta: { dealName: 'Acme' },
  rooms: [{ boothName: name, found: true, lines: synth(layout), unmappedFeatures: [], flags: [], boxCount: 0 }],
  layouts: { [name]: layout }, components: {}, totals: { netLb: 0 }, quoteWeight: 0,
};
const scriptInner = fs.readFileSync(path.join(root, 'packing-list.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];

const test = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
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
    const st = LAYOUT_STATE[0];
    const slots = Object.keys(st.assign);
    log.push('assign slots: '+slots.join(','));
    const A = document.querySelector('.ld-panel[data-slot="'+slots[0]+'"]');
    const B = document.querySelector('.ld-panel[data-slot="'+slots[1]+'"]');
    if(!A||!B){ log.push('MISSING panel A/B'); return done(); }
    const ra=A.getBoundingClientRect(), rb=B.getBoundingClientRect();
    log.push('A '+slots[0]+' rect '+Math.round(ra.x)+','+Math.round(ra.y)+' '+Math.round(ra.width)+'x'+Math.round(ra.height));
    log.push('B '+slots[1]+' rect '+Math.round(rb.x)+','+Math.round(rb.y)+' '+Math.round(rb.width)+'x'+Math.round(rb.height));
    // what does elementFromPoint see at A center?
    const ax=ra.x+ra.width/2, ay=ra.y+ra.height/2, bx=rb.x+rb.width/2, by=rb.y+rb.height/2;
    const efpA = document.elementFromPoint(ax,ay);
    log.push('elementFromPoint(A center): '+(efpA?efpA.tagName+'.'+(efpA.getAttribute&&efpA.getAttribute('class')):'null')+' closest .ld-panel: '+(efpA&&efpA.closest&&efpA.closest('.ld-panel')?'YES':'no'));
    const before = st.assign[slots[0]] && st.assign[slots[0]].code;
    const beforeB = st.assign[slots[1]] && st.assign[slots[1]].code;
    P('pointerdown',efpA||A,ax,ay);
    log.push('_ldDrag after down: '+(typeof _ldDrag!=='undefined' && _ldDrag ? JSON.stringify({ri:_ldDrag.ri,from:_ldDrag.from}) : 'null'));
    P('pointermove',document.elementFromPoint(bx,by)||B,bx,by);
    P('pointerup',document.elementFromPoint(bx,by)||B,bx,by);
    const afterA = (LAYOUT_STATE[0].assign[slots[0]]||{}).code;
    const afterB = (LAYOUT_STATE[0].assign[slots[1]]||{}).code;
    log.push('before A='+before+' B='+beforeB+' | after A='+afterA+' B='+afterB+' | SWAPPED='+(before!==afterA));
  }catch(e){ log.push('THROW '+e.message); }
  done();
}
function done(){ document.getElementById('out').textContent = window.__log.join('\\n'); }
go();
</script>
</body></html>`;
fs.writeFileSync(path.join(__dirname, 'dragtest.html'), test);
console.log('wrote dragtest.html');
