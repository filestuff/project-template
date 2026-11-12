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

const WORKFLOW_DIRS = ["lite/.claude/workflows", "full-overlay/.claude/workflows"];
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
    calls.push({ label: opts.label, agentType: opts.agentType, phase: opts.phase, hasSchema: !!opts.schema, model: opts.model, effort: opts.effort, prompt });
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

// ---- plan-flow --------------------------------------------------------------------
{
  const c = compiled["full-overlay/.claude/workflows/plan-flow.js"];
  check(!!c, "plan-flow.js not found");
  if (c) {
    const ROUTING = { roles: { planner: { model: "opus", effort: "high" }, "brief-auditor": { model: "sonnet", effort: "medium" }, arbiter: { model: "opus", effort: "xhigh" } } };
    const args = (ids, extra = {}) => ({ waveId: "W-1", repoRoot: "/r", rosterSummary: "roster", routing: ROUTING, members: ids.map((s) => ({ sprint: s, file: `/r/wt/${s}.md`, landedSince: "none" })), ...extra });
    const verdict = (v, questions = []) => ({ verdict: v, touches_delta: "unchanged", staleness: [], contract_drift: "none", questions, cross_sprint: "none" });
    const audit = (v, blocking = []) => ({ verdict: v, lint: "SUMMARY plan-check: ok", blocking, assumptions: [] });
    const Q = (id) => ({ id, question: `q ${id}?`, options: ["a", "b"], recommended: "a — simpler" });
    const types = (r) => r.calls.map((x) => x.label);

    // sufficient first time
    let r = await run(c, args(["S-001"]), (o) => (o.agentType === "brief-auditor" ? audit("SUFFICIENT") : verdict("READY")));
    eq(types(r), ["plan:S-001", "audit:S-001"], "plan-flow: planner then one auditor");
    eq([r.result?.verdicts[0].audit.verdict, r.result?.uncertified, r.result?.missing, r.result?.decided, r.result?.ask], ["SUFFICIENT", [], [], [], []], "plan-flow: sufficient brief is certified, nothing to decide");

    // insufficient → repair → sufficient
    let audits = 0;
    r = await run(c, args(["S-001"]), (o) => {
      if (o.agentType === "brief-auditor") return ++audits === 1 ? audit("INSUFFICIENT", ["deliverable 2 — which table?"]) : audit("SUFFICIENT");
      return verdict("READY");
    });
    eq(types(r), ["plan:S-001", "audit:S-001", "repair:S-001", "audit:S-001 (re-audit)"], "plan-flow: insufficient audit triggers exactly one repair + re-audit");
    check(r.calls[2].prompt.includes("Audit-repair mode") && r.calls[2].prompt.includes("which table?"), "plan-flow: repair prompt carries the auditor's blocking list");
    check(!r.calls[0].prompt.includes("Audit-repair mode"), "plan-flow: first planner prompt is not in repair mode");
    eq(r.result?.uncertified, [], "plan-flow: repaired brief is certified");

    // still insufficient after the repair round → uncertified
    r = await run(c, args(["S-001"]), (o) => (o.agentType === "brief-auditor" ? audit("INSUFFICIENT", ["x"]) : verdict("READY_WITH_QUESTIONS")));
    eq(r.result?.uncertified, ["S-001"], "plan-flow: a brief insufficient after repair is uncertified");
    eq(types(r).length, 4, "plan-flow: no third audit round");

    // NOT_READY is never audited
    r = await run(c, args(["S-001"]), (o) => (o.agentType === "brief-auditor" ? audit("SUFFICIENT") : verdict("NOT_READY")));
    eq(types(r), ["plan:S-001"], "plan-flow: a NOT_READY verdict is not audited");
    eq(r.result?.verdicts[0].audit, null, "plan-flow: NOT_READY carries audit null");

    // dead planner → missing; dead auditor → unaudited, which is not sufficient
    r = await run(c, args(["S-001", "S-002"]), (o) => {
      if (o.agentType === "brief-auditor") return null;
      return o.label === "plan:S-001" ? null : verdict("READY");
    });
    eq(r.result?.missing, ["S-001"], "plan-flow: a dead planner is reported missing (not as a verdict with no fields)");
    eq(r.result?.uncertified, ["S-002"], "plan-flow: a dead auditor leaves the brief uncertified");

    // routing reaches the calls
    r = await run(c, args(["S-001"]), (o) => (o.agentType === "brief-auditor" ? audit("SUFFICIENT") : verdict("READY")));
    eq(r.calls.map((x) => [x.agentType, x.model, x.effort]), [["sprint-planner", "opus", "high"], ["brief-auditor", "sonnet", "medium"]], "plan-flow: routing.json models are passed");
    r = await run(c, { ...args(["S-001"]), routing: undefined }, (o) => (o.agentType === "brief-auditor" ? audit("SUFFICIENT") : verdict("READY")));
    eq(r.calls.map((x) => x.model), [undefined, undefined], "plan-flow: without routing the agent definitions' own pins apply");

    // Decide: gated → each question gets an arbiter ruling; decided vs ask are split
    r = await run(c, args(["S-001"]), (o) => {
      if (o.agentType === "brief-auditor") return audit("SUFFICIENT");
      if (o.agentType === "arbiter") {
        if (o.label.endsWith("D-A")) return { class: "taste", decision: "a", principle: "KISS", rejected: "b", undo: "swap", record: "- 2026-11-12 (wave, taste, arbiter): a — principle: KISS — rejected: b — undo: swap" };
        if (o.label.endsWith("D-B")) return { class: "reserved", decision: "", principle: "security posture", record: "", ask_user: { question: "relax auth?", stake: "exposure", options: ["x", "y"], recommended: "x" } };
        return null; // D-C: the arbiter never returned
      }
      return verdict("READY_WITH_QUESTIONS", [Q("D-A"), Q("D-B"), Q("D-C")]);
    });
    eq(types(r), ["plan:S-001", "audit:S-001", "decide:S-001:D-A", "decide:S-001:D-B", "decide:S-001:D-C"], "plan-flow: one arbiter per open question");
    eq(r.result?.decided.map((d) => [d.sprint, d.id, d.class]), [["S-001", "D-A", "taste"]], "plan-flow: taste ruling comes back decided, with its record");
    check(r.result?.decided[0].record.includes("(wave, taste, arbiter)"), "plan-flow: the decided entry carries the record line");
    eq(r.result?.ask.map((a) => [a.id, a.class, a.question]), [["D-B", "reserved", "relax auth?"], ["D-C", "unclassified", "q D-C?"]], "plan-flow: reserved and un-ruled questions go to the user — none is dropped");
    check(r.calls.filter((x) => x.agentType === "arbiter").every((x) => x.model === "opus" && x.effort === "xhigh"), "plan-flow: arbiter runs on its routed model");

    // Decide: interactive → no arbiter; every question is the user's
    r = await run(c, args(["S-001"], { autonomy: "interactive" }), (o) => (o.agentType === "brief-auditor" ? audit("SUFFICIENT") : verdict("READY_WITH_QUESTIONS", [Q("D-A")])));
    check(!r.calls.some((x) => x.agentType === "arbiter"), "plan-flow: interactive runs do not consult the arbiter");
    eq([r.result?.decided.length, r.result?.ask.length], [0, 1], "plan-flow: interactive → all questions asked");

    r = await run(c, { ...args([]), members: [] }, () => null);
    check(r.error instanceof Error, "plan-flow: empty roster throws");
  }
}

// ---- sprint-flow ------------------------------------------------------------------
{
  const c = compiled["full-overlay/.claude/workflows/sprint-flow.js"];
  check(!!c, "sprint-flow.js not found");
  if (c) {
    const ROUTING = JSON.parse(readFileSync(join(REPO, "full-overlay/scripts/sprint/routing.json"), "utf8"));
    const A = (extra = {}, sprint = {}) => ({ waveId: "W-1", repoRoot: "/r", ledgerDir: "/r/l/", routing: ROUTING, sprint: { id: "S-001", worktree: "/r/wt/S-001-x", risk: "low", tier: "standard", ...sprint }, ...extra });
    const st = (status, extra = {}) => ({ status, sprint: "S-001", worktree: "/r/wt/S-001-x", commits: ["abc S-001: thing"], gate: "gate ok", close_check: "SUMMARY ok", concerns: "", ...extra });
    const clean = { findings: [], summary: "no material issues found" };
    const F = (sev, loc = "src/a.ts:3", desc = "null path") => ({ severity: sev, confidence: 8, location: loc, quote: "x = y.z", description: desc, fix: "guard it" });
    const labels = (r) => r.calls.map((x) => x.label);
    const kind = (o) => o.label.split(":")[0];
    // script: a function per call kind; exec results consumed in order
    const play = (script) => {
      const n = {};
      return (o) => {
        const k = kind(o);
        n[k] = (n[k] ?? 0) + 1;
        const h = script[k];
        if (h === undefined) throw new Error(`unexpected agent call ${o.label}`);
        return typeof h === "function" ? h(o, n[k]) : Array.isArray(h) ? h[Math.min(n[k], h.length) - 1] : h;
      };
    };
    const BLOCKED = st("BLOCKED", { question: { question: "which cache?", context: "src/a.ts:1", options: ["lru", "ttl"], default: "lru" } });
    const taste = { class: "taste", decision: "use lru", principle: "ladder rung 2", rejected: "ttl", undo: "swap the import", needs: "none", needs_detail: "", record: "- 2026-11-12 (wave, taste, arbiter): use lru — principle: ladder rung 2 — rejected: ttl — undo: swap the import" };

    // 1. happy path, low risk
    let r = await run(c, A(), play({ exec: st("DONE"), review: clean }));
    eq(labels(r), ["exec:S-001", "review:S-001:review"], "sprint-flow: low-risk happy path is one executor and one reviewer");
    eq([r.result?.status, r.result?.tier, r.result?.review.counts.raised], ["READY_TO_LAND", "executor.standard", 0], "sprint-flow: clean review → READY_TO_LAND");
    check(r.result?.review_record.length === 1 && /no material issues found/.test(r.result.review_record[0]) && /independent review/.test(r.result.review_record[0]), `sprint-flow: a clean review still yields a record line: ${r.result?.review_record}`);
    eq([r.calls[0].model, r.calls[0].effort, r.calls[1].agentType, r.calls[1].model], ["sonnet", "high", "reviewer", "opus"], "sprint-flow: executor.standard and reviewer run on their routed models");
    check(r.calls[1].prompt.includes('git -C "/r/wt/S-001-x" diff main...HEAD') && !/Execute the sprint/.test(r.calls[1].prompt), "sprint-flow: the reviewer is handed the diff, not the author's reasoning");
    check(r.calls.every((x) => x.hasSchema), "sprint-flow: every agent call is schema-validated");

    // 2. tier: complex starts on the stronger executor
    r = await run(c, A({}, { tier: "complex" }), play({ exec: st("DONE"), review: clean }));
    eq([r.calls[0].model, r.result?.tier], ["opus", "executor.complex"], "sprint-flow: a complex sprint starts on executor.complex");

    // 3. BLOCKED → arbiter decides (taste) → a fresh executor continues with the answer
    r = await run(c, A(), play({ exec: [BLOCKED, st("DONE")], arbiter: taste, review: clean }));
    eq(labels(r), ["exec:S-001", "arbiter:S-001", "exec:S-001", "review:S-001:review"], "sprint-flow: BLOCKED goes to the arbiter, then the executor continues");
    check(r.calls[2].prompt.includes("ANSWER: use lru") && r.calls[2].prompt.includes(taste.record) && r.calls[2].prompt.includes("You are continuing this sprint"), "sprint-flow: the continuation carries the answer, the record line, and 'read git log first'");
    eq([r.result?.status, r.result?.decisions], ["READY_TO_LAND", [taste.record]], "sprint-flow: arbiter decisions are returned for the record");
    eq([r.calls[1].agentType, r.calls[1].model, r.calls[1].effort], ["arbiter", "opus", "xhigh"], "sprint-flow: the arbiter runs on its routed model");

    // 4. reserved decision → parked for the user; nothing is reviewed or decided for them
    r = await run(c, A(), play({ exec: BLOCKED, arbiter: { class: "reserved", decision: "", principle: "security posture", needs: "none", needs_detail: "", record: "", ask_user: { question: "relax auth?", stake: "exposure", options: ["no", "yes"], recommended: "no" } } }));
    eq([r.result?.status, r.result?.question.question, r.result?.question.class, r.result?.decisions], ["PARKED", "relax auth?", "reserved", []], "sprint-flow: a reserved decision parks the sprint with the arbiter's brief");
    check(!labels(r).some((l) => l.startsWith("review")), "sprint-flow: a parked sprint is not reviewed");

    // 5. interactive mode → BLOCKED is the user's, no arbiter
    r = await run(c, A({ autonomy: "interactive" }), play({ exec: BLOCKED }));
    eq([labels(r), r.result?.status, r.result?.question.question], [["exec:S-001"], "PARKED", "which cache?"], "sprint-flow: interactive mode never auto-answers");

    // 6. blocked again and again → bounded
    r = await run(c, A(), play({ exec: BLOCKED, arbiter: taste }));
    eq([r.result?.status, labels(r).filter((l) => l.startsWith("arbiter")).length], ["PARKED", 2], "sprint-flow: at most two arbiter rounds, then parked");

    // 7. the arbiter's answer needs a claim → back to the orchestrator (only it may touch main)
    r = await run(c, A(), play({ exec: BLOCKED, arbiter: { ...taste, needs: "claim", needs_detail: "src/shared.ts" } }));
    eq([r.result?.status, r.result?.needs_claim_paths, r.result?.decisions.length], ["NEEDS_CLAIM", ["src/shared.ts"], 1], "sprint-flow: a decision that needs a claim returns NEEDS_CLAIM with the decision recorded");
    r = await run(c, A(), play({ exec: BLOCKED, arbiter: { ...taste, needs: "scope", needs_detail: "adds an endpoint" } }));
    eq([r.result?.status, r.result?.question.class], ["PARKED", "reserved"], "sprint-flow: a decision that changes scope is the user's");

    // 8. ESCALATE → the next routing tier continues from the branch
    const ESC = (reason) => st("ESCALATE", { escalation: { reason, tried: "two attempts at the race", state: "wip committed", next: "needs a lock redesign" } });
    r = await run(c, A(), play({ exec: [ESC("repeated-failure"), st("DONE")], review: clean }));
    eq([r.calls[0].model, r.calls[1].model, r.result?.tier, r.result?.escalations], ["sonnet", "opus", "executor.complex", [{ from: "executor.standard", to: "executor.complex", reason: "repeated-failure" }]], "sprint-flow: ESCALATE re-dispatches on the next tier and records it");
    check(r.calls[1].prompt.includes("TRIED: two attempts at the race") && r.calls[1].prompt.includes("tier: complex"), "sprint-flow: the stronger executor gets the handover");
    check(!labels(r).some((l) => l.startsWith("arbiter")), "sprint-flow: a plain capability escalation does not consult the arbiter");

    // 9. escalation past the top of the ladder → parked
    r = await run(c, A({}, { tier: "complex" }), play({ exec: ESC("beyond-capability") }));
    eq([r.result?.status, /escalation exhausted/.test(r.result?.question.reason)], ["PARKED", true], "sprint-flow: nowhere left to escalate → parked for the user");

    // 10. carve-out uncertainty → the arbiter's read first
    r = await run(c, A(), play({ exec: [ESC("carve-out-uncertainty"), st("DONE")], arbiter: taste, review: clean }));
    eq(labels(r).slice(0, 3), ["exec:S-001", "arbiter:S-001", "exec:S-001"], "sprint-flow: carve-out uncertainty is put to the arbiter before any re-dispatch");
    check(r.calls[2].prompt.includes("The arbiter has ruled"), "sprint-flow: the ruling travels with the handover");
    r = await run(c, A(), play({ exec: ESC("carve-out-uncertainty"), arbiter: { class: "reserved", decision: "", principle: "auth", needs: "none", needs_detail: "", record: "", ask_user: { question: "allow anonymous reads?", stake: "data exposure", options: ["no", "yes"], recommended: "no" } } }));
    eq([r.result?.status, r.result?.question.question], ["PARKED", "allow anonymous reads?"], "sprint-flow: a reserved carve-out decision parks the sprint");

    // 11. NEEDS_CLAIM / PLAN_GAP go straight back
    r = await run(c, A(), play({ exec: st("NEEDS_CLAIM", { needs_claim_paths: ["src/b.ts"] }) }));
    eq([r.result?.status, r.result?.needs_claim_paths, labels(r)], ["NEEDS_CLAIM", ["src/b.ts"], ["exec:S-001"]], "sprint-flow: NEEDS_CLAIM returns to the orchestrator");
    r = await run(c, A(), play({ exec: st("PLAN_GAP", { plan_gap: "cited file is gone" }) }));
    eq([r.result?.status, r.result?.plan_gap], ["PLAN_GAP", "cited file is gone"], "sprint-flow: PLAN_GAP returns to the orchestrator");

    // 12. a dead executor is re-dispatched once, then reported
    r = await run(c, A(), play({ exec: [null, st("DONE")], review: clean }));
    eq([r.result?.status, labels(r).filter((l) => l === "exec:S-001").length], ["READY_TO_LAND", 2], "sprint-flow: one re-dispatch after a death");
    check(r.calls[1].prompt.includes("died mid-run"), "sprint-flow: the re-dispatch is told to continue from the branch");
    r = await run(c, A(), play({ exec: null }));
    eq([r.result?.status, r.result?.sprint], ["DIED", "S-001"], "sprint-flow: two deaths → DIED (with the sprint id, not an empty object)");

    // 13. high risk → three independent lenses, in parallel
    r = await run(c, A({}, { risk: "high" }), play({ exec: st("DONE"), review: clean }));
    eq(labels(r).slice(1), ["review:S-001:correctness", "review:S-001:security", "review:S-001:tests"], "sprint-flow: a high-risk sprint gets three review lenses");
    check(/correctness, security, tests/.test(r.result?.review_record[0]) && /high-risk deep pass/.test(r.result.review_record[0]), "sprint-flow: the record names the lenses that ran");

    // 14. a confirmed finding is fixed, re-checked, and recorded with its commit
    r = await run(c, A(), play({ exec: st("DONE"), review: { findings: [F("Critical"), F("Minor", "src/a.ts:9", "naming")], summary: "one bug" }, verify: { verdict: "confirmed", evidence: "src/a.ts:3", note: "real" }, fix: st("DONE", { commits: ["abc S-001: thing", "def S-001: address review — null path"], fixes: [{ id: "F1", disposition: "fixed", detail: "def" }] }), recheck: { resolved: true, evidence: "src/a.ts:3 guarded" } }));
    eq(labels(r), ["exec:S-001", "review:S-001:review", "verify:S-001#1", "fix:S-001 r1", "recheck:S-001:F1"], "sprint-flow: review → verify (not the Minor) → fix → re-check");
    eq([r.result?.status, r.result?.review.rounds, r.result?.review.counts], ["READY_TO_LAND", 1, { raised: 2, fixed: 1, refuted: 0, overturned: 0, noted: 1, open: 0 }], "sprint-flow: fixed finding → READY_TO_LAND");
    check(/^- Critical \(review\) src\/a\.ts:3 — null path — fixed def$/.test(r.result?.review_record[0]) && /Minor.*declined: minor, noted/.test(r.result.review_record[1]), `sprint-flow: record lines carry severity, location and disposition: ${JSON.stringify(r.result?.review_record)}`);
    check(r.calls[3].prompt.includes("F1 [Critical] src/a.ts:3") && r.calls[3].prompt.includes("Do not touch the sprint file's `### Review` section"), "sprint-flow: the fix round names each finding and leaves the Review section to the orchestrator");
    eq(r.result?.commits, ["abc S-001: thing", "def S-001: address review — null path"], "sprint-flow: commits include the fix");

    // 15. a refuted finding costs no fix round
    r = await run(c, A(), play({ exec: st("DONE"), review: { findings: [F("Important")], summary: "s" }, verify: { verdict: "refuted", evidence: "src/a.ts:1 handles it", note: "handled upstream" } }));
    eq([r.result?.status, labels(r).some((l) => l.startsWith("fix")), /refuted on verification: handled upstream/.test(r.result?.review_record[0])], ["READY_TO_LAND", false, true], "sprint-flow: refuted finding → no fix round, recorded as refuted");
    // … and a downgrade to Minor likewise
    r = await run(c, A(), play({ exec: st("DONE"), review: { findings: [F("Critical")], summary: "s" }, verify: { verdict: "downgrade-minor", evidence: "e", note: "n" } }));
    eq([r.result?.status, r.result?.review.findings[0].severity, r.result?.review.findings[0].disposition], ["READY_TO_LAND", "Minor", "noted"], "sprint-flow: a finding downgraded to Minor is noted, not fixed");

    // 16. a finding that survives two fix rounds parks the sprint — never landed over
    r = await run(c, A(), play({ exec: st("DONE"), review: { findings: [F("Critical")], summary: "s" }, verify: { verdict: "confirmed", evidence: "e", note: "n" }, fix: st("DONE", { fixes: [{ id: "F1", disposition: "fixed", detail: "def" }] }), recheck: { resolved: false, evidence: "src/a.ts:3 still unguarded" } }));
    eq([r.result?.status, r.result?.review.rounds, r.result?.review.counts.open, r.result?.question.class], ["PARKED", 2, 1, "reserved"], "sprint-flow: an unresolved Critical after two rounds is the user's decision");
    check(/OPEN: src\/a\.ts:3 still unguarded/.test(r.result?.review_record[0]), "sprint-flow: the open finding is recorded as OPEN with the re-check evidence");

    // 17. a disputed finding is the arbiter's call, on evidence
    const dispute = { exec: st("DONE"), review: { findings: [F("Critical")], summary: "s" }, verify: { verdict: "confirmed", evidence: "e", note: "n" }, fix: st("DONE", { fixes: [{ id: "F1", disposition: "disputed", detail: "src/a.ts:1 guards it" }] }) };
    r = await run(c, A(), play({ ...dispute, arbiter: { ...taste, class: "mechanical", decision: "OVERTURNED — the guard at src/a.ts:1 covers it", principle: "src/a.ts:1" } }));
    eq([r.result?.status, r.result?.review.counts.overturned, /overturned by arbiter/.test(r.result?.review_record[0])], ["READY_TO_LAND", 1, true], "sprint-flow: a finding the arbiter overturns is closed");
    r = await run(c, A(), play({ ...dispute, arbiter: { ...taste, class: "mechanical", decision: "STANDS — the guard is on another path", principle: "src/a.ts:3" } }));
    eq([r.result?.status, r.result?.review.counts.open], ["PARKED", 1], "sprint-flow: a finding the arbiter upholds stays open");

    // 18. a reviewer that never returned is not a clean review
    r = await run(c, A(), play({ exec: st("DONE"), review: null }));
    eq([r.result?.status, /did not complete/.test(r.result?.question.question), /REVIEW INCOMPLETE/.test(r.result?.review_record.join("\n"))], ["PARKED", true, true], "sprint-flow: a dead reviewer parks the sprint — never READY_TO_LAND");

    // 19. two lenses raising the same line is one finding
    r = await run(c, A({}, { risk: "high" }), play({ exec: st("DONE"), review: { findings: [F("Important")], summary: "s" }, verify: { verdict: "refuted", evidence: "e", note: "n" } }));
    eq(r.result?.review.counts.raised, 1, "sprint-flow: duplicate findings across lenses are de-duplicated");

    // 20. resume and train mode
    r = await run(c, A({ resume: "claim granted for src/b.ts" }), play({ exec: st("DONE"), review: clean }));
    check(r.calls[0].prompt.includes("claim granted for src/b.ts") && r.calls[0].prompt.includes("You are continuing this sprint"), "sprint-flow: a resumed run tells the executor what was resolved");
    r = await run(c, A({ mode: "train" }, { diffBase: "abc123" }), play({ exec: st("DONE"), review: clean }));
    check(r.calls[1].prompt.includes('diff abc123..HEAD') && r.calls[0].prompt.includes("never rewrite commits before it"), "sprint-flow: train mode reviews from the predecessor's boundary");

    // 21. bad arguments
    for (const bad of [{ ...A(), sprint: { id: "nope", worktree: "/w" } }, { ...A(), routing: undefined }, { ...A(), sprint: { id: "S-001" } }]) {
      r = await run(c, bad, () => null);
      check(r.error instanceof Error, "sprint-flow: bad args should throw");
    }
  }
}

if (failed) {
  console.error(`test-workflows: ${failed} check(s) failed`);
  process.exit(1);
}
console.log(`test-workflows: all checks passed (${scripts.length} scripts)`);
