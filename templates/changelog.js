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
      v:'1.7.30', date:'May 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Audimute PO document overhauled with full BOM. Each AP SKU now resolves to its panel breakdown (2\'x4\', 1\'x4\', 1\'x2\') and Audimute wholesale cost from a single source-of-truth mapping (lib/ap-packages.js). Items table is now QTY | ITEM | DESCRIPTION | COLOR | UNIT COST | TOTAL — description shows "Includes: N - 2\'x4\' panels. N - 1\'x2\' panels." plus "N total WhisperRoom Velcro Hang Tab Packs" per item.'},
        {t:'add', d:'Panel Totals summary block below the items table aggregates panel counts × qty across all line items: shows total 2\'x4\', 1\'x4\', 1\'x2\' panels needed, plus a grand total of WhisperRoom Velcro Hang Tab Packs (1 per panel). This is the pull list Audimute fulfills against.'},
        {t:'fix', d:'PO pricing now uses Audimute wholesale cost (e.g. AP 9696 = $588) instead of the customer-facing retail price from the snapshot. Set at PO creation time so each PO is self-contained. Falls back to the snapshot price only if the SKU isn\'t in the mapping.'},
        {t:'ui',  d:'Removed the "From" (WhisperRoom) block from the PO. Vendor block updated to: Audimute / Attn: Elizabeth Wade / 23700 Aurora Road / Bedford Heights, Ohio 44146 / (216) 591-1891 x320 / ewade@audimute.com. Parties row is now 2-column (Vendor + Ship To).'},
        {t:'ui',  d:'Items missing a color show "— TBD —" in red on the PO so it\'s obvious what still needs an answer before sending.'},
      ]
    },
    {
      v:'1.7.29', date:'May 7, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'"Create Audimute PO" was failing with "quoteNumber required" because the request body was being read as a string and never JSON.parse\'d. Same bug existed silently on the supplier-pos PATCH endpoint (status/tracking updates from the Suppliers board) and the orders mark-paid endpoint (custom amount/date/method overrides were ignored). All three now JSON.parse the body correctly.'},
        {t:'fix', d:'AP PO dialog was always showing "no shipping address on file" because it was reading the deal\'s HubSpot contact instead of the order\'s snapshot customer (which has the actual ship-to). The hub endpoint now returns the snapshot customer per order and the dialog uses it first, falling back to the deal contact only if the snapshot is empty.'},
        {t:'ui',  d:'Renamed AP chip states for clarity: "AP !" red = not submitted (was gray), "AP ⏳" yellow = PO in flight, "AP ✓" green = delivered. Quote-row chip stays a neutral orange since it\'s a presence indicator only (PO state lives on the order). Same scheme on pipeline deal cards and order cards in the deal hub.'},
      ]
    },
    {
      v:'1.7.28', date:'May 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'AP chip now appears on the deal card itself in the pipeline (alongside RM and CUST), with status-aware coloring: gray "AP" = no PO yet, yellow "AP ⏳" = at least one Audimute PO in flight, green "AP ✓" = all PO orders delivered. Aggregate is computed across every quote+order on the deal so you can see Audimute status at a glance from the kanban board.'},
        {t:'add', d:'AP chip also appears on each quote row inside the deal hub right panel — flagged on whichever specific quote(s) include AP line items.'},
        {t:'log', d:'/api/deals/list now returns hasAP and apStatus per deal (single LATERAL-style supplier_pos lookup batched for the whole page); /api/deals/:id/hub returns hasAP per quote.'},
      ]
    },
    {
      v:'1.7.27', date:'May 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Audimute PO management moved to the Deal Hub. Each order in the deal hub right panel now shows an "AP" badge if the order contains acoustic-package line items. Three states: gray (no PO yet — click to create), yellow ⏳ (PO submitted to Audimute, in flight), green ✓ (delivered). Status flips to green when the Suppliers board status is set to "complete".'},
        {t:'add', d:'New Create Audimute PO dialog. Triggered from the AP badge click. Lists every AP line item from the order with its quantity, plus a per-item color picker (defaults to the order\'s AP color). Ship-to is shown for confirmation. Notes field for anything Elizabeth needs. Each PO is created with one entry per AP item, each carrying its own color — supports orders with mixed packages or different colors per package.'},
        {t:'add', d:'PO document (/po/:poNumber) now displays the chosen color per line item as an inline chip in the items table, replacing the single-color "Acoustic Package Specifications" block. Existing legacy POs (pre-1.7.27) still render with the old global color for backward compatibility.'},
        {t:'fix', d:'Removed the AP Purchase Order section from the Orders dashboard drawer entirely — it was crowding the production-focused view and the new deal-hub badge is a much cleaner home. The badge handles create / view / status all in one place.'},
        {t:'log', d:'Deal hub /api/deals/:id/hub endpoint now returns apItems[], apColor, and po (latest supplier PO row) per order in a single query (LATERAL join), so the badge has everything it needs without an extra round trip.'},
      ]
    },
    {
      v:'1.7.26', date:'May 7, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'AP Purchase Order section now appears in the orders drawer when an order has an AP color set, even if the line item naming doesn\'t match the strict "AP 4848" pattern. Previously it required line items beginning with "AP " (space) — orders with names like "AP-4848", "AP4848", or "Acoustic Package …", or older orders with no json_snapshot, never showed the section even though they were AP orders.'},
        {t:'fix', d:'Server-side AP detection (POST /api/supplier-pos) broadened to match "AP[space|-|_]<digit>" and "Acoustic Package …" across name/productName/sku/description, so the PO creation step accepts the same orders the UI surfaces.'},
        {t:'log', d:'Added a console.debug "[AP detect]" line on drawer open showing snapshot/line-item state — makes it easy to diagnose why the AP section did/didn\'t appear for a given order.'},
      ]
    },
    {
      v:'1.7.25', date:'May 7, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Folder search race condition — when typing quickly in the "Rebind Drive Folder" or "Merge Legacy Folder" search boxes, a slow earlier request could return after a newer one and overwrite results with stale data, making results appear wrong or disappear. Fixed with AbortController: each new search cancels any in-flight request before firing. Also cancels pending searches when the modal is opened/reopened.'},
        {t:'fix', d:'"Merge Legacy Folder" modal now auto-runs the search immediately when it opens, since the search box is pre-populated with the deal name. Previously the user had to delete a character or click Search to trigger anything.'},
        {t:'fix', d:'Deals board search ("searchAllDeals") had the same stale-result race condition — rapidly typed queries could render out-of-order results. Fixed with AbortController.'},
        {t:'fix', d:'Quote builder deal search had a duplicate event listener — one from the HTML oninput attribute and one from addEventListener — causing two immediate API calls plus a debounced one on every keystroke. Removed the duplicate, leaving only the debounced listener.'},
        {t:'fix', d:'Added autocomplete="off" and spellcheck="false" to both Drive folder search inputs to prevent browser autocomplete from filling values silently (without triggering oninput).'},
      ]
    },
    {
      v:'1.7.24', date:'May 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Auto-create QB Payment when an order is processed, for all payment types EXCEPT PO. Runs immediately after the QB invoice is created using the same defaults as the manual Mark Paid flow (PaymentMethod "Hubspot", deposit "Southeast Bank Regular Checking 2545"). PO orders stay open until payment actually arrives — those can still be marked paid manually from the orders drawer. Auto-payment failures are logged but don\'t block invoice creation.'},
      ]
    },
    {
      v:'1.7.23', date:'May 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'"Mark as Paid" button in the Orders admin dropdown — creates a QB Payment record applied to the linked invoice. Mirrors the QB "Receive Payment" screen exactly: payment method "Hubspot", deposit to "Southeast Bank Regular Checking 2545", payment date today. All three values can be overridden in the dialog. Amount pre-filled with current invoice balance and accepts $/comma formatting. Supports partial payments — click again to record the balance later. Dialog defaults configurable via QB_PAYMENT_METHOD_NAME / QB_DEPOSIT_ACCOUNT_NAME env vars.'},
        {t:'add', d:'QB balance check on the orders drawer — when a QB invoice is linked, the admin section shows current balance ("Paid in Full" green badge, partial paid breakdown, or balance due in amber). Live read from QB so it reflects payments entered manually in QB too.'},
      ]
    },
    {
      v:'1.7.22', date:'May 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Audimute Purchase Order system — the foundation for supplier management. Orders with AP items now show a "Create Audimute PO" button in the admin dropdown. Creates a clean, branded PO document at /po/:poNumber with a shareable link, including ship-to (customer address), AP line items, AP color, and reference number.'},
        {t:'add', d:'Suppliers dashboard at /suppliers — tracks all Audimute POs in a table with status (pending → sent → confirmed → shipped → complete), expected ship date, tracking number, and late-order highlighting (red row when expected ship date has passed). Inline editable ship date and tracking fields with Save button.'},
        {t:'add', d:'Send PO email — one-click opens a pre-filled mailto: draft to ewade@audimute.com with PO link, ship-to address, item list, and AP color. Automatically marks PO as sent.'},
        {t:'add', d:'"Suppliers" nav link added to all dashboard pages (Quotes, Orders, Shipping, Reports, Accounting, Deal Hub).'},
      ]
    },
    {
      v:'1.7.21', date:'May 7, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Freight Cost field on the orders dashboard now accepts "$500", "$1,200.00", "500", etc. Previously the field was type="number" so any "$" or comma silently invalidated the input and nothing transferred to HubSpot. Switched to type="text" with a parseFreightCost() helper that strips $/commas/whitespace before parsing.'},
      ]
    },
    {
      v:'1.7.20', date:'May 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'"Create QB Invoice" button in the Orders admin dropdown. Reads line items, freight, discount, tax, customer, and billing from the stored quote snapshot and creates a QB invoice using the same logic as process-order. Shows existing QB invoice link (with overwrite warning) if one is already linked. Works for orders where process-order QB step failed or where details changed.'},
        {t:'add', d:'DEVLOG.md — full audit of backend, frontend, and security written to the repo. Covers what works well, improvement areas, and critical issues.'},
      ]
    },
    {
      v:'1.7.19', date:'May 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'When an order is marked shipped, the QB invoice "Memo on statement (hidden)" field (PrivateNote) is now populated with "Freight Cost: $XXX.XX" alongside the existing carrier, tracking, ship date, and serial number updates. Internal-only — does not appear on the customer-facing invoice.'},
      ]
    },
    {
      v:'1.7.18', date:'May 7, 2026', tag:'ui',
      changes:[
        {t:'ui',  d:'QB Invoices is now the first tab on the Accounting page and auto-loads the last 90 days when you open the page.'},
        {t:'add', d:'Search box on the QB Invoices tab. Filters the loaded invoices by customer name, doc number, or bill email as you type. Press Enter (or click "Search All") to fetch all invoices across all time — no date filter — then type to narrow results.'},
        {t:'fix', d:'Server endpoint /api/qb/invoices now accepts no date params to return all invoices; credit/refund fetches are skipped in the all-time path.'},
      ]
    },
    {
      v:'1.7.17', date:'May 7, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'Quote Builder top nav now includes "Accounting" link, matching the Deal Hub and other dashboards.'},
      ]
    },
    {
      v:'1.7.16', date:'May 7, 2026', tag:'ui',
      changes:[
        {t:'add', d:'Search box on the Accounts Receivable tab. Filters the visible rows by company name or doc number as you type (case-insensitive substring match). Works in combination with the existing aging-bucket filter — search applies on top of whichever bucket is selected. Aging summary boxes still reflect the full open-invoice picture.'},
      ]
    },
    {
      v:'1.7.15', date:'May 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'QB invoice "Note to customer" (CustomerMemo) is now hardcoded to: "Finance charges of 1.5% per month will be added to invoices not paid by the due date." Previously the field carried the deal name, which was redundant with the invoice number and customer company already on the invoice.'},
      ]
    },
    {
      v:'1.7.14', date:'May 7, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'QB invoice Bill To section now includes the rep-entered Bill To Name (in BillAddr.Line1, with the street address shifted to Line2) and the Bill To Email (on BillEmail.Address, falling back to the customer\'s primary email when no separate billing email was entered).'},
      ]
    },
    {
      v:'1.7.13', date:'May 7, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'QB invoices now default to "apply discount before sales tax" automatically. Sets ApplyTaxAfterDiscount: true on every invoice we create via the API, so the More Options toggle in QB starts in the correct state without needing to flip it manually each time. Result: taxable subtotal = post-discount, matching TaxJar exactly.'},
      ]
    },
    {
      v:'1.7.12', date:'May 7, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Billing address now actually transfers to the QB invoice. The server-side fix from v1.7.9 was reading body.billing, but neither the quote builder\'s confirmProcessOrder nor the deal hub\'s confirmProcessOrderFromHub was sending it — only the customer (ship-to) object. Both clients now include the billing object in the process-order POST: quote builder pulls from the live #bill* form fields (null when "Same as ship-to" is checked), and the deal hub passes through snap.billing from the loaded snapshot.'},
      ]
    },
    {
      v:'1.7.11', date:'May 7, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Reverted the TxnTaxDetail QB tax override introduced in v1.7.9–v1.7.10. The root cause of the tax/discount mismatch was a QB Online setting ("apply tax before/after discount") rather than a code issue. With that setting flipped to post-discount and AST re-enabled, QB AST naturally taxes the correct base — no API override required. The billing address fix from v1.7.9 (using the rep\'s separate billing object instead of always copying the ship address) is retained.'},
      ]
    },
    {
      v:'1.7.10', date:'May 7, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'QB invoice creation was returning a 2010 "failed to parse json object" error after v1.7.9 enabled the tax override. Cause: the TaxLineDetail.Override field and top-level TxnTaxDetail.TotalTax field appear in some QB SDK samples but are not valid JSON request properties — QB rejected the entire payload. Removed both. The remaining structure (TxnTaxCodeRef + TaxLine with explicit Amount, TaxPercent, NetAmountTaxable, TaxRateRef) is the documented non-AST override path. Requires QB Online with Automated Sales Tax disabled.'},
      ]
    },
    {
      v:'1.7.9', date:'May 7, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'QB invoice tax now matches the quote exactly. QB Online\'s Automated Sales Tax was taxing the gross subtotal (pre-discount), while TaxJar taxes the net (post-discount) — the legally correct base. Result: QB invoices were over-collecting tax by (rate × discount). Fix uses QB\'s per-invoice override flag (TxnTaxDetail.TaxLineDetail.Override:true) to force the TaxJar amount through, leaving AST enabled for everything else. AST keeps tracking liability normally; only the displayed tax dollar amount is overridden.'},
        {t:'fix', d:'QB invoice billing address now uses the rep\'s separate billing address when present, instead of always copying the shipping address. Previously the process-order route never read the billing object from the request body, so QB always saw ship-to in the Bill To field.'},
      ]
    },
    {
      v:'1.7.8', date:'May 7, 2026', tag:'security',
      changes:[
        {t:'security', d:'QB invoice deletion gating switched from HubSpot ownerId to login email. Allowed by default: bentonwhite@whisperroom.com and accounting@whisperroom.com. The previous ownerId allowlist (36303670 / 38732178) wasn\'t matching the accounting@ login. Override env var renamed: QB_INVOICE_DELETE_OWNERS → QB_INVOICE_DELETE_EMAILS (comma-separated, case-insensitive).'},
      ]
    },
    {
      v:'1.7.7', date:'May 7, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Deal Hub Process Order modal now pre-fills foam color, door hinge, AP color, and WA type from the rep\'s saved selections (with fallback to customer-accepted values) — matching the quote builder. Previously the snapshot endpoint stripped out the rep fields, so the modal opened blank even when those values had been chosen at quote time.'},
      ]
    },
    {
      v:'1.7.6', date:'May 7, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'WA Type selector now appears in the Deal Hub Process Order modal when the order contains a WA UPG or ADA item — matching the quote builder behavior. The selector pre-populates from the snapshot\'s saved WA type (if any) and lets the rep override it before sending. Both the deal hub and quote builder now behave consistently.'},
      ]
    },
    {
      v:'1.7.5', date:'May 7, 2026', tag:'security',
      changes:[
        {t:'security', d:'QB invoice deletion is now restricted to Benton + Kim only (by HubSpot ownerId). Server returns 403 for other users; the Delete button is hidden in the UI for everyone else. Successful deletions are logged with user, invoice #, customer, and total. Override the allowlist with QB_INVOICE_DELETE_OWNERS env var (comma-separated ownerIds). Note: requires HubSpot OAuth login — password-only sessions cannot delete.'},
      ]
    },
    {
      v:'1.7.4', date:'May 7, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'Top-nav "Reconcile" link renamed to "Accounting" — the page now hosts Reconcile, QB Invoices, and AR sub-tabs. Page title and header subtitle updated to match.'},
      ]
    },
    {
      v:'1.7.3', date:'May 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Reconciler → Accounts Receivable tab. Shows all open (unpaid) QB invoices with aging summary boxes (Current / 1–30 / 31–60 / 61–90 / 90+ days late) — counts and dollar totals per bucket. Filterable by bucket, sorted oldest-due first.'},
        {t:'add', d:'QB Invoices tab now shows Terms (Net 30, Due on receipt) and a smart Status column ("Paid", "Due in Nd", "N days late") color-coded green/gray/amber/red.'},
        {t:'add', d:'Status filter on QB Invoices tab: All / Paid / Open / Due Soon (≤7d) / Overdue.'},
        {t:'add', d:'Per-row Delete button on both QB Invoices and AR tabs — opens a confirmation modal showing customer + total before permanently deleting from QuickBooks. Also clears the qbInvoiceId from the linked local order if any.'},
      ]
    },
    {
      v:'1.7.2', date:'May 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Reconciler: new "QB Invoices" tab shows all QB invoices in a date range (defaults to last 90 days), with Paid/Open status badges and a direct "Open in QB" link to pull up each invoice in QuickBooks Online.'},
        {t:'fix', d:'Deal Hub now loads up to 1,000 deals by default (was capped at 200) using cursor-based HubSpot pagination.'},
      ]
    },
    {
      v:'1.7.1', date:'May 7, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'QB Custom Field DefinitionIds were swapped — P.O. Number was writing to the Serial Number field and vice versa. Corrected: DefinitionId 1 = P.O. Number, 3 = Serial Number.'},
        {t:'add', d:'QB invoice now sets payment terms automatically: PO orders use Net 30, all other payment types use Due on receipt. Term names are configurable via QB_TERM_NET30 / QB_TERM_UPON_RECEIPT env vars.'},
      ]
    },
    {
      v:'1.7.0', date:'May 7, 2026', tag:'feature',
      changes:[
        {t:'add', d:'QuickBooks invoice is now auto-created when an order is processed. Line items are matched to QB items by exact name (falls back to a generic "Product" item). Freight uses QB\'s dedicated Shipping totals row via the SHIPPING_ITEM_ID magic value — not a line item. Discount is excluded from freight. Sales tax handled by QB\'s Automated Sales Tax / TaxJar using the ship-to address.'},
        {t:'add', d:'QB invoice is updated automatically when Jeromy ships an order — carrier populates ShipMethodRef, tracking number populates TrackingNum, ship date populates ShipDate, and serial number fills Custom Field "Serial Number".'},
        {t:'add', d:'QB invoice now carries Sales Rep (Custom Field), P.O. Number (Custom Field, when payment type is PO), and BillEmail from the order.'},
        {t:'fix', d:'QB customer DisplayName now defaults to company name when present (B2B), falling back to person name. Previously only the individual\'s name was used.'},
        {t:'fix', d:'Freight taxability on QB invoice now follows WR\'s own TaxJar calculation (freightTaxed flag) — prevents QB from adding freight tax in states where WR didn\'t charge it.'},
        {t:'add', d:'WA Type selector added to the Process Order modal (auto-populated from quote, dynamic options from line items). WA Type also shown in the Orders dashboard right-side drawer.'},
        {t:'fix', d:'Submit overlay text unreadable in light mode — title and message text now use correct theme variables.'},
      ]
    },
    {
      v:'1.6.4', date:'May 6, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'New quotes on existing deals now always get a fresh quote number. Previously, linking a deal made the system treat any new quote as an in-place revision — silently reusing the prior quote number even when prices/discount/freight differed. Revision-mode is now triggered only when a rep explicitly loads a historical quote to update.'},
        {t:'fix', d:'Folder picker now opens for every new quote, even when the contact has a prior Drive folder. The existing folder is offered as a one-click option but is no longer auto-bound. Files for new deals on returning customers no longer silently land in the old folder.'},
      ]
    },
    {
      v:'1.3.3', date:'Apr 21, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Payment type now reliably included in the mailto email after order processing — replaced inline IIFE with a pre-computed variable to avoid potential closure evaluation issues.'},
      ]
    },
    {
      v:'1.3.2', date:'Apr 21, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'Orders dashboard: Delete Order moved inside a collapsed "Admin Override" drawer to prevent accidental clicks.'},
      ]
    },
    {
      v:'1.3.1', date:'Apr 21, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Payment type now included in the mailto email that opens after order processing (was only added to the server-side HubSpot note, not the mail client template).'},
      ]
    },
    {
      v:'1.3.0', date:'Apr 21, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Payment type now visible on order PDF and order link for all orders, including those processed before v1.2.9 — falls back to a live HubSpot deal lookup when not stored locally.'},
      ]
    },
    {
      v:'1.2.9', date:'Apr 21, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Payment type now shown in order processed email (after total weight) and on the order PDF / order link totals section; PO number included when payment type is PO.'},
      ]
    },
    {
      v:'1.2.8', date:'Apr 20, 2026', tag:'ui',
      changes:[
        {t:'ui', d:'Pickup Fee redesigned as a green checkbox with always-visible $ input; removed "(empty)" label text.'},
      ]
    },
    {
      v:'1.2.7', date:'Apr 20, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Pickup Fee button added to freight section — overrides freight with a non-taxable pickup amount; shows as "Pickup Fee" on quote, invoice, and order PDFs.'},
      ]
    },
    {
      v:'1.2.6', date:'Apr 20, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Bill To Name field added to quote builder (above billing email); appears on quote, invoice, and order PDFs, and syncs to HubSpot bill_to_name property.'},
      ]
    },
    {
      v:'1.2.5', date:'Apr 20, 2026', tag:'feature',
      changes:[
        {t:'add', d:'Ecommerce added to rep dropdown; deals with "Shopify" in the name auto-assign to Ecommerce when linked.'},
      ]
    },
    {
      v:'1.2.4', date:'Apr 20, 2026', tag:'fix',
      changes:[
        {t:'fix', d:'Corrected pallet dimensions for MDL 9696 E and Drum Booth: two pallets at 90×52×45 and one at 102×52×45.'},
      ]
    },
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
