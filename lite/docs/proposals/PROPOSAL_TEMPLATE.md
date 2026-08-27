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

## Open questions

<!-- Decision-ready only: each with 2–4 concrete options, a recommended one, and the
     consequence of deferring it (what the implementer ships by default if unanswered).
     A vague question ("how should errors be handled?") is a gap, not a question. -->

- [ ] {Question} — options: {A (recommended: why)}, {B} — if deferred: {what happens}

## References

<!-- Code locations (file:line), prior art, related proposals/ADRs, external docs. -->

<!-- ## Plan record — appended by /plan when it consumes this proposal (never drafted by
     hand). One dated entry per breakdown or recut: the sprints created, a
     requirement→sprint coverage map, a scope-decisions table (ACCEPTED/DEFERRED/CUT with
     reasoning), review inputs consumed, and a machine-checkable last line — exactly
     `NO UNRESOLVED DECISIONS`, or an `UNRESOLVED DECISIONS:` bullet list. The gate flow
     and /plan recut read this section as evidence of what each stage actually promised. -->
