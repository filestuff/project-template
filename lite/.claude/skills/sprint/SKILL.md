---
name: sprint
description: >
  Kanban sprint management for {{PROJECT_NAME}} — start, complete, plan, and track sprints
  with dependency checking and doc validation. Use when asked to "start a sprint",
  "complete a sprint", "show the board", "create a sprint", "plan a sprint", or
  "what's next".
argument-hint: "[command] [sprint-id]"
allowed-tools: "Read Edit Write Glob Grep Bash AskUserQuestion"
---

# Sprint Management Skill (lite)

You are managing a kanban-style sprint workflow. Sprint files live in `docs/sprints/`
with four directories: `backlog/`, `in-progress/`, `done/`, `rejected/`.

**IMPORTANT**: `docs/sprints/PROTOCOL.md` is the source of truth for every lifecycle
procedure. Read it and follow it exactly — this skill is just the command surface.

This is the **lite** tier: one sprint at a time. If `in-progress/` is non-empty when asked
to start another, stop and ask.

## Commands

Parse the first argument as the command, the second as the sprint ID.

### `/sprint board`

1. Glob `docs/sprints/in-progress/*.md` — list each with sprint ID, goal, start date, days
   elapsed.
2. Glob `docs/sprints/backlog/*.md` — count total, sum story points, list unblocked sprints
   (all `depends_on` in `done/` or `done/archive/`).
3. Glob `docs/sprints/done/*.md` (and `done/archive/*.md`) — count total, show last 3
   completed.
4. Format as a concise board view. (Ignore `.gitkeep` files when counting.)

### `/sprint start [S-NNN]`

Execute **Phase 1: Pre-Sprint** from `docs/sprints/PROTOCOL.md`: dependency check →
one-sprint-at-a-time check → move the file to `in-progress/`, flip frontmatter, update
INDEX.md, commit `sprint: start S-NNN — [name]` → DOC_HEALTH-gated + tag-scoped doc
validation → 2–4 architectural tradeoff questions. Then begin executing deliverables
sequentially per **Phase 2: Execution** (commit atomically per deliverable; run
`scripts/sprint/gate.sh` before each commit).

### `/sprint done [S-NNN]`

Execute **Phase 3: Post-Sprint** from `docs/sprints/PROTOCOL.md`: acceptance-criteria
**evidence** check (cite test/file:line/output — a checked box without evidence does not
count) → doc sync via `git diff` → **`/adr check` (mandatory)** → move the file to `done/`,
flip frontmatter, update INDEX.md with a one-line outcome, commit
`sprint: complete S-NNN — [name]`.

### `/sprint create [title]`

1. Glob all sprint files to find the highest S-NNN; assign the next number.
2. **Check `docs/TODOS.md`** for deferred items this sprint could absorb; offer them.
3. Copy `docs/sprints/SPRINT_TEMPLATE.md` → `docs/sprints/backlog/S-{NNN}-{kebab-title}.md`.
4. Fill frontmatter: sprint ID, `status: backlog`, goal from title, a concise `short:` label.
5. Ask via AskUserQuestion for: `depends_on`, `blocks`, `tags`, `story_points`.
6. Add a Backlog row to INDEX.md. Commit: `sprint: create S-NNN — [title]`.

### `/sprint plan [S-NNN]`

Populate a backlog sprint with implementation-ready detail (Files w/ new|modified, a
**Reference** to the most similar existing file, Interface contract w/ file:line, Setup,
Changes, testable Acceptance criteria), ordered in execution sequence; populate Technical
Details, Testing (pattern reference), Dependencies, Risks, Open Questions; update
`story_points` if scope reveals different complexity. Commit: `sprint: plan S-NNN — [name]`.

### `/sprint next`

For each backlog sprint check all `depends_on` are in `done/` or `done/archive/`. Among
unblocked sprints suggest the highest-priority one and show its goal, points, tags, notes.

## No Arguments

If invoked as just `/sprint`, run `/sprint board`.
