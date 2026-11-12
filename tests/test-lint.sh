#!/usr/bin/env bash
# Every script the template ships downstream must be Biome-clean (v1.15.1). Link-mode
# worktree gates lint the whole tree, scripts/ included, so one lint error in a shipped
# .mjs reddens every downstream sprint gate before a sprint writes a line.
#
# Config: biome.jsonc (rule set) + package.json (pinned versions). Needs `npm ci` once.
# Missing or mis-versioned tooling is a FAIL, never a silent pass.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "test-lint: FAIL — $*" >&2; exit 1; }

BIOME=node_modules/.bin/biome
[ -x "$BIOME" ] || fail "Biome is not installed. Run \`npm ci\` in the template root (pins in package.json)."
[ -f node_modules/ultracite/package.json ] || fail "ultracite is not installed. Run \`npm ci\` in the template root."

pin() { node -e 'const p=require("./package.json");console.log(p.devDependencies[process.argv[1]])' "$1"; }
have_biome=$("$BIOME" --version | sed -E 's/^Version: *//')
have_ultracite=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("node_modules/ultracite/package.json","utf8")).version)')
[ "$have_biome" = "$(pin @biomejs/biome)" ] || fail "Biome $have_biome installed, package.json pins $(pin @biomejs/biome). Run \`npm ci\`."
[ "$have_ultracite" = "$(pin ultracite)" ] || fail "ultracite $have_ultracite installed, package.json pins $(pin ultracite). Run \`npm ci\`."

# 1. The shipped tree is clean.
out=$("$BIOME" check --diagnostic-level=error --max-diagnostics=50 lite full-overlay 2>&1) || {
  echo "$out" >&2
  fail "Biome errors in shipped scripts (see above). Fix them; do not widen biome.jsonc's excludes."
}

# 2. Coverage: Biome must have checked every shipped .js/.mjs/.cjs/.json, apart from the
#    documented .claude/workflows exclusion. This stops a config edit from narrowing the check unnoticed.
want=$(git ls-files -- lite full-overlay | grep -E '\.(m?js|cjs|jsonc?)$' | grep -vc '/\.claude/workflows/' || true)
got=$(echo "$out" | sed -nE 's/^Checked ([0-9]+) files?.*/\1/p')
[ "$got" = "$want" ] || fail "Biome checked ${got:-?} files but ${want} shipped .js/.mjs/.cjs/.json files are tracked. Is biome.jsonc's files.includes too narrow?"

# 3. The check has teeth: a known violation in a shipped path must be an error.
if printf 'let x = 1;\nconsole.log(x);\n' |
  "$BIOME" check --diagnostic-level=error --stdin-file-path=lite/scripts/sprint/_lint-probe.mjs >/dev/null 2>&1; then
  fail "a never-reassigned \`let\` in lite/scripts passed the lint. The rule set has lost its teeth (did extends fail to load?)."
fi

echo "test-lint: ok — ${got} shipped files Biome-clean (biome ${have_biome}, ultracite ${have_ultracite})"
