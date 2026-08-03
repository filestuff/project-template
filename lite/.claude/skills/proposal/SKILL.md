---
name: proposal
description: >
  Turn an idea into a decision-ready proposal (RFC) in docs/proposals/ — the SPEC step
  before /plan. Use when asked to "explore an idea", "draft a spec/proposal/RFC",
  "should we build X", or when a feature request arrives with no design document yet.
  Skips itself when a proposal already exists.
argument-hint: "[idea, doc path, or proposal number]"
allowed-tools: "Read Edit Write Glob Grep Bash AskUserQuestion Skill"
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

## Entry gates — pick exactly one

1. **Idea only** (no document exists): run the method below.
2. **A finished plan/spec document is handed in**: do NOT re-brainstorm. Ask ONE question via
   AskUserQuestion: file it as `docs/proposals/NNN-*.md` (numbered, lightly mapped onto the
   template headings — no forced rewrite) and continue with `/plan <NNN>`, or skip filing and
   go straight to `/plan <path>`. Follow the answer.
3. **A proposal for this topic already exists** (Glob `docs/proposals/*.md`, check titles):
   point to it and offer `/plan <NNN>` — do not write a duplicate.

## Method (gate 1)

Prefer the installed brainstorming skill: if `superpowers:brainstorming` (or another
brainstorming skill) is available, invoke it and steer its output into the template shape and
location below — the skill's default output directory does not apply here.

Fallback (no brainstorming skill installed):
1. Explore the codebase first — answer what is answerable by reading before asking anything.
2. Clarifying questions one at a time (AskUserQuestion), each with concrete options and a
   recommended one. Stop when the problem statement holds without naming a solution.
3. Draft 2–3 genuinely different alternatives with trade-offs, recommendation first.
4. Fill the remaining template sections (decision criteria, open questions — decision-ready
   only, references with file:line).

## Output — always the same, regardless of gate

1. Number: Glob `docs/proposals/*.md`, ignore `README.md` and `PROPOSAL_TEMPLATE.md`, take
   highest NNN + 1, zero-padded to 3 digits.
2. Write `docs/proposals/{NNN}-{kebab-title}.md` following `PROPOSAL_TEMPLATE.md`. No
   unresolved placeholder text — every section filled or explicitly marked "n/a — [why]".
3. Commit: `docs: proposal {NNN} — {title}`.
4. Optional hardening: offer ONE round with an interview/stress-test skill (e.g. grill-me) if
   installed; write every answer back into the proposal (open questions → resolved), not
   just into the conversation.
5. **Always end by offering `/plan {NNN}`** — the proposal is not the destination, the
   sprint backlog is. If the user declines, leave Status: draft and stop.
