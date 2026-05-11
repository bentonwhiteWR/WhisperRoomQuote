# WhisperRoom Quote Builder — Dev Log

Internal development notes. Last updated 2026-05-11.

> **Read this first when starting a session.** The "Current focus" section below is the fastest way to know where we left off. Below that: session writeups, the audit (outstanding work), and the changelog table.

---

## Current focus (2026-05-11)

**Most recent shipped:** v1.9.5 — Deal Hub shows every Closed Won deal regardless of recency. Board fetch filtered to displayed stages + dedicated Closed Won pass. (Previous: v1.9.4 QB invoice delete also deletes linked Payments; v1.9.3 invoice International block; v1.9.2 reconcile uses HS total_tax_amount.)

**Active theme:** Audimute / AP Purchase Order system. Built v1.7.22 → v1.9.0 over May 7–8. Full lifecycle now: create with editable ship-to, edit ship-to/color/notes, delete, change-log audit trail visible on the doc itself. Next-up candidates are user-driven.

**Outstanding work (not yet started):**

- The May 7 audit findings below — none addressed yet. The five "Critical" items are real bugs and should be the next coding focus once the AP system stabilizes. Especially **#1 (public endpoints lack share-token auth)** and **#2 (XSS in server-rendered HTML)** — both are exploitable by anonymous visitors.
- v1.9.5 on staging awaiting test. Prod (main) at v1.9.4.

**Tooling note:** As of 2026-05-08 the user is moving day-to-day editing from Claude Desktop to Cursor. Local clone lives at `C:\Users\bento\Documents\Claude\WhisperRoomQuote-staging`. Workflow stays the same (staging-only, explicit ask to promote to main).

---

## Session writeup — May 7–8, 2026 (v1.7.21 → v1.7.33)

13 versions shipped over two days. Three concurrent threads:

### 1. Audimute / AP Purchase Order system (v1.7.22, .25, .26, .27, .28, .29, .30, .31, .33)

The big build of the session. Started as a "Create Audimute PO" button in the orders dashboard drawer (v1.7.22), got rebuilt and moved to the Deal Hub once the UX shape became clear (v1.7.27). Final shape:

- **Where it lives:** AP badge on each order in the Deal Hub right panel, plus an aggregate AP chip on pipeline deal cards (v1.7.28). Status states: gray "AP !" (not submitted), yellow "AP ⏳" (in flight), green "AP ✓" (delivered) — naming finalized in v1.7.29.
- **PO creation dialog:** triggered from the AP badge. Per-item color picker (defaults to order's AP color), ship-to confirmation, notes field. Each PO is one row per AP item, each with its own color — supports mixed packages and per-package colors (v1.7.27).
- **PO document:** `/po/:poNumber` shows full BOM. Each AP SKU resolves to its panel breakdown (2'x4', 1'x4', 1'x2') and Audimute wholesale cost from `lib/ap-packages.js`. Items table includes per-line color chips, plus a Panel Totals summary block aggregating panels × qty across all items. Pricing uses Audimute wholesale (e.g. AP 9696 = $588), not customer-facing retail (v1.7.30).
- **PO numbering:** `WR{YY}{MM}{DD}{NN}` format (e.g. WR26050801), 2-digit daily counter, Eastern time (v1.7.31).
- **Suppliers dashboard:** `/suppliers` lists all POs with status/expected-ship/tracking, late-order red highlighting, inline editable fields (v1.7.22). Delete button per row added v1.7.33.
- **Detection:** AP detection broadened to match `AP[space|-|_]<digit>` and "Acoustic Package …" across name/productName/sku/description (v1.7.26), so legacy orders with non-strict naming surface correctly.
- **Bug squash:** v1.7.25 fixed AbortController-style search races on folder search, deals search, and quote builder deal search. v1.7.29 fixed a body-parsing bug (request body read as string, never JSON.parse'd) that silently broke three endpoints.

### 2. QuickBooks payment automation (v1.7.23, .24)

- v1.7.23 — manual "Mark as Paid" button in orders admin dropdown. Mirrors the QB Receive Payment screen exactly: PaymentMethod "Hubspot", deposit "Southeast Bank Regular Checking 2545". Pre-fills with current invoice balance. Supports partial payments (click again later for the balance). QB balance check on the drawer shows current state ("Paid in Full" / partial / balance due) — live read from QB.
- v1.7.24 — auto-create QB Payment when an order is processed, for all payment types EXCEPT PO. Same defaults as the manual flow. PO orders stay open until payment actually arrives. Auto-payment failures are logged but don't block invoice creation.

### 3. International orders + misc (v1.7.21, .32)

- v1.7.21 — Freight Cost field on orders dashboard now accepts `$500`, `$1,200.00`, etc. Was `type="number"` so `$`/commas silently invalidated input and nothing transferred to HubSpot.
- v1.7.32 — International quotes get a Country field in the quote builder (appears with the Canadian / International Destination checkbox). Country is stored in the customer snapshot and shown on quote/invoice/order pages. Wire transfer notice ("All international orders must be prepaid in full with bank wire transfer.") appears on those same pages when the international flag is set.

---

## Audit — May 7, 2026 (outstanding work)

Full audit across backend, frontend, and security. Three parallel agents reviewed the codebase. **None of these items have been addressed yet** — they're the next coding focus once the AP system stabilizes.

---

### What Works Well

- **SQL parameterization** — every `db.query()` call uses `$1/$2` placeholders. No string concatenation of user input into SQL.
- **Auth/session basics** — `HttpOnly`, `SameSite=Lax`, 30-day expiry, 32-byte cryptographically random tokens, dual memory+DB cache. QB and HS OAuth state is validated (CSRF guard).
- **QB token refresh** — proactive 5-min buffer before expiry (`lib/quickbooks.js:119`). Clean pattern.
- **Rate limiting + share tokens** — public quote/order/invoice viewer routes are rate-limited (30 req/60s per IP) and gated by share token.
- **Global exception handlers** — `process.on('uncaughtException')` + `unhandledRejection` prevent silent process death.
- **TaxJar error translation** — invalid ZIP/state/city errors become human-readable messages instead of raw API errors.
- **Dark/light theme system** — consistent CSS vars + localStorage persistence across all dashboards.
- **`fetchWithRetry`** in quote-builder — transient-error detection (socket hang-up, ECONNRESET) with configurable delays.
- **Defensive null-coalescing** throughout the HTML frontends — heavy `?.value || default` patterns handle missing DOM safely.

---

### Critical — Fix Soon

**1. Public `/api/accept-quote` and `/api/update-specs` lack proper authorization**
- Both endpoints are in `isPublicRoute` but neither validates the share token against the quoteNumber.
- Any anonymous visitor can flip another customer's quote to accepted, change foam/AP/hinge specs, trigger HubSpot stage moves and rep notifications.
- `quote-server.js:3421`, `:3603`
- Fix: require share-token match before any DB/HS write, same pattern as `/q/:quoteNumber`.

**2. XSS in server-rendered HTML**
- Foam color, AP color, hinge prefs, `repWaType`, and `e.message` concatenated into HTML without escaping.
- Error pages render `e.message` directly into a `<h2>` tag.
- `quote-server.js:2721`, `:3358`, `:2741`, `:3377`
- Fix: route all customer/deal-derived strings through `escHtml()` before string templates; use `textContent` for error messages.

**3. Stale order-modal state snapshot**
- `window._orderModalCanadian` captured once when modal opens. Rep closes/reopens with different checkbox state → old value is submitted.
- `quote-builder.html:6948`
- Fix: read the live DOM checkbox at submit time, not a snapshot.

**4. QB invoice orphan on partial failure**
- `qb.createInvoice()` succeeds but `UPDATE orders SET order_data` fails → QB invoice exists with no order record linkage. No way to safely retry; reconcile won't match it.
- `quote-server.js:8288–8320`
- Fix: write an idempotency key first or wrap in a try that detects the existing invoice by DocNumber before recreating.

**5. HubSpot line-item sync desync**
- `hsClearDealLineItems()` runs, then items are re-created in a loop. If item 3 of 8 fails, the deal has 5 ghosts and 3 missing — yet it's already Closed Won. No rollback.
- `quote-server.js:7869–7918`
- Fix: use HS batch endpoint or stage new items before deleting old.

---

### High Impact

**6. No idempotency on process-order side effects**
- PDF→Drive, AP task, QB invoice — all fire once. Browser hiccup + retry = duplicate invoices/tasks/PDFs.
- Assign a UUID at quote-accept time; persist "completed steps" to skip on retry.

**7. Missing timeouts on QB/HubSpot HTTP calls**
- Default Node.js socket timeout is 120s. Slow upstream requests pile up.
- `lib/quickbooks.js:139`, `lib/hubspot.js:48`
- Fix: `timeout: 30000` + Promise.race on all external calls.

**8. No retry on 429 rate-limit responses**
- QB and HubSpot both rate-limit. Currently a single attempt; heavy-load days produce phantom failures.
- Fix: parse `Retry-After` header, exponential backoff, max 3 attempts.

**9. Missing rate limiting on `/api/accept-quote` and `/api/update-specs`**
- Even after auth fixes, these need 5–10 req/min per IP.

**10. Tax-exempt checkbox has no confirmation guard**
- One misclick silently removes the tax warning and sends an untaxed order.
- `quote-builder.html:3131`
- Fix: require confirmation or a "Why exempt?" dropdown.

**11. Direct-object-reference on deal endpoints**
- Any authenticated rep can read any deal's invoices, stage, etc. No rep-ownership check.
- Acceptable if all reps are equal-trust; revisit if isolation is ever needed.

**12. `checkForDuplicates()` failure swallowed**
- If HubSpot is down, the catch logs a warning and continues → duplicate contacts created.
- `quote-builder.html:3298`

---

### Medium — Refactoring Opportunities

**13. Monolithic `quote-server.js` (~8400 lines)**
- `/api/process-order` alone is 700+ lines of tangled QB/HS/DB logic.
- Extract `lib/order-processor.js` with testable stages: stage deal → create QB invoice → save DB → sync HS line items → send emails.

**14. Massive duplication across HTML files**
- `toggleTheme()`, `fmt()`, `showToast()` reimplemented in every page.
- Extract to `/static/_shared.js` and `/static/_theme.css`.

**15. QB OAuth state warning-not-fail**
- After server restart, missing OAuth state is logged but the flow continues. Opens CSRF window.
- `lib/quickbooks.js:413`
- Fix: hard-fail; user re-initiates.

**16. HubSpot 401 returns silently**
- `lib/hubspot.js:31` returns on 401 without throwing — callers don't know token is expired.
- Fix: throw on 401.

**17. Mailto: link length**
- `deals-dashboard.html:2012` builds 2K+ char URLs; some clients cap at 2048 bytes.
- Switch to copy-to-clipboard or server-rendered draft.

**18. Reconcile table sort is DOM-only**
- Clicking column headers sorts the DOM but not `_allRows`. Page re-render re-sorts by original key.
- `reconcile.html:425`

---

### Low Priority

- **Logging may leak PII** — full QB invoice payload (customer email, address) logged on error (`quote-server.js:382`). Redact before log.
- **No DB pool drain on SIGTERM** — register `process.on('SIGTERM', () => db.end())` for clean Railway redeploys.
- **`bakeInDiscount()` is one-way** — no undo; stash pre-bake values.
- **Memory leak in product search** — inline onclicks accumulate across searches (`quote-builder.html:2942`). Switch to event delegation.
- **Tracking `.catch(() => {})` fire-and-forget** — stale ETA forever if tracking update fails. Consider a periodic backfill.
- **localStorage cache has no schema version** — silent parse breakage if API shape changes.
- **Drag-and-drop row highlights stick** — two consecutive drags leave both rows visually selected (`quote-builder.html:2244`).
- **Discount bake-in is one-way** — no way to unbake without manually editing each line item.

---

## Changelog Reference

Source of truth for in-app changelog is `templates/changelog.js`. This table is the dev-side mirror — one row per version, terse.

| Version | Date       | Summary |
|---------|------------|---------|
| 1.9.5   | 2026-05-11 | Deal Hub always shows every Closed Won (dedicated no-recency-cap pass) + main fetch filtered to board stages + client limit 200→500 |
| 1.9.4   | 2026-05-11 | QB invoice delete now also deletes linked QB Payment(s); new lib helpers `qb.getPayment` + `qb.deletePayment` |
| 1.9.3   | 2026-05-08 | Invoice page renders the International / Canadian Order block (wire-transfer notice + customs broker), mirroring the quote |
| 1.9.2   | 2026-05-08 | Reconcile prefers HubSpot `total_tax_amount` over reverse-calc from `tax_rate` |
| 1.9.1   | 2026-05-08 | Ship-time freight writes only to `actual_freight_cost`; stop clobbering the quoted `freight_cost` (Freight + Install) field |
| 1.9.0   | 2026-05-08 | PO Change Log on document (every edit logged with who/when/what); fix: DATE column save bug (pg type parser); fix: Ship-To override on PO create now persists |
| 1.8.0   | 2026-05-08 | Audimute POs editable: ship-to verify-on-create, ship-to / per-item color / notes editable on existing POs, status-aware guards (complete = locked) |
| 1.7.33  | 2026-05-08 | Delete button for Audimute POs on Suppliers dashboard |
| 1.7.32  | 2026-05-08 | Country field for international quotes + wire transfer notice |
| 1.7.31  | 2026-05-08 | Compact PO number format `WR{YY}{MM}{DD}{NN}`, daily counter, Eastern time |
| 1.7.30  | 2026-05-07 | AP PO uses BOM mapping (panel breakdown + Audimute wholesale cost), Panel Totals summary |
| 1.7.29  | 2026-05-07 | Fix PO body-parsing bug, ship-to lookup uses snapshot customer, AP chip naming |
| 1.7.28  | 2026-05-07 | AP chip on pipeline deal cards (aggregate) and per-quote rows in deal hub |
| 1.7.27  | 2026-05-07 | AP/Audimute PO management moved to Deal Hub badge with per-line-item colors |
| 1.7.26  | 2026-05-07 | Broaden AP detection (AP-9696, AP_9696, "Acoustic Package …") across UI + server |
| 1.7.25  | 2026-05-07 | AbortController on folder/deal/quote-builder searches; remove duplicate input listener |
| 1.7.24  | 2026-05-07 | Auto-create QB Payment on order processing (all types except PO) |
| 1.7.23  | 2026-05-07 | "Mark as Paid" button in orders admin → creates QB Payment, supports partials, balance badge |
| 1.7.22  | 2026-05-07 | Audimute AP PO system foundation: Create PO, /po/:poNumber doc, /suppliers dashboard, mailto draft |
| 1.7.21  | 2026-05-07 | Freight Cost field accepts `$`/commas (was type="number" silently rejecting) |
| 1.7.20  | 2026-05-07 | Dev log created; "Create QB Invoice" button in orders admin dropdown |
| 1.7.19  | 2026-05-07 | Write freight cost to QB invoice `PrivateNote` on ship |
| 1.7.18  | 2026-05-07 | QB Invoices first tab on Accounting page; search box with "Search All" |
| 1.7.17  | 2026-05-07 | "Accounting" link added to Quote Builder top nav |
| 1.7.16  | 2026-05-07 | Search box on Accounts Receivable tab |
| 1.7.15  | 2026-05-07 | Finance charge memo hardcoded on all QB invoices |
| 1.7.14  | 2026-05-07 | Bill To Name + Email on QB invoice |
| 1.7.13  | 2026-05-07 | `ApplyTaxAfterDiscount: true` — QB tax aligns with TaxJar |
| 1.7.12  | 2026-05-07 | Billing address actually transfers to QB (both clients fixed) |
| 1.7.11  | 2026-05-07 | Reverted TxnTaxDetail approach; retained billing fix |
| 1.7.10  | 2026-05-07 | Removed invalid `Override`/`TotalTax` QB fields |
| 1.7.9   | 2026-05-07 | QB billing address reads separate billing object (server-side) |
