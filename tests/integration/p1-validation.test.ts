import { integrationSmsRegistration } from '../support/sms-registration.js'
import request from 'supertest'
import { randomInt } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import app from '../../api/app.js'
import { prisma } from '../../api/lib/prisma.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'

/**
 * 阶段 M：P1 路由 zod 收编（users/ai/admin/agent sessions+plans/comments PATCH）
 * 与死端点 410 后的行为对照。
 * - 缺字段 / 错型 → 400 且文案与收编前逐字一致
 * - 死端点 /outline、/chapter-assist → 410 ENDPOINT_DEPRECATED
 * - 校验顺序不变：admin 端点 requireAdmin 先行（401 优先于 400）
 * - 合法 body 不被 schema 误拒
 */
const dbAvailable = await prisma.$queryRaw`SELECT 1`
  .then(() => true)
  .catch(handleTestDatabaseUnavailable)

afterAll(async () => {
  await prisma.$disconnect().catch(() => {})
})

describe('P1 死端点 410 与校验顺序（无 DB 依赖）', () => {
  it('POST /api/ai/outline → 410 ENDPOINT_DEPRECATED', async () => {
    const res = await request(app).post('/api/ai/outline').send({ theme: 't', genre: 'g' })
    expect(res.status).toBe(410)
    expect(res.body.error.code).toBe('ENDPOINT_DEPRECATED')
    expect(res.body.error.message).toBe('该功能已下线。')
  })

  it('POST /api/ai/chapter-assist → 410 ENDPOINT_DEPRECATED', async () => {
    const res = await request(app)
      .post('/api/ai/chapter-assist')
      .send({ mode: 'polish', content: 'c' })
    expect(res.status).toBe(410)
    expect(res.body.error.code).toBe('ENDPOINT_DEPRECATED')
    expect(res.body.error.message).toBe('该功能已下线。')
  })

  it('未登录时 POST /api/admin/me/change-password 返回 401 而非 400', async () => {
    const res = await request(app).post('/api/admin/me/change-password').send({})
    expect(res.status).toBe(401)
  })
})

describe('P1 tts 合成参数校验（免登录，无 DB 依赖）', () => {
  const cases: Array<{ name: string; body: Record<string, unknown> }> = [
    { name: '缺 novelId', body: { chapterId: 'c', voiceId: 'v', batchIndex: 0 } },
    { name: 'voiceId 纯空白', body: { novelId: 'n', chapterId: 'c', voiceId: '   ', batchIndex: 0 } },
    { name: 'batchIndex 非整数', body: { novelId: 'n', chapterId: 'c', voiceId: 'v', batchIndex: 1.5 } },
    { name: 'batchIndex 负数', body: { novelId: 'n', chapterId: 'c', voiceId: 'v', batchIndex: -1 } },
  ]

  it.each(cases)('$name → 400 原文案', async ({ body }) => {
    const res = await request(app).post('/api/ai/tts/synthesize').send(body)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(res.body.error.message).toBe('请提供完整的听书合成参数。')
  })
})

describe.skipIf(!dbAvailable)('P1 路由 400 文案对照（需 DB）', () => {
  let cookie = ''

  beforeAll(async () => {
    const unique = randomInt(0, 10_000_000).toString().padStart(7, '0')
    const phone = `+861398${unique}`
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...await integrationSmsRegistration(phone), phone, nickname: `p1校验对照${unique}`, password: 'Zod-Test-123!' })
    expect(res.status).toBe(201)
    const setCookies = res.headers['set-cookie']
    const list = Array.isArray(setCookies) ? setCookies : setCookies ? [setCookies] : []
    const session = list.find((item) => item.startsWith('chevoink_session='))
    expect(session).toBeTruthy()
    cookie = session as string
  })

  const cases: Array<{ name: string; req: () => request.Test; message: string }> = [
    {
      name: 'users 昵称：缺 nickname',
      req: () => request(app).patch('/api/users/me/profile').set('Cookie', cookie).send({}),
      message: '请输入昵称。',
    },
    {
      name: 'users 昵称：nickname 错型',
      req: () => request(app).patch('/api/users/me/profile').set('Cookie', cookie).send({ nickname: 123 }),
      message: '请输入昵称。',
    },
    {
      name: 'users 头像：avatarDataUrl 错型',
      req: () => request(app).patch('/api/users/me/avatar').set('Cookie', cookie).send({ avatarDataUrl: 42 }),
      message: '请上传头像图片。',
    },
    {
      name: 'users 密码：缺 password',
      req: () => request(app).patch('/api/users/me/password').set('Cookie', cookie).send({}),
      message: '请输入登录密码。',
    },
    {
      name: 'users 阅读进度：缺 novelId',
      req: () =>
        request(app).post('/api/users/me/reading-progress').set('Cookie', cookie).send({ novelTitle: 't' }),
      message: '缺少作品信息。',
    },
    {
      name: 'users 划线：paragraphIndex 非整数',
      req: () =>
        request(app)
          .put('/api/users/me/underlines')
          .set('Cookie', cookie)
          .send({ novelId: 'n', chapterId: 'c', paragraphIndex: 1.5 }),
      message: '划线参数不完整。',
    },
    {
      name: 'users 已读标记：target 非法枚举',
      req: () =>
        request(app).post('/api/users/me/interaction-badges/seen').set('Cookie', cookie).send({ target: 'bogus' }),
      message: '无效的已读标记目标。',
    },
    {
      name: 'comments 改评：缺 content',
      req: () => request(app).patch('/api/comments/c1').set('Cookie', cookie).send({}),
      message: '请填写评论内容。',
    },
    {
      name: 'agent 建会话：缺 novelId',
      req: () => request(app).post('/api/agent/sessions').set('Cookie', cookie).send({}),
      message: '请提供作品 ID。',
    },
    {
      name: 'agent 改会话：title 纯空白',
      req: () =>
        request(app).patch('/api/agent/sessions/s1').set('Cookie', cookie).send({ title: '   ' }),
      message: '请提供会话标题。',
    },
    {
      name: 'agent 改会话：没有可更新设置',
      req: () => request(app).patch('/api/agent/sessions/s1').set('Cookie', cookie).send({}),
      message: '请提供需要更新的会话设置。',
    },
    {
      name: 'agent 建计划：缺 novelId',
      req: () => request(app).post('/api/agent/plans').set('Cookie', cookie).send({}),
      message: '请提供作品 ID。',
    },
    {
      name: 'agent 改计划：空 patch（refine 至少一键）',
      req: () => request(app).patch('/api/agent/plans/p1').set('Cookie', cookie).send({}),
      message: '请提供需要更新的字段。',
    },
  ]

  it.each(cases)('$name → 400 原文案', async ({ req, message }) => {
    const res = await req()
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(res.body.error.message).toBe(message)
  })

  it('合法 body 不被误拒：更新自己的昵称 → 200', async () => {
    const res = await request(app)
      .patch('/api/users/me/profile')
      .set('Cookie', cookie)
      .send({ nickname: `对照${Date.now().toString().slice(-6)}` })
    expect(res.status).toBe(200)
  })

  it('合法 body 不被误拒：改不存在的计划 → 404 而非 400', async () => {
    const res = await request(app)
      .patch('/api/agent/plans/nonexistent-plan')
      .set('Cookie', cookie)
      .send({ saved: true })
    expect(res.status).not.toBe(400)
    expect(res.status).toBe(404)
  })
})
