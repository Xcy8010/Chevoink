import { integrationLegalConsent } from '../support/legal-consent.js'
import { randomInt } from 'node:crypto'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import app from '../../api/app.js'
import { prisma } from '../../api/lib/prisma.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)

function sessionCookie(response: request.Response): string {
  const values = Array.isArray(response.headers['set-cookie']) ? response.headers['set-cookie'] : [response.headers['set-cookie']]
  return values.find((value: string) => value?.startsWith('chevoink_session=')) as string
}

async function registerAdmin(superAdmin: boolean): Promise<{ cookie: string; id: string }> {
  const unique = randomInt(0, 10_000_000).toString().padStart(7, '0')
  const phone = `+861387${unique}`
  const response = await request(app).post('/api/auth/register').send({ ...await integrationLegalConsent(),
    phone,
    nickname: `盲评测试${unique}`,
    password: 'Blind-Review-123!',
  })
  expect(response.status).toBe(201)
  const user = { id: response.body.data.user.id as string }
  await prisma.user.update({ where: { id: user.id }, data: { role: 'admin', isSuperAdmin: superAdmin } })
  return { cookie: sessionCookie(response), id: user.id }
}

afterAll(async () => {
  await prisma.$disconnect().catch(() => {})
})

describe.skipIf(!dbAvailable)('Agent 3.0 专家盲评 API（需 DB）', () => {
  let superAdmin: { cookie: string; id: string }
  let reviewer: { cookie: string; id: string }
  let suiteId = ''
  let sampleId = ''

  beforeAll(async () => {
    superAdmin = await registerAdmin(true)
    reviewer = await registerAdmin(false)
  })

  it('仅超级管理员可建套件，来源引用只保存 HMAC', async () => {
    const denied = await request(app).post('/api/admin/evals/suites').set('Cookie', reviewer.cookie).send({
      name: '越权套件', datasetVersion: 'v1', rubricVersion: 'v1',
    })
    expect(denied.status).toBe(403)

    const suite = await request(app).post('/api/admin/evals/suites').set('Cookie', superAdmin.cookie).send({
      name: 'P0 中文网文专家盲评', datasetVersion: 'cn-fiction-v1', rubricVersion: 'humanization-v1',
    })
    expect(suite.status).toBe(201)
    suiteId = suite.body.data.id as string

    const sample = await request(app).post(`/api/admin/evals/suites/${suiteId}/samples`).set('Cookie', superAdmin.cookie).send({
      code: 'urban-continuation-001',
      title: '都市章节续写',
      genre: '都市',
      task: '续写',
      style: '克制口语',
      evaluationBrief: '比较剧情推进、人物声音、情感落地和继续阅读意愿。',
      sourceClass: 'licensed',
      sourceReference: 'licensed-contract://secret/source/001',
      candidates: [
        { origin: 'agent2', content: 'Agent 2 候选正文。人物走进屋里，重复解释了上一章发生的冲突，然后停在门口。' },
        { origin: 'agent3', content: 'Agent 3 候选正文。门刚推开一条缝，屋里那句没说完的话就先撞了出来。' },
        { origin: 'human', content: '人类候选正文。她把钥匙留在锁眼里，没有回头，只问桌边的人还认不认那张欠条。' },
      ],
    })
    expect(sample.status).toBe(201)
    sampleId = sample.body.data.id as string

    const stored = await prisma.agentEvalSample.findUniqueOrThrow({ where: { id: sampleId } })
    expect(stored.sourceReferenceHash).toMatch(/^[a-f0-9]{64}$/)
    expect(stored.sourceReferenceHash).not.toContain('secret/source')
  })

  it('分配响应只含 A/B/C，不泄漏真实来源和内部来源引用', async () => {
    const activated = await request(app).patch(`/api/admin/evals/suites/${suiteId}`).set('Cookie', superAdmin.cookie).send({ status: 'active' })
    expect(activated.status).toBe(200)

    const assignment = await request(app).get(`/api/admin/evals/review/next?suiteId=${suiteId}`).set('Cookie', reviewer.cookie)
    expect(assignment.status).toBe(200)
    expect(assignment.body.data.assignment.candidates.map((candidate: { label: string }) => candidate.label).sort()).toEqual(['A', 'B', 'C'])
    const serialized = JSON.stringify(assignment.body.data)
    expect(serialized).not.toContain('origin')
    expect(serialized).not.toContain('sourceReference')
    expect(serialized).not.toContain('licensed-contract')
  })

  it('逐样本提交且防重复，评审身份只保存 HMAC，揭盲结果仅超级管理员可见', async () => {
    const assignmentResponse = await request(app).get(`/api/admin/evals/review/next?suiteId=${suiteId}`).set('Cookie', reviewer.cookie)
    const labels = assignmentResponse.body.data.assignment.candidates.map((candidate: { label: string }) => candidate.label) as string[]
    const dimensions = [
      'continue_reading', 'plot_progress', 'character_agency_voice', 'emotion_credibility', 'style_consistency',
      'description_function', 'mechanical_texture', 'chapter_bridge', 'overall_preference',
    ]
    const candidateRatings = Object.fromEntries(labels.map((label) => [label, Object.fromEntries(dimensions.map((dimension) => [dimension, 4]))]))
    const body = {
      candidateRatings,
      guessedOrigins: Object.fromEntries(labels.map((label) => [label, 'unsure'])),
      mechanicalReasons: Object.fromEntries(labels.map((label) => [label, []])),
      preferredLabel: labels[0],
      notes: '匿名评审记录',
    }
    const submitted = await request(app).post(`/api/admin/evals/samples/${sampleId}/reviews`).set('Cookie', reviewer.cookie).send(body)
    expect(submitted.status).toBe(201)
    const duplicate = await request(app).post(`/api/admin/evals/samples/${sampleId}/reviews`).set('Cookie', reviewer.cookie).send(body)
    expect(duplicate.status).toBe(409)

    const stored = await prisma.agentBlindReview.findFirstOrThrow({ where: { sampleId } })
    expect(stored.reviewerHash).toMatch(/^[a-f0-9]{64}$/)
    expect(stored.reviewerHash).not.toBe(reviewer.id)

    const denied = await request(app).get(`/api/admin/evals/suites/${suiteId}/results`).set('Cookie', reviewer.cookie)
    expect(denied.status).toBe(403)
    const results = await request(app).get(`/api/admin/evals/suites/${suiteId}/results`).set('Cookie', superAdmin.cookie)
    expect(results.status).toBe(200)
    expect(results.body.data.reviewerCount).toBe(1)
    expect(results.body.data.variants.map((variant: { origin: string }) => variant.origin).sort()).toEqual(['agent2', 'agent3', 'human'])
  })
})
