#!/usr/bin/env bash
# Locked sprint-unstart transaction — the ONLY sanctioned way to move an in-flight
# sprint back to the backlog (the inverse of start.sh). Intended for sprints pulled
# back after start — e.g. a wave member whose PLAN_GAP the user decides not to fix
# now. Keeps plan_date, touches:, and Pre-Sprint Decisions; resets status/start_date
# and clears any wave: reservation (the sprint becomes reservable again).
#
#   unstart.sh S-NNN [--reason "…"] [--force] [--no-push] [--wait <secs>]
#
# Refuses if the sprint branch carries deliverable commits beyond main — a sprint
# with real work should go to rejected/ (keeping its branch) or be completed, not
# unstarted. --force overrides after you have confirmed the work is disposable.
#
# Exit codes: 0 ok · 2 not in-flight / branch has commits · 75 lock busy ·
# 1 unexpected (transaction rolled back)
set -euo pipefail

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
GIT_COMMON=$(git rev-parse --path-format=absolute --git-common-dir)
ROOT=${GIT_COMMON%/.git}
MAIN=${SPRINT_MAIN_BRANCH:-main}

SPRINT=${1:?usage: unstart.sh S-NNN [--reason "…"] [--force] [--no-push] [--wait secs]}
shift
REASON="" FORCE=0 NO_PUSH=0 WAIT=300
while [[ $# -gt 0 ]]; do
  case "$1" in
  --reason) REASON=$2; shift 2 ;;
  --force) FORCE=1; shift ;;
  --no-push) NO_PUSH=1; shift ;;
  --wait) WAIT=$2; shift 2 ;;
  *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

# Locate the in-progress file (exit 2 if missing — not in flight).
shopt -s nullglob
candidates=("$ROOT/docs/sprints/in-progress/$SPRINT-"*.md)
if [[ ${#candidates[@]} -ne 1 ]]; then
  echo "$SPRINT: expected exactly one in-progress file, found ${#candidates[@]} — is it in flight?" >&2
  exit 2
fi
FILE=${candidates[0]}
BASENAME=$(basename "$FILE")
TITLE=$(sed -n "s/^# $SPRINT: //p" "$FILE" | head -1)
TITLE=${TITLE:-$BASENAME}
BRANCH=${BASENAME%.md}

# Refuse when the branch carries deliverable work beyond its branch point.
if git -C "$ROOT" rev-parse -q --verify "refs/heads/$BRANCH" >/dev/null; then
  AHEAD=$(git -C "$ROOT" rev-list --count "$MAIN..$BRANCH")
  if [[ $AHEAD -gt 0 && $FORCE -eq 0 ]]; then
    echo "$BRANCH carries $AHEAD commit(s) beyond $MAIN — refusing to unstart." >&2
    echo "Options: move the sprint to rejected/ and keep the branch, or re-run with --force." >&2
    exit 2
  fi
fi

TOKEN=$("$SELF_DIR/lock.sh" acquire "unstart-$SPRINT" --wait "$WAIT")
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

# The transaction: move back, reset lifecycle fields (keep plan_date/touches), regen, commit.
MUTATING=1
git -C "$ROOT" mv "docs/sprints/in-progress/$BASENAME" "docs/sprints/backlog/$BASENAME"
NEW_FILE="$ROOT/docs/sprints/backlog/$BASENAME"
node "$SELF_DIR/frontmatter.mjs" set "$NEW_FILE" status backlog
node "$SELF_DIR/frontmatter.mjs" set "$NEW_FILE" start_date null
node "$SELF_DIR/frontmatter.mjs" set "$NEW_FILE" wave null # re-reservable by any wave
node "$SELF_DIR/regen.mjs" >/dev/null

PATHS=("docs/sprints/backlog/$BASENAME" docs/sprints/INDEX.md docs/sprints/ROADMAP.md)
git -C "$ROOT" add -- "${PATHS[@]}"
if git -C "$ROOT" diff --cached --name-only | grep -q ' 2\.'; then
  echo 'staged a " 2." sync-duplicate file — aborting' >&2
  exit 1
fi
MSG="sprint: unstart $SPRINT — $TITLE"
if [[ -n $REASON ]]; then
  MSG="$MSG ($REASON)"
fi
git -C "$ROOT" commit --no-verify -q -m "$MSG" -- "${PATHS[@]}" "docs/sprints/in-progress/$BASENAME"
COMMITTED=1

# Survival check (grep without -q: -q SIGPIPEs git-show and trips pipefail).
git -C "$ROOT" show "HEAD:docs/sprints/backlog/$BASENAME" | grep '^status: backlog' >/dev/null ||
  { echo "FATAL: committed sprint file is not status: backlog — inspect HEAD" >&2; exit 1; }

if [[ $NO_PUSH -eq 0 ]]; then
  git -C "$ROOT" push origin "$MAIN" || { echo "push failed — local unstart commit is intact; resolve and push" >&2; exit 1; }
fi

echo "unstarted $SPRINT — back in backlog/ on $MAIN at $(git -C "$ROOT" rev-parse HEAD)"
echo "cleanup (if they exist): git worktree remove .claude/worktrees/$BRANCH · git branch -D $BRANCH"
