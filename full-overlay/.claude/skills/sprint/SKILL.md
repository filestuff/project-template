---
name: sprint
description: >
  Kanban sprint management for {{PROJECT_NAME}} — start, complete, plan, and track sprints
  with dependency checking, file claims, doc validation, and lock-serialized
  lifecycle commits on main. Use when asked to "start a sprint", "complete a
  sprint", "show the board", "create a sprint", "plan a sprint", "reject a
  sprint", "what's next", "sprint roadmap", "run/fan out a parallel wave", or
  "run a serial train of sprints".
argument-hint: "[command] [sprint-id]"
allowed-tools: "Read Edit Write Glob Grep Bash AskUserQuestion EnterWorktree ExitWorktree Agent Task Workflow SendMessage"
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

## Boundaries

One-shot command dispatcher — handle the requested command, then stop. In scope: the
lifecycle commands below. Out of scope: execution rules (PROTOCOL.md is the source of
truth — never restate or override it here), breaking a plan into sprints (`/plan`),
recording decisions (`/adr`), root-causing failures (`/debug`), wave orchestration details
(`docs/sprints/ORCHESTRATION.md` governs those). `main` mutations go through the helper
scripts only — never hand-rolled. Null results: an empty board is printed as-is — don't
invent rows; `/sprint next` with nothing unblocked says so and names what blocks each
backlog sprint.

## Helper scripts (`scripts/sprint/`)

| Script | Purpose | Key exits |
|--------|---------|-----------|
| `gate.sh` | The commit gate — single source of truth for pre-commit checks (in a linked worktree with worktree gate commands set: a reduced gate, reported as such) | non-zero = fix first |
| `lock.sh` | Mutex for all main mutations (`acquire`/`release`/`status`/`steal --force`) | 75 = busy |
| `claims.mjs` | `check` claims overlap vs in-flight sprints; `add` expands a claim (locked main commit, pushed via `ledger-push.sh`); `waves` (in-flight + reserved sprints pinned to Wave 1). Tokens: `claims-tokens.json` | 2 = overlap / unknown token, 3 = `add` committed, push withheld |
| `regen.mjs` | Regenerate the marker-delimited blocks in INDEX.md + ROADMAP.md (`--check` for drift, broken INDEX `done/` links and duplicate TODOS ids) | 2 = drift / unknown token |
| `check-ledger-links.mjs [--check]` | Relink INDEX `(done/…)` links orphaned by archive rotation; `--check` also flags unresolved links + duplicate TODOS ids | 2 = issues remain |
| `start.sh S-NNN --touches "…" [--wave W-<id>]` | The whole locked start transaction on main (refuses a sprint reserved by another wave) | 2 = overlap/claimed/foreign-reserved, 3 = committed, push withheld, 75 = busy |
| `unstart.sh S-NNN [--reason "…"]` | The locked inverse: in-progress → backlog (keeps `plan_date`/`touches:`/decisions; clears `wave:`) | 2 = not in flight / branch has commits, 3 = committed, push withheld, 75 = busy |
| `reserve-wave.sh S-A S-B… \| --drop W-<id> S-NNN \| --release W-<id>` | Locked wave reservation: mints `W-<id>`, writes `wave:` into backlog members so concurrent sessions can't take them or overlapping claims | 2 = member gone/reserved/overlap, 3 = committed, push withheld, 75 = busy |
| `merge-sprint.sh prepare\|land\|finish\|abort <branch>` | The locked completion (merge queue); `land`/`finish` take `--sprints S-A,S-B,…` in train mode to land a whole segment in one merge + one completion commit. `finish` never pushes | 3 = re-run gate, 4 = author docs, 5 = incomplete record, 75 = busy |
| `frontmatter.mjs get\|set` | Read/write sprint frontmatter fields round-trip-safely | |
| `push-main.sh [--wait <secs>] [--expect <ids>] [--allow-foreign]` | The only code-bearing pusher: classifies the range by sprint id **before** pushing; with `--expect`, refuses another sprint's code; guards against a `[skip ci]` HEAD hiding a code push; prints the `verify-ci.sh` command | 2 = FOREIGN code (ask before `--allow-foreign`), 75 = busy |
| `ledger-push.sh <root> <branch>` | Ledger-only push used by the lifecycle scripts (caller holds the lock): pushes only if every unpushed commit is `docs/`/`.claude/` | 3 = withheld (code on local main), 1 = error |
| `verify-ci.sh <sha> --base <old>` | Waits for the required CI workflows (`ci-gates.json`) + optional deploy; fails closed | 0 = green, 1 = red, 2 = not verifiable (not green) |
| `worktree-link.sh setup\|teardown <wt>` | Worktree env-file copy + link-mode dependency links (`worktree-links.json`); teardown verifies no primary link points into the worktree | 1 = refused (reason printed) |

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

Print the current kanban state:

1. Glob `docs/sprints/in-progress/*.md` **on main** (the primary checkout) — list each with
   sprint ID, goal, start date, days elapsed, and a `touches:` summary. This is authoritative
   for in-flight work.
2. Glob `docs/sprints/backlog/*.md` — count total, sum story points, list unblocked sprints.
   Tag any sprint whose `plan_date` is null as **unplanned** (never certified by
   `/sprint plan`), and any with a `wave:` field as **reserved by that wave** (another
   session's roster — also list `W-*` dirs under `.claude/sprint-orchestration/` whose
   reservations no longer exist on main: likely finished or abandoned waves).
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
8. **Unpushed ledger check**: run `git rev-list --count origin/<main>..<main>` (guard: skip if
   the `origin/<main>` ref doesn't exist). If the count is > 0 and no wave is currently live,
   classify the range: `git diff --name-only origin/<main>..<main> | grep -vE '^(docs/|\.claude/)'`
   — **non-empty** → "unpushed completion awaiting deploy confirmation — `push-main.sh
   --expect <its ids>` pushes and deploys via any connected platform" (local `main` is shared:
   name whose sprints they are from the commit subjects); **empty** → warn that main carries
   unpushed lifecycle commits and suggest `bash scripts/sprint/push-main.sh`.

9. **Agents**: `node scripts/sprint/agents.mjs` — subagents still running (type, age) and
   finished counts with durations, from the hook-written event log. An agent "running" far
   longer than its type's usual duration is the sign of a dead session; cross-check the
   wave ledger before acting. `node scripts/sprint/claims.mjs ready` shows what could
   start right now and why each other backlog sprint cannot.
10. **Tier calibration**: `node scripts/sprint/tiers.mjs` — per assigned tier, how often
    sprints escalated or finished uncleanly, with `UNDER` / `STRAINED` / `OVER?` flags
    (`docs/sprints/tier-rubric.md` says what to do about each).
11. **Decisions made on your behalf**: `node scripts/sprint/decisions.mjs --class taste
    --limit 5` — the latest taste decisions and where they are recorded.

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
`scripts/sprint/worktree-link.sh setup` (env files; dependency links in link mode — in install
mode, then install deps) →
DOC_HEALTH-gated + tag-scoped doc validation → 2–4 architectural tradeoff questions.
Then begin executing deliverables sequentially per **Phase 2: Execution** (commit atomically
per deliverable, run `scripts/sprint/gate.sh` before each commit, and respect the
**claims-discipline rule**: `claims.mjs check` before touching any unclaimed file).

### `/sprint done [S-NNN]`

Execute the full **Phase 3: Post-Sprint** procedure from `docs/sprints/PROTOCOL.md`:
acceptance-criteria **evidence** check — write each criterion's `- Evidence:` line into the
worktree's sprint file (a checked box without an Evidence line does not count; Manual
criteria are user-confirmed) → fill the **Completion Log** (Outcome / Review / Deviations /
Deferred / Learnings + Close checklist), commit `S-NNN: completion log`, lint it with
`node scripts/sprint/close-check.mjs <file>` → doc sync via `git diff` (on the branch) →
**`/adr check` (mandatory; `ADR check` checklist row)** →
**`merge-sprint.sh prepare S-NNN-…`** (locked; on exit 3 re-run `gate.sh`) →
**`merge-sprint.sh land S-NNN-…`** (re-lints the branch copy — exit 5 = incomplete record,
main untouched, fix and re-run; merges to main, moves the file, stamps `### Commits`,
regenerates; exits 4) →
author the semantic docs on main (DOC_HEALTH.md, INDEX Done-row — one sentence — + header,
ROADMAP narrative, the done-file's `Docs synced`/`New docs`/`ADR check` rows)
→ **`merge-sprint.sh finish S-NNN-…`** (commits, releases the lock, **never pushes** — the
completion commit intentionally carries no `[skip ci]`, since its eventual push is what
lands the code) → **deploy gate**: ask via AskUserQuestion — **Push now (deploy)**
(recommended: `bash scripts/sprint/push-main.sh --expect S-NNN`, then verify CI with the
`verify-ci.sh <sha> --base <old>` command it prints — exit 2 is not green; Phase 3 Step 6)
or **Hold** (keep commits local; report that main is ahead of origin — the board surfaces
it; push later with `push-main.sh --expect S-NNN`, which carries the CI check with it) →
`worktree-link.sh teardown` → exit + remove the worktree and branch (Phase 3 Step 6).

### `/sprint create [title]`

1. Glob all sprint files to find the highest S-NNN; assign the next number.
2. **Check `docs/TODOS.md`** for deferred items this sprint could absorb; offer them.
3. Copy `docs/sprints/SPRINT_TEMPLATE.md` → `docs/sprints/backlog/S-{NNN}-{kebab-title}.md`.
4. Fill frontmatter: sprint ID, `status: backlog`, goal from title, a concise `short:` label
   (used in the generated INDEX/ROADMAP blocks), and an empty `touches: []` stub.
5. Ask via AskUserQuestion for: `depends_on`, `blocks`, `tags`, `story_points`.
6. Commit on main under the lock:
   `lock.sh acquire create-S-NNN` → `regen.mjs` → commit
   `sprint: create S-NNN — [title] [skip ci]` (explicit paths, `--no-verify`) →
   `lock.sh release <token>`.

### `/sprint plan [S-NNN]`

Populate a backlog sprint with implementation-ready detail (Files w/ new|modified, a
**Reference** to the most similar existing file, Interface contract w/ file:line, Setup,
Changes, testable Acceptance criteria), ordered in execution sequence; populate Technical
Details, Testing (pattern reference), Dependencies, Risks, Open Questions; update
`story_points` if scope reveals different complexity. **Required**: populate `touches:`
from the Files lists you just wrote (plus tokens from `claims-tokens.json` and likely
doc-sync targets) — `/sprint start` verifies rather than re-derives it. If
`docs/sprints/PLANNING_LEARNINGS.md` exists, read its newest 20 entries first — it lists how
past briefs failed; don't repeat those gaps.

**Readiness checklist** — all must hold before certifying:

1. Every deliverable's Files list names exact paths (new|modified) — no bare globs
   (`dir/**` remains legal in `touches:` only).
2. Every Reference/Interface `file:line` and every cited API/library version was verified
   against the repo **now**, not assumed from the source plan.
3. Zero unresolved Open Questions: resolve each via AskUserQuestion during this pass
   (recording answers as dated Pre-Sprint Decisions entries), or explicitly rewrite it as
   an ask-at-start question with 2–4 concrete options.
4. Every acceptance criterion states an observable difference — not "works correctly" —
   and is classified **Automated** (with the exact command that demonstrates it) or
   **Manual** (human-confirmed only, per SPRINT_TEMPLATE). A criterion that can't name
   its command is Manual by definition.
5. Testing names an existing test file to follow, or states why test-first doesn't fit and
   how the deliverable is verified instead.
6. `touches:` is populated per the Required rule above.
7. **No placeholders**: every deliverable's Changes/Interface text is executable as
   written — "appropriate error handling", "as needed", "similar to deliverable N"
   are gaps, not instructions. Name the handling, the values, the exact difference.
8. **Fresh-reader pre-mortem**: re-read the file as a wave executor with zero
   conversation context. Name the likeliest gap that would make it return PLAN_GAP
   (missing premise, unstated constraint, criterion it can't evaluate) — and fix it.
   Any decision that still lives only in this conversation goes into Pre-Sprint
   Decisions now.
9. **Mechanical lint**: `node scripts/sprint/plan-check.mjs S-NNN` exits 0 (dependencies
   exist, Consumes matches the dependency's Produces, no template placeholders, every
   `file:line` citation resolves, `risk: high` carries Production notes; a `routine` tier meets its checklist). Re-check
   `risk` against what the deepened Files lists now touch — raise it when the sprint
   turned out to reach a risk-tier surface; never lower it. Then **assign the tier** by
   `docs/sprints/tier-rubric.md` — you have just read the code, which is the only place
   difficulty can be judged from: `routine` only if EVERY routine criterion holds;
   `complex` or `critical` on any ONE of their signals; `standard` otherwise; unsure
   between two → the higher. Write `tier:` and a one-line `tier_reason:` naming the signal
   or the pattern (`follows src/x.ts:12-40 — same handler shape`). You may lower `/plan`'s
   provisional tier when the code shows the work is simpler than the plan implied — with
   the reason on the record.
10. **Independent cold read** — you wrote this brief, so you cannot certify it. Dispatch
   one `brief-auditor` subagent (Agent tool; prompt: the sprint file path and the repo
   root — nothing else, least of all your reasoning). `SUFFICIENT` → certify.
   `INSUFFICIENT` → fix every BLOCKING item in the file (an item that needs the user is
   an Open Question resolved per item 3), then dispatch a FRESH auditor once more; a
   second `INSUFFICIENT` leaves `plan_date: null`. Write its ASSUMPTIONS into the file
   where they bite — an assumption the executor would have to make is a sentence the
   brief is missing. If subagents cannot run, say so in your report ("cold read: could
   not run — [why]") and certify on items 1–9 alone; never report a cold read that did
   not happen.

All pass → `node scripts/sprint/frontmatter.mjs set <file> plan_date "$(date +%F)"`. Any
fail → leave `plan_date: null` and report what's missing (still commit partial progress).
Either way, commit on main under the lock (same pattern as `/sprint create`):
`sprint: plan S-NNN — [name] [skip ci]`.

### `/sprint reject [S-NNN] [reason]`

Discard a backlog sprint while keeping the record. Only from `backlog/`; if the sprint
carries a `wave:` reservation, stop and ask — release the reservation first, don't silently
reject a scheduled sprint. If no reason was given, ask for a one-line reason
(AskUserQuestion). Flag any remaining backlog sprint whose `depends_on` names this one
(remove the dependency or reject it too — no silent dangling edges). Then, as a locked
main-ledger transaction (same pattern as `/sprint create`):
`lock.sh acquire reject-S-NNN` → `git mv backlog/… rejected/…`, set `status: rejected`
(`frontmatter.mjs set`), append the dated reason under a `## Rejected` heading →
`regen.mjs` → commit `sprint: reject S-NNN — [reason] [skip ci]` (explicit paths,
`--no-verify`) → `lock.sh release <token>`. Reversal is the same transaction backwards
(keep the rejection note in the file as history).

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

Run the backlog's parallel-safe work as a **rolling wave**. **Defer to
`docs/sprints/ORCHESTRATION.md`** — it is the source of truth for this command (as
`PROTOCOL.md` is for the rest); read it before acting, this is only the shape:

1. **You are the orchestrator** (this session): you own every mutation of `main` and every
   conversation with the user; you never enter a worktree and never read a diff.
2. **Compute and confirm** (`claims.mjs waves`), settling the autonomy mode
   (`docs/DECISION_POLICY.md` — gated by default) and the push policy in the same
   confirmation; **reserve** the roster (`reserve-wave.sh` — checkpoint P1).
3. **Plan**: one `plan-flow` workflow run in a planning worktree — per member a
   `sprint-planner`, a `brief-auditor` cold read, and `arbiter` rulings on open questions.
   Ask the user only what comes back reserved; show the taste rulings once; write every
   answer into the sprint files (two locked `[skip ci]` commits).
4. **Start** each member (`start.sh --wave W-<id> --no-push` + its worktree) — serialized,
   on `main`, under the lock; after the last start, checkpoint P2
   (`bash scripts/sprint/push-main.sh --expect <wave ids>`, a ledger-only push, zero CI).
5. **Run**: one `sprint-flow` workflow run **per sprint, all launched in one message**. Each
   executes on the model and effort its `tier:` routes to (`routine` / `standard` /
   `complex` / `critical` — assigned by the planner, `docs/sprints/tier-rubric.md`), is
   reviewed independently at that tier's reviewer setting, has its findings verified and
   fixed, and notifies you on its own when it ends.
6. **Land what is ready, in batches, while the rest still run**:
   `assemble-train.sh` → one `gate.sh` run → `merge-sprint.sh prepare / land --sprints /
   finish` (paste each run's `review_record` into the done-file and record its `outcome`). Act on `PARKED`,
   `NEEDS_CLAIM`, `PLAN_GAP` returns as ORCHESTRATION "What a run returns" says.
7. **Admit** newly unblocked sprints into the same wave after every landing
   (`claims.mjs ready --wave` → `reserve-wave.sh --add` → plan → start → run).
8. **Close**: a fresh `reviewer` over the merged result (ORCHESTRATION Step 6 adds a
   conditional second "outside voice" reviewer for high-risk waves), the taste decisions
   made on the user's behalf, release leftovers, then **checkpoint P3 (mandatory)** — run
   the wave-end checks on merged `main` (repo-wide guard tests, and the e2e suite if any
   member touched it), then per the push policy
   `bash scripts/sprint/push-main.sh --expect <the wave's own sprint ids>` — the wave's
   single CI-triggering push — and verify CI green once with `verify-ci.sh` (PROTOCOL
   Phase 3 Step 6; ORCHESTRATION Step 6 for red-run recovery).

Optional `N` caps how many sprints are in flight at once. Without the Workflow tool, do
the same by hand (ORCHESTRATION "Without the Workflow tool"). Keep the durable ledger in
`.claude/sprint-orchestration/W-<id>/`. Multiple waves can run from different terminal
sessions — see ORCHESTRATION "Running waves from multiple sessions" and "Push policy".

### `/sprint train S-A S-B … [--every K] [--fast-gate]`

Drive a **serial chain** of sprints — members that cannot parallelize (each depends on the
previous, or their `touches:` overlap) — through one long-lived worktree with batched
landings. **Defer to `docs/sprints/ORCHESTRATION.md` "The serial train"** — it is the source
of truth for this command. In short: you are the master (this session, strongest model);
subagents dispatch by agent name (models and effort per `scripts/sprint/routing.json`; each
member's executor and reviewers follow its `tier:`). Validate the user's ordered
chain (deps in `done/` or earlier in the chain; warn on pairs that would parallelize —
suggest `/sprint wave`), ask the **checkpoint push policy** at T1 (ask at each checkpoint /
auto-push / hold until train end — ORCHESTRATION "Train protocol" T1), **reserve the whole
chain** (`reserve-wave.sh` — the wave id doubles
as the train id; checkpoint P1, `[skip ci]`), **plan all members upfront** (wave Step 2
verbatim: parallel `sprint-planner` fan-out in a planning worktree, then ONE batched decision
round for the entire chain — after it the train runs unattended), create **one** train
worktree/branch (`train-W-<id>`), then loop strictly serially: `start.sh S-i --wave W-<id>
--no-push` + a ledger-sync merge into the branch, a mechanical delta-refresh screen, one
`sprint-flow` run per sprint (`mode: "train"`, the predecessor's boundary SHA as
`diffBase` — the run executes, reviews independently, and answers BLOCKED / ESCALATE
itself through the `arbiter` and the routing ladder; its decisions are recorded as
`(train, <class>, arbiter)` — the train runs in the policy's unattended mode, and a
`PARKED` return, reserved decision or unresolved finding, is a hard stop). Every K sprints (default 3, `--every K` to
change) and at the end: a **checkpoint** — `merge-sprint.sh prepare` → `land --sprints
S-A,S-B,…` → apply pre-drafted docs → `finish --sprints …` → push **per the T1
push policy** (`push-main.sh --expect <landed ids>` is the segment's single CI push; "ask-each" pauses for the
deploy-gate question first, "hold" skips it until the final T7 push) → verify CI green
once. Hard stops only: 2nd PLAN_GAP on one
sprint, red checkpoint CI not cured by one fix, a NOT_READY delta verdict, or an
irreversible tradeoff. `--fast-gate` (opt-in) relaxes per-commit gates to the cheap static
subset with the full gate mandatory at sprint boundaries. Ledger:
`.claude/sprint-orchestration/W-<id>/train-progress.md` (per-sprint boundary SHAs). Close:
post-train `reviewer` over merged main (plus the conditional outside-voice second reviewer,
ORCHESTRATION Step 6/T7), release leftovers, final `push-main.sh --expect <train ids>` (gated per the T1 policy)
+ CI verify, remove the train worktree/branch.

## No Arguments

If invoked as just `/sprint`, run `/sprint board`.
