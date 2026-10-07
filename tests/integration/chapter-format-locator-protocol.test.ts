import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { verifyTestDatabase } from '../support/database-preflight.js'
import { isTestDatabaseRequired } from '../support/database-availability.js'
import { freezeWritingScope } from '../../api/lib/agent/writing-scope.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { initializeDurableTask } from '../../api/lib/agent/runtime-identity.js'
import { acquireRunLease } from '../../api/lib/agent/runtime-lease.js'
import { prepareOperation } from '../../api/lib/agent/runtime-operations.js'
import { chapterEditRangeTool } from '../../api/lib/agent/tools/chapter-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'

const available = await verifyTestDatabase(isTestDatabaseRequired())
afterAll(() => prisma.$disconnect())
describe.skipIf(!available)('durable locator protocol identity', () => {
  it('keeps an old exact-only operation unchanged and permits one fresh formatting edit with idempotent receipt replay', async () => {
    const userId = randomUUID(), novelId = randomUUID(), sessionId = randomUUID(), runId = randomUUID(), chapterId = randomUUID(), volumeId = randomUUID()
    const prompt = '修改第一章', body = '纸条仍有缺角。\n\n堡内老卫站着。'
    try {
      await prisma.user.create({ data: { id: userId, nickname: 'locator-isolated', passwordHash: 'test-only' } })
      await prisma.novel.create({ data: { id: novelId, authorId: userId, title: '定位协议测试', slug: `locator-${novelId}`, summary: 'test-only' } })
      await prisma.volume.create({ data: { id: volumeId, novelId, title: '第一卷', orderIndex: 1 } })
      await prisma.chapter.create({ data: { id: chapterId, novelId, authorId: userId, volumeId, title: '守堡', content: body, wordCount: body.length, orderIndex: 1, orderInVolume: 1 } })
      await prisma.agentSession.create({ data: { id: sessionId, userId, novelId, title: 'locator-isolated' } })
      await prisma.agentRun.create({ data: { id: runId, sessionId, userId, novelId, chapterId, status: 'queued', engine: 'loop', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', startRequest: { prompt } } })
      const ctx: ToolContext = { userId, novelId, sessionId, runId, chapterId, callId: 'format-call', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced', emit: () => {}, signal: new AbortController().signal,
        toolAuthority: new Map([['chapter_edit_range', { permission: 'allow', alwaysConfirm: false, dangerous: false }]]) }
      const spec = await prisma.$transaction(tx => freezeWritingScope(tx, ctx, buildTaskSpec({ runId, novelId, chapterId, prompt }), prompt))
      await prisma.agentRun.update({ where: { id: runId }, data: { taskSpec: runtimeJson(JSON.parse(JSON.stringify(spec))).value } })
      const sourceMessageId = randomUUID()
      await prisma.agentMessage.create({ data: { id: sourceMessageId, sessionId, runId, role: 'user', parts: [{ type: 'text', text: prompt }] } })
      await initializeDurableTask({ userId, runId, sourceMessageId })
      const lease = await acquireRunLease({ userId, runId, ownerId: 'locator-synthetic', claimId: randomUUID() })
      const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: chapterId } })
      const args = { chapterId, oldText: '纸条仍有缺角。堡内老卫站着。', newText: '纸条仍有缺角。\n\n堡内老卫坐下。' }
      const old = await prepareOperation(lease, { key: 'old-exact-operation', kind: 'tool', action: 'chapter_edit_range', input: runtimeJson({ callId: ctx.callId, novelId, chapterId, expectedRevision: chapter.revision, args }).value })
      const oldCtx = { ...ctx, durableContent: { lease, operationKey: 'old-exact-operation', chapterId, expectedRevision: chapter.revision } }
      await expect(chapterEditRangeTool.execute(oldCtx, args)).rejects.toMatchObject({ code: 'CHAPTER_ANCHOR_CONFLICT' })
      expect(await prisma.agentOperation.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ inputHash: old.inputHash, inputSnapshot: old.inputSnapshot })
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapterId } })).toEqual(chapter)
      const budget = await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: lease.taskRootId } })
      const freshCtx = { ...ctx, durableContent: { lease, operationKey: 'fresh-format-operation', chapterId, expectedRevision: chapter.revision } }
      const first = await chapterEditRangeTool.execute(freshCtx, args)
      const second = await chapterEditRangeTool.execute(freshCtx, args)
      expect(second).toEqual(first)
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: chapterId } })).toMatchObject({ content: args.newText, revision: chapter.revision + 1 })
      expect(await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: lease.taskRootId } })).toEqual(budget)
      expect(await prisma.agentProviderAttempt.count({ where: { runId } })).toBe(0)
    } finally {
      await prisma.$transaction(async tx => {
        await tx.memoryExtractionJob.deleteMany({ where: { novelId, novel: { authorId: userId } } })
        await tx.projectMemoryEntry.deleteMany({ where: { novelId, novel: { authorId: userId } } })
        await tx.agentRun.deleteMany({ where: { id: runId, userId, novelId } })
        await tx.agentSession.deleteMany({ where: { id: sessionId, userId, novelId } })
        await tx.chapter.deleteMany({ where: { novelId, authorId: userId } })
        await tx.novel.deleteMany({ where: { id: novelId, authorId: userId } })
        await tx.user.deleteMany({ where: { id: userId } })
      })
    }
  })
})
