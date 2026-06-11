# Doc Health

Staleness tracker for {{PROJECT_NAME}}'s documentation. The `/sprint` pre-sprint phase reads
this file **first** and skips any doc marked **Current** — only docs marked **Needs review**
get re-read and validated against the code. Keep this file small and accurate.

Rules: `docs/sprints/PROTOCOL.md` (Phase 1 doc-drift validation, Phase 3 doc sync).

_Last updated: (bootstrap)._

## Status

<!-- BOOTSTRAP: add one row per existing top-level doc, status "Needs review" until a
     sprint verifies it. New docs created by sprints get a row at sprint close
     (Completion Log: "New docs registered"). -->

| Doc | Status | Last Verified | By Sprint | Notes |
|-----|--------|---------------|-----------|-------|
| `docs/TODOS.md` | Current | — | — | Deferred-work ledger; promote items via `/sprint create`. |

## History

| Date | Sprint | Change |
|------|--------|--------|
| (bootstrap) | — | Initial scaffolding from project-template. |
