import { terminalCandidateSchema as historyCandidateSchema } from './terminal-candidate-contract.js'
import { terminalCandidateFacts as historyCandidateFacts, terminalFactId as historyFactId } from './terminal-fact-identity.js'
import type { Prisma } from '@prisma/client'
import type { ToolContext } from './tools/types.js'
import { terminalCarriedFactSchema, type TerminalEvidenceContext } from './terminal-evidence-context.js'
import { z } from 'zod'
import type { TerminalInheritanceReadScope } from './terminal-inheritance-chain.js'
import type { TerminalDeliveryBinding } from './terminal-state-review.js'
import { runtimeJson } from './runtime-common.js'
import { authenticateEffectiveContinuityReport, effectiveContinuityAudit } from './continuity-coordinator.js'

type Identity = { userId: string; novelId: string; taskId: string; compilationId: string; chapterId: string; bodyHash: string;
  sourceHash: string; candidateHash: string; evidenceHash: string; preparedHash: string; auditHash: string; revisionHash: string }
const reviewAuthority = new WeakMap<object, string>()
export type TerminalPreservationPolicy = { version: 1; policyHash: string;
  inherited: Array<{ path: string; proofHash: string; sourceNodesHash: string }>;
  pendingCoverageIds: string[] }
const scopeAuthority = new WeakMap<object, { identityHash: string; policy: TerminalPreservationPolicy }>()
export function authenticatedTerminalPreservation(token: unknown, identity: Identity) {
  const value = token && typeof token === 'object' ? scopeAuthority.get(token) : undefined
  return value?.identityHash === runtimeJson(identity).hash ? value.policy : undefined
}
export function authenticatedTerminalReviewAuthority(token: unknown, identity: Identity) {
  return !!token && typeof token === 'object' && reviewAuthority.get(token) === runtimeJson(identity).hash
}
const authority = new WeakMap<object, { identityHash: string; ids: readonly string[]; originHashes: readonly string[] }>()
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export type TerminalDraftReadScope = WeakMap<object, Map<string, Promise<TerminalDeliveryBinding>>>

export function terminalDraftIdentity(binding: TerminalDeliveryBinding, context: TerminalEvidenceContext, candidateHash: string, auditHash: string, revisionHash: string): Identity {
  return { userId: binding.userId ?? '', novelId: binding.novelId ?? '', taskId: binding.taskId, compilationId: binding.compilationId ?? '', chapterId: context.current.id,
    bodyHash: context.current.contentHash, sourceHash: runtimeJson({ previous: context.previous }).hash, candidateHash,
    evidenceHash: runtimeJson(context).hash, preparedHash: runtimeJson(binding.preparedContext).hash, auditHash, revisionHash }
}

/** Only a live object minted below has authority. JSON, copied properties and
 * model arguments cannot supply a certificate; every caller rebinds identity. */
export function authenticatedTerminalDraftIds(token: unknown, identity: Identity): readonly string[] {
  const proof = token && typeof token === 'object' ? authority.get(token) : undefined
  return proof?.identityHash === runtimeJson(identity).hash ? proof.ids : []
}

/** Authenticate once for this compilation/chapter invocation. Nothing is
 * persisted and no cross-request cache exists. Imports are lazy so the pure
 * current-review gate never initializes the response lifecycle recursively. */
export async function readTerminalDraftBinding(db: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string; compilationId: string; signal?: AbortSignal }, binding: TerminalDeliveryBinding,
  chapter: { id: string; revision: number; orderIndex: number; content: string }, validation: unknown,
  context?: TerminalEvidenceContext, scope?: TerminalDraftReadScope, inheritanceScope?: TerminalInheritanceReadScope): Promise<TerminalDeliveryBinding> {
  subject.signal?.throwIfAborted()
  if (!scope) return loadTerminalDraftBinding(db, subject, binding, chapter, validation, context, inheritanceScope)
  let cache = scope.get(db)
  if (!cache) { cache = new Map(); scope.set(db, cache) }
  const key = runtimeJson({ userId: subject.userId, novelId: subject.novelId, runId: subject.runId, compilationId: subject.compilationId,
    taskId: binding.taskId, chapter: { id: chapter.id, revision: chapter.revision, orderIndex: chapter.orderIndex, bodyHash: runtimeJson({ content: chapter.content }).hash },
    preparedContext: binding.preparedContext, context: context ?? null,
    audit: object(validation).continuityCriticResponse ?? null, effectiveReport: object(validation).effectiveReport ?? null, candidate: object(validation).terminalCandidate ?? null,
    newDraftRevision: object(validation).newDraftRevision ?? null, retainedReviewDecision: object(validation).retainedReviewDecision ?? null }).hash
  if (!cache.has(key)) cache.set(key, loadTerminalDraftBinding(db, subject, binding, chapter, validation, context, inheritanceScope))
  const result = await cache.get(key)!
  subject.signal?.throwIfAborted()
  return result
}

async function readPreservationPolicy(db: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string; compilationId: string; signal?: AbortSignal },
  original: Awaited<ReturnType<typeof import('./original-request.js')['readOriginalTaskRequest']>>,
  chapter: { id: string; revision: number; orderIndex: number; content: string }, validation: unknown,
  context: TerminalEvidenceContext, binding: TerminalDeliveryBinding, inheritanceScope?: TerminalInheritanceReadScope): Promise<TerminalPreservationPolicy | null> {
  const audit = effectiveContinuityAudit(validation)
  const review = (await import('./authenticated-continuity-assessment.js')).readAuthenticatedContinuityAssessment(audit, chapter.content, context, true)
  if (!review || context.current.id !== chapter.id || context.current.revision !== chapter.revision
    || context.current.contentHash !== runtimeJson({ content: chapter.content }).hash) return null
  const projected = (await import('./continuity-review-v4.js')).validateStoredContinuityV4Projection(audit, chapter.content, context)
  const errors = projected?.findings.flatMap((finding, index) => finding.severity === 'error' ? [String(index)] : []) ?? []
  if (errors.length) {
    const guard = await import('./chapter-review-guard.js'), reportId = guard.continuityDecisionBinding(subject.compilationId, chapter.revision, validation)
    if (!guard.retainedReviewDecisionMatches(validation, chapter, subject.compilationId, undefined,
      errors.map(findingId => ({ source: 'continuity', reportId, findingId })))) return null
  }
  const unknown = review.verdicts.filter(item => item.verdict !== 'supported')
  const pending = review.factCoverage?.dispositions.filter(item => item.outcome === 'unknown') ?? []
  if (!unknown.length && !pending.length) return null
  const source = context.previous ? await (await import('./compiler-continuity-source.js')).readCompilerContinuitySource(db,
    subject, chapter, context.previous.id, 11, inheritanceScope) : null
  const parsedProofs = z.array(terminalCarriedFactSchema).max(200).safeParse(source && 'terminalInheritance' in source ? source.terminalInheritance : [])
  const currentProofs = parsedProofs.success ? parsedProofs.data : []
  const catalog = (await import('./terminal-proof-verdict.js')).terminalProofCatalog(review.candidate, context)
  const inherited: TerminalPreservationPolicy['inherited'] = []
  for (const verdict of unknown) {
    if (verdict.verdict !== 'unknown' || !('basis' in verdict) || verdict.basis !== 'inherited') continue
    const matches = catalog.filter(entry => entry.paths.includes(verdict.path))
    if (matches.length !== 1) continue
    const fact = matches[0].fact, check = review.proofChecks?.find(item => item.proofHash === fact.proofHash)
    const verified = currentProofs.filter(item => item.proofHash === fact.proofHash)
    if (check?.currentState !== 'uncertain' || verified.length !== 1 || runtimeJson(verified[0]).hash !== runtimeJson(fact).hash) continue
    inherited.push({ path: verdict.path, proofHash: fact.proofHash, sourceNodesHash: runtimeJson(fact.nodes).hash })
  }
  const pendingCoverageIds: string[] = []
  let priorScope: { policyHash?: string; pendingCoverageIds?: string[] } | null = null
  const spec = object(original.spec), prompt = (original.prompt ?? '').trim()
  const onlyNextChapter = /^(?:请)?(?:继续)?(?:写|续写)(?:出)?(?:一下)?(?:下|下一)章[。！!\s]*$/u.test(prompt)
    || /^write the next chapter[.!\s]*$/iu.test(prompt)
  const onlyRevision = /^(?:请)?(?:修改|改写|修订)第[一二三四五六七八九十百千零〇两0-9]+章(?:[，,]\s*只输出标题和正文)?[。！!\s]*$/u.test(prompt)
  let boundedRevision = false
  if (pending.length && onlyRevision) {
    const scope = await (await import('./writing-scope.js')).readWritingScope(db, subject)
    boundedRevision = scope.writing?.kind === 'bounded' && scope.writing.targets.some(target => target.chapterId === chapter.id && target.orderIndex === chapter.orderIndex)
  }
  const noHardObligations = ['hardConstraints', 'postconditions'].every(key => spec[key] === undefined || Array.isArray(spec[key]) && !spec[key].length)
  if (pending.length && (onlyNextChapter || boundedRevision) && noHardObligations) {
    const origins = await (await import('./continuity-coordinator.js')).readNormalizedContinuityCoverageOrigins(db, subject,
      { compilationId: subject.compilationId, chapterId: chapter.id, preparedContext: binding.preparedContext }, audit)
    if (origins) priorScope = await uncommittedCoverageHistory(db, subject, chapter, validation)
    const ledger = (await import('./terminal-fact-coverage.js')).readTerminalCoverageState(original.spec, binding.preparedContext, chapter.id)
    const facts = historyCandidateFacts(review.candidate)
    for (const disposition of pending) {
      const obligation = context.factCoverage?.obligations.find(item => item.id === disposition.id)
      const origin = origins?.origins.find(item => item.factId === disposition.id)
      if (!priorScope || !obligation || obligation.field !== 'openLoops' || !origin || origin.revision > chapter.revision
        || !ledger?.facts.some(item => item.id === obligation.id && item.field === obligation.field && item.claim === obligation.claim)
        || facts.some(item => item.id === obligation.id) || currentProofs.some(item => historyFactId(item.field, item.claim) === obligation.id)) continue
      // A completed canonical chapter containing this exact claim makes it a
      // real inherited obligation, even if the same text also occurred here.
      const canonical = await db.storyCompilation.count({ where: { userId: subject.userId, novelId: subject.novelId,
        status: 'completed', stage: 'commit', bridge: { is: { committedAt: { not: null } } },
        validation: { path: ['terminalCandidate', 'exitState', 'openLoops'], array_contains: [obligation.claim] } } })
      if (!canonical) pendingCoverageIds.push(obligation.id)
    }
  }
  if (!inherited.length && !pendingCoverageIds.length) return null
  subject.signal?.throwIfAborted()
  const { preparedHash: _bookkeeping, ...identity } = terminalDraftIdentity(binding, context, review.candidateHash, runtimeJson(audit).hash,
    runtimeJson({ newDraftRevision: object(validation).newDraftRevision ?? null, retainedReviewDecision: object(validation).retainedReviewDecision ?? null }).hash)
  const value = { version: 1 as const, contractHash: runtimeJson({ prompt: original.prompt ?? null, spec: original.spec }).hash,
    identity, inherited, pendingCoverageIds }
  const policyHash = runtimeJson(value).hash
  if (pendingCoverageIds.length && priorScope?.policyHash && (priorScope.policyHash !== policyHash
    || runtimeJson(priorScope.pendingCoverageIds).hash !== runtimeJson(pendingCoverageIds).hash)) return null
  return { version: 1, policyHash, inherited, pendingCoverageIds }
}

/** Reopening clears bridge.committedAt, but it must not erase canonical
 * history. Negative proofs include retained compiler proofs and both actual
 * executor receipt paths. An unknown or unbounded history grants nothing. */
async function uncommittedCoverageHistory(db: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string; compilationId: string },
  chapter: { id: string; revision: number; content: string }, validation: unknown): Promise<{ policyHash?: string; pendingCoverageIds?: string[] } | null> {
  const audit = effectiveContinuityAudit(validation), pointer = object(object(validation).effectiveReport)
  const report = await db.agentArtifact.findFirst({ where: { id: String(pointer.reportArtifactId), artifactType: 'continuityReview',
    run: { userId: subject.userId, novelId: subject.novelId } }, select: { createdAt: true } })
  if (!report || !Number.isFinite(report.createdAt.getTime())) return null
  const compilations = await db.storyCompilation.findMany({ where: { userId: subject.userId, novelId: subject.novelId, chapterId: chapter.id },
    select: { id: true, preparedContext: true, bridge: { select: { committedAt: true, targetRevision: true } },
      chapter: { select: { revision: true, content: true } } }, take: 129 })
  if (compilations.length > 128 || !compilations.some(compilation => compilation.id === subject.compilationId)) return null
  let policyHash: string | undefined
  let pendingCoverageIds: string[] | undefined
  for (const compilation of compilations) {
    const prepared = object(compilation.preparedContext), proof = object(prepared.terminalReviewProof)
    if (!Object.keys(proof).length && !(Array.isArray(prepared.terminalFactProofs) && prepared.terminalFactProofs.length)
      && prepared.terminalContentHash === undefined && prepared.terminalCandidateHash === undefined && !compilation.bridge?.committedAt) continue
    const own = object(proof.scopePreservation)
    if (compilation.id !== subject.compilationId || own.version !== 1 || own.auditHash !== runtimeJson(audit).hash
      || typeof own.policyHash !== 'string' || !/^[a-f0-9]{64}$/u.test(own.policyHash)
      || !Array.isArray(own.pendingCoverageIds) || own.pendingCoverageIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/u.test(id))
      || new Set(own.pendingCoverageIds).size !== own.pendingCoverageIds.length
      || !compilation.bridge?.committedAt || compilation.bridge.targetRevision !== chapter.revision
      || compilation.chapter?.revision !== chapter.revision || compilation.chapter.content !== chapter.content) return null
    policyHash = own.policyHash
    pendingCoverageIds = own.pendingCoverageIds as string[]
  }
  const targetChapter = async (compilationId: unknown) => {
    if (typeof compilationId !== 'string') return null
    return db.storyCompilation.findFirst({ where: { id: compilationId, userId: subject.userId, novelId: subject.novelId }, select: { chapterId: true } })
  }
  const events = await db.agentRunEvent.findMany({ where: { run: { userId: subject.userId, novelId: subject.novelId }, type: 'tool.result',
    createdAt: { lt: report.createdAt }, AND: [{ payload: { path: ['toolName'], equals: 'chapter_bridge_commit' } },
      { payload: { path: ['ok'], equals: true } }] }, take: 1001 })
  if (events.length > 1000) return null
  for (const event of events) {
    const payload = object(event.payload)
    if (typeof payload.callId !== 'string') return null
    const calls = await db.agentRunEvent.findMany({ where: { runId: event.runId, type: 'tool.call',
      payload: { path: ['callId'], equals: payload.callId } }, take: 2 })
    const call = object(calls[0]?.payload), args = object(call.args), compilationId = object(payload.display).compilationId
    if (calls.length !== 1 || call.toolName !== 'chapter_bridge_commit' || args.compilationId !== compilationId) return null
    if (args.decisionOnly === true && object(payload.display).phase === 'check') continue
    if (args.decisionOnly === true || object(payload.display).phase !== 'commit') return null
    const target = await targetChapter(compilationId)
    if (!target || target.chapterId === chapter.id) return null
  }
  const effects = await db.agentEffectReceipt.findMany({ where: { createdAt: { lt: report.createdAt },
    operation: { action: 'chapter_bridge_commit', taskRoot: { userId: subject.userId, novelId: subject.novelId } } },
  include: { operation: true }, take: 1001 })
  if (effects.length > 1000) return null
  for (const effect of effects) {
    const event = await db.agentExecutionOutbox.findFirst({ where: { operationId: effect.operationId, type: 'effect.committed', eventKey: `effect:${effect.operationId}` } })
    if (effect.operation.status !== 'succeeded' || runtimeJson(effect.result).hash !== effect.resultHash
      || object(event?.payload).operationId !== effect.operationId || object(event?.payload).resultHash !== effect.resultHash) return null
    const display = object(object(object(effect.result).toolResult).display)
    const args = object(object(object(effect.operation.inputSnapshot).input).args)
    if (args.decisionOnly === true && display.phase === 'check') continue
    if (args.decisionOnly === true || display.phase !== 'commit') return null
    const target = await targetChapter(object(object(object(effect.result).toolResult).display).compilationId)
    if (!target || target.chapterId === chapter.id) return null
  }
  return policyHash ? { policyHash, pendingCoverageIds } : {}
}

async function loadTerminalDraftBinding(db: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string; compilationId: string; signal?: AbortSignal }, binding: TerminalDeliveryBinding,
  chapter: { id: string; revision: number; orderIndex: number; content: string }, validation: unknown,
  context?: TerminalEvidenceContext, inheritanceScope?: TerminalInheritanceReadScope): Promise<TerminalDeliveryBinding> {
  const base: TerminalDeliveryBinding = { ...binding, userId: subject.userId, novelId: subject.novelId, compilationId: subject.compilationId }
  delete base.draftAuthority
  delete base.reviewAuthority
  delete base.scopeAuthority
  const currentAudit = object(object(validation).continuityCriticResponse)
  if (object(validation).effectiveReport !== undefined && !effectiveContinuityAudit(validation)) return base
  let nativeEntries: Awaited<ReturnType<typeof import('./native-continuity-assessment.js')['readNativeContinuityAssessments']>> | undefined
  let authenticatedSupplemental = false
  if (currentAudit.parserVersion === 9 || currentAudit.parserVersion === 10) {
    if (!context || typeof db.agentArtifact?.findMany !== 'function') return base
    const { readOriginalTaskRequest, originalTaskRunIds } = await import('./original-request.js')
    const original = await readOriginalTaskRequest(db, subject)
    if (original.taskId !== binding.taskId) return base
    const runIds = await originalTaskRunIds(db, subject, original)
    try {
      if (currentAudit.parserVersion === 10 && !await authenticateEffectiveContinuityReport(db, subject, subject.compilationId, validation, runIds)) return base
      const lifecycle = await import('./assessment-response-lifecycle.js')
      const request = object(currentAudit.assessmentRequest)
      let authentic = false
      if (currentAudit.parserVersion === 10 && object(currentAudit.phaseRequest).version === 1) {
        authenticatedSupplemental = await (await import('./continuity-coordinator.js')).authenticateSupplementalContinuityReport(db, subject, currentAudit)
        authentic = authenticatedSupplemental
      } else if (typeof request.key === 'string') {
        const reservations = await db.agentArtifact.findMany({ where: { runId: { in: runIds }, run: { userId: subject.userId, novelId: subject.novelId },
          artifactType: 'continuityReview', metadata: { path: ['continuityAssessmentRequestKey'], equals: request.key } }, take: 2 })
        const meta = object(reservations[0]?.metadata), parsed = lifecycle.legacyAssessmentInputSchema.safeParse(meta.input)
        if (reservations.length !== 1 || !parsed.success || parsed.data.parserVersion !== currentAudit.parserVersion || parsed.data.continuityManifest?.subject.taskId !== original.taskId
          || typeof meta.callId !== 'string' || request.inputHash !== runtimeJson(parsed.data).hash) return base
        const source = { ...subject, runId: reservations[0].runId, callId: meta.callId } as unknown as ToolContext
        if (lifecycle.legacyContinuityAssessmentKey(source, parsed.data) !== request.key) return base
        const result = await lifecycle.readLegacyContinuityAssessment(db, source, parsed.data)
        const bound = lifecycle.bindLegacyContinuityAssessment(result.inspected, source, parsed.data,
          object(object(currentAudit.continuityV4).projectionNormalization).version === 1)
        authentic = bound.complete && result.billingKnown && result.providerComplete && result.recoveryReady
          && runtimeJson(bound.audit).hash === runtimeJson(currentAudit).hash
      } else {
        const native = await import('./native-continuity-assessment.js')
        const artifacts = await db.agentArtifact.findMany({ where: { runId: { in: runIds }, run: { userId: subject.userId, novelId: subject.novelId }, artifactType: 'continuityReview' }, take: 1001 })
        if (artifacts.length > 1000) return base
        const projected = (await import('./continuity-review-v4.js')).validateStoredContinuityV4Projection(currentAudit, chapter.content, context)
        const ids = new Set(projected?.terminalReview?.proposals?.dispositions.filter(item => item.outcome === 'unknown').map(item => item.id) ?? [])
        nativeEntries = await native.readNativeContinuityAssessments(db, subject, original.taskId, runIds,
          { compilationId: subject.compilationId, chapterId: chapter.id, currentAudit, related: input => relevantDraftHistoryInput(input, ids) }, artifacts)
        const entries = nativeEntries
        authentic = !!entries?.some(entry => entry.current && entry.inspected.complete)
      }
      if (!authentic) return base
      subject.signal?.throwIfAborted()
      const token = Object.freeze({})
      reviewAuthority.set(token, runtimeJson(terminalDraftIdentity(base, context, runtimeJson(currentAudit.terminalCandidate).hash,
        runtimeJson(currentAudit).hash, runtimeJson({ newDraftRevision: object(validation).newDraftRevision ?? null, retainedReviewDecision: object(validation).retainedReviewDecision ?? null }).hash)).hash)
      base.reviewAuthority = token
      if (object(object(currentAudit.continuityV4).projectionNormalization).version === 1) {
        const policy = await readPreservationPolicy(db, subject, original, chapter, validation, context, base, inheritanceScope)
        if (policy) {
          const scopeToken = Object.freeze({})
          scopeAuthority.set(scopeToken, { identityHash: runtimeJson(terminalDraftIdentity(base, context,
            runtimeJson(currentAudit.terminalCandidate).hash, runtimeJson(currentAudit).hash,
            runtimeJson({ newDraftRevision: object(validation).newDraftRevision ?? null, retainedReviewDecision: object(validation).retainedReviewDecision ?? null }).hash)).hash, policy })
          base.scopeAuthority = scopeToken
        }
      }
    } catch (error) {
      subject.signal?.throwIfAborted()
      if (error instanceof (await import('../prisma.js')).DataAccessError && error.code === 'RUNTIME_SCOPE_MISMATCH') throw error
      return base
    }
  }
  if (!context?.proposalChanges) return base
  if (typeof db.agentArtifact?.findMany !== 'function' || typeof db.aiUsageLog?.findMany !== 'function') return base
  subject.signal?.throwIfAborted()
  const [{ currentTerminalReview, terminalCandidateSchema }, { terminalCandidateFacts, terminalFactId }, proposals, coverage] = await Promise.all([
    import('./terminal-state-review.js'), import('./terminal-fact-identity.js'), import('./terminal-proposal-review.js'), import('./terminal-fact-coverage.js'),
  ])
  const review = currentTerminalReview(validation, chapter.content, context, base)
  const unknown = review?.proposals?.dispositions.filter(item => item.outcome === 'unknown') ?? []
  if (!review || review.deliveryEligibility.eligible || !unknown.length || !review.verdicts.length
    || review.verdicts.some(item => item.verdict !== 'supported' && !review.deliveryEligibility.preservation?.inherited.some(proof => proof.path === item.path))
    || review.factCoverage?.version !== 2 || review.factCoverage.dispositions.some(item => item.outcome === 'unknown'
      && !review.deliveryEligibility.preservation?.pendingCoverageIds.includes(item.id))) return base
  const identity = { taskId: binding.taskId, chapterId: chapter.id, bodyHash: context.current.contentHash,
    sourceHash: runtimeJson({ previous: context.previous }).hash }
  let state: ReturnType<typeof proposals.readTerminalProposalState>
  try { state = proposals.readTerminalProposalState(binding.preparedContext, identity) } catch { return base }
  if (!state || runtimeJson(state.lastInput.input).hash !== runtimeJson(context.proposalChanges).hash) return base
  const pending = unknown.map(item => state!.pending.find(proposal => proposal.id === item.id))
  if (pending.some(item => !item)) return base
  if (pending.some(item => item && !['action', 'location', 'storyTime', 'emotion', 'knowledge', 'body', 'objects', 'relationships', 'openLoops'].includes(item.field))) return base
  const ids = new Set(pending.map(item => item!.id))
  const { readOriginalTaskRequest, originalTaskRunIds } = await import('./original-request.js')
  // Identity errors retain their existing DataAccessError boundary.
  const original = await readOriginalTaskRequest(db, subject)
  if (object(original.spec).id !== binding.taskId
    || context.current.id !== chapter.id || context.current.revision !== chapter.revision
    || context.current.orderIndex !== chapter.orderIndex || context.current.contentHash !== runtimeJson({ content: chapter.content }).hash) return base
  const runIds = await originalTaskRunIds(db, subject, original)
  const rows = await db.agentArtifact.findMany({ where: { runId: { in: runIds }, run: { userId: subject.userId, novelId: subject.novelId }, artifactType: 'continuityReview' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 1001 })
  if (rows.length > 1000) return base
  const lifecycle = await import('./assessment-response-lifecycle.js')
  const { inspectAuthenticatedContinuityAssessment, readAuthenticatedContinuityAssessment } = await import('./authenticated-continuity-assessment.js')
  const { continuityReviewManifestSchema } = await import('./continuity-review-v4.js')
  const { terminalEvidenceContextSchema } = await import('./terminal-evidence-context.js')
  const { continuitySourceScopeSchema } = await import('./continuity-source-authority.js')
  const { z } = await import('zod')
  const inputSchema = z.object({ chapterId: z.string(), revision: z.number().int(), bodies: z.object({ current: z.string(), previous: z.string().nullable(),
    terminalEvidence: terminalEvidenceContextSchema }).strict(), system: z.string(), content: z.string(), parserVersion: z.union([z.literal(8), z.literal(9), z.literal(10)]), continuityManifest: continuityReviewManifestSchema.optional(),
    reassessmentProtocol: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(7)]), terminalCandidate: terminalCandidateSchema.optional(),
    sourceScope: continuitySourceScopeSchema, bindingHash: z.string().regex(/^[a-f0-9]{64}$/u), targetType: z.literal('story_compilation'), targetId: z.string() }).strict()
  const establishes = (value: unknown) => establishedDraftHistoryInput(value, ids)
  const passesPending = (value: unknown) => passedDraftHistoryInput(value, ids)
  if (nativeEntries === undefined && typeof db.agentOperation?.findMany === 'function' && !object(currentAudit.assessmentRequest).key) {
    const run = await db.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId }, select: { taskRootId: true } })
    if (run?.taskRootId === original.taskId) nativeEntries = await (await import('./native-continuity-assessment.js')).readNativeContinuityAssessments(db, subject, original.taskId, runIds,
      { compilationId: subject.compilationId, chapterId: chapter.id, currentAudit, related: value => establishes(value) || passesPending(value) }, rows)
  }
  if (nativeEntries === null) return base
  const related = rows.filter(row => object(object(row.metadata).input).chapterId === chapter.id
    && (establishes(object(row.metadata).input) || passesPending(object(row.metadata).input)))
  if (related.some(row => object(row.metadata).version !== 1)) return base
  const reservations = related.filter(row => typeof object(row.metadata).continuityAssessmentRequestKey === 'string')
  if (!reservations.length && !nativeEntries?.length) return base
  const keys = new Set(reservations.map(row => String(object(row.metadata).continuityAssessmentRequestKey)))
  const currentRequest = object(object(object(validation).continuityCriticResponse).assessmentRequest)
  // Only the current carrier is authenticated here. Historical origins,
  // charges and body transitions still must pass below before minting authority.
  if (!keys.has(String(currentRequest.key)) && !authenticatedSupplemental
    && !nativeEntries?.some(entry => entry.current && entry.inspected.complete)) return base
  if (keys.size !== reservations.length || related.some(row => {
    const meta = object(row.metadata)
    return meta.assessmentKey !== undefined && !keys.has(String(meta.assessmentKey))
      || meta.fullReassessmentKey !== undefined && !keys.has(String(meta.fullReassessmentKey))
  })) return base
  const relevantRows = rows.filter(row => { const meta = object(row.metadata); return [meta.assessmentKey, meta.assessmentRequestOwnerKey, meta.fullReassessmentKey].some(key => keys.has(String(key))) })
  if (relevantRows.some(row => object(row.metadata).version !== 1)) return base
  const usageIds = [...new Set(relevantRows.flatMap(row => { const ids = object(row.metadata).usageIds; return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [] }))]
  const usage = usageIds.length ? await db.aiUsageLog.findMany({ where: { id: { in: usageIds }, userId: subject.userId, novelId: subject.novelId,
    agentRunId: { in: runIds }, chapterId: chapter.id, action: { startsWith: 'agent3ContinuityCritic' } } }) : []
  // Feed the normal strict lifecycle reader a finite snapshot. Unsupported
  // query shapes throw; these adapters never issue a second database query.
  const match = (row: Record<string, unknown>, where: Record<string, unknown>): boolean => Object.entries(where).every(([key, value]) => {
    const condition = object(value)
    if (key === 'metadata') {
      if (!Array.isArray(condition.path) || !Object.prototype.hasOwnProperty.call(condition, 'equals')) throw Error('Unknown draft history query')
      return condition.path.reduce((value: unknown, key: unknown) => object(value)[String(key)], row.metadata) === condition.equals
    }
    if (Object.keys(condition).length) {
      if (Object.keys(condition).length === 1 && Array.isArray(condition.in)) return condition.in.includes(row[key])
      if (Object.keys(condition).length === 1 && typeof condition.startsWith === 'string') return typeof row[key] === 'string' && (row[key] as string).startsWith(condition.startsWith)
      throw Error('Unknown draft history query')
    }
    return row[key] === value
  })
  const select = <T extends { metadata?: unknown; createdAt?: Date; id: string }>(data: T[], args: { where: Record<string, unknown>; orderBy?: Record<string, string>[] }) => {
    const selected = data.filter(row => match(row as unknown as Record<string, unknown>, args.where))
    if (args.orderBy) selected.sort((a, b) => { for (const order of args.orderBy!) for (const [key, direction] of Object.entries(order)) {
      const left = object(a)[key], right = object(b)[key]
      const compared = left instanceof Date && right instanceof Date ? left.getTime() - right.getTime() : String(left).localeCompare(String(right))
      if (compared) return compared * (direction === 'desc' ? -1 : 1)
    } return 0 })
    return selected
  }
  const snapshot = { agentArtifact: { findMany: async (args: Parameters<typeof select>[1]) => select(rows, args),
    findFirst: async (args: Parameters<typeof select>[1]) => select(rows, args)[0] ?? null },
  aiUsageLog: { findMany: async (args: Parameters<typeof select>[1]) => select(usage, args) } } as unknown as Prisma.TransactionClient
  try {
    const ledger = coverage.readTerminalCoverageState(original.spec, binding.preparedContext, chapter.id)
    if (ledger?.facts.some(fact => ids.has(fact.id))) return base
    const origins = new Map<string, string>()
    const revisions = new Map<string, Promise<boolean>>()
    for (const reservation of reservations) {
      subject.signal?.throwIfAborted()
      const meta = object(reservation.metadata), parsed = inputSchema.safeParse(meta.input)
      if (!parsed.success || typeof meta.callId !== 'string') return base
      // This is a read-only lifecycle identity, never a tool execution context.
      const frozen = parsed.data, ctx = { ...subject, runId: reservation.runId, callId: meta.callId } as unknown as ToolContext
      if (meta.continuityAssessmentRequestKey !== lifecycle.legacyContinuityAssessmentKey(ctx, frozen)) return base
      if (meta.continuityAssessmentRequestKey === currentRequest.key && currentRequest.inputHash !== runtimeJson(frozen).hash) return base
      const evidence = frozen.bodies.terminalEvidence
      if ([...(evidence.proposalChanges?.verifiedFactIds ?? []), ...(evidence.factCoverage?.obligations.map(fact => fact.id) ?? []),
        ...(evidence.previous?.carried?.map(fact => terminalFactId(fact.field, fact.claim)) ?? [])].some(id => ids.has(id))) return base
      const result = await lifecycle.readLegacyContinuityAssessment(snapshot, ctx, frozen)
      if (!result.billingKnown || !result.providerComplete || !result.recoveryReady) return base
      const bound = lifecycle.bindLegacyContinuityAssessment(result.inspected, ctx, frozen)
      const auditHash = runtimeJson(bound.audit).hash
      if (meta.continuityAssessmentRequestKey === currentRequest.key && auditHash !== runtimeJson(object(validation).continuityCriticResponse).hash) return base
      const frames = relevantRows.filter(row => object(row.metadata).assessmentKey === meta.continuityAssessmentRequestKey)
      const inspections = []
      for (const row of frames) {
        const frame = object(row.metadata), response = object(frame.response)
        if (typeof response.content !== 'string' || response.transportComplete !== true || response.finishReason !== 'stop'
          || !Array.isArray(response.toolCalls) || response.toolCalls.length) return base
        const raw: unknown = JSON.parse(response.content)
        if (typeof raw !== 'string') return base
        const inspected = inspectAuthenticatedContinuityAssessment(raw, frozen, true)
        if (runtimeJson(inspected.audit).hash !== runtimeJson(frame.audit).hash) return base
        inspections.push({ frame, inspected })
        if (frozen.terminalCandidate && inspected.complete) {
          const historical = readAuthenticatedContinuityAssessment(inspected.audit, frozen.bodies.current, evidence, true)
          if (!historical) return base
          const candidateFacts = terminalCandidateFacts(frozen.terminalCandidate)
          if (historical.verdicts.some(verdict => verdict.verdict === 'supported' && candidateFacts.some(fact => ids.has(fact.id) && fact.path === verdict.path))) return base
        }
      }
      if (!result.inspected.complete) {
        // A failed report which merely forwards this exact pending object
        // cannot establish it. Authenticate the whole final request anyway;
        // unknown billing, lost responses or a candidate/ledger mention retain
        // the ordinary strict-complete requirement.
        if (establishes(frozen) || !['source_invalid', 'projection_invalid'].includes(result.inspected.audit.classification)
          || !evidence.proposalChanges || pending.some(proposal => proposal && evidence.proposalChanges!.proposals.some(item => item.id === proposal.id
            && runtimeJson(item).hash !== runtimeJson(proposal).hash))) return base
        const first = inspections.filter(item => item.frame.stage === 'first' || item.frame.stage === 'output_recovery').at(-1)
        const claims = relevantRows.filter(row => object(row.metadata).fullReassessmentKey === meta.continuityAssessmentRequestKey)
        const seconds = inspections.filter(item => item.frame.stage === 'reassessment')
        if (!first || claims.length > 1 || claims.length === 0 && seconds.length !== 0) return base
        if (claims.length === 1) {
          const claim = object(claims[0].metadata)
          if (!seconds.length || runtimeJson(claim.input).hash !== runtimeJson(frozen).hash
            || runtimeJson(claim.original).hash !== runtimeJson(first.inspected.audit).hash
            || runtimeJson(claim.request).hash !== runtimeJson(lifecycle.continuityReassessmentRequest(frozen.system, frozen.content,
              first.inspected, frozen.bodies, false, frozen.reassessmentProtocol)).hash) return base
        }
        continue
      }
      const originReview = frozen.terminalCandidate ? readAuthenticatedContinuityAssessment(bound.audit, frozen.bodies.current, evidence, true) : null
      for (const proposal of pending) {
        if (!proposal || proposal.origin.auditHash !== auditHash) continue
        const fact = frozen.terminalCandidate && terminalCandidateFacts(frozen.terminalCandidate).find(fact => fact.id === proposal.id)
        if (!fact || !originReview || frozen.targetId !== subject.compilationId || originReview.verdicts.find(verdict => verdict.path === fact.path)?.verdict !== 'unknown'
          || frozen.chapterId !== chapter.id || evidence.current.id !== chapter.id || evidence.current.revision !== frozen.revision
          || proposal.origin.bodyHash !== evidence.current.contentHash
          || proposal.origin.sourceHash !== identity.sourceHash || runtimeJson({ previous: evidence.previous }).hash !== identity.sourceHash
          || proposal.origin.candidateHash !== runtimeJson(frozen.terminalCandidate).hash) return base
        if (frozen.revision !== chapter.revision || proposal.origin.bodyHash !== identity.bodyHash) {
          const key = runtimeJson({ revision: frozen.revision, bodyHash: proposal.origin.bodyHash }).hash
          if (!revisions.has(key)) revisions.set(key, import('./terminal-draft-revision.js').then(module => module.authenticatedTerminalDraftRevision(db,
            subject, binding.taskId, runIds, chapter, validation, { revision: frozen.revision, content: frozen.bodies.current })))
          if (!await revisions.get(key)) return base
        }
        origins.set(proposal.id, auditHash)
      }
    }
    for (const entry of nativeEntries ?? []) {
      const frozen = entry.input, evidence = frozen.bodies.terminalEvidence!
      if ([...(evidence.proposalChanges?.verifiedFactIds ?? []), ...(evidence.factCoverage?.obligations.map(fact => fact.id) ?? []),
        ...(evidence.previous?.carried?.map(fact => terminalFactId(fact.field, fact.claim)) ?? [])].some(id => ids.has(id))) return base
      for (const inspected of [...entry.inspections, entry.inspected]) {
        if (!inspected.complete || !frozen.terminalCandidate) continue
        const historical = readAuthenticatedContinuityAssessment(inspected.audit, frozen.bodies.current, evidence, true)
        if (!historical) return base
        const facts = terminalCandidateFacts(frozen.terminalCandidate)
        if (historical.verdicts.some(verdict => verdict.verdict === 'supported' && facts.some(fact => ids.has(fact.id) && fact.path === verdict.path))) return base
      }
      if (!entry.inspected.complete) {
        if (establishes(frozen) || !['source_invalid', 'projection_invalid'].includes(entry.inspected.audit.classification) || !evidence.proposalChanges
          || pending.some(proposal => proposal && evidence.proposalChanges!.proposals.some(item => item.id === proposal.id && runtimeJson(item).hash !== runtimeJson(proposal).hash))) return base
        continue
      }
      const auditHash = runtimeJson(entry.inspected.audit).hash
      const originReview = readAuthenticatedContinuityAssessment(entry.inspected.audit, frozen.bodies.current, evidence, true)
      for (const proposal of pending) {
        if (!proposal || proposal.origin.auditHash !== auditHash) continue
        if (!entry.committed) return base
        const fact = frozen.terminalCandidate && terminalCandidateFacts(frozen.terminalCandidate).find(fact => fact.id === proposal.id)
        if (!fact || !originReview || frozen.targetId !== subject.compilationId || originReview.verdicts.find(verdict => verdict.path === fact.path)?.verdict !== 'unknown'
          || frozen.chapterId !== chapter.id || evidence.current.id !== chapter.id || evidence.current.revision !== frozen.revision
          || proposal.origin.bodyHash !== evidence.current.contentHash || proposal.origin.sourceHash !== identity.sourceHash
          || runtimeJson({ previous: evidence.previous }).hash !== identity.sourceHash || proposal.origin.candidateHash !== runtimeJson(frozen.terminalCandidate).hash) return base
        if (frozen.revision !== chapter.revision || proposal.origin.bodyHash !== identity.bodyHash) {
          const key = runtimeJson({ revision: frozen.revision, bodyHash: proposal.origin.bodyHash }).hash
          if (!revisions.has(key)) revisions.set(key, import('./terminal-draft-revision.js').then(module => module.authenticatedTerminalDraftRevision(db,
            subject, binding.taskId, runIds, chapter, validation, { revision: frozen.revision, content: frozen.bodies.current })))
          if (!await revisions.get(key)) return base
        }
        origins.set(proposal.id, auditHash)
      }
    }
    if (pending.some(proposal => !proposal || !origins.has(proposal.id))) return base
    subject.signal?.throwIfAborted()
    const token = Object.freeze({})
    authority.set(token, { identityHash: runtimeJson(terminalDraftIdentity(base, context, review.candidateHash, runtimeJson(object(validation).continuityCriticResponse).hash,
      runtimeJson({ newDraftRevision: object(validation).newDraftRevision ?? null, retainedReviewDecision: object(validation).retainedReviewDecision ?? null }).hash)).hash,
      ids: Object.freeze([...origins.keys()]), originHashes: Object.freeze([...origins.values()]) })
    return { ...base, draftAuthority: token }
  } catch (error) {
    subject.signal?.throwIfAborted()
    // A missing or contradictory historical response grants no new eligibility.
    void error
    return base
  }
}

function establishedDraftHistoryInput(value: unknown, ids: ReadonlySet<string>) {
    const input = object(value), evidence = object(object(input.bodies).terminalEvidence), candidate = historyCandidateSchema.safeParse(input.terminalCandidate)
    const rawCandidate = object(input.terminalCandidate), rawExit = object(rawCandidate.exitState)
    const rawMatch = Object.entries(rawExit).some(([field, value]) => (Array.isArray(value) ? value : [value])
      .some(claim => typeof claim === 'string' && ids.has(historyFactId(field, claim))))
      || typeof rawCandidate.lastUnfinishedAction === 'string' && ids.has(historyFactId('lastUnfinishedAction', rawCandidate.lastUnfinishedAction))
    return rawMatch || (candidate.success && historyCandidateFacts(candidate.data).some(fact => ids.has(fact.id)))
      || [object(evidence.factCoverage).obligations].some(items => Array.isArray(items) && items.some(item => ids.has(String(object(item).id))))
      || (Array.isArray(object(evidence.proposalChanges).verifiedFactIds) && (object(evidence.proposalChanges).verifiedFactIds as unknown[]).some(id => ids.has(String(id))))
      || (Array.isArray(object(evidence.previous).carried) && (object(evidence.previous).carried as unknown[]).some(item => {
        const fact = object(item); return typeof fact.field === 'string' && typeof fact.claim === 'string' && ids.has(historyFactId(fact.field, fact.claim))
      }))
  }
function passedDraftHistoryInput(value: unknown, ids: ReadonlySet<string>) {
    const items = object(object(object(value).bodies).terminalEvidence).proposalChanges
    const proposals = object(items).proposals
    return Array.isArray(proposals) && proposals.some(item => ids.has(String(object(item).id)))
  }

function relevantDraftHistoryInput(value: unknown, ids: ReadonlySet<string>) {
  return establishedDraftHistoryInput(value, ids) || passedDraftHistoryInput(value, ids)
}
