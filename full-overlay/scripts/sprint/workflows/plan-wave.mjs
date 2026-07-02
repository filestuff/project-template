// Workflow-tool variant of ORCHESTRATION.md Step 2b (planning fan-out).
// Optional: use only when the Workflow tool is available; otherwise dispatch
// sprint-planner subagents via the Agent tool as documented. Everything around
// the fan-out (reservation, constraint checks, decision round, locked commits)
// stays in-session — this script ONLY runs the planners and returns their
// verdicts as validated JSON instead of parsed text.
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
  phases: [{ title: 'Plan', detail: 'one sprint-planner per unplanned/stale member' }],
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'touches_delta', 'staleness', 'contract_drift', 'questions', 'cross_sprint'],
  properties: {
    verdict: { enum: ['READY', 'READY_WITH_QUESTIONS', 'NOT_READY', 'SPLIT_SUGGESTED'] },
    verdict_detail: { type: 'string', description: 'reason for NOT_READY / how to SPLIT; empty otherwise' },
    touches_delta: { type: 'string', description: '"unchanged" or "+added / -removed" paths' },
    staleness: { type: 'array', items: { type: 'string' }, description: 'one line per fixed finding; empty if none' },
    contract_drift: { type: 'string', description: '"none" or what changed and how Consumes was updated / needs decision' },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'question', 'options'],
        properties: {
          id: { type: 'string', description: 'D-A, D-B, …' },
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' }, description: '2-4 concrete options with plan/touches implications' },
        },
      },
    },
    cross_sprint: { type: 'string', description: '"none" or the signal, e.g. "needs edits to a file claimed by S-MMM"' },
  },
}

phase('Plan')
const { waveId, repoRoot, rosterSummary, members } = args
log(`planning ${members.length} member(s) of ${waveId}`)

const results = await parallel(
  members.map((m) => () =>
    agent(
      `You are the sprint-planner subagent for **${m.sprint}**. Follow your agent instructions (.claude/agents/sprint-planner.md).

- Sprint file (edit ONLY this file, do not commit — it lives in the wave's planning worktree): ${m.file}
- Repo root: ${repoRoot}
- Wave roster: ${rosterSummary}
- Landed since this sprint's plan_date: ${m.landedSince || 'none'}

Verify and deepen the sprint file against the CURRENT code, set plan_date if it reaches the readiness bar, and return your findings via the structured output (same fields as your instructions' report format).`,
      { agentType: 'sprint-planner', schema: VERDICT_SCHEMA, label: `plan:${m.sprint}`, phase: 'Plan' },
    ).then((v) => ({ sprint: m.sprint, ...v })),
  ),
)

const missing = members.filter((_, i) => !results[i]).map((m) => m.sprint)
if (missing.length) log(`planner(s) died for: ${missing.join(', ')} — re-dispatch or --drop them`)
return { waveId, verdicts: results.filter(Boolean), missing }
