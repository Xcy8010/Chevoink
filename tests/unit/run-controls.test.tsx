// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useRunControls } from '../../src/features/studio/agent/components/use-run-controls'
import type { ContinueAgentLoopRunModel } from '../../src/features/studio/agent/agentApi'
import type { PendingQuestion } from '../../src/features/studio/agent/agentStore'

const mocks = vi.hoisted(() => ({ resume: vi.fn(), stop: vi.fn(), approval: vi.fn(), question: vi.fn(), begin: vi.fn(), restore: vi.fn() }))
vi.mock('../../src/features/studio/agent/agentApi', () => ({
  continueAgentLoopRun: mocks.resume, stopAgentLoopRun: mocks.stop,
  resolveAgentApproval: mocks.approval, resolveAgentQuestion: mocks.question,
}))
vi.mock('../../src/features/studio/agent/agentStore', () => ({
  isRunActive: (phase: string) => phase === 'running',
  useAgentStore: { getState: () => ({ beginRun: mocks.begin, resumeRun: mocks.restore }) },
}))
afterEach(() => { cleanup(); vi.clearAllMocks() })

function fixture(selectedModelRef?: { current: ContinueAgentLoopRunModel | null }, pendingQuestion?: PendingQuestion) {
  const connect = vi.fn(), setActionError = vi.fn()
  const hook = renderHook(({ sessionId, runId }) => useRunControls({
    sessionId, runId, resumeableRunId: null, phase: 'running',
    pendingApproval: null, pendingQuestion: pendingQuestion ?? null, connect, setActionError, selectedModelRef,
  }), { initialProps: { sessionId: 'a', runId: 'run' } })
  return { ...hook, connect, setActionError }
}

it('deduplicates concurrent resume clicks and connects once', async () => {
  let finish!: (value: { runId: string; eventStartSeq?: number }) => void
  mocks.resume.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  const { result, connect } = fixture()
  let first!: Promise<void>, second!: Promise<void>
  act(() => { first = result.current.handleContinue(); second = result.current.handleContinue() })
  expect(mocks.resume).toHaveBeenCalledTimes(1)
  await act(async () => { finish({ runId: 'resumed', eventStartSeq: 12704 }); await Promise.all([first, second]) })
  expect(connect).toHaveBeenCalledExactlyOnceWith('resumed', 12704)
  expect(mocks.restore).toHaveBeenCalledExactlyOnceWith('resumed', 'a', undefined, 12704)
  expect(mocks.begin).not.toHaveBeenCalled()
})

it('sends the current question identity and leaves its submission error with the question card', async () => {
  const question = { callId: 'call-1', requestId: 'request-1', question: '从哪里开始？', options: [] }
  mocks.question.mockRejectedValueOnce(new Error('提交失败')).mockResolvedValueOnce({ resolved: true })
  const { result, setActionError } = fixture(undefined, question)
  await expect(result.current.handleResolveQuestion({ answer: '夜市' })).rejects.toThrow('提交失败')
  expect(setActionError).not.toHaveBeenCalled()
  await expect(result.current.handleResolveQuestion({ answer: '夜市' })).resolves.toBe(true)
  expect(mocks.question).toHaveBeenLastCalledWith('run', { callId: 'call-1', requestId: 'request-1', answer: '夜市' })
})

it('sends a batch or cancellation as an atomic decision on the original call', async () => {
  const prompt = { question: '从哪里开始？', options: [] }
  const { result } = fixture(undefined, { callId: 'batch', requestId: 'request-2', ...prompt, questions: [prompt, prompt] })
  mocks.question.mockResolvedValue({ resolved: true })
  await expect(result.current.handleResolveQuestion({ answers: ['夜市', '第三人称'] })).resolves.toBe(true)
  await expect(result.current.handleResolveQuestion({ cancelled: true })).resolves.toBe(true)
  expect(mocks.question.mock.calls).toEqual([
    ['run', { callId: 'batch', requestId: 'request-2', answers: ['夜市', '第三人称'] }],
    ['run', { callId: 'batch', requestId: 'request-2', cancelled: true }],
  ])
})

it('one Continue restores the original task and connects directly using the current model', async () => {
  mocks.resume.mockResolvedValue({ runId: 'run', status: 'running', eventStartSeq: 100 })
  const selectedModelRef = { current: { modelTier: 'standard' as const, reasoningEffort: 'medium' as const } }
  const { result, connect, setActionError } = fixture(selectedModelRef)
  await act(async () => { await result.current.handleContinue() })
  expect(mocks.resume).toHaveBeenCalledExactlyOnceWith('run', selectedModelRef.current)
  expect(mocks.restore).toHaveBeenCalledExactlyOnceWith('run', 'a', undefined, 100)
  expect(connect).toHaveBeenCalledExactlyOnceWith('run', 100)
  expect(setActionError).toHaveBeenCalledExactlyOnceWith(null)
})

it('does not restore or connect when ordinary continuation is rejected', async () => {
  mocks.resume.mockRejectedValue(new Error('continue unavailable'))
  const { result, connect, setActionError } = fixture()
  await act(async () => { await result.current.handleContinue() })
  expect(mocks.resume).toHaveBeenCalledOnce()
  expect(connect).not.toHaveBeenCalled()
  expect(mocks.restore).not.toHaveBeenCalled()
  expect(setActionError).toHaveBeenLastCalledWith('continue unavailable')
})

it('passes the current free or BYOK model selection when continuing a run', async () => {
  mocks.resume.mockResolvedValue({ runId: 'resumed' })
  const selectedModelRef = { current: { modelTier: 'custom' as const, customModelId: 'byok-1', reasoningEffort: 'xhigh' as const } }
  const { result } = fixture(selectedModelRef)

  await act(async () => { await result.current.handleContinue() })

  expect(mocks.resume).toHaveBeenCalledExactlyOnceWith('run', selectedModelRef.current)
})

it('does not hydrate an old resume into another window', async () => {
  let finish!: (value: { runId: string; eventStartSeq?: number }) => void
  mocks.resume.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  const { result, rerender, connect } = fixture()
  let pending!: Promise<void>
  act(() => { pending = result.current.handleContinue() })
  rerender({ sessionId: 'b', runId: 'run-b' })
  await act(async () => { finish({ runId: 'old' }); await pending })
  expect(connect).not.toHaveBeenCalled()
  expect(mocks.begin).not.toHaveBeenCalled()
  expect(mocks.restore).not.toHaveBeenCalled()
})

it('does not display an old stop failure in another task', async () => {
  let fail!: (error: Error) => void
  mocks.stop.mockImplementation(() => new Promise((_, reject) => { fail = reject }))
  const { result, rerender, setActionError } = fixture()
  let pending!: Promise<void>
  act(() => { pending = result.current.handleStop() })
  expect(result.current.stoppingRunId).toBe('run')
  rerender({ sessionId: 'b', runId: 'run-b' })
  await act(async () => { fail(new Error('old failure')); await pending })
  expect(setActionError).not.toHaveBeenCalled()
  expect(result.current.stoppingRunId).toBeNull()
})

it('does not restore a late continue response over a newer run in the same session', async () => {
  let finish!: (value: { runId: string; eventStartSeq?: number }) => void
  mocks.resume.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const { result, rerender, connect } = fixture()
  let pending!: Promise<void>
  act(() => { pending = result.current.handleContinue() })
  rerender({ sessionId: 'a', runId: 'new-run' })
  await act(async () => { finish({ runId: 'run' }); await pending })
  expect(connect).not.toHaveBeenCalled()
  expect(mocks.restore).not.toHaveBeenCalled()
})
