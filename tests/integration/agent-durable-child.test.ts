import { randomUUID } from 'node:crypto'
import { setTimeout as contentionTimer } from 'node:timers/promises'
import { Prisma } from '@prisma/client'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { prisma } from '../../api/lib/prisma.js'
import * as runtimeCommon from '../../api/lib/agent/runtime-common.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'
import { buildTaskSpec } from '../../api/lib/agent/task-spec.js'
import { initializeDurableTask, attachRunToDurableTask } from '../../api/lib/agent/runtime-identity.js'
import { acquireRunLease, withRunLease, releaseRunLease, type RunLeaseToken } from '../../api/lib/agent/runtime-lease.js'
import { initializeExecutionState, loadExecutionState, saveExecutionState } from '../../api/lib/agent/runtime-state.js'
import { prepareToolCursorOperation } from '../../api/lib/agent/runtime-tool-cursor.js'
import { subAgentRunTool } from '../../api/lib/agent/tools/subagent-tools.js'
import { taskSpawnTool } from '../../api/lib/agent/tools/task-orchestration-tools.js'
import { chapterReadTool } from '../../api/lib/agent/tools/read-tools.js'
import { toOpenAIParameters } from '../../api/lib/agent/tool-schema.js'
import { admitChildExecution, MAIN_RUN_FILTER, intersectChildConfiguration, verifyChildGrant } from '../../api/lib/agent/runtime-child.js'
import { childContext } from '../../api/lib/agent/runtime-child-tools.js'
import { readTaskBudget } from '../../api/lib/agent/runtime-budget.js'
import { pauseDurableTask, finalizeDurableTask } from '../../api/lib/agent/runtime-lifecycle.js'
import { resumeDurableTask } from '../../api/lib/agent/runtime-resume.js'
import { prepareModelCursorOperation, modelRouteRevision } from '../../api/lib/agent/runtime-model-cursor.js'
import { prepareProviderAttempt, markProviderDispatched, recordProviderUsage, recordProviderResult, recordToolFailure } from '../../api/lib/agent/runtime-operations.js'
import { settleProviderOperation } from '../../api/lib/agent/runtime-settlement.js'
import { registerActiveRun, deregisterActiveRun, getActiveRunIdBySession, hasActiveRunInSession, stopActiveRunsInSession } from '../../api/lib/agent/active-runs.js'
import { reduceExecutionReceipt } from '../../api/lib/agent/runtime-reducer.js'
import { publishDurableEvents, loadDurableEvents } from '../../api/lib/agent/runtime-event-projection.js'
import { parentContentionGate } from '../../api/lib/agent/runtime-parent-contention.js'
import { executeDurableToolStep } from '../../api/lib/agent/runtime-tool-step.js'
import { chapterWriteTool, chapterEditRangeTool } from '../../api/lib/agent/tools/chapter-tools.js'
import { qualityAnalyzeTool } from '../../api/lib/agent/tools/humanity-quality-tools.js'
import { continuityValidateTool } from '../../api/lib/agent/tools/story-compiler-tools.js'

vi.mock('node:timers/promises', async importOriginal => {
  const timers = await importOriginal<typeof import('node:timers/promises')>()
  return { ...timers, setTimeout: vi.fn(timers.setTimeout) }
})

const available = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
afterAll(async () => { await prisma.$disconnect() })
afterEach(async () => {
  vi.unstubAllGlobals(); vi.restoreAllMocks()
  const timers = await vi.importActual<typeof import('node:timers/promises')>('node:timers/promises')
  vi.mocked(contentionTimer).mockReset().mockImplementation(timers.setTimeout)
})
const route = { provider: 'fixture', model: 'fixture', endpoint: 'https://provider.invalid/v1/chat/completions', reasoningEffort: 'high' }
const price = { version: 'credits-v1-exact' as const, modelTier: 'speed' as const, multiplierBps: 10000 }

async function fixture(work: (f: Awaited<ReturnType<typeof prepareFixture>>) => Promise<void>, spawned = false, budget = 5000, target?: 'finite' | 'selection') {
  const user = await prisma.user.create({ data: { nickname: 'durable-child-fixture', passwordHash: 'test-only-unusable' } })
  try { await work(await prepareFixture(user.id, spawned, budget, target)) }
  finally {
    await prisma.agentChildExecutionGrant.deleteMany({ where: { childRun: { userId: user.id } } })
    await prisma.agentArtifact.deleteMany({ where: { run: { userId: user.id } } })
    await prisma.agentRun.deleteMany({ where: { userId: user.id } })
    await prisma.agentSession.deleteMany({ where: { userId: user.id } })
    await prisma.chapter.deleteMany({ where: { authorId: user.id } })
    await prisma.volume.deleteMany({ where: { novel: { authorId: user.id } } })
    await prisma.novel.deleteMany({ where: { authorId: user.id } })
    await prisma.user.delete({ where: { id: user.id } })
  }
}

async function prepareFixture(userId: string, spawned: boolean, tokenBudget: number, target?: 'finite' | 'selection') {
  const novel = await prisma.novel.create({ data: { authorId: userId, title: '子任务测试', slug: randomUUID(), summary: '' } })
  const session = await prisma.agentSession.create({ data: { userId, novelId: novel.id, title: '父任务', toolPolicy: { network: 'allow', contentWrite: 'allow' } } })
  const runId = randomUUID()
  const definition = await prisma.agentSubtask.create({ data: { userId, novelId: novel.id, name: '研究', role: 'research', prompt: '只读审阅',
    triggerCondition: '需要报告', enabled: true, tokenBudget: 16000, status: 'ready' } })
  const chapters = target ? await (async () => {
    const volume = await prisma.volume.create({ data: { novelId: novel.id, title: '测试卷', orderIndex: 1 } })
    return Promise.all([1, 2].map(order => prisma.chapter.create({ data: { authorId: userId, novelId: novel.id, volumeId: volume.id,
      title: `第${order}章`, content: '前缀选区后缀', orderIndex: order, orderInVolume: order, wordCount: 6 } })))
  })() : []
  const spec = { ...buildTaskSpec({ runId, novelId: novel.id, prompt: '只读审阅并汇报' }), intent: 'review' as const, postconditions: [],
    ...(target ? { scope: { novelId: novel.id, chapterIds: [chapters[0].id], ...(target === 'selection' ? { selection: { chapterId: chapters[0].id, text: '选区', start: 2, end: 4 } } : {}) } } : {}),
    expectedOutputs: [{ kind: 'validation_report' as const, required: true, description: '报告' }] }
  await prisma.agentRun.create({ data: { id: runId, userId, novelId: novel.id, sessionId: session.id, mode: 'review', status: 'queued',
    engine: 'loop', action: 'workspaceAgent', agentType: 'writingOrchestrator', taskSpec: JSON.parse(JSON.stringify(spec)) } })
  const message = await prisma.agentMessage.create({ data: { runId, sessionId: session.id, role: 'user', parts: [{ type: 'text', text: '只读审阅并汇报' }] } })
  const root = await initializeDurableTask({ userId, runId, sourceMessageId: message.id, tokenBudget })
  const lease = await acquireRunLease({ userId, runId, ownerId: 'parent-worker', claimId: randomUUID() })
  const tool = spawned ? taskSpawnTool : subAgentRunTool
  const args = spawned ? { tasks: [{ title: '窗口一', brief: '读取作品的现有设定并给出完整的只读审阅报告。' }, { title: '窗口二', brief: '读取作品的现有设定并给出第二份只读审阅报告。' }], mode: 'review', inherit: 'brief' }
    : { subagentId: definition.id, task: '报告' }
  const tools = target ? [tool, chapterReadTool, chapterWriteTool, chapterEditRangeTool, qualityAnalyzeTool, continuityValidateTool] : [tool, chapterReadTool]
  const configuration = { version: 1 as const, mode: target ? 'build' as const : 'review' as const, agentType: 'orchestrator', creativeFreedom: 'balanced' as const, qualityMode: 'premium' as const,
    model: { tier: 'speed', provider: route.provider, modelName: route.model, customModelId: null, reasoningEffort: route.reasoningEffort,
      routeRevision: modelRouteRevision(route), maxOutputTokens: 100 },
    tools: tools.map(item => ({ type: 'function' as const, function: { name: item.name, description: item.description, parameters: toOpenAIParameters(item.parameters) } })),
    toolAuthority: tools.map(item => ({ name: item.name, permission: 'allow' as const, alwaysConfirm: false, dangerous: false })),
    protectedChapterIds: [], pinnedSkillVersions: [] }
  const initial = await initializeExecutionState(lease, { configuration, snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0,
    phase: 'idle', pendingOperationId: null, messages: [{ role: 'user', content: '原始已授权上下文，必须保留' },
      { role: 'assistant', content: null, toolCalls: [{ id: 'delegate', name: tool.name, arguments: JSON.stringify(args) }] }], successfulToolSignatures: [] } })
  const prepared = await prepareToolCursorOperation(lease, { expectedRevision: 0, expectedHash: initial.frame.snapshotHash }, {
    key: 'exec:0', action: tool.name, callId: 'delegate', targetId: root.id, effectDomain: 'read', effectiveArgs: args,
    normalize: value => tool.parameters.parse(value), operationInput: { callId: 'delegate', args } })
  const input = { parentOperationId: prepared.operation.id, childIndex: 0, kind: spawned ? 'spawned' as const : 'inline' as const, role: 'research' as const,
    ...(spawned ? {} : { definitionId: definition.id }),
    name: '研究', prompt: '报告', spec: { ...spec, id: randomUUID(), runId: undefined }, configuration, price,
    tokenCeiling: 1000, turnCeiling: 3, roleTools: ['chapter_read'], messages: childContext(initial.frame.state.messages, '报告', '只做已授权的只读研究') }
  return { userId, runId, rootId: root.id, sessionId: session.id, novelId: novel.id, lease, input, initial, prepared, chapters }
}

async function provider(f: Awaited<ReturnType<typeof prepareFixture>>, lease: RunLeaseToken) {
  const state = await loadExecutionState(f.userId, lease.runId)
  const request = { body: { model: 'fixture', messages: [{ role: 'user', content: '报告' }], max_tokens: 100 } }
  const prepared = await prepareModelCursorOperation(lease, { expectedRevision: 0, expectedHash: state.frame.snapshotHash }, { key: 'exec:0', action: 'workspaceAgent', request, price })
  const attempt = await prepareProviderAttempt(lease, { operationId: prepared.operation.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request })
  await markProviderDispatched(lease, attempt.id)
  return { ...prepared, attempt, identity: { userId: f.userId, attemptId: attempt.id, requestHash: attempt.requestHash } }
}

async function knownProvider(f: Awaited<ReturnType<typeof prepareFixture>>, lease: RunLeaseToken) {
  const call = await provider(f, lease)
  await recordProviderUsage({ ...call.identity, revision: 1, usage: { source: 'reported', promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, cacheMissTokens: 10 } })
  await recordProviderResult({ ...call.identity, outcome: 'succeeded', result: { content: '原始已确认交付', reasoning: '', toolCalls: [], finishReason: 'stop',
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, promptCacheHitTokens: 0, promptCacheMissTokens: 10 } } })
  expect((await settleProviderOperation({ ...call.identity, lease })).status).toBe('settled')
  return call
}

describe.runIf(available)('canonical durable child grants', () => {
  it('atomically reduces a child receipt in one transaction and replays the same saved frame without HTTP or debit', async () => fixture(async f => {
    const fetcher = vi.fn(() => { throw new Error('receipt reduction cannot dispatch HTTP') })
    vi.stubGlobal('fetch', fetcher)
    const grant = await admitChildExecution(f.lease, f.input)
    const child = await acquireRunLease({ userId: f.userId, runId: grant.childRunId, ownerId: 'atomic-child', claimId: randomUUID() })
    const call = await knownProvider(f, child)
    const debitCount = await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })
    const cursor = { expectedRevision: call.pending.revision, expectedHash: call.pending.snapshotHash, operationId: call.operation.id }
    const transactions = vi.spyOn(runtimeCommon, 'runtimeTransaction')
    const saved = await reduceExecutionReceipt(child, cursor)
    expect(transactions).toHaveBeenCalledTimes(1)
    expect(saved.state.messages.at(-1)).toEqual({ role: 'assistant', content: '原始已确认交付' })
    expect(saved.state.phase).toBe('idle')
    const replay = await reduceExecutionReceipt(child, cursor)
    expect(transactions).toHaveBeenCalledTimes(2)
    expect(replay).toEqual(saved)
    transactions.mockRestore()
    expect(await prisma.agentExecutionFrame.count({ where: { taskRootId: child.taskRootId } })).toBe(3)
    expect(await prisma.agentProviderAttempt.count({ where: { operationId: call.operation.id } })).toBe(1)
    expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(debitCount)
    expect(fetcher).not.toHaveBeenCalled()
  }))

  it.each(['receipt', 'outbox', 'revoked parent'] as const)('denies child receipt reduction with %s damage without appending or charging', async kind => fixture(async f => {
    const grant = await admitChildExecution(f.lease, f.input)
    const child = await acquireRunLease({ userId: f.userId, runId: grant.childRunId, ownerId: 'denied-reducer', claimId: randomUUID() })
    const call = await knownProvider(f, child)
    const debitCount = await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })
    const result = await prisma.agentProviderAttempt.findUniqueOrThrow({ where: { id: call.attempt.id } })
    if (kind === 'receipt') await prisma.agentProviderAttempt.update({ where: { id: result.id }, data: { resultHash: 'f'.repeat(64) } })
    else if (kind === 'outbox') await prisma.agentExecutionOutbox.deleteMany({ where: { eventKey: `result:${result.id}:${result.resultHash}` } })
    else await pauseDurableTask(f.userId, f.runId)
    await expect(reduceExecutionReceipt(child, { expectedRevision: call.pending.revision, expectedHash: call.pending.snapshotHash, operationId: call.operation.id }))
      .rejects.toMatchObject({ code: kind === 'revoked parent' ? 'RUNTIME_NOT_ACTIVE' : 'RUNTIME_RECEIPT_INVALID' })
    expect((await loadExecutionState(f.userId, child.runId)).frame.snapshotHash).toBe(call.pending.snapshotHash)
    expect(await prisma.agentExecutionFrame.count({ where: { taskRootId: child.taskRootId } })).toBe(2)
    expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(debitCount)
  }))

  it('retains separate receipt-read and state-write transactions for a main run', async () => fixture(async f => {
    await recordToolFailure(f.lease, { operationId: f.prepared.operation.id, inputHash: f.prepared.operation.inputHash,
      code: 'FIXTURE_NATIVE_REFUSAL', output: '未执行子任务，不代表交付成功。', summary: '已保存拒绝' })
    const transactions = vi.spyOn(runtimeCommon, 'runtimeTransaction')
    const frame = await reduceExecutionReceipt(f.lease, { expectedRevision: f.prepared.pending.revision,
      expectedHash: f.prepared.pending.snapshotHash, operationId: f.prepared.operation.id })
    expect(transactions).toHaveBeenCalledTimes(2)
    expect(frame.state.messages.at(-1)).toMatchObject({ role: 'tool', content: expect.stringContaining('未执行子任务') })
    transactions.mockRestore()
  }))

  it('queues parent reads and projection with child work while public pause fences effects and retains late evidence', async () => fixture(async f => {
    const grant = await admitChildExecution(f.lease, f.input)
    const child = await acquireRunLease({ userId: f.userId, runId: grant.childRunId, ownerId: 'queued-child', claimId: randomUUID() })
    const call = await provider(f, child)
    const effect = vi.fn(async () => undefined), parentJoin = vi.fn(async () => undefined)
    const held = await parentContentionGate.acquire({ userId: f.userId, parentRootId: f.rootId }, { deadline: Date.now() + 5000 })
    const deniedEffect = withRunLease(child, effect).catch(error => error)
    const deniedParent = withRunLease(f.lease, parentJoin).catch(error => error)
    const deniedDebit = settleProviderOperation({ ...call.identity, lease: child }).catch(error => error)
    const frameRead = loadExecutionState(f.userId, f.runId)
    const projection = publishDurableEvents(f.userId, f.runId)
    const replayRead = loadDurableEvents(f.userId, f.runId, 0)
    try {
      await vi.waitFor(() => expect(parentContentionGate.size().waiting).toBe(6), { timeout: 2500 })
      // This public control deliberately bypasses the work permit.
      await pauseDurableTask(f.userId, f.runId)
      expect((await prisma.agentRunLease.findUniqueOrThrow({ where: { runId: f.runId } })).epoch).toBeGreaterThan(BigInt(f.lease.epoch))
      expect(effect).not.toHaveBeenCalled()
      expect(parentJoin).not.toHaveBeenCalled()
    } finally { held.release() }
    expect((await deniedEffect).code).toBe('RUNTIME_NOT_ACTIVE')
    expect((await deniedParent).code).toBe('RUNTIME_NOT_ACTIVE')
    expect((await deniedDebit).code).toBe('RUNTIME_NOT_ACTIVE')
    await Promise.all([frameRead, projection, replayRead])
    await recordProviderResult({ ...call.identity, outcome: 'succeeded', result: { content: '暂停后收到的原请求结果' } })
    await recordProviderUsage({ ...call.identity, revision: 1, usage: { source: 'reported', promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, cacheMissTokens: 10 } })
    expect((await prisma.agentProviderAttempt.findUniqueOrThrow({ where: { id: call.attempt.id } })).resultHash).not.toBeNull()
    expect((await prisma.agentProviderUsageReceipt.findUniqueOrThrow({ where: { attemptId: call.attempt.id } })).settlementStatus).toBe('pending')
    expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
    expect(effect).not.toHaveBeenCalled()
    expect(parentJoin).not.toHaveBeenCalled()
    expect(parentContentionGate.size()).toEqual({ roots: 0, waiting: 0 })
  }))

  it('rechecks revocation after a child contention wait before invoking another effect callback', async () => fixture(async f => {
    const grant = await admitChildExecution(f.lease, f.input)
    const child = await acquireRunLease({ userId: f.userId, runId: grant.childRunId, ownerId: 'wait-child', claimId: randomUUID() })
    let entered!: () => void
    let release!: () => void
    const waitReached = new Promise<void>(resolve => { entered = resolve })
    const pauseCommitted = new Promise<void>(resolve => { release = resolve })
    // The runtime invokes this only after the failed transaction rolled back.
    // Hold this one wait until the real cancellation commits; other waits use
    // the actual timer. Elapsed milliseconds cannot prove revocation order.
    vi.mocked(contentionTimer).mockImplementationOnce(async () => {
      entered()
      await pauseCommitted
    })
    let callbacks = 0
    const work = withRunLease(child, async () => {
      callbacks++
      throw new Prisma.PrismaClientKnownRequestError('injected DB-only contention', { code: 'P2034', clientVersion: 'test' })
    })
    // Attach the rejection handler now, while cancellation races the wait.
    const stopped = work.then(() => null, error => error)
    await waitReached
    try { await pauseDurableTask(f.userId, f.runId) }
    finally { release() }
    const error = await stopped
    expect(error).toMatchObject({ status: 409 })
    expect(error.code).not.toBe('P2034')
    expect(callbacks).toBe(1)
    expect(await prisma.agentEffectReceipt.count({ where: { runId: grant.childRunId } })).toBe(0)
  }))

  it('rejects a corrupted child root containing a second run before provider dispatch', async () => fixture(async f => {
    const grant = await admitChildExecution(f.lease, f.input)
    const child = await prisma.agentRun.findUniqueOrThrow({ where: { id: grant.childRunId } })
    await prisma.agentRun.create({ data: { userId: f.userId, novelId: f.novelId, sessionId: child.sessionId, taskRootId: child.taskRootId,
      runtimeProtocolVersion: 1, mode: 'review', status: 'queued', engine: 'loop', action: 'workspaceAgent', agentType: 'writingOrchestrator' } })
    await expect(acquireRunLease({ userId: f.userId, runId: grant.childRunId, ownerId: 'corrupt-child', claimId: randomUUID() })).rejects.toMatchObject({ code: 'RUNTIME_CHILD_ROOT_CONFLICT' })
    expect(await prisma.agentProviderAttempt.count({ where: { operation: { taskRootId: child.taskRootId! }, dispatchedAt: { not: null } } })).toBe(0)
  }))

  it('revalidates an owned enabled definition at the actual provider dispatch boundary', async () => {
    await fixture(async f => {
      const grant = await admitChildExecution(f.lease, f.input)
      const child = await acquireRunLease({ userId: f.userId, runId: grant.childRunId, ownerId: 'child-worker', claimId: randomUUID() })
      const state = await loadExecutionState(f.userId, child.runId)
      const request = { body: { model: 'fixture', messages: [{ role: 'user', content: '报告' }], max_tokens: 100 } }
      const operation = await prepareModelCursorOperation(child, { expectedRevision: 0, expectedHash: state.frame.snapshotHash }, { key: 'exec:0', action: 'workspaceAgent', request, price })
      const attempt = await prepareProviderAttempt(child, { operationId: operation.operation.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request })
      await prisma.agentSubtask.update({ where: { id: f.input.definitionId! }, data: { enabled: false } })
      await expect(markProviderDispatched(child, attempt.id)).rejects.toMatchObject({ code: 'RUNTIME_CHILD_DEFINITION_REQUIRED' })
      expect(await prisma.agentProviderAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toMatchObject({ status: 'prepared', dispatchedAt: null })
    })
  })

  it('reuses duplicate admission and preserves frozen context, config, price and single child FK', async () => {
    await fixture(async f => {
      const grants = await Promise.all([admitChildExecution(f.lease, f.input), admitChildExecution(f.lease, f.input)])
      expect(grants[0].childRunId).toBe(grants[1].childRunId)
      expect(await prisma.agentChildExecutionGrant.count({ where: { parentRootId: f.rootId } })).toBe(1)
      const frozen = verifyChildGrant(grants[0])
      expect(frozen.price).toEqual(price)
      const child = await loadExecutionState(f.userId, grants[0].childRunId)
      expect(child.frame.state.messages[0]).toMatchObject({ content: '原始已授权上下文，必须保留' })
      expect(child.frame.state.messages.at(-1)).toMatchObject({ role: 'user', content: '报告' })
      expect(child.configuration.tools.map(item => item.function.name)).toEqual(['chapter_read'])
      await expect(prisma.agentChildExecutionGrant.update({ where: { id: grants[0].id }, data: { tokenCeiling: 2000 } })).rejects.toThrow(/immutable child execution admission cannot change/)
      expect((await prisma.agentChildExecutionGrant.findUniqueOrThrow({ where: { id: grants[0].id } })).tokenCeiling).toBe(1000)
    })
  })

  it('atomically reserves concurrent children and rejects over-allocation under one parent limit', async () => {
    await fixture(async f => {
      const results = await Promise.allSettled([admitChildExecution(f.lease, f.input), admitChildExecution(f.lease, { ...f.input, childIndex: 1, spec: { ...f.input.spec, id: randomUUID() } })])
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'RUNTIME_CHILD_BUDGET_EXHAUSTED' } })
      expect(await readTaskBudget(f.lease)).toMatchObject({ usedTokens: 0n, reservedChildTokens: 1000n })
    }, true, 1500)
  })

  it('rejects forged parent lease, foreign scope and child recursion before creating execution', async () => {
    await fixture(async f => {
      await expect(admitChildExecution({ ...f.lease, epoch: f.lease.epoch + 1n }, f.input)).rejects.toMatchObject({ code: 'RUNTIME_LEASE_LOST' })
      await expect(admitChildExecution(f.lease, { ...f.input, spec: { ...f.input.spec, scope: { novelId: 'foreign' } } })).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_MISMATCH' })
      expect(await prisma.agentChildExecutionGrant.count({ where: { parentRootId: f.rootId } })).toBe(0)
      const grant = await admitChildExecution(f.lease, f.input)
      const child = await acquireRunLease({ userId: f.userId, runId: grant.childRunId, ownerId: 'child', claimId: randomUUID() })
      await expect(admitChildExecution(child, f.input)).rejects.toMatchObject({ code: 'RUNTIME_CHILD_RECURSION_DENIED' })
      await expect(attachRunToDurableTask({ userId: f.userId, runId: grant.childRunId, taskRootId: child.taskRootId })).rejects.toMatchObject({ code: 'RUNTIME_CHILD_SOURCE_REQUIRED' })
    })
  })

  it('fences writes/dispatch/debit after parent stop while preserving late known usage and result', async () => {
    await fixture(async f => {
      const grant = await admitChildExecution(f.lease, f.input)
      const child = await acquireRunLease({ userId: f.userId, runId: grant.childRunId, ownerId: 'child', claimId: randomUUID() })
      const call = await provider(f, child)
      const paused = await pauseDurableTask(f.userId, f.runId)
      expect(paused.runIds).toContain(grant.childRunId)
      await recordProviderUsage({ ...call.identity, revision: 1, usage: { source: 'reported', promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, cacheMissTokens: 10 } })
      await recordProviderResult({ ...call.identity, outcome: 'succeeded', result: { content: '迟到的真实结果' } })
      await recordProviderUsage({ ...call.identity, revision: 1, usage: { source: 'reported', promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, cacheMissTokens: 10 } })
      await recordProviderResult({ ...call.identity, outcome: 'succeeded', result: { content: '迟到的真实结果' } })
      expect(await prisma.agentExecutionOutbox.count({ where: { operationId: call.operation.id, type: 'provider.result.recorded' } })).toBe(1)
      expect(await prisma.agentExecutionOutbox.count({ where: { operationId: call.operation.id, type: 'provider.usage.recorded' } })).toBe(1)
      const effect = vi.fn(async () => undefined)
      await expect(withRunLease(child, effect)).rejects.toMatchObject({ code: 'RUNTIME_NOT_ACTIVE' })
      expect(effect).not.toHaveBeenCalled()
      await expect(settleProviderOperation({ ...call.identity, lease: child })).rejects.toMatchObject({ code: 'RUNTIME_NOT_ACTIVE' })
      expect(await settleProviderOperation(call.identity)).toMatchObject({ status: 'pending', reason: 'child_lease_not_confirmed' })
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
      expect(await prisma.agentProviderUsageReceipt.findUnique({ where: { attemptId: call.attempt.id } })).toMatchObject({ source: 'reported', promptTokens: 10, completionTokens: 5, settlementStatus: 'pending' })
    })
  })

  it('adopts the same grant/run/root after restart and rejects the old child generation', async () => {
    await fixture(async f => {
      const grant = await admitChildExecution(f.lease, f.input)
      const child = await acquireRunLease({ userId: f.userId, runId: grant.childRunId, ownerId: 'old-child', claimId: randomUUID() })
      const call = await provider(f, child)
      await recordProviderResult({ ...call.identity, outcome: 'unknown', result: { reason: 'worker_restart' } })
      await releaseRunLease(f.lease)
      const adoptedParent = await acquireRunLease({ userId: f.userId, runId: f.runId, ownerId: 'new-parent', claimId: randomUUID() })
      const current = await prisma.agentChildExecutionGrant.findUniqueOrThrow({ where: { id: grant.id } })
      expect(current).toMatchObject({ childRunId: grant.childRunId, admissionEpoch: grant.admissionEpoch, generation: adoptedParent.epoch })
      await expect(withRunLease(child, async () => undefined)).rejects.toMatchObject({ code: 'RUNTIME_PARENT_LEASE_LOST' })
      const newChild = await acquireRunLease({ userId: f.userId, runId: grant.childRunId, ownerId: 'new-child', claimId: randomUUID() })
      expect(newChild.taskRootId).toBe(child.taskRootId)
      expect(await markProviderDispatched(newChild, call.attempt.id)).toMatchObject({ dispatchGranted: false })
      expect(await readTaskBudget(adoptedParent)).toMatchObject({ reservedChildTokens: 1000n, unresolvedAttempts: 1n })
      expect(await prisma.agentProviderAttempt.count({ where: { operationId: call.operation.id } })).toBe(1)
    })
  })

  it('settles once under both live leases and rolls child tokens into parent without a second debit', async () => {
    await fixture(async f => {
      const grant = await admitChildExecution(f.lease, f.input)
      const child = await acquireRunLease({ userId: f.userId, runId: grant.childRunId, ownerId: 'child', claimId: randomUUID() })
      const call = await provider(f, child)
      await recordProviderUsage({ ...call.identity, revision: 1, usage: { source: 'reported', promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, cacheMissTokens: 10 } })
      await recordProviderResult({ ...call.identity, outcome: 'succeeded', result: { content: '真实报告', reasoning: '', toolCalls: [], finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, promptCacheHitTokens: 0, promptCacheMissTokens: 10 } } })
      const settled = await Promise.all([settleProviderOperation({ ...call.identity, lease: child }), settleProviderOperation({ ...call.identity, lease: child })])
      expect(settled.every(result => result.status === 'settled')).toBe(true)
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(1)
      expect(await readTaskBudget(f.lease)).toMatchObject({ usedTokens: 15n, reservedChildTokens: 985n })
      const frame = await reduceExecutionReceipt(child, { expectedRevision: call.pending.revision, expectedHash: call.pending.snapshotHash, operationId: call.operation.id })
      await finalizeDurableTask(child, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash })
      expect(await readTaskBudget(f.lease)).toMatchObject({ usedTokens: 15n, reservedChildTokens: 0n })
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(1)
    })
  })

  it('reconciles one saved known result only after explicit parent resume and current child adoption', async () => {
    await fixture(async f => {
      const grant = await admitChildExecution(f.lease, f.input)
      const oldChild = await acquireRunLease({ userId: f.userId, runId: grant.childRunId, ownerId: 'old-child', claimId: randomUUID() })
      const call = await provider(f, oldChild)
      await pauseDurableTask(f.userId, f.runId)
      await recordProviderUsage({ ...call.identity, revision: 1, usage: { source: 'reported', promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, cacheMissTokens: 10 } })
      await recordProviderResult({ ...call.identity, outcome: 'succeeded', result: { content: '已核实的完整报告', reasoning: '', toolCalls: [], finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, promptCacheHitTokens: 0, promptCacheMissTokens: 10 } } })
      await expect(settleProviderOperation({ ...call.identity, lease: oldChild })).rejects.toMatchObject({ code: 'RUNTIME_NOT_ACTIVE' })
      const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'run.paused' } })
      const resumed = await resumeDurableTask({ userId: f.userId, runId: f.runId, pauseEventId: pause.id })
      const parent = await acquireRunLease({ userId: f.userId, runId: resumed.run.id, ownerId: 'reconciler-parent', claimId: randomUUID() })
      const current = await acquireRunLease({ userId: f.userId, runId: grant.childRunId, ownerId: 'reconciler-child', claimId: randomUUID() })
      await expect(settleProviderOperation({ ...call.identity, lease: oldChild })).rejects.toMatchObject({ code: 'RUNTIME_PARENT_LEASE_LOST' })
      expect((await Promise.all([settleProviderOperation({ ...call.identity, lease: current }), settleProviderOperation({ ...call.identity, lease: current })])).every(result => result.status === 'settled')).toBe(true)
      const original = await prisma.agentProviderAttempt.findUniqueOrThrow({ where: { id: call.attempt.id } })
      expect(original.ownerEpoch).toBe(oldChild.epoch)
      expect(current.epoch).not.toBe(oldChild.epoch)
      expect(await prisma.agentProviderAttempt.count({ where: { operationId: call.operation.id } })).toBe(1)
      expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId, idempotencyKey: `operation:${call.operation.id}` } })).toBe(1)
      const frame = await reduceExecutionReceipt(current, { expectedRevision: call.pending.revision, expectedHash: call.pending.snapshotHash, operationId: call.operation.id })
      await finalizeDurableTask(current, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash })
      expect(await readTaskBudget(parent)).toMatchObject({ usedTokens: 15n, reservedChildTokens: 0n })
    })
  })

  it('rejects an oversized frozen child request before the dispatch marker', async () => fixture(async f => {
    const grant = await admitChildExecution(f.lease, f.input)
    const child = await acquireRunLease({ userId: f.userId, runId: grant.childRunId, ownerId: 'child', claimId: randomUUID() })
    const state = await loadExecutionState(f.userId, child.runId)
    const request = { body: { model: 'fixture', messages: [{ role: 'user', content: '完整原请求' }], max_tokens: 5000 } }
    const prepared = await prepareModelCursorOperation(child, { expectedRevision: 0, expectedHash: state.frame.snapshotHash }, { key: 'exec:0', action: 'workspaceAgent', request, price })
    const attempt = await prepareProviderAttempt(child, { operationId: prepared.operation.id, attemptKey: '1', provider: 'fixture', model: 'fixture', request })
    await expect(markProviderDispatched(child, attempt.id)).rejects.toMatchObject({ code: 'RUNTIME_CHILD_BUDGET_EXHAUSTED' })
    expect((await prisma.agentProviderAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).dispatchedAt).toBeNull()
    expect(await readTaskBudget(f.lease)).toMatchObject({ reservedChildTokens: 1000n })
  }))

  it.each(['finite', 'selection'] as const)('enforces child target ceilings even after an owned chapter read (%s)', async target => fixture(async f => {
    const grant = await admitChildExecution(f.lease, { ...f.input, roleTools: '*' })
    const child = await acquireRunLease({ userId: f.userId, runId: grant.childRunId, ownerId: 'child', claimId: randomUUID() })
    const chapterId = target === 'finite' ? f.chapters[1].id : f.chapters[0].id
    let state = await loadExecutionState(f.userId, child.runId)
    await saveExecutionState(child, { expectedRevision: state.frame.revision, expectedHash: state.frame.snapshotHash, snapshot: { ...state.frame.state,
      messages: [...state.frame.state.messages, { role: 'assistant', content: null, toolCalls: [{ id: 'read-target', name: 'chapter_read', arguments: JSON.stringify({ chapterId }) }] }] } })
    await executeDurableToolStep(child, new AbortController().signal)
    state = await loadExecutionState(f.userId, child.runId)
    expect(state.frame.state.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'read-target' })
    const calls = target === 'finite' ? [{ name: 'chapter_write', args: { chapterId, content: '覆盖另一个作者自有章节' } }]
      : [{ name: 'chapter_write', args: { chapterId, content: '前缀被改选区后缀被改' } },
        { name: 'chapter_edit_range', args: { chapterId, start: 0, end: 2, newText: '修改前缀' } },
        { name: 'chapter_edit_range', args: { chapterId, start: 4, end: 6, newText: '修改后缀' } }]
    const indirect = [qualityAnalyzeTool, continuityValidateTool].flatMap(tool => [
      { name: tool.name, args: { chapterId }, tool }, { name: tool.name, args: { compilationId: 'saved-compilation' }, tool }])
    for (const [index, call] of [...calls, ...indirect].entries()) {
      state = await loadExecutionState(f.userId, child.runId)
      const frame = await saveExecutionState(child, { expectedRevision: state.frame.revision, expectedHash: state.frame.snapshotHash, snapshot: { ...state.frame.state,
        messages: [...state.frame.state.messages.slice(0, index > 0 ? -1 : undefined), { role: 'assistant', content: null,
          toolCalls: [{ id: `write-target-${index}`, name: call.name, arguments: JSON.stringify(call.args) }] }] } })
      const execute = 'tool' in call ? prepareToolCursorOperation(child, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash }, {
        key: `exec:${frame.state.nextOperationSequence}`, action: call.name, callId: `write-target-${index}`, targetId: child.taskRootId,
        // A nominal read capability cannot hide a tool which can auto-repair.
        effectDomain: 'read', effectiveArgs: call.args, operationInput: { callId: `write-target-${index}`, args: call.args }, normalize: raw => call.tool.parameters.parse(raw) })
        : executeDurableToolStep(child, new AbortController().signal)
      await expect(execute).rejects.toMatchObject({ code: target === 'finite' ? 'RUNTIME_CHILD_TARGET_NOT_AUTHORIZED' : 'RUNTIME_CHILD_SELECTION_READ_ONLY' })
      expect((await loadExecutionState(f.userId, child.runId)).frame.snapshotHash).toBe(frame.snapshotHash)
    }
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: chapterId } })).content).toBe('前缀选区后缀')
  }, false, 5000, target))

  it('admits an explicit chapter mutation inside the frozen finite target ceiling', async () => fixture(async f => {
    const grant = await admitChildExecution(f.lease, { ...f.input, roleTools: '*' })
    const child = await acquireRunLease({ userId: f.userId, runId: grant.childRunId, ownerId: 'finite-child', claimId: randomUUID() })
    const state = await loadExecutionState(f.userId, child.runId)
    const args = { chapterId: f.chapters[0].id, content: '只修改已授权章节' }
    const frame = await saveExecutionState(child, { expectedRevision: state.frame.revision, expectedHash: state.frame.snapshotHash, snapshot: { ...state.frame.state,
      messages: [...state.frame.state.messages, { role: 'assistant', content: null, toolCalls: [{ id: 'allowed-write', name: chapterWriteTool.name, arguments: JSON.stringify(args) }] }] } })
    const prepared = await prepareToolCursorOperation(child, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash }, {
      key: `exec:${frame.state.nextOperationSequence}`, action: chapterWriteTool.name, callId: 'allowed-write', targetId: f.chapters[0].id,
      effectDomain: 'chapter', effectiveArgs: args, operationInput: { callId: 'allowed-write', args }, normalize: raw => chapterWriteTool.parameters.parse(raw) })
    expect(prepared.operation.status).toBe('prepared')
    expect((await prisma.chapter.findUniqueOrThrow({ where: { id: f.chapters[0].id } })).content).toBe('前缀选区后缀')
  }, false, 5000, 'finite'))

  it('excludes inline executions from main/latest queries while retaining cancel discovery and spawned windows', async () => {
    await fixture(async f => {
      const grant = await admitChildExecution(f.lease, f.input)
      expect(await prisma.agentRun.findMany({ where: { sessionId: f.sessionId, ...MAIN_RUN_FILTER }, select: { id: true } })).toEqual([{ id: f.runId }])
      const controller = new AbortController()
      registerActiveRun(grant.childRunId, { userId: f.userId, sessionId: f.sessionId, controller, internalChild: true })
      try {
        expect(hasActiveRunInSession(f.sessionId)).toBe(false)
        expect(getActiveRunIdBySession(f.sessionId)).toBeNull()
        expect(stopActiveRunsInSession(f.sessionId)).toBe(1)
        expect(controller.signal.aborted).toBe(true)
      } finally { deregisterActiveRun(grant.childRunId) }
      const events = await publishDurableEvents(f.userId, f.runId)
      expect(events.some(event => event.type === 'subagent.progress')).toBe(true)
      expect(events.some(event => event.type === 'run.finished')).toBe(false)
    })
    await fixture(async f => {
      const grant = await admitChildExecution(f.lease, f.input)
      expect(await prisma.agentRun.findMany({ where: { userId: f.userId, ...MAIN_RUN_FILTER }, select: { id: true } })).toHaveLength(2)
      expect((await publishDurableEvents(f.userId, f.runId)).filter(event => event.type === 'task.spawned')).toHaveLength(1)
      expect(grant.kind).toBe('spawned')
    }, true)
  })

  it('intersects ask/deny and protected target ceilings without granting configuration or recursion', async () => {
    await fixture(async f => {
      const configuration = f.input.configuration
      const requested = { ...configuration, toolAuthority: configuration.toolAuthority.map(item => ({ ...item, permission: 'allow' as const })), protectedChapterIds: [] }
      const ceiling = { ...configuration, protectedChapterIds: ['protected'], toolAuthority: configuration.toolAuthority.map(item => ({ ...item, permission: 'ask' as const })) }
      const intersected = intersectChildConfiguration(ceiling, requested, '*')
      expect(intersected.toolAuthority).toEqual([{ name: 'chapter_read', permission: 'ask', alwaysConfirm: false, dangerous: false }])
      expect(intersected.protectedChapterIds).toEqual(['protected'])
      expect(intersected.tools.map(item => item.function.name)).toEqual(['chapter_read'])
    })
  })

  it('resumes a paused parent with the same child identities and immutable admission budget', async () => {
    await fixture(async f => {
      const grant = await admitChildExecution(f.lease, f.input)
      await pauseDurableTask(f.userId, f.runId)
      const pause = await prisma.agentExecutionOutbox.findFirstOrThrow({ where: { taskRootId: f.rootId, type: 'run.paused' } })
      const resumed = await resumeDurableTask({ userId: f.userId, runId: f.runId, pauseEventId: pause.id })
      const nextParent = await acquireRunLease({ userId: f.userId, runId: resumed.run.id, ownerId: 'resumed', claimId: randomUUID() })
      const adopted = await prisma.agentChildExecutionGrant.findUniqueOrThrow({ where: { id: grant.id } })
      expect(adopted).toMatchObject({ childRunId: grant.childRunId, admissionRunId: f.runId, admissionEpoch: grant.admissionEpoch,
        currentParentRunId: resumed.run.id, generation: nextParent.epoch, status: 'admitted', tokenCeiling: 1000 })
      expect(await acquireRunLease({ userId: f.userId, runId: grant.childRunId, ownerId: 'resumed-child', claimId: randomUUID() })).toMatchObject({ parent: { runId: resumed.run.id, epoch: nextParent.epoch } })
    })
  })
})
