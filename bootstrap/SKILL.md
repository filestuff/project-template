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
commands; full tier only — where the schema/migrations live (for `claims-tokens.json`;
"none" is valid).

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
   and adds the scripts + `ROADMAP.md`).
3. `chmod +x scripts/sprint/*.sh`.

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
- Full tier: write `scripts/sprint/claims-tokens.json` from the schema answer — always a
  `deps` token (manifest + lockfile); a `schema` token if applicable; drop the REPLACE
  placeholders entirely if a token doesn't apply.
- Default branch ≠ main: add to `.claude/settings.json`:
  `"env": { "SPRINT_MAIN_BRANCH": "<branch>" }`.

## Step 6: CLAUDE.md merge

- **Absent**: create `CLAUDE.md` from `TEMPLATE/lite/CLAUDE.project-block.md` (placeholders
  already known — apply them). If `AGENTS.md` exists, prepend `@AGENTS.md` as the first line.
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

- Lite: `bash -n scripts/sprint/gate.sh`; the four sprint dirs + `.gitkeep`s exist.
- Full, additionally:
  - `scripts/sprint/lock.sh status` prints `FREE`
  - `node scripts/sprint/regen.mjs --check` exits 0 (empty skeleton is current)
  - `node scripts/sprint/frontmatter.mjs get docs/sprints/SPRINT_TEMPLATE.md sprint`
    prints `"S-NNN"`

Any failure: fix before offering the commit.

## Step 10: Offer commit

`chore: install project-template (<tier>) — sprint workflow, ADRs, doc health`

Then suggest next steps: `/plan` to seed the backlog from a plan document, or
`/sprint create` for the first sprint.

---

## Upgrade (lite → full)

1. **Require `docs/sprints/in-progress/` empty** — a lite sprint in flight must close first
   (or the user explicitly accepts registering it by hand afterward).
2. Copy `TEMPLATE/full-overlay/` contents over the repo; `chmod +x scripts/sprint/*.sh`;
   re-apply the `{{PROJECT_NAME}}` / `{{PACKAGE_MANAGER}}` placeholders to the three
   overwritten/added markdown files (PROTOCOL.md, INDEX.md, ROADMAP.md, sprint SKILL.md) and
   re-run the step-4 grep check.
3. Migrate INDEX content: the lite INDEX's hand-maintained Done/Backlog rows move into the
   marker skeleton — Done rows into the LLM-maintained Done table; Backlog/In-Progress rows
   are regenerated from frontmatter, so just verify, don't transcribe.
4. Ensure every backlog sprint file has a `touches: []` field (the lite template already
   includes it; add if missing).
5. Write `scripts/sprint/claims-tokens.json` (ask the schema/deps questions from step 1).
6. `node scripts/sprint/regen.mjs` — populates the generated blocks from the existing sprint
   files (the tiers share frontmatter shape, so this just works).
7. Run the step-9 full-tier validation.
8. Offer commit: `chore: upgrade project-template lite → full`.
