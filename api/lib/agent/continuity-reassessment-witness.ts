import { readCompilerContinuitySource } from './compiler-continuity-source.js'
import type { AiUsageLog, Prisma } from '@prisma/client'
import { z } from 'zod'
import { runtimeJson } from './runtime-common.js'
import { isKnownTextRequestBilling, isKnownRejectedTextRequestAttempt } from './text-request-billing.js'
import { inspectContinuityResponse } from './continuity-format-recovery.js'
import { continuityReassessmentRequest, legacyContinuityAssessmentKey } from './assessment-response-lifecycle.js'
import { compilerContinuityCoverage } from './compiler-continuity-contract.js'
import { activeChapterScope } from '../data/internal.js'
import { terminalCandidateSchema, terminalCandidateInputSchema, readTerminalCandidate, reviewTerminalSelection, resolveTerminalCandidate } from './terminal-state-review.js'
import { continuitySourceScopeSchema } from './continuity-source-authority.js'
import { terminalEvidenceContextSchema, terminalEvidenceContext, terminalQuoteAddressVersion } from './terminal-evidence-context.js'
import { terminalCoverageInput, terminalCoverageProofs } from './terminal-fact-coverage.js'
import { readOriginalTaskRequest } from './original-request.js'
import { readFrozenLegacyTerminalPatch, terminalCandidatePatchSchema } from './terminal-candidate-patch.js'
import { DataAccessError } from '../prisma.js'
import { prepareCompilerTerminalProposals } from './terminal-proposal-context.js'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
/** Authenticate only this exact two-request tool interval. A matching action
 * name or a settled first call never authenticates an unknown second request. */
export async function readOwnedContinuityReassessment(tx: Prisma.TransactionClient, subject: { userId: string; novelId: string }, input: {
  runId: string; callId: string; chapterId: string; revision: number; compilationId?: string | null; callAt: Date; resultAt: Date; payments: AiUsageLog[];
}) {
  const primaryAttempts = input.payments.filter(row => row.action === 'agent3ContinuityCritic')
  const secondAttempts = input.payments.filter(row => row.action === 'agent3ContinuityCriticSecondPass')
  const primary = primaryAttempts.filter(row => !isKnownRejectedTextRequestAttempt(row))
  const second = secondAttempts.filter(row => !isKnownRejectedTextRequestAttempt(row))
  if (input.payments.length !== primaryAttempts.length + secondAttempts.length || primaryAttempts.length > 2 || secondAttempts.length > 2
    || primaryAttempts.some(row => !isKnownRejectedTextRequestAttempt(row) && (row.usageSource !== 'reported' || !isKnownTextRequestBilling(row)))
    || primary.length !== 1 || second.length !== 1 || primary[0].usageSource !== 'reported'
    || !isKnownTextRequestBilling(primary[0]) || object(primary[0].billingEvidence).responseObserved !== true) return null
  const claims = await tx.agentArtifact.findMany({ where: { runId: input.runId, run: { userId: subject.userId, novelId: subject.novelId }, artifactType: 'continuityReview',
    createdAt: { gte: input.callAt, lte: input.resultAt }, metadata: { path: ['callId'], equals: input.callId } } })
  const full = claims.filter(row => typeof object(row.metadata).fullReassessmentKey === 'string')
  if (full.length !== 1) return null
  const claim = full[0], meta = object(claim.metadata)
  const frozen = z.object({ chapterId: z.literal(input.chapterId), revision: z.literal(input.revision), bodies: z.object({ previous: z.string().nullable(), current: z.string(), terminalEvidence: terminalEvidenceContextSchema.optional() }),
    system: z.string(), content: z.string(), reassessmentProtocol: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(), parserVersion: z.union([z.literal(7), z.literal(8)]).optional(), sourceScope: continuitySourceScopeSchema.optional(), bindingHash: z.string().optional(), terminalCandidate: terminalCandidateSchema.optional(), targetType: z.enum(['chapter', 'story_compilation']), targetId: z.string() }).strict().safeParse(meta.input)
  if (!frozen.success || !Array.isArray(meta.usageIds) || !object(meta.request).system || !object(meta.request).content
    || frozen.data.targetId !== (frozen.data.targetType === 'chapter' ? input.chapterId : input.compilationId)
    || meta.fullReassessmentKey !== legacyContinuityAssessmentKey({ runId: input.runId, callId: input.callId }, frozen.data)
    || runtimeJson([...meta.usageIds].sort()).hash !== runtimeJson(primaryAttempts.map(row => row.id).sort()).hash
    || input.payments.some(row => row.userId !== subject.userId || row.novelId !== subject.novelId || row.agentRunId !== input.runId || row.targetType !== frozen.data.targetType || row.targetId !== frozen.data.targetId)
    || primaryAttempts.some(row => row.createdAt > claim.createdAt) || secondAttempts.some(row => row.createdAt < claim.createdAt)
    || primaryAttempts.some(row => isKnownRejectedTextRequestAttempt(row) && row.createdAt >= primary[0].createdAt)
    || secondAttempts.some(row => isKnownRejectedTextRequestAttempt(row) && row.createdAt >= second[0].createdAt)) return null
  const original = object(meta.original), raw = object(original.rawResponse)
  if ((frozen.data.reassessmentProtocol === 3 || frozen.data.reassessmentProtocol === 4 || frozen.data.reassessmentProtocol === 5) !== (original.responseContract === 3)
    || (frozen.data.reassessmentProtocol === 3 || frozen.data.reassessmentProtocol === 4 || frozen.data.reassessmentProtocol === 5) && (frozen.data.parserVersion !== 8 || frozen.data.bodies.terminalEvidence?.verdictProtocol !== 6 || !frozen.data.terminalCandidate)
    || original.parserVersion !== (frozen.data.parserVersion ?? 6) || raw.encoding !== 'json-string' || raw.complete !== true || typeof raw.content !== 'string') return null
  let content: unknown
  try { content = JSON.parse(raw.content) } catch { return null }
  if (typeof content !== 'string') return null
  // A parser correction cannot erase a real historical two-request interval.
  // Authenticate one complete audit/request pair under its own metadata rule.
  const inspected = [inspectContinuityResponse(content, frozen.data.bodies, true, frozen.data.parserVersion ?? 6, frozen.data.terminalCandidate, frozen.data.sourceScope, frozen.data.reassessmentProtocol === 3 || frozen.data.reassessmentProtocol === 4 || frozen.data.reassessmentProtocol === 5 ? { responseContract: 3 } : {}),
    inspectContinuityResponse(content, frozen.data.bodies, true, frozen.data.parserVersion ?? 6, frozen.data.terminalCandidate, frozen.data.sourceScope, { frozenCurrentMetadata: true, ...(frozen.data.reassessmentProtocol === 3 || frozen.data.reassessmentProtocol === 4 || frozen.data.reassessmentProtocol === 5 ? { responseContract: 3 as const } : {}) })].find(inspected => {
    if (inspected.complete) return false
    const currentPair = runtimeJson(inspected.audit).hash === runtimeJson(original).hash
      && runtimeJson(meta.request).hash === runtimeJson(continuityReassessmentRequest(frozen.data.system, frozen.data.content, inspected, frozen.data.bodies, false, frozen.data.reassessmentProtocol)).hash
    // The earlier v2 renderer omitted schema-error paths and their prompt field.
    // Authenticate that exact pair; never mix projections or ignore other bytes.
    const legacyAudit = { ...inspected.audit, ...(inspected.audit.terminalReviewDiagnostics ? {
      terminalReviewDiagnostics: inspected.audit.terminalReviewDiagnostics.map(item => {
        const projected = { ...item }
        if (projected.code === 'verdict_schema_invalid' && (projected.path === 'terminalVerdicts' || projected.path?.startsWith('terminalVerdicts.'))) delete projected.path
        return projected
      }),
    } : {}) }
    const legacyPair = frozen.data.reassessmentProtocol === undefined && runtimeJson(legacyAudit).hash === runtimeJson(original).hash
      && runtimeJson(meta.request).hash === runtimeJson(continuityReassessmentRequest(frozen.data.system, frozen.data.content,
        { ...inspected, audit: legacyAudit }, frozen.data.bodies, true)).hash
    return currentPair || legacyPair
  })
  if (!inspected) return null
  const firstFrames = claims.filter(row => object(row.metadata).assessmentKey === meta.fullReassessmentKey && object(row.metadata).stage === 'first')
  const observed = firstFrames.filter(row => typeof object(object(row.metadata).response).content === 'string')
  if (observed.length !== 1 || !Array.isArray(object(observed[0].metadata).usageIds) || observed[0].createdAt > claim.createdAt || object(object(observed[0].metadata).audit).contentHash !== inspected.audit.contentHash
    || runtimeJson(object(observed[0].metadata).usageIds).hash !== runtimeJson([primary[0].id]).hash) return null
  for (const [stage, payments] of [['first', primaryAttempts], ['reassessment', secondAttempts]] as const) {
    const links = claims.filter(row => object(row.metadata).assessmentRequestOwnerKey === meta.fullReassessmentKey && object(row.metadata).stage === stage)
    if (links.length !== payments.length) return null
    for (const payment of payments) {
      const linked = links.filter(row => runtimeJson({ ids: object(row.metadata).usageIds }).hash === runtimeJson({ ids: [payment.id] }).hash)
      if (linked.length !== 1 || linked[0].createdAt < payment.createdAt || linked[0].createdAt > input.resultAt) return null
      const frames = claims.filter(row => object(row.metadata).assessmentKey === meta.fullReassessmentKey && object(row.metadata).stage === stage
        && runtimeJson(object(row.metadata).usageIds).hash === runtimeJson([payment.id]).hash)
      // Ownership of a second attempt is not evidence that its response or
      // billing is known. Old interrupted attempts may have only the binding
      // saved before HTTP; authenticated human Continue can retire that slot
      // while keeping its real unknown fees. Application/reuse still require
      // their separate complete-response and known-billing checks.
      if (frames.length > 1 || stage === 'first' && frames.length !== 1
        || frames.some(frame => frame.createdAt > input.resultAt)
        || isKnownRejectedTextRequestAttempt(payment) && (frames.length !== 1 || object(object(frames[0].metadata).response).content !== null)) return null
    }
  }
  return { claim, primary: primary[0], second: second[0], input: frozen.data }
}

/** This live producer positively observed no provider send. It authorizes only
 * a new human admission bound to today's exact original compiler inputs. */
export async function readUnsentContinuityAdmission(tx: Prisma.TransactionClient, subject: { userId: string; novelId: string; runId: string }, input: {
  runIds: string[]; compilationId: string; admission: { id: string; at: Date }; retiredUsageIds: Set<string>;
}) {
  const compilation = await tx.storyCompilation.findFirst({ where: { id: input.compilationId, userId: subject.userId, novelId: subject.novelId,
    runId: { in: input.runIds }, status: 'active', chapter: { authorId: subject.userId, ...activeChapterScope(subject.novelId) } },
    include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } }, chapter: true } })
  if (!compilation?.chapter || !compilation.bridge) return null
  const chapter = compilation.chapter
  let source = await readCompilerContinuitySource(tx, subject, compilation.chapter, compilation.bridge.fromChapterId)
  if (compilation.bridge.fromChapterId && source?.revision !== compilation.bridge.sourceRevision) return null
  const calls = await tx.agentRunEvent.findMany({ where: { runId: { in: input.runIds }, type: 'tool.call' }, orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }] })
  const call = calls.find(row => {
    const args = object(object(row.payload).args)
    return object(row.payload).toolName === 'continuity_validate' && (args.compilationId === compilation.id || args.chapterId === chapter.id)
  })
  if (!call || call.createdAt >= input.admission.at || typeof object(call.payload).callId !== 'string') return null
  const callId = String(object(call.payload).callId), args = object(object(call.payload).args)
  if (args.compilationId !== undefined && args.compilationId !== compilation.id || args.chapterId !== undefined && args.chapterId !== chapter.id) return null
  const results = await tx.agentRunEvent.findMany({ where: { runId: call.runId, type: 'tool.result', payload: { path: ['callId'], equals: callId } } })
  if (results.length !== 1 || object(results[0].payload).ok !== false || object(results[0].payload).toolName !== 'continuity_validate'
    || results[0].createdAt >= input.admission.at || results[0].seq <= call.seq) return null
  const reservations = await tx.agentArtifact.findMany({ where: { runId: call.runId, artifactType: 'continuityReview', metadata: { path: ['callId'], equals: callId } } })
  const reservation = reservations.filter(row => typeof object(row.metadata).continuityAssessmentRequestKey === 'string')
  if (reservation.length !== 1) return null
  const meta = object(reservation[0].metadata), frozen = object(meta.input), bodies = object(frozen.bodies), key = meta.continuityAssessmentRequestKey
  const chainProtocol = frozen.parserVersion === 8 && object(bodies.terminalEvidence).protocol === 2
  if (chainProtocol) source = await readCompilerContinuitySource(tx, subject, chapter, compilation.bridge.fromChapterId, 11)
  const original = chainProtocol ? await readOriginalTaskRequest(tx, { ...subject, runId: call.runId }) : null
  const explicit = terminalCandidateInputSchema.optional().safeParse(args.terminalState)
  const proofs = terminalCandidateInputSchema.shape.inheritedProofs.safeParse(args.inheritedProofs)
  if (!explicit.success || !proofs.success) return null
  const savedCandidate = readTerminalCandidate(compilation.validation)
  const patchInput = terminalCandidatePatchSchema.optional().safeParse(args.terminalPatch)
  if (!patchInput.success || patchInput.data && explicit.data) return null
  let patchedCandidate
  if (patchInput.data) {
    try {
      const recovered = await readFrozenLegacyTerminalPatch(tx, { ...subject, runId: call.runId, callId }, { ...compilation, chapter }, source,
        source && 'terminalInheritance' in source ? source.terminalInheritance : undefined, chainProtocol ? 2 : undefined, patchInput.data, proofs.data)
      if (!recovered) return null
      patchedCandidate = recovered.candidate
    } catch (error) { if (error instanceof DataAccessError) return null; throw error }
  }
  const selection = patchedCandidate ? undefined : reviewTerminalSelection(explicit.data, savedCandidate, proofs.data)
  const resolved = selection ? resolveTerminalCandidate(selection,
    source && 'terminalInheritance' in source ? source.terminalInheritance : [], chainProtocol ? 2 : undefined) : undefined
  if (resolved && !resolved.ok) return null
  const coverageInput = { chapter, bridge: compilation.bridge, sceneTasks: compilation.sceneTasks, source, focus: typeof args.focus === 'string' ? args.focus : undefined,
    terminalCandidate: patchedCandidate ?? (resolved?.ok ? resolved.candidate : savedCandidate) }
  coverageInput.terminalCandidate ??= terminalCoverageInput(original?.spec, compilation.preparedContext, chapter)?.obligations.length
    ? terminalCandidateSchema.parse({ exitState: {} }) : undefined
  if (runtimeJson({ candidate: frozen.terminalCandidate ?? null }).hash !== runtimeJson({ candidate: coverageInput.terminalCandidate ?? null }).hash) return null
  const coverage = compilerContinuityCoverage({ ...coverageInput, source }, chainProtocol ? 11 : frozen.parserVersion === 8 ? 10 : frozen.parserVersion === 7 ? 9 : 8)
  let sourceMatches = bodies.previous === (source?.content ?? null) && frozen.bindingHash === runtimeJson(coverage).hash
  if (chainProtocol) {
    let evidence = terminalEvidenceContext(chapter, source, 2, terminalQuoteAddressVersion(original?.spec),
      terminalCoverageInput(original?.spec, compilation.preparedContext, chapter, coverageInput.terminalCandidate,
        object(object(bodies.terminalEvidence).factCoverage).version === 2 ? 2 : 1, terminalCoverageProofs(source, object(bodies.terminalEvidence).spanAddressProtocol === 2 ? 2 : undefined)), object(bodies.terminalEvidence).verdictProtocol === 6 ? 6 : object(bodies.terminalEvidence).verdictProtocol === 5 ? 5 : object(bodies.terminalEvidence).verdictProtocol === 4 ? 4 : object(bodies.terminalEvidence).verdictProtocol === 3 ? 3 : object(bodies.terminalEvidence).verdictProtocol === 2 ? 2 : undefined,
      object(bodies.terminalEvidence).spanAddressProtocol === 2 ? 2 : undefined)
    if (object(bodies.terminalEvidence).proposalChanges !== undefined && coverageInput.terminalCandidate && original) {
      try {
        const proposals = prepareCompilerTerminalProposals({ spec: original.spec, preparedContext: compilation.preparedContext,
          validation: compilation.validation, chapter, source, candidate: coverageInput.terminalCandidate, nextContext: evidence })
        if (!proposals?.changes) return null
        evidence = { ...evidence, proposalChanges: proposals.changes }
      } catch (error) { if (error instanceof DataAccessError) return null; throw error }
    }
    sourceMatches &&= runtimeJson(bodies.terminalEvidence).hash === runtimeJson(evidence).hash
  }
  if (!sourceMatches && !chainProtocol) {
    // A proven non-dispatch may have frozen the previous single-source
    // protocol. Verify those exact bytes; the returned NEW admission still
    // binds today's range, never upgrades an old received judgment.
    const previousSource = await readCompilerContinuitySource(tx, subject, chapter, compilation.bridge.fromChapterId, 7)
    const previousCoverage = compilerContinuityCoverage({ chapter, bridge: compilation.bridge, sceneTasks: compilation.sceneTasks,
      source: previousSource, focus: typeof args.focus === 'string' ? args.focus : undefined,
      terminalCandidate: coverageInput.terminalCandidate }, 7)
    sourceMatches = bodies.previous === (previousSource?.content ?? null) && frozen.bindingHash === runtimeJson(previousCoverage).hash
  }
  if (meta.admissionId === input.admission.id || frozen.chapterId !== chapter.id || frozen.revision !== chapter.revision || bodies.current !== chapter.content
    || !sourceMatches
    || frozen.targetType !== 'story_compilation' || frozen.targetId !== compilation.id) return null
  const receipt = reservations.filter(row => object(row.metadata).firstAssessmentNotDispatchedKey === key || object(row.metadata).fullReassessmentNotDispatchedKey === key)
  if (receipt.length !== 1 || receipt[0].createdAt < call.createdAt || receipt[0].createdAt > results[0].createdAt) return null
  const links = reservations.filter(row => object(row.metadata).assessmentRequestOwnerKey === key || object(row.metadata).assessmentKey === key)
  const ids = [...new Set(links.flatMap(row => { const ids = object(row.metadata).usageIds; return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [] }))]
  const paid = await tx.aiUsageLog.findMany({ where: { userId: subject.userId, novelId: subject.novelId, action: { startsWith: 'agent3Continuity' },
    OR: [{ chapterId: chapter.id }, { targetId: compilation.id }] } })
  if (paid.some(row => !isKnownTextRequestBilling(row) && !input.retiredUsageIds.has(row.id))) return null
  const interval = paid.filter(row => row.createdAt >= call.createdAt && row.createdAt <= results[0].createdAt)
  if (interval.length !== ids.length || interval.some(row => !ids.includes(row.id) || row.agentRunId !== call.runId || !isKnownTextRequestBilling(row))) return null
  const full = object(receipt[0].metadata).fullReassessmentNotDispatchedKey === key
  if (full) {
    const claims = reservations.filter(row => object(row.metadata).fullReassessmentKey === key)
    if (claims.length !== 1 || object(receipt[0].metadata).claimId !== claims[0].id || claims[0].createdAt > receipt[0].createdAt) return null
  }
  if (full && (interval.filter(row => row.action === 'agent3ContinuityCritic' && row.usageSource === 'reported' && !isKnownRejectedTextRequestAttempt(row)).length !== 1
    || interval.some(row => !isKnownRejectedTextRequestAttempt(row) && row.action !== 'agent3ContinuityCritic' && (row.action !== 'agent3ContinuityCriticSecondPass' || row.billingStatus !== 'not_dispatched')))) return null
  if (!full && interval.some(row => row.billingStatus !== 'not_dispatched')) return null
  return { chapter, coverage, sourceCallId: callId, usageIds: ids }
}
