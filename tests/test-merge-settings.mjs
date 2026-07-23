#!/usr/bin/env node
// Regression: merge-settings unioned only permissions.allow. New DENY/ASK
// entries shipped by the template were dropped — for a security-relevant
// field that is the wrong direction to fail in.
//
// merge-settings reads existing settings from <repo-root>/.claude/settings.json
// and the incoming (rendered) settings from --new; see upgrade.mjs's
// `merge-settings --new <rendered-settings.json> [--repo-root <path>]` usage.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const upgradeScript = join(repo, "lite/scripts/template/upgrade.mjs");

const tmp = mkdtempSync(join(tmpdir(), "ms-"));
try {
  const claudeDir = join(tmp, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const existing = join(claudeDir, "settings.json");
  const incoming = join(tmp, "new-settings.json");
  writeFileSync(existing, JSON.stringify({ permissions: { allow: ["Bash(ls:*)"], deny: ["Read(.env)"] } }));
  writeFileSync(incoming, JSON.stringify({ permissions: { allow: ["Bash(git status:*)"], deny: ["Read(.env.*)"], ask: ["Bash(git push:*)"] } }));

  execFileSync("node", [upgradeScript, "merge-settings", "--new", incoming, "--repo-root", tmp], { stdio: "pipe" });

  const merged = JSON.parse(readFileSync(existing, "utf8"));
  const must = [
    ["allow", "Bash(ls:*)"], ["allow", "Bash(git status:*)"],
    ["deny", "Read(.env)"], ["deny", "Read(.env.*)"],
    ["ask", "Bash(git push:*)"],
  ];
  for (const [list, perm] of must) {
    if (!merged.permissions?.[list]?.includes(perm)) {
      console.error(`missing permissions.${list} entry: ${perm}`);
      process.exit(1);
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log("PASS test-merge-settings.mjs");
process.exit(0);
