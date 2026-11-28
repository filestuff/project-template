#!/usr/bin/env node
// Where sprint files live — the one place that knows. Zero-dep; ships in both tiers.
//
// A sprint file sits in one of four states, and its folder says which:
//   docs/sprints/backlog/        not started
//   docs/sprints/in-progress/    started
//   docs/sprints/done/<bucket>/  finished — its permanent home, never moved again
//   docs/sprints/rejected/       deliberately not built
// <bucket> is the sprint's hundred, zero-padded to 4 digits: S-001 → 0000-0099,
// S-645 → 0600-0699, S-1384 → 1300-1399. So a finished sprint's path is a function of
// its id alone — links never rot and nothing has to search for it.
//
// Before v1.19.0 finished sprints sat in a flat done/ and were rotated into
// done/archive/. Those legacy folders are still read (state done) so an unmigrated repo
// keeps working; nothing writes there any more (migrations/v1.19.0.sh moves them).
//
// CLI (root = --root, else the primary checkout via git, else cwd):
//   paths.mjs next-id               # S-NNN one past the highest id in any state
//   paths.mjs done-home S-NNN       # docs/sprints/done/<bucket> (relative to root, no slash)
//   paths.mjs find S-NNN            # the file's path relative to root; exit 1 if none
//   paths.mjs duplicates            # ids with more than one file; exit 2 if any
//
// Importable: SPRINTS, idNum, bucketOf, doneHome, repoRoot, sprintDirs,
//             listSprintFiles, findSprint, nextId, duplicateIds

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const SPRINTS = "docs/sprints";
const FILE_RE = /^(S-(\d+))(?:-.*)?\.md$/;
const BUCKET_RE = /^\d{4,}-\d{4,}$/;

export function idNum(id) {
  const m = /^S-(\d+)$/.exec(String(id));
  if (!m) throw new Error(`not a sprint id: ${id}`);
  return Number(m[1]);
}

export function bucketOf(id) {
  const lo = Math.floor(idNum(id) / 100) * 100;
  const pad = (n) => String(n).padStart(4, "0");
  return `${pad(lo)}-${pad(lo + 99)}`;
}

// Relative to the repo root, no trailing slash.
export function doneHome(id) {
  return `${SPRINTS}/done/${bucketOf(id)}`;
}

// The lifecycle ledger root (primary checkout) — identical from any worktree.
// SPRINT_ROOT overrides it for testing or for operating on a non-ledger checkout.
export function repoRoot() {
  if (process.env.SPRINT_ROOT) return process.env.SPRINT_ROOT;
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  return common.replace(/\/\.git$/, "");
}

// Every folder that can hold sprint files, in lookup-preference order:
// [{ dir (relative to docs/sprints), state }]. Only folders that exist are listed.
export function sprintDirs(root) {
  const base = join(root, SPRINTS);
  const out = [];
  const add = (dir, state) => {
    if (existsSync(join(base, dir))) out.push({ dir, state });
  };
  add("backlog", "backlog");
  add("in-progress", "in-progress");
  const done = join(base, "done");
  if (existsSync(done)) {
    const buckets = readdirSync(done)
      .filter((n) => BUCKET_RE.test(n) && statSync(join(done, n)).isDirectory())
      .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
    for (const b of buckets) out.push({ dir: `done/${b}`, state: "done" });
    out.push({ dir: "done", state: "done" }); // legacy flat done/
    add("done/archive", "done"); // legacy archive
  }
  add("rejected", "rejected");
  return out;
}

// [{ id, num, state, dir, name, file (absolute), rel (relative to root) }], by id number.
export function listSprintFiles(root) {
  const out = [];
  for (const { dir, state } of sprintDirs(root)) {
    const abs = join(root, SPRINTS, dir);
    for (const name of readdirSync(abs)) {
      const m = FILE_RE.exec(name);
      if (!m) continue;
      out.push({ id: m[1], num: Number(m[2]), state, dir, name, file: join(abs, name), rel: `${SPRINTS}/${dir}/${name}` });
    }
  }
  return out.sort((a, b) => a.num - b.num || a.name.localeCompare(b.name));
}

// The first file for `id` in lookup-preference order, or null.
export function findSprint(root, id) {
  const order = new Map(sprintDirs(root).map((d, i) => [d.dir, i]));
  const hits = listSprintFiles(root).filter((s) => s.id === id);
  hits.sort((a, b) => order.get(a.dir) - order.get(b.dir));
  return hits[0] ?? null;
}

// Ids are numbers, not strings: S-99 and S-099 are the same sprint.
export function nextId(root) {
  const max = listSprintFiles(root).reduce((m, s) => Math.max(m, s.num), 0);
  return `S-${String(max + 1).padStart(3, "0")}`;
}

// [{ id, files: [rel…] }] for every sprint number held by more than one file.
export function duplicateIds(root) {
  const byNum = new Map();
  for (const s of listSprintFiles(root)) {
    if (!byNum.has(s.num)) byNum.set(s.num, []);
    byNum.get(s.num).push(s);
  }
  return [...byNum.values()].filter((l) => l.length > 1).map((l) => ({ id: l[0].id, files: l.map((s) => s.rel) }));
}

function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--root");
  let root = i === -1 ? null : argv.splice(i, 2)[1];
  if (!root) {
    try {
      root = repoRoot();
    } catch {
      root = process.cwd();
    }
  }
  const [cmd, id] = argv;
  const needId = () => {
    try {
      idNum(id);
    } catch {
      console.error(`usage: paths.mjs ${cmd} S-NNN`);
      process.exit(1);
    }
  };
  if (cmd === "next-id") console.log(nextId(root));
  else if (cmd === "done-home") {
    needId();
    console.log(doneHome(id));
  } else if (cmd === "find") {
    needId();
    const s = findSprint(root, id);
    if (!s) {
      console.error(`no file for ${id} under ${join(root, SPRINTS)}`);
      process.exit(1);
    }
    console.log(s.rel);
  } else if (cmd === "duplicates") {
    const d = duplicateIds(root);
    for (const x of d) console.log(`${x.id}: ${x.files.join(", ")}`);
    if (d.length > 0) process.exit(2);
  } else {
    console.error("usage: paths.mjs [--root <repo-root>] next-id | done-home S-NNN | find S-NNN | duplicates");
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
