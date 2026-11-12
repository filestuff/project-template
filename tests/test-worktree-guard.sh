#!/usr/bin/env bash
# Regression: the gates must never run the package manager inside a linked worktree when the
# project shares one dependency install across worktrees by symlink ("link mode") — doing so
# rewrites the PRIMARY checkout's install and re-points its links into the worktree. A guard
# keyed on "root dependency dir is a symlink" missed worktrees with a real root install.
# Covers: worktree-guard.sh's own self-test, then both gates rendered from their placeholders
# into a fixture repo — primary runs the normal gate; a linked worktree runs the normal gate
# when the worktree command is blank and ONLY the reduced gate when it is set; without
# worktree-guard.sh (lite tier) a linked worktree runs the normal gate. In LINK mode
# (worktree-links.json lists links) a blank worktree command must FAIL the gate rather than fall
# through to the normal gate — that is the very package-manager run link mode exists to prevent.
set -euo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
GUARD="$REPO_DIR/full-overlay/scripts/sprint/worktree-guard.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
TMP=$(cd "$TMP" && pwd -P)
CALLS="$TMP/calls"
fail() { echo "FAIL: $1"; [ -f "$CALLS" ] && sed 's/^/  calls: /' "$CALLS"; exit 1; }

bash "$GUARD" --self-test >/dev/null || fail "worktree-guard.sh --self-test"

# render <src> <dest> <normal-token> <worktree-token> <worktree-value>
# The normal gate records "normal"; the worktree value is either "" or a two-command chain
# recording "reduced-1" then "reduced-2" (proves a realistic `a && b` chain survives).
render() {
  local src=$1 dest=$2 ntok=$3 wtok=$4 wval=$5
  sed -e "s|{{$ntok}}|echo normal >>\"$CALLS\"|" -e "s|{{$wtok}}|$wval|" "$src" >"$dest"
  bash -n "$dest" || fail "rendered $(basename "$dest") ($wtok='$wval') is not valid bash"
  ! grep -q '{{' "$dest" || fail "unrendered placeholder left in $(basename "$dest")"
}
REDUCED="echo reduced-1 >>\"$CALLS\" \&\& echo reduced-2 >>\"$CALLS\""

# Fixture: primary + one linked worktree, gates and guard committed so both checkouts have them.
P="$TMP/primary" W="$TMP/wt"
git init -q "$P"
mkdir -p "$P/scripts/sprint"
cp "$GUARD" "$P/scripts/sprint/"
echo code >"$P/a.txt"
git -C "$P" add -A
git -C "$P" -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -qm base
echo more >>"$P/a.txt"
git -C "$P" -c user.email=t@t -c user.name=t -c commit.gpgsign=false commit -qam code
git -C "$P" worktree add -q "$W" -b wt

# run_gate <checkout> <gate> <worktree-value> → sets CALLED (one line per recorded call)
run_gate() {
  local dir=$1 gate=$2 wval=$3 src ntok wtok
  case $gate in
    gate.sh) src="$REPO_DIR/lite/scripts/sprint/gate.sh" ntok=GATE_COMMANDS wtok=WORKTREE_GATE_COMMANDS ;;
    pre-push-gate.sh) src="$REPO_DIR/lite/scripts/sprint/pre-push-gate.sh" ntok=PREPUSH_GATE_COMMANDS wtok=WORKTREE_PREPUSH_GATE_COMMANDS ;;
  esac
  render "$src" "$dir/scripts/sprint/$gate" "$ntok" "$wtok" "$wval"
  rm -f "$CALLS"
  (cd "$dir" && bash "scripts/sprint/$gate" </dev/null >"$TMP/out" 2>&1) || fail "$gate in $dir exited non-zero: $(cat "$TMP/out")"
  CALLED=$(tr '\n' ' ' <"$CALLS" 2>/dev/null || true)
}

LINKS_JSON="$W/scripts/sprint/worktree-links.json"
NOBIN="$TMP/no-node-bin"   # a PATH with what the gates need, minus node
mkdir -p "$NOBIN"
for c in git dirname grep sed head; do ln -s "$(command -v "$c")" "$NOBIN/$c"; done

# run_gate_fails <gate> <label> [PATH] — the gate in the worktree with a blank worktree command
# must exit non-zero, say why, and never reach the normal gate.
run_gate_fails() {
  local g=$1 label=$2 path=${3:-$PATH} ntok wtok
  case $g in
    gate.sh) ntok=GATE_COMMANDS wtok=WORKTREE_GATE_COMMANDS ;;
    pre-push-gate.sh) ntok=PREPUSH_GATE_COMMANDS wtok=WORKTREE_PREPUSH_GATE_COMMANDS ;;
  esac
  render "$REPO_DIR/lite/scripts/sprint/$g" "$W/scripts/sprint/$g" "$ntok" "$wtok" ""
  rm -f "$CALLS"
  if (cd "$W" && PATH="$path" /bin/bash "scripts/sprint/$g" </dev/null >"$TMP/out" 2>&1); then
    fail "$g ($label) with a blank worktree command should fail, not pass: $(cat "$TMP/out")"
  fi
  [ ! -e "$CALLS" ] || fail "$g ($label) ran the normal gate in a linked worktree"
  grep -q "link mode is on" "$TMP/out" || fail "$g ($label) should explain link mode: $(cat "$TMP/out")"
  grep -q "/template-upgrade" "$TMP/out" || fail "$g ($label) should point at /template-upgrade"
}

for g in gate.sh pre-push-gate.sh; do
  # Link mode + blank worktree command → the gate fails; the normal gate never runs. Also when
  # node (needed to read the links file) is missing.
  echo '{"links": ["deps"]}' >"$LINKS_JSON"
  run_gate_fails "$g" "link mode"
  run_gate_fails "$g" "link mode, no node" "$NOBIN"
  # Install mode (empty links) + blank → the normal gate, as before.
  echo '{"links": [], "envFiles": [".env"]}' >"$LINKS_JSON"
  run_gate "$W" "$g" ""
  [ "$CALLED" = "normal " ] || fail "$g in install mode with a blank worktree command should run the normal gate (got: $CALLED)"
  # Lite tier (no guard) ignores the links file entirely.
  echo '{"links": ["deps"]}' >"$LINKS_JSON"
  mv "$W/scripts/sprint/worktree-guard.sh" "$TMP/guard.bak"
  run_gate "$W" "$g" ""
  [ "$CALLED" = "normal " ] || fail "$g without worktree-guard.sh should run the normal gate even with links (got: $CALLED)"
  mv "$TMP/guard.bak" "$W/scripts/sprint/worktree-guard.sh"
  # Link mode in the PRIMARY → the normal gate.
  cp "$LINKS_JSON" "$P/scripts/sprint/worktree-links.json"
  run_gate "$P" "$g" ""
  [ "$CALLED" = "normal " ] || fail "$g in the primary should run the normal gate in link mode (got: $CALLED)"
  rm -f "$LINKS_JSON" "$P/scripts/sprint/worktree-links.json"

  run_gate "$P" "$g" "$REDUCED"
  [ "$CALLED" = "normal " ] || fail "$g in the primary should run the normal gate (got: $CALLED)"

  run_gate "$W" "$g" ""
  [ "$CALLED" = "normal " ] || fail "$g in a worktree with a blank worktree command should run the normal gate (got: $CALLED)"

  run_gate "$W" "$g" "$REDUCED"
  [ "$CALLED" = "reduced-1 reduced-2 " ] || fail "$g in a worktree should run ONLY the reduced gate (got: $CALLED)"
  grep -q "REDUCED" "$TMP/out" || fail "$g should announce the REDUCED gate"

  # A failing reduced command fails the gate.
  render "$REPO_DIR/lite/scripts/sprint/$g" "$W/scripts/sprint/$g" \
    "$( [ "$g" = gate.sh ] && echo GATE_COMMANDS || echo PREPUSH_GATE_COMMANDS)" \
    "$( [ "$g" = gate.sh ] && echo WORKTREE_GATE_COMMANDS || echo WORKTREE_PREPUSH_GATE_COMMANDS)" \
    "false \&\& echo unreachable >>\"$CALLS\""
  rm -f "$CALLS"
  if (cd "$W" && bash "scripts/sprint/$g" </dev/null >"$TMP/out" 2>&1); then
    fail "$g should fail when the reduced command fails"
  fi
  [ ! -e "$CALLS" ] || fail "$g ran more than the failing reduced command"

  # Lite tier: no worktree-guard.sh beside the gate → normal gate even in a linked worktree.
  mv "$W/scripts/sprint/worktree-guard.sh" "$TMP/guard.bak"
  run_gate "$W" "$g" "$REDUCED"
  [ "$CALLED" = "normal " ] || fail "$g without worktree-guard.sh should run the normal gate (got: $CALLED)"
  mv "$TMP/guard.bak" "$W/scripts/sprint/worktree-guard.sh"
done
