import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { env } from '../../api/config/env.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { createAgentGoal, actOnAgentGoal, pauseGoalForRun, readAgentGoal, updateAgentGoal } from '../../api/lib/agent/goal-service.js'
import { superviseAgentGoal } from '../../api/lib/agent/goal-supervisor.js'
import { initializeDurableTask } from '../../api/lib/agent/runtime-identity.js'
import { acquireRunLease, type RunLeaseToken } from '../../api/lib/agent/runtime-lease.js'
import { commitOperationEffect, markProviderDispatched, prepareOperation, prepareProviderAttempt, recordProviderResult, recordProviderUsage } from '../../api/lib/agent/runtime-operations.js'
import { initializeExecutionState, loadExecutionState, saveExecutionState } from '../../api/lib/agent/runtime-state.js'
import { resolveDurableQuestion } from '../../api/lib/agent/runtime-question.js'
import { resolveDurableApproval } from '../../api/lib/agent/runtime-approval.js'
import { resolveLoopRunQuestion } from '../../api/lib/agent/run-service.js'
import { waitForQuestionAnswer } from '../../api/lib/agent/permissions.js'
import { observeGoalUsage } from '../../api/lib/agent/goal-budget.js'
import { withGoalDatabaseFences } from '../../api/lib/agent/goal-database.js'
import { withGoalEffects, withGoalExecutionContext, type GoalExecutionContext } from '../../api/lib/agent/goal-context.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'
import { readGoalSavedProgress } from '../../api/lib/agent/goal-saved-progress.js'
import { inspectGoalEvidence } from '../../api/lib/agent/goal-evidence.js'

const available = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)

type Fixture = {
  userId: string
  novelId: string
  sessionId: string
  chapterId: string
  goalId: string
  runId: string
  rootId: string
  lease: RunLeaseToken
}

const executionConfiguration = {
  version: 1 as const,
  mode: 'build' as const,
  agentType: 'orchestrator',
  creativeFreedom: 'balanced' as const,
  qualityMode: 'premium' as const,
  model: { tier: 'speed', provider: 'fixture', modelName: 'fixture', customModelId: null,
    reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
  tools: [{ type: 'function' as const, function: { name: 'chapter_write', description: 'fixture write', parameters: { type: 'object' } } }],
  toolAuthority: [{ name: 'chapter_write', permission: 'allow' as const, alwaysConfirm: false, dangerous: false }],
  protectedChapterIds: [], pinnedSkillVersions: [],
}

function executionSnapshot() {
  return { version: 1 as const, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle' as const,
    pendingOperationId: null, messages: [{ role: 'user' as const, content: 'runtime fixture' }], successfulToolSignatures: [] }
}

async function createGoalRun(f: Pick<Fixture, 'userId' | 'novelId' | 'sessionId' | 'goalId'>, trigger: 'goal_auto' | 'subagent', continuationIndex: number) {
  const runId = randomUUID()
  const sourceMessageId = randomUUID()
  const spec = buildTaskSpec({ runId, novelId: f.novelId, chapterId: null, prompt: '完成持久目标测试' })
  await prisma.agentRun.create({ data: { id: runId, userId: f.userId, novelId: f.novelId, sessionId: f.sessionId,
    status: 'queued', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', taskSpec: JSON.parse(JSON.stringify(spec)) } })
  await prisma.agentMessage.create({ data: { id: sourceMessageId, runId, sessionId: f.sessionId, role: 'system', parts: [{ type: 'text', text: 'goal runtime fixture' }] } })
  await prisma.agentGoalExecution.create({ data: { goalId: f.goalId, goalRevision: 1, epoch: 1n, runId,
    continuationIndex, trigger, sourceEventId: `fixture:${f.goalId}:${runId}` } })
  const root = await initializeDurableTask({ userId: f.userId, runId, sourceMessageId })
  const lease = await acquireRunLease({ userId: f.userId, runId, ownerId: `fixture-${trigger}`, claimId: randomUUID() })
  await initializeExecutionState(lease, { configuration: executionConfiguration, snapshot: executionSnapshot() })
  return { runId, rootId: root.id, lease }
}

async function fixture(tokenLimit = 5_000): Promise<Fixture> {
  env.agentGoalEnabled = true
  const user = await prisma.user.create({ data: { nickname: `goal-runtime-${randomUUID()}`, passwordHash: 'test-only-unusable' } })
  try {
    const novel = await prisma.novel.create({ data: { authorId: user.id, title: '目标运行时事务测试', slug: randomUUID(), summary: '' } })
    const session = await prisma.agentSession.create({ data: { userId: user.id, novelId: novel.id, title: '目标运行时事务测试会话',
      toolPolicy: { network: 'allow', contentWrite: 'allow', bulkWrite: 'allow', publish: 'allow', destructive: 'allow' } } })
    const volume = await prisma.volume.create({ data: { novelId: novel.id, title: '测试卷', orderIndex: 1 } })
    const chapter = await prisma.chapter.create({ data: { authorId: user.id, novelId: novel.id, volumeId: volume.id,
      title: '原始章节', content: '原始正文', orderIndex: 1, orderInVolume: 1, wordCount: 4 } })
    const created = await createAgentGoal(user.id, { sessionId: session.id }, { requestId: randomUUID(), objective: '完成持久目标测试',
      options: { mode: 'build' }, limits: { tokenLimit, activeTimeLimitMs: 3_600_000 } }, { authenticatedHttp: true })
    const goal = await prisma.agentGoal.findUniqueOrThrow({ where: { id: created.id } })
    const parent = await createGoalRun({ userId: user.id, novelId: novel.id, sessionId: session.id, goalId: goal.id }, 'goal_auto', 1)
    await prisma.agentGoal.update({ where: { id: goal.id }, data: { currentRunId: parent.runId, continuationIndex: 1, phase: 'executing', activeSince: new Date() } })
    return { userId: user.id, novelId: novel.id, sessionId: session.id, chapterId: chapter.id, goalId: goal.id,
      runId: parent.runId, rootId: parent.rootId, lease: parent.lease }
  } catch (error) {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined)
    throw error
  }
}

async function cleanup(userId: string) {
  await prisma.agentGoal.deleteMany({ where: { userId } })
  await prisma.agentArtifact.deleteMany({ where: { run: { userId } } })
  await prisma.agentRun.deleteMany({ where: { userId } })
  await prisma.agentTaskRoot.deleteMany({ where: { userId } })
  await prisma.agentSession.deleteMany({ where: { userId } })
  await prisma.chapter.deleteMany({ where: { authorId: userId } })
  await prisma.novel.deleteMany({ where: { authorId: userId } })
  await prisma.user.delete({ where: { id: userId } }).catch(() => undefined)
}

const contextFor = (f: Fixture): GoalExecutionContext => ({ goalId: f.goalId, revision: 1, epoch: 1n,
  userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, runId: f.runId })

describe.skipIf(!available)('agent goal runtime transaction fences (isolated test DB)', () => {
  const fixtures: Fixture[] = []

  afterEach(async () => {
    while (fixtures.length) await cleanup(fixtures.pop()!.userId)
  })
  afterAll(async () => { await prisma.$disconnect() })

  it('disables scheduling and late writes while retaining read/cancel controls when the rollout flag is turned off', async () => {
    const f = await fixture(); fixtures.push(f)
    env.agentGoalEnabled = false
    try {
      await superviseAgentGoal(f.userId, f.sessionId, f.goalId)
      const paused = await readAgentGoal(f.userId, f.sessionId)
      expect(paused).toMatchObject({ id: f.goalId, status: 'paused' })
      expect((await prisma.agentRunLease.findUniqueOrThrow({ where: { runId: f.runId } })).enabled).toBe(false)
      await expect(prepareOperation(f.lease, { key: 'flag-disabled', kind: 'tool', action: 'chapter_write', input: {} }))
        .rejects.toMatchObject({ code: 'GOAL_EXECUTION_FENCED' })
      await expect(actOnAgentGoal(f.userId, f.sessionId, f.goalId, { requestId: randomUUID(), expectedStateVersion: paused!.stateVersion, action: 'resume' }))
        .rejects.toMatchObject({ code: 'GOAL_DISABLED' })
      const cancelled = await actOnAgentGoal(f.userId, f.sessionId, f.goalId, { requestId: randomUUID(), expectedStateVersion: paused!.stateVersion, action: 'cancel' })
      expect(cancelled.status).toBe('cancelled')
      expect(await prisma.agentGoalRevision.count({ where: { goalId: f.goalId } })).toBe(1)
    } finally { env.agentGoalEnabled = true }
  })

  it('recovers a pending revision once and resumes saved progress without author resend or old completion credit', async () => {
    const f = await fixture(); fixtures.push(f)
    const chapter = await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })
    const compilation = await prisma.storyCompilation.create({ data: { userId: f.userId, novelId: f.novelId, runId: f.runId,
      chapterId: f.chapterId, targetOrderIndex: 1, sourcePromptHash: 'fixture-saved-result', preparedContext: {}, status: 'completed' } })
    await prisma.chapterBridge.create({ data: { userId: f.userId, novelId: f.novelId, compilationId: compilation.id,
      toChapterId: f.chapterId, targetOrderIndex: 1, targetRevision: chapter.revision, committedAt: new Date(),
      knowledgeState: {}, bodyState: {}, objectState: {}, relationshipState: {}, emotionAftermath: {}, recentOpenings: [], recentEndings: [], openLoops: [] } })
    const plan = await prisma.agentArtifact.create({ data: { runId: f.runId, artifactType: 'chapterPlan', title: '已保存计划', content: '原版本已保存的大纲', metadata: { savedAsPlan: true } } })
    const messageCount = await prisma.agentMessage.count({ where: { sessionId: f.sessionId } })
    await pauseGoalForRun(f.userId, f.runId)
    await prisma.agentGoalBudget.update({ where: { goalId: f.goalId }, data: { tokensUsed: 321n } })
    const paused = await readAgentGoal(f.userId, f.sessionId)
    await updateAgentGoal(f.userId, f.sessionId, f.goalId, { requestId: randomUUID(), expectedStateVersion: paused!.stateVersion,
      expectedRevision: paused!.revision, objective: '制定第二版大纲' })
    await superviseAgentGoal(f.userId, f.sessionId, f.goalId)
    await superviseAgentGoal(f.userId, f.sessionId, f.goalId)
    const updated = await readAgentGoal(f.userId, f.sessionId)
    expect(updated).toMatchObject({ status: 'paused', revision: 2, pendingRevision: null, objective: '制定第二版大纲', tokensUsed: '321' })
    expect(await prisma.agentGoalRevision.count({ where: { goalId: f.goalId } })).toBe(2)
    expect(await prisma.agentGoalEvent.count({ where: { goalId: f.goalId, type: 'revision.applied' } })).toBe(1)
    expect(await prisma.agentGoalExecution.count({ where: { goalId: f.goalId } })).toBe(1)
    const resumed = await actOnAgentGoal(f.userId, f.sessionId, f.goalId, { requestId: randomUUID(), expectedStateVersion: updated!.stateVersion, action: 'resume' })
    expect(resumed).toMatchObject({ status: 'active', phase: 'queued', revision: 2, objective: '制定第二版大纲', tokensUsed: '321' })
    expect(await prisma.agentMessage.count({ where: { sessionId: f.sessionId } })).toBe(messageCount)
    const stored = await prisma.agentGoal.findUniqueOrThrow({ where: { id: f.goalId } })
    const saved = await prisma.$transaction(tx => readGoalSavedProgress(tx, stored))
    expect(saved).toMatchObject({ completionCredit: false, truncated: false })
    expect(saved.entries).toContainEqual(expect.objectContaining({ kind: 'chapter', id: f.chapterId, sourceRevision: 1, verification: 'current', currentRevision: chapter.revision }))
    expect(saved.entries).toContainEqual(expect.objectContaining({ kind: 'plan', id: plan.id, sourceRevision: 1, verification: 'current' }))
    const current = await prisma.$transaction(tx => inspectGoalEvidence(tx, stored))
    expect(current.facts.chapters).toEqual([])
    expect(current.facts.plans).toEqual([])
    expect(current.hasDeliverable).toBe(false)
    expect(await prisma.$transaction(tx => readGoalSavedProgress(tx, { ...stored, userId: 'unowned-fixture-user' })))
      .toEqual({ completionCredit: false, entries: [], truncated: false })
    await prisma.chapter.update({ where: { id: f.chapterId }, data: { revision: { increment: 1 }, content: '作者后续修改的正文' } })
    expect((await prisma.$transaction(tx => readGoalSavedProgress(tx, stored))).entries.find(item => item.kind === 'chapter')?.verification).toBe('changed')
    await prisma.chapter.update({ where: { id: f.chapterId }, data: { archivedAt: new Date() } })
    expect((await prisma.$transaction(tx => readGoalSavedProgress(tx, stored))).entries.find(item => item.kind === 'chapter')?.verification).toBe('unavailable')
  })

  it('consumes a current legacy answer once and rejects its old mailbox after the goal epoch changes', async () => {
    const f = await fixture(); fixtures.push(f)
    const legacy = await prisma.agentRun.create({ data: { userId: f.userId, novelId: f.novelId, sessionId: f.sessionId,
      status: 'awaiting_approval', mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop' } })
    await prisma.agentGoalExecution.create({ data: { goalId: f.goalId, goalRevision: 1, epoch: 1n, runId: legacy.id,
      continuationIndex: 2, trigger: 'goal_auto', sourceEventId: `fixture:${legacy.id}` } })
    const controller = new AbortController()
    const answer = waitForQuestionAnswer(legacy.id, 'current-question', 5000, controller.signal)
    const stale = waitForQuestionAnswer(legacy.id, 'old-question', 5000, controller.signal)
    try {
      expect(await resolveLoopRunQuestion(f.userId, legacy.id, 'current-question', '使用既定方案')).toEqual({ resolved: true })
      expect(await answer).toEqual({ answer: '使用既定方案', timedOut: false })
      await expect(resolveLoopRunQuestion(f.userId, legacy.id, 'current-question', '重复回答')).rejects.toMatchObject({ code: 'QUESTION_NOT_PENDING' })
      await prisma.agentGoal.update({ where: { id: f.goalId }, data: { epoch: { increment: 1 } } })
      await expect(resolveLoopRunQuestion(f.userId, legacy.id, 'old-question', '继续')).rejects.toMatchObject({ code: 'GOAL_EXECUTION_FENCED' })
    } finally {
      controller.abort()
    }
    expect(await stale).toEqual({ answer: null, timedOut: false })
  })

  it.each(['pause', 'cancel', 'revision'] as const)('rejects stale question and approval cards after %s before consuming an answer', async action => {
    const f = await fixture(); fixtures.push(f)
    if (action === 'revision') {
      await prisma.agentGoal.update({ where: { id: f.goalId }, data: { epoch: { increment: 1 } } })
    } else {
      const goal = await prisma.agentGoal.findUniqueOrThrow({ where: { id: f.goalId } })
      await actOnAgentGoal(f.userId, f.sessionId, f.goalId, { requestId: randomUUID(), expectedStateVersion: goal.stateVersion, action })
    }
    const input = { userId: f.userId, runId: f.runId, requestId: randomUUID(), callId: 'old-card' }
    const count = await prisma.agentExecutionOutbox.count({ where: { taskRootId: f.rootId } })
    await expect(resolveDurableQuestion({ ...input, answer: '继续' })).rejects.toMatchObject({ code: 'GOAL_EXECUTION_FENCED' })
    await expect(resolveDurableApproval({ ...input, approved: true, alwaysAllow: false })).rejects.toMatchObject({ code: 'GOAL_EXECUTION_FENCED' })
    expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: f.rootId } })).toBe(count)
  })

  it('rejects a stale goal epoch before a tool transaction can touch the chapter', async () => {
    const f = await fixture(); fixtures.push(f)
    const operation = await prepareOperation(f.lease, { key: 'write:stale-epoch', kind: 'tool', action: 'chapter_write', input: { chapterId: f.chapterId } })
    await prisma.agentGoal.update({ where: { id: f.goalId }, data: { epoch: { increment: 1 } } })
    const work = async (tx: Parameters<Parameters<typeof commitOperationEffect>[3]>[0]) => {
      await tx.chapter.update({ where: { id: f.chapterId }, data: { content: '迟到正文' } })
      return { content: '迟到正文' }
    }
    await expect(commitOperationEffect(f.lease, operation.id, operation.inputHash, work)).rejects.toMatchObject({ code: 'GOAL_EXECUTION_FENCED' })
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('原始正文')
    expect(await prisma.agentEffectReceipt.count({ where: { operationId: operation.id } })).toBe(0)
  })

  it('rejects a terminal run before a tool transaction can touch the chapter', async () => {
    const f = await fixture(); fixtures.push(f)
    const operation = await prepareOperation(f.lease, { key: 'write:terminal-run', kind: 'tool', action: 'chapter_write', input: { chapterId: f.chapterId } })
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'completed', finishedAt: new Date() } })
    const work = async (tx: Parameters<Parameters<typeof commitOperationEffect>[3]>[0]) => {
      await tx.chapter.update({ where: { id: f.chapterId }, data: { content: '迟到正文' } })
      return { content: '迟到正文' }
    }
    await expect(commitOperationEffect(f.lease, operation.id, operation.inputHash, work)).rejects.toMatchObject({ code: 'GOAL_EXECUTION_FENCED' })
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('原始正文')
    expect(await prisma.agentEffectReceipt.count({ where: { operationId: operation.id } })).toBe(0)
  })

  it.each(['pause', 'cancel'] as const)('%s wins over a pending durable write and leaves no late正文', async action => {
    const f = await fixture(); fixtures.push(f)
    const operation = await prepareOperation(f.lease, { key: `write:${action}`, kind: 'tool', action: 'chapter_write', input: { chapterId: f.chapterId } })
    const goal = await prisma.agentGoal.findUniqueOrThrow({ where: { id: f.goalId } })
    await actOnAgentGoal(f.userId, f.sessionId, f.goalId, { requestId: randomUUID(), expectedStateVersion: goal.stateVersion, action })
    const work = async (tx: Parameters<Parameters<typeof commitOperationEffect>[3]>[0]) => {
      await tx.chapter.update({ where: { id: f.chapterId }, data: { content: '暂停后正文' } })
      return { content: '暂停后正文' }
    }
    await expect(commitOperationEffect(f.lease, operation.id, operation.inputHash, work)).rejects.toMatchObject({ code: 'GOAL_EXECUTION_FENCED' })
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('原始正文')
    expect(await prisma.agentEffectReceipt.count({ where: { operationId: operation.id } })).toBe(0)
  })

  it('pauses the current run after an accounting state change and ignores an old epoch stop', async () => {
    const f = await fixture(); fixtures.push(f)
    const sourceKey = `fixture:usage:${f.goalId}`
    await prisma.agentGoalUsage.create({ data: { sourceKey, goalId: f.goalId, runId: f.runId, reservedTokens: 0n } })
    await observeGoalUsage(sourceKey, { inputTokens: 1, outputTokens: 0, creditsMilli: 0, status: 'known' })
    const beforeStop = await prisma.agentGoal.findUniqueOrThrow({ where: { id: f.goalId } })
    expect(beforeStop.status).toBe('active')
    const stopped = await pauseGoalForRun(f.userId, f.runId)
    expect(stopped).toBe(true)
    const paused = await prisma.agentGoal.findUniqueOrThrow({ where: { id: f.goalId } })
    expect(paused).toMatchObject({ status: 'paused', phase: 'idle' })
    expect(paused.epoch).toBe(beforeStop.epoch + 1n)
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
    const lease = await prisma.agentRunLease.findUniqueOrThrow({ where: { runId: f.runId } })
    expect(run.status).toBe('paused')
    expect(lease.enabled).toBe(false)
    await pauseGoalForRun(f.userId, f.runId)
    expect((await prisma.agentGoal.findUniqueOrThrow({ where: { id: f.goalId } })).epoch).toBe(paused.epoch)
  })

  it('revokes every parent and child execution lease when the goal budget is exhausted', async () => {
    const f = await fixture(10); fixtures.push(f)
    const child = await createGoalRun(f, 'subagent', 2)
    const before = await prisma.agentGoal.findUniqueOrThrow({ where: { id: f.goalId } })
    await prisma.agentGoalBudget.update({ where: { goalId: f.goalId }, data: { tokensUsed: 10n } })
    await superviseAgentGoal(f.userId, f.sessionId, f.goalId)
    const goal = await prisma.agentGoal.findUniqueOrThrow({ where: { id: f.goalId } })
    expect(goal).toMatchObject({ status: 'budget_limited', phase: 'idle', reasonCode: 'GOAL_BUDGET_EXHAUSTED' })
    expect(goal.epoch).toBe(before.epoch + 1n)
    const runs = await prisma.agentRun.findMany({ where: { id: { in: [f.runId, child.runId] } }, select: { id: true, status: true, taskRootId: true } })
    expect(runs).toEqual(expect.arrayContaining([
      { id: f.runId, status: 'paused', taskRootId: f.rootId },
      { id: child.runId, status: 'paused', taskRootId: child.rootId },
    ]))
    const leases = await prisma.agentRunLease.findMany({ where: { runId: { in: [f.runId, child.runId] } }, select: { runId: true, enabled: true } })
    expect(leases).toEqual(expect.arrayContaining([{ runId: f.runId, enabled: false }, { runId: child.runId, enabled: false }]))
    const roots = await prisma.agentTaskRoot.findMany({ where: { id: { in: [f.rootId, child.rootId] } }, select: { id: true, status: true } })
    expect(roots).toEqual(expect.arrayContaining([{ id: f.rootId, status: 'paused' }, { id: child.rootId, status: 'paused' }]))
  })

  it('keeps array read/write batches inside one fenced transaction', async () => {
    const f = await fixture(); fixtures.push(f)
    const fenced = withGoalDatabaseFences(prisma)
    const context = contextFor(f)
    const result = await withGoalExecutionContext(context, () => withGoalEffects(() => {
      const read = fenced.chapter.findUnique({ where: { id: f.chapterId }, select: { content: true } })
      const write = fenced.chapter.update({ where: { id: f.chapterId }, data: { content: '数组事务正文' }, select: { content: true } })
      return fenced.$transaction([read, write])
    }))
    expect(result).toEqual([{ content: '原始正文' }, { content: '数组事务正文' }])
    await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '原始正文' } })
  })

  it('reuses the active transaction for nested helpers and rolls back their writes together', async () => {
    const f = await fixture(); fixtures.push(f)
    const fenced = withGoalDatabaseFences(prisma)
    const context = contextFor(f)
    await expect(
      withGoalExecutionContext(context, () => withGoalEffects(() => fenced.$transaction(async () => {
        await fenced.chapter.update({ where: { id: f.chapterId }, data: { content: '嵌套事务正文' } })
        throw new Error('fixture nested helper rollback')
      })))
    ).rejects.toThrow('fixture nested helper rollback')
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('原始正文')
  })

  it('settles a late provider receipt after cancellation without restoring a lease or tool effect', async () => {
    const f = await fixture(); fixtures.push(f)
    const operation = await prepareOperation(f.lease, { key: 'exec:0', kind: 'provider', action: 'chat', input: { prompt: 'fixture' } })
    const attempt = await prepareProviderAttempt(f.lease, { operationId: operation.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request: { prompt: 'fixture' } })
    const initial = await loadExecutionState(f.userId, f.runId)
    await saveExecutionState(f.lease, { expectedRevision: initial.head.revision, expectedHash: initial.frame.snapshotHash,
      snapshot: { ...initial.frame.state, turn: 1, nextOperationSequence: 1, phase: 'awaiting_operation', pendingOperationId: operation.id } })
    await markProviderDispatched(f.lease, attempt.id, 12)
    const goalBefore = await prisma.agentGoal.findUniqueOrThrow({ where: { id: f.goalId } })
    await actOnAgentGoal(f.userId, f.sessionId, f.goalId, { requestId: randomUUID(), expectedStateVersion: goalBefore.stateVersion, action: 'cancel' })
    const identity = { userId: f.userId, attemptId: attempt.id, requestHash: attempt.requestHash }
    await recordProviderUsage({ ...identity, revision: 1, usage: { source: 'reported', promptTokens: 7, completionTokens: 5, cacheHitTokens: 0, cacheMissTokens: 7 } })
    await recordProviderResult({ ...identity, outcome: 'succeeded', result: { content: '晚到的已付结果' } })
    await observeGoalUsage(`durable:${attempt.id}`, { inputTokens: 7, outputTokens: 5, creditsMilli: 3, status: 'known' })
    const usage = await prisma.agentGoalUsage.findUniqueOrThrow({ where: { sourceKey: `durable:${attempt.id}` } })
    const budget = await prisma.agentGoalBudget.findUniqueOrThrow({ where: { goalId: f.goalId } })
    const goal = await prisma.agentGoal.findUniqueOrThrow({ where: { id: f.goalId } })
    expect(usage).toMatchObject({ status: 'known', reservedTokens: 0n, inputTokens: 7n, outputTokens: 5n, creditsMicros: 3_000n })
    expect(budget).toMatchObject({ tokensUsed: 12n, tokensReserved: 0n, creditsUsedMicros: 3_000n })
    expect(goal.status).toBe('cancelled')
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).content).toBe('原始正文')
    expect(await prisma.agentEffectReceipt.count({ where: { operationId: operation.id } })).toBe(0)
    await expect(acquireRunLease({ userId: f.userId, runId: f.runId, ownerId: 'late-worker', claimId: randomUUID() })).rejects.toMatchObject({ code: 'GOAL_EXECUTION_FENCED' })
  })
})
