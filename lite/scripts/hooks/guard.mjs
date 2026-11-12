#!/usr/bin/env node
// PreToolUse guard — the rules that used to be prose in agent definitions, enforced by the
// harness. Wired in .claude/settings.json for Bash, the file-editing tools and
// StructuredOutput; it fires for the main session AND for every subagent (including agents
// spawned by workflow scripts). Zero-dependency.
//
//   main-guard       (both tiers)  Bash: force-pushing or deleting the main branch.
//   claim-guard      (full tier)   Edit/Write/NotebookEdit/MultiEdit inside a sprint
//                                  worktree: only paths the sprint's `touches:` claims
//                                  (plus its own sprint file and evidence directory).
//   lifecycle-guard  (full tier)   Bash, subagents only: the lifecycle scripts, any
//                                  `git push`, and `git commit --no-verify` belong to the
//                                  orchestrator.
//   done-gate        (full tier)   StructuredOutput from a `sprint-executor` claiming DONE:
//                                  its Completion Log must pass close-check.mjs and its
//                                  worktree must be committed — refused up to 3 times so it
//                                  fixes the record in context, then let through (the
//                                  master's close-check and `land`'s lint are the backstop).
//
// "Full tier" means scripts/sprint/claims.mjs exists in the repo; without it those three
// guards have no opinion, so one settings.json serves both tiers.
//
// A guard is EARLY FEEDBACK, not the guarantee: a shell redirect can write a file no
// Edit hook sees, and command parsing is best-effort. The guarantee for claims is the
// diff-versus-claims check in `merge-sprint.sh land`. For the same reason this script
// FAILS OPEN — any internal error allows the action and prints a warning; it must never
// be the reason work stops.
//
// Input: the hook JSON on stdin. Output: a `permissionDecision: "deny"` JSON on stdout
// (exit 0), or exit 2 with the reason on stderr for the done-gate; silence = no opinion.
// Emergency off-switch: SPRINT_GUARD=off in the environment.
import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";

const MAIN = process.env.SPRINT_MAIN_BRANCH || "main";
const DONE_GATE_MAX_REFUSALS = 3;

function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
  process.exit(0);
}
const norm = (p) => String(p).replace(/\\/g, "/");

// ---------------------------------------------------------------- frontmatter (touches, wave)
function frontmatter(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  if (lines[0] !== "---") return {};
  const out = {};
  for (let i = 1; i < lines.length && lines[i] !== "---"; i++) {
    const m = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) continue;
    const [, key, raw] = m;
    const v = raw.replace(/\s#.*$/, "").trim();
    if (v.startsWith("[")) {
      out[key] = v.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    } else if (v === "") {
      const items = [];
      while (i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1])) items.push(lines[++i].replace(/^\s+-\s+/, "").replace(/\s#.*$/, "").trim().replace(/^["']|["']$/g, ""));
      out[key] = items;
    } else out[key] = v.replace(/^["']|["']$/g, "");
  }
  return out;
}
const sprintFilesIn = (dir, id) => (existsSync(dir) ? readdirSync(dir).filter((f) => (id ? f.startsWith(`${id}-`) : /^S-\d+-/.test(f)) && f.endsWith(".md")).map((f) => join(dir, f)) : []);

// ---------------------------------------------------------------- claim matching
function loadTokens(root) {
  try {
    return JSON.parse(readFileSync(join(root, "scripts/sprint/claims-tokens.json"), "utf8")).tokens ?? {};
  } catch {
    return {};
  }
}
// Same grammar as claims.mjs: exact path | `dir/**` prefix | token expanding to those.
function covered(rel, claims, tokens) {
  for (const claim of claims) {
    for (const pattern of tokens[claim] ?? [claim]) {
      if (pattern.endsWith("/**") ? rel.startsWith(pattern.slice(0, -2)) : rel === pattern) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- claim-guard
function claimGuard(input) {
  const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (typeof target !== "string") return;
  const m = norm(target).match(/^(.*)\/\.claude\/worktrees\/([^/]+)\/(.+)$/);
  if (!m) return; // not inside a worktree — no opinion
  const [, root, wt, rel] = m;
  if (!existsSync(join(root, "scripts/sprint/claims.mjs"))) return; // lite tier
  const isSubagent = Boolean(input.agent_id);

  // The wave's planning worktree: planners edit sprint files there and nothing else.
  if (/^wave-W-.+-plan$/.test(wt)) {
    if (/^docs\/sprints\/backlog\/S-\d+-[^/]+\.md$/.test(rel)) return;
    deny(`CLAIM-GUARD: ${rel} — the wave planning worktree holds sprint files only (docs/sprints/backlog/S-NNN-*.md). Planners never edit code or generated docs; record what you found in your sprint file's PLAN NOTES instead.`);
  }

  let ids;
  const single = wt.match(/^(S-\d+)(-|$)/);
  const train = wt.match(/^train-(W-.+)$/);
  if (single) ids = [single[1]];
  else if (train) {
    // A train worktree carries every started member of the wave; main's ledger says which.
    ids = sprintFilesIn(join(root, "docs/sprints/in-progress")).filter((f) => frontmatter(f).wave === train[1]).map((f) => basename(f).match(/^S-\d+/)[0]);
  } else return; // a worktree this workflow does not manage — no opinion
  if (ids.length === 0) return;

  // Always the sprint's own: its file and its evidence directory.
  for (const id of ids) {
    if (new RegExp(`^docs/sprints/in-progress/${id}-[^/]+\\.md$`).test(rel)) return;
    if (rel.startsWith(`docs/sprints/evidence/${id}/`)) return;
  }

  // Claims: main's copy is the ledger (`claims.mjs add` writes it first); the branch copy
  // may be newer or older by one mirror step, so honour the union of both.
  const claims = new Set();
  let found = false;
  for (const id of ids) {
    for (const base of [root, join(root, ".claude/worktrees", wt)]) {
      for (const f of sprintFilesIn(join(base, "docs/sprints/in-progress"), id)) {
        found = true;
        for (const t of frontmatter(f).touches ?? []) claims.add(t);
      }
    }
  }
  if (!found || claims.size === 0) return; // no manifest to enforce — the sprint runs unclaimed
  if (covered(rel, [...claims], loadTokens(root))) return;

  const who = ids.length === 1 ? `${ids[0]}'s` : `this train's (${ids.join(", ")})`;
  deny(
    isSubagent
      ? `CLAIM-GUARD: ${rel} is outside ${who} touches:. Do not edit it, and do not work around this with a shell command — another sprint may hold that file. Stop and return NEEDS_CLAIM naming this path; the orchestrator grants claims.`
      : `CLAIM-GUARD: ${rel} is outside ${who} touches:. Claim it first — \`node scripts/sprint/claims.mjs add ${ids[0]} ${rel}\` checks that no other in-flight sprint holds it — then mirror the addition in the branch copy of the sprint file and retry.`,
  );
}

// ---------------------------------------------------------------- shell parsing (best-effort)
// Split a command line into simple commands on && || ; | & and newlines, outside quotes.
// Command substitutions are returned as extra commands so a guard sees inside them.
function simpleCommands(cmd, depth = 0) {
  const out = [];
  let cur = "";
  let quote = null;
  const push = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = "";
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === "\\" && quote === '"' && i + 1 < cmd.length) cur += c + cmd[++i];
      else {
        if (c === quote) quote = null;
        cur += c;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
    } else if (c === "\\" && i + 1 < cmd.length) cur += c + cmd[++i];
    else if (c === "\n" || c === ";" || c === "|" || c === "&") {
      push();
      if ((c === "|" || c === "&") && cmd[i + 1] === c) i++;
    } else cur += c;
  }
  push();
  if (depth < 3) {
    for (const m of cmd.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) out.push(...simpleCommands(m[1] ?? m[2], depth + 1));
  }
  return out;
}
function words(simple) {
  const out = [];
  let cur = "";
  let has = false;
  let quote = null;
  for (let i = 0; i < simple.length; i++) {
    const c = simple[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < simple.length) cur += simple[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < simple.length) {
      cur += simple[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else cur += c;
  }
  if (has || cur) out.push(cur);
  return out;
}
// Drop leading env assignments and transparent wrappers; unwrap `bash -c '<script>'`.
function effective(simple, depth = 0) {
  let w = words(simple);
  for (;;) {
    while (w.length && /^[A-Za-z_]\w*=/.test(w[0])) w = w.slice(1);
    const head = basename(w[0] ?? "");
    if (["sudo", "command", "builtin", "nohup", "time", "nice", "exec", "env"].includes(head)) w = w.slice(1);
    else if (head === "timeout") w = w.slice(2);
    else break;
  }
  const head = basename(w[0] ?? "");
  if (["bash", "sh", "zsh", "dash"].includes(head) && depth < 3) {
    const c = w.indexOf("-c");
    if (c !== -1 && w[c + 1]) return simpleCommands(w[c + 1]).flatMap((s) => effective(s, depth + 1));
    if (w[1] && !w[1].startsWith("-")) return [w.slice(1)]; // `bash scripts/x.sh args`
  }
  return w.length ? [w] : [];
}
// For a `git …` word list: { sub, args, dir } with global options peeled off.
function gitCall(w) {
  if (basename(w[0] ?? "") !== "git") return null;
  let i = 1;
  let dir = null;
  while (i < w.length && w[i].startsWith("-")) {
    if (w[i] === "-C") {
      dir = w[i + 1];
      i += 2;
    } else if (w[i] === "-c" || w[i] === "--git-dir" || w[i] === "--work-tree" || w[i] === "--namespace") i += 2;
    else i++;
  }
  return { sub: w[i], args: w.slice(i + 1), dir };
}
function currentBranch(dir) {
  try {
    return execFileSync("git", [...(dir ? ["-C", dir] : []), "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- Bash guards
const LIFECYCLE = /(^|\/)scripts\/sprint\/(start|unstart|merge-sprint|lock|reserve-wave|push-main|assemble-train|ledger-push)\.sh$/;

function bashGuard(input, projectDir) {
  const command = input.tool_input?.command;
  if (typeof command !== "string" || !command.trim()) return;
  const isSubagent = Boolean(input.agent_id);
  const fullTier = existsSync(join(projectDir, "scripts/sprint/claims.mjs"));

  for (const simple of simpleCommands(command)) {
    for (const w of effective(simple)) {
      const git = gitCall(w);

      // main-guard — force-pushing or deleting the main branch, from anyone.
      if (git && git.sub === "push") {
        const flags = [];
        const positional = [];
        for (let k = 0; k < git.args.length; k++) {
          const a = git.args[k];
          if (!a.startsWith("-")) positional.push(a);
          else {
            flags.push(a);
            if (["-o", "--push-option", "--repo", "--receive-pack", "--exec"].includes(a)) k++; // takes a value
          }
        }
        const refspecs = positional.slice(1); // [remote, refspec…]
        const dst = (r) => r.replace(/^\+/, "").split(":").pop().replace(/^refs\/heads\//, "");
        const force = flags.some((f) => f === "--force" || f.startsWith("--force-with-lease") || f === "--force-if-includes" || (/^-[a-zA-Z]+$/.test(f) && f.includes("f"))) || refspecs.some((r) => r.startsWith("+"));
        const everything = flags.includes("--all") || flags.includes("--mirror");
        const deletesMain = (flags.includes("--delete") || flags.includes("-d")) ? refspecs.some((r) => dst(r) === MAIN) : refspecs.some((r) => r.startsWith(":") && dst(r) === MAIN);
        const targetsMain = refspecs.length ? refspecs.some((r) => dst(r) === MAIN) : currentBranch(git.dir) === MAIN;
        if (deletesMain) deny(`MAIN-GUARD: this deletes the remote ${MAIN} branch. Not allowed from a session — if it is truly intended, the user must run it themselves.`);
        if (force && (targetsMain || everything)) {
          deny(`MAIN-GUARD: force-pushing ${MAIN} rewrites shared history — every clone, the sprint ledger and (for a template repo) every downstream manifest pin its commits. Not allowed from a session. Fix forward with a new commit; if a rewrite is truly intended, the user must run it themselves.`);
        }
      }

      // lifecycle-guard — the orchestrator owns every mutation of main.
      if (isSubagent && fullTier) {
        // Only when the script is what RUNS — `cat scripts/sprint/start.sh` is just reading.
        const at = ["source", "."].includes(w[0]) ? 1 : 0;
        const script = LIFECYCLE.test(norm(w[at] ?? "")) ? w[at] : null;
        if (script) {
          const name = basename(script);
          const readOnly = name === "lock.sh" && w[at + 1] === "status";
          if (!readOnly) deny(`LIFECYCLE-GUARD: ${name} mutates main and belongs to the orchestrator. Do not run it. Return your status instead (DONE / BLOCKED / NEEDS_CLAIM / PLAN_GAP) and let the orchestrator act.`);
        }
        const claims = [0, 1].find((k) => /(^|\/)scripts\/sprint\/claims\.mjs$/.test(norm(w[k] ?? "")) && (k === 0 || basename(w[0]) === "node"));
        if (claims !== undefined && w[claims + 1] === "add") deny("LIFECYCLE-GUARD: `claims.mjs add` is a locked commit on main and belongs to the orchestrator. Return NEEDS_CLAIM with the path instead.");
        if (git && git.sub === "push") deny("LIFECYCLE-GUARD: subagents never push — pushes are settled by the orchestrator at the wave's checkpoints (push-main.sh). Commit on your branch and return your status.");
        if (git && git.sub === "commit" && git.args.some((a) => a === "--no-verify" || (/^-[a-zA-Z]+$/.test(a) && a.includes("n")))) {
          deny("LIFECYCLE-GUARD: `git commit --no-verify` skips the commit gate. Run scripts/sprint/gate.sh, fix what fails, and commit normally. If the gate itself is wrong, return BLOCKED with that as the question.");
        }
      }
    }
  }
}

// ---------------------------------------------------------------- done-gate
function doneGate(input, projectDir) {
  if (input.agent_type !== "sprint-executor") return;
  const out = input.tool_input ?? {};
  if (out.status !== "DONE" || typeof out.worktree !== "string") return;
  if (!existsSync(join(projectDir, "scripts/sprint/claims.mjs"))) return;
  const wt = out.worktree;
  const id = typeof out.sprint === "string" && /^S-\d+$/.test(out.sprint) ? out.sprint : (basename(norm(wt)).match(/^S-\d+/) ?? [])[0];
  if (!id) return;
  const files = sprintFilesIn(join(wt, "docs/sprints/in-progress"), id);
  if (files.length !== 1) return; // cannot locate the record — the master's check will

  const problems = [];
  try {
    execFileSync("node", [join(projectDir, "scripts/sprint/close-check.mjs"), files[0]], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    if (e.status === 5) problems.push(...String(e.stdout ?? "").split("\n").filter((l) => l.startsWith("FAIL ")).slice(0, 15));
    else return; // the lint itself broke — not the executor's problem
  }
  try {
    const dirty = execFileSync("git", ["-C", wt, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (dirty) problems.push(`uncommitted changes in the worktree:\n${dirty.split("\n").slice(0, 10).join("\n")}`);
  } catch {
    /* not a git worktree we can read — skip this half */
  }
  if (problems.length === 0) return;

  // Bounded: refuse at most N times per agent, then let it through with the record as is.
  const stateDir = join(projectDir, ".claude/sprint-orchestration/.done-gate");
  const stateFile = join(stateDir, String(input.agent_id ?? "main").replace(/[^\w-]/g, "_"));
  let refusals = 0;
  try {
    refusals = Number(readFileSync(stateFile, "utf8")) || 0;
  } catch {
    /* first refusal */
  }
  if (refusals >= DONE_GATE_MAX_REFUSALS) return;
  try {
    mkdirSync(stateDir, { recursive: true });
    const ignore = join(projectDir, ".claude/sprint-orchestration/.gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
    writeFileSync(stateFile, String(refusals + 1));
  } catch {
    return; // cannot keep count — refusing without a bound could loop, so do not refuse
  }
  process.stderr.write(
    `DONE-GATE (${refusals + 1}/${DONE_GATE_MAX_REFUSALS}): ${id} is not DONE yet — its record would be refused at land.\n${problems.join("\n")}\n` +
      `Fix the Completion Log in ${files[0]} per docs/sprints/SPRINT_TEMPLATE.md, commit (\`${id}: completion log\`), then return DONE again. ` +
      `If a criterion genuinely cannot be evidenced, leave it unchecked and return BLOCKED with that as the question.\n`,
  );
  process.exit(2);
}

// ---------------------------------------------------------------- main
if (process.env.SPRINT_GUARD === "off") process.exit(0);
try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const tool = input.tool_name;
  if (tool === "Bash") bashGuard(input, projectDir);
  else if (tool === "StructuredOutput") doneGate(input, projectDir);
  else if (["Edit", "Write", "NotebookEdit", "MultiEdit"].includes(tool)) claimGuard(input);
} catch (e) {
  process.stderr.write(`guard.mjs: internal error, allowing the action (${e.message})\n`);
}
process.exit(0);
