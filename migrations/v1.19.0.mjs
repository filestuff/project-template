#!/usr/bin/env node
// Steps for migrations/v1.19.0.sh — finished sprints get a permanent home per hundred
// (docs/sprints/done/<bucket>/) and the Done ledger is generated from `summary:`.
// Run from the downstream repo root; each step is idempotent on its own.
//
//   node v1.19.0.mjs move       # git mv done/S-*.md + done/archive/S-*.md → done/<bucket>/
//   node v1.19.0.mjs summaries  # seed `summary:` on done files (INDEX Done row, else ### Outcome)
//   node v1.19.0.mjs relink     # rewrite done/[archive/]S-….md references in docs/**/*.md
//   node v1.19.0.mjs index      # Done table → generated block; stacked INDEX/ROADMAP headers →
//                               # INDEX-HISTORY.md / ROADMAP-HISTORY.md
//
// `summaries` must run before `index` (it reads the hand-written Done table that `index`
// replaces). Each step prints one line saying what it changed.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const SPRINTS = "docs/sprints";
const DONE = join(root, SPRINTS, "done");
const FILE_RE = /^(S-(\d+))(?:-.*)?\.md$/;

const bucketOf = (num) => {
  const lo = Math.floor(num / 100) * 100;
  const pad = (n) => String(n).padStart(4, "0");
  return `${pad(lo)}-${pad(lo + 99)}`;
};
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const tracked = (rel) => {
  try {
    git("ls-files", "--error-unmatch", "--", rel);
    return true;
  } catch {
    return false;
  }
};

// Every done sprint file wherever it sits: [{ id, num, name, abs }].
function doneFiles() {
  const out = [];
  if (!existsSync(DONE)) return out;
  const dirs = [DONE, join(DONE, "archive")];
  for (const n of readdirSync(DONE)) if (/^\d{4,}-\d{4,}$/.test(n) && statSync(join(DONE, n)).isDirectory()) dirs.push(join(DONE, n));
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const name of readdirSync(d)) {
      const m = FILE_RE.exec(name);
      if (m) out.push({ id: m[1], num: Number(m[2]), name, abs: join(d, name) });
    }
  }
  return out;
}

function move() {
  const legacy = [DONE, join(DONE, "archive")];
  const byBucket = new Map();
  for (const dir of legacy) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const m = FILE_RE.exec(name);
      if (!m) continue;
      const b = bucketOf(Number(m[2]));
      if (!byBucket.has(b)) byBucket.set(b, []);
      byBucket.get(b).push(join(dir, name));
    }
  }
  let moved = 0;
  for (const [b, files] of byBucket) {
    const dest = join(DONE, b);
    mkdirSync(dest, { recursive: true });
    for (const f of files) {
      const name = f.slice(f.lastIndexOf("/") + 1);
      if (existsSync(join(dest, name))) throw new Error(`${join(dest, name)} already exists — refusing to overwrite with ${f}`);
    }
    const rel = (f) => f.slice(root.length + 1);
    const inGit = files.filter((f) => tracked(rel(f)));
    // one git mv per bucket (and per ~200 files, to stay under ARG_MAX)
    for (let i = 0; i < inGit.length; i += 200) git("mv", "--", ...inGit.slice(i, i + 200).map(rel), rel(dest));
    for (const f of files) if (!inGit.includes(f)) renameSync(f, join(dest, f.slice(f.lastIndexOf("/") + 1)));
    moved += files.length;
  }
  const archive = join(DONE, "archive");
  if (existsSync(archive)) {
    const rest = readdirSync(archive).filter((n) => n !== ".gitkeep" && n !== ".DS_Store");
    if (rest.length === 0) {
      for (const n of readdirSync(archive)) {
        if (n === ".gitkeep" && tracked(`${SPRINTS}/done/archive/.gitkeep`)) git("rm", "-q", "--", `${SPRINTS}/done/archive/.gitkeep`);
      }
      try {
        rmdirSync(archive);
      } catch {}
    } else console.log(`note: ${SPRINTS}/done/archive/ still holds non-sprint files, left in place: ${rest.join(", ")}`);
  }
  console.log(`move: ${moved} done sprint file(s) moved into ${byBucket.size} bucket(s)`);
}

// Split a markdown table row on unescaped pipes; unescape `\|` in each cell.
const cells = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));

function doneTableOutcomes() {
  const index = join(root, SPRINTS, "INDEX.md");
  const out = new Map();
  if (!existsSync(index)) return out;
  const lines = readFileSync(index, "utf8").split("\n");
  const start = lines.findIndex((l) => /^## Done\b/.test(l));
  if (start === -1) return out;
  for (let i = start + 1; i < lines.length && !/^## /.test(lines[i]); i++) {
    if (!/^\|/.test(lines[i])) continue;
    const c = cells(lines[i]);
    const m = /\[(S-\d+)\]/.exec(c[0] ?? "") ?? /^(S-\d+)\b/.exec(c[0] ?? "");
    if (!m || c.length < 2) continue;
    const last = [...c].reverse().find((x) => x !== "");
    if (last && last !== c[0] && !/^_\(/.test(last)) out.set(Number(m[1].slice(2)), last);
  }
  return out;
}

function firstOutcomeSentence(text) {
  const lines = text.split("\n");
  const h = lines.findIndex((l) => /^### Outcome\s*$/.test(l));
  if (h === -1) return null;
  const body = [];
  for (let i = h + 1; i < lines.length && !/^#{2,3} /.test(lines[i]); i++) {
    const t = lines[i].trim();
    if (t === "" && body.length > 0) break;
    if (t !== "" && !t.startsWith("<!--") && !/^_\(.*\)_$/.test(t)) body.push(t);
  }
  if (body.length === 0) return null;
  const para = body.join(" ");
  const m = /^(.+?[.!?])(\s|$)/.exec(para);
  return (m ? m[1] : para).trim();
}

function summaries() {
  const rows = doneTableOutcomes();
  let fromRow = 0;
  let fromLog = 0;
  let none = 0;
  for (const f of doneFiles()) {
    const text = readFileSync(f.abs, "utf8");
    const lines = text.split("\n");
    if (lines[0] !== "---") continue;
    const end = lines.indexOf("---", 1);
    if (end === -1) continue;
    const at = lines.findIndex((l, i) => i > 0 && i < end && /^summary:/.test(l));
    if (at !== -1 && !/^summary:\s*(null|~)?\s*$/.test(lines[at])) continue; // already has one
    let value = rows.get(f.num) ?? null;
    if (value) fromRow++;
    else {
      value = firstOutcomeSentence(text);
      if (value) fromLog++;
      else none++;
    }
    const line = `summary: ${value ? JSON.stringify(value) : "null"}`;
    if (at !== -1) lines[at] = line;
    else {
      const after = lines.findIndex((l, i) => i > 0 && i < end && /^end_date:/.test(l));
      lines.splice(after === -1 ? end : after + 1, 0, line);
    }
    writeFileSync(f.abs, lines.join("\n"));
  }
  console.log(`summaries: ${fromRow} from INDEX Done rows, ${fromLog} from ### Outcome, ${none} left null`);
}

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n.startsWith(".")) continue;
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (n.endsWith(".md")) out.push(p);
  }
  return out;
}

function relink() {
  const homes = new Map(doneFiles().map((f) => [f.name, bucketOf(f.num)]));
  const re = /(^|[^A-Za-z0-9_-])done\/(?:archive\/)?(S-(\d+)[A-Za-z0-9_.-]*\.md)/g;
  let files = 0;
  let links = 0;
  const targets = [...(existsSync(join(root, "docs")) ? walk(join(root, "docs")) : [])];
  for (const extra of ["CLAUDE.md", "README.md"]) if (existsSync(join(root, extra))) targets.push(join(root, extra));
  for (const p of targets) {
    const text = readFileSync(p, "utf8");
    let n = 0;
    const next = text.replace(re, (all, pre, name) => {
      const b = homes.get(name);
      if (!b) return all;
      n++;
      return `${pre}done/${b}/${name}`;
    });
    if (n > 0) {
      writeFileSync(p, next);
      files++;
      links += n;
    }
  }
  console.log(`relink: ${links} reference(s) rewritten in ${files} file(s)`);
}

const DONE_SECTION = `## Done

<!-- Generated from each finished sprint's \`summary:\` frontmatter (scripts/sprint/ledger.mjs)
     — never edit rows here; fix the sprint file and regenerate. The full history is one
     LEDGER.md per hundred sprints under done/<bucket>/. -->

<!-- BEGIN GENERATED: recent-done -->
_(none yet)_
<!-- END GENERATED: recent-done -->
`;

// Keep the first `_Last updated` line of `name`; move every other one and every
// `_Previously` line, verbatim and in order, to <stem>-HISTORY.md. Returns the count moved.
function unstackHeader(name) {
  const path = join(root, SPRINTS, name);
  if (!existsSync(path)) return 0;
  let first = true;
  const moved = [];
  const kept = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => {
      if (/^_Last updated\b/.test(l) && first) {
        first = false;
        return true;
      }
      if (/^_Last updated\b/.test(l) || /^_Previously\b/.test(l)) {
        moved.push(l);
        return false;
      }
      return true;
    });
  if (moved.length === 0) return 0;
  const stem = name.replace(/\.md$/, "");
  const hist = join(root, SPRINTS, `${stem}-HISTORY.md`);
  const head = existsSync(hist)
    ? readFileSync(hist, "utf8").replace(/\n*$/, "\n\n")
    : `# ${name} header history\n\nThe stacked \`_Last updated\` / \`_Previously\` lines ${name} carried before v1.19.0,\nmoved here verbatim, in their original order. ${name} now keeps ONE header line, overwritten.\n\n`;
  writeFileSync(hist, `${head}${moved.join("\n\n")}\n`);
  writeFileSync(path, kept.join("\n").replace(/\n{3,}/g, "\n\n"));
  return moved.length;
}

function index() {
  const path = join(root, SPRINTS, "INDEX.md");
  if (!existsSync(path)) return console.log("index: no INDEX.md — skipped");
  const notes = [];

  // 1. Headers: INDEX.md (and ROADMAP.md, full tier) keep one `_Last updated` line.
  for (const name of ["INDEX.md", "ROADMAP.md"]) {
    const n = unstackHeader(name);
    if (n > 0) notes.push(`${n} stacked ${name} header line(s) → ${name.replace(/\.md$/, "")}-HISTORY.md`);
  }
  let lines = readFileSync(path, "utf8").split("\n");

  // 2. Done section → generated block (once).
  if (!lines.some((l) => l.includes("<!-- BEGIN GENERATED: recent-done -->"))) {
    const start = lines.findIndex((l) => /^## Done\b/.test(l));
    if (start === -1) {
      const rej = lines.findIndex((l) => /^## Rejected\b/.test(l));
      lines.splice(rej === -1 ? lines.length : rej, 0, ...DONE_SECTION.split("\n"));
      notes.push("Done section added");
    } else {
      let end = start + 1;
      while (end < lines.length && !/^## /.test(lines[end])) end++;
      const rows = lines.slice(start, end).filter((l) => /^\|\s*\[?S-\d+/.test(l)).length;
      lines.splice(start, end - start, ...DONE_SECTION.split("\n"));
      notes.push(`hand-written Done table (${rows} row(s)) → generated block`);
    }
    writeFileSync(path, lines.join("\n"));
  }
  console.log(`index: ${notes.length ? notes.join("; ") : "already migrated"}`);
}

const steps = { move, summaries, relink, index };
const step = process.argv[2];
if (!steps[step]) {
  console.error(`usage: v1.19.0.mjs ${Object.keys(steps).join("|")}`);
  process.exit(1);
}
steps[step]();
