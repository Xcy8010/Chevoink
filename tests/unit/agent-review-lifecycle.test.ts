import { beforeEach, describe, expect, it } from 'vitest'

import { readSessionMessagesCache, useAgentStore } from '../../src/features/studio/agent/agentStore'
import { projectAgentAuthorParts } from '../../shared/agent-author-view.js'

describe('Agent 写入审查生命周期', () => {
  beforeEach(() => {
    useAgentStore.getState().resetRun()
    useAgentStore.getState().resumeRun('run-review', 'session-review')
  })
  it.each(['tool.delta','tool.call'] as const)('重连缺message.start时由%s首帧补同run单卡，预览不成为写入',type=>{
    const store=()=>useAgentStore.getState(),apply=store().applyEvent
    const base={runId:'run-review',messageId:'reconnected',callId:'write',ts:new Date().toISOString()}
    apply(type==='tool.delta'?{...base,seq:1,type,toolName:'chapter_write',argsChars:0}
      :{...base,seq:1,type,toolName:'chapter_write',title:'写入正文',args:{}})
    expect(store().messages).toHaveLength(1)
    expect(store().messages[0]).toMatchObject({id:base.messageId,runId:base.runId,role:'assistant',parts:[{callId:'write',preparing:type==='tool.delta',status:'running'}]})
    expect(store().workspaceActivities).toHaveLength(type==='tool.delta'?0:1)
    apply({...base,seq:2,type:'tool.call',toolName:'chapter_write',title:'写入正文',args:{}})
    apply({...base,seq:3,type:'tool.result',toolName:'chapter_write',ok:true,summary:'已保存'})
    apply({...base,seq:4,type:'tool.delta',toolName:'chapter_write',argsChars:50})
    expect(store().messages[0].parts).toHaveLength(1)
    expect(store().messages[0].parts[0]).toMatchObject({callId:'write',preparing:false,status:'success'})
    expect(store().workspaceActivities).toHaveLength(1)
    expect(store().liveToolDrafts).toEqual({})
  })
  it('同messageId但不同run归属不可补建或覆盖工具卡',()=>{
    const store=()=>useAgentStore.getState(),message={id:'collision',runId:'old',role:'assistant' as const,parts:[],createdAt:new Date().toISOString()}
    useAgentStore.setState({messages:[message]})
    const base={runId:'run-review',messageId:message.id,callId:'write',ts:message.createdAt,toolName:'chapter_write'}
    store().applyEvent({...base,seq:1,type:'tool.delta',argsChars:0})
    store().applyEvent({...base,seq:2,type:'tool.call',title:'写入正文',args:{}})
    store().applyEvent({...base,seq:3,type:'tool.result',ok:true,summary:'已保存'})
    expect(store().messages).toEqual([message])
    expect(store().workspaceActivities).toEqual([])
    expect(store().lastSeq).toBe(0)
  })

  it('继续后重复读取并暂停仍保留已保存变更和历史，不把定位预览当已写正文', () => {
    const store = () => useAgentStore.getState()
    const base = { runId: 'run-review', ts: new Date().toISOString() }
    store().restoreMessages([{ id: 'saved', runId: 'run-review', role: 'assistant', createdAt: base.ts, parts: [{
      type: 'tool-call', callId: 'saved-edit', toolName: 'chapter_edit_range', title: '修改本章', args: {}, status: 'success', summary: '已保存',
      display: { kind: 'chapterDiff', chapterId: 'chapter', chapterTitle: '八千八', before: '旧稿', after: '已保存第4版', revision: 4, appliedDirectly: true } }] }], 'session-review')
    const saved = structuredClone(store().workspaceActivities)
    store().resumeRun('run-review', 'session-review')
    store().applyEvent({ ...base, seq: 101, type: 'message.start', messageId: 'continued', role: 'assistant' })
    store().applyEvent({ ...base, seq: 102, type: 'tool.call', messageId: 'continued', callId: 'read', toolName: 'chapter_read', title: '读取本章', args: { chapterId: 'chapter' } })
    store().applyEvent({ ...base, seq: 103, type: 'tool.result', messageId: 'continued', callId: 'read', toolName: 'chapter_read', ok: true, summary: '已读' })
    store().applyEvent({ ...base, seq: 104, type: 'tool.delta', messageId: 'continued', callId: 'preview', toolName: 'chapter_edit_range', title: '准备修改', argsChars: 20,
      draft: { kind: 'chapter', toolName: 'chapter_edit_range', content: '尚未保存的定位预览' } })
    store().applyEvent({ ...base, seq: 105, type: 'run.paused', reason: 'needs_input' })
    expect(store().workspaceActivities.filter(item => item.callId === 'saved-edit')).toEqual(saved)
    expect(store().messages[0].parts[0]).toMatchObject({ status: 'success', display: { after: '已保存第4版', revision: 4 } })
    expect(store().liveToolDrafts).toEqual({})
    store().resumeRun('run-review', 'session-review')
    store().applyEvent({ ...base, seq: 103, type: 'tool.result', messageId: 'continued', callId: 'read', toolName: 'chapter_read', ok: true, summary: '已读' })
    expect(store().workspaceActivities.filter(item => item.callId === 'saved-edit')).toEqual(saved)
    expect(store().messages.filter(item => item.id === 'saved')).toHaveLength(1)
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

  it('参数首帧只保留内部预览，正文定稿不跳位，正式执行才创建作者卡片', () => {
    const apply = useAgentStore.getState().applyEvent
    const base = { runId: 'run-review', ts: new Date().toISOString() }
    const preview = { type: 'tool.delta' as const, messageId: 'm', callId: 'c', toolName: 'chapter_write', title: '写入章节正文', argsChars: 0 }
    apply({ ...base, seq: 1, type: 'message.start', messageId: 'm', role: 'assistant' })
    apply({ ...base, seq: 2, type: 'text.delta', messageId: 'm', delta: '开始写作。\n\n' })
    apply({ ...base, seq: 3, ...preview })
    expect(useAgentStore.getState().messages[0].parts[1]).toMatchObject({ preparing: true, status: 'running', args: null })
    expect(projectAgentAuthorParts(useAgentStore.getState().messages[0].parts)).toEqual([{ type: 'text', text: '开始写作。\n\n' }])
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

  it('draft-only预览经过分页和A→B→A缓存也不成为已写活动，实际call/result保持真实状态', () => {
    const store = () => useAgentStore.getState()
    const base = { runId: 'run-review', messageId: 'draft-message', ts: new Date().toISOString() }
    store().applyEvent({ ...base, seq: 1, type: 'message.start', role: 'assistant' })
    store().applyEvent({ ...base, seq: 2, type: 'tool.delta', callId: 'write', argsChars: 32,
      draft: { kind: 'chapter', toolName: 'chapter_write', content: '未保存正文' } })
    const previewMessage = structuredClone(store().messages[0])
    store().prependMessages([{ ...previewMessage, id: 'older-preview' }])
    expect(store().workspaceActivities).toEqual([])
    store().resetRun()
    store().restoreMessages([], 'other-session')
    store().resetRun()
    store().restoreMessages(readSessionMessagesCache('session-review')!, 'session-review')
    expect(store().workspaceActivities).toEqual([])
    expect(store().messages.find(message => message.id === 'draft-message')?.parts[0]).toMatchObject({ preparing: true })
    store().resumeRun('run-review', 'session-review')
    store().applyEvent({ ...base, seq: 3, type: 'tool.call', callId: 'write', toolName: 'chapter_write', title: '撰写本章', args: {} })
    expect(store().workspaceActivities).toEqual([expect.objectContaining({ callId: 'write', status: 'running' })])
    store().restoreMessages(store().messages, 'session-review')
    expect(store().workspaceActivities).toEqual([expect.objectContaining({ callId: 'write', status: 'running' })])
    store().resumeRun('run-review', 'session-review')
    store().applyEvent({ ...base, seq: 4, type: 'tool.result', callId: 'write', toolName: 'chapter_write', ok: true, summary: '已保存' })
    store().restoreMessages(store().messages, 'session-review')
    expect(store().workspaceActivities).toEqual([expect.objectContaining({ callId: 'write', status: 'done' })])
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

  it.each(['cancelled', 'error'] as const)('%s 撤下未执行草稿，迟到事件不制造失败写入', type => {
    const apply = useAgentStore.getState().applyEvent
    const base = { runId: 'run-review', messageId: 'm', ts: new Date().toISOString() }
    apply({ ...base, seq: 1, type: 'message.start', role: 'assistant' })
    const preview = { type: 'tool.delta' as const, callId: 'draft', argsChars: 32,
      draft: { kind: 'chapter' as const, toolName: 'chapter_write', content: '未保存正文' } }
    apply({ ...base, seq: 2, ...preview })
    expect(useAgentStore.getState().liveToolDrafts.draft.content).toBe('未保存正文')
    apply(type === 'error' ? { ...base, seq: 3, type: 'error', recoverable: false, code: 'PROVIDER_FAILED', message: '模型响应失败' }
      : { ...base, seq: 3, type: 'run.finished', status: 'cancelled', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } })
    apply({ ...base, seq: 4, ...preview })
    expect(useAgentStore.getState().liveToolDrafts).toEqual({})
    expect(useAgentStore.getState().messages[0].parts).toEqual([])
    expect(useAgentStore.getState().workspaceActivities).toEqual([])
  })

  it('参数生成结束立即撤下缓存与被替换预告，保留实际执行和其他消息', () => {
    const apply = useAgentStore.getState().applyEvent
    const base = { runId: 'run-review', ts: new Date().toISOString() }
    apply({ ...base, seq: 1, type: 'message.start', messageId: 'm', role: 'assistant' })
    apply({ ...base, seq: 2, type: 'message.start', messageId: 'other', role: 'assistant' })
    const preview = { type: 'tool.delta' as const, toolName: 'chapter_read', title: '读取章节', argsChars: 10 }
    apply({ ...base, seq: 3, ...preview, messageId: 'other', callId: 'other-call' })
    apply({ ...base, seq: 4, ...preview, messageId: 'm', callId: 'cached', draft: { kind: 'chapter', toolName: 'chapter_read', content: '缓存预告' } })
    apply({ ...base, seq: 5, ...preview, messageId: 'm', callId: 'replaced' })
    apply({ ...base, seq: 6, type: 'tool.call', messageId: 'm', callId: 'actual', toolName: 'chapter_read', title: '读取章节', args: {} })
    apply({ ...base, seq: 7, type: 'tool.preparation.end', messageId: 'm', callIds: ['cached', 'replaced', 'actual'] })
    expect(useAgentStore.getState().messages[0].parts).toEqual([expect.objectContaining({ callId: 'actual', preparing: false, status: 'running' })])
    expect(useAgentStore.getState().messages[1].parts).toEqual([expect.objectContaining({ callId: 'other-call', preparing: true })])
    expect(useAgentStore.getState().liveToolDrafts).toEqual({})
    apply({ ...base, seq: 4, ...preview, messageId: 'm', callId: 'cached' })
    expect(useAgentStore.getState().messages[0].parts).toHaveLength(1)
    expect(useAgentStore.getState().lastSeq).toBe(7)
  })

  it.each([true, false])('缺正式call时结果按messageId和callId补入终态，保持同名调用独立 (ok=%s)', ok => {
    const apply = useAgentStore.getState().applyEvent
    const base = { runId: 'run-review', ts: new Date().toISOString() }
    apply({ ...base, seq: 1, type: 'message.start', messageId: 'm', role: 'assistant' })
    apply({ ...base, seq: 2, type: 'tool.delta', messageId: 'm', callId: 'other', toolName: 'chapter_read', title: '读取章节', argsChars: 9 })
    const result = { type: 'tool.result' as const, messageId: 'm', callId: 'finished', toolName: 'chapter_read', ok, summary: '已收到结果', durationMs: 12 }
    apply({ ...base, seq: 3, ...result })
    apply({ ...base, seq: 3, ...result })
    expect(useAgentStore.getState().messages[0].parts).toEqual([
      expect.objectContaining({ callId: 'other', preparing: true, status: 'running' }),
      expect.objectContaining({ callId: 'finished', preparing: false, status: ok ? 'success' : 'failed', args: null, summary: result.summary, durationMs: 12 }),
    ])
    // Even a missing message.start must not swallow an authenticated terminal event.
    apply({ ...base, seq: 4, ...result, messageId: 'missing-message', callId: 'restored', subagentCallId: 'parent' })
    expect(useAgentStore.getState().messages[1]).toMatchObject({ id: 'missing-message', runId: 'run-review', parts: [
      expect.objectContaining({ callId: 'restored', subagentCallId: 'parent', status: ok ? 'success' : 'failed' }),
    ] })
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
