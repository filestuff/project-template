#!/usr/bin/env node
// Who is running? Reads .claude/sprint-orchestration/events.jsonl — one line per subagent
// start/stop, written by scripts/hooks/agent-log.mjs — and prints the agents still
// running (a start with no stop) with their age, plus finished counts and durations per
// agent type. `/sprint board` shows this; it is also the first thing to read when a wave
// seems stuck. Wall-clock only: token cost is not exposed to hooks, so none is reported.
//
//   agents.mjs [--since <ISO time>] [--json] [--root <repo-root>]
//
// Exit 0 always (no log yet is not an error). A "running" agent whose session has ended
// is indistinguishable from a live one here — an age far beyond its type's usual duration
// is the tell; compare with the wave ledger before acting on it.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i === -1 ? null : (argv[i + 1] ?? ""); };
const root = flag("--root") || process.cwd();
const since = flag("--since");
const json = argv.includes("--json");
const now = Date.now();
const file = join(root, ".claude/sprint-orchestration/events.jsonl");

const open = new Map(); // agent_id -> start event
const done = []; // { agent_type, ms }
if (existsSync(file)) {
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    let e;
    try { e = JSON.parse(raw); } catch { continue; } // a torn line from a crashed write
    if (!e.agent_id || !e.ts || (since && e.ts < since)) continue;
    if (e.event === "start") open.set(e.agent_id, e);
    else if (e.event === "stop") {
      const s = open.get(e.agent_id);
      if (s) { done.push({ agent_type: s.agent_type, ms: Date.parse(e.ts) - Date.parse(s.ts) }); open.delete(e.agent_id); }
      else done.push({ agent_type: e.agent_type, ms: null }); // resumed agent, or start predates --since
    }
  }
}
const fmt = (ms) => (ms == null ? "?" : ms < 90_000 ? `${Math.round(ms / 1000)}s` : ms < 5_400_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`);
const running = [...open.values()].map((s) => ({ agent_type: s.agent_type, agent_id: s.agent_id, started: s.ts, age_ms: now - Date.parse(s.ts) })).sort((a, b) => b.age_ms - a.age_ms);
const byType = {};
for (const d of done) {
  const t = (byType[d.agent_type] ??= { finished: 0, total_ms: 0, timed: 0, max_ms: 0 });
  t.finished++;
  if (d.ms != null) { t.total_ms += d.ms; t.timed++; t.max_ms = Math.max(t.max_ms, d.ms); }
}

if (json) {
  console.log(JSON.stringify({ running, finished: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, { finished: v.finished, avg_ms: v.timed ? Math.round(v.total_ms / v.timed) : null, max_ms: v.timed ? v.max_ms : null }])) }, null, 2));
} else {
  if (running.length === 0) console.log("running: none");
  for (const r of running) console.log(`running: ${r.agent_type.padEnd(18)} ${fmt(r.age_ms).padStart(6)}  (${r.agent_id}, since ${r.started})`);
  for (const [type, v] of Object.entries(byType).sort()) console.log(`finished: ${type.padEnd(17)} ×${v.finished}  avg ${fmt(v.timed ? v.total_ms / v.timed : null)}  max ${fmt(v.timed ? v.max_ms : null)}`);
  console.log(`SUMMARY agents: ${running.length} running, ${done.length} finished`);
}
