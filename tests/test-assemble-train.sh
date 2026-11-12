#!/usr/bin/env bash
# assemble-train.sh: batch landing. Member branches are merged into ONE integration
# branch (land-<W-id>-<n>) that the real merge-sprint.sh train path lands in a single
# transaction. Covers: clean assembly + a real prepare/land/finish round trip (each
# done-file stamped with ITS OWN commits), a conflicting member skipped while the rest
# merge, total failure leaving nothing behind, -N suffixing, generated-doc conflicts
# auto-resolving, precondition failures (exit 1) and --cleanup. Fixture style as in
# test-merge-sprint-land.sh. Exit contract: 0 >=1 merged · 2 none merged / cleanup of an
# unmerged branch · 1 usage-precondition (incl. a --cleanup name that is not land-W-*).
set -euo pipefail
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
TMP=$(cd "$TMP" && pwd -P)
W=W-20260901-ab12
FIXN=0

sprint_file() { # $1 = id, $2 = kebab — a COMPLETE in-progress record touching src/<kebab>.txt
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

# build_repo: a fresh full-tier install with in-progress S-001 alpha, S-002 beta, S-003 gamma
# on main (plus a shared base file src/shared.txt). Sets R and cd's into it.
build_repo() {
  FIXN=$((FIXN + 1))
  R="$TMP/repo$FIXN"
  mkdir -p "$R/scripts/sprint" "$R/docs/sprints/"{backlog,in-progress,done,rejected} "$R/src"
  cp "$REPO_DIR"/full-overlay/scripts/sprint/*.sh "$REPO_DIR"/full-overlay/scripts/sprint/*.mjs "$REPO_DIR"/full-overlay/scripts/sprint/claims-tokens.json "$R/scripts/sprint/"
  cp "$REPO_DIR/lite/scripts/sprint/close-check.mjs" "$R/scripts/sprint/"
  cp "$REPO_DIR/full-overlay/docs/sprints/INDEX.md" "$REPO_DIR/full-overlay/docs/sprints/ROADMAP.md" "$R/docs/sprints/"
  cp "$REPO_DIR/lite/docs/DOC_HEALTH.md" "$R/docs/"
  chmod +x "$R"/scripts/sprint/*.sh
  cd "$R"
  git init -q && git branch -M main
  printf '.claude/\n' >.gitignore
  git config user.email t@t && git config user.name t
  echo base >src/shared.txt
  sprint_file S-001 alpha >docs/sprints/in-progress/S-001-alpha.md
  sprint_file S-002 beta  >docs/sprints/in-progress/S-002-beta.md
  sprint_file S-003 gamma >docs/sprints/in-progress/S-003-gamma.md
  git add -A && git commit -qm "init ledger"
  AT="$R/scripts/sprint/assemble-train.sh"
  MS="$R/scripts/sprint/merge-sprint.sh"
}

# commit_on BRANCH BASE-REF MESSAGE FILE CONTENT — commit one change on BRANCH (created from
# BASE-REF when absent) through a throwaway worktree, leaving only the branch behind.
commit_on() {
  local br=$1 base=$2 msg=$3 file=$4 content=$5 wt="$TMP/wt-$1-$RANDOM"
  if git show-ref --verify --quiet "refs/heads/$br"; then
    git worktree add -q "$wt" "$br"
  else
    git worktree add -q "$wt" -b "$br" "$base"
  fi
  mkdir -p "$wt/$(dirname "$file")"
  printf '%s\n' "$content" >"$wt/$file"
  git -C "$wt" add -A && git -C "$wt" commit -qm "$msg"
  git worktree remove --force "$wt"
}

OUT="" CODE=0
run() { set +e; OUT=$("$@" 2>&1); CODE=$?; set -e; }
fail() { echo "$1"; echo "$OUT"; exit 1; }
want_code() { [[ $CODE -eq $1 ]] || fail "$2: expected exit $1, got $CODE:"; }
want_line() { printf '%s\n' "$OUT" | grep -qxF -- "$1" || fail "missing line: $1"; }
no_line() { printf '%s\n' "$OUT" | grep -q -- "$1" && fail "unexpected output matching: $1"; return 0; }
no_land_leftovers() {
  [[ -z $(git branch --list 'land-*') ]] || { echo "$1: land-* branch left behind:"; git branch --list 'land-*'; exit 1; }
  [[ -z $(git worktree list --porcelain | grep 'worktrees/land-') ]] || { echo "$1: land worktree left behind"; git worktree list; exit 1; }
  [[ ! -e $R/.claude/worktrees/land-$W-1 ]] || { echo "$1: worktree dir left behind"; exit 1; }
}
lock_free() { [[ $(bash "$R/scripts/sprint/lock.sh" status) == FREE ]] || { echo "$1: lock held"; exit 1; }; }

# ====== 1. clean assembly, then the REAL prepare / land --sprints / finish ======
build_repo
commit_on S-001-alpha main "S-001: build alpha" src/alpha.txt a1
commit_on S-001-alpha main "S-001: tweak alpha" src/alpha.txt a2
commit_on S-002-beta  main "S-002: build beta"  src/beta.txt b
commit_on S-003-gamma main "S-003: build gamma" src/gamma.txt g
MAIN0=$(git rev-parse main)
run bash "$AT" "$W" S-003 S-001 S-002   # deliberately out of order
want_code 0 "clean assemble"
BR=land-$W-1
want_line "branch: $BR"
want_line "worktree: $R/.claude/worktrees/$BR"
want_line "merged: S-001 S-002 S-003"
no_line '^conflict:'
want_line "next: run scripts/sprint/gate.sh in the worktree, then: merge-sprint.sh prepare $BR && merge-sprint.sh land $BR --sprints S-001,S-002,S-003"
[[ $(git rev-parse main) == "$MAIN0" ]] || fail "assemble moved main"
git show-ref --verify --quiet "refs/heads/$BR" || fail "integration branch missing"
[[ -d $R/.claude/worktrees/$BR ]] || fail "integration worktree missing"
[[ $(git log --merges --reverse --format=%s "main..$BR") == "land: merge S-001 into $BR
land: merge S-002 into $BR
land: merge S-003 into $BR" ]] || { echo "merge commits wrong / out of order:"; git log --merges --reverse --format=%s "main..$BR"; exit 1; }
lock_free "assemble (takes no lock)"
[[ -z $(git status --porcelain) ]] || fail "primary checkout dirty after assemble"

# the real train path
set +e; bash "$MS" prepare "$BR" --no-push >/dev/null 2>&1; code=$?; set -e
[[ $code -eq 0 || $code -eq 3 ]] || { echo "prepare exited $code"; exit 1; }
run bash "$MS" land "$BR" --sprints S-001,S-002,S-003
want_code 4 "land --sprints on the integration branch"
for pair in "1:alpha" "2:beta" "3:gamma"; do
  n=${pair%%:*} name=${pair##*:}
  f=docs/sprints/done/S-00$n-$name.md
  [[ -f $f ]] || fail "$f not moved to done/"
  grep -q "^- [0-9a-f]\{7,\} S-00$n: build $name\$" "$f" || { echo "S-00$n lacks its own commit:"; sed -n '/### Commits/,/### Review/p' "$f"; exit 1; }
  for other in 1 2 3; do
    [[ $other -eq $n ]] && continue
    grep -q "S-00$other:" "$f" && { echo "S-00$n stamped with S-00$other's commits:"; sed -n '/### Commits/,/### Review/p' "$f"; exit 1; }
  done
done
grep -q '^- [0-9a-f]\{7,\} S-001: tweak alpha$' docs/sprints/done/S-001-alpha.md || fail "S-001's second commit not stamped"
run bash "$MS" finish "$BR" --sprints S-001,S-002,S-003 --no-push
want_code 0 "finish --sprints"
lock_free "finish"

# cleanup of a landed (fully merged) branch needs no --force
run bash "$AT" --cleanup "$BR"
want_code 0 "cleanup of a merged branch"
no_land_leftovers "cleanup merged"
run bash "$AT" --cleanup "$BR"
want_code 0 "cleanup is idempotent"
printf '%s\n' "$OUT" | grep -q 'already gone' || fail "idempotent cleanup gave no note"

# ====== 2. a conflicting member is skipped, the rest merge; 4. -2 suffix; 7. cleanup ======
build_repo
commit_on S-001-alpha main "S-001: build alpha" src/alpha.txt a
commit_on S-001-alpha main "S-001: edit shared" src/shared.txt one
commit_on S-002-beta  main "S-002: build beta"  src/beta.txt b
commit_on S-002-beta  main "S-002: edit shared" src/shared.txt two
commit_on S-003-gamma main "S-003: build gamma" src/gamma.txt g
BETA_TIP=$(git rev-parse S-002-beta)
run bash "$AT" "$W" S-001 S-002 S-003
want_code 0 "assemble with one conflicting member"
BR=land-$W-1
want_line "merged: S-001 S-003"
want_line "conflict: S-002 (src/shared.txt)"
want_line "next: run scripts/sprint/gate.sh in the worktree, then: merge-sprint.sh prepare $BR && merge-sprint.sh land $BR --sprints S-001,S-003"
[[ $(git rev-parse S-002-beta) == "$BETA_TIP" ]] || fail "the conflicting member's own branch moved"
WT=$R/.claude/worktrees/$BR
[[ -z $(git -C "$WT" status --porcelain) ]] || fail "integration worktree not clean after an aborted member merge"
git -C "$WT" rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1 && fail "merge left in progress"
[[ $(cat "$WT/src/shared.txt") == one ]] || fail "integration content wrong"
[[ -f $WT/src/gamma.txt && ! -f $WT/src/beta.txt ]] || fail "wrong members in the integration tree"
# a second assemble for the same wave takes the next suffix
run bash "$AT" "$W" S-001 S-003
want_code 0 "second assemble"
want_line "branch: land-$W-2"
want_line "merged: S-001 S-003"
[[ -d $R/.claude/worktrees/land-$W-2 ]] || fail "second worktree missing"
# cleanup: unmerged is refused without --force, removed with it
run bash "$AT" --cleanup "land-$W-1"
want_code 2 "cleanup of an unmerged branch"
git show-ref --verify --quiet "refs/heads/land-$W-1" && [[ -d $WT ]] || fail "refused cleanup still removed things"
# non-land names are refused outright
git branch "train-$W" main
for name in S-001-alpha main "train-$W"; do
  run bash "$AT" --cleanup "$name" --force
  want_code 1 "cleanup of '$name'"
  git show-ref --verify --quiet "refs/heads/$name" || fail "'$name' was deleted"
done
run bash "$AT" --cleanup "land-$W-1" --force
want_code 0 "forced cleanup"
git show-ref --verify --quiet "refs/heads/land-$W-1" && fail "branch survived --force cleanup"
[[ ! -e $WT ]] || fail "worktree survived --force cleanup"
git branch -D -q "train-$W"
git show-ref --verify --quiet "refs/heads/land-$W-2" || fail "cleanup removed the wrong branch"
run bash "$AT" --cleanup "land-$W-1" --force
want_code 0 "forced cleanup is idempotent"
run bash "$AT" --cleanup "land-$W-2" --force
want_code 0 "cleanup of -2"

# ====== 3. nothing merges: exit 2 and nothing left behind ======
build_repo
commit_on S-001-alpha main "S-001: edit shared" src/shared.txt one
commit_on S-002-beta  main "S-002: edit shared" src/shared.txt two
echo moved >src/shared.txt && git commit -qam "main moves on shared.txt"
MAIN0=$(git rev-parse main)
run bash "$AT" "$W" S-001
want_code 2 "single conflicting member"
want_line "conflict: S-001 (src/shared.txt)"
no_line '^branch:'
no_land_leftovers "single member"
run bash "$AT" "$W" S-001 S-002
want_code 2 "every member conflicting"
want_line "conflict: S-001 (src/shared.txt)"
want_line "conflict: S-002 (src/shared.txt)"
no_land_leftovers "all members"
[[ $(git rev-parse main) == "$MAIN0" && -z $(git status --porcelain) ]] || fail "main / primary checkout touched"
lock_free "exit 2"

# ====== 5. a conflict confined to generated docs takes the integration side ======
build_repo
for n in 1 2; do
  name=$([[ $n -eq 1 ]] && echo alpha || echo beta)
  commit_on "S-00$n-$name" main "S-00$n: build $name" "src/$name.txt" x
  wt="$TMP/wt-index-$n"
  git worktree add -q "$wt" "S-00$n-$name"
  { echo "member $n edit"; cat "$wt/docs/sprints/INDEX.md"; } >"$wt/INDEX.new" && mv "$wt/INDEX.new" "$wt/docs/sprints/INDEX.md"
  git -C "$wt" commit -qam "S-00$n: touch index"
  git worktree remove --force "$wt"
done
run bash "$AT" "$W" S-001 S-002
want_code 0 "generated-doc conflict"
want_line "merged: S-001 S-002"
no_line '^conflict:'
WT=$R/.claude/worktrees/land-$W-1
[[ $(head -1 "$WT/docs/sprints/INDEX.md") == "member 1 edit" ]] || fail "INDEX.md did not take the integration side"
grep -q '^<<<<<<<\|^>>>>>>>' "$WT/docs/sprints/INDEX.md" && fail "conflict markers left in INDEX.md"
[[ -z $(git -C "$WT" status --porcelain) ]] || fail "worktree dirty after auto-resolve"
[[ -f $WT/src/alpha.txt && -f $WT/src/beta.txt ]] || fail "members' own files missing"

# ====== 6. preconditions: all exit 1, nothing created ======
build_repo
commit_on S-001-alpha main "S-001: build alpha" src/alpha.txt a
run bash "$AT" "$W" S-009
want_code 1 "sprint with no in-progress file / branch"
run bash "$AT" "$W" S-001 S-002           # S-002 is in-progress but has no branch
want_code 1 "sprint with no branch"
printf '%s\n' "$OUT" | grep -q 'S-002: expected exactly one local branch' || fail "no message about the missing branch"
git branch S-001-dup main
run bash "$AT" "$W" S-001
want_code 1 "sprint with two branches"
git branch -D -q S-001-dup
run bash "$AT" W-1 S-001
want_code 1 "malformed wave id"
run bash "$AT" "$W"
want_code 1 "no sprints"
run bash "$AT"
want_code 1 "no args"
run bash "$AT" "$W" S-001 S-001
want_code 1 "duplicate sprint"
run bash "$AT" "$W" alpha
want_code 1 "non-sprint id"
git checkout -q -b elsewhere
run bash "$AT" "$W" S-001
want_code 1 "primary not on main"
printf '%s\n' "$OUT" | grep -q 'not on main' || fail "no message about the primary branch"
git checkout -q main
no_land_leftovers "preconditions"

# no template-renderer placeholders in the new script
if grep -nE '\{\{[^}]*\}\}' "$REPO_DIR/full-overlay/scripts/sprint/assemble-train.sh"; then
  echo "template placeholder syntax found in assemble-train.sh"; exit 1
fi

echo "assemble-train: all checks passed"
