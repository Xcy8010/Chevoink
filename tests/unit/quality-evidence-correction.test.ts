import { describe, expect, it } from 'vitest'
import type { CriticQualityFinding } from '../../shared/contracts/humanity-quality-contracts.js'
import { coerceCriticFindings, correctQualityEvidence, locateQuoteSpans, unlocatedQualityEvidence } from '../../api/lib/agent/quality-evidence.js'

const finding: CriticQualityFinding = { signal: 'explanation_echo', severity: 'warning', quote: '模型改写的引文', explanation: '重复解释', suggestion: '删除重复解释', confidence: 0.9 }
const content = '她关上了门。走廊里的声音消失了。'

describe('quality evidence correction', () => {
  it('corrects only an unbound quote while preserving the original judgment', () => {
    const result = correctQualityEvidence(content, [finding], { corrections: [{ index: 0, quote: '走廊里的声音消失了。' }] })
    expect(result).toEqual([{ ...finding, quote: '走廊里的声音消失了。' }])
    expect(unlocatedQualityEvidence(content, result)).toEqual([])
    expect(finding.quote).toBe('模型改写的引文')
  })
  it.each([
    { corrections: [] },
    { corrections: [{ index: 0, quote: '不存在的文本' }] },
    { corrections: [{ index: 0, quote: '她关上……声音消失了。' }] },
    { corrections: [{ index: 0, quote: '她关上了门。' }, { index: 0, quote: '走廊里的声音消失了。' }] },
    { corrections: [{ index: 99, quote: '她关上了门。' }] },
    { findings: [] },
  ])('retains every unresolved judgment for malformed or ambiguous correction %#', raw => {
    expect(correctQualityEvidence(content, [finding], raw)).toEqual([finding])
    expect(unlocatedQualityEvidence(content, [finding])).toHaveLength(1)
  })
  it('does not accept ambiguous evidence or replace already valid evidence', () => {
    expect(correctQualityEvidence('重复。重复。', [finding], { corrections: [{ index: 0, quote: '重复。' }] })).toEqual([finding])
    const bound = { ...finding, quote: '她关上了门。' }
    expect(correctQualityEvidence(content, [bound], { corrections: [{ index: 0, quote: '走廊里的声音消失了。' }] })).toEqual([bound])
  })
})

describe('quality evidence normalized binding', () => {
  it('binds a quote copied across a paragraph break without the blank line', () => {
    const chapter = '废窑的灰还在落。\n\n他停住脚，听了很久。'
    expect(locateQuoteSpans(chapter, '废窑的灰还在落。他停住脚，听了很久。')).toEqual([{ start: 0, end: chapter.length }])
    expect(unlocatedQualityEvidence(chapter, [{ ...finding, quote: '废窑的灰还在落。他停住脚，听了很久。' }])).toEqual([])
  })
  it.each([
    { chapter: '他说：「废窑里还有存货。」', quote: '“废窑里还有存货。”', expected: '「废窑里还有存货。」', label: 'quote-mark style' },
    { chapter: '他愣住了……半晌才开口。', quote: '他愣住了...', expected: '他愣住了……', label: 'ellipsis as periods' },
    { chapter: '他愣住了……半晌才开口。', quote: '他愣住了。半晌', expected: '他愣住了……半晌', label: 'period for ellipsis' },
    { chapter: '他说——好。', quote: '他说—好', expected: '他说——好', label: 'dash run written shorter' },
    { chapter: '“三文，”他说。', quote: '“三文,”他说。', expected: '“三文，”他说。', label: 'fullwidth comma' },
    { chapter: '门开了．风没进来。', quote: '门开了.风没进来。', expected: '门开了．风没进来。', label: 'fullwidth period' },
  ])('binds an equivalent quote variant: $label', ({ chapter, quote, expected }) => {
    const spans = locateQuoteSpans(chapter, quote)
    expect(spans).toHaveLength(1)
    expect(chapter.slice(spans[0].start, spans[0].end)).toBe(expected)
  })
  it('does not bind evidence that stays ambiguous after normalization', () => {
    expect(locateQuoteSpans('他看到门。他看到门。', '他看到门。')).toHaveLength(2)
    expect(locateQuoteSpans('他认为 "废窑" 还亮着，牌子上写着「废窑」。', '“废窑”')).toHaveLength(2)
  })
})

describe('critic finding coercion', () => {
  it('rescues findings with out-of-range fields instead of failing the whole report', () => {
    const result = coerceCriticFindings({ findings: [
      { signal: 'emotion_grounding', severity: 'error', quote: '长'.repeat(400), explanation: '缺少动作', suggestion: '局部调整', confidence: 85 },
      { signal: 'reader_pull', severity: 'warning', quote: '原文', explanation: '缺少张力', suggestion: '补充动作' },
    ] })
    expect(result).toMatchObject({ dropped: 0 })
    expect(result!.findings).toHaveLength(2)
    expect(result!.findings[0]).toMatchObject({ signal: 'emotion_grounding', severity: 'warning', confidence: 1 })
    expect(result!.findings[0].quote).toHaveLength(360)
    expect(result!.findings[1].confidence).toBe(0.7)
  })
  it('drops only unusable items and truncates beyond the cap', () => {
    const valid = { signal: 'emotion_grounding' as const, severity: 'advisory' as const, quote: '原文', explanation: '说明', suggestion: '建议' }
    const result = coerceCriticFindings({ findings: [null, { ...valid, quote: '' },
      ...Array.from({ length: 26 }, (_, index) => ({ ...valid, quote: `原文${index}`, explanation: `说明${index}` }))] })
    expect(result).toMatchObject({ dropped: 4 })
    expect(result!.findings).toHaveLength(24)
  })
  it('returns null only when the envelope itself is unrecognizable', () => {
    expect(coerceCriticFindings(null)).toBeNull()
    expect(coerceCriticFindings([])).toBeNull()
    expect(coerceCriticFindings({})).toBeNull()
    expect(coerceCriticFindings({ findings: [] })).toEqual({ findings: [], dropped: 0 })
  })
})
