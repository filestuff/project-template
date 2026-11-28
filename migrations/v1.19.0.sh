#!/usr/bin/env bash
# v1.19.0 — finished sprints get a permanent home, one folder per hundred ids
# (docs/sprints/done/<bucket>/), and the Done ledger is generated from each file's
# `summary:` frontmatter. Both tiers.
#
# Steps (journaled; each one is also idempotent on its own):
#   move       git mv done/S-*.md and done/archive/S-*.md into done/<bucket>/
#   summaries  seed `summary:` from the file's INDEX Done row, else its ### Outcome
#   relink     rewrite done/[archive/]S-….md references across docs/**/*.md
#   index      INDEX.md: hand-written Done table → generated block; stacked
#              `_Previously` header lines in INDEX.md / ROADMAP.md →
#              docs/sprints/INDEX-HISTORY.md / ROADMAP-HISTORY.md
#   regen      write the generated blocks and every done/<bucket>/LEDGER.md
#   stage      git add what the steps changed, for the upgrade commit
set -euo pipefail

case "${TEMPLATE_TIER:-}" in
lite | full) ;;
*) echo "v1.19.0: unknown TEMPLATE_TIER '${TEMPLATE_TIER:-}' — nothing to do"; exit 0 ;;
esac
cd "${REPO_ROOT:-$(git rev-parse --show-toplevel)}"
[ -d docs/sprints ] || { echo "v1.19.0: no docs/sprints/ — nothing to migrate"; exit 0; }

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
JOURNAL_FILE=${JOURNAL_FILE:-$(git rev-parse --git-dir)/template-update/migrations/v1.19.0.journal}
mkdir -p "$(dirname "$JOURNAL_FILE")"
step() { # step <name> <command…>
  local name=$1
  shift
  grep -qxF "$name" "$JOURNAL_FILE" 2>/dev/null && { echo "$name: done earlier — skipped"; return 0; }
  "$@"
  echo "$name" >>"$JOURNAL_FILE"
}

# The file-level pass installed the new scripts already; fall back to the template tree.
script() {
  if [ -f "scripts/sprint/$1" ]; then echo "scripts/sprint/$1"; else echo "${TEMPLATE_DIR:?}/lite/scripts/sprint/$1"; fi
}

regen() {
  if [ "$TEMPLATE_TIER" = full ] && [ -f scripts/sprint/regen.mjs ]; then
    node scripts/sprint/regen.mjs
    node scripts/sprint/check-ledger-links.mjs || true # fix mode; leftovers are reported, not fatal
  else
    node "$(script ledger.mjs)" --root "$PWD" || [ $? -eq 2 ] # 2 = problems reported, blocks written
  fi
}

stage() {
  git add -A -- docs/sprints/done
  for f in docs/sprints/{INDEX,ROADMAP}.md docs/sprints/{INDEX,ROADMAP}-HISTORY.md; do [ -f "$f" ] && git add -- "$f"; done
  git add -u -- docs
  for f in CLAUDE.md README.md; do [ -f "$f" ] && git add -u -- "$f"; done
  return 0
}

step move node "$HERE/v1.19.0.mjs" move
step summaries node "$HERE/v1.19.0.mjs" summaries
step relink node "$HERE/v1.19.0.mjs" relink
step index node "$HERE/v1.19.0.mjs" index
step regen regen
step stage stage

echo "v1.19.0: done — finished sprints live in docs/sprints/done/<bucket>/; the Done ledger is generated."
echo "  Check: node $(script ledger.mjs) --check   (full tier: node scripts/sprint/regen.mjs --check)"
