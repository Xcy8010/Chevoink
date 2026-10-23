import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { coverChildSchema, coverRequest, coverUnitSchema, coverUnitUsage, coverWorkSchema } from './runtime-cover-contract.js'
import { imageBlobSchema } from './provider-image-storage.js'
import { runtimeError, runtimeJson, type RuntimeTx } from './runtime-common.js'
import { enforceCoverTitleInPrompt } from './tools/cover-prompt.js'

/** Read-only authentic fixed-image contract. A source label or an arbitrary
 * provider child cannot waive text output limits, Token or settlement checks. */
export async function readCoverAdmission(tx: RuntimeTx, attemptId: string) {
  const attempt = await tx.agentProviderAttempt.findUnique({ where: { id: attemptId }, include: { operation: { include: { parent: true, attempts: true, taskRoot: true } } } })
  if (!attempt) return null
  const operation = attempt.operation, parent = operation.parent
  if (operation.kind !== 'provider' || operation.action !== 'cover_generate_image' || !parent || parent.kind !== 'tool' || parent.action !== 'cover_generate'
    || operation.operationKey !== `cover:${parent.id}:0` || parent.taskRootId !== operation.taskRootId || operation.attempts.length !== 1 || attempt.attemptKey !== '1'
    || runtimeJson(parent.inputSnapshot).hash !== parent.inputHash || runtimeJson(operation.inputSnapshot).hash !== operation.inputHash) return null
  const original = z.object({ input: z.object({ work: coverWorkSchema, novelId: z.string(), callId: z.string(), args: z.object({ prompt: z.string(), count: z.number().optional() }),
    normalization: z.object({ normalizedArgsHash: z.string(), sourceRevision: z.number().int().nonnegative(), sourceSnapshotHash: z.string(), rawArguments: z.string() }) }) }).safeParse(parent.inputSnapshot)
  const child = z.object({ input: coverChildSchema }).safeParse(operation.inputSnapshot)
  if (!original.success || !child.success) return null
  const work = original.data.input.work, input = child.data.input
  await (await import('./runtime-tool-cursor.js')).readToolOperationSource(tx, parent)
  if (work.novelId !== original.data.input.novelId || work.novelId !== operation.taskRoot.novelId || work.count !== (original.data.input.args.count ?? 1)
    || runtimeJson(original.data.input.args).hash !== original.data.input.normalization.normalizedArgsHash
    || input.parentInputHash !== parent.inputHash || input.workHash !== runtimeJson(work).hash || input.chargeKey !== `image:${parent.id}`
    || input.usageLogId !== createHash('sha256').update(`cover:${parent.id}:0`).digest('hex')
    || work.prompt !== enforceCoverTitleInPrompt(original.data.input.args.prompt.trim(), work.title, work.displayTitle)
    || runtimeJson(input.request).hash !== runtimeJson(coverRequest(work)).hash || attempt.provider !== work.route.provider || attempt.model !== work.route.modelName
    || !attempt.requestSnapshot || runtimeJson(attempt.requestSnapshot).hash !== attempt.requestHash
    || runtimeJson(attempt.requestSnapshot).hash !== runtimeJson({ provider: attempt.provider, model: attempt.model, request: input.request }).hash) return null
  const log = await tx.aiUsageLog.findUnique({ where: { id: input.usageLogId } })
  if (!log || log.userId !== operation.taskRoot.userId || log.novelId !== work.novelId || log.agentRunId !== parent.originRunId
    || log.providerType !== 'image' || log.action !== 'generateCoverImage' || log.modelName !== work.route.modelName || log.providerMode !== work.route.providerMode
    || log.targetType !== 'imageCharge' || log.targetId !== input.chargeKey || log.creditChargeMilli !== 6000
    || !log.billingEvidence || runtimeJson(log.billingEvidence).hash !== runtimeJson({ taskRootId: operation.taskRootId, operationId: operation.id }).hash) return null
  const debit = await tx.creditLedgerEntry.findUnique({ where: { idempotencyKey: input.chargeKey } })
  const metadata = debit?.metadata && typeof debit.metadata === 'object' && !Array.isArray(debit.metadata) ? debit.metadata.agentCover : null
  const binding = { version: 1, taskRootId: operation.taskRootId, parentOperationId: parent.id, parentInputHash: parent.inputHash,
    operationId: operation.id, requestHash: attempt.requestHash, workHash: input.workHash, tariff: work.tariff, amountMilli: work.amountMilli, chargeKey: input.chargeKey }
  if (!debit || debit.userId !== operation.taskRoot.userId || debit.sourceType !== 'image_generation' || debit.kind !== 'usage' || debit.deltaMilli !== -6000
    || debit.referenceId !== operation.id || !metadata || runtimeJson(metadata).hash !== runtimeJson(binding).hash) return null
  return { attempt, operation, parent, input, work, debit }
}

/** Completed non-Token observation only. Unknown transport and forged or
 * incomplete receipts remain unresolved, even if a refund has already settled. */
export async function readCoverUnit(tx: RuntimeTx, attemptId: string) {
  const admitted = await readCoverAdmission(tx, attemptId)
  if (!admitted) return null
  const { attempt, operation, parent, input, work, debit } = admitted
  if (!attempt.dispatchedAt || !['succeeded', 'failed'].includes(attempt.status) || !attempt.resultHash
    || runtimeJson(attempt.result).hash !== attempt.resultHash) return null
  const raw = z.object({ outcome: z.enum(['succeeded', 'failed']), result: imageBlobSchema }).strict().safeParse(attempt.result)
  if (!raw.success || raw.data.outcome !== attempt.status || (raw.data.result.httpStatus >= 200 && raw.data.result.httpStatus < 300) !== (attempt.status === 'succeeded')) return null
  const event = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `settlement:${operation.id}` } })
  const proof = coverUnitSchema.safeParse(event?.payload)
  if (!proof.success || !event || event.type !== 'cover.fixed_unit.observed' || event.taskRootId !== operation.taskRootId || event.operationId !== operation.id
    || runtimeJson(proof.data).hash !== runtimeJson({ ...proof.data, operationId: operation.id, parentOperationId: parent.id, attemptId,
      parentInputHash: parent.inputHash, requestHash: attempt.requestHash, resultHash: attempt.resultHash, debitId: debit.id,
      chargeKey: input.chargeKey, tariff: work.tariff, chargedMilli: 6000, units: 1 }).hash) return null
  const resultEvent = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `result:${attempt.id}:${attempt.resultHash}` } })
  if (!resultEvent || resultEvent.type !== 'provider.result.recorded' || resultEvent.taskRootId !== operation.taskRootId || resultEvent.operationId !== operation.id
    || runtimeJson(resultEvent.payload).hash !== runtimeJson({ attemptId, status: attempt.status, resultHash: attempt.resultHash }).hash) return null
  const usage = await tx.agentProviderUsageReceipt.findUnique({ where: { attemptId } })
  if (!usage || usage.source !== 'fixed_unit' || usage.settlementStatus !== 'fixed_unit' || usage.revision !== 1
    || usage.observationHash !== runtimeJson(coverUnitUsage).hash || usage.promptTokens !== null || usage.completionTokens !== null
    || usage.cacheHitTokens !== null || usage.cacheMissTokens !== null) return null
  return { ...admitted, proof: proof.data }
}

/** No lease: authentic late provider accounting survives cancellation. This
 * never grants another generation, asset creation or cursor/manuscript effect. */
export async function writeCoverUnit(tx: RuntimeTx, attemptId: string, outcome: z.infer<typeof coverUnitSchema>['outcome']) {
  const admitted = await readCoverAdmission(tx, attemptId)
  if (!admitted) return runtimeError('RUNTIME_RECEIPT_INVALID', '图片固定费用缺少原请求及扣费回执。')
  const { attempt, operation, parent, input, work, debit } = admitted
  if (!attempt.dispatchedAt || !attempt.resultHash || !['succeeded', 'failed'].includes(attempt.status) || runtimeJson(attempt.result).hash !== attempt.resultHash) return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '图片原响应尚未核实。')
  const payload = coverUnitSchema.parse({ operationId: operation.id, parentOperationId: parent.id, attemptId, parentInputHash: parent.inputHash,
    requestHash: attempt.requestHash, resultHash: attempt.resultHash, debitId: debit.id, chargeKey: input.chargeKey,
    tariff: work.tariff, chargedMilli: 6000, units: 1, outcome })
  const eventKey = `settlement:${operation.id}`, existing = await tx.agentExecutionOutbox.findUnique({ where: { eventKey } })
  if (existing && (existing.type !== 'cover.fixed_unit.observed' || runtimeJson(existing.payload).hash !== runtimeJson(payload).hash)) return runtimeError('RUNTIME_IDENTITY_CONFLICT', '图片单位回执已有其他结果。')
  if (!existing) await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: operation.taskRootId, operationId: operation.id, runId: attempt.runId,
    eventKey, type: 'cover.fixed_unit.observed', payload } })
  const observationHash = runtimeJson(coverUnitUsage).hash, old = await tx.agentProviderUsageReceipt.findUnique({ where: { attemptId } })
  if (old && (old.revision !== 1 || old.observationHash !== observationHash)) return runtimeError('RUNTIME_IDENTITY_CONFLICT', '图片用量不得替换原观察。')
  if (!old) await tx.agentProviderUsageReceipt.create({ data: { attemptId, revision: 1, ...coverUnitUsage, observationHash, settlementStatus: 'fixed_unit' } })
  await tx.aiUsageLog.update({ where: { id: input.usageLogId }, data: { usageSource: 'fixed_unit', billingStatus: 'observed',
    creditChargeMilli: 6000, requestTokens: null, responseTokens: null } })
  return payload
}

export async function coverGoalScope(tx: RuntimeTx, goal: { id: string; userId: string; novelId: string; sessionId: string }, unit: NonNullable<Awaited<ReturnType<typeof readCoverUnit>>>) {
  if (goal.userId !== unit.operation.taskRoot.userId || goal.novelId !== unit.work.novelId) return false
  if (goal.sessionId === unit.operation.taskRoot.sessionId) return true
  // A delegated original task owns a separate session. Same author/novel is
  // insufficient: retain its actual bounded child grant and parent lineage.
  const grant = await tx.agentChildExecutionGrant.findUnique({ where: { childRunId: unit.attempt.runId }, include: { childRun: true } })
  if (!grant || grant.childRun.taskRootId !== unit.operation.taskRootId) return false
  ;(await import('./runtime-child.js')).verifyChildGrant(grant)
  const parent = await tx.agentTaskRoot.findUnique({ where: { id: grant.parentRootId } })
  if (!parent || parent.userId !== goal.userId || parent.novelId !== goal.novelId || parent.sessionId !== goal.sessionId) return false
  if (await tx.agentGoalExecution.findFirst({ where: { goalId: goal.id, taskRootId: grant.parentRootId } })) return true
  const ownedGoal = await tx.agentGoal.findUniqueOrThrow({ where: { id: goal.id } })
  const activation = await (await import('./goal-activation.js')).readGoalActivationReceipt(tx, ownedGoal)
  return activation?.receipt.sourceRootId === grant.parentRootId
}

/** Ordinary-task adoption: the usage log is an internal mirror, not another
 * bill. Seed the authenticated wallet receipt once and keep the durable unit
 * observation separate (zero additional Credits, null Token measurements). */
export async function adoptCoverGoalAccounting(tx: RuntimeTx, goalId: string, log: { id: string; userId: string; agentRunId: string | null; billingEvidence: unknown }) {
  const evidence = z.object({ operationId: z.string(), taskRootId: z.string() }).safeParse(log.billingEvidence)
  if (!evidence.success) return { mirror: false, seeded: false }
  const attempts = await tx.agentProviderAttempt.findMany({ where: { operationId: evidence.data.operationId }, select: { id: true } })
  if (attempts.length !== 1) return { mirror: false, seeded: false }
  const unit = await readCoverUnit(tx, attempts[0].id)
  if (!unit || unit.input.usageLogId !== log.id || unit.operation.taskRoot.userId !== log.userId || unit.operation.taskRootId !== evidence.data.taskRootId
    || unit.parent.originRunId !== log.agentRunId) return { mirror: false, seeded: false }
  const goal = await tx.agentGoal.findUniqueOrThrow({ where: { id: goalId } })
  if (!await coverGoalScope(tx, goal, unit)) return runtimeError('GOAL_SCOPE_MISMATCH', '封面原费用不属于该目标。')
  const sourceKey = `ledger:${unit.debit.id}`, prior = await tx.agentGoalUsage.findUnique({ where: { sourceKey } })
  if (prior && (prior.goalId !== goalId || prior.runId !== unit.attempt.runId)) return runtimeError('GOAL_SCOPE_MISMATCH', '封面费用已有其他目标归属。')
  if (prior) return { mirror: true, seeded: false }
  const refund = await tx.creditLedgerEntry.findUnique({ where: { idempotencyKey: `refund:${unit.input.chargeKey}` } })
  if (refund) {
    const metadata = refund.metadata && typeof refund.metadata === 'object' && !Array.isArray(refund.metadata) ? refund.metadata : null
    if (refund.userId !== log.userId || refund.kind !== 'refund' || refund.sourceType !== 'image_generation' || refund.deltaMilli !== 6000
      || metadata?.originalEntryId !== unit.debit.id) return runtimeError('RUNTIME_RECEIPT_INVALID', '封面退款与原费用不一致。')
  }
  const creditsMicros = refund ? 0n : 6000000n
  await tx.agentGoalUsage.create({ data: { sourceKey, goalId, runId: unit.attempt.runId, status: 'known', creditsMicros } })
  await tx.agentGoalBudget.update({ where: { goalId }, data: { creditsUsedMicros: { increment: creditsMicros } } })
  await (await import('./goal-store.js')).changeGoal(tx, goal, {}, 'usage.updated')
  return { mirror: true, seeded: true }
}
