import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { env } from '../../api/config/env.js'
import { prisma } from '../../api/lib/prisma.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'
import { actOnAgentGoal, createAgentGoal, readAgentGoal, updateAgentGoal } from '../../api/lib/agent/goal-service.js'
import { readGoalExecutionControl } from '../../api/lib/agent/goal-execution-control.js'
import { reserveGoalUsageInTransaction, observeGoalUsage } from '../../api/lib/agent/goal-budget.js'
import { admitGoalRun } from '../../api/lib/agent/goal-run-admission.js'
import { inspectGoalEvidence } from '../../api/lib/agent/goal-evidence.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { readWritingScope } from '../../api/lib/agent/writing-scope.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { serializeExecutionControl, verifiedUserExecutionControl } from '../../api/lib/agent/execution-control.js'

const available = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
const userIds: string[] = []
const previousEnabled = env.agentGoalEnabled
const httpAuthor = { authenticatedHttp: true } as const

async function fixture(limits?: { tokenLimit?: number; activeTimeLimitMs?: number }) {
  const user = await prisma.user.create({ data: { nickname: `goal-policy-${randomUUID()}`, passwordHash: 'synthetic-only' } })
  userIds.push(user.id)
  const novel = await prisma.novel.create({ data: { authorId: user.id, title: '执行策略合成作品', slug: randomUUID(), summary: '' } })
  const session = await prisma.agentSession.create({ data: { userId: user.id, novelId: novel.id, title: '执行策略合成会话' } })
  const goal = await createAgentGoal(user.id, { sessionId: session.id }, { requestId: randomUUID(), objective: '写下一章', options: { mode: 'build', tokenBudget: 500 },
    ...(limits === undefined ? {} : { limits }) }, httpAuthor)
  return { userId: user.id, novelId: novel.id, sessionId: session.id, goal }
}

async function pause(f: Awaited<ReturnType<typeof fixture>>, goal = f.goal) {
  return actOnAgentGoal(f.userId, f.sessionId, goal.id, { requestId: randomUUID(), expectedStateVersion: goal.stateVersion, action: 'pause' })
}

describe.skipIf(!available)('goal execution control provenance (real isolated PG)', () => {
  beforeAll(() => { env.agentGoalEnabled = true })
  afterEach(async () => {
    for (const userId of userIds.splice(0)) {
      await prisma.agentGoalCommand.deleteMany({ where: { userId } })
      await prisma.agentSession.deleteMany({ where: { userId } })
      await prisma.chapter.deleteMany({ where: { authorId: userId } })
      await prisma.volume.deleteMany({ where: { novel: { authorId: userId } } })
      await prisma.novel.deleteMany({ where: { authorId: userId } })
      await prisma.user.delete({ where: { id: userId } })
    }
  })
  afterAll(async () => { env.agentGoalEnabled = previousEnabled; await prisma.$disconnect() })

  it.each([undefined, {}])('has no effective limit for absent/empty limits despite internal tokenBudget (%j)', async limits => {
    const f = await fixture(limits)
    expect(f.goal.executionControl).toMatchObject({ origin: 'system_default', limits: { tokens: null, turns: null, activeTimeMs: null } })
    const run = await prisma.agentRun.create({ data: { userId: f.userId, novelId: f.novelId, sessionId: f.sessionId,
      mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', status: 'running' } })
    await prisma.agentGoalBudget.update({ where: { goalId: f.goal.id }, data: { tokensUsed: 999_999n, activeTimeMs: 99_999_999n } })
    const context = { goalId: f.goal.id, userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, runId: run.id, revision: 1, epoch: 1n }
    const key = `synthetic:${randomUUID()}`
    await prisma.$transaction(tx => reserveGoalUsageInTransaction(tx, key, 50_000, context))
    await observeGoalUsage(key, { inputTokens: 50_000, outputTokens: 1, creditsMilli: 0, status: 'known' })
    await observeGoalUsage(key, { inputTokens: 40_000, outputTokens: 0, creditsMilli: 0, status: 'known' })
    expect(await prisma.agentGoalBudget.findUniqueOrThrow({ where: { goalId: f.goal.id } })).toMatchObject({ tokensUsed: 1_050_000n, tokensReserved: 0n })
    await prisma.agentRun.delete({ where: { id: run.id } })
  })

  it('allows an exact reservation, stops dispatch at the spent explicit cap, and Continue never refills', async () => {
    const f = await fixture({ tokenLimit: 1000 })
    const run = await prisma.agentRun.create({ data: { userId: f.userId, novelId: f.novelId, sessionId: f.sessionId,
      mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', status: 'running' } })
    const context = { goalId: f.goal.id, userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, runId: run.id, revision: 1, epoch: 1n }
    const key = `explicit:${randomUUID()}`
    await prisma.$transaction(tx => reserveGoalUsageInTransaction(tx, key, 1000, context))
    await observeGoalUsage(key, { inputTokens: 600, outputTokens: 400, creditsMilli: 0, status: 'known' })
    await expect(prisma.$transaction(tx => reserveGoalUsageInTransaction(tx, `${key}:next`, 0, context))).rejects.toMatchObject({ code: 'GOAL_BUDGET_EXHAUSTED' })
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: 'completed' } })
    const paused = await pause(f, (await readAgentGoal(f.userId, f.sessionId))!)
    await expect(actOnAgentGoal(f.userId, f.sessionId, f.goal.id, { requestId: randomUUID(), expectedStateVersion: paused.stateVersion, action: 'resume' }))
      .rejects.toMatchObject({ code: 'GOAL_BUDGET_REQUIRED' })
    expect((await readAgentGoal(f.userId, f.sessionId))?.executionControl?.limits.tokens).toBe('1000')
    await prisma.agentRun.delete({ where: { id: run.id } })
  })

  it('binds a partial authenticated change without changing objective revision, previous execution or saved chapter binding', async () => {
    const f = await fixture({ tokenLimit: 1000, activeTimeLimitMs: 60_000 })
    const volume = await prisma.volume.create({ data: { novelId: f.novelId, title: '合成卷', orderIndex: 1 } })
    const chapter = await prisma.chapter.create({ data: { authorId: f.userId, novelId: f.novelId, volumeId: volume.id,
      title: '已保存的授权章节', content: '实际保存正文', orderIndex: 1, orderInVolume: 1 } })
    const runId = randomUUID()
    const taskSpec = buildTaskSpec({ novelId: f.novelId, runId, prompt: '写下一章' })
    taskSpec.scope.writing = { version: 1, kind: 'bounded', titleAndBodyOnly: false, repairAuthorized: false,
      targets: [{ orderIndex: 1, chapterId: chapter.id }] }
    const bindings = { version: 1, taskId: taskSpec.id, targets: [{ orderIndex: 1, chapterId: chapter.id }] }
    const run = await prisma.agentRun.create({ data: { id: runId, userId: f.userId, novelId: f.novelId, sessionId: f.sessionId,
      mode: 'act', action: 'workspaceAgent', agentType: 'writingOrchestrator', engine: 'loop', status: 'completed', writingBindings: bindings,
      outputSummary: '实际保存正文', taskSpec, startRequest: { prompt: '写下一章' } } })
    const compilation = await prisma.storyCompilation.create({ data: { userId: f.userId, novelId: f.novelId, runId: run.id,
      chapterId: chapter.id, targetOrderIndex: 1, sourcePromptHash: 'synthetic-original-contract', preparedContext: {}, status: 'active' } })
    let bridge = await prisma.chapterBridge.create({ data: { userId: f.userId, novelId: f.novelId, compilationId: compilation.id,
      toChapterId: chapter.id, targetOrderIndex: 1, targetRevision: chapter.revision, knowledgeState: {}, bodyState: {},
      objectState: {}, relationshipState: {}, emotionAftermath: {}, recentOpenings: [], recentEndings: [], openLoops: [] } })
    await prisma.agentGoalExecution.create({ data: { goalId: f.goal.id, goalRevision: 1, epoch: 1n, continuationIndex: 1, runId: run.id, trigger: 'author', sourceEventId: randomUUID() } })
    await prisma.agentGoal.update({ where: { id: f.goal.id }, data: { currentRunId: run.id, continuationIndex: 1 } })
    const oldRevision = await prisma.agentGoalRevision.findUniqueOrThrow({ where: { goalId_revision: { goalId: f.goal.id, revision: 1 } } })
    const uncommitted = await prisma.$transaction(async tx => inspectGoalEvidence(tx, await tx.agentGoal.findUniqueOrThrow({ where: { id: f.goal.id } })))
    expect(uncommitted.hasDeliverable).toBe(false)
    await prisma.storyCompilation.update({ where: { id: compilation.id }, data: { status: 'completed' } })
    bridge = await prisma.chapterBridge.update({ where: { id: bridge.id }, data: { committedAt: new Date() } })
    const beforeInspection = await prisma.$transaction(async tx => inspectGoalEvidence(tx, await tx.agentGoal.findUniqueOrThrow({ where: { id: f.goal.id } })))
    expect(beforeInspection.hasDeliverable).toBe(true)
    expect(beforeInspection.progressHash).not.toBe(uncommitted.progressHash)
    const paused = await pause(f)
    const body = { requestId: randomUUID(), expectedStateVersion: paused.stateVersion, action: 'resume' as const, budgetChange: { tokenLimit: 2000 } }
    const resumed = await actOnAgentGoal(f.userId, f.sessionId, f.goal.id, body, httpAuthor)
    expect(resumed).toMatchObject({ revision: 1, currentRunId: run.id, executionControl: { origin: 'user', limits: { tokens: '2000', activeTimeMs: '60000' } } })
    expect(await actOnAgentGoal(f.userId, f.sessionId, f.goal.id, body, httpAuthor)).toEqual(resumed)
    expect(await prisma.agentGoalRevision.findUniqueOrThrow({ where: { goalId_revision: { goalId: f.goal.id, revision: 1 } } })).toEqual(oldRevision)
    expect(await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ writingBindings: bindings, status: 'completed', taskSpec: JSON.parse(JSON.stringify(taskSpec)) })
    const stored = await prisma.agentGoal.findUniqueOrThrow({ where: { id: f.goal.id } })
    const admitted = await prisma.$transaction(tx => admitGoalRun(tx, f.userId, f.sessionId, f.novelId,
      { goalId: f.goal.id, revision: 1, epoch: stored.epoch, continuationIndex: stored.continuationIndex, trigger: 'goal_auto', sourceEventId: randomUUID() }, '写下一章'))
    expect(admitted.previous?.runId).toBe(run.id)
    expect((await prisma.$transaction(tx => readWritingScope(tx, { userId: f.userId, novelId: f.novelId, runId: run.id }))).writing?.targets)
      .toEqual([{ orderIndex: 1, chapterId: chapter.id }])
    const afterInspection = await prisma.$transaction(tx => inspectGoalEvidence(tx, stored))
    expect(afterInspection.progressHash).toBe(beforeInspection.progressHash)
    expect(afterInspection.hasDeliverable).toBe(true)
    expect(await prisma.chapterBridge.findUniqueOrThrow({ where: { id: bridge.id } })).toEqual(bridge)
    expect(await prisma.chapter.count({ where: { novelId: f.novelId } })).toBe(1)
    expect(await prisma.agentGoalEvidence.count({ where: { goalId: f.goal.id, kind: 'execution-control' } })).toBe(1)
    const pausedAgain = await pause(f, resumed)
    const second = await actOnAgentGoal(f.userId, f.sessionId, f.goal.id, { requestId: randomUUID(), expectedStateVersion: pausedAgain.stateVersion,
      action: 'resume', budgetChange: { activeTimeLimitMs: 120_000 } }, httpAuthor)
    expect(second.executionControl?.limits).toEqual({ tokens: '2000', activeTimeMs: '120000', turns: null })
    // Rollback of the mutable pointer cannot downgrade the latest author limit.
    await prisma.agentGoal.update({ where: { id: f.goal.id }, data: { executionOptions: { mode: 'build' } } })
    await expect(prisma.$transaction(tx => readGoalExecutionControl(tx, f.goal.id))).rejects.toMatchObject({ code: 'GOAL_RECONCILIATION_REQUIRED' })
    await prisma.agentRun.delete({ where: { id: run.id } })
  })

  it('keeps legacy raw revision/hash and stopped state while projecting unknown provenance', async () => {
    const f = await fixture()
    await actOnAgentGoal(f.userId, f.sessionId, f.goal.id, { requestId: randomUUID(), expectedStateVersion: f.goal.stateVersion, action: 'cancel' })
    const raw = { mode: 'build', tokenBudget: 500 }
    const legacy = await prisma.agentGoal.create({ data: { userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, status: 'budget_limited', executionOptions: raw,
      revisions: { create: { revision: 1, objective: '写下一章', request: raw, authorityHash: 'old-immutable-authority', sourceActionId: 'old-source' } },
      budget: { create: { tokenLimit: 500n, platformTokenCap: 500n, activeTimeLimitMs: 1n, platformTimeCapMs: 1n, tokensUsed: 501n } } } })
    const before = await prisma.agentGoalRevision.findUniqueOrThrow({ where: { goalId_revision: { goalId: legacy.id, revision: 1 } } })
    expect(await prisma.$transaction(tx => readGoalExecutionControl(tx, legacy.id))).toMatchObject({ origin: 'unknown_legacy', limits: { tokens: null, activeTimeMs: null } })
    expect((await prisma.agentGoal.findUniqueOrThrow({ where: { id: legacy.id } })).status).toBe('budget_limited')
    const resumed = await actOnAgentGoal(f.userId, f.sessionId, legacy.id, { requestId: randomUUID(), expectedStateVersion: legacy.stateVersion, action: 'resume' })
    expect(resumed).toMatchObject({ status: 'active', tokensUsed: '501', tokenLimit: '500', executionControl: { origin: 'unknown_legacy' } })
    expect(await prisma.agentGoalRevision.findUniqueOrThrow({ where: { goalId_revision: { goalId: legacy.id, revision: 1 } } })).toEqual(before)
  })

  it.each(['bare-marker', 'wrong-goal-command', 'authority-mismatch'] as const)('fails closed on %s rather than downgrading to unlimited', async kind => {
    const f = await fixture()
    await actOnAgentGoal(f.userId, f.sessionId, f.goal.id, { requestId: randomUUID(), expectedStateVersion: f.goal.stateVersion, action: 'cancel' })
    const requestId = randomUUID()
    const envelope = { operation: 'create', target: { sessionId: f.sessionId }, body: { requestId, objective: '写下一章', options: { mode: 'build' }, limits: { tokenLimit: 500 } } }
    const control = serializeExecutionControl(verifiedUserExecutionControl({ tokens: 500n, turns: null, activeTimeMs: null }))
    const request = runtimeJson({ mode: 'build', executionControl: control,
      ...(kind === 'wrong-goal-command' ? { executionControlProof: { version: 1, revision: 1, envelope } } : {}) }).value
    const objective = '写下一章'
    const bad = await prisma.agentGoal.create({ data: { userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, executionOptions: { mode: 'build' },
      revisions: { create: { revision: 1, objective, request, authorityHash: kind === 'authority-mismatch' ? 'invalid-new-authority'
        : runtimeJson({ objective, request, novelId: f.novelId, userId: f.userId }).hash, sourceActionId: requestId } },
      budget: { create: { tokenLimit: 500n, platformTokenCap: 500n, activeTimeLimitMs: 1n, platformTimeCapMs: 1n } } } })
    if (kind === 'wrong-goal-command') await prisma.agentGoalCommand.create({ data: { userId: f.userId, requestId,
      requestHash: runtimeJson(envelope).hash, response: runtimeJson({ ...f.goal, executionControl: control }).value } })
    await expect(prisma.$transaction(tx => readGoalExecutionControl(tx, bad.id))).rejects.toMatchObject({ code: 'GOAL_RECONCILIATION_REQUIRED' })
  })

  it('rejects explicit limits from an internal/tool caller without authenticated HTTP provenance', async () => {
    const f = await fixture()
    const paused = await pause(f)
    await expect(actOnAgentGoal(f.userId, f.sessionId, f.goal.id, { requestId: randomUUID(), expectedStateVersion: paused.stateVersion,
      action: 'resume', budgetChange: { tokenLimit: 1000 } })).rejects.toMatchObject({ code: 'GOAL_LIMIT_AUTHORITY_REQUIRED' })
  })

  it('preserves effective user limits across a real objective revision without rewriting the original command', async () => {
    const f = await fixture({ tokenLimit: 1000 })
    const command = await prisma.agentGoalCommand.findFirstOrThrow({ where: { userId: f.userId } })
    await updateAgentGoal(f.userId, f.sessionId, f.goal.id, { requestId: randomUUID(), expectedStateVersion: f.goal.stateVersion,
      expectedRevision: 1, objective: '写一章' })
    await prisma.agentGoal.update({ where: { id: f.goal.id }, data: { currentRevision: 2, pendingRevision: null, status: 'paused' } })
    expect((await readAgentGoal(f.userId, f.sessionId))?.executionControl?.limits.tokens).toBe('1000')
    expect(await prisma.agentGoalCommand.findUniqueOrThrow({ where: { userId_requestId: { userId: command.userId, requestId: command.requestId } } })).toEqual(command)
  })
})
