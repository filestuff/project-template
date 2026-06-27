# Sprint Roadmap

_Last updated: (bootstrap)._

Dependency graph across backlog + in-progress sprints for {{PROJECT_NAME}}. Edges are
`depends_on`; node color tracks `status` (backlog=orange, in-progress=yellow, done=green);
story points appear in the node label. Regeneration rules: `docs/sprints/PROTOCOL.md`.

<!-- BEGIN GENERATED: graph -->
```mermaid
graph TD
  classDef backlog fill:#fed7aa,stroke:#c2410c,color:#7c2d12;
  classDef inprogress fill:#fde68a,stroke:#b45309,color:#78350f;
  classDef done fill:#bbf7d0,stroke:#15803d,color:#14532d;



```
<!-- END GENERATED: graph -->

<!-- BEGIN GENERATED: critical-path -->
**Critical path (0 pts — the longest dependency chain):** `` (0 pts done; 0 remaining).
<!-- END GENERATED: critical-path -->

## Parallel Waves

Each wave is a set of sprints that can run **concurrently**: every dependency is met by an
earlier wave, and the members claim disjoint files (`touches:`). A `depends_on` edge always
forces ordering — to build a dependent in parallel before its blocker lands, use the blocker's
**Interface Contract** (sprint body). A sprint with no `touches:` can't be proven safe, so it
gets its own wave. Derived by `scripts/sprint/claims.mjs` (`computeWaves`); regenerated with the
rest of this file.

<!-- BEGIN GENERATED: waves -->
_(no pending sprints)_
<!-- END GENERATED: waves -->

## Status

<!-- LLM-maintained narrative: what's in flight, what just unblocked, current
     phasing. Edited only on main under lock (PROTOCOL Phase 3 Step 5.2). -->

_(bootstrap — no sprints yet)_
