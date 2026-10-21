import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { continuitySourceSegments } from '../../api/lib/agent/continuity-review-context.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { buildTerminalFactProofs } from '../../api/lib/agent/terminal-inheritance-chain.js'
import { type TerminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { currentTerminalReview, inspectTerminalReview, terminalCandidateSchema, terminalQuoteAddressDiagnostics, terminalReviewInput } from '../../api/lib/agent/terminal-state-review.js'
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

function addressedEvidence(content = current, prior = previous, allowed?: string[]): TerminalEvidenceContext {
  const context = evidence(2)
  return { ...context, quoteAddressProtocol: 1, current: { ...context.current, contentHash: runtimeJson({ content }).hash }, previous: {
    ...context.previous!, contentHash: createHash('sha256').update(prior).digest('hex'), end: prior.length, joinedEnd: prior.length,
    segments: continuitySourceSegments({ previous: prior, current: '' }).filter(part => !allowed || allowed.includes(part.segmentId))
      .map(({ segmentId, quote }) => { const start = Number(segmentId.slice(1)) * 300
        return { segmentId, quote, start, end: start + quote.length, hash: runtimeJson({ text: quote }).hash }
      }),
  } }
}

describe('fresh terminal exact quote address protocol', () => {
  it.each([1, 2] as const)('canonicalizes every downstream address and retains all raw references for context %i', protocol => {
    const context = { ...addressedEvidence(), protocol }, items = structuredClone(verdicts)
    items[0].sourceEvidence.forEach(ref => { ref.segmentId = 'c1' })
    items[1].sourceEvidence.forEach(ref => { ref.segmentId = 'p1' })
    const response = raw(items), reviewed = inspectTerminalReview(candidate, current, response, true, context)!
    expect(reviewed).toMatchObject({ supported: true, responseHash: runtimeJson({ raw: response }).hash,
      originalRefs: items.map((item, verdictIndex) => ({ verdictIndex, path: item.path, sourceEvidence: item.sourceEvidence })),
      verdicts: [
        { sourceEvidence: verdicts[0].sourceEvidence, segmentIds: ['c0'], evidence: [{ segmentId: 'c0', start: 0, end: 300 }] },
        { sourceEvidence: verdicts[1].sourceEvidence, segmentIds: ['p0'], evidence: [{ segmentId: 'p0', start: 0, end: 300 }] },
      ] })
    expect(reviewed.relocations).toEqual(items.flatMap((item, verdictIndex) => item.sourceEvidence.map((ref, referenceIndex) => ({
      verdictIndex, path: item.path, referenceIndex, source: verdictIndex === 0 ? 'current' : 'previous', originalSegmentId: ref.segmentId,
      actualSegmentId: verdictIndex === 0 ? 'c0' : 'p0', quoteHash: createHash('sha256').update(ref.quote).digest('hex'),
    }))))
    expect(terminalQuoteAddressDiagnostics(response, current, context)).toEqual(reviewed.relocations!.map(relocation => ({
      path: relocation.path, referenceIndex: relocation.referenceIndex, originalSegmentId: relocation.originalSegmentId,
      actualSegmentId: relocation.actualSegmentId, reason: 'relocated',
    })))
    const inspected = inspectContinuityResponse(response, { previous, current, terminalEvidence: context }, true, 8, candidate)
    expect(inspected.complete).toBe(true)
    expect(JSON.parse(inspected.audit.rawResponse.content)).toBe(response)
    const validation = { checkedChapterId: 'current', checkedRevision: 1, independentCheck: 'complete', coverage: {},
      terminalCandidate: candidate, continuityCriticResponse: inspected.audit }
    expect(currentTerminalReview(validation, current, context)).toEqual(reviewed)
    const facts = buildTerminalFactProofs({ compilationId: 'canonical-current', chapter: { id: 'current', revision: 1, orderIndex: 2, content: current },
      validation, stateHash: 'b'.repeat(64), evidence: context, review: reviewed })
    expect(facts).toHaveLength(2)
    expect(facts.map(fact => fact.anchors.map(anchor => anchor.quote))).toEqual(verdicts.map(item => item.sourceEvidence.map(ref => ref.quote)))
    expect(facts.flatMap(fact => fact.anchors).every(anchor => (anchor.chapterId === 'current' ? current : previous).slice(anchor.start, anchor.end) === anchor.quote)).toBe(true)
    expect(terminalReviewInput(candidate, context)).toContain('引用地址策略')
    expect(terminalReviewInput(candidate, context)).toContain('"quoteAddressProtocol":1')
    expect(currentTerminalReview(validation, current + '改', context)).toBeNull()
    expect(currentTerminalReview(validation, current, evidence(protocol))).toBeNull()
    expect(inspectTerminalReview(candidate, current, response, false, context)).toBeNull()
  })

  it('adds no empty audit fields or prompt policy to frozen contexts', () => {
    const context = evidence(2), reviewed = inspectTerminalReview(candidate, current, raw(), true, context)!
    expect(reviewed).not.toHaveProperty('originalRefs')
    expect(reviewed).not.toHaveProperty('relocations')
    expect(terminalQuoteAddressDiagnostics(raw(), current, context)).toBeUndefined()
    expect(terminalReviewInput(candidate, context)).not.toContain('引用地址策略')
    expect(inspectTerminalReview(candidate, current, raw(), true, addressedEvidence())?.relocations).toEqual([])
  })

  const singleCandidate = terminalCandidateSchema.parse({ exitState: { body: ['合成事实'] } })
  const single = (segmentId: string, quote: string, inherited = false) => raw([{ path: 'exitState.body.0', verdict: 'supported',
    basis: inherited ? 'inherited' : 'current', sourceEvidence: [{ segmentId, quote }],
    ...(inherited ? { inheritance: { priorEndState: 'established', currentState: 'unchanged' } } : {}),
  }])

  it('accepts a quote ending at 300 while rejecting a quote from 294 through 306', () => {
    const content = '甲'.repeat(294) + 'ABCDEFGHIJKL' + '乙'.repeat(300), context = addressedEvidence(content)
    const reviewed = inspectTerminalReview(singleCandidate, content, single('c1', 'ABCDEF'), true, context)!
    expect(reviewed.verdicts[0]).toMatchObject({ sourceEvidence: [{ segmentId: 'c0', quote: 'ABCDEF' }], segmentIds: ['c0'],
      evidence: [{ segmentId: 'c0', start: 0, end: 300 }] })
    const crossing = single('c1', 'ABCDEFGHIJKL')
    expect(inspectTerminalReview(singleCandidate, content, crossing, true, context)).toBeNull()
    expect(terminalQuoteAddressDiagnostics(crossing, content, context)).toEqual([
      { path: 'exitState.body.0', referenceIndex: 0, originalSegmentId: 'c1', reason: 'quote_not_in_single_segment' },
    ])
  })

  it.each(['unknown current', 'unknown previous', 'wrong current source', 'wrong inherited source', 'invented current', 'invented previous'] as const)(
    'does not repair %s', scenario => {
      const inherited = scenario.includes('previous') || scenario === 'wrong inherited source'
      const segmentId = scenario === 'unknown current' ? 'c999' : scenario === 'unknown previous' ? 'p999'
        : scenario === 'wrong current source' ? 'p0' : scenario === 'wrong inherited source' ? 'c0' : inherited ? 'p1' : 'c1'
      const quote = scenario.startsWith('invented') ? '并不存在的事实' : inherited ? '旧泵尚未修复' : '左腕已经肿起'
      const response = single(segmentId, quote, inherited), context = addressedEvidence()
      expect(inspectTerminalReview(singleCandidate, current, response, true, context)).toBeNull()
      expect(terminalQuoteAddressDiagnostics(response, current, context)?.[0].reason).toBe(scenario.startsWith('unknown') ? 'unknown_segment'
        : scenario.startsWith('wrong') ? 'wrong_source' : 'quote_missing')
    })

  it.each([false, true])('cannot use a quote found only in the other source (inherited=%s)', inherited => {
    const context = addressedEvidence(), response = single(inherited ? 'p1' : 'c1', inherited ? '左腕已经肿起' : '旧泵尚未修复', inherited)
    expect(inspectTerminalReview(singleCandidate, current, response, true, context)).toBeNull()
    expect(terminalQuoteAddressDiagnostics(response, current, context)?.[0].reason).toBe('quote_missing')
  })

  it.each(['same segment', 'different segment', 'crossing occurrence'] as const)('rejects relocation with duplicate quotes: %s', scenario => {
    const content = scenario === 'same segment' ? '重复引文重复引文'.padEnd(600, '甲') + '尾段'
      : '重复引文'.padEnd(scenario === 'crossing occurrence' ? 298 : 300, '甲') + '重复引文'.padEnd(302, '乙') + '尾段'
    const response = single('c2', '重复引文'), context = addressedEvidence(content)
    expect(inspectTerminalReview(singleCandidate, content, response, true, context)).toBeNull()
    expect(terminalQuoteAddressDiagnostics(response, content, context)?.[0].reason).toBe('quote_ambiguous')
  })

  it('uses only the allowed predecessor set and never crosses a gap in that set', () => {
    const prior = '未准入的引文'.padEnd(299, '甲') + '左' + '中间章内容'.padEnd(300, '乙') + '右'.padEnd(300, '丙') + '允许引文'
    const context = addressedEvidence(current, prior, ['p0', 'p2', 'p3'])
    expect(inspectTerminalReview(singleCandidate, current, single('p3', '左右', true), true, context)).toBeNull()
    const allowed = addressedEvidence(current, prior, ['p2', 'p3'])
    expect(inspectTerminalReview(singleCandidate, current, single('p3', '未准入的引文', true), true, allowed)).toBeNull()
    expect(inspectTerminalReview(singleCandidate, current, single('p0', '允许引文', true), true, allowed)).toBeNull()
    expect(inspectTerminalReview(singleCandidate, current, single('p2', '允许引文', true), true, allowed)?.verdicts[0])
      .toMatchObject({ sourceEvidence: [{ segmentId: 'p3', quote: '允许引文' }], segmentIds: ['p3'] })
  })

  it('still rejects one invalid ref after other refs have been repaired and inherited status remains explicit', () => {
    const context = addressedEvidence(), items = structuredClone(verdicts)
    items[0].sourceEvidence.forEach(ref => { ref.segmentId = 'c1' })
    items[0].sourceEvidence[1].quote = '伪造的引文'
    expect(inspectTerminalReview(candidate, current, raw(items), true, context)).toBeNull()
    expect(terminalQuoteAddressDiagnostics(raw(items), current, context)?.map(item => item.reason)).toEqual(['relocated', 'quote_missing'])
    items[0] = structuredClone(verdicts[0]); items[1].sourceEvidence.forEach(ref => { ref.segmentId = 'p1' })
    items[1].inheritance!.currentState = 'uncertain'
    expect(inspectTerminalReview(candidate, current, raw(items), true, context)).toBeNull()
    items[1].inheritance!.currentState = 'unchanged'; items[1].inheritance!.priorEndState = 'uncertain'
    expect(inspectTerminalReview(candidate, current, raw(items), true, context)).toBeNull()
  })

  it('never relocates carried proof IDs or weakens their single-reference and claim requirements', () => {
    const original = evidence(2), reviewed = inspectTerminalReview(candidate, current, raw(), true, original)!
    const inspected = inspectContinuityResponse(raw(), { previous, current, terminalEvidence: original }, true, 8, candidate)
    const validation = { checkedChapterId: 'current', checkedRevision: 1, independentCheck: 'complete', coverage: {},
      terminalCandidate: candidate, continuityCriticResponse: inspected.audit }
    const facts = buildTerminalFactProofs({ compilationId: 'original', chapter: { id: 'current', revision: 1, orderIndex: 2, content: current },
      validation, stateHash: 'c'.repeat(64), evidence: original, review: reviewed })
    const content = '她提起空杯。', context: TerminalEvidenceContext = { ...addressedEvidence(content),
      previous: { ...original.previous!, segments: [], carried: facts } }
    const carriedCandidate = terminalCandidateSchema.parse({ exitState: { body: candidate.exitState.body } })
    const response = single('t0', '左腕已经肿起', true)
    expect(inspectTerminalReview(carriedCandidate, content, response, true, context)?.supported).toBe(true)
    expect(inspectTerminalReview(carriedCandidate, content, single('t1', '左腕已经肿起', true), true, context)).toBeNull()
    expect(terminalQuoteAddressDiagnostics(single('t1', '左腕已经肿起', true), content, context)?.[0].reason).toBe('carried_quote_mismatch')
    expect(inspectTerminalReview(carriedCandidate, content, single('t999', '左腕已经肿起', true), true, context)).toBeNull()
    const two = [{ ...verdicts[0], basis: 'inherited', sourceEvidence: [{ segmentId: 't0', quote: '左腕已经肿起' },
      { segmentId: 't0', quote: '袖口仍被绷带固定' }], inheritance: { priorEndState: 'established', currentState: 'unchanged' } }]
    expect(inspectTerminalReview(carriedCandidate, content, raw(two), true, context)).toBeNull()
    expect(inspectTerminalReview(singleCandidate, content, response, true, context)).toBeNull()
  })
})
