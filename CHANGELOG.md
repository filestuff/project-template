# Changelog

All notable changes to the project-template payload. Downstream repos read these
entries during `/template-upgrade` — write every bullet for the person running a
repo that installed this template, not for template maintainers.

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
