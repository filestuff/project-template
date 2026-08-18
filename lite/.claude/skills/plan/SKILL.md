---
name: plan
description: >
  Breaks a reviewed plan into sprint files with dependencies and story points. Invoke when
  asked to "break this down into sprints", "create sprints from the plan", "convert to
  sprints", or "seed the backlog".
argument-hint: "[feature description | proposal number | plan document path]"
allowed-tools: "Read Edit Write Glob Grep Bash AskUserQuestion Skill"
---

# Plan Breakdown Skill

Takes a reviewed plan and breaks it into sprint files in `docs/sprints/backlog/`.

## Boundaries

In scope: breaking a reviewed plan into backlog sprint files. Out of scope: plan reviews
(those run separately first if used), per-sprint certification (`/sprint plan` — this skill
leaves `plan_date: null`), starting execution (`/sprint start`). Null result: if the plan
genuinely fits one sprint, create one sprint and say so — do not manufacture a multi-sprint
split.

## Pipeline

### Phase 1: Context Gathering

1. Read `docs/sprints/INDEX.md` for current state and existing dependency chains (find the
   highest existing S-NNN).
2. Read the plan source:
   - A path → that document.
   - A number → treat as a proposal: read `docs/proposals/NNN-*.md`.
   - Free text → treat as a feature description; supplement from existing planning docs.
   - No argument → if `docs/execution-plan.md` exists, default to it; otherwise ask the user
     what to break down.
3. If a plan-review output is in the conversation, fold it in. If the user implies a review
   exists but none is visible, ask them to paste/summarize it.
4. Read the design-system doc (if one exists) when the work is UI/visual.

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
   ask whether to merge/split/reorder. A breakdown of more than ~10 sprints is a scope
   smell — offer a phased split (a ship-first tranche now; later tranches seeded as
   backlog with `depends_on`).
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
  `depends_on`, `blocks`, `tags`, `story_points`.
- **Context** (top of body): the source plan's path + this sprint's originating task
  IDs, and every global constraint from the source plan that binds this sprint (stack
  pins, perf budgets, compatibility promises) — copied **verbatim**, not paraphrased.
  The sprint file is the executor's entire brief; a constraint that lives only in the
  source plan is invisible to it.
- **Deliverables** (execution order): Files (new|modified), Reference implementation,
  Interface contract (file:line where code exists), Setup, Changes, Acceptance criteria.
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

## Arguments

- Number → proposal number (`docs/proposals/NNN-*.md`).
- Path → plan document.
- Text → feature description.
- None → `docs/execution-plan.md` if present, else ask.
