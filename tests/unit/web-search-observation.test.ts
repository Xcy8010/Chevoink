import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../api/config/env.js'
import { webSearchTool } from '../../api/lib/agent/tools/search-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

const mocks = vi.hoisted(() => ({ search: vi.fn(), charge: vi.fn(), configuration: vi.fn(), refund: vi.fn(), refundState: vi.fn(), reconcile: vi.fn() }))
// Provider POSTs use package fetch/Agent; fallback HTML uses global fetch.
// Keep both entrypoints inside the same offline response fixtures.
vi.mock('undici', async original => ({ ...await original<typeof import('undici')>(),
  fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
}))
vi.mock('../../api/lib/billing/web-tool-calls.js', () => ({
  findWebToolCallOutcome: vi.fn(async () => null), saveWebToolCacheOutcome: vi.fn(async () => {}),
  executeWebToolCall: mocks.charge, refundCancelledWebToolCall: mocks.refund,
}))
vi.mock('../../api/lib/web-search-service.js', async original => ({ ...await original<object>(), searchWeb: mocks.search }))
vi.mock('../../api/lib/credits.js', () => ({ consumeCredits: mocks.charge, WEB_SEARCH_CALL_MILLI: 2000,
  recordSearchRefundIntent: mocks.refund, getSearchRefundState: mocks.refundState, reconcileCreditRefunds: mocks.reconcile }))
vi.mock('../../api/lib/tool-model-config.js', async original => ({ ...await original<object>(), getToolModelRuntime: mocks.configuration }))
vi.mock('../../api/lib/agent/research-sources.js', async original => ({
  ...await original<typeof import('../../api/lib/agent/research-sources.js')>(),
  reserveResearchRequest: vi.fn(async () => true),
  settleResearchRequest: vi.fn(async () => {}),
  findResearchSearchOutcome: vi.fn(async () => null),
  getResearchReadTarget: vi.fn(async () => undefined),
  saveResearchSearchOutcome: vi.fn(async () => {}),
  registerResearchSources: async (_scope: unknown, entries: Array<{ url: string }>) => entries.map((entry, index) => ({ id: `source-${index}`, canonicalUrl: entry.url })),
}))

const originalProvider = env.webSearchProvider
const originalKey = env.webSearchBochaApiKey
beforeEach(() => { mocks.search.mockReset(); mocks.charge.mockReset().mockImplementation(async (_ctx, _kind, _request, _paid, dispatch) => dispatch()); mocks.configuration.mockReset().mockResolvedValue(null)
  mocks.refund.mockReset().mockResolvedValue({}); mocks.refundState.mockReset().mockResolvedValue(null); mocks.reconcile.mockReset().mockResolvedValue({ examined: 1, settled: 1 }) })
afterEach(() => { env.webSearchProvider = originalProvider; env.webSearchBochaApiKey = originalKey; vi.unstubAllGlobals() })
const context = (): ToolContext => ({ userId: 'fixture', novelId: 'fixture', chapterId: null, sessionId: 'fixture',
  runId: randomUUID(), callId: randomUUID(), mode: 'build', creativeFreedom: 'balanced', qualityMode: 'premium', signal: new AbortController().signal, emit: vi.fn() })

describe('search URL handoff to the model', () => {
  it('rejects an invalid configured provider before reserving, charging or dispatching', async () => {
    const { reserveResearchRequest } = await import('../../api/lib/agent/research-sources.js')
    vi.mocked(reserveResearchRequest).mockClear()
    mocks.configuration.mockResolvedValue({ provider: 'unknown', modelName: 'web', baseUrl: 'https://search.example.com', apiKey: 'private-fixture' })
    await expect(webSearchTool.execute(context(), { query: 'public query', maxResults: 2 })).rejects.toMatchObject({ code: 'WEB_TOOL_PROVIDER_UNSUPPORTED' })
    expect(reserveResearchRequest).not.toHaveBeenCalled()
    expect(mocks.charge).not.toHaveBeenCalled()
    expect(mocks.search).not.toHaveBeenCalled()
  })
  it('reuses a persisted same-task search after process-local cache loss without charging again', async () => {
    const { findResearchSearchOutcome, saveResearchSearchOutcome } = await import('../../api/lib/agent/research-sources.js')
    vi.mocked(findResearchSearchOutcome).mockResolvedValueOnce({ provider: 'bocha', results: [] })
    const savedBefore = vi.mocked(saveResearchSearchOutcome).mock.calls.length
    const result = await webSearchTool.execute(context(), { query: '已保存的目录查询', maxResults: 2 })
    expect(result.output).toContain('没有返回结果')
    expect(mocks.search).not.toHaveBeenCalled()
    expect(mocks.charge).not.toHaveBeenCalled()
    expect(vi.mocked(saveResearchSearchOutcome).mock.calls).toHaveLength(savedBefore)
  })
  it('releases a reservation cancelled before charging and never dispatches it', async () => {
    const { reserveResearchRequest, settleResearchRequest } = await import('../../api/lib/agent/research-sources.js')
    const controller = new AbortController()
    const ctx = { ...context(), signal: controller.signal }
    vi.mocked(reserveResearchRequest).mockImplementationOnce(async () => { controller.abort(new Error('cancel during reservation')); return true })
    await expect(webSearchTool.execute(ctx, { query: '目录', maxResults: 2 })).rejects.toThrow('cancel during reservation')
    expect(settleResearchRequest).toHaveBeenCalledWith(ctx, 'released')
    expect(mocks.charge).not.toHaveBeenCalled()
    expect(mocks.search).not.toHaveBeenCalled()
  })
  it('identifies search endpoint 404 without leaking upstream details or calling it a missing book', async () => {
    const { WebSearchError } = await vi.importActual<typeof import('../../api/lib/web-search-service.js')>('../../api/lib/web-search-service.js')
    mocks.search.mockRejectedValue(new WebSearchError('private upstream detail', [
      { provider: 'bocha', outcome: 'failed', durationMs: 10, httpStatus: 404, providerRequestId: 'private-request-id' },
    ]))
    const result = await webSearchTool.execute(context(), { query: '番茄小说', maxResults: 2 })
    expect(result).toHaveProperty('outcome', 'failed')
    expect(result.output).toContain('搜索接口 HTTP 404')
    expect(result.output).toContain('不是小说正文地址的404')
    expect(result.output).not.toContain('private')
  })
  it.each(['CREDIT_IDEMPOTENCY_CONFLICT', 'CREDITS_EXHAUSTED'])('does not disguise %s as a provider failure or dispatch another paid request', async code => {
    const { DataAccessError } = await import('../../api/lib/prisma.js')
    mocks.charge.mockRejectedValue(new DataAccessError(409, code, 'fixture wallet refusal'))
    await expect(webSearchTool.execute(context(), { query: '目录', maxResults: 2 })).rejects.toMatchObject({ code })
    expect(mocks.search).not.toHaveBeenCalled()
    expect(mocks.refund).not.toHaveBeenCalled()
  })
  it('classifies empty results as free and deduplicates them while retaining the legacy refund replay guard', async () => {
    const ctx = context()
    mocks.search.mockResolvedValue({ provider: 'bocha', results: [] })
    await webSearchTool.execute(ctx, { query: '空查询', maxResults: 2 })
    await webSearchTool.execute({ ...ctx, callId: randomUUID() }, { query: '空查询', maxResults: 2 })
    expect(mocks.charge).toHaveBeenCalledOnce()
    expect(mocks.search).toHaveBeenCalledOnce()
    expect(mocks.charge.mock.calls[0][5]({ provider: 'bocha', results: [] })).toBe('empty')
    const { WebSearchError } = await vi.importActual<typeof import('../../api/lib/web-search-service.js')>('../../api/lib/web-search-service.js')
    const attempts = [{ provider: 'bocha' as const, outcome: 'failed' as const, durationMs: 12 }]
    const failedCtx = { ...ctx, callId: randomUUID() }
    mocks.search.mockRejectedValue(new WebSearchError('unavailable', attempts))
    mocks.reconcile.mockRejectedValue(new Error('database temporarily unavailable'))
    await expect(webSearchTool.execute(failedCtx, { query: '不同查询', maxResults: 2 })).resolves.toHaveProperty('outcome', 'failed')
    expect(mocks.charge).toHaveBeenLastCalledWith(failedCtx, 'search', { query: '不同查询', count: 2 }, expect.any(Boolean), expect.any(Function), expect.any(Function))
    mocks.refundState.mockResolvedValue('pending')
    await webSearchTool.execute(failedCtx, { query: '不同查询', maxResults: 2 })
    expect(mocks.search).toHaveBeenCalledTimes(2)
    expect(mocks.charge).toHaveBeenCalledTimes(2)
  })
  it.each(['count', 'provider', 'configuration', 'admin-configuration', 'user'] as const)('reuses an exact search but isolates changed %s', async changed => {
    const ctx = context()
    mocks.search.mockResolvedValue({ provider: 'bocha', results: [{ title: '目录', url: 'https://example.com/book?id=19', source: 'example.com', snippet: '目录信息' }] })
    await webSearchTool.execute(ctx, { query: '小说  目录', maxResults: 2 })
    await webSearchTool.execute({ ...ctx, callId: randomUUID() }, { query: '小说 目录', maxResults: 2 })
    expect(mocks.search).toHaveBeenCalledOnce()
    expect(mocks.charge).toHaveBeenCalledOnce()
    if (changed === 'provider') env.webSearchProvider = originalProvider === 'bing' ? 'auto' : 'bing'
    if (changed === 'configuration') env.webSearchBochaApiKey = 'fixture-rotated-not-real'
    if (changed === 'admin-configuration') mocks.configuration.mockResolvedValue({ provider: 'bocha', modelName: 'web', baseUrl: 'https://search.example.com/v1/web-search', apiKey: 'fixture-not-real' })
    await webSearchTool.execute({ ...ctx, callId: randomUUID(), userId: changed === 'user' ? 'other-fixture' : ctx.userId },
      { query: '小说 目录', maxResults: changed === 'count' ? 8 : 2 })
    expect(mocks.search).toHaveBeenCalledTimes(2)
    expect(mocks.charge).toHaveBeenCalledTimes(2)
  })
  it('distinguishes provider failure from an empty result without suggesting fabricated book facts', async () => {
    mocks.search.mockRejectedValueOnce(new Error('provider-secret-or-private-query'))
    const failed = await webSearchTool.execute(context(), { query: '指定小说', maxResults: 6 })
    expect(failed).toMatchObject({ outcome: 'failed', summary: '联网搜索不可用' })
    expect(failed.output).not.toContain('provider-secret')
    expect(failed.output).not.toContain('基于既有知识完成')
    mocks.search.mockResolvedValueOnce({ provider: 'bocha', results: [] })
    const empty = await webSearchTool.execute(context(), { query: '指定小说', maxResults: 6 })
    expect(empty).not.toHaveProperty('outcome', 'failed')
    expect(empty.output).toContain('不代表目标书不存在')
  })
  it('does not disguise cancellation as an unavailable search or admit a cancelled cache hit', async () => {
    const controller = new AbortController()
    const ctx = { ...context(), signal: controller.signal }
    mocks.search.mockImplementation(async () => {
      controller.abort(new Error('author stopped'))
      return { provider: 'bocha', results: [] }
    })
    await expect(webSearchTool.execute(ctx, { query: '目录', maxResults: 2 })).rejects.toThrow('author stopped')
    await expect(webSearchTool.execute(ctx, { query: '目录', maxResults: 2 })).rejects.toThrow('author stopped')
    expect(mocks.search).toHaveBeenCalledOnce()
    expect(mocks.charge).toHaveBeenCalledOnce()
  })
  it('delegates attempted-search cancellation to the durable billing boundary and propagates the stop', async () => {
    const { WebSearchError } = await vi.importActual<typeof import('../../api/lib/web-search-service.js')>('../../api/lib/web-search-service.js')
    const controller = new AbortController()
    const ctx = { ...context(), signal: controller.signal }
    const attempts = [{ provider: 'bocha' as const, outcome: 'aborted' as const, durationMs: 20 }]
    mocks.search.mockImplementation(async () => {
      controller.abort(new Error('author stopped'))
      throw new WebSearchError('搜索已取消', attempts)
    })
    await expect(webSearchTool.execute(ctx, { query: '目录', maxResults: 2 })).rejects.toThrow('author stopped')
    expect(mocks.charge).toHaveBeenCalledWith(ctx, 'search', { query: '目录', count: 2 }, expect.any(Boolean), expect.any(Function), expect.any(Function))
    expect(mocks.search).toHaveBeenCalledOnce()
  })
  it('refunds cancellation arriving after billing completes while research persistence is pending', async () => {
    const { saveResearchSearchOutcome } = await import('../../api/lib/agent/research-sources.js')
    const controller = new AbortController()
    const ctx = { ...context(), signal: controller.signal }
    mocks.search.mockResolvedValue({ provider: 'bocha', results: [] })
    vi.mocked(saveResearchSearchOutcome).mockImplementationOnce(async () => { controller.abort(new Error('late stop')) })
    await expect(webSearchTool.execute(ctx, { query: 'late cancellation', maxResults: 2 })).rejects.toThrow('late stop')
    expect(mocks.refund).toHaveBeenCalledWith(ctx, 'search', { query: 'late cancellation', count: 2 })
  })
  it('delivers the same complete URL to observation and UI without guessing or dropping query parameters', async () => {
    const result = { title: '作品目录', url: 'https://example.com/chapter?id=19&page=2', source: 'example.com', snippet: '公开目录信息。' }
    mocks.search.mockResolvedValue({ provider: 'bocha', results: [result] })
    const context: ToolContext = { userId: 'fixture', novelId: 'fixture', chapterId: null, sessionId: 'fixture',
      runId: randomUUID(), callId: randomUUID(), mode: 'build', creativeFreedom: 'balanced', qualityMode: 'premium', signal: new AbortController().signal, emit: vi.fn() }
    const output = await webSearchTool.execute(context, { query: '公开目录', maxResults: 6 })
    expect(output.output).toContain(`URL: ${result.url}`)
    expect(output.output).toContain('sourceId: source-0')
    expect(output.display).toMatchObject({ kind: 'webSearch', results: [result] })
    expect(mocks.search).toHaveBeenCalledOnce()
  })
})

describe('provider response boundaries', () => {
  const actualSearch = async () => (await vi.importActual<typeof import('../../api/lib/web-search-service.js')>('../../api/lib/web-search-service.js')).searchWeb
  const entry = (url: string) => ({ name: '公开章节', url, summary: '公开摘要' })
  it('cancels rejected response bodies before starting fallback requests', async () => {
    env.webSearchProvider = 'bocha'
    const cancelled: number[] = []
    let index = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      expect(cancelled).toHaveLength(index)
      const current = index++
      return new Response(new ReadableStream<Uint8Array>({ cancel: () => { cancelled.push(current) } }), { status: 503 })
    }))
    await expect((await actualSearch())('目录', 2, undefined, null)).rejects.toThrow('所有搜索引擎')
    expect(cancelled).toEqual([0, 1, 2])
  })
  it('keeps request identity and HTTP/business status for failed attempts without storing response prose', async () => {
    env.webSearchProvider = 'bocha'
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ code: 401, log_id: 'provider-log-19', msg: 'private-response-do-not-store' }, { headers: { 'x-request-id': 'header-id' } }))
      .mockImplementation(async () => new Response('private-response-do-not-store', { status: 503, headers: { 'x-request-id': 'https://private.example/query?secret=1' } }))
    vi.stubGlobal('fetch', fetcher)
    const error = await (await actualSearch())('目录', 2, undefined, null).catch((value: unknown) => value)
    expect(error).toMatchObject({ attempts: [
      expect.objectContaining({ provider: 'bocha', httpStatus: 200, providerCode: '401', providerRequestId: 'provider-log-19' }),
      expect.objectContaining({ provider: 'sogou', httpStatus: 503 }), expect.objectContaining({ provider: 'bing', httpStatus: 503 }),
    ] })
    expect(JSON.stringify(error)).not.toContain('private-response')
    expect(JSON.stringify(error)).not.toContain('secret=1')
    expect(fetcher.mock.calls[0][1]).toHaveProperty('redirect', 'error')
  })
  it.each([{ code: 401, data: { webPages: { value: [] } } }, { code: 200, data: {} }, { code: 200, data: { webPages: { value: 'invalid' } } }])('never treats malformed or business-error responses as empty: %j', async payload => {
    env.webSearchProvider = 'bocha'
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(payload))
      .mockImplementation(async () => new Response('unavailable', { status: 503 }))
    vi.stubGlobal('fetch', fetcher)
    await expect((await actualSearch())('目录', 2, undefined, null)).rejects.toMatchObject({
      attempts: [expect.objectContaining({ provider: 'bocha', outcome: 'failed' }),
        expect.objectContaining({ provider: 'sogou', outcome: 'failed' }), expect.objectContaining({ provider: 'bing', outcome: 'failed' })],
    })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
  it('retains a genuinely empty response when fallback providers fail', async () => {
    env.webSearchProvider = 'bocha'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ code: 200, data: { webPages: { value: [] } } }))
      .mockImplementation(async () => new Response('', { status: 503 })))
    await expect((await actualSearch())('目录', 2, undefined, null)).resolves.toMatchObject({ provider: 'bocha', results: [],
      attempts: [expect.objectContaining({ outcome: 'empty' }), expect.objectContaining({ outcome: 'failed' }), expect.objectContaining({ outcome: 'failed' })] })
  })
  it('bounds, deduplicates and filters source URLs without losing meaningful query parameters', async () => {
    env.webSearchProvider = 'bocha'
    const url = 'https://example.com/chapter?id=19&page=2'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ code: 200, data: { webPages: { value: [
      entry('http://127.0.0.1/secret'), entry(url), entry(url), entry('https://example.com/chapter?id=20'), entry('https://example.com/chapter?id=21'),
    ] } } })))
    const result = await (await actualSearch())('目录', 2, undefined, null)
    expect(result.results.map(item => item.url)).toEqual([url, 'https://example.com/chapter?id=20'])
    expect(result.attempts).toEqual([expect.objectContaining({ provider: 'bocha', outcome: 'results' })])
  })
  it('preserves cancelled attempt evidence without starting another provider', async () => {
    env.webSearchProvider = 'bocha'
    const controller = new AbortController()
    const fetcher = vi.fn(async () => {
      controller.abort(new Error('stopped'))
      throw controller.signal.reason
    })
    vi.stubGlobal('fetch', fetcher)
    await expect((await actualSearch())('目录', 2, controller.signal, null)).rejects.toMatchObject({
      attempts: [expect.objectContaining({ provider: 'bocha', outcome: 'aborted' })],
    })
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it('does not start any request after cancellation', async () => {
    env.webSearchProvider = 'bocha'
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const controller = new AbortController()
    controller.abort(new Error('stopped'))
    await expect((await actualSearch())('目录', 2, controller.signal, null)).rejects.toThrow('stopped')
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('leaves fallback time after a provider timeout and keeps a sequential attempt trace', async () => {
    vi.useFakeTimers()
    const timeout = env.webSearchTimeoutMs
    env.webSearchTimeoutMs = 1000
    env.webSearchProvider = 'bocha'
    try {
      const search = await actualSearch()
      const fetcher = vi.fn().mockImplementationOnce(async (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
      })).mockResolvedValueOnce(new Response('<div class="vrwrap" data-url="https://example.com/chapter?id=19"><h3 class="vr-title"><a href="https://example.com/chapter?id=19">章节目录</a></h3><p>公开目录</p></div>'))
      vi.stubGlobal('fetch', fetcher)
      const pending = search('目录', 2, undefined, null)
      await vi.advanceTimersByTimeAsync(500)
      const result = await pending
      expect(result.provider).toBe('sogou')
      expect(result.attempts).toEqual([
        { provider: 'bocha', outcome: 'failed', durationMs: 500 },
        { provider: 'sogou', outcome: 'results', durationMs: 0, httpStatus: 200 },
      ])
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(0)
    } finally { env.webSearchTimeoutMs = timeout; vi.useRealTimers() }
  })
})
