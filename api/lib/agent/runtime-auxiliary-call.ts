import { selectWeightedModelRuntime, resolveWeightedModelRuntime } from '../model-weighted-routing.js'
import { z } from 'zod'
import { weightedRouteSelectionSchema, type WeightedRouteSelection } from '../../../shared/contracts/model-weighted-routes.js'
import { supportsReviewJsonObject } from '../ai-response-format.js'
import { creditModelTierSchema } from '../../../shared/contracts/credits.js'
import type { CreditModelTier, ModelReasoningEffort } from '../../../shared/contracts/credits.js'
import { env } from '../../config/env.js'
import { chatWithTools, resolveTextOutputTokenParameter, type ChatCompletionResult } from '../ai-service.js'
import { getModelTierRuntime } from '../credits.js'
import { runtimeError, runtimeJson, type RuntimeTx } from './runtime-common.js'
import { withManuscriptRunLease, withRunLease, type RunLeaseToken } from './runtime-lease.js'
import { beginDurableChat } from './runtime-provider.js'
import type { AuxiliaryModelStep } from './runtime-auxiliary-model.js'
import type { DurableTokenPrice } from './runtime-settlement.js'
import type { ToolContext } from './tools/types.js'
import { estimateChatMessagesTokens, resolveDurableInputLimit } from './context-budget.js'

const auxiliaryTierSchema = creditModelTierSchema
const reasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

export const auxiliaryRouteSchema = z.object({
  weightedRoute: weightedRouteSelectionSchema.optional(),
  /** Optional fields keep pre-G22 operation snapshots hash-stable. */
  tier: auxiliaryTierSchema.optional(),
  customModelId: z.string().min(1).nullable().optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  honorReasoningEffort: z.literal(true).optional(),
  /** Absent on old routes: never retrofit their original request contract. */
  responseFormat: z.literal('json_object').optional(),
  provider: z.string(), model: z.string(), baseUrl: z.string(), maxOutputTokens: z.number().int().positive(),
}).strict().superRefine((value, ctx) => {
  if (value.tier === 'custom' && !value.customModelId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['customModelId'], message: '自定义辅助模型缺少模型身份。' })
})

export type DurableAuxiliaryModelSelection = {
  weightedRoute?: WeightedRouteSelection
  tier: CreditModelTier
  customModelId: string | null
  reasoningEffort: ModelReasoningEffort
}

type ReviewRuntimeInput = {
  userId: string
  novelId?: string | null
  modelRuntime?: ToolContext['modelRuntime']
  modelSelection?: DurableAuxiliaryModelSelection & Partial<Pick<NonNullable<ToolContext['modelSelection']>, 'provider' | 'modelName'>>
  modelAssignments?: import('../../../shared/contracts/agent-model-assignments.js').FrozenModelAssignments
  task?: 'continuity' | 'quality'
}

/** New checks follow the admitted complete runtime, including paid models.
 * Native adapters may supply only the frozen selected identity; resolve that
 * exact tier/account instead of minting an independent speed critic. */
async function resolveReviewRuntime(input: ReviewRuntimeInput, nativeIdentity: boolean) {
  // Review task assignments cannot replace the current admitted model or price.
  const selected = input.modelSelection
  if (!input.modelRuntime && !selected || selected?.tier === 'custom' && !selected.customModelId) {
    return runtimeError('RUNTIME_MODEL_ADAPTER_REQUIRED', '检查缺少原任务已选择的完整模型身份，未派发模型请求。')
  }
  const runtime = input.modelRuntime ?? resolveWeightedModelRuntime(await getModelTierRuntime(selected!.tier, input.userId, selected!.customModelId, selected!.reasoningEffort), selected?.weightedRoute)
  const selection = selected ?? { tier: runtime.tier, customModelId: null, reasoningEffort: runtime.reasoningEffort }
  if (nativeIdentity && selection.tier === 'custom' && !selection.customModelId) return runtimeError('RUNTIME_MODEL_ADAPTER_REQUIRED', '辅助模型未能继承原任务的模型身份。')
  if (selection.tier !== runtime.tier || selection.reasoningEffort !== runtime.reasoningEffort
    || selected?.provider !== undefined && selected.provider !== runtime.provider
    || selected?.modelName !== undefined && selected.modelName !== (runtime.modelName ?? env.aiTextModel)) return runtimeError('RUNTIME_IDENTITY_CONFLICT', '原任务的检查模型身份已变化，不能替换供应商或模型。')
  return { runtime, selection: { ...selection, reasoningEffort: runtime.reasoningEffort } }
}

/** Legacy main/inline calls already carry owned credentials/capabilities; a
 * custom runtime needs no reconstructed model ID for its in-process request. */
export async function resolveReviewModelRuntime(input: ReviewRuntimeInput) {
  return selectWeightedModelRuntime((await resolveReviewRuntime(input, false)).runtime)
}

export async function resolveDurableAuxiliaryRuntime(input: ReviewRuntimeInput) {
  const resolved = await resolveReviewRuntime(input, true)
  return { ...resolved, runtime: selectWeightedModelRuntime(resolved.runtime) }
}

export function auxiliaryRouteForRuntime(runtime: NonNullable<ToolContext['modelRuntime']> & { honorAssignedReasoning?: true }, selection: DurableAuxiliaryModelSelection, maxOutputTokens: number) {
  return auxiliaryRouteSchema.parse({
    ...(runtime.weightedRoute ? { weightedRoute: runtime.weightedRoute } : {}), tier: selection.tier,
    customModelId: selection.tier === 'custom' ? selection.customModelId : null,
    reasoningEffort: runtime.reasoningEffort,
    ...(runtime.honorAssignedReasoning ? { honorReasoningEffort: true as const } : {}),
    provider: runtime.provider,
    model: runtime.modelName ?? env.aiTextModel,
    baseUrl: runtime.baseUrl ?? env.aiTextBaseUrl,
    ...(supportsReviewJsonObject(runtime.baseUrl ?? env.aiTextBaseUrl, runtime.modelName ?? env.aiTextModel) ? { responseFormat: 'json_object' as const } : {}),
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
  const preparedRequest = existing ? z.object({ input: z.object({ request: z.object({ endpoint: z.string(), body: z.record(z.string(), z.unknown()) }) }) }).parse(existing.inputSnapshot).input.request : undefined
  await withManuscriptRunLease(lease, input.assertCurrent, step.startsWith('continuity_') || step.startsWith('quality_') ? { timeoutMs: 20_000 } : undefined)
  const routeTier = (input.route.tier ?? 'speed') as CreditModelTier
  const routeCustomModelId = input.route.customModelId ?? null
  const routeReasoningEffort = (input.route.reasoningEffort ?? 'low') as ModelReasoningEffort
  const runtime = resolveWeightedModelRuntime(await getModelTierRuntime(routeTier, lease.userId, routeTier === 'custom' ? routeCustomModelId : null, routeReasoningEffort), input.route.weightedRoute)
  if (runtime.tier !== routeTier || runtime.reasoningEffort !== routeReasoningEffort
    || input.price.modelTier !== routeTier
    || runtime.provider !== input.route.provider || (runtime.modelName ?? env.aiTextModel) !== input.route.model
    || (runtime.baseUrl ?? env.aiTextBaseUrl) !== input.route.baseUrl) return runtimeError('RUNTIME_IDENTITY_CONFLICT', '原独立复核路由已变化，不能发送给另一模型。')
  const inputLimit = resolveDurableInputLimit(runtime.contextWindowTokens ?? env.agentContextWindowTokens, input.route.maxOutputTokens)
  if (!inputLimit || estimateChatMessagesTokens([{ role: 'system', content: system }, { role: 'user', content }]) > inputLimit) {
    return runtimeError('RUNTIME_CONTEXT_LIMIT', '独立复核输入超过模型窗口，未派发请求；不能截掉正文后声称完成全文检查。')
  }
  return chatWithTools({ weightedRoute: runtime.weightedRoute, messages: [{ role: 'system', content: system }, { role: 'user', content }], tools: [], provider: input.route.provider, model: input.route.model,
    providerBaseUrl: input.route.baseUrl, providerApiKey: runtime.apiKey, reasoningEffort: runtime.reasoningEffort, temperature, maxOutputTokens: input.route.maxOutputTokens, signal: input.signal,
    boundedReview: !input.route.honorReasoningEffort, thinkingEnabled: runtime.thinkingEnabled, reasoningParameterMode: runtime.reasoningParameterMode,
    reasoningEfforts: [...runtime.reasoningEfforts],
    responseFormat: input.route.responseFormat,
    outputTokenParameter: resolveTextOutputTokenParameter(runtime.outputTokenParameter, { provider: input.route.provider, providerBaseUrl: input.route.baseUrl, model: input.route.model }, true),
    preparedAuxiliaryRequest: preparedRequest, durableExecution: execution, usageLog: { userId: lease.userId, agentRunId: lease.runId, action: step, modelTier: routeTier, multiplierBps: input.price.multiplierBps } })
}
