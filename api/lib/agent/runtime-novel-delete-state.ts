import type { AgentCreationState } from '../../../shared/agent-creation-state.js'
import { taskSpecSchema } from '../../../shared/contracts/task-spec-contracts.js'
import { runtimeError, runtimeJson, type RuntimeTx } from './runtime-common.js'
import { readVerifiedNovelDeletion } from './runtime-novel-delete-read.js'
import { readDeletedTaskCreditScope } from './runtime-novel-delete-billing.js'
import { readExecutionStateInTransaction } from './runtime-state.js'

/** A deleted manuscript has no live run record. Expose this exact source
 * instead of inventing a new run or reclassifying older failed/paused work. */
export async function readDeletedCreationState(tx: RuntimeTx, userId: string, runId: string): Promise<AgentCreationState | null> {
  const proof = await readVerifiedNovelDeletion(tx, userId, runId)
  if (!proof) return null
  const { run, deletion } = proof, ownDeletion = runId === deletion.runId
  const lineage = await readDeletedTaskCreditScope(tx, userId, runId)
  if (!lineage) return runtimeError('RUNTIME_RECEIPT_INVALID', '原删除账务归属缺失。')
  const root = run.taskRootId ? await tx.agentTaskRoot.findUnique({ where: { id: run.taskRootId } }) : null
  if (root && (root.userId !== userId || root.novelId !== run.novelId || root.sessionId !== run.sessionId)) return runtimeError('RUNTIME_RECEIPT_INVALID', '删除后的原任务归属不一致。')
  const state = root && await tx.agentExecutionState.findUnique({ where: { taskRootId: root.id } })
    ? await readExecutionStateInTransaction(tx, root.id) : null
  const parsed = root ? taskSpecSchema.safeParse(root.specSnapshot) : null, spec = parsed?.success ? parsed.data : null
  const prompt = Array.isArray(root?.requestSnapshot) ? root.requestSnapshot.flatMap(part => part && typeof part === 'object' && !Array.isArray(part)
    && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n') || null : null
  const initial = root ? await tx.agentExecutionFrame.findUnique({ where: { taskRootId_revision: { taskRootId: root.id, revision: 0 } }, select: { originRunId: true } }) : null
  const operations = root ? await tx.agentOperation.findMany({ where: { taskRootId: root.id, kind: 'tool' }, include: { effectReceipt: true }, orderBy: { id: 'asc' } }) : []
  const effects: AgentCreationState['effects']['operations'] = operations.map(operation => {
    const receipt = operation.effectReceipt
    if (receipt && runtimeJson(receipt.result).hash !== receipt.resultHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '原工具回执损坏。')
    const verified = ownDeletion && operation.id === deletion.operationId
    return { id: operation.id, action: operation.action, status: operation.status, receiptHash: receipt?.resultHash ?? null,
      receiptState: receipt ? 'hash_verified' : 'missing', observation: verified ? 'reduced_verified' : 'not_verified', outcome: verified ? 'succeeded' : 'unknown' }
  })
  const observations: AgentCreationState['usage']['observations'] = (await tx.aiUsageLog.findMany({ where: { userId, agentRunId: { in: lineage.runIds } }, orderBy: { id: 'asc' } })).map(log => ({
    id: log.id, source: 'legacy_usage', status: log.billingStatus ?? 'unknown', settlementStatus: log.billingStatus, usageSource: log.usageSource,
    tokensKnown: log.usageSource === 'reported' && log.requestTokens !== null && log.responseTokens !== null,
    pendingSettlement: ['observed', 'pending_usage', 'pending_settlement'].includes(log.billingStatus ?? '') }))
  if (root) for (const attempt of await tx.agentProviderAttempt.findMany({ where: { operation: { taskRootId: root.id } }, include: { usageReceipt: true }, orderBy: { id: 'asc' } })) {
    const usage = attempt.usageReceipt
    observations.push({ id: attempt.id, source: 'durable_attempt', status: attempt.status, settlementStatus: usage?.settlementStatus ?? null,
      usageSource: usage?.source ?? null, tokensKnown: usage?.source === 'reported' && usage.promptTokens !== null && usage.completionTokens !== null,
      pendingSettlement: usage ? usage.settlementStatus === 'pending' : attempt.dispatchedAt !== null })
  }
  const status = ownDeletion ? 'completed' : run.status
  return { version: 1, consistency: 'repeatable_read', observedAt: new Date().toISOString(), subject: { userId, novelId: run.novelId, runId },
    original: { taskId: run.taskKey ?? runId, sourceRunId: initial?.originRunId ?? runId, parentRunId: null, prompt, contract: spec, projectionHash: runtimeJson({ prompt, spec }).hash },
    execution: { protocol: run.taskRootId ? 'durable' : 'legacy', status, cursor: state ? { kind: 'durable_frame', revision: state.frame.revision, hash: state.frame.snapshotHash } : { kind: 'unknown' } },
    targets: [], effects: { legacy: run.taskRootId ? 'not_applicable' : 'unknown', operations: effects },
    pending: { operations: operations.filter(operation => ['prepared', 'dispatched', 'unknown'].includes(operation.status)).map(({ id, action, status }) => ({ id, action, status })), reviews: null },
    localRestrictions: { source: 'unknown', items: null }, usage: { coverage: 'saved_records_only', observations },
    delivery: { source: 'deletion_receipt', status, limitation: ownDeletion ? deletion.output : '作品已删除；原任务状态保留，未重新认证其完成。', verified: false },
    obligations: spec ? { source: 'original_contract', verification: 'unverified', goals: spec.goals, expectedOutputs: spec.expectedOutputs,
      postconditions: spec.postconditions, hardConstraints: spec.hardConstraints } : null }
}
