#!/usr/bin/env bash
# Locked batch-push of deferred wave commits. Wave orchestration runs the
# lifecycle scripts with --no-push (each printing a "push deferred" notice)
# so that every ledger-only commit doesn't burn a downstream CI run; this
# script is the checkpoint that actually pushes main, guarding against a
# diverged remote, refusing a range that carries another session's code,
# and forcing CI to run when the pushed range carries code.
#
#   push-main.sh [--wait <secs>] [--expect <csv>] [--allow-foreign]
#   push-main.sh --self-test
#
# Local main is shared by every session in the checkout, so it can carry
# another session's landed-but-held completions. Before pushing, the
# origin/main..main range is classified: commits are grouped by the sprint
# id in their subject (`S-NNN: …`, a conventional-commit scope such as
# `fix(S-NNN): …` / `feat(S-NNN)!: …`, or `sprint: <verb> S-NNN …`; commits
# with no id group under "(unattributed)"), and each group is reported as
# doc-only (every path under docs/ or .claude/) or code.
#
# --expect <csv>: comma-separated sprint ids the caller owns. Any code group
# whose id is absent is FOREIGN and the push is refused (exit 2) unless
# --allow-foreign is given. Omitting --expect keeps the bare call working
# exactly as before (classification is printed, nothing is refused); an empty
# or whitespace-only --expect value is an error, never a silent "no check".
#
# Exit codes: 0 ok (including "nothing to push") · 2 refused — the range has
# a foreign group touching a non-doc path and --allow-foreign was not given ·
# 75 lock busy · 1 error (empty --expect / unreachable origin / diverged remote /
# push failure)
#
# Must run under macOS /bin/bash 3.2: no mapfile/readarray/associative arrays,
# and empty-array "${arr[@]}" expansion is an unbound-variable error under set -u.
set -euo pipefail

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
LEDGER_PATHS='^(docs/|\.claude/)'

# --- pure: sprint_id_of ------------------------------------------------------
# sprint_id_of <subject> — the one sprint id a commit belongs to, or "".
# Anchored at the start of the subject so an id mentioned later in the text
# ("S-200: x (after S-999 review)") never attributes the commit to S-999.
# Keep in sync with ledger-push.sh's copy (both self-tests pin the same table).
sprint_id_of() {
  grep -oE '^(S-[0-9]+([^0-9A-Za-z]|$)|[A-Za-z]+\(S-[0-9]+\)!?:|sprint: [a-z]+ S-[0-9]+)' <<<"$1" |
    grep -oE 'S-[0-9]+' | head -1 || true
}

# --- pure: classify_range ----------------------------------------------------
# classify_range <root> <range> <expect_csv>
# Walks `git log <range>` in <root>, groups commits by sprint_id_of, and prints
# one line per group with its changed-file count and doc-only/code label.
# Merge commits contribute no paths of their own; the commits they bring in are
# in the range and classified individually. When expect_csv is non-empty, any
# group whose id is absent from it is flagged FOREIGN. Prints unconditionally,
# so the composition is a fact BEFORE the push rather than a report after it.
# Takes an explicit root/range (never the script's global $ROOT/$MAIN) so the
# self-test can call it against a throwaway scratch repo.
#
# Returns 0 if nothing needs refusing, 1 if some FOREIGN group touches a
# non-doc path — decide_push turns that into the exit-2 policy.
classify_range() {
  local root=$1 range=$2 expect_csv=$3
  local tmp
  tmp=$(mktemp)

  local commit_line sha subject id f
  while IFS= read -r commit_line; do
    [[ -z "$commit_line" ]] && continue
    sha=${commit_line%% *}
    subject=${commit_line#* }
    id=$(sprint_id_of "$subject")
    [[ -z "$id" ]] && id="(unattributed)"
    # --root: a range with no origin yet starts at the root commit, whose
    # paths diff-tree would otherwise not print.
    while IFS= read -r f; do
      [[ -n "$f" ]] && printf '%s\t%s\n' "$id" "$f" >>"$tmp"
    done < <(git -C "$root" diff-tree --root --no-commit-id --name-only -r "$sha")
  done < <(git -C "$root" log --format='%H %s' "$range")

  echo "range classification ($range):"
  if [[ ! -s "$tmp" ]]; then
    echo "  (no commits with changed paths in range)"
    rm -f "$tmp"
    return 0
  fi

  local group count doc_only label tag is_foreign foreign_nondoc=0
  for group in $(cut -f1 "$tmp" | sort -u); do
    count=$(awk -F'\t' -v id="$group" '$1 == id' "$tmp" | wc -l | tr -d ' ')
    doc_only=1
    while IFS= read -r f; do
      [[ "$f" =~ $LEDGER_PATHS ]] || doc_only=0
    done < <(awk -F'\t' -v id="$group" '$1 == id {print $2}' "$tmp")

    is_foreign=0
    if [[ -n "$expect_csv" ]] && [[ ",${expect_csv}," != *",${group},"* ]]; then
      is_foreign=1
    fi

    label="code"
    [[ "$doc_only" -eq 1 ]] && label="doc-only"
    tag=""
    if [[ "$is_foreign" -eq 1 ]]; then
      tag=" FOREIGN"
      [[ "$doc_only" -eq 0 ]] && foreign_nondoc=1
    fi
    echo "  $group: $count file(s), $label$tag"
  done

  rm -f "$tmp"
  [[ "$foreign_nondoc" -eq 1 ]] && return 1
  return 0
}

# --- pure: decide_push -------------------------------------------------------
# decide_push <root> <range> <expect_csv> <allow_foreign 0|1>
# Wraps classify_range's verdict with the --allow-foreign bypass. Returns 0
# (proceed) or 2 (refuse — the lifecycle scripts' "conflict, needs a decision
# or a flag" exit code).
decide_push() {
  local root=$1 range=$2 expect_csv=$3 allow_foreign=$4
  if classify_range "$root" "$range" "$expect_csv"; then
    return 0
  fi
  [[ "$allow_foreign" -eq 1 ]] && return 0
  return 2
}

# --- skip_ci_guard -----------------------------------------------------------
# skip_ci_guard <root> <branch> <base_ref> <label>
# CI providers read the pushed tip's message: if <branch>'s tip carries a skip
# marker but <base_ref>..<branch> touches non-ledger paths, CI would be skipped
# for real code. Then add an empty, unmarked commit on top of <branch>. Built
# with commit-tree + a compare-and-swap update-ref so it lands on <branch> even
# when a different branch is checked out in <root> (a plain `git commit` writes
# to whatever HEAD points at). Returns 0 whether or not it fired.
skip_ci_guard() {
  local root=$1 branch=$2 base=$3 label=$4
  local head_msg non_ledger old_tip new_tip
  head_msg=$(git -C "$root" log -1 --format=%B "refs/heads/$branch")
  grep -qiE '\[skip ci\]|\[ci skip\]|\[no ci\]|\[skip actions\]|\[actions skip\]|^skip-checks: *true' <<<"$head_msg" || return 0
  non_ledger=$(git -C "$root" diff --name-only "$base..refs/heads/$branch" | grep -vE "$LEDGER_PATHS" || true)
  [[ -n $non_ledger ]] || return 0
  old_tip=$(git -C "$root" rev-parse "refs/heads/$branch")
  new_tip=$(git -C "$root" commit-tree "$old_tip^{tree}" -p "$old_tip" -m "ci: run checks for wave push ($label)")
  git -C "$root" update-ref -m "push-main: skip-CI guard" "refs/heads/$branch" "$new_tip" "$old_tip"
  echo "skip-CI guard fired — $branch's tip carried a skip marker but the range touches non-ledger paths; added an empty commit to force CI"
}

# --- origin_has_branch ---------------------------------------------------------
# origin_has_branch <root> <branch> — prints 1 if origin has <branch>, 0 if origin is reachable
# but has no such branch yet; returns 1 (with a message) if origin cannot be reached. Checked
# BEFORE fetching: `git fetch origin <branch>` exits 128 when the branch does not exist yet.
# Same handling as ledger-push.sh: an unreachable origin must never masquerade as "no remote
# branch yet", which would classify the whole history and skip the divergence check and the
# skip-CI guard.
origin_has_branch() {
  local root=$1 branch=$2 ls_rc=0
  # --exit-code: 2 = reachable but no such branch; anything else non-zero = unreachable.
  git -C "$root" ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1 || ls_rc=$?
  case $ls_rc in
  0) echo 1 ;;
  2) echo 0 ;;
  *) echo "push-main: origin unreachable (ls-remote rc=$ls_rc) — nothing pushed; check the network / remote and re-run" >&2; return 1 ;;
  esac
}

# --- refusal_message -----------------------------------------------------------
# refusal_message <expect_csv> <classification> — the exit-2 explanation, on stderr.
refusal_message() {
  local expect=$1 classification=$2
  echo "refusing to push — the range above has a FOREIGN group touching a non-doc path, and --expect ($expect) does not claim it." >&2
  echo "It may be another session's held code; push it only once its owner has cleared its deploy gate." >&2
  if grep -qE '^  \(unattributed\): .*, code FOREIGN$' <<<"$classification"; then
    echo "Commits without a sprint id in their subject are treated as foreign (the (unattributed) group): tag recovery/fix commits \`fix(S-NNN): …\` and pass that id to --expect." >&2
  fi
  echo "re-run with: $SELF_DIR/push-main.sh --allow-foreign${expect:+ --expect $expect}" >&2
}

# --- pure: verify_ci_hint ----------------------------------------------------
# verify_ci_hint <old_full> <new_full> — the copy-pasteable post-push CI check.
# --base (the pre-push tip) lets verify-ci.sh tell which checks the range can
# trigger; empty = no origin yet, so the flag is omitted.
verify_ci_hint() {
  echo "scripts/sprint/verify-ci.sh $2${1:+ --base $1}"
}

# --- --self-test -------------------------------------------------------------
# Fixture assertions against a throwaway `mktemp -d` git repo — no origin, and
# NEVER lock.sh / git fetch / git push against the real repo (lock.sh's lock
# directory lives in the real repo's git-common-dir; a self-test that reached
# the normal acquire would contend with a real wave's push-main lock).
run_self_test() {
  local scratch rc out
  # An inherited GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE (hook or wrapper shell)
  # would redirect every `git -C <scratch>` below into that repo — scrub them.
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY
  SELF_TEST_SCRATCH=$(mktemp -d)
  trap 'rm -rf "$SELF_TEST_SCRATCH"' EXIT
  scratch=$SELF_TEST_SCRATCH
  fail() { echo "FAIL: $1"; [[ -n ${out:-} ]] && echo "$out"; exit 1; }
  commit() { # commit <path> <subject>
    mkdir -p "$scratch/$(dirname "$1")"
    echo "$RANDOM" >>"$scratch/$1"
    git -C "$scratch" add -- "$1"
    git -C "$scratch" commit -q -m "$2"
  }
  decide() { rc=0; out=$(decide_push "$scratch" "$1" "$2" "$3") || rc=$?; }

  # (0) sprint-id parser
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

  git init -q -b main "$scratch"
  git -C "$scratch" config user.email "selftest@example.com"
  git -C "$scratch" config user.name "push-main self-test"
  git -C "$scratch" config commit.gpgsign false

  # (1) no origin yet: the range is the whole branch, root commit included
  commit src/root.ts "S-300: root code"
  decide main S-100 0
  [[ $rc -eq 2 ]] || fail "(1) root-commit code of a foreign id should be refused (rc=$rc)"
  git -C "$scratch" branch base_ref HEAD

  # (2) own code + foreign docs → allowed
  commit docs/x.md "S-100: own"
  commit docs/y.md "S-200: foreign docs"
  decide base_ref..main S-100 0
  [[ $rc -eq 0 ]] || fail "(2) own + foreign-docs should be allowed (rc=$rc)"

  # (3) own code under a conventional-commit scope → allowed
  commit src/own.ts "fix(S-100): own code, conventional subject"
  commit src/own2.ts "feat(S-100)!: own breaking change"
  decide base_ref..main S-100 0
  [[ $rc -eq 0 ]] || fail "(3) conventional-commit own code should be allowed (rc=$rc)"

  # (4) foreign code → refused; --allow-foreign / no --expect / both ids → allowed
  commit src/z.ts "S-300: foreign code"
  decide base_ref..main S-100 0
  [[ $rc -eq 2 ]] || fail "(4) foreign-code range should be refused without --allow-foreign (rc=$rc)"
  grep -q 'S-300: 1 file(s), code FOREIGN' <<<"$out" || fail "(4) classification should flag S-300 FOREIGN"
  decide base_ref..main S-100 1
  [[ $rc -eq 0 ]] || fail "(4) --allow-foreign should allow the same range (rc=$rc)"
  decide base_ref..main "" 0
  [[ $rc -eq 0 ]] || fail "(4) without --expect nothing is refused (rc=$rc)"
  decide base_ref..main S-100,S-300 0
  [[ $rc -eq 0 ]] || fail "(4) --expect naming both owners should be allowed (rc=$rc)"

  # (5) unattributed code under --expect → refused
  git -C "$scratch" branch -f base_ref main
  commit src/anon.ts "tweak something"
  decide base_ref..main S-100 0
  [[ $rc -eq 2 ]] || fail "(5) unattributed code should be FOREIGN under --expect (rc=$rc)"

  # (6) skip-CI guard lands on main even with another branch checked out
  local before other_before msg
  git -C "$scratch" branch -f base_ref main
  commit src/code.ts "S-100: code"
  commit docs/ledger.md "sprint: complete S-100 [skip ci]"
  git -C "$scratch" checkout -q -b elsewhere
  commit docs/elsewhere.md "docs: unrelated work on another branch"
  before=$(git -C "$scratch" rev-parse main)
  other_before=$(git -C "$scratch" rev-parse elsewhere)
  out=$(skip_ci_guard "$scratch" main base_ref "test")
  [[ $(git -C "$scratch" rev-parse "main^") == "$before" ]] || fail "(6) guard commit should sit directly on top of main"
  [[ $(git -C "$scratch" rev-parse "main^{tree}") == "$(git -C "$scratch" rev-parse "$before^{tree}")" ]] || fail "(6) guard commit should be empty"
  msg=$(git -C "$scratch" log -1 --format=%B main)
  grep -qi 'skip ci' <<<"$msg" && fail "(6) guard commit must not carry a skip marker"
  [[ $(git -C "$scratch" rev-parse elsewhere) == "$other_before" ]] || fail "(6) guard wrote to the checked-out branch"
  [[ $(git -C "$scratch" branch --show-current) == elsewhere ]] || fail "(6) guard changed the checked-out branch"
  [[ -z $(git -C "$scratch" status --porcelain) ]] || fail "(6) guard dirtied the worktree"
  git -C "$scratch" checkout -q main

  # (7) guard stays quiet on a doc-only range and on an unmarked tip
  git -C "$scratch" branch -f base_ref main
  commit docs/only.md "sprint: start S-5 [skip ci]"
  before=$(git -C "$scratch" rev-parse main)
  out=$(skip_ci_guard "$scratch" main base_ref "test")
  [[ $(git -C "$scratch" rev-parse main) == "$before" ]] || fail "(7) guard fired on a doc-only range"
  commit src/more.ts "S-5: code, unmarked tip"
  before=$(git -C "$scratch" rev-parse main)
  out=$(skip_ci_guard "$scratch" main base_ref "test")
  [[ $(git -C "$scratch" rev-parse main) == "$before" ]] || fail "(7) guard fired on an unmarked tip"

  # (8) verify-ci hint
  out=""
  [[ $(verify_ci_hint aaa bbb) == "scripts/sprint/verify-ci.sh bbb --base aaa" ]] || fail "(8) hint should name --base when the pre-push tip is known"
  [[ $(verify_ci_hint "" bbb) == "scripts/sprint/verify-ci.sh bbb" ]] || fail "(8) hint should omit --base with no pre-push tip"

  # (9) --expect with an empty / whitespace-only value (an unset shell variable) is an error,
  #     not a silently disabled foreign check. Exits during arg parsing, before lock.sh.
  local self val
  self="$SELF_DIR/$(basename "${BASH_SOURCE[0]}")"
  for val in "" "  " $'\t'; do
    rc=0; out=$(cd "$scratch" && "$BASH" "$self" --wait 0 --expect "$val" 2>&1) || rc=$?
    [[ $rc -eq 1 ]] || fail "(9) --expect '$val' should exit 1 (rc=$rc)"
    grep -q -- '--expect needs' <<<"$out" || fail "(9) --expect '$val' should say why"
  done

  # (10) origin state: 0 = branch exists, rc 2 = reachable but no branch yet; anything else is
  #      an unreachable origin — never read as "no remote branch yet" (which would classify the
  #      whole history and skip the divergence check and the skip-CI guard).
  git init -q --bare -b main "$scratch.origin.git"
  git -C "$scratch" remote add origin "$scratch.origin.git"
  rc=0; out=$(origin_has_branch "$scratch" main 2>&1) || rc=$?
  [[ $rc -eq 0 && $out == 0 ]] || fail "(10) a reachable origin without main should report 0 (rc=$rc)"
  git -C "$scratch" push -q origin main
  rc=0; out=$(origin_has_branch "$scratch" main 2>&1) || rc=$?
  [[ $rc -eq 0 && $out == 1 ]] || fail "(10) an origin with main should report 1 (rc=$rc)"
  git -C "$scratch" remote set-url origin "$scratch/no-such-origin.git"
  rc=0; out=$(origin_has_branch "$scratch" main 2>&1) || rc=$?
  [[ $rc -eq 1 ]] || fail "(10) an unreachable origin should be an error (rc=$rc)"
  grep -q 'unreachable' <<<"$out" || fail "(10) an unreachable origin should say so"
  rm -rf "$scratch.origin.git"

  # (11) a refused (unattributed) code group explains the attribution rule; other refusals don't
  local cls
  cls=$'range classification (x):\n  (unattributed): 1 file(s), code FOREIGN\n  S-100: 1 file(s), code'
  out=$(refusal_message S-100 "$cls" 2>&1)
  grep -q 'refusing to push' <<<"$out" || fail "(11) refusal should keep its existing lines"
  grep -q 'without a sprint id' <<<"$out" || fail "(11) an unattributed FOREIGN group should explain the rule"
  grep -q 'fix(S-NNN)' <<<"$out" || fail "(11) the explanation should name the fix(S-NNN) tag"
  cls=$'range classification (x):\n  (unattributed): 1 file(s), doc-only FOREIGN\n  S-300: 1 file(s), code FOREIGN'
  out=$(refusal_message S-100 "$cls" 2>&1)
  ! grep -q 'without a sprint id' <<<"$out" || fail "(11) no unattributed CODE group — no attribution note"

  echo "self-test OK"
}

# --self-test is handled first — before GIT_COMMON/ROOT/MAIN are computed, let
# alone lock.sh / git fetch / git push.
if [[ "${1:-}" == "--self-test" ]]; then
  run_self_test
  exit 0
fi

GIT_COMMON=$(git rev-parse --path-format=absolute --git-common-dir)
ROOT=${GIT_COMMON%/.git}
MAIN=${SPRINT_MAIN_BRANCH:-main}

WAIT=300
EXPECT=""
EXPECT_SET=0
ALLOW_FOREIGN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
  --wait) WAIT=$2; shift 2 ;;
  --expect) EXPECT=$2; EXPECT_SET=1; shift 2 ;;
  --allow-foreign) ALLOW_FOREIGN=1; shift ;;
  *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done
# An empty --expect (typically an unset shell variable) would silently disable the foreign
# check — the exact case the flag exists to catch. Omit the flag instead to mean "no check".
if [[ $EXPECT_SET -eq 1 && -z ${EXPECT//[[:space:]]/} ]]; then
  echo "push-main: --expect needs a non-empty sprint-id list (got '$EXPECT' — an unset variable?); omit --expect entirely to skip the foreign check" >&2
  exit 1
fi

TOKEN=$("$SELF_DIR/lock.sh" acquire "push-main" --wait "$WAIT")
cleanup() {
  "$SELF_DIR/lock.sh" release "$TOKEN" || true
}
trap cleanup EXIT

HAS_ORIGIN=$(origin_has_branch "$ROOT" "$MAIN") || exit 1

if [[ $HAS_ORIGIN -eq 1 ]]; then
  git -C "$ROOT" fetch origin "$MAIN"
  if [[ $(git -C "$ROOT" rev-parse "$MAIN") == "$(git -C "$ROOT" rev-parse "origin/$MAIN")" ]]; then
    echo "nothing to push — local $MAIN matches origin/$MAIN"
    exit 0
  fi
  if ! git -C "$ROOT" merge-base --is-ancestor "origin/$MAIN" "$MAIN"; then
    echo "origin/$MAIN is not an ancestor of local $MAIN — histories have diverged (remote moved, likely from another machine)." >&2
    echo "This script will NOT auto-rebase or merge the ledger. Reconcile manually:" >&2
    echo "  git -C \"$ROOT\" log --oneline $MAIN..origin/$MAIN   # see what origin has that you don't" >&2
    echo "  git -C \"$ROOT\" log --oneline origin/$MAIN..$MAIN   # see what you have that origin doesn't" >&2
    exit 1
  fi
fi

OLD_SHA=$(git -C "$ROOT" rev-parse --short "origin/$MAIN" 2>/dev/null || echo '(none)')
OLD_FULL=$(git -C "$ROOT" rev-parse "origin/$MAIN" 2>/dev/null || echo '')

# Classify the about-to-be-pushed range BEFORE pushing — and before the skip-CI
# guard, so a refusal leaves local main exactly as it was.
if [[ $HAS_ORIGIN -eq 1 ]]; then
  RANGE="origin/$MAIN..$MAIN"
else
  RANGE="$MAIN"
fi
DECIDE_RC=0
CLASSIFICATION=$(decide_push "$ROOT" "$RANGE" "$EXPECT" "$ALLOW_FOREIGN") || DECIDE_RC=$?
echo "$CLASSIFICATION"
if [[ $DECIDE_RC -ne 0 ]]; then
  refusal_message "$EXPECT" "$CLASSIFICATION"
  exit 2
fi

if [[ $HAS_ORIGIN -eq 1 ]]; then
  skip_ci_guard "$ROOT" "$MAIN" "origin/$MAIN" "$OLD_SHA..$(git -C "$ROOT" rev-parse --short "$MAIN")"
  git -C "$ROOT" push origin "$MAIN" || { echo "push failed — local commits intact; resolve and re-run push-main.sh" >&2; exit 1; }
else
  git -C "$ROOT" push -u origin "$MAIN" || { echo "push failed — local commits intact; resolve and re-run push-main.sh" >&2; exit 1; }
fi

NEW_SHA=$(git -C "$ROOT" rev-parse --short "$MAIN")
EMPTY_TREE=$(git -C "$ROOT" hash-object -t tree /dev/null)
if [[ $OLD_SHA == "(none)" ]]; then
  COUNT=$(git -C "$ROOT" rev-list --count "$MAIN")
  RANGE_NON_LEDGER=$(git -C "$ROOT" diff --name-only "$EMPTY_TREE" "$MAIN" | grep -vE "$LEDGER_PATHS" || true)
else
  COUNT=$(git -C "$ROOT" rev-list --count "$OLD_SHA..$MAIN")
  RANGE_NON_LEDGER=$(git -C "$ROOT" diff --name-only "$OLD_SHA..$MAIN" | grep -vE "$LEDGER_PATHS" || true)
fi

echo "pushed $OLD_SHA..$NEW_SHA to origin/$MAIN ($COUNT commit(s))"
if [[ -n $RANGE_NON_LEDGER ]]; then
  echo "this push carries code — verify CI green on it: $(verify_ci_hint "$OLD_FULL" "$(git -C "$ROOT" rev-parse "$MAIN")")  (PROTOCOL Phase 3 Step 6)"
fi
