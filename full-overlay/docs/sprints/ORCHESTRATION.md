# Sprint Orchestration Protocol (full tier)

How a single session fans a **wave** of sprints out to parallel subagents and integrates the
results, for {{PROJECT_NAME}}. The `/sprint wave` command defers to this file. This is the
**full tier only** — it relies on the worktree + file-claims + main-lock machinery described in
`PROTOCOL.md` ("Parallel Sprints"). Read that first; this document only adds the orchestration
layer on top.

## The division of labor

The trick that makes this safe: **the orchestrator owns everything that mutates `main` or needs
human judgment; subagents only write into files they are explicitly handed.** The orchestrator
stays lean — it never reads sprint bodies or code into its own context; subagents return short
structured summaries or file paths.

| Owner | Does | Touches |
|-------|------|---------|
| **Orchestrator** (this session) | Compute the wave; run the planning pass (dispatch planners, batch the decision round, write answers into sprint files, two locked commits); per sprint run start (dep check, claims check, `start.sh` under the lock, create the worktree); dispatch execution subagents; collect reports; **serialize** Phase 3 completions; final review | `main` (lock-serialized), the ledger docs, the user |
| **Planning subagent** (`sprint-planner`, one per unplanned/stale sprint) | Verify + deepen ONE sprint file against current `main`: staleness, contract drift, deliverable detail, `touches:`, decision-ready questions; set `plan_date` | its assigned sprint file only (uncommitted — the orchestrator commits) |
| **Wave-planning subagent** (conditional) | Cross-sprint constraint check when planner reports signal it (shared foundations, contract misalignment) | wave-plan.md only |
| **Execution subagent** (one per sprint) | PROTOCOL **Phase 2 only** — verify the brief, implement deliverables test-first, gate, commit atomically — inside its assigned worktree | its worktree branch only |

The orchestrator's primary checkout stays parked on `main` (it is the lifecycle ledger). It
**never** enters a worktree — it creates them with `git worktree add` and hands the path to a
subagent.

## Worktree mode: path-scoped (verified)

Execution subagents operate **entirely through `git -C <worktree>` and absolute paths** — they
do **not** call `EnterWorktree`/`ExitWorktree`. This avoids any reliance on session-global
worktree state across concurrent subagents and rests only on per-subagent Bash isolation +
git's own worktree concurrency safety (both confirmed: concurrent subagents each created a
worktree, committed, and saw no `index.lock`/ref contention, with no `cd` leakage between them).

A subagent works in its worktree by either `cd`-ing into it within its own Bash calls (its cwd
is private to that subagent) or prefixing every command with `git -C <path>` / using absolute
paths for file edits. Either is fine; never use `EnterWorktree`.

## Protocol

### Step 1 — Compute the wave

1. `node scripts/sprint/claims.mjs waves`. Take **Wave 1's startable members** — the `backlog`
   entries (skip anything tagged `(in flight)`: another agent already owns it; skip `⚠️ no
   claims`: it isn't parallel-safe — run it solo via plain `/sprint start`). Members tagged
   `⚠ unplanned` or `⚠ stale plan` stay in the wave — Step 2 plans them before dispatch.
2. Present the set to the user and confirm — per member: ID, goal, points, plan status
   (`plan_date` or unplanned/stale), and open-question count. A wave of 2–4 is typical; more
   than that, ask whether to cap it.

### Step 2 — Plan the wave

The sprint file is each execution subagent's **entire brief** — a thin file makes a thin
agent. This step brings every member's file to execution-ready before anything starts.

**2a — Skip check (mechanical, no body reads).** A member skips the planning subagent iff
ALL hold: `plan_date` is set; no `depends_on` sprint has `end_date` after it (i.e. not
`⚠ stale plan`); `touches:` is populated; and no cross-sprint signal implicates it (2c). For
skipped members, still grep their unchecked `## Open Questions` items (`- [ ]` lines) and
feed any into the decision round (2e). A wave planned just-in-time via `/sprint plan`
typically skips everything; later waves typically re-plan — that is the intended cost
profile.

**2b — Planning fan-out (parallel).** Dispatch one **`sprint-planner`** subagent per
non-skipped member, all in a single message, at a cheap/mid model. Use the **Planning
dispatch prompt** below — pass only the sprint ID, the absolute backlog-file path in the
primary checkout, the repo root, the wave roster (IDs + `touches:`), and the sprints landed
since its `plan_date`. Planners edit their (pairwise-distinct) backlog files **uncommitted**
in the primary checkout; the ledger is briefly dirty, which is fail-safe — any external
`start.sh` refuses on its clean-ledger precondition. Do not run start transactions while
planners are in flight.

**2c — Wave constraints check.** Always (orchestrator, mechanical): after the planners
return, re-run `node scripts/sprint/claims.mjs waves` and, per member,
`claims.mjs check --sprint S-NNN` — touches corrections may have broken pairwise
disjointness; a member that now overlaps drops to a later wave. Scan the planner reports'
`CROSS_SPRINT` / `CONTRACT_DRIFT` lines. Record everything in
`.claude/sprint-orchestration/wave-plan.md` (see ledger below). **Conditionally**: if any
CROSS_SPRINT signal fires (e.g. a shared file all members need, contract misalignment
between members), dispatch one wave-planning subagent to read the affected sprint files +
code and propose a reshape — classic outcome: extract a **foundation sprint** that the
members then `depends_on` (create it via `/sprint create` + `/sprint plan`, add the edges
with `frontmatter.mjs set`, recompute waves; affected members drop out of this wave).

**2d — Locked commit #1.** `lock.sh acquire wave-plan-deepen` → `node scripts/sprint/regen.mjs`
(the waves block depends on touches) → commit
`sprint: wave-plan deepen S-A,S-B,…` (explicit backlog-file paths + INDEX/ROADMAP,
`--no-verify`) → push → release. Deepening is committed even for members that later drop —
the work keeps its value and its `plan_date`.

**2e — Decision round (no lock held).** Batch **all** members' questions into AskUserQuestion
calls (≤4 questions each), labeled `S-NNN D-A: …` with the planner's options. More than ~8
total questions is a planning smell — the per-planner cap is 2–3; push back rather than
relay a quiz. `NOT_READY` / `SPLIT_SUGGESTED` verdicts surface here as defer / split /
proceed-anyway choices — never silently drop a member.

**2f — Apply decisions + locked commit #2.** The orchestrator itself (the answers are
already in its context) appends each answer to the sprint file's **Pre-Sprint Decisions**
section as `- YYYY-MM-DD (wave): [decision] — [rationale]`, checks off the answered Open
Questions items, and applies any option-implied edits the planner pre-declared. Re-run
`claims.mjs waves` if decisions shifted touches. Then the same lock pattern: commit
`sprint: wave decisions S-A,S-B,…`, push, release. Zero questions → 2e/2f collapse to
nothing.

### Step 3 — Start each sprint + create its worktree (orchestrator, serialized)

For each remaining member, in the primary checkout: dependency check →
`claims.mjs check --sprint S-NNN` (stop/ask on overlap) → `start.sh S-NNN` **without
`--touches`** (the file's manifest was verified in Step 2; the start commit lands on `main`
under the lock) → `git worktree add .claude/worktrees/S-NNN-… -b S-NNN-… main` (from the
post-start main tip; **no EnterWorktree**) → setup (copy env files, install deps with
`{{PACKAGE_MANAGER}}`).

These run one-at-a-time: `start.sh` serializes on the lock anyway (each start is a fast
commit, so brief contention). PROTOCOL Phase 1's doc validation and tradeoff questions are
already covered by Step 2 (doc drift recorded in each file's PLAN NOTES; decisions in
Pre-Sprint Decisions).

### Step 4 — Fan out execution (parallel subagents)

Dispatch **one execution subagent per sprint, all in a single message** (multiple tool calls in
one turn = they run concurrently). Use the **Execution dispatch prompt** below. **File-based
handoff:** pass only the sprint ID + worktree path — the sprint file *is* the brief; the
subagent reads it. Do not paste the sprint's contents into the prompt (it would bloat your
context for the rest of the session).

A subagent returns one of: **DONE** (deliverables complete, acceptance evidence gathered, report
file written), **BLOCKED** (needs a decision — handle it, then re-dispatch), **NEEDS_CLAIM**
(wants a file outside its `touches:` — the orchestrator runs `claims.mjs add` under the lock,
mirrors it, then tells the subagent to proceed; never let a subagent mutate `main`), or
**PLAN_GAP** (the brief is wrong or too thin to execute — see Failure handling).

### Step 5 — Serialize completions (orchestrator, one at a time)

**Do NOT fan out `/sprint done`.** `merge-sprint.sh` holds the main-lock across
`prepare → land → finish`, *including the exit-4 pause where you author the semantic docs* — so
racing completions make all but one hit the 5-minute lock ceiling (exit 75). Complete finished
sprints **sequentially**: for each, run PROTOCOL **Phase 3** in full (acceptance-evidence check —
work from the sprint's report file in `.claude/sprint-orchestration/`, spot-checking citations,
instead of re-interrogating the worktree → doc sync → `/adr check` → `prepare` → `land` →
author docs → `finish`), then remove its worktree, then move to the next. A sprint that lands
changes (`prepare` exit 3) re-runs the gate in its worktree before `land`, lock held — that
serialization is the point.

### Step 6 — Review, then the next wave

After the wave's sprints have all landed on `main`, run one broad `/review` over the merged
result (a fresh reviewer catches cross-sprint integration issues per-sprint review can't) —
hand it the wave's report-file paths as a starting map. Then recompute `claims.mjs waves` —
newly-unblocked sprints form the next wave. Members whose `plan_date` predates the sprints
that just landed are tagged `⚠ stale plan` and re-enter Step 2a automatically on the next
wave. Repeat from Step 1, or report the board and stop.

### Durable progress ledger

Conversation memory does not survive compaction; a controller that loses its place has
re-dispatched already-landed sprints — the most expensive failure mode. Keep a ledger:

- Create `.claude/sprint-orchestration/` with a self-ignoring `.gitignore`:
  `printf '*\n' > .claude/sprint-orchestration/.gitignore` (the dir is runtime scratch, never
  committed).
- Maintain `.claude/sprint-orchestration/wave-progress.md`: one line per sprint —
  `S-NNN | planned(date) | decisions | started | worktree=… | status=dispatched|DONE|PLAN_GAP|landed`.
  Update it as agents report and as you land.
- Maintain `.claude/sprint-orchestration/wave-plan.md` per wave: members table (ID, verdict,
  plan_date, touches summary), constraint findings, contract edges checked, pending
  decisions, dispatch checklist. This is where planning-pass state survives compaction —
  including which backlog files may be dirty-uncommitted mid-Step-2.
- Execution subagents write `.claude/sprint-orchestration/S-NNN-report.md` (per-deliverable
  commits, gate/test results, acceptance-criteria evidence citations, deviations from brief,
  deferred items) — it outlives the worktree and feeds Step 5's evidence check and Step 6's
  review.
- After a compaction, trust this ledger + `git log` + `/sprint board` (the `in-progress/` set on
  `main` is authoritative), never recollection. Never start or land a sprint already marked
  `landed`.

### Model / effort selection

Dispatch each execution subagent with the **cheapest model that fits the sprint** (transcription-
heavy sprints where the plan already contains the code → a small model; multi-file integration →
standard). Planning subagents: cheap/mid (read-heavy, one-file writes). The conditional
wave-planner: mid. Reserve the strongest model for the final broad `/review`. Always set the
model explicitly — an omitted model inherits this (expensive) session's model.

---

## Planning dispatch prompt (sprint-planner subagent)

Adapt and send one per non-skipped member (fill the brackets; the agent definition at
`.claude/agents/sprint-planner.md` carries the full duties):

> You are the sprint-planner subagent for **S-NNN**. Follow your agent instructions
> (`.claude/agents/sprint-planner.md`).
>
> - Sprint file (edit ONLY this file, do not commit): `<absolute path to backlog file>`
> - Repo root: `<absolute repo root>`
> - Wave roster: `S-AAA touches [...]; S-BBB touches [...]`
> - Landed since this sprint's plan_date: `S-CCC (<done-file path>), …` (or "none")
>
> Verify and deepen the sprint file against the CURRENT code, set `plan_date` if it reaches
> the readiness bar, and return the structured ≤20-line report from your instructions.

For a **post-start PLAN_GAP repair**, say so explicitly, point at the in-progress copy inside
the worktree, and remind it to commit on the sprint branch as `S-NNN: revise plan — <reason>`.

## Execution dispatch prompt (execution subagent)

Adapt and send one per sprint (fill `S-NNN` and the worktree path):

> You are an execution subagent for sprint **S-NNN**. Work ONLY inside the worktree at
> `<absolute worktree path>`, using `git -C "<path>"` and absolute paths — do **NOT** use
> EnterWorktree, do **NOT** touch `main` or any file under `docs/sprints/` except this sprint's
> own file, and do **NOT** edit `INDEX.md` / `ROADMAP.md` / `DOC_HEALTH.md`.
>
> 1. Read the sprint file `docs/sprints/in-progress/S-NNN-*.md` (in the worktree) — it is your
>    full brief: deliverables (in order), Interface Contract, Pre-Sprint Decisions (binding),
>    acceptance criteria, `touches:`.
> 2. **Verify the brief before writing any code**: each deliverable's `Files:`/`Reference:`/
>    `Interface:` citations exist as described; cited APIs match the installed versions (check
>    the dependency manifest when a versioned API is cited). Trivial drift (a symbol moved
>    lines) → locate it, note it in the sprint file, proceed. An approach-invalidating gap —
>    stale premise, missing referenced file, unresolved decision, an acceptance criterion you
>    cannot evaluate — → STOP without writing code and return **PLAN_GAP**: the specific
>    gap(s), evidence (file:line / version found), and a proposed correction (≤10 lines).
>    Apply any doc-drift fixes recorded in the file's PLAN NOTES (commit
>    `docs: fix drift found in pre-sprint validation for S-NNN` on the branch).
> 3. Execute **Phase 2** of `docs/sprints/PROTOCOL.md` for each deliverable: **test-first
>    (RED → GREEN → refactor)**, run `scripts/sprint/gate.sh` before each commit (all must pass —
>    never commit broken code), commit atomically per deliverable as `S-NNN: <description>`.
>    Apply `docs/ENGINEERING_PRINCIPLES.md` (YAGNI/KISS/DRY/SOLID). Hit an unexpected failure →
>    follow `.claude/skills/debug/SKILL.md` (root-cause before fixing).
> 4. Stay within your `touches:`. If you must edit a file outside it, STOP and return
>    **NEEDS_CLAIM** with the path — do not edit it.
> 5. Gather acceptance-criteria **evidence** (cite test/file:line/output, the observable
>    difference — not just "it ran"). Do **NOT** run the completion/land — that's the
>    orchestrator's job.
> 6. On DONE, write your full report to
>    `<repo-root>/.claude/sprint-orchestration/S-NNN-report.md` (deliverable commits, gate/test
>    results, per-criterion evidence citations, deviations from the brief, deferred items).
> 7. Return ≤15 lines: status (**DONE** / **BLOCKED** / **NEEDS_CLAIM** / **PLAN_GAP**), the
>    deliverable commits (`git -C "<path>" log --oneline`), a one-line gate/test result, the
>    report path, and any concerns — do not paste the report.

## Failure handling

- **A planning subagent dies mid-edit:** its backlog file may be dirty-uncommitted on `main`.
  No lock was held and nothing was committed — recovery is
  `git -C <root> checkout -- docs/sprints/backlog/S-NNN-*.md`, then re-dispatch or drop the
  member (wave-plan.md records which files were handed to planners).
- **A member is rejected at the decision round:** pre-start this is free — keep the committed
  deepening, drop the member from the roster, note it in wave-plan.md. Removing members
  preserves pairwise disjointness; only *adding* members forces a re-check.
- **An execution subagent dies / returns BLOCKED:** resolve the blocker (answer the question,
  expand the claim), then re-dispatch a fresh subagent for that sprint (its committed work
  persists on the branch).
- **PLAN_GAP:** the brief is wrong — fix the brief, don't abandon the sprint. Re-dispatch a
  `sprint-planner` in post-start mode against the **worktree copy** of the in-progress file
  (edits commit on the sprint branch); run `claims.mjs add` under the lock for any touches
  growth it reports (mirror in the branch copy); run a mini decision round if it raises
  questions; then re-dispatch execution. If the user instead decides to pull the sprint back
  entirely: `scripts/sprint/unstart.sh S-NNN --reason "…"` (refuses if the branch carries
  deliverable commits — then prefer `rejected/` or completion), then remove the worktree and
  branch it prints.
- **Start race (`start.sh` exit 2, backlog file gone):** another agent already started it —
  drop it from the wave.
- **Lock busy (exit 75) during a completion:** another orchestrator/agent holds it; wait or
  inspect with `lock.sh status` (PROTOCOL "The sprint-main lock"). Never steal silently.
- **Orphaned worktree** (sprint in `in-progress/` with no worktree, or vice-versa): see
  `/sprint board`'s orphan check before re-dispatching.
