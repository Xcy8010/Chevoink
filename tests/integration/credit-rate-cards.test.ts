import { encryptSecret } from '../../api/lib/secret-box.js'
import type { DynamicBuiltInModelTier } from '../../shared/contracts/model-tier.js'
import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import request from 'supertest'
import app from '../../api/app.js'
import { buildSessionTokens } from '../../api/lib/auth-session.js'
import { prisma } from '../../api/lib/prisma.js'
import { handleTestDatabaseUnavailable } from '../support/database-availability.js'
import { createRateCard, transitionRateCard, getActiveTokenPrice } from '../../api/lib/billing/rate-cards.js'

const available = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(handleTestDatabaseUnavailable)
afterAll(async () => { await prisma.$disconnect() })

describe.runIf(available)('versioned V2 rate-card lifecycle', () => {
  it('permits an explicitly approved quarter-cache discount only with a verified V1 ceiling', async () => {
    const admin = await prisma.user.create({ data: { nickname: 'discount-fixture', passwordHash: 'test-only', role: 'admin', isSuperAdmin: true } })
    const ids = [randomUUID(), randomUUID()]
    const existing = await prisma.aiModelConfig.findFirst({ where: { ownerUserId: null, tier: 'basic' } })
    const config = existing ?? await prisma.aiModelConfig.create({ data: { key: randomUUID(), tier: 'basic', provider: 'fixture',
      displayName: 'fixture', modelName: 'fixture', multiplierBps: 15000 } })
    try {
      const bps = config.multiplierBps
      const price = { version: 'credits-v2-itemized', modelTier: 'basic', multiplierBps: bps,
        rates: { inputNano: bps * 10, cacheNano: bps * 2.5, outputNano: bps * 100 } }
      const evidence = { note: 'fixture explicit waiver, not seven-day evidence', reportHash: 'b'.repeat(64), qualityPassed: true,
        discountApproval: { approvalRef: 'fixture-owner-approval', waiveShadowPeriod: true, replaySamples: 100, maximumIncreaseMilli: 0 } }
      for (let index = 0; index < 2; index++) {
        await createRateCard(admin.id, { ...price, rateCardId: ids[index], ...(index ? { v1CeilingBps: bps } : {}) })
        await transitionRateCard(admin.id, { id: ids[index], expectedRevision: 0, status: 'shadow', evidence: { note: 'offline replay only' } })
      }
      await expect(transitionRateCard(admin.id, { id: ids[0], expectedRevision: 1, status: 'approved', evidence }))
        .rejects.toMatchObject({ code: 'CREDIT_RATE_DISCOUNT_INVALID' })
      await transitionRateCard(admin.id, { id: ids[1], expectedRevision: 1, status: 'approved', evidence })
      await expect(transitionRateCard(admin.id, { id: ids[1], expectedRevision: 2, status: 'active', evidence: { note: 'missing notice' } }))
        .rejects.toMatchObject({ code: 'CREDIT_RATE_NOTICE_REQUIRED' })
      expect((await prisma.creditRateCardEvent.findMany({ where: { rateCardId: ids[1], status: 'approved' } }))[0].evidence)
        .toMatchObject({ discountApproval: evidence.discountApproval })
    } finally {
      await prisma.creditRateCardEvent.deleteMany({ where: { rateCardId: { in: ids } } })
      await prisma.creditRateCard.deleteMany({ where: { id: { in: ids } } })
      if (!existing) await prisma.aiModelConfig.delete({ where: { id: config.id } })
      await prisma.user.delete({ where: { id: admin.id } })
    }
  })
  it('requires review, atomically replaces one active version, preserves old price, and rejects mutation', async () => {
    const admin = await prisma.user.create({ data: { nickname: 'rate-card-fixture', passwordHash: 'test-only', role: 'admin', isSuperAdmin: true } })
    const ids = [randomUUID(), randomUUID()]
    const tier = ('builtin_' + randomBytes(8).toString('hex')) as DynamicBuiltInModelTier
    const model = await prisma.aiModelConfig.create({ data: { key: tier, tier, provider: 'fixture', displayName: '费率配置', modelName: 'rate-fixture', baseUrl: 'https://fixture.invalid/v1', apiKeyCiphertext: encryptSecret('isolated-never-used'), enabled: true, selectable: true } })
    // Test tier must not already have a configured active price; never retire someone else's fixture.
    const prices = ids.map(rateCardId => ({ version: 'credits-v2-itemized' as const, modelTier: tier, multiplierBps: 10000,
      rateCardId, rates: { inputNano: 100000, cacheNano: 100000, outputNano: 1000000 } }))
    try {
      expect(await getActiveTokenPrice(tier)).toBeNull()
      const cookie = `chevoink_session=${buildSessionTokens(admin.id, 0).accessToken}`
      expect((await request(app).get('/api/admin/model-rate-cards')).status).toBe(401)
      const created = await request(app).post('/api/admin/model-rate-cards').set('Cookie', cookie).send(prices[0])
      expect(created.status).toBe(200)
      expect(created.body.data.card.id).toBe(ids[0])
      const invalid = await request(app).post(`/api/admin/model-rate-cards/${ids[0]}/transition`).set('Cookie', cookie)
        .send({ expectedRevision: 0, status: 'shadow', evidence: { note: '' } })
      expect(invalid.status).toBe(400)
      for (const price of prices) {
        const card = await createRateCard(admin.id, price)
        expect(await createRateCard(admin.id, price)).toEqual(card)
        await expect(transitionRateCard(admin.id, { id: card.id, expectedRevision: 0, status: 'active', evidence: { note: 'skip', publicNoticeRef: 'fixture' } })).rejects.toMatchObject({ code: 'CREDIT_RATE_CARD_CONFLICT' })
        await expect(prisma.creditRateCard.update({ where: { id: card.id }, data: { price: { ...price, rates: { ...price.rates, inputNano: 999 } } } })).rejects.toBeDefined()
        await transitionRateCard(admin.id, { id: card.id, expectedRevision: 0, status: 'shadow', evidence: { note: 'start fixture shadow' } })
        await expect(transitionRateCard(admin.id, { id: card.id, expectedRevision: 1, status: 'approved', evidence: { note: 'missing report' } })).rejects.toMatchObject({ code: 'CREDIT_RATE_REVIEW_REQUIRED' })
        await transitionRateCard(admin.id, { id: card.id, expectedRevision: 1, status: 'approved', evidence: { note: 'synthetic fixture attestation, not production evidence', reportHash: 'a'.repeat(64), shadowDays: 7,
          totalFeeDeviationPercent: 0, userTaskP95AbsoluteDeviationPercent: 0, cashCostIncreasePercent: 0, allGroupsReviewed: true, qualityPassed: true } })
        const activation = { id: card.id, expectedRevision: 2, status: 'active', evidence: { note: 'activate fixture', publicNoticeRef: 'fixture-public-notice' } }
        await prisma.aiModelConfig.update({ where: { id: model.id }, data: { enabled: false } })
        await expect(transitionRateCard(admin.id, activation)).rejects.toMatchObject({ code: 'MODEL_TIER_UNAVAILABLE' })
        await prisma.aiModelConfig.update({ where: { id: model.id }, data: { enabled: true } })
        const results = await Promise.all([transitionRateCard(admin.id, activation), transitionRateCard(admin.id, activation)])
        expect(results[0]).toEqual(results[1])
        expect(await getActiveTokenPrice(tier)).toEqual(price)
      }
      expect(await prisma.creditRateCard.count({ where: { id: { in: ids }, status: 'active' } })).toBe(1)
      expect(await prisma.creditRateCard.findUnique({ where: { id: ids[0] } })).toMatchObject({ status: 'retired', price: prices[0] })
      expect(await prisma.creditRateCardEvent.count({ where: { rateCardId: ids[0] } })).toBe(5)
      await prisma.user.update({ where: { id: admin.id }, data: { isSuperAdmin: false } })
      expect((await request(app).get('/api/admin/model-rate-cards').set('Cookie', cookie)).status).toBe(200)
      expect((await request(app).post('/api/admin/model-rate-cards').set('Cookie', cookie).send({ ...prices[0], rateCardId: randomUUID() })).status).toBe(403)
      await expect(createRateCard(admin.id, { ...prices[0], rateCardId: randomUUID() })).rejects.toMatchObject({ status: 403 })
    } finally {
      await prisma.creditRateCardEvent.deleteMany({ where: { rateCardId: { in: ids } } })
      await prisma.creditRateCard.deleteMany({ where: { id: { in: ids }, createdBy: admin.id } })
      await prisma.aiModelConfig.delete({ where: { id: model.id } })
      await prisma.user.delete({ where: { id: admin.id } })
    }
  }, 30000)
})
