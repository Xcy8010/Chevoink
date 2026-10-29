import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getAdminModelManagement, updateAdminModel } from '../../api/lib/admin-credit-model.js'
import { getModelTierRuntime } from '../../api/lib/credits.js'
import { chatWithTools, generateTextCompletion } from '../../api/lib/ai-service.js'
import type { ModelReasoningEffort } from '../../shared/contracts/index.js'

const mocks = vi.hoisted(() => ({ row: {} as Record<string, unknown>, update: vi.fn() }))
vi.mock('../../api/lib/secret-box.js', async original => ({ ...await original<object>(), decryptSecret: () => 'offline-key' }))
vi.mock('../../api/lib/prisma.js', async original => ({ ...await original<object>(), prisma: {
  aiModelConfig: {
    findMany: vi.fn(async (args: { select?: unknown }) => args.select ? [] : [mocks.row]),
    findFirst: vi.fn(async () => mocks.row), findFirstOrThrow: vi.fn(async () => mocks.row), update: mocks.update,
  },
  aiUsageLog: { groupBy: vi.fn(async () => []), findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null),
    create: vi.fn(async () => ({ id: 'usage' })), update: vi.fn(async () => ({ id: 'usage' })), updateMany: vi.fn(async () => ({ count: 1 })) },
  user: { findUnique: vi.fn(async () => ({ role: 'admin', isSuperAdmin: true, bannedAt: null })) },
  $queryRaw: vi.fn(async () => []),
} }))
vi.mock('../../api/lib/credits.js', async original => ({ ...await original<object>(),
  assertCreditAccess: vi.fn(), reserveTokenCredits: vi.fn(), consumeTokenCredits: vi.fn(async () => ({ chargedMilli: 0 })),
}))
vi.mock('../../api/lib/credit-policy.js', async original => ({ ...await original<object>(),
  creditTransaction: async (work: (tx: unknown) => Promise<unknown>) => work((await import('../../api/lib/prisma.js')).prisma),
}))
vi.mock('../../api/lib/billing/rate-cards.js', async original => ({ ...await original<object>(),
  getActiveTokenPrices: vi.fn(async () => new Map()), getActiveTokenPrice: vi.fn(async () => null),
}))
vi.mock('../../api/lib/billing/resolve-token-price.js', async original => ({ ...await original<object>(),
  resolveTokenPrice: async () => ({ version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 }),
}))

beforeEach(() => {
  mocks.row = { id: 'builtin', key: 'builtin-fixture', ownerUserId: null, provider: 'opaque', displayName: '内置模型',
    modelName: 'fixture-model', baseUrl: 'https://fixture.invalid/v1', apiKeyCiphertext: 'encrypted', tier: 'speed', multiplierBps: 10000,
    enabled: true, selectable: true, isDefault: false, sortOrder: 0,
    metadata: { reasoningEfforts: ['high'], defaultReasoningEffort: 'high', customMarker: 'preserved' }, updatedAt: new Date() }
  mocks.update.mockReset().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    mocks.row = { ...mocks.row, ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)) }
    return mocks.row
  })
  vi.stubGlobal('fetch', vi.fn(async () => new Response('data: {"choices":[{"delta":{"content":"ready"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })))
})
afterEach(() => vi.unstubAllGlobals())

const efforts: ModelReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
it.each((['native', 'omit'] as const).flatMap(reasoningParameterMode => efforts.map(reasoningEffort => ({ reasoningParameterMode, reasoningEffort }))))('roundtrips declared builtin $reasoningParameterMode $reasoningEffort capabilities into Agent and auxiliary HTTP bodies', async ({ reasoningParameterMode, reasoningEffort }) => {
  await updateAdminModel('admin', 'builtin', { reasoningParameterMode, outputTokenParameter: 'max_completion_tokens', thinkingEnabled: false, reasoningEfforts: efforts })
  expect((await getAdminModelManagement()).models[0]).toMatchObject({ reasoningParameterMode, outputTokenParameter: 'max_completion_tokens', thinkingEnabled: false })
  // A subsequent unrelated edit must retain the protocol and other metadata.
  await updateAdminModel('admin', 'builtin', { displayName: 'renamed' })
  expect(mocks.row.metadata).toMatchObject({ reasoningParameterMode, customMarker: 'preserved' })
  const runtime = await getModelTierRuntime('speed', 'user', undefined, reasoningEffort)
  await chatWithTools({ messages: [{ role: 'user', content: 'fixture' }], tools: [], provider: runtime.provider,
    model: runtime.modelName!, providerBaseUrl: runtime.baseUrl, providerApiKey: runtime.apiKey,
    reasoningEffort: runtime.reasoningEffort, reasoningParameterMode: runtime.reasoningParameterMode,
    outputTokenParameter: runtime.outputTokenParameter, thinkingEnabled: runtime.thinkingEnabled,
    maxOutputTokens: 512, usageLog: { userId: 'user', action: 'test', modelTier: 'speed' } })
  expect(await generateTextCompletion('system', 'user', { userId: 'user', action: 'test', modelRuntime: runtime, maxOutputTokens: 512 })).toBe('ready')
  expect(fetch).toHaveBeenCalledTimes(2)
  for (const [, init] of vi.mocked(fetch).mock.calls) {
    const body = JSON.parse(String(init?.body))
    expect(body).toMatchObject({ model: 'fixture-model', max_completion_tokens: 512 })
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('max_tokens')
    expect(body).not.toHaveProperty('thinking')
    if (reasoningParameterMode === 'native') expect(body.reasoning_effort).toBe(reasoningEffort)
    else expect(body).not.toHaveProperty('reasoning_effort')
  }
})

it('keeps undeclared protocols unknown and allows explicitly clearing declarations', async () => {
  expect(await getModelTierRuntime('speed')).not.toHaveProperty('reasoningParameterMode')
  await updateAdminModel('admin', 'builtin', { reasoningParameterMode: 'native', outputTokenParameter: 'max_tokens', thinkingEnabled: true })
  expect((await getAdminModelManagement()).models[0]).toMatchObject({ thinkingEnabled: true })
  await updateAdminModel('admin', 'builtin', { reasoningParameterMode: null, outputTokenParameter: null, thinkingEnabled: null })
  const runtime = await getModelTierRuntime('speed')
  expect(runtime).not.toHaveProperty('reasoningParameterMode')
  expect(runtime).not.toHaveProperty('outputTokenParameter')
  expect(runtime).not.toHaveProperty('thinkingEnabled')
  expect(fetch).not.toHaveBeenCalled()
})

it.each(['opaque', 'openai', 'deepseek'].flatMap(provider => efforts.map(reasoningEffort => ({ provider, reasoningEffort,
  temperature: reasoningEffort === 'none' ? 0.45 : undefined }))))('encodes legacy $provider $reasoningEffort without inventing protocol capabilities', async input => {
  mocks.row = { ...mocks.row, provider: input.provider,
    metadata: { reasoningEfforts: efforts, defaultReasoningEffort: input.reasoningEffort } }
  const runtime = await getModelTierRuntime('speed')
  expect(runtime).not.toHaveProperty('reasoningParameterMode')
  await chatWithTools({ messages: [], tools: [], provider: runtime.provider, model: runtime.modelName!,
    providerBaseUrl: runtime.baseUrl, providerApiKey: runtime.apiKey, reasoningEffort: runtime.reasoningEffort,
    temperature: 0.45, usageLog: { userId: 'user', action: 'test', modelTier: 'speed' } })
  await generateTextCompletion('system', 'user', { userId: 'user', action: 'test', modelRuntime: runtime, temperature: 0.45 })
  expect(fetch).toHaveBeenCalledTimes(2)
  for (const [, init] of vi.mocked(fetch).mock.calls) {
    const body = JSON.parse(String(init?.body))
    if (input.temperature === undefined) expect(body).not.toHaveProperty('temperature')
    else expect(body.temperature).toBe(input.temperature)
    if (input.provider === 'deepseek' && input.reasoningEffort === 'none') expect(body).not.toHaveProperty('reasoning_effort')
    else expect(body.reasoning_effort).toBe(input.reasoningEffort)
    expect(body).toHaveProperty('max_tokens')
    if (input.provider === 'deepseek') expect(body.thinking).toEqual({ type: input.reasoningEffort === 'none' ? 'disabled' : 'enabled' })
    else expect(body).not.toHaveProperty('thinking')
  }
})
