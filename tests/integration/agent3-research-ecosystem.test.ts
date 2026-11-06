import { integrationLegalConsent } from '../support/legal-consent.js'
import { randomInt, randomUUID } from 'node:crypto'

import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import app from '../../api/app.js'
import {
  buildFirstThreePrototype,
  buildResearchDossier,
  getLatestResearchDossier,
} from '../../api/lib/agent/research-dossier.js'
import { acceptSkillShareInvite, createSkillShareInvite } from '../../api/lib/agent/skills/sharing.js'
import { resolveEnabledRuntimeSkills } from '../../api/lib/agent/skills/service.js'
import { prisma } from '../../api/lib/prisma.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)

afterAll(async () => {
  await prisma.$disconnect().catch(() => {})
})

describe.skipIf(!dbAvailable)('Agent 3.0 研究、反馈与邀请共享闭环（需 DB）', () => {
  let ownerId = ''
  let recipientId = ''
  let novelId = ''
  let recipientNovelId = ''
  let cookie = ''

  beforeAll(async () => {
    const unique = randomInt(0, 10_000_000).toString().padStart(7, '0')
    const ownerPhone = `+861356${unique}`
    const recipientPhone = `+861346${unique}`
    const owner = await request(app).post('/api/auth/register').send({ ...await integrationLegalConsent(), phone: ownerPhone, nickname: `研究台作者${unique}`, password: 'Research-Test-123!' })
    const recipient = await request(app).post('/api/auth/register').send({ ...await integrationLegalConsent(), phone: recipientPhone, nickname: `技能接收者${unique}`, password: 'Research-Test-123!' })
    expect(owner.status).toBe(201)
    expect(recipient.status).toBe(201)
    cookie = (Array.isArray(owner.headers['set-cookie']) ? owner.headers['set-cookie'] : [owner.headers['set-cookie']]).find((item: string) => item?.startsWith('chevoink_session=')) as string
    const recipientCookie = (Array.isArray(recipient.headers['set-cookie']) ? recipient.headers['set-cookie'] : [recipient.headers['set-cookie']]).find((item: string) => item?.startsWith('chevoink_session=')) as string
    ownerId = (await prisma.user.findUniqueOrThrow({ where: { phone: ownerPhone }, select: { id: true } })).id
    recipientId = (await prisma.user.findUniqueOrThrow({ where: { phone: recipientPhone }, select: { id: true } })).id
    novelId = (await request(app).post('/api/novels').set('Cookie', cookie).send({ title: '研究台测试作品', summary: '一个法医在县城旧案中寻找失踪证人。', tags: ['悬疑'] })).body.data.novel.id
    recipientNovelId = (await request(app).post('/api/novels').set('Cookie', recipientCookie).send({ title: '接收技能作品', summary: '用于验证邀请安装。', tags: [] })).body.data.novel.id
    await prisma.storyCharter.create({ data: {
      userId: ownerId, novelId, oneLinePromise: '法医必须在旧案再次伤人前找到被遗漏的证人。', targetAudience: '偏现实的悬疑读者', targetPlatform: '连载平台',
      protagonistDesire: '证明旧案并未结束', protagonistFear: '自己的判断再次害人', protagonistMisbelief: '证据不会说谎', protagonistNonNegotiable: '不伪造鉴定',
      conflictEngine: '每次逼近证人都会触发旧案利益链的反制', relationshipEngine: '法医与基层刑警从互不信任到共同担责',
      genreRules: ['线索可回溯'], abilityCosts: ['每次违规取证都损害职业信用'], realityBoundaries: ['不虚构万能鉴定技术'], emotionalBaseline: '克制紧绷', emotionalRange: '从孤立到有限信任',
      styleDna: ['事件优先'], forbiddenZones: ['量子式伪科学'], antiExamples: ['用大段雨景替代调查推进'],
    } })
  })

  it('低频研究保存摘要来源并命中作品缓存，不会再次搜索', async () => {
    let searchCalls = 0
    const input = {
      triggerReason: 'new_book' as const,
      triggerSignals: ['新建作品只有一句题材描述'], topic: '县城法医旧案悬疑', genre: '现实悬疑', targetAudience: '偏现实的悬疑读者', targetPlatform: '连载平台',
      queries: ['法医职业流程 权威资料', '悬疑小说 读者弃书原因'], forceRefresh: false,
    }
    const search = async (query: string) => {
      searchCalls += 1
      return { provider: 'bocha' as const, results: [{ title: `${query}资料`, url: `https://example.com/${searchCalls}`, snippet: '公开资料摘要，只描述职业流程和读者期待。', source: 'example.com' }] }
    }
    const synthesize = async () => JSON.stringify({
      readerPromise: '在可核验职业细节中逐步翻转旧案结论。', abandonmentRisks: ['开篇只讲设定没有现场事件'], marketPatterns: ['前三章需要形成第一次证据反转'], differentiation: ['县城熟人社会让每条线索都带关系代价'],
      factCards: [{ claim: '鉴定结论需要说明检材与限制', confidence: 'medium', sourceIndexes: [1], storyUse: '让鉴定成为有边界的证据而非万能答案' }],
      languageRisks: ['避免铁锈味等模板感官词'], recommendations: ['第一章先发生一次具体检材争议'], rejectedIdeas: ['不使用万能黑客即时调档'],
    })
    const first = await buildResearchDossier(ownerId, novelId, null, input, undefined, { search, synthesize })
    const second = await buildResearchDossier(ownerId, novelId, null, input, undefined, { search: async () => { throw new Error('缓存命中时不应搜索') }, synthesize })
    expect(first).toMatchObject({ version: 1, searchCount: 2, reused: false })
    expect(second).toMatchObject({ id: first.id, version: 1, reused: true, reusedCount: 1 })
    expect(searchCalls).toBe(2)
    expect(JSON.stringify(first.sources)).not.toContain('小说正文')
    expect((await getLatestResearchDossier(ownerId, novelId))?.status).toBe('ready')
  })

  it('Story Charter 与有效 dossier 后才能建立恰好三章的试制资产', async () => {
    const prototype = await buildFirstThreePrototype(ownerId, novelId, {
      genreRisks: ['职业事实被万能化', '前三章只有氛围没有案件动作'],
      directions: [
        { id: 'a', title: '被退回的鉴定', readerPromise: '一份被退回的鉴定掀开旧案', conflictEngine: '职业程序与熟人关系持续冲突', differentiation: '每次查证都损失一段现实关系', risk: '程序描写过密' },
        { id: 'b', title: '失踪证人回信', readerPromise: '死去证人的账号再次发信', conflictEngine: '真假证词持续互证', differentiation: '每个数字痕迹都对应现实行动', risk: '容易落入监控万能' },
      ],
      selectedDirectionId: 'a',
      volumeSpine: ['鉴定被退回', '发现旧案检材缺口', '证人关系网反制'],
      chapterBlueprints: [1, 2, 3].map((orderIndex) => ({ orderIndex: orderIndex as 1 | 2 | 3, title: `试制第${orderIndex}章`, chapterJob: '推进一次可观察调查', concreteEvent: `完成第${orderIndex}次现场查证`, protagonistChoice: '保留争议检材并承担问责', cost: '失去同事支持', newInformation: '旧案时间戳不一致', exitHook: '证人主动来电', qualityRisks: ['避免环境描写挤占事件'] })),
    })
    expect(prototype).toMatchObject({ version: 1, status: 'ready', completedChapters: 0 })
    expect(prototype.chapterBlueprints).toHaveLength(3)
    const experiment = await prisma.writingExperiment.findFirstOrThrow({ where: { userId: ownerId, novelId, kind: 'first_three_direction' } })
    expect(experiment.subjectHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(experiment)).not.toContain('完成第1次现场查证')
  })

  it('作者可关闭匿名指标并撤回进行中的实验', async () => {
    const response = await request(app).patch(`/api/agent/novels/${novelId}/agent-data-control`).set('Cookie', cookie).send({ productAnalyticsEnabled: false, publicCorpusOptIn: false })
    expect(response.status).toBe(200)
    expect(response.body.data.dataControl).toMatchObject({ productAnalyticsEnabled: false, publicCorpusOptIn: false })
    expect(await prisma.writingExperiment.count({ where: { userId: ownerId, novelId, status: 'active' } })).toBe(0)
  })

  it('仅已审计发布技能可邀请共享，接收后按固定版本安装且不可编辑', async () => {
    const skillId = `share-test.${randomUUID()}`
    await prisma.agentSkillDefinition.create({ data: {
      id: skillId, ownerUserId: ownerId, name: '邀请制悬疑检查', description: '检查线索是否可回溯。', source: 'user', visibility: 'private', license: 'internal', status: 'active', defaultVersion: '1.0.0',
      versions: { create: { version: '1.0.0', instructions: { critique: '检查线索证据。' }, manifest: { description: '检查线索是否可回溯。', intents: ['review'], modes: ['review'], phases: ['critique'], priority: 70, tokenBudget: 300, triggerPhrases: ['检查线索'], negativeTriggerPhrases: ['只改标题'] }, contentHash: randomUUID().replaceAll('-', ''), status: 'active' } },
      audits: { create: { version: '1.0.0', status: 'passed', findings: [], manifestHash: randomUUID().replaceAll('-', ''), createdByUserId: ownerId } },
      evals: { create: [
        { version: '1.0.0', userId: ownerId, novelId, promptHash: randomUUID().replaceAll('-', ''), input: { expectMatch: true }, result: {}, passed: true },
        { version: '1.0.0', userId: ownerId, novelId, promptHash: randomUUID().replaceAll('-', ''), input: { expectMatch: false }, result: {}, passed: true },
      ] },
    } })
    const invite = await createSkillShareInvite({ userId: ownerId, novelId, skillId, recipientAccount: recipientId, message: '共同测试悬疑线索。' })
    expect(invite).toMatchObject({ status: 'pending', direction: 'sent', version: '1.0.0' })
    await acceptSkillShareInvite(recipientId, invite.id, recipientNovelId)
    const runtime = await resolveEnabledRuntimeSkills(recipientId, recipientNovelId)
    expect(runtime.some((skill) => skill.id === skillId)).toBe(true)
    const payload = await (await import('../../api/lib/agent/skills/service.js')).listNovelSkills(recipientId, recipientNovelId)
    expect(payload.items.find((skill) => skill.id === skillId)).toMatchObject({ enabled: true, activeVersion: '1.0.0', canEdit: false })
  })
})
