# Sprint Execution Protocol (lite)

This document defines the sprint lifecycle that Claude Code follows when executing sprints in
{{PROJECT_NAME}}. The `/sprint` skill defers to this file — it is the source of truth.

Sprint files live in `docs/sprints/` with four directories: `backlog/`, `in-progress/`,
`done/`, `rejected/`. This is the **lite** tier: **one sprint at a time**. If `in-progress/`
is non-empty when starting a new sprint, stop and ask the user before proceeding. (The full
tier adds parallel sprints with file claims, a main-branch lock, and per-sprint worktrees —
upgrade via `/bootstrap-project --upgrade`.)

---

## Phase 1: Pre-Sprint

**Trigger**: user says "start S-NNN" or "work on S-NNN".

### Step 1: Parse Sprint Frontmatter

Read the sprint file and extract: `sprint`, `status`, `goal`, `depends_on`, `blocks`, `tags`,
`story_points`, `plan_date`.

If `plan_date` is null the sprint was never certified implementation-ready by `/sprint plan` —
warn and offer via AskUserQuestion: run `/sprint plan S-NNN` first (recommended), or proceed
with the thin plan.

### Step 2: Dependency Check

For each sprint in `depends_on` (check `done/` + `done/archive/`, then `backlog/`):
- `status: done` → pass.
- In `backlog/` → **warn via AskUserQuestion**:
  - A: "Proceed anyway (dependency not met)"
  - B: "Start [blocking sprint] first"
  - C: "Remove this dependency (resolved or no longer relevant)"

Do NOT silently skip unmet dependencies.

### Step 3: Start the Sprint

1. Confirm `in-progress/` is empty (or ask).
2. `git mv` the file `backlog/ → in-progress/`; set `status: in-progress` and `start_date`.
3. Update the In Progress / Backlog tables in `docs/sprints/INDEX.md` by hand.
4. Commit: `sprint: start S-NNN — [name]`.

Work happens on the current branch by default; use a feature branch if the user prefers.

### Step 4: Doc Drift Validation (token-optimized)

Two gates keep this cheap:

**Gate 1 — DOC_HEALTH gate.** Read `docs/DOC_HEALTH.md` first (small). **Skip any doc marked
"Current"** — only read docs marked "Needs review".

**Gate 2 — Tag-scoped reads.** Among docs needing review, only read those relevant to this
sprint's `tags`:

<!-- BOOTSTRAP: seed this table from a scan of the repo's existing docs -->
| Sprint Tag | Docs to validate |
|-----------|-------------------|
| `database` | the schema/data-model doc vs the actual schema files |
| `frontend` | the design-system / component-conventions doc |
| `infra` | the deployment/architecture doc vs actual config |

List drift found. Fix obvious issues; ask for ambiguous cases. Commit doc fixes separately:
`docs: fix drift found in pre-sprint validation for S-NNN`.

### Step 5: Architectural Tradeoff Questions

Read the sprint's **Pre-Sprint Decisions section first** — those decisions are already made;
do not re-ask them. Then read Scope and Technical Details, cross-reference the codebase, and
surface only the **non-obvious** decisions still open via AskUserQuestion (2–4 max, grouped in
one call) — starting with any Open Questions items explicitly deferred to start.

**Qualifies:** architectural tradeoffs with real alternatives; rate limits / quotas / resource
constraints; module boundary decisions; data-model choices hard to reverse.
**Does not:** anything answerable by reading the sprint file; single-reasonable-approach
details; "should I proceed" (the user already said start).

**Record every answer** as a dated entry in the sprint file's Pre-Sprint Decisions section
(`- YYYY-MM-DD (start): [decision] — [rationale]`) and check off the resolved Open Questions
item. An answer that lives only in this conversation is lost to any later session that picks
the sprint up.

---

## Phase 2: Execution

- **Verify the brief first.** Before deliverable 1, confirm the plan's premises against the
  actual code: the referenced files/symbols exist as described, cited APIs match the installed
  versions, and Pre-Sprint Decisions are reflected in what you're about to build. Trivial
  drift (a symbol moved lines) → locate it, note it, proceed. An approach-invalidating gap
  (stale premise, missing referenced file, an acceptance criterion you cannot evaluate) →
  stop and ask via AskUserQuestion with concrete alternatives — do not code around a broken
  premise.
- Read deliverables sequentially (1, 2, 3 …). The sprint file is the source of truth.
- For each deliverable:
  1. Read all referenced files before changing anything.
  2. **Test-first (RED).** Write the failing test for the behavior and run it — watch it fail
     for the right reason. (Skip only when test-first genuinely doesn't fit — exploratory spike,
     pure config, visual/UI — and say so + state how you'll verify instead. Traps:
     `docs/sprints/testing-anti-patterns.md`.)
  3. **Implement (GREEN), then refactor** — the simplest change that passes (run the decision
     ladder first — reuse > stdlib > platform > installed dep > one line > new code; YAGNI/KISS,
     `docs/ENGINEERING_PRINCIPLES.md`); clean up only once the test is green.
  4. **Gate before commit** — run `scripts/sprint/gate.sh`; all commands must pass. Fix
     failures before committing — do NOT commit broken code and defer.
  5. Check off acceptance criteria only when you can point to the file/test/output that
     proves each.
  6. Commit atomically per deliverable (not per file): `S-NNN: [deliverable description]`.
- **Blockers/ambiguity:** do NOT guess or skip — ask via AskUserQuestion with concrete
  alternatives. If a deliverable turns out unnecessary, ask whether to skip and update the
  sprint file. Hit an unexpected bug or failing test? Use `/debug` — root-cause before fixing.
- **Deferred work:** anything descoped or discovered-but-not-done goes to `docs/TODOS.md`
  with a backlink to this sprint — not into a comment, not into thin air.

**Red flags — don't rationalize past these:**
- "I'll write the test after." Then it's shaped to the code you wrote and you never watched it
  fail — write RED first.
- "I'll commit this broken and fix it next." The gate must pass before every commit.
- "A try/catch makes the error go away." That hides the bug — `/debug` it.
- "The plan says the v2 API, so I'll write v2 even though the repo has v3." The brief's
  premises are claims to verify, not facts to transcribe.

---

## Phase 3: Post-Sprint

**Trigger**: all deliverables complete, all acceptance criteria checked.

### Step 1: Acceptance Criteria Evidence Check

For each criterion, cite one of: a test name that asserts it, a file path + line range that
implements it, or command output that demonstrates it. A checked box without evidence does
not count. **Verify the observable difference** the criterion describes — the value in the
response, the row actually written, the model that answered — not merely that the operation
returned without error. For any unevidenced criterion, ask via AskUserQuestion:
- A: "Implement the missing piece now"
- B: "Descope — remove it and note why in the Completion Log (and `docs/TODOS.md`)"
- C: "Spin out into a follow-up sprint"

### Step 2: Doc Sync

`git diff` from the sprint's first commit to HEAD. For each tracked doc, check whether the
diff touches anything it references; update stale sections. Add
`<!-- last-verified: YYYY-MM-DD by S-NNN -->` to updated sections. If the sprint created a
**new** doc, register it: add a `DOC_HEALTH.md` row and a tag→doc row in this file (Phase 1
Step 4). Update `DOC_HEALTH.md` ("Last Verified" / "By Sprint" rows + a History entry).
Commit: `docs: sync documentation after S-NNN`.

### Step 3: ADR Check (mandatory)

Run `/adr check` over this sprint's commit range. If the sprint introduced a significant
architectural decision not in an existing ADR, draft one (`/adr create`). Record the outcome
in the Completion Log either way ("ADR-NNN" or "none — reason").

### Step 4: Close

1. `git mv` the sprint file `in-progress/ → done/`; set `status: done` and `end_date`.
2. Update `docs/sprints/INDEX.md` by hand: move the row to Done with a one-line outcome.
3. Commit: `sprint: complete S-NNN — [name]`.
4. **If the project has CI**, after pushing verify the completion commit's runs are green
   before declaring the sprint closed (e.g. `gh run list --limit 5`) — a red run reopens the
   close: fix, re-push, re-verify. (No CI? skip this step.)
