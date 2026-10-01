#!/usr/bin/env bash
# Regression: start.sh / unstart.sh / reserve-wave.sh (and claims.mjs add) ended
# their ledger-only transactions with a raw `git push origin main`. Local main is
# shared by every session in the checkout, so that push published whatever else
# it carried — including another session's landed-but-held code, shipped past its
# deploy gate by a mere sprint start. They now push through ledger-push.sh, which
# pushes only an all-ledger range (docs/, .claude/) and otherwise pushes NOTHING
# and exits 3 ("committed locally, push withheld"), naming the code commits and
# the `push-main.sh --expect <ids>` settle command. A sentinel in its self-test
# fails if any other script in scripts/sprint/ grows a raw `push origin` again.
set -euo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
TMP=$(cd "$TMP" && pwd -P)
R="$TMP/repo" ORIGIN="$TMP/origin.git"

copy_scripts() { # copy_scripts <dest> — the full-tier scripts/sprint/ as installed
  mkdir -p "$1/workflows"
  cp "$REPO_DIR"/full-overlay/scripts/sprint/*.sh "$REPO_DIR"/full-overlay/scripts/sprint/*.mjs \
    "$REPO_DIR"/full-overlay/scripts/sprint/claims-tokens.json "$1/"
  cp "$REPO_DIR"/full-overlay/scripts/sprint/workflows/*.mjs "$1/workflows/" 2>/dev/null || true
  chmod +x "$1"/*.sh
}

# --- 1. self-test, sentinel scoped to a clean copy (not stray worktrees) -------
copy_scripts "$TMP/sentinel"
out=$(bash "$TMP/sentinel/ledger-push.sh" --self-test 2>&1) || { echo "ledger-push.sh --self-test failed:"; echo "$out"; exit 1; }

# --- 2. the sentinel catches a reintroduced raw push --------------------------
printf '\ngit -C "$ROOT" push origin "$MAIN"\n' >>"$TMP/sentinel/start.sh"
set +e; out=$(bash "$TMP/sentinel/ledger-push.sh" --self-test 2>&1); code=$?; set -e
[[ $code -ne 0 ]] && echo "$out" | grep -q 'raw push outside the guarded pushers.* start.sh' ||
  { echo "sentinel missed a raw push in start.sh (exit $code):"; echo "$out"; exit 1; }

# --- end-to-end fixture: full-tier ledger + bare origin + held code on main ----
mkdir -p "$R/docs/sprints/"{backlog,in-progress,done,rejected}
copy_scripts "$R/scripts/sprint"
cp "$REPO_DIR/full-overlay/docs/sprints/INDEX.md" "$REPO_DIR/full-overlay/docs/sprints/ROADMAP.md" "$R/docs/sprints/"
cp "$REPO_DIR/lite/docs/DOC_HEALTH.md" "$R/docs/"

backlog_file() { # $1 = id, $2 = kebab
  cat <<EOS
---
sprint: $1
status: backlog
goal: g
short: $2
depends_on: []
blocks: []
tags: []
story_points: 1
plan_date: 2026-09-01
start_date: null
end_date: null
touches:
  - src/$2.txt
---

# $1: $2
EOS
}

cd "$R"
git init -q -b main
git config user.email t@t && git config user.name t && git config commit.gpgsign false
printf '.claude/\n' >.gitignore
for s in "S-1 alpha" "S-2 beta" "S-3 gamma"; do
  set -- $s
  backlog_file "$1" "$2" >"docs/sprints/backlog/$1-$2.md"
done
# A brief far larger than a pipe buffer: the survival checks used to pipe
# `git show` into `grep -q`, which SIGPIPEs git-show under pipefail on big files.
for i in $(seq 1 20000); do echo "- padding line $i of a deepened brief"; done >>docs/sprints/backlog/S-2-beta.md
git add -A && git commit -qm "init ledger"
git init -q --bare -b main "$ORIGIN"
git remote add origin "$ORIGIN"
git push -q -u origin main

mkdir -p src && echo held >src/held.ts
git add src/held.ts && git commit -qm "S-9: another session's held code"

SS="$R/scripts/sprint"
run() { set +e; out=$(bash "$@" 2>&1); code=$?; set -e; }
origin_main() { git -C "$ORIGIN" rev-parse main; }
ORIGIN0=$(origin_main)

# --- 3. reserve-wave: committed, withheld (3), summary still printed -----------
run "$SS/reserve-wave.sh" S-3 --wait 0
[[ $code -eq 3 ]] || { echo "reserve-wave: expected exit 3 with held code on main, got $code:"; echo "$out"; exit 1; }
echo "$out" | grep -q '^wave id: W-' || { echo "reserve-wave: summary not printed on withhold:"; echo "$out"; exit 1; }
echo "$out" | grep -q -- '--expect S-9' || { echo "reserve-wave: settle hint should name S-9:"; echo "$out"; exit 1; }
git log -1 --format=%s | grep -q '^sprint: reserve wave W-' || { echo "reserve-wave: reservation commit missing"; exit 1; }
[[ $(origin_main) == "$ORIGIN0" ]] || { echo "reserve-wave: origin moved — held code shipped"; exit 1; }

# --- 4. start: committed, withheld (3), not rolled back -----------------------
run "$SS/start.sh" S-1 --wait 0
[[ $code -eq 3 ]] || { echo "start: expected exit 3 with held code on main, got $code:"; echo "$out"; exit 1; }
echo "$out" | grep -q '^started S-1 on main' || { echo "start: summary not printed on withhold:"; echo "$out"; exit 1; }
[[ -f docs/sprints/in-progress/S-1-alpha.md ]] || { echo "start: commit rolled back on withhold"; exit 1; }
git log -1 --format=%s | grep -q '^sprint: start S-1' || { echo "start: start commit is not HEAD"; exit 1; }
[[ $(origin_main) == "$ORIGIN0" ]] || { echo "start: origin moved — held code shipped"; exit 1; }

# --- 5. unstart: committed, withheld (3) --------------------------------------
run "$SS/unstart.sh" S-1 --wait 0
[[ $code -eq 3 ]] || { echo "unstart: expected exit 3 with held code on main, got $code:"; echo "$out"; exit 1; }
[[ -f docs/sprints/backlog/S-1-alpha.md ]] || { echo "unstart: commit rolled back on withhold"; exit 1; }
[[ $(origin_main) == "$ORIGIN0" ]] || { echo "unstart: origin moved — held code shipped"; exit 1; }

# --- 6. once the owner has settled, a ledger-only range pushes (0); S-2's brief
#        is the oversized one, so this also covers the SIGPIPE-safe survival check
git push -q origin main # stands in for the owner's push-main.sh --expect S-9
run "$SS/start.sh" S-2 --wait 0
[[ $code -eq 0 ]] || { echo "start: expected exit 0 on a ledger-only range, got $code:"; echo "$out"; exit 1; }
[[ $(origin_main) == "$(git rev-parse main)" ]] || { echo "start: ledger-only start was not pushed"; exit 1; }

# --- 7. --no-push still defers with the usual notice ---------------------------
run "$SS/unstart.sh" S-2 --no-push --wait 0
[[ $code -eq 0 ]] || { echo "unstart --no-push: expected exit 0, got $code:"; echo "$out"; exit 1; }
echo "$out" | grep -q 'push deferred — local main is 1 commit(s) ahead of origin/main' ||
  { echo "unstart --no-push: deferral notice missing:"; echo "$out"; exit 1; }

echo "ledger-push: all checks passed"
