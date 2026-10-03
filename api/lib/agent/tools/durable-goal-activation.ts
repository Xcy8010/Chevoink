import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { DataAccessError } from '../../prisma.js'
import { lockGoalActivationScope, registerGoalActivationInTransaction } from '../goal-activation.js'
import { runtimeError, runtimeJson, runtimeTransaction } from '../runtime-common.js'
import { withRunLeaseInTransaction } from '../runtime-lease.js'
import { commitOperationEffectInTransaction } from '../runtime-operations.js'
import { reduceExecutionReceipt } from '../runtime-reducer.js'
import { prepareToolCursorOperation } from '../runtime-tool-cursor.js'
import type { ToolContext, ToolResult } from './types.js'

/** User -> manuscript -> session -> existing goal -> run/root -> lease.
 * Cursor, pending goal, effect receipt and outbox are one DB-only transaction. */
export async function executeDurableGoalActivation(ctx: ToolContext): Promise<ToolResult> {
  const capability = ctx.durableGoalActivation
  if (!capability || capability.lease.userId !== ctx.userId || capability.lease.runId !== ctx.runId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '目标登记缺少原任务能力。')
  const lease = { ...capability.lease }, cursor = { ...capability.cursor }
  const committed = await runtimeTransaction(async tx => {
    const existing = await lockGoalActivationScope(tx, ctx)
    return withRunLeaseInTransaction(tx, lease, async () => {
      const prepared = await prepareToolCursorOperation(lease, cursor, { key: capability.operationKey, action: 'goal_enable',
        callId: ctx.callId, targetId: lease.taskRootId, effectDomain: 'read', effectiveArgs: {},
        normalize: raw => z.object({}).strict().parse(raw), operationInput: { callId: ctx.callId, args: {} } }, tx)
      const receipt = await commitOperationEffectInTransaction(tx, lease, prepared.operation.id, prepared.operation.inputHash, async () => {
        ctx.signal.throwIfAborted()
        // Authorization failures are confirmed non-effects. Infrastructure/unknown
        // errors abort the transaction; they never become synthetic success.
        let result: ToolResult
        try { result = await registerGoalActivationInTransaction(tx, ctx, existing) }
        catch (error) {
          if (!(error instanceof DataAccessError)) throw error
          result = { outcome: 'failed', failureCode: error.code, output: error.message }
        }
        ctx.signal.throwIfAborted()
        if ('goalSnapshot' in result) await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: lease.taskRootId, runId: lease.runId,
          operationId: prepared.operation.id, eventKey: `goal-activation:${prepared.operation.id}`, type: 'goal.activation_registered',
          payload: runtimeJson({ operationId: prepared.operation.id, snapshot: result.goalSnapshot }).value } })
        return runtimeJson({ toolResult: result }).value
      })
      return { prepared, receipt }
    })
  })
  await reduceExecutionReceipt(lease, { expectedRevision: committed.prepared.pending.revision, expectedHash: committed.prepared.pending.snapshotHash, operationId: committed.prepared.operation.id })
  return z.object({ toolResult: z.object({ output: z.string() }).passthrough() }).parse(committed.receipt.result).toolResult as ToolResult
}
