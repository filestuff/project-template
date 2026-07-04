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

## Boundaries

One-shot command dispatcher — handle the requested command, then stop. In scope: the
lifecycle commands below. Out of scope: execution rules (PROTOCOL.md is the source of
truth — never restate or override it here), breaking a plan into sprints (`/plan`),
recording decisions (`/adr`), root-causing failures (`/debug`). Null results: an empty
board is printed as-is — don't invent rows; `/sprint next` with nothing unblocked says so
and names what blocks each backlog sprint.

## Step 0 (silent): template update check

Before handling any command, run `bash scripts/template/update-check.sh 2>/dev/null || true`.

- `UPGRADE_AVAILABLE <old> <new> <sha>` → prepend exactly ONE line to your response —
  "project-template v\<new\> is available (you have v\<old\>) — run /template-upgrade, or say
  'not now' to snooze" — then continue with the requested command immediately. If the user
  later says "not now", run `bash scripts/template/update-check.sh --snooze`.
- `JUST_UPGRADED <old> <new>` → one line pointing at the template CHANGELOG for what changed
  between those versions, then continue.
- No output, script missing, or any failure → proceed silently. This check must never block,
  delay, or fail a sprint command.

## Commands

Parse the first argument as the command, the second as the sprint ID.

### `/sprint board`

1. Glob `docs/sprints/in-progress/*.md` — list each with sprint ID, goal, start date, days
   elapsed.
2. Glob `docs/sprints/backlog/*.md` — count total, sum story points, list unblocked sprints
   (all `depends_on` in `done/` or `done/archive/`). Tag any sprint whose `plan_date` is
   null as **unplanned** (never certified by `/sprint plan`).
3. Glob `docs/sprints/done/*.md` (and `done/archive/*.md`) — count total, show last 3
   completed.
4. Format as a concise board view. (Ignore `.gitkeep` files when counting.)

### `/sprint start [S-NNN]`

Execute **Phase 1: Pre-Sprint** from `docs/sprints/PROTOCOL.md`: frontmatter parse (warn +
ask if `plan_date` is null — the sprint was never certified by `/sprint plan`) → dependency
check → one-sprint-at-a-time check → move the file to `in-progress/`, flip frontmatter,
update INDEX.md, commit `sprint: start S-NNN — [name]` → DOC_HEALTH-gated + tag-scoped doc
validation → 2–4 architectural tradeoff questions (answers recorded in the sprint file's
Pre-Sprint Decisions section). Then begin executing deliverables sequentially per
**Phase 2: Execution** (verify the brief first; commit atomically per deliverable; run
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
`story_points` if scope reveals different complexity.

**Readiness checklist** — all must hold before certifying:

1. Every deliverable's Files list names exact paths (new|modified) — no bare globs.
2. Every Reference/Interface `file:line` and every cited API/library version was verified
   against the repo **now**, not assumed from the source plan.
3. Zero unresolved Open Questions: resolve each via AskUserQuestion during this pass
   (recording answers as dated Pre-Sprint Decisions entries), or explicitly rewrite it as
   an ask-at-start question with 2–4 concrete options.
4. Every acceptance criterion states an observable difference — not "works correctly".
5. Testing names an existing test file to follow, or states why test-first doesn't fit and
   how the deliverable is verified instead.

All pass → set `plan_date:` to today and commit `sprint: plan S-NNN — [name]`. Any fail →
leave `plan_date: null`, still commit the partial progress, and report what's missing.

### `/sprint next`

For each backlog sprint check all `depends_on` are in `done/` or `done/archive/`. Among
unblocked sprints suggest the highest-priority one and show its goal, points, tags, notes.

## No Arguments

If invoked as just `/sprint`, run `/sprint board`.
