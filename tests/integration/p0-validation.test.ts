import { integrationLegalConsent } from '../support/legal-consent.js'
import request from 'supertest'
import { randomInt } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import app from '../../api/app.js'
import { prisma } from '../../api/lib/prisma.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'

/**
 * 阶段 L3：P0 写操作路由 zod 收编后的行为对照。
 * - 401 优先于 400（校验顺序与改前一致）
 * - 缺字段 / 错型 → 400 且文案与收编前逐字一致
 * - 合法 body 不被 schema 误拒（走到 404 业务分支）
 * 纯写库类端点（建作品/发帖/起 run/落盘附件）的「合法输入不误拒」
 * 由 tests/unit/schemas.test.ts 的 safeParse 用例覆盖，此处不做写库正常例。
 */
const dbAvailable = await prisma.$queryRaw`SELECT 1`
  .then(() => true)
  .catch(handleTestDatabaseUnavailable)

afterAll(async () => {
  await prisma.$disconnect().catch(() => {})
})

describe('P0 路由校验顺序（无 DB 依赖）', () => {
  it('未登录时 POST /api/novels 返回 401 而非 400', async () => {
    const res = await request(app).post('/api/novels').send({})
    expect(res.status).toBe(401)
  })
})

describe.skipIf(!dbAvailable)('P0 路由 400 文案对照（需 DB）', () => {
  let cookie = ''

  beforeAll(async () => {
    const unique = randomInt(0, 10_000_000).toString().padStart(7, '0')
    const phone = `+861397${unique}`
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...await integrationLegalConsent(), phone, nickname: `zod校验对照${unique}`, password: 'Zod-Test-123!' })
    expect(res.status).toBe(201)
    const setCookies = res.headers['set-cookie']
    const list = Array.isArray(setCookies) ? setCookies : setCookies ? [setCookies] : []
    const session = list.find((item) => item.startsWith('chevoink_session='))
    expect(session).toBeTruthy()
    cookie = session as string
  })

  const cases: Array<{ name: string; req: () => request.Test; message: string }> = [
    {
      name: 'novels 创建：缺 summary',
      req: () => request(app).post('/api/novels').set('Cookie', cookie).send({ title: 't' }),
      message: '请完整填写作品标题和简介。',
    },
    {
      name: 'novels 创建：title 错型',
      req: () => request(app).post('/api/novels').set('Cookie', cookie).send({ title: 123, summary: 's' }),
      message: '请完整填写作品标题和简介。',
    },
    {
      name: 'novels 更新：status 非法枚举（原零校验透传，收紧为 400）',
      req: () => request(app).patch('/api/novels/n1').set('Cookie', cookie).send({ status: 'bogus' }),
      message: '作品信息格式不正确。',
    },
    {
      name: 'novels 封面：缺 coverDataUrl',
      req: () => request(app).patch('/api/novels/n1/cover').set('Cookie', cookie).send({}),
      message: '请提供作品封面图片。',
    },
    {
      name: 'novels 封面：coverDataUrl 错型',
      req: () => request(app).patch('/api/novels/n1/cover').set('Cookie', cookie).send({ coverDataUrl: 42 }),
      message: '请提供作品封面图片。',
    },
    {
      name: 'novels 发布：chapterIds 错型',
      req: () => request(app).post('/api/novels/n1/publish').set('Cookie', cookie).send({ chapterIds: 'abc' }),
      message: '发布参数不正确。',
    },
    {
      name: 'novels 发布：chapterIds 含空串（原静默剔除，收紧为 400）',
      req: () => request(app).post('/api/novels/n1/publish').set('Cookie', cookie).send({ chapterIds: [''] }),
      message: '发布参数不正确。',
    },
    {
      name: 'chapters 建章：缺 status',
      req: () =>
        request(app).post('/api/novels/n1/chapters').set('Cookie', cookie).send({ title: 't', content: 'c' }),
      message: '请完整填写章节信息。',
    },
    {
      name: 'chapters 建章：status 错型',
      req: () =>
        request(app)
          .post('/api/novels/n1/chapters')
          .set('Cookie', cookie)
          .send({ title: 't', content: 'c', status: 5 }),
      message: '请完整填写章节信息。',
    },
    {
      name: 'chapters 改章：content 错型',
      req: () =>
        request(app)
          .patch('/api/novels/n1/chapters/c1')
          .set('Cookie', cookie)
          .send({ content: 42 }),
      message: '章节信息格式不正确。',
    },
    {
      name: 'posts 发动态：缺 content',
      req: () => request(app).post('/api/posts').set('Cookie', cookie).send({}),
      message: '请输入动态内容。',
    },
    {
      name: 'posts 发动态：content 错型',
      req: () => request(app).post('/api/posts').set('Cookie', cookie).send({ content: 123 }),
      message: '请输入动态内容。',
    },
    {
      name: 'comments 评论：缺 targetId',
      req: () =>
        request(app).post('/api/comments').set('Cookie', cookie).send({ targetType: 'novel', content: 'c' }),
      message: '请完整填写评论内容。',
    },
    {
      name: 'comments 评论：targetType 非法枚举',
      req: () =>
        request(app).post('/api/comments').set('Cookie', cookie).send({ targetType: 'video', targetId: 'x', content: 'c' }),
      message: '请完整填写评论内容。',
    },
    {
      name: 'agent 起 run：缺 prompt',
      req: () =>
        request(app)
          .post('/api/agent/runs')
          .set('Cookie', cookie)
          .send({ sessionId: 's', novelId: 'n', mode: 'build' }),
      message: '请完整填写运行参数。',
    },
    {
      name: 'agent 起 run：mode 非法枚举',
      req: () =>
        request(app)
          .post('/api/agent/runs')
          .set('Cookie', cookie)
          .send({ sessionId: 's', novelId: 'n', mode: 'bogus', prompt: 'p' }),
      message: '请完整填写运行参数。',
    },
    {
      name: 'agent 审批：缺 approved',
      req: () => request(app).post('/api/agent/runs/r1/approvals').set('Cookie', cookie).send({ callId: 'c' }),
      message: '请提供 callId 与 approved。',
    },
    {
      name: 'agent 审批：approved 错型',
      req: () =>
        request(app)
          .post('/api/agent/runs/r1/approvals')
          .set('Cookie', cookie)
          .send({ callId: 'c', approved: 'yes' }),
      message: '请提供 callId 与 approved。',
    },
    {
      name: 'agent 提问批复：缺 answer',
      req: () => request(app).post('/api/agent/runs/r1/questions').set('Cookie', cookie).send({ callId: 'c' }),
      message: '请提供 callId 与回答内容。',
    },
    {
      name: 'agent 提问批复：answer 纯空白',
      req: () =>
        request(app).post('/api/agent/runs/r1/questions').set('Cookie', cookie).send({ callId: 'c', answer: '   ' }),
      message: '请提供 callId 与回答内容。',
    },
    {
      name: 'agent 附件：缺字段',
      req: () => request(app).post('/api/agent/attachments').set('Cookie', cookie).send({ kind: 'image' }),
      message: '附件参数不完整。',
    },
    {
      name: 'agent 附件：kind 非法枚举',
      req: () =>
        request(app)
          .post('/api/agent/attachments')
          .set('Cookie', cookie)
          .send({ kind: 123, name: 'n', dataUrl: 'd' }),
      message: '附件参数不完整。',
    },
  ]

  it.each(cases)('$name → 400 原文案', async ({ req, message }) => {
    const res = await req()
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(res.body.error.message).toBe(message)
  })

  it('合法 body 不被误拒：PATCH 不存在的作品 → 404 而非 400', async () => {
    const res = await request(app)
      .patch('/api/novels/nonexistent-id')
      .set('Cookie', cookie)
      .send({ title: '合法标题' })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOVEL_NOT_FOUND')
  })

  it('合法 body 不被误拒：发布不存在的作品 → 404 而非 400', async () => {
    const res = await request(app)
      .post('/api/novels/nonexistent-id/publish')
      .set('Cookie', cookie)
      .send({ chapterIds: ['a'] })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOVEL_NOT_FOUND')
  })

  it('合法 body 不被误拒：审批不存在的 run → 404 而非 400', async () => {
    const res = await request(app)
      .post('/api/agent/runs/nonexistent-run/approvals')
      .set('Cookie', cookie)
      .send({ callId: 'c', approved: true })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
  })

  it('合法 body 不被误拒：回答不存在的 run 提问 → 404 而非 400', async () => {
    const res = await request(app)
      .post('/api/agent/runs/nonexistent-run/questions')
      .set('Cookie', cookie)
      .send({ callId: 'c', answer: '好的' })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
  })
})
