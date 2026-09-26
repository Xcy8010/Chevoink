import { withRunLease, type RunLeaseToken } from './runtime-lease.js'
import { runtimeError, runtimeJson } from './runtime-common.js'
import { readTaskBudgetInTransaction, taskTurnLimit } from './runtime-budget.js'
import { readExecutionStateInTransaction, saveExecutionStateInTransaction } from './runtime-state.js'
import { commitRuntimeCheckpointInTransaction, durableProgressSchema, CHECKPOINT_ACTIONS } from './runtime-checkpoint.js'
import { archiveEarlyToolRounds, estimateChatMessagesTokens, estimateToolDefinitionTokens, releaseCompletedReasoning } from './context-budget.js'
import { executionContextReadTool } from './tools/task-context-tools.js'
import { toOpenAIParameters } from './tool-schema.js'
import { randomUUID } from 'node:crypto'

/** Storage-pressure compaction is NOT a budget checkpoint and grants no tokens.
 * Each replacement points to the still-persisted, hash-verified original frame.
 * Model-window admission and very large single results remain separate concerns. */
export async function advanceDurableContext(token: RunLeaseToken, inputLimit?: number) {
  if (inputLimit !== undefined && (!Number.isSafeInteger(inputLimit) || inputLimit < 1)) return runtimeError('RUNTIME_INPUT_INVALID', '上下文输入预算无效。')
  const lease = { ...token }
  return withRunLease(lease, async tx => {
    const { frame, configuration } = await readExecutionStateInTransaction(tx, lease.taskRootId)
    if (frame.state.phase !== 'idle') return null
    const beforeBytes = Buffer.byteLength(JSON.stringify(frame.state.messages), 'utf8')
    const modelPressure = inputLimit !== undefined && estimateChatMessagesTokens(frame.state.messages) + estimateToolDefinitionTokens(configuration.tools) > inputLimit
    if (!modelPressure && (beforeBytes < 256 * 1024 || frame.state.messages.at(-1)?.role !== 'tool')) return null
    // Keep the latest complete tool round: replacing it with an assistant
    // archive note would be mistaken for a final answer by the executor.
    const archived = archiveEarlyToolRounds(frame.state.messages, { revision: frame.revision, hash: frame.snapshotHash }, modelPressure ? 1 : 8)
    const releasedReasoningTokens = modelPressure ? releaseCompletedReasoning(archived.messages) : 0
    const afterBytes = Buffer.byteLength(JSON.stringify(archived.messages), 'utf8')
    if ((!archived.archivedRounds && !releasedReasoningTokens) || afterBytes >= beforeBytes) return null
    const tool = configuration.tools.find(item => item.function.name === executionContextReadTool.name)
    const grant = configuration.toolAuthority.find(item => item.name === executionContextReadTool.name)
    if (!tool || !grant || grant.permission !== 'allow' || grant.alwaysConfirm
      || runtimeJson(tool.function.parameters).hash !== runtimeJson(toOpenAIParameters(executionContextReadTool.parameters)).hash) return runtimeError('RUNTIME_CONTEXT_READER_REQUIRED', '压缩前必须提供本任务原文回读能力，不能留下无法读取的摘要。')
    const next = await saveExecutionStateInTransaction(tx, lease, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash,
      snapshot: { ...frame.state, messages: archived.messages } })
    await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: lease.taskRootId, runId: lease.runId,
      eventKey: `context:${lease.taskRootId}:${frame.revision}`, type: 'execution.context.archived',
      payload: { version: 1, sourceRevision: frame.revision, sourceHash: frame.snapshotHash, revision: next.revision,
        snapshotHash: next.snapshotHash, archivedRounds: archived.archivedRounds, releasedReasoningTokens, beforeBytes, afterBytes,
        ...(inputLimit !== undefined ? { inputLimit, modelPressure } : {}) } } })
    return next
  })
}

/** A continuation after tool observations, not a todo-driven completion decision.
 * Budget checkpoint and frame move atomically; no summary/HTTP call in this TX. */
export async function advanceDurableCheckpoint(token: RunLeaseToken) {
  const lease = { ...token }
  return withRunLease(lease, async tx => {
    const current = await readExecutionStateInTransaction(tx, lease.taskRootId)
    const frame = current.frame
    if (frame.state.phase !== 'idle') return null
    const last = frame.state.messages.at(-1)
    const continuation = last?.role === 'system' ? await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `continuation:${lease.taskRootId}:${frame.revision - 1}` } }) : null
    if (last?.role !== 'tool' && !continuation) return null
    if (continuation && (continuation.taskRootId !== lease.taskRootId || continuation.type !== 'execution.continuation')) return runtimeError('RUNTIME_RECEIPT_INVALID', '继续执行的检查点缺少原判定。')
    const budget = await readTaskBudgetInTransaction(tx, lease.taskRootId)
    const trigger = budget.usedTokens >= BigInt(budget.budget.tokenLimit) ? 'budget'
      : frame.state.turn >= taskTurnLimit(budget.policy, budget.budget.checkpointCount) ? 'turns' : null
    if (!trigger) return null
    if (frame.state.checkpointIndex !== budget.budget.checkpointCount) return runtimeError('RUNTIME_STATE_CONFLICT', '检查点与原执行位置不一致。')
    let assistantIndex = frame.state.messages.length - 1
    if (continuation) assistantIndex--
    while (assistantIndex >= 0 && frame.state.messages[assistantIndex].role === 'tool') assistantIndex--
    const assistant = frame.state.messages[assistantIndex]
    if (assistant?.role !== 'assistant' || assistant.toolCalls?.some(call => !frame.state.messages.slice(assistantIndex + 1).some(message => message.role === 'tool' && message.toolCallId === call.id))) return runtimeError('RUNTIME_TOOL_RESULTS_REQUIRED', '工具观察尚未齐全，不能提交检查点。')
    const previous = budget.budget.checkpointCount ? await tx.agentExecutionOutbox.findUniqueOrThrow({ where: { eventKey: `checkpoint:${lease.taskRootId}:${budget.budget.checkpointCount}` } }) : null
    let before: bigint | undefined
    let progressOperationId: string | undefined
    while (!progressOperationId) {
      const effects = await tx.agentExecutionOutbox.findMany({ where: { taskRootId: lease.taskRootId, type: 'effect.committed',
        sequence: { ...(previous ? { gt: previous.sequence } : {}), ...(before !== undefined ? { lt: before } : {}) },
        operation: { status: 'succeeded', action: { in: CHECKPOINT_ACTIONS }, checkpoints: { none: {} } },
      }, orderBy: { sequence: 'desc' }, take: 100, include: { operation: { include: { effectReceipt: true } } } })
      for (const effect of effects) {
        const operation = effect.operation, receipt = operation?.effectReceipt
        if (!operation || !receipt || !operation.inputSnapshot || runtimeJson(operation.inputSnapshot).hash !== operation.inputHash
          || runtimeJson(receipt.result).hash !== receipt.resultHash
          || runtimeJson(effect.payload).hash !== runtimeJson({ operationId: operation.id, resultHash: receipt.resultHash }).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '检查点候选进展回执损坏，不能忽略后扩额。')
        const result = receipt.result
        const progress = result && typeof result === 'object' && !Array.isArray(result) ? result.progress : undefined
        if (durableProgressSchema.safeParse(progress).success) { progressOperationId = operation.id; break }
      }
      if (effects.length < 100) break
      before = effects.at(-1)!.sequence
    }
    if (!progressOperationId) return runtimeError('RUNTIME_PROGRESS_REQUIRED', '没有新的已提交正文、计划或结构进展，不能自动扩额。')
    const checkpoint = await commitRuntimeCheckpointInTransaction(tx, lease, { expectedCheckpointCount: budget.budget.checkpointCount,
      progressOperationId, snapshot: { version: 1, taskRootId: lease.taskRootId, trigger,
        context: `执行帧 ${frame.revision} / ${frame.snapshotHash}；保留完整原始消息和工具观察，未执行摘要压缩。`,
        remainingWork: ['处理本轮已保存的工具观察，继续核验原任务目标与交付条件；不能仅凭模型回复或历史待办宣称完成。'],
      } })
    return saveExecutionStateInTransaction(tx, lease, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash,
      snapshot: { ...frame.state, checkpointIndex: checkpoint.checkpointIndex } })
  })
}
