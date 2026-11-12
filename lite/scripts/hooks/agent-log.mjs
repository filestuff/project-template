#!/usr/bin/env node
// SubagentStart / SubagentStop logger — one JSON line per event in
// .claude/sprint-orchestration/events.jsonl (gitignored runtime scratch), so `/sprint
// board` and a human can see which agents a wave started, which are still running, and
// how long each took. Wall-clock and counts only: token cost is not exposed to hooks, so
// nothing here claims it.
//
// Full tier only (scripts/sprint/claims.mjs present) — a lite repo has no orchestration
// to observe and gets no file. Never blocks and never fails the session: any error exits 0.
//
//   {"ts":"2026-11-12T10:00:00.000Z","event":"start","agent_type":"sprint-executor",
//    "agent_id":"a1b2…","session_id":"…"}
import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const event = input.hook_event_name === "SubagentStart" ? "start" : input.hook_event_name === "SubagentStop" ? "stop" : null;
  // Claude Code also runs internal helper agents (prompt suggestions, side questions);
  // they arrive with an empty agent_type and are not part of anyone's wave.
  if (event && input.agent_type && existsSync(join(root, "scripts/sprint/claims.mjs"))) {
    const dir = join(root, ".claude/sprint-orchestration");
    mkdirSync(dir, { recursive: true });
    const ignore = join(dir, ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
    const line = { ts: new Date().toISOString(), event, agent_type: input.agent_type, agent_id: input.agent_id ?? null, session_id: input.session_id ?? null };
    appendFileSync(join(dir, "events.jsonl"), JSON.stringify(line) + "\n");
  }
} catch {
  /* observability must never get in the way */
}
process.exit(0);
