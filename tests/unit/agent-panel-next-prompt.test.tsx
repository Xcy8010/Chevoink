// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../src/components/ui/Toast'
import { AgentPanel } from '../../src/features/studio/agent/components/AgentPanel'
import { restoreActiveRunHistory, useAgentStore } from '../../src/features/studio/agent/agentStore'

const remote = vi.hoisted(() => ({ changed: undefined as undefined | ((id: string) => void) }))
vi.mock('../../src/features/studio/agent/useAgentGoalStream', () => {
  const connect = vi.fn(), disconnect = vi.fn()
  return { useAgentGoalStream: (_snapshot: unknown, changed: (id: string) => void) => { remote.changed = changed; return { connect, disconnect } } }
})

afterEach(() => {
  cleanup()
  useAgentStore.getState().resetRun()
  window.localStorage.clear()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('keeps the loaded timeline visible on the first render of a remote activity header', async () => {
  const sessionId = 'reader', runId = 'remote-turn'
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ success: true, data: null })))
  const row = (id: string) => ({ id, runId: id, role: 'user' as const, createdAt: '', parts: [{ type: 'text' as const, text: id }] })
  const history = [row('正在阅读的旧消息')]
  useAgentStore.getState().restoreMessages(history, sessionId)
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } })
  render(<QueryClientProvider client={client}><ToastProvider>
    <AgentPanel novelId="book" novelName="合成作品" sessionId={sessionId} ensureSession={async () => sessionId} />
  </ToastProvider></QueryClientProvider>)
  act(() => restoreActiveRunHistory([...history, row(runId)], runId, sessionId))
  expect(screen.queryByRole('status', { name: '正在载入对话' })).toBeNull()
  expect(screen.getByText('正在阅读的旧消息').closest('[style*="display: none"]')).toBeNull()
  await waitFor(() => expect(document.querySelector('[data-author-timer]')).toBeTruthy(), { timeout: 3000 })
  const apply = useAgentStore.getState().applyEvent
  const ts = new Date().toISOString(), messageId = 'opening'
  const sample = { type: 'context.usage' as const, seq: 3, ts, estimatedTokens: 205349, contextWindowTokens: 258000, compactAtTokens: 228000 }
  act(() => apply({ ...sample, runId }))
  expect(screen.queryByText(/已估算本轮上下文/)).toBeNull()
  act(() => apply({ type: 'message.start', runId, seq: 4, ts, role: 'assistant', messageId }))
  act(() => apply({ type: 'reasoning.delta', runId, seq: 5, ts, messageId, delta: 'PRIVATE_REASONING', activity: true }))
  expect(screen.queryByText(/模型思考中/)).toBeNull()
  expect(screen.queryByText('PRIVATE_REASONING')).toBeNull()
  act(() => apply({ type: 'text.delta', runId, seq: 6, ts, messageId, delta: '我先核对细纲。' }))
  await waitFor(() => expect(screen.getByText('我先核对细纲。')).toBeTruthy())
})

it('reoffers the current run suggestion after Tab acceptance and clearing the composer', () => {
  const sessionId = 'synthetic-session', novelId = 'synthetic-novel'
  const nextPrompt = { runId: 'synthetic-completed-run', text: '沿用这个场景继续写一章' }
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ success: true, data: null })))
  vi.stubGlobal('fetch', fetch)
  const queryClient = new QueryClient({ defaultOptions: { queries: { enabled: false } } })
  queryClient.setQueryData(['agent', 'model-assignments', `novel:${novelId}`], { effective: {} })
  queryClient.setQueryData(['agent', 'window-configuration', sessionId], { configuration: { creativeFreedom: 'balanced', model: null } })
  useAgentStore.getState().restoreMessages([], sessionId, null, nextPrompt)

  render(<QueryClientProvider client={queryClient}><ToastProvider>
    <AgentPanel novelId={novelId} novelName="合成作品" sessionId={sessionId} ensureSession={async () => sessionId} />
  </ToastProvider></QueryClientProvider>)
  const editor = screen.getByRole('textbox', { name: 'Agent 提示词' })
  const offer = () => screen.queryByRole('button', { name: '补全建议：' + nextPrompt.text })
  expect(offer()).toBeTruthy()
  editor.focus()
  expect(fireEvent.keyDown(editor, { key: 'Tab' })).toBe(false)
  expect(editor.textContent).toBe(nextPrompt.text)
  expect(offer()).toBeNull()

  editor.replaceChildren(document.createElement('br'))
  fireEvent.input(editor)
  expect(offer()).toBeTruthy()
  expect(fireEvent.keyDown(editor, { key: 'Tab' })).toBe(false)
  expect(editor.textContent).toBe(nextPrompt.text)
  expect(fetch.mock.calls.every(([, options]) => options?.method !== 'POST')).toBe(true)

  act(() => { useAgentStore.getState().restoreMessages([], 'another-session', null, { runId: 'another-run', text: '另一任务的建议' }) })
  editor.replaceChildren(document.createElement('br'))
  fireEvent.input(editor)
  expect(offer()).toBeNull()
  expect(screen.queryByRole('button', { name: '补全建议：另一任务的建议' })).toBeNull()
})

it('observes another device starting the open conversation once and preserves an unsent draft', async () => {
  const sessionId = 'remote-session', runId = 'remote-run', novelId = 'remote-book'
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const connections: string[] = []
  const streams: EventTarget[] = []
  vi.stubGlobal('EventSource', class extends EventTarget {
    constructor(url: string) { super(); connections.push(url); streams.push(this) }
    close() {}
  })
  const response = (data: unknown) => new Response(JSON.stringify({ success: true, data }))
  let latest: string | null = null
  let status = 'running'
  let revision = '0'
  const prompt = { id: 'remote-message', runId, role: 'user', createdAt: new Date().toISOString(), parts: [{ type: 'text', text: '手机上发来的需求' }] }
  let subsequentHistory: unknown
  let observerRead: Promise<Response> | null = null
  let releaseHistory!: (response: Response) => void
  const pending = new Promise<Response>(resolve => { releaseHistory = resolve })
  const fetch = vi.fn<typeof globalThis.fetch>(async resource => {
    const url = String(resource)
    if (url.endsWith('/queue')) return response({ latestRunId: latest, latestRunStatus: latest ? status : null, historyRevision: revision, items: [] })
    if (url.includes('/messages?runLimit=10')) return observerRead ?? (subsequentHistory ? response(subsequentHistory) : pending)
    return response(null)
  })
  vi.stubGlobal('fetch', fetch)
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } })
  useAgentStore.getState().restoreMessages([], sessionId)
  render(<QueryClientProvider client={client}><ToastProvider>
    <AgentPanel novelId={novelId} novelName="合成作品" sessionId={sessionId} ensureSession={async () => sessionId} />
  </ToastProvider></QueryClientProvider>)
  const editor = screen.getByRole('textbox', { name: 'Agent 提示词' })
  editor.textContent = '本机未发送的草稿'
  fireEvent.input(editor)
  await waitFor(() => expect(client.getQueryData(['agent-queue', sessionId])).toMatchObject({ items: [], latestRunId: null }))
  latest = runId
  act(() => remote.changed?.(sessionId))
  const historyReads = () => fetch.mock.calls.filter(([u]) => String(u).includes('/messages?runLimit=10')).length
  await waitFor(() => expect(historyReads()).toBe(1))
  await act(async () => { remote.changed?.(sessionId); await new Promise(resolve => setTimeout(resolve, 10)) })
  expect(historyReads()).toBe(1)
  await act(async () => releaseHistory(response({ activeRunId: runId, messages: [prompt] })))
  await waitFor(() => expect(connections.filter(url => url.includes(runId))).toHaveLength(1))
  expect(useAgentStore.getState().messages[0]?.parts).toEqual([{ type: 'text', text: '手机上发来的需求' }])
  expect(await screen.findByText('手机上发来的需求', {}, { timeout: 3000 })).toBeTruthy()
  const emit = (stream: EventTarget, type: string, data: Record<string, unknown>) =>
    stream.dispatchEvent(new MessageEvent(type, { data: JSON.stringify({ runId, type, ts: new Date().toISOString(), ...data }) }))
  const start = { agent: { title: '本轮', type: 'orchestrator', model: 'speed' }, mode: 'build' }
  act(() => emit(streams[0], 'run.started', { ...start, seq: 1 }))
  status = 'paused'
  revision = 'stale-pause'
  let settleObserver!: (response: Response) => void
  observerRead = new Promise(resolve => { settleObserver = resolve })
  act(() => remote.changed?.(sessionId))
  await waitFor(() => expect(historyReads()).toBe(2))
  // Same run ID and live phase, but a new, accepted SSE start happened after
  // this request was sent. The delayed pause belongs to the previous attempt.
  act(() => emit(streams[0], 'run.started', { ...start, seq: 2 }))
  await act(async () => settleObserver(response({ historyHead: { latestRunId: runId, latestRunStatus: status, historyRevision: revision },
    activeRunId: null, resumeRunId: runId, messages: [prompt] })))
  expect(useAgentStore.getState()).toMatchObject({ runId, phase: 'running', resumeableRunId: null })
  observerRead = null
  revision = 'stale-mismatched-head'
  subsequentHistory = { historyHead: { latestRunId: 'old', latestRunStatus: 'paused', historyRevision: revision },
    activeRunId: null, messages: [{ ...prompt, runId: 'old' }] }
  await act(async () => remote.changed?.(sessionId))
  await waitFor(() => expect(historyReads()).toBe(3))
  expect(useAgentStore.getState()).toMatchObject({ runId, phase: 'running', resumeableRunId: null })
  status = 'paused'
  revision = '1'
  subsequentHistory = { activeRunId: null, resumeRunId: runId, messages: [prompt] }
  act(() => { emit(streams[0], 'run.paused', { seq: 6, reason: 'author' }); remote.changed?.(sessionId) })
  await waitFor(() => expect(useAgentStore.getState().resumeableRunId).toBe(runId))
  status = 'running'
  revision = '2'
  subsequentHistory = { activeRunId: runId, activeRunReplayAfterSeq: 7, messages: [prompt] }
  act(() => remote.changed?.(sessionId))
  await waitFor(() => expect(connections.at(-1)).toContain('/stream?since=7'))
  expect(useAgentStore.getState().messages.filter(message => message.role === 'user')).toHaveLength(1)

  const answer = { ...prompt, id: 'answer', role: 'assistant', parts: [{ type: 'text', text: '续跑后的答复' }] }
  status = 'completed'
  revision = '3'
  subsequentHistory = { activeRunId: null, messages: [prompt, answer] }
  act(() => remote.changed?.(sessionId))
  await waitFor(() => expect(useAgentStore.getState().messages.at(-1)?.id).toBe('answer'))
  // A deletion can edit an older turn while the newest run ID and status remain identical.
  revision = '4'
  subsequentHistory = { activeRunId: null, messages: [answer] }
  act(() => remote.changed?.(sessionId))
  await waitFor(() => expect(useAgentStore.getState().messages.map(message => message.id)).toEqual(['answer']))
  latest = null
  revision = '5'
  subsequentHistory = { activeRunId: null, messages: [] }
  act(() => remote.changed?.(sessionId))
  await waitFor(() => expect(useAgentStore.getState().messages).toEqual([]))
  expect(editor.textContent).toBe('本机未发送的草稿')
  expect(fetch.mock.calls.every(([, options]) => options?.method !== 'POST')).toBe(true)
})

it('keeps previously opened pages at completion and reconciles a confirmed deletion inside the loaded range', async () => {
  const sessionId = 'older-remote-settlement'
  const rows = Array.from({ length: 14 }, (_, i) => ({ id: 'msg-' + i, runId: 'run-' + i, role: 'user',
    createdAt: new Date(Date.UTC(2025, 0, i + 1)).toISOString(), parts: [{ type: 'text', text: '合成记录 ' + i }] }))
  let visible = rows
  let head = { latestRunId: 'run-13', latestRunStatus: 'running', historyRevision: 'active' }
  const limits: number[] = []
  const response = (data: unknown) => new Response(JSON.stringify({ success: true, data }))
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('EventSource', class extends EventTarget { close() {} })
  vi.stubGlobal('fetch', vi.fn(async (resource: RequestInfo | URL) => {
    const url = new URL(String(resource), 'http://localhost')
    if (url.pathname.endsWith('/queue')) return response({ ...head, items: [] })
    if (!url.pathname.endsWith('/messages')) return response(null)
    const limit = Number(url.searchParams.get('runLimit'))
    const earlier = url.searchParams.get('before')
    const candidates = earlier ? visible.filter(row => row.createdAt < earlier) : visible
    const messages = candidates.slice(-limit)
    if (!earlier && limit !== 1) limits.push(limit)
    return response({ historyHead: earlier ? undefined : head, messages, activeRunId: head.latestRunStatus === 'running' ? head.latestRunId : null,
      pagination: { hasMore: candidates.length > limit, earliestRunStartedAt: messages[0]?.createdAt } })
  }))
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } })
  render(<QueryClientProvider client={client}><ToastProvider>
    <AgentPanel novelId="older-book" novelName="Test" sessionId={sessionId} ensureSession={async () => sessionId} />
  </ToastProvider></QueryClientProvider>)
  fireEvent.click(await screen.findByRole('button', { name: '加载更早对话' }))
  await screen.findByText('合成记录 0')
  head = { ...head, latestRunStatus: 'completed', historyRevision: 'completed' }
  act(() => remote.changed?.(sessionId))
  await waitFor(() => expect(useAgentStore.getState().runId).toBeNull())
  expect(limits.at(-1)).toBe(14)
  expect(useAgentStore.getState().messages.map(row => row.id)).toEqual(rows.map(row => row.id))
  visible = rows.filter(row => row.id !== 'msg-2')
  head = { ...head, historyRevision: 'delete-old-message' }
  act(() => remote.changed?.(sessionId))
  await waitFor(() => expect(useAgentStore.getState().messages.map(row => row.id)).toEqual(visible.map(row => row.id)))
})

it.each([false, true])('retries the same message history in place after a failed read (cached=%s)', async cached => {
  const sessionId = 'retry-history-' + cached
  const row = { id: 'm1', runId: 'r1', role: 'user' as const, createdAt: '', parts: [{ type: 'text' as const, text: '已保存的对话' }] }
  if (cached) {
    useAgentStore.getState().restoreMessages([row], sessionId)
    useAgentStore.getState().resetRun()
  }
  let reads = 0
  const fetch = vi.fn<typeof globalThis.fetch>(async resource => {
    if (String(resource).includes('/messages?runLimit=10')) {
      if (++reads === 1) return new Response(null, { status: 503 })
      return new Response(JSON.stringify({ success: true, data: { messages: [row], activeRunId: null } }))
    }
    return new Response(JSON.stringify({ success: true, data: null }))
  })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('fetch', fetch)
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } })
  render(<QueryClientProvider client={client}><ToastProvider>
    <AgentPanel novelId="retry-book" novelName="合成作品" sessionId={sessionId} ensureSession={async () => sessionId} />
  </ToastProvider></QueryClientProvider>)
  await screen.findByText('对话记录暂未同步。')
  expect(Boolean(screen.queryByText('已保存的对话'))).toBe(cached)
  const editor = screen.getByRole('textbox', { name: 'Agent 提示词' })
  editor.textContent = '保留我的草稿'
  fireEvent.input(editor)
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  await waitFor(() => expect(screen.queryByText('对话记录暂未同步。')).toBeNull())
  await screen.findByText('已保存的对话')
  expect(reads).toBe(2)
  expect(screen.getByRole('textbox', { name: 'Agent 提示词' })).toBe(editor)
  expect(editor.textContent).toBe('保留我的草稿')
})

it.each([
  { cached: false, concurrent: false }, { cached: true, concurrent: false }, { cached: true, concurrent: true },
])('coalesces the initial 50-turn history and applies a concurrent revision (cache=$cached, concurrent=$concurrent)', async ({ cached, concurrent }) => {
  const sessionId = `opening-${cached}-${concurrent}`
  const first = { latestRunId: 'first', latestRunStatus: 'completed', historyRevision: '1' }
  const second = { ...first, latestRunId: 'second', historyRevision: '2' }
  let head = first
  const message = (id: string) => ({ id, role: 'user' as const, runId: id, createdAt: new Date().toISOString(), parts: [{ type: 'text' as const, text: id }] })
  if (cached) useAgentStore.getState().restoreMessages([message('cached')], sessionId)
  useAgentStore.getState().resetRun()
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } })
  const response = (data: unknown) => new Response(JSON.stringify({ success: true, data }))
  let release!: (response: Response) => void
  const pending = new Promise<Response>(resolve => { release = resolve })
  let reads = 0
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async (resource: RequestInfo | URL) => {
    const url = String(resource)
    if (url.endsWith('/queue')) return response({ ...head, items: [] })
    if (url.includes('/messages?runLimit=') && !url.includes('&before=')) return ++reads === 1 ? pending : response({ historyHead: head, activeRunId: null, messages: [message(head.latestRunId)] })
    return response(null)
  }))
  render(<QueryClientProvider client={client}><ToastProvider>
    <AgentPanel novelId="opening-book" novelName="Test" sessionId={sessionId} ensureSession={async () => sessionId} />
  </ToastProvider></QueryClientProvider>)
  await waitFor(() => expect(client.getQueryData(['agent-queue', sessionId])).toMatchObject(first))
  const loading = () => screen.queryByRole('status', { name: '正在载入对话' })
  if (cached) {
    expect(useAgentStore.getState().messages[0]?.id).toBe('cached')
    await screen.findByText('cached')
    expect(loading()).toBeNull()
  } else {
    const delayedLoading = await screen.findByRole('status', { name: '正在载入对话' })
    expect(delayedLoading.closest('.agent-conversation-scroll')).toBeTruthy()
    expect(loading()?.querySelector('.skeleton-shimmer')).toBeTruthy()
  }
  if (concurrent) {
    head = second
    act(() => remote.changed?.(sessionId))
    await waitFor(() => expect(client.getQueryData(['agent-queue', sessionId])).toMatchObject(second))
  }
  expect(reads).toBe(1)
  await act(async () => release(response({ historyHead: first, activeRunId: null, messages: [message('first')] })))
  await waitFor(() => expect(useAgentStore.getState().messages[0]?.id).toBe(head.latestRunId))
  // A later wake for an unchanged head also stays lightweight.
  await act(async () => { remote.changed?.(sessionId); await new Promise(resolve => setTimeout(resolve, 10)) })
  expect(reads).toBe(concurrent ? 2 : 1)
})

it('shows fast task histories directly and returns to cached task messages without a skeleton', async () => {
  const a = 'fast-history-a', b = 'fast-history-b'
  const rows = (session: string) => Array.from({ length: 48 }, (_, index) => ({ id: `${session}-message-${index}`,
    runId: `${session}-run-${Math.floor(index / 2)}`, role: 'user' as const, createdAt: new Date().toISOString(),
    parts: [{ type: 'text' as const, text: `${session}-${index}` }] }))
  const runLimits: string[] = []
  const fetch = vi.fn<typeof globalThis.fetch>(async resource => {
    const url = String(resource)
    const olderSession = [a, b].find(id => url.includes(`/sessions/${id}/messages?runLimit=50&before=`))
    if (olderSession) return new Response(JSON.stringify({ success: true, data: { activeRunId: null,
      messages: rows(olderSession).slice(0, 28), pagination: { hasMore: false, earliestRunStartedAt: '2024-12-31T23:00:00.000Z' } } }))
    const session = [a, b].find(id => url.includes(`/sessions/${id}/messages?runLimit=`))
    if (session) {
      const runLimit = Number(new URL(url, 'http://local').searchParams.get('runLimit'))
      runLimits.push(`${session}:${runLimit}`)
      const all = rows(session)
      return new Response(JSON.stringify({ success: true, data: { activeRunId: null, messages: all.slice(-runLimit * 2),
        pagination: { hasMore: runLimit < 24, earliestRunStartedAt: '2025-01-01T00:00:00.000Z' } } }))
    }
    return new Response(JSON.stringify({ success: true, data: null }))
  })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('fetch', fetch)
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } })
  const view = render(<QueryClientProvider client={client}><ToastProvider>
    <AgentPanel novelId="fast-history-book" novelName="Test" sessionId={a} ensureSession={async () => a} />
  </ToastProvider></QueryClientProvider>)
  const loading = () => screen.queryByRole('status', { name: '正在载入对话' })
  expect(loading()).toBeNull()
  await screen.findByText(a + '-47')
  expect(loading()).toBeNull()

  view.rerender(<QueryClientProvider client={client}><ToastProvider>
    <AgentPanel novelId="fast-history-book" novelName="Test" sessionId={b} ensureSession={async () => b} />
  </ToastProvider></QueryClientProvider>)
  expect(loading()).toBeNull()
  await screen.findByText(b + '-47')
  expect(loading()).toBeNull()

  view.rerender(<QueryClientProvider client={client}><ToastProvider>
    <AgentPanel novelId="fast-history-book" novelName="Test" sessionId={a} ensureSession={async () => a} />
  </ToastProvider></QueryClientProvider>)
  await screen.findByText(a + '-47')
  expect(loading()).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '加载更早对话' }))
  await screen.findByText(a + '-0')
  expect(fetch.mock.calls.some(([url]) => String(url).includes(`/sessions/${a}/messages?runLimit=50&before=2025-01-01T00%3A00%3A00.000Z`))).toBe(true)
  expect(screen.getByText(a + '-47')).toBeTruthy()
  view.rerender(<QueryClientProvider client={client}><ToastProvider>
    <AgentPanel novelId="fast-history-book" novelName="Test" sessionId={b} ensureSession={async () => b} />
  </ToastProvider></QueryClientProvider>)
  await screen.findByText(b + '-47')
  view.rerender(<QueryClientProvider client={client}><ToastProvider>
    <AgentPanel novelId="fast-history-book" novelName="Test" sessionId={a} ensureSession={async () => a} />
  </ToastProvider></QueryClientProvider>)
  await screen.findByText(a + '-0')
  expect(screen.getByText(a + '-47')).toBeTruthy()
  expect(runLimits).toEqual(['fast-history-a:10', 'fast-history-b:10', 'fast-history-a:10', 'fast-history-b:10', 'fast-history-a:24'])
  expect(fetch.mock.calls.every(([, options]) => options?.method !== 'POST')).toBe(true)
})

it('delays the first-visit skeleton for 120ms and does not transfer it into a fast task B', async () => {
  const sessionId = 'slow-first-history'
  const row = { id: 'slow-message', runId: 'slow-run', role: 'user' as const, createdAt: new Date().toISOString(), parts: [{ type: 'text' as const, text: '慢加载内容' }] }
  const rowB = { id: 'fast-message-b', runId: 'fast-run-b', role: 'user' as const, createdAt: new Date().toISOString(), parts: [{ type: 'text' as const, text: '切换后的快任务' }] }
  let release!: (response: Response) => void
  const pending = new Promise<Response>(resolve => { release = resolve })
  const readStarted = Promise.withResolvers<void>()
  const response = (data: unknown) => new Response(JSON.stringify({ success: true, data }))
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('fetch', vi.fn(async (resource: RequestInfo | URL) => {
    const url = String(resource)
    if (url.includes(`/sessions/${sessionId}/messages?runLimit=10`)) { readStarted.resolve(); return pending }
    if (url.includes('/sessions/fast-task-b/messages?runLimit=10')) return response({ activeRunId: null, messages: [rowB] })
    return response(null)
  }))
  vi.useFakeTimers()
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } })
  const view = render(<QueryClientProvider client={client}><ToastProvider>
    <AgentPanel novelId="slow-history-book" novelName="Test" sessionId={sessionId} ensureSession={async () => sessionId} />
  </ToastProvider></QueryClientProvider>)
  const loading = () => screen.queryByRole('status', { name: '正在载入对话' })
  await readStarted.promise
  expect(loading()).toBeNull()
  await act(async () => { await vi.advanceTimersByTimeAsync(119) })
  expect(loading()).toBeNull()
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(loading()?.querySelector('.skeleton-shimmer')).toBeTruthy()
  await act(async () => {
    view.rerender(<QueryClientProvider client={client}><ToastProvider>
      <AgentPanel novelId="slow-history-book" novelName="Test" sessionId="fast-task-b" ensureSession={async () => 'fast-task-b'} />
    </ToastProvider></QueryClientProvider>)
    await Promise.resolve()
  })
  expect(screen.getByText('切换后的快任务')).toBeTruthy()
  expect(loading()).toBeNull()
  await act(async () => release(response({ activeRunId: null, messages: [row] })))
  expect(screen.getByText('切换后的快任务')).toBeTruthy()
  expect(screen.queryByText('慢加载内容')).toBeNull()
  expect(loading()).toBeNull()
})
