import type { StyleLearningJob } from '@prisma/client'
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const store = vi.hoisted(() => ({ row: null as StyleLearningJob | null, privateEnabled: true, revoked: false }))
vi.mock('../../api/lib/prisma', () => ({
  DataAccessError: class extends Error { constructor(public status: number, public code: string, message: string) { super(message) } },
  prisma: {
    novel: { findFirst: vi.fn(async () => ({ id: 'n' })) },
    agentDataControl: { findUnique: vi.fn(async () => ({ privateStyleEnabled: store.privateEnabled })) },
    styleProfile: { findUniqueOrThrow: vi.fn(async () => ({ id: 'p', userId: 'u', novelId: 'n' })) },
    styleLearningJob: {
      findUniqueOrThrow: vi.fn(async () => { if (!store.row) throw Error('deleted'); return structuredClone(store.row) }),
      findFirst: vi.fn(async () => store.revoked ? null : structuredClone(store.row)),
      updateMany: vi.fn(async ({ where, data }) => {
        const row = store.row
        if (!row || Object.entries(where).some(([key, value]) => key === 'leaseUntil' ? row.leaseUntil?.getTime() !== (value as Date)?.getTime() : row[key as keyof StyleLearningJob] !== value)) return { count: 0 }
        Object.assign(row, data, { revision: row.revision + (data.revision?.increment ?? 0) })
        return { count: 1 }
      }),
    },
  },
}))
vi.mock('../../api/lib/agent2-feature-flags', () => ({ requireAgent2Feature: vi.fn(), isAgent2FeatureEnabled: vi.fn(() => true) }))
vi.mock('../../api/lib/credits', () => ({ getModelTierRuntime: vi.fn() }))
vi.mock('../../api/lib/ai-service', () => ({ generateTextCompletion: vi.fn() }))
import { getModelTierRuntime } from '../../api/lib/credits'
import { generateTextCompletion } from '../../api/lib/ai-service'
import { processStyleChunk } from '../../api/lib/agent/style-learning'
const result = JSON.stringify({ rules: [{ dimension: '对白', rule: '用短对白推进动作', evidence: '甲：走。' }] })
const snapshot = () => structuredClone(store.row!)
beforeEach(() => {
  vi.clearAllMocks(); store.privateEnabled = true; store.revoked = false
  vi.mocked(getModelTierRuntime).mockResolvedValue({ tier: 'custom', provider: 'test', modelName: 'fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: 'secret-never-stored', reasoningEffort: 'high', reasoningEfforts: ['high'], multiplierBps: 0, visionEnabled: false, contextWindowTokens: 128000 })
  store.row = { id: 'j', requestId: 'request', profileId: 'p', status: 'queued', revision: 0, enabled: false, pauseRequested: false, selection: { modelTier: 'custom', customModelId: 'm', reasoningEffort: 'high' }, modelIdentity: { price: null, multiplier: 0, reasoning: 'high', model: 'fixture', endpointHash: createHash('sha256').update('https://fixture.invalid/v1').digest('hex'), provider: 'test' }, chunks: [{ name: 'sample', content: '甲：走。' }, { name: 'sample', content: '甲：走。' }], reports: [], rules: [], processed: 0, response: null, error: null, leaseUntil: null, claimToken: null, createdAt: new Date(), updatedAt: new Date() }
  vi.mocked(generateTextCompletion).mockResolvedValue(result)
})
describe('Style learning durable chunk transitions', () => {
  it('CAS admits one call even when two workers hold the same queued snapshot', async () => {
    const initial = snapshot()
    await Promise.all([processStyleChunk(initial), processStyleChunk(initial)])
    expect(generateTextCompletion).toHaveBeenCalledOnce()
    expect(store.row).toMatchObject({ status: 'queued', processed: 1, enabled: false })
    expect(JSON.stringify(store.row)).not.toContain('secret-never-stored')
  })
  it('saves progress before next paid chunk, never automatically enables', async () => {
    await processStyleChunk(snapshot())
    expect(store.row?.processed).toBe(1)
    await processStyleChunk(snapshot())
    expect(store.row).toMatchObject({ status: 'ready', processed: 2, enabled: false })
    expect(generateTextCompletion).toHaveBeenCalledTimes(2)
  })
  it('pause during provider call saves the current chunk and then pauses', async () => {
    vi.mocked(generateTextCompletion).mockImplementation(async () => { store.row!.pauseRequested = true; store.row!.revision++; return result })
    await processStyleChunk(snapshot())
    expect(store.row).toMatchObject({ status: 'paused', processed: 1, enabled: false })
    await processStyleChunk(snapshot())
    expect(generateTextCompletion).toHaveBeenCalledOnce()
  })
  it('process restart after saved provider response parses locally without billing again', async () => {
    store.row!.status = 'analyzing'; store.row!.response = result
    await processStyleChunk(snapshot())
    expect(generateTextCompletion).not.toHaveBeenCalled()
    expect(store.row).toMatchObject({ status: 'queued', processed: 1 })
  })
  it('unknown provider failure does not silently retry', async () => {
    vi.mocked(generateTextCompletion).mockRejectedValue(new Error('timeout'))
    await processStyleChunk(snapshot())
    expect(store.row).toMatchObject({ status: 'interrupted', processed: 0 })
    await processStyleChunk(snapshot())
    expect(generateTextCompletion).toHaveBeenCalledOnce()
  })
  it('invalid evidence retains response for investigation and cannot become enabled', async () => {
    vi.mocked(generateTextCompletion).mockResolvedValue(result.replace('甲：走。', '虚构原文'))
    await processStyleChunk(snapshot())
    expect(store.row).toMatchObject({ status: 'interrupted', enabled: false, processed: 0 })
    expect(store.row!.response).toContain('虚构原文')
  })
  it('data consent disabled or model identity changed blocks dispatch', async () => {
    store.privateEnabled = false
    await processStyleChunk(snapshot())
    expect(generateTextCompletion).not.toHaveBeenCalled()
    expect(store.row!.status).toBe('paused')
    store.privateEnabled = true; store.row!.status = 'queued'; store.row!.modelIdentity = {}
    await processStyleChunk(snapshot())
    expect(generateTextCompletion).not.toHaveBeenCalled()
    expect(store.row!.error).toContain('模型配置或价格已变化')
  })
  it('deleted source and expired lease both fence late results', async () => {
    const original = snapshot()
    vi.mocked(generateTextCompletion).mockImplementation(async () => { store.row = null; return result })
    await processStyleChunk(original)
    expect(store.row).toBeNull()
    store.row = structuredClone(original)
    vi.mocked(generateTextCompletion).mockImplementation(async () => { store.row!.status = 'interrupted'; store.row!.revision++; return result })
    await processStyleChunk(snapshot())
    expect(store.row).toMatchObject({ status: 'interrupted', processed: 0, reports: [] })
    store.row = { ...original, claimToken: null }
    vi.mocked(generateTextCompletion).mockImplementation(async () => { store.row!.claimToken = 'newer-worker'; return result })
    await processStyleChunk(snapshot())
    expect(store.row).toMatchObject({ status: 'processing', claimToken: 'newer-worker', processed: 0, reports: [], response: null })
  })
})

it('retains the persisted job price when only the later admission timestamp differs', async () => {
  const original = { version: 'credits-v1-exact' as const, modelTier: 'standard' as const, multiplierBps: 12000,
    activity: { baseMultiplierBps: 12000, effectiveMultiplierBps: 12000, revision: 2, timezone: 'Asia/Shanghai' as const, admittedAt: '2026-11-02T14:00:00.000Z', activityId: null, activityName: null } }
  const runtime = await getModelTierRuntime()
  vi.mocked(getModelTierRuntime).mockResolvedValue({ ...runtime, tier: 'standard', multiplierBps: 12000, tokenPrice: { ...original, activity: { ...original.activity, admittedAt: '2026-11-02T14:05:00.000Z' } } })
  store.row!.selection = { modelTier: 'standard', reasoningEffort: 'high' }
  store.row!.modelIdentity = { price: original, multiplier: 12000, reasoning: 'high', model: 'fixture', endpointHash: createHash('sha256').update('https://fixture.invalid/v1').digest('hex'), provider: 'test' }
  await processStyleChunk(snapshot())
  expect(generateTextCompletion).toHaveBeenCalledOnce()
  expect(vi.mocked(generateTextCompletion).mock.calls[0][2]).toMatchObject({ operationPrice: original })
})
