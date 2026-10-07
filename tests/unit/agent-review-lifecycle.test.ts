import { beforeEach, describe, expect, it } from 'vitest'

import { useAgentStore } from '../../src/features/studio/agent/agentStore'

describe('Agent 写入审查生命周期', () => {
  beforeEach(() => {
    useAgentStore.getState().resetRun()
    useAgentStore.getState().resumeRun('run-review', 'session-review')
  })

  it('旧审批决定不能关闭同callId的新审批卡片', () => {
    const apply = useAgentStore.getState().applyEvent
    const base = { runId: 'run-review', ts: new Date().toISOString() }
    apply({ ...base, seq: 1, type: 'permission.ask', approvalId: 'new-approval', callId: 'call', toolName: 'chapter_write', title: '写入', args: {}, allowAlways: false, expiresAt: new Date(Date.now() + 60000).toISOString() })
    apply({ ...base, seq: 2, type: 'permission.resolved', approvalId: 'old-approval', callId: 'call', approved: true })
    expect(useAgentStore.getState().pendingApproval?.approvalId).toBe('new-approval')
    expect(useAgentStore.getState().phase).toBe('awaiting_approval')
    apply({ ...base, seq: 3, type: 'permission.resolved', approvalId: 'new-approval', callId: 'call', approved: true })
    expect(useAgentStore.getState().pendingApproval).toBeNull()
    apply({ ...base, seq: 4, type: 'run.paused', reason: 'user_stop' })
    apply({ ...base, seq: 5, type: 'permission.resolved', approvalId: 'new-approval', callId: 'call', approved: true })
    expect(useAgentStore.getState().phase).toBe('paused')
  })

  it('参数首帧创建准备卡，正文定稿不跳位，正式执行和完成复用同一卡片', () => {
    const apply = useAgentStore.getState().applyEvent
    const base = { runId: 'run-review', ts: new Date().toISOString() }
    const preview = { type: 'tool.delta' as const, messageId: 'm', callId: 'c', toolName: 'chapter_write', title: '写入章节正文', argsChars: 0 }
    apply({ ...base, seq: 1, type: 'message.start', messageId: 'm', role: 'assistant' })
    apply({ ...base, seq: 2, type: 'text.delta', messageId: 'm', delta: '开始写作。' })
    apply({ ...base, seq: 3, ...preview })
    expect(useAgentStore.getState().messages[0].parts[1]).toMatchObject({ preparing: true, status: 'running', args: null })
    expect(useAgentStore.getState().workspaceActivities).toEqual([])
    apply({ ...base, seq: 4, ...preview, argsChars: 50, draft: { kind: 'chapter', toolName: 'chapter_write', content: '正文预览' } })
    expect(useAgentStore.getState().liveToolDrafts.c?.content).toBe('正文预览')
    apply({ ...base, seq: 5, type: 'text.final', messageId: 'm', text: '开始写作。', asReasoning: false })
    expect(useAgentStore.getState().messages[0].parts.map(part => part.type)).toEqual(['text', 'tool-call'])
    apply({ ...base, seq: 6, type: 'tool.call', messageId: 'm', callId: 'c', toolName: 'chapter_write', title: '写入章节正文', args: { content: '正文' } })
    expect(useAgentStore.getState().messages[0].parts[1]).toMatchObject({ preparing: false, status: 'running' })
    expect(useAgentStore.getState().workspaceActivities).toHaveLength(1)
    apply({ ...base, seq: 7, type: 'tool.result', messageId: 'm', callId: 'c', toolName: 'chapter_write', ok: true, summary: '已写入', durationMs: 20 })
    apply({ ...base, seq: 8, ...preview, argsChars: 60, draft: { kind: 'chapter', toolName: 'chapter_write', content: '迟到正文' } })
    expect(useAgentStore.getState().liveToolDrafts).toEqual({})
    expect(useAgentStore.getState().messages[0].parts).toHaveLength(2)
    expect(useAgentStore.getState().messages[0].parts[1]).toMatchObject({ preparing: false, status: 'success' })
  })

  it.each(['step.finish', 'run.paused'] as const)('%s 清理未获执行的准备卡，不生成失败写入活动', (type) => {
    const apply = useAgentStore.getState().applyEvent
    const base = { runId: 'run-review', ts: new Date().toISOString() }
    const preview = { type: 'tool.delta' as const, messageId: 'm', callId: 'c', toolName: 'chapter_write', title: '写入章节正文', argsChars: 8 }
    apply({ ...base, seq: 1, type: 'message.start', messageId: 'm', role: 'assistant' })
    apply({ ...base, seq: 2, ...preview })
    apply(type === 'run.paused' ? { ...base, seq: 3, type, reason: 'user_stop' }
      : { ...base, seq: 3, type, turn: 1, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } })
    if (type === 'run.paused') apply({ ...base, seq: 4, ...preview })
    expect(useAgentStore.getState().messages[0].parts).toEqual([])
    expect(useAgentStore.getState().workspaceActivities).toEqual([])
    expect(useAgentStore.getState().liveToolDrafts).toEqual({})
    apply({ ...base, seq: 99, ...preview, runId: 'other-run' })
    expect(useAgentStore.getState().messages[0].parts).toEqual([])
  })

  it('补入检查按实际执行顺序排在提前生成的终态预览前，重连不重复或重排已执行卡', () => {
    const apply = useAgentStore.getState().applyEvent
    const base = { runId: 'run-review', ts: new Date().toISOString() }
    apply({ ...base, seq: 1, type: 'message.start', messageId: 'm', role: 'assistant' })
    apply({ ...base, seq: 2, type: 'tool.delta', messageId: 'm', callId: 'commit', toolName: 'chapter_bridge_commit', title: '提交章节终态', argsChars: 30 })
    apply({ ...base, seq: 3, type: 'tool.call', messageId: 'm', callId: 'check', toolName: 'continuity_validate', title: '检查章节连续性', args: {} })
    expect(useAgentStore.getState().messages[0].parts.map(part => part.type === 'tool-call' && part.callId)).toEqual(['check', 'commit'])
    apply({ ...base, seq: 4, type: 'tool.result', messageId: 'm', callId: 'check', toolName: 'continuity_validate', ok: true, summary: '检查完成', durationMs: 10 })
    apply({ ...base, seq: 5, type: 'tool.call', messageId: 'm', callId: 'commit', toolName: 'chapter_bridge_commit', title: '提交章节终态', args: {} })
    apply({ ...base, seq: 6, type: 'tool.call', messageId: 'm', callId: 'check', toolName: 'continuity_validate', title: '检查章节连续性', args: {} })
    expect(useAgentStore.getState().messages[0].parts.map(part => part.type === 'tool-call' && [part.callId, part.status, part.preparing])).toEqual([
      ['check', 'success', false], ['commit', 'running', false],
    ])
  })

  it('执行成功先保持已完成，作者采纳后才标记已接受', () => {
    const apply = useAgentStore.getState().applyEvent
    apply({ seq: 1, runId: 'run-review', ts: new Date().toISOString(), type: 'message.start', messageId: 'message-review', role: 'assistant' })
    apply({ seq: 2, runId: 'run-review', ts: new Date().toISOString(), type: 'tool.call', messageId: 'message-review', callId: 'call-review-lifecycle', toolName: 'chapter_write', title: '写入章节正文', args: {} })
    apply({
      seq: 3,
      runId: 'run-review',
      ts: new Date().toISOString(),
      type: 'tool.result',
      messageId: 'message-review',
      callId: 'call-review-lifecycle',
      toolName: 'chapter_write',
      ok: true,
      summary: '正文已写入',
      durationMs: 1200,
      display: { kind: 'chapterDiff', chapterId: 'chapter-review', chapterTitle: '测试章', before: '', after: '新正文', appliedDirectly: true },
    })

    const completed = useAgentStore.getState().messages[0]?.parts.find((part) => part.type === 'tool-call')
    expect(completed?.type === 'tool-call' && completed.status).toBe('success')
    expect(completed?.type === 'tool-call' && completed.accepted).toBeFalsy()

    useAgentStore.getState().markWorkspaceActivitiesAccepted({ chapterId: 'chapter-review' })

    const accepted = useAgentStore.getState().messages[0]?.parts.find((part) => part.type === 'tool-call')
    expect(accepted?.type === 'tool-call' && accepted.accepted).toBe(true)
    expect(useAgentStore.getState().workspaceActivities[0]?.accepted).toBe(true)
  })

  it('轮末清除未执行草稿并收尾旧版悬挂工具，已成功结果不受影响', () => {
    useAgentStore.setState({ phase: 'running' })
    const apply = useAgentStore.getState().applyEvent
    const base = { runId: 'run-review', ts: new Date().toISOString() }
    apply({ ...base, seq: 1, type: 'message.start', messageId: 'm', role: 'assistant' })
    apply({ ...base, seq: 2, type: 'tool.call', messageId: 'm', callId: 'old', toolName: 'continuity_validate', title: '检查章节连续性', args: null })
    apply({ ...base, seq: 3, type: 'tool.delta', messageId: 'm', callId: 'draft-only', argsChars: 12, draft: { kind: 'chapter', toolName: 'chapter_write', content: '尚未执行的草稿' } })
    apply({ ...base, seq: 4, type: 'step.finish', turn: 1, usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 } })
    expect(useAgentStore.getState().liveToolDrafts).toEqual({})
    expect(useAgentStore.getState().messages[0]?.parts).toEqual([expect.objectContaining({ callId: 'old', status: 'failed' })])
    expect(useAgentStore.getState().phase).toBe('running')
  })
})
