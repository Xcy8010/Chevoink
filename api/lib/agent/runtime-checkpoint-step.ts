import { withRunLease, type RunLeaseToken } from './runtime-lease.js'
import { runtimeError, runtimeJson } from './runtime-common.js'
import { readTaskBudgetInTransaction } from './runtime-budget.js'
import { readExecutionStateInTransaction, saveExecutionStateInTransaction } from './runtime-state.js'
import { archiveEarlyToolRounds, estimateChatMessagesTokens, estimateToolDefinitionTokens, hasProactiveCompactionGain, releaseCompletedReasoning, releaseSessionReadingMaterial, targetContextTokens, toolOutputsToKeep } from './context-budget.js'
import { executionContextReadTool } from './tools/task-context-tools.js'
import { toOpenAIParameters } from './tool-schema.js'
import { randomUUID } from 'node:crypto'
import { AGENT_TOOL_EXECUTION_POLICY, CHAPTER_MEMORY_GUIDANCE } from './tool-execution-guidance.js'
import { isAgent2FeatureEnabled } from '../agent2-feature-flags.js'
import { COLLABORATION_MARKER, readWritingCollaborationDigest } from './writing-collaboration.js'
import type { ChatMessage } from '../ai-service.js'

type RequestContextBudget = {
  contextWindowTokens: number
  hardLimit: number
  compactAtTokens: number
  estimate: (messages: ChatMessage[]) => number
  canReadArchive: boolean
}

/** Storage-pressure compaction is NOT a budget checkpoint and grants no tokens.
 * Each replacement points to the still-persisted, hash-verified original frame.
 * Model-window admission and very large single results remain separate concerns. */
export async function advanceDurableContext(token: RunLeaseToken, budget?: number | RequestContextBudget | 'guidance') {
  const admission = typeof budget === 'object' ? budget : null
  const inputLimit = typeof budget === 'number' ? budget : admission?.hardLimit
  if (inputLimit !== undefined && (!Number.isSafeInteger(inputLimit) || inputLimit < 1)) return runtimeError('RUNTIME_INPUT_INVALID', '上下文输入预算无效。')
  const lease = { ...token }
  return withRunLease(lease, async tx => {
    const { frame, configuration } = await readExecutionStateInTransaction(tx, lease.taskRootId)
    if (frame.state.phase !== 'idle') return null
    // Only a new model boundary can receive current guidance. Never alter a
    // paid assistant call awaiting execution, or an already prepared request.
    if (!admission && frame.state.messages.at(-1)?.role !== 'assistant') {
      const policies = [AGENT_TOOL_EXECUTION_POLICY]
      if (!lease.parent && configuration.mode === 'build' && configuration.agentType === 'orchestrator'
        && configuration.toolAuthority.some(grant => grant.name === 'memory_save' && grant.permission !== 'deny')
        && isAgent2FeatureEnabled('memory2', lease.userId)) {
        policies.push(CHAPTER_MEMORY_GUIDANCE)
      }
      const missing = policies.filter(policy => !frame.state.messages.some(message => message.role === 'system' && message.content.includes(policy)))
      if (missing.length) {
        const messages = [...frame.state.messages]
        const position = messages.findIndex(message => message.role !== 'system')
        messages.splice(position < 0 ? messages.length : position, 0, ...missing.map(content => ({ role: 'system' as const, content })))
        return saveExecutionStateInTransaction(tx, lease, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash,
          snapshot: { ...frame.state, messages } })
      }
      const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: lease.taskRootId }, select: { novelId: true } })
      const digest = await readWritingCollaborationDigest(tx, { userId: lease.userId, novelId: root.novelId, runId: lease.runId })
      const messages = frame.state.messages.filter(message => !(message.role === 'system' && message.content.startsWith(COLLABORATION_MARKER)))
      if (digest) {
        const position = messages.findIndex(message => message.role !== 'system')
        messages.splice(position < 0 ? messages.length : position, 0, { role: 'system', content: digest })
      }
      if (runtimeJson(messages).hash !== runtimeJson(frame.state.messages).hash) return saveExecutionStateInTransaction(tx, lease,
        { expectedRevision: frame.revision, expectedHash: frame.snapshotHash, snapshot: { ...frame.state, messages } })
    }
    if (budget === 'guidance') return null
    const estimate = admission?.estimate ?? ((messages: ChatMessage[]) => estimateChatMessagesTokens(messages) + estimateToolDefinitionTokens(configuration.tools))
    const beforeTokens = inputLimit === undefined ? 0 : estimate(frame.state.messages)
    const modelPressure = admission ? beforeTokens >= admission.compactAtTokens : inputLimit !== undefined && beforeTokens > inputLimit
    const retained = admission && modelPressure ? releaseSessionReadingMaterial(frame.state.messages, beforeTokens, admission.compactAtTokens) : null
    if (admission && (!modelPressure || !retained && !admission.canReadArchive)) return null
    const beforeBytes = Buffer.byteLength(JSON.stringify(frame.state.messages), 'utf8')
    if (!modelPressure && (beforeBytes < 256 * 1024 || frame.state.messages.at(-1)?.role !== 'tool')) return null
    // Keep the latest complete tool round: replacing it with an assistant
    // archive note would be mistaken for a final answer by the executor.
    const archived = retained ? { messages: retained, archivedRounds: 0 }
      : archiveEarlyToolRounds(frame.state.messages, { revision: frame.revision, hash: frame.snapshotHash },
        admission ? toolOutputsToKeep(frame.state.messages, beforeTokens - targetContextTokens(admission.compactAtTokens), 1) : modelPressure ? 1 : 8)
    const releasedReasoningTokens = modelPressure && !retained ? releaseCompletedReasoning(archived.messages) : 0
    const afterBytes = Buffer.byteLength(JSON.stringify(archived.messages), 'utf8')
    if ((!retained && !archived.archivedRounds && !releasedReasoningTokens) || afterBytes >= beforeBytes) return null
    const afterTokens = admission && modelPressure ? estimate(archived.messages) : null
    if (admission && afterTokens !== null) {
      if (afterTokens >= beforeTokens || !retained && beforeTokens <= admission.hardLimit && !hasProactiveCompactionGain(beforeTokens, afterTokens, admission.compactAtTokens)) return null
    }
    const tool = configuration.tools.find(item => item.function.name === executionContextReadTool.name)
    const grant = configuration.toolAuthority.find(item => item.name === executionContextReadTool.name)
    if (!retained && (!tool || !grant || grant.permission !== 'allow' || grant.alwaysConfirm
      || runtimeJson(tool.function.parameters).hash !== runtimeJson(toOpenAIParameters(executionContextReadTool.parameters)).hash)) {
      if (admission) return null
      return runtimeError('RUNTIME_CONTEXT_READER_REQUIRED', '压缩前必须提供本任务原文回读能力，不能留下无法读取的摘要。')
    }
    const next = await saveExecutionStateInTransaction(tx, lease, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash,
      snapshot: { ...frame.state, messages: archived.messages } })
    await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: lease.taskRootId, runId: lease.runId,
      eventKey: `context:${lease.taskRootId}:${frame.revision}`, type: 'execution.context.archived',
      payload: { version: 1, sourceRevision: frame.revision, sourceHash: frame.snapshotHash, revision: next.revision,
        snapshotHash: next.snapshotHash, archivedRounds: archived.archivedRounds, releasedReasoningTokens, beforeBytes, afterBytes,
        reason: modelPressure ? 'window' : 'storage',
        ...(retained ? { releasedReadingMaterials: frame.state.messages.length - retained.length } : {}),
        ...(admission && afterTokens !== null && !lease.parent ? {
          contextWindowTokens: admission.contextWindowTokens, compactAtTokens: admission.compactAtTokens,
          beforeTokens, afterTokens,
        } : {}),
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
