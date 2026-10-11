import { describe, expect, it } from 'vitest'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { parseIndependentContinuityResult } from '../../api/lib/agent/tools/story-compiler-tools.js'

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
