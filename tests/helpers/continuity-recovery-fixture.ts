import { terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import type { TerminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'

/** Synthetic 5/0/18/13 shape from the production failure; no user manuscript. */
export function continuityRecoveryFixture() {
  const content = 'The guard files the packet at the desk. The packet remains sealed. A reply is still pending. The guard waits for instructions.'
  const candidate = terminalCandidateSchema.parse({ exitState: { action: 'The guard files the packet.', location: 'At the desk.',
    objects: ['The packet remains sealed.'], openLoops: ['A reply is still pending.'] }, lastUnfinishedAction: 'The guard waits for instructions.' })
  const context: TerminalEvidenceContext = { protocol: 2, verdictProtocol: 6, quoteAddressProtocol: 1, spanAddressProtocol: 2,
    current: { id: 'current', revision: 4, orderIndex: 10, contentHash: runtimeJson({ content }).hash }, previous: null,
    factCoverage: { version: 2, taskId: 'task', chapterId: 'current', obligations: Array.from({ length: 18 }, (_, i) => {
      const field = 'knowledge' as const, claim = `Known earlier matter ${i}.`
      return { id: runtimeJson({ field, claim }).hash, field, claim }
    }) } }
  context.proposalChanges = { version: 1, taskId: 'task', chapterId: 'current', bodyHash: context.current.contentHash,
    sourceHash: runtimeJson({ previous: null }).hash, candidateHash: runtimeJson(candidate).hash, verifiedFactIds: [],
    proposals: Array.from({ length: 13 }, (_, i) => {
      const field = 'objects' as const, claim = `An earlier unverified object ${i}.`
      return { id: runtimeJson({ field, claim }).hash, field, claim, origin: { auditHash: 'a'.repeat(64), bodyHash: context.current.contentHash,
        sourceHash: runtimeJson({ previous: null }).hash, candidateHash: runtimeJson(candidate).hash } }
    }) }
  const bodies = { current: content, previous: null, terminalEvidence: context }
  const wire = { findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear', reason: 'Synthetic full-body review.', findingIndexes: [] })),
    terminalVerdicts: Array.from({ length: 5 }, (_, claimIndex) => ({ claimIndex, verdict: 'supported', sourceEvidence: [{ segmentId: 'c0' }] })),
    terminalProofVerdicts: [], terminalDispositions: Array.from({ length: 18 }, (_, obligationIndex) => ({ obligationIndex, outcome: 'unknown', reason: 'The whole historical fact remains unresolved.', sourceEvidence: [] })),
    proposalDispositions: Array.from({ length: 13 }, (_, proposalIndex) => ({ proposalIndex, outcome: 'unknown', reason: 'The previous proposal remains unresolved.', sourceEvidence: [] })) }
  const bad = structuredClone(wire)
  for (const [i, candidateIndex] of [[1, 0], [3, 1], [9, 4]]) Object.assign(bad.terminalDispositions[i], { outcome: 'replaced', candidateIndex })
  const raw = JSON.stringify(bad), original = inspectContinuityResponse(raw, bodies, true, 8, candidate, undefined, { responseContract: 3 })
  const validation = { independentCheck: 'unavailable', terminalCandidate: candidate, continuityCriticResponse: original.audit }
  const patch = { baseResponseHash: original.audit.contentHash, corrections: [1, 3, 9].map(address => ({ table: 'terminalDispositions', address, replacement: wire.terminalDispositions[address] })) }
  return { content, candidate, context, bodies, wire, bad, raw, original, validation, patch }
}
