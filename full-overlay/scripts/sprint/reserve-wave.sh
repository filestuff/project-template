#!/usr/bin/env bash
# Locked wave-reservation transaction — claims a set of backlog sprints for one
# wave so that concurrent sessions running their own waves cannot pick the same
# members (or members whose `touches:` overlap). A reservation writes
# `wave: W-<id>` into each member's frontmatter and commits on main under the
# sprint-main lock; claims.mjs treats reserved backlog sprints as claim holders.
#
#   reserve-wave.sh S-A S-B …                  # reserve members under a fresh W-<id> (printed)
#   reserve-wave.sh --drop W-<id> S-NNN        # release ONE member (e.g. rejected at the decision round)
#   reserve-wave.sh --release W-<id>           # release ALL backlog members of the wave
#
# --release is also the recovery for a crashed session's stale reservation —
# like lock.sh steal, only ever run it with the user's explicit confirmation.
# Options for all forms: [--no-push] [--wait <secs>]
#
# Exit codes: 0 ok · 2 member missing / already reserved / claims overlap ·
# 75 lock busy · 1 unexpected (transaction rolled back)
set -euo pipefail

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
GIT_COMMON=$(git rev-parse --path-format=absolute --git-common-dir)
ROOT=${GIT_COMMON%/.git}
MAIN=${SPRINT_MAIN_BRANCH:-main}

MODE=reserve WAVE="" NO_PUSH=0 WAIT=300
MEMBERS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
  --drop) MODE=drop; WAVE=$2; shift 2 ;;
  --release) MODE=release; WAVE=$2; shift 2 ;;
  --no-push) NO_PUSH=1; shift ;;
  --wait) WAIT=$2; shift 2 ;;
  S-*) MEMBERS+=("$1"); shift ;;
  *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

case "$MODE" in
reserve)
  [[ ${#MEMBERS[@]} -gt 0 ]] || { echo "usage: reserve-wave.sh S-A S-B … | --drop W-<id> S-NNN | --release W-<id>" >&2; exit 1; }
  WAVE="W-$(date +%Y%m%d)-$(od -An -N2 -tx1 /dev/urandom | tr -d ' \n')"
  ;;
drop)
  [[ ${#MEMBERS[@]} -eq 1 ]] || { echo "--drop takes exactly one sprint: reserve-wave.sh --drop W-<id> S-NNN" >&2; exit 1; }
  ;;
release)
  [[ ${#MEMBERS[@]} -eq 0 ]] || { echo "--release takes no sprint args: reserve-wave.sh --release W-<id>" >&2; exit 1; }
  ;;
esac

wave_of() { node "$SELF_DIR/frontmatter.mjs" get "$1" wave | tr -d '"'; }

# Locate each member's backlog file (exit 2 if missing — started or reserved elsewhere).
locate() {
  local sprint=$1
  shopt -s nullglob
  local candidates=("$ROOT/docs/sprints/backlog/$sprint-"*.md)
  if [[ ${#candidates[@]} -ne 1 ]]; then
    echo "$sprint: expected exactly one backlog file, found ${#candidates[@]} — already started or renamed?" >&2
    return 2
  fi
  echo "${candidates[0]}"
}

TOKEN=$("$SELF_DIR/lock.sh" acquire "reserve-$WAVE" --wait "$WAIT")
COMMITTED=0
MUTATING=0 # set just before the first ledger mutation — a precondition failure must NOT
           # reset --hard (it would destroy unrelated in-flight work, e.g. another wave's
           # uncommitted planning edits in its planning worktree are safe, but the primary
           # checkout may still hold user work-in-progress)
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

FILES=()
if [[ $MODE == release ]]; then
  # Every backlog member still carrying this wave's reservation.
  shopt -s nullglob
  for f in "$ROOT"/docs/sprints/backlog/S-*.md; do
    [[ $(wave_of "$f") == "$WAVE" ]] && FILES+=("$f")
  done
  if [[ ${#FILES[@]} -eq 0 ]]; then
    echo "no backlog sprints reserved by $WAVE — nothing to release" >&2
    exit 2
  fi
else
  # reserve / drop: resolve members under the lock (post-pull — the authoritative view).
  for sprint in "${MEMBERS[@]}"; do
    FILE=$(locate "$sprint") || exit 2
    CURRENT=$(wave_of "$FILE")
    if [[ $MODE == reserve && $CURRENT != null && -n $CURRENT ]]; then
      echo "$sprint is already reserved by $CURRENT — release/drop it first or pick another member" >&2
      exit 2
    fi
    if [[ $MODE == drop && $CURRENT != "$WAVE" ]]; then
      echo "$sprint is not reserved by $WAVE (found: $CURRENT)" >&2
      exit 2
    fi
    FILES+=("$FILE")
  done
fi

# The transaction: flip wave fields, verify claims disjointness, regen, commit.
MUTATING=1
for FILE in "${FILES[@]}"; do
  if [[ $MODE == reserve ]]; then
    node "$SELF_DIR/frontmatter.mjs" set "$FILE" wave "$WAVE"
  else
    node "$SELF_DIR/frontmatter.mjs" set "$FILE" wave null
  fi
done

if [[ $MODE == reserve ]]; then
  # With all members now marked, claims.mjs sees them as holders: each member's
  # check enforces disjointness pairwise AND against in-flight + foreign reservations.
  for sprint in "${MEMBERS[@]}"; do
    node "$SELF_DIR/claims.mjs" check --sprint "$sprint" || {
      echo "$sprint: claims overlap — wave not reserved (rolled back)" >&2
      exit 2
    }
  done
fi

if [[ $MODE == reserve ]]; then
  # Record the review base: ORCHESTRATION.md Step 6's post-wave reviewer later diffs
  # pre_wave_sha..HEAD on main — without this, "review the merged wave result on main"
  # has no base and produces an empty diff.
  PRE_WAVE_SHA=$(git -C "$ROOT" rev-parse "$MAIN")
fi

node "$SELF_DIR/regen.mjs" >/dev/null

REL_PATHS=(docs/sprints/INDEX.md docs/sprints/ROADMAP.md)
for FILE in "${FILES[@]}"; do
  REL_PATHS+=("docs/sprints/backlog/$(basename "$FILE")")
done
git -C "$ROOT" add -- "${REL_PATHS[@]}"
if git -C "$ROOT" diff --cached --name-only | grep -q ' 2\.'; then
  echo 'staged a " 2." sync-duplicate file — aborting' >&2
  exit 1
fi
case "$MODE" in
reserve) MSG="sprint: reserve wave $WAVE — $(IFS=,; echo "${MEMBERS[*]}") [skip ci]" ;;
drop)    MSG="sprint: drop ${MEMBERS[0]} from wave $WAVE [skip ci]" ;;
release) MSG="sprint: release wave $WAVE [skip ci]" ;;
esac
if [[ $MODE == reserve ]]; then
  # pre_wave_sha lands as a commit trailer — durable (git history, survives across
  # sessions/machines) and unambiguous: ORCHESTRATION.md Step 6 and the train chapter
  # look it up from this reservation commit.
  git -C "$ROOT" commit --no-verify -q -m "$MSG" -m "pre_wave_sha: $PRE_WAVE_SHA" -- "${REL_PATHS[@]}"
else
  git -C "$ROOT" commit --no-verify -q -m "$MSG" -- "${REL_PATHS[@]}"
fi
COMMITTED=1

# Survival check: the committed files must carry (or have dropped) the reservation.
for FILE in "${FILES[@]}"; do
  BASENAME=$(basename "$FILE")
  if [[ $MODE == reserve ]]; then
    git -C "$ROOT" show "HEAD:docs/sprints/backlog/$BASENAME" | grep "^wave: $WAVE" >/dev/null ||
      { echo "FATAL: committed $BASENAME lost its wave: frontmatter — inspect HEAD" >&2; exit 1; }
  else
    git -C "$ROOT" show "HEAD:docs/sprints/backlog/$BASENAME" | grep "^wave: $WAVE" >/dev/null &&
      { echo "FATAL: committed $BASENAME still reserved by $WAVE — inspect HEAD" >&2; exit 1; }
  fi
done

if [[ $NO_PUSH -eq 0 ]]; then
  git -C "$ROOT" push origin "$MAIN" || { echo "push failed — local reservation commit is intact; resolve and push before proceeding" >&2; exit 1; }
else
  AHEAD=$(git -C "$ROOT" rev-list --count "origin/$MAIN..$MAIN" 2>/dev/null || echo '?')
  echo "push deferred — local $MAIN is $AHEAD commit(s) ahead of origin/$MAIN; wave checkpoints push via scripts/sprint/push-main.sh"
fi

case "$MODE" in
reserve)
  echo "reserved wave $WAVE: $(IFS=' '; echo "${MEMBERS[*]}") on $MAIN at $(git -C "$ROOT" rev-parse HEAD)"
  echo "wave id: $WAVE"
  echo "pre_wave_sha: $PRE_WAVE_SHA"
  echo "ledger dir: .claude/sprint-orchestration/$WAVE/"
  ;;
drop)    echo "dropped ${MEMBERS[0]} from wave $WAVE at $(git -C "$ROOT" rev-parse HEAD)" ;;
release) echo "released wave $WAVE (${#FILES[@]} member(s)) at $(git -C "$ROOT" rev-parse HEAD)" ;;
esac
