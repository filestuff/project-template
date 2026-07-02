---
name: sprint
description: >
  Kanban sprint management for {{PROJECT_NAME}} — start, complete, plan, and track sprints
  with dependency checking, file claims, doc validation, and lock-serialized
  lifecycle commits on main. Use when asked to "start a sprint", "complete a
  sprint", "show the board", "create a sprint", "plan a sprint", "what's next",
  "sprint roadmap", or "run/fan out a parallel wave".
argument-hint: "[command] [sprint-id]"
allowed-tools: "Read Edit Write Glob Grep Bash AskUserQuestion EnterWorktree ExitWorktree Task"
---

# Sprint Management Skill

You are managing a kanban-style sprint workflow. Sprint files live in `docs/sprints/`
with four directories: `backlog/`, `in-progress/`, `done/`, `rejected/`.

**IMPORTANT**: `docs/sprints/PROTOCOL.md` is the source of truth for every lifecycle
procedure. Read it and follow it exactly — this skill is just the command surface.

**Parallel sprints**: `main` is the lifecycle ledger. Sprint start/completion are
lock-serialized commits on `main` made by the helper scripts; `docs/sprints/in-progress/`
on `main` always shows the in-flight sprints and their claimed files (`touches:`).
Sprint branches carry deliverable work only and never touch INDEX.md / ROADMAP.md /
DOC_HEALTH.md (see PROTOCOL "Parallel Sprints").

## Helper scripts (`scripts/sprint/`)

| Script | Purpose | Key exits |
|--------|---------|-----------|
| `gate.sh` | The commit gate — single source of truth for pre-commit checks | non-zero = fix first |
| `lock.sh` | Mutex for all main mutations (`acquire`/`release`/`status`/`steal --force`) | 75 = busy |
| `claims.mjs` | `check` claims overlap vs in-flight sprints; `add` expands a claim (locked main commit). Tokens: `claims-tokens.json` | 2 = overlap |
| `regen.mjs` | Regenerate the marker-delimited blocks in INDEX.md + ROADMAP.md (`--check` for drift) | 2 = drift |
| `start.sh S-NNN --touches "…"` | The whole locked start transaction on main | 2 = overlap/claimed, 75 = busy |
| `unstart.sh S-NNN [--reason "…"]` | The locked inverse: in-progress → backlog (keeps `plan_date`/`touches:`/decisions) | 2 = not in flight / branch has commits, 75 = busy |
| `merge-sprint.sh prepare\|land\|finish\|abort <branch>` | The locked completion (merge queue) | 3 = re-run gate, 4 = author docs, 75 = busy |
| `frontmatter.mjs get\|set` | Read/write sprint frontmatter fields round-trip-safely | |

## Commands

Parse the first argument as the command, the second as the sprint ID.

### `/sprint board`

Print the current kanban state:

1. Glob `docs/sprints/in-progress/*.md` **on main** (the primary checkout) — list each with
   sprint ID, goal, start date, days elapsed, and a `touches:` summary. This is authoritative
   for in-flight work.
2. Glob `docs/sprints/backlog/*.md` — count total, sum story points, list unblocked sprints.
   Tag any sprint whose `plan_date` is null as **unplanned** (never certified by
   `/sprint plan`).
3. Glob `docs/sprints/done/*.md` (and `done/archive/*.md`) — count total, show last 3 completed.
4. **Orphan check**: run `git worktree list` and cross-reference —
   - an `in-progress/` file with **no matching worktree** → crashed/abandoned sprint; suggest
     recovery (PROTOCOL "The sprint-main lock").
   - a worktree with **no `in-progress/` file** → unregistered claim; investigate before
     starting overlapping work.
5. Show lock state: `scripts/sprint/lock.sh status`.
6. Show total backlog points and critical path from `docs/sprints/ROADMAP.md`.
7. **Parallel waves**: run `node scripts/sprint/claims.mjs waves` and show the current
   startable-in-parallel set (Wave 1 backlog members — skip any tagged "in flight"). This is
   what `/sprint wave` would fan out. Members tagged `⚠ unplanned` / `⚠ stale plan` get a
   planning pass before dispatch (ORCHESTRATION.md Step 2) — mention which ones.

Format as a concise board view. (Ignore `.gitkeep` files when counting.)

### `/sprint start [S-NNN]`

Execute the full **Phase 1: Pre-Sprint** procedure from `docs/sprints/PROTOCOL.md`:
frontmatter parse (warn + ask if `plan_date` is null — never certified by `/sprint plan`;
start.sh prints the same warning) → dependency check (in-progress on main = in flight by a
parallel agent) → derive `touches:`
from the sprint's Files lists → `claims.mjs check` (stop and ask on overlap) →
**`start.sh S-NNN --touches "…"` — the start commit lands on `main`, not the branch** →
create + enter the sprint worktree from the post-start main tip
(`git worktree add .claude/worktrees/S-NNN-… -b S-NNN-… main` then `EnterWorktree {path}`;
if the branch already exists another agent owns the sprint — stop and ask) →
DOC_HEALTH-gated + tag-scoped doc validation → 2–4 architectural tradeoff questions.
Then begin executing deliverables sequentially per **Phase 2: Execution** (commit atomically
per deliverable, run `scripts/sprint/gate.sh` before each commit, and respect the
**claims-discipline rule**: `claims.mjs check` before touching any unclaimed file).

### `/sprint done [S-NNN]`

Execute the full **Phase 3: Post-Sprint** procedure from `docs/sprints/PROTOCOL.md`:
acceptance-criteria **evidence** check (cite test/file:line/output — a checked box without
evidence does not count) → doc sync via `git diff` (on the branch) → **`/adr check`
(mandatory; record outcome in the Completion Log)** →
**`merge-sprint.sh prepare S-NNN-…`** (locked; on exit 3 re-run `gate.sh`) →
**`merge-sprint.sh land S-NNN-…`** (merges to main, moves the file, regenerates; exits 4) →
author the semantic docs on main (DOC_HEALTH.md, INDEX Done-row + header, ROADMAP narrative)
→ **`merge-sprint.sh finish S-NNN-…`** (commits, pushes, releases the lock) →
exit + remove the worktree and branch (Phase 3 Step 6).

### `/sprint create [title]`

1. Glob all sprint files to find the highest S-NNN; assign the next number.
2. **Check `docs/TODOS.md`** for deferred items this sprint could absorb; offer them.
3. Copy `docs/sprints/SPRINT_TEMPLATE.md` → `docs/sprints/backlog/S-{NNN}-{kebab-title}.md`.
4. Fill frontmatter: sprint ID, `status: backlog`, goal from title, a concise `short:` label
   (used in the generated INDEX/ROADMAP blocks), and an empty `touches: []` stub.
5. Ask via AskUserQuestion for: `depends_on`, `blocks`, `tags`, `story_points`.
6. Commit on main under the lock:
   `lock.sh acquire create-S-NNN` → `regen.mjs` → commit `sprint: create S-NNN — [title]`
   (explicit paths, `--no-verify`) → `lock.sh release <token>`.

### `/sprint plan [S-NNN]`

Populate a backlog sprint with implementation-ready detail (Files w/ new|modified, a
**Reference** to the most similar existing file, Interface contract w/ file:line, Setup,
Changes, testable Acceptance criteria), ordered in execution sequence; populate Technical
Details, Testing (pattern reference), Dependencies, Risks, Open Questions; update
`story_points` if scope reveals different complexity. **Required**: populate `touches:`
from the Files lists you just wrote (plus tokens from `claims-tokens.json` and likely
doc-sync targets) — `/sprint start` verifies rather than re-derives it.

**Readiness checklist** — all must hold before certifying:

1. Every deliverable's Files list names exact paths (new|modified) — no bare globs
   (`dir/**` remains legal in `touches:` only).
2. Every Reference/Interface `file:line` and every cited API/library version was verified
   against the repo **now**, not assumed from the source plan.
3. Zero unresolved Open Questions: resolve each via AskUserQuestion during this pass
   (recording answers as dated Pre-Sprint Decisions entries), or explicitly rewrite it as
   an ask-at-start question with 2–4 concrete options.
4. Every acceptance criterion states an observable difference — not "works correctly".
5. Testing names an existing test file to follow, or states why test-first doesn't fit and
   how the deliverable is verified instead.
6. `touches:` is populated per the Required rule above.

All pass → `node scripts/sprint/frontmatter.mjs set <file> plan_date "$(date +%F)"`. Any
fail → leave `plan_date: null` and report what's missing (still commit partial progress).
Either way, commit on main under the lock (same pattern as `/sprint create`):
`sprint: plan S-NNN — [name]`.

### `/sprint next`

Read `docs/sprints/INDEX.md`; for each backlog sprint check all `depends_on` are in `done/`
or `done/archive/`; a dependency in `in-progress/` is **in flight by a parallel agent** —
report it as such (it may land soon). Among unblocked sprints suggest the highest-priority
one and show its goal, points, tags, notes.

### `/sprint roadmap`

Run `node scripts/sprint/regen.mjs` (regenerates the graph + critical-path blocks in
`docs/sprints/ROADMAP.md` from sprint frontmatter). Update the narrative outside the markers
if stale. Commit on main under the lock: `docs: regenerate sprint roadmap`.

### `/sprint wave [N]`

Fan the current parallel-safe wave out to subagents. **Defer to
`docs/sprints/ORCHESTRATION.md`** — it is the source of truth for this command (as `PROTOCOL.md`
is for the rest). In short: compute the wave (`claims.mjs waves`), confirm the startable backlog
members with the user, **plan the wave** (fan out one `sprint-planner` subagent per unplanned /
stale member to verify + deepen its file against current code, batch all open decisions into one
AskUserQuestion round, write the answers into the sprint files as Pre-Sprint Decisions — two
short locked commits), then run **`start.sh` + worktree creation per sprint yourself**
(serialized, on `main`, under the lock — you stay parked on `main` and never EnterWorktree),
**dispatch one execution subagent per sprint** (single message = parallel) to run **Phase 2 only**
in its worktree via `git -C` (returns DONE / BLOCKED / NEEDS_CLAIM / **PLAN_GAP** + a report
file), then **complete finished sprints one at a time** (Phase 3 is lock-serialized and cannot
be fanned out). Keep the durable ledger in `.claude/sprint-orchestration/`. Optional `N` caps
the wave size. After the wave lands, run a broad `/review` and recompute the next wave.

## No Arguments

If invoked as just `/sprint`, run `/sprint board`.
