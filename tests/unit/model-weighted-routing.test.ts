import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveWeightedModelRuntime, selectWeightedModelRuntime, weightedRouteEvidence } from '../../api/lib/model-weighted-routing.js'
import { auxiliaryRouteForRuntime, auxiliaryRouteSchema, resolveDurableAuxiliaryRuntime } from '../../api/lib/agent/runtime-auxiliary-call.js'
import { modelRouteRevision } from '../../api/lib/agent/runtime-model-cursor.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
vi.mock('../../api/lib/secret-box.js', () => ({ decryptSecret: (value: string) => 'decrypted-' + value, encryptSecret: (value: string) => value }))
afterEach(() => vi.restoreAllMocks())
const runtime = (): NonNullable<ToolContext['modelRuntime']> => ({ tier: 'standard', provider: 'primary', modelName: 'original-model', baseUrl: 'https://primary.invalid/v1', apiKey: 'primary-key',
  multiplierBps: 12000, reasoningEffort: 'high', reasoningEfforts: ['low', 'high'], reasoningParameterMode: 'native', visionEnabled: true, contextWindowTokens: 128000,
  tokenPrice: { version: 'credits-v1-exact', modelTier: 'standard', multiplierBps: 12000 }, weightedRoutes: { primaryWeight: 70, candidates: [
    { id: 'A', label: 'A', weight: 20, provider: 'relay-a', modelName: 'arbitrary-alias-a', baseUrl: 'https://a.invalid/v1', apiKeyCiphertext: 'secret-A' },
    { id: 'B', label: 'B', weight: 10, provider: 'relay-b', modelName: 'arbitrary-alias-b', baseUrl: 'https://b.invalid/v1', apiKeyCiphertext: 'secret-B' },
  ] } })

describe('independent weighted selection at logical request admission', () => {
  it.each([[0, 'primary'], [0.699999, 'primary'], [0.7, 'A'], [0.899999, 'A'], [0.9, 'B'], [0.999999, 'B']] as const)('selects random boundary %s as %s and preserves product-tier price/protocol', (point, id) => {
    const base = runtime(), chosen = selectWeightedModelRuntime(base, () => point)
    expect(chosen.weightedRoute).toEqual(id === 'primary' ? { source: 'primary' } : { source: 'candidate', candidateId: id })
    expect(chosen).toMatchObject({ tier: base.tier, multiplierBps: base.multiplierBps, reasoningEffort: base.reasoningEffort,
      reasoningEfforts: base.reasoningEfforts, reasoningParameterMode: 'native', tokenPrice: base.tokenPrice, contextWindowTokens: base.contextWindowTokens, visionEnabled: true })
    if (id !== 'primary') expect(chosen.apiKey).toBe('decrypted-secret-' + id)
    expect(base).not.toHaveProperty('weightedRoute')
  })
  it('has a seeded long-run distribution matching 70/20/10 without a round-robin sequence', () => {
    let state = 123456789
    const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296 }
    const counts = { primary: 0, A: 0, B: 0 }, base = runtime()
    for (let index = 0; index < 10000; index++) {
      const choice = selectWeightedModelRuntime(base, random).weightedRoute!
      counts[choice.source === 'primary' ? 'primary' : choice.candidateId as 'A' | 'B']++
    }
    expect(counts.primary).toBeGreaterThan(6800); expect(counts.primary).toBeLessThan(7200)
    expect(counts.A).toBeGreaterThan(1800); expect(counts.A).toBeLessThan(2200)
    expect(counts.B).toBeGreaterThan(850); expect(counts.B).toBeLessThan(1150)
  })
  it('does not draw for legacy, deleted-all extras, or BYOK and does not add a snapshot field', () => {
    const draw = vi.fn(() => 0.9), { weightedRoutes: _pool, ...legacy } = runtime()
    for (const base of [legacy, { ...legacy, weightedRoutes: { primaryWeight: 100, candidates: [] } }, { ...runtime(), tier: 'custom' as const }]) {
      expect(selectWeightedModelRuntime(base, draw)).toBe(base)
      expect(base).not.toHaveProperty('weightedRoute')
    }
    expect(draw).not.toHaveBeenCalled()
  })
  it('holds the actual connection through tools/retries, while a new independent subtask gets a new draw', () => {
    const draw = vi.fn().mockReturnValueOnce(0.75).mockReturnValueOnce(0.95), base = runtime()
    const selected = selectWeightedModelRuntime(base, draw)
    for (let round = 0; round < 5; round++) expect(selectWeightedModelRuntime(selected, draw)).toBe(selected)
    expect(draw).toHaveBeenCalledOnce()
    expect(selectWeightedModelRuntime(base, draw).weightedRoute).toEqual({ source: 'candidate', candidateId: 'B' })
  })
  it('resolves saved candidate identity without drawing again or treating deleted candidates as a new request', () => {
    const base = runtime(), random = vi.spyOn(Math, 'random')
    const saved = resolveWeightedModelRuntime(base, { source: 'candidate', candidateId: 'A' })
    expect(saved).toMatchObject({ provider: 'relay-a', modelName: 'arbitrary-alias-a' })
    expect(resolveWeightedModelRuntime(base)).toBe(base)
    expect(() => resolveWeightedModelRuntime({ ...base, weightedRoutes: { primaryWeight: 100, candidates: [] } }, saved.weightedRoute)).toThrow('原供应商线路已不可用')
    expect(random).not.toHaveBeenCalled()
    expect(weightedRouteEvidence(saved.weightedRoute, saved.provider, saved.modelName!, 'physical-A')).toEqual({ weightedRoute: {
      source: 'candidate', candidateId: 'A', provider: 'relay-a', model: 'arbitrary-alias-a', physicalRouteId: 'physical-A' } })
    expect(JSON.stringify(weightedRouteEvidence(saved.weightedRoute, saved.provider, saved.modelName!))).not.toMatch(/secret|https:/)
  })
  it('selects a fresh builtin review once, inherits an admitted choice and freezes an optional identity without changing old route hashes', async () => {
    const draw = vi.spyOn(Math, 'random').mockReturnValue(0.75)
    const fresh = await resolveDurableAuxiliaryRuntime({ userId: 'owner', modelRuntime: runtime() })
    const route = auxiliaryRouteForRuntime(fresh.runtime, fresh.selection, 16384)
    expect(route).toMatchObject({ tier: 'standard', provider: 'relay-a', model: 'arbitrary-alias-a', weightedRoute: { source: 'candidate', candidateId: 'A' } })
    expect((await resolveDurableAuxiliaryRuntime({ userId: 'owner', modelRuntime: fresh.runtime })).runtime).toBe(fresh.runtime)
    expect(draw).toHaveBeenCalledOnce()
    const old = { tier: 'standard' as const, provider: 'primary', model: 'original-model', baseUrl: 'https://primary.invalid/v1', maxOutputTokens: 16384 }
    expect(auxiliaryRouteSchema.parse(old)).toEqual(old)
    const publicRoute = { provider: old.provider, model: old.model, endpoint: old.baseUrl + '/chat/completions', reasoningEffort: 'high' }
    expect(modelRouteRevision(publicRoute)).toBe(runtimeJson({ version: 1, ...publicRoute }).hash)
    expect(modelRouteRevision({ ...publicRoute, weightedRoute: route.weightedRoute })).not.toBe(modelRouteRevision(publicRoute))
  })
})
