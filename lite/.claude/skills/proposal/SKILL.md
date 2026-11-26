---
name: proposal
description: >
  Turn an idea into a decision-ready proposal (RFC) in docs/proposals/ — the SPEC step
  before /plan. Use when asked to "explore an idea", "draft a spec/proposal/RFC",
  "should we build X", or when a feature request arrives with no design document yet.
  Also decides stage gates of active multi-stage proposals ("decide the gate for
  proposal NNN") and converts an older proposal to the current format on request
  ("/proposal NNN restructure"). Skips itself when a proposal already exists.
argument-hint: "[idea, doc path, proposal number, or 'NNN restructure']"
allowed-tools: "Read Edit Write Glob Grep Bash AskUserQuestion Skill Agent Task Workflow WebSearch WebFetch"
---

# Proposal Skill

Produces `docs/proposals/NNN-kebab-case-title.md` shaped by `docs/proposals/PROPOSAL_TEMPLATE.md`.
The proposal is the input to `/plan <NNN>`; the chosen direction later becomes an ADR.

## The document (read the template's opening comment — these four rules govern every step)

1. **State lives in the header.** `status`, `rigor`, `created`, `closed`, a one-line
   `status_note`, and `supersedes` / `superseded_by` / `blocked_by`. Never write a status
   paragraph; the reasoning behind a status is a Decisions entry.
2. **The body is current truth.** When something changes after acceptance, edit the
   section to say what is true NOW and add a `D-n` line to `## Decisions` saying what
   changed and why. Never append an "Amended <date>" block.
3. **History is append-only and lives apart.** Review, plan and gate records go in
   `docs/proposals/NNN-title/record.md` when that folder exists, otherwise at the end of
   the proposal. The folder is created (Output step 2) for staged and critical proposals;
   long supporting detail goes in a file there, linked from the section it supports.
4. **Only the next stage is specified.** Later stages are rows in the `## Status` table
   until the gate before them is decided.

Proposals written before v1.18 have a `**Status**:` / `**Rigor**:` header instead of the
`---` block, per-stage `- Status:` lines instead of the table, and inline records. They
stay valid: when a step below says "the proposal's status" or "the stage's state", write
it where that proposal keeps it. Convert one only when asked (Restructure flow).

## Boundaries

In scope: exploring a problem and alternatives BEFORE commitment. Out of scope: deliverables,
file lists, acceptance criteria (those are sprint-file territory — /plan produces them),
recording the final decision (`/adr`), and plan execution. If the request is already
decision-free ("rename this function"), say so and route directly — a proposal for a trivial
change is the null result here: "no proposal needed — [reason]".

## Question protocol (all steps)

Every decision the user must make routes through AskUserQuestion — one decision per call,
2–4 concrete options, a recommended one first, highest-ambiguity first. Prose questions are
reserved for open-ended critique and factual gaps, never for choices: a wall-of-text
question the user must parse for options is a protocol violation, not a style choice.

Questions carrying a real trade-off are decision briefs: name the stakes in one line (what
breaks or is lost if we pick wrong) and give each option a one-line consequence —
effort/risk, or "if deferred: {what happens}". Simple confirms need no stakes line. With
5+ real options, never drop or merge one to fit the 4-option cap. Independent items (scope
candidates): split into sequential per-item calls (include / defer / cut), then one final
call confirming the set. Mutually exclusive choices (a direction): two rounds — first
narrow to the top 3 plus an explicit "none of these — show the rest", then decide.

## Autonomy (`docs/DECISION_POLICY.md`)

A proposal's **direction** and **scope appetite** are always the user's — reserved in
every mode; Steps 1.5 and 3 ask them no matter what. Everything else defaults to the
policy's **interactive** mode here: taste decisions (a contested but reversible scope
call, how to stage, which lens findings to take) are asked, one at a time, as this
skill's steps describe.

When the user asks for less interruption ("run it gated", "don't ask me the small stuff",
"decide the details yourself"), switch to **gated**: classify each decision first;
*mechanical* ones (the Rigor tier, anything an ADR or the decision ladder settles) are
decided and recorded; *taste* ones are decided by the policy's ordered principles and
recorded with the rejected option and how to undo it; Step 5's "does this capture it?"
confirmation is skipped; and the user gets ONE approval gate after the review panel
(Step 6) — "decided for you" (the taste decisions, numbered, accept all or overturn by
number) and "yours to decide" (direction, if not yet asked, and every reserved question).
Reserved decisions are never auto-decided: an ADR being superseded, a surviving blocker
accepted, anything touching security posture, irreversible data change, a public contract
or spend.

In either mode every decision made while drafting — the user's own (direction, appetite,
a contested scope call, a gate) and the ones made for them — is written into the
proposal's `## Decisions` register as a numbered `D-n` line in the policy's record
grammar: who decided, what, and which section it changed. A decision that lives only in
this conversation is lost to `/plan`; one written as a paragraph above `## Problem` is
lost to every reader after the first.

## Entry gates — pick exactly one

1. **Idea only** (no document exists): run the method below.
2. **A finished plan/spec document is handed in**: do NOT re-interrogate. Ask ONE question via
   AskUserQuestion: file it as `docs/proposals/NNN-*.md` (numbered, lightly mapped onto the
   template headings — no forced rewrite) and continue with `/plan <NNN>`, or skip filing and
   go straight to `/plan <path>`. Follow the answer.
3. **A proposal for this topic already exists** (Glob `docs/proposals/*.md`; match on
   filenames, and Read the H1 titles of near-misses): point to it and offer `/plan <NNN>` —
   do not write a duplicate. A bare proposal-number argument (`/proposal 003`) resolves
   here too. Exception — **gate due**: if the proposal's status is `active` and a stage's
   state reads `delivered …` with no `gate:` decision, run the Gate flow (below) instead
   of just pointing — unless it is the LAST stage, which has no gate by design: there,
   set the proposal's status to delivered (and `closed:` to the date), commit
   (`docs: proposal {NNN} — delivered`), and say so. Unknown or legacy statuses (e.g.
   `accepted → ADR-NNN`) get the plain pointer. Two more arguments resolve here:
   `/proposal NNN restructure` runs the Restructure flow, and a proposal whose next stage
   is still a sketch (routed here by `/plan`) runs the Gate flow's step 4 alone.

## Method (gate 1)

### Step 0 — Ground in code before asking anything

Hard precondition: explore the codebase BEFORE the first question. Grep/Read whatever the
idea touches; answer everything answerable by reading. The first question round must cite
what you found as `file:line` — never ask "what file should I look at?" or anything the
code already answers. If nothing relevant exists, declare greenfield explicitly:
"I searched {X}, {Y}, {Z} — nothing exists for this yet."

When the idea spans several modules, the repo is unfamiliar, or grounding needs more than a
few greps, dispatch 1–3 read-only subagents (the Agent tool — named Task on older
harnesses; Explore type) — all in a single message so they run in parallel — each with one
specific question, each returning conclusions with `file:line` evidence, never file dumps.
Their findings carry the same citation obligation as your own. Skip the fan-out when the
answers are already obvious (small scope in familiar code): in-context Grep/Read stays the
default, and the fan-out's value is proportional to uncertainty.

**Prior decisions are part of the ground.** Before the first question, also read: the ADR
list in `docs/decisions/` (titles and status — then any ADR whose subject overlaps the
idea, in full), the newest 20 entries of `docs/sprints/PLANNING_LEARNINGS.md` if it exists,
and `docs/TODOS.md` for deferred work this idea would absorb or duplicate. An accepted ADR
binds: a direction that contradicts one is not a design detail but an explicit "supersede
ADR-NNN?" decision, put to the user in Step 3 and never settled by you. Record what you
consulted on the template's `Prior decisions consulted:` line — "none apply — searched
docs/decisions/ for [terms]" is a valid answer; silence is not.

### Step 1 — Premise interrogation

Answer these five anchors before moving on — none may rest on hand-waving:

1. **Who** is affected? ("Just me, solo dev" is a fine answer — don't dwell then.)
2. **What IS happening now?** Verified by reading code/logs/docs, not assumed.
3. **What should happen instead?**
4. **Why now?** Blocking work, costing money/time, correctness, or just nice-to-have?
5. **What observable signal says the problem is solved?** A problem-level success signal
   (a metric, a removed failure mode, a workflow that no longer needs a workaround) — not
   acceptance criteria.

Then challenge the premise itself: is this the real problem or a proxy for one? What
actually happens if we do nothing? If the honest answer is "not much", say so — that
becomes a real alternative in Step 3, or the null result.

Ask per the Question protocol; ask only what Step 0 could not answer.
Quantify claims or mark them explicitly: "unknown — measure by [method]". "Several files"
is not acceptable — find the count.

### Step 1.5 — Scope appetite

One AskUserQuestion before scope lock: is the appetite a minimal cut, the complete version,
or staged (minimal now, gate, then decide)? Recommend one based on Step 1's "why now"
answer. Skip the question when the user already stated their appetite unprompted — that
counts as answered. The appetite sets the defaults for Steps 2–3 (scope lock, recommended
direction); it is a prior, not a cage. Alternatives are still drafted and weighed equally,
and if exploration shows the appetite is wrong, flag it exactly once — in the Step 3
direction question, where the user's choice supersedes. When the appetite is staged, Step 3
frames alternatives as stage-1 candidates rather than re-offering "staged" as a new option.
Outside that one flag, the appetite is not re-litigated.

### Step 1.6 — Rigor tier

Classify the proposal and write the header's `rigor:` key — mechanically, from what
Step 0 found the idea touches, not from how important it feels:

- **critical** — auth or permissions, payments, secrets, irreversible data mutation or
  deletion, input parsing at a trust boundary (the risk-tier table in
  `docs/sprints/review-calibration.md`), a schema or stored-data migration, or a public
  contract others depend on.
- **standard** — a new module, service, datastore or dependency; or work that will clearly
  span more than one sprint.
- **light** — everything else.

State the tier and the one fact that set it ("critical — changes the sessions table,
`db/schema.sql:41`"). Do not ask: the classification is mechanical, and the user can
overrule it in one word at any point (record that as a `D-n` line). The tier decides
how much of `## Production readiness` Step 3 must fill and which review lenses Step 6 runs.
It never licenses skipping the interrogation — a light proposal still answers Step 1.

### Step 2 — Scope lock

State non-goals explicitly and early — locking what this is NOT prevents creep later.
Genuinely contested scope calls — an in/out boundary the user could reasonably want either
way, or competing smallest-versions — are decisions: route each through AskUserQuestion.
Uncontested non-goals are simply stated.
Identify the smallest version that still delivers the value. When the user asks for more
mid-conversation, name it: "that's a separate proposal — let's finish this one." Once the
user settles a scope call, commit to it; do not re-argue it in later steps (the Step 1.5
appetite keeps its own one-flag rule).

### Step 2.5 — Landscape check

Before drafting alternatives, for each new pattern, component, or capability the idea
introduces, WebSearch: does the framework/platform have a built-in? Is there a maintained
off-the-shelf solution? Is the approach current best practice, and what are the known
footguns? A found existing solution becomes an explicit alternative in Step 3 (adopt/wrap
vs build), not a footnote. Research only what the idea introduces, not the whole domain —
this is a proposal skill, not a research skill. Fail-soft, never a gate: if WebSearch is
unavailable, note "search unavailable — in-distribution knowledge only" and continue.

### Step 3 — Alternatives with equal weight

Draft 2–3 genuinely different approaches. One must be the minimal-viable cut; when
meaningfully distinct, one should be the ideal version. Give "do nothing" its own line
when Step 1 showed the do-nothing cost is low. Weigh them EQUALLY while exploring — do not
default to minimal just because it is smaller; if the right answer is the big version, say
so. Per alternative: how it works, the trade-off it accepts, and a rough dual-scale effort
note (human-team time vs Claude-driven time). An installed brainstorming skill MAY be used
here to generate candidates; it does not replace this method.

**Design it twice (standard and critical rigor).** When the idea adds a module, a
service or a data model, do not sketch the alternatives yourself — an author comparing its
favorite against two paragraphs it wrote for the others is advocating. Name two
structurally different shapes (not two flavors of one: "extend the existing module in
place" vs "a separate worker behind a queue"), then dispatch two `design-explorer`
subagents in a single message, one shape each, with the problem statement, goals and
non-goals, and the `file:line` ground from Step 0. They are blind to each other. Build
`## Direction` and `## Alternatives considered` from their returns, each one's WEAKEST
POINT included verbatim in its trade-offs; the minimal-viable cut and "do nothing" are
still yours to add. Skip this for
light rigor and for changes that follow an existing pattern — there the shapes are not
genuinely open. Fail-soft: if subagents cannot run, say so and draft the alternatives
yourself.

**Production readiness.** For the direction, fill the subsections of
`## Production readiness` that the Rigor tier requires (the template lists them) and
delete the rest. Stay at design level — how it fails, how it is undone, how an operator
sees it — never deliverables. A required subsection that does not apply is
`n/a — [why]`; if you cannot fill one because the answer is unknown, that is an Open
question, not an `n/a`. Unknown numbers are "unknown — measure by [method]".

Once the trade-offs are on the table, designate your recommendation — then put the
direction to the USER via AskUserQuestion: one option per alternative, recommended
first, "do nothing" included when it was listed, multi-select off. With 5+ options this is
the protocol's mutually-exclusive case (two-round narrowing), and "do nothing" survives
into the first round when it was listed. The recommendation is
yours; the decision is theirs — equal weight governs the comparison, not the conclusion.
Write the chosen approach as `## Direction` — as the design, not as "Alternative A" — and
the approaches passed over as `## Alternatives considered`, each with the trade-off that
ruled it out. Log the choice as `D-1`.

**Staged directions.** When alternatives are sequential rather than exclusive — a minimal
cut now that a bigger version builds on ("build stage 1, measure, then decide") — offer
that as its own option in the direction question ("Staged: A now, gate, then decide B") —
unless the Step 1.5 appetite is already staged, in which case the direction question picks
stage 1. Either way, when the direction ends up staged: give every stage a row in the
`## Status` table (its outcome and the gate question that follows it), and write a
`### Stage` block for STAGE 1 ONLY — the outcome it delivers, the riskiest assumption it
tests, and a Gate spec (question, 2–4 options, and the measurable evidence that decides
it). Later stages stay sketches: their blocks are written by the Gate flow, from the
evidence the stage before them produced. A stage specified before that evidence exists
gets rewritten at every gate. Stages describe outcomes and gates, never deliverables or
file lists — that stays /plan territory.

### Step 4 — Self-review before showing the draft

Number and write the proposal file now (Output steps 1–2) — Steps 5 and 6 operate on the
file on disk, and edits land there, never only in conversation. Then rate the draft 0–10
against this checklist before presenting it:

- Problem stated without naming a solution.
- Every open question decision-ready: 2–4 concrete options, one recommended, and an
  "if deferred: {what happens}" consequence.
- Every claim quantified or explicitly marked "unknown — measure by [method]".
- Each decision criterion checkable against each alternative.
- Every Production-readiness subsection the Rigor tier requires is filled with a concrete
  answer for the direction — the rollback path names how, not "revert".
- `Prior decisions consulted:` is filled, and no accepted ADR is contradicted silently.
- `## Summary` was written LAST and fits in about 12 lines: problem, direction, appetite,
  success signal — no status, no history.
- Every decision the user made in this conversation is a `D-n` line, and nothing that
  reads like a decision sits outside `## Decisions`.
- The file is under 400 lines. If it is not, the usual causes are evidence that belongs
  in a linked detail file and later stages specified in full.

Then run the lint and fix until it exits 0 — it is the floor, the rating is the ceiling:
`node scripts/sprint/proposal-check.mjs docs/proposals/{NNN}-{kebab-title}.md` (the
header, required sections for the tier, surviving placeholders, vague open questions, the
Decisions register, the Status table against the stage blocks, and every `file:line`
citation resolving against the working tree). Its `WARN size-…` lines are budgets, not
failures — act on them or say why not. Paste its SUMMARY line when you present the
draft. A `review-missing` failure cannot occur yet — the file is still `draft`.

Name the gap ("it's a 6 because the churn claim is unquantified; a 10 would cite the
count"), fix it, re-rate. Show the draft at ≥8, or earlier when closing the gap needs the
user's input.

### Step 5 — Draft review with the user

(Interactive mode. In gated mode skip this step — the approval gate after Step 6 replaces
it.) Present the draft, then confirm via AskUserQuestion — "Does this capture what you want?
**What did I get wrong?**" — options: **"Looks right — proceed to reviewer"** (recommended)
/ **"Needs changes"** (the tool's built-in Other carries free-text critique). Iterate until
confirmed.

### Step 6 — Review panel

After the user confirms the draft, the proposal is reviewed by a panel of fresh-context
`design-reviewer` subagents — one per **lens**, in parallel, blind to each other and to
this conversation. `docs/proposals/review-lenses.md` defines the lenses, the scoring scale
and the evidence rules; the Rigor tier selects the lenses:

| Rigor | Lenses |
|---|---|
| light | feasibility |
| standard | feasibility, architecture, scope |
| critical | feasibility, architecture, scope, operability, tests — plus security (auth, secrets, payments, trust boundary) and data (stored data or schema) when touched |

**Running it.** When the Workflow tool is available, run
`Workflow({ name: "design-review", args: { kind: "proposal", artifact:
"<abs path to the proposal>", repoRoot: "<abs repo root>", lenses: [...] } })` — it runs
the lenses, verifies the findings and returns the structured result below. Otherwise do
the same by hand with the Agent tool (named Task on older harnesses): dispatch every
lens's `design-reviewer` in ONE message (prompt: the proposal path, the repo root, the
lens name — nothing of your own reasoning), then dispatch one `finding-verifier` per
`blocker` / `major` finding, again in one message.

**Verification before action.** A reviewer's finding is a claim. Every `blocker` and
`major` goes to a `finding-verifier` told to refute it against the code and the text:
`refuted` findings are dropped (and counted), `downgrade` lowers the severity, `confirmed`
stands, `unverified` is recorded under Open questions as a decision-ready question rather
than applied. Never revise the proposal on an unverified finding.

**The gate.** The panel passes iff no `blocker` survives verification AND every lens
scored ≥ 7. Otherwise:

1. Fix what survived — per the anti-shortcut clause below — and write each fix into the
   file.
2. Re-run ONLY the lenses that scored < 7 or raised a surviving blocker. At most two
   rounds in total.
3. Whatever still stands after round two is carried to `## Open questions` as
   decision-ready questions and shown to the user. A surviving **blocker** is never
   waved through: the user either changes the proposal or accepts it by name, via
   AskUserQuestion (stakes: the blocker's claim; options: revise / accept the risk
   and proceed / stop). An accepted blocker is recorded verbatim with the date.

**The approval gate (gated mode).** After the panel's rounds, present the one brief the
policy describes — the taste decisions from the `## Decisions` register, numbered, then each
reserved question via AskUserQuestion (a material change the reviewers motivated, a
surviving blocker, the direction if it was not asked yet). Apply what the user overturns
before recording the review.

**Record it.** Append to `## Review record` — in `docs/proposals/{NNN}-{kebab-title}/record.md`
when that folder exists, otherwise at the end of the proposal: per round, a dated entry
with one row per lens (score; findings kept / refuted / fixed) and the last line exactly
`REVIEW: PASS` or `REVIEW: OPEN — [n] finding(s) carried to Open questions`. `/plan`
refuses a proposal whose record is missing (the lint's `review-missing` rule fires once
status leaves `draft`). Then re-run `proposal-check.mjs` — fixes can break citations.

Fail-soft, honestly: if subagents cannot run at all, say so, write
`REVIEW: OPEN — panel could not run ([why])` and carry "unreviewed" to the user as the one
open item. A panel that did not run is never recorded as a pass.

Anti-shortcut clause: apply mechanical fixes (typos, clarity, quantification the code
answers) directly; material changes — direction, a scope boundary, alternative ranking,
stage or gate specs — route back to the user after the reviewer rounds finish, one
AskUserQuestion per change, before landing in the file. Never silently mutate what the
user confirmed in Step 5.

## Anti-patterns

- A solution masquerading as a problem statement.
- Only one alternative described — that is advocacy, not comparison.
- Vague open questions ("how should errors be handled?") — a gap, not a question.
- Unquantified impact ("improves performance", "several files").
- Scope creep absorbed instead of split into its own proposal.
- Deliverables, file lists, or acceptance criteria leaking into the proposal shape.
- A decision asked in prose instead of AskUserQuestion — options the user must extract
  from a paragraph are a gap.
- An option silently dropped or merged to fit the 4-option cap — use the Question
  protocol's 5+ option shapes instead.
- Reviewer findings applied to a confirmed draft without user approval of material changes.
- A reviewer finding acted on before a `finding-verifier` confirmed it.
- A required Production-readiness subsection answered with a bare "n/a", or "rollback:
  revert the commit" where data has moved.
- A direction that contradicts an accepted ADR without a "supersede ADR-NNN?" decision.
- Lenses added beyond the Rigor tier's set "to be safe" — raise the tier or don't.
- A status written as a paragraph, or a decision recorded anywhere but `## Decisions`.
- An "Amended <date>" block — the section is edited to current truth and a `D-n` line
  says what changed.
- A later stage specified in full before the gate in front of it has been decided.
- History (a review, plan or gate record) edited after the fact, or pasted into the body.

## Gate flow (staged proposals)

Runs when a stage's sprints have all landed and its gate is undecided (entry gate 3's
exception, or the sprint-close protocol routed here). Never runs for the LAST stage — it
has no gate; its completion flips the proposal to `delivered YYYY-MM-DD` at sprint close
(or via entry gate 3's fallback).

1. **Re-ground** (mini Step 0): re-verify the next stage's premises against the now-changed
   code; Grep `docs/sprints/done/` for this proposal's citations and read those sprints'
   Completion Logs (`### Outcome`, the criteria's `- Evidence:` lines, `### Deviations from
   brief`) — landed evidence, not the original plan, feeds the decision. When the
   delivered stage touched several modules, the Step 0 Explore fan-out applies here too.
2. **Decide via AskUserQuestion** using the stage's Gate spec verbatim (its question and
   options; add "stop here" if absent), with the gathered evidence quoted against the
   Gate's evidence line. If the evidence the Gate named was never collected, say so — that
   is itself an input, not a reason to guess.
3. **Record** — three writes, each in its own home:
   - *State:* the stage's state becomes `gate: [chosen option] YYYY-MM-DD`. "Stop here" →
     the proposal's status becomes `stopped`, `closed:` the date, `status_note:` one line.
   - *Decision:* one `D-n` line in `## Decisions` — the option chosen, the number that
     decided it, and which sections it changes.
   - *History:* a dated entry under `## Gate record` (in `record.md` when the folder
     exists, else at the end of the proposal): the evidence read against each line of the
     Gate's Evidence spec, what was missed or never collected, and the `D-n` it produced.
     This is where the long version goes — not the stage block, not the header.
4. **Bring the body up to date, and elaborate the next stage.** If the decision changes
   the direction, a goal, or what a later stage must deliver, edit those sections so they
   read as current truth (the `D-n` line is the trail). Then write the next stage's
   `### Stage` block — it has been a sketch until now: Delivers, the assumption it tests,
   and its Gate spec, written from what the finished stage actually showed. A change the
   user did not decide in step 2 (a new stage, a dropped goal) is a material change: one
   AskUserQuestion each, before it lands. Run `proposal-check.mjs`; it must exit 0.
5. Commit: `docs: proposal {NNN} — stage {k} gate: [choice]`. Then offer `/plan {NNN}` for
   the next stage (it re-grounds against the recorded decision), or stop.

## Restructure flow (`/proposal NNN restructure` — opt-in, one proposal at a time)

Converts a proposal written before v1.18 to the current shape. Never run it unasked, never
on a proposal whose sprints are mid-wave, and never as a batch. Two commits, so the
mechanical half can be checked on its own:

1. **Move the records — no rewording.** Create `docs/proposals/{NNN}-{kebab-title}/record.md`
   and move `## Review record`, `## Plan record` and any other dated record section
   (stage records, replan records, gate write-ups) into it, verbatim, oldest first. Verify
   it is a pure move: every line removed from the proposal appears in `record.md`
   (`git diff --stat` shows matching counts apart from the new file's title line). Run
   `proposal-check.mjs` — the result must be what it was before. Commit:
   `docs: proposal {NNN} — move records to record.md`.
2. **Reshape the body.** In this order, losing nothing:
   - Header: replace the `**Status**` / `**Date**` / `**Rigor**` lines with the `---`
     block. The status becomes one word; its date goes to `closed:`; "superseded by" /
     "parked by" go to `superseded_by` / `blocked_by`; whatever else the old status line
     said becomes a `D-n` line or a Gate record entry. A proposal that never had a Rigor
     line gets one now, classified per Step 1.6.
   - Decisions: gather every decision scattered through the file — a preamble list,
     "Decisions recorded" sections, the old Decision log, dated notes inside stages — into
     `## Decisions` as `D-n` lines in date order. Keep the old numbers when the text
     already cites them ("decision 29" stays D-29). Detail longer than three lines moves
     into the section the decision changed.
   - Stages: build the `## Status` table from the per-stage status lines, then fold every
     "Amended …" block into its stage so the block reads as current truth. Stages not yet
     reached keep their text as blocks — do not delete design to make a sketch.
   - Direction: the chosen alternative becomes `## Direction`; the rest become
     `## Alternatives considered`.
   - Summary: written last.
   Show the user the result before committing — AskUserQuestion: **"Looks right"** /
   **"Needs changes"** — because this half is authored, not mechanical. Then
   `proposal-check.mjs` must exit 0. Commit: `docs: proposal {NNN} — restructure to v2`.

If the reshaped file is still over 400 lines, say where the bulk is and offer to move it
to a linked detail file; do not cut content to hit a number.

## Output — whenever a proposal file is produced (gate 1, or gate 2's file-it path)

1. Number: Glob `docs/proposals/*.md`, ignore `README.md` and `PROPOSAL_TEMPLATE.md`, take
   highest NNN + 1 (001 when none exist), zero-padded to 3 digits.
2. Write `docs/proposals/{NNN}-{kebab-title}.md` following `PROPOSAL_TEMPLATE.md`. No
   unresolved placeholder text — every section filled or explicitly marked "n/a — [why]".
   Leave the template's `<!-- … -->` guidance comments out of the proposal: they instruct
   the author, and a reader of the finished file should not have to scroll past them.
   When the proposal is staged or its rigor is critical, also create the folder
   `docs/proposals/{NNN}-{kebab-title}/` with a `record.md` holding one line —
   `# Record — proposal {NNN}` — so every later record lands there. Otherwise no folder:
   a small proposal is one file.
   A gate-2 filing (a finished plan lightly mapped onto the headings) carries NO header
   block and NO rigor — the lint then treats it as imported and checks only its shape.
3. `node scripts/sprint/proposal-check.mjs <the file>` must exit 0, then commit:
   `docs: proposal {NNN} — {title}`.
4. **Always end by offering `/plan {NNN}`** — the proposal is not the destination, the
   sprint backlog is. If the user declines, leave Status: draft and stop.
5. Status lifecycle (defined here, written mostly by other skills): `/plan` flips
   `draft → active` when it consumes the proposal and marks the stage `planned`; sprint
   close marks stages `delivered` and, when the LAST stage lands, sets the proposal to
   `delivered` with `closed:` the date; the Gate flow records gate decisions and the
   terminal `stopped`. `parked` (waiting on `blocked_by`) and `rejected` are set here, on
   the user's word. `/proposal` itself never sets `active`.
