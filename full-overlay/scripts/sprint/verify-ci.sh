#!/usr/bin/env bash
# verify-ci.sh — the scripted close-time CI check: is CI actually green for the SHA just pushed?
#
# WHY: the commit gate runs locally and is deliberately narrow; the slower, broader checks (type
# checks, builds, full test suites, deploys) run only in CI, AFTER the push. If nobody reads their
# verdict, a red run — or a run that never started at all — rides silently on the main branch while
# the close reads as clean. This script turns "go poll the CI page" into a check with an exit code,
# run by the caller on the SHA `push-main.sh` pushed.
#
# What it checks, per scripts/sprint/ci-gates.json (next to this script):
#   - each workflow in `workflows` has a run for the SHA on the main branch, concluded green;
#   - when `deployEnvironment` is a string, the GitHub deployment recorded for the SHA in that
#     environment did not fail (read from GitHub's deployments API, so any deploy provider that
#     reports there is covered and no CI minutes are spent).
#
# It FAILS CLOSED. Exit 2 means "could not prove green" and is NOT a pass: a `gh` API error is never
# read as "no run"; an expected run/deploy that never appears within --grace is exit 2; and a run is
# only "not expected" when --base proves the pushed range touches nothing the workflow's
# `on.push.paths` filter matches. Omitting --base means the range is unknown, so every gate is
# expected.
#
# It does NOT roll anything back: the work is already committed + pushed. A RED result means
# "the close is not clean — reopen it with a follow-up fix".
#
# Usage:  verify-ci.sh [<sha>] [--base <sha>] [--repo <owner/name>] [--timeout <sec>]
#                      [--interval <sec>] [--grace <sec>]
#         verify-ci.sh --self-test   (stubbed `gh` + scratch repo; no network)
#           <sha>       defaults to HEAD (the just-pushed commit).
#           --base      the tip of origin/<main> BEFORE the push (push-main.sh prints it). Lets the
#                       script prove a gate is NOT expected for the range. Omitted = every gate is
#                       expected (fail closed).
#           --repo      owner/name; default derived from the `origin` URL (github.com). Always passed
#                       to `gh` as -R, because gh's own default may resolve to an `upstream` remote.
#           --timeout   max seconds to wait for runs to complete (default: config timeoutSeconds, 1800).
#           --interval  seconds between polls (default 20).
#           --grace     seconds an EXPECTED run/deploy may take to appear (default: config
#                       graceSeconds, 300); past it, its absence is exit 2, never a pass.
# Config: scripts/sprint/ci-gates.json (override path with CI_GATES_FILE):
#           { "workflows": [ { "name": "<workflow display name>", "file": "<file in .github/workflows/>" } ],
#             "deployEnvironment": null | "<environment name>",
#             "timeoutSeconds": 1800, "graceSeconds": 300 }
#         Missing file or empty `workflows` = exit 2 (nothing to verify is not green).
# Env:    SPRINT_MAIN_BRANCH  — the branch runs are listed on (default main).
#         SKIP_CI_VERIFY=1    — skip entirely (a genuine offline / no-`gh` close); requires
#           SKIP_CI_VERIFY_REASON="<why>" too, so an override is a visible decision, not an invisible
#           one — exits 1 without it, and prints the reason in the skip line when given.
# Exit:   0 = every required workflow is green for this SHA (or provably not expected for the
#             range), and the deploy (if configured) did not fail (or is provably not expected);
#         1 = a required workflow is RED (failure/timed_out/startup_failure), the deploy FAILED,
#             or SKIP_CI_VERIFY=1 without a reason — REOPEN the close;
#         2 = not verifiable (bad flag/config, `gh`/jq missing or unauthenticated, owner/repo not
#             derivable, `gh` erroring until timeout, runs cancelled/superseded, timed out before
#             completion, or an expected run/deploy never appeared) — check manually; NOT a pass.

set -uo pipefail

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
MAIN=${SPRINT_MAIN_BRANCH:-main}
BASE=""
REPO=""
TIMEOUT=""   # empty = take timeoutSeconds from the config
INTERVAL=20
GRACE=""     # empty = take graceSeconds from the config
SHA=""

# NB: both diffs use --no-renames — by default git lists only the DESTINATION of a rename, so a move
# out of a watched directory would hide the path that triggers the workflow.
# --- pure helpers: is a run / deploy expected for a pushed range? ------------------------------
# Fail closed: anything unknown (no --base, unresolvable base, unreadable or unparseable workflow)
# answers "yes", so the worst outcome of a parse break is a false exit 2, never a false green.

# push_paths — reads a workflow file on stdin, prints each `on.push.paths` entry (one per line,
# quotes stripped). Only the 2-space `push:` block's 4-space `paths:` list is read;
# `pull_request:` has its own `paths:` and is ignored.
push_paths() {
  awk '
    /^[^ #]/ { inpush = 0; inpaths = 0; next }
    /^  [A-Za-z_-]+:/ { inpush = ($1 == "push:"); inpaths = 0; next }
    inpush && /^    [A-Za-z_-]+:/ { inpaths = ($1 == "paths:"); next }
    inpush && inpaths && /^      - / { sub(/^      - */, ""); sub(/ *#.*$/, ""); sub(/[ \t\r]+$/, ""); print }
  ' | tr -d "\"'"
}

# expects_run <root> <base> <sha> <workflow-file> — prints yes|no. `no` ONLY when the base resolves,
# the workflow's push filter has `paths:` in a supported shape (`dir/**` prefix or an exact file),
# and no file in base..sha matches. N/A only ever applies when NO run exists, so a run GitHub
# creates anyway is always evaluated — a "no" can never hide a real red.
expects_run() {
  local root=$1 base=$2 sha=$3 file=$4 wf paths changed pat f
  { [[ -n "$base" ]] && git -C "$root" rev-parse --verify --quiet "${base}^{commit}" >/dev/null 2>&1; } || { echo yes; return; }
  wf=$(git -C "$root" show "$sha:.github/workflows/$file" 2>/dev/null) || { echo yes; return; }
  paths=$(printf '%s\n' "$wf" | push_paths)
  [[ -n "$paths" ]] || { echo yes; return; }
  changed=$(git -C "$root" diff --no-renames --name-only "$base" "$sha" 2>/dev/null) || { echo yes; return; }
  [[ -n "$changed" ]] || { echo yes; return; }
  while IFS= read -r pat; do
    # Unsupported shape (a glob other than a trailing `/**`, or a `!` exclusion) -> can't judge.
    if printf '%s' "${pat%/\*\*}" | grep -q '[]*?[+!]'; then echo yes; return; fi
  done <<<"$paths"
  while IFS= read -r pat; do
    while IFS= read -r f; do
      if [[ "$pat" == */\*\* ]]; then
        [[ "$f" == "${pat%\*\*}"* ]] && { echo yes; return; }
      else
        [[ "$f" == "$pat" ]] && { echo yes; return; }
      fi
    done <<<"$changed"
  done <<<"$paths"
  echo no
}

# expects_deploy <root> <base> <sha> — prints yes|no. `no` ONLY when the base resolves and every
# changed file is under docs/ or .claude/ (workflow bookkeeping that carries no deployable code).
# Deliberately narrow: over-inclusive is fail-safe (exit 2, not green).
expects_deploy() {
  local root=$1 base=$2 sha=$3 changed f re='^(docs/|\.claude/)'
  { [[ -n "$base" ]] && git -C "$root" rev-parse --verify --quiet "${base}^{commit}" >/dev/null 2>&1; } || { echo yes; return; }
  changed=$(git -C "$root" diff --no-renames --name-only "$base" "$sha" 2>/dev/null) || { echo yes; return; }
  [[ -n "$changed" ]] || { echo yes; return; }
  while IFS= read -r f; do
    [[ "$f" =~ $re ]] || { echo yes; return; }
  done <<<"$changed"
  echo no
}

# --- --self-test -------------------------------------------------------------
# Runs THIS script as a child process against a stubbed `gh` and a throwaway `mktemp -d` git repo
# with a synthetic workflow + ci-gates.json: no network, never a real origin. The stub applies the
# script's own `--jq` filter with system jq, so the real filters are under test (a stub that echoed
# pre-filtered strings would hide a broken filter). Scenarios record failures and keep going, so one
# run names every red one.
ST_FAILS=""

# st_stub — the fake `gh`. Each call reads the n-th canned response for its kind (runs |
# deployments | statuses) from $scratch/canned/<kind>.<n>.json; the last file repeats; no file =
# `[]`; a file containing `ERR` makes the stub exit 1. Every call is logged to canned/calls.log.
# The counter is file-based because every `gh` call runs in a `$(…)` subshell.
st_stub() {
  cat >"$ST_SCRATCH/bin/gh" <<'STUB'
#!/usr/bin/env bash
sc="$(cd "$(dirname "$0")/.." && pwd)/canned"
printf '%s\n' "$*" >>"$sc/calls.log"
[[ "$1" == auth ]] && exit 0
kind=""
if [[ "$1" == run ]]; then kind=runs
elif [[ "$1" == api ]]; then
  case "$2" in
    */statuses) kind=statuses ;;
    *deployments\?*) kind=deployments ;;
  esac
fi
[[ -n "$kind" ]] || { echo "gh stub: unexpected call: $*" >&2; exit 99; }
filter="."
while [[ $# -gt 0 ]]; do [[ "$1" == --jq ]] && filter="$2"; shift; done
n=$(( $(cat "$sc/count.$kind" 2>/dev/null || echo 0) + 1 ))
echo "$n" >"$sc/count.$kind"
i=$n
while [[ $i -gt 0 && ! -f "$sc/$kind.$i.json" ]]; do i=$(( i - 1 )); done
body='[]'
[[ $i -gt 0 ]] && body=$(cat "$sc/$kind.$i.json")
[[ "$body" == ERR ]] && exit 1
printf '%s' "$body" | jq -r "$filter"
STUB
  chmod +x "$ST_SCRATCH/bin/gh"
}

st_reset() { rm -rf "$ST_SCRATCH/canned"; mkdir -p "$ST_SCRATCH/canned"; }

# st_runs <n> none|ERR|<status> [conclusion] — the n-th `gh run list` response for the scenario SHA,
# for the workflow named $ST_WF_NAME (default CI).
st_runs() {
  local body
  case "$2" in
    none) body='[]' ;;
    ERR) body=ERR ;;
    *) body=$(jq -cn --arg n "${ST_WF_NAME:-CI}" --arg sha "$ST_SHA" --arg s "$2" --arg c "${3:-}" \
      '[{name: $n, headSha: $sha, status: $s, conclusion: $c}]') ;;
  esac
  # Decoys the script's own jq filter must ignore: another workflow and another SHA, both green.
  if [[ "$body" != ERR ]]; then
    body=$(printf '%s' "$body" | jq -c --arg sha "$ST_SHA" \
      '. + [{"name":"Lint","headSha":$sha,"status":"completed","conclusion":"success"},{"name":"CI","headSha":"0000000000000000000000000000000000000000","status":"completed","conclusion":"success"}]')
  fi
  printf '%s' "$body" >"$ST_SCRATCH/canned/runs.$1.json"
}

# st_deploy none|ERR|<state> — a deployment record (+ its newest status) for the SHA.
st_deploy() {
  case "$1" in
    none) return 0 ;;
    ERR) printf 'ERR' >"$ST_SCRATCH/canned/deployments.1.json" ;;
    *)
      printf '[{"id":1}]' >"$ST_SCRATCH/canned/deployments.1.json"
      printf '[{"state":"%s"}]' "$1" >"$ST_SCRATCH/canned/statuses.1.json" ;;
  esac
}

# st_commit code|script|docs|lock|manifest|rename — a fresh branch off base with one commit; sets ST_SHA.
st_commit() {
  local f=""
  case "$1" in
    code) f=src/x.ts ;;
    script) f=scripts/y.sh ;;
    docs) f=docs/z.md ;;
    lock) f=package-lock.json ;;
    manifest) f=package.json ;;
  esac
  ST_N=$(( ${ST_N:-0} + 1 ))
  git -C "$ST_SCRATCH" checkout -q -B "sc$ST_N" "$ST_BASE"
  if [[ "$1" == rename ]]; then
    git -C "$ST_SCRATCH" mv src/r.ts docs/r.ts
  else
    mkdir -p "$ST_SCRATCH/$(dirname "$f")"
    echo "$ST_N" >"$ST_SCRATCH/$f"
    git -C "$ST_SCRATCH" add "$f"
  fi
  git -C "$ST_SCRATCH" commit -q -m "$1 $ST_N"
  ST_SHA=$(git -C "$ST_SCRATCH" rev-parse HEAD)
}

# st_cfg <file> <deployEnvironment-json> [workflows-json] — write a gates config (grace 2s, timeout 6s).
st_cfg() {
  local wfs='[{"name":"CI","file":"ci.yml"}]'
  [[ $# -ge 3 ]] && wfs=$3
  printf '{"workflows": %s, "deployEnvironment": %s, "timeoutSeconds": 6, "graceSeconds": 2}\n' "$wfs" "$2" >"$1"
}

# st_run <label> <want-rc> <grep -E pattern> <max-secs|-> [args…] — run the script under test with
# exactly the given args (no --repo default), in the scratch repo, with the stub `gh` on PATH.
# ST_ENV (space-free VAR=value words) and ST_PATH override the child's environment / PATH.
st_run() {
  local label=$1 want=$2 pat=$3 max=$4 out rc t0 secs
  shift 4
  t0=$(date +%s)
  rc=0
  # shellcheck disable=SC2086 # ST_ENV is a deliberate word list of VAR=value assignments
  out=$(cd "$ST_SCRATCH" && env CI_GATES_FILE="$ST_CFG" PATH="${ST_PATH:-$ST_SCRATCH/bin:$PATH}" ${ST_ENV:-} \
    "$BASH" "$ST_SELF" "$@" 2>&1) || rc=$?
  secs=$(( $(date +%s) - t0 ))
  if [[ $rc -ne $want ]] || ! grep -Eq -- "$pat" <<<"$out" || { [[ $max != - ]] && [[ $secs -ge $max ]]; }; then
    echo "FAIL $label: rc=$rc (want $want), ${secs}s (max ${max}), want /$pat/ in:"
    sed 's/^/    | /' <<<"$out"
    ST_FAILS="$ST_FAILS $label"
  else
    echo "ok   $label"
  fi
}

# st_exec <label> <want-rc> <pattern> <max-secs|-> [args…] — st_run on the scenario SHA, --repo o/r.
st_exec() {
  local label=$1 want=$2 pat=$3 max=$4
  shift 4
  st_run "$label" "$want" "$pat" "$max" "$ST_SHA" --repo o/r --interval 1 "$@"
}

# st_eq <label> <got> <want> — a plain assertion.
st_eq() {
  if [[ "$2" == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got '$2', want '$3'"; ST_FAILS="$ST_FAILS $1"; fi
}

# st_logged <label> <fixed string> — the stub `gh` was called with an argument line containing it.
st_logged() {
  if grep -qF -- "$2" "$ST_SCRATCH/canned/calls.log" 2>/dev/null; then echo "ok   $1"
  else echo "FAIL $1: no gh call containing '$2'"; ST_FAILS="$ST_FAILS $1"; fi
}

run_self_test() {
  # An inherited GIT_DIR/GIT_WORK_TREE/… (hook or wrapper shell) would redirect the scratch repo's git.
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY \
    SKIP_CI_VERIFY SKIP_CI_VERIFY_REASON CI_GATES_FILE SPRINT_MAIN_BRANCH
  if ! command -v jq >/dev/null 2>&1; then
    echo "SKIP: jq not installed — verify-ci.sh --self-test not run"
    exit 0
  fi
  ST_SELF="$SELF_DIR/$(basename "${BASH_SOURCE[0]}")"
  ST_SCRATCH=$(cd "$(mktemp -d)" && pwd -P)
  trap 'rm -rf "$ST_SCRATCH"' EXIT
  mkdir -p "$ST_SCRATCH/bin" "$ST_SCRATCH/cfg"
  st_stub
  st_reset
  git init -q "$ST_SCRATCH"
  git -C "$ST_SCRATCH" config user.email "selftest@example.com"
  git -C "$ST_SCRATCH" config user.name "verify-ci self-test"
  git -C "$ST_SCRATCH" config commit.gpgsign false
  mkdir -p "$ST_SCRATCH/docs" "$ST_SCRATCH/src" "$ST_SCRATCH/.github/workflows"
  echo base >"$ST_SCRATCH/docs/a.md"
  echo moved >"$ST_SCRATCH/src/r.ts"
  # The pull_request filter's docs/** must be ignored: only on.push.paths decides a push run.
  cat >"$ST_SCRATCH/.github/workflows/ci.yml" <<'WF'
name: CI
on:
  push:
    branches: [main]
    paths:
      - "src/**"
      - package.json   # exact file
  pull_request:
    paths:
      - "docs/**"
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: "true"
WF
  printf 'on:\n  push:\n    branches: [main]\n' >"$ST_SCRATCH/.github/workflows/nopaths.yml"
  printf 'on:\n  push:\n    paths:\n      - "**/*.ts"\n' >"$ST_SCRATCH/.github/workflows/unsupported.yml"
  git -C "$ST_SCRATCH" add -A
  git -C "$ST_SCRATCH" commit -q -m base
  ST_BASE=$(git -C "$ST_SCRATCH" rev-parse HEAD)

  local cfg_deploy="$ST_SCRATCH/cfg/deploy.json" cfg_nodeploy="$ST_SCRATCH/cfg/nodeploy.json"
  st_cfg "$cfg_deploy" '"production"'
  st_cfg "$cfg_nodeploy" null
  ST_CFG=$cfg_deploy

  # S1 — matching range, run + deploy never appear: fail closed after grace.
  st_commit code; st_reset
  st_runs 1 none   # only decoys (other workflow / other SHA) — the script's jq filter must not match them
  st_exec S1 2 'never appeared.*CI.*production. deploy' - --base "$ST_BASE"

  # S2 — run appears late, runs, then passes; deploy green.
  st_commit code; st_reset
  st_runs 1 none; st_runs 2 in_progress; st_runs 3 completed success; st_deploy success
  st_exec S2 0 'all required workflows green' - --base "$ST_BASE"

  # S3 — `gh run list` errors on every call: never "no run".
  st_commit code; st_reset
  st_runs 1 ERR
  st_exec S3 2 'gh run list failed' - --base "$ST_BASE"

  # S4 — docs-only range: nothing is expected, so no waiting out the grace window.
  st_commit docs; st_reset
  st_exec S4 0 'CI not expected.*' 2 --base "$ST_BASE"

  # S5 — non-matching code path: the workflow is N/A but the deploy is still expected.
  st_commit script; st_reset
  st_deploy success
  st_exec S5a 0 'CI not expected' - --base "$ST_BASE"
  st_reset
  st_exec S5b 2 'never appeared.*production. deploy' - --base "$ST_BASE"

  # S6 — red fails fast; a failed deploy fails fast.
  st_commit code; st_reset
  st_runs 1 completed failure; st_deploy success
  st_exec S6a 1 'RED' 2 --base "$ST_BASE"
  st_reset
  st_runs 1 in_progress; st_deploy failure
  st_exec S6b 1 'deploy FAILED' 2 --base "$ST_BASE"

  # S7 — no --base: range unknown, everything expected even for a docs-only commit.
  st_commit docs; st_reset
  st_exec S7 2 'never appeared' -

  # S8 — a run that never finishes ends at --timeout; the flag overrides the config value.
  st_commit code; st_reset
  st_runs 1 in_progress; st_deploy success
  st_exec S8 2 'timed out after 3s' - --base "$ST_BASE" --timeout 3

  # S9 — the pure helpers.
  local wf=ci.yml
  st_commit code;   st_eq "S9 code->yes"        "$(expects_run "$ST_SCRATCH" "$ST_BASE" "$ST_SHA" $wf)" yes
  st_eq "S9 deploy code->yes"                   "$(expects_deploy "$ST_SCRATCH" "$ST_BASE" "$ST_SHA")" yes
  st_eq "S9 no-base->yes"                       "$(expects_run "$ST_SCRATCH" "" "$ST_SHA" $wf)" yes
  st_eq "S9 bad-base->yes"                      "$(expects_run "$ST_SCRATCH" deadbeef "$ST_SHA" $wf)" yes
  st_eq "S9 missing-file->yes"                  "$(expects_run "$ST_SCRATCH" "$ST_BASE" "$ST_SHA" nope.yml)" yes
  st_commit script; st_eq "S9 scripts->no"      "$(expects_run "$ST_SCRATCH" "$ST_BASE" "$ST_SHA" $wf)" no
  st_eq "S9 deploy scripts->yes"                "$(expects_deploy "$ST_SCRATCH" "$ST_BASE" "$ST_SHA")" yes
  st_commit docs;   st_eq "S9 docs->no (pull_request paths ignored)" "$(expects_run "$ST_SCRATCH" "$ST_BASE" "$ST_SHA" $wf)" no
  st_eq "S9 deploy docs->no"                    "$(expects_deploy "$ST_SCRATCH" "$ST_BASE" "$ST_SHA")" no
  st_eq "S9 deploy no-base->yes"                "$(expects_deploy "$ST_SCRATCH" "" "$ST_SHA")" yes
  st_eq "S9 no-push.paths->yes"                 "$(expects_run "$ST_SCRATCH" "$ST_BASE" "$ST_SHA" nopaths.yml)" yes
  st_eq "S9 unsupported-pattern->yes"           "$(expects_run "$ST_SCRATCH" "$ST_BASE" "$ST_SHA" unsupported.yml)" yes
  st_commit manifest; st_eq "S9 exact-file->yes (comment + whitespace trimmed)" "$(expects_run "$ST_SCRATCH" "$ST_BASE" "$ST_SHA" $wf)" yes
  st_commit lock;   st_eq "S9 lockfile (not an exact match)->no" "$(expects_run "$ST_SCRATCH" "$ST_BASE" "$ST_SHA" $wf)" no
  # A move out of src/ into docs/: rename detection would list only docs/r.ts.
  st_commit rename; st_eq "S9 rename-out->yes"  "$(expects_run "$ST_SCRATCH" "$ST_BASE" "$ST_SHA" $wf)" yes
  st_eq "S9 deploy rename-out->yes"             "$(expects_deploy "$ST_SCRATCH" "$ST_BASE" "$ST_SHA")" yes

  # S10 — deployEnvironment null: the deployments API is never consulted (an erroring one would
  # read as "unavailable" -> exit 2), and the environment name is not required.
  ST_CFG=$cfg_nodeploy
  st_commit code; st_reset
  st_runs 1 completed success; st_deploy ERR
  st_exec S10 0 'all required workflows green' - --base "$ST_BASE"
  st_eq "S10 no deployments call" "$(grep -c deployments "$ST_SCRATCH/canned/calls.log")" 0
  # S10a — with no deploy configured, a missing expected run alone is still exit 2.
  st_reset
  st_runs 1 none
  st_exec S10a 2 'never appeared within 2s: CI ' - --base "$ST_BASE"
  # S10b — the deploy check URL-encodes the environment and passes -R and the main branch.
  ST_CFG=$cfg_deploy; st_reset
  st_runs 1 completed success; st_deploy success
  ST_ENV="SPRINT_MAIN_BRANCH=trunk" st_exec S10b 0 'green' - --base "$ST_BASE"
  st_logged "S10b -R + main branch" "run list -R o/r --branch trunk "
  st_logged "S10b environment query" "deployments?sha=$ST_SHA&environment=production"

  # S11 — SKIP_CI_VERIFY needs a reason.
  st_reset
  ST_ENV="SKIP_CI_VERIFY=1" st_exec S11a 1 'NO SKIP_CI_VERIFY_REASON' 2 --base "$ST_BASE"
  ST_ENV="SKIP_CI_VERIFY=1 SKIP_CI_VERIFY_REASON=offline-laptop" st_exec S11b 0 'Reason: offline-laptop' 2 --base "$ST_BASE"

  # S12 — config errors are exit 2 with a pointer to ci-gates.json, never a silent pass.
  ST_CFG="$ST_SCRATCH/cfg/absent.json" st_exec S12a 2 'ci-gates.json' 2 --base "$ST_BASE"
  st_cfg "$ST_SCRATCH/cfg/empty.json" null '[]'
  ST_CFG="$ST_SCRATCH/cfg/empty.json" st_exec S12b 2 'no workflows' 2 --base "$ST_BASE"
  printf '{"workflows":[{"name":"CI"}],"deployEnvironment":null}\n' >"$ST_SCRATCH/cfg/bad.json"
  ST_CFG="$ST_SCRATCH/cfg/bad.json" st_exec S12c 2 'invalid' 2 --base "$ST_BASE"
  printf '{"workflows":[{"name":"C\\tI","file":"ci.yml"}],"deployEnvironment":null}\n' >"$ST_SCRATCH/cfg/tab.json"
  ST_CFG="$ST_SCRATCH/cfg/tab.json" st_exec S12d 2 'invalid' 2 --base "$ST_BASE"

  # S13 — flags: a valueless or non-numeric flag is exit 2.
  st_run S13a 2 '--base needs a value' 2 "$ST_SHA" --repo o/r --base
  st_run S13b 2 'non-negative integer' 2 "$ST_SHA" --repo o/r --grace soon

  # S14 — owner/repo: derived from a github.com origin; underivable = exit 2.
  st_commit docs; st_reset
  st_run S14a 2 'cannot derive owner/repo' 2 "$ST_SHA" --interval 1 --base "$ST_BASE"
  git -C "$ST_SCRATCH" remote add origin git@github.com:acme/widget.git
  st_reset
  ST_CFG=$cfg_nodeploy st_run S14b 0 'acme/widget' 2 "$ST_SHA" --interval 1 --base "$ST_BASE"
  git -C "$ST_SCRATCH" remote remove origin

  # S15 — `gh` missing: exit 2 cleanly. A PATH holding only the tools the script needs, minus gh.
  mkdir -p "$ST_SCRATCH/nogh"
  local c
  for c in git jq awk sed grep tr date sleep dirname basename cat env; do
    ln -s "$(command -v "$c")" "$ST_SCRATCH/nogh/$c" 2>/dev/null
  done
  ST_PATH="$ST_SCRATCH/nogh" st_exec S15 2 "'gh' not installed" 2 --base "$ST_BASE"

  # S16 — a workflow name with a double quote and a backslash is matched literally: spliced raw
  # into the jq program it was a syntax error, read as ERR and retried until --timeout.
  ST_WF_NAME='Build "fast" \ lint'
  st_cfg "$ST_SCRATCH/cfg/quoted.json" null "$(jq -cn --arg n "$ST_WF_NAME" '[{name: $n, file: "ci.yml"}]')"
  st_commit code; st_reset
  st_runs 1 completed success
  ST_CFG="$ST_SCRATCH/cfg/quoted.json" st_exec S16 0 'all required workflows green' 4 --base "$ST_BASE"
  ST_WF_NAME=""

  [[ -z "$ST_FAILS" ]] || { echo "self-test FAILED:$ST_FAILS"; exit 1; }
  echo "self-test OK"
}

# --self-test is dispatched before any arg parsing, `gh` check or repo resolution.
if [[ "${1:-}" == "--self-test" ]]; then
  run_self_test
  exit 0
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo|--timeout|--interval|--grace|--base)
      [[ $# -ge 2 ]] || { echo "verify-ci.sh: $1 needs a value" >&2; exit 2; }
      case "$1" in
        --repo) REPO="$2" ;;
        --timeout) TIMEOUT="$2" ;;
        --interval) INTERVAL="$2" ;;
        --grace) GRACE="$2" ;;
        --base) BASE="$2" ;;
      esac
      shift 2 ;;
    -*) echo "verify-ci.sh: unknown flag $1" >&2; exit 2 ;;
    *) SHA="$1"; shift ;;
  esac
done
for v in "--timeout:$TIMEOUT" "--interval:$INTERVAL" "--grace:$GRACE"; do
  [[ -z "${v#*:}" || "${v#*:}" =~ ^[0-9]+$ ]] ||
    { echo "verify-ci.sh: ${v%%:*} must be a non-negative integer (got '${v#*:}')" >&2; exit 2; }
done

if [[ "${SKIP_CI_VERIFY:-0}" == 1 ]]; then
  if [[ -z "${SKIP_CI_VERIFY_REASON:-}" ]]; then
    echo "verify-ci: SKIP_CI_VERIFY=1 with NO SKIP_CI_VERIFY_REASON set — refusing to skip silently." >&2
    echo "verify-ci: an override is a visible decision, not an invisible one." >&2
    echo "verify-ci: Re-run with SKIP_CI_VERIFY_REASON=\"<why>\" set." >&2
    exit 1
  fi
  echo "verify-ci: SKIP_CI_VERIFY=1 — skipping the close-time CI check. Reason: ${SKIP_CI_VERIFY_REASON}. Poll 'gh run list' yourself before trusting the close." >&2
  exit 0
fi

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "verify-ci: not in a git repo" >&2; exit 2; }
[[ -n "$SHA" ]] || SHA=$(git -C "$ROOT" rev-parse HEAD)
# Normalize to the full 40-char SHA — `gh`'s headSha is always full, so a short SHA/ref would
# never match. Fall back to the raw value if git can't resolve it (startswith still handles it).
SHA=$(git -C "$ROOT" rev-parse --verify "${SHA}^{commit}" 2>/dev/null || printf '%s' "$SHA")

# --- config: which workflows (and which deploy environment) gate a clean close ------------------
CFG=${CI_GATES_FILE:-$SELF_DIR/ci-gates.json}
CFG_SHAPE='{ "workflows": [ { "name": "<workflow display name>", "file": "<file in .github/workflows/>" } ], "deployEnvironment": null, "timeoutSeconds": 1800, "graceSeconds": 300 }'
cfg_fail() {
  echo "verify-ci: $1" >&2
  echo "verify-ci:   create/fill scripts/sprint/ci-gates.json (or point CI_GATES_FILE at one) — shape:" >&2
  echo "verify-ci:   $CFG_SHAPE" >&2
  exit 2
}
command -v jq >/dev/null 2>&1 || { echo "verify-ci: 'jq' not installed — cannot read $CFG. Verify CI manually." >&2; exit 2; }
[[ -f "$CFG" ]] || cfg_fail "no CI gates config at $CFG — nothing to verify is not green."
jq -e '
  (.workflows | type == "array")
  and (.workflows | all(type == "object"
        and (.name | type == "string" and length > 0 and (test("[\\t\\n\\r]") | not))
        and (.file | type == "string" and length > 0 and (test("[\\t\\n\\r]") | not))))
  and (.deployEnvironment == null or (.deployEnvironment | type == "string" and length > 0))
  and ([.timeoutSeconds, .graceSeconds] | all(. == null or (type == "number" and . >= 0 and . == floor)))
' "$CFG" >/dev/null 2>&1 || cfg_fail "invalid CI gates config at $CFG."
REQUIRED_WORKFLOWS=()
REQUIRED_WORKFLOW_FILES=()   # index-aligned: the file whose on.push.paths decides if a push triggers it
# One value per line (the validator above rejects tabs/newlines) — not @tsv, which escapes a
# backslash in a name to `\\` so the name would never match its runs.
while IFS= read -r name && IFS= read -r file; do
  REQUIRED_WORKFLOWS+=("$name")
  REQUIRED_WORKFLOW_FILES+=("$file")
done < <(jq -r '.workflows[] | .name, .file' "$CFG")
[[ ${#REQUIRED_WORKFLOWS[@]} -gt 0 ]] || cfg_fail "no workflows listed in $CFG — nothing to verify is not green."
DEPLOY_ENV=$(jq -r '.deployEnvironment // empty' "$CFG")
[[ -n "$TIMEOUT" ]] || TIMEOUT=$(jq -r '.timeoutSeconds // 1800' "$CFG")
[[ -n "$GRACE" ]] || GRACE=$(jq -r '.graceSeconds // 300' "$CFG")
DEPLOY_LABEL="'$DEPLOY_ENV' deploy"
DEPLOY_ENV_Q=$(jq -rn --arg e "$DEPLOY_ENV" '$e | @uri')

if ! command -v gh >/dev/null 2>&1; then
  echo "verify-ci: 'gh' not installed — cannot verify CI for $SHA. Check it manually." >&2
  exit 2
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "verify-ci: 'gh' not authenticated — cannot verify CI for $SHA. Check it manually." >&2
  exit 2
fi

# Always an explicit -R: in a fork, gh's own default may resolve to the `upstream` remote.
if [[ -z "$REPO" ]]; then
  origin_url=$(git -C "$ROOT" remote get-url origin 2>/dev/null || echo "")
  if [[ "$origin_url" =~ github\.com[:/]+([^/]+)/([^/]+)$ ]]; then
    REPO="${BASH_REMATCH[1]}/${BASH_REMATCH[2]%.git}"
  fi
  if [[ ! "$REPO" =~ ^[^/[:space:]]+/[^/[:space:]]+$ ]]; then
    echo "verify-ci: cannot derive owner/repo from origin '${origin_url:-<none>}' — pass --repo <owner/name>." >&2
    exit 2
  fi
fi

echo "verify-ci: checking ${REQUIRED_WORKFLOWS[*]}${DEPLOY_ENV:+ + $DEPLOY_LABEL} for $REPO @ ${SHA:0:9} on $MAIN (timeout ${TIMEOUT}s)…" >&2

# Returns "status|conclusion" for the newest run of workflow $1 at $SHA, "" if none exists, or the
# sentinel "ERR" if `gh` itself failed (network / auth / rate limit) — an API error is never "no run".
run_state() {
  local json
  json=$(gh run list -R "$REPO" --branch "$MAIN" --limit 60 \
    --json name,headSha,status,conclusion 2>/dev/null) || { printf 'ERR'; return; }
  # Name and SHA go in via --arg, never spliced into the program: a `"` or `\` in a workflow
  # name made the filter a jq syntax error, read as ERR and retried until --timeout.
  jq -r --arg sha "$SHA" --arg name "$1" \
    '[.[] | select((.headSha|startswith($sha)) and .name==$name)] | .[0] | if . == null then "" else "\(.status)|\(.conclusion)" end' \
    <<<"$json" 2>/dev/null || printf 'ERR'
}

# Echoes the newest status state of the deployment GitHub has recorded for $SHA in $DEPLOY_ENV:
#   ""            no deployment exists for this SHA (yet) — a provider may create none for a skipped
#                 or cancelled build, or create it minutes after the push. The caller decides which
#                 via expects_deploy + GRACE.
#   "unknown"     the API call failed (network / auth / rate limit) — never treated as red or green.
#   otherwise     a GitHub deployment-status state: failure|error|success|pending|queued|
#                 in_progress|inactive.
deploy_state() {
  local id
  id=$(gh api "repos/$REPO/deployments?sha=$SHA&environment=$DEPLOY_ENV_Q" \
    --jq '.[0].id // empty' 2>/dev/null) || { printf 'unknown'; return; }
  [[ -n "$id" ]] || return 0
  gh api "repos/$REPO/deployments/$id/statuses" --jq '.[0].state // empty' 2>/dev/null ||
    printf 'unknown'
}

# Decide once, from the pushed range, whether each gate is expected at all. Unknown range = expected.
wf_expected=()
for i in "${!REQUIRED_WORKFLOWS[@]}"; do
  wf_expected[i]=$(expects_run "$ROOT" "$BASE" "$SHA" "${REQUIRED_WORKFLOW_FILES[i]}")
  [[ "${wf_expected[i]}" == no ]] &&
    echo "verify-ci: ${REQUIRED_WORKFLOWS[i]} not expected for this range (no changed path matches its push filter) — N/A" >&2
done
deploy_expected=no
if [[ -n "$DEPLOY_ENV" ]]; then
  deploy_expected=$(expects_deploy "$ROOT" "$BASE" "$SHA")
  [[ "$deploy_expected" == no ]] &&
    echo "verify-ci: $DEPLOY_LABEL not expected for this range (docs/.claude only) — N/A" >&2
fi

start=$(date +%s)

while true; do
  now=$(date +%s)
  elapsed=$(( now - start ))
  pending=0
  soft=0   # re-evaluated each poll from the latest run states, so a run that flips is not stale
  missing_wf=""
  missing_deploy=0

  for i in "${!REQUIRED_WORKFLOWS[@]}"; do
    wf="${REQUIRED_WORKFLOWS[i]}"
    state=$(run_state "$wf")
    status="${state%%|*}"
    conclusion="${state##*|}"

    if [[ "$state" == ERR ]]; then
      echo "verify-ci: ~ gh run list failed for $wf — retrying" >&2
      pending=1
      continue
    fi
    if [[ -z "$state" ]]; then
      # No run for this SHA. Provably-not-triggered ranges are N/A at once; otherwise the run may
      # just not be created yet (wait out GRACE), and after GRACE it is MISSING — never a pass.
      if [[ "${wf_expected[i]}" == no ]]; then continue; fi
      if [[ $elapsed -lt $GRACE ]]; then pending=1; else missing_wf="$missing_wf $wf"; fi
      continue
    fi
    if [[ "$status" != "completed" ]]; then pending=1; continue; fi

    case "$conclusion" in
      # skipped/neutral count as green: a workflow whose jobs were all skipped by their own
      # `if:` conditions concludes "skipped" — not-applicable, not a failure.
      success|skipped|neutral) : ;;
      failure|timed_out|startup_failure)
        # Fail FAST: a red conclusion is decisive — exit now rather than wait out a slower
        # workflow (or the deploy below); otherwise the timeout on the slowest pending item
        # would mask an already-red one as merely "inconclusive".
        echo "verify-ci: ✗ $wf = $conclusion — RED for ${SHA:0:9}. The close is NOT clean." >&2
        exit 1 ;;
      cancelled|"")
        echo "verify-ci: ~ $wf = ${conclusion:-unknown} (superseded?)" >&2; soft=1 ;;
      *) echo "verify-ci: ~ $wf = $conclusion (unrecognized)" >&2; soft=1 ;;
    esac
  done

  # The deploy, if configured — evaluated inside the same loop so a failed deploy exits fast rather
  # than waiting out a slow workflow, and a still-running deploy is waited for like a pending run.
  if [[ -n "$DEPLOY_ENV" ]]; then
    dstate=$(deploy_state)
    case "$dstate" in
      success) : ;;
      failure|error)
        echo "verify-ci: ✗ $DEPLOY_LABEL FAILED for ${SHA:0:9}. The close is NOT clean." >&2
        echo "verify-ci:   details: gh api \"repos/$REPO/deployments?sha=$SHA&environment=$DEPLOY_ENV_Q\"  ->  gh api repos/$REPO/deployments/<id>/statuses" >&2
        exit 1 ;;
      pending|queued|in_progress) pending=1 ;;
      "")
        # No deployment record yet — same shape as an absent workflow run above: N/A only when the
        # range is provably docs-only, else wait out GRACE and then count it MISSING.
        if [[ "$deploy_expected" == no ]]; then :
        elif [[ $elapsed -lt $GRACE ]]; then pending=1
        else missing_deploy=1; fi ;;
      inactive) : ;;                                        # superseded by a newer deploy — N/A
      unknown)
        echo "verify-ci: ~ $DEPLOY_LABEL state unavailable (gh api error)" >&2; soft=1 ;;
      *)
        echo "verify-ci: ~ $DEPLOY_LABEL = $dstate (unrecognized)" >&2; soft=1 ;;
    esac
  fi

  if [[ $pending -eq 0 ]]; then break; fi
  if [[ $elapsed -ge $TIMEOUT ]]; then
    echo "verify-ci: timed out after ${TIMEOUT}s waiting for CI to complete for ${SHA:0:9} — check 'gh run list' manually." >&2
    exit 2
  fi
  echo "verify-ci: waiting for CI (${elapsed}s elapsed)…" >&2
  sleep "$INTERVAL"
done

# An expected run/deploy that never appeared is NOT a pass.
if [[ -n "$missing_wf" || $missing_deploy -eq 1 ]]; then
  missing="${missing_wf# }"
  if [[ $missing_deploy -eq 1 ]]; then missing="${missing:+$missing, }$DEPLOY_LABEL"; fi
  echo "verify-ci: expected run/deploy never appeared within ${GRACE}s: $missing — NOT treated as a pass." >&2
  echo "verify-ci:   check: gh run list -R $REPO --branch $MAIN --limit 10${DEPLOY_ENV:+ ; gh api \"repos/$REPO/deployments?sha=$SHA\"}" >&2
  exit 2
fi

# All required workflows resolved and none were red (a red would have exited 1 above).
if [[ $soft -eq 1 ]]; then
  echo "verify-ci: inconclusive (a required workflow was cancelled/superseded, or the deploy state was unavailable). Re-check manually." >&2
  exit 2
fi
echo "verify-ci: ✓ all required workflows green${DEPLOY_ENV:+ + no failed $DEPLOY_LABEL} for ${SHA:0:9} ($REPO)." >&2
exit 0
