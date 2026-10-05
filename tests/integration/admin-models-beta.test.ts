import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Prisma } from '@prisma/client'
import { afterAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import app from '../../api/app.js'
import { prisma } from '../../api/lib/prisma.js'
import { verifyTestDatabase } from '../support/database-preflight.js'
import { isTestDatabaseRequired } from '../support/database-availability.js'
import { createAdminModel, reorderAdminModels, updateAdminModel, getAdminModelManagement, getAdminCreditsManagement } from '../../api/lib/admin-credit-model.js'
import { setPublicBetaEnabled, getPublicCreditPolicy } from '../../api/lib/credit-policy.js'
import { ensureCreditAccount, getCreditSummary, getCreditUsage, getCreditWindow, reserveTokenCredits, consumeCredits, refundCreditCharge, consumeTokenCredits, initializeNewUserCredits, assertCreditAccess, getModelTierRuntime, reconcileTokenSettlements } from '../../api/lib/credits.js'
import { isBuiltInModelTier, type CreditModelTier } from '../../shared/contracts/model-tier.js'
import { patchModelAssignments } from '../../api/lib/agent/model-assignments.js'

const available = await verifyTestDatabase(isTestDatabaseRequired())
afterAll(async () => { await prisma.$disconnect() })
const input = { provider: 'openai', displayName: '新内置模型', modelName: 'isolated-model', baseUrl: 'https://fixture.invalid/v1', apiKey: 'isolated-never-dispatched',
  enabled: true, selectable: true, multiplier: 1.25, reasoningEfforts: ['low', 'high', 'max'] as Array<'low' | 'high' | 'max'>, defaultReasoningEffort: 'max' as const }
async function fixture(work: (f: { adminId: string; userId: string; created: string[] }) => Promise<void>) {
  const adminId = randomUUID(), userId = randomUUID(), created: string[] = []
  const oldSetting = await prisma.creditSystemSetting.findUnique({ where: { id: 'global' } })
  const oldOrder = await prisma.aiModelConfig.findMany({ where: { ownerUserId: null }, select: { id: true, sortOrder: true, isDefault: true } })
  await prisma.creditSystemSetting.upsert({ where: { id: 'global' }, create: { id: 'global' }, update: { publicBetaEnabled: true, publicBetaRevision: 0, globallyPaused: false } })
  await prisma.user.createMany({ data: [{ id: adminId, nickname: 'isolated-beta-admin', role: 'admin', isSuperAdmin: true, passwordHash: 'test-only' }, { id: userId, nickname: 'isolated-beta-user', passwordHash: 'test-only' }] })
  try { await work({ adminId, userId, created }) }
  finally {
    await prisma.aiUsageLog.deleteMany({ where: { userId: { in: [userId, adminId] } } })
    await prisma.aiModelConfig.deleteMany({ where: { id: { in: created } } })
    for (const row of oldOrder) await prisma.aiModelConfig.update({ where: { id: row.id }, data: { sortOrder: row.sortOrder, isDefault: row.isDefault } })
    await prisma.adminAuditLog.deleteMany({ where: { adminId } })
    await prisma.user.deleteMany({ where: { id: { in: [userId, adminId] } } })
    if (oldSetting) await prisma.creditSystemSetting.update({ where: { id: 'global' }, data: oldSetting })
    else await prisma.creditSystemSetting.delete({ where: { id: 'global' } })
  }
}
async function order() { return (await getAdminModelManagement()).models.filter(row => isBuiltInModelTier(row.tier)).map(row => row.id) }
async function expiredAccount(userId: string, balance = 10000) {
  const end = new Date(Date.now() - 2 * 86400000), start = new Date(end.getTime() - 86400000)
  return prisma.creditAccount.create({ data: { userId, dailyAllowanceMilli: balance, dailyUsedMilli: 2000, bonusBalanceMilli: 3000, periodStartedAt: start, periodEndsAt: end } })
}
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }

describe.runIf(available)('admin dynamic catalog and independent public beta on isolated PostgreSQL', () => {
  it('creates an encrypted stable model at the tail without changing old defaults or prices; reorders only ranks', async () => fixture(async f => {
    const original = await prisma.aiModelConfig.findMany({ where: { ownerUserId: null } })
    const expected = await order()
    const added = await createAdminModel(f.adminId, input, expected); f.created.push(added.id)
    expect(added.tier).toMatch(/^builtin_[0-9a-f]{16}$/)
    const saved = await prisma.aiModelConfig.findUniqueOrThrow({ where: { id: added.id } })
    expect(saved.apiKeyCiphertext).not.toBe(input.apiKey)
    expect(saved.isDefault).toBe(false)
    const summary = await getCreditSummary(f.userId)
    expect(summary.models.at(-1)).toMatchObject({ tier: added.tier, label: input.displayName, multiplier: 1.25, available: true, defaultReasoningEffort: 'max' })
    expect(JSON.stringify(summary)).not.toContain(input.apiKey)
    await consumeCredits({ userId: f.userId, amountMilli: 100, kind: 'usage', sourceType: 'model_tokens', idempotencyKey: 'dynamic-label:' + randomUUID(), modelTier: added.tier as CreditModelTier })
    expect((await getCreditUsage(f.userId)).ledger[0]).toMatchObject({ modelTier: added.tier, modelLabel: input.displayName })
    await reorderAdminModels(f.adminId, [added.id, ...expected], await order())
    expect(await order()).toEqual([added.id, ...expected])
    for (const previous of original) {
      const after = await prisma.aiModelConfig.findUniqueOrThrow({ where: { id: previous.id } })
      expect({ ...after, sortOrder: previous.sortOrder, updatedAt: previous.updatedAt }).toEqual(previous)
    }
    const audits = await prisma.adminAuditLog.findMany({ where: { adminId: f.adminId } })
    expect(audits.map(row => row.action)).toEqual(['models.create', 'models.reorder'])
    expect(JSON.stringify(audits)).not.toContain(input.apiKey)
  }))
  it('rejects unknown actors, invalid full vectors and concurrent/stale creation without losing catalog entries', async () => fixture(async f => {
    const expected = await order()
    await expect(createAdminModel(f.userId, input, expected)).rejects.toMatchObject({ code: 'SUPER_ADMIN_REQUIRED' })
    const concurrent = await Promise.allSettled([1, 2].map(index => createAdminModel(f.adminId, { ...input, displayName: '并发' + index }, expected)))
    const fulfilled = concurrent.filter(row => row.status === 'fulfilled')
    for (const row of fulfilled) if (row.status === 'fulfilled') f.created.push(row.value.id)
    expect(fulfilled).toHaveLength(1)
    const rejected = concurrent.find(row => row.status === 'rejected')
    expect(rejected?.status === 'rejected' && rejected.reason.code).toBe('MODEL_CATALOG_CONFLICT')
    const current = await order()
    await expect(reorderAdminModels(f.adminId, current, expected)).rejects.toMatchObject({ code: 'MODEL_CATALOG_CONFLICT' })
    await expect(reorderAdminModels(f.adminId, current.slice(1), current)).rejects.toMatchObject({ code: 'MODEL_ORDER_INVALID' })
    await expect(reorderAdminModels(f.adminId, current.map(() => current[0]), current)).rejects.toMatchObject({ code: 'MODEL_ORDER_INVALID' })
    expect(await order()).toEqual(current)
  }))
  it('serializes default creation and PATCH under the same catalog lock in either arrival order', async () => fixture(async f => {
    const target = await createAdminModel(f.adminId, input, await order()); f.created.push(target.id)
    await expect(updateAdminModel(f.userId, target.id, { isDefault: true })).rejects.toMatchObject({ code: 'SUPER_ADMIN_REQUIRED' })
    const cookie = `chevoink_session=${(await import('../../api/lib/auth-session.js')).buildSessionTokens(f.adminId, 0).accessToken}`
    async function waitForWaiters(count: number) {
      for (let attempt = 0; attempt < 100; attempt++) {
        const rows = await prisma.$queryRaw<Array<{ count: number }>>`SELECT COUNT(*)::int AS count FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND objid = (hashtext('platform-model-catalog')::bigint & 4294967295)::oid`
        if (rows[0].count >= count) return
        await delay(20)
      }
      throw new Error('Expected catalog mutations to wait for the real PostgreSQL advisory lock')
    }
    for (const createFirst of [true, false]) {
      const locked = gate(), release = gate(), expected = await order()
      const blocker = prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext('platform-model-catalog'))`
        locked.release(); await release.promise
      }, { timeout: 10000 })
      await locked.promise
      let added!: Promise<{ id: string; tier: string }>, patched!: Promise<request.Response>
      const create = () => { added = createAdminModel(f.adminId, { ...input, isDefault: true }, expected).then(row => { f.created.push(row.id); return row }) }
      const patch = () => { patched = request(app).patch(`/api/admin/models/${target.id}`).set('Cookie', cookie).send({ isDefault: true }).then(response => response) }
      try {
        if (createFirst) create(); else patch()
        await waitForWaiters(1)
        if (createFirst) patch(); else create()
        await waitForWaiters(2)
      } finally {
        release.release(); await blocker
        await Promise.allSettled([added, patched].filter(Boolean))
      }
      const [created, response] = await Promise.all([added, patched])
      expect(response.status).toBe(200)
      const defaults = await prisma.aiModelConfig.findMany({ where: { ownerUserId: null, isDefault: true } })
      expect(defaults).toHaveLength(1)
      expect(defaults[0].id).toBe(createFirst ? target.id : created.id)
      expect(await prisma.aiModelConfig.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({ multiplierBps: 12500, modelName: input.modelName })
      expect((defaults[0].metadata as { defaultReasoningEffort: string }).defaultReasoningEffort).toBe('max')
    }
  }), 30000)
  it('rolls back incomplete creation and its audit, and enforces real dynamic availability/ownership on assignment', async () => fixture(async f => {
    const expected = await order(), before = await prisma.aiModelConfig.count()
    await expect(createAdminModel(f.adminId, { displayName: '不完整', enabled: true, selectable: true }, expected)).rejects.toMatchObject({ code: 'MODEL_CONFIG_INCOMPLETE' })
    expect(await prisma.aiModelConfig.count()).toBe(before)
    expect(await prisma.adminAuditLog.count({ where: { adminId: f.adminId } })).toBe(0)
    const added = await createAdminModel(f.adminId, input, expected); f.created.push(added.id)
    const tier = added.tier as CreditModelTier
    expect(await getModelTierRuntime(tier, f.userId)).toMatchObject({ tier, reasoningEffort: 'max', multiplierBps: 12500 })
    await patchModelAssignments(f.userId, { scope: 'global', expectedRevision: 0, assignments: { main: { modelTier: tier } } })
    await prisma.aiModelConfig.update({ where: { id: added.id }, data: { selectable: false } })
    await expect(patchModelAssignments(f.userId, { scope: 'global', expectedRevision: 1, assignments: { quality: { modelTier: tier } } })).rejects.toMatchObject({ code: 'MODEL_TIER_UNAVAILABLE' })
    await expect(getModelTierRuntime('builtin_ffffffffffffffff', f.userId)).rejects.toMatchObject({ code: 'MODEL_TIER_UNAVAILABLE' })
    await expect(getModelTierRuntime('custom', f.userId, added.id)).rejects.toMatchObject({ code: 'CUSTOM_MODEL_NOT_FOUND' })
    await expect(assertCreditAccess(f.userId, 'basic')).rejects.toMatchObject({ code: 'MODEL_TIER_UNAVAILABLE' })
  }))
  it('stops only AUTO rollover, preserves balances/suspension/period, exposes free plan, and resumes one calendar reset', async () => fixture(async f => {
    const before = await expiredAccount(f.userId)
    await setPublicBetaEnabled(f.adminId, false, 0)
    expect(await ensureCreditAccount(f.userId)).toMatchObject({ account: { dailyUsedMilli: 2000, bonusBalanceMilli: 3000, periodStartedAt: before.periodStartedAt, periodEndsAt: before.periodEndsAt, suspendedAt: null } })
    expect(await getCreditSummary(f.userId)).toMatchObject({ plan: 'free', planLabel: '免费版', publicBetaEnabled: false, publicBetaRevision: 1, totalRemaining: 11 })
    expect((await getAdminCreditsManagement()).users.find(row => row.user.id === f.userId)).toMatchObject({ planLabel: '免费版', dailyUsed: 2, totalRemaining: 11, suspended: false })
    await setPublicBetaEnabled(f.adminId, true, 1)
    expect((await ensureCreditAccount(f.userId)).account).toMatchObject({ dailyAllowanceMilli: 450000, dailyUsedMilli: 0, bonusBalanceMilli: 3000, suspendedAt: null, periodStartedAt: getCreditWindow().startedAt })
    await prisma.creditAccount.update({ where: { userId: f.userId }, data: { dailyUsedMilli: 1000 } })
    await ensureCreditAccount(f.userId)
    expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId: f.userId } })).dailyUsedMilli).toBe(1000)
  }))
  it('admits and settles a real free model at zero balance while stopped without resetting its expired window', async () => fixture(async f => {
    const account = await expiredAccount(f.userId, 450000)
    await prisma.creditAccount.update({ where: { userId: f.userId }, data: { dailyUsedMilli: 450000, bonusBalanceMilli: 0 } })
    await setPublicBetaEnabled(f.adminId, false, 0)
    const free = await createAdminModel(f.adminId, { ...input, multiplier: 0 }, await order()); f.created.push(free.id)
    const paid = await createAdminModel(f.adminId, input, await order()); f.created.push(paid.id)
    const tier = free.tier as CreditModelTier
    await expect(assertCreditAccess(f.userId, tier)).resolves.toBeUndefined()
    expect(await getModelTierRuntime(tier, f.userId)).toMatchObject({ tier, multiplierBps: 0 })
    await expect(assertCreditAccess(f.userId, paid.tier as CreditModelTier)).rejects.toMatchObject({ code: 'CREDITS_EXHAUSTED' })
    const usage = await prisma.aiUsageLog.create({ data: { userId: f.userId, providerType: 'text', providerMode: 'fixture', modelName: input.modelName,
      action: 'fixture', targetType: 'text', modelTier: tier, multiplierBps: 0, durationMs: 0, billingStatus: 'prepared', usageSource: 'prepared',
      billingSnapshot: { version: 'credits-v1-exact', modelTier: tier, multiplierBps: 0 } } })
    await reserveTokenCredits(f.userId, usage.id, 100000, 0)
    expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: usage.id } })).toMatchObject({ reservedCreditMilli: 0 })
    await prisma.aiUsageLog.update({ where: { id: usage.id }, data: { requestTokens: 1000, responseTokens: 500, billingStatus: 'observed', usageSource: 'reported' } })
    const charge = { userId: f.userId, usageLogId: usage.id, requestTokens: 1000, responseTokens: 500, modelTier: tier, multiplierBps: 0 }
    expect((await consumeTokenCredits(charge)).chargedMilli).toBe(0)
    expect((await consumeTokenCredits(charge)).chargedMilli).toBe(0)
    expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId, idempotencyKey: 'usage:' + usage.id } })).toBe(1)
    expect(await prisma.creditAccount.findUniqueOrThrow({ where: { userId: f.userId } })).toMatchObject({ dailyAllowanceMilli: 450000, dailyUsedMilli: 450000,
      bonusBalanceMilli: 0, periodStartedAt: account.periodStartedAt, periodEndsAt: account.periodEndsAt })
    expect(await getCreditSummary(f.userId)).toMatchObject({ publicBetaEnabled: false, totalRemaining: 0 })
    await prisma.aiModelConfig.update({ where: { id: free.id }, data: { enabled: false } })
    await expect(assertCreditAccess(f.userId, tier)).rejects.toMatchObject({ code: 'MODEL_TIER_UNAVAILABLE' })
  }))
  it('CAS rejects duplicates/stale revisions; failed audit rolls policy back; global pause is independent', async () => fixture(async f => {
    await expect(setPublicBetaEnabled(f.userId, false, 0)).rejects.toMatchObject({ code: 'SUPER_ADMIN_REQUIRED' })
    await expect(setPublicBetaEnabled(f.adminId, false, 0, 'x'.repeat(65))).rejects.toBeDefined()
    expect(await getPublicCreditPolicy()).toMatchObject({ publicBetaEnabled: true, publicBetaRevision: 0 })
    await prisma.creditSystemSetting.update({ where: { id: 'global' }, data: { globallyPaused: true } })
    await setPublicBetaEnabled(f.adminId, false, 0)
    await expect(setPublicBetaEnabled(f.adminId, false, 0)).rejects.toMatchObject({ code: 'PUBLIC_BETA_CONFLICT' })
    await expect(setPublicBetaEnabled(f.adminId, true, 0)).rejects.toMatchObject({ code: 'PUBLIC_BETA_CONFLICT' })
    expect((await prisma.creditSystemSetting.findUniqueOrThrow({ where: { id: 'global' } })).globallyPaused).toBe(true)
    expect(await prisma.adminAuditLog.count({ where: { adminId: f.adminId, action: 'credits.stop_beta' } })).toBe(1)
  }))
  it('keeps new holds alive through stopped expired windows, denies spending held credits, and refunds current charges once', async () => fixture(async f => {
    const account = await expiredAccount(f.userId)
    await setPublicBetaEnabled(f.adminId, false, 0)
    const ids: string[] = []
    for (let i = 0; i < 2; i++) ids.push((await prisma.aiUsageLog.create({ data: { userId: f.userId, providerType: 'text', providerMode: 'fixture', modelName: 'fixture', action: 'fixture', targetType: 'text', modelTier: 'speed', durationMs: 0,
      billingStatus: 'prepared', billingSnapshot: { version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 } } })).id)
    for (const id of ids) await reserveTokenCredits(f.userId, id, 100000, 10000)
    const holds = await prisma.aiUsageLog.findMany({ where: { id: { in: ids } } })
    expect(holds.every(row => row.reservationExpiresAt && row.reservationExpiresAt > new Date())).toBe(true)
    expect(holds.every(row => row.reservationExpiresAt && row.reservationExpiresAt > account.periodEndsAt)).toBe(true)
    const held = holds.reduce((sum, row) => sum + row.reservedCreditMilli, 0)
    expect(held).toBeGreaterThan(0)
    const payment = { userId: f.userId, idempotencyKey: 'beta-refund:' + randomUUID(), amountMilli: 2000, kind: 'usage', sourceType: 'web_search', referenceId: 'fixture' }
    await expect(consumeCredits({ ...payment, amountMilli: 11001 - held })).rejects.toMatchObject({ code: 'CREDITS_RESERVED' })
    await consumeCredits(payment)
    await refundCreditCharge(f.userId, payment.idempotencyKey, 'fixture')
    await refundCreditCharge(f.userId, payment.idempotencyKey, 'fixture')
    expect(await prisma.creditAccount.findUniqueOrThrow({ where: { userId: f.userId } })).toMatchObject({ dailyUsedMilli: 2000, bonusBalanceMilli: 3000 })
    expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId, kind: 'refund' } })).toBe(1)
  }))
  it('settles a disabled dynamic model using its saved price while stopped, and refunds old periods to bonus after resume', async () => fixture(async f => {
    await expiredAccount(f.userId)
    await setPublicBetaEnabled(f.adminId, false, 0)
    const added = await createAdminModel(f.adminId, input, await order()); f.created.push(added.id)
    const tier = added.tier as CreditModelTier
    const usage = await prisma.aiUsageLog.create({ data: { userId: f.userId, providerType: 'text', providerMode: 'fixture', modelName: input.modelName, action: 'fixture', targetType: 'text', modelTier: tier, multiplierBps: 12500, requestTokens: 10000, responseTokens: 0,
      durationMs: 0, billingStatus: 'observed', usageSource: 'reported', billingSnapshot: { version: 'credits-v1-exact', modelTier: tier, multiplierBps: 12500 } } })
    await prisma.aiModelConfig.update({ where: { id: added.id }, data: { enabled: false, multiplierBps: 99999 } })
    expect((await consumeTokenCredits({ userId: f.userId, usageLogId: usage.id, requestTokens: 10000, responseTokens: 0, modelTier: tier, multiplierBps: 12500 })).chargedMilli).toBe(1250)
    await prisma.aiUsageLog.update({ where: { id: usage.id }, data: { billingStatus: 'pending_settlement' } })
    await reconcileTokenSettlements()
    await reconcileTokenSettlements()
    expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId, idempotencyKey: 'usage:' + usage.id } })).toBe(1)
    await setPublicBetaEnabled(f.adminId, true, 1)
    await ensureCreditAccount(f.userId)
    await prisma.creditLedgerEntry.update({ where: { idempotencyKey: 'usage:' + usage.id }, data: { createdAt: new Date(Date.now() - 3 * 86400000) } })
    await refundCreditCharge(f.userId, 'usage:' + usage.id, 'fixture')
    expect(await prisma.creditAccount.findUniqueOrThrow({ where: { userId: f.userId } })).toMatchObject({ dailyUsedMilli: 0, bonusBalanceMilli: 4250 })
  }))
  it('serializes rollover-before-stop and stop-before-rollover on the same policy row', async () => fixture(async f => {
    await expiredAccount(f.userId)
    const locked = gate(), release = gate()
    const first = prisma.$transaction(async tx => { await getCreditSummary(f.userId, tx); locked.release(); await release.promise }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    await locked.promise
    let toggled = false
    const toggle = setPublicBetaEnabled(f.adminId, false, 0).then(() => { toggled = true })
    try { await delay(80); expect(toggled).toBe(false) } finally { release.release() }
    await Promise.all([first, toggle])
    expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId: f.userId } })).dailyUsedMilli).toBe(0)
    await prisma.creditSystemSetting.update({ where: { id: 'global' }, data: { publicBetaEnabled: true } })
    await prisma.creditAccount.update({ where: { userId: f.userId }, data: { dailyUsedMilli: 2000, periodEndsAt: new Date(Date.now() - 86400000) } })
    const lockedStop = gate(), finishStop = gate()
    const stop = prisma.$transaction(async tx => { await tx.creditSystemSetting.update({ where: { id: 'global' }, data: { publicBetaEnabled: false } }); lockedStop.release(); await finishStop.promise })
    await lockedStop.promise
    let rolled = false
    const rollover = ensureCreditAccount(f.userId).then(() => { rolled = true })
    try { await delay(80); expect(rolled).toBe(false) } finally { finishStop.release() }
    await Promise.all([stop, rollover])
    expect((await prisma.creditAccount.findUniqueOrThrow({ where: { userId: f.userId } })).dailyUsedMilli).toBe(2000)
  }))
  it('signup/invite keeps initial allowance and bonus while the inviter frozen window does not roll over', async () => fixture(async f => {
    await expiredAccount(f.userId)
    const code = ('BETA' + f.userId.replace(/-/g, '').slice(0, 8)).toUpperCase()
    await prisma.referralCode.create({ data: { userId: f.userId, code } })
    await setPublicBetaEnabled(f.adminId, false, 0)
    await prisma.$transaction(tx => initializeNewUserCredits(tx, f.adminId, code))
    expect(await prisma.creditAccount.findUniqueOrThrow({ where: { userId: f.adminId } })).toMatchObject({ dailyAllowanceMilli: 450000, bonusBalanceMilli: 120000, suspendedAt: null })
    expect(await prisma.creditAccount.findUniqueOrThrow({ where: { userId: f.userId } })).toMatchObject({ dailyUsedMilli: 2000, bonusBalanceMilli: 303000 })
  }))
  it('anonymous policy returns only public fields without initializing accounts or allowing mutation', async () => fixture(async () => {
    const count = await prisma.creditAccount.count(), auditCount = await prisma.adminAuditLog.count()
    const result = await request(app).get('/api/credits/public-policy')
    expect(result.status).toBe(200)
    expect(Object.keys(result.body.data).sort()).toEqual(['plan', 'planLabel', 'publicBetaEnabled', 'publicBetaRevision'])
    expect(await prisma.creditAccount.count()).toBe(count)
    expect(await prisma.adminAuditLog.count()).toBe(auditCount)
    expect((await request(app).post('/api/admin/credits/public-beta').send({ enabled: false, expectedRevision: 0 })).status).toBe(401)
    expect(await getPublicCreditPolicy()).toMatchObject({ publicBetaEnabled: true })
  }))
})
