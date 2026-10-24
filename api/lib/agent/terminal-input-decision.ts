import { inspectAuthenticatedContinuityAssessment, knownFinalContinuityFailure } from './authenticated-continuity-assessment.js'
import { continuityReviewManifestSchema } from './continuity-review-v4.js'
import { z } from 'zod'
import { DataAccessError } from '../prisma.js'
import type { Prisma } from '@prisma/client'
import { runtimeJson } from './runtime-common.js'
import { readWritingScope } from './writing-scope.js'
import { originalTaskRunIds } from './original-request.js'
import { terminalCandidateSchema } from './terminal-candidate-contract.js'
import { terminalCandidateFacts } from './terminal-fact-identity.js'
import { terminalProofCatalog } from './terminal-proof-verdict.js'
import { terminalEvidenceContextSchema, terminalEvidenceContext } from './terminal-evidence-context.js'
import { continuitySourceScopeSchema, compilerEvidenceScope } from './continuity-source-authority.js'
import { terminalCoverageInput, terminalCoverageProofs } from './terminal-fact-coverage.js'
import { readCompilerContinuitySource } from './compiler-continuity-source.js'
import { compilerContinuityCoverage, storedContinuityProtocol } from './compiler-continuity-contract.js'
import { attachTerminalProposalInput } from './terminal-proposal-context.js'
import { continuityFailureOutput } from './continuity-format-recovery.js'
import { terminalProcessingEpisodeKey } from './terminal-processing.js'
import type { LegacyAssessmentInput } from './assessment-response-lifecycle.js'
import { isKnownRejectedTextRequestAttempt, isKnownTextRequestBilling } from './text-request-billing.js'
import { readRetiredReviewUsageIds } from './cancelled-review-recovery.js'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const inputSchema = z.object({ chapterId: z.string(), revision: z.number().int(), parserVersion: z.union([z.literal(8), z.literal(9)]), continuityManifest: continuityReviewManifestSchema.optional(), terminalCandidate: terminalCandidateSchema,
  bodies: z.object({ current: z.string(), previous: z.string().nullable(), terminalEvidence: terminalEvidenceContextSchema }).strict(),
  sourceScope: continuitySourceScopeSchema, system: z.string(), content: z.string(), bindingHash: z.string().regex(/^[a-f0-9]{64}$/u),
  reassessmentProtocol: z.union([z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]).optional(), targetType: z.literal('story_compilation'), targetId: z.string() }).strict()

/** Selectors, ordering, prompts and focus do not create a different subject.
 * This digest grants nothing: its operands must first be authenticated below. */
export function terminalInputSemanticKey(value: unknown) {
  const parsed = inputSchema.safeParse(value)
  if (!parsed.success) return null
  const input = parsed.data, evidence = input.bodies.terminalEvidence
  const previous = evidence.previous ? { ...evidence.previous,
    segments: [...evidence.previous.segments].sort((a, b) => a.segmentId.localeCompare(b.segmentId)),
    ...(evidence.previous.carried ? { carried: [...evidence.previous.carried].sort((a, b) => a.proofHash.localeCompare(b.proofHash)) } : {}) } : null
  return runtimeJson({ chapterId: input.chapterId, revision: input.revision, targetType: input.targetType, targetId: input.targetId,
    parserVersion: 8, protocol: evidence.protocol, sourceScope: input.sourceScope,
    contentHash: runtimeJson({ content: input.bodies.current }).hash, previousContent: input.bodies.previous, previous,
    facts: [...new Map(terminalCandidateFacts(input.terminalCandidate).map(({ id, field, claim }) => [id, { id, field, claim }])).values()].sort((a, b) => a.id.localeCompare(b.id)),
    proofs: terminalProofCatalog(input.terminalCandidate, evidence).map(item => item.fact.proofHash) }).hash
}

export function sameTerminalInputSubject(left: unknown, right: unknown) {
  const key = terminalInputSemanticKey(left)
  return key !== null && key === terminalInputSemanticKey(right)
}

export type TerminalInputDecision = NonNullable<Awaited<ReturnType<typeof readTerminalInputDecision>>>

export function terminalInputDecisionCurrent(expected: Pick<TerminalInputDecision, 'key' | 'proofHash'>,
  current: TerminalInputDecision | null, attempts: ReadonlySet<string>) {
  return !!current && current.runStatus === 'running' && current.key === expected.key && current.proofHash === expected.proofHash
    && !current.nativeClaims.every(claim => attempts.has(claim))
}

/** This narrows an already authenticated control turn; ordinary tool schema,
 * ownership, approval and semantic admission still run for the selected call. */
export function terminalInputDecisionAction(plan: Pick<TerminalInputDecision, 'compilationId' | 'chapterId'>,
  calls: Array<{ name: string; args: Record<string, unknown> | null }>, afterRead: boolean, readConsumed: boolean) {
  if (calls.length !== 1 || !calls[0].args) return null
  const { name, args } = calls[0]
  const same = args.chapterId === undefined || args.chapterId === plan.chapterId
  if (name === 'continuity_validate' && args.compilationId === plan.compilationId && same
    && (args.terminalPatch !== undefined || args.terminalState !== undefined || args.inheritedProofs !== undefined)) return 'decision' as const
  if (name === 'ask_user') return 'ask' as const
  if (!afterRead && !readConsumed && (name === 'chapter_read' && args.chapterId === plan.chapterId
    || name === 'chapter_bridge_get' && args.compilationId === plan.compilationId && same)) return 'read' as const
  return null
}

/** One current, returned, paid failure. Unknown/missing responses are never a
 * decision opportunity and no caller-supplied verdict can create this proof. */
export async function readTerminalInputDecision(db: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string; signal?: AbortSignal }, compilationId?: string) {
  subject.signal?.throwIfAborted()
  const original = await readWritingScope(db, subject)
  if (original.parentRunId || original.writing?.kind !== 'bounded') return null
  const run = await db.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId,
    status: { in: ['running', 'paused'] } }, select: { id: true, status: true } })
  if (!run) return null
  const runIds = await originalTaskRunIds(db, subject, original)
  const compilation = await db.storyCompilation.findFirst({ where: { userId: subject.userId, novelId: subject.novelId, runId: { in: runIds },
    status: 'active', ...(compilationId ? { id: compilationId } : {}) }, include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } },
    chapter: { select: { id: true, revision: true, content: true, orderIndex: true, title: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  const chapter = compilation?.chapter, validation = object(compilation?.validation), audit = object(validation.continuityCriticResponse)
  if (!compilation || !chapter || !compilation.bridge || validation.independentCheck !== 'unavailable' || !knownFinalContinuityFailure(audit)
    || (audit.parserVersion !== 8 && audit.parserVersion !== 9) || validation.checkedChapterId !== chapter.id || validation.checkedRevision !== chapter.revision
    || !original.writing.targets.some(target => target.orderIndex === chapter.orderIndex
      && (target.chapterId ?? original.bindings?.targets.find(binding => binding.orderIndex === target.orderIndex)?.chapterId) === chapter.id)) return null
  if (await db.agentProviderAttempt.count({ where: { runId: { in: runIds }, status: { in: ['prepared', 'dispatching', 'dispatched', 'unknown'] } } })) return null
  const ownedCompilations = await db.storyCompilation.findMany({ where: { userId: subject.userId, novelId: subject.novelId,
    runId: { in: runIds }, chapterId: chapter.id }, select: { id: true } })
  const paid = await db.aiUsageLog.findMany({ where: { userId: subject.userId, novelId: subject.novelId,
    action: { startsWith: 'agent3Continuity' }, OR: [{ agentRunId: { in: runIds } },
      { targetType: 'story_compilation', targetId: { in: ownedCompilations.map(item => item.id) } }, { targetType: 'chapter', targetId: chapter.id }] } })
  const unknown = paid.filter(row => !isKnownRejectedTextRequestAttempt(row) && !(row.usageSource === 'reported' && isKnownTextRequestBilling(row)))
  const retired = unknown.length ? await readRetiredReviewUsageIds(db, subject, runIds) : new Set<string>()
  if (unknown.some(row => !retired.has(row.id))) return null
  const request = object(audit.assessmentRequest)
  const reservations = await db.agentArtifact.findMany({ where: { runId: { in: runIds }, run: { userId: subject.userId, novelId: subject.novelId },
    artifactType: 'continuityReview', metadata: { path: ['continuityAssessmentRequestKey'], equals: String(request.key) } }, take: 2 })
  if (reservations.length !== 1) return null
  const reservation = reservations[0], meta = object(reservation.metadata), parsed = inputSchema.safeParse(meta.input)
  if (!parsed.success || typeof meta.callId !== 'string' || !/^[a-f0-9]{64}$/u.test(String(request.key))
    || runtimeJson(parsed.data).hash !== request.inputHash) return null
  const input = parsed.data, evidence = input.bodies.terminalEvidence, candidate = terminalCandidateSchema.safeParse(validation.terminalCandidate)
  if (!candidate.success || runtimeJson(candidate.data).hash !== runtimeJson(input.terminalCandidate).hash || input.targetId !== compilation.id
    || input.chapterId !== chapter.id || input.revision !== chapter.revision || input.bodies.current !== chapter.content) return null
  const protocol = storedContinuityProtocol(validation)
  if (protocol !== 10 && protocol !== 11) return null
  const source = await readCompilerContinuitySource(db, subject, chapter, compilation.bridge.fromChapterId, protocol)
  if (compilation.bridge.fromChapterId && source?.revision !== compilation.bridge.sourceRevision
    || input.bodies.previous !== (source?.content ?? null)
    || runtimeJson(input.sourceScope).hash !== runtimeJson(compilerEvidenceScope(chapter, source)).hash) return null
  let current = terminalEvidenceContext(chapter, source, evidence.protocol, evidence.quoteAddressProtocol,
    terminalCoverageInput(original.spec, compilation.preparedContext, chapter, candidate.data, evidence.factCoverage?.version,
      terminalCoverageProofs(source, evidence.spanAddressProtocol)), evidence.verdictProtocol, evidence.spanAddressProtocol)
  try { current = attachTerminalProposalInput(current, { taskId: String(object(original.spec).id), preparedContext: compilation.preparedContext,
    validation, candidate: candidate.data }) } catch { return null }
  const coverage = compilerContinuityCoverage({ chapter, bridge: compilation.bridge, sceneTasks: compilation.sceneTasks, source,
    focus: typeof validation.reviewFocus === 'string' ? validation.reviewFocus : undefined, terminalCandidate: candidate.data }, protocol)
  if (runtimeJson(current).hash !== runtimeJson(evidence).hash || runtimeJson(coverage).hash !== input.bindingHash
    || runtimeJson(validation.coverage).hash !== input.bindingHash) return null
  const lifecycle = await import('./assessment-response-lifecycle.js'), ctx = { ...subject, runId: reservation.runId, callId: meta.callId }
  if (lifecycle.legacyContinuityAssessmentKey(ctx, input) !== meta.continuityAssessmentRequestKey) return null
  let received: Awaited<ReturnType<typeof lifecycle.readLegacyContinuityAssessment>>
  try { received = await lifecycle.readLegacyContinuityAssessment(db, ctx as Parameters<typeof lifecycle.readLegacyContinuityAssessment>[1], input) }
  catch (error) {
    if (error instanceof SyntaxError || error instanceof DataAccessError
      && ['RUNTIME_RECEIPT_INVALID', 'RUNTIME_RECONCILIATION_REQUIRED', 'CONTINUITY_REPORT_INCOMPLETE'].includes(error.code)) return null
    throw error
  }
  if (received.inspected.complete || !knownFinalContinuityFailure(received.inspected.audit) || !received.billingKnown
    || !received.providerComplete || !received.recoveryReady) return null
  const bound = lifecycle.bindLegacyContinuityAssessment(received.inspected, ctx as Parameters<typeof lifecycle.bindLegacyContinuityAssessment>[1], input)
  if (runtimeJson(bound.audit).hash !== runtimeJson(audit).hash) return null
  const frames = await db.agentArtifact.findMany({ where: { runId: reservation.runId, artifactType: 'continuityReview',
    metadata: { path: ['assessmentKey'], equals: meta.continuityAssessmentRequestKey } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const inspected = []
  for (const row of frames) {
    const frame = object(row.metadata), response = object(frame.response)
    if (response.transportComplete !== true || response.finishReason !== 'stop' || !Array.isArray(response.toolCalls) || response.toolCalls.length
      || typeof response.content !== 'string' || runtimeJson(frame.input).hash !== runtimeJson(input).hash) return null
    let raw: unknown
    try { raw = JSON.parse(response.content) } catch { return null }
    if (typeof raw !== 'string') return null
    const result = inspectAuthenticatedContinuityAssessment(raw, input, true)
    if (runtimeJson(result.audit).hash !== runtimeJson(frame.audit).hash) return null
    inspected.push({ frame, result, raw, at: row.createdAt })
  }
  const first = inspected.filter(item => item.frame.stage === 'first').at(-1), seconds = inspected.filter(item => item.frame.stage === 'reassessment')
  if (!first || inspected.filter(item => item.frame.stage === 'first').length !== 1 || seconds.length > 1
    || inspected.some(item => !['first', 'reassessment'].includes(String(item.frame.stage)))) return null
  const claims = await db.agentArtifact.findMany({ where: { runId: reservation.runId, artifactType: 'continuityReview',
    metadata: { path: ['fullReassessmentKey'], equals: meta.continuityAssessmentRequestKey } }, take: 2 })
  if (claims.length > 1 || !claims.length && seconds.length) return null
  if (claims.length) {
    const claim = object(claims[0].metadata)
    if (!seconds.length || runtimeJson(claim.input).hash !== runtimeJson(input).hash || runtimeJson(claim.original).hash !== runtimeJson(first.result.audit).hash
      || runtimeJson(claim.request).hash !== runtimeJson(lifecycle.continuityReassessmentRequest(input.system, input.content,
        first.result, input.bodies, false, input.reassessmentProtocol)).hash) return null
  }
  const events = await db.agentRunEvent.findMany({ where: { runId: reservation.runId, type: { in: ['tool.call', 'tool.result'] },
    payload: { path: ['callId'], equals: meta.callId } }, orderBy: { seq: 'asc' }, take: 3 })
  const call = events[0], end = events[1], result = object(end?.payload)
  const emittedAt = (event: typeof events[number] | undefined) => {
    if (!event) return null
    const payload = object(event.payload)
    if (payload.seq !== undefined && payload.seq !== event.seq || payload.type !== undefined && payload.type !== event.type) return null
    if (payload.ts === undefined) return event.createdAt
    if (typeof payload.ts !== 'string') return null
    const date = new Date(payload.ts)
    return Number.isFinite(date.getTime()) && date.toISOString() === payload.ts ? date : null
  }
  const callAt = emittedAt(call), endAt = emittedAt(end)
  const lastResponse = frames.reduce((date, row) => row.createdAt > date ? row.createdAt : date, reservation.createdAt)
  if (events.length !== 2 || call.type !== 'tool.call' || end.type !== 'tool.result' || end.seq <= call.seq
    || object(call.payload).toolName !== 'continuity_validate' || result.toolName !== 'continuity_validate' || result.ok !== false
    || !callAt || !endAt || callAt > reservation.createdAt || endAt < lastResponse
    || !['CONTINUITY_EVIDENCE_UNLOCATED', 'CONTINUITY_REPORT_INCOMPLETE'].includes(String(result.failureCode))) return null
  const semanticInput = terminalInputSemanticKey(input)!, identity = { taskId: String(object(original.spec).id), userId: subject.userId, novelId: subject.novelId,
    compilationId: compilation.id, chapterId: chapter.id, revision: chapter.revision, contentHash: current.current.contentHash,
    sourceHash: runtimeJson({ previousContent: source?.content ?? '', previousChapterId: compilation.bridge.fromChapterId }).hash, semanticInput }
  const controlKey = (phase: string) => runtimeJson({ kind: 'terminal-input-decision', version: 1, ...identity, phase }).hash
  const nativeEpisode = terminalProcessingEpisodeKey({ userId: subject.userId, novelId: subject.novelId, taskId: identity.taskId,
    chapterId: chapter.id, contentHash: identity.contentHash, sourceHash: identity.sourceHash, contractHash: runtimeJson(JSON.parse(JSON.stringify(original.spec))).hash })
  subject.signal?.throwIfAborted()
  return { ...identity, input: input as LegacyAssessmentInput, key: controlKey('decision'), readKey: controlKey('target-read'), runStatus: run.status,
    proofHash: runtimeJson({ audit: bound.audit, input, preparedContext: compilation.preparedContext }).hash,
    nativeClaims: [0, 1].map(index => `terminal-processing:${nativeEpisode}:${index}`),
    guidance: `[系统/当前候选决策] 已收到并结算这份完整响应，但引用或原意见处置未通过，不能宣称检查完成。相同候选、证明和正文不会因继续、换调用编号、关注点或重排再购买检查。先按当前资料作一次候选决策；若确需读取，只能读取本目标一次后立即决定。没有真实语义变化时如实暂停，不改正文来买检查，不清空已知事实或未知提议。\n${JSON.stringify({
      compilationId: compilation.id, chapterId: chapter.id, revision: chapter.revision, terminalPatchBase: { baseCandidateHash: runtimeJson(candidate.data).hash,
        facts: terminalCandidateFacts(candidate.data).map(({ id, field, claim }) => ({ factId: id, field, claim })) },
      currentTerminalState: candidate.data, currentBody: chapter.content, previousBody: source?.content ?? '',
      readOnlyCoverage: evidence.factCoverage?.obligations.map(({ id, field, claim }) => ({ readOnlyCoverageId: id, field, claim })) ?? [],
      readOnlyProposals: evidence.proposalChanges?.proposals.map(({ id, field, claim }) => ({ readOnlyProposalId: id, field, claim })) ?? [],
      inheritedProofs: evidence.previous?.carried ?? [],
      rejectedIndependentResponses: inspected.map(item => ({ stage: item.frame.stage, raw: item.raw })),
      diagnostics: continuityFailureOutput(bound.audit, '原独立报告未通过完整性核验；失败意见不是正文错误，不据此改稿。', input.bodies),
    })}` }
}
