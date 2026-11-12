// plan-flow — the planning pass of a wave or train (ORCHESTRATION.md Step 2b–2e).
// (A Workflow-tool script, not a Node module: top-level await and return. It must keep its
// .js extension — saved workflows are not discovered as .mjs.)
//
// Each member flows on its own — a pipeline, no barrier between stages:
//   Plan    `sprint-planner` verifies and deepens the sprint file against current code.
//   Audit   `brief-auditor` cold-reads it; INSUFFICIENT → one planner repair → re-audit.
//           A planner cannot certify its own brief: only a SUFFICIENT audit lets
//           plan_date stand (the orchestrator resets it for `uncertified` members).
//   Decide  (gated / unattended runs) each open question goes to the `arbiter`, which
//           classifies it under docs/DECISION_POLICY.md: mechanical and taste decisions
//           come back decided, with their record line; reserved ones come back shaped
//           for the user. In an interactive run this stage is skipped and every
//           question is returned for the user.
//
// Everything around the fan-out stays with the orchestrator: the reservation, the
// constraints check, writing decisions into sprint files, and both locked commits.
//
// Invoke as:
//   Workflow({ name: "plan-flow", args: {
//     waveId: "W-…", repoRoot: "/abs/repo", autonomy: "gated" | "interactive" | "unattended",
//     rosterSummary: "S-AAA touches [...]; S-BBB touches [...]",
//     members: [{ sprint: "S-NNN",
//                 file: "/abs/…/.claude/worktrees/wave-W-…-plan/docs/sprints/backlog/S-NNN-….md",
//                 landedSince: "S-CCC (docs/sprints/done/…), …" }],   // or "none"
//     routing: <contents of scripts/sprint/routing.json>               // optional
//   } })
//
// Returns { waveId, verdicts: [{ sprint, verdict, …, audit, questions: [{ …, ruling }] }],
//           missing, uncertified, decided: [{ sprint, id, class, decision, record }],
//           ask: [{ sprint, id, question, stake, options, recommended }] }
export const meta = {
  name: 'plan-flow',
  description: 'Plan a wave: one planner per member, a cold-read audit, and arbiter rulings on open questions',
  whenToUse: 'Launched by /sprint wave and /sprint train for the planning pass (ORCHESTRATION.md Step 2)',
  phases: [
    { title: 'Plan', detail: 'one sprint-planner per unplanned/stale member' },
    { title: 'Audit', detail: 'one brief-auditor cold-read per planned member; one repair round' },
    { title: 'Decide', detail: 'arbiter classifies each open question (gated/unattended runs)' },
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

const RULING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['class', 'decision', 'principle', 'record'],
  properties: {
    class: { enum: ['mechanical', 'taste', 'reserved'] },
    decision: { type: 'string', description: 'the chosen option, as it should be written into the sprint file ("" when reserved)' },
    principle: { type: 'string' },
    rejected: { type: 'string' },
    undo: { type: 'string' },
    record: { type: 'string', description: 'the record line in DECISION_POLICY grammar ("" when reserved)' },
    ask_user: {
      type: 'object',
      additionalProperties: false,
      required: ['question', 'stake', 'options', 'recommended'],
      description: 'reserved only',
      properties: {
        question: { type: 'string' },
        stake: { type: 'string' },
        options: { type: 'array', items: { type: 'string' } },
        recommended: { type: 'string' },
      },
    },
  },
}

const { waveId, repoRoot, rosterSummary, members, routing } = args
const autonomy = args.autonomy || 'gated'
if (!Array.isArray(members) || members.length === 0) throw new Error('args.members must be a non-empty array')
const roles = (routing && routing.roles) || {}
const pick = (r) => (r ? { ...(r.model ? { model: r.model } : {}), ...(r.effort ? { effort: r.effort } : {}) } : {})
log(`planning ${members.length} member(s) of ${waveId} (${autonomy})`)

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
  agent(auditPrompt(m), { agentType: 'brief-auditor', schema: AUDIT_SCHEMA, label: `audit:${m.sprint}${round > 1 ? ' (re-audit)' : ''}`, phase: 'Audit', ...pick(roles['brief-auditor']) })

const certifiable = (v) => v.verdict === 'READY' || v.verdict === 'READY_WITH_QUESTIONS'

const results = await pipeline(
  members,
  // Stage 1 — plan.
  (m) => agent(plannerPrompt(m), { agentType: 'sprint-planner', schema: VERDICT_SCHEMA, label: `plan:${m.sprint}`, phase: 'Plan', ...pick(roles.planner) }),
  // Stage 2 — cold read; one repair round when the brief is insufficient.
  async (v, m) => {
    if (!v) return null
    if (!certifiable(v)) return { sprint: m.sprint, ...v, audit: null }
    let a = await audit(m, 1)
    if (a && a.verdict === 'INSUFFICIENT') {
      log(`${m.sprint}: brief insufficient (${a.blocking.length} blocking) — one planner repair round`)
      const repaired = await agent(plannerPrompt(m, a.blocking), { agentType: 'sprint-planner', schema: VERDICT_SCHEMA, label: `repair:${m.sprint}`, phase: 'Plan', ...pick(roles.planner) })
      if (repaired) v = repaired
      if (certifiable(v)) a = (await audit(m, 2)) || a
    }
    // audit === null means the auditor never returned: unaudited, which is not SUFFICIENT.
    return { sprint: m.sprint, ...v, audit: a || { verdict: 'INSUFFICIENT', lint: '', blocking: ['brief-auditor did not return — brief is unaudited'], assumptions: [] } }
  },
  // Stage 3 — rulings on open questions. A question is never silently dropped: without a
  // ruling (interactive run, or an arbiter that did not return) it is the user's.
  async (v, m) => {
    if (!v) return null
    const questions = v.questions || []
    if (autonomy === 'interactive' || questions.length === 0) return { ...v, questions: questions.map((q) => ({ ...q, ruling: null })) }
    const rulings = await parallel(
      questions.map((q) => () =>
        agent(
          `You are the arbiter subagent. Follow your agent instructions (.claude/agents/arbiter.md) and docs/DECISION_POLICY.md.

A sprint-planner left this question open while planning **${m.sprint}**. Classify it and, if it is mechanical or taste, decide it.

- Sprint file: ${m.file}
- Repo root: ${repoRoot}
- Autonomy mode of this run: ${autonomy}
- Mode tag for your RECORD line (one word, exactly): wave
- Question ${q.id}: ${q.question}
- Options: ${(q.options || []).join(' | ')}
- The planner recommends: ${q.recommended}

Return via the structured output.`,
          { agentType: 'arbiter', schema: RULING_SCHEMA, label: `decide:${m.sprint}:${q.id}`, phase: 'Decide', ...pick(roles.arbiter) },
        ),
      ),
    )
    return { ...v, questions: questions.map((q, i) => ({ ...q, ruling: rulings[i] || null })) }
  },
)

const missing = members.filter((_, i) => !results[i]).map((m) => m.sprint)
if (missing.length) log(`planner(s) died for: ${missing.join(', ')} — re-dispatch or --drop them`)
const verdicts = results.filter(Boolean)
const uncertified = verdicts.filter((v) => certifiable(v) && v.audit && v.audit.verdict !== 'SUFFICIENT').map((v) => v.sprint)
if (uncertified.length) log(`audit INSUFFICIENT after repair: ${uncertified.join(', ')} — reset their plan_date (ORCHESTRATION 2c)`)

// What the orchestrator writes into sprint files as decided, and what it must ask.
const decided = []
const ask = []
for (const v of verdicts) {
  for (const q of v.questions || []) {
    const r = q.ruling
    if (r && r.class !== 'reserved' && r.record) decided.push({ sprint: v.sprint, id: q.id, class: r.class, decision: r.decision, principle: r.principle, rejected: r.rejected || '', undo: r.undo || '', record: r.record })
    else if (r && r.class === 'reserved' && r.ask_user) ask.push({ sprint: v.sprint, id: q.id, class: 'reserved', ...r.ask_user })
    else ask.push({ sprint: v.sprint, id: q.id, class: r ? r.class : 'unclassified', question: q.question, stake: '', options: q.options || [], recommended: q.recommended || '' })
  }
}
log(`decisions: ${decided.length} decided by the arbiter (${decided.filter((d) => d.class === 'taste').length} taste), ${ask.length} for the user`)
return { waveId, verdicts, missing, uncertified, decided, ask }
