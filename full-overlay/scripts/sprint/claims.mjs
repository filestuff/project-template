#!/usr/bin/env node
// File-claims operations over the `touches:` manifests of in-flight sprints.
// In-flight = files in docs/sprints/in-progress/ on main (the primary checkout,
// which is parked clean on main — so reading the filesystem reads main).
//
//   claims.mjs check --sprint S-NNN              # that sprint's touches vs all OTHER in-flight sprints
//   claims.mjs check --paths a,b [--sprint S-NNN] # explicit paths vs in-flight (excluding own sprint)
//   claims.mjs add S-NNN <path...> [--no-push]   # locked main commit appending to touches
//
// Claim grammar: exact repo-relative path | directory prefix ending in /** |
// token (defined in claims-tokens.json). Exit codes: 0 free · 2 overlap · 1 error.

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { repoRoot, readSprintFile, setField, allSprints } from "./frontmatter.mjs";

// Claim tokens are project-specific — defined in the sibling claims-tokens.json
// ({ "tokens": { "name": ["path", "dir/**", …] } }), seeded at bootstrap.
const TOKENS = (() => {
  const file = join(dirname(fileURLToPath(import.meta.url)), "claims-tokens.json");
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8")).tokens ?? {};
})();

// A claim expands to one or more patterns: {kind: "exact"|"prefix", value}
function expand(claim) {
  const sources = TOKENS[claim] ?? [claim];
  return sources.map((s) =>
    s.endsWith("/**")
      ? { kind: "prefix", value: s.slice(0, -2) } // keep trailing "/"
      : { kind: "exact", value: s },
  );
}

function patternsOverlap(a, b) {
  if (a.kind === "exact" && b.kind === "exact") return a.value === b.value;
  if (a.kind === "prefix" && b.kind === "prefix")
    return a.value.startsWith(b.value) || b.value.startsWith(a.value);
  const [exact, prefix] = a.kind === "exact" ? [a, b] : [b, a];
  return exact.value.startsWith(prefix.value);
}

export function claimsOverlap(claimA, claimB) {
  for (const pa of expand(claimA))
    for (const pb of expand(claimB)) if (patternsOverlap(pa, pb)) return true;
  return false;
}

// Two sprints can share a parallel wave only if their `touches:` are disjoint.
// A sprint with NO claims can't be proven safe → treated as conflicting with all,
// so it lands in its own wave (flagged by the renderer).
function sprintsClaimOverlap(a, b) {
  const at = a.touches ?? [];
  const bt = b.touches ?? [];
  if (at.length === 0 || bt.length === 0) return true;
  for (const ca of at) for (const cb of bt) if (claimsOverlap(ca, cb)) return true;
  return false;
}

// Derive parallel "waves" from the backlog + in-progress work set.
// A wave is a set of sprints that can run concurrently: every dependency is
// satisfied by an earlier wave (or already done / outside the set), AND the
// members are pairwise `touches:`-disjoint. NOT a topological level — file
// conflicts split a level across waves. `depends_on` edges always force ordering;
// the Interface Contract (sprint body) is the deliberate way to start a dependent
// early, which this conservative view intentionally does not auto-schedule.
export function computeWaves(sprints) {
  const WORK = new Set(["backlog", "in-progress"]);
  const work = sprints.filter((s) => WORK.has(s.dir));
  const ids = new Set(work.map((s) => s.sprint));
  const num = (s) => parseInt(String(s.sprint).replace(/\D/g, ""), 10) || 0;
  const placed = new Map(); // sprint id -> wave index
  const waves = [];
  let pool = [...work].sort((a, b) => num(a) - num(b));
  while (pool.length) {
    const w = waves.length;
    // Ready = every dep satisfied: done/external (not in work set) OR placed in an earlier wave.
    const ready = pool.filter((s) =>
      (s.depends_on ?? []).every((d) => !ids.has(d) || (placed.has(d) && placed.get(d) < w)),
    );
    const wave = [];
    for (const s of ready) {
      if (wave.some((t) => sprintsClaimOverlap(s, t))) continue; // file conflict → a later wave
      wave.push(s);
    }
    if (wave.length === 0) break; // cycle / over-constrained — remaining go to `unscheduled`
    for (const s of wave) placed.set(s.sprint, w);
    waves.push(wave);
    pool = pool.filter((s) => !placed.has(s.sprint));
  }
  return { waves, unscheduled: pool };
}

function inFlightSprints(root) {
  const dir = join(root, "docs/sprints/in-progress");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^S-\d+.*\.md$/.test(f))
    .map((f) => readSprintFile(join(dir, f)));
}

function findSprintFile(root, id) {
  for (const dir of ["in-progress", "backlog"]) {
    const abs = join(root, "docs/sprints", dir);
    if (!existsSync(abs)) continue;
    const hit = readdirSync(abs).find((f) => f.startsWith(`${id}-`) && f.endsWith(".md"));
    if (hit) return join(abs, hit);
  }
  return null;
}

function parseArgs(argv) {
  const args = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--sprint") args.sprint = argv[++i];
    else if (argv[i] === "--paths") args.paths = argv[++i].split(",").map((s) => s.trim());
    else if (argv[i] === "--no-push") args.noPush = true;
    else args.positional.push(argv[i]);
  }
  return args;
}

// --- CLI (only when run directly, not when imported by regen.mjs) ----------
if (process.argv[1] === fileURLToPath(import.meta.url)) {
const root = repoRoot();
const [, , cmd, ...rest] = process.argv;
const args = parseArgs(rest);

if (cmd === "check") {
  let mine;
  if (args.paths) {
    mine = args.paths;
  } else if (args.sprint) {
    const file = findSprintFile(root, args.sprint);
    if (!file) {
      console.error(`no sprint file found for ${args.sprint} in backlog/ or in-progress/`);
      process.exit(1);
    }
    mine = readSprintFile(file).touches ?? [];
  } else {
    console.error("usage: claims.mjs check --sprint S-NNN | --paths a,b [--sprint S-NNN]");
    process.exit(1);
  }

  const overlaps = [];
  for (const other of inFlightSprints(root)) {
    if (args.sprint && other.sprint === args.sprint) continue;
    for (const theirClaim of other.touches ?? [])
      for (const myClaim of mine)
        if (claimsOverlap(myClaim, theirClaim))
          overlaps.push({ sprint: other.sprint, mine: myClaim, theirs: theirClaim });
  }

  if (overlaps.length === 0) {
    console.log("FREE — no overlap with in-flight claims");
    process.exit(0);
  }
  console.log("OVERLAP with in-flight sprints:");
  for (const o of overlaps) console.log(`  ${o.mine}  ⟂  ${o.theirs}  (claimed by ${o.sprint})`);
  process.exit(2);
} else if (cmd === "add") {
  const [id, ...paths] = args.positional;
  if (!id || paths.length === 0) {
    console.error("usage: claims.mjs add S-NNN <path...> [--no-push]");
    process.exit(1);
  }
  const file = join(root, "docs/sprints/in-progress");
  const hit = existsSync(file)
    ? readdirSync(file).find((f) => f.startsWith(`${id}-`) && f.endsWith(".md"))
    : null;
  if (!hit) {
    console.error(`${id} is not in-flight on main (no in-progress/ file) — run start.sh first`);
    process.exit(1);
  }
  const sprintFile = join(file, hit);

  // The new paths must themselves be free before claiming them.
  const others = inFlightSprints(root).filter((s) => s.sprint !== id);
  for (const other of others)
    for (const theirClaim of other.touches ?? [])
      for (const p of paths)
        if (claimsOverlap(p, theirClaim)) {
          console.log(`OVERLAP: ${p}  ⟂  ${theirClaim}  (claimed by ${other.sprint})`);
          process.exit(2);
        }

  const lockSh = join(root, "scripts/sprint/lock.sh");
  const token = execFileSync(lockSh, ["acquire", `claim-${id}`], { encoding: "utf8" }).trim();
  try {
    const current = readSprintFile(sprintFile).touches ?? [];
    setField(sprintFile, "touches", [...current, ...paths.filter((p) => !current.includes(p))]);
    const rel = `docs/sprints/in-progress/${hit}`;
    execFileSync("git", ["-C", root, "add", "--", rel]);
    execFileSync("git", [
      "-C", root, "commit", "--no-verify", "-m",
      `sprint: claim ${paths.join(", ")} for ${id}`, "--", rel,
    ]);
    if (!args.noPush)
      execFileSync("git", [
        "-C", root, "push", "origin", process.env.SPRINT_MAIN_BRANCH || "main",
      ]);
    console.log(`claimed for ${id}: ${paths.join(", ")}`);
    console.log("Mirror the same touches: addition in the branch's copy of the sprint file.");
  } finally {
    execFileSync(lockSh, ["release", token]);
  }
} else if (cmd === "waves") {
  // Derived parallel schedule over backlog + in-progress (deps + claim-disjointness).
  const { waves, unscheduled } = computeWaves(allSprints(root));
  if (waves.length === 0) {
    console.log("no pending sprints (backlog + in-progress empty)");
  } else {
    waves.forEach((wave, i) => {
      const label = (s) =>
        `${s.sprint}${s.dir === "in-progress" ? " (in flight)" : ""}` +
        ((s.touches ?? []).length === 0 ? " ⚠ no claims" : "");
      const tag = i === 0 ? "startable now in parallel" : `after wave ${i}`;
      console.log(`Wave ${i + 1} (${tag}): ${wave.map(label).join(", ")}`);
    });
  }
  if (unscheduled.length > 0)
    console.log(
      `Unscheduled (dependency cycle?): ${unscheduled.map((s) => s.sprint).join(", ")}`,
    );
} else {
  console.error("usage: claims.mjs check|add|waves ...");
  process.exit(1);
}
}
