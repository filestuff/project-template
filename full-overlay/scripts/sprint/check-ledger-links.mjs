#!/usr/bin/env node
// Ledger auditor for the hand-written ledgers regen.mjs cannot rebuild:
//   - every link to a finished sprint file in docs/sprints/INDEX.md and docs/TODOS.md
//     resolves. A finished sprint lives at done/<bucket>/ for good (scripts/sprint/
//     paths.mjs), so a link only rots when it was written against the pre-v1.19.0
//     layout (flat done/ or done/archive/), typo'd, or points at a deleted file.
//   - every row id in docs/TODOS.md's table is unique.
//
//   check-ledger-links.mjs             # fix mode: rewrite a legacy done/X.md or
//                                      # done/archive/X.md link to done/<bucket>/X.md where
//                                      # that file exists, print each rewrite; exit 0, or 2
//                                      # if unfixable problems remain
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
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { bucketOf, repoRoot } from "./paths.mjs";

// `(<prefix>done/[archive/|<bucket>/]S-NNN-….md)` — a markdown link target into done/.
const DONE_LINK_RE = /\(([^()\s]*?)(done\/(?:archive\/|\d{4,}-\d{4,}\/)?)(S-(\d+)[A-Za-z0-9_.-]*\.md)\)/g;

// Scan `filePath` for every link into done/ and resolve it against the file's folder, or
// against `root` (prose often cites repo-root paths: `(docs/sprints/done/…)`).
// Returns { rewrites, failures } — never throws on a bad link.
// `rewrites`: links whose target exists at its bucket path instead.
// `failures`: links whose target does not exist at either place.
// With `{ fix: true }`, rewrites `filePath` in place for every entry in `rewrites`.
export function checkLinks(filePath, { fix = false, root = null } = {}) {
  const text = readFileSync(filePath, "utf8");
  const bases = [dirname(filePath), ...(root ? [root] : [])];
  const exists = (rel) => bases.some((b) => existsSync(join(b, rel)));
  const seen = new Set();
  const rewrites = [];
  const failures = [];
  for (const m of text.matchAll(DONE_LINK_RE)) {
    const [, prefix, folder, name, num] = m;
    const link = `${prefix}${folder}${name}`;
    if (seen.has(link)) continue;
    seen.add(link);
    if (exists(link)) continue;
    const home = `${prefix}done/${bucketOf(`S-${num}`)}/${name}`;
    if (exists(home)) rewrites.push({ from: link, to: home });
    else failures.push(link);
  }

  if (fix && rewrites.length > 0) {
    let out = text;
    for (const r of rewrites) out = out.split(`(${r.from})`).join(`(${r.to})`);
    writeFileSync(filePath, out);
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
    mkdirSync(join(sprintsRoot, "done", "0000-0099"), { recursive: true });
    writeFileSync(join(sprintsRoot, "done", "0000-0099", "S-7-resolvable.md"), "# S-7\n");
    writeFileSync(join(sprintsRoot, "done", "0000-0099", "S-8-moved.md"), "# S-8\n");
    // S-9 deliberately has no file anywhere — the dangling-link fixture.

    const indexPath = join(sprintsRoot, "INDEX.md");
    const fixture =
      "| [S-7](done/0000-0099/S-7-resolvable.md) |\n" +
      "| [S-8](done/archive/S-8-moved.md) |\n" +
      "| [S-9](done/S-9-missing.md) |\n";
    writeFileSync(indexPath, fixture);

    // read-only: reports the rewrite candidate and the hard failure, skips the
    // resolvable link, writes nothing.
    {
      const { rewrites, failures } = checkLinks(indexPath, { fix: false });
      assert.deepStrictEqual(rewrites.map((r) => r.from), ["done/archive/S-8-moved.md"]);
      assert.deepStrictEqual(failures, ["done/S-9-missing.md"]);
      assert.strictEqual(readFileSync(indexPath, "utf8"), fixture, "read-only mode must not write");
    }

    // fix: rewrites the legacy link to the bucket, leaves the dangling one as-is and reports it.
    {
      const { rewrites, failures } = checkLinks(indexPath, { fix: true });
      assert.deepStrictEqual(rewrites.map((r) => r.to), ["done/0000-0099/S-8-moved.md"]);
      assert.deepStrictEqual(failures, ["done/S-9-missing.md"]);
      const after = readFileSync(indexPath, "utf8");
      assert.ok(after.includes("(done/0000-0099/S-8-moved.md)"), "legacy link rewritten");
      assert.ok(after.includes("(done/S-9-missing.md)"), "dangling link left unrewritten");
    }

    // idempotent re-run: nothing left to rewrite, the dangling link still fails.
    {
      const { rewrites, failures } = checkLinks(indexPath, { fix: true });
      assert.deepStrictEqual(rewrites, []);
      assert.deepStrictEqual(failures, ["done/S-9-missing.md"]);
    }

    // a link with a relative prefix (TODOS lives in docs/, the sprints one level down)
    {
      const todos = join(sprintsRoot, "T.md");
      writeFileSync(todos, "see [S-8](./done/S-8-moved.md)\n");
      const { rewrites } = checkLinks(todos, { fix: true });
      assert.deepStrictEqual(rewrites.map((r) => r.to), ["./done/0000-0099/S-8-moved.md"]);
      // a repo-root path in prose resolves against `root`
      mkdirSync(join(sprintsRoot, "docs"), { recursive: true });
      const nested = join(sprintsRoot, "docs", "N.md");
      writeFileSync(nested, "(done/0000-0099/S-7-resolvable.md)\n");
      assert.deepStrictEqual(checkLinks(nested).failures, ["done/0000-0099/S-7-resolvable.md"]);
      assert.deepStrictEqual(checkLinks(nested, { root: sprintsRoot }).failures, []);
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

  const rewrites = [];
  const failures = [];
  for (const file of [indexPath, todosPath]) {
    if (!existsSync(file)) continue;
    const rel = file.slice(root.length + 1);
    const r = checkLinks(file, { fix: !checkMode, root });
    rewrites.push(...r.rewrites.map((x) => ({ ...x, file: rel })));
    failures.push(...r.failures.map((f) => `${rel}: (${f})`));
  }
  const { duplicates } = existsSync(todosPath) ? checkTodosIds(todosPath) : { duplicates: [] };

  const problems = [
    ...rewrites.map((r) => `${checkMode ? "needs rewrite" : "rewrote"} in ${r.file}: (${r.from}) -> (${r.to})`),
    ...failures.map((f) => `unresolved link, no target at its path or its done/<bucket>/ home: ${f}`),
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
