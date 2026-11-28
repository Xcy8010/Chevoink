import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { env } from '../../api/config/env.js'
import { updateGovernanceSafetyPolicy } from '../../api/lib/governance-safety.js'

const { tx, actorEligible, selectRelease } = vi.hoisted(() => ({
  tx: {
    $queryRaw: vi.fn(),
    user: { findFirst: vi.fn() },
    agentSafetyPolicy: { findUniqueOrThrow: vi.fn(), updateMany: vi.fn() },
    adminAuditLog: { create: vi.fn() },
  },
  actorEligible: vi.fn(),
  selectRelease: vi.fn(),
}))
vi.mock('../../api/lib/prisma.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../api/lib/prisma.js')>(),
  prisma: { $transaction: (apply: (db: typeof tx) => Promise<unknown>) => apply(tx) },
}))
vi.mock('../../api/lib/app-releases.js', () => ({
  hasPlatformGovernanceCapability: actorEligible,
  selectAppReleaseForUser: selectRelease,
}))

const actorId = 'synthetic-policy-administrator'
const before = { mode: 'observe', windowDays: 14, banDays: 3 }
const updatedAt = new Date('2026-01-11T04:00:00Z')
const request = {
  mode: 'enforce', windowDays: 30, banDays: 7, expectedUpdatedAt: updatedAt.toISOString(),
  reason: '  合成治理验收  ', confirmEnforcement: true,
}
const originalEnv = env.appEnv
beforeEach(() => {
  env.appEnv = 'production'
  vi.resetAllMocks()
  tx.user.findFirst.mockResolvedValue({ id: actorId })
  actorEligible.mockResolvedValue(true)
  selectRelease.mockResolvedValue({ mode: 'artifact', channel: 'stable', release: { capabilities: ['platformGovernance'] } })
  tx.agentSafetyPolicy.findUniqueOrThrow.mockResolvedValue({ ...before, updatedAt })
  tx.agentSafetyPolicy.updateMany.mockResolvedValue({ count: 1 })
})
afterAll(() => { env.appEnv = originalEnv })

describe('governance safety policy updates', () => {
  it('loads the actual active super-admin identity inside the transaction', async () => {
    tx.user.findFirst.mockResolvedValue(null)
    await expect(updateGovernanceSafetyPolicy(actorId, request)).rejects.toMatchObject({ code: 'SUPER_ADMIN_REQUIRED' })
    expect(tx.user.findFirst).toHaveBeenCalledWith({ where: {
      id: actorId, role: 'admin', isSuperAdmin: true, bannedAt: null,
      accountRestrictions: { none: { scope: 'platform', revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }] } },
    }, select: { id: true } })
    expect(actorEligible).not.toHaveBeenCalled()
    expect(tx.agentSafetyPolicy.updateMany).not.toHaveBeenCalled()
  })

  it('requires the acting administrator to have the capability', async () => {
    actorEligible.mockResolvedValue(false)
    await expect(updateGovernanceSafetyPolicy(actorId, request)).rejects.toMatchObject({ code: 'APP_RELEASE_CAPABILITY_DISABLED' })
    expect(actorEligible).toHaveBeenCalledWith(actorId, tx)
    expect(selectRelease).not.toHaveBeenCalled()
    expect(tx.adminAuditLog.create).not.toHaveBeenCalled()
  })

  it.each([
    { mode: 'legacy', channel: 'stable', release: null },
    { mode: 'artifact', channel: 'stable', release: { capabilities: [] } },
  ])('rejects enforce for a test administrator while anonymous stable lacks governance', async selection => {
    selectRelease.mockResolvedValue(selection)
    await expect(updateGovernanceSafetyPolicy(actorId, request)).rejects.toMatchObject({ code: 'GOVERNANCE_STABLE_REQUIRED' })
    expect(selectRelease).toHaveBeenCalledWith(null, tx)
    expect(tx.agentSafetyPolicy.updateMany).not.toHaveBeenCalled()
    expect(tx.adminAuditLog.create).not.toHaveBeenCalled()
  })

  it('can return to observe even when the public artifact is unavailable', async () => {
    selectRelease.mockRejectedValue(new Error('unavailable'))
    await expect(updateGovernanceSafetyPolicy(actorId, { ...request, mode: 'observe', confirmEnforcement: false })).resolves.toMatchObject({ mode: 'observe' })
    expect(selectRelease).not.toHaveBeenCalled()
  })

  it('requires explicit enforcement confirmation', async () => {
    await expect(updateGovernanceSafetyPolicy(actorId, { ...request, confirmEnforcement: false })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(tx.agentSafetyPolicy.updateMany).not.toHaveBeenCalled()
  })

  it('rejects a stale read and a concurrent change without recording success', async () => {
    await expect(updateGovernanceSafetyPolicy(actorId, { ...request, expectedUpdatedAt: new Date(0).toISOString() })).rejects.toMatchObject({ code: 'POLICY_CHANGED' })
    expect(tx.agentSafetyPolicy.updateMany).not.toHaveBeenCalled()
    tx.agentSafetyPolicy.updateMany.mockResolvedValue({ count: 0 })
    await expect(updateGovernanceSafetyPolicy(actorId, request)).rejects.toMatchObject({ code: 'POLICY_CHANGED' })
    expect(tx.adminAuditLog.create).not.toHaveBeenCalled()
  })

  it('persists the confirmed 30-day window and 7-day restriction with a before-and-after audit', async () => {
    const after = { mode: 'enforce', windowDays: 30, banDays: 7 }
    const next = await updateGovernanceSafetyPolicy(actorId, request)
    expect(next).toEqual({ ...after, updatedAt: expect.any(Date) })
    expect(next.updatedAt.getTime()).toBeGreaterThan(updatedAt.getTime())
    expect(tx.agentSafetyPolicy.updateMany).toHaveBeenCalledWith({ where: { id: 'active', updatedAt }, data: next })
    expect(tx.adminAuditLog.create).toHaveBeenCalledExactlyOnceWith({ data: {
      adminId: actorId, action: 'governance.safety.policy', targetType: 'safety_policy',
      targetId: 'active', detail: { before, after, reason: '合成治理验收' },
    } })
  })
})
