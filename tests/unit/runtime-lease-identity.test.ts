import { beforeEach, describe, expect, it, vi } from 'vitest'
import { withRunLeaseInTransaction } from '../../api/lib/agent/runtime-lease.js'
import type { RuntimeTx } from '../../api/lib/agent/runtime-common.js'

const mocks = vi.hoisted(() => ({ goal: vi.fn(), parent: vi.fn() }))
vi.mock('../../api/lib/agent/goal-fence.js', async original => ({ ...await original<object>(), assertRunGoalFence: mocks.goal }))
vi.mock('../../api/lib/agent/runtime-child.js', async original => ({ ...await original<object>(), assertChildParentFence: mocks.parent }))

const token = { userId: 'user', runId: 'run', taskRootId: 'root', ownerId: 'owner', claimId: 'claim', epoch: 3n }
const now = new Date('2026-10-23T12:00:00Z')
const held = () => ({ enabled: true, ownerId: 'owner', claimId: 'claim', epoch: 3n, expiresAt: new Date(now.getTime() + 1), now })
let run: { id: string; userId: string; sessionId: string; novelId: string; taskRootId: string | null; runtimeProtocolVersion: number; status: string } | null
let root: { id: string; userId: string; sessionId: string; novelId: string; protocolVersion: number; status: string; authorizationMode: string } | null
let samples: Array<ReturnType<typeof held> | null>, reads: string[]
let tx: RuntimeTx, work: ReturnType<typeof vi.fn>
beforeEach(() => {
  vi.resetAllMocks(); reads = []; samples = [held(), held()]
  mocks.goal.mockResolvedValue(undefined); mocks.parent.mockResolvedValue(undefined)
  run = { id: 'run', userId: 'user', sessionId: 'session', novelId: 'novel', taskRootId: 'root', runtimeProtocolVersion: 1, status: 'running' }
  root = { id: 'root', userId: 'user', sessionId: 'session', novelId: 'novel', protocolVersion: 1, status: 'active', authorizationMode: 'legacy' }
  tx = { agentChildExecutionGrant: { findUnique: vi.fn(async () => null) },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?')
      if (sql.includes('FROM agent_runs ')) { reads.push('owned-run'); return run ? [run] : [] }
      if (sql.includes('FROM agent_task_roots ')) { reads.push('root'); return root ? [root] : [] }
      if (sql.includes('FROM agent_run_leases ')) { reads.push('lease-clock'); const sample = samples.shift(); return sample ? [sample] : [] }
      throw Error('Unexpected database read')
    }) } as unknown as RuntimeTx
  work = vi.fn(async () => 'committed candidate')
})

describe('ordered identity-only lease fences', () => {
  it('checks the same live lease and database clock before and after work', async () => {
    expect(await withRunLeaseInTransaction(tx, token, work)).toBe('committed candidate')
    expect(reads).toEqual(['owned-run', 'root', 'lease-clock', 'lease-clock'])
    expect(mocks.goal).toHaveBeenCalledExactlyOnceWith(tx, 'user', 'run')
    expect(mocks.parent).toHaveBeenCalledTimes(2)
    expect(work).toHaveBeenCalledExactlyOnceWith(tx)
  })

  it.each(['userId', 'sessionId', 'novelId'] as const)('refuses a root with another %s', async key => {
    root![key] = 'foreign'
    await expect(withRunLeaseInTransaction(tx, token, work)).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_MISMATCH' })
    expect(work).not.toHaveBeenCalled()
  })

  it.each(['run', 'root'] as const)('rejects a missing %s before work', async missing => {
    if (missing === 'run') run = null
    else root = null
    await expect(withRunLeaseInTransaction(tx, token, work)).rejects.toMatchObject({ code: 'RUNTIME_SCOPE_MISMATCH' })
    expect(work).not.toHaveBeenCalled()
  })

  it.each(['run', 'root', 'no-root'] as const)('keeps the %s protocol fence', async target => {
    if (target === 'run') run!.runtimeProtocolVersion = 0
    else if (target === 'root') root!.protocolVersion = 0
    else run!.taskRootId = null
    await expect(withRunLeaseInTransaction(tx, token, work)).rejects.toMatchObject({ code: 'RUNTIME_VERSION_MISMATCH' })
    expect(work).not.toHaveBeenCalled()
  })

  it.each(['run-paused', 'root-paused', 'authorization'] as const)('does not activate %s', async state => {
    if (state === 'run-paused') run!.status = 'paused'
    else if (state === 'root-paused') root!.status = 'paused'
    else root!.authorizationMode = 'staged'
    await expect(withRunLeaseInTransaction(tx, token, work)).rejects.toMatchObject({ code: state === 'authorization' ? 'TASK_AUTHORIZATION_NOT_ACTIVATED' : 'RUNTIME_NOT_ACTIVE' })
    expect(work).not.toHaveBeenCalled()
  })

  it('does not execute when the first database clock reaches the expiry', async () => {
    samples[0]!.expiresAt = now
    await expect(withRunLeaseInTransaction(tx, token, work)).rejects.toMatchObject({ code: 'RUNTIME_LEASE_LOST' })
    expect(work).not.toHaveBeenCalled()
  })

  it.each(['expiry', 'owner', 'claim', 'epoch', 'disabled', 'missing'] as const)('rejects %s at the final boundary', async change => {
    const last = samples[1]!
    if (change === 'expiry') last.now = new Date(last.expiresAt.getTime())
    else if (change === 'owner') last.ownerId = 'replacement'
    else if (change === 'claim') last.claimId = 'replacement'
    else if (change === 'epoch') last.epoch++
    else if (change === 'disabled') last.enabled = false
    else samples[1] = null
    await expect(withRunLeaseInTransaction(tx, token, work)).rejects.toMatchObject({ code: 'RUNTIME_LEASE_LOST' })
    expect(work).toHaveBeenCalledTimes(1)
  })

  it('retains the parent fence before any work', async () => {
    mocks.parent.mockRejectedValueOnce(Object.assign(Error('parent stopped'), { code: 'RUNTIME_PARENT_LEASE_LOST' }))
    await expect(withRunLeaseInTransaction(tx, token, work)).rejects.toMatchObject({ code: 'RUNTIME_PARENT_LEASE_LOST' })
    expect(work).not.toHaveBeenCalled()
  })
})
