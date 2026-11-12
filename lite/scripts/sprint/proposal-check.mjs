#!/usr/bin/env node
// Lint for a proposal (docs/proposals/NNN-*.md) — the check that a proposal is
// decision-ready and production-aware before /plan consumes it. Zero-dep and
// self-contained on purpose: it ships in the lite tier, which has no frontmatter.mjs.
//
//   proposal-check.mjs <proposal-file> [--root <repo-root>] [--json]
//
// Exit 0 = ok · 5 = lint failures · 1 = usage / unreadable.
// --root (default: cwd) is where `path/to/file.ext:LINE` citations are resolved.
//
// Header lines read: `**Status**: …`, `**Date**: …`, `**Rigor**: …`.
// LEGACY: a file with NO `**Rigor**:` line predates this lint (or is a finished plan
// filed as-is). Only the [always] rules run, a `WARN legacy-proposal` line is printed
// and the summary reports `rigor none`. Otherwise Rigor must be exactly one of
// light | standard | critical (rule rigor-invalid).
//
// HTML comments (possibly multi-line) and fenced code blocks are ignored by every
// rule — comments are blanked before anything is read, so line numbers stay true.
//
// Rules ([always] = also run on legacy files):
//   section-missing        [always] a required `## ` heading is absent: Problem,
//                          Goals / Non-Goals, Alternatives, Decision criteria,
//                          Open questions, References (+ Production readiness when Rigor is set)
//   section-empty          [always] a required section has no non-blank, non-heading content
//   placeholder-left       [always] a surviving template placeholder: `{…}` outside code
//                          spans/fences, `Title In Plain Words`, `YYYY-MM-DD` on the Date
//                          line, `Proposal NNN:` in the H1
//   alternatives-too-few   [always] fewer than 2 `### ` subsections under ## Alternatives
//   citation-unresolved    [always] a `path/file.ext:LINE[-LINE]` citation whose file is
//                          missing under --root or has fewer lines (times, URLs, `S-001:`
//                          and citations whose path holds `{`/`<` are not citations)
//   rigor-invalid          Rigor is not light | standard | critical
//   readiness-missing      a `### ` subsection required by the tier is absent from
//                          ## Production readiness (light: Risks and rollback;
//                          standard: + Architecture and data flow, Interfaces and contracts,
//                          Test strategy, Observability; critical: + Data model and migration,
//                          Security and threat model, Failure modes, Non-functional targets,
//                          Rollout and rollback plan, Cost and capacity)
//   readiness-empty        a required readiness subsection is empty, a table with only
//                          header + separator rows, or a bare `n/a` / `none` (a reason of
//                          at least 3 words after `n/a —` / `n/a -` / `n/a:` passes)
//   open-question-vague    an unchecked `- [ ]` under ## Open questions lacks `options:`
//                          or `if deferred:`
//   stage-gate-missing     in ## Stages, a non-last `### Stage` lacks `Gate:` with
//                          `Options:` and `Evidence:` beneath, or any stage lacks `Status:`
//   prior-decisions-missing  ## References has no `Prior decisions consulted:` line with content
//   review-missing         Status is not draft/rejected and ## Review record is absent or
//                          its last non-blank line is not `REVIEW: PASS` / `REVIEW: OPEN — …`
//   review-malformed       Status is draft, the section exists, and its last line is malformed
//
// Human output: `FAIL <rule> L<n>: <excerpt>` (and `WARN …`) lines, then one
// `SUMMARY proposal-check: <ok|FAILED> — rigor <tier|none>, <n> failure(s), <m> citation(s) checked`.
// --json: {file, status, rigor, ok, legacy, failures:[{rule,line,text}], warnings:[…],
//          counts:{citations, sections}}.

import { readFileSync, statSync } from "node:fs";
import { resolve, isAbsolute, join } from "node:path";

const USAGE = "usage: proposal-check.mjs <proposal-file> [--root <repo-root>] [--json]";
const argv = process.argv.slice(2);
let json = false;
let root = process.cwd();
let fileArg = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--json") json = true;
  else if (a === "--root") {
    if (i + 1 >= argv.length) { console.error(USAGE); process.exit(1); }
    root = argv[++i];
  } else if (a.startsWith("--root=")) root = a.slice(7);
  else if (a.startsWith("--")) { console.error(USAGE); process.exit(1); }
  else if (fileArg === null) fileArg = a;
  else { console.error(USAGE); process.exit(1); }
}
if (!fileArg) { console.error(USAGE); process.exit(1); }
root = resolve(process.cwd(), root);
let file = resolve(process.cwd(), fileArg);
let text;
try {
  try { text = readFileSync(file, "utf8"); } catch (e) {
    if (isAbsolute(fileArg)) throw e;
    file = resolve(root, fileArg);
    text = readFileSync(file, "utf8");
  }
} catch (e) {
  console.error(`cannot read ${fileArg}: ${e.message}`);
  process.exit(1);
}

// --- preprocessing -------------------------------------------------------------
// Blank HTML comments (keeping newlines) so line numbers survive.
const blank = (s) => s.replace(/[^\n]/g, " ");
let stripped = text.replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, blank);
{
  const k = stripped.indexOf("<!--"); // unterminated comment swallows the rest
  if (k !== -1) stripped = stripped.slice(0, k) + blank(stripped.slice(k));
}
const lines = stripped.split("\n");
const fence = new Array(lines.length).fill(false);
{
  let open = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { fence[i] = true; open = !open; continue; }
    fence[i] = open;
  }
}
const maskCode = (l) => l.replace(/`+[^`]*`+/g, (m) => " ".repeat(m.length));
const isBlank = (i) => lines[i].trim() === "";

const headings = [];
for (let i = 0; i < lines.length; i++) {
  if (fence[i]) continue;
  const m = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i]);
  if (m) headings.push({ i, level: m[1].length, title: m[2].trim() });
}
const headingAtLine = new Set(headings.map((h) => h.i));
// A section: from its heading to the next heading of the same or a higher level.
const sectionOf = (title, level = 2, from = 0, to = lines.length) => {
  const h = headings.find((x) => x.level === level && x.i >= from && x.i < to && x.title.toLowerCase() === title.toLowerCase());
  if (!h) return null;
  const next = headings.find((x) => x.i > h.i && x.level <= level);
  return { heading: h.i, start: h.i + 1, end: next ? next.i : lines.length };
};
const subsections = (sec, level = 3) =>
  headings.filter((x) => x.level === level && x.i >= sec.start && x.i < sec.end).map((x) => {
    const next = headings.find((y) => y.i > x.i && y.level <= level);
    return { title: x.title, heading: x.i, start: x.i + 1, end: Math.min(next ? next.i : lines.length, sec.end) };
  });
const bodyLines = (r) => {
  const out = [];
  for (let i = r.start; i < r.end; i++) if (!isBlank(i) && !headingAtLine.has(i)) out.push(i);
  return out;
};
const lastNonBlank = (r) => {
  for (let i = r.end - 1; i >= r.start; i--) if (!isBlank(i)) return i;
  return -1;
};

const failures = [];
const warnings = [];
const fail = (rule, i, t) => failures.push({ rule, line: i + 1, text: (t ?? lines[i]).trim().slice(0, 100) });

// --- header ----------------------------------------------------------------------
const headerVal = (key) => {
  const re = new RegExp(`^\\*\\*${key}\\*\\*:\\s*(.*)$`);
  for (let i = 0; i < lines.length; i++) {
    if (fence[i]) continue;
    const m = re.exec(lines[i]);
    if (m) return { value: m[1].trim(), line: i };
  }
  return null;
};
const statusH = headerVal("Status");
const rigorH = headerVal("Rigor");
const status = statusH ? statusH.value : "";
const legacy = rigorH === null;
const TIERS = ["light", "standard", "critical"];
const rigor = legacy ? "none" : rigorH.value;
const tierOk = !legacy && TIERS.includes(rigor);

if (legacy) {
  warnings.push({ rule: "legacy-proposal", line: 1, text: "no **Rigor** line — legacy/imported proposal; only the [always] rules ran" });
} else if (!tierOk) {
  fail("rigor-invalid", rigorH.line, `**Rigor**: ${rigor} — must be exactly one of light | standard | critical`);
}

// --- section-missing / section-empty ---------------------------------------------
const REQUIRED = ["Problem", "Goals / Non-Goals", "Alternatives", "Decision criteria", "Open questions", "References"];
if (!legacy) REQUIRED.push("Production readiness");
const sec = {};
let sectionsFound = 0;
for (const title of REQUIRED) {
  const s = sectionOf(title);
  if (!s) { fail("section-missing", 0, `## ${title}`); continue; }
  sec[title] = s;
  sectionsFound++;
  if (bodyLines(s).length === 0) fail("section-empty", s.heading, `## ${title} has no content`);
}

// --- placeholder-left --------------------------------------------------------------
// `{…}` placeholders: only the ones the shipped template actually contains count. A
// generic "any braces outside code" rule fails honest prose (`returns {ok: true}`), and a
// lint that cries wolf gets bypassed. The template is read from the repo being linted.
function templatePlaceholders(rootDir, rel) {
  let text;
  try {
    text = readFileSync(join(rootDir, rel), "utf8");
  } catch {
    return null; // no template in this repo — brace placeholders cannot be checked
  }
  const bare = text.replace(/<!--[\s\S]*?-->/g, "");
  return new Set([...bare.matchAll(/\{[^{}\n]*\}/g)].map((m) => m[0]));
}
const hasTemplateBrace = (set, masked) => {
  if (!set) return false;
  for (const m of masked.matchAll(/\{[^{}]*\}/g)) if (set.has(m[0])) return true;
  return false;
};
const TEMPLATE_BRACES = templatePlaceholders(root, "docs/proposals/PROPOSAL_TEMPLATE.md");
if (!TEMPLATE_BRACES) warnings.push({ rule: "template-not-found", line: 0, text: "docs/proposals/PROPOSAL_TEMPLATE.md not found under --root — `{…}` placeholders not checked" });
for (let i = 0; i < lines.length; i++) {
  if (fence[i]) continue;
  const raw = lines[i];
  const masked = maskCode(raw);
  let why = null;
  if (hasTemplateBrace(TEMPLATE_BRACES, masked)) why = raw;
  else if (/^\s*Prior decisions consulted:\s*\{/.test(raw)) why = raw;
  else if (/Title In Plain Words/.test(raw)) why = raw;
  else if (/^\*\*Date\*\*:.*YYYY-MM-DD/.test(raw)) why = raw;
  else if (/^#\s.*Proposal NNN:/.test(raw)) why = raw;
  if (why !== null) fail("placeholder-left", i, why);
}

// --- alternatives-too-few ------------------------------------------------------------
if (sec.Alternatives) {
  const n = subsections(sec.Alternatives).length;
  if (n < 2) fail("alternatives-too-few", sec.Alternatives.heading, `## Alternatives has ${n} \`###\` subsection(s) — need at least 2`);
}

// --- citation-unresolved ---------------------------------------------------------------
const CITE = /(?<![\w./@~-])((?:[\w.@~-]+\/)*[\w.@~-]+\.([A-Za-z0-9]{1,8})):L?(\d+)(?:-L?(\d+))?(?![\w:])/g;
const TLDS = new Set(["com", "org", "net", "io", "dev", "local", "app", "ai", "co", "edu", "gov"]);
const lineCountCache = new Map();
const countLines = (abs) => {
  if (lineCountCache.has(abs)) return lineCountCache.get(abs);
  let n = null;
  try {
    if (statSync(abs).isFile()) {
      const t = readFileSync(abs, "utf8");
      n = t.length === 0 ? 0 : t.split("\n").length - (t.endsWith("\n") ? 1 : 0);
    }
  } catch { n = null; }
  lineCountCache.set(abs, n);
  return n;
};
let citationsChecked = 0;
for (let i = 0; i < lines.length; i++) {
  if (fence[i]) continue;
  const l = lines[i];
  CITE.lastIndex = 0;
  for (let m = CITE.exec(l); m; m = CITE.exec(l)) {
    const [raw, p, ext, a, b] = m;
    const before = l[m.index - 1] ?? "";
    if (/[{}<>]/.test(before) || /[{}<>]/.test(p)) continue; // placeholder path
    if (/^https?/i.test(p)) continue;
    if (!/[A-Za-z]/.test(ext)) continue; // 10.0.0.1:8080, v1.2:30
    if (!p.includes("/") && TLDS.has(ext.toLowerCase())) continue; // example.com:8080
    citationsChecked++;
    const abs = resolve(root, p);
    const n = countLines(abs);
    const start = Number(a);
    const end = b === undefined ? start : Number(b);
    if (n === null) fail("citation-unresolved", i, `${raw} — file not found under ${root}`);
    else if (start < 1 || end < start || end > n) fail("citation-unresolved", i, `${raw} — file has only ${n} line(s)`);
  }
}

// --- alwaysRules done; the rest only for non-legacy files -------------------------------------
if (!legacy) {
  // readiness-missing / readiness-empty
  const TIER_SECTIONS = {
    light: ["Risks and rollback"],
  };
  TIER_SECTIONS.standard = [...TIER_SECTIONS.light, "Architecture and data flow", "Interfaces and contracts", "Test strategy", "Observability"];
  TIER_SECTIONS.critical = [...TIER_SECTIONS.standard, "Data model and migration", "Security and threat model", "Failure modes", "Non-functional targets", "Rollout and rollback plan", "Cost and capacity"];
  const classify = (idxs) => {
    const ls = idxs.map((i) => lines[i].trim());
    if (ls.length === 0) return "empty";
    if (ls.every((l) => l.startsWith("|"))) {
      const rows = ls.filter((l) => !/^\|[\s:|-]*\|?$/.test(l));
      if (rows.length <= 1) return "empty";
    }
    const joined = ls.join(" ").trim();
    const m = /^(n\/a|none)\b\.?(.*)$/i.exec(joined);
    if (m) {
      const reason = m[2].replace(/^[\s—–:.-]+/, "").trim();
      const words = reason.split(/\s+/).filter(Boolean).length;
      return words >= 3 ? "ok" : "empty";
    }
    return "ok";
  };
  if (tierOk && sec["Production readiness"]) {
    const subs = subsections(sec["Production readiness"]);
    for (const title of TIER_SECTIONS[rigor]) {
      const s = subs.find((x) => x.title.toLowerCase() === title.toLowerCase());
      if (!s) { fail("readiness-missing", sec["Production readiness"].heading, `### ${title} (required at rigor ${rigor})`); continue; }
      if (classify(bodyLines(s)) === "empty") fail("readiness-empty", s.heading, `### ${title} is empty, a bare n/a, or a table with no rows — write content or \`n/a — <reason>\``);
    }
  }

  // open-question-vague
  if (sec["Open questions"]) {
    const s = sec["Open questions"];
    for (let i = s.start; i < s.end; i++) {
      if (!/^\s*[-*]\s+\[ \]/.test(lines[i])) continue;
      let t = lines[i];
      for (let j = i + 1; j < s.end && !isBlank(j) && !/^\s*[-*]\s+\[/.test(lines[j]) && !headingAtLine.has(j); j++) t += ` ${lines[j]}`;
      const lc = t.toLowerCase();
      const missing = ["options:", "if deferred:"].filter((k) => !lc.includes(k));
      if (missing.length) fail("open-question-vague", i, `${lines[i].trim()}  ← missing ${missing.join(", ")}`);
    }
  }

  // stage-gate-missing
  const stages = sectionOf("Stages");
  if (stages) {
    const stageSubs = subsections(stages).filter((x) => /^stage\b/i.test(x.title));
    stageSubs.forEach((s, k) => {
      const idx = [];
      for (let i = s.start; i < s.end; i++) if (!isBlank(i)) idx.push(i);
      const find = (re, from = -1) => idx.find((i) => i > from && re.test(lines[i]));
      if (find(/^\s*(?:[-*]\s*)?Status:/) === undefined) fail("stage-gate-missing", s.heading, `### ${s.title} has no Status: line`);
      if (k < stageSubs.length - 1) {
        const g = find(/^\s*(?:[-*]\s*)?Gate:/);
        if (g === undefined) fail("stage-gate-missing", s.heading, `### ${s.title} has no Gate: line (only the last stage may omit it)`);
        else {
          if (find(/^\s*(?:[-*]\s*)?Options:/, g) === undefined) fail("stage-gate-missing", g, `Gate of ${s.title} has no Options: line beneath it`);
          if (find(/^\s*(?:[-*]\s*)?Evidence:/, g) === undefined) fail("stage-gate-missing", g, `Gate of ${s.title} has no Evidence: line beneath it`);
        }
      }
    });
  }

  // prior-decisions-missing
  if (sec.References) {
    const s = sec.References;
    let ok = false;
    let at = s.heading;
    for (let i = s.start; i < s.end; i++) {
      const m = /^\s*(?:[-*]\s*)?Prior decisions consulted:\s*(.*)$/i.exec(lines[i]);
      if (!m) continue;
      at = i;
      let t = m[1];
      for (let j = i + 1; j < s.end && !isBlank(j) && !headingAtLine.has(j); j++) t += ` ${lines[j]}`;
      t = t.trim();
      ok = t !== "" && !t.startsWith("{") && !/^\[.*\]$/.test(t);
      break;
    }
    if (!ok) fail("prior-decisions-missing", at, "## References needs `Prior decisions consulted: <ADR-NNN — how it constrains this | none apply — searched … for …>`");
  }

  // review-missing / review-malformed
  const st = status.toLowerCase();
  if (!st.startsWith("rejected")) {
    const draft = st.startsWith("draft");
    const rec = sectionOf("Review record");
    const lastOk = (r) => {
      const li = lastNonBlank(r);
      if (li === -1) return { ok: false, line: r.heading };
      const t = lines[li].trim();
      return { ok: t === "REVIEW: PASS" || t.startsWith("REVIEW: OPEN — "), line: li };
    };
    if (!rec) {
      if (!draft) fail("review-missing", statusH ? statusH.line : 0, `Status "${status}" is past draft but there is no ## Review record section`);
    } else {
      const r = lastOk(rec);
      if (!r.ok) fail(draft ? "review-malformed" : "review-missing", r.line, "## Review record must end with `REVIEW: PASS` or `REVIEW: OPEN — <n> finding(s) …`");
    }
  }
}

// --- report ----------------------------------------------------------------------------------
const ok = failures.length === 0;
const summary = `SUMMARY proposal-check: ${ok ? "ok" : "FAILED"} — rigor ${rigor}, ${failures.length} failure(s), ${citationsChecked} citation(s) checked`;
if (json) {
  console.log(JSON.stringify({
    file, status, rigor, ok, legacy, failures, warnings,
    counts: { citations: citationsChecked, sections: sectionsFound },
  }, null, 2));
} else {
  for (const w of warnings) console.log(`WARN ${w.rule} L${w.line}: ${w.text}`);
  for (const f of failures) console.log(`FAIL ${f.rule} L${f.line}: ${f.text}`);
  console.log(summary);
}
process.exit(ok ? 0 : 5);
