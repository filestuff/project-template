#!/usr/bin/env node
// Is the tier rubric right? Every sprint landed by a wave or train carries an `outcome:`
// line in its done-file frontmatter (written at land from the sprint-flow run):
//   outcome: assigned=standard final=complex runs=1 escalations=1 arbiter=0 fix_rounds=1 findings=2/3
// This aggregates them by ASSIGNED tier and says where the rubric
// (docs/sprints/tier-rubric.md) or the routing table (scripts/sprint/routing.json) is
// miscalibrated — the feedback loop that keeps "which model for which work" from being a
// guess someone made once.
//
//   tiers.mjs [--since YYYY-MM-DD] [--json] [--root <repo-root>]
//
// Flags (a tier needs at least MIN_N sprints before any rate is trusted):
//   UNDER     ≥ 25% of the tier's sprints escalated — work harder than the tier is being
//             assigned to it: tighten the rubric's criteria, or route the tier one step up.
//   STRAINED  ≥ 40% needed two fix rounds, a re-launch, or had ≥ 2 confirmed
//             Critical/Important findings — it finishes, but not cleanly.
//   OVER?     complex/critical only, ≥ 8 sprints, none escalated, none strained, no
//             confirmed finding — possibly over-provisioned. A question, not a verdict:
//             try the tier below on the next comparable sprint before changing a rule.
// Exit 0 always. Sprints with no `outcome:` (solo, lite-era, pre-1.14) are counted apart.
import { allSprints, repoRoot } from "./frontmatter.mjs";

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i === -1 ? null : (argv[i + 1] ?? ""); };
const since = flag("--since");
const json = argv.includes("--json");
if (since !== null && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
  console.error("usage: tiers.mjs [--since YYYY-MM-DD] [--json] [--root <repo-root>]");
  process.exit(1);
}
const root = flag("--root") || repoRoot();
const TIERS = ["routine", "standard", "complex", "critical"];
const MIN_N = 4;

const parse = (line) => {
  const o = {};
  for (const m of String(line).matchAll(/(\w+)=(\S+)/g)) o[m[1]] = m[2];
  if (!TIERS.includes(o.assigned) || !TIERS.includes(o.final)) return null;
  const [confirmed, raised] = String(o.findings ?? "0/0").split("/").map((n) => Number(n) || 0);
  return { assigned: o.assigned, final: o.final, runs: Number(o.runs) || 1, escalations: Number(o.escalations) || 0, arbiter: Number(o.arbiter) || 0, fix_rounds: Number(o.fix_rounds) || 0, confirmed, raised };
};

const done = allSprints(root).filter((s) => ["done", "done/archive"].includes(s.dir) && (since === null || String(s.end_date ?? "") >= since));
const rows = [];
let untracked = 0;
for (const s of done) {
  const o = s.outcome ? parse(s.outcome) : null;
  if (!o) { untracked++; continue; }
  rows.push({ sprint: s.sprint, risk: s.risk ?? "low", points: Number(s.story_points) || 0, reason: s.tier_reason ?? null, ...o });
}

const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
const stats = {};
const flags = [];
for (const t of TIERS) {
  const r = rows.filter((x) => x.assigned === t);
  if (r.length === 0) continue;
  const escalated = r.filter((x) => x.escalations > 0 || x.final !== x.assigned);
  const strained = r.filter((x) => x.fix_rounds >= 2 || x.runs > 1 || x.confirmed >= 2);
  const st = {
    sprints: r.length,
    escalated: escalated.length,
    escalated_pct: pct(escalated.length, r.length),
    strained: strained.length,
    strained_pct: pct(strained.length, r.length),
    avg_fix_rounds: Number((r.reduce((a, x) => a + x.fix_rounds, 0) / r.length).toFixed(2)),
    confirmed_findings: r.reduce((a, x) => a + x.confirmed, 0),
    relaunched: r.filter((x) => x.runs > 1).length,
    arbiter_calls: r.reduce((a, x) => a + x.arbiter, 0),
  };
  stats[t] = st;
  if (r.length < MIN_N) continue;
  if (st.escalated_pct >= 25) flags.push({ flag: "UNDER", tier: t, text: `${st.escalated}/${r.length} ${t} sprints escalated (${escalated.map((x) => x.sprint).join(", ")}) — the tier is being assigned to work that is harder than the rubric admits: tighten its criteria, or route ${t} one step up in routing.json` });
  else if (st.strained_pct >= 40) flags.push({ flag: "STRAINED", tier: t, text: `${st.strained}/${r.length} ${t} sprints needed two fix rounds, a re-launch, or had ≥2 confirmed findings (${strained.map((x) => x.sprint).join(", ")}) — they finish, but not cleanly` });
  else if ((t === "complex" || t === "critical") && r.length >= 8 && st.escalated === 0 && st.strained === 0 && st.confirmed_findings === 0) flags.push({ flag: "OVER?", tier: t, text: `${r.length} ${t} sprints ran clean — possibly over-provisioned; try the tier below on the next comparable sprint before changing a rule` });
}

if (json) {
  console.log(JSON.stringify({ tracked: rows.length, untracked, tiers: stats, flags, sprints: rows }, null, 2));
} else {
  if (rows.length === 0) console.log("no sprint has an outcome: line yet — it is written when a wave or train lands a sprint");
  for (const t of TIERS) {
    const st = stats[t];
    if (!st) continue;
    console.log(`${t.padEnd(9)} ${String(st.sprints).padStart(3)} sprint(s)  escalated ${String(st.escalated_pct).padStart(3)}%  strained ${String(st.strained_pct).padStart(3)}%  avg fix rounds ${st.avg_fix_rounds}  confirmed findings ${st.confirmed_findings}  re-launched ${st.relaunched}${st.sprints < MIN_N ? `  (fewer than ${MIN_N} — too few to judge)` : ""}`);
  }
  for (const f of flags) console.log(`${f.flag} ${f.tier}: ${f.text}`);
  console.log(`SUMMARY tiers: ${rows.length} sprint(s) with an outcome, ${untracked} without; ${flags.length} flag(s)`);
}
