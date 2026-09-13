import type { Prisma } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  db: { chapter: { findFirst: vi.fn(), updateMany: vi.fn() }, $transaction: vi.fn() },
  tx: {
    $queryRaw: vi.fn(),
    agentRun: { findFirst: vi.fn() },
    chapter: { findFirst: vi.fn(), findFirstOrThrow: vi.fn(), updateMany: vi.fn(), create: vi.fn(), count: vi.fn() },
    volume: { findFirst: vi.fn() }, agentTaskRoot: { findUniqueOrThrow: vi.fn() },
  },
  stats: vi.fn(), memory: vi.fn(), compiler: vi.fn(), flags: vi.fn(), craft: vi.fn(), placement: vi.fn(), place: vi.fn(),
  prepare: vi.fn(), prepareCursor: vi.fn(), commit: vi.fn(), failure: vi.fn(), reduce: vi.fn(),
}))
vi.mock('../../api/lib/prisma.js', () => ({
  prisma: m.db,
  DataAccessError: class extends Error { constructor(public status: number, public code: string, message: string) { super(message) } },
}))
vi.mock('../../api/lib/data/internal.js', async original => ({
  ...await original<typeof import('../../api/lib/data/internal.js')>(), recalculateNovelStats: m.stats,
}))
vi.mock('../../api/lib/data/volume.js', () => ({ resolveChapterPlacement: m.placement, placeCreatedChapter: m.place }))
vi.mock('../../api/lib/agent/story-memory.js', () => ({ enqueueChapterMemoryExtraction: m.memory }))
vi.mock('../../api/lib/agent/story-compiler.js', () => ({ recordStoryCompilerWrite: m.compiler }))
vi.mock('../../api/lib/agent/craft-library.js', () => ({ assertCraftOutputSafe: m.craft }))
vi.mock('../../api/lib/agent2-feature-flags.js', () => ({ isAgent2FeatureEnabled: m.flags }))
vi.mock('../../api/lib/agent/runtime-operations.js', () => ({ prepareOperation: m.prepare, commitOperationEffect: m.commit, recordToolFailure: m.failure }))
vi.mock('../../api/lib/agent/runtime-tool-cursor.js', () => ({ prepareToolCursorOperation: m.prepareCursor, rejectToolCursorCall: vi.fn() }))
vi.mock('../../api/lib/agent/runtime-reducer.js', async () => {
  const { z } = await import('zod')
  return { reduceExecutionReceipt: m.reduce, failedToolResultSchema: z.object({ outcome: z.literal('failed'), effectApplied: z.literal(false), code: z.string(), toolResult: z.object({ output: z.string(), summary: z.string() }) }).strict() }
})
vi.mock('../../api/lib/agent/tools/durable-create.js', () => ({ executeDurableCreate: vi.fn() }))

import { activeChapterScope } from '../../api/lib/data/internal.js'
import { clearRunBaselines, getChapterBaseline, recordChapterBaseline, recordCreatedChapter } from '../../api/lib/agent/baseline.js'
import { chapterAppendTool, chapterCreateTool, chapterEditRangeTool, chapterRenameTool, chapterWriteTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { executeDurableChapter, executeDurableChapterRename } from '../../api/lib/agent/tools/durable-chapter.js'
import type { AgentTool, ToolContext, ToolResult } from '../../api/lib/agent/tools/types.js'

const tx = m.tx as unknown as Prisma.TransactionClient
const row = { id: 'c', novelId: 'n', authorId: 'u', volumeId: 'v', title: 'Title', content: 'Before', revision: 4, wordCount: 6, orderIndex: 1, orderInVolume: 1, status: 'published', visibility: 'public', publishedContent: 'Snapshot', publishedRevision: 2, archivedAt: null }
const ctx = (overrides: Partial<ToolContext> = {}): ToolContext => ({ userId: 'u', novelId: 'n', chapterId: 'c', runId: 'r', sessionId: 's', callId: 'call', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'premium', signal: new AbortController().signal, emit: () => {}, ...overrides })
const durable = (action: string, cursor = true) => ctx({
  toolAuthority: new Map([[action, { permission: 'allow', alwaysConfirm: false, dangerous: false }]]),
  durableContent: { chapterId: 'c', expectedRevision: 4, operationKey: 'write', lease: { userId: 'u', runId: 'r', taskRootId: 'root', ownerId: 'worker', claimId: 'claim', epoch: 1n }, ...(cursor ? { cursor: { expectedRevision: 1, expectedHash: 'frame' } } : {}) },
})
const legacy: Array<[string, (context: ToolContext) => Promise<ToolResult>]> = [
  ['write', context => chapterWriteTool.execute(context, { content: 'After' })],
  ['append', context => chapterAppendTool.execute(context, { content: 'After' })],
  ['edit', context => chapterEditRangeTool.execute(context, { oldText: 'Before', newText: 'After' })],
  ['rename', context => chapterRenameTool.execute(context, { title: 'After' })],
]
const actions = ['chapter_write', 'chapter_append', 'chapter_edit_range'] as const
const contentArgs = (action: typeof actions[number], unchanged = false) => action === 'chapter_edit_range'
  ? { chapterId: 'c', oldText: 'Before', newText: unchanged ? 'Before' : 'After' }
  : { chapterId: 'c', content: unchanged ? 'Before' : 'After' }

beforeEach(() => {
  vi.resetAllMocks()
  m.tx.$queryRaw.mockResolvedValue([{ id: 'n' }])
  m.tx.agentRun.findFirst.mockResolvedValue({ manuscriptRevision: 0, novel: { authorId: 'u', manuscriptRevision: 0 } })
  clearRunBaselines('r')
  m.db.$transaction.mockImplementation(work => work(tx))
  m.db.chapter.findFirst.mockResolvedValue(row)
  m.tx.chapter.findFirst.mockResolvedValue(row)
  m.tx.chapter.updateMany.mockResolvedValue({ count: 1 })
  m.tx.chapter.count.mockResolvedValue(1)
  m.tx.agentTaskRoot.findUniqueOrThrow.mockResolvedValue({ novelId: 'n', sessionId: 's' })
  m.flags.mockImplementation(name => name === 'memory2' || name === 'storyCompiler')
  m.memory.mockResolvedValue('job')
  const operation = { id: 'op', inputHash: 'hash' }
  m.prepare.mockResolvedValue(operation)
  m.prepareCursor.mockResolvedValue({ operation, pending: { revision: 2, snapshotHash: 'pending' } })
  m.commit.mockImplementation(async (_lease, _id, _hash, work) => ({ result: await work(tx) }))
  m.failure.mockImplementation(async (_lease, input) => ({ result: { outcome: 'failed', effectApplied: false, code: input.code, toolResult: { output: input.output, summary: input.summary } } }))
})

function expectNoEffects() {
  expect(m.stats).not.toHaveBeenCalled()
  expect(m.memory).not.toHaveBeenCalled()
  expect(m.compiler).not.toHaveBeenCalled()
}
function expectCas() {
  expect(m.tx.chapter.updateMany.mock.calls[0][0].where).toEqual({ id: 'c', ...activeChapterScope('n'), authorId: 'u', revision: 4 })
  const data = m.tx.chapter.updateMany.mock.calls[0][0].data
  expect(data.revision).toEqual({ increment: 1 })
  for (const key of ['archivedAt', 'archivedByImportId', 'status', 'visibility', 'publishedContent', 'publishedRevision']) expect(data).not.toHaveProperty(key)
}

describe('legacy Agent chapter archive guards', () => {
  it.each(legacy)('%s rejects the previous manuscript epoch even if chapter revision still matches', async (_name, execute) => {
    recordChapterBaseline('r', 'c', 4)
    m.tx.agentRun.findFirst.mockResolvedValue({ manuscriptRevision: 0, novel: { authorId: 'u', manuscriptRevision: 1 } })
    await expect(execute(ctx())).rejects.toMatchObject({ code: 'IMPORT_SCOPE_CHANGED' })
    expect(m.tx.chapter.updateMany).not.toHaveBeenCalled()
    expectNoEffects()
  })

  it('does not create a target-less chapter from a run authorized before import/restore', async () => {
    m.tx.agentRun.findFirst.mockResolvedValue({ manuscriptRevision: 0, novel: { authorId: 'u', manuscriptRevision: 1 } })
    await expect(chapterCreateTool.execute(ctx(), { title: 'Next chapter' })).rejects.toMatchObject({ code: 'IMPORT_SCOPE_CHANGED' })
    expect(m.tx.volume.findFirst).not.toHaveBeenCalled()
    expect(m.tx.chapter.create).not.toHaveBeenCalled()
    expectNoEffects()
  })
  it.each(legacy)('%s rejects an archived chapter or archived parent volume with a still-matching baseline', async (_name, execute) => {
    recordChapterBaseline('r', 'c', 4)
    m.db.chapter.findFirst.mockResolvedValue(null)
    expect(await execute(ctx())).toMatchObject({ outcome: 'failed' })
    expect(m.db.chapter.findFirst).toHaveBeenCalledWith({ where: { id: 'c', ...activeChapterScope('n'), authorId: 'u' } })
    expect(m.tx.chapter.updateMany).not.toHaveBeenCalled()
    expectNoEffects()
  })

  it.each(legacy)('%s fences archival after its read without changing status or recording effects', async (_name, execute) => {
    recordChapterBaseline('r', 'c', 4)
    m.tx.chapter.updateMany.mockResolvedValue({ count: 0 })
    expect(await execute(ctx())).toMatchObject({ outcome: 'failed' })
    expectCas()
    expectNoEffects()
    expect(getChapterBaseline('r', 'c')).toBe(4)
  })

  it.each(legacy)('%s still rejects stale revision baselines before CAS', async (_name, execute) => {
    recordChapterBaseline('r', 'c', 3)
    expect(await execute(ctx())).toMatchObject({ outcome: 'failed' })
    expect(m.tx.chapter.updateMany).not.toHaveBeenCalled()
    expectNoEffects()
  })

  it.each(legacy)('%s keeps caller transaction and publication state, without advancing an uncommitted baseline', async (_name, execute) => {
    m.tx.chapter.findFirst.mockResolvedValueOnce(row).mockResolvedValueOnce({ ...row, revision: 5 })
    expect((await execute(ctx({ transaction: tx }))).outcome).toBeUndefined()
    expectCas()
    expect(m.db.chapter.findFirst).not.toHaveBeenCalled()
    expect(m.db.chapter.updateMany).not.toHaveBeenCalled()
    expect(m.db.$transaction).not.toHaveBeenCalled()
    expect(m.stats).toHaveBeenCalledWith(tx, 'n')
    expect(getChapterBaseline('r', 'c')).toBeNull()
    for (const [, transaction] of m.memory.mock.calls) expect(transaction).toBe(tx)
    for (const [, transaction] of m.compiler.mock.calls) expect(transaction).toBe(tx)
  })

  it('binds the legacy returned revision to its CAS inside the short transaction', async () => {
    m.tx.chapter.findFirst.mockResolvedValue({ ...row, revision: 5 })
    const result = await chapterWriteTool.execute(ctx(), { content: 'After' })
    expect(result.display).toMatchObject({ revision: 5, appliedDirectly: true })
    expect(m.db.$transaction).toHaveBeenCalledTimes(1)
    expect(m.tx.chapter.findFirst).toHaveBeenCalledWith({ where: { id: 'c', ...activeChapterScope('n'), authorId: 'u', revision: 5 } })
  })

  it('does not recreate an archived ID cached by an old run', async () => {
    recordCreatedChapter('r', 'Title', 'old')
    m.db.chapter.findFirst.mockResolvedValue(null)
    expect(await chapterCreateTool.execute(ctx(), { title: 'Title' })).toMatchObject({ outcome: 'failed' })
    expect(m.tx.chapter.create).not.toHaveBeenCalled()
    expect(m.db.$transaction).not.toHaveBeenCalled()
  })

  it('throws inside the transaction if post-CAS active hydration fails, instead of committing a reported failure', async () => {
    m.tx.chapter.findFirst.mockResolvedValue(null)
    await expect(chapterWriteTool.execute(ctx(), { content: 'After' })).rejects.toMatchObject({ code: 'CHAPTER_REVISION_CONFLICT' })
    expectCas()
    expectNoEffects()
    expect(getChapterBaseline('r', 'c')).toBeNull()
  })

  it('rejects an archived volume ordinal before creating anything', async () => {
    m.tx.volume.findFirst.mockResolvedValue(null)
    await expect(chapterCreateTool.execute(ctx(), { title: 'New', volumeOrder: 1 })).rejects.toMatchObject({ code: 'VOLUME_NOT_FOUND' })
    expect(m.tx.volume.findFirst).toHaveBeenCalledWith({ where: { novelId: 'n', archivedAt: null, orderIndex: 1 } })
    expect(m.tx.chapter.create).not.toHaveBeenCalled()
  })

  it('scopes global placement, last chapter, count and created-row hydration', async () => {
    m.placement.mockResolvedValue({ volume: { id: 'v' }, count: 1, position: 0 })
    m.tx.chapter.create.mockResolvedValue(row)
    m.tx.chapter.findFirstOrThrow.mockResolvedValue({ ...row, volume: { title: 'Volume', orderIndex: 1 } })
    await chapterCreateTool.execute(ctx(), { title: 'New', position: 1 })
    expect(m.tx.chapter.findFirst).toHaveBeenCalledWith({ where: { ...activeChapterScope('n'), orderIndex: 1 } })
    expect(m.tx.chapter.findFirst).toHaveBeenCalledWith({ where: activeChapterScope('n'), orderBy: { orderIndex: 'desc' }, select: { volumeId: true } })
    expect(m.tx.chapter.count).toHaveBeenCalledWith({ where: activeChapterScope('n') })
    expect(m.tx.chapter.findFirstOrThrow.mock.calls[0][0].where).toEqual({ id: 'c', ...activeChapterScope('n'), authorId: 'u' })
    expect(m.tx.chapter.create.mock.calls[0][0].data.status).toBe('draft')
  })
})

describe('durable Agent chapter archive guards', () => {
  it.each(actions)('%s fences an old manuscript before reading/writing chapter effects', async action => {
    m.tx.agentRun.findFirst.mockResolvedValue({ manuscriptRevision: 0, novel: { authorId: 'u', manuscriptRevision: 2 } })
    await expect(executeDurableChapter(durable(action), action, contentArgs(action))).rejects.toMatchObject({ code: 'IMPORT_SCOPE_CHANGED' })
    expect(m.tx.chapter.findFirst).not.toHaveBeenCalled()
    expect(m.tx.chapter.updateMany).not.toHaveBeenCalled()
    expectNoEffects()
  })
  it.each(actions)('%s records failure, not a successful write receipt, for an archived source at the same revision', async action => {
    m.tx.chapter.findFirst.mockResolvedValue(null)
    expect(await executeDurableChapter(durable(action), action, contentArgs(action))).toMatchObject({ outcome: 'failed' })
    expect(m.tx.chapter.findFirst.mock.calls[0][0].where).toEqual({ id: 'c', ...activeChapterScope('n'), authorId: 'u' })
    expect(m.tx.chapter.updateMany).not.toHaveBeenCalled()
    expect(m.failure).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ code: 'CHAPTER_REVISION_CONFLICT' }))
    expectNoEffects()
  })

  it.each(actions)('%s authoritative CAS rejects archive-after-read and leaves memory/compiler untouched', async action => {
    m.tx.chapter.updateMany.mockResolvedValue({ count: 0 })
    expect(await executeDurableChapter(durable(action), action, contentArgs(action))).toMatchObject({ outcome: 'failed' })
    expectCas()
    expectNoEffects()
    expect(getChapterBaseline('r', 'c')).toBeNull()
  })

  it.each(actions)('%s successful CAS preserves publication and stays in the effect transaction', async action => {
    expect((await executeDurableChapter(durable(action), action, contentArgs(action))).display).toMatchObject({ revision: 5 })
    expectCas()
    expect(m.stats).toHaveBeenCalledWith(tx, 'n')
    expect(m.memory.mock.calls[0][1]).toBe(tx)
    expect(m.compiler.mock.calls[0][1]).toBe(tx)
    expect(m.db.chapter.updateMany).not.toHaveBeenCalled()
  })

  it('non-cursor durable writes throw conflict rather than manufacturing success', async () => {
    m.tx.chapter.updateMany.mockResolvedValue({ count: 0 })
    await expect(executeDurableChapter(durable('chapter_write', false), 'chapter_write', contentArgs('chapter_write'))).rejects.toMatchObject({ code: 'CHAPTER_REVISION_CONFLICT' })
    expectNoEffects()
  })

  it.each(['archived', 'stale', 'race'])('durable rename rejects %s with no successful rename effect', async scenario => {
    if (scenario === 'archived') m.tx.chapter.findFirst.mockResolvedValue(null)
    if (scenario === 'stale') m.tx.chapter.findFirst.mockResolvedValue({ ...row, revision: 5 })
    if (scenario === 'race') m.tx.chapter.updateMany.mockResolvedValue({ count: 0 })
    expect(await executeDurableChapterRename(durable('chapter_rename'), chapterRenameTool as AgentTool, { chapterId: 'c', title: 'After' })).toMatchObject({ outcome: 'failed' })
    if (scenario === 'race') expectCas()
    else expect(m.tx.chapter.updateMany).not.toHaveBeenCalled()
    expectNoEffects()
  })

  it('durable rename now uses count-checked owner/revision/active CAS', async () => {
    expect((await executeDurableChapterRename(durable('chapter_rename'), chapterRenameTool as AgentTool, { chapterId: 'c', title: 'After' })).outcome).toBeUndefined()
    expectCas()
    expect(m.stats).toHaveBeenCalledWith(tx, 'n')
  })

  it('unchanged durable body/title still requires an active source and produces no content mutation', async () => {
    await executeDurableChapter(durable('chapter_write'), 'chapter_write', contentArgs('chapter_write', true))
    await executeDurableChapterRename(durable('chapter_rename'), chapterRenameTool as AgentTool, { chapterId: 'c', title: 'Title' })
    expect(m.tx.chapter.updateMany).not.toHaveBeenCalled()
    expectNoEffects()
    m.tx.chapter.findFirst.mockResolvedValue(null)
    expect(await executeDurableChapter(durable('chapter_write'), 'chapter_write', contentArgs('chapter_write', true))).toMatchObject({ outcome: 'failed' })
    expect(await executeDurableChapterRename(durable('chapter_rename'), chapterRenameTool as AgentTool, { chapterId: 'c', title: 'Title' })).toMatchObject({ outcome: 'failed' })
  })
})
