#!/usr/bin/env node
// Regression: git merge-file's negative exit (error, e.g. binary input) came
// back to execFileSync as status 255 and was recorded as "255 conflict(s)"
// while the manifest renderHash was still bumped to the new render — silent
// divergence, committed. An error must abort with exit 1, not masquerade
// as conflicts.
//
// Also asserts the adjacent, still-required behavior: a genuine three-way
// conflict (text files that really diverge) must still be reported as a
// conflict, exit 2, with standard <<<<<<< markers left in the local file.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = dirname(here);
const upgradeScript = join(repo, "lite/scripts/template/upgrade.mjs");

let failed = false;
function fail(msg) {
  console.error(`FAIL: ${msg}`);
  failed = true;
}

function initGitRepo(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
}

function writeManifest(path) {
  writeFileSync(path, JSON.stringify({ template: { version: "1.0.0" }, files: {} }, null, 2));
}

function writePlan(path, entries) {
  writeFileSync(path, JSON.stringify({ oldVersion: "1.0.0", newVersion: "1.1.0", entries }, null, 2));
}

function runApply({ planPath, oldDir, newDir, manifestPath, repoRoot }) {
  return spawnSync(
    process.execPath,
    [upgradeScript, "apply", "--plan", planPath, "--old", oldDir, "--new", newDir, "--manifest", manifestPath, "--repo-root", repoRoot],
    { encoding: "utf8" },
  );
}

const tmp = mkdtempSync(join(tmpdir(), "upg-"));
try {
  // --- Case 1: merge-file errors (binary input) -> must abort, not "conflict" ---
  const bin = (b) => Buffer.concat([Buffer.from([0, 1, 2, b]), Buffer.from("\0x\0")]);
  const oldBuf = bin(1);
  const localBuf = bin(2);
  const newBuf = bin(3);

  // Direct probe: confirm git merge-file errors (negative exit -> 255) on this input,
  // so this fixture actually exercises the bug rather than a normal conflict.
  const probeDir = join(tmp, "probe");
  mkdirSync(probeDir, { recursive: true });
  writeFileSync(join(probeDir, "old"), oldBuf);
  writeFileSync(join(probeDir, "local"), localBuf);
  writeFileSync(join(probeDir, "new"), newBuf);
  const probe = spawnSync("git", ["merge-file", join(probeDir, "local"), join(probeDir, "old"), join(probeDir, "new")]);
  if (probe.status === 0) {
    console.error("fixture did not provoke a merge-file error");
    process.exit(1);
  }

  const dest = "conflict.bin";
  const errOldDir = join(tmp, "err-old");
  const errNewDir = join(tmp, "err-new");
  const errRepoRoot = join(tmp, "err-repo");
  mkdirSync(errOldDir, { recursive: true });
  mkdirSync(errNewDir, { recursive: true });
  initGitRepo(errRepoRoot);
  writeFileSync(join(errOldDir, dest), oldBuf);
  writeFileSync(join(errNewDir, dest), newBuf);
  writeFileSync(join(errRepoRoot, dest), localBuf);

  const errManifestPath = join(tmp, "err-manifest.json");
  writeManifest(errManifestPath);
  const errPlanPath = join(tmp, "err-plan.json");
  writePlan(errPlanPath, [{ dest, state: "three-way", execBit: false }]);

  const errResult = runApply({
    planPath: errPlanPath,
    oldDir: errOldDir,
    newDir: errNewDir,
    manifestPath: errManifestPath,
    repoRoot: errRepoRoot,
  });

  if (errResult.status === 0) fail(`error case: expected non-zero exit, got 0 (stderr: ${errResult.stderr})`);
  if (!errResult.stderr.includes("merge-file failed")) {
    fail(`error case: expected stderr to contain "merge-file failed", got: ${errResult.stderr}`);
  }
  const localAfter = readFileSync(join(errRepoRoot, dest));
  if (Buffer.compare(localAfter, localBuf) !== 0) {
    fail(`error case: local file content changed after failed apply (expected unchanged bin(2))`);
  }

  // --- Case 2: a genuine three-way conflict must still be reported as such ---
  const cDest = "conflict.txt";
  const cOldDir = join(tmp, "c-old");
  const cNewDir = join(tmp, "c-new");
  const cRepoRoot = join(tmp, "c-repo");
  mkdirSync(cOldDir, { recursive: true });
  mkdirSync(cNewDir, { recursive: true });
  initGitRepo(cRepoRoot);
  writeFileSync(join(cOldDir, cDest), "line1\nline2\nline3\n");
  writeFileSync(join(cNewDir, cDest), "line1\nNEW\nline3\n");
  writeFileSync(join(cRepoRoot, cDest), "line1\nLOCAL\nline3\n");

  const cManifestPath = join(tmp, "c-manifest.json");
  writeManifest(cManifestPath);
  const cPlanPath = join(tmp, "c-plan.json");
  writePlan(cPlanPath, [{ dest: cDest, state: "three-way", execBit: false }]);

  const cResult = runApply({
    planPath: cPlanPath,
    oldDir: cOldDir,
    newDir: cNewDir,
    manifestPath: cManifestPath,
    repoRoot: cRepoRoot,
  });

  if (cResult.status !== 2) fail(`conflict case: expected exit 2, got ${cResult.status} (stderr: ${cResult.stderr})`);
  const cLocalAfter = readFileSync(join(cRepoRoot, cDest), "utf8");
  if (!cLocalAfter.includes("<<<<<<<")) {
    fail(`conflict case: expected conflict markers in local file, got: ${cLocalAfter}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failed) {
  process.exit(1);
} else {
  console.log("PASS test-upgrade-merge-file.mjs");
  process.exit(0);
}
