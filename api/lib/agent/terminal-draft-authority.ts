import type { Prisma } from '@prisma/client'
import type { ToolContext } from './tools/types.js'
import type { TerminalEvidenceContext } from './terminal-evidence-context.js'
import type { TerminalDeliveryBinding } from './terminal-state-review.js'
import { runtimeJson } from './runtime-common.js'

type Identity = { userId: string; novelId: string; taskId: string; compilationId: string; chapterId: string; bodyHash: string;
  sourceHash: string; candidateHash: string; evidenceHash: string; preparedHash: string; auditHash: string; revisionHash: string }
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
  context?: TerminalEvidenceContext, scope?: TerminalDraftReadScope): Promise<TerminalDeliveryBinding> {
  subject.signal?.throwIfAborted()
  if (!scope) return loadTerminalDraftBinding(db, subject, binding, chapter, validation, context)
  let cache = scope.get(db)
  if (!cache) { cache = new Map(); scope.set(db, cache) }
  const key = runtimeJson({ userId: subject.userId, novelId: subject.novelId, runId: subject.runId, compilationId: subject.compilationId,
    taskId: binding.taskId, chapter: { id: chapter.id, revision: chapter.revision, orderIndex: chapter.orderIndex, bodyHash: runtimeJson({ content: chapter.content }).hash },
    preparedContext: binding.preparedContext, context: context ?? null,
    audit: object(validation).continuityCriticResponse ?? null, candidate: object(validation).terminalCandidate ?? null,
    newDraftRevision: object(validation).newDraftRevision ?? null }).hash
  if (!cache.has(key)) cache.set(key, loadTerminalDraftBinding(db, subject, binding, chapter, validation, context))
  const result = await cache.get(key)!
  subject.signal?.throwIfAborted()
  return result
}

async function loadTerminalDraftBinding(db: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string; compilationId: string; signal?: AbortSignal }, binding: TerminalDeliveryBinding,
  chapter: { id: string; revision: number; orderIndex: number; content: string }, validation: unknown,
  context?: TerminalEvidenceContext): Promise<TerminalDeliveryBinding> {
  const base = { ...binding, userId: subject.userId, novelId: subject.novelId, compilationId: subject.compilationId }
  delete base.draftAuthority
  if (!context?.proposalChanges) return base
  if (typeof db.agentArtifact?.findMany !== 'function' || typeof db.aiUsageLog?.findMany !== 'function') return base
  subject.signal?.throwIfAborted()
  const [{ currentTerminalReview, terminalCandidateSchema }, { terminalCandidateFacts, terminalFactId }, proposals, coverage] = await Promise.all([
    import('./terminal-state-review.js'), import('./terminal-fact-identity.js'), import('./terminal-proposal-review.js'), import('./terminal-fact-coverage.js'),
  ])
  const review = currentTerminalReview(validation, chapter.content, context, base)
  const unknown = review?.proposals?.dispositions.filter(item => item.outcome === 'unknown') ?? []
  if (!review || review.deliveryEligibility.eligible || !unknown.length || !review.verdicts.length
    || review.verdicts.some(item => item.verdict !== 'supported') || review.factCoverage?.version !== 2 || !review.factCoverage.complete) return base
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
  const { inspectContinuityResponse } = await import('./continuity-format-recovery.js')
  const { terminalEvidenceContextSchema } = await import('./terminal-evidence-context.js')
  const { continuitySourceScopeSchema } = await import('./continuity-source-authority.js')
  const { z } = await import('zod')
  const inputSchema = z.object({ chapterId: z.string(), revision: z.number().int(), bodies: z.object({ current: z.string(), previous: z.string().nullable(),
    terminalEvidence: terminalEvidenceContextSchema }).strict(), system: z.string(), content: z.string(), parserVersion: z.literal(8),
    reassessmentProtocol: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5)]), terminalCandidate: terminalCandidateSchema.optional(),
    sourceScope: continuitySourceScopeSchema, bindingHash: z.string().regex(/^[a-f0-9]{64}$/u), targetType: z.literal('story_compilation'), targetId: z.string() }).strict()
  const establishes = (value: unknown) => {
    const input = object(value), evidence = object(object(input.bodies).terminalEvidence), candidate = terminalCandidateSchema.safeParse(input.terminalCandidate)
    const rawCandidate = object(input.terminalCandidate), rawExit = object(rawCandidate.exitState)
    const rawMatch = Object.entries(rawExit).some(([field, value]) => (Array.isArray(value) ? value : [value])
      .some(claim => typeof claim === 'string' && ids.has(terminalFactId(field, claim))))
      || typeof rawCandidate.lastUnfinishedAction === 'string' && ids.has(terminalFactId('lastUnfinishedAction', rawCandidate.lastUnfinishedAction))
    return rawMatch || (candidate.success && terminalCandidateFacts(candidate.data).some(fact => ids.has(fact.id)))
      || [object(evidence.factCoverage).obligations].some(items => Array.isArray(items) && items.some(item => ids.has(String(object(item).id))))
      || (Array.isArray(object(evidence.proposalChanges).verifiedFactIds) && (object(evidence.proposalChanges).verifiedFactIds as unknown[]).some(id => ids.has(String(id))))
      || (Array.isArray(object(evidence.previous).carried) && (object(evidence.previous).carried as unknown[]).some(item => {
        const fact = object(item); return typeof fact.field === 'string' && typeof fact.claim === 'string' && ids.has(terminalFactId(fact.field, fact.claim))
      }))
  }
  const passesPending = (value: unknown) => {
    const items = object(object(object(value).bodies).terminalEvidence).proposalChanges
    const proposals = object(items).proposals
    return Array.isArray(proposals) && proposals.some(item => ids.has(String(object(item).id)))
  }
  const related = rows.filter(row => object(object(row.metadata).input).chapterId === chapter.id
    && (establishes(object(row.metadata).input) || passesPending(object(row.metadata).input)))
  if (related.some(row => object(row.metadata).version !== 1)) return base
  const reservations = related.filter(row => typeof object(row.metadata).continuityAssessmentRequestKey === 'string')
  if (!reservations.length) return base
  const keys = new Set(reservations.map(row => String(object(row.metadata).continuityAssessmentRequestKey)))
  const currentRequest = object(object(object(validation).continuityCriticResponse).assessmentRequest)
  if (!keys.has(String(currentRequest.key))) return base
  if (keys.size !== reservations.length || related.some(row => {
    const meta = object(row.metadata)
    return meta.assessmentKey !== undefined && !keys.has(String(meta.assessmentKey))
      || meta.fullReassessmentKey !== undefined && !keys.has(String(meta.fullReassessmentKey))
  })) return base
  const relevantRows = rows.filter(row => { const meta = object(row.metadata); return [meta.assessmentKey, meta.assessmentRequestOwnerKey, meta.fullReassessmentKey].some(key => keys.has(String(key))) })
  if (relevantRows.some(row => object(row.metadata).version !== 1)) return base
  const usageIds = [...new Set(relevantRows.flatMap(row => { const ids = object(row.metadata).usageIds; return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [] }))]
  const usage = await db.aiUsageLog.findMany({ where: { id: { in: usageIds }, userId: subject.userId, novelId: subject.novelId,
    agentRunId: { in: runIds }, chapterId: chapter.id, action: { startsWith: 'agent3ContinuityCritic' } } })
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
        const inspected = inspectContinuityResponse(raw, frozen.bodies, true, 8, frozen.terminalCandidate, frozen.sourceScope,
          frozen.reassessmentProtocol === 2 ? {} : { responseContract: 3 })
        if (runtimeJson(inspected.audit).hash !== runtimeJson(frame.audit).hash) return base
        inspections.push({ frame, inspected })
        if (frozen.terminalCandidate && inspected.complete) {
          const historical = currentTerminalReview({ independentCheck: 'complete', terminalCandidate: frozen.terminalCandidate,
            continuityCriticResponse: inspected.audit }, frozen.bodies.current, evidence)
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
        if (establishes(frozen) || result.inspected.audit.classification !== 'source_invalid'
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
      const originReview = frozen.terminalCandidate ? currentTerminalReview({ independentCheck: 'complete', terminalCandidate: frozen.terminalCandidate,
        continuityCriticResponse: bound.audit }, frozen.bodies.current, evidence) : null
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
    if (pending.some(proposal => !proposal || !origins.has(proposal.id))) return base
    subject.signal?.throwIfAborted()
    const token = Object.freeze({})
    authority.set(token, { identityHash: runtimeJson(terminalDraftIdentity(base, context, review.candidateHash, runtimeJson(object(validation).continuityCriticResponse).hash,
      runtimeJson({ newDraftRevision: object(validation).newDraftRevision ?? null }).hash)).hash,
      ids: Object.freeze([...origins.keys()]), originHashes: Object.freeze([...origins.values()]) })
    return { ...base, draftAuthority: token }
  } catch (error) {
    subject.signal?.throwIfAborted()
    // A missing or contradictory historical response grants no new eligibility.
    void error
    return base
  }
}
