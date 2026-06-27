# Engineering Principles

The default design values for this project. They are the shared vocabulary for `/plan`
(sizing deliverables), sprint execution (PROTOCOL Phase 2), and review (`/review`,
`.claude/agents/reviewer.md`). They are heuristics, not laws — name the principle when you
invoke it so a reviewer can weigh the tradeoff.

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

Related: the review lenses in `.claude/skills/review/SKILL.md`, the test discipline in
`docs/sprints/testing-anti-patterns.md`.
