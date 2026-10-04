import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
const db = vi.hoisted(() => ({
  novel: { findFirst: vi.fn() }, agentRun: { findFirst: vi.fn() }, chapter: { findFirst: vi.fn(), findMany: vi.fn() },
  storyCompilation: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn(), create: vi.fn() },
  chapterBridge: { findFirst: vi.fn(), update: vi.fn() }, sceneTask: { updateMany: vi.fn() }, agentGoalExecution: { findUnique: vi.fn() },
  storyCharter: { findFirst: vi.fn() }, readerPromise: { findMany: vi.fn() }, projectMemoryEntry: { findMany: vi.fn() }, $transaction: vi.fn(), $queryRaw: vi.fn(),
}))
vi.mock('../../api/lib/prisma.js', async original => ({ ...await original<typeof import('../../api/lib/prisma.js')>(), prisma: db }))
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { buildStoryCompilerDigest, commitChapterBridge, compilationRunScope, prepareStoryCompilation } from '../../api/lib/agent/story-compiler.js'
import * as memory from '../../api/lib/agent/story-memory.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { hasCommittedTaskChapter } from '../../api/lib/agent/humanity-quality.js'
import { chapterBridgeCommitTool, chapterBridgeGetTool, continuityValidateTool, storyCompilerPrepareTool } from '../../api/lib/agent/tools/story-compiler-tools.js'

const ctx = { userId: 'u', novelId: 'n', runId: 'new-run', sessionId: 'session', chapterId: 'old31', callId: 'call', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced', signal: new AbortController().signal, emit: vi.fn() } as ToolContext
const spec = (prompt: string) => buildTaskSpec({ runId: ctx.runId, novelId: ctx.novelId, chapterId: ctx.chapterId, prompt, mode: 'build' })
beforeEach(() => {
  vi.resetAllMocks()
  db.$transaction.mockImplementation(fn => fn(db)); db.$queryRaw.mockResolvedValue([{ id: 'n' }])
  db.novel.findFirst.mockResolvedValue({ id: 'n', chapterCount: 31 })
  db.agentGoalExecution.findUnique.mockResolvedValue(null)
  db.agentRun.findFirst.mockResolvedValue({ createdAt: new Date('2026-09-20T03:22:41Z'), runtimeProtocolVersion: 0, taskRootId: null, sessionId: 'session', taskSpec: spec('写下一章') })
  db.chapter.findFirst.mockImplementation(async ({ where }) => where.id ? { id: where.id, title: '原章节', orderIndex: where.id === 'old31' ? 31 : 32, revision: 3, content: '已保存正文' } : where.orderIndex?.lt ? null : { orderIndex: 31 })
  db.chapter.findMany.mockResolvedValue([]); db.storyCompilation.findFirst.mockResolvedValue(null); db.storyCompilation.findMany.mockResolvedValue([])
  db.storyCompilation.updateMany.mockResolvedValue({ count: 0 })
  db.storyCompilation.create.mockImplementation(async ({ data }) => ({ id: 'created', ...data, bridge: data.bridge.create }))
  db.storyCharter.findFirst.mockResolvedValue(null); db.readerPromise.findMany.mockResolvedValue([]); db.projectMemoryEntry.findMany.mockResolvedValue([]); db.chapterBridge.findFirst.mockResolvedValue(null)
})

describe('story compiler task identity', () => {
  function historicalResume(originOverride: Record<string, unknown> = {}) {
    const originalSpec = { ...spec('写下一章'), runId: 'original-run' }
    const resumed = { runtimeProtocolVersion: 0, taskRootId: null, sessionId: 'session', taskSpec: originalSpec }
    db.agentRun.findFirst.mockImplementation(async ({ where }) => where.id === 'original-run'
      ? { id: 'original-run', taskSpec: originalSpec, ...originOverride }
      : where.id === 'new-run' ? resumed : { createdAt: new Date('2026-09-20T03:22:41Z') })
    return originalSpec
  }
  it('recovers the exact interrupted legacy origin without recreating its compiler, scenes, or checks', async () => {
    const originalSpec = historicalResume()
    db.storyCompilation.findFirst.mockResolvedValue({ id: 'original-compiler', chapterId: 'own32', targetOrderIndex: 32, stage: 'write', status: 'active',
      sceneTasks: [{ ordinal: 1, purpose: '原场景', turn: '原转折' }], bridge: {}, chapter: { id: 'own32', revision: 4 },
      validation: { checkedRevision: 3, independentCheck: 'complete', findings: [] }, qualityReports: [{ id: 'original-quality', chapterRevision: 4, status: 'passed' }] })
    const digest = await buildStoryCompilerDigest('u', 'n', 'old31', 'new-run')
    expect(digest).toContain('original-compiler')
    expect(digest).toContain('当前正文 r4')
    expect(digest).toContain('original-quality')
    expect(digest).toContain('独立章节检查不能代替编译 CHECK')
    expect(db.storyCompilation.findFirst.mock.calls.at(-1)![0].where.run.taskSpec).toEqual({ path: ['id'], equals: originalSpec.id })
    expect(db.agentRun.findFirst.mock.calls.some(([query]) => query.where.id === 'original-run'
      && query.where.sessionId === 'session' && query.where.userId === 'u' && query.where.novelId === 'n'
      && query.where.status.in.join(',') === 'paused,failed')).toBe(true)
    expect(db.storyCompilation.create).not.toHaveBeenCalled()
    expect(db.storyCompilation.updateMany).not.toHaveBeenCalled()
  })
  it('rejects a copied task id when the original full contract changed', async () => {
    const original = historicalResume()
    historicalResume({ taskSpec: { ...original, goals: ['其他任务'] } })
    await expect(compilationRunScope(db as unknown as Prisma.TransactionClient, ctx)).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_MISMATCH' })
    expect(db.storyCompilation.findFirst).not.toHaveBeenCalled()
  })
  it('rejects unowned, completed, or missing stale origins instead of widening to the session', async () => {
    historicalResume()
    const implementation = db.agentRun.findFirst.getMockImplementation()!
    db.agentRun.findFirst.mockImplementation(async query => query.where.id === 'original-run' ? null : implementation(query))
    await expect(compilationRunScope(db as unknown as Prisma.TransactionClient, ctx)).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_MISMATCH' })
    expect(db.storyCompilation.findFirst).not.toHaveBeenCalled()
  })
  it('acknowledges a newer committed compiler instead of choosing the older active compiler', async () => {
    db.storyCompilation.findMany.mockResolvedValue([
      { id: 'new-completed', status: 'completed', chapter: { id: 'own32', revision: 4 }, bridge: { targetRevision: 4 } },
      { id: 'old-active', status: 'active', chapter: { id: 'own32', revision: 4 }, bridge: { targetRevision: 3 } },
    ])
    const result = await chapterBridgeCommitTool.execute(ctx, {})
    expect(result.summary).toBe('章节终态已提交')
    expect(result.display).toMatchObject({ compilationId: 'new-completed' })
    expect(db.storyCompilation.findMany.mock.calls[0][0].orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }])
    expect(db.storyCompilation.updateMany).not.toHaveBeenCalled()
  })
  it('preserves an explicit wrong id and fails without preparing a replacement', async () => {
    expect(await chapterBridgeCommitTool.execute(ctx, { compilationId: 'wrong-or-foreign' })).toMatchObject({ outcome: 'failed' })
    expect(db.storyCompilation.findMany.mock.calls[0][0].where).toMatchObject({ id: 'wrong-or-foreign' })
    expect(db.storyCompilation.create).not.toHaveBeenCalled()
  })
  it('never substitutes a durable baseline for an explicitly different compilation id', async () => {
    expect(await chapterBridgeCommitTool.execute({ ...ctx, durableCompiler: { baseline: { id: 'own', hash: 'a'.repeat(64) } } } as ToolContext,
      { compilationId: 'foreign' })).toMatchObject({ outcome: 'failed', summary: '章节编译身份不匹配' })
    expect(db.storyCompilation.findMany).not.toHaveBeenCalled()
  })
  it('rejects explicit superseded active identity and leaves the newer chapter commit untouched', async () => {
    db.storyCompilation.findMany.mockResolvedValue([{ id: 'old-active', status: 'active', chapterId: 'own32', createdAt: new Date(1), chapter: { id: 'own32', revision: 4 }, bridge: {} }])
    db.storyCompilation.findFirst.mockResolvedValue({ id: 'new-completed' })
    expect(await chapterBridgeCommitTool.execute(ctx, { compilationId: 'old-active' })).toMatchObject({ outcome: 'failed', summary: '章节编译已被后续准备替代' })
    expect(db.storyCompilation.findFirst.mock.calls[0][0].where).toMatchObject({ chapterId: 'own32', createdAt: { gt: new Date(1) } })
    expect(db.storyCompilation.updateMany).not.toHaveBeenCalled()
  })
  it('ignores superseded same-chapter state for delivery but still rejects another unfinished chapter', async () => {
    const committed = { status: 'completed', stage: 'commit', chapterId: 'own32', createdAt: new Date(2),
      chapter: { id: 'own32', novelId: 'n', revision: 4, wordCount: 2000, archivedAt: null, volume: { novelId: 'n', archivedAt: null } },
      bridge: { toChapterId: 'own32', targetRevision: 4, committedAt: new Date() } }
    db.storyCompilation.findMany.mockResolvedValue([committed, { ...committed, status: 'active', stage: 'write', createdAt: new Date(1) }])
    expect(await hasCommittedTaskChapter(db as unknown as Prisma.TransactionClient, 'u', 'n', 'new-run')).toBe(true)
    db.storyCompilation.findMany.mockResolvedValue([committed, { ...committed, status: 'active', stage: 'write', chapterId: 'own33' }])
    expect(await hasCommittedTaskChapter(db as unknown as Prisma.TransactionClient, 'u', 'n', 'new-run')).toBe(false)
  })
  it('keeps malformed or unbound legacy specs local to their own run', async () => {
    for (const taskSpec of [{}, { ...spec('修改当前章节'), runId: undefined }]) {
      db.agentRun.findFirst.mockResolvedValue({ runtimeProtocolVersion: 0, taskRootId: null, sessionId: 'session', taskSpec })
      expect(await compilationRunScope(db as unknown as Prisma.TransactionClient, ctx)).toEqual({ run: { id: ctx.runId, userId: 'u', novelId: 'n' } })
    }
  })
  it('binds resumed commit memory to the current execution without changing the original compiler owner', async () => {
    const currentTask = spec('修改当前章节')
    db.agentRun.findFirst.mockImplementation(async ({ where, select }) => select?.manuscriptRevision
      ? { manuscriptRevision: 0, novel: { authorId: 'u', manuscriptRevision: 0 } }
      : where.status ? { id: 'new-run' }
        : { runtimeProtocolVersion: 0, taskRootId: null, sessionId: 'session', taskSpec: currentTask })
    const chapter = { id: 'old31', revision: 3, content: '已保存正文', title: '原章节', orderIndex: 31 }
    const bridge = { id: 'bridge', fromChapterId: null, recentOpenings: [], recentEndings: [] }
    db.storyCompilation.findFirst.mockResolvedValue({ id: 'original-compiler', runId: 'original-run', chapterId: 'old31', status: 'active', chapter, sceneTasks: [], bridge,
      validation: { independentCheck: 'complete', checkedRevision: 3, errorCount: 0, coverage: compilerContinuityCoverage({ chapter, bridge, sceneTasks: [], source: null }) } })
    const save = vi.spyOn(memory, 'saveStoryMemory').mockResolvedValue({ id: 'proposal', action: 'created', status: 'candidate' })
    try {
      await commitChapterBridge({ userId: 'u', novelId: 'n', runId: 'new-run', compilationId: 'original-compiler', chapterSummary: '原章节摘要',
        exitState: { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] },
        lastUnfinishedAction: '', hookDecision: '', delayedHookReason: '', openingStructure: '动作', endingStructure: '转折' })
      expect(save).toHaveBeenCalledTimes(2)
      for (const [input] of save.mock.calls) expect(input).toMatchObject({ runId: 'new-run', sourceChapterId: 'old31' })
      expect(db.storyCompilation.findFirst.mock.calls[0][0].where.run.taskSpec).toEqual({ path: ['id'], equals: currentTask.id })
      expect(db.storyCompilation.update.mock.calls[0][0].data).not.toHaveProperty('runId')
    } finally { save.mockRestore() }
  })
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
