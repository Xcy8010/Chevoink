import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { randomInt, randomUUID } from 'node:crypto'
import { persistCurrentContinuityReport } from '../support/current-continuity-report.js'
import { z } from 'zod'
import { saveStoryMemory, deleteStoryMemoryEntry } from '../../api/lib/agent/story-memory.js'

import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import app from '../../api/app.js'
import { prisma } from '../../api/lib/prisma.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'
import { chapterReadTool } from '../../api/lib/agent/tools/read-tools.js'
import { chapterBridgeGetTool, storyCompilerPrepareTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { resolveQualityChapterTarget, persistHumanityQualityReport } from '../../api/lib/agent/humanity-quality.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { freezeWritingScope, readCompletedWritingDelivery, assertCompletedWritingDelivery } from '../../api/lib/agent/writing-scope.js'
import { chapterCreateTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { withHumanAdmission } from '../../api/lib/agent/goal-activation-authority.js'
import { readChapterReviewReadiness } from '../../api/lib/agent/chapter-review-guard.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import {
  commitChapterBridge,
  prepareStoryCompilation,
  recordStoryCompilerWrite,
  saveReaderPromise,
  saveSceneTasks,
  upsertStoryCharter,
  validatedContinuityCheckRounds,
  continuityRepairRounds,
  continuityCheckRounds,
  buildStoryCompilerDigest,
} from '../../api/lib/agent/story-compiler.js'

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)

afterAll(async () => {
  await prisma.$disconnect().catch(() => {})
})

describe.skipIf(!dbAvailable)('Agent 3.0 Story Compiler 与 Chapter Bridge（需 DB）', () => {
  let userId = ''
  let novelId = ''
  let volumeId = ''
  let chapter1Id = ''
  let chapter2Id = ''
  let chapter3Id = ''
  let runId = ''

  beforeAll(async () => {
    const unique = randomInt(0, 10_000_000).toString().padStart(7, '0')
    const phone = `+861373${unique}`
    const register = await request(app).post('/api/auth/register')
      .send({ phone, nickname: `故事编译测试${unique}`, password: 'Story-Compiler-123!' })
    expect(register.status).toBe(201)
    const cookies = Array.isArray(register.headers['set-cookie']) ? register.headers['set-cookie'] : [register.headers['set-cookie']]
    const cookie = cookies.find((item: string) => item?.startsWith('chevoink_session=')) as string
    userId = (await prisma.user.findUniqueOrThrow({ where: { phone }, select: { id: true } })).id
    const novel = await request(app).post('/api/novels').set('Cookie', cookie)
      .send({ title: '章节桥测试作品', summary: '验证章节终态向下一章传递。', tags: [] })
    expect(novel.status).toBe(201)
    novelId = novel.body.data.novel.id as string
    volumeId = (await prisma.volume.findFirstOrThrow({ where: { novelId }, select: { id: true } })).id
    chapter1Id = randomUUID()
    chapter2Id = randomUUID()
    chapter3Id = randomUUID()
    await prisma.chapter.createMany({ data: [
      { id: chapter1Id, novelId, authorId: userId, volumeId, orderIndex: 1, orderInVolume: 1, title: '第一章 雨塔', content: '林舟在雨塔找到铜钥匙。门外的脚步停住，他还没来得及转身。', wordCount: 31, status: 'draft', visibility: 'private', revision: 1 },
      { id: chapter2Id, novelId, authorId: userId, volumeId, orderIndex: 2, orderInVolume: 2, title: '第二章 门后', content: '', wordCount: 0, status: 'draft', visibility: 'private', revision: 1 },
      { id: chapter3Id, novelId, authorId: userId, volumeId, orderIndex: 3, orderInVolume: 3, title: '第三章 回声', content: '', wordCount: 0, status: 'draft', visibility: 'private', revision: 1 },
    ] })
    const session = await prisma.agentSession.create({ data: { userId, novelId, title: 'Story Compiler 测试' } })
    const run = await prisma.agentRun.create({
      data: { sessionId: session.id, userId, novelId, chapterId: chapter2Id, mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'running', engine: 'loop' },
    })
    runId = run.id
    const prompt = '授权自主创作全书，并修改已有章节。'
    await prisma.agentRun.update({ where: { id: runId }, data: { startRequest: { prompt },
      taskSpec: buildTaskSpec({ runId, novelId, chapterId: chapter2Id, prompt, mode: 'build' }) } })
  })

  it('keeps a fresh next-chapter contract separate from old and already-contaminated compilations', async () => {
    const { sessionId } = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId }, select: { sessionId: true } })
    const freshId = randomUUID()
    let task = buildTaskSpec({ runId: freshId, novelId, chapterId: null, prompt: '写下一章', mode: 'build' })
    await prisma.agentRun.create({ data: { id: freshId, sessionId, userId, novelId, chapterId: chapter1Id, mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'running', engine: 'loop', runtimeProtocolVersion: 0, startRequest: { prompt: '写下一章' }, taskSpec: task } })
    task = await prisma.$transaction(tx => freezeWritingScope(tx, { userId, novelId, runId: freshId }, task, '写下一章'))
    await prisma.agentRun.update({ where: { id: freshId }, data: { taskSpec: task } })
    const old = await prepareStoryCompilation({ userId, novelId, runId, chapterId: chapter1Id, mode: 'balanced', intentSummary: '检查原章节' })
    const original = await prisma.chapter.findUniqueOrThrow({ where: { id: chapter1Id } })
    const ctx: ToolContext = { userId, novelId, runId: freshId, chapterId: chapter1Id, sessionId, callId: 'next', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'premium', emit: () => {}, signal: new AbortController().signal }
    expect((await chapterBridgeGetTool.execute(ctx, { compilationId: old.compilation.id })).outcome).toBe('failed')
    // Reproduce the already-persisted historical bug: the new contract owns an
    // old-chapter compilation. Ownership alone must not legalize that target.
    await prisma.storyCompilation.update({ where: { id: old.compilation.id }, data: { runId: freshId } })
    expect((await chapterBridgeGetTool.execute(ctx, { compilationId: old.compilation.id })).outcome).toBe('failed')
    expect((await buildStoryCompilerDigest(userId, novelId, chapter1Id, freshId)) ?? '').not.toContain(old.compilation.id)
    for (const target of [{ chapterId: chapter1Id }, { fallbackChapterId: chapter1Id }, { compilationId: old.compilation.id }]) {
      await expect(resolveQualityChapterTarget({ userId, novelId, runId: freshId, ...target })).rejects.toMatchObject({ code: 'QUALITY_TASK_TARGET_REQUIRED' })
    }
    await expect(prepareStoryCompilation({ userId, novelId, runId: freshId, chapterId: chapter1Id, mode: 'balanced', intentSummary: '恢复旧章' })).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
    await storyCompilerPrepareTool.execute(ctx, { intentSummary: '写下一章', volumeDecision: { kind: 'continue', reason: '当前卷主困局尚未收束，新目标继续原卷' } })
    const fresh = await prisma.storyCompilation.findFirstOrThrow({ where: { runId: freshId, chapterId: null } })
    expect(fresh.targetOrderIndex).toBe(4)
    const preparedDigest = await buildStoryCompilerDigest(userId, novelId, chapter1Id, freshId)
    expect(preparedDigest).toContain('Scene Task 0 个')
    expect(preparedDigest).toContain('下一步调用 scene_task_build')
    expect(preparedDigest).not.toContain('不重复 PREPARE/BEAT')
    expect(preparedDigest).toContain('不能宣称该章已写完或完成')
    expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: old.compilation.id } })).status).toBe('active')
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapter1Id } })).toEqual(original)
    // A real new chapter created during this contract remains available from a
    // typed continuation in the same session, without adopting unrelated tasks.
    const created = await chapterCreateTool.execute(ctx, { title: '第四章 新目标', position: 4 })
    const ownChapter = await prisma.chapter.findUniqueOrThrow({ where: { id: (created.display as { chapterId: string }).chapterId } })
    await prisma.storyCompilation.update({ where: { id: fresh.id }, data: { chapterId: ownChapter.id } })
    const continuationId = randomUUID()
    await prisma.agentRun.create({ data: { id: continuationId, sessionId, userId, novelId, chapterId: chapter1Id, mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'running', engine: 'loop', runtimeProtocolVersion: 0, taskSpec: { ...task, runId: continuationId } } })
    const continued = await chapterBridgeGetTool.execute({ ...ctx, runId: continuationId }, { compilationId: fresh.id })
    expect(continued.outcome).not.toBe('failed')
    expect(await resolveQualityChapterTarget({ userId, novelId, runId: continuationId, chapterId: ownChapter.id })).toBe(ownChapter.id)
    expect(await resolveQualityChapterTarget({ userId, novelId, runId: continuationId, fallbackChapterId: chapter1Id })).toBe(ownChapter.id)
    // Keep the shared fixture's original chapter count/order intact.
    await prisma.storyCompilation.deleteMany({ where: { runId: { in: [freshId, continuationId] } } })
    await prisma.chapter.delete({ where: { id: ownChapter.id } })
  })

  it('reads an explicit whole-book chapter number without guessing IDs and never substitutes the editor chapter', async () => {
    const ctx: ToolContext = { userId, novelId, runId, chapterId: chapter2Id, sessionId: '', callId: 'read',
      mode: 'build', creativeFreedom: 'balanced', qualityMode: 'premium', emit: () => {}, signal: new AbortController().signal }
    const found = await chapterReadTool.execute(ctx, { chapterOrder: 1 })
    expect(found.observedState).toMatchObject({ id: chapter1Id })
    expect(found.output).toContain('铜钥匙')
    for (const args of [{ chapterId: 'stale-id' }, { chapterId: chapter1Id, chapterOrder: 2 }, { chapterOrder: 99 }]) {
      const failure = await chapterReadTool.execute(ctx, args)
      expect(failure.outcome).toBe('failed')
      expect(failure.summary).toBe('章节标识已失效或不匹配')
      expect(failure.observedState).toBeUndefined()
    }
    const foreign = await chapterReadTool.execute({ ...ctx, userId: 'another-user' }, { chapterOrder: 1 })
    expect(foreign.outcome).toBe('failed')
    expect(foreign.output).not.toContain('铜钥匙')
    const missing = await chapterReadTool.execute({ ...ctx, chapterId: null }, {})
    expect(missing.summary).toBe('未指定要读取的章节')
  })

  it('并发复用真实报告，旧修订记录保留且不阻断重新准备后的当前检查', async () => {
    const input = { userId, novelId, runId, chapterId: chapter3Id, mode: 'balanced' as const, intentSummary: '检查修订上限' }
    await prisma.chapter.update({ where: { id: chapter3Id }, data: { content: '林舟沿着雪原寻找信号源。', wordCount: 12, revision: { increment: 1 } } })
    const prepared = await prepareStoryCompilation(input)
    await prisma.storyCompilation.update({ where: { id: prepared.compilation.id }, data: { validation: { autoRepairRounds: 1, checkRounds: 3 } } })
    const first = await persistCurrentContinuityReport({ userId, novelId, runId, compilationId: prepared.compilation.id })
    const attempts = await Promise.all(Array.from({ length: 4 }, () => persistCurrentContinuityReport({ userId, novelId, runId, compilationId: prepared.compilation.id })))
    for (const attempt of attempts) {
      expect(attempt.result).toMatchObject({ reviewCompleted: true })
      expect(attempt.result.output).toContain('复用已保存报告')
      expect(attempt.validation).toMatchObject({ continuityReport: { rawResponses: ['{"findings":[]}'], usageIds: [] } })
    }
    const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: prepared.compilation.id } })
    expect(continuityRepairRounds(saved.validation)).toBe(1)
    const beforeReprepare = saved.validation
    const rePrepared = await prepareStoryCompilation(input)
    const reused = await persistCurrentContinuityReport({ userId, novelId, runId, compilationId: rePrepared.compilation.id })
    expect(reused.result.output).toContain('复用已保存报告')
    expect(reused.validation).toMatchObject({ continuityReport: z.object({ continuityReport: z.object({ id: z.string(), contentHash: z.string() }) }).parse(first.validation).continuityReport })
    expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: prepared.compilation.id } })).validation).toEqual(beforeReprepare)
    await expect(prisma.$transaction(tx => readChapterReviewReadiness(tx, { userId, novelId, runId }, rePrepared.compilation.id))).resolves.toMatchObject({ continuity: 'complete', quality: 'missing', terminalCommitted: false })
  })

  it('历史次数不关闭当前报告；并发缓存保留意见，实际修订后才检查新版', async () => {
    // 先补齐正文与场景任务，使确定性检查不产生干扰误差，额度语义只由 findings 决定。
    await prisma.chapter.update({ where: { id: chapter3Id }, data: { content: '林舟左臂受伤，转眼却说左臂从未受过伤。', wordCount: 21, revision: { increment: 1 } } })
    const input = { userId, novelId, runId, chapterId: chapter3Id, mode: 'balanced' as const, intentSummary: '检查连续性检查额度' }
    const prepared = await prepareStoryCompilation(input)
    await saveSceneTasks({ userId, novelId, compilationId: prepared.compilation.id, tasks: [{
      purpose: '验证累计检查额度保留，不进入真实写作。', entryState: { action: '林舟在雪原上出发' },
      goal: '找到信号源', obstacle: '大雪封路', choice: '绕行或折返', cost: '多走半天', turn: '发现第二把钥匙',
      exitState: { action: '林舟收起钥匙' }, styleBudget: { description: 'low', dialogue: 'low', rhetoric: 'low' },
    }] })
    await prisma.storyCompilation.update({ where: { id: prepared.compilation.id }, data: { validation: { checkRounds: 5 } } })
    await persistCurrentContinuityReport({ userId, novelId, runId, compilationId: prepared.compilation.id, opinions: snapshot => [{ signal: 'body', severity: 'error',
      explanation: '同段把左臂写成受伤和从未受伤。', suggestion: '保留已经发生的伤势。', evidence: [{ sourceId: snapshot.sources[0].table.entries[0].id.slice(0, 13) }] }] })
    const afterError = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: prepared.compilation.id } })
    expect(continuityCheckRounds(afterError.validation)).toBe(5)
    const attempts = await Promise.all(Array.from({ length: 4 }, () => persistCurrentContinuityReport({ userId, novelId, runId, compilationId: prepared.compilation.id })))
    for (const attempt of attempts) expect(attempt.validation).toMatchObject({ errorCount: 1, continuityReport: { findings: [{ severity: 'error' }] } })
    await prisma.chapter.update({ where: { id: chapter3Id }, data: { content: '林舟左臂仍旧受伤，他收好齿纹不同的第二把钥匙。', revision: { increment: 1 } } })
    await persistCurrentContinuityReport({ userId, novelId, runId, compilationId: prepared.compilation.id })
    const afterPass = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: prepared.compilation.id } })
    expect(continuityCheckRounds(afterPass.validation)).toBe(5)
    expect(afterPass.validation).toMatchObject({ errorCount: 0, continuityReport: { complete: true, findings: [] } })
    const next = await prepareStoryCompilation(input)
    expect((await persistCurrentContinuityReport({ userId, novelId, runId, compilationId: next.compilation.id })).result.output).toContain('复用已保存报告')
    expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: prepared.compilation.id } })).validation).toEqual(afterPass.validation)
  })

  it.each([-1, '3', 1.5, Number.MAX_SAFE_INTEGER])('历史reader拒绝异常计数 %s，当前检查保留原值且不受旧计数限制', async checkRounds => {
    const original = await prisma.storyCompilation.findFirstOrThrow({ where: { runId, chapterId: chapter3Id, status: 'active' }, orderBy: { createdAt: 'desc' } })
    const invalid = { checkRounds, autoRepairRounds: 1 }
    await prisma.storyCompilation.update({ where: { id: original.id }, data: { validation: invalid } })
    try {
      expect(() => validatedContinuityCheckRounds(invalid, true)).toThrow(expect.objectContaining({ code: 'RUNTIME_RECEIPT_INVALID' }))
      const checked = await persistCurrentContinuityReport({ userId, novelId, runId, compilationId: original.id })
      expect(checked.result).toMatchObject({ reviewCompleted: true })
      expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: original.id } })).validation).toMatchObject({ ...invalid, continuityReport: { complete: true } })
    } finally { await prisma.storyCompilation.update({ where: { id: original.id }, data: { validation: original.validation! } }) }
  })

  it('建立作品宪章和读者承诺，并以不可逆哈希保存写作意图', async () => {
    const charter = await upsertStoryCharter(userId, novelId, {
      oneLinePromise: '一个只相信证据的人，被迫追查会改写记忆的雨塔。',
      targetAudience: '偏人物驱动的都市悬疑读者', targetPlatform: 'Chevoink',
      protagonistDesire: '证明父亲失踪不是意外', protagonistFear: '自己的记忆同样不可靠',
      protagonistMisbelief: '只要证据完整就不需要相信任何人', protagonistNonNegotiable: '不拿无辜者做诱饵',
      conflictEngine: '每个证据会解决一个局部谜团，同时动摇一段更核心的记忆。',
      relationshipEngine: '林舟需要顾棠的证词，却越来越怀疑她参与过记忆改写。',
      genreRules: ['异常必须留下可复核物证'], abilityCosts: ['读取旧物记忆会遗失自己的当天细节'],
      realityBoundaries: ['警方流程按现实约束'], emotionalBaseline: '克制、警觉', emotionalRange: '信任建立后允许短暂失控',
      styleDna: ['短场景推进', '对话承担冲突'], forbiddenZones: ['无代价开挂'], antiExamples: ['用大段雨景代替行动'],
    })
    await saveReaderPromise(userId, novelId, { title: '父亲失踪真相', promise: '揭示父亲为何主动进入雨塔。', payoffHorizon: '第一卷末', priority: 90 })
    expect(charter.revision).toBe(1)

    const intentSummary = '续写第二章，让林舟开门后发现脚步来自顾棠。'
    const prepared = await prepareStoryCompilation({ userId, novelId, runId, chapterId: chapter2Id, mode: 'balanced', intentSummary })
    expect(prepared.charter?.oneLinePromise).toContain('雨塔')
    expect(prepared.promises[0]).toMatchObject({ title: '父亲失踪真相', status: 'open' })
    expect(prepared.compilation.sourcePromptHash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(prepared.compilation)).not.toContain(intentSummary)
    expect(prepared.compilation.stage).toBe('prepare')
  })

  it('按真实正文和当前双报告提交，并向下一章提供实际前文而不认证自由文本终态', async () => {
    const compilation = await prisma.storyCompilation.findFirstOrThrow({ where: { runId, chapterId: chapter2Id, status: 'active' }, orderBy: { createdAt: 'desc' } })
    const tasks = await saveSceneTasks({
      userId, novelId, compilationId: compilation.id,
      tasks: [{
        purpose: '让林舟发现门外人是顾棠，同时确认她知道铜钥匙。',
        entryState: { action: '林舟正要转身', location: '雨塔二层', storyTime: '当夜', knowledge: ['林舟不知道脚步是谁'], emotion: ['警觉'], body: [], objects: ['铜钥匙在林舟手中'], relationships: ['林舟尚未信任顾棠'], openLoops: ['顾棠为何知道铜钥匙'] },
        goal: '确认门外来者身份', obstacle: '顾棠拒绝解释自己为何跟踪', choice: '交出铜钥匙换答案，或假装没有找到',
        cost: '撒谎会进一步破坏合作', turn: '顾棠准确说出钥匙齿纹上的缺口',
        exitState: { action: '两人暂时同行下塔', location: '雨塔楼梯', storyTime: '当夜', knowledge: ['林舟知道顾棠见过同类钥匙'], emotion: ['怀疑加深但压住追问'], body: [], objects: ['铜钥匙仍在林舟手中'], relationships: ['暂时合作'], openLoops: ['顾棠在哪里见过钥匙'] },
        styleBudget: { description: 'low', dialogue: 'high', rhetoric: 'low' },
      }],
    })
    expect(tasks).toHaveLength(1)
    expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).stage).toBe('beat')

    const chapter2 = await prisma.chapter.update({
      where: { id: chapter2Id },
      data: { content: '门外是顾棠。她没有看林舟，只盯着他掌心的铜钥匙，说出了齿纹缺口的位置。林舟把钥匙收回袖中，跟她一起下楼。', wordCount: 55, revision: { increment: 1 } },
    })
    await recordStoryCompilerWrite({ userId, novelId, runId, chapterId: chapter2.id, chapterOrderIndex: 2, chapterRevision: chapter2.revision })
    expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).stage).toBe('write')

    const checked = await persistCurrentContinuityReport({ userId, novelId, runId, compilationId: compilation.id, expectedChapterRevision: chapter2.revision })
    expect(checked.validation).toMatchObject({ errorCount: 0, continuityReport: { complete: true, revision: chapter2.revision } })
    await persistHumanityQualityReport({ userId, novelId, runId, compilationId: compilation.id, chapterId: chapter2.id,
      chapterRevision: chapter2.revision, mode: 'balanced', criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
    const beforeBridge = await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: compilation.id } })
    const deletedMemory = await saveStoryMemory({ userId, novelId, sourceChapterId: chapter2.id,
      memoryType: 'chapterSummary', layer: 'L2', title: chapter2.title, content: '作者不要的旧摘要',
      importance: 70, confidence: 1, status: 'confirmed',
      evidence: { sourceType: 'chapter', sourceId: chapter2.id, revision: chapter2.revision, confidence: 1 } })
    await deleteStoryMemoryEntry(userId, deletedMemory.id, 1)
    const terminal = {
      userId, novelId, compilationId: compilation.id,
      chapterSummary: '顾棠现身并证明自己知道铜钥匙细节，林舟压住怀疑与她暂时同行。',
      exitState: { action: '林舟与顾棠一起下塔', location: '雨塔楼梯', storyTime: '当夜', knowledge: ['林舟知道顾棠见过同类钥匙'], emotion: ['怀疑加深但暂时压住'], body: [], objects: ['铜钥匙在林舟袖中'], relationships: ['林舟与顾棠暂时合作'], openLoops: ['顾棠在哪里见过铜钥匙'] },
      lastUnfinishedAction: '两人正在下塔，尚未抵达一层', hookDecision: '下一章立即承接楼梯上的异常回声', delayedHookReason: '',
      openingStructure: '动作承接开篇', endingStructure: '同行动作未完成收尾',
    }
    const result = await commitChapterBridge(terminal)
    expect(result.skippedMemoryCount).toBe(1)
    expect(await prisma.projectMemoryEntry.findUniqueOrThrow({ where: { id: deletedMemory.id } })).toMatchObject({ status: 'invalid' })
    expect(await prisma.projectMemoryEntry.count({ where: { novelId, memoryType: 'chapterSummary', title: chapter2.title } })).toBe(1)
    expect(await prisma.projectMemoryEntry.findFirstOrThrow({ where: { novelId, title: `${chapter2.title}终态` } })).toMatchObject({ reviewStatus: 'pending', status: 'inferred' })
    const committed = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true, sceneTasks: true } })
    expect(committed).toMatchObject({ stage: 'commit', status: 'completed' })
    expect(committed.bridge?.targetRevision).toBe(chapter2.revision)
    expect(committed.preparedContext).toMatchObject({ terminalContentHash: runtimeJson({ content: chapter2.content }).hash })
    expect(committed.bridge).toMatchObject({ knowledgeState: beforeBridge.knowledgeState, objectState: beforeBridge.objectState, openLoops: beforeBridge.openLoops })
    expect(committed.sceneTasks[0].status).toBe('completed')

    const nextRun = await prisma.agentRun.create({
      data: { sessionId: (await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).sessionId, userId, novelId, chapterId: chapter3Id, mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'running', engine: 'loop', startRequest: { prompt: '修改第三章' } },
    })
    await prisma.agentRun.update({ where: { id: nextRun.id }, data: { taskSpec: buildTaskSpec({ runId: nextRun.id, novelId, chapterId: chapter3Id, prompt: '修改第三章', mode: 'build' }) } })
    const next = await prepareStoryCompilation({ userId, novelId, runId: nextRun.id, chapterId: chapter3Id, mode: 'balanced', intentSummary: '续写第三章。' })
    expect(next.compilation.bridge).toMatchObject({ fromChapterId: chapter2.id, sourceRevision: chapter2.revision })
    expect(next.compilation.preparedContext).toMatchObject({ previousChapter: { id: chapter2.id, revision: chapter2.revision, ending: chapter2.content } })
    expect(next.bridge.knowledgeState).toEqual(committed.bridge!.knowledgeState)
    expect(next.bridge.objectState).toEqual(committed.bridge!.objectState)
    runId = nextRun.id
  })

  it('实际前文变化会使旧报告失效；真实改稿后仍须复核最终正文', async () => {
    const compilation = await prisma.storyCompilation.findFirstOrThrow({ where: { runId, chapterId: chapter3Id, status: 'active' } })
    await saveSceneTasks({
      userId, novelId, compilationId: compilation.id,
      tasks: [{
        purpose: '承接下塔动作并让异常回声暴露新位置。', entryState: { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] },
        goal: '抵达一层', obstacle: '楼梯回声总比脚步多一次', choice: '停下确认或继续撤离', cost: '停下会被追上', turn: '多出的回声来自上方而不是下方',
        exitState: { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }, styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' },
      }],
    })
    const chapter3 = await prisma.chapter.update({ where: { id: chapter3Id }, data: { content: '两人沿楼梯下行，头顶却多出一声脚步。', wordCount: 19, revision: { increment: 1 } } })
    await recordStoryCompilerWrite({ userId, novelId, runId, chapterId: chapter3.id, chapterOrderIndex: 3, chapterRevision: chapter3.revision })
    const assessed = await persistCurrentContinuityReport({ userId, novelId, runId, compilationId: compilation.id, expectedChapterRevision: chapter3.revision })
    expect(assessed.validation).toMatchObject({ errorCount: 0, continuityReport: { complete: true } })
    await persistHumanityQualityReport({ userId, novelId, runId, compilationId: compilation.id, chapterId: chapter3.id,
      chapterRevision: chapter3.revision, mode: 'balanced', criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
    await prisma.chapter.update({ where: { id: chapter2Id }, data: { content: { set: '用户在第三章写作期间修改了第二章结尾。' }, revision: { increment: 1 } } })
    await expect(prisma.$transaction(tx => readChapterReviewReadiness(tx, { userId, novelId, runId }, compilation.id))).resolves.toMatchObject({ continuity: 'stale', terminalCommitted: false })
    await expect(commitChapterBridge({
      userId, novelId, compilationId: compilation.id, chapterSummary: '测试',
      exitState: { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] },
      lastUnfinishedAction: '', hookDecision: '', delayedHookReason: '', openingStructure: '动作', endingStructure: '悬念',
    })).rejects.toMatchObject({ code: 'CONTINUITY_CHECK_REQUIRED' })

    const repaired = await prisma.chapter.update({ where: { id: chapter3Id }, data: { content: { set: '根据最新章尾，两人停在楼梯转角，头顶多出一声脚步。' }, revision: { increment: 1 } } })
    await recordStoryCompilerWrite({ userId, novelId, runId, chapterId: repaired.id, chapterOrderIndex: 3, chapterRevision: repaired.revision })
    expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).stage).toBe('repair')
  })
  it('blocks unchecked text, reuses the checked terminal, and rechecks a corrected revision on the same compiler', async () => {
    const sessionId = (await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).sessionId
    const chapter = await prisma.chapter.create({ data: { novelId, authorId: userId, volumeId, orderIndex: 4, orderInVolume: 4,
      title: '第四章 停在门前', content: '她握住门把手，停在询问价格之前。', wordCount: 17, status: 'draft', visibility: 'private' } })
    const run = await prisma.agentRun.create({ data: { sessionId, userId, novelId, chapterId: chapter.id, mode: 'act', action: 'workspaceAgent',
      agentType: 'writingOrchestrator', status: 'running', engine: 'loop', startRequest: { prompt: '完成第四章，只要标题和正文。' } } })
    const spec = await prisma.$transaction(tx => freezeWritingScope(tx, { userId, novelId, runId: run.id },
      buildTaskSpec({ runId: run.id, novelId, chapterId: chapter.id, prompt: '完成第四章，只要标题和正文。', mode: 'build' }), '完成第四章，只要标题和正文。'))
    await prisma.agentRun.update({ where: { id: run.id }, data: { taskSpec: spec } })
    const displayRuns: string[] = []
    try {
      const { compilation } = await prepareStoryCompilation({ userId, novelId, runId: run.id, chapterId: chapter.id, mode: 'balanced', intentSummary: '完成第四章，只要标题和正文。' })
      const terminal = { userId, novelId, runId: run.id, compilationId: compilation.id, chapterSummary: '停在询问之前。',
        exitState: { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] },
        lastUnfinishedAction: '', hookDecision: '', delayedHookReason: '', openingStructure: '动作', endingStructure: '停在提问之前' }
      await expect(commitChapterBridge(terminal)).rejects.toMatchObject({ code: 'CONTINUITY_CHECK_REQUIRED' })
      expect(await prisma.$transaction(tx => readCompletedWritingDelivery(tx, { userId, novelId, runId: run.id }))).toBeNull()
      expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).status).toBe('active')
      await saveSceneTasks({ userId, novelId, compilationId: compilation.id, tasks: [{ purpose: '推进门前选择', goal: '进门', obstacle: '不知价格',
        choice: '握住门把手', cost: '暂缓询问', turn: '停住动作', entryState: terminal.exitState, exitState: terminal.exitState,
        styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' } }] })
      const completeChecks = async () => {
        const current = await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })
        await persistCurrentContinuityReport({ userId, novelId, runId: run.id, compilationId: compilation.id, expectedChapterRevision: current.revision })
        await expect(commitChapterBridge(terminal)).rejects.toMatchObject({ code: 'QUALITY_CHECK_REQUIRED' })
        await persistHumanityQualityReport({ userId, novelId, runId: run.id, compilationId: compilation.id, chapterId: chapter.id,
          chapterRevision: current.revision, mode: 'balanced', criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
      }
      await completeChecks()
      const first = await commitChapterBridge({ ...terminal, expectedChapterRevision: chapter.revision,
        expectedContentHash: runtimeJson({ content: chapter.content }).hash })
      expect(first.chapterRevision).toBe(chapter.revision)
      const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true } })
      expect(saved.validation).toMatchObject({ checkedRevision: chapter.revision, independentCheck: 'complete', errorCount: 0 })
      expect(await prisma.$transaction(tx => readCompletedWritingDelivery(tx, { userId, novelId, runId: run.id }))).toMatchObject({
        text: `${chapter.title}\n\n${chapter.content}`, chapters: [{ id: chapter.id, revision: chapter.revision }] })
      expect(await prisma.chapterQualityReport.count({ where: { compilationId: compilation.id } })).toBe(1)
      const fullCapture = await prisma.$transaction(tx => readCompletedWritingDelivery(tx, { userId, novelId, runId: run.id }))
      const originalSaved = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id }, select: { startRequest: true, taskSpec: true } })
      for (const [prompt, fullText] of [['不要重复正文，只保存章节。', false], ['现在请贴出全文。', true]] as const) {
        const source = await prisma.agentRun.create({ data: { sessionId, userId, novelId, chapterId: chapter.id, mode: 'act', action: 'workspaceAgent',
          agentType: 'writingOrchestrator', status: 'completed', engine: 'loop', taskSpec: spec,
          startRequest: withHumanAdmission({ sessionId, novelId, chapterId: chapter.id, mode: 'build', prompt }) } })
        displayRuns.push(source.id)
        await prisma.agentMessage.create({ data: { runId: source.id, sessionId, role: 'user', parts: [{ type: 'text', text: prompt }] } })
        const delivery = await prisma.$transaction(tx => readCompletedWritingDelivery(tx, { userId, novelId, runId: run.id }))
        expect(delivery?.text).toBe(fullText ? `${chapter.title}\n\n${chapter.content}` : `已保存《${chapter.title}》。`)
        if (!fullText) await expect(prisma.$transaction(tx => assertCompletedWritingDelivery(tx, { userId, novelId, runId: run.id }, fullCapture!))).rejects.toMatchObject({ code: 'WRITING_DELIVERY_STALE' })
      }
      expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id }, select: { startRequest: true, taskSpec: true } })).toEqual(originalSaved)
      const repeated = await commitChapterBridge(terminal)
      expect(repeated).toEqual(first)
      expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true } })).bridge?.committedAt).toEqual(saved.bridge?.committedAt)
      const captured = await prisma.$transaction(tx => readCompletedWritingDelivery(tx, { userId, novelId, runId: run.id }))
      const memoryCount = await prisma.projectMemoryEntry.count({ where: { sourceChapterId: chapter.id } })
      await prisma.chapter.update({ where: { id: chapter.id }, data: { content: '同版本号下作者改变了正文。' } })
      expect(await prisma.$transaction(tx => readCompletedWritingDelivery(tx, { userId, novelId, runId: run.id }))).toBeNull()
      await expect(prisma.$transaction(tx => assertCompletedWritingDelivery(tx, { userId, novelId, runId: run.id }, captured!))).rejects.toMatchObject({ code: 'WRITING_DELIVERY_STALE' })
      await expect(commitChapterBridge(terminal)).rejects.toMatchObject({ code: 'CONTINUITY_CHECK_REQUIRED' })
      await completeChecks()
      await commitChapterBridge(terminal)
      expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).preparedContext).toMatchObject({ terminalContentHash: runtimeJson({ content: '同版本号下作者改变了正文。' }).hash })
      expect(await prisma.projectMemoryEntry.count({ where: { sourceChapterId: chapter.id } })).toBe(memoryCount)
      await prisma.storyCompilation.update({ where: { id: compilation.id }, data: { preparedContext: {} } })
      expect(await prisma.$transaction(tx => readCompletedWritingDelivery(tx, { userId, novelId, runId: run.id }))).toBeNull()
      await persistCurrentContinuityReport({ userId, novelId, runId: run.id, compilationId: compilation.id })
      await commitChapterBridge(terminal)
      expect(await prisma.projectMemoryEntry.count({ where: { sourceChapterId: chapter.id } })).toBe(memoryCount)
      const corrected = await prisma.chapter.update({ where: { id: chapter.id }, data: { content: '她松开门把手，依然没有询问价格。', revision: { increment: 1 } } })
      await expect(commitChapterBridge({ ...terminal, expectedChapterRevision: chapter.revision })).rejects.toMatchObject({ code: 'CONTINUITY_INPUT_STALE' })
      await completeChecks()
      const refreshed = await commitChapterBridge({ ...terminal, expectedChapterRevision: corrected.revision,
        expectedContentHash: runtimeJson({ content: corrected.content }).hash })
      expect(refreshed.chapterRevision).toBe(corrected.revision)
      expect(await prisma.storyCompilation.count({ where: { runId: run.id } })).toBe(1)
      expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true } })).validation)
        .toMatchObject({ checkedRevision: corrected.revision, independentCheck: 'complete', errorCount: 0 })
      expect((await prisma.chapter.findUniqueOrThrow({ where: { id: chapter.id } })).content).toBe(corrected.content)
      await prisma.agentRun.update({ where: { id: run.id }, data: { status: 'paused' } })
      await expect(commitChapterBridge(terminal)).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_MISMATCH' })
    } finally {
      await prisma.projectMemoryEntry.deleteMany({ where: { sourceChapterId: chapter.id } })
      await prisma.agentRun.deleteMany({ where: { id: { in: displayRuns } } })
      await prisma.agentRun.delete({ where: { id: run.id } })
      await prisma.chapter.delete({ where: { id: chapter.id } })
    }
  })

})
