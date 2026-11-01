#!/usr/bin/env node
// Regression: `touches: ["src/a.ts", "docs/x/**"]` (the inline form /plan wrote)
// kept the quote characters in every item, so claims.mjs compared `"src/a.ts"`
// with `src/a.ts` and reported FREE for a real overlap. Pins: inline and block
// array items are unquoted like scalars, and `claims.mjs check` sees a quoted
// in-flight manifest end to end.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SRC = new URL("../full-overlay/scripts/sprint/", import.meta.url).pathname;
const { parseFrontmatter } = await import(new URL("frontmatter.mjs", `file://${SRC}`));
// realpath: claims.mjs runs its CLI only when argv[1] is its real path (macOS /var symlink).
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "frontmatter-")));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

let failed = 0;
const check = (label, cond, extra = "") => {
  if (!cond) { failed++; console.error(`FAIL ${label}${extra ? `\n${extra}` : ""}`); }
};
const fields = (body) => parseFrontmatter(`---\n${body}\n---\n`).fields;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

for (const [label, body, key, want] of [
  ["double-quoted inline", 'touches: ["src/a.ts", "docs/x/**"]', "touches", ["src/a.ts", "docs/x/**"]],
  ["single-quoted inline", "touches: ['src/a.ts', 'deps']", "touches", ["src/a.ts", "deps"]],
  ["mixed + comment", "touches: [\"a.ts\", b.ts, 'c.ts']  # note", "touches", ["a.ts", "b.ts", "c.ts"]],
  ["bare inline unchanged", "depends_on: [S-006, S-007]", "depends_on", ["S-006", "S-007"]],
  ["empty inline", "touches: []", "touches", []],
  ["quoted block items", "touches:\n  - \"src/a.ts\"\n  - 'deps'\n  - c.ts  # note", "touches", ["src/a.ts", "deps", "c.ts"]],
]) {
  const got = fields(body)[key];
  check(label, same(got, want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// End to end: a quoted in-flight manifest must block an overlapping path.
const repo = join(tmp, "repo");
const sprint = join(repo, "scripts/sprint");
mkdirSync(sprint, { recursive: true });
for (const d of ["backlog", "in-progress", "done", "rejected"]) mkdirSync(join(repo, "docs/sprints", d), { recursive: true });
for (const f of ["claims.mjs", "frontmatter.mjs", "lock.sh"]) copyFileSync(join(SRC, f), join(sprint, f));
writeFileSync(join(sprint, "claims-tokens.json"), JSON.stringify({ tokens: {} }));
writeFileSync(
  join(repo, "docs/sprints/in-progress/S-1-quoted.md"),
  '---\nsprint: S-1\nstatus: in-progress\ndepends_on: []\ntouches: ["src/a.ts", "docs/x/**"]\n---\n# S-1\n',
);
execFileSync("git", ["init", "-q", "-b", "main", repo]);
const claims = (paths) =>
  spawnSync("node", [join(sprint, "claims.mjs"), "check", "--paths", paths], { cwd: repo, encoding: "utf8", env: { ...process.env, SPRINT_ROOT: repo } });
let r = claims("src/a.ts");
check("exact overlap with quoted claim", r.status === 2, r.stdout + r.stderr);
r = claims("docs/x/y.md");
check("subtree overlap with quoted claim", r.status === 2, r.stdout + r.stderr);
r = claims("src/b.ts");
check("unrelated path free", r.status === 0, r.stdout + r.stderr);

process.exit(failed ? 1 : 0);
