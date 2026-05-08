# CLAUDE.md

WhisperRoom Quote Builder — internal Node.js sales tool. Single-server (`quote-server.js`, ~7k lines) + `lib/` modules + HTML dashboards. Railway-deployed, Postgres-backed. Integrates HubSpot, QuickBooks, TaxJar, Google Drive, ABF/Old Dominion freight, Puppeteer.

## Read these before doing anything

1. **HANDOFF.md** — full architecture, env vars, gotchas, testing recipe. Source of truth for "how this app works."
2. **DEVLOG.md** — top section is "Current focus" (where we left off + outstanding work). Below that is the changelog table and any session writeups.
3. **SCHEMA.md** — Postgres tables, columns, JSONB shapes, which lib reads/writes each. Read before any DB-touching change.

## Slash commands (project-scoped, in `.claude/commands/`)

- `/bump <patch|minor> "<summary>"` — bumps `package.json`, adds `templates/changelog.js` entry, adds DEVLOG row. Stages but doesn't commit, so it bundles cleanly with the actual code change.
- `/promote [optional summary]` — staging→main merge dance with confirmation. Use only when the user explicitly asks to ship to prod.

## Workflow (non-negotiable)

- All work happens on `staging`. **Never commit to `main` or push it without explicit user approval.**
- The user tests every change on the staging URL (`https://test-sales-portal-production.up.railway.app`) before promoting.
- Promote when explicitly asked: `git checkout main && git pull && git merge staging --no-ff -m "Merge staging — <summary>" && git push origin main && git checkout staging`. See HANDOFF §3.

## Every push to staging must include

1. **Version bump in `package.json`** — PATCH for fixes/UI tweaks, MINOR for shipped features. (HANDOFF §3 has the rule of thumb: "I added X" = MINOR, "I fixed X" = PATCH.)
2. **New entry at the top of `templates/changelog.js`** — match the existing format. This feeds the in-app `/changelog` page.
3. **One-line row added to the DEVLOG.md changelog table** — the dev-side narrative.

Do all three without being asked. If they slip, the user will remind you.

## Keep DEVLOG.md current

DEVLOG.md is what a fresh Claude (different machine, days later) reads to know the project state. Treat it as the source of truth for "where are we right now."

- Update **Current focus** at the top whenever the focus shifts (new initiative, abandoned plan, blocker discovered, audit finding addressed).
- Add the version row to the changelog table on every commit that bumps version.
- For multi-version sessions, add a brief session writeup above the changelog table (see the existing v1.7.21–1.7.33 writeup as a model).

## Code conventions to respect

- Don't introduce `fetch` or `axios`. Use the existing `httpsRequest` helper passed via `init({ deps })`.
- Lib modules use the `init({ deps })` pattern, wired in `quote-server.js` startup (~lines 210–230). Check there first to see what depends on what.
- `quote-server.js` is monolithic — Grep, don't read it whole.
- Don't run the server locally — needs ~15 env vars. Test on staging.
- All customer-facing URLs must use `PUBLIC_BASE_URL` (server) or `location.origin` (client). Never hardcode `sales.whisperroom.com`.
- Use `writelog(level, event, message, meta)` for anything operationally interesting — it's the main debugging surface.

## When to ping the user before acting

DB schema migrations, prod data, secret rotation, major refactors, anything that invalidates sessions. See HANDOFF §10.
