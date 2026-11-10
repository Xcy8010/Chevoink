import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'
import { projectOutgoingMessages, useOutgoingMessages } from '../../src/features/studio/agent/outgoing-messages'
import { useAgentStore, readSessionMessagesCache } from '../../src/features/studio/agent/agentStore'
import type { AgentUIMessage } from '../../shared/contracts/index'
import { runElapsedMs } from '../../shared/agent-timing'
import { projectBlockTimings, projectMessages } from '../../src/features/studio/agent/lib/message-projection'

afterEach(() => { useOutgoingMessages.setState({ items: [], requestClocks: [] }); useAgentStore.getState().resetRun(); vi.useRealTimers() })
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
function observeInitialStart(runId: string, id: string) {
  useAgentStore.getState().beginRun(runId, '合成请求', 's', [], null, id)
  // A real original start need not have sequence one.
  useAgentStore.getState().applyEvent({ type: 'run.started', runId, seq: 7, ts: '2026-11-05T00:00:05Z', mode: 'build', title: '合成任务', agent: { type: 'novelist', title: '合成助手', model: 'speed' } })
}
function loadCallback(name: string, context: Record<string, unknown>) {
  const source = ts.createSourceFile('AgentPanel.tsx', readFileSync('src/features/studio/agent/components/AgentPanel.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let callback = ''
  function visit(node: ts.Node) { if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0].getText(source); ts.forEachChild(node, visit) }
  visit(source)
  const code = ts.transpileModule(`const callback = ${callback}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return new Function(...Object.keys(context), `${code}; return callback`)(...Object.values(context)) as (...args: unknown[]) => Promise<void> | void
}
function sending(overrides: Record<string, unknown> = {}) {
  const context = {
    setActionError: vi.fn(), setActionNotice: vi.fn(), readSessionMessagesCache, deliveryErrorRef: { current: null as null | { clientRequestId: string; scope: string; sessionId: string | null; message: string } }, pinnedToBottomRef: { current: false }, useOutgoingMessages,
    sendScope: 'u:a:local-task', novelId: 'a', sessionId: null, voiceScopeKey: 'u:a:local-task',
    inheritMain: true, creditSummaryQuery: { data: null }, modelTier: 'speed', customModelId: null, selectedReasoningEffort: 'high', modelSelectionExplicit: false,
    windowConfiguration: { ready: vi.fn().mockResolvedValue(undefined), promote: vi.fn().mockResolvedValue(undefined) },
    ensureSession: vi.fn().mockResolvedValue('session-a'), viewScope: { current: 'u:a:local-task' }, viewSession: { current: null as string | null }, lazySessionRef: { current: null },
    chapterId: null, selection: null, queueRetry: { current: null }, queueQuery: { data: { items: [] }, refetch: vi.fn() },
    enqueueAgentRequest: vi.fn().mockResolvedValue({ id: 'queue' }), isRunActive: (phase: string) => ['starting','running','awaiting_approval','awaiting_input'].includes(phase), useAgentStore,
    startAgentLoopRun: vi.fn().mockResolvedValue({ runId: 'run-a', runGoalId: null }), connect: vi.fn(), onNewSession: vi.fn(),
    AgentApiError: class extends Error {}, setQuotaDialogOpen: vi.fn(), refetchCredits: vi.fn(), ...overrides,
  }
  const send = loadCallback('handleSend', context) as (prompt: string, attachments: [], freedom: string, quality: string, skills: []) => Promise<void>
  return { context, send: () => send('合成请求', [], 'balanced', 'premium', []) }
}
it('requests a completion suggestion for a manual prompt but never chains a Tab-accepted prompt', async () => {
  const manual = sending()
  await manual.send()
  expect(manual.context.startAgentLoopRun).toHaveBeenCalledWith(expect.objectContaining({ predictNextPrompt: true }))

  useAgentStore.getState().resetRun()
  useAgentStore.setState({ composerAcceptedNextPrompt: '合成请求' })
  try {
    const accepted = sending()
    await accepted.send()
    expect(accepted.context.startAgentLoopRun).toHaveBeenCalledOnce()
    expect(accepted.context.startAgentLoopRun.mock.calls[0]?.[0]).not.toHaveProperty('predictNextPrompt')
  } finally {
    useAgentStore.setState({ composerAcceptedNextPrompt: null })
  }
})

it('keeps the suggestion separate from chat and clears it for a new or failed run', () => {
  const store = useAgentStore.getState()
  const usage = { promptTokens: 2, completionTokens: 3, totalTokens: 5 }
  store.beginRun('first', '合成请求', 'session-a')
  store.applyEvent({ type: 'run.finished', runId: 'first', seq: 1, ts: '2026-11-11T00:00:00.000Z', status: 'succeeded', usage, artifacts: [],
    outputSummary: '已完成。', nextPrompt: '先润色开头。' })
  expect(useAgentStore.getState().nextPrompt).toEqual({ runId: 'first', text: '先润色开头。' })
  expect(JSON.stringify(useAgentStore.getState().messages)).not.toContain('先润色开头。')

  store.beginRun('second', '另一条请求', 'session-a')
  expect(useAgentStore.getState().nextPrompt).toBeNull()
  store.applyEvent({ type: 'run.finished', runId: 'second', seq: 1, ts: '2026-11-11T00:00:01.000Z', status: 'failed', usage, artifacts: [],
    outputSummary: '未完成。', nextPrompt: '不要显示。' })
  expect(useAgentStore.getState().nextPrompt).toBeNull()
})

it.each([null, 'chapter-a'])('only sends a manuscript selection with a chapter target (%s)', async chapterId => {
  const selection = { start: 2, end: 4, text: '选文' }
  const { context, send } = sending({ chapterId, selection })

  await send()

  expect(context.startAgentLoopRun).toHaveBeenCalledWith(expect.objectContaining({
    chapterId,
    prompt: '合成请求',
    selection: chapterId ? selection : null,
  }))
})

it('drops the selection when a deleted chapter is retried without a target', async () => {
  class ApiError extends Error {
    status = 404
    code = 'CHAPTER_NOT_FOUND'
  }
  const selection = { start: 2, end: 4, text: '选文' }
  const startAgentLoopRun = vi.fn().mockRejectedValueOnce(new ApiError()).mockResolvedValueOnce({ runId: 'run-a', runGoalId: null })
  const { send } = sending({ chapterId: 'chapter-a', selection, AgentApiError: ApiError, startAgentLoopRun })

  await send()

  expect(startAgentLoopRun).toHaveBeenNthCalledWith(1, expect.objectContaining({ chapterId: 'chapter-a', selection }))
  expect(startAgentLoopRun).toHaveBeenNthCalledWith(2, expect.objectContaining({ chapterId: null, selection: null }))
})

it('keeps preparation uncounted before configuration, ensureSession and HTTP, retaining its original task ownership', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-05T00:00:00Z'))
  const ready = deferred<void>(), ensured = deferred<string>(), admitted = deferred<{ runId: string; runGoalId: null }>()
  const { context, send } = sending({ windowConfiguration: { ready: () => ready.promise, promote: vi.fn() }, ensureSession: () => ensured.promise, startAgentLoopRun: () => admitted.promise })
  const request = send()
  const elapsed = (sessionId: string | null = null) => {
    const state = useOutgoingMessages.getState()
    const row = projectOutgoingMessages([], state.items, 'u:a:local-task', 'a', sessionId, state.requestClocks)[0]
    return runElapsedMs(row.requestTiming!, Date.now())
  }
  expect(elapsed()).toBeNull()
  vi.advanceTimersByTime(2000); expect(elapsed()).toBeNull()
  ready.resolve(); await Promise.resolve(); await Promise.resolve()
  vi.advanceTimersByTime(3000); expect(elapsed()).toBeNull()
  ensured.resolve('session-a'); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  vi.advanceTimersByTime(4000); expect(elapsed('session-a')).toBeNull()
  context.viewScope.current = 'u:b:other'; context.viewSession.current = 'session-b'
  admitted.resolve({ runId: 'run-a', runGoalId: null }); await request
  expect(context.connect).not.toHaveBeenCalled()
  expect(projectOutgoingMessages([], useOutgoingMessages.getState().items, 'u:b:other', 'b', 'session-b', useOutgoingMessages.getState().requestClocks)).toEqual([])
  expect(elapsed('session-a')).toBeNull()
})

it.each([false, true])('starts on actual response, preserves private activity=%s, excludes pauses and freezes without a final jump', privateMarker => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-05T00:00:00Z'))
  const id = useOutgoingMessages.getState().add('scope', 'a', 's', '合成请求', [])
  const clientRequestId = useOutgoingMessages.getState().items[0].clientRequestId
  useOutgoingMessages.getState().update(id, { runId: 'A', status: 'sent' })
  observeInitialStart('A', id)
  const apply = useAgentStore.getState().applyEvent
  apply({ type: 'message.start', runId: 'A', messageId: 'assistant', seq: 8, ts: '2026-11-05T00:00:05Z', role: 'assistant' })
  const user = { ...row('user', 'A', 'user'), clientRequestId }
  let assistant: AgentUIMessage = { ...row('assistant', 'A'), runTiming: { elapsedMs: 0, activeSince: '2026-11-05T00:00:05Z', status: 'running', lastSeq: 1 } }
  const observe = () => {
    useOutgoingMessages.getState().reconcile([user, assistant], 'scope', 'a', 's')
    const state = useOutgoingMessages.getState()
    return projectOutgoingMessages([user, assistant], state.items, 'scope', 'a', 's', state.requestClocks)[1].runTiming!
  }
  vi.setSystemTime(new Date('2026-11-05T00:00:10Z'))
  // An empty assistant/start is admission, not the model's first response.
  assistant = { ...assistant, parts: [] }
  expect(runElapsedMs(observe(), Date.now())).toBeNull()
  apply({ type: 'reasoning.delta', runId: 'A', messageId: 'assistant', seq: 9, ts: '2026-11-05T00:00:09Z', delta: privateMarker ? '' : '开始分析', ...(privateMarker ? { activity: true as const } : {}) })
  expect(runElapsedMs(observe(), Date.now())).toBe(0)
  vi.advanceTimersByTime(3000)
  expect(runElapsedMs(observe(), Date.now())).toBe(3000)
  expect(useOutgoingMessages.getState().items).toEqual([])
  apply({ type: 'run.paused', runId: 'A', seq: 10, ts: '2026-11-05T00:00:12Z', reason: 'user_stop' })
  assistant = { ...assistant, runTiming: { elapsedMs: 8000, activeSince: null, status: 'paused', lastSeq: 10 } }
  expect(runElapsedMs(observe(), Date.now())).toBe(3000)
  vi.advanceTimersByTime(20000)
  expect(runElapsedMs(observe(), Date.now())).toBe(3000)
  useAgentStore.getState().resumeRun('A', 's', null, 10)
  apply({ type: 'run.started', runId: 'A', seq: 11, ts: new Date().toISOString(), mode: 'build', title: '继续', agent: { type: 'novelist', title: '助手', model: 'speed' } })
  assistant = { ...assistant, runTiming: { elapsedMs: 8000, activeSince: new Date().toISOString(), status: 'running', lastSeq: 11 } }
  vi.advanceTimersByTime(2000)
  expect(runElapsedMs(observe(), Date.now())).toBe(5000)
  apply({ type: 'run.finished', runId: 'A', seq: 12, ts: new Date().toISOString(), status: 'succeeded' })
  assistant = { ...assistant, runTiming: { elapsedMs: 10000, activeSince: null, status: 'finished', lastSeq: 12 } }
  const finished = observe()
  vi.advanceTimersByTime(30000)
  expect(runElapsedMs(finished, Date.now())).toBe(5000)
  expect(runElapsedMs(observe(), Date.now())).toBe(5000)
  expect(assistant.runTiming?.elapsedMs).toBe(10000)
  const unknown: AgentUIMessage = { ...row('old', 'old-run'), runTiming: { elapsedMs: null, activeSince: null, status: 'unknown', lastSeq: 0 } }
  expect(projectOutgoingMessages([unknown], [], 'scope', 'a', 's', useOutgoingMessages.getState().requestClocks)[0]).toBe(unknown)
})

it('keeps unobserved response time unknown when finished history beats an unknown HTTP failure', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-05T00:00:00Z'))
  const failed = deferred<{ runId: string; runGoalId: null }>()
  const { send } = sending({ sessionId: 'session-a', viewSession: { current: 'session-a' }, startAgentLoopRun: () => failed.promise })
  const request = send(); await Promise.resolve(); await Promise.resolve()
  const item = useOutgoingMessages.getState().items[0]
  const history: AgentUIMessage[] = [{ ...row('user', 'A', 'user'), clientRequestId: item.clientRequestId }, {
    ...row('answer', 'A'), completedAt: '2026-11-05T00:00:05Z', runTiming: { elapsedMs: 4000, activeSince: null, status: 'finished', lastSeq: 3 },
  }]
  useAgentStore.getState().restoreMessages(history, 'session-a')
  vi.advanceTimersByTime(20000)
  failed.reject(new Error('HTTP未知')); await expect(request).resolves.toBeUndefined()
  const state = useOutgoingMessages.getState()
  const projected = projectOutgoingMessages(history, state.items, 'u:a:local-task', 'a', 'session-a', state.requestClocks)
  expect(projected).toHaveLength(2)
  expect(state.items).toEqual([])
  expect(runElapsedMs(projected[1].runTiming!, Date.now())).toBeNull()
})
it('retains history time once across an explicitly shared durable timing scope and its new execution run', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-05T00:00:00Z'))
  const id = useOutgoingMessages.getState().add('scope', 'a', 's', '合成请求', [])
  const clientRequestId = useOutgoingMessages.getState().items[0].clientRequestId
  const user = { ...row('user', 'A', 'user'), clientRequestId }
  const original: AgentUIMessage = { ...row('first', 'A'), runTiming: { scopeId: 'task', sourceRunId: 'A', elapsedMs: 0, activeSince: '2026-11-05T00:00:05Z', status: 'running', lastSeq: 1 } }
  useOutgoingMessages.getState().update(id, { runId: 'A', status: 'sent' })
  observeInitialStart('A', id)
  vi.setSystemTime(new Date('2026-11-05T00:00:09Z'))
  const output = { type: 'text.delta' as const, runId: 'A', messageId: 'first', seq: 8, ts: new Date().toISOString(), delta: '模型响应' }
  useAgentStore.getState().applyEvent(output)
  useOutgoingMessages.getState().reconcile([user, original], 'scope', 'a', 's')
  vi.advanceTimersByTime(4000)
  useOutgoingMessages.getState().observeEvent({ type: 'run.paused', runId: 'A', seq: 9, ts: new Date().toISOString(), reason: 'user_stop' })
  const paused: AgentUIMessage = { ...original, runTiming: { ...original.runTiming!, elapsedMs: 8000, activeSince: null, status: 'paused', lastSeq: 9 } }
  useOutgoingMessages.getState().reconcile([user, paused], 'scope', 'a', 's')
  const resumed: AgentUIMessage = { ...row('continued', 'B'), runTiming: { scopeId: 'task', sourceRunId: 'B', elapsedMs: 4000, activeSince: '2026-11-05T00:00:30Z', status: 'running', lastSeq: 3 } }
  vi.setSystemTime(new Date('2026-11-05T00:00:30Z'))
  useOutgoingMessages.getState().reconcile([user, paused, resumed], 'scope', 'a', 's')
  vi.advanceTimersByTime(2000)
  const state = useOutgoingMessages.getState()
  const projected = projectOutgoingMessages([user, paused, resumed], state.items, 'scope', 'a', 's', state.requestClocks)
  const { blockInfoById } = projectMessages(projected)
  const timing = projectBlockTimings(projected, blockInfoById, 'B').get('first')!
  expect(runElapsedMs(timing, Date.now())).toBe(6000)
  expect(projected[1].runTiming?.sourceRunId).toBe('B')
  expect(projected[2].runTiming).toEqual(projected[1].runTiming)
  useAgentStore.getState().resumeRun('B', 's', null, 3)
  useAgentStore.getState().applyEvent({ ...output, runId: 'B', messageId: 'continued', seq: 4, ts: new Date().toISOString() })
  const before = useOutgoingMessages.getState().requestClocks[0]
  vi.advanceTimersByTime(1000)
  useOutgoingMessages.getState().reconcile([user, paused], 'scope', 'a', 's')
  expect(useOutgoingMessages.getState().requestClocks[0]).toBe(before)
  const unscopedOld: AgentUIMessage = { ...paused, runTiming: { elapsedMs: 8000, activeSince: null, status: 'paused', lastSeq: 100 } }
  useOutgoingMessages.getState().reconcile([user, unscopedOld], 'scope', 'a', 's')
  expect(useOutgoingMessages.getState().requestClocks[0]).toBe(before)
  expect(runElapsedMs(before.timing, Date.now())).toBe(7000)
})

it('starts at the first observed history output after a long preparation instead of backfilling server admission time', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-05T00:00:00Z'))
  const id = useOutgoingMessages.getState().add('scope', 'a', 's', '合成请求', [])
  const clientRequestId = useOutgoingMessages.getState().items[0].clientRequestId
  useOutgoingMessages.getState().update(id, { runId: 'A', status: 'sent' })
  const history: AgentUIMessage[] = [{ ...row('user', 'A', 'user'), clientRequestId }, {
    ...row('answer', 'A'), runTiming: { elapsedMs: 0, activeSince: '2026-11-05T00:00:05Z', status: 'running', lastSeq: 8 },
  }]
  vi.advanceTimersByTime(61000)
  useOutgoingMessages.getState().reconcile(history, 'scope', 'a', 's')
  let clock = useOutgoingMessages.getState().requestClocks[0]
  expect(runElapsedMs(clock.timing, Date.now())).toBe(0)
  vi.advanceTimersByTime(2000)
  useOutgoingMessages.getState().reconcile(history, 'scope', 'a', 's')
  clock = useOutgoingMessages.getState().requestClocks[0]
  expect(runElapsedMs(clock.timing, Date.now())).toBe(2000)
  expect(history[1].runTiming!.activeSince).toBe('2026-11-05T00:00:05Z')
})

it.each(['paused', 'finished'] as const)('rejects old running history after first observing a %s response with unknown duration', status => {
  const id = useOutgoingMessages.getState().add('scope', 'a', 's', '合成请求', [])
  const clientRequestId = useOutgoingMessages.getState().items[0].clientRequestId
  useOutgoingMessages.getState().update(id, { runId: 'A', status: 'sent' })
  const user = { ...row('user', 'A', 'user'), clientRequestId }
  const assistant: AgentUIMessage = { ...row('answer', 'A'), runTiming: { status, elapsedMs: 10000, activeSince: null, lastSeq: 12 } }
  useOutgoingMessages.getState().reconcile([user, assistant], 'scope', 'a', 's')
  const before = useOutgoingMessages.getState().requestClocks[0]
  for (const lastSeq of [5, 12]) {
    useOutgoingMessages.getState().reconcile([user, { ...assistant, runTiming: { status: 'running', elapsedMs: 0, activeSince: new Date().toISOString(), lastSeq } }], 'scope', 'a', 's')
    expect(useOutgoingMessages.getState().requestClocks[0]).toBe(before)
  }
  expect(before.responded).toBe(false)
  expect(before.timing.status).toBe(status)
  expect(before.timing.elapsedMs).toBeNull()
})

it('resumes a confirmed new execution after failure without losing observed response time or counting the stopped gap', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-05T00:00:00Z'))
  const id = useOutgoingMessages.getState().add('scope', 'a', 's', '合成请求', [])
  const clientRequestId = useOutgoingMessages.getState().items[0].clientRequestId
  useOutgoingMessages.getState().update(id, { runId: 'A', status: 'sent' })
  observeInitialStart('A', id)
  const user = { ...row('user', 'A', 'user'), clientRequestId }
  useOutgoingMessages.getState().observeEvent({ type: 'text.delta', runId: 'A', messageId: 'first', seq: 8, ts: new Date().toISOString(), delta: '实际响应' })
  vi.advanceTimersByTime(4000)
  useOutgoingMessages.getState().observeEvent({ type: 'error', runId: 'A', seq: 9, ts: new Date().toISOString(), code: 'TEST_STOP', message: '合成中断', recoverable: false })
  const original: AgentUIMessage = { ...row('first', 'A'), runTiming: { scopeId: 'task', sourceRunId: 'A', elapsedMs: 4000, activeSince: null, status: 'finished', lastSeq: 9 } }
  useOutgoingMessages.getState().reconcile([user, original], 'scope', 'a', 's')
  vi.advanceTimersByTime(20000)
  const resumed: AgentUIMessage = { ...row('continued', 'B'), runTiming: { scopeId: 'task', sourceRunId: 'B', elapsedMs: 4000, activeSince: new Date().toISOString(), status: 'running', lastSeq: 1 } }
  useOutgoingMessages.getState().reconcile([user, original, resumed], 'scope', 'a', 's')
  vi.advanceTimersByTime(2000)
  const clock = useOutgoingMessages.getState().requestClocks[0]
  expect(clock.timing.sourceRunId).toBe('B')
  expect(clock.timing.status).toBe('running')
  expect(runElapsedMs(clock.timing, Date.now())).toBe(6000)
})
it.each([
  ['paused', 4000, null, null],
  ['finished', 6000, null, null],
  ['running', 4000, '2026-11-05T00:00:30Z', 0],
  ['running', 0, '2026-11-05T00:00:30Z', 0],
  ['finished', null, null, null],
] as const)('does not infer original submit latency from a first-seen %s snapshot with %s prior activity', (status, elapsedMs, activeSince, expected) => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-05T00:00:00Z'))
  const id = useOutgoingMessages.getState().add('scope', 'a', 's', '合成请求', [])
  const clientRequestId = useOutgoingMessages.getState().items[0].clientRequestId
  useOutgoingMessages.getState().update(id, { runId: 'A', status: 'sent' })
  const history: AgentUIMessage[] = [{ ...row('user', 'A', 'user'), clientRequestId }, {
    ...row('answer', 'A'), runTiming: { scopeId: 'task', sourceRunId: 'A', status, elapsedMs, activeSince, lastSeq: 12 },
    ...(status === 'finished' ? { completedAt: '2026-11-05T00:00:32Z' } : {}),
  }]
  vi.setSystemTime(new Date('2026-11-05T00:00:32Z'))
  useOutgoingMessages.getState().reconcile(history, 'scope', 'a', 's')
  const state = useOutgoingMessages.getState()
  expect(state.requestClocks[0].eventOffsetMs).toBeNull()
  const projected = projectOutgoingMessages(history, state.items, 'scope', 'a', 's', state.requestClocks)
  expect(runElapsedMs(projected[1].runTiming!, Date.now())).toBe(expected)
  expect(projected[1].runTiming?.status).toBe(status)
})

it('does not invent response time from original or continued start metadata alone', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-05T00:00:00Z'))
  const id = useOutgoingMessages.getState().add('scope', 'a', 's', '合成请求', [])
  const clientRequestId = useOutgoingMessages.getState().items[0].clientRequestId
  useOutgoingMessages.getState().update(id, { runId: 'A', status: 'sent' })
  observeInitialStart('A', id)
  const history: AgentUIMessage[] = [{ ...row('user', 'A', 'user'), clientRequestId }, {
    ...row('answer', 'A'), runTiming: { elapsedMs: 6000, activeSince: null, status: 'finished', lastSeq: 12 }, completedAt: '2026-11-05T00:00:32Z',
  }]
  vi.setSystemTime(new Date('2026-11-05T00:00:32Z'))
  useOutgoingMessages.getState().reconcile(history, 'scope', 'a', 's')
  let state = useOutgoingMessages.getState()
  expect(runElapsedMs(projectOutgoingMessages(history, state.items, 'scope', 'a', 's', state.requestClocks)[1].runTiming!, Date.parse('2026-11-05T00:00:32Z'))).toBeNull()
  useAgentStore.getState().resumeRun('A', 's', null, 10)
  useAgentStore.getState().applyEvent({ type: 'run.started', runId: 'A', seq: 11, ts: '2026-11-05T00:00:30Z', mode: 'build', title: '继续合成任务', agent: { type: 'novelist', title: '合成助手', model: 'speed' } })
  state = useOutgoingMessages.getState()
  expect(state.requestClocks[0].timing.elapsedMs).toBeNull()
})
it('shows the outgoing request before configuration/session admission resolves and replaces it once on success', async () => {
  const ready = deferred<void>()
  const { context, send } = sending({ windowConfiguration: { ready: () => ready.promise, promote: vi.fn() } })
  const request = send()
  expect(context.ensureSession).not.toHaveBeenCalled()
  let projected = projectOutgoingMessages([], useOutgoingMessages.getState().items, 'u:a:local-task', 'a', null)
  expect(projected).toHaveLength(1)
  expect(projected[0].parts).toEqual([{ type: 'text', text: '合成请求' }])
  expect(projected[0].delivery?.status).toBe('sending')
  const id = projected[0].id
  ready.resolve(); await request
  projected = projectOutgoingMessages(useAgentStore.getState().messages, useOutgoingMessages.getState().items, 'u:a:session-a', 'a', 'session-a')
  expect(projected).toHaveLength(1)
  expect(projected[0].id).toBe(id)
  expect(projected[0].delivery).toBeUndefined()
  expect(context.startAgentLoopRun).toHaveBeenCalledOnce()
})
it('keeps a failed request visibly scoped without an automatic retry or clearing its text', async () => {
  const { context, send } = sending({ startAgentLoopRun: vi.fn().mockRejectedValue(new Error('网络结果未确认')) })
  await expect(send()).rejects.toThrow('网络结果未确认')
  const item = useOutgoingMessages.getState().items[0]
  expect(item.status).toBe('failed')
  expect(item.message.parts).toEqual([{ type: 'text', text: '合成请求' }])
  expect(item.error).toBe('网络结果未确认')
  expect(context.startAgentLoopRun).toHaveBeenCalledOnce()
  expect(projectOutgoingMessages([], [item], 'u:b:other', 'b', null)).toEqual([])
})
it('retains a late successful admission for its original task and deduplicates after history arrives', async () => {
  const admitted = deferred<{ runId: string; runGoalId: null }>()
  const { context, send } = sending({ startAgentLoopRun: () => admitted.promise })
  const request = send()
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  context.viewScope.current = 'u:b:other'; context.viewSession.current = 'session-b'
  admitted.resolve({ runId: 'run-a', runGoalId: null }); await request
  expect(context.connect).not.toHaveBeenCalled()
  expect(useAgentStore.getState().messages).toHaveLength(0)
  const items = useOutgoingMessages.getState().items
  expect(projectOutgoingMessages([], items, 'u:b:other', 'b', 'session-b')).toHaveLength(0)
  const returned = projectOutgoingMessages([], items, 'u:a:session-a', 'a', 'session-a')
  expect(returned).toHaveLength(1)
  expect(returned[0].delivery?.status).toBe('sent')
  const history: AgentUIMessage = { ...returned[0], id: 'server-message', runId: 'run-a', role: 'user' }
  expect(projectOutgoingMessages([history], items, 'u:a:session-a', 'a', 'session-a')).toHaveLength(1)
})
it('does not reset a run or duplicate the request if live events precede the HTTP receipt', () => {
  useAgentStore.getState().beginRun('run-a', '合成请求', 'session-a')
  useAgentStore.setState({ phase: 'running', lastSeq: 8, currentTurn: 3, messages: [...useAgentStore.getState().messages, { id: 'assistant', runId: 'run-a', role: 'assistant', createdAt: '', parts: [{ type: 'text', text: '已接收的输出' }] }] })
  useAgentStore.getState().beginRun('run-a', '合成请求', 'session-a', [], null, 'local-outgoing-later')
  const state = useAgentStore.getState()
  expect(state.messages.filter(message => message.role === 'user')).toHaveLength(1)
  expect(state.messages.at(-1)?.parts).toEqual([{ type: 'text', text: '已接收的输出' }])
  expect(state.phase).toBe('running'); expect(state.lastSeq).toBe(8); expect(state.currentTurn).toBe(3)
})


it.each(['running', 'succeeded'] as const)('inserts an acknowledged user request after older history and before its first %s run message', phase => {
  const older: AgentUIMessage = { id: 'older', runId: 'old-run', role: 'assistant', createdAt: '', parts: [{ type: 'text', text: '已有历史' }] }
  const current: AgentUIMessage = { id: 'current', runId: 'run-a', role: 'assistant', createdAt: '', parts: [{ type: 'text', text: '先到的实时输出' }] }
  useAgentStore.setState({ runId: 'run-a', phase, activeSessionId: 'session-a', loadedSessionId: 'session-a', lastSeq: 9, messages: [older, current] })
  useAgentStore.getState().beginRun('run-a', '合成请求', 'session-a', [], null, 'local-outgoing-receipt')
  expect(useAgentStore.getState().messages.map(message => message.id)).toEqual(['older', 'local-outgoing-receipt', 'current'])
  expect(useAgentStore.getState().phase).toBe(phase)
  expect(useAgentStore.getState().lastSeq).toBe(9)
  useAgentStore.getState().beginRun('run-a', '合成请求', 'session-a', [], null, 'local-outgoing-receipt')
  expect(useAgentStore.getState().messages).toHaveLength(3)
})


const row = (id: string, runId: string, role: 'user' | 'assistant' = 'assistant'): AgentUIMessage => ({ id, runId, role, createdAt: '1900-01-01T00:00:00Z', parts: [{ type: 'text', text: id }] })
it('keeps failed A in its send position before a later successful B and reply, regardless of clocks', () => {
  const history = row('history', 'old')
  const store = useOutgoingMessages.getState()
  const a = store.add('scope', 'a', 's', 'A', [], { messageId: history.id, runId: history.runId })
  store.update(a, { status: 'failed', error: '未确认' })
  const b = store.add('scope', 'a', 's', 'B', [], { messageId: history.id, runId: history.runId })
  store.update(b, { status: 'sent', runId: 'B' })
  const canonical = [history, row('server-B', 'B', 'user'), row('reply-B', 'B')]
  const projected = projectOutgoingMessages(canonical, useOutgoingMessages.getState().items, 'scope', 'a', 's')
  expect(projected.map(message => message.id)).toEqual(['history', a, 'server-B', 'reply-B'])
  expect(projected[1].delivery?.status).toBe('failed')
})
it('anchors a pending request before history or SSE that arrives ahead of its HTTP receipt', () => {
  const history = row('history', 'old')
  const id = useOutgoingMessages.getState().add('scope', 'a', 's', 'A', [], { messageId: history.id, runId: history.runId })
  const canonical = [history, row('assistant-A', 'A')]
  const projected = projectOutgoingMessages(canonical, useOutgoingMessages.getState().items, 'scope', 'a', 's')
  expect(projected.map(message => message.id)).toEqual(['history', id, 'assistant-A'])
  useOutgoingMessages.getState().update(id, { runId: 'A', status: 'sent' })
  expect(projectOutgoingMessages(canonical, useOutgoingMessages.getState().items, 'scope', 'a', 's').map(message => message.id)).toEqual(['history', id, 'assistant-A'])
})
it('keeps consecutive local requests in send order with a shared canonical anchor', () => {
  const history = row('history', 'old')
  const a = useOutgoingMessages.getState().add('scope', 'a', 's', 'A', [], { messageId: history.id, runId: history.runId })
  useOutgoingMessages.getState().update(a, { status: 'failed' })
  const b = useOutgoingMessages.getState().add('scope', 'a', 's', 'B', [], { messageId: history.id, runId: history.runId })
  expect(projectOutgoingMessages([history], useOutgoingMessages.getState().items, 'scope', 'a', 's').map(message => message.id)).toEqual(['history', a, b])
})
it('does not resurrect a restored terminal A when its HTTP receipt arrives later', () => {
  const history = [row('A-user', 'A', 'user'), { ...row('A-answer', 'A'), completedAt: '2026-11-05T00:01:00Z' }]
  useAgentStore.getState().restoreMessages(history, 's')
  const before = useAgentStore.getState()
  useAgentStore.getState().beginRun('A', 'A-user', 's', [], null, 'local-A', null)
  const after = useAgentStore.getState()
  expect(after.runId).toBeNull(); expect(after.phase).toBe('idle')
  expect(after.messages).toBe(before.messages)
})
it('keeps an actually active canonical A connectable instead of treating its user message as terminal', () => {
  const history = [row('A-user', 'A', 'user'), { ...row('A-tool', 'A'), parts: [{ type: 'tool-call' as const, callId: 'call', toolName: 'chapter_read', title: '读取章节', status: 'running' as const }], runTiming: { elapsedMs: 0, activeSince: '2026-11-05T00:00:00Z', status: 'running' as const, lastSeq: 2 } }]
  useAgentStore.getState().restoreMessages(history, 's')
  useAgentStore.getState().beginRun('A', 'A-user', 's', [], null, 'local-A', 'previous-terminal')
  const state = useAgentStore.getState()
  expect(state.runId).toBe('A'); expect(state.phase).toBe('starting')
  expect(state.messages.map(message => message.id)).toEqual(['A-user', 'A-tool'])
  expect(state.messages[1].parts[0]).toMatchObject({ status: 'running' })
})
it('does not replace resumed B state or its received text with an old A admission', () => {
  useAgentStore.getState().restoreMessages([row('A-user', 'A', 'user'), { ...row('A-answer', 'A'), completedAt: '2026-11-05T00:01:00Z' }], 's')
  useAgentStore.getState().resumeRun('B', 's')
  useAgentStore.setState({ phase: 'running', lastSeq: 7, currentTurn: 2, messages: [...useAgentStore.getState().messages, row('B-answer', 'B')] })
  const before = useAgentStore.getState()
  useAgentStore.getState().beginRun('A', 'A-user', 's', [], null, 'local-A', null)
  const after = useAgentStore.getState()
  expect(after.runId).toBe('B'); expect(after.phase).toBe('running')
  expect(after.lastSeq).toBe(7); expect(after.currentTurn).toBe(2)
  expect(after.messages).toBe(before.messages)
})
it.each(['terminal-A', 'newer-B', 'active-A'] as const)('only connects the still-current active admission after %s was observed before the HTTP receipt', async mode => {
  const admitted = deferred<{ runId: string; runGoalId: null }>()
  const { context, send } = sending({ sessionId: 'session-a', viewSession: { current: 'session-a' }, startAgentLoopRun: () => admitted.promise })
  const request = send()
  await Promise.resolve(); await Promise.resolve()
  const user = row('A-user', 'run-a', 'user')
  const answer = mode === 'active-A' ? { ...row('A-answer', 'run-a'), runTiming: { elapsedMs: 0, activeSince: '2026-11-05T00:00:00Z', status: 'running' as const, lastSeq: 1 } }
    : { ...row('A-answer', 'run-a'), completedAt: '2026-11-05T00:01:00Z' }
  useAgentStore.getState().restoreMessages([user, answer], 'session-a')
  if (mode === 'newer-B') { useAgentStore.getState().resumeRun('B', 'session-a'); useAgentStore.setState({ phase: 'running', lastSeq: 12 }) }
  admitted.resolve({ runId: 'run-a', runGoalId: null }); await request
  if (mode === 'active-A') {
    expect(context.connect).toHaveBeenCalledExactlyOnceWith('run-a')
    expect(useAgentStore.getState().runId).toBe('run-a')
  } else {
    expect(context.connect).not.toHaveBeenCalled()
    expect(useAgentStore.getState().runId).toBe(mode === 'newer-B' ? 'B' : null)
  }
  expect(useAgentStore.getState().messages.filter(message => message.role === 'user' && message.runId === 'run-a')).toHaveLength(1)
})


it('reconciles a complete server transcript before HTTP knows the run id, including a failed local delivery', () => {
  const id = useOutgoingMessages.getState().add('scope', 'a', 's', '同文请求', [])
  const item = useOutgoingMessages.getState().items[0]
  const canonical = [{ ...row('server-user', 'server-run', 'user'), clientRequestId: item.clientRequestId }, row('server-answer', 'server-run')]
  expect(projectOutgoingMessages(canonical, [item], 'scope', 'a', 's').map(message => message.id)).toEqual(['server-user', 'server-answer'])
  useOutgoingMessages.getState().update(id, { status: 'failed', error: 'HTTP未确认' })
  useOutgoingMessages.getState().reconcile(canonical, 'scope', 'a', 's')
  expect(useOutgoingMessages.getState().items).toEqual([])
})
it('does not guess equal prompt text or consume a different request id', () => {
  const first = useOutgoingMessages.getState().add('scope', 'a', 's', '同文请求', [])
  const second = useOutgoingMessages.getState().add('scope', 'a', 's', '同文请求', [])
  const [a, b] = useOutgoingMessages.getState().items
  expect(a.clientRequestId).not.toBe(b.clientRequestId)
  const canonical = [{ ...row('server-user-a', 'run-a', 'user'), clientRequestId: a.clientRequestId, parts: [{ type: 'text' as const, text: '同文请求' }] }, row('answer-a', 'run-a')]
  const projected = projectOutgoingMessages(canonical, [a,b], 'scope', 'a', 's')
  expect(projected.filter(message => message.role === 'user').map(message => message.id)).toEqual(['server-user-a', second])
  useOutgoingMessages.getState().reconcile(canonical, 'scope', 'a', 's')
  expect(useOutgoingMessages.getState().items.map(item => item.id)).toEqual([second])
  expect(first).not.toBe(second)
})
it('requires the owning task scope even if another task reuses the same display id', () => {
  const marker = 'c92a0a12-3af7-4e28-bd14-22ec51f7834c'
  const first = useOutgoingMessages.getState().add('scope-a', 'a', 'session-a', 'A', [], undefined, marker)
  const second = useOutgoingMessages.getState().add('scope-b', 'a', 'session-b', 'B', [], undefined, marker)
  const canonical = [{ ...row('server-a', 'run-a', 'user'), clientRequestId: marker }]
  useOutgoingMessages.getState().reconcile(canonical, 'scope-a', 'a', 'session-a')
  expect(useOutgoingMessages.getState().items).toHaveLength(1)
  expect(useOutgoingMessages.getState().items[0].scope).toBe('scope-b')
  expect(projectOutgoingMessages([], useOutgoingMessages.getState().items, 'scope-b', 'a', 'session-b')[0].id).toBe(second)
  // The display correlation is never reused as the local message identity.
  expect(first).not.toBe(second)
})
it('sends one UUID and accepts its observed canonical admission when HTTP later fails without replaying', async () => {
  const failed = deferred<{ runId: string; runGoalId: null }>()
  const start = vi.fn().mockImplementation(() => failed.promise)
  const { context, send } = sending({ sessionId: 'session-a', viewSession: { current: 'session-a' }, startAgentLoopRun: start })
  const request = send()
  await Promise.resolve(); await Promise.resolve()
  const outgoing = useOutgoingMessages.getState().items[0]
  expect(start).toHaveBeenCalledOnce()
  expect(start.mock.calls[0][0].clientRequestId).toBe(outgoing.clientRequestId)
  useAgentStore.getState().restoreMessages([{ ...row('server-user', 'run-a', 'user'), clientRequestId: outgoing.clientRequestId }, { ...row('server-answer', 'run-a'), completedAt: '2026-11-05T00:01:00Z' }], 'session-a')
  failed.reject(new Error('HTTP连接未确认'))
  await expect(request).resolves.toBeUndefined()
  expect(useOutgoingMessages.getState().items).toEqual([])
  expect(context.setActionError).not.toHaveBeenCalledWith('HTTP连接未确认')
  expect(context.setActionNotice).toHaveBeenCalledWith('请求已由服务端接纳。')
  expect(context.connect).not.toHaveBeenCalled()
  expect(start).toHaveBeenCalledOnce()
})
it('uses original-session history evidence for a late HTTP failure without touching the newly viewed task', async () => {
  const failed = deferred<{ runId: string; runGoalId: null }>()
  const { context, send } = sending({ sessionId: 'session-a', viewSession: { current: 'session-a' }, startAgentLoopRun: () => failed.promise })
  const request = send(); await Promise.resolve(); await Promise.resolve()
  const item = useOutgoingMessages.getState().items[0]
  useAgentStore.getState().restoreMessages([{ ...row('server-user', 'run-a', 'user'), clientRequestId: item.clientRequestId }], 'session-a')
  useAgentStore.getState().resetRun()
  useAgentStore.getState().restoreMessages([row('B-user', 'B', 'user')], 'session-b')
  context.viewScope.current = 'u:b:new'; context.viewSession.current = 'session-b'
  context.setActionError.mockClear(); context.setActionNotice.mockClear()
  failed.reject(new Error('旧HTTP失败')); await expect(request).resolves.toBeUndefined()
  expect(useOutgoingMessages.getState().items).toEqual([])
  expect(useAgentStore.getState().messages[0].id).toBe('B-user')
  expect(context.setActionError).not.toHaveBeenCalled(); expect(context.setActionNotice).not.toHaveBeenCalled()
})


it('clears only the correlated delivery error when canonical history arrives after HTTP failure', async () => {
  const { context, send } = sending({ sessionId: 'session-a', viewSession: { current: 'session-a' }, startAgentLoopRun: vi.fn().mockRejectedValue(new Error('HTTP未确认')) })
  await expect(send()).rejects.toThrow('HTTP未确认')
  const item = useOutgoingMessages.getState().items[0]
  const canonical = [{ ...row('server-user', 'run-a', 'user'), clientRequestId: item.clientRequestId }, row('server-answer', 'run-a')]
  const reconcile = loadCallback('reconcileOutgoingDelivery', { ...context, storeLoadedSessionId: 'session-a', sessionId: 'session-a', canonicalMessages: canonical, actionError: 'HTTP未确认' })
  reconcile()
  expect(useOutgoingMessages.getState().items).toEqual([])
  expect(context.setActionError).toHaveBeenLastCalledWith(null)
  expect(context.setActionNotice).toHaveBeenCalledWith('请求已由服务端接纳。')
  expect(context.deliveryErrorRef.current).toBeNull()
})
it('does not erase a newer unrelated error while reconciling an older accepted delivery', async () => {
  const { context, send } = sending({ sessionId: 'session-a', viewSession: { current: 'session-a' }, startAgentLoopRun: vi.fn().mockRejectedValue(new Error('HTTP未确认')) })
  await expect(send()).rejects.toThrow('HTTP未确认')
  const item = useOutgoingMessages.getState().items[0]
  context.setActionError.mockClear(); context.setActionNotice.mockClear()
  loadCallback('reconcileOutgoingDelivery', { ...context, storeLoadedSessionId: 'session-a', sessionId: 'session-a', canonicalMessages: [{ ...row('server-user', 'run-a', 'user'), clientRequestId: item.clientRequestId }], actionError: '另一个设置保存失败' })()
  expect(useOutgoingMessages.getState().items).toEqual([])
  expect(context.setActionError).not.toHaveBeenCalled()
  expect(context.setActionNotice).not.toHaveBeenCalled()
})


it.each([false, true])('observes a responding restored run with legacy/private marker=%s at the same local instant', privateMarker => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-05T00:00:20Z'))
  const id = useOutgoingMessages.getState().add('scope', 'a', 's', '合成请求', [])
  const clientRequestId = useOutgoingMessages.getState().items[0].clientRequestId
  useOutgoingMessages.getState().update(id, { runId: 'A', status: 'sent' })
  observeInitialStart('A', id)
  const user: AgentUIMessage = { ...row('user', 'A', 'user'), clientRequestId }
  const assistant: AgentUIMessage = { ...row('assistant', 'A'), parts: [{ type: 'reasoning', text: privateMarker ? '' : '实际模型输出', ...(privateMarker ? { activity: true as const } : {}) }], runTiming: {
    elapsedMs: 10000, activeSince: '2026-11-05T00:00:05Z', status: 'running', lastSeq: 8,
  } }
  useOutgoingMessages.getState().reconcile([user, assistant], 'scope', 'a', 's')
  let clock = useOutgoingMessages.getState().requestClocks[0]
  expect(clock.responded).toBe(true)
  expect(clock.timing.activeSince).toBe('2026-11-05T00:00:20.000Z')
  expect(runElapsedMs(clock.timing, Date.now())).toBe(0)
  vi.advanceTimersByTime(3000)
  useOutgoingMessages.getState().reconcile([user, assistant], 'scope', 'a', 's')
  clock = useOutgoingMessages.getState().requestClocks[0]
  expect(runElapsedMs(clock.timing, Date.now())).toBe(3000)
})


it('keeps a restored blank episode without response activity in preparation', () => {
  const id = useOutgoingMessages.getState().add('scope', 'a', 's', '合成请求', [])
  const clientRequestId = useOutgoingMessages.getState().items[0].clientRequestId
  useOutgoingMessages.getState().update(id, { runId: 'A', status: 'sent' })
  observeInitialStart('A', id)
  const user: AgentUIMessage = { ...row('user', 'A', 'user'), clientRequestId }
  const assistant: AgentUIMessage = { ...row('assistant', 'A'), parts: [{ type: 'reasoning', text: '' }], runTiming: {
    elapsedMs: 10000, activeSince: '2026-11-05T00:00:05Z', status: 'running', lastSeq: 8,
  } }
  useOutgoingMessages.getState().reconcile([user, assistant], 'scope', 'a', 's')
  expect(useOutgoingMessages.getState().requestClocks[0]).toMatchObject({ responded: false, timing: { elapsedMs: null, activeSince: null } })
})
