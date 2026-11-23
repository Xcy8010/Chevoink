import { afterEach, expect, it, vi } from 'vitest'
import { ApiClientError } from '../../src/app/api-client.js'
import { getWritingAgentSessionHistory } from '../../src/features/studio/api.js'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('retries one temporary workspace-history failure once and returns its projection', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  const success = new Response(JSON.stringify({ success: true, data: { items: [] } }), { status: 200 })
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ success: false, error: { code: 'TEMPORARILY_UNAVAILABLE' } }), { status: 503 }))
    .mockResolvedValueOnce(success)
  vi.stubGlobal('fetch', fetchMock)

  const pending = getWritingAgentSessionHistory('session-a')
  await vi.advanceTimersByTimeAsync(180)
  await expect(pending).resolves.toEqual([])
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(fetchMock.mock.calls[0][0]).toBe('/api/agent/sessions/session-a/history/workspace')
})

it('does not retry authorization failures', async () => {
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    success: false, error: { code: 'AGENT_SESSION_FORBIDDEN', message: 'forbidden' },
  }), { status: 403 }))
  vi.stubGlobal('fetch', fetchMock)

  await expect(getWritingAgentSessionHistory('session-a')).rejects.toMatchObject<ApiClientError>({ status: 403 })
  expect(fetchMock).toHaveBeenCalledOnce()
})
