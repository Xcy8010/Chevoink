import { afterEach, expect, it, vi } from 'vitest'
import { fetchManualReviewRepair, quoteManualReviewRepair, submitManualReviewRepair, AgentApiError } from '../../src/features/studio/agent/agentApi'

afterEach(() => vi.unstubAllGlobals())
const response = (data: unknown) => ({ ok: true, text: async () => JSON.stringify({ success: true, data }) })
it('uses authenticated read and quote without a repair intent', async () => {
  const fetch = vi.fn().mockResolvedValue(response({ eligible: true, status: null }))
  vi.stubGlobal('fetch', fetch)
  await fetchManualReviewRepair('run')
  await quoteManualReviewRepair('run')
  expect(fetch.mock.calls).toEqual([
    [expect.stringContaining('/api/agent/runs/run/manual-review-repair'), expect.objectContaining({ credentials: 'include' })],
    [expect.stringContaining('/api/agent/runs/run/manual-review-repair/quote'), expect.objectContaining({ credentials: 'include', method: 'POST', body: '{}' })],
  ])
  expect(fetch.mock.calls[0][1].body).toBeUndefined()
})
it('sends the exact explicit repair intent and frozen quote once', async () => {
  const fetch = vi.fn().mockResolvedValue(response({ operationId: 'operation', state: 'running' }))
  vi.stubGlobal('fetch', fetch)
  await submitManualReviewRepair('run', 'frozen-token')
  expect(fetch).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('/api/agent/runs/run/manual-review-repair'), expect.objectContaining({
    method: 'POST', credentials: 'include', body: JSON.stringify({ intent: 'repair_failed_review_once', quoteToken: 'frozen-token' }),
  }))
})
it('preserves ownership/refusal diagnostics without retrying a failed submission', async () => {
  const fetch = vi.fn().mockResolvedValue({ ok: false, status: 409, text: async () => JSON.stringify({ success: false, error: { code: 'MANUAL_REVIEW_REPAIR_REFUSED', message: '原检查结果尚未确认。' } }) })
  vi.stubGlobal('fetch', fetch)
  await expect(submitManualReviewRepair('run', 'token')).rejects.toMatchObject({ name: 'AgentApiError', status: 409, code: 'MANUAL_REVIEW_REPAIR_REFUSED', message: '原检查结果尚未确认。' } satisfies Partial<AgentApiError>)
  expect(fetch).toHaveBeenCalledOnce()
})