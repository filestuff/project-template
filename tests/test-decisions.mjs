#!/usr/bin/env node
// decisions.mjs is the audit view of DECISION_POLICY.md: the only way to see, across every
// sprint and proposal, what was decided on the user's behalf. Covers: the full grammar,
// pre-policy lines (`(wave)`, `(train, auto)`), filters, ordering, the `THIN` flag for a
// taste decision missing its rejected option or undo, and that look-alike lines
// (non-decision parentheticals, template comments, code fences) are ignored.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "lite", "scripts", "sprint", "decisions.mjs");
const tmp = mkdtempSync(join(tmpdir(), "decisions-"));
let failed = 0;
const check = (c, m) => { if (!c) { failed++; console.error(`FAIL ${m}`); } };
const run = (...a) => execFileSync("node", [SCRIPT, "--root", tmp, ...a], { encoding: "utf8" });
const w = (rel, body) => { mkdirSync(dirname(join(tmp, rel)), { recursive: true }); writeFileSync(join(tmp, rel), body); };

try {
  check(/SUMMARY decisions: 0 of 0 shown/.test(run()), "empty repo reports 0 of 0");

  w("docs/sprints/in-progress/S-005-a.md", `# S-005: a

## Pre-Sprint Decisions

- 2026-11-10 (gated, taste, arbiter): use the existing retry helper — principle: decision ladder rung 2 — rejected: a new backoff module — undo: swap the call in src/x.ts
- 2026-11-11 (wave, mechanical, agent): keep the v2 schema — principle: ADR-004
- 2026-11-12 (gated wave, taste, orchestrator): name the table sessions_v2 — principle: explicit over clever
- 2026-11-09 (wave): batch size 50 — rationale from the planner
- 2026-11-08 (train, auto): reuse the queue — smaller blast radius
- 2026-11-07 (Tuesday): not a decision line
- 2026-11-06 (interactive, reserved, user): ship behind a flag — rejected: all at once
<!-- - 2026-01-01 (gated, taste, agent): inside a comment -->

\`\`\`
- 2026-01-02 (gated, taste, agent): inside a fence
\`\`\`
`);
  w("docs/sprints/done/archive/S-001-old.md", "## Pre-Sprint Decisions\n\n- 2026-10-01 (wave, in-flight): renamed the hook\n");
  w("docs/proposals/003-thing.md", "## Decision log\n\n- 2026-11-12 (gated, taste, arbiter): one queue not two — principle: KISS — rejected: per-tenant queues — undo: split by tenant id\n");
  w("docs/proposals/PROPOSAL_TEMPLATE.md", "- 2026-11-12 (gated, taste, agent): template example must be ignored\n");

  let out = run();
  check(/SUMMARY decisions: 8 of 8 shown — 1 mechanical, 4 taste, 1 reserved, 2 unclassified; 1 thin/.test(out), `summary counts wrong:\n${out}`);
  check(!/Tuesday|inside a comment|inside a fence|template example/.test(out), "look-alike lines must be ignored");
  const order = out.split("\n").filter((l) => /^\d{4}-/.test(l)).map((l) => l.slice(0, 10));
  check(order[0] === "2026-11-12" && order[order.length - 1] === "2026-10-01", `newest first: ${order.join(",")}`);
  check(/THIN docs\/sprints\/in-progress\/S-005-a\.md:\d+ — taste decision without a rejected option/.test(out), `a taste decision with no rejected option must be flagged THIN:\n${out}`);
  check((out.match(/^THIN /gm) ?? []).length === 1, "the pre-policy (train, auto) line is not THIN — it predates the grammar");
  check(/2026-11-08\s+taste\s+orchestrator\s+S-005: reuse the queue/.test(out), "(train, auto) reads as taste by the orchestrator");
  check(/2026-11-12\s+taste\s+orchestrator\s+S-005: name the table sessions_v2/.test(out), `a space-separated mode tag ("gated wave") must still be read — seen in a live run:\n${out}`);
  check(/principle: decision ladder rung 2 · rejected: a new backoff module · undo: swap the call in src\/x\.ts/.test(out), "principle / rejected / undo are parsed out");
  check(/docs\/proposals\/003-thing\.md:3/.test(out) && /003-thing: one queue not two/.test(out), "proposal decision logs are read, with file:line");

  out = run("--class", "taste", "--decider", "arbiter");
  check(/2 of 2 shown/.test(out) && !/sessions_v2/.test(out), `class + decider filters:\n${out}`);
  out = run("--since", "2026-11-11");
  check(/3 of 3 shown/.test(out), `--since filter:\n${out}`);
  out = run("--limit", "2");
  check(/2 of 8 shown/.test(out), `--limit:\n${out}`);
  const j = JSON.parse(run("--json", "--class", "reserved"));
  check(j.total === 1 && j.entries[0].decider === "user" && j.entries[0].rejected === "all at once" && j.counts.reserved === 1, "--json shape");

  for (const bad of [["--class", "nope"], ["--since", "yesterday"], ["--limit", "0"], ["--decider", "me"]]) {
    const r = spawnSync("node", [SCRIPT, "--root", tmp, ...bad], { encoding: "utf8" });
    check(r.status === 1 && /usage:/.test(r.stderr), `bad args ${bad.join(" ")} should exit 1`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
if (failed) { console.error(`test-decisions: ${failed} check(s) failed`); process.exit(1); }
console.log("test-decisions: all checks passed");
