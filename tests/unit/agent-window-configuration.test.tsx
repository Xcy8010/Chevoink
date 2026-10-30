// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentWindowConfigurationPayload } from '../../shared/contracts/agent-window-configuration.js'
import { useAgentWindowConfiguration } from '../../src/features/studio/agent/useAgentWindowConfiguration'
import { useAgentModelPreference } from '../../src/features/studio/agent/useAgentModelPreference'

const api = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('../../src/app/api-client', () => ({ requestJson: api.request }))
const records = new Map<string, AgentWindowConfigurationPayload>()
const empty = (id: string): AgentWindowConfigurationPayload => ({ sessionId: id, novelId: 'novel', title: id, revision: 0, configuration: { model: null, creativeFreedom: 'balanced' } })
beforeEach(() => {
  localStorage.clear(); records.clear()
  api.request.mockReset().mockImplementation(async (path: string, options?: RequestInit) => {
    if (path.includes('model-assignments')) return { effective: {} }
    const id = path.split('/').at(-2)!
    const value = records.get(id) ?? empty(id)
    if (options?.method === 'PATCH') {
      const { expectedRevision, ...patch } = JSON.parse(options.body as string)
      expect(expectedRevision).toBe(value.revision)
      records.set(id, { ...value, revision: value.revision + 1, configuration: { ...value.configuration, ...patch } })
    }
    return records.get(id) ?? value
  })
})
afterEach(async () => { await act(async () => {}); cleanup() })
function fixture() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  return { client, wrapper }
}
it('restores independent model, effort and mode for same-novel A → B → A and remount', async () => {
  const { wrapper } = fixture()
  const hook = renderHook(({ id }) => useAgentModelPreference('novel', id), { wrapper, initialProps: { id: 'a' } })
  await waitFor(() => expect(hook.result.current.loading).toBe(false))
  await act(async () => {
    hook.result.current.selectModelTier('ultimate')
    hook.result.current.selectReasoningEffort('tier:ultimate', 'max')
    await hook.result.current.windowConfiguration.update({ creativeFreedom: 'bold' })
  })
  hook.rerender({ id: 'b' })
  await waitFor(() => expect(hook.result.current.loading).toBe(false))
  expect(hook.result.current.modelTier).toBe('speed')
  await act(async () => {
    hook.result.current.selectModelTier('performance')
    await hook.result.current.windowConfiguration.update({ creativeFreedom: 'stable' })
  })
  hook.rerender({ id: 'a' })
  await waitFor(() => expect(hook.result.current.preferredEffort).toBe('max'))
  expect(hook.result.current.modelTier).toBe('ultimate')
  expect(hook.result.current.windowConfiguration.configuration.creativeFreedom).toBe('bold')
  hook.unmount()
  const next = fixture()
  const remount = renderHook(() => useAgentModelPreference('novel', 'b'), next)
  await waitFor(() => expect(remount.result.current.modelTier).toBe('performance'))
  expect(remount.result.current.windowConfiguration.configuration.creativeFreedom).toBe('stable')
  expect(localStorage.getItem('chevoink:agent-model-tier')).toBeNull()
  expect(localStorage.getItem('chevoink:creative-freedom:novel')).toBeNull()
})
it('shares settings/composer cache, serializes edits and promotes isolated draft preferences', async () => {
  const { wrapper } = fixture()
  const hook = renderHook(({ scope }) => ({
    composer: useAgentWindowConfiguration('novel', null, scope),
    settings: useAgentWindowConfiguration('novel', null, scope),
  }), { wrapper, initialProps: { scope: 'draft-a' } })
  await act(async () => { await hook.result.current.settings.update({ creativeFreedom: 'bold', model: { modelTier: 'ultimate', reasoningEffort: 'high' } }) })
  await waitFor(() => expect(hook.result.current.composer.configuration.creativeFreedom).toBe('bold'))
  const promote = hook.result.current.composer.promote
  hook.rerender({ scope: 'draft-b' })
  expect(hook.result.current.composer.configuration.creativeFreedom).toBe('balanced')
  await act(async () => { await promote('created') })
  expect(records.get('created')?.configuration).toEqual({ creativeFreedom: 'bold', model: { modelTier: 'ultimate', reasoningEffort: 'high' } })
  hook.rerender({ scope: 'draft-a' })
  expect(hook.result.current.composer.configuration.creativeFreedom).toBe('bold')
})
it('rolls back an optimistic change when its prerequisite GET fails and hides old-scope save errors', async () => {
  const { wrapper } = fixture()
  const hook = renderHook(({ id }) => useAgentWindowConfiguration('novel', id), { wrapper, initialProps: { id: 'a' } })
  await waitFor(() => expect(hook.result.current.loading).toBe(false))
  api.request.mockRejectedValueOnce(new Error('读取配置失败'))
  await act(async () => { await expect(hook.result.current.update({ creativeFreedom: 'bold' })).rejects.toThrow('读取配置失败') })
  expect(hook.result.current.configuration.creativeFreedom).toBe('balanced')
  expect(hook.result.current.error).toBe('读取配置失败')
  hook.rerender({ id: 'b' })
  await waitFor(() => expect(hook.result.current.loading).toBe(false))
  expect(hook.result.current.error).toBeNull()
})
it('keeps a late failed save in its originating window after a switch', async () => {
  const { wrapper } = fixture()
  const hook = renderHook(({ id }) => useAgentWindowConfiguration('novel', id), { wrapper, initialProps: { id: 'a' } })
  await waitFor(() => expect(hook.result.current.loading).toBe(false))
  let rejectRead!: (error: Error) => void
  api.request.mockImplementationOnce(() => new Promise((_, reject) => { rejectRead = reject }))
  let save!: Promise<unknown>
  await act(async () => { save = hook.result.current.update({ creativeFreedom: 'bold' }).catch(error => error) })
  hook.rerender({ id: 'b' })
  await waitFor(() => expect(hook.result.current.loading).toBe(false))
  await act(async () => { rejectRead(new Error('旧窗口保存失败')); await save })
  expect(hook.result.current.error).toBeNull()
  expect(hook.result.current.configuration.creativeFreedom).toBe('balanced')
})
