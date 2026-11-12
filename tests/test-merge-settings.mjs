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

  // ---- hooks + env (v1.12.0) ------------------------------------------------------
  // Regression: every top-level key other than `permissions` was copied only when the
  // downstream file lacked it. Any repo that already had `env` (bootstrap writes
  // env.SPRINT_MAIN_BRANCH for non-`main` default branches) or `hooks` never received
  // the template's — so shipped hooks would have silently never run there.
  const fail = (msg) => { console.error(msg); process.exit(1); };
  const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) fail(`${msg}\n  got:      ${JSON.stringify(a)}\n  expected: ${JSON.stringify(b)}`); };
  const merge = (existingObj, incomingObj) => {
    const dir = mkdtempSync(join(tmpdir(), "ms2-"));
    try {
      mkdirSync(join(dir, ".claude"), { recursive: true });
      if (existingObj !== null) writeFileSync(join(dir, ".claude/settings.json"), JSON.stringify(existingObj));
      writeFileSync(join(dir, "in.json"), JSON.stringify(incomingObj));
      const once = () => {
        execFileSync("node", [upgradeScript, "merge-settings", "--new", join(dir, "in.json"), "--repo-root", dir], { stdio: "pipe" });
        return JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8"));
      };
      const first = once();
      const second = once(); // idempotency: a second upgrade must change nothing
      eq(second, first, "merge-settings is not idempotent (second run changed the file)");
      return first;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const guard = (matcher) => ({ matcher, hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR"/scripts/hooks/guard.mjs', timeout: 10 }] });
  const userHook = { matcher: "Bash", hooks: [{ type: "command", command: "./my/own-check.sh" }] };
  const tmpl = { hooks: { PreToolUse: [guard("^(Bash|Edit)$")], SubagentStop: [guard("")] }, env: { A: "tmpl", B: "tmpl" } };

  // absent file → created verbatim
  eq(merge(null, tmpl), tmpl, "absent settings.json should be created from the template");

  // no hooks/env downstream → both arrive
  let m = merge({ permissions: { allow: ["x"] } }, tmpl);
  eq(m.hooks, tmpl.hooks, "hooks should arrive when downstream has none");
  eq(m.env, tmpl.env, "env should arrive when downstream has none");
  eq(m.permissions, { allow: ["x"] }, "permissions untouched when the template ships none");

  // downstream already has hooks + env (the case that used to drop everything)
  m = merge({ hooks: { PreToolUse: [userHook], Stop: [userHook] }, env: { SPRINT_MAIN_BRANCH: "master", A: "mine" } }, tmpl);
  eq(m.hooks.PreToolUse, [userHook, guard("^(Bash|Edit)$")], "template hook must be appended after the repo's own PreToolUse hook");
  eq(m.hooks.Stop, [userHook], "an event only the repo uses is kept untouched");
  eq(m.hooks.SubagentStop, [guard("")], "an event only the template uses arrives");
  eq(m.env, { A: "mine", B: "tmpl", SPRINT_MAIN_BRANCH: "master" }, "env merges per key; the repo's value wins on conflict");

  // a CHANGED template hook replaces its old self instead of leaving a stale twin
  m = merge({ hooks: { PreToolUse: [userHook, guard("^(Bash)$")] } }, tmpl);
  eq(m.hooks.PreToolUse, [userHook, guard("^(Bash|Edit)$")], "an outdated template-owned group must be replaced, not duplicated");

  // a template hook DROPPED upstream is removed downstream; the repo's own stay
  m = merge({ hooks: { PreToolUse: [guard("^(Bash)$")], Notification: [guard("x"), userHook] } }, { hooks: {} });
  eq(m.hooks, { Notification: [userHook] }, "template-owned groups the template no longer ships must be removed");

  // a group mixing a repo handler with a template script is the repo's — never touched
  const mixed = { matcher: "Bash", hooks: [{ type: "command", command: "./mine.sh" }, { type: "command", command: "node scripts/hooks/guard.mjs" }] };
  m = merge({ hooks: { PreToolUse: [mixed] } }, tmpl);
  eq(m.hooks.PreToolUse, [mixed, guard("^(Bash|Edit)$")], "a mixed group belongs to the repo and is preserved");

  // same group, different key order → not duplicated
  const reordered = { hooks: [{ timeout: 10, command: 'node "$CLAUDE_PROJECT_DIR"/scripts/hooks/guard.mjs', type: "command" }], matcher: "^(Bash|Edit)$" };
  m = merge({ hooks: { PreToolUse: [reordered] } }, tmpl);
  if (m.hooks.PreToolUse.length !== 1) fail(`key order must not defeat de-duplication: ${JSON.stringify(m.hooks.PreToolUse)}`);

  // other top-level keys keep copy-if-absent semantics
  m = merge({ model: "mine" }, { model: "tmpl", outputStyle: "x" });
  eq([m.model, m.outputStyle], ["mine", "x"], "other keys: keep the repo's, add missing ones");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log("PASS test-merge-settings.mjs");
process.exit(0);
