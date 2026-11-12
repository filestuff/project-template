# Sprint tier rubric

A sprint's `tier:` says **how hard the work is** — not how big, and not how risky. It
decides which model and how much reasoning effort executes and reviews the sprint, so it
is where cost and quality are traded. `risk:` is a different question (what is exposed if
it goes wrong) and drives review *breadth*; `story_points` is size. A two-point fix to a
race condition is harder than a thirteen-point CRUD screen.

**Risk never sets the tier.** A `risk: high` sprint already buys a deeper, three-lens
review on the stronger model; that is what exposure calls for. It does not make the work
harder to write: a sprint that follows an existing pattern and adds a `Produces` another
sprint will consume is high-risk **and** `standard`.

| Tier | The work is… | Executor | Reviewer |
|---|---|---|---|
| `routine` | mechanical: it repeats a pattern the codebase already has | cheaper model, medium effort | cheaper model, high effort |
| `standard` | ordinary engineering: a clear brief, judgment within one module | cheaper model, high effort | stronger model, high effort |
| `complex` | design under constraints: new boundaries, subtle state, cross-module change | stronger model, high effort | stronger model, high effort |
| `critical` | hard **and** unforgiving: a wrong answer loses data, breaks security, or cannot be undone | stronger model, extra-high effort | stronger model, extra-high effort |

The models behind "cheaper" and "stronger" are in `scripts/sprint/routing.json` (full
tier). In the lite tier nothing is routed automatically — the tier tells you which model
to run the sprint's session on.

## Who sets it, and when

1. **`/plan`** sets a **provisional** tier while cutting sprints: `complex` if the source
   plan describes the sprint as introducing a new boundary, abstraction or cross-module
   change; otherwise `standard`. `/plan` works from the plan document, not from the code,
   so it never sets `routine` or `critical`.
2. **The planner assigns the tier at certification** (`/sprint plan`, or the
   `sprint-planner` agent in a wave) — it has just read the code the sprint touches, which
   is the only position from which difficulty can be judged. It writes `tier:` and a
   one-line `tier_reason:` naming the signal or criteria that decided it. It may lower
   `/plan`'s provisional tier, with the reason on the record.
3. **The brief's cold reader checks the claim** — a `routine` tier against its checklist,
   a `complex` or `critical` tier against the signal its `tier_reason` names. A tier the
   brief does not support is sent back to the planner.
4. **After the sprint starts, the tier only goes up**: an executor that meets work beyond
   it returns ESCALATE and the next tier continues from its branch.

## Both ends are checked — the middle is the default

`standard` is where a sprint lands unless something specific moves it. The cheapest
setting and the expensive ones each have to be earned:

- **Down to `routine` needs every criterion.** A model judging its own task's difficulty
  errs low, so `routine` is a checklist, not a judgment. Unsure between `routine` and
  `standard` → `standard`.
- **Up to `complex` or `critical` needs one signal from the lists below, named in
  `tier_reason` and visible in the brief** — "feels hard", size, and `risk: high` are not
  signals. Unsure between `standard` and `complex` → `standard`.
- Starting at `standard` is safe because two things stand behind it: its reviewer runs on
  the stronger model, and an executor that meets work beyond it returns ESCALATE and the
  next tier continues from its branch. A wrong `standard` costs one cheap run; a wrong
  `complex` is paid in full on every sprint and nothing ever reports it.

### `routine` — ALL of these must hold

- The brief's `Reference:` cites an existing implementation of the same pattern
  (`file:line`), and the sprint follows it — same structure, different nouns.
- No new interface: `### Produces` is `— none`, or unchanged from an existing contract.
- `risk: low`.
- No open decision: zero unchecked Open Questions.
- No schema or stored-data change, no concurrency, no caching, no auth, no input parsing
  at a trust boundary.
- At most 5 files touched and at most 3 story points.

If any one fails, the sprint is `standard` or higher. `tier_reason:` for a routine sprint
names the pattern it follows (`follows src/routes/users.ts:12-40 — same handler shape`).

### `complex` — ANY one of these

- It introduces a module boundary, abstraction or interface that other code will build on.
- Concurrency, ordering, caching, retries, a state machine, or coordination between
  processes.
- A non-trivial algorithm, or a performance-sensitive path with a stated budget.
- A change that must stay consistent across more than one module or service.
- It modifies code that has no tests, or a subsystem with no pattern to follow.
- The cold read of the brief came back with three or more assumptions that survive a
  repair round — the brief cannot carry all the judgment, so the executor must.

### `critical` — ANY one of these

- An irreversible migration or transformation of stored data.
- Authentication, authorization, cryptography, or payment logic itself (not merely a
  screen that sits behind them).
- A correctness failure would silently corrupt or lose data.
- A public contract others depend on changes shape.

Everything else is `standard`.

## Calibration

Rules drift from reality unless something measures them. Every sprint that runs through
the orchestration records an `outcome:` line in its done-file — the tier assigned, the
tier it finished on, escalations, arbiter decisions, fix rounds, and review findings
confirmed. `node scripts/sprint/tiers.mjs` (full tier) aggregates them per tier and flags:

- a tier whose sprints **escalate** often — it is being assigned to work that is harder
  than this rubric admits: tighten the criteria above, or move that tier up a model in
  `routing.json`;
- a tier whose sprints need **repeated fix rounds** or yield confirmed Critical findings —
  the same, one notch milder;
- a top tier with four or more sprints, none of which escalated or strained — possibly
  over-provisioned; try the tier below on the next comparable sprint before changing a
  rule.

Change the rubric or the routing on evidence from that view, not on a single bad sprint.
