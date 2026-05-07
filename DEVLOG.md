# WhisperRoom Quote Builder — Dev Log

Internal development notes. Last updated 2026-05-07.

---

## Audit — May 7, 2026

Full audit across backend, frontend, and security. Three parallel agents reviewed the codebase.

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

| Version | Date       | Summary |
|---------|------------|---------|
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
