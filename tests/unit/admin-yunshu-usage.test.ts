import { beforeEach, expect, it, vi } from 'vitest'
import { createAdminYunshuUsageService } from '../../api/lib/admin-yunshu-usage.js'
import { clearToolModelRuntimeCache } from '../../api/lib/tool-model-config.js'
import { env } from '../../api/config/env.js'
const mocks = vi.hoisted(() => ({ models: vi.fn(), count: vi.fn(), modelFirst: vi.fn(), binding: vi.fn() }))
vi.mock('../../api/lib/prisma.js', async original => ({ ...await original<object>(), prisma: { aiModelConfig: { findMany: mocks.models, count: mocks.count, findFirst: mocks.modelFirst }, aiModelSystemBinding: { findUnique: mocks.binding } } }))
vi.mock('../../api/lib/secret-box.js', () => ({ decryptSecret: (value: string) => value.replace('cipher:', '') }))
const now = Date.parse('2026-11-04T04:30:00Z')
const log = (patch: Record<string, unknown> = {}) => ({ token_id: 7, type: 2, created_at: now / 1000 - 60, model_name: 'upstream-model', group: 'default', request_id: 'actual-request', prompt_tokens: 200, completion_tokens: 50, other: JSON.stringify({ cache_tokens: 100, cache_creation_tokens: 20, cache_creation_tokens_5m: 20 }), ...patch })
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
function fixture(rows = [log()]) {
  let time = now
  const fetcher = vi.fn<typeof fetch>(async input => String(input).includes('/token') ? json({ success: true, data: [{ token_id: 7 }] }) : json({ success: true, data: { page: 1, page_size: 100, total: rows.length, items: rows } }))
  const loadToken = vi.fn(async () => 'nap_fake_protected_admin')
  const loadSources = vi.fn(async () => [{ identity: 'model:revision:1', key: 'sk-synthetic-private' }])
  const service = createAdminYunshuUsageService({ fetch: fetcher, now: () => time, loadToken, loadSources })
  return { service, fetcher, loadToken, loadSources, advance: () => { time += 61000 } }
}
beforeEach(() => { vi.clearAllMocks(); clearToolModelRuntimeCache(); mocks.models.mockResolvedValue([]); mocks.count.mockResolvedValue(1); mocks.modelFirst.mockResolvedValue(null); mocks.binding.mockResolvedValue(null) })
it('does not access sources or network without a protected administrator token', async () => {
  const f = fixture(); f.loadToken.mockResolvedValue('')
  const result = await f.service.read('today')
  expect(result.state).toBe('unconfigured'); expect(f.loadSources).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled()
})
it('does not start reads after caller cancellation', async () => {
  const f = fixture(), controller = new AbortController()
  controller.abort()
  await expect(f.service.read('today', controller.signal)).rejects.toThrow()
  expect(f.loadToken).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled()
})
it('uses only fixed GET URLs and authorization headers, filters token identity and separates errors/refunds/cache', async () => {
  const f = fixture([log(), log({ token_id: 8, request_id: 'other-app', prompt_tokens: 999 }), log({ type: 5 }), log({ type: 6 }), log({ type: 1, token_id: 0 })])
  const result = await f.service.read('today')
  expect(result).toMatchObject({ state: 'partial', coverage: 'partial', paginationComplete: true, sources: { configured: 1, verified: 1, unresolved: 0 }, models: [{ modelName: 'upstream-model', requestCount: 1, requestTokens: 200, responseTokens: 50, cacheHitTokens: 100, cacheWriteTokens: 20, errorCount: 1, refundCount: 1 }] })
  for (const [url, init] of f.fetcher.mock.calls) { expect(new URL(String(url)).origin).toBe('https://yunshu.chevolink.com'); expect(init).toMatchObject({ method: 'GET', redirect: 'error' }); expect(String(url)).not.toContain('private'); expect(String(url)).not.toContain('nap_') }
  expect(f.fetcher.mock.calls[0][1]?.headers).toEqual({ Authorization: 'Bearer sk-synthetic-private' })
  expect(f.fetcher.mock.calls[1][1]?.headers).toEqual({ Authorization: 'Bearer nap_fake_protected_admin' })
  expect(JSON.stringify(result)).not.toMatch(/synthetic-private|nap_|token_id|actual-request|quota|cipher/)
  expect(new URL(String(f.fetcher.mock.calls[1][0])).searchParams.get('start_timestamp')).toBe(String(Date.parse('2026-11-03T16:00:00Z') / 1000))
})
it('deduplicates configured keys and concurrent reads, caches only within the same scope', async () => {
  const f = fixture(); f.loadSources.mockResolvedValue([{ identity: 'one', key: 'same-key' }, { identity: 'two', key: 'same-key' }])
  const results = await Promise.all([f.service.read('week'), f.service.read('week')])
  expect(results[0]).toEqual(results[1]); expect(results[0].sources.configured).toBe(1); expect(f.fetcher).toHaveBeenCalledTimes(2)
  await f.service.read('week'); expect(f.fetcher).toHaveBeenCalledTimes(2)
  f.loadSources.mockResolvedValue([{ identity: 'changed-config', key: 'new-key' }]); f.fetcher.mockRejectedValue(new Error('SECRET-URL'))
  const failed = await f.service.read('week'); expect(failed.state).toBe('error'); expect(failed.models).toEqual([]); expect(JSON.stringify(failed)).not.toContain('SECRET')
})
it('leaves missing tokens/cache unknown and preserves stale same-scope success after failure', async () => {
  const f = fixture([log({ prompt_tokens: undefined, other: '{}' })])
  const first = await f.service.read('month')
  expect(first.models[0]).toMatchObject({ requestTokens: null, cacheHitTokens: null, cacheWriteTokens: null })
  f.advance(); f.fetcher.mockRejectedValue(new Error('private exception'))
  const failed = await f.service.read('month')
  expect(failed).toMatchObject({ state: 'stale', observedAt: first.observedAt, models: first.models }); expect(JSON.stringify(failed)).not.toContain('private exception')
})
it('does not fall back to an old successful snapshot when credentials change or configuration fails during a failed read', async () => {
  for (const change of ['token', 'source', 'unavailable']) {
    const f = fixture()
    const first = await f.service.read('today'); expect(first.models).toHaveLength(1)
    f.advance()
    let rejectRead: (error: Error) => void = () => {}
    let started: () => void = () => {}
    const reading = new Promise<void>(resolve => { started = resolve })
    f.fetcher.mockImplementationOnce(() => new Promise<Response>((_, reject) => { rejectRead = reject; started() }))
    const pending = f.service.read('today')
    await reading
    if (change === 'token') f.loadToken.mockResolvedValue('nap_changed_protected_admin')
    if (change === 'source') f.loadSources.mockResolvedValue([{ identity: 'new-source', key: 'different-key' }])
    if (change === 'unavailable') f.loadSources.mockRejectedValue(new Error('private-source-config'))
    rejectRead(new Error('private-network-error'))
    const result = await pending
    expect(result.state).toBe('error'); expect(result.models).toEqual([]); expect(result.observedAt).toBeNull()
    expect(JSON.stringify(result)).not.toContain('private-')
  }
})
it('does not query admin-wide logs for empty, mixed or missing key identities', async () => {
  for (const data of [[], [{ token_id: 7 }, { token_id: 8 }]]) {
    const f = fixture(); f.fetcher.mockResolvedValue(json({ success: true, data }))
    const result = await f.service.read('today'); expect(result.sources).toMatchObject({ verified: 0, unresolved: 1 }); expect(result.models).toEqual([]); expect(f.fetcher).toHaveBeenCalledTimes(1)
  }
  const f = fixture(); f.loadSources.mockResolvedValue([{ identity: 'empty', key: '' }]); expect((await f.service.read('today')).sources.unresolved).toBe(1); expect(f.fetcher).not.toHaveBeenCalled()
})
it('reads later pages, does not use rewritten display ids to collapse rows and marks uncertain duplicates', async () => {
  const f = fixture()
  f.fetcher.mockImplementation(async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('token')) return json({ success: true, data: [{ token_id: 7 }] })
    const page = Number(url.searchParams.get('p'))
    const items = page === 1 ? Array.from({ length: 100 }, (_, i) => ({ ...log({ request_id: `request-${i}` }), id: i + 1 })) : [{ ...log({ request_id: 'request-100' }), id: 1 }, { ...log({ request_id: 'request-99' }), id: 2 }]
    return json({ success: true, data: { page, page_size: 100, total: 102, items } })
  })
  const result = await f.service.read('today')
  expect(result.models[0].requestCount).toBe(101); expect(result.paginationComplete).toBe(false); expect(f.fetcher).toHaveBeenCalledTimes(3)
})
it('preserves identical historical rows within a page and conservatively removes repeated-page overlap', async () => {
  const historic = log({ request_id: undefined })
  const simple = fixture([historic, historic])
  const samePage = await simple.service.read('today')
  expect(samePage.models[0]).toMatchObject({ requestCount: 2, requestTokens: 400, responseTokens: 100 })
  expect(samePage.paginationComplete).toBe(false)
  const overlap = fixture()
  overlap.fetcher.mockImplementation(async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('token')) return json({ success: true, data: [{ token_id: 7 }] })
    const page = Number(url.searchParams.get('p'))
    const items = page === 1 ? [historic, historic, ...Array.from({ length: 98 }, (_, index) => log({ request_id: `unique-${index}` }))] : [historic, historic]
    return json({ success: true, data: { page, page_size: 100, total: 102, items } })
  })
  const result = await overlap.service.read('today')
  expect(result.models[0]).toMatchObject({ requestCount: 100, requestTokens: 20000 })
  expect(result.paginationComplete).toBe(false)
})
it('caps pagination at 100 pages and response bodies at 4 MiB, without returning secret error text', async () => {
  const f = fixture()
  f.fetcher.mockImplementation(async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('token')) return json({ success: true, data: [{ token_id: 7 }] })
    const page = Number(url.searchParams.get('p'))
    return json({ success: true, data: { page, page_size: 100, total: 20000, items: Array.from({ length: 100 }, (_, i) => log({ request_id: `${page}-${i}` })) } })
  })
  const result = await f.service.read('today'); expect(result.paginationComplete).toBe(false); expect(f.fetcher).toHaveBeenCalledTimes(101)
  const big = fixture(); big.fetcher.mockResolvedValue(new Response('x'.repeat(4 * 1024 * 1024 + 1)))
  expect((await big.service.read('today')).state).toBe('error')
})
it('marks a short response incomplete when the actual row count is below the reported total', async () => {
  const f = fixture()
  f.fetcher.mockImplementation(async input => String(input).includes('/token') ? json({ success: true, data: [{ token_id: 7 }] }) : json({ success: true, data: { page: 1, page_size: 100, total: 3, items: [log(), log({ request_id: 'second' })] } }))
  const result = await f.service.read('today')
  expect(result.models[0].requestCount).toBe(2); expect(result.paginationComplete).toBe(false)
})
it('does not join an older in-flight window when UTC+8 today, week or month rolls over', async () => {
  for (const period of ['today', 'week', 'month'] as const) {
    let time = Date.parse('2026-11-30T15:59:59Z')
    if (period === 'week') time = Date.parse('2026-11-29T15:59:59Z')
    let started: () => void = () => {}, release: () => void = () => {}
    const waiting = new Promise<void>(resolve => { started = resolve })
    const paused = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    const fetcher = vi.fn<typeof fetch>(async input => {
      if (String(input).includes('/token')) return json({ success: true, data: [{ token_id: 7 }] })
      if (++calls === 1) { started(); await paused }
      return json({ success: true, data: { page: 1, page_size: 100, total: 0, items: [] } })
    })
    const service = createAdminYunshuUsageService({ fetch: fetcher, now: () => time, loadToken: async () => 'nap_test', loadSources: async () => [{ identity: 'same', key: 'same' }] })
    const previous = service.read(period)
    await waiting; time += 2000
    const next = await service.read(period)
    release()
    const old = await previous
    expect(next.window.from).not.toBe(old.window.from); expect(calls).toBe(2)
  }
})
it('rejects invalid payloads and configuration changes during collection instead of applying an old scope', async () => {
  const f = fixture(); f.fetcher.mockResolvedValueOnce(json({ success: false, message: 'private upstream response' }))
  expect((await f.service.read('today')).state).toBe('error')
  const changed = fixture(); changed.loadSources.mockResolvedValueOnce([{ identity: 'one', key: 'key' }]).mockResolvedValue([{ identity: 'two', key: 'different-key' }])
  const result = await changed.service.read('today'); expect(result.state).toBe('error'); expect(result.models).toEqual([])
})
it('cancels an unsuccessful HTTP response body without exposing its content', async () => {
  const cancel = vi.fn()
  const f = fixture()
  f.fetcher.mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 403 }))
  const result = await f.service.read('today')
  expect(result.state).toBe('error'); expect(cancel).toHaveBeenCalledTimes(1)
})
it('queries only enabled platform configuration and uses actual gateway route keys without querying BYOK', async () => {
  mocks.models.mockResolvedValue([{ id: 'model', revision: 2, key: 'builtin:model', tier: 'speed', baseUrl: 'https://yunshu.chevolink.com/v1', apiKeyCiphertext: 'cipher:platform-key', metadata: {} }])
  const f = fixture()
  const service = createAdminYunshuUsageService({ loadToken: f.loadToken, fetch: f.fetcher, now: () => now })
  expect((await service.read('today')).sources.verified).toBe(1)
  expect(mocks.models).toHaveBeenCalledWith({ where: { ownerUserId: null, archivedAt: null, enabled: true } })
  expect(f.fetcher.mock.calls[0][1]?.headers).toEqual({ Authorization: 'Bearer platform-key' })
})
it('uses the tool system binding after role handoff instead of including the old environment key', async () => {
  const previous = { aiImageBaseUrl: env.aiImageBaseUrl, aiImageApiKey: env.aiImageApiKey }
  Object.assign(env, { aiImageBaseUrl: 'https://yunshu.chevolink.com/v1', aiImageApiKey: 'retired-env-key' })
  const variant = { id: 'variant', revision: 2, key: 'tool:variant', tier: 'tool_image', modelName: 'new-model', baseUrl: 'https://official.example/v1', apiKeyCiphertext: 'cipher:new-key', archivedAt: null, enabled: true, metadata: { modelKind: 'image_generation' } }
  mocks.models.mockResolvedValue([variant])
  mocks.modelFirst.mockImplementation(async ({ where }: { where: { key: string; archivedAt?: null } }) => where.key === 'tool:image-generation' && where.archivedAt === undefined ? { ...variant, id: 'retired', key: 'tool:image-generation', archivedAt: new Date() } : null)
  mocks.binding.mockResolvedValue({ model: variant })
  const f = fixture()
  try {
    const service = createAdminYunshuUsageService({ loadToken: f.loadToken, fetch: f.fetcher, now: () => now })
    expect((await service.read('today')).sources.configured).toBe(0)
    expect(mocks.binding).toHaveBeenCalledWith({ where: { roleKey: 'tool:image-generation' }, include: { model: true } })
    expect(f.fetcher).not.toHaveBeenCalled()
  } finally { Object.assign(env, previous) }
})
it('does not treat a legacy tool tier as a text environment fallback', async () => {
  const previous = { aiTextBaseUrl: env.aiTextBaseUrl, aiTextApiKey: env.aiTextApiKey }
  Object.assign(env, { aiTextBaseUrl: 'https://yunshu.chevolink.com/v1', aiTextApiKey: 'text-only-key' })
  mocks.models.mockResolvedValue([{ id: 'image', revision: 1, key: 'tool:variant', tier: 'tool_image', baseUrl: null, apiKeyCiphertext: null, metadata: { modelKind: 'image_generation' } }])
  const f = fixture()
  try {
    const service = createAdminYunshuUsageService({ loadToken: f.loadToken, fetch: f.fetcher, now: () => now })
    expect((await service.read('today')).sources.configured).toBe(0); expect(f.fetcher).not.toHaveBeenCalled()
  } finally { Object.assign(env, previous) }
})
