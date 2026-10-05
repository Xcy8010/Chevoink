import { createHash, randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { env } from '../../api/config/env.js'
import { prisma } from '../../api/lib/prisma.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { buildStoryCompilerDigest, commitChapterBridge, prepareStoryCompilation, saveSceneTasks, validateStoryContinuity } from '../../api/lib/agent/story-compiler.js'
import { getLatestQualityReport, hasCommittedTaskChapter, persistHumanityQualityReport } from '../../api/lib/agent/humanity-quality.js'
import { chapterBridgeCommitTool, chapterBridgeGetTool, continuityValidateTool } from '../../api/lib/agent/tools/story-compiler-tools.js'
import * as review from '../../api/lib/agent/review-completion.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import * as flags from '../../api/lib/agent2-feature-flags.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { assertRunGoalFence, readGoalExecution } from '../../api/lib/agent/goal-fence.js'
import { assertAgentManuscriptCurrent } from '../../api/lib/agent/manuscript-scope.js'

const available = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
const previousGoalEnabled = env.agentGoalEnabled
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  env.agentGoalEnabled = previousGoalEnabled
  await prisma.$disconnect()
})

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
      manuscriptRevision: novel.manuscriptRevision,
      action: 'workspaceAgent', agentType: 'writingOrchestrator' as const, engine: 'loop' as const, startRequest: { prompt: '完成当前章节' }, taskSpec: JSON.parse(JSON.stringify(task)) }
    await prisma.agentRun.create({ data: { ...runData, id: originalId, status: 'running' } })
    const prepared = await prepareStoryCompilation({ userId: user.id, novelId: novel.id, runId: originalId,
      chapterId: chapter.id, mode: 'balanced', intentSummary: '完成当前章节' })
    await prisma.agentRun.update({ where: { id: originalId }, data: { status: 'paused' } })
    // Reproduce the persisted production defect: goal admission copied the whole
    // contract, retaining the original attempt id on a new execution.
    await prisma.agentRun.create({ data: { ...runData, id: resumedId, status: 'running' } })
    const goal = await prisma.agentGoal.create({ data: { userId: user.id, novelId: novel.id, sessionId: session.id,
      currentRunId: resumedId, continuationIndex: 2, executionOptions: {}, epoch: 2n,
      status: 'active', currentRevision: 1, pendingRevision: null,
      revisions: { create: { revision: 1, objective: '完成当前章节', request: {}, sourceActionId: randomUUID(),
        authorityHash: runtimeJson({ objective: '完成当前章节', options: {}, novelId: novel.id, userId: user.id }).hash } },
    } })
    await prisma.agentGoalExecution.createMany({ data: [
      { goalId: goal.id, goalRevision: 1, epoch: 1n, runId: originalId, continuationIndex: 1, trigger: 'author', sourceEventId: randomUUID() },
      { goalId: goal.id, goalRevision: 1, epoch: 2n, runId: resumedId, continuationIndex: 2, trigger: 'goal_auto', sourceEventId: randomUUID() },
    ] })
    const ctx: ToolContext = { userId: user.id, novelId: novel.id, sessionId: session.id, chapterId: chapter.id, runId: resumedId,
      callId: 'resume-commit', mode: 'build', creativeFreedom: 'stable', qualityMode: 'balanced', signal: new AbortController().signal, emit: () => {} }
    // Prove the actual resumed execution is writable before the test reaches any
    // quality/commit assertions: feature, owner/scope, active goal/run, revision,
    // epoch and manuscript generation must satisfy the production guards.
    expect(await readGoalExecution(ctx.userId, ctx.runId)).toEqual({ goalId: goal.id, revision: 1, epoch: 2n,
      userId: ctx.userId, novelId: ctx.novelId, sessionId: ctx.sessionId, runId: ctx.runId })
    await prisma.$transaction(async tx => {
      expect(await assertRunGoalFence(tx, ctx.userId, ctx.runId)).toMatchObject({ goalId: goal.id, revision: 1, epoch: 2n })
      await assertAgentManuscriptCurrent(tx, ctx)
    })
    return { ctx, originalId, task, chapter, manuscriptRevision: novel.manuscriptRevision, compilationId: prepared.compilation.id }
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
  beforeAll(() => { env.agentGoalEnabled = true })
  it('recovers prepare/zero scenes and beat/saved scenes from persisted state without treating empty prose or assistant history as completion', async () => {
    await fixture(async f => {
      await prisma.chapter.update({ where: { id: f.chapter.id }, data: { content: '  \n', wordCount: 0 } })
      const before = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilationId }, include: { bridge: true, sceneTasks: true } })
      const prepared = await buildStoryCompilerDigest(f.ctx.userId, f.ctx.novelId, f.chapter.id, f.ctx.runId)
      expect(prepared).toContain('阶段 prepare')
      expect(prepared).toContain('Scene Task 0 个')
      expect(prepared).toContain('下一步调用 scene_task_build')
      expect(prepared).toContain('正文为空，未写完')
      expect(prepared).not.toContain('不重复 PREPARE/BEAT')
      expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilationId }, include: { bridge: true, sceneTasks: true } })).toEqual(before)
      const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
      await saveSceneTasks({ ...f.ctx, compilationId: f.compilationId, tasks: [{ purpose: '合成推进', entryState: state, goal: '找线索',
        obstacle: '锁门', choice: '绕路', cost: '时间', turn: '发现脚印', exitState: state, styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' } }] })
      const beat = await buildStoryCompilerDigest(f.ctx.userId, f.ctx.novelId, f.chapter.id, f.ctx.runId)
      expect(beat).toContain('阶段 beat')
      expect(beat).toContain('Scene Task 1 个')
      expect(beat).toContain('不重复 PREPARE/BEAT')
      expect(beat).toContain('调用 chapter_write 保存正文')
      expect(beat).not.toContain('下一步调用 scene_task_build')
      expect(beat).toContain('不能宣称已写完或完成')
      expect(await prisma.storyCompilation.count({ where: { novelId: f.ctx.novelId } })).toBe(1)
    })
  })
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
      expect(first).toMatchObject({ summary: '提交章节桥与当前故事终态', display: { compilationId: f.compilationId } })
      const memoryCount = await prisma.projectMemoryEntry.count({ where: { novelId: f.ctx.novelId } })
      expect(memoryCount).toBeGreaterThan(0)
      expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.ctx.novelId, runId: f.ctx.runId } })).toBe(memoryCount)
      expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: f.originalId } })).status).toBe('paused')
      expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilationId } })).runId).toBe(f.originalId)
      expect(await chapterBridgeCommitTool.execute(f.ctx, {})).toMatchObject({ summary: '提交章节桥与当前故事终态', display: { compilationId: f.compilationId } })
      expect(await buildStoryCompilerDigest(f.ctx.userId, f.ctx.novelId, f.chapter.id, f.ctx.runId)).toContain('终态已提交且匹配当前正文 revision/hash')
      expect(await prisma.storyCompilation.count({ where: { novelId: f.ctx.novelId } })).toBe(1)
      expect(await prisma.chapterQualityReport.count({ where: { novelId: f.ctx.novelId } })).toBe(1)
      expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.ctx.novelId } })).toBe(memoryCount)
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapter.id } })).toEqual(beforeChapter)
      const afterScenes = await prisma.sceneTask.findMany({ where: { compilationId: f.compilationId }, orderBy: { ordinal: 'asc' } })
      expect(afterScenes.map(scene => ({ id: scene.id, purpose: scene.purpose, entryState: scene.entryState, exitState: scene.exitState })))
        .toEqual(beforeScenes.map(scene => ({ id: scene.id, purpose: scene.purpose, entryState: scene.entryState, exitState: scene.exitState })))
      expect(afterScenes.every(scene => scene.status === 'completed')).toBe(true)
      await prisma.chapter.update({ where: { id: f.chapter.id }, data: { content: '同版本正文变更的合成回归' } })
      const stale = await buildStoryCompilerDigest(f.ctx.userId, f.ctx.novelId, f.chapter.id, f.ctx.runId)
      expect(stale).not.toContain('终态已提交且匹配当前正文 revision/hash')
      expect(stale).toContain('不能宣称完成')
      await prisma.chapter.update({ where: { id: f.chapter.id }, data: { content: '  ', wordCount: 0 } })
      const empty = await buildStoryCompilerDigest(f.ctx.userId, f.ctx.novelId, f.chapter.id, f.ctx.runId)
      expect(empty).not.toContain('终态已提交且匹配当前正文 revision/hash')
      expect(empty).toContain('尚无合法非空正文')
    })
  })
  it('chapter-only post-quality CHECK persists the exact resumed compiler revision, reuses without another critic and commits warnings without a rewrite loop', async () => {
    vi.spyOn(flags, 'isAgent2FeatureEnabled').mockImplementation(name => name === 'humanityQuality')
    await fixture(async f => {
      const report = await check(f)
      const changed = await prisma.chapter.update({ where: { id: f.chapter.id }, data: { content: '他绕过锁门，在墙根发现一串刚留下的脚印。', revision: { increment: 1 } } })
      await prisma.chapterQualityReport.update({ where: { id: report.id }, data: { status: 'repaired', chapterRevision: changed.revision, repairRound: 1,
        deterministicMetrics: { independentCheck: 'complete', repairedContentHash: createHash('sha256').update(changed.content).digest('hex'), sourceRevision: f.chapter.revision } } })
      await prisma.chapterBridge.update({ where: { compilationId: f.compilationId }, data: { targetRevision: changed.revision } })
      await prisma.storyCompilation.update({ where: { id: f.compilationId }, data: { stage: 'repair' } })
      const ctx = { ...f.ctx, creativeFreedom: 'balanced' as const }
      expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilationId } })).validation).toMatchObject({ checkedRevision: f.chapter.revision })
      expect(changed.revision).not.toBe(f.chapter.revision)
      const critic = vi.spyOn(review, 'generateReviewCompletion').mockResolvedValue(JSON.stringify({ findings: [
        { signal: 'body', severity: 'warning', evidence: '脚印仍待解释', suggestion: '保留待审' },
        { signal: 'hook', severity: 'warning', evidence: '锁门线索未揭晓', suggestion: '保留待审' },
      ] }))
      expect(await continuityValidateTool.execute(ctx, { chapterId: changed.id })).toMatchObject({ display: { compilationId: f.compilationId, errorCount: 0, warningCount: 2 } })
      const checked = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilationId } })
      expect(checked).toMatchObject({ runId: f.originalId, stage: 'check', validation: { checkedRevision: changed.revision, independentCheck: 'complete',
        coverage: { contentHash: runtimeJson({ content: changed.content }).hash, reviewHash: expect.stringMatching(/^[a-f0-9]{64}$/) } } })
      expect(await continuityValidateTool.execute(ctx, { chapterId: changed.id })).toMatchObject({ summary: '复用连续性检查 · 0 错误 2 警告' })
      expect(critic).toHaveBeenCalledOnce()
      expect(critic.mock.calls[0][1]).toContain('本次只读复核')
      expect(await prisma.agentArtifact.count({ where: { runId: ctx.runId, artifactType: 'continuityReview' } })).toBe(0)
      expect(await chapterBridgeCommitTool.execute(ctx, {})).toMatchObject({ summary: '提交章节桥与当前故事终态', display: { compilationId: f.compilationId } })
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: changed.id } })).toEqual(changed)
      expect(await prisma.chapterQualityReport.count({ where: { chapterId: changed.id } })).toBe(1)
    })
  })

  it('does not certify an unchanged compiler with a report belonging to a different compilation', async () => {
    vi.spyOn(flags, 'isAgent2FeatureEnabled').mockReturnValue(true)
    await fixture(async f => {
      const report = await check(f)
      const otherSession = await prisma.agentSession.create({ data: { userId: f.ctx.userId, novelId: f.ctx.novelId, title: '其他任务' } })
      const otherRun = await prisma.agentRun.create({ data: { userId: f.ctx.userId, novelId: f.ctx.novelId, sessionId: otherSession.id,
        chapterId: f.chapter.id, mode: 'act', status: 'running', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop',
        startRequest: { prompt: '完成当前章节的独立任务' } } })
      await prisma.agentRun.update({ where: { id: otherRun.id }, data: { taskSpec: JSON.parse(JSON.stringify(
        buildTaskSpec({ runId: otherRun.id, novelId: f.ctx.novelId, chapterId: f.chapter.id, prompt: '完成当前章节的独立任务' }))) } })
      const other = await prepareStoryCompilation({ ...f.ctx, runId: otherRun.id, chapterId: f.chapter.id, mode: 'balanced', intentSummary: '其他独立任务' })
      await persistHumanityQualityReport({ ...f.ctx, runId: otherRun.id, compilationId: other.compilation.id, chapterRevision: f.chapter.revision,
        mode: 'balanced', criticComplete: true, criticFindings: [], deterministicFindings: [], deterministicMetrics: {} })
      expect((await getLatestQualityReport(f.ctx.userId, f.ctx.novelId, f.chapter.id, prisma, f.compilationId))?.id).toBe(report.id)
      expect(await chapterBridgeCommitTool.execute(f.ctx, { compilationId: other.compilation.id })).toMatchObject({ outcome: 'failed' })
      expect(await chapterBridgeCommitTool.execute(f.ctx, { compilationId: f.chapter.id })).toMatchObject({ outcome: 'failed' })
      await expect(chapterBridgeCommitTool.execute({ ...f.ctx, novelId: 'wrong-novel' }, {})).rejects.toMatchObject({ code: 'QUALITY_RUN_SCOPE_INVALID' })
      expect(await chapterBridgeCommitTool.execute(f.ctx, {})).toMatchObject({ summary: '提交章节桥与当前故事终态', display: { compilationId: f.compilationId } })
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
      expect(await chapterBridgeCommitTool.execute(f.ctx, {})).toMatchObject({ summary: '提交章节桥与当前故事终态', display: { compilationId: next.compilation.id } })
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

  it('rejects a stale captured terminal revision on resume and preserves the author revision without re-preparing', async () => {
    vi.spyOn(flags, 'isAgent2FeatureEnabled').mockReturnValue(true)
    await fixture(async f => {
      await check(f)
      const authorRevision = await prisma.chapter.update({ where: { id: f.chapter.id }, data: { content: '作者修改后的正文', revision: { increment: 1 } } })
      await expect(commitChapterBridge({ ...f.ctx, compilationId: f.compilationId, expectedChapterRevision: f.chapter.revision,
        expectedContentHash: createHash('sha256').update(f.chapter.content).digest('hex'), chapterSummary: '旧版本摘要',
        exitState: { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] },
        lastUnfinishedAction: '', hookDecision: '', delayedHookReason: '', openingStructure: '动作', endingStructure: '转折' }))
        .rejects.toMatchObject({ code: 'CONTINUITY_INPUT_STALE' })
      expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapter.id } })).toEqual(authorRevision)
      expect(await prisma.storyCompilation.count({ where: { novelId: f.ctx.novelId } })).toBe(1)
      expect((await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilationId } })).status).toBe('active')
      expect((await prisma.chapterBridge.findUniqueOrThrow({ where: { compilationId: f.compilationId } })).committedAt).toBeNull()
    })
  })

  it.each(['paused-run', 'wrong-task', 'stale-epoch'] as const)('rejects commit by %s before any bridge, scene, or memory effect', async scenario => {
    await fixture(async f => {
      const report = await check(f)
      let committingRunId = f.ctx.runId
      if (scenario === 'paused-run') await prisma.agentRun.update({ where: { id: committingRunId }, data: { status: 'paused' } })
      if (scenario === 'stale-epoch') await prisma.agentGoal.updateMany({ where: { userId: f.ctx.userId }, data: { epoch: 3n } })
      if (scenario === 'wrong-task') {
        committingRunId = randomUUID()
        const otherTask = buildTaskSpec({ runId: committingRunId, novelId: f.ctx.novelId, chapterId: f.chapter.id, prompt: '另一个任务' })
        const otherSession = await prisma.agentSession.create({ data: { userId: f.ctx.userId, novelId: f.ctx.novelId, title: '不同任务' } })
        await prisma.agentRun.create({ data: { id: committingRunId, userId: f.ctx.userId, novelId: f.ctx.novelId, sessionId: otherSession.id,
          chapterId: f.chapter.id, manuscriptRevision: f.manuscriptRevision,
          mode: 'act', status: 'running', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop',
          taskSpec: JSON.parse(JSON.stringify(otherTask)), startRequest: { prompt: '另一个任务' } } })
      }
      const before = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilationId }, include: { bridge: true, sceneTasks: true } })
      const state = { knowledge: [], emotion: [], body: [], objects: [], relationships: [], openLoops: [] }
      await expect(commitChapterBridge({ userId: f.ctx.userId, novelId: f.ctx.novelId, runId: committingRunId,
        compilationId: f.compilationId, chapterSummary: '未授权提交', exitState: state, lastUnfinishedAction: '', hookDecision: '',
        delayedHookReason: '', openingStructure: '动作', endingStructure: '转折', requireQuality: true, qualityReportId: report.id }))
        .rejects.toMatchObject({ code: scenario === 'wrong-task' ? 'COMPILATION_NOT_FOUND' : 'GOAL_EXECUTION_FENCED' })
      expect(await prisma.storyCompilation.findUniqueOrThrow({ where: { id: f.compilationId }, include: { bridge: true, sceneTasks: true } })).toEqual(before)
      expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.ctx.novelId } })).toBe(0)
      expect(await prisma.chapterQualityReport.count({ where: { novelId: f.ctx.novelId } })).toBe(1)
    })
  })
})
