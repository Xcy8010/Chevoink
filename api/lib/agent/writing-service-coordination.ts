import { z } from 'zod'
import { taskSpecSchema } from '../../../shared/contracts/task-spec-contracts.js'
import { sceneTaskInputSchema } from '../../../shared/contracts/story-compiler-contracts.js'
import { activeChapterScope } from '../data/internal.js'
import { DataAccessError } from '../prisma.js'
import { isAgent2FeatureEnabled } from '../agent2-feature-flags.js'
import { coordinatedWritingInputSchema, coordinatedWritingManifest, type WritingServiceStep } from './coordinated-writing-input.js'
import { compilerObservationSchema, compilerStateHash } from './runtime-compiler-observation.js'
import { runtimeError, runtimeJson } from './runtime-common.js'
import { withRunLease, type RunLeaseToken } from './runtime-lease.js'
import { commitOperationEffect, recordToolFailure } from './runtime-operations.js'
import { readAdmittedToolOperation } from './runtime-tool-cursor.js'
import { readAdmittedWritingServiceStep, prepareWritingServiceStep, writingServiceOperationKey } from './runtime-writing-service.js'
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
const manifestSchema = z.object({ steps: z.array(z.object({ step: z.enum(['body', 'continuity', 'quality', 'commit']) })).min(1).max(4) })
const knownBodyRefusals = new Set(['AUTHOR_SCOPE_PROTECTED', 'AUTHOR_LOCAL_SCOPE', 'AUTHOR_LOCAL_STALE', 'AUTHOR_SELECTION_SCOPE', 'AUTHOR_SELECTION_STALE',
  'CHAPTER_REVISION_CONFLICT', 'CHAPTER_ANCHOR_CONFLICT', 'AUTHOR_CHAPTER_SCOPE', 'SCOPE_NEEDS_INPUT', 'RUNTIME_SCOPE_MISMATCH', 'RUNTIME_PARENT_LEASE_LOST',
  'REVIEW_AUTOMATION_STOPPED', 'REPAIR_NOT_AUTHORIZED', 'REVIEW_REPAIR_RECHECK_REQUIRED', 'REVIEW_MERGED_REVISION_REQUIRED', 'REVIEW_CYCLE_DECISION_REQUIRED',
  'SCENE_TASK_COUNT_INVALID', 'COMPILATION_STAGE_CONFLICT', 'COMPILATION_NOT_FOUND', 'INVALID_ARGUMENTS'])
type Receipt = Awaited<ReturnType<typeof commitOperationEffect>>

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
  const plan = await withRunLease(lease, async tx => {
    const genuine = await readAdmittedToolOperation(lease, { operationId: parentOperationId, action, novelId: ctx.novelId, callId: ctx.callId }, tx)
    const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: lease.taskRootId } })
    const spec = taskSpecSchema.parse(root.specSnapshot), request = await readOriginalTaskRequest(tx, ctx)
    const args = genuine.input.args, writing = coordinatedWritingInputSchema.parse(args.writing), chapterId = z.string().min(1).parse(args.chapterId)
    const manifest = coordinatedWritingManifest({ spec, prompt: request.prompt }, action, chapterId, writing)
    if (runtimeJson(manifest).hash !== runtimeJson(genuine.input.writingManifest).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '协调清单与原写入不一致。')
    return { ...genuine, writing, chapterId, manifest: manifestSchema.parse(manifest) }
  })
  const completed: Array<{ step: WritingServiceStep; operationId: string; inputHash: string; resultHash: string; receipt: Receipt }> = []
  for (const { step } of plan.manifest.steps) {
    ctx.signal.throwIfAborted()
    const source = completed.at(-1)
    const baseline = source ? compilerObservationSchema.parse(savedResult.parse(source.receipt.result).compilerState) : null
    const args = step === 'body' ? plan.input.args : step === 'continuity' ? { compilationId: baseline!.id, terminalState: plan.writing.actualOutcomes }
      : step === 'quality' ? { compilationId: baseline!.id } : { compilationId: baseline!.id,
        ...Object.fromEntries(Object.entries(plan.writing).filter(([key]) => ['chapterSummary', 'hookDecision', 'delayedHookReason', 'openingStructure', 'endingStructure'].includes(key))),
        ...(plan.input.args.retainedFindings !== undefined ? { retainedFindings: plan.input.args.retainedFindings } : {}) }
    const key = writingServiceOperationKey(parentOperationId, step)
    const prior = await withRunLease(lease, tx => tx.agentOperation.findUnique({ where: { taskRootId_operationKey: { taskRootId: lease.taskRootId, operationKey: key } } }))
    const work = prior ? z.object({ input: z.object({ work: z.unknown() }) }).parse(prior.inputSnapshot).input.work
      : step === 'continuity' ? await prepareContinuityWork(ctx, lease, { operationKey: key, observedRevision: plan.input.normalization.sourceRevision, baseline, args })
        : step === 'quality' ? await prepareQualityWork(ctx, lease, { operationKey: key, observedRevision: plan.input.normalization.sourceRevision, baseline, args, serviceReadOnly: true }) : {}
    const operation = await prepareWritingServiceStep(lease, { novelId: ctx.novelId, callId: ctx.callId, args, baseline, work,
      serviceAdmission: { version: 1, parentOperationId, parentInputHash: plan.operation.inputHash,
        sourceRevision: plan.input.normalization.sourceRevision, sourceSnapshotHash: plan.input.normalization.sourceSnapshotHash,
        step, chapterId: plan.chapterId, source: source ? { operationId: source.operationId, resultHash: source.resultHash } : null } })
    const receipt = step === 'body' ? await executePreparedWritingBody(ctx, lease, operation.id, action)
      : step === 'continuity' ? await executePreparedContinuityWork(ctx, lease, operation.id)
        : step === 'quality' ? await executePreparedQualityWork(ctx, lease, operation.id)
          : await executePreparedCompilerWork(ctx, lease, operation.id, { ...chapterBridgeCommitTool,
            execute: (context, raw) => chapterBridgeCommitTool.execute(context, chapterBridgeCommitTool.parameters.parse(raw)) })
    if (runtimeJson(receipt.result).hash !== receipt.resultHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '写作服务结果回执损坏。')
    completed.push({ step, operationId: operation.id, inputHash: operation.inputHash, resultHash: receipt.resultHash, receipt })
    if (failed(savedResult.parse(receipt.result))) break
  }
  const body = savedResult.parse(completed[0].receipt.result), last = savedResult.parse(completed.at(-1)!.receipt.result)
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
    return runtimeJson({ ...completed[0].receipt.result as object, ...(last.compilerState ? { compilerState: last.compilerState } : {}),
      writingCompletion: { version: 1, status: complete ? 'completed' : plan.writing.draftComplete ? 'blocked' : 'draft_saved',
        steps: completed.map(({ step, operationId, resultHash }) => ({ step, operationId, resultHash })) },
      toolResult: { ...body.toolResult, ...(failed(last) ? { outcome: 'failed',
        ...(last.toolResult.failureCode ?? last.code ? { failureCode: last.toolResult.failureCode ?? last.code } : {}) } : {}),
        output: `${body.toolResult.output}\n${complete ? '独立复核和真实章节提交已完成。' : plan.writing.draftComplete ? '正文已保存，后续复核或提交尚未完成。' : '本次草稿已保存，未请求章节完成。'}${completed.length > 1 ? `\n${last.toolResult.output}` : ''}`,
        summary: complete ? '正文已保存并提交' : plan.writing.draftComplete ? '正文已保存，完成受阻' : '草稿已保存' } }).value
  })
}
