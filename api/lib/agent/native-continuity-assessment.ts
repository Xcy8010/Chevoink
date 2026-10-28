import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { durableChatResultSchema, runtimeJson } from './runtime-common.js'
import { readToolOperationSource } from './runtime-tool-cursor.js'
import { readHistoricalWritingServiceSource } from './runtime-writing-service.js'
import { readExecutionStateInTransaction } from './runtime-state.js'
import { terminalCandidateSchema } from './terminal-candidate-contract.js'
import { terminalEvidenceContextSchema } from './terminal-evidence-context.js'
import { continuitySourceScopeSchema } from './continuity-source-authority.js'
import { continuityReviewManifestSchema } from './continuity-review-v4.js'
import { inspectAuthenticatedContinuityAssessment, isContinuityV4Inspection, type AuthenticatedContinuityInspection } from './authenticated-continuity-assessment.js'
import { applyContinuityReassessment, failedContinuityReassessment, continuityReassessmentRequest, type LegacyAssessmentInput } from './assessment-response-lifecycle.js'
import { continuityFindingInputSchema } from '../../../shared/contracts/story-compiler-contracts.js'
import { tokenPriceSchema } from '../billing/token-price.js'
import { readContinuityPhaseClaim, continuityAssessmentPhase, assertContinuityAssessmentSubject } from './continuity-coordinator.js'

const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const workSchema = z.object({ kind: z.literal('check'), version: z.union([z.literal(18), z.literal(21), z.literal(22), z.literal(23)]),
  chapter: z.object({ id: z.string(), revision: z.number().int(), content: z.string(), orderIndex: z.number().int() }),
  compiler: z.object({ id: z.string() }), terminalCandidate: terminalCandidateSchema.optional(),
  sourceBodies: z.object({ previous: z.string().nullable(), current: z.string(), terminalEvidence: terminalEvidenceContextSchema }).strict(),
  sourceScope: continuitySourceScopeSchema, continuityManifest: continuityReviewManifestSchema.optional(),
  reassessmentProtocol: z.union([z.literal(2), z.literal(5), z.literal(6), z.literal(7)]), criticSystem: z.string(), criticInput: z.string(), coverage: z.unknown(),
  route: z.object({ provider: z.string(), model: z.string(), baseUrl: z.string(), maxOutputTokens: z.number().int() }), price: z.unknown() })
  .refine(work => (work.version === 18) === (work.reassessmentProtocol === 2)
    && (work.terminalCandidate === undefined ? work.version === 18 || work.version === 23 && work.continuityManifest?.candidateHash === null
      : work.version !== 18 && work.continuityManifest?.candidateHash !== null))

/** Native provenance stays native. No lease, admission, billing or state writes.
 * The parent may be pending only for the exact report presently being saved;
 * every historical origin requires its own committed effect and outbox. */
export async function readNativeContinuityAssessments(db: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string }, taskId: string, runIds: string[],
  target: { compilationId: string; chapterId: string; currentAudit: unknown; operationIds?: string[]; related?: (input: unknown) => boolean }, artifacts: Array<{ metadata: unknown }>) {
  const operations = await db.agentOperation.findMany({ where: { taskRootId: taskId, originRunId: { in: runIds },
    action: 'continuity_validate', kind: { in: ['tool', 'internal'] }, ...(target.operationIds ? { id: { in: target.operationIds } } : {}) }, include: { effectReceipt: true, events: true,
    children: { include: { events: true, attempts: { include: { usageReceipt: true } } } } }, orderBy: { createdAt: 'asc' }, take: 1001 })
  if (operations.length > 1000) return null
  const entries: Array<{ input: LegacyAssessmentInput; inspected: AuthenticatedContinuityInspection; inspections: AuthenticatedContinuityInspection[];
    operationId: string; current: boolean; committed: boolean; coverage: unknown }> = []
  const forwarded: Array<{ work: Record<string, unknown>; current: boolean }> = []
  const committedOrCurrent = async (operation: typeof operations[number], sameCurrent: boolean) => {
    const receipt = operation.effectReceipt, event = operation.events.find(row => row.eventKey === `effect:${operation.id}`)
    const committed = operation.status === 'succeeded' && receipt && runIds.includes(receipt.runId)
      && runtimeJson(receipt.result).hash === receipt.resultHash && event?.type === 'effect.committed' && event.taskRootId === taskId
      && event.operationId === operation.id && runtimeJson(event.payload).hash === runtimeJson({ operationId: operation.id, resultHash: receipt.resultHash }).hash
    if (committed) return 'committed' as const
    if (!sameCurrent || operation.status !== 'prepared' || receipt) return null
    const current = await readExecutionStateInTransaction(db, taskId), pendingId = operation.kind === 'tool' ? operation.id : operation.parentOperationId
    if (current.frame.state.phase !== 'awaiting_operation' || current.frame.state.pendingOperationId !== pendingId) return null
    // Read-only provenance follows the canonical native queued/running state.
    // It grants no effects: report application still holds the exact live lease.
    const run = await db.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId,
      taskRootId: taskId, runtimeProtocolVersion: 1, status: { in: ['queued', 'running'] } }, select: { id: true, usage: true } })
    if (!run || object(run.usage).authorEnded !== undefined) return null
    const root = await db.agentTaskRoot.findFirst({ where: { id: taskId, userId: subject.userId, novelId: subject.novelId,
      authorizationMode: 'legacy', status: 'active' }, select: { id: true } })
    return root ? 'current' as const : null
  }
  for (const operation of operations) {
    const rawWork = object(object(operation.inputSnapshot).input).work, rawChapter = object(object(rawWork).chapter), rawCompiler = object(object(rawWork).compiler)
    if (rawChapter.id !== target.chapterId || rawCompiler.id !== target.compilationId) continue
    const current = object(target.currentAudit)
    const currentManifest = object(object(current.continuityV4).manifest)
    const currentContentHash = current.parserVersion === 10 && current.terminalCandidate === undefined && currentManifest.candidateHash === null
      ? currentManifest.bodyHash : current.terminalContentHash
    const projectsCurrent = runtimeJson({ candidate: object(rawWork).terminalCandidate ?? null }).hash === runtimeJson({ candidate: current.terminalCandidate ?? null }).hash
      && typeof rawChapter.content === 'string' && runtimeJson({ content: rawChapter.content }).hash === currentContentHash
    if (!projectsCurrent && (!target.related || !target.related({ terminalCandidate: object(rawWork).terminalCandidate, bodies: object(rawWork).sourceBodies }))) continue
    if (runtimeJson(operation.inputSnapshot).hash !== operation.inputHash) return null
    const raw = object(rawWork)
    if (raw.version === 18 && Array.isArray(raw.cached)) {
      const saved = operation.kind === 'tool' ? await readToolOperationSource(db, operation)
        : await readHistoricalWritingServiceSource(db, { ...subject, runId: operation.originRunId, taskRootId: taskId }, {
          operationId: operation.id, action: operation.action, novelId: subject.novelId, callId: String(object(object(operation.inputSnapshot).input).callId) })
      if (saved.input.novelId !== subject.novelId || raw.reassessmentProtocol !== 2 || raw.repair !== false
        || operation.children.some(child => child.kind === 'provider') || !z.array(continuityFindingInputSchema).safeParse(raw.cached).success
        || !await committedOrCurrent(operation, projectsCurrent)) return null
      forwarded.push({ work: raw, current: projectsCurrent }); continue
    }
    const parsed = workSchema.safeParse(rawWork)
    if (!parsed.success) return null
    const work = parsed.data
    if ((work.version === 22) !== (work.reassessmentProtocol === 6) || (work.version === 23) !== (work.reassessmentProtocol === 7) || work.sourceBodies.current !== work.chapter.content
      || work.sourceBodies.terminalEvidence.current.id !== work.chapter.id || work.sourceBodies.terminalEvidence.current.revision !== work.chapter.revision
      || (work.version === 22 || work.version === 23) && (!work.continuityManifest || work.continuityManifest.subject.userId !== subject.userId
        || work.continuityManifest.subject.novelId !== subject.novelId || work.continuityManifest.subject.taskId !== taskId
        || work.continuityManifest.subject.targetId !== target.compilationId)) return null
    const saved = operation.kind === 'tool' ? await readToolOperationSource(db, operation)
      : await readHistoricalWritingServiceSource(db, { ...subject, runId: operation.originRunId, taskRootId: taskId }, {
        operationId: operation.id, action: operation.action, novelId: subject.novelId, callId: String(object(object(operation.inputSnapshot).input).callId) })
    if (saved.input.novelId !== subject.novelId) return null
    const input: LegacyAssessmentInput = { chapterId: work.chapter.id, revision: work.chapter.revision, bodies: work.sourceBodies,
      parserVersion: work.version === 23 ? 10 : work.version === 22 ? 9 : 8, reassessmentProtocol: work.reassessmentProtocol, ...(work.terminalCandidate ? { terminalCandidate: work.terminalCandidate } : {}),
      sourceScope: work.sourceScope, ...(work.continuityManifest ? { continuityManifest: work.continuityManifest } : {}),
      system: work.criticSystem, content: work.criticInput, targetType: 'story_compilation', targetId: work.compiler.id }
    if (work.version === 23) {
      const plan = work.continuityManifest?.typedLineage?.phasePlan
      if (!plan || plan.modelPriceHash !== runtimeJson({ route: object(rawWork).route, price: object(rawWork).price }).hash) return null
      const phase = continuityAssessmentPhase(input)
      if (phase === null) {
        try { if (await assertContinuityAssessmentSubject(db, subject, input) !== null) return null }
        catch { return null }
      } else if (!await readContinuityPhaseClaim(db, subject, { plan, chapterId: work.chapter.id, phase,
        operationRef: operation.id, inputHash: operation.inputHash })) return null
    }
    const children = operation.children.filter(child => child.action.startsWith('continuity_'))
    if (children.some(child => !['continuity_critic', 'continuity_reassessment'].includes(child.action))
      || children.filter(child => child.action === 'continuity_critic').length !== 1 || children.filter(child => child.action === 'continuity_reassessment').length > 1) return null
    const read = (step: 'continuity_critic' | 'continuity_reassessment', expected: { system: string; content: string }) => {
      const child = children.find(row => row.action === step), attempt = child?.attempts[0]
      if (!child || child.parentOperationId !== operation.id || child.taskRootId !== taskId || child.kind !== 'provider' || child.operationKey !== `aux:${operation.id}:${step}`
        || child.status !== 'succeeded' || child.attempts.length !== 1 || !attempt || attempt.attemptKey !== '1' || attempt.status !== 'succeeded'
        || !runIds.includes(attempt.runId) || !attempt.dispatchedAt || !attempt.resultHash || !attempt.completedAt
        || runtimeJson(child.inputSnapshot).hash !== child.inputHash || runtimeJson(attempt.result).hash !== attempt.resultHash
        || runtimeJson(attempt.requestSnapshot).hash !== attempt.requestHash) return null
      const childInput = object(object(child.inputSnapshot).input), request = object(object(attempt.requestSnapshot).request), body = object(request.body)
      const billing = tokenPriceSchema.safeParse(childInput.billing)
      const route = object(attempt.requestSnapshot), usage = attempt.usageReceipt
      const measurement = usage && { source: usage.source, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
        cacheHitTokens: usage.cacheHitTokens, cacheMissTokens: usage.cacheMissTokens }
      const event = child.events.find(row => row.eventKey === `result:${attempt.id}:${attempt.resultHash}`)
      if (route.provider !== work.route.provider || route.model !== work.route.model || attempt.provider !== route.provider || attempt.model !== route.model
        || request.endpoint !== `${work.route.baseUrl.replace(/\/$/u, '')}/chat/completions` || body.model !== work.route.model
        || (body.max_tokens ?? body.max_completion_tokens) !== work.route.maxOutputTokens || body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length)
        || runtimeJson(childInput.request).hash !== runtimeJson(request).hash || !billing.success || runtimeJson(billing.data).hash !== runtimeJson(work.price).hash
        || runtimeJson(body.messages).hash !== runtimeJson([{ role: 'system', content: expected.system }, { role: 'user', content: expected.content }]).hash
        || !usage || usage.source !== 'reported' || usage.settlementStatus !== 'settled' || usage.promptTokens === null || usage.completionTokens === null
        || usage.promptTokens < 0 || usage.completionTokens < 0 || usage.observationHash !== runtimeJson(measurement).hash
        || !event || event.type !== 'provider.result.recorded' || event.taskRootId !== taskId || event.operationId !== child.id
        || runtimeJson(event.payload).hash !== runtimeJson({ attemptId: attempt.id, status: 'succeeded', resultHash: attempt.resultHash }).hash) return null
      const result = z.object({ outcome: z.literal('succeeded'), result: durableChatResultSchema }).strict().safeParse(attempt.result)
      return result.success && result.data.result.finishReason === 'stop' && !result.data.result.toolCalls.length ? result.data.result : null
    }
    const first = read('continuity_critic', { system: work.criticSystem, content: work.criticInput })
    if (!first) return null
    const original = inspectAuthenticatedContinuityAssessment(first.content, input, true), inspections = [original]
    let inspected = original
    const claims = artifacts.filter(row => object(row.metadata).fullReassessmentKey === `durable:${operation.id}:continuity_reassessment`)
    const secondChild = children.find(row => row.action === 'continuity_reassessment')
    if (claims.length > 1 || !!claims.length !== !!secondChild) return null
    if (secondChild) {
      const request = continuityReassessmentRequest(work.criticSystem, work.criticInput, original, work.sourceBodies, false, work.reassessmentProtocol)
      const claim = object(claims[0].metadata)
      if (runtimeJson(claim.original).hash !== runtimeJson(original.audit).hash || runtimeJson(claim.request).hash !== runtimeJson(request).hash
        || runtimeJson(claim.frozenInput).hash !== runtimeJson({ system: work.criticSystem, content: work.criticInput, bodies: work.sourceBodies, coverage: work.coverage }).hash) return null
      const second = read('continuity_reassessment', request)
      if (!second) return null
      inspections.push(inspectAuthenticatedContinuityAssessment(second.content, input, true))
      // A failed native pair is not an origin of an established fact. Retain it
      // as unverified history; the caller applies its narrow pending-only rule.
      try { inspected = applyContinuityReassessment(original, second.content, work.sourceBodies, work.reassessmentProtocol) }
      catch { inspected = failedContinuityReassessment(original, second.content, true, work.sourceBodies, work.reassessmentProtocol) }
    }
    const savedAudit = object(object(operation.effectReceipt?.result).continuityCriticResponse)
    const expectedNormalization = object(object(savedAudit.continuityV4).projectionNormalization)
    const currentNormalization = object(object(current.continuityV4).projectionNormalization)
    if ([1, 2].includes(expectedNormalization.version as number) || projectsCurrent && [1, 2].includes(currentNormalization.version as number)) {
      if (!isContinuityV4Inspection(inspected)) return null
      const v4 = await import('./continuity-review-v4.js')
      const normalization = [1, 2].includes(expectedNormalization.version as number) ? expectedNormalization : currentNormalization
      inspected = normalization.version === 2 ? v4.normalizeContinuityV4ProjectionV2(inspected, operation.inputHash) : v4.normalizeContinuityV4Projection(inspected, operation.inputHash)
      const expected = [1, 2].includes(expectedNormalization.version as number) ? savedAudit : current
      if (!inspected.complete || runtimeJson(inspected.audit).hash !== runtimeJson(expected).hash) return null
    }
    const sameCurrent = runtimeJson(inspected.audit).hash === runtimeJson(target.currentAudit).hash
    const effect = await committedOrCurrent(operation, sameCurrent)
    if (!effect) return null
    entries.push({ input, inspected, inspections, operationId: operation.id, current: sameCurrent, committed: effect === 'committed', coverage: work.coverage })
  }
  // A no-provider cache operation forwards one already authenticated paid
  // report. It is never another origin or a replacement for missing raw data.
  if (forwarded.some(({ work, current }) => !entries.some(entry => (!current || entry.current) && entry.inspected.complete && entry.committed
    && runtimeJson(work.cached).hash === runtimeJson(entry.inspected.findings).hash
    && runtimeJson(work.coverage).hash === runtimeJson(entry.coverage).hash
    && runtimeJson(work.sourceBodies).hash === runtimeJson(entry.input.bodies).hash
    && runtimeJson({ candidate: work.terminalCandidate ?? null }).hash === runtimeJson({ candidate: entry.input.terminalCandidate ?? null }).hash
    && runtimeJson(work.sourceScope).hash === runtimeJson(entry.input.sourceScope).hash))) return null
  return entries
}
