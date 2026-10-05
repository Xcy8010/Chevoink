import { databaseNow, lockRunRoot, runtimeError, runtimeId, runtimeTransaction, type RuntimeTx } from './runtime-common.js'
import { assertRunGoalFence } from './goal-fence.js'
import { adoptChildGrants, assertChildParentFence, type ChildParentFence } from './runtime-child.js'
import { readParentContentionScope } from './runtime-parent-contention.js'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'

export type RunLeaseToken = { userId: string; runId: string; taskRootId: string; ownerId: string; claimId: string; epoch: bigint; parent?: ChildParentFence }
const MAX_EPOCH = 9_223_372_036_854_775_807n

function ttl(value: number): number {
  if (!Number.isInteger(value) || value < 5000 || value > 120000) runtimeError('RUNTIME_INPUT_INVALID', '租约时长必须在5至120秒内。')
  return value
}

function active(run: { status: string }, root: { status: string; authorizationMode: string }): void {
  if (root.authorizationMode !== 'legacy') runtimeError('TASK_AUTHORIZATION_NOT_ACTIVATED', '阶段授权执行器尚未接入，不能按旧权限执行。')
  if (!['queued', 'running'].includes(run.status) || root.status !== 'active') runtimeError('RUNTIME_NOT_ACTIVE', '任务已暂停或终止，不能继续产生效果。')
}

function nextEpoch(epoch: bigint): bigint {
  if (epoch >= MAX_EPOCH) runtimeError('RUNTIME_EPOCH_EXHAUSTED', '执行代次超限，需要人工核对。')
  return epoch + 1n
}

export async function acquireRunLease(input: { userId: string; runId: string; ownerId: string; claimId: string; ttlMs?: number }): Promise<RunLeaseToken> {
  const captured = { ...input }; const ttlMs = ttl(captured.ttlMs ?? 30000)
  runtimeId(captured.ownerId, 96); runtimeId(captured.claimId)
  // This preliminary lookup controls only DB retry timing. Ownership and the
  // canonical grant are independently verified inside every fresh transaction.
  const contentionScope = await readParentContentionScope(captured.userId, captured.runId)
  const contentionBackoff = Boolean(contentionScope?.isChild)
  return runtimeTransaction(async tx => {
    await assertRunGoalFence(tx, captured.userId, captured.runId)
    const incoming = await tx.agentChildExecutionGrant.findUnique({ where: { childRunId: captured.runId } })
    if (incoming) await assertRunGoalFence(tx, captured.userId, incoming.currentParentRunId)
    const { run, root } = await lockRunRoot(tx, captured.userId, captured.runId)
    active(run, root)
    const parent = await assertChildParentFence(tx, run.id)
    const old = await tx.agentRunLease.upsert({ where: { runId: run.id }, create: { runId: run.id }, update: {} })
    const now = await databaseNow(tx)
    if (!old.enabled) runtimeError('RUNTIME_LEASE_REVOKED', '执行租约已撤销，需要明确恢复任务。')
    if (parent) {
      // Canonical child roots have one authoritative run. Verify that exact
      // invariant instead of scanning unrelated sibling windows' leases.
      if (await tx.agentRun.count({ where: { taskRootId: root.id } }) !== 1) runtimeError('RUNTIME_CHILD_ROOT_CONFLICT', '子任务根存在额外执行身份，尚未派发。')
    } else {
      const other = await tx.agentRunLease.findFirst({ where: { runId: { not: run.id }, enabled: true, expiresAt: { gt: now }, run: { taskRootId: root.id } } })
      if (other) runtimeError('RUNTIME_LEASE_BUSY', '同一任务根已有其他执行者。')
    }
    const held = old.expiresAt && old.expiresAt > now
    if (held && (old.ownerId !== captured.ownerId || old.claimId !== captured.claimId)) runtimeError('RUNTIME_LEASE_BUSY', '任务已由其他执行者持有。')
    const lease = held ? old : await tx.agentRunLease.update({ where: { runId: run.id }, data: {
      ownerId: captured.ownerId, claimId: captured.claimId, epoch: nextEpoch(old.epoch), expiresAt: new Date(now.getTime() + ttlMs),
    } })
    const token = { userId: run.userId, runId: run.id, taskRootId: root.id, ownerId: captured.ownerId, claimId: captured.claimId, epoch: lease.epoch, ...(parent ? { parent } : {}) }
    if (!parent) await adoptChildGrants(tx, token)
    return token
  }, { contentionBackoff, contentionScope })
}

/** Serializes revocation and effects; expiry is rechecked before transaction commit. */
export async function withRunLease<T>(token: RunLeaseToken, work: (tx: RuntimeTx) => Promise<T>): Promise<T> {
  const captured = { ...token }
  const contentionScope = await readParentContentionScope(captured.userId, captured.runId, true)
  return runtimeTransaction(tx => withRunLeaseInTransaction(tx, captured, work), { contentionBackoff: Boolean(captured.parent), contentionScope, deadline: contentionScope?.deadline })
}

/** Manuscript adapters order domain locks before parent/run/root locks. The
 * preliminary owned identity is read again by the lease fence in this TX. */
export async function withManuscriptRunLease<T>(token: RunLeaseToken, work: (tx: RuntimeTx) => Promise<T>): Promise<T> {
  const captured = { ...token }
  const contentionScope = await readParentContentionScope(captured.userId, captured.runId, true)
  return runtimeTransaction(async tx => {
    const run = await tx.agentRun.findFirst({ where: { id: captured.runId, userId: captured.userId, taskRootId: captured.taskRootId }, select: { novelId: true } })
    if (!run) return runtimeError('RUNTIME_SCOPE_MISMATCH', '作品执行身份无法核实。')
    await lockNovelActiveScope(tx, run.novelId)
    const { lockWritingRunLineage } = await import('./writing-scope.js')
    await lockWritingRunLineage(tx, { userId: captured.userId, novelId: run.novelId, runId: captured.runId })
    return withRunLeaseInTransaction(tx, captured, work)
  }, { contentionBackoff: Boolean(captured.parent), contentionScope, deadline: contentionScope?.deadline })
}

/** Allows a dedicated adapter to acquire user/manuscript/session/goal first.
 * The same transaction rechecks ownership before and after its DB-only work. */
export async function withRunLeaseInTransaction<T>(tx: RuntimeTx, token: RunLeaseToken, work: (tx: RuntimeTx) => Promise<T>): Promise<T> {
    const captured = { ...token }
    await assertRunGoalFence(tx, captured.userId, captured.runId)
    if (captured.parent) await assertRunGoalFence(tx, captured.userId, captured.parent.runId)
    const { run, root } = await lockRunRoot(tx, captured.userId, captured.runId)
    active(run, root)
    const check = async () => {
      const parent = await assertChildParentFence(tx, run.id, captured.parent)
      if (parent && !captured.parent) runtimeError('RUNTIME_PARENT_LEASE_LOST', '子任务令牌缺少父任务执行代次。')
      const lease = await tx.agentRunLease.findUnique({ where: { runId: run.id } })
      const now = await databaseNow(tx)
      if (root.id !== captured.taskRootId || !lease?.enabled || lease.ownerId !== captured.ownerId || lease.claimId !== captured.claimId
        || lease.epoch !== captured.epoch || !lease.expiresAt || lease.expiresAt <= now) runtimeError('RUNTIME_LEASE_LOST', '执行所有权已失效，已阻止旧执行者提交。')
    }
    await check()
    const result = await work(tx)
    await check()
    return result
}

export async function renewRunLease(token: RunLeaseToken, ttlMs = 30000): Promise<void> {
  token = { ...token }
  ttl(ttlMs)
  await withRunLease(token, async tx => {
    const now = await databaseNow(tx)
    await tx.agentRunLease.update({ where: { runId: token.runId }, data: { expiresAt: new Date(now.getTime() + ttlMs) } })
  })
}

/** Yield ownership after the local executor has fully unwound. Unlike stop,
 * this leaves the task eligible for a later scheduler/answer wake-up. A stale
 * owner cannot release a replacement owner's lease or re-enable a revoked one. */
export async function releaseRunLease(token: RunLeaseToken): Promise<boolean> {
  const captured = { ...token }
  const contentionScope = await readParentContentionScope(captured.userId, captured.runId)
  return runtimeTransaction(async tx => {
    const { root } = await lockRunRoot(tx, captured.userId, captured.runId)
    if (root.id !== captured.taskRootId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '释放租约不能改变任务范围。')
    const released = await tx.agentRunLease.updateMany({ where: { runId: captured.runId, ownerId: captured.ownerId,
      claimId: captured.claimId, epoch: captured.epoch, enabled: true }, data: { ownerId: null, claimId: null, expiresAt: null } })
    return released.count === 1
  }, { contentionScope, contentionBackoff: Boolean(captured.parent) })
}

/** Cancellation is durable. Re-enabling requires the later explicit resume admission flow. */
export async function revokeRunLease(userId: string, runId: string): Promise<void> {
  await runtimeTransaction(async tx => {
    await lockRunRoot(tx, userId, runId)
    const lease = await tx.agentRunLease.upsert({ where: { runId }, create: { runId }, update: {} })
    if (!lease.enabled) return
    await tx.agentRunLease.update({ where: { runId }, data: { enabled: false, ownerId: null, claimId: null, expiresAt: null, epoch: nextEpoch(lease.epoch) } })
  })
}
