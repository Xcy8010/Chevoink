import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { webToolChargeMilli } from '../../../shared/web-tool-pricing.js'
import { consumeCreditsInTransaction, reconcileCreditRefunds } from '../credits.js'
import { creditTransaction } from '../credit-policy.js'
import { DataAccessError, prisma } from '../prisma.js'
import { withoutGoalEffects } from '../agent/goal-context.js'
import type { ToolContext } from '../agent/tools/types.js'

type Kind = 'search' | 'fetch'
type Scope = Pick<ToolContext, 'userId' | 'novelId' | 'sessionId' | 'runId' | 'callId' | 'webAdmission'>
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const identity = (ctx: Scope, kind: Kind) => digest([ctx.userId, ctx.runId, ctx.callId, kind])
const key = (ctx: Scope, kind: Kind) => `web-${kind}:${ctx.runId}:${ctx.callId}`
const pending = () => new DataAccessError(409, 'CREDIT_WEB_TOOL_PENDING', '此联网调用已有未完成回执，未重复请求或扣费；需核对原调用结果。')
const admitted = <T>(ctx: Scope, tx: Prisma.TransactionClient, work: () => Promise<T>) => ctx.webAdmission ? ctx.webAdmission(tx, work) : work()

const jsonOutcome = (value: unknown): Prisma.InputJsonValue => {
  const serialized = JSON.stringify(value)
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > 3 * 1024 * 1024) throw pending()
  return JSON.parse(serialized) as Prisma.InputJsonValue
}

async function ownedRun(tx: Prisma.TransactionClient, ctx: Scope) {
  const run = await tx.agentRun.findFirst({ where: { id: ctx.runId, userId: ctx.userId, sessionId: ctx.sessionId,
    novelId: ctx.novelId, novel: { authorId: ctx.userId } }, select: { status: true } })
  if (!run) throw new DataAccessError(404, 'CREDIT_WEB_TOOL_SCOPE', '联网调用不属于当前任务。')
  return run
}

/** A free cache hit is also a completed logical call after cache expiry or configuration changes. */
export async function saveWebToolCacheOutcome(ctx: Scope, kind: Kind, request: unknown, result: unknown): Promise<void> {
  await creditTransaction(async tx => {
    await ownedRun(tx, ctx)
    const id = identity(ctx, kind)
    const existing = await tx.webToolCall.findUnique({ where: { id } })
    if (existing) {
      if (existing.requestHash !== digest(request)) throw new DataAccessError(409, 'CREDIT_IDEMPOTENCY_CONFLICT', '联网调用参数与原回执不一致。')
      if (existing.status !== 'completed') throw pending()
      return
    }
    await admitted(ctx, tx, () => tx.webToolCall.create({ data: { id, runId: ctx.runId, kind, requestHash: digest(request), amountMilli: 0,
      multiplierBps: 0, status: 'completed', outcome: jsonOutcome(result) } }))
  })
}

/** Look up logical identity before cache/configuration. Old calls cannot acquire today's price. */
export async function findWebToolCallOutcome<T>(ctx: Scope, kind: Kind, request: unknown): Promise<T | null> {
  return prisma.$transaction(async tx => {
    await ownedRun(tx, ctx)
    const saved = await tx.webToolCall.findUnique({ where: { id: identity(ctx, kind) } })
    if (!saved) return null
    if (saved.requestHash !== digest(request)) throw new DataAccessError(409, 'CREDIT_IDEMPOTENCY_CONFLICT', '联网调用参数与原回执不一致。')
    if (saved.status === 'dispatched') throw pending()
    if (saved.status === 'failed') throw new DataAccessError(409, 'CREDIT_WEB_TOOL_FAILED', '原联网调用已失败并记录退款义务，未重复请求或扣费。')
    if (saved.status !== 'completed' || saved.outcome === null) throw pending()
    return saved.outcome as T
  })
}

/** Caller owns this dispatch and observed cancellation before full tool delivery. */
export async function refundCancelledWebToolCall(ctx: ToolContext, kind: Kind, request: unknown): Promise<void> {
  if (!ctx.signal.aborted) return
  await withoutGoalEffects(() => creditTransaction(async tx => {
    await ownedRun(tx, ctx)
    const receipt = await tx.webToolCall.findUnique({ where: { id: identity(ctx, kind) } })
    if (!receipt) return
    if (receipt.requestHash !== digest(request) || receipt.status === 'dispatched') throw pending()
    const debit = await tx.creditLedgerEntry.findUniqueOrThrow({ where: { idempotencyKey: key(ctx, kind) } })
    if (debit.deltaMilli < 0) await tx.creditRefundIntent.upsert({ where: { originalEntryId: debit.id }, update: {},
      create: { originalEntryId: debit.id, reason: 'web_tool_no_billable_result', evidence: { callId: receipt.id, outcome: 'aborted' } } })
  })).catch(() => { throw pending() })
  await withoutGoalEffects(() => reconcileCreditRefunds({ userId: ctx.userId, limit: 10 })).catch(() => undefined)
}

/** One durable dispatch permit and one frozen debit. Unknown dispatches are never resent. */
export async function executeWebToolCall<T>(ctx: ToolContext, kind: Kind, request: unknown, paidProvider: boolean,
  dispatch: () => Promise<T>, classify: (result: T) => 'billable' | 'empty' | 'fallback' | 'failed' | 'unknown',
  reserve?: (tx: Prisma.TransactionClient) => Promise<void>, knownRejection?: (error: unknown) => boolean): Promise<T> {
  ctx.signal.throwIfAborted()
  const id = identity(ctx, kind)
  await creditTransaction(tx => admitted(ctx, tx, async () => {
    const run = await ownedRun(tx, ctx)
    if (run.status !== 'running' && !ctx.webAdmission) throw new DataAccessError(409, 'CREDIT_WEB_TOOL_INACTIVE', '任务已停止，未发起收费联网请求。')
    if (await tx.webToolCall.findUnique({ where: { id } })) throw pending()
    await reserve?.(tx)
    const config = await tx.aiModelConfig.findFirst({ where: { key: `tool:web-${kind === 'search' ? 'search' : 'fetch'}`, ownerUserId: null },
      select: { multiplierBps: true } })
    const multiplierBps = config?.multiplierBps ?? 10000
    let amountMilli: number
    try { amountMilli = paidProvider ? webToolChargeMilli(multiplierBps) : 0 }
    catch { throw new DataAccessError(409, 'CREDIT_WEB_TOOL_PRICE_INVALID', '网页工具倍率无效，未请求供应商。') }
    await consumeCreditsInTransaction(tx, { userId: ctx.userId, amountMilli, kind: 'usage', sourceType: `web_${kind}`,
      idempotencyKey: key(ctx, kind), referenceId: ctx.runId, multiplierBps,
      metadata: { webToolCallId: id, requestHash: digest(request), baseMilli: 2000 } })
    await tx.webToolCall.create({ data: { id, runId: ctx.runId, requestHash: digest(request), kind, amountMilli, multiplierBps } })
  })).catch(error => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw pending()
    throw error
  })
  const finish = async (result: T | null, outcome: 'billable' | 'empty' | 'fallback' | 'failed' | 'aborted') => {
    // Preserve delivery/refund evidence after cancellation; this cannot dispatch or write author content.
    await withoutGoalEffects(() => creditTransaction(async tx => {
      const receipt = await tx.webToolCall.findUniqueOrThrow({ where: { id } })
      if (receipt.status !== 'dispatched') throw pending()
      const debit = await tx.creditLedgerEntry.findUniqueOrThrow({ where: { idempotencyKey: key(ctx, kind) } })
      if (outcome !== 'billable' && debit.deltaMilli < 0) await tx.creditRefundIntent.create({ data: {
        originalEntryId: debit.id, reason: 'web_tool_no_billable_result', evidence: { callId: id, outcome },
      } })
      await tx.webToolCall.update({ where: { id }, data: { status: result === null ? 'failed' : 'completed',
        outcome: result === null ? Prisma.DbNull : jsonOutcome(result) } })
    })).catch(() => { throw pending() })
    if (outcome !== 'billable') await withoutGoalEffects(() => reconcileCreditRefunds({ userId: ctx.userId, limit: 10 })).catch(() => undefined)
  }
  const preserveUnknown = async (result: T | null) => {
    // A user refund is not evidence that the supplier did not process a request.
    // Keep the original dispatch pending; a new worker must reconcile it.
    await withoutGoalEffects(() => creditTransaction(async tx => {
      await ownedRun(tx, ctx)
      const receipt = await tx.webToolCall.findUniqueOrThrow({ where: { id } })
      if (receipt.status !== 'dispatched' || receipt.requestHash !== digest(request)) throw pending()
      if (result !== null) await tx.webToolCall.update({ where: { id }, data: { outcome: jsonOutcome(result) } })
      const debit = await tx.creditLedgerEntry.findUniqueOrThrow({ where: { idempotencyKey: key(ctx, kind) } })
      if (debit.deltaMilli < 0) await tx.creditRefundIntent.upsert({ where: { originalEntryId: debit.id }, update: {},
        create: { originalEntryId: debit.id, reason: 'web_tool_no_billable_result', evidence: { callId: id, outcome: 'unknown' } } })
    })).catch(() => { throw pending() })
    await withoutGoalEffects(() => reconcileCreditRefunds({ userId: ctx.userId, limit: 10 })).catch(() => undefined)
  }
  let result: T
  let enteredDispatch = false
  try {
    ctx.signal.throwIfAborted()
    enteredDispatch = true
    result = await dispatch()
  } catch (error) {
    if (ctx.webAdmission && enteredDispatch && !knownRejection?.(error)) { await preserveUnknown(null); throw pending() }
    await finish(null, ctx.signal.aborted ? 'aborted' : 'failed')
    throw error
  }
  const classified = classify(result)
  if (classified === 'unknown') { await preserveUnknown(result); throw pending() }
  // A cancelled delivery is free even if the supplier returned a result.
  await finish(result, ctx.signal.aborted ? 'aborted' : classified)
  // Cancellation can arrive while the completion transaction is committing.
  // Keep its already-saved result, but do not retain the cancelled user's fee.
  if (ctx.signal.aborted) await refundCancelledWebToolCall(ctx, kind, request)
  ctx.signal.throwIfAborted()
  return result
}
