import { withGoalExecutionContext, type GoalExecutionContext } from '../../api/lib/agent/goal-context.js'
import { beforeEach, expect, it, vi } from 'vitest'
import { executeImageOperation } from '../../api/lib/image-operation.js'

const m = vi.hoisted(() => ({ operation: null as Record<string, unknown> | null, runtime: {} as Record<string, unknown>, rows: new Map<string, Record<string, unknown>>(), responses: new Map<string, unknown>(),
  dispatch: vi.fn(), resolve: vi.fn(), debit: vi.fn(), intent: vi.fn(), reconcile: vi.fn(), assets: vi.fn(), storage: vi.fn(), goalAdmission: vi.fn(), reserveGoal: vi.fn(), syncGoal: vi.fn(), goalFence: vi.fn(), logs: new Map<string, Record<string, unknown>>(), goalUsages: new Map<string, string>(), goalStopped: false, goalStopCode: 'GOAL_EXECUTION_FENCED', nextId: 0, tx: {} as Record<string, unknown> }))
vi.mock('../../api/lib/prisma.js', async original => ({ ...await original<object>(), prisma: new Proxy({}, { get: (_, property) => m.tx[String(property)] }) }))
vi.mock('../../api/lib/credit-policy.js', () => ({ creditTransaction: async (work: (tx: unknown) => Promise<unknown>) => work(m.tx) }))
vi.mock('../../api/lib/credits.js', () => ({ consumeCreditsInTransaction: (...args: unknown[]) => m.debit(...args), recordImageRefundIntentInTransaction: (...args: unknown[]) => m.intent(...args), reconcileCreditRefunds: (...args: unknown[]) => m.reconcile(...args) }))
vi.mock('../../api/lib/data-access.js', () => ({ createCoverAssetsInTransaction: (...args: unknown[]) => m.assets(...args), recoverCoverAssetStorageData: async (_user: string, id: string) => ({ id, imageUrl: 'https://owned.invalid/' + id, modelName: '图片生成' }) }))
vi.mock('../../api/lib/ai-service.js', async original => ({ ...await original<object>(), resolveCoverImageRuntime: (...args: unknown[]) => m.resolve(...args), requestCoverImages: (...args: unknown[]) => m.dispatch(...args) }))
vi.mock('../../api/lib/agent/goal-budget.js', async original => ({ ...await original<object>(), assertGoalProviderAdmission: (...args: unknown[]) => m.goalAdmission(...args), reserveGoalUsageInTransaction: (...args: unknown[]) => m.reserveGoal(...args), syncGoalLegacyUsage: (...args: unknown[]) => m.syncGoal(...args) }))
vi.mock('../../api/lib/agent/goal-fence.js', async original => ({ ...await original<object>(), assertGoalFence: (...args: unknown[]) => m.goalFence(...args) }))
vi.mock('../../api/lib/agent/provider-image-storage.js', async original => ({ ...await original<object>(), prepareImageResponseStorage: async () => undefined,
  readImageResponse: async (identity: { attemptId: string }) => m.responses.get(identity.attemptId) ?? null,
  storeImageResponse: (...args: unknown[]) => m.storage(...args) }))

const route = { provider: 'private-provider', modelName: 'private-model', baseUrl: 'https://image.invalid/generate', providerMode: 'real' }
const input = { operationId: 'fixed-operation', prompt: '书名与画面', size: '768x1024' as const, count: 1 }
const copy = <T,>(value: T): T => structuredClone(value)
beforeEach(async () => {
  vi.resetAllMocks(); m.operation = null; m.rows.clear(); m.responses.clear(); m.logs.clear(); m.goalUsages.clear(); m.goalStopped = false; m.goalStopCode = 'GOAL_EXECUTION_FENCED'
  m.runtime = { apiKey: 'never-persist-this-key', route }
  const { DataAccessError } = await import('../../api/lib/prisma.js')
  m.goalAdmission.mockImplementation(async (goal: unknown) => { if (goal && m.goalStopped) throw new DataAccessError(409, m.goalStopCode, 'Goal stopped') })
  m.goalFence.mockImplementation(async () => { if (m.goalStopped) throw new DataAccessError(409, 'GOAL_EXECUTION_FENCED', 'Goal stopped') })
  m.reserveGoal.mockImplementation(async (_tx: unknown, key: string) => {
    if (m.goalStopped) throw new DataAccessError(409, 'GOAL_EXECUTION_FENCED', 'Goal stopped')
    if ([...m.goalUsages.values()].includes('unknown')) throw new DataAccessError(409, 'GOAL_RECONCILIATION_REQUIRED', 'Unknown goal usage')
    m.goalUsages.set(key, 'reserved')
  })
  m.syncGoal.mockImplementation(async (id: string) => { const log = m.logs.get(id)!; m.goalUsages.set('legacy:' + id, log.billingStatus === 'provider_rejected' ? 'rejected' : log.billingStatus === 'observed' ? 'known' : 'unknown') })
  const { imageBlobSchema } = await import('../../api/lib/agent/provider-image-storage.js')
  m.tx = { $queryRaw: async () => [], imageOperation: {
    findUnique: async ({ where }: { where: { userId_operationId: { operationId: string } } }) => m.operation?.operationId === where.userId_operationId.operationId ? copy(m.operation) : null, findUniqueOrThrow: async () => { if (!m.operation) throw new Error('missing'); return copy(m.operation) },
    create: async ({ data }: { data: Record<string, unknown> }) => copy(m.operation = { id: '11111111-1111-4111-8111-111111111111', state: 'prepared', routeIndex: 0, result: null, ...data }),
    update: async ({ data }: { data: Record<string, unknown> }) => copy(m.operation = { ...m.operation!, ...data }),
  }, novel: { findFirst: async () => ({ id: 'novel' }) }, agentGoal: { findUniqueOrThrow: async () => ({ phase: 'running' }) }, aiUsageLog: { create: async ({ data }: { data: Record<string, unknown> }) => { m.logs.set(String(data.id), { ...data }); return data }, update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => { const log = m.logs.get(where.id)!; Object.assign(log, data); return log } }, creditLedgerEntry: { findUnique: async ({ where }: { where: { idempotencyKey: string } }) => m.rows.get(where.idempotencyKey) ?? null } }
  m.resolve.mockImplementation(async (frozen?: typeof route) => ({ ...m.runtime, route: frozen ?? route }))
  m.dispatch.mockResolvedValue({ status: 200, body: JSON.stringify({ data: [{ url: 'https://result.invalid/image.png' }] }) })
  m.storage.mockImplementation(async (identity: { attemptId: string }, status: number, body: string) => {
    const saved = { body, pointer: imageBlobSchema.parse({ storageKey: 'a'.repeat(64) + '.blob', sha256: 'b'.repeat(64), bytes: 100, httpStatus: status }) }
    m.responses.set(identity.attemptId, saved); return saved
  })
  m.debit.mockImplementation(async (_tx: unknown, value: { userId: string; idempotencyKey: string; amountMilli: number }) => {
    m.rows.set(value.idempotencyKey, { id: 'debit-' + value.idempotencyKey, userId: value.userId, kind: 'usage', deltaMilli: -value.amountMilli })
    return { chargedMilli: value.amountMilli }
  })
  m.intent.mockImplementation(async (_tx: unknown, userId: string, key: string) => { const original = m.rows.get(key)!; m.rows.set('pending:' + key, { userId, deltaMilli: -Number(original.deltaMilli), metadata: { originalEntryId: original.id } }) })
  m.reconcile.mockImplementation(async () => { for (const [key, value] of m.rows) if (key.startsWith('pending:')) m.rows.set('refund:' + key.slice(8), { ...value, kind: 'refund' }) })
  m.assets.mockResolvedValue([])
  // Use the production error class so classification follows the real boundary.
  m.dispatch.mockImplementation(async () => ({ status: 200, body: JSON.stringify({ data: [{ url: 'https://result.invalid/image.png' }] }) }))
})
it('persists the original admission and replays one paid request without keys or upstream names in the DTO', async () => {
  const first = await executeImageOperation('owner', input), second = await executeImageOperation('owner', input)
  expect(second).toEqual(first); expect(m.dispatch).toHaveBeenCalledOnce(); expect(m.debit).toHaveBeenCalledOnce()
  expect(m.resolve).toHaveBeenCalledTimes(2)
  expect(JSON.stringify(m.operation)).not.toContain('never-persist-this-key')
  expect(JSON.stringify(first)).not.toMatch(/private-provider|private-model|image_call/)
  await expect(executeImageOperation('owner', { ...input, prompt: 'different' })).rejects.toMatchObject({ code: 'IMAGE_OPERATION_CONFLICT' })
  expect(m.dispatch).toHaveBeenCalledOnce()
})
it('keeps an unknown dispatch unresolved and never redraws or dispatches on replay', async () => {
  m.dispatch.mockRejectedValue(new Error('connection lost'))
  await expect(executeImageOperation('owner', input)).rejects.toThrow('connection lost')
  expect(m.operation?.state).toBe('unknown')
  await expect(executeImageOperation('owner', input)).rejects.toMatchObject({ code: 'IMAGE_RECONCILIATION_REQUIRED' })
  expect(m.dispatch).toHaveBeenCalledOnce(); expect(m.resolve).toHaveBeenCalledTimes(2)
})
it('shares one original scheduled debit across the ordered known-failure fallback', async () => {
  m.runtime = { ...m.runtime, price: { tariff: 'image_call_scheduled_v2', amountMilli: 3000, baseAmountMilli: 6000, baseMultiplierBps: 10000, effectiveMultiplierBps: 5000, admittedAt: '2026-11-02T15:00:00.000Z', activity: { baseMultiplierBps: 10000, effectiveMultiplierBps: 5000, revision: 1, timezone: 'Asia/Shanghai', admittedAt: '2026-11-02T15:00:00.000Z', activityId: 'discount', activityName: '折扣' } },
    fallbackRuntimes: [{ apiKey: 'fallback-key', route: { ...route, routeId: '22222222-2222-4222-8222-222222222222', modelName: 'fallback-private', baseUrl: 'https://fallback.invalid/image' } }] }
  m.dispatch.mockResolvedValueOnce({ status: 500, body: '{}' }).mockImplementationOnce(async () => {
    expect([...m.rows.keys()].some(key => key.startsWith('refund:'))).toBe(false)
    return { status: 200, body: JSON.stringify({ data: [{ url: 'https://result.invalid/image.png' }] }) }
  })
  await executeImageOperation('owner', input)
  expect(m.debit.mock.calls.map(([, value]) => value.amountMilli)).toEqual([3000])
  expect(m.debit.mock.calls[0][1]).toMatchObject({ multiplierBps: 5000, metadata: { activity: { effectiveMultiplierBps: 5000, activityId: 'discount' } } })
  expect([...m.rows.values()].filter(row => row.kind === 'refund')).toEqual([])
})
it('refunds the one original amount once when the frozen sequence exhausts', async () => {
  m.runtime = { ...m.runtime, fallbackRuntimes: [{ apiKey: 'fallback-key', route: { ...route, routeId: '22222222-2222-4222-8222-222222222222' } }] }
  m.dispatch.mockResolvedValue({ status: 500, body: '{}' })
  await expect(executeImageOperation('owner', input)).rejects.toMatchObject({ code: 'AI_PROVIDER_ERROR' })
  expect(m.operation?.state).toBe('failed'); expect(m.dispatch).toHaveBeenCalledTimes(2)
  expect(m.debit).toHaveBeenCalledOnce(); expect(m.intent).toHaveBeenCalledOnce()
  expect([...m.rows.values()].filter(row => row.kind === 'refund').map(row => row.deltaMilli)).toEqual([6000])
})
it('preserves storage-failure unknown state without generating a fallback', async () => {
  m.storage.mockRejectedValue(new Error('disk failure'))
  await expect(executeImageOperation('owner', input)).rejects.toThrow('disk failure')
  expect(m.operation?.state).toBe('unknown')
  await expect(executeImageOperation('owner', input)).rejects.toMatchObject({ code: 'IMAGE_RECONCILIATION_REQUIRED' })
  expect(m.dispatch).toHaveBeenCalledOnce()
})
it('rejects concurrent redelivery during the one dispatched provider request', async () => {
  let complete: ((value: { status: number; body: string }) => void) | undefined
  m.dispatch.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
  const first = executeImageOperation('owner', input)
  await vi.waitFor(() => expect(m.dispatch).toHaveBeenCalledOnce())
  await expect(executeImageOperation('owner', input)).rejects.toMatchObject({ code: 'IMAGE_RECONCILIATION_REQUIRED' })
  complete!({ status: 200, body: JSON.stringify({ data: [{ url: 'https://result.invalid/image.png' }] }) })
  await first
  expect(m.dispatch).toHaveBeenCalledOnce(); expect(m.debit).toHaveBeenCalledOnce()
})
it('fences a cancelled admission so a fresh HTTP signal cannot resume its fallback', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(executeImageOperation('owner', input, controller.signal)).rejects.toBeDefined()
  expect(m.operation?.state).toBe('failed')
  await expect(executeImageOperation('owner', input)).rejects.toMatchObject({ code: 'IMAGE_CANCELLED' })
  expect(m.dispatch).not.toHaveBeenCalled(); expect(m.debit).not.toHaveBeenCalled()
})
it('rejects an altered frozen route before recovery without drawing or dispatching again', async () => {
  m.dispatch.mockRejectedValueOnce(new Error('transport unknown'))
  await expect(executeImageOperation('owner', input)).rejects.toThrow('transport unknown')
  const envelope = m.operation!.inputSnapshot as { work: { routes: Array<{ modelName: string }> } }
  envelope.work.routes[0].modelName = 'changed-private-model'
  await expect(executeImageOperation('owner', input)).rejects.toMatchObject({ code: 'IMAGE_RECONCILIATION_REQUIRED' })
  expect(m.dispatch).toHaveBeenCalledOnce(); expect(m.resolve).toHaveBeenCalledTimes(2)
})
const goal: GoalExecutionContext = { goalId: 'goal', revision: 1, epoch: 2n, userId: 'owner', novelId: 'novel', sessionId: 'session', runId: 'original-run' }
it.each([408, 504])('keeps real HTTP %s parser classification unknown, including sealed response replay', async status => {
  m.runtime = { ...m.runtime, fallbackRuntimes: [{ apiKey: 'fallback-key', route: { ...route, routeId: '22222222-2222-4222-8222-222222222222' } }] }
  m.dispatch.mockResolvedValueOnce({ status, body: JSON.stringify({ error: { message: 'private upstream timeout' } }) })
  await expect(executeImageOperation('owner', input)).rejects.toMatchObject({ code: 'IMAGE_RECONCILIATION_REQUIRED' })
  expect(m.operation).toMatchObject({ state: 'unknown', routeIndex: 0, errorCode: 'AI_PROVIDER_TIMEOUT', result: { httpStatus: status } })
  expect([...m.logs.values()][0]).toMatchObject({ billingStatus: 'pending_usage', usageSource: 'unknown', requestTokens: null, responseTokens: null })
  expect(m.intent).toHaveBeenCalledWith(m.tx, 'owner', expect.any(String), { outcome: 'unknown', deliveredImages: 0 })
  await expect(executeImageOperation('owner', input)).rejects.toMatchObject({ code: 'IMAGE_RECONCILIATION_REQUIRED' })
  expect(m.operation?.state).toBe('unknown')
  expect(m.dispatch).toHaveBeenCalledOnce(); expect(m.debit).toHaveBeenCalledOnce()
  expect([...m.rows.values()].filter(row => row.kind === 'refund')).toHaveLength(1)
  expect(new Set(m.intent.mock.calls.map(([, , key]) => key)).size).toBe(1)
})
it('retains original goal run identity and unknown usage that blocks the next independent provider operation', async () => {
  m.dispatch.mockRejectedValueOnce(new Error('transport unknown'))
  const request = { ...input, novelId: goal.novelId }
  await expect(withGoalExecutionContext(goal, () => executeImageOperation('owner', request))).rejects.toThrow('transport unknown')
  const log = [...m.logs.values()][0]
  expect(log).toMatchObject({ agentRunId: goal.runId, usageSource: 'unknown', billingStatus: 'pending_usage', creditChargeMilli: 0 })
  expect(m.goalUsages.get('legacy:' + log.id)).toBe('unknown')
  await expect(withGoalExecutionContext(goal, () => executeImageOperation('owner', { ...request, operationId: 'next-independent-image' }))).rejects.toMatchObject({ code: 'GOAL_RECONCILIATION_REQUIRED' })
  expect(m.dispatch).toHaveBeenCalledOnce(); expect(m.debit).toHaveBeenCalledOnce()
})
it.each(['GOAL_EXECUTION_FENCED', 'GOAL_BUDGET_EXHAUSTED'])('blocks fallback after known rejection when the original goal is denied by %s', async code => {
  m.runtime = { ...m.runtime, fallbackRuntimes: [{ apiKey: 'fallback-key', route: { ...route, routeId: '22222222-2222-4222-8222-222222222222' } }] }
  m.dispatch.mockImplementationOnce(async () => { m.goalStopped = true; m.goalStopCode = code; return { status: 503, body: '{}' } })
  await expect(withGoalExecutionContext(goal, () => executeImageOperation('owner', { ...input, novelId: goal.novelId }))).rejects.toMatchObject({ code })
  expect(m.dispatch).toHaveBeenCalledOnce(); expect(m.debit).toHaveBeenCalledOnce()
  expect(m.goalUsages.values().next().value).toBe('rejected')
  expect(m.operation).toMatchObject({ state: 'failed', errorCode: code })
  expect(m.intent).toHaveBeenCalledWith(m.tx, 'owner', expect.any(String), { outcome: 'rejected', deliveredImages: 0 })
})
