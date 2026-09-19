import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
const db = vi.hoisted(() => ({
  novel: { findFirst: vi.fn() }, agentRun: { findFirst: vi.fn() }, chapter: { findFirst: vi.fn(), findMany: vi.fn() },
  storyCompilation: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
  chapterBridge: { findFirst: vi.fn() }, storyCharter: { findFirst: vi.fn() }, readerPromise: { findMany: vi.fn() }, projectMemoryEntry: { findMany: vi.fn() }, $transaction: vi.fn(), $queryRaw: vi.fn(),
}))
vi.mock('../../api/lib/prisma.js', async original => ({ ...await original<typeof import('../../api/lib/prisma.js')>(), prisma: db }))
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { buildStoryCompilerDigest, compilationRunScope, prepareStoryCompilation } from '../../api/lib/agent/story-compiler.js'
import { chapterBridgeGetTool, continuityValidateTool, storyCompilerPrepareTool } from '../../api/lib/agent/tools/story-compiler-tools.js'

const ctx = { userId: 'u', novelId: 'n', runId: 'new-run', sessionId: 'session', chapterId: 'old31', callId: 'call', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced', signal: new AbortController().signal, emit: vi.fn() } as ToolContext
const spec = (prompt: string) => buildTaskSpec({ runId: ctx.runId, novelId: ctx.novelId, chapterId: ctx.chapterId, prompt, mode: 'build' })
beforeEach(() => {
  vi.resetAllMocks()
  db.$transaction.mockImplementation(fn => fn(db)); db.$queryRaw.mockResolvedValue([{ id: 'n' }])
  db.novel.findFirst.mockResolvedValue({ id: 'n', chapterCount: 31 })
  db.agentRun.findFirst.mockResolvedValue({ createdAt: new Date('2026-09-20T03:22:41Z'), runtimeProtocolVersion: 0, taskRootId: null, sessionId: 'session', taskSpec: spec('写下一章') })
  db.chapter.findFirst.mockImplementation(async ({ where }) => where.id ? { id: where.id, title: '原章节', orderIndex: where.id === 'old31' ? 31 : 32, revision: 3, content: '已保存正文' } : where.orderIndex?.lt ? null : { orderIndex: 31 })
  db.chapter.findMany.mockResolvedValue([]); db.storyCompilation.findFirst.mockResolvedValue(null); db.storyCompilation.findMany.mockResolvedValue([])
  db.storyCompilation.updateMany.mockResolvedValue({ count: 0 })
  db.storyCompilation.create.mockImplementation(async ({ data }) => ({ id: 'created', ...data, bridge: data.bridge.create }))
  db.storyCharter.findFirst.mockResolvedValue(null); db.readerPromise.findMany.mockResolvedValue([]); db.projectMemoryEntry.findMany.mockResolvedValue([]); db.chapterBridge.findFirst.mockResolvedValue(null)
})

describe('story compiler task identity', () => {
  it('prepares chapter32 for a fresh next-chapter request even when the editor selects chapter31', async () => {
    const result = await storyCompilerPrepareTool.execute(ctx, { intentSummary: '写下一章' })
    expect(result.output).toContain('目标全书第 32 章')
    expect(db.storyCompilation.create.mock.calls[0][0].data).toMatchObject({ runId: 'new-run', targetOrderIndex: 32 })
    expect(db.storyCompilation.create.mock.calls[0][0].data.chapterId).toBeUndefined()
  })
  it('rejects an explicit old chapter target from the next-chapter task without writes', async () => {
    await expect(prepareStoryCompilation({ userId: 'u', novelId: 'n', runId: 'new-run', chapterId: 'old31', mode: 'balanced', intentSummary: '恢复旧章' })).rejects.toMatchObject({ code: 'STORY_TASK_TARGET_MISMATCH' })
    expect(db.storyCompilation.create).not.toHaveBeenCalled()
    expect(db.storyCompilation.updateMany).not.toHaveBeenCalled()
  })
  it('keeps explicit author revision requests and same-contract continuation legal', async () => {
    db.agentRun.findFirst.mockResolvedValue({ createdAt: new Date('2026-09-20T03:22:41Z'), runtimeProtocolVersion: 0, taskRootId: null, sessionId: 'session', taskSpec: spec('修改当前章节') })
    await storyCompilerPrepareTool.execute(ctx, { intentSummary: '修改当前章节' })
    expect(db.storyCompilation.create.mock.calls[0][0].data).toMatchObject({ chapterId: 'old31', targetOrderIndex: 31 })
    db.agentRun.findFirst.mockResolvedValue({ createdAt: new Date('2026-09-20T03:22:41Z'), runtimeProtocolVersion: 0, taskRootId: null, sessionId: 'session', taskSpec: spec('写下一章') })
    db.storyCompilation.findFirst.mockResolvedValue({ id: 'own', chapterId: 'own32', targetOrderIndex: 32 })
    await storyCompilerPrepareTool.execute(ctx, { intentSummary: '完成本任务' })
    expect(db.storyCompilation.create.mock.calls[1][0].data).toMatchObject({ chapterId: 'own32', targetOrderIndex: 32 })
  })
  it('uses the validated contract rather than the session for both digest and bridge lookup', async () => {
    const scope = await compilationRunScope(db as unknown as Prisma.TransactionClient, ctx)
    expect(scope).toMatchObject({ AND: [{ OR: [{ chapterId: null }, { chapter: { createdAt: { gte: new Date('2026-09-20T03:22:41Z') } } }] }], run: { sessionId: 'session', taskSpec: { path: ['id'], equals: expect.any(String) } } })
    await buildStoryCompilerDigest('u', 'n', 'old31', 'new-run')
    expect(db.storyCompilation.findFirst.mock.calls.at(-1)![0].where).toMatchObject(scope)
    const result = await chapterBridgeGetTool.execute(ctx, { compilationId: 'foreign-compilation' })
    expect(result.outcome).toBe('failed')
    expect(db.storyCompilation.findFirst.mock.calls.at(-1)![0].where).toMatchObject({ ...scope, id: 'foreign-compilation' })
  })
  it('marks a missing cross-task continuity compilation as failed instead of showing tool success', async () => {
    expect(await continuityValidateTool.execute(ctx, { compilationId: 'foreign' })).toMatchObject({ outcome: 'failed', summary: '本任务连续性检查未执行' })
    expect(db.storyCompilation.create).not.toHaveBeenCalled()
  })
  it('keeps no-run digest compatibility read-only without guessing an active task', async () => {
    db.storyCharter.findFirst.mockResolvedValue({ revision: 1, oneLinePromise: '故事承诺' })
    const digest = await buildStoryCompilerDigest('u', 'n', null)
    expect(digest).toContain('故事承诺')
    expect(digest).toContain('本任务尚未建立编译')
    expect(db.storyCompilation.findFirst).not.toHaveBeenCalled()
    expect(db.agentRun.findFirst).not.toHaveBeenCalled()
  })
})
