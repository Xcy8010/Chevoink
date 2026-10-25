import { terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { buildContinuityReviewManifest } from '../../api/lib/agent/continuity-review-v4.js'
import { manualReviewRepairOperationId } from '../../api/lib/agent/manual-review-repair-contract.js'
import { stageTerminalProposals } from '../../api/lib/agent/terminal-proposal-review.js'
import { terminalFactId } from '../../api/lib/agent/terminal-fact-identity.js'

/** Synthetic shape of a received failed pair. No author text or production IDs. */
export function manualRepairFixture() {
  const knowledge = Array.from({ length: 20 }, (_, i) => `Known K${i}.`)
  const loops = Array.from({ length: 25 }, (_, i) => `Route ${i} remains open.`)
  const content = knowledge.join(' ') + ' The parcel destination and deposit receipt remain questions.'
  const prior = loops.join(' '), priorHash = runtimeJson({ content: prior }).hash
  const candidate = terminalCandidateSchema.parse({ exitState: { knowledge, openLoops: loops } })
  const carried = loops.map((claim, i) => ({ proofHash: runtimeJson({ proof: i }).hash, segmentId: `t${i}`, field: 'openLoops', claim, depth: 1,
    anchors: [{ chapterId: 'previous', revision: 1, contentHash: priorHash, start: prior.indexOf(claim), end: prior.indexOf(claim) + claim.length, quote: claim }],
    nodes: [{ compilationId: 'previous-compilation', chapterId: 'previous', revision: 1, orderIndex: 2, bodyHash: priorHash,
      candidateHash: 'b'.repeat(64), validationHash: 'c'.repeat(64), stateHash: 'd'.repeat(64), path: `exitState.openLoops.${i}`, previousChapterId: null }] }))
  const previous = { id: 'previous', revision: 1, orderIndex: 2, contentHash: priorHash, start: 0, end: prior.length,
    joinedStart: 0, joinedEnd: prior.length, segments: [{ segmentId: 'p0', start: 0, end: prior.length, quote: prior, hash: runtimeJson({ text: prior }).hash }], carried }
  const identity = { taskId: 'task', chapterId: 'chapter', bodyHash: runtimeJson({ content }).hash, sourceHash: runtimeJson({ previous }).hash }
  const old = terminalCandidateSchema.parse({ exitState: { ...candidate.exitState, emotion: ['Unease remains.'] } })
  const staged = stageTerminalProposals({ preparedContext: {}, identity, auditHash: 'a'.repeat(64), base: old, candidate, verifiedFactIds: [] })!
  const context = { protocol: 2 as const, verdictProtocol: 6 as const, spanAddressProtocol: 2 as const,
    current: { id: 'chapter', revision: 4, orderIndex: 3, contentHash: identity.bodyHash }, previous,
    factCoverage: { version: 2 as const, taskId: 'task', chapterId: 'chapter', obligations: [
      { id: terminalFactId('openLoops', 'The parcel destination is still unresolved.'), field: 'openLoops' as const, claim: 'The parcel destination is still unresolved.' },
      { id: terminalFactId('openLoops', 'The deposit receipt is still unresolved.'), field: 'openLoops' as const, claim: 'The deposit receipt is still unresolved.' },
      ...Array.from({ length: 8 }, (_, index) => ({ id: terminalFactId('knowledge', `Previously known K${index}.`), field: 'knowledge' as const, claim: `Previously known K${index}.` })),
    ] }, proposalChanges: staged.changes! }
  const bodies = { previous: prior, current: content, terminalEvidence: context }, sourceScope = { currentOrderIndex: 3, previous: [] }
  const originalFindings = Array.from({ length: 7 }, (_, index) => ({ signal: 'object', severity: 'warning', evidence: `Old unsupported quote ${index}`,
    suggestion: 'Inspect the complete source.', sourceEvidence: [{ source: 'current', quote: 'nonexistent quotation' }] }))
  const originalRawResponses = [JSON.stringify({ findings: originalFindings }), JSON.stringify({ findings: [], diagnostic: 'The entire second report remains invalid.' })]
  const failedAssessmentKey = 'f'.repeat(64)
  const operationId = manualReviewRepairOperationId('task', failedAssessmentKey, { candidate, bodies })
  const manualRepair = { version: 1 as const, operationId, originalTaskId: 'task', failedAssessmentKey,
    originalRawHashes: originalRawResponses.map(raw => runtimeJson({ raw }).hash), originalFindings }
  const manifest = buildContinuityReviewManifest({ subject: { userId: 'user', novelId: 'novel', taskId: 'task', targetType: 'story_compilation',
    targetId: 'compilation', chapterId: 'chapter', revision: 4 }, bodies, candidate, sourceScope, sourceHash: 'e'.repeat(64),
    sourceVersions: { current: context.current, previous }, verifiedCoverage: context.factCoverage, draftProposals: context.proposalChanges, manualRepair })
  const frozen = { manifest, bodies, candidate, sourceScope }
  const wire = { findings: [] as unknown[], semanticChecks: ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear', reason: 'All source material independently reviewed.', findingIds: [] })),
    terminalVerdicts: knowledge.map((_, claimIndex) => ({ claimIndex, verdict: 'supported', sourceEvidence: [{ segmentId: 'c0' }] })),
    terminalProofVerdicts: carried.map((_, proofIndex) => ({ proofIndex, currentState: 'unchanged', reason: 'The full current body retains this independent historical obligation.' })),
    terminalDispositions: context.factCoverage.obligations.map((_, obligationIndex) => ({ obligationIndex, outcome: 'replaced', candidateIndex: obligationIndex < 2 ? 20 + obligationIndex : obligationIndex - 2,
      reason: 'The question is retained under the explicitly selected current open loop, not solved.', sourceEvidence: [{ segmentId: 'c0' }] })),
    proposalDispositions: [{ proposalIndex: 0, outcome: 'unknown', reason: 'The transient emotional draft remains pending with its original provenance.', sourceEvidence: [] }],
    originalFindingDispositions: originalFindings.map((_, index) => ({ index, action: 'retract', reason: 'The old opinion quoted “nonexistent quotation”; the full current source does not support that judgment.', sourceEvidence: [{ segmentId: 'c0' }] })) }
  return { frozen, wire, originalRawResponses, context, candidate, content, staged, operationId, manualRepair }
}
