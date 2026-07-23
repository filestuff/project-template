#!/usr/bin/env bash
# Regression: a cache HIT must not rewrite the cache epoch (sliding-window bug).
# Before the fix, every run within the TTL refreshed the epoch, so frequent
# /sprint use meant the network was never asked again.
set -euo pipefail
REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# Template fixture: local git repo with VERSION 9.9.9 on main
git init -q "$TMP/tpl"
( cd "$TMP/tpl" && echo "9.9.9" > VERSION && git add VERSION \
  && git -c user.email=t@t -c user.name=t commit -qm v && git branch -M main )

# Downstream fixture: manifest at version 1.0.0 pointing at the local template
git init -q "$TMP/dn"
mkdir -p "$TMP/dn/.claude"
cat > "$TMP/dn/.claude/template-manifest.json" <<EOF
{ "template": { "version": "1.0.0", "repo": "$TMP/tpl" } }
EOF

STATE="$TMP/state"
run() ( cd "$TMP/dn" && TEMPLATE_STATE_DIR="$STATE" \
  bash "$REPO_DIR/lite/scripts/template/update-check.sh" "$@" )

out1=$(run)
case "$out1" in UPGRADE_AVAILABLE*) ;; *) echo "expected UPGRADE_AVAILABLE, got: $out1"; exit 1;; esac

# Backdate the cache epoch to 100s ago (still inside the 720min mismatch-TTL)
epoch1=$(cut -d' ' -f1 < "$STATE/last-check")
rest=$(cut -d' ' -f2- < "$STATE/last-check")
echo "$((epoch1 - 100)) $rest" > "$STATE/last-check"

run > /dev/null   # cache hit — must NOT rewrite the epoch
epoch2=$(cut -d' ' -f1 < "$STATE/last-check")
[ "$epoch2" = "$((epoch1 - 100))" ] || { echo "epoch was refreshed on a cache hit ($epoch2)"; exit 1; }
