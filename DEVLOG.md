# WhisperRoom Quote Builder — Dev Log

Internal development notes. Last updated 2026-05-12.

> **Read this first when starting a session.** The "Current focus" section below is the fastest way to know where we left off. Below that: session writeups, the audit (outstanding work), and the changelog table.

---

## Current focus (2026-05-13, end-of-day handoff — Stripe Option A on staging)

**Most recent shipped to PROD:** v1.19.19 — tax-not-calculated popup fix (only warns when Calculate Tax was genuinely never run; no longer fires for legitimate no-nexus $0 results). Pushed direct to main today without bringing Stripe along.

**On STAGING (NOT YET promoted to main):** v1.20.0 → v1.20.2 — Stripe Invoice integration, Option A. Today's progression:

- **v1.20.0** — first cut. `lib/stripe.js` new module. `/api/create-invoice` creates Stripe Invoice alongside HubSpot's. `/i/:quoteNumber` Pay Now prefers Stripe `hosted_invoice_url`. Webhook handler with signature verification. Canadian orders skipped. Stripe state on `json_snapshot.stripe` (no schema migration). Hard-locked to `sk_test_` keys.
- **v1.20.1** — fixed two bugs found on first test: (1) Stripe `/v1/invoiceitems` rejected `price_data.product_data` (that's a Checkout Sessions field, not Invoice Items). Switched to simpler `amount` + `description` (qty pre-multiplied into cents; qty prefix baked into description so customer still sees "2 × Foo"). (2) `customer.email` was missing on `/api/create-invoice` body — added cascading fallback: body → `json_snapshot.customer.email` → HubSpot contact lookup via `resolvedContactId`. `emailSource` logged in success meta.
- **v1.20.2** — toggle + $0 safety. (1) New ON/OFF toggle pill in `/admin-log` topbar, backed by `kv_store.stripe_enabled`. When OFF, BOTH new invoice creation AND existing invoice page Pay Now fall back to HubSpot. Webhook still processes events. Endpoints: `GET/POST /api/stripe-toggle`. 10s memory cache. (2) `$0-total guard` — Stripe finalizes $0 invoices as immediately PAID, which is what produced today's "already paid" report. Now if `invoiceLineItems` positives sum to ≤$0, skip Stripe creation with a `stripe.invoice.skipped` log including line counts. (3) Diagnostics: `stripe.invoice.created` meta now carries `lineItemCount`, `positiveItemCount`, `previewTotalCents`, `emailSource`.

**Stripe diagnostic endpoints** (kept from May 12): `/api/debug/stripe-diagnostic` + `/api/debug/stripe-cleanup` — useful for one-off testing outside the rep flow.

**Pre-flight checklist before next test session:**
1. `STRIPE_WEBHOOK_SECRET` set in Railway test service. Stripe dashboard → test mode → Developers → Webhooks → endpoint at `https://test-sales-portal-production.up.railway.app/api/stripe/webhook` → events `invoice.paid`, `invoice.payment_failed`, `invoice.voided` → copy `whsec_...` into Railway. (Status as of EOD May 13: **unknown — verify**. If unset, webhook acknowledges 200 but doesn't process; you'll see `stripe.webhook.unconfigured` in `/admin-log`.)
2. `STRIPE_SECRET_KEY` set to `sk_test_...` in Railway test service. DEVLOG note from May 12 says it was set; if Stripe block silently no-ops, this is the first thing to check.

**Smoke test recipe for next session:**
1. Open `/admin-log` on staging — confirm "Stripe: ON" pill in topbar (right side). Click to flip OFF and back to ON to confirm the toggle round-trips. Watch for `stripe.toggle` log entries.
2. Build a real quote with: positive line items totaling >$0, a US customer with email, and click Create Invoice from Deal Hub.
3. Watch `/admin-log` for `stripe.invoice.created` (success path) or `stripe.invoice.skipped` (with reason in message) or `error.stripe.invoice` (Stripe API error). Click the meta to see `lineItemCount` / `positiveItemCount` / `previewTotalCents` / `emailSource`.
4. Open `/i/:quoteNumber?t=...` — Pay Now should open Stripe's hosted invoice (NOT HubSpot's). If it opens HubSpot, check whether snapshot has `stripe` field (DB query against `quotes.json_snapshot`).
5. Pay with `4242 4242 4242 4242`, any future expiry, any CVC. Watch `/admin-log` for `stripe.invoice-paid`. Check rep notification badge appears (top of dashboards).
6. Flip toggle OFF. Open the SAME paid invoice URL — Pay Now should fall back to HubSpot. (It says "Pay" but HubSpot will say already-paid since you just paid Stripe; that's a known cross-system inconsistency to live with during parallel.)
7. Flip toggle back ON. Run a Canadian quote → `stripe.invoice.skipped` with Canadian/wire reason.

**Open questions / things to investigate next session:**
- The "already paid $0 invoice" symptom from today should be fixed by v1.20.2's guard — but worth tracing WHY a quote ended up with $0 total. Likely freight-only or pickup-only quote (no product lines). The `stripe.invoice.skipped` meta will now show `lineItemCount` so we can confirm.
- Verify `STRIPE_WEBHOOK_SECRET` is set. If you trigger a real test payment and `/admin-log` shows no `stripe.invoice-paid` event, the secret is the first suspect.
- Cross-system "paid" state: when a Stripe invoice gets paid, HubSpot's invoice for the same quote stays "unpaid" because we don't sync the state back. Need a follow-up: on `invoice.paid` webhook, also patch HubSpot's invoice to `paid` (or mark deal stage). Not urgent during observation, but list as follow-up.
- Quote loaded from history may not refresh `body.customer.email` cleanly — investigate the client path (probably quote-builder.html `loadFromHistoryEntry`) if email-fallback log meta keeps showing `emailSource: snapshot` or `hubspot-contact` instead of `body`. Not blocking but worth tightening.

**Roll-forward path when comfortable:** staging→main merge via `/promote` will bring v1.19.18 (light-mode polish) + v1.20.0/1/2 (Stripe) to prod in one commit. Don't promote yet — let Stripe simmer on staging until 2-3 weeks of observation pass.

**Active theme:** Replace HubSpot customer-facing invoices with Stripe Invoices (Option 2 from the May 12 discussion). Option A is the lightest delivery of that vision — full Stripe Invoice exists in the background; customer just sees Stripe's hosted page instead of HubSpot's when they click Pay Now. Next phases once observation passes: (a) optional embedded Payment Element on `/i/` (so customers never leave our page), (b) Refund button in Order Hub, (c) eventually disable HubSpot invoice creation. HubSpot Payments is Stripe under the hood; `hs_fees_amount` IS Stripe's rate; `hs_platform_fee` (~0.5%) is HubSpot's markup we save going direct. ~$80 per $16k card transaction, $7-10k/year. Decisions locked from May 12: TaxJar stays, payment link goes in OUR email/PDF (`auto_advance: false`), no Stripe-side reminder emails, AR aging untouched.

**Outstanding work (not yet started):**

- The May 7 audit findings below — none addressed yet. The five "Critical" items are real bugs and should be the next coding focus once the AP system stabilizes. Especially **#1 (public endpoints lack share-token auth)** and **#2 (XSS in server-rendered HTML)** — both are exploitable by anonymous visitors.
- v1.11.0 promoted to main 2026-05-11. **v1.12.0 on staging — paused mid-feature, will resume later.** Spot-test the To/CC+ module on Process Order from both Deal Hub and Quote Builder, verify the recipients land in `order_data.shipEmailTo` / `order_data.shipEmailCc` and pre-populate the Orders drawer when the order is opened.
- The "open question" from v1.10.1 was answered by v1.10.2: not auto-apply, but explicit "Select Rate" button. Card click is now pure selection; the two explicit actions are now just "Book Online" and "Select Rate" (the green "Book ABF Shipment" button was retired in v1.12.3).
- ABF deep-link confirmed working in staging test. The candidate-ID logger in `parseAbfXml` is still in place — could be narrowed to a single element name once confirmed which one ABF actually uses (low priority; defensive parsing is fine).
- OD has no public saved-quote viewer (user checked their myOD portal — no quote history page). v1.9.10 dropped OD click-through accordingly. If OD ever exposes one, re-add `quoteUrl` in the OD result.
- **Parked (proposed v1.9.11):** flip OD's `requestReferenceNumber` flag from `false` to `true` and log the raw SOAP response so we can see what identifier-like fields OD returns. Cheap investigation — would tell us empirically whether anything OD ships back is searchable in their UI.
- **Parked follow-up:** BOOTH_DATA pallet dimensions (orders-dashboard.html:689) — user reports some entries may be inaccurate. Needs them to specify which SKUs/booths are wrong; we update the map then. The shared computeShipmentEstimate helper (v1.9.6) makes this a one-place fix when ready. *(Update 2026-05-12: orders-dashboard's copy was synced to QB's in v1.12.4 — QB is the source of truth. Any future corrections still need to land in BOTH files until BOOTH_DATA is extracted.)*
- **Parked architectural cleanup:** Extract `BOOTH_DATA` (and probably `BOOTH_PRESETS`) out of `quote-builder.html` into a shared `lib/booth-data.js` served as a static JS bundle, included by both `quote-builder.html` and `orders-dashboard.html` via `<script src>`. The v1.12.4 incident — two divergent copies silently drifting — is the kind of bug this prevents. Low priority but high ROI when next touching this area.

**Tooling note:** As of 2026-05-08 the user is moving day-to-day editing from Claude Desktop to Cursor. Local clone lives at `C:\Users\bento\Documents\Claude\WhisperRoomQuote-staging`. Workflow stays the same (staging-only, explicit ask to promote to main).

---

## Session writeup — May 12, 2026 (v1.13.2 → v1.16.2)

A 15-version push across five concurrent themes. Two promotions to main during the session (v1.13.6 mid-session, v1.16.0 late-session). All triggered by real incidents — none were "let's add a feature" theoretical.

### 1. Freight modal overhaul (v1.13.2 → v1.14.1)

The "Get Freight" popup on the orders dashboard got a deep cleanup over seven versions:

- **v1.13.2** — ABF rate cards now show the dynamic discount when ABF returns one. `parseAbfXml` was already extracting `DYNDISC` but the value was being dropped before reaching the carrier list. Now: green `−$X.XX dyn. discount` note + `net est.` line beneath the actual cost.
- **v1.13.3** — OD rates dropped the bogus `+120 lbs/pallet` adjustment inside `/api/orders-freight`. Our stored per-pallet weight is already gross (booth + accessories + wooden pallet), which is what OD wants — the +120 was double-counting. OD rates should now line up with odfl.com manual quotes.
- **v1.13.4** — Pickup Date moved from the post-rates booking sub-section to the main form (above Accessorials). Now sent with the rate request and drives ABF's `ShipMonth/Day/Year`, so transit-day rendering reflects the actual pickup day. OD's SOAP rate API has no pickup-date field, so OD rates remain pickup-date-agnostic. Contact Phone field removed entirely (was redundant; dormant bookShipment() now pulls phone from customer snapshot).
- **v1.13.5** — Per rep direction, ABF cards with a dynamic discount now lead with the **net (discounted) estimate** in orange as the headline. The standard cost moves below the discount line.
- **v1.13.6** — Select Rate applies the **net** cost to the order's freight field (not the standard rate). Per rep: they book in advance to capture the discount, so the net IS the actual cost.
- **v1.13.7** — Card click now writes carrier / freight cost / **pickup date → Date Shipped** to the drawer immediately. No longer waits for the Select Rate button. Switching cards rewrites with the latest selection.
- **v1.14.0** — New **Freight Quote Ref** field on the order drawer. When the rep selects a rate, the carrier's saved-quote ID (ABF `quoteId` like `LTLX8W1316` or OD `referenceNumber`) is stashed on the order with an `Open ↗` button. ABF deep-links to the saved quote on arcb.com; OD copies the ref to clipboard and opens its rate-reference-search page. Persisted in `order_data.freightRef` so the rep can come back days later.
- **v1.14.1** — Select Rate now also calls `saveOrder()` so the drawer persists immediately instead of waiting for a separate Save Changes click.

**Promoted to main** mid-session (commit fb4c3f0). The OD rate fix is the most user-visible — confirmed live on prod, no regressions reported.

### 2. QB tax suppression + Process Order guardrail (v1.15.0)

Two related fixes triggered by a NY incident: an order shipped to NY (we don't have NY nexus) processed and QB invoice came back with NY tax added. Investigation showed:

- TaxJar correctly returned $0 (NY isn't in `NEXUS_STATES`)
- Our code sent every line with `TaxCodeRef=TAX`
- QB Automatic Sales Tax then taxed the ship-to address using its agency list, where NY was listed as an active agency
- The rep-controlled Tax Exempt checkbox had the same blind spot — was only used on our PDFs/quote pages, never reached QB

Fix: both QB invoice paths (`/api/process-order` and `/api/orders/:quoteNumber/create-qb-invoice`) now detect `(snapshot.taxExempt === true) || (TaxJar.tax === 0)` and send `GlobalTaxCalculation:"NotApplicable"` + `NON` tax code on every line + freight. QB AST goes silent for the invoice. Suppression-only, **not amount override** — QB AST rejects per-invoice amount overrides for AST companies (see v1.7.10 incident).

The Process Order guardrail came from a separate user report: re-processing a quote that already had an order wiped every rep-edited field (carrier, tracking, freightCost, freightRef, serialNumber, qbInvoiceId). Now: server returns 409 `ORDER_EXISTS` if a row exists; client (both QB and Deal Hub) prompts to confirm; on confirm, retries with `force:true`, server merges with prior order_data (deep-merging `shipped`) so saved fields survive, AND skips QB invoice re-creation when `qbInvoiceId` is already linked (no duplicate invoices). Logs `process-order.blocked-already-exists` and `process-order.force-reprocess`.

### 3. Create Invoice auto-pays + Tax Exempt rehydration (v1.15.1, v1.15.2)

- **v1.15.1** — The orders-dashboard Create Invoice button (`/api/orders/:quoteNumber/create-qb-invoice`) was stopping at invoice creation, leaving the rep to mark-paid manually. Since this endpoint is the recovery path when `/api/process-order` didn't reach QB, it needed to produce the same end state. Now mirrors the process-order auto-payment block: non-PO orders auto-create a QB Payment against the new invoice; PO orders skip.
- **v1.15.2** — Tax Exempt checkbox now restores when reopening a saved quote. The flag was saved to local history (`accessories.taxexempt`) and server snapshot (`taxExempt`), but `loadFromHistoryEntry`'s accessory-restore loop only iterated four hardcoded IDs (residential, liftgate, limitedaccess, loadingdock). Added a dedicated restore block that handles checkbox + label active class + cert input value + the conditional cert-input row visibility + the click-handler side effects (clears `taxData`, hides tax-result panel). Also added `taxExemptCert` to the local-history save payload.

### 4. HubSpot Fees monthly summary + URL rename (v1.15.3 + v1.16.0)

The user's accountant wants to book ONE monthly expense in QB for HubSpot payment-processing fees rather than reconciling per-order. Two-step shipping:

- **v1.15.3** — Diagnostic endpoint `GET /api/debug/hubspot-payments?limit=3` returns the full HubSpot Payment property schema + recent payment values, so we could identify the fee fields with certainty (HubSpot has shifted Payment property names over time). User pasted the response back; confirmed `hs_fees_amount` (card/ACH processor fee) + `hs_platform_fee` (HubSpot's cut) sum to `hs_initial_amount − hs_net_amount` penny-for-penny.
- **v1.16.0** — Built the **HubSpot Fees** tab on the Accounting page. Month picker (defaults to last full month), KPIs (Transactions, Gross, **Total Fees** as orange headline, Processor Fee, Platform Fee, Net, Refunds), per-payment table, CSV download. New endpoint `GET /api/accounting/hubspot-fees?month=YYYY-MM` paginates through HubSpot Payments search filtered to succeeded + `hs_payments` processor.
- Same commit: renamed `/reconcile` → `/accounting` (page title already said "Accounting"; only the URL lagged). All seven dashboard nav links updated. `/reconcile` keeps working — 302-redirects with query string preserved so the QB OAuth callback (`?qb=connected`) and existing bookmarks still land.

**Promoted to main** late-session (commit 9587db1). User confirmed the HubSpot Fees tab loads correctly and the totals tie to bank deposits.

### 5. Stripe integration prep (v1.16.1 + v1.16.2)

User has a Stripe account and asked about replacing HubSpot Payments. Discovery: **HubSpot Payments uses Stripe under the hood.** `hs_fees_amount` IS Stripe's rate (~2.9% + 30¢). The `hs_platform_fee` (~0.5%) is HubSpot's markup we'd save going direct — ballpark $80 on a $16k card transaction, ~$7-10k/year at WR's volume.

Discussed three flavors:
1. **Lightest** — Stripe payment link, everything else stays
2. **Medium** — Stripe Invoices replace HubSpot's invoice UI ← **user chose this**
3. **Heaviest** — Stripe as system of record, QB gets journal summaries (advised against)

Decisions locked for Option 2:
- TaxJar stays (pass tax as a separate `invoice_item` line, not Stripe Tax)
- Payment link goes in OUR existing rep-controlled email/PDF, not Stripe's auto-email (set `auto_advance: false` on the invoice)
- HubSpot Invoice creation: off (button-triggered today, not auto — easy swap)
- AR aging unchanged (reads HS deal amounts, not invoice amounts)
- Refund button to be added in Order Hub
- ACH worth enabling (0.8% capped at $5 vs 2.9% on cards) — pending user check on Stripe account provisioning

Shipped diagnostics:
- **v1.16.1** — `GET /api/debug/stripe-diagnostic` creates one test Customer + four test invoice_items + finalized Invoice, returns `hosted_invoice_url` + `invoice_pdf`. Hard-locked to `sk_test_` keys. Companion `/api/debug/stripe-cleanup?invoice=...&customer=...` voids + deletes.
- **v1.16.2** — Fixed an initial 400: Stripe's `/v1/invoiceitems` rejects `amount` + `quantity` together (mutually exclusive; `quantity` only works with `price_data[unit_amount]`). Dropped quantity from the diagnostic. Real implementation will use `price_data` so multi-qty WR orders display "2 × $3,500" cleanly.

User confirmed the diagnostic ran successfully end-to-end:
```
{"success":true, ..., "invoice":{"total_dollars":"4716.40","status":"open",
 "hosted_invoice_url":"https://invoice.stripe.com/...","invoice_pdf":"..."}}
```

Stripe sandbox key (`sk_test_...`) is in Railway test service env. Awaiting user feedback on how the `hosted_invoice_url` page actually renders (branding, line item display, test-card payment flow) before next step.

**Next session — Stripe integration build:**
1. `lib/stripe.js` module mirroring `lib/quickbooks.js` patterns (init({deps}), findOrCreateCustomer, createInvoice with `price_data` lines, finalize, getInvoice, voidInvoice, refundCharge, verifyWebhookSignature)
2. `POST /api/stripe/webhook` endpoint — signature verification, handles `invoice.paid` (mark QB invoice paid, push HS deal `payment_status=paid`, write `stripeInvoiceId`/`stripePaymentIntentId`/`stripeReceiptUrl` to `order_data`) and `invoice.payment_failed`, `charge.refunded`
3. Hook into `/api/process-order` — alongside the existing QB invoice creation, also create a Stripe invoice with `auto_advance: false`. Stash hosted URL in order_data.
4. UI surfacing in Order Hub / Deal Hub: Stripe-hosted invoice URL + paid status. Refund button.
5. Two env vars per environment: `STRIPE_SECRET_KEY` (sk_test_ staging, sk_live_ prod) + `STRIPE_WEBHOOK_SECRET` (whsec_...).
6. Flag-gate with `INVOICE_PROVIDER=hubspot|stripe` env var for parallel rollout. Default to hubspot until a handful of Stripe orders run end-to-end clean, then flip default to stripe.
7. Then a cleanup PR: disable HubSpot invoice creation on the rep side, retire dead code paths.

Estimate: ~3-4 days of build, then 2-3 weeks parallel observation, then cutover.

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
| 1.20.2  | 2026-05-13 | Stripe on/off toggle (kv_store.stripe_enabled, default ON) — pill button on /admin-log topbar flips integration without redeploy. When OFF: /api/create-invoice skips Stripe AND /i/ falls back to HubSpot payment_link even when a Stripe URL exists on the snapshot. Webhook stays active. Endpoints: `GET/POST /api/stripe-toggle`. Also: $0-total safety guard — if `invoiceLineItems` positives sum to ≤0, skip Stripe (would auto-finalize as paid otherwise). Added `lineItemCount` / `positiveItemCount` / `previewTotalCents` to `stripe.invoice.created` log meta. |
| 1.20.1  | 2026-05-13 | Fixes two issues from v1.20.0 staging test: (1) Stripe `/v1/invoiceitems` rejected `price_data.product_data` (Checkout-only field) — switched to simpler `amount` + `description` shape with qty pre-multiplied; (2) `customer.email` missing from request body — added cascading fallback (body → snapshot → HubSpot contact lookup via `resolvedContactId`). `emailSource` logged in `stripe.invoice.created` meta. |
| 1.20.0  | 2026-05-13 | Stripe Invoice integration (Option A — May 12 plan, first cut). `/api/create-invoice` now also creates a Stripe Invoice from the same line items; `/i/:quoteNumber` Pay Now prefers Stripe `hosted_invoice_url` over HubSpot `payment_link`. HubSpot invoice still created in parallel (fallback). New `lib/stripe.js` module, `POST /api/stripe/webhook` with signature verification, rep notification on `invoice.paid`. State stashed on `json_snapshot.stripe` — no schema migration. Hard-locked to `sk_test_` keys. Canadian orders skip Stripe (wire transfer only). |
| 1.19.19 | 2026-05-13 | Hotfix on main: tax-not-calculated confirm popup no longer fires when Calculate Tax was run and returned $0 due to no-nexus state. Condition tightened from `(!taxData \|\| !_taxAmountFn)` to just `!taxData` — only warns when Calculate was actually skipped. Pushed direct to main without bringing along staging's v1.19.18 light-mode polish or v1.20.0 Stripe work; merged back into staging immediately so staging has the fix too. |
| 1.13.1  | 2026-05-12 | ABF rate requests now subtract 144 lbs of pallet wood per pallet (our stored weight is gross; ABF wants product-only). Applied in buildAbfUrl so both QB and orders dashboard get correct ABF pricing. OD unchanged |
| 1.13.0  | 2026-05-12 | Process Order blocked when ship-to address is incomplete (street + city + state + ZIP). Server-enforced; both clients (QB + Deal Hub) pre-check and toast. ZIP-only rate quoting unaffected |
| 1.12.4  | 2026-05-12 | Orders dashboard: synced BOOTH_DATA from QB (was stale, missing all MDL 96120/96144/96168/96192/102xxx shells + several with wrong dims); pallets now carry FULL shipment weight (booth + accessories), not just booth weight; suppressed misleading "N items missing pallet data" when a booth was found |
| 1.12.3  | 2026-05-12 | Orders freight modal: fixed always-1-pallet bug (BOOTH_DATA lookup was strict, missed HubSpot names with color/finish suffix); removed green "Book ABF Shipment" button (ABF + OD both use blue Book Online now) |
| 1.12.2  | 2026-05-12 | Follow-up: tax calc also only requires destination ZIP now (was still throwing "fill in state and zip" alert after freight succeeded from ZIP alone) |
| 1.12.1  | 2026-05-12 | Freight quote only requires destination ZIP now (city/state optional). Client validator relaxed; server omits empty ConsCity/ConsState from ABF URL so ABF can geocode from ZIP |
| 1.12.0  | 2026-05-11 | Shipping Email Recipients module (To + CC+) on Process Order modal in BOTH Deal Hub and Quote Builder; recipients persist to order_data and pre-populate orders drawer |
| 1.11.0  | 2026-05-11 | New 📞 Log Call button in Deal Hub action row → creates a real HubSpot Call engagement on the deal (auto-titled, OUTBOUND, attributed to logged-in rep) |
| 1.10.4  | 2026-05-11 | Fix: "Select Rate" toast was rendering "null — null applied · $undefined" (state vars cleared before toast read them) |
| 1.10.3  | 2026-05-11 | Fix: ABF Guaranteed cards transit slot now reads "2 business days · by Wed, May 13" instead of raw YYYY-MM-DD |
| 1.10.2  | 2026-05-11 | Freight modal action restructure: card click highlights only; explicit "Book Online ↗" + "Select Rate" buttons in booking sub-section |
| 1.10.1  | 2026-05-11 | Removed Special Instructions field + Rate Only button from freight modal's booking sub-section |
| 1.10.0  | 2026-05-11 | ABF Guaranteed Transit Options as extra rate cards (Guaranteed by 12 PM, by 5 PM, etc.) parsed from `<GUARANTEEDOPTIONS>` |
| 1.9.15  | 2026-05-11 | Fix: OD pallet weight 140 → 120 lbs; removed redundant "Book on OD.com" button from freight modal |
| 1.9.14  | 2026-05-11 | Fix: OD rate requests add 140 lbs per pallet (OD prices off gross weight inc. pallet); ABF unchanged |
| 1.9.13  | 2026-05-11 | Fix: OD rate requests now include NMFC 027880 sub 02 on freight items (matching ABF); OD prices against contracted commodity instead of generic class |
| 1.9.12  | 2026-05-11 | Fix: OD rates were double-counting fuel + accessorials on top of `netFreightCharge` (~$50–$200 too high every quote); OD card click copies reference to clipboard + opens OD's search page |
| 1.9.11  | 2026-05-11 | OD rate cards display "Ref: XXXX" from `<referenceNumber>`; `requestReferenceNumber` flipped to true (WSDL-confirmed safe) |
| 1.9.10  | 2026-05-11 | OD carrier cards no longer click-through (no public saved-quote viewer exists); only ABF gets the ↗ external open |
| 1.9.9   | 2026-05-11 | Carrier cards in Get Freight modal click-through to carrier quote page (ABF rate-quote deep-link, OD ship tool) |
| 1.9.8   | 2026-05-11 | Get Freight modal surfaces ABF service-level notes (e.g. restricted delivery days) inline under each carrier card |
| 1.9.7   | 2026-05-11 | Orders drawer Quote Weight block reformatted to match Quote Builder widget (Total / Pallets / per-pallet dims) |
| 1.9.6   | 2026-05-11 | Orders drawer: "Estimated: N pallets · X lbs" above Shipment section; Get Freight modal gains L/W/H/Weight column headers; shared `computeShipmentEstimate` helper |
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
