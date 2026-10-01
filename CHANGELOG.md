# Changelog

All notable changes to the project-template payload. Downstream repos read these
entries during `/template-upgrade` — write every bullet for the person running a
repo that installed this template, not for template maintainers.

## [1.11.0] - 2026-10-01

**Push safety, fail-closed CI verification, and an opt-in shared-install worktree mode**,
backported from a month of production wave use in ai-todo (the repo this template was
extracted from). The common thread: local `main` is shared by every session in a checkout,
and the 1.10.0 scripts pushed whatever it held. Measured downstream: a wave-start reservation
push carried 26 of another wave's held code commits past that wave's deploy gate; three
earlier pushes did the same because `push-main.sh` only reported what it had pushed
*afterwards*; and a code push read "all green" after 91 s because the CI check counted a
run that had not started yet as "not applicable". No migrations. New per-project config
files are **seeded**, which `/template-upgrade` never adds — see Upgrade notes.

- **`push-main.sh` classifies before it pushes (full).** The unpushed range is grouped by
  the sprint id in each commit subject (`S-NNN: …`, `<type>(S-NNN): …`,
  `<type>(S-NNN)!: …`, `sprint: <verb> S-NNN …`; anything else is `(unattributed)`) and each
  group is printed as doc-only or code. New `--expect <ids>`: a code group you didn't list is
  FOREIGN and the push is **refused with exit 2** (nothing pushed, nothing committed), with
  the `--allow-foreign` re-run command printed for after the user confirms. Every workflow
  call site (solo close, wave P2/P3, train checkpoints, abandon) now passes `--expect`.
  Without the flag it classifies and pushes as before; an empty `--expect ""` (an unset
  variable) is an error (exit 1), never a silent bypass, and an unreachable origin is exit 1
  rather than "no remote branch yet". After a code-bearing push it prints
  the exact `verify-ci.sh <sha> --base <old>` command to run.
- **`push-main.sh` skip-CI guard fixed.** The empty "force CI" commit it adds when a
  `[skip ci]` HEAD would hide a code push was written to *whatever branch was checked out*,
  not `main`. It is now built with `commit-tree` + `update-ref` on `main`, and runs only after
  the `--expect` check passes (a refused push no longer leaves a stray `ci:` commit).
- **New `ledger-push.sh` — bookkeeping pushes are ledger-only or nothing (full).**
  `start.sh`, `unstart.sh`, `reserve-wave.sh` and `claims.mjs add` no longer run a raw
  `git push`. If any unpushed commit touches a path outside `docs/`/`.claude/` (merges diffed
  against their first parent), nothing is pushed, the code-bearing commits are listed with
  the `push-main.sh --expect <their ids>` their owner settles with, and the caller exits
  **3 — "committed locally, push withheld"**. Exit 3 is not a failure (the transaction
  committed; create the worktree / proceed with the wave), and is distinct from exit 2
  (rolled back). A self-test sentinel fails if any sprint script other than `push-main.sh`
  and `ledger-push.sh` contains a raw `push origin`.
- **`merge-sprint.sh finish` never pushes, in any mode (full).** Solo `finish` used to push
  all of local `main` by default. The deferral line now names
  `push-main.sh --expect <roster>`; `--no-push` is still accepted (no-op for `finish`; it
  still skips `prepare`'s pull). New `merge-sprint.sh --self-test`.
- **`merge-sprint.sh land` train-mode stamping fixed.** With `--sprints S-A,S-B`, every
  member's `### Commits` was stamped with the *last* member's commits (and an
  `--allow-incomplete` note landed in the wrong file) — a stale loop variable.
- **New `verify-ci.sh` — CI verification that fails closed (full).**
  `verify-ci.sh <sha> --base <pre-push origin tip>` waits for each required workflow listed
  in the new seeded `scripts/sprint/ci-gates.json` (`workflows: [{name, file}]`, optional
  `deployEnvironment` checked through GitHub's deployments API, `timeoutSeconds`,
  `graceSeconds`). Exit **0** green or provably not triggered (it reads each workflow's
  `on.push.paths` at the pushed SHA and diffs against `--base`); **1** red; **2 not
  verifiable — never green**: an expected run that never appeared within the grace period, a
  `gh` error, cancelled, timeout, or missing config. Omitting `--base` makes every gate
  expected. `SKIP_CI_VERIFY=1` now requires `SKIP_CI_VERIFY_REASON`. PROTOCOL Phase 3 Step 6
  (full) calls it instead of an ad-hoc `gh run list`; the lite Step 6 gains the same
  fail-closed rule in prose.
- **Claims: unknown tokens fail loud; reserved sprints keep Wave 1 (full).** A token-shaped
  claim (`word` / `word:word`) that is neither in `claims-tokens.json` nor an existing
  root file/dir used to become an exact-path claim that overlapped nothing; `claims.mjs
  check`/`add`/`waves` — and therefore `start.sh`/`reserve-wave.sh` — now exit 2 naming it
  (and say so when `claims-tokens.json` is missing). `regen.mjs` reports it with exit 2
  instead of a stack trace. `claims.mjs waves` now pins in-progress and wave-reserved
  sprints to Wave 1 instead of letting a lower-id backlog sprint displace them (which
  advertised starts `start.sh` would refuse). The CLI also works when invoked through a
  symlinked path (macOS `/var` vs `/private/var`).
- **New `check-ledger-links.mjs` (full).** Relinks INDEX `(done/…)` links orphaned by archive
  rotation; `--check` (also run by `regen.mjs --check`) flags unresolved links and duplicate
  TODOS ids. Exit 2 while issues remain.
- **Worktree setup is a script; optional shared-install "link mode" (full).** New
  `worktree-link.sh setup|teardown <worktree>` driven by the seeded
  `scripts/sprint/worktree-links.json`. Default **install mode** (`links: []`): setup copies
  the listed `envFiles` (replacing "copy `.env` — match whatever the project uses") and you
  install as before. **Link mode** (for large monorepos): every worktree symlinks the primary
  checkout's dependency dirs; setup parks a worktree's own real install aside so there is one
  store, keeps `keepIfReal` generated dirs, refuses foreign links; teardown restores and
  exits 1 if any primary link still points into the worktree — run it before
  `git worktree remove`. New `worktree-guard.sh` detects any linked worktree; two new
  placeholders, `{{WORKTREE_GATE_COMMANDS}}` / `{{WORKTREE_PREPUSH_GATE_COMMANDS}}`, give
  `gate.sh` / `pre-push-gate.sh` a reduced, package-manager-free gate inside a linked
  worktree. Blank (the default, and always in lite) = the normal gate everywhere — except
  that in link mode a blank reduced command makes the gate **fail** inside a linked worktree
  rather than run the package manager there. Setup/teardown refuse overlapping `links`
  entries and any path whose parent resolves outside the worktree.
- **`start.sh` / `unstart.sh` SIGPIPE false-FATAL fixed.** `git show … | grep -q` under
  `pipefail` reported a failed frontmatter check on sprint files larger than a pipe buffer.
- **`close-check.mjs` (lite + full):** a Manual criterion's `confirmed` now matches
  case-insensitively (`Confirmed`, `CONFIRMED`).
- **Executor reviewer child runs in the foreground.** `sprint-executor` and the
  ORCHESTRATION dispatch prompt now require `run_in_background: false` for the pre-completion
  `reviewer` child: a background child that finishes after the executor's turn ends reports
  to the orchestrator, and the sprint stalls.
- **Docs (full):** a "Worktree toolchain" subsection (install vs link mode rules); PROTOCOL
  Step 3.8 — if a sprint touches the end-to-end suite, run it before the code-bearing push
  and record pass/fail/skip *counts*, not the exit code; ORCHESTRATION Step 6 "wave-end
  checks on merged `main`" (repo-wide guard tests and the e2e suite run once there before
  P3 — a sprint worktree cannot see a sibling's files); failure-handling rows for exit 3 and
  FOREIGN exit 2.
- **Tests:** new `test-push-main.sh`, `test-ledger-push.sh`, `test-merge-sprint-finish.sh`,
  `test-merge-sprint-train-land.sh`, `test-verify-ci.sh` (skips without `jq`),
  `test-claims.mjs`, `test-check-ledger-links.sh`, `test-worktree-guard.sh`,
  `test-worktree-link.sh`; `test-close-check.mjs` gains the case-insensitive case. Each new
  script also has a `--self-test`.

**Upgrade notes.**
- Expect three-way conflicts in `push-main.sh`, `merge-sprint.sh`, `start.sh`, `unstart.sh`,
  `reserve-wave.sh`, `claims.mjs`, `gate.sh` and `pre-push-gate.sh` if you customized them.
  Keep the template's push paths: any remaining raw `git push origin` fails the ledger-push
  sentinel.
- `/template-upgrade` will prompt for the two new worktree-gate placeholders — answer blank
  unless you use link mode.
- **Create the seeded configs by hand** (upgrades never add seeded files):
  `scripts/sprint/ci-gates.json` — e.g.
  `{"workflows": [{"name": "CI", "file": "ci.yml"}], "deployEnvironment": null,
  "timeoutSeconds": 1800, "graceSeconds": 300}` — without it `verify-ci.sh` exits 2
  ("not configured"); and `scripts/sprint/worktree-links.json` —
  `{"links": [], "envFiles": [".env"], "keepIfReal": [], "scanExclude": []}` (it is optional;
  missing = install mode with no env files copied).
- `verify-ci.sh` needs `gh` (authenticated) and `jq`; `worktree-link.sh` needs `node`.
- **Audit `touches:` after upgrading:** a backlog or in-progress sprint whose `touches:`
  names a bare token that is not in `claims-tokens.json` (and not a root file/dir) now makes
  `regen.mjs`, `claims.mjs waves` and `start.sh` exit 2. Run `node scripts/sprint/claims.mjs
  waves` once; define the token or fix the claim it names.
- Commits made directly on `main` to fix a red wave/train push must carry the sprint id
  (`fix(S-NNN): …`) — `push-main.sh --expect` treats an untagged code commit as foreign.
- Update any project-local docs or scripts that call `merge-sprint.sh finish` expecting a
  push, or `push-main.sh` without `--expect`.

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
