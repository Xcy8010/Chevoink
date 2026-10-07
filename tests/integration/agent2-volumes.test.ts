import request from 'supertest'
import { randomInt } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import app from '../../api/app.js'
import { prisma } from '../../api/lib/prisma.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)

afterAll(async () => {
  await prisma.$disconnect().catch(() => {})
})

describe.skipIf(!dbAvailable)('Agent 2.0 P1 卷章结构（需 DB）', () => {
  let cookie = ''
  let novelId = ''
  let firstVolumeId = ''
  let secondVolumeId = ''
  let firstChapterId = ''
  let secondChapterId = ''

  beforeAll(async () => {
    const unique = randomInt(0, 10_000_000).toString().padStart(7, '0')
    const phone = `+861395${unique}`
    const register = await request(app)
      .post('/api/auth/register')
      .send({ phone, nickname: `卷章结构测试${unique}`, password: 'Volume-Test-123!' })
    expect(register.status).toBe(201)
    const cookies = Array.isArray(register.headers['set-cookie'])
      ? register.headers['set-cookie']
      : [register.headers['set-cookie']]
    cookie = cookies.find((item: string) => item?.startsWith('chevoink_session=')) as string

    const novel = await request(app)
      .post('/api/novels')
      .set('Cookie', cookie)
      .send({ title: '卷章结构作品', summary: '验证卷章不变量。', tags: [] })
    novelId = novel.body.data.novel.id as string

    const studio = await request(app).get(`/api/novels/${novelId}/studio`).set('Cookie', cookie)
    expect(studio.status).toBe(200)
    expect(studio.body.data.volumes).toHaveLength(1)
    firstVolumeId = studio.body.data.volumes[0].id as string

    for (const [title, content] of [['第一章 启程', '甲乙丙丁'], ['第二章 归来', '戊己庚辛']] as const) {
      const created = await request(app)
        .post(`/api/novels/${novelId}/chapters`)
        .set('Cookie', cookie)
        .send({ title, content, status: 'draft', visibility: 'private' })
      expect(created.status).toBe(201)
      if (!firstChapterId) firstChapterId = created.body.data.chapter.id as string
      else secondChapterId = created.body.data.chapter.id as string
    }
  })

  it('新作品自动有默认卷，旧创建参数仍兼容并落入该卷', async () => {
    const studio = await request(app).get(`/api/novels/${novelId}/studio`).set('Cookie', cookie)
    expect(studio.body.data.volumes[0]).toMatchObject({ title: '第一卷', orderIndex: 1, chapterCount: 2 })
    expect(studio.body.data.chapters.map((chapter: { volumeId: string; orderInVolume: number; orderIndex: number }) => ({
      volumeId: chapter.volumeId,
      orderInVolume: chapter.orderInVolume,
      orderIndex: chapter.orderIndex,
    }))).toEqual([
      { volumeId: firstVolumeId, orderInVolume: 1, orderIndex: 1 },
      { volumeId: firstVolumeId, orderInVolume: 2, orderIndex: 2 },
    ])
  })

  it('建卷、跨卷移动和卷内插入后两个序号保持连续', async () => {
    const volume = await request(app)
      .post(`/api/novels/${novelId}/volumes`)
      .set('Cookie', cookie)
      .send({ title: '远行卷' })
    expect(volume.status).toBe(201)
    secondVolumeId = volume.body.data.volume.id as string

    const moved = await request(app)
      .post(`/api/novels/${novelId}/chapters/${secondChapterId}/move`)
      .set('Cookie', cookie)
      .send({ targetVolumeId: secondVolumeId, position: 1 })
    expect(moved.status).toBe(200)
    expect(moved.body.data.chapter).toMatchObject({ volumeId: secondVolumeId, orderInVolume: 1, orderIndex: 2 })

    const inserted = await request(app)
      .post(`/api/novels/${novelId}/chapters`)
      .set('Cookie', cookie)
      .send({
        title: '插入章',
        content: '插入正文',
        status: 'draft',
        visibility: 'private',
        volumeId: secondVolumeId,
        orderInVolume: 1,
      })
    expect(inserted.status).toBe(201)
    expect(inserted.body.data.chapter).toMatchObject({ volumeId: secondVolumeId, orderInVolume: 1, orderIndex: 2 })

    const report = await request(app).get(`/api/novels/${novelId}/structure`).set('Cookie', cookie)
    expect(report.body.data.report).toMatchObject({ valid: true, volumeCount: 2, chapterCount: 3, issues: [] })
  })

  it('移动整卷会同步重排全书章节，但不改卷标题', async () => {
    const moved = await request(app)
      .post(`/api/novels/${novelId}/volumes/${secondVolumeId}/move`)
      .set('Cookie', cookie)
      .send({ position: 1 })
    expect(moved.status).toBe(200)
    expect(moved.body.data.volume).toMatchObject({ title: '远行卷', orderIndex: 1 })

    const studio = await request(app).get(`/api/novels/${novelId}/studio`).set('Cookie', cookie)
    expect(studio.body.data.chapters.map((chapter: { orderIndex: number }) => chapter.orderIndex)).toEqual([1, 2, 3])
    expect(studio.body.data.chapters[2].id).toBe(firstChapterId)
  })

  it('拆分与合并均保持原子结构，过期 revision 被拒绝', async () => {
    const current = await request(app)
      .get(`/api/novels/${novelId}/chapters/${firstChapterId}`)
      .set('Cookie', cookie)
    const revision = current.body.data.chapter.revision as number

    const split = await request(app)
      .post(`/api/novels/${novelId}/chapters/${firstChapterId}/split`)
      .set('Cookie', cookie)
      .send({ splitOffset: 2, newChapterTitle: '拆分章', expectedRevision: revision })
    expect(split.status).toBe(201)
    expect(split.body.data.first.content).toBe('甲乙')
    expect(split.body.data.second.content).toBe('丙丁')

    const staleMove = await request(app)
      .post(`/api/novels/${novelId}/chapters/${firstChapterId}/move`)
      .set('Cookie', cookie)
      .send({ targetVolumeId: firstVolumeId, position: 1, expectedRevision: revision })
    expect(staleMove.status).toBe(409)

    const merged = await request(app)
      .post(`/api/novels/${novelId}/chapters/${firstChapterId}/merge`)
      .set('Cookie', cookie)
      .send({ sourceChapterId: split.body.data.second.id, separator: '' })
    expect(merged.status).toBe(200)
    expect(merged.body.data.chapter.content).toBe('甲乙丙丁')

    const report = await request(app).get(`/api/novels/${novelId}/structure`).set('Cookie', cookie)
    expect(report.body.data.report.valid).toBe(true)
  })

  it('非空卷和最后一卷不能删除', async () => {
    const nonEmpty = await request(app)
      .delete(`/api/novels/${novelId}/volumes/${firstVolumeId}`)
      .set('Cookie', cookie)
    expect(nonEmpty.status).toBe(409)
    expect(nonEmpty.body.error.code).toBe('VOLUME_NOT_EMPTY')
  })

  it('本测试通过接口创建和变更的作品没有缺卷或孤儿章节', async () => {
    const novelsWithoutVolumes = await prisma.novel.count({ where: { id: novelId, volumes: { none: {} } } })
    const orphanChapters = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) AS count
      FROM chapters c
      LEFT JOIN volumes v ON v.id = c.volume_id
      WHERE c.novel_id = ${novelId} AND v.id IS NULL
    `
    expect(novelsWithoutVolumes).toBe(0)
    expect(Number(orphanChapters[0].count)).toBe(0)
  })

  it('第二卷连续建章不与新章占用的临时负序号冲突', async () => {
    const created = await request(app).post('/api/novels').set('Cookie', cookie)
      .send({ title: '临时序号隔离回归', summary: '只用于隔离数据库验证', tags: [] })
    expect(created.status).toBe(201)
    const target = created.body.data.novel.id as string
    expect((await request(app).post(`/api/novels/${target}/chapters`).set('Cookie', cookie)
      .send({ title: '前卷章', content: '前卷正文', status: 'draft', visibility: 'private' })).status).toBe(201)
    const volume = await request(app).post(`/api/novels/${target}/volumes`).set('Cookie', cookie).send({ title: '第二卷' })
    expect(volume.status).toBe(201)
    for (let index = 1; index <= 4; index++) {
      const chapter = await request(app).post(`/api/novels/${target}/chapters`).set('Cookie', cookie)
        .send({ title: `后卷章${index}`, content: `正文${index}`, volumeId: volume.body.data.volume.id, status: 'draft', visibility: 'private' })
      expect(chapter.status).toBe(201)
      expect(chapter.body.data.chapter).toMatchObject({ orderIndex: index + 1, orderInVolume: index })
    }
    const report = await request(app).get(`/api/novels/${target}/structure`).set('Cookie', cookie)
    expect(report.body.data.report).toMatchObject({ valid: true, chapterCount: 5, issues: [] })
  })
})
