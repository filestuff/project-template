---
status: draft
rigor: light | standard | critical
created: YYYY-MM-DD
closed:
status_note:
supersedes: []
superseded_by:
blocked_by: []
---

# Proposal NNN: Title In Plain Words

<!-- THE HEADER (the block above) is the only place the proposal's state is written.
       status       draft | active | delivered | stopped | rejected | parked — one word.
                    /plan flips draft → active; sprint close writes delivered; the gate
                    flow writes stopped; parked = waiting on `blocked_by`.
       rigor        classified by /proposal (Step 1.6) from what the idea touches:
                      critical — auth, payments, secrets, irreversible data mutation, input
                                 parsing at a trust boundary, a schema/data migration, or a
                                 public contract
                      standard — a new module, service, datastore or dependency; or more
                                 than one sprint
                      light    — everything else
                    It sets how much of `## Production readiness` is required and how many
                    review lenses run. Keep exactly one value.
       closed       the date of delivered / stopped / rejected. Empty until then.
       status_note  ONE line, at most 120 characters ("superseded by 037"). The reasoning
                    behind a status belongs in `## Decisions`, never here.
       supersedes / superseded_by / blocked_by — proposal numbers: [028] or [028, 036].

     THE SHAPE. A proposal is the durable statement of a problem, the direction chosen for
     it, and — when it is staged — the map of stages and gates. It deliberately has NO
     deliverables, file lists, or acceptance criteria: those belong to sprint files, which
     /plan produces one stage at a time.

     THE BODY IS CURRENT TRUTH. When something changes after the proposal is accepted (a
     gate decision, a correction, a re-scope), edit the section so it says what is true
     NOW and add one numbered line to `## Decisions` saying what changed and why. Never
     append "Amended <date>" blocks — git keeps the old text, and a reader must not have
     to replay amendments to learn the current design.

     HISTORY LIVES IN THE RECORD. Review, plan and gate records are append-only. If the
     folder `docs/proposals/NNN-title/` exists they go in its `record.md`; otherwise they
     are appended to the end of this file. /proposal creates the folder for staged and
     critical proposals. Long supporting detail (evidence tables, a deep design note) goes
     in a file in that folder, linked from the section it supports — one level deep, never
     a link from a detail file to another detail file.

     SIZE. Aim to keep this file under 400 lines; the lint warns beyond that. -->

## Summary

<!-- Written LAST, read first. At most ~12 lines: the problem in one or two sentences, the
     direction chosen, the appetite (minimal / complete / staged), and the observable
     signal that says it worked. No status and no history — those have their own homes. -->

## Status

<!-- STAGED PROPOSALS ONLY — delete this section and `## Stages` for a single-stage
     proposal. One row per stage; this table is the ONLY place stage state is written.
     State grammar: pending | planned (S-NNN..S-MMM) | delivered YYYY-MM-DD |
     gate: [chosen option] YYYY-MM-DD | stopped — [reason].
     /plan writes planned, sprint close writes delivered, /proposal's gate flow writes
     gate: and stopped. A row that reads `delivered …` is a gate waiting to be decided.
     A stage that has a row here but no `### Stage` block below is a SKETCH: its outcome
     and gate question are known, its detail is not, and /plan will not plan it. -->

| Stage | Outcome | Gate question | State |
|---|---|---|---|
| 1 | {the outcome this stage puts in users' hands} | {the question decided when it lands} | pending |
| 2 | {outcome} | {question — the LAST stage has no gate: write "—"} | pending |

## Problem

<!-- What is broken or missing, for whom, and the evidence (bug report, metric, quote,
     code smell with file:line). Current behavior must be verified, not assumed; quantify
     it or mark it "unknown — measure by [method]". End with the observable signal that
     says the problem is solved. If you cannot state the problem without naming a
     solution, the problem is not understood yet. -->

## Goals / Non-Goals

<!-- Goals: what the direction must achieve. Non-Goals: what is explicitly out of scope,
     so alternatives are compared fairly and later requests can be named as a separate
     proposal. -->

- Goal:
- Non-Goal:

## Constraints

<!-- OPTIONAL — delete if none. What binds ANY direction: an accepted ADR, a decision the
     owner made before drafting, a deadline, a system that must not change. One line each. -->

## Direction

<!-- The approach that was chosen, written as the design: how it works, and in one
     paragraph why it beat the alternatives against the decision criteria. This is the
     section readers return to — keep it current. -->

## Alternatives considered

<!-- At least one genuinely different approach that was NOT chosen. One of the approaches
     across Direction + this section must be the minimal-viable cut; include "do nothing"
     when its cost is genuinely low. Describing only the favorite is advocacy. -->

### {name}
{How it would work.}
Why not: {the trade-off that ruled it out} · Effort: {rough} · Reversible: {yes / no — how}

## Decision criteria

<!-- What the choice actually hinged on: constraints, deadlines, skill availability,
     reversibility. A reader should be able to check each criterion against the Direction
     and against each alternative. -->

## Production readiness

<!-- Design-level answers for the DIRECTION — what it takes to run this in production, not
     how to build it (still no deliverables, file lists, or acceptance criteria). Required
     subsections depend on `rigor`:
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

<!-- STAGED PROPOSALS ONLY (delete with `## Status` otherwise). A `### Stage k` block is
     written ONLY for the stage about to be built. Later stages stay sketches — a row in
     the Status table — until /proposal's gate flow decides the gate before them and
     writes their block from the evidence that landed. Specifying stage 4 before stage 1's
     evidence exists is guessing.
     A block describes OUTCOMES and the decision that gates the next stage — never
     deliverables, file lists, or acceptance criteria (/plan produces those). The Gate's
     evidence must be a measurable signal (a metric, a count, a removed failure mode), not
     vibes. Do NOT write a Status line here — state lives in the Status table. -->

### Stage 1 — {name}
- Delivers: {the outcome this stage puts in users' hands}
- Tests: {the riskiest assumption this stage proves or kills}
- Gate: {the question to decide once this stage's sprints land}
  - Options: {A (recommended: why)}, {B}, {stop here}
  - Evidence: {measurable signal(s) that decide it — how collected}

## Decisions

<!-- The numbered register of every decision that shaped this proposal — the owner's AND
     the ones made for them (docs/DECISION_POLICY.md). Append-only: a reversal is a new
     entry that names the one it replaces. One entry each, at most three lines:
     - D-n YYYY-MM-DD (<interactive|gated>, <mechanical|taste|reserved>, <owner|agent|arbiter>):
       <decision> — changes: <section it changed> [— principle: <which>]
       [— rejected: <option>] [— undo: <how>] [— supersedes: D-k]
     D-1 is the direction; the scope appetite and every gate decision get entries too.
     principle / rejected / undo are required on taste decisions the owner was not asked.
     The detail of a decision belongs in the section it changed — this line points there.
     `node scripts/sprint/decisions.mjs` lists these across proposals and sprints. -->

- D-1 YYYY-MM-DD (interactive, reserved, owner): {direction chosen} — changes: Direction — rejected: {the alternatives passed over}

## Open questions

<!-- Decision-ready only: each with 2–4 concrete options, a recommended one, and the
     consequence of deferring it (what the implementer ships by default if unanswered).
     A vague question ("how should errors be handled?") is a gap, not a question. An
     answered question is removed from here and becomes a Decisions entry. -->

- [ ] {Question} — options: {A (recommended: why)}, {B} — if deferred: {what happens}

## References

<!-- Code locations (file:line), prior art, related proposals, external docs, and the
     detail files in this proposal's folder (one line each: what it holds). -->

Prior decisions consulted: {ADR-NNN — one line on how it constrains this proposal, per
ADR; or "none apply — searched docs/decisions/ for [terms]"}

<!-- RECORDS — never drafted by hand, always appended, never edited afterwards. They live
     in `docs/proposals/NNN-title/record.md` when that folder exists, otherwise at the end
     of this file.
     ## Review record — written by /proposal's review panel (Step 6). One dated entry per
       review round: a row per lens (score 1–10, findings kept / refuted / fixed) and a
       machine-checkable last line — exactly `REVIEW: PASS`, or
       `REVIEW: OPEN — [n] finding(s) carried to Open questions`. `proposal-check.mjs`
       requires it once status has left `draft`.
     ## Plan record — appended by /plan when it consumes this proposal. One dated entry
       per breakdown or recut: the sprints created, a requirement→sprint coverage map, a
       scope-decisions table (ACCEPTED/DEFERRED/CUT with reasoning), review inputs
       consumed, and a machine-checkable last line — exactly `NO UNRESOLVED DECISIONS`, or
       an `UNRESOLVED DECISIONS:` bullet list.
     ## Gate record — appended by /proposal's gate flow. One dated entry per gate: the
       evidence read against the Gate's evidence line, the option chosen, and the D-n
       entry that records it. -->
