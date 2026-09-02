---
name: plan
description: >
  Breaks a reviewed plan into sprint files with dependencies and story points. Invoke when
  asked to "break this down into sprints", "create sprints from the plan", "convert to
  sprints", or "seed the backlog" — and, as "/plan recut", when execution has invalidated
  un-started backlog sprints ("recut the plan", "replan the backlog").
argument-hint: "[feature description | proposal number | plan document path | recut <NNN | S-A S-B …>]"
allowed-tools: "Read Edit Write Glob Grep Bash AskUserQuestion Skill"
---

# Plan Breakdown Skill

Takes a reviewed plan and breaks it into sprint files in `docs/sprints/backlog/`.

## Boundaries

In scope: breaking a reviewed plan into backlog sprint files, and re-cutting un-started
backlog sprints when execution invalidates their premises (Recut flow, below). Out of
scope: plan reviews (those run separately first if used — this skill *consumes* their
reports, Phase 1), per-sprint certification (`/sprint plan` — this skill leaves
`plan_date: null`), starting execution (`/sprint start`). Null result: if the plan
genuinely fits one sprint, create one sprint and say so — do not manufacture a multi-sprint
split.

## Question protocol (all phases)

Every decision the user must make routes through AskUserQuestion — one decision per call,
2–4 concrete options, a recommended one first. Questions carrying a real trade-off are
decision briefs: name the stakes in one line (what breaks or is lost if we pick wrong) and
give each option a one-line consequence. Simple confirms need no stakes line. With 5+ real
options, never drop or merge one to fit the 4-option cap: independent items (scope cuts,
boundary adjustments) split into sequential per-item calls, then one final call confirming
the assembled set; mutually exclusive choices narrow to the top 3 plus an explicit "none
of these — show the rest", then decide. A wall-of-text question the user must parse for
options is a protocol violation, not a style choice.

## Pipeline

### Phase 1: Context Gathering

1. Read `docs/sprints/INDEX.md` for current state and existing dependency chains (find the
   highest existing S-NNN).
2. Read the plan source:
   - A path → that document.
   - A number → treat as a proposal: read `docs/proposals/NNN-*.md`. **Staged proposals**
     (a `## Stages` section exists): plan ONLY the current stage — the first stage whose
     status is `pending`, or the stage the last recorded gate chose. Never pre-plan a stage
     whose entry gate is undecided: the gate exists so that plan is made with post-stage
     evidence. If the previous stage is `delivered` but carries no `gate:` line, the gate
     is due — stop and ask via AskUserQuestion: **"Decide the gate first — run
     `/proposal NNN`"** (recommended) / **"Plan the next stage anyway"**. On override,
     record `gate: skipped by user YYYY-MM-DD` on that stage before planning — a skipped
     gate is a recorded decision, not an invisible one.
   - Free text → treat as a feature description; supplement from existing planning docs.
   - No argument → if `docs/execution-plan.md` exists, default to it; otherwise ask the user
     what to break down.
3. **Review inputs.** Scan the source document for appended review sections (a terminal
   `## GSTACK REVIEW REPORT` or similar `## … REVIEW` heading written by a plan-review
   skill) — the file, not the conversation, is where review skills persist their output —
   and fold their findings in. If a report ends with an `UNRESOLVED DECISIONS:` list,
   those decisions **block the breakdown**: resolve each via AskUserQuestion before
   cutting sprints, and record the answers in the Plan record (Phase 4) and the affected
   sprint files. A review that lives only in the conversation still counts; if the user
   implies a review exists but none is visible in either place, ask them to
   paste/summarize it.
4. Read the design-system doc (if one exists) when the work is UI/visual.
5. Read the newest 20 entries of `docs/sprints/PLANNING_LEARNINGS.md` when present — it
   lists how past briefs failed; don't seed those gaps into new sprints (`/sprint plan` and the wave planners
   already read it; batch breakdown must not reintroduce what they'd have to fix).

### Phase 2: Sprint Breakdown

1. **Scope-gate the plan (quick pass, not a re-review).**
   - Run the decision ladder (`docs/ENGINEERING_PRINCIPLES.md`) over each major piece:
     what does the codebase / stdlib / platform / an installed dep already do? A
     deliverable that rebuilds existing capability is cut or rewritten to reuse it.
     **Name** the existing code/flow that partially solves each major piece —
     reuse-or-rebuild is an explicit call, never an omission.
   - **Search check**: for each new architectural pattern or infra component the plan
     introduces — does the framework/platform have a built-in? Is the approach current
     best practice, and are there known footguns? (Use WebSearch when available;
     otherwise note "in-distribution knowledge only".) A custom build where a built-in
     exists is a scope reduction, not a sprint.
   - Flag deferrable work: anything not needed for the plan's goal goes to
     `docs/TODOS.md` with a backlink — not into a sprint. Also check `docs/TODOS.md`
     for deferred items this plan should absorb.
   - **Complexity smell**: any single sprint shaping up to touch >8 files, or the plan
     introducing >2 new services/stores/frameworks overall, triggers one mandatory
     reduce-or-proceed AskUserQuestion before cutting continues.
   - **Completeness**: is this the full version or a shortcut? A new artifact (package,
     service, pipeline) includes its build/publish/deploy story as a deliverable — or
     an explicit Out of Scope entry naming who owns it.
   - Once the user accepts or rejects a scope reduction, commit fully — don't re-argue
     it or silently re-shrink scope in later phases.
2. **Identify natural sprint boundaries.** Foundation/infra first; independent features
   parallelizable; DB/schema before features; integration/eval last. Each sprint completable
   in ≤ ~2 weeks. Respect any build order the source plan locks in.

   **Measure before cutting (conditional).** When the repo is unfamiliar, the plan spans
   several modules, or the breakdown is heading past ~5 sprints, do not cut on estimated
   file regions: dispatch one read-only `Explore` subagent per candidate slice — all in a
   single message so they run in parallel — each returning (a) the file region the slice
   would touch (dirs/files), (b) shared modules it depends on, and (c) the contracts it
   crosses. Cut on the measured regions. A file reported by two slices is a foundation-
   sprint candidate NOW — far cheaper than discovering it mid-wave as a claims conflict
   (full tier) or a merge conflict (lite). Skip this when the seams are already obvious
   (small repo, familiar code): the fan-out costs tokens and its value is proportional
   to uncertainty about the code.

3. **Cut for parallelism.** The aim is sprints that *parallel agents* can run at the same time:
   - Prefer **vertical slices that own disjoint file regions** so two sprints never edit the
     same files — disjoint `touches:` is exactly what makes concurrent execution safe (full
     tier). If a file is shared by several features, extract it into its own foundation sprint.
   - **Minimize `depends_on` edges.** Where a dependency is unavoidable, plan to define the
     blocker's **Produces** contract (Phase 3) so the dependent can be built in parallel
     *against the agreed signature* instead of waiting for the blocker to land.
   - Keep each sprint cohesive — don't over-split into chatter, and don't collapse independent
     features into one mega-sprint.
   - **Boundary test**: a reviewer could accept one sprint while rejecting its
     neighbor. If rejecting sprint B necessarily reopens sprint A, the seam is wrong.
4. **Confirm boundaries via AskUserQuestion** — present the proposed split as a numbered list
   with goals + the dependency chain, calling out which sprints are meant to run in parallel;
   then decide per the Question protocol: "accept as proposed" (recommended) plus the
   concrete adjustments as options — 5+ contested boundaries go through the per-item split
   rule, never one question the user must decompose. A breakdown of more than ~10 sprints is a scope
   smell — offer a phased split (a ship-first tranche now; later tranches seeded as
   backlog with `depends_on`) — or, when the tranches deserve a real decision point
   between them, suggest restructuring the proposal itself into Stages with a gate
   (`/proposal`).
5. **Assign story points** (Fibonacci 1/2/3/5/8/13; 13 → consider splitting).
6. **Determine dependencies** between new sprints and against existing backlog items.

**Red flags — don't rationalize past these:**
- "I'll just put it all in one sprint." A mega-sprint can't be parallelized and hides
  dependencies. Split along file/feature seams.
- "Both touch the same core file, oh well." Overlapping `touches:` forces those sprints
  sequential. Re-cut the seam, or extract the shared file into a foundation sprint.
- "The dependent can just wait." That is the exact choice that serializes the plan. Write the
  Interface Contract so it can proceed in parallel.

### Phase 3: Sprint File Generation

For each sprint, starting at S-{highest+1}, create a file from
`docs/sprints/SPRINT_TEMPLATE.md` in `docs/sprints/backlog/` and populate:
- **Frontmatter**: sprint ID, `status: backlog`, goal, a concise `short:` label,
  `depends_on`, `blocks`, `tags`, `story_points`. When the source is a proposal, also set
  `proposal: NNN` and `stage: k` (`stage: 1` for un-staged proposals; both stay `null`
  otherwise) — informational backlinks, ignored by scripts.
- **Context** (top of body): the source plan's path + this sprint's originating task
  IDs, and every global constraint from the source plan that binds this sprint (stack
  pins, perf budgets, compatibility promises) — copied **verbatim**, not paraphrased.
  For a staged proposal, the Source line is exactly
  `Source: docs/proposals/NNN-{kebab}.md (stage k/N — gate on completion: [one-line gate
  question])` — the sprint-close protocol greps this citation to detect stage completion.
  The sprint file is the executor's entire brief; a constraint that lives only in the
  source plan is invisible to it.
- **Deliverables** (execution order): Files (new|modified), Reference implementation,
  Interface contract (file:line where code exists), Setup, Changes, Acceptance criteria —
  each criterion classified **Automated** (the exact command that demonstrates the
  observable difference) or **Manual** (human-confirmed only; the executor reports but
  never checks it — see SPRINT_TEMPLATE). A criterion that can't name its command is
  Manual by definition.
  Mark each deliverable's dependency explicitly — "depends on #N" or "independent of
  all prior deliverables" (mandatory per the template comment; independence enables
  parallel dispatch within the sprint).
  Apply YAGNI — only the deliverables the plan actually needs (`docs/ENGINEERING_PRINCIPLES.md`).
- **Interface Contract** (Produces / Consumes): the cross-sprint signatures. For every
  `depends_on` edge, fill the dependent's **Consumes** and the blocker's **Produces** with the
  same agreed signature — this is what lets the two sprints run in parallel.
- **Technical Details**, **Dependencies**, **Testing** (test-first pattern reference),
  **Risks**, **Open Questions** — written **decision-ready**: each question carries 2–4
  concrete options with their implications, so a later planning pass or pre-sprint round
  can resolve it in one AskUserQuestion call.
- **Design checks (UI-scoped sprints only)**: apply `docs/sprints/design-checks.md` —
  its UI-scope test decides; no UI scope means skip entirely. For UI sprints, the
  interaction-states table goes into Technical Details, and unresolved design decisions
  become decision-ready Open Questions (they ride the batched question rounds — never a
  per-issue quiz).
- **Leave `plan_date: null`.** Batch breakdown is not per-sprint certification: it plans
  from the source document, not from a fresh read of every referenced `file:line`, so the
  sprints it creates stay "unplanned" until a per-sprint `/sprint plan` pass (or the wave
  planning pass) verifies them against the actual code. Exception: if you genuinely
  performed the full `/sprint plan` readiness checklist for a given sprint — verified
  every citation, resolved its Open Questions into Pre-Sprint Decisions — you may set its
  `plan_date`.
- **Full tier only** (if `scripts/sprint/claims.mjs` exists): populate `touches:` from the
  Files lists you just wrote, plus tokens from `scripts/sprint/claims-tokens.json` and likely
  doc-sync targets — `/sprint start` verifies rather than re-derives it.

**Full tier only — verify the parallel schedule** (only if `scripts/sprint/claims.mjs` exists):
after writing every sprint's `touches:`, run `node scripts/sprint/claims.mjs waves` and read the
wave assignment. If two sprints you intended to run in parallel land in different waves because
their claims overlap, re-cut the seam (or extract the shared file into a foundation sprint) and
re-run. The waves output is the ground truth for what can actually run concurrently.

If a breakdown surfaces a standalone architectural decision, offer to record it via
`/adr create`.

### Phase 4: Index Update + Parallelization Summary

Update `docs/sprints/INDEX.md` (full tier: run `node scripts/sprint/regen.mjs`, which also
regenerates the ROADMAP graph, critical path, and **Parallel Waves** block; lite: edit the
Backlog table by hand).

**Exit gate (blocking, before the commit)** — re-read what you generated:
- **Coverage map**: table mapping every source-plan requirement/task → the sprint ID
  that delivers it. An orphan requirement (no sprint) or ghost sprint (no requirement)
  blocks the commit — fix the cut, or record the deferral in `docs/TODOS.md`. Include
  the map in the Parallelization Summary.
- **Placeholder scan**: search the generated sprint bodies for hedges — "appropriate",
  "as needed", "handle errors properly", "similar to S-NNN". Each is a gap: fill it or
  shape it into a decision-ready Open Question.
- **Contract consistency**: every Consumes entry cites its dependency's Produces with
  the identical signature. Mismatch = fix before commit.
- **Proposal lints** (proposal sources only): no sprint delivers a declared Non-Goal; no
  sprint builds a distinctive feature of a rejected alternative; no sprint pre-builds a
  later stage (its gate exists so that plan is made with post-stage evidence). A hit is
  a cut or an explicit AskUserQuestion decision — never silently absorbed.

Report the gate explicitly: for each check, state what you examined and what you found —
a zero-findings check says so in one line ("coverage: 9/9 requirements mapped, no
orphans"), never a bare pass. An issue with an obvious fix is still an issue: fix it in
the sprint file before the commit, don't wave it through.

When the source is a proposal, include its status write-back in the same commit: flip
`**Status**: draft` → `active (stage k/N)` on first consumption (`1/1` for un-staged
proposals), and set the consumed stage's status line to `planned (S-{first}..S-{last})`
(staged proposals only).

**Plan record (durable).** When the source is a document (proposal or plan doc), append a
dated entry to its terminal `## Plan record` section (create the section at the end of the
file if absent) in the same commit:

- Heading: `### YYYY-MM-DD — stage k breakdown (S-{first}..S-{last})` (or `— recut …`,
  see Recut flow).
- The coverage map table from the exit gate (requirement/task → sprint ID).
- A scope-decisions table: `# | item | ACCEPTED / DEFERRED / CUT | one-line reasoning` —
  every Phase 2 scope-gate outcome, DEFERRED rows carrying their `docs/TODOS.md` backlink.
- Review inputs consumed (the report section's name, or "none").
- Last line, machine-checkable: exactly `NO UNRESOLVED DECISIONS`, or `UNRESOLVED
  DECISIONS:` followed by one bullet per open item (each also lives as a decision-ready
  Open Question in the sprint that owns it).

The conversation's Parallelization Summary is a view; this section is the record — the
proposal's gate flow and any later recut read it. Free-text sources get no plan record
(there is no document to carry it): the sprint files' Context sections are the only
durable record — say so in the summary.

Commit all new sprints + index:
`sprint: create S-{first}..S-{last} — [feature] (from /plan) [skip ci]`.
(Ledger-only commit — sprint files and index carry no code; burning a CI run
on it contradicts the push-batching policy.)
Full tier: make this commit on `main` under the lock (`scripts/sprint/lock.sh`).

Then **report a Parallelization Summary** to the user:
- **Full tier**: the waves from `node scripts/sprint/claims.mjs waves` (what is startable now in
  parallel, what each later wave unblocks) plus the critical path from `docs/sprints/ROADMAP.md`.
  Call out which Wave-1 members are tagged `⚠ unplanned` — `/sprint wave` will run a planning
  subagent over each before dispatching (or run `/sprint plan S-NNN` yourself first). Recommend
  **just-in-time planning**: certify a wave's members right before dispatching that wave, not all
  waves up front — freshly-verified references also avoid the cross-wave staleness that
  invalidates early-planned sprints. Mention `/sprint wave` can fan the first wave out to
  parallel agents.
- **Lite tier**: derive waves from `depends_on` AND module-level overlap of the sprints'
  Files lists (directory level, not file level — plans describe intent, so file-level is
  guesswork). Flag two same-wave sprints sharing a module directory as a merge-conflict
  risk: same lane (sequential) or re-cut the seam. Label the result "(dependency-only;
  file conflicts not checked in lite — upgrade to the full tier for claim-verified
  parallel safety)."

## Recut flow (`/plan recut <NNN | S-A S-B …>`)

For when execution invalidates the premises of **un-started backlog sprints** — a
mid-sprint stop-and-ask or a 2nd PLAN_GAP (full tier) revealed a wrong premise that spans
more than the current brief, a dependency landed differently than its Produces contract
promised, or the codebase moved under a long-lived backlog. PROTOCOL/ORCHESTRATION route
premise-level failures here; direction changes are NOT recuts — those go through
`/proposal` (a gate decision or a new proposal) and then a normal `/plan` pass.

1. **Structured mismatch first.** The recut's input is: **Expected** (what the plan
   assumed, with the sprint/plan citation) / **Found** (what the code or execution
   actually showed, `file:line` or landed-sprint evidence) / **Why it matters** (which
   backlog sprints' premises die). If the caller didn't provide all three, elicit them —
   a recut without a named mismatch is just second-guessing the plan.
2. **Scope guard.** Only `backlog/` sprints are recut — in-progress work is finished,
   descoped, or unstarted first (full tier: `unstart.sh`; never touch a sprint reserved
   by a live wave without releasing the reservation). Argument forms: a proposal number
   recuts that proposal's un-started sprints; an explicit `S-A S-B …` list recuts exactly
   those.
3. **Re-ground against current code** — the Phase 2 measure-before-cutting rule applies
   (Explore fan-out when the mismatch spans modules). Sort the in-scope sprints into
   *invalidated* (a premise the mismatch kills) and *intact* (untouched — leave them
   alone, including their S-NNNs and plan_date).
4. **Re-cut the invalidated set** per Phases 2–3 (scope-gate quick pass over the changed
   ground only; the Question protocol governs the boundary confirm). Replacements get
   fresh S-NNNs and `plan_date: null`; re-wire `depends_on`/`blocks` edges of intact
   sprints that referenced a rejected one — never leave dangling edges.
5. **Reject, don't delete.** Each invalidated sprint moves to `rejected/` per the
   `/sprint reject` procedure with reason
   `superseded by recut YYYY-MM-DD — [one-line mismatch]`, its INDEX row moved
   accordingly.
6. **Exit gate + record.** Run the Phase 4 exit gate over the recut subset (coverage map
   spans the replaced requirements). Append a `### YYYY-MM-DD — recut (S-A..S-B →
   S-X..S-Y)` entry to the source doc's `## Plan record`: the Expected/Found/Why
   mismatch, the rejected → replacement mapping, and the sentinel last line.
   Commit everything together:
   `sprint: recut S-X..S-Y — [reason] (from /plan recut) [skip ci]`
   (full tier: on `main` under the lock, like Phase 4).

## Arguments

- Number → proposal number (`docs/proposals/NNN-*.md`).
- Path → plan document.
- Text → feature description.
- `recut <NNN | S-A S-B …>` → Recut flow (above).
- None → `docs/execution-plan.md` if present, else ask.
