import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { creditModelTierSchema } from '../../../shared/contracts/credits.js'
import { env } from '../../config/env.js'
import { chatWithTools, type ChatMessage } from '../ai-service.js'
import { readManagedImageDataUrl } from '../agent-attachment-storage.js'
import { getModelTierRuntime } from '../credits.js'
import { resolveDurableTokenPrice } from '../billing/resolve-token-price.js'
import { databaseNow, runtimeError, runtimeJson } from './runtime-common.js'
import { withRunLease, type RunLeaseToken } from './runtime-lease.js'
import { withLeaseHeartbeat } from './runtime-heartbeat.js'
import { readExecutionFrame, readExecutionStateInTransaction, saveExecutionStateInTransaction } from './runtime-state.js'
import { executeDurableToolStep } from './runtime-tool-step.js'
import { assertProviderBudget } from './runtime-budget.js'
import { advanceDurableCheckpoint, advanceDurableContext } from './runtime-checkpoint-step.js'
import { advanceDurableContinuation, advanceDurableCompletionObligations, advanceDurableToolStagnation } from './runtime-continuation.js'
import { pauseDurableTaskForAttention, finalizeDurableTask } from './runtime-lifecycle.js'
import { collectDurableCompletionEvidence } from './runtime-completion-evidence.js'
import { advanceDurableWritingDelivery } from './runtime-writing-delivery.js'
import { advanceDurableMemory } from './runtime-memory.js'
import { estimateChatMessagesTokens, estimateToolDefinitionTokens, resolveDurableInputLimit } from './context-budget.js'
import { readDurableImportBoundary, waitForDurableImport } from './runtime-import.js'
import { modelRouteRevision } from './runtime-model-cursor.js'
import { consumeDurableGoalConsent } from './goal-consent.js'
import { consumeDurableConfigurationConsent } from './configuration-journal.js'
import { awaitDurableChildren, wakeDurableChildren } from './runtime-child-tools.js'
import { verifyChildGrant } from './runtime-child.js'
import { renderWritingPresentation, writingPresentationPreference } from './writing-request-context.js'

const reasoning = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const durableModelTier = creditModelTierSchema

const steeringPart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z.object({ type: z.literal('attachment'), kind: z.enum(['image', 'file']), name: z.string(), url: z.string(), size: z.number().int().nonnegative().optional() }).strict(),
])
const steeringEvent = z.object({ version: z.literal(1), messageId: z.string(), partsHash: z.string().regex(/^[a-f0-9]{64}$/),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), sourceRevision: z.number().int().nonnegative(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().positive(), snapshotHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()

function renderDurableSteering(parts: unknown) {
  const parsed = z.array(steeringPart).min(1).safeParse(parts)
  if (!parsed.success) return runtimeError('RUNTIME_SOURCE_REQUIRED', '作者补充消息格式无效，不能写入原执行帧。')
  const text = parsed.data.map(part => part.type === 'text'
    ? part.text
    : part.kind === 'image' ? `[附件图片：${part.name}，地址：${part.url}]` : `[附件文件：${part.name}，地址：${part.url}]`).filter(Boolean).join('\n')
  if (!text.trim()) return runtimeError('RUNTIME_SOURCE_REQUIRED', '作者补充消息为空，不能写入原执行帧。')
  return { parts: parsed.data, text }
}

type DurableSteeringCandidate = {
  messageId: string
  parts: z.infer<typeof steeringPart>[]
  partsHash: string
  sourceRevision: number
  sourceHash: string
  model: { tier: string; customModelId: string | null; reasoningEffort: string }
}
type SteeringImagePart = { type: 'attachment'; kind: 'image'; name: string; url: string; size?: number }

type DurableSteeringContent = Exclude<ChatMessage, { role: 'system' | 'assistant' | 'tool' }>['content']

/** Materialize images only on a route whose current, resolved model advertises vision.
 * Vision routes must receive the authorized bytes; a missing source is an error rather
 * than a silent URL-only downgrade. Non-vision routes retain the managed source in the
 * textual attachment marker so the existing view_image flow can inspect it. */
async function materializeDurableSteering(candidate: DurableSteeringCandidate, userId: string) {
  const imageParts = candidate.parts.filter((part): part is SteeringImagePart => part.type === 'attachment' && part.kind === 'image')
  let nativeImages: string[] = []
  if (imageParts.length) {
    const tier = durableModelTier.safeParse(candidate.model.tier)
    const effort = reasoning.safeParse(candidate.model.reasoningEffort)
    if (!tier.success || !effort.success || tier.data === 'custom' && !candidate.model.customModelId) {
      return runtimeError('RUNTIME_MODEL_ADAPTER_REQUIRED', '原模型附件能力尚未接入持久执行，不能降级或替换。')
    }
    const runtime = await getModelTierRuntime(tier.data as import('../../../shared/contracts/index.js').CreditModelTier, userId,
      tier.data === 'custom' ? candidate.model.customModelId : null, effort.data)
    if (runtime.tier !== tier.data) return runtimeError('RUNTIME_IDENTITY_CONFLICT', '原模型档位不可用，不能静默回退。')
    if (runtime.visionEnabled) {
      const resolved = await Promise.all(imageParts.map(async part => readManagedImageDataUrl(part.url, userId)))
      if (resolved.some((dataUrl): dataUrl is null => dataUrl === null)) {
        return runtimeError('RUNTIME_SOURCE_REQUIRED', '视觉模型的作者图片来源无法读取，已保留补充消息等待重试。')
      }
      nativeImages = resolved as string[]
    }
  }
  const sourceText = candidate.parts.map(part => part.type === 'text'
    ? part.text
    : part.kind === 'image' ? `[附件图片：${part.name}，地址：${part.url}]` : `[附件文件：${part.name}，地址：${part.url}]`).filter(Boolean).join('\n')
  if (!sourceText.trim()) return runtimeError('RUNTIME_SOURCE_REQUIRED', '作者补充消息为空，不能写入原执行帧。')
  const preference = writingPresentationPreference(candidate.parts.filter(part => part.type === 'text').map(part => part.text).join('\n'))
  const summary = preference ? renderWritingPresentation({ mode: preference, sourceRunId: 'consumed-steering', sourceMessageId: candidate.messageId }) : null
  const text = summary ? `${sourceText}\n\n${summary}` : sourceText
  const content: DurableSteeringContent = nativeImages.length
    ? [{ type: 'text', text }, ...nativeImages.map(url => ({ type: 'image_url' as const, image_url: { url, detail: 'auto' as const } }))]
    : text
  return { content, contentHash: runtimeJson(content).hash }
}

/** Consume a goal steering message exactly once at an idle saved-frame boundary.
 * The message is a new author input, while task scope, tool grants and budget
 * stay on the original root. An outbox receipt binds the message to the frame
 * so a worker crash cannot append it again. */
async function consumeDurableSteering(token: RunLeaseToken) {
  const candidate = await withRunLease(token, async tx => {
    const binding = await tx.agentGoalExecution.findUnique({ where: { runId: token.runId }, select: { trigger: true } })
    if (binding?.trigger !== 'steering') return false
    const run = await tx.agentRun.findUniqueOrThrow({ where: { id: token.runId }, select: { sessionId: true, modelTier: true, customModelId: true, reasoningEffort: true } })
    const messages = await tx.agentMessage.findMany({ where: { runId: token.runId, sessionId: run.sessionId,
      role: 'user' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, parts: true } })
    if (messages.length !== 1) return runtimeError('RUNTIME_SOURCE_REQUIRED', '目标补充消息缺少唯一作者来源。')
    const message = messages[0]
    const rendered = renderDurableSteering(message.parts)
    const partsHash = runtimeJson(rendered.parts).hash
    const eventKey = `goal-steering:${token.taskRootId}:${message.id}`
    const existing = await tx.agentExecutionOutbox.findUnique({ where: { eventKey } })
    const current = await readExecutionStateInTransaction(tx, token.taskRootId)
    if (existing) {
      const payload = steeringEvent.safeParse(existing.payload)
      if (!payload.success || existing.taskRootId !== token.taskRootId || existing.runId !== token.runId
        || existing.type !== 'goal.steering.consumed' || payload.data.messageId !== message.id || payload.data.partsHash !== partsHash) {
        return runtimeError('RUNTIME_RECEIPT_INVALID', '作者补充消息回执与执行帧不一致。')
      }
      const source = await readExecutionFrame(tx, token.taskRootId, payload.data.sourceRevision)
      const result = await readExecutionFrame(tx, token.taskRootId, payload.data.revision)
      const actualContentHash = runtimeJson(result.state.messages.at(-1)?.content).hash
      const expectedContentHash = payload.data.contentHash ?? runtimeJson(rendered.text).hash
      if (source.snapshotHash !== payload.data.sourceHash || result.snapshotHash !== payload.data.snapshotHash
        || result.state.messages.length !== source.state.messages.length + 1
        || result.state.messages.at(-1)?.role !== 'user'
        || actualContentHash !== expectedContentHash) {
        return runtimeError('RUNTIME_RECEIPT_INVALID', '作者补充消息没有绑定到唯一执行帧。')
      }
      return false
    }
    if (current.frame.state.phase === 'completed') return runtimeError('RUNTIME_STATE_CONFLICT', '已完成执行帧不能接收新的目标补充消息。')
    // A pending provider/tool operation must be reduced first. The message is
    // retained in AgentMessage and will be consumed on the next idle boundary.
    if (current.frame.state.phase !== 'idle') return false
    return { messageId: message.id, parts: rendered.parts, partsHash, sourceRevision: current.frame.revision,
      sourceHash: current.frame.snapshotHash, model: { tier: run.modelTier, customModelId: run.customModelId, reasoningEffort: run.reasoningEffort } } satisfies DurableSteeringCandidate
  })
  if (!candidate) return false
  const content = await materializeDurableSteering(candidate, token.userId)
  return withRunLease(token, async tx => {
    const binding = await tx.agentGoalExecution.findUnique({ where: { runId: token.runId }, select: { trigger: true } })
    if (binding?.trigger !== 'steering') return false
    const run = await tx.agentRun.findUniqueOrThrow({ where: { id: token.runId }, select: { sessionId: true } })
    const messages = await tx.agentMessage.findMany({ where: { runId: token.runId, sessionId: run.sessionId, role: 'user' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, parts: true } })
    if (messages.length !== 1 || messages[0].id !== candidate.messageId
      || runtimeJson(renderDurableSteering(messages[0].parts).parts).hash !== candidate.partsHash) return false
    const eventKey = `goal-steering:${token.taskRootId}:${candidate.messageId}`
    const existing = await tx.agentExecutionOutbox.findUnique({ where: { eventKey } })
    if (existing) return false
    const current = await readExecutionStateInTransaction(tx, token.taskRootId)
    if (current.frame.state.phase === 'completed') return runtimeError('RUNTIME_STATE_CONFLICT', '已完成执行帧不能接收新的目标补充消息。')
    if (current.frame.state.phase !== 'idle') return false
    if (current.frame.revision !== candidate.sourceRevision || current.frame.snapshotHash !== candidate.sourceHash) return false
    const last = current.frame.state.messages.at(-1)
    if (last?.role === 'user' && runtimeJson(last.content).hash === content.contentHash) {
      return runtimeError('RUNTIME_RECEIPT_INVALID', '作者补充消息已进入执行帧但缺少消费回执。')
    }
    const next = await saveExecutionStateInTransaction(tx, token, {
      expectedRevision: current.frame.revision, expectedHash: current.frame.snapshotHash,
      snapshot: { ...current.frame.state, messages: [...current.frame.state.messages, { role: 'user', content: content.content }] },
    })
    await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: token.taskRootId, runId: token.runId,
      eventKey, type: 'goal.steering.consumed', payload: { version: 1, messageId: candidate.messageId, partsHash: candidate.partsHash,
        contentHash: content.contentHash, sourceRevision: current.frame.revision, sourceHash: current.frame.snapshotHash,
        revision: next.revision, snapshotHash: next.snapshotHash } } })
    return true
  })
}

/** Apply a newly selected goal model to the existing durable root. The root,
 * saved messages, tool policy and budget remain immutable; only the frozen
 * model route changes, with a durable receipt. */
async function refreshDurableGoalModel(token: RunLeaseToken) {
  const requested = await withRunLease(token, async tx => {
    const binding = await tx.agentGoalExecution.findUnique({ where: { runId: token.runId }, select: { trigger: true } })
    if (!binding || binding.trigger === 'author') return null
    const run = await tx.agentRun.findUniqueOrThrow({ where: { id: token.runId }, select: { modelTier: true, customModelId: true, reasoningEffort: true } })
    const state = await readExecutionStateInTransaction(tx, token.taskRootId)
    const model = state.configuration.model
    if (model.tier === run.modelTier && model.customModelId === run.customModelId && model.reasoningEffort === run.reasoningEffort) return null
    if (state.frame.state.phase !== 'idle') return null
    return { tier: run.modelTier, customModelId: run.customModelId, reasoningEffort: run.reasoningEffort }
  })
  if (!requested) return false
  const effort = reasoning.safeParse(requested.reasoningEffort)
  if (!effort.success) return runtimeError('RUNTIME_MODEL_ADAPTER_REQUIRED', '目标续跑的推理配置无效。')
  const runtime = await getModelTierRuntime(requested.tier as import('../../../shared/contracts/index.js').CreditModelTier, token.userId,
    requested.tier === 'custom' ? requested.customModelId : null, effort.data)
  if (runtime.tier !== requested.tier) return runtimeError('RUNTIME_MODEL_ADAPTER_REQUIRED', '目标续跑模型路由未按原档位解析。')
  const modelName = runtime.modelName ?? env.aiTextModel
  const endpoint = `${(runtime.baseUrl ?? env.aiTextBaseUrl).replace(/\/$/, '')}/chat/completions`
  const routeRevision = modelRouteRevision({ provider: runtime.provider, model: modelName, endpoint, reasoningEffort: runtime.reasoningEffort })
  return withRunLease(token, async tx => {
    const binding = await tx.agentGoalExecution.findUnique({ where: { runId: token.runId }, select: { trigger: true } })
    if (!binding || binding.trigger === 'author') return false
    const run = await tx.agentRun.findUniqueOrThrow({ where: { id: token.runId }, select: { modelTier: true, customModelId: true, reasoningEffort: true } })
    if (run.modelTier !== requested.tier || run.reasoningEffort !== requested.reasoningEffort) return runtimeError('RUNTIME_STATE_CONFLICT', '目标模型选项在续跑过程中发生变化，请重新继续。')
    const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: token.taskRootId } })
    const state = await readExecutionStateInTransaction(tx, token.taskRootId)
    if (state.frame.state.phase !== 'idle') return false
    const [pendingOperations, pendingAttempts] = await Promise.all([
      tx.agentOperation.count({ where: { taskRootId: token.taskRootId, status: { in: ['prepared', 'dispatched'] } } }),
      tx.agentProviderAttempt.count({ where: { operation: { taskRootId: token.taskRootId }, status: { in: ['prepared', 'dispatched', 'unknown'] } } }),
    ])
    if (pendingOperations || pendingAttempts) return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '目标仍有未决模型操作，不能切换模型路由。')
    if (state.configuration.model.tier === run.modelTier && state.configuration.model.customModelId === run.customModelId
      && state.configuration.model.reasoningEffort === run.reasoningEffort) return false
    const nextConfiguration = { ...state.configuration, model: { ...state.configuration.model,
      tier: runtime.tier, provider: runtime.provider, modelName, customModelId: runtime.tier === 'custom' ? run.customModelId : null,
      maxOutputTokens: env.aiTextMaxOutputTokens, contextWindowTokens: runtime.contextWindowTokens ?? env.agentContextWindowTokens,
      reasoningEffort: runtime.reasoningEffort, routeRevision } }
    const configuration = runtimeJson(nextConfiguration)
    const configurationHash = runtimeJson({ configuration: configuration.value, inputHash: root.inputHash }).hash
    const eventKey = `goal-model:${token.taskRootId}:${token.runId}`
    const existing = await tx.agentExecutionOutbox.findUnique({ where: { eventKey } })
    if (existing) {
      if (existing.taskRootId !== token.taskRootId || existing.runId !== token.runId || existing.type !== 'goal.model.changed'
        || runtimeJson(existing.payload).hash !== runtimeJson({ version: 1, runId: token.runId, fromHash: state.head.configurationHash,
          toHash: configurationHash, tier: runtime.tier, reasoningEffort: runtime.reasoningEffort }).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '目标模型切换回执与冻结配置不一致。')
      if (state.head.configurationHash !== configurationHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '目标模型切换回执已写入但配置未更新。')
      return false
    }
    await tx.agentExecutionState.update({ where: { taskRootId: token.taskRootId }, data: { configuration: configuration.value, configurationHash } })
    await tx.agentExecutionOutbox.create({ data: { id: randomUUID(), taskRootId: token.taskRootId, runId: token.runId,
      eventKey, type: 'goal.model.changed', payload: { version: 1, runId: token.runId, fromHash: state.head.configurationHash,
        toHash: configurationHash, tier: runtime.tier, reasoningEffort: runtime.reasoningEffort } } })
    return true
  })
}

/** Internal worker entry. The saved cursor chooses work; callers cannot supply
 * messages, tool args, a new task prompt, a price, or an operation sequence.
 * Completion review is a handoff, never proof that the user task is complete. */
export async function executeDurableStep(token: RunLeaseToken, signal: AbortSignal) {
  const lease = { ...token }
  signal.throwIfAborted()
  const importBoundary = await readDurableImportBoundary(lease)
  if (importBoundary) return importBoundary
  // Goal continuations carry the author's real steering message in AgentMessage;
  // append it to the immutable execution frame only once, at an idle boundary.
  if (!lease.parent) {
    await consumeDurableSteering(lease)
    await consumeDurableGoalConsent(lease)
    await consumeDurableConfigurationConsent(lease)
  }
  // A resumed goal may have an explicitly selected model. Update only the
  // frozen route while retaining the original root, frame history and budget.
  if (!lease.parent) await refreshDurableGoalModel(lease)
  await wakeDurableChildren(lease)
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
    const writingDelivery = await advanceDurableWritingDelivery(lease)
    if (writingDelivery) return { kind: 'context' as const, frame: writingDelivery }
    const memory = await advanceDurableMemory(lease)
    if (memory) return memory
    const tool = await executeDurableToolStep(lease, signal)
    if (tool.kind !== 'idle') return tool
    const stagnation = await advanceDurableToolStagnation(lease)
    if (stagnation) return stagnation
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
  const tier = durableModelTier.safeParse(configuration.model.tier)
  const effort = reasoning.safeParse(configuration.model.reasoningEffort)
  if (!tier.success || !effort.success || tier.data === 'custom' && !configuration.model.customModelId) return runtimeError('RUNTIME_MODEL_ADAPTER_REQUIRED', '原模型配置缺少可核验的自定义模型身份。')
  const runtime = await getModelTierRuntime(tier.data as import('../../../shared/contracts/index.js').CreditModelTier, lease.userId,
    tier.data === 'custom' ? configuration.model.customModelId : null, effort.data)
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
  const child = await withRunLease(lease, tx => tx.agentChildExecutionGrant.findUnique({ where: { childRunId: lease.runId } }))
  const price = child ? verifyChildGrant(child).price : await resolveDurableTokenPrice(lease, operationKey, tier.data, runtime.multiplierBps)
  if (price.modelTier !== tier.data) return runtimeError('RUNTIME_PRICE_INVALID', '冻结价目与当前模型身份不一致。')
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
  const { setGoalRunPhase } = await import('./goal-runtime.js')
  await setGoalRunPhase(token.userId, token.runId, question ? 'awaiting_input' : 'awaiting_approval')
  const result = await withLeaseHeartbeat(token, signal, async ownedSignal => {
    for (;;) {
      ownedSignal.throwIfAborted()
      const outcome = await withRunLease(token, async tx => {
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
        if (decision) return 'resolved' as const
        return Date.parse(deadline.expiresAt) - (await databaseNow(tx)).getTime() <= 0 ? 'expired' as const : 'pending' as const
      })
      if (outcome === 'resolved' || outcome === 'expired') return outcome === 'resolved'
      await delay(1000, undefined, { signal: ownedSignal })
    }
  })
  if (!signal.aborted && result) await setGoalRunPhase(token.userId, token.runId, 'executing')
  return result
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
      const resolved = await waitForDurableDecision(lease, signal, { kind: step.kind, requestId })
      if (!resolved) return step
      continue
    }
    if (step.kind !== 'completion_review') return step
    const children = await withLeaseHeartbeat(lease, signal, ownedSignal => awaitDurableChildren(lease, ownedSignal))
    if (children.some(child => child.status !== 'completed' || child.childRun.status !== 'completed')) {
      await pauseDurableTaskForAttention(lease, { expectedRevision: step.frame.revision, expectedHash: step.frame.snapshotHash }, 'needs_input')
      return { kind: 'needs_attention' as const, reason: '子任务仍未完成或结果待核对，父任务已暂停并保留原进度。', frame: step.frame }
    }
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
