#!/usr/bin/env bash
# migrations/v1.19.0.sh on scratch repos (lite and full): flat done/ + done/archive/ files
# move into done/<bucket>/, summaries are seeded from the hand-written INDEX Done rows (or
# ### Outcome), references are rewritten, the Done table becomes the generated block, the
# stacked header moves to INDEX-HISTORY.md, the checks come out clean, and a re-run
# (journal wiped) changes nothing.
set -euo pipefail
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
fail() { echo "FAIL: $*"; exit 1; }

sprint() { # sprint <dir> <id> <slug> [outcome-prose]
  local f="$R/docs/sprints/$1/$2-$3.md"
  printf -- '---\nsprint: %s\nstatus: done\ngoal: goal of %s\nshort: %s\nstory_points: 2\ndepends_on: []\nend_date: 2026-0%s-01\n---\n\n# %s: %s\n\n## Completion Log\n\n### Outcome\n\n%s\n' \
    "$2" "$2" "$3" "$(( 10#${2#S-} % 9 + 1 ))" "$2" "$3" "${4:-Shipped it. More detail.}" >"$f"
}

setup() { # setup <tier>
  R="$T/$1"
  mkdir -p "$R/scripts/sprint" "$R/docs/sprints/"{backlog,in-progress,done/archive,rejected} "$R/docs/proposals"
  cp "$REPO_DIR"/lite/scripts/sprint/{paths,ledger}.mjs "$R/scripts/sprint/"
  if [[ $1 == full ]]; then
    cp "$REPO_DIR"/full-overlay/scripts/sprint/*.mjs "$REPO_DIR/full-overlay/scripts/sprint/claims-tokens.json" "$R/scripts/sprint/"
    cp "$REPO_DIR/full-overlay/docs/sprints/ROADMAP.md" "$R/docs/sprints/"
    perl -0pi -e 's/^(_Last updated: [^\n]*\n)/$1\n_Previously: roadmap narrative that piled up._\n/m' "$R/docs/sprints/ROADMAP.md"
  fi
  touch "$R/docs/sprints/done/archive/.gitkeep"
  sprint done/archive S-001 first
  sprint done/archive S-099 ninety-nine
  sprint done/archive S-645 legacy-three-digit
  sprint done S-1384 latest "Outcome prose only. Second sentence."
  sprint done S-1385 piped
  cat >"$R/docs/sprints/INDEX.md" <<'EOF'
# Sprint Index

_Last updated: 2026-11-28 — newest header._

_Previously: Last updated: 2026-11-27 — older header._

_Previously: Last updated: 2026-11-26 — oldest header._

Board.

<!-- BEGIN GENERATED: totals -->
<!-- END GENERATED: totals -->

## In Progress

<!-- BEGIN GENERATED: in-progress -->
<!-- END GENERATED: in-progress -->

## Backlog

<!-- BEGIN GENERATED: backlog -->
<!-- END GENERATED: backlog -->

## Design Loop sessions

Project-specific section — must survive.

## Done

| Sprint | Goal | Pts | Completed | Outcome |
|--------|------|-----|-----------|---------|
| [S-1385](done/S-1385-piped.md) | piped | 2 | 2026-01-01 | Split a \| b cleanly (TODOS #12). |
| [S-645](done/archive/S-645-legacy-three-digit.md) | legacy | 2 | 2026-01-01 | Old one. |
| [S-099](done/archive/S-099-ninety-nine.md) | nn | 2 | 2026-01-01 | Ninety-nine. |
| [S-001](done/archive/S-001-first.md) | first | 2 | 2026-01-01 | First. |

## Rejected

_(none)_
EOF
  printf '# TODOS\n\n| # | Item |\n|---|---|\n| 1 | from [S-645](sprints/done/archive/S-645-legacy-three-digit.md) |\n' >"$R/docs/TODOS.md"
  printf 'Source: `docs/sprints/done/S-1384-latest.md` and docs/sprints/done/archive/S-001-first.md\n' >"$R/docs/proposals/001-x.md"
  git -C "$R" init -q -b main
  git -C "$R" config user.email t@example.com
  git -C "$R" config user.name t
  git -C "$R" add -A
  git -C "$R" commit -q -m base
}

migrate() {
  (cd "$R" && TEMPLATE_TIER=$TIER TEMPLATE_DIR="$REPO_DIR" REPO_ROOT="$R" JOURNAL_FILE="$R/.git/j" \
    bash "$REPO_DIR/migrations/v1.19.0.sh") >"$T/out" 2>&1 || { cat "$T/out"; fail "$TIER: migration exited non-zero"; }
}

ran=0
for TIER in lite full; do
  setup "$TIER"
  migrate
  D="$R/docs/sprints/done"
  for f in 0000-0099/S-001-first.md 0000-0099/S-099-ninety-nine.md 0600-0699/S-645-legacy-three-digit.md 1300-1399/S-1384-latest.md 1300-1399/S-1385-piped.md; do
    [[ -f "$D/$f" ]] || fail "$TIER: $f not at its bucket home"
  done
  [[ ! -e "$D/archive" ]] || fail "$TIER: done/archive/ should be gone"
  ls "$D" | grep -q '^S-' && fail "$TIER: sprint files left in flat done/"
  git -C "$R" diff --cached --name-status | grep -q '^R.*S-001-first.md' || fail "$TIER: move not staged as a rename"

  grep -qxF 'summary: "Split a | b cleanly (TODOS #12)."' "$D/1300-1399/S-1385-piped.md" || fail "$TIER: summary from the INDEX row (escaped pipe, #) not seeded"
  grep -qxF 'summary: "Outcome prose only."' "$D/1300-1399/S-1384-latest.md" || fail "$TIER: summary from ### Outcome not seeded"

  grep -q '(sprints/done/0600-0699/S-645-legacy-three-digit.md)' "$R/docs/TODOS.md" || fail "$TIER: TODOS link not rewritten"
  grep -q 'docs/sprints/done/1300-1399/S-1384-latest.md' "$R/docs/proposals/001-x.md" || fail "$TIER: proposal reference not rewritten"
  grep -q 'docs/sprints/done/0000-0099/S-001-first.md' "$R/docs/proposals/001-x.md" || fail "$TIER: archive reference not rewritten"

  I="$R/docs/sprints/INDEX.md"
  [[ $(grep -c '^_Last updated' "$I") -eq 1 ]] || fail "$TIER: INDEX should keep one _Last updated line"
  grep -q '^_Previously' "$I" && fail "$TIER: _Previously lines left in INDEX"
  [[ $(grep -c '^_Previously' "$R/docs/sprints/INDEX-HISTORY.md") -eq 2 ]] || fail "$TIER: header history not moved"
  grep -q 'Project-specific section — must survive.' "$I" || fail "$TIER: project-specific section lost"
  if [[ $TIER == full ]]; then
    grep -q '^_Previously' "$R/docs/sprints/ROADMAP.md" && fail "full: _Previously left in ROADMAP"
    grep -qF '_Previously: roadmap narrative that piled up._' "$R/docs/sprints/ROADMAP-HISTORY.md" || fail "full: ROADMAP header history not moved verbatim"
  fi
  grep -q '<!-- BEGIN GENERATED: recent-done -->' "$I" || fail "$TIER: recent-done markers missing"
  grep -q '| \[S-1385\](done/1300-1399/S-1385-piped.md) | piped | 2 |' "$I" || fail "$TIER: recent-done row missing"
  grep -q 'Split a \\| b cleanly' "$I" || fail "$TIER: pipe not escaped in the generated row"
  grep -q '\[S-001\](S-001-first.md)' "$D/0000-0099/LEDGER.md" || fail "$TIER: bucket LEDGER.md missing its row"
  git -C "$R" diff --cached --name-only | grep -q 'done/0000-0099/LEDGER.md' || fail "$TIER: LEDGER.md not staged"

  if [[ $TIER == full ]]; then
    (cd "$R" && SPRINT_ROOT="$R" node scripts/sprint/regen.mjs --check) || fail "full: regen --check not clean after migration"
  else
    node "$R/scripts/sprint/ledger.mjs" --root "$R" --check || fail "lite: ledger --check not clean after migration"
  fi

  # re-run with the journal wiped: every step must be a no-op
  git -C "$R" add -A
  git -C "$R" commit -q -m migrated
  rm -f "$R/.git/j"
  migrate
  [[ -z $(git -C "$R" status --porcelain) ]] || { git -C "$R" status --porcelain; fail "$TIER: re-run changed files"; }
  echo "ok $TIER"
  ran=$((ran + 1))
done
[[ $ran -eq 2 ]] || fail "only $ran of 2 tiers ran"
echo "PASS test-migration-v1.19.0"
