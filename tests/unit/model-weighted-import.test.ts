import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { quoteImportSuggestion, requestImportSuggestion } from '../../api/lib/novel-import/suggestions.js'
const mocks = vi.hoisted(() => ({ find: vi.fn(), create: vi.fn(), update: vi.fn(), chat: vi.fn(), runtime: {} as Record<string, unknown> }))
vi.mock('../../api/lib/secret-box.js', () => ({ decryptSecret: (value: string) => 'key-' + value, encryptSecret: (value: string) => value }))
vi.mock('../../api/lib/ai-service.js', () => ({ chatWithTools: mocks.chat }))
vi.mock('../../api/lib/novel-import/model-router.js', () => ({ assertImportStructureBudget: vi.fn(), resolveImportModelRoute: async () => ({ runtime: mocks.runtime,
  route: { kind: 'basic', fingerprint: 'a'.repeat(64), reasoningEffort: 'low', modelName: 'primary-model' } }) }))
vi.mock('../../api/lib/novel-import-service.js', () => ({ assertNovelImportHuman: vi.fn(), novelImportCapabilities: () => ({ enabled: true }),
  getNovelImportPreview: async () => ({ manifestHash: 'b'.repeat(64), manifestRevision: 1, volumes: [{ chapters: [{ content: '合成原文\n下一段' }] }] }),
  novelImportTransaction: async (work: (tx: unknown) => unknown) => work(db),
}))
vi.mock('../../api/lib/prisma.js', () => ({ DataAccessError: class extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message) } },
  prisma: { novelImportSuggestion: { findFirst: mocks.find, create: mocks.create, update: mocks.update }, novelImportJob: { findFirstOrThrow: async () => job, findUnique: async () => job } } }))
const job = { id: 'job', status: 'ready', expiresAt: new Date('2099-01-01T00:00:00Z'), modelSelection: { kind: 'basic' } }
const db = { novelImportSuggestion: { findFirst: mocks.find, create: mocks.create, count: async () => 0 }, novelImportJob: { findFirst: async () => job } }
const human = { userId: 'owner', novelId: 'novel' } as Parameters<typeof requestImportSuggestion>[0]
const input = { manifestHash: 'b'.repeat(64), manifestRevision: 1, volumeIndex: 0, chapterIndex: 0, fingerprint: 'a'.repeat(64), confirmed: true as const }
const row = () => ({ id: 'suggestion', fingerprint: input.fingerprint, manifestHash: input.manifestHash, status: 'pending', result: null, errorCode: null, createdAt: new Date() })
beforeEach(() => {
  vi.clearAllMocks(); mocks.find.mockResolvedValue(null); mocks.create.mockImplementation(async () => row()); mocks.update.mockImplementation(async ({ data }) => ({ ...row(), ...data }))
  mocks.runtime = { tier: 'basic', provider: 'primary', modelName: 'primary-model', apiKey: 'primary-key', baseUrl: 'https://main.invalid/v1', reasoningEffort: 'low', multiplierBps: 10000,
    weightedRoutes: { primaryWeight: 0, candidates: [{ id: 'import-A', label: 'A', weight: 100, provider: 'relay', modelName: 'unlisted-import-alias', baseUrl: 'https://import.invalid/v1', apiKeyCiphertext: 'cipher-A' }] } }
  mocks.chat.mockResolvedValue({ content: '{"boundaries":[{"offset":0,"title":"合成标题"}],"note":"结构建议"}', finishReason: 'stop' })
})
afterEach(() => vi.restoreAllMocks())
it('keeps the existing quote deterministic and draws only after the unique true dispatch claim', async () => {
  const random = vi.spyOn(Math, 'random').mockReturnValue(0.8)
  const quote = await quoteImportSuggestion(human, 'job', input)
  expect(quote.fingerprint).toBe(input.fingerprint); expect(random).not.toHaveBeenCalled()
  await expect(requestImportSuggestion(human, 'job', input)).resolves.toMatchObject({ status: 'succeeded' })
  expect(random).toHaveBeenCalledOnce(); expect(mocks.chat).toHaveBeenCalledOnce()
  expect(mocks.chat.mock.calls[0][0]).toMatchObject({ provider: 'relay', model: 'unlisted-import-alias', providerBaseUrl: 'https://import.invalid/v1', providerApiKey: 'key-cipher-A',
    weightedRoute: { source: 'candidate', candidateId: 'import-A' }, usageLog: { modelTier: 'basic', multiplierBps: 10000 } })
})
it.each(['prior', 'claim-lost'] as const)('does not draw or send for %s original suggestion evidence', async state => {
  mocks.find.mockReset()
  if (state === 'prior') mocks.find.mockResolvedValue(row())
  else mocks.find.mockResolvedValueOnce(null).mockResolvedValueOnce(row())
  const random = vi.spyOn(Math, 'random')
  await requestImportSuggestion(human, 'job', input)
  expect(random).not.toHaveBeenCalled(); expect(mocks.chat).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled()
})
