import { beforeEach, expect, it, vi } from 'vitest'
import { getAdminModelManagement, updateAdminModel } from '../../api/lib/admin-credit-model.js'

const mocks = vi.hoisted(() => ({ row: {} as Record<string, unknown>, update: vi.fn(), encrypt: vi.fn((value: string) => `encrypted-${value}`) }))
vi.mock('../../api/lib/secret-box.js', async original => ({ ...await original<object>(), encryptSecret: mocks.encrypt }))
vi.mock('../../api/lib/prisma.js', async original => ({ ...await original<object>(), prisma: {
  aiModelConfig: {
    findMany: vi.fn(async (args: { select?: unknown }) => args.select ? [] : [mocks.row]),
    findFirstOrThrow: vi.fn(async () => mocks.row), update: mocks.update,
  },
  aiUsageLog: { groupBy: vi.fn(async () => []), findMany: vi.fn(async () => []) },
  user: { findUnique: vi.fn(async () => ({ role: 'admin', isSuperAdmin: true, bannedAt: null })) },
  $queryRaw: vi.fn(async () => []),
} }))
vi.mock('../../api/lib/credit-policy.js', async original => ({ ...await original<object>(),
  creditTransaction: async (work: (tx: unknown) => Promise<unknown>) => work((await import('../../api/lib/prisma.js')).prisma),
}))
vi.mock('../../api/lib/billing/rate-cards.js', async original => ({ ...await original<object>(), getActiveTokenPrices: vi.fn(async () => new Map()) }))

beforeEach(() => {
  mocks.row = { id: 'tool-web-fetch', key: 'tool:web-fetch', ownerUserId: null, provider: 'unconfigured', displayName: 'Fetch tool',
    modelName: 'unconfigured', baseUrl: null, apiKeyCiphertext: null, tier: 'tool_fetch', multiplierBps: 10000,
    enabled: false, selectable: false, isDefault: false, sortOrder: 0,
    metadata: { modelKind: 'web_fetch', reasoningEfforts: ['high'], defaultReasoningEffort: 'high', visionEnabled: false },
    updatedAt: new Date('2026-10-19T00:00:00Z') }
  mocks.update.mockReset().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    mocks.row = { ...mocks.row, ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)) }
    return mocks.row
  })
  mocks.encrypt.mockClear()
})

it('roundtrips independent Fetch configuration through the admin payload and save without exposing or borrowing a key', async () => {
  const initial = (await getAdminModelManagement()).models[0]
  expect(initial).toMatchObject({ modelKind: 'web_fetch', enabled: false, provider: 'unconfigured', modelName: 'unconfigured', apiKeyConfigured: false, configurationReady: false })
  await updateAdminModel('fixture-admin', initial.id, { provider: 'deepseek', modelName: 'deepseek-fetch',
    baseUrl: 'https://api.deepseek.com', apiKey: 'offline-fixture-secret', enabled: true, selectable: false })
  const configured = (await getAdminModelManagement()).models[0]
  expect(configured).toMatchObject({ modelKind: 'web_fetch', enabled: true, provider: 'deepseek', modelName: 'deepseek-fetch',
    baseUrl: 'https://api.deepseek.com', apiKeyConfigured: true, configurationReady: true })
  expect(JSON.stringify(configured)).not.toContain('offline-fixture-secret')
  expect(mocks.row.apiKeyCiphertext).toBe('encrypted-offline-fixture-secret')
  await updateAdminModel('fixture-admin', initial.id, { enabled: false })
  expect((await getAdminModelManagement()).models[0]).toMatchObject({ enabled: false, provider: 'deepseek', apiKeyConfigured: true })
})

it.each([{ provider: 'direct', baseUrl: 'https://api.deepseek.com' }, { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1/chat/completions' }])('rejects invalid Fetch admin configuration before saving %j', async config => {
  await expect(updateAdminModel('fixture-admin', 'tool-web-fetch', { ...config, modelName: 'fetch', apiKey: 'offline-fixture-secret', enabled: true }))
    .rejects.toMatchObject({ code: 'WEB_TOOL_CONFIG_INVALID' })
  expect(mocks.update).not.toHaveBeenCalled()
  expect(mocks.encrypt).not.toHaveBeenCalled()
})
