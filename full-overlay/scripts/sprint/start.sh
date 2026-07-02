#!/usr/bin/env bash
# Locked sprint-start transaction — the ONLY way a sprint becomes in-flight.
# Runs entirely against the primary checkout (the lifecycle ledger on main);
# call it BEFORE creating the sprint worktree, then branch from the SHA it prints.
#
#   start.sh S-NNN [--touches "p1,p2,…"] [--no-push] [--wait <secs>]
#
# --touches sets/replaces the claims manifest; omit it only when the backlog
# file already carries a populated `touches:` (e.g. from /sprint plan).
#
# Exit codes: 0 ok (prints new main SHA) · 2 claims overlap / sprint not in
# backlog · 75 lock busy · 1 unexpected (transaction rolled back)
set -euo pipefail

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
GIT_COMMON=$(git rev-parse --path-format=absolute --git-common-dir)
ROOT=${GIT_COMMON%/.git}
MAIN=${SPRINT_MAIN_BRANCH:-main}

SPRINT=${1:?usage: start.sh S-NNN [--touches "p1,p2"] [--no-push] [--wait secs]}
shift
TOUCHES="" NO_PUSH=0 WAIT=300
while [[ $# -gt 0 ]]; do
  case "$1" in
  --touches) TOUCHES=$2; shift 2 ;;
  --no-push) NO_PUSH=1; shift ;;
  --wait) WAIT=$2; shift 2 ;;
  *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

# Locate the backlog file (exit 2 if missing — likely already claimed by another agent).
shopt -s nullglob
candidates=("$ROOT/docs/sprints/backlog/$SPRINT-"*.md)
if [[ ${#candidates[@]} -ne 1 ]]; then
  echo "$SPRINT: expected exactly one backlog file, found ${#candidates[@]} — already started by another agent?" >&2
  exit 2
fi
FILE=${candidates[0]}
BASENAME=$(basename "$FILE")
TITLE=$(sed -n "s/^# $SPRINT: //p" "$FILE" | head -1)
TITLE=${TITLE:-$BASENAME}

# Plan-readiness (advisory — never blocks): /sprint wave plans unplanned sprints
# before dispatch; a solo start proceeds with this warning.
if [[ $(node "$SELF_DIR/frontmatter.mjs" get "$FILE" plan_date) == "null" ]]; then
  echo "⚠ $SPRINT has no plan_date (never certified by /sprint plan) — starting anyway; /sprint wave would run a planning pass first" >&2
fi

TOKEN=$("$SELF_DIR/lock.sh" acquire "start-$SPRINT" --wait "$WAIT")
COMMITTED=0
MUTATING=0 # set just before the first ledger mutation — a precondition failure must NOT
           # reset --hard (it would destroy unrelated in-flight work, e.g. the wave
           # planning pass's uncommitted deepening edits)
cleanup() {
  if [[ $MUTATING -eq 1 && $COMMITTED -eq 0 ]]; then
    git -C "$ROOT" reset --hard -q HEAD || true # roll back the staged transaction only
  fi
  "$SELF_DIR/lock.sh" release "$TOKEN" || true
}
trap cleanup EXIT

# Primary checkout must be the clean ledger on the main branch (untracked junk is tolerated).
[[ $(git -C "$ROOT" branch --show-current) == "$MAIN" ]] || { echo "primary checkout is not on $MAIN — stop and ask the user" >&2; exit 1; }
[[ -z $(git -C "$ROOT" status --porcelain --untracked-files=no) ]] || { echo "primary checkout has tracked changes — stop and ask the user" >&2; exit 1; }
if [[ $NO_PUSH -eq 0 ]]; then
  git -C "$ROOT" pull --ff-only origin "$MAIN"
fi

# Claims: CLI --touches wins; otherwise the file's existing manifest must be populated.
if [[ -n $TOUCHES ]]; then
  CLAIM_PATHS=$TOUCHES
else
  CLAIM_PATHS=$(node "$SELF_DIR/frontmatter.mjs" get "$FILE" touches | node -e 'const v=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(Array.isArray(v)?v.join(","):"")')
  [[ -n $CLAIM_PATHS ]] || { echo "no claims: pass --touches or populate touches: in $BASENAME first" >&2; exit 2; }
fi
node "$SELF_DIR/claims.mjs" check --paths "$CLAIM_PATHS" --sprint "$SPRINT" || exit $?

# The transaction: move, flip frontmatter, write claims, regen, commit.
MUTATING=1
git -C "$ROOT" mv "docs/sprints/backlog/$BASENAME" "docs/sprints/in-progress/$BASENAME"
NEW_FILE="$ROOT/docs/sprints/in-progress/$BASENAME"
node "$SELF_DIR/frontmatter.mjs" set "$NEW_FILE" status in-progress
node "$SELF_DIR/frontmatter.mjs" set "$NEW_FILE" start_date "$(date +%F)"
node "$SELF_DIR/frontmatter.mjs" set "$NEW_FILE" touches "$(node -e 'console.log(JSON.stringify(process.argv[1].split(",").map(s=>s.trim()).filter(Boolean)))' "$CLAIM_PATHS")"
node "$SELF_DIR/regen.mjs" >/dev/null

PATHS=("docs/sprints/in-progress/$BASENAME" docs/sprints/INDEX.md docs/sprints/ROADMAP.md)
git -C "$ROOT" add -- "${PATHS[@]}"
if git -C "$ROOT" diff --cached --name-only | grep -q ' 2\.'; then
  echo 'staged a " 2." sync-duplicate file — aborting' >&2
  exit 1
fi
git -C "$ROOT" commit --no-verify -q -m "sprint: start $SPRINT — $TITLE" -- "${PATHS[@]}" "docs/sprints/backlog/$BASENAME"
COMMITTED=1

# Survival check (the lint-staged/mv stash bug class): the commit must carry the claims.
git -C "$ROOT" show "HEAD:docs/sprints/in-progress/$BASENAME" | grep -q '^touches:' ||
  { echo "FATAL: committed sprint file lost its touches: frontmatter — inspect HEAD" >&2; exit 1; }
git -C "$ROOT" show "HEAD:docs/sprints/in-progress/$BASENAME" | grep -q '^status: in-progress' ||
  { echo "FATAL: committed sprint file is not status: in-progress — inspect HEAD" >&2; exit 1; }

if [[ $NO_PUSH -eq 0 ]]; then
  git -C "$ROOT" push origin "$MAIN" || { echo "push failed — local start commit is intact; resolve and push before creating the worktree" >&2; exit 1; }
fi

echo "started $SPRINT on $MAIN at $(git -C "$ROOT" rev-parse HEAD)"
echo "next: git -C \"$ROOT\" worktree add .claude/worktrees/${BASENAME%.md} -b ${BASENAME%.md} $MAIN"
