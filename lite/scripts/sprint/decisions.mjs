#!/usr/bin/env node
// Cross-artifact view of the decision record (docs/DECISION_POLICY.md). Decisions are
// written where they apply — a sprint file's Pre-Sprint Decisions, a proposal's Decisions
// register (`## Decision log` before v1.18), a Plan record — and nowhere else; this lists
// them, so "what was decided on my behalf this week?" is one command instead of a search.
// Zero-dep, read-only.
//
//   decisions.mjs [--class mechanical,taste,reserved] [--decider agent,arbiter,orchestrator,user]
//                 [--since YYYY-MM-DD] [--limit N] [--root <repo-root>] [--json]
//
// Reads every .md in each sprint folder (scripts/sprint/paths.mjs: backlog/, in-progress/,
// done/<bucket>/ and the legacy done/ + done/archive/, rejected/) and docs/proposals/. A decision line is
//   - YYYY-MM-DD (<mode>[, <class>[, <decider>]]): <decision> [— principle: …] [— rejected: …] [— undo: …]
// A proposal's register numbers its entries and may wrap them over indented lines:
//   - D-7 YYYY-MM-DD (<mode>, <class>, <decider>): <decision> — changes: <section> […] [— supersedes: D-4]
// `owner` is read as the decider `user`.
// Lines written before the policy existed carry only a mode — `(wave)`, `(train, auto)`,
// `(wave, in-flight)` — and are listed with class `unclassified` (`(train, auto)` reads
// as taste decided by the orchestrator, which is what it meant).
// Exit 0 (no decisions is not an error) · 1 usage.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SPRINTS, sprintDirs } from "./paths.mjs";

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i === -1 ? null : (argv[i + 1] ?? ""); };
const list = (n) => (flag(n) === null ? null : flag(n).split(",").map((s) => s.trim()).filter(Boolean));
const CLASSES = ["mechanical", "taste", "reserved", "unclassified"];
const DECIDERS = ["agent", "arbiter", "orchestrator", "user", "unknown"];
const classes = list("--class");
const deciders = list("--decider");
const since = flag("--since");
const limit = flag("--limit") === null ? Number.POSITIVE_INFINITY : Number(flag("--limit"));
const root = flag("--root") || process.cwd();
const json = argv.includes("--json");
const usage = () => { console.error("usage: decisions.mjs [--class mechanical,taste,reserved,unclassified] [--decider agent,arbiter,orchestrator,user] [--since YYYY-MM-DD] [--limit N] [--root <repo-root>] [--json]"); process.exit(1); };
if ((classes?.some((c) => !CLASSES.includes(c))) || (deciders?.some((d) => !DECIDERS.includes(d)))) usage();
if (since !== null && !/^\d{4}-\d{2}-\d{2}$/.test(since)) usage();
if (!(limit === Number.POSITIVE_INFINITY || (Number.isInteger(limit) && limit > 0))) usage();

const DIRS = [...sprintDirs(root).map((d) => `${SPRINTS}/${d.dir}`), "docs/proposals"];
const LINE = /^\s*-\s+(?:D-(\d+)\s+)?(\d{4}-\d{2}-\d{2})\s+\(([^)]+)\):\s*(.+)$/;
const KEYS = "principle|rejected|undo|changes|supersedes";
const part = (text, key) => {
  const m = text.match(new RegExp(`—\\s*${key}:\\s*(.*?)(?=\\s+—\\s*(?:${KEYS}):|$)`, "i"));
  return m ? m[1].trim() : "";
};

const entries = [];
for (const dir of DIRS) {
  const abs = join(root, dir);
  if (!existsSync(abs)) continue;
  for (const name of readdirSync(abs)) {
    if (!name.endsWith(".md") || /TEMPLATE|README|LEDGER/.test(name)) continue;
    const lines = readFileSync(join(abs, name), "utf8").split("\n");
    let fence = false;
    let comment = false;
    lines.forEach((raw, i) => {
      if (/^\s*```/.test(raw)) fence = !fence;
      if (raw.includes("<!--")) comment = true;
      const skip = fence || comment;
      if (raw.includes("-->")) comment = false;
      if (skip) return;
      const m = raw.match(LINE);
      if (!m) return;
      // Tags are comma-separated, but agents also write `(gated wave, taste, arbiter)` —
      // a decision that is recorded and then invisible here is worse than a loose parse,
      // so split on spaces too. Only lines whose parenthetical is made of decision tags
      // count — not `- 2026-01-02 (Tuesday): …`.
      const tags = m[3].toLowerCase().split(/[,\s]+/).filter(Boolean).map((t) => (t === "owner" ? "user" : t));
      const MODES = ["interactive", "gated", "unattended", "wave", "train", "in-flight", "auto", "solo", "start", "plan", "proposal", "recut"];
      if (!tags.every((t) => MODES.includes(t) || CLASSES.includes(t) || DECIDERS.includes(t))) return;
      let cls = tags.find((t) => ["mechanical", "taste", "reserved"].includes(t)) ?? "unclassified";
      let decider = tags.find((t) => ["agent", "arbiter", "orchestrator", "user"].includes(t)) ?? "unknown";
      if (cls === "unclassified" && tags.includes("auto")) { cls = "taste"; decider = "orchestrator"; }
      const mode = tags.filter((t) => MODES.includes(t)).join(", ") || "unknown";
      const id = m[1] ? `D-${m[1]}` : null;
      let text = m[4].trim();
      // A numbered register entry may wrap: indented lines up to the next item belong to it.
      if (id) for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]) && !/^\s*[-*]\s/.test(lines[j]); j++) text += ` ${lines[j].trim()}`;
      const decision = text.split(new RegExp(`\\s+—\\s*(?:${KEYS}):`, "i"))[0].trim();
      const sprint = (name.match(/^S-\d+/) ?? [null])[0];
      const where = sprint ?? name.replace(/\.md$/, "");
      entries.push({ date: m[2], mode, class: cls, decider, decision, principle: part(text, "principle"), rejected: part(text, "rejected"), undo: part(text, "undo"), changes: part(text, "changes"), supersedes: part(text, "supersedes"), id, where: id ? `${where} ${id}` : where, file: `${dir}/${name}`, line: i + 1 });
    });
  }
}
entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.file.localeCompare(b.file) || a.line - b.line));
const picked = entries.filter((e) => (!classes || classes.includes(e.class)) && (!deciders || deciders.includes(e.decider)) && (since === null || e.date >= since));
const shown = picked.slice(0, limit);
const count = (k) => picked.filter((e) => e.class === k).length;
// A taste decision with no rejected option or no undo is not auditable — flag it.
const thin = picked.filter((e) => e.class === "taste" && e.decider !== "user" && (!e.rejected || !e.undo) && e.mode !== "train, auto");

if (json) {
  console.log(JSON.stringify({ total: picked.length, shown: shown.length, counts: { mechanical: count("mechanical"), taste: count("taste"), reserved: count("reserved"), unclassified: count("unclassified") }, thin: thin.length, entries: shown }, null, 2));
} else {
  for (const e of shown) {
    console.log(`${e.date}  ${e.class.padEnd(12)} ${e.decider.padEnd(12)} ${e.where}: ${e.decision}`);
    const extra = [e.changes && `changes: ${e.changes}`, e.principle && `principle: ${e.principle}`, e.rejected && `rejected: ${e.rejected}`, e.undo && `undo: ${e.undo}`, e.supersedes && `supersedes: ${e.supersedes}`].filter(Boolean).join(" · ");
    if (extra) console.log(`            ${extra}`);
    console.log(`            ${e.file}:${e.line}`);
  }
  for (const e of thin) console.log(`THIN ${e.file}:${e.line} — taste decision without ${!e.rejected ? "a rejected option" : "an undo"}`);
  console.log(`SUMMARY decisions: ${shown.length} of ${picked.length} shown — ${count("mechanical")} mechanical, ${count("taste")} taste, ${count("reserved")} reserved, ${count("unclassified")} unclassified; ${thin.length} thin`);
}
