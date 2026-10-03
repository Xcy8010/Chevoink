import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { env } from '../../api/config/env.js'
import { prisma } from '../../api/lib/prisma.js'
import { withHumanAdmission } from '../../api/lib/agent/goal-activation-authority.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { goalEnableTool } from '../../api/lib/agent/tools/goal-tools.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { snapshotToolAuthority } from '../../api/lib/agent/tool-authority.js'
import { toOpenAITools } from '../../api/lib/agent/tools/registry.js'
import { superviseAgentGoal } from '../../api/lib/agent/goal-supervisor.js'
import { actOnAgentGoal, readAgentGoal, updateAgentGoal } from '../../api/lib/agent/goal-service.js'
import { initializeDurableTask, startLegacyRuntimeRun } from '../../api/lib/agent/runtime-identity.js'
import { readGoalActivationToolCeiling } from '../../api/lib/agent/goal-activation.js'
import { reconcileGoalActivation } from '../../api/lib/agent/goal-activation-supervisor.js'
import { lockOwnedGoal } from '../../api/lib/agent/goal-store.js'
import { acquireRunLease, releaseRunLease } from '../../api/lib/agent/runtime-lease.js'
import { initializeExecutionState, loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import { saveExecutionState } from '../../api/lib/agent/runtime-state.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { publishDurableEvents } from '../../api/lib/agent/runtime-event-projection.js'
import { consumeDurableGoalConsent, consumeLegacyGoalConsent } from '../../api/lib/agent/goal-consent.js'
import { enqueueRequest, listQueuedRequests, actOnQueuedRequest, dispatchQueuedRequests } from '../../api/lib/agent/request-queue.js'
import { pauseDurableTask } from '../../api/lib/agent/runtime-lifecycle.js'
import { resumeDurableTask } from '../../api/lib/agent/runtime-resume.js'
import type { ChatMessage } from '../../api/lib/ai-service.js'
import { prepareToolCursorOperation } from '../../api/lib/agent/runtime-tool-cursor.js'
import { admitGoalRun } from '../../api/lib/agent/goal-run-admission.js'
import { getAgentDefinition, getToolsForAgent } from '../../api/lib/agent/agents.js'
import { intersectToolAuthority, restrictToolsToTask } from '../../api/lib/agent/tool-authority.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'

const available = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
const owners: string[] = []
const priorEnabled = env.agentGoalEnabled

async function fixture(prompt = '请启用目标模式，写下一章', human = true) {
  const user = await prisma.user.create({ data: { nickname: 'goal-activation-fixture', passwordHash: 'test-only-unusable' } })
  owners.push(user.id)
  const novel = await prisma.novel.create({ data: { authorId: user.id, title: '目标启用测试', slug: randomUUID(), summary: '' } })
  const session = await prisma.agentSession.create({ data: { userId: user.id, novelId: novel.id, title: '目标启用测试' } })
  const runId = randomUUID(), messageId = randomUUID()
  const input = { sessionId: session.id, novelId: novel.id, chapterId: null, mode: 'build' as const, prompt, modelTier: 'speed' as const }
  const spec = buildTaskSpec({ runId, novelId: novel.id, chapterId: null, prompt })
  await prisma.agentRun.create({ data: { id: runId, userId: user.id, novelId: novel.id, sessionId: session.id,
    mode: 'act', engine: 'loop', action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'queued',
    startRequest: human ? withHumanAdmission(input) : input, taskSpec: JSON.parse(JSON.stringify(spec)), usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } } })
  await prisma.agentMessage.create({ data: { id: messageId, runId, sessionId: session.id, role: 'user', parts: [{ type: 'text', text: prompt }] } })
  const ctx: ToolContext = { userId: user.id, novelId: novel.id, sessionId: session.id, chapterId: null, runId,
    callId: 'enable-goal', mode: 'build', creativeFreedom: 'balanced', qualityMode: 'premium',
    toolAuthority: snapshotToolAuthority([goalEnableTool], 'build'), signal: new AbortController().signal, emit: vi.fn() }
  return { userId: user.id, novelId: novel.id, sessionId: session.id, runId, messageId, spec, ctx }
}

async function enable(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await goalEnableTool.execute(f.ctx, {})
  expect(result.outcome).toBeUndefined()
  return (await readAgentGoal(f.userId, f.sessionId))!
}

async function durableFixture(f: Awaited<ReturnType<typeof fixture>>, messages: ChatMessage[]) {
  const root = await initializeDurableTask({ userId: f.userId, runId: f.runId, sourceMessageId: f.messageId })
  const lease = await acquireRunLease({ userId: f.userId, runId: f.runId, ownerId: 'goal-consent-test', claimId: randomUUID() })
  await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
    model: { tier: 'speed', provider: 'test', modelName: 'test', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
    tools: toOpenAITools([goalEnableTool]), toolAuthority: [{ name: 'goal_enable', permission: 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
    snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null, successfulToolSignatures: [], messages } })
  return { root, lease }
}

describe.skipIf(!available)('current task goal activation (isolated PostgreSQL gate)', () => {
  beforeAll(() => { env.agentGoalEnabled = true })
  afterEach(async () => {
    for (const userId of owners.splice(0)) {
      await prisma.agentGoalCommand.deleteMany({ where: { userId } })
      await prisma.aiUsageLog.deleteMany({ where: { userId } })
      await prisma.agentGoal.deleteMany({ where: { userId } })
      await prisma.chapterBridge.deleteMany({ where: { userId } })
      await prisma.storyCompilation.deleteMany({ where: { userId } })
      await prisma.chapter.deleteMany({ where: { authorId: userId } })
      await prisma.volume.deleteMany({ where: { novel: { authorId: userId } } })
      await prisma.agentRun.deleteMany({ where: { userId } })
      await prisma.agentTaskRoot.deleteMany({ where: { userId } })
      await prisma.agentSession.deleteMany({ where: { userId } })
      await prisma.novel.deleteMany({ where: { authorId: userId } })
      await prisma.user.delete({ where: { id: userId } })
    }
  })
  it('binds a current-task HTTP request to the original author scope, consumes once, and never dispatches a control run', async () => {
    const f = await fixture('写下一章'), id = randomUUID()
    const before = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
    await enqueueRequest(f.userId, id, { sessionId: f.sessionId, novelId: f.novelId, mode: 'build', prompt: '给当前任务启用目标模式' }, 'http')
    expect((await listQueuedRequests(f.userId, f.sessionId)).items).toMatchObject([{ id, status: 'held' }])
    expect(await goalEnableTool.execute(f.ctx, {})).toMatchObject({ outcome: 'failed' })
    const consumed = await consumeLegacyGoalConsent({ ...f, userId: f.userId })
    expect(consumed?.prompt).toBe('给当前任务启用目标模式')
    const goal = await enable(f)
    expect(goal.objective).toBe('写下一章')
    expect(await consumeLegacyGoalConsent(f)).toBeNull()
    expect((await listQueuedRequests(f.userId, f.sessionId)).items).toHaveLength(0)
    expect(await prisma.agentRun.findUnique({ where: { id: f.runId } })).toEqual(before)
    await dispatchQueuedRequests()
    expect(await prisma.agentRun.count({ where: { userId: f.userId } })).toBe(1)
  })
  it('acknowledges different HTTP consent request IDs for an already enabled task without leaving held requests or changing goal controls', async () => {
    const f = await fixture(), goal = await enable(f)
    for (let round = 0; round < 2; round++) {
      await enqueueRequest(f.userId, randomUUID(), { sessionId: f.sessionId, novelId: f.novelId, mode: 'build', prompt: '给当前任务启用目标模式' }, 'http')
      expect((await listQueuedRequests(f.userId, f.sessionId)).items).toHaveLength(0)
      expect(await consumeLegacyGoalConsent(f)).toBeNull()
    }
    expect((await listQueuedRequests(f.userId, f.sessionId)).items).toHaveLength(0)
    expect(await readAgentGoal(f.userId, f.sessionId)).toMatchObject({ id: goal.id, objective: goal.objective, stateVersion: goal.stateVersion,
      status: goal.status, currentRunId: goal.currentRunId, tokensUsed: goal.tokensUsed })
    expect(await prisma.agentGoalCommand.count({ where: { userId: f.userId } })).toBe(1)
    expect(await prisma.agentRun.count({ where: { userId: f.userId } })).toBe(1)
    expect(await prisma.agentQueuedRequest.count({ where: { userId: f.userId, status: 'consented' } })).toBe(2)
    expect(await prisma.agentProviderAttempt.count({ where: { runId: f.runId } })).toBe(0)
  })
  it('retains a late consent visibly after source settlement and never revives or sends it as a new task', async () => {
    const f = await fixture('写下一章'), id = randomUUID()
    await enqueueRequest(f.userId, id, { sessionId: f.sessionId, novelId: f.novelId, mode: 'build', prompt: '请启用目标模式继续当前任务' }, 'http')
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'completed', finishedAt: new Date() } })
    expect(await consumeLegacyGoalConsent(f)).toBeNull()
    expect((await listQueuedRequests(f.userId, f.sessionId)).items[0]).toMatchObject({ id, status: 'held', error: expect.stringContaining('尚未登记') })
    await expect(actOnQueuedRequest(f.userId, f.sessionId, id, 'steer', 0)).rejects.toMatchObject({ code: 'GOAL_CONSENT_BOUND' })
    await dispatchQueuedRequests()
    expect(await prisma.agentGoal.count({ where: { userId: f.userId } })).toBe(0)
    expect(await prisma.agentRun.count({ where: { userId: f.userId } })).toBe(1)
  })
  it('consumes consent only after a full durable native tool batch, preserving its cursor/configuration/budget', async () => {
    const f = await fixture('写下一章')
    const { root, lease } = await durableFixture(f, [{ role: 'user', content: '写下一章' }, { role: 'assistant', content: '',
      toolCalls: [{ id: 'pre-consent', name: 'goal_enable', arguments: '{}' }] }])
    await enqueueRequest(f.userId, randomUUID(), { sessionId: f.sessionId, novelId: f.novelId, mode: 'build', prompt: '给当前任务启用目标模式' }, 'http')
    const before = await loadExecutionState(f.userId, f.runId), budget = await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: root.id } })
    expect(await consumeDurableGoalConsent(lease)).toBe(false)
    expect(await prisma.agentGoal.count({ where: { userId: f.userId } })).toBe(0)
    expect((await executeDurableToolStep(lease, f.ctx.signal)).kind).toBe('tool')
    expect(await consumeDurableGoalConsent(lease)).toBe(true)
    expect(await consumeDurableGoalConsent(lease)).toBe(false)
    const after = await loadExecutionState(f.userId, f.runId)
    expect(after.frame.state.messages.at(-1)).toMatchObject({ role: 'user', content: '给当前任务启用目标模式' })
    expect(after.head.configurationHash).toBe(before.head.configurationHash)
    expect(await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: root.id } })).toEqual(budget)
    expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: root.id, type: 'goal.consent.consumed' } })).toBe(1)
    await releaseRunLease(lease)
  })
  it('restores an unconsumed journal only through explicit resume of the same immutable durable root', async () => {
    const f = await fixture('写下一章')
    const { root, lease } = await durableFixture(f, [{ role: 'user', content: '写下一章' }])
    await enqueueRequest(f.userId, randomUUID(), { sessionId: f.sessionId, novelId: f.novelId, mode: 'build', prompt: '请启用目标模式继续当前任务' }, 'http')
    const before = await loadExecutionState(f.userId, f.runId), budget = await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: root.id } })
    await releaseRunLease(lease)
    await pauseDurableTask(f.userId, f.runId)
    const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: root.id, type: 'run.paused' }, orderBy: { sequence: 'desc' } })
    const resumed = await resumeDurableTask({ userId: f.userId, runId: f.runId, pauseEventId: pause.id })
    const owner = await acquireRunLease({ userId: f.userId, runId: resumed.run.id, ownerId: 'goal-consent-resume', claimId: randomUUID() })
    expect(await consumeDurableGoalConsent(owner)).toBe(true)
    const current = await loadExecutionState(f.userId, resumed.run.id)
    await saveExecutionState(owner, { expectedRevision: current.frame.revision, expectedHash: current.frame.snapshotHash,
      snapshot: { ...current.frame.state, messages: [...current.frame.state.messages, { role: 'assistant', content: '', toolCalls: [{ id: 'resumed-enable', name: 'goal_enable', arguments: '{}' }] }] } })
    expect((await executeDurableToolStep(owner, f.ctx.signal)).kind).toBe('tool')
    const goal = await readAgentGoal(f.userId, f.sessionId)
    expect(goal).toMatchObject({ objective: '写下一章', currentRunId: resumed.run.id, reasonCode: 'GOAL_ACTIVATION_PENDING' })
    const source = await prisma.agentGoalEvidence.findUniqueOrThrow({ where: { goalId_revision_criterionId: { goalId: goal!.id, revision: 1, criterionId: 'activation-source' } } })
    expect(source.receipt).toMatchObject({ sourceRunId: f.runId, activationRunId: resumed.run.id, sourceRootId: root.id })
    const after = await loadExecutionState(f.userId, resumed.run.id)
    expect(after.originalRequest).toEqual(before.originalRequest)
    expect(after.head.configurationHash).toBe(before.head.configurationHash)
    expect(await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: root.id } })).toEqual(budget)
    expect(await prisma.agentGoalCommand.count({ where: { userId: f.userId } })).toBe(1)
    expect(await prisma.agentProviderAttempt.count({ where: { runId: { in: [f.runId, resumed.run.id] } } })).toBe(0)
    await releaseRunLease(owner)
  })
  it('does not move a retained consent onto a different task root in the same owner/window', async () => {
    const f = await fixture('写下一章')
    const initial = await durableFixture(f, [{ role: 'user', content: '写下一章' }])
    await enqueueRequest(f.userId, randomUUID(), { sessionId: f.sessionId, novelId: f.novelId, mode: 'build', prompt: '给当前任务启用目标模式' }, 'http')
    await releaseRunLease(initial.lease); await pauseDurableTask(f.userId, f.runId)
    const runId = randomUUID(), messageId = randomUUID(), prompt = '调研另一段背景'
    const spec = buildTaskSpec({ runId, novelId: f.novelId, chapterId: null, prompt })
    await prisma.agentRun.create({ data: { id: runId, userId: f.userId, sessionId: f.sessionId, novelId: f.novelId, mode: 'act', engine: 'loop',
      action: 'workspaceAgent', agentType: 'writingOrchestrator', status: 'queued', taskSpec: JSON.parse(JSON.stringify(spec)),
      startRequest: withHumanAdmission({ sessionId: f.sessionId, novelId: f.novelId, mode: 'build', prompt }) } })
    await prisma.agentMessage.create({ data: { id: messageId, runId, sessionId: f.sessionId, role: 'user', parts: [{ type: 'text', text: prompt }] } })
    const other = await durableFixture({ ...f, runId, messageId, spec }, [{ role: 'user', content: prompt }, { role: 'assistant', content: '',
      toolCalls: [{ id: 'foreign-root-enable', name: 'goal_enable', arguments: '{}' }] }])
    expect(other.root.id).not.toBe(initial.root.id)
    expect(await consumeDurableGoalConsent(other.lease)).toBe(false)
    await executeDurableToolStep(other.lease, f.ctx.signal)
    expect(await prisma.agentGoal.count({ where: { userId: f.userId } })).toBe(0)
    expect((await listQueuedRequests(f.userId, f.sessionId)).items[0].error).toContain('尚未登记')
    await releaseRunLease(other.lease)
  })
  it.each(['prepared', 'unknown'])('resumes only an untouched %s cursor after human activation pause, keeping the same operation and one effect', async operationStatus => {
    const f = await fixture()
    const { root, lease } = await durableFixture(f, [{ role: 'user', content: '原任务' }, { role: 'assistant', content: '',
      toolCalls: [{ id: 'first-enable', name: 'goal_enable', arguments: '{}' }] }])
    await executeDurableToolStep(lease, f.ctx.signal)
    const first = await loadExecutionState(f.userId, f.runId)
    await saveExecutionState(lease, { expectedRevision: first.frame.revision, expectedHash: first.frame.snapshotHash, snapshot: {
      ...first.frame.state, messages: [...first.frame.state.messages, { role: 'assistant', content: '', toolCalls: [{ id: 'next-enable', name: 'goal_enable', arguments: '{}' }] }],
    } })
    const cursor = await loadExecutionState(f.userId, f.runId), key = `exec:${cursor.frame.state.nextOperationSequence}`
    const pending = await prepareToolCursorOperation(lease, { expectedRevision: cursor.frame.revision, expectedHash: cursor.frame.snapshotHash }, {
      key, action: 'goal_enable', callId: 'next-enable', targetId: root.id, effectDomain: 'read', effectiveArgs: {},
      normalize: raw => goalEnableTool.parameters.parse(raw), operationInput: { callId: 'next-enable', args: {} },
    })
    if (operationStatus === 'unknown') await prisma.agentOperation.update({ where: { id: pending.operation.id }, data: { status: 'unknown' } })
    const initial = (await readAgentGoal(f.userId, f.sessionId))!
    const paused = await actOnAgentGoal(f.userId, f.sessionId, initial.id, { requestId: randomUUID(), expectedStateVersion: initial.stateVersion, action: 'pause' })
    await actOnAgentGoal(f.userId, f.sessionId, initial.id, { requestId: randomUUID(), expectedStateVersion: paused.stateVersion, action: 'resume' })
    const action = await prisma.$transaction(async tx => reconcileGoalActivation(tx, await lockOwnedGoal(tx, f.userId, f.sessionId, initial.id), new Date()))
    if (operationStatus === 'unknown') {
      expect(action).toBe(true)
      expect(await prisma.agentGoalExecution.count({ where: { goalId: initial.id } })).toBe(0)
      expect(await prisma.agentEffectReceipt.count({ where: { operationId: pending.operation.id } })).toBe(0)
      expect((await loadExecutionState(f.userId, f.runId)).frame.snapshotHash).toBe(pending.pending.snapshotHash)
      return
    }
    expect(action).toMatchObject({ kind: 'activation_continue', runId: f.runId })
    const ready = await prisma.agentGoal.findUniqueOrThrow({ where: { id: initial.id } })
    expect(await prisma.agentGoalExecution.findUniqueOrThrow({ where: { runId: f.runId } })).toMatchObject({
      goalId: initial.id, goalRevision: 1, epoch: ready.epoch, taskRootId: root.id,
      trigger: 'author', sourceEventId: `activation:${initial.id}:${f.runId}`,
    })
    const sourceEvidence = await prisma.agentGoalEvidence.findUniqueOrThrow({ where: {
      goalId_revision_criterionId: { goalId: initial.id, revision: 1, criterionId: 'activation-source' },
    } })
    expect(sourceEvidence.receipt).toMatchObject({ sourceRunId: f.runId, activationRunId: f.runId,
      sourceRootId: root.id, sourceMessageId: f.messageId, baselineBound: true })
    const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: root.id, type: 'run.paused' }, orderBy: { sequence: 'desc' } })
    const resumed = await resumeDurableTask({ userId: f.userId, runId: f.runId, pauseEventId: pause.id, activation: { goalId: initial.id, epoch: ready.epoch } })
    expect(await prisma.agentGoalExecution.findUniqueOrThrow({ where: { runId: resumed.run.id } })).toMatchObject({
      goalId: initial.id, goalRevision: 1, epoch: ready.epoch, taskRootId: root.id,
      trigger: 'author', sourceEventId: `activation-resume:${pause.id}`,
    })
    expect((await prisma.agentGoalEvidence.findUniqueOrThrow({ where: { id: sourceEvidence.id } })).receipt).toEqual(sourceEvidence.receipt)
    expect(await prisma.agentGoalEvidence.findUniqueOrThrow({ where: {
      goalId_revision_criterionId: { goalId: initial.id, revision: 1, criterionId: 'activation-resume' },
    } })).toMatchObject({ status: 'consumed', receipt: { sourceRunId: f.runId, epoch: String(ready.epoch) } })
    expect(await prisma.agentMessage.count({ where: { runId: resumed.run.id } })).toBe(0)
    expect(await prisma.agentMessage.findUniqueOrThrow({ where: { id: root.sourceMessageId } })).toMatchObject({
      id: f.messageId, runId: f.runId, sessionId: f.sessionId, role: 'user',
    })
    const owner = await acquireRunLease({ userId: f.userId, runId: resumed.run.id, ownerId: 'prepared-consent-resume', claimId: randomUUID() })
    expect((await loadExecutionState(f.userId, resumed.run.id)).frame.snapshotHash).toBe(pending.pending.snapshotHash)
    expect((await executeDurableToolStep(owner, f.ctx.signal)).kind).toBe('tool')
    expect((await executeDurableToolStep(owner, f.ctx.signal)).kind).toBe('idle')
    expect(await prisma.agentOperation.count({ where: { taskRootId: root.id, operationKey: key } })).toBe(1)
    expect(await prisma.agentEffectReceipt.count({ where: { operationId: pending.operation.id } })).toBe(1)
    expect(await prisma.agentGoalCommand.count({ where: { userId: f.userId } })).toBe(1)
    expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: root.id } } })).toBe(0)
    await releaseRunLease(owner)
  })
  afterAll(async () => { env.agentGoalEnabled = priorEnabled; await prisma.$disconnect() })

  it('serializes duplicate/concurrent native calls into one deferred goal without a run or provider attempt', async () => {
    const f = await fixture()
    const before = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
    const results = await Promise.all([goalEnableTool.execute(f.ctx, {}), goalEnableTool.execute({ ...f.ctx, callId: 'second-call' }, {})])
    expect(results.every(result => !result.outcome)).toBe(true)
    const goal = await readAgentGoal(f.userId, f.sessionId)
    expect(goal).toMatchObject({ status: 'active', phase: 'reconciling', reasonCode: 'GOAL_ACTIVATION_PENDING', currentRunId: f.runId, activeSince: null, objective: '写下一章' })
    expect(await prisma.agentGoal.count({ where: { userId: f.userId } })).toBe(1)
    expect(await prisma.agentGoalCommand.count({ where: { userId: f.userId } })).toBe(1)
    expect(await prisma.agentGoalExecution.count({ where: { goalId: goal!.id } })).toBe(0)
    expect(await prisma.agentRun.findUnique({ where: { id: f.runId } })).toEqual(before)
    await superviseAgentGoal(f.userId, f.sessionId, goal!.id)
    expect(await prisma.agentGoalExecution.count({ where: { goalId: goal!.id } })).toBe(0)
    expect(await prisma.agentProviderAttempt.count({ where: { runId: f.runId } })).toBe(0)
    expect(f.ctx.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'goal.snapshot' }))
  })
  it.each(['unknown-source', 'no-request', 'discussion-en', 'discussion-en-2', 'discussion-zh', 'inline-child', 'spawned', 'specialist', 'foreign-session', 'foreign-owner'])('rejects %s without goal/command effects', async kind => {
    const prompts: Record<string, string> = { 'no-request': '写下一章', 'discussion-en': 'Explain whether I should use goal mode.',
      'discussion-en-2': 'Tell me why people use goal mode.', 'discussion-zh': '解释是否应该 使用目标模式' }
    const f = await fixture(prompts[kind], kind !== 'unknown-source')
    let ctx = f.ctx
    if (kind === 'inline-child') ctx = { ...ctx, inlineChild: true }
    if (kind === 'spawned') await prisma.agentSession.update({ where: { id: f.sessionId }, data: { spawnedFromSessionId: 'model-created' } })
    if (kind === 'specialist') await prisma.agentRun.update({ where: { id: f.runId }, data: { agentType: 'storyPlanner' } })
    if (kind === 'foreign-session') ctx = { ...ctx, sessionId: (await fixture()).sessionId }
    if (kind === 'foreign-owner') ctx = { ...ctx, userId: (await fixture()).userId }
    expect(await goalEnableTool.execute(ctx, {})).toMatchObject({ outcome: 'failed' })
    expect(await prisma.agentGoal.count({ where: { userId: f.userId } })).toBe(0)
    expect(await prisma.agentGoalCommand.count({ where: { userId: f.userId } })).toBe(0)
    expect(ctx.emit).not.toHaveBeenCalled()
  })
  it('keeps unknown billing unsettled and imports real known usage once without charging', async () => {
    const f = await fixture(), goal = await enable(f)
    const usage = await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, targetType: 'agentRun', targetId: f.runId,
      agentRunId: f.runId, providerType: 'text', providerMode: 'test', modelName: 'test', modelTier: 'speed', action: 'workspaceAgent',
      billingStatus: 'pending_usage', usageSource: 'unknown', durationMs: 1 } })
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'completed', finishedAt: new Date() } })
    await superviseAgentGoal(f.userId, f.sessionId, goal.id)
    await superviseAgentGoal(f.userId, f.sessionId, goal.id)
    expect((await readAgentGoal(f.userId, f.sessionId))?.reasonCode).toBe('GOAL_ACTIVATION_PENDING')
    expect(await prisma.agentGoalExecution.count({ where: { goalId: goal.id } })).toBe(0)
    expect((await prisma.agentGoalUsage.findUniqueOrThrow({ where: { sourceKey: `legacy:${usage.id}` } })).status).toBe('unknown')
    await prisma.aiUsageLog.update({ where: { id: usage.id }, data: { billingStatus: 'settled', usageSource: 'reported', requestTokens: 123, responseTokens: 45, creditChargeMilli: 7 } })
    await superviseAgentGoal(f.userId, f.sessionId, goal.id)
    await superviseAgentGoal(f.userId, f.sessionId, goal.id)
    expect(await readAgentGoal(f.userId, f.sessionId)).toMatchObject({ tokensUsed: '168', creditsUsedMicros: '7000', phase: 'awaiting_input' })
    expect(await prisma.agentGoalUsage.count({ where: { goalId: goal.id } })).toBe(1)
    expect(await prisma.agentRun.count({ where: { userId: f.userId } })).toBe(1)
  })
  it('preserves a pending manual pause/cancel and rejects edits until settlement', async () => {
    const f = await fixture(), goal = await enable(f)
    await expect(updateAgentGoal(f.userId, f.sessionId, goal.id, { requestId: randomUUID(), expectedStateVersion: goal.stateVersion,
      expectedRevision: 1, objective: '改成写两章' })).rejects.toMatchObject({ code: 'GOAL_RECONCILIATION_REQUIRED' })
    await actOnAgentGoal(f.userId, f.sessionId, goal.id, { requestId: randomUUID(), expectedStateVersion: goal.stateVersion, action: 'pause' })
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).status).toBe('paused')
    await superviseAgentGoal(f.userId, f.sessionId, goal.id)
    expect((await readAgentGoal(f.userId, f.sessionId))?.status).toBe('paused')
    await expect(actOnAgentGoal(f.userId, f.sessionId, goal.id, { requestId: randomUUID(), expectedStateVersion: (await readAgentGoal(f.userId, f.sessionId))!.stateVersion,
      action: 'resume', model: { modelTier: 'custom', customModelId: 'replacement' } })).rejects.toMatchObject({ code: 'GOAL_ACTIVATION_SCOPE_IMMUTABLE' })
    const cancelled = await actOnAgentGoal(f.userId, f.sessionId, goal.id, { requestId: randomUUID(), expectedStateVersion: (await readAgentGoal(f.userId, f.sessionId))!.stateVersion, action: 'cancel' })
    expect(cancelled.status).toBe('cancelled')
    expect(await goalEnableTool.execute(f.ctx, {})).toMatchObject({ outcome: 'failed' })
    expect(await prisma.agentGoal.count({ where: { userId: f.userId } })).toBe(1)
  })
  it('supports two human pause/continue cycles and request replay without reissuing consumed grants or resetting usage', async () => {
    const f = await fixture(), initial = await enable(f)
    for (let round = 0; round < 2; round++) {
      const before = (await readAgentGoal(f.userId, f.sessionId))!
      await actOnAgentGoal(f.userId, f.sessionId, initial.id, { requestId: randomUUID(), expectedStateVersion: before.stateVersion, action: 'pause' })
      await superviseAgentGoal(f.userId, f.sessionId, initial.id)
      const paused = (await readAgentGoal(f.userId, f.sessionId))!, request = { requestId: randomUUID(), expectedStateVersion: paused.stateVersion, action: 'resume' as const }
      const granted = await actOnAgentGoal(f.userId, f.sessionId, initial.id, request)
      expect(await actOnAgentGoal(f.userId, f.sessionId, initial.id, request)).toEqual(granted)
      const action = await prisma.$transaction(async tx => reconcileGoalActivation(tx, await lockOwnedGoal(tx, f.userId, f.sessionId, initial.id), new Date()))
      expect(action).toMatchObject({ kind: 'activation_continue', runId: f.runId })
      const record = await prisma.agentGoal.findUniqueOrThrow({ where: { id: initial.id } })
      await startLegacyRuntimeRun(f.userId, f.runId, true, { goalId: initial.id, epoch: record.epoch })
      expect((await prisma.agentGoalEvidence.findUniqueOrThrow({ where: { goalId_revision_criterionId: { goalId: initial.id, revision: 1, criterionId: 'activation-resume' } } })).status).toBe('consumed')
      expect(await actOnAgentGoal(f.userId, f.sessionId, initial.id, request)).toEqual(granted)
      expect((await prisma.agentGoalEvidence.findUniqueOrThrow({ where: { goalId_revision_criterionId: { goalId: initial.id, revision: 1, criterionId: 'activation-resume' } } })).status).toBe('consumed')
    }
    expect((await readAgentGoal(f.userId, f.sessionId))?.tokensUsed).toBe(initial.tokensUsed)
    expect(await prisma.agentRun.count({ where: { userId: f.userId } })).toBe(1)
    expect(await prisma.agentProviderAttempt.count({ where: { runId: f.runId } })).toBe(0)
  })
  it('retains the original activation ceiling only for revision 1, while a new human objective revision has independent native authority', async () => {
    const f = await fixture('请启用目标模式，调研一段历史背景'), initial = await enable(f)
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'completed' } })
    await superviseAgentGoal(f.userId, f.sessionId, initial.id)
    const current = (await readAgentGoal(f.userId, f.sessionId))!
    const before = await prisma.agentGoal.findUniqueOrThrow({ where: { id: initial.id } })
    expect(await prisma.$transaction(tx => readGoalActivationToolCeiling(tx, before))).not.toBeNull()
    await updateAgentGoal(f.userId, f.sessionId, initial.id, { requestId: randomUUID(), expectedRevision: 1, expectedStateVersion: current.stateVersion, objective: '写下一章完整正文' })
    await prisma.$transaction(async tx => {
      const pending = await lockOwnedGoal(tx, f.userId, f.sessionId, initial.id)
      // Exercise the same revision gate that the supervisor applies, without
      // dispatching a paid model in this integration suite.
      const next = { ...pending, currentRevision: pending.pendingRevision! }
      expect(await readGoalActivationToolCeiling(tx, next)).toBeNull()
      expect((await tx.agentGoalRevision.findUniqueOrThrow({ where: { goalId_revision: { goalId: initial.id, revision: 2 } } })).objective).toBe('写下一章完整正文')
      expect(await tx.agentGoalExecution.count({ where: { goalId: initial.id, goalRevision: 2 } })).toBe(0)
      const revisionGoal = await tx.agentGoal.update({ where: { id: initial.id }, data: { currentRevision: 2, pendingRevision: null, currentRunId: null, status: 'active' } })
      const admission = await admitGoalRun(tx, f.userId, f.sessionId, f.novelId, { goalId: initial.id, revision: 2, epoch: revisionGoal.epoch,
        continuationIndex: revisionGoal.continuationIndex, trigger: 'revision', sourceEventId: 'human-revision-2' }, '写下一章完整正文')
      expect(admission.previous).toBeNull()
      const revisedSpec = buildTaskSpec({ runId: randomUUID(), novelId: f.novelId, chapterId: null, prompt: '写下一章完整正文' })
      const nativeTools = restrictToolsToTask(getToolsForAgent(getAgentDefinition('orchestrator'), 'build', undefined, { goalOwned: true }), revisedSpec)
      expect(nativeTools.some(tool => tool.name === 'chapter_create')).toBe(true)
      const oldCeiling = await readGoalActivationToolCeiling(tx, before)
      expect(intersectToolAuthority(nativeTools, 'build', new Map(oldCeiling!)).some(tool => tool.name === 'chapter_create')).toBe(false)
      expect(await readGoalActivationToolCeiling(tx, revisionGoal)).toBeNull()
    })
  })
  it('completes from current chapter/bridge receipts without another paid round', async () => {
    const f = await fixture(), goal = await enable(f)
    const volume = await prisma.volume.create({ data: { novelId: f.novelId, title: '测试', orderIndex: 1 } })
    const chapter = await prisma.chapter.create({ data: { authorId: f.userId, novelId: f.novelId, volumeId: volume.id, title: '第一章',
      content: '真实保存的正文', wordCount: 7, orderIndex: 1, orderInVolume: 1 } })
    const compilation = await prisma.storyCompilation.create({ data: { userId: f.userId, novelId: f.novelId, runId: f.runId,
      chapterId: chapter.id, targetOrderIndex: 1, sourcePromptHash: 'test-source', preparedContext: {}, status: 'completed' } })
    await prisma.chapterBridge.create({ data: { userId: f.userId, novelId: f.novelId, compilationId: compilation.id, toChapterId: chapter.id,
      targetOrderIndex: 1, targetRevision: chapter.revision, committedAt: new Date(), knowledgeState: {}, bodyState: {}, objectState: {},
      relationshipState: {}, emotionAftermath: {}, recentOpenings: [], recentEndings: [], openLoops: [] } })
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'completed', finishedAt: new Date() } })
    await superviseAgentGoal(f.userId, f.sessionId, goal.id)
    await superviseAgentGoal(f.userId, f.sessionId, goal.id)
    expect(await readAgentGoal(f.userId, f.sessionId)).toMatchObject({ status: 'completed' })
    expect(await prisma.agentRun.count({ where: { userId: f.userId } })).toBe(1)
    expect(await prisma.agentProviderAttempt.count({ where: { runId: f.runId } })).toBe(0)
  })
  it('commits durable cursor/effect/pending goal together, projects once, and preserves root configuration/budget', async () => {
    const f = await fixture()
    const root = await initializeDurableTask({ userId: f.userId, runId: f.runId, sourceMessageId: f.messageId })
    const lease = await acquireRunLease({ userId: f.userId, runId: f.runId, ownerId: 'goal-activation-test', claimId: randomUUID() })
    const configuration = { version: 1 as const, mode: 'build' as const, agentType: 'orchestrator', creativeFreedom: 'balanced' as const,
      qualityMode: 'premium' as const, model: { tier: 'speed', provider: 'test', modelName: 'test', customModelId: null, reasoningEffort: 'high', routeRevision: 'a'.repeat(64) },
      tools: toOpenAITools([goalEnableTool]), toolAuthority: [{ name: 'goal_enable', permission: 'allow' as const, alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] }
    await initializeExecutionState(lease, { configuration, snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0,
      phase: 'idle', pendingOperationId: null, successfulToolSignatures: [], messages: [{ role: 'user', content: '原始任务' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'enable-goal', name: 'goal_enable', arguments: '{}' }] }] } })
    const before = await loadExecutionState(f.userId, f.runId)
    const budget = await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: root.id } })
    expect((await executeDurableToolStep(lease, f.ctx.signal)).kind).toBe('tool')
    const goal = await readAgentGoal(f.userId, f.sessionId)
    expect(goal).toMatchObject({ currentRunId: f.runId, reasonCode: 'GOAL_ACTIVATION_PENDING' })
    expect(await prisma.agentGoalExecution.count({ where: { goalId: goal!.id } })).toBe(0)
    const after = await loadExecutionState(f.userId, f.runId)
    expect(after.head.configurationHash).toBe(before.head.configurationHash)
    expect(after.originalRequest).toEqual(before.originalRequest)
    expect(await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: root.id } })).toEqual(budget)
    const events = await publishDurableEvents(f.userId, f.runId)
    expect(events.filter(event => event.type === 'goal.snapshot')).toHaveLength(1)
    expect((await publishDurableEvents(f.userId, f.runId)).filter(event => event.type === 'goal.snapshot')).toHaveLength(0)
    expect((await executeDurableToolStep(lease, f.ctx.signal)).kind).toBe('idle')
    await releaseRunLease(lease)
  })
})
