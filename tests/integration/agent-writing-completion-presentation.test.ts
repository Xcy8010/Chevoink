import { createHash, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { verifyTestDatabase } from '../support/database-preflight.js'
import { isTestDatabaseRequired } from '../support/database-availability.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { readCompilerContinuitySource } from '../../api/lib/agent/compiler-continuity-source.js'
import { readChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
import { freezeWritingScope, readCompletedWritingPresentation, completedWritingPresentationText, assertCompletedWritingDelivery } from '../../api/lib/agent/writing-scope.js'

const available = await verifyTestDatabase(isTestDatabaseRequired())
afterAll(() => prisma.$disconnect())
const json = (value: unknown) => runtimeJson(JSON.parse(JSON.stringify(value))).value
const prompt = '只修改第3章，第1、2章不要改。完成后简要总结，不要在聊天中重复正文。'
const body = '北岸闸门只开了半尺。阿岚把手停在铁链上，等守闸人的回答。'

async function fixture(work: (f: Awaited<ReturnType<typeof seed>>) => Promise<void>) {
  const userId = randomUUID()
  try {
    const f = await seed(userId)
    const earlier = await prisma.chapter.findMany({ where: { authorId: userId, orderIndex: { in: [1, 2] } }, orderBy: { orderIndex: 'asc' } })
    await work(f)
    expect(await prisma.chapter.findMany({ where: { authorId: userId, orderIndex: { in: [1, 2] } }, orderBy: { orderIndex: 'asc' } })).toEqual(earlier)
    expect(await prisma.aiUsageLog.count({ where: { userId } })).toBe(0)
  } finally {
    await prisma.agentRun.deleteMany({ where: { userId } })
    await prisma.agentSession.deleteMany({ where: { userId } })
    await prisma.chapter.deleteMany({ where: { authorId: userId } })
    await prisma.novel.deleteMany({ where: { authorId: userId } })
    await prisma.user.deleteMany({ where: { id: userId } })
  }
}

async function seed(userId: string) {
  await prisma.user.create({ data: { id: userId, nickname: 'synthetic-presentation', passwordHash: 'test-only' } })
  const novel = await prisma.novel.create({ data: { authorId: userId, title: '合成展示测试', slug: randomUUID(), summary: '' } })
  const volume = await prisma.volume.create({ data: { novelId: novel.id, title: '卷一', orderIndex: 1 } })
  const chapters = []
  for (const orderIndex of [1, 2, 3]) chapters.push(await prisma.chapter.create({ data: { authorId: userId, novelId: novel.id, volumeId: volume.id,
    orderIndex, orderInVolume: orderIndex, title: `合成章节${orderIndex}`, content: orderIndex === 3 ? body : `前章保留内容${orderIndex}。`, revision: orderIndex === 3 ? 6 : 1 } }))
  const chapter = chapters[2]
  const session = await prisma.agentSession.create({ data: { userId, novelId: novel.id, title: 'synthetic-presentation' } })
  const run = await prisma.agentRun.create({ data: { userId, novelId: novel.id, sessionId: session.id, chapterId: chapter.id,
    engine: 'loop', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'running', startRequest: { prompt } } })
  const subject = { userId, novelId: novel.id, runId: run.id }
  const spec = await prisma.$transaction(tx => freezeWritingScope(tx, subject, buildTaskSpec({ ...subject, chapterId: chapter.id, prompt }), prompt, 1))
  expect(spec.scope.writing?.targets).toEqual([{ orderIndex: 3, chapterId: chapter.id }])
  await prisma.agentRun.update({ where: { id: run.id }, data: { taskSpec: json(spec) } })
  const compilation = await prisma.storyCompilation.create({ data: { ...subject, chapterId: chapter.id, targetOrderIndex: 3,
    mode: 'balanced', status: 'completed', stage: 'commit', sourcePromptHash: runtimeJson(prompt).hash,
    preparedContext: { terminalContentHash: runtimeJson({ content: chapter.content }).hash }, completedAt: new Date() } })
  const bridge = await prisma.chapterBridge.create({ data: { userId, novelId: novel.id, compilationId: compilation.id, fromChapterId: chapters[1].id,
    sourceRevision: chapters[1].revision, toChapterId: chapter.id, targetRevision: chapter.revision, targetOrderIndex: 3, committedAt: new Date(),
    knowledgeState: [], bodyState: [], objectState: [], relationshipState: [], emotionAftermath: [], recentOpenings: [], recentEndings: [], openLoops: [] } })
  await prisma.sceneTask.create({ data: { userId, novelId: novel.id, compilationId: compilation.id, chapterId: chapter.id, ordinal: 1, status: 'completed',
    purpose: '等待守闸人回应', entryState: {}, goal: '确认开闸范围', obstacle: '铁链仍绷紧', choice: '停手等待', cost: '失去抢先过闸的机会',
    turn: '等对方回答', exitState: {}, styleBudget: {} } })
  const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } } } })
  const source = await prisma.$transaction(tx => readCompilerContinuitySource(tx, subject, chapter, bridge.fromChapterId))
  await prisma.storyCompilation.update({ where: { id: compilation.id }, data: { validation: json({ independentCheck: 'complete', checkedChapterId: chapter.id,
    checkedRevision: chapter.revision, checkRounds: 1, autoRepairRounds: 0, errorCount: 0, warningCount: 0, findings: [],
    coverage: compilerContinuityCoverage({ chapter, bridge: saved.bridge, sceneTasks: saved.sceneTasks, source }) }) } })
  const report = await prisma.chapterQualityReport.create({ data: { ...subject, compilationId: compilation.id, chapterId: chapter.id,
    chapterRevision: chapter.revision, status: 'passed', deterministicMetrics: { independentCheck: 'complete', contentHash: createHash('sha256').update(chapter.content).digest('hex') } } })
  expect(await prisma.$transaction(tx => readChapterReviewReadiness(tx, subject, compilation.id))).toMatchObject({
    ready: true, continuity: 'complete', quality: 'complete', decisionPending: false, qualityReportId: report.id,
  })
  return { ...subject, sessionId: session.id, chapter, compilation, report }
}

describe.skipIf(!available)('current committed writing presentation snapshots', () => {
  it('persists a supported natural summary without appending internal receipts or changing protected earlier chapters', () => fixture(async f => {
    const delivery = await prisma.$transaction(tx => readCompletedWritingPresentation(tx, f))
    expect(delivery).not.toBeNull()
    const text = completedWritingPresentationText(delivery!, '已提交r6。正文改为「北岸闸门开了整整一尺」。\n\n结尾保留等待回答的停顿。')
    expect(text).not.toContain('整整一尺')
    expect(text).toContain('结尾保留等待回答的停顿。')
    expect(text).not.toContain('章节终态已提交')
    expect(text).not.toContain('（r6）')
    await prisma.$transaction(async tx => {
      await assertCompletedWritingDelivery(tx, f, delivery!)
      await tx.agentMessage.create({ data: { runId: f.runId, sessionId: f.sessionId, role: 'assistant', parts: [{ type: 'text', text }] } })
    })
    const saved = await prisma.agentMessage.findFirstOrThrow({ where: { runId: f.runId, role: 'assistant' } })
    expect(saved.parts).toEqual([{ type: 'text', text }])
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapter.id } })).content).toBe(body)
  }))
  it.each(['revision', 'report', 'commit'] as const)('rejects a captured completion after %s changes without persisting a success fallback', scenario => fixture(async f => {
    const delivery = await prisma.$transaction(tx => readCompletedWritingPresentation(tx, f))
    expect(delivery).not.toBeNull()
    if (scenario === 'revision') await prisma.chapter.update({ where: { id: f.chapter.id }, data: { content: `${body}新修订。`, revision: { increment: 1 } } })
    else if (scenario === 'report') await prisma.chapterQualityReport.create({ data: { userId: f.userId, novelId: f.novelId, runId: f.runId,
      compilationId: f.compilation.id, chapterId: f.chapter.id, chapterRevision: f.chapter.revision, status: 'passed',
      createdAt: new Date(f.report.createdAt.getTime() + 1000), deterministicMetrics: json(f.report.deterministicMetrics) } })
    else await prisma.storyCompilation.update({ where: { id: f.compilation.id }, data: { preparedContext: { terminalContentHash: runtimeJson({ content: body }).hash, changed: true } } })
    await expect(prisma.$transaction(async tx => {
      await assertCompletedWritingDelivery(tx, f, delivery!)
      await tx.agentMessage.create({ data: { runId: f.runId, sessionId: f.sessionId, role: 'assistant', parts: [{ type: 'text', text: 'unverified success' }] } })
    })).rejects.toMatchObject({ code: 'WRITING_DELIVERY_STALE' })
    expect(await prisma.agentMessage.count({ where: { runId: f.runId, role: 'assistant' } })).toBe(0)
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).status).toBe('running')
  }))
})
