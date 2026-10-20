import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { moveChapterData, normalizeNovelStructure, placeCreatedChapter } from '../../api/lib/data/volume.js'
import { verifyTestDatabase } from '../support/database-preflight.js'
import { isTestDatabaseRequired } from '../support/database-availability.js'

const available = await verifyTestDatabase(isTestDatabaseRequired())
afterAll(() => prisma.$disconnect())

async function withLayout(work: (tx: Prisma.TransactionClient, userId: string, novelId: string, volumes: string[]) => Promise<void>) {
  const rollback = new Error('rollback isolated chapter layout fixture')
  try {
    await prisma.$transaction(async tx => {
      const suffix = randomUUID()
      const user = await tx.user.create({ data: { nickname: `layout-${suffix}`, passwordHash: 'test-only' } })
      const novel = await tx.novel.create({ data: { authorId: user.id, title: 'Synthetic layout', slug: suffix, summary: '' } })
      const volumes: string[] = []
      for (const orderIndex of [1, 2]) {
        const volume = await tx.volume.create({ data: { novelId: novel.id, title: `Volume ${orderIndex}`, orderIndex } })
        volumes.push(volume.id)
        for (const position of [1, 2, 3]) await tx.chapter.create({ data: {
          novelId: novel.id, authorId: user.id, volumeId: volume.id, title: `Chapter ${orderIndex}-${position}`, content: 'Synthetic body',
          orderIndex: (orderIndex - 1) * 3 + position, orderInVolume: position, revision: 7,
          updatedAt: new Date('2026-01-01T00:00:00Z'),
        } })
      }
      await work(tx, user.id, novel.id, volumes)
      throw rollback
    }, { timeout: 20_000 })
  } catch (error) {
    if (error !== rollback) throw error
  }
}

describe.skipIf(!available)('chapter layout preserves rows outside actual structure changes', () => {
  it('normalization and second-volume append preserve complete existing chapter rows', () => withLayout(async (tx, userId, novelId, volumes) => {
    const before = await tx.chapter.findMany({ where: { novelId }, orderBy: { orderIndex: 'asc' } })
    await normalizeNovelStructure(tx, novelId)
    expect(await tx.chapter.findMany({ where: { novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
    const created = await tx.chapter.create({ data: { novelId, authorId: userId, volumeId: volumes[1], title: 'Append', content: '', orderIndex: -7, orderInVolume: -4 } })
    await placeCreatedChapter(tx, novelId, created, volumes[1], 3)
    expect(await tx.chapter.findMany({ where: { id: { in: before.map(chapter => chapter.id) } }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
    expect(await tx.chapter.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({ orderIndex: 7, orderInVolume: 4, revision: created.revision + 1 })
  }))

  it('middle insert and cross-volume move release both unique slots and revise only displaced chapters', () => withLayout(async (tx, userId, novelId, volumes) => {
    const before = await tx.chapter.findMany({ where: { novelId }, orderBy: { orderIndex: 'asc' } })
    const created = await tx.chapter.create({ data: { novelId, authorId: userId, volumeId: volumes[1], title: 'Insert', content: '', orderIndex: -7, orderInVolume: -4 } })
    await placeCreatedChapter(tx, novelId, created, volumes[1], 1)
    const inserted = await tx.chapter.findMany({ where: { novelId }, orderBy: { orderIndex: 'asc' } })
    expect(inserted.map(chapter => chapter.id)).toEqual([...before.slice(0, 4).map(chapter => chapter.id), created.id, ...before.slice(4).map(chapter => chapter.id)])
    expect(inserted.slice(0, 4)).toEqual(before.slice(0, 4))
    for (const chapter of before.slice(4)) expect(inserted.find(row => row.id === chapter.id)).toEqual({
      ...chapter, orderIndex: chapter.orderIndex + 1, orderInVolume: chapter.orderInVolume + 1,
      revision: chapter.revision + 1, updatedAt: expect.any(Date),
    })
    const moving = inserted[6]
    await moveChapterData(userId, novelId, moving.id, { targetVolumeId: volumes[0], position: 2, expectedRevision: moving.revision }, tx)
    const moved = await tx.chapter.findMany({ where: { novelId }, orderBy: { orderIndex: 'asc' } })
    expect(moved.map(chapter => chapter.id)).toEqual([before[0].id, moving.id, ...inserted.slice(1, 6).map(chapter => chapter.id)])
    expect(moved[0]).toEqual(before[0])
    expect(moved.map(chapter => chapter.orderIndex)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(moved.filter(chapter => chapter.volumeId === volumes[0]).map(chapter => chapter.orderInVolume)).toEqual([1, 2, 3, 4])
    expect(moved.filter(chapter => chapter.volumeId === volumes[1]).map(chapter => chapter.orderInVolume)).toEqual([1, 2, 3])
    for (const chapter of moved.slice(1)) {
      const original = inserted.find(row => row.id === chapter.id)!
      expect(chapter).toEqual({ ...original, volumeId: chapter.id === moving.id ? volumes[0] : original.volumeId,
        orderIndex: chapter.orderIndex, orderInVolume: chapter.orderInVolume, revision: original.revision + 1, updatedAt: expect.any(Date) })
    }
    await expect(moveChapterData(userId, novelId, moving.id,
      { targetVolumeId: volumes[1], position: 1, expectedRevision: moving.revision }, tx)).rejects.toMatchObject({ code: 'CHAPTER_REVISION_CONFLICT' })
    expect(await tx.chapter.findMany({ where: { novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(moved)
  }))
})
