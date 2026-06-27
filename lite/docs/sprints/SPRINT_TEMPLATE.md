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

<!-- Deliverables are numbered in execution order. Claude executes 1, then 2, etc.
     If two deliverables are independent, say so in their description. -->

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

<!-- Non-obvious decisions to resolve during the pre-sprint AskUserQuestion phase. -->

- [ ] Question about an architectural tradeoff
- [ ] Question about a data-model choice

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
