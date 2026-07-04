# Migrations

Version-crossing scripts executed **in the downstream repo** by `/template-upgrade`,
after the file-level plan/apply pass. Use a migration for anything a three-way file
merge cannot express; use plain template edits (+ VERSION bump) for everything else.

## Naming and selection

- Scripts are named `vX.Y.Z.sh` — "run when crossing X.Y.Z upward".
- `/template-upgrade` runs every migration where `old < X.Y.Z <= new`, in ascending
  version order, from the freshly fetched new template tree (`work/new/migrations/`).
- Execution: `bash`, with **cwd = the downstream repo root** (not the template).

## Environment contract

Each migration runs with these variables set:

| Variable | Value |
|---|---|
| `TEMPLATE_OLD_VERSION` | version being upgraded from (e.g. `1.0.0`) |
| `TEMPLATE_NEW_VERSION` | version being upgraded to |
| `TEMPLATE_TIER` | `lite` or `full` (from the downstream manifest) |
| `TEMPLATE_DIR` | absolute path to the extracted NEW template tree |
| `REPO_ROOT` | absolute path to the downstream repo root (== cwd) |
| `JOURNAL_FILE` | `<git-dir>/template-update/migrations/vX.Y.Z.journal` |

## Idempotency (required)

Migrations may be re-run after a partial failure. Journal every step:

```bash
grep -qxF "step-name" "$JOURNAL_FILE" 2>/dev/null || {
  do_the_step
  echo "step-name" >> "$JOURNAL_FILE"
}
```

The runner touches `vX.Y.Z.done` beside the journal when the script exits 0 and
skips `.done`-marked migrations on re-runs. A failing migration is **non-fatal**:
the failure is reported, remaining migrations still run, and the un-`.done`-marked
script is retried on the next `/template-upgrade` pass.

## Tier awareness (required)

Every migration must check `TEMPLATE_TIER` and no-op cleanly (exit 0) when it
doesn't apply:

```bash
[ "$TEMPLATE_TIER" = "full" ] || exit 0   # full-only migration
```

## What belongs in a migration

Things the file-level three-way merge can't do:

- Frontmatter additions across **live** sprint files (backlog/in-progress/done) —
  the merge only sees template-managed files, not files the workflow created.
- Generated-skeleton changes to INDEX.md / ROADMAP.md (seeded class — never
  auto-merged); typically edit the markers then run `node scripts/sprint/regen.mjs`.
- File renames/moves (the plan classifies these as removed + added; a migration
  can `git mv` and preserve history).
- `.claude/settings.json` key migrations beyond the additive union that
  `merge-settings` performs (renames, removals, value rewrites).
- Hook re-wiring (pre-push hook path changes, husky migrations).

## What does NOT belong here

Ordinary content changes to managed files (skills, PROTOCOL, scripts): just edit
the template — the upgrade merge handles those. A migration that rewrites a
managed file will fight the merge engine.
