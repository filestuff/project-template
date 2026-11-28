# Sprint File Guide

The rules for filling `docs/sprints/SPRINT_TEMPLATE.md`. Each `<!-- guide: §X -->` line in
the template points to the `## X` section below.

The template holds structure only. Rules live here, so a generated sprint file stays all
signal: it is the executor's **entire brief** and, later, the durable **completion record**.
`/plan`, `/sprint create`, the planner and every other writer **delete the
`<!-- guide: … -->` lines** when they create a sprint file.

**Older files:** sprint files written before template 1.17.0 keep their original sections:
`## Testing`, the Technical Details file tables, `## Dependencies`, and a
`<!-- PLAN NOTES -->` comment. Readers accept both shapes. Nobody rewrites old files to the
new one.

## Brief vs record

A single `---` rule, after Production notes, divides the file.

- **Above it is the brief:** Context through Production notes.
- **Below it is the record:** Execution Notes and the Completion Log.
- **Once `plan_date` is set, the brief is fixed.**
  - Execution writes only five things: criterion checkboxes, `- Evidence:` lines,
    `## Execution Notes`, in-flight Pre-Sprint Decisions entries, and the Completion Log.
  - Execution never rewords a deliverable or an acceptance criterion to fit what was built.
    A brief that turns out wrong is either a **Deviation**, recorded under Completion Log →
    Deviations from brief, or a **PLAN_GAP / stop-and-ask** (PROTOCOL Phase 2).
  - A criterion that no longer applies is descoped with its reason, never deleted.
- **Planners** (`/sprint plan`, the wave planning pass) may edit the brief until they set
  `plan_date`. A recut (`/plan recut`) replaces un-started briefs outright.

## Frontmatter

- **`tags:`** are freeform. Starter set: frontend, backend, database, infra, security,
  design, devops. Add a new tag only when it is clearly distinct from existing ones. Keep
  the tag→doc table in PROTOCOL.md in sync with the tags actually used.
- **`touches:`** is the file-claims manifest. **Full tier only**; lite ignores it.
  - `/sprint plan` fills it from the deliverables' `Files:` lists using exact paths,
    `dir/**` prefixes, or tokens from `scripts/sprint/claims-tokens.json`.
  - `/sprint start` re-derives or verifies it and checks for overlap with in-flight sprints.
- **`plan_date:`** is set ONLY by `/sprint plan` (or the wave planning pass), after its
  readiness checklist passes. It is never set by hand and never at creation.
  - `null` means unplanned: `/sprint start` warns, and `/sprint wave` runs a planning
    subagent over the sprint before dispatching it.
  - A `plan_date` older than a dependency's `end_date` shows as "stale plan" in the waves
    output. The plan's `file:line` premises predate landed work and need re-verification.
- **`risk:`** is `low` or `high`. `/plan` sets it; `/sprint plan` may raise it but never
  lowers it.
  - `high` means the sprint touches a surface in the risk-tier table of
    `docs/sprints/review-calibration.md`: auth/permissions, schema/migrations, public or
    cross-sprint contracts, secrets, payment or irreversible mutation, or trust-boundary
    parsing.
  - `high` makes `## Production notes` mandatory and deepens the review.
- **`tier:`** is `routine`, `standard`, `complex` or `critical`. It measures how HARD the
  work is: not how big, and not how risky (`risk: high` never sets the tier). It decides
  which model, at what reasoning effort, executes and reviews the sprint.
  `docs/sprints/tier-rubric.md` is the rule.
  - `/plan` sets a provisional `standard` or `complex`.
  - The PLANNER assigns the real tier at certification and writes **`tier_reason:`**: one
    line naming the signal that decided it, for example
    `follows src/routes/users.ts:12-40 — same handler shape` or
    `new retry state machine across two services`. Keep `#` out of it, because the
    frontmatter parser treats ` #` as a comment.
  - `routine` requires every criterion in the rubric. Anything above `standard` requires a
    rubric signal the brief shows. If unsure, use `standard`.
  - After the sprint starts, the tier only goes up (ESCALATE).
  - A file with none of these keys (pre-1.11 sprints) is read as `risk: low`,
    `tier: standard`.
- **`outcome:`** is NOT in the template. The orchestrator writes it when a wave or train
  lands the sprint: assigned and final tier, escalations, fix rounds, findings.
  `scripts/sprint/tiers.mjs` reads it to calibrate the rubric. Never set it by hand.
- **`summary:`** is the sprint's one-sentence row in the Done ledger (≤200 chars,
  double-quoted so a `#` survives). It is written at close, after `### Outcome`, and
  `close-check.mjs` blocks the close without it. `scripts/sprint/ledger.mjs` renders it
  into INDEX.md's Recently done table and the sprint's `done/<bucket>/LEDGER.md`. Nobody
  writes Done rows by hand.
- **`proposal:` / `stage:`** are informational backlinks that scripts ignore. `/plan` sets
  them when the source is a proposal: `proposal: NNN`, `stage: k`, with `stage: 1` for
  un-staged proposals. Sprint close (PROTOCOL Step 3.6) uses them, together with the
  Context Source citation, to detect when a proposal stage's last sprint lands.

## Context

Written by `/plan`, or by hand for standalone sprints. It answers why, from where, and
under which constraints, before anything about how.

- **Why:** two or three sentences. Say what problem this solves, what prompted it, and what
  the user can do afterwards that they cannot do now. `goal:` says what done looks like;
  Why says why done matters, so the executor can make judgment calls the brief did not
  anticipate.
- **Source:** the source plan's path plus the originating task IDs, or `— none` for a
  standalone sprint.
  - For a proposal, write the citation form exactly:
    `docs/proposals/NNN-{kebab}.md (stage k/N — gate on completion: [one-line gate question])`.
  - Sprint close greps this line to detect stage completion.
- **Binding constraints:** the source plan's GLOBAL constraints that bind this sprint, such
  as stack pins, performance budgets and compatibility promises. Copy them **verbatim**;
  do not paraphrase. A constraint that lives only in the source plan is invisible to the
  executor.
- **Prerequisites:** external services, API keys, infrastructure, or accounts needed
  before work starts, or `— none`. Sprint-to-sprint ordering lives in
  `depends_on` / `blocks`, not here.

## Open Questions

Non-obvious decisions, written DECISION-READY:

- Each question carries 2–4 concrete options with their plan and touches implications.
- Each question has a recommended option with a one-line why.
- Each question states the stake if the choice is wrong.

They are resolved during `/sprint plan`, which is preferred because the planner has the
most context, or in the pre-sprint AskUserQuestion round. Every answer moves to Pre-Sprint
Decisions and the item is checked off.

An unresolved question without concrete options blocks `plan_date`: the sprint is not
implementation-ready while an open decision has no shaped choices. Write `— none` when
there are none.

The section sits at the top on purpose. It is the first thing a reviewer of an unplanned
brief should see.

## Pre-Sprint Decisions

Binding decisions carried into execution. The sprint file is the executor's entire brief,
so an answer that lives only in a conversation is invisible to it.

- **Who appends:** `/sprint plan`, the wave planning pass, the Phase 1 tradeoff round, and
  the in-flight decisions execution records (the arbiter's RECORD lines, and the
  executor's `(wave, mechanical, agent)` and `(wave, in-flight)` entries).
- **Grammar** (`docs/DECISION_POLICY.md`; listed by `scripts/sprint/decisions.mjs`):
  `- YYYY-MM-DD (<mode>, <mechanical|taste|reserved>, <agent|arbiter|orchestrator|user>):
  <decision> — principle: <which> — rejected: <option> — undo: <how>`
- **Execution treats these as settled.** Do not re-litigate them mid-sprint.

## Deliverables

Deliverables are numbered in execution order. Fields:

- **Files:** exact paths marked `(new | modified | deleted)`. This is the ONE place a
  sprint names its files. `touches:` is derived from it, and there is no separate file
  table.
- **Reference:** the most similar existing file. Follow it for code style, error handling
  and structure, and reuse what it already provides.
- **Interface:** the contract this code must satisfy, as `Symbol` from `path:L##-L##`.
- **Setup:** install commands, environment variables, or config needed first. Omit the
  field when there are none.
- **Changes:** what exactly must happen. It must be executable as written: "appropriate
  error handling", "as needed" and "similar to #N" are gaps, not instructions.

**Dependency marking is MANDATORY.** Each deliverable's Changes text states either
"depends on #N" or "independent of all prior deliverables". Independence is what lets a
subagent-driven executor dispatch deliverables in parallel (PROTOCOL Phase 2). An unmarked
deliverable is treated as depending on its predecessor.

### Acceptance criteria

Every criterion is classified **Automated** or **Manual**. Omit whichever list is empty.

- **Automated:** the exact runnable command plus the observable difference it
  demonstrates. The executor checks the box only by citing that command's output.
- **Manual:** verifiable only by a human, for example a visual check, real-device feel, or
  a third-party dashboard. The executor REPORTS what to check and never checks the box. The
  user confirms it at sprint close (PROTOCOL Phase 3 Step 1).
- A criterion that cannot name its command is Manual by definition.

### Evidence grammar

`scripts/sprint/close-check.mjs` lints these lines at close, in Deliverables and in
Verification.

- **Checked Automated criterion:** it is followed by an indented line, written in the same
  edit as the `[x]`:
  `- Evidence: <test name | file:line | \`cmd\` → output tail | docs/sprints/evidence/S-NNN/…>`
- **Criterion left unchecked at close:** the line ends `— descoped: <why> (TODOS #N)`.
- **Manual criterion:** only the user checks it, and the line ends `— confirmed YYYY-MM-DD`.

Evidence lives in THIS file. Artifacts too big for a line go under
`docs/sprints/evidence/S-NNN/`. Evidence never lives in the conversation or in the
gitignored wave ledger.

## Out of Scope

List what this sprint explicitly does NOT do. Each item is deferred to `docs/TODOS.md`
with a backlink, or marked as a permanent non-goal.

## Interface Contract

The contracts that cross sprint boundaries. Filling them lets a dependent sprint be built
IN PARALLEL against an agreed signature instead of waiting for this sprint to land. The
full tier surfaces the resulting waves in ROADMAP.md.

- **Produces:** signatures, types, endpoints and schemas this sprint creates that other
  sprints (its `blocks:`) may code against. Name each with `file:symbol`.
- **Consumes:** contracts this sprint relies on from its `depends_on:` sprints, written
  `X from S-NNN — path: signature`. Code against these agreed signatures; the blocker does
  not need to be merged yet. `plan-check.mjs` verifies each against the dependency's
  Produces.
- Write `— none` under a heading when the sprint neither exposes nor consumes a
  cross-sprint contract.

## Technical Details

Optional. Delete the whole section when neither subsection applies.

- **Schema / Data-Model Changes:** the migration or schema change. In the full tier, claim
  the `schema` token.
- **Design notes:** UI-scoped sprints only. This holds the interaction-states table from
  `docs/sprints/design-checks.md`, and any design detail that is not a deliverable's
  Changes text.

## Verification

How to see the whole sprint working, not just each deliverable.

- **Test pattern:** the existing test file to follow for mocking approach and assertions.
  If test-first doesn't fit (exploratory spike, pure config, visual/UI), say so and say how
  the work is verified instead.
  - Test-first itself (RED → GREEN → REFACTOR) is a PROTOCOL Phase 2 rule, not a checklist
    here. Avoid the traps in `docs/sprints/testing-anti-patterns.md`.
- **End-to-end:** one or two criteria that prove the frontmatter `goal:` as a user would
  see it.
  - Examples: a command run against the integrated result, a request with its response, or
    a screen to look at.
  - They use the same Automated/Manual classification and Evidence grammar as deliverable
    criteria, and `close-check.mjs` lints them the same way.
  - Unlike a deliverable criterion, they test the deliverables together, so a sprint whose
    parts each pass but whose goal does not hold cannot close.

## Risks

Write a `Risk | Mitigation` row per real risk. Delete the section when there are none.

In the full tier, an acknowledged claim overlap at `/sprint start` is recorded here in
both sprints' files.

## Production notes

MANDATORY when frontmatter has `risk: high`. Otherwise delete the section. The executor
treats these lines as binding.

Each line is a concrete answer, or `n/a — [why]`. A bare "n/a" fails `plan-check.mjs`.

- **Rollback:** how the change is undone after it lands (flag, revert, down-migration), and
  what undoing it loses.
- **Observability:** the log line, metric or alert that shows it working, and the one that
  shows it failing.
- **Security:** the trust boundary or permission this touches, and what enforces it.

## Execution Notes

The running log of what the brief did not say. Each line:

`- YYYY-MM-DD [plan|exec]: <finding>`

Use square brackets, not parentheses, so `decisions.mjs` does not read these lines as
decisions.

- **`[plan]`:** the planner's findings, such as doc drift found in the tag-scoped read
  (the executor applies the fix on its branch) and premises it re-verified.
- **`[exec]`:** trivial drift the executor located and proceeded past (a symbol moved
  lines), surprises, and anything a later reader of the code would ask "why?" about.
- **Not for decisions** (they go in Pre-Sprint Decisions) and **not for evidence** (it goes
  in Evidence lines).
- **At close,** Completion Log → Deviations from brief summarizes whatever here changed
  what was built.
- **Leave `_(none yet)_` while empty.** No lint reads this section.

## Completion Log

Written INTO this file by whoever executes, the solo session or the sprint-executor,
before close, and committed as `S-NNN: completion log`.

This file is the durable record. The conversation is not, and neither is the wave ledger
(`.claude/sprint-orchestration/` is gitignored). `node scripts/sprint/close-check.mjs
<file>` lints it and blocks land:

- Every Automated criterion is `[x]` plus `- Evidence:`, or `— descoped: …`.
- Every Manual criterion is user-confirmed or descoped.
- Every subsection is filled, or `— none`.
- Every checklist row carries an annotation.

The subsection titles are exact and linted, so never rename them.

- **Outcome:** 2–4 sentences on what actually shipped, what changed for the user, and what
  surprised you. It is the narrative; the frontmatter `summary:` is its ONE-sentence
  version, the row the Done ledger shows.
- **Commits:**
  - Full tier: `merge-sprint.sh land` replaces `_(stamped at land)_` with the `S-NNN:`
    deliverable commits plus the merge SHA.
  - Lite: paste `git log --reverse --oneline <start-sha>..HEAD --grep '^S-NNN:'`, where
    start-sha is the `sprint: start S-NNN` commit.
- **Review:** findings by severity, each with its disposition:
  `Critical/Important/Minor: <finding> — fixed <sha>` or `— declined: <why>`. Otherwise
  write the literal `— not run: low risk (Step 3.5)`.
- **Deviations from brief:** what was built differently from the deliverable text, and
  why. Summarize the Execution Notes that changed the build. Write `— none` if nothing did.
- **Deferred:** one `TODOS #N — <item>` per line, or `— none`.
- **Learnings:** each line is
  `- YYYY-MM-DD S-NNN <plan|test|review|design|exec>: <what happened> → rule: <one line>`,
  or `— none`.
  - It uses the same grammar as `docs/sprints/PLANNING_LEARNINGS.md`.
  - A `plan`-class line that would have changed another sprint's brief is also prepended
    there.
- **Close checklist:** every row is `- [x] <label> — <annotation>`. A bare
  "done"/"yes"/"ok" fails the lint, and `n/a` and `descoped` need `: reason`.
