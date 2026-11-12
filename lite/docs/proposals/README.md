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
accepted fix is written back into the proposal (open questions → resolved) — an answer
that lives only in the conversation is lost to any later session.

## Rigor, production readiness and review

Each proposal declares a **Rigor** tier — `light`, `standard` or `critical` — classified
mechanically from what the idea touches (critical: auth, payments, secrets, irreversible
data changes, trust-boundary parsing, migrations, public contracts; standard: a new
module, service, datastore or dependency, or more than one sprint). The tier scales two
things, so small proposals stay small:

- **`## Production readiness`** — the design-level answers for the recommended
  alternative. Light needs only risks and rollback; standard adds architecture and data
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
blind to each other, and the Alternatives section is built from both.

`node scripts/sprint/proposal-check.mjs docs/proposals/NNN-*.md` lints the result:
required sections for the tier, surviving template placeholders, vague open questions,
`file:line` citations that do not resolve, and a missing review record once the proposal
has left `draft`. It also runs from `scripts/sprint/pre-push-gate.sh` on changed proposals.
A proposal with no Rigor line (a finished plan filed as-is, or one written before v1.11)
is treated as imported and only shape-checked.

## Lifecycle

Status grammar: `draft | active (stage k/N) [→ ADR-NNN] | delivered YYYY-MM-DD |
stopped YYYY-MM-DD — [reason] | rejected — [one-line reason]`. A proposal is `active`
while its sprints are in flight; `/plan` flips `draft → active` when it consumes one.
Staged proposals carry a `## Stages` section — per stage an outcome plus a Gate (question,
options, measurable evidence), never deliverables. `/plan` plans one stage at a time; when
a stage's last sprint closes, the sprint protocol marks it `delivered` and routes back to
`/proposal NNN`, whose gate flow decides continue/adjust/stop against the landed evidence
before the next stage is planned. A proposal with no Stages section is single-stage:
sprint close flips it straight to `delivered`.
