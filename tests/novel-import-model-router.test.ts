import { beforeEach, describe, expect, it, vi } from 'vitest'

const { resolve } = vi.hoisted(() => ({ resolve: vi.fn() }))
vi.mock('../api/lib/credits.js', () => ({ getModelTierRuntime: resolve }))
import { assertImportStructureBudget, resolveImportModelRoute } from '../api/lib/novel-import/model-router.js'

const runtime = { tier: 'custom', provider: 'compatible', modelName: 'author-selected',
  baseUrl: 'https://example.com/v1', apiKey: 'private-test-key', reasoningEffort: 'low',
  reasoningEfforts: ['low', 'high'], visionEnabled: false, contextWindowTokens: 128000, multiplierBps: 0 }

beforeEach(() => { resolve.mockReset(); resolve.mockResolvedValue(runtime) })

describe('import model routing', () => {
  it('uses the exact composer BYOK selection and returns no credentials in its display route', async () => {
    const result = await resolveImportModelRoute('owner', { kind: 'custom', customModelId: 'selected-not-recent' })
    expect(resolve).toHaveBeenCalledExactlyOnceWith('custom', 'owner', 'selected-not-recent', 'low')
    expect(result.route.customModelId).toBe('selected-not-recent')
    expect(JSON.stringify(result.route)).not.toContain('private-test-key')
    expect(JSON.stringify(result.route)).not.toContain('example.com')
  })
  it('uses basic low for a built-in selection', async () => {
    await resolveImportModelRoute('owner', { kind: 'basic' })
    expect(resolve).toHaveBeenCalledExactlyOnceWith('basic', 'owner', undefined, 'low')
  })
  it('does not fall back from an unavailable custom model', async () => {
    resolve.mockRejectedValueOnce(new Error('disabled'))
    await expect(resolveImportModelRoute('owner', { kind: 'custom', customModelId: 'disabled' })).rejects.toThrow('disabled')
    expect(resolve).toHaveBeenCalledTimes(1)
  })
  it('rejects unsupported reasoning and unavailable vision', async () => {
    resolve.mockResolvedValueOnce({ ...runtime, reasoningEffort: 'high', reasoningEfforts: ['high'] })
    await expect(resolveImportModelRoute('owner', { kind: 'basic' })).rejects.toMatchObject({ code: 'IMPORT_REASONING_UNSUPPORTED' })
    await expect(resolveImportModelRoute('owner', { kind: 'basic' }, { needsVision: true })).rejects.toMatchObject({ code: 'IMPORT_VISION_REQUIRED' })
  })
  it('invalidates consent on provider credentials or model changes', async () => {
    const selection = { kind: 'custom', customModelId: 'mine' } as const
    const original = await resolveImportModelRoute('owner', selection)
    resolve.mockResolvedValueOnce({ ...runtime, apiKey: 'rotated-private-key' })
    await expect(resolveImportModelRoute('owner', selection, { expectedFingerprint: original.route.fingerprint }))
      .rejects.toMatchObject({ code: 'IMPORT_MODEL_CHANGED' })
  })
})

describe('import structure budget', () => {
  const budget = { estimatedInput: 8000, maxOutput: 2000, consumedInput: 0, consumedOutput: 0,
    reservedInput: 0, reservedOutput: 0, contextWindowTokens: 128000 }
  it('admits bounded requests without making provider calls', () => {
    expect(() => assertImportStructureBudget(budget)).not.toThrow()
    expect(resolve).not.toHaveBeenCalled()
  })
  it.each([
    { estimatedInput: 8001 }, { maxOutput: 2001 }, { consumedInput: 32001 },
    { consumedInput: 32000, reservedInput: 1 }, { consumedOutput: 6001 },
    { reservedOutput: 6001 }, { contextWindowTokens: 10000 },
  ])('accounts for both consumed and pending calls: %o', change => {
    expect(() => assertImportStructureBudget({ ...budget, ...change })).toThrow()
  })
  it.each([-1, NaN, Infinity, 1.1, Number.MAX_SAFE_INTEGER + 1])('rejects invalid counters %s', value => {
    expect(() => assertImportStructureBudget({ ...budget, consumedInput: value })).toThrow()
  })
  it('keeps unknown context distinct from unlimited', () => {
    expect(() => assertImportStructureBudget({ ...budget, contextWindowTokens: null })).toThrow()
  })
})
