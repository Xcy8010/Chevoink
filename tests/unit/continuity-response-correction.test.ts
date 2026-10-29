import { afterEach, describe, expect, it, vi } from 'vitest'
import { reviewContinuity } from '../../api/lib/agent/continuity-review.js'
import { currentContinuityRunnerFixture } from '../helpers/current-continuity-runner-fixture.js'

import { inspectContinuityResponse, continuityUnlocatedCandidateCount } from '../../api/lib/agent/continuity-format-recovery.js'
import { applyContinuityEvidenceCorrection, continuityCorrectionRecoveryDecision } from '../../api/lib/agent/continuity-response-correction.js'

afterEach(() => vi.restoreAllMocks())

const bodies = { previous: '上一章门打开。', current: '这一章门锁住。' }
const finding = { signal: 'object', severity: 'error', evidence: '同一门状态互斥。', suggestion: '统一实际状态。', sourceEvidence: [
  { source: 'previous', segmentId: 'p0', quote: '门打开' }, { source: 'current', segmentId: 'c0', quote: '杜撰引文' },
] }
const raw = JSON.stringify({ findings: [finding, { ...finding, evidence: '另一原意见。', severity: 'warning' }] })
const original = () => inspectContinuityResponse(raw, bodies, true, 5)
const corrections = () => ({ corrections: [0, 1].map(index => ({ index, sourceEvidence: [
  { source: 'previous', segmentId: 'p0', quote: '门打开' }, { source: 'current', segmentId: 'c0', quote: '门锁住' },
] })) })

describe('continuity typed response and evidence correction', () => {
  it('models accounting, output, assessment, application, admission and binding independently', () => {
    for (const billingKnown of [false, true]) for (const providerComplete of [false, true]) for (const assessmentValid of [false, true])
      for (const applied of [false, true]) for (const newAdmission of [false, true]) for (const bindingMatches of [false, true]) {
        const decision = continuityCorrectionRecoveryDecision({ billingKnown, providerComplete, assessmentValid, applied, newAdmission, bindingMatches })
        if (!billingKnown) expect(decision).toBe('unknown')
        else if (applied) expect(decision).toBe('applied')
        else if (providerComplete && assessmentValid && bindingMatches) expect(decision).toBe('reuse')
        else expect(decision).toBe(newAdmission ? 'fresh' : 'wait')
      }
  })
  it('separates valid fields from invalid sources without losing a judgment or raw response', () => {
    expect(inspectContinuityResponse(raw, bodies, true, 4).audit.classification).toBe('findings_invalid')
    const inspected = original()
    expect(inspected).toMatchObject({ structured: true, complete: false, findings: [], candidateFindings: JSON.parse(raw).findings,
      audit: { parserVersion: 5, classification: 'source_invalid' } })
    expect(JSON.parse(inspected.audit.rawResponse.content)).toBe(raw)
    expect(inspected.audit.candidateFindings).toEqual(JSON.parse(raw).findings)
    expect(continuityUnlocatedCandidateCount(inspected)).toBe(2)
  })
  it('binds all exact original signals, severity, evidence and suggestions', () => {
    const result = applyContinuityEvidenceCorrection(original(), JSON.stringify(corrections()), bodies)
    expect(result.complete).toBe(true)
    expect(result.findings).toEqual(JSON.parse(raw).findings.map((item: object) => ({ ...item, sourceEvidence: [
      { source: 'previous', quote: '门打开' }, { source: 'current', quote: '门锁住' },
    ] })))
    expect(result.candidateFindings).toEqual(JSON.parse(raw).findings)
    expect(JSON.parse(result.audit.rawResponse.content)).toBe(raw)
  })
  it.each(['dropped', 'duplicate', 'changed-judgment', 'extra-finding', 'swapped-source', 'fewer-refs', 'invented'] as const)('rejects %s corrections', scenario => {
    const value = corrections()
    if (scenario === 'dropped') value.corrections.pop()
    if (scenario === 'duplicate') value.corrections[1].index = 0
    if (scenario === 'changed-judgment') Object.assign(value.corrections[0], { severity: 'warning' })
    if (scenario === 'extra-finding') value.corrections.push({ ...value.corrections[0], index: 2 })
    if (scenario === 'swapped-source') value.corrections[0].sourceEvidence[0].source = 'current'
    if (scenario === 'fewer-refs') value.corrections[0].sourceEvidence.pop()
    if (scenario === 'invented') value.corrections[0].sourceEvidence[1].quote = '不存在的引用'
    if (scenario === 'invented') expect(applyContinuityEvidenceCorrection(original(), JSON.stringify(value), bodies).complete).toBe(false)
    else expect(() => applyContinuityEvidenceCorrection(original(), JSON.stringify(value), bodies)).toThrow()
  })
  it.each(['same-call', 'new-call'] as const)('reuses the full corrected report for %s without another request', async identity => {
    const f = currentContinuityRunnerFixture(), unknown = { ...f.opinion(), evidence: [{ sourceId: 'missing-source-id' }] }
    const dispatch = f.dispatch(request => request.action === 'agent3ContinuityCritic' ? JSON.stringify({ findings: [unknown] })
      : JSON.stringify({ corrections: [{ index: 0, evidence: f.opinion().evidence }] }))
    expect(await reviewContinuity(f.ctx, { compilationId: 'compilation' }, { allowRepair: false, dispatch })).toMatchObject({ reviewCompleted: true })
    const original = structuredClone(f.report()), fees = structuredClone(f.fees)
    expect(await reviewContinuity({ ...f.ctx, callId: identity === 'same-call' ? f.ctx.callId : 'new-call' }, { compilationId: 'compilation' },
      { allowRepair: false, dispatch })).toMatchObject({ reviewCompleted: true })
    expect(f.report()).toEqual(original); expect(f.fees).toEqual(fees)
    expect(f.requests.map(row => row.action)).toEqual(['agent3ContinuityCritic', 'agent3ContinuityEvidenceCorrection'])
    expect(f.report().opinions[0].explanation).toBe(unknown.explanation)
  })
  it.each(['usage-unknown', 'incomplete', 'aborted', 'current-changed', 'previous-changed'] as const)('does not dispatch current correction work for %s', async scenario => {
    const f = currentContinuityRunnerFixture()
    if (scenario === 'usage-unknown' || scenario === 'incomplete') f.fees.push({ id: 'old', usageSource: scenario === 'incomplete' ? 'partial' : 'unknown',
      billingStatus: 'pending_usage', requestTokens: scenario === 'incomplete' ? 12 : null, responseTokens: null, reservedCreditMilli: 7 })
    if (scenario === 'aborted') f.controller.abort()
    f.ctx.assertCurrentExecution = async () => {
      if (scenario === 'current-changed') f.chapter.content += '作者已更新。'
      if (scenario === 'previous-changed') f.previous[0].content += '作者更正前文。'
    }
    await expect(reviewContinuity(f.ctx, { compilationId: 'compilation' }, { allowRepair: false, dispatch: f.dispatch(() => '{"findings":[]}') })).rejects.toBeDefined()
    expect(f.requests).toEqual([]); expect(f.artifacts.size).toBe(0)
  })
  it('keeps invalid and unfinished source-only replies incomplete without changing any opinion', async () => {
    for (const complete of [true, false]) {
      vi.restoreAllMocks()
      const f = currentContinuityRunnerFixture(), unknown = { ...f.opinion(), evidence: [{ sourceId: 'not-a-real-source' }] }
      const base = f.dispatch(request => request.action === 'agent3ContinuityCritic' ? JSON.stringify({ findings: [unknown] }) : '{"corrections":[]}')
      const result = await reviewContinuity(f.ctx, { compilationId: 'compilation' }, { allowRepair: false,
        dispatch: async request => ({ ...await base(request), ...(request.action === 'agent3ContinuityEvidenceCorrection' ? { providerComplete: complete } : {}) }) })
      expect(result).toMatchObject({ outcome: 'failed', reviewCompleted: false })
      expect(f.report().opinions).toEqual([unknown]); expect(f.report().unlocatedIndexes).toEqual([0])
      expect(f.requests).toHaveLength(2); expect(f.fees).toHaveLength(2)
    }
  })
  it.each(['aborted', 'body-changed', 'apply-failed'] as const)('preserves received correction raw and fees before %s application', async scenario => {
    const f = currentContinuityRunnerFixture(), unknown = { ...f.opinion(), evidence: [{ sourceId: 'missing-source' }] }
    const baseBind = f.bind.getMockImplementation()!
    if (scenario === 'apply-failed') f.bind.mockImplementationOnce(baseBind).mockRejectedValueOnce(new Error('synthetic report binding failed'))
    const first = JSON.stringify({ findings: [unknown] }), second = JSON.stringify({ corrections: [{ index: 0, evidence: f.opinion().evidence }] })
    await expect(reviewContinuity(f.ctx, { compilationId: 'compilation' }, { allowRepair: false, dispatch: f.dispatch(request => {
      if (request.action === 'agent3ContinuityEvidenceCorrection') {
        if (scenario === 'aborted') f.controller.abort()
        if (scenario === 'body-changed') f.chapter.content += '作者新文。'
        return second
      }
      return first
    }) })).rejects.toBeDefined()
    expect(f.report().rawResponses).toEqual([first, second]); expect(f.fees).toHaveLength(2)
    expect(f.report().opinions[0].explanation).toBe(unknown.explanation)
    expect(f.report().complete).toBe(false)
  })
})
