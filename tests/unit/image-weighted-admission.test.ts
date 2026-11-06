import { describe, expect, it, vi } from 'vitest'
import { resolveCoverImageRuntime, parseCoverImageResponse } from '../../api/lib/ai-service.js'
import { readWeightedRoutes } from '../../api/lib/model-weighted-config.js'
import { weightedRoutesInputSchema } from '../../shared/contracts/model-weighted-routes.js'
import { publicModelPrice, publicImagePrice } from '../../api/lib/billing/public-model-price.js'

const m = vi.hoisted(() => ({ runtime: vi.fn() }))
vi.mock('../../api/lib/tool-model-config.js', async original => ({ ...await original<object>(), getToolModelRuntime: m.runtime }))
vi.mock('../../api/lib/secret-box.js', () => ({ decryptSecret: (value: string) => 'decrypted-' + value }))
const primary = { provider: 'private-primary', modelName: 'private-model', baseUrl: 'https://primary.invalid/image', apiKey: 'private-key' }
const a = { id: '11111111-1111-4111-8111-111111111111', label: 'A', provider: 'private-A', modelName: 'private-model-A', baseUrl: 'https://a.invalid/image', apiKeyCiphertext: 'private-secret-A', weight: 25,
  imageQuality: { supportedValues: ['custom-high'], defaultValue: 'custom-high' } }

describe('weighted image admission and public projection', () => {
  it('draws once for a new logical admission and restores exact saved identity without a draw', async () => {
    m.runtime.mockResolvedValue({ ...primary, weightedRoutes: { primaryWeight: 75, candidates: [a] }, imageQuality: { supportedValues: ['low'], defaultValue: 'low' },
      routes: [{ id: '22222222-2222-4222-8222-222222222222', ...primary, provider: 'explicit-fallback' }] })
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.9)
    const admitted = await resolveCoverImageRuntime()
    expect(admitted.route).toMatchObject({ routeId: a.id, provider: a.provider, modelName: a.modelName, baseUrl: a.baseUrl, quality: 'custom-high' })
    expect(admitted.apiKey).toBe('decrypted-private-secret-A')
    expect(admitted.fallbackRuntimes?.[0].route).toMatchObject({ provider: 'explicit-fallback', quality: 'low' })
    const restored = await resolveCoverImageRuntime(admitted.route)
    expect(restored.route).toEqual(admitted.route); expect(random).toHaveBeenCalledOnce()
    m.runtime.mockResolvedValue({ ...primary, weightedRoutes: { primaryWeight: 100, candidates: [{ ...a, enabled: false, weight: 0 }] } })
    await expect(resolveCoverImageRuntime(admitted.route)).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
    expect(random).toHaveBeenCalledOnce(); random.mockRestore()
  })
  it('validates disabled weights, zero weight pools, invalid URL/quality and malformed stored keys', () => {
    expect(weightedRoutesInputSchema.safeParse({ primaryWeight: 0, candidates: [{ ...a, apiKeyCiphertext: undefined, enabled: false }] }).success).toBe(false)
    const { apiKeyCiphertext: _secret, ...input } = a
    expect(weightedRoutesInputSchema.safeParse({ primaryWeight: 100, candidates: [{ ...input, enabled: false }] }).success).toBe(true)
    expect(weightedRoutesInputSchema.safeParse({ primaryWeight: 75, candidates: [{ ...input, baseUrl: 'file:///C:/secret' }] }).success).toBe(false)
    expect(() => readWeightedRoutes({ weightedRoutes: { primaryWeight: 75, candidates: [{ ...a, apiKeyCiphertext: '' }] } })).toThrow()
    expect(weightedRoutesInputSchema.safeParse({ primaryWeight: 75, candidates: [{ ...input, imageQuality: { supportedValues: ['low'], defaultValue: 'high' } }] }).success).toBe(false)
  })
  it('retains absent pool legacy routing and keeps upstream errors out of public error messages', async () => {
    m.runtime.mockResolvedValue(primary)
    const random = vi.spyOn(Math, 'random')
    expect((await resolveCoverImageRuntime()).route.modelName).toBe(primary.modelName)
    expect(random).not.toHaveBeenCalled(); random.mockRestore()
    expect(() => parseCoverImageResponse(401, JSON.stringify({ error: { message: 'private-provider private-model Bearer secret https://private-endpoint' } }))).toThrow('图片模型服务暂时不可用。')
  })
  it('projects independent public fields, precise prices and public activity rules only', () => {
    const projection = publicModelPrice({ multiplierBps: 1250, metadata: { publicDescription: '适合构思', publicFeatures: ['长篇'], provider: 'private-provider', modelName: 'private-model', baseUrl: 'https://private.invalid', apiKey: 'private-secret' } }, 'speed')
    expect(projection).toMatchObject({ multiplier: 0.125, baseMultiplier: 0.125, publicDescription: '适合构思', publicFeatures: ['长篇'] })
    expect(JSON.stringify(projection)).not.toMatch(/private-|provider|modelName|baseUrl|apiKey/)
    const image = publicImagePrice({ displayName: '插画', enabled: true, multiplierBps: 1250, metadata: { modelName: 'private-model', apiKey: 'private-secret' } })
    expect(image).toMatchObject({ label: '插画', basePerCallCredits: 6, perCallCredits: 6, multiplier: 0.125 })
    expect(JSON.stringify(image)).not.toMatch(/private-|provider|modelName|baseUrl|apiKey|image_call/)
  })
})
