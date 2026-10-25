import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { DataAccessError } from '../prisma.js'
import { runtimeJson, durableChatResultSchema } from './runtime-common.js'
import { readOriginalTaskRequest, originalTaskRunIds, originalRepairAuthority } from './original-request.js'
import { originalChapterReviewRequirements } from './chapter-review-requirements.js'
import { env } from '../../config/env.js'
import { tokenPriceSchema, frozenTokenPriceMatchesModel, type TokenPrice } from '../billing/token-price.js'
import type { LegacyAssessmentInput } from './assessment-response-lifecycle.js'
import type { ToolContext } from './tools/types.js'

const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const compilerReferenceSchema = z.object({ id: z.string().min(1), hash }).strict()
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
// Prisma Date values cross the same JSON boundary used by existing durable
// review receipts. runtimeJson remains strict about plain JSON everywhere.
export const continuityUsageRowHash = (value: unknown) => runtimeJson(JSON.parse(JSON.stringify(value))).hash
type Subject = { userId: string; novelId: string; runId: string; signal?: AbortSignal; continuityOwnerSeq?: number;
  continuityNativeLease?: import('./runtime-lease.js').RunLeaseToken }
export const continuityQuestionOwner = (subject: Subject) => ({ userId: subject.userId, novelId: subject.novelId,
  runId: subject.runId, ownerSeq: z.number().int().nonnegative().parse(subject.continuityOwnerSeq) })
export const continuityPhasePlanSchema = z.object({ version: z.literal(1), originalTaskId: z.string().min(1),
  chapterId: z.string().min(1), compilationId: z.string().min(1),
  originalAdmissionId: z.string().min(1), authorityHash: hash, semanticSubjectHash: hash, modelPriceHash: hash,
  revisionAuthority: z.object({ source: z.enum(['original_repair', 'original_new_draft']), sourceHash: hash, cycleHash: hash }).strict().optional(),
  supplementalSourceKey: hash.optional(),
  budgetOwner: z.string().min(1), phases: z.array(z.object({ kind: z.enum(['initial_review', 'sparse_repair', 'prose_revision', 'reverify', 'full_reassessment']),
    limit: z.number().int().min(0).max(1), authoritySourceRef: z.string().min(1) }).strict()).max(5), hash }).strict()
export type ContinuityPhasePlan = z.infer<typeof continuityPhasePlanSchema>
const blocked = (message: string) => new DataAccessError(409, 'CONTINUITY_PHASE_AUTHORITY_REQUIRED', message)
/** A prepared plan or an old manuscript is not this task's saved body. This
 * reads the existing writer checkpoint; it grants no review phase or fee. */
export async function hasCurrentWritingBodyCheckpoint(db: Prisma.TransactionClient, subject: Subject,
  target: { compilationId: string; chapterId: string; revision: number }) {
  const saved = await db.storyCompilation.findFirst({ where: { id: target.compilationId, userId: subject.userId,
    novelId: subject.novelId, chapterId: target.chapterId, status: 'active' },
    include: { bridge: true, chapter: true, sceneTasks: true } })
  const current = !!saved?.chapter && saved.chapter.authorId === subject.userId && saved.chapter.novelId === subject.novelId
    && saved.chapter.revision === target.revision && !!saved.chapter.content.trim()
    && ['write', 'check', 'repair'].includes(saved.stage) && saved.bridge?.toChapterId === target.chapterId
    && saved.bridge.targetRevision === target.revision && !saved.bridge.committedAt
    && saved.sceneTasks.length > 0 && saved.sceneTasks.length <= 4
    && saved.sceneTasks.every(row => row.chapterId === target.chapterId && row.status === 'writing')
  if (!current || !saved?.runId) return false
  const original = await readOriginalTaskRequest(db, subject), runs = await originalTaskRunIds(db, subject, original)
  await (await import('./writing-scope.js')).assertWritingTarget(db, subject, { chapterId: target.chapterId })
  return runs.includes(saved.runId)
}

/** Complete cached bytes may be applied before buying a main selection turn.
 * This is an exact current-input proof, never permission for another request. */
export async function readKnownContinuityReplay(db: Prisma.TransactionClient, subject: Subject, compilationId: string) {
  const saved = await db.storyCompilation.findFirst({ where: { id: compilationId, userId: subject.userId, novelId: subject.novelId,
    status: 'active' }, include: { chapter: true, bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } } } })
  if (!saved?.chapter || !saved.bridge || !saved.runId || object(saved.validation).independentCheck !== 'unavailable'
    || object(saved.validation).checkedRevision !== saved.chapter.revision) return null
  const validation = object(saved.validation), audit = object(validation.continuityCriticResponse), raw = object(audit.rawResponse)
  // A stale effective pointer is never an invitation to choose an older report.
  if (Object.prototype.hasOwnProperty.call(validation, 'effectiveReport') || typeof audit.contentHash !== 'string' || typeof raw.content !== 'string') return null
  const currentKey = object(audit.assessmentRequest).key
  const eligible = new Map<string, { assessmentKey: string; inputHash: string }>()
  const original = await readOriginalTaskRequest(db, subject), runs = await originalTaskRunIds(db, subject, original)
  if (!runs.includes(saved.runId)) return null
  await (await import('./writing-scope.js')).assertWritingTarget(db, subject, { chapterId: saved.chapter.id })
  const candidate = (await import('./terminal-candidate-contract.js')).terminalCandidateSchema.safeParse(object(saved.validation).terminalCandidate)
  if (!candidate.success) return null
  const lifecycle = await import('./assessment-response-lifecycle.js')
  const rows = await db.agentArtifact.findMany({ where: { runId: { in: runs }, artifactType: 'continuityReview',
    metadata: { path: ['assessmentChapterId'], equals: saved.chapter.id } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1001 })
  if (rows.length > 1000) return null
  const protocol = object(object(saved.validation).coverage).protocolVersion
  if (protocol !== 10 && protocol !== 11) return null
  const source = await (await import('./compiler-continuity-source.js')).readCompilerContinuitySource(db, subject,
    saved.chapter, saved.bridge.fromChapterId, protocol)
  const scope = (await import('./continuity-source-authority.js')).compilerEvidenceScope(saved.chapter, source)
  for (const row of rows) {
    const metadata = object(row.metadata), parsed = lifecycle.legacyAssessmentInputSchema.safeParse(metadata.input)
    if (!parsed.success || typeof metadata.callId !== 'string'
      || currentKey !== undefined && currentKey !== metadata.continuityAssessmentRequestKey) continue
    const input = parsed.data, context = input.bodies.terminalEvidence
    if (!context || !input.terminalCandidate || !input.sourceScope || input.targetType !== 'story_compilation' || input.targetId !== compilationId
      || input.chapterId !== saved.chapter.id || input.revision !== saved.chapter.revision
      || input.bodies.current !== saved.chapter.content || input.bodies.previous !== (source?.content ?? null)
      || runtimeJson({ candidate: input.terminalCandidate }).hash !== runtimeJson({ candidate: candidate.data }).hash
      || runtimeJson(input.sourceScope).hash !== runtimeJson(scope).hash) continue
    const evidence = await import('./terminal-evidence-context.js'), coverage = await import('./terminal-fact-coverage.js')
    let current = evidence.terminalEvidenceContext(saved.chapter, source, protocol === 11 ? 2 : 1,
      evidence.terminalQuoteAddressVersion(original.spec), coverage.terminalCoverageInput(original.spec, saved.preparedContext,
        saved.chapter, candidate.data, context.factCoverage?.version, coverage.terminalCoverageProofs(source, context.spanAddressProtocol)),
      context.verdictProtocol, context.spanAddressProtocol)
    const proposals = await import('./terminal-proposal-context.js')
    current = proposals.attachTerminalProposalInput(current,
      { taskId: proposals.terminalProposalTaskId(original.spec, original.taskId), preparedContext: saved.preparedContext, validation: saved.validation, candidate: candidate.data })
    if (runtimeJson(current).hash !== runtimeJson(context).hash) continue
    const currentCoverage = (await import('./compiler-continuity-contract.js')).compilerContinuityCoverage({ chapter: saved.chapter,
      bridge: saved.bridge, sceneTasks: saved.sceneTasks, source, terminalCandidate: candidate.data,
      focus: String(object(saved.validation).reviewFocus ?? '') || undefined }, protocol)
    if (input.bindingHash !== runtimeJson(currentCoverage).hash) continue
    const received = await lifecycle.readReusableLegacyContinuityAssessment(db, { ...subject, callId: 'known-result-probe' } as ToolContext, input)
    const binding = object(object(received?.audit).assessmentRequest)
    const projection = object(object(received?.audit).formatProjection)
    let observedAudit = object(received?.audit)
    if (projection.kind === 'empty_optional_proposal_table') {
      // This authenticated format projection has a different rendered hash.
      // Bind the current failed report to its retained physical response, not
      // to the projected view or an arbitrary historical good fragment.
      if (!(await import('./continuity-empty-proposal-projection.js')).validEmptyOptionalProposalProjection(
        received?.audit, input.bodies.current, context)) continue
      observedAudit = object(projection.original)
    }
    if (received?.complete && observedAudit.contentHash === audit.contentHash
      && runtimeJson(observedAudit.rawResponse).hash === runtimeJson(raw).hash
      && binding.key === metadata.continuityAssessmentRequestKey && binding.inputHash === runtimeJson(input).hash)
      eligible.set(String(binding.key), { assessmentKey: String(binding.key), inputHash: String(binding.inputHash) })
  }
  return eligible.size === 1 ? [...eligible.values()][0] : null
}
export async function assertContinuityOwner(db: Prisma.TransactionClient, subject: Subject) {
  subject.signal?.throwIfAborted()
  if (subject.continuityNativeLease) {
    const lease = subject.continuityNativeLease
    if (lease.userId !== subject.userId || lease.runId !== subject.runId) throw blocked('连续性阶段不属于本 native 执行。')
    // Preserve native goal -> run/root lock order. Every native caller also
    // retains the outer lease transaction through its actual phase/effect.
    return (await import('./runtime-lease.js')).withRunLeaseInTransaction(db, lease, async tx => {
      const run = await tx.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId,
        taskRootId: lease.taskRootId, runtimeProtocolVersion: 1, status: { in: ['queued', 'running'] } }, select: { usage: true } })
      if (!run || object(run.usage).authorEnded !== undefined) throw blocked('当前 native 执行已停止或作者已结束，未应用迟到结果。')
    })
  }
  await db.$queryRaw`SELECT id FROM agent_runs WHERE id = ${subject.runId} FOR UPDATE`
  const run = await db.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId,
    taskRootId: null, runtimeProtocolVersion: 0, status: 'running' }, select: { id: true, taskRootId: true, usage: true } })
  if (!run || object(run.usage).authorEnded !== undefined) throw blocked('当前执行已停止或作者已结束，未应用迟到连续性结果。')
  const owner = await db.agentRunEvent.findFirst({ where: { runId: subject.runId, type: 'run.started' }, orderBy: { seq: 'desc' }, select: { seq: true } })
  if (subject.continuityOwnerSeq === undefined || owner?.seq !== subject.continuityOwnerSeq)
    throw blocked('原连续性执行 owner 已变化；保留已知费用与原始响应，未应用旧 owner 结果。')
}
export const continuityModelPriceHash = (model: { tier: string; provider: string; modelName: string | null; multiplierBps: number }, price: unknown) =>
  runtimeJson({ modelTier: model.tier, provider: model.provider, model: model.modelName, multiplierBps: model.multiplierBps, price }).hash

export async function authenticateContinuityPhasePlan(db: Prisma.TransactionClient, subject: Subject, plan: ContinuityPhasePlan) {
  const original = await readOriginalTaskRequest(db, subject)
  if (plan.supplementalSourceKey) {
    const phase = plan.phases.length === 1 ? plan.phases[0] : null
    const requestId = phase?.authoritySourceRef.replace(/^continuity-question:/u, '')
    const consent = requestId ? await readContinuitySupplementConsent(db, subject, requestId) : null
    return !!consent && original.taskId === plan.originalTaskId && original.sourceRunId === plan.originalAdmissionId
      && plan.authorityHash === runtimeJson({ spec: original.spec, prompt: original.prompt }).hash
      && phase?.kind === 'full_reassessment' && phase.limit === 1
      && runtimeJson(consent.frozen.input.continuityManifest?.typedLineage?.phasePlan).hash === runtimeJson(plan).hash
  }
  let revisionAuthority = false
  if (plan.revisionAuthority) {
    const chapter = await db.chapter.findFirst({ where: { id: plan.chapterId, authorId: subject.userId, novelId: subject.novelId }, select: { id: true, orderIndex: true } })
    const authority = plan.revisionAuthority.source === 'original_repair' ? originalRepairAuthority(original) ? { taskId: original.taskId } : null
      : chapter ? await (await import('./writing-scope.js')).readNewDraftWritingAuthority(db, subject, chapter) : null
    revisionAuthority = !!authority && plan.revisionAuthority.sourceHash === runtimeJson({ source: plan.revisionAuthority.source,
      taskId: original.taskId, sourceRunId: original.sourceRunId, chapterId: plan.chapterId, authority }).hash
  }
  return validContinuityPhasePlan(plan) && original.taskId === plan.originalTaskId && original.sourceRunId === plan.originalAdmissionId
    && plan.budgetOwner === original.taskId && plan.authorityHash === runtimeJson({ spec: original.spec, prompt: original.prompt }).hash
    && originalChapterReviewRequirements(original).continuity && plan.phases.every(phase => phase.limit === 0
      || ['initial_review', 'sparse_repair'].includes(phase.kind) && phase.authoritySourceRef === `original-admission:${original.sourceRunId}`
      || ['prose_revision', 'reverify'].includes(phase.kind) && revisionAuthority
        && phase.authoritySourceRef === `original-revision:${original.sourceRunId}:${plan.revisionAuthority!.sourceHash}`)
}

/** An upper bound is frozen from the original admission; it is not a wallet
 * reservation. Historical requests never acquire a new phase by upgrading wire
 * format, changing a candidate, continuing, or restarting a worker. */
export async function prepareContinuityPhasePlan(db: Prisma.TransactionClient, subject: Subject,
  target: { compilationId: string; chapterId: string; semanticSubjectHash: string; modelPriceHash: string }) {
  subject.signal?.throwIfAborted()
  const original = await readOriginalTaskRequest(db, subject), runs = await originalTaskRunIds(db, subject, original)
  await (await import('./writing-scope.js')).assertWritingTarget(db, subject, { chapterId: target.chapterId })
  const prior = await db.agentArtifact.findMany({ where: { runId: { in: runs }, artifactType: 'continuityReview',
    metadata: { path: ['assessmentChapterId'], equals: target.chapterId } }, take: 1001 })
  if (prior.length > 1000) throw blocked('原连续性阶段无法完整认证，未增加检查额度。')
  const native = await db.agentOperation.count({ where: { taskRootId: original.taskId, action: 'continuity_validate',
    inputSnapshot: { path: ['input', 'work', 'chapter', 'id'], equals: target.chapterId }, children: { some: { action: 'continuity_critic' } } } })
  // Existing reservations keep their own first/second allowance and receipt.
  // This adapter is deliberately unable to convert them into a fresh plan.
  if (prior.some(row => typeof object(row.metadata).continuityAssessmentRequestKey === 'string') || native)
    throw blocked('原检查阶段已使用；现有记录没有新的独立判断授权。已保留原报告、费用和持续义务，继续不会新增主模型或审阅请求。')
  if (!originalChapterReviewRequirements(original).continuity) throw blocked('原任务没有自动连续性检查授权。')
  const compilation = await db.storyCompilation.findFirst({ where: { id: target.compilationId, chapterId: target.chapterId,
    userId: subject.userId, novelId: subject.novelId, runId: { in: runs } }, include: { chapter: true } })
  if (!compilation?.chapter) throw blocked('原自动检查没有当前写作编译与正文绑定。')
  const cycle = (await import('./review-cycle.js')).readReviewCycle(compilation.preparedContext,
    { taskId: original.taskId, userId: subject.userId, novelId: subject.novelId, chapterId: target.chapterId })
  const sourceKind = originalRepairAuthority(original) ? 'original_repair' as const : 'original_new_draft' as const
  const revisionSource = sourceKind === 'original_repair' ? { taskId: original.taskId }
    : await (await import('./writing-scope.js')).readNewDraftWritingAuthority(db, subject, compilation.chapter)
  const reachability = revisionSource ? await (await import('./chapter-review-guard.js')).probeChapterReviewRevision(db, subject, compilation.chapter) : null
  // RECHECK_REQUIRED is a temporary prerequisite, checked by the existing
  // guard only after consumed new-draft/quality repair receipts are excluded.
  // This freezes an upper bound; actual dispatch still requires an open probe.
  const remainingRevision = !!revisionSource && (reachability?.open === true || reachability?.code === 'REVIEW_REPAIR_RECHECK_REQUIRED') && !cycle?.transitions.length
    && !cycle?.verificationStarted && !cycle?.attemptedBaselineRefs?.length
  const revisionAuthority = remainingRevision ? { source: sourceKind,
    sourceHash: runtimeJson({ source: sourceKind, taskId: original.taskId, sourceRunId: original.sourceRunId, chapterId: target.chapterId, authority: revisionSource }).hash,
    cycleHash: runtimeJson({ cycle }).hash } : undefined
  const source = `original-admission:${original.sourceRunId}`
  const value = { version: 1 as const, originalTaskId: original.taskId, originalAdmissionId: original.sourceRunId,
    chapterId: target.chapterId, compilationId: target.compilationId, ...(revisionAuthority ? { revisionAuthority } : {}),
    authorityHash: runtimeJson({ spec: original.spec, prompt: original.prompt }).hash, semanticSubjectHash: target.semanticSubjectHash,
    modelPriceHash: target.modelPriceHash, budgetOwner: original.taskId,
    phases: [{ kind: 'initial_review' as const, limit: 1, authoritySourceRef: source },
      { kind: 'sparse_repair' as const, limit: 1, authoritySourceRef: source },
      ...(revisionAuthority ? [{ kind: 'prose_revision' as const, limit: 1, authoritySourceRef: `original-revision:${original.sourceRunId}:${revisionAuthority.sourceHash}` },
        { kind: 'reverify' as const, limit: 1, authoritySourceRef: `original-revision:${original.sourceRunId}:${revisionAuthority.sourceHash}` }] : [])] }
  return continuityPhasePlanSchema.parse({ ...value, hash: runtimeJson(value).hash })
}

export function validContinuityPhasePlan(value: unknown) {
  const parsed = continuityPhasePlanSchema.safeParse(value)
  if (!parsed.success) return false
  const { hash: digest, ...body } = parsed.data
  return runtimeJson(body).hash === digest && new Set(body.phases.map(phase => phase.kind)).size === body.phases.length
}

/** Only an actual original-cycle body CAS opens verification. Changing a
 * candidate, focus, call id, protocol or compilation cannot create this proof. */
export async function readContinuityRevisionReceipt(db: Prisma.TransactionClient, subject: Subject, plan: ContinuityPhasePlan) {
  if (!await authenticateContinuityPhasePlan(db, subject, plan) || plan.supplementalSourceKey
    || plan.phases.find(phase => phase.kind === 'reverify')?.limit !== 1) return null
  const saved = await db.storyCompilation.findFirst({ where: { id: plan.compilationId, chapterId: plan.chapterId,
    userId: subject.userId, novelId: subject.novelId }, include: { chapter: true } })
  if (!saved?.chapter) return null
  const cycle = (await import('./review-cycle.js')).readReviewCycle(saved.preparedContext,
    { taskId: plan.originalTaskId, userId: subject.userId, novelId: subject.novelId, chapterId: plan.chapterId })
  if (!cycle?.baseline || cycle.transitions.length !== 1 || !cycle.transitions[0].contiguous
    || cycle.baseline.compilationId !== plan.compilationId) return null
  const step = cycle.transitions[0], current = saved.chapter
  if (step.before.revision !== cycle.baseline.body.revision || step.before.contentHash !== cycle.baseline.body.contentHash
    || step.after.revision !== current.revision || step.after.contentHash !== runtimeJson({ content: current.content }).hash) return null
  const receipt = { version: 1, taskId: plan.originalTaskId, compilationId: plan.compilationId, chapterId: plan.chapterId,
    baseline: cycle.baseline, transition: step }
  return { hash: runtimeJson(receipt).hash, value: receipt }
}

/** Frozen legacy readers stay unchanged. A later *dispatch*, however, needs
 * an actual unconsumed original-cycle transition, not a different candidate. */
export async function claimLegacyContinuityVerification(db: Prisma.TransactionClient, ctx: ToolContext, input: LegacyAssessmentInput,
  prior: Array<{ runId: string; metadata: unknown }>, operationRef: string) {
  if (input.parserVersion === 10) return
  const known: LegacyAssessmentInput[] = []
  for (const row of prior) {
    const metadata = object(row.metadata)
    if (typeof metadata.continuityAssessmentRequestKey !== 'string') continue
    const old = (await import('./assessment-response-lifecycle.js')).legacyAssessmentInputSchema.safeParse(metadata.input)
    if (!old.success || typeof metadata.callId !== 'string') throw blocked('原检查预约不能认证。')
    const source = { ...ctx, runId: row.runId, callId: metadata.callId }
    try {
      const result = await (await import('./assessment-response-lifecycle.js')).readLegacyContinuityAssessment(db, source, old.data)
      if (await confirmedLegacySecondNotDispatched(db, source, old.data, result.inspected.audit)) {
        const subject = (value: LegacyAssessmentInput) => ({ chapterId: value.chapterId, revision: value.revision, bodies: value.bodies,
          terminalCandidate: value.terminalCandidate ?? null, targetType: value.targetType, targetId: value.targetId, sourceScope: value.sourceScope ?? null })
        if (runtimeJson(subject(old.data)).hash !== runtimeJson(subject(input)).hash)
          throw blocked('原第二阶段已确认未发送，但当前正文、候选或来源与原预约不同；原许可、首份原始报告和费用保留，未改选新输入或重买首轮检查。')
        throw blocked('原第二阶段已确认未发送，原许可、首份原始报告和费用均保留；但原不可变记录缺少实际端点、思考编码和上下文配置，不能安全重建冻结执行配置，也未重买首轮检查。')
      }
      if (!result.billingKnown || !result.providerComplete || !result.recoveryReady) throw blocked('原检查仍有未决响应或费用。')
      known.push(old.data)
    } catch (error) {
      if (!(error instanceof DataAccessError) || error.code !== 'RUNTIME_RECONCILIATION_REQUIRED') throw error
      const unsent = await db.agentArtifact.findFirst({ where: { runId: row.runId, artifactType: 'continuityReview',
        metadata: { path: ['firstAssessmentNotDispatchedKey'], equals: metadata.continuityAssessmentRequestKey } } })
      if (!unsent) throw error
      const fees = await db.aiUsageLog.findMany({ where: { userId: ctx.userId, novelId: ctx.novelId, agentRunId: row.runId,
        chapterId: input.chapterId, action: { startsWith: 'agent3ContinuityCritic' } } })
      const billing = await import('./text-request-billing.js')
      if (fees.some(fee => !billing.isKnownRejectedTextRequestAttempt(fee)
        && !(fee.billingStatus === 'not_dispatched' && fee.creditChargeMilli === 0 && billing.isKnownTextRequestBilling(fee))))
        throw blocked('未派发证明仍有其他实际请求，不能恢复。')
    }
  }
  // Legacy execution can follow an original native receipt. Its absence from
  // the legacy reservation table is not a new independent-review grant.
  await claimNativeContinuityVerification(db, ctx, input, operationRef)
  if (!known.length) return // A proved-unsent original phase remains unsent.
  await claimOriginalCycleVerification(db, ctx, input, known, operationRef)
}

async function confirmedLegacySecondNotDispatched(db: Prisma.TransactionClient, ctx: ToolContext,
  input: LegacyAssessmentInput, originalAudit: unknown) {
  const lifecycle = await import('./assessment-response-lifecycle.js'), billing = await import('./text-request-billing.js')
  const key = lifecycle.legacyContinuityAssessmentKey(ctx, input)
  const claims = await db.agentArtifact.findMany({ where: { runId: ctx.runId, artifactType: 'continuityReview',
    metadata: { path: ['fullReassessmentKey'], equals: key } } })
  const markers = await db.agentArtifact.findMany({ where: { runId: ctx.runId, artifactType: 'continuityReview',
    metadata: { path: ['fullReassessmentNotDispatchedKey'], equals: key } } })
  if (claims.length !== 1 || markers.length !== 1) return false
  const claim = object(claims[0].metadata), marker = object(markers[0].metadata)
  if (claim.version !== 1 || marker.version !== 1 || claim.callId !== ctx.callId || marker.callId !== ctx.callId
    || marker.claimId !== claims[0].id || marker.outcome !== 'guard_failed_before_dispatch'
    || !claim.input || !claim.original || !claim.request
    || runtimeJson(claim.input).hash !== runtimeJson(input).hash || runtimeJson(claim.original).hash !== runtimeJson(originalAudit).hash
    || !Array.isArray(claim.usageIds) || !Array.isArray(marker.usageIds)) return false
  const firstIds = claim.usageIds
  if (firstIds.some(id => typeof id !== 'string') || new Set(firstIds).size !== firstIds.length) return false
  const firstFees = await db.aiUsageLog.findMany({ where: { id: { in: firstIds as string[] }, userId: ctx.userId, novelId: ctx.novelId,
    agentRunId: ctx.runId, targetType: input.targetType, targetId: input.targetId, action: 'agent3ContinuityCritic' } })
  if (firstFees.length !== firstIds.length || firstFees.some(fee => !billing.isKnownTextRequestBilling(fee))
    || firstFees.filter(fee => !billing.isKnownRejectedTextRequestAttempt(fee)).length !== 1) return false
  const raw = object(object(originalAudit).rawResponse)
  if (raw.complete !== true || raw.encoding !== 'json-string' || typeof raw.content !== 'string') return false
  let text: unknown
  try { text = JSON.parse(raw.content) } catch { return false }
  if (typeof text !== 'string') return false
  const original = (await import('./authenticated-continuity-assessment.js')).inspectAuthenticatedContinuityAssessment(text, input, true)
  if (runtimeJson(original.audit).hash !== runtimeJson(originalAudit).hash) return false
  if (runtimeJson(claim.request).hash !== runtimeJson(lifecycle.continuityReassessmentRequest(input.system, input.content, original,
    input.bodies, false, input.reassessmentProtocol)).hash) return false
  const links = await db.agentArtifact.findMany({ where: { runId: ctx.runId, artifactType: 'continuityReview', AND: [
    { metadata: { path: ['assessmentRequestOwnerKey'], equals: key } }, { metadata: { path: ['stage'], equals: 'reassessment' } }] } })
  const linkedIds = links.flatMap(row => { const value = object(row.metadata); return value.version === 1 && value.callId === ctx.callId
    && Array.isArray(value.usageIds) ? value.usageIds : [null] })
  if (linkedIds.some(id => typeof id !== 'string') || new Set(linkedIds).size !== linkedIds.length
    || new Set(marker.usageIds).size !== marker.usageIds.length
    || runtimeJson([...linkedIds].sort()).hash !== runtimeJson([...marker.usageIds].sort()).hash) return false
  const fees = await db.aiUsageLog.findMany({ where: { userId: ctx.userId, novelId: ctx.novelId, agentRunId: ctx.runId,
    chapterId: input.chapterId, targetType: input.targetType, targetId: input.targetId,
    action: 'agent3ContinuityCriticSecondPass', createdAt: { gte: claims[0].createdAt } } })
  const secondIds = marker.usageIds
  return fees.length === secondIds.length && fees.every(fee => secondIds.includes(fee.id)
    && fee.billingStatus === 'not_dispatched' && fee.creditChargeMilli === 0 && billing.isKnownTextRequestBilling(fee))
}

export async function claimNativeContinuityVerification(db: Prisma.TransactionClient, ctx: ToolContext, input: LegacyAssessmentInput, operationRef: string) {
  const original = await readOriginalTaskRequest(db, ctx), runs = await originalTaskRunIds(db, ctx, original)
  const count = await db.agentOperation.count({ where: { taskRootId: original.taskId, action: 'continuity_validate',
    inputSnapshot: { path: ['input', 'work', 'chapter', 'id'], equals: input.chapterId }, children: { some: { action: 'continuity_critic' } } } })
  if (!count) return
  const artifacts = await db.agentArtifact.findMany({ where: { runId: { in: runs }, artifactType: 'continuityReview' }, take: 1001 })
  if (artifacts.length > 1000) throw blocked('原连续性记录超出有界认证范围。')
  const entries = await (await import('./native-continuity-assessment.js')).readNativeContinuityAssessments(db, ctx, original.taskId, runs,
    { compilationId: input.targetId, chapterId: input.chapterId, currentAudit: {}, related: () => true }, artifacts)
  if (!entries || !entries.length || entries.some(entry => !entry.committed)) throw blocked('原 native 请求仍未完成认证；未再次派发。')
  await claimOriginalCycleVerification(db, ctx, input, entries.map(entry => entry.input), operationRef)
}

async function claimOriginalCycleVerification(db: Prisma.TransactionClient, ctx: ToolContext, input: LegacyAssessmentInput,
  known: LegacyAssessmentInput[], operationRef: string) {
  const original = await readOriginalTaskRequest(db, ctx), runIds = await originalTaskRunIds(db, ctx, original)
  const saved = await db.storyCompilation.findFirst({ where: { id: input.targetId, userId: ctx.userId, novelId: ctx.novelId,
    chapterId: input.chapterId, runId: { in: runIds } }, include: { chapter: true } })
  const cycle = saved ? (await import('./review-cycle.js')).readReviewCycle(saved.preparedContext,
    { taskId: original.taskId, userId: ctx.userId, novelId: ctx.novelId, chapterId: input.chapterId }) : null
  const source = originalRepairAuthority(original) ? { taskId: original.taskId }
    : saved?.chapter ? await (await import('./writing-scope.js')).readNewDraftWritingAuthority(db, ctx, saved.chapter) : null
  const step = cycle?.transitions.length === 1 ? cycle.transitions[0] : null
  if (!source || !step?.contiguous || !cycle?.baseline || cycle.baseline.compilationId !== input.targetId
    || step.after.revision !== input.revision || step.after.contentHash !== runtimeJson({ content: input.bodies.current }).hash
    || !known.some(old => old.revision === step.before.revision && runtimeJson({ content: old.bodies.current }).hash === step.before.contentHash)
    || known.some(old => old.revision >= input.revision)) throw blocked('候选、调用编号或继续任务不能增加完整判断；没有未使用的原周期正文修订与复核授权。')
  const id = runtimeJson({ kind: 'continuity_original_verification', taskId: original.taskId, chapterId: input.chapterId }).hash
  const prior = await db.agentArtifact.findUnique({ where: { id } })
  if (prior) {
    const receipt = object(object(prior.metadata).legacyContinuityVerification)
    if (receipt.operationRef === operationRef && receipt.inputHash === runtimeJson(input).hash) return
    throw blocked('原周期新版复核已领取，未增加判断。')
  }
  await db.agentArtifact.create({ data: { id, runId: ctx.runId, artifactType: 'continuityReview', title: '原周期旧合同复核领取',
    content: '仅实际正文转换打开一次原复核阶段。', metadata: runtimeJson({ version: 1, legacyContinuityVerification: {
      taskId: original.taskId, chapterId: input.chapterId, operationRef, inputHash: runtimeJson(input).hash, transition: step } }).value } })
}

export const continuityAssessmentPhase = (input: Pick<LegacyAssessmentInput, 'continuityManifest'>) =>
  input.continuityManifest?.typedLineage?.revisionReceiptHash ? 'reverify' as const : 'initial_review' as const

export async function assertContinuityAssessmentSubject(db: Prisma.TransactionClient, subject: Subject, input: LegacyAssessmentInput) {
  const lineage = input.continuityManifest?.typedLineage, plan = lineage?.phasePlan
  if (!lineage || !plan || !await authenticateContinuityPhasePlan(db, subject, plan)) throw blocked('原检查阶段不能认证。')
  if (!lineage.revisionReceiptHash) {
    if (plan.semanticSubjectHash !== (await import('./continuity-subject-identity.js')).continuitySubjectIdentity(input)) throw blocked('初次检查的完整语义范围已变化。')
    return 'initial_review' as const
  }
  const receipt = await readContinuityRevisionReceipt(db, subject, plan)
  if (!receipt || receipt.hash !== lineage.revisionReceiptHash || input.chapterId !== plan.chapterId || input.targetId !== plan.compilationId
    || input.revision !== receipt.value.transition.after.revision || runtimeJson({ content: input.bodies.current }).hash !== receipt.value.transition.after.contentHash)
    throw blocked('新版复核缺少同原周期、实际已保存的修订回执。')
  return 'reverify' as const
}

export async function prepareContinuityReviewLineage(db: Prisma.TransactionClient, subject: Subject,
  target: { compilationId: string; chapterId: string; semanticSubjectHash: string; modelPriceHash: string }) {
  const saved = await db.storyCompilation.findFirst({ where: { id: target.compilationId, chapterId: target.chapterId,
    userId: subject.userId, novelId: subject.novelId }, include: { chapter: true } })
  const audit = object(effectiveContinuityAudit(saved?.validation)), old = object(object(audit.continuityV4).frozen)
  const oldManifest = object(old.manifest), parsed = continuityPhasePlanSchema.safeParse(object(oldManifest.typedLineage).phasePlan)
  if (audit.parserVersion !== 10 || !parsed.success) return { version: 1 as const,
    phasePlan: await prepareContinuityPhasePlan(db, subject, target), priorFindings: [], establishedIssues: [] }
  const plan = parsed.data, receipt = await readContinuityRevisionReceipt(db, subject, plan)
  if (!saved?.chapter || !receipt || plan.modelPriceHash !== target.modelPriceHash) throw blocked('原检查已完成；没有剩余的同周期新版复核阶段。')
  const bodies = object(old.bodies), context = bodies.terminalEvidence as LegacyAssessmentInput['bodies']['terminalEvidence']
  if (typeof bodies.current !== 'string' || !context || context.current.revision !== receipt.value.transition.before.revision
    || runtimeJson({ content: bodies.current }).hash !== receipt.value.transition.before.contentHash) throw blocked('实际修订与原完整报告基线不一致。')
  const binding = await (await import('./terminal-draft-authority.js')).readTerminalDraftBinding(db, { ...subject, compilationId: saved.id },
    { taskId: plan.originalTaskId, preparedContext: saved.preparedContext }, { ...saved.chapter, revision: context.current.revision, content: bodies.current }, saved.validation, context)
  if (!binding.reviewAuthority) throw blocked('原完整报告的实际模型回执不能认证，未购买新版判断。')
  const first = object(object(audit.continuityV4).first), record = object(first.record)
  // The saved typed first/repair projection is rebuilt by the authenticated
  // reader above. Established errors retain their source, never invalid prose.
  const projection = (await import('./continuity-review-v4.js')).validateStoredContinuityV4Projection(audit, bodies.current, context)
  const rows = projection?.parsed?.record.findings
  const findings = Array.isArray(rows) ? rows.map(object) : Array.isArray(record.findings) ? record.findings.map(object) : []
  const priorFindings = findings.map(row => ({ reportHash: runtimeJson(audit).hash, findingId: String(row.findingId), text: String(row.explanation),
    origin: { chapterId: plan.chapterId, revision: context.current.revision, bodyHash: receipt.value.transition.before.contentHash,
      sourceHash: String(oldManifest.sourceHash ?? runtimeJson({ previous: bodies.previous ?? null }).hash) } }))
  return { version: 1 as const, phasePlan: plan, revisionReceiptHash: receipt.hash, priorFindings,
    establishedIssues: priorFindings.filter((_row, index) => findings[index].severity === 'error') }
}

const mergedRevisionResponse = z.object({ patches: z.array(z.object({ oldText: z.string().min(1).max(1800), newText: z.string().max(2200) }).strict()).max(8),
  retainedFindings: z.array(z.object({ source: z.enum(['continuity', 'quality']), reportId: z.string().min(1), findingId: z.string().min(1), reason: z.string().trim().min(1).max(1500) }).strict()).max(100) }).strict()
export const continuityMergedRevisionSystem = '你是一次集中局部修订编辑。只依据完整当前报告修复真正错误与原授权质量问题。保持作者范围、已确立事实、未解决义务和人物知识；不清除unknown，不为过审改写判断。只输出严格JSON {"patches":[{"oldText":"当前正文唯一逐字原文","newText":"最小替换"}],"retainedFindings":[{"source":"continuity或quality","reportId":"原id","findingId":"原id","reason":"无法安全修订的具体理由"}]}。最多8个互不重叠补丁，一次覆盖所有安全问题；未改的意见逐项留置，不宣称已经解决。'

export const nativeContinuityRevisionWorkSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('revision_skip'), version: z.literal(1), compiler: compilerReferenceSchema,
    reason: z.enum(['no_current_reports', 'no_findings', 'no_original_phase', 'revision_unavailable']) }).strict(),
  z.object({ kind: z.literal('merged_revision'), version: z.literal(1), compiler: compilerReferenceSchema,
    chapter: z.object({ id: z.string(), revision: z.number().int().positive(), content: z.string() }).strict(),
    plan: continuityPhasePlanSchema, input: z.record(z.string(), z.unknown()), inputHash: hash,
    validation: z.unknown(), preparedContext: z.unknown(), route: z.record(z.string(), z.unknown()), price: tokenPriceSchema,
    system: z.literal(continuityMergedRevisionSystem), content: z.string() }).strict(),
])

export async function prepareNativeContinuityRevisionWork(db: Prisma.TransactionClient, ctx: ToolContext,
  baseline: { id: string; hash: string }, parentOperationId: string) {
  const facts = await mergedRevisionFacts(db, ctx, baseline.id)
  const skip = (reason: 'no_current_reports' | 'no_findings' | 'no_original_phase' | 'revision_unavailable') =>
    ({ kind: 'revision_skip' as const, version: 1 as const, compiler: baseline, reason })
  if (!facts) return skip('no_current_reports')
  if (!facts.findings.length) return skip('no_findings')
  if (facts.plan.phases.find(phase => phase.kind === 'prose_revision')?.limit !== 1) return skip('no_original_phase')
  const probe = await (await import('./chapter-review-guard.js')).probeChapterReviewRevision(db, ctx, facts.saved.chapter!, { mutation: 'range', mergedBatch: true })
  if (!probe.open) return skip('revision_unavailable')
  const { route, price } = await (await import('./runtime-writing-service.js')).readWritingReviewFrozenPrice(db,
    { userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId, taskRootId: facts.plan.originalTaskId }, parentOperationId, 'continuity', facts.plan.modelPriceHash)
  if (facts.plan.modelPriceHash !== runtimeJson({ route, price }).hash) throw blocked('native 集中修订不能替换原冻结模型与价目。')
  return nativeContinuityRevisionWorkSchema.parse({ kind: 'merged_revision', version: 1, compiler: baseline,
    chapter: { id: facts.saved.chapter!.id, revision: facts.saved.chapter!.revision, content: facts.saved.chapter!.content },
    plan: facts.plan, input: facts.input, inputHash: facts.inputHash, validation: facts.saved.validation,
    preparedContext: facts.saved.preparedContext, route, price, system: continuityMergedRevisionSystem, content: JSON.stringify(facts.input) })
}

export async function authenticateNativeContinuityRevisionWork(db: Prisma.TransactionClient, ctx: Subject,
  value: unknown, historical = false) {
  const work = nativeContinuityRevisionWorkSchema.parse(value)
  if (work.kind === 'revision_skip') return work
  const route = (await import('./runtime-auxiliary-call.js')).auxiliaryRouteSchema.parse(work.route)
  if (!await authenticateContinuityPhasePlan(db, ctx, work.plan) || work.plan.supplementalSourceKey
    || work.plan.compilationId !== work.compiler.id || work.plan.chapterId !== work.chapter.id
    || work.plan.phases.find(phase => phase.kind === 'prose_revision')?.limit !== 1
    || work.plan.modelPriceHash !== runtimeJson({ route: work.route, price: work.price }).hash
    || runtimeJson(work.input).hash !== work.inputHash || work.content !== JSON.stringify(work.input)
    || work.input.planHash !== work.plan.hash || work.input.content !== work.chapter.content || work.input.revision !== work.chapter.revision
    || work.input.validationHash !== runtimeJson(work.validation).hash || work.input.preparedHash !== runtimeJson(work.preparedContext).hash) throw blocked('native 集中修订工作缺少原完整材料与阶段绑定。')
  const audit = object(effectiveContinuityAudit(work.validation)), frozen = object(object(audit.continuityV4).frozen)
  const context = object(frozen.bodies).terminalEvidence as LegacyAssessmentInput['bodies']['terminalEvidence']
  const current = object(context?.current)
  if (!context || current.revision !== work.chapter.revision || current.id !== work.chapter.id
    || object(frozen.bodies).current !== work.chapter.content || object(work.validation).independentCheck !== 'complete') throw blocked('native 集中修订没有完整当前报告。')
  const original = await readOriginalTaskRequest(db, ctx), runs = await originalTaskRunIds(db, ctx, original)
  if (!await authenticateEffectiveContinuityReport(db, ctx, work.compiler.id, work.validation, runs)) throw blocked('native 原报告指针不能认证。')
  const artifacts = await db.agentArtifact.findMany({ where: { runId: { in: runs }, artifactType: 'continuityReview' }, take: 1001 })
  if (artifacts.length > 1000) throw blocked('native 原报告历史超出认证范围。')
  // Only this exact pre-revision body/report is an origin. Later verification
  // services must not recursively become prerequisites of their own parent.
  const entries = await (await import('./native-continuity-assessment.js')).readNativeContinuityAssessments(db,
    { userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId }, original.taskId, runs,
    { compilationId: work.compiler.id, chapterId: work.chapter.id, currentAudit: audit }, artifacts)
  if (!entries?.some(entry => entry.current && entry.committed && entry.inspected.complete)) throw blocked('native 集中修订原模型判断来源不能认证。')
  if (!historical) {
    const facts = await mergedRevisionFacts(db, ctx as ToolContext, work.compiler.id)
    if (!facts || facts.inputHash !== work.inputHash) throw blocked('native 集中修订前全部当前报告或正文已变化。')
    const probe = await (await import('./chapter-review-guard.js')).probeChapterReviewRevision(db, ctx, work.chapter, { mutation: 'range', mergedBatch: true })
    if (!probe.open) throw blocked(probe.message)
  }
  return { ...work, route }
}

export async function nativeContinuityRevisionArgs(workValue: unknown, raw: string) {
  const work = nativeContinuityRevisionWorkSchema.parse(workValue)
  if (work.kind !== 'merged_revision') throw blocked('无实际改稿阶段不能应用补丁。')
  const parsed = mergedRevisionResponse.parse(JSON.parse(raw))
  const patches = (await import('./tools/story-compiler-tools.js')).parseContinuityPatches(JSON.stringify({ patches: parsed.patches }), work.chapter.content)
  if (!patches) throw blocked('本次集中修订没有完整安全补丁，未再派发。')
  if (!patches.length) return null
  return { chapterId: work.chapter.id, patches, retainedFindings: parsed.retainedFindings }
}

export async function readNativeContinuityRevisionResult(db: Prisma.TransactionClient, operationId: string) {
  const operation = await db.agentOperation.findFirst({ where: { parentOperationId: operationId, kind: 'provider',
    operationKey: `aux:${operationId}:continuity_coordinated_revision`, action: 'continuity_coordinated_revision', status: 'succeeded' },
    include: { attempts: { include: { usageReceipt: true } }, events: true } })
  const attempt = operation?.attempts[0], usage = attempt?.usageReceipt
  if (!operation || operation.attempts.length !== 1 || !attempt || attempt.attemptKey !== '1' || attempt.status !== 'succeeded'
    || !attempt.dispatchedAt || !attempt.completedAt || !attempt.resultHash || runtimeJson(attempt.result).hash !== attempt.resultHash
    || runtimeJson(attempt.requestSnapshot).hash !== attempt.requestHash || runtimeJson(operation.inputSnapshot).hash !== operation.inputHash
    || !usage || usage.source !== 'reported' || usage.settlementStatus !== 'settled' || usage.promptTokens === null || usage.completionTokens === null
    || !operation.events.some(event => event.type === 'provider.result.recorded' && event.eventKey === `result:${attempt.id}:${attempt.resultHash}`
      && runtimeJson(event.payload).hash === runtimeJson({ attemptId: attempt.id, status: 'succeeded', resultHash: attempt.resultHash }).hash)) return null
  const parsed = z.object({ outcome: z.literal('succeeded'), result: durableChatResultSchema }).strict().safeParse(attempt.result)
  return parsed.success && parsed.data.result.finishReason === 'stop' && !parsed.data.result.toolCalls.length ? parsed.data.result : null
}

export async function assertNativeContinuityRevisionApplication(db: Prisma.TransactionClient, ctx: ToolContext,
  chapter: { id: string; revision: number; content?: string }, after: unknown,
  review?: Pick<import('./chapter-review-guard.js').ChapterReviewRevisionOptions, 'retainedFindings' | 'editRanges'>) {
  const capability = ctx.nativeContinuityRevision
  if (!capability || typeof after !== 'string') throw blocked('native 改稿没有实际正文效果。')
  const work = await authenticateNativeContinuityRevisionWork(db, ctx, capability.work)
  if (work.kind !== 'merged_revision' || chapter.id !== work.chapter.id || chapter.revision !== work.chapter.revision || chapter.content !== work.chapter.content)
    throw blocked('native 改稿实际正文与原阶段不一致。')
  const parent = await db.agentOperation.findFirst({ where: { id: capability.operationId, kind: 'internal', action: 'chapter_edit_range', taskRootId: work.plan.originalTaskId } })
  if (!parent || !await readContinuityPhaseClaim(db, ctx, { plan: work.plan, chapterId: chapter.id, phase: 'prose_revision',
    operationRef: parent.id, inputHash: parent.inputHash })) throw blocked('native 改稿没有原唯一阶段领取。')
  const response = await readNativeContinuityRevisionResult(db, parent.id)
  if (!response) throw blocked('native 改稿响应、真实用量或结算不能认证。')
  const parsed = await nativeContinuityRevisionArgs(work, response.content)
  if (!parsed || runtimeJson(parsed.retainedFindings).hash !== runtimeJson(review?.retainedFindings ?? []).hash) throw blocked('native 实际留置决定不属于原修订响应。')
  let expected = work.chapter.content
  const patches = parsed.patches.map(patch => ({ ...patch, start: expected.indexOf(patch.oldText) })).sort((a, b) => b.start - a.start)
  for (const patch of patches) expected = expected.slice(0, patch.start) + patch.newText + expected.slice(patch.start + patch.oldText.length)
  if (after !== expected) throw blocked('native 实际正文不能替换认证修订候选。')
  return (await import('./chapter-review-guard.js')).assertChapterReviewRevision(db, ctx, chapter,
    { mutation: 'range', mergedBatch: true, after, ...review })
}

async function mergedRevisionFacts(db: Prisma.TransactionClient, ctx: ToolContext, compilationId: string) {
  await assertContinuityOwner(db, ctx)
  const original = await readOriginalTaskRequest(db, ctx), runs = await originalTaskRunIds(db, ctx, original)
  const saved = await db.storyCompilation.findFirst({ where: { id: compilationId, userId: ctx.userId, novelId: ctx.novelId,
    runId: { in: runs }, status: 'active' }, include: { chapter: true } })
  const audit = object(effectiveContinuityAudit(saved?.validation)), marker = object(audit.continuityV4), frozen = object(marker.frozen)
  const plan = continuityPhasePlanSchema.safeParse(object(object(marker.manifest).typedLineage).phasePlan)
  if (!saved?.chapter || audit.parserVersion !== 10 || !plan.success || plan.data.supplementalSourceKey) return null
  const current = saved.chapter, context = object(frozen.bodies).terminalEvidence as LegacyAssessmentInput['bodies']['terminalEvidence']
  if (!context || object(saved.validation).checkedRevision !== current.revision || object(saved.validation).independentCheck !== 'complete') return null
  const guard = await import('./chapter-review-guard.js'), readiness = await guard.readChapterReviewReadiness(db, ctx, compilationId)
  const requirements = originalChapterReviewRequirements(original)
  if (!readiness || readiness.continuity !== 'complete' || requirements.quality && readiness.quality !== 'complete') return null
  const binding = await (await import('./terminal-draft-authority.js')).readTerminalDraftBinding(db, { ...ctx, compilationId },
    { taskId: original.taskId, preparedContext: saved.preparedContext }, current, saved.validation, context)
  if (!binding.reviewAuthority || !await authenticateContinuityPhasePlan(db, ctx, plan.data)) throw blocked('本轮完整报告未通过真实来源认证，未购买改稿。')
  const quality = readiness.qualityReportId ? await db.chapterQualityReport.findFirst({ where: { id: readiness.qualityReportId,
    userId: ctx.userId, novelId: ctx.novelId, chapterRevision: current.revision, compilationId }, include: { findings: true } }) : null
  const qualityContract = await import('./quality-report-contract.js')
  if (requirements.quality && (!quality || !qualityContract.qualityReportCheckedCurrentContent(quality, current.revision, current.content))) return null
  const continuity = Array.isArray(object(saved.validation).findings) ? object(saved.validation).findings as unknown[] : []
  const continuityBinding = guard.continuityDecisionBinding(compilationId, current.revision, saved.validation)
  const findings = [
    ...continuity.map(object).flatMap((finding, index) => finding.severity === 'error' ? [{ source: 'continuity' as const,
      reportId: continuityBinding, findingId: String(index), evidence: finding.evidence, sourceEvidence: finding.sourceEvidence,
      suggestion: finding.suggestion }] : []),
    ...(quality ? qualityContract.selectAutomaticQualityFindings(quality.findings).map(finding => ({ source: 'quality' as const,
      reportId: quality.id, findingId: finding.id, evidence: finding.evidenceExcerpt, startOffset: finding.startOffset, endOffset: finding.endOffset,
      explanation: finding.explanation, suggestion: finding.suggestion })) : [])]
  const input = { version: 1, planHash: plan.data.hash, chapterId: current.id, revision: current.revision, content: current.content,
    validationHash: runtimeJson(saved.validation).hash, preparedHash: runtimeJson(saved.preparedContext).hash,
    qualityReportId: quality?.id ?? null, qualityReportHash: quality ? continuityUsageRowHash(quality) : null, findings }
  return { saved, plan: plan.data, input, inputHash: runtimeJson(input).hash, findings }
}

/** Produces one repair candidate from all current reports. It never invents
 * another review grant or applies manuscript outside the ordinary tool CAS. */
export async function prepareContinuityMergedRevision(ctx: ToolContext, compilationId: string) {
  const { prisma } = await import('../prisma.js')
  if (ctx.inlineChild || ctx.mode !== 'build' || ctx.sandboxMode === 'read_only') return null
  const facts = await prisma.$transaction(tx => mergedRevisionFacts(tx, ctx, compilationId))
  if (!facts?.findings.length) return null
  const plan = facts.plan
  const probe = await prisma.$transaction(tx => import('./chapter-review-guard.js').then(module => module.probeChapterReviewRevision(tx, ctx,
    facts.saved.chapter!, { mutation: 'range', mergedBatch: true })))
  if (plan.phases.find(phase => phase.kind === 'prose_revision')?.limit !== 1 || !probe.open)
    return { kind: 'blocked' as const, reason: !probe.open ? probe.message : '原任务没有尚未使用的集中修订阶段。' }
  const id = runtimeJson({ kind: 'continuity_merged_revision', planHash: plan.hash }).hash
  const prior = await prisma.agentArtifact.findUnique({ where: { id } })
  let stored = object(object(prior?.metadata).continuityMergedRevision)
  if (!prior) {
    const runtime = await (await import('./runtime-auxiliary-call.js')).resolveReviewModelRuntime({ ...ctx, task: 'continuity' })
    const price = runtime.tier === 'custom' ? { version: 'byok-exempt' as const }
      : await (await import('../billing/resolve-token-price.js')).resolveTokenPrice(runtime.tier, runtime.multiplierBps)
    if (continuityModelPriceHash(runtime, price) !== plan.modelPriceHash) throw blocked('原改稿阶段的冻结模型价目发生变化。')
    await prisma.$transaction(async tx => {
      const current = await mergedRevisionFacts(tx, ctx, compilationId)
      if (current?.inputHash !== facts.inputHash) throw blocked('全部当前报告在改稿前已变化。')
      if (!await claimContinuityPhase(tx, ctx, { plan, chapterId: facts.input.chapterId, phase: 'prose_revision', operationRef: id,
        inputHash: facts.inputHash, ownerEpoch: String(ctx.continuityOwnerSeq) })) throw blocked('原集中修订已领取；未知结果不能重发。')
    })
    type Observation = Parameters<NonNullable<Parameters<typeof import('../ai-service.js')['generateTextCompletion']>[2]['onObservedCompletion']>>[0]
    let observed: Observation | undefined
    try {
      await (await import('../ai-service.js')).generateTextCompletion('你是一次集中局部修订编辑。只依据完整当前报告修复真正错误与原授权质量问题。保持作者范围、已确立事实、未解决义务和人物知识；不清除unknown，不为过审改写判断。只输出严格JSON {"patches":[{"oldText":"当前正文唯一逐字原文","newText":"最小替换"}],"retainedFindings":[{"source":"continuity或quality","reportId":"原id","findingId":"原id","reason":"无法安全修订的具体理由"}]}。最多8个互不重叠补丁，一次覆盖所有安全问题；未改的意见逐项留置，不宣称已经解决。',
        JSON.stringify(facts.input), { userId: ctx.userId, novelId: ctx.novelId, chapterId: facts.input.chapterId, agentRunId: ctx.runId,
          action: 'agent3ContinuityRepair', targetType: 'story_compilation', targetId: compilationId, modelRuntime: runtime,
          explicitModelSelection: true, singlePhysicalRequest: true, signal: ctx.signal, temperature: 0, responseFormat: 'json_object', boundedReview: true, maxOutputTokens: 16384,
          beforeProviderDispatch: async usageId => { await prisma.$transaction(async tx => {
            const current = await mergedRevisionFacts(tx, ctx, compilationId)
            if (current?.inputHash !== facts.inputHash) throw blocked('改稿派发前当前完整报告或正文已变化。')
            const fee = await tx.aiUsageLog.findFirst({ where: { id: usageId, userId: ctx.userId, agentRunId: ctx.runId,
              action: 'agent3ContinuityRepair', targetType: 'story_compilation', targetId: compilationId } })
            if (!fee || continuityModelPriceHash({ tier: fee.modelTier!, provider: fee.providerName!, modelName: fee.modelName,
              multiplierBps: fee.multiplierBps }, fee.billingSnapshot) !== plan.modelPriceHash) throw blocked('派发前实际预备费用与原冻结模型价目不一致。')
          }) }, onObservedCompletion: value => { observed = value } })
    } finally {
      if (observed) {
        const value = observed
        stored = { version: 1, planHash: plan.hash, input: facts.input, inputHash: facts.inputHash,
          usageId: value.usageId, raw: value.content, complete: value.transportComplete !== false && value.finishReason === 'stop' && !value.toolCalls.length }
        await prisma.agentArtifact.create({ data: { id, runId: ctx.runId, artifactType: 'continuityReview', title: '原周期集中修订候选',
          content: '保留实际修订响应；写入仍须原正文工具完整守卫。', metadata: runtimeJson({ version: 1, continuityMergedRevision: stored }).value } })
        await prisma.$transaction(tx => accountMergedRevisionUsage(tx, ctx, value.usageId, compilationId))
      }
    }
  }
  if (stored.inputHash !== facts.inputHash || stored.planHash !== plan.hash || typeof stored.usageId !== 'string'
    || stored.complete !== true || typeof stored.raw !== 'string') return { kind: 'blocked' as const, reason: '原集中修订结果尚未完整确认，未重发。' }
  const usage = await prisma.aiUsageLog.findFirst({ where: { id: stored.usageId, userId: ctx.userId, agentRunId: ctx.runId,
    action: 'agent3ContinuityRepair', targetType: 'story_compilation', targetId: compilationId } })
  if (!usage || usage.usageSource !== 'reported' || !(await import('./text-request-billing.js')).isKnownTextRequestBilling(usage))
    return { kind: 'blocked' as const, reason: '改稿响应已保留，真实结算尚未确认，未重发。' }
  await prisma.$transaction(tx => accountMergedRevisionUsage(tx, ctx, usage.id, compilationId))
  if (continuityModelPriceHash({ tier: usage.modelTier!, provider: usage.providerName!, modelName: usage.modelName,
    multiplierBps: usage.multiplierBps }, usage.billingSnapshot) !== plan.modelPriceHash) throw blocked('改稿真实费用身份不匹配原冻结模型价目。')
  let parsed: z.infer<typeof mergedRevisionResponse>
  try { parsed = mergedRevisionResponse.parse(JSON.parse(stored.raw)) } catch { return { kind: 'blocked' as const, reason: '一次改稿响应未形成完整安全补丁，原费用与原始响应保留，未追加格式请求。' } }
  const patches = (await import('./tools/story-compiler-tools.js')).parseContinuityPatches(JSON.stringify({ patches: parsed.patches }), facts.input.content)
  if (!patches?.length) return { kind: 'blocked' as const, reason: '没有可验证且改变正文的合并补丁；原意见与响应保留，未消费实际正文修订或追加请求。' }
  return { kind: 'tool' as const, callId: `continuity_revision_${plan.hash.slice(0, 40)}`, args: { chapterId: facts.input.chapterId,
    patches, retainedFindings: parsed.retainedFindings }, capability: { responseArtifactId: id, plan } }
}

export async function assertContinuityRevisionApplication(db: Prisma.TransactionClient, ctx: ToolContext,
  chapter: { id: string; revision: number; content?: string }, after: unknown,
  review?: Pick<import('./chapter-review-guard.js').ChapterReviewRevisionOptions, 'retainedFindings' | 'editRanges'>) {
  const capability = ctx.continuityRevision
  if (!capability || typeof after !== 'string') throw blocked('缺少原集中修订实际正文。')
  const facts = await mergedRevisionFacts(db, ctx, capability.plan.compilationId)
  const row = await db.agentArtifact.findFirst({ where: { id: capability.responseArtifactId, runId: ctx.runId, artifactType: 'continuityReview' } })
  const stored = object(object(row?.metadata).continuityMergedRevision)
  if (!facts || stored.inputHash !== facts.inputHash || chapter.id !== facts.input.chapterId || chapter.revision !== facts.input.revision
    || chapter.content !== facts.input.content || stored.planHash !== capability.plan.hash || stored.complete !== true || typeof stored.raw !== 'string'
    || !await readContinuityPhaseClaim(db, ctx, { plan: capability.plan, chapterId: chapter.id, phase: 'prose_revision',
      operationRef: capability.responseArtifactId, inputHash: facts.inputHash })) throw blocked('原集中修订的当前正文、报告或阶段回执不匹配。')
  const fee = typeof stored.usageId === 'string' ? await db.aiUsageLog.findFirst({ where: { id: stored.usageId, userId: ctx.userId,
    agentRunId: ctx.runId, novelId: ctx.novelId, chapterId: chapter.id, action: 'agent3ContinuityRepair', targetType: 'story_compilation', targetId: capability.plan.compilationId } }) : null
  if (!fee || fee.usageSource !== 'reported' || !(await import('./text-request-billing.js')).isKnownTextRequestBilling(fee)) throw blocked('原集中修订没有实际已知用量回执。')
  if (continuityModelPriceHash({ tier: fee.modelTier!, provider: fee.providerName!, modelName: fee.modelName,
    multiplierBps: fee.multiplierBps }, fee.billingSnapshot) !== capability.plan.modelPriceHash) throw blocked('原集中修订模型价格回执漂移。')
  const parsed = mergedRevisionResponse.parse(JSON.parse(stored.raw))
  if (runtimeJson(parsed.retainedFindings).hash !== runtimeJson(review?.retainedFindings ?? []).hash) throw blocked('不能替换本次修订响应中的真实留置决定。')
  const patches = (await import('./tools/story-compiler-tools.js')).parseContinuityPatches(JSON.stringify({ patches: parsed.patches }), facts.input.content)
  if (!patches?.length) throw blocked('原集中修订没有完整安全补丁。')
  let expected = facts.input.content
  const ordered = patches.map(patch => ({ ...patch, start: expected.indexOf(patch.oldText) })).sort((a, b) => b.start - a.start)
  for (const patch of ordered) expected = expected.slice(0, patch.start) + patch.newText + expected.slice(patch.start + patch.oldText.length)
  if (after !== expected) throw blocked('实际正文效果不能替换冻结的原集中补丁。')
  return (await import('./chapter-review-guard.js')).assertChapterReviewRevision(db, ctx, chapter,
    { mutation: 'range', mergedBatch: true, after, ...review })
}

async function accountMergedRevisionUsage(db: Prisma.TransactionClient, ctx: Subject, usageId: string, compilationId: string) {
  await db.$queryRaw`SELECT id FROM agent_runs WHERE id = ${ctx.runId} FOR UPDATE`
  const usage = await db.aiUsageLog.findFirst({ where: { id: usageId, userId: ctx.userId, novelId: ctx.novelId,
    agentRunId: ctx.runId, action: 'agent3ContinuityRepair', targetType: 'story_compilation', targetId: compilationId } })
  if (!usage || usage.usageSource !== 'reported' || usage.requestTokens === null || usage.responseTokens === null) return
  const id = runtimeJson({ kind: 'continuity_usage_accounted', usageId }).hash
  if (await db.agentArtifact.findUnique({ where: { id } })) return
  const run = await db.agentRun.findFirstOrThrow({ where: { id: ctx.runId, userId: ctx.userId, novelId: ctx.novelId } }), before = object(run.usage)
  const promptTokens = Number(before.promptTokens ?? 0) + usage.requestTokens, completionTokens = Number(before.completionTokens ?? 0) + usage.responseTokens
  const totalTokens = Number(before.totalTokens ?? 0) + usage.requestTokens + usage.responseTokens
  if (![promptTokens, completionTokens, totalTokens].every(value => Number.isSafeInteger(value) && value >= 0)) throw blocked('改稿实际用量合计不能安全表示。')
  await db.agentRun.update({ where: { id: run.id }, data: { usage: runtimeJson({ ...before, promptTokens, completionTokens, totalTokens }).value } })
  await db.agentArtifact.create({ data: { id, runId: ctx.runId, artifactType: 'continuityReview', title: '原集中修订实际用量', content: '已知实际用量仅计入一次。',
    metadata: runtimeJson({ version: 1, continuityUsageAccounted: { usageId, requestTokens: usage.requestTokens, responseTokens: usage.responseTokens } }).value } })
}

export async function recordContinuityRevisionApplication(db: Prisma.TransactionClient, ctx: ToolContext,
  chapter: { id: string; revision: number }, after: unknown) {
  const capability = ctx.continuityRevision!
  const saved = await db.chapter.findFirst({ where: { id: chapter.id, revision: chapter.revision + 1, authorId: ctx.userId, novelId: ctx.novelId } })
  if (!saved || saved.content !== after) throw blocked('原集中修订实际CAS回执缺失。')
  const id = runtimeJson({ kind: 'continuity_revision_applied', planHash: capability.plan.hash }).hash
  await db.agentArtifact.create({ data: { id, runId: ctx.runId, artifactType: 'continuityReview', title: '原周期正文转换', content: '实际保存后才记录；不代表新版判断已通过。',
    metadata: runtimeJson({ version: 1, continuityRevisionApplied: { planHash: capability.plan.hash, responseArtifactId: capability.responseArtifactId,
      chapterId: chapter.id, beforeRevision: chapter.revision, afterRevision: saved.revision, afterHash: runtimeJson({ content: saved.content }).hash } }).value } })
}

/** The database primary key, inside the caller's existing owner transaction,
 * serializes all runs and protocols for this original chapter phase. A claim
 * is not released when a physical request may have escaped. */
export async function claimContinuityPhase(db: Prisma.TransactionClient, subject: Subject, input: {
  plan: ContinuityPhasePlan; chapterId: string; phase: ContinuityPhasePlan['phases'][number]['kind'];
  operationRef: string; inputHash: string; ownerEpoch: string;
}) {
  const plan = continuityPhasePlanSchema.parse(input.plan)
  await assertContinuityOwner(db, subject)
  if (plan.chapterId !== input.chapterId || !await authenticateContinuityPhasePlan(db, subject, plan)
    || plan.phases.find(phase => phase.kind === input.phase)?.limit !== 1) throw blocked('原任务未授权该连续性阶段。')
  const id = continuityPhaseClaimId(plan, input.chapterId, input.phase)
  const value = { version: 1, planHash: plan.hash, originalTaskId: plan.originalTaskId, phase: input.phase, ordinal: 0,
    operationRef: input.operationRef, exactInputHash: input.inputHash, ownerEpoch: input.ownerEpoch }
  const prior = await db.agentArtifact.findUnique({ where: { id } })
  if (prior) {
    const saved = object(object(prior.metadata).continuityPhaseClaim)
    if (saved.planHash !== plan.hash || saved.operationRef !== input.operationRef || saved.exactInputHash !== input.inputHash)
      throw blocked('该原任务阶段已经领取；重启、候选或调用编号变化不能新增付费判断。')
    return false
  }
  await db.agentArtifact.create({ data: { id, runId: subject.runId, artifactType: 'continuityReview', title: '连续性原阶段领取',
    content: '仅领取原任务已有阶段；不增加预算。', metadata: runtimeJson({ version: 1, continuityPhaseClaim: value }).value } })
  return true
}

export async function readContinuityPhaseClaim(db: Prisma.TransactionClient, subject: Subject, input: {
  plan: ContinuityPhasePlan; chapterId: string; phase: ContinuityPhasePlan['phases'][number]['kind']; operationRef: string; inputHash: string;
}) {
  if (!await authenticateContinuityPhasePlan(db, subject, input.plan)) return false
  const id = continuityPhaseClaimId(input.plan, input.chapterId, input.phase)
  const row = await db.agentArtifact.findUnique({ where: { id } }), claim = object(object(row?.metadata).continuityPhaseClaim)
  return claim.planHash === input.plan.hash && claim.operationRef === input.operationRef && claim.exactInputHash === input.inputHash
}
function continuityPhaseClaimId(plan: ContinuityPhasePlan, chapterId: string, phase: ContinuityPhasePlan['phases'][number]['kind']) {
  return runtimeJson({ kind: 'continuity_phase', taskId: plan.originalTaskId, chapterId, phase, ordinal: 0,
    ...(phase === 'full_reassessment' ? { originalFailedSubject: plan.supplementalSourceKey } : {}) }).hash
}

export const effectiveContinuityReportSchema = z.object({ version: z.literal(1), reportArtifactId: z.string().min(1),
  reportHash: hash, manifestHash: hash, lineageHash: hash }).strict()
export type EffectiveContinuityReport = z.infer<typeof effectiveContinuityReportSchema>

/** Pure consumers never pick fragments or fall back when a pointer is stale.
 * Database consumers additionally authenticate this immutable artifact and the
 * original paid receipt through readTerminalDraftBinding. */
export function effectiveContinuityAudit(validation: unknown): unknown | null {
  const saved = object(validation), audit = object(saved.continuityCriticResponse)
  if (saved.effectiveReport === undefined) return audit.parserVersion === 10 ? null : saved.continuityCriticResponse ?? null
  const pointer = effectiveContinuityReportSchema.safeParse(saved.effectiveReport), marker = object(audit.continuityV4), manifest = object(marker.manifest)
  return pointer.success && audit.parserVersion === 10 && pointer.data.reportHash === runtimeJson(audit).hash
    && pointer.data.manifestHash === manifest.hash && pointer.data.lineageHash === runtimeJson({ assessmentRequest: audit.assessmentRequest ?? null,
      ...(audit.phaseRequest ? { phaseRequest: audit.phaseRequest } : {}),
      manifest: marker.manifest, first: marker.first, repair: marker.repair ?? null }).hash ? audit : null
}

/** Called inside the existing report-save transaction and its manuscript/run
 * locks. A later bridge refusal cannot roll back this complete report. The
 * caller still authenticates the original provider lineage before committing. */
export async function stageEffectiveContinuityReport(db: Prisma.TransactionClient, subject: Subject,
  input: { compilationId: string; audit: unknown; previousValidation: unknown }) {
  const audit = object(input.audit), marker = object(audit.continuityV4), manifest = object(marker.manifest)
  if (audit.parserVersion !== 10 || audit.classification !== 'complete' || typeof manifest.hash !== 'string') return undefined
  const { validateStoredContinuityV4Projection } = await import('./continuity-review-v4.js')
  const frozen = object(marker.frozen), bodies = object(frozen.bodies)
  if (typeof bodies.current !== 'string' || !validateStoredContinuityV4Projection(audit, bodies.current,
    bodies.terminalEvidence as Parameters<typeof validateStoredContinuityV4Projection>[2])?.complete) throw blocked('完整报告的当前来源与投影不能重建。')
  const reportHash = runtimeJson(audit).hash, lineageHash = runtimeJson({ assessmentRequest: audit.assessmentRequest ?? null,
    ...(audit.phaseRequest ? { phaseRequest: audit.phaseRequest } : {}),
    manifest: marker.manifest, first: marker.first, repair: marker.repair ?? null }).hash
  const id = runtimeJson({ kind: 'continuity_report', compilationId: input.compilationId, reportHash }).hash
  const metadata = runtimeJson({ version: 1, effectiveContinuityReport: { compilationId: input.compilationId, reportHash,
    manifestHash: manifest.hash, lineageHash, audit, supersedes: object(input.previousValidation).effectiveReport ?? null,
    previousAuditHash: object(input.previousValidation).continuityCriticResponse === undefined ? null
      : runtimeJson(object(input.previousValidation).continuityCriticResponse).hash } }).value
  const old = await db.agentArtifact.findUnique({ where: { id } })
  if (old) {
    const saved = object(object(old.metadata).effectiveContinuityReport)
    if (saved.compilationId !== input.compilationId || saved.reportHash !== reportHash || saved.manifestHash !== manifest.hash
      || saved.lineageHash !== lineageHash || runtimeJson(saved.audit).hash !== reportHash) throw blocked('完整报告应用回执不一致，未覆盖原回执。')
  }
  if (!old) await db.agentArtifact.create({ data: { id, runId: subject.runId, artifactType: 'continuityReview',
    title: '连续性完整报告', content: '独立完整报告已保存；提交资格另行核验。', metadata } })
  return effectiveContinuityReportSchema.parse({ version: 1, reportArtifactId: id, reportHash, manifestHash: manifest.hash, lineageHash })
}

export async function authenticateEffectiveContinuityReport(db: Prisma.TransactionClient, subject: Subject,
  compilationId: string, validation: unknown, runIds: string[]) {
  const audit = effectiveContinuityAudit(validation), pointer = effectiveContinuityReportSchema.safeParse(object(validation).effectiveReport)
  if (!audit || !pointer.success) return false
  const row = await db.agentArtifact.findFirst({ where: { id: pointer.data.reportArtifactId, runId: { in: runIds },
    run: { userId: subject.userId, novelId: subject.novelId }, artifactType: 'continuityReview' } })
  const report = object(object(row?.metadata).effectiveContinuityReport)
  return report.compilationId === compilationId && report.reportHash === pointer.data.reportHash && report.manifestHash === pointer.data.manifestHash
    && report.lineageHash === pointer.data.lineageHash && runtimeJson(report.audit).hash === pointer.data.reportHash
}

/** Free source adapter. It replays only authenticated, actually applied whole
 * reports. Standalone good fragments of an invalid pair are never origins.
 * The returned ledger must equal the existing ledger; this cannot add, remove
 * or certify a fact and does not mint a replacement whole report. */
export async function reconstructContinuitySourceProvenance(db: Prisma.TransactionClient, subject: Subject,
  target: { compilationId: string; chapterId: string; preparedContext: unknown }) {
  const original = await readOriginalTaskRequest(db, subject), runIds = await originalTaskRunIds(db, subject, original)
  const lifecycle = await import('./assessment-response-lifecycle.js'), coverage = await import('./terminal-fact-coverage.js')
  const rows = await db.agentArtifact.findMany({ where: { runId: { in: runIds }, run: { userId: subject.userId, novelId: subject.novelId },
    artifactType: 'continuityReview' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 1001 })
  if (rows.length > 1000) throw blocked('连续性来源记录超出有界重建范围。')
  let state: import('./terminal-fact-coverage.js').TerminalCoverageState | undefined
  const origins = new Map<string, { factId: string; reservationId: string; reportHash: string; bodyHash: string; sourceHash: string; candidateHash: string; revision: number }>()
  const history: Array<{ reservationId: string; reportHash: string; ledgerHash: string; inputHash: string; usageIds: string[] }> = []
  let latestAppliedReport: { reservationId: string; reportHash: string; revision: number; bodyHash: string;
    establishedIssues: Array<{ reportHash: string; findingId: string; text: string;
      origin: { chapterId: string; revision: number; bodyHash: string; sourceHash: string } }> } | null = null
  const applicationTime = (row: typeof rows[number]) => {
    const key = object(row.metadata).continuityAssessmentRequestKey
    return rows.find(application => object(application.metadata).assessmentApplicationKey === key)?.createdAt.getTime() ?? Number.MAX_SAFE_INTEGER
  }
  for (const row of [...rows].sort((a, b) => applicationTime(a) - applicationTime(b) || a.id.localeCompare(b.id))) {
    subject.signal?.throwIfAborted()
    const meta = object(row.metadata), key = meta.continuityAssessmentRequestKey
    if (typeof key !== 'string') continue
    const applications = rows.filter(application => object(application.metadata).assessmentApplicationKey === key)
    if (!applications.length) continue
    const parsed = lifecycle.legacyAssessmentInputSchema.safeParse(meta.input)
    if (!parsed.success || parsed.data.chapterId !== target.chapterId || parsed.data.targetId !== target.compilationId) continue
    if (typeof meta.callId !== 'string') throw blocked('原报告应用来源缺少真实调用身份。')
    const input = parsed.data
    const context = { ...subject, runId: row.runId, callId: meta.callId } as import('./tools/types.js').ToolContext
    if (lifecycle.legacyContinuityAssessmentKey(context, input) !== key) throw blocked('原报告请求身份无法重建。')
    const result = await lifecycle.readLegacyContinuityAssessment(db, context, input)
    if (!result.inspected.complete || !result.billingKnown || !result.providerComplete || !result.recoveryReady)
      throw blocked('原应用记录没有完整且已结算的独立报告来源。')
    if (!applications.every(application => {
      const receipt = object(application.metadata)
      return receipt.version === 1 && receipt.reservationId === row.id && Array.isArray(receipt.usageIds)
        && runtimeJson([...new Set(receipt.usageIds)].sort()).hash === runtimeJson([...new Set(result.usageIds)].sort()).hash
        && receipt.usageIds.length === result.usageIds.length
    })) throw blocked('原报告应用回执的预约或费用归属不一致。')
    const bound = lifecycle.bindLegacyContinuityAssessment(result.inspected, context, input)
    const review = (await import('./authenticated-continuity-assessment.js')).readAuthenticatedContinuityAssessment(bound.audit,
      input.bodies.current, input.bodies.terminalEvidence, true)
    if (!review || !input.bodies.terminalEvidence?.factCoverage) throw blocked('原报告持续义务不能完整重建。')
    state = coverage.advanceTerminalCoverage(original.spec, state ? { terminalFactCoverage: state } : {},
      { id: target.chapterId, content: input.bodies.current }, review, input.bodies.terminalEvidence.factCoverage)
    if (!state) throw blocked('原持续事实合同缺失。')
    const reportHash = runtimeJson(bound.audit).hash
    const origin = { chapterId: target.chapterId, revision: input.revision, bodyHash: runtimeJson({ content: input.bodies.current }).hash,
      sourceHash: runtimeJson({ previous: input.bodies.terminalEvidence.previous }).hash }
    const classify = (await import('./continuity-finding-authority.js')).classifyContinuityFindingAuthority
    const rawFindings = 'parsed' in result.inspected && result.inspected.parsed ? result.inspected.parsed.record.findings : null
    const establishedIssues = result.inspected.findings.flatMap((finding, index) => {
      const classified = classify(finding, original.prompt, input.bodies)
      if (classified.severity !== 'error') return []
      const raw = Array.isArray(rawFindings) ? object(rawFindings[index]) : null
      return [{ reportHash, findingId: typeof raw?.findingId === 'string' ? raw.findingId : String(index),
        text: bound.audit.parserVersion === 10 && typeof raw?.explanation === 'string' ? raw.explanation
          : typeof raw?.reason === 'string' ? raw.reason : finding.evidence, origin }]
    })
    latestAppliedReport = { reservationId: row.id, reportHash, revision: input.revision, bodyHash: origin.bodyHash, establishedIssues }
    for (const fact of state.facts) if (!origins.has(fact.id)) origins.set(fact.id, { factId: fact.id, reservationId: row.id, reportHash,
      bodyHash: runtimeJson({ content: input.bodies.current }).hash, sourceHash: runtimeJson({ previous: input.bodies.terminalEvidence.previous }).hash,
      candidateHash: runtimeJson(input.terminalCandidate).hash, revision: input.revision })
    history.push({ reservationId: row.id, reportHash, ledgerHash: runtimeJson(state).hash, inputHash: runtimeJson(input).hash, usageIds: result.usageIds })
  }
  const current = coverage.readTerminalCoverageState(original.spec, target.preparedContext, target.chapterId)
  if (!state || !current || runtimeJson(state).hash !== runtimeJson(current).hash || current.facts.some(fact => !origins.has(fact.id)))
    throw blocked('原持续事实与完整已应用报告的来源重建不一致；未更改原 ledger。')
  return { version: 1 as const, originalTaskId: original.taskId, compilationId: target.compilationId, chapterId: target.chapterId,
    ledgerHash: runtimeJson(current).hash, origins: [...origins.values()], history,
    currentFactIds: current.facts.map(fact => fact.id), latestAppliedReport,
    establishedIssues: latestAppliedReport?.establishedIssues ?? [], dependencyScope: 'authenticated_explicit_claims_only' as const }
}

/** Append audit to the original failed operation; the receipt is deliberately
 * not an effective report, a semantic verdict, or a new model operation. */
export async function saveContinuitySourceRecovery(db: Prisma.TransactionClient, subject: Subject,
  target: { compilationId: string; chapterId: string; preparedContext: unknown; originalAssessmentKey: string }) {
  subject.signal?.throwIfAborted()
  await (await import('./manuscript-scope.js')).assertAgentManuscriptCurrent(db, subject)
  await assertContinuityOwner(db, subject)
  if (!await db.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId, status: 'running' }, select: { id: true } }))
    throw blocked('原任务已暂停或取消，未保存迟到恢复结果。')
  const projection = await reconstructContinuitySourceProvenance(db, subject, target)
  const metadata = runtimeJson({ version: 1, continuitySourceRecovery: { originalAssessmentKey: target.originalAssessmentKey,
    projection, action: 'no_action', newProviderDispatches: 0, newMainDispatches: 0, effectiveWholeReport: false } }).value
  const id = runtimeJson({ kind: 'continuity_source_recovery', originalAssessmentKey: target.originalAssessmentKey,
    projectionHash: runtimeJson(projection).hash }).hash
  const old = await db.agentArtifact.findUnique({ where: { id } })
  if (old && runtimeJson(old.metadata).hash !== runtimeJson(metadata).hash) throw blocked('原来源恢复回执冲突。')
  if (!old) await db.agentArtifact.create({ data: { id, runId: subject.runId, artifactType: 'continuityReview', title: '连续性来源免费恢复',
    content: '已核实旧完整报告与持续事实来源；尚无覆盖当前全部义务的新完整独立报告。', metadata } })
  return projection
}

type SupplementModel = { tier: NonNullable<ToolContext['modelRuntime']>['tier']; provider: string; modelName: string;
  multiplierBps: number; reasoningEffort: NonNullable<ToolContext['modelRuntime']>['reasoningEffort']; baseUrl: string; contextWindowTokens: number }
type SupplementFrozen = { version: 1; originalTaskId: string; originalAssessmentKey: string; source: { runId: string; callId: string };
  oldInput: LegacyAssessmentInput; oldAuditHash: string; rawHashes: string[]; originalUsage: Array<{ id: string; hash: string }>;
  input: LegacyAssessmentInput; model: SupplementModel; price: TokenPrice; sourceRecoveryHash: string;
  validationHash: string; preparedHash: string; coverage: unknown; inputTokenCeiling: number; maximumCreditMilli: number;
  focus: string;
  maxPhysicalRequests: 1; formatRepairRequests: 0 }
const supplementQuestionSchema = z.object({ version: z.literal(1), requestId: hash, requestHash: hash, callId: z.string().min(1),
  userId: z.string().min(1), novelId: z.string().min(1), runId: z.string().min(1), ownerSeq: z.number().int().positive(),
  expiresAt: z.string().datetime(), question: z.string().min(1).max(500), accept: z.string().min(1).max(60), reject: z.string().min(1).max(60), frozen: z.unknown() }).strict()
type SupplementQuestion = Omit<z.infer<typeof supplementQuestionSchema>, 'frozen'> & { frozen: SupplementFrozen }
const questionBodyHash = (question: Omit<SupplementQuestion, 'requestHash'>) => runtimeJson(question).hash

/** Read-only concrete request construction. Existing fees select the original
 * critic model and exact price. No prompt, main response or Continue can supply
 * an extra allowance. Both complete old raw responses remain labelled data. */
export async function buildContinuitySupplementQuestion(db: Prisma.TransactionClient, subject: Subject,
  decision: NonNullable<Awaited<ReturnType<typeof import('./terminal-input-decision.js')['readTerminalInputDecision']>>>): Promise<SupplementQuestion> {
  if (subject.continuityOwnerSeq === undefined) throw blocked('缺少当前原任务执行身份。')
  const original = await readOriginalTaskRequest(db, subject), runIds = await originalTaskRunIds(db, subject, original)
  if (original.parentRunId || original.taskId !== decision.taskId) throw blocked('额外独立判断不属于当前原任务。')
  const compilation = await db.storyCompilation.findFirstOrThrow({ where: { id: decision.compilationId, userId: subject.userId, novelId: subject.novelId,
    runId: { in: runIds } }, include: { chapter: true } })
  const oldAudit = object(object(compilation.validation).continuityCriticResponse), request = object(oldAudit.assessmentRequest)
  const lifecycle = await import('./assessment-response-lifecycle.js')
  const reservations = await db.agentArtifact.findMany({ where: { runId: { in: runIds }, artifactType: 'continuityReview',
    metadata: { path: ['continuityAssessmentRequestKey'], equals: String(request.key) } }, take: 2 })
  const reservation = reservations.length === 1 ? reservations[0] : null, meta = object(reservation?.metadata)
  if (!reservation || typeof meta.callId !== 'string' || runtimeJson(meta.input).hash !== runtimeJson(decision.input).hash) throw blocked('原失败独立判断的真实预约不唯一。')
  const source = { runId: reservation.runId, callId: meta.callId }, oldCtx = { ...subject, ...source } as ToolContext
  const received = await lifecycle.readLegacyContinuityAssessment(db, oldCtx, decision.input)
  const bound = lifecycle.bindLegacyContinuityAssessment(received.inspected, oldCtx, decision.input)
  if (received.inspected.complete || !received.billingKnown || !received.providerComplete || !received.recoveryReady || !received.slotUsed
    || runtimeJson(bound.audit).hash !== runtimeJson(oldAudit).hash) throw blocked('原两次判断、完整原文或费用尚未完全核实。')
  const payments = await db.aiUsageLog.findMany({ where: { id: { in: received.usageIds }, userId: subject.userId, novelId: subject.novelId }, orderBy: { id: 'asc' } })
  if (payments.length !== received.usageIds.length || !payments.length) throw blocked('原判断费用来源缺失。')
  const price = tokenPriceSchema.parse(payments[0].billingSnapshot)
  const tier = (await import('../../../shared/contracts/credits.js')).creditModelTierSchema.parse(payments[0].modelTier)
  if (tier === 'custom') throw blocked('原自定义检查模型身份未包含完整可恢复配置，未猜测替代模型。')
  const run = await db.agentRun.findFirstOrThrow({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId } })
  const reasoning = (await import('../../../shared/contracts/agent-model-assignments.js')).modelReasoningEffortSchema.parse(run.reasoningEffort)
  const runtime = await (await import('../credits.js')).getModelTierRuntime(tier, subject.userId, null, reasoning)
  const model: SupplementModel = { tier, provider: runtime.provider, modelName: runtime.modelName ?? env.aiTextModel,
    multiplierBps: runtime.multiplierBps, reasoningEffort: runtime.reasoningEffort, baseUrl: runtime.baseUrl ?? env.aiTextBaseUrl,
    contextWindowTokens: runtime.contextWindowTokens ?? env.agentContextWindowTokens }
  if (!frozenTokenPriceMatchesModel(price, tier, model.multiplierBps) || payments.some(row => row.modelTier !== tier || row.providerName !== model.provider
    || row.modelName !== model.modelName || row.multiplierBps !== model.multiplierBps || runtimeJson(row.billingSnapshot).hash !== runtimeJson(price).hash))
    throw blocked('原独立模型或认证价目不能完整继承。')
  const frames = await db.agentArtifact.findMany({ where: { runId: source.runId, artifactType: 'continuityReview', metadata: { path: ['assessmentKey'], equals: String(request.key) } } })
  const raws = ['first', 'reassessment'].map(stage => {
    const matched = frames.filter(row => object(row.metadata).stage === stage && typeof object(object(row.metadata).response).content === 'string')
    if (matched.length !== 1) throw blocked('原完整响应不唯一，未挑选片段。')
    const raw: unknown = JSON.parse(String(object(object(matched[0].metadata).response).content))
    if (typeof raw !== 'string') throw blocked('原始完整响应损坏。')
    return raw
  })
  const sourceProjection = await reconstructContinuitySourceProvenance(db, subject,
    { compilationId: compilation.id, chapterId: decision.chapterId, preparedContext: compilation.preparedContext })
  const semanticSubjectHash = (await import('./continuity-subject-identity.js')).continuitySubjectIdentity(decision.input)
  if (!semanticSubjectHash || !decision.input.terminalCandidate || !decision.input.sourceScope) throw blocked('本次完整输入不能重建。')
  const family = runtimeJson({ originalTaskId: original.taskId, originalAssessmentKey: request.key, semanticSubjectHash }).hash
  const requestId = runtimeJson({ kind: 'continuity_supplement_question', family, ownerSeq: subject.continuityOwnerSeq }).hash
  const planBody = { version: 1 as const, originalTaskId: original.taskId, originalAdmissionId: original.sourceRunId,
    chapterId: decision.chapterId, compilationId: compilation.id, authorityHash: runtimeJson({ spec: original.spec, prompt: original.prompt }).hash,
    semanticSubjectHash, modelPriceHash: continuityModelPriceHash({ ...model, modelName: model.modelName }, price), budgetOwner: original.taskId,
    supplementalSourceKey: family, phases: [{ kind: 'full_reassessment' as const, limit: 1, authoritySourceRef: `continuity-question:${requestId}` }] }
  const phasePlan = continuityPhasePlanSchema.parse({ ...planBody, hash: runtimeJson(planBody).hash })
  const v4 = await import('./continuity-review-v4.js'), findings = lifecycle.continuityReassessmentCandidates(raws[0])
  const priorFindings = findings?.map((finding, index) => ({ reportHash: runtimeJson({ raw: raws[0] }).hash, findingId: `first:${index}`,
    text: String(object(finding).evidence ?? object(finding).reason ?? '') })) ?? []
  const evidence = decision.input.bodies.terminalEvidence!
  const manifest = v4.buildContinuityReviewManifest({ subject: { userId: subject.userId, novelId: subject.novelId, taskId: original.taskId,
    targetType: 'story_compilation', targetId: compilation.id, chapterId: decision.chapterId, revision: decision.revision }, bodies: decision.input.bodies,
    candidate: decision.input.terminalCandidate, sourceScope: decision.input.sourceScope,
    sourceHash: decision.input.bodies.previous === null ? null : runtimeJson({ previous: decision.input.bodies.previous, source: evidence.previous }).hash,
    sourceVersions: { current: evidence.current, previous: evidence.previous }, verifiedCoverage: evidence.factCoverage ?? null,
    draftProposals: evidence.proposalChanges ?? null, typedLineage: { version: 1, phasePlan,
      priorFindings: [...priorFindings, ...sourceProjection.establishedIssues], establishedIssues: sourceProjection.establishedIssues } })
  const review = { manifest, bodies: decision.input.bodies, candidate: decision.input.terminalCandidate, sourceScope: decision.input.sourceScope }
  const next = v4.continuityReviewV4Request(review, original.prompt, JSON.stringify({ currentBody: decision.input.bodies.current,
    previousBody: decision.input.bodies.previous, originalReadOnlyResponses: raws, originalContext: decision.input.content,
    sourceRecovery: { ledgerHash: sourceProjection.ledgerHash, establishedFactIds: sourceProjection.currentFactIds } }))
  const input: LegacyAssessmentInput = { ...decision.input, ...next, parserVersion: 10, reassessmentProtocol: 7, continuityManifest: manifest }
  const messages = [{ role: 'system' as const, content: next.system }, { role: 'user' as const, content: next.content }]
  const budget = await import('./context-budget.js'), maxOutput = (await import('./review-completion.js')).REVIEW_MAX_OUTPUT_TOKENS
  const inputLimit = budget.resolveDurableInputLimit(model.contextWindowTokens, maxOutput)
  if (!inputLimit || budget.estimateChatMessagesTokens(messages) > inputLimit) throw blocked('全部材料超过原模型窗口；未截断或派发。')
  const inputTokenCeiling = Buffer.byteLength(JSON.stringify(messages), 'utf8') + 4096
  const maximumCreditMilli = (await import('../billing/reservation-policy.js')).priceTokenEvidence(price, inputTokenCeiling, maxOutput, 0)
  if (!Number.isSafeInteger(maximumCreditMilli) || maximumCreditMilli < 0 || maximumCreditMilli > 2147483647) throw blocked('一次判断的费用上限不能安全表示。')
  const frozen: SupplementFrozen = { version: 1, originalTaskId: original.taskId, originalAssessmentKey: String(request.key), source,
    oldInput: decision.input, oldAuditHash: runtimeJson(oldAudit).hash, rawHashes: raws.map(raw => runtimeJson({ raw }).hash),
    originalUsage: payments.map(row => ({ id: row.id, hash: continuityUsageRowHash(row) })), input, model, price, sourceRecoveryHash: runtimeJson(sourceProjection).hash,
    validationHash: runtimeJson(compilation.validation).hash, preparedHash: runtimeJson(compilation.preparedContext).hash,
    coverage: object(compilation.validation).coverage, focus: typeof object(compilation.validation).reviewFocus === 'string' ? String(object(compilation.validation).reviewFocus) : '',
    inputTokenCeiling, maximumCreditMilli, maxPhysicalRequests: 1, formatRepairRequests: 0 }
  const credits = (maximumCreditMilli / 1000).toFixed(3)
  const value = { version: 1 as const, requestId, callId: `continuity_question_${requestId.slice(0, 40)}`,
    ...continuityQuestionOwner(subject),
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), frozen,
    question: `原检查没有覆盖当前全部持续义务，需要额外完整独立判断一次。使用 ${model.provider}/${model.modelName}，费用上限 ${credits} Credits；最多一次供应商请求，不另买格式修复或主模型收尾。是否批准？`,
    accept: `批准这一次完整判断，上限 ${credits} Credits`, reject: '保留现稿与报告，暂不增加这次检查' }
  return { ...value, requestHash: questionBodyHash(value) }
}

async function readContinuitySupplementQuestion(db: Prisma.TransactionClient, subject: Subject, requestId: string): Promise<SupplementQuestion | null> {
  const row = await db.agentArtifact.findFirst({ where: { id: requestId, runId: subject.runId, run: { userId: subject.userId, novelId: subject.novelId }, artifactType: 'continuityReview' } })
  const parsed = supplementQuestionSchema.safeParse(object(row?.metadata).continuitySupplementQuestion)
  if (!parsed.success) return null
  const value = parsed.data as SupplementQuestion, { requestHash: _hash, ...body } = value
  return value.userId === subject.userId && value.novelId === subject.novelId && value.runId === subject.runId && questionBodyHash(body) === value.requestHash ? value : null
}

export async function persistContinuitySupplementQuestion(db: Prisma.TransactionClient, subject: Subject, question: SupplementQuestion) {
  await assertContinuityOwner(db, subject)
  const existing = await readContinuitySupplementQuestion(db, subject, question.requestId)
  if (existing) return existing
  await db.agentArtifact.create({ data: { id: question.requestId, runId: subject.runId, artifactType: 'continuityReview', title: '原连续性阶段明确授权问题',
    content: question.question, metadata: runtimeJson({ version: 1, continuitySupplementQuestion: question }).value } })
  return question
}

async function readContinuitySupplementConsent(db: Prisma.TransactionClient, subject: Subject, requestId: string) {
  const question = await readContinuitySupplementQuestion(db, subject, requestId)
  if (!question) return null
  const id = runtimeJson({ kind: 'continuity_supplement_answer', requestId }).hash
  const row = await db.agentArtifact.findFirst({ where: { id, runId: subject.runId, run: { userId: subject.userId, novelId: subject.novelId }, artifactType: 'continuityReview' } })
  const answer = object(object(row?.metadata).continuitySupplementAnswer)
  return answer.requestId === requestId && answer.requestHash === question.requestHash && answer.userId === subject.userId
    && answer.answer === question.accept && answer.decision === 'accept' && typeof answer.answeredAt === 'string'
    && Date.parse(answer.answeredAt) <= Date.parse(question.expiresAt) ? { ...question, answerArtifactId: id } : null
}

/** This is invoked only by the existing authenticated questions endpoint.
 * A duplicate POST is read-only; it cannot wake a cancelled operation. */
export async function answerContinuitySupplementQuestion(db: Prisma.TransactionClient, subject: Subject,
  input: { requestId?: string; callId: string; answer: string }) {
  if (!input.requestId) return null
  const question = await readContinuitySupplementQuestion(db, subject, input.requestId)
  if (!question) return null
  const id = runtimeJson({ kind: 'continuity_supplement_answer', requestId: input.requestId }).hash
  const existing = await db.agentArtifact.findUnique({ where: { id } })
  if (existing) return { handled: true as const, newAnswer: false, accepted: object(object(existing.metadata).continuitySupplementAnswer).decision === 'accept' }
  await db.$queryRaw`SELECT id FROM agent_runs WHERE id = ${subject.runId} FOR UPDATE`
  const run = await db.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId,
    status: { in: ['running', 'awaiting_approval', 'paused'] } }, select: { usage: true, status: true } })
  const owner = await db.agentRunEvent.findFirst({ where: { runId: subject.runId, type: 'run.started' }, orderBy: { seq: 'desc' } })
  const terminal = run?.status === 'paused' ? await db.agentRunEvent.findFirst({ where: { runId: subject.runId, type: { in: ['run.paused', 'run.finished'] } }, orderBy: { seq: 'desc' } }) : null
  if (!run || object(run.usage).authorEnded !== undefined || question.callId !== input.callId || owner?.seq !== question.ownerSeq
    || Date.now() > Date.parse(question.expiresAt) || run.status === 'paused' && (terminal?.type !== 'run.paused' || object(terminal.payload).reason !== 'needs_input'))
    throw blocked('原问题已过期、取消或执行身份变化；旧卡片不能恢复收费阶段。')
  const accepted = input.answer === question.accept
  if (!accepted && input.answer !== question.reject) throw blocked('请明确选择本问题的具体批准或拒绝选项；普通“继续”不提供额外额度。')
  await db.agentArtifact.create({ data: { id, runId: subject.runId, artifactType: 'continuityReview', title: '原连续性阶段作者答复', content: input.answer,
    metadata: runtimeJson({ version: 1, continuitySupplementAnswer: { requestId: question.requestId, requestHash: question.requestHash,
      userId: subject.userId, answer: input.answer, decision: accepted ? 'accept' : 'reject', answeredAt: new Date().toISOString() } }).value } })
  return { handled: true as const, newAnswer: true, accepted }
}

export async function continuitySupplementQuestionArgs(db: Prisma.TransactionClient, subject: Subject, requestId: string) {
  const question = await readContinuitySupplementQuestion(db, subject, requestId)
  if (!question) throw blocked('本次额外阶段的问题不存在或归属不一致。')
  return { requestId: question.requestId, question: question.question,
    options: [{ label: question.accept }, { label: question.reject }] }
}

/** The ordinary ask_user card/mailbox is reused, while this particular exact
 * request has a durable author receipt. Timeout never chooses an option. */
export async function waitForContinuitySupplementAnswer(ctx: ToolContext,
  args: { question: string; options: Array<{ label: string; detail?: string }> }) {
  const { prisma } = await import('../prisma.js')
  const requestId = ctx.continuityQuestion?.requestId
  if (!requestId) throw blocked('缺少服务端明确阶段问题身份。')
  const question = await readContinuitySupplementQuestion(prisma, ctx, requestId)
  if (!question || question.callId !== ctx.callId || question.ownerSeq !== ctx.continuityOwnerSeq
    || runtimeJson({ question: args.question, options: args.options }).hash !== runtimeJson({ question: question.question,
      options: [{ label: question.accept }, { label: question.reject }] }).hash) throw blocked('提问材料不能替换冻结的具体阶段与费用上限。')
  await prisma.$transaction(async tx => {
    await assertContinuityOwner(tx, ctx)
    await tx.agentRun.update({ where: { id: ctx.runId }, data: { status: 'awaiting_approval' } })
  })
  const response = await (await import('./permissions.js')).waitForQuestionAnswer(ctx.runId, ctx.callId, env.agentApprovalTimeoutMs, ctx.signal)
  ctx.signal.throwIfAborted()
  const consent = await readContinuitySupplementConsent(prisma, ctx, requestId)
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM agent_runs WHERE id = ${ctx.runId} FOR UPDATE`
    const owner = await tx.agentRunEvent.findFirst({ where: { runId: ctx.runId, type: 'run.started' }, orderBy: { seq: 'desc' }, select: { seq: true } })
    if (owner?.seq !== ctx.continuityOwnerSeq) throw blocked('作者答复之后当前执行已变化。')
    if ((await tx.agentRun.updateMany({ where: { id: ctx.runId, userId: ctx.userId, status: 'awaiting_approval' }, data: { status: 'running' } })).count !== 1)
      throw blocked('提问已取消，未恢复旧任务。')
  })
  return { output: consent ? '已保存作者对本具体阶段和费用上限的明确批准；仅原操作的这一次完整判断可执行。'
    : '本次额外完整判断未获明确批准，未选择默认项；原正文、报告与费用记录保持。',
    summary: consent ? '已确认一次具体独立判断' : '等待明确批准，未增加检查',
    display: { kind: 'question' as const, question: question.question, options: args.options,
      ...(response.answer === null ? { unanswered: true } : { answer: response.answer }) } }
}

function supplementUsageMatches(row: { userId: string; novelId: string | null; chapterId: string | null; agentRunId: string | null; action: string;
  targetType: string | null; targetId: string | null; providerName: string | null; modelTier: string | null; modelName: string | null;
  multiplierBps: number; billingSnapshot: unknown }, question: SupplementQuestion) {
  const frozen = question.frozen
  return row.userId === question.userId && row.novelId === question.novelId && row.agentRunId === question.runId
    && row.chapterId === frozen.input.chapterId && row.action === 'agent3ContinuityCritic' && row.targetType === 'story_compilation'
    && row.targetId === frozen.input.targetId && row.providerName === frozen.model.provider && row.modelTier === frozen.model.tier
    && row.modelName === frozen.model.modelName && row.multiplierBps === frozen.model.multiplierBps
    && runtimeJson(row.billingSnapshot).hash === runtimeJson(frozen.price).hash
}

export async function assertContinuitySupplementTransport(db: Prisma.TransactionClient, input: { userId: string; novelId: string; runId: string;
  requestId: string; chapterId: string; targetId: string; system: string; content: string; model: { tier: string; provider: string; modelName: string | null; multiplierBps: number };
  price: unknown; inputTokenCeiling: number; maximumCreditMilli: number; maxOutputTokens: number }) {
  const subject = { userId: input.userId, novelId: input.novelId, runId: input.runId }, consent = await readContinuitySupplementConsent(db, subject, input.requestId)
  if (!consent || Date.now() > Date.parse(consent.expiresAt)) throw blocked('没有当前明确费用授权，未派发完整判断。')
  const frozen = consent.frozen, plan = frozen.input.continuityManifest?.typedLineage?.phasePlan
  if (!plan || frozen.maxPhysicalRequests !== 1 || frozen.formatRepairRequests !== 0 || input.maxOutputTokens !== 16384
    || plan.semanticSubjectHash !== (await import('./continuity-subject-identity.js')).continuitySubjectIdentity(frozen.input)
    || frozen.input.chapterId !== input.chapterId || frozen.input.targetId !== input.targetId || frozen.input.system !== input.system || frozen.input.content !== input.content
    || frozen.inputTokenCeiling !== input.inputTokenCeiling || frozen.maximumCreditMilli !== input.maximumCreditMilli
    || continuityModelPriceHash(input.model, input.price) !== plan.modelPriceHash
    || !await readContinuityPhaseClaim(db, subject, { plan, chapterId: frozen.input.chapterId, phase: 'full_reassessment',
      operationRef: frozen.originalAssessmentKey, inputHash: runtimeJson(frozen.input).hash })) throw blocked('明确阶段、原操作、模型价格或完整请求不能认证。')
  return consent
}

/** The ordinary Credit reservation calls this before reserving. The primary
 * key binds one physical usage to the original failed subject, even across a
 * refreshed question, concurrent API invocation or worker restart. */
export async function reserveContinuitySupplementUsage(db: Prisma.TransactionClient, userId: string, usageId: string, requestId: string, executionId?: string) {
  const usage = await db.aiUsageLog.findFirstOrThrow({ where: { id: usageId, userId } })
  if (!usage.novelId || !usage.agentRunId) throw blocked('额外阶段缺少原任务费用归属。')
  await db.$queryRaw`SELECT id FROM agent_runs WHERE id = ${usage.agentRunId} FOR UPDATE`
  const subject = { userId, novelId: usage.novelId, runId: usage.agentRunId }, consent = await readContinuitySupplementConsent(db, subject, requestId)
  const plan = consent?.frozen.input.continuityManifest?.typedLineage?.phasePlan
  if (!consent || !executionId || !await currentSupplementExecution(db, subject, consent, executionId)) throw blocked('实际费用没有当前唯一执行准入。')
  if (!consent || !plan?.supplementalSourceKey || Date.now() > Date.parse(consent.expiresAt) || !supplementUsageMatches(usage, consent)
    || usage.usageSource !== 'prepared' || usage.billingStatus !== 'authorized_pending'
    || !await readContinuityPhaseClaim(db, subject, { plan, chapterId: consent.frozen.input.chapterId, phase: 'full_reassessment',
      operationRef: consent.frozen.originalAssessmentKey, inputHash: runtimeJson(consent.frozen.input).hash })) throw blocked('该预备费用没有对应真实作者答复与原阶段领取。')
  const id = runtimeJson({ kind: 'continuity_supplement_usage', originalFailedSubject: plan.supplementalSourceKey }).hash
  const value = { version: 1, requestId, requestHash: consent.requestHash, executionId, usageId, inputHash: runtimeJson(consent.frozen.input).hash }
  const prior = await db.agentArtifact.findUnique({ where: { id } })
  if (prior && runtimeJson(object(prior.metadata).continuitySupplementUsage).hash !== runtimeJson(value).hash)
    throw blocked('同一原失败输入已有实际请求费用身份，未创建第二次供应商请求。')
  if (!prior) await db.agentArtifact.create({ data: { id, runId: subject.runId, artifactType: 'continuityReview', title: '原额外阶段唯一费用身份',
    content: '一次明确阶段仅绑定一笔真实请求账目。', metadata: runtimeJson({ version: 1, continuitySupplementUsage: value }).value } })
}

const supplementExecutionId = (question: SupplementQuestion, ownerSeq: number) => runtimeJson({ kind: 'continuity_supplement_execution',
  originalFailedSubject: question.frozen.input.continuityManifest!.typedLineage!.phasePlan.supplementalSourceKey, ownerSeq }).hash

async function currentSupplementExecution(db: Prisma.TransactionClient, subject: Subject, question: SupplementQuestion, executionId: string) {
  const row = await db.agentArtifact.findFirst({ where: { id: executionId, runId: subject.runId, artifactType: 'continuityReview' } })
  const execution = object(object(row?.metadata).continuitySupplementExecution)
  if (execution.requestId !== question.requestId || execution.requestHash !== question.requestHash || typeof execution.ownerSeq !== 'number'
    || typeof execution.callId !== 'string' || execution.inputHash !== runtimeJson(question.frozen.input).hash
    || executionId !== supplementExecutionId(question, execution.ownerSeq)) return false
  const run = await db.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId,
    taskRootId: null, runtimeProtocolVersion: 0, status: 'running' }, select: { usage: true } })
  const owner = await db.agentRunEvent.findFirst({ where: { runId: subject.runId, type: 'run.started' }, orderBy: { seq: 'desc' }, select: { seq: true } })
  return !!run && object(run.usage).authorEnded === undefined && owner?.seq === execution.ownerSeq
}

/** Owner check, first usage creation and unique usage binding are one run-
 * locked transaction. A late/duplicate worker cannot create an orphan row. */
export async function createContinuitySupplementUsage(db: Prisma.TransactionClient, input: { userId: string; novelId: string;
  runId: string; requestId: string; executionId: string }, data: Prisma.AiUsageLogUncheckedCreateInput) {
  await db.$queryRaw`SELECT id FROM agent_runs WHERE id = ${input.runId} FOR UPDATE`
  const question = await readContinuitySupplementConsent(db, input, input.requestId)
  if (!question || Date.now() > Date.parse(question.expiresAt) || !await currentSupplementExecution(db, input, question, input.executionId)
    || data.userId !== input.userId || data.agentRunId !== input.runId || data.novelId !== input.novelId)
    throw blocked('创建费用行前执行 owner 或真实阶段授权已失效。')
  if (await db.agentArtifact.findUnique({ where: { id: supplementReceiptId('continuity_supplement_usage', question) } }))
    throw blocked('原阶段已经绑定实际费用身份，未创建另一费用行。')
  const usage = await db.aiUsageLog.create({ data })
  await reserveContinuitySupplementUsage(db, input.userId, usage.id, input.requestId, input.executionId)
  return usage
}

const supplementReceiptId = (kind: string, question: SupplementQuestion) => runtimeJson({ kind,
  originalFailedSubject: question.frozen.input.continuityManifest!.typedLineage!.phasePlan.supplementalSourceKey }).hash

async function authenticateSupplementOriginal(db: Prisma.TransactionClient, subject: Subject, question: SupplementQuestion) {
  const frozen = question.frozen, original = await readOriginalTaskRequest(db, subject), runIds = await originalTaskRunIds(db, subject, original)
  if (original.taskId !== frozen.originalTaskId || frozen.input.continuityManifest?.subject.taskId !== original.taskId
    || !runIds.includes(frozen.source.runId)) return false
  const lifecycle = await import('./assessment-response-lifecycle.js'), oldCtx = { ...subject, ...frozen.source } as ToolContext
  const reservation = await db.agentArtifact.findMany({ where: { runId: frozen.source.runId, artifactType: 'continuityReview',
    metadata: { path: ['continuityAssessmentRequestKey'], equals: frozen.originalAssessmentKey } }, take: 2 })
  if (reservation.length !== 1 || runtimeJson(object(reservation[0].metadata).input).hash !== runtimeJson(frozen.oldInput).hash
    || object(reservation[0].metadata).callId !== frozen.source.callId || lifecycle.legacyContinuityAssessmentKey(oldCtx, frozen.oldInput) !== frozen.originalAssessmentKey) return false
  const old = await lifecycle.readLegacyContinuityAssessment(db, oldCtx, frozen.oldInput)
  if (old.inspected.complete || !old.billingKnown || !old.providerComplete || !old.recoveryReady || !old.slotUsed
    || runtimeJson(lifecycle.bindLegacyContinuityAssessment(old.inspected, oldCtx, frozen.oldInput).audit).hash !== frozen.oldAuditHash) return false
  const fees = await db.aiUsageLog.findMany({ where: { id: { in: frozen.originalUsage.map(row => row.id) }, userId: subject.userId, novelId: subject.novelId } })
  if (fees.length !== frozen.originalUsage.length || fees.some(row => frozen.originalUsage.find(old => old.id === row.id)?.hash !== continuityUsageRowHash(row))) return false
  const frames = await db.agentArtifact.findMany({ where: { runId: frozen.source.runId, artifactType: 'continuityReview', metadata: { path: ['assessmentKey'], equals: frozen.originalAssessmentKey } } })
  const hashes = ['first', 'reassessment'].map(stage => {
    const rows = frames.filter(row => object(row.metadata).stage === stage && typeof object(object(row.metadata).response).content === 'string')
    if (rows.length !== 1) return null
    try { return runtimeJson({ raw: JSON.parse(String(object(object(rows[0].metadata).response).content)) }).hash } catch { return null }
  })
  return runtimeJson(hashes).hash === runtimeJson(frozen.rawHashes).hash
}

async function assertSupplementCurrent(db: Prisma.TransactionClient, ctx: ToolContext, question: SupplementQuestion, preparedUsageId?: string) {
  await assertContinuityOwner(db, ctx)
  await (await import('./manuscript-scope.js')).assertAgentManuscriptCurrent(db, ctx)
  if (!await authenticateSupplementOriginal(db, ctx, question)) throw blocked('原完整判断、费用或真实作者范围不能重验。')
  const compilation = await db.storyCompilation.findFirstOrThrow({ where: { id: question.frozen.input.targetId, userId: ctx.userId, novelId: ctx.novelId },
    include: { chapter: true, bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } } } })
  if (!compilation.chapter || compilation.chapter.id !== question.frozen.input.chapterId || compilation.chapter.revision !== question.frozen.input.revision
    || compilation.chapter.content !== question.frozen.input.bodies.current || runtimeJson(compilation.validation).hash !== question.frozen.validationHash
    || runtimeJson(compilation.preparedContext).hash !== question.frozen.preparedHash) throw blocked('正文、候选、来源义务或原作者绑定已变化，未应用旧阶段。')
  if (!preparedUsageId) {
    const current = await (await import('./terminal-input-decision.js')).readTerminalInputDecision(db, ctx, compilation.id)
    if (!current || runtimeJson(current.input).hash !== runtimeJson(question.frozen.oldInput).hash) throw blocked('额外阶段已不匹配当前完整输入，未重复派发。')
  } else {
    const usage = await db.aiUsageLog.findFirst({ where: { id: preparedUsageId, userId: ctx.userId, agentRunId: ctx.runId } })
    const binding = await db.agentArtifact.findUnique({ where: { id: supplementReceiptId('continuity_supplement_usage', question) } })
    if (!usage || !supplementUsageMatches(usage, question) || object(object(binding?.metadata).continuitySupplementUsage).usageId !== usage.id)
      throw blocked('当前预备请求不是本次唯一已确认阶段。')
    const original = await readOriginalTaskRequest(db, ctx), runs = await originalTaskRunIds(db, ctx, original)
    if (await db.agentProviderAttempt.count({ where: { runId: { in: runs }, status: { in: ['prepared', 'dispatching', 'dispatched', 'unknown'] } } }))
      throw blocked('原任务仍有未决供应商请求，未派发另一判断。')
    const reviews = await db.aiUsageLog.findMany({ where: { userId: ctx.userId, novelId: ctx.novelId, chapterId: question.frozen.input.chapterId,
      agentRunId: { in: runs }, OR: [{ action: { startsWith: 'agent3Continuity' } }, { action: { startsWith: 'agent3Humanity' } }] } })
    const billing = await import('./text-request-billing.js')
    const unknown = reviews.filter(row => row.id !== preparedUsageId && !billing.isKnownRejectedTextRequestAttempt(row)
      && !(row.usageSource === 'reported' && billing.isKnownTextRequestBilling(row)))
    const retired = unknown.length ? await (await import('./cancelled-review-recovery.js')).readRetiredReviewUsageIds(db, ctx, runs) : new Set<string>()
    if (unknown.some(row => !retired.has(row.id))) throw blocked('当前章节还有未核实的独立请求，未借额外阶段重试。')
    if (!compilation.bridge) throw blocked('原章节桥已缺失。')
    const source = await (await import('./compiler-continuity-source.js')).readCompilerContinuitySource(db, ctx, compilation.chapter, compilation.bridge.fromChapterId, 11)
    const coverage = (await import('./compiler-continuity-contract.js')).compilerContinuityCoverage({ chapter: compilation.chapter,
      bridge: compilation.bridge, sceneTasks: compilation.sceneTasks, source, focus: typeof object(compilation.validation).reviewFocus === 'string'
        ? String(object(compilation.validation).reviewFocus) : undefined, terminalCandidate: question.frozen.input.terminalCandidate }, 11)
    if (runtimeJson(coverage).hash !== runtimeJson(question.frozen.coverage).hash || (source?.content ?? null) !== question.frozen.input.bodies.previous)
      throw blocked('费用预留后原完整来源已变化，未发送旧请求。')
  }
  return compilation
}

async function readSupplementResponse(db: Prisma.TransactionClient, subject: Subject, question: SupplementQuestion) {
  const plan = question.frozen.input.continuityManifest?.typedLineage?.phasePlan
  if (!plan || !await readContinuityPhaseClaim(db, subject, { plan, chapterId: question.frozen.input.chapterId, phase: 'full_reassessment',
    operationRef: question.frozen.originalAssessmentKey, inputHash: runtimeJson(question.frozen.input).hash })) return null
  const row = await db.agentArtifact.findFirst({ where: { id: supplementReceiptId('continuity_supplement_response', question), runId: subject.runId,
    run: { userId: subject.userId, novelId: subject.novelId }, artifactType: 'continuityReview' } })
  const value = object(object(row?.metadata).continuitySupplementResponse), dispatchRow = await db.agentArtifact.findFirst({ where: {
    id: supplementReceiptId('continuity_supplement_dispatch', question), runId: subject.runId, artifactType: 'continuityReview' } })
  const dispatch = object(object(dispatchRow?.metadata).continuitySupplementDispatch)
  if (value.requestId !== question.requestId || value.requestHash !== question.requestHash || typeof value.usageId !== 'string'
    || value.usageId !== dispatch.usageId || dispatch.requestHash !== question.requestHash || dispatch.inputHash !== runtimeJson(question.frozen.input).hash
    || typeof dispatch.at !== 'string' || Date.parse(dispatch.at) > Date.parse(question.expiresAt) || typeof value.raw !== 'string' || typeof value.complete !== 'boolean') return null
  if (typeof dispatch.callId !== 'string' || typeof dispatch.executionId !== 'string' || typeof dispatch.ownerSeq !== 'number') return null
  const executionRow = await db.agentArtifact.findFirst({ where: { id: dispatch.executionId, runId: subject.runId, artifactType: 'continuityReview' } })
  const execution = object(object(executionRow?.metadata).continuitySupplementExecution)
  if (dispatch.executionId !== supplementExecutionId(question, dispatch.ownerSeq) || execution.requestId !== question.requestId
    || execution.requestHash !== question.requestHash || execution.ownerSeq !== dispatch.ownerSeq || execution.callId !== dispatch.callId
    || execution.inputHash !== runtimeJson(question.frozen.input).hash) return null
  const calls = await db.agentRunEvent.findMany({ where: { runId: subject.runId, type: 'tool.call', payload: { path: ['callId'], equals: dispatch.callId } }, take: 2 })
  if (calls.length !== 1 || object(calls[0].payload).toolName !== 'continuity_validate'
    || object(object(calls[0].payload).args).compilationId !== question.frozen.input.targetId) return null
  const usage = await db.aiUsageLog.findFirst({ where: { id: value.usageId, userId: subject.userId, novelId: subject.novelId, agentRunId: subject.runId } })
  const bound = await db.agentArtifact.findFirst({ where: { id: supplementReceiptId('continuity_supplement_usage', question), runId: subject.runId, artifactType: 'continuityReview' } })
  const binding = object(object(bound?.metadata).continuitySupplementUsage)
  if (binding.usageId !== value.usageId || binding.requestId !== question.requestId || binding.requestHash !== question.requestHash || binding.executionId !== dispatch.executionId
    || binding.inputHash !== runtimeJson(question.frozen.input).hash) return null
  if (!usage || !supplementUsageMatches(usage, question) || usage.usageSource !== 'reported' || !(await import('./text-request-billing.js')).isKnownTextRequestBilling(usage)) return null
  const v4 = await import('./continuity-review-v4.js'), input = question.frozen.input
  const inspected = v4.inspectContinuityV4(value.raw, { manifest: input.continuityManifest!, bodies: input.bodies,
    candidate: input.terminalCandidate!, sourceScope: input.sourceScope! }, value.complete)
  const audit = { ...inspected.audit, phaseRequest: { version: 1 as const, requestId: question.requestId,
    originalAssessmentKey: question.frozen.originalAssessmentKey, inputHash: runtimeJson(input).hash, usageId: usage.id } }
  return { inspected: { ...inspected, audit }, usage }
}

export async function knownContinuitySupplementCall(db: Prisma.TransactionClient, subject: Subject, question: SupplementQuestion) {
  if (!await authenticateSupplementOriginal(db, subject, question) || !await readSupplementResponse(db, subject, question)) return null
  const row = await db.agentArtifact.findUnique({ where: { id: supplementReceiptId('continuity_supplement_dispatch', question) } })
  const callId = object(object(row?.metadata).continuitySupplementDispatch).callId
  return typeof callId === 'string' ? { callId, chapterId: question.frozen.input.chapterId,
    revision: question.frozen.input.revision, compilationId: question.frozen.input.targetId } : null
}

/** Startup reconciliation precedes the generic pending-review hard stop. A
 * real known response closes only its exact dispatched execution slot; no
 * tool result, passed report or new request authority is fabricated. */
export async function reconcileKnownContinuitySupplementPending(db: Prisma.TransactionClient, subject: Subject,
  pending: { callId: string; toolName: string; chapterId: string; revision: number; compilationId: string | null }) {
  if (pending.toolName !== 'continuity_validate' || !pending.compilationId) return false
  const rows = await db.agentArtifact.findMany({ where: { runId: subject.runId,
    run: { userId: subject.userId, novelId: subject.novelId }, artifactType: 'continuityReview',
    metadata: { path: ['continuitySupplementDispatch', 'callId'], equals: pending.callId } }, take: 2 })
  const requestId = object(object(rows[0]?.metadata).continuitySupplementDispatch).requestId
  if (rows.length !== 1 || typeof requestId !== 'string') return false
  const question = await readContinuitySupplementConsent(db, subject, requestId)
  if (!question) return false
  const proof = await knownContinuitySupplementCall(db, subject, question)
  return proof?.callId === pending.callId && proof.chapterId === pending.chapterId && proof.revision === pending.revision
    && proof.compilationId === pending.compilationId
}

/** Full report readers use this branch only for an explicit new phase. No
 * legacy pair is ever signed as passed or reinterpreted by contract5. */
export async function authenticateSupplementalContinuityReport(db: Prisma.TransactionClient, subject: Subject, audit: unknown) {
  const phase = object(object(audit).phaseRequest)
  if (typeof phase.requestId !== 'string') return false
  const consent = await readContinuitySupplementConsent(db, subject, phase.requestId)
  if (!consent || !await authenticateSupplementOriginal(db, subject, consent)) return false
  const result = await readSupplementResponse(db, subject, consent)
  return !!result?.inspected.complete && runtimeJson(result.inspected.audit).hash === runtimeJson(audit).hash
}

export async function readContinuitySupplementState(db: Prisma.TransactionClient, subject: Subject, originalAssessmentKey: string) {
  const rows = await db.agentArtifact.findMany({ where: { runId: subject.runId, run: { userId: subject.userId, novelId: subject.novelId }, artifactType: 'continuityReview',
    metadata: { path: ['continuitySupplementQuestion', 'frozen', 'originalAssessmentKey'], equals: originalAssessmentKey } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 101 })
  if (rows.length > 100) throw blocked('原授权问题历史超出有界范围。')
  for (const row of rows) {
    const question = await readContinuitySupplementConsent(db, subject, row.id)
    if (!question) continue
    const result = await readSupplementResponse(db, subject, question)
    const applied = await db.agentArtifact.findUnique({ where: { id: supplementReceiptId('continuity_supplement_application', question) } })
    if (applied) return { kind: 'applied' as const, question, result }
    if (result) return { kind: 'known_result' as const, question, result }
    const plan = question.frozen.input.continuityManifest!.typedLineage!.phasePlan
    const claim = await db.agentArtifact.findUnique({ where: { id: continuityPhaseClaimId(plan, question.frozen.input.chapterId, 'full_reassessment') } })
    if (claim) return { kind: await canResumeUnsentContinuitySupplement(db, subject, question) ? 'authorized' as const : 'unknown' as const, question, result: null }
    if (Date.now() <= Date.parse(question.expiresAt)) return { kind: 'authorized' as const, question, result: null }
  }
  return { kind: 'no_authority' as const, question: null, result: null }
}

/** A claim is not a dispatch. A new persisted owner may continue this exact
 * first attempt only when every possible earlier send/usage window is absent.
 * Existing bound/prepared usage is never replaced by another usage identity. */
export async function canResumeUnsentContinuitySupplement(db: Prisma.TransactionClient, subject: Subject, question: SupplementQuestion) {
  if (subject.continuityOwnerSeq === undefined || Date.now() > Date.parse(question.expiresAt)) return false
  const consent = await readContinuitySupplementConsent(db, subject, question.requestId)
  if (!consent || consent.requestHash !== question.requestHash) return false
  const plan = question.frozen.input.continuityManifest!.typedLineage!.phasePlan
  const row = await db.agentArtifact.findUnique({ where: { id: continuityPhaseClaimId(plan, question.frozen.input.chapterId, 'full_reassessment') } })
  const claim = object(object(row?.metadata).continuityPhaseClaim)
  if (claim.planHash !== plan.hash || claim.operationRef !== question.frozen.originalAssessmentKey
    || claim.exactInputHash !== runtimeJson(question.frozen.input).hash || typeof claim.ownerEpoch !== 'string'
    || !/^\d+$/u.test(claim.ownerEpoch) || Number(claim.ownerEpoch) >= subject.continuityOwnerSeq) return false
  const run = await db.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId,
    taskRootId: null, runtimeProtocolVersion: 0, status: 'running' }, select: { usage: true } })
  const owner = await db.agentRunEvent.findFirst({ where: { runId: subject.runId, type: 'run.started' }, orderBy: { seq: 'desc' }, select: { seq: true } })
  if (!run || object(run.usage).authorEnded !== undefined || owner?.seq !== subject.continuityOwnerSeq) return false
  if (await db.agentArtifact.findUnique({ where: { id: supplementExecutionId(question, subject.continuityOwnerSeq) } })) return false
  if (await db.agentArtifact.findUnique({ where: { id: supplementReceiptId('continuity_supplement_dispatch', question) } })
    || await db.agentArtifact.findUnique({ where: { id: supplementReceiptId('continuity_supplement_usage', question) } })) return false
  const original = await readOriginalTaskRequest(db, subject), runs = await originalTaskRunIds(db, subject, original)
  const issuedAt = new Date(Date.parse(question.expiresAt) - 30 * 60_000)
  const orphan = await db.aiUsageLog.count({ where: { userId: subject.userId, novelId: subject.novelId, agentRunId: { in: runs },
    id: { notIn: question.frozen.originalUsage.map(row => row.id) },
    targetType: 'story_compilation', targetId: question.frozen.input.targetId, chapterId: question.frozen.input.chapterId,
    action: { startsWith: 'agent3ContinuityCritic' }, createdAt: { gte: issuedAt } } })
  if (orphan) return false
  return !await db.agentProviderAttempt.count({ where: { runId: { in: runs }, status: { in: ['prepared', 'dispatching', 'dispatched', 'unknown'] } } })
}

async function appendSupplementReceipt(db: Prisma.TransactionClient, question: SupplementQuestion, kind: string, key: string, value: unknown) {
  const id = supplementReceiptId(kind, question), metadata = runtimeJson({ version: 1, [key]: value }).value
  const prior = await db.agentArtifact.findUnique({ where: { id } })
  if (prior && runtimeJson(prior.metadata).hash !== runtimeJson(metadata).hash) throw blocked('原连续性阶段的不可变回执冲突。')
  if (!prior) await db.agentArtifact.create({ data: { id, runId: question.runId, artifactType: 'continuityReview', title: '原连续性阶段回执',
    content: '保留真实请求、响应和应用身份；不补充阶段或费用。', metadata } })
}

/** Accounting is independent from report validity, cancellation and body
 * application. The immutable usage marker and aggregate update share one tx. */
async function accountSupplementUsage(db: Prisma.TransactionClient, question: SupplementQuestion, usageId: string) {
  await db.$queryRaw`SELECT id FROM agent_runs WHERE id = ${question.runId} FOR UPDATE`
  const usage = await db.aiUsageLog.findFirst({ where: { id: usageId, userId: question.userId, agentRunId: question.runId } })
  if (!usage || !supplementUsageMatches(usage, question) || usage.requestTokens === null || usage.responseTokens === null) return
  const id = runtimeJson({ kind: 'continuity_usage_accounted', usageId }).hash
  if (await db.agentArtifact.findUnique({ where: { id } })) return
  const run = await db.agentRun.findFirstOrThrow({ where: { id: question.runId, userId: question.userId, novelId: question.novelId } }), before = object(run.usage)
  const promptTokens = Number(before.promptTokens ?? 0) + usage.requestTokens, completionTokens = Number(before.completionTokens ?? 0) + usage.responseTokens
  const totalTokens = Number(before.totalTokens ?? 0) + usage.requestTokens + usage.responseTokens
  if (![promptTokens, completionTokens, totalTokens].every(value => Number.isSafeInteger(value) && value >= 0)) throw blocked('真实用量合计不能安全表示，原账目已保留。')
  await db.agentRun.update({ where: { id: run.id }, data: { usage: runtimeJson({ ...before, promptTokens, completionTokens, totalTokens }).value } })
  await db.agentArtifact.create({ data: { id, runId: question.runId, artifactType: 'continuityReview', title: '真实独立判断用量计入', content: '已知用量仅计入一次。',
    metadata: runtimeJson({ version: 1, continuityUsageAccounted: { usageId, requestTokens: usage.requestTokens, responseTokens: usage.responseTokens } }).value } })
}

/** The original operation owns one explicitly purchased phase. Known raw is
 * always applied locally; an escaped/unknown dispatch is never sent again. */
export async function executeContinuitySupplement(ctx: ToolContext, question: SupplementQuestion, dispatchAllowed: boolean) {
  const { prisma } = await import('../prisma.js')
  let response = await readSupplementResponse(prisma, ctx, question)
  if (!response) {
    if (!dispatchAllowed) throw blocked('原额外阶段尚无可认证完整结果；未知请求仅核对，不重发。')
    const consent = await readContinuitySupplementConsent(prisma, ctx, question.requestId)
    if (!consent || Date.now() > Date.parse(question.expiresAt)) throw blocked('本次具体阶段没有有效作者批准。')
    const frozen = question.frozen, plan = frozen.input.continuityManifest!.typedLineage!.phasePlan
    let executionId: string | undefined
    await prisma.$transaction(async tx => {
      await assertSupplementCurrent(tx, ctx, question)
      const fresh = await claimContinuityPhase(tx, ctx, { plan, chapterId: frozen.input.chapterId, phase: 'full_reassessment',
        operationRef: frozen.originalAssessmentKey, inputHash: runtimeJson(frozen.input).hash, ownerEpoch: String(ctx.continuityOwnerSeq) })
      if (!fresh && !await canResumeUnsentContinuitySupplement(tx, ctx, question)) throw blocked('本次完整判断已领取，未重发供应商请求。')
      if (ctx.continuityOwnerSeq === undefined) throw blocked('原阶段执行缺少已持久 owner。')
      const id = supplementExecutionId(question, ctx.continuityOwnerSeq)
      if (await tx.agentArtifact.findUnique({ where: { id } })) throw blocked('该 owner 已领取本次首次发送，未创建另一费用行。')
      await tx.agentArtifact.create({ data: { id, runId: ctx.runId, artifactType: 'continuityReview', title: '原阶段唯一当前执行准入',
        content: '同一原claim的当前执行身份；不创建阶段、请求或费用。', metadata: runtimeJson({ version: 1, continuitySupplementExecution: {
          requestId: question.requestId, requestHash: question.requestHash, inputHash: runtimeJson(frozen.input).hash,
          ownerSeq: ctx.continuityOwnerSeq, callId: ctx.callId } }).value } })
      executionId = id
    })
    const runtime = await (await import('../credits.js')).getModelTierRuntime(frozen.model.tier, ctx.userId, null, frozen.model.reasoningEffort)
    if (runtime.provider !== frozen.model.provider || (runtime.modelName ?? env.aiTextModel) !== frozen.model.modelName
      || (runtime.baseUrl ?? env.aiTextBaseUrl) !== frozen.model.baseUrl || runtime.multiplierBps !== frozen.model.multiplierBps
      || runtime.reasoningEffort !== frozen.model.reasoningEffort || (runtime.contextWindowTokens ?? env.agentContextWindowTokens) !== frozen.model.contextWindowTokens)
      throw blocked('本具体阶段的原模型配置已变化，未替换模型或价目。')
    type Observation = Parameters<NonNullable<Parameters<typeof import('../ai-service.js')['generateTextCompletion']>[2]['onObservedCompletion']>>[0]
    let observed: Observation | undefined, dispatchUsageId: string | undefined
    try {
      await (await import('../ai-service.js')).generateTextCompletion(frozen.input.system, frozen.input.content, { userId: ctx.userId, novelId: ctx.novelId,
        chapterId: frozen.input.chapterId, agentRunId: ctx.runId, targetType: 'story_compilation', targetId: frozen.input.targetId,
        action: 'agent3ContinuityCritic', modelRuntime: runtime, explicitModelSelection: true, signal: ctx.signal, temperature: 0,
        reasoningEffort: runtime.reasoningEffort, responseFormat: 'json_object', boundedReview: true, maxOutputTokens: 16384,
        authorizedRequest: { price: frozen.price, inputTokenCeiling: frozen.inputTokenCeiling, maxCreditMilli: frozen.maximumCreditMilli,
          continuityQuestionId: question.requestId, continuityExecutionId: executionId, beforeDispatch: async () => { ctx.signal.throwIfAborted() } },
        beforeProviderDispatch: async usageId => {
          await prisma.$transaction(async tx => {
            await assertSupplementCurrent(tx, ctx, question, usageId)
            if (!executionId || !await currentSupplementExecution(tx, ctx, question, executionId)) throw blocked('最终派发前唯一执行准入已失效。')
            const dispatchedAt = new Date()
            if (dispatchedAt.getTime() > Date.parse(question.expiresAt)) throw blocked('明确阶段费用授权已到期，未派发供应商请求。')
            await appendSupplementReceipt(tx, question, 'continuity_supplement_dispatch', 'continuitySupplementDispatch', {
              version: 1, requestId: question.requestId, requestHash: question.requestHash, inputHash: runtimeJson(frozen.input).hash,
              usageId, executionId, callId: ctx.callId, ownerSeq: ctx.continuityOwnerSeq, at: dispatchedAt.toISOString() })
          })
          dispatchUsageId = usageId
        }, onObservedCompletion: value => { observed = value } })
    } finally {
      // Raw/known usage survive stale owner and cancellation. These writes do
      // not touch manuscript, report pointer, original claims or old fees.
      if (observed && dispatchUsageId && observed.usageId === dispatchUsageId) {
        const value = observed
        await prisma.$transaction(tx => appendSupplementReceipt(tx, question, 'continuity_supplement_response', 'continuitySupplementResponse', {
          version: 1, requestId: question.requestId, requestHash: question.requestHash, usageId: value.usageId, raw: value.content,
          complete: value.transportComplete !== false && value.finishReason === 'stop' && !value.toolCalls.length }))
      }
      if (dispatchUsageId) await prisma.$transaction(tx => accountSupplementUsage(tx, question, dispatchUsageId!))
    }
    response = await readSupplementResponse(prisma, ctx, question)
    if (!response) throw blocked('完整结果或真实结算尚未确认；保留原请求，不重发。')
  }
  const received = response
  await prisma.$transaction(tx => accountSupplementUsage(tx, question, received.usage.id))
  if (!received.inspected.complete) {
    await prisma.$transaction(async tx => {
      await assertContinuityOwner(tx, ctx)
      await appendSupplementReceipt(tx, question, 'continuity_supplement_application', 'continuitySupplementApplication', {
        version: 1, requestId: question.requestId, reportComplete: false, classification: received.inspected.audit.classification,
        reportHash: runtimeJson(received.inspected.audit).hash, usageId: received.usage.id })
    })
    return { applied: false, reportComplete: false, reason: '本次完整判断仍未通过真实合同校验；本次唯一请求已使用，未追加格式修复。' }
  }
  return prisma.$transaction(async tx => {
    await assertSupplementCurrent(tx, ctx, question, received.usage.id)
    const input = question.frozen.input
    const report = await (await import('./story-compiler.js')).validateStoryContinuity({ userId: ctx.userId, novelId: ctx.novelId,
      runId: ctx.runId, compilationId: input.targetId, expectedChapterRevision: input.revision, expectedContinuityOwnerSeq: ctx.continuityOwnerSeq,
      independentCheck: 'complete', findings: received.inspected.findings, terminalCandidate: input.terminalCandidate,
      continuityCriticResponse: received.inspected.audit, coverage: question.frozen.coverage as Parameters<typeof import('./story-compiler.js')['validateStoryContinuity']>[0]['coverage'],
      focus: question.frozen.focus, signal: ctx.signal }, tx)
    await appendSupplementReceipt(tx, question, 'continuity_supplement_application', 'continuitySupplementApplication', { version: 1,
      requestId: question.requestId, reportComplete: report.independentCheck === 'complete', reportHash: runtimeJson(received.inspected.audit).hash, usageId: received.usage.id })
    return { applied: report.independentCheck === 'complete', reportComplete: report.independentCheck === 'complete', reason: '' }
  })
}

export async function executeContinuitySupplementTool(ctx: ToolContext, args: { compilationId?: string; chapterId?: string }): Promise<import('./tools/types.js').ToolResult> {
  const { prisma } = await import('../prisma.js'), capability = ctx.continuitySupplement
  if (!capability || ctx.inlineChild || ctx.mode !== 'build' || ctx.sandboxMode === 'read_only') throw blocked('当前执行没有原独立判断阶段能力。')
  const question = await readContinuitySupplementConsent(prisma, ctx, capability.requestId)
  if (!question || args.compilationId !== question.frozen.input.targetId || args.chapterId !== undefined && args.chapterId !== question.frozen.input.chapterId)
    throw blocked('额外判断不能作用于其他正文或候选。')
  const state = await readContinuitySupplementState(prisma, ctx, question.frozen.originalAssessmentKey)
  if (state.question?.requestId !== question.requestId || !['authorized', 'known_result'].includes(state.kind)) throw blocked('原阶段已领取或应用，未重放。')
  const result = await executeContinuitySupplement(ctx, question, capability.dispatchAllowed && state.kind === 'authorized')
  const response = await readSupplementResponse(prisma, ctx, question)
  const finished = { version: 1 as const, chapterId: question.frozen.input.chapterId, revision: question.frozen.input.revision,
    contentHash: createHash('sha256').update(question.frozen.input.bodies.current).digest('hex'), usageIds: response ? [response.usage.id] : [] }
  if (!result.applied || !response?.inspected.complete) return { outcome: 'failed', failureCode: 'CONTINUITY_REPORT_INCOMPLETE',
    reviewCompleted: false, reviewOutcome: 'evidence_repair_required', reviewRequestFinished: finished,
    summary: '这次完整判断未通过合同校验', output: result.reason }
  const saved = await prisma.storyCompilation.findUniqueOrThrow({ where: { id: args.compilationId }, include: { chapter: true } })
  if (!saved.chapter) throw blocked('完整报告已保存，但当前正文绑定尚未确认。')
  const binding = await (await import('./terminal-draft-authority.js')).readTerminalDraftBinding(prisma, { ...ctx, compilationId: saved.id },
    { taskId: question.frozen.originalTaskId, preparedContext: saved.preparedContext }, saved.chapter, saved.validation, question.frozen.input.bodies.terminalEvidence)
  const terminal = await import('./terminal-state-review.js')
  const decision = terminal.terminalReviewFailure(saved.validation, saved.chapter.content, question.frozen.input.bodies.terminalEvidence, undefined, binding)
  if (decision && !decision.reviewCompleted) throw blocked('新报告的真实来源尚不能完整认证。')
  const report = object(saved.validation), errorCount = Number(report.errorCount ?? 0), warningCount = Number(report.warningCount ?? 0)
  const readiness = await (await import('./chapter-review-guard.js')).readChapterReviewReadiness(prisma, ctx, saved.id)
  return { ...(decision ?? {}), reviewCompleted: true, reviewOutcome: decision || errorCount || warningCount ? 'decision_required' : 'complete',
    reviewRequestFinished: finished, summary: `额外完整判断已保存 · ${errorCount} 错误 ${warningCount} 警告`,
    output: decision?.output ?? `完整独立报告已认证并保存：${errorCount} 个正文错误、${warningCount} 个警告。原任务还须通过当前版本的实际章节提交与交付检查。`,
    ...(readiness?.progressEvidence ? { reviewProgress: { ...readiness.progressEvidence,
      phases: readiness.progressEvidence.phases.filter(phase => ['continuity', 'terminal', 'terminal_supported'].includes(phase)) } } : {}) }
}
