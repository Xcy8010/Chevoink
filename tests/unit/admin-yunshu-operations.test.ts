import { expect, it, vi } from 'vitest'
import { createAdminYunshuUsageService } from '../../api/lib/admin-yunshu-usage.js'
import type { AdminYunshuOperationsQuery } from '../../shared/contracts/admin-yunshu-usage.js'

const now = Date.parse('2026-11-04T04:30:00Z')
const row = (patch: Record<string, unknown> = {}) => ({ token_id: 7, type: 2, created_at: now / 1000 - 60, model_name: 'upstream-model', group: 'platform', request_id: 'actual-request', prompt_tokens: 200, completion_tokens: 50, quota: 250000, use_time: 2, is_stream: true,
  other: JSON.stringify({ cache_tokens: 100, stream_status: { status: 'ok' } }), ...patch })
const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }))
const query = (patch: Partial<AdminYunshuOperationsQuery> = {}): AdminYunshuOperationsQuery => ({ period: 'today', page: 1, pageSize: 20, kind: 'all', view: 'records', ...patch })
function fixture(rows = [row()]) {
  let time = now
  let unit: Record<string, unknown> = { quota_per_unit: 500000, quota_display_type: 'USD', usd_exchange_rate: 7.3, custom_currency_symbol: '¤', custom_currency_exchange_rate: 1 }
  const fetcher = vi.fn<typeof fetch>(async input => {
    const path = new URL(String(input)).pathname
    if (path === '/api/log/token') return json([{ token_id: 7 }])
    if (path === '/api/log/') return json({ page: 1, page_size: 100, total: rows.length, items: rows })
    if (path === '/api/status') return json(unit)
    if (path === '/api/user/self') return json({ quota: 1000000, used_quota: 2000000, email: 'private-email', username: 'private-account', setting: 'private-config' })
    throw new Error('UNEXPECTED_ENDPOINT')
  })
  const loadToken = vi.fn(async () => 'nap_synthetic_admin')
  const loadSources = vi.fn(async () => [{ identity: 'model:revision:1', key: 'sk-private-key' }])
  const service = createAdminYunshuUsageService({ fetch: fetcher, now: () => time, loadToken, loadSources })
  return { service, fetcher, loadToken, loadSources, advance: () => { time += 61000 }, unit: (value: Record<string, unknown>) => { unit = value }, calls: (path: string) => fetcher.mock.calls.filter(([input]) => new URL(String(input)).pathname === path).length }
}

it('shares a sanitized snapshot across usage, record pagination, kind filters, health and cost', async () => {
  const f = fixture([row({ content: 'private-manuscript', username: 'private-author', ip: 'private-address', token_name: 'private-token', other: JSON.stringify({ stream_status: { status: 'ok', errors: ['private-error'] }, admin_info: { api_key: 'private-secret' } }) }), row({ type: 5, request_id: 'error-one' }), row({ type: 6, request_id: 'refund-one' }), row({ token_id: 8, request_id: 'other-application' })])
  await f.service.read('today')
  const first = await f.service.operations(query({ pageSize: 1 }))
  expect(first.records).toMatchObject({ page: 1, total: 3, totalObserved: 3, totalPages: 3, hasMore: true })
  expect(first.records.items).toHaveLength(1)
  const refund = await f.service.operations(query({ kind: 'refund', page: 50, pageSize: 1 }))
  expect(refund.records).toMatchObject({ page: 1, total: 1, totalObserved: 3, kind: 'refund' })
  expect(refund.records.items[0].kind).toBe('refund')
  const health = await f.service.operations(query({ view: 'health' }))
  expect(health.cost.display.state).toBe('ready'); expect(health.balance.state).toBe('not_requested')
  const cost = await f.service.operations(query({ view: 'cost' }))
  expect(cost.balance).toMatchObject({ state: 'ready', scope: 'management_account', remainingQuota: '1000000' })
  expect(f.calls('/api/log/token')).toBe(1); expect(f.calls('/api/log/')).toBe(1)
  expect(f.calls('/api/status')).toBe(1); expect(f.calls('/api/user/self')).toBe(1)
  expect(JSON.stringify(cost)).not.toMatch(/private-|other-application|token_id|admin_info|username|email|setting|content|api_key/)
  const statusCall = f.fetcher.mock.calls.find(([input]) => String(input).endsWith('/api/status'))
  expect(statusCall?.[1]?.headers).toEqual({})
  first.records.items[0].modelName = 'caller-change'
  expect((await f.service.operations(query())).records.items[0].modelName).toBe('upstream-model')
})
it('reports passive stream errors, unknown outcomes and only positive duration samples', async () => {
  const f = fixture([row({ use_time: 2 }), row({ request_id: 'stream-error', use_time: 4, other: JSON.stringify({ stream_status: { status: 'error', end_error: 'private-error' } }) }), row({ request_id: 'unobserved', use_time: 0, is_stream: false }), row({ type: 5, request_id: 'error', use_time: 8 }), row({ type: 6, request_id: 'refund', use_time: 99 })])
  const value = await f.service.operations(query({ view: 'health' }))
  expect(value.health).toMatchObject({ observation: 'attention', consumeCount: 3, errorCount: 1, refundCount: 1, streamSuccessCount: 1, streamErrorCount: 1, unknownOutcomeCount: 1, durationSamples: 3, p50Ms: 4000, p95Ms: 8000 })
  expect(value.records.items.find(item => item.requestId === 'unobserved')?.durationMs).toBeNull()
  expect(f.calls('/api/user/self')).toBe(0)
})
it('retains exact large integer costs and a negative net when recorded refunds exceed consumption', async () => {
  const amount = Number.MAX_SAFE_INTEGER
  const f = fixture([row({ quota: amount }), row({ request_id: 'second', quota: amount }), row({ type: 6, request_id: 'refund-1', quota: amount }), row({ type: 6, request_id: 'refund-2', quota: amount }), row({ type: 6, request_id: 'refund-3', quota: amount })])
  f.unit({ quota_per_unit: 1, quota_display_type: 'USD' })
  const value = await f.service.operations(query({ view: 'cost' }))
  expect(value.cost).toMatchObject({ deductionQuota: '18014398509481982', refundQuota: '27021597764222973', netQuota: '-9007199254740991', display: { deduction: '18014398509481982', refund: '27021597764222973', net: '-9007199254740991' } })
})
it('uses live USD, CNY, custom and quota-unit settings instead of hardcoded currency defaults', async () => {
  for (const [type, rate, net, balance, symbol] of [['USD', 77, '-1', '2', '$'], ['CNY', 7.3, '-7.3', '14.6', '¥'], ['CUSTOM', 0.9, '-0.9', '1.8', '€'], ['TOKENS', 1, '-500000', '1000000', '网关额度单位']] as const) {
    const f = fixture([row(), row({ type: 6, request_id: 'refund', quota: 750000 })])
    f.unit({ quota_per_unit: 500000, quota_display_type: type, usd_exchange_rate: rate, custom_currency_symbol: '€', custom_currency_exchange_rate: rate })
    const value = await f.service.operations(query({ view: 'cost' }))
    expect(value.cost.display).toMatchObject({ state: 'ready', type, net, symbol })
    expect(value.balance.displayRemaining).toBe(balance)
  }
})
it('keeps missing or negative quota unknown and does not round a nonzero amount silently to zero', async () => {
  const f = fixture([row({ quota: undefined }), row({ type: 6, request_id: 'refund', quota: -1 })])
  const value = await f.service.operations(query({ view: 'cost' }))
  expect(value.cost).toMatchObject({ deductionQuota: null, refundQuota: null, netQuota: null, unknownDeductionCount: 1, unknownRefundCount: 1, display: { net: null } })
  const tiny = fixture([row({ quota: 1 })]); tiny.unit({ quota_per_unit: 1e20, quota_display_type: 'USD' })
  const result = await tiny.service.operations(query({ view: 'cost' }))
  expect(result.cost.deductionQuota).toBe('1'); expect(result.cost.display.deduction).toBeNull()
})
it('keeps logs usable when balance permission or live currency metadata is unavailable', async () => {
  const f = fixture()
  const original = f.fetcher.getMockImplementation()!
  f.fetcher.mockImplementation(async (input, init) => String(input).endsWith('/api/user/self') ? new Response('private-denial', { status: 403 }) : original(input, init))
  const value = await f.service.operations(query({ view: 'cost' }))
  expect(value.state).toBe('partial'); expect(value.records.total).toBe(1)
  expect(value.balance).toMatchObject({ state: 'error', remainingQuota: null })
  expect(value.balance.message).toContain('profile:read'); expect(JSON.stringify(value)).not.toContain('private-denial')
  await f.service.operations(query({ view: 'cost' })); expect(f.calls('/api/user/self')).toBe(1)
  const unknown = fixture(); unknown.unit({ quota_per_unit: 500000, quota_display_type: 'CNY' })
  const result = await unknown.service.operations(query({ view: 'cost' }))
  expect(result.cost).toMatchObject({ deductionQuota: '250000', display: { state: 'error', deduction: null } })
  expect(result.balance).toMatchObject({ state: 'ready', remainingQuota: '1000000', displayRemaining: null })
})
it('shows a real negative management-wallet balance exactly while keeping used quota nonnegative', async () => {
  for (const [quota, raw, display] of [[-1, '-1', '-0.000002'], [-1250000, '-1250000', '-2.5'], [-Number.MAX_SAFE_INTEGER, '-9007199254740991', '-18014398509.481982']] as const) {
    const f = fixture()
    const original = f.fetcher.getMockImplementation()!
    f.fetcher.mockImplementation(async (input, init) => String(input).endsWith('/api/user/self') ? json({ quota, used_quota: 2000000 }) : original(input, init))
    const value = await f.service.operations(query({ view: 'cost' }))
    expect(value.balance).toMatchObject({ state: 'ready', remainingQuota: raw, displayRemaining: display, usedQuota: '2000000', displayUsed: '4' })
  }
  const f = fixture(), original = f.fetcher.getMockImplementation()!
  f.fetcher.mockImplementation(async (input, init) => String(input).endsWith('/api/user/self') ? json({ quota: -1, used_quota: -1 }) : original(input, init))
  expect((await f.service.operations(query({ view: 'cost' }))).balance).toMatchObject({ state: 'error', remainingQuota: null, usedQuota: null })
})
it('refreshes auxiliary snapshots after sixty seconds and does not apply stale currency rates', async () => {
  const f = fixture()
  const first = await f.service.operations(query({ view: 'cost' }))
  f.advance()
  const original = f.fetcher.getMockImplementation()!
  f.fetcher.mockImplementation(async (input, init) => String(input).endsWith('/api/status') ? new Response('', { status: 503 }) : original(input, init))
  const value = await f.service.operations(query({ view: 'cost' }))
  expect(value.cost.display).toMatchObject({ state: 'stale', observedAt: first.cost.display.observedAt, deduction: null, net: null })
  expect(value.balance.displayRemaining).toBeNull()
  expect(f.calls('/api/status')).toBe(2); expect(f.calls('/api/log/token')).toBe(1)
})
it('shares auxiliary work across health and cost, and does not fetch a balance for a health view', async () => {
  const f = fixture()
  let started: () => void = () => {}, release: () => void = () => {}
  const waiting = new Promise<void>(resolve => { started = resolve })
  const paused = new Promise<void>(resolve => { release = resolve })
  const original = f.fetcher.getMockImplementation()!
  f.fetcher.mockImplementation(async (input, init) => { if (String(input).endsWith('/api/status')) { started(); await paused } return original(input, init) })
  const health = f.service.operations(query({ view: 'health' }))
  await waiting
  expect(f.calls('/api/user/self')).toBe(0)
  const cost = f.service.operations(query({ view: 'cost' }))
  release(); await Promise.all([health, cost])
  expect(f.calls('/api/status')).toBe(1); expect(f.calls('/api/user/self')).toBe(1); expect(f.calls('/api/log/')).toBe(1)
})
it('shares 429 backoff between auxiliary calls and logs without discarding already observed records', async () => {
  const f = fixture()
  const original = f.fetcher.getMockImplementation()!
  f.fetcher.mockImplementation(async (input, init) => String(input).endsWith('/api/status') ? new Response('private-limit', { status: 429, headers: { 'Retry-After': '1200' } }) : original(input, init))
  const cost = await f.service.operations(query({ view: 'cost' }))
  expect(cost.records.total).toBe(1); expect(cost.cost.deductionQuota).toBe('250000')
  expect(cost.cost.display.state).toBe('error'); expect(cost.balance.state).toBe('error')
  expect(f.calls('/api/user/self')).toBe(0)
  const calls = f.fetcher.mock.calls.length
  const records = await f.service.operations(query())
  expect(records.state).toBe('stale'); expect(records.records.total).toBe(1); expect(f.fetcher).toHaveBeenCalledTimes(calls)
})
it('replaces a prior successful scope with a cleared business-error DTO when scope changes or becomes unreadable during refresh', async () => {
  for (const unavailable of [false, true]) {
    const f = fixture([row({ model_name: 'scope-A-model' })])
    const first = await f.service.operations(query({ view: 'cost' }))
    expect(first.records.items[0].modelName).toBe('scope-A-model'); expect(first.balance.remainingQuota).toBe('1000000')
    f.advance()
    const original = f.fetcher.getMockImplementation()!
    f.fetcher.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/api/status')) {
        if (unavailable) f.loadSources.mockRejectedValue(new Error('private-config-error'))
        else f.loadSources.mockResolvedValue([{ identity: 'changed', key: 'new-private-key' }])
      }
      return original(input, init)
    })
    const value = await f.service.operations(query({ view: 'cost' }))
    expect(value).toMatchObject({ state: 'error', observedAt: null, paginationComplete: false, sources: { configured: 0, verified: 0, unresolved: 0 },
      records: { items: [], total: 0, totalObserved: 0 }, health: { consumeCount: 0, p50Ms: null, p95Ms: null, lastSampleAt: null },
      cost: { deductionQuota: null, refundQuota: null, netQuota: null, display: { state: 'error', observedAt: null, quotaPerUnit: null, type: null, rate: null, symbol: null, deduction: null, refund: null, net: null } },
      balance: { state: 'error', observedAt: null, remainingQuota: null, usedQuota: null, displayRemaining: null, displayUsed: null } })
    expect(JSON.stringify(value)).not.toMatch(/scope-A-model|1000000|250000|private-/)
  }
})
