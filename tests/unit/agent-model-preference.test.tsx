// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStreamEvent } from '../../shared/contracts/index.js'
import type { ModelAssignmentsPayload } from '../../shared/contracts/agent-model-assignments.js'
import { resolveComposerModelEffort, useAgentModelPreference } from '../../src/features/studio/agent/useAgentModelPreference'
import { useAgentStream } from '../../src/features/studio/agent/useAgentStream'
import { useAgentStore } from '../../src/features/studio/agent/agentStore'

const api = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('../../src/app/api-client', () => ({ requestJson: api.request }))
function payload(main = true): ModelAssignmentsPayload {
  return { version: 1, global: { revision: 1, assignments: {} }, novel: { revision: 0, assignments: {} },
    effective: main ? { main: { source: 'global', selection: { modelTier: 'custom', customModelId: 'custom-a', reasoningEffort: 'medium' } } } : {} }
}
function mount(novelId = 'novel-a', sessionId = 'session-a') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  return renderHook(({ novelId, sessionId }) => useAgentModelPreference(novelId, sessionId), { initialProps: { novelId, sessionId }, wrapper })
}
const configuration = (seq = 2, runId = 'run-a'): AgentStreamEvent & { type: 'run.configuration' } => ({ type: 'run.configuration', runId, seq, ts: new Date().toISOString(), modelTier: 'ultimate', customModelId: null, reasoningEffort: 'high', creativeFreedom: 'bold', modelSelectionExplicit: true })
beforeEach(() => {
  window.localStorage.clear()
  api.request.mockReset().mockResolvedValue(payload())
  useAgentStore.setState({ activeSessionId: 'session-a', runId: 'run-a', phase: 'running', lastSeq: 1, messages: [] })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('Agent model preference ownership', () => {
  it('inherits global main without converting it to an explicit choice or leaking it into local defaults', async () => {
    const { result } = mount()
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current).toMatchObject({ modelTier: 'custom', customModelId: 'custom-a', inheritMain: true, explicit: false, preferredEffort: 'medium' })
    expect(window.localStorage.getItem('chevoink:agent-model-tier')).toBe('speed')
    expect(window.localStorage.getItem('chevoink:agent-custom-model-id')).toBeNull()
  })
  it('recognizes a manual selection even when the author chooses the same tier as the old default', async () => {
    api.request.mockResolvedValue(payload(false))
    const { result } = mount()
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.explicit).toBe(false)
    act(() => result.current.selectModelTier('speed'))
    expect(result.current.explicit).toBe(true)
    expect(result.current.preferredEffort).toBeUndefined()
    act(() => result.current.selectReasoningEffort('tier:speed', 'medium'))
    expect(result.current.preferredEffort).toBe('medium')
  })
  it('does not carry work A overrides into work B and preserves defaults when nothing is assigned', async () => {
    api.request.mockImplementation((path: string) => Promise.resolve(payload(path.includes('novel-a'))))
    const { result, rerender } = mount()
    await waitFor(() => expect(result.current.inheritMain).toBe(true))
    act(() => result.current.selectModelTier('performance'))
    rerender({ novelId: 'novel-b', sessionId: 'session-b' })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current).toMatchObject({ modelTier: 'performance', explicit: false, inheritMain: false })
  })
  it('keeps the newly chosen custom id when the composer batches custom and tier callbacks', async () => {
    const { result } = mount()
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => {
      result.current.selectCustomModel('custom-b')
      result.current.selectModelTier('custom')
    })
    expect(result.current).toMatchObject({ modelTier: 'custom', customModelId: 'custom-b', explicit: true, preferredEffort: undefined })
  })
  it('uses the selected model configured default when no strength was chosen, while preserving untouched saved settings', async () => {
    window.localStorage.setItem('chevoink:agent-reasoning-efforts', JSON.stringify({ 'tier:speed': 'low' }))
    api.request.mockResolvedValue(payload(false))
    const { result } = mount()
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.preferredEffort).toBeUndefined()
    expect(result.current.reasoningSelections['tier:speed']).toBe('low')
    const highDefault = { reasoningEfforts: ['low', 'high', 'max'] as const, defaultReasoningEffort: 'high' as const }
    expect(resolveComposerModelEffort(undefined, false, result.current.reasoningSelections['tier:speed'], highDefault)).toBe('low')
    act(() => result.current.selectModelTier('speed'))
    expect(result.current.preferredEffort).toBeUndefined()
    expect(resolveComposerModelEffort(result.current.preferredEffort, result.current.explicit, result.current.reasoningSelections['tier:speed'], highDefault)).toBe('high')
    expect(resolveComposerModelEffort(undefined, true, 'high', { reasoningEfforts: ['none', 'low', 'medium', 'high'], defaultReasoningEffort: 'medium' })).toBe('medium')
    act(() => result.current.selectReasoningEffort('tier:speed', 'low'))
    expect(resolveComposerModelEffort(result.current.preferredEffort, true, 'high', highDefault)).toBe('low')
  })
  it('uses the inherited model configured default instead of stale local effort without creating a composer override', async () => {
    window.localStorage.setItem('chevoink:agent-reasoning-efforts', JSON.stringify({ 'tier:ultimate': 'low' }))
    api.request.mockResolvedValue({ ...payload(false), effective: { main: { source: 'global', selection: { modelTier: 'ultimate' } } } })
    const { result } = mount()
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current).toMatchObject({ modelTier: 'ultimate', inheritMain: true, explicit: false, preferredEffort: undefined })
    const capability = { reasoningEfforts: ['low', 'high', 'max'] as const, defaultReasoningEffort: 'high' as const }
    expect(resolveComposerModelEffort(result.current.preferredEffort, result.current.explicit || result.current.inheritMain,
      result.current.reasoningSelections['tier:ultimate'], capability)).toBe('high')
    expect(window.localStorage.getItem('chevoink:agent-reasoning-efforts')).toBe(JSON.stringify({ 'tier:ultimate': 'low' }))
    expect(result.current.inheritMain).toBe(true)
  })
  it('applies only the current run configuration, deduplicates replay and retains conversation state', async () => {
    const { result, rerender } = mount()
    await waitFor(() => expect(result.current.loading).toBe(false))
    const messages = useAgentStore.getState().messages
    const event = configuration()
    act(() => {
      useAgentStore.getState().applyEvent(event)
      expect(result.current.applyConfiguration(event)).toBe(true)
    })
    expect(result.current.modelTier).toBe('ultimate')
    expect(window.localStorage.getItem('chevoink:agent-model-tier')).toBe('speed')
    expect(useAgentStore.getState().messages).toBe(messages)
    act(() => {
      expect(result.current.applyConfiguration(event)).toBe(false)
      expect(result.current.applyConfiguration(configuration(1))).toBe(false)
      expect(result.current.applyConfiguration(configuration(3, 'foreign-run'))).toBe(false)
    })
    rerender({ novelId: 'novel-b', sessionId: 'session-b' })
    act(() => expect(result.current.applyConfiguration(configuration(3))).toBe(false))
    await waitFor(() => expect(result.current.modelTier).toBe('custom'))
  })
  it('edits an inactive model strength without changing the active model and honors that explicit choice when selected', async () => {
    api.request.mockResolvedValue(payload(false))
    const { result } = mount()
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.selectReasoningEffort('tier:ultimate', 'max'))
    expect(result.current).toMatchObject({ modelTier: 'speed', explicit: false, preferredEffort: undefined })
    act(() => result.current.selectModelTier('ultimate'))
    expect(result.current).toMatchObject({ modelTier: 'ultimate', explicit: true, preferredEffort: 'max' })
  })
  it('subscribes to configuration SSE and forwards the event after advancing the store sequence', () => {
    const listeners = new Map<string, (event: MessageEvent) => void>()
    class Source {
      onerror = null
      addEventListener(type: string, listener: (event: MessageEvent) => void) { listeners.set(type, listener) }
      close() {}
    }
    vi.stubGlobal('EventSource', Source)
    const received = vi.fn((event: AgentStreamEvent) => expect(useAgentStore.getState().lastSeq).toBe(event.seq))
    const { result } = renderHook(() => useAgentStream(received))
    act(() => result.current.connect('run-a'))
    expect(listeners.has('run.configuration')).toBe(true)
    const event = configuration()
    act(() => listeners.get('run.configuration')!(new MessageEvent('run.configuration', { data: JSON.stringify(event) })))
    expect(received).toHaveBeenCalledWith(event)
  })
  it('starts resumed streaming after the server cursor and still closes on the new terminal', () => {
    const listeners = new Map<string, (event: MessageEvent) => void>()
    const opened = vi.fn(), closed = vi.fn()
    class Source {
      onerror = null
      constructor(url: string) { opened(url) }
      addEventListener(type: string, listener: (event: MessageEvent) => void) { listeners.set(type, listener) }
      close() { closed() }
    }
    vi.stubGlobal('EventSource', Source)
    const { result } = renderHook(() => useAgentStream())
    act(() => result.current.connect('run-a', 12704))
    expect(opened).toHaveBeenCalledWith(expect.stringContaining('/run-a/stream?since=12704'))
    expect(closed).not.toHaveBeenCalled()
    const event: AgentStreamEvent = { type: 'run.paused', runId: 'run-a', seq: 12709, ts: new Date().toISOString(), reason: 'needs_input' }
    act(() => listeners.get('run.paused')!(new MessageEvent('run.paused', { data: JSON.stringify(event) })))
    expect(useAgentStore.getState()).toMatchObject({ phase: 'paused', lastSeq: 12709 })
    expect(closed).toHaveBeenCalledOnce()
  })
  it('does not override an inherited model when only creative mode changes', async () => {
    const { result } = mount()
    await waitFor(() => expect(result.current.inheritMain).toBe(true))
    const event = { ...configuration(), modelSelectionExplicit: false }
    act(() => {
      useAgentStore.getState().applyEvent(event)
      expect(result.current.applyConfiguration(event)).toBe(true)
    })
    expect(result.current).toMatchObject({ inheritMain: true, explicit: false, modelTier: 'custom' })
  })
})
