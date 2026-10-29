import { z } from 'zod'
import { DataAccessError } from '../../prisma.js'
import { runtimeError, runtimeJson } from '../runtime-common.js'
import { withRunLease, type RunLeaseToken } from '../runtime-lease.js'
import { compilerStateHash, compilerObservationSchema } from '../runtime-compiler-observation.js'
import { prepareToolCursorOperation, rejectToolCursorCall } from '../runtime-tool-cursor.js'
import { readAdmittedReviewWork } from '../runtime-writing-service.js'
import { commitOperationEffect, recordToolFailure } from '../runtime-operations.js'
import { failedToolResultSchema, readFailedToolResult, reduceExecutionReceipt } from '../runtime-reducer.js'
import { normalizeToolInput } from './input-validation.js'
import type { AgentTool, ToolContext, ToolResult } from './types.js'

const actions = new Set(['story_compiler_prepare', 'scene_task_build', 'chapter_bridge_get', 'chapter_bridge_commit'])
const failures = new Set(['TOOL_COMPILER_REQUIRED', 'TOOL_COMPILER_STALE', 'COMPILATION_NOT_FOUND', 'COMPILATION_STAGE_CONFLICT',
  'TERMINAL_STATE_REVIEW_REQUIRED',
  'AUTHOR_LOCAL_SCOPE', 'AUTHOR_LOCAL_STALE', 'AUTHOR_SELECTION_SCOPE', 'AUTHOR_SELECTION_STALE',
  'COMPILATION_IDENTITY_MISMATCH', 'COMPILATION_NOT_WRITTEN', 'INVALID_ARGUMENTS',
  'SCENE_TASK_COUNT_INVALID', 'NOVEL_NOT_FOUND', 'CHAPTER_NOT_FOUND', 'TARGET_CHAPTER_GAP', 'AUTHOR_CHAPTER_SCOPE', 'SCOPE_NEEDS_INPUT',
  'RUNTIME_SCOPE_MISMATCH', 'RUNTIME_PARENT_LEASE_LOST', 'CONTINUITY_INPUT_STALE', 'CONTINUITY_CHECK_REQUIRED', 'CONTINUITY_REPORT_INCOMPLETE', 'CONTINUITY_ERRORS_REMAIN', 'QUALITY_CHECK_REQUIRED', 'REVIEW_DECISION_REQUIRED'])

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

function registeredCommitReviews(ctx: ToolContext, lease: RunLeaseToken, parent: Awaited<ReturnType<typeof readAdmittedReviewWork>>): NonNullable<ToolContext['registeredReview']> {
  return async (name, args, options) => {
    const services = await import('../runtime-writing-service.js')
    const state = await withRunLease(lease, async tx => {
      const hash = await compilerStateHash(tx, ctx.userId, ctx.novelId, lease.taskRootId, args.compilationId)
      if (!hash) return runtimeError('COMPILATION_NOT_FOUND', '没有当前任务可检查的章节。')
      const chapterId = (await tx.storyCompilation.findUniqueOrThrow({ where: { id: args.compilationId }, select: { chapterId: true } })).chapterId!
      const requestSource = await import('../original-request.js'), original = await requestSource.readOriginalTaskRequest(tx, ctx)
      const runIds = await requestSource.originalTaskRunIds(tx, ctx, original)
      // Reconcile before a real review dispatch, including when the body became
      // stale after the commit's first readiness read. Local delivery needs no call.
      if (!(await (await import('../continuity-review.js')).readContinuityRequestBilling(tx, ctx, { runIds, chapter: { id: chapterId } }, null)).known)
        return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '原请求用量或费用尚未确认，未追加检查。')
      const children = await tx.agentOperation.findMany({ where: { taskRootId: lease.taskRootId, parentOperationId: parent.operation.id, kind: 'internal' },
        include: { effectReceipt: true }, orderBy: { createdAt: 'asc' } })
      for (const child of children) if (runtimeJson(child.inputSnapshot).hash !== child.inputHash
        || child.effectReceipt && runtimeJson(child.effectReceipt.result).hash !== child.effectReceipt.resultHash)
        return runtimeError('RUNTIME_RECEIPT_INVALID', '原检查操作或回执损坏，未追加请求。')
      const same = children.filter(child => child.action === name)
      const repaired = same.some(child => { const progress = object(object(child.effectReceipt?.result).progress)
        return child.status === 'succeeded' && progress.kind === 'content_revision' && progress.beforeHash !== progress.afterHash })
      const readOnly = options?.readOnly || repaired
      const step = name === 'quality_analyze' ? readOnly ? 'quality_verify' as const : 'quality' as const
        : readOnly ? 'continuity_verify' as const : 'continuity' as const
      const contextHash = name === 'continuity_validate' ? (await (await import('../continuity-review.js')).buildContinuitySnapshot(ctx, args, tx)).contextHash
        : runtimeJson(JSON.parse(JSON.stringify(await (await import('../humanity-quality.js')).buildHumanityQualityContext(ctx.userId, ctx.novelId,
          chapterId, ctx.runId, tx)))).hash
      const key = services.writingServiceOperationKey(parent.operation.id, step, contextHash)
      const existing = children.find(child => child.operationKey === key)
      const source = [...children].reverse().find(child => child.status === 'succeeded' && child.effectReceipt && object(object(child.effectReceipt.result).toolResult).outcome !== 'failed')
      const role = same.map(child => object(object(child.inputSnapshot).input).work).map(object).find(work => work.route && work.price)
      return { baseline: { id: args.compilationId, hash }, readOnly, step, key, contextHash, existing,
        source: source?.effectReceipt ? { operationId: source.id, resultHash: source.effectReceipt.resultHash } : null,
        frozenReview: role ? { route: (await import('../runtime-auxiliary-call.js')).auxiliaryRouteSchema.parse(role.route),
          price: (await import('../../billing/token-price.js')).tokenPriceSchema.parse(role.price) } : undefined }
    })
    let admitted: Awaited<ReturnType<typeof services.prepareWritingServiceStep>>
    if (state.existing) {
      const saved = z.object({ input: z.record(z.string(), z.unknown()) }).parse(state.existing.inputSnapshot).input
      admitted = await services.prepareWritingServiceStep(lease, saved)
    } else {
      const reviewContext = state.readOnly ? { ...ctx, sandboxMode: 'read_only' as const } : ctx
      const work = name === 'continuity_validate'
        ? await (await import('./durable-continuity.js')).prepareContinuityWork(reviewContext, lease, { operationKey: state.key,
          observedRevision: parent.input.normalization.sourceRevision, baseline: state.baseline, args, ...(state.frozenReview ? { frozenReview: state.frozenReview } : {}) })
        : await (await import('./durable-quality.js')).prepareQualityWork(reviewContext, lease, { operationKey: state.key,
          observedRevision: parent.input.normalization.sourceRevision, baseline: state.baseline, args, ...(state.readOnly ? { serviceReadOnly: true } : {}),
          ...(state.frozenReview ? { frozenReview: state.frozenReview } : {}) })
      const frozen = object(work)
      if (frozen.kind === 'rejected') return { outcome: 'failed', failureCode: String(frozen.code), summary: '检查未完成', output: String(frozen.message) }
      if (frozen.contextHash !== state.contextHash) return runtimeError('CONTINUITY_INPUT_STALE', '正文或检查来源已变化，未发送旧请求。')
      const manifest = await withRunLease(lease, tx => services.requiredCommitReviewManifest(tx, ctx, args.compilationId))
      admitted = await services.prepareWritingServiceStep(lease, { novelId: ctx.novelId, callId: ctx.callId, args, baseline: state.baseline, work,
        serviceAdmission: { version: 1, parentOperationId: parent.operation.id, parentInputHash: parent.operation.inputHash,
          sourceRevision: parent.input.normalization.sourceRevision, sourceSnapshotHash: parent.input.normalization.sourceSnapshotHash,
          step: state.step, chapterId: manifest.chapterId, source: state.source } })
    }
    const reviewContext = state.readOnly ? { ...ctx, sandboxMode: 'read_only' as const } : ctx
    const receipt = name === 'continuity_validate'
      ? await (await import('./durable-continuity.js')).executePreparedContinuityWork(reviewContext, lease, admitted.id)
      : await (await import('./durable-quality.js')).executePreparedQualityWork(reviewContext, lease, admitted.id)
    const failure = failedToolResultSchema.safeParse(receipt.result)
    return failure.success ? { ...failure.data.toolResult, outcome: 'failed', failureCode: failure.data.code }
      : z.object({ toolResult: z.custom<ToolResult>() }).parse(receipt.result).toolResult
  }
}

/** These tools are DB-only. Model critics/repairs must use separately
 * receipted provider operations, never this retryable transaction adapter. */
export async function executeDurableCompiler(ctx: ToolContext, tool: AgentTool, raw: unknown): Promise<ToolResult> {
  const capability = ctx.durableCompiler && { ...ctx.durableCompiler, lease: { ...ctx.durableCompiler.lease },
    cursor: { ...ctx.durableCompiler.cursor }, baseline: ctx.durableCompiler.baseline && { ...ctx.durableCompiler.baseline } }
  if (!capability || !actions.has(tool.name) || capability.lease.userId !== ctx.userId || capability.lease.runId !== ctx.runId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '编译能力与原任务不一致。')
  const { lease, cursor, baseline } = capability
  const normalize = (value: unknown) => Object.fromEntries(Object.entries(tool.parameters.parse(normalizeToolInput(tool, value)) as Record<string, unknown>).filter(([, item]) => item !== undefined))
  const args = normalize(raw)
  const prepared = await prepareToolCursorOperation(lease, cursor, { key: capability.operationKey, action: tool.name, callId: ctx.callId,
    effectDomain: tool.name === 'chapter_bridge_get' ? 'read' : 'compiler', targetId: lease.taskRootId,
    effectiveArgs: args, normalize, operationInput: runtimeJson({ callId: ctx.callId, novelId: ctx.novelId, args, baseline }).value }).catch(async error => {
    if (!(error instanceof DataAccessError) || !['RUNTIME_APPROVAL_DENIED', 'RUNTIME_APPROVAL_EXPIRED'].includes(error.code)) throw error
    const rejected = await rejectToolCursorCall(lease, cursor, ctx.callId)
    await reduceExecutionReceipt(lease, { expectedRevision: rejected.pending.revision, expectedHash: rejected.pending.snapshotHash, operationId: rejected.operation.id })
    return { rejected: readFailedToolResult(rejected.receipt.result) }
  })
  if ('rejected' in prepared) return prepared.rejected
  const receipt = await executePreparedCompilerWork(ctx, lease, prepared.operation.id, tool)
  await reduceExecutionReceipt(lease, { expectedRevision: prepared.pending.revision, expectedHash: prepared.pending.snapshotHash, operationId: prepared.operation.id })
  const failed = failedToolResultSchema.safeParse(receipt.result)
  return failed.success ? { ...failed.data.toolResult, failureCode: failed.data.code, outcome: 'failed' } : z.object({ toolResult: z.object({ output: z.string(), summary: z.string() }).passthrough() }).parse(receipt.result).toolResult as ToolResult
}

/** DB business effects and their receipt are independent of cursor delivery.
 * Only an existing, genuinely admitted compiler tool can enter this core. */
export async function executePreparedCompilerWork(ctx: ToolContext, lease: import('../runtime-lease.js').RunLeaseToken, operationId: string, tool: AgentTool) {
  ctx = { ...ctx }; lease = { ...lease }
  if (lease.userId !== ctx.userId || lease.runId !== ctx.runId || !actions.has(tool.name)) return runtimeError('RUNTIME_SCOPE_MISMATCH', '编译工作不属于当前执行身份或原工具。')
  const { operation, input } = await readAdmittedReviewWork(lease, { operationId, action: tool.name, novelId: ctx.novelId, callId: ctx.callId })
  const { args, baseline } = z.object({ args: z.record(z.string(), z.unknown()), baseline: compilerObservationSchema.nullable() }).parse(input)
  const capability = { lease, operationKey: operation.operationKey, baseline,
    cursor: { expectedRevision: input.normalization.sourceRevision, expectedHash: input.normalization.sourceSnapshotHash } }
  if (tool.name === 'chapter_bridge_commit' && !await withRunLease(lease, tx => tx.agentEffectReceipt.findUnique({ where: { operationId: operation.id } }))) {
    let unavailableCode = 'CONTINUITY_CHECK_REQUIRED'
    try { await withRunLease(lease, async tx => {
      const services = await import('../runtime-writing-service.js')
      await services.requiredCommitReviewManifest(tx, ctx, typeof args.compilationId === 'string' ? args.compilationId : undefined)
      const readiness = await (await import('../chapter-review-guard.js')).readChapterReviewReadiness(tx, ctx,
        typeof args.compilationId === 'string' ? args.compilationId : undefined)
      if (readiness?.requiredTools.some(tool => tool.name === 'quality_analyze')) unavailableCode = 'QUALITY_CHECK_REQUIRED'
      await services.readWritingServiceConfirmations(tx, lease, readiness?.requiredTools.map(tool => tool.name) ?? [])
    }) } catch (error) {
      if (!(error instanceof DataAccessError) || error.code !== 'RUNTIME_EFFECT_NOT_AUTHORIZED') throw error
      return recordToolFailure(lease, { operationId: operation.id, inputHash: operation.inputHash, code: unavailableCode,
        output: `${error.message}当前必要检查未取得，正文已保留，章节尚未提交。`, summary: '当前任务缺少必要检查工具' })
    }
    const failed = await (await import('./story-compiler-tools.js')).prepareChapterCommitReviews({ ...ctx,
      registeredReview: registeredCommitReviews(ctx, lease, { operation, input }) }, args)
    if (failed) {
      if (failed.reviewOutcome === 'provider_unresolved') return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '原检查用量或费用尚未确认，章节未提交。')
      return recordToolFailure(lease, { operationId: operation.id, inputHash: operation.inputHash, code: failed.failureCode ?? 'CONTINUITY_REPORT_INCOMPLETE',
        output: failed.output, summary: failed.summary ?? '章节尚未提交' })
    }
  }
  const receipt = await commitOperationEffect(lease, operation.id, operation.inputHash, async tx => {
    ctx.signal.throwIfAborted()
    const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: lease.taskRootId } })
    if (root.novelId !== ctx.novelId || root.sessionId !== ctx.sessionId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '编译工具不属于原任务范围。')
    if (tool.name === 'scene_task_build') {
      if (!baseline) throw new DataAccessError(409, 'TOOL_COMPILER_REQUIRED', '本次未执行。请先准备本任务的章节编译，或用 chapter_bridge_get 读取本任务的 compilationId；不能使用其他任务的章节桥。')
      const current = await compilerStateHash(tx, ctx.userId, ctx.novelId, root.id, baseline.id)
      if (current !== baseline.hash) throw new DataAccessError(409, 'TOOL_COMPILER_STALE', `本次未执行。compilationId=${baseline.id} 的阶段或内容已变化，请先 chapter_bridge_get 重新读取后再决定，不覆盖新状态。`)
    }
    const result = await tool.execute({ ...ctx, durableCompiler: capability, transaction: tx }, args)
    if (result.outcome === 'failed') throw new DataAccessError(409,
      result.failureCode && failures.has(result.failureCode) ? result.failureCode : 'COMPILATION_NOT_FOUND', result.output)
    const id = result.display?.kind === 'storyCompiler' ? result.display.compilationId : undefined
    const hash = id ? await compilerStateHash(tx, ctx.userId, ctx.novelId, root.id, id) : null
    if (!id || !hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '编译结果缺少原任务内的状态身份。')
    ctx.signal.throwIfAborted()
    return runtimeJson({ compilerState: { id, hash }, toolResult: { ...result, summary: result.summary ?? '读取章节编译状态' } }).value
  }).catch(async error => {
    if (!(error instanceof DataAccessError) || !failures.has(error.code)) throw error
    return recordToolFailure(lease, { operationId: operation.id, inputHash: operation.inputHash, code: error.code, output: error.message, summary: '章节编译未执行' })
  })
  return receipt
}
