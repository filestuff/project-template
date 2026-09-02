#!/usr/bin/env node
// Close-time lint for a sprint file's completion record — the check that the
// sprint file (not the conversation, not the gitignored wave ledger) carries the
// evidence, outcome, review and learnings PROTOCOL Phase 3 demands. Zero-dep and
// self-contained on purpose: it ships in the lite tier, which has no frontmatter.mjs.
//
//   close-check.mjs <sprint-file> [--json]
//
// Exit 0 = record complete (or legacy file — see below) · 5 = record incomplete
// (failures listed) · 1 = usage / unreadable / no frontmatter.
//
// Human output: one `FAIL <rule> L<n>: <excerpt>` per failure, then a SUMMARY line.
// --json: {sprint, status, ok, legacy, failures:[{rule,line,text}], counts,
//          review:[], deviations:[], deferred:[], learnings:[]} — the wave master
// consumes this instead of reading the sprint body.
//
// Rules (criteria are scanned ONLY between `### Deliverables` and the next `### `
// heading, so Testing / Open Questions checkboxes are untouched):
//   criterion-unevidenced  checked Automated criterion not followed by `- Evidence:`
//   criterion-unchecked    unchecked Automated criterion without `descoped:`
//   manual-unconfirmed     Manual criterion not `[x] … confirmed` and not descoped
//   record-missing         no `## Completion Log` heading at all
//   section-missing        a required `### ` subsection is absent
//   outcome-empty          `### Outcome` has no prose
//   placeholder-left       a `_(…)_` template placeholder survives (Commits' `_(stamped at land)_` is allowed)
//   section-empty          Review / Deviations / Deferred / Learnings has no content (`— none` counts)
//   checklist-unannotated  a Close checklist row is unchecked, lacks ` — <annotation>`,
//                          or its annotation is vacuous (`done`, `ok`, `<placeholder>`, `n/a` without `: reason`)
// Legacy: a `## Completion Log` with no `### ` subsections (pre-1.10.0 file) → one
// `legacy-log` WARNING, exit 0 — old files are history, not lint failures.

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const json = args.includes("--json");
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("usage: close-check.mjs <sprint-file> [--json]");
  process.exit(1);
}
let text;
try {
  text = readFileSync(file, "utf8");
} catch (e) {
  console.error(`cannot read ${file}: ${e.message}`);
  process.exit(1);
}
const lines = text.split("\n");
if (lines[0] !== "---") {
  console.error(`${file}: no frontmatter (file does not start with ---)`);
  process.exit(1);
}
let fmEnd = lines.indexOf("---", 1);
if (fmEnd === -1) {
  console.error(`${file}: unterminated frontmatter`);
  process.exit(1);
}
const fm = (key) => {
  const re = new RegExp(`^${key}:\\s*(.*)$`);
  for (let i = 1; i < fmEnd; i++) {
    const m = lines[i].match(re);
    if (m) return m[1].trim();
  }
  return null;
};
const sprint = fm("sprint") ?? "S-???";
const status = fm("status");

// --- helpers ----------------------------------------------------------------
const L = (i) => i + 1; // 1-based line numbers for humans
const failures = [];
const warnings = [];
const fail = (rule, i, t) => failures.push({ rule, line: L(i), text: (t ?? lines[i]).trim().slice(0, 120) });

// Lines inside HTML comments are neither content nor criteria.
const inComment = new Array(lines.length).fill(false);
{
  let open = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!open && l.includes("<!--")) {
      open = !l.includes("-->", l.indexOf("<!--"));
      inComment[i] = true;
      continue;
    }
    if (open) {
      inComment[i] = true;
      if (l.includes("-->")) open = false;
    }
  }
}
const isBlank = (i) => lines[i].trim() === "";
const isPlaceholder = (s) => /^_\(.*\)_?\s*$/.test(s.trim()) || /^_\(/.test(s.trim());
const nextContent = (i) => {
  for (let j = i + 1; j < lines.length; j++) if (!isBlank(j) && !inComment[j]) return j;
  return -1;
};
const headingAt = (i, level) => new RegExp(`^${"#".repeat(level)} (.+)$`).exec(lines[i]);
const findHeading = (level, title, from = 0) => {
  for (let i = from; i < lines.length; i++) {
    const m = headingAt(i, level);
    if (m && m[1].trim() === title) return i;
  }
  return -1;
};
// Lines belonging to a section: after its heading, until the next heading of the same or higher level.
const sectionRange = (start, level) => {
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    for (let lv = 1; lv <= level; lv++) if (headingAt(i, lv)) { end = i; lv = level + 1; }
    if (end === i) break;
  }
  return [start + 1, end];
};
const contentLines = ([a, b]) => {
  const out = [];
  for (let i = a; i < b; i++) if (!isBlank(i) && !inComment[i]) out.push(i);
  return out;
};

// --- legacy detection (before anything else: it decides how criterion findings are graded)
const logStart = findHeading(2, "Completion Log");
let legacy = false;
if (logStart !== -1) {
  const [la, lb] = sectionRange(logStart, 2);
  legacy = true;
  for (let i = la; i < lb; i++) if (headingAt(i, 3)) legacy = false;
}
// On a pre-1.10.0 file the criteria never had an Evidence grammar to follow — report, don't fail.
const criterionFinding = (rule, i) =>
  legacy ? warnings.push(`${rule} L${L(i)}: ${lines[i].trim().slice(0, 120)} (legacy file — not enforced)`) : fail(rule, i);

// --- acceptance criteria ------------------------------------------------------
const counts = { automated: 0, automated_evidenced: 0, descoped: 0, manual: 0, manual_confirmed: 0, checklist: 0, checklist_annotated: 0 };
const delivStart = findHeading(3, "Deliverables");
if (delivStart !== -1) {
  const [a, b] = sectionRange(delivStart, 3);
  let mode = null; // null = unclassified (treated as Automated), "automated", "manual"
  for (let i = a; i < b; i++) {
    if (inComment[i]) continue;
    const l = lines[i];
    if (/^\d+\.\s+\*\*/.test(l)) { mode = null; continue; } // new deliverable resets the mode
    if (/^\s*-\s*Automated\b/i.test(l)) { mode = "automated"; continue; }
    if (/^\s*-\s*Manual\b/i.test(l)) { mode = "manual"; continue; }
    const m = /^\s*- \[( |x|X)\] (.*)$/.exec(l);
    if (!m) continue;
    const checked = m[1] !== " ";
    const body = m[2];
    const descoped = /\bdescoped:/.test(body);
    if (mode === "manual") {
      counts.manual++;
      if (checked && /\bconfirmed\b/.test(body)) counts.manual_confirmed++;
      else if (!checked && descoped) counts.descoped++;
      else criterionFinding("manual-unconfirmed", i);
    } else {
      counts.automated++;
      if (checked) {
        const j = nextContent(i);
        if (j !== -1 && /^\s*-?\s*Evidence:/.test(lines[j])) counts.automated_evidenced++;
        else criterionFinding("criterion-unevidenced", i);
      } else if (descoped) counts.descoped++;
      else criterionFinding("criterion-unchecked", i);
    }
  }
}

// --- completion log -----------------------------------------------------------
const REQUIRED = ["Outcome", "Commits", "Review", "Deviations from brief", "Deferred", "Learnings", "Close checklist"];
const sections = {};
if (logStart === -1) {
  fail("record-missing", lines.length - 1, "no `## Completion Log` heading — paste the section from docs/sprints/SPRINT_TEMPLATE.md");
} else {
  const [a, b] = sectionRange(logStart, 2);
  if (legacy) {
    warnings.push(`legacy-log L${L(logStart)}: Completion Log has no subsections (pre-1.10.0 file) — not linted; append the sections from SPRINT_TEMPLATE.md to record this sprint`);
  } else {
    for (const title of REQUIRED) {
      const h = findHeading(3, title, a);
      if (h === -1 || h >= b) { fail("section-missing", logStart, `### ${title}`); continue; }
      const range = sectionRange(h, 3);
      sections[title] = { heading: h, content: contentLines(range) };
    }
    const contentOf = (t) => (sections[t]?.content ?? []).map((i) => lines[i].trim());
    // Outcome
    if (sections.Outcome) {
      const c = contentOf("Outcome");
      if (c.length === 0) fail("outcome-empty", sections.Outcome.heading, "### Outcome has no prose");
    }
    // placeholders anywhere in the log except Commits' stamp marker
    for (const [title, sec] of Object.entries(sections)) {
      for (const i of sec.content) {
        if (title === "Commits" && lines[i].trim() === "_(stamped at land)_") continue;
        if (isPlaceholder(lines[i])) fail(title === "Outcome" ? "outcome-empty" : "placeholder-left", i);
      }
    }
    // free-text sections must have something (`— none` counts)
    for (const title of ["Review", "Deviations from brief", "Deferred", "Learnings"]) {
      if (sections[title] && contentOf(title).length === 0) fail("section-empty", sections[title].heading, `### ${title} is empty — write the content or \`— none\``);
    }
    // checklist rows
    if (sections["Close checklist"]) {
      for (const i of sections["Close checklist"].content) {
        const m = /^- \[( |x|X)\] (.*)$/.exec(lines[i]);
        if (!m) continue;
        counts.checklist++;
        const parts = m[2].split(/\s+—\s+/);
        const ann = parts.length > 1 ? parts.slice(1).join(" — ").trim() : "";
        const vacuous = /^(done|yes|ok|✓|✔|complete|completed|n\/a|descoped|none)\.?$/i.test(ann);
        const bareNa = /^(n\/a|descoped)\b/i.test(ann) && !/^(n\/a|descoped):\s+\S/i.test(ann);
        if (m[1] === " ") fail("checklist-unannotated", i, `${lines[i].trim()}  ← unchecked`);
        else if (!ann) fail("checklist-unannotated", i, `${lines[i].trim()}  ← no \` — <annotation>\``);
        else if (ann.startsWith("<") || vacuous || bareNa) fail("checklist-unannotated", i, `${lines[i].trim()}  ← vacuous annotation`);
        else counts.checklist_annotated++;
      }
    }
  }
}

// --- report -------------------------------------------------------------------
const pick = (t) => (sections[t]?.content ?? []).map((i) => lines[i].trim()).filter((s) => !/^— none\b/.test(s));
const summary =
  `SUMMARY ${sprint} automated=${counts.automated_evidenced}/${counts.automated} descoped=${counts.descoped} ` +
  `manual=${counts.manual_confirmed}/${counts.manual} checklist=${counts.checklist_annotated}/${counts.checklist} ` +
  `sections=${legacy ? "legacy" : REQUIRED.every((t) => sections[t]) ? "ok" : "missing:" + REQUIRED.filter((t) => !sections[t]).join(",")}`;
const ok = failures.length === 0;

if (json) {
  console.log(JSON.stringify({
    sprint, status, ok, legacy, failures, warnings, counts, summary,
    review: pick("Review"), deviations: pick("Deviations from brief"), deferred: pick("Deferred"), learnings: pick("Learnings"),
  }, null, 2));
} else {
  for (const w of warnings) console.log(`WARNING ${w}`);
  for (const f of failures) console.log(`FAIL ${f.rule} L${f.line}: ${f.text}`);
  console.log(summary);
  if (!ok) console.log(`close-check: ${failures.length} failure(s) — fix the sprint file's Completion Log, then re-run`);
}
process.exit(ok ? 0 : 5);
