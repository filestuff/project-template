# Sprint Execution Protocol

This document defines the autonomous sprint lifecycle that Claude Code follows when executing
sprints in {{PROJECT_NAME}}. It covers pre-sprint validation, execution, and post-sprint
cleanup. The `/sprint` skill defers to this file — it is the source of truth.

Sprint files live in `docs/sprints/` with four directories: `backlog/`, `in-progress/`,
`done/`, `rejected/`. The commit gate is `scripts/sprint/gate.sh` — the **single source of
truth** for what must pass before every deliverable commit; no other doc restates the
commands.

> "main" below means the project's default branch. If it isn't literally `main`, set
> `SPRINT_MAIN_BRANCH` in `.claude/settings.json` `env` — the helper scripts read it.

---

## Parallel Sprints: ledger on main, work on branches

Multiple agents may run sprints concurrently. Agents cannot talk to each other — they
coordinate exclusively through `main`, which is the **lifecycle ledger**. Five invariants:

1. **Lifecycle state lives on `main`; deliverable work lives on the sprint branch.**
   Sprint-start and sprint-completion are commits on `main`, executed in the primary checkout
   by the helper scripts (`scripts/sprint/`), serialized by the sprint-main lock. `main`'s
   `docs/sprints/in-progress/` is always the authoritative list of in-flight sprints and the
   files they claim.
2. **One git worktree + branch per sprint** (Phase 1 Step 4, mandatory), branched from the
   `main` tip that contains the sprint's own start commit. The branch name claims the
   *sprint* (`git worktree add -b S-NNN-…` fails if it exists — another agent owns it; stop
   and ask). The `touches:` frontmatter list claims *files* (spec below).
3. **Sprint branches never touch** `docs/sprints/INDEX.md`, `docs/sprints/ROADMAP.md`, or
   `docs/DOC_HEALTH.md`, and never move files between `docs/sprints/*` directories. The
   branch edits its own sprint file **in place** in `in-progress/` (checking off
   deliverables, mirroring claim expansions); `main` — under lock — performs both file moves
   and the `status:`/date flips. With a single writer for the generated docs, that conflict
   class is gone.
4. **The primary checkout is the lifecycle ledger**: parked on `main`, never carrying
   in-flight deliverable work, mutated only by lock-serialized transactions that each end in
   a commit leaving it clean (untracked junk is tolerated; scripts stage explicit paths only).
5. **Every mutation of `main` goes through the lock** (`scripts/sprint/lock.sh`): start
   transactions, claim expansions, completion merges, wave reservations, and
   `/sprint create`/`plan` commits made from the primary checkout.

A sixth coordination fact exists for concurrent waves: a **wave reservation** — a
`wave: W-<id>` frontmatter field on a *backlog* sprint, written by
`scripts/sprint/reserve-wave.sh` (locked). It is a scheduling claim: the sprint belongs to
one session's wave roster, and its `touches:` are held as if in-flight, so another wave can
neither take the sprint nor claim overlapping files. `start.sh` refuses a sprint reserved by
a different wave (pass `--wave W-<id>` for your own); `unstart.sh` clears the field. See
`ORCHESTRATION.md` "Running waves from multiple sessions".

Chains that *cannot* parallelize (each member depends on the previous, or their `touches:`
overlap) have their own orchestration mode: the **serial train** (`/sprint train`) — one
long-lived worktree/branch for the whole chain, landings batched every few sprints into one
merge + one CI push. See `ORCHESTRATION.md` "The serial train".

### File claims (`touches:`)

Each in-flight sprint declares the files it expects to modify in its frontmatter:

```yaml
touches:
  - src/components/SideNav.tsx        # exact file
  - src/app/mail/**                   # subtree claim (this prefix, recursive)
  - schema                            # token — defined in scripts/sprint/claims-tokens.json
  - deps                              # token — dependency manifest + lockfile
```

- **Grammar** (deliberately small): an exact repo-relative path, a directory prefix ending in
  `/**`, or a token. No mid-path wildcards. Tokens are defined in
  `scripts/sprint/claims-tokens.json` — keep a `deps` token (the lockfile is the classic
  hidden conflict) and a `schema` token if the project has one (two parallel migrations
  conflict structurally even in different files).
- **What to claim:** files the sprint will *modify*, plus its likely doc-sync targets.
  Always exempt: the sprint's own file, its own `docs/sprints/evidence/S-NNN/` directory,
  and the three generated docs.
- Claims are **advisory but protocol-enforced**: nothing technically blocks an edit — the
  Phase 2 claims-discipline rule is the enforcement, and `claims.mjs check` makes compliance
  a one-command habit.
- **Claim holders** are the in-flight sprints (`in-progress/`) *plus* any backlog sprints
  reserved by a live wave (`wave:` set) — `claims.mjs check`/`add` treat both as conflicts,
  so a reservation protects files another wave has planned against but not yet started.

### The sprint-main lock

`scripts/sprint/lock.sh` — a `mkdir`-atomic directory at `.git/sprint-main.lock` (the common
git dir, so all worktrees resolve to the same lock). `acquire` waits up to 5 minutes, then
exits 75 with the holder's info (label, worktree, age) — show it to the user and ask.
`status` flags locks older than 60 minutes as probably stale (sized to survive a build-gate
re-run during a completion). **Never steal silently**: show `lock.sh status` to the user,
get confirmation, then `lock.sh steal --force` — it prints the recovery checklist (restore
the lifecycle paths if a transaction died mid-flight; abort any in-progress merge).

Two guarantees the scripts already enforce, stated for multi-session operation: every locked
transaction **pulls `--ff-only` before mutating and pushes before releasing the lock** —
commit + push form one critical section, so two sessions cannot race pushes to `main` —
unless the caller defers (`--no-push` — the wave orchestrator's mode, and now the rule for
`finish` in **every** mode: the code-bearing completion push settles after the lock via the
deploy gate + `scripts/sprint/push-main.sh`, which takes the lock itself; see ORCHESTRATION
"Push policy"); and a failed push leaves
the local commit intact with printed recovery instructions. When another session's wave is
live, pass `--wait 900` to `start.sh` and `merge-sprint.sh prepare` — the other wave's
completion legitimately holds the lock across its prepare→land→finish window.

---

## Phase 1: Pre-Sprint

**Trigger**: User says "start S-NNN" or "work on S-NNN"

### Step 1: Parse Sprint Frontmatter

Read the sprint file and extract YAML frontmatter: `sprint`, `status`, `goal`, `depends_on`,
`blocks`, `tags`, `story_points`, `plan_date`.

If `plan_date` is null the sprint was never certified implementation-ready by `/sprint plan` —
warn (a solo start may proceed after asking; `/sprint wave` instead runs a planning pass over
such sprints before dispatch, see `ORCHESTRATION.md`). If `plan_date` predates a dependency's
`end_date` (the waves output tags this `⚠ stale plan`), the plan's `file:line` premises may
cite code that landed work has since moved — re-verify them before trusting the brief.

### Step 2: Dependency Check

For each sprint in `depends_on` (dirs checked: `done/` + `done/archive/`, then `in-progress/`,
then `backlog/` — all on `main`, which shows in-flight sprints):
- If `status: done` → pass.
- If `status: in-progress` → another agent is flying it right now. **Warn via AskUserQuestion**:
  - A: "Wait for / coordinate with the in-flight sprint"
  - B: "Proceed anyway (dependency not met)"
  - C: "Remove this dependency (resolved or no longer relevant)"
- If in `backlog/` → **warn via AskUserQuestion**:
  - A: "Proceed anyway (dependency not met)"
  - B: "Start [blocking sprint] first"
  - C: "Remove this dependency (resolved or no longer relevant)"

Do NOT silently skip unmet dependencies.

### Step 3: Derive Claims + Run the Locked Start Transaction

1. **Derive `touches:`** from the sprint file's per-deliverable `Files:` lists plus the
   doc-sync targets it will plausibly update (Phase 3 Step 2 table). Sprints adding
   migrations claim the `schema` token; sprints adding packages claim `deps`. If
   `/sprint plan` already populated `touches:`, verify it against the deliverables instead
   of re-deriving.
2. **Overlap check** (read-only, no lock):
   `node <repo-root>/scripts/sprint/claims.mjs check --paths <p1,p2,…> --sprint S-NNN`.
   On exit 2, **stop and ask** with the printed overlap pairs; options:
   - A: "Wait for the overlapping sprint to land"
   - B: "Re-scope this sprint's claims (drop/narrow the overlapping paths)"
   - C: "Proceed with acknowledged overlap" — record the overlap in **both** sprint files'
     Risks sections; the second sprint to land owns the conflict resolution at its `prepare`.
3. **Start transaction**: `<repo-root>/scripts/sprint/start.sh S-NNN --touches "<p1,p2,…>"`.
   Under the lock it re-checks claims, moves `backlog/ → in-progress/`, sets
   `status: in-progress` / `start_date` / `touches:`, regenerates the INDEX/ROADMAP blocks,
   commits `sprint: start S-NNN — [name]` **on `main`**, verifies the committed frontmatter
   survived, and pushes. It prints the new `main` SHA — the worktree branches from it. In wave
   mode the orchestrator passes `--no-push`, deferring this push to the wave's checkpoint
   push (`scripts/sprint/push-main.sh`; see ORCHESTRATION "Push policy") — solo starts always
   push immediately.

   The inverse exists: `scripts/sprint/unstart.sh S-NNN` is the **only** sanctioned way to
   move an in-flight sprint back to `backlog/` (locked; refuses if the branch carries
   deliverable commits; keeps `plan_date`/`touches:`/decisions). Never hand-roll an unstart.

### Step 4: Create the Sprint Worktree (mandatory)

1. Derive the branch/worktree name from the sprint filename: `S-NNN-kebab-name`.
2. **Claim check**: if `git branch --list 'S-NNN-*'` or `git worktree list` already shows this
   sprint, another agent owns it — stop and ask the user. Do NOT proceed in the primary
   checkout. (Step 3 also fails cleanly if another agent won the start race — the backlog
   file is gone.)
3. Create it, branching from the post-start `main` tip:
   `git worktree add .claude/worktrees/S-NNN-kebab-name -b S-NNN-kebab-name main`
4. Switch the session in with `EnterWorktree {path: ".claude/worktrees/S-NNN-kebab-name"}`.
   All subsequent deliverable reads, edits, and commits happen inside the worktree — the
   primary checkout is only touched via the lifecycle scripts.
5. Setup: copy untracked env files from the primary checkout (e.g.
   `cp <repo-root>/.env .env` — match whatever the project actually uses), then install
   dependencies with `{{PACKAGE_MANAGER}}` (worktrees don't share installed modules). The
   install may run in the background while Step 5 proceeds.

### Step 5: Doc Drift Validation (token-optimized)

Two gates keep this cheap.

**Gate 1 — DOC_HEALTH gate.** Read `docs/DOC_HEALTH.md` first (small). **Skip any doc marked
"Current"** — only read docs marked "Needs review".

**Gate 2 — Tag-scoped reads.** Among docs that need review, only read those relevant to this
sprint's `tags`. Expand this table as project docs are created — registering a new doc here
is a Close checklist row in the sprint file's Completion Log.

<!-- BOOTSTRAP: seed this table from a scan of the repo's existing docs -->
| Sprint Tag | Docs to validate |
|-----------|-------------------|
| `database` | the schema/data-model doc vs the actual schema files |
| `frontend` | the design-system / component-conventions doc |
| `infra` | the deployment/architecture doc vs actual config |

Validate each doc against reality before trusting it (e.g. a database doc against the actual
schema and migrations; a deployment doc against actual config).

**Output.** List drift found. Fix obvious issues automatically; ask via AskUserQuestion for
ambiguous cases. Commit doc fixes separately on the sprint branch:
`docs: fix drift found in pre-sprint validation for S-NNN`. Exception: if a drift fix touches
`docs/DOC_HEALTH.md` or another generated doc, it goes through the lock on `main` instead
(invariant 3).

### Step 6: Architectural Tradeoff Questions

Read the sprint's **Pre-Sprint Decisions section first** — those decisions are already made;
do not re-ask them. Then read Scope and Technical Details, cross-reference the codebase, and
surface only the **non-obvious** decisions still open via AskUserQuestion (2–4 max, grouped
in one call) — starting with any Open Questions items explicitly deferred to start:

**Qualifies:** architectural tradeoffs with real alternatives; rate limits / quotas /
resource constraints; module boundary decisions; data-model choices hard to reverse.

**Does not:** anything answerable by reading the sprint file; single-reasonable-approach
details; "should I proceed" (the user already said start).

**Record every answer** as a dated entry in the sprint file's Pre-Sprint Decisions section
(`- YYYY-MM-DD (start): [decision] — [rationale]`) in the **worktree's copy** (invariant 3
permits the branch editing its own sprint file in place) and check off the resolved Open
Questions item. The sprint file is the entire brief for whoever executes — an answer that
lives only in this conversation never reaches them. (In wave flows this step is normally
already done by the planning pass — see `ORCHESTRATION.md` Step 2.)

---

## Phase 2: Execution

- All deliverable work, gate commands, and commits run **inside the sprint worktree**
  (Phase 1 Step 4).
- **Verify the brief first.** Before deliverable 1, confirm the plan's premises against the
  worktree's actual code: the referenced files/symbols exist as described, cited APIs match
  the installed versions (check the dependency manifest when a versioned API is cited), and
  Pre-Sprint Decisions are reflected in what you're about to build. Trivial drift (a symbol
  moved lines) → locate it, note it in the sprint file, proceed. An approach-invalidating gap
  (stale premise, missing referenced file, unresolved decision, an acceptance criterion you
  cannot evaluate) → do not code around it: a solo session asks via AskUserQuestion with
  concrete alternatives; an execution subagent stops and returns **PLAN_GAP** per
  `ORCHESTRATION.md`.
- Read deliverables sequentially (1, 2, 3 …). The sprint file is the source of truth for what
  to build.
- For each deliverable:
  1. Read all referenced files before changing anything.
  2. **Test-first (RED).** Write the failing test for the behavior and run it — watch it fail
     for the right reason. (Skip only when test-first genuinely doesn't fit — exploratory spike,
     pure config, visual/UI — and say so + state how you'll verify instead. Traps:
     `docs/sprints/testing-anti-patterns.md`.)
  3. **Implement (GREEN), then refactor** — the simplest change that passes (run the decision
     ladder first — reuse > stdlib > platform > installed dep > one line > new code; YAGNI/KISS,
     `docs/ENGINEERING_PRINCIPLES.md`); clean up only once the test is green.
  4. **Gate before commit** — run `scripts/sprint/gate.sh`; all commands must pass, plus any
     deliverable-relevant tests not covered by the gate. Fix failures before committing — do
     NOT commit broken code and defer.
  5. Check off acceptance criteria only when you can point to the file/test/output that
     proves each — and write that proof into the sprint file as the criterion's
     `- Evidence:` line (SPRINT_TEMPLATE grammar) in the same edit as the `[x]`; the
     branch may edit its own sprint file in place (invariant 3). Automated criteria only —
     Manual criteria stay unchecked: report what to verify and leave the box for the user
     at close (Phase 3 Step 1).
  6. Commit atomically per deliverable (not per file): `S-NNN: [deliverable description]`.
- **Blockers/ambiguity:** do NOT guess or skip — ask via AskUserQuestion with concrete
  alternatives. If a deliverable turns out unnecessary, ask whether to skip and update the
  sprint file. Hit an unexpected bug or failing test? Use `/debug` — root-cause before fixing.
  If the stop was caused by a brief gap (stale premise, missing file, unevaluable criterion),
  log one line in `docs/sprints/PLANNING_LEARNINGS.md` after resolving it (create if absent;
  newest first — readers read the newest 20, older entries are never deleted; a doc-sync
  target: claim the file if editing it mid-sprint, full tier).
  A gap that invalidates the premises of **other un-started backlog sprints** — not just
  this brief — escalates past in-place repair: finish or descope the current sprint, then
  route to `/plan recut` rather than hand-editing the backlog.
- **Deferred work:** anything descoped or discovered-but-not-done goes to `docs/TODOS.md`
  with a backlink to this sprint — not into a comment, not into thin air. (`docs/TODOS.md`
  edits are doc-sync targets; claim the file if editing it mid-sprint.)
- **Claims discipline.** Before editing any file NOT matched by this sprint's `touches:`, run
  `node <repo-root>/scripts/sprint/claims.mjs check --paths <path,…> --sprint S-NNN`.
  - Free → expand the claim: `node <repo-root>/scripts/sprint/claims.mjs add S-NNN <path…>`
    (a small locked commit on `main`) **and mirror the identical `touches:` addition in the
    branch's copy of the sprint file in the same turn** (identical edits on both sides merge
    cleanly at land).
  - Claimed by another in-flight sprint → **stop and ask** — do not edit the file.

**Red flags — don't rationalize past these:**
- "I'll write the test after." Then it's shaped to the code you wrote and you never watched it
  fail — write RED first.
- "I'll commit this broken and fix it next." The gate must pass before every commit.
- "A try/catch makes the error go away." That hides the bug — `/debug` it.
- "The plan says the v2 API, so I'll write v2 even though the repo has v3." The brief's
  premises are claims to verify, not facts to transcribe.

---

## Phase 3: Post-Sprint

**Trigger**: All deliverables complete, all acceptance criteria checked.

### Step 1: Acceptance Criteria Evidence Check

For each criterion, cite one of: a test name that asserts it, a file path + line range that
implements it, or command output that demonstrates it — **written into the sprint file** as
the criterion's indented `- Evidence:` line (SPRINT_TEMPLATE grammar). A checked box without
an Evidence line does not count; evidence that lives only in a conversation or in the
gitignored wave ledger is lost. **Verify the observable difference** the criterion
describes — the value in the response, the row actually written, the model that answered —
not merely that the operation returned without error. An **Automated** criterion's evidence
is the output of the exact command it names. A **Manual** criterion is never self-checked:
present each to the user via AskUserQuestion — confirmed / needs work / descope — and on
confirmation check its box and append `— confirmed YYYY-MM-DD`. For any unevidenced
automated criterion, ask via AskUserQuestion:
- A: "Implement the missing piece now"
- B: "Descope — leave the box unchecked, append `— descoped: <why> (TODOS #N)` to the
  criterion, and add the TODOS row"
- C: "Spin out into a follow-up sprint"

Artifacts that don't fit a line — screenshots, smoke transcripts, measurement or
investigation reports, operator runbooks — go in
`docs/sprints/evidence/S-NNN/<YYYY-MM-DD>-<kind>-<slug>.<ext>` (`kind` ∈ smoke, screenshot,
measure, transcript, runbook; reports are verdict-first), committed on the sprint branch
(the own-sprint evidence dir is claim-exempt) and cited by path from the Evidence line.
Never cite `.claude/sprint-orchestration/` — it is gitignored. A later sprint that proves an
older sprint's deferred criterion back-annotates that older `done/` file on `main` under the
lock at its own close (`— verified by S-MMM on YYYY-MM-DD`, Evidence path).

Then fill the **Completion Log** in the worktree's copy of the sprint file (SPRINT_TEMPLATE):
`### Outcome` (2–4 sentences — the narrative), `### Review`, `### Deviations from brief`,
`### Deferred`, `### Learnings` (`— none` is valid for each), and annotate the
`### Close checklist` rows you can answer now; `Docs synced` / `New docs` / `ADR check` /
`Deployed` are finalized on `main` at Step 5. If the file predates the structured log (no
`### ` subsections), append them from SPRINT_TEMPLATE first. Commit
`S-NNN: completion log`. Lint it before preparing:
`node <repo-root>/scripts/sprint/close-check.mjs <worktree>/docs/sprints/in-progress/S-NNN-*.md`
— `land` runs the same check and refuses (exit 5) on an incomplete record. Do not proceed to
doc sync until every remaining criterion has an Evidence line or a descope annotation.

### Step 2: Doc Sync

`git diff` from the sprint's first commit to HEAD. For each tracked doc, check whether the
diff touches anything it references and update stale sections. Typical triggers: schema /
migration changes → the data-model doc; build scripts / dependencies → the development doc;
env vars → development + deployment docs; UI tokens or components → the design doc; a new
external service → architecture + deployment docs.

Apply Claude-readability rules: full paths for every file/service/table mentioned; relative
links between docs; add `<!-- last-verified: YYYY-MM-DD by S-NNN -->` to updated sections.

**If the sprint created a new doc, register it**: add a `DOC_HEALTH.md` row and a tag→doc
row in Phase 1 Step 5 — that's the `New docs registered` Close checklist row.

Commit: `docs: sync documentation after S-NNN`.

### Step 3: ADR Check (mandatory)

Run `/adr check` over this sprint's commit range. If the sprint introduced a significant
architectural decision not in an existing ADR, draft one (`/adr create`). Record the outcome
on the Close checklist's `ADR check` row either way (`— ADR-NNN` or `— none: reason`).

### Step 3.5: Risk-Tiered Review (solo sprints only)

Check the sprint's diff against the risk-tier table in `docs/sprints/review-calibration.md`
(auth/permissions, schema/migrations, public contracts, test deletion/loosening, secrets,
payment/irreversible mutation, trust-boundary parsing). **High-risk** → dispatch one
`reviewer` subagent (fresh context, diff base = the sprint branch vs `main`) before
preparing the merge; fix Critical/Important findings and re-run `gate.sh`. **Not
high-risk** → skip — review depth scales with blast radius; do not add a pass to every
sprint. Record the outcome under `### Review`: findings by severity with disposition
(`— fixed <sha>` / `— declined: <why>`), or the literal `— not run: low risk (Step 3.5)`.
(Wave/train sprints skip this step entirely — the executor's mandatory `reviewer` child
already covered it and recorded its outcome there.)

### Step 3.6: Proposal Stage Check (solo sprints only)

If the sprint cites a proposal (frontmatter `proposal:`, or a Context
`Source: docs/proposals/NNN-…` line), check whether this was the LAST open sprint for that
proposal + stage: Grep `backlog/` and `in-progress/` on `main` for the same citation (same
`stage k/` when staged). Others remain → note "stage still in progress" and continue to
Step 4. (Wave/train sprints skip this step — the master runs the check once at wave close /
train close; see ORCHESTRATION.md.)

If this was the last:
- **Staged proposal** → set that stage's status line to `delivered YYYY-MM-DD` in the
  proposal file — stage the edit in the worktree; it lands with the sprint via Steps 4–5's
  normal merge (no separate main-lock commit). Then tell the user: "Stage k of proposal
  NNN is complete — the proposal defines a gate here: [gate question]." Offer
  `/proposal NNN` to decide it. Do NOT decide the gate inline at sprint close, and do not
  plan the next stage without it.
- **Un-staged proposal** → flip its `**Status**:` to `delivered YYYY-MM-DD` the same way
  and say so.

### Step 3.7: Learnings

Fill `### Learnings` in the worktree copy — one line per lesson in the SPRINT_TEMPLATE
grammar (`- YYYY-MM-DD S-NNN <plan|test|review|design|exec>: <what happened> → rule: <one
line>`), or `— none`. A `plan`-class line — a gap that would have changed another sprint's
brief — is also prepended to `docs/sprints/PLANNING_LEARNINGS.md` (a doc-sync target: on
`main` during Step 5's pause, or claim the file; never delete older entries). Other classes
stay in the sprint file, greppable across `done/` via `### Learnings`.

### Step 4: Prepare (locked)

Run `<repo-root>/scripts/sprint/merge-sprint.sh prepare S-NNN-kebab-name`. It acquires the
sprint-main lock — **and keeps it through Step 5**, so `main` cannot move underneath the
completion — verifies the ledger (primary clean on `main`), ff-pulls, and merges `main` into
the sprint branch.

- Exit 0 — the branch already contains `main`; go straight to Step 5.
- Exit 3 — the merge brought in changes from other landed sprints: **re-run
  `scripts/sprint/gate.sh`** (plus deliverable-relevant tests) in the worktree, then Step 5.
  The lock is held while the gate runs — that serialization is the point of the merge queue.
- Exit 1 with conflicts listed — real conflicts outside the generated docs (the script
  auto-resolves generated-doc conflicts by taking `main`'s side, since their regeneration
  happens on `main`). Resolve in the worktree, commit, re-run `prepare`. Branches following
  this protocol cannot conflict on generated docs at all — the branch never edits them.

### Step 5: Land (locked)

1. `merge-sprint.sh land S-NNN-kebab-name` — **first lints the branch's copy of the sprint
   file with `close-check.mjs`**: exit 5 means the Completion Log is incomplete (unevidenced
   criteria, placeholders, unannotated checklist rows) — `main` is untouched and the lock is
   kept; fix the record on the branch (commit `S-NNN: completion log`) and re-run `land`
   without a new `prepare`. `--allow-incomplete "<reason>"` lands anyway and writes the
   reason under the file's `### Deviations from brief` — an auditable exception, not a
   habit. Then it merges `--no-ff` into `main`, moves the sprint file
   `in-progress/ → done/`, flips `status: done` + `end_date`, **stamps the sprint's `S-NNN:`
   deliverable commits + merge SHA under `### Commits`**, rotates the archive (keeps the 10
   most recent in `done/`; archived sprints stay in INDEX.md and dependency checks read
   `done/archive/` too), and regenerates the generated blocks. It exits 4, pausing for the
   semantic docs.
2. **Author the semantic docs** — editing by absolute path in the **primary checkout** (the
   lock is yours; do not commit):
   - `docs/DOC_HEALTH.md`: "Last Verified" / "By Sprint" rows for docs this sprint checked,
     status updates, a History entry.
   - `docs/sprints/INDEX.md`: the Done-table row — Outcome is **one sentence (≤200 chars)**;
     the narrative lives in the sprint file's `### Outcome` (`finish` warns past 300) — plus
     the `_Last updated_` header line (one line, overwritten, never appended to).
   - `docs/sprints/ROADMAP.md`: narrative (Status paragraph, newly-unblocked sprints from
     this sprint's `blocks`, `_Last updated_`).
   - The landed `docs/sprints/done/S-NNN-*.md`: finalize the Close checklist rows that only
     `main` can answer — `Docs synced`, `New docs registered`, `ADR check` (from Steps 2–3
     or the doc-sync agent's return) — and, when the deploy gate decides, `Deployed`.
     Prepend any `plan`-class `### Learnings` line to `docs/sprints/PLANNING_LEARNINGS.md`.
3. `merge-sprint.sh finish S-NNN-kebab-name --no-push` — verifies the moved file kept
   `status: done` (commit hooks that stash unstaged changes can silently drop edits made
   around a `git mv`), guards against `" 2."` macOS sync-duplicate files, commits
   `sprint: complete S-NNN — [name]` with explicit paths `--no-verify`, and releases
   the lock. **`--no-push` is now the rule in every mode** — the code-bearing push is
   settled after the lock is released, behind the deploy gate. Other ledger-only lifecycle
   commits (start, claim expansions, wave reservations)
   carry a trailing ` [skip ci]`; this completion commit never does — it is the HEAD of a
   code-bearing push, and a skip marker there would skip CI for the landed code.
   - **Solo:** ask the deploy-gate question (AskUserQuestion — pushing `main` deploys via
     any connected platform): **Push now (deploy)** (recommended) → `bash
     scripts/sprint/push-main.sh`, then Step 6's CI check; **Hold** → keep commits local,
     state that main is ahead of origin (the board surfaces it; `push-main.sh` is the
     catch-up path and Step 6 rides the eventual push). Never ask while the lock is held —
     `finish` releases it first.
   - **Wave mode:** the push defers to the wave's gated checkpoint push
     (ORCHESTRATION "Push policy" / checkpoint P3).
   - **Train mode:** Steps 4–6 run once **per checkpoint segment**, not per sprint:
     `land`/`finish` take `--sprints S-A,S-B,…` and one lock transaction lands the whole
     segment; the push follows the T1 push policy (ORCHESTRATION "The serial train").

If anything goes wrong mid-land: `merge-sprint.sh abort S-NNN-kebab-name` rolls `main` back
to the recorded pre-land SHA and releases the lock.

### Step 6: Post-Push CI Check + Worktree Cleanup

1. **If the project has CI**, verify the completion push's runs are green before declaring the
   sprint closed — pushed-but-red is a silent failure mode: the push step always ran, but
   nobody read the result. Poll the runs for the completion push until they finish
   (e.g. `gh run list --branch <main> --limit 5`, or `gh run watch <id>`). A red run
   **reopens the sprint's close**: fix on a follow-up commit (small fixes can go straight to
   `main` under the lock; anything larger reopens the worktree), then re-verify. Cite the
   green run IDs in the close summary. (No CI? skip this step.) The check runs against the
   **actual** push, whenever the deploy gate lets it happen — a held push carries this
   check with it. (Wave mode: this check runs
   once, against the wave-end checkpoint push — see ORCHESTRATION Step 6 / checkpoint P3 —
   not after each sprint's `finish`.)
2. `ExitWorktree {action: "keep"}` — returns the session to the primary checkout
   (path-entered worktrees are not auto-removed, so "keep" is correct here).
3. `git worktree remove .claude/worktrees/S-NNN-kebab-name`
4. `git branch -d S-NNN-kebab-name` (safe: the branch is merged).

---

## Rejecting a sprint

`/sprint reject S-NNN [reason]` discards a **backlog** sprint while keeping the record:
a locked main-ledger transaction (lock → `git mv backlog/ → rejected/`, `status: rejected`,
dated one-line reason in the file → regen → commit `sprint: reject S-NNN — [reason]
[skip ci]`). A sprint holding a `wave:` reservation is never rejected silently — release
the reservation first. Only backlog sprints can be rejected; in-progress work is completed,
descoped, or unstarted (`unstart.sh`) instead. Reversal is the same transaction backwards;
the rejection note stays in the file as history.

---

## Generated Blocks & Regeneration

`docs/sprints/INDEX.md` and `docs/sprints/ROADMAP.md` contain regions delimited by
`<!-- BEGIN GENERATED: name -->` / `<!-- END GENERATED: name -->`, regenerated **only** by
`scripts/sprint/regen.mjs` (run automatically by `start.sh` and `merge-sprint.sh land`, or
manually via `node scripts/sprint/regen.mjs`; `--check` exits 2 on drift —
`node scripts/sprint/regen.mjs --check` is a cheap one-liner for CI or a pre-push hook if
you want mechanical drift detection):

- INDEX.md: `totals`, `in-progress` (table incl. each sprint's `touches:`), `backlog`
  (table; the Goal column is the sprint's `short:` frontmatter, the Tasks column its
  `tasks:`, dep-cell notes its `deps_note:`).
- ROADMAP.md: `graph` (Mermaid — nodes labeled `S-NNN · short (pts)`, edges from
  `depends_on`, colors from directory), `critical-path` (longest `depends_on` chain by
  story points).

Everything **outside** the markers (INDEX header narrative + Done-table outcomes; ROADMAP
Status/phasing prose) is LLM-maintained and edited **only on `main` under lock** (Phase 3
Step 5.2 or a locked `/sprint create`/`plan` commit). `docs/DOC_HEALTH.md` remains fully
LLM-authored under the same rule. Hand-edits inside a generated block self-heal at the next
lifecycle event — regen runs unconditionally.
