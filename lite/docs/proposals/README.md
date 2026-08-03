# Proposals (RFCs)

Pre-decision design documents: `NNN-kebab-case-title.md`, shaped by `PROPOSAL_TEMPLATE.md`.
A proposal explores a problem and alternatives *before* commitment; once a direction is
chosen, the decision itself is recorded as an ADR in `docs/decisions/` and the proposal is
referenced from it. `/plan` accepts a proposal number as input to break an accepted proposal
into sprints.

`/proposal` creates these — it uses an installed brainstorming skill as the method when one
is available, and knows when to skip itself (finished plan handed in, or proposal already
exists). Optional before `/plan`: one stress-test round with an interview skill (e.g.
grill-me); write the answers back into the proposal (open questions → resolved) — an answer
that lives only in the conversation is lost to any later session.
