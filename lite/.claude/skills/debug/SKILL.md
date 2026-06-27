---
name: debug
description: >
  Root-cause a bug before fixing it. Invoke when you hit a bug, a failing test, a crash, or any
  unexpected behavior — "debug this", "why is this failing", "this test is flaky", "track down
  this error" — BEFORE proposing or applying a fix.
argument-hint: "[error message | failing test | description of the misbehavior]"
allowed-tools: "Read Edit Write Glob Grep Bash AskUserQuestion"
---

# Systematic Debugging

## Iron Law

**NO FIX WITHOUT A ROOT CAUSE FIRST.** A fix you can't explain — *why it broke* and *why this
change fixes it* — is a guess. Guesses that happen to make the symptom disappear leave the real
bug in place and add code nobody understands. Find the cause, then fix the cause.

Work the four phases in order. Do not jump to Phase 4.

## Phase 1 — Reproduce & locate the failure

1. **Read the full error.** The whole message, the whole stack trace, the actual vs expected.
   Don't pattern-match on the first line.
2. **Reproduce it consistently.** A bug you can't trigger on demand, you can't verify you fixed.
   Find the smallest reliable repro (a command, a test, an input).
3. **Check what recently changed** (`git log`, `git diff`) — recent edits are the prime suspect.
4. **For multi-component systems, find WHERE it breaks before WHY.** Add temporary diagnostics
   at each boundary (inputs/outputs between modules, function entry/exit) and watch where good
   data becomes bad. See `condition-based-waiting.md` for timing/flaky failures.

## Phase 2 — Understand the correct behavior

1. Find a **working** example — a similar path that works, or the reference implementation the
   sprint pointed at.
2. **Read it completely**, don't skim. List every difference between the working case and the
   broken one. The bug is usually in that diff.

## Phase 3 — Hypothesis, one at a time

1. State ONE hypothesis explicitly: *"I think X is happening because Y."*
2. Test it with the **smallest possible change** — change one variable, observe, keep or discard.
3. Never change several things at once "to be safe" — you won't know which mattered, and you'll
   add noise.

## Phase 4 — Fix the cause (test-first)

1. **Write a failing test that reproduces the bug** — proves you understand it and guards against
   regression. (See `docs/sprints/testing-anti-patterns.md`.)
2. Apply the **single** fix at the root, not a patch at the symptom.
3. **Defense in depth:** once you know the root cause, ask whether a validation/guard at an
   earlier layer would make this class of bug *structurally impossible*, not just this instance
   fixed. Add it where it's cheap.
4. Verify: the new test passes, the rest still pass, output is clean.

## The 3-strikes circuit breaker

After **3 failed fix attempts**, STOP. This is not a fourth hypothesis to try — it is a signal
the **architecture or your model of the system is wrong.** Return to Phase 1 with fresh eyes, or
escalate to the user with what you've ruled out. Do not keep throwing fixes at it.

## Rationalizations — don't talk yourself past these

| Excuse | Reality |
|---|---|
| "I'll just try this fix and see if it works." | Trying fixes without a cause is guessing. Phase 1 first. |
| "The error is obvious, I don't need to reproduce it." | If you can't trigger it, you can't prove you fixed it. |
| "Adding a `try/catch` makes the error go away." | That hides the bug; it doesn't fix it. Find why it throws. |
| "It's probably a race condition" (then `sleep(100)`). | Arbitrary waits are flaky. Use condition-based waiting. |
| "I changed a few things and now it works." | You don't know what fixed it or what you broke. Revert, one change at a time. |
| "I've tried 5 things, let me try a 6th." | 3 strikes → question the architecture, don't keep guessing. |

## Red flags — you have left the method

- You're editing code you haven't read or run.
- You can't state, in one sentence, why the bug happens.
- The "fix" is broader than the bug (rewriting a module to fix one wrong value).
- You're suppressing/catching the symptom instead of removing its cause.
- The test still passes when you revert the fix (it isn't testing the bug).

Any of these → go back to Phase 1.
