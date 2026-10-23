import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { researchDossierBuildSchema } from '../../shared/contracts/index.js'
import { dossierCacheKey, parseResearchSynthesis, researchDossierSources } from '../../api/lib/agent/research-dossier.js'
import { assertDossierBuildExclusive, dossierQueryIdentity, dossierQueryRequest, dossierWorkSchema, readIncludedDossierSearch, researchRefreshProof } from '../../api/lib/agent/runtime-dossier-contract.js'
import { runtimeJson, type RuntimeTx } from '../../api/lib/agent/runtime-common.js'
import { env } from '../../api/config/env.js'
import { searchWeb, WebSearchUnknownError } from '../../api/lib/web-search-service.js'

vi.mock('undici', async original => ({ ...await original<typeof import('undici')>(), fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) }))
const args = researchDossierBuildSchema.parse({ topic: '雪原救援', genre: '探险', triggerReason: 'new_book', triggerSignals: ['确定职业细节'], targetAudience: '成年读者', queries: ['雪原 救援'] })
const provider = env.webSearchProvider
afterEach(() => { env.webSearchProvider = provider; vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('dossier original business and human refresh evidence', () => {
  it.each(['请重新建立研究档案。', '帮我强制刷新研究档案。', '请把研究档案重新建立。', 'Refresh the research dossier.'])('accepts an explicit human refresh: %s', prompt => {
    const proof = researchRefreshProof(prompt)!
    expect(proof).not.toBeNull()
    expect(prompt.slice(proof.start, proof.end)).not.toContain('。')
    expect(proof.requestHash).toMatch(/^[a-f0-9]{64}$/)
  })
  it.each(['请勿刷新研究档案。', '请别重新研究。', 'Never refresh research.', '请不要重新研究。',
    '界面写着刷新研究档案。', '请解释如何刷新研究档案。', '请说出刷新研究档案的意思。', '请问怎么重建研究档案？',
    '请总结“重新研究”的例子。', '如果需要，可以刷新研究档案。', '刷新研究档案？', 'Refresh research?',
    '请刷新研究档案。这只是一个示例，请勿联网。', '刷新研究档案并非我的要求。', 'Refresh research is not permitted.', '请刷新研究档案。算了。'])('does not mint force authority: %s', prompt => {
    expect(researchRefreshProof(prompt)).toBeNull()
  })
  it('retains the original cache key independent of query/signal edits', () => {
    expect(dossierCacheKey(args)).toBe(dossierCacheKey({ ...args, queries: ['另一条查询'], triggerSignals: ['另一个信号'] }))
    expect(dossierCacheKey(args)).not.toBe(dossierCacheKey({ ...args, topic: '新的研究主题' }))
  })
  it('keeps first URL, original order, fifteen summaries and the three-hundred-character boundary', () => {
    const results = Array.from({ length: 20 }, (_, index) => ({ title: `来源${index}`, url: `https://example.org/${index}`, source: 'example.org', snippet: '资料'.repeat(200) }))
    const sources = researchDossierSources([{ provider: 'bocha', results: [results[0], { ...results[0], title: '重复来源' }, ...results.slice(1)] }], '2026-10-23T00:00:00.000Z')
    expect(sources).toHaveLength(15)
    expect(sources[0]).toMatchObject({ index: 1, title: '来源0', rightsType: 'web_summary_only', retrievedAt: '2026-10-23T00:00:00.000Z' })
    expect(sources.every(source => source.snippet.length === 300)).toBe(true)
  })
  it('exposes complete-invalid fallback without inventing sourced facts', () => {
    const fallback = vi.fn()
    expect(parseResearchSynthesis('complete but invalid format', args, 1, fallback).factCards).toEqual([])
    expect(fallback).toHaveBeenCalledOnce()
  })
})

describe('included search is limited to the genuine original dossier service', () => {
  it.each(['original', 'owner', 'session', 'run', 'parent-hash', 'ordinal', 'query', 'route', 'action'] as const)('%s', async scenario => {
    const work = dossierWorkSchema.parse({ version: 1, kind: 'build', novelId: 'novel', args, admittedAt: '2026-10-23T00:00:00.000Z', cacheKey: dossierCacheKey(args),
      predecessor: null, dossierId: randomUUID(), expectedVersion: 1, expiresAt: '2026-11-22T00:00:00.000Z', novel: { title: '雪原', summary: '' }, force: null,
      searchTariff: 'dossier_search_included_v1', searchRoute: { configured: null, envProvider: 'auto', envBochaConfigured: false },
      route: { tier: 'speed', provider: 'fixture', model: 'fixture', baseUrl: 'https://provider.invalid/v1', maxOutputTokens: 1000 },
      price: { version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 10000, rateCardId: 'fixture', rates: { inputNano: 1, cacheNano: 1, outputNano: 1 } } })
    if (work.kind !== 'build') throw Error('invalid fixture')
    const source = { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null, successfulToolSignatures: [],
      messages: [{ role: 'user', content: '建立研究' }, { role: 'assistant', content: null, toolCalls: [{ id: 'dossier-call', name: 'research_dossier_build', arguments: JSON.stringify(args) }] }] }
    const sourceHash = runtimeJson(source).hash
    const snapshot = runtimeJson({ kind: 'tool', action: 'research_dossier_build', input: { novelId: 'novel', callId: 'dossier-call', args, work,
      normalization: { version: 1, rawArguments: JSON.stringify(args), normalizedArgsHash: runtimeJson(args).hash, sourceRevision: 0, sourceSnapshotHash: sourceHash } } })
    const parent = { id: 'parent', kind: 'tool', action: scenario === 'action' ? 'web_search' : 'research_dossier_build', taskRootId: 'root',
      operationKey: 'exec:0', originRunId: 'original-run', inputHash: snapshot.hash, inputSnapshot: snapshot.value, taskRoot: { userId: 'owner', novelId: 'novel' } }
    const ctx = { userId: scenario === 'owner' ? 'another-owner' : 'owner', novelId: 'novel', sessionId: scenario === 'session' ? 'another-session' : 'session', runId: scenario === 'run' ? 'resumed-run' : 'original-run',
      callId: dossierQueryIdentity('owner', 'original-run', parent.id, 0).callId,
      includedDossierSearch: { parentOperationId: parent.id, parentInputHash: scenario === 'parent-hash' ? 'b'.repeat(64) : snapshot.hash, ordinal: scenario === 'ordinal' ? 3 : 0 } }
    const request = dossierQueryRequest(parent, work, 0)
    if (scenario === 'query') request.query = '替换原查询'
    if (scenario === 'route') request.route = { ...request.route, envProvider: 'bing' }
    const tx = { agentOperation: { findUnique: vi.fn().mockResolvedValue(parent) }, agentRun: { findUnique: vi.fn().mockResolvedValue({ userId: 'owner', novelId: 'novel', sessionId: 'session' }) },
      agentExecutionFrame: { findUnique: vi.fn().mockResolvedValue({ revision: 0, snapshot: source, snapshotHash: sourceHash, previousHash: null }) },
      agentExecutionOutbox: { findUnique: vi.fn().mockResolvedValue({ taskRootId: 'root', type: 'execution.state.saved', payload: { revision: 0, snapshotHash: sourceHash, previousHash: null } }) } }
    const result = readIncludedDossierSearch(tx as unknown as RuntimeTx, ctx, request)
    if (scenario === 'original') expect(await result).toMatchObject({ parent: { id: 'parent' }, work: { searchTariff: 'dossier_search_included_v1' } })
    else await expect(result).rejects.toMatchObject({ code: expect.stringMatching(/^RUNTIME_/) })
  })
  it.each(['abandoned-empty', 'abandoned-query', 'abandoned-model', 'live-admission', 'newer-live', 'older-resumed'] as const)('%s retains actual dispatches without an eternal empty-work lock', async scenario => {
    const current = ['newer-live', 'older-resumed'].includes(scenario) ? { id: 'current', createdAt: new Date('2026-10-23T01:00:00Z') } : undefined
    const tx = { agentOperation: { findMany: vi.fn().mockResolvedValue([{ id: 'other', originRunId: 'original-run', taskRootId: 'other-root',
      createdAt: new Date(scenario === 'older-resumed' ? '2026-10-23T00:00:00Z' : '2026-10-23T02:00:00Z'), taskRoot: { status: scenario.startsWith('abandoned') ? 'paused' : 'active' } }]) },
      webToolCall: { count: vi.fn().mockResolvedValue(scenario === 'abandoned-query' ? 1 : 0) },
      agentProviderAttempt: { count: vi.fn().mockResolvedValue(scenario === 'abandoned-model' ? 1 : 0) }, agentRun: { count: vi.fn().mockResolvedValue(1) } }
    const result = assertDossierBuildExclusive(tx as unknown as RuntimeTx, 'owner', 'novel', current)
    if (scenario === 'abandoned-empty' || scenario === 'older-resumed') await expect(result).resolves.toBeUndefined()
    else await expect(result).rejects.toMatchObject({ code: 'RESEARCH_BUILD_PENDING' })
  })
})

describe('durable search distinguishes unknown transport from an observed rejection', () => {
  const route = { provider: 'bocha', modelName: 'bocha', baseUrl: 'https://search.example.org/v1', apiKey: 'isolated-not-a-real-secret' }
  const html = '<div class="vrwrap" data-url="https://example.org/authorized"><h3 class="vr-title"><a href="https://example.org/authorized">公开资料标题</a></h3><p>只提供公开摘要</p></div>'
  it.each(['transport', 'partial-body'] as const)('retains %s unknown without issuing a fallback', async scenario => {
    env.webSearchProvider = 'auto'
    const transport = vi.fn(async () => {
      if (scenario === 'transport') throw Error('connection lost after request')
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"code":200')); controller.error(Error('truncated body')) } }))
    })
    vi.stubGlobal('fetch', transport)
    await expect(searchWeb('雪原 救援', 5, undefined, route, undefined, undefined, { stopOnUnknown: true })).rejects.toBeInstanceOf(WebSearchUnknownError)
    expect(transport).toHaveBeenCalledOnce()
  })
  it('allows the original bounded fallback after a definite rejected HTTP response', async () => {
    env.webSearchProvider = 'auto'
    const transport = vi.fn().mockResolvedValueOnce(new Response('', { status: 429 })).mockResolvedValueOnce(new Response(html))
    vi.stubGlobal('fetch', transport)
    const result = await searchWeb('雪原 救援', 5, undefined, route, undefined, undefined, { stopOnUnknown: true })
    expect(transport).toHaveBeenCalledTimes(2)
    expect(result.provider).toBe('sogou')
    expect(result.attempts?.[0]).toMatchObject({ provider: 'bocha', outcome: 'failed', httpStatus: 429 })
    expect(result.results[0].url).toBe('https://example.org/authorized')
  })
})
