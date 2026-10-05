import { z } from 'zod'
import { readTaskBudgetInTransaction } from './runtime-budget.js'
import { runtimeError, runtimeId, runtimeJson, type RuntimeTx } from './runtime-common.js'
import { withRunLease, type RunLeaseToken } from './runtime-lease.js'
import { STRUCTURE_MUTATIONS } from './runtime-common.js'

const snapshotSchema = z.object({
  version: z.literal(1), taskRootId: z.string().min(1).max(64),
  context: z.string().trim().min(1), remainingWork: z.array(z.string().trim().min(1)).min(1),
  trigger: z.enum(['budget', 'turns']).optional(),
}).strict()
export const contentRevisionProgressSchema = z.object({
  kind: z.literal('content_revision'), targetId: z.string().min(1).max(64),
  beforeHash: z.string().regex(/^[a-f0-9]{64}$/), afterHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine(value => value.beforeHash !== value.afterHash)

export const structureRevisionProgressSchema = z.object({ kind: z.literal('structure_revision'), targetId: z.string().min(1).max(64),
  beforeHash: z.string().regex(/^[a-f0-9]{64}$/), afterHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine(value => value.beforeHash !== value.afterHash)
export const durableProgressSchema = z.union([contentRevisionProgressSchema, structureRevisionProgressSchema])
export const CHECKPOINT_ACTIONS = ['chapter_create', 'chapter_write', 'chapter_append', 'chapter_edit_range', 'plan_save', 'continuity_validate', 'quality_analyze', ...STRUCTURE_MUTATIONS]

/** Internal executor only. The tool adapter must produce progress from its committed revision,
 * never from model prose or a todo update. No provider calls inside this transaction. */
type CheckpointInput = {
  expectedCheckpointCount: number; progressOperationId: string; snapshot: unknown;
}

export async function commitRuntimeCheckpoint(token: RunLeaseToken, input: CheckpointInput) {
  return withRunLease({ ...token }, checkpointWrite(token, input))
}

/** Caller holds the same lease/root transaction as the execution-frame update. */
export async function commitRuntimeCheckpointInTransaction(tx: RuntimeTx, token: RunLeaseToken, input: CheckpointInput) {
  return checkpointWrite(token, input)(tx)
}

function checkpointWrite(token: RunLeaseToken, input: CheckpointInput) {
  const lease = { ...token }
  runtimeId(input.progressOperationId)
  const expected = input.expectedCheckpointCount
  if (!Number.isSafeInteger(expected) || expected < 0 || expected >= 2147483647) runtimeError('RUNTIME_INPUT_INVALID', '检查点序号无效。')
  const parsed = snapshotSchema.safeParse(input.snapshot)
  if (!parsed.success || parsed.data.taskRootId !== lease.taskRootId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '检查点必须绑定原任务和未完成工作。')
  const snapshot = runtimeJson(parsed.data)
  const progressOperationId = input.progressOperationId
  const request = runtimeJson({ expectedCheckpointCount: expected, progressOperationId, snapshot: snapshot.value })
  const index = expected + 1
  const eventKey = `checkpoint:${lease.taskRootId}:${index}`
  return async (tx: RuntimeTx) => {
    const state = await readTaskBudgetInTransaction(tx, lease.taskRootId)
    const existing = await tx.agentRuntimeCheckpoint.findUnique({ where: { taskRootId_checkpointIndex: { taskRootId: lease.taskRootId, checkpointIndex: index } } })
    if (existing) {
      if (existing.requestHash !== request.hash) runtimeError('RUNTIME_IDENTITY_CONFLICT', '同一检查点不能绑定不同内容。')
      if (existing.snapshotHash !== snapshot.hash || runtimeJson(existing.snapshot).hash !== snapshot.hash
        || existing.progressOperationId !== progressOperationId || state.budget.checkpointCount < index) runtimeError('RUNTIME_RECEIPT_INVALID', '检查点回执损坏。')
      const event = await tx.agentExecutionOutbox.findUnique({ where: { eventKey } })
      if (!event || event.taskRootId !== lease.taskRootId || event.type !== 'checkpoint.committed'
        || runtimeJson(event.payload).hash !== runtimeJson({ checkpointIndex: index, snapshotHash: snapshot.hash, progressOperationId }).hash) runtimeError('RUNTIME_RECEIPT_INVALID', '检查点事件缺失或损坏。')
      return existing
    }
    if (state.budget.checkpointCount !== expected) runtimeError('RUNTIME_CHECKPOINT_CONFLICT', '检查点已推进，请恢复已保存的状态。')
    return runtimeError('RUNTIME_CHECKPOINT_NOT_DUE', '任务按完成条件执行，不授予累计预算片；原检查点回执仍可重放。')
  }
}
