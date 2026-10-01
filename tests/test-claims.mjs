#!/usr/bin/env node
// Regression: a claim like `dpes` (typo) or a token missing from
// claims-tokens.json silently became an exact-path claim that overlapped
// nothing, so two sprints touching the same files were scheduled in parallel.
// expand() now throws on an unknown token-shaped claim (unless it names a real
// file/dir at the repo root, e.g. Makefile) and check/add/waves exit 2 with the
// message. Also pins: in-flight + wave-reserved sprints own Wave 1 in
// computeWaves (so `waves` agrees with `check`), and `add` pushes only through
// ledger-push.sh (exit 3 = committed locally, push withheld) — never a raw push.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const SRC = new URL("../full-overlay/scripts/sprint/", import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), "claims-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

let failed = 0;
const check = (label, cond, extra = "") => {
  if (!cond) { failed++; console.error(`FAIL ${label}${extra ? `\n${extra}` : ""}`); }
};
const git = (repo, ...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });

// A git repo with the claims scripts installed; tokens=null omits claims-tokens.json.
function makeRepo(name, tokens) {
  const repo = join(tmp, name);
  const sprint = join(repo, "scripts/sprint");
  mkdirSync(sprint, { recursive: true });
  for (const d of ["backlog", "in-progress", "done", "rejected"]) mkdirSync(join(repo, "docs/sprints", d), { recursive: true });
  for (const f of ["claims.mjs", "frontmatter.mjs", "lock.sh"]) copyFileSync(join(SRC, f), join(sprint, f));
  if (tokens) writeFileSync(join(sprint, "claims-tokens.json"), JSON.stringify({ tokens }));
  writeFileSync(join(repo, "Makefile"), "all:\n");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  return repo;
}
const sprintFile = (id, dir, touches, extra = "") =>
  `---\nsprint: ${id}\nstatus: ${dir}\ngoal: g\nstory_points: 1\ndepends_on: []\n${extra}touches:\n${touches.map((t) => `  - ${t}`).join("\n")}\n---\n\n# ${id}\n`;
function cli(repo, args, env = {}) {
  const r = spawnSync("node", [join(repo, "scripts/sprint/claims.mjs"), ...args], {
    cwd: repo, encoding: "utf8", env: { ...process.env, SPRINT_ROOT: repo, ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const TOKENS = { deps: ["package.json", "lockfile"], schema: ["db/schema.sql", "db/migrations/**"] };
const repo = makeRepo("repo", TOKENS);

// --- in-process: expand via claimsOverlap, computeWaves -----------------------
process.env.SPRINT_ROOT = repo; // repoRoot() for the root-path exemption
const { claimsOverlap, computeWaves } = await import(pathToFileURL(join(repo, "scripts/sprint/claims.mjs")).href);

let threw = null;
try { claimsOverlap("dpes", "package.json"); } catch (e) { threw = e; }
check("unknown token throws", threw !== null);
check("error names the token, the valid tokens and the tokens file",
  threw && /"dpes"/.test(threw.message) && /valid tokens: deps, schema/.test(threw.message) && /claims-tokens\.json/.test(threw.message),
  threw?.message);
threw = null;
try { claimsOverlap("db:schema", "x/y"); } catch (e) { threw = e; }
check("namespaced unknown token (a:b) throws", threw !== null);

let ok;
try { ok = claimsOverlap("Makefile", "Makefile") && !claimsOverlap("Makefile", "src/**"); } catch (e) { ok = e.message; }
check("existing root file `Makefile` is an exact-path claim, not an unknown token", ok === true, String(ok));
try { ok = claimsOverlap("scripts", "scripts"); } catch (e) { ok = e.message; }
check("existing root dir `scripts` is an exact-path claim", ok === true, String(ok));
check("defined token expands", claimsOverlap("deps", "package.json") && claimsOverlap("schema", "db/migrations/**"));
check("path / prefix claims pass through", claimsOverlap("src/a.ts", "src/**") && !claimsOverlap("src/a.ts", "src/b.ts"));

const waveIds = ({ waves }) => JSON.stringify(waves.map((w) => w.map((s) => s.sprint)));
const got = waveIds(computeWaves([
  { sprint: "S-5", dir: "backlog", touches: ["b.ts"] },
  { sprint: "S-10", dir: "backlog", touches: ["a.ts"] },
  { sprint: "S-20", dir: "in-progress", touches: ["a.ts"] },
  { sprint: "S-30", dir: "backlog", wave: "W-1", touches: ["b.ts"] },
  { sprint: "S-40", dir: "backlog", touches: ["c.ts"] },
]));
check("in-flight + reserved sprints pin Wave 1; overlapping lower-id backlog moves later",
  got === JSON.stringify([["S-20", "S-30", "S-40"], ["S-5", "S-10"]]), got);

// --- CLI: check / waves exit 2 on an unknown token ------------------------------
let r = cli(repo, ["check", "--paths", "dpes"]);
check("check --paths <unknown token> exits 2 with the message", r.code === 2 && /unknown claim token "dpes"/.test(r.err), JSON.stringify(r));
r = cli(repo, ["check", "--paths", "Makefile,src/**"]);
check("check --paths Makefile,src/** is FREE (exit 0)", r.code === 0 && /FREE/.test(r.out), JSON.stringify(r));

writeFileSync(join(repo, "docs/sprints/in-progress/S-1-a.md"), sprintFile("S-1", "in-progress", ["src/a.ts"]));
writeFileSync(join(repo, "docs/sprints/backlog/S-2-b.md"), sprintFile("S-2", "backlog", ["shcema"]));
r = cli(repo, ["waves"]);
check("waves exits 2 when a sprint carries an unknown token", r.code === 2 && /"shcema"/.test(r.err), JSON.stringify(r));
r = cli(repo, ["check", "--sprint", "S-2"]);
check("check --sprint with an unknown token in its touches exits 2", r.code === 2 && /"shcema"/.test(r.err), JSON.stringify(r));
rmSync(join(repo, "docs/sprints/backlog/S-2-b.md"));

// --- missing claims-tokens.json is reported as missing ----------------------------
const bare = makeRepo("bare", null);
r = cli(bare, ["check", "--paths", "deps"]);
check("missing claims-tokens.json: exit 2, says the file is missing",
  r.code === 2 && /claims-tokens\.json is missing/.test(r.err) && !/valid tokens/.test(r.err), JSON.stringify(r));
r = cli(bare, ["check", "--paths", "Makefile"]);
check("missing claims-tokens.json: a real root file still claims fine", r.code === 0, JSON.stringify(r));

// --- add: pushes only via ledger-push.sh, honours its exit codes -----------------
git(repo, "add", "-A");
git(repo, "commit", "-qm", "fixture sprints");
const stub = (code) =>
  writeFileSync(join(repo, "scripts/sprint/ledger-push.sh"),
    `#!/usr/bin/env bash\necho "$@" > "${join(tmp, "ledger-push.args")}"\nexit ${code}\n`);
const head = () => git(repo, "rev-parse", "HEAD").trim();

stub(3);
let before = head();
r = cli(repo, ["add", "S-1", "src/b.ts"], { SPRINT_MAIN_BRANCH: "trunk" });
check("add: ledger-push exit 3 → exit 3, committed locally, push withheld",
  r.code === 3 && /push withheld/.test(r.err) && /claimed for S-1: src\/b\.ts/.test(r.out) && head() !== before, JSON.stringify(r));
check("add: ledger-push.sh gets <root> <SPRINT_MAIN_BRANCH>",
  readFileSync(join(tmp, "ledger-push.args"), "utf8").trim() === `${repo} trunk`);
check("add: claim commit carries [skip ci]", /\[skip ci\]/.test(git(repo, "log", "-1", "--format=%s")));

stub(1);
before = head();
r = cli(repo, ["add", "S-1", "src/c.ts"]);
check("add: ledger-push exit 1 → exit 1, local claim commit kept", r.code === 1 && /push failed/.test(r.err) && head() !== before, JSON.stringify(r));

stub(0);
r = cli(repo, ["add", "S-1", "src/d.ts"]);
check("add: ledger-push exit 0 → exit 0", r.code === 0, JSON.stringify(r));

stub(1); // must not be called
r = cli(repo, ["add", "S-1", "src/e.ts", "--no-push"]);
check("add --no-push: skips ledger-push, prints the deferred notice", r.code === 0 && /push deferred/.test(r.out), JSON.stringify(r));

before = head();
r = cli(repo, ["add", "S-1", "dpes"]);
check("add: unknown token exits 2 and commits nothing", r.code === 2 && /"dpes"/.test(r.err) && head() === before, JSON.stringify(r));

const src = readFileSync(join(SRC, "claims.mjs"), "utf8");
check("claims.mjs has no raw git push", !/["']push["']/.test(src));

if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log("claims: all checks passed");
