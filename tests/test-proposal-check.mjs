#!/usr/bin/env node
// Regression: proposals reached /plan with placeholders left, one-sided alternatives,
// bare "n/a" readiness answers and dangling file:line citations. proposal-check.mjs is
// the lint that stops that; this pins its grammar rule by rule.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SCRIPT = new URL("../lite/scripts/sprint/proposal-check.mjs", import.meta.url).pathname;
const TEMPLATE = new URL("../lite/docs/proposals/PROPOSAL_TEMPLATE.md", import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), "proposal-check-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

// A small fake repo so citations can resolve.
const repo = join(tmp, "repo");
mkdirSync(join(repo, "src"), { recursive: true });
writeFileSync(join(repo, "src/a.js"), Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
writeFileSync(join(repo, "src/b.js"), "one\ntwo\nthree\n");
// The lint reads the repo's own template to know which `{…}` strings are placeholders.
mkdirSync(join(repo, "docs/proposals"), { recursive: true });
writeFileSync(join(repo, "docs/proposals/PROPOSAL_TEMPLATE.md"), readFileSync(TEMPLATE, "utf8"));

function runIn(cwd, name, body, ...flags) {
  const f = join(tmp, name);
  writeFileSync(f, body);
  try {
    const out = execFileSync("node", [SCRIPT, f, "--root", repo, ...flags], { encoding: "utf8", cwd });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: e.stdout ?? "" };
  }
}
const run = (name, body, ...flags) => runIn(tmp, name, body, ...flags);
let failed = 0;
const check = (label, cond, extra = "") => {
  if (!cond) { failed++; console.error(`FAIL ${label}${extra ? `\n${extra}` : ""}`); }
};
const rejects = (label, body, rule) => {
  const r = run(`${label.replace(/\W+/g, "-")}.md`, body);
  check(`${label}: exits 5`, r.code === 5, r.out);
  check(`${label}: names ${rule}`, new RegExp(`FAIL ${rule} L\\d+`).test(r.out), r.out);
  return r;
};

// --- fixture builders -------------------------------------------------------------------
const TIER_SUBS = {
  light: ["Risks and rollback"],
  standard: ["Risks and rollback", "Architecture and data flow", "Interfaces and contracts", "Test strategy", "Observability"],
  critical: ["Risks and rollback", "Architecture and data flow", "Interfaces and contracts", "Test strategy", "Observability",
    "Data model and migration", "Security and threat model", "Failure modes", "Non-functional targets", "Rollout and rollback plan", "Cost and capacity"],
};
const readiness = (tier) => `## Production readiness

${(TIER_SUBS[tier] ?? TIER_SUBS.light).map((t) => `### ${t}

The ${t.toLowerCase()} story is covered here with concrete detail.
`).join("\n")}`;
const REVIEW_PASS = `## Review record

### 2026-09-01 round 1

| Lens | Score | Findings |
|---|---|---|
| correctness | 9 | none |

REVIEW: PASS
`;
const proposal = ({ rigor = "light", status = "draft", header = true, mid = "", extra = "" } = {}) => `# Proposal 007: Cache the thing

**Status**: ${status}
**Date**: 2026-09-01
${header ? `**Rigor**: ${rigor}\n` : ""}
<!-- a comment: ## Problem hidden here must not count -->

## Problem

Users wait too long. The slow path is at \`src/a.js:3\` and src/a.js:2-5. See https://example.com:8080/x at 12:30 and S-001: commit grammar.

## Goals / Non-Goals

- Goal: faster reads
- Non-Goal: new storage engine

## Alternatives

### A — Recommended: in-memory cache
Keeps hot rows in a map. Trade-offs: memory use.

### B — do nothing
Leave as is. Trade-offs: users keep waiting.

## Decision criteria

Reversibility and effort.

${header ? readiness(rigor) : ""}
${mid}
## Open questions

- [ ] TTL length — options: 60s (recommended: fresh enough), 5m — if deferred: ships with 60s
- [x] Already settled question

## References

Prior decisions consulted: none apply — searched docs/decisions/ for cache terms
${extra}`;
const withReview = (body) => body + "\n" + REVIEW_PASS;
const ACTIVE = { status: "active (stage 1/1)" };

// 1. fully valid file at each tier
for (const tier of ["light", "standard", "critical"]) {
  for (const [status, withRec] of [["draft", false], ["active (stage 1/1)", true]]) {
    let body = proposal({ rigor: tier, status });
    if (withRec) body = withReview(body);
    const r = run(`ok-${tier}-${status.slice(0, 3)}.md`, body);
    check(`valid ${tier}/${status} exits 0`, r.code === 0, r.out);
    check(`valid ${tier} summary`, new RegExp(`SUMMARY proposal-check: ok — rigor ${tier}, 0 failure\\(s\\), 2 citation\\(s\\) checked`).test(r.out), r.out);
  }
}
// works from any cwd (--root decides)
{
  const r = runIn(repo, "cwd.md", proposal());
  check("runs from an unrelated cwd", r.code === 0, r.out);
}

// 2. THE SHIPPED TEMPLATE must never pass
{
  const r = run("template.md", readFileSync(TEMPLATE, "utf8"));
  check("shipped template exits 5", r.code === 5, r.out);
  check("template: rigor-invalid", /FAIL rigor-invalid/.test(r.out), r.out);
  check("template: placeholder-left", /FAIL placeholder-left/.test(r.out), r.out);
  check("template: not legacy (has a Rigor line)", !/legacy-proposal/.test(r.out), r.out);
}

// 3. rigor-invalid
rejects("rigor-invalid", proposal({ rigor: "fast" }), "rigor-invalid");
rejects("rigor-template-value", proposal({ rigor: "light | standard | critical" }), "rigor-invalid");

// 4. section-missing / comments ignored / section-empty
rejects("section-missing", proposal().replace("## Decision criteria\n\nReversibility and effort.\n", ""), "section-missing");
rejects("heading only inside comment does not count",
  proposal().replace("## Decision criteria\n\nReversibility and effort.\n", "<!--\n## Decision criteria\n\nReversibility and effort.\n-->\n"), "section-missing");
rejects("production readiness required when Rigor set", proposal().replace(/## Production readiness[\s\S]*?(?=## Open questions)/, ""), "section-missing");
rejects("section-empty", proposal().replace("Users wait too long. The slow path is at `src/a.js:3` and src/a.js:2-5. See https://example.com:8080/x at 12:30 and S-001: commit grammar.", ""), "section-empty");
{
  // content that lives only in a comment is not content
  const r = rejects("section-empty comment-only", proposal().replace("Reversibility and effort.", "<!-- Reversibility and effort. -->"), "section-empty");
  check("section-empty points at Decision criteria", /Decision criteria/.test(r.out), r.out);
}

// 5. placeholder-left (and its false-positive guards)
rejects("placeholder brace", proposal().replace("Keeps hot rows in a map.", "{How it works.}"), "placeholder-left");
rejects("placeholder title", proposal().replace("Cache the thing", "Title In Plain Words"), "placeholder-left");
rejects("placeholder date", proposal().replace("2026-09-01\n", "YYYY-MM-DD\n"), "placeholder-left");
rejects("placeholder H1", proposal().replace("# Proposal 007:", "# Proposal NNN:"), "placeholder-left");
{
  const r = run("braces-ok.md", proposal({ extra: "\nNotes: the map is `{a: 1}` in memory.\n\n```js\nconst o = {name};\n```\n" }));
  check("braces in code span and fence are not placeholders", r.code === 0, r.out);
}
{
  const r = run("comment-placeholder-ok.md", proposal().replace("Keeps hot rows in a map.", "Keeps hot rows in a map.\n<!-- {How it works.} Title In Plain Words -->"));
  check("placeholder inside a comment is ignored", r.code === 0, r.out);
}

// 6. alternatives-too-few
rejects("alternatives-too-few", proposal().replace("### B — do nothing\nLeave as is. Trade-offs: users keep waiting.\n", ""), "alternatives-too-few");

// 7. citations
rejects("citation to missing file", proposal({ extra: "\nSee src/nope.js:4 for the old path.\n" }), "citation-unresolved");
{
  const r = rejects("citation past end of file", proposal({ extra: "\nSee `src/b.js:99` for the old path.\n" }), "citation-unresolved");
  check("citation failure names the citation", /src\/b\.js:99/.test(r.out), r.out);
}
rejects("citation range past end", proposal({ extra: "\nSee src/b.js:2-9.\n" }), "citation-unresolved");
{
  const r = run("cite-ok.md", proposal({ extra: "\nSee src/b.js:3 and `src/a.js:1-10`, http://localhost:3000/x, 12:30pm, v1.2:30, host.example.com:443, S-002: add thing, `src/{name}.js:5`, <dir>/x.js:9.\n" }));
  check("valid citations + URL/port/time/commit grammar/placeholder paths are not flagged", r.code === 0, r.out);
  check("only the real citations are counted", /4 citation\(s\) checked/.test(r.out), r.out);
}

// 8. readiness-missing / readiness-empty
rejects("readiness-missing", proposal({ rigor: "standard" }).replace(/### Observability[\s\S]*?(?=## Open questions)/, ""), "readiness-missing");
rejects("readiness-missing critical", proposal({ rigor: "critical" }).replace(/### Cost and capacity[\s\S]*?(?=## Open questions)/, ""), "readiness-missing");
{
  const body = proposal().replace(/(### Risks and rollback\n\n)[^\n]*/, "$1n/a");
  rejects("readiness-empty bare n/a", body, "readiness-empty");
  rejects("readiness-empty N/A.", proposal().replace(/(### Risks and rollback\n\n)[^\n]*/, "$1N/A."), "readiness-empty");
  rejects("readiness-empty none", proposal().replace(/(### Risks and rollback\n\n)[^\n]*/, "$1none"), "readiness-empty");
  rejects("readiness-empty heading only", proposal().replace(/(### Risks and rollback\n\n)[^\n]*/, "$1"), "readiness-empty");
  rejects("readiness-empty short reason", proposal().replace(/(### Risks and rollback\n\n)[^\n]*/, "$1n/a — docs only"), "readiness-empty");
  rejects("readiness-empty table without rows", proposal().replace(/(### Risks and rollback\n\n)[^\n]*/, "$1| Risk | Impact |\n|---|---|"), "readiness-empty");
  for (const sep of ["—", "-", ":"]) {
    const r = run(`na-reason-${sep.charCodeAt(0)}.md`, proposal().replace(/(### Risks and rollback\n\n)[^\n]*/, `$1n/a ${sep} nothing runs in production here`));
    check(`n/a ${sep} <3-word reason> passes`, r.code === 0, r.out);
  }
  const r = run("table-ok.md", proposal().replace(/(### Risks and rollback\n\n)[^\n]*/, "$1| Risk | Impact |\n|---|---|\n| stale cache | wrong reads |"));
  check("table with a data row passes", r.code === 0, r.out);
  const ci = run("heading-case.md", proposal().replace("### Risks and rollback", "### RISKS AND ROLLBACK"));
  check("readiness heading match is case-insensitive", ci.code === 0, ci.out);
}

// 9. open-question-vague
rejects("open-question-vague no options", proposal().replace("- [x] Already settled question", "- [ ] How should errors be handled?"), "open-question-vague");
rejects("open-question-vague no if deferred", proposal().replace("— if deferred: ships with 60s", ""), "open-question-vague");
{
  const r = run("oq-none.md", proposal().replace(/- \[ \] TTL[^\n]*\n- \[x\][^\n]*\n/, "— none\n"));
  check("— none body passes", r.code === 0, r.out);
  const r2 = run("oq-case.md", proposal().replace("options:", "OPTIONS:").replace("if deferred:", "If Deferred:"));
  check("options:/if deferred: are case-insensitive", r2.code === 0, r2.out);
}

// 10. stage-gate-missing
const STAGES = (s1gate, s1status = "- Status: pending") => `## Stages

### Stage 1 — Cache
- Delivers: faster reads
${s1gate}
${s1status}

### Stage 2 — Persist
- Delivers: warm restarts
- Status: pending

`;
const GATE = "- Gate: is the hit rate high enough?\n  - Options: A (recommended: ship), B, stop here\n  - Evidence: hit rate from the metrics dashboard";
{
  const r = run("stages-ok.md", proposal({ mid: STAGES(GATE) }));
  check("valid Stages (last stage needs no Gate) passes", r.code === 0, r.out);
}
rejects("stage without Gate", proposal({ mid: STAGES("") }), "stage-gate-missing");
rejects("gate without Evidence", proposal({ mid: STAGES("- Gate: enough?\n  - Options: A, B") }), "stage-gate-missing");
rejects("gate without Options", proposal({ mid: STAGES("- Gate: enough?\n  - Evidence: a metric") }), "stage-gate-missing");
rejects("stage without Status", proposal({ mid: STAGES(GATE, "") }), "stage-gate-missing");

// 11. prior-decisions-missing
rejects("prior-decisions absent", proposal().replace("Prior decisions consulted: none apply — searched docs/decisions/ for cache terms\n", "Nothing here.\n"), "prior-decisions-missing");
rejects("prior-decisions placeholder", proposal().replace("none apply — searched docs/decisions/ for cache terms", "{ADR-NNN — one line}"), "prior-decisions-missing");

// 12. review-missing / review-malformed
rejects("review-missing past draft", proposal(ACTIVE), "review-missing");
{
  const open = proposal(ACTIVE) + "\n## Review record\n\n### 2026-09-01\n\nREVIEW: OPEN — 2 finding(s) carried to Open questions\n";
  const r = run("review-open.md", open);
  check("REVIEW: OPEN — … passes", r.code === 0, r.out);
  const rej = run("rejected.md", proposal({ status: "rejected — not worth it" }));
  check("rejected needs no review record", rej.code === 0, rej.out);
  const draft = run("draft-norec.md", proposal());
  check("draft needs no review record", draft.code === 0, draft.out);
}
rejects("review last line wrong", proposal(ACTIVE) + "\n## Review record\n\nAll good.\nREVIEW: pass\n", "review-missing");
rejects("review empty section", proposal(ACTIVE) + "\n## Review record\n\n", "review-missing");
rejects("review-malformed on draft", proposal() + "\n## Review record\n\nREVIEW: MAYBE\n", "review-malformed");
{
  const r = run("review-order.md", withReview(proposal(ACTIVE)) + "\n## Plan record\n\nnotes after the review\n");
  check("review record may be followed by another ## section", r.code === 0, r.out);
}

// 13. legacy
{
  const legacy = proposal({ header: false, status: "delivered 2026-08-01" });
  const r = run("legacy.md", legacy);
  check("legacy file (no Rigor) exits 0", r.code === 0, r.out);
  check("legacy prints WARN legacy-proposal", /WARN legacy-proposal/.test(r.out), r.out);
  check("legacy skips readiness/review/prior-decisions (summary says rigor none)", /rigor none/.test(r.out), r.out);
  const noPrior = run("legacy-noprior.md", legacy.replace("Prior decisions consulted: none apply — searched docs/decisions/ for cache terms\n", "Nothing here.\n"));
  check("legacy skips prior-decisions-missing", noPrior.code === 0, noPrior.out);
  const lj = run("legacy-json.md", legacy, "--json");
  const j = JSON.parse(lj.out);
  check("legacy json: legacy true, rigor none, warning present", j.legacy === true && j.rigor === "none" && j.warnings.some((w) => w.rule === "legacy-proposal") && j.ok === true, lj.out);
  // [always] rules still run
  const bad = run("legacy-bad.md", legacy.replace("## Problem\n", "## Pro\n"));
  check("legacy still enforces section-missing", bad.code === 5 && /FAIL section-missing/.test(bad.out), bad.out);
  const bad2 = run("legacy-cite.md", legacy + "\nSee src/nope.js:4\n");
  check("legacy still enforces citation-unresolved", bad2.code === 5 && /citation-unresolved/.test(bad2.out), bad2.out);
  const bad3 = run("legacy-alt.md", legacy.replace("### B — do nothing\nLeave as is. Trade-offs: users keep waiting.\n", ""));
  check("legacy still enforces alternatives-too-few", bad3.code === 5 && /alternatives-too-few/.test(bad3.out), bad3.out);
  const bad4 = run("legacy-ph.md", legacy.replace("Keeps hot rows", "{How it works.} hot rows"));
  check("legacy still enforces placeholder-left", bad4.code === 5 && /placeholder-left/.test(bad4.out), bad4.out);
  const bad5 = run("legacy-empty.md", legacy.replace("Reversibility and effort.", ""));
  check("legacy still enforces section-empty", bad5.code === 5 && /section-empty/.test(bad5.out), bad5.out);
}

// 14. --json shape
{
  const r = run("json-ok.md", proposal({ rigor: "standard" }), "--json");
  let j; try { j = JSON.parse(r.out); } catch { j = null; }
  check("--json parses", j !== null, r.out);
  check("--json ok shape", j && j.ok === true && j.rigor === "standard" && j.status === "draft" && j.legacy === false
    && Array.isArray(j.failures) && Array.isArray(j.warnings) && j.counts.citations === 2 && j.counts.sections === 7 && typeof j.file === "string", r.out);
  const b = run("json-bad.md", proposal({ rigor: "fast" }), "--json");
  let jb; try { jb = JSON.parse(b.out); } catch { jb = null; }
  check("--json failure entries carry rule/line/text", b.code === 5 && jb && jb.ok === false && jb.failures[0].rule === "rigor-invalid"
    && typeof jb.failures[0].line === "number" && typeof jb.failures[0].text === "string", b.out);
}

// 15. usage
{
  let code = 0;
  try { execFileSync("node", [SCRIPT], { stdio: "pipe" }); } catch (e) { code = e.status; }
  check("no file argument exits 1", code === 1);
  code = 0;
  try { execFileSync("node", [SCRIPT, join(tmp, "does-not-exist.md")], { stdio: "pipe" }); } catch (e) { code = e.status; }
  check("unreadable file exits 1", code === 1);
}

// 16. excerpt cap and line numbers
{
  const r = run("excerpt.md", proposal().replace("Keeps hot rows in a map.", `{How it works.} ${"x".repeat(200)}`));
  const line = r.out.split("\n").find((l) => l.startsWith("FAIL placeholder-left")) ?? "";
  check("excerpt is capped at 100 chars", line.length > 0 && line.replace(/^FAIL placeholder-left L\d+: /, "").length <= 100, line);
}

// 17. braces: only the template's own placeholders count
{
  const prose = run("prose-braces.md", proposal().replace("Keeps hot rows in a map.", "Returns {ok: true, ttl: 1800} and logs {userId}."));
  check("prose braces that are not template placeholders pass", prose.code === 0, prose.out);
  // a repo without the template cannot know the placeholders: warn, do not guess
  const bare = join(tmp, "bare-repo");
  mkdirSync(join(bare, "src"), { recursive: true });
  writeFileSync(join(bare, "src/a.js"), Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  writeFileSync(join(bare, "src/b.js"), "one\ntwo\nthree\n");
  const f = join(tmp, "no-template.md");
  writeFileSync(f, proposal().replace("Keeps hot rows in a map.", "{How it works.}"));
  let out = "", code = 0;
  try { out = execFileSync("node", [SCRIPT, f, "--root", bare], { encoding: "utf8" }); } catch (e) { code = e.status; out = e.stdout ?? ""; }
  check("no template under --root: brace check skipped with a WARN", code === 0 && /WARN template-not-found/.test(out), out);
}

if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log("proposal-check: all checks passed");
