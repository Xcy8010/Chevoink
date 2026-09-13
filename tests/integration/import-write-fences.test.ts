import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { lockNovelActiveScope } from '../../api/lib/data/novel-write-lock.js'
import { activeChapterScope } from '../../api/lib/data/internal.js'
import { createChapterData, getReaderPayloadData, updateChapterData } from '../../api/lib/data/chapter.js'
import { createVolumeData, getStructureReportData } from '../../api/lib/data/volume.js'
import { assertAgentManuscriptCurrent } from '../../api/lib/agent/manuscript-scope.js'
import { chapterCreateTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { applyMemoryExtractionJob, saveStoryMemory } from '../../api/lib/agent/story-memory.js'
import { mergeStoryBranch } from '../../api/lib/agent/productivity.js'
import { continueLoopRun } from '../../api/lib/agent/run-service.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'

// Root test preflight validates the exact isolated database and least-privilege
// role before this module loads. This suite never starts HTTP/model/native work.
const available = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
afterAll(async () => { await prisma.$disconnect() })

async function fixture() {
  return prisma.$transaction(async tx => {
    const suffix = randomUUID()
    const user = await tx.user.create({ data: { nickname: `Import fence ${suffix}`, passwordHash: 'unused-test-only', isAuthor: true } })
    const novel = await tx.novel.create({ data: { authorId: user.id, slug: `import-fence-${suffix}`, title: 'Fixture', summary: 'Synthetic fixture', status: 'published', visibility: 'public' } })
    const volume = await tx.volume.create({ data: { novelId: novel.id, title: 'Retained volume', orderIndex: 1 } })
    const chapter = await tx.chapter.create({ data: { authorId: user.id, novelId: novel.id, volumeId: volume.id,
      title: 'Draft title', content: 'Draft body', wordCount: 10, orderIndex: 1, orderInVolume: 1, revision: 4,
      status: 'published', visibility: 'public', publishedTitle: 'Public title', publishedContent: 'Public body',
      publishedWordCount: 11, publishedRevision: 2, publishedAt: new Date('2026-01-01') } })
    const session = await tx.agentSession.create({ data: { userId: user.id, novelId: novel.id, title: 'Fixture session' } })
    const run = await tx.agentRun.create({ data: { userId: user.id, novelId: novel.id, sessionId: session.id,
      mode: 'act', action: 'planChapter', agentType: 'storyPlanner', status: 'paused', engine: 'loop', manuscriptRevision: novel.manuscriptRevision } })
    return { user, novel, volume, chapter, session, run }
  })
}

async function clean(f: Awaited<ReturnType<typeof fixture>>) {
  // Only our random fixture's rows, never truncate/shared cleanup.
  await prisma.$transaction(async tx => {
    await tx.memoryExtractionJob.deleteMany({ where: { novelId: f.novel.id } })
    await tx.projectMemoryEntry.deleteMany({ where: { novelId: f.novel.id } })
    await tx.storyBranch.deleteMany({ where: { novelId: f.novel.id } })
    await tx.agentRun.deleteMany({ where: { novelId: f.novel.id } })
    await tx.agentSession.deleteMany({ where: { novelId: f.novel.id } })
    await tx.chapter.deleteMany({ where: { novelId: f.novel.id } })
    await tx.volume.deleteMany({ where: { novelId: f.novel.id } })
    await tx.novel.delete({ where: { id: f.novel.id } })
    await tx.user.delete({ where: { id: f.user.id } })
  })
}

describe.skipIf(!available)('import write fences: real isolated PostgreSQL', () => {
  it('blocks an old-volume create behind the import lock, then rejects instead of making an orphan', async () => {
    const f = await fixture()
    let release!: () => void
    let locked!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const ready = new Promise<void>(resolve => { locked = resolve })
    const importing = prisma.$transaction(async tx => {
      await lockNovelActiveScope(tx, f.novel.id)
      locked()
      await gate
      const archivedAt = new Date()
      await tx.chapter.updateMany({ where: activeChapterScope(f.novel.id), data: { archivedAt, revision: { increment: 1 } } })
      await tx.volume.updateMany({ where: { novelId: f.novel.id, archivedAt: null }, data: { archivedAt, revision: { increment: 1 } } })
      await tx.novel.update({ where: { id: f.novel.id }, data: { manuscriptRevision: { increment: 1 } } })
      await tx.volume.create({ data: { novelId: f.novel.id, title: 'Replacement', orderIndex: 1 } })
    }, { timeout: 10_000 })
    let creation: Promise<unknown> | undefined
    try {
      await ready
      let settled = false
      creation = createChapterData(f.user.id, f.novel.id, { volumeId: f.volume.id, title: 'Late create', content: 'Synthetic', status: 'draft' }, 'private')
        .then(value => ({ value }), error => ({ error })).finally(() => { settled = true })
      await new Promise(resolve => setTimeout(resolve, 80))
      expect(settled).toBe(false)
      release()
      await importing
      expect(await creation).toMatchObject({ error: { code: 'VOLUME_NOT_FOUND' } })
      expect(await prisma.chapter.count({ where: activeChapterScope(f.novel.id) })).toBe(0)
      expect(await prisma.chapter.count({ where: { novelId: f.novel.id } })).toBe(1)
      expect(await prisma.chapter.findUnique({ where: { id: f.chapter.id } })).toMatchObject({ publishedContent: 'Public body', revision: 5 })
    } finally {
      release()
      await Promise.allSettled([importing, ...(creation ? [creation] : [])])
      await clean(f)
    }
  })

  it('serializes concurrent structure creates and retains consecutive unique positions', async () => {
    const f = await fixture()
    try {
      await Promise.all(['Second', 'Third'].map(title => createVolumeData(f.user.id, f.novel.id, { title })))
      expect(await getStructureReportData(f.user.id, f.novel.id)).toMatchObject({ valid: true, volumeCount: 3, chapterCount: 1 })
      expect((await prisma.volume.findMany({ where: { novelId: f.novel.id }, orderBy: { orderIndex: 'asc' } })).map(v => v.orderIndex)).toEqual([1, 2, 3])
    } finally { await clean(f) }
  })

  it('fences old target-less Agent create across import AND restore ABA while a fresh run can write', async () => {
    const f = await fixture()
    try {
      const context = { userId: f.user.id, novelId: f.novel.id, runId: f.run.id, sessionId: f.session.id, chapterId: null,
        callId: randomUUID(), mode: 'build' as const, creativeFreedom: 'balanced' as const, qualityMode: 'premium' as const,
        signal: new AbortController().signal, emit: () => {} }
      for (const manuscriptRevision of [1, 2]) {
        await prisma.$transaction(async tx => {
          await lockNovelActiveScope(tx, f.novel.id)
          await tx.novel.update({ where: { id: f.novel.id }, data: { manuscriptRevision } })
        })
        await expect(chapterCreateTool.execute(context, { title: 'Unauthorized next' })).rejects.toMatchObject({ code: 'IMPORT_SCOPE_CHANGED' })
        await expect(continueLoopRun(f.user.id, f.run.id)).rejects.toMatchObject({ code: 'IMPORT_SCOPE_CHANGED' })
        expect(await prisma.chapter.count({ where: { novelId: f.novel.id } })).toBe(1)
      }
      const fresh = await prisma.agentRun.create({ data: { userId: f.user.id, novelId: f.novel.id, sessionId: f.session.id,
        mode: 'act', action: 'planChapter', agentType: 'storyPlanner', status: 'paused', manuscriptRevision: 2 } })
      await prisma.$transaction(tx => assertAgentManuscriptCurrent(tx, { userId: f.user.id, novelId: f.novel.id, runId: fresh.id }))
      const result = await chapterCreateTool.execute({ ...context, runId: fresh.id }, { title: 'Authorized next' })
      expect(result.outcome).toBeUndefined()
      expect(await prisma.chapter.count({ where: activeChapterScope(f.novel.id) })).toBe(2)
    } finally { await clean(f) }
  })

  it('rejects archived-parent writes, branches and old background memory at unchanged chapter revision; preserves public reading', async () => {
    const f = await fixture()
    try {
      const branch = await prisma.storyBranch.create({ data: { userId: f.user.id, novelId: f.novel.id, chapterId: f.chapter.id,
        name: 'Old branch', baseRevision: f.chapter.revision, baseContent: f.chapter.content, headContent: 'Do not apply' } })
      const job = await prisma.memoryExtractionJob.create({ data: { novelId: f.novel.id, chapterId: f.chapter.id,
        chapterRevision: f.chapter.revision, idempotencyKey: randomUUID(), diff: { before: '', after: f.chapter.content } } })
      await prisma.$transaction(async tx => {
        await lockNovelActiveScope(tx, f.novel.id)
        await tx.volume.update({ where: { id: f.volume.id }, data: { archivedAt: new Date() } })
      })
      expect(await updateChapterData(f.user.id, f.novel.id, f.chapter.id, { content: 'Do not apply', expectedRevision: 4 })).toBeNull()
      await expect(mergeStoryBranch(f.user.id, branch.id)).rejects.toMatchObject({ code: 'CHAPTER_NOT_FOUND' })
      await expect(prisma.$transaction(tx => applyMemoryExtractionJob(tx, job.id))).resolves.toEqual({ status: 'stale', memoryIds: [] })
      await expect(saveStoryMemory({ userId: f.user.id, novelId: f.novel.id, sourceChapterId: f.chapter.id,
        memoryType: 'chapterSummary', title: 'Old derived memory', content: 'Do not project',
        layer: 'L2', importance: 60, confidence: 1, status: 'inferred',
        evidence: { sourceType: 'chapter', sourceId: f.chapter.id, revision: 4, confidence: 1 } })).rejects.toMatchObject({ code: 'MEMORY_SOURCE_REQUIRED' })
      expect(await prisma.chapter.findUnique({ where: { id: f.chapter.id } })).toEqual(f.chapter)
      const reader = await getReaderPayloadData(f.novel.id, f.chapter.id, null)
      expect(reader?.currentChapter).toMatchObject({ id: f.chapter.id, title: 'Public title', content: 'Public body', revision: 2 })
      expect(reader?.volumes[0].id).toBe(f.volume.id)
      expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.novel.id } })).toBe(0)
    } finally { await clean(f) }
  })
})
