import { randomInt } from 'node:crypto'

import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import app from '../../api/app.js'
import { prisma } from '../../api/lib/prisma.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)

afterAll(async () => {
  await prisma.$disconnect().catch(() => {})
})

describe.skipIf(!dbAvailable)('Agent 2.0 P2 全书检索与 ChangeSet（需 DB）', () => {
  let cookie = ''
  let novelId = ''
  const chapterIds: string[] = []

  beforeAll(async () => {
    const unique = randomInt(0, 10_000_000).toString().padStart(7, '0')
    const register = await request(app)
      .post('/api/auth/register')
      .send({ phone: `+861394${unique}`, nickname: `ChangeSet测试${unique}`, password: 'ChangeSet-Test-123!' })
    expect(register.status).toBe(201)
    const cookies = Array.isArray(register.headers['set-cookie']) ? register.headers['set-cookie'] : [register.headers['set-cookie']]
    cookie = cookies.find((item: string) => item?.startsWith('chevoink_session=')) as string

    const novel = await request(app)
      .post('/api/novels')
      .set('Cookie', cookie)
      .send({ title: '三十章改名评测', summary: '全书精确改名测试。', tags: [] })
    expect(novel.status).toBe(201)
    novelId = novel.body.data.novel.id as string

    for (let index = 1; index <= 30; index += 1) {
      const quoted = index % 5 === 0 ? '旁人回忆道：“林默当年也来过。”' : ''
      const chapter = await request(app)
        .post(`/api/novels/${novelId}/chapters`)
        .set('Cookie', cookie)
        .send({
          title: `第${index}章 雨巷${index}`,
          content: `第${index}章开场，林默走进雨巷。${quoted}`,
          status: 'draft',
          visibility: 'private',
        })
      expect(chapter.status).toBe(201)
      chapterIds.push(chapter.body.data.chapter.id as string)
    }
  }, 30_000)

  it('一次检索返回 30 章全部 36 处命中及精确来源版本', async () => {
    const response = await request(app)
      .post(`/api/novels/${novelId}/search`)
      .set('Cookie', cookie)
      .send({ query: '林默', mode: 'exact', fields: ['content'], limit: 100 })
    expect(response.status).toBe(200)
    expect(response.body.data).toMatchObject({ total: 36, truncated: false, indexState: 'fresh' })
    expect(new Set(response.body.data.matches.map((match: { chapterId: string }) => match.chapterId)).size).toBe(30)
    expect(response.body.data.matches.every((match: { revision: number; offset: number }) => match.revision > 0 && match.offset >= 0)).toBe(true)
  })

  it('实体改名预览保留引号内旧名，应用后 30 处新名且 6 处旧名', async () => {
    const preview = await request(app)
      .post(`/api/novels/${novelId}/changesets/preview`)
      .set('Cookie', cookie)
      .send({
        query: '林默',
        replacement: '林舟',
        fields: ['content'],
        preserveQuotedText: true,
        reason: '人物主名改名，保留回忆引语旧名',
      })
    expect(preview.status).toBe(201)
    expect(preview.body.data.changeSet.patches).toHaveLength(30)
    expect(preview.body.data.changeSet.validations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'QUOTED_OCCURRENCES_EXCLUDED', status: 'warning' }),
    ]))

    const applied = await request(app)
      .post(`/api/changesets/${preview.body.data.changeSet.id}/apply`)
      .set('Cookie', cookie)
      .send({})
    expect(applied.status).toBe(200)
    expect(applied.body.data.changeSet.status).toBe('applied')

    const [oldName, newName] = await Promise.all([
      request(app).post(`/api/novels/${novelId}/search`).set('Cookie', cookie).send({ query: '林默', mode: 'exact', fields: ['content'], limit: 100 }),
      request(app).post(`/api/novels/${novelId}/search`).set('Cookie', cookie).send({ query: '林舟', mode: 'exact', fields: ['content'], limit: 100 }),
    ])
    expect(oldName.body.data.total).toBe(6)
    expect(newName.body.data.total).toBe(30)

    const rolledBack = await request(app)
      .post(`/api/changesets/${preview.body.data.changeSet.id}/rollback`)
      .set('Cookie', cookie)
      .send({ reason: '评测回滚' })
    expect(rolledBack.status).toBe(200)
    expect(rolledBack.body.data.changeSet.status).toBe('rolled_back')

    const restored = await request(app)
      .post(`/api/novels/${novelId}/search`)
      .set('Cookie', cookie)
      .send({ query: '林默', mode: 'exact', fields: ['content'], limit: 100 })
    expect(restored.body.data.total).toBe(36)
  })

  it('预览后出现无关编辑时在最新正文安全重放，并在回滚时保留该编辑', async () => {
    const preview = await request(app)
      .post(`/api/novels/${novelId}/changesets/preview`)
      .set('Cookie', cookie)
      .send({ query: '林默', replacement: '林舟', fields: ['content'], preserveQuotedText: false })
    expect(preview.status).toBe(201)

    const current = await request(app)
      .get(`/api/novels/${novelId}/chapters/${chapterIds[0]}`)
      .set('Cookie', cookie)
    await request(app)
      .patch(`/api/novels/${novelId}/chapters/${chapterIds[0]}`)
      .set('Cookie', cookie)
      .send({ content: `${current.body.data.chapter.content}用户刚补了一句。`, expectedRevision: current.body.data.chapter.revision })

    const apply = await request(app)
      .post(`/api/changesets/${preview.body.data.changeSet.id}/apply`)
      .set('Cookie', cookie)
      .send({})
    expect(apply.status).toBe(200)
    expect(apply.body.data.changeSet.status).toBe('applied')
    expect(apply.body.data.changeSet.validations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'CONCURRENT_CHANGES_REBASED', status: 'passed' }),
    ]))

    const rebased = await request(app)
      .get(`/api/novels/${novelId}/chapters/${chapterIds[0]}`)
      .set('Cookie', cookie)
    expect(rebased.body.data.chapter.content).toContain('林舟')
    expect(rebased.body.data.chapter.content).toContain('用户刚补了一句。')

    const rolledBack = await request(app)
      .post(`/api/changesets/${preview.body.data.changeSet.id}/rollback`)
      .set('Cookie', cookie)
      .send({ reason: '验证回滚保留并发编辑' })
    expect(rolledBack.status).toBe(200)
    const restored = await request(app).get(`/api/novels/${novelId}/chapters/${chapterIds[0]}`).set('Cookie', cookie)
    expect(restored.body.data.chapter.content).toContain('林默')
    expect(restored.body.data.chapter.content).toContain('用户刚补了一句。')
  })

  it('替换目标本身已被改写时仍整批 0 写入并记录 conflicted', async () => {
    const preview = await request(app)
      .post(`/api/novels/${novelId}/changesets/preview`)
      .set('Cookie', cookie)
      .send({ query: '林默', replacement: '林舟', fields: ['content'], preserveQuotedText: false })
    expect(preview.status).toBe(201)

    const current = await request(app).get(`/api/novels/${novelId}/chapters/${chapterIds[0]}`).set('Cookie', cookie)
    await request(app)
      .patch(`/api/novels/${novelId}/chapters/${chapterIds[0]}`)
      .set('Cookie', cookie)
      .send({ content: current.body.data.chapter.content.replaceAll('林默', '林岚'), expectedRevision: current.body.data.chapter.revision })

    const apply = await request(app).post(`/api/changesets/${preview.body.data.changeSet.id}/apply`).set('Cookie', cookie).send({})
    expect(apply.status).toBe(409)
    expect(apply.body.error.code).toBe('CHANGESET_REBASE_CONFLICT')
    const untouched = await request(app).get(`/api/novels/${novelId}/chapters/${chapterIds[1]}`).set('Cookie', cookie)
    expect(untouched.body.data.chapter.content).toContain('林默')
    expect(untouched.body.data.chapter.content).not.toContain('林舟')
  })

  it('数据库存在同步维护的 trigram 与全文 GIN 索引', async () => {
    const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'chapters'
    `
    const names = indexes.map((index) => index.indexname)
    expect(names).toEqual(expect.arrayContaining([
      'chapters_title_trgm_idx',
      'chapters_summary_trgm_idx',
      'chapters_content_trgm_idx',
      'chapters_search_fts_idx',
    ]))
  })
})
