#!/usr/bin/env node
// Regression: a sprint could land with a virgin Completion Log (57% of one
// downstream repo's done sprints) because nothing checked the record before the
// in-progress → done move. close-check.mjs is that check; this pins its grammar.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCRIPT = new URL("../lite/scripts/sprint/close-check.mjs", import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), "close-check-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

function run(name, body, ...flags) {
  const f = join(tmp, name);
  writeFileSync(f, body);
  try {
    const out = execFileSync("node", [SCRIPT, f, ...flags], { encoding: "utf8" });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: e.stdout ?? "" };
  }
}
let failed = 0;
const check = (label, cond, extra = "") => {
  if (!cond) { failed++; console.error(`FAIL ${label}${extra ? `\n${extra}` : ""}`); }
};

const FM = "---\nsprint: S-001\nstatus: in-progress\ngoal: g\n---\n\n# S-001: X\n\n";
const deliverables = ({ evidence = true, manual = "confirmed", extraUnchecked = false } = {}) => `## Scope

### Deliverables

1. **Thing**
   - Acceptance criteria:
     - Automated:
       - [x] \`npm test\` → 3 passed
${evidence ? "         - Evidence: `npm test` → Tests 3 passed (3)\n" : ""}${extraUnchecked ? "       - [ ] `npm run lint` → clean\n" : ""}     - Manual (user-confirmed at close):
       - [x] Looks right on mobile${manual === "confirmed" ? " — confirmed 2026-09-01" : ""}

### Out of Scope

- [ ] this box is NOT a criterion

## Testing

- [ ] RED: ignored by the lint
`;
const log = ({ outcome = "Shipped the thing; users see X.", review = "— not run: low risk (Step 3.5)", learnings = "- 2026-09-01 S-001 test: a flaky timer → rule: fake timers before render", gate = "gate: all checks passed", deployed = "n/a: docs-only", commits = "_(stamped at land)_" } = {}) => `
## Completion Log

<!-- a comment with - [ ] a fake box that must be ignored -->

### Outcome

${outcome}

### Commits

${commits}

### Review

${review}

### Deviations from brief

— none

### Deferred

— none

### Learnings

${learnings}

### Close checklist

- [x] Gate green — ${gate}
- [x] Docs synced — none: no doc references the changed internals
- [x] New docs registered — none: no new docs
- [x] ADR check — none: no architectural decision
- [x] Deferred work logged — none: nothing deferred
- [x] Deployed — ${deployed}
`;

// 1. complete record passes
let r = run("ok.md", FM + deliverables() + log());
check("complete record exits 0", r.code === 0, r.out);
check("SUMMARY reports 1/1 automated, 1/1 manual, 6/6 checklist",
  /SUMMARY S-001 automated=1\/1 descoped=0 manual=1\/1 checklist=6\/6 sections=ok/.test(r.out), r.out);

// 2. checked criterion without Evidence
r = run("noev.md", FM + deliverables({ evidence: false }) + log());
check("missing Evidence exits 5", r.code === 5);
check("names criterion-unevidenced", /FAIL criterion-unevidenced/.test(r.out), r.out);

// 3. unchecked automated criterion without descoped
r = run("unchecked.md", FM + deliverables({ extraUnchecked: true }) + log());
check("unchecked criterion → criterion-unchecked", r.code === 5 && /criterion-unchecked/.test(r.out), r.out);

// 4. Manual checked without 'confirmed'
r = run("manual.md", FM + deliverables({ manual: "bare" }) + log());
check("manual [x] without confirmed → manual-unconfirmed", r.code === 5 && /manual-unconfirmed/.test(r.out), r.out);

// 5. vacuous annotations
r = run("vacuous.md", FM + deliverables() + log({ gate: "done", deployed: "n/a" }));
check("'— done' and bare 'n/a' → checklist-unannotated x2", r.code === 5 && (r.out.match(/checklist-unannotated/g) ?? []).length === 2, r.out);

// 6. placeholder left + empty outcome
r = run("placeholder.md", FM + deliverables() + log({ outcome: "_(2–4 sentences at close …)_", review: "_(fill at close: …)_" }));
check("template placeholders → outcome-empty + placeholder-left", r.code === 5 && /outcome-empty/.test(r.out) && /placeholder-left/.test(r.out), r.out);

// 7. legacy log (no subsections) → warning, exit 0
r = run("legacy.md", FM + deliverables({ evidence: false }) + "\n## Completion Log\n\n- [ ] Implementation complete\n- [ ] Tests passing\n");
check("legacy log exits 0 with WARNING legacy-log", r.code === 0 && /WARNING legacy-log/.test(r.out), r.out);
// (criteria checks still run on legacy files — the missing Evidence above is a real failure only when the log is new)
check("legacy summary says sections=legacy", /sections=legacy/.test(r.out), r.out);

// 8. no Completion Log at all
r = run("nolog.md", FM + deliverables());
check("no log → record-missing", r.code === 5 && /record-missing/.test(r.out), r.out);

// 9. --json
r = run("json.md", FM + deliverables() + log(), "--json");
let j; try { j = JSON.parse(r.out); } catch { j = null; }
check("--json parses", j !== null, r.out);
check("--json ok:true, learnings has 1 entry, sprint id", j && j.ok === true && j.learnings.length === 1 && j.sprint === "S-001", r.out);
r = run("json-bad.md", FM + deliverables({ evidence: false }) + log(), "--json");
try { j = JSON.parse(r.out); } catch { j = null; }
check("--json ok:false with failure rule", j && j.ok === false && j.failures[0].rule === "criterion-unevidenced", r.out);

// 10. usage
r = run("nofm.md", "# no frontmatter\n");
check("no frontmatter exits 1", r.code === 1);

if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log("close-check: all checks passed");
