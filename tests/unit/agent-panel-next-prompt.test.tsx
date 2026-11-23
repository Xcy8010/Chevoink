// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../src/components/ui/Toast'
import { AgentPanel } from '../../src/features/studio/agent/components/AgentPanel'
import { useAgentStore } from '../../src/features/studio/agent/agentStore'

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
  let releaseHistory!: (response: Response) => void
  const pending = new Promise<Response>(resolve => { releaseHistory = resolve })
  const fetch = vi.fn<typeof globalThis.fetch>(async resource => {
    const url = String(resource)
    if (url.endsWith('/queue')) return response({ latestRunId: latest, latestRunStatus: latest ? status : null, historyRevision: revision, items: [] })
    if (url.includes('/messages?runLimit=10')) return subsequentHistory ? response(subsequentHistory) : pending
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
