# WhisperRoom Quote Builder — Handoff

> For Gabe (and his Claude). Read this top-to-bottom once, then keep it open as a reference. Benton wrote this so you can pick up work without him.

---

## 1. What this is

An internal Node.js web app used by the WhisperRoom sales team to:

- Build quotes (pricing, shipping, tax, options, Canadian addresses)
- Sync quotes/invoices/orders to HubSpot (contacts, deals, line items, invoices)
- Generate PDFs (Puppeteer) and upload them to a per-deal Google Drive folder
- Pull freight rates & tracking from ABF and Old Dominion
- Calculate sales tax via TaxJar (nexus-state aware)
- Provide a rep dashboard with quote history, search, tracking, admin logs

It's a single Node.js server (`quote-server.js`) serving HTML pages + JSON APIs, deployed on Railway, backed by Postgres.

**Two environments, one codebase:**

| Env      | URL                                             | Branch    | Railway service            |
|----------|-------------------------------------------------|-----------|----------------------------|
| Staging  | `https://test-sales-portal-production.up.railway.app` | `staging` | test-sales-portal          |
| Prod     | `https://sales.whisperroom.com`                 | `main`    | sales-portal (or similar)  |

Both share the same Postgres? **No — separate DBs.** Staging has its own `DATABASE_URL`. Never point staging at prod DB.

---

## 2. First-time setup (do this once)

1. **Clone the repo** somewhere you can work on it:
   ```bash
   git clone https://github.com/bentonwhitewr/whisperroomquote.git
   cd whisperroomquote
   ```

2. **Install Claude Code** (the CLI you're reading this with). Follow Anthropic's install instructions, run `claude` in the repo directory.

3. **Make sure you have access to:**
   - GitHub repo `bentonwhitewr/whisperroomquote` (push access)
   - Railway dashboard (both staging + prod services)
   - Google Drive folder the service account uses (ask Benton if you can't see uploaded PDFs)
   - HubSpot portal (for testing quote sync)

4. **Don't run the server locally.** It needs ~15 env vars (HubSpot, TaxJar, Google service-account JSON, Postgres URL, ABF creds, OD creds, etc.). Testing happens on staging. See §5.

---

## 3. How to work on this

The day-to-day loop is:

```
  ┌──────────────┐      ┌─────────────┐      ┌────────────┐      ┌────────────┐
  │ ask Claude   │ ───▶ │ commit &    │ ───▶ │ test on    │ ───▶ │ merge to   │
  │ to make fix  │      │ push staging│      │ staging +  │      │ main when  │
  │              │      │             │      │ paste logs │      │ confirmed  │
  └──────────────┘      └─────────────┘      └────────────┘      └────────────┘
```

**Branches:**
- `staging` — day-to-day work. Commit here freely.
- `main` — production. Only merge when staging is confirmed working.
- Feature branches (`claude/<something>`) — Claude may create these; merge them into `staging` first.

**Merging staging → main:**
```bash
git checkout main
git pull origin main
git merge staging --no-ff -m "Merge staging — <one-line summary>"
git push origin main
git checkout staging
```
Use `--no-ff` so the merge commit preserves history. Railway auto-deploys both envs on push.

**Rolling back:** Railway → service → Deployments → pick previous deploy → Redeploy. Takes ~60s. Keep this in mind — you don't need to be terrified of pushing.

---

## 4. Repo layout (what lives where)

```
quote-server.js              ← main server (orchestrator, ~7.1k lines)
lib/
  auth.js                    ← sessions, OAuth state, getRepFromReq
  db.js                      ← Postgres init, quote CRUD, quote-number gen
  freight.js                 ← ABF/OD rates, tracking cache + poller
  gdrive.js                  ← Google Drive: folders, PDF upload, JWT auth
  hubspot.js                 ← HubSpot API wrapper (contacts, deals, line items, invoices)
  logger.js                  ← writelog() → admin log table
  notify.js                  ← admin notifications (unread-count, mark-read)
  pdf.js                     ← Puppeteer PDF generation (+semaphore)
  states.js                  ← NEXUS_STATES, state name↔abbr, Canadian province detection
  taxjar.js                  ← sales tax lookup
  utils.js                   ← generateToken, parseCookies, rate limit, share tokens
templates/
  changelog.js               ← renderChangelog() HTML
*.html                       ← static pages (login, admin-log, deals-dashboard, …)
public/                      ← static assets
```

**Module pattern:** every lib/* exports an `init({ deps })` function. `quote-server.js` wires dependencies in once at startup (around lines 210–230). Look there first to understand what a module depends on.

Example:
```js
gdrive.init({ httpsRequest, getDb: () => db, writelog });
```
The `getDb: () => db` bit is a lazy getter — the module doesn't capture `db` at init time (it's `null` until Postgres connects), it asks for it on every call.

---

## 5. Testing on staging

Staging URL: `https://test-sales-portal-production.up.railway.app`

**Login:** same HubSpot OAuth as prod. First time you open it, authorize the app; it redirects back to staging (because `HS_REDIRECT_URI` is env-specific — don't touch that var).

**If you get redirected to `sales.whisperroom.com` instead of staging:**
- That's browser cache. Hard-reload: DevTools open → right-click reload → "Empty Cache and Hard Reload".
- Or try an incognito window.

**Cookie collision:** staging and prod both set `wr_qt_session` on `.whisperroom.com` adjacent domains. If a session cookie from prod leaks into staging (or vice versa) you'll get weird auth. Clear site data for both domains if confused.

**Standard smoke test** after any meaningful change:
1. Log in to staging
2. Create a new quote (no existing deal) — folder-picker modal should appear
3. Bind it to a new deal or existing deal
4. Add a room, add options, set a Canadian ship address (e.g. Ontario)
5. Generate quote PDF → check it lands in Google Drive folder
6. Convert to invoice → check invoice syncs to HubSpot (no `hs_collect_address_types` errors)
7. Mark as order → check order PDF uploads to the shared-orders Drive folder
8. Check `/admin-log` shows recent activity with no `error.*` entries

If something breaks on staging: grab the Railway logs (last ~50 lines around the failure), paste them to Claude. Don't guess — logs are how this app gets debugged.

---

## 6. Env vars (Railway)

Don't store secrets in the repo. Everything is in Railway → service → Variables. The important ones:

| Var                          | Purpose                                                          |
|------------------------------|------------------------------------------------------------------|
| `DATABASE_URL`               | Postgres (Railway-managed)                                       |
| `TZ`                         | **Must be `America/New_York`** — quote numbers use local date    |
| `STAGING_MODE`               | `true` on staging only. Disables prod-only redirects/integrations |
| `PUBLIC_BASE_URL`            | Used to build customer-facing links. Staging = staging URL, prod = `https://sales.whisperroom.com` |
| `HS_CLIENT_ID` / `HS_CLIENT_SECRET` | HubSpot OAuth app creds                                 |
| `HS_REDIRECT_URI`            | OAuth callback — env-specific                                    |
| `GOOGLE_SERVICE_ACCOUNT_JSON`| Service-account JSON (escaped newlines are OK, code handles it)  |
| `GDRIVE_ROOT_FOLDER`         | Drive folder ID where deal folders get created                   |
| `GDRIVE_ORDERS_FOLDER`       | Drive folder ID for processed-order PDFs                         |
| `TAXJAR_API_KEY`             | TaxJar                                                           |
| `ABF_ID` / `ABF_ACCT`        | ABF freight creds                                                |
| `OD_*`                       | Old Dominion freight creds                                       |
| `PUPPETEER_EXECUTABLE_PATH`  | Chrome path on Railway (set by buildpack)                        |

If you need to change one of these, do it in Railway and redeploy. Don't bake secrets into code.

---

## 7. Known gotchas (read before touching these areas)

- **Quote numbers are `W-` + 8-digit date key + 2-digit sequence (10 digits total).** The sequence is parsed from `digits.slice(8)` in `lib/db.js` — **do not** switch it back to a greedy regex, it will break any quote where seq ≥ 10.
- **Canadian addresses:** HubSpot's `shipping_state`/`billing_state`/contact `state` fields are US-only enums. For Canadian provinces we omit those fields entirely (see `isCanadianProvince` checks in `lib/hubspot.js`). Don't re-add them.
- **Invoice address PATCH** must include `hs_collect_address_types: 'billing_address'` when patching shipping props, otherwise HubSpot returns a conflict error. This is already wired — if you see that error again, the property order likely got touched.
- **Folder picker always appears for unbound quotes**, even if the contact already has deals. That's intentional: a contact can have many deals, and each quote needs to bind to exactly one.
- **PDF generation is single-threaded** (Puppeteer semaphore in `lib/pdf.js`). Concurrent requests wait up to 30s. Don't remove the `_pdfBusy` gate — Railway's memory will tip over.
- **Google Drive orphan folders:** `gdriveSavePdfToDeal` has a sibling-quote fallback — if a quote lacks `gdrive_folder_id` but a sibling on the same deal has one, it'll use and backfill. This handles legacy quotes. Keep that fallback.
- **Tracking poller** starts from `db.js` `onAfterInit`. It runs every ~30 min. Don't add another poller on top — one is enough.
- **All customer-facing URLs** must use `PUBLIC_BASE_URL` server-side or `location.origin` client-side. Never hardcode `sales.whisperroom.com` in new code or staging links will point to prod.

---

## 8. Common operations (copy-paste ready)

**Read recent Railway logs (ask the user to do this, you can't):**
Ask the user to open Railway → service → Deployments → latest → View Logs, then paste the relevant lines.

**Grep the codebase:**
```
<use the Grep tool, not bash grep>
```

**Find where a lib function is wired:**
```
Grep for `<modulename>.init(` in quote-server.js — that tells you its deps.
```

**Run a one-off query against the DB:**
Railway → Postgres service → Data → Query. Don't do destructive updates without Benton's sign-off.

**Regenerate a quote PDF manually:**
Hit `GET /pdf/quote/W-XXXXXXXXXX` while authenticated.

---

## 9. Architecture notes

- `httpsRequest` (defined in `quote-server.js`) is the universal HTTP helper. Every lib module that makes outbound calls receives it via `init`. Don't use `fetch` or `axios` — match the existing pattern.
- `writelog(level, event, message, meta)` goes to the `admin_log` table. Use it for anything operationally interesting, especially errors. It's the main debugging surface.
- Sessions live in memory + Postgres (`sessions` table). The memory cache (`_sessionCache`) is best-effort; DB is source of truth. OAuth state for HubSpot auth is in `oauthStates` (memory only, short-lived).
- The server is a single `http.createServer` with a giant `requestHandler` switch. Routes are ~7k lines of if/else. Phase 3 of the refactor (splitting into `routes/`) hasn't happened yet — don't volunteer to do it unless Benton asks.

---

## 10. When to ping Benton before acting

- Schema migrations (adding/removing DB columns) — always
- Anything touching production data
- Rotating secrets / regenerating OAuth apps
- Major refactors (moving big chunks between files, rewriting a module)
- Anything that would log out all users or invalidate sessions
- Deploying on a Friday afternoon

For small bug fixes, UI tweaks, and log noise — just do it. Staging first, confirm, merge, watch prod for 5 min.

---

## 11. Quickstart for your Claude

Paste this into Claude Code when starting a session:

> Read `HANDOFF.md` for project context. I'm going to ask you to fix/add something. Follow the workflow in §3 — work on `staging`, don't touch `main` until I say it's tested. When you need to see logs, ask me to paste them from Railway. Don't hardcode URLs or secrets.

That's enough. Claude will ask clarifying questions from there.

---

## 12. Who to contact

- **Benton** — owns the app, has full context. Ask before big changes.
- **Claude Code** — your pair programmer. Describe the problem in plain English, paste logs when stuck, and it'll edit, commit, and push for you.

Good luck. Break staging freely — that's what it's for.
