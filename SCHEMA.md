# Postgres Schema

Single-page reference for the WhisperRoom Quote Builder Postgres schema. Source of truth is the `CREATE TABLE` statements in `lib/db.js`, `lib/freight.js`, and `quote-server.js` — this file mirrors them in human-readable form.

All tables auto-create on server startup via `initDb()` (`lib/db.js:31`) and `initTrackingCache()` (`lib/freight.js:25`). The `orders` table is created lazily on the first `process-order` call (`quote-server.js:8771`).

Last verified: 2026-05-08, against v1.7.33.

---

## Tables at a glance

| Table              | Purpose                                       | Owner (write)                | Reader(s)                       |
|--------------------|-----------------------------------------------|------------------------------|---------------------------------|
| `quotes`           | Every quote created, with full snapshot       | `lib/db.js`, `quote-server.js` | most pages, all dashboards       |
| `orders`           | Quotes that have been processed into orders   | `quote-server.js`            | orders-dashboard, deal-hub       |
| `supplier_pos`     | Audimute supplier POs (sales-rep, drop-ship)  | `quote-server.js`            | suppliers-dashboard, deal-hub    |
| `vendors`          | WR PO System vendor catalog (Josh's home, supply-chain) | `quote-server.js`  | vendors-dashboard (v1.48+)       |
| `vendor_pos`       | WR PO System purchase orders (Josh's POs to vendors) | `quote-server.js`  | vendor-pos-dashboard (v1.49+)    |
| `sessions`         | Logged-in rep sessions                        | `lib/auth.js`                | every authenticated request      |
| `notifications`    | Per-rep notification feed                     | `lib/notify.js`              | admin-log, dashboards (badge)    |
| `logs`             | Admin/event log                               | `lib/logger.js` (`writelog`) | admin-log page                   |
| `kv_store`         | Generic key-value (OAuth tokens, settings)    | `quote-server.js`, `lib/quickbooks.js` | OAuth flows, integrations |
| `reconcile_links`  | Confirmed HS deal ↔ QB invoice pairings       | `reconcile.html` actions     | reconcile page                   |
| `reconcile_blocks` | Explicitly-rejected pairings                  | `reconcile.html` actions     | reconcile page                   |
| `tracking_cache`   | Freight tracking results, polled ~every 30min | `lib/freight.js`             | shipping-dashboard, order pages  |
| `components_inventory` | On-hand per component code (PL migration Phase 2) | `lib/inventory.js`   | inventory-dashboard (v1.88+)     |
| `inventory_transactions` | Append-only audit of every stock move   | `lib/inventory.js`           | inventory-dashboard (audit views)|

---

## quotes

The big one. Every quote becomes a row. The `json_snapshot` JSONB carries the full quote state (line items, customer, freight, tax, etc.) — most read paths pull from this rather than the broken-out columns.

| Column            | Type           | Notes                                                                   |
|-------------------|----------------|-------------------------------------------------------------------------|
| `id`              | SERIAL PK      |                                                                         |
| `quote_number`    | TEXT UNIQUE    | `W-<8-digit dateKey><2-digit seq>` (e.g. `W-1605082601`). See HANDOFF §7. |
| `deal_id`         | TEXT           | HubSpot deal ID                                                         |
| `contact_id`      | TEXT           | HubSpot contact ID                                                      |
| `deal_name`       | TEXT           |                                                                         |
| `customer_name`   | TEXT           | Concatenated `firstName lastName` from snapshot                         |
| `company`         | TEXT           |                                                                         |
| `rep_id`          | TEXT           | HubSpot owner ID; mapped to a 2-digit prefix in `SERVER_REP_NUMBERS`    |
| `total`           | NUMERIC(12,2)  |                                                                         |
| `date`            | TEXT           | Display date string (not a real DATE)                                   |
| `quote_link`      | TEXT           | `${PUBLIC_BASE_URL}/q/${quote_number}`                                  |
| `json_snapshot`   | JSONB NOT NULL | **Source of truth for quote contents.** See JSONB shapes below.         |
| `payment_link`    | TEXT           | Payment URL after invoice creation                                      |
| `order_link`      | TEXT           | `${PUBLIC_BASE_URL}/order/${quote_number}` once converted               |
| `share_token`     | TEXT           | 12-char hex; used by `/q/:quoteNumber` public viewer                    |
| `gdrive_folder_id`| TEXT           | Google Drive folder for this deal's PDFs                                |
| `created_at`      | TIMESTAMPTZ    | Default NOW()                                                           |

**Indexes:** `quote_number`, `deal_id`, `contact_id`, `rep_id`, `created_at DESC`, `lower(company)`, `lower(customer_name)`.

**Common reads:** `getQuoteFromDb(quoteNumber)`, `searchQuotesInDb(query, repId, limit, offset)`, `fetchQuoteHistory()` — all in `lib/db.js`.

**Upsert pattern:** `saveQuoteToDb()` uses `ON CONFLICT (quote_number) DO UPDATE` with `share_token` preserved (`COALESCE(quotes.share_token, EXCLUDED.share_token)`) so replays don't churn the customer's link.

---

## orders

Created lazily on first `/api/process-order`. Lighter shape than `quotes` — just a pointer + the order-specific data captured at processing time.

| Column         | Type           | Notes                                     |
|----------------|----------------|-------------------------------------------|
| `id`           | SERIAL PK      |                                           |
| `quote_number` | TEXT UNIQUE    | FK-by-convention to `quotes.quote_number` |
| `deal_id`      | TEXT           |                                           |
| `order_data`   | JSONB          | Order specs, AP color, customs broker, payment type, etc. |
| `created_at`   | TIMESTAMPTZ    |                                           |

`UPDATE quotes SET order_link = $1` runs immediately after the insert, linking the quote row to the order viewer URL.

---

## supplier_pos

Audimute Purchase Orders (system extends to other suppliers — `supplier` column defaults `'audimute'`).

| Column               | Type            | Notes                                                          |
|----------------------|-----------------|----------------------------------------------------------------|
| `id`                 | SERIAL PK       |                                                                |
| `po_number`          | TEXT UNIQUE     | `WR{YY}{MM}{DD}{NN}` (v1.7.31+, e.g. `WR26050801`)             |
| `quote_number`       | TEXT NOT NULL   | The order this PO fulfills                                     |
| `deal_id`, `deal_name` | TEXT          |                                                                |
| `supplier`           | TEXT NOT NULL   | Default `'audimute'`                                           |
| `supplier_email`     | TEXT NOT NULL   | e.g. `ewade@audimute.com`                                      |
| `share_token`        | TEXT UNIQUE NOT NULL | Used by `/po/:poNumber` public viewer                     |
| `status`             | TEXT NOT NULL   | `pending` → `sent` → `confirmed` → `shipped` → `complete`      |
| `po_data`            | JSONB           | Per-line items (qty, color, panel breakdown, wholesale cost), ship-to, notes |
| `sent_at`            | TIMESTAMPTZ     | Set when mailto draft fired                                    |
| `expected_ship_date` | DATE            | Inline-editable on Suppliers dashboard                         |
| `tracking_number`    | TEXT            | Inline-editable                                                |
| `shipped_at`         | TIMESTAMPTZ     |                                                                |
| `notes`              | TEXT            |                                                                |
| `created_by`         | TEXT            | Rep email or owner ID                                          |
| `created_at`         | TIMESTAMPTZ     |                                                                |

**Indexes:** `quote_number`, `(status, created_at DESC)`.

---

## vendors

Catalog of suppliers for the new WR PO System (v1.48+). Parallel to `supplier_pos` (which holds Audimute drop-ship POs) — this is the supply-chain side that Josh owns. Will be joined by `vendor_pos` (v1.49+) when the PO create flow ships.

| Column                       | Type            | Notes                                                          |
|------------------------------|-----------------|----------------------------------------------------------------|
| `id`                         | SERIAL PK       |                                                                |
| `name`                       | TEXT UNIQUE     | Display name (e.g. `Bertelkamp Automation, Inc.`)              |
| `address_lines`              | JSONB           | `["P.O. Box 11643", "Knoxville, TN 37939-1643"]`               |
| `phone`                      | TEXT            |                                                                |
| `contacts`                   | JSONB           | `[{name}]` — who to address (multiple OK)                      |
| `send_to_emails`             | JSONB           | TO recipients on the mailto draft                              |
| `cc_emails`                  | JSONB           | CC recipients                                                  |
| `billing_address_override`   | TEXT            | NULL = default WR billing addr; set for Foss-style overrides   |
| `payment_terms`              | TEXT            | e.g. `1%10, Net 30`                                            |
| `freight_terms`              | TEXT            | e.g. `Ship COLLECT via ABF Account #189059`                    |
| `standard_notes`             | TEXT            | Always-on PO notes (e.g. foam tolerances)                      |
| `catalog`                    | JSONB           | `[{id, sku, description, mfg, mfg_part_no, default_qty, unit_price, price_updated_date}]` |
| `archived`                   | BOOLEAN         | Soft delete                                                    |
| `created_by`                 | TEXT            |                                                                |
| `created_at`, `updated_at`   | TIMESTAMPTZ     |                                                                |

**Indexes:** `lower(name)`, `(archived, lower(name))`.

---

## vendor_pos

Vendor Purchase Orders for the WR PO System (v1.49+). Parallel to `supplier_pos` (Audimute). `vendor_snapshot` freezes the vendor row at PO creation time so historical POs stay correct when Josh edits a vendor record later.

| Column                | Type            | Notes                                                          |
|-----------------------|-----------------|----------------------------------------------------------------|
| `id`                  | SERIAL PK       |                                                                |
| `po_number`           | TEXT UNIQUE     | `WP-{YY}{MM}{DD}{NN}` (e.g. `WP-26052901`). Older PO numbers created before v1.49.13 used the `WV-` prefix; both formats coexist. |
| `vendor_id`           | INT FK          | References `vendors(id)`; `ON DELETE SET NULL` for safety      |
| `vendor_snapshot`     | JSONB           | Frozen vendor row at creation time                             |
| `share_token`         | TEXT UNIQUE     | Used by `/vpo/:poNumber` viewer                                |
| `status`              | TEXT NOT NULL   | `DRAFT` → `APPROVED` → `SENT` → `PARTIAL` → `RECEIVED` → `CLOSED` (+ `CANCELLED`) |
| `po_data`             | JSONB           | `{lines:[{itemId,sku,description,mfg,mfg_part_no,qty,unit_price}], notes}` |
| `received_data`       | JSONB           | Phase 2 (v1.50+) — per-line receive state                      |
| `invoice_data`        | JSONB           | Phase 2 (v1.50+) — Kim's invoice match                         |
| `approved_at`         | TIMESTAMPTZ     | Stamped on Approve                                             |
| `sent_at`             | TIMESTAMPTZ     | Stamped on Send (mailto fires)                                 |
| `expected_date`       | DATE            | Inline-editable                                                |
| `received_at`         | TIMESTAMPTZ     | Phase 2                                                        |
| `closed_at`           | TIMESTAMPTZ     | Phase 2                                                        |
| `pdf_drive_file_id`   | TEXT            | Drive file ID; reused on PDF re-upload so edits overwrite      |
| `created_by`          | TEXT            | Rep owner ID                                                   |
| `created_at`, `updated_at` | TIMESTAMPTZ |                                                                |

**Indexes:** `(vendor_id, created_at DESC)`, `(status, created_at DESC)`.

---

## sessions

Created on HubSpot OAuth callback. Memory-cached but DB is source of truth (see HANDOFF §9).

| Column       | Type        | Notes                                |
|--------------|-------------|--------------------------------------|
| `token`      | TEXT PK     | 32-byte cryptographically random hex |
| `email`      | TEXT        |                                      |
| `name`       | TEXT        |                                      |
| `owner_id`   | TEXT        | HubSpot owner ID                     |
| `expires_at` | TIMESTAMPTZ NOT NULL | 30-day expiry                |
| `created_at` | TIMESTAMPTZ |                                      |

Expired rows are swept hourly via `setInterval` in `initDb()`.

---

## notifications

Per-rep notifications shown in the dashboard badge.

| Column       | Type          | Notes                                         |
|--------------|---------------|-----------------------------------------------|
| `id`         | SERIAL PK     |                                               |
| `owner_id`   | TEXT NOT NULL | Target rep                                    |
| `type`       | TEXT NOT NULL | e.g. `quote-accepted`, `spec-updated`         |
| `title`      | TEXT NOT NULL |                                               |
| `body`       | TEXT          |                                               |
| `deal_id`, `deal_name`, `quote_num` | TEXT |                                       |
| `read`       | BOOLEAN       | Default FALSE                                 |
| `created_at` | TIMESTAMPTZ   |                                               |

**Index:** `(owner_id, read, created_at DESC)` — backs the unread-count and feed queries.

---

## logs

Admin/event log. Every interesting action (and every error) goes here via `writelog(level, event, message, meta)`.

| Column      | Type          | Notes                                       |
|-------------|---------------|---------------------------------------------|
| `id`        | SERIAL PK     |                                             |
| `at`        | TIMESTAMPTZ   | Default NOW()                               |
| `level`     | TEXT NOT NULL | `info` \| `warn` \| `error`                 |
| `event`     | TEXT NOT NULL | Short slug like `quote.created`, `qb.invoice.failed` |
| `rep`       | TEXT          |                                             |
| `quote_num` | TEXT          |                                             |
| `deal_id`, `deal_name` | TEXT |                                          |
| `message`   | TEXT NOT NULL | Human-readable                              |
| `meta`      | JSONB         | Anything structured                         |
| `version`   | TEXT          | Added later via `ALTER TABLE … ADD COLUMN IF NOT EXISTS` — app version when log was written |

**Indexes:** `at DESC`, `(level, at DESC)`, `(event, at DESC)`.

The audit (DEVLOG, low-priority) flagged that QB invoice payloads in `meta` may include PII — redact before logging.

---

## kv_store

Generic key-value. Used for QB OAuth tokens, server-side settings, anything that needs to outlive an in-memory cache but doesn't deserve its own table.

| Column       | Type        | Notes |
|--------------|-------------|-------|
| `key`        | TEXT PK     |       |
| `value`      | TEXT NOT NULL |     |
| `updated_at` | TIMESTAMPTZ |       |

Touch points: `lib/quickbooks.js` (`qb_oauth_token`), and ad-hoc settings stashes in `quote-server.js`.

---

## reconcile_links

Manual confirmations that a HubSpot deal corresponds to a QB invoice. Backs the reconcile page.

| Column          | Type         | Notes                                              |
|-----------------|--------------|----------------------------------------------------|
| `id`            | SERIAL PK    |                                                    |
| `hs_deal_id`    | TEXT NOT NULL |                                                   |
| `qb_invoice_id` | TEXT NOT NULL |                                                   |
| `created_at`    | TIMESTAMPTZ  |                                                    |
| UNIQUE          |              | `(hs_deal_id, qb_invoice_id)` — one HS deal can map to multiple QB invoices |

**Migration note:** older deployments had `UNIQUE(hs_deal_id)` only — that constraint blocks 1:N pairings. `initDb()` drops it if found. Don't restore.

## reconcile_blocks

Pairs the user has explicitly said "no, these don't go together" so reconcile stops suggesting them.

| Column          | Type        | Notes              |
|-----------------|-------------|--------------------|
| `hs_deal_id`    | TEXT NOT NULL | Composite PK     |
| `qb_invoice_id` | TEXT NOT NULL | Composite PK     |
| `created_at`    | TIMESTAMPTZ |                    |

---

## tracking_cache

Freight tracking results, polled by the tracking poller (`lib/freight.js`, started from `db.js` `onAfterInit`, runs every ~30 min). See HANDOFF §7 — don't add a second poller.

| Column            | Type        | Notes                                            |
|-------------------|-------------|--------------------------------------------------|
| `tracking_number` | TEXT PK     |                                                  |
| `slug`            | TEXT        | Carrier slug (e.g. `abf`, `od`, AfterShip slug)  |
| `status`          | TEXT        | `in-transit` \| `delivered` \| `exception` …     |
| `label`           | TEXT        | Status display label                             |
| `location`        | TEXT        | Last-known location                              |
| `last_event`      | TEXT        | Most recent event description                    |
| `last_event_time` | TEXT        |                                                  |
| `eta`             | TEXT        |                                                  |
| `delivered_at`    | TEXT        |                                                  |
| `signed_by`       | TEXT        |                                                  |
| `dest_city`       | TEXT        | Added later (`ALTER TABLE … ADD COLUMN IF NOT EXISTS`) |
| `dest_state`      | TEXT        | Same                                             |
| `updated_at`      | TIMESTAMPTZ |                                                  |

On startup, `delivered` rows with `delivered_at IS NULL` or `delivered_at = today` are wiped to avoid stale/bogus cache entries.

---

## components_inventory

Component inventory (PL migration Phase 2) — replaces the Excel `Inventory` sheet + pCloud `Inventory.csv` round-trip. One row per component code; on-hand is a single scalar (no bins/lots, same model as the sheet). All writes go through `lib/inventory.js` (`applyChanges` / `deductForOrder` / `restoreForOrder`); on-hand never changes without a matching `inventory_transactions` row.

| Column           | Type        | Notes                                                            |
|------------------|-------------|------------------------------------------------------------------|
| `code`           | TEXT PK     | Component code (`A01`, `Z30`, …) — joins to PL generator codes   |
| `name`           | TEXT        | Short display name from the sheet (e.g. `4230 CL`)               |
| `on_hand`        | INTEGER     | NOT NULL DEFAULT 0; may go negative (flagged, not blocked)       |
| `build_point`    | TEXT        | Reorder threshold — a number, or the literal `as needed`         |
| `build_qty`      | INTEGER     | Batch size when building                                         |
| `finished_qty`   | INTEGER     |                                                                  |
| `in_process_qty` | INTEGER     |                                                                  |
| `active`         | BOOLEAN     | DEFAULT TRUE (soft retire, no delete)                            |
| `updated_at`     | TIMESTAMPTZ |                                                                  |

Seeded once at startup from `lib/pl-data/inventory-seed.json` (extracted from `PackingList.xlsm`) when the table is empty; re-aligned with Excel during the parallel run via the dashboard's paste-sync. Rows auto-create at 0 when a ship deduction hits an unknown code (the Excel macros silently skipped those).

---

## inventory_transactions

Append-only audit of every stock move. Reasons: `ship` (auto-deduct on order shipped), `unship` (restore on un-ship), `adjust` (manual grid save), `sync` (Excel paste-sync), `seed` (startup import). Idempotency guard: a quote's ship deduction only applies when its net `ship`/`unship` delta is 0.

| Column          | Type        | Notes                                          |
|-----------------|-------------|-------------------------------------------------|
| `id`            | SERIAL PK   |                                                 |
| `code`          | TEXT        | Component code                                  |
| `delta`         | INTEGER     | Signed stock change                             |
| `on_hand_after` | INTEGER     | Resulting level (history reads without replay)  |
| `reason`        | TEXT        | `ship` / `unship` / `adjust` / `sync` / `seed`  |
| `quote_number`  | TEXT        | Set for ship/unship (links to the order's PL)   |
| `rep`           | TEXT        | Who                                             |
| `note`          | TEXT        |                                                 |
| `created_at`    | TIMESTAMPTZ |                                                 |

**Indexes:** `(code, created_at DESC)`, `quote_number`, `created_at DESC`.

---

## JSONB shapes (high level)

These columns carry the bulk of the app's domain model. They're not enforced by Postgres — the schema is documented in code (read paths) and convention.

### `quotes.json_snapshot`

Built from the full `quoteData` posted to `/api/save-quote`. Top-level keys observed:

- `lineItems` — array of `{ name, sku, qty, price, weight, productName, ... }`
- `customer` — `{ firstName, lastName, company, email, phone, address, city, state, zip, country }`
- `billing` — separate billing address object (used by QB BillAddr; see v1.7.12)
- `freight` — `{ total, carrier, eta, ... }`
- `tax` — `{ tax, rate, jurisdiction }`
- `discount` — `{ type: 'pct'|'fixed', value }`
- `foamColor`, `apColor`, `hingePreference`
- `productionNotes`, `deliveryNotes`
- `paymentType` — `hs` | `cc` | `ach` | `po` | `other`
- `poNumber` — when paymentType is `po`
- `canadian` (bool), `country` — international flag + country (v1.7.32)
- `customsBroker` — for international orders
- `_shareToken` — reflected from the row's `share_token` column on read

### `orders.order_data`

Set at process-order time. Captures order-specific fields not on the quote (e.g. final foam/AP/hinge selections after rep edits, customs broker, freight overrides, AP color confirmed).

### `supplier_pos.po_data`

Per-line array `[{ sku, name, qty, color, panels: { '2x4': N, '1x4': N, '1x2': N }, wholesaleCost, ... }]`, plus `shipTo`, `notes`, `apColor` (legacy single-color fallback for pre-v1.7.27 POs).

---

## Common ops

**One-off query against the DB:** Railway → Postgres service → Data → Query. Don't run destructive UPDATE/DELETE without Benton's sign-off (HANDOFF §10).

**Find quotes for a deal:**
```sql
SELECT quote_number, customer_name, total, created_at
FROM quotes WHERE deal_id = '<deal_id>' ORDER BY created_at DESC;
```

**See recent errors:**
```sql
SELECT at, event, message, meta
FROM logs WHERE level = 'error' ORDER BY at DESC LIMIT 50;
```

**Find orders missing QB invoices:**
```sql
SELECT o.quote_number, o.deal_id
FROM orders o
LEFT JOIN reconcile_links r ON r.hs_deal_id = o.deal_id
WHERE r.qb_invoice_id IS NULL
ORDER BY o.created_at DESC;
```

**Clear a stale tracking cache entry:**
```sql
DELETE FROM tracking_cache WHERE tracking_number = '<num>';
```
(Next poll will re-fetch from carrier.)
