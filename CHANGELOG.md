# Changelog

All notable changes to the project-template payload. Downstream repos read these
entries during `/template-upgrade` — write every bullet for the person running a
repo that installed this template, not for template maintainers.

## [1.14.0] - 2026-11-12

**Model and effort follow the difficulty of the work.** Until now a sprint was `standard`
or `complex` by proxy — story points, risk — every executor ran at the same reasoning
effort, reviewers ran at one fixed setting, and nothing recorded whether the choice had
been right. Tiers are now four, each fixes model *and* effort for both the executor and
its reviewers, the planner assigns them from the code with a recorded reason, and every
landed sprint feeds a calibration view. No migrations: existing sprint files keep working
(`standard` and `complex` mean what they meant; a missing tier is `standard`).

- **Four tiers** (`docs/sprints/tier-rubric.md`, new, both tiers): `routine` (mechanical —
  repeats an existing pattern), `standard`, `complex` (design under constraints, subtle
  state, cross-module), `critical` (hard *and* unforgiving). The tier is about difficulty;
  `risk:` (what is exposed) and `story_points` (size) are separate questions, and story
  points no longer set the tier.
- **Routing per tier** (full: `scripts/sprint/routing.json`): executor — routine
  sonnet/medium, standard sonnet/high, complex opus/high, critical opus/xhigh; reviewer —
  routine sonnet/high, standard opus/high, complex and critical opus/xhigh. A reviewer is
  never weaker than the executor it reviews, and an escalated sprint is reviewed at the
  tier it *finished* on. The escalation ladder now has four rungs, climbed one per
  ESCALATE.
- **The planner assigns the tier, at certification** (`/sprint plan`, the `sprint-planner`
  agent). It has just read the code the sprint touches; `/plan`'s tier is provisional and
  is only ever `standard` or `complex`. The planner writes `tier:` and a one-line
  `tier_reason:` (new frontmatter key) and may lower a provisional tier when the code shows
  the work is simpler — with the reason on the record.
- **Asymmetric by design.** Going *down* to `routine` requires every criterion on a
  checklist: an existing pattern cited as `file:line` and followed, no new interface,
  `risk: low`, no open question, no schema/concurrency/caching/auth/trust-boundary work,
  ≤ 5 files, ≤ 3 points. `plan-check.mjs` enforces the ones a lint can see (new rule
  `tier-unjustified`), and the `brief-auditor` — which has not seen the planner's
  reasoning — checks the claim against the code and blocks a `routine` that does not
  hold. Going *up* needs one signal. Unsure means the higher tier. After a sprint starts,
  its tier only rises.
- **Outcome tracking** (full). Each `sprint-flow` run returns an `outcome` line —
  `assigned=… final=… runs=… escalations=… arbiter=… fix_rounds=… findings=confirmed/raised`
  — which the orchestrator writes into the done-file's frontmatter at land.
  **`scripts/sprint/tiers.mjs`** (new) aggregates them per assigned tier and flags `UNDER`
  (≥ 25% of a tier's sprints escalated), `STRAINED` (≥ 40% needed two fix rounds, a
  re-launch, or had ≥ 2 confirmed findings) and `OVER?` (a top tier that has run clean for
  8+ sprints). Nothing is flagged below 4 sprints. `/sprint board` shows it, and the wave
  close relays its flags to you — changing the rubric or the table is your call.
- **Upgrade notes.**
  - `routing.json` changes shape: `roles.reviewer` is now a table by tier, and
    `roles.executor` and `escalation` gain `routine` and `critical`. If you edited the
    file, the upgrade three-way-merges it; `sprint-flow` also accepts the old shape (one
    reviewer entry; a `critical` sprint then starts at the top of the old ladder, a
    `routine` one runs as `standard`) so a half-merged file degrades safely rather than
    cheaply.
  - **Cost moves in both directions.** Mechanical sprints get cheaper (medium effort, and a
    Sonnet reviewer); `complex` sprints get a more expensive review (Opus at extra-high);
    `critical` is new and is the most expensive setting. Nothing becomes `routine` unless
    a planner assigns it and the lint and the cold reader agree.
  - Briefs certified before this release have no `tier_reason:`. That is a warning for
    `complex`, never a failure; re-certifying a sprint (`/sprint plan`) assigns its tier
    under the new rubric.
  - Where `fable` is available to you, `executor.critical`, `reviewer.critical` and
    `arbiter` in `routing.json` are the places to use it.

## [1.13.0] - 2026-11-12

**Flow orchestration (full tier).** A wave used to move in barriers: plan everything, then
execute everything, then land one sprint at a time — each landing able to re-run the whole
gate under the lock — and only then look at what was unblocked. It now flows. Each sprint
runs in its own workflow and reports back on its own; finished sprints land together in
one merge with one gate run while the others keep executing; and every landing admits the
sprints it unblocked into the same wave. Review moves out of the executor: an executor can
no longer be the one who picks its reviewer. No migrations. Lite installs are unaffected
apart from two extra allow rules.

- **One workflow run per sprint** (new: `.claude/workflows/sprint-flow.js`). The
  orchestrator launches one run per started sprint in a single message; each notifies it
  separately when it ends. Inside a run: **execute** on the model the sprint's `tier:`
  routes to → a BLOCKED executor is answered by the `arbiter` and a fresh executor
  continues from the branch (a reserved decision parks the sprint for you) → an ESCALATE
  moves it up the routing ladder → **review**, independent of the author: one `reviewer`,
  or three focused lenses (correctness, security and data, tests) for a `risk: high`
  sprint → every Critical/Important finding goes to a `finding-verifier` told to refute
  it → the executor **fixes** what survived and verifiers re-check each fix against the
  new HEAD, two rounds at most. It returns `READY_TO_LAND`, `PARKED`, `NEEDS_CLAIM`,
  `PLAN_GAP` or `DIED`, with a ready-made `review_record`.
- **Planning as a workflow too** (new: `.claude/workflows/plan-flow.js`, replacing
  `plan-wave.mjs`): per member a planner, a `brief-auditor` cold read with one repair
  round, and — in a gated wave — an `arbiter` ruling on each open question. It returns
  what was `decided` (with record lines) and what to `ask` you.
- **Review is no longer the executor's to arrange.** `sprint-executor` loses its
  "run a reviewer child" duty: it writes `### Review` as `— pending: independent review
  before land`, and the orchestrator pastes the run's `review_record` into the done-file
  at land. This also retires the v1.11 stop-gap for executors that could not spawn
  children — nothing in the wave depends on an agent spawning a child any more, so waves
  behave the same in cloud sessions (where subagent nesting is capped) as on a laptop.
- **The gate is the gate.** `sprint-executor` is now told in so many words that a
  `gate.sh` failing on the untouched baseline is a PLAN_GAP, and that substituting another
  command for it — or editing it — is never the executor's call. (Found in a live fixture
  run: with a broken gate, two executors stopped correctly and one "verified" with a
  different command; the batch's single gate run at landing would have caught it, but it
  should not get that far.)
- **Batch landing** (new: `scripts/sprint/assemble-train.sh`). Every sprint that is ready
  when you turn to landing goes in one batch: the script merges their branches into one
  integration branch (a member that conflicts is left out, not allowed to sink the batch),
  you run `gate.sh` **once**, with no lock held, and `merge-sprint.sh prepare / land
  --sprints / finish` land them in one transaction — the train-checkpoint path, now used
  for waves. N sprints cost one gate run instead of up to N under the lock. A red gate
  splits the batch in half.
- **Rolling admission** (new: `claims.mjs ready [--wave W-<id>]`, `reserve-wave.sh --add
  W-<id> S-NNN…`). After each landing the orchestrator asks what can start *now* — every
  dependency landed, claims free — and adds those sprints to the same wave: same id, same
  ledger, same review base. `ready` also says why each other backlog sprint cannot start.
  Planning for soon-to-be-unblocked sprints may run ahead while the wave executes.
- **`/sprint board`** gains running agents (`scripts/sprint/agents.mjs`, from the
  hook-written event log: who is running, for how long; finished counts and durations per
  agent type) and the latest decisions made on your behalf. Wall-clock only — Claude Code
  does not expose token cost to hooks, so none is shown.
- **Verified with live agents** before release: in a rendered full-tier fixture, three
  sprints ran as three concurrent workflow runs, hit a broken gate (two stopped
  correctly), had a deliberately undecided behaviour settled by the arbiter and recorded,
  were reviewed independently (three lenses for the high-risk one), and landed as one
  batch with one gate run, each done-file carrying its own commits and review record.
- **`ORCHESTRATION.md` is restructured** around this: Step 4 launches runs, "What a run
  returns" says what to do with each status, Step 5 lands in batches, Step 5.5 admits. A
  "Without the Workflow tool" section keeps the hand-dispatch path — same roles, same
  order, same rules. The train loop launches one `sprint-flow` run per member
  (`mode: "train"`) instead of dispatching executors directly.
- **Upgrade notes.**
  - `/template-upgrade` will list two **removed** files —
    `scripts/sprint/workflows/exec-wave.mjs` and `plan-wave.mjs`. Choose *delete*: the
    workflows now live in `.claude/workflows/` as `sprint-flow.js` and `plan-flow.js`
    (they must be `.js` there — Claude Code does not discover saved workflows as `.mjs`).
  - The workflow scripts use top-level `await` and `return`; if your linter scans
    dot-directories, ignore `.claude/`.
  - **Finish in-flight waves before upgrading**, or finish them by hand: an executor
    dispatched under the old definition has already run (or skipped) its own review and
    written `### Review` itself — land those sprints as before; the new record-pasting
    step applies to sprints run after the upgrade.
  - A wave now runs more agents per sprint than before (reviewers, verifiers, and the
    arbiter when needed). Cost scales with `risk:` — a low-risk sprint adds one reviewer;
    a high-risk one adds three plus a verifier per finding. Models are in
    `scripts/sprint/routing.json`.
  - If the user capped a wave at N, the cap now limits sprints *in flight*, not the wave's
    total — admission keeps the wave going until nothing more is ready.

## [1.12.0] - 2026-11-12

**Decisions, routing and enforcement.** Three things that were prose become mechanisms.
Who decides what is now one policy every skill and agent defers to, instead of ~20
separate "ask the user" rules and an autonomy contract that existed only in train mode.
Which model runs which role is a table, with an escalation path for agents that hit
something beyond them. And the rules agents were asked to follow — stay inside your
claims, never run lifecycle scripts, never push — are enforced by hooks and by `land`.
No migrations. **Read the upgrade notes: this release changes how sessions behave.**

- **`docs/DECISION_POLICY.md`** (new, both tiers). Three classes, tested in order:
  *reserved* (direction and scope, overturning you, irreversible or destructive changes,
  security posture, spend, public contracts, superseding an ADR, weakening a test or the
  gate, deploys, Manual criteria) is **always asked, in every mode**; *mechanical* (the
  brief, an ADR, the decision ladder or the code's convention gives one answer) is decided
  and recorded without asking; *taste* (reasonable people differ, reversible, contained)
  is decided, recorded with the option not taken and how to undo it, and listed at **one
  approval gate per phase** where you accept all with a word or overturn any by number.
- **Defaults by flow.** `/plan` and `/sprint wave` run *gated* (you now get one brief at
  the end of a breakdown or a decision round instead of a question per boundary);
  `/sprint train` runs *unattended* as before, with its auto-answers now made by the
  arbiter and recorded in the policy's grammar; `/proposal` stays *interactive* — its
  direction and appetite are always yours — unless you ask it to run gated; solo
  `/sprint start` stays interactive. Say "ask me everything" to any of them for
  interactive.
- **`arbiter` agent** (new, both tiers; opus / xhigh). Planners' and executors' questions
  go to it before they go to you: it reads the record and the code, classifies the
  decision, answers mechanical and taste ones with a recorded rationale, and returns
  reserved ones shaped as a decision brief. It never decides a reserved question.
- **`scripts/sprint/decisions.mjs`** (new): lists every recorded decision across sprints
  and proposals — `--class taste` is "what was decided on my behalf", `--since` narrows
  it. Decisions still live only in the artifact they concern; this is a view. It flags a
  taste decision recorded without a rejected option or an undo.
- **Model routing** (full: `scripts/sprint/routing.json`; both tiers: every agent
  definition now pins `model`, `effort` and `maxTurns`). Planners, reviewers and the
  arbiter move to **opus**; executors stay on sonnet for `tier: standard` sprints and run
  on opus for `tier: complex` ones; auditors, verifiers and doc-sync stay on sonnet. The
  old rule "all wave subagents are sonnet, never pass a model" is replaced by "pass a
  spawn-time model only for the executor, only from routing.json".
- **Escalation path.** `sprint-executor` gains a fifth status, **ESCALATE**
  (`repeated-failure` / `beyond-capability` / `carve-out-uncertainty`), with a handover
  block; it commits its work in progress first, and the master re-dispatches on the next
  routing tier, then the arbiter, then you. **BLOCKED** now means "a decision I may not
  make" and is answered by the arbiter first. Escalation is one-way.
- **Guard hooks** (new: `scripts/hooks/guard.mjs`, wired in `.claude/settings.json`).
  Before every Bash and file-edit call, for the main session and every subagent:
  *both tiers* — force-pushing or deleting the main branch is refused (feature branches
  are untouched). *Full tier* — an edit inside a sprint worktree outside that sprint's
  `touches:` is refused, with the way out in the message; a subagent running a lifecycle
  script, pushing, or committing with `--no-verify` is refused; and under the workflow
  variant an executor's DONE is refused (at most three times) while its Completion Log
  fails `close-check.mjs`. `scripts/hooks/agent-log.mjs` records subagent start/stop times
  in `.claude/sprint-orchestration/events.jsonl` (full tier, gitignored).
- **Claims bind at `land`** (full). `merge-sprint.sh land` now refuses a branch that
  changed any path outside its roster's `touches:` — **exit 6**, lock kept, `main`
  untouched, paths listed (the sprint's own file, its evidence directory and the generated
  docs are exempt). Recovery: `abort`, `claims.mjs add`, `prepare`, `land`.
  `--allow-outside-claims "<reason>"` is the audited escape, written into Deviations. It
  also prints a `GATE-SENSITIVE:` list when a branch changes the commit gate, CI config or
  deletes tests. New `claims.mjs covers --sprints …` does the check.
- **Fix: `/template-upgrade` dropped template hooks and env.** `merge-settings` copied any
  top-level key other than `permissions` only when your `settings.json` lacked it — so a
  repo that already had `env` (bootstrap writes `env.SPRINT_MAIN_BRANCH` for a non-`main`
  default branch) or its own `hooks` would never have received this release's hooks. It
  now merges `hooks` per event and `env` per variable (yours win), and is idempotent.
- **Upgrade notes.**
  - *Hooks change session behaviour.* After upgrading, every Bash and edit call runs
    `guard.mjs` (≈50 ms). Hooks you added yourself are kept; the upgrade owns only groups
    whose handlers all run scripts under `scripts/hooks/`. Emergency off-switch:
    `SPRINT_GUARD=off` in the environment. Node ≥ 18 is now required in the lite tier too.
  - *In-flight sprints (full tier).* A sprint started before the upgrade whose branch
    already strays outside its `touches:` will now stop at `land` with exit 6 — claim the
    paths (`claims.mjs add`) rather than override. Sprints with empty `touches:` are
    unaffected (a warning).
  - *Cost.* Planners and reviewers now run on opus. To keep the old behaviour, set their
    `model:` back to `sonnet` in `.claude/agents/*.md` **and** in
    `scripts/sprint/routing.json` (a test in the template keeps the two in step; your
    copies are yours to change).
  - *Unattended runs.* Claude Code ignores `permissions.defaultMode: "auto"` in a project
    settings file; set it in `~/.claude/settings.json` if you want waves and trains to run
    without permission prompts.
  - *CLAUDE.md block* gains one line (the policy doc); as always the block between the
    `project-template` markers is replaced whole.

## [1.11.0] - 2026-11-12

**Planning rigor.** Until now a proposal was scored by one generic reviewer whose result
was explicitly "not a gate", a plan breakdown was reviewed by nobody but its author, a
sprint brief was certified by the agent that wrote it, and none of the rules for any of
them was checked by a script. This release adds a rigor tier, production-readiness
sections, independent review panels with a pass mark, and two lints. It also fixes two
defects in the full tier's workflow variant found while testing it. No migrations.
Everything applies to proposals and sprints written after the upgrade — existing
proposals (no `**Rigor**:` line) and existing sprints (no `risk:`/`tier:` keys) keep
working unchanged.

- **Rigor tiers** (`/proposal` Step 1.6, `PROPOSAL_TEMPLATE.md`): each proposal declares
  `**Rigor**: light | standard | critical`, classified mechanically from what the idea
  touches (critical: auth, payments, secrets, irreversible data changes, trust-boundary
  parsing, migrations, public contracts; standard: a new module/service/datastore/
  dependency, or more than one sprint). The tier scales everything below, so a small
  proposal stays small.
- **`## Production readiness`** (new template section): design-level answers for the
  recommended alternative. Light: risks and rollback. Standard adds architecture and data
  flow, interfaces and contracts, test strategy, observability. Critical adds data model
  and migration, security and threat model, failure modes, non-functional targets,
  rollout plan, cost and capacity. Still no deliverables. A bare "n/a" fails the lint;
  `n/a — [why]` passes.
- **Prior decisions are read first.** `/proposal` and `/plan` now read `docs/decisions/`
  (plus planning learnings and TODOS) before the first question. A direction that
  contradicts an accepted ADR becomes an explicit "supersede ADR-NNN?" decision for you —
  previously nothing upstream read the ADRs at all.
- **Design it twice** (`/proposal` Step 3, standard and critical): when the idea adds a
  module, service or data model, two `design-explorer` agents each develop a structurally
  different shape, blind to each other, and Alternatives is built from both.
- **Review panels replace the single reviewer.** `/proposal` Step 6 and — new — `/plan`
  Phase 4 dispatch one fresh-context `design-reviewer` per lens
  (`docs/proposals/review-lenses.md`): 1 lens for light, 3 for standard, up to 7 for
  critical; 4 for a plan (coverage, slicing, contracts, executability). Every blocker and
  major finding is checked by a `finding-verifier` told to refute it before anyone acts on
  it. The panel **passes only if no blocker survives and every lens scores ≥ 7**; at most
  two rounds; what still stands goes to Open questions, and a surviving blocker needs your
  explicit acceptance. The result is written into the proposal as `## Review record`.
  `/plan` skips its panel for 1–2 low-risk sprints and asks before breaking down a
  rigor-bearing proposal that has no review record.
- **Sprint files: `risk:` and `tier:`** (`SPRINT_TEMPLATE.md`, set by `/plan`, raised by
  planning). `risk: high` (the sprint touches a risk-tier surface) makes a new
  `## Production notes` section mandatory — rollback, observability, security.
  `tier: complex` marks sprints that should run on a stronger model; it is recorded now
  and acted on by a later release.
- **A brief's author no longer certifies it.** `/sprint plan` (both tiers) and the wave
  planning pass (full) hand the finished sprint file to a `brief-auditor` that has seen
  nothing else and reports what it would have to ask or assume to execute it. A brief
  that is still insufficient after one repair round keeps `plan_date: null`.
- **New lints** (zero-dependency, lite + full): `scripts/sprint/proposal-check.mjs <file>`
  (sections required by the tier, surviving template placeholders, vague open questions,
  stage gates, `file:line` citations that do not resolve, a missing review record once the
  proposal leaves `draft`) and `scripts/sprint/plan-check.mjs [S-NNN …] [--record <doc>]`
  (dependencies exist and are acyclic, every Consumes is something its dependency
  Produces, placeholders, Production notes on high-risk sprints, citations, the plan
  record's coverage map and sentinel). The skills run them; so does
  `scripts/sprint/pre-push-gate.sh`, narrowly — changed proposals, and changed **backlog**
  briefs that are certified and carry a `risk:` key. Unplanned skeletons, in-progress
  files, pre-1.11 briefs and imported proposals are never blocked.
- **Learnings are read back.** `scripts/sprint/learnings.mjs [--class review,test]` lists
  the `### Learnings` lines of closed sprints, newest first. The `reviewer` agent and
  `/review` now start from them, and a rule recorded by three or more sprints is flagged
  `RECURRING` and promoted into `/review`'s Project-Specific Checks. Before this, only
  `plan`-class learnings were ever re-read.
- **Fix (full tier, workflow variant): a dead executor or planner was reported as alive.**
  `exec-wave.mjs` and `plan-wave.mjs` merged a crashed agent's empty result into an
  object, so it came back as a status with no fields and `missing` was always empty.
- **Fix (full tier): sprints could land unreviewed without anyone noticing.** An executor
  cannot spawn its reviewer child when it is dispatched by a workflow script (always) or
  when subagent nesting is capped at depth 1 (the default in cloud sessions). It now says
  so — `### Review` reads `— not run: no Agent tool — orchestrator must review before
  land` — and ORCHESTRATION.md Step 4 tells the wave master to dispatch the reviewer
  itself before landing.
- **Upgrade notes.** New files arrive as additions (four agents, one workflow under
  `.claude/workflows/`, three scripts, `docs/proposals/review-lenses.md`);
  `.claude/settings.json` gains one allow rule, `Workflow(design-review)`. `/proposal`,
  `/plan` and `/sprint plan` now dispatch more subagents than before, and
  `design-reviewer` and `design-explorer` are pinned to `model: opus` — edit the `model:`
  line in `.claude/agents/<name>.md` to change that. The panels use the Workflow tool
  when it is available and fall back to plain parallel subagents when it is not. The
  workflow ships as `.claude/workflows/design-review.js` — a workflow script, not a Node
  module (it uses top-level `await` and `return`): if your linter scans dot-directories
  (ESLint 9's flat config does), add `.claude/` to its ignores.

## [1.10.1] - 2026-11-12

Fixes a `merge-sprint.sh` defect in **train mode** (full tier), found by code review rather
than in use. No migrations; the fix applies on your next `land --sprints …`. Sprints already
landed by a train keep whatever was stamped at the time — see the last bullet.

- **`land --sprints S-A,S-B,…` now stamps each member with its own commits.** The
  post-merge loop reused a variable left over from the completion-log lint loop, so it was
  stuck on the roster's LAST sprint id: every member's done-file got the last member's
  `S-NNN:` commits under `### Commits`, and its own were recorded nowhere. Single-sprint
  landings (`/sprint done`, `/sprint wave`) were never affected.
- **`--allow-incomplete` in train mode now notes the right files.** The same variable
  decided which done-files receive the `landed incomplete — <reason>` line under
  Deviations: it was written to every member when the last one was incomplete, and to none
  otherwise. It is now written to exactly the members that failed the lint.
- **Existing train-landed sprints:** a done-file whose `### Commits` list names another
  sprint's id was stamped by the old loop. The true list is
  `git log --reverse --format='- %h %s' <merge>^1..<merge>^2 --grep='^S-NNN:'` with the
  `merge:` SHA already recorded in that file — correct by hand if the record matters.

## [1.10.0] - 2026-09-01

The sprint file becomes the **durable completion record**. Measured across three downstream
repos (856 done sprints): in the wave-heavy repo 57% of done sprints had a Completion Log
with zero checked boxes and 73% had zero checked acceptance criteria (fill rate decayed
84% → 21% over 670 sprints); the mandatory ADR-check outcome appeared in 0 files; and the
per-deliverable narrative had migrated into INDEX.md Outcome cells (median 1,941 chars,
INDEX.md 1.4 MB). Root cause was a role gap, not discipline: PROTOCOL demanded evidence in
five places but the file had no slot for it, the wave executor stopped at Phase 2 and wrote
evidence/review/deviations to the **gitignored** wave ledger (every committed citation of
`.claude/sprint-orchestration/…` is dead), and `land` flipped two frontmatter fields. No
migrations; the change applies to sprints closed after the upgrade.

- **Structured Completion Log** (`SPRINT_TEMPLATE.md`, heading unchanged): `### Outcome`
  (2–4 sentences — the narrative), `### Commits` (stamped at land), `### Review` (findings
  by severity with `— fixed <sha>` / `— declined: <why>`, or `— not run: low risk`),
  `### Deviations from brief`, `### Deferred`, `### Learnings`, and a `### Close checklist`
  whose every row carries an annotation (`— ADR-NNN` / `— none: reason` / `— n/a: reason`;
  bare "done" fails the lint). The boolean-only rows are gone.
- **Inline evidence grammar.** A checked Automated criterion is followed by
  `- Evidence: <test name | file:line | \`cmd\` → output tail | evidence/ path>`; a criterion
  left open ends `— descoped: <why> (TODOS #N)`; a Manual criterion is checked only by the
  user and ends `— confirmed YYYY-MM-DD`. PROTOCOL Phase 2 step 5 and Phase 3 Step 1 (both
  tiers) now *write* the evidence into the file instead of merely citing it in conversation.
- **The executor writes the record** (`sprint-executor.md` duties 5/7): Evidence lines as
  criteria are checked; at DONE, the Completion Log is filled in the worktree's sprint file,
  self-linted, and committed `S-NNN: completion log`. The ledger report shrinks to a
  ≤20-line pointer. The wave master checks the record through `close-check.mjs --json`
  (`ok`, `failures[]`, `counts`, `review[]`, `deviations[]`, `learnings[]`) — it still never
  reads sprint bodies or diffs. `doc-sync` spot-checks two Evidence citations and returns the
  `Docs synced` / `New docs` / `ADR check` row annotations for the master to paste at land.
- **`scripts/sprint/close-check.mjs`** (new, lite + full, zero-dep): lints a sprint file's
  record — unevidenced/unchecked criteria, unconfirmed Manual criteria, missing or empty
  sections, surviving template placeholders, unannotated or vacuous checklist rows. Exit 0
  pass · 5 incomplete · 1 usage. Pre-1.10.0 files (a Completion Log with no subsections) get
  a `legacy-log` WARNING and exit 0 — history is not a lint failure, and in-flight sprints
  started before the upgrade still land.
- **`merge-sprint.sh land` gates on the record.** Before merging it lints the *branch's*
  copy of each roster member's sprint file: exit 5 lists what is missing with `main`
  untouched and the lock kept — fix on the branch and re-run `land` (no new `prepare`).
  `--allow-incomplete "<reason>"` lands anyway and writes
  `- YYYY-MM-DD landed incomplete — <reason>` under the file's Deviations. After the merge
  it **stamps the sprint's `S-NNN:` deliverable commits + merge SHA under `### Commits`**
  (derived from the merge's parents; zero LLM cost), so a done file stays self-contained
  after archive rotation. `finish` warns when a done file has no Completion Log and when
  the INDEX Done-row Outcome exceeds 300 chars.
- **INDEX diet.** The Done-row Outcome is one sentence (≤200 chars) pointing at the file's
  `### Outcome`; the `_Last updated_` header is one line, overwritten, never appended to
  (PROTOCOL both tiers; INDEX comments for fresh installs).
- **Learnings.** Every sprint records `### Learnings` in a grammar shared with
  `PLANNING_LEARNINGS.md` (`- YYYY-MM-DD S-NNN <plan|test|review|design|exec>: <what> → rule:
  <one line>`; `— none` is valid); `plan`-class lines are also prepended there (new PROTOCOL
  Step 3.7). The "cap at newest 20" rule becomes "readers read the newest 20; never delete
  older entries" — the downstream file that had silently evicted everything after 20 lines
  stops losing knowledge.
- **`docs/sprints/evidence/S-NNN/`** is the official home for artifacts too big for an
  Evidence line — screenshots, smoke transcripts, measurement/investigation reports,
  runbooks — named `<YYYY-MM-DD>-<kind>-<slug>.<ext>`, committed on the sprint branch
  (claim-exempt for the owning sprint), cited by path from the Evidence line. Later sprints
  may back-annotate an older sprint's deferred criterion (`— verified by S-MMM on …`).
- **Tests**: `tests/test-close-check.mjs` (the lint grammar) and
  `tests/test-merge-sprint-land.sh` — the first coverage of `merge-sprint.sh` (exit-5 refusal
  with `main` untouched, re-run without `prepare`, commit stamping, `--allow-incomplete`,
  the oversized-Outcome warning).
- **Upgrade notes.** Downstream repos whose local `SPRINT_TEMPLATE.md` carries a hand-diverged
  Completion Log (two were found with a stale 6-row list) will see a three-way conflict on
  that section — take the template's side. In-flight sprints at upgrade time either get the
  subsections appended by their executor/solo close or land as legacy (warning only).
  Add `Bash(node scripts/sprint/*)` to `.claude/settings.json` allow (the settings-union
  merge does this for you).

## [1.9.1] - 2026-08-28

Fixes two `merge-sprint.sh` defects found in production wave use (ai-todo TODOS #440/#441),
both of the displaced-in-time kind: the script reports success and the damage surfaces
later, somewhere else, looking like something unrelated. No migrations; the fixes apply on
your next sprint completion.

- **`finish` no longer strands doc-sync edits.** It previously staged a fixed path list
  (INDEX, ROADMAP, DOC_HEALTH, the sprint file), so any other doc the completion pass
  touched (TODOS rows, architecture notes) stayed uncommitted — and resurfaced as the NEXT
  sprint's `prepare` refusing with "primary checkout has tracked changes", where it reads
  exactly like a concurrent session's mess. `finish` now stages every dirty tracked file
  under `docs/`, and after the completion commit prints a WARNING naming any tracked
  leftovers that would still dirty-stop the next `prepare`.
- **`land` no longer orphans INDEX.md links on archive rotation.** Rotating a sprint file
  past the 10-file `done/` boundary into `done/archive/` left its hand-authored Done-table
  link pointing at `done/X.md`, which 404s — always a *sibling's* file, never the sprint
  being landed, so any self-scoped check comes back clean and the broken links compound
  silently (13 had accumulated in one downstream repo). `land` now rewrites any
  `(done/X.md)` link whose target exists only under `done/archive/`, echoing each relink.
  The sweep checks all links, so it also repairs previously accumulated orphans on the
  next land.

## [1.9.0] - 2026-08-27

`/plan` closes its seams with `/proposal` (upstream) and `/sprint` (downstream): its
decisions become durable, execution failures route back into a re-cut, and acceptance
criteria learn the difference between what a command can prove and what only a human can.
Patterns ported from gstack's plan-review skills (review-report interop, decision-record
sentinels, exit-gate armor) and current plan-stage research (HumanLayer ACE-FCA dual
verification, OpenAI ExecPlans living records, Spec Kit cross-artifact analyze). No
migrations; existing sprint files with unclassified acceptance criteria stay valid — the
split applies to newly planned/certified sprints.

- **Plan record (durable).** `/plan`'s exit-gate outputs stop living only in conversation:
  each breakdown appends a dated entry to a terminal `## Plan record` section of the source
  document — sprints created, the requirement→sprint coverage map, a scope-decisions table
  (ACCEPTED/DEFERRED/CUT with reasoning and TODOS backlinks), review inputs consumed, and a
  machine-checkable last line (`NO UNRESOLVED DECISIONS` or an `UNRESOLVED DECISIONS:`
  list). The gate flow and recuts read it as evidence. PROPOSAL_TEMPLATE documents the
  section; free-text sources (no document) are exempt and say so.
- **Review-report interop.** Phase 1 now scans the source document for appended review
  sections (e.g. gstack's terminal `## GSTACK REVIEW REPORT`) instead of relying on
  review output being in the conversation; a report's `UNRESOLVED DECISIONS:` list blocks
  the breakdown until each item is resolved via AskUserQuestion.
- **`/plan recut` — the divergence protocol.** New flow for when execution invalidates
  un-started backlog sprints: structured mismatch first (Expected / Found / Why it
  matters), re-ground against current code, re-cut only the invalidated backlog subset,
  reject stale sprints with `superseded by recut YYYY-MM-DD — [mismatch]` (edges
  re-wired, never dangling), fresh S-NNNs for replacements, a dated recut entry in the
  Plan record. PROTOCOL Phase 2 (both tiers) and ORCHESTRATION's PLAN_GAP handling route
  premise-level failures that span sprints here instead of hand-editing the backlog;
  direction changes still go through `/proposal`.
- **Question protocol + exit-gate armor in `/plan`.** The skill adopts `/proposal`'s
  question protocol (decision briefs with stakes lines, one decision per call, the
  5+-option split rule) — applied to the Phase 2 boundary confirm — and the exit gate
  reports explicitly per check ("state what you examined"; a zero-findings check says so
  in one line, never a bare pass; an issue with an obvious fix is still an issue).
- **Automated vs Manual acceptance criteria.** SPRINT_TEMPLATE splits criteria:
  Automated (the exact command + the observable difference it must show) vs Manual
  (human-confirmed only — executors and `/plan`/`/sprint plan` may never check those
  boxes; PROTOCOL Phase 3 Step 1 confirms each with the user at close). `/sprint plan`'s
  readiness checklist and the sprint-executor agent enforce the classification.
- **Cross-artifact lints + learnings parity.** `/plan`'s exit gate gains three proposal
  lints — no sprint delivers a declared Non-Goal, builds a rejected alternative's
  distinctive feature, or pre-builds a later stage — and Phase 1 now reads
  `docs/sprints/PLANNING_LEARNINGS.md` (previously only `/sprint plan` and the wave
  planners did).

## [1.8.1] - 2026-08-26

Fixes the multi-stage gate machinery for a proposal's LAST stage, which by design has no
Gate spec (PROPOSAL_TEMPLATE.md said so since 1.7.0, but no skill implemented it — the
Gate flow would fire anyway and land on an unanswerable one-option question). No
migrations; existing proposals are unaffected until their final stage closes.

- **`/proposal` gate-due exception skips the final stage.** A delivered final stage with
  Status still `active` now flips `**Status**:` to `delivered YYYY-MM-DD` directly
  (commit: `docs: proposal {NNN} — delivered`) instead of entering the Gate flow. The
  Gate flow header states it never runs for the last stage.
- **PROTOCOL Step 3.6 distinguishes final from non-final stages.** Non-final: unchanged
  (mark stage delivered, quote the gate question, route to `/proposal NNN`). Final: mark
  the stage AND the proposal `delivered YYYY-MM-DD` in the close commit — no gate message
  fabricated for a stage that has none. The full tier's master-side stage check
  (ORCHESTRATION wave close, reused at train close) gets the same branch.
- **Terminal statuses match the template grammar.** The Gate flow writes
  `stopped YYYY-MM-DD — [reason]` (was bare `stopped`); terminal `delivered YYYY-MM-DD` is
  written at sprint close, not by the Gate flow. A decided stage's status line *becomes*
  `gate: [chosen option] YYYY-MM-DD` (was "gains"), matching the template's
  alternative-values grammar and keeping the gate-due detection (`delivered …` with no
  `gate:`) unambiguous.

## [1.8.0] - 2026-08-25

`/proposal` learns to look outward — parallel codebase exploration, an online landscape
check before alternatives — and tightens its Q&A rigor with patterns ported from gstack's
plan-review skills (plan-ceo-review / plan-eng-review / plan-design-review). Single file
changed (`proposal/SKILL.md`, both tiers via lite); no migrations.

- **Step 0 Explore fan-out (conditional).** When the idea spans several modules, the repo
  is unfamiliar, or grounding needs more than a few greps, Step 0 dispatches 1–3 parallel
  read-only `Explore` subagents, each answering one specific question with `file:line`
  evidence — mirroring `/plan`'s measure-before-cutting rule. Small/known scope keeps the
  in-context Grep/Read default. The Gate flow's re-ground step may use the same fan-out.
- **Step 2.5 landscape check (new).** Before drafting alternatives, WebSearch what the
  idea introduces: built-ins, maintained off-the-shelf solutions, current best practice,
  known footguns. A found existing solution becomes an explicit alternative (adopt/wrap vs
  build). Fail-soft: without WebSearch, note "search unavailable — in-distribution
  knowledge only" and continue. `allowed-tools` gains WebSearch/WebFetch.
- **Question protocol → decision briefs.** Every AskUserQuestion now names the stakes
  (one line on what breaks if we pick wrong) and gives each option a one-line consequence.
  New split rule: 5+ real options are never dropped to fit the 4-option cap — split into
  sequential per-item calls, then one final confirm of the assembled set.
- **Step 1.5 scope appetite (new).** One early question — minimal cut / complete version /
  staged — recommended from Step 1's "why now", skipped when the user already stated it.
  Steps 2–3 commit to the chosen posture instead of re-arguing it later.
- **Step 6 reviewer is code-grounded.** The fresh-context reviewer now gets repo access
  and verifies the proposal's claims against the code: every issue quotes its motivating
  `file:line` (or names the empty search); ungroundable issues are labeled `unverified`
  and recorded, not acted on. New anti-shortcut clause: after the user confirms the draft,
  mechanical fixes apply directly, but material changes (direction, scope boundary,
  alternative ranking, stage/gate specs) route back through AskUserQuestion — the reviewer
  never silently mutates a confirmed draft.

## [1.7.0] - 2026-08-25

Multi-stage proposals close the loop between an RFC and the sprints it spawns, and
`/proposal` now routes every user decision through AskUserQuestion instead of prose. No
migrations — all changed files are managed and merge via `/template-upgrade`'s normal
plan/apply.

- **`/proposal` question protocol generalized (both tiers).** A skill-wide rule replaces
  Step 1's local one: every decision the user must make arrives as an AskUserQuestion
  (2–4 options, recommended first) — contested scope calls in Step 2, and, new, the
  **direction itself in Step 3**: the model recommends, the user picks the alternative.
  Step 5's draft review is a structured confirm ("Looks right — proceed to reviewer" /
  "Needs changes"). New anti-pattern: a decision asked in prose is a gap.
- **Multi-stage proposals.** `PROPOSAL_TEMPLATE.md` gains an optional `## Stages` section:
  per stage an outcome plus a Gate spec (question, options, measurable evidence) — never
  deliverables. The Status grammar becomes `draft | active (stage k/N) [→ ADR-NNN] |
  delivered | stopped | rejected`; existing proposals with legacy statuses
  (`accepted → ADR-NNN`) stay valid history and are left untouched. A new Gate flow in
  `/proposal` (also reached by `/proposal NNN` when a stage is delivered but ungated)
  re-grounds in the changed code, reads the landed sprints' Completion Logs, decides the
  gate via AskUserQuestion, records it, and offers `/plan NNN` for the next stage.
- **`/plan` is stage-scoped and writes back.** On a staged proposal it plans ONLY the
  current stage — planning past an undecided gate stops and routes to `/proposal NNN`
  (an explicit override is recorded as `gate: skipped by user`). It stamps each sprint
  with `proposal:`/`stage:` frontmatter backlinks (new SPRINT_TEMPLATE fields, ignored by
  scripts) plus a greppable Context citation, and flips the proposal `draft → active` /
  the stage to `planned (S-…)` in the same commit — closing the "Status: draft forever"
  gap for all proposals, staged or not.
- **Sprint close points back to the proposal.** New PROTOCOL Step 3.6 (both tiers): when
  the last open sprint of a proposal stage closes, the stage is marked `delivered` (rides
  the close commit) and the user is routed to `/proposal NNN` for the gate decision —
  never decided inline. Un-staged proposals flip straight to `delivered`. Wave/train
  executors skip the step; the master runs it once at wave close (ORCHESTRATION Step 6)
  and train close (T7), avoiding the simultaneous-finishers race.

## [1.6.0] - 2026-08-21

`/proposal` grows a real interrogation method. The probing-question style stays; it is now
the primary method (no longer hidden behind an installed brainstorming skill) and is
structured into explicit steps, borrowing the highest-leverage mechanics from the gstack
review skills without their infrastructure. No migrations — all changed files are managed
and copy in via `/template-upgrade`'s normal plan/apply.

- **`/proposal` method rewrite (both tiers).** The gate-1 method is now: ground in code
  before asking (first question cites `file:line` or explicitly declares greenfield) →
  premise interrogation (who / verified current behavior / desired behavior / why now /
  observable success signal, plus a premise challenge: "real problem or proxy — what if we
  do nothing?") → scope lock (non-goals early, smallest version that delivers the value,
  settled scope calls are not re-argued) → equal-weight alternatives (minimal-viable cut
  mandatory, ideal version when distinct, "do nothing" when cheap, dual-scale effort notes;
  a brainstorming skill is optional input here, no longer the whole method) → a 0–10
  self-review loop before the draft is shown → "what did I get wrong?" draft review → one
  fresh-context reviewer subagent round (scores Completeness/Consistency/Clarity/
  Scope-YAGNI/Feasibility, max 2 rounds, recurring issues land in Open questions instead of
  looping, fail-soft). A short anti-patterns list replaces the optional grill-me round.
  Quantification rule throughout: count it or write "unknown — measure by [method]".
- **`PROPOSAL_TEMPLATE.md` guidance tightened (comments only, shape unchanged).** Problem
  comments now require verified/quantified current behavior and an observable success
  signal; Alternatives comments require the minimal-viable cut plus reversibility/effort
  notes; Open questions gain a mandatory deferral consequence
  (`— if deferred: {what happens}`).
- `docs/proposals/README.md` updated to describe the new method.
- **Executability fixes surfaced by a fresh-context review of the skill itself**: first
  proposal ever numbers 001; the proposal file is written at the self-review step so later
  steps operate on disk; a bare proposal-number argument routes to the existing-proposal
  gate; the Output section applies only to paths that produce a file; gate-3 duplicate
  detection checks filenames then H1 titles.

## [1.5.0] - 2026-08-18

The idea→spec→sprint path is now complete end to end: `/proposal` fills the gap
before `/plan`, `/sprint reject` fills the gap after it, and `/plan` cuts slices that
are safe to run in parallel. Contributed from downstream fork experience. No
migrations — no seeded file changed; the new skill and template copy in via
`/template-upgrade`'s normal plan/apply, and the changed files are all managed or
merged.

- **New `/proposal` skill + `docs/proposals/PROPOSAL_TEMPLATE.md` — the missing idea→spec
  step (both tiers).** Turns a bare idea into a decision-ready RFC in
  `docs/proposals/NNN-*.md` (problem, goals, 2–3 alternatives with trade-offs, decision
  criteria — the shape is deliberately disjoint from sprint files: no deliverables, no
  acceptance criteria). Uses an installed brainstorming skill as the method when available,
  knows when to skip itself (finished plan handed in, or proposal already exists), and
  always ends by offering `/plan <NNN>`. README workflow gains step 0; the CLAUDE block
  routes bare ideas here.
- **Lite-tier sprint execution defaults to a subagent-driven execution skill** when one is
  installed (sprint file = plan, deliverables = tasks; Phase 2 rules bind every implementer
  subagent as global constraints; `/sprint done` stays mandatory afterwards). Solo
  execution remains the fallback. Full tier unaffected — its own executor machinery governs.
- **New `/sprint reject S-NNN [reason]` (both tiers)** — the `rejected/` column gets its
  missing transition: backlog-only move with a mandatory one-line reason,
  dangling-dependency flagging, documented reversal. Full tier runs it as a locked
  main-ledger transaction with a wave-reservation guard.
- **`/plan` measures slice file-regions before cutting (both tiers).** When the repo is
  unfamiliar, the plan spans several modules, or the breakdown heads past ~5 sprints, Phase 2
  now dispatches one read-only `Explore` subagent per candidate slice — all in a single
  message, so they run concurrently — each reporting the file region the slice touches, the
  shared modules it depends on, and the contracts it crosses. The cut then happens on measured
  regions rather than estimates, so a file claimed by two slices becomes a foundation-sprint
  candidate up front instead of a mid-wave claims conflict (full tier) or a merge conflict
  (lite). Skipped when the seams are already obvious — the fan-out costs tokens and its value
  scales with uncertainty about the code.
- **Deliverable dependencies are now marked explicitly (both tiers).** `/plan` writes, and
  `SPRINT_TEMPLATE.md` requires, a `depends on #N` / `independent of all prior deliverables`
  line per deliverable; PROTOCOL Phase 2 uses that marking to dispatch independent
  deliverables in parallel instead of reading every sprint as strictly sequential.
- **One-shot bulk work routes past the sprint machinery.** The CLAUDE block now sends
  migration sweeps, codebase audits, and research passes — work that leaves no durable
  artifact — to a goal-formulated parallel job (Workflow / plain parallel subagents) stating
  goal, done-criterion, and self-check, rather than through sprint cards. Sprints stay for
  work whose cards, claims, and history must outlive the session.
- **Settings**: `Skill(proposal)`, `Skill(debug)`, `Skill(template-upgrade)` added to the
  shipped allowlist (the latter two were shipped but not allowlisted); `gate.sh` ships with
  its executable bit set.

## [1.4.0] - 2026-07-29

Two themes: sprint completions now **ask before pushing main** (a push to main is a
production deploy on any platform that auto-deploys the default branch), and review
depth now **scales with blast radius** via a shared calibration doc. No new always-on
agents; no migrations — all changed files are managed, and the two new docs copy in via
`/template-upgrade`'s normal plan/apply.

- **Deploy gate (both tiers).** Sprint completion no longer pushes `main` silently.
  Lite: the close step asks (Push now (deploy) / Hold) before `git push`. Full solo:
  `/sprint done` runs `merge-sprint.sh finish --no-push` in every mode and settles the
  code-bearing push behind the same question via `push-main.sh`; waves ask once at
  checkpoint P3; trains choose a policy at T1 (ask at each checkpoint / auto-push /
  hold until train end) — the four train hard stops stay four. Held pushes are
  board-visible (`/sprint board` classifies the unpushed range) and CI verification
  rides the eventual push. Ledger-only `[skip ci]` pushes (start/reserve/unstart,
  wave P1/P2) stay automatic; if your platform redeploys on those, configure it to
  ignore `docs/` + `.claude/` watch paths. `merge-sprint.sh` behavior is unchanged
  apart from its deferral message — `finish` without `--no-push` still pushes.
- **New `docs/sprints/review-calibration.md` (both tiers).** Shared reference for the
  reviewer agent and `/review`: confidence calibration, a pre-emit verification gate
  (quote the motivating `file:line` or the finding is demoted — kills the
  "field doesn't exist" false-positive class), anti-rationalization rules, test-gaming
  detection (tests loosened to make a diff pass are Critical), a failure-modes check,
  and the risk-tier table that defines "high blast radius" once for every consumer.
- **Reviewer hardening (both tiers).** `.claude/agents/reviewer.md` gains the evidence
  gate, confidence-scored findings with an "Unverified observations" appendix,
  test-gaming detection, risk-tiered deep passes, a narrow mandate (correctness /
  security / stated acceptance criteria — "could be more general" is not a finding),
  and acceptance-criteria checking against the sprint file rather than author summaries.
- **Risk-tiered solo review (both tiers).** New PROTOCOL Phase 3 step: solo sprints
  whose diff hits the risk table get one fresh-context `reviewer` pass before closing;
  low-risk sprints explicitly skip it. Wave/train sprints are unaffected (their
  executor's mandatory reviewer child already covers it).
- **Testing discipline (both tiers).** `docs/sprints/testing-anti-patterns.md` gains
  three patterns: a ★/★★/★★★ test-quality rubric (a smoke test doesn't satisfy an
  acceptance criterion), the mandatory regression rule (changed existing behavior with
  no covering test ⇒ regression test, no asking), and interaction edge cases with a
  unit-vs-E2E rule of thumb.
- **Plan-time quality (both tiers).** `/plan` Phase 2 adds a search check (framework
  built-in? known footguns? custom-where-builtin-exists is a scope reduction), requires
  naming the existing code each major piece reuses, and locks scope decisions once
  made; Phase 4's lite parallelization now flags module-level overlap between same-wave
  sprints. New `docs/sprints/design-checks.md` (interaction-states table, AI-slop
  check, design-system alignment, responsive + a11y, unresolved-decisions table) is
  applied to UI-scoped sprints only — a hard early exit keeps backend sprints free of
  design review. The full tier's `sprint-planner` applies the same checks when deepening.
- **Executor evidence + reviewer independence (full tier).** `sprint-executor` hands
  its reviewer child the diff and the sprint file only — never its own reasoning — and
  reports must include the literal tail of gate/test output instead of prose claims.
- **Conditional outside voice (full tier).** After a wave (or train close), a *second*
  fresh reviewer is dispatched only when the merged diff is high-risk or the first
  review found a Critical — prompted to find what the first review missed, never shown
  its findings; disagreements are surfaced to the user as neutral tensions. At most one
  extra agent per wave, never per sprint.

## [1.3.1] - 2026-07-23

- **Fix (full tier): serial trains could not start their second sprint.** `start.sh
  S-NNN --wave W-…` ran the file-claims overlap check without telling it which wave
  the caller belongs to, so the train's own reservation (which legitimately covers
  every member of the chain) was treated as a foreign blocking claim — every train
  member after the first failed with exit 2, contradicting ORCHESTRATION.md's serial-train
  protocol and start.sh's own contract ("a sprint reserved by a *different* wave refuses
  to start"). `claims.mjs check` now accepts `--wave` and skips claim holders in the
  caller's own wave/train; `start.sh` passes its `--wave` through. Foreign-wave and
  solo-sprint claims still block exactly as before. Both files are managed —
  `/template-upgrade`'s three-way merge applies them. No migrations.

The fixes below also shipped in v1.3.1 (they landed via PR #1 before the version
bump) but were originally omitted from this entry; added retroactively.

- **Fix (both tiers): update checks no longer go permanently stale for the most
  active users.** `update-check.sh` rewrote its cache timestamp on every run,
  including cache hits — anyone running `/sprint` more often than the 1-hour TTL
  kept sliding the window forward and never hit the network again, so new template
  versions were never surfaced. The cache is now written only after a real fetch.
- **Fix (both tiers): update checks and upgrades now work when the template repo is
  private.** `update-check.sh` and `upgrade.mjs` fetched over
  `raw.githubusercontent.com` / codeload tarballs, which serve nothing for private
  repos without a token. Both now use a single bounded shallow `git fetch` that
  reuses the same credential helper or SSH auth you cloned with. This also removes
  the unbounded `ls-remote` call, satisfying the update check's "must never block"
  contract by construction.
- **Fix (both tiers): template-shipped `deny`/`ask` permissions are no longer
  dropped on upgrade.** `upgrade.mjs`'s settings merge unioned only
  `permissions.allow`; `deny` and `ask` entries shipped by the template were
  silently discarded, weakening the permission posture of upgraded repos. All three
  lists are unioned now.
- **Fix (both tiers): a failing `git merge-file` during upgrade no longer
  masquerades as conflicts.** `git merge-file` exits negative on error (e.g. binary
  input), which was recorded as "255 conflict(s)", journaled, and the renderHash
  bumped — your local file silently kept its old content while the manifest claimed
  the new render had been applied. Such errors now abort the apply with exit 1.
- **Fix (both tiers): `/plan`'s batch sprint-creation commit now carries
  `[skip ci]`.** It was the one ledger-only commit missing the marker, costing a CI
  run per plan despite the push-batching policy.
- **Fix (full tier): worktree paths containing spaces no longer break
  `merge-sprint.sh`.** The porcelain output parse truncated the worktree path at
  the first space, so any checkout under a path like `~/Documents/Claude Code/…`
  failed `prepare` with "no worktree found".
- **Fix (full tier): a merge that fails before starting is no longer misdiagnosed
  as merge conflicts.** A `git merge` that aborts up front (dirty worktree, etc.)
  leaves no `MERGE_HEAD`; `merge-sprint.sh`'s conflict path then ran
  `git commit --no-edit` with no merge in progress and died cryptically under
  `set -e` with the lock still held. The no-`MERGE_HEAD` case is now detected and
  the real worktree status reported.
- **Fix (full tier): post-wave review no longer passes on an empty diff.** "Review
  the merged wave result on main" had no defined base — after landing, the
  reviewer's branch-vs-main diff was empty, so wave reviews trivially passed.
  `reserve-wave.sh` now records a `pre_wave_sha` (as a trailer on the reservation
  commit), ORCHESTRATION.md Step 6 and the train checkpoints dispatch the reviewer
  with it, and the `reviewer` agent refuses to pass an empty default-branch diff.
- **Fix (full tier): the master's doc-sync/ADR duties no longer contradict its
  context diet.** ORCHESTRATION.md Step 5.2 required the master to run doc sync and
  the `/adr` check — both diff work — while the context-diet rule forbids the
  master from reading diffs, so different sessions resolved the conflict
  differently. Diff-dependent duties are now delegated to a short-lived subagent
  whose ≤10-line return the master adjudicates, and a new `doc-sync` agent
  definition backs the role (previously dispatched by name with no definition,
  violating ORCHESTRATION's own invariant).
- **Fix (full tier, docs): corrected ORCHESTRATION.md's stale model-override
  premise.** It claimed the Agent tool has no spawn-time model override — it does
  (the `model` parameter). The cost-control guidance now states the real rule:
  never pass `model` when dispatching wave agents.
- PR #1 also added the template's first regression test suite (`tests/`, covering
  the update-check cache, the settings union, the merge-file error path, and the
  worktree path parse). Tests live only in the template repo and do not ship
  downstream. All shipped changes above are to managed files — `/template-upgrade`'s
  three-way merge applies them. No migrations.

## [1.3.0] - 2026-07-22

- **New `/sprint train S-A S-B … [--every K] [--fast-gate]` (full tier):** an autonomous
  runner for serial sprint chains — members that cannot parallelize because each depends
  on the previous or their `touches:` overlap. Where running such a chain sprint-by-sprint
  costs one worktree, one merge-queue transaction, one push, and one CI run *per sprint*,
  a train uses one reservation, one long-lived worktree/branch for the whole chain, and
  batches landings every K sprints (default 3) into one merge + one push + one CI run —
  N sprints cost ceil(N/K) CI runs. All planning and user decisions are front-loaded into
  a single batched round; the master then drives one `sprint-executor` at a time
  unattended, stopping only for four hard-stop events (repeat PLAN_GAP, uncured red CI,
  a not-ready re-plan verdict, or an irreversible tradeoff). Full protocol in
  `docs/sprints/ORCHESTRATION.md` "The serial train".
- `merge-sprint.sh land`/`finish` accept `--sprints S-A,S-B,…` to land several sprints
  from one branch in a single `--no-ff` merge and a single completion commit (train
  checkpoints). Without the flag, behavior is unchanged — solo and wave flows are
  untouched.
- `sprint-executor` and `sprint-planner` agent definitions gained train-mode notes
  (shared-worktree etiquette, reviewer diff-base SHA, delta refresh against branch
  state); PROTOCOL.md cross-references the train from "Parallel Sprints" and Phase 3.
- All changes are to managed files — `/template-upgrade`'s three-way merge applies them.
  No migrations.

## [1.2.0] - 2026-07-10

- `/plan` gained a scope gate (Phase 2 step 1): before cutting sprints it runs the
  decision ladder over each major piece (cut deliverables that rebuild existing
  capability), routes deferrable work to `docs/TODOS.md`, flags complexity smells
  (a sprint touching >8 files, or >2 new services/stores/frameworks in the plan,
  forces one reduce-or-proceed question), and checks completeness (new artifacts
  must include their build/publish/deploy story or an explicit Out of Scope owner).
- `/plan` gained a blocking exit gate before its commit: a coverage map proving
  every source-plan requirement landed in a sprint (orphans and ghost sprints block),
  a placeholder scan over generated sprint bodies ("appropriate", "as needed",
  "similar to S-NNN" are gaps), and a Produces/Consumes signature-consistency check.
  Sprint cutting also gained a boundary test (a reviewer could accept one sprint
  while rejecting its neighbor) and a >~10-sprints phasing smell.
- `/sprint plan`'s readiness checklist gained two items in both tiers: **no
  placeholders** (every Changes/Interface text executable as written) and a
  **fresh-reader pre-mortem** (re-read the file as an executor with zero
  conversation context; find and fix the likeliest gap before certifying). The
  `sprint-planner` wave agent applies the same bar.
- New planning feedback loop: brief failures (an executor PLAN_GAP in full tier, a
  mid-sprint stop caused by a stale/thin brief in lite) append one line to
  `docs/sprints/PLANNING_LEARNINGS.md` (created lazily, capped at 20 entries), and
  `/sprint plan` + the wave planner read it before planning — briefs stop failing
  the same way twice.
- Sprint files gained a `## Context` section (SPRINT_TEMPLATE.md): source plan path,
  originating task IDs, and the source plan's global constraints copied verbatim —
  the sprint file is the executor's entire brief, so constraints must travel with it.
  Existing sprint files without the section remain valid; no backfill needed.
- Decision-ready Open Questions now carry a recommended option, a one-line why, and
  the stake if wrong (template comment, `sprint-planner` question harvest + return
  format, wave decision round).
- The decision ladder (`docs/ENGINEERING_PRINCIPLES.md`) gained two tie-breakers:
  reversible over locked-in, and small blast radius.
- All changes are to managed files — `/template-upgrade`'s three-way merge applies
  them and your local customizations survive as usual. No migrations.

## [1.1.0] - 2026-07-04

- `docs/ENGINEERING_PRINCIPLES.md` now opens with a 7-rung decision ladder run
  before writing code (build at all? > reuse the codebase > stdlib > platform >
  installed dep > one line > minimum code), and gains two sections: root-cause-
  over-symptom bug fixing (grep all callers, fix shared code once) and hard
  safety carve-outs that are never simplified away (trust-boundary validation,
  data-loss error handling, security, accessibility, explicit requests). The
  smell table gained matching rows.
- `/review` and the `reviewer` agent check the ladder (reimplementation of
  something that already exists) and root-cause placement of bug fixes, and are
  told not to flag the safety carve-outs as YAGNI/KISS violations.
  `/code-simplifier` and `/debug` carry the matching guardrails; the sprint
  PROTOCOL's GREEN step points at the ladder.
- Skills gained explicit Boundaries and null-result rules (sprint, plan, adr,
  debug, review, explain-changes, code-simplifier): each states what's out of
  scope and which skill to hand off to, and what a clean/empty result looks like
  so agents don't invent findings or manufacture edits.
- All changes are to managed files — `/template-upgrade`'s three-way merge
  applies them and your local customizations survive as usual. No migrations.

## [1.0.1] - 2026-07-04

- `scripts/template/upgrade.mjs` now passes strict repo-wide Biome lint rules
  (`Object.hasOwn` instead of prototype `hasOwnProperty`, template literals
  instead of string concatenation, `matchAll` instead of an assign-in-expression
  `exec` loop, and removal of an unused `void`'d variable). Behavior-identical —
  a post-fix render of v1.0.0 is byte-identical to the pre-fix render. If your
  repo lints `scripts/` with Biome (e.g. a whole-repo `pnpm check`), upgrading
  clears those errors; if you already applied the same fixes locally, the
  three-way merge lands clean.

## [1.0.0] - 2026-07-04

- Versioned template: a root `VERSION` file plus a committed
  `.claude/template-manifest.json` in every downstream install pin exactly which
  template version, commit, tier, and placeholder values were installed.
- Automated update checks: `scripts/template/update-check.sh` runs silently before
  every `/sprint` command and surfaces newer template versions (with snooze and
  opt-out); a new `/template-upgrade` skill walks the whole upgrade.
- Three-way upgrade engine (`scripts/template/upgrade.mjs`): fetches old and new
  template versions, re-renders both with your placeholder values, and merges —
  your local customizations are preserved, conflicts get standard markers, and
  nothing is ever deleted without asking.
- Wave push batching: parallel waves now push `main` at three checkpoints instead
  of after every lifecycle commit (~13 → 1 CI-triggering pushes per wave), via the
  new `scripts/sprint/push-main.sh`.
- Sprint ledger commits now carry `[skip ci]` — lifecycle bookkeeping (start,
  reserve, unstart, claims, plan, INDEX/ROADMAP regen) no longer burns CI
  minutes. The `sprint: complete` commit deliberately does not: its push lands
  the code and must trigger CI.
- CI-hygiene audit at bootstrap and on every upgrade: proposes `paths-ignore`
  filters and `concurrency` groups for your GitHub workflows (offered, never
  auto-applied).
- Migrations convention: `migrations/vX.Y.Z.sh` scripts run inside the downstream
  repo when an upgrade crosses that version — for structural changes a file merge
  can't express (frontmatter backfills, skeleton regens, renames).
