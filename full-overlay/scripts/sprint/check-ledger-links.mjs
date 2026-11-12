#!/usr/bin/env node
// Ledger auditor for the two hand-maintained ledgers regen.mjs cannot rebuild:
//   - every `(done/X.md)` link in docs/sprints/INDEX.md resolves. Archive
//     rotation (merge-sprint.sh keeps the 10 newest sprints in done/) moves
//     older files to done/archive/; merge-sprint.sh relinks those inline at
//     land time — this catches everything else (a land that skipped the relink,
//     typo'd paths, links into deleted files).
//   - every row id in docs/TODOS.md's table is unique.
//
//   check-ledger-links.mjs             # fix mode: rewrite done/X.md -> done/archive/X.md
//                                      # where only the archived file exists, print each
//                                      # rewrite; exit 0, or 2 if unfixable problems remain
//   check-ledger-links.mjs --check     # read-only: exit 2 listing every unresolved /
//                                      # rewrite-needed link or duplicate TODOS id, 0 if clean
//   check-ledger-links.mjs --self-test # fixture assertions in a temp dir; exit 0/1,
//                                      # touches nothing under docs/
//
// Exit codes: 0 clean (or fixed) · 2 problems found/remaining · 1 self-test failure.
// regen.mjs --check runs the same checks. Importable: checkLinks, checkTodosIds

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./frontmatter.mjs";

// Same link shape merge-sprint.sh's inline relink greps for — keep the two in step.
const DONE_LINK_RE = /\(done\/[A-Za-z0-9_.-]*\.md\)/g;

// Scan `indexPath` for every `(done/X.md)` link and resolve it against
// `sprintsRoot`. Returns { rewrites, failures } — never throws on a bad link.
// `rewrites`: links whose target now lives only under `done/archive/`.
// `failures`: links whose target does not exist anywhere.
// With `{ fix: true }`, rewrites `indexPath` in place for every entry in `rewrites`.
export function checkLinks(indexPath, sprintsRoot, { fix = false } = {}) {
  const text = readFileSync(indexPath, "utf8");
  const links = [...new Set((text.match(DONE_LINK_RE) ?? []).map((m) => m.slice(1, -1)))];

  const rewrites = [];
  const failures = [];
  for (const link of links) {
    if (existsSync(join(sprintsRoot, link))) continue;
    const archived = `done/archive/${link.slice("done/".length)}`;
    if (existsSync(join(sprintsRoot, archived))) rewrites.push({ from: link, to: archived });
    else failures.push(link);
  }

  if (fix && rewrites.length > 0) {
    let out = text;
    for (const r of rewrites) out = out.split(`(${r.from})`).join(`(${r.to})`);
    writeFileSync(indexPath, out);
  }

  return { rewrites, failures };
}

// A renumbered row may leave a tombstone that keeps its old id as a pointer
// (`| 3 | see #9 (renumbered …) |`) — not a second live claim on that id.
const TOMBSTONE_ITEM_RE = /^see #\d+ \(renumbered\b/;

// Parse every `| N |` table-row id in `todosPath` and return the ids that occur
// more than once across live (non-tombstone) rows.
export function checkTodosIds(todosPath) {
  const text = readFileSync(todosPath, "utf8");
  const seen = new Set();
  const duplicates = new Set();
  for (const line of text.split("\n")) {
    const m = line.match(/^\|\s*(\d+)\s*\|\s*(.*)$/);
    if (!m) continue;
    const [, id, rest] = m;
    if (TOMBSTONE_ITEM_RE.test(rest.trim())) continue;
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return { duplicates: [...duplicates].sort((a, b) => Number(a) - Number(b)) };
}

function runSelfTest() {
  const sprintsRoot = mkdtempSync(join(tmpdir(), "check-ledger-links-selftest-"));
  try {
    mkdirSync(join(sprintsRoot, "done", "archive"), { recursive: true });
    writeFileSync(join(sprintsRoot, "done", "S-7-resolvable.md"), "# S-7\n");
    writeFileSync(join(sprintsRoot, "done", "archive", "S-8-archived.md"), "# S-8\n");
    // S-9 deliberately has no file anywhere — the dangling-link fixture.

    const indexPath = join(sprintsRoot, "INDEX.md");
    const fixture =
      "| [S-7](done/S-7-resolvable.md) |\n" +
      "| [S-8](done/S-8-archived.md) |\n" +
      "| [S-9](done/S-9-missing.md) |\n";
    writeFileSync(indexPath, fixture);

    // read-only: reports the rewrite candidate and the hard failure, skips the
    // resolvable link, writes nothing.
    {
      const { rewrites, failures } = checkLinks(indexPath, sprintsRoot, { fix: false });
      assert.deepStrictEqual(rewrites.map((r) => r.from), ["done/S-8-archived.md"]);
      assert.deepStrictEqual(failures, ["done/S-9-missing.md"]);
      assert.strictEqual(readFileSync(indexPath, "utf8"), fixture, "read-only mode must not write");
    }

    // fix: rewrites the archive-rotated link, leaves the dangling one as-is and reports it.
    {
      const { rewrites, failures } = checkLinks(indexPath, sprintsRoot, { fix: true });
      assert.deepStrictEqual(rewrites.map((r) => r.to), ["done/archive/S-8-archived.md"]);
      assert.deepStrictEqual(failures, ["done/S-9-missing.md"]);
      const after = readFileSync(indexPath, "utf8");
      assert.ok(after.includes("(done/archive/S-8-archived.md)"), "archive link rewritten");
      assert.ok(after.includes("(done/S-9-missing.md)"), "dangling link left unrewritten");
    }

    // idempotent re-run: nothing left to rewrite, the dangling link still fails.
    {
      const { rewrites, failures } = checkLinks(indexPath, sprintsRoot, { fix: true });
      assert.deepStrictEqual(rewrites, []);
      assert.deepStrictEqual(failures, ["done/S-9-missing.md"]);
    }

    // TODOS ids: one duplicate across live rows, one clean id, and one renumber
    // tombstone that reuses its old id — the tombstone must NOT count.
    {
      const todosPath = join(sprintsRoot, "TODOS.md");
      writeFileSync(
        todosPath,
        "| # | Item | Deferred from | Why | Status |\n" +
          "|---|------|---------------|-----|--------|\n" +
          "| 1 | dup one | x | y | open |\n" +
          "| 2 | clean | x | y | open |\n" +
          "| 1 | dup two | x | y | open |\n" +
          "| 3 | live row that kept its id | x | y | open |\n" +
          "| 3 | see #9 (renumbered — duplicate id) | — | — | closed |\n",
      );
      assert.deepStrictEqual(checkTodosIds(todosPath).duplicates, ["1"]);
    }

    console.log("self-test OK");
  } finally {
    rmSync(sprintsRoot, { recursive: true, force: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    try {
      runSelfTest();
      process.exit(0);
    } catch (err) {
      console.error(err);
      process.exit(1);
    }
  }

  const checkMode = args.includes("--check");
  const root = repoRoot();
  const sprintsRoot = join(root, "docs/sprints");
  const indexPath = join(sprintsRoot, "INDEX.md");
  const todosPath = join(root, "docs/TODOS.md");

  const { rewrites, failures } = checkLinks(indexPath, sprintsRoot, { fix: !checkMode });
  const { duplicates } = existsSync(todosPath) ? checkTodosIds(todosPath) : { duplicates: [] };

  const problems = [
    ...rewrites.map((r) => `${checkMode ? "needs rewrite" : "rewrote"}: (${r.from}) -> (${r.to})`),
    ...failures.map((f) => `unresolved link, no target in done/ or done/archive/: (${f})`),
    ...(duplicates.length > 0 ? [`duplicate TODOS ids: ${duplicates.map((d) => `#${d}`).join(", ")}`] : []),
  ];
  if (problems.length > 0) console.log(problems.join("\n"));

  // Rewrites are fixed in fix mode; unresolved links and duplicate ids need a human.
  const remaining = failures.length + duplicates.length + (checkMode ? rewrites.length : 0);
  if (remaining > 0) process.exit(2);
  console.log(
    checkMode ? "ledger links + TODOS ids clean" : rewrites.length ? "ledger links fixed" : "no changes needed",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main();
}
