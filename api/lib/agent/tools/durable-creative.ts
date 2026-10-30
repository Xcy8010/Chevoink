import { selectWeightedModelRuntime, resolveWeightedModelRuntime } from '../../model-weighted-routing.js'
import { z } from 'zod'
import { env } from '../../../config/env.js'
import { getModelTierRuntime } from '../../credits.js'
import { DataAccessError } from '../../prisma.js'
import { tokenPriceSchema } from '../../billing/token-price.js'
import { resolveDurableTokenPrice } from '../../billing/resolve-token-price.js'
import { assignedTaskModel } from '../model-assignment-context.js'
import { auxiliaryTextModel } from '../auxiliary-text-model.js'
import { auxiliaryRouteForRuntime, auxiliaryRouteSchema, callDurableAuxiliary, resolveDurableAuxiliaryRuntime } from '../runtime-auxiliary-call.js'
import { runtimeError, runtimeJson } from '../runtime-common.js'
import { withRunLease, withManuscriptRunLease } from '../runtime-lease.js'
import { prepareToolCursorOperation, readAdmittedToolOperation } from '../runtime-tool-cursor.js'
import { assertCurrentToolPolicy, commitOperationEffect, recordToolFailure } from '../runtime-operations.js'
import { reduceExecutionReceipt, failedToolResultSchema } from '../runtime-reducer.js'
import { normalizeToolInput } from './input-validation.js'
import { creativeReviewWorkSchema, prepareCreativeReview, assertCreativeReviewCurrent, saveCreativeReview } from './creative-review.js'
import type { AgentTool, ToolContext, ToolResult } from './types.js'

const workSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rejected'), code: z.string(), message: z.string() }).strict(),
  z.object({ kind: z.literal('creative'), version: z.literal(1), review: creativeReviewWorkSchema,
    route: auxiliaryRouteSchema, price: tokenPriceSchema }).strict(),
])

/** Critique and revision keep independent input and original auxiliary pricing.
 * Provider result, artifact receipt and the real model cursor remain distinct. */
export async function executeDurableCreative(ctx: ToolContext, tool: AgentTool, raw: unknown): Promise<ToolResult> {
  const capability = ctx.durableCreative
  const step = tool.name === 'creative_critique' ? 'creative_critique' : 'creative_revision'
  if (!capability || !['creative_critique', 'creative_revision_draft'].includes(tool.name)
    || capability.lease.userId !== ctx.userId || capability.lease.runId !== ctx.runId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '创作辅助缺少原任务能力。')
  const lease = { ...capability.lease }, cursor = { ...capability.cursor }
  const normalize = (value: unknown) => Object.fromEntries(Object.entries(tool.parameters.parse(normalizeToolInput(tool, value)) as Record<string, unknown>).filter(([, value]) => value !== undefined))
  const args = normalize(raw)
  const old = await withRunLease(lease, async tx => {
    const operation = await tx.agentOperation.findUnique({ where: { taskRootId_operationKey: { taskRootId: lease.taskRootId, operationKey: capability.operationKey } } })
    if (!operation) return null
    if (runtimeJson(operation.inputSnapshot).hash !== operation.inputHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '创作辅助原输入损坏。')
    return z.object({ input: z.object({ work: workSchema }) }).parse(operation.inputSnapshot).input.work
  })
  let work = old
  if (!work) {
    try {
      const review = await withManuscriptRunLease(lease, tx => prepareCreativeReview({ ...ctx, transaction: tx },
        args as Parameters<typeof prepareCreativeReview>[1], step === 'creative_critique' ? 'critique' : 'revision'))
      const assigned = await assignedTaskModel(ctx.userId, ctx.novelId, step === 'creative_critique' ? 'creative_critique' : 'creative_revision', ctx.modelAssignments, true)
      const selected = ctx.modelSelection
      const main = ctx.modelRuntime ?? (selected ? resolveWeightedModelRuntime(await getModelTierRuntime(selected.tier, ctx.userId, selected.customModelId, selected.reasoningEffort), selected.weightedRoute) : undefined)
      const inherited = !assigned && auxiliaryTextModel(main)
      const inheritedRuntime = inherited ? await resolveDurableAuxiliaryRuntime({ userId: ctx.userId, modelRuntime: inherited, modelSelection: selected }) : undefined
      const runtime = selectWeightedModelRuntime(assigned?.runtime ?? inheritedRuntime?.runtime ?? await getModelTierRuntime('speed', ctx.userId))
      const selection = { tier: runtime.tier, customModelId: runtime.tier === 'custom' ? assigned?.selection.customModelId ?? selected?.customModelId ?? null : null, reasoningEffort: runtime.reasoningEffort }
      if (selection.tier === 'custom' && !selection.customModelId) return runtimeError('RUNTIME_MODEL_ADAPTER_REQUIRED', '创作辅助缺少原自定义模型身份。')
      const route = auxiliaryRouteForRuntime({ ...runtime, honorAssignedReasoning: true }, selection, env.aiTextMaxOutputTokens)
      // These tools produce prose; the critic JSON response format is inapplicable.
      delete route.responseFormat
      work = { kind: 'creative', version: 1, review, route, price: await resolveDurableTokenPrice(lease, `${capability.operationKey}:creative-price`, runtime.tier, runtime.multiplierBps) }
    } catch (error) {
      if (!(error instanceof DataAccessError) || !error.code.startsWith('CREATIVE_')) throw error
      work = { kind: 'rejected', code: error.code, message: error.message }
    }
  }
  work = workSchema.parse(work)
  const prepared = await prepareToolCursorOperation(lease, cursor, { key: capability.operationKey, action: tool.name, callId: ctx.callId,
    effectDomain: 'read', targetId: ctx.novelId, effectiveArgs: args, normalize,
    operationInput: runtimeJson({ callId: ctx.callId, novelId: ctx.novelId, args, work }).value })
  const admitted = await readAdmittedToolOperation(lease, { operationId: prepared.operation.id, action: tool.name, novelId: ctx.novelId, callId: ctx.callId })
  const frozen = z.object({ work: workSchema }).parse(admitted.input).work
  let receipt = await withRunLease(lease, tx => tx.agentEffectReceipt.findUnique({ where: { operationId: prepared.operation.id } }))
  if (!receipt) {
    try {
      if (frozen.kind === 'rejected') throw new DataAccessError(409, frozen.code, frozen.message)
      const response = await callDurableAuxiliary({ lease, parentOperationId: prepared.operation.id, step, route: frozen.route, price: frozen.price,
        system: frozen.review.system, content: frozen.review.content, temperature: frozen.review.temperature, signal: ctx.signal,
        assertCurrent: async tx => { await assertCurrentToolPolicy(tx, lease, prepared.operation); await assertCreativeReviewCurrent({ ...ctx, transaction: tx }, frozen.review) } })
      if (response.finishReason !== 'stop' || response.toolCalls.length || !response.content.trim()) throw new DataAccessError(409, 'CREATIVE_RESULT_INCOMPLETE', '辅助模型没有返回完整创作产物，原结果及用量保留，未自动重新请求。')
      receipt = await commitOperationEffect(lease, prepared.operation.id, prepared.operation.inputHash, async tx => {
        ctx.signal.throwIfAborted()
        const result = await saveCreativeReview({ ...ctx, transaction: tx }, frozen.review, response.content)
        ctx.signal.throwIfAborted()
        return runtimeJson({ toolResult: result }).value
      })
    } catch (error) {
      if (!(error instanceof DataAccessError) || !error.code.startsWith('CREATIVE_')) throw error
      receipt = await recordToolFailure(lease, { operationId: prepared.operation.id, inputHash: prepared.operation.inputHash, code: error.code, output: error.message, summary: '创作辅助产物未完成' })
    }
  }
  if (runtimeJson(receipt.result).hash !== receipt.resultHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '创作辅助回执损坏。')
  await reduceExecutionReceipt(lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
  const failed = failedToolResultSchema.safeParse(receipt.result)
  if (failed.success) return { ...failed.data.toolResult, outcome: 'failed', failureCode: failed.data.code }
  return z.object({ toolResult: z.object({ output: z.string() }).passthrough() }).parse(receipt.result).toolResult as ToolResult
}
