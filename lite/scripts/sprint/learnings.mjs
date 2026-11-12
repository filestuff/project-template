#!/usr/bin/env node
// Read-side of the learning loop. Every closed sprint records `### Learnings` lines
// (`- YYYY-MM-DD S-NNN <plan|test|review|design|exec>: <what happened> → rule: <one line>`),
// but only `plan`-class lines were ever read again (via PLANNING_LEARNINGS.md); the rest
// sat in done/ where nothing consumed them. This lists them — newest first — so reviewers
// and planners start from what past sprints already paid to learn.
//
//   learnings.mjs [--class review,test] [--limit 20] [--root <repo-root>] [--json]
//
// Scans docs/sprints/done/ and docs/sprints/done/archive/. Zero-dep, read-only.
// Exit 0 always when the directories are readable (no learnings is not an error) ·
// 1 = usage. Human output: the matching lines verbatim, then a SUMMARY line; a rule
// (the text after `rule:`) recorded by 3+ sprints is flagged `RECURRING ×n` — that is the
// signal to promote it into a project convention (/review "Project-Specific Checks").
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] ?? "");
};
const CLASSES = ["plan", "test", "review", "design", "exec"];
const wanted = (flag("--class") ?? CLASSES.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const limit = Number(flag("--limit") ?? 20);
const root = flag("--root") || process.cwd();
const json = argv.includes("--json");
if (wanted.some((c) => !CLASSES.includes(c)) || !Number.isInteger(limit) || limit < 1) {
  console.error(`usage: learnings.mjs [--class ${CLASSES.join(",")}] [--limit N] [--root <repo-root>] [--json]`);
  process.exit(1);
}

const LINE = /^-\s+(\d{4}-\d{2}-\d{2})\s+(S-\d+)\s+(plan|test|review|design|exec):\s*(.+)$/;
const entries = [];
for (const dir of ["docs/sprints/done", "docs/sprints/done/archive"]) {
  const abs = join(root, dir);
  if (!existsSync(abs)) continue;
  for (const name of readdirSync(abs)) {
    if (!/^S-\d+.*\.md$/.test(name)) continue;
    const lines = readFileSync(join(abs, name), "utf8").split("\n");
    let inside = false;
    for (const raw of lines) {
      if (/^### Learnings\s*$/.test(raw)) inside = true;
      else if (/^#{2,3} /.test(raw)) inside = false;
      else if (inside) {
        const m = raw.match(LINE);
        if (!m || !wanted.includes(m[3])) continue;
        const rule = (m[4].split(/→\s*rule:/i)[1] ?? "").trim();
        entries.push({ date: m[1], sprint: m[2], class: m[3], text: m[4].trim(), rule, file: join(dir, name) });
      }
    }
  }
}
entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.sprint.localeCompare(a.sprint, undefined, { numeric: true })));

// A rule counts once per sprint; compare case- and punctuation-insensitively.
const norm = (r) => r.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const seen = new Map();
for (const e of entries) {
  if (!e.rule) continue;
  const k = norm(e.rule);
  if (!seen.has(k)) seen.set(k, { rule: e.rule, sprints: new Set() });
  seen.get(k).sprints.add(e.sprint);
}
const recurring = [...seen.values()].filter((v) => v.sprints.size >= 3).map((v) => ({ rule: v.rule, count: v.sprints.size, sprints: [...v.sprints] }));
const shown = entries.slice(0, limit);

if (json) {
  console.log(JSON.stringify({ total: entries.length, shown: shown.length, classes: wanted, entries: shown, recurring }, null, 2));
} else {
  for (const e of shown) console.log(`- ${e.date} ${e.sprint} ${e.class}: ${e.text}`);
  for (const r of recurring) console.log(`RECURRING ×${r.count} (${r.sprints.join(", ")}): ${r.rule}`);
  console.log(`SUMMARY learnings: ${shown.length} of ${entries.length} shown (${wanted.join(",")}), ${recurring.length} recurring rule(s)`);
}
