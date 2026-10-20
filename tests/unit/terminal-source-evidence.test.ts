import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { continuitySourceSegments } from '../../api/lib/agent/continuity-review-context.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { buildTerminalFactProofs } from '../../api/lib/agent/terminal-inheritance-chain.js'
import { type TerminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { currentTerminalReview, inspectTerminalReview, terminalCandidateSchema, terminalReviewInput } from '../../api/lib/agent/terminal-state-review.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'

const current = '她的左腕已经肿起，袖口仍被绷带固定。'.padEnd(300, '。') + '她锁紧侧柜。'
const previous = '旧泵尚未修复，仍在等新轴。'.padEnd(300, '。') + '仓门已经关闭。'
const candidate = terminalCandidateSchema.parse({ exitState: { body: ['左腕肿起且被绷带固定'], openLoops: ['旧泵检修等新轴'] } })
const checks = ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'not_applicable', reason: '已逐项核对合成正文。', findingIndexes: [] }))
const verdicts = [
  { path: 'exitState.body.0', verdict: 'supported', basis: 'current',
    sourceEvidence: [{ segmentId: 'c0', quote: '左腕已经肿起' }, { segmentId: 'c0', quote: '袖口仍被绷带固定' }] },
  { path: 'exitState.openLoops.0', verdict: 'supported', basis: 'inherited',
    sourceEvidence: [{ segmentId: 'p0', quote: '旧泵尚未修复' }, { segmentId: 'p0', quote: '仍在等新轴' }],
    inheritance: { priorEndState: 'established', currentState: 'unchanged' } },
]
const raw = (items: unknown[] = verdicts) => JSON.stringify({ findings: [], semanticChecks: checks, terminalVerdicts: items })
function evidence(protocol: 1 | 2): TerminalEvidenceContext {
  return { protocol, current: { id: 'current', revision: 1, orderIndex: 2, contentHash: runtimeJson({ content: current }).hash }, previous: {
    id: 'previous', revision: 1, orderIndex: 1, contentHash: createHash('sha256').update(previous).digest('hex'),
    start: 0, end: previous.length, joinedStart: 0, joinedEnd: previous.length,
    segments: continuitySourceSegments({ previous, current: '' }).map(({ segmentId, quote }) => {
      const start = Number(segmentId.slice(1)) * 300
      return { segmentId, quote, start, end: start + quote.length, hash: runtimeJson({ text: quote }).hash }
    }),
  } }
}

describe('terminal verdict quote references and segment projection', () => {
  it.each([1, 2] as const)('retains each exact quote while projecting unique segment addresses for protocol %i', protocol => {
    const context = evidence(protocol), response = raw(), bodies = { previous, current, terminalEvidence: context }
    const reviewed = inspectTerminalReview(candidate, current, response, true, context)!
    expect(reviewed).toMatchObject({ supported: true, verdicts: [
      { sourceEvidence: verdicts[0].sourceEvidence, segmentIds: ['c0'], evidence: [{ segmentId: 'c0', start: 0, end: 300 }] },
      { sourceEvidence: verdicts[1].sourceEvidence, segmentIds: ['p0'], evidence: [{ segmentId: 'p0', start: 0, end: 300 }] },
    ] })
    expect(reviewed.verdicts.map(item => item.evidence.length)).toEqual([1, 1])
    const inspected = inspectContinuityResponse(response, bodies, true, 8, candidate)
    expect(inspected).toMatchObject({ complete: true, audit: { classification: 'complete', parserVersion: 8 } })
    expect(JSON.parse(inspected.audit.rawResponse.content)).toBe(response)
    const validation = { checkedChapterId: 'current', checkedRevision: 1, independentCheck: 'complete', coverage: {},
      terminalCandidate: candidate, continuityCriticResponse: inspected.audit }
    expect(currentTerminalReview(validation, current, context)).toEqual(reviewed)
    const facts = buildTerminalFactProofs({ compilationId: 'commit-current', chapter: { id: 'current', revision: 1, orderIndex: 2, content: current },
      validation, stateHash: 'a'.repeat(64), evidence: context, review: reviewed })
    expect(facts.map(fact => fact.anchors.map(anchor => anchor.quote))).toEqual(verdicts.map(item => item.sourceEvidence.map(ref => ref.quote)))
    expect(facts.flatMap(fact => fact.anchors).every(anchor => (anchor.chapterId === 'current' ? current : previous).slice(anchor.start, anchor.end) === anchor.quote)).toBe(true)
    expect(terminalReviewInput(candidate, context)).toContain('同一正文片段可引用多个逐字短 quote')
  })

  for (const protocol of [1, 2] as const) {
    it.each(['invented current quote', 'current quote in a different segment', 'missing current segment', 'current wrong source',
      'invented inherited quote', 'inherited quote in a different segment', 'inherited wrong source', 'ninth reference'] as const)(
      `still checks every original reference before accepting protocol ${protocol}: %s`, scenario => {
        const context = evidence(protocol), items = structuredClone(verdicts)
        if (scenario === 'invented current quote') items[0].sourceEvidence[1].quote = '左腕已经痊愈'
        if (scenario === 'current quote in a different segment') items[0].sourceEvidence[1].quote = '她锁紧侧柜'
        if (scenario === 'missing current segment') items[0].sourceEvidence[1].segmentId = 'c999'
        if (scenario === 'current wrong source') items[0].sourceEvidence[1] = { segmentId: 'p0', quote: '仍在等新轴' }
        if (scenario === 'invented inherited quote') items[1].sourceEvidence[1].quote = '新轴已经送到'
        if (scenario === 'inherited quote in a different segment') items[1].sourceEvidence[1].quote = '仓门已经关闭'
        if (scenario === 'inherited wrong source') items[1].sourceEvidence[1] = { segmentId: 'c0', quote: '袖口仍被绷带固定' }
        if (scenario === 'ninth reference') items[0].sourceEvidence = Array.from({ length: 9 }, (_, index) => verdicts[0].sourceEvidence[index % 2])
        const response = raw(items)
        expect(inspectTerminalReview(candidate, current, response, true, context)).toBeNull()
        expect(inspectContinuityResponse(response, { previous, current, terminalEvidence: context }, true, 8, candidate))
          .toMatchObject({ complete: false, audit: { classification: 'terminal_invalid' } })
      })
  }

  it('preserves transport, exhaustive path and legacy explicit-address requirements', () => {
    const context = evidence(2)
    expect(inspectTerminalReview(candidate, current, raw(), false, context)).toBeNull()
    expect(inspectTerminalReview(candidate, current, raw(verdicts.slice(0, 1)), true, context)).toBeNull()
    expect(inspectTerminalReview(candidate, current, raw([verdicts[0], verdicts[0]]), true, context)).toBeNull()
    const legacyCandidate = terminalCandidateSchema.parse({ exitState: { body: ['左腕肿起且被绷带固定'] } })
    const legacy = (segmentIds: string[]) => JSON.stringify({ findings: [], terminalVerdicts: [{ path: 'exitState.body.0', verdict: 'supported', segmentIds }] })
    expect(inspectTerminalReview(legacyCandidate, current, legacy(['c0']), true)?.supported).toBe(true)
    expect(inspectTerminalReview(legacyCandidate, current, legacy(['c0', 'c0']), true)).toBeNull()
  })

  it('does not collapse multiple carried-proof references into the required single attestation', () => {
    const initialCandidate = terminalCandidateSchema.parse({ exitState: { body: candidate.exitState.body } })
    const context = evidence(2), response = raw([verdicts[0]])
    const reviewed = inspectTerminalReview(initialCandidate, current, response, true, context)!
    const inspected = inspectContinuityResponse(response, { previous, current, terminalEvidence: context }, true, 8, initialCandidate)
    const validation = { checkedChapterId: 'current', checkedRevision: 1, independentCheck: 'complete', coverage: {},
      terminalCandidate: initialCandidate, continuityCriticResponse: inspected.audit }
    const [fact] = buildTerminalFactProofs({ compilationId: 'commit-current', chapter: { id: 'current', revision: 1, orderIndex: 2, content: current },
      validation, stateHash: 'a'.repeat(64), evidence: context, review: reviewed })
    const nextContent = '她拿起杯子。', nextContext: TerminalEvidenceContext = { protocol: 2,
      current: { id: 'next', revision: 1, orderIndex: 3, contentHash: runtimeJson({ content: nextContent }).hash },
      previous: { ...context.previous!, id: 'current', orderIndex: 2, contentHash: createHash('sha256').update(current).digest('hex'),
        end: current.length, joinedEnd: current.length, segments: [], carried: [fact] } }
    const inherited = { ...verdicts[0], basis: 'inherited', sourceEvidence: [{ segmentId: 't0', quote: '左腕已经肿起' }],
      inheritance: { priorEndState: 'established', currentState: 'unchanged' } }
    expect(inspectTerminalReview(initialCandidate, nextContent, raw([inherited]), true, nextContext)?.supported).toBe(true)
    expect(inspectTerminalReview(initialCandidate, nextContent, raw([{ ...inherited, sourceEvidence: [...inherited.sourceEvidence,
      { segmentId: 't0', quote: '袖口仍被绷带固定' }] }]), true, nextContext)).toBeNull()
    expect(inspectTerminalReview(initialCandidate, nextContent, raw([inherited]), true, { ...nextContext, protocol: 1 })).toBeNull()
  })
})
