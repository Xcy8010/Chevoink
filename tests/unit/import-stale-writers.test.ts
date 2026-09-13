import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  db: {
    $queryRaw: vi.fn(), $transaction: vi.fn(),
    chapter: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    novel: { findFirst: vi.fn(), update: vi.fn() },
    agentRun: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
    agentSession: { findFirst: vi.fn() }, agentMessage: { findFirst: vi.fn(), findMany: vi.fn() },
    agentArtifact: { deleteMany: vi.fn() },
    changeSet: { findFirst: vi.fn(), update: vi.fn() }, changeSetPatch: { updateMany: vi.fn() },
    storyBranch: { findFirst: vi.fn(), update: vi.fn() },
    memoryExtractionJob: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
    projectMemoryEntry: { deleteMany: vi.fn(), findFirst: vi.fn(), findUniqueOrThrow: vi.fn(), update: vi.fn() },
    memoryEvidence: { findMany: vi.fn() }, storyEntity: { findMany: vi.fn() },
    memoryRevision: { findFirst: vi.fn() },
  }, stats: vi.fn(), normalize: vi.fn(),
}))
vi.mock('../../api/lib/prisma.js', () => ({ prisma: m.db,
  DataAccessError: class extends Error { constructor(public status: number, public code: string, message: string) { super(message) } },
}))
vi.mock('../../api/lib/data/internal.js', async original => ({
  ...await original<typeof import('../../api/lib/data/internal.js')>(), recalculateNovelStats: m.stats,
}))
vi.mock('../../api/lib/data/volume.js', () => ({ normalizeNovelStructure: m.normalize }))
vi.mock('../../api/lib/agent/run-service.js', () => ({ startLoopRun: vi.fn(), stopLoopRun: vi.fn() }))
vi.mock('../../api/lib/agent/active-runs.js', () => ({ getActiveRunIdBySession: () => null, hasActiveRunInSession: () => false }))
vi.mock('../../api/lib/agent/runtime-event-projection.js', () => ({ publishDurableEvents: vi.fn() }))
vi.mock('../../api/lib/ai-service.js', () => ({ generateTextCompletion: vi.fn() }))
vi.mock('../../api/lib/credits.js', () => ({ getAuxiliaryModelRuntime: vi.fn() }))

import { activeChapterScope } from '../../api/lib/data/internal.js'
import { lockNovelActiveScope } from '../../api/lib/data/novel-write-lock.js'
import { assertAgentManuscriptCurrent, withAgentManuscriptWrite } from '../../api/lib/agent/manuscript-scope.js'
import { applyChangeSetData, rollbackChangeSetData } from '../../api/lib/data/changeset.js'
import { mergeStoryBranch } from '../../api/lib/agent/productivity.js'
import { rollbackLoopSessionFromMessage } from '../../api/lib/agent/session-messages.js'
import { applyMemoryExtractionJob, resolveMemoryReview, getMemoryGraph } from '../../api/lib/agent/story-memory.js'

const tx = m.db as unknown as Prisma.TransactionClient
const scope = { userId: 'u', novelId: 'n', runId: 'r' }
const chapter = { id: 'c', title: 'Chapter', content: 'Before', summary: null, revision: 4, wordCount: 6 }
const hash = (value: string) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const changeset = (status: string) => ({ id: 'set', novelId: 'n', userId: 'u', status, validations: [],
  patches: [{ id: 'p', targetId: 'c', targetType: 'chapter', field: 'content', before: 'Before', beforeHash: hash('Before'),
    after: 'After', expectedRevision: 4, appliedRevision: status === 'applied' ? 4 : null, selected: true }],
})

beforeEach(() => {
  vi.resetAllMocks()
  m.db.$transaction.mockImplementation(work => work(tx))
  m.db.$queryRaw.mockResolvedValue([{ id: 'n' }])
  m.db.agentRun.findFirst.mockResolvedValue({ manuscriptRevision: 2, novel: { authorId: 'u', manuscriptRevision: 2 } })
  m.db.chapter.findFirst.mockResolvedValue(chapter)
  m.db.chapter.updateMany.mockResolvedValue({ count: 1 })
  m.db.chapter.deleteMany.mockResolvedValue({ count: 1 })
  m.db.chapter.count.mockResolvedValue(1)
})

describe('import manuscript epoch', () => {
  it('uses a parameterized novel row lock, including an empty manuscript', async () => {
    await lockNovelActiveScope(tx, "n'; DROP TABLE novels;--")
    expect(m.db.$queryRaw.mock.calls[0][0].join('?')).toBe('SELECT id FROM novels WHERE id = ? FOR UPDATE')
    expect(m.db.$queryRaw.mock.calls[0][1]).toBe("n'; DROP TABLE novels;--")
    m.db.$queryRaw.mockResolvedValue([])
    await expect(lockNovelActiveScope(tx, 'missing')).rejects.toMatchObject({ code: 'NOVEL_NOT_FOUND' })
  })
  it.each([null, { manuscriptRevision: 1, novel: { authorId: 'u', manuscriptRevision: 2 } },
    { manuscriptRevision: 2, novel: { authorId: 'other', manuscriptRevision: 2 } },
    { manuscriptRevision: undefined, novel: { authorId: 'u', manuscriptRevision: 2 } }])('rejects stale/missing/foreign authority before target-less create: %j', async run => {
    m.db.agentRun.findFirst.mockResolvedValue(run)
    const create = vi.fn()
    await expect(withAgentManuscriptWrite(scope, create)).rejects.toMatchObject({ code: 'IMPORT_SCOPE_CHANGED', status: 409 })
    expect(create).not.toHaveBeenCalled()
    expect(m.db.agentRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'r', userId: 'u', novelId: 'n' } }))
  })
  it('retains caller transaction and holds the lock across version check and mutation', async () => {
    const create = vi.fn().mockResolvedValue('written')
    await expect(withAgentManuscriptWrite({ ...scope, transaction: tx }, create)).resolves.toBe('written')
    expect(create).toHaveBeenCalledWith(tx)
    expect(m.db.$transaction).not.toHaveBeenCalled()
    expect(m.db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(m.db.agentRun.findFirst.mock.invocationCallOrder[0])
    expect(m.db.agentRun.findFirst.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0])
    // A second invocation cannot reuse a cached epoch, even in the same process.
    m.db.agentRun.findFirst.mockResolvedValue({ manuscriptRevision: 2, novel: { authorId: 'u', manuscriptRevision: 3 } })
    await expect(assertAgentManuscriptCurrent(tx, scope)).rejects.toMatchObject({ code: 'IMPORT_SCOPE_CHANGED' })
  })
})

describe('retained chapter write protection', () => {
  it.each(['before read', 'while waiting for novel lock'])('never retries a changeset invalidated by import/restore: %s', async phase => {
    const old = changeset('failed')
    const invalid = { ...old, validations: [{ code: 'IMPORT_SCOPE_CHANGED', status: 'failed', message: 'Source replaced', targetIds: ['c'] }] }
    if (phase === 'before read') m.db.changeSet.findFirst.mockResolvedValue(invalid)
    else m.db.changeSet.findFirst.mockResolvedValueOnce(old).mockResolvedValue(invalid)
    await expect(applyChangeSetData('u', 'set', {})).rejects.toMatchObject({ code: 'IMPORT_SCOPE_CHANGED' })
    expect(m.db.chapter.findFirst).not.toHaveBeenCalled()
    expect(m.db.chapter.updateMany).not.toHaveBeenCalled()
    expect(m.stats).not.toHaveBeenCalled()
  })
  it.each(['apply', 'rollback'])('%s old changeset rejects archived sources even when hashes match', async mode => {
    m.db.changeSet.findFirst.mockResolvedValue(changeset(mode === 'apply' ? 'draft' : 'applied'))
    m.db.chapter.findFirst.mockResolvedValue(null)
    await expect(mode === 'apply' ? applyChangeSetData('u', 'set', {}) : rollbackChangeSetData('u', 'set'))
      .rejects.toMatchObject({ code: 'CHANGESET_TARGET_MISSING' })
    expect(m.db.chapter.findFirst).toHaveBeenCalledWith({ where: { id: 'c', authorId: 'u', ...activeChapterScope('n') } })
    expect(m.db.chapter.updateMany).not.toHaveBeenCalled()
    expect(m.stats).not.toHaveBeenCalled()
  })
  it.each(['apply', 'rollback'])('%s uses count-checked active CAS if archival races its read', async mode => {
    m.db.changeSet.findFirst.mockResolvedValue(changeset(mode === 'apply' ? 'draft' : 'applied'))
    if (mode === 'rollback') m.db.chapter.findFirst.mockResolvedValue({ ...chapter, content: 'After' })
    m.db.chapter.updateMany.mockResolvedValue({ count: 0 })
    await expect(mode === 'apply' ? applyChangeSetData('u', 'set', {}) : rollbackChangeSetData('u', 'set'))
      .rejects.toMatchObject({ status: 409 })
    expect(m.db.chapter.updateMany.mock.calls[0][0].where).toEqual({ id: 'c', authorId: 'u', ...activeChapterScope('n'), revision: 4 })
    expect(m.stats).not.toHaveBeenCalled()
  })
  it.each(['archived', 'raced'])('branch merge rejects %s target without stats/merged receipt', async mode => {
    m.db.storyBranch.findFirst.mockResolvedValue({ id: 'b', novelId: 'n', chapterId: 'c', status: 'active', baseRevision: 4, headContent: 'After' })
    if (mode === 'archived') m.db.chapter.findFirst.mockResolvedValue(null)
    else m.db.chapter.updateMany.mockResolvedValue({ count: 0 })
    await expect(mergeStoryBranch('u', 'b')).rejects.toMatchObject({ code: mode === 'archived' ? 'CHAPTER_NOT_FOUND' : 'BRANCH_CONFLICT' })
    if (mode === 'raced') expect(m.db.chapter.updateMany.mock.calls[0][0].where).toEqual({ id: 'c', ...activeChapterScope('n'), authorId: 'u', revision: 4 })
    expect(m.db.novel.update).not.toHaveBeenCalled()
    expect(m.db.storyBranch.update).not.toHaveBeenCalled()
  })
  it.each(['chapter_create', 'chapter_write'])('session rollback refuses old %s and keeps all history', async toolName => {
    m.db.agentSession.findFirst.mockResolvedValue({ id: 's', novelId: 'n' })
    m.db.agentMessage.findFirst.mockResolvedValue({ runId: 'r' })
    m.db.agentRun.findUnique.mockResolvedValue({ id: 'r', createdAt: new Date() })
    m.db.agentRun.findMany.mockResolvedValue([{ id: 'r' }])
    m.db.agentMessage.findMany.mockResolvedValue([{ parts: [{ type: 'tool-call', status: 'success', toolName,
      ...(toolName === 'chapter_create' ? { display: { kind: 'chapterRef', chapterId: 'c' } }
        : { snapshot: { target: 'chapter', targetId: 'c', field: 'content', previousValue: 'Before' } }),
    }] }])
    m.db.chapter.count.mockResolvedValue(0)
    await expect(rollbackLoopSessionFromMessage('u', 's', 'message')).rejects.toMatchObject({ code: 'CHAPTER_REVISION_CONFLICT' })
    expect(m.db.chapter.deleteMany).not.toHaveBeenCalled()
    expect(m.db.chapter.updateMany).not.toHaveBeenCalled()
    expect(m.db.agentRun.deleteMany).not.toHaveBeenCalled()
    expect(m.normalize).not.toHaveBeenCalled()
  })
})

describe('background memory and pending review', () => {
  it.each([null, { ...chapter, revision: 5 }])('marks invalidated extraction stale and emits no derived memory: %j', async row => {
    m.db.memoryExtractionJob.findUniqueOrThrow.mockResolvedValue({ id: 'job', novelId: 'n', chapterId: 'c', chapterRevision: 4 })
    m.db.chapter.findFirst.mockResolvedValue(row)
    await expect(applyMemoryExtractionJob(tx, 'job')).resolves.toEqual({ status: 'stale', memoryIds: [] })
    expect(m.db.chapter.findFirst.mock.calls[0][0].where).toEqual({ id: 'c', ...activeChapterScope('n') })
    expect(m.db.memoryExtractionJob.update).toHaveBeenCalledWith({ where: { id: 'job' }, data: { status: 'completed', errorMessage: 'stale_revision_skipped', leaseUntil: null } })
    expect(m.db.projectMemoryEntry.update).not.toHaveBeenCalled()
  })
  it('cannot accept old pending review from an archived chapter at the same revision', async () => {
    m.db.projectMemoryEntry.findFirst.mockResolvedValueOnce({ novelId: 'n' }).mockResolvedValueOnce(null)
    m.db.projectMemoryEntry.findUniqueOrThrow.mockResolvedValue({ id: 'mem', novelId: 'n', status: 'inferred', reviewStatus: 'pending' })
    m.db.memoryEvidence.findMany.mockResolvedValue([{ sourceId: 'c', revision: 4 }])
    m.db.chapter.findFirst.mockResolvedValue(null)
    await expect(resolveMemoryReview('u', 'mem', true)).rejects.toMatchObject({ code: 'MEMORY_SOURCE_REQUIRED' })
    expect(m.db.projectMemoryEntry.update).not.toHaveBeenCalled()
  })
  it('does not return import-invalidated graph edges as live facts', async () => {
    m.db.novel.findFirst.mockResolvedValue({ id: 'n' })
    const entity = { id: 'a', canonicalName: 'A', entityType: 'character', status: 'confirmed', aliases: [], updatedAt: new Date(), relationsFrom: [] }
    m.db.storyEntity.findMany.mockResolvedValue([{ ...entity, relationsFrom: [{ id: 'bad', toEntityId: 'b', revision: -1 }] }, { ...entity, id: 'b' }])
    const graph = await getMemoryGraph('u', 'n')
    expect(graph.edges).toEqual([])
  })
})
