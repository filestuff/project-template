#!/usr/bin/env bash
# The commit gate — the SINGLE source of truth for what must pass before every
# deliverable commit. PROTOCOL.md, CLAUDE.md, and the skills all defer to this
# file; change the commands here, nowhere else.
# (Distinct from scripts/sprint/pre-push-gate.sh, the cheap CI-mirror gate that
# runs at push time — keep the heavy/slow checks here.)
set -euo pipefail

# Linked-worktree guard (full tier only: worktree-guard.sh ships with the parallel-sprint
# machinery). When worktrees share the primary checkout's dependency install by symlink
# (scripts/sprint/worktree-link.sh, "link mode"), running the package manager inside a linked
# worktree corrupts the PRIMARY's install. Projects in link mode set the worktree gate below
# to a reduced command chain that calls tool binaries directly (no package manager). Blank =
# no reduced gate: the normal gate runs everywhere (right for "install mode", where every
# worktree has its own install, and always in the lite tier) — except in a linked worktree
# when worktree-links.json lists links: then the gate FAILS rather than fall through to the
# package manager.
WORKTREE_GATE_CMD=""
IFS= read -r -d '' WORKTREE_GATE_CMD <<'WORKTREE_GATE_EOF' || true
{{WORKTREE_GATE_COMMANDS}}
WORKTREE_GATE_EOF
if [ -f "$(dirname "${BASH_SOURCE[0]}")/worktree-guard.sh" ]; then
  # shellcheck source=/dev/null
  source "$(dirname "${BASH_SOURCE[0]}")/worktree-guard.sh"
  if in_linked_worktree; then
    if [ -n "${WORKTREE_GATE_CMD//[[:space:]]/}" ]; then
      echo "gate: REDUCED gate (linked worktree) — the package manager would corrupt the PRIMARY"
      echo "gate: checkout's shared install here, so running the worktree gate commands instead."
      bash -euo pipefail -c "$WORKTREE_GATE_CMD"
      echo "gate: REDUCED checks passed (linked worktree). This is NOT a full gate pass —"
      echo "gate: report it as reduced; the full gate runs on the primary checkout/CI."
      exit 0
    fi
    links_file="$(dirname "${BASH_SOURCE[0]}")/worktree-links.json"
    if [ -f "$links_file" ]; then
      # "install" only when node reads a config with an empty/missing `links`; a missing node
      # or an unreadable file fails closed (treated as link mode).
      links_mode=""
      if command -v node >/dev/null 2>&1; then
        links_mode=$(node -e 'const c = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
          process.stdout.write(Array.isArray(c && c.links) && c.links.length ? "link" : "install")' "$links_file" 2>/dev/null) || links_mode=""
      fi
      if [ "$links_mode" != install ]; then
        why="it lists links"
        [ -n "$links_mode" ] || why="unreadable without node / not valid JSON — assuming links"
        echo "gate: link mode is on ($links_file: $why), but no worktree gate commands are set —" >&2
        echo "gate: the normal gate would run the package manager here and corrupt the PRIMARY" >&2
        echo "gate: checkout's shared install. Set the worktree gate commands via /template-upgrade," >&2
        echo "gate: or run the gate from the primary checkout." >&2
        exit 1
      fi
    fi
  fi
fi

{{GATE_COMMANDS}}

echo "gate: all checks passed"
