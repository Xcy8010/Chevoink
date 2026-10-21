import { describe, expect, it } from 'vitest'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { continuitySourceSegments } from '../../api/lib/agent/continuity-review-context.js'
import { terminalEvidenceContext, validContinuitySemanticChecks } from '../../api/lib/agent/terminal-evidence-context.js'
import { advanceTerminalCoverage, readTerminalCoverageState, terminalCoverageInput } from '../../api/lib/agent/terminal-fact-coverage.js'
import { buildTerminalFactProofs } from '../../api/lib/agent/terminal-inheritance-chain.js'
import { terminalQuoteRange } from '../../api/lib/agent/terminal-quote-range.js'
import { currentTerminalReview, inspectTerminalReview, terminalCandidateSchema, terminalReviewInput } from '../../api/lib/agent/terminal-state-review.js'

const checks = ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear', reason: 'Checked the actual sequence.', findingIndexes: [] }))
const candidate = terminalCandidateSchema.parse({ exitState: { knowledge: ['The sensor remains offline.'] } })
const spec = (version: 1 | 2) => ({ id: 'original-task', scope: { terminalCoverageProtocol: version } })
const chapter = (content: string) => ({ id: 'current', revision: 3, orderIndex: 5, content })
const evidence = (content: string, version: 1 | 2 = 2) => terminalEvidenceContext(chapter(content), null, 2, 1,
  terminalCoverageInput(spec(version), {}, chapter(content), candidate))
const verdict = (segmentId: string, quote: string, path = 'exitState.knowledge.0', status = 'supported') =>
  ({ path, verdict: status, basis: 'current', sourceEvidence: [{ segmentId, quote }] })
const raw = (terminalVerdicts: unknown[], semanticChecks: unknown = checks, terminalDispositions?: unknown[]) =>
  JSON.stringify({ findings: [], semanticChecks, terminalVerdicts, ...(terminalDispositions ? { terminalDispositions } : {}) })

describe('fresh terminal fact evidence v2', () => {
  it.each(['complete-map', 'explicit-shared-reason'] as const)('accepts a lossless semantic envelope: %s', kind => {
    const input = kind === 'complete-map' ? Object.fromEntries(checks.map(check => [check.kind, check]))
      : { action_direction: 'clear', state_progression: 'clear', reason: 'Checked both relationships explicitly.' }
    expect(validContinuitySemanticChecks(input, [], 1)).toBe(false)
    expect(validContinuitySemanticChecks(input, [], 2)).toBe(true)
    const content = 'The sensor remains offline.', response = raw([verdict('c0', content)], input)
    const result = inspectContinuityResponse(response, { previous: null, current: content, terminalEvidence: evidence(content) }, true, 8, candidate)
    expect(result.complete).toBe(true)
    expect(JSON.parse(result.audit.rawResponse.content)).toBe(response)
    expect(currentTerminalReview({ terminalCandidate: candidate, independentCheck: 'complete', continuityCriticResponse: result.audit }, content, evidence(content))?.supported).toBe(true)
  })

  it.each([
    { action_direction: 'conflict', state_progression: 'clear', reason: 'No indexed error.' },
    { action_direction: 'clear', state_progression: 'clear' },
    { action_direction: 'clear', state_progression: 'clear', reason: '   ' },
    { action_direction: 'clear', state_progression: 'clear', reason: 'Checked.', extra: 'ignore' },
    { action_direction: checks[1], state_progression: checks[0] },
    { action_direction: checks[0], state_progression: { ...checks[1], result: 'conflict', findingIndexes: [0] } },
  ])('never invents semantic fields, indexed findings or judgments: %j', input => {
    expect(validContinuitySemanticChecks(input, [], 2)).toBe(false)
  })

  it.each([294, 299, 300, 594, 599])('preserves one exact anchor across arbitrary presentation chunks at %i', start => {
    const quote = 'ABCDEFGHI', content = 'x'.repeat(start) + quote + 'y'.repeat(932 - start - quote.length)
    const context = evidence(content), response = raw([verdict('c2', quote)])
    const review = inspectTerminalReview(candidate, content, response, true, context)!
    expect(review?.supported).toBe(true)
    expect(review.verdicts[0].segmentIds).toEqual(start % 300 + quote.length > 300
      ? [`c${Math.floor(start / 300)}`, `c${Math.floor(start / 300) + 1}`] : [`c${Math.floor(start / 300)}`])
    const inspected = inspectContinuityResponse(response, { previous: null, current: content, terminalEvidence: context }, true, 8, candidate)
    const validation = { checkedChapterId: 'current', checkedRevision: 3, coverage: {}, terminalCandidate: candidate, independentCheck: 'complete', continuityCriticResponse: inspected.audit }
    expect(currentTerminalReview(validation, content, context)).toEqual(review)
    const facts = buildTerminalFactProofs({ compilationId: 'commit', chapter: chapter(content), validation, evidence: context, review, stateHash: 'a'.repeat(64) })
    expect(facts[0].anchors).toMatchObject([{ start, end: start + quote.length, quote }])
    expect(facts[0].anchors).toHaveLength(1)
    expect(content.slice(facts[0].anchors[0].start, facts[0].anchors[0].end)).toBe(quote)
    if (start % 300 + quote.length > 300) expect(inspectTerminalReview(candidate, content, response, true, evidence(content, 1))).toBeNull()
  })

  it.each(['unknown-id', 'wrong-source', 'invented', 'duplicate', 'overlap', 'in-segment-duplicate', 'in-segment-overlap', 'one-invalid'] as const)('keeps address and source denials: %s', kind => {
    let quote = 'ABCDEFGHI', content = 'x'.repeat(594) + quote + 'z'.repeat(329), segment = 'c2'
    if (kind === 'unknown-id') segment = 'c999'
    if (kind === 'wrong-source') segment = 'p2'
    if (kind === 'invented') quote = 'ABCXEFGHI'
    if (kind === 'duplicate') content = 'x'.repeat(294) + quote + 'x'.repeat(291) + quote + 'z'.repeat(329)
    if (kind === 'overlap') { quote = 'aaa'; content = 'x'.repeat(298) + 'aaaa' + 'z'.repeat(630) }
    if (kind === 'in-segment-duplicate') { content = quote + 'x' + quote; segment = 'c0' }
    if (kind === 'in-segment-overlap') { quote = 'aaa'; content = 'aaaa'; segment = 'c0' }
    const item = verdict(segment, quote)
    if (kind === 'one-invalid') item.sourceEvidence.push({ segmentId: 'c1', quote: 'A made up citation.' })
    expect(inspectTerminalReview(candidate, content, raw([item]), true, evidence(content))).toBeNull()
  })

  it('never joins missing spans, different source prefixes or artificial chapter gaps', () => {
    expect(terminalQuoteRange({ segmentId: 'p0', quote: 'ABC' }, [{ segmentId: 'p0', quote: 'x'.repeat(299) + 'A' }, { segmentId: 'p2', quote: 'BC' }])).toBeNull()
    expect(terminalQuoteRange({ segmentId: 'p0', quote: 'ABC' }, [{ segmentId: 'p0', quote: 'x'.repeat(299) + 'A' }, { segmentId: 'c1', quote: 'BC' }])).toBeNull()
  })

  it('uses the same exact range for predecessor evidence and preserves one-character edges in eight anchors', () => {
    const quote = 'ABCDEFGHI', previous = 'x'.repeat(299) + quote + 'y'.repeat(624), content = 'Work continues.'
    const context = evidence(content)
    context.previous = { id: 'previous', revision: 8, orderIndex: 4, contentHash: 'b'.repeat(64), start: 0, end: previous.length,
      joinedStart: 0, joinedEnd: previous.length,
      segments: continuitySourceSegments({ previous, current: '' }).map(({ segmentId, quote }) => ({ segmentId, quote, start: Number(segmentId.slice(1)) * 300,
        end: Number(segmentId.slice(1)) * 300 + quote.length, hash: 'c'.repeat(64) })) }
    const item = { ...verdict('p2', quote), basis: 'inherited', inheritance: { priorEndState: 'established', currentState: 'unchanged' },
      sourceEvidence: Array.from({ length: 8 }, () => ({ segmentId: 'p2', quote })) }
    const response = raw([item]), review = inspectTerminalReview(candidate, content, response, true, context)!
    expect(review?.supported).toBe(true)
    expect(review.verdicts[0].segmentIds).toEqual(['p0', 'p1'])
    const inspected = inspectContinuityResponse(response, { previous, current: content, terminalEvidence: context }, true, 8, candidate)
    const validation = { checkedChapterId: 'current', checkedRevision: 3, coverage: {}, terminalCandidate: candidate, independentCheck: 'complete', continuityCriticResponse: inspected.audit }
    const facts = buildTerminalFactProofs({ compilationId: 'commit', chapter: chapter(content), validation, evidence: context, review, stateHash: 'a'.repeat(64) })
    expect(facts[0].anchors).toHaveLength(8)
    expect(facts[0].anchors.every(anchor => anchor.start === 299 && anchor.end === 308 && anchor.quote === quote)).toBe(true)
    const unavailable = structuredClone(context)
    unavailable.previous!.segments = unavailable.previous!.segments.filter(part => part.segmentId !== 'p0')
    expect(inspectTerminalReview(candidate, content, response, true, unavailable)).toBeNull()
  })

  it.each([false, true])('consolidates only independently resolved old facts and retains unknown=%s', unresolved => {
    const current = chapter('The sensor remains offline. The battery remains flat.')
    const original = terminalCandidateSchema.parse({ exitState: { knowledge: ['The sensor remains offline.', 'The battery remains flat.'] } })
    const initial = inspectTerminalReview(original, current.content, raw([
      verdict('c0', 'sensor remains offline'), verdict('c0', 'battery remains flat', 'exitState.knowledge.1'),
    ]), true, evidence(current.content))!
    const saved = { terminalFactCoverage: advanceTerminalCoverage(spec(2), {}, current, initial) }
    const next = terminalCandidateSchema.parse({ exitState: { openLoops: ['Restore the offline sensor and flat battery.'] } })
    const input = terminalCoverageInput(spec(2), saved, current, next)!
    expect(input.obligations).toHaveLength(2)
    const dispositions = input.obligations.map((fact, i) => i === 1 && unresolved
      ? { id: fact.id, outcome: 'unknown', reason: 'Not reconciled.', sourceEvidence: [] }
      : { id: fact.id, outcome: 'replaced', reason: 'The entire unresolved fact remains in the combined repair obligation.',
        candidatePath: 'exitState.openLoops.0', sourceEvidence: [{ segmentId: 'c0', quote: current.content }] })
    const context = terminalEvidenceContext(current, null, 2, 1, input)
    const review = inspectTerminalReview(next, current.content, raw([verdict('c0', current.content, 'exitState.openLoops.0')], checks, dispositions), true, context)!
    expect(review.supported).toBe(!unresolved)
    const state = advanceTerminalCoverage(spec(2), saved, current, review)!
    expect(state.facts).toHaveLength(unresolved ? 2 : 1)
    if (unresolved) expect(state.facts.some(fact => fact.id === input.obligations[1].id)).toBe(true)
    expect(state.facts.some(fact => fact.id === input.obligations[0].id)).toBe(false)
  })

  it('keeps the v1 contract and task owner immutable, including no-candidate behavior', () => {
    const current = chapter('The sensor remains offline.'), old = evidence(current.content, 1)
    expect(old.factCoverage?.version).toBe(1)
    expect(terminalCoverageInput(spec(1), {}, current)).toBeUndefined()
    expect(terminalCoverageInput(spec(2), {}, current)?.version).toBe(2)
    const review = inspectTerminalReview(candidate, current.content, raw([verdict('c0', current.content)]), true, old)!
    const state = { terminalFactCoverage: advanceTerminalCoverage(spec(1), {}, current, review) }
    expect(() => readTerminalCoverageState(spec(2), state, current.id)).toThrow()
    expect(() => readTerminalCoverageState({ ...spec(1), id: 'other' }, state, current.id)).toThrow()
    expect(terminalReviewInput(candidate, evidence(current.content))).not.toContain('"nodes"')
  })

  for (const version of [1, 2] as const) {
    it.each(['supported', 'unknown', 'planned', 'absent', 'transient', 'no-evidence'] as const)(`requires whole-fact independent replacement under v${version}: %s`, status => {
      const current = chapter('The sensor remains offline and still needs repair.')
      const initial = inspectTerminalReview(candidate, current.content, raw([verdict('c0', 'sensor remains offline')]), true, evidence(current.content, version))!
      const saved = { terminalFactCoverage: advanceTerminalCoverage(spec(version), {}, current, initial) }
      const next = terminalCandidateSchema.parse({ exitState: { openLoops: ['Repair the offline sensor.'] } })
      const input = terminalCoverageInput(spec(version), saved, current, next)!
      const context = terminalEvidenceContext(current, null, 2, 1, input)
      const target = status === 'absent' ? 'exitState.openLoops.9' : status === 'transient' ? 'exitState.action' : 'exitState.openLoops.0'
      const disposition = { id: input.obligations[0].id, outcome: 'replaced', reason: 'The same unresolved repair obligation remains represented.', candidatePath: target,
        sourceEvidence: status === 'no-evidence' ? [] : [{ segmentId: 'c0', quote: 'still needs repair' }] }
      const review = inspectTerminalReview(next, current.content, raw([verdict('c0', 'still needs repair', 'exitState.openLoops.0', status === 'unknown' || status === 'planned' ? status : 'supported')], checks, [disposition]), true, context)
      if (version === 2 && status === 'supported') {
        expect(review?.supported).toBe(true)
        expect(advanceTerminalCoverage(spec(version), saved, current, review!)?.facts.map(fact => fact.field)).toEqual(['openLoops'])
      } else expect(review).toBeNull()
    })
  }
})
