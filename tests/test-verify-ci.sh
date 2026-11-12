#!/usr/bin/env bash
# Regression: the close-time CI check read a never-started run (or a `gh` API error) as "no run"
# and passed it as green, and SKIP_CI_VERIFY silently skipped with no recorded reason. verify-ci.sh
# --self-test drives the script against a stubbed `gh` and a scratch repo with a synthetic
# workflow + ci-gates.json: fail-closed exit 2, red = 1, path-filter N/A via --base, deploy check,
# config/flag/owner-repo errors, and the SKIP_CI_VERIFY reason rule. Prints SKIP without jq.
set -euo pipefail
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
bash "$REPO_DIR/full-overlay/scripts/sprint/verify-ci.sh" --self-test
