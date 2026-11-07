import { integrationSmsRegistration } from '../support/sms-registration.js'
import { randomInt, randomUUID } from 'node:crypto'

import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import app from '../../api/app.js'
import {
  checkStyleLeakage,
  importCorpusDocument,
  searchCraftLibrary,
} from '../../api/lib/agent/craft-library.js'
import { prisma } from '../../api/lib/prisma.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
const AUTHOR_SAMPLE_BASE = '林舟把报表推回桌心，没有解释自己为什么拒绝。他问：“如果到账晚三天，谁来签字？”会议室里没人接话。顾棠合上电脑，把违约条款翻到最后一页。'

afterAll(async () => {
  await prisma.$disconnect().catch(() => {})
})

describe.skipIf(!dbAvailable)('Agent 3.0 合法文笔库闭环（需 DB）', () => {
  let userId = ''
  let novelId = ''
  let runId = ''
  let cookie = ''
  let chapterIds: string[] = []
  let privateSourceId = ''

  beforeAll(async () => {
    const unique = randomInt(0, 10_000_000).toString().padStart(7, '0')
    const phone = `+861376${unique}`
    const register = await request(app).post('/api/auth/register').send({ ...await integrationSmsRegistration(phone), phone, nickname: `文笔库测试${unique}`, password: 'Craft-Library-123!' })
    expect(register.status).toBe(201)
    const cookies = Array.isArray(register.headers['set-cookie']) ? register.headers['set-cookie'] : [register.headers['set-cookie']]
    cookie = cookies.find((item: string) => item?.startsWith('chevoink_session=')) as string
    userId = (await prisma.user.findUniqueOrThrow({ where: { phone }, select: { id: true } })).id
    const novel = await request(app).post('/api/novels').set('Cookie', cookie).send({ title: '合法文笔库测试', summary: '验证权利门、混合检索和撤权。', tags: ['都市'] })
    expect(novel.status).toBe(201)
    novelId = novel.body.data.novel.id as string
    const volumeId = (await prisma.volume.findFirstOrThrow({ where: { novelId }, select: { id: true } })).id
    chapterIds = [randomUUID(), randomUUID()]
    await prisma.chapter.createMany({ data: chapterIds.map((id, index) => ({
      id, novelId, authorId: userId, volumeId, orderIndex: index + 1, orderInVolume: index + 1,
      title: `样章 ${index + 1}`, content: AUTHOR_SAMPLE_BASE.repeat(8), wordCount: AUTHOR_SAMPLE_BASE.length * 8, revision: 1,
      status: 'draft', visibility: 'private',
    })) })
    const session = await prisma.agentSession.create({ data: { userId, novelId, title: 'P4 文笔库测试' } })
    runId = (await prisma.agentRun.create({ data: {
      sessionId: session.id, userId, novelId, chapterId: chapterIds[0], mode: 'act', action: 'workspaceAgent',
      agentType: 'writingOrchestrator', status: 'running', engine: 'loop',
    } })).id
  })

  it('生产索引包含 320 张有权利记录的内置卡，pending 来源即使误设 active 也不可召回', async () => {
    const builtin = await prisma.corpusSource.findUniqueOrThrow({ where: { id: 'builtin.agent3.craft.v1' } })
    expect(builtin).toMatchObject({ rightsStatus: 'approved', indexAllowed: true, rawStorageAllowed: false })
    expect(await prisma.techniqueCard.count({ where: { sourceId: builtin.id, active: true } })).toBe(320)

    const pending = await prisma.corpusSource.create({ data: {
      name: '未审批来源', sourceClass: 'licensed', rightsHolder: '未知', license: 'Unknown', commercialUse: true,
      redistribution: false, modification: false, rawStorageAllowed: false, indexAllowed: true,
      rightsStatus: 'pending', rightsEvidence: '待审。',
    } })
    const pendingCard = await prisma.techniqueCard.create({ data: {
      sourceId: pending.id, cardKey: `pending.${randomUUID()}`, title: '不应召回', genre: '都市', sceneType: '谈判',
      readerEffect: '错误进入索引', defectTargets: [], techniques: ['不应出现'], styleStats: {}, avoid: [],
      searchableText: '都市 谈判 不应召回', abstractionHash: randomUUID().replaceAll('-', ''), active: true,
    } })
    const result = await searchCraftLibrary({ userId, novelId, runId, query: {
      genre: '都市', sceneType: '谈判', defectTargets: ['plot_progress'], limit: 4,
    } })
    expect(result.cards).toHaveLength(4)
    expect(result.cards.some((card) => card.id === pendingCard.id)).toBe(false)
    expect(result.cards.every((card) => card.rights.reversibleQuote === false)).toBe(true)
    const trace = await prisma.retrievalTrace.findUniqueOrThrow({ where: { id: result.traceId } })
    expect(trace).toMatchObject({ userId, novelId, runId })
    expect(JSON.stringify(trace.selected)).not.toContain(AUTHOR_SAMPLE_BASE.slice(0, 30))
  })

  it('作者明确选择样章后只建立本作品私有 Style DNA，读取接口不返回正文', async () => {
    const created = await request(app).post(`/api/agent/novels/${novelId}/style-profile`).set('Cookie', cookie).send({
      title: '我的克制谈判样章', chapterIds, consent: true,
    })
    expect(created.status).toBe(201)
    privateSourceId = created.body.data.profile.sourceId as string
    const source = await prisma.corpusSource.findUniqueOrThrow({ where: { id: privateSourceId } })
    expect(source).toMatchObject({ userId, novelId, scope: 'novel', sourceClass: 'author_private', rightsStatus: 'approved' })
    const profileResponse = await request(app).get(`/api/agent/novels/${novelId}/style-profile`).set('Cookie', cookie)
    expect(profileResponse.status).toBe(200)
    expect(profileResponse.body.data.profile.stats.sampleChars).toBeGreaterThan(500)
    expect(JSON.stringify(profileResponse.body)).not.toContain(AUTHOR_SAMPLE_BASE.slice(0, 30))
  })

  it('支持上传受限 TXT/Markdown 自有样章建立 Style DNA', async () => {
    const content = '她没有解释，只把账本翻到缺失的那一页。桌边的人停止争吵，开始核对日期与签名。'.repeat(35)
    const response = await request(app).post(`/api/agent/novels/${novelId}/style-profile`).set('Cookie', cookie).send({
      title: '上传的克制叙事样章',
      chapterIds: [],
      uploadedFile: { name: 'private-sample.md', size: Buffer.byteLength(content), content },
      consent: true,
    })
    expect(response.status).toBe(201)
    expect(response.body.data.profile.stats.sampleCount).toBe(1)
    const document = await prisma.corpusDocument.findUniqueOrThrow({ where: { id: response.body.data.profile.documentId } })
    expect(document.metadata).toMatchObject({ uploadedFile: { name: 'private-sample.md', size: Buffer.byteLength(content) } })
  })

  it('公共来源必须先审批且具备原文存储权，才能受控导入并生成统计画像', async () => {
    const source = await prisma.corpusSource.create({ data: {
      name: '受控导入测试来源', sourceClass: 'licensed', rightsHolder: '测试权利方', license: 'Test-Commercial',
      commercialUse: true, redistribution: false, modification: true, rawStorageAllowed: true, indexAllowed: true,
      rightsStatus: 'pending', rightsEvidence: '测试合同与授权范围。',
    } })
    const content = '周谨把合同翻到违约条款，没有抬头。他让财务先算最坏情形，再问对方愿意用什么交换三天账期。会议室里的争执因此从态度变成了数字。'.repeat(60)
    await expect(importCorpusDocument({
      adminId: userId, sourceId: source.id, document: { title: '待审批文档', content, metadata: {} },
    })).rejects.toMatchObject({ code: 'CORPUS_SOURCE_NOT_APPROVED' })
    await prisma.corpusSource.update({ where: { id: source.id }, data: { rightsStatus: 'approved', auditedAt: new Date() } })
    const imported = await importCorpusDocument({
      adminId: userId, sourceId: source.id, document: { title: '已审批文档', authorName: '测试作者', content, metadata: { batch: 'integration' } },
    })
    expect(imported.passageCount).toBeGreaterThan(1)
    expect(imported.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(await prisma.corpusPassage.count({ where: { documentId: imported.documentId } })).toBe(imported.passageCount)
    expect((await prisma.corpusPassage.aggregate({ where: { documentId: imported.documentId }, _max: { charCount: true } }))._max.charCount).toBeLessThanOrEqual(1_600)
    expect(await prisma.styleProfile.findUniqueOrThrow({ where: { id: imported.styleProfileId } })).toMatchObject({
      sourceId: source.id, documentId: imported.documentId, kind: 'corpus', confirmed: true,
    })
  })

  it('已审批原文命中时阻断并只保存 hash/指标；作者自己的私有样章不参与版权阻断', async () => {
    const licensedText = '电梯停在没有编号的楼层。门开以后，走廊里的灯依次熄灭，只剩安全出口的绿光贴在地面上。'
    const licensed = await prisma.corpusSource.create({ data: {
      name: '测试授权短文', sourceClass: 'licensed', rightsHolder: '测试权利方', license: 'Test-Commercial',
      commercialUse: true, redistribution: false, modification: true, rawStorageAllowed: true, indexAllowed: true,
      rightsStatus: 'approved', rightsEvidence: '仅测试数据库使用。', auditedAt: new Date(),
    } })
    const document = await prisma.corpusDocument.create({ data: {
      sourceId: licensed.id, title: '测试文档', contentHash: randomUUID().replaceAll('-', ''), rawStorageAllowed: true,
      indexAllowed: true, status: 'indexed', passages: { create: {
        ordinal: 0, content: licensedText, contentHash: randomUUID().replaceAll('-', ''), charCount: licensedText.length,
      } },
    } })
    expect(document.status).toBe('indexed')
    const blocked = await checkStyleLeakage({ userId, novelId, runId, chapterId: chapterIds[0], content: `开头。${licensedText}结尾。` })
    expect(blocked.decision).toBe('blocked')
    expect(blocked.longestCommonSubstring).toBeGreaterThanOrEqual(licensedText.length)
    const persisted = await prisma.leakageCheck.findUniqueOrThrow({ where: { id: blocked.id } })
    expect(persisted.outputHash).toMatch(/^[a-f0-9]{64}$/)
    expect(persisted.evidenceHash).toMatch(/^[a-f0-9]{64}$/)
    expect(persisted).not.toHaveProperty('content')

    const ownSentence = '林舟把报表推回桌心，没有解释自己为什么拒绝。'
    const own = await checkStyleLeakage({ userId, novelId, runId, content: ownSentence.repeat(3) })
    expect(own.decision).toBe('passed')
  })

  it('作者撤权会删除原文、派生画像与索引，并返回不可变删除回执', async () => {
    const response = await request(app).delete(`/api/agent/novels/${novelId}/corpus-sources/${privateSourceId}`).set('Cookie', cookie).send({ reason: '不再希望该样章参与 Style DNA。' })
    expect(response.status).toBe(200)
    expect(response.body.data.receipt.receiptHash).toMatch(/^[a-f0-9]{64}$/)
    expect(await prisma.corpusPassage.count({ where: { document: { sourceId: privateSourceId } } })).toBe(0)
    expect(await prisma.styleProfile.count({ where: { sourceId: privateSourceId } })).toBe(0)
    expect(await prisma.techniqueCard.count({ where: { sourceId: privateSourceId } })).toBe(0)
    expect((await prisma.corpusSource.findUniqueOrThrow({ where: { id: privateSourceId } })).rightsStatus).toBe('revoked')
  })
})
