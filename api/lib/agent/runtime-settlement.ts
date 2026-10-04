import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { consumeCreditsInTransaction } from '../credits.js'
import { calculateV1ChargeMilli, calculateV2ChargeMilli, BillingCacheUsageRequired, V1_PRICING_VERSION, V2_PRICING_VERSION } from '../billing/pricing.js'
import { tokenPriceSchema as priceSchema, type TokenPrice } from '../billing/token-price.js'
import { runtimeError, runtimeJson, runtimeTransaction, type RuntimeTx } from './runtime-common.js'
import { lockOwnedAttempt, prepareOperation, prepareOperationInTransaction } from './runtime-operations.js'
import { withRunLeaseInTransaction, type RunLeaseToken } from './runtime-lease.js'
import { readAttemptContentionScope } from './runtime-parent-contention.js'

export type DurableTokenPrice = TokenPrice

/** Atomic operation+cursor admission; no second/nested lease transaction. */
export async function preparePricedProviderOperationInTransaction(tx: RuntimeTx, token: RunLeaseToken, input: {
  key: string; action: string; request: Prisma.InputJsonValue; price: DurableTokenPrice; parentOperationId?: string
}) {
  const price = priceSchema.safeParse(input.price)
  if (!price.success) return runtimeError('RUNTIME_PRICE_INVALID', '收费策略未冻结或不受支持。')
  return prepareOperationInTransaction(tx, token, { key: input.key, kind: 'provider', action: input.action, parentOperationId: input.parentOperationId,
    input: { billing: price.data, request: input.request } })
}

/** Only the server-selected runtime price enters this contract, never model-generated arguments. */
export async function preparePricedProviderOperation(token: RunLeaseToken, input: {
  key: string; action: string; request: Prisma.InputJsonValue; price: DurableTokenPrice; parentOperationId?: string
}) {
  const price = priceSchema.safeParse(input.price)
  if (!price.success) runtimeError('RUNTIME_PRICE_INVALID', '收费策略未冻结或不受支持。')
  return prepareOperation(token, {
    key: input.key, kind: 'provider', action: input.action, parentOperationId: input.parentOperationId,
    input: { billing: price.data!, request: input.request },
  })
}

/**
 * Evidence first, money second. Delegated child debits require their current
 * parent and child leases; late evidence remains stored for reconciliation.
 * Only confirmed successful, fully measured calls enter this first settlement path. Other
 * outcomes remain pending for explicit policy/reconciliation, never silently zero-priced.
 */
export async function settleProviderOperation(input: { userId: string; attemptId: string; requestHash: string; lease?: RunLeaseToken }) {
  const captured = { ...input }
  const contentionScope = await readAttemptContentionScope(captured.userId, captured.attemptId, Boolean(captured.lease))
  return runtimeTransaction(async tx => {
    // Goal/manuscript -> parent -> child locks precede the attempt lock. Known
    // saved results may be reconciled by an explicitly adopted current owner;
    // historical attempt ownership remains unchanged and is not a live grant.
    const source = await tx.agentProviderAttempt.findFirst({ where: { id: captured.attemptId, operation: { taskRoot: { userId: captured.userId } } }, select: { runId: true } })
    const incoming = source ? await tx.agentChildExecutionGrant.findUnique({ where: { childRunId: source.runId } }) : null
    if (incoming && captured.lease) await withRunLeaseInTransaction(tx, captured.lease, async () => undefined)
    const attempt = await lockOwnedAttempt(tx, captured.userId, captured.attemptId, captured.requestHash)
    const delegated = await tx.agentChildExecutionGrant.findUnique({ where: { childRunId: attempt.runId } })
    if (delegated) {
      if (!captured.lease || captured.lease.runId !== attempt.runId
        || captured.lease.userId !== captured.userId || captured.lease.taskRootId !== attempt.operation.taskRootId) {
        return { status: 'pending' as const, reason: 'child_lease_not_confirmed' as const }
      }
      await withRunLeaseInTransaction(tx, captured.lease, async () => undefined)
    }
    const operation = attempt.operation
    if (!operation.inputSnapshot || runtimeJson(operation.inputSnapshot).hash !== operation.inputHash) {
      runtimeError('RUNTIME_RECEIPT_INVALID', '操作计费快照缺失或损坏。')
    }
    const envelope = operation.inputSnapshot as { input?: { billing?: unknown } }
    const price = priceSchema.safeParse(envelope.input?.billing)
    if (!price.success) runtimeError('RUNTIME_PRICE_INVALID', '原请求没有获准的固定计费策略，不能补造价格。')
    if (attempt.status !== 'succeeded' || operation.status !== 'succeeded') {
      return { status: 'pending' as const, reason: 'result_not_confirmed' as const }
    }
    if (!attempt.result || !attempt.resultHash || runtimeJson(attempt.result).hash !== attempt.resultHash) {
      runtimeError('RUNTIME_RECEIPT_INVALID', '供应商结果回执损坏，停止结算。')
    }
    const usage = await tx.agentProviderUsageReceipt.findUnique({ where: { attemptId: attempt.id } })
    if (!usage) return { status: 'pending' as const, reason: 'usage_not_confirmed' as const }
    const measurement = { source: usage.source, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, cacheHitTokens: usage.cacheHitTokens, cacheMissTokens: usage.cacheMissTokens }
    if (runtimeJson(measurement).hash !== usage.observationHash) runtimeError('RUNTIME_RECEIPT_INVALID', '用量回执损坏，停止结算。')
    if (usage.source !== 'reported' || usage.promptTokens === null || usage.completionTokens === null) {
      return { status: 'pending' as const, reason: 'usage_not_confirmed' as const }
    }
    if (!['pending', 'settled'].includes(usage.settlementStatus)) runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '未知结算状态不能重扣。')
    const frozenPrice = price.data!
    let amountMilli: number
    try {
      amountMilli = frozenPrice.version === V1_PRICING_VERSION
        ? calculateV1ChargeMilli(usage.promptTokens, usage.completionTokens, frozenPrice.multiplierBps)
        : calculateV2ChargeMilli(usage.promptTokens, usage.completionTokens, usage.cacheHitTokens, frozenPrice.rates, frozenPrice.v1CeilingBps)
    } catch (error) {
      if (error instanceof BillingCacheUsageRequired) return { status: 'pending' as const, reason: 'cache_usage_not_confirmed' as const }
      throw error
    }
    const eventKey = `settlement:${operation.id}`
    const priorEvent = await tx.agentExecutionOutbox.findUnique({ where: { eventKey } })
    const chargeKey = `operation:${operation.id}`
    const priorCharge = await tx.creditLedgerEntry.findUnique({ where: { idempotencyKey: chargeKey } })
    if (usage.settlementStatus === 'settled' && (!priorEvent || !priorCharge)) {
      runtimeError('RUNTIME_RECEIPT_INVALID', '结算状态与账本/通知不一致，禁止补扣。')
    }
    if (usage.settlementStatus === 'pending' && (priorEvent || priorCharge)) {
      runtimeError('RUNTIME_RECEIPT_INVALID', '待结算操作已有资金或通知记录，需要核对。')
    }
    const charge = await consumeCreditsInTransaction(tx, {
      userId: captured.userId, amountMilli, kind: 'usage', sourceType: 'model_tokens',
      idempotencyKey: chargeKey, referenceId: operation.id,
      modelTier: frozenPrice.modelTier, multiplierBps: frozenPrice.multiplierBps,
      requestTokens: usage.promptTokens, responseTokens: usage.completionTokens,
      allowPartialOnExhaustion: true,
      metadata: { pricingVersion: frozenPrice.version, taskRootId: operation.taskRootId, operationId: operation.id,
        ...(frozenPrice.version === V2_PRICING_VERSION ? { rateCardId: frozenPrice.rateCardId, rates: frozenPrice.rates, cacheHitTokens: usage.cacheHitTokens, cacheMissTokens: usage.cacheMissTokens,
          ...(frozenPrice.v1CeilingBps !== undefined ? { v1CeilingBps: frozenPrice.v1CeilingBps } : {}) } : {}),
        attemptId: attempt.id, requestHash: attempt.requestHash, usageRevision: usage.revision, observationHash: usage.observationHash },
    })
    const payload = { operationId: operation.id, attemptId: attempt.id, pricingVersion: frozenPrice.version,
      usageRevision: usage.revision, amountMilli, chargedMilli: charge.chargedMilli, shortfallMilli: amountMilli - charge.chargedMilli }
    if (priorEvent) {
      if (priorEvent.taskRootId !== operation.taskRootId || priorEvent.operationId !== operation.id
        || priorEvent.type !== 'credit.settled' || runtimeJson(priorEvent.payload).hash !== runtimeJson(payload).hash) {
        runtimeError('RUNTIME_RECEIPT_INVALID', '结算通知与资金事实不一致。')
      }
    } else {
      await tx.agentProviderUsageReceipt.update({ where: { attemptId: attempt.id }, data: { settlementStatus: 'settled' } })
      await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: operation.taskRootId, operationId: operation.id,
        runId: attempt.runId, eventKey, type: 'credit.settled', payload } })
    }
    if (delegated && captured.lease) await withRunLeaseInTransaction(tx, captured.lease, async () => undefined)
    return { status: 'settled' as const, amountMilli, shortfallMilli: amountMilli - charge.chargedMilli, ...charge }
  }, { contentionScope, contentionBackoff: Boolean(contentionScope?.isChild), deadline: contentionScope?.deadline })
}
