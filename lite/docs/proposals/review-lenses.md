# Design review lenses

The rubrics the `design-reviewer` agent applies to a proposal (`/proposal` Step 6) or a
plan breakdown (`/plan` Phase 4). One reviewer runs per lens, in parallel, each in a fresh
context and blind to the others. A lens is a point of view, not a checklist to recite:
the reviewer reads the artifact *and the code it implicates* looking for what that point of
view would catch, then reports only what it can ground.

## Which lenses run

Proposals — by the `**Rigor**:` line:

| Rigor | Lenses |
|---|---|
| light | feasibility |
| standard | feasibility, architecture, scope |
| critical | feasibility, architecture, scope, operability, tests — plus security when the proposal touches auth, secrets, payments or a trust boundary, and data when it changes stored data or a schema |

Plans — always: coverage, slicing, contracts, executability.

More lenses than the table gives is noise, not rigor: do not add one because the work
"feels important". Raise the Rigor line instead (it is the user's call) if the table
under-serves the proposal.

## Scoring

Each lens scores the artifact 1–10 **from its own point of view only**:

- **9–10** — would sign off as written.
- **7–8** — sound; the findings are improvements, none is load-bearing.
- **5–6** — a load-bearing gap: the artifact can be fixed, but not shipped as is.
- **≤ 4** — the direction itself is in doubt from this point of view.

A score below 7 must come with at least one `major` or `blocker` finding that explains it;
a score with no finding behind it is not a review.

## Findings

Every finding carries a severity, a claim, evidence and a proposed fix.

- **blocker** — acting on the artifact as written would cause data loss, a security hole,
  an outage, an irreversible commitment made by accident, or work that cannot be built
  because a premise is false.
- **major** — a load-bearing gap or error: a missing failure path, an unstated dependency,
  a requirement no sprint covers, a contract nobody produces.
- **minor** — clarity, precision, a better name. Reported, never gating.

Evidence rules (the same gate the code reviewer uses):

- A finding that asserts a fact about the code quotes the motivating `file:line`, or names
  the search that came up empty.
- A finding about the artifact's own text names the section or line it concerns.
- A factual finding the reviewer cannot ground is labeled `unverified`. It is never
  silently dropped and never stated as fact.

No compliments, no restating the artifact, no findings outside the lens.

## Proposal lenses

### feasibility
Is every claim about the current system true, and can the recommended alternative actually
be built on it? Verify the Problem's "what is happening now" against the code. Check that
each alternative's "how it works" matches the interfaces, data shapes and dependencies
that exist — cite where it does not. Check the effort notes against the size of what must
change. A false premise is a blocker.

### architecture
Does the recommended design fit the system it lands in? Component boundaries and
ownership; data flow on the unhappy paths (empty, slow, failed, out of order); coupling it
adds; whether it contradicts an accepted ADR in `docs/decisions/`; what it makes harder a
year from now. Prefer the structurally simpler design when two reach the same outcome.

### scope
Is this the smallest thing that delivers the stated value, and is everything in it
needed? Apply the decision ladder and YAGNI from `docs/ENGINEERING_PRINCIPLES.md`: does the
codebase, the standard library or an installed dependency already do part of it? Is any
Non-Goal quietly delivered, or any Goal quietly dropped, by the recommended alternative?
Is "do nothing" dismissed without its cost being stated?

### security
Assets, trust boundaries and abuse. Who can reach the new surface and with what
authority; what input crosses a trust boundary unvalidated; what secret is created,
stored or logged; what an attacker gains from each threat the proposal lists — and which
threat it does not list. The hard carve-outs in `docs/ENGINEERING_PRINCIPLES.md` are never
simplified away.

### data
Stored data and its migration. Is the new shape reachable from every existing row; what
happens while old and new code run side by side; is the backfill restartable; can the
migration be reversed, and what is lost if it is; what reads the data that the proposal
does not mention.

### operability
Running it. How an operator knows it is healthy; what pages someone and what merely logs;
whether a failure is visible to the user or silently absorbed; whether the rollout can be
stopped halfway and the rollback has been thought through to a duration; what it costs
and where it stops scaling.

### tests
What would prove this works, and what would not. Is the level right (a unit test cannot
prove an integration); is the one failure that must be caught named; does any stage gate
rest on evidence nobody will collect.

## Plan lenses

### coverage
Every requirement, goal and binding constraint in the source maps to a deliverable in some
sprint, and every sprint traces back to the source. Orphan requirements and ghost sprints
are major. A Non-Goal delivered, or a rejected alternative's feature built, is a blocker.

### slicing
Sprint boundaries and order. Are the `depends_on` edges necessary and sufficient; could
two serial sprints run in parallel with a cleaner seam; do two "parallel" sprints actually
edit the same file (check `touches:` against the code, not against each other's prose); is
any sprint too large to finish or too thin to be worth its ceremony.

### contracts
Every `Consumes` line names something a dependency's `Produces` line actually promises,
with matching signatures and shapes. An interface two sprints both assume the other will
define is a blocker.

### executability
Read each sprint file as the agent that must execute it with no other context. List what
you would have to ask or assume: an unnamed file, an unstated decision, an acceptance
criterion you could not evaluate, a citation that does not resolve.
