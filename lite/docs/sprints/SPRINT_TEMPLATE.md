---
sprint: S-NNN
status: backlog
goal: One sentence describing what "done" looks like
short: Concise label for INDEX tables (~30 chars)
tasks: null
depends_on: []
blocks: []
tags: []
story_points: 0
plan_date: null
start_date: null
end_date: null
touches: []
---

# S-NNN: [Sprint Name]

<!-- Starter tags: frontend, backend, database, infra, security, design, devops.
     Freeform — add a new tag when clearly distinct from existing ones. Keep the
     tag→doc table in PROTOCOL.md in sync with the tags you actually use. -->

<!-- touches: is the file-claims manifest — FULL TIER ONLY (ignored in lite).
     /sprint plan populates it from the deliverables' Files lists: exact paths,
     `dir/**` prefixes, or tokens from scripts/sprint/claims-tokens.json.
     /sprint start re-derives or verifies it and checks overlap with in-flight
     sprints. -->

<!-- plan_date: is set ONLY by /sprint plan (or the wave planning pass) after its
     readiness checklist passes — never by hand and never at creation. null =
     unplanned: /sprint start warns, and /sprint wave runs a planning subagent
     over the sprint before dispatching it. A plan_date older than a
     dependency's end_date renders as "stale plan" in the waves output — the
     plan's file:line premises predate landed work and need re-verification. -->

<!-- Deliverables are numbered in execution order. Claude executes 1, then 2, etc.
     If two deliverables are independent, say so in their description. -->

## Context

<!-- Populated by /plan (or by hand for standalone sprints): source plan path +
     originating task IDs, and the source plan's GLOBAL constraints that bind this
     sprint — copied verbatim, not paraphrased. This file is the executor's entire
     brief; a constraint living only in the source plan is invisible to it.
     "— none" is a valid entry for standalone sprints. -->

- Source: `path/to/plan.md` (tasks: T-x, T-y) | — none
- Binding constraints: …

## Scope

### Deliverables

1. **[Feature/Task Name]**
   - Files: `path/to/file` (new | modified)
   - Reference: `path/to/similar_file` — follow this for code style, error handling, structure
   - Interface: `ClassName` / `functionName()` from `path/to/module:L##-L##` — the contract this code must satisfy
   - Setup: install commands, env vars, or config needed before implementation
   - Changes: what exactly needs to happen
   - Acceptance criteria:
     - [ ] Criterion 1
     - [ ] Criterion 2

2. **[Feature/Task Name]**
   - Files: `path/to/file` (new | modified)
   - Reference: `path/to/similar_file`
   - Interface: what contract this must implement or expose
   - Setup: pre-requisites if any
   - Changes: what exactly needs to happen
   - Acceptance criteria:
     - [ ] Criterion 1

### Out of Scope

- Things explicitly NOT included in this sprint (defer to `docs/TODOS.md` with a backlink)

---

## Technical Details

### Schema / Data-Model Changes

<!-- Migration or schema change needed? Describe here; claim the schema token (full tier). -->

### New Files

| File | Purpose |
|------|---------|
| `path/to/new-file` | Description |

### Modified Files

| File | Changes |
|------|---------|
| `path/to/existing` | What changes |

### Deleted Files

| File | Reason |
|------|--------|
| `path/to/old` | Replaced by X |

---

## Dependencies

- External services, API keys, or infrastructure needed
- Sprint dependencies captured in frontmatter `depends_on` / `blocks`

## Interface Contract

<!-- The contracts that cross sprint boundaries. Filling these lets a dependent
     sprint be built IN PARALLEL against an agreed signature instead of waiting
     for this sprint to land (full tier surfaces the resulting waves in
     ROADMAP.md). Leave a section "— none" if this sprint neither exposes nor
     consumes a cross-sprint contract. -->

### Produces

<!-- Signatures / types / endpoints / schemas this sprint creates that other
     sprints (its `blocks:`) may code against. Name each with file:symbol. -->

- `ExportedThing` — `path/to/module`: the shape/signature dependents may rely on

### Consumes

<!-- Contracts this sprint depends on, from its `depends_on:` sprints. Code
     against these agreed signatures; the blocker need not be merged yet. -->

- `UpstreamThing` from S-NNN — `path/to/module`: signature relied on

## Testing

<!-- Test-first (RED → GREEN → REFACTOR): write the failing test BEFORE the
     implementation and watch it fail for the right reason. Reference an existing
     test file for style/patterns. Avoid the traps in
     docs/sprints/testing-anti-patterns.md. When test-first doesn't fit
     (exploratory spike, pure config, visual/UI), say so here and state how the
     deliverable is verified instead. -->

- Test pattern: follow `path/to/existing_test` for mocking approach and assertions
- [ ] RED: failing test written for X, observed to fail for the right reason
- [ ] GREEN: simplest code makes it pass (YAGNI — see `docs/ENGINEERING_PRINCIPLES.md`)
- [ ] Integration test for Y
- [ ] Manual verification of Z

## Risks

| Risk | Mitigation |
|------|-----------|
| Description | How to handle |

## Open Questions

<!-- Non-obvious decisions, written DECISION-READY: each question carries 2–4
     concrete options with their plan/touches implications, a recommended option
     with a one-line why, and the stake if the choice is wrong. Resolved during
     /sprint plan (preferred — the planner has the most context) or the
     pre-sprint AskUserQuestion phase; every answer moves to Pre-Sprint
     Decisions below and the item is checked off. An unresolved question
     without concrete options blocks plan_date — the sprint is not
     implementation-ready while an open decision has no shaped choices. -->

- [ ] Question about an architectural tradeoff — options: A …, B …
- [ ] Question about a data-model choice — options: A …, B …

## Pre-Sprint Decisions

<!-- Binding decisions carried into execution — the sprint file is the entire
     brief for an execution agent, so an answer that lives only in a
     conversation is invisible to it. Appended by /sprint plan, the wave
     planning pass, or the Phase 1 tradeoff round. Format:
     - YYYY-MM-DD (plan|start|wave): [decision] — [one-line rationale]
     Execution treats these as settled: do not re-litigate them mid-sprint. -->

_(none yet)_

---

## Completion Log

_Fill in as work progresses:_

- [ ] Implementation complete
- [ ] Tests passing (gate: `scripts/sprint/gate.sh`)
- [ ] Reviewed / self-reviewed
- [ ] Docs synced (post-sprint validation)
- [ ] New docs registered (DOC_HEALTH row + PROTOCOL tag→doc row, or "none")
- [ ] ADR check run (ADR-NNN or "none — reason")
- [ ] Deferred work logged in `docs/TODOS.md` (or "none")
- [ ] Deployed (if applicable)
- [ ] Move file to `done/` folder
