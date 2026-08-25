# {{PROJECT_NAME}} — Claude Code Instructions

## Project

{{PROJECT_NAME}} — {{PROJECT_DESCRIPTION}}

## Documentation

Entry points (discover the rest by listing `docs/`):
- `docs/sprints/INDEX.md` — sprint kanban · `docs/sprints/PROTOCOL.md` — authoritative lifecycle spec
- `docs/decisions/` — ADRs · `docs/proposals/` — RFCs
- `docs/DOC_HEALTH.md` — doc staleness tracker (read first during pre-sprint)
- `docs/TODOS.md` — deferred-work ledger
- `docs/ENGINEERING_PRINCIPLES.md` — design defaults: the decision ladder (reuse before build), YAGNI/KISS/DRY/SOLID, root-cause-over-symptom, hard safety carve-outs (planning, execution, review)
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

- Explore a feature idea / draft a spec → `/proposal` (writes `docs/proposals/NNN-*.md`,
  then hands off to `/plan <NNN>`; when a staged proposal's stage completes,
  `/proposal <NNN>` decides its gate) — do NOT plan or build from a bare idea without it,
  and do NOT plan past an undecided stage gate
- Start/complete/show sprints, "what's next" → `/sprint` (full tier: `/sprint wave` fans a
  parallel wave of independent sprints out to subagents)
- Break a plan into sprints / seed the backlog → `/plan` (splits work for parallel agents)
- Execute a started sprint (lite) → a subagent-driven execution skill if installed (e.g.
  superpowers:subagent-driven-development), sprint file as the plan — solo only without one
- Record an architectural decision → `/adr`
- Root-cause a bug / failing test / unexpected behavior → `/debug` (before proposing a fix)
- One-shot bulk work with no durable artifact (migration sweep, codebase audit, research
  pass) → run it directly as a goal-formulated parallel job (Workflow tool / "ultracode",
  where available, or plain parallel subagents) instead of through the sprint machinery —
  sprints are for work whose cards, claims, and history must outlive the session. State
  the goal, the done-criterion, and the self-check; do not prescribe the step list.

## Context discipline

- Push broad or cross-cutting exploration into `Explore` subagents; bring back conclusions,
  not file dumps.
- Checkpoint at deliverable boundaries on long sprints.
- Prefer smaller, independently-committable deliverables — they survive compaction and
  re-entry better.
