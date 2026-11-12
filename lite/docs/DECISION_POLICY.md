# Decision Policy

Who decides what, when work is run by agents. Every skill, the wave and train
orchestrators, and the `arbiter` agent defer to this file; it is the one place the rule
lives. The aim is not fewer decisions by the user — it is that the user is asked the
decisions that are theirs, once, with the rest made in the open and recorded so they can
be overturned.

It builds on `docs/ENGINEERING_PRINCIPLES.md`: the principles say *how* to choose; this
says *who* chooses and what gets written down.

## Three classes

Classify every decision by testing these **in order** — the first that matches wins.

### 1. Reserved — always the user

Ask. Never auto-decide, whatever the autonomy mode, however obvious the answer looks:

- **Whether and what to build** — a proposal's direction, its scope appetite, a stage
  gate, dropping or adding scope the user confirmed.
- **Overturning the user** — anything that contradicts what the user said or approved,
  including a recorded Pre-Sprint Decision.
- **Irreversible or destructive change** — deleting or rewriting stored data, a migration
  that cannot be reversed, rewriting published history, removing a public API.
- **Security posture** — authentication, authorization, secrets handling, what crosses a
  trust boundary, relaxing a validation.
- **Spend and vendors** — a new paid service, a new external dependency with a cost or a
  licence, a material change in run cost.
- **Breaking a public contract** — an API, schema, event or CLI others depend on.
- **Superseding an accepted ADR.**
- **Weakening a check** — deleting, skipping or loosening a test; changing the commit
  gate or CI; landing with an incomplete record or outside claims.
- **Deploys** — any code-bearing push to the main branch, unless the push policy chosen at
  the start of a wave or train already authorizes it.
- **Manual acceptance criteria** — only the user confirms them.

A decision that would be Reserved *if it went wrong* is Reserved. When in doubt between
Reserved and Taste, it is Reserved.

### 2. Mechanical — decide, record, move on

Exactly one defensible answer follows from something already written down:

- a rung of the decision ladder, or one of its tie-breakers, ranks the options uniquely;
- an accepted ADR, a Pre-Sprint Decision, or a binding constraint in the sprint file
  already settles it;
- a lint, a type, a test or the existing code's convention dictates it;
- the classification itself is defined mechanically (a proposal's Rigor tier, a sprint's
  `risk` and `tier`).

Decide it. Record it (grammar below). Do not ask, and do not surface it at a gate — a
user who is asked to confirm what the rules already settle learns to stop reading.

### 3. Taste — decide, record with the road not taken, show at the gate

Reasonable engineers would choose differently, AND the choice is **reversible**, AND its
**blast radius is contained** (it stays inside the feature being built; nothing outside
the sprint or proposal has to change if it is later reversed).

Decide it by the principles below, record it *with the rejected option and how to undo
it*, and list it at the phase's single approval gate, where the user can overturn it in a
word. Typical: a naming or structure choice inside a module, which of two equivalent
libraries already installed, how to split a deliverable, the default for an option nobody
specified.

A choice that is not clearly reversible, or whose blast radius you cannot bound, is not
Taste — it is Reserved.

## Principles for deciding (in order)

1. **Correctness and the hard carve-outs** — input validation at trust boundaries, error
   handling that prevents data loss, security, accessibility, anything the user explicitly
   asked for. These are never traded away.
2. **What is already decided binds** — accepted ADRs, Pre-Sprint Decisions, binding
   constraints, the proposal's Non-Goals.
3. **The decision ladder** — does it need building; does the codebase, the standard
   library, the platform or an installed dependency already do it.
4. **Reversible over locked-in.**
5. **Small blast radius.**
6. **Complete inside the blast radius when it is cheap** — if the full version costs
   minutes more than the shortcut and stays in the same files, do the full version.
7. **Explicit over clever.**

Name the principle you used. "Felt cleaner" is not a principle.

## Autonomy modes

| Mode | Mechanical | Taste | Reserved | Default for |
|---|---|---|---|---|
| `interactive` | decide | **ask** | ask | `/proposal` direction and appetite; solo `/sprint start` |
| `gated` | decide | decide, show at the gate | ask at the gate | `/plan`, `/sprint wave`, the rest of `/proposal` |
| `unattended` | decide | decide, record as pending review | **stop** (a hard stop) | `/sprint train` after its opening confirmation |

The user sets the mode in words ("ask me everything", "run it unattended") and it holds
for that run. Reserved decisions are never auto-decided in any mode: `unattended` does not
mean "decide for me", it means "do not interrupt me until you must — and then stop".

## The approval gate

One per phase — the end of a proposal's review, the end of a plan's breakdown, a wave's
decision round, a train's opening confirmation. It is a single brief, not a quiz:

1. **Decided for you** — the Taste decisions made in this phase, numbered, each one line:
   the decision, the principle, the rejected option. The user accepts them all with one
   word or overturns any by number.
2. **Yours to decide** — the Reserved questions, each asked with the question protocol
   (one decision per question, 2–4 concrete options, the recommendation first, the stake
   named).

Mechanical decisions are not listed; they are in the record. A gate with nothing in either
list is skipped, in one line: "no decisions needed your input".

## Who decides

| Decider | Decides | Never |
|---|---|---|
| The agent doing the work | Mechanical | Taste in work it is executing for someone else; Reserved |
| The `arbiter` agent (a stronger model, fresh context, this file as its instructions) | Taste raised by planners and executors; classifying a question; whether a reviewer's disputed Critical stands | Reserved — it returns the question, shaped for the user |
| The orchestrator (the session the user is talking to) | Taste in its own phase; delivers the gate | Reserved |
| The user | Reserved; anything they choose to take back | — |

An executing agent that meets a decision it **cannot or should not** make does not guess
and does not stall:

- a decision → it returns **BLOCKED** with the question, the options and what it would do
  if forced; the arbiter classifies and answers, or passes it to the user;
- work beyond it → it returns **ESCALATE** (see `docs/sprints/PROTOCOL.md`), and the
  sprint is handed to a stronger executor.

Escalation is one-way — executor, stronger executor, arbiter, user. Nobody downstream
overrules a decision made upstream of them.

## The record

Every Mechanical and Taste decision is written into the artifact it concerns, at the
moment it is made — the sprint file's **Pre-Sprint Decisions**, the proposal's
**Decision log**, the **Plan record**'s scope-decisions table. A decision that lives only
in a conversation or an agent's context is lost when that context ends.

One line each:

```
- YYYY-MM-DD (<mode>, <class>, <decider>): <decision> — principle: <which> — rejected: <option> — undo: <how>
```

- `<mode>`: `interactive` | `gated` | `unattended` — or the flow that made it (`wave`,
  `train`, `wave, in-flight`), as existing entries do.
- `<class>`: `mechanical` | `taste` | `reserved`.
- `<decider>`: `agent` | `arbiter` | `orchestrator` | `user`.
- `rejected:` and `undo:` are required for `taste`, optional otherwise.

`node scripts/sprint/decisions.mjs` lists them across every artifact (`--class taste`
shows what was decided on the user's behalf; `--since YYYY-MM-DD` narrows it). There is no
second store: the script reads the artifacts.

## What this file does not do

It does not make agents cautious. A Mechanical decision that is asked about, and a Taste
decision that is escalated "to be safe", are both failures of this policy — they spend the
user's attention on what the rules already settled, which is how the Reserved question
gets skimmed past when it finally arrives.
