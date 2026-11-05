import { beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareQualityWork } from '../../api/lib/agent/tools/durable-quality.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

const mocks = vi.hoisted(() => ({
  operation: vi.fn(), compilation: vi.fn(), bundle: vi.fn(), compilerHash: vi.fn(), target: vi.fn(),
}))
vi.mock('../../api/lib/agent/runtime-lease.js', async original => ({ ...await original<object>(),
  withRunLease: async (_lease: unknown, work: (tx: unknown) => unknown) => work({
    agentOperation: { findUnique: mocks.operation }, storyCompilation: { findFirst: mocks.compilation },
    agentTaskRoot: { findUniqueOrThrow: async () => ({ sessionId: 'session' }) },
  }),
}))
vi.mock('../../api/lib/agent/runtime-state.js', async original => ({ ...await original<object>(),
  readExecutionStateInTransaction: async () => ({ configuration: { mode: 'review', qualityMode: 'balanced', creativeFreedom: 'balanced', protectedChapterIds: [] } }),
}))
vi.mock('../../api/lib/agent/runtime-compiler-observation.js', async original => ({ ...await original<object>(), compilerStateHash: mocks.compilerHash }))
vi.mock('../../api/lib/agent/tools/chapter-mutation.js', async original => ({ ...await original<object>(), automaticChapterRevisionWritable: async () => false }))
vi.mock('../../api/lib/agent/humanity-quality.js', async original => ({ ...await original<object>(),
  resolveQualityChapterTarget: mocks.target, buildHumanityQualityContext: mocks.bundle, getLatestQualityReport: async () => null,
}))
vi.mock('../../api/lib/agent/tools/humanity-quality-tools.js', async original => ({ ...await original<object>(),
  buildCriticInput: () => 'current source', buildQualityRepairContext: () => 'current context',
}))

const lease = { userId: 'author', runId: 'run', taskRootId: 'root', ownerId: 'worker', claimId: 'claim', epoch: 1n }
const ctx = { userId: 'author', novelId: 'novel', runId: 'run', chapterId: 'chapter', callId: 'check', signal: new AbortController().signal } as ToolContext
const compilation = { id: 'compilation', chapterId: 'chapter', status: 'active', bridge: {}, sceneTasks: [] }
const chapter = { id: 'chapter', title: '合成章节', revision: 3, content: '当前正文已经保存。', novel: { tagNames: [] } }
const input = { operationKey: 'exec:4', observedRevision: 8, baseline: null, args: { compilationId: compilation.id },
  frozenReview: { route: { provider: 'fixture', model: 'fixture', baseUrl: 'https://provider.invalid/v1', maxOutputTokens: 1024 },
    price: { version: 'credits-v1-exact' as const, modelTier: 'speed' as const, multiplierBps: 10000 } } }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.operation.mockResolvedValue(null)
  mocks.compilation.mockResolvedValue(compilation)
  mocks.compilerHash.mockResolvedValue('b'.repeat(64))
  mocks.target.mockResolvedValue(chapter.id)
  mocks.bundle.mockResolvedValue({ chapter, compilation, recentChapters: [], feedback: [], originalRequest: '检查当前章节。' })
})

describe('new quality checks read their current source without a prior read phase', () => {
  it.each([null, { id: compilation.id, hash: 'a'.repeat(64) }])('freezes the real current compiler and body with previous observation %j', async baseline => {
    expect(await prepareQualityWork(ctx, lease, { ...input, baseline })).toMatchObject({ kind: 'check', repair: false,
      compiler: { id: compilation.id, hash: 'b'.repeat(64) }, chapter: { id: chapter.id, revision: chapter.revision, content: chapter.content } })
    expect(mocks.compilation).toHaveBeenCalledWith({ where: { id: compilation.id, userId: ctx.userId, novelId: ctx.novelId,
      run: { taskRootId: lease.taskRootId }, status: { in: ['active', 'completed'] } } })
  })
  it('does not replace a foreign explicit compilation with a current chapter', async () => {
    mocks.compilation.mockResolvedValue(null)
    expect(await prepareQualityWork(ctx, lease, input)).toMatchObject({ kind: 'rejected', code: 'QUALITY_COMPILATION_SCOPE_INVALID' })
    expect(mocks.bundle).not.toHaveBeenCalled()
  })
  it('does not associate the explicitly selected compilation with another current compilation', async () => {
    mocks.bundle.mockResolvedValue({ chapter, compilation: { ...compilation, id: 'other-compilation' }, recentChapters: [], feedback: [] })
    expect(await prepareQualityWork(ctx, lease, input)).toMatchObject({ kind: 'rejected', code: 'QUALITY_COMPILATION_SCOPE_INVALID' })
    expect(mocks.compilerHash).not.toHaveBeenCalled()
  })
  it('keeps already prepared work unchanged instead of refreshing its source', async () => {
    const work = { kind: 'rejected', code: 'QUALITY_SOURCE_STALE', message: 'Original observed refusal' }
    const snapshot = runtimeJson({ input: { work } })
    mocks.operation.mockResolvedValue({ inputSnapshot: snapshot.value, inputHash: snapshot.hash })
    expect(await prepareQualityWork(ctx, lease, input)).toEqual(work)
    expect(mocks.bundle).not.toHaveBeenCalled()
    expect(mocks.compilation).not.toHaveBeenCalled()
  })
})
