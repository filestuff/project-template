#!/usr/bin/env bash
# Locked batch-push of deferred wave commits. Wave orchestration runs the
# lifecycle scripts with --no-push (each printing a "push deferred" notice)
# so that every ledger-only commit doesn't burn a downstream CI run; this
# script is the checkpoint that actually pushes main, guarding against a
# diverged remote and forcing CI to run when the pushed range carries code.
#
#   push-main.sh [--wait <secs>]
#
# Exit codes: 0 ok (including "nothing to push") · 75 lock busy ·
# 1 error (diverged remote / push failure)
set -euo pipefail

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
GIT_COMMON=$(git rev-parse --path-format=absolute --git-common-dir)
ROOT=${GIT_COMMON%/.git}
MAIN=${SPRINT_MAIN_BRANCH:-main}

WAIT=300
while [[ $# -gt 0 ]]; do
  case "$1" in
  --wait) WAIT=$2; shift 2 ;;
  *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

TOKEN=$("$SELF_DIR/lock.sh" acquire "push-main" --wait "$WAIT")
cleanup() {
  "$SELF_DIR/lock.sh" release "$TOKEN" || true
}
trap cleanup EXIT

# Check remote-branch existence BEFORE fetching — `git fetch origin $MAIN` exits
# 128 ("couldn't find remote ref") when no upstream exists yet, which would
# abort the script under set -e before the no-origin path ever ran.
if git -C "$ROOT" ls-remote --exit-code --heads origin "$MAIN" >/dev/null 2>&1; then
  HAS_ORIGIN=1
else
  HAS_ORIGIN=0
fi

if [[ $HAS_ORIGIN -eq 1 ]]; then
  git -C "$ROOT" fetch origin "$MAIN"
  if [[ $(git -C "$ROOT" rev-parse "$MAIN") == "$(git -C "$ROOT" rev-parse "origin/$MAIN")" ]]; then
    echo "nothing to push — local $MAIN matches origin/$MAIN"
    exit 0
  fi
  if ! git -C "$ROOT" merge-base --is-ancestor "origin/$MAIN" "$MAIN"; then
    echo "origin/$MAIN is not an ancestor of local $MAIN — histories have diverged (remote moved, likely from another machine)." >&2
    echo "This script will NOT auto-rebase or merge the ledger. Reconcile manually:" >&2
    echo "  git -C \"$ROOT\" log --oneline $MAIN..origin/$MAIN   # see what origin has that you don't" >&2
    echo "  git -C \"$ROOT\" log --oneline origin/$MAIN..$MAIN   # see what you have that origin doesn't" >&2
    exit 1
  fi
fi

OLD_SHA=$(git -C "$ROOT" rev-parse --short "origin/$MAIN" 2>/dev/null || echo '(none)')

if [[ $HAS_ORIGIN -eq 1 ]]; then
  # Skip-HEAD guard: if HEAD carries a skip marker but the pushed range touches
  # non-ledger paths, force CI by adding an empty, unmarked commit on top.
  HEAD_MSG=$(git -C "$ROOT" log -1 --format=%B "$MAIN")
  SKIP_MARKER=0
  if grep -qiE '\[skip ci\]|\[ci skip\]|\[no ci\]|\[skip actions\]|\[actions skip\]|^skip-checks: *true' <<<"$HEAD_MSG"; then
    SKIP_MARKER=1
  fi
  if [[ $SKIP_MARKER -eq 1 ]]; then
    NON_LEDGER=$(git -C "$ROOT" diff --name-only "origin/$MAIN..$MAIN" | grep -vE '^(docs/|\.claude/)' || true)
    if [[ -n $NON_LEDGER ]]; then
      OLD_HEAD_SHORT=$(git -C "$ROOT" rev-parse --short "$MAIN")
      git -C "$ROOT" commit --allow-empty --no-verify -m "ci: run checks for wave push ($OLD_SHA..$OLD_HEAD_SHORT)"
      echo "skip-CI guard fired — HEAD carried a skip marker but the range touches non-ledger paths; added an empty commit to force CI"
    fi
  fi
fi

if [[ $HAS_ORIGIN -eq 1 ]]; then
  git -C "$ROOT" push origin "$MAIN" || { echo "push failed — local commits intact; resolve and re-run push-main.sh" >&2; exit 1; }
else
  git -C "$ROOT" push -u origin "$MAIN" || { echo "push failed — local commits intact; resolve and re-run push-main.sh" >&2; exit 1; }
fi

NEW_SHA=$(git -C "$ROOT" rev-parse --short "$MAIN")
EMPTY_TREE=$(git -C "$ROOT" hash-object -t tree /dev/null)
if [[ $OLD_SHA == "(none)" ]]; then
  COUNT=$(git -C "$ROOT" rev-list --count "$MAIN")
  RANGE_NON_LEDGER=$(git -C "$ROOT" diff --name-only "$EMPTY_TREE" "$MAIN" | grep -vE '^(docs/|\.claude/)' || true)
else
  COUNT=$(git -C "$ROOT" rev-list --count "$OLD_SHA..$MAIN")
  RANGE_NON_LEDGER=$(git -C "$ROOT" diff --name-only "$OLD_SHA..$MAIN" | grep -vE '^(docs/|\.claude/)' || true)
fi

echo "pushed $OLD_SHA..$NEW_SHA to origin/$MAIN ($COUNT commit(s))"
if [[ -n $RANGE_NON_LEDGER ]]; then
  echo "this push carries code — verify CI green on it (PROTOCOL Phase 3 Step 6)"
fi
