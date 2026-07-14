---
name: bootstrap-project
description: >
  Install the reusable project workflow (sprint kanban, /sprint /plan /adr skills,
  DOC_HEALTH, ADRs, commit gate; full tier adds parallel-sprint machinery) from
  ~/Documents/code_base_master/project-template into a target repo. Use when asked to
  "bootstrap a project", "set up the sprint workflow", "install the project template",
  or "upgrade to the full sprint tier" (--upgrade).
argument-hint: "[target-path] [--upgrade]"
allowed-tools: "Read Edit Write Glob Grep Bash AskUserQuestion"
---

# Bootstrap Project Skill

Installs the project-template workflow into a target repo. The template lives at
`~/Documents/code_base_master/project-template` (TEMPLATE below); read its
`template.config.json` first — it is the placeholder manifest this skill executes.

If invoked with `--upgrade`, skip to **Upgrade (lite → full)** at the bottom.

## Step 1: Interrogate (detection first, then one grouped AskUserQuestion)

Detect before asking:
- Target path: the argument, else cwd.
- Existing repo? `git rev-parse --is-inside-work-tree`.
- Package manager: lockfile present (`pnpm-lock.yaml` → pnpm, `package-lock.json` → npm,
  `yarn.lock` → yarn, `Cargo.lock` → cargo, `uv.lock`/`poetry.lock` → that tool; none →
  ask).
- Gate commands: propose from `package.json` scripts (lint/test/typecheck) or the stack's
  conventional commands; the user edits/confirms.
- Default branch: `git symbolic-ref --short refs/remotes/origin/HEAD` (fallback: current
  branch). Only surface it if ≠ `main`.

Then ask (grouped): project name; one-line description; tier (lite = one sprint at a time,
no extra machinery; full = parallel agents, file claims, lock, worktrees); confirm gate
commands; the cheap **pre-push** checks (the fast subset of CI to run on every push — propose
the project's quickest structural/lint checks, mirroring the CI steps that most often go red,
e.g. lint/typecheck/unit; catching a failure locally is the top CI-cost lever, since a red push
re-runs the whole workflow. "none" → a gitleaks-only pre-push gate); full
tier only — where the schema/migrations live (for `claims-tokens.json`; "none" is valid).

## Step 2: Preflight

- New directory → `git init`.
- **Refuse** if `docs/sprints/` or `.claude/skills/sprint/` already exists — offer
  `--upgrade` (lite→full) or manual cleanup instead. Never overwrite an installed workflow.
- Note whether `CLAUDE.md`, `AGENTS.md`, `.claude/settings.json` exist (steps 6/8 handle
  merging).

## Step 3: Copy

1. Copy `TEMPLATE/lite/` contents into the repo root — **except** `CLAUDE.project-block.md`
   (handled in step 6).
2. Full tier: copy `TEMPLATE/full-overlay/` contents on top (it overwrites
   `docs/sprints/PROTOCOL.md`, `docs/sprints/INDEX.md`, `.claude/skills/sprint/SKILL.md`
   and adds the scripts, `ROADMAP.md` (with its Parallel Waves block), and
   `docs/sprints/ORCHESTRATION.md`).
3. `chmod +x scripts/sprint/*.sh scripts/template/*.sh` (the `postCopy.chmod+x` globs in
   `template.config.json`).

## Step 4: Replace placeholders (deterministic)

For each placeholder in `template.config.json`, literal find/replace in exactly the listed
files (skip files not present in the chosen tier). Then the hard check:

```
grep -rn '{{' docs/ .claude/ scripts/ CLAUDE.md 2>/dev/null
```

must return **nothing**. If it returns anything, fix before proceeding — a leftover
placeholder is a bootstrap bug, not a cosmetic issue.

## Step 5: Per-project files

- `scripts/sprint/gate.sh` already received `{{GATE_COMMANDS}}` in step 4 — verify it runs
  (`bash -n scripts/sprint/gate.sh`).
- `scripts/sprint/pre-push-gate.sh` already received `{{PREPUSH_GATE_COMMANDS}}` in step 4 (if
  the user said "none", replace the placeholder with `:` so the gate stays valid and runs
  gitleaks only). Then **wire it up as an actual pre-push hook**, by stack:
  - Node + husky (`.husky/` present): add/append a `.husky/pre-push` that runs
    `scripts/sprint/pre-push-gate.sh "$@"`.
  - Otherwise: `git config core.hooksPath` to a hooks dir containing a `pre-push` that calls
    it, or drop a thin executable `.git/hooks/pre-push` wrapper
    (`exec "$(git rev-parse --show-toplevel)/scripts/sprint/pre-push-gate.sh" "$@"`).
  Offer to do the wiring based on the detected stack; otherwise print the one-liner for the user.
- Full tier: write `scripts/sprint/claims-tokens.json` from the schema answer — always a
  `deps` token (manifest + lockfile); a `schema` token if applicable; drop the REPLACE
  placeholders entirely if a token doesn't apply.
- Default branch ≠ main: add to `.claude/settings.json`:
  `"env": { "SPRINT_MAIN_BRANCH": "<branch>" }`.

## Step 5.5: Write the installed manifest

Write `.claude/template-manifest.json` — the record `scripts/template/update-check.sh` and
`/template-upgrade` operate on. It MUST be written **now**: after the copy (step 3) and
placeholder substitution (steps 4–5), but **before** semantic seeding (step 7). Seeding
rewrites DOC_HEALTH/PROTOCOL/review-skill content; hashing those files *after* seeding
would make the seeded state look like the pristine render, so a future upgrade would
treat template-side changes to them as clean overwrites and clobber the seeded content.
Hashed pre-seeding, the seeded edits register as local modifications — which the
upgrade's three-way merges preserve.

1. Read `TEMPLATE/VERSION` and `git -C TEMPLATE rev-parse HEAD`. Warn if the template
   checkout is dirty (`git -C TEMPLATE status --porcelain` non-empty) or ahead of
   `origin/main` (`git -C TEMPLATE rev-list origin/main..HEAD --count` > 0) —
   update-check and `/template-upgrade` fetch from GitHub, so a manifest pinned to an
   unpushed commit can't be used as a merge base until the template is pushed.
2. Write the manifest:

   ```json
   {
     "configVersion": 2,
     "template": { "version": "<VERSION>", "commit": "<40-hex HEAD sha>", "repo": "<templateRepo from template.config.json>" },
     "tier": "<lite|full>",
     "updateCheck": true,
     "placeholders": { "{{PROJECT_NAME}}": "...", "{{PROJECT_DESCRIPTION}}": "...", "{{GATE_COMMANDS}}": "...", "{{PREPUSH_GATE_COMMANDS}}": "...", "{{PACKAGE_MANAGER}}": "..." },
     "files": { "<destPath>": { "source": "lite/<destPath> | full-overlay/<destPath>", "class": "managed", "renderHash": "<sha256>" } }
   }
   ```

   - `placeholders`: the **actual substituted values** (e.g. `:` if the user said "none"
     for pre-push checks) — upgrades re-render both template versions with exactly these.
   - `files`: one entry per file copied in step 3 (excluding `CLAUDE.project-block.md`),
     keyed by dest path relative to the repo root; `source` is its template-relative
     origin (full tier: `full-overlay/...` for files the overlay provided/overwrote).
     `source` is informational only (nothing reads it back): entries added later by
     `/template-upgrade` legitimately omit it, and may carry an explicit
     `"ignored": false` — both are normal, not corruption.
     `class` comes from `template.config.json` `fileClasses` (`seeded` list / `merged`
     map); everything else is `managed`.
   - `renderHash` = `node scripts/template/upgrade.mjs hash <destPath>` for every entry,
     computed at this point.

## Step 6: CLAUDE.md merge

The `<!-- BEGIN project-template -->` / `<!-- END project-template -->` markers are
load-bearing: `/template-upgrade` (`upgrade.mjs merge-claude-block`) greps for exactly
those two literals to swap the block on upgrades. **Both paths below must emit them.**

- **Absent**: create `CLAUDE.md` containing the block from
  `TEMPLATE/lite/CLAUDE.project-block.md` (placeholders already known — apply them),
  wrapped in the same markers as below. If `AGENTS.md` exists, prepend `@AGENTS.md` as
  the first line (above the BEGIN marker).
- **Present**: append the block wrapped in markers, never modifying existing content:

  ```
  <!-- BEGIN project-template -->
  ...block (drop the duplicate H1 if the file already has one)...
  <!-- END project-template -->
  ```

  Show the user the diff before writing.

## Step 7: Seed semantic content (LLM judgment — the only non-deterministic step)

Scan `README.md` and `docs/*.md` (top level only) for pre-existing documentation:
- Add a "Needs review" row per doc to `docs/DOC_HEALTH.md`.
- Seed the tag→doc table in `docs/sprints/PROTOCOL.md` (replace the
  `<!-- BOOTSTRAP: ... -->` starter rows with real mappings; keep tags aligned with
  SPRINT_TEMPLATE's starter tags).
- If the repo has established conventions (an `AGENTS.md`, a style doc), seed the
  "Project-Specific Checks" section of `.claude/skills/review/SKILL.md` with 3–5 concrete,
  checkable rules; otherwise leave its `_(none yet)_` stub.
- Show the user the tables for confirmation.

## Step 8: settings.json merge

- Absent → the copied skeleton stands.
- Pre-existing → union the `permissions.allow` arrays (copied skeleton ∪ existing), keep all
  other existing keys, show the diff, ask before writing.

## Step 9: Validate

- Lite: `bash -n scripts/sprint/gate.sh` and `bash -n scripts/sprint/pre-push-gate.sh`; the
  four sprint dirs + `.gitkeep`s exist.
- Manifest (all tiers):
  - `.claude/template-manifest.json` parses
    (`node -e 'JSON.parse(require("fs").readFileSync(".claude/template-manifest.json","utf8"))'`)
  - every key in its `files` map exists on disk
  - `bash -n scripts/template/update-check.sh`
  - `bash scripts/template/update-check.sh` prints **nothing** (a fresh install is
    current; any output here means the manifest version/repo is wrong).
- Full, additionally:
  - `bash -n scripts/sprint/unstart.sh` and `bash -n scripts/sprint/reserve-wave.sh`
  - `scripts/sprint/lock.sh status` prints `FREE`
  - `node scripts/sprint/regen.mjs --check` exits 0 (empty skeleton is current — this also
    covers the ROADMAP Parallel Waves block)
  - `node scripts/sprint/claims.mjs waves` runs clean (prints `no pending sprints` on the empty
    skeleton)
  - `node scripts/sprint/frontmatter.mjs get docs/sprints/SPRINT_TEMPLATE.md sprint`
    prints `"S-NNN"`
  - `node scripts/sprint/frontmatter.mjs get docs/sprints/SPRINT_TEMPLATE.md plan_date`
    prints `null`

Any failure: fix before offering the commit.

## Step 9.5: CI-hygiene audit (offer, never auto-apply)

<!-- NOTE for /template-upgrade: the upgrade skill should run this same audit on every version upgrade. -->

1. If the target repo has no `.github/workflows/` directory, skip this step silently.
2. For each `*.yml`/`*.yaml` workflow with a `push:` trigger on the default branch, detect:
   - path filtering: presence of `paths:` or `paths-ignore:` under that push trigger;
   - a `concurrency:` block (top-level or per-job);
   - deploy-ish character: workflow name or steps matching
     `deploy|publish|release|docker.*push|image` (case-insensitive) — these must never be
     cancelled mid-run.
3. Build proposed patches and show a per-workflow diff, then ONE grouped AskUserQuestion
   (apply all / pick individually / skip):
   - **No path filter at all** → add under the push trigger:
     ```yaml
     paths-ignore:
       - "docs/**"
       - "**/*.md"
       - "**/*.mdx"
       - ".claude/**"
     ```
     NEVER add `paths-ignore` to a trigger that already has `paths:` — they are mutually
     exclusive; leave those workflows alone (their allowlist already filters).
   - **No `concurrency:`** → build/test workflows get:
     ```yaml
     concurrency:
       group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
       cancel-in-progress: true
     ```
     deploy/publish workflows get the same `group` with `cancel-in-progress: false`. Note the
     semantics: a concurrency group holds at most one running plus one pending run — a newly
     queued run REPLACES the previously pending one even with `cancel-in-progress: false`, so
     burst pushes collapse either way; `false` only protects the in-flight run from a
     mid-publish abort.
   - **`schedule:` triggers** → report the cron cadence and a rough monthly-minutes estimate,
     suggest the user consider reducing cadence — informational only, no patch.
   - **Redundant full builds** → if two or more jobs each run a full app build (`next build`,
     `vite build`, etc.) on the same push/PR trigger, OR a full build duplicates one the repo's
     deploy platform (Vercel/Netlify/Render/Fly) already runs on that same trigger, report it
     with a rough per-run minutes estimate. Informational only, no patch — dropping a build can
     remove real coverage (a second engine catches errors the other misses; a CI gate fails
     louder and earlier than a failed deploy). Surface the trade-off; let the user decide.
4. Rationale: the sprint ledger commits carry `[skip ci]` and waves batch pushes, but code
   pushes and pre-existing unfiltered workflows still burn minutes — this audit is the
   downstream repo's defense. Patches are proposed and confirmed via the grouped question
   above; never applied silently.

## Step 10: Offer commit

`chore: install project-template (<tier>) — sprint workflow, ADRs, doc health`

Then suggest next steps: `/plan` to seed the backlog from a plan document (it now splits work
for parallel agents), or `/sprint create` for the first sprint. Mention `/debug` (root-cause a
failure before fixing) and — full tier — `/sprint wave` to fan a parallel wave of independent
sprints out to subagents.

---

## Upgrade (lite → full)

1. **Require `docs/sprints/in-progress/` empty** — a lite sprint in flight must close first
   (or the user explicitly accepts registering it by hand afterward).
1.5. **Require the installed template version to be current.** Compare the manifest's
   `template.version` against `TEMPLATE/VERSION`; if behind, stop and tell the user to run
   `/template-upgrade` first — tier-upgrading from a stale version would install a
   full-overlay newer than the lite base and desync the manifest's merge base. (No manifest
   at all → run the **Adopt** section below first.)
2. Copy `TEMPLATE/full-overlay/` contents over the repo; `chmod +x scripts/sprint/*.sh`;
   re-apply the `{{PROJECT_NAME}}` / `{{PACKAGE_MANAGER}}` placeholders to the overwritten/added
   markdown files (PROTOCOL.md, INDEX.md, ROADMAP.md, ORCHESTRATION.md, sprint SKILL.md) and
   re-run the step-4 grep check.
3. Migrate INDEX content: the lite INDEX's hand-maintained Done/Backlog rows move into the
   marker skeleton — Done rows into the LLM-maintained Done table; Backlog/In-Progress rows
   are regenerated from frontmatter, so just verify, don't transcribe.
4. Ensure every backlog sprint file has a `touches: []` field (the lite template already
   includes it; add if missing). Do **not** backfill `plan_date` into existing sprint files —
   a missing/null `plan_date` degrades gracefully to `⚠ unplanned` in the waves output, which
   is correct (those sprints were never certified by `/sprint plan`); mechanically stamping a
   date would defeat the readiness gate. They get certified per-sprint by `/sprint plan` or
   the `/sprint wave` planning pass.
5. Write `scripts/sprint/claims-tokens.json` (ask the schema/deps questions from step 1).
5.5. **Update the manifest**: set `"tier": "full"`; add/overwrite a `files` entry for every
   file full-overlay provided or overwrote (`source: "full-overlay/..."`), with a fresh
   `renderHash` (`node scripts/template/upgrade.mjs hash <destPath>`) computed now — after
   the placeholder re-apply in step 2, before regen writes generated content in step 6
   (same pre-seeding rationale as Step 5.5 of the install flow).
6. `node scripts/sprint/regen.mjs` — populates the generated blocks from the existing sprint
   files (the tiers share frontmatter shape, so this just works).
7. Run the step-9 full-tier validation (including the manifest checks).
7.5. Run the Step 9.5 CI-hygiene audit (workflows may have been added since bootstrap).
8. Offer commit: `chore: upgrade project-template lite → full`.

---

## Adopt (existing installs — retrofit a manifest)

For repos bootstrapped **before** manifests existed: they have the workflow
(`docs/sprints/`, `.claude/skills/sprint/`) but no `.claude/template-manifest.json`, so
update checks and `/template-upgrade` can't run. Retrofit one:

1. **Preflight**: workflow present, manifest absent, `git status` clean. Detect the tier
   (`scripts/sprint/lock.sh` present → full, else lite).
2. **Ask** (grouped): confirm tier; the five placeholder values (detect where possible —
   project name from CLAUDE.md, gate commands from `scripts/sprint/gate.sh`, pre-push from
   `scripts/sprint/pre-push-gate.sh`, package manager from the lockfile); and which template
   version/commit was approximately installed (show `git -C TEMPLATE log --oneline -10` to
   jog memory; default: current template HEAD + `TEMPLATE/VERSION`).
3. **Write the manifest** (schema in Step 5.5 of the install flow) with that version/commit,
   `updateCheck: true`, and the answered placeholders.
4. **Compute renderHashes from a fresh render of THAT version** — not from the current local
   files. In a temp dir: `upgrade.mjs fetch <commit> <tmp>/old` then
   `upgrade.mjs render <tmp>/old --manifest .claude/template-manifest.json --out <tmp>/render/files`,
   and set each entry's `renderHash` to the hash of the rendered file. **Why this way**:
   `plan` treats `localHash === renderHash` as *clean-overwrite* (silent replace by the new
   version). Hashing the CURRENT local files would stamp every local customization as
   "pristine", so the first `/template-upgrade` would silently clobber them all. Hashing a
   pristine render of the adopted version means customized files hash-mismatch → *three-way*
   merge, which preserves local edits and surfaces genuine conflicts — even if the user's
   version guess was slightly off, a wrong merge base degrades to visible conflict markers,
   never to silent data loss. If the fetch/render of that version fails, set every
   `renderHash` to the sentinel `"adopted-unverified"` — nothing matches, so every changed
   file goes three-way (the safe default).
   Files present locally but not in that version's render (repo-local additions): leave them
   out of `files` entirely. Files in the render but deleted locally: add the entry with
   `"ignored": true`.
5. **Ensure the update machinery exists**: pre-manifest installs lack
   `scripts/template/update-check.sh` / `upgrade.mjs` — copy them from the rendered tree
   (or `TEMPLATE/lite/scripts/template/`), `chmod +x scripts/template/*.sh`.
6. **Ensure CLAUDE.md has the markers** (`<!-- BEGIN project-template -->` /
   `<!-- END project-template -->`) — `merge-claude-block` needs them. If absent, show the
   user the template-derived section of their CLAUDE.md and offer to wrap it.
7. Run the Step 9 manifest checks. Note: `update-check.sh` may immediately print
   `UPGRADE_AVAILABLE` if the adopted version is behind — that is correct, not a failure.
8. Offer commit: `chore: adopt project-template manifest (v<version>)` — then suggest
   `/template-upgrade` to catch up.
