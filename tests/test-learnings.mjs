#!/usr/bin/env node
// learnings.mjs is the read-side of the learning loop: non-`plan` learnings used to sit
// in done/ where nothing read them. Covers: class filter, newest-first order, archive
// scanning, only lines under `### Learnings` count, limit, recurring-rule detection
// (3+ distinct sprints), --json shape, usage errors, and an empty repo.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "lite", "scripts", "sprint", "learnings.mjs");
const tmp = mkdtempSync(join(tmpdir(), "learnings-"));
let failed = 0;
const check = (c, m) => { if (!c) { failed++; console.error(`FAIL ${m}`); } };
const run = (...a) => execFileSync("node", [SCRIPT, "--root", tmp, ...a], { encoding: "utf8" });

try {
  // empty repo: no directories at all
  check(/SUMMARY learnings: 0 of 0 shown/.test(run()), "empty repo should report 0 of 0");

  mkdirSync(join(tmp, "docs/sprints/done/archive"), { recursive: true });
  const file = (id, body) => `---\nsprint: ${id}\nstatus: done\n---\n\n# ${id}: x\n\n## Completion Log\n\n### Outcome\n\nShipped.\n\n### Learnings\n\n${body}\n\n### Close checklist\n\n- 2026-01-01 S-999 review: not a learning, wrong section → rule: ignore me\n`;
  writeFileSync(join(tmp, "docs/sprints/done/S-003-c.md"), file("S-003", "- 2026-03-01 S-003 review: missed a null path → rule: Trace nil inputs through every new branch.\n- 2026-03-01 S-003 plan: brief cited a moved file → rule: re-verify citations"));
  writeFileSync(join(tmp, "docs/sprints/done/S-002-b.md"), file("S-002", "- 2026-02-01 S-002 review: missed a null path again → rule: trace nil inputs through every new branch\n- 2026-02-01 S-002 test: mocked the thing under test → rule: mock at the boundary"));
  writeFileSync(join(tmp, "docs/sprints/done/archive/S-001-a.md"), file("S-001", "- 2026-01-01 S-001 review: third time → rule: Trace nil inputs through every new branch"));
  writeFileSync(join(tmp, "docs/sprints/done/S-004-d.md"), file("S-004", "— none"));
  writeFileSync(join(tmp, "docs/sprints/done/README.md"), "### Learnings\n\n- 2026-09-09 S-777 review: not a sprint file → rule: ignore\n");

  let out = run("--class", "review");
  const lines = out.split("\n").filter((l) => l.startsWith("- "));
  check(lines.length === 3, `review class should list 3 lines, got ${lines.length}:\n${out}`);
  check(lines[0].includes("S-003") && lines[2].includes("S-001"), "newest first, archive included");
  check(!out.includes("S-999") && !out.includes("S-777"), "lines outside ### Learnings / non-sprint files must be ignored");
  check(!out.includes("moved file"), "class filter must exclude plan lines");
  check(/RECURRING ×3 \(.*S-001.*\): /.test(out), `rule seen in 3 sprints should be flagged RECURRING:\n${out}`);
  check(/SUMMARY learnings: 3 of 3 shown \(review\), 1 recurring rule\(s\)/.test(out), `summary line wrong:\n${out}`);

  out = run("--class", "review,test", "--limit", "2");
  check(out.split("\n").filter((l) => l.startsWith("- ")).length === 2, "limit caps the listing");
  check(/2 of 4 shown/.test(out), "summary reports shown of total under a limit");
  check(/RECURRING ×3/.test(out), "recurring detection uses all entries, not just the shown ones");

  out = run();
  check(/5 of 5 shown/.test(out), `default lists every class:\n${out}`);

  const j = JSON.parse(run("--json", "--class", "test"));
  check(j.total === 1 && j.entries[0].sprint === "S-002" && j.entries[0].rule === "mock at the boundary" && Array.isArray(j.recurring), "--json shape");

  for (const bad of [["--class", "nonsense"], ["--limit", "0"], ["--limit", "abc"]]) {
    const r = spawnSync("node", [SCRIPT, "--root", tmp, ...bad], { encoding: "utf8" });
    check(r.status === 1 && /usage:/.test(r.stderr), `bad args ${bad.join(" ")} should exit 1 with usage`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
if (failed) { console.error(`test-learnings: ${failed} check(s) failed`); process.exit(1); }
console.log("test-learnings: all checks passed");
