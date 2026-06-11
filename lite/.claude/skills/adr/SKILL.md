---
name: adr
description: >
  Architecture Decision Record management — create, list, supersede, and check ADRs.
  Use when asked to "create an ADR", "document this decision", "list ADRs",
  "supersede an ADR", or when a significant architectural decision is made during
  sprint planning or implementation. /adr check runs mandatorily at sprint close.
argument-hint: "[command] [title-or-number]"
allowed-tools: "Read Edit Write Glob Grep Bash AskUserQuestion"
---

# ADR Management Skill

Architecture Decision Records live in `docs/decisions/` named `NNN-kebab-case-title.md`.

## Commands

### `/adr create [title]`

1. Glob `docs/decisions/*.md` to find the highest NNN (ignore `.gitkeep` and `README.md`).
2. Assign the next number, zero-padded to 3 digits.
3. Ask via AskUserQuestion: the context/problem; the alternatives considered (offer 2–4 if known).
4. Create `docs/decisions/{NNN}-{kebab-title}.md`:

```markdown
# ADR-{NNN}: {Title}

**Status**: Accepted
**Date**: {today}
**Sprint**: {current in-progress sprint, if any, else —}

## Context
{Problem statement.}

## Decision
{The decision, stated clearly.}

## Consequences
- {What changes as a result}
- {New constraints or capabilities}
- {Impact on other systems or sprints}

## Alternatives Considered
### {Alternative 1}
{Description and why not chosen.}
### {Alternative 2}
{Description and why not chosen.}

## Implementation
{Which sprints implement this, or "N/A" if already implemented.}
```

5. Commit: `docs: ADR-{NNN} — {title}`.

### `/adr list`

Glob `docs/decisions/*.md`; for each read the title line + Status; print a table sorted by
number ascending:

```
| # | Title | Status | Date | Sprint |
|---|-------|--------|------|--------|
```

If none exist, say "No ADRs yet."

### `/adr supersede [NNN] [new-title]`

1. Find `docs/decisions/{NNN}-*.md`; read it fully.
2. Set its Status to `Superseded by ADR-{new}`.
3. Create the replacement via the `/adr create` flow, adding:

```markdown
## Supersedes
This ADR supersedes [ADR-{NNN}: {original title}](./{NNN}-original-title.md).

**Reason for change**: {ask via AskUserQuestion}
```

4. Commit both: `docs: ADR-{new} supersedes ADR-{NNN} — {new title}`.

### `/adr check`

**Run mandatorily at every sprint close (PROTOCOL Phase 3), and on demand.**

1. Determine the commit range: at sprint close, the sprint's first commit to HEAD; on demand,
   `git log --oneline -20`.
2. Look for undocumented decisions: new external services/deps, schema changes, new packages
   or significant restructuring, changed infra/deploy config, a chosen-over-alternatives
   approach visible in the diff.
3. Cross-reference existing ADRs.
4. If any are undocumented, list them and ask whether to draft ADRs.
5. **Report the outcome explicitly** — "ADR-NNN drafted" or "none — [reason]" — so the sprint
   Completion Log can record it.

## No Arguments

If invoked as just `/adr`, run `/adr list`.
