# project-template

A reusable AI-agent-driven project workflow, extracted from the `ai-todo` project. It gives any
repo a sprint kanban (`/sprint`), plan breakdown (`/plan`), Architecture Decision Records
(`/adr`), a documentation staleness tracker (`DOC_HEALTH.md`), versioned in-place upgrades
(`/template-upgrade`), and — in the full tier — the machinery for **multiple Claude Code
agents running sprints in parallel** (`/sprint wave`: file claims, a main-branch mutex,
per-sprint git worktrees, planner/executor subagents, generated kanban/roadmap blocks) and
for **driving serial sprint chains autonomously** (`/sprint train`: one worktree for the
whole chain, front-loaded decisions, landings batched into one CI push per few sprints).

**Requirements:** [Claude Code](https://claude.com/claude-code) (the skills and agents are
Claude Code skills), git, bash. Node ≥ 18 for the full tier and for `/template-upgrade`
(the `.mjs` helper scripts).

## Install

Run `/bootstrap-project` in a Claude Code session inside (or pointed at) the target repo. It
asks the questions, copies the right tier, fills placeholders, merges CLAUDE.md/settings.json
safely, and validates the result. Manual install: copy `lite/` into the repo root, then (for
full) copy `full-overlay/` over it, replace every `{{PLACEHOLDER}}` (see
`template.config.json`), and `chmod +x scripts/sprint/*.sh`.

## Workflow at a glance

1. **Plan** a feature however you like (design doc, proposal, conversation), ideally review it
   (e.g. an external plan-review skill), then run `/plan` — it challenges scope against the
   decision ladder, cuts the plan into sprint files in `docs/sprints/backlog/` with
   dependencies, story points, and Produces/Consumes interface contracts, and won't commit
   until every source-plan requirement maps to a sprint.
2. **Certify** a sprint just before working it: `/sprint plan S-NNN` deepens the file to an
   executable brief (exact paths, verified `file:line` citations, no placeholders, a
   fresh-reader pre-mortem) and stamps `plan_date`. Uncertified sprints still run — you just
   get warned.
3. **Execute**: `/sprint start S-NNN` → implement → `/sprint done S-NNN` (acceptance evidence,
   doc sync, ADR check). `/sprint board` shows the kanban; `/sprint next` suggests what's
   unblocked.
4. **Full tier, in parallel**: `/sprint wave` computes the next conflict-free wave from file
   claims, fans out one planner subagent per stale/unplanned member, then one executor
   subagent per sprint — each in its own git worktree, serialized on `main` by a lock.
   Brief failures feed back into `docs/sprints/PLANNING_LEARNINGS.md` so plans stop failing
   the same way twice.
5. **Full tier, in series**: when the backlog is a chain that can't parallelize,
   `/sprint train S-A S-B …` runs it autonomously — all decisions batched upfront, one
   executor at a time in a single shared worktree, landings checkpointed every 3 sprints
   into one merge + one CI run (instead of one per sprint).

The sprint file is the executor's **entire brief** — every gate above exists to make that
single file sufficient for an agent (or developer) with zero conversation context.

## Tiers

| | lite | full |
|---|---|---|
| Sprint kanban (`backlog/ → in-progress/ → done/`) | ✅ | ✅ |
| `/sprint`, `/plan`, `/adr` skills | ✅ | ✅ |
| `/review`, `/explain-changes`, `/code-simplifier`, `/debug` skills + `reviewer` agent | ✅ | ✅ |
| `DOC_HEALTH.md` staleness gate, `TODOS.md` ledger, ADRs | ✅ | ✅ |
| Commit gate (`scripts/sprint/gate.sh`, single source of truth) | ✅ | ✅ |
| Update checks + `/template-upgrade` (three-way merge, migrations) | ✅ | ✅ |
| Planning gates (scope challenge, coverage map, readiness checklist, `PLANNING_LEARNINGS.md` loop) | ✅ | ✅ |
| Concurrent sprints | one at a time | many, in parallel agents |
| Wave orchestration (`/sprint wave` + `sprint-planner`/`sprint-executor`/`wave-planner` agents) | — | ✅ |
| Serial-train orchestration (`/sprint train`: shared worktree, batched CI checkpoints) | — | ✅ |
| File claims (`touches:` + `claims.mjs`) | — | ✅ |
| Main-branch mutex (`lock.sh`) | — | ✅ |
| Per-sprint git worktrees | — | ✅ |
| Generated INDEX/ROADMAP blocks (`regen.mjs`, Mermaid dep graph) | — | ✅ |
| INDEX.md maintenance | by hand (tiny) | regenerated |
| PROTOCOL.md size | ~165 lines | ~400 lines |

Start lite. Upgrade later with `/bootstrap-project --upgrade` (requires an empty
`in-progress/`); the tiers share frontmatter shape, so the full tooling picks up existing
sprint files as-is.

## Layout

- `lite/` — the complete base payload **shared by both tiers** (a lite install is exactly
  this; a full install starts from it — so everything here, e.g.
  `docs/ENGINEERING_PRINCIPLES.md`, ships with full too). Always copied.
- `full-overlay/` — **full-tier additions and overrides only**, copied on top of `lite/`.
  Overwrites exactly three files
  (`docs/sprints/PROTOCOL.md`, `.claude/skills/sprint/SKILL.md`, `docs/sprints/INDEX.md`)
  and adds the agents, scripts, `ORCHESTRATION.md` + `ROADMAP.md`.
- `bootstrap/SKILL.md` — the installer skill. Symlink it:
  `ln -s "$(pwd)/bootstrap" ~/.claude/skills/bootstrap-project`
- `template.config.json` — the install manifest the bootstrap and upgrade skills read:
  placeholders, tier copy-sets, and file classes (seeded vs merged vs managed).
- `VERSION` + `CHANGELOG.md` + `migrations/` — the release surface downstream repos
  upgrade against (see **Releasing**).

## Releasing

Downstream repos pin what they installed in `.claude/template-manifest.json` and
upgrade via `/template-upgrade`, which diffs template versions by commit SHA. That
imposes three hard rules on this repo:

1. **Every change to `lite/`, `full-overlay/`, `template.config.json`, or
   `migrations/` must bump `VERSION` and add a `CHANGELOG.md` entry in the same
   commit.** The update checker compares `VERSION` on `main` against downstream
   manifests; an unbumped change is invisible to every installed repo, and the
   changelog entry is what users read before approving an upgrade.
2. **Never force-push `main`.** Downstream manifests pin commit SHAs as three-way
   merge bases; rewriting history orphans those SHAs and degrades every future
   upgrade to a manual new-vs-local diff.
3. **Structural changes to seeded files must ship as migrations.** Seeded files
   (the INDEX/ROADMAP generated skeletons, `claims-tokens.json`, `TODOS.md`) are
   copied once at bootstrap and never auto-merged afterwards — a template-side edit
   to them never reaches downstream unless a `migrations/vX.Y.Z.sh` script applies
   it in place (see `migrations/README.md`).

## Fixed conventions (deliberately not configurable)

- Sprint IDs are `S-NNN`; files are `docs/sprints/{status}/S-NNN-kebab-name.md`.
- ADRs are `docs/decisions/NNN-kebab-title.md`; RFCs are `docs/proposals/`.
- Docs live at `docs/sprints/`, `docs/DOC_HEALTH.md`, `docs/TODOS.md`.
- Worktrees (full) live at `.claude/worktrees/S-NNN-kebab-name`.
- Commit grammar: `S-NNN: [deliverable]` · `sprint: start/complete S-NNN — [name]` ·
  `docs: [what changed]`.

These are baked into the scripts' regexes and the skills; keeping them identical across all
your projects is the point.

## What the template deliberately does NOT carry

Stack-convention skills (testing patterns, framework workflows, ORM guidance, logging rules,
UI-component conventions, release/changelog processes). Those encode a *specific stack's*
norms — each project grows its own in `.claude/skills/` alongside its `AGENTS.md`. The
`/review` skill's "Project-Specific Checks" section and its Learnings check are the intake
funnel: conventions that keep coming up in review graduate into per-project skills.

## What varies per project

| Placeholder / mechanism | Where | Example |
|---|---|---|
| `{{PROJECT_NAME}}` | CLAUDE block, PROTOCOL, DOC_HEALTH, INDEX, skills | `acme-app` |
| `{{PROJECT_DESCRIPTION}}` | CLAUDE block | "B2B invoicing SaaS" |
| `{{GATE_COMMANDS}}` | `scripts/sprint/gate.sh` only | `pnpm lint && pnpm test` |
| `{{PREPUSH_GATE_COMMANDS}}` | `scripts/sprint/pre-push-gate.sh` only | `pnpm test:e2e` |
| `{{PACKAGE_MANAGER}}` | PROTOCOL worktree setup, settings.json | `pnpm` |
| `SPRINT_MAIN_BRANCH` env | `.claude/settings.json` `env` block (full scripts read it) | `master` |
| `scripts/sprint/claims-tokens.json` | full tier; claim-token definitions | see file |
| Tag→doc table + DOC_HEALTH rows | PROTOCOL / DOC_HEALTH; seeded by bootstrap from a doc scan | — |
