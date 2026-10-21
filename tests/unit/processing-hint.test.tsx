// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ProcessingHint } from '../../src/features/studio/agent/components/ProcessingHint'
import { AgentMessageParts } from '../../src/features/studio/agent/components/AgentMessageParts'
import { projectAgentAuthorParts } from '../../shared/agent-author-view'
import { shouldShowProcessingHint } from '../../src/features/studio/agent/lib/panel-helpers'
import type { AgentUIMessage } from '../../shared/contracts/index.js'
import { useAgentStore } from '../../src/features/studio/agent/agentStore'
import { OUTPUT_SILENCE_MS, useProcessingHint } from '../../src/features/studio/agent/useProcessingHint'
afterEach(() => { cleanup(); useAgentStore.getState().resetRun(); vi.useRealTimers() })

function LiveParts() {
  const messages=useAgentStore(state=>state.messages)
  const visible=useProcessingHint(messages,'r','running',false)
  return <><ProcessingHint visible={visible}/>{messages.map(message=><AgentMessageParts key={message.id} parts={message.parts} streaming runActive/>)}</>
}

it('hands fallback feedback to the first preparation frame and keeps one card throughout visible draft growth',()=>{
  vi.useFakeTimers()
  useAgentStore.getState().resumeRun('r','session')
  useAgentStore.setState({messages:[],lastSeq:0,lastVisibleOutput:null})
  const view=render(<LiveParts/>),apply=useAgentStore.getState().applyEvent
  const base={runId:'r',messageId:'m',callId:'write',ts:new Date().toISOString()}
  expect(screen.getByRole('status').textContent).toBe('正在处理...')
  act(()=>apply({...base,seq:1,type:'tool.delta',toolName:'chapter_write',argsChars:0}))
  expect(screen.getByText('准备中…')).toBeTruthy()
  expect(screen.queryByRole('status')).toBeNull()
  expect(view.container.querySelector('.agent-tool-progress')).not.toBeNull()
  for(let seq=2;seq<=4;seq++){
    act(()=>apply({...base,seq,type:'tool.delta',toolName:'chapter_write',argsChars:seq*10,draft:{kind:'chapter',toolName:'chapter_write',content:'可见正文'.repeat(seq)}}))
    act(()=>vi.advanceTimersByTime(OUTPUT_SILENCE_MS+1))
    expect(screen.queryByRole('status')).toBeNull()
    expect(view.container.querySelectorAll('[data-agent-call-id="write"]')).toHaveLength(1)
  }
  expect(useAgentStore.getState().workspaceActivities).toEqual([])
  act(()=>apply({...base,seq:5,type:'tool.call',toolName:'chapter_write',title:'写入正文',args:{chapterId:'chapter'}}))
  expect(screen.queryByText('准备中…')).toBeNull()
  expect(screen.getByText('执行中…')).toBeTruthy()
  act(()=>apply({...base,seq:6,type:'tool.result',toolName:'chapter_write',ok:true,summary:'正文已保存'}))
  expect(view.container.querySelectorAll('[data-agent-call-id="write"]')).toHaveLength(1)
  expect(view.container.querySelector('.agent-tool-progress')).toBeNull()
  expect(screen.getByRole('status').textContent).toBe('正在处理...')
  expect(useAgentStore.getState().liveToolDrafts).toEqual({})
})

it('cancels the fallback timer when goal control suppresses a stale running phase', () => {
  vi.useFakeTimers()
  useAgentStore.setState({ lastVisibleOutput: { runId: 'r', at: Date.now() } })
  const view = renderHook(({ enabled }) => useProcessingHint([], 'r', 'running', false, enabled), { initialProps: { enabled: true } })
  expect(vi.getTimerCount()).toBe(1)
  view.rerender({ enabled: false })
  expect(vi.getTimerCount()).toBe(0)
  act(() => vi.advanceTimersByTime(5000))
  expect(view.result.current).toBe(false)
  view.rerender({ enabled: true })
  expect(view.result.current).toBe(true)
})

it('hides on published paragraph output and returns only after silence without another event', () => {
  vi.useFakeTimers()
  const message: AgentUIMessage = { id: 'm', runId: 'r', role: 'assistant', createdAt: new Date().toISOString(), parts: [] }
  useAgentStore.setState({ runId: 'r', lastSeq: 0, messages: [message], lastVisibleOutput: null })
  const view = renderHook(() => useProcessingHint(useAgentStore(state => state.messages), 'r', 'running', false))
  expect(view.result.current).toBe(true)
  act(() => useAgentStore.getState().applyEvent({ type: 'text.delta', messageId: 'm', runId: 'r', delta: '正在输出。\n\n', seq: 1, ts: new Date().toISOString() }))
  expect(view.result.current).toBe(false)
  act(() => vi.advanceTimersByTime(OUTPUT_SILENCE_MS - 100))
  act(() => useAgentStore.getState().applyEvent({ type: 'text.delta', messageId: 'm', runId: 'r', delta: '继续输出。\n\n', seq: 2, ts: new Date().toISOString() }))
  act(() => vi.advanceTimersByTime(200))
  expect(view.result.current).toBe(false)
  act(() => vi.advanceTimersByTime(OUTPUT_SILENCE_MS))
  expect(view.result.current).toBe(true)
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it.each(['text.delta', 'reasoning.delta'] as const)('keeps truthful waiting feedback while %s contains invisible progress', type => {
  vi.useFakeTimers()
  useAgentStore.getState().resetRun()
  useAgentStore.getState().resumeRun('r', 'session')
  useAgentStore.setState({ lastVisibleOutput: null })
  const view = renderHook(() => useProcessingHint(useAgentStore(state => state.messages), 'r', 'running', false))
  const apply = useAgentStore.getState().applyEvent
  const base = { runId: 'r', messageId: 'm', ts: new Date().toISOString() }
  act(() => apply({ ...base, seq: 1, type: 'message.start', role: 'assistant' }))
  act(() => apply({ ...base, seq: 2, type, delta: '调用 chapter_' }))
  expect(view.result.current).toBe(true)
  expect(projectAgentAuthorParts(useAgentStore.getState().messages[0].parts, true).every(part => part.type === 'reasoning' && !part.text)).toBe(true)
  expect(useAgentStore.getState().lastVisibleOutput).toBeNull()
  act(() => apply({ ...base, seq: 3, type, delta: 'write，chapterId=private-id。\n\n' }))
  expect(view.result.current).toBe(true)
  const parts = projectAgentAuthorParts(useAgentStore.getState().messages[0].parts, true)
  expect(parts.every(part => (part.type === 'text' || part.type === 'reasoning') && part.text.trim() === '')).toBe(true)
  expect(JSON.stringify(parts)).not.toMatch(/chapter_write|chapterId|private-id/)
  act(() => vi.advanceTimersByTime(OUTPUT_SILENCE_MS))
  expect(view.result.current).toBe(true)
  expect(useAgentStore.getState().lastVisibleOutput).toBeNull()
})

it('does not let old-run or whitespace events suppress waiting; replay does not extend the timer', () => {
  vi.useFakeTimers()
  useAgentStore.setState({ runId: 'r', lastSeq: 0, messages: [], lastVisibleOutput: null })
  const view = renderHook(() => useProcessingHint([], 'r', 'running', false))
  act(() => useAgentStore.getState().applyEvent({ type: 'text.delta', messageId: 'm', runId: 'old', delta: '旧输出', seq: 1, ts: new Date().toISOString() }))
  expect(view.result.current).toBe(true)
  act(() => useAgentStore.getState().applyEvent({ type: 'text.delta', messageId: 'm', runId: 'r', delta: '\n', seq: 2, ts: new Date().toISOString() }))
  expect(view.result.current).toBe(true)
  const event = { type: 'text.delta' as const, messageId: 'm', runId: 'r', delta: '字\n\n', seq: 3, ts: new Date().toISOString() }
  act(() => useAgentStore.getState().applyEvent(event))
  act(() => vi.advanceTimersByTime(1000))
  act(() => useAgentStore.getState().applyEvent(event))
  act(() => vi.advanceTimersByTime(501))
  expect(view.result.current).toBe(true)
})

it('cleans timers on pause, keeps approvals idle and isolates run switches', () => {
  vi.useFakeTimers()
  useAgentStore.setState({ lastVisibleOutput: { runId: 'r', at: Date.now() } })
  const view = renderHook(({ runId, phase, waiting }) => useProcessingHint([], runId, phase, waiting), { initialProps: { runId: 'r', phase: 'running', waiting: false } })
  expect(view.result.current).toBe(false)
  expect(vi.getTimerCount()).toBe(1)
  view.rerender({ runId: 'r', phase: 'paused', waiting: false })
  expect(vi.getTimerCount()).toBe(0)
  act(() => vi.advanceTimersByTime(5000))
  expect(view.result.current).toBe(false)
  view.rerender({ runId: 'new', phase: 'running', waiting: true })
  expect(view.result.current).toBe(false)
  view.rerender({ runId: 'new', phase: 'running', waiting: false })
  expect(view.result.current).toBe(true)
})
it.each(['scene_task_build', 'chapter_write', 'chapter_read', 'quality_analyze', 'web_search', 'other_action'])('keeps the existing shimmer before %s has a running card, then hands off', toolName => {
  vi.useFakeTimers()
  const message: AgentUIMessage = { id: 'm', runId: 'r', role: 'assistant', createdAt: new Date().toISOString(), parts: [{ type: 'reasoning', text: '现在构建场景' }] }
  const view = render(<ProcessingHint visible={shouldShowProcessingHint([message], 'r', 'running')} />)
  act(() => vi.advanceTimersByTime(5000)) // No finalization or parameter event arrives.
  expect(screen.getByRole('status').textContent).toBe('正在处理...')
  expect(view.container.querySelector('.agent-processing-shimmer')).not.toBeNull()
  message.parts.push({ type: 'tool-call', callId: 'c', toolName, title: '执行动作', args: null, status: 'running' })
  view.rerender(<ProcessingHint visible={shouldShowProcessingHint([message], 'r', 'running')} />)
  expect(screen.queryByRole('status')).toBeNull()
  act(() => vi.advanceTimersByTime(250))
  expect(view.container.textContent).toBe('')
})
it('shows animated waiting feedback and removes it even without animationend', () => {
  vi.useFakeTimers()
  const view = render(<ProcessingHint visible />)
  expect(screen.getByRole('status').textContent).toBe('正在处理...')
  expect(view.container.querySelector('.agent-processing-shimmer')).not.toBeNull()
  view.rerender(<ProcessingHint visible={false} />)
  expect(screen.queryByRole('status')).toBeNull()
  expect(view.container.querySelector('.agent-processing-shimmer')).toBeNull()
  act(() => vi.advanceTimersByTime(250))
  expect(view.container.textContent).toBe('')
})
it('can reappear mid-fade without the previous timer removing the new hint', () => {
  vi.useFakeTimers()
  const view = render(<ProcessingHint visible />)
  view.rerender(<ProcessingHint visible={false} />)
  act(() => vi.advanceTimersByTime(100))
  view.rerender(<ProcessingHint visible />)
  act(() => vi.advanceTimersByTime(400))
  expect(screen.getAllByRole('status')).toHaveLength(1)
  expect(view.container.querySelector('.agent-processing-shimmer')).not.toBeNull()
})
it('does not mount a placeholder when initially idle and cleans up timers on unmount', () => {
  vi.useFakeTimers()
  const view = render(<ProcessingHint visible={false} />)
  expect(view.container.textContent).toBe('')
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})
