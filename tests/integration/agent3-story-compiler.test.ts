import { randomInt, randomUUID } from 'node:crypto'
import { saveStoryMemory, deleteStoryMemoryEntry } from '../../api/lib/agent/story-memory.js'

import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import app from '../../api/app.js'
import { prisma } from '../../api/lib/prisma.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'
import { chapterReadTool } from '../../api/lib/agent/tools/read-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import {
  commitChapterBridge,
  prepareStoryCompilation,
  recordStoryCompilerWrite,
  saveReaderPromise,
  saveSceneTasks,
  upsertStoryCharter,
  validateStoryContinuity,
  reserveContinuityRepair,
  continuityRepairRounds,
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

  it('自动修订额度原子限一次，复核和重新准备不重置', async () => {
    const input = { userId, novelId, runId, chapterId: chapter3Id, mode: 'balanced' as const, intentSummary: '检查修订上限' }
    const prepared = await prepareStoryCompilation(input)
    const attempts = await Promise.all(Array.from({ length: 4 }, () => reserveContinuityRepair(userId, novelId, prepared.compilation.id)))
    expect(attempts.filter(Boolean)).toHaveLength(1)
    await validateStoryContinuity({ userId, novelId, compilationId: prepared.compilation.id, findings: [], independentCheck: 'complete' })
    const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: prepared.compilation.id } })
    expect(continuityRepairRounds(saved.validation)).toBe(1)
    const rePrepared = await prepareStoryCompilation(input)
    expect(continuityRepairRounds(rePrepared.compilation.validation)).toBe(1)
    expect(await reserveContinuityRepair(userId, novelId, rePrepared.compilation.id)).toBe(false)
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

  it('按 PREPARE→BEAT→WRITE→CHECK→COMMIT 落库，并向下一章传递终态', async () => {
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

    const checked = await validateStoryContinuity({ userId, novelId, compilationId: compilation.id, findings: [], independentCheck: 'complete', expectedChapterRevision: chapter2.revision })
    expect(checked.errorCount).toBe(0)
    const deletedMemory = await saveStoryMemory({ userId, novelId, sourceChapterId: chapter2.id,
      memoryType: 'chapterSummary', layer: 'L2', title: chapter2.title, content: '作者不要的旧摘要',
      importance: 70, confidence: 1, status: 'confirmed',
      evidence: { sourceType: 'chapter', sourceId: chapter2.id, revision: chapter2.revision, confidence: 1 } })
    await deleteStoryMemoryEntry(userId, deletedMemory.id, 1)
    const result = await commitChapterBridge({
      userId, novelId, compilationId: compilation.id,
      chapterSummary: '顾棠现身并证明自己知道铜钥匙细节，林舟压住怀疑与她暂时同行。',
      exitState: { action: '林舟与顾棠一起下塔', location: '雨塔楼梯', storyTime: '当夜', knowledge: ['林舟知道顾棠见过同类钥匙'], emotion: ['怀疑加深但暂时压住'], body: [], objects: ['铜钥匙在林舟袖中'], relationships: ['林舟与顾棠暂时合作'], openLoops: ['顾棠在哪里见过铜钥匙'] },
      lastUnfinishedAction: '两人正在下塔，尚未抵达一层', hookDecision: '下一章立即承接楼梯上的异常回声', delayedHookReason: '',
      openingStructure: '动作承接开篇', endingStructure: '同行动作未完成收尾',
    })
    expect(result.skippedMemoryCount).toBe(1)
    expect(await prisma.projectMemoryEntry.findUniqueOrThrow({ where: { id: deletedMemory.id } })).toMatchObject({ status: 'invalid' })
    expect(await prisma.projectMemoryEntry.count({ where: { novelId, memoryType: 'chapterSummary', title: chapter2.title } })).toBe(1)
    expect(await prisma.projectMemoryEntry.findFirstOrThrow({ where: { novelId, title: `${chapter2.title}终态` } })).toMatchObject({ reviewStatus: 'pending', status: 'inferred' })
    const committed = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id }, include: { bridge: true, sceneTasks: true } })
    expect(committed).toMatchObject({ stage: 'commit', status: 'completed' })
    expect(committed.bridge?.targetRevision).toBe(chapter2.revision)
    expect(committed.sceneTasks[0].status).toBe('completed')

    const nextRun = await prisma.agentRun.create({
      data: { sessionId: (await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).sessionId, userId, novelId, chapterId: chapter3Id, mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'running', engine: 'loop' },
    })
    const next = await prepareStoryCompilation({ userId, novelId, runId: nextRun.id, chapterId: chapter3Id, mode: 'balanced', intentSummary: '续写第三章。' })
    expect(next.bridge.lastUnfinishedAction).toContain('尚未抵达一层')
    expect(next.bridge.knowledgeState).toContain('林舟知道顾棠见过同类钥匙')
    expect(next.bridge.objectState).toContain('铜钥匙在林舟袖中')
    expect(next.bridge.openLoops).toContain('顾棠在哪里见过铜钥匙')
    runId = nextRun.id
  })

  it('来源 revision 过期会产生确定性错误；修补后进入 REPAIR 并需重新检查', async () => {
    const compilation = await prisma.storyCompilation.findFirstOrThrow({ where: { runId, chapterId: chapter3Id, status: 'active' } })
    await saveSceneTasks({
      userId, novelId, compilationId: compilation.id,
      tasks: [{
        purpose: '承接下塔动作并让异常回声暴露新位置。', entryState: { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] },
        goal: '抵达一层', obstacle: '楼梯回声总比脚步多一次', choice: '停下确认或继续撤离', cost: '停下会被追上', turn: '多出的回声来自上方而不是下方',
        exitState: { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }, styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' },
      }],
    })
    await prisma.chapter.update({ where: { id: chapter2Id }, data: { content: { set: '用户在第三章写作期间修改了第二章结尾。' }, revision: { increment: 1 } } })
    const chapter3 = await prisma.chapter.update({ where: { id: chapter3Id }, data: { content: '两人沿楼梯下行，头顶却多出一声脚步。', wordCount: 19, revision: { increment: 1 } } })
    await recordStoryCompilerWrite({ userId, novelId, runId, chapterId: chapter3.id, chapterOrderIndex: 3, chapterRevision: chapter3.revision })
    const stale = await validateStoryContinuity({ userId, novelId, compilationId: compilation.id, findings: [], independentCheck: 'complete', expectedChapterRevision: chapter3.revision })
    expect(stale.errorCount).toBeGreaterThan(0)
    expect(stale.findings.some((item) => item.evidence.includes('已从 r'))).toBe(true)
    await expect(commitChapterBridge({
      userId, novelId, compilationId: compilation.id, chapterSummary: '测试',
      exitState: { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] },
      lastUnfinishedAction: '', hookDecision: '', delayedHookReason: '', openingStructure: '动作', endingStructure: '悬念',
    })).rejects.toMatchObject({ code: 'CONTINUITY_ERRORS_REMAIN' })

    const repaired = await prisma.chapter.update({ where: { id: chapter3Id }, data: { content: { set: '根据最新章尾，两人停在楼梯转角，头顶多出一声脚步。' }, revision: { increment: 1 } } })
    await recordStoryCompilerWrite({ userId, novelId, runId, chapterId: repaired.id, chapterOrderIndex: 3, chapterRevision: repaired.revision })
    expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: compilation.id } })).stage).toBe('repair')
  })
})
