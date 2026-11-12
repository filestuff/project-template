// Design review panel — the workflow behind /proposal Step 6 and /plan Phase 4.
// (A Workflow-tool script, not a Node module: it uses top-level await and return, and it
// must keep its .js extension — saved workflows are not discovered as .mjs.)
//
// One `design-reviewer` per lens, in parallel and blind to each other; then every
// blocker/major finding goes to a `finding-verifier` told to refute it. Each lens flows
// review → verify on its own (pipeline, no barrier), so a fast lens never waits for a
// slow one. The script decides nothing a human should: it returns scores, the findings
// that survived verification, and whether the gate passed. Applying fixes, asking the
// user, and writing the `## Review record` stay with the calling skill.
//
// Invoke as:
//   Workflow({ name: "design-review", args: {
//     kind: "proposal" | "plan",
//     artifact: "/abs/path/docs/proposals/NNN-title.md",   // proposal, or the plan source
//     repoRoot: "/abs/repo/root",
//     lenses: ["feasibility", "architecture", "scope"],     // see docs/proposals/review-lenses.md
//     sprintFiles: ["/abs/path/docs/sprints/backlog/S-012-x.md"]  // kind "plan" only
//   } })
//
// Returns { pass, lenses: [{ lens, score, summary, died, findings: [...] }],
//           failing: [lens...], counts: { raised, confirmed, refuted, downgraded, unverified } }
//
// Models and effort come from the agent definitions (.claude/agents/design-reviewer.md,
// finding-verifier.md). No shell, clock or file access here — agents do the reading.
export const meta = {
  name: 'design-review',
  description: 'Review a proposal or plan through independent lenses, verify each finding, report the gate',
  whenToUse: 'Called by /proposal (Step 6) and /plan (Phase 4) — not for code diffs',
  phases: [
    { title: 'Review', detail: 'one design-reviewer per lens, blind to the others' },
    { title: 'Verify', detail: 'one finding-verifier per blocker/major finding' },
  ],
}

const PASS_SCORE = 7

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lens', 'score', 'findings', 'summary'],
  properties: {
    lens: { type: 'string' },
    score: { type: 'integer', minimum: 1, maximum: 10 },
    summary: { type: 'string', description: 'one sentence — what this lens thinks of the artifact' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'claim', 'evidence', 'fix'],
        properties: {
          severity: { enum: ['blocker', 'major', 'minor'] },
          claim: { type: 'string', description: 'one sentence' },
          evidence: { type: 'string', description: 'file:line "quoted text" | section name | search that came up empty | unverified' },
          fix: { type: 'string', description: 'the concrete change to the artifact' },
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
    evidence: { type: 'string', description: 'file:line "quoted text" or section that decides it' },
    note: { type: 'string', description: 'one sentence' },
  },
}

const { kind, artifact, repoRoot, lenses, sprintFiles } = args
if (kind !== 'proposal' && kind !== 'plan') throw new Error('args.kind must be "proposal" or "plan"')
if (!artifact || !repoRoot) throw new Error('args.artifact and args.repoRoot are required')
if (!Array.isArray(lenses) || lenses.length === 0) throw new Error('args.lenses must be a non-empty array')

const subject =
  kind === 'plan'
    ? `the plan breakdown: source ${artifact}; sprint files produced from it:\n${(sprintFiles || []).map((f) => `  - ${f}`).join('\n')}`
    : `the proposal at ${artifact}`

log(`design-review (${kind}): ${lenses.length} lens(es) — ${lenses.join(', ')}`)

const reviewed = await pipeline(
  lenses,
  // Stage 1 — one reviewer per lens.
  (lens) =>
    agent(
      `You are the design-reviewer subagent. Follow your agent instructions (.claude/agents/design-reviewer.md).

- Lens: **${lens}** (defined in ${repoRoot}/docs/proposals/review-lenses.md — read it first)
- Review ${subject}
- Repo root: ${repoRoot}

Review through this one lens only and return your result via the structured output.`,
      { agentType: 'design-reviewer', schema: REVIEW_SCHEMA, label: `review:${lens}`, phase: 'Review' },
    ),
  // Stage 2 — refute each load-bearing finding. Minor findings are reported, never gating,
  // so they are not worth a verifier.
  async (review, lens) => {
    if (!review) return { lens, died: true, score: null, summary: 'reviewer did not return', findings: [] }
    const findings = await parallel(
      review.findings.map((f, i) => async () => {
        if (f.severity === 'minor') return { ...f, verdict: 'not-verified-minor' }
        const v = await agent(
          `You are the finding-verifier subagent. Follow your agent instructions (.claude/agents/finding-verifier.md).

A reviewer applying the "${lens}" lens to ${subject} raised this finding. Try to refute it.

- Severity claimed: ${f.severity}
- Claim: ${f.claim}
- Evidence cited: ${f.evidence}
- Proposed fix: ${f.fix}
- Repo root: ${repoRoot}

Return your verdict via the structured output (use downgrade-major / downgrade-minor when the gap is real but filed too high).`,
          { agentType: 'finding-verifier', schema: VERDICT_SCHEMA, label: `verify:${lens}#${i + 1}`, phase: 'Verify' },
        )
        // A verifier that died proves nothing either way — carry the finding as unverified.
        if (!v) return { ...f, verdict: 'unverified', verifier_note: 'verifier did not return' }
        const severity = v.verdict === 'downgrade-major' ? 'major' : v.verdict === 'downgrade-minor' ? 'minor' : f.severity
        return { ...f, severity, raised_as: f.severity, verdict: v.verdict, verifier_evidence: v.evidence, verifier_note: v.note }
      }),
    )
    // parallel() turns a thrown thunk into null; keep the original finding rather than lose it.
    const kept = findings.map((r, i) => r || { ...review.findings[i], verdict: 'unverified', verifier_note: 'verification failed' })
    return { lens, died: false, score: review.score, summary: review.summary, findings: kept }
  },
)

// A lens dropped to null by a thrown stage is a lens that did not run — never a pass.
const results = reviewed.map((r, i) => r || { lens: lenses[i], died: true, score: null, summary: 'lens did not complete', findings: [] })

const all = results.flatMap((r) => r.findings)
const counts = {
  raised: all.length,
  confirmed: all.filter((f) => f.verdict === 'confirmed').length,
  refuted: all.filter((f) => f.verdict === 'refuted').length,
  downgraded: all.filter((f) => String(f.verdict).startsWith('downgrade')).length,
  unverified: all.filter((f) => f.verdict === 'unverified').length,
}

const standing = (f) => f.verdict !== 'refuted'
const failing = results
  .filter((r) => r.died || r.score < PASS_SCORE || r.findings.some((f) => standing(f) && f.severity === 'blocker' && f.verdict === 'confirmed'))
  .map((r) => r.lens)

for (const r of results) {
  const kept = r.findings.filter(standing).length
  log(r.died ? `${r.lens}: did not run` : `${r.lens}: ${r.score}/10 — ${kept} finding(s) standing, ${r.findings.length - kept} refuted`)
}

return {
  pass: failing.length === 0,
  pass_score: PASS_SCORE,
  failing,
  lenses: results.map((r) => ({ ...r, findings: r.findings.filter(standing), refuted: r.findings.filter((f) => !standing(f)) })),
  counts,
}
