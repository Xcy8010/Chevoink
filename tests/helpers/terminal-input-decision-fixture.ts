import { terminalCandidateSchema } from '../../api/lib/agent/terminal-candidate-contract.js'
import { terminalEvidenceContext, type TerminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { terminalCoverageInput } from '../../api/lib/agent/terminal-fact-coverage.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { compilerEvidenceScope } from '../../api/lib/agent/continuity-source-authority.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { continuityReassessmentRequest, legacyContinuityAssessmentKey, type LegacyAssessmentInput } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'

/** Complete synthetic transports with a deliberately illegal paired reason.
 * The standalone second verdicts are not an accepted final assessment. */
export function terminalInputDecisionFixture(input: {
  runId: string; taskSpec: { id: string }; chapter: { id: string; revision: number; orderIndex: number; title: string; content: string };
  compilationId: string; bridge: unknown; scenes: unknown[]; preparedContext: unknown; proposals?: TerminalEvidenceContext['proposalChanges'];
}) {
  const candidate = terminalCandidateSchema.parse({ exitState: { objects: ['The packet remains sealed.'] } })
  const context = terminalEvidenceContext(input.chapter, null, 2, 1,
    terminalCoverageInput(input.taskSpec, input.preparedContext, input.chapter, candidate, 2), 6, 2)
  if (input.proposals) context.proposalChanges = input.proposals
  const coverage = compilerContinuityCoverage({ chapter: input.chapter, bridge: input.bridge, sceneTasks: input.scenes, source: null, terminalCandidate: candidate }, 11)
  const frozen: LegacyAssessmentInput = { chapterId: input.chapter.id, revision: input.chapter.revision, parserVersion: 8, reassessmentProtocol: 5,
    bodies: { current: input.chapter.content, previous: null, terminalEvidence: context }, terminalCandidate: candidate,
    sourceScope: compilerEvidenceScope(input.chapter, null), bindingHash: runtimeJson(coverage).hash,
    system: 'Synthetic frozen independent review.', content: 'Synthetic frozen request.', targetType: 'story_compilation', targetId: input.compilationId }
  const common = { semanticChecks: { action_direction: { result: 'clear', reason: 'Complete synthetic manuscript review.', findingIndexes: [] },
    state_progression: { result: 'clear', reason: 'Complete synthetic manuscript review.', findingIndexes: [] } },
    terminalVerdicts: [{ claimIndex: 0, verdict: 'supported', sourceEvidence: [{ segmentId: 'c0' }] }], terminalProofVerdicts: [], terminalDispositions: [],
    ...(input.proposals ? { proposalDispositions: input.proposals.proposals.map((_, proposalIndex) => ({ proposalIndex, outcome: 'unknown',
      reason: 'The original draft remains unverified.', sourceEvidence: [] })) } : {}) }
  const firstWire = { ...common, findings: [{ signal: 'object', severity: 'warning', evidence: 'The text says “an invented quotation”.',
    suggestion: 'Check the actual text.', sourceEvidence: [{ source: 'current', segmentId: 'c0', quote: 'an invented quotation' }] }] }
  const secondWire = { ...common, findings: [], decisions: [{ index: 0, action: 'retract', reason: 'The current manuscript says “another absent quotation”.',
    sourceEvidence: [{ source: 'current', segmentId: 'c0', quote: input.chapter.content }] }] }
  const inspect = (wire: unknown) => inspectContinuityResponse(JSON.stringify(wire), frozen.bodies, true, 8, candidate, frozen.sourceScope, { responseContract: 3 })
  const first = inspect(firstWire), second = inspect(secondWire), callId = 'synthetic-known-invalid-call'
  const key = legacyContinuityAssessmentKey({ runId: input.runId, callId }, frozen)
  const metadata = [{ version: 1, continuityAssessmentRequestKey: key, assessmentChapterId: input.chapter.id, input: frozen, callId, admissionId: null },
    { version: 1, fullReassessmentKey: key, input: frozen, callId, original: first.audit, usageIds: ['first-usage'],
      request: continuityReassessmentRequest(frozen.system, frozen.content, first, frozen.bodies, false, 5) },
    ...(['first', 'reassessment'] as const).flatMap((stage, index) => [
      { version: 1, assessmentRequestOwnerKey: key, stage, callId, usageIds: [index ? 'second-usage' : 'first-usage'] },
      { version: 1, assessmentKey: key, assessmentResponseKey: runtimeJson({ key, stage }).hash, input: frozen, stage, callId,
        usageIds: [index ? 'second-usage' : 'first-usage'], audit: index ? second.audit : first.audit,
        response: { content: JSON.stringify(JSON.stringify(index ? secondWire : firstWire)), encoding: 'json-string', transportComplete: true, finishReason: 'stop', toolCalls: [] } },
    ])]
  return { candidate, context, coverage, frozen, callId, key, first, second, firstWire, secondWire, metadata }
}
