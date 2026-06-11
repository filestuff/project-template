---
name: plan
description: >
  Breaks a reviewed plan into sprint files with dependencies and story points. Invoke when
  asked to "break this down into sprints", "create sprints from the plan", "convert to
  sprints", or "seed the backlog".
argument-hint: "[feature description | proposal number | plan document path]"
allowed-tools: "Read Edit Write Glob Grep Bash AskUserQuestion Skill"
---

# Plan Breakdown Skill

Takes a reviewed plan and breaks it into sprint files in `docs/sprints/backlog/`.
It does NOT run plan reviews — those run separately first if used.

## Pipeline

### Phase 1: Context Gathering

1. Read `docs/sprints/INDEX.md` for current state and existing dependency chains (find the
   highest existing S-NNN).
2. Read the plan source:
   - A path → that document.
   - A number → treat as a proposal: read `docs/proposals/NNN-*.md`.
   - Free text → treat as a feature description; supplement from existing planning docs.
   - No argument → if `docs/execution-plan.md` exists, default to it; otherwise ask the user
     what to break down.
3. If a plan-review output is in the conversation, fold it in. If the user implies a review
   exists but none is visible, ask them to paste/summarize it.
4. Read the design-system doc (if one exists) when the work is UI/visual.

### Phase 2: Sprint Breakdown

1. **Identify natural sprint boundaries.** Foundation/infra first; independent features
   parallelizable; DB/schema before features; integration/eval last. Each sprint completable
   in ≤ ~2 weeks. Respect any build order the source plan locks in.
2. **Confirm boundaries via AskUserQuestion** — present the proposed split as a numbered list
   with goals + the dependency chain; ask whether to merge/split/reorder.
3. **Assign story points** (Fibonacci 1/2/3/5/8/13; 13 → consider splitting).
4. **Determine dependencies** between new sprints and against existing backlog items.

### Phase 3: Sprint File Generation

For each sprint, starting at S-{highest+1}, create a file from
`docs/sprints/SPRINT_TEMPLATE.md` in `docs/sprints/backlog/` and populate:
- **Frontmatter**: sprint ID, `status: backlog`, goal, a concise `short:` label,
  `depends_on`, `blocks`, `tags`, `story_points`.
- **Deliverables** (execution order): Files (new|modified), Reference implementation,
  Interface contract (file:line where code exists), Setup, Changes, Acceptance criteria.
- **Technical Details**, **Dependencies**, **Testing** (pattern reference), **Risks**,
  **Open Questions** (the non-obvious decisions `/sprint start` will ask).
- **Full tier only** (if `scripts/sprint/claims.mjs` exists): populate `touches:` from the
  Files lists you just wrote, plus tokens from `scripts/sprint/claims-tokens.json` and likely
  doc-sync targets — `/sprint start` verifies rather than re-derives it.

If the source plan numbers its tasks, tie each generated sprint back to its originating task
IDs in the sprint body so traceability is preserved.

If a breakdown surfaces a standalone architectural decision, offer to record it via
`/adr create`.

### Phase 4: Index Update

Update `docs/sprints/INDEX.md` (full tier: run `node scripts/sprint/regen.mjs`; lite: edit
the Backlog table by hand). Commit all new sprints + index:
`sprint: create S-{first}..S-{last} — [feature] (from /plan)`.
Full tier: make this commit on `main` under the lock (`scripts/sprint/lock.sh`).

## Arguments

- Number → proposal number (`docs/proposals/NNN-*.md`).
- Path → plan document.
- Text → feature description.
- None → `docs/execution-plan.md` if present, else ask.
