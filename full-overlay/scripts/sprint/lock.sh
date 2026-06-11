#!/usr/bin/env bash
# Mutual exclusion for all sprint-lifecycle mutations of main.
# The lock is a directory inside the *common* git dir, so every worktree of
# this repo resolves to the same path and `mkdir` gives atomic acquisition.
#
#   lock.sh acquire <label> [--wait <secs>]   # prints the release token on success
#   lock.sh continue <label>                  # succeed iff the lock is held with this label
#   lock.sh release <token>
#   lock.sh status                            # prints holder info; flags stale (>60 min)
#   lock.sh steal --force                     # removes the lock; only after user confirmation
#
# Exit codes: 0 ok · 75 lock busy · 1 usage/unexpected
set -euo pipefail

GIT_COMMON=$(git rev-parse --path-format=absolute --git-common-dir)
LOCK_DIR="$GIT_COMMON/sprint-main.lock"
OWNER_FILE="$LOCK_DIR/owner"
STALE_SECS=3600

print_holder() {
  if [[ -f "$OWNER_FILE" ]]; then
    grep -v '^TOKEN=' "$OWNER_FILE" # the token is the release credential — never print it
    local held_at now age
    held_at=$(sed -n 's/^EPOCH=//p' "$OWNER_FILE")
    now=$(date +%s)
    age=$((now - held_at))
    echo "AGE_SECONDS=$age"
    if ((age > STALE_SECS)); then
      echo "STALE=probably (held >$((STALE_SECS / 60)) min — confirm with the user before 'steal --force')"
    fi
  fi
}

cmd=${1:-}
case "$cmd" in
acquire)
  label=${2:?usage: lock.sh acquire <label> [--wait <secs>]}
  wait_secs=300
  [[ "${3:-}" == "--wait" ]] && wait_secs=${4:?--wait needs seconds}
  deadline=$(($(date +%s) + wait_secs))
  until mkdir "$LOCK_DIR" 2>/dev/null; do
    if (($(date +%s) >= deadline)); then
      echo "lock busy after ${wait_secs}s; current holder:" >&2
      print_holder >&2
      exit 75
    fi
    sleep 5
  done
  token=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
  {
    echo "LABEL=$label"
    echo "WORKTREE=$(git rev-parse --show-toplevel)"
    echo "TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "EPOCH=$(date +%s)"
    echo "TOKEN=$token"
  } >"$OWNER_FILE"
  echo "$token"
  ;;
continue)
  label=${2:?usage: lock.sh continue <label>}
  if [[ ! -f "$OWNER_FILE" ]]; then
    echo "lock not held — expected to be continuing '$label'" >&2
    exit 75
  fi
  held_label=$(sed -n 's/^LABEL=//p' "$OWNER_FILE")
  if [[ "$held_label" != "$label" ]]; then
    echo "lock held by '$held_label', not '$label':" >&2
    print_holder >&2
    exit 75
  fi
  ;;
release)
  token=${2:?usage: lock.sh release <token>}
  if [[ ! -f "$OWNER_FILE" ]]; then
    echo "lock not held; nothing to release" >&2
    exit 0
  fi
  held_token=$(sed -n 's/^TOKEN=//p' "$OWNER_FILE")
  if [[ "$held_token" != "$token" ]]; then
    echo "token mismatch — refusing to release another owner's lock:" >&2
    print_holder >&2
    exit 1
  fi
  rm -rf "$LOCK_DIR"
  ;;
release-label)
  # Internal: release by label instead of token (used by multi-invocation
  # flows like merge-sprint.sh where the token doesn't cross process calls).
  label=${2:?usage: lock.sh release-label <label>}
  if [[ ! -f "$OWNER_FILE" ]]; then exit 0; fi
  held_label=$(sed -n 's/^LABEL=//p' "$OWNER_FILE")
  if [[ "$held_label" != "$label" ]]; then
    echo "lock held by '$held_label', not '$label' — refusing" >&2
    exit 1
  fi
  rm -rf "$LOCK_DIR"
  ;;
status)
  if [[ -d "$LOCK_DIR" ]]; then
    echo "LOCKED"
    print_holder
  else
    echo "FREE"
  fi
  ;;
steal)
  [[ "${2:-}" == "--force" ]] || {
    echo "usage: lock.sh steal --force  (show 'lock.sh status' to the user first)" >&2
    exit 1
  }
  if [[ -d "$LOCK_DIR" ]]; then
    echo "removed lock held by:"
    print_holder
    rm -rf "$LOCK_DIR"
    cat <<'EOF'
RECOVERY CHECKLIST (the stolen transaction may have died mid-flight):
  1. git -C <repo-root> status --porcelain
     Tracked changes mean a transaction died mid-flight. Lifecycle transactions
     only touch docs/sprints/ + docs/DOC_HEALTH.md before committing, so:
       git restore --staged --worktree -- docs/sprints docs/DOC_HEALTH.md
  2. If a merge is in progress: git merge --abort
     (or merge-sprint.sh abort <branch>, which also rolls back a half-landed
     merge via its recorded pre-land SHA).
Every script ends every success-or-handled-failure path with main clean, so
recovery is always one of those two cases.
EOF
  else
    echo "lock was not held"
  fi
  ;;
*)
  echo "usage: lock.sh acquire|continue|release|release-label|status|steal" >&2
  exit 1
  ;;
esac
