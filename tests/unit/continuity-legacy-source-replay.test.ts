import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-candidate-contract.js'
import { terminalEvidenceContext } from '../../api/lib/agent/terminal-evidence-context.js'
import { terminalFactId } from '../../api/lib/agent/terminal-fact-identity.js'
import { advanceTerminalCoverage } from '../../api/lib/agent/terminal-fact-coverage.js'
import * as coverageModule from '../../api/lib/agent/terminal-fact-coverage.js'
import { inspectContinuityResponse } from '../../api/lib/agent/continuity-format-recovery.js'
import { readAuthenticatedContinuityAssessment } from '../../api/lib/agent/authenticated-continuity-assessment.js'
import * as lifecycle from '../../api/lib/agent/assessment-response-lifecycle.js'
import * as originals from '../../api/lib/agent/original-request.js'
import { buildContinuityReviewManifest, inspectContinuityV4, normalizeContinuityV4ProjectionV2 } from '../../api/lib/agent/continuity-review-v4.js'
import { continuitySubjectIdentity } from '../../api/lib/agent/continuity-subject-identity.js'
import { continuityModelPriceHash, continuityUsageRowHash, readNormalizedContinuityCoverageOrigins, reconstructContinuitySourceProvenance } from '../../api/lib/agent/continuity-coordinator.js'
import { terminalInputDecisionFixture } from '../helpers/terminal-input-decision-fixture.js'

type Row = { id: string; runId: string; artifactType: string; createdAt: Date; metadata: Record<string, unknown> }
const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' ? v as Record<string, unknown> : {}
afterEach(() => vi.restoreAllMocks())

async function fixture(damage?: 'ledger' | 'history' | 'projection' | 'current' | 'duplicate') {
  const subject = { userId: 'synthetic-user', novelId: 'synthetic-novel', runId: 'synthetic-run', continuityOwnerSeq: 7 }
  const spec = { id: 'synthetic-task', scope: { terminalCoverageProtocol: 2 } }
  const original = { taskId: spec.id, sourceRunId: subject.runId, parentRunId: null, spec, prompt: 'Synthetic task' }
  vi.spyOn(originals, 'readOriginalTaskRequest').mockResolvedValue(original as Awaited<ReturnType<typeof originals.readOriginalTaskRequest>>)
  vi.spyOn(originals, 'originalTaskRunIds').mockResolvedValue([subject.runId])
  const rows: Row[] = [], fees: Array<Record<string, unknown>> = []
  const write = vi.fn(() => { throw Error('Source recovery must not write or create fees') })
  const add = (id: string, metadata: Record<string, unknown>, time = rows.length + 1) =>
    rows.push({ id, runId: subject.runId, artifactType: 'continuityReview', createdAt: new Date(time), metadata })
  const usage = (id: string, action = 'agent3ContinuityCritic') => ({ id, userId: subject.userId, novelId: subject.novelId,
    agentRunId: subject.runId, chapterId: 'chapter', targetType: 'story_compilation', targetId: 'compilation', action,
    usageSource: 'reported', billingStatus: 'settled', requestTokens: 12, responseTokens: 8, reservedCreditMilli: 0, creditChargeMilli: 23 })
  const match = (row: Row, where: Record<string, unknown>) => {
    if (where.id && row.id !== where.id || typeof where.runId === 'string' && row.runId !== where.runId
      || obj(where.runId).in && !(obj(where.runId).in as string[]).includes(row.runId)
      || where.artifactType && row.artifactType !== where.artifactType) return false
    const owner = obj(where.run)
    if (owner.userId && owner.userId !== subject.userId || owner.novelId && owner.novelId !== subject.novelId) return false
    const meta = obj(where.metadata)
    const value = Array.isArray(meta.path) ? (meta.path as string[]).reduce<unknown>((v, key) => obj(v)[key], row.metadata) : undefined
    return !Array.isArray(meta.path) || value === meta.equals
  }
  const db = { agentArtifact: {
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows.filter(row => match(row, where))),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows.find(row => match(row, where)) ?? null),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.find(row => row.id === where.id) ?? null),
    create: write, update: write, delete: write,
  }, aiUsageLog: {
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => fees.filter(row => {
      const ids = obj(where.id).in
      return (!ids || (ids as string[]).includes(String(row.id))) && (!where.userId || row.userId === where.userId)
        && (!where.novelId || row.novelId === where.novelId) && (!where.agentRunId || row.agentRunId === where.agentRunId)
        && (!where.targetType || row.targetType === where.targetType) && (!where.targetId || row.targetId === where.targetId)
        && (!where.action || (typeof where.action === 'string' ? row.action === where.action
          : String(row.action).startsWith(String(obj(where.action).startsWith))))
    })),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => fees.find(row =>
      Object.entries(where).every(([key, value]) => row[key] === value)) ?? null),
    create: write, update: write, delete: write,
  }, agentRunEvent: { findMany: vi.fn(async () => [{ payload: { callId: 'physical-call', toolName: 'continuity_validate',
    args: { compilationId: 'compilation' } } }]) } } as unknown as Prisma.TransactionClient
  const inherited = { id: terminalFactId('openLoops', 'An inherited synthetic issue remains open.'), field: 'openLoops' as const,
    claim: 'An inherited synthetic issue remains open.' }
  const chapter = { id: 'chapter', revision: 4, orderIndex: 1, title: 'Synthetic chapter', content: 'The packet remains sealed. The guard waits.' }
  const candidate = terminalCandidateSchema.parse({ exitState: { objects: ['The packet remains sealed.'] } })
  const coverage = { version: 2 as const, taskId: spec.id, chapterId: chapter.id, obligations: [inherited] }
  const fact = { id: terminalFactId('objects', candidate.exitState.objects[0]), field: 'objects' as const, claim: candidate.exitState.objects[0] }
  const history: Array<Record<string, unknown>> = [], origins: Array<Record<string, unknown>> = []
  let latest: Record<string, unknown> | null = null
  let state: ReturnType<typeof advanceTerminalCoverage>
  for (const [index, content] of ['The packet remains sealed.', chapter.content].entries()) {
    const current = { ...chapter, revision: index + 1, content }
    const evidence = terminalEvidenceContext(current, null, 2, 1, coverage, 6, 2)
    const input = { chapterId: chapter.id, revision: current.revision, bodies: { previous: null, current: content, terminalEvidence: evidence },
      system: 'Synthetic reviewer.', content: 'Synthetic request ' + index, terminalCandidate: candidate, parserVersion: 8 as const,
      reassessmentProtocol: 5 as const, sourceScope: { currentOrderIndex: 1, previous: [] }, targetType: 'story_compilation' as const, targetId: 'compilation' }
    const wire = { findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind =>
      ({ kind, result: 'clear', reason: 'Complete independent review.', findingIndexes: [] })),
    terminalVerdicts: [{ claimIndex: 0, verdict: 'supported', sourceEvidence: [{ segmentId: 'c0' }] }], terminalProofVerdicts: [],
    terminalDispositions: [{ obligationIndex: 0, outcome: 'unknown', reason: 'This inherited item remains unverified.', sourceEvidence: [] }] }
    const inspected = inspectContinuityResponse(JSON.stringify(wire), input.bodies, true, 8, candidate, input.sourceScope, { responseContract: 3 })
    expect(inspected.complete).toBe(true)
    const callId = 'history-' + index, ctx = { ...subject, callId } as ToolContext, key = lifecycle.legacyContinuityAssessmentKey(ctx, input)
    const bound = lifecycle.bindLegacyContinuityAssessment(inspected, ctx, input), fee = usage('fee-' + index), reservationId = 'reservation-' + index
    const review = readAuthenticatedContinuityAssessment(bound.audit, content, evidence, true)!
    expect(review.factCoverage?.dispositions[0].outcome).toBe('unknown')
    // Independent reference for the original producer algorithm, not today's advance function.
    state = damage === 'current' ? advanceTerminalCoverage(spec, state ? { terminalFactCoverage: state } : {}, current, review, coverage)
      : { version: 1, taskId: spec.id, chapterId: chapter.id, facts: [fact],
        lastReview: { bodyHash: runtimeJson({ content }).hash, candidateHash: runtimeJson(candidate).hash, input: coverage } }
    fees.push(fee)
    add(reservationId, { version: 1, continuityAssessmentRequestKey: key, callId, input }, 10 + index * 10)
    add('owner-' + index, { version: 1, assessmentRequestOwnerKey: key, stage: 'first', callId, usageIds: [fee.id] }, 11 + index * 10)
    add('response-' + index, { version: 1, assessmentKey: key, stage: 'first', callId, input, usageIds: [fee.id], audit: inspected.audit,
      response: { content: JSON.stringify(JSON.stringify(wire)), transportComplete: true, finishReason: 'stop', toolCalls: [] } }, 12 + index * 10)
    add('application-' + index, { version: 1, assessmentApplicationKey: key, reservationId, usageIds: [fee.id] }, 13 + index * 10)
    const reportHash = runtimeJson(bound.audit).hash, bodyHash = runtimeJson({ content }).hash
    for (const item of state!.facts) if (!origins.some(origin => origin.factId === item.id))
      origins.push({ factId: item.id, reservationId, reportHash, bodyHash,
        sourceHash: runtimeJson({ previous: null }).hash, candidateHash: runtimeJson(candidate).hash, revision: current.revision })
    history.push({ reservationId, reportHash, ledgerHash: runtimeJson(state).hash, inputHash: runtimeJson(input).hash, usageIds: [fee.id] })
    latest = { reservationId, reportHash, revision: current.revision, bodyHash, establishedIssues: [] }
  }
  const projection = { version: 1 as const, originalTaskId: spec.id, compilationId: 'compilation', chapterId: chapter.id,
    ledgerHash: runtimeJson(state).hash, origins, history, currentFactIds: state!.facts.map(item => item.id), latestAppliedReport: latest,
    establishedIssues: [], dependencyScope: 'authenticated_explicit_claims_only' as const }
  if (damage === 'ledger') projection.ledgerHash = 'f'.repeat(64)
  if (damage === 'history') history[0].ledgerHash = 'f'.repeat(64)
  if (damage === 'projection') origins[0].revision = 99
  if (damage === 'duplicate') history[1].reservationId = history[0].reservationId
  const target = { compilationId: 'compilation', chapterId: chapter.id, preparedContext: { terminalFactCoverage: state } }
  const failed = terminalInputDecisionFixture({ runId: subject.runId, taskSpec: spec, chapter, compilationId: 'compilation',
    bridge: { fromChapterId: null, sourceRevision: null }, scenes: [], preparedContext: target.preparedContext })
  for (const [i, meta] of failed.metadata.entries()) add('failed-' + i, meta, 50 + i)
  fees.push(usage('first-usage'), usage('second-usage', 'agent3ContinuityCriticSecondPass'))
  const oldResult = await lifecycle.readLegacyContinuityAssessment(db, { ...subject, callId: failed.callId } as ToolContext, failed.frozen)
  expect(oldResult).toMatchObject({ billingKnown: true, providerComplete: true, recoveryReady: true, slotUsed: true, inspected: { complete: false } })
  const requestId = 'a'.repeat(64), family = 'b'.repeat(64)
  const evidence = terminalEvidenceContext(chapter, null, 2, 1, coverage, 6, 2)
  const base = { chapterId: chapter.id, revision: chapter.revision, bodies: { current: chapter.content, previous: null, terminalEvidence: evidence },
    terminalCandidate: candidate, sourceScope: { currentOrderIndex: 1, previous: [] }, targetType: 'story_compilation' as const, targetId: 'compilation' }
  const model = { tier: 'speed' as const, provider: 'fixture', modelName: 'fixture', multiplierBps: 15000,
    reasoningEffort: 'high' as const, baseUrl: 'https://provider.invalid/v1', contextWindowTokens: 128000 }
  const price = { version: 'credits-v2-itemized' as const, modelTier: 'speed' as const, multiplierBps: 11000,
    rateCardId: 'synthetic-price', rates: { inputNano: 110000, cacheNano: 27500, outputNano: 1100000 } }
  const planBody = { version: 1 as const, originalTaskId: spec.id, originalAdmissionId: subject.runId, chapterId: chapter.id,
    compilationId: 'compilation', authorityHash: runtimeJson({ spec, prompt: original.prompt }).hash,
    semanticSubjectHash: continuitySubjectIdentity(base)!, modelPriceHash: continuityModelPriceHash(model, price), budgetOwner: spec.id,
    supplementalSourceKey: family, phases: [{ kind: 'full_reassessment' as const, limit: 1, authoritySourceRef: 'continuity-question:' + requestId }] }
  const plan = { ...planBody, hash: runtimeJson(planBody).hash }
  const manifest = buildContinuityReviewManifest({ subject: { userId: subject.userId, novelId: subject.novelId, taskId: spec.id,
    targetType: base.targetType, targetId: base.targetId, chapterId: chapter.id, revision: chapter.revision },
  bodies: base.bodies, candidate, sourceScope: base.sourceScope, sourceHash: null, sourceVersions: { current: evidence.current },
  verifiedCoverage: coverage, draftProposals: null, typedLineage: { version: 1, phasePlan: plan, priorFindings: [], establishedIssues: [] } })
  const input = { ...base, parserVersion: 10 as const, reassessmentProtocol: 7 as const, system: 'Synthetic full reviewer.',
    content: 'Synthetic full request.', continuityManifest: manifest }
  const wire = { findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind =>
    ({ kind, result: 'clear', reasonCode: 'consistent', explanation: 'The synthetic chapter is consistent.', findingIds: [] })),
  terminalVerdicts: [{ claimIndex: 0, verdict: 'supported', reasonCode: 'consistent', explanation: 'The packet remains sealed.',
    manuscriptEvidence: [{ segmentId: 'c0' }] }], terminalProofVerdicts: [], terminalDispositions: [{ obligationIndex: 0,
    outcome: 'unknown', reasonCode: 'historical_reference', explanation: 'The previous issue remains background and is not resolved.',
    manuscriptEvidence: [] }], issueDispositions: [] }
  const raw = JSON.stringify(wire), strict = inspectContinuityV4(raw, { manifest, bodies: input.bodies, candidate, sourceScope: input.sourceScope })
  expect(strict.complete).toBe(true)
  const oldAudit = lifecycle.bindLegacyContinuityAssessment(oldResult.inspected, { ...subject, callId: failed.callId } as ToolContext, failed.frozen).audit
  const frozen = { version: 1, originalTaskId: spec.id, originalAssessmentKey: failed.key, source: { runId: subject.runId, callId: failed.callId },
    oldInput: failed.frozen, oldAuditHash: runtimeJson(oldAudit).hash, rawHashes: [failed.firstWire, failed.secondWire].map(v => runtimeJson({ raw: JSON.stringify(v) }).hash),
    originalUsage: fees.filter(row => ['first-usage', 'second-usage'].includes(String(row.id))).map(row => ({ id: String(row.id), hash: continuityUsageRowHash(row) })),
    input, model, price, sourceRecoveryHash: runtimeJson(projection).hash, validationHash: 'c'.repeat(64), preparedHash: 'd'.repeat(64),
    coverage: {}, focus: '', inputTokenCeiling: 10000, maximumCreditMilli: 1000, maxPhysicalRequests: 1, formatRepairRequests: 0 }
  const body = { version: 1, requestId, callId: 'question-call', userId: subject.userId, novelId: subject.novelId,
    runId: subject.runId, ownerSeq: 7, expiresAt: '2030-01-01T00:00:00.000Z', question: 'Approve this synthetic phase?', accept: 'Approve', reject: 'Reject', frozen }
  const question = { ...body, requestHash: runtimeJson(body).hash }
  add(requestId, { version: 1, continuitySupplementQuestion: question })
  add(runtimeJson({ kind: 'continuity_supplement_answer', requestId }).hash, { version: 1, continuitySupplementAnswer: {
    requestId, requestHash: question.requestHash, userId: subject.userId, answer: question.accept, decision: 'accept', answeredAt: '2029-01-01T00:00:00.000Z' } })
  add('recovery', { version: 1, continuitySourceRecovery: { originalAssessmentKey: failed.key, projection } })
  const receipt = (kind: string) => runtimeJson({ kind, originalFailedSubject: family }).hash
  const executionId = runtimeJson({ kind: 'continuity_supplement_execution', originalFailedSubject: family, ownerSeq: 7 }).hash
  const inputHash = runtimeJson(input).hash, fee = { ...usage('supplement-fee'), providerName: model.provider,
    modelTier: model.tier, modelName: model.modelName, multiplierBps: model.multiplierBps, billingSnapshot: price }
  fees.push(fee)
  add(runtimeJson({ kind: 'continuity_phase', taskId: spec.id, chapterId: chapter.id, phase: 'full_reassessment', ordinal: 0,
    originalFailedSubject: family }).hash, { version: 1, continuityPhaseClaim: { version: 1, planHash: plan.hash, originalTaskId: spec.id,
      phase: 'full_reassessment', ordinal: 0, operationRef: failed.key, exactInputHash: inputHash, ownerEpoch: '7' } })
  add(executionId, { version: 1, continuitySupplementExecution: { requestId, requestHash: question.requestHash, inputHash, ownerSeq: 7, callId: 'physical-call' } })
  add(receipt('continuity_supplement_dispatch'), { version: 1, continuitySupplementDispatch: { requestId, requestHash: question.requestHash,
    inputHash, usageId: fee.id, at: '2029-01-01T00:00:00.000Z', executionId, ownerSeq: 7, callId: 'physical-call' } })
  add(receipt('continuity_supplement_usage'), { version: 1, continuitySupplementUsage: { requestId, requestHash: question.requestHash, inputHash, executionId, usageId: fee.id } })
  add(receipt('continuity_supplement_response'), { version: 1, continuitySupplementResponse: { requestId, requestHash: question.requestHash, usageId: fee.id, raw, complete: true } })
  const originAudit = { ...strict.audit, phaseRequest: { version: 1 as const, requestId, originalAssessmentKey: failed.key, inputHash, usageId: fee.id } }
  const normalized = normalizeContinuityV4ProjectionV2({ ...strict, audit: originAudit }, inputHash)
  expect(normalized.audit.continuityV4.projectionNormalization?.version).toBe(2)
  const marker = normalized.audit.continuityV4.projectionNormalization!
  add(receipt('continuity_supplement_application'), { version: 1, continuitySupplementApplication: { requestId,
    reportComplete: strict.complete, reportHash: runtimeJson(originAudit).hash, usageId: fee.id, classification: strict.audit.classification } })
  add(receipt('continuity_supplement_projection_application'), { version: 1, continuitySupplementProjectionApplication: {
    version: 1, requestId, requestHash: question.requestHash, originReportHash: runtimeJson(originAudit).hash,
    reportHash: runtimeJson(normalized.audit).hash, frozenInputHash: inputHash, rawHash: marker.rawHash, derivationHash: marker.derivationHash,
    usageId: fee.id, reportComplete: true } })
  return { subject, spec, db, rows, fees, projection, target, audit: normalized.audit, frozen, candidate, chapter, coverage, inherited, write }
}

describe('authenticated historical source replay', () => {
  it('reconstructs the full frozen source using its original applied-report ledger', async () => {
    const f = await fixture(), before = JSON.stringify({ rows: f.rows, fees: f.fees })
    const reads = vi.spyOn(lifecycle, 'readLegacyContinuityAssessment')
    const actual = await readNormalizedContinuityCoverageOrigins(f.db, f.subject, f.target, f.audit)
    expect(actual).toEqual(f.projection)
    expect(runtimeJson(actual).hash).toBe(f.frozen.sourceRecoveryHash)
    expect(actual!.currentFactIds).not.toContain(f.inherited.id)
    expect(JSON.stringify({ rows: f.rows, fees: f.fees })).toBe(before)
    expect(reads.mock.calls.map(call => call[2].content)).toEqual([
      'Synthetic frozen request.', 'Synthetic request 0', 'Synthetic request 1',
    ])
  })
  it('stops between historical receipts when cancelled without writing or issuing another paid request', async () => {
    const f = await fixture(), before = JSON.stringify({ rows: f.rows, fees: f.fees }), controller = new AbortController()
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No new request is authorized'))
    const advance = coverageModule.replayLegacyTerminalCoverageReceipt
    const replay = vi.spyOn(coverageModule, 'replayLegacyTerminalCoverageReceipt').mockImplementation((...args) => {
      const state = advance(...args)
      controller.abort()
      return state
    })
    await expect(readNormalizedContinuityCoverageOrigins(f.db, { ...f.subject, signal: controller.signal }, f.target, f.audit))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(replay).toHaveBeenCalledOnce()
    expect(f.write).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(JSON.stringify({ rows: f.rows, fees: f.fees })).toBe(before)
  })
  it('repeats the same authenticated recovery read with identical hashes and no writes or new charges', async () => {
    const f = await fixture(), before = JSON.stringify({ rows: f.rows, fees: f.fees })
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No new request is authorized'))
    const replay = vi.spyOn(coverageModule, 'replayLegacyTerminalCoverageReceipt')
    const first = await readNormalizedContinuityCoverageOrigins(f.db, f.subject, f.target, f.audit)
    const second = await readNormalizedContinuityCoverageOrigins(f.db, f.subject, f.target, f.audit)
    expect(first).toEqual(f.projection)
    expect(second).toEqual(first)
    expect(runtimeJson(first).hash).toBe(f.frozen.sourceRecoveryHash)
    expect(runtimeJson(second).hash).toBe(f.frozen.sourceRecoveryHash)
    expect(replay).toHaveBeenCalledTimes(4)
    expect(f.write).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(JSON.stringify({ rows: f.rows, fees: f.fees })).toBe(before)
  })
  it('rejects a frozen history with duplicate reservation identities without replay or writes', async () => {
    const f = await fixture('duplicate'), before = JSON.stringify({ rows: f.rows, fees: f.fees })
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No new request is authorized'))
    const replay = vi.spyOn(coverageModule, 'replayLegacyTerminalCoverageReceipt')
    await expect(readNormalizedContinuityCoverageOrigins(f.db, f.subject, f.target, f.audit))
      .rejects.toMatchObject({ code: 'CONTINUITY_PHASE_AUTHORITY_REQUIRED' })
    expect(replay).not.toHaveBeenCalled()
    expect(f.write).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(JSON.stringify({ rows: f.rows, fees: f.fees })).toBe(before)
  })
  it('keeps the current algorithm for ordinary reconstruction', async () => {
    const f = await fixture()
    await expect(reconstructContinuitySourceProvenance(f.db, f.subject, f.target)).rejects.toMatchObject({ code: 'CONTINUITY_PHASE_AUTHORITY_REQUIRED' })
    const input = obj(f.rows.find(row => row.id === 'reservation-0')!.metadata).input as lifecycle.LegacyAssessmentInput
    const ctx = { ...f.subject, callId: 'history-0' } as ToolContext
    const result = await lifecycle.readLegacyContinuityAssessment(f.db, ctx, input)
    const audit = lifecycle.bindLegacyContinuityAssessment(result.inspected, ctx, input).audit
    const review = readAuthenticatedContinuityAssessment(audit, input.bodies.current, input.bodies.terminalEvidence, true)!
    const next = advanceTerminalCoverage(f.spec, {}, { id: f.chapter.id, content: input.bodies.current }, review, f.coverage)
    expect(next!.facts.map(item => item.id)).toContain(f.inherited.id)
    const current = advanceTerminalCoverage(f.spec, { terminalFactCoverage: next }, f.chapter,
      readAuthenticatedContinuityAssessment(lifecycle.bindLegacyContinuityAssessment(
        (await lifecycle.readLegacyContinuityAssessment(f.db, { ...f.subject, callId: 'history-1' } as ToolContext,
          obj(f.rows.find(row => row.id === 'reservation-1')!.metadata).input as lifecycle.LegacyAssessmentInput)).inspected,
        { ...f.subject, callId: 'history-1' } as ToolContext,
        obj(f.rows.find(row => row.id === 'reservation-1')!.metadata).input as lifecycle.LegacyAssessmentInput).audit,
      f.chapter.content, (obj(f.rows.find(row => row.id === 'reservation-1')!.metadata).input as lifecycle.LegacyAssessmentInput).bodies.terminalEvidence, true)!, f.coverage)
    const target = { ...f.target, preparedContext: { terminalFactCoverage: current } }
    const rebuilt = await reconstructContinuitySourceProvenance(f.db, f.subject, target)
    expect(rebuilt.currentFactIds).toContain(f.inherited.id)
    const { phaseRequest: _phase, ...nonSupplement } = f.audit
    const replay = vi.spyOn(coverageModule, 'replayLegacyTerminalCoverageReceipt')
    expect(await readNormalizedContinuityCoverageOrigins(f.db, f.subject, target, nonSupplement)).toEqual(rebuilt)
    expect(replay).not.toHaveBeenCalled()
  })
  it.each(['ledger', 'history', 'projection'] as const)('rejects a frozen %s change even when its question hash matches', async damage => {
    const f = await fixture(damage)
    if (damage === 'projection') expect(await readNormalizedContinuityCoverageOrigins(f.db, f.subject, f.target, f.audit)).toBeNull()
    else await expect(readNormalizedContinuityCoverageOrigins(f.db, f.subject, f.target, f.audit))
      .rejects.toMatchObject({ code: 'CONTINUITY_PHASE_AUTHORITY_REQUIRED' })
  })
  it.each(['saved-projection', 'frozen-hash', 'wrong-owner', 'consent', 'physical-raw', 'phase-claim',
    'unknown-original-fee', 'unknown-supplement-fee', 'historical-raw', 'application'] as const)(
    'rejects %s without attempting the historical algorithm', async damage => {
      const f = await fixture(), replay = vi.spyOn(coverageModule, 'replayLegacyTerminalCoverageReceipt')
      if (damage === 'saved-projection') obj(obj(f.rows.find(row => row.id === 'recovery')!.metadata).continuitySourceRecovery).projection = { ...f.projection, ledgerHash: '0'.repeat(64) }
      if (damage === 'frozen-hash') f.frozen.sourceRecoveryHash = '0'.repeat(64)
      if (damage === 'consent') {
        const answer = f.rows.find(row => obj(row.metadata).continuitySupplementAnswer)!
        obj(answer.metadata.continuitySupplementAnswer).decision = 'reject'
      }
      if (damage === 'physical-raw') {
        const response = f.rows.find(row => obj(row.metadata).continuitySupplementResponse)!
        obj(response.metadata.continuitySupplementResponse).raw = '{}'
      }
      if (damage === 'phase-claim') {
        const claim = f.rows.find(row => obj(row.metadata).continuityPhaseClaim)!
        obj(claim.metadata.continuityPhaseClaim).operationRef = 'wrong-operation'
      }
      if (damage === 'unknown-original-fee') f.fees.find(row => row.id === 'fee-0')!.billingStatus = 'pending_usage'
      if (damage === 'unknown-supplement-fee') f.fees.find(row => row.id === 'supplement-fee')!.billingStatus = 'pending_usage'
      if (damage === 'historical-raw') obj(f.rows.find(row => row.id === 'response-0')!.metadata.response).content = JSON.stringify('{}')
      if (damage === 'application') f.rows.find(row => row.id === 'application-0')!.metadata.reservationId = 'wrong-reservation'
      const call = readNormalizedContinuityCoverageOrigins(f.db,
        damage === 'wrong-owner' ? { ...f.subject, userId: 'other-user' } : f.subject, f.target, f.audit)
      if (['unknown-original-fee', 'historical-raw', 'application'].includes(damage)) await expect(call).rejects.toBeDefined()
      else expect(await call).toBeNull()
      expect(replay).not.toHaveBeenCalled()
    })
  it.each(['legacy', 'current'] as const)('keeps a legitimate later application outside the frozen %s source', async kind => {
    const f = await fixture(kind === 'current' ? 'current' : undefined)
    const replay = vi.spyOn(coverageModule, 'replayLegacyTerminalCoverageReceipt')
    const input = structuredClone(obj(f.rows.find(row => row.id === 'reservation-1')!.metadata).input as lifecycle.LegacyAssessmentInput)
    const callId = 'later-call', key = lifecycle.legacyContinuityAssessmentKey({ ...f.subject, callId }, input)
    const templates = ['reservation-1', 'owner-1', 'response-1', 'application-1']
    for (const [i, id] of templates.entries()) {
      const row = structuredClone(f.rows.find(item => item.id === id)!), meta = row.metadata
      row.id = 'later-' + i; row.createdAt = new Date(100 + i)
      if (meta.continuityAssessmentRequestKey) meta.continuityAssessmentRequestKey = key
      if (meta.assessmentRequestOwnerKey) meta.assessmentRequestOwnerKey = key
      if (meta.assessmentKey) meta.assessmentKey = key
      if (meta.assessmentApplicationKey) meta.assessmentApplicationKey = key
      if (meta.reservationId) meta.reservationId = 'later-0'
      if (meta.callId) meta.callId = callId
      if (meta.input) meta.input = input
      if (meta.usageIds) meta.usageIds = ['later-fee']
      f.rows.push(row)
    }
    f.fees.push({ ...f.fees.find(row => row.id === 'fee-1')!, id: 'later-fee' })
    expect(await readNormalizedContinuityCoverageOrigins(f.db, f.subject, f.target, f.audit)).toEqual(f.projection)
    expect(replay).toHaveBeenCalledTimes(kind === 'legacy' ? 2 : 0)
    replay.mockClear()
    f.fees.find(row => row.id === 'later-fee')!.billingStatus = 'pending_usage'
    await expect(readNormalizedContinuityCoverageOrigins(f.db, f.subject, f.target, f.audit)).rejects.toBeDefined()
    expect(replay).not.toHaveBeenCalled()
  })
})
