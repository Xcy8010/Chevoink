import { describe, expect, it } from 'vitest'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { parseIndependentContinuityResult } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { createHash } from 'node:crypto'

const bodies = { previous: '前章的门开着。', current: '本章的门锁着。' }
const finding = { signal: 'object' as const, severity: 'error' as const, evidence: '同一扇门同时开着和锁着。', suggestion: '按原文事实统一门的状态。',
  sourceEvidence: [{ source: 'previous' as const, quote: '门开着' }, { source: 'current' as const, quote: '门锁着' }] }
const wrapper = (findings: unknown[] = [finding]) => JSON.stringify({ report: { findings } })

describe('mechanical continuity envelope compatibility', () => {
  it('preserves all 31 valid judgments while frozen parsers retain their original limit', () => {
    const findings = Array.from({ length: 31 }, (_, index) => ({ ...finding, evidence: '原意见 ' + index }))
    const raw = JSON.stringify({ findings })
    expect(parseIndependentContinuityResult(raw, 1, bodies).structured).toBe(false)
    expect(parseIndependentContinuityResult(raw, 2, bodies).structured).toBe(false)
    expect(parseIndependentContinuityResult(raw, 3, bodies)).toEqual({ structured: true, findings })
  })
  it('locally unwraps the complete exact report and keeps raw audit past 8K', () => {
    const raw = ' '.repeat(9000) + wrapper([finding, { ...finding, evidence: '第二条意见', suggestion: '另一个原建议' }])
    const inspected = inspectContinuityResponse(raw, bodies)
    expect(inspected).toMatchObject({ structured: true, audit: { classification: 'complete', unwrapped: true } })
    expect(inspected.findings).toEqual(JSON.parse(raw).report.findings)
    expect(JSON.parse(inspected.audit.rawResponse.content)).toBe(raw)
    expect(inspected.audit.rawResponse.complete).toBe(true)
    expect(parseIndependentContinuityResult(raw, 2, bodies).structured).toBe(false)
  })
  it.each(['unknown', 'truncated', 'empty', 'invalid-enum', 'ambiguous', 'duplicate', 'unfinished'] as const)('%s cannot become a rescued empty success', scenario => {
    const raw = scenario === 'unknown' ? '检查结果不明' : scenario === 'truncated' ? '{"report":{"findings":['
      : scenario === 'empty' ? wrapper([]) : scenario === 'invalid-enum' ? wrapper([{ ...finding, severity: 'error/warning' }])
        : scenario === 'ambiguous' ? JSON.stringify({ report: { findings: [finding] }, extra: { findings: [finding] } })
          : scenario === 'duplicate' ? '{"report":{"findings":[],"findings":[]}}' : wrapper()
    expect(inspectContinuityResponse(raw, bodies, scenario !== 'unfinished').structured).toBe(false)
  })
  it('retains source-invalid judgments for the existing reference validator without marking them complete', () => {
    const raw = wrapper([{ ...finding, sourceEvidence: [{ source: 'previous', quote: '门锁着' }] }])
    expect(inspectContinuityResponse(raw, bodies)).toMatchObject({ structured: true, findings: [{ ...finding, sourceEvidence: [{ source: 'previous', quote: '门锁着' }] }], audit: { classification: 'source_invalid' } })
  })
})

describe('explicit parser4 exact same-source segment relocation', () => {
  const source = { previous: '前章证据', current: '甲'.repeat(1800) + '唯一原引文\n包含"转义"。' + '乙'.repeat(350) }
  const refs = Array.from({ length: 4 }, (_, index) => ({ ...finding, evidence: `原判断${index}`, sourceEvidence: [
    { source: 'previous', segmentId: 'p0', quote: '前章证据' },
    { source: 'current', segmentId: index === 1 ? 'c5' : 'c6', quote: '唯一原引文\n包含"转义"。' },
  ] }))
  it('retains all four judgments and eight quotes; only the one wrong c5 address is audited as c6', () => {
    const raw = wrapper(refs), result = inspectContinuityResponse(raw, source, true, 4)
    expect(inspectContinuityResponse(raw, source)).toMatchObject({ structured: false, audit: { parserVersion: 3, classification: 'findings_invalid' } })
    expect(parseIndependentContinuityResult(raw, 3, source).structured).toBe(false)
    expect(result).toMatchObject({ structured: true, audit: { parserVersion: 4, classification: 'complete', sourceRelocations: [{ findingIndex: 1, referenceIndex: 1, source: 'current', originalSegmentId: 'c5', actualSegmentId: 'c6', quoteHash: createHash('sha256').update('唯一原引文\n包含"转义"。').digest('hex') }] } })
    expect(result.findings).toEqual(refs.map(item => ({ ...item, sourceEvidence: item.sourceEvidence.map(({ source, quote }) => ({ source, quote })) })))
    expect(JSON.parse(result.audit.rawResponse.content)).toBe(raw)
  })
  it.each(['repeated', 'same-segment-repeated', 'cross-source', 'wrong-prefix', 'bad-quote', 'spans-boundary', 'no-quote'] as const)('%s cannot supply a relocation', scenario => {
    const current = scenario === 'repeated' ? source.current + '唯一原引文\n包含"转义"。'
      : scenario === 'same-segment-repeated' ? '甲'.repeat(1800) + '重复重复' : source.current
    const quote = scenario === 'same-segment-repeated' ? '重复' : scenario === 'cross-source' ? '前章证据'
      : scenario === 'bad-quote' ? '不存在的句子' : scenario === 'spans-boundary' ? '甲唯一原引文' : '唯一原引文\n包含"转义"。'
    const ref = { source: 'current', segmentId: scenario === 'wrong-prefix' ? 'p0' : 'c5', ...(scenario === 'no-quote' ? {} : { quote }) }
    const result = inspectContinuityResponse(wrapper([{ ...finding, sourceEvidence: [ref] }]), { ...source, current }, true, 4)
    expect(result.audit.classification).not.toBe('complete')
    expect(result.audit.sourceRelocations).toEqual([])
  })
})
