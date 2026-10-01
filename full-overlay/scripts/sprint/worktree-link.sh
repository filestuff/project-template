#!/usr/bin/env bash
# Worktree dependency setup/teardown — the sprint-worktree toolchain contract.
#
#   bash scripts/sprint/worktree-link.sh setup    [<worktree-path>]   # default: cwd
#   bash scripts/sprint/worktree-link.sh teardown [<worktree-path>]
#   bash scripts/sprint/worktree-link.sh --self-test
#
# Exit 0 on success; 1 on any refusal or failure (the reason is printed to stderr), or usage.
#
# Driven by scripts/sprint/worktree-links.json next to this script (override the path with
# WORKTREE_LINKS_FILE). Every key is optional; every path is repo-relative:
#
#   links        paths symlinked to the PRIMARY checkout's copy, so every worktree resolves
#                dependencies from ONE install ("link mode"), e.g. a root dependency dir plus
#                each package-level one.
#   envFiles     files copied from the primary when the worktree lacks them (local env /
#                secrets files that are gitignored and so absent from a fresh worktree).
#   keepIfReal   links entries that, when already a REAL directory in the worktree, are kept
#                as worktree-local (e.g. a generated client a schema-touching sprint
#                regenerates on purpose). Any other real directory at a links path is moved
#                aside (see below).
#   scanExclude  `find -path` patterns skipped by teardown's final scan (e.g. a package
#                manager's internal content-addressed store, such as '*/.pnpm/*').
#
# With no config file, or an empty `links`, this is "install mode": each worktree runs its
# own dependency install, and setup only copies envFiles.
#
# setup refuses in the primary checkout, is idempotent, and refuses a link that points
# anywhere but the primary's copy. A real directory at a links path (a worktree that carries
# its own install) is moved into the worktree's own git dir, under worktree-link-aside/
# (outside the tree: invisible to `git status`, removed with the worktree, restored by
# teardown) — two copies of every package side by side break tooling in confusing ways. An
# existing aside copy is never overwritten. Overlapping links entries (one equal to or under
# another) are refused at config load, and setup/teardown refuse any path whose parent resolves
# outside the worktree (a symlinked parent component) — either would act on the PRIMARY.
#
# teardown removes only the links (never their targets) and restores what setup moved aside —
# run it BEFORE `git worktree remove`. It then fails if any link inside the primary's linked
# dirs still points into this worktree: that is the corruption shape a package manager run
# inside the worktree leaves behind (it re-points the primary's package links into the
# worktree), and removing the worktree would leave them dangling.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/sprint/worktree-guard.sh
source "$SELF_DIR/worktree-guard.sh"

die() { echo "worktree-link: $*" >&2; exit 1; }

# Fills LINKS / ENV_FILES / KEEP_IF_REAL / SCAN_EXCLUDE from the config. Arrays may be empty:
# expand them as ${A[@]+"${A[@]}"} (bash 3.2 treats "${A[@]}" of an empty array as unbound).
load_config() {
  local f key val lines
  LINKS=() ENV_FILES=() KEEP_IF_REAL=() SCAN_EXCLUDE=()
  f="${WORKTREE_LINKS_FILE:-$SELF_DIR/worktree-links.json}"
  if [[ ! -f $f ]]; then
    [[ -z ${WORKTREE_LINKS_FILE:-} ]] || die "WORKTREE_LINKS_FILE=$f does not exist"
    return 0
  fi
  command -v node >/dev/null 2>&1 || die "node is required to read $f"
  lines=$(node -e '
    const fs = require("node:fs"), path = require("node:path");
    const file = process.argv[1];
    const fail = (msg) => { console.error(`worktree-link: ${file}: ${msg}`); process.exit(1); };
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { fail(e.message); }
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) fail("top level must be an object");
    const keys = ["links", "envFiles", "keepIfReal", "scanExclude"];
    for (const k of Object.keys(cfg)) {
      if (!keys.includes(k) && !k.startsWith("$")) fail(`unknown key "${k}"`);
    }
    const out = [];
    for (const k of keys) {
      const v = cfg[k] ?? [];
      if (!Array.isArray(v)) fail(`"${k}" must be an array`);
      for (const e of v) {
        if (typeof e !== "string" || e === "" || /[\t\n\r]/.test(e)) fail(`"${k}" entries must be non-empty single-line strings`);
        if (k !== "scanExclude") {
          const norm = path.posix.normalize(e);
          if (e.startsWith("/") || norm !== e || norm === "." || norm.split("/").includes(".."))
            fail(`"${k}" entry "${e}" must be a normalized repo-relative path`);
        }
        out.push(`${k}\t${e}`);
      }
    }
    for (const e of cfg.keepIfReal ?? []) {
      if (!(cfg.links ?? []).includes(e)) fail(`keepIfReal entry "${e}" is not in links`);
    }
    // Once a links entry is a symlink, any links entry at or under it resolves THROUGH that
    // symlink into the primary, so setup/teardown would mutate the primary checkout itself.
    const links = cfg.links ?? [];
    links.forEach((a, i) => links.forEach((b, j) => {
      if (i !== j && (a === b || b.startsWith(`${a}/`)))
        fail(`links entries "${a}" and "${b}" overlap (one equals or contains the other) — list only the outermost dir`);
    }));
    if (out.length) console.log(out.join("\n"));
  ' "$f") || exit 1
  while IFS=$'\t' read -r key val; do
    case $key in
      links) LINKS+=("$val") ;;
      envFiles) ENV_FILES+=("$val") ;;
      keepIfReal) KEEP_IF_REAL+=("$val") ;;
      scanExclude) SCAN_EXCLUDE+=("$val") ;;
    esac
  done <<<"$lines"
}

# Sets wt / primary / aside for the worktree at $1, refusing anything but a linked worktree.
resolve_paths() {
  [[ -d $1 ]] || die "no such directory: $1"
  wt="$(cd "$1" && pwd -P)"
  (cd "$wt" && in_linked_worktree) || die "$wt is not a linked git worktree — refusing (never run this in the primary checkout)"
  primary="$(dirname "$(cd "$wt" && cd "$(git rev-parse --git-common-dir)" && pwd -P)")"
  aside="$(cd "$wt" && cd "$(git rev-parse --absolute-git-dir)" && pwd -P)/worktree-link-aside"
}

# assert_under <root> <path> — refuse (exit 1) unless <path>'s parent dir resolves PHYSICALLY
# under <root> (the worktree's physical root). A symlinked parent component (e.g. a worktree dir
# that is a link into the primary) would otherwise carry mv/rm/ln/cp/mkdir into the primary.
# A parent that does not exist yet is judged by its nearest existing ancestor, which is what
# `mkdir -p` would build under; a dangling link on the way cannot be resolved and is refused.
assert_under() {
  local root=$1 path=$2 d
  d=$(dirname "$path")
  while [[ ! -e $d && ! -L $d ]]; do d=$(dirname "$d"); done
  d=$(cd "$d" 2>/dev/null && pwd -P) || die "cannot resolve the parent of $path — refusing to touch it"
  [[ $d == "$root" || $d == "$root"/* ]] \
    || die "$path resolves outside the worktree (its parent is really $d, not under $root) — a symlinked parent component; refusing to touch it (fix by hand)"
}

keep_if_real() {
  local k
  for k in ${KEEP_IF_REAL[@]+"${KEEP_IF_REAL[@]}"}; do [[ $k == "$1" ]] && return 0; done
  return 1
}

setup() {
  local wt primary aside p src dst
  load_config
  resolve_paths "$1"
  [[ -n ${LINKS[*]+x} ]] || echo "install mode (no links configured) — copying env files only"
  for p in ${LINKS[@]+"${LINKS[@]}"}; do
    src="$primary/$p" dst="$wt/$p"
    assert_under "$wt" "$dst"
    [[ -e $src ]] || { echo "skipped      $p (the primary has none)"; continue; }
    if [[ -L $dst ]]; then
      if [[ $(readlink "$dst") == "$src" ]] \
        || { [[ -d $dst && -d $src ]] && [[ $(cd "$dst" && pwd -P) == "$(cd "$src" && pwd -P)" ]]; }; then
        echo "kept         $p"
        continue
      fi
      die "$p is a link to $(readlink "$dst"), not $src — fix it by hand"
    fi
    if [[ -e $dst ]]; then
      if keep_if_real "$p"; then
        echo "kept         $p (worktree-local real copy — restore the link when done with it)"
        continue
      fi
      [[ ! -e $aside/$p && ! -L $aside/$p ]] || die "$aside/$p already exists — refusing to overwrite it"
      mkdir -p "$(dirname "$aside/$p")"
      mv "$dst" "$aside/$p"
      echo "moved aside  $p → $aside/$p"
    fi
    mkdir -p "$(dirname "$dst")"
    ln -s "$src" "$dst"
    echo "linked       $p → $src"
  done
  for p in ${ENV_FILES[@]+"${ENV_FILES[@]}"}; do
    if [[ -f $primary/$p && ! -e $wt/$p ]]; then
      assert_under "$wt" "$wt/$p"
      mkdir -p "$(dirname "$wt/$p")"
      cp "$primary/$p" "$wt/$p"
      echo "copied       $p"
    fi
  done
}

teardown() {
  local wt primary aside p leftovers
  local -a excl=()
  load_config
  resolve_paths "$1"
  for p in ${LINKS[@]+"${LINKS[@]}"}; do
    # Covers both the rm below and the aside restore into $wt/$p.
    assert_under "$wt" "$wt/$p"
    if [[ -L $wt/$p ]]; then
      rm "$wt/$p"
      echo "unlinked     $p"
    fi
    if [[ -e $aside/$p && ! -e $wt/$p ]]; then
      mv "$aside/$p" "$wt/$p"
      echo "restored     $p"
    fi
  done
  for p in ${SCAN_EXCLUDE[@]+"${SCAN_EXCLUDE[@]}"}; do excl+=(-not -path "$p"); done
  # Scan roots = the primary's copies of the linked paths: exactly the dirs a package-manager
  # run inside the worktree could have re-pointed. `|| true` on find: under pipefail + set -e a
  # permission error deep in a store would otherwise silently kill teardown.
  leftovers=$(
    for p in ${LINKS[@]+"${LINKS[@]}"}; do
      if [[ -d $primary/$p || -L $primary/$p ]]; then
        find "$primary/$p" -maxdepth 3 -type l ${excl[@]+"${excl[@]}"} 2>/dev/null || true
      fi
    done | node -e '
      const fs = require("node:fs"), path = require("node:path");
      const wt = process.argv[1];
      for (const link of fs.readFileSync(0, "utf8").split("\n").filter(Boolean)) {
        const target = path.resolve(fs.realpathSync(path.dirname(link)), fs.readlinkSync(link));
        if (target === wt || target.startsWith(wt + path.sep)) console.log(`  ${link} -> ${fs.readlinkSync(link)}`);
      }' "$wt"
  )
  if [[ -n $leftovers ]]; then
    echo "worktree-link: primary links point into this worktree — repair them before removing it:" >&2
    echo "$leftovers" >&2
    exit 1
  fi
  echo "teardown OK — safe to: git worktree remove $wt"
}

# --- --self-test ------------------------------------------------------------
# Scratch `mktemp -d` primary + linked worktrees and a fixture config; never the real repo, its
# config, or a real install.
run_self_test() {
  local self scratch primary wt wt2 rc out aside_dir d cfg
  self="$SELF_DIR/$(basename "${BASH_SOURCE[0]}")"
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY
  scratch=$(cd "$(mktemp -d)" && pwd -P)
  # shellcheck disable=SC2064 # expand now: `scratch` is local and gone when EXIT fires
  trap "rm -rf '$scratch'" EXIT
  # The worktree sits under the primary (as many sprint worktrees do), so case (g) can use the
  # relative link shape a package manager writes when it re-points a primary link into it.
  primary="$scratch/primary" wt="$scratch/primary/.worktrees/wt" wt2="$scratch/primary/.worktrees/wt2"
  cfg="$scratch/worktree-links.json"
  fail() { echo "FAIL: $1"; [[ -n ${out:-} ]] && echo "$out"; exit 1; }
  run() { rc=0; out=$("$@" 2>&1) || rc=$?; }
  is_link_to() { [[ -L $1 && $(readlink "$1") == "$2" ]]; }
  # snapshot <primary> — every entry (type, link target, content checksum), minus .git and the
  # worktrees nested under it: equal snapshots = the primary is byte-identical.
  snapshot() {
    (cd "$1" && find . \( -path ./.git -o -path ./.worktrees \) -prune -o -print | LC_ALL=C sort |
      while IFS= read -r f; do
        if [[ -L $f ]]; then echo "L $f $(readlink "$f")"
        elif [[ -f $f ]]; then echo "F $f $(cksum <"$f")"
        else echo "D $f"; fi
      done)
  }
  local -a dirs=(deps pkg/a/deps pkg/a/generated pkg/b/deps tools/c/deps)
  cat >"$cfg" <<'JSON'
{
  "links": ["deps", "pkg/a/deps", "pkg/a/generated", "pkg/b/deps", "tools/c/deps"],
  "envFiles": ["pkg/a/.env", "tools/c/.env"],
  "keepIfReal": ["pkg/a/generated"],
  "scanExclude": ["*/.store/*"]
}
JSON
  export WORKTREE_LINKS_FILE="$cfg"

  git init -q "$primary"
  printf 'deps\ngenerated\n.env*\n.worktrees/\n' >"$primary/.gitignore"
  git -C "$primary" add .gitignore
  git -C "$primary" -c user.email=selftest@example.com -c user.name="worktree-link self-test" \
    -c commit.gpgsign=false commit -q -m base
  for d in "${dirs[@]}"; do
    mkdir -p "$primary/$d" && echo primary >"$primary/$d/marker"
  done
  echo "SECRET=1" >"$primary/pkg/a/.env"
  git -C "$primary" worktree add -q "$wt" -b wt
  # A worktree that carries its own REAL root install.
  mkdir -p "$wt/deps" && echo own >"$wt/deps/marker"

  # (a) setup in the primary → refused, nothing changed
  run "$BASH" "$self" setup "$primary"
  [[ $rc -ne 0 ]] || fail "(a) setup should refuse in the primary checkout"
  [[ -d $primary/deps && ! -L $primary/deps ]] || fail "(a) primary deps was touched"

  # (b) setup in a real-root worktree → one install, own copy kept aside, env copied, status clean
  run "$BASH" -c "cd '$wt' && '$BASH' '$self' setup"
  [[ $rc -eq 0 ]] || fail "(b) setup failed (rc=$rc)"
  for d in "${dirs[@]}"; do
    is_link_to "$wt/$d" "$primary/$d" || fail "(b) $d is not a link to the primary's"
  done
  [[ $(cat "$(git -C "$wt" rev-parse --absolute-git-dir)/worktree-link-aside/deps/marker") == own ]] \
    || fail "(b) the worktree's own root deps was not kept aside"
  [[ -f $wt/pkg/a/.env ]] || fail "(b) pkg/a/.env not copied"
  [[ ! -e $wt/tools/c/.env ]] || fail "(b) tools/c/.env copied though the primary has none"
  [[ -z $(git -C "$wt" status --porcelain) ]] || fail "(b) git status not clean: $(git -C "$wt" status --porcelain)"

  # (c) idempotent
  run "$BASH" "$self" setup "$wt"
  [[ $rc -eq 0 ]] || fail "(c) second setup failed (rc=$rc)"
  is_link_to "$wt/deps" "$primary/deps" || fail "(c) second setup changed deps"

  # (d) a link pointing somewhere else → refused
  rm "$wt/pkg/b/deps" && ln -s "$scratch" "$wt/pkg/b/deps"
  run "$BASH" "$self" setup "$wt"
  [[ $rc -ne 0 ]] || fail "(d) setup should refuse a link that points elsewhere"
  grep -q "pkg/b/deps" <<<"$out" || fail "(d) refusal should name the path"
  rm "$wt/pkg/b/deps"

  # (h) a real keepIfReal dir is kept as worktree-local, not moved aside
  rm "$wt/pkg/a/generated" && mkdir "$wt/pkg/a/generated" && echo local >"$wt/pkg/a/generated/marker"
  run "$BASH" "$self" setup "$wt"
  [[ $rc -eq 0 && ! -L $wt/pkg/a/generated && $(cat "$wt/pkg/a/generated/marker") == local ]] \
    || fail "(h) setup should keep a worktree-local keepIfReal dir (rc=$rc)"
  rm -r "$wt/pkg/a/generated"

  # (i) a stale aside copy is never overwritten
  rm "$wt/tools/c/deps" && mkdir "$wt/tools/c/deps"
  aside_dir="$(git -C "$wt" rev-parse --absolute-git-dir)/worktree-link-aside"
  mkdir -p "$aside_dir/tools/c/deps"
  run "$BASH" "$self" setup "$wt"
  [[ $rc -ne 0 ]] || fail "(i) setup should refuse to overwrite an existing aside copy"
  grep -q "already exists" <<<"$out" || fail "(i) refusal should say the aside copy exists"
  rm -r "$wt/tools/c/deps" "$aside_dir/tools"

  # (e) orchestrator mode: by path, from the primary's cwd
  run "$BASH" -c "cd '$primary' && '$BASH' '$self' setup '$wt'"
  [[ $rc -eq 0 ]] || fail "(e) setup by path from the primary failed (rc=$rc)"
  is_link_to "$wt/pkg/b/deps" "$primary/pkg/b/deps" || fail "(e) setup by path did not link pkg/b/deps"
  is_link_to "$wt/pkg/a/generated" "$primary/pkg/a/generated" || fail "(e) setup by path did not link pkg/a/generated"

  # (g) a primary link pointing into the worktree → teardown refuses to call it safe;
  #     the same shape under a scanExclude pattern is ignored
  mkdir -p "$primary/deps/.store"
  ln -s "../../.worktrees/wt/deps/.store/y" "$primary/deps/.store/y"
  ln -s "../../../.worktrees/wt/deps/.store/x" "$primary/pkg/a/deps/x"
  run "$BASH" "$self" teardown "$wt"
  [[ $rc -ne 0 ]] || fail "(g) teardown should fail while primary links point into the worktree"
  grep -q "pkg/a/deps/x" <<<"$out" || fail "(g) teardown should name the leftover link"
  ! grep -q "deps/.store/y" <<<"$out" || fail "(g) teardown should skip scanExclude matches"
  rm "$primary/pkg/a/deps/x"

  # (f) teardown → links gone, own install restored; removal then leaves the primary intact
  run "$BASH" "$self" teardown "$wt"
  [[ $rc -eq 0 ]] || fail "(f) teardown failed (rc=$rc)"
  for d in pkg/a/deps pkg/a/generated pkg/b/deps tools/c/deps; do
    [[ ! -e $wt/$d && ! -L $wt/$d ]] || fail "(f) $d still present after teardown"
  done
  [[ -d $wt/deps && ! -L $wt/deps && $(cat "$wt/deps/marker") == own ]] \
    || fail "(f) the worktree's own root deps was not restored"
  git -C "$primary" worktree remove --force "$wt"
  for d in "${dirs[@]}"; do
    [[ $(cat "$primary/$d/marker" 2>/dev/null) == primary ]] || fail "(f) worktree removal destroyed the primary's $d"
  done

  # (j) an invalid config (absolute or escaping path) is refused before anything changes
  git -C "$primary" worktree add -q "$wt2" -b wt2
  echo '{"links": ["../outside"]}' >"$scratch/bad.json"
  run env WORKTREE_LINKS_FILE="$scratch/bad.json" "$BASH" "$self" setup "$wt2"
  [[ $rc -ne 0 ]] || fail "(j) setup should refuse a path escaping the repo"
  grep -q "repo-relative" <<<"$out" || fail "(j) refusal should explain the bad entry"

  # (k) install mode (empty links): setup only copies env files; teardown is a passing no-op
  echo '{"links": [], "envFiles": ["pkg/a/.env"], "keepIfReal": [], "scanExclude": []}' >"$scratch/install.json"
  mkdir -p "$wt2/deps"
  run env WORKTREE_LINKS_FILE="$scratch/install.json" "$BASH" "$self" setup "$wt2"
  [[ $rc -eq 0 ]] || fail "(k) install-mode setup failed (rc=$rc)"
  [[ -f $wt2/pkg/a/.env ]] || fail "(k) install-mode setup did not copy pkg/a/.env"
  [[ -d $wt2/deps && ! -L $wt2/deps ]] || fail "(k) install-mode setup touched the worktree's own deps"
  [[ ! -e $wt2/pkg/b/deps ]] || fail "(k) install-mode setup created a link"
  run env WORKTREE_LINKS_FILE="$scratch/install.json" "$BASH" "$self" teardown "$wt2"
  [[ $rc -eq 0 ]] || fail "(k) install-mode teardown failed (rc=$rc)"
  [[ -d $wt2/deps ]] || fail "(k) install-mode teardown touched the worktree's own deps"

  # (l) no config file beside the script → install mode too; still refused in the primary;
  #     a WORKTREE_LINKS_FILE that does not exist is an error, not a silent install mode
  mkdir "$scratch/noconfig"
  cp "$self" "$SELF_DIR/worktree-guard.sh" "$scratch/noconfig/"
  run env -u WORKTREE_LINKS_FILE "$BASH" "$scratch/noconfig/worktree-link.sh" setup "$wt2"
  [[ $rc -eq 0 ]] || fail "(l) setup with no config file failed (rc=$rc)"
  grep -q "install mode" <<<"$out" || fail "(l) setup with no config file should report install mode"
  run env -u WORKTREE_LINKS_FILE "$BASH" "$scratch/noconfig/worktree-link.sh" setup "$primary"
  [[ $rc -ne 0 ]] || fail "(l) setup should refuse in the primary even in install mode"
  run env WORKTREE_LINKS_FILE="$scratch/missing.json" "$BASH" "$self" setup "$wt2"
  [[ $rc -ne 0 ]] || fail "(l) a missing WORKTREE_LINKS_FILE should be refused"

  # (m) nested/overlapping links are refused at config load: linking `deps` first makes
  #     `deps/sub` resolve THROUGH the link into the primary, whose real deps/sub would be moved
  #     aside and replaced by a self-referential link. A sibling that merely shares a string
  #     prefix (deps vs deps-extra) is not nested.
  local wt3="$scratch/primary/.worktrees/wt3" before
  git -C "$primary" worktree add -q "$wt3" -b wt3
  mkdir -p "$primary/deps/sub" && echo primary >"$primary/deps/sub/marker"
  before=$(snapshot "$primary")
  for d in '["deps", "deps/sub"]' '["deps/sub", "deps"]' '["deps", "deps"]'; do
    echo "{\"links\": $d}" >"$scratch/nested.json"
    run env WORKTREE_LINKS_FILE="$scratch/nested.json" "$BASH" "$self" setup "$wt3"
    [[ $rc -ne 0 ]] || fail "(m) setup should refuse nested links $d"
    grep -q "overlap" <<<"$out" || fail "(m) refusal should explain the overlapping links $d"
    [[ ! -e $wt3/deps && ! -L $wt3/deps ]] || fail "(m) setup changed the worktree before refusing $d"
  done
  [[ $(snapshot "$primary") == "$before" ]] || fail "(m) nested-links setup changed the primary"
  echo '{"links": ["deps", "deps-extra"]}' >"$scratch/sibling.json"
  rc=0; out=$(WORKTREE_LINKS_FILE="$scratch/sibling.json" load_config 2>&1) || rc=$?
  [[ $rc -eq 0 ]] || fail "(m) a sibling sharing a string prefix (deps, deps-extra) is not nested (rc=$rc)"

  # (n) a symlinked PARENT component in the worktree that points into the primary: setup must
  #     not mv/ln through it (the primary's real pkg/a/deps would be moved aside and replaced
  #     by a self-referential link), nor teardown rm through it (deleting the primary's own
  #     pkg/l/deps link) or copy an env file through it. The primary stays byte-identical.
  mkdir -p "$primary/pkg/l" && ln -s ../a/deps "$primary/pkg/l/deps"
  ln -s "$primary/pkg" "$wt3/pkg"
  before=$(snapshot "$primary")
  echo '{"links": ["pkg/a/deps"]}' >"$scratch/parent.json"
  run env WORKTREE_LINKS_FILE="$scratch/parent.json" "$BASH" "$self" setup "$wt3"
  [[ $rc -ne 0 ]] || fail "(n) setup should refuse a links path under a symlinked parent"
  grep -q "outside the worktree" <<<"$out" || fail "(n) setup refusal should say the path resolves outside the worktree"
  [[ $(snapshot "$primary") == "$before" ]] || fail "(n) setup through a symlinked parent changed the primary"
  echo '{"links": [], "envFiles": ["pkg/b/.env"]}' >"$scratch/parent-env.json"
  echo "SECRET=2" >"$scratch/b.env"
  mkdir -p "$scratch/elsewhere/b" && rm "$wt3/pkg" && ln -s "$scratch/elsewhere" "$wt3/pkg"
  cp "$scratch/b.env" "$primary/pkg/b/.env"
  before=$(snapshot "$primary")
  run env WORKTREE_LINKS_FILE="$scratch/parent-env.json" "$BASH" "$self" setup "$wt3"
  [[ $rc -ne 0 ]] || fail "(n) setup should refuse an envFiles path under a symlinked parent"
  [[ ! -e $scratch/elsewhere/b/.env ]] || fail "(n) setup copied an env file through a symlinked parent"
  rm "$wt3/pkg" && ln -s "$primary/pkg" "$wt3/pkg"
  echo '{"links": ["pkg/l/deps"]}' >"$scratch/parent-td.json"
  run env WORKTREE_LINKS_FILE="$scratch/parent-td.json" "$BASH" "$self" teardown "$wt3"
  [[ $rc -ne 0 ]] || fail "(n) teardown should refuse a links path under a symlinked parent"
  grep -q "outside the worktree" <<<"$out" || fail "(n) teardown refusal should say the path resolves outside the worktree"
  [[ -L $primary/pkg/l/deps ]] || fail "(n) teardown removed the primary's own pkg/l/deps link"
  [[ $(snapshot "$primary") == "$before" ]] || fail "(n) teardown through a symlinked parent changed the primary"

  echo "self-test OK"
}

if [[ "${1:-}" == "--self-test" ]]; then
  run_self_test
  exit 0
fi
case "${1:-}" in
  setup) setup "${2:-$PWD}" ;;
  teardown) teardown "${2:-$PWD}" ;;
  *) echo "usage: worktree-link.sh setup|teardown [<worktree-path>] | --self-test" >&2; exit 1 ;;
esac
