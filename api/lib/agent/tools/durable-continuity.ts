import { z } from 'zod'
import { prisma, DataAccessError } from '../../prisma.js'
import { tokenPriceSchema } from '../../billing/token-price.js'
import { resolveDurableTokenPrice } from '../../billing/resolve-token-price.js'
import { runtimeError, runtimeJson } from '../runtime-common.js'
import { withRunLease, type RunLeaseToken } from '../runtime-lease.js'
import { readExecutionFrame } from '../runtime-state.js'
import { compilerObservationSchema, compilerStateHash } from '../runtime-compiler-observation.js'
import { prepareToolCursorOperation, rejectToolCursorCall } from '../runtime-tool-cursor.js'
import { readAdmittedReviewWork } from '../runtime-writing-service.js'
import { commitOperationEffect, recordToolFailure } from '../runtime-operations.js'
import { failedToolResultSchema, reduceExecutionReceipt } from '../runtime-reducer.js'
import { auxiliaryRouteSchema, auxiliaryRouteForRuntime, resolveDurableAuxiliaryRuntime, callDurableAuxiliary } from '../runtime-auxiliary-call.js'
import type { AuxiliaryModelStep } from '../runtime-auxiliary-model.js'
import { REVIEW_MAX_OUTPUT_TOKENS } from '../review-completion.js'
import { buildContinuitySnapshot, continuityReviewRequest, reviewContinuity, bindContinuityReport, readContinuityRequestBilling,
  type ContinuityDispatch, type ContinuityReport, type ContinuitySnapshot } from '../continuity-review.js'
import { normalizeToolInput } from './input-validation.js'
import type { AgentTool, ToolContext, ToolResult } from './types.js'

const argsSchema = z.object({ chapterId: z.string().optional(), compilationId: z.string().optional(), focus: z.string().optional() })
export const nativeContinuityWorkSchema = z.object({ kind: z.literal('continuityReview'),
  chapterId: z.string(), revision: z.number().int().positive(), contextHash: z.string(),
  critic: z.object({ system: z.string(), content: z.string() }).strict(), route: auxiliaryRouteSchema, price: tokenPriceSchema }).strict()
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const steps: Record<string, AuxiliaryModelStep> = { agent3ContinuityCritic: 'continuity_critic',
  agent3ContinuityFormatRecovery: 'continuity_format_recovery', agent3ContinuityEvidenceCorrection: 'continuity_evidence_correction', agent3ContinuityRevision: 'continuity_repair' }

/** Kept for historical response readers; it has no dispatch or authority. */
export function applyContinuityPatches(before: string, patches: Array<{ oldText: string; newText: string }>) {
  const ranges: Array<{ start: number; end: number; text: string }> = []
  for (const patch of patches) {
    const start = before.indexOf(patch.oldText), end = start + patch.oldText.length
    if (patch.oldText && start >= 0 && before.indexOf(patch.oldText, start + 1) < 0 && patch.oldText !== patch.newText
      && !ranges.some(range => start < range.end && end > range.start)) ranges.push({ start, end, text: patch.newText })
  }
  let after = before
  for (const range of ranges.sort((a, b) => b.start - a.start)) after = after.slice(0, range.start) + range.text + after.slice(range.end)
  return { after, applied: ranges.length }
}

/** Freeze the ordinary current review input. No terminal phase is reserved. */
export async function prepareContinuityWork(ctx: ToolContext, lease: RunLeaseToken, input: {
  operationKey: string; observedRevision: number; baseline: z.infer<typeof compilerObservationSchema> | null; args: Record<string, unknown>;
  frozenReview?: { route: z.infer<typeof auxiliaryRouteSchema>; price: z.infer<typeof tokenPriceSchema> }
}) {
  if (lease.userId !== ctx.userId || lease.runId !== ctx.runId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '连续性检查不属于当前执行。')
  const frozen = await withRunLease(lease, async tx => {
    const existing = await tx.agentOperation.findUnique({ where: { taskRootId_operationKey: { taskRootId: lease.taskRootId, operationKey: input.operationKey } } })
    if (existing) {
      if (runtimeJson(existing.inputSnapshot).hash !== existing.inputHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '原检查输入损坏。')
      return { saved: object(object(existing.inputSnapshot).input).work }
    }
    const args = argsSchema.parse(input.args), snapshot = await buildContinuitySnapshot(ctx, args, tx)
    return { snapshot, args }
  })
  if ('saved' in frozen) return frozen.saved
  const { snapshot, args } = frozen
  const resolved = input.frozenReview ? null : await resolveDurableAuxiliaryRuntime({ ...ctx, task: 'continuity' })
  const route = input.frozenReview?.route ?? auxiliaryRouteForRuntime(resolved!.runtime, resolved!.selection, REVIEW_MAX_OUTPUT_TOKENS)
  const price = input.frozenReview?.price ?? await resolveDurableTokenPrice(lease, `${input.operationKey}:critic-price`, resolved!.selection.tier, resolved!.runtime.multiplierBps)
  return nativeContinuityWorkSchema.parse({ kind: 'continuityReview', chapterId: snapshot.chapter.id, revision: snapshot.chapter.revision,
    contextHash: snapshot.contextHash, critic: continuityReviewRequest(snapshot, args.focus), route, price })
}

export async function executePreparedContinuityWork(ctx: ToolContext, lease: RunLeaseToken, operationId: string) {
  if (lease.userId !== ctx.userId || lease.runId !== ctx.runId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '连续性检查不属于当前执行。')
  const { operation, input } = await readAdmittedReviewWork(lease, { operationId, action: 'continuity_validate', novelId: ctx.novelId, callId: ctx.callId })
  const existing = await withRunLease(lease, tx => tx.agentEffectReceipt.findUnique({ where: { operationId } }))
  if (existing) return commitOperationEffect(lease, operationId, operation.inputHash, async () => runtimeError('RUNTIME_RECEIPT_INVALID', '已提交回执不能重执行。'))
  try {
  const args = argsSchema.parse(input.args), work = nativeContinuityWorkSchema.safeParse(input.work)
  if (!work.success) {
    // Old work remains history. A known physical failure can close its pending
    // tool, but no former phase may dispatch a model or grant a new revision.
    const chapterId = object(object(input.work).chapter).id
    const snapshot = await buildContinuitySnapshot(ctx, { ...args, ...(typeof chapterId === 'string' ? { chapterId } : {}) })
    const billing = await readContinuityRequestBilling(prisma, ctx, snapshot)
    if (!billing.known) return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '原检查的用量或费用尚未确认，未重新请求。')
    return recordToolFailure(lease, { operationId, inputHash: operation.inputHash, code: 'CONTINUITY_REPORT_INCOMPLETE',
      output: '原检查记录与费用已保留。当前正文可通过普通连续性检查取得新报告。', summary: '原连续性报告未完成' })
  }
  ctx = { ...ctx, continuityNativeLease: { ...lease }, inlineChild: !!lease.parent }
  const frozen = work.data
  const assertCurrent = async (tx = prisma as import('@prisma/client').Prisma.TransactionClient) => {
    ctx.signal.throwIfAborted()
    const current = await buildContinuitySnapshot(ctx, args, tx)
    if (current.contextHash !== frozen.contextHash || current.chapter.id !== frozen.chapterId || current.chapter.revision !== frozen.revision)
      throw new DataAccessError(409, 'CONTINUITY_INPUT_STALE', '正文或前文已变化，原报告未应用到新版本。')
    return current
  }
  const snapshot: ContinuitySnapshot = await assertCurrent()
  const dispatch: ContinuityDispatch = async request => {
    const step = steps[request.action]
    if (!step) return runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '未知连续性模型步骤。')
    if (request.action === 'agent3ContinuityRevision' && !await withRunLease(lease, async tx =>
      (await import('./chapter-mutation.js')).automaticChapterRevisionWritable(tx, ctx)))
      throw new DataAccessError(409, 'REPAIR_NOT_AUTHORIZED', '当前会话不允许改稿，正文未修改。')
    const response = await callDurableAuxiliary({ lease, parentOperationId: operation.id, step, route: frozen.route, price: frozen.price,
      system: request.system, content: request.content, temperature: 0.15, signal: ctx.signal, assertCurrent: async tx => { await assertCurrent(tx) } })
    const child = await withRunLease(lease, tx => tx.agentOperation.findUniqueOrThrow({ where: { taskRootId_operationKey: {
      taskRootId: lease.taskRootId, operationKey: `aux:${operation.id}:${step}` } }, include: { attempts: { include: { usageReceipt: true } } } }))
    const billing = await readContinuityRequestBilling(prisma, ctx, snapshot)
    return { content: response.content, usageIds: [], nativeReceiptIds: child.attempts.flatMap(attempt => attempt.usageReceipt ? [attempt.usageReceipt.attemptId] : []),
      billingKnown: billing.known && response.billing?.status === 'settled', providerComplete: response.finishReason === 'stop' && !response.toolCalls.length }
  }
  const envelope = async (tx: import('@prisma/client').Prisma.TransactionClient, toolResult: ToolResult) => {
    const compilation = snapshot.compilation
    const hash = compilation ? await compilerStateHash(tx, ctx.userId, ctx.novelId, lease.taskRootId, compilation.id) : null
    const display = toolResult.display
    const progress = display?.kind === 'chapterDiff' && display.before !== display.after ? { kind: 'content_revision', targetId: display.chapterId,
      beforeHash: runtimeJson({ content: display.before }).hash, afterHash: runtimeJson({ content: display.after }).hash } : undefined
    const job = progress && display?.kind === 'chapterDiff' ? await tx.memoryExtractionJob.findUnique({ where: { idempotencyKey: `${display.chapterId}:${display.revision}` }, select: { id: true } }) : null
    return runtimeJson({ compilerState: compilation && hash ? { id: compilation.id, hash } : null, toolResult, memoryJobId: job?.id ?? null, ...(progress ? { progress } : {}) }).value
  }
  let applied: Awaited<ReturnType<typeof commitOperationEffect>> | undefined
  const result = await reviewContinuity(ctx, args, { snapshot, dispatch, resumeKnownRequest: operation.id,
    applyRepair: async (report, apply) => {
      let result: ToolResult | undefined
      applied = await commitOperationEffect(lease, operation.id, operation.inputHash, async tx => {
        await assertCurrent(tx)
        await bindContinuityReport(tx, snapshot, report)
        result = await apply(tx)
        return envelope(tx, result)
      })
      return result ?? z.object({ toolResult: z.custom<ToolResult>() }).parse(applied.result).toolResult
    } })
  if (applied) return applied
  return await commitOperationEffect(lease, operation.id, operation.inputHash, async tx => {
    await assertCurrent(tx)
    const id = runtimeJson({ kind: 'continuity-report', taskId: snapshot.original.taskId, chapterId: snapshot.chapter.id, contextHash: snapshot.contextHash }).hash
    const artifact = await tx.agentArtifact.findUniqueOrThrow({ where: { id } })
    const report = object(artifact.metadata).continuityReport as ContinuityReport
    await bindContinuityReport(tx, snapshot, report)
    return envelope(tx, result)
  })
  } catch (error) {
    const business = new Set(['CONTINUITY_INPUT_STALE', 'CHAPTER_REVISION_CONFLICT', 'COMPILATION_NOT_FOUND', 'CHAPTER_NOT_FOUND',
      'AUTHOR_CHAPTER_SCOPE', 'AUTHOR_LOCAL_SCOPE', 'AUTHOR_LOCAL_STALE', 'AUTHOR_SELECTION_SCOPE', 'AUTHOR_SELECTION_STALE',
      'REPAIR_NOT_AUTHORIZED', 'CONTINUITY_REPAIR_FAILED', 'CREDITS_EXHAUSTED', 'CREDITS_RESERVED', 'CREDITS_PROVIDER_UNSTABLE'])
    if (ctx.signal.aborted || !(error instanceof DataAccessError) || error.code === 'AI_PROVIDER_BILLING_UNCONFIRMED'
      || !business.has(error.code) && !error.code.startsWith('AI_PROVIDER_')) throw error
    const frozen = object(input.work), id = frozen.chapterId ?? object(frozen.chapter).id
    if (typeof id !== 'string') throw error
    const requests = await import('../original-request.js'), original = await requests.readOriginalTaskRequest(prisma, ctx)
    const runIds = await requests.originalTaskRunIds(prisma, ctx, original)
    if (!(await readContinuityRequestBilling(prisma, ctx, { runIds, chapter: { id } })).known)
      return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '原检查的用量或费用尚未确认，未关闭或重复请求。')
    return recordToolFailure(lease, { operationId, inputHash: operation.inputHash, code: error.code,
      output: `${error.message}原报告、响应与费用已保留，正文未应用。`, summary: '本次连续性检查未完成' })
  }
}

/** Only this real shell reduces the model cursor; the shared runner never does. */
export async function executeDurableContinuity(ctx: ToolContext, tool: Pick<AgentTool, 'name' | 'parameters'>, raw: unknown): Promise<ToolResult> {
  const capability = ctx.durableCompiler
  if (!capability || tool.name !== 'continuity_validate' || capability.lease.userId !== ctx.userId || capability.lease.runId !== ctx.runId)
    return runtimeError('RUNTIME_SCOPE_MISMATCH', '连续性工具缺少原任务执行能力。')
  const lease = { ...capability.lease }, cursor = { ...capability.cursor }, baseline = capability.baseline && { ...capability.baseline }
  const prior = await withRunLease(lease, tx => tx.agentOperation.findUnique({ where: { taskRootId_operationKey: {
    taskRootId: lease.taskRootId, operationKey: capability.operationKey } } }))
  if (prior && object(object(prior.inputSnapshot).input).work && object(object(object(prior.inputSnapshot).input).work).kind !== 'continuityReview') {
    const receipt = await executePreparedContinuityWork(ctx, lease, prior.id)
    const source = z.object({ input: z.object({ normalization: z.object({ sourceRevision: z.number().int() }) }) }).parse(prior.inputSnapshot)
    const pending = await withRunLease(lease, tx => readExecutionFrame(tx, lease.taskRootId, source.input.normalization.sourceRevision + 1))
    await reduceExecutionReceipt(lease, { expectedRevision: pending.revision, expectedHash: pending.snapshotHash, operationId: prior.id })
    const failed = failedToolResultSchema.safeParse(receipt.result)
    return failed.success ? { ...failed.data.toolResult, outcome: 'failed', failureCode: failed.data.code }
      : z.object({ toolResult: z.custom<ToolResult>() }).parse(receipt.result).toolResult
  }
  const normalize = (value: unknown) => Object.fromEntries(Object.entries(tool.parameters.parse(normalizeToolInput(tool, value)) as Record<string, unknown>).filter(([, item]) => item !== undefined))
  const args = normalize(raw), work = await prepareContinuityWork(ctx, lease, { operationKey: capability.operationKey, observedRevision: cursor.expectedRevision, baseline, args })
  const prepared = await prepareToolCursorOperation(lease, cursor, { key: capability.operationKey, action: tool.name, callId: ctx.callId, effectDomain: 'compiler',
    targetId: lease.taskRootId, effectiveArgs: args, normalize, operationInput: runtimeJson({ callId: ctx.callId, novelId: ctx.novelId, args, baseline, work }).value }).catch(async error => {
    if (!(error instanceof DataAccessError) || !['RUNTIME_APPROVAL_DENIED', 'RUNTIME_APPROVAL_EXPIRED'].includes(error.code)) throw error
    const rejected = await rejectToolCursorCall(lease, cursor, ctx.callId)
    await reduceExecutionReceipt(lease, { expectedRevision: rejected.pending.revision, expectedHash: rejected.pending.snapshotHash, operationId: rejected.operation.id })
    return { rejected: { ...failedToolResultSchema.parse(rejected.receipt.result).toolResult, outcome: 'failed' as const } }
  })
  if ('rejected' in prepared) return prepared.rejected
  const receipt = await executePreparedContinuityWork(ctx, lease, prepared.operation.id)
  const failed = failedToolResultSchema.safeParse(receipt.result)
  const result = failed.success ? { ...failed.data.toolResult, failureCode: failed.data.code, outcome: 'failed' as const }
    : z.object({ toolResult: z.custom<ToolResult>() }).parse(receipt.result).toolResult
  await reduceExecutionReceipt(lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
  return result
}
