#!/usr/bin/env bash
# Batch landing for a wave: instead of landing N finished sprint branches one at a
# time (N lock transactions, up to N full gate runs), merge them into ONE integration
# branch that the existing train-checkpoint path lands in a single transaction:
#
#   assemble-train.sh W-<id> S-A S-B …        # build the integration branch + worktree
#   assemble-train.sh --cleanup <branch> [--force]
#
# then:  gate.sh in the worktree, and
#   merge-sprint.sh prepare <branch> && merge-sprint.sh land <branch> --sprints S-A,S-B
#   merge-sprint.sh finish <branch> --sprints S-A,S-B
#
# Assemble takes NO lock and never touches main: it creates `land-<W-id>-<n>` (n = the
# smallest positive integer whose branch does not exist) and a worktree at
# <root>/.claude/worktrees/land-<W-id>-<n> from main's tip, then merges each member's
# `S-NNN-*` branch into it, in ascending sprint-number order, --no-ff. (`prepare` handles a
# main that moved afterwards.) A member whose merge conflicts is aborted and reported; the
# rest still merge. Conflicts confined to the generated docs (docs/sprints/INDEX.md,
# ROADMAP.md, docs/DOC_HEALTH.md) take the integration side — land regenerates them.
#
# Output (last lines, parseable):
#   branch: land-W-…-1
#   worktree: /abs/path
#   merged: S-001 S-003                      (omitted if none)
#   conflict: S-002 (src/x.ts src/y.ts)      (one line per conflicting member)
#   next: …
#
# --cleanup: only for `land-W-*` branches. Removes the worktree and deletes the branch;
# refuses (exit 2) when the branch is not fully merged into main unless --force. Idempotent:
# an already-gone branch/worktree is exit 0 with a note.
#
# Exit codes: 0 ok (assemble: >=1 member merged) · 2 assemble: NO member merged (nothing
# left behind) / cleanup: branch not merged, use --force · 1 usage or precondition failure
# (bad wave id, no sprints, a sprint without exactly one in-progress file or one S-NNN-*
# branch, primary not on main, cleanup of a non-land-W-* name) or an unexpected git failure
# (worktree and branch removed again).
#
# Must run under macOS /bin/bash 3.2: no mapfile/readarray/associative arrays, and
# empty-array "${arr[@]}" expansion is an unbound-variable error under set -u.
set -euo pipefail

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
GIT_COMMON=$(git rev-parse --path-format=absolute --git-common-dir)
ROOT=${GIT_COMMON%/.git}
MAIN=${SPRINT_MAIN_BRANCH:-main}
GENERATED=(docs/sprints/INDEX.md docs/sprints/ROADMAP.md docs/DOC_HEALTH.md)
USAGE="usage: assemble-train.sh W-<id> S-A S-B … | assemble-train.sh --cleanup <branch> [--force]"

worktree_path() { # $1 = branch; substr, not $2: worktree paths may contain spaces
  git worktree list --porcelain | awk -v b="refs/heads/$1" '
    /^worktree /{wt=substr($0,10)} /^branch /{if (substr($0,8)==b) print wt}'
}

# --- cleanup ------------------------------------------------------------------
if [[ ${1:-} == --cleanup ]]; then
  shift
  BR=${1:-}
  [[ -n $BR ]] || { echo "$USAGE" >&2; exit 1; }
  shift
  FORCE=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
    --force) FORCE=1; shift ;;
    *) echo "unknown arg: $1" >&2; echo "$USAGE" >&2; exit 1 ;;
    esac
  done
  [[ $BR == land-W-* ]] || { echo "refusing: '$BR' is not a land-W-* integration branch" >&2; exit 1; }

  HAVE_BRANCH=0
  git show-ref --verify --quiet "refs/heads/$BR" && HAVE_BRANCH=1
  WT=$(worktree_path "$BR")
  if [[ $HAVE_BRANCH -eq 0 && -z $WT ]]; then
    echo "nothing to clean: branch $BR and its worktree are already gone"
    exit 0
  fi
  if [[ $HAVE_BRANCH -eq 1 && $FORCE -eq 0 ]]; then
    git merge-base --is-ancestor "$BR" "$MAIN" || {
      echo "$BR is not fully merged into $MAIN — land it first, or pass --force to discard it" >&2
      exit 2
    }
  fi
  if [[ -n $WT ]]; then
    if [[ $FORCE -eq 1 ]]; then
      git worktree remove --force "$WT"
    else
      git worktree remove "$WT" || { echo "could not remove worktree $WT (modified or untracked files?) — pass --force" >&2; exit 1; }
    fi
    echo "removed worktree $WT"
  else
    echo "note: no worktree registered for $BR"
  fi
  if [[ $HAVE_BRANCH -eq 1 ]]; then
    git branch -D -q "$BR"
    echo "deleted branch $BR"
  fi
  exit 0
fi

# --- assemble -------------------------------------------------------------------
[[ $# -ge 1 ]] || { echo "$USAGE" >&2; exit 1; }
WAVE=$1
shift
[[ $WAVE =~ ^W-[0-9]{8}-[0-9a-f]{4}$ ]] || { echo "'$WAVE' is not a wave id (expected W-<8 digits>-<4 hex>)" >&2; exit 1; }
[[ $# -ge 1 ]] || { echo "no sprints given — $USAGE" >&2; exit 1; }
for s in "$@"; do
  [[ $s =~ ^S-[0-9]+$ ]] || { echo "'$s' is not an S-NNN sprint id" >&2; exit 1; }
done
DUPES=$(printf '%s\n' "$@" | sort | uniq -d)
[[ -z $DUPES ]] || { echo "sprint listed more than once: $(echo $DUPES)" >&2; exit 1; }
# ascending sprint-number order (S-002 before S-010, whatever the padding)
SORTED=()
while IFS= read -r s; do SORTED+=("$s"); done < <(printf '%s\n' "$@" | sort -t- -k2,2n)

[[ $(git -C "$ROOT" branch --show-current) == "$MAIN" ]] ||
  { echo "primary checkout is not on $MAIN — stop and ask the user" >&2; exit 1; }

shopt -s nullglob
MEMBER_BRANCHES=() ERRORS=0
for s in "${SORTED[@]}"; do
  files=("$ROOT/docs/sprints/in-progress/$s-"*.md)
  if [[ ${#files[@]} -ne 1 ]]; then
    echo "$s: expected exactly one docs/sprints/in-progress/$s-*.md on the primary checkout, found ${#files[@]} — not started?" >&2
    ERRORS=1
  fi
  brs=()
  while IFS= read -r b; do [[ -z $b ]] || brs+=("$b"); done < <(git -C "$ROOT" for-each-ref --format='%(refname:short)' "refs/heads/$s-*")
  if [[ ${#brs[@]} -ne 1 ]]; then
    echo "$s: expected exactly one local branch named $s-*, found ${#brs[@]}" >&2
    ERRORS=1
    MEMBER_BRANCHES+=("")
  else
    MEMBER_BRANCHES+=("${brs[0]}")
  fi
done
[[ $ERRORS -eq 0 ]] || exit 1

N=1
while git -C "$ROOT" show-ref --verify --quiet "refs/heads/land-$WAVE-$N" || [[ -e "$ROOT/.claude/worktrees/land-$WAVE-$N" ]]; do
  N=$((N + 1))
done
BRANCH="land-$WAVE-$N"
WT="$ROOT/.claude/worktrees/$BRANCH"

resolve_generated() { # take the integration side of each given path, then conclude the merge
  local f
  for f in "$@"; do
    git -C "$WT" checkout --ours -- "$f" && git -C "$WT" add -- "$f" || return 1
  done
  git -C "$WT" commit --no-verify -q --no-edit
}

CREATED=0 DONE=0
remove_integration() {
  git -C "$ROOT" worktree remove --force "$WT" >/dev/null 2>&1 || true
  git -C "$ROOT" branch -D -q "$BRANCH" >/dev/null 2>&1 || true
}
cleanup() {
  if [[ $CREATED -eq 1 && $DONE -eq 0 ]]; then remove_integration; fi
}
trap cleanup EXIT

git -C "$ROOT" worktree add -q "$WT" -b "$BRANCH" "$MAIN"
CREATED=1

MERGED=() CONFLICTS=()
for ((i = 0; i < ${#SORTED[@]}; i++)); do
  s=${SORTED[i]}
  mb=${MEMBER_BRANCHES[i]}
  set +e
  OUT=$(git -C "$WT" merge --no-ff "$mb" -m "land: merge $s into $BRANCH" 2>&1)
  rc=$?
  set -e
  if [[ $rc -eq 0 ]]; then
    MERGED+=("$s")
    continue
  fi
  if ! git -C "$WT" rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
    # failed WITHOUT starting a merge (dirty worktree, fs error): nothing sensible to continue with
    echo "git merge of $mb failed without starting a merge in $WT — status:" >&2
    printf '%s\n' "$OUT" >&2
    git -C "$WT" status --short >&2
    DONE=1
    remove_integration
    exit 1
  fi
  CONFLICTED=()
  while IFS= read -r f; do [[ -z $f ]] || CONFLICTED+=("$f"); done < <(git -C "$WT" diff --name-only --diff-filter=U)
  REAL=0
  for f in ${CONFLICTED[@]+"${CONFLICTED[@]}"}; do
    printf '%s\n' "${GENERATED[@]}" | grep -qxF "$f" || REAL=1
  done
  RESOLVED=0
  if [[ $REAL -eq 0 ]]; then
    # generated docs only: take the integration side; land regenerates them on main
    if resolve_generated ${CONFLICTED[@]+"${CONFLICTED[@]}"} >/dev/null 2>&1; then
      RESOLVED=1
    fi
  fi
  if [[ $RESOLVED -eq 1 ]]; then
    MERGED+=("$s")
  else
    git -C "$WT" merge --abort >/dev/null 2>&1 || git -C "$WT" reset --hard -q HEAD
    CONFLICTS+=("$s (${CONFLICTED[*]+${CONFLICTED[*]}})")
  fi
done

if [[ ${#MERGED[@]} -eq 0 ]]; then
  DONE=1
  remove_integration
  echo "no member could be merged — nothing assembled (worktree and branch removed):" >&2
  for c in ${CONFLICTS[@]+"${CONFLICTS[@]}"}; do echo "conflict: $c"; done
  exit 2
fi

DONE=1
CSV=$(IFS=,; echo "${MERGED[*]}")
echo "branch: $BRANCH"
echo "worktree: $WT"
echo "merged: ${MERGED[*]}"
for c in ${CONFLICTS[@]+"${CONFLICTS[@]}"}; do echo "conflict: $c"; done
echo "next: run scripts/sprint/gate.sh in the worktree, then: merge-sprint.sh prepare $BRANCH && merge-sprint.sh land $BRANCH --sprints $CSV"
