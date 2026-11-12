#!/usr/bin/env bash
# Regression: in train mode (`merge-sprint.sh land <branch> --sprints S-A,S-B`),
# land's post-merge per-member loop (git mv to done/, frontmatter flips,
# stamp_commits, note_incomplete) read a stale `$s` left over from the lint
# loop, so EVERY member's `### Commits` was stamped with the LAST member's
# commits, and --allow-incomplete notes keyed on the wrong id (attached to the
# wrong file, or dropped). The loop now binds `s=${SPRINTS[i]}` per iteration.
set -euo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
TMP=$(cd "$TMP" && pwd -P)
R="$TMP/repo"

# --- fixture: a full-tier install with four in-progress sprints --------------
mkdir -p "$R/scripts/sprint" "$R/docs/sprints/"{backlog,in-progress,done,rejected}
cp "$REPO_DIR"/full-overlay/scripts/sprint/*.sh "$REPO_DIR"/full-overlay/scripts/sprint/*.mjs "$REPO_DIR"/full-overlay/scripts/sprint/claims-tokens.json "$R/scripts/sprint/"
cp "$REPO_DIR/lite/scripts/sprint/close-check.mjs" "$R/scripts/sprint/"
cp "$REPO_DIR/full-overlay/docs/sprints/INDEX.md" "$REPO_DIR/full-overlay/docs/sprints/ROADMAP.md" "$R/docs/sprints/"
cp "$REPO_DIR/lite/docs/DOC_HEALTH.md" "$R/docs/"
chmod +x "$R"/scripts/sprint/*.sh

sprint_file() { # $1 = id, $2 = kebab, $3 = "complete" | "incomplete"
  local ev=""
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
sprint_file S-001 alpha complete   >docs/sprints/in-progress/S-001-alpha.md
sprint_file S-002 beta complete    >docs/sprints/in-progress/S-002-beta.md
sprint_file S-003 gamma incomplete >docs/sprints/in-progress/S-003-gamma.md
sprint_file S-004 delta complete   >docs/sprints/in-progress/S-004-delta.md
git add -A && git commit -qm "init ledger"

commit_on() { # $1 = worktree, $2 = file stem, $3 = commit subject
  echo "$3" >>"$1/src/$2.txt"
  git -C "$1" add -A
  git -C "$1" commit -qm "$3"
}

# Interleave the members' commits so a stamp keyed on the wrong id is visible.
make_train() { # $1 = branch, $2 = first id, $3 = its kebab, $4 = second id, $5 = its kebab
  local wt="$R/.claude/worktrees/$1"
  git worktree add -q "$wt" -b "$1" main
  mkdir -p "$wt/src"
  commit_on "$wt" "$3" "$2: first $3 change"
  commit_on "$wt" "$5" "$4: first $5 change"
  commit_on "$wt" "$3" "$2: second $3 change"
  commit_on "$wt" "$5" "$4: second $5 change"
}

MS="$R/scripts/sprint/merge-sprint.sh"
prep() { set +e; bash "$MS" prepare "$1" --no-push >/dev/null 2>&1; local c=$?; set -e; [[ $c -eq 0 || $c -eq 3 ]] || { echo "prepare $1 exited $c"; exit 1; }; }
commits_of() { sed -n '/^### Commits$/,/^### Review$/p' "$1"; }

# assert_stamped <done-file> <own id> <other id>: exactly the own id's two
# commits are stamped, none of the other member's.
assert_stamped() {
  local f=$1 own=$2 other=$3 n
  [[ -f $f ]] || { echo "$f not moved to done/"; exit 1; }
  grep -q '^status: done' "$f" || { echo "$f status not flipped"; exit 1; }
  if commits_of "$f" | grep -q "^- [0-9a-f]\{7,\} $other: "; then
    echo "$f (${own}) stamped with ${other}'s commits:"; commits_of "$f"; exit 1
  fi
  n=$(commits_of "$f" | grep -c "^- [0-9a-f]\{7,\} $own: " || true)
  [[ $n -eq 2 ]] || { echo "$f: expected 2 $own commits stamped, got $n:"; commits_of "$f"; exit 1; }
  grep -q "^- merge: $(git rev-parse HEAD)$" "$f" || { echo "$f: merge SHA not stamped"; exit 1; }
}

# --- 1. train land: each member's ### Commits lists only its own commits -----
make_train train-W-a S-001 alpha S-002 beta
prep train-W-a
set +e; out=$(bash "$MS" land train-W-a --sprints S-001,S-002 2>&1); code=$?; set -e
[[ $code -eq 4 ]] || { echo "expected train land exit 4, got $code:"; echo "$out"; exit 1; }
assert_stamped docs/sprints/done/S-001-alpha.md S-001 S-002
assert_stamped docs/sprints/done/S-002-beta.md  S-002 S-001
bash "$MS" finish train-W-a --sprints S-001,S-002 --no-push >/dev/null

# --- 2. --allow-incomplete: the note lands on the incomplete member only -----
# S-003 (first member) is incomplete, S-004 (last member) is complete — a stale
# `$s` would key the note on S-004 and drop it from S-003.
make_train train-W-b S-003 gamma S-004 delta
prep train-W-b
set +e; out=$(bash "$MS" land train-W-b --sprints S-003,S-004 --allow-incomplete "train close, executor gone" 2>&1); code=$?; set -e
[[ $code -eq 4 ]] || { echo "expected train land exit 4 with --allow-incomplete, got $code:"; echo "$out"; exit 1; }
echo "$out" | grep -q 'WARNING: landing with an incomplete completion log for S-003 — ' ||
  { echo "override warning does not name exactly S-003:"; echo "$out"; exit 1; }
D3=docs/sprints/done/S-003-gamma.md D4=docs/sprints/done/S-004-delta.md
assert_stamped "$D3" S-003 S-004
assert_stamped "$D4" S-004 S-003
grep -q '^- [0-9-]\{10\} landed incomplete — train close, executor gone$' "$D3" ||
  { echo "override note missing from S-003 (the incomplete member):"; sed -n '/### Deviations/,/### Deferred/p' "$D3"; exit 1; }
grep -q 'landed incomplete' "$D4" &&
  { echo "override note attached to S-004 (a complete member):"; sed -n '/### Deviations/,/### Deferred/p' "$D4"; exit 1; }
bash "$MS" finish train-W-b --sprints S-003,S-004 --no-push >/dev/null

echo "merge-sprint train land: all checks passed"
