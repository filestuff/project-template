#!/usr/bin/env bash
# Guarded push for ledger-only lifecycle transactions (start.sh, unstart.sh,
# reserve-wave.sh, claims.mjs add). A raw `git push origin main` publishes ALL
# of local main — and local main is shared by every session in the checkout, so
# it can carry another session's landed-but-held completions. A ledger push
# would then ship that code past its owner's deploy gate.
#
#   ledger-push.sh <root> <branch>     # caller MUST already hold the sprint-main lock
#   ledger-push.sh --self-test
#
# Pushes only when every commit in origin/<branch>..<branch> touches nothing
# outside docs/ and .claude/. Otherwise it pushes nothing, keeps the local
# commits, names the code-bearing commits and prints the push-main.sh --expect
# command their owner settles with at their own deploy gate. History is
# linear, so the caller's ledger commit cannot be pushed on its own.
#
# Exit codes: 0 pushed, or nothing to push · 3 withheld — the range carries
# non-ledger commits (nothing pushed) · 1 error (origin unreachable / fetch
# failed / diverged / push failed / usage)
#
# Must run under macOS /bin/bash 3.2 (see push-main.sh's header).
set -euo pipefail

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
MAX_LISTED=20
LEDGER_PATHS='^(docs/|\.claude/)'

# sprint_id_of <subject> — the one sprint id a commit belongs to, or "".
# Keep in sync with push-main.sh's copy (both self-tests pin the same table).
sprint_id_of() {
  grep -oE '^(S-[0-9]+([^0-9A-Za-z]|$)|[A-Za-z]+\(S-[0-9]+\)!?:|sprint: [a-z]+ S-[0-9]+)' <<<"$1" |
    grep -oE 'S-[0-9]+' | head -1 || true
}

# ledger_push <root> <branch> — never touches lock.sh; the caller holds the lock.
ledger_push() {
  local root=$1 branch=$2 range has_origin=0 ls_rc=0
  # --exit-code: 2 = reachable but no such branch; anything else non-zero is an
  # unreachable origin, which must not masquerade as "whole history unpushed".
  git -C "$root" ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1 || ls_rc=$?
  case $ls_rc in
  0) has_origin=1 ;;
  2) ;;
  *) echo "ledger-push: cannot reach origin (ls-remote rc=$ls_rc) — nothing pushed" >&2; return 1 ;;
  esac

  if [[ $has_origin -eq 1 ]]; then
    git -C "$root" fetch -q origin "$branch" || { echo "ledger-push: fetch of origin/$branch failed" >&2; return 1; }
    if [[ $(git -C "$root" rev-parse "$branch") == "$(git -C "$root" rev-parse "origin/$branch")" ]]; then
      echo "ledger-push: nothing to push — local $branch matches origin/$branch"
      return 0
    fi
    if ! git -C "$root" merge-base --is-ancestor "origin/$branch" "$branch"; then
      echo "ledger-push: origin/$branch is not an ancestor of local $branch — histories have diverged; reconcile manually (nothing pushed)" >&2
      return 1
    fi
    range="origin/$branch..$branch"
  else
    range=$branch
  fi

  # Per-commit paths, merges diffed against their first parent: a net
  # `git diff` of the range can cancel out, and a land merge's own
  # first-parent diff is exactly the code it brings in.
  local sha paths offending="" n_offending=0 ids=""
  for sha in $(git -C "$root" rev-list "$range"); do
    if git -C "$root" rev-parse -q --verify "$sha^1" >/dev/null; then
      paths=$(git -C "$root" diff-tree --no-commit-id --name-only -r "$sha^1" "$sha")
    else
      paths=$(git -C "$root" diff-tree --root --no-commit-id --name-only -r "$sha")
    fi
    # No `grep -q` in a pipe (it SIGPIPEs the writer under pipefail); an
    # empty commit's "" must not count as a non-ledger path.
    if [[ -n $(grep -vE "$LEDGER_PATHS" <<<"$paths" | grep -v '^$' || true) ]]; then
      n_offending=$((n_offending + 1))
      if [[ $n_offending -le $MAX_LISTED ]]; then
        offending="$offending  $(git -C "$root" log -1 --format='%h %s' "$sha")"$'\n'
      fi
      ids="$ids $(sprint_id_of "$(git -C "$root" log -1 --format=%s "$sha")")"
    fi
  done

  if [[ $n_offending -gt 0 ]]; then
    local csv
    csv=$(tr ' ' '\n' <<<"$ids" | grep . | sort -u -t- -k2,2n | paste -sd, - || true)
    echo "ledger-push: WITHHELD — local $branch carries $n_offending unpushed commit(s) touching paths outside docs/ and .claude/ (another session's held code?):" >&2
    printf '%s' "$offending" >&2
    [[ $n_offending -gt $MAX_LISTED ]] && echo "  … and $((n_offending - MAX_LISTED)) more" >&2
    echo "ledger-push: nothing pushed; your ledger commit is kept locally (visible to every session in this checkout)." >&2
    echo "ledger-push: settle later — the owner of that code, after its deploy gate: bash $SELF_DIR/push-main.sh${csv:+ --expect $csv}" >&2
    return 3
  fi

  if [[ $has_origin -eq 1 ]]; then
    git -C "$root" push -q origin "$branch" || { echo "ledger-push: push failed" >&2; return 1; }
  else
    git -C "$root" push -q -u origin "$branch" || { echo "ledger-push: push failed" >&2; return 1; }
  fi
  echo "ledger-push: pushed ledger-only range $range"
}

# --- --self-test ------------------------------------------------------------
# Scratch `mktemp -d` work repo + bare origin; never the real repo's lock,
# origin, or push. The last case is a read-only coverage sentinel over this
# script's own directory: nothing but the guarded pushers may push.
run_self_test() {
  local scratch work bare rc out origin_before
  # An inherited GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE (hook or wrapper shell)
  # would redirect every `git -C <scratch>` below into that repo — scrub them.
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY
  SELF_TEST_SCRATCH=$(mktemp -d)
  trap 'rm -rf "$SELF_TEST_SCRATCH"' EXIT
  scratch=$SELF_TEST_SCRATCH
  work="$scratch/work" bare="$scratch/origin.git"
  fail() { echo "FAIL: $1"; [[ -n ${out:-} ]] && echo "$out"; exit 1; }
  commit() { # commit <path> <subject>
    mkdir -p "$work/$(dirname "$1")"
    echo "$RANDOM" >>"$work/$1"
    git -C "$work" add -- "$1"
    git -C "$work" commit -q -m "$2"
  }
  run() { rc=0; out=$(ledger_push "$work" main 2>&1) || rc=$?; }
  origin_head() { git -C "$bare" rev-parse main; }

  # (0) sprint-id parser — the same table as push-main.sh's self-test
  local pair subj want got
  for pair in \
    "S-12: plain|S-12" \
    "S-1234 no colon|S-1234" \
    "fix(S-12): conventional fix|S-12" \
    "docs(S-12): conventional docs|S-12" \
    "feat(S-12)!: breaking|S-12" \
    "sprint: complete S-7 — title|S-7" \
    "sprint: merge S-2,S-3|S-2" \
    "S-200: x (after S-999 review)|S-200" \
    "chore: bump deps|" \
    "fix(ui): mention S-12 later|" \
    "S-12x: not an id|" \
    "Merge branch 'S-12-x'|"; do
    subj=${pair%|*} want=${pair##*|}
    got=$(sprint_id_of "$subj")
    [[ $got == "$want" ]] || fail "(0) sprint_id_of '$subj' = '$got', want '$want'"
  done

  git init -q -b main "$work"
  git -C "$work" config user.email "selftest@example.com"
  git -C "$work" config user.name "ledger-push self-test"
  git -C "$work" config commit.gpgsign false
  commit docs/base.md "base"

  # (h) reachable origin without the branch yet → whole (ledger-only) branch pushed
  git init -q --bare -b main "$bare"
  git -C "$work" remote add origin "$bare"
  run
  [[ $rc -eq 0 ]] || fail "(h) first push of a ledger-only branch should succeed (rc=$rc)"
  [[ $(origin_head) == "$(git -C "$work" rev-parse main)" ]] || fail "(h) origin/main not created"

  # (a) ledger-only range → pushed
  commit docs/sprints/in-progress/S-1.md "sprint: start S-1 — one [skip ci]"
  commit .claude/x.md "sprint: claim x for S-1 [skip ci]"
  run
  [[ $rc -eq 0 ]] || fail "(a) ledger-only range should push (rc=$rc)"
  [[ $(origin_head) == "$(git -C "$work" rev-parse main)" ]] || fail "(a) origin did not advance"

  # (d) nothing to push
  run
  [[ $rc -eq 0 ]] || fail "(d) nothing-to-push should be rc 0 (rc=$rc)"

  # (b) foreign code + ledger commit on top → withheld, origin unchanged
  origin_before=$(origin_head)
  commit src/z.ts "S-200: foreign code (after S-999 review)"
  commit src/w.ts "fix(S-150): foreign conventional fix"
  commit docs/sprints/backlog/S-3.md "sprint: reserve wave W-x — S-3 [skip ci]"
  run
  [[ $rc -eq 3 ]] || fail "(b) foreign code range should be withheld with rc 3 (rc=$rc)"
  [[ $(origin_head) == "$origin_before" ]] || fail "(b) origin moved despite withhold"
  grep -q 'S-200: foreign code' <<<"$out" || fail "(b) offending commit should be listed"
  grep -q 'sprint: reserve wave' <<<"$out" && fail "(b) the ledger commit itself must not be listed as offending"
  grep -q -- '--expect S-150,S-200$' <<<"$out" || fail "(b) settle ids should be the anchored owner ids, numerically sorted (not S-999)"

  # (c) code arriving only through a merge's first-parent diff → withheld
  git -C "$work" reset -q --hard "$origin_before"
  git -C "$work" checkout -q -b side
  git -C "$work" commit -q --allow-empty -m "side: empty"
  git -C "$work" checkout -q main
  commit docs/y.md "docs: y"
  git -C "$work" merge -q --no-ff --no-edit side
  # Rewrite the merge so it (not any side commit) introduces the code.
  mkdir -p "$work/src" && echo m >"$work/src/m.ts"
  git -C "$work" add src/m.ts
  git -C "$work" commit -q --amend --no-edit -m "sprint: merge S-400 — evil merge"
  run
  [[ $rc -eq 3 ]] || fail "(c) code introduced by a merge commit should be withheld (rc=$rc)"
  grep -q -- '--expect S-400' <<<"$out" || fail "(c) settle line should name S-400"

  # (e) diverged origin → error, nothing pushed
  git -C "$work" reset -q --hard "$origin_before"
  local other="$scratch/other"
  git clone -q "$bare" "$other"
  git -C "$other" -c user.email=o@example.com -c user.name=o commit -q --allow-empty -m "remote-only"
  git -C "$other" push -q origin main
  commit docs/z.md "docs: local-only"
  run
  [[ $rc -eq 1 ]] || fail "(e) diverged origin should be rc 1 (rc=$rc)"

  # (g) unreachable origin → error, not a whole-history "withheld"
  git -C "$work" remote set-url origin "$scratch/does-not-exist.git"
  run
  [[ $rc -eq 1 ]] || fail "(g) unreachable origin should be rc 1 (rc=$rc)"
  grep -q 'cannot reach origin' <<<"$out" || fail "(g) should say origin is unreachable"
  git -C "$work" remote set-url origin "$bare"

  # (f) coverage sentinel — read-only grep of this script's directory.
  local f hits=""
  for f in "$SELF_DIR"/*.sh "$SELF_DIR"/*.mjs "$SELF_DIR"/workflows/*.mjs; do
    [[ -f $f ]] || continue
    case "$(basename "$f")" in push-main.sh | ledger-push.sh) continue ;; esac
    if grep -nE "push origin|[\"']push[\"'], *[\"']origin[\"']" "$f" >/dev/null; then
      hits="$hits $(basename "$f")"
    fi
  done
  out=""
  [[ -z $hits ]] || fail "(f) raw push outside the guarded pushers — route ledger pushes through ledger-push.sh, code pushes through push-main.sh --expect:$hits"

  echo "self-test OK"
}

if [[ "${1:-}" == "--self-test" ]]; then
  run_self_test
  exit 0
fi

[[ $# -eq 2 ]] || { echo "usage: ledger-push.sh <root> <branch> | --self-test" >&2; exit 1; }
rc=0
ledger_push "$1" "$2" || rc=$?
exit $rc
