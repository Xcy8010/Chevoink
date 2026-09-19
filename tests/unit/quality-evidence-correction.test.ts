import { describe, expect, it } from 'vitest'
import type { CriticQualityFinding } from '../../shared/contracts/humanity-quality-contracts.js'
import { correctQualityEvidence, unlocatedQualityEvidence } from '../../api/lib/agent/quality-evidence.js'

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
