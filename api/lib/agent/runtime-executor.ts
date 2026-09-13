import { z } from 'zod'
import { setTimeout as delay } from 'node:timers/promises'
import { SERVER_MODEL_TIERS } from '../../../shared/contracts/credits.js'
import { env } from '../../config/env.js'
import { chatWithTools } from '../ai-service.js'
import { getModelTierRuntime } from '../credits.js'
import { resolveDurableTokenPrice } from '../billing/resolve-token-price.js'
import { databaseNow, runtimeError, runtimeJson } from './runtime-common.js'
import { withRunLease, type RunLeaseToken } from './runtime-lease.js'
import { withLeaseHeartbeat } from './runtime-heartbeat.js'
import { readExecutionFrame, readExecutionStateInTransaction } from './runtime-state.js'
import { executeDurableToolStep } from './runtime-tool-step.js'
import { assertProviderBudget } from './runtime-budget.js'
import { advanceDurableCheckpoint, advanceDurableContext } from './runtime-checkpoint-step.js'
import { advanceDurableContinuation, advanceDurableCompletionObligations } from './runtime-continuation.js'
import { pauseDurableTaskForAttention, finalizeDurableTask } from './runtime-lifecycle.js'
import { collectDurableCompletionEvidence } from './runtime-completion-evidence.js'
import { advanceDurableMemory } from './runtime-memory.js'
import { estimateChatMessagesTokens, estimateToolDefinitionTokens, resolveDurableInputLimit } from './context-budget.js'
import { readDurableImportBoundary, waitForDurableImport } from './runtime-import.js'

const reasoning = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/** Internal worker entry. The saved cursor chooses work; callers cannot supply
 * messages, tool args, a new task prompt, a price, or an operation sequence.
 * Completion review is a handoff, never proof that the user task is complete. */
export async function executeDurableStep(token: RunLeaseToken, signal: AbortSignal) {
  const lease = { ...token }
  signal.throwIfAborted()
  const importBoundary = await readDurableImportBoundary(lease)
  if (importBoundary) return importBoundary
  const prepared = await withRunLease(lease, async tx => {
    const state = await readExecutionStateInTransaction(tx, lease.taskRootId)
    if (state.frame.state.phase !== 'awaiting_operation') return null
    const operation = await tx.agentOperation.findUniqueOrThrow({ where: { id: state.frame.state.pendingOperationId! } })
    if (operation.kind !== 'provider' || operation.status !== 'prepared') return null
    if (await tx.agentProviderAttempt.count({ where: { operationId: operation.id, OR: [{ dispatchedAt: { not: null } }, { status: { not: 'prepared' } }] } })) return null
    const source = await readExecutionFrame(tx, lease.taskRootId, state.frame.revision - 1)
    if (source.state.phase !== 'idle' || operation.operationKey !== `exec:${source.state.nextOperationSequence}`
      || state.frame.state.turn !== source.state.turn + 1 || state.frame.state.nextOperationSequence !== source.state.nextOperationSequence + 1
      || runtimeJson(state.frame.state.messages).hash !== runtimeJson(source.state.messages).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '未派发模型请求缺少原准入位置。')
    await assertProviderBudget(tx, lease.taskRootId)
    return { state: { ...state, frame: source } }
  })
  if (!prepared) {
    const memory = await advanceDurableMemory(lease)
    if (memory) return memory
    const tool = await executeDurableToolStep(lease, signal)
    if (tool.kind !== 'idle') return tool
    const context = await advanceDurableContext(lease)
    if (context) return { kind: 'context' as const, frame: context }
    const checkpoint = await advanceDurableCheckpoint(lease)
    if (checkpoint) return { kind: 'checkpoint' as const, frame: checkpoint }
    const continuation = await advanceDurableContinuation(lease)
    if (continuation) return continuation
  }
  const current = prepared ?? await withRunLease(lease, async tx => {
    const state = await readExecutionStateInTransaction(tx, lease.taskRootId)
    if (state.frame.state.phase === 'completed') return { review: true as const, frame: state.frame }
    if (state.frame.state.phase !== 'idle') return runtimeError('RUNTIME_STATE_CONFLICT', '执行位置已变化，需要从已保存位置重新调度。')
    const last = state.frame.state.messages.at(-1)
    // An assistant answer is only a candidate for completion/continuation review.
    // Do not manufacture another user "continue" message or infer success here.
    if (last?.role === 'assistant') return { review: true as const, frame: state.frame }
    await assertProviderBudget(tx, lease.taskRootId)
    return { state }
  })
  if ('review' in current) return { kind: 'completion_review' as const, frame: current.frame,
    evidence: await collectDurableCompletionEvidence(lease, { expectedRevision: current.frame.revision, expectedHash: current.frame.snapshotHash }) }
  const { configuration, frame } = current.state
  const tier = z.enum(SERVER_MODEL_TIERS).safeParse(configuration.model.tier)
  const effort = reasoning.safeParse(configuration.model.reasoningEffort)
  if (!tier.success || !effort.success || configuration.model.customModelId) return runtimeError('RUNTIME_MODEL_ADAPTER_REQUIRED', '原模型计费模式尚未接入持久执行，不能降级或替换。')
  const runtime = await getModelTierRuntime(tier.data, lease.userId, null, effort.data)
  if (runtime.tier !== tier.data) return runtimeError('RUNTIME_IDENTITY_CONFLICT', '原模型档位不可用，不能静默回退。')
  const currentWindow = runtime.contextWindowTokens ?? env.agentContextWindowTokens
  const window = Math.min(configuration.model.contextWindowTokens ?? currentWindow, currentWindow)
  const maxOutputTokens = configuration.model.maxOutputTokens ?? env.aiTextMaxOutputTokens
  // Reserve the actual requested output, even when it exceeds the legacy
  // estimator's quarter-window allowance. Never shorten the requested answer.
  const inputLimit = resolveDurableInputLimit(window, maxOutputTokens)
  if (inputLimit < 1) return runtimeError('RUNTIME_CONTEXT_LIMIT', '模型上下文窗口不足以预留配置的输出空间，请调整模型配置；原任务保留。')
  if (!prepared) {
    const compacted = await advanceDurableContext(lease, inputLimit)
    if (compacted) return { kind: 'context' as const, frame: compacted }
  }
  if (estimateChatMessagesTokens(frame.state.messages) + estimateToolDefinitionTokens(configuration.tools) > inputLimit) {
    return runtimeError('RUNTIME_CONTEXT_LIMIT', '原请求、工具定义或不可再归档内容超过模型输入预算；已保留完整原文，不截掉要求或盲目重试模型。')
  }
  const operationKey = `exec:${frame.state.nextOperationSequence}`
  const price = await resolveDurableTokenPrice(lease, operationKey, tier.data, runtime.multiplierBps)
  if (price.version !== 'credits-v2-itemized') return runtimeError('RUNTIME_PRICE_REQUIRED', '新执行器需要已批准的V2价目，不能使用未校准默认价格。')
  signal.throwIfAborted()
  const result = await chatWithTools({ messages: frame.state.messages, tools: configuration.tools,
    provider: runtime.provider, model: runtime.modelName ?? env.aiTextModel, providerBaseUrl: runtime.baseUrl,
    providerApiKey: runtime.apiKey, reasoningEffort: effort.data, maxOutputTokens, signal,
    durableExecution: { lease, operationKey, attemptKey: '1', price, cursor: { expectedRevision: frame.revision, expectedHash: frame.snapshotHash } },
    usageLog: { userId: lease.userId, agentRunId: lease.runId, action: 'workspaceAgent', modelTier: tier.data, multiplierBps: price.multiplierBps, turn: frame.state.turn + 1 },
  })
  return { kind: 'model' as const, result }
}

/** Run until a real external decision/review boundary, not one model call.
 * Activation remains gated on all tool adapters and completion review integration. */
export async function runDurableExecution(token: RunLeaseToken, signal: AbortSignal) {
  const lease = { ...token }
  const result = await withLeaseHeartbeat(lease, signal, async ownedSignal => {
    for (;;) {
      ownedSignal.throwIfAborted()
      const step = await executeDurableStep(lease, ownedSignal)
      if (step.kind === 'completion_review' || step.kind === 'waiting_approval' || step.kind === 'waiting_question' || step.kind === 'waiting_import' || step.kind === 'needs_attention') return step
    }
  })
  if (result.kind === 'needs_attention') {
    signal.throwIfAborted()
    await pauseDurableTaskForAttention(lease, { expectedRevision: result.frame.revision, expectedHash: result.frame.snapshotHash }, 'importBoundary' in result ? 'needs_input' : 'model_stalled')
  }
  return result
}

/** B0 keeps its single owner while waiting. Saved decisions (not an in-memory
 * notification) trigger the next step, including answers received before this
 * wait starts. The tool step still validates and consumes the actual decision. */
export async function waitForDurableDecision(token: RunLeaseToken, signal: AbortSignal,
  waiting: { kind: 'waiting_question' | 'waiting_approval'; requestId: string }) {
  const requestId = waiting.requestId
  const question = waiting.kind === 'waiting_question'
  await withLeaseHeartbeat(token, signal, async ownedSignal => {
    for (;;) {
      ownedSignal.throwIfAborted()
      const remaining = await withRunLease(token, async tx => {
        const request = await tx.agentExecutionOutbox.findUnique({ where: { id: requestId } })
        if (!request || request.taskRootId !== token.taskRootId
          || request.type !== (question ? 'question.requested' : 'approval.requested')) {
          return runtimeError('RUNTIME_RECEIPT_INVALID', '等待的原审批或提问不存在。')
        }
        const deadline = z.object({ expiresAt: z.string().datetime() }).parse(request.payload)
        const decision = await tx.agentExecutionOutbox.findUnique({ where: {
          eventKey: `${question ? 'question-answer' : 'approval-decision'}:${requestId}`,
        } })
        // This is only a wake-up signal, never authorization to apply an effect.
        // Malformed decisions are rejected by the original tool on the next step.
        if (decision) return 0
        return Date.parse(deadline.expiresAt) - (await databaseNow(tx)).getTime()
      })
      if (remaining <= 0) return
      await delay(Math.min(1000, remaining), undefined, { signal: ownedSignal })
    }
  })
}

/** Complete the existing domain checks without adding a paid completion critic. */
export async function runReviewedDurableExecution(token: RunLeaseToken, signal: AbortSignal) {
  const lease = { ...token }
  for (;;) {
    const step = await runDurableExecution(lease, signal)
    if (step.kind === 'waiting_import') {
      await waitForDurableImport(lease, signal, step.requestId)
      continue
    }
    if (step.kind === 'waiting_question' || step.kind === 'waiting_approval') {
      const requestId = step.kind === 'waiting_question' ? step.requestId : step.approvalId
      if (!requestId) return runtimeError('RUNTIME_RECEIPT_INVALID', '等待状态缺少原请求身份。')
      await waitForDurableDecision(lease, signal, { kind: step.kind, requestId })
      continue
    }
    if (step.kind !== 'completion_review') return step
    const obligation = await advanceDurableCompletionObligations(lease, { expectedRevision: step.frame.revision, expectedHash: step.frame.snapshotHash })
    if (obligation?.kind === 'continued') continue
    if (obligation?.kind === 'reconciliation_required') {
      signal.throwIfAborted()
      await pauseDurableTaskForAttention(lease, { expectedRevision: step.frame.revision, expectedHash: step.frame.snapshotHash }, 'needs_input')
      return { kind: 'needs_attention' as const, reason: '原任务存在待核对操作或缺少有效权限，已保留进度；不能盲目重试或宣称完成。',
        frame: step.frame, blockers: obligation.blockers }
    }
    if (obligation?.kind === 'needs_attention') {
      signal.throwIfAborted()
      await pauseDurableTaskForAttention(lease, { expectedRevision: obligation.frame.revision, expectedHash: obligation.frame.snapshotHash })
      return obligation
    }
    signal.throwIfAborted()
    // Finalization revokes the lease: it must run after the heartbeat has stopped.
    return finalizeDurableTask(lease, { expectedRevision: step.frame.revision, expectedHash: step.frame.snapshotHash })
  }
}
