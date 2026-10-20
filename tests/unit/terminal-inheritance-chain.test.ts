import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildTerminalFactProofs, terminalAssessmentHash } from '../../api/lib/agent/terminal-inheritance-chain.js'
import { type TerminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { terminalCandidateSchema, currentTerminalReview } from '../../api/lib/agent/terminal-state-review.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { compilerContinuityCoverage, compilerContinuityCoverageMatches } from '../../api/lib/agent/compiler-continuity-contract.js'

const checks = ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'not_applicable', reason: '合成事实继承。', findingIndexes: [] }))
const initial = terminalCandidateSchema.parse({ exitState: { openLoops: ['过滤泵检修等零件'] } })
const baseContext = (id: string, orderIndex: number, content: string): TerminalEvidenceContext => ({ protocol: 2,
  current: { id, orderIndex, revision: 1, contentHash: runtimeJson({ content }).hash }, previous: null })
function assessment(chapter: { id: string; orderIndex: number; revision: number; content: string }, evidence: TerminalEvidenceContext,
  candidate: typeof initial, verdicts: unknown[]) {
  const raw = JSON.stringify({ findings: [], terminalVerdicts: verdicts, semanticChecks: checks })
  const inspected = inspectContinuityResponse(raw, { previous: null, current: chapter.content, terminalEvidence: evidence }, true, 8, candidate)
  const validation = { checkedChapterId: chapter.id, checkedRevision: 1, checkedAt: 'old', checkRounds: 1,
    coverage: compilerContinuityCoverage({ chapter, bridge: {}, sceneTasks: [], source: null, terminalCandidate: candidate }, 11),
    terminalCandidate: candidate, independentCheck: 'complete', continuityCriticResponse: inspected.audit }
  return { validation, review: currentTerminalReview(validation, chapter.content, evidence) }
}
describe('bounded flat terminal fact chains', () => {
  it('ignores cache counters/time while binding semantic coverage and actual response', () => {
    const chapter = { id: 'c', orderIndex: 1, revision: 1, content: '过滤泵仍需检修。' }
    const { validation } = assessment(chapter, baseContext(chapter.id, 1, chapter.content), initial,
      [{ path: 'exitState.openLoops.0', verdict: 'supported', basis: 'current', sourceEvidence: [{ segmentId: 'c0', quote: '过滤泵仍需检修' }] }])
    expect(terminalAssessmentHash(validation)).toBe(terminalAssessmentHash({ ...validation, checkedAt: 'new', checkRounds: 99 }))
    expect(terminalAssessmentHash(validation)).not.toBe(terminalAssessmentHash({ ...validation, continuityCriticResponse: { ...validation.continuityCriticResponse, contentHash: 'b'.repeat(64) } }))
    const base = { chapter, bridge: {}, sceneTasks: [], source: null, terminalCandidate: initial }
    expect(compilerContinuityCoverageMatches(compilerContinuityCoverage(base, 10), compilerContinuityCoverage(base, 11))).toBe(false)
  })
  it('limits each fact to16 nodes while a new directly proven fact starts its own root', () => {
    let previous: ReturnType<typeof buildTerminalFactProofs> = []
    let previousBody = '', previousId = ''
    for (let index = 1; index <= 16; index++) {
      const chapter = { id: `c${index}`, revision: 1, orderIndex: index, content: index === 1 ? '过滤泵仍需检修。' : index === 16 ? '新锁栓已经断裂。' : '她取走清单。' }
      const evidence = baseContext(chapter.id, index, chapter.content)
      if (index > 1) evidence.previous = { id: previousId, revision: 1, orderIndex: index - 1, contentHash: createHash('sha256').update(previousBody).digest('hex'),
        start: 0, end: previousBody.length, joinedStart: 0, joinedEnd: previousBody.length, segments: [], carried: previous }
      const candidate = index === 16 ? terminalCandidateSchema.parse({ exitState: { ...initial.exitState, objects: ['新锁栓已经断裂'] } }) : initial
      const verdicts = [{ path: 'exitState.openLoops.0', verdict: 'supported', basis: index === 1 ? 'current' : 'inherited',
        sourceEvidence: [{ segmentId: index === 1 ? 'c0' : 't0', quote: '过滤泵仍需检修' }],
        ...(index === 1 ? {} : { inheritance: { priorEndState: 'established', currentState: 'unchanged' } }) },
      ...(index === 16 ? [{ path: 'exitState.objects.0', verdict: 'supported', basis: 'current', sourceEvidence: [{ segmentId: 'c0', quote: '新锁栓已经断裂' }] }] : [])]
      const { validation, review } = assessment(chapter, evidence, candidate, verdicts)
      expect(review?.supported).toBe(true)
      previous = buildTerminalFactProofs({ compilationId: `compile${index}`, chapter, validation, evidence, review: review!, stateHash: 'a'.repeat(64) })
      previousBody = chapter.content; previousId = chapter.id
    }
    expect(previous.find(fact => fact.field === 'openLoops')?.depth).toBe(16)
    expect(previous.find(fact => fact.field === 'objects')?.depth).toBe(1)
    const chapter = { id: 'next', revision: 1, orderIndex: 17, content: '她关好了箱盖。' }, evidence = baseContext(chapter.id, 17, chapter.content)
    evidence.previous = { id: previousId, revision: 1, orderIndex: 16, contentHash: createHash('sha256').update(previousBody).digest('hex'),
      start: 0, end: previousBody.length, joinedStart: 0, joinedEnd: previousBody.length, segments: [], carried: previous }
    const old = previous.find(fact => fact.field === 'openLoops')!, fresh = previous.find(fact => fact.field === 'objects')!
    const verdict = (id: string, path: string, quote: string, value = 'supported') => ({ path, verdict: value, basis: 'inherited', sourceEvidence: [{ segmentId: id, quote }],
      inheritance: { priorEndState: 'established', currentState: 'unchanged' } })
    expect(assessment(chapter, evidence, initial, [verdict(old.segmentId, 'exitState.openLoops.0', '过滤泵仍需检修')]).review).toBeNull()
    expect(assessment(chapter, evidence, initial, [verdict(old.segmentId, 'exitState.openLoops.0', '过滤泵仍需检修', 'unknown')]).review?.supported).toBe(false)
    const freshCandidate = terminalCandidateSchema.parse({ exitState: { objects: ['新锁栓已经断裂'] } })
    const accepted = assessment(chapter, evidence, freshCandidate, [verdict(fresh.segmentId, 'exitState.objects.0', '新锁栓已经断裂')])
    expect(accepted.review?.supported).toBe(true)
    expect(buildTerminalFactProofs({ compilationId: 'next', chapter, evidence, ...accepted, review: accepted.review!, stateHash: 'a'.repeat(64) })[0].depth).toBe(2)
  })
})
