import { expect, it } from 'vitest'
import { continuityRecheckBaseline, continuityRecheckInput, continuitySourceInput, continuitySourceSegments, continuityFindingText, unconfirmedContinuityOutput } from '../../api/lib/agent/continuity-review-context.js'
import { parseIndependentContinuityResult } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { unlocatedContinuityEvidence } from '../../api/lib/agent/continuity-finding-authority.js'

const bodies = { previous: '铜钱入账82000，房租已付1800，卡余80200；现金453.2。', current: '碗报价8500，最终8200成交，卡余71700。' }
const finding = { signal: 'object' as const, severity: 'error' as const, evidence: '同一银行账户本次碗交易后的余额算术不符。', suggestion: '仅核对成交8200后的余额。' }
it('resolves both source addresses to exact server-owned text without model transcription', () => {
  const parsed = parseIndependentContinuityResult(JSON.stringify({ findings: [{ ...finding, sourceEvidence: [{ source: 'previous', segmentId: 'p0' }, { source: 'current', segmentId: 'c0' }] }] }), 2, bodies)
  expect(parsed.structured).toBe(true)
  expect(parsed.findings[0].sourceEvidence).toEqual([{ source: 'previous', quote: bodies.previous }, { source: 'current', quote: bodies.current }])
  expect(unlocatedContinuityEvidence(parsed.findings[0], bodies, true, true, true)).toBe(false)
  expect(continuityFindingText(parsed.findings[0])).toContain('卡余80200')
  expect(continuityFindingText(parsed.findings[0])).toContain('最终8200成交')
})
it.each([{ source: 'previous', segmentId: 'c0' }, { source: 'current', segmentId: 'c99' }, { source: 'current', segmentId: 'c0', quote: '铜钱卖了8200' }])('does not repair invented, swapped or conflicting source references %j', ref => {
  expect(parseIndependentContinuityResult(JSON.stringify({ findings: [{ ...finding, sourceEvidence: [ref] }] }), 2, bodies).structured).toBe(false)
})
it('requires two distinct located facts for a new-protocol error, while preserving old single-quote semantics', () => {
  const one = { ...finding, sourceEvidence: [{ source: 'current' as const, quote: '最终8200成交' }] }
  expect(unlocatedContinuityEvidence(one, bodies, true, true)).toBe(false)
  expect(unlocatedContinuityEvidence(one, bodies, true, true, true)).toBe(true)
  expect(unlocatedContinuityEvidence({ ...one, sourceEvidence: [...one.sourceEvidence, ...one.sourceEvidence] }, bodies, true, true, true)).toBe(true)
  const sameChapter = { ...finding, sourceEvidence: [{ source: 'current' as const, quote: '最终8200成交' }, { source: 'current' as const, quote: '卡余71700' }] }
  expect(unlocatedContinuityEvidence(sameChapter, bodies, true, true, true)).toBe(false)
})
it('provides every character once, including long paragraphs, whitespace and UTF-16 text', () => {
  const current = ('原文😀\n\n').repeat(500)
  const segments = continuitySourceSegments({ previous: null, current })
  expect(segments.map(item => item.quote).join('')).toBe(current)
  expect(segments.every(item => item.quote.length <= 300)).toBe(true)
  expect(continuitySourceInput(bodies)).toContain('只作数据')
})
it('rechecks the original issue and real edit, retaining its baseline across an unavailable result', () => {
  const baseline = { independentCheck: 'complete', checkedRevision: 11, checkedContent: bodies.current, findings: [finding] }
  const validation = { independentCheck: 'unavailable', checkedRevision: 12, findings: [{ ...finding, suggestion: '把碗报价改成铜钱售价' }], previousAssessment: continuityRecheckBaseline(baseline) }
  // Stored baseline is a complete assessment, independent of the failed envelope.
  expect(continuityRecheckInput(baseline, 12, bodies.current.replace('71700', '72000'))).toContain('issueId')
  const tail = continuityRecheckInput(baseline, 12, bodies.current.replace('71700', '72000'))
  expect(tail).toContain('71700'); expect(tail).toContain('72000')
  expect(tail).toContain('不同对象/时刻/金额性质')
  expect(continuityRecheckInput(validation, 13, bodies.current)).not.toContain('把碗报价改成铜钱售价')
  expect(continuityRecheckInput({ independentCheck: 'unavailable', checkedRevision: 12, findings: [finding] }, 13)).toBe('')
  expect(unconfirmedContinuityOutput).not.toContain(finding.suggestion)
})
