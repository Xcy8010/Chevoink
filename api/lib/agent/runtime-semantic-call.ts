import { z } from 'zod'
import { env } from '../../config/env.js'
import { chatWithTools, resolveTextOutputTokenParameter, type ChatMessage } from '../ai-service.js'
import type { getModelTierRuntime } from '../credits.js'
import type { TokenPrice } from '../billing/token-price.js'
import { DataAccessError } from '../prisma.js'
import { estimateChatMessagesTokens, resolveDurableInputLimit } from './context-budget.js'
import { runtimeError, runtimeJson, runtimeJsonHash } from './runtime-common.js'
import { modelRouteRevision } from './runtime-model-cursor.js'
import { assertProviderBudget } from './runtime-budget.js'
import { withRunLease, type RunLeaseToken } from './runtime-lease.js'
import { beginDurableChat } from './runtime-provider.js'
import { assertSummarySource, SEMANTIC_ACTION, summaryOperationKey, type SummarySource } from './runtime-semantic-cursor.js'
import { readExecutionStateInTransaction } from './runtime-state.js'

type Model = Awaited<ReturnType<typeof readExecutionStateInTransaction>>['configuration']['model']
type Runtime = Awaited<ReturnType<typeof getModelTierRuntime>>
const savedRequest = z.object({ endpoint: z.string(), body: z.record(z.string(), z.unknown()) }).passthrough()
const envelope = z.object({ input: z.object({ source: z.unknown(), request: savedRequest, billing: z.unknown() }) })

/** The original model contract is also the spending authority for this step.
 * Older roots without a frozen price can still use deterministic compaction. */
export async function callDurableContextSummary(input: {
  lease: RunLeaseToken; source: SummarySource; runtime: Runtime; model: Model; window: number; maxOutputTokens: number;
  system: string; content: string; signal: AbortSignal;
}) {
  const { lease, source, model, runtime, system, content, signal } = input
  const price: TokenPrice | undefined = model.tokenPrice
  if (!price) return null
  const messages: ChatMessage[] = [{ role: 'system', content: system }, { role: 'user', content }]
  const maxOutputTokens = Math.min(8192, input.maxOutputTokens)
  if (runtimeJsonHash({ system, content }) !== source.planHash) return runtimeError('RUNTIME_IDENTITY_CONFLICT', '摘要原文与执行帧绑定的材料不一致。')
  const modelName = runtime.modelName ?? env.aiTextModel
  const baseUrl = runtime.baseUrl ?? env.aiTextBaseUrl
  const revision = modelRouteRevision({ provider: runtime.provider, model: modelName, endpoint: `${baseUrl.replace(/\/$/, '')}/chat/completions`,
    reasoningEffort: runtime.reasoningEffort, ...(runtime.weightedRoute ? { weightedRoute: runtime.weightedRoute } : {}),
    ...(model.toolCallingProtocol ? { toolCallingProtocol: model.toolCallingProtocol } : {}) })
  signal.throwIfAborted()
  const key = summaryOperationKey(source)
  const execution = { lease, operationKey: key, attemptKey: '1', summarySource: source, price }
  const where = { taskRootId_operationKey: { taskRootId: lease.taskRootId, operationKey: key } }
  const existing = await withRunLease(lease, async tx => {
    assertSummarySource(source, await readExecutionStateInTransaction(tx, lease.taskRootId))
    const op = await tx.agentOperation.findUnique({ where })
    if (!op) return null
    if (op.kind !== 'provider' || op.action !== SEMANTIC_ACTION || op.parentOperationId || runtimeJsonHash(op.inputSnapshot) !== op.inputHash) {
      return runtimeError('RUNTIME_RECEIPT_INVALID', '摘要操作的原请求已损坏。')
    }
    const saved = envelope.parse(op.inputSnapshot).input
    if (runtimeJsonHash(saved.source) !== runtimeJsonHash(source) || runtimeJsonHash(saved.billing) !== runtimeJsonHash(price)) {
      return runtimeError('RUNTIME_IDENTITY_CONFLICT', '原帧摘要已经绑定另一份材料或计价配置。')
    }
    return { status: op.status, request: saved.request }
  })
  const replayOnly = existing && existing.status !== 'prepared'
  if (!replayOnly) {
    if (model.tier === 'custom' && (!model.customModelRevision || model.customModelRevision !== runtime.customModelRevision)) return null
    if (maxOutputTokens < 1 || estimateChatMessagesTokens(messages) > resolveDurableInputLimit(input.window, maxOutputTokens)) return null
    if (model.routeRevision !== revision || model.tier !== runtime.tier || model.provider !== runtime.provider || model.modelName !== modelName
      || price.modelTier !== runtime.tier || model.modelConfigId && model.modelConfigId !== runtime.modelConfigId
      || model.modelConfigRevision && model.modelConfigRevision !== runtime.modelConfigRevision) {
      return runtimeError('RUNTIME_IDENTITY_CONFLICT', '摘要模型与原任务的冻结身份或线路不一致。')
    }
  }
  try {
    const result = replayOnly
      ? (await beginDurableChat({ execution, userId: lease.userId, agentRunId: lease.runId, action: SEMANTIC_ACTION, provider: model.provider,
        model: model.modelName!, request: runtimeJson(existing.request).value, price,
        admit: async () => runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '已派发的摘要不能再次请求。') })).replay
      : await chatWithTools({ semanticCompaction: true, messages, tools: [], provider: runtime.provider, model: modelName, providerBaseUrl: baseUrl,
        weightedRoute: runtime.weightedRoute, physicalRouteId: runtime.physicalRouteId, providerApiKey: runtime.apiKey, maxOutputTokens, signal,
        reasoningEffort: runtime.reasoningEffort, reasoningEfforts: runtime.reasoningEfforts, thinkingEnabled: runtime.thinkingEnabled,
        reasoningParameterMode: runtime.reasoningParameterMode, toolCallingProtocol: model.toolCallingProtocol,
        outputTokenParameter: resolveTextOutputTokenParameter(runtime.outputTokenParameter, { provider: runtime.provider, providerBaseUrl: baseUrl, model: modelName }, true),
        preparedAuxiliaryRequest: existing?.request, durableExecution: execution,
        usageLog: { userId: lease.userId, agentRunId: lease.runId, action: SEMANTIC_ACTION, modelTier: runtime.tier, multiplierBps: price.multiplierBps } })
    if (!result || result.billing?.status !== 'settled') return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '摘要请求尚无完整的结果和计量回执。')
    return result.finishReason === 'stop' && !result.toolCalls.length ? result.content : null
  } catch (error) {
    signal.throwIfAborted()
    // A known provider failure can lose this optional optimization. Never
    // swallow unknown dispatch, accounting, lease, scope or receipt failures.
    if (!(error instanceof DataAccessError) || !['AI_PROVIDER_ERROR', 'AI_PROVIDER_TIMEOUT'].includes(error.code)) throw error
    await withRunLease(lease, async tx => {
      const op = await tx.agentOperation.findUnique({ where })
      if (!op || op.status !== 'failed') throw error
      await assertProviderBudget(tx, lease.taskRootId)
    })
    return null
  }
}
