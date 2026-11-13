import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ run: vi.fn(), model: vi.fn(), runtime: vi.fn(), context: vi.fn(), transaction: vi.fn(), lease: vi.fn(), catalog: vi.fn() }))
vi.mock('../../api/lib/prisma.js', () => ({
  prisma: { agentRun: { findFirst: mocks.run }, agentGoalExecution: { findUnique: vi.fn(async () => null) },
    agentExecutionOutbox: { findFirst: vi.fn(async () => null) },
    agentMessage: { findFirst: vi.fn(async () => ({ id: 'original-message', parts: [{ type: 'text', text: '原始排队请求' }] })) },
    aiModelConfig: { findFirst: mocks.catalog, findUnique: mocks.model }, $transaction: mocks.transaction },
  DataAccessError: class extends Error { constructor(public status: number, public code: string, message: string) { super(message) } },
}))
vi.mock('../../api/lib/credits.js', () => ({ getModelTierRuntime: mocks.runtime, assertCreditAccess: vi.fn() }))
vi.mock('../../api/lib/agent/context.js', () => ({ assembleContext: mocks.context, insertSubagentCatalog: vi.fn() }))
vi.mock('../../api/lib/agent/runtime-lease.js', async original => ({ ...await original<object>(), withRunLease: mocks.lease }))
import { initializeExecutionState } from '../../api/lib/agent/runtime-state.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { getActiveRun } from '../../api/lib/agent/active-runs.js'
import { executePersistedLoopRun, initializePersistedLoopRun } from '../../api/lib/agent/run-service.js'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.catalog.mockResolvedValue({ archivedAt: null })
  mocks.run.mockResolvedValue({ id: 'queued-run', userId: 'owner', sessionId: 'session', novelId: 'novel', chapterId: null,
    mode: 'act', status: 'queued', runtimeProtocolVersion: 0, taskRootId: null,
    startRequest: { novelId: 'novel', sessionId: 'session', prompt: '原始排队请求', mode: 'build' },
    modelTier: 'speed', modelConfigId: 'model-A', modelConfigRevision: 1, customModelId: null, reasoningEffort: 'low',
    modelPriceSnapshot: { version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 } })
})
it('rejects queued revision M after an admin edit to N before resolving credentials, assembling context or initializing state', async () => {
  mocks.model.mockResolvedValue({ id: 'model-A', ownerUserId: null, tier: 'speed', revision: 2, enabled: true, archivedAt: null })
  await expect(initializePersistedLoopRun('owner', 'queued-run')).rejects.toMatchObject({ status: 409, code: 'MODEL_SELECTION_REQUIRED' })
  expect(mocks.runtime).not.toHaveBeenCalled()
  expect(mocks.context).not.toHaveBeenCalled()
  expect(mocks.transaction).not.toHaveBeenCalled()
})
it('rejects a runtime edited between the initial catalog check and resolution instead of mixing M price with N identity', async () => {
  mocks.model.mockResolvedValue({ id: 'model-A', ownerUserId: null, tier: 'speed', revision: 1, enabled: true, archivedAt: null })
  mocks.runtime.mockResolvedValue({ tier: 'speed', modelConfigId: 'model-A', modelConfigRevision: 2 })
  await expect(initializePersistedLoopRun('owner', 'queued-run')).rejects.toMatchObject({ status: 409, code: 'MODEL_SELECTION_REQUIRED' })
  expect(mocks.runtime).toHaveBeenCalledOnce()
  expect(mocks.context).not.toHaveBeenCalled()
  expect(mocks.transaction).not.toHaveBeenCalled()
})

it('rechecks revision under the shared catalog lock at first state insertion after context assembly', async () => {
  const spec = { scope: {} }, request = []
  const root = { id: 'root', specSnapshot: spec, requestSnapshot: request, inputHash: runtimeJson({ spec, request }).hash }
  const create = vi.fn(), lock = vi.fn(async () => [])
  const tx = { agentTaskRoot: { findUniqueOrThrow: vi.fn(async () => root) }, agentExecutionState: { findUnique: vi.fn(async () => null), create },
    aiModelConfig: { findUnique: vi.fn(async () => ({ id: 'model-A', revision: 2, enabled: true, archivedAt: null })) }, $queryRaw: lock }
  mocks.lease.mockImplementation(async (_lease, work) => work(tx))
  await expect(initializeExecutionState({ userId: 'owner', runId: 'run', taskRootId: 'root', ownerId: 'worker', claimId: 'claim', epoch: 1n }, {
    admittedModel: { modelConfigId: 'model-A', modelConfigRevision: 1 },
    configuration: { version: 1, mode: 'build', agentType: 'orchestrator', creativeFreedom: 'balanced', qualityMode: 'premium',
      model: { tier: 'speed', provider: 'fixture', modelName: 'model-A', customModelId: null, reasoningEffort: 'low', routeRevision: 'a'.repeat(64) },
      tools: [], toolAuthority: [], protectedChapterIds: [], pinnedSkillVersions: [] },
    snapshot: { version: 1, turn: 0, nextOperationSequence: 0, checkpointIndex: 0, phase: 'idle', pendingOperationId: null, messages: [{ role: 'user', content: '原始排队请求' }], successfulToolSignatures: [] },
  })).rejects.toMatchObject({ code: 'MODEL_SELECTION_REQUIRED' })
  expect(lock).toHaveBeenCalledOnce()
  expect(create).not.toHaveBeenCalled()
})

it('reserves the pending executor before async archive admission and rejects duplicate dispatch without starting a lease', async () => {
  const original = await mocks.run()
  mocks.run.mockResolvedValue({ ...original, runtimeProtocolVersion: 1, taskRootId: 'root' })
  let release!: () => void, entered!: () => void
  let activeAtCatalog: ReturnType<typeof getActiveRun>
  const gate = new Promise<void>(resolve => { release = resolve })
  const admissionStarted = new Promise<void>(resolve => { entered = resolve })
  mocks.catalog.mockImplementation(async () => { activeAtCatalog = getActiveRun('queued-run'); entered(); await gate; return { archivedAt: new Date() } })
  const pending = executePersistedLoopRun('owner', 'queued-run')
  const rejected = expect(pending).rejects.toMatchObject({ code: 'MODEL_SELECTION_REQUIRED' })
  try {
    await admissionStarted
    // Observe the exact first async catalog boundary, without a timer or retry.
    expect(activeAtCatalog).toBeDefined()
    expect(getActiveRun('queued-run')).toBeDefined()
    await expect(executePersistedLoopRun('owner', 'queued-run')).rejects.toMatchObject({ code: 'RUN_IN_PROGRESS' })
    expect(mocks.catalog).toHaveBeenCalledOnce()
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.runtime).not.toHaveBeenCalled()
  } finally {
    release()
    await rejected
  }
  expect(getActiveRun('queued-run')).toBeUndefined()
})
