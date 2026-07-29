# Design Checks

Reference for `/plan` Phase 3 (and the full tier's sprint-planner) when a sprint has UI
scope. The output of these checks is spec text in the sprint file and decision-ready Open
Questions — not a review document, and not scores.

## UI scope detection — check this first

If the work involves NONE of: new UI screens/pages, changes to existing UI, user-facing
interactions, frontend framework changes, or design-system changes — design checks are
**not applicable**. Say so and skip the rest of this file. Don't force design review on a
backend change.

## 1. Information architecture

What does the user see first, second, third? If everything competes, nothing wins. If the
screen can only show 3 things, which 3? Write the hierarchy into the sprint's Technical
Details (a short ASCII sketch of screen structure/nav flow is enough when layout matters).

## 2. Interaction states

Every UI feature specifies all five states — describe what the user **sees**, not backend
behavior:

```
FEATURE | LOADING | EMPTY | ERROR | SUCCESS | PARTIAL
```

Empty states are features: specify warmth, a primary action, and context — "No items
found." is not a design. Error states must say whether the user can recover (retry, go
back, fix input) or is stuck.

## 3. AI-slop check

Specific, intentional UI — or generic patterns? "Clean, modern UI" is meaningless;
replace it with actual decisions (typeface, spacing, layout, interaction). Flag these
recognizable defaults:

- purple/violet gradient schemes; icon-in-colored-circle 3-column feature grids
- centered-everything; uniform large border-radius on every element
- decorative blobs / wavy dividers; emoji as design elements
- generic hero copy ("Welcome to X", "Your all-in-one solution…")
- cookie-cutter section rhythm (hero → 3 features → testimonials → pricing → CTA)
- default font stacks (system-ui / Inter-by-default) as the primary typeface

Quick litmus: is the brand/product unmistakable on the first screen? Does each section
have exactly one job? Are cards actually necessary, or just decoration?

## 4. Design-system alignment

If the project has a design doc (DESIGN.md or equivalent), annotate the sprint with the
specific tokens/components it uses. Flag every *new* component against the existing
vocabulary — does it fit, or is it a one-off? No design doc? Flag the gap once; don't
invent a system inside one sprint.

## 5. Responsive & accessibility

Per-viewport layout is intentional — "stacked on mobile" is not a spec. Specify keyboard
navigation, ARIA landmarks, touch targets (44px minimum), and color contrast. Accessibility
is a hard carve-out (`docs/ENGINEERING_PRINCIPLES.md`) — it is never simplified away.

## 6. Unresolved design decisions

Surface ambiguities that will otherwise be decided silently by whoever implements:

```
DECISION NEEDED                    | IF DEFERRED, WHAT HAPPENS
What does the empty state look like? | Engineer ships "No items found."
Mobile nav pattern?                  | Desktop nav hides behind a hamburger
```

Each row becomes a decision-ready Open Question in the sprint file (with a recommended
option), riding the normal batched question round — never a per-issue quiz.
