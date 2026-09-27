import { prisma } from '../prisma.js'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'
import { currentGoalExecution, withoutGoalEffects, type GoalExecutionContext } from './goal-context.js'
import { assertGoalFence } from './goal-fence.js'
import { changeGoal, goalError } from './goal-store.js'
import { databaseNow, runtimeTransaction, runtimeJson } from './runtime-common.js'

/** Reserve before dispatch, once per provider attempt (including routed failures and auxiliary calls). */
export async function reserveGoalUsage(sourceKey: string, estimatedTokens: number, context = currentGoalExecution()) {
  if (!context) return
  if (!Number.isSafeInteger(estimatedTokens) || estimatedTokens < 0) return goalError('GOAL_USAGE_INVALID', '目标用量估算无效。')
  await withoutGoalEffects(() => runtimeTransaction(tx => reserveGoalUsageInTransaction(tx, sourceKey, estimatedTokens, context)))
}

/** Durable dispatch commits its budget reservation and single-dispatch marker together. */
export async function reserveGoalUsageInTransaction(tx: Prisma.TransactionClient, sourceKey: string, estimatedTokens: number, context: GoalExecutionContext) {
  if (!Number.isSafeInteger(estimatedTokens) || estimatedTokens < 0) return goalError('GOAL_USAGE_INVALID', '目标用量估算无效。')
    await assertGoalFence(tx, context)
    const previous = await tx.agentGoalUsage.findUnique({ where: { sourceKey } })
    if (previous) {
      if (previous.goalId !== context.goalId || previous.runId !== context.runId) return goalError('GOAL_SCOPE_MISMATCH', '用量归属不一致。')
      // A reservation grants dispatch only once. Caller must replay an existing result, never spend it twice.
      return goalError('GOAL_RECONCILIATION_REQUIRED', '原请求已登记，不能重复派发。')
    }
    if (await tx.agentGoalUsage.count({ where: { goalId: context.goalId, status: 'unknown' } })) {
      return goalError('GOAL_RECONCILIATION_REQUIRED', '尚有模型用量待核实，已保留目标。')
    }
    const budget = await tx.agentGoalBudget.findUniqueOrThrow({ where: { goalId: context.goalId } })
    const goal = await tx.agentGoal.findUniqueOrThrow({ where: { id: context.goalId } })
    const now = await databaseNow(tx)
    const elapsed = goal.activeSince ? BigInt(Math.max(0, now.getTime() - goal.activeSince.getTime())) : 0n
    const reserved = BigInt(estimatedTokens)
    if (budget.tokensUsed + budget.tokensReserved + reserved > budget.tokenLimit || budget.activeTimeMs + elapsed >= budget.activeTimeLimitMs) {
      return goalError('GOAL_BUDGET_EXHAUSTED', '目标已达到执行预算，已保存的内容保留。')
    }
    await tx.agentGoalUsage.create({ data: { sourceKey, goalId: context.goalId, runId: context.runId, reservedTokens: reserved } })
    await tx.agentGoalBudget.update({ where: { goalId: context.goalId }, data: { tokensReserved: { increment: reserved } } })
}

export interface GoalUsageObservation {
  inputTokens: number | null; outputTokens: number | null; creditsMilli: number
  status: 'reserved' | 'known' | 'rejected' | 'unknown'
}

/** Monotone accounting watermark. Settling an old epoch is allowed; creating another request is not. */
export async function observeGoalUsage(sourceKey: string, observation: GoalUsageObservation) {
  const known = await withoutGoalEffects(() => prisma.agentGoalUsage.findUnique({ where: { sourceKey }, include: { goal: true } }))
  if (!known) return
  for (const value of [observation.inputTokens, observation.outputTokens, observation.creditsMilli]) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) return goalError('GOAL_USAGE_INVALID', '模型用量记录无效。')
  }
  await withoutGoalEffects(() => runtimeTransaction(async tx => {
    await lockNovelActiveScope(tx, known.goal.novelId)
    await tx.$queryRaw`SELECT id FROM agent_goals WHERE id = ${known.goalId} FOR UPDATE`
    const current = await tx.agentGoalUsage.findUniqueOrThrow({ where: { sourceKey } })
    const goal = await tx.agentGoal.findUniqueOrThrow({ where: { id: known.goalId } })
    const input = BigInt(observation.inputTokens ?? 0)
    const output = BigInt(observation.outputTokens ?? 0)
    const credits = BigInt(observation.creditsMilli) * 1000n
    // Late partial observations cannot decrease a previously confirmed measurement.
    const inputTokens = input > current.inputTokens ? input : current.inputTokens
    const outputTokens = output > current.outputTokens ? output : current.outputTokens
    const creditsMicros = credits > current.creditsMicros ? credits : current.creditsMicros
    const terminal = ['known', 'rejected'].includes(current.status)
    const status = terminal ? current.status : observation.status
    const release = ['known', 'rejected'].includes(status) ? current.reservedTokens : 0n
    if (inputTokens === current.inputTokens && outputTokens === current.outputTokens && creditsMicros === current.creditsMicros
      && status === current.status && release === 0n) return
    await tx.agentGoalUsage.update({ where: { sourceKey }, data: { inputTokens, outputTokens, creditsMicros, status,
      reservedTokens: current.reservedTokens - release } })
    await tx.agentGoalBudget.update({ where: { goalId: known.goalId }, data: {
      tokensUsed: { increment: inputTokens + outputTokens - current.inputTokens - current.outputTokens },
      tokensReserved: { decrement: release }, creditsUsedMicros: { increment: creditsMicros - current.creditsMicros },
    } })
    await changeGoal(tx, goal, {}, 'usage.updated')
  }))
}

export async function syncGoalLegacyUsage(usageId: string) {
  const log = await withoutGoalEffects(() => prisma.aiUsageLog.findUnique({ where: { id: usageId } }))
  if (!log) return
  const rejected = ['provider_rejected', 'not_dispatched'].includes(log.billingStatus ?? '')
  const fixedImage = log.providerType === 'image' && log.action === 'generateCoverImage' && log.usageSource === 'fixed_unit'
    && log.billingStatus === 'observed' && log.requestTokens === 0 && log.responseTokens === 0
  const known = fixedImage || log.billingStatus !== 'pending_settlement' && log.requestTokens !== null && log.responseTokens !== null && ['reported', 'estimated'].includes(log.usageSource ?? '')
  await observeGoalUsage(`legacy:${usageId}`, { inputTokens: log.requestTokens, outputTokens: log.responseTokens,
    creditsMilli: fixedImage ? 0 : log.creditChargeMilli, status: rejected ? 'rejected' : known ? 'known'
      : ['pending_usage', 'pending_settlement'].includes(log.billingStatus ?? '') ? 'unknown' : 'reserved' })
}

/** Reconcile persisted durable measurements without dispatching or charging a provider again. */
export async function syncGoalDurableUsage(attemptId: string) {
  const attempt = await withoutGoalEffects(() => prisma.agentProviderAttempt.findUnique({ where: { id: attemptId }, include: { usageReceipt: true } }))
  if (!attempt) return
  if (attempt.result && (!attempt.resultHash || runtimeJson(attempt.result).hash !== attempt.resultHash)) {
    return goalError('GOAL_RECONCILIATION_REQUIRED', '模型结果回执不一致。')
  }
  const usage = attempt.usageReceipt
  if (usage && runtimeJson({ source: usage.source, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
    cacheHitTokens: usage.cacheHitTokens, cacheMissTokens: usage.cacheMissTokens }).hash !== usage.observationHash) {
    return goalError('GOAL_RECONCILIATION_REQUIRED', '模型用量回执不一致。')
  }
  const settlement = await withoutGoalEffects(() => prisma.agentExecutionOutbox.findUnique({ where: { eventKey: `settlement:${attempt.operationId}` } }))
  const paid = z.object({ operationId: z.literal(attempt.operationId), attemptId: z.literal(attempt.id),
    chargedMilli: z.number().int().nonnegative() }).safeParse(settlement?.payload)
  const rejected = z.object({ outcome: z.literal('failed'), result: z.object({ httpStatus: z.number() }) }).safeParse(attempt.result)
  // A cancellation releases the reservation only when the persisted receipt proves
  // that the provider was never reached.  A bare cancelled status is ambiguous:
  // the worker may have crashed after sending the request but before recording it.
  const notDispatched = z.object({
    outcome: z.literal('cancelled'),
    result: z.object({ code: z.string().min(1), dispatched: z.literal(false) }),
  }).safeParse(attempt.result)
  const confirmedNotDispatched = attempt.status === 'cancelled'
    && attempt.dispatchedAt === null
    && notDispatched.success
  const known = attempt.status === 'succeeded' && usage?.source === 'reported' && usage.promptTokens !== null && usage.completionTokens !== null
    && usage.settlementStatus === 'settled' && paid.success && settlement?.type === 'credit.settled'
  const status: GoalUsageObservation['status'] = known ? 'known' : confirmedNotDispatched ? 'rejected'
    : rejected.success && [400, 401, 403, 404, 422, 429].includes(rejected.data.result.httpStatus) ? 'rejected'
      : attempt.status === 'prepared' || attempt.status === 'dispatched' ? 'reserved' : 'unknown'
  await observeGoalUsage(`durable:${attemptId}`, { inputTokens: usage?.promptTokens ?? null, outputTokens: usage?.completionTokens ?? null,
    creditsMilli: paid.success ? paid.data.chargedMilli : 0,
    status })
}

/** Oldest unresolved rows first, including cancelled goals; final receipts must survive cancellation. */
export async function reconcileGoalUsage(goalId?: string, scope?: { userId: string; sessionId: string }) {
  const rows = await prisma.agentGoalUsage.findMany({ where: {
    ...(goalId ? { goalId } : {}),
    ...(scope ? { goal: { userId: scope.userId, sessionId: scope.sessionId } } : {}),
    status: { in: ['reserved', 'unknown'] },
  },
    orderBy: [{ updatedAt: 'asc' }, { sourceKey: 'asc' }], take: 200, select: { sourceKey: true } })
  for (const row of rows) {
    if (row.sourceKey.startsWith('legacy:')) await syncGoalLegacyUsage(row.sourceKey.slice(7))
    else if (row.sourceKey.startsWith('durable:')) await syncGoalDurableUsage(row.sourceKey.slice(8))
    // Rotate unchanged unknown receipts as well, so one outage cannot starve
    // the rest of a goal's attempt ledger behind the batch limit.
    await prisma.agentGoalUsage.updateMany({ where: { sourceKey: row.sourceKey, status: { in: ['reserved', 'unknown'] } }, data: { updatedAt: new Date() } })
  }
}

export async function assertGoalProviderAdmission(context: GoalExecutionContext | undefined = currentGoalExecution()) {
  if (context) await withoutGoalEffects(() => prisma.$transaction(async tx => {
    await assertGoalFence(tx, context)
    const goal = await tx.agentGoal.findUniqueOrThrow({ where: { id: context.goalId } })
    if (goal.currentRunId === context.runId && ['awaiting_input', 'awaiting_approval'].includes(goal.phase)) {
      return goalError('GOAL_AUTHOR_INPUT_REQUIRED', '目标等待作者决定，不能派发新模型请求。')
    }
  }))
}
