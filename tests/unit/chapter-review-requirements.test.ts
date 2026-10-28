import { describe, expect, it } from 'vitest'
import { originalChapterReviewRequirements } from '../../api/lib/agent/chapter-review-requirements.js'

const spec = (targets = [{ chapterId: 'c13' as string | null, orderIndex: 13 }]) => ({
  intent: 'write', qualityMode: 'balanced', writingPacing: 'explicit_writing',
  scope: { writing: { kind: 'bounded', targets } },
})
const both = { continuity: true, quality: true }
const current = { id: 'c13', orderIndex: 13 }

describe('original author requirements bind one real chapter', () => {
  it('does not attach manuscript delivery checks to a frozen advisory request with a write label', () => {
    const value = spec()
    const original = { prompt: '解释连续性检查失败的原因并给出开发建议。',
      spec: { ...value, writingPacing: undefined, scope: { ...value.scope,
        authorEffects: { version: 1, requestHash: 'a'.repeat(64), manuscript: false, structure: false } } } }
    expect(originalChapterReviewRequirements(original, current)).toEqual({ continuity: false, quality: false })
    expect(originalChapterReviewRequirements(original)).toEqual({ continuity: false, quality: false })
  })
  it.each([
    ['写第13章。', both],
    ['写第13章，本章不用质量检查。', { continuity: true, quality: false }],
    ['写第13章，第十三章不需要人类感质量检查。', { continuity: true, quality: false }],
    ['写第13章，这章无需连续性检查。', { continuity: false, quality: true }],
    ['写第13章，本章不做任何检查。', { continuity: false, quality: false }],
    ['写第13章，skip quality checks for chapter 13.', { continuity: true, quality: false }],
    ['写第13章，不要跳过质量检查。', both],
    ['写第13章，本章不允许跳过质量检查。', both],
    ['写第13章，本章是否不用质量检查？', both],
    ['写第13章。如果时间不够，本章不用质量检查。', both],
    ['写第13章。你觉得，本章不用质量检查，可以吗？', both],
    ['写第13章，原句“如果时间不够”保留，本章不用质量检查。', { continuity: true, quality: false }],
    ['写第13章，跳过质量检查？', both],
    ['写第13章，如果本章不用质量检查会怎样。', both],
    ['写第13章，本章不用质量检查但要做连续性检查。', { continuity: true, quality: false }],
    ['写第13章，本章不用连续性检查但需要人类感质量检查。', { continuity: false, quality: true }],
    ['写第13章，不是不用质量检查。', both],
    ['写第13章，不是不需要质量检查。', both],
    ['写第13章，无需跳过连续性检查。', both],
    ['写第13章，不必不做质量检查。', both],
    ['写第13章，无需通过质量检查。', both],
    ['写第13章，本章不用质量检查，但质量检查必须完成。', both],
    ['写第13章，保留台词“本章不用质量检查”。', both],
    ['写第13章。\n```\n本章不用质量检查\n```', both],
    ['写第13章，原文「无需连续性检查」保持不变。', both],
    ['写第13章，示例是本章不用质量检查。', both],
    ['写第13章，不要在回复里写不用质量检查。', both],
    ['写第13章，第14章不用质量检查。', both],
    ['写第13章，不检查第13章标题的标点。', both],
  ] as const)('%s', (prompt, expected) => {
    const original = { spec: spec(), prompt }, frozen = structuredClone(original)
    expect(originalChapterReviewRequirements(original, current)).toEqual(expected)
    expect(original).toEqual(frozen)
  })
  it('keeps different chapters and check kinds independent, with capability union', () => {
    const original = { spec: spec([{ chapterId: 'c13', orderIndex: 13 }, { chapterId: 'c14', orderIndex: 14 }]),
      prompt: '写第13章和第14章。第13章不用质量检查，第14章不用连续性检查。' }
    expect(originalChapterReviewRequirements(original, current)).toEqual({ continuity: true, quality: false })
    expect(originalChapterReviewRequirements(original, { id: 'c14', orderIndex: 14 })).toEqual({ continuity: false, quality: true })
    expect(originalChapterReviewRequirements(original)).toEqual(both)
  })
  it('requires actual order for a new unbound chapter and rejects a foreign bound identity', () => {
    const original = { spec: spec([{ chapterId: null, orderIndex: 13 }, { chapterId: null, orderIndex: 14 }]),
      prompt: '写第13章和第14章。第13章不用质量检查。' }
    expect(originalChapterReviewRequirements(original, { id: 'new', orderIndex: 13 })).toEqual({ continuity: true, quality: false })
    expect(originalChapterReviewRequirements(original, { id: 'new', orderIndex: 14 })).toEqual(both)
    expect(originalChapterReviewRequirements(original, { id: 'new' })).toEqual(both)
    expect(originalChapterReviewRequirements({ spec: spec(), prompt: '第13章不用检查。' }, { id: 'foreign', orderIndex: 13 })).toEqual(both)
  })
  it('applies an explicit all-chapters waiver only to original targets', () => {
    const original = { spec: spec([{ chapterId: 'c13', orderIndex: 13 }, { chapterId: 'c14', orderIndex: 14 }]),
      prompt: '写第13章和第14章。所有章节不用质量检查。' }
    expect(originalChapterReviewRequirements(original)).toEqual({ continuity: true, quality: false })
    expect(originalChapterReviewRequirements(original, { id: 'foreign', orderIndex: 15 })).toEqual(both)
  })
  it('separates a review directive after a chapter list comma retained by the writing lexer', () => {
    const original = { spec: spec([{ chapterId: null, orderIndex: 13 }, { chapterId: null, orderIndex: 14 }]),
      prompt: '写第13章和第14章，第13章不用质量检查。' }
    expect(originalChapterReviewRequirements(original, { id: 'new13', orderIndex: 13 })).toEqual({ continuity: true, quality: false })
    expect(originalChapterReviewRequirements(original, { id: 'new14', orderIndex: 14 })).toEqual(both)
    expect(originalChapterReviewRequirements(original)).toEqual(both)
  })

})
