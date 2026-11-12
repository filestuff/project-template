#!/usr/bin/env node
// Regression: sprint briefs reached execution with unfilled template text, deliverables
// without criteria, Consumes bullets nobody Produces, and risk:high sprints with no
// Production notes. plan-check.mjs lints the BRIEF before the sprint runs (close-check
// lints the record after); this pins its grammar rule by rule.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

const SCRIPT = new URL("../lite/scripts/sprint/plan-check.mjs", import.meta.url).pathname;
const SPRINT_TEMPLATE = new URL("../lite/docs/sprints/SPRINT_TEMPLATE.md", import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), "plan-check-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
// Build a fake repo from {relpath: content}; always has two citeable source files.
function mkRoot(files = {}) {
  const root = join(tmp, `root${++seq}`);
  const all = {
    "src/a.js": Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n",
    "src/b.js": "one\ntwo\nthree\n",
    // the lint reads the repo's own template to know which `{…}` strings are placeholders
    "docs/sprints/SPRINT_TEMPLATE.md": readFileSync(SPRINT_TEMPLATE, "utf8"),
    ...files,
  };
  for (const [rel, body] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}
function run(root, args = [], cwd = tmp) {
  try {
    const out = execFileSync("node", [SCRIPT, "--root", root, ...args], { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out, err: "" };
  } catch (e) {
    return { code: e.status, out: e.stdout ?? "", err: e.stderr ?? "" };
  }
}
let failed = 0;
const check = (label, cond, extra = "") => {
  if (!cond) { failed++; console.error(`FAIL ${label}${extra ? `\n${extra}` : ""}`); }
};
const BL = "docs/sprints/backlog";

// --- sprint builder ---------------------------------------------------------------------------
const sprint = ({
  id = "S-001", points = "3", risk = "low", tier = "standard", depends = "[]", blocks = "[]", proposal = "null",
  touches = "[]", deliverables, produces = "— none", consumes = "— none", notes = "", oq, risks, title,
} = {}) => `---
sprint: ${id}
status: backlog
goal: Make the thing fast
short: Fast thing
tasks: null
proposal: ${proposal}
stage: null
depends_on: ${depends}
blocks: ${blocks}
tags: []
${points === null ? "" : `story_points: ${points}\n`}${risk === null ? "" : `risk: ${risk}\n`}${tier === null ? "" : `tier: ${tier}\n`}plan_date: null
start_date: null
end_date: null
touches: ${touches}
---

# ${title ?? `${id}: Make it fast`}

<!-- a comment: path/to/thing {placeholder} - [ ] fake box; must be ignored -->

## Context

- Source: — none

## Scope

### Deliverables

${deliverables ?? `1. **Add the cache**
   - Files: \`src/a.js\` (modified)
   - Acceptance criteria:
     - Automated:
       - [ ] \`npm test\` → 3 passed

2. **Wire it**
   - Files: \`src/b.js\` (modified)
   - Acceptance criteria:
     - Automated:
       - [ ] \`npm run lint\` → clean
`}
### Out of Scope

- nothing

## Interface Contract

### Produces

${produces}

### Consumes

${consumes}

## Testing

- [ ] RED: failing test written first

## Risks

${risks ?? `| Risk | Mitigation |
|------|-----------|
| Stale cache | TTL of 60s |
`}
${notes}## Open Questions

${oq ?? "- [ ] Which eviction policy? — options: LRU (recommended), FIFO"}
`;
const NOTES = `## Production notes

- Rollback: revert the commit; cache is rebuilt on next start, nothing lost
- Observability: log \`cache.hit_rate\`; alert below 50%
- Security: n/a — cache holds public data only

`;
const A = () => sprint({ id: "S-001", blocks: "[S-002]", produces: "- `Widget` — `src/a.js`: build(opts) returns a Widget" });
const B = (over = {}) => sprint({ id: "S-002", depends: "[S-001]", consumes: "- `Widget` from S-001 — `src/a.js`: build(opts) signature", ...over });
const twoSprints = (over = {}) => ({ [`${BL}/S-001-first.md`]: A(), [`${BL}/S-002-second.md`]: B(over) });

const rejects = (label, files, rule, args = [], expectSprint) => {
  const root = mkRoot(files);
  const r = run(root, args);
  check(`${label}: exits 5`, r.code === 5, r.out + r.err);
  check(`${label}: names ${rule}`, new RegExp(`FAIL ${rule} S-\\d+ L\\d+`).test(r.out), r.out);
  if (expectSprint) check(`${label}: attributed to ${expectSprint}`, new RegExp(`FAIL ${rule} ${expectSprint} `).test(r.out), r.out);
  return r;
};

// 1. valid two-sprint backlog
{
  const root = mkRoot(twoSprints());
  const r = run(root);
  check("valid two-sprint backlog exits 0", r.code === 0, r.out + r.err);
  check("summary line", /SUMMARY plan-check: ok — 2 sprint\(s\), 0 failure\(s\), 0 warning\(s\)/.test(r.out), r.out);
  const rc = run(root, [], root);
  check("works from the root as cwd and from an unrelated cwd", rc.code === 0, rc.out);
}

// 2. frontmatter-invalid
const fmCase = (label, over, patch) => {
  let body = sprint({ id: "S-001", ...over });
  if (patch) body = patch(body);
  return rejects(`frontmatter ${label}`, { [`${BL}/S-001-x.md`]: body }, "frontmatter-invalid");
};
fmCase("story_points 4", { points: "4" });
fmCase("story_points 0", { points: "0" });
fmCase("story_points missing", { points: null });
fmCase("risk medium", { risk: "medium" });
fmCase("tier huge", { tier: "huge" });
fmCase("depends_on not flow array", { depends: "S-002" });
fmCase("blocks bad id", { blocks: "[S-2x]" });
fmCase("sprint id mismatch", {}, (b) => b.replace("sprint: S-001", "sprint: S-002"));
fmCase("sprint not S-NNN", {}, (b) => b.replace("sprint: S-001", "sprint: sprint-one"));
rejects("no frontmatter", { [`${BL}/S-001-x.md`]: "# S-001: no frontmatter\n" }, "frontmatter-invalid");
for (const pts of ["1", "2", "3", "5", "8", "13"]) {
  const r = run(mkRoot({ [`${BL}/S-001-x.md`]: sprint({ points: pts }) }));
  check(`story_points ${pts} is valid`, r.code === 0, r.out);
}

// 3. pre-1.11 file: no risk/tier keys
{
  const r = run(mkRoot({ [`${BL}/S-001-x.md`]: sprint({ risk: null, tier: null }) }), ["--json"]);
  const j = JSON.parse(r.out);
  check("no risk/tier keys passes (read as low/standard)", r.code === 0 && j.sprints[0].risk === null && j.sprints[0].tier === null, r.out);
}

// 4. dependencies
rejects("dependency-unknown", { [`${BL}/S-002-second.md`]: B() }, "dependency-unknown", [], "S-002");
rejects("dependency-rejected", {
  [`${BL}/S-002-second.md`]: B({ consumes: "— none" }),
  "docs/sprints/rejected/S-001-old.md": A(),
}, "dependency-rejected", [], "S-002");
{
  const root = mkRoot({
    [`${BL}/S-002-second.md`]: B({ consumes: "— none" }),
    "docs/sprints/done/S-001-first.md": A(),
  });
  const r = run(root);
  check("dependency found in done/ passes", r.code === 0, r.out);
  const root2 = mkRoot({
    [`${BL}/S-002-second.md`]: B({ consumes: "— none" }),
    "docs/sprints/done/archive/S-001-first.md": A(),
  });
  check("dependency found in done/archive/ passes", run(root2).code === 0, run(root2).out);
  const root3 = mkRoot({
    [`${BL}/S-002-second.md`]: B({ consumes: "— none" }),
    "docs/sprints/in-progress/S-001-first.md": A(),
  });
  check("dependency found in in-progress/ passes", run(root3).code === 0, run(root3).out);
}

// 5. cycle (reported once)
{
  const files = {
    [`${BL}/S-001-first.md`]: sprint({ id: "S-001", depends: "[S-002]" }),
    [`${BL}/S-002-second.md`]: sprint({ id: "S-002", depends: "[S-001]" }),
  };
  const r = rejects("dependency-cycle", files, "dependency-cycle");
  check("cycle reported exactly once", (r.out.match(/FAIL dependency-cycle/g) ?? []).length === 1, r.out);
  check("cycle lists both ids", /S-001/.test(r.out.split("\n").find((l) => l.includes("dependency-cycle")) ?? "") && /S-002/.test(r.out.split("\n").find((l) => l.includes("dependency-cycle")) ?? ""), r.out);
  const three = {
    [`${BL}/S-001-a.md`]: sprint({ id: "S-001", depends: "[S-003]" }),
    [`${BL}/S-002-b.md`]: sprint({ id: "S-002", depends: "[S-001]" }),
    [`${BL}/S-003-c.md`]: sprint({ id: "S-003", depends: "[S-002]" }),
  };
  const r3 = run(mkRoot(three));
  check("3-cycle reported once", (r3.out.match(/FAIL dependency-cycle/g) ?? []).length === 1, r3.out);
}

// 6. placeholder-left
rejects("placeholder S-NNN title", { [`${BL}/S-001-x.md`]: sprint({ title: "S-NNN: [Sprint Name]" }) }, "placeholder-left");
rejects("placeholder path/to in backticks", { [`${BL}/S-001-x.md`]: sprint().replace("`src/a.js` (modified)", "`path/to/file` (new)") }, "placeholder-left");
rejects("placeholder brace", { [`${BL}/S-001-x.md`]: sprint().replace("- nothing", "- {the trust boundary or permission this touches and what enforces it}") }, "placeholder-left");
{
  // Braces that are NOT template placeholders are honest prose, not a lint failure.
  const r = run(mkRoot({ [`${BL}/S-001-x.md`]: sprint().replace("- nothing", "- the handler returns {ok: true} and logs {userId}") }));
  check("prose braces that are not template placeholders pass", r.code === 0, r.out);
}
rejects("placeholder goal sentence", { [`${BL}/S-001-x.md`]: sprint().replace("goal: Make the thing fast", 'goal: One sentence describing what "done" looks like') }, "placeholder-left");
rejects("placeholder risks cells", { [`${BL}/S-001-x.md`]: sprint({ risks: "| Risk | Mitigation |\n|---|---|\n| Description | How to handle |\n" }) }, "placeholder-left");
rejects("placeholder feature name", { [`${BL}/S-001-x.md`]: sprint().replace("**Add the cache**", "**[Feature/Task Name]**") }, "placeholder-left");
{
  const body = sprint().replace("- nothing", "- the `{a: 1}` literal is out of scope\n\n```js\nconst o = {name};\n```");
  const r = run(mkRoot({ [`${BL}/S-001-x.md`]: body }));
  check("braces in code span / fence are not placeholders", r.code === 0, r.out);
}

// 7. deliverables / criteria
rejects("deliverables-missing", { [`${BL}/S-001-x.md`]: sprint({ deliverables: "Just prose, no numbered items.\n" }) }, "deliverables-missing");
{
  const r = rejects("criteria-missing", {
    [`${BL}/S-001-x.md`]: sprint({
      deliverables: `1. **Add the cache**
   - Acceptance criteria:
     - Automated:
       - [ ] \`npm test\` → ok

2. **Wire it**
   - Files: \`src/b.js\` (modified)
`,
    }),
  }, "criteria-missing");
  check("criteria-missing points at deliverable 2", /Wire it/.test(r.out) && !/Add the cache/.test(r.out), r.out);
}

// 8. contract-unproduced
{
  const r = rejects("contract: identifier not in Produces", twoSprints({ consumes: "- `Gadget` from S-001 — `src/a.js`: signature" }), "contract-unproduced", [], "S-002");
  check("names the missing identifier", /Gadget/.test(r.out), r.out);
}
rejects("contract: source not in depends_on", {
  [`${BL}/S-001-first.md`]: A(),
  [`${BL}/S-002-second.md`]: B({ depends: "[]", consumes: "- `Widget` from S-001 — `src/a.js`: sig" }),
}, "contract-unproduced", [], "S-002");
rejects("contract: no source sprint", twoSprints({ consumes: "- `Widget` — `src/a.js`: sig" }), "contract-unproduced", [], "S-002");
{
  const r = run(mkRoot({
    [`${BL}/S-002-second.md`]: B({ consumes: "- `Anything` from S-001 — `src/a.js`: sig" }),
    "docs/sprints/done/S-001-first.md": A(),
  }));
  check("contract: dependency in done/ only checks (a)", r.code === 0, r.out);
  const r2 = run(mkRoot({
    [`${BL}/S-002-second.md`]: B({ depends: "[]", consumes: "- `Anything` from S-001 — `src/a.js`: sig" }),
    "docs/sprints/done/S-001-first.md": A(),
  }));
  check("contract: dependency in done/ still needs (a)", r2.code === 5 && /contract-unproduced/.test(r2.out), r2.out);
  const none = run(mkRoot({ [`${BL}/S-001-x.md`]: sprint({ produces: "none", consumes: "none" }) }));
  check("Consumes/Produces bodies of none pass", none.code === 0, none.out);
}

// 9. production notes
{
  const bad = rejects("production-notes missing section", { [`${BL}/S-001-x.md`]: sprint({ risk: "high" }) }, "production-notes-missing");
  const ok = run(mkRoot({ [`${BL}/S-001-x.md`]: sprint({ risk: "high", notes: NOTES }) }));
  check("risk: high with Production notes passes", ok.code === 0, ok.out);
  const low = run(mkRoot({ [`${BL}/S-001-x.md`]: sprint({ risk: "low" }) }));
  check("risk: low needs no Production notes", low.code === 0, low.out);
  rejects("production-notes missing bullet", { [`${BL}/S-001-x.md`]: sprint({ risk: "high", notes: NOTES.replace(/- Observability:[^\n]*\n/, "") }) }, "production-notes-missing");
  rejects("production-notes bare n/a", { [`${BL}/S-001-x.md`]: sprint({ risk: "high", notes: NOTES.replace("n/a — cache holds public data only", "n/a") }) }, "production-notes-missing");
  rejects("production-notes empty bullet", { [`${BL}/S-001-x.md`]: sprint({ risk: "high", notes: NOTES.replace(/- Rollback:[^\n]*/, "- Rollback:") }) }, "production-notes-missing");
  void bad;
}

// 10. open-question-vague
rejects("open-question-vague", { [`${BL}/S-001-x.md`]: sprint({ oq: "- [ ] How should errors be handled?" }) }, "open-question-vague");
{
  const r = run(mkRoot({ [`${BL}/S-001-x.md`]: sprint({ oq: "- [x] Settled already\n- [ ] Pick one — options: A, B" }) }));
  check("checked questions and questions with options: pass", r.code === 0, r.out);
}

// 11. citations
{
  const r = rejects("citation to missing file", { [`${BL}/S-001-x.md`]: sprint().replace("- nothing", "- see src/nope.js:4") }, "citation-unresolved");
  rejects("citation past end of file", { [`${BL}/S-001-x.md`]: sprint().replace("- nothing", "- see `src/b.js:40`") }, "citation-unresolved");
  void r;
  const ok = run(mkRoot({ [`${BL}/S-001-x.md`]: sprint().replace("- nothing", "- see src/b.js:3, `src/a.js:2-5`, http://localhost:3000/x at 12:30, commit S-001: x") }));
  check("valid citations / URL / time / commit grammar pass", ok.code === 0, ok.out);
}

// 12. touches WARN only when claims.mjs exists
{
  const lite = run(mkRoot({ [`${BL}/S-001-x.md`]: sprint() }));
  check("no claims.mjs: no touches warning", lite.code === 0 && !/touches-empty/.test(lite.out), lite.out);
  const full = run(mkRoot({ [`${BL}/S-001-x.md`]: sprint(), "scripts/sprint/claims.mjs": "// stub\n" }));
  check("claims.mjs present: touches-empty is a WARN and exits 0", full.code === 0 && /WARN touches-empty S-001 L\d+/.test(full.out) && /1 warning\(s\)/.test(full.out), full.out);
  const filled = run(mkRoot({ [`${BL}/S-001-x.md`]: sprint({ touches: "[src/a.js]" }), "scripts/sprint/claims.mjs": "// stub\n" }));
  check("claims.mjs present + touches filled: no warning", filled.code === 0 && !/touches-empty/.test(filled.out), filled.out);
}

// 13. explicit ids
{
  const root = mkRoot({
    [`${BL}/S-001-first.md`]: sprint({ id: "S-001", points: "4" }), // broken, but not asked for
    "docs/sprints/in-progress/S-002-second.md": sprint({ id: "S-002" }),
  });
  const r = run(root, ["S-002"]);
  check("explicit id finds a sprint in in-progress/ and ignores other backlog files", r.code === 0 && /1 sprint\(s\)/.test(r.out), r.out);
  const r2 = run(root, ["S-001"]);
  check("explicit id lints just that sprint", r2.code === 5 && /frontmatter-invalid S-001/.test(r2.out), r2.out);
  const r3 = run(root, ["S-099"]);
  check("unknown id exits 1", r3.code === 1 && /S-099/.test(r3.err), r3.out + r3.err);
  const done = run(mkRoot({ "docs/sprints/done/S-005-old.md": sprint({ id: "S-005" }) }), ["S-005"]);
  check("an id that exists only in done/ is unknown for linting", done.code === 1, done.out);
  const nobl = run(join(tmp, "nonexistent-root"));
  check("no backlog directory exits 1", nobl.code === 1, nobl.out + nobl.err);
  const empty = mkRoot({});
  mkdirSync(join(empty, BL), { recursive: true });
  check("empty backlog exits 0", run(empty).code === 0);
  const bad = run(mkRoot({}), ["bogus"]);
  check("non-id positional exits 1", bad.code === 1, bad.out + bad.err);
}

// 14. --json
{
  const r = run(mkRoot(twoSprints()), ["--json"]);
  let j; try { j = JSON.parse(r.out); } catch { j = null; }
  check("--json parses", j !== null, r.out);
  check("--json shape", j && j.ok === true && j.failures === 0 && j.record === null && j.sprints.length === 2
    && j.sprints[1].sprint === "S-002" && j.sprints[1].risk === "low" && j.sprints[1].tier === "standard"
    && Array.isArray(j.sprints[1].failures) && Array.isArray(j.sprints[1].warnings) && typeof j.sprints[1].file === "string", r.out);
  const b = run(mkRoot({ [`${BL}/S-001-x.md`]: sprint({ points: "4" }) }), ["--json"]);
  const jb = JSON.parse(b.out);
  check("--json failure entries", b.code === 5 && jb.ok === false && jb.failures === 1 && jb.sprints[0].failures[0].rule === "frontmatter-invalid" && typeof jb.sprints[0].failures[0].line === "number", b.out);
}

// 15. THE SHIPPED TEMPLATE must never pass
{
  const r = run(mkRoot({ [`${BL}/S-001-x.md`]: readFileSync(SPRINT_TEMPLATE, "utf8") }));
  check("shipped SPRINT_TEMPLATE.md as S-001-x.md exits 5", r.code === 5, r.out);
  check("template: placeholder-left", /FAIL placeholder-left S-001/.test(r.out), r.out);
  check("template: frontmatter-invalid", /FAIL frontmatter-invalid S-001/.test(r.out), r.out);
}

// 16. --record
const RECORD = (over = {}) => `# Proposal 007: Cache

**Status**: active (stage 1/1)

## Problem

Slow.

## Plan record

<!-- ${over.comment ?? ""} -->

### 2026-09-01 — stage 1 breakdown (S-001..S-002)

${over.coverage ?? "| Requirement | Sprint |\n|---|---|\n| cache | S-001 |\n| wiring | S-002 |\n"}
${over.tail ?? "NO UNRESOLVED DECISIONS"}
`;
const withRecord = (rec, name = "007-cache.md", files = twoSprints()) => {
  const root = mkRoot({ ...files, [`docs/proposals/${name}`]: rec });
  return { root, rec: `docs/proposals/${name}` };
};
{
  const { root, rec } = withRecord(RECORD());
  const r = run(root, ["--record", rec]);
  check("valid record exits 0", r.code === 0, r.out + r.err);
  const rj = JSON.parse(run(root, ["--record", rec, "--json"]).out);
  check("--json record object present and ok", rj.record && rj.record.ok === true && Array.isArray(rj.record.failures), JSON.stringify(rj.record));
  const abs = run(root, ["--record", join(root, rec)]);
  check("absolute --record path works", abs.code === 0, abs.out);
}
const recordRejects = (label, rec, rule, name) => {
  const { root, rec: p } = withRecord(rec, name);
  const r = run(root, ["--record", p]);
  check(`${label}: exits 5`, r.code === 5, r.out + r.err);
  check(`${label}: names ${rule}`, new RegExp(`FAIL ${rule} record L\\d+`).test(r.out), r.out);
};
recordRejects("record-missing", "# Proposal 007\n\n## Problem\n\nSlow.\n", "record-missing");
recordRejects("record-missing (heading only inside a comment)", "# P\n\n<!-- ## Plan record\n\n### 2026 — x\n\n| a | S-001 |\n\nNO UNRESOLVED DECISIONS\n-->\n", "record-missing");
recordRejects("record-coverage-missing", RECORD({ coverage: "Sprints were created." }), "record-coverage-missing");
recordRejects("record-coverage-missing (table without S-ids)", RECORD({ coverage: "| Requirement | Sprint |\n|---|---|\n| cache | none yet |\n" }), "record-coverage-missing");
recordRejects("record-sentinel-missing", RECORD({ tail: "All decisions are made." }), "record-sentinel-missing");
recordRejects("record-sentinel-missing (sentinel not last)", RECORD({ tail: "NO UNRESOLVED DECISIONS\n\nSee also notes." }), "record-sentinel-missing");
recordRejects("record-unresolved", RECORD({ tail: "UNRESOLVED DECISIONS:\n- which store to use?\n- who owns rollout?" }), "record-unresolved");
{
  // latest entry wins for the coverage map
  const rec = `# P\n\n## Plan record\n\n### 2026-09-01 — stage 1 breakdown\n\n| a | S-001 |\n\n### 2026-09-05 — recut\n\nNothing mapped here.\n\nNO UNRESOLVED DECISIONS\n`;
  const { root, rec: p } = withRecord(rec);
  const r = run(root, ["--record", p]);
  check("coverage map must be in the LATEST entry", r.code === 5 && /record-coverage-missing/.test(r.out), r.out);
}
{
  // coverage-ghost: backlog sprints citing the record's proposal number
  const files = {
    [`${BL}/S-001-first.md`]: sprint({ id: "S-001", proposal: "7", blocks: "[S-002]", produces: "- `Widget` — `src/a.js`: sig" }),
    [`${BL}/S-002-second.md`]: B({ proposal: "7" }),
  };
  const ghost = { [`${BL}/S-003-third.md`]: sprint({ id: "S-003", proposal: "7" }) };
  const other = { [`${BL}/S-004-fourth.md`]: sprint({ id: "S-004", proposal: "8" }) };
  const ok = withRecord(RECORD(), "007-cache.md", { ...files, ...other });
  const r = run(ok.root, ["--record", ok.rec]);
  check("coverage-ghost: all proposal-7 sprints covered (proposal 8 ignored) passes", r.code === 0, r.out);
  const bad = withRecord(RECORD(), "007-cache.md", { ...files, ...ghost });
  const rb = run(bad.root, ["--record", bad.rec]);
  check("coverage-ghost: uncovered backlog sprint fails", rb.code === 5 && /FAIL coverage-ghost S-003 L\d+/.test(rb.out), rb.out);
  const re = run(bad.root, ["--record", bad.rec, "S-001", "S-002"]);
  check("coverage-ghost: not applied in explicit-id mode", re.code === 0, re.out);
  const noRec = run(bad.root);
  check("coverage-ghost: not applied without --record", noRec.code === 0, noRec.out);
  const numeric = withRecord(RECORD(), "7-cache.md", { ...files, ...ghost });
  check("coverage-ghost: proposal number compared numerically (7 vs 007)", run(numeric.root, ["--record", numeric.rec]).code === 5);
  const prefixTrap = withRecord(RECORD(), "007-cache.md", { [`${BL}/S-001-first.md`]: sprint({ id: "S-001", proposal: "7" }) });
  const rp = run(prefixTrap.root, ["--record", prefixTrap.rec]);
  check("coverage-ghost: S-001 is covered by the S-001 mention (word-bounded)", rp.code === 0, rp.out);
}
{
  const missing = run(mkRoot(twoSprints()), ["--record", "docs/proposals/nope.md"]);
  check("unreadable --record exits 1", missing.code === 1, missing.out + missing.err);
}

// tiers — four values; both ends are earned: routine must meet its checklist, complex/critical must name a signal
{
  const withReason = (body, reason) => body.replace(/^tier: (\w+)$/m, (m) => `${m}\ntier_reason: ${reason}`);
  for (const t of ["routine", "standard", "complex", "critical"]) {
    const body = withReason(sprint({ tier: t, points: "2", oq: "— none" }), "follows src/a.js:1-3 — same shape");
    const r = run(mkRoot({ [`${BL}/S-001-x.md`]: body }));
    check(`tier ${t} with a reason is valid`, r.code === 0, r.out);
  }
  rejects("tier: routine without a reason", { [`${BL}/S-001-x.md`]: sprint({ tier: "routine", points: "2", oq: "— none" }) }, "tier-unjustified");
  rejects("tier: routine with tier_reason: null", { [`${BL}/S-001-x.md`]: withReason(sprint({ tier: "routine", points: "2", oq: "— none" }), "null") }, "tier-unjustified");
  rejects("tier: routine on a 5-point sprint", { [`${BL}/S-001-x.md`]: withReason(sprint({ tier: "routine", points: "5", oq: "— none" }), "follows src/a.js:1") }, "tier-unjustified");
  {
    const r = run(mkRoot({ [`${BL}/S-001-x.md`]: withReason(sprint({ tier: "routine", points: "2", risk: "high", notes: NOTES, oq: "— none" }), "follows src/a.js:1") }));
    check("tier: routine with risk: high is rejected", r.code === 5 && /tier-unjustified.*risk: high/.test(r.out), r.out);
  }
  {
    const r = run(mkRoot({ [`${BL}/S-001-x.md`]: withReason(sprint({ tier: "routine", points: "2", oq: "- [ ] Which cache? — options: A lru, B ttl" }), "follows src/a.js:1") }));
    check("tier: routine with an open question is rejected", r.code === 5 && /tier-unjustified.*open question/.test(r.out), r.out);
    const ok = run(mkRoot({ [`${BL}/S-001-x.md`]: withReason(sprint({ tier: "standard", points: "2", oq: "- [ ] Which cache? — options: A lru, B ttl" }), "x") }));
    check("the same open question on a standard sprint is fine", ok.code === 0, ok.out);
  }
  for (const t of ["complex", "critical"]) {
    rejects(`tier: ${t} without a reason`, { [`${BL}/S-001-x.md`]: sprint({ tier: t }) }, "tier-unreasoned");
    rejects(`tier: ${t} with tier_reason: null`, { [`${BL}/S-001-x.md`]: withReason(sprint({ tier: t }), "null") }, "tier-unreasoned");
    const r = run(mkRoot({ [`${BL}/S-001-x.md`]: withReason(sprint({ tier: t, risk: "high", notes: NOTES }), "new retry state machine across two services") }));
    check(`tier: ${t} with a reason on a high-risk sprint is valid`, r.code === 0, r.out);
  }
  {
    const r = run(mkRoot({ [`${BL}/S-001-x.md`]: sprint({ tier: "standard" }) }));
    check("tier: standard needs no reason and does not warn", r.code === 0 && !/tier-un/.test(r.out), r.out);
  }
}

if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log("plan-check: all checks passed");
