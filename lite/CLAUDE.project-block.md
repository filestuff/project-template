# {{PROJECT_NAME}} — Claude Code Instructions

## Project

{{PROJECT_NAME}} — {{PROJECT_DESCRIPTION}}

## Documentation

Entry points (discover the rest by listing `docs/`):
- `docs/sprints/INDEX.md` — sprint kanban · `docs/sprints/PROTOCOL.md` — authoritative lifecycle spec
- `docs/decisions/` — ADRs · `docs/proposals/` — RFCs
- `docs/DOC_HEALTH.md` — doc staleness tracker (read first during pre-sprint)
- `docs/TODOS.md` — deferred-work ledger
- `docs/ENGINEERING_PRINCIPLES.md` — YAGNI/KISS/DRY/SOLID design defaults (planning, execution, review)
- `docs/sprints/testing-anti-patterns.md` — test-first traps to avoid

## Sprint Workflow

When the user says "start S-NNN", "what's next", or "show the board", invoke `/sprint`.
`docs/sprints/PROTOCOL.md` is the source of truth for execution — do not restate its rules
here. The commit gate is `scripts/sprint/gate.sh` — the single source of truth for what must
pass before each deliverable commit.

## Conventions

- Sprint deliverable commits: `S-NNN: [description]`
- Sprint lifecycle commits: `sprint: start/complete S-NNN — [name]`
- Doc commits: `docs: [what changed]`
- ADR files: `docs/decisions/NNN-kebab-case-title.md`
- Sprint files: `docs/sprints/{status}/S-NNN-kebab-case-name.md`

## Skill routing

When a request matches a skill, invoke it via Skill as the FIRST action:

- Start/complete/show sprints, "what's next" → `/sprint` (full tier: `/sprint wave` fans a
  parallel wave of independent sprints out to subagents)
- Break a plan into sprints / seed the backlog → `/plan` (splits work for parallel agents)
- Record an architectural decision → `/adr`
- Root-cause a bug / failing test / unexpected behavior → `/debug` (before proposing a fix)

## Context discipline

- Push broad or cross-cutting exploration into `Explore` subagents; bring back conclusions,
  not file dumps.
- Checkpoint at deliverable boundaries on long sprints.
- Prefer smaller, independently-committable deliverables — they survive compaction and
  re-entry better.
