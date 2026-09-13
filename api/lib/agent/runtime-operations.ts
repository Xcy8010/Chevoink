import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { databaseNow, runtimeError, runtimeId, runtimeJson, runtimeTransaction, type RuntimeTx } from './runtime-common.js'
import { withRunLease, type RunLeaseToken } from './runtime-lease.js'
import { assertProviderBudget } from './runtime-budget.js'
import { assertPendingProviderState } from './runtime-state.js'

async function outbox(tx: RuntimeTx, input: { taskRootId: string; operationId: string; runId: string; eventKey: string; type: string; payload: Prisma.InputJsonValue }) {
  return tx.agentExecutionOutbox.create({ data: { id: randomUUID(), ...input } })
}

async function ownedOperation(tx: RuntimeTx, token: RunLeaseToken, operationId: string) {
  const operation = await tx.agentOperation.findFirst({ where: { id: operationId, taskRootId: token.taskRootId } })
  if (!operation) return runtimeError('RUNTIME_SCOPE_MISMATCH', '操作不属于当前任务。')
  if (!operation.inputSnapshot || runtimeJson(operation.inputSnapshot).hash !== operation.inputHash) runtimeError('RUNTIME_RECEIPT_INVALID', '原操作快照缺失或损坏，不能重新推测输入。')
  return operation
}

/** Frozen admission cannot override permissions narrowed since preparation.
 * Receipt replay is intentionally checked before this new-effect boundary. */
export async function assertCurrentToolPolicy(tx: RuntimeTx, token: RunLeaseToken, operation: Awaited<ReturnType<typeof ownedOperation>>) {
  if (operation.kind !== 'tool') return
  const envelope = operation.inputSnapshot as Prisma.JsonObject
  const input = envelope.input as Prisma.JsonObject | undefined
  const normalization = input?.normalization as Prisma.JsonObject | undefined
  // Internal primitives and recorded rejection observations have no cursor grant.
  if (!normalization) return
  const [{ readExecutionStateInTransaction }, { applySessionToolPolicy }, { getToolByName }] = await Promise.all([
    import('./runtime-state.js'), import('./agents.js'), import('./tools/registry.js'),
  ])
  const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: token.taskRootId } })
  await tx.$queryRaw`SELECT id FROM agent_sessions WHERE id = ${root.sessionId} FOR SHARE`
  const session = await tx.agentSession.findUnique({ where: { id: root.sessionId } })
  // This existing, explicitly frozen recovery reader is intentionally absent
  // from the public legacy registry; use its real metadata, not a blanket grant.
  let tool = getToolByName(operation.action)
  if (operation.action === 'execution_context_read') {
    const { executionContextReadTool: reader } = await import('./tools/task-context-tools.js')
    tool = { ...reader, execute: (ctx, args) => reader.execute(ctx, reader.parameters.parse(args)) }
  }
  if (!session || session.userId !== token.userId || session.novelId !== root.novelId || !tool) return runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '当前会话不再允许执行原工具。')
  const { configuration } = await readExecutionStateInTransaction(tx, token.taskRootId)
  const grant = configuration.toolAuthority.find(item => item.name === operation.action)
  if (!grant || grant.permission === 'deny') return runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '原任务没有此次工具授权。')
  const effective = applySessionToolPolicy([{ ...tool, permission: { ...tool.permission, [configuration.mode]: grant.permission } }],
    configuration.mode, session.toolPolicy, session.sandboxMode === 'read_only' ? 'read_only' : 'workspace')[0]
  if (!effective || effective.permission[configuration.mode] === 'deny') return runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '会话权限已收紧，本次操作尚未执行。')
  if (effective.permission[configuration.mode] === 'ask' || grant.alwaysConfirm) {
    if (typeof input?.callId !== 'string' || typeof normalization.sourceSnapshotHash !== 'string'
      || typeof normalization.rawArguments !== 'string' || typeof normalization.normalizedArgsHash !== 'string') return runtimeError('RUNTIME_RECEIPT_INVALID', '原工具审批身份缺失。')
    const { assertToolApproval } = await import('./runtime-approval.js')
    await assertToolApproval(tx, token, normalization.sourceSnapshotHash, input.callId, operation.action, normalization.rawArguments, normalization.normalizedArgsHash)
  }
}

type PrepareOperationInput = {
  key: string; kind: 'provider' | 'tool' | 'internal'; action: string; input: Prisma.InputJsonValue; parentOperationId?: string
}

export async function prepareOperation(token: RunLeaseToken, input: PrepareOperationInput) {
  return withRunLease({ ...token }, prepareOperationWrite(token, input))
}

/** Caller must already hold withRunLease in this same transaction. */
export async function prepareOperationInTransaction(tx: RuntimeTx, token: RunLeaseToken, input: PrepareOperationInput) {
  return prepareOperationWrite(token, input)(tx)
}

function prepareOperationWrite(token: RunLeaseToken, input: PrepareOperationInput) {
  token = { ...token }
  runtimeId(input.key, 160); runtimeId(input.action, 96)
  if (!['provider', 'tool', 'internal'].includes(input.kind)) runtimeError('RUNTIME_INPUT_INVALID', '未知操作类型。')
  if (input.parentOperationId) runtimeId(input.parentOperationId)
  const captured = { ...input }
  const snapshot = runtimeJson({ kind: captured.kind, action: captured.action, parentOperationId: captured.parentOperationId ?? null, input: captured.input })
  return async (tx: RuntimeTx) => {
    const old = await tx.agentOperation.findUnique({ where: { taskRootId_operationKey: { taskRootId: token.taskRootId, operationKey: captured.key } } })
    if (old) {
      if (old.inputHash !== snapshot.hash) runtimeError('RUNTIME_IDENTITY_CONFLICT', '同一操作键的内容已变化，拒绝复用其他结果。')
      return ownedOperation(tx, token, old.id)
    }
    if (captured.parentOperationId) await ownedOperation(tx, token, captured.parentOperationId)
    return tx.agentOperation.create({ data: {
      id: randomUUID(), taskRootId: token.taskRootId, operationKey: captured.key, originRunId: token.runId,
      parentOperationId: captured.parentOperationId ?? null, kind: captured.kind, action: captured.action, inputHash: snapshot.hash, inputSnapshot: snapshot.value,
    } })
  }
}

/** Work must perform only DB effects through tx, after caller's tool/effect authorization. */
export async function commitOperationEffect(token: RunLeaseToken, operationId: string, inputHash: string,
  work: (tx: RuntimeTx) => Promise<Prisma.InputJsonValue>) {
  token = { ...token }
  return withRunLease(token, tx => commitOperationEffectInTransaction(tx, token, operationId, inputHash, work))
}

/** Caller holds the same root/lease transaction for admission and effects. */
export async function commitOperationEffectInTransaction(tx: RuntimeTx, token: RunLeaseToken, operationId: string, inputHash: string,
  work: (tx: RuntimeTx) => Promise<Prisma.InputJsonValue>) {
    const operation = await ownedOperation(tx, token, operationId)
    if (operation.inputHash !== inputHash || operation.kind === 'provider') runtimeError('RUNTIME_IDENTITY_CONFLICT', '业务操作身份不匹配。')
    const existing = await tx.agentEffectReceipt.findUnique({ where: { operationId } })
    if (existing) {
      const savedFailure = operation.kind === 'tool' && operation.status === 'failed' && existing.result && typeof existing.result === 'object'
        && !Array.isArray(existing.result) && existing.result.outcome === 'failed' && existing.result.effectApplied === false
      if ((!savedFailure && operation.status !== 'succeeded') || runtimeJson(existing.result).hash !== existing.resultHash) runtimeError('RUNTIME_RECEIPT_INVALID', '业务回执与状态不一致，需要核对。')
      return existing
    }
    if (operation.status !== 'prepared') runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '业务操作不是可安全提交状态。')
    await assertCurrentToolPolicy(tx, token, operation)
    const raw = await work(tx)
    if (operation.kind === 'tool') await bindMemoryJobOwnership(tx, token.taskRootId, operation.id, raw)
    const result = runtimeJson(raw)
    const receipt = await tx.agentEffectReceipt.create({ data: { operationId, runId: token.runId, ownerEpoch: token.epoch, result: result.value, resultHash: result.hash } })
    await tx.agentOperation.update({ where: { id: operationId }, data: { status: 'succeeded' } })
    await outbox(tx, { taskRootId: token.taskRootId, operationId, runId: token.runId, eventKey: `effect:${operationId}`, type: 'effect.committed', payload: { operationId, resultHash: result.hash } })
    return receipt
}

/** Confirmed non-effect outcome only. Unknown transaction/network failures must
 * stay pending for reconciliation, never be described as a definite failure. */
export async function recordToolFailure(token: RunLeaseToken, input: { operationId: string; inputHash: string; code: string; output: string; summary: string }) {
  return withRunLease({ ...token }, toolFailureWrite(token, input))
}

/** Caller must hold the lease/root lock in this transaction. */
export async function recordToolFailureInTransaction(tx: RuntimeTx, token: RunLeaseToken, input: { operationId: string; inputHash: string; code: string; output: string; summary: string }) {
  return toolFailureWrite(token, input)(tx)
}

function toolFailureWrite(token: RunLeaseToken, input: { operationId: string; inputHash: string; code: string; output: string; summary: string }) {
  token = { ...token }; input = { ...input }
  runtimeId(input.code, 96)
  const result = runtimeJson({ outcome: 'failed', effectApplied: false, code: input.code, toolResult: { output: input.output, summary: input.summary } })
  return async (tx: RuntimeTx) => {
    const operation = await ownedOperation(tx, token, input.operationId)
    if (operation.kind !== 'tool' || operation.inputHash !== input.inputHash) runtimeError('RUNTIME_IDENTITY_CONFLICT', '失败观察不属于原工具操作。')
    const existing = await tx.agentEffectReceipt.findUnique({ where: { operationId: operation.id } })
    if (existing) {
      if (runtimeJson(existing.result).hash !== existing.resultHash) runtimeError('RUNTIME_RECEIPT_INVALID', '工具回执损坏。')
      if (operation.status === 'succeeded') return existing // A concurrent confirmed success is never downgraded.
      if (operation.status !== 'failed' || existing.resultHash !== result.hash) runtimeError('RUNTIME_IDENTITY_CONFLICT', '同一工具已有不同终态观察。')
      return existing
    }
    if (operation.status !== 'prepared') runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '工具结果尚不能确认。')
    const receipt = await tx.agentEffectReceipt.create({ data: { operationId: operation.id, runId: token.runId, ownerEpoch: token.epoch,
      result: result.value, resultHash: result.hash } })
    await tx.agentOperation.update({ where: { id: operation.id }, data: { status: 'failed' } })
    await outbox(tx, { taskRootId: token.taskRootId, operationId: operation.id, runId: token.runId, eventKey: `observation:${operation.id}`,
      type: 'tool.observation.recorded', payload: { operationId: operation.id, outcome: 'failed', resultHash: result.hash } })
    return receipt
  }
}

export async function prepareProviderAttempt(token: RunLeaseToken, input: {
  operationId: string; attemptKey: string; provider: string; model: string; request: Prisma.InputJsonValue
}) {
  token = { ...token }
  const captured = { ...input }
  runtimeId(captured.attemptKey); runtimeId(captured.provider, 96); runtimeId(captured.model, 160)
  const snapshot = runtimeJson({ provider: captured.provider, model: captured.model, request: captured.request })
  return withRunLease(token, async tx => {
    const operation = await ownedOperation(tx, token, captured.operationId)
    if (operation.kind !== 'provider') runtimeError('RUNTIME_INPUT_INVALID', '供应商尝试必须属于独立provider操作。')
    const existing = await tx.agentProviderAttempt.findUnique({ where: { operationId_attemptKey: { operationId: operation.id, attemptKey: captured.attemptKey } } })
    if (existing) {
      if (existing.requestHash !== snapshot.hash) runtimeError('RUNTIME_IDENTITY_CONFLICT', '供应商尝试的请求已变化。')
      if (!existing.requestSnapshot || runtimeJson(existing.requestSnapshot).hash !== existing.requestHash) runtimeError('RUNTIME_RECEIPT_INVALID', '原供应商请求快照缺失或损坏。')
      // An undispatched attempt can be recovered by the current owner; never rebind a sent one.
      return existing.status === 'prepared' ? tx.agentProviderAttempt.update({ where: { id: existing.id }, data: { runId: token.runId, ownerEpoch: token.epoch } }) : existing
    }
    if (operation.status !== 'prepared' || await tx.agentProviderAttempt.count({ where: { operationId: operation.id } })) {
      runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '已有供应商尝试必须先核对；不能自动新建尝试重复请求。')
    }
    return tx.agentProviderAttempt.create({ data: {
      id: randomUUID(), operationId: operation.id, attemptKey: captured.attemptKey, runId: token.runId, ownerEpoch: token.epoch,
      provider: captured.provider, model: captured.model, requestHash: snapshot.hash, requestSnapshot: snapshot.value,
    } })
  })
}

/** Only dispatchGranted=true permits a network call; a lost commit reply requires reconciliation. */
export async function markProviderDispatched(token: RunLeaseToken, attemptId: string) {
  token = { ...token }
  return withRunLease(token, async tx => {
    const attempt = await tx.agentProviderAttempt.findUnique({ where: { id: attemptId } })
    if (!attempt) return runtimeError('RUNTIME_SCOPE_MISMATCH', '供应商尝试不存在。')
    const operation = await ownedOperation(tx, token, attempt.operationId)
    if (!attempt.requestSnapshot || runtimeJson(attempt.requestSnapshot).hash !== attempt.requestHash) runtimeError('RUNTIME_RECEIPT_INVALID', '原供应商请求快照缺失或损坏。')
    if (attempt.status !== 'prepared') return { dispatchGranted: false, attempt }
    if (attempt.runId !== token.runId || attempt.ownerEpoch !== token.epoch) runtimeError('RUNTIME_LEASE_LOST', '供应商尝试未归属当前执行者。')
    if (operation.parentOperationId) await assertCurrentToolPolicy(tx, token, await ownedOperation(tx, token, operation.parentOperationId))
    await assertProviderBudget(tx, token.taskRootId)
    await assertPendingProviderState(tx, token.taskRootId, attempt.operationId)
    const updated = await tx.agentProviderAttempt.update({ where: { id: attempt.id }, data: { status: 'dispatched', dispatchedAt: await databaseNow(tx) } })
    await tx.agentOperation.update({ where: { id: attempt.operationId }, data: { status: 'dispatched' } })
    return { dispatchGranted: true, attempt: updated }
  })
}

/** Internal transaction primitive; callers must retain the root lock through all dependent writes. */
export async function lockOwnedAttempt(tx: RuntimeTx, userId: string, attemptId: string, requestHash: string) {
  const initial = await tx.agentProviderAttempt.findFirst({ where: { id: attemptId, operation: { taskRoot: { userId } } }, include: { operation: true } })
  if (!initial) return runtimeError('RUNTIME_SCOPE_MISMATCH', '供应商尝试不存在或无权访问。')
  // Same root lock order as effects. Late evidence needs no lease, but grants no execution rights.
  await tx.$queryRaw`SELECT id FROM agent_task_roots WHERE id = ${initial.operation.taskRootId} FOR UPDATE`
  const attempt = await tx.agentProviderAttempt.findUniqueOrThrow({ where: { id: attemptId }, include: { operation: true } })
  if (attempt.requestHash !== requestHash) runtimeError('RUNTIME_IDENTITY_CONFLICT', '供应商回执不匹配原请求。')
  if (!attempt.requestSnapshot || runtimeJson(attempt.requestSnapshot).hash !== attempt.requestHash) runtimeError('RUNTIME_RECEIPT_INVALID', '原供应商请求快照缺失或损坏。')
  if (!attempt.dispatchedAt) runtimeError('RUNTIME_NOT_DISPATCHED', '未派发的请求不能保存供应商执行结果。')
  return attempt
}

/** Persist paid evidence even after cancellation/lease loss; never run tools or charge here. */
export async function recordProviderResult(input: {
  userId: string; attemptId: string; requestHash: string; outcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown'; result: Prisma.InputJsonValue
}) {
  const captured = { ...input }
  if (!['succeeded', 'failed', 'cancelled', 'unknown'].includes(captured.outcome)) runtimeError('RUNTIME_INPUT_INVALID', '供应商结果状态无效。')
  const result = runtimeJson({ outcome: captured.outcome, result: captured.result })
  return runtimeTransaction(async tx => {
    const attempt = await lockOwnedAttempt(tx, captured.userId, captured.attemptId, captured.requestHash)
    if ((attempt.resultHash !== null || attempt.result !== null)
      && (attempt.resultHash === null || attempt.result === null || runtimeJson(attempt.result).hash !== attempt.resultHash)) {
      runtimeError('RUNTIME_RECEIPT_INVALID', '已保存的供应商结果损坏，不能作为恢复依据。')
    }
    if (attempt.resultHash === result.hash) return tx.agentProviderAttempt.findUniqueOrThrow({ where: { id: attempt.id } })
    if (!['dispatched', 'unknown'].includes(attempt.status)) runtimeError('RUNTIME_IDENTITY_CONFLICT', '供应商终态已有不同结果，拒绝覆盖。')
    const updated = await tx.agentProviderAttempt.update({ where: { id: attempt.id }, data: {
      status: captured.outcome, result: result.value, resultHash: result.hash,
      completedAt: captured.outcome === 'unknown' ? null : await databaseNow(tx),
    } })
    await tx.agentOperation.update({ where: { id: attempt.operationId }, data: { status: captured.outcome } })
    await outbox(tx, { taskRootId: attempt.operation.taskRootId, operationId: attempt.operationId, runId: attempt.runId,
      eventKey: `result:${attempt.id}:${result.hash}`, type: 'provider.result.recorded', payload: { attemptId: attempt.id, status: captured.outcome, resultHash: result.hash } })
    return updated
  })
}

export type ProviderUsageObservation = {
  source: 'reported' | 'estimated' | 'unknown'
  promptTokens: number | null; completionTokens: number | null; cacheHitTokens: number | null; cacheMissTokens: number | null
}

function validateUsage(usage: ProviderUsageObservation): void {
  for (const value of [usage.promptTokens, usage.completionTokens, usage.cacheHitTokens, usage.cacheMissTokens]) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0 || value > 2147483647)) runtimeError('RUNTIME_USAGE_INVALID', '供应商用量无效，不能作为零成本结算。')
  }
  if (!['reported', 'estimated', 'unknown'].includes(usage.source)
    || (usage.source !== 'unknown' && (usage.promptTokens === null || usage.completionTokens === null))) runtimeError('RUNTIME_USAGE_INVALID', '用量来源与完整性不一致。')
  const hit = usage.cacheHitTokens, miss = usage.cacheMissTokens, prompt = usage.promptTokens
  if ((hit !== null || miss !== null) && (prompt === null || (hit ?? 0) > prompt || (miss ?? 0) > prompt
    || (hit !== null && miss !== null && hit + miss !== prompt) || usage.source === 'estimated')) runtimeError('RUNTIME_USAGE_INVALID', '缓存用量与输入总量不一致。')
}

export async function recordProviderUsage(input: { userId: string; attemptId: string; requestHash: string; revision: number; usage: ProviderUsageObservation }) {
  const captured = { ...input, usage: { ...input.usage } }
  if (!Number.isInteger(captured.revision) || captured.revision < 1 || captured.revision > 2147483647) runtimeError('RUNTIME_USAGE_INVALID', '用量版本无效。')
  validateUsage(captured.usage)
  const snapshot = runtimeJson(captured.usage)
  return runtimeTransaction(async tx => {
    const attempt = await lockOwnedAttempt(tx, captured.userId, captured.attemptId, captured.requestHash)
    const old = await tx.agentProviderUsageReceipt.findUnique({ where: { attemptId: attempt.id } })
    if (old) {
      const storedUsage = { source: old.source, promptTokens: old.promptTokens, completionTokens: old.completionTokens, cacheHitTokens: old.cacheHitTokens, cacheMissTokens: old.cacheMissTokens }
      if (runtimeJson(storedUsage).hash !== old.observationHash) runtimeError('RUNTIME_RECEIPT_INVALID', '已保存的供应商用量损坏，需要对账而非覆盖。')
      if (captured.revision < old.revision) return old
      if (captured.revision === old.revision) {
        if (snapshot.hash !== old.observationHash) runtimeError('RUNTIME_IDENTITY_CONFLICT', '同一用量版本出现不同内容。')
        return old
      }
      if (old.settlementStatus !== 'pending') runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '已结算用量不能覆盖，需要独立调整回执。')
      if (old.source === 'reported' && captured.usage.source !== 'reported') runtimeError('RUNTIME_USAGE_INVALID', '实测用量不能降级。')
      if (old.source !== 'estimated') {
        for (const field of ['promptTokens', 'completionTokens', 'cacheHitTokens', 'cacheMissTokens'] as const) {
          const previous = old[field], current = captured.usage[field]
          if (previous !== null && (current === null || current < previous || captured.usage.source === 'estimated')) {
            runtimeError('RUNTIME_USAGE_INVALID', '已观测的累计用量不能遗失、倒退或变成估算。')
          }
        }
      }
    }
    const data = { ...captured.usage, revision: captured.revision, observationHash: snapshot.hash }
    const receipt = await tx.agentProviderUsageReceipt.upsert({ where: { attemptId: attempt.id }, create: { attemptId: attempt.id, ...data }, update: data })
    await outbox(tx, { taskRootId: attempt.operation.taskRootId, operationId: attempt.operationId, runId: attempt.runId,
      eventKey: `usage:${attempt.id}:${captured.revision}`, type: 'provider.usage.recorded', payload: { attemptId: attempt.id, revision: captured.revision, ...captured.usage } })
    return receipt
  })
}

/** Stamp derivative ownership in the SAME transaction that creates its source
 * effect. The legacy worker must never claim these durable jobs. */
async function bindMemoryJobOwnership(tx: RuntimeTx, taskRootId: string, operationId: string, result: unknown) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return
  const value = result as { memoryJobId?: unknown; memoryJobIds?: unknown }
  const ids = [...(typeof value.memoryJobId === 'string' ? [value.memoryJobId] : []), ...(Array.isArray(value.memoryJobIds) ? value.memoryJobIds : [])]
  if (!ids.length) return
  const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: taskRootId } })
  for (const id of new Set(ids)) {
    if (typeof id !== 'string') return runtimeError('RUNTIME_RECEIPT_INVALID', '记忆任务身份无效。')
    const job = await tx.memoryExtractionJob.findUnique({ where: { id } })
    if (!job || job.novelId !== root.novelId || !job.diff || typeof job.diff !== 'object' || Array.isArray(job.diff)) return runtimeError('RUNTIME_SCOPE_MISMATCH', '记忆任务不属于原任务作品。')
    if (job.status === 'processing') return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '记忆任务已被旧处理器领取，不能并发绑定。')
    if (job.diff.durableTaskRootId && (job.diff.durableTaskRootId !== root.id || job.diff.durableOperationId !== operationId)) return runtimeError('RUNTIME_IDENTITY_CONFLICT', '记忆任务已绑定其他来源。')
    await tx.memoryExtractionJob.update({ where: { id }, data: { diff: { ...job.diff, durableTaskRootId: root.id, durableOperationId: operationId } } })
  }
}
