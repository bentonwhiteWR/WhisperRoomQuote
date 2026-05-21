# WhisperRoom Quote Builder — Dev Log

Internal development notes. Last updated 2026-05-20.

> **Read this first when starting a session.** The "Current focus" section below is the fastest way to know where we left off. Below that: session writeups, the audit (outstanding work), and the changelog table.

---

## Current focus (2026-05-20 — Assembly Manual + Suppliers tab + Ship Calendar + email-reply logging all shipped)

**Most recent shipped to PROD:** v1.33.1 — Modify Order line items inline + Own Shipping toggle + T&C cleanup + process-order PDF upsert + global logo redirect. Promoted 2026-05-21.

Today's prod batch (v1.26.x → v1.32.x) is the largest single-day shipment in the project's history. Five parallel workstreams plus a Shopify-API investigation that didn't ship code but informed the path forward. Full breakdown lives in the **May 20 session writeup** below.

**On STAGING (NOT YET promoted to main):**

- **v1.34.0** (2026-05-21) — AP / Audimute email-flow tweaks. Three pieces: (a) Process Order shipping email (the `shipping@whisperroom.com` mailto built in quote-builder.html after `/api/process-order` returns) auto-CCs `jholdway@whisperroom.com` when the order has an AP item or AP color — Jill handles the Audimute step downstream and was previously not on the loop. (b) Suppliers-dashboard "Send" button (`sendPoEmail`) auto-CCs `bentonwhite@whisperroom.com` for paper trail. (c) Deal Hub `submitApPoModal` create flow auto-opens the Audimute mailto draft right after the PO is created — new helper `_openAudimutePoDraft` builds the same subject/body/CC as the suppliers-dashboard Send button. Does NOT mark the PO as sent (only the actual Send click from suppliers dashboard PATCHes `sent_at`). **Awaiting user test.**

**Open follow-ups from today (in priority order):**

- **Assembly Manual — feature-combo testing.** Most code paths are exercised, but the user explicitly said "I need to test everything in the manual, but will get to that in due time." Coordinate a test build with each common combo (ADA / WA UPG / Roof Vent / Bass Traps / SNV / LP / etc.) and verify section files match. The `X-Assembly-Missing` response header surfaces any folder where the substring lookup didn't land.

- **Supplier-spend drilldown deep links — verify QB txn-id mapping.** The "Open ↗" link on each row relies on QB exposing the underlying transaction id on one of the `ColData[i].id` cells. My flatten picks the first non-account id. If any row shows a dash in the QB column instead of "Open ↗", paste the row's type + doc # and we adjust the extraction.

- **HubSpot workflow rewrite — validate next fresh Shopify order.** Today's rewrite changes parts-order deals to TRANSITION (not duplicate) into the Sales Pipeline, preserving tax_price / source store / line items / contact assoc from the original Shopify-synced deal. Next live parts order tells us whether the data actually flows through. Old duplicate deals from the prior workflow are still orphaned in HubSpot — possible cleanup later.

- **Shopify API authentication — tabled.** Explored at length today. Conclusion: the new Shopify Dev Dashboard does not offer a static `shpat_` token for custom-distribution apps without standing up an OAuth callback handler (~30 min of work). Decision was to stick with HubSpot-mirror data for the Shopify-parts auto-invoice for now. If precision tax / address / line items become a real pain point, options are (a) install Intuit's official Shopify→QB integration and let it own all Shopify→QB sync, or (b) build the OAuth callback. See May 20 writeup §6 for the trail.

- **Email-reply logs v2 — feedback capture.** Deliberately not in v1. Revisit once there's enough history in the `email_reply_logs` table to make manual review valuable. Likely shape: thumbs up/down + an "edited final" textarea that captures what the rep actually sent (if different from what the model produced), so we can build a dataset of "model output → human-corrected output" pairs.

### TaxJar compliance investigation (TABLED — keeping notes for future reference)

v1.22.0 (TaxJar line-item mode) and v1.22.1 (manual FL §212.054 surtax cap) were reverted from staging on 2026-05-18 — user chose to table the entire workstream. The reverts preserve the code in git history, so the work can be resurrected by reverting the revert commits when ready. What surfaced before tabling:

- TaxJar's `/v2/taxes` endpoint **does not auto-apply state-specific per-item caps** — confirmed for FL even in line-item mode. Likely also misses TN single-article cap, MA $175 clothing, etc.
- User confirmed TaxJar's AutoFile **files on its own calculated number, NOT on what was actually collected via Shopify/QB**. Dashboard shows "what we collected" vs. "what we should have collected" vs. "discrepancy" — and files the higher (TaxJar-calculated) number.
- Mechanism of leak: QB AST + Shopify both correctly apply state caps at invoice time → customer pays the correct (lower) amount → TaxJar's records say "should have collected $X" using uncapped flat rate → TaxJar files $X → WhisperRoom remits the gap out of pocket.
- User mentioned a TN incident a few months back where Shopify charged "less than what the total tax rate was" and TaxJar then "filed that we owed more money to the government." That's a concrete confirmation this isn't theoretical.
- Per-order amounts are small (FL = ~1% × amount-over-$5k-cap, so ~$7 on the Pinellas booth) but it's compounding silently across years and multiple states.

If/when picked back up: items worth revisiting include emailing TaxJar support on AutoFile actuals-vs-calculated, pulling historical FL orders to verify the leak is recurring, the reconciliation script (Closed Won vs QB `TxnTaxDetail.TotalTax` vs TaxJar-would-have-filed), nexus list verification (`lib/states.js:8-25` has 16 states; user thought 14), and the strategic stay/Stripe-Tax/Avalara decision. Process-side: add CPA-level human review of monthly filings regardless of software choice.

- **v1.21.10** (this session, May 15 PM) — User raised the question: when an order is processed, is the correct freight amount actually transferred to HubSpot's `freight_cost` deal field? Trace found three connected bugs:
  - `/api/process-order` closedwon PATCH was missing amount/tax_rate/freight_cost/discount entirely. The Freight LINE ITEM got rebuilt on the deal but `freight_cost` (the deal property) was never patched. So if the rep edited freight after quote creation, HubSpot kept the original value.
  - `/api/create-deal` open-stage path (`dealPatchProps` around quote-server.js:2902) had amount/tax_rate/total_tax_amount/discount but was missing freight_cost. So updating a quote on an open deal silently failed to push freight.
  - `/api/create-deal` locked-stage path (quote-server.js:2856-2900): the May 13 carve-out that financial-PATCHed closed deals on every new quote creation was overreaching — Merge Deal (/api/deals/:id/merge) and Modify Order (/api/orders/:q/add-charge) each have their own endpoints and don't go through /api/create-deal. So the locked-stage patch was firing on ANY new quote creation against a closed deal, silently rewriting its financials. Per user's clarified rule ("unless the order is closed, it should be updating; closed = read-only except for the explicit Modify Order action"), the locked-stage branch is now a no-op log.
  - Net behavior: open deals get full financial sync on create/update; process-order does the FINAL sync as the deal transitions to closedwon; closed deals are read-only from /api/create-deal thereafter (use Modify Order for changes).

- **v1.21.0** (this session, May 15) — Shopify Orders drawer + 60s auto-refresh. New 🛒 button in Deal Hub topbar opens a right-side slide-out drawer listing every ecommerce-owned deal in three sections: Awaiting Verification (≥$5k, no quote yet — orange chip, the booth orders Jill needs to verify), Small Orders (under $5k, no quote yet — parts orders for spot-checking), In Progress (already has a quote in our system). Button glows orange with a pulse when there are pending verifications; neutral count badge otherwise. Polls every 60s. Click any row → existing deal hub overlay → "+ New Quote" → normal quote flow. Ecommerce-owned deals now EXCLUDED from main `/api/deals/list` results — drawer is their home, also sidesteps the HubSpot search quirk from yesterday. Deal Hub board itself also auto-refreshes every 60s now (matches admin-log polling pattern). Two new env-overridable constants: `ECOMMERCE_OWNER_ID` (default 49384873) and `SHOPIFY_VERIFY_THRESHOLD` (default $5000). New endpoint `GET /api/shopify-pending`.

Today's progression (May 14, in order):

- **v1.20.7** — accept ACH + wire alongside card. Per-quote `allowCC` / `allowACH` / `allowWire` checkboxes in both Create Invoice modals (quote builder + deal hub), all default ON. `lib/stripe.js` builds `payment_settings.payment_method_types` dynamically; when wire is on, adds the required `customer_balance.bank_transfer.type: us_bank_transfer`. Days-until-due stretches 7 → 14 when ACH on so legit payers don't see "past due" before ACH clears. Defensive: wire silently drops (`stripe.invoice.wire-dropped` log) if customer has no name. Use case: uncheck CC on $50k+ orders to skip 3.4% fee. Stripe Dashboard ACH + Bank Transfers confirmed enabled in test mode.

- **v1.20.8** — Deal Hub invoice rows reflect Stripe paid state. When `json_snapshot.stripe.status === 'paid'`, the deal-hub response overlays `status='paid'` + `paidVia='stripe'` + `stripeInvoiceId` + `stripeDashboardUrl` onto the HubSpot-sourced row. UI renders a purple "Stripe" badge + "Stripe ↗" link jumping to the Stripe Dashboard. Existing /admin-log toggle gates the overlay — flipping OFF makes the server skip Stripe entirely.

- **v1.20.9** — **critical fix.** Stripe webhook had been returning 401 to EVERY delivery since v1.20.0 shipped (8+ days). The global auth middleware at `quote-server.js:564` rejects `/api/*` requests without a session cookie, and `/api/stripe/webhook` wasn't in the `isPublicRoute` allowlist. Stripe authenticates via signed body, not cookies. So every webhook attempt bounced off auth before our handler ran — zero `invoice.paid` events processed for the entire integration period. Caught by inspecting Stripe Workbench → Webhooks → Event deliveries (saw 9+ `401 ERR` attempts). One-line fix: added webhook path to the allowlist. Signature verification in the handler is preserved (only requests with valid `Stripe-Signature` get processed). Stripe auto-retried queued events over the next hour and they all landed.

- **v1.20.10** — two workflow upgrades hanging off `invoice.paid` (now working): (1) **Deal cards turn green** when an invoice is paid (Stripe-paid via toggle-gated snapshot flag OR HubSpot `payment_status='paid'`), in addition to existing quote-accepted/payment-type triggers. (2) **Auto-advance HubSpot deal stage** to "Verbal Confirmation" (`contractsent`) on `invoice.paid` webhook, but ONLY if currently at an earlier stage. Skips `contractsent`/`closedwon`/`845719`/`closedlost` to never walk a deal backwards. New log events: `stripe.deal-stage-advanced`, `stripe.deal-stage-noop`, `error.stripe.deal-stage`.

- **v1.20.11 → v1.20.12 (reverted)** — added a dedicated Shipped-stage catch-all pass mirroring Closed Won. Brought in more old Shipped deals as expected, but did NOT solve the immediate problem (a brand-new Shopify deal was missing from the board). Reverted to keep the board clean while we investigate.

**Diagnostic endpoints added today (no version bump, debug-only):**
- `GET /api/debug/deal/:id` — fetches raw HubSpot deal properties + the pipeline definition (with all stage IDs ↔ labels). Used to verify a deal's actual internal `dealstage`/`pipeline` vs. what we filter on.
- `GET /api/debug/find-deal?q=...` — searches HubSpot deals by name and returns up to 20 matches with IDs and key properties.

### Open investigation: Shopify deals invisible from Deal Hub [RESOLVED 2026-05-20]

The HubSpot workflow rewrite (transition the original Shopify-synced deal into the Sales Pipeline instead of creating a duplicate) sidesteps this entirely — the source-of-truth deal is now in the pipeline our app reads, complete with the Shopify-synced data. The HubSpot search-index quirk no longer matters. Keeping the notes below for historical context.

---

Late EOD May 14 we hit a real bug we couldn't fully diagnose. Two newly-arrived Shopify-generated deals — IDs `60254716188` (#2144, $5,046.50) and `60256150594` (#2145, $11,180.80) — landed in HubSpot's Sales Pipeline at stage `845719` (Shipped) with owner `49384873` (ecommerce@whisperroom.com). Both are missing from the Deal Hub board.

**What we ruled out:**
- Pipeline mismatch — confirmed in Sales Pipeline (`default`), confirmed stage is genuinely `845719` (not a duplicate-named stage), pipeline definition verified via `/api/debug/deal/:id`
- Rep filter — user verified "All Reps" was selected
- "Hide HubSpot Only" toggle — verified off
- Pagination depth — added dedicated Shipped catch-all in v1.20.11 (brought in MORE old Shipped deals), didn't surface these
- These deals ARE returned by `/api/deals/list?stage=845719&limit=500` (explicitly filtering to Shipped) — verified by Ctrl+F on deal ID
- These deals ARE returned by `/api/debug/find-deal?q=Shopify+%232144` — HubSpot's text-search index has them

**The leading suspect:** something about how HubSpot's deal-search API handles deals owned by `49384873` (ecommerce service user) in combination with the `dealstage IN [5 stages]` filter we use on the default load. Single-stage filter (`?stage=845719`) returns them; multi-stage filter does not. Probably a HubSpot search-index quirk specific to that owner ID or to the way Shopify deals are tagged.

User comment from EOD: "I have to specifically search '2145'. If I type shopify, lots comes up, but definitely not the most recent ones we sold." So even the text-search has weirdness — older Shopify deals match the search, the most recent ones don't unless you search by their specific number.

**Decision (user-driven):** rather than chase down the HubSpot search quirk, build a new **"Shopify Review" column** in the Deal Hub that pulls ALL ecommerce-owned deals (`ownerId === '49384873'`) regardless of HubSpot stage. This sidesteps the search bug AND fixes a real workflow gap (the HubSpot Shopify integration auto-advances new Shopify deals to "Shipped" stage on creation, which is correct for small parts orders but WRONG for booth orders that need human verification before processing).

### Queued (next session): build "Shopify Review" column [SUPERSEDED 2026-05-20]

User opted for a different approach: rewrite the upstream HubSpot workflow to TRANSITION the original Shopify-synced deal into the Sales Pipeline (booth orders → Verbal Confirmation stage; parts orders stay in Order Pipeline owned by ecommerce). That obviates the need for a separate "Shopify Review" column. Notes below retained as historical context.

---

**The workflow problem:** Shopify orders auto-create HubSpot deals via a workflow that drops them in "Shipped" (presumably because Shopify already collected payment + the small parts orders ship automatically from the Shopify side). But booth orders ($5k+) come through the same Shopify checkout and end up in the same "Shipped" stage — which is wrong because they haven't been verified, quoted, or processed by sales. Jill needs to contact the customer, confirm what they're getting + shipping, then create a real quote and process it like a normal order.

**Two paths to fix (not mutually exclusive):**

- **Path A — Fix the HubSpot workflow at the source:** change the auto-advance logic to put deals over $X into a different stage (or new "Shopify Review" stage). No-code change inside HubSpot Workflows. Cleanest long-term answer. We aren't doing this in next session unless user wants to.
- **Path B — Build a "Shopify Review" column in our Deal Hub:** **THIS IS THE PLAN.** Column criteria: `ownerId === '49384873'`, regardless of HubSpot stage. Effectively removes ecommerce deals from the Shipped column and gives them their own home. Doesn't touch the HubSpot workflow (no risk of breaking the small-parts auto-flow).

**Sketch for the column (locked decisions from EOD May 14 discussion):**
- Column shows ALL ecommerce-owned deals (not just $5k+), so small parts orders are visible too — Jill can spot-check anything weird
- Card displays an orange `Booth — Verify` chip if `amount >= $5000`, no chip otherwise — visual priority signal
- Click → existing deal hub overlay → existing "+ New Quote" button. Jill builds a real quote bound to the Shopify-created deal, sends to customer, processes like normal.
- Deal LEAVES the Shopify Review column once `latestQuote` is set on it (sales has created a real quote — deal now flows through normal columns based on actual stage)

**Three scoping questions still unanswered (ask user first thing next session):**
1. Threshold for "Booth — Verify" chip — $5k as proposed, or different?
2. Show all Shopify deals in column, or only ones above some amount? (Recommended: all, only big ones get the chip.)
3. When Jill creates a quote against a Shopify deal, should it move out of the column entirely (recommended) or stay with a "Quote Sent" indicator?

**Estimated effort:** ~half-day. New COLUMNS entry in `deals-dashboard.html`, server-side `shopifyReview` flag in `/api/deals/list` based on ownerId, exclude these deals from the Shipped column (so they only appear in Shopify Review). Bonus: ALSO fixes the visibility bug we couldn't track down — these deals will appear in their own column whether or not HubSpot's search index includes them in default queries.

### Also tabled (not in next session unless user asks)

- **BOL + carrier API pickup booking via ABF** — full spec captured from API docs (May 14 session). Decisions locked: freight class 100, NMFC `027880-02`, requester Jeromy Packwood (shipping@whisperroom.com, 423-586-6299), `RequesterType=1`, `PayTerms=P`, `FileFormat=A`, `PkupCopyShip=Y`, `BolCopyShip=Y`, `ProAutoAssign=Y`. Safety: `ABF_BOOKING_MODE` env (`off`/`test`/`live`), `Test=Y` flag built into ABF live endpoint so no separate UAT needed. BOL PDF goes into `GDRIVE_ORDERS_FOLDER` (not deal folder), named `{order_name minus W-XXXXXXXXXX} BOL.pdf`. Dock hours 8-5, AT 10:00, pickup default next business day, button always available to Jeromy (no gating). Button lives on Orders dashboard. Estimated 2-3 days build + 1 week test-mode burn-in. Dormant `bookShipment()` in `lib/freight.js` is the starting scaffold.

- **Embedded Stripe Payment Element on /i/** — explicitly deferred from May 14 morning discussion. Re-evaluate after 1-2 weeks of real customer use if anyone balks at the Stripe-hosted redirect.

- **HubSpot Payment record sync on `invoice.paid`** — so HubSpot UI shows Stripe-paid invoices as paid too. Defer until needed; reps live in our Deal Hub day-to-day, HubSpot UI being out-of-sync is a documented known issue.

- **Auto-suppress CC above $X threshold** — currently the rep manually unchecks the CC box on $50k+ orders, prompted by an orange warning. Could auto-uncheck. Low priority since the warning banner already nudges.

### Open questions / things to investigate

- The HubSpot search-index quirk with ecommerce-owned deals + multi-stage filters. If the Shopify Review column resolves the user-facing problem, this becomes academic. But worth understanding if it bites again with other auto-created deals (e.g., future integrations).
- Cross-system "paid" sync to HubSpot — deferred but worth scoping if HubSpot's accounting/AR views start mattering.
- `STRIPE_WEBHOOK_SECRET` is set in Railway test service (confirmed working as of v1.20.9 fix).
- `STRIPE_SECRET_KEY` is set to `sk_test_...` (confirmed working).

Yesterday's progression (May 13):

- **v1.20.6** — switched the discount display from per-line baking (v1.20.5) to a native Stripe Coupon attached to the invoice via `discounts[]`. Hosted invoice now shows a single "Discount" row under the subtotal — the standard B2B-invoice convention. Freight/tax/install invoiceitems flagged `discountable:false` so the coupon only hits product lines (matches HubSpot's `hs_discount_percentage` scope). Coupon is created one-shot per invoice (`duration:once`, `max_redemptions:1`) and named "N% Off — Quote W-XXX" so it's traceable in the Stripe dashboard. `previewTotalCents` reworked to mirror Stripe's aggregate-then-round math so it matches `amount_due` to the cent. Also polish: friendly `footer` ("Thank you for choosing WhisperRoom…"), and `custom_fields` for Quote Number + Deal ID so support can cross-reference from Stripe. Logo/brand color/business name are configured separately in Stripe Dashboard → Settings → Branding (one-time, no code) and propagate to all hosted invoices automatically.
- **v1.20.5** — wired the quote-level discount into Stripe. HubSpot's path was passing `hs_discount_percentage` per line; Stripe has no equivalent field, so the discount silently dropped (Stripe total = gross instead of net). `lib/stripe.js` now bakes `item.lineDiscount` into each line's cents amount and appends "(N% off, was $X)" to the description so the customer sees the discount on the hosted page. Freight/tax/install lines carry `lineDiscount=0` already, so the discount stays product-only just like HubSpot. `previewTotalCents` in `/api/create-invoice` updated to apply the same math so the fail-loud guard does not misfire and the success-log preview matches Stripe's finalized `amount_due`.
- **v1.20.4** — fixed the doubling bug introduced by v1.20.3's first real test. v1.20.3's `pending_invoice_items_behavior: include` correctly attached the new items but ALSO swept in every orphan pending invoiceitem the customer had accumulated from pre-v1.20.3 failed runs — so the invoice was ~2× expected. Switched to draft-first, attach-directly: create the empty invoice draft, then create each `/v1/invoiceitems` with `invoice: draft.id`. No pending-bucket interaction means orphan items from any past or future failed run cannot contaminate. `pending_invoice_items_behavior: exclude` set explicitly as belt-and-suspenders. Stale pending invoiceitems on the test customers from yesterday's runs are still in Stripe sandbox but no longer harmful — clean up via Stripe dashboard (test mode → Customers → delete pending invoiceitems, or delete the customers entirely).
- **v1.20.3** — fixed the $0-invoice bug from today's first real rep-flow test. Root cause: `lib/stripe.js` was POSTing `/v1/invoices` without `pending_invoice_items_behavior: include`. Stripe's API default flipped from `include` to `exclude` in version 2022-11-15, so the freshly-created `/v1/invoiceitems` (pending) never attached to the new draft → draft finalized at $0 → hosted invoice page reads "already paid." The existing `/api/debug/stripe-diagnostic` route already had the flag (`quote-server.js:841`), which is why the May 12 diagnostic ran clean end-to-end at $4716.40 but today's real rep-flow attempt produced a $0 invoice. Also added a fail-loud guard: `createInvoiceForQuote` now takes `expectedTotalCents` from the caller and throws if Stripe returns `amount_due=0` when we expected positive. `/api/create-invoice` passes `previewTotalCents` through. The error surfaces as `error.stripe.invoice` in `/admin-log` instead of a silent $0 success.

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

**Queued (per May 14 ship-to-process discussion):**

- **Embedded Payment Element on /i/ — explicitly DEFERRED** (Option B from May 13 discussion). User decided May 14 to stick with the redirect-to-Stripe-hosted flow for now. Reasoning: customers don't perceive the redirect as friction the way developers do, and embedded would mean rebuilding Stripe's hosted-page UX (already-paid state, decline retries, 3DS challenge, ACH processing state UI, wire funding-instructions display). Total cost: card-only embedded ~1 day, +ACH ~2 days, +wire ~3-4 days. Re-evaluate after 1-2 weeks of real customer use if anyone balks at the redirect.

- **Order-processing settlement policy (May 14 decision):** payment method dictates how long to hold before shipping.
  - **Wire** (`customer_balance`): clears in 1–2 business days; **effectively irreversible** once received. Process on `invoice.paid`. Safe.
  - **Card**: clears instantly; chargeback window is 120 days (Visa/MC) but practical risk is 30–60 days. Process on `invoice.paid` for normal orders. Keep signed BOL + order acceptance as chargeback evidence.
  - **ACH**: clears in 4–5 business days; **reversal window is 60 days** for "unauthorized" reasons. Process on `invoice.paid` for established customers. For **first-time customer + large order ($5k+)**, hold 7 days after `paid` as a fraud margin.
  - Stripe webhook fires `invoice.paid` ONLY after bank-network clearing for ACH/wire (not on initial submit) — so the webhook is a real "money has settled to Stripe" signal, not a "customer hit submit" signal.

- **ACH `processing` status follow-up** (deferred — would be nice not urgent): Between customer-submits-ACH (day 0) and `paid` (day 4–5), Stripe's `payment_intent.status` is `processing`. We don't currently surface this in `/admin-log` or anywhere rep-facing. Means an ACH-in-flight order is invisible to reps during the gap. Worth adding a `stripe.invoice.processing` log event (subscribed via webhook) + maybe a "ACH pending" badge on the deal hub once enough orders flow through to justify the UI.

- **Cross-system "paid" sync** (deferred — same as yesterday): on `invoice.paid` from Stripe, also patch the HubSpot invoice to paid so reconciliation isn't manual. Not urgent during the observation period since HubSpot AR aging reads deal amounts, not invoice paid-state.

- **New-customer-ACH hold automation** (deferred): rep-side notification when a $5k+ ACH payment comes from a first-time customer, so the rep can verify before shipping. Nice-to-have once we see real volume.

- **Auto-suppress CC above $X threshold** (deferred): currently the rep manually unchecks the CC box on $50k+ orders. Could auto-uncheck-and-warn at $50k. Low priority since the $50k warning banner already nudges the rep.

---

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

## Session writeup — May 20, 2026 (v1.27.1 → v1.32.3)

Marathon day. Eighteen versions shipped across five parallel workstreams plus a Shopify-API rabbit hole that didn't ship code but informed the path forward. Promoted to main four times during the day (after v1.30.4, v1.31.2, v1.32.1, and v1.32.3). One genuinely-large batch.

### 1. Shopify-parts QB auto-invoice — preview-before-commit + bug fix (v1.27.1, v1.28.0)

Continued from the v1.26.x work shipped the prior session. Two iterations today:

- **v1.27.1** — User asked to trim the confirm-dialog wording (drop the internal-plumbing bullets + the "Cannot be undone" caveat). One-line UI tweak.
- **v1.28.0** — Three things bundled:
  1. **Dry-run preview**. POST `/api/shopify-parts/create-invoice` now accepts `{dryRun:true}` and returns the assembled QB payload (addresses, line items, totals, memo, data source) without touching QB / Postgres / HubSpot. Frontend uses this for a confirm-dialog preview before the real commit. The idempotency-row check is informational in dry-run mode so reps can preview even after a botched prior attempt.
  2. **`contactName` → `customerName`** in the payment privateNote at `quote-server.js:3264`. Threw `ReferenceError` every time, surfacing as "Contact name not defined" in the toast. QB invoice was being created but the payment step always failed.
  3. **Toast surfaces fallback reason** when Shopify data isn't available — `dataSource: 'hubspot'` + `shopifyError: '...'` exposed in the API response.

### 2. Email Reply assistant — input/output logging + admin reviewer (v1.29.0, v1.29.1, v1.30.1)

New workstream. User wants to "review and train" the assistant. Logging + viewer in v1, feedback capture queued for v2.

- **v1.29.0** — New `email_reply_logs` Postgres table captures every `/api/email-reply` call: rep info, voice picked, full input, full output, model, token usage (input/output/cache-read/cache-creation), duration, status, error. Fire-and-forget so a DB hiccup never blocks the rep's reply. New `/email-reply-logs` page with paginated list, substring filter on input/output, click-to-expand for full-text side-by-side with copy buttons.
- **v1.29.1** — Dropped the admin gate after user said "anybody can see it, no PII concerns." Removed `ADMIN_REP_EMAILS` env var, `isAdmin(req)` helper, and the `__IS_ADMIN__` injection on the page.
- **v1.30.1** — Moved the "Admin Tools" button (links to the logs viewer) from the topbar (hidden in embed mode) into the bottom-right of the Generated Reply output panel so it's visible when the page is iframed inside the Deal Hub modal.

### 3. Assembly Manual builder — replace the Excel/VBA workflow (v1.28.2, v1.30.0, v1.30.3, v1.30.4, v1.31.1, v1.31.2)

Biggest workstream of the day. Replaced the legacy Excel/VBA "AMPDFMerge" macro with a server-side PDF merge driven from the quote builder.

**Architecture:**
- Source PDFs migrated to Google Drive under `Server/AssemblyManuals/` (replaces `Z:\Database\InventoryDB\AssemblyManuals\`)
- New `lib/assembly-manual.js` carries a declarative section config (~20 sections — one row per page-group) + a merge function using `pdf-lib`
- New `gdriveListFilesInFolder` + `gdriveDownloadFile` helpers in `lib/gdrive.js` (the latter uses native https because `_httpsRequest` string-concats response bodies and corrupts binary PDFs)
- Three endpoints: `/api/assembly-manual/models` (QB Item `LIKE 'MDL %'`, 24h cache, filtered to canonical naming pattern `MDL <digits>( LP)? (E|S|ENV|SNV)`), `/api/assembly-manual/plan` (dry-run preview), `/api/assembly-manual/build` (Drive lookup → merge → stream PDF)

**Iteration timeline:**
- **v1.28.2** — Backend (lib + endpoints + pdf-lib dep + `GDRIVE_ASSEMBLY_MANUALS_FOLDER` env var).
- **v1.30.0** — Frontend (button on quote builder + modal with pre-fill from `lineItems` + multi-room handling).
- **v1.30.3** — Form rework after user feedback: removed Jack Panel (OLD) checkbox, relabeled EFP from "(Window)" to "(Elevated Floor Package)", reworked pre-fill to use starts-with prefix rules (`RM `, `ADA `, `WA UPG`, `SL `, `EFP `) instead of loose substring matching that was missing common cases.
- **v1.30.4** — Three fixes: (1) `ctx.modelStem` (model with `MDL ` stripped) used for Cover/Series/EFP file matching since those folders use names like `4848 S EFP.pdf` not `MDL 4848 S EFP.pdf`. (2) ADA Size dropdown hardcoded to all 4 options (`4016, 4040, 4622, 4646`) so reps can build for rooms not on the current quote. (3) Spinner on Build button + status copy telling rep they can close modal and keep working.
- **v1.31.1** — SNV/ENV models normalize to S/E in the stem (WhisperRoom doesn't ship dedicated no-vent manuals; SNV/ENV share Cover/Series/EFP PDFs with their vented kin). New `ctx.isNV` flag gates the K + L ventilation sections off for those models.
- **v1.31.2** — ADA vs WA UPG semantic split: ADA line item = full package (Door + Ramp + EFP — auto-cascade); WA UPG = Door only (no Ramp, no EFP). Also added light-mode CSS support to the modal (was hard-coded dark).

**Status:** core functionality is shipped to prod. User needs to test feature combos and confirm section matching for the long tail.

### 4. Supplier-spend report — QB-driven dashboard (v1.28.1, v1.30.2, v1.31.0, v1.31.3, v1.32.2)

User asked for a dynamic supplier-spend report off QB data. Three-step build that took longer than expected because of two false starts (wrong QB report name → misleading "permission denied" error; wrong onclick escaping → silent-broken drilldown buttons).

**Iteration:**
- **v1.28.1** — Backend endpoint `/api/reports/supplier-spend?range=...` (24h cache, 7 range presets + custom). Initially used `ExpensesByVendorSummary` report — which 400'd with code 5020 "Permission Denied Error." Sent us down a false trail looking at QB user roles.
- **v1.30.2** — Discovered Intuit renamed the API report. Switched to `VendorExpenses` (and `TransactionListByVendor` for drilldown). Endpoint actually works now.
- **v1.31.0** — Frontend tile on `/reports` (new Suppliers tab) + sortable table + drilldown modal + sibling endpoint `/api/reports/supplier-spend/detail`.
- **v1.31.3** — Two bug fixes after first user test: (1) the "view →" drilldown links were dead because the inline `onclick="...openSupplierDetail(${JSON.stringify(name)})"` got mangled by the double-quoted JSON inside the double-quoted attribute. Switched to `data-vendor-id`/`data-vendor-name` + a single delegate listener. (2) QB's "Not Specified" bucket (~47% of total in our case — sales tax filings, bank fees, journal entries, payroll, CC processor payments) was dominating the table. Stripped server-side and surfaced separately as `notSpecifiedTotal` + a "+ $X uncategorized ⓘ" callout in the summary line. Percentages now compute against the named-vendor total.
- **v1.32.2** — User: "I only want accounts payable, not the payments. Can we add open-in-QB buttons?" Done both. `_flattenVendorDetail` now drops any row where `TxnType` matches `/payment/i`. New "QB" column with type-aware deep links to `app.qbo.intuit.com/app/<type>?txnId=<id>&realmId=<...>`. Response carries `qbRealmId` from `qb.getStatus()`.

### 5. Ship Calendar on /shipping (v1.32.0, v1.32.1)

User asked to copy the Ship Calendar from the Orders page to the Shipping page, with two key differences: (a) tile click opens a compact summary popup instead of the heavy edit drawer, (b) tile colors reflect *live* shipment status, not just shipped-or-not.

- **v1.32.0** — New sub-tab strip on `/shipping` (📅 Ship Calendar / 📦 Tracking). Calendar HTML/CSS/JS mirrors `orders-dashboard.html` but cross-references each order against `allShipments` from `/api/shipping-board` to pick a status class: in_production (orange) / in_transit (blue) / out_for_delivery (yellow) / delivered (green) / exception (red) / pending (gray). Click → new `#shipSummaryOverlay` popup with MDL(s), pallets, ship date, carrier+tracking, delivery date or ETA, destination, last tracking event.
- **v1.32.1** — Field-name fix. v1.32.0 read `s.status` off the shipping-board record but the actual field is `s.trackStatus` — lookup found the right shipment but the falsy access fell through to `'pending'` for every tile. Also corrected popup fields: `trackDelivered`/`trackEta`/`trackLastEvent`/`trackUpdated`/`city`+`state` (no `destination` field).

### 6. Shopify API authentication exploration (no code shipped)

Tried to get a static `shpat_` token so the Shopify-parts auto-invoice could pull canonical data (customer, address, line items, tax, shipping) instead of relying on HubSpot's deal-name-and-total mirror. Trail:

1. Tried "App automation token" from the new Shopify Dev Dashboard — confirmed via Shopify's own docs that this is CLI-only (`shopify app deploy`) and **cannot** authenticate against the Admin API.
2. Tried the legacy `/admin/settings/apps/development` URL on the merchant admin — redirects to the new Dev Dashboard. No way back to the old simple Custom App workflow.
3. Reviewed the OAuth callback option (~30 min of code: implement `/api/shopify/oauth/callback`, set the App URL in Dev Dashboard, reinstall, capture the token from the OAuth response, log it, paste into Railway). Real path but ~85% confidence first-try without iteration.
4. **Decision:** stick with the HubSpot-mirror fallback. The current code already has the fallback wired and surfaces "Data source: HubSpot mirror ⚠" in both the API response and the new dry-run preview dialog. For small parts orders the mirror is sufficient (deal name + total + contact email; tax handled via `TaxCodeRef:'NON'` per-line). If precision becomes a pain point, alternative paths considered: (a) install Intuit's official Shopify→QB integration and let it own all Shopify→QB sync (caveat: would auto-create QB records for booth orders too, requires reconciliation logic), (b) build the OAuth callback.

### 7. HubSpot workflow rewrite (no code in this repo)

While exploring the Shopify-data problem, realized the HubSpot workflow itself was CREATING NEW deals (Name + Total only) instead of TRANSITIONING the original Shopify-synced deals (which carry tax_price / order_number / source_store / line items / contact assoc) into our Sales Pipeline. User rewrote the workflow live during the session:

- Step 1: Set Owner = ecommerce@whisperroom.com (unchanged)
- Step 2: Branch on close date (unchanged)
- Step 3: Branch on Amount in company currency
  - ≥ $5,000 (booth) → Edit Deal Name + transition pipeline to Sales Pipeline / Verbal Confirmation
  - < $5,000 (parts) → Edit Deal Name only, leave in Order Pipeline (still owned by ecommerce, still shows in our Shopify drawer via owner_id filter)

Net effect: the original Shopify-synced deal is now the source-of-truth deal we read. Tax/source-store/line-item data should flow through automatically. Old duplicate deals from the prior workflow are orphaned in HubSpot — possible cleanup later. Resolves the v1.20.11 "Shopify deals invisible from Deal Hub" investigation (HubSpot search-index quirk no longer matters; we're not relying on multi-stage search filters).

### Workflow / process notes

- Promoted to main four times today: after v1.30.4 (Assembly Manual + Suppliers backend + email-reply logs + Shopify dry-run), after v1.31.2 (Assembly Manual SNV/ENV + ADA-vs-WA-UPG + light mode), after v1.32.1 (Ship Calendar + Suppliers drilldown fixes), and after v1.32.3 (this writeup). Rolling promotions kept staging-vs-prod drift small and let users start testing assembly-manual + suppliers in parallel.
- The user's pace today was significantly faster than usual — feedback came in tight loops (often "test → bug report → fix" within 5 minutes). Held to the workflow: version-bump every push, changelog entry every push, DEVLOG row every push. Worth it for traceability even at speed.

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
| 1.34.0  | 2026-05-21 | **AP / Audimute email-flow tweaks.** (1) Process Order shipping email auto-CCs Jill (`jholdway@whisperroom.com`) when the order has an AP item — she handles the Audimute step downstream. (2) Suppliers-dashboard `sendPoEmail` auto-CCs Benton (`bentonwhite@whisperroom.com`) for paper trail. (3) Deal Hub `submitApPoModal` create flow auto-opens the Audimute mailto draft after PO creation via new helper `_openAudimutePoDraft` — mirrors the suppliers-dashboard Send button (same subject/body/CC). Doesn't mark sent — that still requires hitting Send from the suppliers dashboard. |
| 1.33.2  | 2026-05-21 | **DEVLOG bookkeeping** — Current focus block updated post-promote; v1.33.1 is now the most recent on prod, staging clean. |
| 1.33.1  | 2026-05-21 | **Right-rail summary "Own Freight" label when Own Shipping is on.** Was falling through to "Not quoted" since the `else` branch of the Freight summary block only checked tbd/freight>0/else. Added an `else if (freightData?.ownShipping)` branch that renders italic muted "Own Freight". |
| 1.33.0  | 2026-05-21 | **Modify Order line items inline + Own Shipping toggle + T&C cleanup + process-order PDF upsert + logo → Deal Hub.** (1) Order-page line items table appends each addendum's `lineItems` (v1.19+) as highlighted rows below the originals — orange "Added" / red "Credit" badge. Order Adjustments totals block unchanged. (2) New "Own Shipping" button in the Freight Estimate area: when on, freight line renders as "Shipping: Client will arrange own shipping" on quote/order/invoice with $0 charge. Stored as `freightData.ownShipping`, mutually exclusive with TBD. (3) T&Cs simplified across quote builder + customer-facing pages: removed damage-reporting + standard-delivery clauses, added "WhisperRoom is not responsible for any issues or damages related to transportation." (4) `process-order` PDF upload switched to `gdriveUpsertFilePdf` so all three order flows hit the same find-or-update path. (5) WhisperRoom logo on every internal dashboard now wraps in `<a href="/deals">` — single-click bounce home. Customer-facing pages intentionally skipped. |
| 1.32.3  | 2026-05-20 | **DEVLOG: full session writeup for 2026-05-20.** Captured today's 18-version run across Assembly Manual, Email Reply logging, Suppliers tab, Ship Calendar, Shopify-parts preview + the Shopify auth investigation. Updated Current focus block + marked the v1.20.11 Shopify-deals-invisible investigation and the queued "Shopify Review column" task as RESOLVED/SUPERSEDED by the HubSpot workflow rewrite. |
| 1.32.2  | 2026-05-20 | **Supplier drilldown: payments filtered out + "Open in QB ↗" per row.** `_flattenVendorDetail` now drops any row where `TxnType` matches /payment/i (Bill Payment, Bill Payment Check, Bill Payment Credit Card, Credit Card Payment, plain Payment) — reps care about what was charged to AP, not how it got settled. Also captures the underlying transaction id from whichever `ColData[i].id` exposes it (skipping the account column's id). New `qbRealmId` field on the detail response (sourced from `qb.getStatus()` cached tokens — no fresh OAuth refresh). Frontend renders a new "QB" column with type-aware deep links: `app.qbo.intuit.com/app/<type>?txnId=<id>&realmId=<...>` where type ∈ {bill, expense, vendorcredit, check, journal, creditcardcredit}. Unknown types render a dash. Detail-modal header now reads "... · payments excluded" to make the filter explicit. |
| 1.32.1  | 2026-05-20 | **Ship Calendar: field-name fix — tiles were stuck on Pending.** v1.32.0 read `s.status` off the shipping-board record but the real field is `s.trackStatus`. Lookup was finding the right shipment but the falsy status fell through to `'pending'` for everything. Corrected the calendar status read + all the summary popup field names: `trackDelivered`/`trackEta`/`trackLastEvent`/`trackUpdated` instead of `delivered_at`/`eta`/`last_event`/`last_event_at`, and `city`+`state` (no `destination` field exists). Delivered popup now also shows "Signed: <name>" when present. |
| 1.32.0  | 2026-05-20 | **Ship Calendar on /shipping + status-aware tile colors + summary popup.** Sub-tab strip splits the page into "📅 Ship Calendar" (new, default) and "📦 Tracking" (existing table). Calendar HTML/CSS/JS mirrors `orders-dashboard.html` but tile colors now reflect live shipment status by cross-referencing each order's `order_data.shipped.tracking` against `allShipments` from `/api/shipping-board`: in_production (orange) / in_transit (blue) / out_for_delivery (yellow) / delivered (green) / exception (red) / pending (gray). Click any tile → new `#shipSummaryOverlay` popup instead of opening the orders drawer — shows status pill, MDL(s), pallets, ship date, carrier + tracking, delivery date, ETA, destination, last tracking event. Footer has "Open in Tracking →" + "View order ↗" jumps. `loadBoard()` now re-renders the calendar after shipments load so the Refresh button on Tracking tab also refreshes tile colors. |
| 1.31.3  | 2026-05-20 | **Suppliers tab: drilldown clicks fixed + "Not Specified" bucket separated out.** (1) `view →` links did nothing because the onclick attribute was `onclick="...openSupplierDetail(${JSON.stringify(...)})"` — the JSON-stringified value's double quotes broke the double-quoted HTML attribute. Switched to `data-vendor-id`/`data-vendor-name` attributes + a single delegated click listener on `#ssTable`. (2) QB tags transactions with no vendor as the literal `Not Specified` (sales tax filings, bank fees, payroll, journal entries — internal ops, not suppliers). Was showing up as a $790k 47% row. Now stripped from `rows` server-side and tracked as `notSpecifiedTotal` in the response; surfaced in the summary line as "+ $X uncategorized ⓘ" with a hover tooltip. Percentages now compute against named-vendor total only. |
| 1.31.2  | 2026-05-20 | **Assembly Manual: ADA vs WA UPG semantic distinction + light-mode support.** Per user: ADA line item = full package (ADA Door + Ramp + Elevated Floor — auto-cascade); WA UPG line item = just the Wide Access door alone (no Ramp, no EFP). Frontend pre-fill: `hasAdaFullItem = startsWith('ADA ')` triggers cascade; `hasWaUpgItem = startsWith('WA UPG')` only ticks ADA Door + ADA Size. Both still enable the door. Removed the v1.31.1 server-side `opts.ada → opts.efp=true, opts.ramp=true` cascade because it forced EFP+Ramp for WA UPG quotes too. Frontend checkbox state is now the source of truth. **Also:** modal was hard-coded to dark colors and looked broken on light theme — switched all surfaces, borders, text, and status colors to the existing `--surface/--text/--muted/--border/--accent/--red/--yellow/--green` CSS variables. Native `<option>` background set explicitly so dropdown popups follow theme too. |
| 1.31.1  | 2026-05-20 | **Assembly Manual: SNV/ENV → S/E normalization + ADA→EFP+Ramp cascade enforced server-side.** WhisperRoom doesn't ship dedicated no-vent manuals — SNV/ENV variants share Cover/Series/EFP PDFs with their vented S/E kin. `_stripMdlPrefix` strips `SNV → S` and `ENV → E` so file matches against names like `4848 S EFP.pdf` work for SNV models too. New `ctx.isNV` flag gates K + L ventilation sections off for SNV/ENV. Backend cascade: `opts.ada` → forces `opts.efp = true, opts.ramp = true` in `planSections` so the EFP+Ramp pull-in is guaranteed even if the frontend cascade misses or a rep accidentally unticks. Fixes "EFP not pulling when ADA is on quote." |
| 1.31.0  | 2026-05-20 | **Suppliers tab — UI + drilldown (steps 2 + 3 of 3).** New "Suppliers" tab on `/reports` driven by QB's `VendorExpenses` report. Range picker: YTD / 12m / this+last month / this+last quarter / custom. Sortable table (Vendor / Total / % of total). Click "view →" on a row → drilldown modal lists every Bill/Cash Purchase/CC Purchase for that vendor in range via `TransactionListByVendor`. New endpoint `GET /api/reports/supplier-spend/detail?vendorId=...&range=...` (+ `_supplierSpendDetailCache` 24h memory cache, keyed by vendor+range). New flatten helper `_flattenVendorDetail` walks QB's report by column type (ColType lookup) so it survives column reorders. "↻ Refresh" button on the tab busts the summary cache; same on drilldown modal. |
| 1.30.4  | 2026-05-20 | **Assembly Manual — EFP/Cover/Series file match fix + UX polish.** (1) Section config now matches on `ctx.modelStem` (model with `MDL ` stripped) for Cover/Series/EFP — files in those folders are named like `4848 S EFP.pdf`, not `MDL 4848 S EFP.pdf`. (2) ADA Size dropdown hardcodes the 4 canonical options (`4016, 4040, 4622, 4646`) so reps can build for rooms not on the current quote. (3) Build button shows a spinning indicator + modal stays closable during build (fetch runs async; download fires when ready). (4) Removed Overseas checkbox + retired section F (no longer relevant). |
| 1.30.3  | 2026-05-20 | **Assembly Manual modal — form + pre-fill rework.** Removed "Jack Panel (OLD)" checkbox (not used). Renamed "EFP (Window)" → "EFP (Elevated Floor Package)" — the underlying Drive files are still `EFP*.pdf`, just the label was wrong. Pre-fill detection switched from substring-only to a mix of starts-with prefix rules + substring rules: `RM `→rm, `ADA `/`WA UPG`→ada (+ auto-fill ADA Size from repWaType or first dropdown option), `SL `→studioLight, `EFP `→efp. Cascade rule: when ADA is detected (or WA Type is set on quote), Ramp + EFP get auto-ticked. Substring matching kept for HX, Bass Traps, MJP, AP, Step, Expansion. |
| 1.30.2  | 2026-05-20 | **Fix: supplier-spend QB report name.** v1.28.1 used `ExpensesByVendorSummary` which Intuit renamed to `VendorExpenses` in their API. Old name returns misleading code-5020 "Permission Denied" instead of 404, sent us chasing user roles. Switched to current names: `VendorExpenses` (summary), `TransactionListByVendor` (drilldown). |
| 1.30.1  | 2026-05-20 | **UI: move Admin Tools button into the Email Reply output panel.** v1.29.0 put it in the topbar, which is hidden in embed mode (when the page is iframed inside the Deal Hub popup). Moved to bottom-right of the Generated Reply panel + renamed "⚙ Logs" → "Admin Tools". Visible in both standalone and embedded modes; still opens logs viewer in a new tab. |
| 1.30.0  | 2026-05-20 | **Assembly Manual builder — quote-builder button + modal (step 2 of 2).** New "🛠 Build Assembly Manual" button in the quote-builder action stack. Modal pre-fills from current quote: MDL from first matching line item, ADA + ADA size from `repWaType` dropdown, checkboxes from substring scan of `lineItems[].name`. Rep verifies → POST `/api/assembly-manual/build` → PDF blob → triggers browser download. Status banner inside modal surfaces missing-section warnings via `X-Assembly-Missing` header. ADA Size dropdown clones options from the existing `repWaType` dropdown (one source of truth). Also: filter `/api/assembly-manual/models` to canonical naming pattern `MDL <digits>( LP)? (E\|S\|ENV\|SNV)` — drops typos like "MDL 9696 B" and "MDL 102186 CL Repl" that QB has accumulated. |
| 1.29.1  | 2026-05-20 | **Email reply logs — drop the admin gate.** v1.29.0 gated the viewer behind `ADMIN_REP_EMAILS`. Per user: any authed rep can see it. Removed the env var, `isAdmin(req)` helper, page+API gates, and `__IS_ADMIN__` injection on `/email-reply`. "⚙ Logs" button now always visible in topbar. |
| 1.29.0  | 2026-05-20 | **Email reply assistant — input/output logging + admin reviewer page.** Every `/api/email-reply` call writes a row to new `email_reply_logs` table (rep, voice, full input, full output, model, token usage, duration, status, error). Fire-and-forget so DB issues don't block the rep. New reviewer at `/email-reply-logs`: paginated list with substring filter, status chips, token counts, click-to-expand for full input+output side-by-side with copy buttons. Admin-gated via new env var `ADMIN_REP_EMAILS` (CSV of emails). `isAdmin(req)` helper added. "⚙ Logs" button in Email Reply topbar shows only to admins (server injects `__IS_ADMIN__` into the page at render time). v1 = logging + viewer only; feedback (thumbs up/down, edited-final capture) is v2. |
| 1.28.2  | 2026-05-20 | **Assembly Manual builder — backend (step 1 of 2).** Replaces the Excel/VBA workflow. New `lib/assembly-manual.js` (section config table + merge logic), new helpers `gdriveListFilesInFolder`+`gdriveDownloadFile` in `lib/gdrive.js` (latter uses native https for binary safety — `_httpsRequest` string-concats body and corrupts PDFs). Three endpoints: `GET /api/assembly-manual/models` (QB Item LIKE 'MDL %', 24h cache), `POST /api/assembly-manual/plan` (preview which sections will be included, no Drive reads), `POST /api/assembly-manual/build` (Drive lookup → pdf-lib merge → stream PDF). New dep `pdf-lib`. New env var `GDRIVE_ASSEMBLY_MANUALS_FOLDER` — set in Railway before testing, value = Drive folder ID of `Server/AssemblyManuals/`. Step 2 (button + modal + feature pre-fill on quote builder) is queued. |
| 1.28.1  | 2026-05-20 | **Supplier-spend report — backend (step 1 of 3).** New `GET /api/reports/supplier-spend?range=ytd|12m|month|lastmonth|quarter|lastquarter|custom` endpoint hits QB's `ExpensesByVendorSummary`, flattens the nested row/column tree, returns `[{vendor, vendorId, total}]` sorted desc + grand total + range metadata. 24h in-memory cache, `?refresh=1` to bust. `lib/quickbooks.js` adds generic `fetchReport(name, params)` + `fetchExpensesByVendorSummary` + `fetchExpensesByVendorDetail` (for the upcoming drilldown). UI (range picker, sortable table) is step 2 → v1.29.0. Drilldown is step 3 → v1.29.1. Test on staging by curling the endpoint or hitting it in browser while logged in. If QB returns 401 on scopes, we re-auth before continuing. |
| 1.28.0  | 2026-05-20 | **Shopify-parts: dry-run preview + payment fix + diagnostics.** (1) Click on Create QB Invoice now does a server-side dry-run first (`{dryRun:true}`) — assembles the full QB payload (addresses, line items, totals, memo, data source) without touching QB/Postgres/HubSpot. Frontend shows it in a confirm dialog so the rep verifies before committing. Idempotency check is informational (not 409) in dry-run, so you can preview even after a botched prior attempt without cleaning up the row. Uses `findCustomerByDisplayName` instead of `findOrCreateCustomer` in dry-run. (2) `quote-server.js:3264` referenced undeclared `contactName` (should be `customerName`) — threw `ReferenceError` every time → QB invoice created but payment step always failed with "Contact name not defined." (3) Endpoint returns `dataSource`+`shopifyError`; toast warns when Shopify fell back to HubSpot mirror. (4) Confirm-dialog wording trim (removed internal-plumbing bullets + "Cannot be undone"). |
| 1.27.0  | 2026-05-19 | **Shopify-parts QB invoice now uses Shopify as source of truth.** HubSpot mirror was deal name + total only — missing customer, address, line items, tax, shipping. New lib/shopify.js Admin API client. Server parses Shopify order # from deal name `/#(\\d+)/`, fetches canonical order, builds QB invoice from it: real ship-to + bill-to, customer name + email, itemized lines (SKU→QB item lookup with fallback), shipping as own line (mapped to QB "Shipping"/"Freight" item if available), tax as own line. Graceful fallback to v1.26.x HubSpot-only path if Shopify unavailable. Memo carries `[Data source: shopify\|hubspot]` for visibility. New env vars: SHOPIFY_ACCESS_TOKEN, SHOPIFY_STORE_DOMAIN (set on staging + prod). |
| 1.26.5  | 2026-05-19 | **Shopify-parts QB invoice — force zero tax + pass ship-to address.** v1.26.4 created invoices but QB AST added TN tax to non-nexus orders because no ship-to was passed (AST defaulted to company home state) AND line items weren\'t marked non-taxable so `globalTaxCalc:NotApplicable` alone wasn\'t enough. Three fixes: per-line `TaxCodeRef:\'NON\'` + BillAddr/ShipAddr from contact + TxnTaxDetail.TotalTax=0. Invoice now matches Shopify charge exactly. |
| 1.26.4  | 2026-05-19 | **Shopify-parts auto-invoice: collapsed-line fallback when HubSpot has no line items.** Shopify\'s HubSpot integration doesn\'t push line items onto deals for small parts orders — only name + amount. v1.26.0 errored 422 in that case. Now falls back to a single QB line: Item = "Shopify Order Line", Qty = 1, UnitPrice = deal.amount, Description = deal name (carries Shopify order #). Total still matches what Shopify charged. Itemized path still runs when HubSpot does have line items (rare for Shopify, common for app-built invoices). |
| 1.26.3  | 2026-05-19 | **Shopify drawer rows — type chip + left-edge color.** Each row now has a 🛋 Booth (blue) or 🛒 Parts (purple) chip + matching left-edge accent. Threshold matches server (≥$5k = Booth, <$5k = Parts). Tell at a glance which is which when scanning. |
| 1.26.2  | 2026-05-19 | **Shopify drawer: new "📋 Parts Orders — Needs QB Invoice" section + backdated cutoff.** Without a dedicated section, the only way to find a Shopify parts order was scrolling the Shipped column. Now the 🛒 drawer has a section listing every small Shopify deal (<$5k, post-cutoff) without a QB invoice yet — click row → opens deal → green Create QB Invoice button. /api/shopify-pending now returns small orders too + new `needsInvoiceCount` field. Drawer badge glows for BOTH booth verifications + parts-to-invoice. Also backdated SHOPIFY_QB_CUTOFF_DATE default from 2026-05-19 → 2026-05-12 (one week back) so existing orders are testable. |
| 1.26.1  | 2026-05-19 | **Hot-fix: Deal Hub board broken on v1.26.0** — `shopifyQbRes is not defined`. Added the new shopify_qb_invoices query to the /api/deals/list Promise.all but forgot to add the variable to the destructure. One-line fix. |
| 1.26.0  | 2026-05-19 | **Shopify parts orders — one-click QB invoice + mark paid.** Big green button on eligible Shopify deals (<$5k, ecommerce-owned, created >= 2026-05-19 cutoff) in Deal Hub overlay. Click → confirm → server pulls HS line items + contact, looks up each line by name in QB (fallback to generic "Shopify Order Line" with original name in description), createInvoice against shared "Shopify Web Orders" QB customer, createPayment for full amount (same QB_PAYMENT_METHOD_NAME + QB_DEPOSIT_ACCOUNT_NAME as regular process-order), patches HS deal payment_status=paid. New `shopify_qb_invoices` table (deal_id PK) is the idempotency key. Cutoff date prevents double-invoicing historicals. Backfill link "Mark as already invoiced manually →" for cleanup. Tax handled as line-items-as-is with globalTaxCalc:NotApplicable (revenue includes tax for now; iterate later if accounting needs separate treatment). New env vars: SHOPIFY_QB_CUSTOMER_NAME, SHOPIFY_QB_FALLBACK_ITEM_NAME, SHOPIFY_QB_CUTOFF_DATE. **Required setup in QB**: create non-inventory item named "Shopify Order Line" (server returns 503 with clear instructions if missing). |
| 1.25.3  | 2026-05-19 | **Quote Builder pre-flight: look up by quote_number, not stale deal_id.** v1.25.2 fallback to /api/quote-snapshot returned `quotes.deal_id` which is STALE after a Merge Deal. Reproed: W-1105142607 quotes.deal_id=60256026416, but the actual current deal post-merge is 60256150594. New endpoint GET /api/deal-payment-status-by-quote/:quoteNumber searches HubSpot for invoice by quote_number → walks association to current dealId → looks up payment row. Deal Hub side unchanged. |
| 1.25.2  | 2026-05-19 | **Quote Builder pre-flight: resolve dealId reliably even on loaded quotes.** v1.25.1 relied on `window._lastPushedDealId` / `linkedDeal` / `selectedDeal` globals which don\'t get populated on all quote-load paths — so the check silently no-op\'d for loaded historical quotes. Now falls back to /api/quote-snapshot/:quoteNumber lookup for the dealId. Added `[pay-preflight]` console logs for debugging. Extracted into `_payClearanceCheck(quoteNumber)` helper. |
| 1.25.1  | 2026-05-19 | **Payment pre-flight warning fires immediately at button click, both Process Order buttons.** v1.25.0 buried the check inside `confirmProcessOrderFromHub` so it only fired after the rep filled out the whole modal. Moved to the button click — Deal Hub blue "Process →" button (`processOrderFromHub`) and Quote Builder orange "📦 Process Order" button (`openOrderModal`). New endpoint GET /api/deal-payment-status/:dealId returns just the payment row so Quote Builder (which doesn't cache the deal list) can hit it cheaply. Deal Hub prefers its in-memory cache and falls back to the endpoint only when the deal isn't there. |
| 1.25.0  | 2026-05-19 | **Payment-state chips + ACH clearing soft-warning.** New `deal_payment_status` table mirrors each deal\'s latest HubSpot Commerce Payment. Deal Hub card shows amber "💳 ACH clearing · funds 5/20" while in flight, green "✓ Funds available" once succeeded past payout date, green "✓ CC Paid" for cards, pulsing red "🚨 Payment failed" when failed/reversed (the fraud case). Process Order modal soft-blocks (confirm dialog) if ACH not yet cleared or payment failed. Two write paths: existing /api/webhooks/invoice-paid extended to upsert payment data instantly, plus new 30-min polling sync of `commerce_payments` for everything else. notifyRep fires on pending→succeeded (ACH only) and any→failed transitions, debounced via *_notified_at columns. We don\'t compute the 3-vs-4-weekday math — HubSpot already does it as `hs_estimated_payout_date`. Throwaway debug endpoints from earlier in v1.24.x (hs-invoice + hs-invoices-for-deal) removed; recoverable in git at 3947d7c, 70882b5. |
| 1.24.6  | 2026-05-19 | **Intl shipping email — drop parenthetical from SHIPMENT VALUE.** Removed the "(for insurance, products only — excludes freight & tax)" tail from v1.24.5. Line now reads just `SHIPMENT VALUE: $X,XXX.XX`. |
| 1.24.5  | 2026-05-19 | **International Shipping Request — SHIPMENT VALUE line added for insurance calc.** Overseas-quote email modal already emitted name / address / pallet dims / total weight. Added `SHIPMENT VALUE: ${fmt(sub - disc)} (for insurance, products only — excludes freight & tax)` directly below TOTAL WEIGHT so freight forwarder can quote insurance. Value is line-item subtotal minus discount (post-discount product price). |
| 1.24.4  | 2026-05-18 | **Email Reply popup — shrink modal, keep panel sizing.** v1.24.3 stretched panels to fill iframe (felt too big). Reverted that — panels back to natural `min-height:520px`. Instead shrunk the modal itself from 88vh / max 900px down to 600px (max-height: 92vh). Popup\'s bottom edge now lands right at the Generate Reply button. |
| 1.24.3  | 2026-05-18 | **Email Reply popup polish.** (1) Panels now fill the iframe height — bottom 30-40% was dead space because panels had `min-height:520px` while iframe was 88vh. Embed mode now locks body to 100vh, kills the panel min-height, panels use `height:100%`. (2) Voice auto-selected from logged-in rep via /api/me ownerId mapping (Jill 36330944, Sarah 38143901, Travis 117442978). Soft default — doesn\'t overwrite an explicit localStorage choice. Reps outside the supported set stay blank. |
| 1.24.2  | 2026-05-18 | **3 fixes.** (1) Shopify Orders drawer now ≥$5k only — small parts auto-ship orders don\'t need sales-team quotes, dropped "Small Orders" section entirely. Server-side filter in /api/shopify-pending so badge count also drops. (2) Shopify deals now ACTUALLY appear on the Deal Hub board — re-surfaced the v1.20.11 finding that HubSpot\'s multi-stage `dealstage IN [...]` search is unreliable for ecommerce-owned deals. Added a dedicated ecommerce-owner catch-all pass to /api/deals/list mirroring the closedwon catch-all: filters by `hubspot_owner_id = ECOMMERCE_OWNER_ID` + `dealstage IN BOARD_STAGES`, paginated up to 500. Runs on default load (no stage/q/rep). (3) Email Reply popup now inherits dark mode from the parent dashboard via new `?theme=dark` query param — opening it in dark mode was previously a wall of bright white. |
| 1.24.1  | 2026-05-18 | **Email Reply Assistant — icon-only popup, not new tab.** Moved entry point from "✉️ Email Reply" link on the LEFT of the Deal Hub topbar (which opened a new tab) to a ✉️ icon-only button on the RIGHT side next to the theme toggle. Click opens a modal that iframes `/email-reply?embed=1` so reps stay on the Deal Hub. Modal: 88vh × max-1180px wide, dimmed backdrop. Close via ✕, ESC, or backdrop click. Iframe is lazy-loaded on first open. New `?embed=1` query param suppresses the email-reply page\'s own topbar + footer when iframed. Standalone `/email-reply` URL still works for anyone who bookmarks it. |
| 1.24.0  | 2026-05-18 | **Email Reply Assistant — ✉️ button in Deal Hub topbar.** Opens a paste-and-generate tool in new tab. Rep picks voice (Jill/Sarah/Travis), pastes customer email or HubSpot lead notification, hits Generate, gets a reply with the correct spec PDF + YouTube overview URLs auto-injected, copies to clipboard. Single-shot. Vendored from Gabe\'s gabewhite438/whisperroom-reply-assistant: system-prompt.txt (~1900 lines of locked phrases, voice templates, no-em-dash rule, product facts), product-links.json (71 products → spec + overview), product-specs.json (scraped specs). Anthropic call goes through new POST /api/email-reply server proxy with API key server-side + prompt caching (cache_control:ephemeral). Frontend post-processing intact: em-dash scrub, URL force-injection into three-link blocks, intro-line replacement with each rep\'s exact preferred opening, existing-customer detection bypasses formal intro replacement. Requires new env var ANTHROPIC_API_KEY in Railway (both staging + prod). See assistant/README.md for the update procedure when Gabe ships changes upstream. |
| 1.23.2  | 2026-05-18 | **Sales Goal — three polish tweaks.** (1) Tier badges say "+5% BONUS / +10% BONUS / +15% BONUS" (was "SALARY") — clearer it\'s additional payout, not base-pay change. (2) Deal count shown under each month abbreviation in the 12-mo chart so a low-revenue month's cause (low volume vs low AOV) is visible at a glance. (3) Fixed "120% — $617K" tick label getting clipped at the right edge — tick sits at left:100% so the centered label was extending half-off-container. Now right-anchored (left:auto; right:0). |
| 1.23.1  | 2026-05-18 | **Sales Goal report — progress bar layout fix.** MTD-stats text on the right and tier labels (90 / 100 / 120) were stacking on the same horizontal band above the bar, crashing into each other ("39.4% of 100% goal · No tier yet · $259,904 to 5% tier" was getting visually mangled). Tier labels moved below the bar (`bottom:-22px`); right-side header text stacked vertically with right-align + flex-wrap so it reflows cleanly. Removed redundant `$0` / `$617K` endpoint labels since the tier labels under the bar convey position. |
| 1.23.0  | 2026-05-18 | **Sales Goal report — monthly bonus tier dashboard, top of /reports.** New default sub-tab "Sales Goal" shows 12-month moving average of net revenue (Closed Won + Shipped, amount minus tax, freight included) and publishes the month's 100% goal (= moving avg × 1.05) + 90% / 120% tiers driving the sales-team monthly salary bonus (5% / 10% / 15%, step function, capped). Goal locks at month start. UI: hero with target + 3 tier badges (active tier glows), MTD progress bar with tier marks, 12-month bar chart w/ moving-avg dotted line, data-quality footer (deals using HubSpot total_tax_amount vs back-calc from tax_rate for legacy). Endpoint GET /api/reports/sales-goal — paginates dealstage IN [closedwon, 845719] over 13-month window, buckets closedate in EST, prefers total_tax_amount with rate-calc + nexus-aware freightTaxable fallback. Includes Shopify ecommerce deals (owner 49384873). 5-min in-memory cache shared across viewers. |
| 1.21.10 | 2026-05-15 | **HubSpot freight_cost / amount / tax sync gaps — 3 connected fixes.** (1) /api/process-order: closedwon PATCH was missing amount/tax_rate/freight_cost/discount — only dealstage+total_tax_amount+ap_color+payment_type went through. Freight LINE ITEM rebuilt but deal-level freight_cost stayed stale if rep edited freight between create and process. Now closedwon PATCH carries full final-state financials (this is the LAST sync; deal locks after). (2) /api/create-deal open-stage path: dealPatchProps was missing freight_cost (had amount/tax/discount). Added with the same delivery_install carve-out as the new-deal-create branch. (3) /api/create-deal locked-stage path: the 2026-05-13 carve-out that financial-PATCHed closed deals on every new quote creation was overreaching — Merge/Modify each have their own endpoints (/api/deals/:id/merge, /api/orders/:q/add-charge) and never touch /api/create-deal. Removed. Closed deals are now read-only from /api/create-deal; use Modify Order to update closed-deal financials. |
| 1.21.9  | 2026-05-15 | When a rep manually picks "Ecommerce" in the rep dropdown, auto-redirect to the logged-in user as deal owner + show a toast. Reps shouldn't own deals as ecommerce/Shopify; that's reserved for auto-created Shopify deals. Programmatic sets (loadDeal restoring a Shopify deal's owner) don't fire the handler, so existing Shopify ownership stays intact when re-opened. |
| 1.21.8  | 2026-05-15 | **Critical:** stuck "Creating Quote" spinner when rep selected "Ecommerce" as owner. Dropdown had `value="ecommerce"` (string) instead of numeric HubSpot user ID — HubSpot rejected, error swallowed, spinner forever. Fix: dropdown value changed to `49384873`; REP_NAMES + REP_NUMBERS maps updated. Server-side normalizes legacy `'ecommerce'` string to `ECOMMERCE_OWNER_ID` as belt-and-suspenders. Affected: anyone who picked Ecommerce in the rep dropdown (Jill hit this today). |
| 1.21.7  | 2026-05-15 | Three changes: (1) Revert v1.21.6 weight-display change — per-unit display is what reps prefer. Renamed column header to "Unit Weight" for clarity. (2) Quote summary now shows "Tax Exempt" instead of "Not calculated" when tax-exempt is checked. (3) Create-deal fetch has 90s hard timeout — hung HubSpot/QB calls now surface as a clear error instead of spinner-spinning-forever (addresses recent stuck-on-Creating-Quote report). |
| 1.21.6  | 2026-05-15 | Fix: line-item Weight column now shows line total (per-unit × qty), matching adjacent Total column. Previously qty change didn't update displayed weight — confusing reps even though freight calcs were using the correct multiplied number. `item.weight` storage stays per-unit; edits get divided by qty before storing. Tooltip on input. |
| 1.21.5  | 2026-05-15 | Fix: Shopify Orders button invisible in light mode. Used hardcoded `rgba(255,255,255,.08)` bg + `#f0ede8` text instead of theme-aware CSS vars. Switched to `var(--surface2)`/`var(--text)`/`var(--border)`; glow uses `var(--orange-dim)` + `var(--orange)` so it scales per theme. Badge re-themed too. |
| 1.21.4  | 2026-05-15 | Ecommerce-owned Shopify deals no longer excluded from main Deal Hub board. They now show on the board (in whatever HubSpot stage they're in — typically Shipped from the integration's auto-workflow) AND in the Shopify drawer. Both surfaces are useful: drawer = curated verification lens with glow; board = full pipeline view. Ownership stays at ecommerce@whisperroom.com after merge (per user's call — these aren't rep deals, shouldn't count toward individual pipeline graphs). Reverts the v1.21.0 server-side filter + v1.21.1 `_shopify` flag client workaround. |
| 1.21.3  | 2026-05-15 | Shopify drawer button now shows "🛒 Shopify Orders" instead of just the emoji. Matches uppercase letter-spacing of the other board-toolbar elements. |
| 1.21.2  | 2026-05-15 | Merge Deal modal now has a "⇅ Swap Direction" button on the confirm step. Previously merge was strictly one-way (deal you started from = always "delete" side). Now after picking both deals you can flip which one survives. Useful for the Shopify workflow: open a Shopify auto-deal in the drawer, click Merge Into, search for the existing deal that has quotes, swap direction so Shopify is the survivor — the existing deal's quotes/orders/folder move INTO Shopify and the existing deal gets deleted. Step 2 confirm UI redesigned: red "Delete" card on top, swap button between, green "Keep" card below. Header label updates in sync with current Delete side. |
| 1.21.1  | 2026-05-15 | Three fixes from v1.21.0 user feedback: (1) Moved 🛒 button into the board-toolbar next to the rep filter (was in main topbar). (2) Filter Shopify drawer to only show deals created on or after `SHOPIFY_CUTOFF_DATE` (default 2026-05-12) — was showing historical clutter. Server filters via HubSpot `createdate GTE` filter; sort changed to createdate DESC. (3) Fixed deal overlay showing just "Deal" header when opened from drawer — `renderHub` looks up deal in `allDeals` but v1.21.0 excluded Shopify deals from it. Now they're merged back into allDeals with a `_shopify:true` flag, and `renderBoard` filters that flag out so they stay drawer-only. |
| 1.21.0  | 2026-05-15 | New 🛒 Shopify Orders drawer in Deal Hub topbar — slide-out panel listing all ecommerce-owned deals in three sections (Awaiting Verification ≥$5k+no quote, Small Orders no quote, In Progress/Quoted). Button glows orange with pulse animation when pending booth orders exist; neutral count badge otherwise. Polls every 60s. Click row → standard deal hub overlay → "+ New Quote" → normal quote flow. Also: Deal Hub board auto-refreshes every 60s (matches admin-log pattern). Also: ecommerce-owned deals excluded from main `/api/deals/list` board — drawer is their home, sidesteps the HubSpot search quirk from yesterday. New endpoint `GET /api/shopify-pending`. Configurable via `ECOMMERCE_OWNER_ID` + `SHOPIFY_VERIFY_THRESHOLD` env vars. |
| 1.20.12 | 2026-05-14 | Revert of v1.20.11 — the Shipped catch-all pass surfaced more old shipped deals but did NOT find the actual Shopify deal the rep was hunting, so the underlying problem is elsewhere (likely the Shopify deal has a different internal stage ID than 845719 even though display name is "Shipped"). Reverting while we investigate to keep the board clean. |
| 1.20.11 | 2026-05-14 | Fix: Shipped deals silently dropping off the Deal Hub. `/api/deals/list` had a dedicated catch-all pass for `closedwon` (fetches all regardless of recency) but not for `845719` (Shipped) — so once the main 1000-deal paginated list rolled past a shipped deal, it disappeared. Refactored the catch-all into a shared helper, now runs for both closedwon AND 845719. Same 10-page cap per stage. Surfaced when a Shopify-generated deal in Shipped didn't appear on the board for any rep. |
| 1.20.10 | 2026-05-14 | Two workflow upgrades on `invoice.paid`: (1) Deal cards in Deal Hub turn green when an invoice is paid (Stripe `snap.stripe.status=paid`, toggle-gated, OR HubSpot `payment_status=paid`) — adds to the existing accepted/payment-type triggers. (2) Stripe webhook auto-advances the HubSpot deal stage to "Verbal Confirmation" (`contractsent`) when payment lands, IF the deal is in an earlier stage. Skips `contractsent`/`closedwon`/`845719`/`closedlost` to never walk a deal backwards. New log events: `stripe.deal-stage-advanced`, `stripe.deal-stage-noop`, `error.stripe.deal-stage`. |
| 1.20.9  | 2026-05-14 | Critical fix — Stripe webhook was returning 401 on every delivery since v1.20.0 shipped, because `/api/stripe/webhook` wasn't in the public-routes allowlist (quote-server.js:564 global auth middleware rejects API requests without a session cookie; Stripe doesn't have one — it authenticates via signed body). Caught by inspecting Stripe Workbench → Event deliveries (9+ 401 ERR attempts visible). Added webhook path to `isPublicRoute`. Signature verification in the handler is preserved. Already-failed events retry automatically over the next hour; clicking "Resend" in Stripe dashboard triggers immediate replay. |
| 1.20.8  | 2026-05-14 | Deal Hub invoice rows now reflect Stripe payment status. Webhook-driven `json_snapshot.stripe.status` is overlaid onto the HubSpot-sourced invoice list — when Stripe says paid, the row goes green/Paid with a purple "Stripe" badge. New "Stripe ↗" link jumps to the Stripe Dashboard page for that invoice (test/live auto-detected from key prefix). The `/admin-log` Stripe toggle now also gates this overlay: when OFF, server skips the Stripe data entirely and Deal Hub renders pure HubSpot status (Stripe-paid invoices will look "open" — intended bail-out). HubSpot status not patched back — deferred (proper sync would create HubSpot Payment records via API; manual `hs_invoice_status` patches may not stick because HubSpot computes it from Payment records). |
| 1.20.7  | 2026-05-14 | ACH + wire transfer enabled on Stripe invoices. New `Wire Transfer` checkbox alongside existing CC and ACH in both the quote-builder Create Invoice modal (`invoiceAllowWire`) and the deal-hub mini modal (`dhInvoiceAllowWire`); all three default ON. `lib/stripe.js` builds `payment_settings.payment_method_types` dynamically from `allowCC` / `allowACH` / `allowWire`, and when wire is on adds the required `customer_balance.bank_transfer.type: us_bank_transfer` config (Stripe rejects without it). Defensive guard: wire silently drops with a `stripe.invoice.wire-dropped` log if the customer has no name (Stripe `customer_balance` requires one). Days-until-due stretches from 7 → 14 when ACH is on so legit payers don't see "past due" reminders before ACH clears (4–5 business days). `paymentMethods` + `daysUntilDue` added to `stripe.invoice.created` log meta. Use case: uncheck CC on $50k+ orders to skip the 3.4% fee — the existing $50k CC fee warning surfaces this dynamically. |
| 1.20.6  | 2026-05-13 | Stripe hosted invoice discount now renders as a single "Discount" row under the subtotal instead of per-line `(N% off, was $X)`. `lib/stripe.js` creates a one-shot Stripe Coupon (`percent_off`, `duration:once`, `max_redemptions:1`, named after the quote) and attaches it via `discounts[]` on the invoice. Freight/tax/install invoiceitems are marked `discountable:false` so the coupon only applies to product lines — same scope as HubSpot's `hs_discount_percentage`. `/api/create-invoice` passes `discountPct` through; `previewTotalCents` reworked to mirror Stripe's aggregate-then-round math (matches `amount_due` to the cent). Polish: added a friendly `footer` and surfaced Quote Number + Deal ID as `custom_fields` for customer-support traceability. Logo/brand color/business name are configured separately in Stripe Dashboard → Settings → Branding (one-time, no code). |
| 1.20.5  | 2026-05-13 | Stripe invoices now honor the quote-level discount. HubSpot's path was passing `hs_discount_percentage` on each line; Stripe has no per-line percentage field, so the discount was silently dropped (Stripe total = gross instead of net). `lib/stripe.js` now bakes `item.lineDiscount` into the cents amount on each `/v1/invoiceitems` POST and appends "(N% off, was $X)" to the description for customer transparency. Only product lines carry `lineDiscount` (freight/tax/install carry 0), so the discount stays product-only — same scope as HubSpot. `/api/create-invoice`'s `previewTotalCents` calc updated to match so the fail-loud guard does not misfire on discounted invoices and the success log shows the actual expected net. |
| 1.20.4  | 2026-05-13 | Fixes the Stripe doubling bug found on the first v1.20.3 test (invoice ~2× expected). v1.20.3's `pending_invoice_items_behavior: include` worked but ALSO swept in orphan pending invoiceitems left over from pre-v1.20.3 failed runs (every attempt created invoiceitems that never attached to anything → accumulated on the customer). Fix: draft the (empty) invoice FIRST in `lib/stripe.js`, then create each invoiceitem with `invoice: draft.id` so it attaches directly. No pending-bucket interaction. `pending_invoice_items_behavior: exclude` set explicitly. Stale pending invoiceitems on test customers from earlier runs are now harmless but worth cleaning up via Stripe dashboard (test mode). |
| 1.20.3  | 2026-05-13 | Fixes today's $0-Stripe-invoice bug: real quote with line items was finalizing as a $0 hosted invoice. Root cause: `lib/stripe.js` was POSTing to `/v1/invoices` without `pending_invoice_items_behavior:'include'`. Stripe's default flipped to `exclude` in API version 2022-11-15, so the freshly-created `/v1/invoiceitems` never attached to the draft. Existing `/api/debug/stripe-diagnostic` already had the flag (which is why diagnostic invoices worked end-to-end on May 12 but the first real rep-flow attempt today did not). Also added a fail-loud guard: caller now passes `expectedTotalCents` and `lib/stripe.js` throws if Stripe returns `amount_due=0` when we expected positive — surfaces as `error.stripe.invoice` instead of a silently empty invoice. |
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
