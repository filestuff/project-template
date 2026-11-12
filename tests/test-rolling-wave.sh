#!/usr/bin/env bash
# Rolling-wave admission: `claims.mjs ready` (what can start right now) and
# `reserve-wave.sh --add` (new members join an EXISTING wave instead of minting one).
# Fixture repo as in test-merge-sprint-land.sh; every reserve uses --no-push (no origin).
# Also pins the pre-existing reserve / --drop / --release modes, since --add reshaped
# the script they share. A malformed wave id for --add is exit 1 (usage error);
# an unknown but well-formed one is exit 2.
set -euo pipefail
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
TMP=$(cd "$TMP" && pwd -P)
R="$TMP/repo"

# --- fixture: a full-tier install with an (initially empty) ledger -------------
mkdir -p "$R/scripts/sprint" "$R/docs/sprints/"{backlog,in-progress,done/archive,rejected}
cp "$REPO_DIR"/full-overlay/scripts/sprint/*.sh "$REPO_DIR"/full-overlay/scripts/sprint/*.mjs "$REPO_DIR"/full-overlay/scripts/sprint/claims-tokens.json "$R/scripts/sprint/"
cp "$REPO_DIR/lite/scripts/sprint/close-check.mjs" "$R/scripts/sprint/"
cp "$REPO_DIR/full-overlay/docs/sprints/INDEX.md" "$REPO_DIR/full-overlay/docs/sprints/ROADMAP.md" "$R/docs/sprints/"
cp "$REPO_DIR/lite/docs/DOC_HEALTH.md" "$R/docs/"
chmod +x "$R"/scripts/sprint/*.sh

# sprint_file DIR ID KEBAB "deps,csv" "touches,csv" POINTS [extra frontmatter lines…]
sprint_file() {
  local dir=$1 id=$2 kebab=$3 deps=$4 touches=$5 pts=$6
  shift 6
  local f="$R/docs/sprints/$dir/$id-$kebab.md" status=$dir t
  [[ $dir == done/archive ]] && status=done
  {
    echo "---"
    echo "sprint: $id"
    echo "status: $status"
    echo "goal: g"
    echo "short: $kebab"
    echo "depends_on: [${deps//,/, }]"
    echo "blocks: []"
    echo "tags: []"
    echo "story_points: $pts"
    for extra in "$@"; do echo "$extra"; done
    if [[ -z $touches ]]; then
      echo "touches: []"
    else
      echo "touches:"
      local IFS=,
      for t in $touches; do echo "  - $t"; done
    fi
    echo "---"
    echo
    echo "# $id: $kebab"
  } >"$f"
}
reset_ledger() { rm -f "$R"/docs/sprints/{backlog,in-progress,done,done/archive,rejected}/S-*.md; }

cd "$R"
git init -q && git branch -M main
printf '.claude/\n' >.gitignore
git config user.email t@t && git config user.name t
git add -A && git commit -qm "init ledger"

CL="$R/scripts/sprint/claims.mjs"
RW="$R/scripts/sprint/reserve-wave.sh"
LOCK="$R/scripts/sprint/lock.sh"

OUT="" CODE=0
run() { set +e; OUT=$("$@" 2>&1); CODE=$?; set -e; }
fail() { echo "$1"; echo "$OUT"; exit 1; }
want_code() { [[ $CODE -eq $1 ]] || fail "$2: expected exit $1, got $CODE:"; }
want_line() { printf '%s\n' "$OUT" | grep -qxF -- "$1" || fail "missing line: $1"; }
want_text() { printf '%s\n' "$OUT" | grep -qF -- "$1" || fail "missing text: $1"; }
lock_free() { [[ $(bash "$LOCK" status) == FREE ]] || { echo "$1: lock still held:"; bash "$LOCK" status; exit 1; }; }
tree_clean() { [[ -z $(git status --porcelain) ]] || { echo "$1: tree not clean:"; git status --porcelain; exit 1; }; }

# ============================ claims.mjs ready ==================================
reset_ledger
W_A=W-20260901-aaaa W_B=W-20260901-bbbb
sprint_file done      S-001 landed-one   ""      src/z1.txt 1 "end_date: 2026-08-01"
sprint_file done/archive S-002 landed-two ""     src/z2.txt 1 "end_date: 2026-08-15"
sprint_file done      S-003 landed-late  ""      src/z3.txt 1 "end_date: 2026-10-01"
sprint_file in-progress S-010 flying     ""      src/flight.txt 2
sprint_file rejected  S-050 nope         ""      src/nope.txt 1
sprint_file backlog S-020 alpha   "S-001,S-002" src/a.txt 3 "risk: high" "tier: deep" "plan_date: 2026-09-01"
sprint_file backlog S-021 beta    "S-003"       "src/b/**" 2 "plan_date: 2026-09-01"
sprint_file backlog S-022 gamma   ""            src/c.txt 1
sprint_file backlog S-030 needs-backlog "S-040" src/g30.txt 1
sprint_file backlog S-031 needs-flying  "S-010" src/g31.txt 1
sprint_file backlog S-032 needs-rejected "S-050" src/g32.txt 1
sprint_file backlog S-033 needs-missing "S-099" src/g33.txt 1
sprint_file backlog S-034 no-claims     ""      "" 1
sprint_file backlog S-035 reserved-a    ""      src/d.txt 1 "wave: $W_A"
sprint_file backlog S-036 hits-flight   ""      src/flight.txt 1
sprint_file backlog S-037 hits-reserved ""      src/d.txt 1
sprint_file backlog S-038 hits-ready    ""      src/a.txt 1
sprint_file backlog S-039 reserved-b    ""      src/f.txt 1 "wave: $W_B"
sprint_file backlog S-040 delta         ""      src/e.txt 1
sprint_file backlog S-041 hits-b        ""      src/f.txt 1

run node "$CL" ready
want_code 0 "ready"
want_line "S-020  3pt  high/deep  fresh  alpha"
want_line "S-021  2pt  low/standard  stale  beta"
want_line "S-022  1pt  low/standard  unplanned  gamma"
want_line "S-040  1pt  low/standard  unplanned  delta"
want_line "blocked: S-030 — depends on S-040 (backlog)"
want_line "blocked: S-031 — depends on S-010 (in-progress)"
want_line "blocked: S-032 — depends on S-050 (rejected)"
want_line "blocked: S-033 — depends on S-099 (missing)"
want_line "blocked: S-034 — no claims"
want_line "blocked: S-035 — reserved by $W_A"
want_line "blocked: S-036 — claims overlap S-010 (in flight)"
want_line "blocked: S-037 — claims overlap S-035 (reserved $W_A)"
want_line "blocked: S-038 — claims overlap S-020 (ready ahead of it)"
want_line "blocked: S-039 — reserved by $W_B"
want_line "blocked: S-041 — claims overlap S-039 (reserved $W_B)"
want_line "SUMMARY ready: 4 startable, 11 blocked"
printf '%s\n' "$OUT" | grep -q '^S-0[0-9][0-9]  ' && [[ $(printf '%s\n' "$OUT" | grep -c '^S-0[0-9][0-9]  ') -eq 4 ]] || fail "expected exactly 4 ready lines"

# --wave: that wave's own members become ready; another wave's stay blocked.
run node "$CL" ready --wave "$W_A"
want_code 0 "ready --wave"
want_line "S-035  1pt  low/standard  unplanned  reserved-a"
want_line "blocked: S-037 — claims overlap S-035 (ready ahead of it)"
want_line "blocked: S-039 — reserved by $W_B"
want_line "blocked: S-041 — claims overlap S-039 (reserved $W_B)"
want_line "SUMMARY ready: 5 startable, 10 blocked"
printf '%s\n' "$OUT" | grep -q "S-035 — reserved" && fail "own-wave member still blocked"

# --json shape
run node "$CL" ready --json
want_code 0 "ready --json"
printf '%s' "$OUT" | node -e '
const j = JSON.parse(require("fs").readFileSync(0, "utf8")), assert = require("assert");
assert.deepStrictEqual(Object.keys(j), ["ready", "blocked"]);
assert.deepStrictEqual(j.ready.map((r) => r.sprint), ["S-020", "S-021", "S-022", "S-040"]);
const r = j.ready[0];
assert.deepStrictEqual(Object.keys(r).sort(), ["file", "plan", "risk", "sprint", "story_points", "tier", "touches", "wave"]);
assert.strictEqual(r.file, "docs/sprints/backlog/S-020-alpha.md");
assert.strictEqual(r.plan, "fresh"); assert.strictEqual(r.risk, "high"); assert.strictEqual(r.tier, "deep");
assert.strictEqual(r.story_points, 3); assert.strictEqual(r.wave, null);
assert.deepStrictEqual(r.touches, ["src/a.txt"]);
assert.strictEqual(j.ready[1].plan, "stale"); assert.strictEqual(j.ready[2].plan, "unplanned");
assert.strictEqual(j.ready[2].risk, "low"); assert.strictEqual(j.ready[2].tier, "standard");
assert.strictEqual(j.blocked.length, 11);
assert.deepStrictEqual(j.blocked[0], { sprint: "S-030", reason: "depends on S-040 (backlog)" });
' || fail "--json shape wrong:"
run node "$CL" ready --json --wave "$W_A"
printf '%s' "$OUT" | node -e '
const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
const m = j.ready.find((r) => r.sprint === "S-035");
if (!m || m.wave !== process.argv[1]) process.exit(1);' "$W_A" || fail "--json: reserved member should carry its wave:"

# computeReady is importable and pure
node --input-type=module -e '
import { computeReady } from "'"$CL"'";
import assert from "node:assert";
const { ready, blocked } = computeReady([
  { sprint: "S-001", dir: "backlog", touches: ["a"], depends_on: [] },
  { sprint: "S-002", dir: "backlog", touches: ["a"], depends_on: [] },
], undefined);
assert.deepStrictEqual(ready.map((s) => s.sprint), ["S-001"]);
assert.deepStrictEqual(blocked, [{ sprint: "S-002", reason: "claims overlap S-001 (ready ahead of it)" }]);
' || { echo "computeReady unit check failed"; exit 1; }

# usage errors are exit 1
run node "$CL" ready --bogus
want_code 1 "ready --bogus"
run node "$CL" ready --wave
want_code 1 "ready --wave (no value)"

# empty backlog is not an error
reset_ledger
run node "$CL" ready
want_code 0 "ready on an empty backlog"
want_line "SUMMARY ready: 0 startable, 0 blocked"
run node "$CL" ready --json
[[ $(printf '%s' "$OUT" | tr -d ' \n') == '{"ready":[],"blocked":[]}' ]] || fail "empty --json wrong:"

# ============================ reserve-wave.sh ===================================
reset_ledger
sprint_file backlog S-101 one   "" src/one.txt 1
sprint_file backlog S-102 two   "" src/two.txt 1
sprint_file backlog S-103 clash "" src/one.txt 1
sprint_file backlog S-104 four  "" src/four.txt 1
sprint_file backlog S-105 five  "" src/five.txt 1
sprint_file backlog S-106 six   "" src/six.txt 1
sprint_file backlog S-107 seven "" src/seven.txt 1
git add -A && git commit -qm "seed backlog"

wave_field() { node "$R/scripts/sprint/frontmatter.mjs" get "$R/docs/sprints/backlog/$1" wave; }

# plain reserve still works
run bash "$RW" S-101 --no-push
want_code 0 "plain reserve"
W1=$(printf '%s\n' "$OUT" | sed -n 's/^wave id: //p')
[[ $W1 =~ ^W-[0-9]{8}-[0-9a-f]{4}$ ]] || fail "reserve did not print a well-formed wave id:"
[[ $(wave_field S-101-one.md) == "\"$W1\"" ]] || fail "S-101 not reserved by $W1"
want_text "pre_wave_sha: "
git log -1 --format=%s | grep -qF "sprint: reserve wave $W1 — S-101 [skip ci]" || fail "reserve subject wrong"
git log -1 --format=%B | grep -q '^pre_wave_sha: ' || fail "reserve commit lost its pre_wave_sha trailer"
lock_free "reserve"; tree_clean "reserve"

HEAD1=$(git rev-parse HEAD)

# unknown but well-formed wave -> exit 2, nothing touched
run bash "$RW" --add W-20990101-ffff S-102 --no-push
want_code 2 "--add unknown wave"
want_text "unknown wave W-20990101-ffff"
[[ $(git rev-parse HEAD) == "$HEAD1" ]] || fail "HEAD moved on an unknown wave"
tree_clean "unknown wave"; lock_free "unknown wave"
[[ $(wave_field S-102-two.md) == null ]] || fail "S-102 was marked despite an unknown wave"

# the wave must appear in a commit SUBJECT: a mention in a body does not make it exist
git commit -q --allow-empty -m "docs: unrelated note" -m "sprint: reserve wave W-20991231-abcd — S-999 [skip ci]"
HEAD1=$(git rev-parse HEAD)
run bash "$RW" --add W-20991231-abcd S-102 --no-push
want_code 2 "--add wave known only from a commit body"
want_text "unknown wave W-20991231-abcd"
[[ $(git rev-parse HEAD) == "$HEAD1" ]] || fail "HEAD moved"
lock_free "body-only wave"

# malformed ids -> exit 1 with a message; no lock taken
for bad in W-1 W-20260901-ZZZZ w-20260901-abcd S-102; do
  run bash "$RW" --add "$bad" S-102 --no-push
  want_code 1 "--add malformed id '$bad'"
  want_text "not a wave id"
done
run bash "$RW" --add "$W1" --no-push
want_code 1 "--add with no sprints"
run bash "$RW" --add
want_code 1 "--add with no args"
lock_free "malformed"

# overlapping an existing member -> exit 2 and a clean rollback
run bash "$RW" --add "$W1" S-103 --no-push
want_code 2 "--add overlapping an existing member"
want_text "claims overlap"
[[ $(git rev-parse HEAD) == "$HEAD1" ]] || fail "HEAD moved on overlap"
tree_clean "overlap"; lock_free "overlap"
[[ $(wave_field S-103-clash.md) == null ]] || fail "S-103 still marked after rollback"

# overlap between two NEW members in one call -> exit 2, rolled back
sprint_file backlog S-108 eight "" src/seven.txt 1
git add -A && git commit -qm "seed S-108"
HEAD1=$(git rev-parse HEAD)
run bash "$RW" --add "$W1" S-107 S-108 --no-push
want_code 2 "--add with two overlapping new members"
tree_clean "mutual overlap"; [[ $(git rev-parse HEAD) == "$HEAD1" ]] || fail "HEAD moved"
lock_free "mutual overlap"

# missing / already-started member -> exit 2
run bash "$RW" --add "$W1" S-999 --no-push
want_code 2 "--add missing member"
tree_clean "missing member"; lock_free "missing member"

# the happy path
run bash "$RW" --add "$W1" S-102 --no-push
want_code 0 "--add S-102"
SHA=$(git rev-parse HEAD)
want_line "added to wave $W1: S-102 on main at $SHA"
[[ $(wave_field S-102-two.md) == "\"$W1\"" ]] || fail "S-102 frontmatter lacks the wave"
[[ $(git log -1 --format=%s) == "sprint: add S-102 to wave $W1 [skip ci]" ]] || fail "add commit subject wrong: $(git log -1 --format=%s)"
git log -1 --format=%B | grep -q 'pre_wave_sha' && fail "--add must not mint a new pre_wave_sha"
git log -1 --name-only --format= | grep -qx 'docs/sprints/backlog/S-102-two.md' || fail "commit lacks S-102's file"
tree_clean "--add"; lock_free "--add"
node "$R/scripts/sprint/regen.mjs" --check >/dev/null || fail "INDEX/ROADMAP not regenerated by --add"
[[ $(git log --format=%B --grep="^sprint: reserve wave $W1 " | grep -c '^pre_wave_sha: ') -eq 1 ]] || fail "the original reservation commit lost its pre_wave_sha"

# same wave again -> "already in", other wave -> "already reserved by"
run bash "$RW" --add "$W1" S-102 --no-push
want_code 2 "--add member twice"
want_text "S-102 is already in $W1"
run bash "$RW" --add "$W1" S-101 --no-push
want_code 2 "--add original member"
want_text "already in $W1"
tree_clean "twice"; lock_free "twice"
run bash "$RW" S-106 --no-push
want_code 0 "second wave reserve"
W2=$(printf '%s\n' "$OUT" | sed -n 's/^wave id: //p')
run bash "$RW" --add "$W1" S-106 --no-push
want_code 2 "--add a member reserved by another wave"
want_text "already reserved by $W2"
tree_clean "other wave"; lock_free "other wave"
# the same sprint twice in one call
run bash "$RW" --add "$W1" S-104 S-104 --no-push
want_code 2 "--add duplicate arg"
tree_clean "dup"; lock_free "dup"

# several at once, one commit
run bash "$RW" --add "$W1" S-104 S-105 --no-push
want_code 0 "--add two"
[[ $(git log -1 --format=%s) == "sprint: add S-104,S-105 to wave $W1 [skip ci]" ]] || fail "multi-add subject wrong: $(git log -1 --format=%s)"
want_line "added to wave $W1: S-104 S-105 on main at $(git rev-parse HEAD)"
tree_clean "--add two"; lock_free "--add two"

# the new members now show up as the wave's own in `ready --wave` (and are blocked without it)
run node "$CL" ready --wave "$W1"
want_line "S-104  1pt  low/standard  unplanned  four"
run node "$CL" ready
want_line "blocked: S-104 — reserved by $W1"

# existing --drop / --release still behave
run bash "$RW" --drop "$W1" S-105 --no-push
want_code 0 "--drop"
[[ $(wave_field S-105-five.md) == null ]] || fail "--drop did not clear the wave"
[[ $(git log -1 --format=%s) == "sprint: drop S-105 from wave $W1 [skip ci]" ]] || fail "drop subject wrong"
tree_clean "--drop"; lock_free "--drop"
run bash "$RW" --release "$W1" --no-push
want_code 0 "--release"
want_text "released wave $W1 (3 member(s))"
for f in S-101-one S-102-two S-104-four; do
  [[ $(wave_field "$f.md") == null ]] || fail "--release left $f reserved"
done
[[ $(wave_field S-106-six.md) == "\"$W2\"" ]] || fail "--release touched another wave's member"
tree_clean "--release"; lock_free "--release"
run bash "$RW" --release "$W1" --no-push
want_code 2 "--release of an empty wave"
lock_free "empty release"

# a fresh acquire succeeds immediately after all of the above
tok=$(bash "$LOCK" acquire final --wait 1) || { echo "lock not acquirable"; exit 1; }
bash "$LOCK" release "$tok"

# no template-renderer placeholders in what we ship
if grep -nE '\{\{[^}]*\}\}' "$REPO_DIR"/full-overlay/scripts/sprint/{reserve-wave.sh,claims.mjs}; then
  echo "template placeholder syntax found in a shipped script"; exit 1
fi

# --- start.sh: a sprint with no claims never starts — wave member or solo ------------
# reserve-wave.sh accepts a member with empty `touches:` (the planning pass fills it in
# afterwards), and every claim check passes an empty manifest as "nothing to check". The
# backstop is start.sh: it refuses to start an unclaimed sprint. Pin that — the edit-time
# guard and the land-time claims check both rely on it.
reset_ledger
git add -A && git commit -qm "reset for start guard" >/dev/null 2>&1 || true
sprint_file backlog S-070 unclaimed "" "" 1 "plan_date: 2026-09-01"
sprint_file backlog S-071 claimed   "" src/claimed.txt 1 "plan_date: 2026-09-01"
git add -A && git commit -qm "two backlog sprints"
ST="$R/scripts/sprint/start.sh"
H=$(git rev-parse HEAD)
for wave_args in "--wave W-20261112-ab12" ""; do
  # shellcheck disable=SC2086 # the optional flag pair must word-split
  set +e; out=$(bash "$ST" S-070 $wave_args --no-push 2>&1); code=$?; set -e
  [[ $code -ne 0 ]] || { echo "start.sh ${wave_args:-(solo)} on a sprint with no touches must refuse:"; echo "$out"; exit 1; }
  echo "$out" | grep -q 'no claims' || { echo "refusal did not say why:"; echo "$out"; exit 1; }
  [[ $(git rev-parse HEAD) == "$H" && -z $(git status --porcelain) && -f docs/sprints/backlog/S-070-unclaimed.md ]] || { echo "refused start left the ledger changed"; exit 1; }
  bash "$R/scripts/sprint/lock.sh" status | grep -q FREE || { echo "lock held after a refused start"; exit 1; }
done
set +e; out=$(bash "$ST" S-071 --wave W-20261112-ab12 --no-push 2>&1); code=$?; set -e
[[ $code -eq 0 && -f docs/sprints/in-progress/S-071-claimed.md ]] || { echo "a claimed sprint should start, got $code:"; echo "$out"; exit 1; }

echo "rolling wave: all checks passed"
