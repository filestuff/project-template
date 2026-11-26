# Proposals (RFCs)

Pre-decision design documents: `NNN-kebab-case-title.md`, shaped by `PROPOSAL_TEMPLATE.md`.
A proposal explores a problem and alternatives *before* commitment; once a direction is
chosen, the decision itself is recorded as an ADR in `docs/decisions/` and the proposal is
referenced from it. `/plan` accepts a proposal number as input to break an active
proposal's current stage into sprints.

`/proposal` creates these with its own interrogation method: ground in code first (the
first question cites file:line or declares greenfield), premise interrogation (who / what
is / what should be / why now / observable success signal, plus "what if we do nothing"),
scope lock, equal-weight alternatives (an installed brainstorming skill is optional input
here), a self-review pass, and a review panel.
It knows when to skip itself (finished plan handed in, or proposal already exists). Every
accepted fix is written back into the proposal (open questions → a Decisions entry) — an
answer that lives only in the conversation is lost to any later session.

## Rigor, production readiness and review

Each proposal declares a **Rigor** tier — `light`, `standard` or `critical` — classified
mechanically from what the idea touches (critical: auth, payments, secrets, irreversible
data changes, trust-boundary parsing, migrations, public contracts; standard: a new
module, service, datastore or dependency, or more than one sprint). The tier scales two
things, so small proposals stay small:

- **`## Production readiness`** — the design-level answers for the chosen direction. Light needs only risks and rollback; standard adds architecture and data
  flow, interfaces and contracts, test strategy and observability; critical adds data
  model and migration, security and threat model, failure modes, non-functional targets,
  rollout plan, and cost and capacity. Still no deliverables or acceptance criteria.
- **The review panel** — fresh-context `design-reviewer` agents, one per lens
  (`review-lenses.md`), blind to each other: one lens for light, three for standard, up
  to seven for critical. Every blocker and major finding is independently checked by a
  `finding-verifier` before anyone acts on it. The panel passes only when no blocker
  survives and every lens scores 7 or more; what still stands after two rounds goes to
  Open questions, and a surviving blocker needs the user's explicit acceptance. The
  outcome is written into the proposal as `## Review record`.

At standard and critical rigor, a direction that adds a module, service or data model is
designed twice: two `design-explorer` agents each develop a structurally different shape,
blind to each other, and the Direction and Alternatives considered are built from both.

`node scripts/sprint/proposal-check.mjs docs/proposals/NNN-*.md` lints the result:
the header, required sections for the tier, surviving template placeholders, vague open
questions, the Decisions register, the Status table against the stage blocks, `file:line`
citations that do not resolve, and a missing review record once the proposal has left
`draft`. It also runs from `scripts/sprint/pre-push-gate.sh` on changed proposals and on
the proposal that owns a changed file in its folder. A proposal with no rigor tier (a
finished plan filed as-is, or one written before v1.11) is treated as imported and only
shape-checked.

## Shape

A proposal is organised by how fast its parts change, so that each kind of fact has one
home:

| What | Where | Changes |
|---|---|---|
| State — status, rigor, dates, what it supersedes or waits on | the `---` header block | by `/plan`, sprint close and the gate flow |
| Intent and design — Summary, Problem, Goals, Direction, Alternatives considered, Production readiness | the body | edited in place: the body always says what is true **now** |
| Stage state | one `## Status` table | one cell per event |
| Why it changed — every decision, the owner's included | `## Decisions`, numbered `D-1`, `D-2`, … | append-only, at most three lines each |
| History — review, plan and gate records | `NNN-title/record.md` when the folder exists, else the end of the file | append-only |

Four rules follow from that:

- **No status prose.** `status` is one word and `status_note` one line of at most 120
  characters. The reasoning is a Decisions entry.
- **No "Amended" blocks.** When a gate or a correction changes the design, the section is
  rewritten to current truth and a `D-n` line says what changed and why. Git keeps the old
  text; a reader never has to replay amendments.
- **Only the next stage is specified.** Later stages are rows in the Status table — an
  outcome and a gate question — until the gate in front of them is decided. The gate flow
  then writes the stage's block from the evidence that landed, and `/plan` refuses to plan
  a stage that is still a sketch.
- **Small proposals stay one file.** The folder `docs/proposals/NNN-title/` is created
  only for staged and critical proposals. It holds `record.md` and any long supporting
  detail (evidence tables, a deep design note), each linked from the section it supports,
  one level deep.

The lint warns — it never fails — when the file passes 400 lines, the Summary passes 15,
or a Decisions entry passes 3. These are guardrails, not rules: tune them to how your
proposals actually read.

**Older proposals.** A proposal written before v1.18 has a `**Status**:` / `**Rigor**:`
header, per-stage `- Status:` lines and inline records. It stays valid, every skill still
reads and writes it where it keeps its state, and the lint checks it by its own rules.
`/proposal NNN restructure` converts one proposal on request, in two commits — a verbatim
move of the records, then the reshaped body shown to you before it lands. Nothing is ever
converted automatically.

## Lifecycle

Status: `draft | active | delivered | stopped | rejected | parked`, in the header.
A proposal is `active` while its sprints are in flight; `/plan` flips `draft → active`
when it consumes one. `parked` means it is waiting on the proposals in `blocked_by`.
Staged proposals carry a `## Status` table — one row per stage with its outcome, its gate
question and its state (`pending | planned (S-NNN..S-MMM) | delivered YYYY-MM-DD |
gate: [option] YYYY-MM-DD | stopped — [reason]`) — and a `## Stages` section holding a
block for the stage being built: what it delivers, the assumption it tests, and a Gate
(question, options, measurable evidence), never deliverables. `/plan` plans one stage at a
time; when a stage's last sprint closes, the sprint protocol marks its row `delivered` and
routes back to `/proposal NNN`, whose gate flow decides continue/adjust/stop against the
landed evidence, records it, and writes the next stage's block before that stage is
planned. A proposal with no Stages section is single-stage: sprint close sets it straight
to `delivered`.
