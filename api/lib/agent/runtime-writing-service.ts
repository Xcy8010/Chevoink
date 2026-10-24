import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { taskSpecSchema } from '../../../shared/contracts/task-spec-contracts.js'
import { coordinatedWritingInputSchema, coordinatedWritingManifest, coordinatedWriterActions, writingServiceStepSchema } from './coordinated-writing-input.js'
import { runtimeError, runtimeJson, type RuntimeTx } from './runtime-common.js'
import { argumentNormalizationSchema, readAdmittedToolOperation, readToolOperationSource } from './runtime-tool-cursor.js'
import { readExecutionStateInTransaction } from './runtime-state.js'
import { readObservedBaseline } from './runtime-observed-baseline.js'
import { compilerObservationSchema } from './runtime-compiler-observation.js'
import { readOriginalTaskRequest } from './original-request.js'
import { assertWritingTarget, readWritingScope } from './writing-scope.js'
import { prepareOperationInTransaction } from './runtime-operations.js'
import { withManuscriptRunLease, withRunLease, type RunLeaseToken } from './runtime-lease.js'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const manifestSchema = z.object({ version: z.literal(1), chapterId: z.string().min(1), writingHash: hash,
  steps: z.array(z.object({ step: writingServiceStepSchema, actions: z.array(z.string().min(1)).min(1) }).strict()).min(1).max(4) }).strict()
export const writingServiceAdmissionSchema = z.object({ version: z.literal(1), parentOperationId: z.string().min(1), parentInputHash: hash,
  sourceRevision: z.number().int().nonnegative(), sourceSnapshotHash: hash, step: writingServiceStepSchema, chapterId: z.string().min(1),
  source: z.object({ operationId: z.string().min(1), resultHash: hash }).strict().nullable() }).strict()
const inputSchema = z.object({ novelId: z.string().min(1), callId: z.string().min(1), args: z.record(z.string(), z.unknown()),
  baseline: compilerObservationSchema.nullable(), serviceAdmission: writingServiceAdmissionSchema, work: z.unknown() }).strict()
const bodyReceiptSchema = z.object({ toolResult: z.object({ display: z.object({ kind: z.literal('chapterDiff'), chapterId: z.string(),
  revision: z.number().int().positive(), before: z.string(), after: z.string() }) }) })

/** Reviews may inspect only the body saved by this writer. The service does
 * not silently add an automatic prose-repair decision to a review manifest. */
export function assertWritingReviewWork(value: unknown, expected: { step: 'continuity' | 'quality'; baseline: z.infer<typeof compilerObservationSchema>;
  chapterId: string; revision: number; content: string; actualOutcomes: unknown }) {
  const work = z.object({ kind: z.enum(['check', 'rejected']) }).passthrough().parse(value)
  if (work.kind === 'rejected') return // A bounded refusal supplies no effect or provider authority.
  const frozen = z.object({ compiler: compilerObservationSchema, chapter: z.object({ id: z.string(), revision: z.number(), content: z.string() }),
    repair: z.literal(false), terminalCandidate: z.unknown().optional(), sourceBodies: z.object({ current: z.string() }).optional() }).parse(work)
  if (runtimeJson(frozen.compiler).hash !== runtimeJson(expected.baseline).hash
    || frozen.chapter.id !== expected.chapterId || frozen.chapter.revision !== expected.revision || frozen.chapter.content !== expected.content
    || expected.step === 'continuity' && (runtimeJson({ candidate: frozen.terminalCandidate ?? null }).hash !== runtimeJson({ candidate: expected.actualOutcomes ?? null }).hash
      || frozen.sourceBodies?.current !== expected.content)) {
    return runtimeError('RUNTIME_RECEIPT_INVALID', '独立复核工作与原候选、已保存正文或编译回执不一致。')
  }
}
const actionFor = (step: z.infer<typeof writingServiceStepSchema>, writer: string) => ({ body: writer,
  continuity: 'continuity_validate', quality: 'quality_analyze', commit: 'chapter_bridge_commit' })[step]
export const writingServiceOperationKey = (parentId: string, step: z.infer<typeof writingServiceStepSchema>) => `writing:${parentId}:${step}`

/** Read-only evidence after the parent has closed. This is deliberately not
 * effect admission: a blocked review cannot hide a real saved body, and cannot
 * use arbitrary failed-result metadata to manufacture progress. */
export async function readCommittedWritingBodyProgress(tx: RuntimeTx, parent: { id: string; taskRootId: string; action: string; inputSnapshot: Prisma.JsonValue; inputHash: string }, value: unknown) {
  if (!coordinatedWriterActions.some(action => action === parent.action) || runtimeJson(parent.inputSnapshot).hash !== parent.inputHash) {
    return runtimeError('RUNTIME_RECEIPT_INVALID', '受阻写作进度缺少真实父写入。')
  }
  const completion = z.object({ writingCompletion: z.object({ version: z.literal(1), status: z.literal('blocked'),
    steps: z.array(z.object({ step: writingServiceStepSchema, operationId: z.string(), resultHash: hash }).strict()).min(2).max(4) }).strict(),
    progress: z.unknown(), toolResult: z.object({ display: z.unknown() }) }).parse(value)
  const original = z.object({ input: z.object({ novelId: z.string(), callId: z.string(), args: z.record(z.string(), z.unknown()),
    expectedRevision: z.number().int().positive(), writingManifest: manifestSchema, normalization: argumentNormalizationSchema }) }).parse(parent.inputSnapshot).input
  const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: parent.taskRootId } })
  const spec = taskSpecSchema.parse(root.specSnapshot), writing = coordinatedWritingInputSchema.parse(original.args.writing)
  const request = await readOriginalTaskRequest(tx, { userId: root.userId, novelId: root.novelId,
    runId: (await tx.agentOperation.findUniqueOrThrow({ where: { id: parent.id } })).originRunId })
  const chapterId = z.string().parse(original.args.chapterId)
  const manifest = manifestSchema.parse(coordinatedWritingManifest({ spec, prompt: request.prompt }, parent.action, chapterId, writing))
  if (!writing.draftComplete || original.novelId !== root.novelId || runtimeJson(original.args).hash !== original.normalization.normalizedArgsHash
    || runtimeJson(original.writingManifest).hash !== runtimeJson(manifest).hash
    || completion.writingCompletion.steps.some((step, index) => step.step !== manifest.steps[index]?.step)) {
    return runtimeError('RUNTIME_RECEIPT_INVALID', '受阻写作进度不属于原完整写作合同。')
  }
  const body = await tx.agentOperation.findUnique({ where: { taskRootId_operationKey: { taskRootId: parent.taskRootId,
    operationKey: writingServiceOperationKey(parent.id, 'body') } }, include: { effectReceipt: true } })
  const declared = completion.writingCompletion.steps[0], receipt = body?.effectReceipt
  const expectedInput = { novelId: original.novelId, callId: original.callId, args: original.args, baseline: null, work: {}, serviceAdmission: {
    version: 1, parentOperationId: parent.id, parentInputHash: parent.inputHash, sourceRevision: original.normalization.sourceRevision,
    sourceSnapshotHash: original.normalization.sourceSnapshotHash, step: 'body', chapterId, source: null } }
  if (!body || body.id !== declared.operationId || body.taskRootId !== parent.taskRootId || body.kind !== 'internal' || body.action !== parent.action
    || body.parentOperationId !== parent.id || body.status !== 'succeeded' || !receipt || receipt.resultHash !== declared.resultHash
    || runtimeJson(receipt.result).hash !== receipt.resultHash
    || body.inputHash !== runtimeJson({ kind: 'internal', action: parent.action, parentOperationId: parent.id, input: expectedInput }).hash
    || runtimeJson(body.inputSnapshot).hash !== body.inputHash) {
    return runtimeError('RUNTIME_RECEIPT_INVALID', '受阻写作缺少同一父写入已提交的正文回执。')
  }
  const event = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `effect:${body.id}` } })
  if (!event || event.operationId !== body.id || event.taskRootId !== parent.taskRootId || event.type !== 'effect.committed'
    || runtimeJson(event.payload).hash !== runtimeJson({ operationId: body.id, resultHash: receipt.resultHash }).hash) {
    return runtimeError('RUNTIME_RECEIPT_INVALID', '已保存正文缺少真实事务事件。')
  }
  const saved = bodyReceiptSchema.extend({ progress: z.object({ kind: z.literal('content_revision'), targetId: z.string(), beforeHash: hash, afterHash: hash }).strict() }).parse(receipt.result)
  const display = saved.toolResult.display
  if (display.chapterId !== chapterId || saved.progress.targetId !== chapterId
    || display.revision !== original.expectedRevision + (display.before === display.after ? 0 : 1)
    || saved.progress.beforeHash !== runtimeJson({ content: display.before }).hash || saved.progress.afterHash !== runtimeJson({ content: display.after }).hash
    || runtimeJson(saved.progress).hash !== runtimeJson(completion.progress).hash || runtimeJson(display).hash !== runtimeJson(
      bodyReceiptSchema.parse({ toolResult: { display: completion.toolResult.display } }).toolResult.display).hash) {
    return runtimeError('RUNTIME_RECEIPT_INVALID', '受阻写作的正文变化与实际回执不一致。')
  }
  return saved.progress
}

/** Authenticate service work against a real pending writer and its immutable
 * predecessor receipt. An internal row, target ID or current DB read alone is
 * never a grant or an observation delivered to the model. */
type ServiceProofSubject = Pick<RunLeaseToken, 'userId' | 'runId' | 'taskRootId'>
async function readServiceParent(tx: RuntimeTx, lease: ServiceProofSubject, saved: z.infer<typeof inputSchema>, verification: { historical: boolean; liveLease?: RunLeaseToken }) {
  const admission = saved.serviceAdmission
  const parent = await tx.agentOperation.findFirst({ where: { id: admission.parentOperationId, taskRootId: lease.taskRootId, kind: 'tool', ...(!verification.historical ? { status: 'prepared' } : {}) } })
  if (!parent || !coordinatedWriterActions.some(name => name === parent.action)) return runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '内部写作步骤缺少原待执行写入。')
  const genuine = verification.historical ? await readToolOperationSource(tx, parent)
    : verification.liveLease ? await readAdmittedToolOperation(verification.liveLease, { operationId: parent.id, action: parent.action, novelId: saved.novelId, callId: saved.callId }, tx)
      : runtimeError('RUNTIME_RECEIPT_INVALID', '当前内部工作缺少原执行租约。')
  const original = genuine.input
  const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: lease.taskRootId } })
  const spec = taskSpecSchema.parse(root.specSnapshot)
  const request = await readOriginalTaskRequest(tx, { userId: lease.userId, novelId: saved.novelId, runId: lease.runId })
  if (root.userId !== lease.userId || root.novelId !== saved.novelId || spec.id !== taskSpecSchema.parse(request.spec).id || original.novelId !== saved.novelId || original.callId !== saved.callId) return runtimeError('RUNTIME_RECEIPT_INVALID', '原内部工作不属于同一作者任务。')
  return { parent, original, root, spec, request }
}

type ServiceIdentity = { operationId: string; action: string; novelId: string; callId: string }
type ServiceVerification = { parent?: Awaited<ReturnType<typeof readServiceParent>>; proven: Set<string>; historical: boolean; liveLease?: RunLeaseToken }
const serviceVerification = (liveLease?: RunLeaseToken, historical = false): ServiceVerification => ({ proven: new Set(), historical, ...(liveLease ? { liveLease } : {}) })

/** Only this read traversal shares proof. Never reuse it between transactions,
 * preparation, effects or provider requests: those boundaries re-read authority. */
async function verifyPredecessor(tx: RuntimeTx, lease: ServiceProofSubject, input: ServiceIdentity, verification: ServiceVerification): Promise<void> {
  const key = JSON.stringify([input.operationId, input.action, input.novelId, input.callId])
  if (verification.proven.has(key)) return
  await readVerifiedServiceStep(lease, input, tx, verification)
  verification.proven.add(key)
}

async function verifyServiceInput(tx: RuntimeTx, lease: ServiceProofSubject, saved: z.infer<typeof inputSchema>, action: string, verification: ServiceVerification) {
  const admission = saved.serviceAdmission
  const common = verification.parent ?? await readServiceParent(tx, lease, saved, verification)
  const { parent, original, root, spec, request } = common
  if (parent.id !== admission.parentOperationId || original.novelId !== saved.novelId || original.callId !== saved.callId) {
    return runtimeError('RUNTIME_RECEIPT_INVALID', '内部前置步骤与同一父写入或调用不一致。')
  }
  verification.parent = common
  const chapterId = original.args.chapterId
  const writing = coordinatedWritingInputSchema.parse(original.args.writing)
  if (typeof chapterId !== 'string' || chapterId !== admission.chapterId || root.novelId !== saved.novelId
    || parent.inputHash !== admission.parentInputHash || original.normalization.sourceRevision !== admission.sourceRevision
    || original.normalization.sourceSnapshotHash !== admission.sourceSnapshotHash || action !== actionFor(admission.step, parent.action)) {
    return runtimeError('RUNTIME_RECEIPT_INVALID', '内部步骤与真实写入、目标或原上下文不一致。')
  }
  if (verification.historical) {
    const scope = await readWritingScope(tx, { userId: lease.userId, novelId: saved.novelId, runId: lease.runId })
    if (scope.writing?.kind !== 'bounded' || !scope.writing.targets.some(target =>
      (target.chapterId ?? scope.bindings?.targets.find(binding => binding.orderIndex === target.orderIndex)?.chapterId) === chapterId))
      return runtimeError('RUNTIME_RECEIPT_INVALID', '原内部工作的章节不属于冻结目标。')
  } else await assertWritingTarget(tx, { userId: lease.userId, novelId: saved.novelId, runId: lease.runId },
    { chapterId, effect: parent.action === 'chapter_write' ? 'replace' : parent.action === 'chapter_append' ? 'append' : 'range' })
  const manifest = manifestSchema.parse(coordinatedWritingManifest({ spec, prompt: request.prompt }, parent.action, chapterId, writing))
  if (runtimeJson(manifest).hash !== runtimeJson(original.writingManifest).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '写作步骤清单与原写入决策不一致。')
  const index = manifest.steps.findIndex(item => item.step === admission.step)
  if (index < 0) return runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '原写入没有授权该内部业务步骤。')
  let expectedArgs: Record<string, unknown>, expectedBaseline: z.infer<typeof compilerObservationSchema> | null = null
  if (index === 0) {
    const observed = await readObservedBaseline(tx, lease.taskRootId, admission.sourceRevision, { kind: 'chapter', id: chapterId })
    if (admission.source !== null || observed?.kind !== 'chapter' || observed.revision !== original.expectedRevision) {
      return runtimeError('RUNTIME_RECEIPT_INVALID', '写作保存缺少原模型实际读到的正文版本，不能采用今天的新版本。')
    }
    expectedArgs = original.args
  } else {
    const previous = manifest.steps[index - 1].step
    const source = await tx.agentOperation.findUnique({ where: { taskRootId_operationKey: {
      taskRootId: lease.taskRootId, operationKey: writingServiceOperationKey(parent.id, previous) } }, include: { effectReceipt: true } })
    const receipt = source?.effectReceipt
    if (!source || source.kind !== 'internal' || source.parentOperationId !== parent.id || source.status !== 'succeeded'
      || !receipt || admission.source?.operationId !== source.id || admission.source.resultHash !== receipt.resultHash
      || runtimeJson(source.inputSnapshot).hash !== source.inputHash || runtimeJson(receipt.result).hash !== receipt.resultHash) {
      return runtimeError('RUNTIME_RECEIPT_INVALID', '内部写作步骤缺少同一父写入的真实前置回执。')
    }
    await verifyPredecessor(tx, lease, { operationId: source.id, action: actionFor(previous, parent.action),
      novelId: saved.novelId, callId: saved.callId }, verification)
    const event = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `effect:${source.id}` } })
    if (!event || event.operationId !== source.id || event.taskRootId !== lease.taskRootId || event.type !== 'effect.committed'
      || runtimeJson(event.payload).hash !== runtimeJson({ operationId: source.id, resultHash: receipt.resultHash }).hash) {
      return runtimeError('RUNTIME_RECEIPT_INVALID', '内部前置回执缺少匹配持久事件。')
    }
    const result = z.object({ compilerState: compilerObservationSchema, toolResult: z.object({ outcome: z.never().optional() }).passthrough() }).parse(receipt.result)
    expectedBaseline = result.compilerState
    expectedArgs = admission.step === 'continuity' ? { compilationId: expectedBaseline.id, terminalState: writing.actualOutcomes }
      : admission.step === 'quality' ? { compilationId: expectedBaseline.id }
        : { compilationId: expectedBaseline.id, ...Object.fromEntries(Object.entries(writing).filter(([key]) =>
          ['chapterSummary', 'hookDecision', 'delayedHookReason', 'openingStructure', 'endingStructure'].includes(key))),
          ...(original.args.retainedFindings !== undefined ? { retainedFindings: original.args.retainedFindings } : {}) }
    if (admission.step === 'continuity' || admission.step === 'quality') {
      const body = previous === 'body' ? source : await tx.agentOperation.findUnique({ where: { taskRootId_operationKey: {
        taskRootId: lease.taskRootId, operationKey: writingServiceOperationKey(parent.id, 'body') } }, include: { effectReceipt: true } })
      if (!body || body.status !== 'succeeded' || !body.effectReceipt
        || runtimeJson(body.effectReceipt.result).hash !== body.effectReceipt.resultHash) {
        return runtimeError('RUNTIME_RECEIPT_INVALID', '独立复核缺少同一写入的正文回执。')
      }
      if (previous !== 'body') await verifyPredecessor(tx, lease, { operationId: body.id, action: parent.action,
        novelId: saved.novelId, callId: saved.callId }, verification)
      const display = bodyReceiptSchema.parse(body.effectReceipt.result).toolResult.display
      if (display.chapterId !== chapterId) return runtimeError('RUNTIME_RECEIPT_INVALID', '正文回执目标与原写入不一致。')
      assertWritingReviewWork(saved.work, { step: admission.step, baseline: expectedBaseline, chapterId,
        revision: display.revision, content: display.after, actualOutcomes: writing.actualOutcomes })
    }
  }
  if ((admission.step === 'body' || admission.step === 'commit') && runtimeJson(saved.work).hash !== runtimeJson({}).hash) {
    return runtimeError('RUNTIME_RECEIPT_INVALID', '正文或提交步骤不能携带额外复核工作。')
  }
  if (runtimeJson(saved.args).hash !== runtimeJson(expectedArgs).hash || runtimeJson({ baseline: saved.baseline }).hash !== runtimeJson({ baseline: expectedBaseline }).hash) {
    return runtimeError('RUNTIME_RECEIPT_INVALID', '内部业务参数或版本不是原写入及前置回执的确定投影。')
  }
  return { parent, original, manifest, step: manifest.steps[index], input: saved }
}

/** Strict alternate provenance for service cores. Real tool admission is never
 * weakened and no fabricated call or additional main cursor is produced. */
async function readVerifiedServiceStep(lease: ServiceProofSubject, input: ServiceIdentity, tx: RuntimeTx, verification: ServiceVerification) {
  const operation = await tx.agentOperation.findFirst({ where: { id: input.operationId, taskRootId: lease.taskRootId, kind: 'internal', action: input.action } })
  if (!operation || runtimeJson(operation.inputSnapshot).hash !== operation.inputHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '内部写作操作缺失或原输入损坏。')
  const envelope = z.object({ kind: z.literal('internal'), action: z.literal(input.action), parentOperationId: z.string(), input: inputSchema }).strict().parse(operation.inputSnapshot)
  const saved = envelope.input
  if (saved.novelId !== input.novelId || saved.callId !== input.callId || operation.parentOperationId !== saved.serviceAdmission.parentOperationId
    || envelope.parentOperationId !== operation.parentOperationId || operation.operationKey !== writingServiceOperationKey(operation.parentOperationId, saved.serviceAdmission.step)) {
    return runtimeError('RUNTIME_RECEIPT_INVALID', '内部写作操作的父归属、调用或步骤键不一致。')
  }
  const verified = await verifyServiceInput(tx, lease, saved, operation.action, verification)
  return { operation, ...verified }
}

export async function readAdmittedWritingServiceStep(lease: RunLeaseToken, input: ServiceIdentity, tx: RuntimeTx) {
  return readVerifiedServiceStep(lease, input, tx, serviceVerification(lease))
}

/** Historical source proof only. It never acquires a lease, admits a provider
 * request or writes a receipt; live service admission above is unchanged. */
export async function readHistoricalWritingServiceSource(tx: RuntimeTx, subject: ServiceProofSubject, input: ServiceIdentity) {
  return readVerifiedServiceStep(subject, input, tx, serviceVerification(undefined, true))
}

/** Two explicit provenances for existing compiler/review work. Normalization
 * below is the authenticated real writer's source, never a synthetic child call
 * or a second pending cursor. Historical tool work keeps its original reader. */
export async function readAdmittedReviewWork(lease: RunLeaseToken, input: { operationId: string; action: string; novelId: string; callId: string }) {
  if (!['story_compiler_prepare', 'scene_task_build', 'chapter_bridge_get', 'continuity_validate', 'quality_analyze', 'chapter_bridge_commit'].includes(input.action)) {
    return runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '业务复核入口不接受其他工具动作。')
  }
  return withRunLease(lease, async tx => {
    const operation = await tx.agentOperation.findFirst({ where: { id: input.operationId, taskRootId: lease.taskRootId, action: input.action } })
    if (!operation || runtimeJson(operation.inputSnapshot).hash !== operation.inputHash) {
      return runtimeError('RUNTIME_RECEIPT_INVALID', '业务复核工作缺少原操作或冻结输入损坏。')
    }
    if (operation.kind === 'tool') return readAdmittedToolOperation(lease, input, tx)
    const service = await readAdmittedWritingServiceStep(lease, input, tx)
    return { operation: service.operation, input: { ...service.input, normalization: service.original.normalization } }
  })
}

/** Caller has frozen business work using the original writer/source receipt.
 * Preparation is DB-only and current policy must still pass before effects. */
export async function prepareWritingServiceStep(lease: RunLeaseToken, value: unknown) {
  const saved = inputSchema.parse(value)
  return withManuscriptRunLease(lease, async tx => {
    const verified = await verifyServiceInput(tx, lease, saved, actionFor(saved.serviceAdmission.step,
      (await tx.agentOperation.findUniqueOrThrow({ where: { id: saved.serviceAdmission.parentOperationId } })).action), serviceVerification(lease))
    return prepareOperationInTransaction(tx, lease, { key: writingServiceOperationKey(verified.parent.id, saved.serviceAdmission.step),
      kind: 'internal', action: actionFor(saved.serviceAdmission.step, verified.parent.action), parentOperationId: verified.parent.id,
      input: runtimeJson(saved).value })
  })
}

/** Internal operations must enter this branch before the generic policy reader's
 * legacy no-normalization return. A parent writer grant does not grant a check. */
export async function assertWritingServicePolicy(tx: RuntimeTx, lease: RunLeaseToken, operation: { id: string; action: string; inputSnapshot: Prisma.JsonValue },
  assertParent: (tx: RuntimeTx, lease: RunLeaseToken, parent: Awaited<ReturnType<typeof readAdmittedWritingServiceStep>>['parent']) => Promise<void>) {
  const saved = z.object({ input: inputSchema }).parse(operation.inputSnapshot).input
  const verified = await readAdmittedWritingServiceStep(lease, { operationId: operation.id, action: operation.action, novelId: saved.novelId, callId: saved.callId }, tx)
  await assertParent(tx, lease, verified.parent)
  const required = await readWritingServiceConfirmations(tx, lease, verified.step.actions)
  if (required.length) {
    await (await import('./runtime-approval.js')).assertWritingServiceApproval(tx, lease, { sourceHash: verified.original.normalization.sourceSnapshotHash,
      callId: saved.callId, toolName: verified.parent.action, rawArguments: verified.original.normalization.rawArguments,
      argsHash: verified.original.normalization.normalizedArgsHash, manifest: runtimeJson(verified.manifest).value })
  }
}

/** Frozen and current ceilings apply to every real action. This read is also
 * used before the parent starts, to show any required composite confirmation. */
export async function readWritingServiceConfirmations(tx: RuntimeTx, lease: RunLeaseToken, actions: readonly string[]) {
  const current = await readExecutionStateInTransaction(tx, lease.taskRootId)
  const root = await tx.agentTaskRoot.findUniqueOrThrow({ where: { id: lease.taskRootId } })
  await tx.$queryRaw`SELECT id FROM agent_sessions WHERE id = ${root.sessionId} FOR SHARE`
  const session = await tx.agentSession.findUnique({ where: { id: root.sessionId } })
  const [{ getToolByName }, { applySessionToolPolicy }] = await Promise.all([import('./tools/registry.js'), import('./agents.js')])
  if (!session || session.userId !== lease.userId || session.novelId !== root.novelId) return runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '内部写作会话归属已变化。')
  const required: string[] = []
  for (const action of new Set(actions)) {
    const grant = current.configuration.toolAuthority.find(item => item.name === action), tool = getToolByName(action)
    if (!tool || !grant || grant.permission === 'deny' || !current.configuration.tools.some(item => item.function.name === action)) {
      return runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '原任务未授予内部写作步骤的实际工具能力。')
    }
    const effective = applySessionToolPolicy([{ ...tool, permission: { ...tool.permission, [current.configuration.mode]: grant.permission } }],
      current.configuration.mode, session.toolPolicy, session.sandboxMode === 'read_only' ? 'read_only' : 'workspace')[0]
    if (!effective || effective.permission[current.configuration.mode] === 'deny') return runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '当前会话已收紧内部写作权限。')
    if (effective.permission[current.configuration.mode] === 'ask' || grant.alwaysConfirm) required.push(action)
  }
  return required
}
