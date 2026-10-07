import { describe, expect, it } from 'vitest'
import { allowsLimitedWritingDelivery, allowsLimitedWritingContract, limitedReviewDependency, limitedWritingDeliverySchema, readRunLimitedWritingOutcome } from '../../api/lib/agent/writing-delivery-limitations.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'

describe('limited writing delivery contract', () => {
  it.each(['写下一章', '写第一章，只要标题和正文', '修改本章正文'])('accepts an original writing artifact: %s', prompt => {
    expect(allowsLimitedWritingDelivery(prompt)).toBe(true)
  })
  it.each(['检查本章连续性', '写下一章，检查通过后才能交付', '写下一章，必须通过所有检查', '写下一章，并生成封面', '写下一章，同时给出完整分析报告', '全书审阅'])('does not waive independent or hard requirements: %s', prompt => {
    expect(allowsLimitedWritingDelivery(prompt)).toBe(false)
  })
  it.each(['完成连续性检查及章节终态提交', '完成质量检查及章节终态提交', '提交章节桥', 'continuity check and chapter_bridge_commit', 'quality check and chapter_bridge_commit'])('recognizes only explicit review dependencies: %s', content => {
    expect(limitedReviewDependency(content)).toBe(true)
  })
  it.each(['完成正文写作并检查连续性', '检查第二章连续性', '检查第二章质量', '完成质量分析报告', '提交封面及章节终态', '完成场景写作', '保存大纲', '分析连续性原因'])('keeps unrelated or uncertain work pending: %s', content => {
    expect(limitedReviewDependency(content)).toBe(false)
  })
  it('does not interpret ordinary historical usage as a limited completion', () => {
    expect(readRunLimitedWritingOutcome({ promptTokens: 10 })).toBeNull()
    expect(() => readRunLimitedWritingOutcome({ outcome: { kind: 'delivered_with_limitations', summary: 'unbound' } })).toThrow()
    expect(limitedWritingDeliverySchema.safeParse({ version: 1, taskId: 'task', chapters: [] }).success).toBe(false)
  })
  it('uses the same frozen hard requirements for main and parent limited delivery', () => {
    const spec = buildTaskSpec({ runId: 'run', novelId: 'novel', prompt: '写下一章' })
    expect(allowsLimitedWritingContract(spec, '写下一章')).toBe(true)
    spec.hardConstraints.push({ id: 'author', kind: 'author_directive', text: '不得跳过连续性检查，必须复核通过才能交付' })
    expect(allowsLimitedWritingContract(spec, '写下一章')).toBe(false)
    spec.hardConstraints = []
    spec.expectedOutputs.push({ kind: 'validation_report', description: '完整连续性报告', required: true })
    expect(allowsLimitedWritingContract(spec, '写下一章')).toBe(false)
  })
})
