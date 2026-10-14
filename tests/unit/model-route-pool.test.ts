import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const { findFirst } = vi.hoisted(() => ({ findFirst: vi.fn() }))
vi.mock('../../api/lib/prisma.js', () => ({ prisma: { aiModelConfig: { findFirst } }, DataAccessError: class extends Error { constructor(public status: number, public code: string, message: string) { super(message) } } }))
vi.mock('../../api/lib/secret-box.js', () => ({ encryptSecret: (value: string) => `encrypted:${value}`, decryptSecret: (value: string) => value.replace('encrypted:', '') }))
vi.mock('../../api/config/env.js', () => ({ env: { aiTextProvider: 'deepseek', aiTextModel: 'primary', aiTextBaseUrl: 'https://primary.test/v1', aiTextApiKey: 'primary-secret' } }))
import { ModelRouteRejected, presentModelRoutes, routeRejectionMayRetry, saveModelRoutes, withModelRoutePool } from '../../api/lib/model-route-pool.js'
import type { ChatWithToolsParams } from '../../api/lib/ai-service.js'

const id = '6a18e83b-4c75-422d-8173-3e524fb64892'
const routes = [{ id, label: '账号2', provider: 'openai-compatible', modelName: 'backup', baseUrl: 'https://backup.test/v1', apiKeyCiphertext: 'encrypted:backup-secret', enabled: true }]
const params: ChatWithToolsParams = { messages: [{ role: 'user', content: '你好' }], tools: [], model: 'primary', providerBaseUrl: 'https://primary.test/v1', providerApiKey: 'primary-secret', usageLog: { userId: 'user', action: 'agent', modelTier: 'speed', multiplierBps: 0 } }
beforeEach(() => { vi.clearAllMocks(); findFirst.mockResolvedValue({ id: 'main', tier: 'speed', enabled: true, provider: 'deepseek', modelName: 'primary', baseUrl: 'https://primary.test/v1', apiKeyCiphertext: 'encrypted:primary-secret', metadata: { routes } }) })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
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
    expect(invoke.mock.calls[1][0]).toMatchObject(explicit)
    expect(invoke.mock.calls[1][0].messages).toBe(explicit.messages)
    expect(invoke.mock.calls[1][0].usageLog).toBe(explicit.usageLog)
    expect(invoke.mock.calls[1][0].signal).toBeInstanceOf(AbortSignal)
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

  it.each(['missing-config', 'no-alternates', 'disabled-alternates', 'explicit-model', 'explicit-provider', 'explicit-endpoint', 'explicit-key'] as const)(
    'waits once on a confirmed no-usage builtin 429 for %s, retaining all request identity and price', async scenario => {
      vi.useFakeTimers()
      if (scenario === 'missing-config') findFirst.mockResolvedValue(null)
      if (scenario === 'no-alternates' || scenario === 'disabled-alternates') findFirst.mockResolvedValue({ id: 'main', metadata: {
        routes: scenario === 'no-alternates' ? [] : routes.map(route => ({ ...route, enabled: false })),
      } })
      const request = { ...params, provider: 'deepseek', usageLog: { ...params.usageLog, userId: `builtin-${scenario}`, multiplierBps: 12000 },
        ...(scenario === 'explicit-model' ? { model: 'selected-model' } : {}),
        ...(scenario === 'explicit-provider' ? { provider: 'selected-provider' } : {}),
        ...(scenario === 'explicit-endpoint' ? { providerBaseUrl: 'https://selected.test/v1' } : {}),
        ...(scenario === 'explicit-key' ? { providerApiKey: 'selected-key' } : {}),
      }
      const invoke = vi.fn().mockRejectedValueOnce(new ModelRouteRejected(429)).mockResolvedValueOnce('ok')
      const pending = withModelRoutePool(request, invoke)
      await vi.advanceTimersByTimeAsync(59_999)
      expect(invoke).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(await pending).toBe('ok')
      expect(invoke).toHaveBeenCalledTimes(2)
      const [first, retry] = invoke.mock.calls.map(call => call[0])
      for (const actual of [first, retry]) {
        expect(actual).toMatchObject(request)
        expect(actual.messages).toBe(request.messages)
        expect(actual.tools).toBe(request.tools)
        expect(actual.usageLog).toBe(request.usageLog)
      }
      expect(first.signal).toBe(retry.signal)
    })

  it.each(['120', 'http-date'] as const)('honors the supplied %s Retry-After without a premature dispatch', async header => {
    vi.useFakeTimers()
    findFirst.mockResolvedValue(null)
    const retryAfter = header === 'http-date' ? new Date(Date.now() + 120_000).toUTCString() : header
    const invoke = vi.fn().mockRejectedValueOnce(new ModelRouteRejected(429, retryAfter)).mockResolvedValueOnce('ok')
    const pending = withModelRoutePool({ ...params, usageLog: { ...params.usageLog, userId: `delay-${header}` } }, invoke)
    await vi.advanceTimersByTimeAsync(119_000)
    expect(invoke).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await pending).toBe('ok')
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it.each([undefined, 'invalid', '0', '-1'] as const)('keeps the one-minute default for missing/invalid/short Retry-After %s', value => {
    expect(new ModelRouteRejected(429, value).cooldownMs).toBe(60_000)
  })

  it('does not call a fixed route after a pre-abort or dispatch a retry after caller deadline', async () => {
    vi.useFakeTimers()
    findFirst.mockResolvedValue(null)
    const aborted = new AbortController(); aborted.abort(new Error('already stopped'))
    const invoke = vi.fn().mockRejectedValue(new ModelRouteRejected(429))
    await expect(withModelRoutePool({ ...params, signal: aborted.signal }, invoke)).rejects.toThrow('already stopped')
    expect(invoke).not.toHaveBeenCalled()
    const controller = new AbortController()
    const pending = withModelRoutePool({ ...params, signal: controller.signal, usageLog: { ...params.usageLog, userId: 'deadline' } }, invoke)
    const assertion = expect(pending).rejects.toThrow('caller deadline')
    setTimeout(() => controller.abort(new Error('caller deadline')), 59_000)
    await vi.advanceTimersByTimeAsync(59_000)
    await assertion
    await vi.advanceTimersByTimeAsync(120_000)
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('uses one original 360-second deadline even when the retry is still awaiting the provider', async () => {
    vi.useFakeTimers()
    findFirst.mockResolvedValue(null)
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(delay => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new Error('original timeout')), delay)
      return controller.signal
    })
    const invoke = vi.fn().mockRejectedValueOnce(new ModelRouteRejected(429, '300'))
      .mockImplementationOnce(({ signal }: ChatWithToolsParams) => new Promise((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
      }))
    const pending = withModelRoutePool({ ...params, usageLog: { ...params.usageLog, userId: 'original-timeout' } }, invoke)
    const assertion = expect(pending).rejects.toThrow('original timeout')
    await vi.advanceTimersByTimeAsync(300_000)
    expect(invoke).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(60_000)
    await assertion
    expect(timeout).toHaveBeenCalledExactlyOnceWith(360_000)
    expect(invoke.mock.calls[0][0].signal).toBe(invoke.mock.calls[1][0].signal)
  })

  it('stops after the builtin retry is rejected and applies its cooldown only to the exact route', async () => {
    vi.useFakeTimers()
    findFirst.mockResolvedValue(null)
    const request = { ...params, usageLog: { ...params.usageLog, userId: 'repeated-builtin' } }
    const invoke = vi.fn().mockRejectedValue(new ModelRouteRejected(429))
    const pending = withModelRoutePool(request, invoke)
    const assertion = expect(pending).rejects.toThrow('系统已等待后安全重试一次')
    await vi.advanceTimersByTimeAsync(60_000)
    await assertion
    expect(invoke).toHaveBeenCalledTimes(2)
    const next = vi.fn().mockResolvedValue('ok')
    const nextRequest = withModelRoutePool(request, next)
    await vi.advanceTimersByTimeAsync(59_000)
    expect(next).not.toHaveBeenCalled()
    const differentProvider = vi.fn().mockResolvedValue('other')
    expect(await withModelRoutePool({ ...request, provider: 'other-provider' }, differentProvider)).toBe('other')
    expect(differentProvider).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await nextRequest).toBe('ok')
    expect(next).toHaveBeenCalledTimes(1)
  })

  it.each([new TypeError('fetch failed'), Object.assign(new Error('429 usage already reported'), { upstreamStatus: 429 }),
    new ModelRouteRejected(503)])('never retries a fixed route without explicit safe 429 rejection: %s', async error => {
    findFirst.mockResolvedValue(null)
    const invoke = vi.fn().mockRejectedValue(error)
    await expect(withModelRoutePool({ ...params, usageLog: { ...params.usageLog, userId: `non-retry-${error.message}` } }, invoke)).rejects.toBe(error)
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('keeps durable operations outside automatic retries, including explicit rejected attempts', async () => {
    const durable = { ...params, durableExecution: {} as NonNullable<ChatWithToolsParams['durableExecution']> }
    const error = new ModelRouteRejected(429)
    const invoke = vi.fn().mockRejectedValue(error)
    await expect(withModelRoutePool(durable, invoke)).rejects.toBe(error)
    expect(invoke).toHaveBeenCalledExactlyOnceWith(durable)
    expect(findFirst).not.toHaveBeenCalled()
  })
})
