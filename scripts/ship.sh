#!/usr/bin/env bash
# One-command staging push that can't stomp (or get stomped by) a parallel
# push. Replaces the raw `git push origin staging` that kept getting rejected
# when Benton and Gabe pushed in the same window.
#
#   scripts/ship.sh
#
# What it does, each attempt (up to 3):
#   1. fetch — see what the other person landed while you worked
#   2. rebase --autostash onto origin/staging (linear history, no merge knots;
#      DEVLOG table rows auto-merge via the union driver in .gitattributes)
#   3. re-verify the startup-critical files POST-rebase (a textually clean
#      merge can still be semantically broken — pre-commit only saw YOUR tree)
#   4. push; if someone slipped a push in during steps 1–3, loop and retry
#
# NEVER resolve a rejected push with --force. If this script can't get you
# through, the conflict is real and small — fix it, `git rebase --continue`,
# run ship.sh again.

set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "staging" ]; then
  echo "✗ ship.sh pushes staging only — you're on '$BRANCH'" >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "⚠ uncommitted changes detected — they'll be autostashed through the rebase and restored"
fi

verify() {
  echo "· verifying startup-critical files post-rebase…"
  node --check quote-server.js
  node -e "require('./templates/changelog.js')(); const pl=require('./lib/packing-list.js'); pl.init(); pl.generate([]);" \
    || { echo "✗ post-rebase smoke test failed — the merge combined into broken JS. Fix before pushing." >&2; exit 1; }
}

for attempt in 1 2 3; do
  git fetch origin
  if ! git merge-base --is-ancestor origin/staging HEAD; then
    echo "↻ origin/staging moved — rebasing your work on top (attempt $attempt)"
    if ! git rebase --autostash origin/staging; then
      cat >&2 <<'EOF'

✗ Rebase stopped on a real conflict. The usual suspects:

   package.json    both pushes claimed the same version number. Keep the
                   OTHER side's number, re-pick yours one higher, and make it
                   match everywhere: rename your templates/changelog.d/<v>.js
                   fragment (+ its v: field), fix your DEVLOG row, and reword
                   the commit message during --continue.

   DEVLOG.md       should auto-merge (union driver). If it still conflicts,
                   keep BOTH table rows, newest on top.

   anything else   you and Gabe touched the same code — read both sides,
                   keep what's correct.

Then:  git add -A && git rebase --continue && scripts/ship.sh
Abort: git rebase --abort   (returns you to exactly where you were)
EOF
      exit 1
    fi
    verify
  fi
  if git push origin staging; then
    echo "✓ pushed $(git rev-parse --short HEAD) → origin/staging"
    exit 0
  fi
  echo "… push raced another push, retrying"
done

echo "✗ push still failing after 3 attempts — check 'git status' and network" >&2
exit 1
