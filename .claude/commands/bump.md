---
description: Bump version + add changelog entry + add DEVLOG row in one shot
argument-hint: <patch|minor> "<one-line summary>" [tag: fix|feature|ui|log|security]
allowed-tools: Read, Edit, Bash
---

The user has invoked `/bump` to record a new version. Arguments: `$ARGUMENTS`.

## Argument parsing

- First word: `patch` or `minor`. PATCH bumps the third number (1.7.33 → 1.7.34). MINOR bumps the second and resets the third (1.7.33 → 1.8.0). MAJOR is reserved for rewrites — don't bump major from this command; if the user passes `major`, ask them to confirm and edit `package.json` manually.
- The quoted string is the one-line summary — used in BOTH the changelog entry and the DEVLOG table row.
- Optional `tag:` is the version-level tag (`fix` | `feature` | `ui` | `log` | `security`). Defaults: `fix` for patch, `feature` for minor.

If arguments are missing or unclear, ask the user to clarify before doing anything.

## Steps

1. **Read current state** in parallel:
   - `package.json` — current version
   - `templates/changelog.js` — first ~30 lines, to confirm the entry format
   - `DEVLOG.md` — find the changelog table row to insert above

2. **Compute new version** from the bump type. Confirm with the user in one sentence: "Bumping 1.7.33 → 1.7.34 with summary 'X'. Proceed?" Only proceed on yes.

3. **Edit `package.json`** — update the `version` field.

4. **Insert into `templates/changelog.js`** — add a new entry block immediately after the opening `${[` of the entries array (currently at line ~52). Format must match existing entries exactly:
   ```js
   {
     v:'<new version>', date:'<Month D, YYYY>', tag:'<tag>',
     changes:[
       {t:'<change type>', d:'<summary>'},
     ]
   },
   ```
   - Date format: `May 8, 2026` (month name spelled out, no leading zero on day).
   - Use today's date — get it from `Bash: date "+%B %-d, %Y"` if unsure.
   - `t:` (the per-change type) maps to: fix → `fix`, feature → `add`, ui → `ui`, log → `log`, security → `security`.

5. **Insert into `DEVLOG.md`** — add a new row at the top of the changelog table (between the `|---|` separator and the existing top row):
   ```
   | <new version>  | <YYYY-MM-DD> | <summary> |
   ```

6. **Run the syntax check** before reporting back:
   - `node scripts/check-syntax.js` — this is what `.git/hooks/pre-commit` runs.
   - If it fails (especially on `templates/changelog.js`), it's almost always an over-escaped char in the summary string you just inserted. Fix the escape and re-run the check.
   - **Why this matters:** `templates/changelog.js` is `require`'d at server startup. A SyntaxError here crash-loops the Railway deploy (this happened in v1.72.11; see DEVLOG row for v1.72.13). The pre-commit hook will catch it, but you should catch it earlier so you don't waste a `git commit` attempt.

7. **Stage all three files** and report back:
   - Show the diff of the three edits in summary form.
   - Tell the user: "Bumped to v<X>. Three files staged, syntax check passed. Commit when ready, or run `git diff --staged` to review."
   - **Do NOT auto-commit.** The user wants to bundle this with the actual code change.

## Guardrails

- If the user is in the middle of unrelated changes (working tree has unstaged code edits), proceed but warn them in the final report.
- If `package.json` version looks corrupted or doesn't match `\d+\.\d+\.\d+`, STOP and ask the user.
- If the entry-array opening line in `templates/changelog.js` has moved, find it via Grep for `${[` near the top of the renderChangelog function before inserting.
- **Watch the apostrophes.** Inside the single-quoted `d:'...'` string, write `booth\'s` (one backslash). Writing `\\'s` (two backslashes) is the bug that took down v1.72.11.
