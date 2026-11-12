// @vitest-environment jsdom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { AgentMessageParts } from '../../src/features/studio/agent/components/AgentMessageParts'
import { useStreamingTextState } from '../../src/features/studio/components/use-streaming-text'
import { isRunActive, useAgentStore } from '../../src/features/studio/agent/agentStore'
import { projectMessages } from '../../src/features/studio/agent/lib/message-projection'
import type { AgentStreamEventBody } from '../../shared/contracts/index.js'

beforeAll(async () => { await Promise.all([import('react-markdown'), import('remark-gfm')]) }, 30000)
afterEach(() => { cleanup(); useAgentStore.getState().resetRun(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function Harness() {
  const state = useAgentStore(), [expanded, expand] = useState(false)
  const message = state.messages.find(item => item.id === 'answer')
  if (!message) return null
  return <AgentMessageParts parts={message.parts} messageId={message.id} streaming={!state.finalizedTextIds.includes(message.id)}
    runActive={isRunActive(state.phase)} settling={Object.keys(state.textRevealTargets).length > 0}
    revealText={state.textRevealTargets[message.id]} onTextRevealed={state.finishTextReveal} animateLive={message.runId === state.runId && state.motionAfterSeq !== null && (isRunActive(state.phase) || Object.keys(state.textRevealTargets).length > 0)}
    liveToolCallIds={state.liveToolCallIds} blockId="answer" summaryCount={1} summaryExpanded={expanded} onToggleSummary={() => expand(value => !value)} />
}
let seq = 0
function event(body: AgentStreamEventBody) { useAgentStore.getState().applyEvent({ ...body, runId: 'run', seq: ++seq, ts: '2026-10-31T00:00:00Z' }) }
// Each call starts a separate synthetic execution; reusing a run id is an idempotent receipt.
function start() { useAgentStore.getState().resetRun(); seq = 0; useAgentStore.getState().beginRun('run', '合成问题', 'session'); event({ type: 'message.start', messageId: 'answer' }) }
const answer = '按照已经核对的卷纲，第一卷计划写二十章，人物冲突与阶段目标会分批推进。'
it('keeps the entire pending batch on its original call and clears it on the cancel receipt', () => {
  start()
  const questions = [
    { question: '故事主线？', options: [{ label: '旧案' }, { label: '失踪' }] },
    { question: '叙事视角？', options: [{ label: '第一人称' }, { label: '第三人称' }] },
  ]
  event({ type: 'tool.call', messageId: 'answer', callId: 'batch', toolName: 'ask_user',
    title: '向作者提问', args: { requestId: 'batch-request', questions } })
  expect(useAgentStore.getState()).toMatchObject({
    phase: 'awaiting_input', pendingQuestion: { callId: 'batch', requestId: 'batch-request', ...questions[0], questions },
  })
  event({ type: 'tool.result', messageId: 'answer', callId: 'batch', toolName: 'ask_user', ok: true,
    summary: '作者已取消提问', display: { kind: 'question', ...questions[0], questions, cancelled: true } })
  expect(useAgentStore.getState().pendingQuestion).toBeNull()
  expect(useAgentStore.getState().messages.at(-1)?.parts.at(-1)).toMatchObject({ display: { cancelled: true } })
})

it('retains cover asset references from single and batched question events', () => {
  const question = { question: '选择封面', options: [{ label: '雨夜车站', coverAssetId: 'sample-cover-1' }, { label: '暂不应用' }] }
  for (const args of [question, { questions: [question] }]) {
    start()
    event({ type: 'tool.call', messageId: 'answer', callId: 'cover-question', toolName: 'ask_user', title: '向作者提问', args })
    expect(useAgentStore.getState().pendingQuestion).toMatchObject({
      callId: 'cover-question',
      ...question,
      ...('questions' in args ? args : {}),
    })
  }
})

it('keeps saved setup progress and tool results ahead of the terminal recap on live delivery and replay', () => {
  start()
  const progress = '先确认故事方向。'
  const recap = '书名《雾港》，简介已保存。要不要开始写大纲？'
  event({ type: 'text.final', messageId: 'answer', text: progress, asReasoning: false })
  event({ type: 'tool.call', messageId: 'answer', callId: 'save', toolName: 'novel_update_meta', title: '更新作品信息', args: {} })
  event({ type: 'tool.result', messageId: 'answer', callId: 'save', toolName: 'novel_update_meta', ok: true, summary: '已整理作品信息' })
  const terminal = { type: 'text.final', messageId: 'answer', text: recap, asReasoning: false, afterTools: true } as const
  event(terminal)
  event(terminal)
  const state = useAgentStore.getState()
  expect(state.messages.at(-1)?.parts).toEqual([
    { type: 'text', text: progress },
    expect.objectContaining({ type: 'tool-call', callId: 'save', status: 'success' }),
    { type: 'text', text: recap },
  ])
  expect(state.textRevealTargets.answer).toBe(progress + recap)
  state.finishTextReveal('answer', progress + recap)
  expect(useAgentStore.getState().textRevealTargets).toEqual({})
})

it('reveals an atomic final answer after real finish, then folds process rows with an exit transition', async () => {
  vi.useFakeTimers(); start()
  event({ type: 'tool.call', messageId: 'answer', callId: 'read', toolName: 'chapter_read', title: '读取正文', args: {} })
  event({ type: 'tool.result', messageId: 'answer', callId: 'read', toolName: 'chapter_read', ok: true, summary: '已核对合成资料' })
  const view = render(<Harness />)
  act(() => { event({ type: 'text.final', messageId: 'answer', text: answer }); event({ type: 'run.finished', status: 'succeeded', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, artifacts: [] }) })
  expect(useAgentStore.getState().phase).toBe('succeeded')
  expect(useAgentStore.getState().messages.at(-1)?.parts).toEqual([expect.objectContaining({ type: 'tool-call', callId: 'read', status: 'success' }), { type: 'text', text: answer }])
  expect(view.container.textContent).not.toContain(answer)
  expect(screen.getByText('已核对合成资料')).toBeTruthy()
  await act(async () => { await vi.advanceTimersByTimeAsync(16) })
  expect(view.container.textContent).toContain(answer.slice(0, 4))
  expect(view.container.textContent).not.toContain(answer)
  await act(async () => { await vi.advanceTimersByTimeAsync(600) })
  expect(view.container.textContent).toContain(answer)
  expect(view.container.querySelector('[data-agent-call-id="read"]')?.closest('[data-agent-process-open]')?.getAttribute('data-agent-process-open')).toBe('false')
  await act(async () => { await vi.advanceTimersByTimeAsync(220) })
  expect(screen.queryByText('已核对合成资料')).toBeNull()
  expect(useAgentStore.getState().textRevealTargets).toEqual({})
  fireEvent.click(screen.getByRole('button', { name: '查看 1 项操作' }))
  await act(async () => { await vi.advanceTimersByTimeAsync(32) })
  expect(screen.getByText('已核对合成资料')).toBeTruthy()
})
it('smooths progress even when a tool part starts, with truthful same-frame prepare/result updates', async () => {
  vi.useFakeTimers(); start(); const view = render(<Harness />)
  act(() => { event({ type: 'text.final', messageId: 'answer', text: answer }); event({ type: 'tool.call', messageId: 'answer', callId: 'read', toolName: 'chapter_read', title: '读取正文', args: {} }) })
  expect(view.container.textContent).not.toContain(answer)
  const row = view.container.querySelector('[data-agent-call-id="read"]')
  expect(row?.getAttribute('data-agent-tool-phase')).toBe('running')
  act(() => event({ type: 'tool.result', messageId: 'answer', callId: 'read', toolName: 'chapter_read', ok: true, summary: '读取完成' }))
  expect(view.container.querySelector('[data-agent-call-id="read"]')).toBe(row)
  expect(row?.getAttribute('data-agent-tool-phase')).toBe('success')
  await act(async () => { await vi.advanceTimersByTimeAsync(400) })
  expect(view.container.textContent).toContain(answer)
})
it('shows final-only live mounts progressively, but flushes stop, history, switch and reduced motion', async () => {
  vi.useFakeTimers(); start()
  event({ type: 'text.final', messageId: 'answer', text: answer })
  event({ type: 'run.finished', status: 'succeeded', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, artifacts: [] })
  const view = render(<Harness />)
  expect(view.container.textContent).not.toContain(answer)
  act(() => event({ type: 'run.paused', reason: 'user_stop' }))
  expect(view.container.textContent).toContain(answer)
  act(() => useAgentStore.getState().restoreMessages([{ id: 'answer', runId: 'run', role: 'assistant', parts: [{ type: 'text', text: '历史答复直接可见' }], createdAt: '' }], 'other'))
  expect(view.container.textContent).toContain('历史答复直接可见')
  expect(useAgentStore.getState().textRevealTargets).toEqual({})
  act(() => { useAgentStore.getState().resumeRun('run', 'other'); event({ type: 'text.final', messageId: 'answer', text: '重放历史不逐字播放' }) })
  expect(view.container.textContent).toContain('重放历史不逐字播放')
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  view.unmount(); start(); event({ type: 'text.final', messageId: 'answer', text: answer })
  const reduced = render(<Harness />)
  expect(reduced.container.textContent).toContain(answer)
  expect(useAgentStore.getState().textRevealTargets).toEqual({})
})
it('does not count hidden reply transport as an extra operation', () => {
  const result = projectMessages([{ id: 'answer', runId: 'run', role: 'assistant', createdAt: '', parts: [
    { type: 'tool-call', callId: 'reply', toolName: 'task_respond', title: '答复问题', status: 'success' }, { type: 'text', text: answer },
  ] }])
  expect(result.blockInfoById.get('answer')?.ops).toBe(0)
})

it.each([{ label: 'empty', text: '' }, { label: 'protocol-only', text: '<tool_call>{"name":"task_respond"}</tool_call>' }])(
  'lets the composer settle when a hidden tool-only turn has an $label final', ({ text }) => {
    start()
    event({ type: 'message.start', messageId: 'tool-turn' })
    event({ type: 'text.final', messageId: 'tool-turn', text })
    event({ type: 'tool.call', messageId: 'tool-turn', callId: 'reply', toolName: 'task_respond', title: '答复问题', args: {} })
    event({ type: 'tool.result', messageId: 'tool-turn', callId: 'reply', toolName: 'task_respond', ok: true, summary: '已答复' })
    event({ type: 'text.delta', messageId: 'answer', delta: '先显示这段临时文本。\n\n' })
    expect(useAgentStore.getState().textRevealTargets.answer).toBeDefined()
    event({ type: 'text.final', messageId: 'answer', text })
    event({ type: 'run.finished', status: 'succeeded', nextPrompt: '复核刚保存的计划。', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, artifacts: [] })
    expect(useAgentStore.getState().textRevealTargets).toEqual({})
    expect(useAgentStore.getState().nextPrompt).toEqual({ runId: 'run', text: '复核刚保存的计划。' })
  },
)

it('keeps a prepared tool row stable through batched completion and exits without replay on history expand', async () => {
  vi.useFakeTimers(); start(); const view = render(<Harness />)
  act(() => event({ type: 'tool.delta', messageId: 'answer', callId: 'fast', toolName: 'chapter_read', argsChars: 4 }))
  const row = view.container.querySelector('[data-agent-call-id="fast"]')
  expect(row?.getAttribute('data-agent-tool-phase')).toBe('preparing')
  act(() => {
    event({ type: 'tool.call', messageId: 'answer', callId: 'fast', toolName: 'chapter_read', title: '读取', args: {} })
    event({ type: 'tool.result', messageId: 'answer', callId: 'fast', toolName: 'chapter_read', ok: true, summary: '即时读取完成' })
    event({ type: 'run.finished', status: 'succeeded', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, artifacts: [] })
  })
  expect(useAgentStore.getState().phase).toBe('succeeded')
  expect(view.container.querySelector('[data-agent-call-id="fast"]')).toBe(row)
  expect(row?.getAttribute('data-agent-tool-phase')).toBe('success')
  expect(row?.closest('[data-agent-process-open]')?.getAttribute('data-agent-process-open')).toBe('false')
  await act(async () => { await vi.advanceTimersByTimeAsync(220) })
  expect(view.container.querySelector('[data-agent-call-id="fast"]')).toBeNull()
  view.unmount()
  useAgentStore.getState().restoreMessages(useAgentStore.getState().messages, 'history')
  const history = render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: '查看 1 项操作' }))
  expect(history.container.querySelector('.agent-tool-enter')).toBeNull()
})
it.each(['call', 'result', 'preview'] as const)('places new streamed commentary according to a preceding %s, then keeps that slot', boundary => {
  start()
  if (boundary === 'call') event({ type: 'tool.call', messageId: 'answer', callId: 'read', toolName: 'chapter_read', title: '读取', args: {} })
  else if (boundary === 'result') event({ type: 'tool.result', messageId: 'answer', callId: 'read', toolName: 'chapter_read', ok: true, summary: '读取完成' })
  else event({ type: 'tool.delta', messageId: 'answer', callId: 'read', toolName: 'chapter_read', argsChars: 4 })
  event({ type: 'text.delta', messageId: 'answer', delta: '人物直到抵达河岸才知道信寄错了。\n\n' })
  const parts = () => useAgentStore.getState().messages.at(-1)?.parts
  const types = boundary === 'preview' ? ['text', 'tool-call'] : ['tool-call', 'text']
  expect(parts()?.map(part => part.type)).toEqual(types)
  event({ type: 'text.final', messageId: 'answer', text: '人物在渡口才知道信寄错了。' })
  expect(parts()?.map(part => part.type)).toEqual(types)
  expect(parts()?.filter(part => part.type === 'text')).toEqual([{ type: 'text', text: '人物在渡口才知道信寄错了。' }])
})

it('keeps streamed prose before its tool through preview, admission, finalization, and an authoritative correction', async () => {
  vi.useFakeTimers(); start(); const view = render(<Harness />)
  const parts = () => useAgentStore.getState().messages.at(-1)?.parts
  const prose = '第一段信息已核实。\n\n第二段说明保持完整。'
  act(() => {
    event({ type: 'text.delta', messageId: 'answer', delta: '第一段信息已核实。\n\n' })
    event({ type: 'tool.delta', messageId: 'answer', callId: 'middle', toolName: 'chapter_read', argsChars: 2 })
    event({ type: 'text.delta', messageId: 'answer', delta: '第二段说明保持完整。\n\n' })
  })
  expect(parts()).toEqual([{ type: 'text', text: prose + '\n\n' }, expect.objectContaining({ type: 'tool-call', callId: 'middle', preparing: true })])
  act(() => event({ type: 'tool.call', messageId: 'answer', callId: 'middle', toolName: 'chapter_read', title: '读取', args: {} }))
  await act(async () => { await vi.advanceTimersByTimeAsync(32) })
  act(() => event({ type: 'text.final', messageId: 'answer', text: prose }))
  expect(parts()).toEqual([{ type: 'text', text: prose }, expect.objectContaining({ type: 'tool-call', callId: 'middle', preparing: false })])
  await act(async () => { await vi.advanceTimersByTimeAsync(400) })
  expect(view.container.textContent).toContain('第一段信息已核实。')
  expect(view.container.textContent).toContain('第二段说明保持完整。')
  expect(view.container.textContent?.match(/第一段信息已核实。/g)).toHaveLength(1)
  act(() => event({ type: 'text.final', messageId: 'answer', text: '纠正后的完整说明。' }))
  expect(view.container.textContent).toContain('纠正后的完整说明。')
  expect(view.container.textContent).not.toContain('第一段信息')
  act(() => useAgentStore.getState().finishTextReveal('answer', '旧说明'))
  expect(parts()?.[0]).toEqual({ type: 'text', text: '纠正后的完整说明。' })
  act(() => event({ type: 'text.final', messageId: 'answer', text: '' }))
  expect(parts()).toEqual([expect.objectContaining({ type: 'tool-call', callId: 'middle' })])
})

it('flushes hidden text without accumulating timers or replaying background chunks after return', () => {
  vi.useFakeTimers()
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const hook = renderHook(({ text }) => useStreamingTextState(text, true, 'live', true), { initialProps: { text: '' } })
  hook.rerender({ text: answer })
  expect(vi.getTimerCount()).toBe(1)
  visibility.mockReturnValue('hidden')
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  expect(hook.result.current).toEqual({ text: answer, pending: false })
  expect(vi.getTimerCount()).toBe(0)
  let latest = answer
  for (let index = 0; index < 512; index++) {
    latest += '后台新增的真实文字。'.repeat(8)
    hook.rerender({ text: latest })
    expect(vi.getTimerCount()).toBe(0)
  }
  expect(hook.result.current).toEqual({ text: latest, pending: false })
  visibility.mockReturnValue('visible')
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  expect(hook.result.current).toEqual({ text: latest, pending: false })
  expect(vi.getTimerCount()).toBe(0)
  hook.rerender({ text: latest + answer })
  expect(hook.result.current.pending).toBe(true)
  expect(vi.getTimerCount()).toBe(1)
  act(() => vi.advanceTimersByTime(16))
  expect(hook.result.current.text.length).toBeGreaterThan(latest.length)
  expect(hook.result.current.text.length).toBeLessThan(latest.length + answer.length)
  hook.unmount()
  expect(vi.getTimerCount()).toBe(0)
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  expect(vi.getTimerCount()).toBe(0)
})
it('flushes a hidden initial mount and preserves the latest scope when visibility resumes', () => {
  vi.useFakeTimers()
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  const hook = renderHook(({ text, scope }) => useStreamingTextState(text, true, scope, true), { initialProps: { text: answer, scope: 'old' } })
  expect(hook.result.current).toEqual({ text: answer, pending: false })
  hook.rerender({ text: '当前任务的最新文字', scope: 'current' })
  visibility.mockReturnValue('visible')
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  expect(hook.result.current).toEqual({ text: '当前任务的最新文字', pending: false })
  expect(vi.getTimerCount()).toBe(0)
})
it('clears response settling on polled stop or failure, preserving successful completion drain', () => {
  for (const status of ['paused', 'cancelled', 'failed', 'completed'] as const) {
    start(); event({ type: 'text.final', messageId: 'answer', text: answer })
    useAgentStore.getState().syncRemoteRunStatuses({ session: { runId: 'run', status } })
    expect(useAgentStore.getState().textRevealTargets).toEqual(status === 'completed' ? { answer } : {})
    if (status !== 'completed') {
      event({ type: 'text.final', messageId: 'answer', text: '迟到但应保留的真实文字' })
      expect(useAgentStore.getState().textRevealTargets).toEqual({})
      expect(useAgentStore.getState().motionAfterSeq).toBeNull()
    }
  }
  start(); event({ type: 'text.final', messageId: 'answer', text: answer })
  useAgentStore.getState().syncRemoteRunStatuses({ session: { runId: 'run', status: 'running', authorEnded: { fulfilled: false } } })
  expect(useAgentStore.getState().phase).toBe('cancelled')
  expect(useAgentStore.getState().textRevealTargets).toEqual({})
})

it('does not replay retained same-run tool history on Continue while animating new live calls', () => {
  start()
  event({ type: 'tool.call', messageId: 'answer', callId: 'old-read', toolName: 'chapter_read', title: '读取', args: {} })
  event({ type: 'tool.result', messageId: 'answer', callId: 'old-read', toolName: 'chapter_read', ok: true, summary: '已保存的读取结果' })
  event({ type: 'run.finished', status: 'failed', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, artifacts: [] })
  useAgentStore.getState().resumeRun('run', 'session', null, seq)
  const view = render(<Harness />)
  const old = view.container.querySelector('[data-agent-call-id="old-read"]')
  expect(old?.classList.contains('agent-tool-enter')).toBe(false)
  act(() => event({ type: 'tool.delta', messageId: 'answer', callId: 'new-read', toolName: 'chapter_read', argsChars: 4 }))
  const fresh = view.container.querySelector('[data-agent-call-id="new-read"]')
  expect(fresh?.classList.contains('agent-tool-enter')).toBe(true)
  expect(old?.classList.contains('agent-tool-enter')).toBe(false)
  act(() => {
    event({ type: 'tool.call', messageId: 'answer', callId: 'new-read', toolName: 'chapter_read', title: '读取', args: {} })
    event({ type: 'tool.result', messageId: 'answer', callId: 'new-read', toolName: 'chapter_read', ok: true, summary: '本次读取完成' })
  })
  expect(view.container.querySelector('[data-agent-call-id="new-read"]')).toBe(fresh)
  expect(fresh?.getAttribute('data-agent-tool-phase')).toBe('success')
  expect(useAgentStore.getState().liveToolCallIds).toEqual(new Set(['new-read']))
})
