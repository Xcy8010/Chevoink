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
    if (url.includes('/messages?runLimit=50')) return subsequentHistory ? response(subsequentHistory) : pending
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
  const historyReads = () => fetch.mock.calls.filter(([u]) => String(u).includes('/messages?runLimit=50')).length
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
    if (url.includes('/messages?runLimit=50')) return ++reads === 1 ? pending : response({ historyHead: head, activeRunId: null, messages: [message(head.latestRunId)] })
    return response(null)
  }))
  render(<QueryClientProvider client={client}><ToastProvider>
    <AgentPanel novelId="opening-book" novelName="Test" sessionId={sessionId} ensureSession={async () => sessionId} />
  </ToastProvider></QueryClientProvider>)
  await waitFor(() => expect(client.getQueryData(['agent-queue', sessionId])).toMatchObject(first))
  if (cached) expect(useAgentStore.getState().messages[0]?.id).toBe('cached')
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
