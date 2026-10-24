import { terminalCandidateSchema } from '../../api/lib/agent/terminal-state-review.js'
import { terminalEvidenceContext, type TerminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'

export function emptyProposalFixture(chapter = { id: 'chapter', revision: 1, orderIndex: 1, content: 'The packet remains sealed.' }, supplied?: TerminalEvidenceContext) {
  const candidate = terminalCandidateSchema.parse({ exitState: { objects: ['The packet remains sealed.'] } })
  const context = supplied ?? terminalEvidenceContext(chapter, null, 2, 1,
    { version: 2, taskId: 'task', chapterId: chapter.id, obligations: [] }, 6, 2)
  const bodies = { current: chapter.content, previous: null, terminalEvidence: context }
  const wire = { findings: [], semanticChecks: { action_direction: { result: 'clear', reason: 'Independent complete synthetic review.', findingIndexes: [] },
    state_progression: { result: 'clear', reason: 'Independent complete synthetic review.', findingIndexes: [] } },
    terminalVerdicts: [{ claimIndex: 0, verdict: 'supported', sourceEvidence: [{ segmentId: 'c0' }] }],
    terminalProofVerdicts: [], terminalDispositions: [], proposalDispositions: [] }
  const inspect = (raw: string) => inspectContinuityResponse(raw, bodies, true, 8, candidate, undefined, { responseContract: 3 })
  const raw = JSON.stringify(wire), original = inspect(raw)
  return { chapter, candidate, context, bodies, wire, raw, original, inspect }
}
