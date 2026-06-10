// Node-only logic test for booth-builder.html: runs the REAL page script
// (plus the shared renderer) in a vm with a stub DOM + mock fetch, then
// exercises boot, the #d= hash round-trip, drag-swap survival, and the
// quote-request submit flow. Usage: node bot/specsheet-work/bbtest.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', '..');
const layouts = JSON.parse(fs.readFileSync(path.join(root, 'lib', 'pl-data', 'booth-layouts.json'), 'utf8')).layouts;
const html = fs.readFileSync(path.join(root, 'booth-builder.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'assets', 'layout-render.js'), 'utf8');
// inline scripts only (the src= tags don't match — renderer is loaded above)
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);

const els = {};
const el = () => ({
  innerHTML: '', value: '', href: '', textContent: '', style: {},
  classList: { add() {}, remove() {}, toggle() {} },
  appendChild() {}, remove() {}, setAttribute() {}, getAttribute() { return null; },
});
const fetchCalls = [];
const sandbox = {
  window: { BB_AUTHED: 0 },
  document: {
    querySelector: () => el(), querySelectorAll: () => [],
    getElementById: id => els[id] || (els[id] = el()),
    createElement: () => el(), addEventListener() {},
    head: { appendChild() {} },
    body: { appendChild() {}, classList: { add() {}, remove() {} } },
    readyState: 'complete',
  },
  history: { replaceState: (a, b, url) => { sandbox.location.hash = url; } },
  location: { hash: '', origin: 'https://test.local' },
  navigator: {},
  fetch: async (url, opts) => {
    fetchCalls.push({ url, opts });
    if (url === '/api/booth-layouts') return { ok: true, json: async () => ({ layouts }) };
    if (url === '/api/booth-request') return { ok: true, json: async () => ({ success: true }) };
    return { ok: false, json: async () => ({ error: 'nope' }) };
  },
  setTimeout: () => 0, clearTimeout() {},
  btoa: s => Buffer.from(s, 'binary').toString('base64'),
  atob: s => Buffer.from(s, 'base64').toString('binary'),
  escape: global.escape, unescape: global.unescape,
  console,
};
vm.createContext(sandbox);
vm.runInContext(renderer, sandbox);
for (const s of scripts) vm.runInContext(s, sandbox);
// expose the page's lexical bindings to the test
vm.runInContext(`__h = { state, designPayload, designToHash, restoreFromHash,
  resolveLayout, doSwap, setModel, setWindow, setC, submitRequest, quoteCardHtml,
  compatible, eachSlot }`, sandbox);
const H = sandbox.__h;

let pass = 0, fail = 0;
const t = (name, ok) => { console.log((ok ? '  ✓ ' : '  ✗ ') + name); ok ? pass++ : fail++; };

(async () => {
  // boot() is an async IIFE — let it settle
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));

  t('boots: layouts loaded + default model assigned',
    !!layouts[H.state.model] && Object.keys(H.state.assign).length > 0);
  t('render published a #d= hash', /^#d=[A-Za-z0-9_-]+$/.test(sandbox.location.hash));

  // ── hash round-trip ──
  const h1 = H.designToHash();
  const assign1 = JSON.stringify(H.designPayload().a);
  H.setModel('MDL 4242');
  for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r));
  t('model switch changes the hash', H.designToHash() !== h1);
  sandbox.location.hash = '#d=' + h1;
  t('restoreFromHash accepts the old link', H.restoreFromHash() === true);
  t('restore reproduces model + arrangement exactly',
    H.designToHash() === h1 && JSON.stringify(H.designPayload().a) === assign1);

  // ── drag survives the round-trip ──
  const layout = H.resolveLayout();
  let from = null, to = null;
  H.eachSlot(layout, slot => {
    if (from && to) return;
    if (!from && H.state.assign[slot.id] && /DRFRM/.test(H.state.assign[slot.id].pack)) { from = slot.id; return; }
  });
  H.eachSlot(layout, slot => {
    if (!from || to) return;
    if (slot.id !== from && H.compatible(layout, from, slot.id)) to = slot.id;
  });
  if (from && to) {
    H.doSwap(layout, from, to);
    const h2 = H.designToHash();
    const moved = JSON.stringify(H.designPayload().a);
    sandbox.location.hash = '#d=' + h2;
    H.restoreFromHash();
    t('dragged door round-trips through the link (' + from + '→' + to + ')',
      JSON.stringify(H.designPayload().a) === moved);
  } else t('dragged door round-trips through the link', false);

  // ── window option encodes ──
  H.setWindow(36);
  for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r));
  const withWdo = H.designPayload();
  const wdoSlot = Object.keys(withWdo.a).find(k => /WDO/.test(withWdo.a[k]));
  t('window option lands in the payload', withWdo.w === 36 && !!wdoSlot);
  sandbox.location.hash = '#d=' + H.designToHash();
  H.restoreFromHash();
  t('window survives restore on its slot', /WDO/.test(H.designPayload().a[wdoSlot] || ''));

  // ── quote request flow ──
  t('quote card renders the form', /Request my quote/.test(H.quoteCardHtml()));
  H.setC('name', 'Test Customer');
  H.setC('email', 'not-an-email');
  await H.submitRequest();
  t('bad email blocked client-side', !fetchCalls.some(c => c.url === '/api/booth-request'));
  H.setC('email', 'test@example.com');
  H.setC('company', 'Acme');
  await H.submitRequest();
  const req = fetchCalls.find(c => c.url === '/api/booth-request');
  const body = req ? JSON.parse(req.opts.body) : null;
  t('valid submit POSTs /api/booth-request', !!req);
  t('payload carries design + summary + honeypot field',
    !!body && body.design && body.design.m === H.state.model
    && Array.isArray(body.summary) && body.summary.length > 0 && 'website' in body);
  t('success flips to the thanks card',
    H.state.requested === true && /Request sent/.test(H.quoteCardHtml()));

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR:', e); process.exit(1); });
