// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentReviewRecovery } from '../../src/features/studio/agent/components/AgentReviewRecovery'

const mocks = vi.hoisted(() => ({ latest: vi.fn(), preview: vi.fn(), submit: vi.fn(), status: vi.fn(),
  ApiError: class extends Error { constructor(message: string, readonly status: number, readonly code: string) { super(message) } } }))
vi.mock('../../src/features/studio/agent/agentApi', () => ({ fetchLatestAgentReviewReplacementStatus: mocks.latest,
  quoteAgentReviewReplacement: mocks.preview, submitAgentReviewReplacement: mocks.submit, fetchAgentReviewReplacementStatus: mocks.status, AgentApiError: mocks.ApiError }))
const model = { modelTier: 'standard' as const, reasoningEffort: 'medium' as const }
const quote = { quoteToken: 'signed', authorizationId: 'author:a:nonce', expiresAt: '2099-01-01T00:00:00Z', chapterId: 'chapter', currentRevision: 4,
  currentModel: { modelTier: 'standard', customModelId: null, reasoningEffort: 'medium', label: '标准', modelName: 'mimo-v2.6-flash', multiplierBps: 12000 }, maximumCreditMilli: 19661 }
const running = { authorizationId: quote.authorizationId, state: 'running', message: '检查中' }
beforeEach(() => {
  vi.resetAllMocks()
  mocks.latest.mockResolvedValue(null); mocks.preview.mockResolvedValue(quote); mocks.submit.mockResolvedValue(running)
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true } })
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value() { this.open = false } })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })
function fixture() {
  const ready = vi.fn()
  const view = render(<AgentReviewRecovery runId="run" sessionId="session" enabled model={model} onReady={ready} />)
  return { ...view, ready }
}
async function preview() {
  const button = await screen.findByRole('button', { name: '按当前模型重新检查' })
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(button)
  await screen.findByRole('button', { name: '确认检查' })
}
it('loads and quotes read-only, discloses actual selected price, then submits once only on confirmation', async () => {
  fixture(); await preview()
  expect(mocks.preview).toHaveBeenCalledExactlyOnceWith('run', model)
  expect(mocks.submit).not.toHaveBeenCalled()
  expect(screen.getByText(/19.661 Credits/)).toBeDefined()
  expect(screen.getByText(/mimo-v2.6-flash/)).toBeDefined()
  expect(screen.getByText(/原费用预留保留/)).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: '确认检查' }))
  await waitFor(() => expect(mocks.submit).toHaveBeenCalledExactlyOnceWith('run', 'signed'))
  expect(mocks.preview).toHaveBeenCalledOnce()
})
it('invalidates a quote if the author changes the selected model before confirmation', async () => {
  const { rerender, ready } = fixture(); await preview()
  rerender(<AgentReviewRecovery runId="run" sessionId="session" enabled model={{ modelTier: 'ultimate', reasoningEffort: 'high' }} onReady={ready} />)
  fireEvent.click(screen.getByRole('button', { name: '确认检查' }))
  expect(mocks.submit).not.toHaveBeenCalled(); expect(ready).not.toHaveBeenCalled()
  expect(screen.getByText(/模型选择或报价已改变/)).toBeDefined()
})
it('a lost POST response reconciles the same action by GET without a second POST or main Continue', async () => {
  mocks.submit.mockRejectedValue(new Error('network lost'))
  mocks.status.mockResolvedValue({ ...running, state: 'waiting_confirmation', message: '用量待确认' })
  const { ready } = fixture(); await preview()
  fireEvent.click(screen.getByRole('button', { name: '确认检查' }))
  await screen.findByText('用量待确认')
  expect(mocks.status).toHaveBeenCalledWith('run', quote.authorizationId)
  expect(mocks.submit).toHaveBeenCalledOnce(); expect(ready).not.toHaveBeenCalled()
})
it('refresh reads the existing claim and only polls GET; complete evidence alone enables later Continue', async () => {
  vi.useFakeTimers()
  mocks.latest.mockResolvedValue(running)
  mocks.status.mockResolvedValue({ ...running, state: 'complete', reportId: 'report', message: '报告已保存' })
  const { ready } = fixture()
  await act(async () => { await Promise.resolve() })
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(mocks.submit).not.toHaveBeenCalled(); expect(mocks.preview).not.toHaveBeenCalled()
  expect(mocks.status).toHaveBeenCalledExactlyOnceWith('run', quote.authorizationId)
  expect(ready).toHaveBeenCalledOnce()
  await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
  expect(mocks.status).toHaveBeenCalledOnce()
})
it('a definitively absent action allows explicit confirmation of the same quote without automatic resend', async () => {
  mocks.submit.mockRejectedValue(new Error('network lost'))
  mocks.status.mockRejectedValue(new mocks.ApiError('no action', 404, 'REVIEW_REPLACEMENT_NOT_FOUND'))
  const { ready } = fixture(); await preview()
  fireEvent.click(screen.getByRole('button', { name: '确认检查' }))
  await screen.findByRole('button', { name: '再次确认这次检查' })
  expect(mocks.submit).toHaveBeenCalledOnce(); expect(ready).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '再次确认这次检查' }))
  fireEvent.click(await screen.findByRole('button', { name: '确认检查' }))
  await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(2))
  expect(mocks.submit.mock.calls).toEqual([['run', 'signed'], ['run', 'signed']])
  expect(mocks.preview).toHaveBeenCalledOnce()
})
it.each(['expired', 'changed selection'] as const)('an absent action with an %s retry quote permits only an explicit fresh preview and confirmation', async scenario => {
  const expiresAt = Date.now() + 300000
  const originalQuote = { ...quote, expiresAt: new Date(expiresAt).toISOString() }
  const currentModel = scenario === 'changed selection' ? { modelTier: 'ultimate' as const, reasoningEffort: 'high' as const } : model
  const freshQuote = { ...quote, quoteToken: 'fresh-signed', authorizationId: 'author:a:fresh-nonce',
    expiresAt: new Date(expiresAt + 300000).toISOString(), currentModel: { ...quote.currentModel, modelTier: currentModel.modelTier,
      reasoningEffort: currentModel.reasoningEffort, modelName: 'current-selected-model' } }
  mocks.preview.mockResolvedValueOnce(originalQuote).mockResolvedValueOnce(freshQuote)
  mocks.submit.mockRejectedValueOnce(new Error('network lost')).mockResolvedValueOnce({ ...running, authorizationId: freshQuote.authorizationId })
  mocks.status.mockRejectedValue(new mocks.ApiError('no action', 404, 'REVIEW_REPLACEMENT_NOT_FOUND'))
  const { rerender, ready } = fixture(); await preview()
  fireEvent.click(screen.getByRole('button', { name: '确认检查' }))
  await screen.findByRole('button', { name: '再次确认这次检查' })
  expect(mocks.submit).toHaveBeenCalledExactlyOnceWith('run', 'signed')
  expect(mocks.preview).toHaveBeenCalledOnce()
  expect(mocks.status).toHaveBeenCalledExactlyOnceWith('run', originalQuote.authorizationId)
  if (scenario === 'expired') vi.spyOn(Date, 'now').mockReturnValue(expiresAt + 1)
  else rerender(<AgentReviewRecovery runId="run" sessionId="session" enabled model={currentModel} onReady={ready} />)
  fireEvent.click(screen.getByRole('button', { name: '再次确认这次检查' }))
  fireEvent.click(await screen.findByRole('button', { name: '确认检查' }))
  expect(screen.getByText(/模型选择或报价已改变/)).toBeDefined()
  expect(screen.queryByRole('button', { name: '再次确认这次检查' })).toBeNull()
  const freshPreviewButton = await screen.findByRole('button', { name: '按当前模型重新检查' })
  expect(mocks.preview).toHaveBeenCalledOnce(); expect(mocks.submit).toHaveBeenCalledOnce(); expect(ready).not.toHaveBeenCalled()
  fireEvent.click(freshPreviewButton)
  await screen.findByRole('button', { name: '确认检查' })
  expect(mocks.preview).toHaveBeenCalledTimes(2)
  expect(mocks.preview.mock.calls).toEqual([['run', model], ['run', currentModel]])
  expect(mocks.submit).toHaveBeenCalledOnce()
  expect(screen.getByText(/current-selected-model/)).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: '确认检查' }))
  await waitFor(() => expect(mocks.submit).toHaveBeenCalledTimes(2))
  expect(mocks.submit.mock.calls).toEqual([['run', 'signed'], ['run', 'fresh-signed']])
  expect(ready).not.toHaveBeenCalled()
})
it('ignores late recovery in a different task window', async () => {
  let resolve!: (value: unknown) => void
  mocks.latest.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  const { rerender, ready } = fixture()
  rerender(<AgentReviewRecovery runId="other" sessionId="other-session" enabled model={model} onReady={ready} />)
  await act(async () => { resolve({ ...running, state: 'complete', message: '旧报告' }) })
  expect(ready).not.toHaveBeenCalled(); expect(screen.queryByText('旧报告')).toBeNull()
})
