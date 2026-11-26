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
risk: low
tier: standard
tier_reason: null
plan_date: null
start_date: null
end_date: null
touches: []
---

# S-NNN: [Sprint Name]

<!-- guide: docs/sprints/sprint-file-guide.md holds the rules for every section below.
     Delete these guide comments when creating a sprint from this template. -->

## Context

<!-- guide: §Context -->

- Why: {the problem, what prompted it, and what the user can do afterwards that they can't today}
- Source: `path/to/plan.md` (tasks: T-x, T-y) | `docs/proposals/NNN-{kebab}.md` (stage k/N — gate on completion: [one-line gate question]) | — none
- Binding constraints: {copied verbatim from the source plan} | — none
- Prerequisites: {external services, keys, infra needed first} | — none

## Open Questions

<!-- guide: §Open Questions -->

- [ ] Question about an architectural tradeoff — options: A …, B … — recommend A: {one-line why}; stake: {cost if wrong}

## Pre-Sprint Decisions

<!-- guide: §Pre-Sprint Decisions -->

_(none yet)_

## Scope

### Deliverables

<!-- guide: §Deliverables -->

1. **[Feature/Task Name]**
   - Files: `path/to/file` (new | modified | deleted)
   - Reference: `path/to/similar_file` — follow for style, error handling, structure
   - Interface: `functionName()` from `path/to/module:L##-L##`
   - Setup: {install / env / config needed first — omit the field if none}
   - Changes: {what exactly must happen} — independent of all prior deliverables
   - Acceptance criteria:
     - Automated:
       - [ ] `command to run` → the observable difference it must show
     - Manual (user-confirmed at close):
       - [ ] What the user verifies by hand, and where

2. **[Feature/Task Name]**
   - Files: `path/to/file` (new | modified | deleted)
   - Reference: `path/to/similar_file`
   - Interface: {contract this must implement or expose}
   - Changes: {what exactly must happen} — depends on #1
   - Acceptance criteria:
     - Automated:
       - [ ] `command to run` → expected observable

### Out of Scope

- {what this sprint explicitly does NOT do} — deferred to `docs/TODOS.md` #N | permanent non-goal

## Interface Contract

<!-- guide: §Interface Contract -->

### Produces

- `ExportedThing` — `path/to/module`: the shape/signature dependents may rely on

### Consumes

- `UpstreamThing` from S-NNN — `path/to/module`: signature relied on

## Technical Details

<!-- guide: §Technical Details — optional; delete the section when neither subsection applies -->

### Schema / Data-Model Changes

- {migration or schema change; full tier: claim the schema token}

### Design notes

- {UI sprints only: interaction-states table from docs/sprints/design-checks.md}

## Verification

<!-- guide: §Verification -->

- Test pattern: follow `path/to/existing_test` for mocking approach and assertions
- End-to-end — proves the `goal:` with the deliverables together:
  - Automated:
    - [ ] `command to run against the integrated result` → the observable that shows the goal met
  - Manual (user-confirmed at close):
    - [ ] What the user sees or does, and where

## Risks

| Risk | Mitigation |
|------|-----------|
| Description | How to handle |

## Production notes

<!-- guide: §Production notes — MANDATORY when `risk: high`; otherwise delete this section -->

- Rollback: {how this sprint's change is undone after it lands — flag, revert, down-migration — and what undoing loses}
- Observability: {the log line, metric or alert that shows it working, and the one that shows it failing}
- Security: {the trust boundary or permission this touches and what enforces it}

---

> **Above this line is the brief — fixed once `plan_date` is set.** Execution writes only
> checkboxes, `- Evidence:` lines, in-flight Pre-Sprint Decisions, and the sections below.
> A brief that turns out wrong is a Deviation or a PLAN_GAP, never an edit.
> (`docs/sprints/sprint-file-guide.md` §Brief vs record)

## Execution Notes

<!-- guide: §Execution Notes — `- YYYY-MM-DD [plan|exec]: <finding>` -->

_(none yet)_

## Completion Log

<!-- guide: §Completion Log — the seven `###` titles below are linted; never rename them -->

### Outcome

_(2–4 sentences at close: what actually shipped, what changed for the user, what surprised you)_

### Commits

_(stamped at land)_

### Review

_(findings by severity with disposition, or `— not run: low risk (Step 3.5)`)_

### Deviations from brief

_(what was built differently from the brief, and why; `— none`)_

### Deferred

_(`TODOS #N — <item>` per line; `— none`)_

### Learnings

_(`- YYYY-MM-DD S-NNN <plan|test|review|design|exec>: <what happened> → rule: <one line>`; `— none`)_

### Close checklist

- [ ] Gate green — <last line of `scripts/sprint/gate.sh` output>
- [ ] Docs synced — <docs updated | none: reason>
- [ ] New docs registered — <DOC_HEALTH row + PROTOCOL tag→doc row for `<doc>` | none: no new docs>
- [ ] ADR check — <ADR-NNN | none: reason>
- [ ] Deferred work logged — <TODOS #N, … | none: nothing deferred>
- [ ] Deployed — <where / when / run id | n/a: reason>
