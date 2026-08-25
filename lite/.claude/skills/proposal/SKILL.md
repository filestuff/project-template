---
name: proposal
description: >
  Turn an idea into a decision-ready proposal (RFC) in docs/proposals/ — the SPEC step
  before /plan. Use when asked to "explore an idea", "draft a spec/proposal/RFC",
  "should we build X", or when a feature request arrives with no design document yet.
  Also decides stage gates of active multi-stage proposals ("decide the gate for
  proposal NNN"). Skips itself when a proposal already exists.
argument-hint: "[idea, doc path, or proposal number]"
allowed-tools: "Read Edit Write Glob Grep Bash AskUserQuestion Skill Agent Task"
---

# Proposal Skill

Produces `docs/proposals/NNN-kebab-case-title.md` shaped by `docs/proposals/PROPOSAL_TEMPLATE.md`.
The proposal is the input to `/plan <NNN>`; the chosen direction later becomes an ADR.

## Boundaries

In scope: exploring a problem and alternatives BEFORE commitment. Out of scope: deliverables,
file lists, acceptance criteria (those are sprint-file territory — /plan produces them),
recording the final decision (`/adr`), and plan execution. If the request is already
decision-free ("rename this function"), say so and route directly — a proposal for a trivial
change is the null result here: "no proposal needed — [reason]".

## Question protocol (all steps)

Every decision the user must make routes through AskUserQuestion — one decision per call,
2–4 concrete options, a recommended one first, highest-ambiguity first. Prose questions are
reserved for open-ended critique, never for choices: a wall-of-text question the user must
parse for options is a protocol violation, not a style choice.

## Entry gates — pick exactly one

1. **Idea only** (no document exists): run the method below.
2. **A finished plan/spec document is handed in**: do NOT re-interrogate. Ask ONE question via
   AskUserQuestion: file it as `docs/proposals/NNN-*.md` (numbered, lightly mapped onto the
   template headings — no forced rewrite) and continue with `/plan <NNN>`, or skip filing and
   go straight to `/plan <path>`. Follow the answer.
3. **A proposal for this topic already exists** (Glob `docs/proposals/*.md`; match on
   filenames, and Read the H1 titles of near-misses): point to it and offer `/plan <NNN>` —
   do not write a duplicate. A bare proposal-number argument (`/proposal 003`) resolves
   here too. Exception — **gate due**: if the proposal's Status is `active` and its current
   stage's status line reads `delivered …` with no `gate:` entry, run the Gate flow (below)
   instead of just pointing. Unknown or legacy statuses (e.g. `accepted → ADR-NNN`) get the
   plain pointer.

## Method (gate 1)

### Step 0 — Ground in code before asking anything

Hard precondition: explore the codebase BEFORE the first question. Grep/Read whatever the
idea touches; answer everything answerable by reading. The first question round must cite
what you found as `file:line` — never ask "what file should I look at?" or anything the
code already answers. If nothing relevant exists, declare greenfield explicitly:
"I searched {X}, {Y}, {Z} — nothing exists for this yet."

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

### Step 2 — Scope lock

State non-goals explicitly and early — locking what this is NOT prevents creep later.
Genuinely contested scope calls — an in/out boundary the user could reasonably want either
way, or competing smallest-versions — are decisions: route each through AskUserQuestion.
Uncontested non-goals are simply stated.
Identify the smallest version that still delivers the value. When the user asks for more
mid-conversation, name it: "that's a separate proposal — let's finish this one." Once the
user settles a scope call, commit to it; do not re-argue it in later steps.

### Step 3 — Alternatives with equal weight

Draft 2–3 genuinely different approaches. One must be the minimal-viable cut; when
meaningfully distinct, one should be the ideal version. Give "do nothing" its own line
when Step 1 showed the do-nothing cost is low. Weigh them EQUALLY while exploring — do not
default to minimal just because it is smaller; if the right answer is the big version, say
so. Per alternative: how it works, the trade-off it accepts, and a rough dual-scale effort
note (human-team time vs Claude-driven time). An installed brainstorming skill MAY be used
here to generate candidates; it does not replace this method.

Once the trade-offs are on the table, designate your recommendation — then put the
direction to the USER via one AskUserQuestion: one option per alternative, recommended
first, "do nothing" included when it was listed, multi-select off. The recommendation is
yours; the decision is theirs — equal weight governs the comparison, not the conclusion.
Record the chosen direction (the template lists it first).

**Staged directions.** When alternatives are sequential rather than exclusive — a minimal
cut now that a bigger version builds on ("build stage 1, measure, then decide") — offer
that as its own option in the same direction question ("Staged: A now, gate, then decide
B"). If chosen, fill the proposal's `## Stages` section: per stage, the outcome it delivers
and a Gate spec (question, 2–4 options, and the measurable evidence that decides it).
Stages describe outcomes and gates, never deliverables or file lists — that stays /plan
territory.

### Step 4 — Self-review before showing the draft

Number and write the proposal file now (Output steps 1–2) — Steps 5 and 6 operate on the
file on disk, and edits land there, never only in conversation. Then rate the draft 0–10
against this checklist before presenting it:

- Problem stated without naming a solution.
- Every open question decision-ready: 2–4 concrete options, one recommended, and an
  "if deferred: {what happens}" consequence.
- Every claim quantified or explicitly marked "unknown — measure by [method]".
- Each decision criterion checkable against each alternative.

Name the gap ("it's a 6 because the churn claim is unquantified; a 10 would cite the
count"), fix it, re-rate. Show the draft at ≥8, or earlier when closing the gap needs the
user's input.

### Step 5 — Draft review with the user

Present the draft, then confirm via AskUserQuestion — "Does this capture what you want?
**What did I get wrong?**" — options: **"Looks right — proceed to reviewer"** (recommended)
/ **"Needs changes"** (the tool's built-in Other carries free-text critique). Iterate until
confirmed.

### Step 6 — Fresh-context reviewer

After the user confirms the draft, dispatch ONE fresh-context subagent (the Agent tool —
named Task on older harnesses; Explore or general-purpose type) with only the proposal
file path and this brief: score it 1–10 on Completeness,
Consistency, Clarity, Scope (YAGNI), and Feasibility; list specific issues, no compliments.
Fix what's right, re-dispatch at most once (max 2 rounds total). If the same issues recur,
stop and record them under Open questions instead of looping. Fail-soft: if the subagent
cannot run, say so and continue — this is a quality bonus, not a gate. Write every accepted
fix back into the proposal file, never leave it only in conversation.

## Anti-patterns

- A solution masquerading as a problem statement.
- Only one alternative described — that is advocacy, not comparison.
- Vague open questions ("how should errors be handled?") — a gap, not a question.
- Unquantified impact ("improves performance", "several files").
- Scope creep absorbed instead of split into its own proposal.
- Deliverables, file lists, or acceptance criteria leaking into the proposal shape.
- A decision asked in prose instead of AskUserQuestion — options the user must extract
  from a paragraph are a gap.

## Gate flow (staged proposals)

Runs when a stage's sprints have all landed and its gate is undecided (entry gate 3's
exception, or the sprint-close protocol routed here).

1. **Re-ground** (mini Step 0): re-verify the next stage's premises against the now-changed
   code; Grep `docs/sprints/done/` for this proposal's citations and read those sprints'
   Completion Logs — landed evidence, not the original plan, feeds the decision.
2. **Decide via AskUserQuestion** using the stage's Gate spec verbatim (its question and
   options; add "stop here" if absent), with the gathered evidence quoted against the
   Gate's evidence line. If the evidence the Gate named was never collected, say so — that
   is itself an input, not a reason to guess.
3. **Record** in the proposal: the stage's status line gains `gate: [chosen option]
   YYYY-MM-DD`, plus a dated decision line under the stage. Last stage or "stop here" →
   flip Status to `delivered`/`stopped`. Otherwise Status becomes `active (stage k+1/N)`.
4. Commit: `docs: proposal {NNN} — stage {k} gate: [choice]`. Then offer `/plan {NNN}` for
   the next stage (it re-grounds against the recorded decision), or stop.

## Output — whenever a proposal file is produced (gate 1, or gate 2's file-it path)

1. Number: Glob `docs/proposals/*.md`, ignore `README.md` and `PROPOSAL_TEMPLATE.md`, take
   highest NNN + 1 (001 when none exist), zero-padded to 3 digits.
2. Write `docs/proposals/{NNN}-{kebab-title}.md` following `PROPOSAL_TEMPLATE.md`. No
   unresolved placeholder text — every section filled or explicitly marked "n/a — [why]".
3. Commit: `docs: proposal {NNN} — {title}`.
4. **Always end by offering `/plan {NNN}`** — the proposal is not the destination, the
   sprint backlog is. If the user declines, leave Status: draft and stop.
5. Status lifecycle (defined here, written mostly by other skills): `/plan` flips
   `draft → active (stage k/N)` when it consumes the proposal; sprint close marks stages
   `delivered`; the Gate flow records gate decisions and the terminal `delivered`/
   `stopped`. `/proposal` itself never sets `active`.
