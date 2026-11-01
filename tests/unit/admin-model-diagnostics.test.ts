import dns from 'node:dns'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AdminDiagnosticFailure, checkAdminModelConfiguration, createAdminModelDiagnosticService, type DiagnosticAdapter, type DiagnosticModelSnapshot, type DiagnosticRepository } from '../../api/lib/admin-model-diagnostics.js'
import type { AdminModelDiagnosticRequest, AdminModelDiagnosticResult } from '../../shared/contracts/admin-model-diagnostics.js'

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
const request = (mode: AdminModelDiagnosticRequest['mode'] = 'configuration', requestKey = 'diagnostic-request-1'): AdminModelDiagnosticRequest => ({ requestKey, mode, expectedRevision: '1' })
function fixture(adapter?: DiagnosticAdapter, policy?: { liveRequestsEnabled: boolean; maximumCostMicros: number | null }) {
  const model: DiagnosticModelSnapshot = { id: 'model-a', revision: '1', modelName: 'synthetic-model', provider: 'example-channel', modelKind: 'text', baseUrl: 'https://gateway.example.com/v1', apiKeyConfigured: true, metadata: {}, archived: false }
  const records = new Map<string, AdminModelDiagnosticResult>()
  let superAdmin = true
  let time = Date.parse('2026-11-01T00:00:00Z')
  const repository: DiagnosticRepository = {
    actor: async id => id === 'banned' ? { role: 'admin', isSuperAdmin: true, bannedAt: new Date() } : { role: 'admin', isSuperAdmin: superAdmin, bannedAt: null },
    model: async id => id === model.id ? structuredClone(model) : null,
    find: async (id, key) => structuredClone(records.get(`${id}:${key}`) ?? null),
    create: async (id, result) => { const key = `${id}:${result.requestKey}`; if (!records.has(key)) records.set(key, structuredClone(result)); return structuredClone(records.get(key)!) },
    save: async result => { const entry = [...records].find(([, value]) => value.id === result.id)!; records.set(entry[0], structuredClone(result)) },
  }
  const service = createAdminModelDiagnosticService({ repository, adapter, policy, now: () => time })
  return { model, records, service, ordinaryAdmin: () => { superAdmin = false }, advance: (ms: number) => { time += ms } }
}
const livePolicy = { liveRequestsEnabled: true, maximumCostMicros: 1000 }
const completed = { valid: true, outputTokens: 4, generationDurationMs: 200, fee: { status: 'known' as const, amountMicros: 10 } }
function adapter(execute: DiagnosticAdapter['execute']): DiagnosticAdapter { return { quote: vi.fn(async () => ({ maximumCostMicros: 100, currency: 'CNY' })), execute: vi.fn(execute) } }
async function finished(f: ReturnType<typeof fixture>, key = 'diagnostic-request-1') {
  let result = await f.service.get('admin', 'model-a', key)
  for (let i = 0; i < 30 && result.status === 'running'; i++) { await new Promise(resolve => setTimeout(resolve, 0)); result = await f.service.get('admin', 'model-a', key) }
  return result
}

describe('local model configuration checks and closed default policy', () => {
  it('checks public URL/capabilities locally without DNS, upstream access or decrypting credentials', async () => {
    const lookup = vi.spyOn(dns, 'lookup')
    const fetch = vi.spyOn(globalThis, 'fetch')
    const upstream = adapter(async () => completed)
    const f = fixture(upstream)
    f.ordinaryAdmin()
    const result = await f.service.start('admin', 'model-a', request())
    expect(result.status).toBe('configuration_passed')
    expect(result.metrics.firstTextMs).toBeNull()
    expect(result.fee).toMatchObject({ owner: 'platform', status: 'not_requested', amountMicros: null })
    expect(result.livePolicy).toMatchObject({ enabled: false, maximumCostMicros: null })
    expect(lookup).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(upstream.quote).not.toHaveBeenCalled(); expect(upstream.execute).not.toHaveBeenCalled()
  })
  it('blocks live requests with an unknown fee cap and preserves the explicit blocked evidence', async () => {
    const upstream = adapter(async () => completed)
    const f = fixture(upstream, { liveRequestsEnabled: true, maximumCostMicros: null })
    const result = await f.service.start('admin', 'model-a', request('capability'))
    expect(result).toMatchObject({ status: 'blocked', failure: { stage: 'policy', code: 'LIVE_DIAGNOSTIC_DISABLED' } })
    expect(upstream.execute).not.toHaveBeenCalled()
    expect((await f.service.get('admin', 'model-a', result.requestKey)).id).toBe(result.id)
  })
  it('uses independent Search/Fetch endpoint rules and never echoes unsafe URL values', () => {
    const f = fixture()
    f.model.modelKind = 'web_fetch'; f.model.provider = 'channel_YunShu'; f.model.metadata = { webToolProtocol: 'deepseek' }; f.model.baseUrl = 'https://gateway.example.com/v1/tools/fetch'
    expect(checkAdminModelConfiguration(f.model).every(check => check.passed)).toBe(true)
    f.model.baseUrl = 'https://sensitive-user:synthetic-secret@gateway.example.com/v1/chat/completions'
    const checks = checkAdminModelConfiguration(f.model)
    expect(checks.find(check => check.field === 'baseUrl')?.passed).toBe(false)
    expect(checks.find(check => check.field === 'protocol')?.passed).toBe(false)
    expect(JSON.stringify(checks)).not.toContain('synthetic-secret')
    f.model.baseUrl = 'https://gateway.example.com/v1/tools/search'; f.model.metadata = { webToolProtocol: 'bocha' }
    expect(checkAdminModelConfiguration(f.model).find(check => check.field === 'protocol')?.passed).toBe(false)
  })
  it('retains immutable request identity, owner access and old results after revision/archive changes', async () => {
    const f = fixture()
    const first = await f.service.start('admin', 'model-a', request())
    expect((await f.service.start('admin', 'model-a', request())).id).toBe(first.id)
    await expect(f.service.start('admin', 'model-a', { ...request(), mode: 'gateway' })).rejects.toMatchObject({ code: 'MODEL_DIAGNOSTIC_IDENTITY_CONFLICT' })
    await expect(f.service.get('other-admin', 'model-a', first.requestKey)).rejects.toMatchObject({ code: 'MODEL_DIAGNOSTIC_NOT_FOUND' })
    await expect(f.service.start('banned', 'model-a', request())).rejects.toMatchObject({ code: 'ADMIN_REQUIRED' })
    f.model.revision = '2'; f.model.archived = true
    expect(await f.service.get('admin', 'model-a', first.requestKey)).toMatchObject({ id: first.id, stale: true, configRevision: '1' })
    await expect(f.service.start('admin', 'model-a', { ...request('configuration', 'new-request-2'), expectedRevision: '1' })).rejects.toMatchObject({ code: 'MODEL_DIAGNOSTIC_CONFIG_CHANGED' })
  })
  it('allows ordinary admin local checks while refusing real capability requests', async () => {
    const f = fixture(adapter(async () => completed), livePolicy); f.ordinaryAdmin()
    await expect(f.service.start('admin', 'model-a', request('capability'))).rejects.toMatchObject({ code: 'SUPER_ADMIN_REQUIRED' })
  })
})

describe('injected mocked capability diagnostics', () => {
  it('merges double clicks and separates headers, events, thinking and actual first text', async () => {
    const upstream = adapter(async input => {
      f.advance(20); input.emit({ type: 'headers' }); f.advance(10); input.emit({ type: 'first_event' })
      f.advance(30); input.emit({ type: 'thinking', bytes: 20 }); f.advance(40); input.emit({ type: 'text', bytes: 5 })
      f.advance(200); return completed
    })
    const f = fixture(upstream, livePolicy)
    const [first, duplicate] = await Promise.all([f.service.start('admin', 'model-a', request('capability')), f.service.start('admin', 'model-a', request('capability'))])
    expect(first.id).toBe(duplicate.id)
    const result = await finished(f)
    expect(upstream.execute).toHaveBeenCalledTimes(1)
    expect(result.metrics).toMatchObject({ responseHeadersMs: 20, firstEventMs: 30, firstThinkingMs: 60, firstTextMs: 100, totalMs: 300, outputTokens: 4, tokensPerSecond: 20 })
    expect(result.fee).toMatchObject({ owner: 'platform', status: 'known', amountMicros: 10 })
  })
  it('does not infer TTFT or output speed from headers/thinking/total alone', async () => {
    const f = fixture(adapter(async input => { input.emit({ type: 'headers' }); input.emit({ type: 'thinking', bytes: 10 }); return completed }), livePolicy)
    await f.service.start('admin', 'model-a', request('capability'))
    expect((await finished(f)).metrics).toMatchObject({ firstTextMs: null, tokensPerSecond: null })
  })
  it('keeps image completion separate from text speed and requires cost confirmation', async () => {
    const upstream = adapter(async () => completed); const f = fixture(upstream, livePolicy); f.model.modelKind = 'image_generation'
    expect((await f.service.start('admin', 'model-a', request('capability'))).failure?.code).toBe('IMAGE_TEST_COST_CONFIRMATION_REQUIRED')
    expect(upstream.execute).not.toHaveBeenCalled()
    await f.service.start('admin', 'model-a', { ...request('capability', 'confirmed-image-request'), costConfirmed: true })
    expect((await finished(f, 'confirmed-image-request')).metrics.tokensPerSecond).toBeNull()
  })
  it.each(['dns', 'tls', 'http', 'authentication', 'protocol'] as const)('records one sanitized %s failure stage without retry', async stage => {
    const upstream = adapter(async () => { throw new AdminDiagnosticFailure(stage, 'PROTOCOL_FAILED') })
    const f = fixture(upstream, livePolicy)
    await f.service.start('admin', 'model-a', request('capability'))
    const result = await finished(f)
    expect(result).toMatchObject({ status: 'failed', failure: { stage }, fee: { status: 'unknown', amountMicros: null } })
    await f.service.start('admin', 'model-a', request('capability'))
    expect(upstream.execute).toHaveBeenCalledTimes(1)
  })
  it('treats HTTP 200 without valid capability content as protocol failure', async () => {
    const f = fixture(adapter(async input => { input.emit({ type: 'headers' }); return { ...completed, valid: false } }), livePolicy)
    await f.service.start('admin', 'model-a', request('capability'))
    expect(await finished(f)).toMatchObject({ status: 'failed', failure: { stage: 'protocol', code: 'CAPABILITY_RESPONSE_INVALID' } })
  })
  it('bounds output and does not expose an unexpected upstream error or retry unknown fees', async () => {
    const upstream = adapter(async input => { input.emit({ type: 'text', bytes: 4097 }); throw new Error('synthetic-secret') })
    const f = fixture(upstream, livePolicy)
    await f.service.start('admin', 'model-a', request('capability'))
    const result = await finished(f)
    expect(result).toMatchObject({ status: 'failed', failure: { code: 'DIAGNOSTIC_OUTPUT_LIMIT' }, fee: { status: 'unknown' } })
    expect(JSON.stringify(result)).not.toContain('synthetic-secret')
    expect(upstream.execute).toHaveBeenCalledTimes(1)
  })
  it('cancels a dispatched mock through its signal, preserving unknown fee identity and late-result isolation', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const upstream = adapter(async input => { await gate; input.emit({ type: 'text', bytes: 4 }); return completed })
    const f = fixture(upstream, livePolicy)
    const first = await f.service.start('admin', 'model-a', request('capability'))
    await vi.waitFor(() => expect(upstream.execute).toHaveBeenCalledTimes(1))
    const cancelled = await f.service.cancel('admin', 'model-a', first.requestKey)
    expect(cancelled).toMatchObject({ status: 'cancelled', fee: { identity: first.fee.identity, status: 'unknown', owner: 'platform' } })
    release(); await new Promise(resolve => setTimeout(resolve, 0))
    expect((await f.service.get('admin', 'model-a', first.requestKey)).status).toBe('cancelled')
    expect((upstream.execute as ReturnType<typeof vi.fn>).mock.calls[0][0].signal.aborted).toBe(true)
  })
  it('blocks unknown or excessive quotes without dispatch', async () => {
    const upstream = adapter(async () => completed); upstream.quote = vi.fn(async () => null)
    const f = fixture(upstream, livePolicy)
    await f.service.start('admin', 'model-a', request('capability'))
    expect(await finished(f)).toMatchObject({ status: 'blocked', failure: { stage: 'policy', code: 'COST_QUOTE_UNAVAILABLE_OR_OVER_CAP' }, fee: { status: 'not_requested' } })
    expect(upstream.execute).not.toHaveBeenCalled()
  })
  it('aborts the bounded deadline and preserves unknown fee evidence without retry', async () => {
    vi.useFakeTimers()
    const upstream = adapter(async () => new Promise<never>(() => {}))
    const f = fixture(upstream, livePolicy)
    await f.service.start('admin', 'model-a', request('capability'))
    await vi.advanceTimersByTimeAsync(0)
    expect(upstream.execute).toHaveBeenCalledTimes(1)
    f.advance(15001)
    await vi.advanceTimersByTimeAsync(15001)
    expect(await f.service.get('admin', 'model-a', 'diagnostic-request-1')).toMatchObject({ status: 'unknown', failure: { stage: 'timeout' }, fee: { status: 'unknown' }, metrics: { totalMs: 15001 } })
    expect(upstream.execute).toHaveBeenCalledTimes(1)
    expect(vi.mocked(upstream.execute).mock.calls[0][0].signal.aborted).toBe(true)
  })
  it('keeps the acquired model revision and marks a changed configuration stale while blocking a second concurrent request', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const upstream = adapter(async () => { await gate; return completed })
    const f = fixture(upstream, livePolicy)
    const first = await f.service.start('admin', 'model-a', request('capability'))
    await vi.waitFor(() => expect(upstream.execute).toHaveBeenCalledTimes(1))
    await expect(f.service.start('admin', 'model-a', request('capability', 'second-parallel-request'))).rejects.toMatchObject({ code: 'MODEL_DIAGNOSTIC_BUSY' })
    f.model.revision = '2'; release()
    expect(await finished(f)).toMatchObject({ id: first.id, configRevision: '1', stale: true, status: 'succeeded' })
    expect(vi.mocked(upstream.execute).mock.calls[0][0].model.revision).toBe('1')
  })
})
