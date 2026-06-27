# Sprint Orchestration Protocol (full tier)

How a single session fans a **wave** of sprints out to parallel subagents and integrates the
results, for {{PROJECT_NAME}}. The `/sprint wave` command defers to this file. This is the
**full tier only** — it relies on the worktree + file-claims + main-lock machinery described in
`PROTOCOL.md` ("Parallel Sprints"). Read that first; this document only adds the orchestration
layer on top.

## The division of labor

The trick that makes this safe: **the orchestrator owns everything that mutates `main` or needs
human judgment; subagents only write deliverable code in their own worktree.**

| Owner | Does | Touches |
|-------|------|---------|
| **Orchestrator** (this session) | Compute the wave; per sprint run Phase 1 (dep check, claims check, `start.sh` under the lock, create the worktree, pre-sprint doc validation, architectural-tradeoff questions); dispatch execution subagents; collect reports; **serialize** Phase 3 completions; final review | `main` (lock-serialized), the ledger docs, the user |
| **Execution subagent** (one per sprint) | PROTOCOL **Phase 2 only** — implement deliverables test-first, gate, commit atomically — inside its assigned worktree | its worktree branch only |

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
   claims`: it isn't parallel-safe — run it solo via plain `/sprint start`).
2. Present the set to the user and confirm (count, IDs, goals). A wave of 2–4 is typical; more
   than that, ask whether to cap it.

### Step 2 — Start each sprint + create its worktree (orchestrator, serialized)

For each sprint in the confirmed set, run **PROTOCOL Phase 1** in the primary checkout:
dependency check → `claims.mjs check` (stop/ask on overlap) → `start.sh S-NNN --touches "…"`
(lands the start commit on `main` under the lock) → `git worktree add
.claude/worktrees/S-NNN-… -b S-NNN-… main` (from the post-start main tip; **no EnterWorktree**)
→ pre-sprint doc validation → architectural-tradeoff questions.

These run one-at-a-time: `start.sh` serializes on the lock anyway (each start is a fast commit,
so brief contention), and the tradeoff questions are the moment to batch any human decisions for
the whole wave. Setup each worktree (copy env files, install deps with `{{PACKAGE_MANAGER}}`).

### Step 3 — Fan out execution (parallel subagents)

Dispatch **one execution subagent per sprint, all in a single message** (multiple tool calls in
one turn = they run concurrently). Use the **Dispatch prompt** below. **File-based handoff:**
pass only the sprint ID + worktree path — the sprint file *is* the brief; the subagent reads it.
Do not paste the sprint's contents into the prompt (it would bloat your context for the rest of
the session).

A subagent returns one of: **DONE** (deliverables complete, acceptance evidence gathered),
**BLOCKED** (needs a decision — handle it, then re-dispatch), or **NEEDS_CLAIM** (wants a file
outside its `touches:` — the orchestrator runs `claims.mjs add` under the lock, mirrors it, then
tells the subagent to proceed; never let a subagent mutate `main`).

### Step 4 — Serialize completions (orchestrator, one at a time)

**Do NOT fan out `/sprint done`.** `merge-sprint.sh` holds the main-lock across
`prepare → land → finish`, *including the exit-4 pause where you author the semantic docs* — so
racing completions make all but one hit the 5-minute lock ceiling (exit 75). Complete finished
sprints **sequentially**: for each, run PROTOCOL **Phase 3** in full (acceptance-evidence check →
doc sync → `/adr check` → `prepare` → `land` → author docs → `finish`), then remove its worktree,
then move to the next. A sprint that lands changes (`prepare` exit 3) re-runs the gate in its
worktree before `land`, lock held — that serialization is the point.

### Step 5 — Review, then the next wave

After the wave's sprints have all landed on `main`, run one broad `/review` over the merged
result (a fresh reviewer catches cross-sprint integration issues per-sprint review can't). Then
recompute `claims.mjs waves` — newly-unblocked sprints form the next wave. Repeat from Step 1, or
report the board and stop.

### Durable progress ledger

Conversation memory does not survive compaction; a controller that loses its place has
re-dispatched already-landed sprints — the most expensive failure mode. Keep a ledger:

- Create `.claude/sprint-orchestration/` with a self-ignoring `.gitignore`:
  `printf '*\n' > .claude/sprint-orchestration/.gitignore` (the dir is runtime scratch, never
  committed).
- Maintain `.claude/sprint-orchestration/wave-progress.md`: one line per sprint —
  `S-NNN | started | worktree=… | status=dispatched|DONE|landed`. Update it as agents report and
  as you land.
- After a compaction, trust this ledger + `git log` + `/sprint board` (the `in-progress/` set on
  `main` is authoritative), never recollection. Never start or land a sprint already marked
  `landed`.

### Model / effort selection

Dispatch each execution subagent with the **cheapest model that fits the sprint** (transcription-
heavy sprints where the plan already contains the code → a small model; multi-file integration →
standard). Reserve the strongest model for the final broad `/review`. Always set the model
explicitly — an omitted model inherits this (expensive) session's model.

---

## Dispatch prompt (execution subagent)

Adapt and send one per sprint (fill `S-NNN` and the worktree path):

> You are an execution subagent for sprint **S-NNN**. Work ONLY inside the worktree at
> `<absolute worktree path>`, using `git -C "<path>"` and absolute paths — do **NOT** use
> EnterWorktree, do **NOT** touch `main` or any file under `docs/sprints/` except this sprint's
> own file, and do **NOT** edit `INDEX.md` / `ROADMAP.md` / `DOC_HEALTH.md`.
>
> 1. Read the sprint file `docs/sprints/in-progress/S-NNN-*.md` (in the worktree) — it is your
>    full brief: deliverables (in order), Interface Contract, acceptance criteria, `touches:`.
> 2. Execute **Phase 2** of `docs/sprints/PROTOCOL.md` for each deliverable: **test-first
>    (RED → GREEN → refactor)**, run `scripts/sprint/gate.sh` before each commit (all must pass —
>    never commit broken code), commit atomically per deliverable as `S-NNN: <description>`.
>    Apply `docs/ENGINEERING_PRINCIPLES.md` (YAGNI/KISS/DRY/SOLID). Hit an unexpected failure →
>    follow `.claude/skills/debug/SKILL.md` (root-cause before fixing).
> 3. Stay within your `touches:`. If you must edit a file outside it, STOP and return
>    **NEEDS_CLAIM** with the path — do not edit it.
> 4. Gather acceptance-criteria **evidence** (cite test/file:line/output, the observable
>    difference — not just "it ran"). Do **NOT** run the completion/land — that's the
>    orchestrator's job.
> 5. Return ≤15 lines: status (**DONE** / **BLOCKED** / **NEEDS_CLAIM**), the deliverable commits
>    (`git -C "<path>" log --oneline`), a one-line gate/test result, and any concerns. Write any
>    longer report to a file in the worktree and return its path — do not paste it.

## Failure handling

- **A subagent dies / returns BLOCKED:** resolve the blocker (answer the question, expand the
  claim), then re-dispatch a fresh subagent for that sprint (its committed work persists on the
  branch).
- **Start race (`start.sh` exit 2, backlog file gone):** another agent already started it — drop
  it from the wave.
- **Lock busy (exit 75) during a completion:** another orchestrator/agent holds it; wait or
  inspect with `lock.sh status` (PROTOCOL "The sprint-main lock"). Never steal silently.
- **Orphaned worktree** (sprint in `in-progress/` with no worktree, or vice-versa): see
  `/sprint board`'s orphan check before re-dispatching.
