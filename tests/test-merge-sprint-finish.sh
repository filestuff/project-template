#!/usr/bin/env bash
# Regression: `merge-sprint.sh finish` ran `git push origin main` unless given
# --no-push. Local main is shared by every session in the checkout, so a solo
# close pushed whatever else main carried — another session's landed-but-held
# code went out past its deploy gate as a side effect of an unrelated finish.
# finish now never pushes (--no-push is accepted as a no-op) and its deferral
# line names `scripts/sprint/push-main.sh --expect <roster csv>`, the one
# code-bearing pusher, which refuses the held code until its owner is named.
set -euo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
TMP=$(cd "$TMP" && pwd -P)
R="$TMP/repo" ORIGIN="$TMP/origin.git"

mkdir -p "$R/scripts/sprint" "$R/docs/sprints/"{backlog,in-progress,done,rejected}
cp "$REPO_DIR"/full-overlay/scripts/sprint/*.sh "$REPO_DIR"/full-overlay/scripts/sprint/*.mjs "$REPO_DIR"/full-overlay/scripts/sprint/claims-tokens.json "$R/scripts/sprint/"
cp "$REPO_DIR/lite/scripts/sprint/close-check.mjs" "$R/scripts/sprint/"
cp "$REPO_DIR/full-overlay/docs/sprints/INDEX.md" "$REPO_DIR/full-overlay/docs/sprints/ROADMAP.md" "$R/docs/sprints/"
cp "$REPO_DIR/lite/docs/DOC_HEALTH.md" "$R/docs/"
chmod +x "$R"/scripts/sprint/*.sh
MS="$R/scripts/sprint/merge-sprint.sh"

# --- 1. the script's own scratch-repo assertions -------------------------------
out=$(bash "$MS" --self-test 2>&1) || { echo "merge-sprint.sh --self-test failed:"; echo "$out"; exit 1; }

# --- end-to-end: a complete sprint lands while another session's code is held --
sprint_file() { # $1 = id, $2 = kebab — a record that passes close-check
  cat <<EOS
---
sprint: $1
status: in-progress
goal: g
short: $2
depends_on: []
blocks: []
tags: []
story_points: 1
plan_date: 2026-09-01
start_date: 2026-09-01
end_date: null
touches:
  - src/$2.txt
---

# $1: $2

## Scope

### Deliverables

1. **Thing**
   - Acceptance criteria:
     - Automated:
       - [x] \`npm test\` → 1 passed
         - Evidence: \`npm test\` → 1 passed

### Out of Scope

- nothing

## Completion Log

### Outcome

Shipped the thing.

### Commits

_(stamped at land)_

### Review

— not run: low risk (Step 3.5)

### Deviations from brief

— none

### Deferred

— none

### Learnings

— none

### Close checklist

- [x] Gate green — gate: all checks passed
- [x] Docs synced — none: nothing referenced
- [x] New docs registered — none: no new docs
- [x] ADR check — none: no decision
- [x] Deferred work logged — none: nothing deferred
- [x] Deployed — n/a: test fixture
EOS
}

cd "$R"
git init -q -b main
printf '.claude/\nscripts/\n' >.gitignore
git config user.email t@t && git config user.name t && git config commit.gpgsign false
sprint_file S-001 alpha >docs/sprints/in-progress/S-001-alpha.md
git add -A && git commit -qm "init ledger"
git init -q --bare -b main "$ORIGIN"
git remote add origin "$ORIGIN"
git push -q -u origin main
ORIGIN0=$(git -C "$ORIGIN" rev-parse main)

git worktree add -q "$R/.claude/worktrees/S-001-alpha" -b S-001-alpha main
mkdir -p "$R/.claude/worktrees/S-001-alpha/src"
echo work >"$R/.claude/worktrees/S-001-alpha/src/alpha.txt"
git -C "$R/.claude/worktrees/S-001-alpha" add -A
git -C "$R/.claude/worktrees/S-001-alpha" commit -qm "S-001: do the thing"

mkdir -p src && echo held >src/held.ts
git add src/held.ts && git commit -qm "S-900: another session's held code"

# prepare WITHOUT --no-push still pulls (a no-op here) — that path is kept
set +e; bash "$MS" prepare S-001-alpha >/dev/null 2>&1; code=$?; set -e
[[ $code -eq 0 || $code -eq 3 ]] || { echo "prepare exited $code"; exit 1; }
set +e; out=$(bash "$MS" land S-001-alpha 2>&1); code=$?; set -e
[[ $code -eq 4 ]] || { echo "expected land exit 4, got $code:"; echo "$out"; exit 1; }

# --- 2. finish with NO flag: completes locally, never pushes -------------------
set +e; out=$(bash "$MS" finish S-001-alpha 2>&1); code=$?; set -e
[[ $code -eq 0 ]] || { echo "finish exited $code:"; echo "$out"; exit 1; }
[[ $(git -C "$ORIGIN" rev-parse main) == "$ORIGIN0" ]] || { echo "finish pushed — held S-900 code shipped past its deploy gate"; exit 1; }
[[ $(git log -1 --format=%s) == "sprint: complete S-001 — alpha" ]] || { echo "completion commit missing"; exit 1; }
echo "$out" | grep -q 'push deferred — finish never pushes' || { echo "deferral line missing:"; echo "$out"; exit 1; }
echo "$out" | grep -q 'scripts/sprint/push-main.sh --expect S-001,' || { echo "deferral line should name push-main.sh --expect S-001:"; echo "$out"; exit 1; }
bash scripts/sprint/lock.sh continue land-S-001-alpha >/dev/null 2>&1 && { echo "finish kept the lock"; exit 1; }

# --- 3. the named settle command refuses the held code until its owner is named -
set +e; out=$(bash scripts/sprint/push-main.sh --expect S-001 --wait 0 2>&1); code=$?; set -e
[[ $code -eq 2 ]] || { echo "push-main --expect S-001 should refuse the held S-900 code (exit 2), got $code:"; echo "$out"; exit 1; }
[[ $(git -C "$ORIGIN" rev-parse main) == "$ORIGIN0" ]] || { echo "refused push-main moved origin"; exit 1; }
set +e; out=$(bash scripts/sprint/push-main.sh --expect S-001,S-900 --wait 0 2>&1); code=$?; set -e
[[ $code -eq 0 ]] || { echo "push-main --expect S-001,S-900 exited $code:"; echo "$out"; exit 1; }
[[ $(git -C "$ORIGIN" rev-parse main) == "$(git rev-parse main)" ]] || { echo "settling push did not reach origin"; exit 1; }

echo "merge-sprint finish: all checks passed"
