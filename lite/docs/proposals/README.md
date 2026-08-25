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
here), a self-review pass, and a bounded fresh-context reviewer pass that scores the draft.
It knows when to skip itself (finished plan handed in, or proposal already exists). Every
accepted fix is written back into the proposal (open questions → resolved) — an answer
that lives only in the conversation is lost to any later session.

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
