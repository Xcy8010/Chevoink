import { describe, expect, it } from 'vitest'
import { toolFailureRecovery, toolRecoveryKey } from '../../api/lib/agent/tool-failure-recovery.js'
import { findToolRestriction, isInputScopedFailure, restoreToolRestriction, toolFailureInputHash } from '../../api/lib/agent/tool-local-failure.js'
import { frozenWritingToolGuidance } from '../../api/lib/agent/writing-tool-guidance.js'
import type { TaskSpec } from '../../shared/contracts/index.js'

const nextScope: TaskSpec['scope'] = { novelId: 'novel', writing: { version: 1, kind: 'bounded',
  targets: [{ chapterId: null, orderIndex: 49 }], repairAuthorized: false, titleAndBodyOnly: false,
  tailVolume: { version: 1, previousChapterId: 'previous48', previousRevision: 6, targetOrderIndex: 49 } } }

describe('frozen new-chapter input recovery', () => {
  it('explains the authorized new target, reference chapter and saved volume decision', () => {
    const prepare = frozenWritingToolGuidance('story_compiler_prepare', nextScope)
    expect(prepare).toContain('已授权新建全书第49章')
    expect(prepare).toContain('省略 chapterId')
    expect(prepare).toContain('volumeDecision 必填')
    expect(prepare).toContain('先纠正准备参数')
    expect(prepare).toContain('复用其真实 compilationId/chapterId')
    expect(prepare).toContain('仅本任务尚未准备时')
    expect(prepare).not.toContain('尚未绑定章节')
    const create = frozenWritingToolGuidance('chapter_create', nextScope)
    expect(create).toContain('{"title":"章节名称"}')
    expect(create).toContain('先完成本任务 PREPARE')
    expect(create).toContain('不能填写已有卷')
    expect(create).toContain('不因章号或书名号拒绝创建')
  })
  it('does not infer a new slot from a missing, multiple, existing or volume-relative grant', () => {
    const writing = nextScope.writing!
    for (const scope of [undefined, { novelId: 'novel' }, { ...nextScope, writing: { ...writing, targets: [{ chapterId: 'existing49', orderIndex: 49 }] } },
      { ...nextScope, writing: { ...writing, targets: [...writing.targets, { chapterId: null, orderIndex: 50 }] } },
      { ...nextScope, writing: { ...writing, targets: [{ chapterId: null, orderIndex: 49, volumeId: 'volume2', positionInVolume: 33 }] } }]) {
      expect(frozenWritingToolGuidance('story_compiler_prepare', scope)).toBe('')
    }
    expect(frozenWritingToolGuidance('chapter_write', nextScope)).toBe('')
  })
  it.each(['TOOL_SCHEMA_INVALID', 'TOOL_ARGUMENTS_INVALID', 'TOOL_ARGUMENTS_INCOMPLETE', 'TOOL_NORMALIZATION_FAILED'])(
    'isolates only the failed input for %s and preserves an old audit without granting progress', code => {
      expect(isInputScopedFailure(code)).toBe(true)
      const bad = { title: '风眼', volumeOrder: '2', positionInVolume: '33', newVolume: { title: '第二卷 雪压边墙' } }
      const current = { action: 'chapter_create', target: 'previous48', code, reason: '连续三次参数无效', inputHash: toolFailureInputHash('chapter_create', bad) }
      expect(findToolRestriction([current], 'chapter_create', bad, 'previous48')).toBe(current)
      expect(findToolRestriction([current], 'chapter_create', { title: '风眼' }, 'previous48')).toBeUndefined()
      const restored = restoreToolRestriction({ ...current, inputHash: undefined })
      expect(restored).toMatchObject({ action: current.action, target: current.target, code, reason: current.reason, inputHash: expect.any(String) })
      expect(restoreToolRestriction(restored)).toEqual(restored)
      expect(findToolRestriction([restored], 'chapter_create', { title: '风眼' }, 'previous48')).toBeUndefined()
    })
  it.each(['AUTHOR_CHAPTER_SCOPE', 'RUNTIME_SCOPE_MISMATCH', 'AI_PROVIDER_TIMEOUT', 'REVIEW_PROVIDER_OUTCOME_UNCONFIRMED'])(
    'preserves broad safety restriction %s', code => {
      const restriction = { action: 'chapter_create', target: 'previous48', code, reason: '原拒绝' }
      expect(isInputScopedFailure(code)).toBe(false)
      expect(restoreToolRestriction(restriction)).toBe(restriction)
      expect(findToolRestriction([restriction], 'chapter_create', { title: '风眼' }, 'previous48')).toBe(restriction)
    })
})

describe('chapter authority failure feedback', () => {
  it('routes a completed-check decision to commit with exact references instead of another critic', () => {
    const recovery = toolFailureRecovery('REVIEW_DECISION_REQUIRED')!
    expect(recovery.guidance).toContain('chapter_bridge_commit')
    expect(recovery.guidance).toContain('retainedFindings')
    expect(recovery.guidance).toContain('无需再次检查')
    expect(recovery.guidance).not.toContain('先完成当前正文的 quality_analyze')
  })
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
