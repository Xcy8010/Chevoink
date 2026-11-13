// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentStreamEvent, AgentUIMessage } from '../../shared/contracts/index.js'
import { useAgentStream } from '../../src/features/studio/agent/useAgentStream.js'
import { restoreActiveRunHistory, failSessionHistoryHydration, useAgentStore } from '../../src/features/studio/agent/agentStore.js'
import { workspaceGroupDelta } from '../../src/features/studio/agent/workspace-body-changes.js'

class Source {
  static opened: Source[] = []
  listeners = new Map<string, (event: MessageEvent) => void>()
  onerror: (() => void) | null = null
  close = vi.fn()
  constructor(readonly url: string) { Source.opened.push(this) }
  addEventListener(type: string, callback: (event: MessageEvent) => void) { this.listeners.set(type, callback) }
  send(event: AgentStreamEvent) { this.listeners.get(event.type)?.(new MessageEvent(event.type, { data: JSON.stringify(event) })) }
}
const base = { runId: 'run-a', ts: '2026-11-05T00:00:00Z' }
const start = (seq: number): AgentStreamEvent => ({ ...base, seq, type: 'run.started', mode: 'act', title: 'A', agent: { type: 'novelist', title: '作者助手', model: 'speed' } })
const result = (seq: number, callId = 'old-write', messageId = 'saved-a'): AgentStreamEvent => ({ ...base, seq, type: 'tool.result', messageId, callId, toolName: 'chapter_write', ok: true, summary: '已保存',
  display: { kind: 'chapterDiff', chapterId: 'chapter-a', chapterTitle: 'A', before: '甲', after: '乙丙', revision: 2, appliedDirectly: true } })
const history = (): AgentUIMessage[] => [
  { id: 'user-a', runId: 'run-a', role: 'user', createdAt: base.ts, parts: [{ type: 'text', text: '编辑当前章节' }] },
  { id: 'saved-a', runId: 'run-a', role: 'assistant', createdAt: base.ts, parts: [
    { type: 'reasoning', text: '先核对承接。' }, { type: 'text', text: '已有结果。\n\n' },
    { type: 'tool-call', callId: 'old-write', toolName: 'chapter_write', title: '写入正文', args: {}, status: 'success', summary: '已保存',
      display: { kind: 'chapterDiff', chapterId: 'chapter-a', chapterTitle: 'A', before: '甲', after: '乙丙', revision: 2, appliedDirectly: true } },
    { type: 'tool-call', callId: 'old-plan', toolName: 'plan_save', title: '保存计划', args: {}, status: 'success',
      display: { kind: 'planDiff', artifactId: 'plan-a', title: '计划A', before: '', after: '后续安排' } },
  ] },
]
const toolIds = () => useAgentStore.getState().messages.flatMap(message => message.parts.flatMap(part => part.type === 'tool-call' ? [part.callId] : []))
const activityIds = () => useAgentStore.getState().workspaceActivities.map(activity => activity.callId)
beforeEach(() => {
  useAgentStore.getState().resetRun()
  Source.opened = []
  vi.stubGlobal('EventSource', Source)
})
afterEach(() => { cleanup(); useAgentStore.getState().resetRun(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear() })

it('keeps server-saved tools and change counts through A -> B -> A when legacy replay contains only the new attempt tail', () => {
  const hook = renderHook(() => useAgentStream())
  act(() => { restoreActiveRunHistory(history(), 'run-a', 'session-a'); hook.result.current.connect('run-a', 0) })
  const initialDelta = workspaceGroupDelta(useAgentStore.getState().workspaceActivities)
  expect(activityIds()).toEqual(['old-write', 'old-plan'])
  act(() => { hook.result.current.disconnect(); useAgentStore.getState().resetRun(); useAgentStore.getState().restoreMessages([
    { id: 'user-b', runId: 'run-b', role: 'user', parts: [{ type: 'text', text: 'B独立讨论' }], createdAt: base.ts },
  ], 'session-b') })
  expect(activityIds()).toEqual([])
  // Use a fresh server response rather than the in-memory/session cache.
  act(() => { restoreActiveRunHistory(structuredClone(history()), 'run-a', 'session-a'); hook.result.current.connect('run-a', 0) })
  expect(toolIds()).toEqual(['old-write', 'old-plan'])
  expect(workspaceGroupDelta(useAgentStore.getState().workspaceActivities)).toEqual(initialDelta)
  const tail = Source.opened.at(-1)!
  act(() => tail.send(start(101)))
  expect(activityIds()).toEqual(['old-write', 'old-plan'])
  act(() => tail.send({ ...base, seq: 102, type: 'message.start', role: 'assistant', messageId: 'next-attempt' }))
  act(() => tail.send({ ...base, seq: 103, type: 'tool.result', messageId: 'next-attempt', callId: 'new-volume', toolName: 'volume_create', ok: true, summary: '已新建空卷' }))
  expect(toolIds()).toEqual(['old-write', 'old-plan', 'new-volume'])
  expect(activityIds()).toEqual(['old-write', 'old-plan', 'new-volume'])
  expect(useAgentStore.getState().workspaceActivities.every(activity => activity.status === 'done')).toBe(true)
  expect(workspaceGroupDelta(useAgentStore.getState().workspaceActivities)).toEqual(initialDelta)
})

it('merges full seq0 replay without removing settled tools or duplicating saved prose and reasoning', () => {
  const hook = renderHook(() => useAgentStream())
  act(() => { restoreActiveRunHistory(history(), 'run-a', 'session-a'); hook.result.current.connect('run-a', 0) })
  const source = Source.opened[0], initialDelta = workspaceGroupDelta(useAgentStore.getState().workspaceActivities)
  act(() => { source.send(start(1)); source.send({ ...base, seq: 2, type: 'message.start', role: 'assistant', messageId: 'saved-a' }) })
  expect(activityIds()).toEqual(['old-write', 'old-plan'])
  expect(toolIds()).toEqual(['old-write', 'old-plan'])
  act(() => {
    source.send({ ...base, seq: 3, type: 'reasoning.delta', messageId: 'saved-a', delta: '先核对' })
    source.send({ ...base, seq: 4, type: 'reasoning.delta', messageId: 'saved-a', delta: '承接。' })
    source.send({ ...base, seq: 5, type: 'text.delta', messageId: 'saved-a', delta: '已有结果。\n\n' })
    source.send({ ...base, seq: 6, type: 'tool.call', messageId: 'saved-a', callId: 'old-write', toolName: 'chapter_write', title: '写入正文', args: {} })
    source.send(result(7))
    source.send({ ...base, seq: 8, type: 'text.final', messageId: 'saved-a', text: '已有结果。\n\n', asReasoning: false })
  })
  const parts = useAgentStore.getState().messages.find(message => message.id === 'saved-a')!.parts
  expect(parts.filter(part => part.type === 'reasoning')).toEqual([{ type: 'reasoning', text: '先核对承接。', activity: true }])
  expect(parts.map(part => part.type === 'tool-call' ? part.callId : part.type)).toEqual(['reasoning', 'text', 'old-write', 'old-plan'])
  expect(parts.filter(part => part.type === 'text')).toEqual([{ type: 'text', text: '已有结果。\n\n' }])
  expect(toolIds()).toEqual(['old-write', 'old-plan'])
  expect(activityIds()).toEqual(['old-write', 'old-plan'])
  expect(useAgentStore.getState().workspaceActivities.every(activity => activity.status === 'done')).toBe(true)
  expect(workspaceGroupDelta(useAgentStore.getState().workspaceActivities)).toEqual(initialDelta)
  act(() => { hook.result.current.connect('run-a', 8); Source.opened[0].send(result(99)); Source.opened[1].send(result(7)); Source.opened[1].send(result(9, 'new-write', 'later-a')) })
  expect(activityIds()).toEqual(['old-write', 'old-plan', 'new-write'])
  expect(useAgentStore.getState().lastSeq).toBe(9)
})

it('anchors the first visible final before restored tools and keeps another turn’s final separate', () => {
  const saved = history()
  saved[1].parts = saved[1].parts.filter(part => part.type !== 'text')
  const hook = renderHook(() => useAgentStream())
  act(() => { restoreActiveRunHistory(saved, 'run-a', 'session-a'); hook.result.current.connect('run-a', 50) })
  act(() => {
    const source = Source.opened[0]
    source.send({ ...base, seq: 51, type: 'text.final', messageId: 'saved-a', text: '查清了错送的那封信。', asReasoning: false })
    source.send({ ...base, seq: 52, type: 'tool.call', messageId: 'terminal', callId: 'reply', toolName: 'task_respond', title: '答复', args: {} })
    source.send({ ...base, seq: 53, type: 'tool.result', messageId: 'terminal', callId: 'reply', toolName: 'task_respond', ok: true, summary: '完成' })
    source.send({ ...base, seq: 54, type: 'text.final', messageId: 'terminal', text: '已保存第一章。', asReasoning: false })
  })
  const { messages } = useAgentStore.getState()
  expect(messages.find(message => message.id === 'saved-a')?.parts).toEqual([
    expect.objectContaining({ type: 'reasoning' }), { type: 'text', text: '查清了错送的那封信。' },
    expect.objectContaining({ type: 'tool-call', callId: 'old-write', status: 'success' }),
    expect.objectContaining({ type: 'tool-call', callId: 'old-plan', status: 'success' }),
  ])
  expect(messages.find(message => message.id === 'terminal')?.parts).toEqual([{ type: 'text', text: '已保存第一章。' }])
})

it.each([true, false])('places new commentary after a witnessed tool without crossing unreplayed receipts (from start=%s)', async fromStart => {
  vi.useFakeTimers()
  const saved = history()
  saved[1].parts = saved[1].parts.filter(part => part.type !== 'text')
  const hook = renderHook(() => useAgentStream())
  act(() => { restoreActiveRunHistory(saved, 'run-a', 'session-a'); hook.result.current.connect('run-a', fromStart ? 0 : 50) })
  const source = Source.opened[0]
  const offset = fromStart ? 0 : 50
  act(() => {
    if (fromStart) source.send({ ...base, seq: 1, type: 'message.start', messageId: 'saved-a', role: 'assistant' })
    source.send(result(offset + 2))
    source.send({ ...base, seq: offset + 3, type: 'text.delta', messageId: 'saved-a', delta: '错送的信已经回到邮差手中。\n\n' })
  })
  await act(async () => { await vi.advanceTimersByTimeAsync(32) })
  const parts = () => useAgentStore.getState().messages.find(message => message.id === 'saved-a')?.parts
  const order = () => parts()?.map(part => part.type === 'tool-call' ? part.callId : part.type)
  expect(order()).toEqual(['reasoning', 'old-write', 'text', 'old-plan'])
  act(() => {
    source.send({ ...base, seq: offset + 4, type: 'tool.call', messageId: 'saved-a', callId: 'old-plan', toolName: 'plan_save', title: '保存计划', args: {} })
    source.send({ ...base, seq: offset + 5, type: 'text.final', messageId: 'saved-a', text: '邮差已拿回错送的信。', asReasoning: false })
  })
  expect(order()).toEqual(['reasoning', 'old-write', 'text', 'old-plan'])
  expect(parts()?.find(part => part.type === 'text')).toEqual({ type: 'text', text: '邮差已拿回错送的信。' })
})

it('rejects text targeted at another run’s restored message', () => {
  const saved = history()
  saved[1].runId = 'unrelated-run'
  const hook = renderHook(() => useAgentStream())
  act(() => { restoreActiveRunHistory(saved, 'run-a', 'session-a'); hook.result.current.connect('run-a') })
  const before = useAgentStore.getState().messages
  act(() => {
    const source = Source.opened[0]
    source.send({ ...base, seq: 1, type: 'text.delta', messageId: 'saved-a', delta: '无关回复。\n\n' })
    source.send({ ...base, seq: 2, type: 'text.final', messageId: 'saved-a', text: '无关回复。', asReasoning: false })
  })
  expect(useAgentStore.getState().messages).toEqual(before)
})

it.each(['novel_update_meta', 'volume_create', 'plan_rename'])('creates one normal write activity from a result-only reconnect: %s', toolName => {
  const hook = renderHook(() => useAgentStream())
  act(() => { restoreActiveRunHistory([], 'run-a', 'session-a'); hook.result.current.connect('run-a', 50) })
  const event: AgentStreamEvent = { ...base, seq: 51, type: 'tool.result', messageId: 'result-only', callId: 'write', toolName, ok: true, summary: '已保存' }
  act(() => { Source.opened[0].send(event); Source.opened[0].send(event) })
  expect(activityIds()).toEqual(['write'])
  expect(toolIds()).toEqual(['write'])
  expect(useAgentStore.getState().workspaceActivities[0]).toMatchObject({ toolName, status: 'done' })
})

it('keeps failed and nested results truthful without counting a child write as a main workspace change', () => {
  const hook = renderHook(() => useAgentStream())
  act(() => { restoreActiveRunHistory([], 'run-a', 'session-a'); hook.result.current.connect('run-a') })
  act(() => { Source.opened[0].send({ ...base, seq: 1, type: 'tool.result', messageId: 'm', callId: 'failed', toolName: 'volume_create', ok: false, summary: '未创建' });
    Source.opened[0].send({ ...base, seq: 2, type: 'tool.result', messageId: 'm', callId: 'child', toolName: 'chapter_write', ok: true, summary: '内部保存', subagentCallId: 'parent-call' }) })
  expect(activityIds()).toEqual(['failed'])
  expect(useAgentStore.getState().workspaceActivities[0].status).toBe('failed')
  useAgentStore.getState().restoreMessages(useAgentStore.getState().messages, 'session-a')
  expect(activityIds()).toEqual(['failed'])
  expect(workspaceGroupDelta(useAgentStore.getState().workspaceActivities)).toEqual({ added: 0, removed: 0 })
})

it('preserves interleaved reasoning/tool segments and saved content while replay has only a prefix', () => {
  const saved = history()
  const message = saved[1]
  message.parts = [
    { type: 'reasoning', text: '第一段判断。' }, message.parts[2],
    { type: 'reasoning', text: '第二段判断。' }, message.parts[3],
    { type: 'reasoning', text: '第三段判断。' }, { type: 'text', text: '完整结果。\n\n' },
  ]
  const hook = renderHook(() => useAgentStream())
  act(() => { restoreActiveRunHistory(saved, 'run-a', 'session-a'); hook.result.current.connect('run-a') })
  const source = Source.opened[0]
  const beforeReplay = structuredClone(useAgentStore.getState().messages[1].parts)
  act(() => { source.send(start(1)); source.send({ ...base, seq: 2, type: 'message.start', messageId: 'saved-a', role: 'assistant' });
    source.send({ ...base, seq: 3, type: 'reasoning.delta', messageId: 'saved-a', delta: '第一' }) })
  expect(useAgentStore.getState().messages[1].parts).toEqual(beforeReplay)
  act(() => { source.send({ ...base, seq: 4, type: 'reasoning.delta', messageId: 'saved-a', delta: '段判断。' });
    source.send({ ...base, seq: 5, type: 'tool.call', messageId: 'saved-a', callId: 'old-write', toolName: 'chapter_write', title: '写入正文', args: {} });
    source.send(result(6));
    source.send({ ...base, seq: 7, type: 'reasoning.delta', messageId: 'saved-a', delta: '第二段判断。' });
    source.send({ ...base, seq: 8, type: 'tool.call', messageId: 'saved-a', callId: 'old-plan', toolName: 'plan_save', title: '保存计划', args: {} });
    source.send({ ...base, seq: 9, type: 'reasoning.delta', messageId: 'saved-a', delta: '第三段判断。' });
    source.send({ ...base, seq: 10, type: 'text.delta', messageId: 'saved-a', delta: '完整' });
    source.send({ ...base, seq: 11, type: 'tool.result', messageId: 'saved-a', callId: 'old-plan', toolName: 'plan_save', ok: true, summary: '已保存' }) })
  expect(useAgentStore.getState().messages[1].parts.map(part => part.type === 'tool-call' ? part.callId : part.text)).toEqual([
    '第一段判断。', 'old-write', '第二段判断。', 'old-plan', '第三段判断。', '完整结果。\n\n',
  ])
  expect(activityIds()).toEqual(['old-write', 'old-plan'])
})

it('reconciles retained durable message IDs using only the server-proven current root attempt', () => {
  const saved = history()
  for (const message of saved) { message.runId = 'old-attempt'; message.runTiming = { scopeId: 'root:task-a', sourceRunId: 'run-a', elapsedMs: 1000, activeSince: base.ts, status: 'running', lastSeq: 0 } }
  const hook = renderHook(() => useAgentStream())
  act(() => { restoreActiveRunHistory(saved, 'run-a', 'session-a'); hook.result.current.connect('run-a'); Source.opened[0].send(result(1, 'new-bound-write')) })
  expect(activityIds()).toEqual(['old-write', 'old-plan', 'new-bound-write'])
  expect(toolIds()).toEqual(['old-write', 'old-plan', 'new-bound-write'])
  expect(useAgentStore.getState().messages[1].runId).toBe('old-attempt')
  const invalid = history()
  invalid[1].runId = 'unrelated-run'
  invalid[1].runTiming = { scopeId: 'unrelated-run', sourceRunId: 'run-a', elapsedMs: 0, activeSince: null, status: 'finished', lastSeq: 0 }
  act(() => { restoreActiveRunHistory(invalid, 'run-a', 'session-a'); hook.result.current.connect('run-a'); Source.opened[1].send(result(2, 'not-owned')) })
  expect(toolIds()).not.toContain('not-owned')
  expect(useAgentStore.getState().lastSeq).toBe(0)
})
it('a stopped answer attaches its original durable messages before the continued stream starts', () => {
  const saved = history()
  for (const message of saved) {
    message.runId = 'stopped-attempt'
    message.runTiming = { scopeId: 'root:task-a', sourceRunId: 'stopped-attempt', elapsedMs: 1000, activeSince: null, status: 'paused', lastSeq: 12 }
  }
  const unrelated = { ...saved[1], id: 'unrelated', runId: 'other-attempt',
    runTiming: { ...saved[1].runTiming!, scopeId: 'root:other-task', sourceRunId: 'other-attempt' } }
  const hook = renderHook(() => useAgentStream())
  act(() => {
    const store = useAgentStore.getState()
    store.restoreMessages([unrelated, ...saved], 'session-a')
    store.resumeRun('run-a', 'session-a', null, undefined, 'stopped-attempt')
    hook.result.current.connect('run-a')
    Source.opened[0].send(start(1))
    Source.opened[0].send(result(2, 'after-answer'))
  })
  expect(useAgentStore.getState().messages.find(message => message.id === 'saved-a')).toMatchObject({
    runId: 'stopped-attempt', runTiming: { sourceRunId: 'run-a', activeSince: null, elapsedMs: 1000 },
  })
  expect(toolIds()).toContain('after-answer')
  expect(useAgentStore.getState().messages.find(message => message.id === 'unrelated')?.runTiming?.sourceRunId).toBe('other-attempt')
})
it('uses real tool boundaries to repair old flattened reasoning without duplicating its later segments', () => {
  const saved = history()
  saved[1].parts = [{ type: 'reasoning', text: '第一段。第二段。第三段。' }, saved[1].parts[2], saved[1].parts[3]]
  const hook = renderHook(() => useAgentStream())
  act(() => { restoreActiveRunHistory(saved, 'run-a', 'session-a'); hook.result.current.connect('run-a');
    const source = Source.opened[0]
    source.send(start(1)); source.send({ ...base, seq: 2, type: 'message.start', role: 'assistant', messageId: 'saved-a' })
    source.send({ ...base, seq: 3, type: 'reasoning.delta', messageId: 'saved-a', delta: '第一段。' })
    source.send({ ...base, seq: 4, type: 'tool.call', messageId: 'saved-a', callId: 'old-write', toolName: 'chapter_write', title: '写入正文', args: {} })
    source.send({ ...base, seq: 5, type: 'reasoning.delta', messageId: 'saved-a', delta: '第二段。' })
    source.send({ ...base, seq: 6, type: 'tool.call', messageId: 'saved-a', callId: 'old-plan', toolName: 'plan_save', title: '保存计划', args: {} })
    source.send({ ...base, seq: 7, type: 'reasoning.delta', messageId: 'saved-a', delta: '第三段。' })
    source.send({ ...base, seq: 8, type: 'step.finish', turn: 1, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } })
  })
  expect(useAgentStore.getState().messages[1].parts.map(part => part.type === 'tool-call' ? part.callId : part.text)).toEqual(['第一段。', 'old-write', '第二段。', 'old-plan', '第三段。'])
  expect(activityIds()).toEqual(['old-write', 'old-plan'])
})

it.each(['running', 'finished'] as const)('an actual delayed history rejection cannot erase a newly admitted %s run', async outcome => {
  useAgentStore.getState().restoreMessages(history(), 'session-a')
  const requestedRunId = useAgentStore.getState().runId
  let reject!: (reason: Error) => void
  const pending = new Promise<void>((_resolve, rejectRequest) => { reject = rejectRequest })
    .catch(() => failSessionHistoryHydration('session-a', requestedRunId))
  act(() => {
    useAgentStore.getState().beginRun('new-run', '新请求', 'session-a')
    useAgentStore.getState().applyEvent({ ...result(1, 'new-write', 'new-message'), runId: 'new-run' })
    if (outcome === 'finished') useAgentStore.getState().applyEvent({ ...base, runId: 'new-run', seq: 2, type: 'run.finished', status: 'succeeded', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, artifacts: [], outputSummary: '' })
  })
  const before = useAgentStore.getState()
  let retained: unknown
  await act(async () => { reject(new Error('old request disconnected')); retained = await pending })
  expect(retained).toBe(false)
  expect(useAgentStore.getState()).toMatchObject({ runId: 'new-run', messages: before.messages, workspaceActivities: before.workspaceActivities, phase: before.phase })
  expect(activityIds()).toContain('new-write')
})
it('a failed history refresh keeps the correct cached session journal and ignores a foreign session', async () => {
  useAgentStore.getState().restoreMessages(history(), 'session-a')
  const before = useAgentStore.getState(), failure = Promise.reject(new Error('offline'))
    .catch(() => failSessionHistoryHydration('session-a', null))
  expect(await failure).toBe(true)
  expect(useAgentStore.getState()).toMatchObject({ loadedSessionId: 'session-a', messages: before.messages, workspaceActivities: before.workspaceActivities })
  expect(failSessionHistoryHydration('session-b', null)).toBe(false)
  expect(activityIds()).toEqual(['old-write', 'old-plan'])
})


it('preserves private activity across a batched whitespace marker without exposing thinking', () => {
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const hook = renderHook(() => useAgentStream())
  act(() => { restoreActiveRunHistory([], 'run-a', 'session-a'); hook.result.current.connect('run-a') })
  act(() => {
    Source.opened[0].send({ ...base, seq: 1, type: 'message.start', role: 'assistant', messageId: 'm' })
    Source.opened[0].send({ ...base, seq: 2, type: 'reasoning.delta', messageId: 'm', delta: '', activity: true })
    Source.opened[0].send({ ...base, seq: 3, type: 'reasoning.delta', messageId: 'm', delta: '' })
    for (const callback of frames.splice(0)) callback(0)
  })
  expect(useAgentStore.getState().lastVisibleOutput).toMatchObject({ runId: 'run-a' })
  expect(useAgentStore.getState().messages[0].parts).toEqual([{ type: 'reasoning', text: '', activity: true }])
  const clock = useAgentStore.getState().lastVisibleOutput
  act(() => {
    Source.opened[0].send({ ...base, seq: 3, type: 'reasoning.delta', messageId: 'm', delta: '', activity: true })
    Source.opened[0].send({ ...base, runId: 'other-run', seq: 99, type: 'reasoning.delta', messageId: 'm', delta: '', activity: true })
    for (const callback of frames.splice(0)) callback(0)
  })
  expect(useAgentStore.getState().lastVisibleOutput).toBe(clock)
  expect(useAgentStore.getState().lastSeq).toBe(3)
})
