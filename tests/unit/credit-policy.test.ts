import { Prisma } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ raw: vi.fn(), read: vi.fn(), upsert: vi.fn(), transaction: vi.fn() }))
vi.mock('../../api/lib/prisma.js', () => ({ DataAccessError: class extends Error {}, prisma: { $transaction: mocks.transaction } }))
import { lockCreditPolicy, creditTransaction } from '../../api/lib/credit-policy.js'
const tx = { $queryRaw: mocks.raw, creditSystemSetting: { findUniqueOrThrow: mocks.read, upsert: mocks.upsert } } as unknown as Prisma.TransactionClient
beforeEach(() => { vi.clearAllMocks(); mocks.raw.mockResolvedValue([{ id: 'global' }]); mocks.read.mockResolvedValue({ publicBetaEnabled: true }) })
describe('credit policy transaction boundary', () => {
  it('locks the actual connection before reading current policy and retains missing-singleton initialization', async () => {
    await lockCreditPolicy(tx)
    expect(mocks.raw.mock.calls[0][0].join('')).toContain('FOR SHARE')
    expect(mocks.raw.mock.invocationCallOrder[0]).toBeLessThan(mocks.read.mock.invocationCallOrder[0])
    expect(mocks.upsert).not.toHaveBeenCalled()
    mocks.raw.mockResolvedValueOnce([])
    await lockCreditPolicy(tx)
    expect(mocks.upsert).toHaveBeenCalledOnce()
  })
  it('refuses a global client masquerading as a transaction', async () => {
    await expect(lockCreditPolicy({ ...tx, $transaction: mocks.transaction } as unknown as Prisma.TransactionClient)).rejects.toThrow('transaction connection')
    expect(mocks.raw).not.toHaveBeenCalled()
  })
  it('propagates raw serialization as an abort and retries only the whole transaction', async () => {
    mocks.raw.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('serialization fixture', { code: 'P2010', clientVersion: '6.12.0', meta: { code: '40001' } }))
    mocks.transaction.mockImplementation(async (work: (connection: Prisma.TransactionClient) => unknown) => work(tx))
    await expect(creditTransaction(connection => lockCreditPolicy(connection))).resolves.toMatchObject({ publicBetaEnabled: true })
    expect(mocks.transaction).toHaveBeenCalledTimes(2)
    expect(mocks.read).toHaveBeenCalledOnce()
  })
  it('does not retry generic uniqueness or unrelated raw failures', async () => {
    for (const error of [new Prisma.PrismaClientKnownRequestError('unique fixture', { code: 'P2002', clientVersion: '6.12.0' }),
      new Prisma.PrismaClientKnownRequestError('raw fixture', { code: 'P2010', clientVersion: '6.12.0', meta: { code: '22001' } })]) {
      mocks.transaction.mockReset().mockRejectedValue(error)
      await expect(creditTransaction(async () => 1)).rejects.toBe(error)
      expect(mocks.transaction).toHaveBeenCalledOnce()
    }
  })
})
