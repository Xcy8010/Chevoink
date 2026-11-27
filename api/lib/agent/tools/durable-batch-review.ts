import { z } from 'zod'
import { env } from '../../../config/env.js'
import { resolveDurableTokenPrice } from '../../billing/resolve-token-price.js'
import { tokenPriceSchema } from '../../billing/token-price.js'
import { DataAccessError, prisma } from '../../prisma.js'
import { activeChapterScope } from '../../data/internal.js'
import { generateTextCompletion } from '../../ai-service.js'
import { createTextRequestTrace, textRequestsFinished, withTextRequestTrace } from '../../text-request-trace.js'
import { estimateChatMessagesTokens, resolveDurableInputLimit, resolveSessionContextWindow } from '../context-budget.js'
import { REVIEW_MAX_OUTPUT_TOKENS } from '../review-completion.js'
import { auxiliaryRouteForRuntime, auxiliaryRouteSchema, callDurableAuxiliary, resolveDurableAuxiliaryRuntime } from '../runtime-auxiliary-call.js'
import { runtimeError, runtimeJson, runtimeTransaction, type RuntimeTx } from '../runtime-common.js'
import { withRunLease, withManuscriptRunLease, type RunLeaseToken } from '../runtime-lease.js'
import { assertCurrentToolPolicy, commitOperationEffect, recordToolFailure } from '../runtime-operations.js'
import { prepareToolCursorOperation, readAdmittedToolOperation } from '../runtime-tool-cursor.js'
import { reduceExecutionReceipt, failedToolResultSchema } from '../runtime-reducer.js'
import { isKnownRejectedTextRequestAttempt, isKnownTextRequestBilling } from '../text-request-billing.js'
import { originalTaskRunIds, readOriginalTaskRequest } from '../original-request.js'
import { batchReviewArgsSchema, batchReviewWorkSchema, checkBatchReviewGrant, prepareBatchReview, projectBatchReview, saveBatchReview, saveBatchReviewObservation,
  type BatchReviewArgs } from './batch-review.js'
import { defineTool, type ToolContext, type ToolResult } from './types.js'

export const batchReviewAdmissionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rejected'), code: z.string(), message: z.string() }).strict(),
  z.object({ kind: z.literal('review'), review: batchReviewWorkSchema,
    route: auxiliaryRouteSchema.nullable(), price: tokenPriceSchema.nullable() }).strict(),
])
const storedAdmissionSchema = z.object({ work: batchReviewAdmissionSchema })
const action = 'chapter_review_batch'
const step = 'chapter_review_batch' as const

export async function assertBatchReviewSources(tx: RuntimeTx, lease: RunLeaseToken, raw: unknown) {
  const { novelId, work } = storedAdmissionSchema.extend({ novelId: z.string() }).parse(raw)
  if (work.kind !== 'review' || !work.route || !work.price) return runtimeError('RUNTIME_RECEIPT_INVALID', '批量复查缺少原请求。')
  const sourceIds = [...new Set(work.review.targets.filter(target => target.cached === null).flatMap(target => target.sourceIds))]
  const current = new Map((await tx.chapter.findMany({ where: { id: { in: sourceIds }, ...activeChapterScope(novelId),
    authorId: lease.userId }, select: { id: true, title: true, revision: true, orderIndex: true, content: true } })).map(row => [row.id, row]))
  const previous = new Map(work.review.sources.map(source => [source.chapterId, source]))
  for (const id of sourceIds) {
    const row = current.get(id), source = previous.get(id)
    if (!row || !source || row.revision !== source.revision || row.orderIndex !== source.orderIndex || row.title !== source.title
      || row.content.slice(source.sourceStart ?? 0) !== source.content) {
      throw new DataAccessError(409, 'BATCH_REVIEW_SOURCE_CHANGED', '同组正文或来源已变化，本次检查尚未发送。')
    }
  }
}

export const chapterReviewBatchTool = defineTool({
  name: action, title: '批量章节复查',
  description: '对同一作品至少两个已保存章节集中审阅，一次检查共享上下文并逐章返回原文证据。reviewType 分别为 continuity（连续性）、quality（人类感）、custom（使用 skillIds 指定审阅技能）。默认用于连写多章的首轮检查，只读正文。章节过长时按工具提示拆成相邻小批，余下单章用对应单章检查工具；修订后按需回读改动处和相关前文。若作者明确要求独立终稿检查或提交必须通过对应正式检查，使用原来的单章检查入口取得正式回执。',
  parameters: batchReviewArgsSchema,
  permission: { plan: 'deny', build: 'allow', review: 'allow' },
  readOnly: true,
  async execute(ctx, args) { return ctx.durableCreative ? executeDurableBatchReview(ctx, args) : executeLegacyBatchReview(ctx, args) },
})

function resolveBatchOutputLimit(review: { system: string; content: string }, runtime: NonNullable<ToolContext['modelRuntime']>) {
  const window = resolveSessionContextWindow(env.agentContextWindowTokens, runtime.contextWindowTokens)
  const maxOutput = Math.min(REVIEW_MAX_OUTPUT_TOKENS, runtime.maxOutputTokens ?? REVIEW_MAX_OUTPUT_TOKENS, Math.floor(window / 4))
  const limit = resolveDurableInputLimit(window, maxOutput)
  if (estimateChatMessagesTokens([{ role: 'system', content: review.system }, { role: 'user', content: review.content }]) > limit) {
    throw new DataAccessError(413, 'BATCH_REVIEW_CONTEXT', '这组完整正文超过当前模型的检查窗口。按相邻章节拆成更小组继续，剩余单章用单章工具。')
  }
  return maxOutput
}

const batchObservationSchema = z.object({
  version: z.literal(1), usageId: z.string(), complete: z.boolean(), rawHash: z.string(),
  unavailableReason: z.string().optional(),
}).strict()

function observedBatchFailure(code: string) {
  if (code === 'AI_PROVIDER_TIMEOUT') return '检查已超时，未取得完整报告。'
  if (code === 'AI_PROVIDER_QUOTA_EXCEEDED') return '模型供应方额度不足，未取得报告。'
  if (code === 'AI_PROVIDER_OUTPUT_LIMIT') return '模型输出达到上限，未取得完整报告。'
  if (code === 'AI_PROVIDER_EMPTY_RESPONSE') return '模型返回了空报告。'
  return '模型未返回检查报告。'
}

const settledResponseUnavailable = '原复查请求已结算，本地没有可恢复的报告。'
const legacyBatchBillingSelect = {
  targetId: true, usageSource: true, billingStatus: true, requestTokens: true, responseTokens: true,
  reservedCreditMilli: true, creditChargeMilli: true, billingEvidence: true,
} as const
const hasSettledBatchResult = (usage: Parameters<typeof isKnownRejectedTextRequestAttempt>[0]) =>
  usage.usageSource === 'reported' && isKnownTextRequestBilling(usage) && !isKnownRejectedTextRequestAttempt(usage)

async function executeLegacyBatchReview(ctx: ToolContext, args: BatchReviewArgs): Promise<ToolResult> {
  const transaction = <T>(work: (tx: RuntimeTx) => Promise<T>) => prisma.$transaction(work, { timeout: 20_000 })
  checkBatchReviewGrant(ctx.toolAuthority, args.reviewType)
  const frozen = await transaction(async tx => {
    await ctx.assertCurrentExecution?.(tx)
    return prepareBatchReview(ctx, args, tx)
  })
  let raw = '', complete = false, paidResult = false, unavailableReason: string | undefined
  if (frozen.content) {
    const task = await readOriginalTaskRequest(prisma, ctx)
    const originalTargetId = runtimeJson({ task: task.taskId, reviewType: args.reviewType }).hash
    const requestHash = runtimeJson({ originalTargetId, system: frozen.system, content: frozen.content,
      targets: frozen.targets.map(target => target.contextHash), unavailable: frozen.unavailable }).hash
    const runIds = await originalTaskRunIds(prisma, ctx, task)
    const usageScope = { userId: ctx.userId, novelId: ctx.novelId, action, targetType: 'chapter_review_batch' }
    const observation = await prisma.agentArtifact.findFirst({ where: {
      runId: { in: runIds }, artifactType: 'continuityReview', run: { userId: ctx.userId, novelId: ctx.novelId },
      metadata: { path: ['batchResponseRequestHash'], equals: requestHash },
    }, select: { runId: true, content: true, metadata: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
    if (observation) {
      const saved = z.object({ batchResponse: batchObservationSchema }).safeParse(observation.metadata)
      if (!saved.success) throw new DataAccessError(409, 'BATCH_REVIEW_RECEIPT_INVALID', '原复查结果无法恢复。')
      const data = saved.data.batchResponse
      raw = z.string().parse(JSON.parse(observation.content))
      if (runtimeJson({ raw }).hash !== data.rawHash) throw new DataAccessError(409, 'BATCH_REVIEW_RECEIPT_INVALID', '原复查结果无法恢复。')
      const usage = await prisma.aiUsageLog.findFirst({ where: { ...usageScope, id: data.usageId, agentRunId: observation.runId, targetId: requestHash },
        select: legacyBatchBillingSelect })
      if (!usage || !isKnownTextRequestBilling(usage)) {
        throw new DataAccessError(409, 'AI_PROVIDER_BILLING_UNCONFIRMED', '这组章节的原复查请求尚待核对。')
      }
      complete = data.complete
      paidResult = true
      unavailableReason = data.unavailableReason
    } else if ((await prisma.aiUsageLog.findMany({ where: { ...usageScope, targetId: requestHash, agentRunId: { in: runIds } },
      select: legacyBatchBillingSelect })).some(hasSettledBatchResult)) {
      unavailableReason = settledResponseUnavailable
    } else {
      const { runtime, selection } = await resolveDurableAuxiliaryRuntime(ctx)
      const maxOutputTokens = resolveBatchOutputLimit(frozen, runtime)
      const trace = createTextRequestTrace()
      try {
        raw = await withTextRequestTrace(trace, () => generateTextCompletion(frozen.system, frozen.content, {
          ...usageScope, agentRunId: ctx.runId, targetId: requestHash,
          signal: ctx.signal, modelRuntime: runtime, explicitModelSelection: true, operationPrice: selection.tokenPrice,
          maxOutputTokens, temperature: 0.15, boundedReview: true, singlePhysicalRequest: true, responseFormat: 'json_object',
          onObservedCompletion: value => {
            raw = value.content
            complete = value.transportComplete !== false && value.finishReason === 'stop' && !value.toolCalls.length
          },
          beforeProviderDispatch: usageId => transaction(async tx => {
            await ctx.assertCurrentExecution?.(tx)
            const current = await prepareBatchReview(ctx, args, tx)
            if (current.content !== frozen.content || current.system !== frozen.system) {
              throw new DataAccessError(409, 'BATCH_REVIEW_SOURCE_CHANGED', '同组正文或来源已变化，本次检查尚未发送。')
            }
            const attempts = await tx.aiUsageLog.findMany({ where: { ...usageScope, id: { not: usageId },
              targetId: { in: [originalTargetId, requestHash] } }, select: legacyBatchBillingSelect })
            if (attempts.some(attempt => attempt.targetId === requestHash && hasSettledBatchResult(attempt))) {
              throw new DataAccessError(409, 'BATCH_REVIEW_RESPONSE_UNAVAILABLE', settledResponseUnavailable)
            }
            if (attempts.some(attempt => !isKnownTextRequestBilling(attempt))) {
              throw new DataAccessError(409, 'AI_PROVIDER_BILLING_UNCONFIRMED', '这组章节的原复查请求尚待核对。')
            }
          }),
        }))
        if (!textRequestsFinished(trace)) throw new DataAccessError(409, 'AI_PROVIDER_BILLING_UNCONFIRMED', '批量审阅原请求用量尚待核对。')
        if (!complete) unavailableReason = '模型输出不完整。'
      } catch (error) {
        ctx.signal.throwIfAborted()
        if (!(error instanceof DataAccessError)) throw error
        if (error.code === 'BATCH_REVIEW_SOURCE_CHANGED' || error.code === 'BATCH_REVIEW_RESPONSE_UNAVAILABLE') unavailableReason = error.message
        else if (textRequestsFinished(trace) && ['AI_PROVIDER_ERROR', 'AI_PROVIDER_QUOTA_EXCEEDED', 'AI_PROVIDER_TIMEOUT',
          'AI_PROVIDER_OUTPUT_LIMIT', 'AI_PROVIDER_EMPTY_RESPONSE'].includes(error.code)) {
          unavailableReason = observedBatchFailure(error.code)
          paidResult = error.code === 'AI_PROVIDER_EMPTY_RESPONSE'
        }
        else throw error
        complete = false
      }
      // Keep the paid response before local parsing or reporting. Continuing
      // the same input can then finish the projection without a model request.
      const received = trace.records.find(record => record.status === 'terminal' && record.billingKnown)
      if (received && (raw || paidResult)) {
        await saveBatchReviewObservation(ctx.runId, raw, {
          version: 1, batchResponseRequestHash: requestHash, batchResponse: { version: 1, usageId: received.usageId,
            complete, rawHash: runtimeJson({ raw }).hash, ...(unavailableReason ? { unavailableReason } : {}) },
        })
        paidResult = true
      }
    }
  }
  const project = async (tx: RuntimeTx) => {
    ctx.signal.throwIfAborted()
    await ctx.assertCurrentExecution?.(tx)
    const current = await prepareBatchReview(ctx, args, tx, false)
    return saveBatchReview(ctx, tx, frozen, projectBatchReview(frozen, raw, current, complete, unavailableReason, ctx), paidResult)
  }
  if (!paidResult) return transaction(project)
  try {
    return await runtimeTransaction(project, { timeoutMs: 20_000, signal: ctx.signal })
  } catch (error) {
    ctx.signal.throwIfAborted()
    if (error instanceof DataAccessError) throw error
    console.warn('[agent-batch-review-projection]', { runId: ctx.runId, callId: ctx.callId, errorType: error instanceof Error ? error.name : 'unknown' })
    return { outcome: 'failed', failureCode: 'BATCH_REVIEW_PROJECTION_PENDING', summary: '批量复查报告整理未确认',
      output: '这批复查的用量已确认，原回包已在本地保留。若交付仍需要报告，且正文和检查依据保持原版本，可用 chapter_review_batch 按原章节、检查类型、技能和重点读取原回包继续整理，无须再次调用供应商。保留正文及其他已有结果，不因本地整理问题逐章重发检查。' }
  }
}

async function executeDurableBatchReview(ctx: ToolContext, args: BatchReviewArgs): Promise<ToolResult> {
  const capability = ctx.durableCreative
  if (!capability) return { outcome: 'failed', failureCode: 'BATCH_REVIEW_UNAVAILABLE', summary: '批量审阅不可用',
    output: '当前执行器可使用原单章检查工具。' }
  const { lease, cursor, operationKey } = capability
  const old = await withRunLease(lease, async tx => {
    const operation = await tx.agentOperation.findUnique({ where: { taskRootId_operationKey: { taskRootId: lease.taskRootId, operationKey } } })
    if (!operation) return null
    if (runtimeJson(operation.inputSnapshot).hash !== operation.inputHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '批量审阅原输入损坏。')
    return z.object({ input: storedAdmissionSchema }).parse(operation.inputSnapshot).input.work
  })
  let work = old
  if (!work) {
    try {
      checkBatchReviewGrant(ctx.toolAuthority, args.reviewType)
      const review = await withManuscriptRunLease(lease, tx => prepareBatchReview(ctx, args, tx), { timeoutMs: 20_000 })
      work = { kind: 'review', review, route: null, price: null }
      if (review.content) {
        const resolved = await resolveDurableAuxiliaryRuntime({ userId: ctx.userId, runId: ctx.runId, modelRuntime: ctx.modelRuntime, modelSelection: ctx.modelSelection })
        const maxOutput = resolveBatchOutputLimit(review, resolved.runtime)
        work = { ...work, route: auxiliaryRouteForRuntime(resolved.runtime, resolved.selection, maxOutput),
          price: await resolveDurableTokenPrice(lease, `${operationKey}:batch-review-price`, resolved.selection.tier,
            resolved.runtime.multiplierBps, resolved.selection.tokenPrice) }
      }
    } catch (error) {
      if (!(error instanceof DataAccessError) || !error.code.startsWith('BATCH_REVIEW_')) throw error
      work = { kind: 'rejected', code: error.code, message: error.message }
    }
  }
  const prepared = await prepareToolCursorOperation(lease, cursor, { key: operationKey, action, callId: ctx.callId,
    effectDomain: 'read', targetId: ctx.novelId, effectiveArgs: args, normalize: raw => batchReviewArgsSchema.parse(raw),
    operationInput: runtimeJson({ callId: ctx.callId, novelId: ctx.novelId, args, work }).value })
  const admitted = await readAdmittedToolOperation(lease, { operationId: prepared.operation.id, action, novelId: ctx.novelId, callId: ctx.callId })
  const frozen = storedAdmissionSchema.parse(admitted.input).work
  let receipt = await withRunLease(lease, tx => tx.agentEffectReceipt.findUnique({ where: { operationId: prepared.operation.id } }))
  if (!receipt) {
    try {
      if (frozen.kind === 'rejected') throw new DataAccessError(409, frozen.code, frozen.message)
      let raw = '', complete = false, paidResult = false, unavailableReason: string | undefined
      if (frozen.review.content) {
        if (!frozen.route || !frozen.price) return runtimeError('RUNTIME_RECEIPT_INVALID', '批量审阅原模型或价格记录缺失。')
        const readAttempt = () => withRunLease(lease, async tx => {
          const provider = await tx.agentOperation.findUnique({ where: { taskRootId_operationKey: {
            taskRootId: lease.taskRootId, operationKey: `aux:${prepared.operation.id}:${step}` } } })
          return provider && await tx.agentProviderAttempt.findUnique({ where: { operationId_attemptKey: {
            operationId: provider.id, attemptKey: '1' } }, include: { usageReceipt: true } })
        })
        const response = await callDurableAuxiliary({ lease, parentOperationId: prepared.operation.id, step, route: frozen.route,
          price: frozen.price, system: frozen.review.system, content: frozen.review.content, temperature: 0.15, signal: ctx.signal,
          assertCurrent: tx => assertCurrentToolPolicy(tx, lease, prepared.operation) }).catch(async error => {
          ctx.signal.throwIfAborted()
          if (!(error instanceof DataAccessError)) throw error
          if (error.code === 'BATCH_REVIEW_SOURCE_CHANGED') {
            unavailableReason = '同组正文或来源已变化，本次检查尚未发送。'
            return null
          }
          if (!['AI_PROVIDER_ERROR', 'AI_PROVIDER_QUOTA_EXCEEDED', 'AI_PROVIDER_TIMEOUT'].includes(error.code)) throw error
          const attempt = await readAttempt()
          if (attempt?.status !== 'failed' || !attempt.resultHash || runtimeJson(attempt.result).hash !== attempt.resultHash) throw error
          const failed = z.object({ outcome: z.literal('failed'), result: z.object({ httpStatus: z.number().int(), code: z.string().optional() }) })
            .safeParse(attempt.result)
          const usage = attempt.usageReceipt
          const noCharge = !usage && failed.success && !failed.data.result.code
            && [400, 401, 403, 404, 422, 429].includes(failed.data.result.httpStatus)
          if (!noCharge && (usage?.source !== 'reported' || usage.settlementStatus !== 'settled'
            || usage.promptTokens === null || usage.completionTokens === null)) {
            return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '批量审阅原请求用量尚待核对。')
          }
          unavailableReason = observedBatchFailure(error.code)
          return null
        })
        if (response) {
          const usage = (await readAttempt())?.usageReceipt
          if (usage?.source !== 'reported' || usage.settlementStatus !== 'settled') {
            return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '批量审阅原请求用量尚待核对。')
          }
          raw = response.content
          paidResult = true
          complete = Boolean(raw.trim()) && response.finishReason === 'stop' && !response.toolCalls.length
          if (!complete) unavailableReason = raw.trim() ? '模型输出不完整。' : observedBatchFailure('AI_PROVIDER_EMPTY_RESPONSE')
        }
      }
      receipt = await commitOperationEffect(lease, prepared.operation.id, prepared.operation.inputHash, async tx => {
        const current = await prepareBatchReview(ctx, args, tx, false)
        const display = projectBatchReview(frozen.review, raw, current, complete, unavailableReason, ctx)
        return runtimeJson({ toolResult: await saveBatchReview(ctx, tx, frozen.review, display, paidResult) }).value
      })
    } catch (error) {
      if (!(error instanceof DataAccessError) || !error.code.startsWith('BATCH_REVIEW_')) throw error
      receipt = await recordToolFailure(lease, { operationId: prepared.operation.id, inputHash: prepared.operation.inputHash,
        code: error.code, output: error.message, summary: '批量审阅未完成' })
    }
  }
  if (runtimeJson(receipt.result).hash !== receipt.resultHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '批量审阅回执损坏。')
  await reduceExecutionReceipt(lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
  const failed = failedToolResultSchema.safeParse(receipt.result)
  if (failed.success) return { ...failed.data.toolResult, outcome: 'failed', failureCode: failed.data.code }
  return z.object({ toolResult: z.object({ output: z.string() }).passthrough() }).parse(receipt.result).toolResult as ToolResult
}
