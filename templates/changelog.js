// Changelog page template — extracted from quote-server.js
// Returns the fully rendered HTML for /changelog.

module.exports = function renderChangelog() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Changelog — WhisperRoom</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='6' fill='%231a1a1a'/><text x='50%25' y='56%25' dominant-baseline='middle' text-anchor='middle' font-size='18'>📝</text></svg>">
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root{--bg:#0f0f0f;--surface:#1a1a1a;--surface2:#222;--border:#2a2a2a;--orange:#ee6216;--text:#e8e8e8;--muted:#888;--green:#22c55e;--red:#ef4444;--yellow:#f59e0b;--blue:#3b82f6;}
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;}
  .topbar{display:flex;align-items:center;justify-content:space-between;padding:0 20px;height:52px;background:#1a1a1a;border-bottom:1px solid rgba(255,255,255,.1);position:sticky;top:0;z-index:100;}
  .logo{font-family:'Syne',sans-serif;font-size:18px;font-weight:800;color:#f0ede8;}.logo span{color:#e8531a;}
  .back{font-size:11px;font-weight:700;color:var(--muted);text-decoration:none;padding:5px 10px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:6px;letter-spacing:.05em;text-transform:uppercase;}
  .main{max-width:860px;margin:0 auto;padding:32px 24px;}
  h1{font-family:'Syne',sans-serif;font-size:24px;font-weight:800;margin-bottom:4px;}h1 span{color:var(--orange);}
  .subtitle{font-size:12px;color:var(--muted);margin-bottom:32px;}
  .version-block{margin-bottom:28px;border:1px solid var(--border);border-radius:10px;overflow:hidden;}
  .version-header{padding:12px 18px;background:var(--surface);display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--border);}
  .version-num{font-family:'Syne',sans-serif;font-size:15px;font-weight:800;color:var(--orange);}
  .version-date{font-size:11px;color:var(--muted);}
  .version-tag{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;padding:2px 7px;border-radius:4px;margin-left:auto;}
  .tag-fix{background:rgba(59,130,246,.15);color:var(--blue);}
  .tag-feature{background:rgba(34,197,94,.12);color:var(--green);}
  .tag-logging{background:rgba(238,98,22,.12);color:var(--orange);}
  .tag-ui{background:rgba(168,85,247,.15);color:#a855f7;}
  .version-body{padding:14px 18px;background:var(--surface);}
  .change-item{display:flex;gap:10px;padding:5px 0;border-bottom:1px solid var(--border);font-size:13px;line-height:1.5;}
  .change-item:last-child{border-bottom:none;}
  .change-type{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;padding:2px 6px;border-radius:3px;white-space:nowrap;height:fit-content;margin-top:2px;}
  .ct-fix{background:rgba(59,130,246,.15);color:var(--blue);}
  .ct-add{background:rgba(34,197,94,.12);color:var(--green);}
  .ct-log{background:rgba(238,98,22,.12);color:var(--orange);}
  .ct-ui{background:rgba(168,85,247,.15);color:#a855f7;}
  .ct-security{background:rgba(245,158,11,.12);color:var(--yellow);}
</style>
</head>
<body>
<div class="topbar">
  <div class="logo">Whisper<span>Room</span> — Changelog</div>
  <a href="/admin-log" class="back">← Admin Log</a>
</div>
<div class="main">
  <h1>Patch <span>Notes</span></h1>
  <div class="subtitle">Full history of changes to the WhisperRoom sales tool</div>

  ${[
    {
      v:'1.2.3', date:'Apr 18, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Deal Hub card sort: was secretly re-sorting client-side by HubSpot\\u2019s hs_lastmodifieddate, which treats any HubSpot activity (views, note edits, field touches) as a reason to bump a card up. Now strictly sorts by lastActivityAt from our system \u2014 quote pushed, order processed, quote accepted. Deals without any of those sink to the bottom by amount.'},
        {t:'fix', d:'Unintegrated dot logic: was gated on a narrow stage list (only Sent/Updated Quote stages got the dot). Now any deal without a quote / accepted flag / payment type in our system gets dimmed + gray dot, regardless of HubSpot stage. Emily-Love-type cases (no quotes, not in early stage) are now correctly flagged.'},
      ]
    },
    {
      v:'1.2.2', date:'Apr 18, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Versioning convention refined in HANDOFF.md: MINOR (1.2 → 1.3) now bumps only on meaningful new features (not on every merge to main). PATCH (1.2.0 → 1.2.1) for bug fixes and small tweaks. MAJOR (1 → 2) reserved for rewrites. Rule of thumb: if you\\u2019d say "I added X" → MINOR; "I fixed X" → PATCH.'},
      ]
    },
    {
      v:'1.2.1', date:'Apr 18, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Customer-facing invoice page: "Change Specs" button now always shows (was gated behind q.accepted, so it only appeared when the customer had clicked Accept on the /q/ page first — invoices sent directly by the rep had no spec-change path).'},
      ]
    },
    {
      v:'1.2.0', date:'Apr 18, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Release bump: everything from 1.1.15 through 1.1.104 rolls into the 1.2.0 release milestone. Going forward: MINOR bump (1.2 \u2192 1.3) on every merge to main; PATCH counts commits on staging between releases; MAJOR reserved for rewrites. Documented in HANDOFF.md §3.'},
        {t:'add', d:'This release: Process Order overhaul (Deal Hub modal + quote builder parity), payment method tracking, Mobile overhaul (Deal Hub + quote builder + customer pages), Ship Calendar with pallet color coding, RM + Custom Holes production flags, Orders dashboard redesign, Reports rebuild Step 1 (hero KPIs + rep filter), retroactive changelog + version discipline, admin payment-method override.'},
      ]
    },
    {
      v:'1.1.104', date:'Apr 18, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'Deal Hub detail panel quote rows now show RM / CUST chips per quote so you can tell which specific revision contains the flagged line items. Previously only the deal card (aggregate) showed them. /api/deals/:id/hub now returns hasRM + hasCustomHole on each quote.'},
      ]
    },
    {
      v:'1.1.103', date:'Apr 18, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Custom holes tracking: line items starting with "CUST HOLE " (CUST HOLE E or CUST HOLE S) now flag the order as Custom Holes — 1-month lead, Gary (production manager) notified.'},
        {t:'add', d:'On Process Order: server prepends "CUSTOM HOLES — " to production notes (idempotent, survives re-processing). Shipping email CCs gamos@whisperroom.com (same as RM) and includes "Gary, this order includes Custom Holes." line when detected. Both flags can apply together — prefix becomes "RM + CUSTOM HOLES — " and both Gary lines appear.'},
        {t:'ui',  d:'Amber "CUST" chip on Deal Hub board cards, orders dashboard table rows, and ship calendar cells. Distinct from the red "RM" chip so you can tell them apart at a glance; deals with both show both chips.'},
      ]
    },
    {
      v:'1.1.102', date:'Apr 18, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Deal Hub admin override: new Payment Method dropdown in the admin panel lets you change a deal\\u2019s payment type (HubSpot Invoice / Credit Card / ACH / PO / Other) or clear it. Non-PO choices save automatically on change; PO shows a PO Number input + Save PO button so the number can be entered first.'},
        {t:'add', d:'New endpoint PATCH /api/deals/:id/payment-type \u2014 maps lowercase client values to HubSpot\\u2019s uppercase enum, mirrors payment_status, logs admin override to the admin log, logs HubSpot failures to Railway.'},
        {t:'ui',  d:'Removed "(1-month lead time)" from the RM notice line in the shipping notification email \u2014 Gary already knows.'},
      ]
    },
    {
      v:'1.1.101', date:'Apr 18, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Deal Hub Process Order now opens the shipping notification email (was only happening from the quote builder\\u2019s orange Process Order button). Added openShippingNotifyEmail() helper to deals-dashboard.html that mirrors the quote-builder email format: to=shipping@, cc=accounting@+bentonwhite@ (+ gamos@ if RM), subject, full order body with line items, totals, ship-to, production notes, and order URL.'},
        {t:'ui',  d:'Light-mode Process Order modal: Cancel button and other secondary controls used rgba(255,255,255,.6) text which fell through my CSS override. Extended coverage to include .6/.65/.7/.75 alpha whites as --text, and invisible .08 white backgrounds now use --bg so the button has a visible surface against the cream modal.'},
      ]
    },
    {
      v:'1.1.100', date:'Apr 18, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Process Order mailto: switched from window.location.href / window.open to a programmatic anchor-click (create <a>, append, .click(), remove). This is the most reliable way to trigger native mailto handlers — browsers treat it as a user-initiated click instead of programmatic navigation, which bypasses popup blocker heuristics. Added console.log traces so the dispatch is visible in DevTools if it still doesn\\u2019t open.'},
        {t:'ui',  d:'Removed the manual "Send Shipping Email" button from the success box — the email must open automatically, not require a click.'},
        {t:'ui',  d:'Light-mode Process Order modal labels (Payment Method, Foam, Hinge, AP) now use --text instead of --muted for primary labels, darker --border lines, and adapted input backgrounds. Primary radio/selection labels were getting lost against the cream surface.'},
      ]
    },
    {
      v:'1.1.99', date:'Apr 18, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Process Order: HubSpot deal PATCH was failing with 400 because payment_type values were sent lowercase (hs/cc/ach/po/other) but HubSpot\\u2019s dropdown enum uses uppercase (HS, CC, ACH, PO, Other). Added a client\u2192HubSpot mapping at the server boundary and normalize incoming HubSpot values back to lowercase when we read them for the UI. Deals will now move to Closed Won correctly.'},
      ]
    },
    {
      v:'1.1.98', date:'Apr 18, 2026', tag:'fix',
      changes:[
        {t:'ui',  d:'Process Order modal now adapts to light/dark theme — was hard-coded dark regardless of theme. In light mode the modal bg, text, inputs, and AP color picker all render light; in dark mode they stay dark. Fixes unreadable AP color options in Opera/Chrome where native select chrome ignored forced dark styling.'},
        {t:'log', d:'Process Order deal PATCH failures now also log to Railway stdout (console.error) with status + HubSpot rejection body + sent props. No need to expand the admin log entry to diagnose.'},
      ]
    },
    {
      v:'1.1.97', date:'Apr 18, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Process Order AP color picker options are now dark-themed on Chrome/Opera: added inline color-scheme:dark to the select so the browser renders the native dropdown with dark OS chrome. Previous fix via body.dark CSS only applied when the user had explicitly toggled dark theme.'},
        {t:'fix', d:'Process Order mailto now tries window.open first (with window.location.href as fallback) — more reliable across browsers when a mailto handler is registered but popup-style triggers behave differently than navigation-style.'},
      ]
    },
    {
      v:'1.1.96', date:'Apr 18, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Process Order: if the full HubSpot deal PATCH (stage + ap_color + payment_type + po_) returns 400, we now automatically retry with just dealstage=closedwon so the deal at least moves. Both failures are logged (stage-patch + stage-patch-retry) with the full HubSpot response body and the props we sent — next time this happens we\\u2019ll have enough data to fix the actual bad property.'},
      ]
    },
    {
      v:'1.1.95', date:'Apr 18, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Process Order HubSpot deal-stage PATCH was silently swallowing HubSpot errors — if HubSpot returned 4xx/5xx, the deal stayed in its previous stage but the order still saved and the UI showed success. Now surfaces a non-2xx response as error.process-order.stage-patch in the admin log so the issue is visible.'},
        {t:'ui',  d:'Process Order success box now includes a manual "✉ Send Shipping Email" button alongside the order link. Auto-mailto (window.location.href = mailto:) can be blocked silently by the browser or OS, so the manual fallback guarantees the email can be opened.'},
        {t:'ui',  d:'Toast text changed from "Email draft opened!" to "Order processed" since we can\\u2019t actually guarantee the mail client opened.'},
      ]
    },
    {
      v:'1.1.94', date:'Apr 18, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'Process Order AP color picker options are now readable — the dropdown options were using the browser default light gray (barely visible on dark theme). Applied dark-theme option styling globally so every select respects the theme.'},
      ]
    },
    {
      v:'1.1.93', date:'Apr 18, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Roof Mounted Ventilation (RM) tracking: any line item starting with "RM " now flags the order for Gary (production manager) — 1-month lead time.'},
        {t:'add', d:'On Process Order: server auto-prepends "RM — " to production notes; quote-builder mailto now cc\\u2019s gamos@whisperroom.com and includes "Gary, this order includes Roof Mounted Ventilation (1-month lead time)" in the email body.'},
        {t:'ui',  d:'Red "RM" chip on Deal Hub board cards, orders dashboard rows, and ship calendar cells so the flag is visible everywhere a deal surfaces.'},
        {t:'ui',  d:'Ship calendar now shows "Parts" instead of "?" for orders with 0 pallets and no MDL items (parts-only orders). "?" still appears for unknown/missing pallet data.'},
      ]
    },
    {
      v:'1.1.92', date:'Apr 18, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'Ship calendar cells now wrap long deal names instead of truncating with ellipsis. Day cells grow vertically to fit the content.'},
        {t:'ui', d:'Strips noise suffixes from calendar labels ("– New Deal", "— Quote", "— Revision", "— Updated Quote") so the meaningful part of the deal name shows through. Full original name still appears on hover.'},
      ]
    },
    {
      v:'1.1.91', date:'Apr 18, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'Ship calendar cells now show the deal name as the primary label, with the MDL in muted type next to it (was: MDL only)'},
      ]
    },
    {
      v:'1.1.90', date:'Apr 18, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Orders dashboard: monthly ship calendar below the orders list — renders each order on its planned/actual ship date with click-through to the detail drawer'},
        {t:'add', d:'Pallet cap color coding per day cell: green ≤3, yellow 4-5, red 6+ (soft indicator — does not prevent adding more)'},
        {t:'add', d:'Pallet count auto-computed from line items when processing an order — saved to order_data.shipped.pallets. Jeromy can edit afterward in the drawer.'},
        {t:'ui',  d:'Orders table now caps at ~10 rows with an internal scroll + sticky header instead of a long page scroll'},
        {t:'ui',  d:'Day cells show total pallet count badge and list each shipment\\u2019s pallet qty + MDL'},
        {t:'ui',  d:'Calendar month nav (Prev / Today / Next), Today cell highlighted in orange, outside-month days dimmed'},
      ]
    },
    {
      v:'1.1.89', date:'Apr 18, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'"E" now labeled "Enhanced" (not "Electric") in the Standard vs Enhanced split'},
        {t:'fix', d:'Top Customers by Value no longer double-counts quote revisions — was summing every revision as its own deal (e.g. AMP showing $528k for a $173k deal with 3 revisions). Now uses max total per unique deal_id.'},
        {t:'ui',  d:'Replaced broken hand-drawn US sales map with an expanded "Top States" bar chart showing count + % share — accurate, readable, and mobile-friendly'},
      ]
    },
    {
      v:'1.1.88', date:'Apr 18, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Reports rebuild Step 1: new "At a glance" hero row with 4 decision-oriented KPIs — Revenue MTD (vs last month), Pipeline Value, Win Rate (vs 90d avg), Avg Deal Size (vs 90d avg)'},
        {t:'add', d:'Rep filter dropdown in the reports sidebar — all KPIs recompute scoped to the selected rep'},
        {t:'ui',  d:'Mobile-responsive reports: sidebar collapses to a horizontal chip row, KPI strip switches to 2-column on tablet and 1-column on narrow'},
        {t:'ui',  d:'Topbar scrolls horizontally on narrow screens to match Deal Hub pattern'},
      ]
    },
    {
      v:'1.1.87', date:'Apr 18, 2026', tag:'feature',
      changes:[
        {t:'add', d:'HANDOFF.md now documents the version-bump + changelog discipline — every push bumps package.json patch version and adds a templates/changelog.js entry'},
      ]
    },
    {
      v:'1.1.86', date:'Apr 18, 2026', tag:'ui',
      changes:[
        {t:'ui',  d:'Mobile overhaul of Deal Hub — hub panel slides in as overlay on narrow screens, topbar scrolls horizontally instead of clipping Sign Out'},
        {t:'ui',  d:'Collapsible Kanban columns on Fold-cover / ≤480px — tap a column header to expand/collapse'},
        {t:'ui',  d:'Column totals now displayed under each stage header (Sent, Verbal, Won, Shipped) — color-matched to the stage'},
        {t:'ui',  d:'Quote builder topbar: fixed nav-button pile-up at tablet widths by switching to horizontal scroll ≤1024px'},
        {t:'ui',  d:'Customer order page /o/:id: table collapses to name/qty/total on mobile (was overflowing with 5 columns)'},
        {t:'add', d:'Retroactive changelog reconstruction from v1.1.15 to v1.1.86'},
      ]
    },
    {
      v:'1.1.85', date:'Apr 17, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Restore orderModal HTML to DOM — the div only existed inside a PDF template string, so document.getElementById returned null and the orange Process Order button did nothing'},
        {t:'fix', d:'Open order modal before awaiting HubSpot payment-type prefill so a slow fetch never blocks the modal from appearing'},
        {t:'fix', d:'Wrap renderOrderSummaryQB() in try/catch so a rendering error cannot block the modal from opening'},
        {t:'fix', d:'Silence Puppeteer "old Headless" deprecation warning in UPS tracking scraper (headless: true → headless: "new")'},
      ]
    },
    {
      v:'1.1.84', date:'Apr 17, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Orange Process Order button in quote builder now opens the same modal used on the Deal Hub — collects payment type, PO number, order summary, and production notes'},
        {t:'add', d:'Quote label surfaced on Deal Hub cards and quote rows — takes precedence over MDL model string when set'},
      ]
    },
    {
      v:'1.1.83', date:'Apr 17, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'Deal Hub cards and column headers restyled — cleaner spacing, tighter type scale, clearer stage colors'},
      ]
    },
    {
      v:'1.1.82', date:'Apr 17, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Process Order modal now shows a live order summary — line items, discount, freight, tax, total, and ship-to address'},
      ]
    },
    {
      v:'1.1.81', date:'Apr 17, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'Switched all internal dashboards to Satoshi font family for a more consistent brand feel'},
      ]
    },
    {
      v:'1.1.80', date:'Apr 17, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Process Order modal launched from the Deal Hub — previously the blue "Process" button redirected into the quote builder'},
        {t:'add', d:'Payment method tracking via HubSpot custom properties payment_type (HS / CC / ACH / PO / Other) and po_ (PO number)'},
        {t:'add', d:'Payment badges on Deal Hub cards now reflect specific payment method instead of generic paid/PO tag'},
        {t:'add', d:'Notes & Order Specs carry over to Production Notes automatically when processing an order'},
      ]
    },
    {
      v:'1.1.78', date:'Apr 17, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'Replaced text logo with WhisperRoom SVG logo across all pages (topbar, PDFs, customer-facing quote/invoice/order pages)'},
      ]
    },
    {
      v:'1.1.77', date:'Apr 17, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Locked deal payment amount is now additive — paying a second invoice adds to amount_paid instead of replacing it'},
      ]
    },
    {
      v:'1.1.75', date:'Apr 17, 2026', tag:'security',
      changes:[
        {t:'security', d:'Closed Won / Shipped deals locked against quote sync overwrites — prevents a late quote revision from rewriting a finalized deal'},
      ]
    },
    {
      v:'1.1.72', date:'Apr 17, 2026', tag:'feature',
      changes:[
        {t:'add', d:'HANDOFF.md onboarding doc — full project context, workflow, env vars, gotchas for new collaborators'},
      ]
    },
    {
      v:'1.1.70', date:'Apr 17, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'gdriveSavePdfToDeal: fall back to a sibling quote folder on the same deal when the current quote lacks gdrive_folder_id (covers legacy quotes)'},
        {t:'log', d:'Surface the real error on order PDF upload instead of generic failure message'},
        {t:'fix', d:'GDRIVE_ORDERS_FOLDER env var now overrides hardcoded orders folder ID'},
      ]
    },
    {
      v:'1.1.65', date:'Apr 17, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Phase 2 refactor: extracted inline HTML dashboards (deals, quotes, orders, shipping, reports, admin-log) from quote-server.js into separate .html files'},
      ]
    },
    {
      v:'1.1.60', date:'Apr 17, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Phase 1 refactor: extracted states, utils, logger, auth, db, hubspot, gdrive, pdf, taxjar, notify, and freight helpers from monolithic quote-server.js into lib/*.js modules'},
        {t:'ui', d:'Each lib module exports init({ deps }) — dependencies wired once at server startup'},
      ]
    },
    {
      v:'1.1.55', date:'Apr 17, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Quote number collision handler no longer produces 11-digit numbers when the daily sequence rolls over'},
      ]
    },
    {
      v:'1.1.50', date:'Apr 17, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Skip US-only state enums up front for Canadian provinces instead of retrying on HubSpot rejection'},
        {t:'fix', d:'Invoice address PATCH now includes hs_collect_address_types: "billing_address" — resolves HubSpot 400 conflict errors'},
      ]
    },
    {
      v:'1.1.45', date:'Apr 17, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Folder picker always prompts on new deals, even when the contact already has a prior Drive folder — each deal now gets its own folder'},
        {t:'log', d:'Invoice address PATCH errors now log the full request body for diagnosis'},
      ]
    },
    {
      v:'1.1.40', date:'Apr 17, 2026', tag:'feature',
      changes:[
        {t:'add', d:'PUBLIC_BASE_URL env var for building customer-facing links — staging and prod now point to their own domains'},
        {t:'fix', d:'Client-side links use location.origin instead of hardcoded sales.whisperroom.com'},
        {t:'fix', d:'PDF cookie domain derived from request host instead of hardcoded'},
      ]
    },
    {
      v:'1.1.35', date:'Apr 17, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Quote number timezone bug — quote numbers now generate with correct local date (America/New_York) instead of UTC'},
        {t:'fix', d:'Allow staging Railway URL in OAuth redirect allowlist'},
      ]
    },
    {
      v:'1.1.30', date:'Apr 16, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Catch-up: multiple iterations on Deal Hub — card layout, pipeline stages, filter toggles, deal search refinements'},
      ]
    },
    {
      v:'1.1.25', date:'Apr 16, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Catch-up: continued quote-server refinements — HubSpot deal matching, contact search, owner assignment edge cases'},
      ]
    },
    {
      v:'1.1.20', date:'Apr 15, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Catch-up: tracking and shipping polish — column headers, status badges, tracking link fallbacks'},
      ]
    },
    {
      v:'1.1.15', date:'Apr 15, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Catch-up: quote builder and orders dashboard iterations — freight display, invoice flow tweaks, small UI fixes'},
      ]
    },
    {
      v:'1.1.14', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Canadian freight now uses correct NMFC codes (027880/02) matching legacy system'},
        {t:'fix', d:'Postal code spaces stripped automatically — "M4W 1B7" and "M4W1B7" both work'},
        {t:'fix', d:'Zip space stripping applied at server, freight request, and customer record save'},
      ]
    },
    {
      v:'1.1.13', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Ship It button now saves serial number, production notes, foam color, and hinge preference — same as Save Changes'},
      ]
    },
    {
      v:'1.1.12', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Ship date showing one day early — YYYY-MM-DD strings parsed as UTC midnight, now treated as local noon'},
      ]
    },
    {
      v:'1.1.11', date:'Apr 13, 2026', tag:'log',
      changes:[
        {t:'log', d:'Full shipping error coverage: error.refresh-tracking, error.track, error.ship-deal, error.ship-hubspot-deal, error.shipping-board, error.order-ship, error.tracking-poller'},
        {t:'log', d:'All error log entries now include rep via getRepFromReq()'},
      ]
    },
    {
      v:'1.1.10', date:'Apr 13, 2026', tag:'log',
      changes:[
        {t:'log', d:'Rep name now shows on ALL error log entries — getRepFromReq() helper added'},
        {t:'log', d:'Tax errors include rep from request body'},
      ]
    },
    {
      v:'1.1.09', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'TaxJar errors now log to system log with state/zip/city'},
        {t:'fix', d:'Tax route body hoisted out of try block — prevents body is not defined crash'},
        {t:'ui',  d:'Tax errors show plain English: invalid ZIP/city/state/timeout messages'},
      ]
    },
    {
      v:'1.1.08', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'TaxJar errors now logged to system log (error.tax event)'},
        {t:'ui',  d:'Tax error messages translated to plain English for reps'},
      ]
    },
    {
      v:'1.1.07', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'httpsGet 15-second timeout — freight no longer hangs for 5+ minutes'},
        {t:'fix', d:'parseAbfXml reads ABF ERROR tags and returns actionable messages'},
        {t:'fix', d:'Freight body scope fix — body is not defined crash resolved'},
        {t:'ui',  d:'Invalid ZIP/city/state/weight shown as plain English to reps'},
      ]
    },
    {
      v:'1.1.06', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Freight route body hoisted — prevented unhandledRejection crash'},
        {t:'log', d:'Freight errors now correctly log with dest zip/state/city'},
      ]
    },
    {
      v:'1.1.05', date:'Apr 13, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Rename Deal button in deal panel — updates HubSpot, Google Drive folder, and all DB quotes'},
        {t:'log', d:'deal.renamed logged to activity feed on success'},
      ]
    },
    {
      v:'1.1.04', date:'Apr 13, 2026', tag:'log',
      changes:[
        {t:'log', d:'Full error logging on all critical routes: accept-quote, create-invoice, process-order, abf-booking, order-save, unship, orders-list, hubspot'},
        {t:'add', d:'Gabe Troubleshooting Handbook added to handoff doc'},
      ]
    },
    {
      v:'1.1.03', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Duplicate quote.pushed log removed — was firing from both /api/history and /api/create-deal'},
      ]
    },
    {
      v:'1.1.02', date:'Apr 13, 2026', tag:'log',
      changes:[
        {t:'log', d:'Freight error logging added to quote builder, orders-freight, and ABF inner catch'},
      ]
    },
    {
      v:'1.1.01', date:'Apr 13, 2026', tag:'ui',
      changes:[
        {t:'ui',  d:'Admin log rebuilt — favicon, live dot, rep/event dropdowns, date range filter, stats bar, version badge, clear button'},
      ]
    },
    {
      v:'1.1.00', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'quote.pushed log correctly labels New deal vs Revision — meta includes isNewDeal and existingDealId'},
      ]
    },
    {
      v:'1.0.96', date:'Apr 13, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Logging system launched — logs table in PostgreSQL, writelog() helper, admin log page at /admin-log'},
        {t:'log', d:'Events: quote.pushed, deal.created, invoice.created, order.shipped, order.unshipped, order.deleted, order.processed, task.accounting'},
        {t:'log', d:'Errors: error.freight, error.tax, error.hubspot, error.save'},
      ]
    },
    {
      v:'1.0.95', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Accounting task on Ship It fires for ALL reps, not just Jeromy — assigned to Kim Dalton'},
        {t:'fix', d:'Task includes deal name, serial number, carrier, PRO/tracking, freight cost'},
      ]
    },
    {
      v:'1.0.94', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Unship preserves all shipment data — only reverts HubSpot dealstage to Closed Won'},
        {t:'fix', d:'Delete button now visible to all reps'},
        {t:'fix', d:'HS-only orders: Ship It creates DB record so order persists on board'},
      ]
    },
    {
      v:'1.0.93', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Serial number field changed to textarea for multi-line support'},
        {t:'fix', d:'HS-only orders (HS-{dealId}) save directly to HubSpot via PATCH'},
      ]
    },
    {
      v:'1.0.92', date:'Apr 13, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Credits line items created BEFORE the HubSpot loop — were never being sent'},
        {t:'fix', d:'Credit descriptor line: "Credit applied in MDL XXXX above: -$XX.XX"'},
        {t:'fix', d:'anchor variable hoisted to outer scope — fixed ReferenceError on credit push'},
      ]
    },
    {
      v:'1.0.91', date:'Apr 13, 2026', tag:'feature',
      changes:[
        {t:'add', d:'OD Freight rating added alongside ABF — LTL, GTD, GTE via SOAP XML'},
        {t:'add', d:'OD Book URL pre-fills dest zip on odfl.com'},
        {t:'fix', d:'httpsGet timeout 15 seconds, parseAbfXml reads ERROR tags'},
      ]
    },
    {
      v:'1.0.90', date:'Apr 13, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Freight rating modal on orders board — Get Freight button fetches ABF rate per order'},
        {t:'add', d:'Orders board drag-and-drop sort with position persistence'},
      ]
    },
    {
      v:'1.0.89', date:'Apr 9, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Quote notes displayed on /q/ and /i/ client pages in orange-bordered box'},
        {t:'fix', d:'Canadian province state handling — retry without state fields if HubSpot rejects'},
      ]
    },
    {
      v:'1.0.88', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Orders dashboard — In Production / Shipped / All Orders / HubSpot Closed Won tabs'},
        {t:'add', d:'Orders drawer with foam color, hinge, serial number, production notes, delivery notes'},
        {t:'add', d:'Ship It button with carrier/tracking/date/pallets/boxes/hardware box fields'},
        {t:'add', d:'HubSpot deal stage advances to Shipped (845719) on Ship It'},
      ]
    },
    {
      v:'1.0.87', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Notifications system — bell icon in Deal Hub, fires on quote accept and payment marked'},
        {t:'add', d:'HubSpot workflow: task on accept → emails rep via internal email notification'},
      ]
    },
    {
      v:'1.0.86', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Merge Deal feature — move all quotes/orders to correct deal, delete wrong deal, merge Drive folders'},
        {t:'add', d:'Merge Legacy folder — import old AllContacts Drive folders into deal structure'},
      ]
    },
    {
      v:'1.0.85', date:'Apr 9, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Deal hub panel load parallelized with Promise.all — 5 independent HubSpot calls fire simultaneously'},
        {t:'fix', d:'Hub panel load time reduced from 5-7s to near-instant'},
      ]
    },
    {
      v:'1.0.84', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Activity Timeline in deal panel — full HubSpot engagement history per deal'},
        {t:'add', d:'Invoice panel in deal hub showing status, payment method, amounts'},
        {t:'add', d:'Orders panel in deal hub showing production/shipped status'},
      ]
    },
    {
      v:'1.0.83', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Create Invoice button per quote in deal hub — creates HubSpot invoice from quote snapshot'},
        {t:'add', d:'Invoice linked to deal and contact in HubSpot'},
        {t:'add', d:'Payment link fetched and stored in DB after invoice creation'},
      ]
    },
    {
      v:'1.0.82', date:'Apr 9, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Deal delete — removes HubSpot deal and all DB quote records'},
        {t:'fix', d:'Stage override in admin panel — single click moves deal to any stage'},
        {t:'fix', d:'Payment status picker — Not Paid / PO Received / Paid with color coding'},
      ]
    },
    {
      v:'1.0.81', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Deal Hub kanban board — Sent/Updated, Verbal, Closed Won, Shipped columns'},
        {t:'add', d:'Right-side hub panel with quotes, pipeline stepper, next action, admin overrides'},
        {t:'add', d:'Auto-filters to logged-in rep deals on load'},
        {t:'add', d:'HubSpot-only deal toggle to hide/show unintegrated deals'},
      ]
    },
    {
      v:'1.0.80', date:'Apr 9, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Share token stored in DB column only — stripped from json_snapshot before save'},
        {t:'fix', d:'getShareToken() prefers _loadedShareToken over _lastShareToken'},
        {t:'fix', d:'Both tokens synced on push, cleared on new quote, server fallback fetch if missing'},
      ]
    },
    {
      v:'1.0.79', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Shareable quote links (/q/:quoteNumber) with token validation'},
        {t:'add', d:'Customer-facing quote accept flow — foam color, hinge, notes captured on accept'},
        {t:'add', d:'Shareable invoice links (/i/:quoteNumber)'},
        {t:'add', d:'Customer-facing order status pages (/o/:quoteNumber)'},
      ]
    },
    {
      v:'1.0.78', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'PDF download for quotes, invoices, orders via Puppeteer'},
        {t:'add', d:'PDF semaphore — only one PDF generates at a time to stay within Railway memory limits'},
        {t:'add', d:'Google Drive auto-upload: quotes to Quotes/, invoices to Invoices/'},
      ]
    },
    {
      v:'1.0.77', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Google Drive integration — service account JWT auth, deal folder creation with subfolders'},
        {t:'add', d:'Subfolders: Quotes, Invoices, Purchase Orders, Drawings & Specs, Shipping, Final Order'},
        {t:'add', d:'Drive folder ID saved to DB, linked to quote record'},
      ]
    },
    {
      v:'1.0.76', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Process Order flow — moves deal to Closed Won, creates order record, sends confirmation email'},
        {t:'add', d:'Foam/hinge no longer required to process order'},
        {t:'add', d:'Changelog uses OAuth session name (window._sessionRepName)'},
      ]
    },
    {
      v:'1.0.75', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'TaxJar sales tax integration — nexus states, freight taxability per state'},
        {t:'add', d:'Tax exempt checkbox per quote'},
        {t:'add', d:'Tax included in HubSpot deal amount and order total'},
      ]
    },
    {
      v:'1.0.74', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'ABF freight rate integration — pallets, weight, accessories (residential, liftgate, limited access)'},
        {t:'add', d:'Freight accessorial preferences saved per customer email'},
        {t:'add', d:'BOOTH_DATA for pallet dims, freight weight = sum of all line item weights'},
      ]
    },
    {
      v:'1.0.73', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'OD tracking via direct REST API (api.odfl.com) — replaces AfterShip for OD shipments'},
        {t:'add', d:'ABF tracking via XML API (abfs.com) — replaces AfterShip for ABF shipments'},
        {t:'add', d:'UPS/FedEx/USPS tracking via Puppeteer scrape'},
        {t:'add', d:'Shipping board — 90-day window of shipped deals with live tracking status'},
      ]
    },
    {
      v:'1.0.59', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Credits tab in price book — 35 credit items from WR_CREDITS list, red CR badge styling'},
        {t:'add', d:'Negative price inputs supported — custom items can have negative prices'},
        {t:'fix', d:'Credits excluded from HubSpot line items — sum applied as hs_discount on invoice'},
      ]
    },
    {
      v:'1.0.58', date:'Apr 9, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'ABF delivered status false positives — now requires DELIVERYDATE in XML, not just status text match'},
        {t:'add', d:'"Arrived at Terminal" label added for shipments at local service center'},
      ]
    },
    {
      v:'1.0.57', date:'Apr 9, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'AfterShip fully removed — all tracking now uses direct carrier APIs'},
        {t:'fix', d:'Hub panel parallelized with Promise.all — 5 HubSpot calls fire simultaneously'},
        {t:'add', d:'fetchAndCacheTracking() seeds cache immediately on Ship It instead of AfterShip'},
      ]
    },
    {
      v:'1.0.56', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'fetchABFTracking() — ABF XML trace API, parses status/dates/signature/destination'},
        {t:'add', d:'fetchABFTransitDays() — ABF transit time API for ETA backfill on shipping board'},
        {t:'add', d:'fetchAndCacheTracking() rewritten — OD REST API, ABF direct XML, UPS/FedEx/USPS Puppeteer'},
        {t:'add', d:'/api/debug/od-tracking — raw OD API debug endpoint'},
        {t:'fix', d:'initTrackingCache — clears bogus same-day delivered_at entries'},
      ]
    },
    {
      v:'1.0.55', date:'Apr 9, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Initial import — full system on Railway: Node.js server, PostgreSQL, HubSpot OAuth'},
        {t:'add', d:'Quote builder with product search, line items, customer fields, HubSpot push'},
        {t:'add', d:'Quote history in DB, contact/deal search, quote numbering by rep'},
        {t:'add', d:'HubSpot 30-day OAuth sessions, DB-backed, products cached with 15min TTL'},
      ]
    },
    ].map(v => `
    <div class="version-block">
      <div class="version-header">
        <div class="version-num">v${v.v}</div>
        <div class="version-date">${v.date}</div>
        <div class="version-tag tag-${v.tag}">${v.tag}</div>
      </div>
      <div class="version-body">
        ${v.changes.map(c => `
          <div class="change-item">
            <span class="change-type ct-${c.t === 'log' ? 'log' : c.t === 'add' ? 'add' : c.t === 'ui' ? 'ui' : c.t === 'security' ? 'security' : 'fix'}">${c.t === 'log' ? 'log' : c.t === 'add' ? 'new' : c.t === 'ui' ? 'ui' : c.t === 'security' ? 'sec' : 'fix'}</span>
            <span>${c.d}</span>
          </div>`).join('')}
      </div>
    </div>`).join('')}
</div>
</body>
</html>`;
};
