import { terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { terminalCandidateFacts } from '../../api/lib/agent/terminal-fact-identity.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { bindLegacyContinuityAssessment, legacyContinuityAssessmentKey, type LegacyAssessmentInput } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { stageTerminalProposals } from '../../api/lib/agent/terminal-proposal-review.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import type { TerminalCandidate } from '../../api/lib/agent/terminal-state-review.js'

export function terminalDraftFixture(field = 'openLoops', options?: {
  chapter: { id: string; revision: number; orderIndex: number; content: string }; taskId: string; ctx: Pick<ToolContext, 'userId' | 'novelId' | 'runId'>;
  compilationId: string; candidate: TerminalCandidate; originBindingHash: string; currentBindingHash: string
}) {
  const chapter = options?.chapter ?? { id: 'chapter', revision: 4, orderIndex: 1, content: 'The packet remains sealed.' }, taskId = options?.taskId ?? 'task'
  const ctx = { ...(options?.ctx ?? { userId: 'owner', novelId: 'novel', runId: 'run' }), callId: 'origin' } as ToolContext
  const base = terminalCandidateSchema.parse(field === 'lastUnfinishedAction' ? { exitState: {}, lastUnfinishedAction: 'A reply remains pending.' }
    : { exitState: { [field]: ['A reply remains pending.'] } })
  const candidate = options?.candidate ?? terminalCandidateSchema.parse({ exitState: { objects: [chapter.content] } })
  const context = terminalEvidenceContext(chapter, null, 2, 1, { version: 2, taskId, chapterId: chapter.id, obligations: [] }, 6, 2)
  const bodies = { previous: null, current: chapter.content, terminalEvidence: context }, sourceScope = { currentOrderIndex: chapter.orderIndex, previous: [] }
  const input: LegacyAssessmentInput = { chapterId: chapter.id, revision: chapter.revision, bodies, terminalCandidate: base, parserVersion: 8,
    sourceScope, reassessmentProtocol: 5, bindingHash: options?.originBindingHash ?? 'b'.repeat(64), system: 'Synthetic frozen reviewer.', content: 'Synthetic original request.', targetType: 'story_compilation', targetId: options?.compilationId ?? 'compilation' }
  const checks = ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear', reason: 'Synthetic full-body independent review.', findingIndexes: [] }))
  const originWire = { findings: [], semanticChecks: checks, terminalVerdicts: terminalCandidateFacts(base).map((_, claimIndex) => ({ claimIndex, verdict: 'unknown', sourceEvidence: [] })),
    terminalProofVerdicts: [], terminalDispositions: [] }
  const inspect = (wire: unknown, frozen: LegacyAssessmentInput) => inspectContinuityResponse(JSON.stringify(wire), frozen.bodies, true, 8, frozen.terminalCandidate, frozen.sourceScope, { responseContract: 3 })
  const origin = inspect(originWire, input), bound = bindLegacyContinuityAssessment(origin, ctx, input)
  const staged = stageTerminalProposals({ preparedContext: {}, identity: { taskId, chapterId: chapter.id, bodyHash: context.current.contentHash,
    sourceHash: runtimeJson({ previous: null }).hash }, auditHash: runtimeJson(bound.audit).hash, base, candidate, verifiedFactIds: [] })!
  const nextContext = { ...context, proposalChanges: staged.changes! }, nextInput = { ...input, bodies: { ...bodies, terminalEvidence: nextContext }, terminalCandidate: candidate,
    bindingHash: options?.currentBindingHash ?? input.bindingHash, content: 'Synthetic current request.' }
  const currentWire = { findings: [], semanticChecks: checks, terminalVerdicts: terminalCandidateFacts(candidate).map((fact, claimIndex) => ({ claimIndex,
    verdict: 'supported', sourceEvidence: [{ segmentId: `c${Math.floor(Math.max(0, chapter.content.indexOf(fact.claim)) / 300)}` }] })),
    terminalProofVerdicts: [], terminalDispositions: [], proposalDispositions: [{ proposalIndex: 0, outcome: 'unknown', reason: 'The old draft was not established.', sourceEvidence: [] }] }
  const current = inspect(currentWire, nextInput), currentBound = bindLegacyContinuityAssessment(current, { ...ctx, callId: 'current' }, nextInput)
  const preparedContext = { terminalProposalReview: staged.state }, binding = { taskId, preparedContext }
  const validation = { independentCheck: 'complete', terminalCandidate: candidate, continuityCriticResponse: currentBound.audit }
  const rows: Array<{ id: string; runId: string; artifactType: string; createdAt: Date; metadata: Record<string, unknown> }> = []
  const usage: Array<Record<string, unknown>> = []
  const add = (callId: string, frozen: LegacyAssessmentInput, wire: unknown, audit = inspect(wire, frozen).audit) => {
    const key = legacyContinuityAssessmentKey({ ...ctx, callId }, frozen), usageId = `usage-${callId}`
    const at = new Date(rows.length + 1)
    for (const [suffix, metadata] of Object.entries({ reservation: { continuityAssessmentRequestKey: key, assessmentChapterId: chapter.id, callId, input: frozen },
      owner: { assessmentRequestOwnerKey: key, callId, stage: 'first', usageIds: [usageId] },
      response: { assessmentKey: key, assessmentResponseKey: key, callId, stage: 'first', usageIds: [usageId], input: frozen, audit,
        response: { content: JSON.stringify(JSON.stringify(wire)), encoding: 'json-string', transportComplete: true, finishReason: 'stop', toolCalls: [] } } })) {
      rows.push({ id: `${callId}-${suffix}`, runId: ctx.runId, artifactType: 'continuityReview', createdAt: at, metadata: { version: 1, ...metadata } })
    }
    usage.push({ id: usageId, userId: ctx.userId, novelId: ctx.novelId, agentRunId: ctx.runId, chapterId: chapter.id, targetType: frozen.targetType, targetId: frozen.targetId,
      action: 'agent3ContinuityCritic', usageSource: 'reported', billingStatus: 'settled', requestTokens: 12, responseTokens: 8, reservedCreditMilli: 0, creditChargeMilli: 23 })
  }
  add('origin', input, originWire); add('current', nextInput, currentWire)
  return { chapter, ctx, base, candidate, context, nextContext, input, nextInput, originWire, currentWire, origin, bound, validation, preparedContext, binding,
    proposal: staged.changes!.proposals[0], rows, usage, add, inspect }
}
