# Engineering Principles

The default design values for this project. They are the shared vocabulary for `/plan`
(sizing deliverables), sprint execution (PROTOCOL Phase 2), and review (`/review`,
`.claude/agents/reviewer.md`). They are heuristics, not laws — name the principle when you
invoke it so a reviewer can weigh the tradeoff. The doc opens with the operating procedure
(the decision ladder); the principles it leans on follow.

## Before you code: understand, then climb the ladder

The ladder runs *after* you understand the problem, not instead of it: read the task and the
code it touches, trace the real flow end to end, then climb. A small diff you don't
understand is just laziness dressed up as efficiency.

Then, before writing any code, stop at the first rung that answers:

1. Does it need to be built at all? (see **YAGNI** below)
2. Does this codebase already do it? Reuse the existing helper, util, or pattern.
3. Does the standard library do it?
4. Does a native platform feature cover it?
5. Does an already-installed dependency solve it?
6. Can it be one line?
7. Only then: write the minimum code that works.

When two options land on the same rung, tie-break with:

- Deletion over addition.
- Boring over clever.
- Fewest files possible.
- Reversible over locked-in — prefer the choice you can undo (feature flag, adapter,
  additive migration) when rungs tie.
- Small blast radius — prefer the change whose failure stays contained to its feature
  over one that can break neighbors.

## YAGNI — You Aren't Gonna Need It

Build only what the current sprint/plan actually requires. No speculative config flags,
extension points, "we might need it" parameters, or abstractions for a second caller that
doesn't exist yet. Unrequested generality is cost (more code, more tests, more to read) with
no benefit until the need is real.

- **Smell:** a function parameter only ever called with one value; an interface with one
  implementation; "for future use" code; backwards-compat shims for code that never shipped.

## KISS — Keep It Simple

Prefer the most boring solution that works. Fewer moving parts, shallower call stacks, less
cleverness. Optimize for the next person reading this at 2am, not for elegance.

- **Smell:** a clever one-liner that needs a comment to decode; a framework where a function
  would do; layers of indirection you have to trace to understand one behavior.

## DRY — Don't Repeat Yourself (without premature abstraction)

Remove genuine duplication of *knowledge* (the same rule encoded in two places that must change
together). But 2–3 similar lines are not duplication — **the wrong abstraction is more
expensive than a little copy-paste.** Wait for the third occurrence and a stable shape before
extracting.

- **Smell (too wet):** the same business rule copy-pasted across files; a constant hardcoded in
  several places.
- **Smell (too dry):** a "shared helper" with a `mode`/`isX` flag whose branches share almost
  no code; an abstraction with a single caller.

## SOLID — for object/module boundaries

- **S**ingle Responsibility — a module/class has one reason to change. If "and" appears in its
  description, consider splitting.
- **O**pen/Closed — extend behavior by adding code, not editing stable code; but only once a
  real second case exists (see YAGNI).
- **L**iskov Substitution — a subtype must be usable wherever its base type is, without
  surprising the caller.
- **I**nterface Segregation — many small, focused interfaces beat one fat one; don't force a
  caller to depend on methods it doesn't use.
- **D**ependency Inversion — depend on abstractions (interfaces) at module seams, not on
  concrete implementations; this is also what makes code testable without heavy mocking.

## Root cause over symptom (bug fixes)

A bug report names a *symptom*, not the cause. Before patching the reported path, grep every
caller of the function you touch; if the fault lives in shared code, fix the shared function
once — one guard there is a smaller diff than one per caller, and patching only the path the
ticket names leaves a sibling caller still broken. The smallest change in the wrong place
isn't lazy, it's a second bug. (`/debug` — `.claude/skills/debug/SKILL.md` — is the
procedure; this is the principle.)

## Hard carve-outs — never simplified away

Minimalism has a floor. These are never cut in the name of YAGNI/KISS:

- Input validation at trust boundaries.
- Error handling that prevents data loss.
- Security.
- Accessibility.
- Anything the user explicitly requested.

And when two approaches are the same size, pick the edge-case-correct one — lazy means *less
code*, not the flimsier algorithm.

## Smell → principle quick table

| You notice… | Likely principle | Fix |
|---|---|---|
| Param/flag with one real value | YAGNI | Inline it; delete the branch |
| Interface with one implementation | YAGNI / DIP | Drop the interface until a 2nd impl exists |
| Same rule in 2+ places | DRY | Extract the *knowledge*, not the syntax |
| Helper with a `mode` flag, branches don't share code | DRY (over-applied) | Split into two functions |
| Must mock everything to test it | DIP / SRP | Invert a dependency; split responsibilities |
| Can't explain the class in one sentence without "and" | SRP | Split it |
| Clever code needing a decoder comment | KISS | Rewrite the boring way |
| Reimplements what the codebase/stdlib/an installed dep already provides | Ladder (rungs 2–5) | Delete it; call the existing thing |
| Guard/fix added at one caller of a shared function | Root cause | Grep all callers; fix the shared function once |
| New file where an existing module had room | Ladder tie-breakers | Fold it into the existing file |

Related: the review lenses in `.claude/skills/review/SKILL.md`, the test discipline in
`docs/sprints/testing-anti-patterns.md`, the debugging procedure in
`.claude/skills/debug/SKILL.md`.
