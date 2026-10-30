// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentMessagePart, AgentStreamEvent } from '../../shared/contracts/index.js'
import { projectAgentAuthorParts } from '../../shared/agent-author-view.js'
import { useAgentStore } from '../../src/features/studio/agent/agentStore'
import { fromMarkdown } from 'mdast-util-from-markdown'

vi.mock('mdast-util-from-markdown', async importOriginal => {
  const actual = await importOriginal<typeof import('mdast-util-from-markdown')>()
  return { ...actual, fromMarkdown: vi.fn(actual.fromMarkdown) }
})
afterEach(() => { useAgentStore.getState().resetRun(); vi.clearAllMocks() })

it('projects an unchanged 75-part history once while 40 further deltas arrive', () => {
  const parts: AgentMessagePart[] = Array.from({ length: 75 }, (_, index) => ({
    type: 'text', text: `第${index}次核对：人物说了\`synthetic_example\`，然后走进花园。\n\n`,
  }))
  useAgentStore.getState().restoreMessages([{ id: 'm', runId: 'synthetic', role: 'assistant', createdAt: '', parts }], 'synthetic-session')
  useAgentStore.setState({ runId: 'synthetic', phase: 'running', lastSeq: 0 })
  const preserved = useAgentStore.getState().messages[0].parts
  const initialParses = vi.mocked(fromMarkdown).mock.calls.length
  const start = performance.now()
  for (let index = 1; index <= 40; index++) {
    useAgentStore.getState().applyEvent({ type: 'reasoning.delta', runId: 'synthetic', messageId: 'm', seq: index, ts: '', delta: '继续核对。' } as AgentStreamEvent)
    projectAgentAuthorParts(useAgentStore.getState().messages[0].parts, true, { includePreparing: true })
  }
  const state = useAgentStore.getState()
  console.info('[synthetic-projection]', JSON.stringify({ historyParts: 75, deltas: 40, markdownParses: vi.mocked(fromMarkdown).mock.calls.length, elapsedMs: Math.round(performance.now() - start) }))
  expect(state.messages[0].parts.slice(0, 75)).toEqual(preserved)
  expect(state.messages[0].parts.slice(0, 75).every((part, index) => part === preserved[index])).toBe(true)
  expect(state.messages[0].parts.at(-1)).toEqual({ type: 'reasoning', text: '继续核对。'.repeat(40) })
  expect(initialParses).toBeGreaterThan(0)
  expect(fromMarkdown).toHaveBeenCalledTimes(initialParses)
})

it('keeps streaming and finished reasoning projections separate for the same immutable part', () => {
  const ordinary: AgentMessagePart = Object.freeze({ type: 'reasoning', text: '还在核对人物动机。' })
  expect(projectAgentAuthorParts([ordinary], true)[0]).toBe(ordinary)
  const tail: AgentMessagePart = Object.freeze({ type: 'reasoning', text: '已核对人物动机。\n\n新到达的普通尾句' })
  expect(projectAgentAuthorParts([tail], true)[0]).toBe(tail)
  const part: AgentMessagePart = Object.freeze({ type: 'reasoning', text: '还在核对人物动机。\n\n“尚未闭合的引用' })
  const streaming = [{ type: 'reasoning', text: '还在核对人物动机。\n\n' }]
  expect(projectAgentAuthorParts([part], true)).toEqual(streaming)
  expect(projectAgentAuthorParts([part], false)).toEqual([part])
  expect(projectAgentAuthorParts([part], true)).toEqual(streaming)
  expect(projectAgentAuthorParts([part], false)[0]).toBe(part)
})

it('replaces preparation, execution and failure parts without caching a false success or hiding real failure', () => {
  useAgentStore.setState({ runId: 'synthetic', phase: 'running', lastSeq: 0, messages: [], workspaceActivities: [] })
  const apply = (event: Record<string, unknown>) => useAgentStore.getState().applyEvent({
    runId: 'synthetic', messageId: 'm', callId: 'write', toolName: 'chapter_write', ts: '', ...event,
  } as AgentStreamEvent)
  apply({ type: 'tool.delta', seq: 1, argsChars: 20 })
  const preparing = useAgentStore.getState().messages[0].parts
  expect(projectAgentAuthorParts(preparing, true)).toEqual([])
  expect(projectAgentAuthorParts(preparing, true, { includePreparing: true })[0]).toMatchObject({ preparing: true, status: 'running' })
  apply({ type: 'tool.call', seq: 2, args: {}, title: '' })
  const executing = useAgentStore.getState().messages[0].parts
  expect(executing[0]).not.toBe(preparing[0])
  expect(projectAgentAuthorParts(executing, true)[0]).toMatchObject({ preparing: false, status: 'running' })
  apply({ type: 'tool.result', seq: 3, ok: false, summary: '这次修改没有完成。' })
  const failed = useAgentStore.getState().messages[0].parts
  expect(failed[0]).not.toBe(executing[0])
  expect(projectAgentAuthorParts(failed)[0]).toMatchObject({ preparing: false, status: 'failed', summary: '这次修改没有完成。' })
  expect(projectAgentAuthorParts(preparing, true)).toEqual([])
  expect(projectAgentAuthorParts(preparing, true, { includePreparing: true })[0]).toMatchObject({ preparing: true, status: 'running' })
})
