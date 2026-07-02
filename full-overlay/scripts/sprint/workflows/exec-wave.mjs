// Workflow-tool variant of ORCHESTRATION.md Step 4 (execution fan-out).
// Optional: use only when the Workflow tool is available; otherwise dispatch
// sprint-executor subagents via the Agent tool as documented. Starts (Step 3)
// and completions (Step 5) stay in-session — this script ONLY runs the
// executors and returns their statuses as validated JSON.
//
// Note: workflow agents cannot be continued via SendMessage after the run ends.
// A BLOCKED result here is answered by the advisor loop via a fresh
// sprint-executor dispatch pointed at the branch's committed work.
//
// Invoke as: Workflow({ scriptPath: "scripts/sprint/workflows/exec-wave.mjs",
//   args: {
//     waveId: "W-…",
//     repoRoot: "/abs/repo/root",
//     ledgerDir: "/abs/repo/root/.claude/sprint-orchestration/W-…/",
//     sprints: [{ sprint: "S-NNN", worktree: "/abs/repo/root/.claude/worktrees/S-NNN-…" }]
//   } })
export const meta = {
  name: 'exec-wave',
  description: 'Fan out one sprint-executor per started sprint; return structured statuses',
  phases: [{ title: 'Execute', detail: 'one sprint-executor per sprint, in its worktree' }],
}

const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'commits', 'gate', 'report_path'],
  properties: {
    status: { enum: ['DONE', 'BLOCKED', 'NEEDS_CLAIM', 'PLAN_GAP'] },
    commits: { type: 'array', items: { type: 'string' }, description: 'git log --oneline lines for deliverable commits' },
    gate: { type: 'string', description: 'one-line gate/test result' },
    report_path: { type: 'string', description: 'the report file written in the wave ledger dir (or "" if not written)' },
    concerns: { type: 'string', description: 'anything the orchestrator should know; "" if none' },
    question: {
      type: 'object',
      additionalProperties: false,
      required: ['question', 'context', 'options', 'default'],
      description: 'BLOCKED only: the structured question for the advisor loop',
      properties: {
        question: { type: 'string' },
        context: { type: 'string', description: 'file:line, what was tried' },
        options: { type: 'array', items: { type: 'string' } },
        default: { type: 'string', description: 'what the executor would do if forced to choose' },
      },
    },
    needs_claim_paths: { type: 'array', items: { type: 'string' }, description: 'NEEDS_CLAIM only: the unclaimed paths' },
    plan_gap: { type: 'string', description: 'PLAN_GAP only: gaps + evidence + proposed correction (≤10 lines)' },
  },
}

phase('Execute')
const { waveId, repoRoot, ledgerDir, sprints } = args
log(`executing ${sprints.length} sprint(s) of ${waveId}`)

const results = await parallel(
  sprints.map((s) => () =>
    agent(
      `You are the sprint-executor subagent for sprint **${s.sprint}** — follow your agent instructions (.claude/agents/sprint-executor.md).

- Worktree (work ONLY here, via git -C / absolute paths): ${s.worktree}
- Repo root: ${repoRoot}
- Wave ledger dir (your report goes here): ${ledgerDir}

Execute the sprint per your instructions and return your status via the structured output.`,
      { agentType: 'sprint-executor', schema: STATUS_SCHEMA, label: `exec:${s.sprint}`, phase: 'Execute' },
    ).then((r) => ({ sprint: s.sprint, ...r })),
  ),
)

const missing = sprints.filter((_, i) => !results[i]).map((s) => s.sprint)
if (missing.length)
  log(`executor(s) died for: ${missing.join(', ')} — committed work persists on their branches; re-dispatch fresh`)
return { waveId, statuses: results.filter(Boolean), missing }
