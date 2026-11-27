import { describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ entries: vi.fn(), refund: vi.fn(), goal: vi.fn(), web: vi.fn() }))
vi.mock('../../api/lib/prisma.js', () => ({ prisma: {
  creditLedgerEntry: { findMany: mocks.entries, findUnique: mocks.refund },
  agentGoalUsage: { findUnique: mocks.goal }, webToolCall: { findUnique: mocks.web },
} }))
import { goalReceipt, readFixedFeeReceipts } from '../../api/lib/governance-fixed-receipts'

describe('independent fixed-fee ledger evidence', () => {
  const goal = { goalId: 'goal', runId: 'run', creditsMicros: 0n, reservedTokens: 9007199254740993n, status: 'known', goal: { userId: 'owner' } }
  it('keeps exact amounts and reservations, scopes the snapshot to its owner', () => {
    expect(goalReceipt('owner', goal)).toMatchObject({ creditsMicros: '0', reservedTokens: '9007199254740993' })
    expect(goalReceipt('other', goal)).toBeNull()
  })
  it('checks the original call, frozen fee, scoped goal record, and refund', async () => {
    const entry = { id: 'wallet', userId: 'owner', idempotencyKey: 'web-search:run:action', referenceId: 'run',
      kind: 'usage', sourceType: 'web_search', deltaMilli: -750, metadata: { webToolCallId: 'call', requestHash: 'original' }, refundIntent: { settledAt: new Date() } }
    mocks.entries.mockResolvedValue([entry])
    mocks.goal.mockResolvedValue(goal)
    mocks.refund.mockResolvedValue({ userId: 'owner', kind: 'refund', sourceType: 'web_search', deltaMilli: 750 })
    mocks.web.mockResolvedValue({ runId: 'run', kind: 'search', requestHash: 'original', amountMilli: 750 })
    expect((await readFixedFeeReceipts(1, 'owner')).items[0]).toMatchObject({ expectedMilli: 750, chargedMilli: 750, refundMilli: 750, goal: { creditsMicros: '0' } })
    mocks.web.mockResolvedValue({ runId: 'run', kind: 'search', requestHash: 'unrelated', amountMilli: 750 })
    mocks.refund.mockResolvedValue({ userId: 'other', kind: 'refund', sourceType: 'web_search', deltaMilli: 750 })
    expect((await readFixedFeeReceipts(1, 'owner')).items[0]).toMatchObject({ expectedMilli: null, refundMilli: null })
  })
})
