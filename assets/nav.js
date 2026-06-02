// Shared top navigation — single source of truth for the dashboard navbar.
// Included by the internal dashboards via <script src="/assets/nav.js" defer>.
// Renders the standard links into the page's `.topbar-nav` container and
// highlights the active page by path. Replaces the navbar that used to be
// copy-pasted into every dashboard, so future nav tweaks are a one-file change.
// (v1.59.0) "Suppliers" (Audimute POs) folded under Vendor Hub as a subtab.
(function(){
  var LINKS = [
    { href:'/deals',      label:'⬡ Deal Hub' },
    { href:'/quotes',     label:'Quotes' },
    { href:'/orders',     label:'Orders' },
    { href:'/shipping',   label:'Shipping' },
    { href:'/reports',    label:'Reports' },
    { href:'/accounting', label:'Accounting' },
    // Vendor Hub now also covers the Audimute (Suppliers) POs, shown as a
    // subtab on that page — so it stays highlighted on /suppliers too.
    { href:'/vendor-pos', label:'Vendor Hub', match:['/vendor-pos','/suppliers'] },
    { href:'/marketing',  label:'Marketing', id:'marketingNavLink' },
  ];

  function render(){
    var nav = document.querySelector('.topbar-nav');
    if(!nav) return;
    // Drop any hard-coded nav links (the old per-page copies) so we don't
    // double up; leave non-link children (e.g. the #appVersion badge) alone.
    var old = nav.querySelectorAll('a.nav-link');
    for(var i = 0; i < old.length; i++) old[i].remove();

    var path = (location.pathname.replace(/\/+$/,'') || '/').toLowerCase();
    var frag = document.createDocumentFragment();
    LINKS.forEach(function(l){
      var a = document.createElement('a');
      a.href = l.href;
      a.className = 'nav-link';
      a.textContent = l.label;
      if(l.id) a.id = l.id;
      var ms = (l.match || [l.href]).map(function(m){ return m.toLowerCase(); });
      if(ms.indexOf(path) !== -1) a.className += ' active';
      frag.appendChild(a);
    });
    nav.insertBefore(frag, nav.firstChild);
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();
})();
