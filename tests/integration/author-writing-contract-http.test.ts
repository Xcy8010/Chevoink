import { randomUUID } from 'node:crypto'
import request from 'supertest'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../api/lib/agent/loop.js', () => ({ executeAgentRun: vi.fn(async () => {}) }))
vi.mock('../../api/lib/credits.js', () => ({ assertCreditAccess: vi.fn(async () => {}), getModelTierRuntime: vi.fn(async () => ({ reasoningEffort: 'high' })) }))
vi.mock('../../api/lib/agent/writing-experiments.js', () => ({ recordSevenDayContinuation: vi.fn(async () => {}) }))
import app from '../../api/app.js'
import { prisma } from '../../api/lib/prisma.js'
import { buildSessionTokens } from '../../api/lib/auth-session.js'
import { lockNovelActiveScope } from '../../api/lib/data/novel-write-lock.js'
import { chapterEditRangeTool, chapterWriteTool, chapterAppendTool, chapterCreateTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { storyCompilerPrepareTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { freezeWritingScope, readWritingScope } from '../../api/lib/agent/writing-scope.js'
import { taskSpecSchema } from '../../shared/contracts/index.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { verifyTestDatabase } from '../support/database-preflight.js'
import { isTestDatabaseRequired } from '../support/database-availability.js'
import { askUserTool } from '../../api/lib/agent/tools/interact-tools.js'
import * as questionPermissions from '../../api/lib/agent/permissions.js'
import { resolveLoopRunQuestion } from '../../api/lib/agent/run-service.js'
import { shortSceneRequest, firstChapterAnswer, placementQuestion } from '../support/writing-clarification-fixture.js'

const available = await verifyTestDatabase(isTestDatabaseRequired())
afterAll(() => prisma.$disconnect())
afterEach(() => vi.unstubAllGlobals())
const body = '钟声传来。甲说：“向左走。”乙听后却向右转。两人留在长廊，门还没开。'
const concerns = '已确认本章有动作方向冲突：甲说“向左走。”，紧接着却写“向右转”。请以最小改动让指令与动作一致。不新增设定。“钟声传来”保持不变。完成正常连续性和人类感检查。'
const requests = [
  '请只对第二卷第2章当前已保存正文做一次局部修订，不续写、不新建章节，不修改第1、2、3章。',
  '第二卷第2章当前已存正文，请做一次局部修订。先读取第1章作为参考，不修改第1、2、3章。',
  '先通读前两章；对第二卷第2章的正文进行局部修订，不修改前3章，不新建章节。',
]

async function fixture(prompt: string, work: (ctx: ToolContext, before: Awaited<ReturnType<typeof prisma.chapter.findMany>>) => Promise<void>, duplicate = false, targetBody = body) {
  const userId = randomUUID(), novelId = randomUUID(), sessionId = randomUUID()
  try {
    vi.stubGlobal('fetch', vi.fn(() => { throw Error('No Provider allowed in synthetic admission test') }))
    await prisma.user.create({ data: { id: userId, nickname: 'synthetic-author-contract', passwordHash: 'test-only' } })
    await prisma.novel.create({ data: { id: novelId, authorId: userId, title: '合成契约作品', slug: randomUUID(), summary: '' } })
    const volumes = []
    for (const orderIndex of [1, 2]) volumes.push(await prisma.volume.create({ data: { novelId, title: `合成卷${orderIndex}`, orderIndex } }))
    for (const orderIndex of [1, 2, 3, 4]) await prisma.chapter.create({ data: { novelId, authorId: userId,
      volumeId: volumes[orderIndex <= 2 ? 0 : 1].id, title: `合成章${orderIndex}`, orderIndex,
      orderInVolume: orderIndex <= 2 ? orderIndex : orderIndex - 2, revision: 4,
      content: orderIndex === 4 ? targetBody + (duplicate ? '又向右转。' : '') : `前章合成正文${orderIndex}。` } })
    const before = await prisma.chapter.findMany({ where: { novelId }, orderBy: { orderIndex: 'asc' } })
    await prisma.agentSession.create({ data: { id: sessionId, novelId, userId, title: '合成局部任务' } })
    const response = await request(app).post('/api/agent/runs')
      .set('Cookie', `chevoink_session=${buildSessionTokens(userId, 0).accessToken}`)
      .send({ novelId, sessionId, chapterId: before[0].id, prompt, mode: 'build' })
    expect(response.status).toBe(200)
    const runId = response.body.data.runId as string
    await prisma.agentRun.update({ where: { id: runId }, data: { status: 'running' } })
    await work({ userId, novelId, sessionId, runId, chapterId: before[0].id, callId: 'synthetic-contract', mode: 'build',
      creativeFreedom: 'balanced', qualityMode: 'premium', emit: () => {}, signal: new AbortController().signal }, before)
    expect(await prisma.aiUsageLog.count({ where: { userId } })).toBe(0)
    expect(await prisma.creditLedgerEntry.count({ where: { userId } })).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    await prisma.$transaction(async tx => {
      await lockNovelActiveScope(tx, novelId)
      await tx.memoryExtractionJob.deleteMany({ where: { novelId } })
      await tx.projectMemoryEntry.deleteMany({ where: { novelId } })
      await tx.agentArtifact.deleteMany({ where: { run: { userId, novelId } } })
      await tx.agentRun.deleteMany({ where: { userId } })
      await tx.agentSession.deleteMany({ where: { userId } })
      await tx.chapter.deleteMany({ where: { novelId, authorId: userId } })
      await tx.novel.deleteMany({ where: { id: novelId, authorId: userId } })
      await tx.user.deleteMany({ where: { id: userId } })
    })
  }
}
const prepare = (ctx: ToolContext) => storyCompilerPrepareTool.execute(ctx, { targetOrderIndex: 4,
  intentSummary: '只对第四个已存合成章作作者指出的局部修订', volumeDecision: { kind: 'continue', reason: '原卷原章' } })

describe.skipIf(!available)('unified fresh HTTP author contract with actual PostgreSQL writes', () => {
  it.each(requests)('binds a qualified chapter and two local islands without touching read-context chapters: %s', start => fixture(start + concerns, async (ctx, before) => {
    const original = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec)
    expect(original).toMatchObject({ intent: 'revise', scope: { writingTargetProtocol: 2,
      writing: { kind: 'bounded', targets: [{ chapterId: before[3].id, orderIndex: 4, volumeId: before[3].volumeId, positionInVolume: 2 }] },
      writingInterpretation: { version: 2, intent: 'revise', excludedChapterIds: expect.arrayContaining(before.slice(0, 3).map(chapter => chapter.id)) },
      localEditBoundary: { version: 2, kind: 'bounded', regions: [{ text: '向左走。' }, { text: '向右转' }] } } })
    expect(original.scope.writing?.targets).toHaveLength(1)
    expect((await prepare(ctx)).outcome).not.toBe('failed')
    const first = await chapterEditRangeTool.execute({ ...ctx, callId: 'first-local-patch' },
      { chapterId: before[3].id, oldText: '向左走。', newText: '请向右走。' })
    expect(first.outcome).not.toBe('failed')
    const second = await chapterEditRangeTool.execute({ ...ctx, callId: 'second-local-patch' },
      { chapterId: before[3].id, oldText: '向右转', newText: '往右侧走' })
    expect(second.outcome).not.toBe('failed')
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: before[3].id } })).content)
      .toBe(body.replace('向左走。', '请向右走。').replace('向右转', '往右侧走'))
    expect(await prisma.chapter.findMany({ where: { id: { in: before.slice(0, 3).map(chapter => chapter.id) } }, orderBy: { orderIndex: 'asc' } })).toEqual(before.slice(0, 3))
    const saved = await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })
    expect(await prisma.$transaction(tx => freezeWritingScope(tx, ctx, original, '重写全书', 2))).toEqual(original)
    expect((await prisma.$transaction(tx => readWritingScope(tx, ctx))).writing).toEqual(original.scope.writing)
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec).toEqual(saved.taskSpec)
  }))
  it.each(['cross-gap', 'whole', 'append', 'growth', 'prior', 'create'] as const)('denies %s without any partial chapter or compilation effect', kind => fixture(requests[0] + concerns, async (ctx, before) => {
    const target = before[3]
    const action = kind === 'whole' ? chapterWriteTool.execute(ctx, { chapterId: target.id, content: '替换全章。' })
      : kind === 'append' ? chapterAppendTool.execute(ctx, { chapterId: target.id, content: '新尾段。' })
      : kind === 'create' ? chapterCreateTool.execute(ctx, { title: '新第五章', volumeOrder: 2, positionInVolume: 3 })
      : chapterEditRangeTool.execute(ctx, { chapterId: kind === 'prior' ? before[0].id : target.id,
        oldText: kind === 'prior' ? before[0].content : kind === 'cross-gap' ? '向左走。”乙听后却向右转' : '向右转',
        newText: kind === 'growth' ? '整章内容'.repeat(300) : '未授权改动' })
    await expect(action).rejects.toMatchObject({ code: kind === 'create' ? 'AUTHOR_CHAPTER_SCOPE' : 'AUTHOR_LOCAL_SCOPE' })
    expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
    expect(await prisma.storyCompilation.count({ where: { runId: ctx.runId } })).toBe(0)
  }))
  it.each(['只补写第4章第二段', '只补齐第4章第二段', '请只补写第4章当前正文的第二段'])(
    'keeps write-family paragraph work local through actual HTTP admission: %s', prompt => fixture(prompt, async (ctx, before) => {
      const spec = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec)
      expect(spec.scope.localEditBoundary).toMatchObject({ kind: 'bounded', regions: [{ chapterId: before[3].id, start: 4, end: 7 }] })
      await expect(chapterWriteTool.execute(ctx, { chapterId: before[3].id, content: '不得扩大为整章替换。' })).rejects.toMatchObject({ code: 'AUTHOR_LOCAL_SCOPE' })
      expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
      expect((await chapterEditRangeTool.execute(ctx, { chapterId: before[3].id, oldText: '第二段', newText: '第二段修正' })).outcome).not.toBe('failed')
      expect((await prisma.chapter.findUniqueOrThrow({ where: { id: before[3].id } })).content).toBe('第一段\n第二段修正\n第三段')
      expect(await prisma.chapter.findMany({ where: { id: { in: before.slice(0, 3).map(chapter => chapter.id) } }, orderBy: { orderIndex: 'asc' } })).toEqual(before.slice(0, 3))
    }, false, '第一段\n第二段\n第三段'))
  it('keeps the chapter identity when only its local quotation is ambiguous', () => fixture(requests[0] + concerns, async (ctx, before) => {
    const spec = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec)
    expect(spec).toMatchObject({ ambiguity: 'must_ask', scope: { writing: { kind: 'bounded', targets: [{ chapterId: before[3].id }] },
      localEditBoundary: { kind: 'needs_input', regions: [] }, writingInterpretation: { reasons: expect.arrayContaining(['LOCAL_ANCHOR_UNRESOLVED']) } } })
    await expect(prepare(ctx)).rejects.toMatchObject({ code: 'AUTHOR_LOCAL_SCOPE' })
    await expect(chapterEditRangeTool.execute(ctx, { chapterId: before[3].id, oldText: '向左走。', newText: '向右走。' }))
      .rejects.toMatchObject({ code: 'AUTHOR_LOCAL_SCOPE' })
    expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
  }, true))
  it.each(['完成第二卷第2章质量检查，判断是否需要局部修订。', '请阅读这句：“修改第二卷第2章”。'])(
    'does not promote review or quoted data into a chapter mutation: %s', prompt => fixture(prompt, async (ctx, before) => {
      await expect(chapterWriteTool.execute(ctx, { chapterId: before[3].id, content: '不能改写。' })).rejects.toBeTruthy()
      expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
    }))
  it.each(['检查是否需要修改第二段。', '只检查第4章是否需要修订正文。', '请勿再修改第4章。',
    '修订第4章正文。不得修改。'])(
    'retains assessment and bare-denial boundaries through actual HTTP admission: %s', prompt => fixture(prompt, async (ctx, before) => {
      await expect(chapterEditRangeTool.execute(ctx, { chapterId: before[3].id, oldText: '向右转', newText: '向左转' })).rejects.toBeTruthy()
      expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
    }))
  it.each(['禁止修订“向左走。”。', '不调整“向左走。”。', '“向左走。”，保持不变。'])(
    'preserves a protected quotation even when the same text was cited as an issue: %s', protection => fixture(requests[0] + concerns + protection, async (ctx, before) => {
      const spec = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec)
      expect(spec.scope.localEditBoundary).toMatchObject({ kind: 'needs_input', regions: [] })
      await expect(chapterEditRangeTool.execute(ctx, { chapterId: before[3].id, oldText: '向左走。', newText: '向右走。' })).rejects.toMatchObject({ code: 'AUTHOR_LOCAL_SCOPE' })
      expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
    }))
  it('does not create a relative next chapter when the same request forbids chapter creation', () => fixture('续写下一章，不新建章节。', async (ctx, before) => {
    const spec = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec)
    expect(spec.scope).toMatchObject({ writing: { kind: 'needs_input', targets: [] }, writingInterpretation: { creationDenied: true } })
    await expect(chapterCreateTool.execute(ctx, { title: '不得创建', volumeOrder: 2, positionInVolume: 3 })).rejects.toMatchObject({ code: 'SCOPE_NEEDS_INPUT' })
    expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
  }))
  it.each(['writing', 'localEditBoundary', 'writingInterpretation'] as const)(
    'rejects a partial frozen2 projection with missing %s before prepare or writes', field => fixture(requests[0] + concerns, async (ctx, before) => {
      const spec = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec)
      delete spec.scope[field]
      await prisma.agentRun.update({ where: { id: ctx.runId }, data: { taskSpec: spec } })
      await expect(prepare(ctx)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
      await expect(chapterWriteTool.execute(ctx, { chapterId: before[3].id, content: '不应扩大为整章权限。' })).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
      expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
      expect(await prisma.storyCompilation.count({ where: { runId: ctx.runId } })).toBe(0)
    }))
  it('honors a genuine empty-book first-chapter answer without widening the frozen root', async () => {
    const userId = randomUUID(), novelId = randomUUID(), sessionId = randomUUID()
    let restoreWait = () => {}
    try {
      vi.stubGlobal('fetch', vi.fn(() => { throw Error('No Provider allowed') }))
      await prisma.user.create({ data: { id: userId, nickname: 'synthetic-first-answer', passwordHash: 'test-only' } })
      await prisma.novel.create({ data: { id: novelId, authorId: userId, title: '合成空书', slug: randomUUID(), summary: '' } })
      await prisma.volume.create({ data: { novelId, title: '第一卷', orderIndex: 1 } })
      await prisma.agentSession.create({ data: { id: sessionId, userId, novelId, title: '合成澄清' } })
      const admitted = await request(app).post('/api/agent/runs')
        .set('Cookie', `chevoink_session=${buildSessionTokens(userId, 0).accessToken}`)
        .send({ novelId, sessionId, prompt: shortSceneRequest, mode: 'build' })
      expect(admitted.status).toBe(200)
      const runId = admitted.body.data.runId as string
      const frozen = (await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).taskSpec
      expect(frozen).toMatchObject({ scope: { writingTargetProtocol: 2, writingClarificationProtocol: 1, writing: { kind: 'needs_input' } } })
      await prisma.agentRun.update({ where: { id: runId }, data: { status: 'running' } })
      const ctx: ToolContext = { userId, novelId, sessionId, runId, chapterId: null, callId: 'true-author-answer', mode: 'build',
        qualityMode: 'premium', creativeFreedom: 'balanced', signal: new AbortController().signal, emit: () => {} }
      const wait = questionPermissions.waitForQuestionAnswer
      const waitingSpy = vi.spyOn(questionPermissions, 'waitForQuestionAnswer').mockImplementation((id, callId, timeout, signal) => {
        const pending = wait(id, callId, timeout, signal)
        return Promise.all([pending, resolveLoopRunQuestion(userId, id, callId, firstChapterAnswer)]).then(([answer]) => answer)
      })
      restoreWait = () => { waitingSpy.mockRestore() }
      expect((await askUserTool.execute(ctx, placementQuestion)).semanticTransition).toBeDefined()
      expect((await chapterCreateTool.execute({ ...ctx, callId: 'create-answered-first' }, { title: '合成第一章', volumeOrder: 1, positionInVolume: 1 })).outcome).not.toBe('failed')
      const chapter = await prisma.chapter.findFirstOrThrow({ where: { novelId, orderIndex: 1 } })
      expect((await chapterWriteTool.execute({ ...ctx, callId: 'write-answered-first' }, { chapterId: chapter.id, content: '她在门口等候。窗外天亮了。' })).outcome).not.toBe('failed')
      expect((await chapterEditRangeTool.execute({ ...ctx, callId: 'edit-answered-first' }, { chapterId: chapter.id, oldText: '窗外天亮了', newText: '窗外雨停了' })).outcome).not.toBe('failed')
      await expect(chapterCreateTool.execute({ ...ctx, callId: 'deny-second-after-answer' }, { title: '不得扩成第二章', volumeOrder: 1, positionInVolume: 2 })).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
      expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).taskSpec).toEqual(frozen)
      expect(await prisma.chapter.count({ where: { novelId } })).toBe(1)
      expect(await prisma.aiUsageLog.count({ where: { userId } })).toBe(0)
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      restoreWait()
      await prisma.$transaction(async tx => {
        await lockNovelActiveScope(tx, novelId)
        await tx.memoryExtractionJob.deleteMany({ where: { novelId } })
        await tx.projectMemoryEntry.deleteMany({ where: { novelId } })
        await tx.agentArtifact.deleteMany({ where: { run: { userId, novelId } } })
        await tx.agentRun.deleteMany({ where: { userId } })
        await tx.agentSession.deleteMany({ where: { userId } })
        await tx.chapter.deleteMany({ where: { novelId, authorId: userId } })
        await tx.novel.deleteMany({ where: { id: novelId, authorId: userId } })
        await tx.user.deleteMany({ where: { id: userId } })
      })
    }
  })
})
