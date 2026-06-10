---
description: Bump version + add changelog fragment + add DEVLOG row in one shot
argument-hint: <patch|minor> "<one-line summary>" [tag: fix|feature|ui|log|security]
allowed-tools: Read, Edit, Write, Bash
---

The user has invoked `/bump` to record a new version. Arguments: `$ARGUMENTS`.

## Argument parsing

- First word: `patch` or `minor`. PATCH bumps the third number (1.7.33 → 1.7.34). MINOR bumps the second and resets the third (1.7.33 → 1.8.0). MAJOR is reserved for rewrites — don't bump major from this command; if the user passes `major`, ask them to confirm and edit `package.json` manually.
- The quoted string is the one-line summary — used in BOTH the changelog entry and the DEVLOG table row.
- Optional `tag:` is the version-level tag (`fix` | `feature` | `ui` | `log` | `security`). Defaults: `fix` for patch, `feature` for minor.

If arguments are missing or unclear, ask the user to clarify before doing anything.

## Steps

1. **Read current state** in parallel:
   - `package.json` — current LOCAL version
   - `Bash: git fetch origin && git show origin/staging:package.json` — the REMOTE version. Two people (Benton + Gabe) push to staging in parallel; the next number may already be taken upstream.
   - `DEVLOG.md` — find the changelog table row to insert above

2. **Compute new version** from the bump type, **starting from the HIGHER of local vs origin/staging**. Confirm with the user in one sentence: "Bumping 1.7.33 → 1.7.34 with summary 'X'. Proceed?" Only proceed on yes.

3. **Edit `package.json`** — update the `version` field.

4. **Create `templates/changelog.d/<new version>.js`** — one fragment file per version. **NEVER add entries to `templates/changelog.js` itself** — its inline array is frozen legacy; inserting at its top is the parallel-push merge conflict the fragment system removed (and the file that crash-loops Railway when merged wrong). Format (see `templates/changelog.d/README.md`):
   ```js
   module.exports = {
     v: '<new version>', date: '<Month D, YYYY>', tag: '<tag>',
     changes: [
       { t: '<change type>', d: '<summary>' },
     ],
   };
   ```
   - Date format: `May 8, 2026` (month name spelled out, no leading zero on day).
   - Use today's date — get it from `Bash: date "+%B %-d, %Y"` if unsure.
   - `t:` (the per-change type) maps to: fix → `fix`, feature → `add`, ui → `ui`, log → `log`, security → `security`.

5. **Insert into `DEVLOG.md`** — add a new row at the top of the changelog table (between the `|---|` separator and the existing top row):
   ```
   | <new version>  | <YYYY-MM-DD> | <summary> |
   ```

6. **Run the syntax check** before reporting back:
   - `node scripts/check-syntax.js` — this is what `.git/hooks/pre-commit` runs. It node-checks staged JS and validates the shape of staged changelog fragments.
   - If it fails on your new fragment, it's almost always an over-escaped char in the `d:'…'` string. Fix the escape and re-run the check.

7. **Stage all three files** and report back:
   - Show the diff of the three edits in summary form.
   - Tell the user: "Bumped to v<X>. Three files staged, syntax check passed. Commit when ready, then push with `scripts/ship.sh`."
   - **Do NOT auto-commit.** The user wants to bundle this with the actual code change.

## Guardrails

- Push with `scripts/ship.sh`, never a raw `git push` (and NEVER `--force`) — it rebases onto origin/staging, re-verifies startup-critical files, and retries races.
- If the user is in the middle of unrelated changes (working tree has unstaged code edits), proceed but warn them in the final report.
- If `package.json` version looks corrupted or doesn't match `\d+\.\d+\.\d+`, STOP and ask the user.
- If ship.sh later reports a version collision (both sides bumped), keep the OTHER side's number and re-pick yours one higher: rename your fragment file (+ its `v:` field), fix your DEVLOG row, amend the commit message.
- **Watch the apostrophes.** Inside the single-quoted `d:'...'` string, write `booth\'s` (one backslash) or use `&apos;`. Writing `\\'s` (two backslashes) is the bug that took down v1.72.11.
