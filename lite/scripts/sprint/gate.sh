#!/usr/bin/env bash
# The commit gate — the SINGLE source of truth for what must pass before every
# deliverable commit. PROTOCOL.md, CLAUDE.md, and the skills all defer to this
# file; change the commands here, nowhere else.
# (Distinct from scripts/sprint/pre-push-gate.sh, the cheap CI-mirror gate that
# runs at push time — keep the heavy/slow checks here.)
set -euo pipefail

{{GATE_COMMANDS}}

echo "gate: all checks passed"
