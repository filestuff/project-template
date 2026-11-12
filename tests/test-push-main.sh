#!/usr/bin/env bash
# Regression: push-main.sh pushed all of local main unconditionally — and local
# main is shared by every session in the checkout, so a wave's checkpoint push
# could ship another session's held code past its deploy gate; the range was
# only reported AFTER the push. It now classifies origin/main..main by sprint id
# (`S-NNN:` and conventional `type(S-NNN):` subjects) BEFORE pushing and, with
# `--expect <csv>`, refuses (exit 2) any foreign code group unless
# --allow-foreign. Also: the skip-CI guard ran `git commit --allow-empty`, which
# writes to whatever branch is checked out — not main — so with a feature branch
# checked out the "force CI" commit landed on the wrong branch and main was
# pushed with its [skip ci] tip anyway.
set -euo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
TMP=$(cd "$TMP" && pwd -P)
R="$TMP/repo" ORIGIN="$TMP/origin.git"

mkdir -p "$R/scripts/sprint"
cp "$REPO_DIR"/full-overlay/scripts/sprint/{push-main.sh,lock.sh} "$R/scripts/sprint/"
chmod +x "$R"/scripts/sprint/*.sh
PM="$R/scripts/sprint/push-main.sh"

# --- 1. the script's own fixture assertions ----------------------------------
bash "$PM" --self-test >/dev/null || { echo "push-main.sh --self-test failed:"; bash "$PM" --self-test; exit 1; }

# --- end-to-end fixture: a work repo + a bare origin --------------------------
cd "$R"
git init -q -b main
git config user.email t@t && git config user.name t && git config commit.gpgsign false
printf 'scripts/\n' >.gitignore
mkdir -p docs src
echo base >docs/base.md
git add -A && git commit -qm "base"
git init -q --bare -b main "$ORIGIN"
git remote add origin "$ORIGIN"
c() { mkdir -p "$(dirname "$1")"; echo "$RANDOM" >>"$1"; git add -- "$1"; git commit -qm "$2"; }
run() { set +e; out=$(bash "$PM" --wait 0 "$@" 2>&1); code=$?; set -e; }
origin_main() { git -C "$ORIGIN" rev-parse -q --verify main || echo none; }

# --- 2. no origin branch yet: first push creates it ---------------------------
run
[[ $code -eq 0 ]] || { echo "first push exited $code:"; echo "$out"; exit 1; }
[[ $(origin_main) == "$(git rev-parse main)" ]] || { echo "origin/main not created"; exit 1; }

# --- 3. foreign code under --expect: refused, local main and origin untouched --
c src/own.ts "fix(S-1): own code"
c src/held.ts "S-9: another session's held code"
c docs/ledger.md "sprint: complete S-1 [skip ci]"
BEFORE=$(git rev-parse main) ORIGIN_BEFORE=$(origin_main)
run --expect S-1
[[ $code -eq 2 ]] || { echo "expected exit 2 on a foreign code group, got $code:"; echo "$out"; exit 1; }
echo "$out" | grep -q 'S-9: 1 file(s), code FOREIGN' || { echo "classification did not flag S-9:"; echo "$out"; exit 1; }
echo "$out" | grep -q 'S-1: 2 file(s), code$' || { echo "conventional fix(S-1) not attributed to S-1:"; echo "$out"; exit 1; }
[[ $(git rev-parse main) == "$BEFORE" ]] || { echo "refusal changed local main (guard commit added before the refusal?)"; exit 1; }
[[ $(origin_main) == "$ORIGIN_BEFORE" ]] || { echo "refusal moved origin"; exit 1; }
bash scripts/sprint/lock.sh status 2>/dev/null | grep -q LABEL && { echo "lock not released after refusal"; exit 1; }

# --- 4. owner settles: guard fires on main while a feature branch is checked out
git checkout -q -b feature
c docs/feature.md "docs: unrelated work on a feature branch"
FEATURE_BEFORE=$(git rev-parse feature)
run --expect S-1,S-9
[[ $code -eq 0 ]] || { echo "settling push exited $code:"; echo "$out"; exit 1; }
echo "$out" | grep -q 'skip-CI guard fired' || { echo "skip-CI guard did not fire:"; echo "$out"; exit 1; }
[[ $(git rev-parse main^) == "$BEFORE" ]] || { echo "guard commit is not on top of main"; exit 1; }
[[ $(origin_main) == "$(git rev-parse main)" ]] || { echo "origin did not receive main + guard commit"; exit 1; }
git -C "$ORIGIN" log -1 --format=%B main | grep -qi 'skip ci' && { echo "pushed tip still carries a skip marker"; exit 1; }
[[ $(git rev-parse feature) == "$FEATURE_BEFORE" ]] || { echo "guard wrote to the checked-out feature branch"; exit 1; }
[[ $(git branch --show-current) == feature ]] || { echo "checked-out branch changed"; exit 1; }
echo "$out" | grep -q "verify CI green on it: scripts/sprint/verify-ci.sh $(git rev-parse main) --base $ORIGIN_BEFORE" ||
  { echo "verify-ci hint missing or wrong:"; echo "$out"; exit 1; }
git checkout -q main

# --- 5. nothing to push --------------------------------------------------------
run --expect S-1
[[ $code -eq 0 ]] && echo "$out" | grep -q 'nothing to push' || { echo "expected nothing-to-push, got $code:"; echo "$out"; exit 1; }

# --- 6. --expect "" (an unset variable) is an error, not a disabled foreign check
c src/held2.ts "S-9: more held code"
BEFORE=$(git rev-parse main)
run --expect ""
[[ $code -eq 1 ]] || { echo "expected exit 1 on an empty --expect, got $code:"; echo "$out"; exit 1; }
echo "$out" | grep -q -- '--expect needs' || { echo "empty --expect not explained:"; echo "$out"; exit 1; }
[[ $(origin_main) != "$BEFORE" ]] || { echo "empty --expect pushed"; exit 1; }

# --- 7. unattributed code: the refusal explains the sprint-id attribution rule --
git reset -q --hard "$(origin_main)"
c src/anon.ts "quick recovery fix"
run --expect S-1
[[ $code -eq 2 ]] || { echo "expected exit 2 on unattributed code, got $code:"; echo "$out"; exit 1; }
echo "$out" | grep -q 'without a sprint id' || { echo "refusal does not explain unattributed commits:"; echo "$out"; exit 1; }
echo "$out" | grep -q 'refusing to push' || { echo "refusal lost its existing lines:"; echo "$out"; exit 1; }

# --- 8. unreachable origin: exit 1 before classifying, never "no remote branch yet"
git remote set-url origin "$TMP/no-such-origin.git"
run --expect S-1
[[ $code -eq 1 ]] || { echo "expected exit 1 on an unreachable origin, got $code:"; echo "$out"; exit 1; }
echo "$out" | grep -q 'origin unreachable' || { echo "unreachable origin not reported:"; echo "$out"; exit 1; }
echo "$out" | grep -q 'range classification' && { echo "unreachable origin classified the range as if unpushed:"; echo "$out"; exit 1; }
git remote set-url origin "$ORIGIN"

echo "push-main: all checks passed"
