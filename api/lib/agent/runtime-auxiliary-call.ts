import { z } from 'zod'
import { creditModelTierSchema } from '../../../shared/contracts/credits.js'
import type { CreditModelTier, ModelReasoningEffort } from '../../../shared/contracts/credits.js'
import { env } from '../../config/env.js'
import { chatWithTools, resolveTextOutputTokenParameter, type ChatCompletionResult } from '../ai-service.js'
import { getModelTierRuntime } from '../credits.js'
import { auxiliaryTextModel } from './auxiliary-text-model.js'
import { runtimeError, runtimeJson, type RuntimeTx } from './runtime-common.js'
import { withManuscriptRunLease, withRunLease, type RunLeaseToken } from './runtime-lease.js'
import { beginDurableChat } from './runtime-provider.js'
import type { AuxiliaryModelStep } from './runtime-auxiliary-model.js'
import type { DurableTokenPrice } from './runtime-settlement.js'
import type { ToolContext } from './tools/types.js'
import { estimateChatMessagesTokens, resolveDurableInputLimit } from './context-budget.js'
import { assignedTaskModel } from './model-assignment-context.js'

const auxiliaryTierSchema = creditModelTierSchema
const reasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

export const auxiliaryRouteSchema = z.object({
  /** Optional fields keep pre-G22 operation snapshots hash-stable. */
  tier: auxiliaryTierSchema.optional(),
  customModelId: z.string().min(1).nullable().optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  honorReasoningEffort: z.literal(true).optional(),
  provider: z.string(), model: z.string(), baseUrl: z.string(), maxOutputTokens: z.number().int().positive(),
}).strict().superRefine((value, ctx) => {
  if (value.tier === 'custom' && !value.customModelId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['customModelId'], message: '自定义辅助模型缺少模型身份。' })
})

export type DurableAuxiliaryModelSelection = {
  tier: CreditModelTier
  customModelId: string | null
  reasoningEffort: ModelReasoningEffort
}

/** Resolve auxiliary work from the already admitted main runtime when it is
 * free or BYOK. Paid platform runs keep the historical independent speed
 * critic policy. The returned selection is the exact route identity frozen
 * into the operation input. */
export async function resolveDurableAuxiliaryRuntime(input: {
  userId: string
  modelRuntime?: ToolContext['modelRuntime']
  modelSelection?: DurableAuxiliaryModelSelection
  modelAssignments?: import('../../../shared/contracts/agent-model-assignments.js').FrozenModelAssignments
  task?: 'continuity' | 'quality'
}) {
  const assigned = input.task ? await assignedTaskModel(input.userId, null, input.task, input.modelAssignments, true) : undefined
  if (assigned) return { runtime: { ...assigned.runtime, honorAssignedReasoning: true as const }, selection: { tier: assigned.selection.modelTier,
    customModelId: assigned.selection.customModelId ?? null, reasoningEffort: assigned.runtime.reasoningEffort } }
  const inherited = auxiliaryTextModel(input.modelRuntime)
  if (inherited) {
    const selection = input.modelSelection ?? { tier: inherited.tier, customModelId: null, reasoningEffort: inherited.reasoningEffort }
    if (selection.tier !== inherited.tier || selection.tier === 'custom' && !selection.customModelId) {
      return runtimeError('RUNTIME_MODEL_ADAPTER_REQUIRED', '辅助模型未能继承原任务的模型身份。')
    }
    return { runtime: inherited, selection: { ...selection, reasoningEffort: inherited.reasoningEffort } }
  }
  // Quality's wire policy is applied after resolution; do not request an
  // unsupported low setting from a model whose native default is high.
  const runtime = input.task === 'quality' ? await getModelTierRuntime('speed', input.userId)
    : await getModelTierRuntime('speed', input.userId, null, 'low')
  if (runtime.tier !== 'speed') return runtimeError('RUNTIME_IDENTITY_CONFLICT', '独立辅助模型档位不可替换。')
  return { runtime, selection: { tier: 'speed' as const, customModelId: null, reasoningEffort: runtime.reasoningEffort } }
}

export function auxiliaryRouteForRuntime(runtime: NonNullable<ToolContext['modelRuntime']> & { honorAssignedReasoning?: true }, selection: DurableAuxiliaryModelSelection, maxOutputTokens: number) {
  return auxiliaryRouteSchema.parse({
    tier: selection.tier,
    customModelId: selection.tier === 'custom' ? selection.customModelId : null,
    reasoningEffort: runtime.reasoningEffort,
    ...(runtime.honorAssignedReasoning ? { honorReasoningEffort: true as const } : {}),
    provider: runtime.provider,
    model: runtime.modelName ?? env.aiTextModel,
    baseUrl: runtime.baseUrl ?? env.aiTextBaseUrl,
    maxOutputTokens,
  })
}

/** Replay original paid results without resolving today's credentials. Only new
 * dispatch checks current business state and the frozen provider route. */
export async function callDurableAuxiliary(input: {
  lease: RunLeaseToken; parentOperationId: string; step: AuxiliaryModelStep;
  route: z.infer<typeof auxiliaryRouteSchema>; price: DurableTokenPrice;
  system: string; content: string; temperature: number; signal: AbortSignal;
  assertCurrent: (tx: RuntimeTx) => Promise<void>;
}): Promise<ChatCompletionResult> {
  input = { ...input, lease: { ...input.lease }, route: { ...input.route }, price: structuredClone(input.price) }
  const lease = { ...input.lease }, { step, system, content, temperature } = input
  input.signal.throwIfAborted()
  const key = `aux:${input.parentOperationId}:${step}`
  const existing = await withRunLease(lease, async tx => {
    const op = await tx.agentOperation.findUnique({ where: { taskRootId_operationKey: { taskRootId: lease.taskRootId, operationKey: key } } })
    if (!op) return null
    if (runtimeJson(op.inputSnapshot).hash !== op.inputHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '独立模型原请求损坏。')
    return op
  })
  if (!input.route || !input.price) return runtimeError('RUNTIME_RECEIPT_INVALID', '独立模型路由或价目缺失。')
  const execution = { lease, operationKey: key, parentOperationId: input.parentOperationId, auxiliaryStep: step, attemptKey: '1', price: input.price }
  if (existing && existing.status !== 'prepared') {
    const saved = z.object({ input: z.object({ request: z.record(z.string(), z.unknown()) }) }).parse(existing.inputSnapshot)
    const replay = await beginDurableChat({ execution, userId: lease.userId, agentRunId: lease.runId, action: step, provider: input.route.provider, model: input.route.model,
      request: runtimeJson(saved.input.request).value, price: input.price, admit: async () => runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '原请求不得再次派发。') })
    if (!replay.replay) return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '原请求尚无完整结果。')
    return replay.replay
  }
  await withManuscriptRunLease(lease, input.assertCurrent)
  const routeTier = (input.route.tier ?? 'speed') as CreditModelTier
  const routeCustomModelId = input.route.customModelId ?? null
  const routeReasoningEffort = (input.route.reasoningEffort ?? 'low') as ModelReasoningEffort
  const runtime = await getModelTierRuntime(routeTier, lease.userId, routeTier === 'custom' ? routeCustomModelId : null, routeReasoningEffort)
  if (runtime.tier !== routeTier || runtime.reasoningEffort !== routeReasoningEffort
    || input.price.modelTier !== routeTier
    || runtime.provider !== input.route.provider || (runtime.modelName ?? env.aiTextModel) !== input.route.model
    || (runtime.baseUrl ?? env.aiTextBaseUrl) !== input.route.baseUrl) return runtimeError('RUNTIME_IDENTITY_CONFLICT', '原独立复核路由已变化，不能发送给另一模型。')
  const inputLimit = resolveDurableInputLimit(runtime.contextWindowTokens ?? env.agentContextWindowTokens, input.route.maxOutputTokens)
  if (!inputLimit || estimateChatMessagesTokens([{ role: 'system', content: system }, { role: 'user', content }]) > inputLimit) {
    return runtimeError('RUNTIME_CONTEXT_LIMIT', '独立复核输入超过模型窗口，未派发请求；不能截掉正文后声称完成全文检查。')
  }
  return chatWithTools({ messages: [{ role: 'system', content: system }, { role: 'user', content }], tools: [], provider: input.route.provider, model: input.route.model,
    providerBaseUrl: input.route.baseUrl, providerApiKey: runtime.apiKey, reasoningEffort: runtime.reasoningEffort, temperature, maxOutputTokens: input.route.maxOutputTokens, signal: input.signal,
    boundedReview: !input.route.honorReasoningEffort, thinkingEnabled: runtime.thinkingEnabled, reasoningParameterMode: runtime.reasoningParameterMode,
    reasoningEfforts: [...runtime.reasoningEfforts],
    outputTokenParameter: resolveTextOutputTokenParameter(runtime.outputTokenParameter, { provider: input.route.provider, providerBaseUrl: input.route.baseUrl, model: input.route.model }, true),
    durableExecution: execution, usageLog: { userId: lease.userId, agentRunId: lease.runId, action: step, modelTier: routeTier, multiplierBps: input.price.multiplierBps } })
}
