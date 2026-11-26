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
// THREE SHAPES, picked from the file itself:
//   v2     — opens with a `---` frontmatter block that carries a `rigor:` key (the
//            current PROPOSAL_TEMPLATE.md). Header keys read: status, rigor, created,
//            closed, status_note, supersedes, superseded_by, blocked_by.
//   v1     — no such block, but a `**Rigor**: …` line (proposals written before v1.18).
//            Header lines read: `**Status**: …`, `**Date**: …`, `**Rigor**: …`. Its rules
//            are unchanged, so an existing proposal passes or fails exactly as before.
//   legacy — neither (written before v1.11, or a finished plan filed as-is; a leading
//            `---` block WITHOUT `rigor:` is an imported document's own and is ignored).
//            Only the [always] rules run, a `WARN legacy-proposal` line is printed and
//            the summary reports `rigor none`.
// In v1 and v2, rigor must be exactly one of light | standard | critical (rigor-invalid).
//
// RECORDS: `## Review record` is looked up in `<proposal-without-.md>/record.md` first,
// then in the proposal itself — for every shape.
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
// v2 changes to the rules above:
//   section-missing        the required list is Summary, Problem, Goals / Non-Goals,
//                          Direction, Alternatives considered, Decision criteria,
//                          Production readiness, Decisions, Open questions, References
//   placeholder-left       also `created: YYYY-MM-DD`
//   alternatives-too-few   fewer than 1 `### ` subsection under ## Alternatives considered
//   stage-gate-missing     a `### Stage` block whose row is not the LAST row of the Status
//                          table lacks `Gate:` with `Options:` and `Evidence:` (no Status:
//                          line is expected — state lives in the table)
//   review-missing         status `parked` is exempt too, like draft and rejected
// v2-only rules:
//   frontmatter-invalid    the block is unclosed, holds a line that is not `key: value`,
//                          lacks `status` or `created`, or `created` / `closed` is not a date
//   status-invalid         status is not draft | active | delivered | stopped | rejected | parked
//   status-note-too-long   status_note is longer than 120 characters
//   ref-malformed          supersedes / superseded_by / blocked_by holds something that is
//                          not a 3-digit proposal number
//   header-duplicated      a `**Status**:` / `**Rigor**:` / `**Date**:` line survives in the body
//   decisions-malformed    ## Decisions has no `- D-n YYYY-MM-DD (tags): …` entry, an entry
//                          that does not match that shape, a repeated id, or a
//                          `supersedes: D-k` naming an id that is not in the register
//   stage-table-invalid    ## Stages without a ## Status table; a table row with fewer than
//                          4 cells, no stage number, or a State outside the grammar
//                          (pending | planned … | delivered YYYY-MM-DD | gate: … | stopped …);
//                          a `### Stage` block with no row; a `Status:` line inside a block
//   stage-block-missing    a stage that is planned / delivered / gated — or the pending stage
//                          that is next while status is draft or active — has a row but no
//                          `### Stage` block (a sketch must be elaborated before it is planned)
// v2-only warnings (never change the exit code):
//   size-core              the file is longer than 400 lines
//   size-summary           ## Summary is longer than 15 lines
//   size-decision          a Decisions entry is longer than 3 lines
//   amended-in-place       an `Amended YYYY-MM-DD` block under ## Stages (edit the stage to
//                          current truth and add a D-n entry instead)
//   record-duplicated      ## Review record exists both in record.md and in the proposal
//
// Human output: `FAIL <rule> L<n>: <excerpt>` (and `WARN …`) lines, then one
// `SUMMARY proposal-check: <ok|FAILED> — rigor <tier|none>, <n> failure(s), <m> citation(s) checked`.
// --json: {file, shape, status, rigor, ok, legacy, failures:[{rule,line,text}], warnings:[…],
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
// Frontmatter. A leading `---` block is the v2 header when it carries a `rigor:` key;
// without one it belongs to an imported document and is read as body, as it always was.
// The v2 header's lines are masked like a fence, so no body rule reads them.
const fm = { open: /^﻿?---\s*$/.test(lines[0] ?? ""), end: -1, keys: new Map(), bad: [] };
if (fm.open) {
  for (let i = 1; i < Math.min(lines.length, 60); i++) if (/^---\s*$/.test(lines[i])) { fm.end = i; break; }
  // An unclosed block: read keys up to the first blank line or heading, so a v2 file
  // with a lost closing fence is still recognised (and failed) rather than called legacy.
  let stop = fm.end;
  if (stop === -1) for (stop = 1; stop < Math.min(lines.length, 60) && lines[stop].trim() !== "" && !/^#/.test(lines[stop]); stop++);
  for (let i = 1; i < stop; i++) {
    if (lines[i].trim() === "") continue;
    const m = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(lines[i]);
    if (!m) { fm.bad.push(i); continue; }
    const value = (m[2] ?? "").replace(/\s+#.*$/, "").trim().replace(/^(["'])(.*)\1$/, "$2");
    fm.keys.set(m[1], { value, line: i });
  }
}
const v2 = fm.open && fm.keys.has("rigor");
if (v2) for (let i = 0; i <= fm.end; i++) fence[i] = true;
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
const warn = (rule, i, t) => warnings.push({ rule, line: i + 1, text: t.slice(0, 160) });

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
const fmVal = (key) => fm.keys.get(key) ?? null;
const statusH = v2 ? fmVal("status") : headerVal("Status");
const rigorH = v2 ? fmVal("rigor") : headerVal("Rigor");
const status = statusH ? statusH.value : "";
const legacy = rigorH === null;
const shape = v2 ? "v2" : legacy ? "legacy" : "v1";
const TIERS = ["light", "standard", "critical"];
const STATUSES = ["draft", "active", "delivered", "stopped", "rejected", "parked"];
const rigor = legacy ? "none" : rigorH.value;
const tierOk = !legacy && TIERS.includes(rigor);

if (legacy) {
  warnings.push({ rule: "legacy-proposal", line: 1, text: "no **Rigor** line — legacy/imported proposal; only the [always] rules ran" });
} else if (!tierOk) {
  fail("rigor-invalid", rigorH.line, `${v2 ? "rigor:" : "**Rigor**:"} ${rigor} — must be exactly one of light | standard | critical`);
}

if (v2) {
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  if (fm.end === -1) fail("frontmatter-invalid", 0, "the `---` header block is never closed");
  for (const i of fm.bad) fail("frontmatter-invalid", i, `${lines[i].trim()}  ← not a \`key: value\` line`);
  for (const key of ["status", "created"]) if (!fmVal(key)) fail("frontmatter-invalid", 0, `header has no \`${key}:\` key`);
  if (statusH && !STATUSES.includes(status)) fail("status-invalid", statusH.line, `status: ${status} — must be exactly one of ${STATUSES.join(" | ")}`);
  const created = fmVal("created");
  if (created) {
    if (created.value === "YYYY-MM-DD") fail("placeholder-left", created.line);
    else if (!DATE.test(created.value)) fail("frontmatter-invalid", created.line, `created: ${created.value} — must be YYYY-MM-DD`);
  }
  const closed = fmVal("closed");
  if (closed && closed.value !== "" && !DATE.test(closed.value)) fail("frontmatter-invalid", closed.line, `closed: ${closed.value} — must be YYYY-MM-DD or empty`);
  const note = fmVal("status_note");
  if (note && note.value.length > 120) fail("status-note-too-long", note.line, `status_note is ${note.value.length} characters — at most 120; the reasoning belongs in ## Decisions`);
  for (const key of ["supersedes", "superseded_by", "blocked_by"]) {
    const v = fmVal(key);
    if (!v) continue;
    const items = v.value.replace(/^\[(.*)\]$/, "$1").split(",").map((s) => s.trim()).filter(Boolean);
    const bad = items.filter((s) => !/^\d{3}$/.test(s));
    if (bad.length) fail("ref-malformed", v.line, `${key}: ${v.value} — each entry must be a 3-digit proposal number`);
  }
  for (const key of ["Status", "Rigor", "Date"]) {
    const h = headerVal(key);
    if (h) fail("header-duplicated", h.line, `**${key}**: line in the body — the header block is the only place state is written`);
  }
}

// --- section-missing / section-empty ---------------------------------------------
const REQUIRED = v2
  ? ["Summary", "Problem", "Goals / Non-Goals", "Direction", "Alternatives considered", "Decision criteria", "Decisions", "Open questions", "References"]
  : ["Problem", "Goals / Non-Goals", "Alternatives", "Decision criteria", "Open questions", "References"];
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
if (sec["Alternatives considered"]) {
  const s = sec["Alternatives considered"];
  if (subsections(s).length < 1) fail("alternatives-too-few", s.heading, "## Alternatives considered has no `###` subsection — need at least 1 approach that was not chosen");
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

  // stage-gate-missing (+ v2: stage-table-invalid, stage-block-missing)
  const stages = sectionOf("Stages");
  const stageSubs = stages ? subsections(stages).filter((x) => /^stage\b/i.test(x.title)) : [];
  const stageLines = (s) => {
    const idx = [];
    for (let i = s.start; i < s.end; i++) if (!isBlank(i)) idx.push(i);
    return (re, from = -1) => idx.find((i) => i > from && re.test(lines[i]));
  };
  const needGate = (s, find) => {
    const g = find(/^\s*(?:[-*]\s*)?Gate:/);
    if (g === undefined) fail("stage-gate-missing", s.heading, `### ${s.title} has no Gate: line (only the last stage may omit it)`);
    else {
      if (find(/^\s*(?:[-*]\s*)?Options:/, g) === undefined) fail("stage-gate-missing", g, `Gate of ${s.title} has no Options: line beneath it`);
      if (find(/^\s*(?:[-*]\s*)?Evidence:/, g) === undefined) fail("stage-gate-missing", g, `Gate of ${s.title} has no Evidence: line beneath it`);
    }
  };
  if (!v2) {
    stageSubs.forEach((s, k) => {
      const find = stageLines(s);
      if (find(/^\s*(?:[-*]\s*)?Status:/) === undefined) fail("stage-gate-missing", s.heading, `### ${s.title} has no Status: line`);
      if (k < stageSubs.length - 1) needGate(s, find);
    });
  } else {
    // The Status table is the single home of stage state; a row with no `### Stage`
    // block is a sketch. Stage ids are `1`, `2`, … (a letter suffix — `1b` — is allowed).
    const stageId = (t) => { const m = /(\d+[a-z]?)\b/i.exec(t); return m ? m[1].toLowerCase() : null; };
    const STATE = /^(pending|planned\b.*|delivered \d{4}-\d{2}-\d{2}.*|gate: \S.*|stopped\b.*)$/;
    const table = sectionOf("Status");
    const rows = [];
    if (table) {
      const tl = [];
      for (let i = table.start; i < table.end; i++) if (!fence[i] && /^\s*\|/.test(lines[i]) && !/^\s*\|[\s:|-]*\|?\s*$/.test(lines[i])) tl.push(i);
      for (const i of tl.slice(1)) { // tl[0] is the header row
        const cells = lines[i].trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim());
        const id = stageId(cells[0] ?? "");
        const state = (cells[cells.length - 1] ?? "").replace(/^[*_`]+|[*_`]+$/g, "");
        if (cells.length < 4 || id === null) fail("stage-table-invalid", i, `${lines[i].trim()}  ← a row is | Stage | Outcome | Gate question | State |`);
        else if (!STATE.test(state)) fail("stage-table-invalid", i, `State "${state}" — must be pending | planned (S-…) | delivered YYYY-MM-DD | gate: … | stopped — …`);
        else rows.push({ id, state, line: i });
      }
    }
    if (stages && rows.length === 0 && failures.every((f) => f.rule !== "stage-table-invalid")) {
      fail("stage-table-invalid", stages.heading, "## Stages exists but there is no ## Status table with a row per stage");
    }
    const blocks = new Map();
    for (const s of stageSubs) {
      const id = stageId(s.title.replace(/^stage\s*/i, ""));
      const find = stageLines(s);
      blocks.set(id, s);
      const stray = find(/^\s*(?:[-*]\s*)?(?:\*\*)?Status:/);
      if (stray !== undefined) fail("stage-table-invalid", stray, `### ${s.title} carries a Status: line — stage state lives in the ## Status table only`);
      if (rows.length === 0) continue;
      const k = rows.findIndex((r) => r.id === id);
      if (k === -1) fail("stage-table-invalid", s.heading, `### ${s.title} has no row in the ## Status table`);
      else if (k < rows.length - 1) needGate(s, find);
    }
    const live = status === "draft" || status === "active";
    rows.forEach((r, k) => {
      if (blocks.has(r.id)) return;
      const begun = !r.state.startsWith("pending");
      const next = live && (k === 0 || rows[k - 1].state.startsWith("gate:"));
      if (begun) fail("stage-block-missing", r.line, `stage ${r.id} is "${r.state}" but has no ### Stage ${r.id} block — a sketch cannot be planned`);
      else if (next) fail("stage-block-missing", r.line, `stage ${r.id} is next but has no ### Stage ${r.id} block — elaborate it (Delivers / Gate / Options / Evidence)`);
    });
    if (stages) for (let i = stages.start; i < stages.end; i++) {
      if (!fence[i] && /\bAmended\b[^\n]{0,24}\d{4}-\d{2}-\d{2}/i.test(lines[i])) warn("amended-in-place", i, "an \"Amended <date>\" block under ## Stages — edit the stage to current truth and add a D-n entry to ## Decisions");
    }
  }

  // decisions-malformed (v2)
  if (v2 && sec.Decisions) {
    const s = sec.Decisions;
    const ENTRY = /^[-*]\s+D-(\d+)\s+\d{4}-\d{2}-\d{2}\s+\([^)]+\):\s*\S/;
    const entries = [];
    for (let i = s.start; i < s.end; i++) {
      if (fence[i] || !/^[-*]\s+/.test(lines[i])) continue;
      const m = ENTRY.exec(lines[i]);
      if (!m) { fail("decisions-malformed", i, `${lines[i].trim()}  ← an entry is \`- D-n YYYY-MM-DD (mode, class, who): decision — changes: …\``); continue; }
      let end = i + 1;
      while (end < s.end && !isBlank(end) && !/^[-*]\s+/.test(lines[end]) && !headingAtLine.has(end)) end++;
      entries.push({ id: Number(m[1]), line: i, text: lines.slice(i, end).join(" "), span: end - i });
    }
    const ids = new Set();
    for (const e of entries) {
      if (ids.has(e.id)) fail("decisions-malformed", e.line, `D-${e.id} appears more than once`);
      ids.add(e.id);
      if (e.span > 3) warn("size-decision", e.line, `D-${e.id} is ${e.span} lines — at most 3; the detail belongs in the section it changed`);
    }
    for (const e of entries) {
      for (const m of e.text.matchAll(/supersedes:?\s+D-(\d+)/gi)) {
        const k = Number(m[1]);
        if (k === e.id || !ids.has(k)) fail("decisions-malformed", e.line, `D-${e.id} supersedes D-${k}, which is not another entry in this register`);
      }
    }
    if (entries.length === 0 && bodyLines(s).length > 0 && failures.every((f) => f.rule !== "decisions-malformed")) {
      fail("decisions-malformed", s.heading, "## Decisions has no `- D-n YYYY-MM-DD (…): …` entry — the direction is D-1");
    }
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
  // The record lives in `<proposal>/record.md` when that folder exists, else in the
  // proposal itself. `side` is that file's `## Review record`: its last non-blank line.
  const sidePath = `${file.replace(/\.md$/i, "")}/record.md`;
  const side = (() => {
    let raw;
    try { raw = readFileSync(sidePath, "utf8"); } catch { return null; }
    const ls = raw.replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, blank).split("\n");
    let open = false;
    let start = -1;
    let end = ls.length;
    for (let i = 0; i < ls.length; i++) {
      if (/^\s*(```|~~~)/.test(ls[i])) { open = !open; continue; }
      if (open) continue;
      const m = /^(#{1,2})\s+(.+?)\s*$/.exec(ls[i]);
      if (!m) continue;
      if (start === -1) { if (m[1].length === 2 && m[2].toLowerCase() === "review record") start = i; }
      else { end = i; break; }
    }
    if (start === -1) return null;
    let last = "";
    for (let i = end - 1; i > start; i--) if (ls[i].trim() !== "") { last = ls[i].trim(); break; }
    return { last };
  })();
  const sentinel = (t) => t === "REVIEW: PASS" || t.startsWith("REVIEW: OPEN — ");
  const st = status.toLowerCase();
  const rec = sectionOf("Review record");
  if (side && rec) warn("record-duplicated", rec.heading, "## Review record exists both here and in record.md — record.md is the one that counts");
  if (!st.startsWith("rejected") && !(v2 && st === "parked")) {
    const draft = st.startsWith("draft");
    const lastOk = (r) => {
      const li = lastNonBlank(r);
      if (li === -1) return { ok: false, line: r.heading };
      return { ok: sentinel(lines[li].trim()), line: li };
    };
    const at = statusH ? statusH.line : 0;
    if (side) {
      if (!sentinel(side.last)) fail(draft ? "review-malformed" : "review-missing", at, "## Review record in record.md must end with `REVIEW: PASS` or `REVIEW: OPEN — <n> finding(s) …`");
    } else if (!rec) {
      if (!draft) fail("review-missing", at, `Status "${status}" is past draft but there is no ## Review record section`);
    } else {
      const r = lastOk(rec);
      if (!r.ok) fail(draft ? "review-malformed" : "review-missing", r.line, "## Review record must end with `REVIEW: PASS` or `REVIEW: OPEN — <n> finding(s) …`");
    }
  }

  // size budgets (v2) — guardrails, never failures
  if (v2) {
    const total = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    if (total > 400) warn("size-core", 0, `${total} lines — aim for at most 400: move records to record.md and long detail to a linked file in the proposal's folder`);
    if (sec.Summary) {
      const n = bodyLines(sec.Summary).length;
      if (n > 15) warn("size-summary", sec.Summary.heading, `## Summary is ${n} lines — at most 15: problem, direction, appetite, success signal`);
    }
  }
}

// --- report ----------------------------------------------------------------------------------
const ok = failures.length === 0;
const summary = `SUMMARY proposal-check: ${ok ? "ok" : "FAILED"} — rigor ${rigor}, ${failures.length} failure(s), ${citationsChecked} citation(s) checked`;
if (json) {
  console.log(JSON.stringify({
    file, shape, status, rigor, ok, legacy, failures, warnings,
    counts: { citations: citationsChecked, sections: sectionsFound },
  }, null, 2));
} else {
  for (const w of warnings) console.log(`WARN ${w.rule} L${w.line}: ${w.text}`);
  for (const f of failures) console.log(`FAIL ${f.rule} L${f.line}: ${f.text}`);
  console.log(summary);
}
process.exit(ok ? 0 : 5);
