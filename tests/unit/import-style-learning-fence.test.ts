import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({ db: {
  $transaction: vi.fn(), $queryRaw: vi.fn(),
  novel: { findFirst: vi.fn() }, agentDataControl: { findUnique: vi.fn() },
  chapter: { count: vi.fn() }, styleProfile: { findFirst: vi.fn() },
  styleLearningJob: { findFirst: vi.fn(), findUnique: vi.fn(), count: vi.fn(), update: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
} }))
vi.mock('../../api/lib/prisma.js', () => ({ prisma: m.db, DataAccessError: class extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
} }))
vi.mock('../../api/lib/agent2-feature-flags.js', () => ({ requireAgent2Feature: vi.fn(), isAgent2FeatureEnabled: () => true }))
vi.mock('../../api/lib/ai-service.js', () => ({ generateTextCompletion: vi.fn() }))
vi.mock('../../api/lib/credits.js', () => ({ getModelTierRuntime: vi.fn(async () => ({ apiKey: 'fixture', modelName: 'fixture', baseUrl: 'https://fixture.invalid' })) }))
import { changeStyleLearning, startStyleLearning } from '../../api/lib/agent/style-learning.js'

beforeEach(() => {
  vi.resetAllMocks()
  m.db.$transaction.mockImplementation(work => work(m.db))
  m.db.$queryRaw.mockResolvedValue([{ id: 'n' }])
  m.db.novel.findFirst.mockResolvedValue({ id: 'n' })
  m.db.agentDataControl.findUnique.mockResolvedValue(null)
  m.db.styleLearningJob.findFirst.mockResolvedValue({ id: 'j', revision: 4, error: 'IMPORT_SOURCE_ARCHIVED', status: 'paused' })
  m.db.styleLearningJob.count.mockResolvedValue(0)
  m.db.styleProfile.findFirst.mockResolvedValue({ id: 'p', document: { metadata: { chapters: [{ id: 'c', revision: 3 }] } } })
  m.db.chapter.count.mockResolvedValue(0)
})
describe('retained style-learning source cannot be reauthorized', () => {
  it.each(['resume', 'retry', 'enable'] as const)('rejects %s with a fresh revision before any mutation', async action => {
    await expect(changeStyleLearning('u', 'n', 'j', { revision: 4, action, consent: true })).rejects.toMatchObject({ status: 409, code: 'IMPORT_SCOPE_CHANGED' })
    expect(m.db.styleLearningJob.update).not.toHaveBeenCalled()
    expect(m.db.styleLearningJob.updateMany).not.toHaveBeenCalled()
    expect(m.db.$queryRaw.mock.calls[0][0].join('?')).toBe('SELECT id FROM novels WHERE id = ? FOR UPDATE')
    expect(m.db.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(m.db.styleLearningJob.findFirst.mock.invocationCallOrder[0])
  })
  const input = { requestId: '7acd7590-79d1-4a35-a313-7676241d8323', profileId: 'p', model: { modelTier: 'standard' as const, customModelId: null, reasoningEffort: 'high' as const }, consent: true as const }
  it('rejects a new request ID that reuses an import-invalidated profile', async () => {
    m.db.styleLearningJob.count.mockResolvedValue(1)
    await expect(startStyleLearning('u', 'n', input)).rejects.toMatchObject({ code: 'IMPORT_SCOPE_CHANGED' })
    expect(m.db.styleLearningJob.count).toHaveBeenCalledWith({ where: { profileId: 'p', error: 'IMPORT_SOURCE_ARCHIVED' } })
    expect(m.db.styleLearningJob.create).not.toHaveBeenCalled()
  })
  it('rejects archived or revision-mismatched chapter evidence even without a prior job', async () => {
    await expect(startStyleLearning('u', 'n', input)).rejects.toMatchObject({ code: 'IMPORT_SCOPE_CHANGED' })
    expect(m.db.chapter.count).toHaveBeenCalledWith({ where: expect.objectContaining({ novelId: 'n', authorId: 'u', archivedAt: null, volume: expect.objectContaining({ archivedAt: null }), OR: [{ id: 'c', revision: 3 }] }) })
    expect(m.db.styleLearningJob.create).not.toHaveBeenCalled()
  })
})
