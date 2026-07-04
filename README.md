# project-template

A reusable AI-agent-driven project workflow, extracted from the `ai-todo` project. It gives any
repo a sprint kanban (`/sprint`), plan breakdown (`/plan`), Architecture Decision Records
(`/adr`), a documentation staleness tracker (`DOC_HEALTH.md`), and — in the full tier — the
machinery for **multiple Claude Code agents running sprints in parallel** (file claims, a
main-branch mutex, per-sprint git worktrees, generated kanban/roadmap blocks).

## Install

Run `/bootstrap-project` in a Claude Code session inside (or pointed at) the target repo. It
asks the questions, copies the right tier, fills placeholders, merges CLAUDE.md/settings.json
safely, and validates the result. Manual install: copy `lite/` into the repo root, then (for
full) copy `full-overlay/` over it, replace every `{{PLACEHOLDER}}` (see
`template.config.json`), and `chmod +x scripts/sprint/*.sh`.

## Tiers

| | lite | full |
|---|---|---|
| Sprint kanban (`backlog/ → in-progress/ → done/`) | ✅ | ✅ |
| `/sprint`, `/plan`, `/adr` skills | ✅ | ✅ |
| `/review`, `/explain-changes`, `/code-simplifier` skills + `reviewer` agent | ✅ | ✅ |
| `DOC_HEALTH.md` staleness gate, `TODOS.md` ledger, ADRs | ✅ | ✅ |
| Commit gate (`scripts/sprint/gate.sh`, single source of truth) | ✅ | ✅ |
| Concurrent sprints | one at a time | many, in parallel agents |
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
- `template.config.json` — the placeholder manifest the bootstrap skill reads.
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
| `{{PACKAGE_MANAGER}}` | PROTOCOL worktree setup, settings.json | `pnpm` |
| `SPRINT_MAIN_BRANCH` env | `.claude/settings.json` `env` block (full scripts read it) | `master` |
| `scripts/sprint/claims-tokens.json` | full tier; claim-token definitions | see file |
| Tag→doc table + DOC_HEALTH rows | PROTOCOL / DOC_HEALTH; seeded by bootstrap from a doc scan | — |
