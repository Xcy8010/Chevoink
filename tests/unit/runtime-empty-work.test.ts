import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { consumeDurableConfigurationConsent } from '../../api/lib/agent/configuration-journal.js'
import { wakeDurableChildren } from '../../api/lib/agent/runtime-child-tools.js'
import { advanceDurableMemory } from '../../api/lib/agent/runtime-memory.js'
import { prisma } from '../../api/lib/prisma.js'

const mocks = vi.hoisted(() => ({ tx: {} as Record<string, unknown>, state: vi.fn(), adopt: vi.fn(), evidence: vi.fn() }))
vi.mock('../../api/lib/agent/runtime-lease.js', async original => ({ ...await original<object>(),
  withRunLease: async (_token: unknown, work: (tx: unknown) => unknown) => work(mocks.tx) }))
vi.mock('../../api/lib/agent/runtime-state.js', async original => ({ ...await original<object>(), readExecutionStateInTransaction: mocks.state }))
vi.mock('../../api/lib/agent/runtime-child.js', async original => ({ ...await original<object>(), adoptChildGrants: mocks.adopt }))
vi.mock('../../api/lib/agent/runtime-evidence.js', async original => ({ ...await original<object>(), collectDurableToolEvidence: mocks.evidence }))

const token = { userId: 'user', runId: 'run', taskRootId: 'root', ownerId: 'owner', claimId: 'claim', epoch: 1n }
let queued: ReturnType<typeof vi.fn>, eligible: ReturnType<typeof vi.fn>, operations: ReturnType<typeof vi.fn>, pending: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.resetAllMocks()
  queued = vi.fn(async () => 0); eligible = vi.fn(async () => []); operations = vi.fn(async () => 0); pending = vi.fn(async () => null)
  mocks.tx = { agentRun: { findUniqueOrThrow: vi.fn(async () => ({ id: 'run', sessionId: 'session' })) },
    agentQueuedRequest: { count: queued }, agentChildExecutionGrant: { findMany: eligible },
    agentOperation: { count: operations, findUnique: pending }, agentTaskRoot: { findUniqueOrThrow: vi.fn(async () => ({ id: 'root', novelId: 'novel' })) } }
  mocks.state.mockResolvedValue({ frame: { state: { phase: 'idle', messages: [], pendingOperationId: null }, revision: 0 } })
  mocks.evidence.mockResolvedValue({ effects: [] }); mocks.adopt.mockResolvedValue(undefined)
})
afterEach(() => vi.restoreAllMocks())

describe('empty scheduler work without reconstructing unrelated snapshots', () => {
  it('leaves an absent configuration journal untouched without a frame read', async () => {
    expect(await consumeDurableConfigurationConsent(token)).toBe(false)
    expect(queued).toHaveBeenCalledWith({ where: { userId: 'user', sessionId: 'session', status: { in: ['held', 'consented'] },
      payload: { path: ['configurationConsent', 'sourceRootId'], equals: 'root' } } })
    expect(mocks.state).not.toHaveBeenCalled()
  })

  it('retains the saved cursor guard when a journal exists', async () => {
    queued.mockResolvedValue(1)
    mocks.state.mockResolvedValue({ frame: { state: { phase: 'awaiting_operation' } } })
    expect(await consumeDurableConfigurationConsent(token)).toBe(false)
    expect(mocks.state).toHaveBeenCalledExactlyOnceWith(mocks.tx, 'root')
  })

  it('does not hide a damaged frame behind a nonempty configuration journal', async () => {
    queued.mockResolvedValue(1); mocks.state.mockRejectedValue(Error('damaged frame'))
    await expect(consumeDurableConfigurationConsent(token)).rejects.toThrow('damaged frame')
  })

  it('adopts first and avoids the parent frame only when no eligible child remains', async () => {
    await wakeDurableChildren(token)
    expect(mocks.adopt).toHaveBeenCalledExactlyOnceWith(mocks.tx, token)
    expect(eligible).toHaveBeenCalledWith({ where: { parentRootId: 'root', status: { in: ['admitted', 'running'] } },
      select: { childRunId: true, parentOperationId: true } })
    expect(mocks.state).not.toHaveBeenCalled()
    expect(mocks.adopt.mock.invocationCallOrder[0]).toBeLessThan(eligible.mock.invocationCallOrder[0])
  })

  it.each(['task_spawn', 'task_send'])('keeps the unacknowledged %s child excluded', async action => {
    const dispatch = vi.spyOn(prisma.agentChildExecutionGrant, 'findUnique').mockResolvedValue(null)
    eligible.mockResolvedValue([{ childRunId: 'child', parentOperationId: 'pending' }])
    mocks.state.mockResolvedValue({ frame: { state: { pendingOperationId: 'pending' } } })
    pending.mockResolvedValue({ id: 'pending', status: 'prepared', action })
    await wakeDurableChildren(token)
    expect(mocks.state).toHaveBeenCalledTimes(1)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it.each(['another-parent', 'acknowledged'] as const)('still dispatches an eligible %s child through the real entrypoint', async scenario => {
    // The real entrypoint stops at an absent synthetic grant; no worker/network
    // work is substituted and no database is reached by this unit fixture.
    const dispatch = vi.spyOn(prisma.agentChildExecutionGrant, 'findUnique').mockResolvedValue(null)
    eligible.mockResolvedValue([{ childRunId: scenario, parentOperationId: scenario === 'another-parent' ? 'other' : 'pending' }])
    mocks.state.mockResolvedValue({ frame: { state: { pendingOperationId: 'pending' } } })
    pending.mockResolvedValue({ id: 'pending', status: scenario === 'another-parent' ? 'prepared' : 'succeeded', action: 'task_spawn' })
    await wakeDurableChildren(token)
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ where: { childRunId: scenario }, include: { childRun: true } })
  })

  it('does not dispatch children when their nonempty parent frame is invalid', async () => {
    const dispatch = vi.spyOn(prisma.agentChildExecutionGrant, 'findUnique').mockResolvedValue(null)
    eligible.mockResolvedValue([{ childRunId: 'child', parentOperationId: 'parent' }]); mocks.state.mockRejectedValue(Error('invalid parent'))
    await expect(wakeDurableChildren(token)).rejects.toThrow('invalid parent')
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('avoids the evidence scan only before any successful tool exists', async () => {
    expect(await advanceDurableMemory(token)).toBeNull()
    expect(operations).toHaveBeenCalledWith({ where: { taskRootId: 'root', kind: 'tool', status: 'succeeded' } })
    expect(mocks.state).not.toHaveBeenCalled(); expect(mocks.evidence).not.toHaveBeenCalled()
  })

  it('keeps full evidence verification after any successful tool, including a read', async () => {
    operations.mockResolvedValue(1)
    expect(await advanceDurableMemory(token)).toBeNull()
    expect(mocks.state).toHaveBeenCalledExactlyOnceWith(mocks.tx, 'root')
    expect(mocks.evidence).toHaveBeenCalledExactlyOnceWith(mocks.tx, 'root', 0)
  })

  it('does not bypass a damaged successful read receipt before the next native tool', async () => {
    operations.mockResolvedValue(1); mocks.evidence.mockRejectedValue(Error('damaged receipt'))
    await expect(advanceDurableMemory(token)).rejects.toThrow('damaged receipt')
  })
})
