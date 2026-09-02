#!/usr/bin/env bash
# Regression: `merge-sprint.sh land` moved a sprint file to done/ flipping only
# status/end_date, so sprints landed with a virgin Completion Log (57% of one
# downstream repo's done sprints) and no record of their own commits. land now
# lints the branch's copy of the record BEFORE merging (exit 5, main untouched,
# re-runnable without a new prepare), honours --allow-incomplete "<reason>" by
# writing the reason into the file, and stamps the `S-NNN:` commits + merge SHA
# under ### Commits after the merge. First test coverage of merge-sprint.sh.
set -euo pipefail
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
TMP=$(cd "$TMP" && pwd -P)
R="$TMP/repo"

# --- fixture: a full-tier install with one in-progress sprint on a branch -----
mkdir -p "$R/scripts/sprint" "$R/docs/sprints/"{backlog,in-progress,done,rejected}
cp "$REPO_DIR"/full-overlay/scripts/sprint/*.sh "$REPO_DIR"/full-overlay/scripts/sprint/*.mjs "$REPO_DIR"/full-overlay/scripts/sprint/claims-tokens.json "$R/scripts/sprint/"
cp "$REPO_DIR/lite/scripts/sprint/close-check.mjs" "$R/scripts/sprint/"
cp "$REPO_DIR/full-overlay/docs/sprints/INDEX.md" "$REPO_DIR/full-overlay/docs/sprints/ROADMAP.md" "$R/docs/sprints/"
cp "$REPO_DIR/lite/docs/DOC_HEALTH.md" "$R/docs/"
chmod +x "$R"/scripts/sprint/*.sh

sprint_file() { # $1 = id, $2 = kebab, $3 = "complete" | "incomplete"
  local ev="" log
  [[ $3 == complete ]] && ev="         - Evidence: \`npm test\` → 1 passed"
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
$ev

### Out of Scope

- nothing

## Completion Log

### Outcome

$( [[ $3 == complete ]] && echo "Shipped the thing." || echo "_(2–4 sentences at close …)_" )

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
git init -q && git branch -M main
printf '.claude/\n' >.gitignore
git config user.email t@t && git config user.name t
sprint_file S-001 alpha incomplete >docs/sprints/in-progress/S-001-alpha.md
sprint_file S-002 beta incomplete  >docs/sprints/in-progress/S-002-beta.md
git add -A && git commit -qm "init ledger"

make_branch() { # $1 = branch, $2 = sprint id, $3 = kebab name
  git worktree add -q "$R/.claude/worktrees/$1" -b "$1" main
  mkdir -p "$R/.claude/worktrees/$1/src"
  echo work >"$R/.claude/worktrees/$1/src/$3.txt"
  git -C "$R/.claude/worktrees/$1" add -A
  git -C "$R/.claude/worktrees/$1" commit -qm "$2: do the thing"
}
make_branch S-001-alpha S-001 alpha
make_branch S-002-beta  S-002 beta

MS="$R/scripts/sprint/merge-sprint.sh"
HEAD0=$(git rev-parse HEAD)

# --- 1. incomplete record: land exits 5, main untouched, lock kept ----------
prep() { set +e; bash "$MS" prepare "$1" --no-push >/dev/null 2>&1; local c=$?; set -e; [[ $c -eq 0 || $c -eq 3 ]] || { echo "prepare $1 exited $c"; exit 1; }; }
prep S-001-alpha
set +e; out=$(bash "$MS" land S-001-alpha 2>&1); code=$?; set -e
[[ $code -eq 5 ]] || { echo "expected land exit 5 on incomplete record, got $code:"; echo "$out"; exit 1; }
echo "$out" | grep -q 'outcome-empty' || { echo "land did not surface the lint failure:"; echo "$out"; exit 1; }
[[ $(git rev-parse HEAD) == "$HEAD0" ]] || { echo "main moved on a failed lint"; exit 1; }
[[ -f docs/sprints/in-progress/S-001-alpha.md ]] || { echo "sprint file moved on a failed lint"; exit 1; }
bash "$R/scripts/sprint/lock.sh" continue land-S-001-alpha >/dev/null || { echo "lock not kept after exit 5"; exit 1; }

# --- 2. fix the record on the branch; land again WITHOUT a new prepare -------
WT="$R/.claude/worktrees/S-001-alpha"
sprint_file S-001 alpha complete >"$WT/docs/sprints/in-progress/S-001-alpha.md"
git -C "$WT" commit -qam "S-001: completion log"
set +e; out=$(bash "$MS" land S-001-alpha 2>&1); code=$?; set -e
[[ $code -eq 4 ]] || { echo "expected land exit 4 after fixing the record, got $code:"; echo "$out"; exit 1; }
DONE="docs/sprints/done/S-001-alpha.md"
[[ -f $DONE ]] || { echo "sprint file not moved to done/"; exit 1; }
grep -q '^status: done' "$DONE" || { echo "status not flipped"; exit 1; }
grep -q '^_(stamped at land)_$' "$DONE" && { echo "stamp placeholder left in place"; exit 1; }
grep -q '^- [0-9a-f]\{7,\} S-001: do the thing$' "$DONE" || { echo "deliverable commit not stamped:"; sed -n '/### Commits/,/### Review/p' "$DONE"; exit 1; }
grep -q '^- [0-9a-f]\{7,\} S-001: completion log$' "$DONE" || { echo "completion-log commit not stamped"; exit 1; }
grep -q "^- merge: $(git rev-parse HEAD)$" "$DONE" || { echo "merge SHA not stamped"; exit 1; }
# the stamp must not swallow the fixture's non-S-001 commit or the merge commit itself
[[ $(grep -c '^- [0-9a-f]\{7,\} ' "$DONE") -eq 2 ]] || { echo "unexpected commit lines stamped:"; grep '^- [0-9a-f]' "$DONE"; exit 1; }
bash "$MS" finish S-001-alpha --no-push >/dev/null
git show HEAD:"$DONE" | grep -q '^- merge: ' || { echo "stamp did not survive the completion commit"; exit 1; }

# --- 3. --allow-incomplete lands and records the reason ----------------------
prep S-002-beta
set +e; out=$(bash "$MS" land S-002-beta --allow-incomplete "wave close, executor gone" 2>&1); code=$?; set -e
[[ $code -eq 4 ]] || { echo "expected land exit 4 with --allow-incomplete, got $code:"; echo "$out"; exit 1; }
echo "$out" | grep -q 'WARNING: landing with an incomplete completion log for S-002' || { echo "no override warning:"; echo "$out"; exit 1; }
DONE2="docs/sprints/done/S-002-beta.md"
grep -q '^- [0-9-]\{10\} landed incomplete — wave close, executor gone$' "$DONE2" || { echo "override reason not recorded:"; sed -n '/### Deviations/,/### Deferred/p' "$DONE2"; exit 1; }
# the placeholder `— none` under Deviations was replaced, not duplicated
[[ $(sed -n '/### Deviations from brief/,/### Deferred/p' "$DONE2" | grep -c '^— none$') -eq 0 ]] || { echo "'— none' left under Deviations alongside the override note"; exit 1; }
bash "$MS" finish S-002-beta --no-push >/dev/null

# --- 4. finish warns on an oversized INDEX Outcome row -----------------------
long=$(printf 'x%.0s' $(seq 1 320))
sprint_file S-003 gamma complete >docs/sprints/in-progress/S-003-gamma.md
printf '| [S-003](done/S-003-gamma.md) | gamma | 1 | 2026-09-01 | %s |\n' "$long" >>docs/sprints/INDEX.md
git add -A && git commit -qm "start S-003 + index row"
make_branch S-003-gamma S-003 gamma
prep S-003-gamma
set +e; bash "$MS" land S-003-gamma >/dev/null 2>&1; code=$?; set -e
[[ $code -eq 4 ]] || { echo "expected land exit 4 for S-003, got $code"; exit 1; }
set +e; out=$(bash "$MS" finish S-003-gamma --no-push 2>&1); code=$?; set -e
[[ $code -eq 0 ]] || { echo "finish S-003 exited $code:"; echo "$out"; exit 1; }
echo "$out" | grep -Eq 'Outcome for S-003 is 3[0-9]{2} chars' || { echo "no oversized-Outcome warning:"; echo "$out"; exit 1; }

echo "merge-sprint land: all checks passed"
