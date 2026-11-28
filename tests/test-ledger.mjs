#!/usr/bin/env node
// ledger.mjs: the Done ledger is generated from each finished sprint's `summary:` — INDEX's
// recent-done block (newest RECENT) and one LEDGER.md per hundred ids — and --check fails on
// drift, a duplicate id, a done file outside its bucket, or a stacked INDEX header.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../lite/scripts/sprint/ledger.mjs", import.meta.url).pathname;
const INDEX_TEMPLATE = new URL("../lite/docs/sprints/INDEX.md", import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), "ledger-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
let failed = 0;
const check = (c, m, extra = "") => {
  if (!c) {
    failed++;
    console.error(`FAIL ${m}${extra ? `\n${extra}` : ""}`);
  }
};
const S = join(tmp, "docs/sprints");
const run = (...a) => spawnSync("node", [SCRIPT, "--root", tmp, ...a], { encoding: "utf8" });
const index = () => readFileSync(join(S, "INDEX.md"), "utf8");
function done(rel, id, { summary = null, end = "2026-11-01", short = null } = {}) {
  const f = join(S, rel);
  mkdirSync(join(f, ".."), { recursive: true });
  const lines = ["---", `sprint: ${id}`, "status: done", "goal: g # a comment", "story_points: 3", `end_date: ${end}`];
  if (short) lines.push(`short: ${short}`);
  if (summary !== undefined) lines.push(`summary: ${summary === null ? "null" : summary}`);
  writeFileSync(f, `${lines.join("\n")}\n---\n\n# ${id}: x\n`);
}

mkdirSync(S, { recursive: true });
writeFileSync(join(S, "INDEX.md"), readFileSync(INDEX_TEMPLATE, "utf8"));

// empty: the block says so, check is clean
let r = run();
check(r.status === 0 && /_\(none yet\)_/.test(index()), `empty ledger: ${r.stdout}${r.stderr}`);
check(run("--check").status === 0, "empty ledger --check clean");

// 25 sprints across two buckets; one quoted summary with a pipe and a #
for (let n = 76; n <= 100; n++) done(`done/${n < 100 ? "0000-0099" : "0100-0199"}/S-${String(n).padStart(3, "0")}-s${n}.md`, `S-${String(n).padStart(3, "0")}`, { summary: `"Shipped ${n}."`, end: `2026-10-${String(n - 75).padStart(2, "0")}` });
done("done/0000-0099/S-075-piped.md", "S-075", { summary: JSON.stringify("Split a | b (TODOS #12)."), end: "2026-09-01", short: "piped" });
done("done/0000-0099/S-074-unwritten.md", "S-074", { summary: null, end: "2026-09-01" });

r = run("--check");
check(r.status === 2 && /drift:/.test(r.stdout), `--check reports drift before a write: ${r.stdout}`);
r = run();
check(r.status === 0, `write: ${r.stdout}${r.stderr}`);
const block = index().split("<!-- BEGIN GENERATED: recent-done -->")[1].split("<!-- END GENERATED: recent-done -->")[0];
const rows = block.split("\n").filter((l) => /^\| \[S-/.test(l));
check(rows.length === 20, `recent-done holds 20 rows: ${rows.length}`);
check(rows[0].startsWith("| [S-100](done/0100-0199/S-100-s100.md) |"), `newest end_date first, linked to its bucket: ${rows[0]}`);
check(/27 done/.test(block) && /\[0100-0199\]\(done\/0100-0199\/LEDGER\.md\) · \[0000-0099\]\(done\/0000-0099\/LEDGER\.md\)/.test(block), `count line + ledger links, newest bucket first:\n${block}`);

const l0 = readFileSync(join(S, "done/0000-0099/LEDGER.md"), "utf8");
check(/^# Done ledger — S-0 to S-99/.test(l0), "ledger title");
check(l0.includes("| [S-075](S-075-piped.md) | piped | 3 | 2026-09-01 | Split a \\| b (TODOS #12). |"), `quoted summary kept whole, pipe escaped:\n${l0}`);
check(l0.includes("| [S-074](S-074-unwritten.md) | unwritten | 3 | 2026-09-01 | — |"), "a null summary renders as —");
check(l0.indexOf("S-074") < l0.indexOf("S-075") && l0.indexOf("S-075") < l0.indexOf("S-099"), "ledger rows by id");
check(existsSync(join(S, "done/0100-0199/LEDGER.md")), "second bucket's ledger written");
check(run("--check").status === 0, "--check clean after write");
check(run().stdout.includes("unchanged"), "re-run writes nothing");

// problems regenerating cannot fix
writeFileSync(join(S, "INDEX.md"), index().replace(/^(_Last updated[^\n]*\n)/m, "$1\n_Previously: Last updated: older._\n"));
r = run("--check");
check(r.status === 2 && /index-header: INDEX\.md has 1 `_Last updated` and 1 `_Previously`/.test(r.stdout), `stacked header: ${r.stdout}`);
writeFileSync(join(S, "INDEX.md"), index().replace(/\n_Previously[^\n]*\n/, ""));
writeFileSync(join(S, "ROADMAP.md"), "# Roadmap\n\n_Last updated: new._\n\n_Last updated: old._\n");
r = run("--check");
check(r.status === 2 && /index-header: ROADMAP\.md has 2 `_Last updated`/.test(r.stdout), `stacked ROADMAP header: ${r.stdout}`);
rmSync(join(S, "ROADMAP.md"));
done("done/S-200-flat.md", "S-200", { summary: '"Legacy."' });
r = run("--check");
check(r.status === 2 && /legacy-layout: 1 done sprint\(s\) outside done\/<bucket>\//.test(r.stdout), `legacy layout: ${r.stdout}`);
rmSync(join(S, "done/S-200-flat.md"));
mkdirSync(join(S, "backlog"), { recursive: true });
writeFileSync(join(S, "backlog/S-75-again.md"), "---\nsprint: S-75\n---\n");
r = run("--check");
check(r.status === 2 && /duplicate-id: S-075/.test(r.stdout), `duplicate id: ${r.stdout}`);
rmSync(join(S, "backlog/S-75-again.md"));
r = run();
check(r.status === 0 && run("--check").status === 0, `clean again: ${r.stdout}`);

// missing markers → exit 1 with the way out
writeFileSync(join(S, "INDEX.md"), "# Sprint Index\n\n## Done\n\n| Sprint |\n");
r = run();
check(r.status === 1 && /migrations\/v1\.19\.0\.sh/.test(r.stderr), `missing markers: ${r.stderr}`);

if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("test-ledger: all checks passed");
