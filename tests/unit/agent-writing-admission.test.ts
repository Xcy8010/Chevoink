import { describe, expect, it } from 'vitest'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { isContinuationRequest } from '../../api/lib/agent/completion-guard.js'
import { restrictToolsToTask } from '../../api/lib/agent/tool-authority.js'
import { chapterReadTool } from '../../api/lib/agent/tools/read-tools.js'
import { chapterWriteTool, chapterCreateTool } from '../../api/lib/agent/tools/chapter-tools.js'

describe('ambiguous writing admission', () => {
  it.each(['下一步应该做什么', '接下来应该怎么做？', '其他的我都听你的', '其他我听你的', '其余事情交给你'])('keeps %s conversational without inheriting chapter effects', prompt => {
    const spec = buildTaskSpec({ runId: 'synthetic-run', novelId: 'synthetic-novel', chapterId: 'editor-chapter', prompt })
    expect(spec.writingPacing).toBe('conversation_only')
    expect(spec.scope.writing).toBeUndefined()
    expect(isContinuationRequest(prompt)).toBe(false)
    expect(restrictToolsToTask([chapterReadTool, chapterWriteTool, chapterCreateTool], spec)).toEqual([chapterReadTool])
  })
  it('retains explicit actions and exact existing-task continuations', () => {
    expect(buildTaskSpec({ runId: 'synthetic-run', novelId: 'synthetic-novel', prompt: '下一步帮我修改第71、72章' }).writingPacing).not.toBe('conversation_only')
    expect(isContinuationRequest('继续完成之前的任务')).toBe(true)
    expect(isContinuationRequest('继续写第73章')).toBe(false)
  })
})

describe('chapter actions with subordinate checks', () => {
  it.each([
    ['完成当前章节，不要跳过质量检查', 'write'],
    ['写下一章，不要跳过质量检查', 'write'],
    ['写下一章并不得跳过连续性检查', 'write'],
    ['写第一章，完成后检查质量', 'write'],
    ['写下一章但不要改前文，必须检查本章', 'write'],
    ['修改第一章，不要跳过质量检查', 'revise'],
    ['检查当前章节并修复问题', 'revise'],
    ['Write the current chapter. Do not skip any checks', 'write'],
    ['Write the next chapter and do not skip quality checks', 'write'],
    ['Finish the current chapter; review continuity', 'write'],
    ['Revise chapter 1; do not skip the quality check', 'revise'],
    ['Check and repair the current chapter', 'revise'],
  ])('keeps the explicit effect in %s', (prompt, intent) => {
    const spec = buildTaskSpec({ runId: 'synthetic-run', novelId: 'synthetic-novel', chapterId: 'synthetic-chapter', prompt })
    expect(spec.intent).toBe(intent)
    expect(spec.expectedOutputs[0].kind).toBe('text')
    expect(spec.scope.writing).toBeUndefined()
  })
  it.each([
    '只检查当前章节，不要写下一章',
    '不要写下一章，也不得跳过当前章节的检查',
    '完成当前章节的质量检查',
    '检查第一章，给出修改建议',
    '写当前章节的质量检查报告',
    'Review the current chapter; do not write the next chapter',
    'Do not write the next chapter. Do not skip the current chapter check',
    'Complete the current chapter review',
    "Complete the current chapter's quality review",
    'Write a review of the current chapter',
  ])('keeps a pure review or negated writing request read-only: %s', prompt => {
    expect(buildTaskSpec({ runId: 'synthetic-run', novelId: 'synthetic-novel', chapterId: 'synthetic-chapter', prompt }).intent).toBe('review')
  })
})
