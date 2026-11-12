// Workflow-tool variant of ORCHESTRATION.md Step 2b (planning fan-out).
// Optional: use only when the Workflow tool is available; otherwise dispatch
// sprint-planner subagents via the Agent tool as documented. Everything around
// the fan-out (reservation, constraint checks, decision round, locked commits)
// stays in-session — this script ONLY runs the planners and returns their
// verdicts as validated JSON instead of parsed text.
//
// Each member flows planner → brief-auditor → (one planner repair + re-audit when the
// audit is INSUFFICIENT) on its own — a pipeline, so a member whose brief is already
// sufficient never waits for a neighbor's repair round. A planner cannot certify its own
// brief: `audit.verdict` is what makes a member's plan_date stand (ORCHESTRATION 2c).
//
// Invoke as: Workflow({ scriptPath: "scripts/sprint/workflows/plan-wave.mjs",
//   args: {
//     waveId: "W-…",                       // from reserve-wave.sh
//     repoRoot: "/abs/repo/root",
//     rosterSummary: "S-AAA touches [...]; S-BBB touches [...]",
//     members: [{ sprint: "S-NNN",
//                 file: "/abs/path/inside/.claude/worktrees/wave-W-…-plan/docs/sprints/backlog/S-NNN-….md",
//                 landedSince: "S-CCC (docs/sprints/done/…), …" }]  // or "none"
//   } })
export const meta = {
  name: 'plan-wave',
  description: 'Fan out one sprint-planner per wave member; return structured verdicts',
  phases: [
    { title: 'Plan', detail: 'one sprint-planner per unplanned/stale member' },
    { title: 'Audit', detail: 'one brief-auditor cold-read per planned member; one repair round' },
  ],
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'touches_delta', 'staleness', 'contract_drift', 'questions', 'cross_sprint'],
  properties: {
    verdict: { enum: ['READY', 'READY_WITH_QUESTIONS', 'NOT_READY', 'SPLIT_SUGGESTED'] },
    verdict_detail: { type: 'string', description: 'reason for NOT_READY / how to SPLIT; empty otherwise' },
    risk_tier: { type: 'string', description: '"<risk>/<tier>" plus "unchanged" or "raised: <why>"' },
    lint: { type: 'string', description: 'the SUMMARY line from plan-check.mjs ("" if not run)' },
    touches_delta: { type: 'string', description: '"unchanged" or "+added / -removed" paths' },
    staleness: { type: 'array', items: { type: 'string' }, description: 'one line per fixed finding; empty if none' },
    contract_drift: { type: 'string', description: '"none" or what changed and how Consumes was updated / needs decision' },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'question', 'options', 'recommended'],
        properties: {
          id: { type: 'string', description: 'D-A, D-B, …' },
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' }, description: '2-4 concrete options with plan/touches implications' },
          recommended: { type: 'string', description: 'the option you recommend, a one-line why, and the stake if it is wrong' },
        },
      },
    },
    cross_sprint: { type: 'string', description: '"none" or the signal, e.g. "needs edits to a file claimed by S-MMM"' },
  },
}

const AUDIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'lint', 'blocking', 'assumptions'],
  properties: {
    verdict: { enum: ['SUFFICIENT', 'INSUFFICIENT'] },
    lint: { type: 'string', description: 'the SUMMARY line from plan-check.mjs' },
    blocking: { type: 'array', items: { type: 'string' }, description: 'what an executor would have to ask; empty if none' },
    assumptions: { type: 'array', items: { type: 'string' }, description: 'assumptions an executor would have to make; empty if none' },
  },
}

const { waveId, repoRoot, rosterSummary, members } = args
log(`planning ${members.length} member(s) of ${waveId}`)

const plannerPrompt = (m, repair) =>
  `You are the sprint-planner subagent for **${m.sprint}**. Follow your agent instructions (.claude/agents/sprint-planner.md).

- Sprint file (edit ONLY this file, do not commit — it lives in the wave's planning worktree): ${m.file}
- Repo root: ${repoRoot}
- Wave roster: ${rosterSummary}
- Landed since this sprint's plan_date: ${m.landedSince || 'none'}
${
  repair
    ? `
**Audit-repair mode.** A brief-auditor cold-read this file and could not execute it without guessing. Fix exactly these gaps in the file, re-run the lint, and return your report again:
${repair.map((b) => `  - ${b}`).join('\n')}`
    : `
Verify and deepen the sprint file against the CURRENT code, set plan_date if it reaches the readiness bar, and return your findings via the structured output (same fields as your instructions' report format).`
}`

const auditPrompt = (m) =>
  `You are the brief-auditor subagent. Follow your agent instructions (.claude/agents/brief-auditor.md).

- Sprint file: ${m.file}
- Repo root: ${repoRoot}

Cold-read the brief as the agent that must execute it and return your verdict via the structured output.`

const audit = (m, round) =>
  agent(auditPrompt(m), { agentType: 'brief-auditor', schema: AUDIT_SCHEMA, label: `audit:${m.sprint}${round > 1 ? ' (re-audit)' : ''}`, phase: 'Audit' })

const certifiable = (v) => v.verdict === 'READY' || v.verdict === 'READY_WITH_QUESTIONS'

const results = await pipeline(
  members,
  // Stage 1 — plan.
  (m) => agent(plannerPrompt(m), { agentType: 'sprint-planner', schema: VERDICT_SCHEMA, label: `plan:${m.sprint}`, phase: 'Plan' }),
  // Stage 2 — cold read; one repair round when the brief is insufficient.
  async (v, m) => {
    if (!v) return null
    if (!certifiable(v)) return { sprint: m.sprint, ...v, audit: null }
    let a = await audit(m, 1)
    if (a && a.verdict === 'INSUFFICIENT') {
      log(`${m.sprint}: brief insufficient (${a.blocking.length} blocking) — one planner repair round`)
      const repaired = await agent(plannerPrompt(m, a.blocking), { agentType: 'sprint-planner', schema: VERDICT_SCHEMA, label: `repair:${m.sprint}`, phase: 'Plan' })
      if (repaired) v = repaired
      if (certifiable(v)) a = (await audit(m, 2)) || a
    }
    // audit === null means the auditor never returned: unaudited, which is not SUFFICIENT.
    return { sprint: m.sprint, ...v, audit: a || { verdict: 'INSUFFICIENT', lint: '', blocking: ['brief-auditor did not return — brief is unaudited'], assumptions: [] } }
  },
)

const missing = members.filter((_, i) => !results[i]).map((m) => m.sprint)
if (missing.length) log(`planner(s) died for: ${missing.join(', ')} — re-dispatch or --drop them`)
const verdicts = results.filter(Boolean)
const uncertified = verdicts.filter((v) => certifiable(v) && v.audit && v.audit.verdict !== 'SUFFICIENT').map((v) => v.sprint)
if (uncertified.length) log(`audit INSUFFICIENT after repair: ${uncertified.join(', ')} — reset their plan_date (ORCHESTRATION 2c)`)
return { waveId, verdicts, missing, uncertified }
