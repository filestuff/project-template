# Sprint Orchestration Protocol (full tier)

How a session fans a **wave** of sprints out to parallel subagents and integrates the
results, for {{PROJECT_NAME}} — and how it drives a serial **train** of dependent sprints
through one worktree with batched landings (see "The serial train" below). The
`/sprint wave` and `/sprint train` commands defer to this file. This is the
**full tier only** — it relies on the worktree + file-claims + main-lock machinery described in
`PROTOCOL.md` ("Parallel Sprints"). Read that first; this document only adds the orchestration
layer on top.

Waves are **multi-session safe**: two terminal sessions can each drive their own wave on the
same repo. Each wave gets an id (`W-<date>-<hex>`, minted by `reserve-wave.sh`), a committed
reservation of its members, and its own ledger directory. See "Running waves from multiple
sessions" below.

## The division of labor

The trick that makes this safe: **the orchestrator owns everything that mutates `main` or needs
human judgment; subagents only write into files they are explicitly handed.** The orchestrator
stays lean — it never reads sprint bodies, diffs, or code into its own context; subagents
return short structured summaries or file paths.

| Owner | Does | Touches |
|-------|------|---------|
| **Orchestrator** (this session — the "master") | Compute + reserve the wave; run the planning pass (dispatch planners, batch the decision round, write answers into sprint files, two locked commits); per sprint run start (dep check, claims check, `start.sh` under the lock, create the worktree); dispatch `sprint-executor` subagents; **advise** blocked subagents (see The advisor loop); collect reports; **serialize** Phase 3 completions; adjudicate review findings | `main` (lock-serialized), the ledger docs, the user |
| **Planning subagent** (`sprint-planner`, one per unplanned/stale sprint) | Verify + deepen ONE sprint file against current `main`: staleness, contract drift, deliverable detail, `touches:`, decision-ready questions; set `plan_date` | its assigned sprint file only (in the wave's planning worktree — the orchestrator commits) |
| **Wave-planning subagent** (`wave-planner`, conditional) | Cross-sprint constraint check when planner reports signal it (shared foundations, contract misalignment) | the wave's wave-plan.md only |
| **Execution subagent** (`sprint-executor`, one per sprint) | PROTOCOL **Phase 2 only** — verify the brief, implement deliverables test-first, gate, commit atomically, run a `reviewer` child before DONE — inside its assigned worktree; may spawn read-only Explore/debug children (see Executor children) | its worktree branch only + its report file |
| **Reviewer subagent** (`reviewer`) | Per-sprint branch review (as the executor's child) and the post-wave broad review over merged `main` | nothing — findings list only |

Every subagent role has an agent definition under `.claude/agents/` with `model: sonnet`
pinned — **never dispatch a definition-less generic subagent in a wave**; there is no
spawn-time model override, so it would silently inherit the master's (expensive) model.

The orchestrator's primary checkout stays parked on `main` (it is the lifecycle ledger). It
**never** enters a worktree — it creates them with `git worktree add` and hands the path to a
subagent.

## Push policy

A 5-sprint wave running the solo lifecycle scripts unmodified would push to `origin` on every
transaction — reserve, deepen, decisions, N starts, N finishes — roughly 13 pushes, each firing
downstream CI. Waves instead **defer** pushes and settle them at three checkpoints: **during a
wave, every main-mutating script gets `--no-push`; only `scripts/sprint/push-main.sh` pushes.**

- **P1 (wave start).** `reserve-wave.sh` is the sole exception to the no-push rule above — it
  keeps its normal push as the wave's origin-sync point, backing up the roster. Its commit
  carries `[skip ci]`, so it costs zero CI.
- **P2 (after the last `start.sh --no-push`).** Run `push-main.sh` — a ledger-only backup push,
  zero CI (HEAD is a `[skip ci]` start commit).
- **P3 (wave end, mandatory).** After the last `merge-sprint.sh finish <branch> --no-push` and
  any `reserve-wave.sh --release`, run `push-main.sh` — the single CI-triggering push of the
  wave. PROTOCOL Phase 3 Step 6's "verify CI green" check runs exactly once here, against this
  push, covering every sprint in the wave.

**The `[skip ci]` convention:** ledger-only lifecycle commits (start, claim expansions, deepen,
decisions, reservations) carry a trailing ` [skip ci]`. The `sprint: complete` commit written by
`merge-sprint.sh finish` deliberately does **not** — it is the HEAD of a code-bearing push, and a
skip marker there would skip CI for landed code.

**`push-main.sh [--wait <secs>]` contract:** acquires the sprint-main lock (label `push-main`);
fetches `origin` and refuses with a hard error if the remote has diverged (it never auto-rebases
the ledger); exits 0 ("nothing to push") when local `main` already matches `origin`; guards a
`[skip ci]` HEAD — if the HEAD commit carries a skip marker but the pushed range touches paths
outside `docs/` and `.claude/`, it appends an empty, unmarked
`ci: run checks for wave push (<range>)` commit so code pushes still trigger CI; then pushes and
reports the pushed range.

On a long-running (multi-hour) wave, the orchestrator **may** run `push-main.sh` after any
individual sprint's finish for backup, at the cost of one CI cycle per extra push — a deliberate
tradeoff, not a violation of the checkpoint schedule.

**Abandoning or pausing a wave:** always run `bash scripts/sprint/push-main.sh` before walking
away. A deferred wave must never leave local `main` silently ahead of `origin` — this applies
equally to abandonment (Failure handling) and to any pause longer than a session (e.g. a decision
round parked overnight).

Solo (non-wave) `/sprint start` and `/sprint done` are unaffected — they keep push-per-transaction.

## Worktree mode: path-scoped (verified)

Subagents operate **entirely through `git -C <worktree>` and absolute paths** — they do
**not** call `EnterWorktree`/`ExitWorktree`. This avoids any reliance on session-global
worktree state across concurrent subagents and rests only on per-subagent Bash isolation +
git's own worktree concurrency safety (both confirmed: concurrent subagents each created a
worktree, committed, and saw no `index.lock`/ref contention, with no `cd` leakage between them).

A subagent works in its worktree by either `cd`-ing into it within its own Bash calls (its cwd
is private to that subagent) or prefixing every command with `git -C <path>` / using absolute
paths for file edits. Either is fine; never use `EnterWorktree`.

## Protocol

### Step 1 — Compute the wave

1. `node scripts/sprint/claims.mjs waves`. Take **Wave 1's startable members** — the `backlog`
   entries. Skip anything tagged `(in flight)` (another agent already owns it), `(reserved
   W-…)` for a wave id that is not yours (another session's roster — treat like in-flight),
   or `⚠️ no claims` (it isn't parallel-safe — run it solo via plain `/sprint start`). Members
   tagged `⚠ unplanned` or `⚠ stale plan` stay in the wave — Step 2 plans them before dispatch.
2. Present the set to the user and confirm — per member: ID, goal, points, plan status
   (`plan_date` or unplanned/stale), and open-question count. A wave of 2–4 is typical; more
   than that, ask whether to cap it.

### Step 1.5 — Reserve the wave

`bash scripts/sprint/reserve-wave.sh S-A S-B …` — a locked `main` commit that mints the wave
id (`W-<date>-<hex>`, printed) and writes `wave: W-<id>` into each member's frontmatter.
From this commit on, `claims.mjs` treats the members as claim holders: another session's wave
can neither reserve them nor reserve/start anything whose `touches:` overlap theirs. This is
**checkpoint P1** (see Push policy): the script pushes as usual, and its commit carries
`[skip ci]`.

- Exit 2 (member gone / already reserved / claims overlap): another session moved first —
  recompute Step 1 and re-confirm a smaller or different roster.
- Record the wave id, then create the wave's ledger dir (see Durable progress ledger):
  `.claude/sprint-orchestration/W-<id>/`.
- A member that later leaves the roster is released at that moment with
  `reserve-wave.sh --drop W-<id> S-NNN`; the whole reservation is released at wave end (or
  abandonment) with `--release W-<id>`.

### Step 2 — Plan the wave

The sprint file is each execution subagent's **entire brief** — a thin file makes a thin
agent. This step brings every member's file to execution-ready before anything starts.

**2a — Skip check (mechanical, no body reads).** A member skips the planning subagent iff
ALL hold: `plan_date` is set; no `depends_on` sprint has `end_date` after it (i.e. not
`⚠ stale plan`); `touches:` is populated; and no cross-sprint signal implicates it (2c). For
skipped members, still grep their unchecked `## Open Questions` items (`- [ ]` lines) and
feed any into the decision round (2e). A wave planned just-in-time via `/sprint plan`
typically skips everything; later waves typically re-plan — that is the intended cost
profile. If **every** member skips, no planning worktree is needed — go straight to 2e.

**2b — Planning fan-out (parallel, in a planning worktree).** First create the wave's
planning worktree:
`git worktree add .claude/worktrees/wave-W-<id>-plan -b wave-W-<id>-plan main`.
Then dispatch one **`sprint-planner`** subagent per non-skipped member, all in a single
message, using the **Planning dispatch prompt** below — pass only the sprint ID, the
absolute backlog-file path **inside the planning worktree**, the repo root, the wave roster
(IDs + `touches:`), and the sprints landed since its `plan_date`. Planners edit their
(pairwise-distinct) files in the worktree; the primary checkout — the ledger — **stays
clean throughout**, so other waves' locked transactions are never blocked by this pass.

**2c — Wave constraints check.** Always (orchestrator, mechanical): after the planners
return, re-run the wave math **against the planning worktree** (it holds the corrected
`touches:`): `SPRINT_ROOT=<planning-worktree> node scripts/sprint/claims.mjs waves` and,
per member, `SPRINT_ROOT=<planning-worktree> node scripts/sprint/claims.mjs check --sprint
S-NNN` — touches corrections may have broken pairwise disjointness; a member that now
overlaps drops to a later wave (`reserve-wave.sh --drop`). Step 3's `start.sh` re-checks
claims against the live ledger anyway — that check is authoritative. Scan the planner
reports' `CROSS_SPRINT` / `CONTRACT_DRIFT` lines. Record everything in the wave's
`wave-plan.md`. **Conditionally**: if any CROSS_SPRINT signal fires (e.g. a shared file all
members need, contract misalignment between members), dispatch one **`wave-planner`**
subagent to read the affected sprint files + code and propose a reshape — classic outcome:
extract a **foundation sprint** that the members then `depends_on` (create it via
`/sprint create` + `/sprint plan`, add the edges with `frontmatter.mjs set`, recompute
waves; affected members drop out of this wave — `--drop` them).

**2d — Locked commit #1 (deepen).** `lock.sh acquire wave-plan-deepen-W-<id>` → copy the
planners' edits onto the ledger:
`cp <planning-worktree>/docs/sprints/backlog/<file> <root>/docs/sprints/backlog/<file>`
per roster file (a plain copy — the planners' edits are uncommitted working-tree state in
the planning worktree, so `git checkout <branch> -- <path>` would NOT see them; the copy is
safe because reserved files cannot move on `main` — only lifecycle scripts move them, and
they are reserved) → `node scripts/sprint/regen.mjs` (the waves block depends on touches) →
commit `sprint: wave-plan deepen W-<id> — S-A,S-B,… [skip ci]` (explicit backlog-file paths +
INDEX/ROADMAP, `--no-verify`) → release (no push — the commit carries `[skip ci]` and rides
the next checkpoint). Deepening is committed even for members that later drop — the work
keeps its value and its `plan_date`.

**2e — Decision round (no lock held).** Batch **all** members' questions into AskUserQuestion
calls (≤4 questions each), labeled `S-NNN D-A: …` with the planner's options and its
marked recommendation. More than ~8
total questions is a planning smell — the per-planner cap is 2–3; push back rather than
relay a quiz. `NOT_READY` / `SPLIT_SUGGESTED` verdicts surface here as defer / split /
proceed-anyway choices — never silently drop a member (and `--drop` whatever the user
defers).

**2f — Apply decisions + locked commit #2.** Entirely under the lock (the orchestrator's
own edits take seconds — the ledger must not sit dirty outside it):
`lock.sh acquire wave-decisions-W-<id>` → append each answer to the sprint file's
**Pre-Sprint Decisions** section as `- YYYY-MM-DD (wave): [decision] — [rationale]`, check
off the answered Open Questions items, apply any option-implied edits the planner
pre-declared → re-run `claims.mjs waves` if decisions shifted touches → commit
`sprint: wave decisions W-<id> — S-A,S-B,… [skip ci]`, release (no push — see Push policy).
Zero questions → 2e/2f collapse to nothing. Finally remove the planning worktree (`--force`:
it still holds the planners' uncommitted edits, which 2d already copied and committed):
`git worktree remove --force .claude/worktrees/wave-W-<id>-plan && git branch -D wave-W-<id>-plan`.

### Step 3 — Start each sprint + create its worktree (orchestrator, serialized)

For each remaining member, in the primary checkout:

1. **Staleness re-check (cheap, mechanical — matters when other waves are landing).** List
   sprints landed since this wave's deepen commit:
   `git log --oneline --diff-filter=A <deepen-sha>..HEAD -- docs/sprints/done/`. Empty →
   proceed. Non-empty → grep this member's sprint-file body for paths matched by the landed
   sprints' `touches:`; an intersection means the brief's read-only premises (`Reference:`/
   `Interface:` citations) may cite moved code — re-dispatch a `sprint-planner` for that
   member first (verify-only; the executor's verify-the-brief step remains the backstop).
2. Dependency check → `claims.mjs check --sprint S-NNN` (stop/ask on overlap) →
   `start.sh S-NNN --wave W-<id> --no-push` **without `--touches`** (the file's manifest was
   verified in Step 2; the start commit lands on `main` under the lock; when another wave is
   live, add `--wait 900`) → `git worktree add .claude/worktrees/S-NNN-… -b S-NNN-… main`
   (from the post-start main tip; **no EnterWorktree**) → setup (copy env files, install deps
   with `{{PACKAGE_MANAGER}}`).

These run one-at-a-time: `start.sh` serializes on the lock anyway (each start is a fast
commit, so brief contention). PROTOCOL Phase 1's doc validation and tradeoff questions are
already covered by Step 2 (doc drift recorded in each file's PLAN NOTES; decisions in
Pre-Sprint Decisions).

After the **last** member's start: **checkpoint P2** — `bash scripts/sprint/push-main.sh`
(ledger-only; the HEAD commit carries `[skip ci]`, so this triggers no CI).

### Step 4 — Fan out execution (parallel subagents)

Dispatch **one `sprint-executor` subagent per sprint, all in a single message** (multiple tool
calls in one turn = they run concurrently). Use the **Execution dispatch prompt** below.
**File-based handoff:** pass only the sprint ID + worktree path + wave ledger dir — the sprint
file *is* the brief; the subagent reads it. Do not paste the sprint's contents into the prompt
(it would bloat your context for the rest of the session).

Before returning DONE, the executor runs a `reviewer` child over its branch diff and fixes all
Critical/Important findings — **Step 5 receives reviewed work**, and the report discloses the
review outcome.

A subagent returns one of: **DONE** (deliverables complete, reviewed, acceptance evidence
gathered, report file written), **BLOCKED** / **NEEDS_CLAIM** (handle via The advisor loop
below), or **PLAN_GAP** (the brief is wrong or too thin to execute — see Failure handling).

### The advisor loop

The master is the executors' first line of support — most blockers should die here without
reaching the user. A **BLOCKED** return arrives in the executor's structured form (QUESTION /
CONTEXT / OPTIONS / DEFAULT). Handle it:

1. **Answer from what you already hold**: the sprint's Pre-Sprint Decisions, the wave's
   wave-plan.md, your own plan context from Steps 1–2. Most blockers are already decided
   there.
2. **Answer from the repo**: a *targeted* read (a config file, an interface, a doc) is fine —
   but never the sprint's diff or body wholesale; that budget belongs to Step 5/6 survival.
3. **Escalate to the user** only when it is a genuine product/architecture tradeoff you
   cannot decide: AskUserQuestion, batched if several sprints are blocked at once, labeled
   `S-NNN: …` with the executor's OPTIONS.

Deliver the answer by **continuing the same subagent (SendMessage) — not a fresh dispatch**:
its context (partial work, dead ends already explored) is the most valuable thing it has.
Re-dispatch fresh only if the agent died (see Failure handling). For **NEEDS_CLAIM**: run
`claims.mjs add S-NNN <path> --no-push` under the lock (checks the path is free of other
in-flight sprints *and* other waves' reservations), then continue the subagent with "claim
granted — mirror the touches: addition in your branch copy and proceed."

Recording: the executor writes the answer into its sprint file's Pre-Sprint Decisions as
`- YYYY-MM-DD (wave, in-flight): [decision] — [rationale]` (the file lives in its worktree);
the master mirrors one line into the wave's wave-progress.md.

### Executor children

Executors may spawn their own subagents — at most 2–3 per sprint: **Explore** (read-only
recon of an unfamiliar subsystem), **reviewer** (the mandatory pre-completion review), and
**debug** (a failure that resists two root-cause attempts). Every child prompt must restate
the worktree path + `git -C` discipline (never EnterWorktree), the `touches:` list (report,
never edit, outside it), and "do not commit — the parent commits". Children are leaves —
they never spawn further agents. An executor that needs more children than this is holding a
brief that is too thin: that is a PLAN_GAP, not a staffing problem. (Full rules live in
`.claude/agents/sprint-executor.md`.)

### Step 5 — Serialize completions (orchestrator, one at a time)

**Do NOT fan out `/sprint done`.** `merge-sprint.sh` holds the main-lock across
`prepare → land → finish`, *including the exit-4 pause where you apply the semantic docs* — so
racing completions make all but one hit the lock ceiling (exit 75). Complete finished sprints
**sequentially**. For each:

1. **Pre-draft the semantic docs before taking the lock** (mandatory when another wave is
   live, recommended always): write the DOC_HEALTH rows/History entry, INDEX Done-row, and
   ROADMAP narrative into `.claude/sprint-orchestration/W-<id>/S-NNN-docs-draft.md`. The
   exit-4 pause then becomes "apply the draft" — seconds of lock-held time, not minutes.
2. Run PROTOCOL **Phase 3 through `finish`**: acceptance-evidence check — work from the
   sprint's report file in `.claude/sprint-orchestration/W-<id>/`, spot-checking citations,
   instead of re-interrogating the worktree. The check now also covers the report's **review
   section**: the reviewer child ran, Critical/Important findings were fixed or escalated,
   declined findings have recorded reasons — adjudicate that from the report; do not read the
   diff. Then doc sync → `/adr check` → `prepare` (add `--wait 900` when another wave is live)
   → `land` → apply the docs draft → `finish <branch> --no-push`. Phase 3 Step 6's CI check
   does **not** run here — `finish` deferred its push, so there is nothing to poll yet; it
   defers to checkpoint P3 in Step 6 below, which covers every sprint in the wave at once.
3. Remove the sprint's worktree, then move to the next.

A sprint that lands changes (`prepare` exit 3) re-runs the gate in its worktree before
`land`, lock held — that serialization is the point.

### Step 6 — Review, then the next wave

After the wave's sprints have all landed on `main`, dispatch one **`reviewer`** subagent
(fresh context) over the merged wave result on `main` — a fresh reviewer catches cross-sprint
integration issues per-sprint review can't. Hand it the wave's report-file paths as a starting
map. The master does **not** perform this review itself: it adjudicates the returned findings
list — fix now (small), spin a follow-up sprint, or accept — and records the disposition in
wave-plan.md.

Then close out the wave: `reserve-wave.sh --release W-<id>` if any backlog members still
carry the reservation (deferred/split members). Then **checkpoint P3 (mandatory)**: run
`bash scripts/sprint/push-main.sh` — the single CI-triggering push of the wave — and run
PROTOCOL Phase 3 Step 6's "verify CI green" check against **this** push; it covers every
sprint in the wave in one pass. On a red run: identify the offending sprint locally by
bisecting over the wave's merge commits (each sprint's `gate.sh` already passed inside its
own worktree, so the regression is almost always an integration effect between sprints, not
a single sprint's own gate) — fix on `main` under the lock, then run `push-main.sh` again
(never a raw `git push` — the fix commit becomes the new HEAD and needs the same
`[skip ci]`-guard treatment) and re-verify.

Finally, recompute `claims.mjs waves` —
newly-unblocked sprints form the next wave. Members whose `plan_date` predates the sprints
that just landed are tagged `⚠ stale plan` and re-enter Step 2a automatically on the next
wave. Repeat from Step 1 (a new wave = a new reservation + ledger dir), or report the board
and stop.

### Durable progress ledger

Conversation memory does not survive compaction; a controller that loses its place has
re-dispatched already-landed sprints — the most expensive failure mode. Keep a per-wave ledger:

- Create `.claude/sprint-orchestration/` with a self-ignoring `.gitignore`
  (`printf '*\n' > .claude/sprint-orchestration/.gitignore` — runtime scratch, never
  committed), then a subdirectory per wave: `.claude/sprint-orchestration/W-<id>/`.
- Maintain `W-<id>/wave-progress.md`: one line per sprint —
  `S-NNN | planned(date) | decisions | started | worktree=… | status=dispatched|DONE|PLAN_GAP|landed`.
  Update it as agents report and as you land.
- Maintain `W-<id>/wave-plan.md`: members table (ID, verdict, plan_date, touches summary),
  constraint findings, contract edges checked, pending decisions, dispatch checklist,
  review dispositions. This is where planning-pass state survives compaction — including
  the planning-worktree path while Step 2 is in flight.
- Execution subagents write `W-<id>/S-NNN-report.md` (per-deliverable commits, gate/test
  results, acceptance-criteria evidence citations, review outcome, deviations from brief,
  deferred items) — it outlives the worktree and feeds Step 5's evidence check and Step 6's
  review. Step 5 adds `W-<id>/S-NNN-docs-draft.md`.
- After a compaction, trust this ledger + `git log` + `/sprint board` (the `in-progress/`
  set and `wave:` reservations on `main` are authoritative), never recollection. Your wave
  id is in the ledger dir name and in the reservation commit. Never start or land a sprint
  already marked `landed`.

### Roles and models

The **master** is this interactive session — assumed to run the strongest available model
(e.g. Fable). Its judgment is spent where it is cheapest and highest-leverage: orchestrating,
advising blocked agents, adjudicating findings lists and reports. It never reads diffs or
sprint bodies — that is what keeps it alive across a whole wave.

All wave subagents — `sprint-planner`, `sprint-executor`, `wave-planner`, `reviewer` — are
pinned `model: sonnet` in their agent definitions. There is **no spawn-time model override**,
so the definition is the only thing standing between a wave and N executors silently running
on the master's model: always dispatch by agent name, never as a generic subagent. Executors'
children inherit the same tier via their own definitions (`reviewer`) or the dispatch default.

### Running waves from multiple sessions

Two (or more) terminal sessions can drive concurrent waves on the same repo. What makes it
safe, and what to do differently:

- **Reservation before planning.** Step 1.5's locked `wave:` commit is what prevents two
  sessions from picking the same members or overlapping `touches:` — never skip it when
  waving, even solo (it costs one fast commit and makes your roster visible to the other
  session's `/sprint board`).
- **The ledger stays clean.** All planning edits happen in the wave's own planning worktree
  (2b); orchestrator edits on the primary happen only inside a lock window (2f). If you find
  the primary checkout dirty and you didn't dirty it, stop and ask the user — another
  session may be mid-transaction gone wrong.
- **Longer lock waits.** Detect a live foreign wave via `/sprint board` (reserved members,
  in-flight sprints you don't own). When one exists, pass `--wait 900` to `start.sh` and
  `merge-sprint.sh prepare` — the other wave's completion legitimately holds the lock across
  prepare→land→finish. On exit 75: `lock.sh status`; a live holder (label `start-*`/`land-*`/
  `reserve-*`, age under an hour) → retry once with `--wait 900`; older → surface to the
  user; **never steal silently**.
- **Keep lock-held pauses short.** Pre-draft completion docs (Step 5.1) so the exit-4 pause
  is seconds. The exit-3 gate re-run is irreducible; the other wave's 900s wait absorbs it.
- **Pushes cannot race.** During a wave, main-mutating transactions defer their push
  (`--no-push`); pushes serialize on the sprint-main lock through `push-main.sh` at the P1/P2/P3
  checkpoints instead. Sessions share one checkout, so a checkpoint push legitimately carries
  the other wave's local commits too — that's harmless, both waves' ledgers advance together.
  The pull/ff sync with `origin` now happens at P1 (`reserve-wave.sh`'s own push) and inside
  `push-main.sh`'s fetch + divergence check at P2/P3. A failed push (divergence, not a race —
  `push-main.sh` never auto-rebases the ledger) leaves the local commits intact with
  instructions; resolve before proceeding.
- **Stale reservations.** A crashed session leaves its `wave:` fields behind. Recovery is
  `reserve-wave.sh --release W-<id>` — but like `lock.sh steal`, only with the user's
  explicit confirmation that the other session is really dead.
- **Cross-wave staleness.** The other wave lands sprints while yours runs; your members'
  read-only premises can rot. Step 3.1's re-check catches it before dispatch; the executor's
  verify-the-brief step is the backstop.

### Dynamic workflow variant (optional)

If the **Workflow tool** is available in this environment, the two fan-outs — and only
those — can run as deterministic workflow scripts with schema-validated returns (no
text-parsing of planner verdicts / executor statuses) and resume-from-runId:

- Step 2b → `scripts/sprint/workflows/plan-wave.mjs` (args: wave id, roster with file paths
  in the planning worktree, repo root, landed-since list).
- Step 4 → `scripts/sprint/workflows/exec-wave.mjs` (args: wave id, sprints with worktree
  paths, repo root).

Everything else is unchanged and stays in-session: the decision round needs interactive
AskUserQuestion; starts, completions, and reservations are lock-serialized shell transactions
whose exit codes (2/3/4/75) demand in-session judgment. Note one tradeoff: workflow agents
return structured results but cannot be continued via SendMessage after the workflow ends —
a BLOCKED executor inside a workflow surfaces its question in the workflow result, and the
advisor loop answers it via a fresh dispatch (pointing at the branch's committed work) instead
of a continuation. When the Workflow tool is absent, the Agent-tool dispatch described in
Steps 2b/4 is the primary path — the two are interchangeable per wave.

## The serial train (`/sprint train`)

A **train** is the serial dual of a wave, for a chain of sprints that cannot parallelize —
each depends on the previous, or their `touches:` overlap, so `claims.mjs waves` degenerates
to one sprint per wave. Running such a chain as N solo lifecycles (or N one-member waves)
repeats the full ceremony per sprint: worktree + branch + deps install, a three-phase merge
queue, a CI-triggering push, a CI-green wait. A train collapses that: **one reservation for
the whole chain, one long-lived worktree/branch carrying all code, fresh executors dispatched
one at a time, and landings batched every K sprints** (default K=3) into one `--no-ff` merge,
one push, one CI run — N sprints cost ceil(N/K) CI runs instead of N.

Everything not stated in this section is inherited from the wave protocol verbatim: the
division of labor (master never reads code, diffs, or sprint bodies), Push policy and the
`[skip ci]` convention, worktree mode (`git -C`, never EnterWorktree), the advisor loop,
Executor children, the durable ledger, Roles and models (all subagents pinned
`model: sonnet` — dispatch by agent name only), multi-session rules, and Failure handling.

What is structurally different from a wave:

- **One branch, boundary SHAs.** Deliverable commits for every member accumulate on
  `train-W-<id>` (`S-NNN:`-prefixed). After each member's last commit, record its
  **boundary SHA** (`git -C <wt> rev-parse HEAD`) in the ledger — that is the per-sprint
  attribution, bisect grain, and rollback point; no per-sprint branches or tags.
- **Ledger-sync merges.** Each `start.sh --no-push` commit lands on `main`, not the branch —
  so after every start, run `git -C <wt> merge main -m "train: sync ledger after start
  S-NNN"`. Conflict-free by construction: between checkpoints `main` moves only via
  lifecycle/generated-doc commits the branch never edits (PROTOCOL invariant). This also
  keeps checkpoint `prepare` a near-no-op in single-session operation.
- **Board truth vs train truth.** `in-progress/` on `main` stays authoritative for claims:
  between checkpoints up to K members legitimately sit there (accurate — claims held, code
  unlanded). The `in-progress/ → done/` moves happen **only at the checkpoint land** — moving
  earlier would let another session's dependency check treat unlanded code as satisfied.
  Inside your own train, an earlier member with a recorded DONE boundary counts as a
  satisfied dependency for the next member; PROTOCOL Phase 1's "in flight by a parallel
  agent" warning does not apply to your own train's members.
- **The reservation is longer-lived.** The whole chain's `touches:` are held against other
  sessions for the train's full duration — inherent to serial work; expect to starve
  overlapping foreign work longer than a wave would.
- **Autonomy contract.** The confirmation at Step T1 authorizes the whole chain. Between
  sprints the master proceeds without asking; executor OPTIONS are run through the decision
  ladder (`docs/ENGINEERING_PRINCIPLES.md`) before any escalation, and auto-answers are
  recorded as `- YYYY-MM-DD (train, auto): [decision] — [rationale]` in Pre-Sprint Decisions
  plus one line in train-progress.md. The **only four hard stops**: (1) a second PLAN_GAP on
  the same sprint; (2) a red checkpoint CI not cured by one targeted fix; (3) a delta-refresh
  `NOT_READY`/`SPLIT_SUGGESTED` verdict; (4) an irreversible / architectural / security /
  spend tradeoff the ladder cannot rank.
- **Gate economics.** Default unchanged: full `gate.sh` before every deliverable commit.
  Opt-in `--fast-gate` (the user must ask for it): executors run only the cheap static
  subset per commit, with the full `gate.sh` mandatory at every sprint boundary (DONE
  requires it green) and at checkpoint `prepare` exit-3 re-runs. Tradeoff: mid-sprint
  commits may be broken — intra-sprint bisect degrades; boundaries stay green.

### Train protocol

**T1 — Compute + confirm the train.** `node scripts/sprint/claims.mjs waves`; take the
user's ordered chain S-A … S-N. Validate: every member's `depends_on` is in `done/` or
earlier in the chain; skip members `(in flight)` or reserved by a foreign wave; **warn** on
adjacent members that are dep-independent and touches-disjoint ("these would parallelize —
consider `/sprint wave`"); ask before exceeding ~10 members. Present per member: ID, goal,
points, plan status, open-question count — and the autonomy contract: "after the decision
round I run unattended; planned stops are checkpoints every K sprints and the four
hard-stop events."

**T2 — Reserve the whole chain.** `bash scripts/sprint/reserve-wave.sh S-A … S-N` — the
wave id doubles as the train id, and this is checkpoint P1 (the train's one origin-sync
push, `[skip ci]`, zero CI). Create `.claude/sprint-orchestration/W-<id>/` with
`train-progress.md` + `train-plan.md` (same roles as wave-progress/wave-plan; progress
lines are `S-NNN | started | DONE boundary=<sha> | report=… | landed@ckpt-n`).

**T3 — Plan the train upfront.** Wave Step 2 (2a–2f) verbatim over **all** members: one
planning worktree, parallel `sprint-planner` fan-out, constraints check, locked deepen
commit, **one batched decision round covering the entire chain** (the single biggest
autonomy lever), locked decisions commit. A CROSS_SPRINT "shared foundation" signal in a
serial chain usually means "make it the first car" — reorder rather than reshape.
`NOT_READY` / `SPLIT_SUGGESTED` members are dropped (`reserve-wave.sh --drop`) or the chain
re-cut **now** — never mid-train.

**T4 — Open the train.** `start.sh S-A --wave W-<id> --no-push` →
`git worktree add .claude/worktrees/train-W-<id> -b train-W-<id> main` (once; never
EnterWorktree) → setup (env files, one `{{PACKAGE_MANAGER}}` install). Record the base SHA
in train-progress.md.

**T5 — The sprint loop** (strictly serial, per member i):

1. **Start + sync** (i > 1): `start.sh S-i --wave W-<id> --no-push`, then the ledger-sync
   merge into the branch.
2. **Delta refresh (mechanical, master-only — no code reads).** `planStatus` is blind
   mid-train (dep `end_date`s flip only at checkpoints), so screen staleness yourself: read
   the predecessor's report's *deviations-from-brief* and Produces lines, and grep S-i's
   brief citations against the predecessor's `touches:`. Clean → dispatch. Dirty → one
   `sprint-planner` in **post-start mode against the worktree copy** (commits
   `S-i: revise plan — train delta` on the branch); auto-decide its new questions via the
   ladder where an option is recommended + reversible + small-blast-radius, else hard stop.
3. **Dispatch** one fresh `sprint-executor` (by name — pinned sonnet) with the standard
   execution prompt plus the **diff-base SHA** (the predecessor's boundary): its reviewer
   child diffs `<base>..HEAD`, not `main...HEAD`.
4. **Advise** BLOCKED / NEEDS_CLAIM via the advisor loop (SendMessage continuation;
   `claims.mjs add S-i <path> --no-push` under the lock — S-i is in `in-progress/`, so the
   precondition holds).
5. **On DONE:** evidence check from the report (citations only — never the diff); record the
   boundary SHA + status line in train-progress.md; pre-draft S-i's semantic docs into
   `W-<id>/S-i-docs-draft.md`.
6. **Checkpoint due** (i ≡ 0 mod K, last member, or any pause/abort)? → T6, then continue
   the loop.

**T6 — Checkpoint land** (one lock transaction, at a sprint boundary only):
`merge-sprint.sh prepare train-W-<id>` (exit 3 → full `gate.sh` in the worktree, lock held)
→ `merge-sprint.sh land train-W-<id> --sprints S-A,S-B,…` (one `--no-ff` merge; per-sprint
done-moves + status/end_date flips; one regen; exit 4) → apply the segment's pre-drafted
docs (seconds) → `merge-sprint.sh finish train-W-<id> --sprints S-A,S-B,… --no-push` →
`bash scripts/sprint/push-main.sh` — **the checkpoint's single CI-triggering push** — →
verify CI green once (PROTOCOL Phase 3 Step 6). Update train-progress.md (`landed@ckpt-n`).
**Red CI:** the segment's boundary SHAs narrow a first-parent bisect to one sprint in ≤2
steps; fix on `main` under the lock, `push-main.sh` again (never raw `git push`), re-verify.
Not cured by one targeted fix → hard stop; the batched land gives a clean escape hatch —
`git revert -m 1 <segment-merge-sha>` undoes the whole segment in one commit (surface to the
user first).

**T7 — Close the train.** After the final segment: one fresh `reviewer` over merged `main`
(hand it all report paths; small fixes on `main` under the lock ride the final push, larger
ones become follow-up sprints) → `reserve-wave.sh --release W-<id>` for never-started
members → final `push-main.sh` + CI verify →
`git worktree remove .claude/worktrees/train-W-<id> && git branch -d train-W-<id>` →
recompute `claims.mjs waves`, report the board, stop.

### Train failure handling (deltas from the wave table)

- **PLAN_GAP:** as in waves (learnings line, planner post-start repair on the branch,
  re-dispatch) — but a **second PLAN_GAP on the same sprint is a hard stop**, not another
  repair loop.
- **Mid-train abort (user or hard stop):** rescue any partial member
  (`git branch rescue/S-i <branch-tip>`), reset the train branch to the last recorded
  boundary, run an immediate T6 checkpoint over the DONE prefix (always landable —
  boundaries are gate-green), then `unstart.sh S-i` for the aborted member. Caution:
  `unstart.sh`'s deliverable-commit guard keys off an `S-NNN-*` branch name and cannot see
  the train branch — check for non-disposable partial work yourself before unstarting.
  Release leftovers (`--release`), final `push-main.sh`, keep the ledger dir for the
  post-mortem. Never leave local `main` ahead of `origin`.
- **Executor dies:** fresh dispatch pointed at
  `git -C <wt> log <boundary>..HEAD` — committed work persists on the branch.
- **Compaction:** train-progress.md + `git log` + `/sprint board`; never re-dispatch a
  member with a recorded boundary.
- **Foreign session lands mid-train:** surfaces at checkpoint `prepare` (exit 3 → full gate
  re-run under the lock) and at the delta refresh; use `--wait 900` on contention, never
  steal the lock silently.

---

## Planning dispatch prompt (sprint-planner subagent)

Adapt and send one per non-skipped member (fill the brackets; the agent definition at
`.claude/agents/sprint-planner.md` carries the full duties):

> You are the sprint-planner subagent for **S-NNN**. Follow your agent instructions
> (`.claude/agents/sprint-planner.md`).
>
> - Sprint file (edit ONLY this file, do not commit — it lives in the wave's planning
>   worktree): `<absolute path to backlog file inside .claude/worktrees/wave-W-<id>-plan>`
> - Repo root: `<absolute repo root>`
> - Wave roster: `S-AAA touches [...]; S-BBB touches [...]`
> - Landed since this sprint's plan_date: `S-CCC (<done-file path>), …` (or "none")
>
> Verify and deepen the sprint file against the CURRENT code, set `plan_date` if it reaches
> the readiness bar, and return the structured ≤20-line report from your instructions.

For a **post-start PLAN_GAP repair**, say so explicitly, point at the in-progress copy inside
the sprint's worktree, and remind it to commit on the sprint branch as
`S-NNN: revise plan — <reason>`.

## Execution dispatch prompt (sprint-executor subagent)

Adapt and send one per sprint — the agent definition at `.claude/agents/sprint-executor.md`
carries the full duties; the prompt carries only the per-sprint variables:

> You are the `sprint-executor` subagent for sprint **S-NNN** — follow your agent
> instructions (`.claude/agents/sprint-executor.md`).
>
> - Worktree (work ONLY here, via `git -C` / absolute paths): `<absolute worktree path>`
> - Repo root: `<absolute repo root>`
> - Wave ledger dir (your report goes here): `<repo-root>/.claude/sprint-orchestration/W-<id>/`
>
> Execute the sprint per your instructions and return the structured status (≤15 lines).

## Failure handling

- **A planning subagent dies mid-edit:** its roster file may be dirty — in the wave's
  planning worktree, not the ledger. Recovery is
  `git -C .claude/worktrees/wave-W-<id>-plan checkout -- docs/sprints/backlog/S-NNN-*.md`,
  then re-dispatch or `--drop` the member (wave-plan.md records which files were handed to
  planners). The primary checkout was never at risk.
- **A member is rejected at the decision round:** pre-start this is cheap — keep the
  committed deepening, `reserve-wave.sh --drop W-<id> S-NNN`, note it in wave-plan.md.
  Removing members preserves pairwise disjointness; only *adding* members forces a re-check.
- **An execution subagent returns BLOCKED / NEEDS_CLAIM:** the advisor loop — answer or
  claim, then **continue the same agent** (SendMessage). Re-dispatch a fresh `sprint-executor`
  only if the agent died (its committed work persists on the branch; tell the fresh agent to
  read `git -C <worktree> log` first).
- **PLAN_GAP:** the brief is wrong — fix the brief, don't abandon the sprint. Before
  re-dispatching, append one line to `docs/sprints/PLANNING_LEARNINGS.md` (create with a
  one-line header if absent): `- YYYY-MM-DD S-NNN PLAN_GAP: <gap class> — <root cause in
  one line>`; cap the file at the newest 20 entries. Then re-dispatch a
  `sprint-planner` in post-start mode against the **worktree copy** of the in-progress file
  (edits commit on the sprint branch); run `claims.mjs add` under the lock for any touches
  growth it reports (mirror in the branch copy); run a mini decision round if it raises
  questions; then re-dispatch execution. If the user instead decides to pull the sprint back
  entirely: `scripts/sprint/unstart.sh S-NNN --reason "…"` (refuses if the branch carries
  deliverable commits — then prefer `rejected/` or completion; clears the `wave:` reservation),
  then remove the worktree and branch it prints.
- **Reservation race (`reserve-wave.sh` exit 2):** another session reserved or started a
  member between your Step 1 and Step 1.5 — recompute the wave and re-confirm.
- **Start race (`start.sh` exit 2):** backlog file gone (another agent started it) or the
  sprint is reserved by another wave — drop it from your roster.
- **Lock busy (exit 75):** another session/wave holds it — follow the exit-75 protocol in
  "Running waves from multiple sessions". Never steal silently.
- **Orphaned worktree** (sprint in `in-progress/` with no worktree, or vice-versa): see
  `/sprint board`'s orphan check before re-dispatching.
- **Abandoning a wave:** release what you hold — `reserve-wave.sh --release W-<id>` for
  unstarted members; started members are individually `unstart`ed or completed. Then, always,
  `bash scripts/sprint/push-main.sh` before walking away (see Push policy) — a deferred wave
  must never leave local `main` silently ahead of `origin`. Leave the ledger dir for the
  post-mortem.
