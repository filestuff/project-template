#!/usr/bin/env bash
# Regression: INDEX.md's hand-authored `(done/X.md)` links rot when archive
# rotation moves X to done/archive/ outside merge-sprint.sh's inline relink, and
# docs/TODOS.md can grow two rows with the same id — nothing noticed either.
# check-ledger-links.mjs validates both (fix mode relinks archived targets), and
# regen.mjs --check now fails on them. regen.mjs also exits 2 with a message
# (writing nothing) instead of crashing when a sprint carries an unknown claim token.
set -euo pipefail
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
TMP=$(cd "$TMP" && pwd -P)
fail=0
ok() { echo "  ok   $1"; }
bad() { echo "  FAIL $1" >&2; fail=1; }

# Run from a copy: the self-test only touches a temp dir, but running it from the
# template tree would let repoRoot() resolve to the template checkout.
R="$TMP/repo"
mkdir -p "$R/scripts/sprint" "$R/docs/sprints/"{backlog,in-progress,done/archive,rejected}
cp "$REPO_DIR"/full-overlay/scripts/sprint/*.mjs "$REPO_DIR/full-overlay/scripts/sprint/claims-tokens.json" "$R/scripts/sprint/"
cp "$REPO_DIR/full-overlay/docs/sprints/INDEX.md" "$REPO_DIR/full-overlay/docs/sprints/ROADMAP.md" "$R/docs/sprints/"
cp "$REPO_DIR/lite/docs/TODOS.md" "$R/docs/"
export SPRINT_ROOT="$R"
CLL="$R/scripts/sprint/check-ledger-links.mjs"
REGEN="$R/scripts/sprint/regen.mjs"

# 1. self-test
if out=$(node "$CLL" --self-test 2>&1) && grep -q "self-test OK" <<<"$out"; then ok "--self-test"; else bad "--self-test: $out"; fi

# 2. clean skeleton: --check exits 0; regen --check exits 0 after a regen
node "$REGEN" >/dev/null
if out=$(node "$CLL" --check 2>&1); then ok "--check clean skeleton exits 0"; else bad "--check clean skeleton: $out"; fi
if out=$(node "$REGEN" --check 2>&1); then ok "regen --check clean exits 0"; else bad "regen --check clean: $out"; fi

# 3. an archived target + a missing target + a duplicate TODOS id
printf -- '---\nsprint: S-1\nstatus: done\ngoal: g\nstory_points: 1\ndepends_on: []\n---\n\n# S-1\n' >"$R/docs/sprints/done/archive/S-1-old.md"
node "$REGEN" >/dev/null # the archived sprint shifts the generated totals; keep the drift check out of the way
printf '\n| [S-1](done/S-1-old.md) | x |\n| [S-2](done/S-2-gone.md) | y |\n' >>"$R/docs/sprints/INDEX.md"
printf '| 1 | duplicate | S-3 | z | open |\n' >>"$R/docs/TODOS.md"
set +e
out=$(node "$CLL" --check 2>&1); rc=$?
set -e
if [[ $rc -eq 2 ]] && grep -q 'needs rewrite: (done/S-1-old.md) -> (done/archive/S-1-old.md)' <<<"$out" &&
  grep -q 'unresolved link.*(done/S-2-gone.md)' <<<"$out" && grep -q 'duplicate TODOS ids: #1' <<<"$out"; then
  ok "--check exits 2 listing rewrite, unresolved link, duplicate id"
else bad "--check broken ledger (rc=$rc): $out"; fi
grep -q '(done/S-1-old.md)' "$R/docs/sprints/INDEX.md" && ok "--check wrote nothing" || bad "--check modified INDEX.md"

set +e
out=$(node "$REGEN" --check 2>&1); rc=$?
set -e
if [[ $rc -eq 2 ]] && grep -q 'LEDGER LINK' <<<"$out" && grep -q 'DUPLICATE TODOS ids in docs/TODOS.md: #1' <<<"$out"; then
  ok "regen --check exits 2 on ledger problems"
else bad "regen --check broken ledger (rc=$rc): $out"; fi

# 4. fix mode: relinks the archived target, still exits 2 for what it cannot fix
set +e
out=$(node "$CLL" 2>&1); rc=$?
set -e
if [[ $rc -eq 2 ]] && grep -q 'rewrote: (done/S-1-old.md)' <<<"$out" && grep -q '(done/archive/S-1-old.md)' "$R/docs/sprints/INDEX.md"; then
  ok "fix mode relinks archived target, exits 2 for the unfixable rest"
else bad "fix mode (rc=$rc): $out"; fi

# 5. once the human fixes the rest, both checks are clean
perl -ni -e 'print unless /S-2-gone|\| 1 \| duplicate/' "$R/docs/sprints/INDEX.md" "$R/docs/TODOS.md"
if out=$(node "$CLL" --check 2>&1); then ok "--check clean after fixes"; else bad "--check after fixes: $out"; fi
if out=$(node "$REGEN" --check 2>&1); then ok "regen --check clean after fixes"; else bad "regen --check after fixes: $out"; fi

# 6. unknown claim token: regen exits 2 with the message, writes nothing
cat >"$R/docs/sprints/backlog/S-4-x.md" <<'EOF'
---
sprint: S-4
status: backlog
goal: g
story_points: 1
depends_on: []
touches:
  - dpes
---

# S-4
EOF
before=$(cat "$R/docs/sprints/INDEX.md")
set +e
out=$(node "$REGEN" 2>&1); rc=$?
set -e
if [[ $rc -eq 2 ]] && grep -q 'cannot compute the wave schedule.*unknown claim token "dpes"' <<<"$out" && ! grep -q '    at ' <<<"$out"; then
  ok "regen exits 2 on an unknown token, no stack trace"
else bad "regen unknown token (rc=$rc): $out"; fi
[[ "$(cat "$R/docs/sprints/INDEX.md")" == "$before" ]] && ok "regen wrote nothing" || bad "regen modified INDEX.md despite the error"

exit "$fail"
