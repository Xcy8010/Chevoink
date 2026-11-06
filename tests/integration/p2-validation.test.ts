import { integrationLegalConsent } from '../support/legal-consent.js'
import request from 'supertest'
import { randomInt } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import app from '../../api/app.js'
import { prisma } from '../../api/lib/prisma.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'

/**
 * 阶段 P1：残余写接口 zod 收编收尾（conversations×2 + users privacy + admin delete novel）
 * - 缺字段 / 错型 → 400 且文案与收编前逐字一致
 * - 校验顺序不变：requireSessionUserId / requireAdmin 先行（401 优先于 400）
 * - 合法 body 不被 schema 误拒
 */
const dbAvailable = await prisma.$queryRaw`SELECT 1`
  .then(() => true)
  .catch(handleTestDatabaseUnavailable)

afterAll(async () => {
  await prisma.$disconnect().catch(() => {})
})

describe('P1 收尾校验顺序（无 DB 依赖）', () => {
  it('未登录时 POST /api/conversations 返回 401 而非 400', async () => {
    const res = await request(app).post('/api/conversations').send({})
    expect(res.status).toBe(401)
  })

  it('未登录时 POST /api/conversations/:id/messages 返回 401 而非 400', async () => {
    const res = await request(app).post('/api/conversations/c1/messages').send({})
    expect(res.status).toBe(401)
  })

  it('未登录时 PATCH /api/users/me/privacy 返回 401 而非 400', async () => {
    const res = await request(app).patch('/api/users/me/privacy').send({ followers: 'bogus' })
    expect(res.status).toBe(401)
  })

  it('未登录时 DELETE /api/admin/novels/:novelId 返回 401 而非 400', async () => {
    const res = await request(app).delete('/api/admin/novels/n1').send({})
    expect(res.status).toBe(401)
  })
})

describe.skipIf(!dbAvailable)('P1 收尾 400 文案对照（需 DB）', () => {
  let cookie = ''

  beforeAll(async () => {
    const unique = randomInt(0, 10_000_000).toString().padStart(7, '0')
    const phone = `+861398${unique}`
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...await integrationLegalConsent(), phone, nickname: `p1收尾对照${unique}`, password: 'Zod-Test-123!' })
    expect(res.status).toBe(201)
    const setCookies = res.headers['set-cookie']
    const list = Array.isArray(setCookies) ? setCookies : setCookies ? [setCookies] : []
    const session = list.find((item) => item.startsWith('chevoink_session='))
    expect(session).toBeTruthy()
    cookie = session as string
  })

  const cases: Array<{ name: string; req: () => request.Test; message: string }> = [
    {
      name: 'conversations 建会话：缺 targetUserId',
      req: () => request(app).post('/api/conversations').set('Cookie', cookie).send({}),
      message: '请指定要私信的用户。',
    },
    {
      name: 'conversations 建会话：targetUserId 纯空白',
      req: () => request(app).post('/api/conversations').set('Cookie', cookie).send({ targetUserId: '   ' }),
      message: '请指定要私信的用户。',
    },
    {
      name: 'conversations 发消息：缺 content',
      req: () =>
        request(app).post('/api/conversations/c1/messages').set('Cookie', cookie).send({ type: 'text' }),
      message: '消息内容不能为空。',
    },
    {
      name: 'conversations 发消息：缺 type',
      req: () =>
        request(app).post('/api/conversations/c1/messages').set('Cookie', cookie).send({ content: '你好' }),
      message: '消息内容不能为空。',
    },
    {
      name: 'conversations 发消息：content 纯空白',
      req: () =>
        request(app)
          .post('/api/conversations/c1/messages')
          .set('Cookie', cookie)
          .send({ type: 'text', content: '   ' }),
      message: '消息内容不能为空。',
    },
    {
      name: 'users 隐私：followers 非法枚举',
      req: () =>
        request(app).patch('/api/users/me/privacy').set('Cookie', cookie).send({ followers: 'bogus' }),
      message: '隐私级别不合法。',
    },
    {
      name: 'users 隐私：replies 错型',
      req: () => request(app).patch('/api/users/me/privacy').set('Cookie', cookie).send({ replies: 123 }),
      message: '隐私级别不合法。',
    },
  ]

  it.each(cases)('$name → 400 原文案', async ({ req, message }) => {
    const res = await req()
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(res.body.error.message).toBe(message)
  })

  it('合法 body 不被误拒：更新单项隐私 → 200', async () => {
    const res = await request(app)
      .patch('/api/users/me/privacy')
      .set('Cookie', cookie)
      .send({ followers: 'public' })
    expect(res.status).toBe(200)
  })

  it('合法 body 不被误拒：空 body 仍放行返回当前隐私 → 200', async () => {
    const res = await request(app).patch('/api/users/me/privacy').set('Cookie', cookie).send({})
    expect(res.status).toBe(200)
  })

  it('合法 body 不被误拒：向不存在的用户建会话 → 404 而非 400', async () => {
    const res = await request(app)
      .post('/api/conversations')
      .set('Cookie', cookie)
      .send({ targetUserId: 'nonexistent-user' })
    expect(res.status).toBe(404)
  })

  it('合法 body 不被误拒：向不存在的会话发消息 → 404 而非 400', async () => {
    const res = await request(app)
      .post('/api/conversations/nonexistent-conversation/messages')
      .set('Cookie', cookie)
      .send({ type: 'text', content: '你好' })
    expect(res.status).toBe(404)
  })
})
