# Architecture Decision Records

One file per decision: `NNN-kebab-case-title.md`, numbered sequentially, zero-padded to 3
digits. Managed by the `/adr` skill (create / list / supersede / check).

Format: Status (Accepted | Superseded by ADR-NNN), Date, Sprint, Context, Decision,
Consequences, Alternatives Considered, Implementation.

Conventions:
- ADRs are append-only history — never rewrite a decision; supersede it.
- `/adr check` runs at every sprint close (PROTOCOL Phase 3) to catch undocumented decisions.
- Commit message: `docs: ADR-NNN — [title]`.
