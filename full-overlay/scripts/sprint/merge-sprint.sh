#!/usr/bin/env bash
# Locked sprint-completion transaction (the merge queue). Three steps, one lock
# held across all of them so main cannot move underneath:
#
#   merge-sprint.sh prepare <branch> [--no-push] [--wait <secs>]
#       Acquire the lock (KEPT until finish/abort), verify the ledger, merge
#       main into the sprint branch. Exit 0 = branch already up to date;
#       exit 3 = merge brought changes — re-run the commit gate in the
#       worktree, then call `land`.
#   merge-sprint.sh land <branch>
#       Merge --no-ff into main, move the sprint file in-progress/ → done/,
#       flip status/end_date, rotate the archive, regenerate. Exits 4: author
#       the semantic docs on main (docs/DOC_HEALTH.md row + History; INDEX.md
#       Done-table row + header narrative; ROADMAP.md narrative), then `finish`.
#   merge-sprint.sh finish <branch> [--no-push]
#       Verify, commit `sprint: complete S-NNN`, push, release the lock.
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
NO_PUSH=0 WAIT=300
while [[ $# -gt 0 ]]; do
  case "$1" in
  --no-push) NO_PUSH=1; shift ;;
  --wait) WAIT=$2; shift 2 ;;
  *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

SPRINT=$(echo "$BRANCH" | grep -oE '^S-[0-9]+')
LABEL="land-$BRANCH"
GENERATED=(docs/sprints/INDEX.md docs/sprints/ROADMAP.md docs/DOC_HEALTH.md)

worktree_path() {
  git worktree list --porcelain | awk -v b="refs/heads/$BRANCH" '
    /^worktree /{wt=$2} /^branch /{if ($2==b) print wt}'
}

sprint_title() { # $1 = absolute sprint file path
  local t
  t=$(sed -n "s/^# $SPRINT: //p" "$1" | head -1)
  echo "${t:-$SPRINT}"
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
  git -C "$ROOT" merge-base --is-ancestor "$MAIN" "$BRANCH" ||
    { echo "$BRANCH does not contain $MAIN — run prepare first" >&2; exit 1; }

  git -C "$ROOT" rev-parse HEAD >"$LOCK_DIR/preland-sha"

  shopt -s nullglob
  files=("$ROOT/docs/sprints/in-progress/$SPRINT-"*.md)
  [[ ${#files[@]} -eq 1 ]] || { echo "expected exactly one in-progress file for $SPRINT on main, found ${#files[@]}" >&2; exit 1; }
  BASENAME=$(basename "${files[0]}")
  TITLE=$(sprint_title "${files[0]}")

  git -C "$ROOT" merge --no-ff "$BRANCH" -m "sprint: merge $SPRINT — $TITLE"

  git -C "$ROOT" mv "docs/sprints/in-progress/$BASENAME" "docs/sprints/done/$BASENAME"
  DONE_FILE="$ROOT/docs/sprints/done/$BASENAME"
  node "$SELF_DIR/frontmatter.mjs" set "$DONE_FILE" status done
  node "$SELF_DIR/frontmatter.mjs" set "$DONE_FILE" end_date "$(date +%F)"

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

  echo "landed $SPRINT onto main (uncommitted lifecycle changes staged)."
  echo "NOW author the semantic docs in the PRIMARY checkout ($ROOT):"
  echo "  - docs/DOC_HEALTH.md: Last Verified / By Sprint rows + History entry"
  echo "  - docs/sprints/INDEX.md: Done-table row for $SPRINT + '_Last updated_' header line"
  echo "  - docs/sprints/ROADMAP.md: narrative (Status / In progress / unblocked notes)"
  echo "  (waves: apply the pre-drafted .claude/sprint-orchestration/W-*/$SPRINT-docs-draft.md if one exists — the lock is held; keep this pause short)"
  echo "then run: merge-sprint.sh finish $BRANCH"
  exit 4
  ;;

finish)
  "$SELF_DIR/lock.sh" continue "$LABEL" || { echo "lock not held for $LABEL — was land run?" >&2; exit 75; }

  shopt -s nullglob
  # A low-numbered sprint can be archived by the land-step rotation immediately (keeps the 10
  # highest-numbered in done/), so look in done/ AND done/archive/.
  files=("$ROOT/docs/sprints/done/$SPRINT-"*.md "$ROOT/docs/sprints/done/archive/$SPRINT-"*.md)
  [[ ${#files[@]} -eq 1 ]] || { echo "expected exactly one done/ file for $SPRINT (checked done/ + done/archive/)" >&2; exit 1; }
  BASENAME=$(basename "${files[0]}")
  REL_FILE="${files[0]#"$ROOT"/}"
  TITLE=$(sprint_title "${files[0]}")
  grep -q '^status: done' "${files[0]}" || { echo "${files[0]} is not status: done" >&2; exit 1; }

  git -C "$ROOT" add -u -- docs/sprints docs/DOC_HEALTH.md
  if git -C "$ROOT" diff --cached --name-only | grep -q ' 2\.'; then
    echo 'staged a " 2." sync-duplicate file — unstage it before re-running finish' >&2
    exit 1
  fi
  # No [skip ci] here: this commit is the HEAD of a push whose range contains the
  # land merge (real code); GitHub checks the push HEAD, so a marker here would
  # skip CI for landed code.
  git -C "$ROOT" commit --no-verify -q -m "sprint: complete $SPRINT — $TITLE"

  # grep without -q: -q exits on first match and SIGPIPEs git-show, which trips pipefail
  # into a false FATAL. REL_FILE (not a hardcoded done/ path) so an archived file resolves.
  git -C "$ROOT" show "HEAD:$REL_FILE" | grep '^status: done' >/dev/null ||
    { echo "FATAL: committed sprint file is not status: done — inspect HEAD" >&2; exit 1; }

  if [[ $NO_PUSH -eq 0 ]]; then
    git -C "$ROOT" push origin "$MAIN" ||
      { echo "push failed — local commits intact, lock kept; resolve and re-run finish" >&2; exit 1; }
  else
    echo "push deferred — wave orchestrator: run scripts/sprint/push-main.sh after the wave's LAST completion and verify CI on that push (PROTOCOL Phase 3 Step 6)"
  fi

  rm -f "$LOCK_DIR/preland-sha"
  "$SELF_DIR/lock.sh" release-label "$LABEL"
  echo "completed $SPRINT — $MAIN at $(git -C "$ROOT" rev-parse HEAD)"
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
