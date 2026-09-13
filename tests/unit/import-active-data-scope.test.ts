import type { Prisma } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  chapter: { findFirst: vi.fn(), findUnique: vi.fn(), findFirstOrThrow: vi.fn(), findMany: vi.fn(), count: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(), create: vi.fn() },
  volume: { findFirst: vi.fn(), findFirstOrThrow: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(), create: vi.fn() },
  novel: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  coverAsset: { findMany: vi.fn() },
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
}))
vi.mock('../../api/lib/prisma.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/lib/prisma.js')>(), prisma: db,
}))
vi.mock('../../api/lib/ai-service.js', () => ({ generatePublishAdviceData: vi.fn() }))
vi.mock('../../api/lib/agent/plan-artifacts.js', () => ({ listNovelPlanArtifacts: vi.fn() }))

import { activeChapterScope, activeVolumeWhere, recalculateNovelStats, updateActiveChapter, updateActiveVolume, volumeListItemInclude } from '../../api/lib/data/internal.js'
import { deleteChapterData, getChapterData, getReaderPayloadData, getStudioPayloadData, publicChapterWhere, updateChapterData } from '../../api/lib/data/chapter.js'
import { deleteVolumeData, ensureDefaultVolume, getStructureRevisionHash, mergeChaptersData, normalizeNovelStructure, resolveChapterPlacement, splitChapterData, updateVolumeData } from '../../api/lib/data/volume.js'
import { publishNovelData } from '../../api/lib/data/novel.js'
import { buildNovelExportZip } from '../../api/lib/export-service.js'

const tx = db as unknown as Prisma.TransactionClient
const novel = { id: 'n', authorId: 'u', title: 'Novel', slug: 'novel', summary: '', status: 'published', visibility: 'public', author: { id: 'u', nickname: 'Author', isAuthor: true } }
const volume = { id: 'v', novelId: 'n', title: 'Volume', orderIndex: 1, revision: 2, archivedAt: null }
const chapter = { id: 'c', novelId: 'n', authorId: 'u', volumeId: 'v', title: 'Draft title', content: 'Draft body', summary: null, wordCount: 10, orderIndex: 1, orderInVolume: 1, revision: 4, status: 'published', visibility: 'public', publishedTitle: 'Public title', publishedContent: 'Public body', publishedRevision: 2, publishedWordCount: 11, publishedAt: new Date('2026-01-01'), archivedAt: null }

beforeEach(() => {
  vi.resetAllMocks()
  db.$queryRaw.mockResolvedValue([{ id: 'n' }])
  db.$transaction.mockImplementation(work => typeof work === 'function' ? work(tx) : Promise.all(work))
  db.novel.findUnique.mockResolvedValue(novel)
  db.novel.findFirst.mockResolvedValue(novel)
  db.novel.update.mockResolvedValue(novel)
  db.chapter.findFirst.mockResolvedValue(null)
  db.chapter.findMany.mockResolvedValue([])
  db.chapter.updateMany.mockResolvedValue({ count: 1 })
  db.chapter.deleteMany.mockResolvedValue({ count: 1 })
  db.chapter.count.mockResolvedValue(0)
  db.volume.findFirst.mockResolvedValue(volume)
  db.volume.findMany.mockResolvedValue([volume])
  db.volume.updateMany.mockResolvedValue({ count: 1 })
  db.volume.deleteMany.mockResolvedValue({ count: 1 })
  db.coverAsset.findMany.mockResolvedValue([])
})

describe('import archival: bounded creative data scope', () => {
  it('waits for the shared lock before even reading an empty-book default volume', async () => {
    let release!: (rows: Array<{ id: string }>) => void
    db.$queryRaw.mockReturnValue(new Promise(resolve => { release = resolve }))
    const pending = ensureDefaultVolume(tx, 'n')
    await Promise.resolve()
    expect(db.volume.findFirst).not.toHaveBeenCalled()
    expect(db.volume.create).not.toHaveBeenCalled()
    release([{ id: 'n' }])
    await pending
    expect(db.volume.findFirst).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['archived draft', { archivedAt: new Date(), status: 'draft' }, {}],
    ['archived private', { archivedAt: new Date(), visibility: 'private' }, {}],
    ['scheduled publication', { publishedAt: new Date('2099-01-01') }, {}],
    ['foreign novel', { novelId: 'other' }, {}],
    ['private novel', {}, { visibility: 'private' }],
    ['unpublished novel', {}, { status: 'draft' }],
  ])('public reader rejects %s before returning any body/navigation', async (_name, chapterPatch, novelPatch) => {
    db.novel.findUnique.mockResolvedValue({ ...novel, ...novelPatch })
    db.chapter.findUnique.mockResolvedValue({ ...chapter, ...chapterPatch })
    expect(await getReaderPayloadData('n', 'c', null)).toBeNull()
    expect(db.chapter.findMany).not.toHaveBeenCalled()
    expect(db.volume.findMany).not.toHaveBeenCalled()
  })

  it('uses identical published/visibility/schedule filters for navigation and volume counts', async () => {
    db.chapter.findUnique.mockResolvedValue(chapter)
    db.chapter.findMany.mockResolvedValue([chapter])
    db.volume.findMany.mockResolvedValue([{ ...volume, chapters: [chapter] }, { ...volume, id: 'private-volume', chapters: [] }])
    const result = await getReaderPayloadData('n', 'c', null)
    const where = db.chapter.findMany.mock.calls[0][0].where
    expect(where).toMatchObject({ novelId: 'n', status: 'published', visibility: 'public' })
    expect(where.OR).toEqual([{ publishedAt: null }, { publishedAt: { lte: expect.any(Date) } }])
    expect(db.volume.findMany.mock.calls[0][0].include.chapters.where).toEqual(where)
    expect(result?.volumes.map(volume => volume.id)).toEqual(['v'])
    expect(db.chapter.findMany.mock.calls[0][0].orderBy).toEqual([{ orderIndex: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }])
  })
  it('separates creative predicates and nested counts from public publication scope', () => {
    expect(activeChapterScope('n')).toEqual({ novelId: 'n', archivedAt: null, volume: { novelId: 'n', archivedAt: null } })
    expect(activeVolumeWhere).toEqual({ archivedAt: null })
    expect(volumeListItemInclude._count.select.chapters.where).toEqual(activeChapterScope())
    expect(volumeListItemInclude.chapters.where).toEqual(activeChapterScope())
    expect(publicChapterWhere).toEqual({ status: 'published', visibility: 'public' })
  })

  it('guards actual mutation predicates and rejects zero affected rows', async () => {
    db.chapter.updateMany.mockResolvedValue({ count: 0 })
    db.volume.updateMany.mockResolvedValue({ count: 0 })
    await expect(updateActiveChapter(tx, { id: 'c', novelId: 'n', revision: 4 }, { content: 'new' })).rejects.toMatchObject({ status: 409 })
    expect(db.chapter.updateMany).toHaveBeenCalledWith({ where: { AND: [{ id: 'c', novelId: 'n', revision: 4 }, activeChapterScope('n')] }, data: { content: 'new' } })
    await expect(updateActiveVolume(tx, { id: 'v', revision: 2 }, { title: 'new' })).rejects.toMatchObject({ status: 409 })
    expect(db.volume.updateMany).toHaveBeenCalledWith({ where: { AND: [{ id: 'v', revision: 2 }, activeVolumeWhere] }, data: { title: 'new' } })
  })

  it('scopes studio lists and the second draft-body lookup', async () => {
    db.chapter.findMany.mockResolvedValue([{ ...chapter, status: 'draft' }])
    const result = await getStudioPayloadData('u', 'n')
    expect(db.chapter.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: activeChapterScope('n') }))
    expect(db.volume.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { novelId: 'n', archivedAt: null } }))
    expect(db.chapter.findFirst).toHaveBeenCalledWith({ where: { id: 'c', ...activeChapterScope('n') } })
    // The draft was archived between list and body fetch; never hydrate its body.
    expect(result?.draftChapter).toBeNull()
  })

  it('rejects inactive author IDs without mutations', async () => {
    expect(await getChapterData('u', 'n', 'old')).toBeNull()
    expect(await updateChapterData('u', 'n', 'old', { content: 'new' })).toBeNull()
    expect(await deleteChapterData('u', 'n', 'old')).toBe(false)
    for (const [query] of db.chapter.findFirst.mock.calls) expect(query.where).toEqual({ id: 'old', ...activeChapterScope('n') })
    expect(db.chapter.updateMany).not.toHaveBeenCalled()
    expect(db.chapter.deleteMany).not.toHaveBeenCalled()
  })

  it.each([undefined, 4])('fences a save archived after observation (expectedRevision=%s)', async expectedRevision => {
    db.chapter.findFirst.mockResolvedValue(chapter)
    db.chapter.updateMany.mockResolvedValue({ count: 0 })
    await expect(updateChapterData('u', 'n', 'c', { content: 'new', expectedRevision })).rejects.toMatchObject({ code: 'CHAPTER_REVISION_CONFLICT' })
    expect(db.chapter.updateMany.mock.calls[0][0].where).toEqual({ AND: [{ id: 'c', novelId: 'n', revision: 4 }, activeChapterScope('n')] })
    expect(db.novel.update).not.toHaveBeenCalled()
  })

  it.each([undefined, 4])('fences deletion archived after observation (expectedRevision=%s)', async expectedRevision => {
    db.chapter.findFirst.mockResolvedValue(chapter)
    db.chapter.deleteMany.mockResolvedValue({ count: 0 })
    await expect(deleteChapterData('u', 'n', 'c', expectedRevision)).rejects.toMatchObject({ status: 409 })
    expect(db.chapter.deleteMany).toHaveBeenCalledWith({ where: { id: 'c', revision: 4, ...activeChapterScope('n') } })
    expect(db.volume.updateMany).not.toHaveBeenCalled()
  })

  it('ordinary save still leaves published snapshots untouched', async () => {
    db.chapter.findFirst.mockResolvedValue(chapter)
    await updateChapterData('u', 'n', 'c', { content: 'new', expectedRevision: 4 })
    const data = db.chapter.updateMany.mock.calls[0][0].data
    expect(data.content).toBe('new')
    for (const key of ['publishedTitle', 'publishedSummary', 'publishedContent', 'publishedRevision', 'publishedWordCount', 'publishedAt']) expect(data[key]).toBeUndefined()
  })

  it('recalculates creative counts independently of retained publication date', async () => {
    db.chapter.findMany.mockResolvedValue([{ ...chapter, title: 'Replacement', status: 'draft', wordCount: 3 }])
    db.chapter.findFirst.mockResolvedValue({ publishedAt: chapter.publishedAt })
    await recalculateNovelStats(tx, 'n')
    expect(db.chapter.findMany).toHaveBeenCalledWith({ where: activeChapterScope('n'), orderBy: { orderIndex: 'asc' } })
    expect(db.chapter.findFirst).toHaveBeenCalledWith({ where: { novelId: 'n', status: 'published', publishedAt: { not: null } }, orderBy: { orderIndex: 'desc' }, select: { publishedAt: true } })
    expect(db.novel.update).toHaveBeenCalledWith({ where: { id: 'n' }, data: { chapterCount: 1, wordCount: 3, lastChapterTitle: 'Replacement', lastPublishedAt: chapter.publishedAt } })
  })

  it('keeps archived published reader body, IDs, navigation and volume metadata', async () => {
    const archived = { ...chapter, archivedAt: new Date() }
    db.chapter.findUnique.mockResolvedValue(archived)
    db.chapter.findMany.mockResolvedValue([archived])
    db.volume.findMany.mockResolvedValue([{ ...volume, archivedAt: new Date(), chapters: [archived] }])
    const result = await getReaderPayloadData('n', 'c', null)
    expect(result?.currentChapter).toMatchObject({ id: 'c', title: 'Public title', content: 'Public body', revision: 2 })
    expect(result?.volumes[0]).toMatchObject({ id: 'v', title: 'Volume' })
    expect(result?.chapterList[0].id).toBe('c')
    expect(db.chapter.findUnique).toHaveBeenCalledWith({ where: { id: 'c' } })
    expect(db.volume.findMany.mock.calls[0][0].where).toEqual({ novelId: 'n' })
    expect(db.chapter.findMany.mock.calls[0][0].where).not.toHaveProperty('archivedAt')
  })

  it('uses active default/placement/layout/hash and count-checked two-phase ordering', async () => {
    db.chapter.findMany.mockResolvedValue([chapter])
    expect(await ensureDefaultVolume(tx, 'n')).toBe(volume)
    await resolveChapterPlacement(tx, 'n', 'v')
    await normalizeNovelStructure(tx, 'n')
    await getStructureRevisionHash(tx, 'n')
    for (const [query] of db.volume.findFirst.mock.calls) expect(query.where).toMatchObject({ novelId: 'n', archivedAt: null })
    for (const [query] of db.volume.findMany.mock.calls) expect(query.where).toEqual({ novelId: 'n', archivedAt: null })
    for (const [query] of db.chapter.findMany.mock.calls) expect(query.where).toEqual(activeChapterScope('n'))
    expect(db.chapter.updateMany).toHaveBeenCalledTimes(2)
    expect(db.chapter.updateMany.mock.calls[0][0].data).toEqual({ orderIndex: -1, orderInVolume: -1 })
    expect(db.chapter.updateMany.mock.calls[1][0].data).toMatchObject({ orderIndex: 1, orderInVolume: 1, volumeId: 'v' })
    for (const [query] of db.chapter.updateMany.mock.calls) expect(query.where.AND[1]).toEqual(activeChapterScope())
  })

  it('fails ordering immediately if an observed row becomes archived', async () => {
    db.volume.updateMany.mockResolvedValue({ count: 0 })
    await expect(normalizeNovelStructure(tx, 'n')).rejects.toMatchObject({ code: 'VOLUME_REVISION_CONFLICT' })
    expect(db.chapter.updateMany).not.toHaveBeenCalled()
  })

  it('rejects archived target volumes, split sources and merge sources', async () => {
    db.volume.findFirst.mockResolvedValue(null)
    db.volume.create.mockResolvedValue(volume)
    await expect(resolveChapterPlacement(tx, 'n', 'old-volume')).rejects.toMatchObject({ code: 'VOLUME_NOT_FOUND' })
    expect(await updateVolumeData('u', 'n', 'old-volume', { title: 'new' }, tx)).toBeNull()
    expect(await splitChapterData('u', 'n', 'old', { splitOffset: 2, newChapterTitle: 'new' }, tx)).toBeNull()
    expect(await mergeChaptersData('u', 'n', 'c', { sourceChapterId: 'old', separator: '\n' }, tx)).toBeNull()
    expect(db.chapter.create).not.toHaveBeenCalled()
  })

  it('guards volume update/delete counts and retains historical children', async () => {
    db.volume.updateMany.mockResolvedValue({ count: 0 })
    await expect(updateVolumeData('u', 'n', 'v', { title: 'new' }, tx)).rejects.toMatchObject({ status: 409 })
    db.volume.findMany.mockResolvedValue([volume, { ...volume, id: 'v2' }])
    db.chapter.count.mockResolvedValue(1)
    await expect(deleteVolumeData('u', 'n', 'v', tx)).rejects.toMatchObject({ code: 'VOLUME_NOT_EMPTY' })
    expect(db.chapter.count).toHaveBeenCalledWith({ where: { volumeId: 'v' } })
    expect(db.volume.deleteMany).not.toHaveBeenCalled()
    db.chapter.count.mockResolvedValue(0)
    db.volume.deleteMany.mockResolvedValue({ count: 0 })
    await expect(deleteVolumeData('u', 'n', 'v', tx)).rejects.toMatchObject({ status: 409 })
    expect(db.volume.deleteMany).toHaveBeenCalledWith({ where: { id: 'v', novelId: 'n', revision: 2, archivedAt: null } })
  })

  it('rejects mixed active/archived publication selection before any snapshot write', async () => {
    db.chapter.findMany.mockResolvedValue([chapter])
    await expect(publishNovelData('u', 'n', ['c', 'old'])).rejects.toMatchObject({ status: 409 })
    expect(db.chapter.findMany.mock.calls[0][0].where).toEqual({ ...activeChapterScope('n'), id: { in: ['c', 'old'] } })
    expect(db.chapter.updateMany).not.toHaveBeenCalled()
    expect(db.novel.update).not.toHaveBeenCalled()
  })

  it('rejects partially stale export selections instead of silently dropping old IDs', async () => {
    db.chapter.findMany.mockResolvedValue([chapter])
    await expect(buildNovelExportZip('u', 'n', { includePlans: false, includeInfo: false, chapterIds: ['c', 'old'] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(db.chapter.findMany.mock.calls[0][0].where).toEqual(activeChapterScope('n'))
  })
})
