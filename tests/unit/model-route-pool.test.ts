import { beforeEach, describe, expect, it, vi } from 'vitest'
const { findFirst } = vi.hoisted(() => ({ findFirst: vi.fn() }))
vi.mock('../../api/lib/prisma.js', () => ({ prisma: { aiModelConfig: { findFirst } }, DataAccessError: class extends Error { constructor(public status: number, public code: string, message: string) { super(message) } } }))
vi.mock('../../api/lib/secret-box.js', () => ({ encryptSecret: (value: string) => `encrypted:${value}`, decryptSecret: (value: string) => value.replace('encrypted:', '') }))
vi.mock('../../api/config/env.js', () => ({ env: { aiTextModel: 'primary', aiTextBaseUrl: 'https://primary.test/v1', aiTextApiKey: 'primary-secret' } }))
import { ModelRouteRejected, presentModelRoutes, routeRejectionMayRetry, saveModelRoutes, withModelRoutePool } from '../../api/lib/model-route-pool.js'
import type { ChatWithToolsParams } from '../../api/lib/ai-service.js'

const id = '6a18e83b-4c75-422d-8173-3e524fb64892'
const routes = [{ id, label: '账号2', provider: 'openai-compatible', modelName: 'backup', baseUrl: 'https://backup.test/v1', apiKeyCiphertext: 'encrypted:backup-secret', enabled: true }]
const params: ChatWithToolsParams = { messages: [{ role: 'user', content: '你好' }], tools: [], model: 'primary', providerBaseUrl: 'https://primary.test/v1', providerApiKey: 'primary-secret', usageLog: { userId: 'user', action: 'agent', modelTier: 'speed', multiplierBps: 0 } }
beforeEach(() => { vi.clearAllMocks(); findFirst.mockResolvedValue({ id: 'main', tier: 'speed', enabled: true, provider: 'deepseek', modelName: 'primary', baseUrl: 'https://primary.test/v1', apiKeyCiphertext: 'encrypted:primary-secret', metadata: { routes } }) })
describe('built-in route pools', () => {
  it('encrypts new credentials and never returns them to admin reads', () => {
    const stored = saveModelRoutes([{ label: '第二账号', provider: 'deepseek', modelName: 'deepseek-chat', baseUrl: 'https://example.test/v1', apiKey: 'secret-123', enabled: true }], {}, ['low'])
    expect(stored[0].apiKeyCiphertext).toBe('encrypted:secret-123')
    expect(JSON.stringify(presentModelRoutes({ routes: stored }))).not.toContain('secret-123')
    expect(saveModelRoutes([{ id: stored[0].id, label: '改名', provider: 'deepseek', modelName: 'deepseek-chat', baseUrl: 'https://example.test/v1', enabled: true }], { routes: stored }, ['low'])[0].apiKeyCiphertext).toBe(stored[0].apiKeyCiphertext)
  })
  it('rejects forged IDs and incompatible provider capabilities', () => {
    const route = { id, label: '线路', provider: 'deepseek', modelName: 'm', baseUrl: 'https://example.test', enabled: true }
    expect(() => saveModelRoutes([route], {}, ['low'])).toThrow()
    expect(() => saveModelRoutes([route], { routes }, ['xhigh'])).toThrow()
    expect(() => saveModelRoutes([{ ...route, provider: 'openai', contextWindowTokens: 16000 }], { routes }, ['low'], { contextWindowTokens: 128000, visionEnabled: false })).toThrow()
    expect(() => saveModelRoutes([{ ...route, provider: 'openai', visionEnabled: false }], { routes }, ['low'], { contextWindowTokens: 128000, visionEnabled: true })).toThrow()
  })
  it('does not replay paid or partly observed failures', () => {
    expect(routeRejectionMayRetry(429, 0, 0)).toBe(true)
    expect(routeRejectionMayRetry(503, undefined, undefined)).toBe(true)
    expect(routeRejectionMayRetry(503, 20, 0)).toBe(false)
    expect(routeRejectionMayRetry(503, 0, undefined)).toBe(false)
    expect(routeRejectionMayRetry(400, undefined, undefined)).toBe(false)
  })
  it('fails over only on explicit HTTP rejection with the same messages and tier price', async () => {
    const invoke = vi.fn().mockRejectedValueOnce(new ModelRouteRejected(429)).mockResolvedValueOnce('ok')
    expect(await withModelRoutePool(params, invoke)).toBe('ok')
    expect(invoke).toHaveBeenCalledTimes(2)
    const [first, second] = invoke.mock.calls.map(call => call[0])
    expect(first.providerApiKey).not.toBe(second.providerApiKey)
    expect(second.messages).toBe(params.messages)
    expect(second.usageLog).toBe(params.usageLog)
  })
  it('does not replay unknown network outcomes or a cancelled request', async () => {
    const invoke = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    await expect(withModelRoutePool(params, invoke)).rejects.toThrow('fetch failed')
    expect(invoke).toHaveBeenCalledTimes(1)
    const abort = new AbortController(); abort.abort()
    invoke.mockClear()
    await expect(withModelRoutePool({ ...params, signal: abort.signal }, invoke)).rejects.toThrow()
    expect(invoke).not.toHaveBeenCalled()
  })
  it('does not reroute BYOK or an explicitly different auxiliary model', async () => {
    const invoke = vi.fn().mockResolvedValue('ok')
    await withModelRoutePool({ ...params, usageLog: { ...params.usageLog, modelTier: 'custom' } }, invoke)
    expect(findFirst).not.toHaveBeenCalled()
    const explicit = { ...params, model: 'special' }
    await withModelRoutePool(explicit, invoke)
    expect(invoke.mock.calls[1][0]).toBe(explicit)
  })
  it('retries a BYOK 429 once after its cooldown without changing its model or account', async () => {
    vi.useFakeTimers()
    try {
      const byok = { ...params, usageLog: { ...params.usageLog, modelTier: 'custom' }, providerApiKey: 'byok-secret' }
      const invoke = vi.fn().mockRejectedValueOnce(new ModelRouteRejected(429)).mockResolvedValueOnce('ok')
      const pending = withModelRoutePool(byok, invoke)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(await pending).toBe('ok')
      expect(invoke).toHaveBeenCalledTimes(2)
      expect(invoke.mock.calls[1][0]).toMatchObject({ model: byok.model, providerBaseUrl: byok.providerBaseUrl, providerApiKey: 'byok-secret' })
    } finally {
      vi.useRealTimers()
    }
  })
  it('returns an actionable Chinese error after the single safe BYOK retry is still rate limited', async () => {
    vi.useFakeTimers()
    try {
      const invoke = vi.fn().mockRejectedValue(new ModelRouteRejected(429))
      const pending = withModelRoutePool({ ...params, usageLog: { ...params.usageLog, modelTier: 'custom' } }, invoke)
      const assertion = expect(pending).rejects.toThrow('系统已等待后安全重试一次')
      await vi.advanceTimersByTimeAsync(60_000)
      await assertion
      expect(invoke).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
