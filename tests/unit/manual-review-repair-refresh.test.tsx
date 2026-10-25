// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useManualReviewRepairRefresh } from '../../src/features/studio/agent/components/use-manual-review-repair-refresh'
import { useAgentStore } from '../../src/features/studio/agent/agentStore'
const api = vi.hoisted(() => ({ messages: vi.fn(), statuses: vi.fn() }))
vi.mock('../../src/features/studio/agent/agentApi', () => ({ fetchAgentSessionMessages: api.messages, fetchSessionsRunStatus: api.statuses }))
const payload = { messages: [], activeRunId: null, runGoalId: null, resumeRunId: null }
beforeEach(() => {
  useAgentStore.setState(useAgentStore.getInitialState(), true)
  useAgentStore.setState({ runId: 'run', loadedSessionId: 'session', activeSessionId: 'session', phase: 'paused' })
  api.messages.mockResolvedValue(payload)
  api.statuses.mockResolvedValue({ statuses: { session: { runId: 'run', status: 'completed' } } })
})
afterEach(() => { cleanup(); vi.resetAllMocks() })
function fixture() { return renderHook(props => useManualReviewRepairRefresh(props), { initialProps: { runId: 'run', resumeableRunId: null as string | null, sessionId: 'session' } }) }
it('marks completion from the actual owned run status after hydrating messages', async () => {
  const { result } = fixture()
  act(() => result.current())
  await waitFor(() => expect(useAgentStore.getState().phase).toBe('succeeded'))
  expect(useAgentStore.getState().runId).toBe('run')
  expect(api.messages).toHaveBeenCalledExactlyOnceWith('session', { runLimit: 50 })
})
it('keeps the original run stoppable only after the server reports it active', async () => {
  api.messages.mockResolvedValue({ ...payload, activeRunId: 'run' })
  api.statuses.mockResolvedValue({ statuses: { session: { runId: 'run', status: 'running' } } })
  const { result } = fixture()
  act(() => result.current())
  await waitFor(() => expect(useAgentStore.getState().phase).toBe('running'))
  expect(useAgentStore.getState().activeSessionId).toBe('session')
  expect(useAgentStore.getState().runId).toBe('run')
})
it('preserves a real pause and the original continuation when repair is incomplete', async () => {
  api.messages.mockResolvedValue({ ...payload, resumeRunId: 'run' })
  api.statuses.mockResolvedValue({ statuses: { session: { runId: 'run', status: 'paused' } } })
  const { result } = fixture()
  act(() => result.current())
  await waitFor(() => expect(useAgentStore.getState().resumeableRunId).toBe('run'))
  expect(useAgentStore.getState().phase).toBe('paused')
})
it('does not report completion when status lookup is unavailable', async () => {
  api.statuses.mockRejectedValue(new Error('status unavailable'))
  const { result } = fixture()
  await act(async () => result.current())
  expect(useAgentStore.getState().phase).toBe('paused')
})
it('does not restore an old response over another run in the same session', async () => {
  let finish!: (value: typeof payload) => void
  api.messages.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const { result } = fixture()
  act(() => result.current())
  useAgentStore.setState({ runId: 'new-run', phase: 'running' })
  await act(async () => finish(payload))
  expect(useAgentStore.getState().runId).toBe('new-run')
  expect(useAgentStore.getState().phase).toBe('running')
})
it('does not apply late original-task state after changing the viewed task', async () => {
  let finish!: (value: typeof payload) => void
  api.messages.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const { result, rerender } = fixture()
  act(() => result.current())
  rerender({ runId: 'other-run', sessionId: 'other-session', resumeableRunId: null })
  useAgentStore.setState({ runId: 'other-run', loadedSessionId: 'other-session', phase: 'paused' })
  await act(async () => finish(payload))
  expect(useAgentStore.getState().loadedSessionId).toBe('other-session')
  expect(useAgentStore.getState().runId).toBe('other-run')
  expect(useAgentStore.getState().phase).toBe('paused')
})
it('disconnects the old SSE replay only for the currently owned manual operation', async () => {
  const disconnect = vi.fn()
  const { result } = renderHook(() => useManualReviewRepairRefresh({ runId: 'run', resumeableRunId: null, sessionId: 'session', disconnect }))
  const running = { operationId: 'repair', eventStartSeq: 3532, state: 'running' as const, reportId: null, terminalCommitted: false, needsContinuation: false, message: '正在修复。' }
  await act(async () => result.current(running))
  expect(disconnect).toHaveBeenCalledOnce()
  useAgentStore.setState({ runId: 'new-run', phase: 'running' })
  await act(async () => result.current(running))
  expect(disconnect).toHaveBeenCalledOnce()
})