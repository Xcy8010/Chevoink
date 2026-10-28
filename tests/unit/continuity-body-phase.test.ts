import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import type { LegacyAssessmentInput } from '../../api/lib/agent/assessment-response-lifecycle.js'
import { legacyContinuityAssessmentKey, readReusableLegacyContinuityAssessment } from '../../api/lib/agent/assessment-response-lifecycle.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

const boundary = vi.hoisted(() => ({ original: vi.fn(), runs: vi.fn() }))
vi.mock('../../api/lib/agent/original-request.js', async original => ({ ...await original<object>(),
  readOriginalTaskRequest: boundary.original, originalTaskRunIds: boundary.runs }))
vi.mock('../../api/lib/agent/writing-scope.js', async original => ({ ...await original<object>(),
  assertWritingTarget: vi.fn(async () => {}), readNewDraftWritingAuthority: vi.fn(async () => ({ originalTarget: 'chapter' })) }))
vi.mock('../../api/lib/agent/chapter-review-guard.js', async original => ({ ...await original<object>(), probeChapterReviewRevision: vi.fn(async () => ({ open: true })) }))

import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-candidate-contract.js'
import { continuitySubjectIdentity, continuityWorkSubjectIdentity } from '../../api/lib/agent/continuity-subject-identity.js'
import { buildContinuityReviewManifest, inspectContinuityV4 } from '../../api/lib/agent/continuity-review-v4.js'
import { assertContinuityAssessmentSubject, claimContinuityPhase, continuityAssessmentPhase, effectiveContinuityAudit,
  prepareContinuityPhasePlan, prepareContinuityReviewLineage, stageEffectiveContinuityReport, authenticateEffectiveContinuityReport,
  reconstructContinuitySourceProvenance, authenticateInitialContinuityHistory, claimLegacyContinuityVerification } from '../../api/lib/agent/continuity-coordinator.js'
import { beginReviewCycle, advanceReviewCycle } from '../../api/lib/agent/review-cycle.js'

beforeEach(() => { vi.clearAllMocks() })

async function fixture(error = false) {
  const subject = { userId: 'author', novelId: 'novel', runId: 'run', continuityOwnerSeq: 7 }
  const original = { taskId: 'task', sourceRunId: 'run', parentRunId: null, prompt: 'Write the next chapter.',
    spec: { id: 'task', intent: 'write', qualityMode: 'balanced', scope: { writing: { targets: [{ chapterId: 'chapter', orderIndex: 1 }] } } } }
  boundary.original.mockResolvedValue(original); boundary.runs.mockResolvedValue(['run'])
  const chapter = { id: 'chapter', authorId: subject.userId, novelId: subject.novelId, revision: 4, orderIndex: 1,
    content: error ? 'The packet remains sealed. The guard opens the packet.' : 'The packet remains sealed.' }
  const context = { protocol: 2 as const, verdictProtocol: 6 as const, spanAddressProtocol: 2 as const,
    current: { id: chapter.id, revision: chapter.revision, orderIndex: chapter.orderIndex, contentHash: runtimeJson({ content: chapter.content }).hash },
    previous: null, factCoverage: { version: 2 as const, taskId: original.taskId, chapterId: chapter.id, obligations: [] } }
  const bodies = { previous: null, current: chapter.content, terminalEvidence: context }, sourceScope = { currentOrderIndex: 1, previous: [] }
  const base = { chapterId: chapter.id, revision: chapter.revision, targetType: 'story_compilation' as const, targetId: 'compilation', bodies, sourceScope }
  const planValue = { version: 1 as const, originalTaskId: original.taskId, originalAdmissionId: original.sourceRunId,
    chapterId: chapter.id, compilationId: base.targetId, authorityHash: runtimeJson({ spec: original.spec, prompt: original.prompt }).hash,
    semanticSubjectHash: continuitySubjectIdentity(base)!, modelPriceHash: 'a'.repeat(64), budgetOwner: original.taskId,
    phases: [{ kind: 'initial_review' as const, limit: 1, authoritySourceRef: 'original-admission:run' },
      { kind: 'sparse_repair' as const, limit: 1, authoritySourceRef: 'original-admission:run' }] }
  const plan = { ...planValue, hash: runtimeJson(planValue).hash }
  const manifest = buildContinuityReviewManifest({ subject: { userId: subject.userId, novelId: subject.novelId, taskId: original.taskId, targetType: base.targetType,
    targetId: base.targetId, chapterId: chapter.id, revision: chapter.revision }, bodies, sourceScope,
    sourceHash: null, sourceVersions: { current: context.current }, verifiedCoverage: context.factCoverage, draftProposals: null,
    typedLineage: { version: 1, phasePlan: plan, priorFindings: [], establishedIssues: [] } })
  const input: LegacyAssessmentInput = { ...base, parserVersion: 10, reassessmentProtocol: 7, continuityManifest: manifest,
    system: 'Frozen body review.', content: 'Frozen complete body.' }
  const raw = JSON.stringify({ findings: error ? [{ findingId: 'f0', signal: 'object', severity: 'error', reasonCode: 'manuscript_conflict',
    explanation: 'The packet cannot stay sealed after it is opened.', suggestion: 'Reconcile these two manuscript statements.',
    manuscriptEvidence: [{ segmentId: 'c0', quote: 'The packet remains sealed.' }, { segmentId: 'c0', quote: 'The guard opens the packet.' }] }] : [],
  semanticChecks: ['action_direction', 'state_progression'].map(kind => ({ kind, result: error && kind === 'state_progression' ? 'conflict' : 'clear',
    reasonCode: error && kind === 'state_progression' ? 'manuscript_conflict' : 'consistent', explanation: 'The complete manuscript was inspected.',
    findingIds: error && kind === 'state_progression' ? ['f0'] : [] })), issueDispositions: [] })
  const inspected = inspectContinuityV4(raw, { manifest, bodies, sourceScope })
  expect(inspected.complete).toBe(true)
  const fees = [{ id: 'body-fee', userId: subject.userId, novelId: subject.novelId, agentRunId: subject.runId,
    chapterId: chapter.id, targetType: base.targetType, targetId: base.targetId, action: 'agent3ContinuityCritic', usageSource: 'reported',
    billingStatus: 'settled', requestTokens: 12, responseTokens: 8, reservedCreditMilli: 0, creditChargeMilli: 23 }]
  const key = legacyContinuityAssessmentKey({ ...subject, callId: 'body' } as ToolContext, input)
  const rows: Array<{ id: string; runId: string; artifactType: string; createdAt: Date; metadata: Record<string, unknown> }> = [{ id: 'body-request',
    runId: subject.runId, artifactType: 'continuityReview', createdAt: new Date(1), metadata: { assessmentChapterId: chapter.id,
      continuityAssessmentRequestKey: key, input, callId: 'body' } }, { id: 'body-response', runId: subject.runId, artifactType: 'continuityReview', createdAt: new Date(2),
      metadata: { assessmentKey: key, stage: 'first', callId: 'body', input, usageIds: ['body-fee'], audit: inspected.audit,
        response: { content: JSON.stringify(raw), transportComplete: true, finishReason: 'stop', toolCalls: [] } } }]
  const matches = (row: typeof rows[number], where: Record<string, unknown>) => {
    if (where.id && row.id !== where.id) return false
    const metadata = where.metadata as { path?: string[]; equals?: unknown } | undefined
    return !metadata?.path || metadata.path.reduce<unknown>((value, key) => (value as Record<string, unknown>)?.[key], row.metadata) === metadata.equals
  }
  const saved = { id: base.targetId, runId: subject.runId, chapterId: chapter.id, chapter, preparedContext: {}, validation: {
    independentCheck: 'complete', checkedChapterId: chapter.id, checkedRevision: chapter.revision,
    coverage: { contentHash: context.current.contentHash }, findings: inspected.findings, continuityCriticResponse: inspected.audit,
  } as Record<string, unknown> }
  const db = { $queryRaw: vi.fn(async () => []), chapter: { findFirst: vi.fn(async () => chapter) },
    agentRun: { findFirst: vi.fn(async () => ({ id: subject.runId, status: 'running', taskRootId: null, runtimeProtocolVersion: 0, usage: {} })) },
    agentRunEvent: { findFirst: vi.fn(async () => ({ seq: subject.continuityOwnerSeq })) },
    storyCompilation: { findFirst: vi.fn(async () => saved) }, agentOperation: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
    aiUsageLog: { count: vi.fn(async () => fees.length), findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
      fees.filter(row => !where.id || where.id.in.includes(row.id))) },
    agentArtifact: { findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows.filter(row => matches(row, where))),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows.find(row => matches(row, where)) ?? null),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.find(row => row.id === where.id) ?? null),
      create: vi.fn(async ({ data }: { data: Omit<typeof rows[number], 'createdAt'> }) => { rows.push({ ...data, createdAt: new Date(rows.length + 1) }); return data }) } }
  const tx = db as unknown as Prisma.TransactionClient
  saved.validation.effectiveReport = await stageEffectiveContinuityReport(tx, subject, { compilationId: base.targetId,
    audit: inspected.audit, previousValidation: {} })
  return { subject, original, chapter, context, bodies, sourceScope, base, input, plan, inspected, saved, rows, fees, db, tx, raw, key }
}

function editBody(f: Awaited<ReturnType<typeof fixture>>) {
  const before = { ...f.chapter }, after = before.content.replace('opens the packet', 'keeps the packet sealed')
  const scope = { taskId: f.original.taskId, userId: f.subject.userId, novelId: f.subject.novelId, chapterId: f.chapter.id }
  const cycle = beginReviewCycle(scope, { compilationId: f.base.targetId, revision: before.revision, content: before.content, ready: true,
    required: { continuity: true, quality: false }, binding: { contentHash: f.context.current.contentHash,
      continuityBinding: 'body-report', qualityReportId: null, qualityReportHash: null }, findings: [] })
  const edited = advanceReviewCycle(cycle, { beforeRevision: before.revision, before: before.content, afterRevision: before.revision + 1, after })
  Object.assign(f.chapter, { revision: before.revision + 1, content: after })
  f.saved.preparedContext = { reviewCycle: edited }
  const context = { ...f.context, current: { ...f.context.current, revision: f.chapter.revision, contentHash: runtimeJson({ content: after }).hash } }
  return { ...f.base, revision: f.chapter.revision, bodies: { ...f.bodies, current: after, terminalEvidence: context } }
}

async function bodyRecheck(f: Awaited<ReturnType<typeof fixture>>, base: ReturnType<typeof editBody>) {
  const lineage = await prepareContinuityReviewLineage(f.tx, f.subject, { compilationId: base.targetId, chapterId: base.chapterId,
    input: base, semanticSubjectHash: continuitySubjectIdentity(base)!, modelPriceHash: f.plan.modelPriceHash })
  const manifest = buildContinuityReviewManifest({ ...f.input.continuityManifest!, subject: { ...f.input.continuityManifest!.subject, revision: base.revision },
    bodies: base.bodies, sourceScope: base.sourceScope, sourceVersions: { current: base.bodies.terminalEvidence.current }, typedLineage: lineage })
  return { ...base, parserVersion: 10 as const, reassessmentProtocol: 7 as const, continuityManifest: manifest,
    system: 'Frozen original-cycle body verification.', content: base.bodies.current }
}

describe('typed body review retains the original terminal phases', () => {
  it('distinguishes absent and empty candidates while preserving all existing candidate identities', async () => {
    const f = await fixture(), candidate = terminalCandidateSchema.parse({ exitState: {} }), input = { ...f.base, terminalCandidate: candidate }
    const oldProjection = { chapterId: f.chapter.id, revision: f.chapter.revision, targetType: f.base.targetType, targetId: f.base.targetId,
      current: f.context.current, previousContent: null, sourceScope: f.sourceScope, previous: null,
      facts: [], selectedProofs: [], coverage: { taskId: 'task', chapterId: 'chapter', obligations: [] }, proposals: null }
    expect(continuitySubjectIdentity(input)).toBe(runtimeJson(oldProjection).hash)
    expect(continuitySubjectIdentity(f.base)).not.toBe(continuitySubjectIdentity(input))
    const legacy = { ...f.base, bodies: { ...f.bodies, terminalEvidence: { ...f.context, verdictProtocol: 5 as const } } }
    expect(continuitySubjectIdentity(legacy)).toBe(continuitySubjectIdentity(f.base))
    expect(continuityWorkSubjectIdentity({ kind: 'check', chapter: f.chapter, compiler: { id: f.base.targetId },
      sourceBodies: legacy.bodies, sourceScope: f.sourceScope })).toBe(continuitySubjectIdentity(f.base))
  })
  it('authenticates a whole body report without terminal authority or a terminal claim', async () => {
    const f = await fixture()
    expect(continuityAssessmentPhase(f.input)).toBeNull()
    await expect(assertContinuityAssessmentSubject(f.tx, f.subject, f.input)).resolves.toBeNull()
    expect(f.inspected.terminalReview).toBeNull()
    expect(effectiveContinuityAudit(f.saved.validation)).toEqual(f.inspected.audit)
    await expect(authenticateEffectiveContinuityReport(f.tx, f.subject, f.base.targetId, f.saved.validation, ['run'])).resolves.toBe(true)
    expect(f.rows.filter(row => row.metadata.continuityPhaseClaim)).toEqual([])
  })
  it('reuses the original typed body from a different known-result call without undefined-candidate hashes or writes', async () => {
    const f = await fixture(), before = structuredClone({ rows: f.rows, fees: f.fees })
    const reused = await readReusableLegacyContinuityAssessment(f.tx, { ...f.subject, callId: 'known-result-probe', signal: new AbortController().signal } as ToolContext, f.input)
    expect(reused).toMatchObject({ complete: true, terminalReview: null, audit: { rawResponse: f.inspected.audit.rawResponse,
      assessmentRequest: { key: f.key, inputHash: runtimeJson(f.input).hash } } })
    expect(reused!.audit).not.toHaveProperty('terminalCandidate')
    expect({ rows: f.rows, fees: f.fees }).toEqual(before)
  })
  it('keeps the first real candidate on the one original initial phase and refuses a different candidate', async () => {
    const f = await fixture(), candidate = terminalCandidateSchema.parse({ exitState: { objects: ['The packet remains sealed.'] } })
    const target = { compilationId: f.base.targetId, chapterId: f.chapter.id,
      input: { ...f.input, terminalCandidate: candidate }, semanticSubjectHash: continuitySubjectIdentity({ ...f.input, terminalCandidate: candidate })!, modelPriceHash: f.plan.modelPriceHash }
    const lineage = await prepareContinuityReviewLineage(f.tx, f.subject, target)
    expect(lineage.revisionReceiptHash).toBeUndefined()
    expect(lineage.phasePlan.revisionAuthority).toBeUndefined()
    expect(lineage.phasePlan.phases.map(row => row.kind)).toEqual(['initial_review', 'sparse_repair'])
    const first = { plan: lineage.phasePlan, chapterId: f.chapter.id, phase: 'initial_review' as const,
      operationRef: 'candidate-request', inputHash: 'b'.repeat(64), ownerEpoch: 'run:7' }
    expect(await claimContinuityPhase(f.tx, f.subject, first)).toBe(true)
    expect(await claimContinuityPhase(f.tx, f.subject, first)).toBe(false)
    const changed = terminalCandidateSchema.parse({ exitState: { objects: ['Another claim.'] } })
    const next = await prepareContinuityReviewLineage(f.tx, f.subject, { ...target, input: { ...f.input, terminalCandidate: changed },
      semanticSubjectHash: continuitySubjectIdentity({ ...f.input, terminalCandidate: changed })! })
    await expect(claimContinuityPhase(f.tx, f.subject, { ...first, plan: next.phasePlan, operationRef: 'another-request' }))
      .rejects.toMatchObject({ code: 'CONTINUITY_PHASE_AUTHORITY_REQUIRED' })
    expect(f.rows.filter(row => row.metadata.continuityPhaseClaim)).toHaveLength(1)
  })
  it('carries the source-bound typed body explanation and finding identity into the first candidate', async () => {
    const f = await fixture(true), candidate = terminalCandidateSchema.parse({ exitState: { objects: ['The packet is open.'] } })
    const lineage = await prepareContinuityReviewLineage(f.tx, f.subject, { compilationId: f.base.targetId, chapterId: f.chapter.id,
      input: { ...f.input, terminalCandidate: candidate }, semanticSubjectHash: continuitySubjectIdentity({ ...f.input, terminalCandidate: candidate })!, modelPriceHash: f.plan.modelPriceHash })
    expect(lineage.priorFindings).toEqual([expect.objectContaining({ findingId: 'f0', text: 'The packet cannot stay sealed after it is opened.',
      reportHash: runtimeJson(f.inspected.audit).hash, origin: expect.objectContaining({ bodyHash: f.context.current.contentHash, revision: f.chapter.revision }) })])
    expect(lineage.establishedIssues).toEqual(lineage.priorFindings)
    expect(f.rows.filter(row => row.metadata.continuityPhaseClaim)).toEqual([])
  })
  it.each(['billingKnown', 'providerComplete', 'recoveryReady'] as const)('retains %s reconciliation before the first candidate', async field => {
    const f = await fixture(), candidate = terminalCandidateSchema.parse({ exitState: { objects: ['The packet remains sealed.'] } })
    if (field === 'billingKnown') f.fees[0].billingStatus = 'pending_settlement'
    if (field === 'providerComplete') {
      (f.rows[1].metadata.response as { transportComplete: boolean }).transportComplete = false
      f.rows[1].metadata.audit = inspectContinuityV4(f.raw, { manifest: f.input.continuityManifest!, bodies: f.bodies, sourceScope: f.sourceScope }, false).audit
    }
    if (field === 'recoveryReady') f.rows.push({ id: 'second-reservation', runId: f.subject.runId, artifactType: 'continuityReview', createdAt: new Date(3),
      metadata: { fullReassessmentKey: f.key } })
    await expect(prepareContinuityReviewLineage(f.tx, f.subject, { compilationId: f.base.targetId, chapterId: f.chapter.id,
      input: { ...f.input, terminalCandidate: candidate }, semanticSubjectHash: continuitySubjectIdentity({ ...f.input, terminalCandidate: candidate })!, modelPriceHash: f.plan.modelPriceHash }))
      .rejects.toMatchObject({ code: field === 'providerComplete' ? 'CONTINUITY_PHASE_AUTHORITY_REQUIRED' : 'CONTINUITY_REPORT_INCOMPLETE' })
    expect(f.rows.filter(row => row.metadata.continuityPhaseClaim)).toEqual([])
  })
  it('does not grant a body report the available automatic revision authority', async () => {
    const f = await fixture(); f.rows.length = 0; f.fees.length = 0; f.saved.validation = {}
    const plan = await prepareContinuityPhasePlan(f.tx, f.subject, { compilationId: f.base.targetId, chapterId: f.chapter.id,
      input: f.input, semanticSubjectHash: continuitySubjectIdentity(f.input)!, modelPriceHash: f.plan.modelPriceHash })
    expect(plan.revisionAuthority).toBeUndefined()
    expect(plan.phases.map(row => row.kind)).toEqual(['initial_review', 'sparse_repair'])
  })
  it('cannot buy a second body check after the original complete body receipt', async () => {
    const f = await fixture(), before = structuredClone({ rows: f.rows, fees: f.fees })
    await expect(prepareContinuityReviewLineage(f.tx, f.subject, { compilationId: f.base.targetId, chapterId: f.chapter.id,
      input: f.input, semanticSubjectHash: continuitySubjectIdentity(f.input)!, modelPriceHash: f.plan.modelPriceHash }))
      .rejects.toMatchObject({ code: 'CONTINUITY_PHASE_AUTHORITY_REQUIRED' })
    expect({ rows: f.rows, fees: f.fees }).toEqual(before)
  })
  it.each([{ adapter: 'legacy', outcome: 'repaired' }, { adapter: 'native', outcome: 'repaired' }, { adapter: 'legacy', outcome: 'unknown' }] as const)(
    'preserves the one original-cycle $adapter body verification with $outcome issues without spending terminal phases', async ({ adapter, outcome }) => {
    const f = await fixture(true), base = editBody(f), input = await bodyRecheck(f, base)
    const target = { compilationId: base.targetId, chapterId: base.chapterId, input }
    expect(input.continuityManifest.typedLineage!.priorFindings[0]).toMatchObject({ findingId: 'f0',
      text: 'The packet cannot stay sealed after it is opened.', origin: { revision: 4, bodyHash: f.context.current.contentHash } })
    expect(f.rows.filter(row => row.metadata.legacyContinuityVerification)).toEqual([])
    const ctx = { ...f.subject, callId: 'body-recheck' } as ToolContext, operationRef = adapter === 'native' ? 'body-parent' : legacyContinuityAssessmentKey(ctx, input)
    const reserve = (reference: string) => adapter === 'native'
      ? authenticateInitialContinuityHistory(f.tx, f.subject, target, reference)
      : claimLegacyContinuityVerification(f.tx, ctx, input, f.rows.filter(row => row.metadata.assessmentChapterId), reference)
    await reserve(operationRef)
    const claimed = f.rows.filter(row => row.metadata.legacyContinuityVerification)
    expect(claimed).toHaveLength(1)
    expect(claimed[0].metadata.legacyContinuityVerification).toMatchObject({ operationRef, inputHash: runtimeJson(input).hash,
      transition: { before: { revision: 4 }, after: { revision: 5 } } })
    await reserve(operationRef)
    expect(f.rows.filter(row => row.metadata.legacyContinuityVerification)).toHaveLength(1)
    await expect(reserve('different-call-cannot-reclaim')).rejects.toMatchObject({ code: 'CONTINUITY_PHASE_AUTHORITY_REQUIRED' })
    expect(f.rows.filter(row => row.metadata.continuityPhaseClaim)).toEqual([])
    expect(f.fees).toHaveLength(1)

    // Persist only this admitted physical recheck. Its whole raw, price-known
    // usage and explicit disposition let the first real candidate use r5.
    const raw = JSON.stringify({ findings: [], semanticChecks: ['action_direction', 'state_progression'].map(kind => ({ kind, result: 'clear',
      reasonCode: 'consistent', explanation: 'The saved manuscript now has one packet state.', findingIds: [] })),
    issueDispositions: [{ issueIndex: 0, outcome, reasonCode: outcome === 'repaired' ? 'consistent' : 'insufficient_evidence',
      explanation: outcome === 'repaired' ? 'The packet remains sealed in both saved statements.' : 'The reviewer cannot resolve the previous issue.',
      manuscriptEvidence: outcome === 'repaired' ? [{ segmentId: 'c0' }] : [] }] })
    const inspected = inspectContinuityV4(raw, { manifest: input.continuityManifest, bodies: input.bodies, sourceScope: input.sourceScope })
    expect(inspected.complete).toBe(true)
    const key = legacyContinuityAssessmentKey(ctx, input)
    f.fees.push({ ...f.fees[0], id: 'body-recheck-fee' })
    f.rows.push({ id: 'body-recheck-request', runId: f.subject.runId, artifactType: 'continuityReview', createdAt: new Date(5),
      metadata: { assessmentChapterId: f.chapter.id, continuityAssessmentRequestKey: key, input, callId: ctx.callId } },
    { id: 'body-recheck-response', runId: f.subject.runId, artifactType: 'continuityReview', createdAt: new Date(6),
      metadata: { assessmentKey: key, stage: 'first', callId: ctx.callId, input, usageIds: ['body-recheck-fee'], audit: inspected.audit,
        response: { content: JSON.stringify(raw), transportComplete: true, finishReason: 'stop', toolCalls: [] } } })
    f.saved.validation = { ...f.saved.validation, checkedRevision: 5, coverage: { contentHash: base.bodies.terminalEvidence.current.contentHash },
      findings: [], continuityCriticResponse: inspected.audit }
    f.saved.validation.effectiveReport = await stageEffectiveContinuityReport(f.tx, f.subject,
      { compilationId: base.targetId, audit: inspected.audit, previousValidation: {} })
    const candidate = terminalCandidateSchema.parse({ exitState: { objects: ['The packet remains sealed.'] } })
    const lineage = await prepareContinuityReviewLineage(f.tx, f.subject, { compilationId: base.targetId, chapterId: base.chapterId,
      input: { ...input, terminalCandidate: candidate }, semanticSubjectHash: continuitySubjectIdentity({ ...input, terminalCandidate: candidate })!, modelPriceHash: f.plan.modelPriceHash })
    expect(lineage.revisionReceiptHash).toBeUndefined()
    if (outcome === 'repaired') expect(lineage.establishedIssues).toEqual([])
    else expect(lineage.establishedIssues).toEqual(input.continuityManifest.typedLineage!.establishedIssues)
    expect(lineage.phasePlan.phases.map(row => row.kind)).toEqual(['initial_review', 'sparse_repair'])
    expect(f.rows.filter(row => row.metadata.legacyContinuityVerification)).toHaveLength(1)
    expect(f.rows.filter(row => row.metadata.continuityPhaseClaim)).toEqual([])
  })
  it('does not open the original-cycle body verification while the old price-known receipt is unresolved', async () => {
    const f = await fixture(true), base = editBody(f); f.fees[0].billingStatus = 'pending_settlement'
    await expect(bodyRecheck(f, base)).rejects.toMatchObject({ code: 'CONTINUITY_REPORT_INCOMPLETE' })
    expect(f.rows.filter(row => row.metadata.legacyContinuityVerification || row.metadata.continuityPhaseClaim)).toEqual([])
  })
  it('authenticates an applied body report without converting it into a terminal fact ledger', async () => {
    const f = await fixture(true)
    f.rows.push({ id: 'body-application', runId: f.subject.runId, artifactType: 'continuityReview', createdAt: new Date(4),
      metadata: { version: 1, assessmentApplicationKey: f.key, reservationId: 'body-request', usageIds: ['body-fee'] } })
    const before = structuredClone({ validation: f.saved.validation, rows: f.rows, fees: f.fees })
    await expect(reconstructContinuitySourceProvenance(f.tx, f.subject, { compilationId: f.base.targetId, chapterId: f.chapter.id, preparedContext: {} }))
      .rejects.toThrow('原持续事实与完整已应用报告的来源重建不一致')
    expect({ validation: f.saved.validation, rows: f.rows, fees: f.fees }).toEqual(before)
  })
  it('rejects a candidate attached to a body manifest instead of bypassing its phase', async () => {
    const f = await fixture()
    await expect(assertContinuityAssessmentSubject(f.tx, f.subject, { ...f.input, terminalCandidate: terminalCandidateSchema.parse({ exitState: {} }) }))
      .rejects.toMatchObject({ code: 'CONTINUITY_PHASE_AUTHORITY_REQUIRED' })
  })
})
