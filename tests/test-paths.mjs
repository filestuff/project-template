#!/usr/bin/env node
// paths.mjs is the one place that knows where sprint files live: a finished sprint's home
// is done/<bucket>/, one folder per hundred ids; next-id never reuses an id from any state
// (legacy flat done/ and done/archive/ included); duplicates are found by number.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../lite/scripts/sprint/paths.mjs", import.meta.url).pathname;
const P = await import(SCRIPT);
const tmp = mkdtempSync(join(tmpdir(), "paths-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
let failed = 0;
const check = (c, m, extra = "") => {
  if (!c) {
    failed++;
    console.error(`FAIL ${m}${extra ? `\n${extra}` : ""}`);
  }
};
const put = (rel) => {
  const f = join(tmp, "docs/sprints", rel);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, "---\nsprint: x\n---\n");
};
const cli = (...a) => spawnSync("node", [SCRIPT, "--root", tmp, ...a], { encoding: "utf8" });

// buckets
check(P.bucketOf("S-001") === "0000-0099", "S-001 → 0000-0099");
check(P.bucketOf("S-099") === "0000-0099", "S-099 → 0000-0099");
check(P.bucketOf("S-100") === "0100-0199", "S-100 → 0100-0199");
check(P.bucketOf("S-645") === "0600-0699", "S-645 → 0600-0699");
check(P.bucketOf("S-1384") === "1300-1399", "S-1384 → 1300-1399");
check(P.bucketOf("S-10000") === "10000-10099", "S-10000 widens naturally");
check(P.doneHome("S-1384") === "docs/sprints/done/1300-1399", "doneHome is relative, no trailing slash");
let threw = false;
try {
  P.bucketOf("1384");
} catch {
  threw = true;
}
check(threw, "a non-id throws");

// listing across every state, bucket folders and the legacy layout
put("backlog/S-1402-next.md");
put("in-progress/S-1401-doing.md");
put("done/1300-1399/S-1394-landed.md");
put("done/0000-0099/S-007-early.md");
put("done/S-650-legacy-flat.md");
put("done/archive/S-200-legacy-archive.md");
put("rejected/S-1500-nope.md");
writeFileSync(join(tmp, "docs/sprints/done/1300-1399/LEDGER.md"), "# ledger\n");
const all = P.listSprintFiles(tmp);
check(all.length === 7, `7 sprint files listed (LEDGER.md is not one): ${all.map((s) => s.rel).join(", ")}`);
check(all.map((s) => s.num).join(",") === "7,200,650,1394,1401,1402,1500", "sorted by id number");
const state = Object.fromEntries(all.map((s) => [s.id, s.state]));
check(state["S-650"] === "done" && state["S-200"] === "done" && state["S-1394"] === "done", "legacy and bucket folders are all state done");
check(state["S-1500"] === "rejected" && state["S-1402"] === "backlog" && state["S-1401"] === "in-progress", "other states");
check(P.findSprint(tmp, "S-1394")?.rel === "docs/sprints/done/1300-1399/S-1394-landed.md", "findSprint");
check(P.findSprint(tmp, "S-9") === null, "findSprint → null when absent");

// next id: one past the highest in ANY state (a rejected id is never reused)
check(P.nextId(tmp) === "S-1501", `nextId counts rejected: ${P.nextId(tmp)}`);
check(cli("next-id").stdout.trim() === "S-1501", "CLI next-id");
check(cli("done-home", "S-1384").stdout.trim() === "docs/sprints/done/1300-1399", "CLI done-home");
check(cli("find", "S-200").stdout.trim() === "docs/sprints/done/archive/S-200-legacy-archive.md", "CLI find reads the legacy archive");
check(cli("find", "S-9").status === 1, "CLI find exits 1 when absent");
check(cli("done-home", "nope").status === 1, "CLI done-home rejects a non-id");

// duplicates by NUMBER (S-7 and S-007 are one sprint)
check(P.duplicateIds(tmp).length === 0 && cli("duplicates").status === 0, "no duplicates yet");
put("backlog/S-7-again.md");
const d = P.duplicateIds(tmp);
check(d.length === 1 && d[0].files.length === 2, `S-7 and S-007 collide: ${JSON.stringify(d)}`);
const r = cli("duplicates");
check(r.status === 2 && /S-007/.test(r.stdout), `CLI duplicates exits 2: ${r.stdout}`);

// an empty repo starts at S-001
const empty = mkdtempSync(join(tmpdir(), "paths-empty-"));
check(execFileSync("node", [SCRIPT, "--root", empty, "next-id"], { encoding: "utf8" }).trim() === "S-001", "empty repo → S-001");
rmSync(empty, { recursive: true, force: true });

if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("test-paths: all checks passed");
