#!/usr/bin/env node
// tiers.mjs is the feedback loop for model routing: it reads the `outcome:` line each
// landed sprint carries and says whether a tier is assigned to work that is too hard for
// it (UNDER), finishes but not cleanly (STRAINED), or may be over-provisioned (OVER?).
// A wrong flag here moves spend or quality in the wrong direction, so the thresholds and
// the minimum sample are pinned. The outcome line is written with the real frontmatter.mjs
// — the same command the orchestrator runs at land — to prove it survives the round trip.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "full-overlay", "scripts", "sprint");
const SCRIPT = join(DIR, "tiers.mjs");
const FM = join(DIR, "frontmatter.mjs");
const tmp = mkdtempSync(join(tmpdir(), "tiers-"));
let failed = 0;
const check = (c, m) => { if (!c) { failed++; console.error(`FAIL ${m}`); } };
const run = (...a) => execFileSync("node", [SCRIPT, "--root", tmp, ...a], { encoding: "utf8" });
let n = 0;
// landed(tier, outcome | null, { dir, end }) → writes a done-file, outcome set via frontmatter.mjs
function landed(tier, outcome, { dir = "done", end = "2026-11-01", reason = "x" } = {}) {
  const id = `S-${String(++n).padStart(3, "0")}`;
  const f = join(tmp, "docs/sprints", dir, `${id}-s.md`);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, `---\nsprint: ${id}\nstatus: done\nstory_points: 2\nrisk: low\ntier: ${tier}\ntier_reason: ${reason}\nend_date: ${end}\ntouches: []\n---\n\n# ${id}: s\n`);
  if (outcome) execFileSync("node", [FM, "set", f, "outcome", outcome]);
  return id;
}
const O = (assigned, final, { runs = 1, esc = 0, arb = 0, fix = 0, findings = "0/0" } = {}) => `assigned=${assigned} final=${final} runs=${runs} escalations=${esc} arbiter=${arb} fix_rounds=${fix} findings=${findings}`;

try {
  check(/no sprint has an outcome: line yet/.test(run()) && /0 sprint\(s\) with an outcome, 0 without; 0 flag/.test(run()), "empty repo: nothing to report, exit 0");

  // round trip: the line the orchestrator writes is the line tiers.mjs reads
  const first = landed("standard", O("standard", "complex", { esc: 1, fix: 1, findings: "2/3" }));
  let j = JSON.parse(run("--json"));
  check(j.tracked === 1 && j.sprints[0].sprint === first && j.sprints[0].final === "complex" && j.sprints[0].escalations === 1 && j.sprints[0].confirmed === 2 && j.sprints[0].raised === 3, `outcome line survives frontmatter.mjs set → tiers.mjs: ${JSON.stringify(j.sprints[0])}`);
  check(j.flags.length === 0 && /fewer than 4 — too few to judge/.test(run()), "one sprint escalating is not a pattern — below the minimum sample nothing is flagged");

  // UNDER: 2 of 4 standard sprints escalated (≥25%)
  landed("standard", O("standard", "standard"));
  landed("standard", O("standard", "standard"));
  landed("standard", O("standard", "critical", { esc: 2 }));
  let out = run();
  check(/^UNDER standard: 2\/4 standard sprints escalated \(S-001, S-004\)/m.test(out) && /routing\.json/.test(out), `UNDER when ≥25% of a tier escalates:\n${out}`);
  check(/standard\s+4 sprint\(s\)\s+escalated\s+50%/.test(out), `per-tier line:\n${out}`);

  // STRAINED: routine never escalates, but 2 of 4 need two fix rounds / a re-launch
  landed("routine", O("routine", "routine", { fix: 2 }));
  landed("routine", O("routine", "routine", { runs: 2 }));
  landed("routine", O("routine", "routine"));
  landed("routine", O("routine", "routine", { findings: "1/1" }));
  out = run();
  check(/^STRAINED routine: 2\/4 routine sprints/m.test(out) && !/UNDER routine/.test(out), `STRAINED when ≥40% finish uncleanly:\n${out}`);

  // OVER?: 8 clean complex sprints — and never for 7, never for a lower tier
  for (let i = 0; i < 7; i++) landed("complex", O("complex", "complex"), { dir: i % 2 ? "done/archive" : "done" });
  check(!/OVER\?/.test(run()), "seven clean complex sprints are not yet enough to question the tier");
  landed("complex", O("complex", "complex"));
  out = run();
  check(/^OVER\? complex: 8 complex sprints ran clean/m.test(out), `OVER? after 8 clean sprints of a top tier (archive included):\n${out}`);
  landed("complex", O("complex", "complex", { findings: "1/2" }));
  check(!/OVER\?/.test(run()), "one confirmed finding withdraws OVER? — the tier is earning its cost");

  // untracked sprints, malformed outcomes, --since
  landed("standard", null);                                    // solo / pre-1.14: no outcome
  landed("standard", "assigned=huge final=standard");          // unknown tier → ignored, counted as untracked
  landed("critical", O("critical", "critical"), { end: "2026-12-05" });
  j = JSON.parse(run("--json"));
  check(j.untracked === 2 && j.tracked === 18, `untracked and malformed outcomes are counted apart: tracked ${j.tracked}, untracked ${j.untracked}`);
  j = JSON.parse(run("--json", "--since", "2026-12-01"));
  check(j.tracked === 1 && j.tiers.critical?.sprints === 1 && !j.tiers.standard, "--since filters on end_date");
  check(spawnSync("node", [SCRIPT, "--root", tmp, "--since", "soon"], { encoding: "utf8" }).status === 1, "bad --since exits 1");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
if (failed) { console.error(`test-tiers: ${failed} check(s) failed`); process.exit(1); }
console.log("test-tiers: all checks passed");
