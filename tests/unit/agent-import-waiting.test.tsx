// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useAgentStore } from '../../src/features/studio/agent/agentStore'
import { AgentMessageParts } from '../../src/features/studio/agent/components/AgentMessageParts'
import type { AgentMessagePart } from '../../shared/contracts/agent-events.js'

afterEach(cleanup)
const importWaiting = { url: '/studio/novel/book?importRunId=run&importCallId=call&importAttachmentUrl=source', expiresAt: '2030-01-01T00:00:00.000Z' }
const part: AgentMessagePart = { type: 'tool-call', callId: 'call', toolName: 'novel_import', title: '等待作者确认导入',
  args: { action: 'prepare', attachmentUrl: 'source' }, status: 'running', importWaiting }

describe('Agent import waiting presentation is not approval', () => {
  it('renders a real waiting link with no success or generic approval action', () => {
    render(<AgentMessageParts parts={[part]} streaming={false} runActive />)
    expect(screen.getByRole('link', { name: '核对原文并确认导入' }).getAttribute('href')).toBe(importWaiting.url)
    expect(screen.getByText('等待作者确认')).toBeTruthy()
    expect(screen.getByText(/尚未导入；已有章节需要两次覆盖确认/)).toBeTruthy()
    expect(screen.queryByText('已完成')).toBeNull()
    expect(screen.queryByRole('button', { name: /允许|批准/ })).toBeNull()
  })
  it('does not render arbitrary external waiting links or resurrect terminal waiting UI', () => {
    const { rerender } = render(<AgentMessageParts parts={[{ ...part, importWaiting: { ...importWaiting, url: 'https://example.com/confirm' } }]} streaming={false} runActive />)
    expect(screen.queryByRole('link', { name: '核对原文并确认导入' })).toBeNull()
    rerender(<AgentMessageParts parts={[{ ...part, status: 'success' }]} streaming={false} runActive />)
    expect(screen.queryByText('等待作者确认')).toBeNull()
  })
  it('replays the same waiting event into one card, stores attention and clears it only on the real result', () => {
    useAgentStore.setState({ runId: 'r', lastSeq: 0, activeSessionId: 's', phase: 'running', pendingApproval: null,
      workspaceActivities: [], sessionSignals: {}, messages: [{ id: 'a', runId: 'r', role: 'assistant', parts: [], createdAt: '2026-09-14T00:00:00Z' }] })
    const body = { type: 'tool.call' as const, runId: 'r', ts: '2026-09-14T00:00:00Z', messageId: 'a', callId: 'call',
      toolName: 'novel_import', title: '等待作者确认导入', args: part.args, autoApproved: false, importWaiting }
    useAgentStore.getState().applyEvent({ ...body, seq: 1 })
    useAgentStore.getState().applyEvent({ ...body, seq: 2 })
    expect(useAgentStore.getState()).toMatchObject({ phase: 'awaiting_input', pendingApproval: null })
    expect(useAgentStore.getState().messages[0].parts).toEqual([expect.objectContaining({ status: 'running', importWaiting })])
    useAgentStore.getState().applyEvent({ type: 'tool.result', runId: 'r', seq: 3, ts: body.ts, messageId: 'a', callId: 'call', toolName: 'novel_import', ok: true, summary: '真实回执已提交', durationMs: 100 })
    expect(useAgentStore.getState().phase).toBe('running')
    expect(useAgentStore.getState().messages[0].parts[0]).toMatchObject({ status: 'success' })
  })
})
