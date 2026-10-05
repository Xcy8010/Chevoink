import type { Prisma } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  db: { chapter: { findFirst: vi.fn(), updateMany: vi.fn() }, $transaction: vi.fn() },
  tx: {
    $queryRaw: vi.fn(),
    agentRun: { findFirst: vi.fn(), findFirstOrThrow: vi.fn(), update: vi.fn() },
    agentSession: { findFirst: vi.fn() }, agentChildExecutionGrant: { findUnique: vi.fn() },
    // Legacy runs have no AgentGoalExecution; keep the new goal fence on its
    // ordinary no-goal branch while preserving all manuscript assertions.
    agentGoalExecution: { findUnique: vi.fn() },
    chapter: { findFirst: vi.fn(), findFirstOrThrow: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), create: vi.fn(), count: vi.fn() },
    volume: { findFirst: vi.fn(), findMany: vi.fn() }, agentTaskRoot: { findUniqueOrThrow: vi.fn() },
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
import { clearRunBaselines, getChapterBaseline, getCreatedChapter, recordChapterBaseline, recordCreatedChapter } from '../../api/lib/agent/baseline.js'
import { chapterAppendTool, chapterCreateTool, chapterEditRangeTool, chapterRenameTool, chapterWriteTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { executeDurableChapter, executeDurableChapterRename } from '../../api/lib/agent/tools/durable-chapter.js'
import type { AgentTool, ToolContext, ToolResult } from '../../api/lib/agent/tools/types.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'

const tx = m.tx as unknown as Prisma.TransactionClient
const row = { id: 'c', novelId: 'n', authorId: 'u', volumeId: 'v', volume: { title: 'Volume', orderIndex: 1 }, title: 'Title', content: 'Before', revision: 4, wordCount: 6, orderIndex: 1, orderInVolume: 1, status: 'published', visibility: 'public', publishedContent: 'Snapshot', publishedRevision: 2, archivedAt: null }
let ownedRun: Record<string, unknown>
function authorScope(createAt?: number) {
  const prompt = createAt ? `写第${createAt}章，创建该目标章节。` : '修订当前章节的标题和正文。'
  const task = buildTaskSpec({ runId: 'r', novelId: 'n', chapterId: 'c', prompt })
  task.scope.writing = { version: 1, kind: 'bounded', titleAndBodyOnly: false, repairAuthorized: !createAt,
    targets: [{ orderIndex: createAt ?? 1, chapterId: createAt ? null : 'c' }] }
  ownedRun = { id: 'r', userId: 'u', novelId: 'n', sessionId: 's', chapterId: 'c', taskSpec: task,
    startRequest: { prompt }, status: 'running', manuscriptRevision: 0, novel: { authorId: 'u', manuscriptRevision: 0 }, writingBindings: null }
  m.tx.agentRun.findFirst.mockImplementation(async ({ where }) => where.id === 'r' && where.userId === 'u' && where.novelId === 'n' ? ownedRun : null)
  m.tx.agentRun.findFirstOrThrow.mockImplementation(async ({ where }) => {
    if (where.id !== undefined && where.id !== 'r' || where.userId !== 'u' || where.novelId !== 'n'
      || where.taskSpec && where.taskSpec.equals !== task.id) throw new Error('Missing owned original run')
    return ownedRun
  })
  m.tx.agentRun.update.mockImplementation(async ({ data }) => Object.assign(ownedRun, data))
}
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
  m.tx.$queryRaw.mockImplementation(async (strings, ...values) => {
    const sql = strings.join('?')
    if (sql === 'SELECT id FROM novels WHERE id = ? FOR UPDATE' && values[0] === 'n') return [{ id: 'n' }]
    if (sql === 'SELECT id FROM agent_runs WHERE id = ? AND user_id = ? AND novel_id = ? FOR UPDATE'
      && values[0] === 'r' && values[1] === 'u' && values[2] === 'n') return [{ id: 'r' }]
    throw new Error(`Unexpected fixture lock: ${sql}`)
  })
  authorScope()
  m.tx.agentSession.findFirst.mockResolvedValue({ id: 's', userId: 'u', novelId: 'n', spawnedFromRunId: null, spawnedFromSessionId: null })
  m.tx.agentChildExecutionGrant.findUnique.mockResolvedValue(null)
  m.tx.chapter.findMany.mockResolvedValue([row])
  m.tx.volume.findMany.mockResolvedValue([{ id: 'v', title: 'Volume', novelId: 'n', orderIndex: 1, archivedAt: null }])
  m.tx.agentGoalExecution.findUnique.mockResolvedValue(null)
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

  it('validates explicit placement even when the title cache already points to an owned chapter', async () => {
    recordCreatedChapter('r', 'Title', 'c')
    await expect(chapterCreateTool.execute(ctx(), { title: 'Title', position: 2 })).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
    expect(m.tx.chapter.create).not.toHaveBeenCalled()
    expect(m.tx.agentRun.update).not.toHaveBeenCalled()
    expect(getCreatedChapter('r', 'Title')).toBe('c')
    expectNoEffects()
  })

  it.each([{ volumeOrder: 2, positionInVolume: 1 }, { volumeOrder: 1, positionInVolume: 2 }])('rejects an unmatched volume target without falling back to the first slot: %j', async args => {
    m.tx.volume.findFirst.mockResolvedValue({ id: args.volumeOrder === 2 ? 'other-v' : 'v', novelId: 'n', orderIndex: args.volumeOrder, archivedAt: null })
    await expect(chapterCreateTool.execute(ctx(), { title: 'Different', content: 'Must not write', ...args })).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
    expect(m.tx.chapter.create).not.toHaveBeenCalled()
    expect(m.tx.chapter.updateMany).not.toHaveBeenCalled()
    expect(m.tx.agentRun.update).not.toHaveBeenCalled()
    expect(getCreatedChapter('r', 'Different')).toBeNull()
    expectNoEffects()
  })

  it('keeps an actual created chapter retry idempotent after cache placement validation', async () => {
    authorScope(1)
    const created = { ...row, volume: { title: 'Volume', orderIndex: 1 } }
    m.placement.mockResolvedValue({ volume: { id: 'v' }, count: 1, position: 0 })
    m.tx.chapter.create.mockResolvedValue(row)
    m.tx.chapter.findFirstOrThrow.mockResolvedValue(created)
    const first = await chapterCreateTool.execute(ctx(), { title: 'Title', position: 1 })
    expect(first.summary).toContain('新建')
    expect(getCreatedChapter('r', 'Title')).toBe('c')
    m.tx.chapter.findFirst.mockResolvedValue(created)
    m.stats.mockClear()
    m.memory.mockClear()
    m.compiler.mockClear()
    const retry = await chapterCreateTool.execute(ctx(), { title: 'Title', position: 1 })
    expect(retry.summary).toContain('复用')
    expect(retry.observedState?.id).toBe(first.observedState?.id)
    expect(m.tx.chapter.create).toHaveBeenCalledTimes(1)
    expectNoEffects()
  })

  it.each(['explicit-overflow', 'frozen-overflow', 'hydrated-mismatch'] as const)('rejects %s rather than binding a clamped volume insertion to another global slot', async scenario => {
    authorScope(39)
    const chapters = Array.from({ length: 38 }, (_, index) => ({ ...row, id: `c-${index + 1}`, orderIndex: index + 1,
      volumeId: index < 16 ? 'v' : 'v2', orderInVolume: index < 16 ? index + 1 : index - 15, volume: { title: 'Volume', orderIndex: index < 16 ? 1 : 2 } }))
    m.tx.chapter.findMany.mockResolvedValue(chapters)
    m.tx.chapter.findFirst.mockImplementation(async ({ where }) => where.orderIndex === 39 ? null : { ...chapters.at(-1), volumeId: 'v2' })
    m.tx.volume.findFirst.mockResolvedValue({ id: 'v', novelId: 'n', orderIndex: 1, archivedAt: null })
    m.placement.mockResolvedValue({ volume: { id: 'v', orderIndex: 1 }, count: 16, position: 16 })
    if (scenario === 'frozen-overflow') {
      const task = ownedRun.taskSpec as ReturnType<typeof buildTaskSpec>
      task.scope.writing!.targets[0] = { orderIndex: 39, chapterId: null, volumeId: 'v', positionInVolume: 39 }
    }
    if (scenario === 'hydrated-mismatch') {
      m.placement.mockResolvedValue({ volume: { id: 'v2', orderIndex: 2 }, count: 22, position: 22 })
      m.tx.chapter.create.mockResolvedValue({ ...row, id: 'created' })
      m.tx.chapter.findFirstOrThrow.mockResolvedValue({ ...row, id: 'created', orderIndex: 17, orderInVolume: 17 })
    }
    await expect(chapterCreateTool.execute(ctx(), { title: 'Wrong binding', ...(scenario === 'explicit-overflow' ? { volumeOrder: 1, positionInVolume: 39 } : {}) }))
      .rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
    if (scenario !== 'hydrated-mismatch') expect(m.tx.chapter.create).not.toHaveBeenCalled()
    expect(m.tx.agentRun.update).not.toHaveBeenCalled()
    expect(getCreatedChapter('r', 'Wrong binding')).toBeNull()
    expectNoEffects()
  })

  it.each(['volume', 'local'] as const)('keeps frozen %s placement when a bound chapter moved, while omitted placement still reuses its identity', async scenario => {
    const task = ownedRun.taskSpec as ReturnType<typeof buildTaskSpec>
    task.scope.writing!.targets[0] = { orderIndex: 2, chapterId: 'c', volumeId: 'v2', positionInVolume: 1 }
    const moved = { ...row, volumeId: scenario === 'volume' ? 'v' : 'v2', orderInVolume: scenario === 'volume' ? 1 : 2 }
    m.tx.chapter.findMany.mockResolvedValue([moved])
    m.tx.chapter.findFirst.mockResolvedValue(moved)
    m.tx.volume.findFirst.mockResolvedValue({ id: moved.volumeId, novelId: 'n', orderIndex: scenario === 'volume' ? 1 : 2, archivedAt: null })
    await expect(chapterCreateTool.execute(ctx(), { title: 'Must not move', volumeOrder: scenario === 'volume' ? 1 : 2, positionInVolume: moved.orderInVolume }))
      .rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
    await expect(chapterCreateTool.execute(ctx(), { title: 'Must not move', volumeOrder: scenario === 'volume' ? 1 : 2 }))
      .rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
    const omitted = await chapterCreateTool.execute(ctx(), { title: 'Must not move' })
    expect(omitted.summary).toContain('复用')
    expect(omitted.display).toMatchObject({ kind: 'chapterRef', chapterId: 'c' })
    expect(m.tx.chapter.create).not.toHaveBeenCalled()
    expect(m.tx.agentRun.update).not.toHaveBeenCalled()
    expect(getCreatedChapter('r', 'Must not move')).toBeNull()
    expectNoEffects()
  })

  it('truthfully reuses an admitted historical chapter without recording it as newly created or changing stats/body', async () => {
    m.tx.chapter.findFirst.mockResolvedValue({ ...row, volume: { title: 'Volume', orderIndex: 1 } })
    const reused = await chapterCreateTool.execute(ctx(), { title: 'Different', content: 'Must not write', position: 1 })
    expect(reused.summary).toContain('复用')
    expect(reused.output).toContain('本次未创建、改名或写入章节')
    expect(reused.display).toMatchObject({ kind: 'chapterRef', chapterId: 'c' })
    expect(reused.snapshot).toBeUndefined()
    expect(reused.semanticTransition).toBeUndefined()
    expect(getCreatedChapter('r', row.title)).toBeNull()
    expect(getCreatedChapter('r', 'Different')).toBeNull()
    expect(m.tx.chapter.create).not.toHaveBeenCalled()
    expect(m.tx.chapter.updateMany).not.toHaveBeenCalled()
    expectNoEffects()
  })

  it('throws inside the transaction if post-CAS active hydration fails, instead of committing a reported failure', async () => {
    m.tx.chapter.findFirst.mockResolvedValue(null)
    await expect(chapterWriteTool.execute(ctx(), { content: 'After' })).rejects.toMatchObject({ code: 'CHAPTER_REVISION_CONFLICT' })
    expectCas()
    expectNoEffects()
    expect(getChapterBaseline('r', 'c')).toBeNull()
  })

  it('rejects an archived volume ordinal before creating anything', async () => {
    authorScope(2)
    m.tx.volume.findFirst.mockResolvedValue(null)
    await expect(chapterCreateTool.execute(ctx(), { title: 'New', volumeOrder: 1 })).rejects.toMatchObject({ code: 'VOLUME_NOT_FOUND' })
    expect(m.tx.volume.findFirst).toHaveBeenCalledWith({ where: { novelId: 'n', archivedAt: null, orderIndex: 1 } })
    expect(m.tx.chapter.create).not.toHaveBeenCalled()
  })

  it('scopes global placement, last chapter, count and created-row hydration', async () => {
    authorScope(1)
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
