---
name: code-simplifier
description: Simplify and refine recently modified code for clarity, consistency, and maintainability while preserving exact behavior. Use when asked to simplify, polish, refactor lightly, or clean up current-session changes before review or PR.
---

# Code Simplifier

Refine recently modified code without changing what it does. Prioritize readable, explicit code over overly compact solutions.

Reference `AGENTS.md` / `CLAUDE.md` (if present) and any more specific local instructions for project conventions.

## Scope

Focus on code touched in the current session or current branch diff unless the user explicitly asks for a broader pass.

Do not introduce broad refactors, formatting churn, dependency changes, or unrelated edits.
Behavior-changing fixes are out of scope — route them to `/review` or `/debug`.

## Rules

1. Preserve functionality exactly.
   - Keep features, outputs, side effects, data contracts, permissions, and error behavior intact.
   - Change how code is expressed, not what it does.

2. Apply project standards.
   - Prefer existing local patterns, frameworks, and helper APIs over introducing new ones.
   - Follow the conventions `AGENTS.md` / `CLAUDE.md` establish for imports, file
     organization, typing, validation, logging, and testing when touching those areas.
   - Add comments only for why, not what.

3. Enhance clarity.
   - Reduce unnecessary complexity and nesting.
   - Remove redundant code and weak abstractions.
   - Improve names when intent becomes clearer.
   - Consolidate related logic only when it improves maintainability.
   - Avoid nested ternaries; prefer straightforward control flow, a small helper, a switch, or a lookup table.

4. Maintain balance.
   - Do not prioritize fewer lines over readability.
   - Do not create clever dense one-liners.
   - Do not combine too many concerns into one function or component.
   - Do not remove helpful abstractions that make the code easier to understand or extend.
   - Never simplify away the hard carve-outs: input validation at trust boundaries, error
     handling that prevents data loss, security, accessibility, anything explicitly requested
     (`docs/ENGINEERING_PRINCIPLES.md`).

## Workflow

1. Inspect the current diff and identify recently modified sections.
2. Look for low-risk simplifications that improve clarity or consistency.
3. Apply only changes that preserve behavior.
4. Run focused validation when practical for the files touched (`scripts/sprint/gate.sh` covers the project's standard checks).
5. Report significant changes and validation performed. If the diff is already lean, report
   "already lean — no changes made" and stop; never manufacture edits to justify the
   invocation.
