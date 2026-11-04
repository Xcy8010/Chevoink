import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'
import { projectOutgoingMessages, useOutgoingMessages } from '../../src/features/studio/agent/outgoing-messages'
import { useAgentStore, readSessionMessagesCache } from '../../src/features/studio/agent/agentStore'
import type { AgentUIMessage } from '../../shared/contracts/index'

afterEach(() => { useOutgoingMessages.setState({ items: [] }); useAgentStore.getState().resetRun() })
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
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
