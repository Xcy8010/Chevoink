import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { activeChapterScope, recalculateNovelStats, updateActiveChapter, updateActiveVolume } from '../../api/lib/data/internal.js'
import { getStructureReportData, getStructureRevisionHash, listVolumesData, mergeChaptersData, moveChapterData, moveVolumeData, normalizeNovelStructure, splitChapterData, updateVolumeData } from '../../api/lib/data/volume.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
afterAll(async () => { await prisma.$disconnect() })

// Requires the backend-owned archived columns and all three partial indexes.
// A reachable DB with an unapplied migration must fail, not silently skip.
describe.skipIf(!dbAvailable)('import archive active structure (isolated DB)', () => {
  it('preserves overlapping historical rows through normalize, split, merge and moves', async () => {
    const rollback = new Error('rollback archive structure fixture')
    try {
      await prisma.$transaction(async tx => {
        const suffix = randomUUID()
        const user = await tx.user.create({ data: { nickname: `Archive ${suffix}`, passwordHash: 'test-only-unused', isAuthor: true } })
        const novel = await tx.novel.create({ data: { authorId: user.id, title: 'Archive fixture', slug: `archive-${suffix}`, summary: 'Test', status: 'published' } })
        const archivedAt = new Date('2026-08-01')
        const publishedAt = new Date('2026-07-01')
        const oldVolume = await tx.volume.create({ data: { novelId: novel.id, title: 'Retained volume', orderIndex: 1, archivedAt, archivedByImportId: `fixture-${suffix}` } })
        const oldChapter = await tx.chapter.create({ data: {
          novelId: novel.id, authorId: user.id, volumeId: oldVolume.id, title: 'Old working title', content: 'Old working body',
          orderIndex: 1, orderInVolume: 1, wordCount: 16, revision: 7, archivedAt, archivedByImportId: `fixture-${suffix}`,
          status: 'published', visibility: 'public', publishedTitle: 'Retained public title', publishedContent: 'Retained public body',
          publishedRevision: 5, publishedWordCount: 20, publishedAt,
        } })
        const activeVolume = await tx.volume.create({ data: { novelId: novel.id, title: 'Current', orderIndex: 1 } })
        const nextVolume = await tx.volume.create({ data: { novelId: novel.id, title: 'Next', orderIndex: 2 } })
        // Exercise per-volume partial uniqueness too, not only distinct historical volumes.
        const archivedSibling = await tx.chapter.create({ data: {
          novelId: novel.id, authorId: user.id, volumeId: activeVolume.id, title: 'Retained draft', content: 'History',
          wordCount: 7, orderIndex: 1, orderInVolume: 1, archivedAt, archivedByImportId: `fixture-${suffix}`,
        } })
        const current = await tx.chapter.create({ data: { novelId: novel.id, authorId: user.id, volumeId: activeVolume.id, title: 'Current chapter', content: 'ABCD', wordCount: 4, orderIndex: 1, orderInVolume: 1 } })

        expect((await tx.chapter.findMany({ where: activeChapterScope(novel.id) })).map(c => c.id)).toEqual([current.id])
        expect(await listVolumesData(user.id, novel.id, tx)).toMatchObject([
          { id: activeVolume.id, chapterCount: 1, wordCount: 4 }, { id: nextVolume.id, chapterCount: 0 },
        ])
        await expect(updateActiveChapter(tx, { id: oldChapter.id, novelId: novel.id, revision: 7 }, { content: 'unsafe' })).rejects.toMatchObject({ status: 409 })
        await expect(updateActiveVolume(tx, { id: oldVolume.id }, { title: 'unsafe' })).rejects.toMatchObject({ status: 409 })
        expect(await updateVolumeData(user.id, novel.id, oldVolume.id, { title: 'unsafe' }, tx)).toBeNull()
        expect(await moveChapterData(user.id, novel.id, oldChapter.id, { targetVolumeId: nextVolume.id, position: 1 }, tx)).toBeNull()
        expect(await moveVolumeData(user.id, novel.id, oldVolume.id, { position: 1 }, tx)).toBeNull()

        await normalizeNovelStructure(tx, novel.id)
        const beforeHash = await getStructureRevisionHash(tx, novel.id)
        const split = await splitChapterData(user.id, novel.id, current.id, { splitOffset: 2, newChapterTitle: 'Second half' }, tx)
        expect(split?.first.content).toBe('AB')
        expect(split?.second.content).toBe('CD')
        expect(await getStructureRevisionHash(tx, novel.id)).not.toBe(beforeHash)
        const merged = await mergeChaptersData(user.id, novel.id, current.id, { sourceChapterId: split!.second.id, separator: '' }, tx)
        expect(merged?.content).toBe('ABCD')
        await moveChapterData(user.id, novel.id, current.id, { targetVolumeId: nextVolume.id, position: 1 }, tx)
        await moveVolumeData(user.id, novel.id, nextVolume.id, { position: 1 }, tx)
        expect(await getStructureReportData(user.id, novel.id, tx)).toMatchObject({ valid: true, volumeCount: 2, chapterCount: 1 })

        await recalculateNovelStats(tx, novel.id)
        expect(await tx.novel.findUnique({ where: { id: novel.id } })).toMatchObject({ chapterCount: 1, wordCount: 4, lastPublishedAt: publishedAt })
        expect(await tx.chapter.findUnique({ where: { id: oldChapter.id } })).toEqual(oldChapter)
        expect(await tx.chapter.findUnique({ where: { id: archivedSibling.id } })).toEqual(archivedSibling)
        expect(await tx.volume.findUnique({ where: { id: oldVolume.id } })).toEqual(oldVolume)
        throw rollback
      }, { timeout: 20_000 })
    } catch (error) {
      if (error !== rollback) throw error
    }
  })
})
