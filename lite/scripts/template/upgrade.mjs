#!/usr/bin/env node
// Template-upgrade merge engine. Runs INSIDE a downstream repo (copied payload —
// placeholder-free by design: this file must never contain a literal doubled-brace
// token, or render's own leftover-token check flags it; brace pairs appear only
// escaped inside regexes, never as adjacent literal characters).
// Node >=18 built-ins only (node:fs, node:path, node:child_process, node:crypto, node:os).
//
// Subcommands:
//   upgrade.mjs fetch <sha-or-ref> <outdir> [--repo <url-or-path>]
//     Fetch a template version's tree into <outdir>. Local path / file:// → `git archive`;
//     https GitHub URL → shallow `git fetch` into a throwaway bare repo, then `git archive`
//     (works for private repos via the user's credential helper/SSH). Verifies
//     <outdir>/VERSION exists.
//
//   upgrade.mjs render <templateDir> --manifest <path> --out <dir>
//     Render the manifest tier's file set from <templateDir>, substituting every stored
//     placeholder token everywhere (see DECISION 1 below). Writes rendered files under
//     --out, and two sidecars next to it (NOT inside the render tree, so `plan` never
//     mistakes them for dest files): `<out>/../claude-block.md` (rendered
//     CLAUDE.project-block.md, for merge-claude-block) and `<out>/../template.config.json`
//     + `<out>/../VERSION` (copied verbatim from templateDir, so `plan`/`apply` can find
//     the new tier's fileClasses/postCopy/version without new CLI args — see DECISION 2).
//     Exit 3 if any doubled-brace token survives rendering that isn't a known placeholder.
//
//   upgrade.mjs plan --old <renderDir> --new <renderDir> --manifest <path> [--repo-root <path>]
//     Classify every dest file in old ∪ new against the local working tree. Writes JSON to
//     stdout and to `<git-dir>/template-update/plan.json`; human summary to stderr.
//
//   upgrade.mjs apply --plan <plan.json> --old <renderDir> --new <renderDir> --manifest <path> [--only <dest>]
//     Apply the plan: clean overwrites, three-way merges (git merge-file), added/removed
//     reporting. Journal-based resumability (see DECISION 3). Updates the manifest.
//
//   upgrade.mjs merge-claude-block --rendered <claude-block.md> [--repo-root <path>]
//     Replace the marked block in CLAUDE.md with the rendered project block.
//
//   upgrade.mjs merge-settings --new <rendered-settings.json> [--repo-root <path>]
//     Union permissions.allow/deny/ask, preserve all other existing keys/values.
//
//   upgrade.mjs hash <file>
//     Print sha256 hex of a file.
//
// Exit codes: 0 ok · 1 error · 2 conflicts-present · 3 needs-input/missing-markers
//
// DECISIONS (documented per the plan's explicit ask):
//   1. Placeholder substitution: rather than resolving each token's `files` list from
//      template.config.json, we substitute every stored placeholder (from the downstream
//      manifest) in every text file, unconditionally. This is deterministic, idempotent,
//      and matches what bootstrap effectively produces (a file either contains a token and
//      gets it replaced, or doesn't and is untouched). Binary files (detected by a NUL byte
//      in the first 8000 bytes) are copied byte-for-byte, never scanned/substituted.
//   2. Sidecars: `render` writes `template.config.json` and `VERSION` from the NEW
//      templateDir next to `--out` (i.e. `dirname(out)/template.config.json`), not inside
//      the rendered tree. `plan --new <dir>` and `apply --new <dir>` read them from
//      `dirname(newRenderDir)/...`. This keeps `plan`'s dest-file walk (old ∪ new) free of
//      spurious "added" entries for the config file itself, while still letting apply pick
//      up `postCopy` chmod globs and the new version/commit without extra required args.
//   3. Conflict journaling: a three-way merge that produces conflicts IS journaled (the
//      merge runs exactly once, whether it lands clean or with markers). It's reported in
//      the apply summary under `conflicts` (needs-resolution) and exit 2 is returned; the
//      working file is left with standard <<<<<<< markers. Journaling it means a re-run of
//      `apply` never touches the file again — `git merge-file` is NOT idempotent against a
//      hand-edited local file (re-running it against the original old/new bases after the
//      user has resolved markers re-diffs stale content and can re-conflict or corrupt the
//      resolution), so retrying it automatically is unsafe. Resolution happens out-of-band:
//      the user edits the markers directly and commits; a fresh `plan`/`apply` pass (not a
//      replay of the same plan.json) is how further template changes reach that file later.

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync,
  chmodSync, rmSync, copyFileSync, mkdtempSync,
} from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

// --- generic helpers ---------------------------------------------------------

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function walkFiles(root) {
  const out = [];
  (function rec(dir) {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) rec(abs);
      else out.push(abs);
    }
  })(root);
  return out.map((abs) => ({ abs, rel: relative(root, abs).split(sep).join("/") }));
}

function isExecutable(path) {
  try {
    const mode = statSync(path).mode;
    return (mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function mkdirpFor(filePath) {
  mkdirSync(dirname(filePath), { recursive: true });
}

function readJSON(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJSON(path, obj) {
  mkdirpFor(path);
  writeFileSync(path, `${JSON.stringify(obj, null, 2)}\n`);
}

function gitDir(repoRoot) {
  return execFileSync("git", ["-C", repoRoot, "rev-parse", "--git-dir"], {
    encoding: "utf8",
  }).trim();
}

function parseArgs(argv) {
  const args = { positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args.flags[key] = true;
      } else {
        args.flags[key] = next;
        i++;
      }
    } else {
      args.positional.push(a);
    }
  }
  return args;
}

const CLAUDE_BLOCK_BEGIN = "<!-- BEGIN project-template -->";
const CLAUDE_BLOCK_END = "<!-- END project-template -->";
const SPECIAL_CLAUDE_BLOCK_SRC_SUFFIX = "CLAUDE.project-block.md";

// --- manifest helpers ---------------------------------------------------------

function loadManifest(path) {
  if (!existsSync(path)) die(`manifest not found: ${path}`, 1);
  return readJSON(path);
}

function saveManifest(path, manifest) {
  writeJSON(path, manifest);
}

// --- fetch ---------------------------------------------------------------

// Shared by both fetch branches: extract a `git archive` tar stream into outdir.
function extractArchive(archive, outdir) {
  execFileSync("tar", ["-x", "-C", outdir], { input: archive });
}

function cmdFetch(argv) {
  const args = parseArgs(argv);
  const [ref, outdir] = args.positional;
  if (!ref || !outdir) die("usage: upgrade.mjs fetch <sha-or-ref> <outdir> [--repo <url-or-path>]", 1);

  let repo = args.flags.repo;
  if (!repo) {
    const manifestPath = existsSync(".claude/template-manifest.json")
      ? ".claude/template-manifest.json"
      : null;
    if (manifestPath) {
      const manifest = loadManifest(manifestPath);
      repo = manifest?.template?.repo;
    }
  }
  if (!repo) die("no --repo given and none found in .claude/template-manifest.json", 1);

  mkdirSync(outdir, { recursive: true });

  const isLocal = repo.startsWith("file://") || (!repo.startsWith("http://") && !repo.startsWith("https://"));

  try {
    if (isLocal) {
      const localPath = repo.startsWith("file://") ? repo.slice("file://".length) : repo;
      // git archive <sha> | tar -x -C <outdir>
      const archive = execFileSync("git", ["-C", localPath, "archive", ref], {
        maxBuffer: 1024 * 1024 * 512,
      });
      extractArchive(archive, outdir);
    } else {
      // Private-repo-capable fetch: shallow-fetch the pinned ref into a throwaway
      // bare repo using the user's git credentials, then reuse the local branch's
      // git-archive extraction path above. The old codeload tarball URL served
      // nothing for private repos without a token. GitHub allows fetching pinned
      // SHAs directly (uploadpack.allowReachableSHA1InWant); a SHA gone after a
      // history rewrite still fails cleanly into the documented degraded mode.
      const bare = mkdtempSync(join(tmpdir(), "tpl-fetch-"));
      try {
        execFileSync("git", ["-C", bare, "init", "-q", "--bare"], { stdio: "pipe" });
        execFileSync("git", ["-C", bare,
          "-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=15",
          "fetch", "-q", "--depth=1", repo, ref],
          { stdio: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
        const archive = execFileSync("git", ["-C", bare, "archive", "FETCH_HEAD"], {
          maxBuffer: 1024 * 1024 * 512,
        });
        extractArchive(archive, outdir);
      } finally {
        rmSync(bare, { recursive: true, force: true });
      }
    }
  } catch (e) {
    die(`fetch failed for ${ref} from ${repo}: ${e.message}`, 1);
  }

  const versionFile = join(outdir, "VERSION");
  if (!existsSync(versionFile)) die(`fetch succeeded but ${versionFile} is missing`, 1);
  const version = readFileSync(versionFile, "utf8").trim();
  console.log(`fetched ${ref} -> ${outdir} (VERSION ${version})`);
}

// --- render ---------------------------------------------------------------

// Resolve the manifest tier's copy-source dirs, in overwrite order.
function tierCopyDirs(templateConfig, tier) {
  const tiers = templateConfig.tiers || {};
  const entry = tiers[tier];
  if (!entry || !Array.isArray(entry.copy)) {
    die(`template.config.json has no tiers.${tier}.copy list`, 1);
  }
  return entry.copy;
}

// Build the dest-path -> source-abs-path map for the tier, later dirs overwrite earlier.
function resolveTierFileSet(templateDir, templateConfig, tier) {
  const dirs = tierCopyDirs(templateConfig, tier);
  const map = new Map(); // dest -> { abs, tierPrefix }
  for (const prefix of dirs) {
    const abs = join(templateDir, prefix);
    if (!existsSync(abs)) continue;
    for (const { abs: fileAbs, rel } of walkFiles(abs)) {
      if (rel.endsWith(SPECIAL_CLAUDE_BLOCK_SRC_SUFFIX)) continue; // never a normal dest file
      map.set(rel, { abs: fileAbs });
    }
  }
  return map;
}

// Find CLAUDE.project-block.md within the tier's copy dirs (searched in order).
function findClaudeBlockSource(templateDir, templateConfig, tier) {
  const dirs = tierCopyDirs(templateConfig, tier);
  for (const prefix of dirs) {
    const candidate = join(templateDir, prefix, SPECIAL_CLAUDE_BLOCK_SRC_SUFFIX);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function substitutePlaceholders(text, placeholders) {
  let out = text;
  for (const [token, value] of Object.entries(placeholders)) {
    out = out.split(token).join(value);
  }
  return out;
}

function findLeftoverTokens(text, placeholders) {
  const known = new Set(Object.keys(placeholders));
  const found = new Set();
  const re = /\{\{[^}]*\}\}/g;
  for (const m of text.matchAll(re)) {
    if (!known.has(m[0])) found.add(m[0]);
  }
  return [...found];
}

function cmdRender(argv) {
  const args = parseArgs(argv);
  const [templateDir] = args.positional;
  const manifestPath = args.flags.manifest;
  const outDir = args.flags.out;
  if (!templateDir || !manifestPath || !outDir) {
    die("usage: upgrade.mjs render <templateDir> --manifest <path> --out <dir>", 1);
  }

  const configPath = join(templateDir, "template.config.json");
  if (!existsSync(configPath)) die(`template.config.json not found in ${templateDir}`, 1);
  const templateConfig = readJSON(configPath);

  const manifest = loadManifest(manifestPath);
  const tier = manifest.tier;
  if (!tier) die(`manifest ${manifestPath} has no "tier"`, 1);
  const placeholders = manifest.placeholders || {};

  const fileSet = resolveTierFileSet(templateDir, templateConfig, tier);

  const leftovers = []; // { file, tokens }
  for (const [dest, { abs }] of fileSet) {
    const outPath = join(outDir, dest);
    const buf = readFileSync(abs);
    if (isBinary(buf)) {
      mkdirpFor(outPath);
      copyFileSync(abs, outPath);
    } else {
      const text = buf.toString("utf8");
      const rendered = substitutePlaceholders(text, placeholders);
      const remaining = findLeftoverTokens(rendered, placeholders);
      if (remaining.length > 0) leftovers.push({ file: dest, tokens: remaining });
      mkdirpFor(outPath);
      writeFileSync(outPath, rendered);
    }
    if (isExecutable(abs)) chmodSync(outPath, 0o755);
  }

  // Sidecars next to --out (see DECISION 2) — never inside the rendered tree.
  // parentDir == dirname(outDir) once trailing slashes are stripped.
  const parentDir = dirname(outDir.replace(/\/+$/, ""));
  copyFileSync(configPath, join(parentDir, "template.config.json"));
  const versionSrc = join(templateDir, "VERSION");
  if (existsSync(versionSrc)) copyFileSync(versionSrc, join(parentDir, "VERSION"));

  const blockSrc = findClaudeBlockSource(templateDir, templateConfig, tier);
  if (blockSrc) {
    const blockText = readFileSync(blockSrc, "utf8");
    const renderedBlock = substitutePlaceholders(blockText, placeholders);
    const remaining = findLeftoverTokens(renderedBlock, placeholders);
    if (remaining.length > 0) leftovers.push({ file: SPECIAL_CLAUDE_BLOCK_SRC_SUFFIX, tokens: remaining });
    writeFileSync(join(parentDir, "claude-block.md"), renderedBlock);
  }

  if (leftovers.length > 0) {
    console.error("unresolved placeholder tokens found after substitution:");
    for (const { file, tokens } of leftovers) {
      console.error(`  ${file}: ${tokens.join(", ")}`);
    }
    process.exit(3);
  }

  console.log(`rendered ${fileSet.size} file(s) for tier "${tier}" -> ${outDir}`);
}

// --- plan ---------------------------------------------------------------

function classOf(dest, manifest, templateConfig) {
  const entry = manifest.files?.[dest];
  if (entry?.ignored) return "ignored";
  const fc = templateConfig?.fileClasses;
  if (fc) {
    if (Array.isArray(fc.seeded) && fc.seeded.includes(dest)) return "seeded";
    if (fc.merged && Object.hasOwn(fc.merged, dest)) return "merged";
  }
  if (entry?.class) return entry.class;
  return "managed";
}

function cmdPlan(argv) {
  const args = parseArgs(argv);
  const oldDir = args.flags.old;
  const newDir = args.flags.new;
  const manifestPath = args.flags.manifest;
  const repoRoot = args.flags["repo-root"] || process.cwd();
  if (!oldDir || !newDir || !manifestPath) {
    die("usage: upgrade.mjs plan --old <renderDir> --new <renderDir> --manifest <path> [--repo-root <path>]", 1);
  }

  const manifest = loadManifest(manifestPath);

  // New-render sidecar template.config.json (see DECISION 2).
  const newParent = dirname(newDir.replace(/\/+$/, ""));
  const newConfigPath = join(newParent, "template.config.json");
  const newTemplateConfig = existsSync(newConfigPath) ? readJSON(newConfigPath) : {};
  const newVersionPath = join(newParent, "VERSION");
  const newVersion = existsSync(newVersionPath) ? readFileSync(newVersionPath, "utf8").trim() : null;

  const oldFiles = existsSync(oldDir) ? new Map(walkFiles(oldDir).map((f) => [f.rel, f.abs])) : new Map();
  const newFiles = existsSync(newDir) ? new Map(walkFiles(newDir).map((f) => [f.rel, f.abs])) : new Map();

  const allDest = new Set([...oldFiles.keys(), ...newFiles.keys()]);
  const entries = [];

  for (const dest of allDest) {
    const cls = classOf(dest, manifest, newTemplateConfig);
    if (cls === "ignored" || cls === "seeded" || cls === "merged" || cls === "merged-json" || cls === "merged-block") {
      continue; // handled by dedicated flows / never auto-plan-merged here
    }

    const localPath = join(repoRoot, dest);
    const localExists = existsSync(localPath);
    const inOld = oldFiles.has(dest);
    const inNew = newFiles.has(dest);
    const execBit = inNew
      ? isExecutable(newFiles.get(dest))
      : inOld
        ? isExecutable(oldFiles.get(dest))
        : localExists && isExecutable(localPath);

    let state;
    if (inOld && inNew) {
      const oldBuf = readFileSync(oldFiles.get(dest));
      const newBuf = readFileSync(newFiles.get(dest));
      if (Buffer.compare(oldBuf, newBuf) === 0) {
        state = "unchanged";
      } else if (!localExists) {
        state = "missing-local";
      } else {
        const localHash = sha256File(localPath);
        const manifestHash = manifest.files?.[dest]?.renderHash;
        state = localHash === manifestHash ? "clean-overwrite" : "three-way";
      }
    } else if (inNew && !inOld) {
      state = localExists ? "added-conflict" : "added";
      // "added" but local already matches new render exactly -> effectively unchanged.
      if (localExists) {
        const localHash = sha256File(localPath);
        const newHash = sha256File(newFiles.get(dest));
        if (localHash === newHash) state = "unchanged";
      }
    } else if (inOld && !inNew) {
      if (!localExists) continue; // nothing to report — already gone
      state = "removed";
    } else {
      continue;
    }

    entries.push({ dest, state, execBit });
  }

  entries.sort((a, b) => a.dest.localeCompare(b.dest));

  const plan = {
    oldVersion: manifest.template?.version ?? null,
    newVersion: newVersion ?? args.flags["new-version"] ?? null,
    entries,
  };

  const gd = gitDir(repoRoot);
  const planPath = join(repoRoot, gd, "template-update", "plan.json");
  writeJSON(planPath, plan);

  console.log(JSON.stringify(plan, null, 2));

  const counts = {};
  for (const e of entries) counts[e.state] = (counts[e.state] || 0) + 1;
  console.error(`plan: ${entries.length} entries — ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`);
  console.error(`plan written to ${planPath}`);
}

// --- apply ---------------------------------------------------------------

function journalPath(repoRoot) {
  const gd = gitDir(repoRoot);
  return join(repoRoot, gd, "template-update", "upgrade-journal");
}

function readJournal(path) {
  if (!existsSync(path)) return new Set();
  return new Set(
    readFileSync(path, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

function appendJournal(path, dest) {
  mkdirpFor(path);
  const line = `${dest}\n`;
  if (!existsSync(path)) writeFileSync(path, line);
  else writeFileSync(path, `${readFileSync(path, "utf8")}${line}`);
}

function applyChmodGlobsToDest(dest, globs) {
  // Minimal glob: supports a single trailing "*" segment (e.g. "scripts/sprint/*.sh").
  for (const pattern of globs || []) {
    const re = new RegExp(
      "^" +
        pattern
          .split("*")
          .map((s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
          .join("[^/]*") +
        "$",
    );
    if (re.test(dest)) return true;
  }
  return false;
}

function cmdApply(argv) {
  const args = parseArgs(argv);
  const planPath = args.flags.plan;
  const oldDir = args.flags.old;
  const newDir = args.flags.new;
  const manifestPath = args.flags.manifest;
  const only = args.flags.only;
  const repoRoot = args.flags["repo-root"] || process.cwd();
  if (!planPath || !oldDir || !newDir || !manifestPath) {
    die("usage: upgrade.mjs apply --plan <plan.json> --old <renderDir> --new <renderDir> --manifest <path> [--only <dest>]", 1);
  }

  const plan = readJSON(planPath);
  const manifest = loadManifest(manifestPath);

  const newParent = dirname(newDir.replace(/\/+$/, ""));
  const newConfigPath = join(newParent, "template.config.json");
  const newTemplateConfig = existsSync(newConfigPath) ? readJSON(newConfigPath) : {};
  const newVersionPath = join(newParent, "VERSION");
  const newVersionFromRender = existsSync(newVersionPath) ? readFileSync(newVersionPath, "utf8").trim() : null;

  const jPath = journalPath(repoRoot);
  const journaled = readJournal(jPath);

  const result = { applied: [], "merged-clean": [], conflicts: [], added: [], removed: [], skipped: [] };

  for (const entry of plan.entries) {
    const { dest, state, execBit } = entry;
    if (only && dest !== only) continue;
    if (journaled.has(dest)) {
      result.skipped.push(dest);
      continue;
    }

    const localPath = join(repoRoot, dest);
    const newPath = join(newDir, dest);
    const oldPath = join(oldDir, dest);

    if (state === "unchanged") {
      appendJournal(jPath, dest);
      continue;
    }

    if (state === "clean-overwrite" || state === "missing-local") {
      mkdirpFor(localPath);
      copyFileSync(newPath, localPath);
      if (execBit) chmodSync(localPath, 0o755);
      result.applied.push(dest);
      appendJournal(jPath, dest);
      continue;
    }

    if (state === "added") {
      mkdirpFor(localPath);
      copyFileSync(newPath, localPath);
      if (execBit) chmodSync(localPath, 0o755);
      result.added.push(dest);
      appendJournal(jPath, dest);
      continue;
    }

    if (state === "added-conflict") {
      result.conflicts.push({ dest, reason: "added-conflict: local file exists and differs from new render" });
      continue; // do not journal — needs manual resolution
    }

    if (state === "three-way") {
      // git merge-file <local> <oldRender> <newRender> — modifies <local> in place.
      let conflictCount = 0;
      try {
        execFileSync("git", ["merge-file", localPath, oldPath, newPath], { stdio: "pipe" });
      } catch (e) {
        // git merge-file: exit 1..127 = number of conflicts; a NEGATIVE exit
        // (error, e.g. binary input) surfaces as 128..255 and must NOT be
        // counted as conflicts — that would journal the file and bump its
        // renderHash while the local content silently diverges.
        if (typeof e.status === "number" && e.status >= 1 && e.status <= 127) {
          conflictCount = e.status;
        } else {
          die(`git merge-file failed for ${dest} (exit ${e.status ?? "?"}): ${e.message}`, 1);
        }
      }
      if (execBit) chmodSync(localPath, 0o755);
      if (conflictCount > 0) {
        result.conflicts.push({ dest, reason: `${conflictCount} conflict(s) — resolve markers in place` });
        appendJournal(jPath, dest); // journaled so a re-run never re-merges — see DECISION 3
      } else {
        result["merged-clean"].push(dest);
        appendJournal(jPath, dest);
      }
      continue;
    }

    if (state === "removed") {
      result.removed.push(dest); // never delete — report only
      appendJournal(jPath, dest);
      continue;
    }

    // Unknown state — surface rather than silently skip.
    result.skipped.push(dest);
  }

  // Re-apply chmod +x per the NEW template.config.json postCopy globs.
  const chmodGlobs = newTemplateConfig.postCopy?.["chmod+x"];
  if (Array.isArray(chmodGlobs)) {
    for (const dest of new Set([...result.applied, ...result.added, ...result["merged-clean"]])) {
      if (applyChmodGlobsToDest(dest, chmodGlobs) && existsSync(join(repoRoot, dest))) {
        chmodSync(join(repoRoot, dest), 0o755);
      }
    }
  }

  // Update the manifest.
  const newVersionArg = args.flags["new-version"] || newVersionFromRender || manifest.template?.version;
  const newCommitArg = args.flags["new-commit"] || manifest.template?.commit;
  manifest.template = { ...manifest.template, version: newVersionArg, commit: newCommitArg };

  manifest.files = manifest.files || {};
  const allTouched = new Set([
    ...result.applied,
    ...result["merged-clean"],
    ...result.added,
    ...plan.entries.filter((e) => e.state === "three-way").map((e) => e.dest), // includes conflicted
  ]);
  for (const dest of allTouched) {
    const newPath = join(newDir, dest);
    if (!existsSync(newPath)) continue;
    const cls = classOf(dest, manifest, newTemplateConfig);
    const prevIgnored = manifest.files[dest]?.ignored ?? false;
    manifest.files[dest] = {
      source: manifest.files[dest]?.source,
      class: cls,
      renderHash: sha256File(newPath), // hash of the NEW render, never the merged local
      ignored: prevIgnored,
    };
  }
  saveManifest(manifestPath, manifest);

  console.log(JSON.stringify(result, null, 2));
  if (result.conflicts.length > 0) process.exit(2);
}

// --- merge-claude-block ---------------------------------------------------------

function cmdMergeClaudeBlock(argv) {
  const args = parseArgs(argv);
  const renderedPath = args.flags.rendered;
  const repoRoot = args.flags["repo-root"] || process.cwd();
  if (!renderedPath) die("usage: upgrade.mjs merge-claude-block --rendered <claude-block.md> [--repo-root <path>]", 1);
  if (!existsSync(renderedPath)) die(`rendered block not found: ${renderedPath}`, 1);

  const claudeMdPath = join(repoRoot, "CLAUDE.md");
  if (!existsSync(claudeMdPath)) die(`no CLAUDE.md found at ${claudeMdPath}`, 3);

  const claudeMd = readFileSync(claudeMdPath, "utf8");
  const beginIdx = claudeMd.indexOf(CLAUDE_BLOCK_BEGIN);
  const endIdx = claudeMd.indexOf(CLAUDE_BLOCK_END);
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    die(
      `CLAUDE.md is missing the "${CLAUDE_BLOCK_BEGIN}" / "${CLAUDE_BLOCK_END}" markers — resolve manually`,
      3,
    );
  }

  const rendered = readFileSync(renderedPath, "utf8").replace(/\n+$/, "");
  const before = claudeMd.slice(0, beginIdx + CLAUDE_BLOCK_BEGIN.length);
  const after = claudeMd.slice(endIdx);
  const updated = `${before}\n${rendered}\n${after}`;
  writeFileSync(claudeMdPath, updated);
  console.log(`updated project block in ${claudeMdPath}`);
}

// --- merge-settings ---------------------------------------------------------

function cmdMergeSettings(argv) {
  const args = parseArgs(argv);
  const newPath = args.flags.new;
  const repoRoot = args.flags["repo-root"] || process.cwd();
  if (!newPath) die("usage: upgrade.mjs merge-settings --new <rendered-settings.json> [--repo-root <path>]", 1);
  if (!existsSync(newPath)) die(`rendered settings not found: ${newPath}`, 1);

  const settingsPath = join(repoRoot, ".claude", "settings.json");
  const newSettings = readJSON(newPath);

  if (!existsSync(settingsPath)) {
    writeJSON(settingsPath, newSettings);
    console.log(`created ${settingsPath}`);
    return;
  }

  const existing = readJSON(settingsPath);

  // Union allow, deny AND ask. Dropping template-shipped deny/ask entries
  // silently weakens the downstream permission posture — the one field where
  // losing entries is worse than duplicating them.
  const merged = { ...existing };
  if (existing.permissions || newSettings.permissions) {
    const mergedPerms = { ...existing.permissions };
    for (const list of ["allow", "deny", "ask"]) {
      const have = existing.permissions?.[list] ?? [];
      const add = newSettings.permissions?.[list] ?? [];
      if (have.length === 0 && add.length === 0) continue;
      const union = [...have];
      for (const perm of add) if (!union.includes(perm)) union.push(perm);
      mergedPerms[list] = union;
    }
    merged.permissions = mergedPerms;
  }
  for (const [key, value] of Object.entries(newSettings)) {
    if (key === "permissions") continue;
    if (!Object.hasOwn(existing, key)) merged[key] = value;
  }

  writeJSON(settingsPath, merged);
  console.log(`merged settings -> ${settingsPath}`);
}

// --- hash ---------------------------------------------------------------

function cmdHash(argv) {
  const [file] = argv;
  if (!file) die("usage: upgrade.mjs hash <file>", 1);
  if (!existsSync(file)) die(`file not found: ${file}`, 1);
  console.log(sha256File(file));
}

// --- dispatch ---------------------------------------------------------------

const [, , cmd, ...rest] = process.argv;

switch (cmd) {
  case "fetch":
    cmdFetch(rest);
    break;
  case "render":
    cmdRender(rest);
    break;
  case "plan":
    cmdPlan(rest);
    break;
  case "apply":
    cmdApply(rest);
    break;
  case "merge-claude-block":
    cmdMergeClaudeBlock(rest);
    break;
  case "merge-settings":
    cmdMergeSettings(rest);
    break;
  case "hash":
    cmdHash(rest);
    break;
  default:
    console.error(
      "usage: upgrade.mjs fetch|render|plan|apply|merge-claude-block|merge-settings|hash ...",
    );
    process.exit(1);
}
