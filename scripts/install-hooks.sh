#!/bin/sh
# One-shot installer for local git hooks. Run from repo root after a fresh clone:
#   scripts/install-hooks.sh
#
# Copies tracked hooks from scripts/git-hooks/ into .git/hooks/ and makes them
# executable. `.git/hooks/` itself is not tracked, so each clone needs this once.

set -e

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$REPO_ROOT" ]; then
  echo "install-hooks: not inside a git repo" >&2
  exit 1
fi

SRC="$REPO_ROOT/scripts/git-hooks"
DST="$REPO_ROOT/.git/hooks"

for hook in "$SRC"/*; do
  [ -f "$hook" ] || continue
  name="$(basename "$hook")"
  cp "$hook" "$DST/$name"
  chmod +x "$DST/$name"
  echo "installed: $DST/$name"
done
