import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
const db = vi.hoisted(() => ({
  novel: { findFirst: vi.fn() }, agentArtifact: { findMany: vi.fn() }, agentRun: { findFirst: vi.fn(), findMany: vi.fn(), findFirstOrThrow: vi.fn(), findUniqueOrThrow: vi.fn() }, chapter: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn() },
  agentSession: { findFirst: vi.fn() }, agentChildExecutionGrant: { findUnique: vi.fn() }, agentMessage: { findFirst: vi.fn() }, chapterQualityReport: { findFirst: vi.fn(), findUnique: vi.fn() },
  storyCompilation: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn(), create: vi.fn() },
  chapterBridge: { findFirst: vi.fn(), update: vi.fn() }, sceneTask: { updateMany: vi.fn() }, agentGoalExecution: { findUnique: vi.fn() },
  storyCharter: { findFirst: vi.fn() }, readerPromise: { findMany: vi.fn() }, projectMemoryEntry: { findMany: vi.fn() }, $transaction: vi.fn(), $queryRaw: vi.fn(),
}))
vi.mock('../../api/lib/prisma.js', async original => ({ ...await original<typeof import('../../api/lib/prisma.js')>(), prisma: db }))
vi.mock('../../api/lib/agent/writing-volume.js', async original => ({ ...await original<typeof import('../../api/lib/agent/writing-volume.js')>(), readWritingVolumeContext: vi.fn(async () => null) }))
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { buildStoryCompilerDigest, commitChapterBridge, compilationRunScope, prepareStoryCompilation, readPersistedWritingWorkflowMilestones } from '../../api/lib/agent/story-compiler.js'
import * as memory from '../../api/lib/agent/story-memory.js'
import { compilerContinuityCoverage } from '../../api/lib/agent/compiler-continuity-contract.js'
import { hasCommittedTaskChapter } from '../../api/lib/agent/humanity-quality.js'
import { chapterBridgeCommitTool, chapterBridgeGetTool, continuityValidateTool, storyCompilerPrepareTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import { activeChapterScope } from '../../api/lib/data/internal.js'

const ctx = { userId: 'u', novelId: 'n', runId: 'new-run', sessionId: 'session', chapterId: 'old31', callId: 'call', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'balanced', signal: new AbortController().signal, emit: vi.fn() } as ToolContext
const spec = (prompt: string) => {
  const result = buildTaskSpec({ runId: ctx.runId, novelId: ctx.novelId, chapterId: ctx.chapterId, prompt, mode: 'build' })
  return { ...result, scope: { ...result.scope, writing: { version: 1 as const, kind: 'bounded' as const,
    targets: [{ orderIndex: prompt.includes('下一章') ? 32 : 31, chapterId: prompt.includes('下一章') ? null : 'old31' }], titleAndBodyOnly: false, repairAuthorized: prompt.includes('修改') } } }
}
beforeEach(() => {
  vi.resetAllMocks()
  db.$transaction.mockImplementation(fn => fn(db)); db.$queryRaw.mockResolvedValue([{ id: 'n' }])
  db.novel.findFirst.mockResolvedValue({ id: 'n', chapterCount: 31 })
  db.agentGoalExecution.findUnique.mockResolvedValue(null)
  db.agentSession.findFirst.mockResolvedValue(null); db.agentChildExecutionGrant.findUnique.mockResolvedValue(null); db.agentMessage.findFirst.mockResolvedValue(null); db.chapterQualityReport.findFirst.mockResolvedValue(null)
  db.chapterQualityReport.findUnique.mockImplementation(query => db.chapterQualityReport.findFirst(query))
  db.agentRun.findFirst.mockResolvedValue({ id: 'new-run', userId: 'u', novelId: 'n', status: 'running', startRequest: { prompt: '写下一章' }, createdAt: new Date('2026-09-20T03:22:41Z'), runtimeProtocolVersion: 0, taskRootId: null, sessionId: 'session', taskSpec: spec('写下一章') })
  db.agentRun.findFirstOrThrow.mockImplementation(query => db.agentRun.findFirst(query))
  db.agentRun.findMany.mockResolvedValue([])
  db.agentRun.findUniqueOrThrow.mockImplementation(query => db.agentRun.findFirst(query))
  db.chapter.findFirst.mockImplementation(async ({ where }) => where.id ? { id: where.id, title: '原章节', orderIndex: where.id === 'old31' ? 31 : 32, revision: 3, content: '已保存正文' } : where.orderIndex?.lt || where.orderIndex === 32 ? null : { id: 'old31', orderIndex: 31 })
  const findChapter = db.chapter.findFirst.getMockImplementation()!
  db.chapter.findFirst.mockImplementation(async query => {
    const chapter = await findChapter(query)
    return chapter ? { revision: 1, content: '', volumeId: 'v', volume: { title: '第一卷', summary: '边堡困局' }, ...chapter } : chapter
  })
  db.chapter.count.mockResolvedValue(31); db.agentArtifact.findMany.mockResolvedValue([])
  db.chapter.findMany.mockResolvedValue([]); db.storyCompilation.findFirst.mockResolvedValue(null); db.storyCompilation.findMany.mockResolvedValue([])
  db.storyCompilation.updateMany.mockResolvedValue({ count: 0 })
  db.storyCompilation.create.mockImplementation(async ({ data }) => ({ id: 'created', ...data, bridge: data.bridge.create }))
  db.storyCharter.findFirst.mockResolvedValue(null); db.readerPromise.findMany.mockResolvedValue([]); db.projectMemoryEntry.findMany.mockResolvedValue([]); db.chapterBridge.findFirst.mockResolvedValue(null)
})

describe('story compiler task identity', () => {
  it.each(['malformed', 'review', 'unbounded', 'selection', 'proposal', 'wrong-run'] as const)('saved workflow recovery rejects %s input before querying progress', async scenario => {
    const original = spec('写下一章')
    const taskSpec = scenario === 'malformed' ? {} : scenario === 'review' ? { ...original, intent: 'review' }
      : scenario === 'unbounded' ? { ...original, scope: { ...original.scope, writing: { ...original.scope.writing, kind: 'unbounded', targets: [] } } }
        : scenario === 'selection' ? { ...original, scope: { ...original.scope, selection: { chapterId: 'old31', text: '原文', start: 0, end: 2 } } }
          : scenario === 'proposal' ? { ...original, writingPacing: 'proposal_only' } : { ...original, runId: 'different-run' }
    expect(await readPersistedWritingWorkflowMilestones({ ...ctx, taskSpec }, db as unknown as Prisma.TransactionClient)).toEqual([])
    expect(db.agentRun.findFirst).not.toHaveBeenCalled()
    expect(db.storyCompilation.findMany).not.toHaveBeenCalled()
  })
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
    const actualChapter = { id: 'own32', title: '本任务章节', orderIndex: 32, revision: 4, content: '已保存正文' }
    const readChapter = db.chapter.findFirst.getMockImplementation()!
    db.chapter.findFirst.mockImplementation(async query => query.where.id === actualChapter.id ? actualChapter : readChapter(query))
    db.storyCompilation.findFirst.mockResolvedValue({ id: 'original-compiler', chapterId: 'own32', targetOrderIndex: 32, stage: 'write', status: 'active',
      sceneTasks: [{ ordinal: 1, purpose: '原场景', turn: '原转折' }], bridge: { targetRevision: 4 }, chapter: actualChapter,
      validation: { checkedRevision: 3, independentCheck: 'complete', findings: [] }, qualityReports: [{ id: 'original-quality', chapterRevision: 4, status: 'passed' }] })
    const digest = await buildStoryCompilerDigest('u', 'n', 'old31', 'new-run')
    expect(digest).toContain('original-compiler')
    expect(digest).toContain('当前正文 r4')
    expect(digest).toContain('original-quality')
    expect(digest).toContain('独立章节检查不能代替编译 CHECK')
    expect(digest).toContain('revision=3')
    expect(digest).toContain('缺失或旧版本报告不代表通过')
    expect(db.chapter.findFirst).toHaveBeenCalledWith({ where: { id: actualChapter.id, authorId: 'u', ...activeChapterScope('n') }, select: { id: true, revision: true, content: true } })
    expect(db.storyCompilation.findFirst.mock.calls.at(-1)![0].where.run.taskSpec).toEqual({ path: ['id'], equals: originalSpec.id })
    expect(db.agentRun.findFirst.mock.calls.some(([query]) => query.where.id === 'original-run'
      && query.where.sessionId === 'session' && query.where.userId === 'u' && query.where.novelId === 'n'
      && query.where.status.in.join(',') === 'paused,failed')).toBe(true)
    expect(db.storyCompilation.create).not.toHaveBeenCalled()
    expect(db.storyCompilation.updateMany).not.toHaveBeenCalled()
  })

  it.each([
    { stage: 'prepare', sceneCount: 0, content: null, revision: 3, next: '下一步调用 scene_task_build', avoid: '不重复 PREPARE/BEAT' },
    { stage: 'beat', sceneCount: 1, content: '  \n', revision: 3, next: '调用 chapter_write 保存正文', avoid: '下一步调用 scene_task_build' },
    { stage: 'write', sceneCount: 1, content: '已保存正文', revision: 4, next: '当前正文与本编译绑定写入版本', avoid: '终态已提交且匹配当前正文' },
    { stage: 'write', sceneCount: 1, content: '已保存正文', revision: 3, next: '调用 chapter_bridge_commit', avoid: '终态已提交且匹配当前正文' },
    { stage: 'commit', sceneCount: 1, content: '已保存正文', revision: 3, next: '终态已提交且匹配当前正文 revision/hash', avoid: '下一步调用 scene_task_build' },
    { stage: 'commit', sceneCount: 1, content: '已保存正文', revision: 4, next: '不能宣称完成', avoid: '终态已提交且匹配当前正文' },
    { stage: 'commit', sceneCount: 1, content: '同版本变更正文', revision: 3, next: '不能宣称完成', avoid: '终态已提交且匹配当前正文' },
    { stage: 'commit', sceneCount: 1, content: '  ', revision: 3, next: '尚无合法非空正文', avoid: '终态已提交且匹配当前正文' },
    { stage: 'write', sceneCount: 1, content: null, revision: 3, next: '尚无合法非空正文', avoid: '终态已提交且匹配当前正文' },
  ])('derives recovery from actual $stage/$sceneCount scenes/body/revision without a persisted mutation', async scenario => {
    const chapterId = scenario.stage === 'prepare' ? null : 'own32'
    db.chapter.findFirst.mockResolvedValue(scenario.content === null ? null : { id: 'own32', revision: scenario.revision, content: scenario.content })
    db.storyCompilation.findFirst.mockResolvedValue({ id: 'own-compiler', chapterId, targetOrderIndex: 32, stage: scenario.stage,
      status: scenario.stage === 'commit' ? 'completed' : 'active', sceneTasks: Array.from({ length: scenario.sceneCount }, (_, ordinal) => ({ ordinal: ordinal + 1 })),
      bridge: { toChapterId: 'own32', targetRevision: 3, committedAt: scenario.stage === 'commit' ? new Date() : null },
      preparedContext: { terminalContentHash: runtimeJson({ content: '已保存正文' }).hash }, validation: { checkedRevision: 2, independentCheck: 'complete' },
      qualityReports: [{ id: 'old-quality', chapterRevision: 2, status: 'passed' }] })
    const digest = await buildStoryCompilerDigest('u', 'n', 'old31', 'new-run')
    expect(digest).toContain(scenario.next)
    expect(digest).not.toContain(scenario.avoid)
    if (scenario.sceneCount > 0 && scenario.stage !== 'commit') expect(digest).toContain('不重复 PREPARE/BEAT')
    if (scenario.content !== null) expect(digest).toContain('缺失或旧版本报告不代表通过')
    expect(db.storyCompilation.create).not.toHaveBeenCalled()
    expect(db.storyCompilation.update).not.toHaveBeenCalled()
    expect(db.storyCompilation.updateMany).not.toHaveBeenCalled()
    expect(db.chapterBridge.update).not.toHaveBeenCalled()
    expect(db.sceneTask.updateMany).not.toHaveBeenCalled()
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
    const task = spec('写下一章')
    const ownedRun = { id: 'new-run', userId: 'u', novelId: 'n', status: 'running', manuscriptRevision: 0, novel: { authorId: 'u', manuscriptRevision: 0 },
      runtimeProtocolVersion: 0, taskRootId: null, sessionId: 'session', startRequest: { prompt: '写下一章' }, taskSpec: task,
      writingBindings: { version: 1, taskId: task.id, targets: [{ orderIndex: 32, chapterId: 'own32' }] } }
    db.agentRun.findFirst.mockResolvedValue(ownedRun)
    const terminal = { id: 'new-completed', chapterId: 'own32', status: 'completed', stage: 'commit', sceneTasks: [], preparedContext: { terminalContentHash: runtimeJson({ content: '已保存正文' }).hash },
      chapter: { id: 'own32', title: '原章节', content: '已保存正文', revision: 3, orderIndex: 32 },
      bridge: { targetRevision: 3, committedAt: new Date(), fromChapterId: null, recentOpenings: [], recentEndings: [] } }
    Object.assign(terminal, { validation: { checkedChapterId: terminal.chapterId, checkedRevision: 3, independentCheck: 'complete', findings: [], errorCount: 0, warningCount: 0,
      coverage: compilerContinuityCoverage({ chapter: terminal.chapter, bridge: terminal.bridge, sceneTasks: terminal.sceneTasks, source: null }) } })
    db.chapterQualityReport.findFirst.mockResolvedValue({ id: 'q', chapterRevision: 3, status: 'passed', findings: [],
      deterministicMetrics: { independentCheck: 'complete', contentHash: createHash('sha256').update(terminal.chapter.content).digest('hex') } })
    db.storyCompilation.findMany.mockResolvedValue([terminal, { ...terminal, id: 'old-active', status: 'active' }])
    db.storyCompilation.findFirst.mockResolvedValue(terminal)
    const result = await chapterBridgeCommitTool.execute(ctx, {})
    expect(result.summary).toBe('提交章节桥与当前故事终态')
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
      { compilationId: 'foreign' })).toMatchObject({ outcome: 'failed', failureCode: 'COMPILATION_IDENTITY_MISMATCH', summary: '章节编译身份不匹配' })
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
      validation: { independentCheck: 'complete', checkedChapterId: chapter.id, checkedRevision: 3, findings: [], errorCount: 0, warningCount: 0,
        coverage: compilerContinuityCoverage({ chapter, bridge, sceneTasks: [], source: null }) } })
    db.chapterQualityReport.findFirst.mockResolvedValue({ id: 'q', chapterRevision: 3, status: 'passed', findings: [],
      deterministicMetrics: { independentCheck: 'complete', contentHash: createHash('sha256').update(chapter.content).digest('hex') } })
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
  it('a chapter id passed as compilationId fails and names the original next-chapter preparation path', async () => {
    const result = await chapterBridgeCommitTool.execute(ctx, { compilationId: 'old31' })
    expect(result).toMatchObject({ outcome: 'failed', failureCode: 'COMPILATION_NOT_FOUND' })
    expect(result.output).toContain('第 32 章')
    expect(result.output).toContain('story_compiler_prepare')
    expect(result.output).toContain('省略编辑器旧 chapterId')
    expect(db.storyCompilation.findMany.mock.calls[0][0].where).toMatchObject({ id: 'old31', run: { userId: 'u', novelId: 'n', sessionId: 'session', taskSpec: { path: ['id'] } } })
    expect(db.storyCompilation.create).not.toHaveBeenCalled(); expect(db.storyCompilation.updateMany).not.toHaveBeenCalled()
  })
  it.each([0, 1])('an existing unwritten next chapter with %s scenes directs the saved state forward without a new compiler', async scenes => {
    const prepared = { id: 'real-compiler', chapterId: null, targetOrderIndex: 32, stage: 'prepare', bridge: {}, chapter: null,
      sceneTasks: Array.from({ length: scenes }, (_, ordinal) => ({ ordinal })) }
    db.storyCompilation.findMany.mockResolvedValue([prepared])
    const result = await chapterBridgeCommitTool.execute(ctx, { compilationId: prepared.id })
    expect(result).toMatchObject({ outcome: 'failed', failureCode: 'COMPILATION_NOT_WRITTEN' })
    expect(result.output).toContain(scenes ? 'chapter_create' : 'scene_task_build')
    expect(result.output).toContain('real-compiler')
    expect(db.storyCompilation.create).not.toHaveBeenCalled(); expect(db.storyCompilation.updateMany).not.toHaveBeenCalled()
  })
  it('an invalid explicit compiler is not silently replaced by the real current one', async () => {
    db.storyCompilation.findFirst.mockResolvedValue({ id: 'real-compiler', chapterId: null, targetOrderIndex: 32, stage: 'prepare', chapter: null, sceneTasks: [] })
    const result = await chapterBridgeCommitTool.execute(ctx, { compilationId: 'old31' })
    expect(result.failureCode).toBe('COMPILATION_NOT_FOUND')
    expect(result.output).toContain('compilationId=real-compiler')
    expect(result.output).toContain('scene_task_build')
    expect(db.storyCompilation.updateMany).not.toHaveBeenCalled()
  })
  it('inherits the CAS-consumed new-draft marker and counters when repreparing across the original parent/child lineage', async () => {
    const marker = { version: 1, taskId: 'task', chapterId: 'own32', compilationId: 'old-compiler', checkedRevision: 3 }
    db.storyCompilation.findMany.mockResolvedValue([{ validation: { checkRounds: 2, autoRepairRounds: 0, newDraftRevision: marker } }])
    db.agentRun.findMany.mockResolvedValue([{ id: 'new-run' }])
    const result = await prepareStoryCompilation({ ...ctx, chapterId: undefined, mode: 'balanced', intentSummary: '写下一章' })
    expect(result.compilation.validation).toEqual({ checkRounds: 2, newDraftRevision: marker })
    expect(result.preparedFirstForTarget).toBe(false)
    expect(db.storyCompilation.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ runId: { in: ['new-run'] }, targetOrderIndex: 32 }) }))
  })
  it('rejects an explicit old chapter target from the next-chapter task without writes', async () => {
    await expect(prepareStoryCompilation({ userId: 'u', novelId: 'n', runId: 'new-run', chapterId: 'old31', mode: 'balanced', intentSummary: '恢复旧章' })).rejects.toMatchObject({ code: 'AUTHOR_CHAPTER_SCOPE' })
    expect(db.storyCompilation.create).not.toHaveBeenCalled()
    expect(db.storyCompilation.updateMany).not.toHaveBeenCalled()
  })
  it('keeps explicit author revision requests and same-contract continuation legal', async () => {
    db.agentRun.findFirst.mockResolvedValue({ id: 'new-run', userId: 'u', novelId: 'n', status: 'running', startRequest: { prompt: '修改当前章节' }, createdAt: new Date('2026-09-20T03:22:41Z'), runtimeProtocolVersion: 0, taskRootId: null, sessionId: 'session', taskSpec: spec('修改当前章节') })
    await storyCompilerPrepareTool.execute(ctx, { intentSummary: '修改当前章节' })
    expect(db.storyCompilation.create.mock.calls[0][0].data).toMatchObject({ chapterId: 'old31', targetOrderIndex: 31 })
    const nextSpec = spec('写下一章')
    db.agentRun.findFirst.mockResolvedValue({ id: 'new-run', userId: 'u', novelId: 'n', status: 'running', startRequest: { prompt: '写下一章' }, createdAt: new Date('2026-09-20T03:22:41Z'), runtimeProtocolVersion: 0, taskRootId: null, sessionId: 'session', taskSpec: nextSpec,
      writingBindings: { version: 1, taskId: nextSpec.id, targets: [{ orderIndex: 32, chapterId: 'own32' }] } })
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
    expect(db.storyCompilation.findFirst.mock.calls.some(([query]) => query.where.id === 'foreign-compilation'
      && JSON.stringify(query.where.run) === JSON.stringify(scope.run))).toBe(true)
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
  it('states that the current task has no compiler even without charter or historical bridge', async () => {
    expect(await buildStoryCompilerDigest('u', 'n', 'old31', 'new-run')).toContain('本任务尚未建立编译')
    expect(db.storyCompilation.create).not.toHaveBeenCalled()
    expect(await buildStoryCompilerDigest('u', 'n', null)).toBeNull()
  })
})
