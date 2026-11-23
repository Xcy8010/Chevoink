import { withRunLease, type RunLeaseToken } from './runtime-lease.js'
import { runtimeError, runtimeJson, runtimeJsonHash, type RuntimeTx } from './runtime-common.js'
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
import { fitArchivedHistoryForDispatch, planSemanticCompaction, type SemanticHistoryDigest } from './semantic-compaction.js'
import { assertSummarySource, type SummarySource } from './runtime-semantic-cursor.js'

type RequestContextBudget = {
  contextWindowTokens: number
  hardLimit: number
  compactAtTokens: number
  estimate: (messages: ChatMessage[]) => number
  canReadArchive: boolean
  summarize?: (source: SummarySource, system: string, content: string) => Promise<string | null>
}

/** Storage-pressure compaction is NOT a budget checkpoint and grants no tokens.
 * Each replacement points to the still-persisted, hash-verified original frame.
 * Model-window admission and very large single results remain separate concerns. */
export async function advanceDurableContext(token: RunLeaseToken, budget?: number | RequestContextBudget | 'guidance') {
  const admission = typeof budget === 'object' ? budget : null
  const inputLimit = typeof budget === 'number' ? budget : admission?.hardLimit
  if (inputLimit !== undefined && (!Number.isSafeInteger(inputLimit) || inputLimit < 1)) return runtimeError('RUNTIME_INPUT_INVALID', '上下文输入预算无效。')
  const lease = { ...token }
  const candidate = await withRunLease(lease, async tx => {
    const { frame, configuration, head } = await readExecutionStateInTransaction(tx, lease.taskRootId)
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
    if (admission && !modelPressure) return null
    const beforeBytes = Buffer.byteLength(JSON.stringify(frame.state.messages), 'utf8')
    if (!modelPressure && (beforeBytes < 256 * 1024 || frame.state.messages.at(-1)?.role !== 'tool')) return null
    // Keep the latest complete tool round: replacing it with an assistant
    // archive note would be mistaken for a final answer by the executor.
    const tool = configuration.tools.find(item => item.function.name === executionContextReadTool.name)
    const grant = configuration.toolAuthority.find(item => item.name === executionContextReadTool.name)
    const readerAvailable = tool && grant?.permission === 'allow' && !grant.alwaysConfirm
      && runtimeJson(tool.function.parameters).hash === runtimeJson(toOpenAIParameters(executionContextReadTool.parameters)).hash
    const remainingTokens = retained ? estimate(retained) : beforeTokens
    const target = admission ? targetContextTokens(admission.compactAtTokens) : 0
    let archived = { messages: retained ?? frame.state.messages, archivedRounds: 0 }
    let releasedReasoningTokens = 0
    if ((!admission || admission.canReadArchive && readerAvailable) && (!retained || remainingTokens > target)) {
      const candidate = archiveEarlyToolRounds(frame.state.messages, { revision: frame.revision, hash: frame.snapshotHash },
        admission ? toolOutputsToKeep(frame.state.messages, remainingTokens - target, 1) : modelPressure ? 1 : 8,
        retained ? new Set(retained) : undefined)
      const released = modelPressure ? releaseCompletedReasoning(candidate.messages) : 0
      if (!retained || estimate(candidate.messages) < remainingTokens) {
        archived = candidate
        releasedReasoningTokens = released
      }
    }
    const afterTokens = admission ? estimate(archived.messages) : null
    const mechanical = Boolean(retained || archived.archivedRounds || releasedReasoningTokens)
      && Buffer.byteLength(JSON.stringify(archived.messages), 'utf8') < beforeBytes
      && (!admission || afterTokens! < beforeTokens && (Boolean(retained) || beforeTokens > admission.hardLimit
        || hasProactiveCompactionGain(beforeTokens, afterTokens!, admission.compactAtTokens)))
    if (mechanical && !retained && !readerAvailable) {
      return runtimeError('RUNTIME_CONTEXT_READER_REQUIRED', '压缩前必须提供本任务原文回读能力，不能留下无法读取的摘要。')
    }
    const base = mechanical ? archived.messages : frame.state.messages
    const summarize = admission?.summarize
    const plan = summarize && (mechanical ? afterTokens! : beforeTokens) > target ? planSemanticCompaction(base, target, estimate) : null
    const fallback = () => (admission && (mechanical ? afterTokens! : beforeTokens) > admission.hardLimit
      ? fitArchivedHistoryForDispatch(base, admission.hardLimit, estimate) : null) ?? (mechanical ? base : null)
    async function save(write: RuntimeTx, messages: ChatMessage[], historyDigest?: SemanticHistoryDigest) {
      const next = await saveExecutionStateInTransaction(write, lease, { expectedRevision: frame.revision, expectedHash: frame.snapshotHash,
        snapshot: { ...frame.state, messages } })
      await write.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: lease.taskRootId, runId: lease.runId,
        eventKey: `context:${lease.taskRootId}:${frame.revision}`, type: 'execution.context.archived',
        payload: { version: 1, sourceRevision: frame.revision, sourceHash: frame.snapshotHash, revision: next.revision,
          snapshotHash: next.snapshotHash, archivedRounds: mechanical ? archived.archivedRounds : 0,
          releasedReasoningTokens: mechanical ? releasedReasoningTokens : 0, beforeBytes, afterBytes: Buffer.byteLength(JSON.stringify(messages), 'utf8'),
          reason: modelPressure ? 'window' : 'storage',
          ...(historyDigest ? { historyDigest } : {}),
          ...(mechanical && retained ? { releasedReadingMaterials: frame.state.messages.length - retained.length } : {}),
          ...(admission && !lease.parent ? {
            contextWindowTokens: admission.contextWindowTokens, compactAtTokens: admission.compactAtTokens,
            beforeTokens, afterTokens: estimate(messages),
          } : {}),
          ...(inputLimit !== undefined ? { inputLimit, modelPressure } : {}) } } })
      return next
    }
    if (!plan || !summarize) {
      const messages = fallback()
      return messages ? save(tx, messages) : null
    }
    // JSON-in-JSON quoting in a history digest can be larger than the source
    // frame. Leave space under the durable 2 MiB envelope for route and price.
    if (Buffer.byteLength(JSON.stringify([plan.system, plan.content]), 'utf8') > 2 * 1024 * 1024 - 32768) {
      const messages = fallback()
      return messages ? save(tx, messages) : null
    }
    const source: SummarySource = { revision: frame.revision, snapshotHash: frame.snapshotHash, configurationHash: head.configurationHash,
      planHash: runtimeJsonHash({ system: plan.system, content: plan.content }) }
    // Return work, not a live transaction. The leased call and the CAS write
    // both recheck the frozen source on their own side of the network.
    return async () => {
      const summary = await summarize(source, plan.system, plan.content)
      const applied = summary ? plan.apply(summary) : null
      const referenceOnly = applied && admission && estimate(applied) > admission.hardLimit
        ? fitArchivedHistoryForDispatch(base, admission.hardLimit, estimate) : null
      const messages = referenceOnly ?? applied ?? fallback()
      if (!messages) return null
      return withRunLease(lease, async write => {
        assertSummarySource(source, await readExecutionStateInTransaction(write, lease.taskRootId))
        return save(write, messages, !referenceOnly && applied ? plan.receipt(applied) : undefined)
      })
    }
  })
  return typeof candidate === 'function' ? candidate() : candidate
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
