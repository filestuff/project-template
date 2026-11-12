#!/usr/bin/env node
// Workflow scripts (.claude/workflows/*.js, scripts/sprint/workflows/*.mjs) run inside
// the Workflow tool's runtime, which no test can reach — so a typo in one ships silently
// and surfaces as a dead wave. This harness runs each script's real body against a stub
// runtime (agent/parallel/pipeline/phase/log/args with the documented semantics) and
// asserts the orchestration logic: which agents are dispatched in which order, and what
// the script returns for each combination of canned agent results.
//
// It also guards two things the template renderer and the runtime are strict about:
// no `{{…}}` token (upgrade.mjs render exits 3 on any unknown one), and every `phase:`
// an agent is assigned to exists in the script's `meta.phases`.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
let failed = 0;
const check = (cond, msg) => {
  if (!cond) {
    failed++;
    console.error(`FAIL ${msg}`);
  }
};
const eq = (a, b, msg) => check(JSON.stringify(a) === JSON.stringify(b), `${msg}\n   got:      ${JSON.stringify(a)}\n   expected: ${JSON.stringify(b)}`);

const WORKFLOW_DIRS = ["lite/.claude/workflows", "full-overlay/.claude/workflows", "full-overlay/scripts/sprint/workflows"];
const scripts = WORKFLOW_DIRS.filter((d) => existsSync(join(REPO, d))).flatMap((d) =>
  readdirSync(join(REPO, d))
    .filter((f) => f.endsWith(".mjs") || f.endsWith(".js"))
    .map((f) => join(d, f)),
);
// Saved workflows (invoked by NAME from .claude/workflows/) are discovered only with a
// `.js` extension — verified against Claude Code 2.1.322: a `.mjs` file there is invisible
// to `Workflow({ name })`. Scripts invoked by scriptPath may use either.
for (const d of WORKFLOW_DIRS.filter((d) => d.endsWith(".claude/workflows") && existsSync(join(REPO, d)))) {
  for (const f of readdirSync(join(REPO, d))) check(f.endsWith(".js"), `${d}/${f}: saved workflows must end in .js or Workflow({ name }) cannot find them`);
}
check(scripts.length >= 3, `expected at least 3 workflow scripts, found ${scripts.length}`);

// Compile a workflow script the way the runtime does: `meta` is a leading export, the
// rest is an async function body (top-level await and `return` are legal there).
function compile(rel) {
  const src = readFileSync(join(REPO, rel), "utf8");
  check(/^export const meta = \{/m.test(src), `${rel}: no \`export const meta = {\``);
  const body = src.replace(/^export const meta = /m, "const meta = ") + "\n;return undefined;";
  let fn;
  try {
    fn = new AsyncFunction("agent", "parallel", "pipeline", "phase", "log", "args", "budget", "workflow", "__meta", body.replace(/\n;return undefined;$/, "\n"));
  } catch (e) {
    check(false, `${rel}: does not parse — ${e.message}`);
    return null;
  }
  // Second compile that only returns meta, to read it without running the body.
  const metaSrc = src.slice(src.indexOf("export const meta = ") + "export const meta = ".length);
  let depth = 0,
    end = -1;
  for (let i = 0; i < metaSrc.length; i++) {
    if (metaSrc[i] === "{") depth++;
    else if (metaSrc[i] === "}" && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  let meta = null;
  try {
    meta = new Function(`return (${metaSrc.slice(0, end)})`)();
  } catch (e) {
    check(false, `${rel}: meta is not a pure literal — ${e.message}`);
  }
  return { src, fn, meta };
}

// Stub runtime with the documented semantics: parallel() never rejects (a throwing thunk
// → null); pipeline() runs each item through every stage independently, passing
// (prev, item, index), and a throwing stage drops that item to null.
function runtime(handler) {
  const calls = [];
  const logs = [];
  const agent = async (prompt, opts = {}) => {
    calls.push({ label: opts.label, agentType: opts.agentType, phase: opts.phase, hasSchema: !!opts.schema, prompt });
    return handler({ prompt, ...opts }, calls.length);
  };
  const parallel = (thunks) => Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(() => null)));
  const pipeline = (items, ...stages) =>
    Promise.all(
      items.map(async (item, i) => {
        let prev = item;
        try {
          for (const [n, stage] of stages.entries()) prev = await stage(n === 0 ? item : prev, item, i);
          return prev;
        } catch {
          return null;
        }
      }),
    );
  return { calls, logs, agent, parallel, pipeline, phase: () => {}, log: (m) => logs.push(m) };
}
async function run(compiled, args, handler) {
  const rt = runtime(handler);
  const budget = { total: null, spent: () => 0, remaining: () => Infinity };
  let result, error;
  try {
    result = await compiled.fn(rt.agent, rt.parallel, rt.pipeline, rt.phase, rt.log, args, budget, async () => null);
  } catch (e) {
    error = e;
  }
  return { result, error, calls: rt.calls, logs: rt.logs };
}

// ---- static guards over every workflow script -------------------------------------
const compiled = {};
for (const rel of scripts) {
  const c = compile(rel);
  if (!c) continue;
  compiled[rel] = c;
  const token = c.src.match(/\{\{[^}]*\}\}/);
  check(!token, `${rel}: contains a \`${token?.[0]}\` token — the template renderer rejects it (upgrade.mjs render exit 3)`);
  check(c.meta && typeof c.meta.name === "string" && c.meta.name, `${rel}: meta.name missing`);
  check(c.meta && typeof c.meta.description === "string" && c.meta.description, `${rel}: meta.description missing`);
  const titles = new Set((c.meta?.phases ?? []).map((p) => p.title));
  for (const m of c.src.matchAll(/phase:\s*'([^']+)'/g)) check(titles.has(m[1]), `${rel}: agent assigned to phase '${m[1]}' which is not in meta.phases`);
  for (const m of c.src.matchAll(/^phase\('([^']+)'\)/gm)) check(titles.has(m[1]), `${rel}: phase('${m[1]}') is not in meta.phases`);
  for (const m of c.src.matchAll(/agentType:\s*'([^']+)'/g)) {
    const def = ["lite", "full-overlay"].some((t) => existsSync(join(REPO, t, ".claude/agents", `${m[1]}.md`)));
    check(def, `${rel}: agentType '${m[1]}' has no .claude/agents/${m[1]}.md in either tier`);
  }
}

// ---- design-review ----------------------------------------------------------------
{
  const c = compiled["lite/.claude/workflows/design-review.js"];
  check(!!c, "design-review.js not found");
  if (c) {
    const base = { kind: "proposal", artifact: "/r/docs/proposals/001-x.md", repoRoot: "/r", lenses: ["feasibility", "architecture"] };
    const review = (lens, score, findings = []) => ({ lens, score, summary: "s", findings });
    const F = (severity) => ({ severity, claim: "c", evidence: "a.js:1", fix: "f" });
    const lensOf = (o) => o.label.split(":")[1].split("#")[0];

    // clean pass: no findings → no verifier dispatched
    let r = await run(c, base, (o) => review(lensOf(o), 8));
    check(r.result?.pass === true, "design-review: clean panel should pass");
    eq(r.calls.map((x) => x.agentType), ["design-reviewer", "design-reviewer"], "design-review: one reviewer per lens, no verifiers when there are no findings");
    check(r.calls.every((x) => x.hasSchema), "design-review: every agent call carries a schema");
    check(r.calls[0].prompt.includes("/r/docs/proposals/001-x.md") && r.calls[0].prompt.includes("feasibility"), "design-review: reviewer prompt names the artifact and its lens");

    // low score fails that lens only
    r = await run(c, base, (o) => review(lensOf(o), lensOf(o) === "architecture" ? 6 : 9));
    check(r.result?.pass === false, "design-review: a lens below 7 fails the gate");
    eq(r.result?.failing, ["architecture"], "design-review: failing lists exactly the low lens");

    // confirmed blocker fails even at a high score; minor is never verified
    r = await run(c, base, (o) => {
      if (o.agentType === "finding-verifier") return { verdict: "confirmed", evidence: "a.js:1", note: "n" };
      return review(lensOf(o), 9, lensOf(o) === "feasibility" ? [F("blocker"), F("minor")] : []);
    });
    check(r.result?.pass === false, "design-review: a confirmed blocker fails the gate");
    eq(r.calls.filter((x) => x.agentType === "finding-verifier").length, 1, "design-review: minor findings are not sent to a verifier");
    eq(r.result?.counts, { raised: 2, confirmed: 1, refuted: 0, downgraded: 0, unverified: 0 }, "design-review: counts for confirmed blocker + minor");

    // refuted blocker is dropped → pass
    r = await run(c, base, (o) => {
      if (o.agentType === "finding-verifier") return { verdict: "refuted", evidence: "a.js:9", note: "handled" };
      return review(lensOf(o), 8, lensOf(o) === "feasibility" ? [F("blocker")] : []);
    });
    check(r.result?.pass === true, "design-review: a refuted blocker does not fail the gate");
    const feas = r.result?.lenses.find((l) => l.lens === "feasibility");
    eq([feas?.findings.length, feas?.refuted.length], [0, 1], "design-review: refuted finding moves out of findings into refuted");

    // downgrade lowers severity
    r = await run(c, base, (o) => {
      if (o.agentType === "finding-verifier") return { verdict: "downgrade-major", evidence: "e", note: "n" };
      return review(lensOf(o), 8, lensOf(o) === "feasibility" ? [F("blocker")] : []);
    });
    check(r.result?.pass === true, "design-review: a blocker downgraded to major no longer fails the gate");
    eq(r.result?.lenses[0].findings[0].severity, "major", "design-review: downgrade rewrites the severity");
    eq(r.result?.lenses[0].findings[0].raised_as, "blocker", "design-review: downgrade keeps what it was raised as");

    // a reviewer that never returns is a lens that did not run — never a pass
    r = await run(c, base, (o) => (lensOf(o) === "architecture" ? null : review(lensOf(o), 9)));
    check(r.result?.pass === false, "design-review: a dead reviewer must fail the gate");
    eq(r.result?.failing, ["architecture"], "design-review: the dead lens is the failing one");
    check(r.result?.lenses.find((l) => l.lens === "architecture")?.died === true, "design-review: dead lens is marked died");

    // a verifier that never returns leaves the finding unverified (not confirmed)
    r = await run(c, base, (o) => {
      if (o.agentType === "finding-verifier") return null;
      return review(lensOf(o), 8, lensOf(o) === "feasibility" ? [F("blocker")] : []);
    });
    eq(r.result?.counts.unverified, 1, "design-review: dead verifier → finding is unverified");
    check(r.result?.pass === true, "design-review: an unverified blocker is carried, not treated as confirmed");
    check(r.result?.lenses[0].findings.length === 1, "design-review: an unverified finding is still reported");

    // plan kind passes the sprint files to the reviewer
    r = await run(c, { ...base, kind: "plan", lenses: ["coverage"], sprintFiles: ["/r/docs/sprints/backlog/S-001-a.md"] }, (o) => review(lensOf(o), 9));
    check(r.calls[0].prompt.includes("/r/docs/sprints/backlog/S-001-a.md"), "design-review: plan kind names the sprint files in the prompt");

    // argument validation
    for (const bad of [{ ...base, kind: "code" }, { ...base, lenses: [] }, { ...base, artifact: "" }]) {
      r = await run(c, bad, () => review("x", 9));
      check(r.error instanceof Error, `design-review: bad args should throw (${JSON.stringify(bad).slice(0, 60)}…)`);
    }
  }
}

// ---- plan-wave --------------------------------------------------------------------
{
  const c = compiled["full-overlay/scripts/sprint/workflows/plan-wave.mjs"];
  check(!!c, "plan-wave.mjs not found");
  if (c) {
    const args = (ids) => ({ waveId: "W-1", repoRoot: "/r", rosterSummary: "roster", members: ids.map((s) => ({ sprint: s, file: `/r/wt/${s}.md`, landedSince: "none" })) });
    const verdict = (v) => ({ verdict: v, touches_delta: "unchanged", staleness: [], contract_drift: "none", questions: [], cross_sprint: "none" });
    const audit = (v, blocking = []) => ({ verdict: v, lint: "SUMMARY plan-check: ok", blocking, assumptions: [] });
    const types = (r) => r.calls.map((x) => x.label);

    // sufficient first time
    let r = await run(c, args(["S-001"]), (o) => (o.agentType === "brief-auditor" ? audit("SUFFICIENT") : verdict("READY")));
    eq(types(r), ["plan:S-001", "audit:S-001"], "plan-wave: planner then one auditor");
    eq([r.result?.verdicts[0].audit.verdict, r.result?.uncertified, r.result?.missing], ["SUFFICIENT", [], []], "plan-wave: sufficient brief is certified");

    // insufficient → repair → sufficient
    let audits = 0;
    r = await run(c, args(["S-001"]), (o) => {
      if (o.agentType === "brief-auditor") return ++audits === 1 ? audit("INSUFFICIENT", ["deliverable 2 — which table?"]) : audit("SUFFICIENT");
      return verdict("READY");
    });
    eq(types(r), ["plan:S-001", "audit:S-001", "repair:S-001", "audit:S-001 (re-audit)"], "plan-wave: insufficient audit triggers exactly one repair + re-audit");
    check(r.calls[2].prompt.includes("Audit-repair mode") && r.calls[2].prompt.includes("which table?"), "plan-wave: repair prompt carries the auditor's blocking list");
    check(!r.calls[0].prompt.includes("Audit-repair mode"), "plan-wave: first planner prompt is not in repair mode");
    eq(r.result?.uncertified, [], "plan-wave: repaired brief is certified");

    // still insufficient after the repair round → uncertified
    r = await run(c, args(["S-001"]), (o) => (o.agentType === "brief-auditor" ? audit("INSUFFICIENT", ["x"]) : verdict("READY_WITH_QUESTIONS")));
    eq(r.result?.uncertified, ["S-001"], "plan-wave: a brief insufficient after repair is uncertified");
    eq(types(r).length, 4, "plan-wave: no third audit round");

    // NOT_READY is never audited
    r = await run(c, args(["S-001"]), (o) => (o.agentType === "brief-auditor" ? audit("SUFFICIENT") : verdict("NOT_READY")));
    eq(types(r), ["plan:S-001"], "plan-wave: a NOT_READY verdict is not audited");
    eq(r.result?.verdicts[0].audit, null, "plan-wave: NOT_READY carries audit null");

    // dead planner → missing; dead auditor → unaudited, which is not sufficient
    r = await run(c, args(["S-001", "S-002"]), (o) => {
      if (o.agentType === "brief-auditor") return null;
      return o.label === "plan:S-001" ? null : verdict("READY");
    });
    eq(r.result?.missing, ["S-001"], "plan-wave: a dead planner is reported missing");
    eq(r.result?.uncertified, ["S-002"], "plan-wave: a dead auditor leaves the brief uncertified");

    // members flow independently (two members, both complete)
    r = await run(c, args(["S-001", "S-002"]), (o) => (o.agentType === "brief-auditor" ? audit("SUFFICIENT") : verdict("READY")));
    eq(r.result?.verdicts.map((v) => v.sprint), ["S-001", "S-002"], "plan-wave: results keep roster order");
  }
}

// ---- exec-wave (smoke: it runs and reports dead executors) ---------------------------
{
  const c = compiled["full-overlay/scripts/sprint/workflows/exec-wave.mjs"];
  if (c) {
    const args = { waveId: "W-1", repoRoot: "/r", ledgerDir: "/r/l", sprints: [{ sprint: "S-001", worktree: "/r/w1" }, { sprint: "S-002", worktree: "/r/w2" }] };
    const r = await run(c, args, (o) => (o.label === "exec:S-002" ? null : { status: "DONE", commits: [], gate: "ok", report_path: "" }));
    eq([r.result?.statuses.map((s) => s.sprint), r.result?.missing], [["S-001"], ["S-002"]], "exec-wave: statuses and missing");
    // routing: a sprint's model/effort (from routing.json, by its tier) reach the agent call;
    // a sprint without them leaves the agent definition's own pin in force.
    const seen = [];
    const rt = runtime((o) => { seen.push({ label: o.label, model: o.model, effort: o.effort }); return { status: "DONE", sprint: "S-00x", worktree: "/w", commits: [], gate: "ok", report_path: "" }; });
    await c.fn(rt.agent, rt.parallel, rt.pipeline, rt.phase, rt.log, { ...args, sprints: [{ sprint: "S-001", worktree: "/r/w1", model: "opus", effort: "high" }, { sprint: "S-002", worktree: "/r/w2" }] }, { total: null }, async () => null);
    eq(seen, [{ label: "exec:S-001", model: "opus", effort: "high" }, { label: "exec:S-002" }], "exec-wave: routed model/effort are passed only when given");
    check(/'ESCALATE'/.test(c.src) && /required: \['status', 'sprint', 'worktree'/.test(c.src), "exec-wave: schema carries ESCALATE and the sprint/worktree the done-gate needs");
  }
}

if (failed) {
  console.error(`test-workflows: ${failed} check(s) failed`);
  process.exit(1);
}
console.log(`test-workflows: all checks passed (${scripts.length} scripts)`);
