import { describe, expect, it } from 'vitest'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { advanceTerminalCoverage, terminalCoverageInput, readTerminalCoverageState } from '../../api/lib/agent/terminal-fact-coverage.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { currentTerminalReview, inspectTerminalReview, terminalCandidateSchema, terminalReviewFailure, terminalReviewInput } from '../../api/lib/agent/terminal-state-review.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { applyContinuityReassessment, continuityReassessmentRequest } from '../../api/lib/agent/assessment-response-lifecycle.js'

const spec = { id: 'same-original-task', scope: { terminalCoverageProtocol: 1 } }
const chapter = { id: 'chapter', revision: 7, orderIndex: 4, content: '林舟右掌有伤。他的心情未明，门仍关着。' }
const full = terminalCandidateSchema.parse({ exitState: { body: ['林舟右掌有伤'], emotion: ['林舟很安心'] } })
const bodyOnly = terminalCandidateSchema.parse({ exitState: { body: ['林舟右掌有伤'] } })
const empty = terminalCandidateSchema.parse({ exitState: {} })
const semanticChecks = ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'not_applicable', reason: '合成事实核验。', findingIndexes: [] }))
const verdict = (path: string, value = 'supported', quote = '林舟右掌有伤') => ({ path, verdict: value, basis: 'current', sourceEvidence: [{ segmentId: 'c0', quote }] })
const raw = (terminalVerdicts: unknown[], terminalDispositions?: unknown[]) => JSON.stringify({ findings: [], semanticChecks, terminalVerdicts,
  ...(terminalDispositions ? { terminalDispositions } : {}) })
function assess(candidate = full, preparedContext: unknown = {}, current = chapter,
  response = raw([verdict('exitState.body.0'), verdict('exitState.emotion.0', 'unknown', '心情未明')])) {
  const evidence = terminalEvidenceContext(current, null, 2, 1, terminalCoverageInput(spec, preparedContext, current, candidate))
  const inspected = inspectContinuityResponse(response, { previous: null, current: current.content, terminalEvidence: evidence }, true, 8, candidate)
  const validation = { terminalCandidate: candidate, independentCheck: 'complete', continuityCriticResponse: inspected.audit }
  const review = currentTerminalReview(validation, current.content, evidence)
  return { evidence, validation, inspected, review }
}
function baseline() {
  const first = assess()
  expect(first.review?.supported).toBe(false)
  const state = advanceTerminalCoverage(spec, {}, chapter, first.review!)!
  return { terminalFactCoverage: state }
}

describe('fresh bounded terminal fact coverage', () => {
  it.each(['valid', 'missing', 'invented-quote', 'old-protocol'] as const)('keeps the existing one full reassessment usable only with valid frozen fact dispositions: %s', scenario => {
    const context = baseline(), current = { ...chapter, content: '医师确认林舟右掌伤口已经痊愈。', revision: 8 }
    const evidence = terminalEvidenceContext(current, null, 2, 1, terminalCoverageInput(spec, context, current, empty))
    if (scenario === 'old-protocol') delete evidence.factCoverage
    const bodies = { previous: null, current: current.content, terminalEvidence: evidence }
    const first = inspectContinuityResponse('{"findings":[]}', bodies, true, 8, empty)
    expect(first.complete).toBe(false)
    const id = context.terminalFactCoverage.facts[0].id
    const second = JSON.stringify({ decisions: [], findings: [], semanticChecks, terminalVerdicts: [],
      ...(scenario !== 'missing' ? { terminalDispositions: [{ id, outcome: 'ended', reason: '当前正文明确伤口痊愈。',
        sourceEvidence: [{ segmentId: 'c0', quote: scenario === 'invented-quote' ? '伪造的解除原文' : '伤口已经痊愈' }] }] } : {}) })
    if (scenario !== 'valid') expect(() => applyContinuityReassessment(first, second, bodies)).toThrow()
    else {
      expect(continuityReassessmentRequest('原系统', '原冻结输入', first, bodies).content).toContain('terminalDispositions')
      const completed = applyContinuityReassessment(first, second, bodies)
      expect(completed.complete).toBe(true)
      const validation = { terminalCandidate: empty, independentCheck: 'complete', continuityCriticResponse: completed.audit }
      expect(currentTerminalReview(validation, current.content, evidence)?.supported).toBe(true)
      expect(JSON.parse(completed.audit.rawResponse.content)).toBe(second)
    }
  })
  it('keeps individually supported facts when another candidate claim is unknown', () => {
    const context = baseline(), input = terminalCoverageInput(spec, context, chapter, empty)!
    expect(context.terminalFactCoverage.facts).toMatchObject([{ field: 'body', claim: '林舟右掌有伤' }])
    expect(input.obligations).toHaveLength(1)
    expect(input.obligations[0].field).toBe('body')
    expect(terminalReviewInput(empty, terminalEvidenceContext(chapter, null, 2, 1, input))).toContain('旧引文仍在不证明持续')
  })
  it('does not infer a persisting fact from an unchanged old quote or accept silent omission', () => {
    const before = baseline(), unchanged = structuredClone(before)
    const next = { ...chapter, revision: 8, content: chapter.content.replace('门仍关着', '门依旧关着') }
    const missing = assess(empty, before, next, raw([]))
    expect(missing.inspected.audit.classification).toBe('terminal_invalid')
    expect(missing.review).toBeNull()
    expect(before).toEqual(unchanged)
    const id = terminalCoverageInput(spec, before, next, empty)!.obligations[0].id
    const unknown = assess(empty, before, next, raw([], [{ id, outcome: 'unknown', reason: '全文不能确定该状态在章末是否持续。', sourceEvidence: [] }]))
    expect(unknown.inspected.complete).toBe(true)
    expect(unknown.review?.supported).toBe(false)
    expect(terminalReviewFailure(unknown.validation, next.content, unknown.evidence)).toMatchObject({ outcome: 'failed', failureCode: 'TERMINAL_STATE_REVIEW_REQUIRED' })
    const after = advanceTerminalCoverage(spec, before, next, unknown.review!)!
    expect(after.facts).toEqual(before.terminalFactCoverage.facts)
    expect(after.lastReview.input.obligations).toHaveLength(1)
  })
  it('requires a fresh supported verdict for an exactly retained claim and reuses its exact input snapshot', () => {
    const before = baseline(), checked = assess(bodyOnly, before, chapter, raw([verdict('exitState.body.0')]))
    expect(checked.evidence.factCoverage?.obligations).toEqual([])
    expect(checked.review?.supported).toBe(true)
    const state = advanceTerminalCoverage(spec, before, chapter, checked.review!)!
    const next = terminalCoverageInput(spec, { terminalFactCoverage: state }, chapter, bodyOnly)
    expect(next).toEqual(checked.evidence.factCoverage)
    expect(currentTerminalReview(checked.validation, chapter.content, { ...checked.evidence, factCoverage: next })?.supported).toBe(true)
    expect(assess(bodyOnly, before, chapter, raw([verdict('exitState.body.0', 'unknown')])).review?.supported).toBe(false)
  })
  it('accepts a current independent ended disposition, preserves audit binding, and removes only that obligation', () => {
    const before = baseline(), next = { ...chapter, revision: 8, content: '医师确认林舟右掌伤口已经痊愈。' }
    const id = terminalCoverageInput(spec, before, next, empty)!.obligations[0].id
    const checked = assess(empty, before, next, raw([], [{ id, outcome: 'ended', reason: '章末医师确认伤口痊愈，旧伤状态解除。', sourceEvidence: [{ segmentId: 'c0', quote: '伤口已经痊愈' }] }]))
    expect(checked.review?.supported).toBe(true)
    const state = advanceTerminalCoverage(spec, before, next, checked.review!)!
    expect(state.facts).toEqual([])
    expect(terminalCoverageInput(spec, { terminalFactCoverage: state }, next, empty)).toEqual(checked.evidence.factCoverage)
    const noObligations = { ...checked.evidence, factCoverage: { ...checked.evidence.factCoverage!, obligations: [] } }
    expect(currentTerminalReview(checked.validation, next.content, noObligations)).toBeNull()
  })
  it('only replaces a prior fact with a fresh supported candidate from the same field', () => {
    const before = baseline(), next = { ...chapter, revision: 8, content: '林舟右掌伤口已结痂，仍不能握紧。' }
    const candidate = terminalCandidateSchema.parse({ exitState: { body: ['林舟右掌已结痂但仍不能握紧'] } })
    const id = terminalCoverageInput(spec, before, next, candidate)!.obligations[0].id
    const decision = { id, outcome: 'replaced', reason: '同一伤势在章末的实际进展由新候选完整表示。', candidatePath: 'exitState.body.0', sourceEvidence: [] }
    const checked = assess(candidate, before, next, raw([verdict('exitState.body.0', 'supported', '右掌伤口已结痂，仍不能握紧')], [decision]))
    expect(checked.review?.supported).toBe(true)
    expect(advanceTerminalCoverage(spec, before, next, checked.review!)?.facts.map(item => item.claim)).toEqual(candidate.exitState.body)
    expect(assess(candidate, before, next, raw([verdict('exitState.body.0', 'unknown', '右掌伤口已结痂')], [decision])).review).toBeNull()
    expect(assess(candidate, before, next, raw([verdict('exitState.body.0', 'supported', '右掌伤口已结痂')], [{ ...decision, candidatePath: 'exitState.objects.0' }])).review).toBeNull()
  })
  it.each(['missing', 'duplicate', 'extra', 'invented_quote', 'wrong_source', 'no_quote'] as const)('rejects %s disposition evidence', kind => {
    const context = baseline(), id = terminalCoverageInput(spec, context, chapter, empty)!.obligations[0].id
    const item = { id, outcome: 'ended', reason: '需当前正文的明确解除证据。', sourceEvidence: [{ segmentId: 'c0', quote: '右掌有伤' }] }
    const items = kind === 'missing' ? [] : kind === 'duplicate' ? [item, item] : [item]
    if (kind === 'extra') item.id = '0'.repeat(64)
    if (kind === 'invented_quote') item.sourceEvidence[0].quote = '原文不存在的解除事实'
    if (kind === 'wrong_source') item.sourceEvidence[0].segmentId = 'p0'
    if (kind === 'no_quote') item.sourceEvidence = []
    expect(assess(empty, context, chapter, raw([], items)).review).toBeNull()
  })
  it('does not upgrade old frozen contracts or accept another task/chapter state', () => {
    const context = baseline()
    expect(terminalCoverageInput({ id: spec.id, scope: {} }, context, chapter, empty)).toBeUndefined()
    expect(readTerminalCoverageState({ id: spec.id, scope: {} }, { terminalFactCoverage: 'legacy-unrelated' }, chapter.id)).toBeUndefined()
    expect(() => terminalCoverageInput({ ...spec, id: 'other-task' }, context, chapter, empty)).toThrow()
    expect(() => terminalCoverageInput(spec, context, { ...chapter, id: 'other-chapter' }, empty)).toThrow()
    expect(inspectTerminalReview(empty, chapter.content, raw([]), true)?.supported).toBe(true)
  })
  it('bounds stored facts instead of silently truncating them', () => {
    const context = baseline()
    const facts = Array.from({ length: 201 }, (_, index) => ({ field: 'body', claim: `已证实合成状态${index}` }))
      .map(item => ({ ...item, id: runtimeJson(item).hash }))
    expect(() => readTerminalCoverageState(spec, { terminalFactCoverage: { ...context.terminalFactCoverage, facts } }, chapter.id)).toThrow()
    expect(() => readTerminalCoverageState(spec, { terminalFactCoverage: { ...context.terminalFactCoverage, facts: [{ ...facts[0], id: '0'.repeat(64) }] } }, chapter.id)).toThrow()
  })
})
