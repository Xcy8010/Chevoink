import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  generate: vi.fn(), novel: vi.fn(), chapters: vi.fn(), count: vi.fn(), remove: vi.fn(), runtime: vi.fn(),
}))
vi.mock('../../api/lib/ai-service.js', () => ({ generateTextCompletion: mocks.generate }))
vi.mock('../../api/lib/credits.js', () => ({ getAuxiliaryModelRuntime: mocks.runtime }))
vi.mock('../../api/lib/prisma.js', async importOriginal => ({ ...await importOriginal<typeof import('../../api/lib/prisma.js')>(), prisma: {
  novel: { findFirst: mocks.novel }, storyEntity: { deleteMany: mocks.remove, count: mocks.count },
  chapter: { findMany: mocks.chapters },
} }))

import { syncNovelMemoryProjection } from '../../api/lib/agent/story-memory.js'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.novel.mockResolvedValue({ id: 'n', title: '合成作品', tagNames: [], manuscriptRevision: 1 })
  mocks.count.mockResolvedValue(0)
  mocks.remove.mockResolvedValue({ count: 0 })
  mocks.chapters.mockResolvedValue([{ id: 'c', title: '合成章节', content: '他收起工具，走出了房间。', revision: 1, orderIndex: 1 }])
  mocks.runtime.mockResolvedValue({ tier: 'basic', modelName: 'fixture', multiplierBps: 15000 })
  // Returned invalid data is a known local format failure, never a paid probe.
  mocks.generate.mockResolvedValue('{}')
})

describe('automatic memory graph accounting identity', () => {
  it('keeps the finishing run on its auxiliary request without changing its route or price', async () => {
    await expect(syncNovelMemoryProjection('u', 'n', { runId: 'finished-run' })).rejects.toMatchObject({ code: 'AI_PROVIDER_EMPTY_RESPONSE' })
    expect(mocks.generate).toHaveBeenCalledOnce()
    expect(mocks.generate.mock.calls[0][2]).toMatchObject({ agentRunId: 'finished-run', userId: 'u', novelId: 'n',
      action: 'agentMemoryGraphBuild', targetType: 'novel', targetId: 'n', modelRuntime: { tier: 'basic', multiplierBps: 15000 } })
  })
  it('keeps overlapping callers deduplicated and charges only the initiating context', async () => {
    const first = syncNovelMemoryProjection('u', 'n', { runId: 'first' })
    const second = syncNovelMemoryProjection('u', 'n', { runId: 'second' })
    expect(second).toBe(first)
    await expect(first).rejects.toMatchObject({ code: 'AI_PROVIDER_EMPTY_RESPONSE' })
    expect(mocks.generate).toHaveBeenCalledOnce()
    expect(mocks.generate.mock.calls[0][2]).toMatchObject({ agentRunId: 'first' })
  })
  it('does not invent a run for a separately requested graph refresh', async () => {
    await expect(syncNovelMemoryProjection('u', 'n')).rejects.toMatchObject({ code: 'AI_PROVIDER_EMPTY_RESPONSE' })
    expect(mocks.generate.mock.calls[0][2].agentRunId).toBeUndefined()
  })
})
