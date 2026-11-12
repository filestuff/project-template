#!/usr/bin/env node
// Pre-execution lint for sprint BRIEFS (close-check.mjs lints the completion record
// AFTER a sprint; this lints the brief BEFORE it runs) and, with --record, for the
// plan record /plan appends to a proposal. Zero-dep and self-contained on purpose: it
// ships in the lite tier, which has no frontmatter.mjs.
//
//   plan-check.mjs [--root <repo-root>] [--record <file>] [--json] [S-NNN …]
//
// With no ids: every sprint file in <root>/docs/sprints/backlog/. With ids: those
// sprints, found in backlog/ or in-progress/. Dependency lookups consult backlog/,
// in-progress/, done/, done/archive/ and rejected/ (files named S-NNN-*.md).
// --root defaults to cwd; --record is resolved against --root (then cwd).
//
// Exit 0 = ok · 5 = failures · 1 = usage / unreadable / unknown id.
//
// HTML comments are blanked before any rule runs (line numbers are preserved).
// Per-sprint rules:
//   frontmatter-invalid     sprint is S-NNN and matches the filename prefix; story_points is
//                           one of 1,2,3,5,8,13 (0/missing fails); risk (if present) low|high;
//                           tier (if present) routine|standard|complex|critical; depends_on/blocks are flow
//                           arrays of S-NNN ids (a key that is absent counts as empty)
//   dependency-unknown      a depends_on id has no sprint file anywhere
//   dependency-rejected     a depends_on id lives in rejected/
//   dependency-cycle        a depends_on cycle (reported once per cycle, ids listed)
//   placeholder-left        template text survives: `S-NNN: [Sprint Name]`, `[Feature/Task Name]`,
//                           `path/to/…` (even in backticks), `{…}` outside code spans/fences,
//                           the template goal sentence, `Description` / `How to handle` Risks cells
//   deliverables-missing    no numbered `1. **…**` deliverable under ### Deliverables
//   criteria-missing        a deliverable has no `- [ ]` criterion before the next deliverable/heading
//   contract-unproduced     a ### Consumes bullet `… from S-NNN — …` names a sprint not in
//                           depends_on, or its first backticked identifier is absent from that
//                           sprint's ### Produces (b is skipped when it lives in done/ or done/archive/)
//   production-notes-missing  risk: high without ## Production notes carrying Rollback:,
//                           Observability:, Security: bullets with real (non-bare-n/a) content
//   open-question-vague     an unchecked `- [ ]` under ## Open Questions lacks `options:`
//   citation-unresolved     a `path/file.ext:LINE[-LINE]` citation (an `L` before the number is
//                           accepted) whose file is missing under --root or too short
//   tier-unjustified        `tier: routine` — the cheapest execution setting — without what
//                           docs/sprints/tier-rubric.md demands for it: a `tier_reason:`,
//                           risk low, at most 3 story points, no open question. (The rubric
//                           is asymmetric: lowering needs every criterion; the ones a lint
//                           can see are checked here, the brief-auditor checks the rest.)
//   tier-unreasoned         WARN only: `tier: complex|critical` with no `tier_reason:`
//   touches-empty           WARN only, and only when <root>/scripts/sprint/claims.mjs exists
//                           (full tier): `touches:` has no entries
// Plan record (--record <file>), a proposal or plan doc:
//   record-missing          no `## Plan record` section
//   record-coverage-missing the latest entry has no table/list line referencing an S-NNN
//   record-sentinel-missing the section's last line is not `NO UNRESOLVED DECISIONS` (and no
//                           UNRESOLVED DECISIONS: bullet list)
//   record-unresolved       the section carries an `UNRESOLVED DECISIONS:` list with bullets
//   coverage-ghost          (backlog mode only) a linted sprint whose `proposal:` equals the
//                           record file's number is not mentioned in the latest entry
//
// Human output: `FAIL <rule> <S-NNN> L<n>: <excerpt>` / `WARN …` lines, then
// `SUMMARY plan-check: <ok|FAILED> — <k> sprint(s), <n> failure(s), <w> warning(s)`.
// --json: {ok, sprints:[{sprint, file, risk, tier, failures, warnings}], record, failures}.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, join, basename, relative, isAbsolute } from "node:path";

const USAGE = "usage: plan-check.mjs [--root <repo-root>] [--record <file>] [--json] [S-NNN …]";
const die = (msg, code = 1) => { console.error(msg); process.exit(code); };
const argv = process.argv.slice(2);
let json = false;
let root = process.cwd();
let recordArg = null;
const ids = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--json") json = true;
  else if (a === "--root") { if (i + 1 >= argv.length) die(USAGE); root = argv[++i]; }
  else if (a.startsWith("--root=")) root = a.slice(7);
  else if (a === "--record") { if (i + 1 >= argv.length) die(USAGE); recordArg = argv[++i]; }
  else if (a.startsWith("--record=")) recordArg = a.slice(9);
  else if (a.startsWith("--")) die(USAGE);
  else if (/^S-\d+$/.test(a)) ids.push(a);
  else die(`${USAGE}\nnot a sprint id: ${a}`);
}
root = resolve(process.cwd(), root);

// --- shared text helpers (duplicated in proposal-check.mjs on purpose) ---------------
const blank = (s) => s.replace(/[^\n]/g, " ");
const stripComments = (t) => {
  let out = t.replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, blank);
  const k = out.indexOf("<!--");
  if (k !== -1) out = out.slice(0, k) + blank(out.slice(k));
  return out;
};
const maskCode = (l) => l.replace(/`+[^`]*`+/g, (m) => " ".repeat(m.length));

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

// Parse a document (comments already blanked) into lines, fences and headings.
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

const TEMPLATE_BRACES = templatePlaceholders(root, "docs/sprints/SPRINT_TEMPLATE.md");

function parseDoc(stripped) {
  const lines = stripped.split("\n");
  const fence = new Array(lines.length).fill(false);
  let open = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { fence[i] = true; open = !open; continue; }
    fence[i] = open;
  }
  const headings = [];
  for (let i = 0; i < lines.length; i++) {
    if (fence[i]) continue;
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[i]);
    if (m) headings.push({ i, level: m[1].length, title: m[2].trim() });
  }
  const hset = new Set(headings.map((h) => h.i));
  const isBlank = (i) => lines[i].trim() === "";
  const sectionOf = (title, level, from = 0, to = lines.length) => {
    const h = headings.find((x) => x.level === level && x.i >= from && x.i < to && x.title.toLowerCase() === title.toLowerCase());
    if (!h) return null;
    const next = headings.find((x) => x.i > h.i && x.level <= level);
    return { heading: h.i, start: h.i + 1, end: Math.min(next ? next.i : lines.length, to) };
  };
  const body = (r) => {
    const out = [];
    for (let i = r.start; i < r.end; i++) if (!isBlank(i) && !hset.has(i)) out.push(i);
    return out;
  };
  return { lines, fence, headings, hset, isBlank, sectionOf, body };
}

// Frontmatter (flat `key: value` plus block lists) from blanked lines.
function parseFrontmatter(lines) {
  if (lines[0] !== "---") return { ok: false, end: -1, get: () => null, block: () => [] };
  const end = lines.indexOf("---", 1);
  if (end === -1) return { ok: false, end: -1, get: () => null, block: () => [] };
  const get = (key) => {
    const re = new RegExp(`^${key}:\\s*(.*)$`);
    for (let i = 1; i < end; i++) {
      const m = re.exec(lines[i]);
      if (m) return { value: m[1].trim().replace(/^(["'])(.*)\1$/, "$2"), line: i };
    }
    return null;
  };
  const block = (key) => {
    const h = get(key);
    if (!h) return [];
    const out = [];
    for (let i = h.line + 1; i < end && /^\s+-\s+/.test(lines[i]); i++) out.push(lines[i].replace(/^\s+-\s+/, "").trim());
    return out;
  };
  return { ok: true, end, get, block };
}
// Flow array `[S-001, S-002]` → {ids} or {error}.
function flowIds(value) {
  const m = /^\[(.*)\]$/.exec(value);
  if (!m) return { error: `not a flow array: ${value}` };
  const items = m[1].split(",").map((s) => s.trim().replace(/^(["'])(.*)\1$/, "$2")).filter(Boolean);
  const bad = items.filter((s) => !/^S-\d+$/.test(s));
  if (bad.length) return { error: `not S-NNN ids: ${bad.join(", ")}` };
  return { ids: items };
}

// --- locate sprint files -----------------------------------------------------------------
const DIRS = [
  ["backlog", "docs/sprints/backlog"],
  ["in-progress", "docs/sprints/in-progress"],
  ["done", "docs/sprints/done"],
  ["archive", "docs/sprints/done/archive"],
  ["rejected", "docs/sprints/rejected"],
];
const index = new Map(); // id → [{dir, file}] in DIRS preference order
const dirExists = {};
for (const [dir, rel] of DIRS) {
  const abs = join(root, rel);
  let names = [];
  try { names = readdirSync(abs).sort(); dirExists[dir] = true; } catch { dirExists[dir] = false; }
  for (const n of names) {
    const m = /^(S-\d+)-.*\.md$/.exec(n);
    if (!m) continue;
    if (!index.has(m[1])) index.set(m[1], []);
    index.get(m[1]).push({ dir, file: join(abs, n) });
  }
}
const locate = (id) => index.get(id)?.[0] ?? null;

const cache = new Map(); // file → parsed sprint
function load(file) {
  if (cache.has(file)) return cache.get(file);
  let raw;
  try { raw = readFileSync(file, "utf8"); } catch (e) { die(`cannot read ${file}: ${e.message}`); }
  const doc = parseDoc(stripComments(raw));
  const fm = parseFrontmatter(doc.lines);
  const o = { file, doc, fm };
  cache.set(file, o);
  return o;
}
const depsOf = (file) => {
  const o = load(file);
  const d = o.fm.get("depends_on");
  if (!d) return [];
  const r = flowIds(d.value);
  return r.ids ?? [];
};
// Bullets under `## Interface Contract` → `### <which>`; `null` body = none.
function contractBullets(o, which) {
  const { doc } = o;
  const ic = doc.sectionOf("Interface Contract", 2);
  if (!ic) return { bullets: [], none: true };
  const sub = doc.sectionOf(which, 3, ic.start, ic.end);
  if (!sub) return { bullets: [], none: true };
  const content = doc.body(sub);
  const bullets = content.filter((i) => /^\s*[-*]\s+/.test(doc.lines[i])).map((i) => ({ i, text: doc.lines[i].replace(/^\s*[-*]\s+/, "") }));
  return { bullets, none: bullets.length === 0 };
}

// --- choose the sprints to lint --------------------------------------------------------------
const targets = [];
if (ids.length === 0) {
  if (!dirExists.backlog) die(`no backlog directory: ${join(root, DIRS[0][1])}`);
  for (const [id, locs] of [...index.entries()].sort()) for (const l of locs) if (l.dir === "backlog") targets.push({ id, ...l });
} else {
  for (const id of ids) {
    const l = (index.get(id) ?? []).find((x) => x.dir === "backlog" || x.dir === "in-progress");
    if (!l) die(`unknown sprint ${id}: no ${id}-*.md in backlog/ or in-progress/ under ${join(root, "docs/sprints")}`);
    targets.push({ id, ...l });
  }
}
const explicit = ids.length > 0;
const relFile = (f) => relative(root, f) || f;

// --- per-sprint lint -----------------------------------------------------------------------------
const fullTier = existsSync(join(root, "scripts/sprint/claims.mjs"));
const results = [];
for (const t of targets) {
  const o = load(t.file);
  const { doc, fm } = o;
  const { lines } = doc;
  const failures = [];
  const warnings = [];
  const fail = (rule, i, text) => failures.push({ rule, line: Math.max(i, 0) + 1, text: String(text ?? lines[i]).trim().slice(0, 120) });
  const warn = (rule, i, text) => warnings.push({ rule, line: Math.max(i, 0) + 1, text: String(text ?? lines[i]).trim().slice(0, 120) });
  const start = fm.ok ? fm.end + 1 : 0;
  const prefix = (/^(S-\d+)-/.exec(basename(t.file)) ?? [])[1];

  // frontmatter-invalid
  let depends = [];
  if (!fm.ok) fail("frontmatter-invalid", 0, "no frontmatter (file must start with --- and close it)");
  else {
    const sp = fm.get("sprint");
    if (!sp) fail("frontmatter-invalid", 0, "missing `sprint:`");
    else if (!/^S-\d+$/.test(sp.value)) fail("frontmatter-invalid", sp.line, `sprint: ${sp.value} — must match S-NNN`);
    else if (sp.value !== prefix) fail("frontmatter-invalid", sp.line, `sprint: ${sp.value} does not match filename prefix ${prefix}`);
    const pts = fm.get("story_points");
    if (!pts) fail("frontmatter-invalid", 0, "missing `story_points:` (one of 1,2,3,5,8,13)");
    else if (![1, 2, 3, 5, 8, 13].includes(Number(pts.value)) || pts.value === "") fail("frontmatter-invalid", pts.line, `story_points: ${pts.value} — must be one of 1,2,3,5,8,13`);
    const risk = fm.get("risk");
    if (risk && !["low", "high"].includes(risk.value)) fail("frontmatter-invalid", risk.line, `risk: ${risk.value} — must be low | high`);
    const tier = fm.get("tier");
    if (tier && !["routine", "standard", "complex", "critical"].includes(tier.value)) fail("frontmatter-invalid", tier.line, `tier: ${tier.value} — must be routine | standard | complex | critical`);
    for (const key of ["depends_on", "blocks"]) {
      const h = fm.get(key);
      if (!h) continue;
      const r = flowIds(h.value);
      if (r.error) fail("frontmatter-invalid", h.line, `${key}: ${r.error}`);
      else if (key === "depends_on") depends = r.ids;
    }
  }
  const riskVal = fm.ok ? fm.get("risk")?.value ?? null : null;
  const tierVal = fm.ok ? fm.get("tier")?.value ?? null : null;

  // tier-unjustified — the rubric is asymmetric (docs/sprints/tier-rubric.md): going DOWN
  // to routine needs every criterion and a recorded reason, so the mechanical ones are
  // checked here; a complex/critical tier with no reason only warns (raising is cheap,
  // and pre-1.14 briefs carry `tier: complex` with no tier_reason key at all).
  if (fm.ok && tierVal) {
    const tierLine = fm.get("tier").line;
    const reason = (fm.get("tier_reason")?.value ?? "").trim();
    const hasReason = reason !== "" && reason !== "null" && reason !== "~";
    if (tierVal === "routine") {
      if (!hasReason) fail("tier-unjustified", tierLine, "tier: routine needs tier_reason: naming the existing pattern it follows (file:line)");
      if (riskVal === "high") fail("tier-unjustified", tierLine, "tier: routine with risk: high — a high-risk sprint is at least complex");
      const pts = Number(fm.get("story_points")?.value);
      if (pts > 3) fail("tier-unjustified", tierLine, `tier: routine with story_points: ${pts} — routine is at most 3 points`);
    } else if ((tierVal === "complex" || tierVal === "critical") && !hasReason) {
      warn("tier-unreasoned", tierLine, `tier: ${tierVal} has no tier_reason: — record the signal that decided it`);
    }
  }

  // dependency-unknown / dependency-rejected
  const depLine = fm.ok ? fm.get("depends_on")?.line ?? 0 : 0;
  for (const d of depends) {
    const locs = index.get(d);
    if (!locs) fail("dependency-unknown", depLine, `${d} has no sprint file in backlog/, in-progress/, done/, done/archive/ or rejected/`);
    else if (locs.every((l) => l.dir === "rejected")) fail("dependency-rejected", depLine, `${d} lives in rejected/ — re-wire or drop the edge`);
  }

  // placeholder-left (one failure per line)
  let inRisks = false;
  for (let i = 0; i < lines.length; i++) {
    if (doc.fence[i]) continue;
    const l = lines[i];
    const h = doc.headings.find((x) => x.i === i);
    if (h && h.level <= 2) inRisks = h.level === 2 && /^risks$/i.test(h.title);
    let hit = false;
    if (/One sentence describing what "done" looks like/.test(l)) hit = true;
    if (i >= start) {
      if (/^#\s+S-NNN\b/.test(l) || l.includes("[Sprint Name]") || l.includes("[Feature/Task Name]")) hit = true;
      else if (/\bpath\/to\//.test(l)) hit = true;
      else if (hasTemplateBrace(TEMPLATE_BRACES, maskCode(l))) hit = true;
      else if (inRisks && l.trim().startsWith("|")) {
        const cells = l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        if (cells.some((c) => c === "Description" || c === "How to handle")) hit = true;
      }
    }
    if (hit) fail("placeholder-left", i, l);
  }

  // deliverables-missing / criteria-missing
  const deliv = doc.sectionOf("Deliverables", 3);
  if (!deliv) fail("deliverables-missing", 0, "no `### Deliverables` section");
  else {
    const items = [];
    for (let i = deliv.start; i < deliv.end; i++) if (!doc.fence[i] && /^\d+\.\s+\*\*/.test(lines[i])) items.push(i);
    if (items.length === 0) fail("deliverables-missing", deliv.heading, "no numbered `1. **…**` deliverable under ### Deliverables");
    items.forEach((s, k) => {
      const e = k + 1 < items.length ? items[k + 1] : deliv.end;
      let has = false;
      for (let i = s + 1; i < e; i++) if (/^\s*- \[[ xX]\]/.test(lines[i])) { has = true; break; }
      if (!has) fail("criteria-missing", s, `${lines[s].trim()}  ← no \`- [ ]\` acceptance criterion`);
    });
  }

  // contract-unproduced
  {
    const cons = contractBullets(o, "Consumes");
    for (const b of cons.bullets) {
      if (/^(—|–|-)?\s*none\b/i.test(b.text)) continue;
      const m = /\bfrom\s+(S-\d+)\b/.exec(b.text);
      if (!m) { fail("contract-unproduced", b.i, `${b.text}  ← no \`from S-NNN\` source sprint`); continue; }
      const dep = m[1];
      if (!depends.includes(dep)) { fail("contract-unproduced", b.i, `${b.text}  ← ${dep} is not in depends_on`); continue; }
      const loc = locate(dep);
      if (!loc || loc.dir === "done" || loc.dir === "archive" || loc.dir === "rejected") continue; // (b) only for live dependencies
      const idm = /`([^`]+)`/.exec(b.text);
      if (!idm) { fail("contract-unproduced", b.i, `${b.text}  ← no backticked identifier to check`); continue; }
      const prod = contractBullets(load(loc.file), "Produces");
      if (!prod.bullets.some((p) => p.text.includes(idm[1]))) fail("contract-unproduced", b.i, `${b.text}  ← \`${idm[1]}\` is not in ${dep}'s ### Produces`);
    }
  }

  // production-notes-missing
  if (riskVal === "high") {
    const pn = doc.sectionOf("Production notes", 2);
    if (!pn) fail("production-notes-missing", 0, "risk: high requires a ## Production notes section");
    else {
      for (const key of ["Rollback", "Observability", "Security"]) {
        const re = new RegExp(`^\\s*[-*]\\s*(?:\\*\\*)?${key}(?:\\*\\*)?:\\s*(.*)$`, "i");
        let found = null;
        for (let i = pn.start; i < pn.end; i++) {
          const m = re.exec(lines[i]);
          if (!m) continue;
          let v = m[1];
          for (let j = i + 1; j < pn.end && /^\s+\S/.test(lines[j]) && !/^\s*[-*]\s/.test(lines[j]); j++) v += ` ${lines[j]}`;
          found = { i, v: v.trim() };
          break;
        }
        if (!found) { fail("production-notes-missing", pn.heading, `## Production notes has no \`- ${key}:\` bullet`); continue; }
        const na = /^(n\/a|none)\b\.?(.*)$/i.exec(found.v);
        const reason = na ? na[2].replace(/^[\s—–:.-]+/, "").trim() : "";
        if (found.v === "" || found.v.startsWith("{") || /^<.*>$/.test(found.v) || /^\[.*\]$/.test(found.v) || (na && reason === "")) {
          fail("production-notes-missing", found.i, `${key}: needs a concrete answer or \`n/a — <why>\``);
        }
      }
    }
  }

  // open-question-vague
  {
    const oq = doc.sectionOf("Open Questions", 2);
    if (oq) {
      for (let i = oq.start; i < oq.end; i++) {
        if (!/^\s*[-*]\s+\[ \]/.test(lines[i])) continue;
        let tx = lines[i];
        for (let j = i + 1; j < oq.end && !doc.isBlank(j) && !/^\s*[-*]\s+\[/.test(lines[j]) && !doc.hset.has(j); j++) tx += ` ${lines[j]}`;
        if (!tx.toLowerCase().includes("options:")) fail("open-question-vague", i, `${lines[i].trim()}  ← no \`options:\``);
        if (tierVal === "routine") fail("tier-unjustified", i, "tier: routine with an open question — a sprint with an undecided choice is at least standard");
      }
    }
  }

  // citation-unresolved (body only, outside fences)
  for (let i = start; i < lines.length; i++) {
    if (doc.fence[i]) continue;
    const l = lines[i];
    CITE.lastIndex = 0;
    for (let m = CITE.exec(l); m; m = CITE.exec(l)) {
      const [raw, p, ext, a, b] = m;
      const before = l[m.index - 1] ?? "";
      if (/[{}<>]/.test(before) || /[{}<>]/.test(p) || /^https?/i.test(p)) continue;
      if (!/[A-Za-z]/.test(ext)) continue;
      if (!p.includes("/") && TLDS.has(ext.toLowerCase())) continue;
      const n = countLines(resolve(root, p));
      const s = Number(a);
      const e = b === undefined ? s : Number(b);
      if (n === null) fail("citation-unresolved", i, `${raw} — file not found under ${root}`);
      else if (s < 1 || e < s || e > n) fail("citation-unresolved", i, `${raw} — file has only ${n} line(s)`);
    }
  }

  // touches-empty (WARN, full tier only)
  if (fullTier && fm.ok) {
    const h = fm.get("touches");
    const flow = h ? /^\[(.*)\]$/.exec(h.value) : null;
    const entries = h ? (flow ? flow[1].split(",").map((s) => s.trim()).filter(Boolean) : h.value && h.value !== "null" ? [h.value] : fm.block("touches")) : [];
    if (entries.length === 0) warn("touches-empty", h ? h.line : 0, "touches: has no entries — /sprint plan should populate the file-claims manifest");
  }

  results.push({ id: t.id, file: t.file, dir: t.dir, failures, warnings, risk: riskVal, tier: tierVal, proposal: fm.ok ? fm.get("proposal")?.value ?? null : null, proposalLine: fm.ok ? fm.get("proposal")?.line ?? 0 : 0 });
}

// --- dependency-cycle ----------------------------------------------------------------------------------
{
  const color = new Map(); // id → 1 gray, 2 black
  const reported = new Set();
  const stack = [];
  const visit = (id, owner) => {
    color.set(id, 1);
    stack.push(id);
    const loc = locate(id);
    for (const d of loc ? depsOf(loc.file) : []) {
      if (color.get(d) === 1) {
        const cyc = stack.slice(stack.indexOf(d));
        const key = [...cyc].sort().join(",");
        if (!reported.has(key)) {
          reported.add(key);
          const r = owner;
          r.failures.push({ rule: "dependency-cycle", line: 1, text: [...cyc, d].join(" -> ") });
        }
      } else if (!color.has(d)) visit(d, owner);
    }
    stack.pop();
    color.set(id, 2);
  };
  for (const r of results) if (!color.has(r.id)) visit(r.id, r);
}

// --- plan record ---------------------------------------------------------------------------------------
let record = null;
let recordFailures = 0;
if (recordArg !== null) {
  let rf = isAbsolute(recordArg) ? recordArg : resolve(root, recordArg);
  if (!existsSync(rf) && !isAbsolute(recordArg) && existsSync(resolve(process.cwd(), recordArg))) rf = resolve(process.cwd(), recordArg);
  let raw;
  try { raw = readFileSync(rf, "utf8"); } catch (e) { die(`cannot read ${recordArg}: ${e.message}`); }
  const doc = parseDoc(stripComments(raw));
  const { lines } = doc;
  const failures = [];
  const fail = (rule, i, text) => failures.push({ rule, line: Math.max(i, 0) + 1, text: String(text ?? lines[i]).trim().slice(0, 120) });
  const sec = doc.sectionOf("Plan record", 2);
  let entryText = "";
  if (!sec) fail("record-missing", 0, "no `## Plan record` section (an entry inside an HTML comment does not count)");
  else {
    const subs = doc.headings.filter((h) => h.level === 3 && h.i >= sec.start && h.i < sec.end);
    const es = subs.length ? subs[subs.length - 1].i : sec.start;
    const entry = [];
    for (let i = es; i < sec.end; i++) if (!doc.fence[i]) entry.push(i);
    entryText = entry.map((i) => lines[i]).join("\n");
    const cov = entry.filter((i) => /^\s*(\||[-*]\s|\d+\.\s)/.test(lines[i]) && /S-\d+/.test(lines[i]));
    if (cov.length === 0) fail("record-coverage-missing", es, "latest Plan record entry has no coverage map (a table/list whose lines reference S-NNN)");
    let last = -1;
    for (let i = sec.end - 1; i >= sec.start; i--) if (!doc.isBlank(i)) { last = i; break; }
    if (last !== -1 && lines[last].trim() === "NO UNRESOLVED DECISIONS") { /* sentinel ok */ }
    else {
      let u = -1;
      for (let i = sec.start; i < sec.end; i++) if (/^\s*UNRESOLVED DECISIONS:/.test(lines[i])) u = i;
      let bullets = false;
      if (u !== -1) for (let i = u + 1; i < sec.end && !doc.hset.has(i); i++) if (/^\s*[-*]\s+\S/.test(lines[i])) { bullets = true; break; }
      if (u !== -1 && bullets) fail("record-unresolved", u, "Plan record lists UNRESOLVED DECISIONS — resolve them before execution");
      else fail("record-sentinel-missing", last === -1 ? sec.heading : last, "Plan record must end with exactly `NO UNRESOLVED DECISIONS` (or an `UNRESOLVED DECISIONS:` bullet list)");
    }
  }
  // coverage-ghost: backlog mode only
  if (!explicit && sec) {
    const num = /^(\d+)/.exec(basename(rf));
    if (num) {
      for (const r of results) {
        if (r.proposal === null || !/^\d+$/.test(r.proposal) || Number(r.proposal) !== Number(num[1])) continue;
        if (!new RegExp(`\\b${r.id}\\b`).test(entryText)) {
          r.failures.push({ rule: "coverage-ghost", line: r.proposalLine + 1, text: `${r.id} cites proposal ${r.proposal} but is not in the latest Plan record entry of ${basename(rf)}` });
        }
      }
    }
  }
  recordFailures = failures.length;
  record = { file: rf, ok: failures.length === 0, failures };
}

// --- report ----------------------------------------------------------------------------------------------
const nFail = results.reduce((n, r) => n + r.failures.length, 0) + recordFailures;
const nWarn = results.reduce((n, r) => n + r.warnings.length, 0);
const ok = nFail === 0;
const summary = `SUMMARY plan-check: ${ok ? "ok" : "FAILED"} — ${results.length} sprint(s), ${nFail} failure(s), ${nWarn} warning(s)`;
if (json) {
  console.log(JSON.stringify({
    ok,
    sprints: results.map((r) => ({ sprint: r.id, file: relFile(r.file), risk: r.risk, tier: r.tier, failures: r.failures, warnings: r.warnings })),
    record,
    failures: nFail,
  }, null, 2));
} else {
  for (const r of results) {
    for (const w of r.warnings) console.log(`WARN ${w.rule} ${r.id} L${w.line}: ${w.text}`);
    for (const f of r.failures) console.log(`FAIL ${f.rule} ${r.id} L${f.line}: ${f.text}`);
  }
  if (record) for (const f of record.failures) console.log(`FAIL ${f.rule} record L${f.line}: ${f.text}`);
  console.log(summary);
}
process.exit(ok ? 0 : 5);
