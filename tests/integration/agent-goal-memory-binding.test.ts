import { randomUUID } from 'node:crypto'

import type { Prisma } from '@prisma/client'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import { env } from '../../api/config/env.js'
import { createAgentGoal } from '../../api/lib/agent/goal-service.js'
import { withGoalEffects, withGoalExecutionContext, type GoalExecutionContext } from '../../api/lib/agent/goal-context.js'
import { applyMemoryExtractionJob, enqueueChapterMemoryExtraction, processMemoryExtractionJob } from '../../api/lib/agent/story-memory.js'
import { prisma } from '../../api/lib/prisma.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)

type Fixture = {
  userId: string
  otherUserId: string
  novelId: string
  otherNovelId: string
  sessionId: string
  chapterId: string
  otherChapterId: string
  goalId: string
  runId: string
}

async function createFixture(): Promise<Fixture> {
  env.agentGoalEnabled = true
  const user = await prisma.user.create({ data: { nickname: `memory-goal-${randomUUID()}`, passwordHash: 'test-only-unusable' } })
  const otherUser = await prisma.user.create({ data: { nickname: `memory-other-${randomUUID()}`, passwordHash: 'test-only-unusable' } })
  try {
    const novel = await prisma.novel.create({ data: { authorId: user.id, title: '目标记忆绑定测试', slug: randomUUID(), summary: '' } })
    const otherNovel = await prisma.novel.create({ data: { authorId: otherUser.id, title: '其他用户作品', slug: randomUUID(), summary: '' } })
    const session = await prisma.agentSession.create({ data: { userId: user.id, novelId: novel.id, title: '目标记忆绑定测试会话' } })
    const volume = await prisma.volume.create({ data: { novelId: novel.id, title: '测试卷', orderIndex: 1 } })
    const otherVolume = await prisma.volume.create({ data: { novelId: otherNovel.id, title: '其他测试卷', orderIndex: 1 } })
    const chapter = await prisma.chapter.create({ data: { authorId: user.id, novelId: novel.id, volumeId: volume.id,
      title: '目标章节', content: '目标章节正文', orderIndex: 1, orderInVolume: 1, wordCount: 6 } })
    const otherChapter = await prisma.chapter.create({ data: { authorId: otherUser.id, novelId: otherNovel.id, volumeId: otherVolume.id,
      title: '其他章节', content: '其他章节正文', orderIndex: 1, orderInVolume: 1, wordCount: 6 } })
    const created = await createAgentGoal(user.id, { sessionId: session.id }, {
      requestId: randomUUID(), objective: '验证目标记忆绑定', options: { mode: 'build' },
      limits: { tokenLimit: 5_000, activeTimeLimitMs: 3_600_000 },
    }, { authenticatedHttp: true })
    const runId = randomUUID()
    await prisma.agentRun.create({ data: { id: runId, userId: user.id, novelId: novel.id, sessionId: session.id,
      status: 'queued', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'legacy' } })
    await prisma.agentGoalExecution.create({ data: { goalId: created.id, goalRevision: 1, epoch: 1n, runId,
      continuationIndex: 1, trigger: 'goal_auto', sourceEventId: `memory-fixture:${runId}` } })
    await prisma.agentGoal.update({ where: { id: created.id }, data: { currentRunId: runId, continuationIndex: 1, phase: 'executing' } })
    return { userId: user.id, otherUserId: otherUser.id, novelId: novel.id, otherNovelId: otherNovel.id,
      sessionId: session.id, chapterId: chapter.id, otherChapterId: otherChapter.id, goalId: created.id, runId }
  } catch (error) {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined)
    await prisma.user.delete({ where: { id: otherUser.id } }).catch(() => undefined)
    throw error
  }
}

async function cleanup(f: Fixture) {
  await prisma.agentGoal.deleteMany({ where: { userId: f.userId } })
  await prisma.agentRun.deleteMany({ where: { userId: f.userId } })
  await prisma.agentTaskRoot.deleteMany({ where: { userId: f.userId } })
  await prisma.agentSession.deleteMany({ where: { userId: f.userId } })
  await prisma.chapter.deleteMany({ where: { authorId: { in: [f.userId, f.otherUserId] } } })
  await prisma.projectMemoryEntry.deleteMany({ where: { novel: { authorId: { in: [f.userId, f.otherUserId] } } } })
  await prisma.novel.deleteMany({ where: { authorId: { in: [f.userId, f.otherUserId] } } })
  await prisma.user.delete({ where: { id: f.userId } }).catch(() => undefined)
  await prisma.user.delete({ where: { id: f.otherUserId } }).catch(() => undefined)
}

function contextFor(f: Fixture): GoalExecutionContext {
  return { goalId: f.goalId, revision: 1, epoch: 1n, userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, runId: f.runId }
}

async function enqueueBound(f: Fixture, chapterId = f.chapterId, chapterRevision = 1, after = '目标章节正文') {
  return prisma.$transaction(tx => withGoalExecutionContext(contextFor(f), () => withGoalEffects(() => enqueueChapterMemoryExtraction({
    novelId: f.novelId, chapterId, chapterRevision, before: '', after,
  }, tx))))
}

function mutableDiff(value: Prisma.JsonValue) {
  return structuredClone(value) as Prisma.InputJsonObject
}

describe.skipIf(!dbAvailable)('legacy goal memory job binding (isolated test DB)', () => {
  const fixtures: Fixture[] = []

  afterEach(async () => {
    while (fixtures.length) await cleanup(fixtures.pop()!)
  })

  afterAll(async () => { await prisma.$disconnect() })

  it('persists only the server goal scope and rejects pause plus resumed old epoch before claiming', async () => {
    const f = await createFixture(); fixtures.push(f)
    const jobId = await enqueueBound(f)
    const created = await prisma.memoryExtractionJob.findUniqueOrThrow({ where: { id: jobId } })
    expect(created.diff).toMatchObject({ goalBinding: {
      goalId: f.goalId, revision: 1, epoch: '1', userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, runId: f.runId,
    } })

    await prisma.agentGoal.update({ where: { id: f.goalId }, data: { status: 'paused', phase: 'idle', epoch: 2n } })
    await expect(processMemoryExtractionJob(jobId)).rejects.toMatchObject({ code: 'GOAL_EXECUTION_FENCED' })
    expect(await prisma.memoryExtractionJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: 'pending', attempts: 0 })
    expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })).toBe(0)

    // Resuming the goal creates a new epoch; an old pending job cannot borrow it.
    await prisma.agentGoal.update({ where: { id: f.goalId }, data: { status: 'active', phase: 'executing', epoch: 3n } })
    await expect(processMemoryExtractionJob(jobId)).rejects.toMatchObject({ code: 'GOAL_EXECUTION_FENCED' })
    expect(await prisma.memoryExtractionJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: 'pending', attempts: 0 })

    // A normal memory job has no goal binding and retains the pre-goal behavior.
    const ordinaryJobId = await prisma.$transaction(tx => enqueueChapterMemoryExtraction({
      novelId: f.otherNovelId, chapterId: f.otherChapterId, chapterRevision: 1, before: '', after: '其他章节正文',
    }, tx))
    await processMemoryExtractionJob(ordinaryJobId)
    expect(await prisma.memoryExtractionJob.findUniqueOrThrow({ where: { id: ordinaryJobId } })).toMatchObject({ status: 'completed' })
    expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.otherNovelId } })).toBeGreaterThan(0)
  })

  it('checks cross-user and cross-novel binding tampering, and preserves records already derived before pause', async () => {
    const f = await createFixture(); fixtures.push(f)
    const jobId = await enqueueBound(f)
    await prisma.memoryExtractionJob.update({ where: { id: jobId }, data: { diff: {
      ...mutableDiff((await prisma.memoryExtractionJob.findUniqueOrThrow({ where: { id: jobId } })).diff),
      goalBinding: { ...(contextFor(f)), epoch: '1' },
    } } })
    await processMemoryExtractionJob(jobId)
    expect(await prisma.memoryExtractionJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: 'completed' })
    const memoryCount = await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })
    expect(memoryCount).toBeGreaterThan(0)

    const crossUserJobId = await enqueueBound(f, f.chapterId, 2, '目标章节正文')
    const crossUserJob = await prisma.memoryExtractionJob.findUniqueOrThrow({ where: { id: crossUserJobId } })
    const crossUserDiff = mutableDiff(crossUserJob.diff)
    crossUserDiff.goalBinding = { ...(crossUserDiff.goalBinding as Prisma.InputJsonObject), userId: f.otherUserId }
    await prisma.memoryExtractionJob.update({ where: { id: crossUserJobId }, data: { diff: crossUserDiff } })
    await expect(processMemoryExtractionJob(crossUserJobId)).rejects.toMatchObject({ code: 'GOAL_EXECUTION_FENCED' })

    const crossNovelJobId = await enqueueBound(f, f.chapterId, 3, '目标章节正文')
    const crossNovelJob = await prisma.memoryExtractionJob.findUniqueOrThrow({ where: { id: crossNovelJobId } })
    const crossNovelDiff = mutableDiff(crossNovelJob.diff)
    crossNovelDiff.goalBinding = { ...(crossNovelDiff.goalBinding as Prisma.InputJsonObject), novelId: f.otherNovelId }
    await prisma.memoryExtractionJob.update({ where: { id: crossNovelJobId }, data: { diff: crossNovelDiff } })
    await expect(processMemoryExtractionJob(crossNovelJobId)).rejects.toMatchObject({ code: 'MEMORY_JOB_SOURCE_MISMATCH' })
    expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.otherNovelId } })).toBe(0)

    await prisma.agentGoal.update({ where: { id: f.goalId }, data: { status: 'paused', phase: 'idle', epoch: 2n } })
    await processMemoryExtractionJob(jobId)
    expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })).toBe(memoryCount)
  })

  it('rechecks the binding in direct apply transactions, including a pause racing claim', async () => {
    const f = await createFixture(); fixtures.push(f)
    const jobId = await enqueueBound(f)
    await prisma.agentGoal.update({ where: { id: f.goalId }, data: { status: 'paused', phase: 'idle', epoch: 2n } })
    await expect(prisma.$transaction(tx => applyMemoryExtractionJob(tx, jobId))).rejects.toMatchObject({ code: 'GOAL_EXECUTION_FENCED' })
    expect(await prisma.memoryExtractionJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: 'pending' })
    expect(await prisma.projectMemoryEntry.count({ where: { novelId: f.novelId } })).toBe(0)
  })
})
