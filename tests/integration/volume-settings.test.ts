import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, describe, expect, it } from 'vitest'
import app from '../../api/app.js'
import { buildSessionTokens } from '../../api/lib/auth-session.js'
import { prisma } from '../../api/lib/prisma.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
const fixtureNovelIds: string[] = []
const fixtureUserIds: string[] = []

type Fixture = Awaited<ReturnType<typeof createFixture>>

function cookie(userId: string) {
  return `chevoink_session=${buildSessionTokens(userId, 0).accessToken}`
}

async function createFixture(options: { volumeCount?: number; chaptersPerVolume?: number; archivedChapterInVolume?: number } = {}) {
  const suffix = randomUUID()
  const userId = randomUUID()
  const novelId = randomUUID()
  const volumeCount = options.volumeCount ?? 3
  const chaptersPerVolume = options.chaptersPerVolume ?? 1
  const archivedChapterInVolume = options.archivedChapterInVolume

  const result = await prisma.$transaction(async tx => {
    const user = await tx.user.create({
      data: { id: userId, nickname: `卷设置夹具-${suffix}`, passwordHash: 'fixture-only', isAuthor: true },
    })
    const novel = await tx.novel.create({
      data: {
        id: novelId,
        authorId: user.id,
        title: `卷设置作品-${suffix}`,
        slug: `volume-settings-${suffix}`,
        summary: 'Synthetic volume settings fixture',
        visibility: 'private',
      },
    })

    const volumes = []
    const chapters = []
    let globalOrder = 1
    for (let volumeIndex = 0; volumeIndex < volumeCount; volumeIndex += 1) {
      const volume = await tx.volume.create({
        data: {
          id: randomUUID(),
          novelId: novel.id,
          title: `卷${volumeIndex + 1}`,
          orderIndex: volumeIndex + 1,
        },
      })
      volumes.push(volume)
      for (let chapterIndex = 0; chapterIndex < chaptersPerVolume; chapterIndex += 1) {
        const chapter = await tx.chapter.create({
          data: {
            id: randomUUID(),
            novelId: novel.id,
            authorId: user.id,
            volumeId: volume.id,
            title: `卷${volumeIndex + 1}章${chapterIndex + 1}`,
            content: `synthetic-content-${volumeIndex + 1}-${chapterIndex + 1}`,
            wordCount: 24,
            orderIndex: globalOrder,
            orderInVolume: chapterIndex + 1,
          },
        })
        chapters.push(chapter)
        globalOrder += 1
      }
      if (archivedChapterInVolume === volumeIndex) {
        chapters.push(await tx.chapter.create({
          data: {
            id: randomUUID(),
            novelId: novel.id,
            authorId: user.id,
            volumeId: volume.id,
            title: `卷${volumeIndex + 1}历史章`,
            content: 'synthetic-archived-history',
            wordCount: 22,
            orderIndex: 9000 + volumeIndex,
            orderInVolume: 9000,
            archivedAt: new Date('2026-01-01T00:00:00.000Z'),
            archivedByImportId: `fixture-import-${suffix}`,
          },
        }))
      }
    }
    return { userId: user.id, novelId: novel.id, volumes, chapters }
  })

  fixtureNovelIds.push(result.novelId)
  fixtureUserIds.push(result.userId)
  return result
}

async function createSecondUser() {
  const user = await prisma.user.create({
    data: { id: randomUUID(), nickname: `卷设置跨用户-${randomUUID()}`, passwordHash: 'fixture-only', isAuthor: true },
  })
  fixtureUserIds.push(user.id)
  return user.id
}

function deleteBody(fixture: Fixture, volumeIndex: number, targetIndex: number, chapters = fixture.chapters) {
  const volume = fixture.volumes[volumeIndex]
  const target = fixture.volumes[targetIndex]
  return {
    expectedRevision: volume.revision,
    moveChapters: true as const,
    targetVolumeId: target.id,
    expectedChapterRevisions: chapters
      .filter(chapter => chapter.volumeId === volume.id && chapter.archivedAt === null)
      .map(chapter => ({ id: chapter.id, revision: chapter.revision })),
  }
}

async function activeLayout(novelId: string) {
  const [volumes, chapters] = await Promise.all([
    prisma.volume.findMany({ where: { novelId, archivedAt: null }, orderBy: { orderIndex: 'asc' } }),
    prisma.chapter.findMany({ where: { novelId, archivedAt: null }, orderBy: { orderIndex: 'asc' } }),
  ])
  return { volumes, chapters }
}

afterAll(async () => {
  try {
    if (dbAvailable) {
      await prisma.chapter.deleteMany({ where: { novelId: { in: fixtureNovelIds } } })
      await prisma.volume.deleteMany({ where: { novelId: { in: fixtureNovelIds } } })
      await prisma.novel.deleteMany({ where: { id: { in: fixtureNovelIds } } })
      await prisma.user.deleteMany({ where: { id: { in: fixtureUserIds } } })
    }
  } finally {
    await prisma.$disconnect()
  }
})

describe.skipIf(!dbAvailable)('卷设置删除 API：真实隔离 PostgreSQL HTTP 回归', () => {
  it('删除中卷时把章节追加到前卷，压缩卷章序并保留正文身份', async () => {
    const fixture = await createFixture({ chaptersPerVolume: 2 })
    const before = new Map(fixture.chapters.map(chapter => [chapter.id, { content: chapter.content, volumeId: chapter.volumeId }]))
    const response = await request(app)
      .delete(`/api/novels/${fixture.novelId}/volumes/${fixture.volumes[1].id}`)
      .set('Cookie', cookie(fixture.userId))
      .send(deleteBody(fixture, 1, 0))

    expect(response.status, JSON.stringify(response.body)).toBe(200)
    expect(response.body.data).toEqual({ deleted: true })
    const layout = await activeLayout(fixture.novelId)
    expect(layout.volumes.map(volume => [volume.id, volume.orderIndex])).toEqual([
      [fixture.volumes[0].id, 1],
      [fixture.volumes[2].id, 2],
    ])
    expect(layout.chapters.map(chapter => chapter.id)).toEqual([
      fixture.chapters[0].id, fixture.chapters[1].id,
      fixture.chapters[2].id, fixture.chapters[3].id,
      fixture.chapters[4].id, fixture.chapters[5].id,
    ])
    expect(layout.chapters.map(chapter => [chapter.volumeId, chapter.orderInVolume, chapter.orderIndex])).toEqual([
      [fixture.volumes[0].id, 1, 1], [fixture.volumes[0].id, 2, 2],
      [fixture.volumes[0].id, 3, 3], [fixture.volumes[0].id, 4, 4],
      [fixture.volumes[2].id, 1, 5], [fixture.volumes[2].id, 2, 6],
    ])
    for (const chapter of layout.chapters) expect(before.get(chapter.id)?.content).toBe(chapter.content)
    expect(await prisma.volume.findUnique({ where: { id: fixture.volumes[1].id } })).toBeNull()
  })

  it('删除首卷时把章节前插到后卷，且活动卷列表不暴露被归档卷', async () => {
    const fixture = await createFixture({ chaptersPerVolume: 1 })
    const response = await request(app)
      .delete(`/api/novels/${fixture.novelId}/volumes/${fixture.volumes[0].id}`)
      .set('Cookie', cookie(fixture.userId))
      .send(deleteBody(fixture, 0, 1))

    expect(response.status, JSON.stringify(response.body)).toBe(200)
    const listed = await request(app).get(`/api/novels/${fixture.novelId}/volumes`).set('Cookie', cookie(fixture.userId))
    expect(listed.status).toBe(200)
    expect(listed.body.data.items.map((item: { id: string; orderIndex: number }) => [item.id, item.orderIndex])).toEqual([
      [fixture.volumes[1].id, 1], [fixture.volumes[2].id, 2],
    ])
    const layout = await activeLayout(fixture.novelId)
    expect(layout.chapters.map(chapter => chapter.id)).toEqual(fixture.chapters.map(chapter => chapter.id))
    expect(layout.chapters.map(chapter => [chapter.volumeId, chapter.orderInVolume])).toEqual([
      [fixture.volumes[1].id, 1], [fixture.volumes[1].id, 2], [fixture.volumes[2].id, 1],
    ])
    expect(await prisma.volume.findUnique({ where: { id: fixture.volumes[0].id } })).toBeNull()
  })

  it('删除末卷时把章节追加到前卷并压缩末尾卷序', async () => {
    const fixture = await createFixture({ chaptersPerVolume: 1 })
    const response = await request(app)
      .delete(`/api/novels/${fixture.novelId}/volumes/${fixture.volumes[2].id}`)
      .set('Cookie', cookie(fixture.userId))
      .send(deleteBody(fixture, 2, 1))

    expect(response.status, JSON.stringify(response.body)).toBe(200)
    expect(await prisma.volume.findUnique({ where: { id: fixture.volumes[2].id } })).toBeNull()
    const layout = await activeLayout(fixture.novelId)
    expect(layout.volumes.map(volume => [volume.id, volume.orderIndex])).toEqual([
      [fixture.volumes[0].id, 1], [fixture.volumes[1].id, 2],
    ])
    expect(layout.chapters.map(chapter => [chapter.id, chapter.volumeId, chapter.orderInVolume])).toEqual([
      [fixture.chapters[0].id, fixture.volumes[0].id, 1],
      [fixture.chapters[1].id, fixture.volumes[1].id, 1],
      [fixture.chapters[2].id, fixture.volumes[1].id, 2],
    ])
  })

  it('兼容旧无 body 调用删除空卷，但禁止删除最后一卷', async () => {
    const empty = await createFixture({ chaptersPerVolume: 0 })
    const deleted = await request(app)
      .delete(`/api/novels/${empty.novelId}/volumes/${empty.volumes[1].id}`)
      .set('Cookie', cookie(empty.userId))
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200)
    expect(await prisma.volume.findUnique({ where: { id: empty.volumes[1].id } })).toBeNull()
    expect((await activeLayout(empty.novelId)).volumes.map(volume => [volume.id, volume.orderIndex])).toEqual([
      [empty.volumes[0].id, 1], [empty.volumes[2].id, 2],
    ])

    const last = await createFixture({ volumeCount: 1, chaptersPerVolume: 0 })
    const blocked = await request(app)
      .delete(`/api/novels/${last.novelId}/volumes/${last.volumes[0].id}`)
      .set('Cookie', cookie(last.userId))
    expect(blocked.status).toBe(400)
    expect(blocked.body.error.code).toBe('LAST_VOLUME_REQUIRED')
    expect(await prisma.volume.findUnique({ where: { id: last.volumes[0].id } })).not.toBeNull()
  })

  it('拒绝相邻目标变化、过期卷或章节 revision，以及确认后新增章节', async () => {
    const targetChanged = await createFixture({ chaptersPerVolume: 1 })
    const wrongTarget = await request(app)
      .delete(`/api/novels/${targetChanged.novelId}/volumes/${targetChanged.volumes[1].id}`)
      .set('Cookie', cookie(targetChanged.userId))
      .send(deleteBody(targetChanged, 1, 2))
    expect(wrongTarget.status).toBe(409)
    expect(wrongTarget.body.error.code).toBe('VOLUME_REVISION_CONFLICT')

    const staleVolume = await createFixture({ chaptersPerVolume: 1 })
    await prisma.volume.update({ where: { id: staleVolume.volumes[1].id }, data: { title: '目标卷已改', revision: { increment: 1 } } })
    const staleVolumeResponse = await request(app)
      .delete(`/api/novels/${staleVolume.novelId}/volumes/${staleVolume.volumes[1].id}`)
      .set('Cookie', cookie(staleVolume.userId))
      .send(deleteBody(staleVolume, 1, 0))
    expect(staleVolumeResponse.status).toBe(409)
    expect(staleVolumeResponse.body.error.code).toBe('VOLUME_REVISION_CONFLICT')

    const staleChapter = await createFixture({ chaptersPerVolume: 1 })
    await prisma.chapter.update({ where: { id: staleChapter.chapters[1].id }, data: { revision: { increment: 1 } } })
    const staleChapterResponse = await request(app)
      .delete(`/api/novels/${staleChapter.novelId}/volumes/${staleChapter.volumes[1].id}`)
      .set('Cookie', cookie(staleChapter.userId))
      .send(deleteBody(staleChapter, 1, 0))
    expect(staleChapterResponse.status).toBe(409)
    expect(staleChapterResponse.body.error.code).toBe('VOLUME_REVISION_CONFLICT')

    const newChapter = await createFixture({ chaptersPerVolume: 1 })
    const target = newChapter.volumes[1]
    await prisma.chapter.create({
      data: {
        id: randomUUID(), novelId: newChapter.novelId, authorId: newChapter.userId, volumeId: target.id,
        title: '确认后新增章', content: 'synthetic-new-chapter', wordCount: 20, orderIndex: 99, orderInVolume: 2,
      },
    })
    const newChapterResponse = await request(app)
      .delete(`/api/novels/${newChapter.novelId}/volumes/${target.id}`)
      .set('Cookie', cookie(newChapter.userId))
      .send(deleteBody(newChapter, 1, 0))
    expect(newChapterResponse.status).toBe(409)
    expect(newChapterResponse.body.error.code).toBe('VOLUME_REVISION_CONFLICT')
    expect((await activeLayout(newChapter.novelId)).volumes.map(volume => volume.id)).toEqual(newChapter.volumes.map(volume => volume.id))
  })

  it('同一确认请求并发删除时至多一次成功，章节不会重复或丢失', async () => {
    const fixture = await createFixture({ chaptersPerVolume: 1 })
    const url = `/api/novels/${fixture.novelId}/volumes/${fixture.volumes[1].id}`
    const body = deleteBody(fixture, 1, 0)
    const responses = await Promise.all([
      request(app).delete(url).set('Cookie', cookie(fixture.userId)).send(body),
      request(app).delete(url).set('Cookie', cookie(fixture.userId)).send(body),
    ])
    expect(responses.filter(response => response.status === 200)).toHaveLength(1)
    expect(responses.map(response => response.status).sort()).toEqual([200, 404])
    const layout = await activeLayout(fixture.novelId)
    expect(new Set(layout.chapters.map(chapter => chapter.id)).size).toBe(fixture.chapters.length)
    expect(layout.chapters.map(chapter => chapter.id).sort()).toEqual(fixture.chapters.map(chapter => chapter.id).sort())
  })

  it('拒绝跨用户作品删除，并保留归档历史 chapter FK 同时隐藏归档卷', async () => {
    const fixture = await createFixture({ chaptersPerVolume: 1, archivedChapterInVolume: 1 })
    const otherUserId = await createSecondUser()
    const forbidden = await request(app)
      .delete(`/api/novels/${fixture.novelId}/volumes/${fixture.volumes[1].id}`)
      .set('Cookie', cookie(otherUserId))
      .send(deleteBody(fixture, 1, 0))
    expect(forbidden.status).toBe(403)
    expect(forbidden.body.error.code).toBe('NOVEL_FORBIDDEN')

    const allowed = await request(app)
      .delete(`/api/novels/${fixture.novelId}/volumes/${fixture.volumes[1].id}`)
      .set('Cookie', cookie(fixture.userId))
      .send(deleteBody(fixture, 1, 0))
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200)
    const history = fixture.chapters.find(chapter => chapter.archivedAt !== null)
    expect(history).toBeDefined()
    const retainedHistory = await prisma.chapter.findUnique({ where: { id: history!.id } })
    expect(retainedHistory).toMatchObject({ volumeId: fixture.volumes[1].id })
    expect(retainedHistory?.archivedAt).not.toBeNull()
    expect((await prisma.volume.findUnique({ where: { id: fixture.volumes[1].id } }))?.archivedAt).not.toBeNull()
    expect((await activeLayout(fixture.novelId)).volumes.map(volume => volume.id)).toEqual([fixture.volumes[0].id, fixture.volumes[2].id])
  })
})
