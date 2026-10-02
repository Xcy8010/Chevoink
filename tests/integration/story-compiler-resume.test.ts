import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { buildStoryCompilerDigest, prepareStoryCompilation, saveSceneTasks, validateStoryContinuity } from '../../api/lib/agent/story-compiler.js'
import { getLatestQualityReport, hasCommittedTaskChapter, persistHumanityQualityReport } from '../../api/lib/agent/humanity-quality.js'
import { chapterBridgeCommitTool, chapterBridgeGetTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import * as flags from '../../api/lib/agent2-feature-flags.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'

const available = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
afterEach(() => vi.restoreAllMocks())
afterAll(() => prisma.$disconnect())

async function fixture(work: (f: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const f = await createFixture()
  try { await work(f) } finally { await cleanupFixture(f.ctx.userId) }
}

async function cleanupFixture(userId: string) {
  // Goal deletion cascades revisions/executions (including their deferred FK).
  // Runs RESTRICT session deletion; artifacts RESTRICT run deletion. The goal's
  // currentRunId is an unreferenced scalar, so removing goals first also clears
  // that pointer before its run is deleted. Match the proven runtime DB fixture.
  await prisma.agentGoal.deleteMany({ where: { userId } })
  await prisma.agentArtifact.deleteMany({ where: { run: { userId } } })
  // COMMIT creates memory proposals; their novel FK is RESTRICT. Deleting these
  // owned proposals cascades their MemoryEvidence/MemoryRevision children.
  await prisma.projectMemoryEntry.deleteMany({ where: { novel: { authorId: userId } } })
  await prisma.agentRun.deleteMany({ where: { userId } })
  await prisma.agentTaskRoot.deleteMany({ where: { userId } })
  await prisma.agentSession.deleteMany({ where: { userId } })
  await prisma.chapter.deleteMany({ where: { authorId: userId } })
  await prisma.novel.deleteMany({ where: { authorId: userId } })
  await prisma.user.delete({ where: { id: userId } })
}

async function createFixture() {
  const user = await prisma.user.create({ data: { nickname: 'compiler-resume-fixture', passwordHash: 'test-only-unusable' } })
  try {
    const novel = await prisma.novel.create({ data: { authorId: user.id, title: '恢复原编译', slug: randomUUID(), summary: '' } })
    const volume = await prisma.volume.create({ data: { novelId: novel.id, title: '测试卷', orderIndex: 1 } })
    const chapter = await prisma.chapter.create({ data: { novelId: novel.id, authorId: user.id, volumeId: volume.id,
      title: '测试章', orderIndex: 1, orderInVolume: 1, content: '他绕过锁门，在墙根发现了脚印。', wordCount: 16 } })
    const session = await prisma.agentSession.create({ data: { userId: user.id, novelId: novel.id, title: '同任务恢复' } })
    const originalId = randomUUID(), resumedId = randomUUID()
    const task = buildTaskSpec({ runId: originalId, novelId: novel.id, chapterId: chapter.id, prompt: '完成当前章节' })
    const runData = { userId: user.id, novelId: novel.id, sessionId: session.id, chapterId: chapter.id, mode: 'act' as const,
      action: 'workspaceAgent', agentType: 'writingOrchestrator' as const, engine: 'loop' as const, taskSpec: JSON.parse(JSON.stringify(task)) }
    await prisma.agentRun.create({ data: { ...runData, id: originalId, status: 'paused' } })
    // Reproduce the persisted production defect: goal admission copied the whole
    // contract, retaining the original attempt id on a new execution.
    await prisma.agentRun.create({ data: { ...runData, id: resumedId, status: 'running' } })
    const goal = await prisma.agentGoal.create({ data: { userId: user.id, novelId: novel.id, sessionId: session.id,
      currentRunId: resumedId, continuationIndex: 2, executionOptions: {},
      revisions: { create: { revision: 1, objective: '完成当前章节', request: {}, sourceActionId: randomUUID(),
        authorityHash: runtimeJson({ objective: '完成当前章节', options: {}, novelId: novel.id, userId: user.id }).hash } },
    } })
    await prisma.agentGoalExecution.createMany({ data: [
      { goalId: goal.id, goalRevision: 1, epoch: 1n, runId: originalId, continuationIndex: 1, trigger: 'author', sourceEventId: randomUUID() },
      { goalId: goal.id, goalRevision: 1, epoch: 2n, runId: resumedId, continuationIndex: 2, trigger: 'goal_auto', sourceEventId: randomUUID() },
    ] })
    const ctx: ToolContext = { userId: user.id, novelId: novel.id, sessionId: session.id, chapterId: chapter.id, runId: resumedId,
      callId: 'resume-commit', mode: 'build', creativeFreedom: 'stable', qualityMode: 'balanced', signal: new AbortController().signal, emit: () => {} }
    const prepared = await prepareStoryCompilation({ userId: user.id, novelId: novel.id, runId: originalId,
      chapterId: chapter.id, mode: 'balanced', intentSummary: '完成当前章节' })
    return { ctx, originalId, task, chapter, compilationId: prepared.compilation.id }
  } catch (error) {
    try { await cleanupFixture(user.id) } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Compiler resume fixture setup and cleanup failed')
    }
    throw error
  }
}

async function check(f: Awaited<ReturnType<typeof createFixture>>, compilationId = f.compilationId) {
  const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
  await saveSceneTasks({ ...f.ctx, compilationId, tasks: [{ purpose: '推进调查', entryState: state, goal: '寻找线索',
    obstacle: '门已上锁', choice: '绕路', cost: '耗费时间', turn: '发现脚印', exitState: state,
    styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' } }] })
  await validateStoryContinuity({ ...f.ctx, compilationId, findings: [], expectedChapterRevision: f.chapter.revision, independentCheck: 'complete' })
  return persistHumanityQualityReport({ ...f.ctx, compilationId, chapterRevision: f.chapter.revision, mode: 'balanced',
    criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
}

describe.skipIf(!available)('compiler recovery through historical goal continuation (isolated DB)', () => {
  it('reads and commits the original compilation, scenes and version-bound report exactly once', async () => {
    vi.spyOn(flags, 'isAgent2FeatureEnabled').mockReturnValue(true)
    await fixture(async f => {
      const report = await check(f)
      const beforeChapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapter.id } })
      const beforeScenes = await prisma.sceneTask.findMany({ where: { compilationId: f.compilationId }, orderBy: { ordinal: 'asc' } })
      expect(await chapterBridgeGetTool.execute(f.ctx, {})).toMatchObject({ display: { compilationId: f.compilationId } })
      const digest = await buildStoryCompilerDigest(f.ctx.userId, f.ctx.novelId, f.chapter.id, f.ctx.runId)
      expect(digest).toContain(f.compilationId)
      expect(digest).toContain(report.id)
      expect(digest).toContain(`当前正文 r${f.chapter.revision}`)
      const first = await chapterBridgeCommitTool.execute(f.ctx, {})
      expect(first).toMatchObject({ summary: '提交章节桥与故事终态', display: { compilationId: f.compilationId } })
      const memoryCount = await prisma.projectMemoryEntry.count({ where: { novelId: f.ctx.novelId } })
      expect(await chapterBridgeCommitTool.execute(f.ctx, {})).toMatchObject({ summary: '章节终态已提交', display: { compilationId: f.compilationId } })
      expect(await prisma.storyCompilation.count({ where: { novelId: f.ctx.novelId } })).toBe(1)
      expect(await prisma.chapterQualityReport.count({ where: { novelId: f.ctx.novelId } })).toBe(1)
      expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.ctx.novelId } })).toBe(memoryCount)
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapter.id } })).toEqual(beforeChapter)
      const afterScenes = await prisma.sceneTask.findMany({ where: { compilationId: f.compilationId }, orderBy: { ordinal: 'asc' } })
      expect(afterScenes.map(scene => ({ id: scene.id, purpose: scene.purpose, entryState: scene.entryState, exitState: scene.exitState })))
        .toEqual(beforeScenes.map(scene => ({ id: scene.id, purpose: scene.purpose, entryState: scene.entryState, exitState: scene.exitState })))
      expect(afterScenes.every(scene => scene.status === 'completed')).toBe(true)
    })
  })

  it('does not certify an unchanged compiler with a report belonging to a different compilation', async () => {
    vi.spyOn(flags, 'isAgent2FeatureEnabled').mockReturnValue(true)
    await fixture(async f => {
      const report = await check(f)
      const otherSession = await prisma.agentSession.create({ data: { userId: f.ctx.userId, novelId: f.ctx.novelId, title: '其他任务' } })
      const otherRun = await prisma.agentRun.create({ data: { userId: f.ctx.userId, novelId: f.ctx.novelId, sessionId: otherSession.id,
        mode: 'act', status: 'running', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop' } })
      const other = await prepareStoryCompilation({ ...f.ctx, runId: otherRun.id, chapterId: f.chapter.id, mode: 'balanced', intentSummary: '其他独立任务' })
      await persistHumanityQualityReport({ ...f.ctx, runId: otherRun.id, compilationId: other.compilation.id, chapterRevision: f.chapter.revision,
        mode: 'balanced', criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
      expect((await getLatestQualityReport(f.ctx.userId, f.ctx.novelId, f.chapter.id, prisma, f.compilationId))?.id).toBe(report.id)
      expect(await chapterBridgeCommitTool.execute(f.ctx, { compilationId: other.compilation.id })).toMatchObject({ outcome: 'failed' })
      expect(await chapterBridgeCommitTool.execute(f.ctx, { compilationId: f.chapter.id })).toMatchObject({ outcome: 'failed' })
      await expect(chapterBridgeCommitTool.execute({ ...f.ctx, novelId: 'wrong-novel' }, {})).rejects.toMatchObject({ code: 'QUALITY_RUN_SCOPE_INVALID' })
      expect(await chapterBridgeCommitTool.execute(f.ctx, {})).toMatchObject({ summary: '提交章节桥与故事终态', display: { compilationId: f.compilationId } })
      expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: other.compilation.id } })).status).toBe('active')
    })
  })

  it('keeps the newer completed identity visible when the historical older compiler is still active', async () => {
    vi.spyOn(flags, 'isAgent2FeatureEnabled').mockReturnValue(true)
    await fixture(async f => {
      await check(f)
      const next = await prepareStoryCompilation({ ...f.ctx, chapterId: f.chapter.id, mode: 'balanced', intentSummary: '历史绕路重新准备' })
      await check(f, next.compilation.id)
      expect(await chapterBridgeCommitTool.execute(f.ctx, { compilationId: next.compilation.id })).toMatchObject({ display: { compilationId: next.compilation.id } })
      await prisma.storyCompilation.update({ where: { id: f.compilationId }, data: { status: 'active' } })
      expect(await chapterBridgeCommitTool.execute(f.ctx, {})).toMatchObject({ summary: '章节终态已提交', display: { compilationId: next.compilation.id } })
      expect(await chapterBridgeCommitTool.execute(f.ctx, { compilationId: f.compilationId })).toMatchObject({ outcome: 'failed', summary: '章节编译已被后续准备替代' })
      expect(await buildStoryCompilerDigest(f.ctx.userId, f.ctx.novelId, f.chapter.id, f.ctx.runId)).toContain(`本任务编译：${next.compilation.id}`)
      expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: next.compilation.id } })).status).toBe('completed')
      expect(await hasCommittedTaskChapter(prisma, f.ctx.userId, f.ctx.novelId, f.ctx.runId)).toBe(true)
    })
  })

  it.each(['completed-origin', 'changed-contract', 'other-session'] as const)('rejects %s without reading or replacing its saved compiler', async scenario => {
    await fixture(async f => {
      const before = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilationId } })
      if (scenario === 'completed-origin') await prisma.agentRun.update({ where: { id: f.originalId }, data: { status: 'completed' } })
      if (scenario === 'changed-contract') await prisma.agentRun.update({ where: { id: f.originalId }, data: {
        taskSpec: JSON.parse(JSON.stringify({ ...f.task, goals: ['另一个已结束任务'] })),
      } })
      if (scenario === 'other-session') {
        const otherSession = await prisma.agentSession.create({ data: { userId: f.ctx.userId, novelId: f.ctx.novelId, title: '另一个会话' } })
        await prisma.agentRun.update({ where: { id: f.originalId }, data: { sessionId: otherSession.id } })
      }
      await expect(chapterBridgeGetTool.execute(f.ctx, { compilationId: f.compilationId })).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_MISMATCH' })
      expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilationId } })).toEqual(before)
      expect(await prisma.storyCompilation.count({ where: { novelId: f.ctx.novelId } })).toBe(1)
    })
  })

  it('rejects stale version receipts on resume and preserves the author revision without re-preparing', async () => {
    vi.spyOn(flags, 'isAgent2FeatureEnabled').mockReturnValue(true)
    await fixture(async f => {
      await check(f)
      const authorRevision = await prisma.chapter.update({ where: { id: f.chapter.id }, data: { content: '作者修改后的正文', revision: { increment: 1 } } })
      expect(await chapterBridgeCommitTool.execute(f.ctx, {})).toMatchObject({ outcome: 'failed', summary: '等待单次质量检查' })
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapter.id } })).toEqual(authorRevision)
      expect(await prisma.storyCompilation.count({ where: { novelId: f.ctx.novelId } })).toBe(1)
      expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilationId } })).status).toBe('active')
      expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: f.compilationId } })).committedAt).toBeNull()
    })
  })
})
