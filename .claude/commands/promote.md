---
description: Promote staging → main with the standard --no-ff merge and push
argument-hint: [optional one-line summary]
allowed-tools: Bash, Read
---

The user has invoked `/promote` to merge `staging` into `main` and push it to GitHub. Optional argument is a one-line summary for the merge commit; if absent, derive a tight summary from the most recent staging commits not yet on main.

## Procedure (do not skip steps)

1. **Pre-flight check** — run these in parallel:
   - `git status` — must show working tree clean. If dirty, STOP and tell the user.
   - `git log origin/main..staging --oneline` — show what's about to ship. If empty, STOP and tell the user there's nothing to promote.
   - `git fetch origin` — make sure we're up to date with remote.

2. **Briefly state what's about to happen** (one short paragraph) then proceed directly — no confirmation prompt:
   - The list of commits that will land on main (output of step 1's `git log`).
   - The proposed merge commit message: `Merge staging — <summary>` (use `$ARGUMENTS` if provided, else synthesize from the commit list).

3. **Run the merge dance:**
   ```
   git checkout main
   git pull origin main
   git merge staging --no-ff -m "Merge staging — <summary>"
   git push origin main
   git checkout staging
   ```
   Run as one chained command (`&&` between each) so a failure stops the chain.

4. **Report success** — show final `git log --oneline -3` of main so the user can see the merge commit landed.

## Guardrails

- Never use `--force` or `--force-with-lease` on main. If the push is rejected, STOP and tell the user — do not try to overwrite.
- If pre-flight finds the working tree dirty, do NOT auto-stash. Ask the user what they want to do.
- If `git pull origin main` reveals upstream commits not in staging, STOP. Tell the user — there may be a hotfix on main that needs to be pulled into staging first.
