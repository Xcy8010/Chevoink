// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { projectAgentAuthorMessage, projectAgentAuthorParts, projectAgentAuthorText } from '../../shared/agent-author-view.js'
import type { AgentMessagePart, AgentUIMessage, AgentStreamEvent } from '../../shared/contracts/index.js'
import { AgentMessageParts } from '../../src/features/studio/agent/components/AgentMessageParts'
import { AgentPermissionCard } from '../../src/features/studio/agent/components/AgentPermissionCard'
import { useAgentStore, readSessionMessagesCache } from '../../src/features/studio/agent/agentStore'
import { getMessageText } from '../../src/features/studio/agent/lib/panel-helpers'
import { describeToolArguments } from '../../src/features/studio/agent/tool-argument-view'

afterEach(() => { cleanup(); useAgentStore.getState().resetRun() })
const raw = '调用 scene_task_build，compilationId=cmttleebg03h9wqox9lieracs。'
const manuscript = 'AnnBlue says hello_world, 12345678901234567890。她说：“调用 chapter_write。”'
const history: AgentUIMessage = { id: 'a', runId: 'r', role: 'assistant', createdAt: '2026-10-11T00:00:00Z', parts: [
  { type: 'reasoning', text: '先核对人物动机。\n\n调用 chapter_write，chapterId=cmttleebg03h9wqox9lieracs。' },
  { type: 'text', text: raw }, { type: 'text', text: manuscript },
] }
function apply(event: Record<string, unknown>, seq: number) {
  useAgentStore.getState().applyEvent({ runId: 'r', ts: '2026-10-11T00:00:00Z', seq, ...event } as AgentStreamEvent)
}

it('projects legacy history, pagination, A -> B -> A cache and copy without touching source protocol', () => {
  const original = structuredClone(history)
  useAgentStore.getState().restoreMessages([history], 'A')
  const expected = getMessageText(projectAgentAuthorMessage(history).parts)
  expect(useAgentStore.getState().messages[0].parts[0]).toEqual(history.parts[0])
  expect(getMessageText(useAgentStore.getState().messages[0].parts)).toBe(expected)
  useAgentStore.getState().prependMessages([{ ...history, id: 'older' }])
  expect(useAgentStore.getState().messages[0].parts[0]).toEqual(history.parts[0])
  useAgentStore.getState().resetRun()
  useAgentStore.getState().restoreMessages([], 'B')
  useAgentStore.getState().resetRun()
  useAgentStore.getState().restoreMessages(readSessionMessagesCache('A')!, 'A')
  expect(getMessageText(useAgentStore.getState().messages.at(-1)!.parts)).toBe(expected)
  expect(expected).toContain(manuscript)
  expect(expected).not.toMatch(/hidden English|scene_task_build|compilationId|cmttle/)
  expect(history).toEqual(original)
  expect(getMessageText([{ type: 'text', text: raw }], 'user')).toBe(raw)
})

it('holds every streamed split before first render, then uses the same final/history/copy projection', () => {
  for (let split = 1; split < raw.length; split++) {
    useAgentStore.getState().resetRun()
    useAgentStore.setState({ runId: 'r', phase: 'running', lastSeq: 0, messages: [{ ...history, parts: [] }] })
    apply({ type: 'reasoning.delta', messageId: 'a', delta: '先核对人物动机。' }, 1)
    apply({ type: 'text.delta', messageId: 'a', delta: raw.slice(0, split) }, 2)
    expect(useAgentStore.getState().messages[0].parts).toEqual([{ type: 'reasoning', text: '先核对人物动机。' }])
    apply({ type: 'text.delta', messageId: 'a', delta: raw.slice(split) }, 3)
    expect(useAgentStore.getState().messages[0].parts).toEqual([{ type: 'reasoning', text: '先核对人物动机。' }])
    apply({ type: 'text.final', messageId: 'a', text: `${raw}\n\n${manuscript}`, asReasoning: false }, 4)
    expect(getMessageText(useAgentStore.getState().messages[0].parts)).toBe(projectAgentAuthorText(`${raw}\n\n${manuscript}`).trim())
    // Replayed sequence is ignored; reconnect cannot append a raw old fragment.
    apply({ type: 'text.delta', messageId: 'a', delta: 'compilationId' }, 3)
    expect(getMessageText(useAgentStore.getState().messages[0].parts)).not.toContain('compilationId')
  }
})

it('folds actual thinking, sanitizes its expanded content and preserves visible real failure and intent', () => {
  const tool: AgentMessagePart = { type: 'tool-call', callId: 'failure', toolName: 'future_unknown_tool', title: 'future_unknown_tool',
    status: 'failed', summary: 'HTTP Error P2002 at hidden/stack.ts:3', args: {
      chapterId: 'cmttleebg03h9wqox9lieracs', secretField: 'hidden-param', nested: { key: 'hidden-json' }, reason: '避免人物前后矛盾', content: manuscript,
    } }
  const view = render(<AgentMessageParts parts={[...history.parts, tool]} streaming={false} runActive summaryExpanded />)
  expect(view.container.textContent).not.toContain('hidden English')
  expect(screen.queryByText('先核对人物动机。')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '展开思考' }))
  expect(screen.getByText('先核对人物动机。')).toBeTruthy()
  expect(screen.getByText('推进创作')).toBeTruthy()
  expect(screen.getByText('本次操作未完成。请核对当前成果后重试，或调整要求。')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '展开工具详情' }))
  expect(screen.getByText('避免人物前后矛盾')).toBeTruthy()
  expect(screen.getByText(`${manuscript.length} 字`)).toBeTruthy()
  expect(view.container.textContent).not.toMatch(/future_unknown_tool|hidden-param|hidden-json|cmttle|secretField|chapterId|P2002/)
  expect(describeToolArguments({ chapterId: 'private-id', unknown: { content: 'hidden' } })).toEqual([])
})

it('updates the actual tool in place without showing preparation as saved or assessment as applied', () => {
  useAgentStore.setState({ runId: 'r', phase: 'running', lastSeq: 0, messages: [{ ...history, parts: [] }] })
  apply({ type: 'tool.delta', messageId: 'a', callId: 'save', toolName: 'chapter_bridge_commit', title: 'raw_tool', argsChars: 10 }, 1)
  const view = render(<AgentMessageParts parts={useAgentStore.getState().messages[0].parts} streaming runActive />)
  expect(screen.queryByText('准备中…')).toBeNull()
  expect(view.container.textContent).toBe('')
  expect(view.container.textContent).not.toContain('已保存')
  apply({ type: 'tool.call', messageId: 'a', callId: 'save', toolName: 'chapter_bridge_commit', title: 'raw_tool', args: {}, preparing: false }, 2)
  view.rerender(<AgentMessageParts parts={useAgentStore.getState().messages[0].parts} streaming runActive />)
  expect(screen.queryByText('准备中…')).toBeNull()
  expect(screen.getByText('执行中…')).toBeTruthy()
  expect(useAgentStore.getState().messages[0].parts.filter(part => part.type === 'tool-call')).toHaveLength(1)
})

it('uses Chinese fallback for result-only reconnect and permission rows without changing approval identity', () => {
  useAgentStore.setState({ runId: 'r', lastSeq: 0, messages: [{ ...history, parts: [] }] })
  apply({ type: 'tool.result', messageId: 'a', callId: 'unknown', toolName: 'future_unknown_tool', status: 'failed', summary: '操作中断，请重试' }, 1)
  expect(useAgentStore.getState().messages[0].parts[0]).toMatchObject({ title: '推进创作', status: 'failed', summary: '操作中断，请重试' })
  render(<AgentPermissionCard approval={{ callId: 'private-call', toolName: 'future_unknown_tool', title: 'raw_tool', args: {}, allowAlways: false, expiresAt: 'future' }} onResolve={() => {}} />)
  expect(screen.getByText('推进创作')).toBeTruthy()
  expect(screen.queryByText('raw_tool')).toBeNull()
})

it('preserves real failure status and error code while projecting live activity and error consumers', () => {
  useAgentStore.setState({ runId: 'r', phase: 'running', lastSeq: 0, workspaceActivities: [], messages: [{ ...history, parts: [] }] })
  apply({ type: 'tool.call', messageId: 'a', callId: 'write', toolName: 'chapter_write', title: 'chapter_write', args: {} }, 1)
  apply({ type: 'tool.result', messageId: 'a', callId: 'write', toolName: 'chapter_write', ok: false, summary: 'HTTP Error P2002' }, 2)
  const state = useAgentStore.getState()
  expect(state.workspaceActivities[0]).toMatchObject({ status: 'failed', summary: '本次操作未完成。请核对当前成果后重试，或调整要求。' })
  expect(state.messages[0].parts[0]).toMatchObject({ status: 'failed', title: '撰写本章' })
  apply({ type: 'error', code: 'PROVIDER_FAILURE', message: 'HTTP Error P2002', recoverable: false }, 3)
  expect(useAgentStore.getState()).toMatchObject({ phase: 'failed', errorCode: 'PROVIDER_FAILURE', errorMessage: '本次操作未完成。请核对当前成果后重试，或调整要求。' })
})

it('keeps unfinished work actionable in default collapsed history while preserving successful-operation folding', () => {
  const parts: AgentMessagePart[] = [
    { type: 'tool-call', callId: 'read', toolName: 'chapter_read', title: '', status: 'success', summary: '已核对前文' },
    { type: 'tool-call', callId: 'check', toolName: 'continuity_validate', title: '', status: 'failed', summary: '正文已保存，这次复查还未完成。请核对问题后继续。' },
    { type: 'reasoning', text: 'hidden English reasoning' },
  ]
  render(<AgentMessageParts parts={parts} streaming={false} runActive={false} blockId="b" summaryCount={2} />)
  expect(screen.getByText('查看 2 项操作')).toBeTruthy()
  expect(screen.getByText('正文已保存，这次复查还未完成。请核对问题后继续。')).toBeTruthy()
  expect(screen.queryByText('已核对前文')).toBeNull()
  expect(screen.queryByText('hidden English reasoning')).toBeNull()
})

it('retains every real thinking split through final, reconnect and cache without exposing partial protocol or copying thinking', () => {
  const thinking = `先核对人物动机。\n\n${raw}\n\n再检查情节承接。`
  for (let split = 1; split < thinking.length; split++) {
    useAgentStore.getState().resetRun()
    useAgentStore.getState().resumeRun('r', 'A')
    apply({ type: 'message.start', messageId: 'a' }, 1)
    apply({ type: 'reasoning.delta', messageId: 'a', delta: thinking.slice(0, split) }, 2)
    expect(JSON.stringify(projectAgentAuthorParts(useAgentStore.getState().messages[0].parts, true))).not.toMatch(/scene_task_build|compilationId|cmttle/)
    apply({ type: 'reasoning.delta', messageId: 'a', delta: thinking.slice(split) }, 3)
    apply({ type: 'reasoning.delta', messageId: 'a', delta: '重复' }, 3)
    apply({ type: 'reasoning.delta', messageId: 'a', delta: '外部', runId: 'foreign' }, 99)
    apply({ type: 'text.final', messageId: 'a', text: '最终回复', asReasoning: false }, 4)
    expect(useAgentStore.getState().messages[0].parts[0]).toEqual({ type: 'reasoning', text: thinking })
    expect(getMessageText(useAgentStore.getState().messages[0].parts)).toBe('最终回复')
    const view = render(<AgentMessageParts parts={useAgentStore.getState().messages[0].parts} streaming={false} runActive={false} />)
    expect(screen.queryByText('再检查情节承接。')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '展开思考' }))
    expect(view.container.textContent).toContain('再检查情节承接。')
    expect(view.container.textContent).not.toMatch(/scene_task_build|compilationId|cmttle/)
    cleanup()
    useAgentStore.getState().resetRun()
    useAgentStore.getState().restoreMessages(readSessionMessagesCache('A')!, 'A')
    expect(useAgentStore.getState().messages[0].parts[0]).toEqual({ type: 'reasoning', text: thinking })
  }
})

it('does not reinterpret narrated text or asReasoning final as actual thinking', () => {
  useAgentStore.getState().resumeRun('r', 'A')
  apply({ type: 'message.start', messageId: 'a' }, 1)
  apply({ type: 'text.final', messageId: 'a', text: '我在思考下一章。', asReasoning: true }, 2)
  expect(useAgentStore.getState().messages[0].parts).toEqual([])
  apply({ type: 'reasoning.delta', messageId: 'a', delta: '实际思考。' }, 3)
  apply({ type: 'text.final', messageId: 'a', text: '供应商汇总', asReasoning: true }, 4)
  expect(useAgentStore.getState().messages[0].parts).toEqual([{ type: 'reasoning', text: '实际思考。' }])
  expect(getMessageText(useAgentStore.getState().messages[0].parts)).toBe('')
})

it('shows a truthful live thinking indicator until a complete safe paragraph arrives, preserving the open fold', () => {
  const view = render(<AgentMessageParts parts={[{ type: 'reasoning', text: '先核对人' }]} streaming runActive />)
  fireEvent.click(screen.getByRole('button', { name: '展开思考' }))
  expect(screen.getByText('思考正在生成，完整段落到达后显示。')).toBeTruthy()
  view.rerender(<AgentMessageParts parts={[{ type: 'reasoning', text: '先核对人物动机。\n\n调用 chapter_' }]} streaming runActive />)
  expect(screen.getByRole('button', { name: '收起思考' }).getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByText('先核对人物动机。')).toBeTruthy()
  expect(view.container.textContent).not.toContain('chapter_')
  view.rerender(<AgentMessageParts parts={[{ type: 'reasoning', text: '先核对人物动机。\n\n调用 chapter_write，chapterId=private-id。' }]} streaming={false} runActive={false} />)
  expect(screen.getByRole('button', { name: '收起思考' })).toBeTruthy()
  expect(view.container.textContent).not.toMatch(/chapter_write|chapterId|private-id/)
})
