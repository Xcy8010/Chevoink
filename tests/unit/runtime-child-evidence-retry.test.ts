import { Prisma } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), attempt: vi.fn(), grant: vi.fn(), delay: vi.fn() }))
vi.mock('node:timers/promises', () => ({ setTimeout: mocks.delay }))
vi.mock('../../api/lib/prisma.js', () => ({
  prisma: { $transaction: mocks.transaction, agentProviderAttempt: { findFirst: mocks.attempt }, agentChildExecutionGrant: { findFirst: mocks.grant } },
  DataAccessError: class extends Error { constructor(public status: number, public code: string, message: string) { super(message) } },
}))
import { recordProviderResult, recordProviderUsage } from '../../api/lib/agent/runtime-operations.js'
const conflict = new Prisma.PrismaClientKnownRequestError('fixture DB conflict', { code: 'P2034', clientVersion: 'test' })
const writers = {
  result: () => recordProviderResult({ userId: 'author', attemptId: 'attempt', requestHash: 'original', outcome: 'succeeded', result: { content: 'known' } }),
  usage: () => recordProviderUsage({ userId: 'author', attemptId: 'attempt', requestHash: 'original', revision: 1,
    usage: { source: 'reported', promptTokens: 10, completionTokens: 5, cacheHitTokens: null, cacheMissTokens: null } }),
}
beforeEach(() => { vi.restoreAllMocks(); mocks.transaction.mockReset(); mocks.attempt.mockReset().mockResolvedValue({ runId: 'child' }); mocks.grant.mockReset(); mocks.delay.mockReset().mockResolvedValue(undefined) })

describe('persisted evidence contention selection', () => {
  it.each(['result', 'usage'] as const)('bounds %s evidence to three attempts even for a revoked canonical grant', async kind => {
    mocks.grant.mockResolvedValue({ parentRootId: 'root', childRunId: 'child', status: 'cancelled' })
    mocks.transaction.mockRejectedValue(conflict)
    await expect(writers[kind]()).rejects.toBe(conflict)
    expect(mocks.transaction).toHaveBeenCalledTimes(3)
    expect(mocks.delay).toHaveBeenCalledTimes(2)
    expect(mocks.delay.mock.calls.reduce((sum, call) => sum + Number(call[0]), 0)).toBeLessThanOrEqual(450)
    expect(mocks.attempt).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'attempt', operation: { taskRoot: { userId: 'author' } } } }))
  })
  it.each(['result', 'usage'] as const)('keeps ordinary main %s evidence retry timing unchanged', async kind => {
    mocks.grant.mockResolvedValue(null)
    mocks.transaction.mockRejectedValueOnce(conflict).mockResolvedValueOnce('stored')
    expect(await writers[kind]()).toBe('stored')
    expect(mocks.transaction).toHaveBeenCalledTimes(2)
    expect(mocks.delay).not.toHaveBeenCalled()
  })
  it.each(['result', 'usage'] as const)('never retries a %s identity or permission failure', async kind => {
    mocks.grant.mockResolvedValue({ parentRootId: 'root', childRunId: 'child' })
    const error = new Error('original identity rejected')
    mocks.transaction.mockRejectedValue(error)
    await expect(writers[kind]()).rejects.toBe(error)
    expect(mocks.transaction).toHaveBeenCalledOnce()
    expect(mocks.delay).not.toHaveBeenCalled()
  })
})
