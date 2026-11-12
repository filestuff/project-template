# Build spec — planning rigor, decision policy, flow orchestration (v1.11 → v1.13)

Status: **built** — v1.11.0, v1.12.0 and v1.13.0 on branch `claude/nifty-dirac-th4tke` (owner go-ahead 2026-11-12, all three phases). Each phase has an "As built" subsection recording where the build departed from the text.
This file is the maintainer-side build spec for the template itself. It lives outside
`lite/` and `full-overlay/`, so it is never installed downstream and changing it needs no
`VERSION` bump.

## 0. Decisions already taken

| # | Decision | Source |
|---|---|---|
| 1 | Build all three phases, one minor release each. | owner |
| 2 | Use the most appropriate model per role: stronger model for planners, reviewers, arbiter, and for sprints marked complex. | owner |
| 3 | Agents get an escalation path: hand work to a stronger agent, or ask a stronger agent for a decision they cannot or should not make. | owner |
| 4 | Landing stays direct-to-main under the lock; single machine. No PR / merge-queue path. | owner |
| 5 | Taste-level decisions are auto-decided and shown at one gate by default for `/plan` and waves; opt-in for `/proposal`. | owner |
| 6 | Train-mode `land` stamp bug fixed separately. | shipped v1.10.1 |

## 1. Verified facts this design rests on

`E` = tested empirically in a throwaway fixture repo with Claude Code 2.1.322 (headless),
`D` = stated in the live docs, `C` = read in this repo's code.

| # | Fact | How |
|---|---|---|
| F1 | Project `settings.json` hooks fire for tool calls made by subagents, for both Agent-tool dispatch and Workflow `agent()` dispatch. | E |
| F2 | Hook input carries `agent_id` and `agent_type` for subagent calls (absent on the main thread), and an absolute `tool_input.file_path` for Edit/Write. | E, D |
| F3 | Hook input `cwd` is the **main session's** directory even when the subagent works in a worktree by absolute path. Path checks must key on `tool_input.file_path`. | E |
| F4 | `$CLAUDE_PROJECT_DIR` is the main checkout root inside hooks. | E, D |
| F5 | A PreToolUse `permissionDecision: "deny"` blocks the edit and the reason reaches the subagent, which adapts. | E |
| F6 | SubagentStop exit 2 keeps the subagent working with stderr as its next instruction; `stop_hook_active` is true on the retry. | E, D |
| F7 | In a Workflow, an agent's `StructuredOutput` call is a hookable tool call; exit 2 refuses the result and the agent retries in context. | E |
| F8 | **Workflow-spawned agents never receive the Agent tool**, even when the agent definition lists it and nesting depth is 3. They cannot spawn children. | E |
| F9 | Agent-tool-spawned subagents can spawn children only when `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` ≥ 2. Cloud sessions set it to 1, which silently removes the Agent tool from subagents. | E |
| F10 | Workflow `agent({agentType})` honours the definition's `model` pin; a `model` option on the call overrides it. `effort` is settable per call. | E |
| F11 | Workflow scripts have no filesystem, shell, clock or randomness; `pipeline()` has no barrier between stages; a workflow is a barrier to its caller (the caller is notified once, at the end). Concurrency cap per workflow is min(16, CPUs − 2). | D (harness reference) |
| F12 | Hooks fail open: any exit code other than 0 or 2 lets the action proceed. | D |
| F13 | Bash permission patterns and hook `if` filters are best-effort, not a security boundary (`git -C . push` evades `Bash(git push *)`). | D |
| F14 | `defaultMode: auto` in a project `settings.json` is ignored; it must be set in user or managed settings. `permissions.deny` applies in every mode and to subagents. | D |
| F15 | `upgrade.mjs merge-settings` unions only `permissions.*`; any other top-level key is copied only when the downstream file lacks it. A downstream repo that already has `hooks` or `env` (e.g. `env.SPRINT_MAIN_BRANCH`) never receives template hooks or env keys. | C (`upgrade.mjs:717-720`) |
| F16 | `render` exits 3 on any `{{…}}` in any text file that is not a known placeholder (`/\{\{[^}]*\}\}/`). Shipped JS and shell must not contain two adjacent opening braces closed by two adjacent closing braces. | C (`upgrade.mjs:287-295`) |
| F17 | `merge-sprint.sh land` has no check that a branch's diff stays inside its `touches:`. Claims are advisory end to end. | C |
| F18 | `land --sprints` already lands several sprints from one branch in one merge and one completion commit (train checkpoint). | C, tested |
| F19 | Saved workflows in `.claude/workflows/` are discovered by name only with a `.js` extension; a `.mjs` file there is invisible to `Workflow({ name })`. | E |

Consequences drawn from these:

- **F8 + F9: today's workflow variant cannot run the executor's mandatory reviewer child**,
  and the Agent-tool path cannot either in any environment with nesting depth 1. Review must
  move out of the executor and into the orchestration layer in both paths. Nothing in the
  new design may depend on an agent spawning a child.
- **F3: claim enforcement resolves the sprint from the file path**
  (`.claude/worktrees/S-NNN-*/…`), never from `cwd`.
- **F12 + F13 + F17: hooks are early feedback, not the guarantee.** The guarantee is a
  deterministic diff-versus-claims check inside `land`.
- **F11: landing cannot live inside a workflow** (no shell, and lifecycle transactions need
  the lock, the primary checkout and exit-code judgment). The master stays the single
  ledger writer; the barrier is removed by launching one workflow per sprint.
- **F15: the settings merge must be extended before any hook ships.**

## 2. Invariants preserved

1. The orchestrator owns every mutation of `main`; subagents write only what they are handed.
2. The sprint file is the executor's entire brief and the durable completion record.
3. The master never reads sprint bodies or diffs; it adjudicates structured returns.
4. Lifecycle transactions are lock-serialized scripts; the lock is never stolen silently.
5. Proportionality: low-risk work pays no extra ceremony. Every new section, lens and
   reviewer is gated on a rigor or risk tier.
6. A rule that matters is enforced by a script or hook; prose alone decays (measured in
   v1.10.0: evidence fill rate 84% → 21%).
7. Records live in the artifact they concern; cross-artifact views are generated.
8. Release rules: `VERSION` + `CHANGELOG.md` in the same commit; never force-push `main`;
   structural changes to seeded files ship as migrations.

## 3. Phase 1 — planning rigor (v1.11.0, mostly lite)

### 3.1 Rigor tiers

A proposal declares `**Rigor**: light | standard | critical`, classified mechanically in
`/proposal` Step 1.5 and overridable by the user:

- **critical** — touches a surface in the `review-calibration.md` risk-tier table (auth,
  payments, secrets, irreversible data mutation, trust-boundary parsing), or a schema /
  data migration, or a public contract.
- **standard** — adds a module, service, datastore or dependency; or spans more than one
  sprint.
- **light** — everything else.

Sprint frontmatter gains two optional keys, defaulting when absent so existing files need
no migration: `risk: low | high` (drives review depth and brief sections) and
`tier: standard | complex` (drives model routing, §4.3).

### 3.2 Template sections

`PROPOSAL_TEMPLATE.md` gains `## Production readiness`. Required subsections by tier
(each may be `n/a — <reason>`; a bare `n/a` fails the lint):

| Subsection | light | standard | critical |
|---|---|---|---|
| Risks and rollback | ✓ | ✓ | ✓ |
| Architecture and data flow (incl. failure paths) | | ✓ | ✓ |
| Interfaces and contracts (compatibility) | | ✓ | ✓ |
| Test strategy | | ✓ | ✓ |
| Observability | | ✓ | ✓ |
| Data model and migration | | | ✓ |
| Security and threat model | | | ✓ |
| Failure modes (what fails / detection / user sees / recovery) | | | ✓ |
| Non-functional targets (quantified or `unknown — measure by …`) | | | ✓ |
| Rollout and rollback plan (path and time) | | | ✓ |
| Cost and capacity | | | ✓ |

The template still excludes deliverables and acceptance criteria; these sections are
design-level. `SPRINT_TEMPLATE.md` gains, required only when `risk: high`: rollback / flag,
observability, security notes.

### 3.3 Context intake

`/proposal` Step 0 and `/plan` Phase 1 read, before the first question: the ADR index in
`docs/decisions/` (and any ADR whose subject overlaps), the newest 20
`PLANNING_LEARNINGS.md` entries, and `TODOS.md`. The proposal lists them under References
as "Prior decisions consulted". A direction that contradicts an accepted ADR becomes an
explicit "supersede ADR-NNN?" decision, which is always the user's.

### 3.4 Design review panel

Replaces the single fail-soft reviewer in `/proposal` Step 6 and adds the first independent
review to `/plan` Phase 4.

- One agent definition, `design-reviewer` (read-only; strong model, high effort). The lens
  is passed in the dispatch prompt; rubrics live in `docs/proposals/review-lenses.md`.
- Proposal lenses: feasibility-against-code, architecture, scope and simplicity, security,
  data and migration, operability, test strategy.
  light → feasibility only. standard → feasibility, architecture, scope. critical → all
  that apply.
- Plan lenses: coverage (requirement → sprint), slicing and parallelism (deps, touches),
  contracts (Produces / Consumes), executability (cold read).
- Each reviewer returns structured findings: lens, score 1–10, and per finding
  `severity (blocker | major | minor)`, claim, evidence (`file:line` quote or the section
  named), proposed fix. Ungroundable factual claims are `unverified`, as today.
- **Verification:** every blocker and major finding goes to an independent verifier
  (cheaper model) prompted to refute it against the code or the text. Refuted findings are
  dropped and counted.
- **Gate:** pass iff no surviving blocker and every lens scores ≥ 7. Otherwise revise and
  re-run only the failing lenses, at most two rounds. What survives round two is recorded
  under Open questions and shown at the approval gate; a proposal cannot become `accepted`
  with a surviving blocker unless the user accepts it by name (recorded).
- The outcome is written into the artifact as `## Review record` (lens, score, findings
  kept / refuted / fixed, rounds).
- Delivery: `.claude/workflows/design-review.js` when the Workflow tool is available;
  otherwise the skill dispatches the same lenses with the Agent tool in one message. The
  anti-shortcut clause is unchanged: mechanical fixes are applied, material changes go
  through the decision policy.

### 3.5 Design it twice

At standard and critical rigor, when the direction adds a module, service or data model,
`/proposal` Step 3 dispatches two `design-explorer` agents in parallel, each developing one
structurally different alternative to equal depth (interface sketch, data flow, failure
modes, cost), blind to each other. The author compares them in Alternatives instead of
writing every alternative itself.

### 3.6 Artifact lints

Zero-dependency Node, tested, in `scripts/sprint/` (lite):

- `proposal-check.mjs <file> [--root <repo>]` — required sections for the declared rigor;
  no surviving template placeholders; ≥ 2 alternatives; decision criteria present; every
  stage has a gate spec; Open questions are decision-ready; every `path:line` citation
  resolves to an existing file with at least that many lines; a `## Review record` exists
  once Status is past draft.
- `plan-check.mjs [--root <repo>] [S-NNN …]` — every `depends_on` target exists; no cycles;
  every Consumes line cites a Produces line in a dependency; `touches:` populated (full
  tier); story points valid; `risk` / `tier` valid when present; citations resolve; the
  plan record has its coverage map and sentinel.

Both print a `SUMMARY` line and support `--json`. The skills run them and paste the
summary; `pre-push-gate.sh` runs them on changed proposal and backlog files, which is the
mechanical enforcement point in both tiers.

### 3.7 Independent brief certification

`/sprint plan` and the `sprint-planner` agent no longer self-certify. After the planner
finishes, a fresh `brief-auditor` agent receives only the sprint file path and the repo and
returns the questions it would have to ask, and the assumptions it would have to make, to
execute it. Any blocking question means `plan_date` stays null; the planner gets one repair
round. Citation checking is `plan-check.mjs`, not the auditor.

### 3.8 Learning loop

`/proposal` reads planning learnings (§3.3). At sprint close, a finding class that appears
three or more times in `done/` Learnings is proposed as a Project-Specific Check in
`/review` (a mechanical-class decision once §4 ships).

### 3.9 Phase 1 acceptance

- New scripts have tests under `tests/`; `tests/run.sh` green.
- `proposal-check.mjs` passes on a filled fixture at each rigor tier and fails on each
  omission class; `plan-check.mjs` likewise.
- No shipped file contains an unknown `{{…}}` token (F16) — a test renders both tiers.
- Lite and overlay copies of the three shadowed files stay consistent
  (`docs/sprints/PROTOCOL.md`, `docs/sprints/INDEX.md`, `.claude/skills/sprint/SKILL.md`).

### 3.10 As built (v1.11.0) — deviations from the text above

- **Brace placeholders are template-derived.** The lints flag a `{…}` string only when it
  is one of the placeholders in the repo's own template; a generic "braces outside code"
  rule failed honest prose in testing.
- **Pre-push scope is narrower than "changed proposal and backlog files".** Briefs are
  linted only when they are in `backlog/`, certified (`plan_date` set) and carry a `risk:`
  key. Unplanned skeletons legitimately hold placeholders, in-progress citations move as
  the sprint edits code, and pre-1.11 briefs must not start failing on upgrade.
- **Learning loop is a script, not prose.** `learnings.mjs` lists closed sprints'
  learnings and flags rules recorded by 3+ sprints; the reviewer and `/review` read it.
- **`plan-wave.mjs` gained the auditor stage now** (planner → brief-auditor → one repair),
  rather than waiting for `plan-flow` in §5; it also gained `recommended` on questions.
- **Two defects fixed in passing:** `exec-wave.mjs` / `plan-wave.mjs` reported dead agents
  as alive; and a stopgap for F8/F9 (executor declares "review not run", master reviews)
  ships now, ahead of the orchestration-layer review in §5.
- **New test harnesses:** `tests/test-workflows.mjs` runs workflow script bodies against a
  stub runtime; `tests/test-payload-integrity.mjs` guards tokens, dangling references,
  tier parity and exec bits across the whole payload.

## 4. Phase 2 — decision policy, routing and escalation, enforcement (v1.12.0)

### 4.1 `docs/DECISION_POLICY.md` (lite)

Three classes, tested in order:

1. **Reserved — always the user.** Whether to build, and a proposal's direction and scope
   appetite; overturning something the user stated; irreversible or data-destructive
   change; security posture; new vendor, paid dependency or other spend; breaking a public
   contract; superseding an accepted ADR; stage gates; deploys (per push policy);
   weakening or deleting a test or gate; Manual acceptance criteria.
2. **Mechanical — decide silently, log.** The decision ladder, the engineering principles,
   an ADR or a recorded prior decision yields exactly one defensible answer.
3. **Taste — decide, log with the rejected option, surface at the phase's one gate.**
   Reasonable people differ, the choice is reversible, and its blast radius is contained.
   Anything that is neither clearly mechanical nor clearly reversible is Reserved.

Ordered principles for deciding: correctness and the hard carve-outs; binding prior
decisions; the decision ladder; reversible over locked-in; small blast radius; completeness
inside the blast radius when it is cheap; explicit over clever.

Autonomy modes: `interactive` (taste is asked too), `gated` (taste auto-decided, one gate
per phase — the default for `/plan` and waves), `unattended` (gate items are written as
pending and only hard stops interrupt — today's train contract). `/proposal` defaults to
`interactive` for direction and appetite and `gated` for everything else.

Record grammar, written into the artifact the decision concerns (sprint Pre-Sprint
Decisions, the proposal's decision log, the plan record):

    - YYYY-MM-DD (<mode>, <class>, <decider>): <decision> — principle: <which> — rejected: <option> — undo: <how>

`scripts/sprint/decisions.mjs list [--since <date>] [--class taste]` generates the
cross-artifact view; there is no second store.

The approval gate is one brief: the taste decisions made (accept all with one word, or
overturn by number) and the reserved questions, asked with the existing question protocol.

### 4.2 Applying it

| Point today | Becomes |
|---|---|
| `/proposal` "looks right — proceed to reviewer" | removed; the panel runs, then one gate |
| `/proposal` contested scope items | taste when reversible, else reserved |
| `/plan` sprint-boundary confirmation | gate item only if the panel or the complexity smell flags it |
| Wave decision round | reserved questions asked in one batch; taste answered by the arbiter with the planner's recommendation as input |
| Wave BLOCKED executor | arbiter first (as train does today), then the user |
| "Draft an ADR?" | mechanical: draft when doc-sync says one is needed |
| Review fix scope | mechanical: fix Critical and Important |
| Wave deploy gate | push policy chosen once at wave start (ask-each / auto / hold), as train T1 |

### 4.3 Model routing and escalation

- `scripts/sprint/routing.json` maps role → `{model, effort}` using tier aliases
  (`sonnet`, `opus`, `fable`), never dated ids. Defaults: planner, design-reviewer,
  design-explorer, code reviewer → `opus` / high; arbiter → `opus` / xhigh (set `fable`
  where available); executor standard → `sonnet` / high; executor complex → `opus` / high;
  verifier, brief-auditor → `sonnet` / medium; doc-sync → `sonnet` / low.
- Agent definitions carry the same defaults (`model`, `effort`, `maxTurns`). Workflows pass
  the routed values explicitly (F10). On the Agent-tool path the master may pass a `model`
  override **only** from the routing table, for a `tier: complex` sprint; the old
  "never pass a model" rule is narrowed to "never pass one that is not in routing.json".
- `/plan` sets `tier: complex` when story points ≥ 8, or `risk: high`, or the sprint
  introduces architecture rather than following it. The planner may raise it, never lower.
- **Escalation is one-way:** executor (standard) → executor (complex) → arbiter → user.
  - New executor status **ESCALATE** — reason class `beyond-capability`,
    `repeated-failure` (same gate failure after two root-cause attempts) or
    `carve-out-uncertainty` (security, data loss) — with handover notes. The executor
    commits its work in progress first; the successor resumes from the branch.
  - **BLOCKED** carries a decision the executor cannot or should not make. The arbiter
    classifies it under the policy and returns a recorded decision, or `ASK_HUMAN` with a
    decision brief.
  - Where the Agent tool is available to the executor (F9), it may consult the `advisor`
    child directly and keep its context. Nothing depends on this (F8).
- New agents: `arbiter` (lite; read-only; the policy is its instruction) and the
  definitions named in §3.

### 4.4 Enforcement

Hook scripts live in `scripts/hooks/` and are wired in `.claude/settings.json`. Each is
invoked as `node "$CLAUDE_PROJECT_DIR"/scripts/hooks/<name>.mjs`, so a missing exec bit
cannot disable it.

| Hook | Event / matcher | Rule |
|---|---|---|
| `claim-guard` (full) | PreToolUse `^(Edit\|Write\|NotebookEdit\|MultiEdit)$` | If the target is under `.claude/worktrees/S-NNN-*/` (or a train worktree), allow only paths matched by that sprint's `touches:` (tokens expanded via `claims-tokens.json`), its own sprint file and its evidence directory. Otherwise deny: "return NEEDS_CLAIM with the path". Outside worktrees: no opinion. |
| `lifecycle-guard` (full) | PreToolUse `Bash`, subagent calls only (`agent_id` present) | Deny lifecycle scripts (`start.sh`, `unstart.sh`, `merge-sprint.sh`, `lock.sh`, `reserve-wave.sh`, `push-main.sh`, `claims.mjs add`) and `git commit --no-verify`. |
| `main-guard` (lite) | PreToolUse `Bash` | Deny force-push in any spelling the parser recognises, including `git -C … push --force`. |
| `done-gate` (full) | PreToolUse `StructuredOutput`, `agent_type` `sprint-executor`, status DONE | Run `close-check.mjs` on the named worktree's sprint file and require a clean worktree; on failure exit 2 with the failure list so the executor fixes it in context (F7). |
| `agent-log` (full) | SubagentStart / SubagentStop | Append one JSON line (time, event, agent type, agent id) to `.claude/sprint-orchestration/events.jsonl`. |

Guards parse the command themselves rather than rely on `if` patterns (F13). A guard that
errors allows the action and prints a warning (F12); the guarantee is below.

**The guarantee:** `merge-sprint.sh land` gains a claims check before anything mutates —
every path changed on the branch (excluding the roster's own sprint files, their evidence
directories and generated docs) must match the union of the roster's `touches:`. A miss
exits 6 with the list, lock kept, `main` untouched; `--allow-outside-claims "<reason>"` is
the audited escape and writes the reason into Deviations. The same pass lists
gate-sensitive paths (`scripts/sprint/gate.sh`, CI config, deleted test files) so the
master treats them as a Reserved decision.

`permissions.deny` gains the force-push spellings; deny rules apply in every permission
mode and to subagents (F14). The bootstrap notes tell the operator that unattended runs
need auto mode set in **user** settings (F14).

### 4.5 Shipping it downstream

- `merge-settings`: merge `hooks` per event, deduplicating matcher groups by canonical
  JSON so a second run adds nothing; merge `env` per key with the downstream value
  winning; keep the permissions union. Tests: hooks absent, hooks present, hand-added
  hooks preserved, `env` per key, second-run idempotency, absent file.
- `template.config.json` `postCopy.chmod+x`, the bootstrap chmod lines and the README
  manual-install line gain `scripts/hooks/*`.
- Bootstrap Step 8 calls `merge-settings` instead of describing a hand union, and the
  `env.SPRINT_MAIN_BRANCH` step adds a key to an existing `env` object.
- Full-only hooks must not fire in a lite install: each full-tier hook exits 0 immediately
  when `scripts/sprint/claims.mjs` is absent, so one `settings.json` serves both tiers.

### 4.6 Phase 2 acceptance

- Each hook script has a test that feeds it recorded hook-input JSON (allow, deny, error →
  allow, non-worktree path → no opinion).
- `land` claims check: inside claims lands; outside exits 6 with `main` untouched; the
  escape records its reason; train roster uses the union.
- `merge-settings` tests above. `decisions.mjs` test over fixture artifacts.
- A fixture run with a live subagent confirms claim-guard denies and done-gate refuses.

### 4.7 As built (v1.12.0) — deviations from the text above

- **One guard script, shipped in lite.** `scripts/hooks/guard.mjs` dispatches on the tool
  name and holds all four guards; the full-tier ones are inert without
  `scripts/sprint/claims.mjs`. Separate per-guard files would have needed a second
  `settings.json` for the full tier, and lite has only one.
- **No `permissions.deny` rule for force-push.** A permission pattern cannot tell `main`
  from a feature branch, and force-pushing a feature branch is legitimate. The hook
  parses the command and the checkout's branch instead.
- **`merge-settings` owns template hook groups** (every handler runs something under
  `scripts/hooks/`) and replaces them wholesale, so a changed or dropped template hook
  never leaves a stale twin; other groups are the repo's and are kept.
- **done-gate keys on `sprint` and `worktree` in the executor's structured output**, which
  `exec-wave.mjs`'s schema now requires. On the Agent-tool path there is no structured
  output to gate; the master's `close-check --json` + SendMessage loop remains.
- **The lifecycle guard matches the script being run**, not any mention of it — reading
  `start.sh` is not running it.
- **Verified live** in a rendered full-tier fixture: a real subagent's claimed edit went
  through, its out-of-claim edit and its `lock.sh acquire` were refused with the shipped
  messages, and the event log recorded its start and stop.

## 5. Phase 3 — flow orchestration (v1.13.0, full tier)

### 5.1 One workflow per sprint

`.claude/workflows/sprint-flow.js` replaces `exec-wave.mjs`. The master launches one run
per started sprint, all in one message. Each run notifies the master when it finishes, so
there is no barrier across sprints (F11): finished sprints land while others still execute.

Stages inside a run, for one sprint:

1. **Execute** — `sprint-executor` at the routed tier.
   - BLOCKED → `arbiter`; a decision re-dispatches the executor with the answer (it resumes
     from its committed work); `ASK_HUMAN` ends the run as PARKED. At most two rounds.
   - ESCALATE → one re-dispatch at the next tier; a second ends the run as PARKED.
   - A dead executor is re-dispatched once with "read `git log` first".
   - PLAN_GAP and NEEDS_CLAIM end the run and return to the master, because the repair
     needs the lock.
2. **Review** — independent and chosen by the flow, not by the author: a correctness
   reviewer always; for `risk: high`, security, data-and-contract and test lenses in
   parallel. Findings are structured with a quoted line.
3. **Verify** — each Critical and Important finding goes to a verifier prompted to refute.
4. **Fix** — the executor is re-dispatched with the surviving findings, fixes, re-gates,
   commits and updates the Completion Log's Review section; verifiers confirm. At most two
   rounds. A disputed Critical goes to the arbiter; anything unresolved ends as PARKED.

Result: `{sprint, status: READY_TO_LAND | PARKED | PLAN_GAP | NEEDS_CLAIM | DIED, commits,
gate, review, decisions[], escalations[], question?}`. Arbiter decisions are returned for
the master to confirm they were recorded in the sprint file.

`.claude/workflows/plan-flow.js` replaces `plan-wave.mjs`: per member, planner →
brief-auditor, as a pipeline; question objects carry `recommended` and a policy class.

The executor definition drops the reviewer-child duty and the Agent tool requirement
(F8, F9). On the Agent-tool fallback path the master dispatches the reviewer after DONE and
continues the executor with the findings.

### 5.2 Merge-train landing for waves

New `scripts/sprint/assemble-train.sh W-<id> S-A S-B …`: creates an integration worktree
and branch `land-W-<id>-<n>` from `main` and merges each member branch in id order. A
member that conflicts is reported and left out (it lands solo, or returns to its executor).

The master then runs `gate.sh` **once**, in the integration worktree and outside the lock;
green → `prepare` (normally a no-op) → `land <branch> --sprints …` → apply the pre-drafted
docs → `finish … --no-push`. This is the tested train checkpoint path (F18), so a batch of
N sprints costs one gate run and one lock transaction instead of N.

Red gate with several members: split the roster in half and assemble each half; a single
red member goes back through one fix round with the integration failure output. Default
batch cap: six.

### 5.3 Rolling admission and lookahead planning

- `reserve-wave.sh --add W-<id> S-NNN` adds a member to a live reservation under the lock,
  with the same claim checks as a new reservation.
- `claims.mjs ready --json` lists sprints startable now given in-flight claims.
- After each landing batch the master admits newly startable sprints into the same flow:
  add → plan-flow (skip check as today) → decisions per policy → start → launch.
- While a batch executes, the master may run plan-flow for the next candidates in the
  planning worktree. The existing start-time staleness re-check is the guard.

### 5.4 Recovery and visibility

- Lock semantics are unchanged. The lock is transactional across separate processes
  (`prepare → land → finish`), so holder-PID liveness would be wrong; "never steal
  silently" stays.
- `/sprint board` gains an Agents section from `events.jsonl` (running agents by type, age)
  and the per-run results. Wall-clock and counts are available; **token cost per agent is
  not exposed to hooks**, so the board does not claim it.
- The post-flow review over `pre_wave_sha...HEAD` is unchanged.

### 5.5 Documentation shape

`ORCHESTRATION.md` is restructured so the flow is the primary path and Agent-tool dispatch
the documented fallback. Dispatch prompts live once, in the workflow scripts; the document
references them. The sprint skill's `allowed-tools` gains `Agent`, `SendMessage` and
`Workflow`.

Migration `migrations/v1.13.0.sh` (full tier, idempotent): remove
`scripts/sprint/workflows/exec-wave.mjs` and `plan-wave.mjs` when unmodified and drop
their manifest entries.

### 5.6 Phase 3 acceptance

- `assemble-train.sh` tests: three branches assemble and land with each done-file stamped
  with its own commits; a conflicting member is excluded; `reserve-wave.sh --add` and
  `claims.mjs ready` tests.
- Workflow scripts parse, contain no unknown `{{…}}` token, and pass a dry structural test
  (meta literal, phase titles match).
- **End-to-end fixture run** (live agents, cheap models, a toy repo with three sprints,
  one of them deliberately blocked and one with a planted review finding): all three reach
  `done/`, the blocked one via the arbiter, the planted finding fixed, one gate run for
  the batch.

### 5.7 As built (v1.13.0) — deviations from the text above

- **F20 (verified): several workflow runs launched in one message each notify the caller
  separately**, in completion order. That settled the architecture: one `sprint-flow` run
  per sprint, no single pipeline with a barrier at its end.
- **No migration.** `/template-upgrade` already lists removed files and asks delete/keep;
  a `v1.13.0.sh` that deleted the two old workflow scripts would only duplicate that
  prompt. The CHANGELOG tells the operator to choose delete.
- **The review record is pasted by the orchestrator at land**, not written by the
  executor. A clean review would otherwise need one more executor dispatch just to edit a
  line; the master already finalizes done-file rows during the exit-4 pause.
- **`plan-flow` also runs the arbiter** over planners' open questions (a Decide stage),
  so the decision round starts from `decided` / `ask` lists instead of raw questions.
- **Batch landing is a procedure around `assemble-train.sh`**, with the red-gate split
  done by the orchestrator re-invoking it on half the roster — not a `--bisect` flag.
- **Lock semantics and `computeWaves` are untouched**, as planned. `claims.mjs ready` is a
  separate pure function (`computeReady`) with the admission rule; unlike `computeWaves`
  it treats an in-flight sprint with empty `touches:` as overlapping nothing, matching
  `claims.mjs check` and `start.sh` (which refuses to start an unclaimed sprint at all —
  now pinned by a test).
- **`agents.mjs`** summarises the hook event log for `/sprint board`; cost is not shown
  because hooks cannot see it.

### 5.8 Acceptance run (live agents, 2026-11-12)

A rendered full-tier install in a throwaway repo, three sprints, every role on the cheaper
tier at low/medium effort, subagent nesting capped at depth 1 (the cloud default), three
`sprint-flow` runs launched in one message. What happened:

- **The fixture's gate was broken** (my mistake: `node --test tests/` fails on Node 22).
  One executor returned PLAN_GAP and one NEEDS_CLAIM, each refusing to edit the gate
  ("changing the gate is a reserved decision"); the third verified with a different
  command and carried on. The executor definition now forbids that substitution. The
  orchestrator repaired the gate on `main`, merged it into the branches, and re-launched
  the two parked sprints with `resume`.
- **The forced decision** (S-002's brief left a behaviour undecided): BLOCKED → arbiter
  ruled it taste, with principle, rejected option and undo → a fresh executor continued
  from the branch and wrote the record line into the sprint file → independent review →
  `READY_TO_LAND`.
- **The high-risk sprint** got all three review lenses; six Minor findings, none gating.
  The same gap was raised by all three lenses in different words — de-duplication only
  merges identical location + description, so the record carries it three times. Left as
  is: merging on location alone could drop a distinct finding, and noise in a record is
  the cheaper error.
- **Landing:** `assemble-train.sh` merged all three; **one** gate run (8 tests); `prepare`
  was a no-op; `land --sprints` passed the completion lint and the claims check for all
  three; each done-file was stamped with its own commits; the review records were pasted;
  `finish`; lock free; cleanup.
- 13 agents in total (6 executor dispatches, 5 reviewers, 1 verifier, 1 arbiter), about
  one US dollar at these settings. The shipped routing (opus for reviewers and the
  arbiter, higher effort) will cost several times that per sprint.

Two defects found and fixed from this run: `decisions.mjs` ignored a record whose mode tag
was written `gated wave` (the arbiter now gets its one-word tag in the prompt, and the
parser splits on spaces too); and reviewers raised the deliberately pending
Completion-Log rows as findings (the review prompt now says they are not).

## 6. Build order and checkpoints

1. v1.11.0 — §3. Commit, push, report.
2. v1.12.0 — §4, starting with `merge-settings` (§4.5) because hooks cannot ship without it.
3. v1.13.0 — §5, ending with the end-to-end fixture run.

Each release: `tests/run.sh` green, `VERSION` and `CHANGELOG.md` in the same commit, a
both-tier render test with no leftover tokens.

## 7. Deliberately out of scope

- Agent teams (experimental; no per-teammate permissions; no resume).
- PR / merge-queue landing and multi-machine locking (decision 4).
- Cross-vendor second opinions (data leaves the machine by default).
- Changing `computeWaves` ordering (it would churn every downstream ROADMAP block).
- Per-agent token cost reporting (not available to hooks).

## 8. Known risks

| Risk | Mitigation |
|---|---|
| Several workflows launched in one message may not each notify independently in an interactive session (tested only headless, one at a time). | First step of §5 is a two-run smoke test; fallback is one workflow with `pipeline()` and batch landing at its end. |
| Review panel cost on small proposals. | Rigor tiers; light runs one reviewer. |
| A guard false positive blocks legitimate work. | Guards have no opinion outside worktrees; every deny names the escape (NEEDS_CLAIM); tests cover allow cases. |
| Downstream repos with hand-edited `settings.json` hooks. | Merge preserves them and is idempotent (§4.5). |
| Three-file overlay drift (lite vs full copies). | A test diffs the shared sections. |

## 9. Addendum — v1.14.0: tiers that fix model and effort (built 2026-11-12)

Asked by the owner after v1.13: "should model selection and effort level not be dynamic
based on the complexity of the work?" What v1.12–1.13 had was two tiers chosen by proxy
(story points, risk), one fixed effort for every executor, one fixed reviewer setting, and
no record of whether a choice had been right.

**Decisions**

| # | Decision | Why |
|---|---|---|
| 1 | Four tiers — `routine`, `standard`, `complex`, `critical` — each fixing model **and** effort for the executor and for its reviewers. | Effort is the cheaper lever; one effort for all work either overpays for mechanical work or under-thinks hard work. |
| 2 | The tier measures difficulty only. `risk:` still drives review breadth (lens count); story points no longer set the tier. | A 2-point race-condition fix is harder than a 13-point CRUD screen. |
| 3 | The **planner** assigns the tier at certification, with a recorded `tier_reason:`; `/plan`'s tier is provisional (`standard` or `complex` only). | The planner has just read the code — the only position difficulty can be judged from. |
| 4 | Rule-based and asymmetric: `routine` needs every checklist criterion (lint + independent cold reader); one signal moves a sprint up; unsure → up; after start a tier only rises. | A model judging its own task errs low, and under-classifying costs a failed run plus an escalation while over-classifying costs tokens. A free per-task model choice by the agent was rejected for that reason. |
| 5 | A reviewer is never weaker than the executor it reviews, and an escalated sprint is reviewed at the tier it finished on. | Otherwise escalation raises the author above its reviewer. |
| 6 | Outcomes are recorded in the done-file (`outcome:` frontmatter, one line) and aggregated by `tiers.mjs`; nothing is flagged below 4 sprints. | Records live in the artifact they concern (invariant 7); a second store would drift. |
| 7 | `sprint-flow` accepts the pre-1.14 `routing.json` shape; an unknown tier below standard runs as standard, above it at the top of the ladder. | A half-merged table must degrade safely, never cheaply. |

**As built**

- `lite/docs/sprints/tier-rubric.md` is the rule; `SPRINT_TEMPLATE.md`, `/plan`,
  `/sprint plan` (both tiers), `sprint-planner`, `brief-auditor` and `plan-check.mjs`
  (`tier-unjustified`, `tier-unreasoned`) apply it.
- `routing.json`: `roles.executor` and `roles.reviewer` are tables by tier; the escalation
  ladder has four rungs. A test pins that every tier is present, strength never falls as
  the tier rises, no reviewer is weaker than its executor, the arbiter is at least as
  strong as the strongest executor, and the agent definitions pin the `standard` tier.
- `sprint-flow.js` routes both roles by tier, returns `tier`, `tier_assigned` and
  `outcome`, and takes `sprint.assignedTier` / `sprint.attempt` on a re-launch so an
  escalation is not lost. It no longer tells the executor to rewrite `tier:` on
  escalation — the assigned tier stays on the record and the outcome carries the final.
- `tiers.mjs` + `/sprint board` + the wave close relay `UNDER` / `STRAINED` / `OVER?`.
- Not done: effort routing on the hand-dispatch fallback (the Agent tool takes a spawn-time
  model, not an effort — the definition's effort applies there); varying the verifier or
  the planner by tier; any automatic change to the rubric or the table — flags go to the
  user.

