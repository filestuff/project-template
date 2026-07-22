#!/usr/bin/env bash
# Locked sprint-completion transaction (the merge queue). Three steps, one lock
# held across all of them so main cannot move underneath:
#
#   merge-sprint.sh prepare <branch> [--no-push] [--wait <secs>]
#       Acquire the lock (KEPT until finish/abort), verify the ledger, merge
#       main into the sprint branch. Exit 0 = branch already up to date;
#       exit 3 = merge brought changes — re-run the commit gate in the
#       worktree, then call `land`.
#   merge-sprint.sh land <branch> [--sprints S-A,S-B,…]
#       Merge --no-ff into main, move the sprint file(s) in-progress/ → done/,
#       flip status/end_date, rotate the archive, regenerate. Exits 4: author
#       the semantic docs on main (docs/DOC_HEALTH.md row + History; INDEX.md
#       Done-table row + header narrative; ROADMAP.md narrative), then `finish`.
#   merge-sprint.sh finish <branch> [--sprints S-A,S-B,…] [--no-push]
#       Verify, commit `sprint: complete S-NNN`, push, release the lock.
#
# --sprints (train mode — ORCHESTRATION.md "The serial train"): the branch carries
# several sprints and its name (`train-W-<id>`) has no sprint id, so land/finish
# take the roster explicitly and land them in ONE merge + ONE completion commit.
# Without the flag, behavior is unchanged (single sprint, id from the branch name).
#   merge-sprint.sh abort <branch>
#       Roll main back to the pre-land SHA, abort in-progress merges, release.
#
# Exit codes: 0 ok · 1 error (lock kept — fix and re-run, or abort) ·
# 3 gate re-run needed · 4 paused for doc authoring · 75 lock busy
#
# Must run under macOS /bin/bash 3.2: no mapfile/readarray/associative arrays,
# and empty-array "${arr[@]}" expansion is an unbound-variable error under set -u.
set -euo pipefail

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
GIT_COMMON=$(git rev-parse --path-format=absolute --git-common-dir)
ROOT=${GIT_COMMON%/.git}
LOCK_DIR="$GIT_COMMON/sprint-main.lock"
MAIN=${SPRINT_MAIN_BRANCH:-main}

CMD=${1:?usage: merge-sprint.sh prepare|land|finish|abort <branch>}
BRANCH=${2:?usage: merge-sprint.sh $CMD <branch>}
shift 2
NO_PUSH=0 WAIT=300 SPRINTS_CSV=""
while [[ $# -gt 0 ]]; do
  case "$1" in
  --no-push) NO_PUSH=1; shift ;;
  --wait) WAIT=$2; shift 2 ;;
  --sprints) SPRINTS_CSV=$2; shift 2 ;;
  *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

# Roster for land/finish: --sprints wins; otherwise the single id in the branch
# name. prepare/abort never use it, so an id-less branch is fine there.
SPRINTS=()
if [[ -n $SPRINTS_CSV ]]; then
  IFS=',' read -r -a SPRINTS <<<"$SPRINTS_CSV"
  for s in "${SPRINTS[@]}"; do
    [[ $s =~ ^S-[0-9]+$ ]] || { echo "--sprints: '$s' is not an S-NNN id" >&2; exit 1; }
  done
else
  SPRINT=$(echo "$BRANCH" | grep -oE '^S-[0-9]+' || true)
  if [[ -n $SPRINT ]]; then SPRINTS=("$SPRINT"); fi
fi
CSV=""
if [[ ${#SPRINTS[@]} -gt 0 ]]; then CSV=$(IFS=,; echo "${SPRINTS[*]}"); fi
FINISH_ARGS="${SPRINTS_CSV:+ --sprints $SPRINTS_CSV}"

require_roster() {
  [[ ${#SPRINTS[@]} -gt 0 ]] ||
    { echo "cannot derive a sprint id from branch '$BRANCH' — pass --sprints S-A,S-B,…" >&2; exit 1; }
}

LABEL="land-$BRANCH"
GENERATED=(docs/sprints/INDEX.md docs/sprints/ROADMAP.md docs/DOC_HEALTH.md)

worktree_path() {
  git worktree list --porcelain | awk -v b="refs/heads/$BRANCH" '
    /^worktree /{wt=$2} /^branch /{if ($2==b) print wt}'
}

sprint_title() { # $1 = sprint id, $2 = absolute sprint file path
  local t
  t=$(sed -n "s/^# $1: //p" "$2" | head -1)
  echo "${t:-$1}"
}

case "$CMD" in
prepare)
  WT=$(worktree_path)
  [[ -n $WT ]] || { echo "no worktree found for branch $BRANCH" >&2; exit 1; }

  # Acquire, or continue if we already hold it for this branch (re-run after conflict fix).
  if ! "$SELF_DIR/lock.sh" continue "$LABEL" 2>/dev/null; then
    "$SELF_DIR/lock.sh" acquire "$LABEL" --wait "$WAIT" >/dev/null
  fi

  [[ $(git -C "$ROOT" branch --show-current) == "$MAIN" ]] ||
    { echo "primary checkout is not on $MAIN — stop and ask the user (lock kept)" >&2; exit 1; }
  [[ -z $(git -C "$ROOT" status --porcelain --untracked-files=no) ]] ||
    { echo "primary checkout has tracked changes — stop and ask the user (lock kept)" >&2; exit 1; }
  if [[ $NO_PUSH -eq 0 ]]; then
    git -C "$ROOT" pull --ff-only origin "$MAIN"
  fi

  if [[ -f "$WT/.git" && -e "$GIT_COMMON/worktrees" ]] && git -C "$WT" rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
    echo "a merge is already in progress in $WT — resolve it, commit, then re-run prepare" >&2
    exit 1
  fi

  OLD_HEAD=$(git -C "$WT" rev-parse HEAD)
  if ! git -C "$WT" merge "$MAIN" -m "merge $MAIN into $BRANCH pre-land" >/dev/null 2>&1; then
    # Auto-resolve generated docs by taking main's side (their regen happens on main now);
    # anything else is a real conflict for the agent.
    conflicted=()
    while IFS= read -r f; do conflicted+=("$f"); done < <(git -C "$WT" diff --name-only --diff-filter=U)
    remaining=()
    for f in ${conflicted[@]+"${conflicted[@]}"}; do
      if printf '%s\n' "${GENERATED[@]}" | grep -qx "$f"; then
        git -C "$WT" checkout --theirs -- "$f" && git -C "$WT" add -- "$f"
      else
        remaining+=("$f")
      fi
    done
    if [[ ${#remaining[@]} -gt 0 ]]; then
      echo "real merge conflicts in $WT (lock kept — resolve, commit, re-run prepare):" >&2
      printf '  %s\n' "${remaining[@]}" >&2
      exit 1
    fi
    git -C "$WT" commit --no-verify -q --no-edit
  fi

  if [[ $(git -C "$WT" rev-parse HEAD) == "$OLD_HEAD" ]]; then
    echo "branch already contains $MAIN — proceed to: merge-sprint.sh land $BRANCH"
    exit 0
  fi
  echo "merged $MAIN into $BRANCH — re-run the commit gate in the worktree, then: merge-sprint.sh land $BRANCH"
  exit 3
  ;;

land)
  "$SELF_DIR/lock.sh" continue "$LABEL" || { echo "run prepare first (it takes the lock)" >&2; exit 75; }
  require_roster
  git -C "$ROOT" merge-base --is-ancestor "$MAIN" "$BRANCH" ||
    { echo "$BRANCH does not contain $MAIN — run prepare first" >&2; exit 1; }

  git -C "$ROOT" rev-parse HEAD >"$LOCK_DIR/preland-sha"

  shopt -s nullglob
  # Resolve every roster member's in-progress file before mutating anything.
  BASENAMES=() TITLES=()
  for s in "${SPRINTS[@]}"; do
    files=("$ROOT/docs/sprints/in-progress/$s-"*.md)
    [[ ${#files[@]} -eq 1 ]] || { echo "expected exactly one in-progress file for $s on main, found ${#files[@]}" >&2; exit 1; }
    BASENAMES+=("$(basename "${files[0]}")")
    TITLES+=("$(sprint_title "$s" "${files[0]}")")
  done

  if [[ ${#SPRINTS[@]} -eq 1 ]]; then
    git -C "$ROOT" merge --no-ff "$BRANCH" -m "sprint: merge ${SPRINTS[0]} — ${TITLES[0]}"
  else
    git -C "$ROOT" merge --no-ff "$BRANCH" -m "sprint: merge $CSV"
  fi

  for ((i = 0; i < ${#SPRINTS[@]}; i++)); do
    BASENAME=${BASENAMES[i]}
    git -C "$ROOT" mv "docs/sprints/in-progress/$BASENAME" "docs/sprints/done/$BASENAME"
    DONE_FILE="$ROOT/docs/sprints/done/$BASENAME"
    node "$SELF_DIR/frontmatter.mjs" set "$DONE_FILE" status done
    node "$SELF_DIR/frontmatter.mjs" set "$DONE_FILE" end_date "$(date +%F)"
  done

  # Archive rotation: keep the 10 most recent (highest-numbered) in done/.
  done_files=()
  while IFS= read -r f; do done_files+=("$f"); done < <(ls "$ROOT/docs/sprints/done/" | grep -E '^S-[0-9]+.*\.md$' | sort -V)
  excess=$((${#done_files[@]} - 10))
  if ((excess > 0)); then
    mkdir -p "$ROOT/docs/sprints/done/archive"
    for ((i = 0; i < excess; i++)); do
      git -C "$ROOT" mv "docs/sprints/done/${done_files[i]}" "docs/sprints/done/archive/${done_files[i]}"
    done
  fi

  node "$SELF_DIR/regen.mjs" >/dev/null

  echo "landed $CSV onto main (uncommitted lifecycle changes staged)."
  echo "NOW author the semantic docs in the PRIMARY checkout ($ROOT):"
  echo "  - docs/DOC_HEALTH.md: Last Verified / By Sprint rows + History entry"
  echo "  - docs/sprints/INDEX.md: Done-table row(s) for $CSV + '_Last updated_' header line"
  echo "  - docs/sprints/ROADMAP.md: narrative (Status / In progress / unblocked notes)"
  echo "  (waves/trains: apply any pre-drafted .claude/sprint-orchestration/W-*/S-NNN-docs-draft.md — the lock is held; keep this pause short)"
  echo "then run: merge-sprint.sh finish $BRANCH$FINISH_ARGS"
  exit 4
  ;;

finish)
  "$SELF_DIR/lock.sh" continue "$LABEL" || { echo "lock not held for $LABEL — was land run?" >&2; exit 75; }
  require_roster

  shopt -s nullglob
  # A low-numbered sprint can be archived by the land-step rotation immediately (keeps the 10
  # highest-numbered in done/), so look in done/ AND done/archive/.
  REL_FILES=() TITLES=()
  for s in "${SPRINTS[@]}"; do
    files=("$ROOT/docs/sprints/done/$s-"*.md "$ROOT/docs/sprints/done/archive/$s-"*.md)
    [[ ${#files[@]} -eq 1 ]] || { echo "expected exactly one done/ file for $s (checked done/ + done/archive/)" >&2; exit 1; }
    grep -q '^status: done' "${files[0]}" || { echo "${files[0]} is not status: done" >&2; exit 1; }
    REL_FILES+=("${files[0]#"$ROOT"/}")
    TITLES+=("$(sprint_title "$s" "${files[0]}")")
  done

  git -C "$ROOT" add -u -- docs/sprints docs/DOC_HEALTH.md
  if git -C "$ROOT" diff --cached --name-only | grep -q ' 2\.'; then
    echo 'staged a " 2." sync-duplicate file — unstage it before re-running finish' >&2
    exit 1
  fi
  # No [skip ci] here: this commit is the HEAD of a push whose range contains the
  # land merge (real code); GitHub checks the push HEAD, so a marker here would
  # skip CI for landed code.
  if [[ ${#SPRINTS[@]} -eq 1 ]]; then
    git -C "$ROOT" commit --no-verify -q -m "sprint: complete ${SPRINTS[0]} — ${TITLES[0]}"
  else
    git -C "$ROOT" commit --no-verify -q -m "sprint: complete $CSV"
  fi

  # grep without -q: -q exits on first match and SIGPIPEs git-show, which trips pipefail
  # into a false FATAL. REL_FILES entries (not hardcoded done/ paths) so archived files resolve.
  for rel in "${REL_FILES[@]}"; do
    git -C "$ROOT" show "HEAD:$rel" | grep '^status: done' >/dev/null ||
      { echo "FATAL: committed sprint file $rel is not status: done — inspect HEAD" >&2; exit 1; }
  done

  if [[ $NO_PUSH -eq 0 ]]; then
    git -C "$ROOT" push origin "$MAIN" ||
      { echo "push failed — local commits intact, lock kept; resolve and re-run finish" >&2; exit 1; }
  else
    echo "push deferred — orchestrator: run scripts/sprint/push-main.sh at the wave's/train's next checkpoint and verify CI on that push (PROTOCOL Phase 3 Step 6)"
  fi

  rm -f "$LOCK_DIR/preland-sha"
  "$SELF_DIR/lock.sh" release-label "$LABEL"
  echo "completed $CSV — $MAIN at $(git -C "$ROOT" rev-parse HEAD)"
  echo "cleanup: ExitWorktree {action: \"keep\"} · git worktree remove .claude/worktrees/$BRANCH · git branch -d $BRANCH"
  ;;

abort)
  "$SELF_DIR/lock.sh" continue "$LABEL" || { echo "lock not held for $LABEL — nothing to abort" >&2; exit 1; }
  if git -C "$ROOT" rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
    git -C "$ROOT" merge --abort
  fi
  if [[ -f "$LOCK_DIR/preland-sha" ]]; then
    git -C "$ROOT" reset --hard -q "$(cat "$LOCK_DIR/preland-sha")"
    echo "main rolled back to pre-land SHA"
  else
    git -C "$ROOT" reset --hard -q HEAD
  fi
  "$SELF_DIR/lock.sh" release-label "$LABEL"
  echo "aborted; if the worktree has an unfinished pre-land merge: git -C <worktree> merge --abort"
  ;;

*)
  echo "usage: merge-sprint.sh prepare|land|finish|abort <branch>" >&2
  exit 1
  ;;
esac
