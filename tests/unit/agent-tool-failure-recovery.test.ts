import { describe, expect, it } from 'vitest'
import { toolFailureRecovery, toolRecoveryKey } from '../../api/lib/agent/tool-failure-recovery.js'

describe('chapter authority failure feedback', () => {
  it('does not misdiagnose rejected edits as no-ops or force a full-write workaround', () => {
    const recovery = toolFailureRecovery('REVIEW_MERGED_REVISION_REQUIRED')!
    expect(recovery.guidance).toContain('本次修改被拒绝，未写入')
    expect(recovery.guidance).toContain('真实编号')
    expect(recovery.guidance).toContain('分步调用')
    expect(recovery.guidance).not.toContain('正文未变化')
    expect(recovery.guidance).not.toContain('不能逐条')
  })

  it('counts the same failed target across changed content and writer tools without mixing other targets', () => {
    const code = 'REVIEW_MERGED_REVISION_REQUIRED'
    const first = toolRecoveryKey('chapter_edit_range', code, { chapterId: 'c', oldText: 'old', newText: 'new' })
    expect(toolRecoveryKey('chapter_write', code, { chapterId: 'c', content: 'whole new body' })).toBe(first)
    expect(toolRecoveryKey('chapter_append', code, { content: 'append' }, 'c')).toBe(first)
    expect(toolRecoveryKey('chapter_write', code, { chapterId: ' c ', content: 'new' })).toBe(first)
    expect(toolRecoveryKey('chapter_append', code, { content: 'append' }, ' c ')).toBe(first)
    expect(toolRecoveryKey('chapter_write', code, { chapterId: 'other', content: 'new' })).not.toBe(first)
    expect(toolRecoveryKey('chapter_write', 'CHAPTER_ANCHOR_CONFLICT', { chapterId: 'c' })).not.toBe(first)
  })
  it('requires checking the original request and catalog within the existing scope', () => {
    const recovery = toolFailureRecovery('AUTHOR_CHAPTER_SCOPE')!
    expect(recovery.label).toContain('目标或位置')
    expect(recovery.guidance).toContain('不表示任务已结束')
    expect(recovery.guidance).toContain('原始请求和当前作品目录')
    expect(recovery.guidance).toContain('仅在现有授权范围内')
    expect(recovery.guidance).toContain('不得混用')
    expect(recovery.guidance).toContain('任务已暂停、结束或授权不匹配时不得继续')
  })

  it.each(['RUNTIME_SCOPE_MISMATCH', 'RUNTIME_NOT_ACTIVE', 'RUN_CANCELLED', 'RUN_PAUSED', 'UNKNOWN_FAILURE'])(
    'does not label %s as a correctable chapter placement', code => {
      expect(toolFailureRecovery(code)).toBeUndefined()
    })
})
