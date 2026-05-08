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
| `supplier_pos`     | Audimute (and future) supplier POs            | `quote-server.js`            | suppliers-dashboard, deal-hub    |
| `sessions`         | Logged-in rep sessions                        | `lib/auth.js`                | every authenticated request      |
| `notifications`    | Per-rep notification feed                     | `lib/notify.js`              | admin-log, dashboards (badge)    |
| `logs`             | Admin/event log                               | `lib/logger.js` (`writelog`) | admin-log page                   |
| `kv_store`         | Generic key-value (OAuth tokens, settings)    | `quote-server.js`, `lib/quickbooks.js` | OAuth flows, integrations |
| `reconcile_links`  | Confirmed HS deal ↔ QB invoice pairings       | `reconcile.html` actions     | reconcile page                   |
| `reconcile_blocks` | Explicitly-rejected pairings                  | `reconcile.html` actions     | reconcile page                   |
| `tracking_cache`   | Freight tracking results, polled ~every 30min | `lib/freight.js`             | shipping-dashboard, order pages  |

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
