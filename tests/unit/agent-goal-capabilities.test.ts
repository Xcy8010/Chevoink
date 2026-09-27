import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchAgentGoalCapabilities } from '../../src/features/studio/agent/agentApi'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('agent goal capability gate', () => {
  it('reads the authenticated feature capability envelope', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ success: true, requestId: 'request-1', data: { enabled: true } }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchAgentGoalCapabilities()).resolves.toEqual({ enabled: true })
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/agent/goal-capabilities'), expect.objectContaining({ credentials: 'include' }))
  })

  it('keeps a disabled capability disabled', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ success: true, requestId: 'request-2', data: { enabled: false } }),
    }))

    await expect(fetchAgentGoalCapabilities()).resolves.toEqual({ enabled: false })
  })
})
