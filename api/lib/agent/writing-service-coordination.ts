import { z } from 'zod'
import { taskSpecSchema } from '../../../shared/contracts/task-spec-contracts.js'
import { sceneTaskInputSchema } from '../../../shared/contracts/story-compiler-contracts.js'
import { activeChapterScope } from '../data/internal.js'
import { DataAccessError } from '../prisma.js'
import { isAgent2FeatureEnabled } from '../agent2-feature-flags.js'
import { coordinatedWritingInputSchema, coordinatedWritingManifest, writingServiceManifestSchema, type WritingServiceStep } from './coordinated-writing-input.js'
import { compilerObservationSchema, compilerStateHash } from './runtime-compiler-observation.js'
import { runtimeError, runtimeJson } from './runtime-common.js'
import { withRunLease, type RunLeaseToken } from './runtime-lease.js'
import { commitOperationEffect, recordToolFailure } from './runtime-operations.js'
import { readAdmittedToolOperation } from './runtime-tool-cursor.js'
import { readAdmittedWritingServiceStep, prepareWritingServiceStep, writingServiceOperationKey, composeWritingBodyEffects, readWritingReviewFrozenPrice } from './runtime-writing-service.js'
import { readOriginalTaskRequest } from './original-request.js'
import { assertAgentManuscriptCurrent } from './manuscript-scope.js'
import { assertCraftOutputSafe } from './craft-library.js'
import { compilationRunScope, prepareStoryCompilation, saveSceneTasksWithMilestone, recordStoryCompilerWrite } from './story-compiler.js'
import { applyDurableChapterBody } from './tools/durable-chapter.js'
import { prepareContinuityWork, executePreparedContinuityWork } from './tools/durable-continuity.js'
import { prepareQualityWork, executePreparedQualityWork } from './tools/durable-quality.js'
import { executePreparedCompilerWork } from './tools/durable-compiler.js'
import { chapterBridgeCommitTool } from './tools/story-compiler-tools.js'
import type { ToolContext } from './tools/types.js'

const savedResult = z.object({ toolResult: z.object({ output: z.string(), summary: z.string().optional(),
  outcome: z.literal('failed').optional(), failureCode: z.string().optional() }).passthrough(), compilerState: compilerObservationSchema.optional(),
  outcome: z.literal('failed').optional(), code: z.string().optional() }).passthrough()
const failed = (result: z.infer<typeof savedResult>) => result.outcome === 'failed' || result.toolResult.outcome === 'failed'
const manifestSchema = writingServiceManifestSchema
const knownBodyRefusals = new Set(['AUTHOR_SCOPE_PROTECTED', 'AUTHOR_LOCAL_SCOPE', 'AUTHOR_LOCAL_STALE', 'AUTHOR_SELECTION_SCOPE', 'AUTHOR_SELECTION_STALE',
  'CHAPTER_REVISION_CONFLICT', 'CHAPTER_ANCHOR_CONFLICT', 'AUTHOR_CHAPTER_SCOPE', 'SCOPE_NEEDS_INPUT', 'RUNTIME_SCOPE_MISMATCH', 'RUNTIME_PARENT_LEASE_LOST',
  'REVIEW_AUTOMATION_STOPPED', 'REPAIR_NOT_AUTHORIZED', 'REVIEW_REPAIR_RECHECK_REQUIRED', 'REVIEW_MERGED_REVISION_REQUIRED', 'REVIEW_CYCLE_DECISION_REQUIRED',
  'SCENE_TASK_COUNT_INVALID', 'COMPILATION_STAGE_CONFLICT', 'COMPILATION_NOT_FOUND', 'INVALID_ARGUMENTS'])
type Receipt = Awaited<ReturnType<typeof commitOperationEffect>>

async function executePreparedWritingRevision(ctx: ToolContext, lease: RunLeaseToken, operationId: string) {
  const coordinator = await import('./continuity-coordinator.js')
  const admitted = await withRunLease(lease, tx => readAdmittedWritingServiceStep(lease,
    { operationId, action: 'chapter_edit_range', novelId: ctx.novelId, callId: ctx.callId }, tx))
  if (admitted.manifest.version !== 2 || admitted.input.serviceAdmission.step !== 'prose_revision') return runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '该旧写作清单没有集中修订。')
  const existing = await withRunLease(lease, tx => tx.agentEffectReceipt.findUnique({ where: { operationId } }))
  if (existing) {
    if (runtimeJson(existing.result).hash !== existing.resultHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '集中修订回执损坏。')
    return existing
  }
  const work = coordinator.nativeContinuityRevisionWorkSchema.parse(admitted.input.work)
  const noEffect = (reason: string) => commitOperationEffect(lease, operationId, admitted.operation.inputHash, async tx => {
    ctx.signal.throwIfAborted()
    await assertAgentManuscriptCurrent(tx, ctx)
    const hash = await compilerStateHash(tx, ctx.userId, ctx.novelId, lease.taskRootId, work.compiler.id)
    if (hash !== work.compiler.hash) return runtimeError('TOOL_COMPILER_STALE', '无效果阶段不能采用另一编译状态。')
    return runtimeJson({ revisionApplied: false, compilerState: work.compiler, toolResult: { output: reason, summary: '集中修订 · 正文未变化' } }).value
  })
  if (work.kind === 'revision_skip') return noEffect(`原报告保持：${work.reason}。没有调用修订模型，没有创建正文转换或新版通过证明。`)
  const auxiliary = await import('./runtime-auxiliary-call.js')
  await auxiliary.callDurableAuxiliary({ lease, parentOperationId: operationId,
    step: 'continuity_coordinated_revision', route: auxiliary.auxiliaryRouteSchema.parse(work.route), price: work.price, system: work.system, content: work.content,
    temperature: 0, signal: ctx.signal, assertCurrent: async tx => { await coordinator.authenticateNativeContinuityRevisionWork(tx, ctx, work) } })
  const response = await withRunLease(lease, tx => coordinator.readNativeContinuityRevisionResult(tx, operationId))
  if (!response) return runtimeError('RUNTIME_RECONCILIATION_REQUIRED', '原集中修订响应或费用尚未确认，未重发。')
  let args: Awaited<ReturnType<typeof coordinator.nativeContinuityRevisionArgs>>
  try { args = await coordinator.nativeContinuityRevisionArgs(work, response.content) } catch (error) {
    if (ctx.signal.aborted) throw error
    return recordToolFailure(lease, { operationId, inputHash: admitted.operation.inputHash, code: 'CONTINUITY_REVISION_INVALID',
      output: '一次集中修订没有完整安全补丁，原始响应与费用已保留，未追加格式请求或改写正文。', summary: '集中修订未形成安全补丁' })
  }
  if (!args) return noEffect('实际改稿响应没有可应用的正文变化；原判断与留置意见仍保留，不代表问题已解决。')
  return commitOperationEffect(lease, operationId, admitted.operation.inputHash, async tx => {
    ctx.signal.throwIfAborted()
    await coordinator.authenticateNativeContinuityRevisionWork(tx, ctx, work)
    const result = await applyDurableChapterBody({ ...ctx, nativeContinuityRevision: { operationId, work } }, tx,
      { taskRootId: lease.taskRootId, action: 'chapter_edit_range', args: args!, expectedRevision: work.chapter.revision, anchorProtocol: 2 })
    const hash = await compilerStateHash(tx, ctx.userId, ctx.novelId, lease.taskRootId, work.compiler.id)
    if (!hash || result.progress.beforeHash === result.progress.afterHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '集中修订缺少实际正文转换。')
    return runtimeJson({ ...result, revisionApplied: true, compilerState: { id: work.compiler.id, hash } }).value
  })
}

async function executeWritingVerificationSkip(ctx: ToolContext, lease: RunLeaseToken, operationId: string, action: string) {
  const admitted = await withRunLease(lease, tx => readAdmittedWritingServiceStep(lease,
    { operationId, action, novelId: ctx.novelId, callId: ctx.callId }, tx))
  const work = z.object({ kind: z.literal('verification_skip'), version: z.literal(1), compiler: compilerObservationSchema }).strict().parse(admitted.input.work)
  return commitOperationEffect(lease, operationId, admitted.operation.inputHash, async tx => {
    const hash = await compilerStateHash(tx, ctx.userId, ctx.novelId, lease.taskRootId, work.compiler.id)
    if (hash !== work.compiler.hash) return runtimeError('TOOL_COMPILER_STALE', '无正文转换的复核阶段已过期。')
    return runtimeJson({ compilerState: work.compiler, verificationSkipped: true,
      toolResult: { output: '未发生原周期正文转换，保留真实当前报告；没有购买复检，也没有制造完成证明。', summary: '正文未变 · 复检无需新请求' } }).value
  })
}

/** Internal body transaction: compiler, scenes, manuscript CAS and receipt
 * commit together. It never makes the real parent succeed at the body boundary. */
export async function executePreparedWritingBody(ctx: ToolContext, lease: RunLeaseToken, operationId: string, action: string) {
  if (lease.userId !== ctx.userId || lease.runId !== ctx.runId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '写入服务执行身份不一致。')
  const admitted = await withRunLease(lease, tx => readAdmittedWritingServiceStep(lease,
    { operationId, action, novelId: ctx.novelId, callId: ctx.callId }, tx))
  if (admitted.input.serviceAdmission.step !== 'body') return runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '正文服务不能代替复核或提交。')
  const writer = z.enum(['chapter_write', 'chapter_append', 'chapter_edit_range']).parse(action)
  const writing = coordinatedWritingInputSchema.parse(admitted.original.args.writing)
  const { writing: _writing, ...bodyArgs } = admitted.original.args
  void _writing
  const args = z.object({ chapterId: z.string().min(1), content: z.string().optional(), oldText: z.string().optional(), start: z.number().optional(),
    end: z.number().optional(), newText: z.string().optional(), patches: z.array(z.object({ oldText: z.string(), newText: z.string() }).strict()).optional(),
    retainedFindings: z.array(z.object({ source: z.enum(['continuity', 'quality']), reportId: z.string(), findingId: z.string(), reason: z.string() })).optional() }).strict().parse(bodyArgs)
  const expectedRevision = z.number().int().positive().parse(admitted.original.expectedRevision)
  const existing = await withRunLease(lease, tx => tx.agentEffectReceipt.findUnique({ where: { operationId } }))
  if (existing) {
    if (runtimeJson(existing.result).hash !== existing.resultHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '正文服务回执损坏。')
    return existing
  }
  if (ctx.protectedChapterIds?.has(args.chapterId)) return runtimeError('AUTHOR_SCOPE_PROTECTED', '作者要求保持不变的章节不能写入。')
  const candidate = writer === 'chapter_edit_range' ? args.patches?.map(item => item.newText).join('\n') ?? args.newText : args.content
  if (candidate === undefined) return runtimeError('RUNTIME_INPUT_INVALID', '正文内容缺失。')
  if (isAgent2FeatureEnabled('craftLibrary', ctx.userId) && candidate.trim().length >= 80) {
    await assertCraftOutputSafe({ userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId, chapterId: args.chapterId, content: candidate })
  }
  return commitOperationEffect(lease, operationId, admitted.operation.inputHash, async tx => {
    ctx.signal.throwIfAborted()
    await assertAgentManuscriptCurrent(tx, ctx)
    const scope = await compilationRunScope(tx, ctx)
    let compilation = await tx.storyCompilation.findFirst({ where: { userId: ctx.userId, novelId: ctx.novelId,
      ...scope, chapterId: args.chapterId, status: 'active' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], include: { sceneTasks: { orderBy: { ordinal: 'asc' } } } })
    if (!compilation) {
      if (!writing.scenes?.length) throw new DataAccessError(400, 'SCENE_TASK_COUNT_INVALID', '首次保存正文需要原作者方案的场景任务。')
      const request = await readOriginalTaskRequest(tx, ctx)
      const prepared = await prepareStoryCompilation({ userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId,
        chapterId: args.chapterId, mode: ctx.qualityMode, intentSummary: request.prompt ?? '',
        ...(writing.volumeDecision ? { volumeDecision: writing.volumeDecision } : {}) }, tx)
      compilation = { ...prepared.compilation, sceneTasks: [] }
    }
    if (writing.scenes) {
      const unchanged = runtimeJson(compilation.sceneTasks.map(task => sceneTaskInputSchema.parse(task))).hash === runtimeJson(writing.scenes).hash
      if (!unchanged) await saveSceneTasksWithMilestone({ userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId,
        compilationId: compilation.id, tasks: writing.scenes }, tx)
    } else if (!compilation.sceneTasks.length) throw new DataAccessError(400, 'SCENE_TASK_COUNT_INVALID', '正文尚无已保存场景任务，未执行写入。')
    const result = await applyDurableChapterBody(ctx, tx, { taskRootId: lease.taskRootId, action: writer, args, expectedRevision, anchorProtocol: 2 })
    // An identical body can still enter a newly prepared compiler. It consumes
    // no manuscript revision and earns no content-progress credit.
    if (result.progress.beforeHash === result.progress.afterHash) {
      const chapter = await tx.chapter.findFirstOrThrow({ where: { id: args.chapterId, authorId: ctx.userId, ...activeChapterScope(ctx.novelId), revision: result.toolResult.display.revision } })
      await recordStoryCompilerWrite({ userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId,
        chapterId: chapter.id, chapterOrderIndex: chapter.orderIndex, chapterRevision: chapter.revision }, tx)
    }
    const hash = await compilerStateHash(tx, ctx.userId, ctx.novelId, lease.taskRootId, compilation.id)
    if (!hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '正文事务缺少同一编译的保存回执。')
    return runtimeJson({ ...result, compilerState: { id: compilation.id, hash } }).value
  }).catch(error => {
    if (!(error instanceof DataAccessError) || !knownBodyRefusals.has(error.code)) throw error
    return recordToolFailure(lease, { operationId, inputHash: admitted.operation.inputHash, code: error.code,
      output: error.message, summary: '正文变更未执行' })
  })
}

/** One genuine writer, at most four existing operations. This core does not
 * publish a schema, upgrade an old task, or advance the main cursor. The shell
 * may reduce only its final parent receipt. Unknown outcomes propagate pending. */
export async function executeCoordinatedWritingServices(ctx: ToolContext, lease: RunLeaseToken, parentOperationId: string, action: string) {
  if (lease.userId !== ctx.userId || lease.runId !== ctx.runId) return runtimeError('RUNTIME_SCOPE_MISMATCH', '写作协调身份不一致。')
  ctx = { ...ctx, continuityNativeLease: lease }
  const plan = await withRunLease(lease, async tx => {
    const genuine = await readAdmittedToolOperation(lease, { operationId: parentOperationId, action, novelId: ctx.novelId, callId: ctx.callId }, tx)
    const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: lease.taskRootId } })
    const spec = taskSpecSchema.parse(root.specSnapshot), request = await readOriginalTaskRequest(tx, ctx)
    const args = genuine.input.args, writing = coordinatedWritingInputSchema.parse(args.writing), chapterId = z.string().min(1).parse(args.chapterId)
    const manifest = coordinatedWritingManifest({ spec, prompt: request.prompt }, action, chapterId, writing, { frozenManifest: genuine.input.writingManifest })
    if (runtimeJson(manifest).hash !== runtimeJson(genuine.input.writingManifest).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '协调清单与原写入不一致。')
    return { ...genuine, writing, chapterId, manifest: manifestSchema.parse(manifest) }
  })
  const completed: Array<{ step: WritingServiceStep; operationId: string; inputHash: string; resultHash: string; receipt: Receipt }> = []
  for (const { step } of plan.manifest.steps) {
    ctx.signal.throwIfAborted()
    const source = completed.at(-1)
    const baseline = source ? compilerObservationSchema.parse(savedResult.parse(source.receipt.result).compilerState) : null
    const continuityStep = step === 'continuity' || step === 'continuity_verify', qualityStep = step === 'quality' || step === 'quality_verify'
    const verify = step === 'continuity_verify' || step === 'quality_verify'
    const revision = completed.find(item => item.step === 'prose_revision')
    const revisionApplied = revision ? z.object({ revisionApplied: z.boolean() }).parse(revision.receipt.result).revisionApplied : false
    const args = step === 'body' ? plan.input.args : continuityStep ? { compilationId: baseline!.id, terminalState: plan.writing.actualOutcomes }
      : qualityStep ? { compilationId: baseline!.id } : step === 'prose_revision' ? { chapterId: plan.chapterId } : { compilationId: baseline!.id,
        ...Object.fromEntries(Object.entries(plan.writing).filter(([key]) => ['chapterSummary', 'hookDecision', 'delayedHookReason', 'openingStructure', 'endingStructure'].includes(key))),
        ...(plan.input.args.retainedFindings !== undefined ? { retainedFindings: plan.input.args.retainedFindings } : {}) }
    const key = writingServiceOperationKey(parentOperationId, step)
    const prior = await withRunLease(lease, tx => tx.agentOperation.findUnique({ where: { taskRootId_operationKey: { taskRootId: lease.taskRootId, operationKey: key } } }))
    const originalReview = verify && revisionApplied ? await withRunLease(lease, async tx => {
      const sourceStep = qualityStep ? 'quality' : 'continuity'
      return readWritingReviewFrozenPrice(tx, { ...lease, novelId: ctx.novelId }, parentOperationId, sourceStep)
    }) : null
    const frozenReview = verify && revisionApplied && originalReview ? { route: (await import('./runtime-auxiliary-call.js')).auxiliaryRouteSchema.parse(originalReview.route),
      price: (await import('../billing/token-price.js')).tokenPriceSchema.parse(originalReview.price) } : undefined
    const work = prior ? z.object({ input: z.object({ work: z.unknown() }) }).parse(prior.inputSnapshot).input.work
      : verify && !revisionApplied ? { kind: 'verification_skip', version: 1, compiler: baseline }
        : step === 'prose_revision' ? await withRunLease(lease, tx => import('./continuity-coordinator.js').then(module =>
          module.prepareNativeContinuityRevisionWork(tx, ctx, baseline!, parentOperationId)))
          : continuityStep ? await prepareContinuityWork(ctx, lease, { operationKey: key, observedRevision: plan.input.normalization.sourceRevision, baseline, args, ...(frozenReview ? { frozenReview } : {}) })
            : qualityStep ? await prepareQualityWork(ctx, lease, { operationKey: key, observedRevision: plan.input.normalization.sourceRevision, baseline, args, serviceReadOnly: true, ...(frozenReview ? { frozenReview } : {}) }) : {}
    const operation = await prepareWritingServiceStep(lease, { novelId: ctx.novelId, callId: ctx.callId, args, baseline, work,
      serviceAdmission: { version: 1, parentOperationId, parentInputHash: plan.operation.inputHash,
        sourceRevision: plan.input.normalization.sourceRevision, sourceSnapshotHash: plan.input.normalization.sourceSnapshotHash,
        step, chapterId: plan.chapterId, source: source ? { operationId: source.operationId, resultHash: source.resultHash } : null } })
    const receipt = step === 'body' ? await executePreparedWritingBody(ctx, lease, operation.id, action)
      : step === 'prose_revision' ? await executePreparedWritingRevision(ctx, lease, operation.id)
        : verify && !revisionApplied ? await executeWritingVerificationSkip(ctx, lease, operation.id, continuityStep ? 'continuity_validate' : 'quality_analyze')
          : continuityStep ? await executePreparedContinuityWork(ctx, lease, operation.id)
            : qualityStep ? await executePreparedQualityWork(ctx, lease, operation.id)
          : await executePreparedCompilerWork(ctx, lease, operation.id, { ...chapterBridgeCommitTool,
            execute: (context, raw) => chapterBridgeCommitTool.execute(context, chapterBridgeCommitTool.parameters.parse(raw)) })
    if (runtimeJson(receipt.result).hash !== receipt.resultHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '写作服务结果回执损坏。')
    completed.push({ step, operationId: operation.id, inputHash: operation.inputHash, resultHash: receipt.resultHash, receipt })
    if (failed(savedResult.parse(receipt.result))) break
  }
  const revision = completed.find(item => item.step === 'prose_revision')
  const effectiveBody = revision ? composeWritingBodyEffects(completed[0].receipt.result as Record<string, unknown>, revision.receipt.result as Record<string, unknown>)
    : completed[0].receipt.result as Record<string, unknown>
  const body = savedResult.parse(effectiveBody), last = savedResult.parse(completed.at(-1)!.receipt.result)
  const bodyFailed = failed(body)
  if (bodyFailed) return recordToolFailure(lease, { operationId: parentOperationId, inputHash: plan.operation.inputHash,
    code: body.toolResult.failureCode ?? z.object({ code: z.string() }).parse(completed[0].receipt.result).code,
    output: body.toolResult.output, summary: body.toolResult.summary ?? '正文未保存' })
  const complete = plan.writing.draftComplete && completed.at(-1)!.step === 'commit' && !failed(last)
  return commitOperationEffect(lease, parentOperationId, plan.operation.inputHash, async tx => {
    for (const item of completed) {
      const saved = await tx.agentOperation.findUniqueOrThrow({ where: { id: item.operationId }, include: { effectReceipt: true } })
      if (saved.parentOperationId !== parentOperationId || saved.taskRootId !== lease.taskRootId || !['succeeded', 'failed'].includes(saved.status)
        || saved.inputHash !== item.inputHash || runtimeJson(saved.inputSnapshot).hash !== item.inputHash
        || !saved.effectReceipt || saved.effectReceipt.resultHash !== item.resultHash || runtimeJson(saved.effectReceipt.result).hash !== item.resultHash) {
        return runtimeError('RUNTIME_RECEIPT_INVALID', '写作协调缺少原服务结果，未宣称完成。')
      }
    }
    return runtimeJson({ ...effectiveBody, ...(last.compilerState ? { compilerState: last.compilerState } : {}),
      writingCompletion: { version: 1, status: complete ? 'completed' : plan.writing.draftComplete ? 'blocked' : 'draft_saved',
        steps: completed.map(({ step, operationId, resultHash }) => ({ step, operationId, resultHash })) },
      toolResult: { ...body.toolResult, ...(failed(last) ? { outcome: 'failed',
        ...(last.toolResult.failureCode ?? last.code ? { failureCode: last.toolResult.failureCode ?? last.code } : {}) } : {}),
        output: `${body.toolResult.output}\n${complete ? '独立复核和真实章节提交已完成。' : plan.writing.draftComplete ? '正文已保存，后续复核或提交尚未完成。' : '本次草稿已保存，未请求章节完成。'}${completed.length > 1 ? `\n${last.toolResult.output}` : ''}`,
        summary: complete ? '正文已保存并提交' : plan.writing.draftComplete ? '正文已保存，完成受阻' : '草稿已保存' } }).value
  })
}
