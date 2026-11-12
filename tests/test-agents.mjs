#!/usr/bin/env node
// agents.mjs turns the hook-written event log into "who is running, for how long" — the
// only view of a wave's agents that does not depend on the orchestrator's own notes.
// Covers: running vs finished pairing, per-type counts and durations, --since, --json,
// a torn line, a stop with no start, and a repo with no log at all.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "full-overlay", "scripts", "sprint", "agents.mjs");
const tmp = mkdtempSync(join(tmpdir(), "agents-"));
let failed = 0;
const check = (c, m) => { if (!c) { failed++; console.error(`FAIL ${m}`); } };
const run = (...a) => execFileSync("node", [SCRIPT, "--root", tmp, ...a], { encoding: "utf8" });
try {
  check(/running: none/.test(run()) && /0 running, 0 finished/.test(run()), "no log → nothing running, exit 0");
  mkdirSync(join(tmp, ".claude/sprint-orchestration"), { recursive: true });
  const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
  const ev = (event, type, id, min) => JSON.stringify({ ts: ago(min), event, agent_type: type, agent_id: id, session_id: "s" });
  writeFileSync(join(tmp, ".claude/sprint-orchestration/events.jsonl"), [
    ev("start", "sprint-executor", "e1", 60), ev("stop", "sprint-executor", "e1", 40),   // 20 min
    ev("start", "sprint-executor", "e2", 50), ev("stop", "sprint-executor", "e2", 40),   // 10 min
    ev("start", "reviewer", "r1", 30), ev("stop", "reviewer", "r1", 28),                 // 2 min
    ev("start", "sprint-executor", "e3", 25),                                            // still running
    ev("start", "arbiter", "a1", 3),                                                     // still running
    ev("stop", "doc-sync", "d0", 2),                                                     // stop with no start
    '{"ts":"torn line',
    "",
  ].join("\n"));
  const out = run();
  check(/SUMMARY agents: 2 running, 4 finished/.test(out), `summary:\n${out}`);
  const lines = out.split("\n").filter((l) => l.startsWith("running:"));
  check(lines.length === 2 && /sprint-executor\s+25m\s+\(e3/.test(lines[0]) && /arbiter\s+3m\s+\(a1/.test(lines[1]), `running agents, oldest first, with age:\n${out}`);
  check(/finished: sprint-executor\s+×2\s+avg 15m\s+max 20m/.test(out), `per-type count and durations:\n${out}`);
  check(/finished: reviewer\s+×1\s+avg 2m\s+max 2m/.test(out) && /finished: doc-sync\s+×1\s+avg \?\s+max \?/.test(out), `a stop with no start is counted without a duration:\n${out}`);
  const j = JSON.parse(run("--json"));
  check(j.running.length === 2 && j.finished["sprint-executor"].finished === 2 && Math.abs(j.finished["sprint-executor"].avg_ms - 900_000) < 2000 && j.finished["doc-sync"].avg_ms === null, "--json shape");
  check(/1 running, 1 finished/.test(run("--since", ago(10))), "--since drops older events");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
if (failed) { console.error(`test-agents: ${failed} check(s) failed`); process.exit(1); }
console.log("test-agents: all checks passed");
