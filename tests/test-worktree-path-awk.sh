#!/usr/bin/env bash
# Regression: worktree_path() parsed `git worktree list --porcelain` with
# awk '{wt=$2}', truncating paths at the first space — e.g. every path under
# "~/Documents/Claude Code/...". Fixture reproduces the porcelain format.
set -euo pipefail
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
TMP=$(cd "$TMP" && pwd -P) # resolve symlinks (e.g. macOS /var -> /private/var):
                           # git worktree records the resolved path, so TMP
                           # must match it or the comparison below is bogus.

git init -q "$TMP/repo with space"
( cd "$TMP/repo with space" \
  && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init \
  && git branch -M main \
  && git worktree add -q -b sprint/S-001 "$TMP/wt with space" main )

# Extract worktree_path() exactly as merge-sprint.sh defines it, with its
# BRANCH variable bound, and run it inside the fixture repo.
fn=$(sed -n '/^worktree_path()/,/^}/p' "$REPO_DIR/full-overlay/scripts/sprint/merge-sprint.sh")
got=$(cd "$TMP/repo with space" && BRANCH="sprint/S-001" bash -c "BRANCH='sprint/S-001'; $fn; worktree_path")
[ "$got" = "$TMP/wt with space" ] || { echo "got truncated path: '$got'"; exit 1; }
