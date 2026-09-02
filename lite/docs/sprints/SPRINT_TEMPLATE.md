---
sprint: S-NNN
status: backlog
goal: One sentence describing what "done" looks like
short: Concise label for INDEX tables (~30 chars)
tasks: null
proposal: null
stage: null
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

<!-- proposal:/stage: are informational backlinks, ignored by scripts — set by /plan
     when the source is a proposal (proposal: NNN, stage: k; stage: 1 for un-staged
     proposals). Sprint close (PROTOCOL Step 3.6) uses them, together with the Context
     Source citation, to detect when a proposal stage's last sprint lands. -->

<!-- Deliverables are numbered in execution order. Claude executes 1, then 2, etc.
     Dependency marking is MANDATORY per deliverable: state either "depends on #N"
     or "independent of all prior deliverables" in its description. Independence is
     what allows a subagent-driven executor to dispatch deliverables in parallel;
     an unmarked deliverable is treated as depending on its predecessor. -->

## Context

<!-- Populated by /plan (or by hand for standalone sprints): source plan path +
     originating task IDs, and the source plan's GLOBAL constraints that bind this
     sprint — copied verbatim, not paraphrased. This file is the executor's entire
     brief; a constraint living only in the source plan is invisible to it.
     "— none" is a valid entry for standalone sprints. For staged proposals /plan
     writes the citation form below verbatim — sprint close greps it to detect stage
     completion. -->

- Source: `path/to/plan.md` (tasks: T-x, T-y) | `docs/proposals/NNN-{kebab}.md` (stage k/N — gate on completion: [one-line gate question]) | — none
- Binding constraints: …

## Scope

### Deliverables

<!-- Acceptance criteria are classified Automated or Manual. Automated: the exact
     runnable command plus the observable difference it demonstrates — the executor
     checks the box only by citing that command's output. Manual: verifiable only by a
     human (visual look, real-device feel, third-party dashboard); the executor REPORTS
     what to check but never checks the box — the user confirms it at sprint close
     (PROTOCOL Phase 3 Step 1). A criterion that can't name its command is Manual by
     definition. Omit whichever list is empty.

     Evidence grammar (linted by scripts/sprint/close-check.mjs at close):
       - A checked Automated criterion is followed by an indented
         `- Evidence: <test name | file:line | \`cmd\` → output tail | docs/sprints/evidence/S-NNN/…>`
         line — the proof, written at the same keystroke as the `[x]`.
       - A criterion left unchecked at close ends `— descoped: <why> (TODOS #N)`.
       - A Manual criterion is checked ONLY by the user and ends `— confirmed YYYY-MM-DD`.
     Evidence lives in THIS file (or under docs/sprints/evidence/S-NNN/ for artifacts that
     don't fit a line) — never in the conversation and never in the gitignored wave ledger. -->

1. **[Feature/Task Name]**
   - Files: `path/to/file` (new | modified)
   - Reference: `path/to/similar_file` — follow this for code style, error handling, structure
   - Interface: `ClassName` / `functionName()` from `path/to/module:L##-L##` — the contract this code must satisfy
   - Setup: install commands, env vars, or config needed before implementation
   - Changes: what exactly needs to happen
   - Acceptance criteria:
     - Automated:
       - [ ] `command to run` → the observable difference it must show
     - Manual (user-confirmed at close):
       - [ ] What the user verifies by hand, and where

2. **[Feature/Task Name]**
   - Files: `path/to/file` (new | modified)
   - Reference: `path/to/similar_file`
   - Interface: what contract this must implement or expose
   - Setup: pre-requisites if any
   - Changes: what exactly needs to happen
   - Acceptance criteria:
     - Automated:
       - [ ] `command to run` → expected observable

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

<!-- Written INTO this file by whoever executes (solo Claude or the sprint-executor) before
     close, committed `S-NNN: completion log`. This file is the durable record — not the
     conversation, not the wave ledger (`.claude/sprint-orchestration/` is gitignored).
     `node scripts/sprint/close-check.mjs <this file>` lints it: every Automated criterion
     above is `[x]` + `- Evidence:` or `— descoped: …`, every Manual one is user-confirmed
     or descoped, every section below is filled (or `— none`), and every checklist row
     carries an annotation. Artifacts too big for a line (screenshots, smoke transcripts,
     measurement reports) go in `docs/sprints/evidence/S-NNN/` and are cited by path. -->

### Outcome

_(2–4 sentences at close: what actually shipped, what changed for the user, what surprised
you. This is the narrative — INDEX.md's Outcome cell is ONE sentence pointing here.)_

### Commits

_(stamped at land)_

<!-- Full tier: merge-sprint.sh land replaces the line above with the `S-NNN:` deliverable
     commits + the merge SHA. Lite: paste `git log --reverse --oneline <start-sha>..HEAD
     --grep '^S-NNN:'` here at close (start-sha = the `sprint: start S-NNN` commit). -->

### Review

_(fill at close: findings by severity with disposition — `Critical/Important/Minor: <finding>
— fixed <sha>` or `— declined: <why>` — or the literal `— not run: low risk (Step 3.5)`)_

### Deviations from brief

_(fill at close: what was built differently from the deliverable text, and why; `— none`)_

### Deferred

_(fill at close: `TODOS #N — <item>` per line; `— none`)_

### Learnings

_(fill at close: `- YYYY-MM-DD S-NNN <plan|test|review|design|exec>: <what happened> → rule:
<one line>`; `— none`. Same grammar as docs/sprints/PLANNING_LEARNINGS.md — a `plan`-class
line that would have changed another sprint's brief is also prepended there.)_

### Close checklist

<!-- Every row is `- [x] <label> — <annotation>`. A bare "done"/"yes"/"ok" fails the lint;
     `n/a` and `descoped` need `: reason`. -->

- [ ] Gate green — <last line of `scripts/sprint/gate.sh` output>
- [ ] Docs synced — <docs updated | none: reason>
- [ ] New docs registered — <DOC_HEALTH row + PROTOCOL tag→doc row for `<doc>` | none: no new docs>
- [ ] ADR check — <ADR-NNN | none: reason>
- [ ] Deferred work logged — <TODOS #N, … | none: nothing deferred>
- [ ] Deployed — <where / when / run id | n/a: reason>
