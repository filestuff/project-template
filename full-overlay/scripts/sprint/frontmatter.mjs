#!/usr/bin/env node
// Zero-dependency parser/serializer for the flat-YAML sprint frontmatter
// (scalars, flow arrays like `depends_on: [S-006, S-007]`, and block lists
// like `touches:` with `  - item` lines). Round-trip-safe: `set` rewrites
// only the targeted field's lines.
//
// CLI:
//   frontmatter.mjs get <file> <field>            # prints JSON value (null if absent)
//   frontmatter.mjs set <file> <field> <value>    # value parsed as JSON, else raw string
//
// Importable: parseFrontmatter, setField, readSprintFile, sprintDirs, repoRoot

import { readFileSync, writeFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { join, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

// The lifecycle ledger root (primary checkout) — identical from any worktree.
// SPRINT_ROOT overrides it for testing or for operating on a non-ledger checkout.
export function repoRoot() {
  if (process.env.SPRINT_ROOT) return process.env.SPRINT_ROOT;
  const common = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8" },
  ).trim();
  return common.replace(/\/\.git$/, "");
}

function stripComment(s) {
  const i = s.search(/\s#/);
  return (i === -1 ? s : s.slice(0, i)).trim();
}

function parseScalar(raw) {
  const v = stripComment(raw);
  if (v === "" || v === "null" || v === "~") return null;
  if (v.startsWith("[")) {
    const inner = v.replace(/^\[/, "").replace(/\]$/, "").trim();
    if (inner === "") return [];
    return inner.split(",").map((s) => stripComment(s.trim()));
  }
  if (/^-?\d+$/.test(v)) return Number(v);
  return v.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
}

// Returns { fields: { name: value }, spans: { name: [startLine, endLine] }, lines, bodyStart }
// Line indices refer to the full file's line array; frontmatter is lines 1..bodyStart-2.
export function parseFrontmatter(text) {
  const lines = text.split("\n");
  if (lines[0] !== "---") throw new Error("no frontmatter: file does not start with ---");
  const fields = {};
  const spans = {};
  let i = 1;
  while (i < lines.length && lines[i] !== "---") {
    const m = lines[i].match(/^([A-Za-z_][\w-]*):(.*)$/);
    if (!m) {
      i++;
      continue;
    }
    const [, key, rest] = m;
    const start = i;
    if (rest.trim() === "" || stripComment(rest) === "") {
      // possible block list
      const items = [];
      let j = i + 1;
      while (j < lines.length && /^\s+-\s/.test(lines[j])) {
        items.push(stripComment(lines[j].replace(/^\s+-\s+/, "")));
        j++;
      }
      fields[key] = items.length > 0 ? items : null;
      spans[key] = [start, j - 1];
      i = j;
    } else {
      fields[key] = parseScalar(rest);
      spans[key] = [start, start];
      i++;
    }
  }
  if (lines[i] !== "---") throw new Error("unterminated frontmatter");
  return { fields, spans, lines, bodyStart: i + 1 };
}

function serializeField(key, value) {
  if (value === null) return [`${key}: null`];
  if (Array.isArray(value)) {
    // touches reads best as a block list; other arrays keep the existing flow style
    if (key === "touches") {
      if (value.length === 0) return [`${key}: []`];
      return [`${key}:`, ...value.map((v) => `  - ${v}`)];
    }
    return [`${key}: [${value.join(", ")}]`];
  }
  return [`${key}: ${value}`];
}

export function setField(file, key, value) {
  const text = readFileSync(file, "utf8");
  const { spans, lines, bodyStart } = parseFrontmatter(text);
  const newLines = serializeField(key, value);
  if (spans[key]) {
    lines.splice(spans[key][0], spans[key][1] - spans[key][0] + 1, ...newLines);
  } else {
    lines.splice(bodyStart - 1, 0, ...newLines); // before closing ---
  }
  writeFileSync(file, lines.join("\n"));
}

export function readSprintFile(file) {
  const { fields } = parseFrontmatter(readFileSync(file, "utf8"));
  return { file, name: basename(file), ...fields };
}

export const SPRINT_DIRS = ["backlog", "in-progress", "done", "done/archive", "rejected"];

// All sprint files, each annotated with its dir. Skips .gitkeep/templates.
export function allSprints(root) {
  const out = [];
  for (const dir of SPRINT_DIRS) {
    const abs = join(root, "docs/sprints", dir);
    if (!existsSync(abs)) continue;
    for (const f of readdirSync(abs)) {
      if (!/^S-\d+.*\.md$/.test(f)) continue;
      if (dir === "done" && f === "archive") continue;
      out.push({ dir, ...readSprintFile(join(abs, f)) });
    }
  }
  return out.sort((a, b) => a.sprint.localeCompare(b.sprint, undefined, { numeric: true }));
}

// Short human label: explicit `short:` frontmatter, else derived from the filename.
export function shortLabel(s) {
  if (s.short) return s.short;
  return s.name
    .replace(/^S-\d+-/, "")
    .replace(/\.md$/, "")
    .replace(/-/g, " ");
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [, , cmd, file, field, rawValue] = process.argv;
  if (cmd === "get") {
    const { fields } = parseFrontmatter(readFileSync(file, "utf8"));
    console.log(JSON.stringify(fields[field] ?? null));
  } else if (cmd === "set") {
    let value;
    try {
      value = JSON.parse(rawValue);
    } catch {
      value = rawValue;
    }
    setField(file, field, value);
  } else {
    console.error("usage: frontmatter.mjs get|set <file> <field> [value]");
    process.exit(1);
  }
}
