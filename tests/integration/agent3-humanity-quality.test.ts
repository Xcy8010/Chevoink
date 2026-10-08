import { randomInt, randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'

import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import app from '../../api/app.js'
import {
  analyzeDeterministicQuality,
  applyQualityRepair,
  getQualityReport,
  persistHumanityQualityReport,
  saveCharacterVoiceProfile,
  saveExperienceAnchor,
  selectQualityFindings,
  resolveQualityChapterTarget,
  qualityCompilationScope,
  hasCommittedTaskChapter,
} from '../../api/lib/agent/humanity-quality.js'
import { prisma } from '../../api/lib/prisma.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { buildQualityEvidenceSources, inspectCriticResponse } from '../../api/lib/agent/quality-evidence.js'

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)

afterAll(async () => {
  await prisma.$disconnect().catch(() => {})
})

describe.skipIf(!dbAvailable)('Agent 3.0 人类感质量门（需 DB）', () => {
  let userId = ''
  let novelId = ''
  let chapterId = ''
  let runId = ''
  let cookie = ''

  beforeAll(async () => {
    const unique = randomInt(0, 10_000_000).toString().padStart(7, '0')
    const phone = `+861374${unique}`
    const register = await request(app).post('/api/auth/register').send({ phone, nickname: `质量门测试${unique}`, password: 'Humanity-Gate-123!' })
    expect(register.status).toBe(201)
    const cookies = Array.isArray(register.headers['set-cookie']) ? register.headers['set-cookie'] : [register.headers['set-cookie']]
    cookie = cookies.find((item: string) => item?.startsWith('chevoink_session=')) as string
    userId = (await prisma.user.findUniqueOrThrow({ where: { phone }, select: { id: true } })).id
    const novel = await request(app).post('/api/novels').set('Cookie', cookie).send({ title: '人类感质量门测试', summary: '验证证据化批评与局部修订。', tags: ['悬疑'] })
    expect(novel.status).toBe(201)
    novelId = novel.body.data.novel.id as string
    const volumeId = (await prisma.volume.findFirstOrThrow({ where: { novelId }, select: { id: true } })).id
    chapterId = randomUUID()
    const content = '他感到无比悲伤。顾棠说：“别碰那把钥匙。”“看着我。”“现在走。”她闻到消毒水时会把拇指压进旧伤。'
    await prisma.chapter.create({ data: { id: chapterId, novelId, authorId: userId, volumeId, orderIndex: 1, orderInVolume: 1, title: '第一章 钥匙', content, wordCount: content.length, revision: 1, status: 'draft', visibility: 'private' } })
    const session = await prisma.agentSession.create({ data: { userId, novelId, title: 'P3 质量测试' } })
    runId = (await prisma.agentRun.create({ data: { sessionId: session.id, userId, novelId, chapterId, mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'running', engine: 'loop' } })).id
  })

  it('原合同续跑可读取编译；同会话的新任务不能继承编译权限', async () => {
    const source = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
    const originalSpec = buildTaskSpec({ runId, novelId, chapterId, prompt: '完成本章写作' })
    const resumeId = randomUUID()
    await prisma.agentRun.update({ where: { id: runId }, data: { taskSpec: originalSpec } })
    const compilation = await prisma.storyCompilation.create({ data: { userId, novelId, runId, chapterId, targetOrderIndex: 1, sourcePromptHash: 'scope-test', preparedContext: {} } })
    try {
      await prisma.agentRun.create({ data: { id: resumeId, userId, novelId, sessionId: source.sessionId, mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', taskSpec: { ...originalSpec, runId: resumeId } } })
      expect(await resolveQualityChapterTarget({ userId, novelId, runId: resumeId, compilationId: compilation.id, fallbackChapterId: 'old-editor' })).toBe(chapterId)
      const scope = await qualityCompilationScope(prisma, userId, novelId, resumeId)
      expect(await prisma.storyCompilation.count({ where: { id: compilation.id, userId, novelId, ...scope } })).toBe(1)
      expect(await hasCommittedTaskChapter(prisma, userId, novelId, resumeId)).toBe(false)
      const revision = (await prisma.chapter.findUniqueOrThrow({ where: { id: chapterId }, select: { revision: true } })).revision
      await prisma.chapterBridge.create({ data: { userId, novelId, compilationId: compilation.id, toChapterId: chapterId, targetOrderIndex: 1, targetRevision: revision,
        committedAt: new Date(), knowledgeState: {}, bodyState: {}, objectState: {}, relationshipState: {}, emotionAftermath: {}, recentOpenings: [], recentEndings: [], openLoops: [] } })
      await prisma.storyCompilation.update({ where: { id: compilation.id }, data: { status: 'completed', stage: 'commit' } })
      expect(await hasCommittedTaskChapter(prisma, userId, novelId, resumeId)).toBe(true)
      await prisma.chapterBridge.update({ where: { compilationId: compilation.id }, data: { targetRevision: revision - 1 } })
      expect(await hasCommittedTaskChapter(prisma, userId, novelId, resumeId)).toBe(false)
      await prisma.chapterBridge.update({ where: { compilationId: compilation.id }, data: { targetRevision: revision } })
      await prisma.agentRun.update({ where: { id: resumeId }, data: { taskSpec: buildTaskSpec({ runId: resumeId, novelId, prompt: '分析另一章' }) } })
      expect(await hasCommittedTaskChapter(prisma, userId, novelId, resumeId)).toBe(false)
      await expect(resolveQualityChapterTarget({ userId, novelId, runId: resumeId, compilationId: compilation.id })).rejects.toMatchObject({ code: 'QUALITY_TARGET_AMBIGUOUS' })
    } finally {
      await prisma.storyCompilation.delete({ where: { id: compilation.id } })
      await prisma.agentRun.deleteMany({ where: { id: resumeId } })
      await prisma.agentRun.update({ where: { id: runId }, data: { taskSpec: source.taskSpec ?? Prisma.DbNull } })
    }
  })

  it('确认版 Voice DNA 与 Experience Anchor 必须绑定逐字章节证据', async () => {
    const profile = await saveCharacterVoiceProfile(userId, novelId, {
      characterName: '顾棠', vocabularyLevel: '短句、日常词，不主动解释', sentenceLength: { short: 3, long: 18 },
      addressSystem: ['林舟'], pressureResponse: '先沉默，再用问题转移', avoidedTopics: ['钥匙来源'], attentionBias: ['出口', '手部动作'],
      voiceSamples: [
        { text: '“别碰那把钥匙。”', sourceChapterId: chapterId, sourceRevision: 1 },
        { text: '“看着我。”', sourceChapterId: chapterId, sourceRevision: 1 },
        { text: '“现在走。”', sourceChapterId: chapterId, sourceRevision: 1 },
      ], forbiddenKnowledge: ['林舟父亲的最终去向'], evolutionNotes: '', confirmed: true,
    })
    expect(profile.status).toBe('confirmed')
    const anchor = await saveExperienceAnchor(userId, novelId, {
      characterName: '顾棠', title: '医院旧伤', triggerEvent: '闻到消毒水', concreteDetail: '她闻到消毒水时会把拇指压进旧伤。', sensoryCue: '消毒水',
      habitualResponse: '拇指压住旧伤', emotionalMeaning: '用疼痛压住失控记忆', sourceType: 'chapter', sourceId: chapterId, sourceRevision: 1,
    })
    expect(anchor.sourceRevision).toBe(1)
    await expect(saveCharacterVoiceProfile(userId, novelId, {
      characterName: '林舟', vocabularyLevel: '克制', sentenceLength: { short: 3, long: 18 }, addressSystem: [], pressureResponse: '沉默', avoidedTopics: [], attentionBias: [],
      voiceSamples: [
        { text: '正文中不存在的台词', sourceChapterId: chapterId, sourceRevision: 1 },
        { text: '另一个不存在的台词', sourceChapterId: chapterId, sourceRevision: 1 },
        { text: '第三个不存在的台词', sourceChapterId: chapterId, sourceRevision: 1 },
      ], forbiddenKnowledge: [], evolutionNotes: '', confirmed: true,
    })).rejects.toMatchObject({ code: 'VOICE_SAMPLE_EVIDENCE_INVALID' })
  })

  it('丢弃无法逐字定位的 Critic 意见，并在局部修订后保留独立作者反馈', async () => {
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: chapterId } })
    const deterministic = analyzeDeterministicQuality(chapter.content)
    const first = await persistHumanityQualityReport({
      userId, novelId, runId, chapterId, chapterRevision: chapter.revision, mode: 'balanced',
      deterministicMetrics: deterministic.metrics, deterministicFindings: deterministic.findings, criticComplete: true,
      criticFindings: [
        { signal: 'emotion_grounding', severity: 'warning', quote: '他感到无比悲伤。', explanation: '情绪只有标签，没有选择或后果。', suggestion: '用一个与父亲有关的具体回避动作替换。', confidence: 0.91 },
        { signal: 'orphaned_sophistication', severity: 'warning', quote: '正文里根本不存在的华丽句', explanation: '幻觉证据。', suggestion: '不应入库。', confidence: 0.99 },
      ],
    })
    expect(first.findings).toHaveLength(1)
    const findingId = first.findings[0].id
    const feedback = await request(app).post(`/api/agent/quality-findings/${findingId}/feedback`).set('Cookie', cookie).send({ accepted: true, reason: '确实太抽象' })
    expect(feedback.status).toBe(200)
    const reportState = await request(app).get(`/api/agent/quality-reports/${first.id}`).set('Cookie', cookie)
    expect(reportState.status).toBe(200)
    expect(reportState.body.data.report.findings[0].authorFeedback).toBe('accepted')
    expect(reportState.body.data.report).not.toHaveProperty('chapter')
    await selectQualityFindings(userId, novelId, first.id, [findingId])
    const repaired = await applyQualityRepair({ userId, novelId, reportId: first.id, replacements: [{ findingId, replacement: '林舟把钥匙塞回袖口，没再问父亲的事。' }] })
    expect(repaired.updated.revision).toBe(2)
    expect(repaired.after).toContain('没再问父亲的事')
    const after = await getQualityReport(userId, novelId, first.id)
    expect(after.findings[0]).toMatchObject({ disposition: 'repaired', authorFeedback: 'accepted' })
  })

  it('局部修订绑定最新 revision，新检查重置修订预算且同报告内阻止第二轮自动循环', async () => {
    const secondChapter = await prisma.chapter.findUniqueOrThrow({ where: { id: chapterId } })
    const second = await persistHumanityQualityReport({
      userId, novelId, runId, chapterId, chapterRevision: secondChapter.revision, mode: 'balanced', deterministicMetrics: {}, deterministicFindings: [], criticComplete: true,
      criticFindings: [{ signal: 'reader_pull', severity: 'warning', quote: '林舟把钥匙塞回袖口，没再问父亲的事。', explanation: '动作没有改变当下关系。', suggestion: '让动作落到当前场景选择。', confidence: 0.8 }],
    })
    // 新检查 = 新报告：修订预算重置为 0，不再继承旧报告已用轮次（否则新 revision 上的新检查会被直接熔断成工具失败）
    expect(second.repairRound).toBe(0)
    await selectQualityFindings(userId, novelId, second.id, [second.findings[0].id])
    const repaired = await applyQualityRepair({ userId, novelId, reportId: second.id, replacements: [{ findingId: second.findings[0].id, replacement: '林舟把钥匙塞回袖口，转身去关窗。' }] })
    expect(repaired.updated.revision).toBe(secondChapter.revision + 1)
    // 同一报告内第二轮自动修订仍硬熔断（单次检查单次修订，防空转循环）
    await expect(applyQualityRepair({ userId, novelId, reportId: second.id, replacements: [{ findingId: second.findings[0].id, replacement: '林舟把钥匙塞回袖口，转身去关窗。' }] })).rejects.toMatchObject({ code: 'QUALITY_REPAIR_LIMIT' })
  })
  it('persists failed critic audit and authentic partial evidence without changing the saved manuscript', async () => {
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: chapterId } })
    const sources = buildQualityEvidenceSources({ userId, novelId, chapterId, chapterRevision: chapter.revision }, chapter.content)
    const valid = { sourceId: sources.entries[0].id, signal: 'emotion_grounding', severity: 'advisory', explanation: '真实位置，待作者判断', suggestion: '保留人物声音' }
    const raw = JSON.stringify({ findings: [valid, { ...valid, sourceId: 'foreign' }] })
    const inspected = inspectCriticResponse(raw, sources)
    const report = await persistHumanityQualityReport({ userId, novelId, runId, chapterId, chapterRevision: chapter.revision, mode: 'premium',
      sources, deterministicMetrics: {}, deterministicFindings: [], criticFindings: inspected.findings, criticComplete: inspected.complete,
      criticDropped: inspected.diagnostic.droppedFindings, criticResponseDiagnostic: { ...inspected.diagnostic, callId: 'native-legacy-critic' } })
    expect(report).toMatchObject({ status: 'failed', repairRound: 0, deterministicMetrics: { independentCheck: 'unavailable',
      droppedFindings: 1, criticFindingCount: 1, criticResponse: { version: 1, callId: 'native-legacy-critic', classification: 'source_invalid', findingCount: 2, invalidSources: 1 } } })
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0].evidenceExcerpt).toBe(sources.entries[0].text)
    expect(report.deterministicMetrics).not.toHaveProperty('rawResponse')
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapterId } })).toEqual(chapter)
  })
  it('persists identical critic evidence at distinct offsets and repairs only the selected occurrence', async () => {
    const original = await prisma.chapter.findUniqueOrThrow({ where: { id: chapterId } })
    const content = '他笑了。\n他笑了。'
    const chapter = await prisma.chapter.create({ data: { novelId, authorId: userId, volumeId: original.volumeId,
      orderIndex: 99, orderInVolume: 99, title: '重复位置', content, wordCount: content.length, revision: 1 } })
    const sources = buildQualityEvidenceSources({ userId, novelId, chapterId: chapter.id, chapterRevision: 1 }, content)
    const occurrences = sources.entries.filter(entry => entry.text === '他笑了。')
    expect(occurrences).toHaveLength(2)
    const findings = occurrences.map(entry => ({ sourceId: entry.id, signal: 'emotion_grounding', severity: 'warning',
      quote: entry.text, explanation: '此处人物反应需结合动作判断。', suggestion: '让这一处反应更具体。', confidence: 0.9 }))
    const report = await persistHumanityQualityReport({ userId, novelId, chapterId: chapter.id, chapterRevision: 1,
      mode: 'balanced', deterministicMetrics: {}, deterministicFindings: [], criticComplete: true, sources,
      criticFindings: [...findings, findings[0]] })
    expect(report.findings).toHaveLength(2)
    expect(new Set(report.findings.map(finding => finding.evidenceHash)).size).toBe(1)
    expect(new Set(report.findings.map(finding => finding.startOffset)).size).toBe(2)
    const target = report.findings.find(finding => finding.startOffset > 0)!
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...duplicate } = target
    await expect(prisma.qualityFinding.create({ data: duplicate })).rejects.toMatchObject({ code: 'P2002' })
    await selectQualityFindings(userId, novelId, report.id, [target.id])
    const repaired = await applyQualityRepair({ userId, novelId, reportId: report.id,
      replacements: [{ findingId: target.id, replacement: '他别过脸。' }] })
    expect(repaired.after).toBe('他笑了。\n他别过脸。')
  })

})
