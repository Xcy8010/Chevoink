import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { taskSpecSchema } from '../../../shared/contracts/task-spec-contracts.js'
import { coordinatedWritingInputSchema, coordinatedWritingManifest, coordinatedWriterActions, writingServiceStepSchema, writingServiceManifestSchema } from './coordinated-writing-input.js'
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
const manifestSchema = writingServiceManifestSchema
export const writingServiceAdmissionSchema = z.object({ version: z.literal(1), parentOperationId: z.string().min(1), parentInputHash: hash,
  sourceRevision: z.number().int().nonnegative(), sourceSnapshotHash: hash, step: writingServiceStepSchema, chapterId: z.string().min(1),
  source: z.object({ operationId: z.string().min(1), resultHash: hash }).strict().nullable() }).strict()
const inputSchema = z.object({ novelId: z.string().min(1), callId: z.string().min(1), args: z.record(z.string(), z.unknown()),
  baseline: compilerObservationSchema.nullable(), serviceAdmission: writingServiceAdmissionSchema, work: z.unknown() }).strict()
const bodyReceiptSchema = z.object({ toolResult: z.object({ display: z.object({ kind: z.literal('chapterDiff'), chapterId: z.string(),
  revision: z.number().int().positive(), before: z.string(), after: z.string() }) }) })
export function composeWritingBodyEffects(body: Record<string, unknown>, revision?: Record<string, unknown>) {
  if (!revision || revision.revisionApplied !== true) return body
  const first = bodyReceiptSchema.parse(body).toolResult.display, last = bodyReceiptSchema.parse(revision).toolResult.display
  if (first.chapterId !== last.chapterId || first.after !== last.before || last.revision !== first.revision + 1)
    return runtimeError('RUNTIME_RECEIPT_INVALID', '写作与集中修订不是同一连续正文转换。')
  const initialTool = z.record(z.string(), z.unknown()).parse(body.toolResult), initialDisplay = z.record(z.string(), z.unknown()).parse(initialTool.display)
  return { ...body, ...(revision.memoryJobId ? { memoryJobId: revision.memoryJobId } : {}),
    progress: { kind: 'content_revision', targetId: first.chapterId, beforeHash: runtimeJson({ content: first.before }).hash,
      afterHash: runtimeJson({ content: last.after }).hash },
    toolResult: { ...initialTool, display: { ...initialDisplay, after: last.after, revision: last.revision } } }
}

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
  continuity: 'continuity_validate', quality: 'quality_analyze', prose_revision: 'chapter_edit_range',
  continuity_verify: 'continuity_validate', quality_verify: 'quality_analyze', commit: 'chapter_bridge_commit' })[step]
export const writingServiceOperationKey = (parentId: string, step: z.infer<typeof writingServiceStepSchema>) => `writing:${parentId}:${step}`

/** Recover the exact original review role from a no-provider cache. A cache
 * never substitutes today's model/rate or manufactures another paid phase. */
export async function readWritingReviewFrozenPrice(tx: RuntimeTx, subject: ServiceProofSubject & { novelId: string }, parentId: string,
  step: 'continuity' | 'quality', expectedContinuityPriceHash?: string) {
  const source = await tx.agentOperation.findUniqueOrThrow({ where: { taskRootId_operationKey: {
    taskRootId: subject.taskRootId, operationKey: writingServiceOperationKey(parentId, step) } }, include: { effectReceipt: true } })
  const proof = await readHistoricalWritingServiceSource(tx, subject, { operationId: source.id,
    action: step === 'continuity' ? 'continuity_validate' : 'quality_analyze', novelId: subject.novelId,
    callId: z.object({ input: z.object({ callId: z.string() }) }).parse(source.inputSnapshot).input.callId })
  const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const work = object(proof.input.work), routeSchema = (await import('./runtime-auxiliary-call.js')).auxiliaryRouteSchema
  const priceSchema = (await import('../billing/token-price.js')).tokenPriceSchema
  const directRoute = routeSchema.safeParse(work.route), directPrice = priceSchema.safeParse(work.price)
  if (directRoute.success && directPrice.success) {
    const value = { route: directRoute.data, price: directPrice.data }
    if (expectedContinuityPriceHash && runtimeJson(value).hash !== expectedContinuityPriceHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '首检价目与原阶段不同。')
    return value
  }
  const compilationId = object(work.compiler).id, chapterId = object(work.chapter).id
  if (typeof compilationId !== 'string' || typeof chapterId !== 'string') return runtimeError('RUNTIME_RECEIPT_INVALID', '缓存检查缺少原编译身份。')
  let operations: Array<{ inputSnapshot: Prisma.JsonValue; inputHash: string }> = []
  if (step === 'continuity') {
    if (!expectedContinuityPriceHash) {
      const revision = await tx.agentOperation.findUnique({ where: { taskRootId_operationKey: {
        taskRootId: subject.taskRootId, operationKey: writingServiceOperationKey(parentId, 'prose_revision') } } })
      const compilation = revision ? null : await tx.storyCompilation.findFirst({ where: { id: compilationId, userId: subject.userId, novelId: subject.novelId }, select: { validation: true } })
      const value = revision ? object(object(revision.inputSnapshot).input).work : object(object(compilation?.validation).continuityCriticResponse).continuityV4
      const planValue = revision ? object(value).plan : object(object(object(value).manifest).typedLineage).phasePlan
      const coordinator = await import('./continuity-coordinator.js'), plan = coordinator.continuityPhasePlanSchema.safeParse(planValue)
      if (!plan.success || !await coordinator.authenticateContinuityPhasePlan(tx, subject, plan.data)) return runtimeError('RUNTIME_RECEIPT_INVALID', '缓存没有原阶段冻结模型价目。')
      expectedContinuityPriceHash = plan.data.modelPriceHash
    }
    const original = await readOriginalTaskRequest(tx, subject), runs = await (await import('./original-request.js')).originalTaskRunIds(tx, subject, original)
    const artifacts = await tx.agentArtifact.findMany({ where: { runId: { in: runs }, artifactType: 'continuityReview' }, take: 1001 })
    if (artifacts.length > 1000) return runtimeError('RUNTIME_RECEIPT_INVALID', '缓存来源超出有界认证范围。')
    const entries = await (await import('./native-continuity-assessment.js')).readNativeContinuityAssessments(tx, subject, subject.taskRootId, runs,
      { compilationId, chapterId, currentAudit: {}, related: input => {
        const value = object(input)
        return runtimeJson({ bodies: value.bodies, candidate: value.terminalCandidate }).hash === runtimeJson({ bodies: work.sourceBodies, candidate: work.terminalCandidate }).hash
      } }, artifacts)
    if (!entries) return runtimeError('RUNTIME_RECEIPT_INVALID', '缓存连续性报告的真实原模型结果不能认证。')
    const eligible = entries.filter(entry => entry.committed && entry.inspected.complete
      && runtimeJson(entry.input.bodies).hash === runtimeJson(work.sourceBodies).hash
      && runtimeJson(entry.input.terminalCandidate).hash === runtimeJson(work.terminalCandidate).hash
      && runtimeJson(entry.coverage).hash === runtimeJson(work.coverage).hash)
    operations = eligible.length ? await tx.agentOperation.findMany({ where: { id: { in: eligible.map(entry => entry.operationId) } } }) : []
  } else {
    const cachedId = object(work.cached).id
    if (typeof cachedId !== 'string') return runtimeError('RUNTIME_RECEIPT_INVALID', '缓存质量报告缺少原报告身份。')
    const candidates = await tx.agentOperation.findMany({ where: { taskRootId: subject.taskRootId, action: 'quality_analyze', status: 'succeeded',
      inputSnapshot: { path: ['input', 'work', 'chapter', 'id'], equals: chapterId } }, include: { effectReceipt: true,
        children: { include: { attempts: { include: { usageReceipt: true } }, events: true } } }, take: 1001 })
    if (candidates.length > 1000) return runtimeError('RUNTIME_RECEIPT_INVALID', '缓存质量来源超出有界认证范围。')
    for (const candidate of candidates) {
      const saved = object(object(candidate.inputSnapshot).input), frozen = object(saved.work), result = object(candidate.effectReceipt?.result)
      if (object(object(result.toolResult).display).reportId !== cachedId || frozen.contextHash !== work.contextHash
        || !candidate.effectReceipt || runtimeJson(candidate.effectReceipt.result).hash !== candidate.effectReceipt.resultHash
        || !routeSchema.safeParse(frozen.route).success || !priceSchema.safeParse(frozen.price).success) continue
      const event = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `effect:${candidate.id}` } })
      if (!event || runtimeJson(event.payload).hash !== runtimeJson({ operationId: candidate.id, resultHash: candidate.effectReceipt.resultHash }).hash) continue
      const known = candidate.children.some(child => child.kind === 'provider' && child.status === 'succeeded' && child.attempts.length === 1
        && child.action.startsWith('quality_') && runtimeJson(object(object(child.inputSnapshot).input).billing).hash === runtimeJson(frozen.price).hash
        && child.attempts.every(attempt => attempt.status === 'succeeded' && attempt.dispatchedAt && attempt.completedAt && attempt.resultHash
          && runtimeJson(attempt.result).hash === attempt.resultHash && runtimeJson(attempt.requestSnapshot).hash === attempt.requestHash
          && attempt.usageReceipt?.source === 'reported' && attempt.usageReceipt.settlementStatus === 'settled'
          && child.events.some(row => row.type === 'provider.result.recorded' && row.eventKey === `result:${attempt.id}:${attempt.resultHash}`)))
      if (!known || typeof saved.callId !== 'string') continue
      if (candidate.kind === 'tool') await readToolOperationSource(tx, candidate)
      else await readHistoricalWritingServiceSource(tx, { ...subject, runId: candidate.originRunId },
        { operationId: candidate.id, action: 'quality_analyze', novelId: subject.novelId, callId: saved.callId })
      operations.push(candidate)
    }
  }
  const prices = operations.flatMap(row => {
    if (runtimeJson(row.inputSnapshot).hash !== row.inputHash) return []
    const frozen = object(object(row.inputSnapshot).input).work, route = routeSchema.safeParse(object(frozen).route), price = priceSchema.safeParse(object(frozen).price)
    return route.success && price.success && (!expectedContinuityPriceHash || runtimeJson({ route: route.data, price: price.data }).hash === expectedContinuityPriceHash)
      ? [{ route: route.data, price: price.data }] : []
  })
  const unique = new Map(prices.map(value => [runtimeJson(value).hash, value]))
  if (unique.size !== 1) return runtimeError('RUNTIME_RECEIPT_INVALID', '缓存没有唯一认证的原模型价目，未替换今日路由或追加请求。')
  return [...unique.values()][0]
}

/** Read-only evidence after the parent has closed. This is deliberately not
 * effect admission: a blocked review cannot hide a real saved body, and cannot
 * use arbitrary failed-result metadata to manufacture progress. */
export async function readCommittedWritingBodyProgress(tx: RuntimeTx, parent: { id: string; taskRootId: string; action: string; inputSnapshot: Prisma.JsonValue; inputHash: string }, value: unknown) {
  if (!coordinatedWriterActions.some(action => action === parent.action) || runtimeJson(parent.inputSnapshot).hash !== parent.inputHash) {
    return runtimeError('RUNTIME_RECEIPT_INVALID', '受阻写作进度缺少真实父写入。')
  }
  const completion = z.object({ writingCompletion: z.object({ version: z.literal(1), status: z.literal('blocked'),
    steps: z.array(z.object({ step: writingServiceStepSchema, operationId: z.string(), resultHash: hash }).strict()).min(2).max(7) }).strict(),
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
  const originalBody = bodyReceiptSchema.extend({ progress: z.object({ kind: z.literal('content_revision'), targetId: z.string(), beforeHash: hash, afterHash: hash }).strict() }).parse(receipt.result)
  if (originalBody.toolResult.display.revision !== original.expectedRevision + (originalBody.toolResult.display.before === originalBody.toolResult.display.after ? 0 : 1))
    return runtimeError('RUNTIME_RECEIPT_INVALID', '原写作保存回执的正文版本不一致。')
  let effectiveBody = receipt.result as Record<string, unknown>
  const declaredRevision = completion.writingCompletion.steps.find(step => step.step === 'prose_revision')
  if (manifest.version === 2 && declaredRevision) {
    const revision = await tx.agentOperation.findUnique({ where: { id: declaredRevision.operationId }, include: { effectReceipt: true } })
    if (!revision || revision.parentOperationId !== parent.id || revision.taskRootId !== parent.taskRootId
      || !revision.effectReceipt || revision.effectReceipt.resultHash !== declaredRevision.resultHash
      || runtimeJson(revision.effectReceipt.result).hash !== revision.effectReceipt.resultHash) return runtimeError('RUNTIME_RECEIPT_INVALID', '后续修订缺少同一父写入的真实回执。')
    if (revision.status === 'succeeded') {
      await readHistoricalWritingServiceSource(tx, { userId: root.userId, runId: revision.originRunId, taskRootId: parent.taskRootId },
        { operationId: revision.id, action: 'chapter_edit_range', novelId: root.novelId, callId: original.callId })
      effectiveBody = composeWritingBodyEffects(effectiveBody, revision.effectReceipt.result as Record<string, unknown>)
    }
  }
  const saved = bodyReceiptSchema.extend({ progress: z.object({ kind: z.literal('content_revision'), targetId: z.string(), beforeHash: hash, afterHash: hash }).strict() }).parse(effectiveBody)
  const display = saved.toolResult.display
  if (display.chapterId !== chapterId || saved.progress.targetId !== chapterId
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
  if (!await hasCommittedServiceReceipt(tx, lease, input.operationId)) return runtimeError('RUNTIME_RECEIPT_INVALID', '前置步骤没有匹配的实际提交回执与持久事件。')
  await readVerifiedServiceStep(lease, input, tx, { ...verification, historical: true })
  verification.proven.add(key)
}

async function hasCommittedServiceReceipt(tx: RuntimeTx, subject: ServiceProofSubject, operationId: string) {
  const row = await tx.agentOperation.findFirst({ where: { id: operationId, taskRootId: subject.taskRootId, kind: 'internal', status: 'succeeded' }, include: { effectReceipt: true } })
  if (!row?.effectReceipt || runtimeJson(row.inputSnapshot).hash !== row.inputHash
    || runtimeJson(row.effectReceipt.result).hash !== row.effectReceipt.resultHash) return false
  const event = await tx.agentExecutionOutbox.findUnique({ where: { eventKey: `effect:${row.id}` } })
  return !!event && event.taskRootId === subject.taskRootId && event.operationId === row.id && event.type === 'effect.committed'
    && runtimeJson(event.payload).hash === runtimeJson({ operationId: row.id, resultHash: row.effectReceipt.resultHash }).hash
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
    expectedArgs = admission.step === 'continuity' || admission.step === 'continuity_verify' ? { compilationId: expectedBaseline.id, terminalState: writing.actualOutcomes }
      : admission.step === 'quality' || admission.step === 'quality_verify' ? { compilationId: expectedBaseline.id }
        : admission.step === 'prose_revision' ? { chapterId }
        : { compilationId: expectedBaseline.id, ...Object.fromEntries(Object.entries(writing).filter(([key]) =>
          ['chapterSummary', 'hookDecision', 'delayedHookReason', 'openingStructure', 'endingStructure'].includes(key))),
          ...(original.args.retainedFindings !== undefined ? { retainedFindings: original.args.retainedFindings } : {}) }
    if (admission.step === 'prose_revision') {
      if (manifest.version !== 2) return runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '旧写作清单没有集中修订阶段。')
      const coordinator = await import('./continuity-coordinator.js')
      const work = await coordinator.authenticateNativeContinuityRevisionWork(tx,
        { userId: lease.userId, novelId: saved.novelId, runId: lease.runId }, saved.work, verification.historical)
      if (runtimeJson(work.compiler).hash !== runtimeJson(expectedBaseline).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '集中修订没有同一前置编译回执。')
      if (work.kind === 'merged_revision') {
        const role = await readWritingReviewFrozenPrice(tx, { ...lease, novelId: saved.novelId }, parent.id, 'continuity', work.plan.modelPriceHash)
        if (runtimeJson(role).hash !== runtimeJson({ route: work.route, price: work.price }).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '集中修订不能替换首检模型价目。')
      }
      if (work.kind === 'merged_revision' && previous === 'quality'
        && work.input.qualityReportId !== z.object({ toolResult: z.object({ display: z.object({ reportId: z.string() }) }) }).parse(receipt.result).toolResult.display.reportId)
        return runtimeError('RUNTIME_RECEIPT_INVALID', '集中修订不能替换原质量报告。')
    }
    if (['continuity', 'quality', 'continuity_verify', 'quality_verify'].includes(admission.step)) {
      const body = previous === 'body' ? source : await tx.agentOperation.findUnique({ where: { taskRootId_operationKey: {
        taskRootId: lease.taskRootId, operationKey: writingServiceOperationKey(parent.id, 'body') } }, include: { effectReceipt: true } })
      if (!body || body.status !== 'succeeded' || !body.effectReceipt
        || runtimeJson(body.effectReceipt.result).hash !== body.effectReceipt.resultHash) {
        return runtimeError('RUNTIME_RECEIPT_INVALID', '独立复核缺少同一写入的正文回执。')
      }
      if (previous !== 'body') await verifyPredecessor(tx, lease, { operationId: body.id, action: parent.action,
        novelId: saved.novelId, callId: saved.callId }, verification)
      let display = bodyReceiptSchema.parse(body.effectReceipt.result).toolResult.display
      if (admission.step === 'continuity_verify' || admission.step === 'quality_verify') {
        if (manifest.version !== 2) return runtimeError('RUNTIME_EFFECT_NOT_AUTHORIZED', '旧写作清单没有新版复核阶段。')
        const revision = await tx.agentOperation.findUnique({ where: { taskRootId_operationKey: { taskRootId: lease.taskRootId,
          operationKey: writingServiceOperationKey(parent.id, 'prose_revision') } }, include: { effectReceipt: true } })
        if (!revision?.effectReceipt || revision.status !== 'succeeded') return runtimeError('RUNTIME_RECEIPT_INVALID', '新版复核缺少原集中修订阶段回执。')
        await verifyPredecessor(tx, lease, { operationId: revision.id, action: 'chapter_edit_range', novelId: saved.novelId, callId: saved.callId }, verification)
        const effect = z.object({ revisionApplied: z.boolean() }).parse(revision.effectReceipt.result)
        if (!effect.revisionApplied) {
          const skip = z.object({ kind: z.literal('verification_skip'), version: z.literal(1), compiler: compilerObservationSchema }).strict().parse(saved.work)
          if (runtimeJson(skip.compiler).hash !== runtimeJson(expectedBaseline).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '跳过复核不能替换当前编译回执。')
        } else display = bodyReceiptSchema.parse(revision.effectReceipt.result).toolResult.display
        if (!effect.revisionApplied) {
          if (runtimeJson(saved.args).hash !== runtimeJson(expectedArgs).hash || runtimeJson(saved.baseline).hash !== runtimeJson(expectedBaseline).hash)
            return runtimeError('RUNTIME_RECEIPT_INVALID', '未改稿的无请求阶段参数不匹配。')
          return { parent, original, manifest, step: manifest.steps[index], input: saved }
        }
        const role = await readWritingReviewFrozenPrice(tx, { ...lease, novelId: saved.novelId }, parent.id,
          admission.step === 'continuity_verify' ? 'continuity' : 'quality')
        const workRole = z.object({ route: z.unknown(), price: z.unknown() }).parse(saved.work)
        if (runtimeJson(role).hash !== runtimeJson(workRole).hash) return runtimeError('RUNTIME_RECEIPT_INVALID', '新版复检不能替换首检角色路由与价目。')
      }
      if (display.chapterId !== chapterId) return runtimeError('RUNTIME_RECEIPT_INVALID', '正文回执目标与原写入不一致。')
      assertWritingReviewWork(saved.work, { step: admission.step === 'continuity' || admission.step === 'continuity_verify' ? 'continuity' : 'quality', baseline: expectedBaseline, chapterId,
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
  return readVerifiedServiceStep(lease, input, tx, await hasCommittedServiceReceipt(tx, lease, input.operationId)
    ? serviceVerification(undefined, true) : serviceVerification(lease))
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
    const action = actionFor(saved.serviceAdmission.step,
      (await tx.agentOperation.findUniqueOrThrow({ where: { id: saved.serviceAdmission.parentOperationId } })).action)
    const existing = await tx.agentOperation.findUnique({ where: { taskRootId_operationKey: { taskRootId: lease.taskRootId,
      operationKey: writingServiceOperationKey(saved.serviceAdmission.parentOperationId, saved.serviceAdmission.step) } } })
    if (existing && await hasCommittedServiceReceipt(tx, lease, existing.id)) {
      const expected = runtimeJson({ kind: 'internal', action, parentOperationId: saved.serviceAdmission.parentOperationId, input: saved })
      if (existing.inputHash !== expected.hash || runtimeJson(existing.inputSnapshot).hash !== expected.hash)
        return runtimeError('RUNTIME_IDENTITY_CONFLICT', '已提交写作阶段不能替换原冻结输入。')
      await readHistoricalWritingServiceSource(tx, lease, { operationId: existing.id, action, novelId: saved.novelId, callId: saved.callId })
      return existing
    }
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
