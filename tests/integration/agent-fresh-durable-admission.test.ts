import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Response as ExpressResponse } from 'express'
vi.mock('../../api/lib/agent/loop.js', () => ({ executeAgentRun: vi.fn(async () => {}) }))
vi.mock('../../api/lib/agent/runtime-bootstrap.js', async importOriginal => ({ ...await importOriginal<typeof import('../../api/lib/agent/runtime-bootstrap.js')>(), dispatchFreshDurableRun: vi.fn(async () => {}) }))
import { prisma, DataAccessError } from '../../api/lib/prisma.js'
import * as credits from '../../api/lib/credits.js'
import * as context from '../../api/lib/agent/context.js'
import * as flags from '../../api/lib/agent2-feature-flags.js'
import * as executor from '../../api/lib/agent/runtime-executor.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'
import * as storyMemory from '../../api/lib/agent/story-memory.js'
import { executeAgentRun } from '../../api/lib/agent/loop.js'
import { startLoopRun, initializePersistedLoopRun, continueLoopRun, stopLoopRun, recoverDurableLoopRuns } from '../../api/lib/agent/run-service.js'
import * as runService from '../../api/lib/agent/run-service.js'
import { dispatchFreshDurableRun, pauseFreshBootstrap, readFreshBootstrapAdmission } from '../../api/lib/agent/runtime-bootstrap.js'
import { loadExecutionState } from '../../api/lib/agent/runtime-state.js'
import * as executionState from '../../api/lib/agent/runtime-state.js'
import { loadDurableEvents, isDurablePauseResumed, publishDurableEvents } from '../../api/lib/agent/runtime-event-projection.js'
import { taskSpecSchema } from '../../shared/contracts/task-spec-contracts.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { available, fixture } from '../support/agent-durable-runtime-fixture.js'
import { streamDurableRun } from '../../api/lib/agent/runtime-stream.js'
import { env } from '../../api/config/env.js'
import { createAgentGoal, actOnAgentGoal, readAgentGoal } from '../../api/lib/agent/goal-service.js'
import { superviseAgentGoal } from '../../api/lib/agent/goal-supervisor.js'
import { createDurableTestLifecycle, DURABLE_FULL_CHAIN_TEST_TIMEOUT_MS, type DurableTestLifecycle } from '../support/durable-test-lifecycle.js'
import { startDurableTestCpuProfile } from '../support/durable-test-cpu.js'

const realBootstrap = await vi.importActual<typeof import('../../api/lib/agent/runtime-bootstrap.js')>('../../api/lib/agent/runtime-bootstrap.js')
const originalRollout = env.agentDurableRolloutUserIds
const originalGoalEnabled = env.agentGoalEnabled
class StreamResponse extends EventEmitter {
  writableEnded = false
  destroyed = false
  chunks: string[] = []
  writeHead = vi.fn()
  write(chunk: string) { this.chunks.push(chunk); return true }
  end() { this.writableEnded = true }
  destroy() { this.destroyed = true }
}
afterEach(() => {
  env.agentDurableRolloutUserIds = originalRollout; env.agentGoalEnabled = originalGoalEnabled
  vi.mocked(dispatchFreshDurableRun).mockReset().mockResolvedValue(undefined)
  vi.clearAllMocks(); vi.restoreAllMocks()
})

async function ready(f: { userId: string; runId: string; rootId: string }) {
  env.agentDurableRolloutUserIds = [f.userId]
  await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'completed' } })
  await prisma.agentTaskRoot.update({ where: { id: f.rootId }, data: { status: 'completed' } })
  vi.spyOn(credits, 'assertCreditAccess').mockResolvedValue(undefined)
  vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue({ tier: 'speed', multiplierBps: 10000, provider: 'fixture', modelName: 'fixture',
    baseUrl: 'https://provider.invalid/v1', apiKey: 'synthetic-only', reasoningEffort: 'high', reasoningEfforts: ['none', 'high'],
    reasoningParameterMode: 'native', thinkingEnabled: false, visionEnabled: false, contextWindowTokens: null })
  const features = flags.resolveAgent2FeatureFlags(f.userId)
  vi.spyOn(flags, 'resolveAgent2FeatureFlags').mockReturnValue({ ...features, storyCompiler: true, humanityQuality: true })
  vi.spyOn(context, 'assembleContext').mockImplementation(async input => ({ messages: [{ role: 'system', content: '合成原始任务边界' }, { role: 'user', content: input.prompt }],
    skillRoute: null, availableSkillVersions: [], timings: {} }))
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('No supplier is allowed in this bootstrap matrix') }))
}

const unknownUsage = (userId: string, novelId: string, runId: string) => prisma.aiUsageLog.create({ data: {
  userId, novelId, agentRunId: runId, targetType: 'agentRun', targetId: runId, providerType: 'text', providerMode: 'platform',
  modelName: 'fixture', action: 'agent', modelTier: 'speed', billingStatus: 'pending_usage', usageSource: 'unknown', durationMs: 1,
} })

/** CI exposes failure annotations without requiring restricted raw logs.
 * Observe the actual adapter calls; do not substitute an execution outcome. */
function observeBootstrapFailures(lifecycle?: DurableTestLifecycle) {
  const failures: Array<{ stage: string; message: string; code?: string }> = []
  const record = (stage: string, error: unknown) => failures.push({ stage, message: error instanceof Error ? error.message : String(error),
    ...(error instanceof DataAccessError ? { code: error.code } : {}) })
  const initialize = runService.initializePersistedLoopRun, execute = runService.executePersistedLoopRun
  vi.spyOn(runService, 'initializePersistedLoopRun').mockImplementation(async (...args) => {
    try { return await (lifecycle ? lifecycle.phase('runtime.seed', () => initialize(...args)) : initialize(...args)) } catch (error) { record('initialize', error); throw error }
  })
  vi.spyOn(runService, 'executePersistedLoopRun').mockImplementation(async (...args) => {
    try { return await (lifecycle ? lifecycle.phase('step', () => execute(...args)) : execute(...args)) } catch (error) { record('execute', error); throw error }
  })
  return failures
}

async function bootstrapDiagnostic(runId: string, failures: ReturnType<typeof observeBootstrapFailures>) {
  const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId }, select: { status: true, errorMessage: true, taskRootId: true } })
  const frame = run.taskRootId ? await prisma.agentExecutionFrame.findFirst({ where: { taskRootId: run.taskRootId }, orderBy: { revision: 'desc' }, select: { snapshot: true } }) : null
  const snapshot = frame?.snapshot && typeof frame.snapshot === 'object' && !Array.isArray(frame.snapshot) ? frame.snapshot : null
  const operations = run.taskRootId ? await prisma.agentOperation.findMany({ where: { taskRootId: run.taskRootId },
    select: { kind: true, action: true, status: true, effectReceipt: { select: { result: true } } }, orderBy: { createdAt: 'asc' } }) : []
  const bootstrapPause = await prisma.agentExecutionOutbox.findFirst({ where: { runId, type: 'execution.bootstrap.paused' },
    orderBy: { sequence: 'desc' }, select: { payload: true } })
  return JSON.stringify({ ...run, failures, bootstrapPause: bootstrapPause?.payload, phase: snapshot?.phase, pendingOperationId: snapshot?.pendingOperationId,
    operations: operations.map(item => ({ kind: item.kind, action: item.action, status: item.status,
      result: (JSON.stringify(item.effectReceipt?.result) ?? '').slice(0, 600) })) })
}

describe.runIf(available)('fresh native admission and unstarted bootstrap', () => {
  it('does not opt a fresh durable HTTP task into legacy terminal response schemas', () => fixture(async f => {
    const runtime = { tier: 'speed' as const, multiplierBps: 0, provider: 'fixture', modelName: 'fixture-main',
      baseUrl: 'https://provider.invalid/v1', apiKey: null, reasoningEffort: 'high' as const, reasoningEfforts: ['high' as const],
      visionEnabled: false, contextWindowTokens: 128000 }
    vi.spyOn(credits, 'assertCreditAccess').mockResolvedValue(undefined)
    vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue(runtime)
    env.agentDurableRolloutUserIds = [f.userId]
    const session = await prisma.agentSession.create({ data: { userId: f.userId, novelId: f.novelId, title: '新持久问答' } })
    const result = await startLoopRun(f.userId, { novelId: f.novelId, sessionId: session.id, chapterId: f.chapterId,
      prompt: '你好', mode: 'build' }, { humanOrigin: 'http' })
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: result.runId } })
    expect(run.runtimeProtocolVersion).toBe(1)
    const spec = taskSpecSchema.parse(run.taskSpec)
    expect(spec.responseDeliveryProtocol).toBeUndefined()
    const { getToolsForMode } = await import('../../api/lib/agent/tools/registry.js')
    const { restrictToolsToTask } = await import('../../api/lib/agent/tool-authority.js')
    expect(restrictToolsToTask(getToolsForMode('build'), spec).some(tool => tool.name === 'task_respond')).toBe(false)
  }))

  it('retains original HTTP bootstrap event identity after later goal activation binding', () => fixture(async f => {
    await ready(f)
    env.agentGoalEnabled = true
    const admitted = await startLoopRun(f.userId, { sessionId: f.sessionId, novelId: f.novelId, prompt: '你好', mode: 'build' }, { humanOrigin: 'http' })
    await pauseFreshBootstrap(f.userId, admitted.runId, 'SYNTHETIC_FAILURE')
    await continueLoopRun(f.userId, admitted.runId)
    await initializePersistedLoopRun(f.userId, admitted.runId)
    const history = await loadDurableEvents(f.userId, admitted.runId, 0)
    const originalPause = history.find(event => event.type === 'run.paused')!
    await stopLoopRun(f.userId, admitted.runId)
    const goal = await createAgentGoal(f.userId, { sessionId: f.sessionId }, { requestId: randomUUID(), objective: '保留原任务', options: { mode: 'build' } })
    try {
      const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: admitted.runId } })
      // Replay the existing activation binding shape, not a new native issuer.
      await prisma.agentGoalExecution.create({ data: { goalId: goal.id, goalRevision: 1, epoch: 1n, continuationIndex: 1,
        runId: run.id, taskRootId: run.taskRootId, trigger: 'author', sourceEventId: `activation:${goal.id}:${run.id}` } })
      expect((await prisma.$transaction(tx => readFreshBootstrapAdmission(tx, f.userId, run.id))).goalSource).toBeNull()
      expect(await isDurablePauseResumed(f.userId, run.id, originalPause.seq)).toBe(true)
      await publishDurableEvents(f.userId, run.id)
      expect((await loadDurableEvents(f.userId, run.id, 0)).at(-1)?.type).toBe('run.paused')
      expect(fetch).not.toHaveBeenCalled()
    } finally { await prisma.agentGoal.delete({ where: { id: goal.id } }) }
  }))

  it.each(['http', 'legacy-http', 'unmarked-http', 'internal', 'rollout-disabled', 'tampered-command', 'altered-start'] as const)('first goal %s uses its original creation authority, never a user-role inference', scenario => fixture(async f => {
    await ready(f)
    env.agentGoalEnabled = true
    if (scenario === 'rollout-disabled') env.agentDurableRolloutUserIds = []
    const objective = '完整重写第一章正文。'
    const requestId = randomUUID()
    const goal = await createAgentGoal(f.userId, { sessionId: f.sessionId }, { requestId, objective,
      options: { mode: 'build', chapterId: f.chapterId, qualityMode: 'balanced', creativeFreedom: 'balanced' } },
    scenario === 'internal' ? undefined : { authenticatedHttp: true })
    try {
      if (scenario === 'legacy-http' || scenario === 'unmarked-http') {
        const revision = await prisma.agentGoalRevision.findUniqueOrThrow({ where: { goalId_revision: { goalId: goal.id, revision: 1 } } })
        const request = revision.request as { nativeAdmission: { envelope: object }; [key: string]: unknown }
        const { nativeAdmission, ...options } = request
        const historical = runtimeJson({ ...options, ...(scenario === 'legacy-http'
          ? { nativeAdmission: { version: 1, origin: 'http', envelope: nativeAdmission.envelope } } : {}) }).value
        await prisma.agentGoalRevision.update({ where: { goalId_revision: { goalId: goal.id, revision: 1 } }, data: { request: historical,
          authorityHash: runtimeJson({ objective: revision.objective, request: historical, novelId: f.novelId, userId: f.userId }).hash } })
      }
      if (scenario === 'tampered-command') await prisma.agentGoalCommand.update({ where: { userId_requestId: { userId: f.userId, requestId } }, data: { requestHash: '0'.repeat(64) } })
      await superviseAgentGoal(f.userId, f.sessionId, goal.id)
      if (scenario === 'tampered-command') {
        expect(await prisma.agentGoalExecution.count({ where: { goalId: goal.id } })).toBe(0)
        expect((await readAgentGoal(f.userId, f.sessionId))?.status).toBe('blocked')
        expect(dispatchFreshDurableRun).not.toHaveBeenCalled()
        return
      }
      const binding = await prisma.agentGoalExecution.findFirstOrThrow({ where: { goalId: goal.id } })
      const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: binding.runId } })
      if (scenario === 'internal' || scenario === 'rollout-disabled' || scenario === 'unmarked-http') {
        expect(run.runtimeProtocolVersion).toBe(0)
        expect(taskSpecSchema.parse(run.taskSpec).scope.continuityReportProtocol).toBeUndefined()
        expect(dispatchFreshDurableRun).not.toHaveBeenCalled()
        return
      }
      expect(run).toMatchObject({ runtimeProtocolVersion: 1, status: 'queued', taskRootId: binding.taskRootId })
      const scope = taskSpecSchema.parse(run.taskSpec).scope
      expect(scope.writingCoordinationProtocol).toBe(scenario === 'legacy-http' ? 1 : 2)
      if (scenario === 'legacy-http') expect(scope.continuityReportProtocol).toBeUndefined()
      else expect(scope.continuityReportProtocol).toBe(5)
      expect(binding).toMatchObject({ trigger: 'author', continuationIndex: 1, sourceEventId: `${goal.id}:1:1` })
      if (scenario === 'altered-start') {
        await prisma.agentRun.update({ where: { id: run.id }, data: { startRequest: { ...run.startRequest as object, qualityMode: 'premium' } } })
        await expect(prisma.$transaction(tx => readFreshBootstrapAdmission(tx, f.userId, run.id))).rejects.toMatchObject({ code: 'RUNTIME_BOOTSTRAP_SOURCE_REQUIRED' })
        expect(context.assembleContext).not.toHaveBeenCalled()
      } else {
        const initialized = await initializePersistedLoopRun(f.userId, run.id)
        expect(initialized.frame.state.messages.some(message => message.content === objective)).toBe(true)
        expect((await prisma.agentGoalExecution.findUniqueOrThrow({ where: { runId: run.id } })).taskRootId).toBe(run.taskRootId)
      }
      expect(executeAgentRun).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
    } finally { await prisma.agentGoal.delete({ where: { id: goal.id } }) }
  }))

  it.each(['bootstrap-error', 'goal-pause'] as const)('first goal %s resumes the same unstarted root via the real goal control', scenario => fixture(async f => {
    await ready(f)
    env.agentGoalEnabled = true
    const goal = await createAgentGoal(f.userId, { sessionId: f.sessionId }, { requestId: randomUUID(), objective: '写第2至6章正文。',
      options: { mode: 'build' }, limits: { activeTimeLimitMs: 60_000 } }, { authenticatedHttp: true })
    try {
      await superviseAgentGoal(f.userId, f.sessionId, goal.id)
      const original = await prisma.agentRun.findFirstOrThrow({ where: { goalExecution: { goalId: goal.id } } })
      expect(original.runtimeProtocolVersion).toBe(1)
      const budget = await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: original.taskRootId! } })
      if (scenario === 'bootstrap-error') {
        vi.mocked(context.assembleContext).mockRejectedValueOnce(new Error('synthetic initialization failure'))
        await realBootstrap.dispatchFreshDurableRun(f.userId, original.id)
      } else {
        const active = (await readAgentGoal(f.userId, f.sessionId))!
        await actOnAgentGoal(f.userId, f.sessionId, goal.id, { requestId: randomUUID(), expectedStateVersion: active.stateVersion, action: 'pause' })
      }
      const paused = (await readAgentGoal(f.userId, f.sessionId))!
      expect(paused.status).toBe(scenario === 'goal-pause' ? 'paused' : 'blocked')
      expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: original.id } })).status).toBe('paused')
      await expect(continueLoopRun(f.userId, original.id)).rejects.toMatchObject({ code: 'GOAL_RESUME_REQUIRED' })
      env.agentDurableRolloutUserIds = []
      const resumed = await actOnAgentGoal(f.userId, f.sessionId, goal.id, { requestId: randomUUID(), expectedStateVersion: paused.stateVersion, action: 'resume' })
      expect(resumed).toMatchObject({ phase: 'executing', activeSince: expect.any(String) })
      expect(resumed.activeTimeMs).toBe(paused.activeTimeMs)
      await superviseAgentGoal(f.userId, f.sessionId, goal.id)
      expect(await prisma.agentGoalExecution.count({ where: { goalId: goal.id } })).toBe(1)
      expect(await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: original.taskRootId! } })).toEqual(budget)
      expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: original.id } })).status).toBe('queued')
      const current = await prisma.agentGoal.findUniqueOrThrow({ where: { id: goal.id } })
      expect((await prisma.agentGoalExecution.findUniqueOrThrow({ where: { runId: original.id } })).epoch).toBe(current.epoch)
      await initializePersistedLoopRun(f.userId, original.id)
      expect(await prisma.agentExecutionState.count({ where: { taskRootId: original.taskRootId! } })).toBe(1)
      expect(await prisma.aiUsageLog.count({ where: { userId: f.userId } })).toBe(0)
      await prisma.agentGoal.update({ where: { id: goal.id }, data: { activeSince: new Date(Date.now() - 60_001) } })
      await superviseAgentGoal(f.userId, f.sessionId, goal.id)
      expect((await readAgentGoal(f.userId, f.sessionId))?.status).toBe('budget_limited')
      expect((await prisma.agentRunLease.findUniqueOrThrow({ where: { runId: original.id } })).enabled).toBe(false)
      expect(fetch).not.toHaveBeenCalled()
    } finally { await prisma.agentGoal.delete({ where: { id: goal.id } }) }
  }))

  it.each(['bounded-write', 'conversation', 'research', 'internal', 'rollout-disabled'] as const)('%s freezes identity before dispatch, without upgrading old runs', scenario => fixture(async f => {
    await ready(f)
    if (scenario === 'rollout-disabled') env.agentDurableRolloutUserIds = []
    const prompt = scenario === 'bounded-write' ? '续写下一章正文。' : scenario === 'research' ? '联网搜索《合成作品》，研究叙事技巧。' : '你好'
    const admitted = await startLoopRun(f.userId, { sessionId: f.sessionId, novelId: f.novelId, chapterId: f.chapterId, prompt, mode: 'build' },
      scenario === 'internal' ? {} : { humanOrigin: 'http' })
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: admitted.runId } })
    const spec = taskSpecSchema.parse(run.taskSpec)
    if (scenario === 'internal' || scenario === 'rollout-disabled') {
      expect(run.runtimeProtocolVersion).toBe(0)
      expect(run.taskRootId).toBeNull()
      expect(spec.scope.capabilityCatalog).toBeUndefined()
      expect(executeAgentRun).toHaveBeenCalledWith(expect.objectContaining({ runId: run.id }))
      return
    }
    expect(run).toMatchObject({ runtimeProtocolVersion: 1, status: 'queued', taskRootId: spec.id })
    expect(dispatchFreshDurableRun).toHaveBeenCalledWith(f.userId, run.id)
    expect(executeAgentRun).not.toHaveBeenCalled()
    expect((await prisma.agentRunLease.findUniqueOrThrow({ where: { runId: run.id } })).enabled).toBe(true)
    expect(await prisma.agentExecutionState.count({ where: { taskRootId: spec.id } })).toBe(0)
    const source = await prisma.$transaction(tx => readFreshBootstrapAdmission(tx, f.userId, run.id))
    expect(source.root.requestSnapshot).toEqual([{ type: 'text', text: prompt }])
    if (scenario === 'bounded-write') expect(spec.scope).toMatchObject({ writingCoordinationProtocol: 2, continuityReportProtocol: 5 })
    else expect(spec.scope.writingCoordinationProtocol).toBeUndefined()
    const initial = await initializePersistedLoopRun(f.userId, run.id)
    expect(initial.originalSpec).toEqual(source.root.specSnapshot)
    expect(initial.frame.state.messages.at(-1)?.content).toBe(prompt)
    expect(initial.configuration.tools.map(tool => tool.function.name)).toEqual(initial.configuration.toolAuthority.map(tool => tool.name))
    const before = { configuration: initial.head.configurationHash, frame: initial.frame.snapshotHash, budget: await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: spec.id } }) }
    vi.mocked(context.assembleContext).mockRejectedValueOnce(new Error('A saved frame must not assemble again'))
    expect((await initializePersistedLoopRun(f.userId, run.id)).head.configurationHash).toBe(before.configuration)
    expect((await loadExecutionState(f.userId, run.id)).frame.snapshotHash).toBe(before.frame)
    expect(await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: spec.id } })).toEqual(before.budget)
    expect(await pauseFreshBootstrap(f.userId, run.id, 'SYNTHETIC_FAILURE')).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  }))

  it.each(['bootstrap-error', 'user-stop', 'tampered-resume'] as const)('%s preserves the original request/budget and resumes without replaying an old terminal event', scenario => fixture(async f => {
    await ready(f)
    const admitted = await startLoopRun(f.userId, { sessionId: f.sessionId, novelId: f.novelId, prompt: '你好', mode: 'build' }, { humanOrigin: 'http' })
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: admitted.runId } })
    const root = await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: run.taskRootId! } })
    const budget = await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: root.id } })
    if (scenario === 'user-stop') await stopLoopRun(f.userId, run.id)
    else {
      vi.mocked(context.assembleContext).mockRejectedValueOnce(new DataAccessError(409, 'SYNTHETIC_CONTEXT_UNAVAILABLE', 'synthetic'))
      await realBootstrap.dispatchFreshDurableRun(f.userId, run.id)
    }
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('paused')
    env.agentDurableRolloutUserIds = [] // stopping rollout never rewrites an admitted task
    const continued = await continueLoopRun(f.userId, run.id)
    expect(continued.runId).toBe(run.id)
    expect(continued.eventStartSeq).toBeGreaterThan(0)
    expect(await loadDurableEvents(f.userId, run.id, continued.eventStartSeq!)).toEqual([])
    const history = await loadDurableEvents(f.userId, run.id, 0)
    const paused = history.find(event => event.type === 'run.paused')!
    expect(history.at(-1)).toMatchObject({ type: 'run.started', authorContinue: { afterSeq: paused.seq } })
    expect(await isDurablePauseResumed(f.userId, run.id, paused.seq)).toBe(true)
    expect(await prisma.agentTaskRoot.findUniqueOrThrow({ where: { id: root.id } })).toEqual({ ...root, status: 'active' })
    expect(await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: root.id } })).toEqual(budget)
    expect(await prisma.agentOperation.count({ where: { taskRootId: root.id } })).toBe(0)
    expect(await prisma.aiUsageLog.count({ where: { agentRunId: run.id } })).toBe(0)
    expect(await prisma.agentExecutionFrame.count({ where: { taskRootId: root.id } })).toBe(0)
    expect(await prisma.agentMessage.count({ where: { runId: run.id, role: 'user' } })).toBe(1)
    expect(fetch).not.toHaveBeenCalled()
    if (scenario === 'tampered-resume') {
      const source = await prisma.agentExecutionOutbox.findUniqueOrThrow({ where: { eventKey: `bootstrap-resume:${(await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { runId: run.id, type: 'execution.bootstrap.paused' } })).id}` } })
      await prisma.agentExecutionOutbox.update({ where: { id: source.id }, data: { payload: { ...(source.payload as object), inputHash: '0'.repeat(64) } } })
      await expect(isDurablePauseResumed(f.userId, run.id, paused.seq)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
    } else {
      await stopLoopRun(f.userId, run.id)
      await publishDurableEvents(f.userId, run.id)
      const stopped = (await loadDurableEvents(f.userId, run.id, continued.eventStartSeq!)).at(-1)!
      expect(stopped.type).toBe('run.paused')
      expect(await isDurablePauseResumed(f.userId, run.id, stopped.seq)).toBe(false)
    }
  }))

  it.each(['foreign', 'tampered-request', 'operation', 'unknown-usage', 'missing-legacy-source'] as const)('%s cannot acquire a fresh bootstrap recovery', scenario => fixture(async f => {
    await ready(f)
    if (scenario === 'missing-legacy-source') {
      await expect(pauseFreshBootstrap(f.userId, f.runId, 'FAILURE')).rejects.toMatchObject({ code: 'RUNTIME_BOOTSTRAP_SOURCE_REQUIRED' })
      return
    }
    const admitted = await startLoopRun(f.userId, { sessionId: f.sessionId, novelId: f.novelId, prompt: '你好', mode: 'build' }, { humanOrigin: 'http' })
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: admitted.runId } })
    if (scenario === 'foreign') {
      await expect(prisma.$transaction(tx => readFreshBootstrapAdmission(tx, 'foreign-owner', run.id))).rejects.toThrow()
      return
    }
    if (scenario === 'tampered-request') await prisma.agentRun.update({ where: { id: run.id }, data: { startRequest: { prompt: '修改其他章节' } } })
    if (scenario === 'operation') await prisma.agentOperation.create({ data: { id: randomUUID(), taskRootId: run.taskRootId!, originRunId: run.id,
      operationKey: 'never-replay', kind: 'provider', action: 'chat', inputSnapshot: {}, inputHash: runtimeJson({}).hash } })
    if (scenario === 'unknown-usage') await unknownUsage(f.userId, f.novelId, run.id)
    await expect(pauseFreshBootstrap(f.userId, run.id, 'FAILURE')).rejects.toMatchObject({ code: scenario === 'tampered-request' ? 'RUNTIME_BOOTSTRAP_SOURCE_REQUIRED' : 'RUNTIME_STATE_REQUIRED' })
    const assembleCalls = vi.mocked(context.assembleContext).mock.calls.length
    await realBootstrap.dispatchFreshDurableRun(f.userId, run.id)
    expect(context.assembleContext).toHaveBeenCalledTimes(assembleCalls)
    expect(await prisma.agentExecutionState.count({ where: { taskRootId: run.taskRootId! } })).toBe(0)
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('queued')
    expect(fetch).not.toHaveBeenCalled()
  }))

  it('discovers a queued no-frame admission and dispatches the original native task only once', () => fixture(async f => {
    await ready(f)
    const failures = observeBootstrapFailures()
    const admitted = await startLoopRun(f.userId, { sessionId: f.sessionId, novelId: f.novelId, prompt: '你好', mode: 'build' }, { humanOrigin: 'http' })
    // Admission dispatch is intentionally async. Let its no-op fixture finish
    // before the recovery scan becomes the sole real dispatcher for this case.
    await vi.waitFor(() => expect(dispatchFreshDurableRun).toHaveBeenCalledWith(f.userId, admitted.runId))
    const execute = vi.spyOn(executor, 'runReviewedDurableExecution').mockImplementation(async lease => ({ kind: 'needs_attention', reason: 'synthetic boundary', frame: (await loadExecutionState(lease.userId, lease.runId)).frame }))
    // Discovery is global: another parallel fixture can precede this owner.
    // Exercise this exact source, never spend the one-shot mock on a peer run.
    vi.mocked(dispatchFreshDurableRun).mockImplementation(async (userId, runId) => {
      if (runId === admitted.runId) await realBootstrap.dispatchFreshDurableRun(userId, runId)
    })
    expect(await recoverDurableLoopRuns()).toContainEqual({ runId: admitted.runId, status: 'dispatched' })
    expect(execute, await bootstrapDiagnostic(admitted.runId, failures)).toHaveBeenCalledTimes(1)
    expect(executeAgentRun).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  }))

  it('a Stop during context assembly revokes the original admission before any frame or provider request', () => fixture(async f => {
    await ready(f)
    const admitted = await startLoopRun(f.userId, { sessionId: f.sessionId, novelId: f.novelId, prompt: '你好', mode: 'build' }, { humanOrigin: 'http' })
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const original = vi.mocked(context.assembleContext).getMockImplementation()!
    vi.mocked(context.assembleContext).mockImplementationOnce(async input => { await blocked; return original(input) })
    const work = realBootstrap.dispatchFreshDurableRun(f.userId, admitted.runId)
    try {
      await vi.waitFor(() => expect(context.assembleContext).toHaveBeenCalledTimes(1))
      await stopLoopRun(f.userId, admitted.runId)
    } finally { release() }
    await work
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: admitted.runId } })
    expect(run.status).toBe('paused')
    expect(await prisma.agentExecutionState.count({ where: { taskRootId: run.taskRootId! } })).toBe(0)
    expect((await prisma.agentRunLease.findUniqueOrThrow({ where: { runId: run.id } })).enabled).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  }))

  it.each(['fee-race', 'stop-after-lease'] as const)('%s is rechecked inside the original lease before the first frame', scenario => fixture(async f => {
    await ready(f)
    const admitted = await startLoopRun(f.userId, { sessionId: f.sessionId, novelId: f.novelId, prompt: '你好', mode: 'build' }, { humanOrigin: 'http' })
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: admitted.runId } })
    const budget = await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: run.taskRootId! } })
    const initialize = executionState.initializeExecutionState
    vi.spyOn(executionState, 'initializeExecutionState').mockImplementationOnce(async (lease, input) => {
      expect((await prisma.agentRunLease.findUniqueOrThrow({ where: { runId: run.id } })).ownerId).toBe(lease.ownerId)
      if (scenario === 'stop-after-lease') await stopLoopRun(f.userId, run.id)
      else await unknownUsage(f.userId, f.novelId, run.id)
      return initialize(lease, input)
    })
    await realBootstrap.dispatchFreshDurableRun(f.userId, run.id)
    expect(await prisma.agentExecutionState.count({ where: { taskRootId: run.taskRootId! } })).toBe(0)
    expect(await prisma.agentExecutionFrame.count({ where: { taskRootId: run.taskRootId! } })).toBe(0)
    expect(await prisma.agentTaskBudget.findUniqueOrThrow({ where: { taskRootId: run.taskRootId! } })).toEqual(budget)
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(scenario === 'stop-after-lease' ? 'paused' : 'queued')
    expect(await prisma.aiUsageLog.count({ where: { agentRunId: run.id } })).toBe(scenario === 'fee-race' ? 1 : 0)
    expect(fetch).not.toHaveBeenCalled()
  }))

  it('a real DB-backed Continue stream waits for initialization instead of closing on its previous pause', () => fixture(async f => {
    await ready(f)
    const admitted = await startLoopRun(f.userId, { sessionId: f.sessionId, novelId: f.novelId, prompt: '你好', mode: 'build' }, { humanOrigin: 'http' })
    await stopLoopRun(f.userId, admitted.runId)
    const resumed = await continueLoopRun(f.userId, admitted.runId)
    const response = new StreamResponse()
    const pending = streamDurableRun(f.userId, admitted.runId, resumed.eventStartSeq!, response as unknown as ExpressResponse)
    try {
      await vi.waitFor(() => expect(response.writeHead).toHaveBeenCalled())
      expect(response.writableEnded).toBe(false)
      await initializePersistedLoopRun(f.userId, admitted.runId)
      await vi.waitFor(() => expect(response.chunks.join('')).toContain(`id: ${resumed.eventStartSeq! + 1}\nevent: run.started`), { timeout: 2000, interval: 10 })
      expect(response.writableEnded).toBe(false)
    } finally { response.emit('close'); await pending }
    expect(fetch).not.toHaveBeenCalled()
  }))

  it('two dispatchers share the original frame and cannot overlap a live executor', () => fixture(async f => {
    await ready(f)
    const admitted = await startLoopRun(f.userId, { sessionId: f.sessionId, novelId: f.novelId, prompt: '你好', mode: 'build' }, { humanOrigin: 'http' })
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const execute = vi.spyOn(executor, 'runReviewedDurableExecution').mockImplementation(async lease => {
      await blocked
      return { kind: 'needs_attention', reason: 'synthetic boundary', frame: (await loadExecutionState(lease.userId, lease.runId)).frame }
    })
    const first = realBootstrap.dispatchFreshDurableRun(f.userId, admitted.runId)
    try {
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1))
      await realBootstrap.dispatchFreshDurableRun(f.userId, admitted.runId)
      expect(execute).toHaveBeenCalledTimes(1)
      expect(await prisma.agentTaskRoot.count({ where: { userId: f.userId, status: 'active' } })).toBe(1)
    } finally { release(); await first }
    expect(context.assembleContext).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
  }))

  it('current read-only policy narrows a fresh frozen writing catalog before the first model request', () => fixture(async f => {
    await ready(f)
    const admitted = await startLoopRun(f.userId, { sessionId: f.sessionId, novelId: f.novelId, chapterId: f.chapterId, prompt: '续写下一章正文。', mode: 'build' }, { humanOrigin: 'http' })
    await prisma.agentSession.update({ where: { id: f.sessionId }, data: { sandboxMode: 'read_only' } })
    const initial = await initializePersistedLoopRun(f.userId, admitted.runId)
    expect(initial.configuration.toolAuthority.some(grant => grant.name === 'chapter_write')).toBe(false)
    expect(initial.configuration.tools.some(tool => tool.function.name === 'chapter_write')).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  }))

  it('runs a genuine fresh writer through real read, coordinated body/reviews/commit and natural completion', { timeout: DURABLE_FULL_CHAIN_TEST_TIMEOUT_MS }, async ({ signal }) => {
    const lifecycle = createDurableTestLifecycle(signal, entry => console.info('[durable-quality-stage]', JSON.stringify(entry)))
    // Keep sampling opt-in: the timing control and covered run use the same
    // assertions without inspector startup cost.
    const stopCpu = process.env.CHEVOINK_TEST_CPU_PROFILE === '1' ? await startDurableTestCpuProfile() : undefined
    try { await fixture(async f => {
    await ready(f)
    const failures = observeBootstrapFailures(lifecycle)
    // The derivative is owned by the native executor, not a parallel legacy job.
    vi.spyOn(storyMemory, 'processMemoryExtractionJob').mockResolvedValue(undefined)
    const window = credits.getCreditWindow()
    await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 100000, periodStartedAt: window.startedAt, periodEndsAt: window.endsAt } })
    vi.spyOn(prices, 'resolveDurableTokenPrice').mockResolvedValue({ version: 'credits-v2-itemized', modelTier: 'speed', multiplierBps: 10000,
      rateCardId: 'fresh-writer-fixture', rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } })
    const content = '他停在原地，尚未行动。'
    const scene = { purpose: '等候', goal: '保留当前位置', obstacle: '尚未行动', choice: '继续等待', cost: '耗费时间', turn: '停在原地',
      entryState: {}, exitState: {}, styleBudget: { description: 'low', dialogue: 'medium', rhetoric: 'low' } }
    let mainCalls = 0, criticCalls = 0
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
      lifecycle.mockRequest()
      const body = JSON.parse(String(init.body))
      let delta: object
      if (body.tools) {
        mainCalls++
        if (mainCalls > 2) throw Error('Fresh completion must not request another main-model loop')
        const visible = body.tools.map((tool: { function: { name: string } }) => tool.function.name)
        for (const name of ['story_compiler_prepare', 'scene_task_build', 'chapter_read', 'chapter_write', 'chapter_bridge_commit']) expect(visible).toContain(name)
        delta = mainCalls === 1 ? { tool_calls: [
          { index: 0, id: 'fresh-prepare', type: 'function', function: { name: 'story_compiler_prepare', arguments: JSON.stringify({ chapterId: f.chapterId, intentSummary: '完整重写第一章正文' }) } },
          { index: 1, id: 'fresh-scenes', type: 'function', function: { name: 'scene_task_build', arguments: JSON.stringify({ tasks: [scene] }) } },
          { index: 2, id: 'fresh-read', type: 'function', function: { name: 'chapter_read', arguments: JSON.stringify({ chapterId: f.chapterId }) } },
          { index: 3, id: 'fresh-writer', type: 'function', function: { name: 'chapter_write', arguments: JSON.stringify({ chapterId: f.chapterId, content }) } },
          { index: 4, id: 'fresh-commit', type: 'function', function: { name: 'chapter_bridge_commit', arguments: JSON.stringify({ chapterSummary: '仍停在原地' }) } },
        ] } : { content: '第一章已保存并完成核对。' }
      } else {
        criticCalls++
        expect(body.reasoning_effort).toBe('none')
        expect(body.thinking?.type).not.toBe('enabled')
        if (criticCalls > 2) throw Error('A successful current-version report must not be paid twice')
        expect(body.messages[1].content).toContain(content)
        delta = { content: '{"findings":[]}' }
      }
      return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } })
    })
    vi.stubGlobal('fetch', fetcher)
    const admitted = await startLoopRun(f.userId, { sessionId: f.sessionId, novelId: f.novelId, chapterId: f.chapterId, prompt: '完整重写第一章正文。', mode: 'build', qualityMode: 'balanced' }, { humanOrigin: 'http' })
    const initial = await prisma.agentRun.findUniqueOrThrow({ where: { id: admitted.runId } })
    expect(taskSpecSchema.parse(initial.taskSpec).scope).toMatchObject({ writingCoordinationProtocol: 2, continuityReportProtocol: 5 })
    await realBootstrap.dispatchFreshDurableRun(f.userId, admitted.runId)
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: admitted.runId } })).status,
      await bootstrapDiagnostic(admitted.runId, failures)).toBe('completed')
    expect(await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapterId } })).toMatchObject({ content, revision: 2 })
    const compilation = await prisma.storyCompilation.findFirstOrThrow({ where: { runId: admitted.runId }, include: { bridge: true } })
    expect(compilation).toMatchObject({ status: 'completed', bridge: { committedAt: expect.any(Date) }, validation: { independentCheck: 'complete', checkedRevision: 2 } })
    expect(await prisma.chapterQualityReport.findFirstOrThrow({ where: { runId: admitted.runId } })).toMatchObject({ chapterRevision: 2 })
    expect(criticCalls).toBe(2)
    expect(mainCalls).toBeGreaterThanOrEqual(1)
    expect(await prisma.agentOperation.count({ where: { taskRootId: initial.taskRootId!, kind: 'tool', action: 'chapter_write' } })).toBe(1)
    expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId, kind: 'usage' } })).toBe(fetcher.mock.calls.length)
    expect(executeAgentRun).not.toHaveBeenCalled()
    }, undefined, '修改本章', { lifecycle })
    } finally { if (stopCpu) console.info('[durable-quality-cpu]', JSON.stringify(await stopCpu())) }
  })
})
