// Shared Truckload calculator — used by the Orders page (🚚 Truckload subtab)
// and the Quote Builder (popup modal). Floor-only, rotation-aware shelf
// packing. Theme-adaptive: styles via the host page's CSS vars (with
// fallbacks), so it looks right on both the dark dashboards and the light
// Quote Builder.
//
// Usage:
//   const calc = TruckloadCalc.create({ container, boothData, keysByLen });
//   calc.prefill([{ name, qty }]);   // map line items → rows
//   calc.showBanner('…');            // or null to hide
//
// boothData: the page's BOOTH_DATA map { "<model>": { pallets:[{l,w,h}] } }.
(function(){
  if (window.TruckloadCalc) return;

  // Truck usable interior (inches). Floor-only, so height is informational.
  const TRUCKS = [
    { id:'53',  label:"53' dry van",   len:624, width:98, height:108 }, // 52' usable
    { id:'28',  label:"28' pup",       len:324, width:98, height:108 }, // 27' usable
    { id:'40c', label:"40' container", len:468, width:92, height:94  }, // 39' usable
    { id:'20c', label:"20' container", len:228, width:92, height:94  }, // 19' usable
  ];
  const PALETTE = ['#ee6216','#3b82f6','#10b981','#a855f7','#f59e0b','#ef4444','#14b8a6','#ec4899','#84cc16','#6366f1','#eab308','#06b6d4'];

  const CSS = `
  .tlc *{box-sizing:border-box}
  .tlc-card{background:var(--surface,#1e1e1e);border:1px solid var(--border,#333);border-radius:12px;padding:16px 18px;margin-bottom:16px}
  .tlc-title{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--muted,#8a8a8a);margin:0 0 12px}
  .tlc-trucks{display:flex;flex-wrap:wrap;gap:8px}
  .tlc-truck{padding:9px 14px;background:var(--surface2,#262626);border:1px solid var(--border,#333);border-radius:8px;color:var(--text,#e8e8e8);font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
  .tlc-truck.active{border-color:var(--orange,#ee6216);background:rgba(238,98,22,.12);color:var(--orange,#ee6216)}
  .tlc-row{display:flex;gap:10px;align-items:center;margin-bottom:10px}
  .tlc-row select{flex:1;min-width:0;background:var(--surface2,#262626);border:1px solid var(--border,#333);border-radius:7px;color:var(--text,#e8e8e8);font-size:13px;font-family:inherit;padding:8px 10px;outline:none}
  .tlc-qty{width:74px;background:var(--surface2,#262626);border:1px solid var(--border,#333);border-radius:7px;color:var(--text,#e8e8e8);font-size:13px;font-family:inherit;padding:8px 10px;outline:none}
  .tlc-wa{display:flex;align-items:center;gap:5px;font-size:12px;font-weight:600;color:var(--muted,#8a8a8a);white-space:nowrap;cursor:pointer;user-select:none}
  .tlc-wa input{cursor:pointer;accent-color:var(--orange,#ee6216)}
  .tlc-rm{background:none;border:none;color:var(--muted,#8a8a8a);font-size:18px;cursor:pointer;padding:0 6px;line-height:1}
  .tlc-rm:hover{color:#ef4444}
  .tlc-add{margin-top:4px;padding:8px 14px;background:var(--surface2,#262626);border:1px dashed var(--border,#333);border-radius:8px;color:var(--text,#e8e8e8);font-size:13px;cursor:pointer;font-family:inherit}
  .tlc-add:hover{border-color:var(--orange,#ee6216);color:var(--orange,#ee6216)}
  .tlc-res-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-bottom:16px}
  .tlc-stat{background:var(--surface2,#262626);border:1px solid var(--border,#333);border-radius:10px;padding:14px 16px}
  .tlc-stat .v{font-size:26px;font-weight:800;font-family:var(--mono,ui-monospace,monospace);line-height:1;color:var(--text,#e8e8e8)}
  .tlc-stat .v.big{color:var(--orange,#ee6216)}
  .tlc-stat .l{font-size:11px;color:var(--muted,#8a8a8a);text-transform:uppercase;letter-spacing:.06em;margin-top:6px}
  .tlc-bar-head{display:flex;justify-content:space-between;font-size:12px;color:var(--muted,#8a8a8a);margin-bottom:4px}
  .tlc-empty{color:var(--muted,#8a8a8a);font-style:italic;padding:30px;text-align:center}
  .tlc-banner{background:rgba(238,98,22,.1);border:1px solid rgba(238,98,22,.4);border-radius:8px;padding:9px 13px;font-size:12px;color:var(--orange,#ee6216);margin-bottom:14px}
  .tlc-table{width:100%;border-collapse:collapse;font-size:13px;margin-top:6px}
  .tlc-table th,.tlc-table td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--border,#333);color:var(--text,#e8e8e8)}
  .tlc-table th{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted,#8a8a8a);font-weight:800}
  .tlc-table td.num,.tlc-table th.num{text-align:right;font-family:var(--mono,ui-monospace,monospace)}
  .tlc-note{font-size:11px;color:var(--muted,#8a8a8a);line-height:1.6;margin-top:14px}`;

  function injectCSS(){
    if (document.getElementById('tlc-styles')) return;
    const s = document.createElement('style');
    s.id = 'tlc-styles';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  const fmtFt = i => (i/12).toFixed(1);

  function create(opts){
    injectCSS();
    const BOOTH_DATA = opts.boothData || {};
    const KEYS = opts.keysByLen || Object.keys(BOOTH_DATA).sort((a,b)=>b.length-a.length);
    const MODEL_OPTIONS = Object.keys(BOOTH_DATA).filter(k=>!/(ENV|SNV)$/.test(k));
    const optHtml = MODEL_OPTIONS.map(k=>`<option value="${k}">${k}</option>`).join('');
    const root = opts.container;
    let truckId = '53';
    let rows = [{ model:'', qty:1, wa:false }];

    root.classList.add('tlc');
    root.innerHTML = `
      <div class="tlc-banner" data-banner style="display:none"></div>
      <div class="tlc-card"><div class="tlc-title">Truck</div><div class="tlc-trucks" data-trucks></div></div>
      <div class="tlc-card"><div class="tlc-title">Booths</div><div data-rows></div><button class="tlc-add" data-add type="button">+ Add model</button></div>
      <div class="tlc-card"><div class="tlc-title">Result</div><div data-results><div class="tlc-empty">Add at least one booth to see truckloads.</div></div></div>`;
    const elTrucks  = root.querySelector('[data-trucks]');
    const elRows    = root.querySelector('[data-rows]');
    const elResults = root.querySelector('[data-results]');
    const elBanner  = root.querySelector('[data-banner]');

    function normalizeKey(key){ if(key && /(ENV|SNV)$/.test(key)){ const b=key.slice(0,-2); if(BOOTH_DATA[b]) return b; } return key; }
    function findKey(name){
      if(!name) return null;
      if(BOOTH_DATA[name]) return name;
      const n = String(name).trim().toLowerCase();
      if(!n) return null;
      for(const k of KEYS){ const kk=k.toLowerCase();
        if(n===kk) return k;
        if(n.startsWith(kk)){ const nx=n.charAt(kk.length); if(nx===''||/[\s\-—,(/]/.test(nx)) return k; }
      }
      return null;
    }
    function activeTruck(){ return TRUCKS.find(t=>t.id===truckId) || TRUCKS[0]; }

    function packLayout(palletList, truck){
      const items = palletList.map(p=>{
        const L=Math.max(p.l,p.w), W=Math.min(p.l,p.w);
        let len=L, wid=W, rotated=false;
        if(L<=truck.width && W>truck.width/2){ len=W; wid=L; rotated=true; }
        return { len, wid, rotated, l:p.l, w:p.w, h:p.h, model:p.model };
      });
      items.sort((a,b)=>b.len-a.len || b.wid-a.wid);
      const shelves=[];
      for(const it of items){
        let placed=false;
        for(const sh of shelves){
          if(sh.widthUsed+it.wid<=truck.width){ it.y=sh.widthUsed; sh.widthUsed+=it.wid; sh.len=Math.max(sh.len,it.len); sh.items.push(it); placed=true; break; }
        }
        if(!placed){ it.y=0; shelves.push({ len:it.len, widthUsed:it.wid, items:[it] }); }
      }
      shelves.sort((a,b)=>b.len-a.len);
      const bins=[];
      for(const sh of shelves){
        let placed=false;
        for(const b of bins){ if(b.used+sh.len<=truck.len){ sh.x=b.used; b.used+=sh.len; b.shelves.push(sh); placed=true; break; } }
        if(!placed){ sh.x=0; bins.push({ used:sh.len, shelves:[sh] }); }
      }
      return bins;
    }

    function palletCell(px,py,pw,ph,it,color){
      const L=Math.max(it.l,it.w), W=Math.min(it.l,it.w);
      const label = `${L}×${W}${it.rotated?' ⟳':''}`;
      const show = pw>26 && ph>14;
      const fs = Math.max(8, Math.min(13, ph*0.30, pw*0.16));
      return `<g>
        <rect x="${(px+1).toFixed(1)}" y="${(py+1).toFixed(1)}" width="${Math.max(0,pw-2).toFixed(1)}" height="${Math.max(0,ph-2).toFixed(1)}" rx="3" fill="${color}" fill-opacity="0.85" stroke="#0d0d0d" stroke-width="1"><title>${(it.model||'').replace(/"/g,'')} — ${L}×${W}×${it.h||'?'} in${it.rotated?' (rotated 90°)':''}</title></rect>
        ${show?`<text x="${(px+pw/2).toFixed(1)}" y="${(py+ph/2).toFixed(1)}" font-size="${fs.toFixed(1)}" fill="#0d0d0d" font-weight="700" text-anchor="middle" dominant-baseline="central" font-family="ui-monospace,monospace">${label}</text>`:''}
      </g>`;
    }

    function drawTruck(bin, truck, colorOf, idx){
      const PX=900, scale=PX/truck.len, W=truck.len*scale, H=truck.width*scale;
      const pct=Math.min(100,(bin.used/truck.len)*100);
      let cells='';
      for(const sh of bin.shelves){ const x=sh.x*scale; for(const it of sh.items){ cells+=palletCell(x, it.y*scale, it.len*scale, it.wid*scale, it, colorOf(it.model)); } }
      return `<div style="margin:6px 0 16px">
        <div class="tlc-bar-head"><span><b>Truck ${idx+1}</b></span><span>${fmtFt(bin.used)} / ${fmtFt(truck.len)} ft &middot; ${pct.toFixed(0)}% full</span></div>
        <svg viewBox="0 0 ${W.toFixed(1)} ${H.toFixed(1)}" width="100%" style="max-width:${W.toFixed(0)}px;height:auto;background:#141414;border:1px solid var(--border,#333);border-radius:6px;display:block">
          <rect x="0.5" y="0.5" width="${(W-1).toFixed(1)}" height="${(H-1).toFixed(1)}" fill="none" stroke="#555" stroke-width="1"/>
          ${cells}
        </svg>
        <div style="font-size:10px;color:var(--muted,#8a8a8a);margin-top:3px;display:flex;justify-content:space-between">
          <span>◄ nose</span><span>${fmtFt(truck.len)} ft × ${truck.width}" — top-down, to scale (⟳ = rotated 90°)</span><span>doors ►</span>
        </div>
      </div>`;
    }

    function palletsForRows(){
      const list=[], breakdown=[];
      for(const r of rows){
        const bd=BOOTH_DATA[r.model]; const qty=parseInt(r.qty)||0;
        if(!bd || qty<=0) continue;
        let pals = bd.pallets.map(p=>({l:p.l,w:p.w,h:p.h}));
        if(r.wa){ const idx=pals.findIndex(p=>p.w===47); if(idx>=0) pals[idx]={...pals[idx],w:52}; }
        for(let q=0;q<qty;q++) for(const p of pals) list.push({l:p.l,w:p.w,h:p.h,model:r.model});
        breakdown.push({ model:r.model, qty, palletsEach:pals.length, total:pals.length*qty, wa:!!r.wa });
      }
      return { list, breakdown };
    }

    function renderTrucks(){
      elTrucks.innerHTML = TRUCKS.map(t=>`<button type="button" class="tlc-truck${t.id===truckId?' active':''}" data-truck="${t.id}">${t.label}</button>`).join('');
    }
    function renderRows(){
      elRows.innerHTML = rows.map((r,i)=>`<div class="tlc-row" data-i="${i}">
        <select data-f="model"><option value="">— Select model —</option>${optHtml}</select>
        <input class="tlc-qty" type="number" min="1" value="${r.qty}" data-f="qty">
        <label class="tlc-wa" title="Wide Access — swaps one 47&quot; pallet for a 52&quot; pallet"><input type="checkbox" data-f="wa" ${r.wa?'checked':''}> WA</label>
        <button type="button" class="tlc-rm" data-f="rm" title="Remove">&times;</button>
      </div>`).join('');
      elRows.querySelectorAll('.tlc-row').forEach(rowEl=>{ const i=+rowEl.dataset.i; rowEl.querySelector('select').value = rows[i].model || ''; });
    }
    function recompute(){
      const truck = activeTruck();
      const { list, breakdown } = palletsForRows();
      if(!list.length || !truck.len){ elResults.innerHTML='<div class="tlc-empty">Add at least one booth to see truckloads.</div>'; return; }
      const colorMap={}; breakdown.forEach((b,i)=>{ colorMap[b.model]=PALETTE[i%PALETTE.length]; });
      const colorOf=m=>colorMap[m]||'#888';
      const bins=packLayout(list,truck);
      const trucks=bins.length;
      const linearTotal=bins.reduce((s,b)=>s+b.used,0);
      const capacity=trucks*truck.len;
      const util=capacity>0?(linearTotal/capacity)*100:0;
      const oversize=bins.some(b=>b.shelves.some(s=>s.len>truck.len));
      const diagrams=bins.map((b,i)=>drawTruck(b,truck,colorOf,i)).join('');
      const legend=breakdown.map(b=>`<span style="display:inline-flex;align-items:center;gap:6px;margin:0 14px 6px 0;font-size:12px"><span style="width:12px;height:12px;border-radius:3px;background:${colorOf(b.model)};display:inline-block;flex-shrink:0"></span>${b.model}${b.wa?' <span style="color:var(--orange,#ee6216);font-weight:700">WA</span>':''}</span>`).join('');
      const totalPallets=list.length;
      const rowsHtml=breakdown.map(b=>`<tr><td>${b.model}${b.wa?' <span style="color:var(--orange,#ee6216);font-size:10px;font-weight:700">WA</span>':''}</td><td class="num">${b.qty}</td><td class="num">${b.palletsEach}</td><td class="num">${b.total}</td></tr>`).join('');
      elResults.innerHTML = `
        <div class="tlc-res-grid">
          <div class="tlc-stat"><div class="v big">${trucks}</div><div class="l">${truck.label}${trucks===1?'':'s'} needed</div></div>
          <div class="tlc-stat"><div class="v">${totalPallets}</div><div class="l">Pallets</div></div>
          <div class="tlc-stat"><div class="v">${fmtFt(linearTotal)}<span style="font-size:14px;color:var(--muted,#8a8a8a)"> ft</span></div><div class="l">Linear feet used</div></div>
          <div class="tlc-stat"><div class="v">${util.toFixed(0)}<span style="font-size:14px;color:var(--muted,#8a8a8a)">%</span></div><div class="l">Avg fill across trucks</div></div>
        </div>
        ${oversize?'<div class="tlc-banner">⚠ A pallet is longer than the selected truck — check the truck.</div>':''}
        <div style="margin:4px 0 12px">${legend}</div>
        ${diagrams}
        <table class="tlc-table">
          <thead><tr><th>Model</th><th class="num">Qty</th><th class="num">Pallets ea.</th><th class="num">Total pallets</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        <div class="tlc-note">
          <b>How this is figured:</b> ${truck.label} usable floor ≈ ${fmtFt(truck.len)} ft long × ${truck.width}" wide.
          Pallets sit side-by-side across the width and may be <b>rotated 90°</b> (⟳) when the long side fits the ${truck.width}" width and turning saves length.
          Floor space only — <b>no stacking</b>. A pallet can't be split across two trucks, so the count rounds up at the pallet, not the foot.
          <b>WA</b> swaps one 47" pallet for a 52" pallet. A to-scale estimate of one good arrangement; real loadout depends on how the driver builds it.
        </div>`;
    }

    // Delegated events.
    elTrucks.addEventListener('click', e=>{ const b=e.target.closest('[data-truck]'); if(!b) return; truckId=b.dataset.truck; renderTrucks(); recompute(); });
    root.querySelector('[data-add]').addEventListener('click', ()=>{ rows.push({model:'',qty:1,wa:false}); renderRows(); recompute(); });
    elRows.addEventListener('change', e=>{ const rowEl=e.target.closest('.tlc-row'); if(!rowEl) return; const i=+rowEl.dataset.i; const f=e.target.dataset.f; if(f==='model'){ rows[i].model=e.target.value; recompute(); } else if(f==='wa'){ rows[i].wa=e.target.checked; recompute(); } });
    elRows.addEventListener('input', e=>{ const rowEl=e.target.closest('.tlc-row'); if(!rowEl) return; const i=+rowEl.dataset.i; if(e.target.dataset.f==='qty'){ rows[i].qty=e.target.value; recompute(); } });
    elRows.addEventListener('click', e=>{ const rm=e.target.closest('[data-f="rm"]'); if(!rm) return; const i=+rm.closest('.tlc-row').dataset.i; rows.splice(i,1); if(!rows.length) rows=[{model:'',qty:1,wa:false}]; renderRows(); recompute(); });

    renderTrucks(); renderRows(); recompute();

    return {
      prefill(items){
        const counts={};
        for(const it of (items||[])){ const key=normalizeKey(findKey(it.name||it.productName)); if(!key) continue; counts[key]=(counts[key]||0)+(parseInt(it.qty)||1); }
        const nr=Object.entries(counts).map(([m,q])=>({model:m,qty:q,wa:false}));
        rows = nr.length ? nr : [{model:'',qty:1,wa:false}];
        renderRows(); recompute();
      },
      showBanner(msg){ if(msg){ elBanner.style.display='block'; elBanner.textContent=msg; } else { elBanner.style.display='none'; } },
      reset(){ rows=[{model:'',qty:1,wa:false}]; renderRows(); recompute(); },
    };
  }

  window.TruckloadCalc = { create, TRUCKS };
})();
