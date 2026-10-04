import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'
import { encryptSecret } from '../../api/lib/secret-box.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { initializeDurableTask } from '../../api/lib/agent/runtime-identity.js'
import { acquireRunLease } from '../../api/lib/agent/runtime-lease.js'
import { initializeExecutionState, loadExecutionState, saveExecutionState } from '../../api/lib/agent/runtime-state.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { runReviewedDurableExecution } from '../../api/lib/agent/runtime-executor.js'
import { dispatchDurableChild, awaitDurableChildren } from '../../api/lib/agent/runtime-child-tools.js'
import { admitChildExecution, verifyChildGrant, assertPinnedChildCompletion } from '../../api/lib/agent/runtime-child.js'
import { subAgentRunTool, subAgentDelegateTool } from '../../api/lib/agent/tools/subagent-tools.js'
import { taskSpawnTool, taskWaitTool, taskSendTool } from '../../api/lib/agent/tools/task-orchestration-tools.js'
import { chapterReadTool } from '../../api/lib/agent/tools/read-tools.js'
import { toOpenAIParameters } from '../../api/lib/agent/tool-schema.js'
import { modelRouteRevision } from '../../api/lib/agent/runtime-model-cursor.js'
import { freezeModelAssignments, patchModelAssignments } from '../../api/lib/agent/model-assignments.js'
import { listQueuedRequests } from '../../api/lib/agent/request-queue.js'
import { deleteAgentSessionData, listAgentSessionHistoryData, listSessionRunStatuses, stopLoopRun } from '../../api/lib/agent/run-service.js'
import type { AgentTool } from '../../api/lib/agent/tools/types.js'
import { env } from '../../api/config/env.js'
import { createAgentGoal, actOnAgentGoal } from '../../api/lib/agent/goal-service.js'
import { acquireRunLease as claimLease, releaseRunLease } from '../../api/lib/agent/runtime-lease.js'
import { withRunLease } from '../../api/lib/agent/runtime-lease.js'
import { readTaskBudget } from '../../api/lib/agent/runtime-budget.js'
import { forkAgentSessionData } from '../../api/lib/agent/run-service.js'
import { publishDurableEvents } from '../../api/lib/agent/runtime-event-projection.js'
import { pauseDurableTask } from '../../api/lib/agent/runtime-lifecycle.js'
import { resumeDurableTask } from '../../api/lib/agent/runtime-resume.js'
import { prepareToolCursorOperation } from '../../api/lib/agent/runtime-tool-cursor.js'
import { childContext } from '../../api/lib/agent/runtime-child-tools.js'
import { deleteLoopSessionMessage, rollbackLoopSessionFromMessage, listLoopSessionMessages, loadCurrentTodoSnapshot } from '../../api/lib/agent/session-messages.js'
import { withGoalTransaction, withoutGoalEffects } from '../../api/lib/agent/goal-context.js'
import { observeGoalUsage, syncGoalDurableUsage } from '../../api/lib/agent/goal-budget.js'
import * as childLease from '../../api/lib/agent/runtime-lease.js'
import { getActiveRun } from '../../api/lib/agent/active-runs.js'
import { streamLoopRun } from '../../api/lib/agent/run-service.js'

const available = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
afterAll(async () => { await prisma.$disconnect() })
const previousGoalEnabled = env.agentGoalEnabled
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); env.agentGoalEnabled = previousGoalEnabled })

async function fixture(work: (f: { userId: string; novelId: string; sessionId: string; modelA: string; modelB: string; definitionId: string }) => Promise<void>) {
  const userId = randomUUID(), novelId = randomUUID(), sessionId = randomUUID(), modelA = randomUUID(), modelB = randomUUID(), definitionId = randomUUID()
  await prisma.user.create({ data: { id: userId, nickname: 'durable-native-isolated', passwordHash: 'test-only' } })
  try {
    await prisma.novel.create({ data: { id: novelId, authorId: userId, title: '测试', slug: randomUUID(), summary: '' } })
    await prisma.agentSession.create({ data: { id: sessionId, userId, novelId, title: '父任务', toolPolicy: { contentWrite: 'allow' } } })
    await prisma.aiModelConfig.createMany({ data: [modelA, modelB].map((id, i) => ({ id, ownerUserId: userId, key: `child:${id}`, provider: 'openai',
      displayName: `模型${i ? 'B' : 'A'}`, modelName: `模型${i ? 'B' : 'A'}`, baseUrl: 'https://fixture.invalid/v1', apiKeyCiphertext: encryptSecret('isolated-never-used'), multiplierBps: 0,
      metadata: { reasoningEfforts: ['low', 'high', 'medium'], defaultReasoningEffort: i ? 'high' : 'low', contextWindowTokens: 128000 } })) })
    await prisma.agentSubtask.create({ data: { id: definitionId, userId, novelId, name: '指定研究员', role: 'research', prompt: '阅读原始上下文，只做审阅报告。',
      triggerCondition: '需要审阅', enabled: true, tokenBudget: 16000, status: 'ready' } })
    await work({ userId, novelId, sessionId, modelA, modelB, definitionId })
  } finally {
    const children = await prisma.agentChildExecutionGrant.findMany({ where: { childRun: { userId } }, select: { childRunId: true } })
    await Promise.allSettled(children.map(child => dispatchDurableChild(userId, child.childRunId)))
    await prisma.agentChildExecutionGrant.deleteMany({ where: { childRun: { userId } } })
    await prisma.agentGoal.deleteMany({ where: { userId } })
    await prisma.agentArtifact.deleteMany({ where: { run: { userId } } })
    await prisma.agentRun.deleteMany({ where: { userId } })
    await prisma.agentSession.deleteMany({ where: { userId } })
    await prisma.chapter.deleteMany({ where: { authorId: userId } })
    await prisma.volume.deleteMany({ where: { novel: { authorId: userId } } })
    await prisma.novel.deleteMany({ where: { authorId: userId } })
    await prisma.user.delete({ where: { id: userId } })
  }
}

async function execution(f: Parameters<Parameters<typeof fixture>[0]>[0], tool: AgentTool, args: Record<string, unknown>, assigned = false, pin = false, goalBound = false, tokenBudget = 64000) {
  if (assigned) await patchModelAssignments(f.userId, { scope: 'global', expectedRevision: 0, assignments: { subagent: { modelTier: 'custom', customModelId: f.modelB }, spawned_task: { modelTier: 'custom', customModelId: f.modelB } } })
  const prefs = await freezeModelAssignments(f.userId, f.novelId)
  const runId = randomUUID(), callId = randomUUID(), prompt = '只读审阅并提交报告'
  const goal = goalBound ? await (async () => {
    env.agentGoalEnabled = true
    return createAgentGoal(f.userId, { sessionId: f.sessionId }, { requestId: randomUUID(), objective: prompt, options: { mode: 'review' }, limits: { tokenLimit: 64000, activeTimeLimitMs: 3600000 } })
  })() : null
  const spec = { ...buildTaskSpec({ runId, novelId: f.novelId, prompt }), intent: 'review' as const, postconditions: [],
    expectedOutputs: [{ kind: 'validation_report' as const, required: true, description: '报告' }] }
  await prisma.agentRun.create({ data: { id: runId, userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, engine: 'loop', mode: 'review', status: 'queued',
    action: 'workspaceAgent', agentType: 'writingOrchestrator', modelTier: 'custom', customModelId: f.modelA, reasoningEffort: 'low', taskSpec: JSON.parse(JSON.stringify(spec)) } })
  const message = await prisma.agentMessage.create({ data: { runId, sessionId: f.sessionId, role: 'user', parts: [{ type: 'text', text: prompt }] } })
  if (goal) {
    await prisma.agentGoalExecution.create({ data: { goalId: goal.id, goalRevision: 1, epoch: 1n, continuationIndex: 1, runId, trigger: 'author', sourceEventId: `fixture:${runId}` } })
    await prisma.agentGoal.update({ where: { id: goal.id }, data: { currentRunId: runId, continuationIndex: 1, phase: 'executing', activeSince: new Date() } })
  }
  const root = await initializeDurableTask({ userId: f.userId, runId, sourceMessageId: message.id, tokenBudget })
  const lease = await acquireRunLease({ userId: f.userId, runId, ownerId: 'native-parent', claimId: randomUUID() })
  await prisma.agentRun.update({ where: { id: runId }, data: { status: 'running' } })
  const tools = [subAgentRunTool, subAgentDelegateTool, taskSpawnTool, taskWaitTool, taskSendTool, chapterReadTool]
  const initial = await initializeExecutionState(lease, { configuration: { version: 1, mode: 'review', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
    ...(prefs ? { modelAssignments: prefs } : {}), ...(pin ? { pinnedSubagentId: f.definitionId } : {}),
    model: { tier: 'custom', customModelId: f.modelA, provider: 'openai', modelName: '模型A', reasoningEffort: 'low', maxOutputTokens: 100,
      routeRevision: modelRouteRevision({ provider: 'openai', model: '模型A', endpoint: 'https://fixture.invalid/v1/chat/completions', reasoningEffort: 'low' }) },
    tools: tools.map(item => ({ type: 'function', function: { name: item.name, description: item.description, parameters: toOpenAIParameters(item.parameters) } })),
    toolAuthority: tools.map(item => ({ name: item.name, permission: 'allow', alwaysConfirm: false, dangerous: false })), protectedChapterIds: [], pinnedSkillVersions: [] },
    snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
      messages: [{ role: 'system', content: '完整原始作品设定 KEEP_CONTEXT' }, { role: 'user', content: prompt },
        { role: 'assistant', content: null, toolCalls: [{ id: callId, name: tool.name, arguments: JSON.stringify(args) }] }], successfulToolSignatures: [] } })
  return { runId, root, lease, initial, callId, goalId: goal?.id }
}

function mockProvider(parallelFirstPair = false) {
  let entered = 0, release!: () => void
  const bothEntered = new Promise<void>(resolve => { release = resolve })
  const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => {
    if (parallelFirstPair && ++entered <= 2) {
      if (entered === 2) release()
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([bothEntered, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Both child HTTP calls must enter before either returns')), 5000) })]) }
      finally { clearTimeout(timer) }
    }
    return new Response('data: {"choices":[{"delta":{"content":"已完成只读审阅。报告：原始设定完整，未修改正文。"},"finish_reason":"stop"}],"usage":{"prompt_tokens":50,"completion_tokens":10,"prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":50}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

async function completeParent(exec: Awaited<ReturnType<typeof execution>>, userId: string) {
  const state = await loadExecutionState(userId, exec.runId)
  await saveExecutionState(exec.lease, { expectedRevision: state.frame.revision, expectedHash: state.frame.snapshotHash,
    snapshot: { ...state.frame.state, messages: [...state.frame.state.messages, { role: 'assistant', content: '审阅报告已完成，原始设定完整。' }] } })
  expect((await runReviewedDurableExecution(exec.lease, new AbortController().signal)).kind).toBe('completed')
}

describe.runIf(available)('durable native child HTTP path in isolated PG', () => {
  it('keeps public messages, pagination, session state and todo on the main run with a newer inline execution', async () => fixture(async f => {
    mockProvider()
    const exec = await execution(f, subAgentRunTool, { subagentId: f.definitionId, task: '只读报告' })
    await executeDurableToolStep(exec.lease, new AbortController().signal)
    const grant = await prisma.agentChildExecutionGrant.findFirstOrThrow({ where: { parentRootId: exec.root.id } })
    await publishDurableEvents(f.userId, grant.childRunId)
    await prisma.agentMessage.create({ data: { runId: grant.childRunId, sessionId: f.sessionId, role: 'assistant', parts: [{ type: 'text', text: 'PRIVATE_INLINE_ONLY' }] } })
    for (const options of [{}, { runLimit: 1 }]) {
      const history = await listLoopSessionMessages(f.userId, f.sessionId, options)
      expect(history.activeRunId).toBe(exec.runId)
      expect(history.todoSnapshot?.runId).toBe(exec.runId)
      expect(history.messages.every(message => message.runId !== grant.childRunId)).toBe(true)
      expect(JSON.stringify(history)).not.toContain('PRIVATE_INLINE_ONLY')
      expect(history.pagination.hasMore).toBe(false)
    }
    expect((await loadCurrentTodoSnapshot(f.userId, f.sessionId))?.runId).toBe(exec.runId)
    await expect(streamLoopRun(f.userId, grant.childRunId, 0, {} as Parameters<typeof streamLoopRun>[3])).rejects.toMatchObject({ status: 404 })
  }), 30000)

  it.each(['delete', 'rollback'] as const)('atomically removes private inline run and root during public single-turn %s', async action => fixture(async f => {
    mockProvider()
    const exec = await execution(f, subAgentRunTool, { subagentId: f.definitionId, task: '只读报告' })
    await executeDurableToolStep(exec.lease, new AbortController().signal)
    const grant = await prisma.agentChildExecutionGrant.findFirstOrThrow({ where: { parentRootId: exec.root.id }, include: { childRun: true } })
    await publishDurableEvents(f.userId, grant.childRunId)
    await completeParent(exec, f.userId)
    const source = await prisma.agentMessage.findFirstOrThrow({ where: { runId: exec.runId, role: 'user' } })
    if (action === 'delete') await deleteLoopSessionMessage(f.userId, f.sessionId, source.id)
    else await rollbackLoopSessionFromMessage(f.userId, f.sessionId, source.id)
    expect(await prisma.agentChildExecutionGrant.findUnique({ where: { id: grant.id } })).toBeNull()
    expect(await prisma.agentRun.findUnique({ where: { id: grant.childRunId } })).toBeNull()
    expect(await prisma.agentTaskRoot.findUnique({ where: { id: grant.childRun.taskRootId! } })).toBeNull()
    expect((await listAgentSessionHistoryData(f.userId, f.sessionId)).items).toHaveLength(0)
    expect((await listLoopSessionMessages(f.userId, f.sessionId)).messages).toHaveLength(0)
    await expect(streamLoopRun(f.userId, grant.childRunId, 0, {} as Parameters<typeof streamLoopRun>[3])).rejects.toMatchObject({ status: 404 })
  }), 30000)

  it('preserves spawned provenance when parent deletion would orphan it, then allows child-first deletion', async () => fixture(async f => {
    mockProvider()
    const exec = await execution(f, taskSpawnTool, { tasks: [{ title: '独立窗口', brief: '只读审阅原始作品设定并提交完整报告，保持原有正文不变。' }], mode: 'review', inherit: 'brief' })
    await executeDurableToolStep(exec.lease, new AbortController().signal)
    const grant = await prisma.agentChildExecutionGrant.findFirstOrThrow({ where: { parentRootId: exec.root.id }, include: { childRun: true } })
    await dispatchDurableChild(f.userId, grant.childRunId)
    await completeParent(exec, f.userId)
    const source = await prisma.agentMessage.findFirstOrThrow({ where: { runId: exec.runId, role: 'user' } })
    await expect(deleteLoopSessionMessage(f.userId, f.sessionId, source.id)).rejects.toMatchObject({ code: 'RUNTIME_CHILD_DELETION_BLOCKED' })
    await expect(rollbackLoopSessionFromMessage(f.userId, f.sessionId, source.id)).rejects.toMatchObject({ code: 'RUNTIME_CHILD_DELETION_BLOCKED' })
    expect(await prisma.agentChildExecutionGrant.findUniqueOrThrow({ where: { id: grant.id } })).toMatchObject({ snapshotHash: grant.snapshotHash })
    expect(await prisma.agentMessage.findUnique({ where: { id: source.id } })).not.toBeNull()
    expect(await prisma.agentRun.findUnique({ where: { id: grant.childRunId } })).not.toBeNull()
    await deleteAgentSessionData(f.userId, grant.childRun.sessionId)
    expect(await deleteLoopSessionMessage(f.userId, f.sessionId, source.id)).toMatchObject({ deleted: true })
    expect(await prisma.agentRun.findUnique({ where: { id: exec.runId } })).toBeNull()
  }), 30000)

  it.each(['run', 'delegate'] as const)('returns only current B %s delivery despite prior A and an unrelated cancelled window', async kind => fixture(async f => {
    const fetcher = mockProvider()
    const exec = await execution(f, subAgentRunTool, { subagentId: f.definitionId, task: '交付报告A' })
    await executeDurableToolStep(exec.lease, new AbortController().signal)
    const a = await prisma.agentChildExecutionGrant.findFirstOrThrow({ where: { parentRootId: exec.root.id } })
    let state = await loadExecutionState(f.userId, exec.runId)
    const spawnArgs = { tasks: [{ title: '历史窗口', brief: '只读审阅原始作品设定并提交完整报告，保持原有正文不变。' }], mode: 'review', inherit: 'brief' }
    const frame = await saveExecutionState(exec.lease, { expectedRevision: state.frame.revision, expectedHash: state.frame.snapshotHash, snapshot: { ...state.frame.state,
      messages: [...state.frame.state.messages, { role: 'assistant', content: null, toolCalls: [{ id: 'cancelled-window', name: taskSpawnTool.name, arguments: JSON.stringify(spawnArgs) }] }] } })
    const prepared = await prepareToolCursorOperation(exec.lease, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash }, {
      key: `exec:${frame.state.nextOperationSequence}`, action: taskSpawnTool.name, callId: 'cancelled-window', targetId: exec.root.id,
      effectDomain: 'read', effectiveArgs: spawnArgs, operationInput: { callId: 'cancelled-window', args: spawnArgs }, normalize: raw => taskSpawnTool.parameters.parse(raw) })
    const cancelled = await admitChildExecution(exec.lease, { parentOperationId: prepared.operation.id, childIndex: 0, kind: 'spawned', role: 'orchestrator',
      name: '历史窗口', prompt: spawnArgs.tasks[0].brief, spec: { ...verifyChildGrant(a).taskSpec, id: randomUUID() }, configuration: state.configuration,
      price: verifyChildGrant(a).price, tokenCeiling: 1000, turnCeiling: 3, roleTools: ['chapter_read'], messages: childContext(frame.state.messages, spawnArgs.tasks[0].brief, '只读报告') })
    const cancelledRun = await prisma.agentRun.findUniqueOrThrow({ where: { id: cancelled.childRunId } })
    await prisma.$transaction(async tx => {
      await tx.agentChildExecutionGrant.update({ where: { id: cancelled.id }, data: { status: 'cancelled' } })
      await tx.agentRun.update({ where: { id: cancelled.childRunId }, data: { status: 'cancelled' } })
      await tx.agentTaskRoot.update({ where: { id: cancelledRun.taskRootId! }, data: { status: 'cancelled' } })
      await tx.agentRunLease.update({ where: { runId: cancelled.childRunId }, data: { enabled: false } })
    })
    await executeDurableToolStep(exec.lease, new AbortController().signal)
    const bDefinition = await prisma.agentSubtask.create({ data: { userId: f.userId, novelId: f.novelId, name: '研究员B', role: 'research', prompt: '交付B', triggerCondition: '复核', enabled: true } })
    state = await loadExecutionState(f.userId, exec.runId)
    const tool = kind === 'run' ? subAgentRunTool : subAgentDelegateTool
    const args = kind === 'run' ? { subagentId: bDefinition.id, task: '交付报告B' }
      : { name: bDefinition.name, role: 'research', prompt: '交付B', triggerCondition: '复核', task: '交付报告B' }
    await saveExecutionState(exec.lease, { expectedRevision: state.frame.revision, expectedHash: state.frame.snapshotHash, snapshot: { ...state.frame.state,
      messages: [...state.frame.state.messages, { role: 'assistant', content: null, toolCalls: [{ id: 'current-B', name: tool.name, arguments: JSON.stringify(args) }] }] } })
    const result = await executeDurableToolStep(exec.lease, new AbortController().signal)
    const b = await prisma.agentChildExecutionGrant.findFirstOrThrow({ where: { parentRootId: exec.root.id, parentOperation: { inputSnapshot: { path: ['input', 'callId'], equals: 'current-B' } } } })
    expect(result.kind).toBe('tool')
    expect('result' in result && result.result.display).toMatchObject({ kind: 'subagentReport', subagentRunId: b.id, subagentName: '研究员B', status: 'success' })
    expect('result' in result && result.result.output).not.toContain('指定研究员')
    expect('result' in result && result.result.output).not.toContain('历史窗口')
    await expect(awaitDurableChildren(exec.lease, new AbortController().signal, { operation: { id: b.parentOperationId, grantIds: [] } })).rejects.toMatchObject({ code: 'RUNTIME_CHILD_SOURCE_REQUIRED' })
    await expect(awaitDurableChildren(exec.lease, new AbortController().signal, { operation: { id: a.parentOperationId, grantIds: [a.id] } })).rejects.toMatchObject({ code: 'RUNTIME_CHILD_SOURCE_REQUIRED' })
    expect((await awaitDurableChildren(exec.lease, new AbortController().signal, { timeoutMs: 0 })).map(grant => grant.id)).toContain(cancelled.id)
    state = await loadExecutionState(f.userId, exec.runId)
    await saveExecutionState(exec.lease, { expectedRevision: state.frame.revision, expectedHash: state.frame.snapshotHash, snapshot: { ...state.frame.state,
      messages: [...state.frame.state.messages, { role: 'assistant', content: '报告已完成。' }] } })
    expect((await runReviewedDurableExecution(exec.lease, new AbortController().signal)).kind).toBe('needs_attention')
    expect(fetcher).toHaveBeenCalledTimes(2)
  }), 30000)

  it.each(['inline', 'spawned'] as const)('allows public window deletion only after the canonical %s lineage completes', async kind => fixture(async f => {
    mockProvider()
    const exec = await execution(f, kind === 'inline' ? subAgentRunTool : taskSpawnTool, kind === 'inline'
      ? { subagentId: f.definitionId, task: '只读审阅并提交报告' }
      : { tasks: [{ title: '审阅窗口', brief: '只读审阅原始作品设定并提交完整报告，保持原有正文不变。' }], mode: 'review', inherit: 'brief' })
    await executeDurableToolStep(exec.lease, new AbortController().signal)
    const grant = await prisma.agentChildExecutionGrant.findFirstOrThrow({ where: { parentRootId: exec.root.id }, include: { childRun: true } })
    await dispatchDurableChild(f.userId, grant.childRunId)
    const state = await loadExecutionState(f.userId, exec.runId)
    await saveExecutionState(exec.lease, { expectedRevision: state.frame.revision, expectedHash: state.frame.snapshotHash,
      snapshot: { ...state.frame.state, messages: [...state.frame.state.messages, { role: 'assistant', content: '审阅报告已完成，原始设定完整。' }] } })
    expect((await runReviewedDurableExecution(exec.lease, new AbortController().signal)).kind).toBe('completed')
    const targetSession = kind === 'spawned' ? grant.childRun.sessionId : f.sessionId
    expect(await deleteAgentSessionData(f.userId, targetSession)).toMatchObject({ deleted: true })
    expect(await prisma.agentSession.findUnique({ where: { id: targetSession } })).toBeNull()
    expect(await prisma.agentChildExecutionGrant.findUnique({ where: { id: grant.id } })).toBeNull()
  }), 30000)

  it('denies public deletion of an active unknown lineage while retaining acquired evidence and authorization', async () => fixture(async f => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('deletion-held-unknown') }))
    const exec = await execution(f, taskSpawnTool, { tasks: [{ title: '未知窗口', brief: '只读审阅原始作品设定并提交完整报告，保持原有正文不变。' }], mode: 'review', inherit: 'brief' })
    await executeDurableToolStep(exec.lease, new AbortController().signal)
    const grant = await prisma.agentChildExecutionGrant.findFirstOrThrow({ where: { parentRootId: exec.root.id } })
    await dispatchDurableChild(f.userId, grant.childRunId).catch(() => {})
    const attempt = await prisma.agentProviderAttempt.findFirstOrThrow({ where: { runId: grant.childRunId } })
    await expect(deleteAgentSessionData(f.userId, f.sessionId)).rejects.toMatchObject({ code: 'RUNTIME_CHILD_DELETION_BLOCKED' })
    expect(await prisma.agentSession.findUnique({ where: { id: f.sessionId } })).not.toBeNull()
    expect(await prisma.agentChildExecutionGrant.findUnique({ where: { id: grant.id } })).not.toBeNull()
    expect(await prisma.agentProviderAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toMatchObject({ requestHash: attempt.requestHash, status: 'unknown', dispatchedAt: attempt.dispatchedAt })
    await expect(claimLease({ userId: f.userId, runId: grant.childRunId, ownerId: 'late-delete-child', claimId: randomUUID() })).rejects.toBeDefined()
  }), 30000)

  it.each(['inherit', 'assigned', 'explicit', 'explicit-effort'] as const)('runs inline child through saved durable cursor (%s)', async selection => fixture(async f => {
    const fetcher = mockProvider()
    const model = selection.startsWith('explicit') ? { modelTier: 'custom', customModelId: selection === 'explicit' ? f.modelB : f.modelA,
      ...(selection === 'explicit-effort' ? { reasoningEffort: 'medium' } : {}) } : undefined
    const exec = await execution(f, subAgentRunTool, { subagentId: f.definitionId, task: '只读审阅原始设定并提交完整报告', ...(model ? { model } : {}) }, selection !== 'inherit', true)
    await expect(prisma.$transaction(tx => assertPinnedChildCompletion(tx, exec.root.id))).rejects.toMatchObject({ code: 'RUNTIME_PINNED_CHILD_REQUIRED' })
    expect((await executeDurableToolStep(exec.lease, new AbortController().signal)).kind).toBe('tool')
    const grants = await prisma.agentChildExecutionGrant.findMany({ where: { parentRootId: exec.root.id }, include: { childRun: true } })
    expect(grants).toHaveLength(1)
    const interrupted = await prisma.agentExecutionOutbox.findMany({ where: { runId: grants[0].childRunId, type: 'child.interrupted' } })
    expect(grants[0].status, JSON.stringify({ calls: fetcher.mock.calls.length, interrupted: interrupted.map(row => row.payload) })).toBe('completed')
    expect(grants[0].childRun).toMatchObject({ status: 'completed', runtimeProtocolVersion: 1, startRequest: null })
    await prisma.$transaction(tx => assertPinnedChildCompletion(tx, exec.root.id))
    expect(fetcher).toHaveBeenCalledOnce()
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body))
    expect(body).toMatchObject({ model: selection === 'inherit' || selection === 'explicit-effort' ? '模型A' : '模型B', reasoning_effort: selection === 'inherit' ? 'low' : selection === 'explicit-effort' ? 'medium' : 'high' })
    expect(body.messages[0]).toEqual({ role: 'system', content: '完整原始作品设定 KEEP_CONTEXT' })
    expect(body.messages[1]).toEqual({ role: 'user', content: '只读审阅并提交报告' })
    const parent = await loadExecutionState(f.userId, exec.runId)
    expect(parent.configuration).toEqual(exec.initial.configuration)
    expect(parent.frame.state.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: exec.callId })
    const frozen = verifyChildGrant(grants[0])
    expect(frozen.price).toMatchObject({ modelTier: 'custom', multiplierBps: 0 })
    expect(frozen.configuration).not.toHaveProperty('pinnedSubagentId')
    const settlements = await prisma.agentExecutionOutbox.findMany({ where: { runId: grants[0].childRunId, type: 'credit.settled' } })
    expect(settlements).toHaveLength(1)
    expect(settlements[0].payload).toMatchObject({ chargedMilli: 0 })
    expect((await listQueuedRequests(f.userId, f.sessionId)).latestRunId).toBe(exec.runId)
    await expect(stopLoopRun(f.userId, grants[0].childRunId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await publishDurableEvents(f.userId, grants[0].childRunId)
    expect((await listSessionRunStatuses(f.userId, [f.sessionId])).statuses[f.sessionId]?.runId).toBe(exec.runId)
    const childMessage = await prisma.agentMessage.findFirstOrThrow({ where: { runId: grants[0].childRunId } })
    expect(JSON.stringify(await listAgentSessionHistoryData(f.userId, f.sessionId))).not.toContain(childMessage.id)
    await expect(forkAgentSessionData(f.userId, f.sessionId, { fromMessageId: childMessage.id })).rejects.toMatchObject({ code: 'AGENT_MESSAGE_NOT_FOUND' })
    const fork = await forkAgentSessionData(f.userId, f.sessionId)
    expect(await prisma.agentRun.count({ where: { sessionId: fork.session.id, incomingChildGrant: { isNot: null } } })).toBe(0)
  }), 30000)

  it('allocates separate-window original-budget shares atomically and preserves them on explicit resume', async () => fixture(async f => {
    const exec = await execution(f, taskSpawnTool, { tasks: [{ title: '窗口一', brief: '只读审阅原始作品设定并提交完整报告，保持原有正文不变。' },
      { title: '窗口二', brief: '只读核对原始作品设定并提交完整报告，保持原有正文不变。' }], mode: 'review', inherit: 'transcript' }, false, false, false, 2000000)
    const fetcher = vi.fn(async () => { throw new Error('allocation-held-unknown') })
    vi.stubGlobal('fetch', fetcher)
    await executeDurableToolStep(exec.lease, new AbortController().signal)
    const grants = await prisma.agentChildExecutionGrant.findMany({ where: { parentRootId: exec.root.id }, orderBy: { childIndex: 'asc' } })
    expect(grants.map(grant => grant.tokenCeiling)).toEqual([666666, 666667])
    expect(grants.map(grant => verifyChildGrant(grant).turnCeiling)).toEqual([env.agentMaxTurns, env.agentMaxTurns])
    await Promise.allSettled(grants.map(grant => dispatchDurableChild(f.userId, grant.childRunId)))
    const budget = await readTaskBudget(exec.lease)
    expect(budget.reservedChildTokens).toBe(1333333n)
    await pauseDurableTask(f.userId, exec.runId)
    const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: exec.root.id, type: 'run.paused' }, orderBy: { createdAt: 'desc' } })
    const resumed = await resumeDurableTask({ userId: f.userId, runId: exec.runId, pauseEventId: pause.id })
    const parent = await claimLease({ userId: f.userId, runId: resumed.run.id, ownerId: 'allocation-resume', claimId: randomUUID() })
    const after = await prisma.agentChildExecutionGrant.findMany({ where: { parentRootId: exec.root.id }, orderBy: { childIndex: 'asc' } })
    expect(after.map(grant => [grant.id, grant.childRunId, grant.tokenCeiling, grant.snapshotHash])).toEqual(grants.map(grant => [grant.id, grant.childRunId, grant.tokenCeiling, grant.snapshotHash]))
    expect((await readTaskBudget(parent)).reservedChildTokens).toBe(budget.reservedChildTokens)
  }), 30000)

  it('keeps full oversized inline context and returns a persisted no-dispatch budget failure', async () => fixture(async f => {
    const fetcher = mockProvider()
    const exec = await execution(f, subAgentRunTool, { subagentId: f.definitionId, task: '只读审阅并报告' }, false, true)
    await saveExecutionState(exec.lease, { expectedRevision: exec.initial.frame.revision, expectedHash: exec.initial.frame.snapshotHash,
      snapshot: { ...exec.initial.frame.state, messages: [{ role: 'system', content: 'KEEP_CONTEXT'.repeat(10000) }, ...exec.initial.frame.state.messages.slice(1)] } })
    const result = await executeDurableToolStep(exec.lease, new AbortController().signal)
    expect(result.kind).toBe('tool')
    expect('result' in result && result.result.output).toContain('供应商尚未派发')
    expect(fetcher).not.toHaveBeenCalled()
    const grant = await prisma.agentChildExecutionGrant.findFirstOrThrow({ where: { parentRootId: exec.root.id } })
    expect(grant.tokenCeiling).toBe(16000)
    const child = await loadExecutionState(f.userId, grant.childRunId)
    expect(child.frame.state.messages[0]).toMatchObject({ content: 'KEEP_CONTEXT'.repeat(10000) })
    expect((await prisma.agentProviderAttempt.findFirstOrThrow({ where: { runId: grant.childRunId } })).dispatchedAt).toBeNull()
    await expect(prisma.$transaction(tx => assertPinnedChildCompletion(tx, exec.root.id))).rejects.toMatchObject({ code: 'RUNTIME_PINNED_CHILD_REQUIRED' })
  }), 30000)

  it('caps a new separate window at the legacy default when the parent explicitly has a larger allowance', async () => fixture(async f => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('legacy-cap-held-unknown') }))
    const exec = await execution(f, taskSpawnTool, { tasks: [{ title: '独立窗口', brief: '只读审阅原始作品设定并提交完整报告，保持原有正文不变。' }], mode: 'review', inherit: 'transcript' }, false, false, false, 5000000)
    await executeDurableToolStep(exec.lease, new AbortController().signal)
    const grant = await prisma.agentChildExecutionGrant.findFirstOrThrow({ where: { parentRootId: exec.root.id } })
    expect(grant.tokenCeiling).toBe(Math.min(env.agentRunTokenBudget, 2500000))
    await dispatchDurableChild(f.userId, grant.childRunId).catch(() => {})
    const originalDefault = env.agentRunTokenBudget
    try {
      env.agentRunTokenBudget = originalDefault + 500
      await pauseDurableTask(f.userId, exec.runId)
      const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: exec.root.id, type: 'run.paused' }, orderBy: { createdAt: 'desc' } })
      const resumed = await resumeDurableTask({ userId: f.userId, runId: exec.runId, pauseEventId: pause.id })
      await claimLease({ userId: f.userId, runId: resumed.run.id, ownerId: 'cap-resume', claimId: randomUUID() })
      expect(await prisma.agentChildExecutionGrant.findUniqueOrThrow({ where: { id: grant.id } })).toMatchObject({ tokenCeiling: grant.tokenCeiling, snapshotHash: grant.snapshotHash })
    } finally { env.agentRunTokenBudget = originalDefault }
  }), 30000)

  it('durably admits two visible windows, joins real results, and sends rework to the same window', async () => fixture(async f => {
    const fetcher = mockProvider(true)
    const exec = await execution(f, taskSpawnTool, { tasks: [{ title: '审阅一', brief: '只读审阅原始作品设定并提交完整的审阅报告，不改动正文。' },
      { title: '审阅二', brief: '只读检查原始作品设定并提交完整的检查报告，不改动正文。', model: { modelTier: 'custom', customModelId: f.modelA, reasoningEffort: 'medium' } }], mode: 'review', inherit: 'brief' }, true)
    expect((await executeDurableToolStep(exec.lease, new AbortController().signal)).kind).toBe('tool')
    const grants = await prisma.agentChildExecutionGrant.findMany({ where: { parentRootId: exec.root.id }, orderBy: { childIndex: 'asc' }, include: { childRun: true } })
    expect(grants).toHaveLength(2)
    expect(new Set(grants.map(item => item.childRun.sessionId)).size).toBe(2)
    await Promise.all(grants.map(grant => dispatchDurableChild(f.userId, grant.childRunId)))
    expect((await awaitDurableChildren(exec.lease, new AbortController().signal)).every(item => item.status === 'completed')).toBe(true)
    const sessionIds = grants.map(item => item.childRun.sessionId)
    const state = await loadExecutionState(f.userId, exec.runId)
    await saveExecutionState(exec.lease, { expectedRevision: state.frame.revision, expectedHash: state.frame.snapshotHash,
      snapshot: { ...state.frame.state, messages: [...state.frame.state.messages, { role: 'assistant', content: null, toolCalls: [{ id: 'join', name: 'task_wait', arguments: JSON.stringify({ sessionIds, mode: 'all', timeoutSeconds: 10 }) }] }] } })
    expect((await executeDurableToolStep(exec.lease, new AbortController().signal)).kind).toBe('tool')
    const waited = await loadExecutionState(f.userId, exec.runId)
    expect(waited.frame.state.messages.at(-1)).toMatchObject({ role: 'tool', content: expect.stringContaining('已完成') })
    await saveExecutionState(exec.lease, { expectedRevision: waited.frame.revision, expectedHash: waited.frame.snapshotHash,
      snapshot: { ...waited.frame.state, messages: [...waited.frame.state.messages, { role: 'assistant', content: null, toolCalls: [{ id: 'rework', name: 'task_send', arguments: JSON.stringify({ sessionId: sessionIds[0], prompt: '继续只读复核并提交第二份报告。', mode: 'review' }) }] }] } })
    await executeDurableToolStep(exec.lease, new AbortController().signal)
    const rework = await prisma.agentChildExecutionGrant.findFirstOrThrow({ where: { parentRootId: exec.root.id, parentOperation: { action: 'task_send' } }, include: { childRun: true } })
    expect(rework.childRun.sessionId).toBe(sessionIds[0])
    expect(rework.childRunId).not.toBe(grants[0].childRunId)
    await dispatchDurableChild(f.userId, rework.childRunId)
    expect((await awaitDurableChildren(exec.lease, new AbortController().signal, { sessionIds: [sessionIds[0]] })).map(item => item.id)).toEqual([rework.id])
    expect(fetcher).toHaveBeenCalledTimes(3)
    const bodies = fetcher.mock.calls.map(call => JSON.parse(String(call[1]?.body)))
    expect(bodies.map(body => [body.model, body.reasoning_effort])).toEqual(expect.arrayContaining([['模型B', 'high'], ['模型A', 'medium']]))
    const status = await listSessionRunStatuses(f.userId, [sessionIds[0]])
    expect(status).toBeTruthy()
    const history = await listAgentSessionHistoryData(f.userId, f.sessionId)
    expect(JSON.stringify(history)).not.toContain(grants[0].childRunId)
  }), 30000)

  it('preserves the completed target full transcript and current steering when rework selects a different model and effort', async () => fixture(async f => {
    const volume = await prisma.volume.create({ data: { novelId: f.novelId, title: '测试卷', orderIndex: 1 } })
    const chapter = await prisma.chapter.create({ data: { authorId: f.userId, novelId: f.novelId, volumeId: volume.id,
      title: '私有阅读', content: 'CHILD_ONLY_TOOL_SENTINEL 原始阅读事实。', orderIndex: 1, orderInVolume: 1, wordCount: 40 } })
    let requests = 0
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => {
      requests++
      const delta = requests === 1 ? { tool_calls: [{ index: 0, id: 'private-child-read', type: 'function', function: {
        name: 'chapter_read', arguments: JSON.stringify({ chapterId: chapter.id }) } }] } : { content: '已完成只读审阅。报告：原始事实完整，未修改正文。' }
      return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: requests === 1 ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 50, completion_tokens: 10, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 50 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    })
    vi.stubGlobal('fetch', fetcher)
    const exec = await execution(f, taskSpawnTool, { tasks: [{ title: '目标窗口', brief: '只读审阅原始作品设定并提交完整报告，不改动正文。' }], mode: 'review', inherit: 'brief' })
    await executeDurableToolStep(exec.lease, new AbortController().signal)
    const original = await prisma.agentChildExecutionGrant.findFirstOrThrow({ where: { parentRootId: exec.root.id }, include: { childRun: true } })
    await dispatchDurableChild(f.userId, original.childRunId)
    const saved = await loadExecutionState(f.userId, original.childRunId)
    expect(saved.frame.state.messages.some(message => message.role === 'tool' && message.content.includes('CHILD_ONLY_TOOL_SENTINEL'))).toBe(true)
    const parent = await loadExecutionState(f.userId, exec.runId)
    expect(JSON.stringify(parent.frame.state.messages)).not.toContain('CHILD_ONLY_TOOL_SENTINEL')
    const prompt = '继续只读复核并提交第二份报告。REWORK_LAST_ONLY'
    await saveExecutionState(exec.lease, { expectedRevision: parent.frame.revision, expectedHash: parent.frame.snapshotHash,
      snapshot: { ...parent.frame.state, messages: [...parent.frame.state.messages, { role: 'user', content: 'CURRENT_PARENT_STEERING_ONLY：复核事实并保留原始证据。' },
        { role: 'assistant', content: null, toolCalls: [{ id: 'full-history-rework', name: 'task_send', arguments: JSON.stringify({ sessionId: original.childRun.sessionId,
          prompt, mode: 'review', model: { modelTier: 'custom', customModelId: f.modelB, reasoningEffort: 'medium' } }) }] }] } })
    await executeDurableToolStep(exec.lease, new AbortController().signal)
    const rework = await prisma.agentChildExecutionGrant.findFirstOrThrow({ where: { parentRootId: exec.root.id, parentOperation: { action: 'task_send' } }, include: { childRun: true } })
    const initial = await prisma.agentExecutionFrame.findUniqueOrThrow({ where: { taskRootId_revision: { taskRootId: rework.childRun.taskRootId!, revision: 0 } } })
    expect(verifyChildGrant(rework).reworkSource).toEqual({ grantId: original.id, runId: original.childRunId, taskRootId: original.childRun.taskRootId,
      frameRevision: saved.frame.revision, frameHash: saved.frame.snapshotHash })
    await dispatchDurableChild(f.userId, rework.childRunId)
    const body = JSON.parse(String(fetcher.mock.calls[2][1]?.body))
    expect([body.model, body.reasoning_effort]).toEqual(['模型B', 'medium'])
    expect(JSON.stringify(body.messages)).toContain('CHILD_ONLY_TOOL_SENTINEL')
    expect(JSON.stringify(body.messages)).toContain('CURRENT_PARENT_STEERING_ONLY')
    expect(body.messages.at(-1)).toMatchObject({ role: 'user', content: prompt })
    const tool = body.messages.find((message: { role: string; content?: string }) => message.role === 'tool' && message.content?.includes('CHILD_ONLY_TOOL_SENTINEL'))
    const call = body.messages.flatMap((message: { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }) => message.tool_calls ?? [])
      .find((item: { id: string }) => item.id === tool.tool_call_id)
    expect(call).toMatchObject({ id: expect.stringMatching(/^rework_/), function: { name: 'chapter_read', arguments: JSON.stringify({ chapterId: chapter.id }) } })
    expect(body.messages.filter((message: { role: string; tool_call_id?: string }) => message.role === 'tool' && message.tool_call_id === call.id)).toHaveLength(1)
    expect((await loadExecutionState(f.userId, original.childRunId)).frame.snapshotHash).toBe(saved.frame.snapshotHash)
    await pauseDurableTask(f.userId, exec.runId)
    const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: exec.root.id, type: 'run.paused' }, orderBy: { createdAt: 'desc' } })
    const resumed = await resumeDurableTask({ userId: f.userId, runId: exec.runId, pauseEventId: pause.id })
    await claimLease({ userId: f.userId, runId: resumed.run.id, ownerId: 'history-resume', claimId: randomUUID() })
    await dispatchDurableChild(f.userId, original.childRunId)
    await dispatchDurableChild(f.userId, rework.childRunId)
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(await prisma.agentExecutionFrame.findUniqueOrThrow({ where: { taskRootId_revision: { taskRootId: rework.childRun.taskRootId!, revision: 0 } } })).toMatchObject({ snapshotHash: initial.snapshotHash, snapshot: initial.snapshot })
  }), 30000)

  it.each(['failed', 'unknown', 'foreign'] as const)('rejects %s target rework without creating a grant or another provider request', async kind => fixture(async f => {
    const fetcher = kind === 'unknown' ? vi.fn(async () => { throw new Error('unknown-rework-target') }) : mockProvider()
    if (kind === 'unknown') vi.stubGlobal('fetch', fetcher)
    const exec = await execution(f, taskSpawnTool, { tasks: [{ title: '目标窗口', brief: '只读审阅原始作品设定并提交完整报告，不改动正文。' }], mode: 'review', inherit: 'brief' })
    await executeDurableToolStep(exec.lease, new AbortController().signal)
    const original = await prisma.agentChildExecutionGrant.findFirstOrThrow({ where: { parentRootId: exec.root.id }, include: { childRun: true } })
    await dispatchDurableChild(f.userId, original.childRunId).catch(() => {})
    if (kind === 'failed') await prisma.$transaction(async tx => {
      await tx.agentChildExecutionGrant.update({ where: { id: original.id }, data: { status: 'failed' } })
      await tx.agentRun.update({ where: { id: original.childRunId }, data: { status: 'failed' } })
      await tx.agentTaskRoot.update({ where: { id: original.childRun.taskRootId! }, data: { status: 'cancelled' } })
    })
    const targetSessionId = kind === 'foreign' ? (await prisma.agentSession.create({ data: { userId: f.userId, novelId: f.novelId, title: '其他任务窗口' } })).id : original.childRun.sessionId
    const parent = await loadExecutionState(f.userId, exec.runId)
    await saveExecutionState(exec.lease, { expectedRevision: parent.frame.revision, expectedHash: parent.frame.snapshotHash,
      snapshot: { ...parent.frame.state, messages: [...parent.frame.state.messages, { role: 'assistant', content: null, toolCalls: [{ id: 'denied-rework', name: 'task_send',
        arguments: JSON.stringify({ sessionId: targetSessionId, prompt: '继续只读复核并提交报告。', mode: 'review' }) }] }] } })
    await expect(executeDurableToolStep(exec.lease, new AbortController().signal)).rejects.toMatchObject({ code: kind === 'unknown' ? 'RUNTIME_RECONCILIATION_REQUIRED' : 'RUNTIME_CHILD_REWORK_NOT_READY' })
    expect(await prisma.agentChildExecutionGrant.count({ where: { parentRootId: exec.root.id } })).toBe(1)
    expect(fetcher).toHaveBeenCalledOnce()
  }), 30000)

  it('creates a delegate through one actual native call', async () => fixture(async f => {
    mockProvider()
    const exec = await execution(f, subAgentDelegateTool, { name: '新研究员', role: 'research', triggerCondition: '审阅', prompt: '只读审阅并报告', task: '只读审阅并提交完整报告' })
    await executeDurableToolStep(exec.lease, new AbortController().signal)
    expect(await prisma.agentSubtask.count({ where: { userId: f.userId, name: '新研究员' } })).toBe(1)
    const grant = await prisma.agentChildExecutionGrant.findFirstOrThrow({ where: { parentRootId: exec.root.id } })
    expect(grant.status).toBe('completed')
  }), 30000)

  it('holds unknown provider evidence and prevents parent success without another HTTP request', async () => fixture(async f => {
    const fetcher = vi.fn(async () => { throw new Error('isolated-unknown-provider') })
    vi.stubGlobal('fetch', fetcher)
    const exec = await execution(f, taskSpawnTool, { tasks: [{ title: '未知结果', brief: '只读审阅原始作品设定并提交完整报告，保持原有正文不变。' }], mode: 'review', inherit: 'brief' })
    await executeDurableToolStep(exec.lease, new AbortController().signal)
    const grant = await prisma.agentChildExecutionGrant.findFirstOrThrow({ where: { parentRootId: exec.root.id } })
    await dispatchDurableChild(f.userId, grant.childRunId).catch(() => {})
    expect(fetcher).toHaveBeenCalledOnce()
    expect((await prisma.agentChildExecutionGrant.findUniqueOrThrow({ where: { id: grant.id } })).status).toBe('reconciliation')
    const parent = await loadExecutionState(f.userId, exec.runId)
    await saveExecutionState(exec.lease, { expectedRevision: parent.frame.revision, expectedHash: parent.frame.snapshotHash,
      snapshot: { ...parent.frame.state, messages: [...parent.frame.state.messages, { role: 'assistant', content: '父任务已完成。' }] } })
    const outcome = await runReviewedDurableExecution(exec.lease, new AbortController().signal)
    expect(outcome.kind).toBe('needs_attention')
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: exec.runId } })).status).toBe('paused')
    expect(await prisma.agentExecutionOutbox.count({ where: { taskRootId: exec.root.id, type: 'child.awaiting' } })).toBeGreaterThan(0)
  }), 30000)

  it('attributes child usage to the parent goal once and retains the main currentRunId', async () => fixture(async f => {
    const fetcher = mockProvider()
    const exec = await execution(f, subAgentRunTool, { subagentId: f.definitionId, task: '只读审阅并提交完整报告' }, false, false, true)
    await executeDurableToolStep(exec.lease, new AbortController().signal)
    const grant = await prisma.agentChildExecutionGrant.findFirstOrThrow({ where: { parentRootId: exec.root.id } })
    expect(await prisma.agentGoalExecution.findUniqueOrThrow({ where: { runId: grant.childRunId } })).toMatchObject({ goalId: exec.goalId, goalRevision: 1, epoch: 1n,
      trigger: 'subagent', sourceEventId: `child-grant:${grant.id}`, taskRootId: verifyChildGrant(grant).taskSpec.id })
    expect((await prisma.agentGoal.findUniqueOrThrow({ where: { id: exec.goalId! } })).currentRunId).toBe(exec.runId)
    expect(await prisma.agentGoalBudget.findUniqueOrThrow({ where: { goalId: exec.goalId! } })).toMatchObject({ tokensUsed: 60n, tokensReserved: 0n })
    expect(await prisma.agentGoalUsage.count({ where: { goalId: exec.goalId! } })).toBe(1)
    const raw = await prisma.agentProviderAttempt.findFirstOrThrow({ where: { runId: grant.childRunId }, include: { usageReceipt: true } })
    const budget = await prisma.agentGoalBudget.findUniqueOrThrow({ where: { goalId: exec.goalId! } })
    const ledger = await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })
    await expect(prisma.$transaction(tx => withGoalTransaction(tx, () => withoutGoalEffects(() => observeGoalUsage(`durable:${raw.id}`,
      { inputTokens: 50, outputTokens: 10, creditsMilli: 0, status: 'known' }))))).rejects.toMatchObject({ code: 'GOAL_USAGE_TRANSACTION_REQUIRED' })
    expect(await prisma.agentProviderAttempt.findUniqueOrThrow({ where: { id: raw.id }, include: { usageReceipt: true } })).toEqual(raw)
    await syncGoalDurableUsage(raw.id)
    await syncGoalDurableUsage(raw.id)
    expect(await prisma.agentGoalBudget.findUniqueOrThrow({ where: { goalId: exec.goalId! } })).toEqual(budget)
    expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(ledger)
    expect(fetcher).toHaveBeenCalledOnce()
  }), 30000)

  it('deregisters a completed child even when its lease release fails', async () => fixture(async f => {
    const fetcher = mockProvider()
    const exec = await execution(f, taskSpawnTool, { tasks: [{ title: '清理测试', brief: '只读审阅原始作品设定并提交完整报告，保持原有正文不变。' }], mode: 'review', inherit: 'brief' })
    let reached!: () => void, release!: () => void
    const cleanupReached = new Promise<void>(resolve => { reached = resolve })
    const cleanupContinue = new Promise<void>(resolve => { release = resolve })
    const original = childLease.releaseRunLease
    const cleanup = vi.spyOn(childLease, 'releaseRunLease').mockImplementation(async token => {
      if (token.parent) { reached(); await cleanupContinue; throw new Error('isolated-release-failure') }
      return original(token)
    })
    await executeDurableToolStep(exec.lease, new AbortController().signal)
    const grant = await prisma.agentChildExecutionGrant.findFirstOrThrow({ where: { parentRootId: exec.root.id } })
    const done = dispatchDurableChild(f.userId, grant.childRunId).catch(error => error)
    try {
      await cleanupReached
      expect(getActiveRun(grant.childRunId)).toBeDefined()
    } finally { release() }
    expect((await done).message).toBe('isolated-release-failure')
    cleanup.mockRestore()
    expect(getActiveRun(grant.childRunId)).toBeUndefined()
    expect((await prisma.agentChildExecutionGrant.findUniqueOrThrow({ where: { id: grant.id } })).status).toBe('completed')
    expect(fetcher).toHaveBeenCalledOnce()
  }), 30000)

  it('keeps unknown goal reserves and atomically cancels canonical children', async () => fixture(async f => {
    const fetcher = vi.fn(async () => { throw new Error('goal-child-unknown') })
    vi.stubGlobal('fetch', fetcher)
    const exec = await execution(f, taskSpawnTool, { tasks: [{ title: '未知结果', brief: '只读审阅原始作品设定并提交完整报告，保持原有正文不变。' }], mode: 'review', inherit: 'brief' }, false, false, true)
    await executeDurableToolStep(exec.lease, new AbortController().signal)
    const grant = await prisma.agentChildExecutionGrant.findFirstOrThrow({ where: { parentRootId: exec.root.id } })
    await dispatchDurableChild(f.userId, grant.childRunId).catch(() => {})
    const budget = await prisma.agentGoalBudget.findUniqueOrThrow({ where: { goalId: exec.goalId! } })
    expect(budget.tokensReserved).toBeGreaterThan(0n)
    expect(budget.tokensUsed).toBe(0n)
    expect(await prisma.agentGoalUsage.findFirstOrThrow({ where: { goalId: exec.goalId! } })).toMatchObject({ status: 'unknown' })
    const goal = await prisma.agentGoal.findUniqueOrThrow({ where: { id: exec.goalId! } })
    await actOnAgentGoal(f.userId, f.sessionId, goal.id, { requestId: randomUUID(), action: 'cancel', expectedStateVersion: goal.stateVersion })
    expect((await prisma.agentChildExecutionGrant.findUniqueOrThrow({ where: { id: grant.id } })).status).toBe('cancelled')
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: grant.childRunId } })).status).toBe('cancelled')
    expect((await prisma.agentGoalBudget.findUniqueOrThrow({ where: { goalId: goal.id } })).tokensReserved).toBe(budget.tokensReserved)
    await expect(claimLease({ userId: f.userId, runId: grant.childRunId, ownerId: 'late-child', claimId: randomUUID() })).rejects.toMatchObject({ code: 'GOAL_EXECUTION_FENCED' })
    expect(fetcher).toHaveBeenCalledOnce()
  }), 30000)

  it('adopts goal revision/epoch only under a newly fenced parent lease', async () => fixture(async f => {
    const exec = await execution(f, taskSpawnTool, { tasks: [{ title: '等待派发', brief: '只读审阅原始作品设定并提交完整报告，保持原有正文不变。' }], mode: 'review', inherit: 'brief' }, false, false, true)
    // Freeze work before admission so the native acknowledgement cannot send HTTP.
    const fetcher = vi.fn(async () => { throw new Error('held-evidence') })
    vi.stubGlobal('fetch', fetcher)
    await executeDurableToolStep(exec.lease, new AbortController().signal)
    const grant = await prisma.agentChildExecutionGrant.findFirstOrThrow({ where: { parentRootId: exec.root.id } })
    await dispatchDurableChild(f.userId, grant.childRunId).catch(() => {})
    await releaseRunLease(exec.lease)
    await prisma.agentGoal.update({ where: { id: exec.goalId! }, data: { epoch: 2n } })
    await expect(claimLease({ userId: f.userId, runId: exec.runId, ownerId: 'old-goal-parent', claimId: randomUUID() })).rejects.toMatchObject({ code: 'GOAL_EXECUTION_FENCED' })
    await prisma.agentGoalExecution.update({ where: { runId: exec.runId }, data: { epoch: 2n } })
    const parent = await claimLease({ userId: f.userId, runId: exec.runId, ownerId: 'current-goal-parent', claimId: randomUUID() })
    expect(await prisma.agentGoalExecution.findUniqueOrThrow({ where: { runId: grant.childRunId } })).toMatchObject({ epoch: 2n })
    await withRunLease(parent, async () => undefined)
    expect(fetcher).toHaveBeenCalledOnce()
  }), 30000)
})
