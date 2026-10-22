import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { terminalEvidenceContext, type TerminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { terminalCandidateSchema, terminalReviewInput } from '../../api/lib/agent/terminal-state-review.js'
import { terminalCandidateFacts } from '../../api/lib/agent/terminal-fact-identity.js'
import { terminalCandidateCorrection } from '../../api/lib/agent/terminal-candidate-feedback.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'

function fixture() {
  const content = 'He stops at the control-room doorway, before turning the wheel.'
  const previous = 'He crossed the first door, the middle chamber, then the second door into the control room.'
  const chapter = { id: 'chapter', revision: 8, orderIndex: 6, content }
  const context: TerminalEvidenceContext = { ...terminalEvidenceContext(chapter, null, 2, 1,
    { version: 2, taskId: 'task', chapterId: chapter.id, obligations: [] }, 5), previous: {
    id: 'previous', revision: 15, orderIndex: 5, contentHash: createHash('sha256').update(previous).digest('hex'),
    start: 0, end: previous.length, joinedStart: 0, joinedEnd: previous.length, carried: [],
    segments: [{ segmentId: 'p0', start: 0, end: previous.length, quote: previous, hash: runtimeJson({ text: previous }).hash }],
  } }
  const candidate = terminalCandidateSchema.parse({ exitState: { location: 'Inside the first door of the control room.' } })
  const raw = JSON.stringify({ findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind =>
    ({ kind, result: 'clear', reason: 'Synthetic whole-body review.', findingIndexes: [] })),
  terminalVerdicts: [{ factId: terminalCandidateFacts(candidate)[0].id, verdict: 'supported', sourceEvidence: [{ segmentId: 'c0' }, { segmentId: 'p0' }] }], terminalProofVerdicts: [], terminalDispositions: [] })
  const inspected = inspectContinuityResponse(raw, { current: content, previous, terminalEvidence: context }, true, 8, candidate)
  const validation = { independentCheck: 'unavailable', terminalCandidate: candidate, continuityCriticResponse: structuredClone(inspected.audit) }
  return { content, previous, candidate, context, raw, inspected, validation }
}

it('projects a precise candidate-processing task while keeping the original wrong location rejected', () => {
  const f = fixture(), before = JSON.stringify(f.validation)
  expect(f.inspected).toMatchObject({ complete: false, audit: { classification: 'terminal_invalid', terminalReviewDiagnostics: [{ code: 'inheritance_invalid', path: 'exitState.location' }] } })
  expect(terminalCandidateCorrection(f.validation, f.content, f.context)).toMatchObject({ version: 1, candidateHash: runtimeJson(f.candidate).hash, paths: ['exitState.location'] })
  expect(JSON.stringify(f.validation)).toBe(before)
  expect(f.validation.independentCheck).toBe('unavailable')
})

it.each(['body', 'candidate', 'source', 'raw', 'incomplete', 'old-protocol'] as const)('rejects stale, altered or unfinished feedback: %s', change => {
  const f = fixture()
  if (change === 'body') f.content += ' changed'
  if (change === 'candidate') f.validation.terminalCandidate.exitState.location = 'Changed candidate'
  if (change === 'source') f.context.previous!.revision++
  if (change === 'raw') f.validation.continuityCriticResponse.rawResponse.content = JSON.stringify(f.raw + ' changed')
  if (change === 'incomplete') f.validation.continuityCriticResponse.rawResponse.complete = false
  if (change === 'old-protocol') f.context.verdictProtocol = 4
  expect(terminalCandidateCorrection(f.validation, f.content, f.context)).toBeNull()
})

it.each(['unknown', 'current-only', 'duplicate', 'invented-span'] as const)('does not turn a different critic failure into candidate authority: %s', change => {
  const f = fixture(), parts = JSON.parse(f.raw)
  const candidate = f.candidate
  if (change === 'unknown') parts.terminalVerdicts[0].verdict = 'unknown'
  if (change === 'current-only') {
    parts.terminalVerdicts[0].sourceEvidence = [{ segmentId: 'c0' }]
    parts.terminalVerdicts[0].inheritance = { priorEndState: 'established', currentState: 'unchanged' }
  }
  if (change === 'duplicate') parts.terminalVerdicts.push(structuredClone(parts.terminalVerdicts[0]))
  if (change === 'invented-span') parts.terminalVerdicts[0].sourceEvidence[1].segmentId = 'p99'
  const inspected = inspectContinuityResponse(JSON.stringify(parts), { current: f.content, previous: f.previous, terminalEvidence: f.context }, true, 8, candidate)
  expect(terminalCandidateCorrection({ independentCheck: 'unavailable', terminalCandidate: candidate, continuityCriticResponse: inspected.audit }, f.content, f.context)).toBeNull()
})

it.each(['knowledge', 'objects', 'openLoops'] as const)('returns authenticated failed inheritance feedback for %s without certifying the claim', field => {
  const f = fixture(), parts = JSON.parse(f.raw)
  const candidate = terminalCandidateSchema.parse({ exitState: { [field]: ['A persistent claim still needs its actual proof.'] } })
  parts.terminalVerdicts[0].factId = terminalCandidateFacts(candidate)[0].id
  const inspected = inspectContinuityResponse(JSON.stringify(parts), { current: f.content, previous: f.previous, terminalEvidence: f.context }, true, 8, candidate)
  const saved = { independentCheck: 'unavailable', terminalCandidate: candidate, continuityCriticResponse: inspected.audit }
  const before = JSON.stringify(saved)
  expect(inspected.complete).toBe(false)
  expect(terminalCandidateCorrection(saved, f.content, f.context)?.paths).toEqual([`exitState.${field}.0`])
  expect(JSON.stringify(saved)).toBe(before)
})

it('clarifies source policy only for new primary v5 coverage2 inputs, without changing older renderer branches', () => {
  const f = fixture()
  expect(terminalReviewInput(f.candidate, f.context)).toContain('"sourcePolicy":"current_only"')
  expect(terminalReviewInput(f.candidate, { ...f.context, verdictProtocol: 4 })).not.toContain('sourcePolicy')
  expect(terminalReviewInput(f.candidate, { ...f.context, factCoverage: undefined })).not.toContain('sourcePolicy')
})
