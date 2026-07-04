#!/usr/bin/env bash
# Checks whether the upstream template (filestuff/project-template) has a newer
# version than the one installed in this downstream repo. This script is part
# of the template PAYLOAD — it ships into every repo that bootstraps from the
# template and runs there, not in the template repo itself.
#
# Invoked (a) silently as a preamble by the /sprint skill on every run, and
# (b) by the /template-upgrade skill with --force. Because of (a) it must be
# fast, must never block on input, and must exit 0 SILENTLY on any failure —
# a broken manifest, no network, no git, whatever. Never let this script be
# the reason a sprint command fails or hangs.
#
# Usage:
#   update-check.sh            # cached/normal check
#   update-check.sh --force    # bypass cache + snooze, always hit the network
#   update-check.sh --snooze   # snooze the currently-known remote version, no network
#
# Output contract (stdout, only on success paths — otherwise silent):
#   JUST_UPGRADED <old_version> <new_version>
#   UPGRADE_AVAILABLE <local_version> <remote_version> <remote_sha>
#
# Deliberately does NOT use `set -e`: the contract is "exit 0 silently on any
# failure," which means every risky step is individually guarded rather than
# relying on errexit (which would also trip on harmless nonzero results from
# things like grep/read/arithmetic and abort mid-script instead of falling
# through cleanly). set -u is kept, with defaults on every optional env var.
set -uo pipefail

# --- helpers -----------------------------------------------------------------

# Trim leading/trailing whitespace (including trailing newlines) from stdin.
trim() {
  local s
  s=$(cat)
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# node semver-ish compare: prints "gt" if $1 > $2, else "le". Empty stdout
# means node itself failed — callers must treat that as "not greater".
semver_gt() {
  node -e '
    function parts(v) { return v.split(".").map(function (n) { return parseInt(n, 10) || 0; }); }
    var a = parts(process.argv[1]);
    var b = parts(process.argv[2]);
    var len = Math.max(a.length, b.length);
    for (var i = 0; i < len; i++) {
      var x = a[i] || 0, y = b[i] || 0;
      if (x > y) { process.stdout.write("gt"); process.exit(0); }
      if (x < y) { process.stdout.write("le"); process.exit(0); }
    }
    process.stdout.write("le");
  ' "$1" "$2" 2>/dev/null
}

# Validate a version string looks like X.Y.Z (digits and dots only).
looks_like_version() {
  local v="$1" re='^[0-9]+(\.[0-9]+)*$'
  [[ "$v" =~ $re ]]
}

# --- 0. Cheap bail-outs (must stay silent) ------------------------------------

[ "${TEMPLATE_UPDATE_CHECK:-}" = "0" ] && exit 0

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
GIT_DIR=$(git rev-parse --git-dir 2>/dev/null) || exit 0
[ -n "$REPO_ROOT" ] || exit 0

MANIFEST="$REPO_ROOT/.claude/template-manifest.json"
[ -f "$MANIFEST" ] || exit 0

# Parse the manifest with node; any failure here (bad JSON, missing fields)
# must be silent. Emit a single line: "<updateCheck> <version> <repo>".
manifest_line=$(node -e '
  try {
    var fs = require("fs");
    var m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    var updateCheck = m.updateCheck === false ? "0" : "1";
    var version = (m.template && m.template.version) || "";
    var repo = (m.template && m.template.repo) || "";
    if (!version) { process.exit(1); }
    process.stdout.write(updateCheck + "\t" + version + "\t" + repo);
  } catch (e) {
    process.exit(1);
  }
' "$MANIFEST" 2>/dev/null) || exit 0
[ -n "$manifest_line" ] || exit 0

MANIFEST_UPDATE_CHECK=$(printf '%s' "$manifest_line" | cut -f1)
LOCAL_VERSION=$(printf '%s' "$manifest_line" | cut -f2)
MANIFEST_REPO=$(printf '%s' "$manifest_line" | cut -f3)

[ "$MANIFEST_UPDATE_CHECK" = "1" ] || exit 0
[ -n "$LOCAL_VERSION" ] || exit 0

REPO_URL="${TEMPLATE_REPO_URL:-$MANIFEST_REPO}"
[ -n "$REPO_URL" ] || exit 0

STATE_DIR="${TEMPLATE_STATE_DIR:-$GIT_DIR/template-update}"
mkdir -p "$STATE_DIR" 2>/dev/null || exit 0

LAST_CHECK_FILE="$STATE_DIR/last-check"
SNOOZE_FILE="$STATE_DIR/update-snoozed"
JUST_UPGRADED_FILE="$STATE_DIR/just-upgraded-from"

FORCE=0
SNOOZE=0
for arg in "$@"; do
  case "$arg" in
  --force) FORCE=1 ;;
  --snooze) SNOOZE=1 ;;
  esac
done

# --- 1. just-upgraded-from marker (checked before flag handling) -------------

if [ -f "$JUST_UPGRADED_FILE" ]; then
  old_version=$(trim <"$JUST_UPGRADED_FILE" 2>/dev/null)
  if [ -n "$old_version" ]; then
    echo "JUST_UPGRADED $old_version $LOCAL_VERSION"
  fi
  rm -f "$JUST_UPGRADED_FILE" 2>/dev/null
  exit 0
fi

# --- 2. --snooze mode: no network, just record/escalate ----------------------

if [ "$SNOOZE" -eq 1 ]; then
  [ -f "$LAST_CHECK_FILE" ] || exit 0
  cached_remote_version=$(cut -d' ' -f2 <"$LAST_CHECK_FILE" 2>/dev/null)
  [ -n "$cached_remote_version" ] || exit 0

  level=1
  if [ -f "$SNOOZE_FILE" ]; then
    snoozed_version=$(cut -d' ' -f1 <"$SNOOZE_FILE" 2>/dev/null)
    snoozed_level=$(cut -d' ' -f2 <"$SNOOZE_FILE" 2>/dev/null)
    if [ "$snoozed_version" = "$cached_remote_version" ] && [ -n "$snoozed_level" ]; then
      level=$((snoozed_level + 1))
    fi
  fi
  now=$(date +%s)
  echo "$cached_remote_version $level $now" >"$SNOOZE_FILE" 2>/dev/null
  exit 0
fi

# --- 3. Cache check -----------------------------------------------------------

now=$(date +%s)
cached_epoch=""
cached_remote_version=""
cached_remote_sha=""
if [ -f "$LAST_CHECK_FILE" ]; then
  cached_epoch=$(cut -d' ' -f1 <"$LAST_CHECK_FILE" 2>/dev/null)
  cached_remote_version=$(cut -d' ' -f2 <"$LAST_CHECK_FILE" 2>/dev/null)
  cached_remote_sha=$(cut -d' ' -f3 <"$LAST_CHECK_FILE" 2>/dev/null)
fi

use_cache=0
if [ "$FORCE" -ne 1 ] && [ -n "$cached_epoch" ] && [ -n "$cached_remote_version" ]; then
  if [ "$cached_remote_version" = "$LOCAL_VERSION" ]; then
    ttl_secs=$((60 * 60))
  else
    ttl_secs=$((720 * 60))
  fi
  age=$((now - cached_epoch))
  if [ "$age" -ge 0 ] && [ "$age" -lt "$ttl_secs" ]; then
    use_cache=1
  fi
fi

remote_version=""
remote_sha=""

if [ "$use_cache" -eq 1 ]; then
  remote_version="$cached_remote_version"
  remote_sha="$cached_remote_sha"
else
  # --- 4. Network fetch (every failure -> write nothing, exit 0 silently) ----
  export GIT_TERMINAL_PROMPT=0

  url="$REPO_URL"
  local_path=""
  case "$url" in
  file://*)
    local_path="${url#file://}"
    ;;
  *://*)
    local_path=""
    ;;
  *)
    # No scheme at all -> treat as a local filesystem path (testing override).
    local_path="$url"
    ;;
  esac

  if [ -n "$local_path" ] && [ -d "$local_path" ]; then
    remote_sha=$(git -C "$local_path" rev-parse main 2>/dev/null | trim) || exit 0
    [ -n "$remote_sha" ] || exit 0
    remote_version=$(git -C "$local_path" show main:VERSION 2>/dev/null | trim) || exit 0
  else
    remote_sha=$(git ls-remote "$url" refs/heads/main 2>/dev/null | cut -f1 | trim)
    [ -n "$remote_sha" ] || exit 0

    raw_base="${TEMPLATE_RAW_BASE:-}"
    if [ -z "$raw_base" ]; then
      owner_repo=$(printf '%s' "$url" | node -e '
        var url = require("fs").readFileSync(0, "utf8").trim();
        var m = url.match(/github\.com[:/]+([^/]+)\/([^/]+?)(\.git)?\/?$/);
        if (!m) { process.exit(1); }
        process.stdout.write(m[1] + "/" + m[2]);
      ' 2>/dev/null)
      [ -n "$owner_repo" ] || exit 0
      raw_base="https://raw.githubusercontent.com/$owner_repo"
    fi

    remote_version=$(curl -fsSL --max-time 5 "$raw_base/$remote_sha/VERSION" 2>/dev/null | trim)
    if [ -z "$remote_version" ]; then
      remote_version=$(curl -fsSL --max-time 5 "$raw_base/main/VERSION" 2>/dev/null | trim)
      # sha becomes unreliable once we fall back to the main branch VERSION;
      # keep it if we already have it, otherwise report unknown.
    fi
    [ -n "$remote_version" ] || exit 0
    [ -n "$remote_sha" ] || remote_sha="-"
  fi
fi

looks_like_version "$remote_version" || exit 0

# --- 5. Write cache (always, even when reusing — refreshes the epoch) --------

sha_for_cache="$remote_sha"
[ -n "$sha_for_cache" ] || sha_for_cache="-"
echo "$now $remote_version $sha_for_cache" >"$LAST_CHECK_FILE" 2>/dev/null

# --- 6. Compare (never downgrade) --------------------------------------------

cmp=$(semver_gt "$remote_version" "$LOCAL_VERSION")
[ "$cmp" = "gt" ] || exit 0

# --- 7. Snooze check (skipped for --force) -----------------------------------

if [ "$FORCE" -ne 1 ] && [ -f "$SNOOZE_FILE" ]; then
  snoozed_version=$(cut -d' ' -f1 <"$SNOOZE_FILE" 2>/dev/null)
  snoozed_level=$(cut -d' ' -f2 <"$SNOOZE_FILE" 2>/dev/null)
  snoozed_epoch=$(cut -d' ' -f3 <"$SNOOZE_FILE" 2>/dev/null)

  if [ "$snoozed_version" = "$remote_version" ]; then
    case "${snoozed_level:-1}" in
    1) duration=$((24 * 60 * 60)) ;;
    2) duration=$((48 * 60 * 60)) ;;
    *) duration=$((7 * 24 * 60 * 60)) ;;
    esac
    snoozed_epoch=${snoozed_epoch:-0}
    if [ "$now" -lt "$((snoozed_epoch + duration))" ]; then
      exit 0
    fi
  else
    # A different (newer) remote version invalidates the snooze.
    rm -f "$SNOOZE_FILE" 2>/dev/null
  fi
fi

# --- 8. Report ----------------------------------------------------------------

echo "UPGRADE_AVAILABLE $LOCAL_VERSION $remote_version $sha_for_cache"
exit 0
