import { withRunLease, type RunLeaseToken } from './runtime-lease.js'
import { runtimeError, runtimeJson } from './runtime-common.js'
import { readTaskBudgetInTransaction } from './runtime-budget.js'
import { readExecutionStateInTransaction, saveExecutionStateInTransaction } from './runtime-state.js'
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

/** No cumulative budget slices are granted. Context-window pressure is handled
 * independently above; validating saved budget receipts still precedes dispatch. */
export async function advanceDurableCheckpoint(token: RunLeaseToken) {
  const lease = { ...token }
  return withRunLease(lease, async tx => {
    const current = await readExecutionStateInTransaction(tx, lease.taskRootId)
    const budget = await readTaskBudgetInTransaction(tx, lease.taskRootId)
    if (current.frame.state.checkpointIndex !== budget.budget.checkpointCount) return runtimeError('RUNTIME_STATE_CONFLICT', '执行位置与历史检查点回执不一致。')
    return null
  })
}
