import type { ChapterReviewReadScope } from './chapter-review-guard.js'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { DataAccessError } from '../prisma.js'
import { runtimeJson, durableChatResultSchema } from './runtime-common.js'
import { readOriginalTaskRequest, originalTaskRunIds, originalRepairAuthority } from './original-request.js'
import { originalChapterReviewRequirements } from './chapter-review-requirements.js'
import { tokenPriceSchema, type TokenPrice } from '../billing/token-price.js'
import type { LegacyAssessmentInput } from './assessment-response-lifecycle.js'
import type { ToolContext } from './tools/types.js'
import { parseQualityJsonObject } from './quality-evidence.js'

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
  const storedCandidate = validation.terminalCandidate
  const parsedCandidate = (await import('./terminal-candidate-contract.js')).terminalCandidateSchema.safeParse(storedCandidate)
  if (storedCandidate !== undefined && storedCandidate !== null && !parsedCandidate.success) return null
  const candidate = parsedCandidate.success ? parsedCandidate.data : undefined
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
    if (!context || !!input.terminalCandidate !== !!candidate || !input.sourceScope || input.targetType !== 'story_compilation' || input.targetId !== compilationId
      || input.chapterId !== saved.chapter.id || input.revision !== saved.chapter.revision
      || input.bodies.current !== saved.chapter.content || input.bodies.previous !== (source?.content ?? null)
      || runtimeJson({ candidate: input.terminalCandidate ?? null }).hash !== runtimeJson({ candidate: candidate ?? null }).hash
      || runtimeJson(input.sourceScope).hash !== runtimeJson(scope).hash) continue
    const evidence = await import('./terminal-evidence-context.js'), coverage = await import('./terminal-fact-coverage.js')
    let current = evidence.terminalEvidenceContext(saved.chapter, source, protocol === 11 ? 2 : 1,
      evidence.terminalQuoteAddressVersion(original.spec), coverage.terminalCoverageInput(original.spec, saved.preparedContext,
        saved.chapter, candidate, context.factCoverage?.version, coverage.terminalCoverageProofs(source, context.spanAddressProtocol)),
      context.verdictProtocol, context.spanAddressProtocol)
    const proposals = await import('./terminal-proposal-context.js')
    if (candidate) current = proposals.attachTerminalProposalInput(current,
      { taskId: proposals.terminalProposalTaskId(original.spec, original.taskId), preparedContext: saved.preparedContext, validation: saved.validation, candidate })
    if (runtimeJson(current).hash !== runtimeJson(context).hash) continue
    const currentCoverage = (await import('./compiler-continuity-contract.js')).compilerContinuityCoverage({ chapter: saved.chapter,
      bridge: saved.bridge, sceneTasks: saved.sceneTasks, source, terminalCandidate: candidate,
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
    const explicit = object(object(received?.audit).sourceProjection)
    if (explicit.kind === 'explicit_source_evidence') {
      if (candidate || !(await import('./continuity-explicit-source-projection.js')).validateStoredExplicitSourceProjection(
        received?.audit, input.bodies.current, context)) continue
      observedAudit = object(explicit.originalAudit)
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
  const chapter = await db.chapter.findFirst({ where: { id: plan.chapterId, authorId: subject.userId, novelId: subject.novelId }, select: { id: true, orderIndex: true } })
  if (!chapter) return false
  let revisionAuthority = false
  if (plan.revisionAuthority) {
    const authority = plan.revisionAuthority.source === 'original_repair' ? originalRepairAuthority(original) ? { taskId: original.taskId } : null
      : chapter ? await (await import('./writing-scope.js')).readNewDraftWritingAuthority(db, subject, chapter) : null
    revisionAuthority = !!authority && plan.revisionAuthority.sourceHash === runtimeJson({ source: plan.revisionAuthority.source,
      taskId: original.taskId, sourceRunId: original.sourceRunId, chapterId: plan.chapterId, authority }).hash
  }
  return validContinuityPhasePlan(plan) && original.taskId === plan.originalTaskId && original.sourceRunId === plan.originalAdmissionId
    && plan.budgetOwner === original.taskId && plan.authorityHash === runtimeJson({ spec: original.spec, prompt: original.prompt }).hash
    && (originalChapterReviewRequirements(original, chapter).continuity
      || !!await readOriginalContinuityPhaseClaim(db, subject, plan, plan.chapterId, 'initial_review')) && plan.phases.every(phase => phase.limit === 0
      || ['initial_review', 'sparse_repair'].includes(phase.kind) && phase.authoritySourceRef === `original-admission:${original.sourceRunId}`
      || ['prose_revision', 'reverify'].includes(phase.kind) && revisionAuthority
        && phase.authoritySourceRef === `original-revision:${original.sourceRunId}:${plan.revisionAuthority!.sourceHash}`)
}

/** An upper bound is frozen from the original admission; it is not a wallet
 * reservation. Historical requests never acquire a new phase by upgrading wire
 * format, changing a candidate, continuing, or restarting a worker. */
type InitialContinuityTarget = {
  compilationId: string; chapterId: string
  input?: Pick<LegacyAssessmentInput, 'revision' | 'bodies' | 'terminalCandidate'>
}

/** Body-only checks do not certify a terminal candidate. Authenticate their
 * actual receipts before filling that missing part of the same initial review. */
export async function authenticateInitialContinuityHistory(db: Prisma.TransactionClient, subject: Subject, target: InitialContinuityTarget) {
  const original = await readOriginalTaskRequest(db, subject), runs = await originalTaskRunIds(db, subject, original)
  const prior = await db.agentArtifact.findMany({ where: { runId: { in: runs }, artifactType: 'continuityReview',
    metadata: { path: ['assessmentChapterId'], equals: target.chapterId } }, take: 1001 })
  const nativeOperations = await db.agentOperation.findMany({ where: { taskRootId: original.taskId, action: 'continuity_validate',
    inputSnapshot: { path: ['input', 'work', 'chapter', 'id'], equals: target.chapterId }, children: { some: { kind: 'provider' } } },
    select: { id: true }, take: 1001 })
  const native = nativeOperations.length
  if (prior.length > 1000 || native > 1000) throw blocked('原连续性记录无法完整认证。')
  if (!prior.length && !native) {
    if (await db.aiUsageLog.count({ where: { userId: subject.userId, novelId: subject.novelId, agentRunId: { in: runs },
      action: { startsWith: 'agent3Continuity' }, OR: [{ chapterId: target.chapterId }, { targetId: { in: [target.chapterId, target.compilationId] } }] } }))
      throw blocked('原连续性用量缺少可认证的请求回执。')
    return false
  }
  const lifecycle = await import('./assessment-response-lifecycle.js')
  const inputs: Array<{ input: LegacyAssessmentInput; audit: { contentHash: string }; complete: boolean }> = [], usageIds = new Set<string>()
  for (const row of prior) {
    const meta = object(row.metadata), parsed = lifecycle.legacyAssessmentInputSchema.safeParse(meta.input)
    if (!parsed.success || parsed.data.terminalCandidate !== undefined || parsed.data.targetType !== 'story_compilation'
      || parsed.data.targetId !== target.compilationId || parsed.data.chapterId !== target.chapterId
      || typeof meta.callId !== 'string') throw blocked('原终态请求或预约仍须按原阶段核对。')
    const receipt = await lifecycle.readLegacyContinuityAssessment(db, { ...subject, runId: row.runId, callId: meta.callId } as ToolContext, parsed.data)
    if (!receipt || !receipt.billingKnown || !receipt.providerComplete || !receipt.recoveryReady)
      throw blocked('原正文检查响应或费用尚未确认。')
    receipt.usageIds.forEach(id => usageIds.add(id))
    inputs.push({ input: parsed.data, audit: receipt.inspected.audit, complete: receipt.inspected.complete })
  }
  if (native) {
    const artifacts = await db.agentArtifact.findMany({ where: { runId: { in: runs }, artifactType: 'continuityReview' }, take: 1001 })
    if (artifacts.length > 1000) throw blocked('原连续性记录无法完整认证。')
    const entries = await (await import('./native-continuity-assessment.js')).readNativeContinuityAssessments(db, subject, original.taskId, runs,
      { compilationId: target.compilationId, chapterId: target.chapterId, currentAudit: {}, operationIds: nativeOperations.map(row => row.id), related: () => true }, artifacts)
    if (!entries || entries.length !== native || entries.some(entry => !entry.committed || entry.input.terminalCandidate !== undefined))
      throw blocked('原 native 检查尚未完成，或已经包含终态判断。')
    inputs.push(...entries.map(entry => ({ input: entry.input, audit: entry.inspected.audit, complete: entry.inspected.complete })))
  }
  const payments = await db.aiUsageLog.findMany({ where: { userId: subject.userId, novelId: subject.novelId, agentRunId: { in: runs },
    action: { startsWith: 'agent3Continuity' }, OR: [{ chapterId: target.chapterId }, { targetId: { in: [target.chapterId, target.compilationId] } }] },
    select: { id: true } })
  if (payments.some(row => !usageIds.has(row.id))) throw blocked('仍有未绑定原回执的连续性用量。')
  const saved = await db.storyCompilation.findFirst({ where: { id: target.compilationId, userId: subject.userId, novelId: subject.novelId,
    runId: { in: runs }, chapterId: target.chapterId }, include: { chapter: true } })
  const validation = object(saved?.validation), audit = object(effectiveContinuityAudit(validation)), input = target.input
  if (!input) throw blocked('原检查缺少完整当前正文输入。')
  if (!input.terminalCandidate) {
    const current = { ...input, chapterId: target.chapterId, targetType: 'story_compilation' as const, targetId: target.compilationId }
    const known = inputs.map(row => row.input)
    if (!saved?.chapter || saved.chapter.revision !== current.revision || saved.chapter.content !== current.bodies.current
      || !await readOriginalCycleContinuityVerification(db, subject, current, known)) throw blocked('已有检查不能重复领取原阶段。')
    // Preparation only authenticates. The existing reservation/provider owner
    // transaction claims this same original-cycle verification exactly once.
    return true
  }
  if (!saved?.chapter || saved.chapter.revision !== input.revision || saved.chapter.content !== input.bodies.current
    || validation.independentCheck !== 'complete' || validation.checkedChapterId !== target.chapterId || validation.checkedRevision !== input.revision
    || object(validation.coverage).contentHash !== runtimeJson({ content: input.bodies.current }).hash
    || !inputs.some(row => row.complete && row.input.revision === input.revision && row.input.bodies.current === input.bodies.current
      && row.input.bodies.previous === input.bodies.previous && row.audit.contentHash === audit.contentHash
      && runtimeJson({ previous: row.input.bodies.terminalEvidence?.previous ?? null }).hash === runtimeJson({ previous: input.bodies.terminalEvidence?.previous ?? null }).hash))
    throw blocked('原完整正文检查不属于当前版本或来源。')
  return true
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

export async function readOriginalCycleContinuityVerification(db: Prisma.TransactionClient, ctx: Subject,
  input: Pick<LegacyAssessmentInput, 'targetId' | 'chapterId' | 'revision' | 'bodies'>, known: LegacyAssessmentInput[]) {
  const original = await readOriginalTaskRequest(db, ctx), runIds = await originalTaskRunIds(db, ctx, original)
  const saved = await db.storyCompilation.findFirst({ where: { id: input.targetId, userId: ctx.userId, novelId: ctx.novelId,
    chapterId: input.chapterId, runId: { in: runIds } }, include: { chapter: true } })
  const cycle = saved ? (await import('./review-cycle.js')).readReviewCycle(saved.preparedContext,
    { taskId: original.taskId, userId: ctx.userId, novelId: ctx.novelId, chapterId: input.chapterId }) : null
  const source = originalRepairAuthority(original) ? { taskId: original.taskId }
    : saved?.chapter ? await (await import('./writing-scope.js')).readNewDraftWritingAuthority(db, ctx, saved.chapter) : null
  const revision = saved && !cycle ? (await import('./writing-scope.js')).readNewDraftRevision(saved.validation) : null
  // An incomplete required report cannot create a ready reviewCycle. The
  // ordinary writing CAS still records this same one original draft revision.
  const step = cycle?.transitions.length === 1 ? cycle.transitions[0]
    : !cycle && revision?.taskId === original.taskId && revision.chapterId === input.chapterId && revision.compilationId === input.targetId
      && revision.beforeHash && revision.afterHash && revision.beforeHash !== revision.afterHash
      ? { before: { revision: revision.checkedRevision, contentHash: revision.beforeHash },
        after: { revision: revision.checkedRevision + 1, contentHash: revision.afterHash }, contiguous: true } : null
  if (!source || !step?.contiguous || cycle && (!cycle.baseline || cycle.baseline.compilationId !== input.targetId)
    || step.after.revision !== input.revision || step.after.contentHash !== runtimeJson({ content: input.bodies.current }).hash
    || !known.some(old => old.revision === step.before.revision && runtimeJson({ content: old.bodies.current }).hash === step.before.contentHash)
    || known.some(old => old.revision >= input.revision)) return null
  const id = runtimeJson({ kind: 'continuity_original_verification', taskId: original.taskId, chapterId: input.chapterId }).hash
  return { id, taskId: original.taskId, step }
}

export const continuityAssessmentPhase = (input: Pick<LegacyAssessmentInput, 'continuityManifest' | 'terminalCandidate'>) =>
  input.continuityManifest?.candidateHash === null && input.terminalCandidate === undefined ? null
    : input.continuityManifest?.typedLineage?.revisionReceiptHash ? 'reverify' as const : 'initial_review' as const

export async function assertContinuityAssessmentSubject(db: Prisma.TransactionClient, subject: Subject, input: LegacyAssessmentInput) {
  const manifest = input.continuityManifest, lineage = manifest?.typedLineage, plan = lineage?.phasePlan
  if (!manifest || !lineage || !plan || !await authenticateContinuityPhasePlan(db, subject, plan)) throw blocked('原检查阶段不能认证。')
  if (manifest.candidateHash === null || input.terminalCandidate === undefined) {
    const { validContinuityReviewManifest } = await import('./continuity-review-v4.js')
    if (continuityAssessmentPhase(input) !== null || !input.sourceScope || lineage.revisionReceiptHash || plan.revisionAuthority || plan.supplementalSourceKey
      || manifest.subject.userId !== subject.userId || manifest.subject.novelId !== subject.novelId || input.targetType !== 'story_compilation'
      || manifest.subject.targetId !== input.targetId || manifest.subject.chapterId !== input.chapterId || manifest.subject.revision !== input.revision
      || !validContinuityReviewManifest({ manifest, bodies: input.bodies, sourceScope: input.sourceScope })
      || plan.semanticSubjectHash !== (await import('./continuity-subject-identity.js')).continuitySubjectIdentity(input))
      throw blocked('正文检查的原任务、材料或模型阶段不能认证。')
    // The physical body request retains its own reservation and one second
    // pass. It does not spend the original terminal-candidate phase claims.
    return null
  }
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

/** JSONB preserves values, not insertion order. Authenticate the complete
 * original message without rewriting its bytes or accepting duplicate keys. */
export function nativeContinuityRevisionMaterialMatches(input: Record<string, unknown>, inputHash: string, content: string) {
  try {
    const material: unknown = JSON.parse(content)
    if (!material || typeof material !== 'object' || Array.isArray(material)) return false
    // Strict JSON.parse above forbids fragments, syntax repair and trailing
    // prose; the existing parser additionally rejects duplicate object keys.
    parseQualityJsonObject(content, 'continuity')
    return runtimeJson(material).hash === inputHash && runtimeJson(input).hash === inputHash
  } catch { return false }
}

export async function authenticateNativeContinuityRevisionWork(db: Prisma.TransactionClient, ctx: Subject,
  value: unknown, historical = false, sourceReadScope?: ChapterReviewReadScope) {
  const readScope = sourceReadScope ?? (await import('./chapter-review-guard.js')).createChapterReviewReadScope()
  const work = nativeContinuityRevisionWorkSchema.parse(value)
  if (work.kind === 'revision_skip') return work
  const route = (await import('./runtime-auxiliary-call.js')).auxiliaryRouteSchema.parse(work.route)
  if (!await authenticateContinuityPhasePlan(db, ctx, work.plan) || work.plan.supplementalSourceKey
    || work.plan.compilationId !== work.compiler.id || work.plan.chapterId !== work.chapter.id
    || work.plan.phases.find(phase => phase.kind === 'prose_revision')?.limit !== 1
    || work.plan.modelPriceHash !== runtimeJson({ route: work.route, price: work.price }).hash
    || !nativeContinuityRevisionMaterialMatches(work.input, work.inputHash, work.content)
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
    const facts = await mergedRevisionFacts(db, ctx as ToolContext, work.compiler.id, readScope)
    if (!facts || facts.inputHash !== work.inputHash) throw blocked('native 集中修订前全部当前报告或正文已变化。')
    const probe = await (await import('./chapter-review-guard.js')).probeChapterReviewRevision(db, ctx, work.chapter, { mutation: 'range', mergedBatch: true, readScope })
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

async function mergedRevisionFacts(db: Prisma.TransactionClient, ctx: ToolContext, compilationId: string, sourceReadScope?: ChapterReviewReadScope) {
  const readScope = sourceReadScope ?? (await import('./chapter-review-guard.js')).createChapterReviewReadScope()
  await assertContinuityOwner(db, ctx)
  const original = await readOriginalTaskRequest(db, ctx), runs = await originalTaskRunIds(db, ctx, original)
  const saved = await db.storyCompilation.findFirst({ where: { id: compilationId, userId: ctx.userId, novelId: ctx.novelId,
    runId: { in: runs }, status: 'active' }, include: { chapter: true } })
  const audit = object(effectiveContinuityAudit(saved?.validation)), marker = object(audit.continuityV4), frozen = object(marker.frozen)
  const plan = continuityPhasePlanSchema.safeParse(object(object(marker.manifest).typedLineage).phasePlan)
  if (!saved?.chapter || audit.parserVersion !== 10 || !plan.success || plan.data.supplementalSourceKey || object(marker.manifest).candidateHash === null) return null
  const current = saved.chapter, context = object(frozen.bodies).terminalEvidence as LegacyAssessmentInput['bodies']['terminalEvidence']
  if (!context || object(saved.validation).checkedRevision !== current.revision || object(saved.validation).independentCheck !== 'complete') return null
  const guard = await import('./chapter-review-guard.js'), readiness = await guard.readChapterReviewReadiness(db, ctx, compilationId, { readScope })
  const requirements = originalChapterReviewRequirements(original, current)
  if (!readiness || readiness.continuity !== 'complete' || requirements.quality && readiness.quality !== 'complete') return null
  const binding = await (await import('./terminal-draft-authority.js')).readTerminalDraftBinding(db, { ...ctx, compilationId },
    { taskId: original.taskId, preparedContext: saved.preparedContext }, current, saved.validation, context, readScope.terminalDraftScope, readScope.inheritanceScope)
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

export async function readContinuityPhaseClaim(db: Prisma.TransactionClient, subject: Subject, input: {
  plan: ContinuityPhasePlan; chapterId: string; phase: ContinuityPhasePlan['phases'][number]['kind']; operationRef: string; inputHash: string;
}) {
  if (!await authenticateContinuityPhasePlan(db, subject, input.plan)) return false
  const claim = await readOriginalContinuityPhaseClaim(db, subject, input.plan, input.chapterId, input.phase)
  return !!claim && claim.operationRef === input.operationRef && claim.exactInputHash === input.inputHash
}
/** Read the one existing claim without recursing into plan authentication.
 * A historical claim proves its old phase identity, never another paid slot. */
async function readOriginalContinuityPhaseClaim(db: Prisma.TransactionClient, subject: Subject, plan: ContinuityPhasePlan, chapterId: string,
  phase: ContinuityPhasePlan['phases'][number]['kind'], savedRow?: { runId: string; artifactType: string; metadata: unknown }) {
  const original = await readOriginalTaskRequest(db, subject)
  if (!validContinuityPhasePlan(plan) || plan.originalTaskId !== original.taskId || plan.chapterId !== chapterId) return null
  const row = savedRow ?? await db.agentArtifact.findUnique({ where: { id: continuityPhaseClaimId(plan, chapterId, phase) } })
  if (!row || row.artifactType !== 'continuityReview' || object(row.metadata).version !== 1
    || !(await originalTaskRunIds(db, subject, original)).includes(row.runId)) return null
  const claim = z.object({ version: z.literal(1), planHash: hash, originalTaskId: z.string().min(1), phase: z.string().min(1),
    ordinal: z.literal(0), operationRef: z.string().min(1), exactInputHash: hash, ownerEpoch: z.string().min(1) }).strict()
    .safeParse(object(row.metadata).continuityPhaseClaim)
  return claim.success && claim.data.planHash === plan.hash && claim.data.originalTaskId === original.taskId
    && claim.data.phase === phase ? claim.data : null
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
      ...(marker.projectionNormalization ? { projectionNormalization: marker.projectionNormalization } : {}),
      manifest: marker.manifest, first: marker.first, repair: marker.repair ?? null }).hash ? audit : null
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
  return rebuildContinuitySourceProvenance(db, subject, target)
}

const frozenSourceHistorySchema = z.array(z.object({ reservationId: z.string().min(1), reportHash: hash, ledgerHash: hash,
  inputHash: hash, usageIds: z.array(z.string().min(1)) }).strict()).min(1).max(1000)
type FrozenSourceHistory = z.infer<typeof frozenSourceHistorySchema>
type AppliedSourceReport = { reservationId: string; reportHash: string; revision: number; bodyHash: string;
  establishedIssues: Array<{ reportHash: string; findingId: string; text: string;
    origin: { chapterId: string; revision: number; bodyHash: string; sourceHash: string } }> }
const sourceLedgerMismatch = () => blocked('原持续事实与完整已应用报告的来源重建不一致；未更改原 ledger。')

async function rebuildContinuitySourceProvenance(db: Prisma.TransactionClient, subject: Subject,
  target: { compilationId: string; chapterId: string; preparedContext: unknown }, priorLedgerHash?: string,
  snapshot?: { history: FrozenSourceHistory }) {
  const original = await readOriginalTaskRequest(db, subject), runIds = await originalTaskRunIds(db, subject, original)
  const lifecycle = await import('./assessment-response-lifecycle.js'), coverage = await import('./terminal-fact-coverage.js')
  const rows = await db.agentArtifact.findMany({ where: { runId: { in: runIds }, run: { userId: subject.userId, novelId: subject.novelId },
    artifactType: 'continuityReview' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 1001 })
  if (rows.length > 1000) throw blocked('连续性来源记录超出有界重建范围。')
  let state: import('./terminal-fact-coverage.js').TerminalCoverageState | undefined
  const origins = new Map<string, { factId: string; reservationId: string; reportHash: string; bodyHash: string; sourceHash: string; candidateHash: string; revision: number }>()
  const history: Array<{ reservationId: string; reportHash: string; ledgerHash: string; inputHash: string; usageIds: string[] }> = []
  let latestAppliedReport: AppliedSourceReport | null = null
  const replayLegacyReceipts: Array<() => void> = []
  const snapshotIds = snapshot ? new Set(snapshot.history.map(item => item.reservationId)) : undefined
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
    const normalization = applications.some(application => object(application.metadata).projectionNormalization !== undefined)
    const bound = lifecycle.bindLegacyContinuityAssessment(result.inspected, context, input, applications.some(application => object(object(application.metadata).projectionNormalization).version === 2) ? 2 : normalization)
    if (!bound.complete || !result.billingKnown || !result.providerComplete || !result.recoveryReady)
      throw blocked('原应用记录没有完整且已结算的独立报告来源。')
    if (!applications.every(application => {
      const receipt = object(application.metadata)
      return receipt.version === 1 && receipt.reservationId === row.id && Array.isArray(receipt.usageIds)
        && (!normalization || runtimeJson(receipt.projectionNormalization).hash === runtimeJson(object(object(bound.audit).continuityV4).projectionNormalization).hash)
        && runtimeJson([...new Set(receipt.usageIds)].sort()).hash === runtimeJson([...new Set(result.usageIds)].sort()).hash
        && receipt.usageIds.length === result.usageIds.length
    })) throw blocked('原报告应用回执的预约或费用归属不一致。')
    const evidence = input.bodies.terminalEvidence
    if (input.parserVersion === 10 && input.terminalCandidate === undefined && input.continuityManifest?.candidateHash === null) {
      const projection = (await import('./continuity-review-v4.js')).validateStoredContinuityV4Projection(bound.audit, input.bodies.current, evidence)
      if (!projection?.complete || projection.terminalReview) throw blocked('原正文报告不能重建，未作为终态来源。')
      // Its actual issues are carried into the first candidate lineage above.
      // A body report cannot advance facts or certify a terminal ledger entry.
      continue
    }
    const review = (await import('./authenticated-continuity-assessment.js')).readAuthenticatedContinuityAssessment(bound.audit,
      input.bodies.current, evidence, true)
    if (!review || !evidence?.factCoverage) throw blocked('原报告持续义务不能完整重建。')
    const frozenCoverage = evidence.factCoverage
    // Later authenticated applications belong to their own ledger. They must
    // not be interpreted or included in this previously frozen source.
    if (snapshotIds && !snapshotIds.has(row.id)) continue
    const reportHash = runtimeJson(bound.audit).hash, inputHash = runtimeJson(input).hash
    const frozenEntry = snapshot?.history[history.length]
    if (snapshot && (!frozenEntry || frozenEntry.reservationId !== row.id || frozenEntry.reportHash !== reportHash
      || frozenEntry.inputHash !== inputHash || runtimeJson(frozenEntry.usageIds).hash !== runtimeJson(result.usageIds).hash))
      throw sourceLedgerMismatch()
    const origin = { chapterId: target.chapterId, revision: input.revision, bodyHash: runtimeJson({ content: input.bodies.current }).hash,
      sourceHash: runtimeJson({ previous: evidence.previous }).hash }
    const classify = (await import('./continuity-finding-authority.js')).classifyContinuityFindingAuthority
    const rawFindings = 'parsed' in bound && bound.parsed ? bound.parsed.record.findings : null
    const establishedIssues = bound.findings.flatMap((finding, index) => {
      const classified = classify(finding, original.prompt, input.bodies)
      if (classified.severity !== 'error') return []
      const raw = Array.isArray(rawFindings) ? object(rawFindings[index]) : null
      return [{ reportHash, findingId: typeof raw?.findingId === 'string' ? raw.findingId : String(index),
        text: bound.audit.parserVersion === 10 && typeof raw?.explanation === 'string' ? raw.explanation
          : typeof raw?.reason === 'string' ? raw.reason : finding.evidence, origin }]
    })
    const applyReceipt = (legacy: boolean) => {
      const chapter = { id: target.chapterId, content: input.bodies.current }, prepared = state ? { terminalFactCoverage: state } : {}
      state = legacy
        ? coverage.replayLegacyTerminalCoverageReceipt(original.spec, prepared, chapter, review, frozenCoverage)
        : coverage.advanceTerminalCoverage(original.spec, prepared, chapter, review, frozenCoverage)
      if (!state) throw blocked('原持续事实合同缺失。')
      if (legacy && frozenEntry && frozenEntry.ledgerHash !== runtimeJson(state).hash) throw sourceLedgerMismatch()
      latestAppliedReport = { reservationId: row.id, reportHash, revision: input.revision, bodyHash: origin.bodyHash, establishedIssues }
      for (const fact of state.facts) if (!origins.has(fact.id)) origins.set(fact.id, { factId: fact.id, reservationId: row.id, reportHash,
        bodyHash: origin.bodyHash, sourceHash: origin.sourceHash, candidateHash: runtimeJson(input.terminalCandidate).hash, revision: input.revision })
      history.push({ reservationId: row.id, reportHash, ledgerHash: runtimeJson(state).hash, inputHash, usageIds: result.usageIds })
    }
    applyReceipt(false)
    if (snapshot) replayLegacyReceipts.push(() => applyReceipt(true))
  }
  if (snapshot && history.length !== snapshot.history.length) throw sourceLedgerMismatch()
  const current = coverage.readTerminalCoverageState(original.spec, target.preparedContext, target.chapterId)
  const currentState = state as import('./terminal-fact-coverage.js').TerminalCoverageState | undefined
  if (!currentState || !current) throw sourceLedgerMismatch()
  const ledgerMatches = priorLedgerHash ? runtimeJson(currentState).hash === priorLedgerHash
    : runtimeJson(currentState).hash === runtimeJson(current).hash && current.facts.every(fact => origins.has(fact.id))
  if (!ledgerMatches) {
    if (!priorLedgerHash || !snapshot) throw sourceLedgerMismatch()
    // The whole current walk has authenticated every applied receipt. Replay
    // only those same frozen receipts in memory; do not repeat database reads.
    state = undefined; origins.clear(); history.length = 0; latestAppliedReport = null
    for (const replay of replayLegacyReceipts) { subject.signal?.throwIfAborted(); replay() }
  }
  const finalState = state as import('./terminal-fact-coverage.js').TerminalCoverageState | undefined
  if (!finalState || priorLedgerHash && runtimeJson(finalState).hash !== priorLedgerHash) throw sourceLedgerMismatch()
  const finalReport = latestAppliedReport as AppliedSourceReport | null
  return { version: 1 as const, originalTaskId: original.taskId, compilationId: target.compilationId, chapterId: target.chapterId,
    ledgerHash: runtimeJson(finalState).hash, origins: [...origins.values()], history,
    currentFactIds: finalState.facts.map(fact => fact.id), latestAppliedReport: finalReport,
    establishedIssues: finalReport?.establishedIssues ?? [], dependencyScope: 'authenticated_explicit_claims_only' as const }
}

/** Read-only origins for a marked whole report. The old complete applications
 * are replayed again; a saved question/projection alone never certifies them.
 * A new report may advance lastReview without rewriting its prior origins. */
export async function readNormalizedContinuityCoverageOrigins(db: Prisma.TransactionClient, subject: Subject,
  target: { compilationId: string; chapterId: string; preparedContext: unknown }, audit: unknown) {
  if (![1, 2].includes(object(object(object(audit).continuityV4).projectionNormalization).version as number)) return null
  const phase = object(object(audit).phaseRequest)
  if (typeof phase.requestId !== 'string') return reconstructContinuitySourceProvenance(db, subject, target)
  const question = await readContinuitySupplementConsent(db, subject, phase.requestId)
  if (!question || question.frozen.input.targetId !== target.compilationId || question.frozen.input.chapterId !== target.chapterId
    || !await authenticateSupplementalContinuityReport(db, subject, audit)) return null
  const rows = await db.agentArtifact.findMany({ where: { runId: subject.runId, artifactType: 'continuityReview',
    metadata: { path: ['continuitySourceRecovery', 'originalAssessmentKey'], equals: question.frozen.originalAssessmentKey } }, take: 101 })
  if (rows.length > 100) return null
  const projections = rows.map(row => object(object(row.metadata).continuitySourceRecovery).projection)
    .filter(value => value && runtimeJson(value).hash === question.frozen.sourceRecoveryHash)
  if (projections.length !== 1 || typeof object(projections[0]).ledgerHash !== 'string') return null
  const frozen = object(projections[0]), priorLedgerHash = String(frozen.ledgerHash)
  const history = frozenSourceHistorySchema.safeParse(frozen.history)
  if (frozen.version !== 1 || !history.success
    || new Set(history.data.map(item => item.reservationId)).size !== history.data.length) throw sourceLedgerMismatch()
  const rebuilt = await rebuildContinuitySourceProvenance(db, subject, target, priorLedgerHash, { history: history.data })
  return runtimeJson(rebuilt).hash === question.frozen.sourceRecoveryHash ? rebuilt : null
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

async function readContinuitySupplementQuestion(db: Prisma.TransactionClient, subject: Subject, requestId: string): Promise<SupplementQuestion | null> {
  const row = await db.agentArtifact.findFirst({ where: { id: requestId, runId: subject.runId, run: { userId: subject.userId, novelId: subject.novelId }, artifactType: 'continuityReview' } })
  const parsed = supplementQuestionSchema.safeParse(object(row?.metadata).continuitySupplementQuestion)
  if (!parsed.success) return null
  const value = parsed.data as SupplementQuestion, { requestHash: _hash, ...body } = value
  return value.userId === subject.userId && value.novelId === subject.novelId && value.runId === subject.runId && questionBodyHash(body) === value.requestHash ? value : null
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

export async function continuitySupplementQuestionArgs(db: Prisma.TransactionClient, subject: Subject, requestId: string) {
  const question = await readContinuitySupplementQuestion(db, subject, requestId)
  if (!question) throw blocked('本次额外阶段的问题不存在或归属不一致。')
  return { requestId: question.requestId, question: question.question,
    options: [{ label: question.accept }, { label: question.reject }] }
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

const supplementExecutionId = (question: SupplementQuestion, ownerSeq: number) => runtimeJson({ kind: 'continuity_supplement_execution',
  originalFailedSubject: question.frozen.input.continuityManifest!.typedLineage!.phasePlan.supplementalSourceKey, ownerSeq }).hash

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

async function readSupplementResponse(db: Prisma.TransactionClient, subject: Subject, question: SupplementQuestion, normalize: boolean | 2 = false) {
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
  const originalInspection = { ...inspected, audit }
  let interpreted = normalize === 2 ? v4.normalizeContinuityV4ProjectionV2(originalInspection, runtimeJson(input).hash)
    : normalize ? v4.normalizeContinuityV4Projection(originalInspection, runtimeJson(input).hash) : originalInspection
  if (normalize === 2 && interpreted.audit.continuityV4.projectionNormalization?.version === 2) {
    const old = await db.agentArtifact.findUnique({ where: { id: supplementReceiptId('continuity_supplement_projection_application', question) } })
    if (old) {
      const legacy = v4.normalizeContinuityV4Projection(originalInspection, runtimeJson(input).hash)
      if (object(object(old.metadata).continuitySupplementProjectionApplication).reportHash === runtimeJson(legacy.audit).hash) interpreted = legacy
    }
  }
  return { inspected: interpreted, originalInspection, usage }
}

function supplementProjectionApplication(question: SupplementQuestion, result: NonNullable<Awaited<ReturnType<typeof readSupplementResponse>>>) {
  const normalization = result.inspected.audit.continuityV4.projectionNormalization
  return normalization ? { version: 1, requestId: question.requestId, requestHash: question.requestHash,
    originReportHash: runtimeJson(result.originalInspection.audit).hash, reportHash: runtimeJson(result.inspected.audit).hash,
    frozenInputHash: runtimeJson(question.frozen.input).hash, rawHash: normalization.rawHash,
    derivationHash: normalization.derivationHash, usageId: result.usage.id, reportComplete: true } : null
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
  const result = await readSupplementResponse(db, subject, consent, object(object(object(audit).continuityV4).projectionNormalization).version === 2 ? 2 : object(object(object(audit).continuityV4).projectionNormalization).version === 1)
  if (!result?.inspected.complete || runtimeJson(result.inspected.audit).hash !== runtimeJson(audit).hash) return false
  const expected = supplementProjectionApplication(consent, result)
  if (expected) {
    const original = await db.agentArtifact.findUnique({ where: { id: supplementReceiptId('continuity_supplement_application', consent) } })
    const base = object(object(original?.metadata).continuitySupplementApplication)
    if (base.requestId !== consent.requestId || base.reportComplete !== result.originalInspection.complete || base.reportHash !== expected.originReportHash
      || base.usageId !== result.usage.id || base.classification !== result.originalInspection.audit.classification) return false
    const applied = await db.agentArtifact.findUnique({ where: { id: supplementReceiptId('continuity_supplement_projection_application', consent) } })
    if (applied) return runtimeJson(object(applied.metadata).continuitySupplementProjectionApplication).hash === runtimeJson(expected).hash
    // Before the report-save CAS, the source is still exactly the old frozen
    // validation. After it is persisted, the derived application is mandatory;
    // both are committed in the same existing transaction.
    const saved = await db.storyCompilation.findFirst({ where: { id: consent.frozen.input.targetId, userId: subject.userId, novelId: subject.novelId }, select: { validation: true } })
    return !!saved && runtimeJson(saved.validation).hash === consent.frozen.validationHash
  }
  return true
}

export async function readContinuitySupplementState(db: Prisma.TransactionClient, subject: Subject, originalAssessmentKey: string) {
  const rows = await db.agentArtifact.findMany({ where: { runId: subject.runId, run: { userId: subject.userId, novelId: subject.novelId }, artifactType: 'continuityReview',
    metadata: { path: ['continuitySupplementQuestion', 'frozen', 'originalAssessmentKey'], equals: originalAssessmentKey } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 101 })
  if (rows.length > 100) throw blocked('原授权问题历史超出有界范围。')
  for (const row of rows) {
    const question = await readContinuitySupplementConsent(db, subject, row.id)
    if (!question) continue
    const result = await readSupplementResponse(db, subject, question, 2)
    const applied = await db.agentArtifact.findUnique({ where: { id: supplementReceiptId('continuity_supplement_application', question) } })
    if (applied) {
      const expected = result && supplementProjectionApplication(question, result)
      if (expected) {
        const base = object(object(applied.metadata).continuitySupplementApplication)
        if (base.requestId !== question.requestId || base.usageId !== result.usage.id || base.reportComplete !== result.originalInspection.complete
          || base.reportHash !== expected.originReportHash || base.classification !== result.originalInspection.audit.classification)
          throw blocked('原失败报告的不可变应用回执与派生来源不一致。')
        const normalized = await db.agentArtifact.findUnique({ where: { id: supplementReceiptId('continuity_supplement_projection_application', question) } })
        if (!normalized) return { kind: 'known_result' as const, question, result }
        if (runtimeJson(object(normalized.metadata).continuitySupplementProjectionApplication).hash !== runtimeJson(expected).hash)
          throw blocked('原完整报告的唯一派生应用回执不一致。')
      }
      return { kind: 'applied' as const, question, result }
    }
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
