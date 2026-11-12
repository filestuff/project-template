// sprint-flow — one started sprint, from execution to "ready to land".
// (A Workflow-tool script, not a Node module: top-level await and return. It must keep its
// .js extension — saved workflows are not discovered as .mjs.)
//
// The orchestrator launches ONE run per started sprint, all in one message. Each run
// notifies it separately when it ends, so a sprint that finishes early lands while its
// neighbours are still executing — there is no barrier across sprints.
//
// Inside a run, in order:
//   Execute  the `sprint-executor`, on the model AND effort routing.json gives the
//            sprint's tier (routine | standard | complex | critical — tier-rubric.md).
//            BLOCKED  → the `arbiter` decides (mechanical / taste) and a fresh executor
//                       continues from the branch with the answer; a reserved decision
//                       parks the sprint for the user.
//            ESCALATE → the next tier in routing.escalation continues from the branch.
//            died     → one re-dispatch.
//            NEEDS_CLAIM / PLAN_GAP → returned: only the orchestrator may touch main.
//   Review   independent of the author, chosen here and not by the executor: one
//            `reviewer` always; three focused lenses when the sprint is `risk: high`.
//            The reviewer's model and effort follow the tier the sprint FINISHED on —
//            a sprint that escalated is reviewed at the level that completed it.
//   Verify   every Critical / Important finding goes to a `finding-verifier` told to
//            refute it.
//   Fix      the executor fixes what survived, re-gates, commits; reviewers re-check.
//            At most two rounds; anything still standing parks the sprint.
//
// Agents spawned by a workflow cannot spawn children, which is why review, advice and
// escalation live in this script and not inside the executor. This script has no shell,
// clock or file access; it never runs lifecycle scripts — it returns, and the orchestrator
// lands (ORCHESTRATION.md Step 5).
//
// Invoke as:
//   Workflow({ name: "sprint-flow", args: {
//     waveId: "W-…", repoRoot: "/abs/repo", ledgerDir: "/abs/repo/.claude/sprint-orchestration/W-…/",
//     mode: "wave" | "train", autonomy: "gated" | "interactive" | "unattended",
//     sprint: { id: "S-NNN", worktree: "/abs/repo/.claude/worktrees/S-NNN-…",
//               risk: "low" | "high",
//               tier: "routine" | "standard" | "complex" | "critical",   // where to start
//               assignedTier: "standard",     // re-launch only: the frontmatter tier, when
//                                             //   `tier` is the rung the last run reached
//               attempt: 2,                   // re-launch only: 1-based run count
//               diffBase: "<sha>" },          // train mode only: the predecessor's boundary
//     routing: <contents of scripts/sprint/routing.json>,
//     resume: "claim granted for src/x.ts — mirror it in your branch copy and proceed"
//   } })                                      // resume: optional, when re-launching a parked sprint
//
// Returns { sprint, status, tier, tier_assigned, outcome, commits, gate, close_check,
//           review, review_record, decisions, escalations, question, needs_claim_paths,
//           plan_gap, concerns }
//   status: READY_TO_LAND | PARKED | NEEDS_CLAIM | PLAN_GAP | DIED
//   tier:   the tier the run ended on (pass it back as sprint.tier when re-launching)
//   outcome: one line for the done-file's `outcome:` frontmatter (tiers.mjs reads it)
export const meta = {
  name: 'sprint-flow',
  description: 'Run one started sprint: execute, arbitrate or escalate as needed, review independently, verify findings, fix',
  whenToUse: 'Launched by /sprint wave and /sprint train, one run per started sprint (ORCHESTRATION.md Step 4)',
  phases: [
    { title: 'Execute', detail: 'sprint-executor on the routed tier; arbiter on BLOCKED, next tier on ESCALATE' },
    { title: 'Review', detail: 'independent reviewer(s), chosen by risk' },
    { title: 'Verify', detail: 'one finding-verifier per Critical/Important finding' },
    { title: 'Fix', detail: 'executor fixes surviving findings; reviewers re-check (max 2 rounds)' },
  ],
}

const MAX_ARBITER_ROUNDS = 2
const MAX_FIX_ROUNDS = 2

const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'sprint', 'worktree', 'commits', 'gate', 'close_check', 'concerns'],
  properties: {
    status: { enum: ['DONE', 'BLOCKED', 'NEEDS_CLAIM', 'PLAN_GAP', 'ESCALATE'] },
    sprint: { type: 'string', description: 'your sprint id, S-NNN' },
    worktree: { type: 'string', description: 'the absolute worktree path you worked in' },
    commits: { type: 'array', items: { type: 'string' }, description: 'git log --oneline lines for your commits on the branch' },
    gate: { type: 'string', description: 'the literal last line of gate.sh output ("" if not run)' },
    close_check: { type: 'string', description: 'DONE: the SUMMARY line from close-check.mjs on the sprint file ("" otherwise)' },
    concerns: { type: 'string', description: 'anything the orchestrator should know; "" if none' },
    question: {
      type: 'object',
      additionalProperties: false,
      required: ['question', 'context', 'options', 'default'],
      description: 'BLOCKED only',
      properties: {
        question: { type: 'string' },
        context: { type: 'string', description: 'file:line, what was tried' },
        options: { type: 'array', items: { type: 'string' } },
        default: { type: 'string', description: 'what you would do if forced to choose' },
      },
    },
    needs_claim_paths: { type: 'array', items: { type: 'string' }, description: 'NEEDS_CLAIM only: the unclaimed repo-relative paths' },
    plan_gap: { type: 'string', description: 'PLAN_GAP only: gaps + evidence + proposed correction (≤10 lines)' },
    escalation: {
      type: 'object',
      additionalProperties: false,
      required: ['reason', 'tried', 'state', 'next'],
      description: 'ESCALATE only: the handover for a stronger executor',
      properties: {
        reason: { enum: ['repeated-failure', 'beyond-capability', 'carve-out-uncertainty'] },
        tried: { type: 'string' },
        state: { type: 'string' },
        next: { type: 'string' },
      },
    },
    fixes: {
      type: 'array',
      description: 'review-fix rounds only: one entry per finding you were handed',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'disposition', 'detail'],
        properties: {
          id: { type: 'string', description: 'the finding id you were given, e.g. F1' },
          disposition: { enum: ['fixed', 'disputed'] },
          detail: { type: 'string', description: 'fixed: the commit sha; disputed: the evidence (file:line) that the finding is wrong' },
        },
      },
    },
  },
}

const ARBITER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['class', 'decision', 'principle', 'needs', 'needs_detail', 'record'],
  properties: {
    class: { enum: ['mechanical', 'taste', 'reserved'] },
    decision: { type: 'string', description: 'the chosen option as an instruction ("" when reserved)' },
    principle: { type: 'string' },
    rejected: { type: 'string' },
    undo: { type: 'string' },
    needs: { enum: ['none', 'claim', 'scope'], description: 'what acting on the decision requires' },
    needs_detail: { type: 'string', description: 'the path(s) to claim, or the scope change; "" for none' },
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

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'summary'],
  properties: {
    summary: { type: 'string', description: 'one sentence; "no material issues found" when clean' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'confidence', 'location', 'quote', 'description', 'fix'],
        properties: {
          severity: { enum: ['Critical', 'Important', 'Minor'] },
          confidence: { type: 'integer', minimum: 1, maximum: 10 },
          location: { type: 'string', description: 'file:line' },
          quote: { type: 'string', description: 'the verbatim line(s) that motivate the finding' },
          description: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'evidence', 'note'],
  properties: {
    verdict: { enum: ['confirmed', 'refuted', 'downgrade-major', 'downgrade-minor', 'unverified'] },
    evidence: { type: 'string' },
    note: { type: 'string' },
  },
}

const RECHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['resolved', 'evidence'],
  properties: {
    resolved: { type: 'boolean', description: 'true iff the finding no longer holds at the branch HEAD' },
    evidence: { type: 'string', description: 'file:line "quoted text" at HEAD that decides it' },
  },
}

// ------------------------------------------------------------------ arguments
const { waveId, repoRoot, ledgerDir, sprint, routing, resume } = args
const mode = args.mode || 'wave'
const autonomy = args.autonomy || 'gated'
if (!sprint || !/^S-\d+$/.test(sprint.id || '') || !sprint.worktree) throw new Error('args.sprint needs id (S-NNN) and worktree')
if (!repoRoot || !routing || !routing.roles || !Array.isArray(routing.escalation)) throw new Error('args.repoRoot and args.routing (scripts/sprint/routing.json) are required')
const id = sprint.id
const wt = sprint.worktree
const highRisk = sprint.risk === 'high'

const role = (path) => path.split('.').reduce((o, k) => (o ? o[k] : undefined), routing.roles)
const pick = (r) => (r ? { ...(r.model ? { model: r.model } : {}), ...(r.effort ? { effort: r.effort } : {}) } : {})
// Where on the escalation ladder this sprint starts. A tier the table does not know (a
// typo, or a routing.json older than the tier) starts at `standard` — never at the bottom:
// starting too low is the expensive mistake.
const TIERS = ['routine', 'standard', 'complex', 'critical']
const known = (t) => Boolean(role(`executor.${t}`)) && routing.escalation.includes(`executor.${t}`)
const ladderTop = (routing.escalation[routing.escalation.length - 1] || 'executor.standard').split('.').pop()
// Unknown and BELOW standard → standard; unknown and ABOVE standard → the top of the ladder.
const startTier = known(sprint.tier) ? sprint.tier : TIERS.indexOf(sprint.tier) > TIERS.indexOf('standard') ? ladderTop : 'standard'
const assignedTier = TIERS.includes(sprint.assignedTier) ? sprint.assignedTier : startTier
if (sprint.tier && sprint.tier !== startTier) log(`${id}: tier "${sprint.tier}" is not in routing.json — running as ${startTier}`)
let rung = routing.escalation.indexOf(`executor.${startTier}`)
if (rung < 0) rung = Math.max(0, routing.escalation.indexOf('executor.standard'))
const tierName = () => routing.escalation[rung] || `executor.${startTier}`
const tier = () => tierName().split('.').pop()
// The reviewer follows the tier the sprint is on NOW (after any escalation). An older
// routing.json has one reviewer entry for every tier — accept that shape too.
const reviewerRole = () => {
  const r = routing.roles.reviewer
  return r && (r.model || r.effort) ? r : (r && (r[tier()] || r.standard)) || undefined
}
// One lens of the high-risk three-lens review may be routed apart from the tier's reviewer
// (routing.roles.reviewer_lens.<lens key>) — except on the tiers its `except` lists.
const lensRole = (lens) => {
  const o = routing.roles.reviewer_lens && routing.roles.reviewer_lens[lens.key]
  return o && (o.model || o.effort) && !(Array.isArray(o.except) && o.except.includes(tier())) ? o : reviewerRole()
}
const attempt = Number.isInteger(sprint.attempt) && sprint.attempt > 0 ? sprint.attempt : 1

const decisions = []
const escalations = []
const diffSpec = mode === 'train' && sprint.diffBase ? `git -C "${wt}" diff ${sprint.diffBase}..HEAD` : `git -C "${wt}" diff main...HEAD`

const base = `- Sprint: **${id}**
- Worktree (work ONLY here, via git -C / absolute paths): ${wt}
- Repo root: ${repoRoot}
- Wave ledger dir (your pointer report goes here): ${ledgerDir || `${repoRoot}/.claude/sprint-orchestration/${waveId}/`}
- Mode: ${mode}${mode === 'train' && sprint.diffBase ? ` (diff-base SHA ${sprint.diffBase} — never rewrite commits before it)` : ''}`

const executorPrompt = (directive) =>
  `You are the sprint-executor subagent for sprint **${id}** — follow your agent instructions (.claude/agents/sprint-executor.md).

${base}
${
  directive
    ? `
**You are continuing this sprint, not starting it.** Read \`git -C "${wt}" log --oneline\` and the sprint file's Pre-Sprint Decisions first — committed work persists on the branch; do not redo it.

${directive}`
    : `
Execute the sprint per your instructions.`
}

Return your status via the structured output (always include your sprint id and worktree path).`

let arbiterCalls = 0
// One line for the done-file's `outcome:` frontmatter — what tiers.mjs calibrates on.
const outcome = (review) =>
  `assigned=${assignedTier} final=${tier()} runs=${attempt} escalations=${escalations.length} arbiter=${arbiterCalls} fix_rounds=${review ? review.rounds : 0} findings=${review ? review.counts.confirmed : 0}/${review ? review.counts.raised : 0}`

const result = (status, last, extra) => ({
  sprint: id,
  status,
  tier: tier(),
  tier_assigned: assignedTier,
  outcome: outcome(extra && extra.review),
  commits: (last && last.commits) || [],
  gate: (last && last.gate) || '',
  close_check: (last && last.close_check) || '',
  concerns: (last && last.concerns) || '',
  review: null,
  review_record: [],
  decisions,
  escalations,
  ...extra,
})

const askArbiter = (question, where) => {
  arbiterCalls++
  return agent(
    `You are the arbiter subagent. Follow your agent instructions (.claude/agents/arbiter.md) and docs/DECISION_POLICY.md.

${where}
- Sprint file: the single file matching ${wt}/docs/sprints/in-progress/${id}-*.md
- Repo root: ${repoRoot}
- Autonomy mode of this run: ${autonomy}
- Mode tag for your RECORD line (one word, exactly): ${mode}

${question}

Classify and decide per the policy, and return via the structured output. If acting on your decision needs a file outside the sprint's touches:, set needs to "claim" and name the path(s); if it changes the sprint's scope, set needs to "scope".`,
    { agentType: 'arbiter', schema: ARBITER_SCHEMA, label: `arbiter:${id}`, phase: 'Execute', ...pick(role('arbiter')) },
  )
}

// ------------------------------------------------------------------ Execute
let last = null
let directive = resume ? `The orchestrator resolved what stopped the previous run:\n${resume}` : null
let arbiterRounds = 0
let died = 0

for (;;) {
  last = await agent(executorPrompt(directive), { agentType: 'sprint-executor', schema: STATUS_SCHEMA, label: `exec:${id}`, phase: 'Execute', ...pick(role(tierName())) })

  if (!last) {
    if (++died > 1) return result('DIED', null, { concerns: 'executor died twice — committed work persists on the branch' })
    log(`${id}: executor died — one re-dispatch from the branch`)
    directive = 'The previous executor for this sprint died mid-run. Continue from the branch.'
    continue
  }

  if (last.status === 'DONE') break
  if (last.status === 'NEEDS_CLAIM') return result('NEEDS_CLAIM', last, { needs_claim_paths: last.needs_claim_paths || [] })
  if (last.status === 'PLAN_GAP') return result('PLAN_GAP', last, { plan_gap: last.plan_gap || '' })

  if (last.status === 'BLOCKED') {
    const q = last.question || { question: last.concerns || 'executor returned BLOCKED without a question', context: '', options: [], default: '' }
    if (autonomy === 'interactive') return result('PARKED', last, { question: { ...q, from: 'executor', reason: 'interactive mode — every non-mechanical decision is the user’s' } })
    if (++arbiterRounds > MAX_ARBITER_ROUNDS) return result('PARKED', last, { question: { ...q, from: 'executor', reason: `still blocked after ${MAX_ARBITER_ROUNDS} arbiter decisions` } })
    const a = await askArbiter(
      `A sprint-executor is BLOCKED on a decision it may not make.\n- Question: ${q.question}\n- Context: ${q.context}\n- Options it sees: ${(q.options || []).join(' | ') || '(none given)'}\n- What it would do if forced: ${q.default}`,
      '',
    )
    if (!a) return result('PARKED', last, { question: { ...q, from: 'executor', reason: 'arbiter did not return' } })
    if (a.class === 'reserved') return result('PARKED', last, { question: { ...(a.ask_user || q), from: 'arbiter', class: 'reserved', reason: 'reserved decision — the user’s in every mode' } })
    if (a.record) decisions.push(a.record)
    if (a.needs === 'claim') return result('NEEDS_CLAIM', last, { needs_claim_paths: [a.needs_detail], concerns: `arbiter decided: ${a.decision} — needs the claim first` })
    if (a.needs === 'scope') return result('PARKED', last, { question: { question: `Arbiter's answer changes the sprint's scope: ${a.needs_detail}`, stake: a.principle, options: [a.decision, q.default].filter(Boolean), recommended: a.decision, from: 'arbiter', class: 'reserved', reason: 'scope change' } })
    log(`${id}: arbiter decided (${a.class}) — continuing`)
    directive = `You returned BLOCKED; the arbiter has decided (${a.class}).\nANSWER: ${a.decision}\nPrinciple: ${a.principle}\nRecord this line verbatim in the sprint file's Pre-Sprint Decisions and include it in your next commit:\n${a.record}`
    continue
  }

  if (last.status === 'ESCALATE') {
    const e = last.escalation || { reason: 'beyond-capability', tried: last.concerns || '', state: '', next: '' }
    let advice = ''
    // A doubt at a carve-out is a question first and a capability gap second.
    if (e.reason === 'carve-out-uncertainty' && autonomy !== 'interactive') {
      const a = await askArbiter(`A sprint-executor escalated with carve-out uncertainty (a trust boundary, a data-loss path, auth).\n- What it tried: ${e.tried}\n- Branch state: ${e.state}\n- The question to settle: ${e.next}`, '')
      if (a && a.class === 'reserved') return result('PARKED', last, { question: { ...(a.ask_user || { question: e.next }), from: 'arbiter', class: 'reserved', reason: 'carve-out decision' } })
      if (a && a.record) {
        decisions.push(a.record)
        advice = `\nThe arbiter has ruled on the open question (${a.class}): ${a.decision}\nRecord verbatim in Pre-Sprint Decisions: ${a.record}`
      }
    }
    const from = tier()
    if (rung + 1 >= routing.escalation.length) {
      return result('PARKED', last, { question: { question: `${id} escalated past the top of the routing ladder (${from}): ${e.next}`, context: `tried: ${e.tried} — state: ${e.state}`, options: [], default: '', from: 'executor', reason: `escalation exhausted (${e.reason})` } })
    }
    rung++
    escalations.push({ from, to: tier(), reason: e.reason })
    log(`${id}: ESCALATE (${e.reason}) — ${from} → ${tier()}`)
    directive = `The previous executor (${from}) escalated this sprint to you: ${e.reason}.\nTRIED: ${e.tried}\nSTATE: ${e.state}\nNEXT: ${e.next}${advice}\nLeave the sprint file's \`tier:\` as the planner assigned it — the orchestrator records the escalation at land.`
    continue
  }

  return result('PARKED', last, { question: { question: `executor returned an unknown status: ${last.status}`, from: 'executor', reason: 'protocol error' } })
}

// ------------------------------------------------------------------ Review → Verify → Fix
const LENSES = highRisk
  ? [
      { key: 'correctness', focus: 'correctness and logic — high-risk: deep pass. Trace the callers of changed shared code; run the failure-modes check per new codepath.' },
      { key: 'security', focus: 'security and data — auth and permissions, input crossing a trust boundary, secrets, irreversible data mutation, migrations, and any cross-sprint or public contract this diff changes. High-risk: deep pass.' },
      { key: 'tests', focus: 'tests — do they assert the observable behaviour the change introduces; was any test loosened, skipped or deleted to make the diff pass; is each acceptance criterion actually demonstrated.' },
    ]
  : [{ key: 'review', focus: 'the standard pass across correctness, security, tests and quality.' }]

const reviewPrompt = (lens) =>
  `You are the reviewer subagent. Follow your agent instructions (.claude/agents/reviewer.md).

- Worktree (read-only for you; operate via git -C and absolute paths, never EnterWorktree, never edit, never commit): ${wt}
- Review exactly this diff: \`${diffSpec}\`
- Sprint file (its acceptance criteria are the review target): the single file matching ${wt}/docs/sprints/in-progress/${id}-*.md
- Repo root: ${repoRoot}
- Focus: ${lens.focus}

Not findings: in the sprint file's Completion Log, the \`### Review\` line and the Close-checklist rows annotated \`pending\` (docs synced, new docs, ADR check, deployed) are settled by the orchestrator at land — they are pending by design.

You have been given nothing of the author's reasoning, on purpose. Return your findings via the structured output — every Critical/Important with its file:line and the verbatim quote that motivates it; an empty findings list when the diff is clean.`

const key = (f) => `${f.location}::${f.description}`.toLowerCase().replace(/\s+/g, ' ').slice(0, 160)

async function reviewAndVerify(round) {
  const reviews = await parallel(LENSES.map((lens) => () => agent(reviewPrompt(lens), { agentType: 'reviewer', schema: REVIEW_SCHEMA, label: `review:${id}:${lens.key}${round > 1 ? ` r${round}` : ''}`, phase: 'Review', ...pick(lensRole(lens)) })))
  const ran = LENSES.map((lens, i) => ({ lens: lens.key, ok: Boolean(reviews[i]), summary: reviews[i] ? reviews[i].summary : 'reviewer did not return' }))
  const seen = new Set()
  const raised = []
  reviews.forEach((r, i) => {
    for (const f of (r && r.findings) || []) {
      if (seen.has(key(f))) continue // two lenses raising the same line is one finding
      seen.add(key(f))
      raised.push({ ...f, lens: LENSES[i].key })
    }
  })
  const verified = await parallel(
    raised.map((f, i) => async () => {
      if (f.severity === 'Minor') return { ...f, verdict: 'not-verified-minor' }
      const v = await agent(
        `You are the finding-verifier subagent. Follow your agent instructions (.claude/agents/finding-verifier.md).

A code reviewer raised this finding on \`${diffSpec}\`. Try to refute it against the code at the branch HEAD.

- Severity claimed: ${f.severity} (code-review scale: Critical = correctness/security/data-loss bug; Important = will bite; Minor = note only). Map a downgrade to downgrade-major (→ Important) or downgrade-minor (→ Minor).
- Location: ${f.location}
- Quoted: ${f.quote}
- Claim: ${f.description}
- Proposed fix: ${f.fix}
- Worktree: ${wt}

Return your verdict via the structured output.`,
        { agentType: 'finding-verifier', schema: VERDICT_SCHEMA, label: `verify:${id}#${i + 1}`, phase: 'Verify', ...pick(role('finding-verifier')) },
      )
      if (!v) return { ...f, verdict: 'unverified' }
      const severity = v.verdict === 'downgrade-major' ? 'Important' : v.verdict === 'downgrade-minor' ? 'Minor' : f.severity
      return { ...f, severity, raised_as: f.severity, verdict: v.verdict, verifier_note: v.note }
    }),
  )
  const findings = verified.map((f, i) => f || { ...raised[i], verdict: 'unverified' })
  return { ran, findings }
}

const mustFix = (f) => f.verdict !== 'refuted' && (f.severity === 'Critical' || f.severity === 'Important')

let { ran, findings } = await reviewAndVerify(1)
const all = findings.map((f, i) => ({ ...f, id: `F${i + 1}`, disposition: f.verdict === 'refuted' ? 'refuted' : mustFix(f) ? 'open' : 'noted' }))
let rounds = 0

// A reviewer that never returned is a review that did not happen — never a clean pass.
const unreviewed = ran.filter((r) => !r.ok).map((r) => r.lens)

while (all.some((f) => f.disposition === 'open') && rounds < MAX_FIX_ROUNDS) {
  rounds++
  const open = all.filter((f) => f.disposition === 'open')
  log(`${id}: fix round ${rounds} — ${open.length} finding(s)`)
  const fix = await agent(
    executorPrompt(
      `An independent review of your branch raised these findings, each confirmed by a second agent (or left unverified — then check it yourself). Fix every one: change the code, re-run scripts/sprint/gate.sh, commit as \`${id}: address review — <finding>\`. Do not touch the sprint file's \`### Review\` section — the orchestrator records the review at land. If you are certain a finding is wrong, do not argue it in a commit: mark it \`disputed\` with the file:line evidence.

${open.map((f) => `${f.id} [${f.severity}${f.verdict === 'unverified' ? ', unverified' : ''}] ${f.location} — ${f.description}\n    quoted: ${f.quote}\n    suggested fix: ${f.fix}`).join('\n')}

Return status DONE with one \`fixes\` entry per finding id (fixed: the commit sha; disputed: your evidence).`,
    ),
    { agentType: 'sprint-executor', schema: STATUS_SCHEMA, label: `fix:${id} r${rounds}`, phase: 'Fix', ...pick(role(tierName())) },
  )
  if (!fix) {
    log(`${id}: fix executor died in round ${rounds}`)
    continue
  }
  if (fix.status === 'NEEDS_CLAIM') return result('NEEDS_CLAIM', fix, { needs_claim_paths: fix.needs_claim_paths || [], concerns: 'raised while fixing review findings' })
  last = { ...last, commits: fix.commits && fix.commits.length ? fix.commits : last.commits, gate: fix.gate || last.gate, close_check: fix.close_check || last.close_check }
  const byId = new Map((fix.fixes || []).map((x) => [x.id, x]))

  // Re-check each handed finding against the new HEAD — the author's "fixed" is a claim.
  const rechecked = await parallel(
    open.map((f) => async () => {
      const claim = byId.get(f.id)
      if (claim && claim.disposition === 'disputed') {
        // A disputed Critical is not the executor's call, nor this script's.
        const a = autonomy === 'interactive' ? null : await askArbiter(`An executor disputes a review finding. Decide on the evidence whether the finding stands.\n- Finding (${f.severity}) at ${f.location}: ${f.description}\n- Quoted by the reviewer: ${f.quote}\n- The executor's rebuttal: ${claim.detail}\nDECISION must begin with the word STANDS or OVERTURNED.`, `- Review diff: \`${diffSpec}\``)
        if (a && a.class !== 'reserved' && /^\s*OVERTURNED/i.test(a.decision)) {
          if (a.record) decisions.push(a.record)
          return { id: f.id, disposition: 'overturned', detail: a.principle }
        }
        return { id: f.id, disposition: 'open', detail: a ? `arbiter: finding stands — ${a.principle}` : 'disputed; not arbitrated' }
      }
      const r = await agent(
        `You are the finding-verifier subagent. Follow your agent instructions (.claude/agents/finding-verifier.md).

A review finding was reported fixed. Check the branch HEAD in ${wt} (\`${diffSpec}\`): does the finding still hold?

- Finding (${f.severity}) at ${f.location}: ${f.description}
- Originally quoted: ${f.quote}
- The author says: ${claim ? `fixed in ${claim.detail}` : 'nothing — no fix was reported for it'}

Return resolved=true only if the code at HEAD no longer has the problem; quote the line that decides it.`,
        { agentType: 'finding-verifier', schema: RECHECK_SCHEMA, label: `recheck:${id}:${f.id}`, phase: 'Fix', ...pick(role('finding-verifier')) },
      )
      if (r && r.resolved) return { id: f.id, disposition: 'fixed', detail: claim ? claim.detail : '' }
      return { id: f.id, disposition: 'open', detail: r ? r.evidence : 're-check did not return' }
    }),
  )
  for (const [i, r] of rechecked.entries()) {
    const f = all.find((x) => x.id === open[i].id)
    if (r) Object.assign(f, { disposition: r.disposition, detail: r.detail })
  }
}

// ------------------------------------------------------------------ result
const line = (f) => {
  const head = `- ${f.severity} (${f.lens}) ${f.location} — ${f.description}`
  if (f.disposition === 'fixed') return `${head} — fixed ${f.detail}`.trim()
  if (f.disposition === 'refuted') return `${head} — refuted on verification: ${f.verifier_note || ''}`.trim()
  if (f.disposition === 'overturned') return `${head} — overturned by arbiter: ${f.detail}`
  if (f.disposition === 'noted') return `${head} — declined: ${f.severity === 'Minor' ? 'minor, noted' : 'downgraded on verification'}`
  return `${head} — OPEN: ${f.detail || 'not resolved'}`
}
const stillOpen = all.filter((f) => f.disposition === 'open')
const review_record = all.length
  ? all.map(line)
  : [`— no material issues found (${ran.map((r) => r.lens).join(', ')}; independent review, ${highRisk ? 'high-risk deep pass' : 'standard pass'})`]
if (unreviewed.length) review_record.push(`- REVIEW INCOMPLETE — lens(es) that did not run: ${unreviewed.join(', ')}`)

const review = {
  lenses: ran,
  rounds,
  counts: {
    raised: all.length,
    // confirmed = stood after verification as Critical/Important, whatever happened next
    confirmed: all.filter((f) => ['fixed', 'open', 'overturned'].includes(f.disposition)).length,
    fixed: all.filter((f) => f.disposition === 'fixed').length,
    refuted: all.filter((f) => f.disposition === 'refuted').length,
    overturned: all.filter((f) => f.disposition === 'overturned').length,
    noted: all.filter((f) => f.disposition === 'noted').length,
    open: stillOpen.length,
  },
  findings: all.map((f) => ({ id: f.id, severity: f.severity, lens: f.lens, location: f.location, description: f.description, disposition: f.disposition, detail: f.detail || '' })),
}

if (stillOpen.length || unreviewed.length) {
  return result('PARKED', last, {
    review,
    review_record,
    question: {
      question: unreviewed.length && !stillOpen.length ? `${id}: the independent review did not complete (${unreviewed.join(', ')}) — land unreviewed, or re-run the review?` : `${id}: ${stillOpen.length} review finding(s) still stand after ${rounds} fix round(s) — fix further, accept, or spin a follow-up?`,
      context: stillOpen.map((f) => `${f.id} ${f.severity} ${f.location}: ${f.description}`).join(' | '),
      options: [],
      default: '',
      from: 'review',
      class: 'reserved',
      reason: 'landing with open Critical/Important findings, or without a review, weakens a check',
    },
  })
}
log(`${id}: ready to land — ${review.counts.raised} finding(s): ${review.counts.fixed} fixed, ${review.counts.refuted} refuted, ${review.counts.noted} noted`)
return result('READY_TO_LAND', last, { review, review_record })
