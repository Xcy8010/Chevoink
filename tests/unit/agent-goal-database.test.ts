import type { PrismaClient } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  withGoalExecutionContext,
  withGoalEffects,
  withoutGoalEffects,
  type GoalExecutionContext,
} from '../../api/lib/agent/goal-context.js'

const mocks = vi.hoisted(() => ({
  assertGoalFence: vi.fn(),
}))

vi.mock('../../api/lib/agent/goal-fence.js', () => ({
  assertGoalFence: mocks.assertGoalFence,
}))

const { withGoalDatabaseFences } = await import('../../api/lib/agent/goal-database.js')

type Delegate = Record<string, ReturnType<typeof vi.fn>>

interface FakeDatabase {
  raw: Record<string, unknown>
  tx: Record<string, unknown>
  transaction: ReturnType<typeof vi.fn>
}

function delegate() {
  return {
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  } satisfies Delegate
}

function fakeDatabase(): FakeDatabase {
  const rawUser = delegate()
  const txUser = delegate()
  const tx = { user: txUser, $queryRaw: vi.fn() }
  const transaction = vi.fn(async (input: unknown) => {
    if (typeof input === 'function') return input(tx)
    return Promise.all(input as Promise<unknown>[])
  })
  const raw = { user: rawUser, $transaction: transaction, $queryRaw: vi.fn() }
  return { raw, tx, transaction }
}

const context: GoalExecutionContext = {
  goalId: 'goal-1',
  revision: 3,
  epoch: 1n,
  userId: 'user-1',
  novelId: 'novel-1',
  sessionId: 'session-1',
  runId: 'run-1',
}

function inGoal<T>(work: () => T) {
  return withGoalExecutionContext(context, () => withGoalEffects(work))
}

describe('withGoalDatabaseFences', () => {
  beforeEach(() => {
    mocks.assertGoalFence.mockReset()
  })

  it('keeps ordinary Prisma model calls and transactions unchanged outside a goal effect scope', async () => {
    const database = fakeDatabase()
    database.raw.user.update.mockResolvedValue('ordinary-write')
    const ordinaryTransaction = Promise.resolve('ordinary-transaction')
    const fenced = withGoalDatabaseFences(database.raw as unknown as PrismaClient) as unknown as {
      user: Delegate
      $transaction: (input: unknown, options?: object) => Promise<unknown>
    }

    await expect(fenced.user.update({ where: { id: 'u-1' } })).resolves.toBe('ordinary-write')
    await expect(fenced.$transaction([ordinaryTransaction])).resolves.toEqual(['ordinary-transaction'])

    expect(database.raw.user.update).toHaveBeenCalledTimes(1)
    expect(database.transaction).toHaveBeenCalledWith([ordinaryTransaction], undefined)
    expect(mocks.assertGoalFence).not.toHaveBeenCalled()
  })

  it('preserves transaction instrumentation and captured methods without recursion or losing goal fences', async () => {
    const database = fakeDatabase()
    const fenced = withGoalDatabaseFences(database.raw as unknown as PrismaClient)
    const transact = fenced.$transaction.bind(fenced)
    // Vitest 4 returns the native vi.fn() double unchanged from vi.spyOn, so the
    // outside instrumentation wrapper is installed explicitly around the captured method.
    database.raw.$transaction = vi.fn((work: (tx: unknown) => Promise<unknown>) =>
      transact(work).then(() => { throw new Error('lost commit acknowledgement') }))

    await expect(fenced.$transaction(async () => 'committed')).rejects.toThrow('lost commit acknowledgement')
    expect(database.transaction).toHaveBeenCalledTimes(1)
    database.raw.$transaction = database.transaction
    fenced.$transaction = transact
    await expect(fenced.$transaction(async () => 'restored')).resolves.toBe('restored')
    expect(database.transaction).toHaveBeenCalledTimes(2)

    mocks.assertGoalFence.mockRejectedValueOnce(new Error('goal fenced'))
    await expect(inGoal(() => fenced.$transaction(async () => 'late-write'))).rejects.toThrow('goal fenced')
    expect(mocks.assertGoalFence).toHaveBeenCalledTimes(1)
  })

  it('defers scoped writes until awaited, then fences and executes them in one transaction', async () => {
    const database = fakeDatabase()
    const order: string[] = []
    mocks.assertGoalFence.mockImplementation(async () => { order.push('fence') })
    database.tx.user.update.mockImplementation(async () => { order.push('write'); return 'tx-write' })
    const fenced = withGoalDatabaseFences(database.raw as unknown as PrismaClient) as unknown as { user: Delegate }

    const pending = inGoal(() => fenced.user.update({ where: { id: 'u-1' }, data: { name: 'new' } }))
    expect(database.raw.user.update).not.toHaveBeenCalled()
    expect(database.tx.user.update).not.toHaveBeenCalled()

    await expect(pending).resolves.toBe('tx-write')
    expect(order).toEqual(['fence', 'write'])
    expect(database.transaction).toHaveBeenCalledTimes(1)
    expect(mocks.assertGoalFence).toHaveBeenCalledWith(database.tx, context)
  })

  it('preserves array transaction ordering and atomicity for deferred scoped reads and writes', async () => {
    const database = fakeDatabase()
    const order: string[] = []
    mocks.assertGoalFence.mockImplementation(async () => { order.push('fence') })
    database.tx.user.findMany.mockImplementation(async () => { order.push('read'); return ['row'] })
    database.tx.user.update.mockImplementation(async () => { order.push('write'); return 'updated' })
    const fenced = withGoalDatabaseFences(database.raw as unknown as PrismaClient) as unknown as {
      user: Delegate
      $transaction: (input: unknown[]) => Promise<unknown[]>
    }

    const result = await inGoal(async () => {
      const read = fenced.user.findMany({ where: { id: 'u-1' } })
      const write = fenced.user.update({ where: { id: 'u-1' }, data: { name: 'new' } })
      expect(database.tx.user.findMany).not.toHaveBeenCalled()
      expect(database.tx.user.update).not.toHaveBeenCalled()
      return fenced.$transaction([read, write])
    })

    expect(result).toEqual([['row'], 'updated'])
    expect(order).toEqual(['fence', 'read', 'write'])
    expect(database.transaction).toHaveBeenCalledTimes(1)
  })

  it('reuses the active transaction for nested helpers and does not open a nested transaction', async () => {
    const database = fakeDatabase()
    mocks.assertGoalFence.mockResolvedValue(undefined)
    database.tx.user.update.mockResolvedValue('nested-write')
    const fenced = withGoalDatabaseFences(database.raw as unknown as PrismaClient) as unknown as {
      user: Delegate
      $transaction: (input: (tx: unknown) => Promise<unknown>) => Promise<unknown>
    }

    await inGoal(() => fenced.$transaction(async () => {
      const helper = async () => fenced.user.update({ where: { id: 'u-1' }, data: { name: 'nested' } })
      await expect(helper()).resolves.toBe('nested-write')
    }))

    expect(database.transaction).toHaveBeenCalledTimes(1)
    expect(database.tx.user.update).toHaveBeenCalledTimes(1)
    expect(mocks.assertGoalFence).toHaveBeenCalledTimes(1)
  })

  it('rejects foreign or already executed promises from scoped array transactions', async () => {
    const database = fakeDatabase()
    mocks.assertGoalFence.mockResolvedValue(undefined)
    database.raw.user.update.mockResolvedValue('raw')
    database.tx.user.update.mockResolvedValue('tx')
    const fenced = withGoalDatabaseFences(database.raw as unknown as PrismaClient) as unknown as {
      user: Delegate
      $transaction: (input: unknown[]) => Promise<unknown[]>
    }

    await expect(inGoal(() => fenced.$transaction([Promise.resolve('foreign')]))).rejects.toThrow(
      'Goal transactions require unexecuted scoped Prisma queries',
    )

    const pending = inGoal(() => fenced.user.update({ where: { id: 'u-1' }, data: { name: 'once' } }))
    await expect(pending).resolves.toBe('tx')
    await expect(inGoal(() => fenced.$transaction([pending]))).rejects.toThrow(
      'Goal transactions require unexecuted scoped Prisma queries',
    )
    expect(database.tx.user.update).toHaveBeenCalledTimes(1)
  })

  it('allows cancellation-safe accounting receipts to bypass effect fences', async () => {
    const database = fakeDatabase()
    mocks.assertGoalFence.mockRejectedValue(Object.assign(new Error('fenced'), { code: 'GOAL_EXECUTION_FENCED' }))
    database.raw.user.update.mockResolvedValue('receipt')
    database.tx.user.update.mockResolvedValue('should-not-write')
    const fenced = withGoalDatabaseFences(database.raw as unknown as PrismaClient) as unknown as { user: Delegate }

    await expect(inGoal(() => fenced.user.update({ where: { id: 'u-1' }, data: { content: 'late-write' } })))
      .rejects.toMatchObject({ code: 'GOAL_EXECUTION_FENCED' })
    expect(database.tx.user.update).not.toHaveBeenCalled()

    await expect(withGoalExecutionContext(context, () => withoutGoalEffects(() =>
      fenced.user.update({ where: { id: 'u-1' }, data: { status: 'settled' } }),
    ))).resolves.toBe('receipt')
    expect(database.raw.user.update).toHaveBeenCalledTimes(1)
    expect(database.transaction).toHaveBeenCalledTimes(1)
    expect(mocks.assertGoalFence).toHaveBeenCalledTimes(1)
  })
})
