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
`story_points`.

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

Read the sprint's Scope and Technical Details. Cross-reference the codebase. Surface
**non-obvious** decisions via AskUserQuestion (2–4 max, grouped in one call).

**Qualifies:** architectural tradeoffs with real alternatives; rate limits / quotas / resource
constraints; module boundary decisions; data-model choices hard to reverse.
**Does not:** anything answerable by reading the sprint file; single-reasonable-approach
details; "should I proceed" (the user already said start).

---

## Phase 2: Execution

- Read deliverables sequentially (1, 2, 3 …). The sprint file is the source of truth.
- For each deliverable:
  1. Read all referenced files before changing anything.
  2. Implement the described changes.
  3. **Gate before commit** — run `scripts/sprint/gate.sh`; all commands must pass. Fix
     failures before committing — do NOT commit broken code and defer.
  4. Check off acceptance criteria only when you can point to the file/test/output that
     proves each.
  5. Commit atomically per deliverable (not per file): `S-NNN: [deliverable description]`.
- **Blockers/ambiguity:** do NOT guess or skip — ask via AskUserQuestion with concrete
  alternatives. If a deliverable turns out unnecessary, ask whether to skip and update the
  sprint file.
- **Deferred work:** anything descoped or discovered-but-not-done goes to `docs/TODOS.md`
  with a backlink to this sprint — not into a comment, not into thin air.

---

## Phase 3: Post-Sprint

**Trigger**: all deliverables complete, all acceptance criteria checked.

### Step 1: Acceptance Criteria Evidence Check

For each criterion, cite one of: a test name that asserts it, a file path + line range that
implements it, or command output that demonstrates it. A checked box without evidence does
not count. For any unevidenced criterion, ask via AskUserQuestion:
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
