// Verify side-aware vent/door: place a door on E and a vent on W (as a drag
// would) and render, to confirm the swing/ducts re-orient to those walls.
const fs = require('fs'); const path = require('path');
const { renderLayoutSvg, placeBom } = require('./layout-render.js');
const pl = require(path.join(__dirname,'..','..','lib','packing-list.js')); if(pl.init)pl.init();
function synth(L){const a=[];let n=0;for(const s of['N','S','E','W'])for(const sl of L.walls[s].slots){const sz=Math.round(sl.size);const k=(sl.prefers&&sl.prefers[0])||'SOLID';const kind=(k==='VNT'&&L.hasVent===false)?'SOLID':k;let p,c;if(kind==='VNT'){p='STDWL'+sz+' VNT';c='V'+(++n);}else if(kind==='DRFRM'){p='STDWL'+sz+' DRFRM R';c='D'+(++n);}else{p='STDWL'+sz;c='C'+(++n);}a.push({code:c,pack:p,desc:p,L:sz,W:2,T:80,eachLb:40});}return a;}
const L = pl.boothLayout('MDL 9696 S');
const {placement} = placeBom(L, synth(L));
// swap door (S0) onto E0, and a vent (N0) onto W0 — mimic drag
function swap(a,b){const t=placement[a]||null;placement[a]=placement[b]||null;placement[b]=t;if(!placement[a])delete placement[a];if(!placement[b])delete placement[b];}
swap('S0','E0');
swap('N0','W0');
const html=`<!DOCTYPE html><html><head><meta charset=utf8><style>body{margin:0;background:#fff}.c{padding:14px}</style></head><body><div class=c>${renderLayoutSvg(L,placement)}</div></body></html>`;
fs.writeFileSync(path.join(__dirname,'rottest.html'),html);
console.log('wrote rottest.html (door→E, vent→W)');
