---
name: review
description: Review code changes, auto-fix safe issues, and report bugs
disable-model-invocation: true
---

# review

Code review with craftsman's eye. Auto-fix obvious issues, surface real bugs.

Reference `AGENTS.md` / `CLAUDE.md` (if present) for project conventions. Apply those
patterns as review criteria.

## Critical Rules

1. **AUTO-FIX safe obvious issues** - Don't ask permission for no-brainers
2. **HUNT FOR BUGS** - Logic errors, edge cases, race conditions first
3. **WAIT for confirmation** - On BUG/FIX, don't execute until user says "go"
4. **BE CONCISE** - One-line items, choices at END
5. **USE clickable links** - `path/to/file:123` format only

## Categories

| Category | What | Action |
|----------|------|--------|
| **[BUG]** | Logic errors, security, data loss, race conditions | Report → wait |
| **[FIX]** | Type gaps, missing error handling, test gaps, slop | Report → wait |
| **[AUTO]** | Unused imports, dead code, debug prints, typos | Fix immediately |
| **[CONSIDER]** | Refactors, style opinions, nice-to-have | Mention only |

### AUTO Criteria (all must be true)

- Zero risk of breaking behavior
- <5 seconds to fix
- No judgment call needed

**AUTO examples:**
- Unused imports/variables
- Trailing whitespace
- Leftover debug prints/logs (unless intentional)
- Dead/unreachable code
- Obvious typos in comments/strings

**NOT AUTO (needs confirmation):**
- Removing "unused" function (might be used elsewhere)
- Type changes (might change behavior)
- Any logic change
- AI slop removal (might be intentional)

## Core Checks

**Always ask these questions during review:**

### Can this be simpler?
- Is there unnecessary abstraction? Could this be done with less code?
- Are there helpers/utils being created for one-time operations?
- Over-engineered error handling, feature flags, or backwards-compat shims?

### Can we remove any code?
- Dead code, unused exports, commented-out blocks?
- Backwards-compatibility hacks like renamed `_vars` or `// removed` comments?
- Types/interfaces exported but only used in the same file?

### Is it DRY without premature abstraction?
- Obvious copy-paste of entire functions or large blocks → refactor
- But 2-3 similar lines are fine — don't abstract too early
- The wrong abstraction is worse than duplication

### Does it follow project patterns?
- Whatever `AGENTS.md` / `CLAUDE.md` and the surrounding code establish: file
  organization, error handling, validation, data fetching, logging, testing style.
- Self-documenting code? Comments explain "why" not "what"?

## Project-Specific Checks

<!-- BOOTSTRAP/maintain per project: add concrete, checkable rules here as the
     project's conventions solidify — e.g. "mutations use server actions, not
     POST routes", "no barrel files", "validation schemas in *.validation.ts",
     "bump PIPELINE_VERSION when the prompt changes". The Learnings check below
     is what feeds this section. -->

_(none yet)_

### Learnings check
- Did this change teach us something that should be captured in `AGENTS.md` or this review file?
- Are there patterns that keep coming up that we should document?

## Mindset

**Inheritance Test:** Would I curse the previous author? Understand at 2am?

**Pride Test:** Would I put my name on this?

## Workflow

### Step 0: Determine Scope & Group Files

Auto-detect: conversation changes → staged → current diff

```bash
git diff --cached --name-only  # or HEAD
```

**Group files by area/dependency:**
```
Batch 1: src/api/* (3 files)
Batch 2: src/components/* (related components)
Batch 3: src/utils/* (2 files)
```

**Output:** `Found X files in Y batches`

──────────

### Step 1: Create Review Plan (TODO)

**BEFORE reading any file content**, create a todo list:

```
- [ ] Batch 1: API routes
- [ ] Batch 2: components
- [ ] Batch 3: utils
```

Track batches with the task/todo tools.

──────────

### Step 2: Process Each Batch

**For each batch:**

1. Read diff for batch files only (`git diff --cached -- path/to/files`)
2. Review & categorize issues
3. Auto-fix [AUTO] items immediately
4. Note [BUG]/[FIX]/[CONSIDER] items
5. Mark batch complete in todos

**Issue format:**
```
1. **[BUG]** Race condition in concurrent saves — `src/db.ts:45`
2. **[FIX]** Missing error boundary — `src/App.tsx:12`
3. **[CONSIDER]** Extract to custom hook — `src/Form.tsx:34`
```

**After each batch:**
```
Batch 1 done: AUTO: 2 fixed | BUG: 1 | FIX: 2
```

──────────

### Step 3: Summary & Options (After All Batches)

```
Total: BUG: X | FIX: X | CONSIDER: X (auto-fixed: Y)

Issues:
1. [BUG] ... — `path:line`
2. [FIX] ... — `path:line`

What to fix?
- a) BUG + FIX [recommended]
- b) BUG only
- c) All including CONSIDER
- d) Custom (e.g., "1,3")

I'll assume a) if you don't specify.

Learnings:
- Any patterns worth adding to AGENTS.md?
- Any new review checks to add to this file?
```

**STOP. Wait for selection.**

──────────

### Step 4: Execute Fixes

Process fixes batch-by-batch (same grouping):

1. Update todo list with selected fixes
2. For each batch:
   - Read relevant file(s)
   - Apply fixes
   - Mark complete
3. Run `scripts/sprint/gate.sh` (or the relevant linter) if applicable

## Severity Guide

**BUG (Logic/Security):**
- Business logic errors, wrong conditions
- Race conditions, data loss
- Security: injection, XSS, exposed secrets
- Endpoints missing auth
- Null/undefined not handled
- Edge cases that break

**FIX (Quality):**
- Type safety gaps, unsafe casts
- Missing error handling
- Test coverage gaps
- AI slop (WHAT comments, unnecessary try/catch, blanket casts)
- Missing validation

**CONSIDER (Opinions):**
- Refactoring opportunities
- "I would do it differently"
- Performance micro-optimizations
- Style preferences

## Git Commands

```bash
# Staged
git diff --cached
git diff --cached --name-only

# All uncommitted
git diff HEAD
git diff HEAD --name-only
```

## Error Handling

| Error | Response |
|-------|----------|
| No changes | "Check git status or specify files" |
| File not found | List available, ask to specify |
| Binary files | Skip, mention in summary |
| Large file (>10k) | "Review specific sections?" |
