#!/usr/bin/env bash
# The commit gate — the SINGLE source of truth for what must pass before every
# deliverable commit. PROTOCOL.md, CLAUDE.md, and the skills all defer to this
# file; change the commands here, nowhere else.
set -euo pipefail

{{GATE_COMMANDS}}

echo "gate: all checks passed"
