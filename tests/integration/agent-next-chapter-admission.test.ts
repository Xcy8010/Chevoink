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
import { chapterCreateTool, chapterWriteTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { storyCompilerPrepareTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { freezeWritingScope, readWritingScope } from '../../api/lib/agent/writing-scope.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { taskSpecSchema } from '../../shared/contracts/index.js'
import { verifyTestDatabase } from '../support/database-preflight.js'
import { isTestDatabaseRequired } from '../support/database-availability.js'
import { nextChapterContinuationPrompt } from '../support/writing-target-prompt.js'
import { frozenWritingScopeHash } from '../../api/lib/agent/writing-contract.js'

const available = await verifyTestDatabase(isTestDatabaseRequired())
afterAll(() => prisma.$disconnect())
afterEach(() => vi.unstubAllGlobals())

async function fixture(prompt: string, work: (ctx: ToolContext, before: Awaited<ReturnType<typeof prisma.chapter.findMany>>) => Promise<void>, editor = false) {
  const userId = randomUUID(), novelId = randomUUID(), sessionId = randomUUID(), volumeId = randomUUID()
  try {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Provider calls forbidden in admission regression') }))
    await prisma.user.create({ data: { id: userId, nickname: 'synthetic-next-admission', passwordHash: 'test-only' } })
    await prisma.novel.create({ data: { id: novelId, authorId: userId, title: '合成接续', slug: randomUUID(), summary: '' } })
    await prisma.volume.create({ data: { id: volumeId, novelId, title: '合成第一卷', orderIndex: 1 } })
    for (const orderIndex of [1, 2, 3]) await prisma.chapter.create({ data: { novelId, authorId: userId, volumeId,
      title: `合成章${orderIndex}`, content: `合成正文${orderIndex}。`, orderIndex, orderInVolume: orderIndex, revision: orderIndex + 3 } })
    const before = await prisma.chapter.findMany({ where: { novelId }, orderBy: { orderIndex: 'asc' } })
    await prisma.agentSession.create({ data: { id: sessionId, novelId, userId, title: '合成接续任务' } })
    const chapterId = editor ? before[0].id : null
    const admitted = await request(app).post('/api/agent/runs')
      .set('Cookie', `chevoink_session=${buildSessionTokens(userId, 0).accessToken}`)
      .send({ novelId, sessionId, chapterId, prompt, mode: 'build' })
    expect(admitted.status).toBe(200)
    const runId = admitted.body.data.runId as string
    await prisma.agentRun.update({ where: { id: runId }, data: { status: 'running' } })
    expect(await prisma.chapter.findMany({ where: { novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
    await work({ userId, novelId, sessionId, chapterId, runId, callId: 'synthetic-prepare', mode: 'build',
      qualityMode: 'premium', creativeFreedom: 'balanced', emit: () => {}, signal: new AbortController().signal }, before)
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

const prepare = (ctx: ToolContext, targetOrderIndex = 4) => storyCompilerPrepareTool.execute(ctx, {
  targetOrderIndex, intentSummary: '仅推进一个合成小冲突，承接前章状态',
  volumeDecision: { kind: 'continue', reason: '当前合成困局尚未结束，继续原卷' },
})

describe.skipIf(!available)('fresh HTTP same next-chapter identity and actual PG tool admission', () => {
  it.each([
    nextChapterContinuationPrompt,
    '续写下一章，只写这一章，不修改第1、2、3章。',
    '续写下一章，作为第四章保存。仅写该章，不修改已经保存的第1、2、3章。',
  ])('prepares and creates exactly chapter4 without asking again or touching prior chapters: %s', prompt => fixture(prompt, async (ctx, before) => {
    const spec = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec)
    expect(spec).toMatchObject({ intent: 'write', scope: { writingTargetProtocol: 2,
      writing: { kind: 'bounded', targets: [{ orderIndex: 4, chapterId: null }] } } })
    expect(spec.scope.writing?.targets).toHaveLength(1)
    expect((await prepare(ctx)).outcome).not.toBe('failed')
    expect(await prisma.storyCompilation.findMany({ where: { runId: ctx.runId } })).toEqual([
      expect.objectContaining({ targetOrderIndex: 4, chapterId: null }),
    ])
    const args = { title: '合成第四章', volumeOrder: 1, positionInVolume: 4 }
    expect((await chapterCreateTool.execute({ ...ctx, callId: 'synthetic-create' }, args)).outcome).not.toBe('failed')
    const created = await prisma.chapter.findFirstOrThrow({ where: { novelId: ctx.novelId, orderIndex: 4 } })
    expect(created).toMatchObject({ volumeId: before[0].volumeId, orderInVolume: 4, content: '' })
    expect((await chapterCreateTool.execute({ ...ctx, callId: 'synthetic-repeat' }, args)).outcome).not.toBe('failed')
    expect(await prisma.chapter.count({ where: { novelId: ctx.novelId } })).toBe(4)
    const scope = await prisma.$transaction(tx => readWritingScope(tx, ctx))
    expect(scope.bindings?.targets).toEqual([{ orderIndex: 4, chapterId: created.id }])
    await expect(chapterCreateTool.execute({ ...ctx, callId: 'deny-fifth' },
      { title: '不得续建第五章', volumeOrder: 1, positionInVolume: 5 })).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
    for (const chapter of before) await expect(chapterWriteTool.execute({ ...ctx, callId: `deny-${chapter.orderIndex}` },
      { chapterId: chapter.id, content: '不得覆盖前章。' })).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
    expect(await prisma.chapter.findMany({ where: { id: { in: before.map(chapter => chapter.id) } }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
    expect(await prisma.$transaction(tx => freezeWritingScope(tx, ctx, spec, '写全部章节', 1))).toEqual(spec)
  }))

  it.each([
    ['续写下一章，作为第5章正式写入。只写这一章。', false],
    ['在当前章之后写下一章，作为第4章正式写入。只写这一章。', true],
    ['写第4至5章。只写这一章。', false],
  ] as const)('denies an ordinal or cardinality conflict before any prepare/create effect: %s', (prompt, editor) => fixture(prompt, async (ctx, before) => {
    const spec = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec)
    expect(spec.scope.writing).toMatchObject({ kind: 'needs_input', targets: [] })
    await expect(prepare(ctx)).rejects.toMatchObject({ code: 'SCOPE_NEEDS_INPUT' })
    await expect(chapterCreateTool.execute({ ...ctx, callId: 'denied-create' },
      { title: '不得创建', volumeOrder: 1, positionInVolume: 4 })).rejects.toMatchObject({ code: 'SCOPE_NEEDS_INPUT' })
    expect(await prisma.storyCompilation.count({ where: { runId: ctx.runId } })).toBe(0)
    expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
  }, editor))

  it.each([true, false])('never reparses a frozen needs-input run on continuation, new marker=%s', marker => fixture(nextChapterContinuationPrompt, async (ctx, before) => {
    const spec = taskSpecSchema.parse((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).taskSpec)
    spec.scope.writing = { version: 1, kind: 'needs_input', targets: [], repairAuthorized: true, titleAndBodyOnly: false }
    if (spec.scope.writingInterpretation) spec.scope.writingInterpretation.scopeHash = frozenWritingScopeHash(spec.scope)
    if (!marker) delete spec.scope.writingTargetProtocol
    await prisma.agentRun.update({ where: { id: ctx.runId }, data: { taskSpec: spec, status: 'awaiting_approval' } })
    expect(await prisma.$transaction(tx => freezeWritingScope(tx, ctx, spec, nextChapterContinuationPrompt, 1))).toEqual(spec)
    await expect(prepare(ctx)).rejects.toMatchObject({ code: 'SCOPE_NEEDS_INPUT' })
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: ctx.runId } })).status).toBe('awaiting_approval')
    expect(await prisma.chapter.findMany({ where: { novelId: ctx.novelId }, orderBy: { orderIndex: 'asc' } })).toEqual(before)
  }))
})
