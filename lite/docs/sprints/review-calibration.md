# Review Calibration

Reference for `.claude/agents/reviewer.md` and `/review` (`.claude/skills/review/SKILL.md`).
Read on demand — when emitting findings, when a finding is contested, or when deciding how
deep to review. Two goals: kill plausible-but-wrong findings (false positives waste fix
cycles), and scale review depth with blast radius (deep review is the exception, not the
default — an extra pass must earn its tokens).

## Confidence calibration

Every Critical/Important finding carries a confidence score:

| Score | Meaning | Display rule |
|---|---|---|
| 9–10 | Verified by reading the specific code; concrete bug demonstrated | Report normally |
| 7–8 | High-confidence pattern match | Report normally |
| 5–6 | Could be a false positive | Report with an explicit caveat; never as Critical |
| ≤4 | Suspicious pattern, unverified | Demote to a trailing **Unverified observations** list — unless severity would be data-loss/security-critical |

Finding format: `**Critical** (confidence 9/10) file:line — description`.

## Pre-emit verification gate

Before any finding is promoted to the report:

1. **Quote the motivating line(s)** — file:line plus the verbatim text that triggered the
   finding. "Field X doesn't exist on model Y" → quote the lines of Y where the field would
   live. "This might return null" → quote the initialization. "Race between A and B" →
   quote both A and B.
2. **Can't quote it? The finding is unverified.** Force confidence to ≤5 and demote it. Do
   not work around the gate by asserting confidence 7+ without the quote.

**Framework-meta rule:** when a symbol is created by a framework construct — ORM model
definition, decorator, metaclass, generated client, migration (Django `Meta`, Rails
`has_many`, Prisma client, TypeORM decorators) — quote the construct that *creates* it.
The bar is "I read the source that creates this symbol", not "I grepped for the name and
didn't find it."

Common false-positive classes this gate kills:

| Claimed finding | What the gate forces |
|---|---|
| "field doesn't exist on model" | Quote the model body/meta — absence (or presence) becomes obvious |
| "lookup might return null/None" | Quote the initialization — many containers are guaranteed non-null |
| "save/update might drop fields" | Quote the actual signature or field set |
| "handler never registered" | Quote the registration site (often generated or convention-based) |

## Anti-rationalization

- "This looks fine" is not a finding and "likely handled elsewhere" is not verification —
  cite the handling code (file:line) or label the item unverified.
- Never write "probably tested" — name the test file and assertion, or flag the gap.
- A stated author rationale ("safe because…") never downgrades a finding; verify it.

## Test-gaming detection

Diff the test-file changes against the source changes. Any test change that exists to make
the diff pass rather than to specify behavior is **Critical**:

- weakened or deleted assertion; deleted test case
- added `skip` / `.only` / commented-out test
- snapshot blindly regenerated to match new output
- widened tolerance or raised timeout papering over a race
- test rewritten to assert the buggy behavior

Tests in a diff should get *stricter* with new behavior, not looser.

## Failure-modes check (deep pass only)

For each new codepath the diff introduces, answer three questions:

1. Is there a test for its failure mode (timeout, null, race, stale data)?
2. Does error handling exist for it?
3. Would the user see a clear error — or a silent failure?

No test AND no handling AND silent → flag as a **critical gap**.

## Risk tiers — when to go deep

A diff (or sprint) is **high-risk** when it touches any of:

- auth, permissions, or session logic
- schema or migrations
- public API contracts, or cross-sprint contracts (a sprint's **Produces**)
- deletion or loosening of tests
- secrets / credential handling
- payment, or irreversible data mutation/deletion
- input parsing at a trust boundary

**High-risk ⇒ deep pass**: trace the callers of changed shared code, run the failure-modes
check above. **Everything else ⇒ one standard pass** — do not add depth (or extra review
agents) to low-risk diffs; the cost is real and the yield is noise.
