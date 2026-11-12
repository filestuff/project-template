#!/usr/bin/env bash
# Regression: worktree-link.sh setup/teardown — link mode shares ONE dependency install across
# worktrees by symlink. Setup must refuse in the primary, move a worktree's own real install
# aside (two copies side by side break tooling), keep keepIfReal dirs, refuse a foreign link or
# an existing aside copy, and stay idempotent; teardown must restore the aside copy and fail
# while any primary link still points into the worktree (removing it would leave them
# dangling). Install mode (no links) only copies env files. Neither may ever act on the primary:
# overlapping links entries are refused at config load, and a symlinked parent component is
# refused at setup and teardown. All cases live in --self-test.
set -euo pipefail
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
bash "$REPO_DIR/full-overlay/scripts/sprint/worktree-link.sh" --self-test >/dev/null
