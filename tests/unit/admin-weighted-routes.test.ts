import express from 'express'
import request from 'supertest'
import { beforeEach, expect, it, vi } from 'vitest'
import { weightedRoutesInputSchema, sumWeightedRouteWeights } from '../../shared/contracts/model-weighted-routes.js'
import { getAdminModelManagement, updateAdminModel } from '../../api/lib/admin-credit-model.js'
import { presentWeightedRoutes, readWeightedRoutes, saveWeightedRoutes } from '../../api/lib/model-weighted-config.js'
import { encryptSecret, decryptSecret } from '../../api/lib/secret-box.js'
import adminRouter from '../../api/routes/admin.js'

const mocks = vi.hoisted(() => ({ row: {} as Record<string, unknown>, update: vi.fn(), actor: vi.fn(), auth: vi.fn(), audit: vi.fn(), clear: vi.fn() }))
vi.mock('../../api/lib/admin-auth.js', async original => ({ ...await original<object>(), requireAdmin: mocks.auth }))
vi.mock('../../api/lib/data-access.js', async original => ({ ...await original<object>(), recordAdminAuditLog: mocks.audit }))
vi.mock('../../api/lib/tool-model-config.js', async original => ({ ...await original<object>(), clearToolModelRuntimeCache: mocks.clear }))
vi.mock('../../api/lib/prisma.js', async original => ({ ...await original<object>(), prisma: {
  aiModelConfig: { findMany: vi.fn(async (args: { select?: unknown }) => args.select ? [] : [mocks.row]),
    findFirstOrThrow: vi.fn(async () => mocks.row), update: mocks.update },
  creditRateCard: { findMany: vi.fn(async () => []) },
  user: { findUnique: mocks.actor }, $queryRaw: vi.fn(async () => []),
  aiUsageLog: { groupBy: vi.fn(async () => []), findMany: vi.fn(async () => []) },
} }))
vi.mock('../../api/lib/credit-policy.js', async original => ({ ...await original<object>(),
  creditTransaction: async (work: (tx: unknown) => Promise<unknown>) => work((await import('../../api/lib/prisma.js')).prisma),
}))
const candidate = { label: '自由供应商', provider: 'custom-relay-any', modelName: 'arbitrary/model-alias', baseUrl: 'https://relay.invalid/custom/endpoint', weight: 35, apiKey: 'offline-candidate-secret' }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.actor.mockResolvedValue({ role: 'admin', isSuperAdmin: true, bannedAt: null })
  mocks.auth.mockResolvedValue({ id: 'admin', role: 'admin', isSuperAdmin: true })
  mocks.row = { id: 'model', key: 'text:speed', tier: 'speed', provider: 'openai', modelName: 'parent-alias', baseUrl: 'https://parent.invalid',
    apiKeyCiphertext: encryptSecret('offline-parent-key'), multiplierBps: 15000, enabled: true, selectable: true, isDefault: false, sortOrder: 0,
    updatedAt: new Date('2026-10-31T00:00:00Z'), metadata: { modelKind: 'text', customMarker: { preserve: true },
      imageQuality: { supportedValues: ['proxy-high'], defaultValue: 'proxy-high' },
      reasoningEfforts: ['high'], defaultReasoningEffort: 'high', reasoningParameterMode: 'omit',
      routes: [{ id: '11111111-1111-4111-8111-111111111111', label: '原线路', provider: 'original', modelName: 'old', baseUrl: 'https://old.invalid', enabled: false, apiKeyCiphertext: encryptSecret('old-route-key') }] } }
  mocks.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => { mocks.row = { ...mocks.row, ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)) }; return mocks.row })
})
it('validates proportions once at the input boundary without limiting free-form candidates or importing old routes', () => {
  expect(weightedRoutesInputSchema.safeParse({ primaryWeight: 60, candidates: [candidate] }).success).toBe(false)
  const many = weightedRoutesInputSchema.parse({ primaryWeight: 20, candidates: Array.from({ length: 8 }, () => ({ ...candidate, weight: 10 })) })
  expect(many.candidates).toHaveLength(8)
  expect(weightedRoutesInputSchema.parse({ primaryWeight: 2, candidates: [] })).toEqual({ primaryWeight: 100, candidates: [] })
  expect(readWeightedRoutes(mocks.row.metadata)).toBeUndefined()
})
it('creates server IDs, encrypts new keys and presents only configured flags while retaining unrelated configuration', async () => {
  const old = mocks.row.metadata
  await updateAdminModel('admin', 'model', { weightedRoutes: { primaryWeight: 65, candidates: [candidate] } })
  const stored = readWeightedRoutes(mocks.row.metadata)!
  expect(stored.candidates[0].id).toMatch(/^[0-9a-f-]{36}$/)
  expect(decryptSecret(stored.candidates[0].apiKeyCiphertext)).toBe(candidate.apiKey)
  expect(stored.candidates[0]).not.toHaveProperty('apiKey')
  expect(mocks.row.metadata).toMatchObject(old as Record<string, unknown>)
  expect(mocks.row.multiplierBps).toBe(15000)
  expect(mocks.clear).toHaveBeenCalledOnce()
  const view = (await getAdminModelManagement()).models[0]
  expect(view.weightedRoutes).toMatchObject({ primaryWeight: 65, candidates: [{ id: stored.candidates[0].id, weight: 35, apiKeyConfigured: true, provider: candidate.provider, modelName: candidate.modelName }] })
  expect(JSON.stringify(view)).not.toContain(candidate.apiKey)
  expect(JSON.stringify(view)).not.toContain(stored.candidates[0].apiKeyCiphertext)
})
it('keeps IDs and ciphertext on blank-key edits, replaces keys on request, and clears candidates back to primary 100', async () => {
  const initial = saveWeightedRoutes({ primaryWeight: 65, candidates: [{ ...candidate, id: 'client-cannot-assign-new-id' }] }, {})
  expect(initial.candidates[0].id).not.toBe('client-cannot-assign-new-id')
  const first = initial.candidates[0]
  const edited = saveWeightedRoutes({ primaryWeight: 50, candidates: [{ ...candidate, id: first.id, weight: 50, label: '改名', apiKey: '   ' }] }, { weightedRoutes: initial })
  expect(edited.candidates[0]).toMatchObject({ id: first.id, label: '改名', apiKeyCiphertext: first.apiKeyCiphertext })
  const replaced = saveWeightedRoutes({ primaryWeight: 50, candidates: [{ ...candidate, id: first.id, weight: 50, apiKey: 'replacement-key' }] }, { weightedRoutes: edited })
  expect(decryptSecret(replaced.candidates[0].apiKeyCiphertext)).toBe('replacement-key')
  expect(presentWeightedRoutes({ weightedRoutes: replaced })?.candidates[0]).not.toHaveProperty('apiKeyCiphertext')
  await updateAdminModel('admin', 'model', { weightedRoutes: { primaryWeight: 100, candidates: [] } })
  expect(readWeightedRoutes(mocks.row.metadata)).toEqual({ primaryWeight: 100, candidates: [] })
})
it('rejects invalid proportions through HTTP, redacts audit credentials, and retains the existing super-admin boundary', async () => {
  const app = express().use(express.json()).use('/api/admin', adminRouter)
  expect((await request(app).patch('/api/admin/models/model').send({ weightedRoutes: { primaryWeight: 64, candidates: [candidate] } })).status).toBe(400)
  expect(mocks.update).not.toHaveBeenCalled()
  expect((await request(app).patch('/api/admin/models/model').send({ weightedRoutes: { primaryWeight: 65, candidates: [candidate] } })).status).toBe(200)
  expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(candidate.apiKey)
  expect(JSON.stringify(mocks.audit.mock.calls)).toContain('[REPLACED]')
  mocks.update.mockClear(); mocks.auth.mockResolvedValue({ id: 'normal-admin', role: 'admin', isSuperAdmin: false })
  expect((await request(app).patch('/api/admin/models/model').send({ weightedRoutes: { primaryWeight: 65, candidates: [candidate] } })).status).toBe(403)
  expect(mocks.update).not.toHaveBeenCalled()
})

it.each([[0.01, 0.01, 99.98], [1e-7, 1e-7, 99.9999998]])('accepts exact decimal percentages and exponent notation without rounding: %j', (primaryWeight, first, second) => {
  expect(sumWeightedRouteWeights([primaryWeight, first, second])).toBe('100')
  expect(weightedRoutesInputSchema.safeParse({ primaryWeight, candidates: [{ ...candidate, weight: first }, { ...candidate, weight: second }] }).success).toBe(true)
})
it('rejects a truly insufficient decimal total without an epsilon or precision cutoff', () => {
  const candidates = [{ ...candidate, weight: 0.01 }, { ...candidate, weight: 99.97999999999999 }]
  expect(sumWeightedRouteWeights([0.01, ...candidates.map(route => route.weight)])).toBe('99.99999999999999')
  expect(weightedRoutesInputSchema.safeParse({ primaryWeight: 0.01, candidates }).success).toBe(false)
  expect(sumWeightedRouteWeights([1e-7, 2e-7])).toBe('0.0000003')
})
