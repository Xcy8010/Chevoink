import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { prisma, DataAccessError } from '../prisma.js'
import { runtimeJson, runtimeTransaction, type RuntimeTx } from '../agent/runtime-common.js'
import { itemizedTokenPriceSchema } from './token-price.js'

const statusSchema = z.enum(['draft', 'shadow', 'approved', 'active', 'retired'])
export const rateCardEvidenceSchema = z.object({ note: z.string().trim().min(1).max(2000),
  reportHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  shadowDays: z.number().min(7).max(365).optional(),
  totalFeeDeviationPercent: z.number().min(-3).max(3).optional(),
  userTaskP95AbsoluteDeviationPercent: z.number().min(0).max(5).optional(),
  cashCostIncreasePercent: z.number().max(3).optional(),
  allGroupsReviewed: z.literal(true).optional(),
  qualityPassed: z.literal(true).optional(),
  publicNoticeRef: z.string().trim().min(1).max(512).optional(),
  /** Explicit owner-approved discount release, not a simulated seven-day shadow. */
  discountApproval: z.object({ approvalRef: z.string().trim().min(1).max(512),
    waiveShadowPeriod: z.literal(true), replaySamples: z.number().int().positive(),
    maximumIncreaseMilli: z.literal(0) }).strict().optional(),
}).strict()

async function assertAdmin(tx: RuntimeTx, actorId: string, mutation = true) {
  const actor = await tx.user.findUnique({ where: { id: actorId }, select: { role: true, bannedAt: true, isSuperAdmin: true } })
  if (!actor || actor.role !== 'admin' || actor.bannedAt || (mutation && !actor.isSuperAdmin)) throw new DataAccessError(403, 'FORBIDDEN', '费率修改需要有效超级管理员身份。')
}

function checkedPrice(card: { id: string; modelTier: string; price: unknown; priceHash: string }) {
  const price = itemizedTokenPriceSchema.parse(card.price)
  if (price.rateCardId !== card.id || price.modelTier !== card.modelTier || runtimeJson(price).hash !== card.priceHash) throw new DataAccessError(409, 'CREDIT_RATE_CARD_CORRUPT', '原费率卡不可核对。')
  return price
}

/** Rates are immutable even in draft. Revise by creating another version. */
export async function createRateCard(actorId: string, input: unknown) {
  const price = itemizedTokenPriceSchema.parse(input)
  z.string().min(1).max(64).parse(price.rateCardId)
  const frozen = runtimeJson(price)
  return runtimeTransaction(async tx => {
    await assertAdmin(tx, actorId)
    const existing = await tx.creditRateCard.findUnique({ where: { id: price.rateCardId } })
    if (existing) {
      if (existing.createdBy !== actorId || existing.priceHash !== frozen.hash) throw new DataAccessError(409, 'CREDIT_RATE_CARD_CONFLICT', '费率版本已绑定其他内容。')
      checkedPrice(existing)
      return existing
    }
    const card = await tx.creditRateCard.create({ data: { id: price.rateCardId, modelTier: price.modelTier, price: frozen.value, priceHash: frozen.hash, createdBy: actorId } })
    await tx.creditRateCardEvent.create({ data: { id: randomUUID(), rateCardId: card.id, revision: 0, status: 'draft', actorId, evidence: { note: '创建不可变费率版本' } } })
    return card
  })
}

/** Approval records a review attestation + report hash, not a fabricated benchmark.
 * This service never generates the report or auto-approves unmeasured prices. */
export async function transitionRateCard(actorId: string, input: { id: string; expectedRevision: number; status: string; evidence: unknown }) {
  const id = z.string().min(1).max(64).parse(input.id)
  const expected = z.number().int().nonnegative().parse(input.expectedRevision)
  const next = statusSchema.parse(input.status)
  const evidence = rateCardEvidenceSchema.parse(input.evidence)
  if (next === 'approved' && !evidence.discountApproval && (!evidence.reportHash || evidence.shadowDays === undefined || evidence.totalFeeDeviationPercent === undefined
    || evidence.userTaskP95AbsoluteDeviationPercent === undefined || evidence.cashCostIncreasePercent === undefined || !evidence.allGroupsReviewed || !evidence.qualityPassed)) throw new DataAccessError(409, 'CREDIT_RATE_REVIEW_REQUIRED', '批准前必须记录影子、分组费用、质量与现金成本评审证据。')
  if (next === 'active' && !evidence.publicNoticeRef) throw new DataAccessError(409, 'CREDIT_RATE_NOTICE_REQUIRED', '生效前必须记录对外费率说明。')
  return runtimeTransaction(async tx => {
    await assertAdmin(tx, actorId)
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext('credit-rate-card-lifecycle'))`
    const card = await tx.creditRateCard.findUniqueOrThrow({ where: { id } })
    const price = checkedPrice(card)
    if (next === 'approved' && evidence.discountApproval) {
      const config = await tx.aiModelConfig.findFirst({ where: { ownerUserId: null, tier: card.modelTier }, select: { multiplierBps: true } })
      const bps = config?.multiplierBps
      if (!evidence.reportHash || !evidence.qualityPassed || bps === undefined || bps <= 0
        || price.multiplierBps !== bps || price.v1CeilingBps !== bps
        || price.rates.inputNano !== bps * 10 || price.rates.outputNano !== bps * 100
        || price.rates.cacheNano * 4 !== price.rates.inputNano) {
        throw new DataAccessError(409, 'CREDIT_RATE_DISCOUNT_INVALID', '快速折扣发布仅允许已核对当前倍率的25%缓存价格、V1封顶、回放报告与明确批准。')
      }
    }
    if (card.revision === expected + 1 && card.status === next) {
      const event = await tx.creditRateCardEvent.findUnique({ where: { rateCardId_revision: { rateCardId: id, revision: card.revision } } })
      if (event?.actorId === actorId && runtimeJson(event.evidence).hash === runtimeJson(evidence).hash) return card
      throw new DataAccessError(409, 'CREDIT_RATE_CARD_CONFLICT', '状态重放与原审批记录不同。')
    }
    const allowed: Record<string, string[]> = { draft: ['shadow', 'retired'], shadow: ['approved', 'retired'], approved: ['active', 'retired'], active: ['retired'], retired: [] }
    if (card.revision !== expected || !allowed[card.status]?.includes(next)) throw new DataAccessError(409, 'CREDIT_RATE_CARD_CONFLICT', '费率状态已变化或跳过必需评审。')
    if (next === 'active') {
      const config = await tx.aiModelConfig.findFirst({ where: { ownerUserId: null, tier: card.modelTier, enabled: true, ...(card.modelTier === 'basic' ? {} : { selectable: true }) } })
      if (!config || config.modelName === 'unconfigured' || (card.modelTier !== 'speed' && (!config.baseUrl || !config.apiKeyCiphertext))) throw new DataAccessError(409, 'MODEL_TIER_UNAVAILABLE', '该模型档位尚未开放。')
      const previous = await tx.creditRateCard.findFirst({ where: { modelTier: card.modelTier, status: 'active' } })
      if (previous) {
        await tx.creditRateCard.update({ where: { id: previous.id }, data: { status: 'retired', revision: { increment: 1 } } })
        await tx.creditRateCardEvent.create({ data: { id: randomUUID(), rateCardId: previous.id, revision: previous.revision + 1, status: 'retired', actorId, evidence: { note: `由费率版本 ${id} 替代` } } })
      }
    }
    const updated = await tx.creditRateCard.update({ where: { id }, data: { status: next, revision: { increment: 1 } } })
    await tx.creditRateCardEvent.create({ data: { id: randomUUID(), rateCardId: id, revision: updated.revision, status: next, actorId, evidence } })
    return updated
  })
}

export async function getActiveTokenPrice(modelTier: string) {
  return (await getActiveTokenPrices([modelTier])).get(modelTier) ?? null
}

export async function getActiveTokenPrices(modelTiers: string[]) {
  const cards = await prisma.creditRateCard.findMany({ where: { modelTier: { in: modelTiers }, status: 'active' }, include: { events: { orderBy: { revision: 'asc' } } } })
  return new Map(cards.map(card => {
    if (card.revision !== 3 || card.events.length !== 4 || card.events.some((event, index) => event.revision !== index || event.status !== ['draft', 'shadow', 'approved', 'active'][index])) {
      throw new DataAccessError(409, 'CREDIT_RATE_CARD_CORRUPT', '生效费率缺少完整生命周期记录。')
    }
    return [card.modelTier, checkedPrice(card)] as const
  }))
}

export async function listRateCards(actorId: string) {
  return runtimeTransaction(async tx => {
    await assertAdmin(tx, actorId, false)
    return tx.creditRateCard.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 100, include: { events: { orderBy: { revision: 'desc' } } } })
  })
}
