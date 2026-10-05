import { z } from 'zod'
import { COMPATIBILITY_TOKEN_LIMIT, untilCompletionControl } from './execution-control.js'
import { runtimeError, runtimeJson, type RuntimeTx } from './runtime-common.js'
import { withRunLease, type RunLeaseToken } from './runtime-lease.js'

const integer = z.number().int().nonnegative().max(2147483647)
const policyFields = {
  initialTokens: integer.min(500), tokenCeiling: integer.min(500),
  budgetSlice: integer.positive(), maxCheckpoints: integer, maxCompactions: integer,
  wallClockMs: integer.positive(), longWallClockMs: integer.positive(),
}
const legacyPolicySchema = z.discriminatedUnion('version', [
  z.object({ ...policyFields, version: z.literal(1) }).strict(),
  z.object({ ...policyFields, version: z.literal(2), initialTurns: integer.positive(), turnSlice: integer.positive() }).strict(),
]).refine(value => value.initialTokens <= value.tokenCeiling && value.wallClockMs <= value.longWallClockMs
  && (value.version === 1 || BigInt(value.initialTurns) + BigInt(value.maxCheckpoints) * BigInt(value.turnSlice) <= 2147483647n))
const untilCompletionPolicySchema = z.object({ version: z.literal(3), controlPolicy: z.literal('until_completion'),
  compatibilityTokenLimit: z.literal(COMPATIBILITY_TOKEN_LIMIT) }).strict()
const policySchema = z.union([legacyPolicySchema, untilCompletionPolicySchema])
export type TaskBudgetPolicy = z.infer<typeof policySchema>

/** Historical slices remain receipt evidence; they do not cap current execution. */
export function taskTurnLimit(policy: TaskBudgetPolicy, checkpointCount: number): number | null {
  if (!Number.isSafeInteger(checkpointCount) || checkpointCount < 0) runtimeError('RUNTIME_BUDGET_INVALID', '检查点计数不合法。')
  return untilCompletionControl(policy.version === 3 ? 'system_default' : 'unknown_legacy').limits.turns
}

export function createTaskBudgetPolicy(tokenBudget?: number) {
  if (tokenBudget !== undefined && (!Number.isSafeInteger(tokenBudget) || tokenBudget < 0)) runtimeError('RUNTIME_BUDGET_INVALID', '任务预算必须为有效整数。')
  return { ...runtimeJson({ version: 3, controlPolicy: 'until_completion', compatibilityTokenLimit: COMPATIBILITY_TOKEN_LIMIT }), initialTokens: COMPATIBILITY_TOKEN_LIMIT }
}

/** Caller holds the task-root lock. Sums each attempt's latest observation once across all runs. */
export async function readTaskBudgetInTransaction(tx: RuntimeTx, taskRootId: string) {
  const budget = await tx.agentTaskBudget.findUnique({ where: { taskRootId }, include: { taskRoot: { select: { createdAt: true, novelId: true } } } })
  if (!budget) return runtimeError('RUNTIME_BUDGET_REQUIRED', '原任务缺少预算合同，不能在恢复时重新分配额度。')
  const parsed = policySchema.safeParse(budget.policy)
  if (!parsed.success || runtimeJson(budget.policy).hash !== budget.policyHash) return runtimeError('RUNTIME_BUDGET_INVALID', '原预算合同损坏。')
  const policy = parsed.data
  // Checkpoint receipts, not a mutable counter alone, authorize additional slices.
  const checkpoints = await tx.agentRuntimeCheckpoint.findMany({ where: { taskRootId }, orderBy: { checkpointIndex: 'asc' } })
  if (checkpoints.length !== budget.checkpointCount || checkpoints.some((row, i) => row.checkpointIndex !== i + 1)
    || budget.compactionCount < budget.checkpointCount) runtimeError('RUNTIME_BUDGET_INVALID', '检查点回执与预算计数不一致。')
  for (const checkpoint of checkpoints) {
    const event = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `checkpoint:${taskRootId}:${checkpoint.checkpointIndex}` } })
    if (runtimeJson(checkpoint.snapshot).hash !== checkpoint.snapshotHash
      || runtimeJson({ expectedCheckpointCount: checkpoint.checkpointIndex - 1, progressOperationId: checkpoint.progressOperationId, snapshot: checkpoint.snapshot }).hash !== checkpoint.requestHash
      || !event || event.taskRootId !== taskRootId || event.type !== 'checkpoint.committed'
      || runtimeJson(event.payload).hash !== runtimeJson({ checkpointIndex: checkpoint.checkpointIndex, snapshotHash: checkpoint.snapshotHash, progressOperationId: checkpoint.progressOperationId }).hash) {
      runtimeError('RUNTIME_RECEIPT_INVALID', '检查点快照或事件损坏，不能仅凭预算计数继续。')
    }
  }
  const expectedLimit = policy.version === 3 ? COMPATIBILITY_TOKEN_LIMIT : Math.min(policy.tokenCeiling, policy.initialTokens + budget.checkpointCount * policy.budgetSlice)
  if (budget.tokenLimit !== expectedLimit || (policy.version === 3 ? budget.checkpointCount !== 0
    : budget.checkpointCount > policy.maxCheckpoints || budget.compactionCount > policy.maxCompactions)) {
    runtimeError('RUNTIME_BUDGET_INVALID', '预算状态与原合同不一致，不能按新预算继续。')
  }
  const totals = { used: 0n, unresolved: 0n, attempts: 0n }
  let cursor: string | undefined
  for (;;) {
    const rows = await tx.agentProviderAttempt.findMany({
      where: { operation: { taskRootId }, dispatchedAt: { not: null } }, orderBy: { id: 'asc' }, take: 500,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, status: true, usageReceipt: true },
    })
    for (const row of rows) {
      totals.attempts += 1n
      const usage = row.usageReceipt
      if (usage) {
        const observed = { source: usage.source, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, cacheHitTokens: usage.cacheHitTokens, cacheMissTokens: usage.cacheMissTokens }
        if (runtimeJson(observed).hash !== usage.observationHash) runtimeError('RUNTIME_RECEIPT_INVALID', '累计预算的用量回执损坏，不能按较低用量继续。')
        totals.used += BigInt(usage.promptTokens ?? 0) + BigInt(usage.completionTokens ?? 0)
      }
      if (!usage || usage.source !== 'reported' || usage.promptTokens === null || usage.completionTokens === null
        || !['succeeded', 'failed', 'cancelled'].includes(row.status)) totals.unresolved += 1n
    }
    if (rows.length < 500) break
    cursor = rows[rows.length - 1].id
  }
  let reservedChildTokens = 0n
  const children = await tx.agentChildExecutionGrant.findMany({ where: { parentRootId: taskRootId }, include: { childRun: { include: { taskRoot: true } } } })
  for (const grant of children) {
    const { verifyChildGrant } = await import('./runtime-child.js')
    verifyChildGrant(grant)
    const childRootId = grant.childRun.taskRootId
    if (!childRootId || grant.childRun.runtimeProtocolVersion !== 1) return runtimeError('RUNTIME_RECEIPT_INVALID', '子任务预算缺少原执行身份。')
    if (await tx.agentChildExecutionGrant.count({ where: { parentRootId: childRootId } })) return runtimeError('RUNTIME_CHILD_RECURSION_DENIED', '子任务不能派生其他任务。')
    // Child roots cannot recursively delegate. Reading their ordinary receipts
    // through the same checker also validates budget policy and usage hashes.
    const child = await readTaskBudgetInTransaction(tx, childRootId)
    if (child.budget.tokenLimit !== grant.tokenCeiling || (child.policy.version === 3 ? grant.tokenCeiling !== COMPATIBILITY_TOKEN_LIMIT
      : child.policy.tokenCeiling !== grant.tokenCeiling || child.policy.maxCheckpoints !== 0)) return runtimeError('RUNTIME_BUDGET_INVALID', '子任务原预算存储与准入回执不一致。')
    totals.used += child.usedTokens
    const completed = grant.childRun.status === 'completed' && grant.childRun.taskRoot?.status === 'completed'
    const released = grant.status === 'completed' && completed && child.unresolvedAttempts === 0n
    if (!released) reservedChildTokens += BigInt(grant.tokenCeiling) > child.usedTokens ? BigInt(grant.tokenCeiling) - child.usedTokens : 0n
    // A live grant already reserves its entire ceiling. Only genuinely unknown
    // child outcomes block parent providers; in-flight measured requests do not
    // prevent the parent from issuing task_wait under its unreserved budget.
    if (await tx.agentProviderAttempt.count({ where: { operation: { taskRootId: childRootId }, status: 'unknown' } })) totals.unresolved += 1n
    if (!['queued', 'running'].includes(grant.childRun.status) && !released && child.unresolvedAttempts > 0n) totals.unresolved += child.unresolvedAttempts
  }
  return { budget, policy, usedTokens: totals.used, reservedChildTokens, unresolvedAttempts: totals.unresolved, attempts: totals.attempts,
    control: untilCompletionControl(policy.version === 3 ? 'system_default' : 'unknown_legacy'), deadlineExceeded: false }
}

export async function readTaskBudget(token: RunLeaseToken) {
  const captured = { ...token }
  return withRunLease(captured, tx => readTaskBudgetInTransaction(tx, captured.taskRootId))
}

export async function assertProviderBudget(tx: RuntimeTx, taskRootId: string): Promise<void> {
  const state = await readTaskBudgetInTransaction(tx, taskRootId)
  const incoming = await tx.agentChildExecutionGrant.findFirst({ where: { childRun: { taskRootId } } })
  if (incoming) {
    const aggregate = await readTaskBudgetInTransaction(tx, incoming.parentRootId)
    if (aggregate.unresolvedAttempts > 0n) runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '父子任务仍有未确认的调用或用量，不能继续派发。')
  }
  if (state.unresolvedAttempts > 0n) runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '原任务仍有未确认的调用或用量，不能继续扩大供应商支出。')
}
