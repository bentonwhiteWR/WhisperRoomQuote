// Shared notification bell + dropdown for all internal dashboards.
//
// Usage: drop <div id="notifBellMount"></div> into a page topbar where
// you want the bell to appear, then include this script once:
//   <script src="/assets/notif-bell.js" defer></script>
//
// Server contract:
//   GET  /api/notifications              → { notifications: [...unread, latest 50] }
//   GET  /api/notifications/history      → { notifications: [...read=true, latest 200] }
//   POST /api/notifications/:id/confirm  → { success: true }   (sets read=true)
//   POST /api/notifications/read-all     → { success: true }   (confirms all unread)
//
// Behavior:
//   - 60s poll for new unread notifications
//   - Badge pulses green when unread > 0
//   - Each card has a "✓ Confirm" button (sole way to clear it from the
//     active list) and, if quote_num is set, an "Open →" link that does
//     NOT auto-confirm — the rep can revisit before acknowledging
//   - "View history →" toggle swaps the active list for read=true
//     notifications (most recent 200), no Confirm buttons

(function() {
  if (window._wrNotifBellInit) return;
  window._wrNotifBellInit = true;

  // ── Style injection (idempotent — only the first script invocation
  // adds the <style> tag). Scoped via the `wr-notif-` prefix so it
  // doesn't collide with any per-page CSS.
  const styleId = 'wr-notif-bell-styles';
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
.wr-notif-wrap { position:relative; display:inline-flex; align-items:center; flex-shrink:0; }
.wr-notif-bell-btn { position:relative; padding:5px 9px; background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.12); border-radius:6px; color:#f0ede8; cursor:pointer; font-size:14px; line-height:1; transition:all .15s; font-family:inherit; }
.wr-notif-bell-btn:hover { background:rgba(255,255,255,.14); }
.wr-notif-bell-btn.has-unread { background:rgba(34,197,94,.15); border-color:rgba(34,197,94,.5); box-shadow:0 0 0 0 rgba(34,197,94,.5); animation:wr-notif-pulse 2s infinite; }
@keyframes wr-notif-pulse { 0%{box-shadow:0 0 0 0 rgba(34,197,94,.5)} 70%{box-shadow:0 0 0 10px rgba(34,197,94,0)} 100%{box-shadow:0 0 0 0 rgba(34,197,94,0)} }
.wr-notif-badge { position:absolute; top:-5px; right:-5px; min-width:18px; height:18px; padding:0 5px; background:#22c55e; color:#fff; font-size:10px; font-weight:800; border-radius:9px; display:none; align-items:center; justify-content:center; line-height:1; box-shadow:0 0 0 2px #1a1a1a; }
.wr-notif-badge.show { display:flex; }
.wr-notif-panel { position:absolute; top:calc(100% + 8px); right:0; width:380px; max-height:520px; background:#1a1a1a; border:1px solid #2a2a2a; border-radius:10px; box-shadow:0 12px 36px rgba(0,0,0,.5); z-index:1500; display:flex; flex-direction:column; overflow:hidden; }
.wr-notif-panel-header { display:flex; align-items:center; justify-content:space-between; padding:12px 16px; border-bottom:1px solid #2a2a2a; flex-shrink:0; }
.wr-notif-panel-title { font-size:12px; font-weight:800; text-transform:uppercase; letter-spacing:.07em; color:#e8e8e8; }
.wr-notif-link-btn { font-size:11px; font-weight:600; color:#888; background:none; border:none; cursor:pointer; font-family:inherit; padding:0; transition:color .15s; }
.wr-notif-link-btn:hover { color:#e8e8e8; }
.wr-notif-link-btn.primary { color:#22c55e; }
.wr-notif-link-btn.primary:hover { color:#16a34a; }
.wr-notif-list { flex:1; overflow-y:auto; min-height:0; }
.wr-notif-empty { padding:40px 20px; text-align:center; font-size:12px; color:#888; font-style:italic; }
.wr-notif-card { padding:11px 14px; border-bottom:1px solid #2a2a2a; transition:background .12s; }
.wr-notif-card:last-child { border-bottom:none; }
.wr-notif-card.unread { background:rgba(34,197,94,.04); }
.wr-notif-card-title { font-size:12px; font-weight:700; color:#e8e8e8; line-height:1.35; margin-bottom:3px; }
.wr-notif-card-body { font-size:11px; color:#aaa; line-height:1.5; }
.wr-notif-card-meta { font-size:9.5px; color:#666; margin-top:4px; }
.wr-notif-card-actions { display:flex; align-items:center; gap:8px; margin-top:8px; }
.wr-notif-confirm-btn { padding:4px 10px; background:rgba(34,197,94,.15); border:1px solid rgba(34,197,94,.4); border-radius:5px; color:#22c55e; font-size:10px; font-weight:700; cursor:pointer; font-family:inherit; letter-spacing:.02em; transition:background .12s; }
.wr-notif-confirm-btn:hover { background:rgba(34,197,94,.25); }
.wr-notif-open-link { font-size:10px; color:#888; text-decoration:none; font-weight:600; padding:4px 0; }
.wr-notif-open-link:hover { color:#ee6216; }
.wr-notif-panel-footer { display:flex; align-items:center; justify-content:space-between; padding:10px 16px; border-top:1px solid #2a2a2a; flex-shrink:0; background:#161616; }
`;
    document.head.appendChild(style);
  }

  function init() {
    const mount = document.getElementById('notifBellMount');
    if (!mount) return; // page doesn't include the bell — silent no-op

    // Replace the mount placeholder with the bell + dropdown.
    const wrap = document.createElement('div');
    wrap.className = 'wr-notif-wrap';
    wrap.id = 'wrNotifWrap';
    wrap.innerHTML = `
      <button class="wr-notif-bell-btn" id="wrNotifBellBtn" title="Notifications" type="button">
        🔔<span class="wr-notif-badge" id="wrNotifBadge">0</span>
      </button>
      <div class="wr-notif-panel" id="wrNotifPanel" style="display:none">
        <div class="wr-notif-panel-header">
          <span class="wr-notif-panel-title" id="wrNotifPanelTitle">🔔 Notifications</span>
          <button class="wr-notif-link-btn" id="wrNotifBackBtn" type="button" style="display:none">← Active</button>
        </div>
        <div class="wr-notif-list" id="wrNotifList">
          <div class="wr-notif-empty">Loading…</div>
        </div>
        <div class="wr-notif-panel-footer">
          <button class="wr-notif-link-btn" id="wrNotifHistoryBtn" type="button">View history →</button>
          <button class="wr-notif-link-btn primary" id="wrNotifConfirmAllBtn" type="button">✓ Confirm all</button>
        </div>
      </div>
    `;
    mount.replaceWith(wrap);

    // ── State ───────────────────────────────────────────────────────
    let _view = 'active';   // 'active' | 'history'
    let _items = [];        // current list shown in the panel
    let _activeCache = [];  // last fetched unread list (drives the badge)
    let _pollTimer = null;
    let _open = false;

    // ── DOM refs ────────────────────────────────────────────────────
    const $btn        = document.getElementById('wrNotifBellBtn');
    const $badge      = document.getElementById('wrNotifBadge');
    const $panel      = document.getElementById('wrNotifPanel');
    const $list       = document.getElementById('wrNotifList');
    const $title      = document.getElementById('wrNotifPanelTitle');
    const $back       = document.getElementById('wrNotifBackBtn');
    const $hist       = document.getElementById('wrNotifHistoryBtn');
    const $confirmAll = document.getElementById('wrNotifConfirmAllBtn');

    // ── Helpers ─────────────────────────────────────────────────────
    const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const fmtTime = iso => {
      if (!iso) return '';
      const d = new Date(iso);
      const diffMin = Math.round((Date.now() - d.getTime()) / 60000);
      if (diffMin < 1)    return 'just now';
      if (diffMin < 60)   return diffMin + 'm ago';
      if (diffMin < 1440) return Math.round(diffMin / 60) + 'h ago';
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
    };

    function renderBadge() {
      const n = _activeCache.length;
      if (n > 0) {
        $badge.textContent = n > 99 ? '99+' : String(n);
        $badge.classList.add('show');
        $btn.classList.add('has-unread');
      } else {
        $badge.classList.remove('show');
        $btn.classList.remove('has-unread');
      }
    }

    function renderList() {
      if (!_items.length) {
        $list.innerHTML = `<div class="wr-notif-empty">${_view === 'history' ? 'No history yet' : 'You\'re all caught up'}</div>`;
        return;
      }
      $list.innerHTML = _items.map(n => {
        const isActive = _view === 'active';
        const openLink = n.quote_num
          ? `<a class="wr-notif-open-link" href="/orders?openOrder=${encodeURIComponent(n.quote_num)}">Open order →</a>`
          : (n.deal_id ? `<a class="wr-notif-open-link" href="/deals?openDeal=${encodeURIComponent(n.deal_id)}">Open deal →</a>` : '');
        return `
          <div class="wr-notif-card ${isActive ? 'unread' : ''}" data-id="${n.id}">
            <div class="wr-notif-card-title">${esc(n.title || '')}</div>
            ${n.body ? `<div class="wr-notif-card-body">${esc(n.body)}</div>` : ''}
            <div class="wr-notif-card-meta">${fmtTime(n.created_at)}${n.deal_name ? ' · ' + esc(n.deal_name) : ''}</div>
            ${isActive ? `<div class="wr-notif-card-actions">
              <button class="wr-notif-confirm-btn" data-confirm="${n.id}" type="button">✓ Confirm</button>
              ${openLink}
            </div>` : (openLink ? `<div class="wr-notif-card-actions">${openLink}</div>` : '')}
          </div>
        `;
      }).join('');

      // Bind confirm buttons (event-delegated would also work; per-button
      // keeps it simple).
      $list.querySelectorAll('[data-confirm]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          confirmOne(parseInt(btn.dataset.confirm, 10));
        });
      });
    }

    async function loadActive() {
      try {
        const res = await fetch('/api/notifications', { credentials: 'include' });
        const data = await res.json();
        _activeCache = Array.isArray(data.notifications) ? data.notifications : [];
        renderBadge();
        if (_view === 'active') {
          _items = _activeCache;
          renderList();
        }
      } catch(e) { /* silent */ }
    }

    async function loadHistory() {
      try {
        const res = await fetch('/api/notifications/history?limit=200', { credentials: 'include' });
        const data = await res.json();
        _items = Array.isArray(data.notifications) ? data.notifications : [];
        renderList();
      } catch(e) { /* silent */ }
    }

    async function confirmOne(id) {
      if (!id) return;
      try {
        await fetch(`/api/notifications/${id}/confirm`, { method: 'POST', credentials: 'include' });
        _activeCache = _activeCache.filter(n => n.id !== id);
        if (_view === 'active') {
          _items = _activeCache;
          renderList();
        }
        renderBadge();
      } catch(e) { /* silent */ }
    }

    async function confirmAll() {
      if (!_activeCache.length) return;
      try {
        await fetch('/api/notifications/read-all', { method: 'POST', credentials: 'include' });
        _activeCache = [];
        if (_view === 'active') { _items = []; renderList(); }
        renderBadge();
      } catch(e) { /* silent */ }
    }

    function openPanel() {
      $panel.style.display = 'flex';
      _open = true;
      // Always show active on open; refresh first.
      _view = 'active';
      $title.textContent = '🔔 Notifications';
      $back.style.display = 'none';
      $hist.style.display = 'inline-block';
      $confirmAll.style.display = 'inline-block';
      loadActive();
    }

    function closePanel() {
      $panel.style.display = 'none';
      _open = false;
    }

    function showHistory() {
      _view = 'history';
      $title.textContent = '🕓 Notification History';
      $back.style.display = 'inline-block';
      $hist.style.display = 'none';
      $confirmAll.style.display = 'none';
      $list.innerHTML = '<div class="wr-notif-empty">Loading…</div>';
      loadHistory();
    }

    function showActive() {
      _view = 'active';
      $title.textContent = '🔔 Notifications';
      $back.style.display = 'none';
      $hist.style.display = 'inline-block';
      $confirmAll.style.display = 'inline-block';
      _items = _activeCache;
      renderList();
    }

    // ── Wire events ─────────────────────────────────────────────────
    $btn.addEventListener('click', (e) => {
      e.stopPropagation();
      _open ? closePanel() : openPanel();
    });
    $back.addEventListener('click', showActive);
    $hist.addEventListener('click', showHistory);
    $confirmAll.addEventListener('click', confirmAll);
    document.addEventListener('click', (e) => {
      if (_open && !wrap.contains(e.target)) closePanel();
    });

    // Initial load + 60s poll for fresh notifications.
    loadActive();
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(loadActive, 60000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
