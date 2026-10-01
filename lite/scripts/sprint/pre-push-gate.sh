#!/usr/bin/env bash
# Fast pre-push gate. Runs only the CHEAP subset of CI checks locally so they fail in
# seconds instead of after a long red CI run — the broken-push -> red-CI -> fix -> push
# churn is the dominant CI drain. This is DISTINCT from scripts/sprint/gate.sh, which is
# the full per-commit gate; keep the heavy/slow checks there.
#
# Skips doc-only / .claude-only pushes (matching a typical CI paths-ignore). Bypass for a
# WIP or emergency push:  git push --no-verify
#
# Wire it up as an actual git pre-push hook (see the bootstrap skill, step 5): for a Node
# project add a husky .husky/pre-push that runs this script; otherwise point
# core.hooksPath at it or drop a thin .git/hooks/pre-push wrapper that calls it.
set -euo pipefail
MAIN=${SPRINT_MAIN_BRANCH:-main}

trap 'echo "pre-push gate failed — fix locally, or bypass with: git push --no-verify" >&2' ERR

# --- Secret scan (gitleaks, if installed) -----------------------------------
# git feeds pre-push hooks "<local_ref> <local_oid> <remote_ref> <remote_oid>" lines on
# stdin; scan only the commits actually being pushed.
if command -v gitleaks >/dev/null 2>&1; then
  zero_oid="0000000000000000000000000000000000000000"
  remote_name="${1:-origin}"
  remote_default_ref=$(git symbolic-ref "refs/remotes/$remote_name/HEAD" 2>/dev/null || true)

  if [ -z "$remote_default_ref" ]; then
    remote_head_branch=$(git remote show "$remote_name" 2>/dev/null | sed -n '/HEAD branch/s/.*: //p' | head -n 1 || true)
    if [ -n "$remote_head_branch" ]; then
      remote_default_ref="$remote_name/$remote_head_branch"
    fi
  else
    remote_default_ref=${remote_default_ref#refs/remotes/}
  fi

  if [ -z "$remote_default_ref" ]; then
    remote_default_ref="$remote_name/$MAIN"
  fi

  while read -r local_ref local_oid remote_ref remote_oid; do
    if [ -z "$local_ref" ] || [ "$local_oid" = "$zero_oid" ]; then
      continue
    fi

    if [ "$remote_oid" = "$zero_oid" ]; then
      merge_base=$(git merge-base "$local_oid" "$remote_default_ref" 2>/dev/null || true)
      if [ -n "$merge_base" ]; then
        log_opts="$merge_base..$local_oid"
      else
        log_opts="$local_oid^!"
      fi
    else
      log_opts="$remote_oid..$local_oid"
    fi

    commit_count=$(git rev-list --count "$log_opts" 2>/dev/null || true)
    if [ -z "$commit_count" ] || [ "$commit_count" = "0" ]; then
      continue
    fi

    echo "Running gitleaks on $local_ref ($commit_count commit(s))..."
    if ! gitleaks git --no-banner --redact --log-opts="$log_opts" .; then
      echo "Push blocked by gitleaks." >&2
      exit 1
    fi
  done
else
  echo "Skipping gitleaks pre-push scan (not installed) — install gitleaks to enable it."
fi

# --- Fast static gate (skips doc-only / .claude-only pushes) ----------------
gate_base="origin/$MAIN"
git rev-parse --verify --quiet "$gate_base" >/dev/null 2>&1 || gate_base="HEAD~1"

changed=$(git diff --name-only "$gate_base"...HEAD 2>/dev/null || true)
code_changed=$(printf '%s\n' "$changed" | grep -Ev '^(docs/|\.claude/)|\.mdx?$' | grep -v '^$' || true)

if [ -n "$code_changed" ]; then
  echo "pre-push: running fast static gate…"

  # Linked-worktree guard (full tier only; rationale in scripts/sprint/gate.sh): in link mode
  # the package manager inside a linked worktree corrupts the PRIMARY checkout's shared
  # install, so run the worktree pre-push commands (direct tool binaries) instead. Blank = the
  # normal checks below run everywhere — except in a linked worktree when worktree-links.json
  # lists links: then the gate FAILS rather than fall through to the package manager.
  WORKTREE_PREPUSH_CMD=""
  IFS= read -r -d '' WORKTREE_PREPUSH_CMD <<'WORKTREE_PREPUSH_EOF' || true
{{WORKTREE_PREPUSH_GATE_COMMANDS}}
WORKTREE_PREPUSH_EOF
  if [ -f "$(dirname "${BASH_SOURCE[0]}")/worktree-guard.sh" ]; then
    # shellcheck source=/dev/null
    source "$(dirname "${BASH_SOURCE[0]}")/worktree-guard.sh"
    if in_linked_worktree; then
      if [ -n "${WORKTREE_PREPUSH_CMD//[[:space:]]/}" ]; then
        echo "pre-push: REDUCED gate (linked worktree) — running the worktree pre-push commands"
        echo "pre-push: instead of the package manager, which would corrupt the PRIMARY's install."
        bash -euo pipefail -c "$WORKTREE_PREPUSH_CMD"
        echo "pre-push: static gate passed (REDUCED — linked worktree)."
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
          echo "pre-push: link mode is on ($links_file: $why), but no worktree pre-push commands" >&2
          echo "pre-push: are set — the normal checks would run the package manager here and corrupt the" >&2
          echo "pre-push: PRIMARY checkout's shared install. Set the worktree gate commands via" >&2
          echo "pre-push: /template-upgrade, or run the gate from the primary checkout." >&2
          exit 1
        fi
      fi
    fi
  fi

  {{PREPUSH_GATE_COMMANDS}}
  echo "pre-push: static gate passed."
fi
