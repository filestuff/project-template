#!/usr/bin/env bash
# pre-push-gate.sh gained a planning-artifact lint (v1.11.0). A lint in the push path is
# only acceptable if it is narrow: it must block a certified brief or a rigor-bearing
# proposal that fails its lint, and must NEVER block an ordinary ledger push — an
# unplanned backlog skeleton, an in-progress file, a pre-1.11 brief, an imported proposal.
set -euo pipefail
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
TMP=$(cd "$TMP" && pwd -P)
R="$TMP/repo"

mkdir -p "$R/scripts/sprint" "$R/docs/sprints/"{backlog,in-progress,done} "$R/docs/proposals" "$R/src"
cp "$REPO_DIR"/lite/scripts/sprint/{plan-check,proposal-check}.mjs "$R/scripts/sprint/"
# render the one placeholder the gate carries, as bootstrap would
sed 's/{{PREPUSH_GATE_COMMANDS}}/:/' "$REPO_DIR/lite/scripts/sprint/pre-push-gate.sh" >"$R/scripts/sprint/pre-push-gate.sh"
cp "$REPO_DIR/lite/docs/sprints/SPRINT_TEMPLATE.md" "$R/docs/sprints/"
cp "$REPO_DIR/lite/docs/proposals/PROPOSAL_TEMPLATE.md" "$R/docs/proposals/"
printf 'one\ntwo\nthree\n' >"$R/src/a.js"
touch "$R/docs/sprints/"{backlog,in-progress,done}/.gitkeep   # keep the dirs across `git clean`

brief() { # $1 = id, $2 = plan_date value, $3 = "risk" to include the 1.11 keys, $4 = citation
  local keys="story_points: 2"
  [[ ${3:-} == risk ]] && keys=$'story_points: 2\nrisk: low\ntier: standard'
  cat <<EOS
---
sprint: $1
status: backlog
goal: Make the thing fast
short: fast thing
depends_on: []
blocks: []
tags: []
$keys
plan_date: $2
start_date: null
end_date: null
touches: []
---

# $1: Fast thing

## Context

- Source: — none
- Binding constraints: — none

## Scope

### Deliverables

1. **Cache the lookup** — independent of all prior deliverables
   - Files: \`src/a.js\` (modified)
   - Reference: \`${4:-src/a.js:2}\`
   - Acceptance criteria:
     - Automated:
       - [ ] \`npm test\` → cache hit counted

### Out of Scope

- nothing

## Interface Contract

### Produces

— none

### Consumes

— none

## Open Questions

— none
EOS
}

cd "$R"
git init -q && git branch -M main
git config user.email t@t && git config user.name t
git add -A && git commit -qm init
git init -q --bare "$TMP/origin.git" && git remote add origin "$TMP/origin.git" && git push -q -u origin main 2>/dev/null

gate() { set +e; out=$(bash scripts/sprint/pre-push-gate.sh origin </dev/null 2>&1); code=$?; set -e; }
commit() { git add -A && git commit -qm "$1"; }
reset() { git reset -q --hard origin/main && git clean -qfd; }

# --- 1. ledger pushes that must NOT be blocked ---------------------------------------
cp docs/sprints/SPRINT_TEMPLATE.md docs/sprints/backlog/S-001-skeleton.md   # unplanned skeleton, placeholders and all
brief S-002 2026-09-01 "" "src/nope.js:9" >docs/sprints/backlog/S-002-old.md      # certified pre-1.11 brief (no risk key), stale citation
brief S-003 2026-09-01 risk "src/nope.js:9" >docs/sprints/in-progress/S-003-live.md # in-progress: citations may legitimately move
commit "ledger"
gate
[[ $code -eq 0 ]] || { echo "ledger-only push was blocked (skeleton / pre-1.11 / in-progress must be skipped):"; echo "$out"; exit 1; }
echo "$out" | grep -q 'plan-check' && { echo "plan-check ran on files it must skip:"; echo "$out"; exit 1; }
reset

# --- 2. a certified 1.11+ backlog brief that fails its lint IS blocked ----------------
brief S-004 2026-11-12 risk "src/nope.js:9" >docs/sprints/backlog/S-004-bad.md
commit "bad brief"
gate
[[ $code -ne 0 ]] || { echo "push with a certified brief citing a missing file was not blocked:"; echo "$out"; exit 1; }
echo "$out" | grep -q 'citation-unresolved' || { echo "block did not name the failing rule:"; echo "$out"; exit 1; }
echo "$out" | grep -q 'bypass with: git push --no-verify' || { echo "block did not print the bypass hint:"; echo "$out"; exit 1; }
reset

# --- 3. the same brief, valid, passes ---------------------------------------------------
brief S-004 2026-11-12 risk >docs/sprints/backlog/S-004-good.md
commit "good brief"
gate
[[ $code -eq 0 ]] || { echo "push with a valid certified brief was blocked:"; echo "$out"; exit 1; }
echo "$out" | grep -q 'linting certified backlog briefs: S-004' || { echo "valid brief was not linted:"; echo "$out"; exit 1; }
reset

# --- 4. proposals: rigor-bearing and broken → blocked; imported (no Rigor) → passes ----
cat >docs/proposals/001-imported.md <<'EOS'
# Proposal 001: An imported plan

**Status**: draft
**Date**: 2026-11-12

## Problem

Lookups are slow.

## Goals / Non-Goals

- Goal: faster lookups.

## Alternatives

### A — Recommended: cache
Cache it.

### B — do nothing
Leave it.

## Decision criteria

Effort.

## Open questions

— none

## References

- `src/a.js:1`
EOS
commit "imported proposal"
gate
[[ $code -eq 0 ]] || { echo "an imported proposal (no Rigor line) was blocked:"; echo "$out"; exit 1; }
echo "$out" | grep -q 'legacy-proposal' || { echo "imported proposal was not shape-checked:"; echo "$out"; exit 1; }
reset

cp docs/proposals/PROPOSAL_TEMPLATE.md docs/proposals/002-unfilled.md   # has a Rigor line and every placeholder
commit "unfilled proposal"
gate
[[ $code -ne 0 ]] || { echo "an unfilled rigor-bearing proposal was not blocked:"; echo "$out"; exit 1; }
echo "$out" | grep -q 'placeholder-left' || { echo "block did not name placeholder-left:"; echo "$out"; exit 1; }
reset

# --- 5. a repo without the lint scripts (pre-1.11 payload) is unaffected ----------------
rm scripts/sprint/plan-check.mjs scripts/sprint/proposal-check.mjs
cp docs/proposals/PROPOSAL_TEMPLATE.md docs/proposals/003-x.md
commit "no lints installed"
gate
[[ $code -eq 0 ]] || { echo "gate failed in a repo without the lint scripts:"; echo "$out"; exit 1; }

echo "pre-push lint: all checks passed"
