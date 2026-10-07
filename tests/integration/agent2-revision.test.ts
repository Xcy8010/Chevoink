import request from 'supertest'
import { randomInt } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import app from '../../api/app.js'
import { prisma } from '../../api/lib/prisma.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'

const dbAvailable = await prisma.$queryRaw`SELECT 1`
  .then(() => true)
  .catch(handleTestDatabaseUnavailable)

afterAll(async () => {
  await prisma.$disconnect().catch(() => {})
})

describe.skipIf(!dbAvailable)('Agent 2.0 章节 revision 乐观锁（需 DB）', () => {
  let cookie = ''
  let novelId = ''
  let chapterId = ''
  let initialRevision = 0

  beforeAll(async () => {
    const unique = randomInt(0, 10_000_000).toString().padStart(7, '0')
    const phone = `+861396${unique}`
    const register = await request(app)
      .post('/api/auth/register')
      .send({ phone, nickname: `revision并发测试${unique}`, password: 'Revision-Test-123!' })
    expect(register.status).toBe(201)
    const setCookies = register.headers['set-cookie']
    const list = Array.isArray(setCookies) ? setCookies : setCookies ? [setCookies] : []
    cookie = list.find((item) => item.startsWith('chevoink_session=')) as string

    const novel = await request(app)
      .post('/api/novels')
      .set('Cookie', cookie)
      .send({ title: '并发测试作品', summary: '验证章节 revision。', tags: [] })
    expect(novel.status).toBe(201)
    novelId = novel.body.data.novel.id as string

    const chapter = await request(app)
      .post(`/api/novels/${novelId}/chapters`)
      .set('Cookie', cookie)
      .send({ title: '第一章 起点', content: '初始正文', status: 'draft', visibility: 'private' })
    expect(chapter.status).toBe(201)
    chapterId = chapter.body.data.chapter.id as string
    initialRevision = chapter.body.data.chapter.revision as number
  })

  it('相同 expectedRevision 只有第一次写入成功，过期写入返回 409', async () => {
    const first = await request(app)
      .patch(`/api/novels/${novelId}/chapters/${chapterId}`)
      .set('Cookie', cookie)
      .send({ content: '客户端 A 的正文', expectedRevision: initialRevision })
    expect(first.status).toBe(200)
    expect(first.body.data.chapter.revision).toBe(initialRevision + 1)

    const stale = await request(app)
      .patch(`/api/novels/${novelId}/chapters/${chapterId}`)
      .set('Cookie', cookie)
      .send({ content: '客户端 B 的过期正文', expectedRevision: initialRevision })
    expect(stale.status).toBe(409)
    expect(stale.body.error.code).toBe('CHAPTER_REVISION_CONFLICT')

    const current = await request(app)
      .get(`/api/novels/${novelId}/chapters/${chapterId}`)
      .set('Cookie', cookie)
    expect(current.body.data.chapter.content).toBe('客户端 A 的正文')
  })

  it('旧客户端不传 expectedRevision 仍可保存，但版本继续递增', async () => {
    const response = await request(app)
      .patch(`/api/novels/${novelId}/chapters/${chapterId}`)
      .set('Cookie', cookie)
      .send({ content: '旧客户端兼容正文' })

    expect(response.status).toBe(200)
    expect(response.body.data.chapter.revision).toBe(initialRevision + 2)
  })

  it('过期版本不能删除新内容，当前版本可以删除', async () => {
    const stale = await request(app)
      .delete(`/api/novels/${novelId}/chapters/${chapterId}?expectedRevision=${initialRevision}`)
      .set('Cookie', cookie)
    expect(stale.status).toBe(409)

    const current = await request(app)
      .delete(`/api/novels/${novelId}/chapters/${chapterId}?expectedRevision=${initialRevision + 2}`)
      .set('Cookie', cookie)
    expect(current.status).toBe(200)
  })
})
