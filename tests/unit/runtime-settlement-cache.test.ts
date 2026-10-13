import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ attempt: null as unknown, usage: null as unknown,
  ledger: null as { metadata: Record<string, unknown> } | null, event: null as unknown,
  consume: vi.fn(), update: vi.fn(), create: vi.fn() }))
vi.mock('../../api/lib/credits.js', () => ({ consumeCreditsInTransaction: mocks.consume }))
vi.mock('../../api/lib/agent/runtime-parent-contention.js', () => ({ readAttemptContentionScope: vi.fn(async () => null) }))
vi.mock('../../api/lib/agent/runtime-operations.js', () => ({ lockOwnedAttempt: vi.fn(async () => mocks.attempt),
  prepareOperation: vi.fn(), prepareOperationInTransaction: vi.fn() }))
vi.mock('../../api/lib/agent/runtime-lease.js', () => ({ withRunLeaseInTransaction: vi.fn() }))
vi.mock('../../api/lib/agent/runtime-common.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../api/lib/agent/runtime-common.js')>()
  return { ...original, runtimeTransaction: async (work: (tx: unknown) => Promise<unknown>) => work({
    agentProviderAttempt: { findFirst: async () => ({ runId: 'run' }) }, agentChildExecutionGrant: { findUnique: async () => null },
    agentProviderUsageReceipt: { findUnique: async () => mocks.usage, update: mocks.update },
    agentExecutionOutbox: { findUnique: async () => mocks.event, create: mocks.create },
    creditLedgerEntry: { findUnique: async () => mocks.ledger },
  }) }
})

import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { settleProviderOperation, type DurableTokenPrice } from '../../api/lib/agent/runtime-settlement.js'

const identity = { userId: 'author', attemptId: 'attempt', requestHash: 'request' }
const v2: DurableTokenPrice = { version: 'credits-v2-itemized', modelTier: 'standard', multiplierBps: 12000,
  rateCardId: 'frozen-card', rates: { inputNano: 100000, cacheNano: 20000, outputNano: 1000000 } }
function fixture(price: DurableTokenPrice = v2, hit: number | null = null) {
  const measurement = { source: 'reported', promptTokens: 10000, completionTokens: 1000, cacheHitTokens: hit, cacheMissTokens: hit === null ? null : 10000 - hit }
  const snapshot = { input: { billing: price } }, result = { content: 'complete response' }
  const usage = { ...measurement, attemptId: 'attempt', revision: 1, settlementStatus: 'pending', observationHash: runtimeJson(measurement).hash }
  mocks.usage = usage
  mocks.attempt = { id: 'attempt', runId: 'run', requestHash: 'request', status: 'succeeded', result, resultHash: runtimeJson(result).hash,
    operation: { id: 'operation', taskRootId: 'root', status: 'succeeded', inputSnapshot: snapshot, inputHash: runtimeJson(snapshot).hash } }
  mocks.update.mockImplementation(async () => { usage.settlementStatus = 'settled'; return usage })
  mocks.create.mockImplementation(async ({ data }) => { mocks.event = data; return data })
  mocks.consume.mockImplementation(async (_tx, request) => {
    mocks.ledger ??= { metadata: request.metadata }
    return { chargedMilli: request.amountMilli, remainingMilli: 10000 - request.amountMilli, exhausted: false }
  })
  return usage
}
beforeEach(() => { vi.clearAllMocks(); mocks.ledger = null; mocks.event = null })

it('settles reported totals with absent cache details and replays the same discounted billing identity', async () => {
  const usage = fixture()
  for (let index = 0; index < 2; index++) expect(await settleProviderOperation(identity)).toMatchObject({ status: 'settled', amountMilli: 1200, chargedMilli: 1200 })
  expect(mocks.consume).toHaveBeenCalledTimes(2)
  expect(mocks.consume.mock.calls[0][1]).toEqual(mocks.consume.mock.calls[1][1])
  expect(mocks.consume.mock.calls[0][1]).toMatchObject({ idempotencyKey: 'operation:operation', multiplierBps: 12000,
    metadata: { rates: v2.rates, cacheHitTokens: null, cacheMissTokens: null, cachePricingPolicy: 'unknown-cache-discount-2026-09-09', platformAbsorbsDifference: true } })
  expect(usage.cacheHitTokens).toBeNull(); expect(usage.cacheMissTokens).toBeNull()
  expect(mocks.update).toHaveBeenCalledOnce(); expect(mocks.create).toHaveBeenCalledOnce()
})
it('keeps explicit zero cache hits as full-input billing rather than a missing-cache concession', async () => {
  fixture(v2, 0)
  expect(await settleProviderOperation(identity)).toMatchObject({ status: 'settled', amountMilli: 2000 })
  expect(mocks.consume.mock.calls[0][1].metadata.cacheHitTokens).toBe(0)
  expect(mocks.consume.mock.calls[0][1].metadata.cachePricingPolicy).toBeUndefined()
})
it('preserves V1 multiplier billing without requiring cache details', async () => {
  fixture({ version: 'credits-v1-exact', modelTier: 'standard', multiplierBps: 12000 })
  expect(await settleProviderOperation(identity)).toMatchObject({ status: 'settled', amountMilli: 1200 })
  expect(mocks.consume.mock.calls[0][1].metadata.cachePricingPolicy).toBeUndefined()
})
it('replays historical equal-rate settlement without changing its old ledger metadata', async () => {
  const usage = fixture({ ...v2, rates: { ...v2.rates, cacheNano: 100000 } })
  usage.settlementStatus = 'settled'
  mocks.ledger = { metadata: { pricingVersion: v2.version } }
  mocks.event = { taskRootId: 'root', operationId: 'operation', type: 'credit.settled', payload: { operationId: 'operation', attemptId: 'attempt',
    pricingVersion: v2.version, usageRevision: 1, amountMilli: 2000, chargedMilli: 2000, shortfallMilli: 0 } }
  expect(await settleProviderOperation(identity)).toMatchObject({ status: 'settled', amountMilli: 2000 })
  expect(mocks.consume.mock.calls[0][1].metadata.cachePricingPolicy).toBeUndefined()
  expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled()
})
it.each(['input', 'output', 'unknown'] as const)('does not turn missing %s token evidence into a settled zero bill', async missing => {
  const usage = fixture()
  if (missing === 'input') (usage as { promptTokens: number | null }).promptTokens = null
  else if (missing === 'output') (usage as { completionTokens: number | null }).completionTokens = null
  else usage.source = 'unknown'
  usage.observationHash = runtimeJson({ source: usage.source, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
    cacheHitTokens: usage.cacheHitTokens, cacheMissTokens: usage.cacheMissTokens }).hash
  expect(await settleProviderOperation(identity)).toEqual({ status: 'pending', reason: 'usage_not_confirmed' })
  expect(mocks.consume).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled()
})
it('rejects inconsistent prior money state instead of charging again', async () => {
  fixture(); mocks.ledger = { metadata: {} }
  await expect(settleProviderOperation(identity)).rejects.toMatchObject({ code: 'RUNTIME_RECEIPT_INVALID' })
  expect(mocks.consume).not.toHaveBeenCalled()
})
