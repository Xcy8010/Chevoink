import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { prisma } from '../../api/lib/prisma.js'
import { encryptSecret } from '../../api/lib/secret-box.js'
import { verifyTestDatabase } from '../support/database-preflight.js'
import { isTestDatabaseRequired } from '../support/database-availability.js'
import { getModelAssignments, patchModelAssignments, freezeModelAssignments } from '../../api/lib/agent/model-assignments.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { withHumanAdmission } from '../../api/lib/agent/goal-activation-authority.js'
import { initializeDurableTask } from '../../api/lib/agent/runtime-identity.js'
import { acquireRunLease, revokeRunLease } from '../../api/lib/agent/runtime-lease.js'
import { initializeExecutionState, readExecutionStateInTransaction } from '../../api/lib/agent/runtime-state.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { modelRouteRevision } from '../../api/lib/agent/runtime-model-cursor.js'
import { preparePricedProviderOperation } from '../../api/lib/agent/runtime-settlement.js'
import { configureAgent, configureAgentTool, configureAgentSchema } from '../../api/lib/agent/tools/configuration-tools.js'
import { modelAssignmentTool } from '../../api/lib/agent/tools/model-assignment-tools.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { executeDurableStep } from '../../api/lib/agent/runtime-executor.js'
import { publishDurableEvents } from '../../api/lib/agent/runtime-event-projection.js'
import { bindConfigurationConsent, consumeDurableConfigurationConsent } from '../../api/lib/agent/configuration-journal.js'
import { assertConfigurationAuthority } from '../../api/lib/agent/configuration-authority.js'
import { pauseDurableTask } from '../../api/lib/agent/runtime-lifecycle.js'
import { resumeDurableTask } from '../../api/lib/agent/runtime-resume.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { preflightNovelImport, prepareNovelImport } from '../../api/lib/novel-import-service.js'

const available = await verifyTestDatabase(isTestDatabaseRequired())
afterAll(async () => { await prisma.$disconnect() })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function fixture(work: (f: { userId: string; novelId: string; otherNovelId: string; sessionId: string; modelA: string; modelB: string }) => Promise<void>) {
  const userId = randomUUID(), novelId = randomUUID(), otherNovelId = randomUUID(), sessionId = randomUUID(), modelA = randomUUID(), modelB = randomUUID()
  await prisma.user.create({ data: { id: userId, nickname: 'model-routing-isolated', passwordHash: 'test-only' } })
  try {
    await prisma.novel.createMany({ data: [novelId, otherNovelId].map(id => ({ id, authorId: userId, title: '测试', slug: randomUUID(), summary: '' })) })
    await prisma.agentSession.create({ data: { id: sessionId, userId, novelId, title: '测试', toolPolicy: { contentWrite: 'allow' } } })
    await prisma.aiModelConfig.createMany({ data: [{ id: modelA, name: '模型A' }, { id: modelB, name: '模型B' }].map(row => ({ id: row.id,
      ownerUserId: userId, key: `test:${row.id}`, provider: 'openai', displayName: row.name, modelName: row.name,
      baseUrl: 'https://fixture.invalid/v1', apiKeyCiphertext: encryptSecret('isolated-never-used'), multiplierBps: 0,
      metadata: { reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'high', visionEnabled: true, contextWindowTokens: 128000 } })) })
    await work({ userId, novelId, otherNovelId, sessionId, modelA, modelB })
  } finally {
    await prisma.agentRun.deleteMany({ where: { userId } })
    await prisma.agentSession.deleteMany({ where: { userId } })
    await prisma.novel.deleteMany({ where: { authorId: userId } })
    await prisma.user.delete({ where: { id: userId } })
  }
}
async function execution(f: { userId: string; novelId: string; sessionId: string; modelA: string }, prompt: string,
  tool: typeof configureAgentTool | typeof modelAssignmentTool, args: Record<string, unknown>, prefs?: Awaited<ReturnType<typeof freezeModelAssignments>>) {
  const runId = randomUUID(), messageId = randomUUID(), callId = randomUUID()
  const spec = buildTaskSpec({ runId, novelId: f.novelId, prompt })
  const request = withHumanAdmission({ sessionId: f.sessionId, novelId: f.novelId, prompt, mode: 'build', modelTier: 'custom', customModelId: f.modelA, reasoningEffort: 'low' })
  await prisma.agentRun.create({ data: { id: runId, userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, engine: 'loop', mode: 'act',
    action: 'workspaceAgent', agentType: 'writingOrchestrator', modelTier: 'custom', customModelId: f.modelA, reasoningEffort: 'low', taskSpec: runtimeJson(JSON.parse(JSON.stringify(spec))).value, startRequest: request } })
  await prisma.agentMessage.create({ data: { id: messageId, runId, sessionId: f.sessionId, role: 'user', parts: [{ type: 'text', text: prompt }] } })
  const root = await initializeDurableTask({ userId: f.userId, runId, sourceMessageId: messageId })
  const lease = await acquireRunLease({ userId: f.userId, runId, ownerId: 'fixture-model-owner', claimId: randomUUID() })
  await prisma.agentRun.update({ where: { id: runId }, data: { status: 'running' } })
  const initial = await initializeExecutionState(lease, { configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'stable', qualityMode: 'balanced',
    ...(prefs ? { modelAssignments: prefs } : {}),
    model: { tier: 'custom', customModelId: f.modelA, provider: 'openai', modelName: '模型A', reasoningEffort: 'low',
      routeRevision: modelRouteRevision({ provider: 'openai', model: '模型A', endpoint: 'https://fixture.invalid/v1/chat/completions', reasoningEffort: 'low' }) },
    tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.parameters, { io: 'input' }) } }],
    toolAuthority: [{ name: tool.name, permission: 'allow', alwaysConfirm: false, dangerous: false }], protectedChapterIds: [], pinnedSkillVersions: [] },
    snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null,
      messages: [{ role: 'system', content: '同一任务完整设定' }, { role: 'user', content: prompt },
        { role: 'assistant', content: null, toolCalls: [{ id: callId, name: tool.name, arguments: JSON.stringify(args) }] }], successfulToolSignatures: [] } })
  return { runId, root, lease, initial, callId }
}

describe.runIf(available)('model assignments and native configuration real isolated PG', () => {
  it('preserves import custom ownership403, captures the configured default and leaves unassigned imports basic without HTTP or charges', async () => fixture(async f => {
    vi.stubEnv('NOVEL_IMPORT_ENABLED', 'true')
    const foreignUserId = randomUUID(), foreignModelId = randomUUID()
    const http = vi.fn()
    vi.stubGlobal('fetch', http)
    await prisma.user.create({ data: { id: foreignUserId, nickname: 'foreign-import-model', passwordHash: 'test-only' } })
    try {
      await prisma.aiModelConfig.create({ data: { id: foreignModelId, ownerUserId: foreignUserId, key: `test:${foreignModelId}`,
        provider: 'openai', displayName: 'foreign-private', modelName: 'foreign-private', baseUrl: 'https://fixture.invalid/v1',
        apiKeyCiphertext: encryptSecret('test-only-unused'), multiplierBps: 0,
        metadata: { reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'max' } } })
      const scope = { userId: f.userId, novelId: f.novelId }
      const intent = await preflightNovelImport(scope)
      await prisma.aiModelConfig.update({ where: { id: f.modelB }, data: { enabled: false } })
      for (const customModelId of [randomUUID(), foreignModelId, f.modelB]) {
        await expect(prepareNovelImport(scope, intent.intentId, { kind: 'custom', customModelId })).rejects.toMatchObject({ status: 403, code: 'IMPORT_MODEL_UNAVAILABLE' })
        expect(await prisma.novelImportJob.count({ where: { userId: f.userId } })).toBe(0)
      }
      await prepareNovelImport(scope, intent.intentId, { kind: 'custom', customModelId: f.modelA })
      expect((await prisma.novelImportJob.findUniqueOrThrow({ where: { intentId: intent.intentId } })).modelSelection)
        .toEqual({ kind: 'custom', customModelId: f.modelA, reasoningEffort: 'high' })
      const otherScope = { userId: f.userId, novelId: f.otherNovelId }
      const otherIntent = await preflightNovelImport(otherScope)
      await prepareNovelImport(otherScope, otherIntent.intentId)
      expect((await prisma.novelImportJob.findUniqueOrThrow({ where: { intentId: otherIntent.intentId } })).modelSelection).toEqual({ kind: 'basic' })
      expect(http).not.toHaveBeenCalled()
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
      expect(await prisma.aiUsageLog.count({ where: { userId: f.userId } })).toBe(0)
    } finally {
      await prisma.user.delete({ where: { id: foreignUserId } })
      vi.unstubAllEnvs()
    }
  }))
  it('enforces owned scopes and concurrent CAS, keeps novel overrides and stable frozen copy', async () => fixture(async f => {
    const base = { modelTier: 'custom' as const, customModelId: f.modelA }
    const results = await Promise.allSettled([1, 2].map(() => patchModelAssignments(f.userId, { scope: 'global', expectedRevision: 0, assignments: { main: base } })))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    await patchModelAssignments(f.userId, { scope: 'novel', novelId: f.novelId, expectedRevision: 0, assignments: { main: { modelTier: 'custom', customModelId: f.modelB } } })
    const frozen = await freezeModelAssignments(f.userId, f.novelId)
    expect(frozen?.assignments.main).toMatchObject({ customModelId: f.modelB, reasoningEffort: 'high' })
    expect((await getModelAssignments(f.userId, f.otherNovelId)).effective.main?.selection.customModelId).toBe(f.modelA)
    await patchModelAssignments(f.userId, { scope: 'novel', novelId: f.novelId, expectedRevision: 1, assignments: { main: null } })
    expect((await getModelAssignments(f.userId, f.novelId)).effective.main?.source).toBe('global')
    expect(frozen?.assignments.main?.customModelId).toBe(f.modelB)
    await expect(patchModelAssignments('foreign', { scope: 'novel', novelId: f.novelId, expectedRevision: 2, assignments: { main: base } })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  }))
  it('switches next-turn config with original context, frozen prices and one native receipt/event', async () => fixture(async f => {
    const exec = await execution(f, '请切换到 模型B high', configureAgentTool, { model: { modelTier: 'custom', customModelId: f.modelB, reasoningEffort: 'high' } })
    const prior = await preparePricedProviderOperation(exec.lease, { key: 'already-priced', action: 'workspaceAgent', request: { model: 'old' },
      price: { version: 'credits-v1-exact', modelTier: 'custom', multiplierBps: 0 } })
    const result = await executeDurableToolStep(exec.lease, new AbortController().signal)
    expect(result.kind).toBe('tool')
    const state = await prisma.$transaction(tx => readExecutionStateInTransaction(tx, exec.root.id))
    expect(state.configuration.model).toMatchObject({ customModelId: f.modelB, modelName: '模型B', reasoningEffort: 'high' })
    expect(state.frame.state.messages.slice(0, 3)).toEqual(exec.initial.frame.state.messages)
    expect(state.frame.state.messages.at(-1)?.role).toBe('tool')
    expect((await prisma.agentOperation.findUniqueOrThrow({ where: { id: prior.id } })).inputHash).toBe(prior.inputHash)
    expect(state.originalRequest).toEqual(exec.root.requestSnapshot)
    expect(state.originalSpec).toEqual(exec.root.specSnapshot)
    expect(await prisma.agentConfigurationChange.count({ where: { runId: exec.runId } })).toBe(1)
    await publishDurableEvents(f.userId, exec.runId)
    await publishDurableEvents(f.userId, exec.runId)
    const events = await prisma.agentRunEvent.findMany({ where: { runId: exec.runId } })
    expect(events.filter(event => (event.payload as { type?: string }).type === 'run.configuration')).toHaveLength(1)
    expect(JSON.stringify(state.configuration)).not.toContain('isolated-never-used')
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response('data: {"choices":[{"delta":{"content":"任务已完成"},"finish_reason":"stop"}],"usage":{"prompt_tokens":50,"completion_tokens":10,"prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":50}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetcher)
    expect((await executeDurableStep(exec.lease, new AbortController().signal)).kind).toBe('model')
    expect(fetcher).toHaveBeenCalledOnce()
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body))
    expect(body).toMatchObject({ model: '模型B', reasoning_effort: 'high' })
    expect(body.messages[0]).toEqual({ role: 'system', content: '同一任务完整设定' })
    expect(body.messages[1]).toEqual({ role: 'user', content: '请切换到 模型B high' })
    expect(body.messages.some((message: { role: string; tool_call_id?: string }) => message.role === 'tool' && message.tool_call_id === exec.callId)).toBe(true)
    expect((await prisma.agentOperation.findUniqueOrThrow({ where: { id: prior.id } })).inputHash).toBe(prior.inputHash)
  }))
  it('freezes the selected configured default even when it is not medium or the middle capability', async () => fixture(async f => {
    await prisma.aiModelConfig.update({ where: { id: f.modelB }, data: { metadata: { reasoningEfforts: ['high', 'low', 'max'], defaultReasoningEffort: 'max', visionEnabled: true } } })
    await patchModelAssignments(f.userId, { scope: 'global', expectedRevision: 0, assignments: { main: { modelTier: 'custom', customModelId: f.modelB } } })
    const frozen = await freezeModelAssignments(f.userId, f.novelId)
    expect(frozen?.assignments.main?.reasoningEffort).toBe('max')
    const exec = await execution(f, '请切换到 模型B', configureAgentTool, { model: { modelTier: 'custom', customModelId: f.modelB } })
    await executeDurableToolStep(exec.lease, new AbortController().signal)
    expect((await prisma.$transaction(tx => readExecutionStateInTransaction(tx, exec.root.id))).configuration.model.reasoningEffort).toBe('max')
    await prisma.aiModelConfig.update({ where: { id: f.modelB }, data: { metadata: { reasoningEfforts: ['high', 'low', 'max'], defaultReasoningEffort: 'low', visionEnabled: true } } })
    expect((await freezeModelAssignments(f.userId, f.novelId))?.assignments.main?.reasoningEffort).toBe('max')
    expect((await prisma.$transaction(tx => readExecutionStateInTransaction(tx, exec.root.id))).configuration.model.reasoningEffort).toBe('max')
  }))
  it('denies fresh superseded author choices while replaying the committed receipt without new writes', async () => fixture(async f => {
    const args = { model: { modelTier: 'custom' as const, customModelId: f.modelB, reasoningEffort: 'high' as const } }
    const exec = await execution(f, '请切换到 模型B high', configureAgentTool, args)
    await executeDurableToolStep(exec.lease, new AbortController().signal)
    const ctx: ToolContext = { userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, runId: exec.runId, chapterId: null, callId: exec.callId,
      mode: 'build', creativeFreedom: 'stable', qualityMode: 'balanced', signal: new AbortController().signal, emit: vi.fn() }
    const control = async (prompt: string) => {
      const request = { novelId: f.novelId, sessionId: f.sessionId, mode: 'build' as const, prompt }
      const consent = await prisma.$transaction(tx => bindConfigurationConsent(tx, f.userId, request))
      expect(consent).not.toBeNull()
      await prisma.agentQueuedRequest.create({ data: { id: randomUUID(), userId: f.userId, sessionId: f.sessionId, status: 'held', payload: runtimeJson({ ...withHumanAdmission(request), configurationConsent: consent }).value } })
    }
    await control('请切换到 模型A')
    const state = await prisma.$transaction(tx => readExecutionStateInTransaction(tx, exec.root.id))
    const durableCtx = { ...ctx, callId: 'fresh-call', durableConfiguration: { lease: exec.lease, cursor: { expectedRevision: state.frame.revision, expectedHash: state.frame.snapshotHash }, operationKey: 'new' } }
    await expect(prisma.$transaction(tx => assertConfigurationAuthority(tx, durableCtx, args))).rejects.toMatchObject({ code: 'CONFIGURATION_AUTHOR_REQUIRED' })
    await consumeDurableConfigurationConsent(exec.lease)
    await expect(prisma.$transaction(tx => assertConfigurationAuthority(tx, durableCtx, args))).rejects.toMatchObject({ code: 'CONFIGURATION_AUTHOR_REQUIRED' })
    await expect(prisma.$transaction(tx => assertConfigurationAuthority(tx, durableCtx, { model: { modelTier: 'custom', customModelId: f.modelA } }))).resolves.toBeDefined()
    const receipt = await configureAgent(ctx, args)
    expect(JSON.parse(receipt.output).customModelId).toBe(f.modelB)
    expect(ctx.emit).not.toHaveBeenCalled()
    expect(await prisma.agentConfigurationChange.count({ where: { runId: exec.runId } })).toBe(1)
    await control('不要再用 模型A')
    await consumeDurableConfigurationConsent(exec.lease)
    await expect(prisma.$transaction(tx => assertConfigurationAuthority(tx, durableCtx, { model: { modelTier: 'custom', customModelId: f.modelA } }))).rejects.toMatchObject({ code: 'CONFIGURATION_AUTHOR_REQUIRED' })
  }))
  it('retains consumed same-root supersession after actual pause/resume without granting old-run control', async () => fixture(async f => {
    const exec = await execution(f, '请切换到 模型B', configureAgentTool, { model: { modelTier: 'custom', customModelId: f.modelB } })
    await executeDurableToolStep(exec.lease, new AbortController().signal)
    const request = { novelId: f.novelId, sessionId: f.sessionId, mode: 'build' as const, prompt: '请切换到 模型A' }
    const consent = await prisma.$transaction(tx => bindConfigurationConsent(tx, f.userId, request))
    await prisma.agentQueuedRequest.create({ data: { id: randomUUID(), userId: f.userId, sessionId: f.sessionId, status: 'held', payload: runtimeJson({ ...withHumanAdmission(request), configurationConsent: consent }).value } })
    await consumeDurableConfigurationConsent(exec.lease)
    await pauseDurableTask(f.userId, exec.runId)
    const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: exec.root.id, type: 'run.paused' }, orderBy: { sequence: 'desc' } })
    const resumed = await resumeDurableTask({ userId: f.userId, runId: exec.runId, pauseEventId: pause.id })
    const lease = await acquireRunLease({ userId: f.userId, runId: resumed.run.id, ownerId: 'new-fixture-owner', claimId: randomUUID() })
    await prisma.agentRun.update({ where: { id: lease.runId }, data: { status: 'running' } })
    const state = await prisma.$transaction(tx => readExecutionStateInTransaction(tx, exec.root.id))
    const ctx: ToolContext = { userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, runId: lease.runId, chapterId: null, callId: 'fresh-resumed-call',
      mode: 'build', creativeFreedom: 'stable', qualityMode: 'balanced', signal: new AbortController().signal, emit: () => {},
      durableConfiguration: { lease, cursor: { expectedRevision: state.frame.revision, expectedHash: state.frame.snapshotHash }, operationKey: 'new' } }
    await expect(prisma.$transaction(tx => assertConfigurationAuthority(tx, ctx, { model: { modelTier: 'custom', customModelId: f.modelB } }))).rejects.toMatchObject({ code: 'CONFIGURATION_AUTHOR_REQUIRED' })
    await expect(prisma.$transaction(tx => assertConfigurationAuthority(tx, ctx, { model: { modelTier: 'custom', customModelId: f.modelA } }))).rejects.toMatchObject({ code: 'CONFIGURATION_AUTHOR_REQUIRED' })
    expect(await consumeDurableConfigurationConsent(lease)).toBe(false)
  }))
  it('does not reset a later low choice to configured high through an omitted effort, but honors a genuinely newer model reset', async () => fixture(async f => {
    const exec = await execution(f, '请切换到 模型B high', configureAgentTool, { model: { modelTier: 'custom', customModelId: f.modelB, reasoningEffort: 'high' } })
    await executeDurableToolStep(exec.lease, new AbortController().signal)
    const control = async (prompt: string) => {
      const request = { novelId: f.novelId, sessionId: f.sessionId, mode: 'build' as const, prompt }
      const consent = await prisma.$transaction(tx => bindConfigurationConsent(tx, f.userId, request))
      await prisma.agentQueuedRequest.create({ data: { id: randomUUID(), userId: f.userId, sessionId: f.sessionId, status: 'held', payload: runtimeJson({ ...withHumanAdmission(request), configurationConsent: consent }).value } })
      await consumeDurableConfigurationConsent(exec.lease)
    }
    const call = async (args: Record<string, unknown>) => {
      const state = await prisma.$transaction(tx => readExecutionStateInTransaction(tx, exec.root.id))
      await (await import('../../api/lib/agent/runtime-state.js')).saveExecutionState(exec.lease, { expectedRevision: state.frame.revision, expectedHash: state.frame.snapshotHash,
        snapshot: { ...state.frame.state, messages: [...state.frame.state.messages, { role: 'assistant', content: null,
          toolCalls: [{ id: randomUUID(), name: 'agent_configure', arguments: JSON.stringify(args) }] }] } })
      return executeDurableToolStep(exec.lease, new AbortController().signal)
    }
    await control('思考强度设为 low')
    await call({ reasoningEffort: 'low' })
    expect((await prisma.$transaction(tx => readExecutionStateInTransaction(tx, exec.root.id))).configuration.model.reasoningEffort).toBe('low')
    await call({ model: { modelTier: 'custom', customModelId: f.modelB } })
    const unchanged = await prisma.$transaction(tx => readExecutionStateInTransaction(tx, exec.root.id))
    expect(unchanged.configuration.model.reasoningEffort).toBe('low')
    expect(await prisma.agentConfigurationChange.count({ where: { runId: exec.runId } })).toBe(2)
    expect(unchanged.frame.state.messages.at(-1)?.content).toContain('请先向作者确认')
    await control('请切换到 模型A')
    await call({ model: { modelTier: 'custom', customModelId: f.modelA } })
    expect((await prisma.$transaction(tx => readExecutionStateInTransaction(tx, exec.root.id))).configuration.model).toMatchObject({ customModelId: f.modelA, reasoningEffort: 'high' })
    const receiptCount = await prisma.agentConfigurationChange.count({ where: { runId: exec.runId } })
    await call({ reasoningEffort: 'low' })
    expect((await prisma.$transaction(tx => readExecutionStateInTransaction(tx, exec.root.id))).configuration.model).toMatchObject({ customModelId: f.modelA, reasoningEffort: 'high' })
    expect(await prisma.agentConfigurationChange.count({ where: { runId: exec.runId } })).toBe(receiptCount)
    await control('思考强度设为 low')
    await call({ reasoningEffort: 'low' })
    expect((await prisma.$transaction(tx => readExecutionStateInTransaction(tx, exec.root.id))).configuration.model).toMatchObject({ customModelId: f.modelA, reasoningEffort: 'low' })
    expect(await prisma.agentConfigurationChange.count({ where: { runId: exec.runId } })).toBe(receiptCount + 1)
  }))
  it('rolls preference/config/command changes back when native receipt publication fails, then replays the original operation once', async () => fixture(async f => {
    const exec = await execution(f, '全局质量检查用 模型B', modelAssignmentTool, { task: 'quality', model: { modelTier: 'custom', customModelId: f.modelB }, scope: 'global', expectedRevision: 0 })
    // A constraint failure AFTER mutation, within the same effect transaction.
    const operations = await import('../../api/lib/agent/runtime-operations.js')
    const original = operations.commitOperationEffect
    vi.spyOn(operations, 'commitOperationEffect').mockImplementationOnce((lease, id, hash, work) => original(lease, id, hash, async tx => {
      const result = await work(tx)
      throw new Error(`injected-effect-rollback:${typeof result}`)
    }))
    await expect(executeDurableToolStep(exec.lease, new AbortController().signal)).rejects.toThrow('injected-effect-rollback')
    expect((await getModelAssignments(f.userId)).global.revision).toBe(0)
    expect(await prisma.agentConfigurationChange.count({ where: { runId: exec.runId } })).toBe(0)
    const pending = await prisma.agentOperation.findFirstOrThrow({ where: { taskRootId: exec.root.id, action: 'model_assign' } })
    expect(pending.status).toBe('prepared')
    await executeDurableToolStep(exec.lease, new AbortController().signal)
    expect((await getModelAssignments(f.userId)).global.revision).toBe(1)
    expect(await prisma.agentOperation.count({ where: { taskRootId: exec.root.id, action: 'model_assign' } })).toBe(1)
    expect(await prisma.agentConfigurationChange.count({ where: { runId: exec.runId } })).toBe(1)
  }))
  it('global native assignment preserves a novel override, and stale CAS commits no preference mutation', async () => fixture(async f => {
    await patchModelAssignments(f.userId, { scope: 'novel', novelId: f.novelId, expectedRevision: 0, assignments: { quality: { modelTier: 'custom', customModelId: f.modelA } } })
    const frozen = await freezeModelAssignments(f.userId, f.novelId)
    const exec = await execution(f, '全局质量检查用 模型B', modelAssignmentTool, { task: 'quality', model: { modelTier: 'custom', customModelId: f.modelB }, scope: 'global', expectedRevision: 0 }, frozen)
    await executeDurableToolStep(exec.lease, new AbortController().signal)
    const state = await prisma.$transaction(tx => readExecutionStateInTransaction(tx, exec.root.id))
    expect(state.configuration.modelAssignments?.assignments.quality?.customModelId).toBe(f.modelA)
    expect((await getModelAssignments(f.userId, f.otherNovelId)).effective.quality?.selection.customModelId).toBe(f.modelB)
    const stale = await execution(f, '全局质量检查用 模型A', modelAssignmentTool, { task: 'quality', model: { modelTier: 'custom', customModelId: f.modelA }, scope: 'global', expectedRevision: 0 }, frozen)
    const result = await executeDurableToolStep(stale.lease, new AbortController().signal)
    expect(result).toMatchObject({ kind: 'tool', result: { outcome: 'failed', failureCode: 'MODEL_ASSIGNMENT_CONFLICT' } })
    expect((await getModelAssignments(f.userId)).global.revision).toBe(1)
    expect(await prisma.agentConfigurationChange.count({ where: { runId: stale.runId } })).toBe(0)
  }))
  it('refuses a revoked native owner before config/pref writes', async () => fixture(async f => {
    const exec = await execution(f, '请切换到 模型B', configureAgentTool, { model: { modelTier: 'custom', customModelId: f.modelB } })
    await revokeRunLease(f.userId, exec.runId)
    await expect(executeDurableToolStep(exec.lease, new AbortController().signal)).rejects.toMatchObject({ code: 'RUNTIME_LEASE_LOST' })
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: exec.runId } })).customModelId).toBe(f.modelA)
    expect(await prisma.agentConfigurationChange.count({ where: { runId: exec.runId } })).toBe(0)
  }))
  it('authenticates an exact live journal once, preserves same context and fences old epoch controls', async () => fixture(async f => {
    const exec = await execution(f, '讨论现有人物', configureAgentTool, {})
    // Start the journal at a real idle boundary with no pending native batch.
    const current = await prisma.$transaction(tx => readExecutionStateInTransaction(tx, exec.root.id))
    const { saveExecutionState } = await import('../../api/lib/agent/runtime-state.js')
    await saveExecutionState(exec.lease, { expectedRevision: current.frame.revision, expectedHash: current.frame.snapshotHash,
      snapshot: { ...current.frame.state, messages: current.frame.state.messages.slice(0, 2) } })
    const request = { novelId: f.novelId, sessionId: f.sessionId, prompt: '请切换到 模型B high', mode: 'build' as const }
    const consent = await prisma.$transaction(tx => bindConfigurationConsent(tx, f.userId, request))
    expect(consent?.sourceEpoch).toBe(exec.lease.epoch.toString())
    const queue = await prisma.agentQueuedRequest.create({ data: { id: randomUUID(), userId: f.userId, sessionId: f.sessionId, status: 'held',
      payload: runtimeJson({ ...withHumanAdmission(request), configurationConsent: consent }).value } })
    expect(await consumeDurableConfigurationConsent(exec.lease)).toBe(true)
    expect(await consumeDurableConfigurationConsent(exec.lease)).toBe(false)
    const state = await prisma.$transaction(tx => readExecutionStateInTransaction(tx, exec.root.id))
    expect(state.frame.state.messages.at(-1)).toEqual({ role: 'user', content: request.prompt })
    expect((await prisma.agentQueuedRequest.findUniqueOrThrow({ where: { id: queue.id } })).status).toBe('consented')
    const ctx: ToolContext = { userId: f.userId, novelId: f.novelId, sessionId: f.sessionId, runId: exec.runId, chapterId: null,
      callId: exec.callId, mode: 'build', creativeFreedom: 'stable', qualityMode: 'balanced', signal: new AbortController().signal, emit: () => {},
      durableConfiguration: { lease: exec.lease, cursor: { expectedRevision: state.frame.revision, expectedHash: state.frame.snapshotHash }, operationKey: 'exec:0' } }
    await expect(prisma.$transaction(tx => assertConfigurationAuthority(tx, ctx, { model: { modelTier: 'custom', customModelId: f.modelB, reasoningEffort: 'high' } })))
      .resolves.toMatchObject({ sourceMessageId: consent!.messageId })
    await pauseDurableTask(f.userId, exec.runId)
    await expect(consumeDurableConfigurationConsent(exec.lease)).rejects.toMatchObject({ code: 'RUNTIME_NOT_ACTIVE' })
    expect(state.frame.state.messages[0]).toEqual({ role: 'system', content: '同一任务完整设定' })
  }))
  it('binds exact creative-mode controls to the current task, and leaves mixed manuscript requests as new work', async () => fixture(async f => {
    await execution(f, '讨论现有人物', configureAgentTool, {})
    for (const prompt of ['创作模式切换到严谨创作', '切换到大胆创作', '请改为平衡创作']) {
      expect(await prisma.$transaction(tx => bindConfigurationConsent(tx, f.userId, { novelId: f.novelId, sessionId: f.sessionId, mode: 'build', prompt }))).not.toBeNull()
    }
    const before = await prisma.agentMessage.count({ where: { sessionId: f.sessionId } })
    for (const prompt of ['切换到大胆创作，并创作下一章', '切换到严谨创作。写下一章', '切换到大胆创作正文']) {
      expect(await prisma.$transaction(tx => bindConfigurationConsent(tx, f.userId, { novelId: f.novelId, sessionId: f.sessionId, mode: 'build', prompt }))).toBeNull()
    }
    expect(await prisma.agentMessage.count({ where: { sessionId: f.sessionId } })).toBe(before)
  }))
  it('rejects conflicting effort arguments before preparing any operation', () => {
    expect(configureAgentSchema.safeParse({ model: { modelTier: 'speed', reasoningEffort: 'low' }, reasoningEffort: 'high' }).success).toBe(false)
  })
})
