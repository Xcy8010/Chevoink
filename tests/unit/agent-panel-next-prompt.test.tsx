// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ToastProvider } from '../../src/components/ui/Toast'
import { AgentPanel } from '../../src/features/studio/agent/components/AgentPanel'
import { useAgentStore } from '../../src/features/studio/agent/agentStore'

vi.mock('../../src/features/studio/agent/useAgentGoalStream', () => {
  const connect = vi.fn(), disconnect = vi.fn()
  return { useAgentGoalStream: () => ({ connect, disconnect }) }
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
