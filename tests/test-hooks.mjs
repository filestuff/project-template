#!/usr/bin/env node
// scripts/hooks/guard.mjs and agent-log.mjs run on every Bash / file-edit tool call of
// every session and subagent. Two ways to get that wrong are both expensive: a guard that
// misses what it exists to stop (claims stay advisory), and a guard that blocks legitimate
// work (people turn it off). This feeds the scripts the hook-input JSON Claude Code sends
// (shape recorded from a live fixture run with 2.1.322: absolute tool_input.file_path,
// agent_id/agent_type present only for subagent calls, cwd = the main session's) and
// asserts allow / deny for each rule, the fail-open behaviour, and the done-gate's bound.
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const GUARD = join(REPO, "lite/scripts/hooks/guard.mjs");
const LOG = join(REPO, "lite/scripts/hooks/agent-log.mjs");
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "hooks-")));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
let failed = 0;
const check = (c, m) => { if (!c) { failed++; console.error(`FAIL ${m}`); } };

const write = (root, rel, body) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
function hook(script, root, input, env = {}) {
  const r = spawnSync("node", [script], { input: typeof input === "string" ? input : JSON.stringify({ session_id: "s", cwd: root, hook_event_name: "PreToolUse", ...input }), encoding: "utf8", cwd: root, env: { ...process.env, CLAUDE_PROJECT_DIR: root, SPRINT_MAIN_BRANCH: "", SPRINT_GUARD: "", ...env } });
  let decision = null, reason = "";
  try { const j = JSON.parse(r.stdout); decision = j.hookSpecificOutput?.permissionDecision ?? null; reason = j.hookSpecificOutput?.permissionDecisionReason ?? ""; } catch { /* no opinion */ }
  return { code: r.status, decision, reason, stderr: r.stderr, stdout: r.stdout };
}
const allowed = (r) => r.code === 0 && r.decision === null;
const denied = (r) => r.code === 0 && r.decision === "deny";
const SUB = { agent_id: "a1", agent_type: "sprint-executor" };

const sprint = (id, { touches = [], wave = null, complete = false } = {}) => `---
sprint: ${id}
status: in-progress
goal: g
short: s
depends_on: []
blocks: []
tags: []
story_points: 1
plan_date: 2026-11-01
start_date: 2026-11-01
end_date: null
${wave ? `wave: ${wave}\n` : ""}touches:${touches.length ? "\n" + touches.map((t) => `  - ${t}`).join("\n") : " []"}
---

# ${id}: thing

## Scope

### Deliverables

1. **Thing**
   - Acceptance criteria:
     - Automated:
       - [x] \`npm test\` → 1 passed
${complete ? "         - Evidence: `npm test` → 1 passed\n" : ""}
### Out of Scope

- nothing

## Completion Log

### Outcome

${complete ? "Shipped the thing." : "_(2–4 sentences at close …)_"}

### Commits

_(stamped at land)_

### Review

— not run: low risk (Step 3.5)

### Deviations from brief

— none

### Deferred

— none

### Learnings

— none

### Close checklist

- [x] Gate green — gate: all checks passed
- [x] Docs synced — none: nothing referenced
- [x] New docs registered — none: no new docs
- [x] ADR check — none: no decision
- [x] Deferred work logged — none: nothing deferred
- [x] Deployed — n/a: test fixture
`;

// ---------------------------------------------------------------- fixture: a full-tier repo
function fullRepo(name) {
  const root = join(tmp, name);
  write(root, "scripts/sprint/claims.mjs", "// presence marks the full tier\n");
  write(root, "scripts/sprint/claims-tokens.json", JSON.stringify({ tokens: { deps: ["package.json", "pnpm-lock.yaml"], schema: ["db/schema.sql", "db/migrations/**"] } }));
  copyFileSync(join(REPO, "lite/scripts/sprint/close-check.mjs"), join(root, "scripts/sprint/close-check.mjs"));
  return root;
}
const root = fullRepo("full");
const WT = join(root, ".claude/worktrees/S-001-thing");
write(root, "docs/sprints/in-progress/S-001-thing.md", sprint("S-001", { touches: ["src/a.ts", "src/feature/**", "deps", "docs/arch.md", "src/granted-on-main.ts"] }));
write(WT, "docs/sprints/in-progress/S-001-thing.md", sprint("S-001", { touches: ["src/a.ts", "src/feature/**", "deps", "docs/arch.md"] }));
const edit = (rel, extra = SUB, tool = "Edit", base = WT) => hook(GUARD, root, { tool_name: tool, tool_input: tool === "NotebookEdit" ? { notebook_path: join(base, rel) } : { file_path: join(base, rel) }, ...extra });

// ---- claim-guard: allowed paths
for (const rel of ["src/a.ts", "src/feature/x/y.ts", "package.json", "pnpm-lock.yaml", "docs/arch.md", "docs/sprints/in-progress/S-001-thing.md", "docs/sprints/evidence/S-001/shot.png", "src/granted-on-main.ts"]) {
  check(allowed(edit(rel)), `claim-guard should allow ${rel} (claimed, own sprint file, evidence, or granted on main)`);
}
// ---- claim-guard: denied paths
for (const rel of ["src/b.ts", "src/featurex/y.ts", "docs/sprints/INDEX.md", "docs/sprints/in-progress/S-002-other.md", "docs/sprints/evidence/S-002/x.png", "db/schema.sql"]) {
  const r = edit(rel);
  check(denied(r), `claim-guard should deny ${rel} (outside touches)`);
  check(r.reason.includes(rel) && r.reason.includes("S-001"), `deny reason should name the path and the sprint (${rel}): ${r.reason}`);
}
let r = edit("src/b.ts");
check(/NEEDS_CLAIM/.test(r.reason) && !/claims\.mjs add/.test(r.reason), `a subagent is told to return NEEDS_CLAIM, never to claim itself: ${r.reason}`);
r = edit("src/b.ts", {});
check(denied(r) && /claims\.mjs add S-001 src\/b\.ts/.test(r.reason), `the main session is told how to claim the path: ${r.reason}`);
check(denied(edit("src/b.ts", SUB, "Write")) && denied(edit("src/b.ipynb", SUB, "NotebookEdit")) && denied(edit("src/b.ts", SUB, "MultiEdit")), "claim-guard covers Write, NotebookEdit (notebook_path) and MultiEdit");
// ---- claim-guard: no opinion
check(allowed(hook(GUARD, root, { tool_name: "Edit", tool_input: { file_path: join(root, "src/anything.ts") }, ...SUB })), "a file outside any worktree is not the claim-guard's business");
check(allowed(edit("src/b.ts", SUB, "Edit", join(root, ".claude/worktrees/my-experiment"))), "a worktree this workflow does not manage gets no opinion");
check(allowed(edit("src/b.ts", SUB, "Edit", join(root, ".claude/worktrees/land-W-1-1"))), "the landing integration worktree gets no opinion");
write(root, "docs/sprints/in-progress/S-003-unclaimed.md", sprint("S-003"));
check(allowed(edit("src/b.ts", SUB, "Edit", join(root, ".claude/worktrees/S-003-unclaimed"))), "a sprint with empty touches runs unclaimed — nothing to enforce");
check(allowed(edit("src/b.ts", SUB, "Edit", join(root, ".claude/worktrees/S-099-ghost"))), "no sprint file for the worktree → fail open");
check(allowed(hook(GUARD, root, { tool_name: "Read", tool_input: { file_path: join(WT, "src/b.ts") }, ...SUB })), "reads are never claim-guarded");
check(allowed(edit("src/b.ts", SUB, "Edit", WT, )) === false, "sanity: the denied case is still denied");
check(allowed(hook(GUARD, root, { tool_name: "Edit", tool_input: { file_path: join(WT, "src/b.ts") }, ...SUB }, { SPRINT_GUARD: "off" })), "SPRINT_GUARD=off disables the guard");
// lite tier: same path, no claims.mjs
const lite = join(tmp, "lite");
write(lite, ".claude/worktrees/S-001-thing/docs/sprints/in-progress/S-001-thing.md", sprint("S-001", { touches: ["src/a.ts"] }));
check(allowed(hook(GUARD, lite, { tool_name: "Edit", tool_input: { file_path: join(lite, ".claude/worktrees/S-001-thing/src/b.ts") }, ...SUB })), "lite tier (no claims.mjs): claim-guard has no opinion");
// planning worktree
const PLAN = join(root, ".claude/worktrees/wave-W-2026-11-12-ab12-plan");
check(allowed(edit("docs/sprints/backlog/S-004-next.md", { agent_id: "p", agent_type: "sprint-planner" }, "Edit", PLAN)), "a planner may edit a backlog sprint file in the planning worktree");
for (const rel of ["src/a.ts", "docs/sprints/INDEX.md", "docs/sprints/in-progress/S-001-thing.md"]) check(denied(edit(rel, { agent_id: "p", agent_type: "sprint-planner" }, "Edit", PLAN)), `a planner may not edit ${rel} in the planning worktree`);
// train worktree: union of the wave's started members
write(root, "docs/sprints/in-progress/S-010-car1.md", sprint("S-010", { touches: ["lib/one.ts"], wave: "W-2026-11-12-cd34" }));
write(root, "docs/sprints/in-progress/S-011-car2.md", sprint("S-011", { touches: ["lib/two/**"], wave: "W-2026-11-12-cd34" }));
write(root, "docs/sprints/in-progress/S-012-other-wave.md", sprint("S-012", { touches: ["lib/three.ts"], wave: "W-2026-11-12-zz99" }));
const TRAIN = join(root, ".claude/worktrees/train-W-2026-11-12-cd34");
for (const rel of ["lib/one.ts", "lib/two/deep/x.ts", "docs/sprints/in-progress/S-011-car2.md", "docs/sprints/evidence/S-010/a.txt"]) check(allowed(edit(rel, SUB, "Edit", TRAIN)), `train worktree should allow ${rel} (union of its members)`);
for (const rel of ["lib/three.ts", "src/a.ts"]) check(denied(edit(rel, SUB, "Edit", TRAIN)), `train worktree should deny ${rel} (another wave's / nobody's claim)`);
// fail open on garbage
r = hook(GUARD, root, "this is not json");
check(r.code === 0 && r.decision === null && /internal error, allowing/.test(r.stderr), `malformed hook input must fail open with a warning: ${r.stderr}`);
check(allowed(hook(GUARD, root, { tool_name: "Edit", tool_input: {} })), "a tool call with no path is ignored");

// ---------------------------------------------------------------- Bash guards (need real git for branch lookups)
const gr = fullRepo("gitrepo");
git(tmp, "init", "-q", gr);
git(gr, "checkout", "-q", "-b", "main");
git(gr, "config", "user.email", "t@t"); git(gr, "config", "user.name", "t");
write(gr, "f.txt", "x\n"); git(gr, "add", "-A"); git(gr, "commit", "-qm", "init");
const feature = join(tmp, "featurewt");
git(gr, "worktree", "add", "-q", feature, "-b", "feature/x");
const bash = (command, extra = {}, env = {}, cwdRoot = gr) => hook(GUARD, cwdRoot, { tool_name: "Bash", tool_input: { command }, ...extra }, env);

// main-guard: applies to everyone
for (const c of [
  "git push --force origin main", "git push -f origin main", "git push -fu origin main", "git push --force-with-lease origin main",
  "git push origin +main", "git push origin HEAD:main --force", "git -C . push --force origin main", "git -c push.default=current push -f origin main",
  "/usr/bin/git push --force origin main", "bash -c 'git push -f origin main'", "cd /tmp && git push --force origin main", "npm test; git push -f origin main",
  "echo $(git push -f origin main)", "FOO=1 git push --force origin refs/heads/main", "git push --force", "git push -f origin", "git push --mirror --force origin",
  "git push origin :main", "git push --delete origin main", "sudo git push --force origin main", "timeout 30 git push -f origin main",
]) {
  check(denied(bash(c)), `main-guard should deny: ${c}`);
  check(denied(bash(c, SUB)), `main-guard should deny from a subagent too: ${c}`);
}
for (const c of [
  "git push origin main", "git push", "git push --force origin feature/x", "git push -f origin my-branch", "git push --force-with-lease origin claude/topic",
  "git push -o ci.skip origin main", "git push -u origin main", "echo 'git push --force origin main'", "git log --oneline -n 5", "grep -rn 'push --force' docs/",
  `git -C ${feature} push --force`, "git push --follow-tags origin main", "git pull --force origin main", "git fetch --force",
]) check(allowed(bash(c)), `main-guard should allow: ${c}`);
check(denied(bash(`git -C ${gr} push --force`)) && allowed(bash(`git -C ${feature} push -f`)), "a bare force-push is judged by the branch of the checkout it targets (-C)");
check(denied(bash("git push --force origin trunk", {}, { SPRINT_MAIN_BRANCH: "trunk" })) && allowed(bash("git push --force origin main", {}, { SPRINT_MAIN_BRANCH: "trunk" })), "SPRINT_MAIN_BRANCH names the protected branch");
check(denied(bash("git push --force origin main", {}, {}, lite)), "main-guard also runs in the lite tier");

// lifecycle-guard: subagents in the full tier
for (const c of [
  "bash scripts/sprint/start.sh S-001 --no-push", "scripts/sprint/merge-sprint.sh land S-001-thing", `bash ${gr}/scripts/sprint/merge-sprint.sh prepare S-001-x`,
  "scripts/sprint/lock.sh acquire mine", "scripts/sprint/lock.sh steal --force", "bash scripts/sprint/reserve-wave.sh S-1 S-2", "bash scripts/sprint/push-main.sh",
  "bash scripts/sprint/unstart.sh S-001 --reason x", "node scripts/sprint/claims.mjs add S-001 src/b.ts --no-push", "cd /x && bash scripts/sprint/start.sh S-2",
  "git push origin S-001-thing", "git -C /wt push", "git commit --no-verify -m wip", "git commit -n -m wip", "git -C /wt commit -anm wip", "bash scripts/sprint/assemble-train.sh W-1 S-1",
]) {
  const d = bash(c, SUB);
  check(denied(d) && /LIFECYCLE-GUARD/.test(d.reason), `lifecycle-guard should deny a subagent: ${c}`);
  check(allowed(bash(c)), `lifecycle-guard must not touch the main session: ${c}`);
  check(allowed(bash(c, SUB, {}, lite)), `lifecycle-guard has no opinion in the lite tier: ${c}`);
}
for (const c of [
  "scripts/sprint/gate.sh", "bash scripts/sprint/gate.sh && git -C /wt commit -m 'S-001: thing'", "node scripts/sprint/claims.mjs check --sprint S-001", "node scripts/sprint/claims.mjs waves",
  "scripts/sprint/lock.sh status", "node scripts/sprint/close-check.mjs docs/sprints/in-progress/S-001-thing.md", "git -C /wt commit -am 'S-001: fix -n handling'",
  "git -C /wt commit --amend --no-edit", "git -C /wt log --oneline -n 3", "cat scripts/sprint/start.sh", "grep -n lock scripts/sprint/merge-sprint.sh", "npm test",
]) check(allowed(bash(c, SUB)), `lifecycle-guard should allow a subagent: ${c}`);
check(allowed(bash("", SUB)) && allowed(hook(GUARD, gr, { tool_name: "Bash", tool_input: {}, ...SUB })), "an empty command is ignored");

// ---------------------------------------------------------------- done-gate
const dg = fullRepo("donegate");
git(tmp, "init", "-q", dg);
git(dg, "checkout", "-q", "-b", "main");
git(dg, "config", "user.email", "t@t"); git(dg, "config", "user.name", "t");
write(dg, ".gitignore", ".claude/\n");
write(dg, "docs/sprints/in-progress/S-020-rec.md", sprint("S-020", { touches: ["src/a.ts"] }));
git(dg, "add", "-A"); git(dg, "commit", "-qm", "init");
const DWT = join(dg, ".claude/worktrees/S-020-rec");
git(dg, "worktree", "add", "-q", DWT, "-b", "S-020-rec");
const done = (out, extra = { agent_id: "ex1", agent_type: "sprint-executor" }) => hook(GUARD, dg, { tool_name: "StructuredOutput", tool_input: out, ...extra });
const DONE = { status: "DONE", sprint: "S-020", worktree: DWT, commits: [], gate: "ok", report_path: "" };

r = done(DONE);
check(r.code === 2 && /DONE-GATE \(1\/3\)/.test(r.stderr) && /outcome-empty/.test(r.stderr) && /criterion-unevidenced/.test(r.stderr), `an incomplete record must be refused with the lint failures:\n${r.stderr}`);
check(done({ ...DONE, status: "BLOCKED" }).code === 0, "done-gate only looks at DONE");
check(done(DONE, { agent_id: "x", agent_type: "sprint-planner" }).code === 0, "done-gate only looks at sprint-executor");
check(done({ status: "DONE" }).code === 0, "no worktree named → no opinion (the master's check will catch it)");
check(done({ ...DONE, worktree: join(dg, "nope") }).code === 0, "an unlocatable record → no opinion");
check(/DONE-GATE \(2\/3\)/.test(done(DONE).stderr) && /DONE-GATE \(3\/3\)/.test(done(DONE).stderr), "refusals are counted per agent");
r = done(DONE);
check(r.code === 0, `after 3 refusals the gate lets the executor through (bounded): code ${r.code}`);
check(done(DONE, { agent_id: "ex2", agent_type: "sprint-executor" }).code === 2, "a different executor has its own count");
check(readFileSync(join(dg, ".claude/sprint-orchestration/.gitignore"), "utf8") === "*\n", "gate state lives in a self-ignoring directory");
// complete record, clean tree → through
writeFileSync(join(DWT, "docs/sprints/in-progress/S-020-rec.md"), sprint("S-020", { touches: ["src/a.ts"], complete: true }));
r = done(DONE, { agent_id: "ex3", agent_type: "sprint-executor" });
check(r.code === 2 && /uncommitted changes/.test(r.stderr) && !/outcome-empty/.test(r.stderr), `a complete but uncommitted record is refused for the uncommitted change only:\n${r.stderr}`);
git(DWT, "commit", "-qam", "S-020: completion log");
r = done(DONE, { agent_id: "ex4", agent_type: "sprint-executor" });
check(r.code === 0 && r.stderr === "", `a complete, committed record passes: code ${r.code} ${r.stderr}`);
check(done({ status: "DONE", worktree: DWT }, { agent_id: "ex5", agent_type: "sprint-executor" }).code === 0, "the sprint id is derived from the worktree name when not given");
check(done(DONE, { agent_id: "ex6", agent_type: "sprint-executor" }).code === 0 && hook(GUARD, lite, { tool_name: "StructuredOutput", tool_input: DONE, agent_id: "e", agent_type: "sprint-executor" }).code === 0, "lite tier: done-gate has no opinion");

// ---------------------------------------------------------------- agent-log
const ev = (root_, name, extra) => spawnSync("node", [LOG], { input: JSON.stringify({ session_id: "sess", cwd: root_, hook_event_name: name, ...extra }), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: root_ } });
const lg = fullRepo("logrepo");
check(ev(lg, "SubagentStart", { agent_id: "a1", agent_type: "sprint-executor" }).status === 0, "agent-log exits 0");
ev(lg, "SubagentStop", { agent_id: "a1", agent_type: "sprint-executor" });
ev(lg, "SubagentStop", { agent_id: "a2", agent_type: "" }); // internal helper agent
ev(lg, "PreToolUse", { agent_id: "a3", agent_type: "x" }); // not an agent lifecycle event
const events = readFileSync(join(lg, ".claude/sprint-orchestration/events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
check(events.length === 2 && events[0].event === "start" && events[1].event === "stop" && events[0].agent_type === "sprint-executor" && events[0].agent_id === "a1" && events[0].session_id === "sess" && !Number.isNaN(Date.parse(events[0].ts)), `agent-log should record exactly the start and stop: ${JSON.stringify(events)}`);
check(readFileSync(join(lg, ".claude/sprint-orchestration/.gitignore"), "utf8") === "*\n", "the log directory ignores itself");
ev(lite, "SubagentStart", { agent_id: "a1", agent_type: "reviewer" });
check(!existsSync(join(lite, ".claude/sprint-orchestration/events.jsonl")), "lite tier: nothing is logged");
check(spawnSync("node", [LOG], { input: "garbage", encoding: "utf8" }).status === 0, "agent-log never fails the session");

if (failed) { console.error(`test-hooks: ${failed} check(s) failed`); process.exit(1); }
console.log("test-hooks: all checks passed");
