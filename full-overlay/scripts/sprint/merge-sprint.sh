#!/usr/bin/env bash
# Locked sprint-completion transaction (the merge queue). Three steps, one lock
# held across all of them so main cannot move underneath:
#
#   merge-sprint.sh prepare <branch> [--no-push] [--wait <secs>]
#       Acquire the lock (KEPT until finish/abort), verify the ledger, merge
#       main into the sprint branch. Exit 0 = branch already up to date;
#       exit 3 = merge brought changes — re-run the commit gate in the
#       worktree, then call `land`.
#   merge-sprint.sh land <branch> [--sprints S-A,S-B,…] [--allow-incomplete <reason>]
#       FIRST lint every roster member's Completion Log on the branch
#       (close-check.mjs, before anything mutates): exit 5 lists what is missing
#       — fix the record on the branch and re-run `land` (no new `prepare`
#       needed), or pass --allow-incomplete "<reason>" to land anyway with the
#       reason written into the file's Deviations. Then merge --no-ff into main,
#       move the sprint file(s) in-progress/ → done/, flip status/end_date, stamp
#       the `S-NNN:` deliverable commits + merge SHA under `### Commits`, rotate
#       the archive, regenerate. Exits 4: author the semantic docs on main
#       (docs/DOC_HEALTH.md row + History; INDEX.md Done-table row — ONE sentence,
#       the narrative lives in the sprint file's ### Outcome — + header line;
#       ROADMAP.md narrative), then `finish`.
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
# 3 gate re-run needed · 4 paused for doc authoring · 5 completion log incomplete
# (lock kept, main untouched) · 75 lock busy
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
NO_PUSH=0 WAIT=300 SPRINTS_CSV="" ALLOW_INCOMPLETE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
  --no-push) NO_PUSH=1; shift ;;
  --wait) WAIT=$2; shift 2 ;;
  --sprints) SPRINTS_CSV=$2; shift 2 ;;
  --allow-incomplete) ALLOW_INCOMPLETE=${2:?--allow-incomplete needs a reason}; shift 2 ;;
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
  # substr, not $2: worktree paths may contain spaces ("Claude Code", ...).
  # "worktree " is 9 chars, "branch " is 7.
  git worktree list --porcelain | awk -v b="refs/heads/$BRANCH" '
    /^worktree /{wt=substr($0,10)} /^branch /{if (substr($0,8)==b) print wt}'
}

sprint_title() { # $1 = sprint id, $2 = absolute sprint file path
  local t
  t=$(sed -n "s/^# $1: //p" "$2" | head -1)
  echo "${t:-$1}"
}

# Replace the sprint file's `_(stamped at land)_` marker with the sprint's
# deliverable commits (the `S-NNN:` commits between the merge's two parents) and
# the merge SHA — mechanical facts, zero LLM cost, and the file stays
# self-contained after archive rotation. Never fatal: the merge has happened.
stamp_commits() { # $1 = sprint id, $2 = absolute done-file path
  local s=$1 file=$2 merge commits
  merge=$(git -C "$ROOT" rev-parse HEAD)
  commits=$(git -C "$ROOT" log --reverse --format='- %h %s' "$merge^1..$merge^2" --grep="^$s:" 2>/dev/null || true)
  [[ -n $commits ]] || commits="- (no commits matched \`$s:\` — see \`git log $merge^1..$merge^2\`)"
  STAMP=$(printf '%s\n- merge: %s' "$commits" "$merge")
  export STAMP
  if grep -q '^_(stamped at land)_$' "$file"; then
    perl -pi -e 's/^_\(stamped at land\)_$/$ENV{STAMP}/' "$file"
  elif grep -q '^### Commits' "$file"; then
    perl -pi -e 's/^### Commits$/### Commits\n\n$ENV{STAMP}/' "$file"
  else
    echo "WARNING: $s has no \`### Commits\` section (pre-1.10.0 file) — commits not stamped; see \`git log $merge^1..$merge^2\`" >&2
  fi
}

# --allow-incomplete: record the override in the file itself, under Deviations.
note_incomplete() { # $1 = absolute done-file path
  local file=$1
  NOTE="- $(date +%F) landed incomplete — $ALLOW_INCOMPLETE"
  export NOTE
  if grep -q '^### Deviations from brief' "$file"; then
    # drop a `— none` directly under the heading, then insert the note after the heading
    perl -0pi -e 's/(### Deviations from brief\n)(\n*)(— none\n)?/$1\n$ENV{NOTE}\n\n/' "$file"
  else
    printf '\n### Deviations from brief\n\n%s\n' "$NOTE" >>"$file"
  fi
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
    # A merge can fail WITHOUT starting one (dirty worktree, lock, fs error).
    # Then there is no MERGE_HEAD and no conflicts — falling through to the
    # conflict path would end in a bogus `git commit --no-edit` and a cryptic
    # set -e abort with the lock still held. Surface the real cause instead.
    if ! git -C "$WT" rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
      echo "git merge failed without starting a merge in $WT (lock kept) — status:" >&2
      git -C "$WT" status --short >&2
      exit 1
    fi

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

  # Completion-log lint — the branch's copy of each sprint file is the record
  # (the executor / solo close writes it there). Runs BEFORE any mutation so a
  # failure leaves main untouched and needs no rollback; `prepare` still holds.
  INCOMPLETE=()
  for ((i = 0; i < ${#SPRINTS[@]}; i++)); do
    s=${SPRINTS[i]}
    CHECK_COPY="$LOCK_DIR/close-check-$s.md"
    if ! git -C "$ROOT" show "$BRANCH:docs/sprints/in-progress/${BASENAMES[i]}" >"$CHECK_COPY" 2>/dev/null; then
      echo "$s: docs/sprints/in-progress/${BASENAMES[i]} is not on branch $BRANCH — merge $MAIN into the branch (re-run prepare)" >&2
      exit 1
    fi
    if ! node "$SELF_DIR/close-check.mjs" "$CHECK_COPY"; then
      INCOMPLETE+=("$s")
    fi
  done
  if [[ ${#INCOMPLETE[@]} -gt 0 ]]; then
    if [[ -z $ALLOW_INCOMPLETE ]]; then
      echo "completion log incomplete for: ${INCOMPLETE[*]} (lock kept, $MAIN untouched)." >&2
      echo "fix the record on the branch (fill docs/sprints/in-progress/<file> per SPRINT_TEMPLATE ## Completion Log," >&2
      echo "commit \`S-NNN: completion log\`), then re-run: merge-sprint.sh land $BRANCH$FINISH_ARGS" >&2
      echo "— or land anyway with: --allow-incomplete \"<reason>\" (the reason is written into the file's Deviations)" >&2
      exit 5
    fi
    echo "WARNING: landing with an incomplete completion log for ${INCOMPLETE[*]} — reason recorded in each file: $ALLOW_INCOMPLETE" >&2
  fi

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
    stamp_commits "$s" "$DONE_FILE"
    if [[ -n $ALLOW_INCOMPLETE ]] && printf '%s\n' ${INCOMPLETE[@]+"${INCOMPLETE[@]}"} | grep -qx "$s"; then
      note_incomplete "$DONE_FILE"
    fi
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

  # Rotation moves sibling sprint files past the 10-file done/ boundary,
  # orphaning their hand-authored INDEX.md Done-table links. Rewrite any
  # (done/X.md) link whose target now exists only under done/archive/.
  INDEX_MD="$ROOT/docs/sprints/INDEX.md"
  while IFS= read -r rel; do
    base=${rel#done/}
    if [[ ! -f "$ROOT/docs/sprints/done/$base" && -f "$ROOT/docs/sprints/done/archive/$base" ]]; then
      perl -pi -e "s{\(\Qdone/$base\E\)}{(done/archive/$base)}g" "$INDEX_MD"
      echo "INDEX.md: relinked done/$base -> done/archive/$base"
    fi
  done < <(grep -o '(done/[A-Za-z0-9_.-]*\.md)' "$INDEX_MD" | tr -d '()' | sort -u)

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
    grep -q '^## Completion Log' "${files[0]}" ||
      echo "WARNING: ${files[0]#"$ROOT"/} has no ## Completion Log — the sprint leaves no durable record" >&2
    # The Done-row Outcome is ONE sentence; the narrative belongs in the file's ### Outcome.
    OUTCOME_LEN=$(awk -F'|' -v key="[$s](" 'index($0, key) { n = NF; while (n > 1 && $n ~ /^[ \t]*$/) n--; print length($n); exit }' "$ROOT/docs/sprints/INDEX.md")
    if [[ -n $OUTCOME_LEN && $OUTCOME_LEN -gt 300 ]]; then
      echo "WARNING: INDEX.md Done-row Outcome for $s is $OUTCOME_LEN chars — keep it to one sentence (≤200); move the narrative into the sprint file's ### Outcome" >&2
    fi
  done

  # Stage every dirty tracked file under docs/, not a fixed list — the
  # completion pass routinely edits docs beyond the lifecycle set (e.g.
  # TODOS.md, architecture notes), and stranded leftovers dirty-stop the
  # NEXT sprint's prepare, where they masquerade as a foreign session's mess.
  git -C "$ROOT" add -u -- docs
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

  # Name any tracked leftovers NOW, while the cause is obvious — otherwise
  # they resurface as the next prepare's "primary checkout has tracked
  # changes" refusal, misdiagnosed as a concurrent session's mess.
  LEFTOVER=$(git -C "$ROOT" status --porcelain --untracked-files=no)
  if [[ -n $LEFTOVER ]]; then
    echo "WARNING: uncommitted doc-sync leftovers remain after the completion commit:" >&2
    echo "$LEFTOVER" >&2
    echo "these will dirty-stop the NEXT sprint's prepare — commit or restore them before then." >&2
  fi

  if [[ $NO_PUSH -eq 0 ]]; then
    git -C "$ROOT" push origin "$MAIN" ||
      { echo "push failed — local commits intact, lock kept; resolve and re-run finish" >&2; exit 1; }
  else
    echo "push deferred — this push deploys via any connected platform; confirm with the user (deploy gate), then run scripts/sprint/push-main.sh and verify CI on that push (PROTOCOL Phase 3 Step 6). Waves/trains: settle at the next checkpoint per the push policy."
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
