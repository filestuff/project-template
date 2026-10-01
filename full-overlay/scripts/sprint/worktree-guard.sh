#!/usr/bin/env bash
# Linked-worktree guard — the ONE definition of "am I in a sprint worktree?" for the gates.
# Sourced by scripts/sprint/gate.sh, scripts/sprint/pre-push-gate.sh and
# scripts/sprint/worktree-link.sh.
#
# In "link mode" (scripts/sprint/worktree-links.json lists dependency dirs) a worktree's
# dependency dirs are symlinks into the PRIMARY checkout. Running the package manager there
# (e.g. `pnpm install`, or a `pnpm lint` that triggers one) rewrites the primary's install
# metadata and re-points its package links into this worktree. Nothing looks broken until
# the worktree is removed; then the primary's toolchain dangles.
#
# Keyed on "linked worktree" alone, never on which dependency dir is a symlink: a guard that
# also required a symlinked ROOT dependency dir missed worktrees that carry their own real
# root install beside linked package-level dirs — and the gate then corrupted the primary.
#
#   source scripts/sprint/worktree-guard.sh; in_linked_worktree && …
#   bash scripts/sprint/worktree-guard.sh --self-test

# Exit 0 iff the cwd is inside a linked worktree; 1 in a primary checkout or outside git.
# `--git-dir` is RELATIVE (".git") in a primary but absolute in a linked worktree, and either
# side can sit under a symlinked path (macOS /var → /private/var), so both sides are resolved
# with `pwd -P` before comparing — comparing raw values is a false positive in the primary.
in_linked_worktree() {
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 1
  local git_dir common_dir
  git_dir="$(cd "$(git rev-parse --absolute-git-dir)" && pwd -P)"
  common_dir="$(cd "$(git rev-parse --git-common-dir)" && pwd -P)"
  [ "$git_dir" != "$common_dir" ]
}

# --- --self-test ------------------------------------------------------------
# Scratch `mktemp -d` repo + linked worktrees; never the real repo's worktrees.
run_self_test() {
  local scratch primary wt_real wt_link
  # An inherited GIT_DIR/GIT_WORK_TREE (hook or wrapper shell) would redirect every git call
  # below into that repo — scrub them first.
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY
  scratch=$(mktemp -d)
  # EXIT, not just fail(): an unexpected command failure under `set -e` would otherwise leave
  # the scratch tree behind.
  # shellcheck disable=SC2064 # expand now: `scratch` is local and gone when EXIT fires
  trap "rm -rf '$scratch'" EXIT
  primary="$scratch/primary" wt_real="$scratch/wt-real" wt_link="$scratch/wt-link"
  fail() { echo "FAIL: $1"; exit 1; }
  guard_in() { (cd "$1" && in_linked_worktree); }

  git init -q "$primary"
  git -C "$primary" -c user.email=selftest@example.com -c user.name="worktree-guard self-test" \
    -c commit.gpgsign=false commit -q --allow-empty -m base
  mkdir -p "$primary/node_modules/.bin"
  git -C "$primary" worktree add -q "$wt_real" -b wt-real
  git -C "$primary" worktree add -q "$wt_link" -b wt-link

  # (a) primary checkout → not a linked worktree
  guard_in "$primary" && fail "(a) primary checkout reported as a linked worktree"

  # (b) linked worktree with a REAL root install → linked
  mkdir -p "$wt_real/node_modules/.bin"
  guard_in "$wt_real" || fail "(b) worktree with a real root install not detected"

  # (c) linked worktree with a symlinked root install (link mode) → linked
  ln -s "$primary/node_modules" "$wt_link/node_modules"
  guard_in "$wt_link" || fail "(c) worktree with a symlinked root install not detected"

  echo "self-test OK"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  if [[ "${1:-}" == "--self-test" ]]; then
    set -euo pipefail
    run_self_test
    exit 0
  fi
  echo "usage: worktree-guard.sh --self-test   (otherwise source it for in_linked_worktree)" >&2
  exit 1
fi
