# Proposal NNN: Title In Plain Words

<!-- Status: draft | active (stage k/N) [→ ADR-NNN] | delivered YYYY-MM-DD
             | stopped YYYY-MM-DD — [reason] | rejected — [one-line reason]
     Written by other skills: /plan flips draft → active (stage k/N) when it consumes the
     proposal; sprint close marks stages delivered; gate decisions and the terminal
     delivered/stopped are written by /proposal's gate flow. A proposal with no Stages
     section is single-stage (1/1).
     A proposal is a PRE-decision document. It deliberately has NO deliverables, file lists,
     or acceptance criteria — those belong to sprint files and are produced by /plan AFTER
     a direction is chosen. Keeping the two shapes disjoint is the point: a proposal that
     reads like a sprint has skipped the decision. -->

**Status**: draft
**Date**: YYYY-MM-DD
**Rigor**: light | standard | critical

<!-- Rigor is classified by /proposal (Step 1.6) from what the idea touches, and sets how
     much of `## Production readiness` is required and how many review lenses run:
       critical — auth, payments, secrets, irreversible data mutation, input parsing at a
                  trust boundary, a schema/data migration, or a public contract
       standard — a new module, service, datastore or dependency; or more than one sprint
       light    — everything else
     Keep exactly one value on the line above. -->

## Problem

<!-- What is broken or missing, for whom, and the evidence (bug report, metric, quote,
     code smell with file:line). Current behavior must be verified, not assumed; quantify
     it or mark it "unknown — measure by [method]". End with the observable signal that
     says the problem is solved. If you cannot state the problem without naming a
     solution, the problem is not understood yet. -->

## Goals / Non-Goals

<!-- Goals: what a chosen direction must achieve. Non-Goals: what is explicitly out of
     scope, so alternatives are compared fairly. -->

- Goal:
- Non-Goal:

## Alternatives

<!-- 2–3 genuinely different approaches. Recommended one FIRST, with trade-offs for each.
     One must be the minimal-viable cut; note reversibility and rough effort per
     alternative. Include "do nothing" when its cost is genuinely low. One alternative
     is not a comparison; describing only the favorite is advocacy. -->

### A — Recommended: {name}
{How it works. Why it is favored — one line.}
Trade-offs: {cost/risk it accepts}

### B — {name}
{How it works.}
Trade-offs: {why not first choice}

## Decision criteria

<!-- What the choice actually hinges on: constraints, deadlines, skill availability,
     reversibility. A reader should be able to check each criterion against each
     alternative. -->

## Production readiness

<!-- Design-level answers for the RECOMMENDED alternative — what it takes to run this in
     production, not how to build it (still no deliverables, file lists, or acceptance
     criteria). Required subsections depend on the Rigor line:
       light    — Risks and rollback
       standard — + Architecture and data flow, Interfaces and contracts, Test strategy,
                  Observability
       critical — + Data model and migration, Security and threat model, Failure modes,
                  Non-functional targets, Rollout and rollback plan, Cost and capacity
     Delete the subsections your tier does not require. A required subsection that truly
     does not apply is written `n/a — [why]`; a bare "n/a" fails `proposal-check.mjs`.
     Quantify, or mark "unknown — measure by [method]". -->

### Risks and rollback
<!-- The 2–5 ways this goes wrong, each with likelihood, impact and mitigation — and how
     the change is undone if it has to be (and what is lost by undoing it). -->

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| {what goes wrong} | {low/med/high} | {who is hurt, how badly} | {what prevents or contains it} |

Rollback: {how it is undone, and what undoing costs}

### Architecture and data flow
<!-- standard+. The components touched or added and how data moves between them —
     including the unhappy paths (empty, missing, slow, failed). A Mermaid diagram when
     three or more components interact. Cite existing code as file:line. -->

### Interfaces and contracts
<!-- standard+. Every interface this adds or changes (API, schema, event, CLI, config) and
     who consumes it. State compatibility: additive, or breaking — and for whom. -->

### Test strategy
<!-- standard+. What proves this works, at which level (unit / integration / end-to-end /
     manual), and the one failure a test MUST catch before this ships. -->

### Observability
<!-- standard+. What an operator needs to see to know it is working and to diagnose it
     when it is not: logs, metrics, alerts. "Nothing new" is an answer only with a reason. -->

### Data model and migration
<!-- critical. Schema or stored-data changes; how existing data gets there (backfill,
     dual-write, lazy); what happens while old and new code run side by side; how the
     migration is reversed. -->

### Security and threat model
<!-- critical. Assets at stake, trust boundaries crossed, and per threat: how it would be
     exploited and what stops it. Include authn/authz changes and any new secret. -->

| Threat | Vector | Mitigation |
|---|---|---|
| {what an attacker gains} | {how} | {what stops it} |

### Failure modes
<!-- critical. One row per way a component can fail in production. A failure nobody
     detects and the user silently absorbs is the worst row — find it. -->

| What fails | How it is detected | What the user sees | Recovery |
|---|---|---|---|
| {component / dependency} | {alert, log, check} | {behavior} | {automatic or manual, and how long} |

### Non-functional targets
<!-- critical. The numbers this must meet: latency, throughput, volume, availability,
     data-loss tolerance. Each is a target with a unit, or "unknown — measure by [method]". -->

### Rollout and rollback plan
<!-- critical. How it reaches users (flag, staged, all at once), what is checked at each
     step, the rollback path, and how long rollback takes. -->

### Cost and capacity
<!-- critical. What it costs to run (infrastructure, vendor, per-request) and where it
     stops scaling. -->

## Stages

<!-- OPTIONAL — delete this section unless the chosen direction is explicitly sequential
     ("build stage 1, measure, gate-decide, then stage 2"). Stages describe OUTCOMES and
     the decision that gates the next stage — never deliverables, file lists, or
     acceptance criteria (/plan produces those, one stage at a time). The Gate's evidence
     must be a measurable signal (a metric, a count, a removed failure mode), not vibes.
     Stage status grammar: pending | planned (S-NNN..S-MMM) | delivered YYYY-MM-DD |
     gate: [chosen option] YYYY-MM-DD | stopped — [reason]. Status is written by /plan
     (planned), sprint close (delivered), and /proposal's gate flow (gate/stopped). -->

### Stage 1 — {name}
- Delivers: {the outcome this stage puts in users' hands}
- Gate: {the question to decide once this stage's sprints land}
  - Options: {A (recommended: why)}, {B}, {stop here}
  - Evidence: {measurable signal(s) that decide it — how collected}
- Status: pending

### Stage 2 — {name}
- Delivers: …
- Gate: … (the LAST stage needs no Gate — its completion flips the proposal to delivered)
- Status: pending

## Decision log

<!-- OPTIONAL — delete if empty. Decisions made while drafting that the user was NOT asked
     (docs/DECISION_POLICY.md): mechanical ones, and taste ones decided in gated mode.
     One line each, in the policy's grammar:
     - YYYY-MM-DD (<interactive|gated>, <mechanical|taste>, <agent|arbiter>): <decision> —
       principle: <which> — rejected: <option> — undo: <how>
     The direction and scope appetite are never here — they are the user's and are
     recorded in Alternatives. `node scripts/sprint/decisions.mjs` lists these across
     proposals and sprints. -->

## Open questions

<!-- Decision-ready only: each with 2–4 concrete options, a recommended one, and the
     consequence of deferring it (what the implementer ships by default if unanswered).
     A vague question ("how should errors be handled?") is a gap, not a question. -->

- [ ] {Question} — options: {A (recommended: why)}, {B} — if deferred: {what happens}

## References

<!-- Code locations (file:line), prior art, related proposals, external docs. -->

Prior decisions consulted: {ADR-NNN — one line on how it constrains this proposal, per
ADR; or "none apply — searched docs/decisions/ for [terms]"}

<!-- ## Review record — written by /proposal's review panel (Step 6), never by hand. One
     dated entry per review round: a row per lens (score 1–10, findings kept / refuted /
     fixed) and a machine-checkable last line — exactly `REVIEW: PASS`, or
     `REVIEW: OPEN — [n] finding(s) carried to Open questions`. `proposal-check.mjs`
     requires this section once Status has left `draft`. -->

<!-- ## Plan record — appended by /plan when it consumes this proposal (never drafted by
     hand). One dated entry per breakdown or recut: the sprints created, a
     requirement→sprint coverage map, a scope-decisions table (ACCEPTED/DEFERRED/CUT with
     reasoning), review inputs consumed, and a machine-checkable last line — exactly
     `NO UNRESOLVED DECISIONS`, or an `UNRESOLVED DECISIONS:` bullet list. The gate flow
     and /plan recut read this section as evidence of what each stage actually promised. -->
