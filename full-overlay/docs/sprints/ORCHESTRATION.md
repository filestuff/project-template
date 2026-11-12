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
stays lean — it never reads sprint bodies, diffs, or code into its own context (diff-dependent
duties — doc sync, `/adr check`, review — are always delegated to fresh subagents; the master
only adjudicates their structured returns); subagents return short structured summaries or
file paths.

| Owner | Does | Touches |
|-------|------|---------|
| **Orchestrator** (this session — the "master") | Compute + reserve the wave; run the planning pass (launch `plan-flow`, hold the decision round, write answers into sprint files, two locked commits); per sprint run start (dep check, claims check, `start.sh` under the lock, create the worktree); launch one `sprint-flow` run per sprint; act on what each run returns (grant claims, take parked decisions to the user, re-launch); **land** ready sprints in batches under the lock; admit newly unblocked sprints; adjudicate the post-wave review | `main` (lock-serialized), the ledger docs, the user |
| **Planning subagent** (`sprint-planner`, one per unplanned/stale sprint) | Verify + deepen ONE sprint file against current `main`: staleness, contract drift, deliverable detail, `touches:`, decision-ready questions; set `plan_date` | its assigned sprint file only (in the wave's planning worktree — the orchestrator commits) |
| **Brief auditor** (`brief-auditor`, one per planned sprint) | Cold-read ONE planned sprint file as its future executor: what it would have to ask or assume. Its verdict, not the planner's, is what lets `plan_date` stand | nothing — verdict only |
| **Arbiter** (`arbiter`, on demand) | Classify and decide what a planner or executor raised and may not decide itself, under `docs/DECISION_POLICY.md`: answers mechanical and taste decisions with a recorded rationale, returns reserved ones shaped for the user | nothing — decision only |
| **Wave-planning subagent** (`wave-planner`, conditional) | Cross-sprint constraint check when planner reports signal it (shared foundations, contract misalignment) | the wave's wave-plan.md only |
| **Execution subagent** (`sprint-executor`, one per sprint) | PROTOCOL **Phase 2 only** — verify the brief, implement deliverables test-first, gate, commit atomically, write the Completion Log — inside its assigned worktree; fixes review findings when handed them; returns BLOCKED for a decision it may not make and ESCALATE for work beyond it. It never reviews its own work | its worktree branch only + its report file |
| **Doc-sync subagent** (`doc-sync`, one per completing sprint) | Step 5 completion pass: resolve the diff base (`git -C <worktree> merge-base HEAD main`), run PROTOCOL Phase 3's doc-sync pass and `/adr check` over the diff | nothing — docs/ADR signal only |
| **Reviewer subagent** (`reviewer`) | Per-sprint branch review — dispatched by the orchestration layer, never by the author: one pass, or three focused lenses for a `risk: high` sprint — and the post-wave broad review over merged `main` | nothing — findings list only |
| **Finding verifier** (`finding-verifier`) | Tries to refute one Critical/Important review finding before anyone acts on it; re-checks a "fixed" finding against the new HEAD | nothing — verdict only |

Every subagent role — including `doc-sync` — has an agent definition under `.claude/agents/`
that pins its `model` and `effort` — **never dispatch a definition-less generic subagent in
a wave**: it would silently inherit the master's (expensive) model. The one sanctioned
spawn-time `model` override is the executor's, and only with the value
`scripts/sprint/routing.json` gives for that sprint (see Roles and models).

**What is enforced, not just asked.** `scripts/hooks/guard.mjs` (wired in
`.claude/settings.json`) runs before every Bash and file-edit call of every agent: an edit
inside a sprint worktree outside that sprint's `touches:` is refused (the agent is told to
return NEEDS_CLAIM); a subagent running a lifecycle script, pushing, or committing with
`--no-verify` is refused; a force-push or deletion of the main branch is refused for
everyone; and under the workflow variant an executor's DONE is refused while its
Completion Log fails `close-check.mjs`. These are early feedback — a shell redirect can
still write a file no hook sees — so the binding check is `merge-sprint.sh land`'s
claims check (Step 5, exit 6). Decisions are governed by `docs/DECISION_POLICY.md`.

The orchestrator's primary checkout stays parked on `main` (it is the lifecycle ledger). It
**never** enters a worktree — it creates them with `git worktree add` and hands the path to a
subagent.

## Push policy

A 5-sprint wave running the solo lifecycle scripts unmodified would push to `origin` on every
transaction — reserve, deepen, decisions, N starts, N finishes — roughly 13 pushes, each firing
downstream CI. Waves instead **defer** pushes and settle them at three checkpoints: **during a
wave, every main-mutating script gets `--no-push`; only `scripts/sprint/push-main.sh` pushes.**

`merge-sprint.sh finish` never pushes, in any mode (`--no-push` is accepted there as a no-op).
Local `main` is shared by every session in the checkout, so a push from `finish` could carry
another session's held completions past their deploy gate. The only code-bearing pusher is
`push-main.sh --expect <your sprint ids>`: it refuses (exit 2) a range carrying another
sprint's non-doc commits. The ledger scripts push only through `ledger-push.sh` (below).

- **P1 (wave start).** `reserve-wave.sh` is the sole exception to the no-push rule above — it
  keeps its push as the wave's origin-sync point, backing up the roster. Its commit carries
  `[skip ci]`, so it costs zero CI. The push goes through `ledger-push.sh` and is **ledger-only
  or nothing**: if local `main` already carries unpushed commits touching paths outside
  `docs/`/`.claude/` — typically another session's completions awaiting their own deploy
  gate — it pushes nothing, keeps the reservation commit local (already visible to every
  session sharing this checkout), prints the code-bearing commits and the
  `push-main.sh --expect <their ids>` command their owner settles with, and exits **3**.
  Exit 3 is not a failure of the reservation: read the printed `wave id:`/`pre_wave_sha:` and
  proceed; the reservation rides out with the owner's (or your P3) push.
- **P2 (after the last `start.sh --no-push`).** Run `push-main.sh --expect <the wave's sprint
  ids>` — a ledger-only backup push, zero CI (HEAD is a `[skip ci]` start commit). `--expect`
  makes it refuse rather than carry another session's code out with your bookkeeping.
- **P3 (wave end, mandatory).** After the last `merge-sprint.sh finish <branch>` and any
  `reserve-wave.sh --release`, ask the deploy-gate question (below), then run
  `push-main.sh --expect <the wave's sprint ids>` — the single CI-triggering push of the wave. PROTOCOL Phase 3 Step 6's
  "verify CI green" check runs exactly once here, against this push, covering every sprint
  in the wave.

**Deploy confirmation gate.** A code-bearing push to `main` is a production deploy on any
platform that auto-deploys the default branch (Railway, Vercel, Netlify, Render…). Never
run a code-bearing `push-main.sh` silently — ask first (AskUserQuestion):

- **Push now (deploy)** — run `push-main.sh --expect <ids>`, then verify CI green
  (`verify-ci.sh`, PROTOCOL Phase 3 Step 6). *(recommended)*
- **Hold** — keep commits local; the board's unpushed-ledger check surfaces the held state,
  and the catch-up path is `push-main.sh --expect <ids>` (CI verification rides with the
  eventual push).

The gate applies to code-bearing pushes only: solo `finish`, wave P3, and train checkpoints
(per the T1 policy, below). Ledger-only `[skip ci]` pushes (P1/P2, start, reserve, unstart,
claim) stay automatic — gating bookkeeping would make the workflow unusable — but automatic
is not unconditional: the four ledger scripts push only through `ledger-push.sh`, which
refuses any range that is not ledger-only, so bookkeeping can never carry code past its gate.
Two platform caveats
to note in project docs: commit-marker handling is platform-dependent (Railway honors
`[skip ci]`; Vercel needs its own Ignored Build Step), so configure the platform to ignore
`docs/` + `.claude/` watch paths if ledger-only pushes trigger redeploys; and `push-main.sh`
deliberately *forces* CI on code-bearing ranges whose HEAD carries a skip marker.

**The `[skip ci]` convention:** ledger-only lifecycle commits (start, unstart, claim expansions,
deepen, decisions, reservations, drops, releases) carry a trailing ` [skip ci]`, stamped by the
scripts themselves. The marker is safe only because `ledger-push.sh` never lets such a HEAD ride
out over code. The `sprint: complete` commit written by
`merge-sprint.sh finish` deliberately does **not** — it is the HEAD of a code-bearing push, and a
skip marker there would skip CI for landed code.

**`push-main.sh [--wait <secs>] [--expect <csv>] [--allow-foreign] [--self-test]` contract:**
acquires the sprint-main lock (label `push-main`); fetches `origin` and refuses with a hard error
if the remote has diverged (it never auto-rebases the ledger); exits 0 ("nothing to push") when
local `main` already matches `origin`. Then it **classifies the about-to-be-pushed range before
pushing**: commits are grouped by the sprint id in their subject (`S-NNN: …`,
`<type>(S-NNN): …` / `<type>(S-NNN)!: …`, `sprint: <verb> S-NNN …`; anything else is
`(unattributed)`) and each group is printed as doc-only (`docs/`, `.claude/`) or code. With
`--expect <csv>` (the sprint ids the caller owns), any code group not in the list is FOREIGN and
the script **refuses (exit 2)** — nothing pushed, no commit added — printing the
`--allow-foreign` re-run command; use it only after the user confirms the foreign code may ship.
Without `--expect` it classifies and pushes (no refusal) — always pass it from the workflow.
Next it guards a `[skip ci]` HEAD: if the HEAD commit carries a skip marker but the range touches
paths outside `docs/` and `.claude/`, it adds an empty, unmarked
`ci: run checks for wave push (<range>)` commit **on `main`** (built with `commit-tree` +
`update-ref`, so it never lands on whatever branch happens to be checked out) so code pushes
still trigger CI. Then it pushes and, for a code-bearing push, prints the exact CI check to run:
`scripts/sprint/verify-ci.sh <new sha> --base <old origin sha>` (PROTOCOL Phase 3 Step 6).
`--self-test` runs scratch-repo cases and never touches the real lock, `origin`, or `git push`.

**`ledger-push.sh <root> <branch> [--self-test]` contract:** the one push path for
`start.sh`, `unstart.sh`, `reserve-wave.sh` and `claims.mjs add` (each skips it under
`--no-push`). Called while the caller already holds the sprint-main lock — it never touches
`lock.sh`. Fetches `origin`; exits 0 when there is nothing to push (a missing remote branch is
fine — first push); exits 1 on an unreachable origin, a diverged remote or a failed push; and
otherwise inspects **every commit** in `origin/<branch>..<branch>` (merges diffed against their
first parent, so a land merge's code counts): all paths under `docs/`/`.claude/` → push;
anything else → push nothing, list the code-bearing commits, print
`push-main.sh --expect <the sprint ids found in their subjects>`, exit **3**. Each caller still
prints its normal summary on 3 and then exits 3 ("committed locally, push withheld") — distinct
from 2 ("rolled back, nothing committed"). History is linear, so the caller's own ledger commit
cannot be pushed alone; refusing is the only safe option. `--self-test` runs scratch-repo cases
against a bare origin plus a read-only sentinel that fails if any script in `scripts/sprint/`
other than `push-main.sh` and `ledger-push.sh` contains a raw `push origin`.

On a long-running (multi-hour) wave, the orchestrator **may** run `push-main.sh` after any
individual sprint's finish for backup, at the cost of one CI cycle per extra push — a deliberate
tradeoff, not a violation of the checkpoint schedule.

**Abandoning or pausing a wave:** always **settle** the push before walking away — run
`bash scripts/sprint/push-main.sh --expect <your sprint ids>` (asking the deploy-gate question
if the range carries code; exit 2 means another session's code is on local `main` — that is its
owner's to settle, not yours), or record an explicit user *hold* decision. A user-confirmed hold is a deliberate,
board-visible state; what must never happen is local `main` left silently ahead of `origin`
with nobody having decided that. Applies equally to abandonment (Failure handling) and to
any pause longer than a session (e.g. a decision round parked overnight).

Solo (non-wave) `/sprint start` keeps its push-per-transaction (ledger-only, `[skip ci]`).
Solo `/sprint done` runs `finish` (which never pushes) and settles its code-bearing push
through the same deploy gate: ask, then `push-main.sh --expect S-NNN`.

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
2. Present the set to the user and confirm — per member: ID, goal, points, `risk`/`tier`,
   plan status (`plan_date` or unplanned/stale), and open-question count. A wave of 2–4 is
   typical; more than that, ask whether to cap it. In the same confirmation settle the two
   things that would otherwise interrupt the wave later (AskUserQuestion):
   - **Autonomy** (`docs/DECISION_POLICY.md`): **gated** *(recommended, the default)* —
     mechanical and taste decisions are made and recorded, taste ones are listed for you at
     the decision round and the wave close, reserved ones are always asked; or
     **interactive** — taste decisions are asked too.
   - **Push policy** for the wave's code-bearing push (P3): **ask at wave end**
     *(recommended when a platform auto-deploys main)*, **auto-push**, or **hold**.

### Step 1.5 — Reserve the wave

`bash scripts/sprint/reserve-wave.sh S-A S-B …` — a locked `main` commit that mints the wave
id (`W-<date>-<hex>`, printed) and writes `wave: W-<id>` into each member's frontmatter.
From this commit on, `claims.mjs` treats the members as claim holders: another session's wave
can neither reserve them nor reserve/start anything whose `touches:` overlap theirs. This is
**checkpoint P1** (see Push policy): the script pushes as usual, and its commit carries
`[skip ci]`.

- Exit 2 (member gone / already reserved / claims overlap): another session moved first —
  recompute Step 1 and re-confirm a smaller or different roster.
- Record the wave id and the printed `pre_wave_sha` (also committed as a trailer on this
  reservation commit — Step 6 needs it as the post-wave review's diff base), then create the
  wave's ledger dir (see Durable progress ledger): `.claude/sprint-orchestration/W-<id>/`.
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

**2b — Planning pass (one workflow run, in a planning worktree).** First create the wave's
planning worktree:
`git worktree add .claude/worktrees/wave-W-<id>-plan -b wave-W-<id>-plan main`.
Then launch the **`plan-flow`** workflow over the non-skipped members:

```
Workflow({ name: "plan-flow", args: {
  waveId: "W-<id>", repoRoot: "<abs repo root>", autonomy: "<gated | interactive>",
  rosterSummary: "S-AAA touches [...]; S-BBB touches [...]",
  members: [{ sprint: "S-NNN", file: "<abs backlog-file path INSIDE the planning worktree>",
              landedSince: "S-CCC (docs/sprints/done/…), …" }],     // or "none"
  routing: <the parsed contents of scripts/sprint/routing.json>
} })
```

Each member flows on its own through three stages — no member waits for another:

1. **Plan** — a `sprint-planner` verifies and deepens the member's file against current
   code, and **assigns its `tier:`** — how hard the work is, which decides the model and
   effort that will execute and review it (`docs/sprints/tier-rubric.md`). The planner has
   just read the code; `/plan`'s tier was provisional. Each verdict carries `tier` and
   `tier_reason`. Planners edit their (pairwise-distinct) files in the worktree; the primary
   checkout — the ledger — **stays clean throughout**, so other waves' locked
   transactions are never blocked by this pass.
2. **Audit** — a `brief-auditor` cold-reads the file as its future executor, and checks
   independently any claim that the sprint is `routine` (the cheapest setting — a downgrade
   that does not hold is a blocking item). A planner
   cannot certify the brief it wrote: its `plan_date` is provisional until a fresh reader
   agrees. `INSUFFICIENT` → one planner repair round with the auditor's blocking list →
   one re-audit.
3. **Decide** (gated runs) — each open question goes to the `arbiter`, which classifies
   it under `docs/DECISION_POLICY.md`.

The run returns `verdicts` (each with its `audit`), `missing` (planners that died —
re-launch for those members, or `--drop` them), `uncertified`, `decided` and `ask`.
For every **`uncertified`** member — still insufficient after the repair round — run
`node scripts/sprint/frontmatter.mjs set <planning-worktree file> plan_date null` and
surface it in the decision round (2e) as defer / proceed-anyway, exactly like a
`NOT_READY` verdict. Record each verdict and audit in wave-plan.md.

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

**2e — Decision round (no lock held).** `plan-flow` has already classified the planners'
questions (`docs/DECISION_POLICY.md`):

- **`decided`** — the arbiter's mechanical and taste rulings, each with its record line.
  They go into 2f as written. Nothing to ask.
- **`ask`** — reserved questions (with the arbiter's stake, options and recommendation),
  plus any question the arbiter did not rule on. Batch them into AskUserQuestion calls
  (≤4 questions each), labeled `S-NNN D-A: …`.

Then show the gate brief once: the **taste** rulings from `decided`, numbered, one line
each (decision — principle — rejected option). The user accepts them with a word or
overturns any by number; an overturned one is re-recorded as `reserved, user`. Mechanical
rulings are not listed — they are in the record. In an **interactive** wave `decided` is
empty and every question is in `ask`.
More than ~8 total questions is a planning smell — the per-planner cap is 2–3; push back
rather than relay a quiz. `NOT_READY` / `SPLIT_SUGGESTED` verdicts and uncertified members
are always the user's — defer / split / proceed-anyway — never silently drop a member
(and `--drop` whatever the user defers).

**2f — Apply decisions + locked commit #2.** Entirely under the lock (the orchestrator's
own edits take seconds — the ledger must not sit dirty outside it):
`lock.sh acquire wave-decisions-W-<id>` → append each answer to the sprint file's
**Pre-Sprint Decisions** section in the policy's record grammar —
`- YYYY-MM-DD (wave, <class>, <arbiter|user>): [decision] — principle: … — rejected: … — undo: …`
(the arbiter's RECORD line verbatim; for a user answer, `(wave, reserved, user)`) — check
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
   (from the post-start main tip; **no EnterWorktree**) →
   `bash scripts/sprint/worktree-link.sh setup <worktree>` (env files; links in link mode) →
   in install mode only, install deps with `{{PACKAGE_MANAGER}}` (PROTOCOL "Worktree
   toolchain").

These run one-at-a-time: `start.sh` serializes on the lock anyway (each start is a fast
commit, so brief contention). PROTOCOL Phase 1's doc validation and tradeoff questions are
already covered by Step 2 (doc drift recorded in each file's PLAN NOTES; decisions in
Pre-Sprint Decisions).

After the **last** member's start: **checkpoint P2** —
`bash scripts/sprint/push-main.sh --expect <the wave's sprint ids>` (ledger-only; the HEAD
commit carries `[skip ci]`, so this triggers no CI; exit 2 means another session's code sits on
local `main` — leave it for its owner and continue, the ledger rides your P3).

### Step 4 — Launch one `sprint-flow` run per sprint

Launch **one `sprint-flow` workflow run per started sprint, all in a single message**.
Each run is independent and notifies you separately when it ends — a sprint that finishes
early is yours to land (Step 5) while its neighbours are still executing. Do not wait for
the slowest sprint.

```
Workflow({ name: "sprint-flow", args: {
  waveId: "W-<id>", repoRoot: "<abs repo root>",
  ledgerDir: "<abs repo root>/.claude/sprint-orchestration/W-<id>/",
  mode: "wave", autonomy: "<gated | interactive>",
  sprint: { id: "S-NNN", worktree: "<abs worktree path>",
            risk: "<low | high>",                                     // from the sprint's frontmatter
            tier: "<routine | standard | complex | critical>" },      // from the sprint's frontmatter
  routing: <the parsed contents of scripts/sprint/routing.json>
} })
```

`tier` picks the rung of `routing.json` the sprint starts on — model **and** effort for
its executor and for its reviewers. A missing or unknown tier runs as `standard`.

**File-based handoff:** the run is given the sprint id and worktree — the sprint file *is*
the brief; never paste a sprint's contents into `args`.

Inside a run (the script is `.claude/workflows/sprint-flow.js`; you do none of this by
hand):

1. **Execute** — a `sprint-executor` on the model and effort routing.json gives the
   sprint's `tier:`.
   A **BLOCKED** executor is answered by the `arbiter` and a fresh executor continues from
   the branch; an **ESCALATE** moves the sprint to the next tier in `routing.escalation`;
   a dead executor is re-dispatched once.
2. **Review** — independent of the author by construction: one `reviewer` over the branch
   diff, or three focused lenses (correctness, security and data, tests) when the sprint
   is `risk: high`. Reviewers run on the reviewer setting of the tier the sprint
   **finished** on — never weaker than the executor that did the work; the one exception
   is the tests lens, which runs on routing.json's `reviewer_lens.tests` on every tier
   below `critical`. The executor
   neither spawns nor briefs them.
3. **Verify** — each Critical/Important finding goes to a `finding-verifier` told to
   refute it; refuted findings are dropped and recorded as such.
4. **Fix** — the executor fixes what survived, re-gates and commits; verifiers re-check
   each fix against the new HEAD. At most two rounds. A finding the executor disputes goes
   to the arbiter.

### What a run returns

Every run ends with a `status`, the executor's `commits` / `gate` / `close_check` lines,
the `review` summary, a `review_record` (the lines for the sprint's `### Review` section —
you paste them at land, Step 5), the arbiter `decisions` made along the way, any
`escalations`, the `tier` it finished on, and an `outcome` line (assigned and final tier,
runs, escalations, arbiter calls, fix rounds, findings — you write it into the done-file
at land; `tiers.mjs` calibrates the rubric on it). Act on the status; record one line per sprint in wave-progress.md.

| Status | Meaning | You |
|---|---|---|
| `READY_TO_LAND` | executed, reviewed, findings fixed or refuted | land it — Step 5 |
| `PARKED` | a decision that is the user's (`question.class: reserved`), an unresolved review finding, a review that did not complete, or an escalation past the top of the ladder | put `question` to the user (AskUserQuestion, with its stake and options), then re-launch the sprint's run with `resume: "<the answer>"` |
| `NEEDS_CLAIM` | the sprint needs a file outside its `touches:` | `claims.mjs add S-NNN <path> --no-push` under the lock, then re-launch with `resume: "claim granted for <path> — mirror the touches: addition in your branch copy and proceed"`. Exit 2 from `claims.mjs add` = another sprint holds it: a real conflict — re-launch with `resume` telling the executor to do without the file, or sequence the sprints (re-cutting a seam is the user's call) |
| `PLAN_GAP` | the brief is wrong | Failure handling → PLAN_GAP, then re-launch |
| `DIED` | the executor died twice | read `git -C <worktree> log`; re-launch once, or surface it |

A re-launched run reads the branch first — committed work persists there — and continues.
Besides `resume`, pass it where the sprint stands on the ladder so an escalation is not
lost and the outcome stays true: `sprint.tier` = the `tier` the previous run **returned**,
`sprint.assignedTier` = the tier in the sprint's frontmatter, and `sprint.attempt` = the
run count (2 for the first re-launch). Confirm each `decisions` entry is in the
sprint file's Pre-Sprint Decisions (the executor was told to record it verbatim); collect
the taste ones for the list you show the user at the wave close (Step 6).

**Never auto-answer a `PARKED` question whose class is `reserved`,** in any autonomy mode,
and never land a `PARKED` sprint over its open findings without the user saying so —
landing unreviewed or over an open Critical is weakening a check
(`docs/DECISION_POLICY.md`).

### Without the Workflow tool (fallback)

When the Workflow tool is not available, do by hand what the runs do — the roles, the
order and the rules are identical; only the dispatcher changes:

- **Plan** (2b): dispatch one `sprint-planner` per member in a single message (Planning
  dispatch prompt, below); then one `brief-auditor` per `READY` / `READY_WITH_QUESTIONS`
  member in a single message (prompt: the sprint file path in the planning worktree and
  the repo root, nothing else); `INSUFFICIENT` → continue that planner via SendMessage
  with the blocking list, then one fresh auditor. In a gated wave, dispatch one `arbiter`
  per open question in a single message.
- **Execute** (4): dispatch one `sprint-executor` per sprint in a single message
  (Execution dispatch prompt, below), passing as spawn-time `model` what routing.json's
  `executor.<tier>` gives for any sprint that is not `standard` (the Agent tool takes a
  model, not an effort — the definition's effort applies; that is one reason the workflow
  path is the primary one). On **BLOCKED**: answer from the record if it is already decided, otherwise
  dispatch the `arbiter`; deliver the answer by **continuing the same executor
  (SendMessage)** — its context is the most valuable thing it has. On **ESCALATE**:
  dispatch a fresh `sprint-executor` on the next routing tier with the handover block.
- **Review**: when an executor returns DONE, dispatch the `reviewer`(s) yourself —
  worktree path, the diff to review, the sprint file path, **nothing of the executor's
  reasoning**; three lenses for `risk: high`. Dispatch a `finding-verifier` per
  Critical/Important finding. Send the surviving findings to the executor (SendMessage)
  as a fix round; re-check each fix with a `finding-verifier`. Two rounds at most, then
  it is the user's.
- Dispatch reviewers with the model routing.json's `reviewer.<tier>` gives for the tier
  the sprint finished on — except the tests lens of a three-lens review, which takes
  `reviewer_lens.tests`' model unless the tier is in its `except` list.
- Compose the sprint's `outcome` line yourself, in the same grammar the runs use:
  `assigned=<tier> final=<tier> runs=<n> escalations=<n> arbiter=<n> fix_rounds=<n>
  findings=<confirmed>/<raised>`.
- Compose the `review_record` lines yourself, one per finding:
  `- <severity> (<lens>) <file:line> — <description> — fixed <sha> | refuted on
  verification: <why> | declined: <why>`, or `— no material issues found (…)`.

Executors cannot be relied on to spawn children in either path — agents started by a
workflow never can, and environments that cap subagent nesting
(`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1`, the default in cloud sessions) remove the
ability from hand-dispatched ones too. That is why review, advice and escalation are the
orchestration layer's job and never the executor's.

### Step 5 — Land what is ready (orchestrator; batched, while others still run)

**Do NOT fan out landings.** `merge-sprint.sh` holds the main-lock across
`prepare → land → finish`, *including the exit-4 pause where you apply the semantic docs* —
so racing completions make all but one hit the lock ceiling (exit 75). But do not land
sprints one by one either: every sprint that is `READY_TO_LAND` when you turn to landing
goes in **one batch** — one merge, one gate run, one lock transaction — and you do not
wait for the sprints still executing. Land again when more are ready.

For the batch (up to 6 sprints; one ready sprint is simply a batch of one):

1. **Check each record** (no lock):
   `node scripts/sprint/close-check.mjs --json <worktree>/docs/sprints/in-progress/S-NNN-*.md`
   and adjudicate the JSON — `ok`, `failures[]`, `counts` (evidenced/total per class),
   `deviations[]`, `learnings[]` — never the sprint body or the diff. `ok:false` →
   re-launch that sprint's run with `resume: "<the failure list>"` and leave it out of
   this batch; never fill the record yourself. (`review[]` reads `— pending: independent
   review before land` here — the review lives in the run's `review_record`, step 5.)
2. **Doc-sync** (no lock): dispatch one short-lived **`doc-sync`** subagent per sprint in
   the batch, in a single message, each with its sprint's worktree path: it resolves its
   own diff base (`git -C <worktree> merge-base HEAD main`), runs the PROTOCOL Phase 3
   doc-sync pass and `/adr check` over `git diff <base>..HEAD`, spot-checks two Evidence
   citations, and returns ≤12 lines (docs drafted yes/no, ADR needed yes/no + why,
   `evidence: ok | gap: <criterion>`, and the verbatim annotations for the `Docs synced` /
   `New docs registered` / `ADR check` checklist rows). You adjudicate the returns — you
   still never read a diff.
3. **Pre-draft the semantic docs** (no lock; mandatory when another wave is live): per
   sprint, the DOC_HEALTH rows/History entry, INDEX Done-row and ROADMAP narrative into
   `.claude/sprint-orchestration/W-<id>/S-NNN-docs-draft.md`. The exit-4 pause then becomes
   "apply the drafts" — seconds of lock-held time, not minutes.
4. **Assemble and gate — once** (no lock):
   `bash scripts/sprint/assemble-train.sh W-<id> S-A S-B …` merges the batch's branches
   into one integration branch `land-W-<id>-<n>` in its own worktree and prints `branch:`,
   `worktree:`, `merged:` and, for any member whose merge conflicted, `conflict: S-NNN
   (<paths>)` — that member is left out (the batch is not sunk): land it alone afterwards,
   or re-launch its run with the conflict as `resume`. Then
   `bash scripts/sprint/worktree-link.sh setup <integration worktree>` (links or installs its
   dependencies per `worktree-links.json`; PROTOCOL "Worktree toolchain contract") and run
   `scripts/sprint/gate.sh` **in the integration worktree** — one gate run for the whole
   batch, with no lock held.
   - **Green** → step 5.
   - **Red** → the members each passed alone, so this is an interaction between them:
     `assemble-train.sh --cleanup <branch> --force`, split the roster in half, assemble
     and gate each half. A half that is green lands; a single member that is red on
     current `main` goes back to its run with the gate's failure output as `resume`.
5. **Land the batch** (one lock transaction):
   `merge-sprint.sh prepare <land-branch>` (add `--wait 900` when another wave is live;
   exit 3 = `main` moved since you assembled — re-run the gate in the integration worktree,
   lock held) → `merge-sprint.sh land <land-branch> --sprints S-A,S-B,…` (it lints every
   member's record and exits 5 on an incomplete one; it checks claims and exits 6 — see
   below; `main` is untouched in both cases) → at the exit-4 pause, for each member: apply
   its docs draft; finalize the done-file's `Docs synced` / `New docs` / `ADR check` rows
   from its doc-sync return (an ADR the doc-sync agent says is needed is drafted now via
   `/adr` — mechanical, not a question); **replace the `### Review` section's `— pending:
   independent review before land` line with that sprint's `review_record` lines,
   verbatim**; record how the run went —
   `node scripts/sprint/frontmatter.mjs set docs/sprints/done/S-NNN-….md outcome "<the
   run's outcome line>"` (the last run's, for a sprint that was re-launched); prepend any `plan`-class `learnings[]` line to
   `docs/sprints/PLANNING_LEARNINGS.md` → `merge-sprint.sh finish <land-branch> --sprints
   S-A,S-B,… --no-push`. Phase 3 Step 6's CI check does **not** run here — `finish`
   deferred its push; it runs once at checkpoint P3 (Step 6).
6. **Clean up**: `bash scripts/sprint/worktree-link.sh teardown <worktree>` first, for
   every worktree you remove (it must pass — in link mode, removing a worktree whose links
   are still in place can wipe the primary checkout's installs). Then
   `bash scripts/sprint/assemble-train.sh --cleanup <land-branch>`, and remove each landed
   member's worktree and branch
   (`git worktree remove .claude/worktrees/S-NNN-… && git branch -d S-NNN-…`). Mark the
   members `landed` in wave-progress.md.
7. **Admit what is now unblocked** — Step 5.5 — before you go back to waiting.

A batch whose `prepare` brings in changes (exit 3) re-runs the gate in the integration
worktree before `land`, lock held — that serialization is the point. In single-session
operation `main` moves only by ledger commits between your assemble and your `prepare`, so
exit 3 is rare and the batch's one gate run is the one you already did.

**`land` exit 6 — the branch changed files outside its claims** (lock kept, `main`
untouched; the paths are listed). Those files were never checked against the other
in-flight sprints, which is the one thing claims exist to guarantee. Do not reach for the
override: `merge-sprint.sh abort <land-branch>` (releases the lock) →
`claims.mjs add S-NNN <path…> --no-push` for the member that changed them → `prepare` →
`land` again. If `claims.mjs add`
exits 2, another sprint holds the path — a real conflict: have the executor undo that
change, or land the two sprints in sequence. `--allow-outside-claims "<reason>"` (written
into the done-file's Deviations) is for paths no sprint could contend for, and it is a
**reserved** decision — ask the user. A `GATE-SENSITIVE:` list in `land`'s output (the
commit gate, CI config, or deleted tests changed) is also reserved: confirm with the user
before `finish`, or `abort`.

### Step 5.5 — Rolling admission (after every landing batch)

A landing unblocks sprints: dependents of what just landed, and sprints whose claims
overlapped it. Do not wait for the wave to drain before starting them.

1. `node scripts/sprint/claims.mjs ready --wave W-<id> --json` — the backlog sprints that
   can start **right now**: every dependency landed, claims disjoint from everything in
   flight and from other waves' reservations, and pairwise disjoint among themselves. Its
   `blocked` list says why each of the others cannot (`depends on S-x (in-progress)`,
   `claims overlap S-y (in flight)`, `no claims`, …).
2. Nothing ready → go back to waiting for runs. Otherwise the new members join **this**
   wave — same id, same ledger, same review base:
   `bash scripts/sprint/reserve-wave.sh --add W-<id> S-X S-Y --no-push` (exit 2 = a claim
   race or an unknown wave — recompute). A wave the user capped at N keeps at most N
   sprints in flight: admit only as many as have landed.
3. Plan them — Step 2, over the new members only (2a's skip check first: members certified
   just-in-time skip straight to 2e) — then Step 3 (start + worktree) and Step 4 (one
   `sprint-flow` run each). Admission never changes the autonomy mode or the push policy
   the user chose at Step 1; tell them in one line what joined ("admitted S-X, S-Y —
   unblocked by S-A").

**Lookahead planning.** While runs are executing and you have nothing to land, you may run
Step 2 early for sprints that will become ready when in-flight work lands (the `blocked`
entries whose only reason is a dependency or overlap with a sprint of this wave) — in the
planning worktree, uncommitted. Their plans are provisional: Step 3.1's staleness
re-check runs when they are actually admitted, and a member whose dependency landed
differently than planned goes through `plan-flow` again.

### Step 6 — Review, then close the wave

The wave is over when no run is executing, nothing is `READY_TO_LAND` or parked, and
`claims.mjs ready --wave W-<id>` admits nothing more (or the user stops it). After its
sprints have all landed on `main`, dispatch one **`reviewer`** subagent
(fresh context) over the merged wave result on `main` — a fresh reviewer catches cross-sprint
integration issues per-sprint review can't. Hand it the landed `docs/sprints/done/S-NNN-*.md`
paths as a starting map (their Completion Logs carry the evidence, review dispositions and
deviations; the ledger reports are pointers). Hand it the diff base explicitly, too: `pre_wave_sha`, recorded at Step 1.5 from
`reserve-wave.sh`'s output and committed as a trailer on the wave's reservation commit — the
reviewer runs `git diff <pre_wave_sha>...HEAD` on `main`. Without an explicit base the
"merged result on main" is an empty diff and the review silently approves nothing. The same
rule applies to train checkpoint reviews (base = `pre_wave_sha` from the train's T2
reservation — see "Close the train" below).

The master does **not** perform this review itself: it adjudicates the returned findings
list — fix now (small), spin a follow-up sprint, or accept — and records the disposition in
wave-plan.md.

**Outside voice (conditional — at most one extra agent per wave, never per sprint).**
Dispatch a *second* fresh `reviewer` only if (a) the wave's merged diff touches the
risk-tier table in `docs/sprints/review-calibration.md`, or (b) the first post-wave review
returned any Critical. Same diff base and report paths, plus this framing: "A prior review
of this diff exists. You have NOT seen it — do not ask for it. Your job is to find what it
missed: logical gaps, unstated assumptions, a fundamentally simpler approach, missing
sequencing." Never hand it the first reviewer's findings. Where the two reviews disagree,
present the disagreement to the user as a neutral tension — both positions, batched with
the other findings — and never auto-incorporate either side; adjudicate dispositions in
wave-plan.md exactly as for the first review.

**Proposal stage check (master, once per wave).** Grep the landed sprints' frontmatter
`proposal:` fields / Context `Source: docs/proposals/NNN-…` lines for proposal citations.
For each cited stage with no remaining open sprints (`backlog/` + `in-progress/` on
`main`), mark the stage `delivered YYYY-MM-DD` in the proposal file (commit on `main`
under the lock, `[skip ci]`; un-staged proposals: flip `**Status**:` to `delivered
YYYY-MM-DD`). For a non-final stage, report: the stage's gate is now due — offer
`/proposal NNN`. For the FINAL stage (no gate by design), also flip `**Status**:` to
`delivered YYYY-MM-DD` in the same commit and say so. Never fold a gate decision
into the wave close; it needs the proposal's evidence spec, not the wave report.
(Executors skip PROTOCOL Step 3.6 — this master-side check replaces it, so simultaneous
finishers can't each see a sibling in-progress and silently drop the gate offer.)

Then close out the wave: `reserve-wave.sh --release W-<id>` if any backlog members still
carry the reservation (deferred/split members). Run `node scripts/sprint/tiers.mjs` and
relay any flag it raises — a tier whose sprints keep escalating (`UNDER`) or finishing
uncleanly (`STRAINED`) means the rubric or the routing table needs adjusting, and that is
the user's call to make on evidence, not yours to make silently. Show the user the wave's
decisions made on their behalf — `node scripts/sprint/decisions.mjs --class taste --since <wave start>` —
and take any they overturn as follow-up work.

**Wave-end checks on merged `main` (before P3).** Each sprint's gate ran inside its own
worktree, which is blind to two things: repo-wide guard/sentinel tests that scan the whole
tree (a sibling's new file is invisible from your worktree), and integration between sprints.
Run the project's repo-wide guard tests from the primary checkout on the merged `main`, and —
if any member touched the end-to-end suite or the paths it drives — run that suite once there
too, recording pass / fail / skip counts (PROTOCOL Step 3.8). A red here is fixed on `main`
under the lock before P3.

Then **checkpoint P3 (mandatory)**: follow
the push policy chosen at Step 1 — "ask at wave end" → the deploy-gate question (Push
policy above); "auto-push" → proceed; "hold" → skip the push and say so — then run
`bash scripts/sprint/push-main.sh --expect <the wave's sprint ids>` — the single
CI-triggering push of the wave — and run PROTOCOL Phase 3 Step 6's `verify-ci.sh` check
against **this** push (the command `push-main.sh` prints); it covers every
sprint in the wave in one pass. On a red run: identify the offending sprint locally by
bisecting over the wave's merge commits (each sprint's `gate.sh` already passed inside its
own worktree, so the regression is almost always an integration effect between sprints, not
a single sprint's own gate) — fix on `main` under the lock (subject `fix(S-NNN): …` naming the
offending sprint, so `--expect` attributes it — an untagged commit is `(unattributed)` and
refused as foreign), then run `push-main.sh --expect …` again
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
  `S-NNN | planned(date) | decisions | started | worktree=… | status=running|READY_TO_LAND|PARKED|NEEDS_CLAIM|PLAN_GAP|DIED|landed@<land-branch> | admitted(initial|after S-NNN)`.
  Update it as runs return and as you land. `.claude/sprint-orchestration/events.jsonl`
  (written by a hook on every subagent start and stop) shows which agents are running and
  for how long — `/sprint board` summarises it.
- Maintain `W-<id>/wave-plan.md`: members table (ID, verdict, plan_date, touches summary),
  constraint findings, contract edges checked, pending decisions, dispatch checklist,
  review dispositions. This is where planning-pass state survives compaction — including
  the planning-worktree path while Step 2 is in flight.
- Execution subagents write the **Completion Log into the sprint file** in their worktree
  (evidence citations, outcome, deviations, deferred, learnings — committed
  on the branch, so it lands with the code and outlives everything here) and a ≤20-line
  pointer `W-<id>/S-NNN-report.md` (sprint-file path, commit list, literal gate tail, the
  lint SUMMARY line). Step 5 reads the sprint file through `close-check.mjs --json`, never
  the body, and adds `W-<id>/S-NNN-docs-draft.md`. Save each run's returned
  `review_record` and `outcome` line to `W-<id>/S-NNN-review.md` the moment they arrive —
  you write both at land, and they must survive a compaction in between. Nothing in this directory is ever cited
  from a committed file — it is gitignored.
- After a compaction, trust this ledger + `git log` + `/sprint board` (the `in-progress/`
  set and `wave:` reservations on `main` are authoritative), never recollection. Your wave
  id is in the ledger dir name and in the reservation commit. Never start or land a sprint
  already marked `landed`.

### Roles and models

The **master** is this interactive session — assumed to run the strongest available model
(e.g. Fable). Its judgment is spent where it is cheapest and highest-leverage: orchestrating,
advising blocked agents, adjudicating findings lists and reports. It never reads diffs or
sprint bodies (diff-dependent duties — doc sync, `/adr check`, review — are always delegated
to fresh subagents; the master only adjudicates their structured returns) — that is what
keeps it alive across a whole wave.

Subagents run on the model **and reasoning effort** their work needs.
`scripts/sprint/routing.json` is the table. Fixed roles are pinned in their agent
definitions too, so dispatching by name gives the routed setting:

| Role | Default | Why |
|---|---|---|
| `sprint-planner`, `wave-planner` | opus / high | a gap in the brief is a guess committed to code — and the planner assigns the tier |
| `arbiter` | opus / xhigh | makes the decisions others may not (set `fable` where available) |
| `brief-auditor`, `finding-verifier` | sonnet / medium | narrow, checkable tasks |
| `doc-sync` | sonnet / low | mechanical |

The **executor and the reviewer are routed per sprint, by its `tier:`** — how hard the work
is (`docs/sprints/tier-rubric.md`), assigned by the planner at certification with a
recorded reason:

| `tier:` | The work is… | Executor | Reviewer |
|---|---|---|---|
| `routine` | mechanical — repeats an existing pattern | sonnet / medium | sonnet / high |
| `standard` | ordinary engineering within one module | sonnet / high | opus / high |
| `complex` | design under constraints, subtle state, cross-module | opus / high | opus / high |
| `critical` | hard and unforgiving — data loss, security, irreversible | opus / xhigh | opus / xhigh |

Three properties of this table are deliberate. **A tier fixes effort as well as model** —
effort is the cheaper lever, and running everything at the same effort either overpays for
mechanical work or under-thinks the hard work. **A reviewer is never weaker than the
executor it reviews** — with one routed exception: in the three-lens review of a
`risk: high` sprint, the tests lens (do the tests assert the new behaviour; was one
loosened) runs on `reviewer_lens.tests`, the cheaper model, on every tier below
`critical`. And **both ends of the tier scale are earned, with `standard` the default**:
`routine` needs every criterion on a checklist, `complex` and `critical` need a rubric
signal the brief shows, and the lint and the cold reader check both. `risk: high` is not
such a signal — risk buys the three lenses, not a stronger executor. A sprint wrongly left
at `standard` costs one cheap run before ESCALATE lifts it, under a reviewer on the
stronger model; a sprint wrongly raised is paid in full every time.

`sprint-flow` applies the table itself from the `routing` and `sprint.tier` you pass it,
and climbs `routing.escalation` one rung per ESCALATE. On the hand-dispatch fallback the
routed model is a spawn-time `model` on the Agent tool — the only sanctioned override:
never pass a `model` that is not in routing.json, and never dispatch a wave role as a
generic subagent — either lets N agents silently run on the master's model and multiply
the wave's cost. To change a setting, edit routing.json — and, for a fixed role or the
`standard` tier, the `model:` / `effort:` lines of its agent definition too.

**Tune it on evidence.** Each landed sprint records an `outcome:` line; `node
scripts/sprint/tiers.mjs` aggregates them per assigned tier and flags a tier that
escalates too often (`UNDER`), finishes uncleanly (`STRAINED`), or has run clean long
enough to question (`OVER?`). Change the rubric or the table when that view says so — not
after one bad sprint, and not on a hunch.

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
`[skip ci]` convention, worktree mode (`git -C`, never EnterWorktree), what a
`sprint-flow` run does and returns (Step 4), the hand-dispatch fallback, the durable ledger, Roles and models (dispatch by agent name; the
executor's model follows the sprint's `tier:` per routing.json), the decision policy,
ESCALATE handling, the `land` claims check (exit 6), multi-session rules, and Failure
handling.

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
- **Autonomy contract.** The confirmation at Step T1 authorizes the whole chain: a train
  runs in the policy's **unattended** mode (`docs/DECISION_POLICY.md`). Between sprints
  the master proceeds without asking; executor OPTIONS and planner questions go to the
  `arbiter`, and its mechanical and taste decisions are recorded in Pre-Sprint Decisions
  with its RECORD line (`- YYYY-MM-DD (train, taste, arbiter): [decision] — principle: … —
  rejected: … — undo: …`) plus one line in train-progress.md — the T7 close lists the
  taste ones for the user. A `reserved` return is never auto-answered: it is hard stop (4). Checkpoint pushes follow the **push policy chosen at
  T1**; when "ask at each checkpoint" was chosen, that pause is a *scheduled* stop like the
  decision round — not a hard stop. The **only four hard stops**: (1) a second PLAN_GAP on
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
hard-stop events." In the same confirmation, ask the **checkpoint push policy**
(AskUserQuestion — each checkpoint push deploys via any connected platform):

- **Ask at each checkpoint** — pause for the deploy-gate question before every
  `push-main.sh`. *(recommended when platforms auto-deploy main)*
- **Auto-push** — this T1 confirmation authorizes all checkpoint pushes; no further asks.
- **Hold until train end** — checkpoints land locally without pushing; one deploy-gate ask
  before the final T7 push. *Caveat: no origin backup of landed code mid-train.*

**T2 — Reserve the whole chain.** `bash scripts/sprint/reserve-wave.sh S-A … S-N` — the
wave id doubles as the train id, and this is checkpoint P1 (the train's one origin-sync
push, `[skip ci]`, zero CI). Record the printed `pre_wave_sha` alongside the wave id — T7's
close-the-train review uses it as the diff base. Create `.claude/sprint-orchestration/W-<id>/` with
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
EnterWorktree) → `worktree-link.sh setup` (env files; links in link mode — install mode adds
one `{{PACKAGE_MANAGER}}` install). Record the base SHA
in train-progress.md.

**T5 — The sprint loop** (strictly serial, per member i):

1. **Start + sync** (i > 1): `start.sh S-i --wave W-<id> --no-push`, then the ledger-sync
   merge into the branch.
2. **Delta refresh (mechanical, master-only — no code reads).** `planStatus` is blind
   mid-train (dep `end_date`s flip only at checkpoints), so screen staleness yourself: take
   the predecessor's `deviations[]` from its `close-check.mjs --json` output and its
   Produces lines, and grep S-i's brief citations against the predecessor's `touches:`. Clean → dispatch. Dirty → one
   `sprint-planner` in **post-start mode against the worktree copy** (commits
   `S-i: revise plan — train delta` on the branch); auto-decide its new questions via the
   ladder where an option is recommended + reversible + small-blast-radius, else hard stop.
3. **Launch** one `sprint-flow` run for S-i (wave Step 4's call) with `mode: "train"`,
   `autonomy: "unattended"`, the train worktree as `sprint.worktree`, and
   `sprint.diffBase` = the predecessor's **boundary SHA** — the run's reviewers then diff
   `<base>..HEAD` (S-i's commits only), not `main...HEAD`. One run at a time: the train is
   serial.
4. **Act on what the run returns** (wave "What a run returns"): `NEEDS_CLAIM` →
   `claims.mjs add S-i <path> --no-push` under the lock (S-i is in `in-progress/`, so the
   precondition holds) and re-launch with `resume`; `PARKED` with a `reserved` question is
   hard stop (4); `PARKED` on review findings that survived two fix rounds is a hard stop
   too — a train never lands over an open Critical.
5. **On `READY_TO_LAND`:** evidence check via `close-check.mjs --json` on the worktree's
   in-progress file (structured output only, never the diff; `ok:false` → re-launch with
   the failure list as `resume`); record the boundary SHA (`git -C <wt> rev-parse HEAD`) +
   status line in train-progress.md; save the run's `review_record` and `outcome` line to
   `W-<id>/S-i-review.md`; dispatch `doc-sync` for S-i against the boundary range and
   pre-draft its semantic docs into `W-<id>/S-i-docs-draft.md`.
6. **Checkpoint due** (i ≡ 0 mod K, last member, or any pause/abort)? → T6, then continue
   the loop.

**T6 — Checkpoint land** (one lock transaction, at a sprint boundary only):
`merge-sprint.sh prepare train-W-<id>` (exit 3 → full `gate.sh` in the worktree, lock held)
→ `merge-sprint.sh land train-W-<id> --sprints S-A,S-B,…` (one `--no-ff` merge; per-sprint
done-moves + status/end_date flips; one regen; exit 4) → apply the segment's pre-drafted
docs, paste each member's saved `review_record` over its `### Review` pending line, and
set each done-file's `outcome` (seconds) → `merge-sprint.sh finish train-W-<id> --sprints S-A,S-B,… --no-push` →
push **per the T1 push policy**: "ask-each" → deploy-gate question, then
`bash scripts/sprint/push-main.sh --expect S-A,S-B,…` (the landed ids); "auto" → that
`push-main.sh --expect` directly; "hold" → skip the
push (the segment stays local until T7). When pushed, it is **the checkpoint's single
CI-triggering push** — verify CI green once (PROTOCOL Phase 3 Step 6); a held segment
carries the CI check to whichever later push lands it. Update train-progress.md
(`landed@ckpt-n`).
**Red CI:** the segment's boundary SHAs narrow a first-parent bisect to one sprint in ≤2
steps; fix on `main` under the lock (`fix(S-NNN): …` subject), `push-main.sh --expect …` again
(never raw `git push`), re-verify.
Not cured by one targeted fix → hard stop; the batched land gives a clean escape hatch —
`git revert -m 1 <segment-merge-sha>` undoes the whole segment in one commit (surface to the
user first).

**T7 — Close the train.** After the final segment: one fresh `reviewer` over merged `main`
(hand it the landed `done/` file paths, plus `pre_wave_sha` from T2's reservation as the explicit diff
base — `git diff <pre_wave_sha>...HEAD` on `main`; same rule as the wave review in Step 6, an
implicit branch-vs-main diff on `main` is empty; small fixes on `main` under the lock ride
the final push, larger ones become follow-up sprints; Step 6's conditional outside-voice
second pass applies here too, with the same `pre_wave_sha` base) → run wave Step 6's
**proposal stage check** over the whole train's landed sprints →
`reserve-wave.sh --release W-<id>` for never-started
members → final push per the T1 policy (auto → `push-main.sh --expect <train ids>`; otherwise
the deploy-gate question first — under "hold" this is the train's one code-bearing push) + CI
verify → `worktree-link.sh teardown .claude/worktrees/train-W-<id>` →
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
  Release leftovers (`--release`), final `push-main.sh --expect <train ids>`, keep the ledger dir for the
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

(Hand-dispatch fallback only — `sprint-flow` composes this prompt itself.)

## Failure handling

- **A planning subagent dies mid-edit:** its roster file may be dirty — in the wave's
  planning worktree, not the ledger. Recovery is
  `git -C .claude/worktrees/wave-W-<id>-plan checkout -- docs/sprints/backlog/S-NNN-*.md`,
  then re-dispatch or `--drop` the member (wave-plan.md records which files were handed to
  planners). The primary checkout was never at risk.
- **A member is rejected at the decision round:** pre-start this is cheap — keep the
  committed deepening, `reserve-wave.sh --drop W-<id> S-NNN`, note it in wave-plan.md.
  Removing members preserves pairwise disjointness; only *adding* members forces a re-check.
- **A run returns `NEEDS_CLAIM` / `PARKED` / `DIED`:** see "What a run returns" (Step 4) —
  grant the claim, take the question to the user, or re-launch; a re-launched run
  continues from the branch (committed work persists there) and needs only `resume`.
- **BLOCKED and ESCALATE never reach you from a run** — the run answers a BLOCKED executor
  through the arbiter and moves an ESCALATE to the next routing tier itself; what it
  cannot settle arrives as `PARKED`. On the hand-dispatch fallback you do both: never
  answer an ESCALATE by telling the same executor to try again.
- **A run itself fails** (the workflow errors, or is stopped): nothing on `main` moved and
  the branch keeps every commit — re-launch it; with the same arguments the Workflow tool
  can resume from its last completed agent.
- **`land` exits 6 (paths outside claims):** see Step 5 — abort, claim, prepare, land.
- **PLAN_GAP:** the brief is wrong — fix the brief, don't abandon the sprint. Before
  re-dispatching, prepend one line to `docs/sprints/PLANNING_LEARNINGS.md` (create with a
  one-line header if absent): `- YYYY-MM-DD S-NNN PLAN_GAP: <gap class> — <root cause in
  one line>`; readers read the newest 20 entries — never delete older ones, they are the
  archive. A gap that invalidates the premises
  of **other un-started members or backlog sprints** — not just this brief — escalates
  past in-place repair: drop or finish the affected in-flight work, then route to
  `/plan recut` for the un-started remainder rather than hand-editing the backlog
  (a 2nd PLAN_GAP on the same sprint is the hard-stop signal to consider it). Then
  re-dispatch a
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
- **Ledger push withheld (exit 3 from `start.sh` / `unstart.sh` / `reserve-wave.sh` /
  `claims.mjs add` — not to be confused with `merge-sprint.sh prepare`'s exit 3, "re-run the
  gate"):** the transaction committed locally; `ledger-push.sh` refused to push
  because local `main` carries another session's unpushed code. Not a failure — continue; the
  printed `push-main.sh --expect <ids>` is the owner's to run, and your ledger commits ride the
  next permitted push. Never "fix" it with a raw `git push`.
- **`push-main.sh` exit 2 (FOREIGN code in the range):** another session's landed code is on
  local `main`. Do not push it past its owner's deploy gate: show the printed groups and ask
  the user; `--allow-foreign` only on an explicit yes.
- **Lock busy (exit 75):** another session/wave holds it — follow the exit-75 protocol in
  "Running waves from multiple sessions". Never steal silently.
- **Orphaned worktree** (sprint in `in-progress/` with no worktree, or vice-versa): see
  `/sprint board`'s orphan check before re-dispatching.
- **Abandoning a wave:** release what you hold — `reserve-wave.sh --release W-<id>` for
  unstarted members; started members are individually `unstart`ed or completed. Then, always,
  `bash scripts/sprint/push-main.sh --expect <wave ids>` before walking away (see Push policy) — a deferred wave
  must never leave local `main` silently ahead of `origin`. Leave the ledger dir for the
  post-mortem.
