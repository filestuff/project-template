# Proposals (RFCs)

Pre-decision design documents: `NNN-kebab-case-title.md`, shaped by `PROPOSAL_TEMPLATE.md`.
A proposal explores a problem and alternatives *before* commitment; once a direction is
chosen, the decision itself is recorded as an ADR in `docs/decisions/` and the proposal is
referenced from it. `/plan` accepts a proposal number as input to break an accepted proposal
into sprints.

`/proposal` creates these with its own interrogation method: ground in code first (the
first question cites file:line or declares greenfield), premise interrogation (who / what
is / what should be / why now / observable success signal, plus "what if we do nothing"),
scope lock, equal-weight alternatives (an installed brainstorming skill is optional input
here), a self-review pass, and a bounded fresh-context reviewer pass that scores the draft.
It knows when to skip itself (finished plan handed in, or proposal already exists). Every
accepted fix is written back into the proposal (open questions → resolved) — an answer
that lives only in the conversation is lost to any later session.
