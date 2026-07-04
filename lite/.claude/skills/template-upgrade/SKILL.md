---
name: template-upgrade
description: >
  Upgrade this repo's installed project-template workflow (sprint kanban, skills,
  scripts) to the latest released template version — fetch, re-render, three-way
  merge, migrations, validation, commit. Use when asked to "upgrade the template",
  "update project-template", or when a "template update available" notice appears.
argument-hint: ""
allowed-tools: "Read Edit Write Glob Grep Bash AskUserQuestion"
---

# Template Upgrade Skill

Upgrades the installed project-template payload in place. The engine is
`scripts/template/upgrade.mjs` (subcommands: `fetch`, `render`, `plan`, `apply`,
`merge-claude-block`, `merge-settings`, `hash`; exit codes: 0 ok, 2 conflicts,
3 needs-input, 1 error). State lives under `<git-dir>/template-update/` — call it
STATE below (`STATE=$(git rev-parse --git-dir)/template-update`). The installed
manifest is `.claude/template-manifest.json` — MANIFEST below.

Never run this inside a sprint worktree — operate on the primary checkout, on the
main branch.

## Step 1: Preflight

1. MANIFEST must exist. If not, this repo predates manifests — stop and point the
   user at `/bootstrap-project`'s **Adopt (existing installs)** section.
2. `git status --porcelain` must be empty. If not, offer to `git stash` (and pop
   after Step 12) or abort.
3. If `STATE/upgrade-journal` exists, a previous apply was interrupted. Offer:
   - **Resume**: re-run `apply` with the same `STATE/plan.json` and the same
     `--old/--new` render dirs (journaled entries are skipped automatically), then
     continue from Step 7.
   - **Abort**: `git checkout --` every dest path listed in `STATE/plan.json`,
     then delete `STATE/upgrade-journal` and `STATE/plan.json`, and start fresh.

## Step 2: Check

Run `bash scripts/template/update-check.sh --force`.

- No output → report "up to date — project-template v<manifest version>" and stop.
- `UPGRADE_AVAILABLE <old> <new> <sha>` → record OLD_VERSION, NEW_VERSION, NEW_SHA
  and continue. (`JUST_UPGRADED` here means a stale marker; treat as up to date.)

## Step 3: Fetch both versions

Work dir: `STATE/work/`.

```
node scripts/template/upgrade.mjs fetch <MANIFEST template.commit> "$STATE/work/old"
node scripts/template/upgrade.mjs fetch <NEW_SHA> "$STATE/work/new"
```

If the OLD fetch fails (rewritten upstream history — the pinned SHA is gone), warn
the user and switch to **degraded mode**: skip `plan`/`apply` (no merge base) and
instead, after rendering the NEW version in Step 6, treat every file that differs
from the local copy as needs-review — show the new-vs-local diff per file and ask
keep local / take new for each. Everything else (Steps 4, 5, 7–12) still applies.

## Step 4: Show what's new, ask

Parse `STATE/work/new/CHANGELOG.md` and collect the entries for versions in
(OLD_VERSION, NEW_VERSION] — newest first. Print 5–7 user-facing bullets. Then
AskUserQuestion:

- **Upgrade now** → continue.
- **Not now** → `bash scripts/template/update-check.sh --snooze`, stop.
- **Never ask** → set `"updateCheck": false` in MANIFEST, offer to commit that
  one-line change (`chore: disable template update checks`), stop.

## Step 5: New placeholders

Diff the placeholder keys of `STATE/work/old/template.config.json` vs
`STATE/work/new/template.config.json`. For each key present only in NEW, ask the
user for a value (use the key's `prompt`) and store it in MANIFEST's
`placeholders` map **before** rendering — `render` substitutes every stored token
and exits 3 on unknown leftovers.

## Step 6: Render, plan, apply

Render both versions with the (possibly updated) MANIFEST. Keep the two render
trees in separate parents — `render` writes sidecars (`template.config.json`,
`VERSION`, `claude-block.md`) next to `--out`, and `plan`/`apply` read the NEW
sidecars from there:

```
node scripts/template/upgrade.mjs render "$STATE/work/old" --manifest .claude/template-manifest.json --out "$STATE/work/old-render/files"
node scripts/template/upgrade.mjs render "$STATE/work/new" --manifest .claude/template-manifest.json --out "$STATE/work/new-render/files"
```

Exit 3 → the error lists unresolved tokens; ask the user for each value, add to
MANIFEST placeholders, re-run the render.

```
node scripts/template/upgrade.mjs plan --old "$STATE/work/old-render/files" --new "$STATE/work/new-render/files" --manifest .claude/template-manifest.json
node scripts/template/upgrade.mjs apply --plan "$STATE/plan.json" --old "$STATE/work/old-render/files" --new "$STATE/work/new-render/files" --manifest .claude/template-manifest.json --new-version <NEW_VERSION> --new-commit <NEW_SHA>
```

Always pass `--new-version`/`--new-commit` explicitly. Then walk apply's JSON
output:

- `applied` / `merged-clean` / `added` → report counts, nothing to do.
- `conflicts` with a three-way reason → the file now contains standard conflict
  markers and is journaled (a re-run will NOT re-merge it). Per file,
  AskUserQuestion: **keep local** (`git checkout -- <file>` — preflight
  guaranteed HEAD == pre-upgrade local), **take new**
  (`cp "$STATE/work/new-render/files/<dest>" <dest>`), or **leave markers** to
  hand-resolve now.
- `conflicts` with reason `added-conflict` (not journaled) → show the local-vs-new
  diff, ask: **take new** (copy it over, then set the file's MANIFEST entry:
  class `managed`, `renderHash` = `upgrade.mjs hash` of the new-render copy) or
  **keep local** (set `"ignored": true` on its MANIFEST entry so future plans
  skip it).
- `removed` → apply never deletes. List them; per file ask **delete**
  (`git rm <file>`, drop its MANIFEST entry) or **keep** (set `"ignored": true`
  on the MANIFEST entry).

## Step 7: Merged-class files

```
node scripts/template/upgrade.mjs merge-claude-block --rendered "$STATE/work/new-render/claude-block.md"
node scripts/template/upgrade.mjs merge-settings --new "$STATE/work/new-render/files/.claude/settings.json"
```

`merge-claude-block` exit 3 means CLAUDE.md is missing its
`<!-- BEGIN project-template -->` / `<!-- END project-template -->` markers —
show the user the rendered block and where the markers should wrap it, let them
place the markers (or paste the block manually), then re-run.

## Step 8: Migrations

List `STATE/work/new/migrations/v*.sh`; select those whose version v satisfies
OLD_VERSION < v <= NEW_VERSION (numeric semver compare, e.g. `sort -V`); run in
ascending order. Skip any with an existing
`STATE/migrations/vX.Y.Z.done` marker. For each, from the repo root:

```
TEMPLATE_OLD_VERSION=<old> TEMPLATE_NEW_VERSION=<new> \
TEMPLATE_TIER=<manifest tier> TEMPLATE_DIR="$STATE/work/new" \
REPO_ROOT="$(git rev-parse --show-toplevel)" \
JOURNAL_FILE="$STATE/migrations/vX.Y.Z.journal" \
bash "$STATE/work/new/migrations/vX.Y.Z.sh"
```

(`mkdir -p "$STATE/migrations"` first.) Exit 0 → `touch` the `.done` marker
beside the journal. Non-zero → **non-fatal**: report the failure, leave no
`.done` marker (it retries on the next upgrade), and keep running the remaining
migrations.

## Step 9: CI-hygiene audit

Run the same audit bootstrap performs at install time — one line: propose
`paths-ignore` and `concurrency` patches for the repo's `.github/workflows/`,
offered via a grouped question, never auto-applied. Follow the full procedure in
`STATE/work/new/bootstrap/SKILL.md`, **Step 9.5** (the fetched new template tree
contains it).

## Step 10: Finalize state

- Write OLD_VERSION into `STATE/just-upgraded-from` (update-check turns this into
  a one-time JUST_UPGRADED notice).
- Delete `STATE/last-check`, `STATE/update-snoozed`, `STATE/upgrade-journal`,
  `STATE/plan.json`, and the whole `STATE/work/` dir.

## Step 11: Validate

- `bash -n` every `scripts/sprint/*.sh` and `scripts/template/*.sh`.
- Full tier additionally: `scripts/sprint/lock.sh status` prints `FREE`;
  `node scripts/sprint/regen.mjs --check` exits 0;
  `node scripts/sprint/claims.mjs waves` runs clean.
- No leftover placeholder tokens: `grep -rnE '\{\{' <file...>` over exactly the
  files listed in MANIFEST's `files` map (not the whole repo — the repo's own
  code may legitimately contain doubled braces) must return nothing.

Any failure: fix before offering the commit (a validation failure after apply is
an upgrade bug — investigate, don't paper over).

## Step 12: Commit

First, refuse-check: `grep -l '^<<<<<<< '` over every plan-touched file (the
dest paths in the apply output). Any hit → **refuse to commit**, list the files
still carrying conflict markers, and stop — the user resolves and re-invokes, or
commits manually.

Clean → commit everything the upgrade touched (including MANIFEST):

```
chore: upgrade project-template v<OLD_VERSION> → v<NEW_VERSION>
```

If Step 1 stashed local changes, remind the user to `git stash pop`.
