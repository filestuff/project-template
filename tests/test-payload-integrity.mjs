#!/usr/bin/env node
// Whole-payload guards — the failures here never show up in a single file's own test:
//   1. Leftover tokens. `upgrade.mjs render` exits 3 on any `{{…}}` that is not a declared
//      placeholder, in ANY text file (a JS object literal or a shell `${{…}}` counts), so
//      one stray token makes every downstream install and upgrade fail.
//   2. Dangling references. A skill, agent or doc that tells Claude to run
//      `scripts/sprint/<x>` or to dispatch `.claude/agents/<x>.md` that the payload does
//      not ship fails silently at run time, in someone else's repo.
//   3. Tier parity of the three files full-overlay shadows: a rule added to the lite copy
//      and forgotten in the overlay never reaches a full install.
//   4. Exec bits: every shell script in the payload is committed executable.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const check = (c, m) => { if (!c) { failed++; console.error(`FAIL ${m}`); } };

const walk = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const TIERS = ["lite", "full-overlay"];
const files = TIERS.flatMap((t) => walk(join(REPO, t)));
const isText = (p) => !/\.(png|jpg|jpeg|gif|ico|pdf|zip|gz|woff2?)$/i.test(p);
const config = JSON.parse(readFileSync(join(REPO, "template.config.json"), "utf8"));
const known = new Set(Object.keys(config.placeholders));

// 1. leftover tokens
for (const f of files.filter(isText)) {
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(/\{\{[^}]*\}\}/g)) {
    if (!known.has(m[0])) {
      const line = text.slice(0, m.index).split("\n").length;
      check(false, `${relative(REPO, f)}:${line}: undeclared token ${m[0]} — render would exit 3`);
    }
  }
}

// 2. dangling references (resolved against the union of both tiers = a full install)
const shipped = (rel) => TIERS.some((t) => existsSync(join(REPO, t, rel)));
const docs = files.filter((f) => /\.(md|mjs|sh|json)$/.test(f));
for (const f of docs) {
  const text = readFileSync(f, "utf8");
  const rel = relative(REPO, f);
  for (const m of text.matchAll(/(?<![\w/.-])(scripts\/(?:sprint|template|hooks)\/[\w./-]+\.(?:mjs|sh|json))/g)) {
    // `scripts/sprint/*.sh` style globs and <placeholder> paths are not references.
    if (/[*<>]/.test(m[1])) continue;
    check(shipped(m[1]), `${rel}: references ${m[1]}, which neither tier ships`);
  }
  for (const m of text.matchAll(/\.claude\/agents\/([\w-]+)\.md/g)) check(shipped(`.claude/agents/${m[1]}.md`), `${rel}: references .claude/agents/${m[1]}.md, which neither tier ships`);
  for (const m of text.matchAll(/\.claude\/workflows\/([\w-]+)\.(m?js)/g)) check(shipped(`.claude/workflows/${m[1]}.${m[2]}`), `${rel}: references .claude/workflows/${m[1]}.${m[2]}, which neither tier ships`);
  // Saved workflows are found by name only as `.js` (a `.mjs` there is invisible).
  for (const m of text.matchAll(/Workflow\(\{\s*name:\s*"([\w-]+)"/g)) check(shipped(`.claude/workflows/${m[1]}.js`), `${rel}: invokes saved workflow "${m[1]}", but neither tier ships .claude/workflows/${m[1]}.js`);
  for (const m of text.matchAll(/"Workflow\(([\w-]+)\)"/g)) check(shipped(`.claude/workflows/${m[1]}.js`), `${rel}: allows Workflow(${m[1]}), but neither tier ships .claude/workflows/${m[1]}.js`);
}
// A lite-only install must not be told to run something only the overlay ships, unless
// the sentence is explicitly full-tier. Checked for the lite skills and agents.
for (const f of files.filter((f) => f.includes(`${join("lite", ".claude")}`) && f.endsWith(".md"))) {
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/`[^`]*?(scripts\/sprint\/[\w.-]+\.(?:mjs|sh))[^`]*`/g)) {
      if (existsSync(join(REPO, "lite", m[1]))) continue;
      const context = lines.slice(Math.max(0, i - 6), i + 1).join(" ");
      check(/full tier|full-tier|if .{0,40}exists|only if/i.test(context), `${relative(REPO, f)}:${i + 1}: lite file runs ${m[1]} (full-tier only) without a full-tier guard nearby`);
    }
  });
}

// 3. tier parity for shadowed files — each must mention the same mechanisms.
const SHADOWED = { ".claude/skills/sprint/SKILL.md": ["plan-check.mjs", "brief-auditor", "close-check.mjs"], "docs/sprints/PROTOCOL.md": ["learnings.mjs", "close-check.mjs", "PLANNING_LEARNINGS.md"] };
for (const [rel, needles] of Object.entries(SHADOWED)) {
  for (const t of TIERS) {
    const p = join(REPO, t, rel);
    check(existsSync(p), `${t}/${rel} is missing (expected in both tiers)`);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    for (const n of needles) check(text.includes(n), `${t}/${rel}: does not mention ${n} (the other tier's copy does — shadowed files must stay in step)`);
  }
}

// 4. exec bits (git mode, since that is what reaches a clone)
const modes = execFileSync("git", ["-C", REPO, "ls-files", "-s", "--", ...TIERS], { encoding: "utf8" }).trim().split("\n");
for (const l of modes) {
  const [mode, , , path] = l.split(/\s+/);
  if (path.endsWith(".sh")) check(mode === "100755", `${path}: shell script committed with mode ${mode}, expected 100755`);
}

if (failed) { console.error(`test-payload-integrity: ${failed} check(s) failed`); process.exit(1); }
console.log(`test-payload-integrity: all checks passed (${files.length} files)`);
