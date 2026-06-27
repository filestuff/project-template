#!/usr/bin/env node
// Deterministic regeneration of the marker-delimited blocks in
// docs/sprints/INDEX.md and docs/sprints/ROADMAP.md. Everything outside the
// markers (header narrative, Done-table outcomes, phasing prose) is
// LLM-maintained and untouched here.
//
//   regen.mjs           # rewrite blocks in place
//   regen.mjs --check   # exit 2 (listing blocks) if any block is out of date
//
// Blocks — INDEX.md: totals, in-progress, backlog · ROADMAP.md: graph, critical-path

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, allSprints, shortLabel } from "./frontmatter.mjs";
import { computeWaves } from "./claims.mjs";

const root = repoRoot();
const check = process.argv.includes("--check");
const sprints = allSprints(root);
const byId = new Map(sprints.map((s) => [s.sprint, s]));
const isDone = (id) => ["done", "done/archive"].includes(byId.get(id)?.dir);

function bucket(dir) {
  return sprints.filter((s) => s.dir === dir);
}
const backlog = bucket("backlog");
const inProgress = bucket("in-progress");
const done = [...bucket("done"), ...bucket("done/archive")];
const rejected = bucket("rejected");
const pts = (list) => list.reduce((sum, s) => sum + (s.story_points ?? 0), 0);

// --- block generators ------------------------------------------------------

function genTotals() {
  return [
    `**Totals:** ${backlog.length} backlog (${pts(backlog)} pts) · ` +
      `${inProgress.length} in-progress (${pts(inProgress)} pts) · ` +
      `${done.length} done (${pts(done)} pts) · ${rejected.length} rejected`,
  ];
}

function depCell(s) {
  const deps = (s.depends_on ?? []).map((d) => (isDone(d) ? `${d} ✅` : d));
  const cell = deps.join(", ") || "—";
  return s.deps_note ? `${cell} ${s.deps_note}` : cell;
}

function genInProgress() {
  if (inProgress.length === 0) return ["_(none)_"];
  const rows = inProgress.map(
    (s) =>
      `| [${s.sprint}](in-progress/${s.name}) | ${shortLabel(s)} | ${s.story_points} | ` +
      `${s.start_date} | ${(s.touches ?? []).join(", ") || "—"} |`,
  );
  return [
    "| Sprint | Goal | Pts | Started | Touches (claimed files) |",
    "|--------|------|-----|---------|--------------------------|",
    ...rows,
  ];
}

function genBacklog() {
  if (backlog.length === 0) return ["_(empty)_"];
  const rows = backlog.map(
    (s) =>
      `| [${s.sprint}](backlog/${s.name}) | ${shortLabel(s)} | ${s.tasks ?? "—"} | ` +
      `${s.story_points} | ${depCell(s)} |`,
  );
  return [
    "| Sprint | Goal | Tasks | Pts | depends_on |",
    "|--------|------|-------|-----|------------|",
    ...rows,
  ];
}

function genGraph() {
  const graphed = sprints.filter((s) => s.dir !== "rejected");
  const nodeId = (id) => id.replace(/-/g, "");
  const lines = [
    "```mermaid",
    "graph TD",
    "  classDef backlog fill:#fed7aa,stroke:#c2410c,color:#7c2d12;",
    "  classDef inprogress fill:#fde68a,stroke:#b45309,color:#78350f;",
    "  classDef done fill:#bbf7d0,stroke:#15803d,color:#14532d;",
    "",
  ];
  for (const s of graphed)
    lines.push(`  ${nodeId(s.sprint)}["${s.sprint} · ${shortLabel(s)} (${s.story_points})"]`);
  lines.push("");
  for (const s of graphed)
    for (const d of s.depends_on ?? [])
      if (byId.has(d)) lines.push(`  ${nodeId(d)} --> ${nodeId(s.sprint)}`);
  const byClass = { done: [], inprogress: [], backlog: [] };
  for (const s of graphed) {
    const cls =
      s.dir === "in-progress" ? "inprogress" : s.dir === "backlog" ? "backlog" : "done";
    byClass[cls].push(nodeId(s.sprint));
  }
  lines.push("");
  for (const [cls, ids] of Object.entries(byClass))
    if (ids.length > 0) lines.push(`  class ${ids.join(",")} ${cls};`);
  lines.push("```");
  return lines;
}

function genCriticalPath() {
  // Longest depends_on chain by story points across non-rejected sprints.
  const memo = new Map();
  const visiting = new Set();
  function best(id) {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) return { pts: 0, chain: [] }; // cycle guard
    visiting.add(id);
    const s = byId.get(id);
    let result = { pts: s.story_points ?? 0, chain: [id] };
    for (const d of s.depends_on ?? []) {
      if (!byId.has(d) || byId.get(d).dir === "rejected") continue;
      const sub = best(d);
      if (sub.pts + (s.story_points ?? 0) > result.pts)
        result = { pts: sub.pts + (s.story_points ?? 0), chain: [...sub.chain, id] };
    }
    visiting.delete(id);
    memo.set(id, result);
    return result;
  }
  let top = { pts: 0, chain: [] };
  for (const s of sprints)
    if (s.dir !== "rejected") {
      const r = best(s.sprint);
      if (r.pts > top.pts) top = r;
    }
  const remaining = top.chain.filter((id) => !isDone(id)).reduce(
    (sum, id) => sum + (byId.get(id).story_points ?? 0), 0,
  );
  const rendered = top.chain.map((id) => (isDone(id) ? `${id} ✅` : id)).join(" → ");
  return [
    `**Critical path (${top.pts} pts — the longest dependency chain):** \`${rendered}\` ` +
      `(${top.pts - remaining} pts done; ${remaining} remaining).`,
  ];
}

function genWaves() {
  // Derived parallel schedule: each wave is dependency-ready AND claim-disjoint.
  const { waves, unscheduled } = computeWaves(sprints);
  if (waves.length === 0) return ["_(no pending sprints)_"];
  const label = (s) =>
    `${s.sprint}${s.dir === "in-progress" ? " (in flight)" : ""}` +
    ((s.touches ?? []).length === 0 ? " ⚠️ no claims" : "");
  const lines = waves.map((wave, i) => {
    const tag = i === 0 ? "startable now in parallel" : `after wave ${i}`;
    return `- **Wave ${i + 1}** (${tag}): ${wave.map(label).join(", ")}`;
  });
  if (unscheduled.length > 0)
    lines.push(
      `- **Unscheduled** (dependency cycle?): ${unscheduled.map((s) => s.sprint).join(", ")}`,
    );
  return lines;
}

// --- marker splicing -------------------------------------------------------

const FILES = {
  "docs/sprints/INDEX.md": { totals: genTotals, "in-progress": genInProgress, backlog: genBacklog },
  "docs/sprints/ROADMAP.md": { graph: genGraph, "critical-path": genCriticalPath, waves: genWaves },
};

let drift = [];
for (const [rel, blocks] of Object.entries(FILES)) {
  const path = join(root, rel);
  let text = readFileSync(path, "utf8");
  for (const [name, gen] of Object.entries(blocks)) {
    const begin = `<!-- BEGIN GENERATED: ${name} -->`;
    const end = `<!-- END GENERATED: ${name} -->`;
    const re = new RegExp(`${begin}\\n[\\s\\S]*?${end}`);
    if (!re.test(text)) {
      console.error(`missing markers for block '${name}' in ${rel}`);
      process.exit(1);
    }
    const replacement = `${begin}\n${gen().join("\n")}\n${end}`;
    if (!text.includes(replacement)) {
      drift.push(`${rel}#${name}`);
      text = text.replace(re, replacement);
    }
  }
  if (!check) writeFileSync(path, text);
}

if (check && drift.length > 0) {
  console.log(`DRIFT in generated blocks:\n  ${drift.join("\n  ")}`);
  process.exit(2);
}
console.log(check ? "generated blocks are current" : `regenerated${drift.length ? `: ${drift.join(", ")}` : " (no changes)"}`);
