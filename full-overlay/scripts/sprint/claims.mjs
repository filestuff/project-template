#!/usr/bin/env node
// File-claims operations over the `touches:` manifests of in-flight sprints
// and wave-reserved backlog sprints. In-flight = files in docs/sprints/in-progress/
// on main; reserved = backlog files with a `wave:` set by reserve-wave.sh (the
// primary checkout is parked clean on main — so reading the filesystem reads main).
//
//   claims.mjs check --sprint S-NNN              # that sprint's touches vs all OTHER in-flight sprints
//   claims.mjs check --paths a,b [--sprint S-NNN] # explicit paths vs in-flight (excluding own sprint)
//   claims.mjs add S-NNN <path...> [--no-push]   # locked main commit appending to touches
//   claims.mjs covers --sprints S-A,S-B           # paths on stdin (one per line) vs those
//                                                 # sprints' touches; prints the uncovered ones
//   claims.mjs ready [--wave W-<id>] [--json]     # backlog sprints startable RIGHT NOW (rolling
//                                                 # wave admission): deps landed, claims non-empty,
//                                                 # unreserved (or reserved by --wave), disjoint from
//                                                 # in-flight + other waves' reservations + each other
//   claims.mjs waves                             # derived parallel wave schedule (deps + claim-disjoint)
//
// Claim grammar: exact repo-relative path | directory prefix ending in /** |
// token (defined in claims-tokens.json). A token-shaped claim (no "/" or ".",
// e.g. `deps`, `db:schema`) that is neither a defined token nor an existing
// file/dir at the repo root (`Makefile`, `LICENSE`, `scripts`) is an error,
// never a silent exact-path claim that overlaps nothing.
//
// Exit codes: 0 free · 2 overlap, or an unknown claim token · 3 (add) claim
// committed locally but push withheld — local main carries non-ledger commits
// (see ledger-push.sh) · 1 error.
// `ready`: 0 always for a readable repo (nothing ready is not an error) · 1 usage error.
// `covers`: 0 every path is claimed · 2 some are not (listed) · 3 a named sprint has no
// touches at all, so nothing can be verified.

import { join, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { repoRoot, readSprintFile, setField, allSprints, shortLabel } from "./frontmatter.mjs";

// Claim tokens are project-specific — defined in the sibling claims-tokens.json
// ({ "tokens": { "name": ["path", "dir/**", …] } }), seeded at bootstrap.
const TOKENS_FILE = join(dirname(fileURLToPath(import.meta.url)), "claims-tokens.json");
const TOKENS = existsSync(TOKENS_FILE)
  ? (JSON.parse(readFileSync(TOKENS_FILE, "utf8")).tokens ?? {})
  : null; // null = no tokens file at all (reported as such, not as "zero valid tokens")

// Bare-token shape: no "/", no "." — anything else is a real path/prefix claim
// and passes through expand() unchanged.
const BARE_TOKEN_SHAPE = /^[\w-]+(:[\w-]+)?$/;

let rootCache;
const rootPathExists = (claim) => existsSync(join((rootCache ??= repoRoot()), claim));

// A claim expands to one or more patterns: {kind: "exact"|"prefix", value}.
// Throws (never process.exit) on an unknown bare token: computeWaves/claimsOverlap
// are imported by regen.mjs, which must be able to report the failure itself.
function expand(claim) {
  let sources;
  if (TOKENS && Object.hasOwn(TOKENS, claim)) sources = TOKENS[claim];
  else if (BARE_TOKEN_SHAPE.test(claim) && !rootPathExists(claim)) throw unknownToken(claim);
  else sources = [claim];
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

// Is a concrete repo-relative path inside any of these claims? (The land-time check:
// claims are only a guarantee if what a branch actually changed is held against them.)
export function pathCovered(path, claims) {
  for (const claim of claims)
    for (const p of expand(claim)) if (p.kind === "prefix" ? path.startsWith(p.value) : path === p.value) return true;
  return false;
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
//
// In-flight and wave-reserved sprints (the `check` claim holders) pin Wave 1
// unconditionally: they already hold their claims — start.sh / reserve-wave.sh
// admitted them, so their deps and mutual overlaps (a train's reserved members
// overlap by design) were settled then. Everything else is placed greedily
// around them, so Wave 1 ("startable now") agrees with `check`.
export function computeWaves(sprints) {
  const WORK = new Set(["backlog", "in-progress"]);
  const work = sprints.filter((s) => WORK.has(s.dir));
  // Validate every claim up front: a sprint that never meets an overlap check
  // (a lone backlog sprint) must still fail loud on an unknown token.
  for (const s of work) for (const c of s.touches ?? []) expand(c);
  const ids = new Set(work.map((s) => s.sprint));
  const num = (s) => parseInt(String(s.sprint).replace(/\D/g, ""), 10) || 0;
  const holdsClaims = (s) => s.dir === "in-progress" || (s.dir === "backlog" && Boolean(s.wave));
  const placed = new Map(); // sprint id -> wave index
  const waves = [];
  let pool = [...work].sort((a, b) => num(a) - num(b));
  while (pool.length) {
    const w = waves.length;
    const wave = w === 0 ? pool.filter(holdsClaims) : [];
    // Ready = every dep satisfied: done/external (not in work set) OR placed in an earlier wave.
    const ready = pool.filter(
      (s) =>
        !wave.includes(s) &&
        (s.depends_on ?? []).every((d) => !ids.has(d) || (placed.has(d) && placed.get(d) < w)),
    );
    for (const s of ready) {
      if (wave.some((t) => sprintsClaimOverlap(s, t))) continue; // file conflict → a later wave
      wave.push(s);
    }
    if (wave.length === 0) break; // cycle / over-constrained — remaining go to `unscheduled`
    wave.sort((a, b) => num(a) - num(b));
    for (const s of wave) placed.set(s.sprint, w);
    waves.push(wave);
    pool = pool.filter((s) => !placed.has(s.sprint));
  }
  return { waves, unscheduled: pool };
}

// Plan-readiness status for the wave renderers (labels only — computeWaves
// scheduling is deliberately untouched). "unplanned" = never certified by
// /sprint plan (no plan_date). "stale" = a dependency landed after the plan was
// written (end_date > plan_date; string compare is safe for YYYY-MM-DD), so the
// plan's file:line premises may cite moved code — re-verify before dispatch.
export function planStatus(s, byId) {
  if (!s.plan_date) return "unplanned";
  for (const d of s.depends_on ?? []) {
    const dep = byId.get(d);
    if (!dep || !["done", "done/archive"].includes(dep.dir)) continue;
    if (dep.end_date && String(dep.end_date) > String(s.plan_date)) return "stale";
  }
  return "fresh";
}

// Real pairwise overlap (unlike sprintsClaimOverlap, an empty manifest overlaps nothing —
// this mirrors `check`/start.sh, so "ready" implies start.sh's claims check passes).
function touchesOverlap(a, b) {
  for (const ca of a.touches ?? []) for (const cb of b.touches ?? []) if (claimsOverlap(ca, cb)) return true;
  return false;
}

// "What can start right now?" — the mechanical admission query for a rolling wave.
// A backlog sprint is READY iff: (a) every depends_on sprint is landed (done/ or
// done/archive/); (b) it has non-empty touches; (c) it is unreserved or reserved by
// `wave`; (d) its touches are disjoint from every in-flight sprint and from every
// backlog sprint reserved by a wave OTHER than `wave`; (e) in ascending sprint-number
// order, it is disjoint from the sprints already accepted (the whole set can start
// together). Returns { ready: [sprint…], blocked: [{ sprint, reason }] } — each blocked
// sprint carries its FIRST failing reason, checked in the order above.
export function computeReady(sprints, wave) {
  const num = (s) => parseInt(String(s.sprint).replace(/\D/g, ""), 10) || 0;
  const byId = new Map(sprints.map((s) => [s.sprint, s]));
  const inFlight = sprints.filter((s) => s.dir === "in-progress");
  const reservedElsewhere = sprints.filter((s) => s.dir === "backlog" && s.wave && s.wave !== wave);
  const ready = [];
  const blocked = [];
  const backlog = sprints.filter((s) => s.dir === "backlog").sort((a, b) => num(a) - num(b));
  for (const s of backlog) {
    const block = (reason) => blocked.push({ sprint: s.sprint, reason });
    let unmet = null;
    for (const d of s.depends_on ?? []) {
      const dep = byId.get(d);
      if (dep && ["done", "done/archive"].includes(dep.dir)) continue;
      unmet = `depends on ${d} (${dep ? dep.dir : "missing"})`;
      break;
    }
    if (unmet) { block(unmet); continue; }
    if ((s.touches ?? []).length === 0) { block("no claims"); continue; }
    if (s.wave && s.wave !== wave) { block(`reserved by ${s.wave}`); continue; }
    const flying = inFlight.find((t) => touchesOverlap(s, t));
    if (flying) { block(`claims overlap ${flying.sprint} (in flight)`); continue; }
    const held = reservedElsewhere.find((t) => t.sprint !== s.sprint && touchesOverlap(s, t));
    if (held) { block(`claims overlap ${held.sprint} (reserved ${held.wave})`); continue; }
    const ahead = ready.find((t) => touchesOverlap(s, t));
    if (ahead) { block(`claims overlap ${ahead.sprint} (ready ahead of it)`); continue; }
    ready.push(s);
  }
  return { ready, blocked };
}

function inFlightSprints(root) {
  const dir = join(root, "docs/sprints/in-progress");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^S-\d+.*\.md$/.test(f))
    .map((f) => readSprintFile(join(dir, f)));
}

// Backlog sprints reserved by a live wave (`wave: W-…` set by reserve-wave.sh).
// They hold their claims like in-flight sprints do: a reservation is a scheduling
// claim on files that another wave must not also reserve or start against.
function reservedBacklogSprints(root) {
  const dir = join(root, "docs/sprints/backlog");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^S-\d+.*\.md$/.test(f))
    .map((f) => readSprintFile(join(dir, f)))
    .filter((s) => s.wave)
    .map((s) => ({ ...s, _reserved: true }));
}

// The full conflict set for claim checks: in-flight + wave-reserved backlog.
function claimHolders(root) {
  return [...inFlightSprints(root), ...reservedBacklogSprints(root)];
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
    else if (argv[i] === "--wave") args.wave = argv[++i];
    else if (argv[i] === "--sprints") args.sprints = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (argv[i] === "--no-push") args.noPush = true;
    else args.positional.push(argv[i]);
  }
  return args;
}

function unknownToken(claim) {
  const notPath = `"${claim}" is not a file or directory at the repo root either`;
  if (TOKENS === null)
    return new Error(
      `unknown claim token "${claim}" — claims-tokens.json is missing (expected at ${TOKENS_FILE}), ` +
        `so no tokens are defined; ${notPath}. Create claims-tokens.json defining it, or claim an exact path / dir/** prefix.`,
    );
  const names = Object.keys(TOKENS).sort();
  return new Error(
    `unknown claim token "${claim}" — not defined in ${TOKENS_FILE} ` +
      `(${names.length ? `valid tokens: ${names.join(", ")}` : "the file defines no tokens"}); ${notPath}. ` +
      `Define the token, or claim an exact path / dir/** prefix.`,
  );
}

// --- CLI (only when run directly, not when imported by regen.mjs) ----------
// realpath: import.meta.url is symlink-resolved, argv[1] is not (e.g. macOS /var → /private/var).
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
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

  // Only the expand()/claimsOverlap() calls can throw an unknown-token error, so
  // only they are try-scoped — an fs/frontmatter error elsewhere stays its own
  // uncaught failure rather than being remapped to exit 2.
  const holders = claimHolders(root);
  const overlaps = [];
  try {
    for (const myClaim of mine) expand(myClaim); // validate even when nothing else is in flight
    for (const other of holders) {
      if (args.sprint && other.sprint === args.sprint) continue;
      // Same-wave holders are our own train/wave roster: a reservation guards
      // against OTHER sessions, and a serial train's members legitimately share
      // claims (they run one at a time on one branch). Foreign waves still block.
      if (args.wave && other.wave === args.wave) continue;
      for (const theirClaim of other.touches ?? [])
        for (const myClaim of mine)
          if (claimsOverlap(myClaim, theirClaim))
            overlaps.push({
              sprint: other.sprint,
              mine: myClaim,
              theirs: theirClaim,
              reserved: other._reserved ? other.wave : null,
            });
    }
  } catch (err) {
    console.error(err.message ?? String(err));
    process.exit(2);
  }

  if (overlaps.length === 0) {
    console.log("FREE — no overlap with in-flight or wave-reserved claims");
    process.exit(0);
  }
  console.log("OVERLAP with in-flight / wave-reserved sprints:");
  for (const o of overlaps)
    console.log(
      `  ${o.mine}  ⟂  ${o.theirs}  (claimed by ${o.sprint}${o.reserved ? `, reserved ${o.reserved}` : ""})`,
    );
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

  // The new paths must themselves be free before claiming them — free of other
  // in-flight sprints AND of any wave's reserved backlog members.
  const others = claimHolders(root).filter((s) => s.sprint !== id);
  try {
    for (const p of paths) expand(p); // never commit a claim that cannot be checked
    for (const other of others)
      for (const theirClaim of other.touches ?? [])
        for (const p of paths)
          if (claimsOverlap(p, theirClaim)) {
            console.log(
              `OVERLAP: ${p}  ⟂  ${theirClaim}  (claimed by ${other.sprint}${other._reserved ? `, reserved ${other.wave}` : ""})`,
            );
            process.exit(2);
          }
  } catch (err) {
    console.error(err.message ?? String(err));
    process.exit(2);
  }

  const lockSh = join(root, "scripts/sprint/lock.sh");
  const token = execFileSync(lockSh, ["acquire", `claim-${id}`], { encoding: "utf8" }).trim();
  const mainBranch = process.env.SPRINT_MAIN_BRANCH || "main";
  let pushStatus = 0; // ledger-push.sh exit: 0 pushed/nothing to push · 3 withheld · other = error
  try {
    const current = readSprintFile(sprintFile).touches ?? [];
    setField(sprintFile, "touches", [...current, ...paths.filter((p) => !current.includes(p))]);
    const rel = `docs/sprints/in-progress/${hit}`;
    execFileSync("git", ["-C", root, "add", "--", rel]);
    execFileSync("git", [
      "-C", root, "commit", "--no-verify", "-m",
      `sprint: claim ${paths.join(", ")} for ${id} [skip ci]`, "--", rel,
    ]);
    if (!args.noPush) {
      // Guarded push: ledger-push.sh refuses (exit 3) when local main also carries
      // non-ledger commits, so a claim never publishes another session's code.
      const push = spawnSync("bash", [join(root, "scripts/sprint/ledger-push.sh"), root, mainBranch], {
        stdio: "inherit",
      });
      pushStatus = push.status ?? 1;
    } else {
      let ahead;
      try {
        ahead = execFileSync(
          "git", ["-C", root, "rev-list", "--count", `origin/${mainBranch}..${mainBranch}`],
          { encoding: "utf8" },
        ).trim();
      } catch {
        ahead = "?";
      }
      console.log(
        `push deferred — local ${mainBranch} is ${ahead} commit(s) ahead of origin/${mainBranch}; wave checkpoints push via scripts/sprint/push-main.sh`,
      );
    }
    console.log(`claimed for ${id}: ${paths.join(", ")}`);
    console.log("Mirror the same touches: addition in the branch's copy of the sprint file.");
  } finally {
    execFileSync(lockSh, ["release", token]);
  }
  if (pushStatus === 3) {
    console.error(
      `claim committed locally, push withheld — local ${mainBranch} carries non-ledger commits (see ledger-push.sh output above); exiting 3`,
    );
    process.exit(3);
  }
  if (pushStatus !== 0) {
    console.error(
      `push failed (ledger-push.sh exit ${pushStatus}) — the local claim commit is intact; resolve, then push it with "bash scripts/sprint/ledger-push.sh ${root} ${mainBranch}" while holding the sprint lock`,
    );
    process.exit(1);
  }
} else if (cmd === "covers") {
  // Land-time guarantee: every path a branch changed must be inside its roster's touches.
  if (!args.sprints?.length) {
    console.error("usage: <paths on stdin> | claims.mjs covers --sprints S-A,S-B");
    process.exit(1);
  }
  const claims = [];
  const unclaimed = [];
  for (const id of args.sprints) {
    const file = findSprintFile(root, id);
    if (!file) {
      console.error(`${id}: no sprint file in in-progress/ or backlog/ on the ledger`);
      process.exit(1);
    }
    const touches = readSprintFile(file).touches ?? [];
    if (touches.length === 0) unclaimed.push(id);
    claims.push(...touches);
  }
  if (unclaimed.length) {
    console.log(`NO-CLAIMS: ${unclaimed.join(", ")} — no touches: to check against`);
    process.exit(3);
  }
  const paths = readFileSync(0, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  const outside = paths.filter((p) => !pathCovered(p, claims));
  for (const p of outside) console.log(p);
  process.exit(outside.length ? 2 : 0);
} else if (cmd === "waves") {
  // Derived parallel schedule over backlog + in-progress (deps + claim-disjointness).
  // Only computeWaves() (via claimsOverlap) can throw an unknown-token error.
  const sprints = allSprints(root);
  const byId = new Map(sprints.map((s) => [s.sprint, s]));
  let waves, unscheduled;
  try {
    ({ waves, unscheduled } = computeWaves(sprints));
  } catch (err) {
    console.error(err.message ?? String(err));
    process.exit(2);
  }
  if (waves.length === 0) {
    console.log("no pending sprints (backlog + in-progress empty)");
  } else {
    waves.forEach((wave, i) => {
      const label = (s) => {
        const plan = s.dir === "backlog" ? planStatus(s, byId) : "fresh";
        return (
          `${s.sprint}${s.dir === "in-progress" ? " (in flight)" : ""}` +
          (s.dir === "backlog" && s.wave ? ` (reserved ${s.wave})` : "") +
          ((s.touches ?? []).length === 0 ? " ⚠ no claims" : "") +
          (plan === "unplanned" ? " ⚠ unplanned" : plan === "stale" ? " ⚠ stale plan" : "")
        );
      };
      const tag = i === 0 ? "startable now in parallel" : `after wave ${i}`;
      console.log(`Wave ${i + 1} (${tag}): ${wave.map(label).join(", ")}`);
    });
  }
  if (unscheduled.length > 0)
    console.log(
      `Unscheduled (dependency cycle?): ${unscheduled.map((s) => s.sprint).join(", ")}`,
    );
} else if (cmd === "ready") {
  // Own arg parsing: --json is specific to this subcommand (parseArgs is shared and untouched).
  let wave = null;
  let json = false;
  let bad = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--json") json = true;
    else if (rest[i] === "--wave") {
      wave = rest[++i];
      if (!wave || !/^W-\S+$/.test(wave)) bad = `--wave needs a wave id (W-<id>), got '${wave ?? ""}'`;
    } else bad = `unknown argument: ${rest[i]}`;
  }
  if (bad) {
    console.error(bad);
    console.error("usage: claims.mjs ready [--wave W-<id>] [--json]");
    process.exit(1);
  }
  const sprints = allSprints(root);
  const byId = new Map(sprints.map((s) => [s.sprint, s]));
  const { ready, blocked } = computeReady(sprints, wave ?? undefined);
  if (json) {
    console.log(
      JSON.stringify(
        {
          ready: ready.map((s) => ({
            sprint: s.sprint,
            file: relative(root, s.file),
            plan: planStatus(s, byId),
            wave: s.wave ?? null,
            risk: s.risk ?? "low",
            tier: s.tier ?? "standard",
            story_points: s.story_points ?? null,
            touches: s.touches ?? [],
          })),
          blocked,
        },
        null,
        2,
      ),
    );
  } else {
    for (const s of ready)
      console.log(
        `${s.sprint}  ${s.story_points ?? "?"}pt  ${s.risk ?? "low"}/${s.tier ?? "standard"}  ${planStatus(s, byId)}  ${shortLabel(s)}`,
      );
    for (const b of blocked) console.log(`blocked: ${b.sprint} — ${b.reason}`);
    console.log(`SUMMARY ready: ${ready.length} startable, ${blocked.length} blocked`);
  }
} else {
  console.error("usage: claims.mjs check|add|covers|waves|ready ...");
  process.exit(1);
}
}
