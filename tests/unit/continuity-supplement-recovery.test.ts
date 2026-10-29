import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'

const boundary = vi.hoisted(() => ({ db: {} as Record<string, unknown>, original: vi.fn(), runs: vi.fn() }))
vi.mock('../../api/lib/prisma.js', () => ({
  DataAccessError: class extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message) } },
  prisma: boundary.db,
}))
vi.mock('../../api/lib/agent/original-request.js', () => ({ readOriginalTaskRequest: boundary.original, originalTaskRunIds: boundary.runs }))

import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { continuitySubjectIdentity } from '../../api/lib/agent/continuity-subject-identity.js'
import { terminalCandidateSchema } from '../../api/lib/agent/terminal-candidate-contract.js'
import { buildContinuityReviewManifest } from '../../api/lib/agent/continuity-review-v4.js'
import { authenticateContinuityPhasePlan, readContinuityPhaseClaim, continuityModelPriceHash,
  continuitySupplementQuestionArgs, canResumeUnsentContinuitySupplement, readContinuitySupplementState } from '../../api/lib/agent/continuity-coordinator.js'
import * as coordinator from '../../api/lib/agent/continuity-coordinator.js'

type Question = Omit<NonNullable<Awaited<ReturnType<typeof readContinuitySupplementState>>['question']>, 'answerArtifactId'>
type Row = { id: string; runId: string; artifactType: string; metadata: Record<string, unknown>; content?: string }
const original = { taskId: 'original-task', sourceRunId: 'original-run', parentRunId: null, spec: { id: 'original-task' }, prompt: 'Review this chapter.' }

// Immutable historical rows are fixtures; only production read-only parsers run.
function fixture() {
  const subject = { userId: 'synthetic-author', novelId: 'synthetic-novel', runId: 'original-run', continuityOwnerSeq: 7 }
  const rows = new Map<string, Row>(), usage = new Map<string, Record<string, unknown>>()
  const run = { id: subject.runId, userId: subject.userId, novelId: subject.novelId, status: 'running', taskRootId: null,
    runtimeProtocolVersion: 0, usage: {} as Record<string, unknown> }
  const owner = { seq: 7 }, terminal = { type: 'run.paused', payload: { reason: 'needs_input' } }
  const owned = (where: Record<string, unknown>) => (!where.runId || where.runId === subject.runId)
    && (!where.run || (where.run as typeof subject).userId === subject.userId && (where.run as typeof subject).novelId === subject.novelId)
  const artifacts = {
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => owned(where) ? rows.get(String(where.id)) ?? null : null),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => owned(where) ? [...rows.values()].filter(row => {
      const q = row.metadata.continuitySupplementQuestion as Question | undefined
      return q?.frozen.originalAssessmentKey === (where.metadata as { equals: string }).equals
    }) : []),
    create: vi.fn(async ({ data }: { data: Row }) => { if (rows.has(data.id)) throw Error('unique artifact'); rows.set(data.id, structuredClone(data)); return data }),
  }
  const db = {
    $queryRaw: vi.fn(async () => []),
    agentArtifact: artifacts,
    agentRun: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.userId !== subject.userId || where.novelId !== subject.novelId || where.id !== subject.runId) return null
        if (typeof where.status === 'string' && where.status !== run.status) return null
        if (where.status && typeof where.status === 'object' && !(where.status as { in: string[] }).in.includes(run.status)) return null
        return run
      }),
      update: vi.fn(async ({ data }: { data: { status: string } }) => Object.assign(run, data)),
      updateMany: vi.fn(async ({ where, data }: { where: { status: string }; data: { status: string } }) => {
        if (where.status !== run.status) return { count: 0 }; Object.assign(run, data); return { count: 1 }
      }),
    },
    agentRunEvent: { findFirst: vi.fn(async ({ where }: { where: { type: unknown } }) => where.type === 'run.started' ? owner : terminal) },
    agentProviderAttempt: { count: vi.fn(async () => 0) },
    aiUsageLog: { count: vi.fn(async () => usage.size), create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const id = String(data.id); if (usage.has(id)) throw Error('unique usage'); usage.set(id, structuredClone(data)); return data
    }), findFirstOrThrow: vi.fn(async ({ where }: { where: { id: string; userId: string } }) => {
      const row = usage.get(where.id); if (!row || row.userId !== where.userId) throw Error('usage not owned'); return row
    }) },
  }
  Object.assign(boundary.db, db, { $transaction: async (work: (tx: typeof db) => unknown) => work(db) })
  boundary.original.mockResolvedValue(original)
  boundary.runs.mockResolvedValue([subject.runId])
  const tx = boundary.db as unknown as Prisma.TransactionClient
  const content = 'The sealed packet remains with the guard.'
  const candidate = terminalCandidateSchema.parse({ exitState: { objects: [content] } })
  const context = { protocol: 2 as const, verdictProtocol: 6 as const, spanAddressProtocol: 2 as const,
    current: { id: 'chapter', revision: 4, orderIndex: 1, contentHash: runtimeJson({ content }).hash }, previous: null,
    factCoverage: { version: 2 as const, taskId: original.taskId, chapterId: 'chapter', obligations: [] } }
  const base = { chapterId: 'chapter', revision: 4, targetType: 'story_compilation' as const, targetId: 'compilation',
    bodies: { previous: null, current: content, terminalEvidence: context }, terminalCandidate: candidate,
    sourceScope: { currentOrderIndex: 1, previous: [] } }
  const model = { tier: 'speed' as const, provider: 'fixture', modelName: 'fixture', multiplierBps: 15000,
    reasoningEffort: 'high' as const, baseUrl: 'https://provider.invalid/v1', contextWindowTokens: 128000 }
  const price = { version: 'credits-v2-itemized' as const, modelTier: 'speed' as const, multiplierBps: 11000, rateCardId: 'frozen-original',
    rates: { inputNano: 110000, cacheNano: 27500, outputNano: 1100000 } }
  const requestId = 'a'.repeat(64), family = 'b'.repeat(64)
  const planBody = { version: 1 as const, originalTaskId: original.taskId, originalAdmissionId: original.sourceRunId,
    chapterId: base.chapterId, compilationId: base.targetId, authorityHash: runtimeJson({ spec: original.spec, prompt: original.prompt }).hash,
    semanticSubjectHash: continuitySubjectIdentity(base)!, modelPriceHash: continuityModelPriceHash(model, price), budgetOwner: original.taskId,
    supplementalSourceKey: family, phases: [{ kind: 'full_reassessment' as const, limit: 1, authoritySourceRef: `continuity-question:${requestId}` }] }
  const plan = { ...planBody, hash: runtimeJson(planBody).hash }
  const manifest = buildContinuityReviewManifest({ subject: { userId: subject.userId, novelId: subject.novelId, taskId: original.taskId, targetType: base.targetType,
    targetId: base.targetId, chapterId: base.chapterId, revision: base.revision }, bodies: base.bodies, candidate, sourceScope: base.sourceScope,
    sourceHash: null, sourceVersions: { current: context.current }, verifiedCoverage: context.factCoverage, draftProposals: null,
    typedLineage: { version: 1, phasePlan: plan, priorFindings: [], establishedIssues: [] } })
  const input = { ...base, parserVersion: 10 as const, reassessmentProtocol: 7 as const, system: 'Frozen complete review.', content: 'Frozen full manuscript.', continuityManifest: manifest }
  const frozen: Question['frozen'] = { version: 1, originalTaskId: original.taskId, originalAssessmentKey: 'original-assessment',
    source: { runId: subject.runId, callId: 'old-call' }, oldInput: { ...base, system: input.system, content: input.content, parserVersion: 8, reassessmentProtocol: 5 },
    oldAuditHash: 'c'.repeat(64), rawHashes: ['d'.repeat(64), 'e'.repeat(64)], originalUsage: [{ id: 'old-fee', hash: 'f'.repeat(64) }],
    input, model, price, sourceRecoveryHash: '1'.repeat(64), validationHash: '2'.repeat(64), preparedHash: '3'.repeat(64), coverage: {}, focus: '',
    inputTokenCeiling: 10000, maximumCreditMilli: 20000, maxPhysicalRequests: 1, formatRepairRequests: 0 }
  const body = { version: 1 as const, requestId, callId: 'dedicated-question', ...subject, ownerSeq: subject.continuityOwnerSeq,
    expiresAt: new Date(Date.now() + 60000).toISOString(), question: 'Approve one complete review, at most 20 Credits?',
    accept: 'Approve this one review, at most 20 Credits', reject: 'Keep the draft and reports', frozen }
  // ToolContext-only owner fields never appear in the persisted envelope.
  const { continuityOwnerSeq: _owner, ...questionBody } = body
  let question: Question = { ...questionBody, requestHash: runtimeJson(questionBody).hash }
  // Fixed pre-refactor records. These helpers never call a production writer.
  const store = () => rows.set(question.requestId, { id: question.requestId, runId: subject.runId,
    artifactType: 'continuityReview', metadata: { version: 1, continuitySupplementQuestion: structuredClone(question) } })
  const answer = (text = question.accept, extra = {}) => {
    const id = runtimeJson({ kind: 'continuity_supplement_answer', requestId: question.requestId }).hash
    rows.set(id, { id, runId: subject.runId, artifactType: 'continuityReview', metadata: { version: 1,
      continuitySupplementAnswer: { requestId: question.requestId, requestHash: question.requestHash, userId: subject.userId,
        answer: text, decision: text === question.accept ? 'accept' : 'reject', answeredAt: new Date().toISOString(), ...extra } } })
  }
  const rewrite = (change: (q: Question) => void) => {
    const next = structuredClone(question); change(next)
    const { requestHash: _hash, ...rest } = next; question = { ...rest, requestHash: runtimeJson(rest).hash }
    rows.get(question.requestId)!.metadata.continuitySupplementQuestion = structuredClone(question)
  }
  const claim = (extra = {}) => {
    const id = runtimeJson({ kind: 'continuity_phase', taskId: plan.originalTaskId, chapterId: input.chapterId,
      phase: 'full_reassessment', ordinal: 0, originalFailedSubject: plan.supplementalSourceKey }).hash
    rows.set(id, { id, runId: subject.runId, artifactType: 'continuityReview', metadata: { version: 1, continuityPhaseClaim: {
      version: 1, planHash: plan.hash, originalTaskId: plan.originalTaskId, phase: 'full_reassessment', ordinal: 0,
      operationRef: frozen.originalAssessmentKey, exactInputHash: runtimeJson(input).hash, ownerEpoch: '7', ...extra } } })
    return id
  }
  const prepare = (id = 'new-usage') => usage.set(id, { id, ...subject, agentRunId: subject.runId, chapterId: input.chapterId,
    action: 'agent3ContinuityCritic', targetType: input.targetType, targetId: input.targetId, providerName: model.provider,
    modelTier: model.tier, modelName: model.modelName, multiplierBps: model.multiplierBps, billingSnapshot: price,
    usageSource: 'prepared', billingStatus: 'authorized_pending' })
  const execution = (ownerSeq = owner.seq, callId = 'physical-call') => {
    const id = runtimeJson({ kind: 'continuity_supplement_execution', originalFailedSubject: plan.supplementalSourceKey, ownerSeq }).hash
    rows.set(id, { id, runId: subject.runId, artifactType: 'continuityReview', metadata: { version: 1, continuitySupplementExecution: {
      requestId: question.requestId, requestHash: question.requestHash, inputHash: runtimeJson(frozen.input).hash, ownerSeq, callId } } })
    return id
  }
  const binding = () => {
    const id = runtimeJson({ kind: 'continuity_supplement_usage', originalFailedSubject: plan.supplementalSourceKey }).hash
    rows.set(id, { id, runId: subject.runId, artifactType: 'continuityReview', metadata: { version: 1,
      continuitySupplementUsage: { requestId: question.requestId, requestHash: question.requestHash, usageId: 'new-usage',
        executionId: execution(7), inputHash: runtimeJson(frozen.input).hash } } })
  }
  return { subject, tx, rows, run, owner, terminal, usage, artifacts, plan, frozen, providerAttempts: db.agentProviderAttempt,
    usageCreate: db.aiUsageLog.create, question: () => question, store, rewrite, answer, claim, prepare, execution, binding }
}

beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw Error('Synthetic history has no provider authority') })))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

function immutable(f: ReturnType<typeof fixture>) {
  const before = structuredClone({ rows: [...f.rows.values()], usage: [...f.usage.values()], run: f.run })
  return () => {
    expect({ rows: [...f.rows.values()], usage: [...f.usage.values()], run: f.run }).toEqual(before)
    expect(f.artifacts.create).not.toHaveBeenCalled(); expect(f.usageCreate).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  }
}

describe('frozen supplemental continuity consent is read-only history', () => {
  it.each(['继续', 'Continue', 'Yes', 'Approve', 'arbitrary manuscript text'])('does not turn %s into historical consent', async text => {
    const f = fixture(); f.store(); f.answer(text); const unchanged = immutable(f)
    expect((await readContinuitySupplementState(f.tx, f.subject, f.frozen.originalAssessmentKey)).kind).toBe('no_authority')
    expect(await authenticateContinuityPhasePlan(f.tx, f.subject, f.plan)).toBe(false); unchanged()
  })
  it.each(['expired', 'wrong-call', 'new-owner', 'stopped', 'author-ended', 'cancelled-pause'] as const)('cannot resume a %s historical card', async scenario => {
    const f = fixture(); f.store(); f.answer(); f.claim(); f.owner.seq = 8
    if (scenario === 'expired') vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.question().expiresAt) + 1)
    if (scenario === 'wrong-call') (f.rows.get(f.question().requestId)!.metadata.continuitySupplementQuestion as Question).callId = 'another-call'
    if (scenario === 'new-owner') f.owner.seq = 9
    if (scenario === 'stopped') f.run.status = 'cancelled'
    if (scenario === 'author-ended') f.run.usage.authorEnded = true
    if (scenario === 'cancelled-pause') { f.run.status = 'paused'; f.terminal.payload.reason = 'user_stopped' }
    const unchanged = immutable(f)
    expect(await canResumeUnsentContinuitySupplement(f.tx, { ...f.subject, continuityOwnerSeq: 8 }, f.question())).toBe(false)
    unchanged()
  })
  it('keeps an existing rejected answer immutable across repeated reads', async () => {
    const f = fixture(); f.store(); f.answer(f.question().reject); const unchanged = immutable(f)
    for (let attempt = 0; attempt < 2; attempt++)
      expect((await readContinuitySupplementState(f.tx, f.subject, f.frozen.originalAssessmentKey)).kind).toBe('no_authority')
    expect(coordinator).not.toHaveProperty('answerContinuitySupplementQuestion'); unchanged()
  })
  it('binds actor and every frozen field to the original question hash', async () => {
    const f = fixture(); f.store(); f.answer()
    expect((await readContinuitySupplementState(f.tx, { ...f.subject, userId: 'different-author' }, f.frozen.originalAssessmentKey)).kind).toBe('no_authority')
    const saved = f.rows.get(f.question().requestId)!.metadata.continuitySupplementQuestion as Question
    saved.frozen.maximumCreditMilli++; const unchanged = immutable(f)
    expect((await readContinuitySupplementState(f.tx, f.subject, f.frozen.originalAssessmentKey)).kind).toBe('no_authority'); unchanged()
  })
  it('reads the exact approved answer without waking or rewriting a cancelled run', async () => {
    const f = fixture(); f.store(); f.answer(); f.claim(); f.run.status = 'paused'; f.run.usage.authorEnded = true
    const unchanged = immutable(f), args = await continuitySupplementQuestionArgs(f.tx, f.subject, f.question().requestId)
    expect(args).toMatchObject({ requestId: f.question().requestId, options: [{ label: f.question().accept }, { label: f.question().reject }] })
    expect(await authenticateContinuityPhasePlan(f.tx, f.subject, f.plan)).toBe(true)
    expect(await canResumeUnsentContinuitySupplement(f.tx, { ...f.subject, continuityOwnerSeq: 8 }, f.question())).toBe(false)
    expect(coordinator).not.toHaveProperty('waitForContinuitySupplementAnswer'); unchanged()
  })
  it.each(['old-mailbox-only', 'unanswered'] as const)('does not infer a persisted answer from %s', async () => {
    const f = fixture(); f.store(); const unchanged = immutable(f)
    expect((await readContinuitySupplementState(f.tx, f.subject, f.frozen.originalAssessmentKey)).kind).toBe('no_authority')
    expect(await authenticateContinuityPhasePlan(f.tx, f.subject, f.plan)).toBe(false); unchanged()
  })
})

describe('historical supplemental transport identity never becomes a new paid slot', () => {
  it.each(['model', 'price', 'cap', 'input-limit', 'body', 'target', 'output-limit'] as const)('rejects %s drift in frozen historical consent', async field => {
    const f = fixture(); f.store(); f.answer()
    const saved = (f.rows.get(f.question().requestId)!.metadata.continuitySupplementQuestion as Question).frozen
    if (field === 'model') saved.model.modelName = 'replacement'
    if (field === 'price') saved.price = { ...saved.price, multiplierBps: saved.price.multiplierBps + 1 }
    if (field === 'cap') saved.maximumCreditMilli++
    if (field === 'input-limit') saved.inputTokenCeiling++
    if (field === 'body') saved.input.content += 'changed'
    if (field === 'target') saved.input.targetId = 'other-compilation'
    if (field === 'output-limit') Object.assign(saved, { maxOutputTokens: 32768 })
    const unchanged = immutable(f)
    expect(await authenticateContinuityPhasePlan(f.tx, f.subject, f.plan)).toBe(false)
    expect((await readContinuitySupplementState(f.tx, f.subject, f.frozen.originalAssessmentKey)).kind).toBe('no_authority'); unchanged()
  })
  it('reads only the exact claimed phase and never creates another claim, usage or execution', async () => {
    const f = fixture(); f.store(); f.answer(); f.claim(); const unchanged = immutable(f)
    expect(await readContinuityPhaseClaim(f.tx, f.subject, { plan: f.plan, chapterId: f.frozen.input.chapterId,
      phase: 'full_reassessment', operationRef: f.frozen.originalAssessmentKey, inputHash: runtimeJson(f.frozen.input).hash })).toBe(true)
    for (const kind of ['prose_revision', 'reverify', 'sparse_repair'] as const) {
      const { hash: _hash, ...value } = f.plan, body = { ...value, phases: [{ kind, limit: 1, authoritySourceRef: `continuity-question:${f.question().requestId}` }] }
      expect(await authenticateContinuityPhasePlan(f.tx, f.subject, { ...body, hash: runtimeJson(body).hash })).toBe(false)
    }
    expect(await readContinuityPhaseClaim(f.tx, f.subject, { plan: f.plan, chapterId: f.frozen.input.chapterId,
      phase: 'full_reassessment', operationRef: 'changed-operation', inputHash: runtimeJson(f.frozen.input).hash })).toBe(false)
    expect(coordinator).not.toHaveProperty('claimContinuityPhase'); unchanged()
  })
  it.each(['claim-only', 'dispatch-marker', 'usage-binding', 'orphan-prepared', 'native-unknown', 'expired', 'same-owner', 'current-execution'] as const)(
    'requires absence of every historical send window for %s', async kind => {
    const f = fixture(); f.store(); f.answer(); f.claim()
    if (kind === 'dispatch-marker') {
      const id = runtimeJson({ kind: 'continuity_supplement_dispatch', originalFailedSubject: f.plan.supplementalSourceKey }).hash
      f.rows.set(id, { id, runId: f.subject.runId, artifactType: 'continuityReview', metadata: { version: 1,
        continuitySupplementDispatch: { requestId: f.question().requestId, requestHash: f.question().requestHash, callId: 'escaped-call',
          usageId: 'unknown-physical-usage', inputHash: runtimeJson(f.frozen.input).hash, at: new Date().toISOString() } } })
    }
    if (kind === 'usage-binding' || kind === 'orphan-prepared') { f.prepare(); if (kind === 'usage-binding') f.binding() }
    if (kind === 'native-unknown') f.providerAttempts.count.mockResolvedValue(1)
    if (kind === 'expired') vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.question().expiresAt) + 1)
    f.owner.seq = kind === 'same-owner' ? 7 : 8
    if (kind === 'current-execution') f.execution(8)
    const resumed = { ...f.subject, continuityOwnerSeq: f.owner.seq }, unchanged = immutable(f)
    expect(await canResumeUnsentContinuitySupplement(f.tx, resumed, f.question())).toBe(kind === 'claim-only')
    expect((await readContinuitySupplementState(f.tx, resumed, f.frozen.originalAssessmentKey)).kind).toBe(kind === 'claim-only' ? 'authorized' : 'unknown')
    expect(coordinator).not.toHaveProperty('executeContinuitySupplementTool'); unchanged()
  })
  it('preserves existing usage while retired preparation exports cannot create late or duplicate orphans', async () => {
    const f = fixture(); f.store(); f.answer(); f.claim(); f.prepare('only-usage'); f.execution(7, 'old-worker'); f.execution(8, 'current-worker'); f.owner.seq = 8
    const unchanged = immutable(f)
    for (const name of ['createContinuitySupplementUsage', 'reserveContinuitySupplementUsage', 'assertContinuitySupplementTransport'])
      expect(coordinator).not.toHaveProperty(name)
    expect(await canResumeUnsentContinuitySupplement(f.tx, { ...f.subject, continuityOwnerSeq: 8 }, f.question())).toBe(false)
    expect([...f.usage.keys()]).toEqual(['only-usage']); unchanged()
  })
})

describe('historical target-specific waiver keeps only existing phase claims', () => {
  function oldClaim(seed = true) {
    const f = fixture(), chapterId = f.frozen.input.chapterId
    const admitted = { ...original, prompt: '改写第13章，第13章不用连续性检查。',
      spec: { id: original.taskId, intent: 'revise', qualityMode: 'premium',
        scope: { writing: { kind: 'bounded', targets: [{ chapterId, orderIndex: 13 }] } } } }
    boundary.original.mockResolvedValue(admitted)
    Object.assign(f.tx, { chapter: { findFirst: vi.fn(async ({ where }: { where: { id: string; authorId: string; novelId: string } }) =>
      where.id === chapterId && where.authorId === f.subject.userId && where.novelId === f.subject.novelId ? { id: chapterId, orderIndex: 13 } : null) } })
    const { hash: _old, supplementalSourceKey: _supplement, ...base } = f.plan
    const body = { ...base, authorityHash: runtimeJson({ spec: admitted.spec, prompt: admitted.prompt }).hash,
      phases: [{ kind: 'initial_review' as const, limit: 1, authoritySourceRef: 'original-admission:' + original.sourceRunId },
        { kind: 'sparse_repair' as const, limit: 1, authoritySourceRef: 'original-admission:' + original.sourceRunId }] }
    const plan = { ...body, hash: runtimeJson(body).hash }
    const id = runtimeJson({ kind: 'continuity_phase', taskId: original.taskId, chapterId, phase: 'initial_review', ordinal: 0 }).hash
    const claim = { version: 1, planHash: plan.hash, originalTaskId: original.taskId, phase: 'initial_review', ordinal: 0,
      operationRef: 'old-request', exactInputHash: 'a'.repeat(64), ownerEpoch: '7' }
    if (seed) f.rows.set(id, { id, runId: f.subject.runId, artifactType: 'continuityReview', metadata: { version: 1, continuityPhaseClaim: claim } })
    return { ...f, chapterId, plan, id, claim }
  }
  it.each(['pending_settlement', 'settled'] as const)('reads the exact old claim without changing %s usage or granting another phase', async billingStatus => {
    const f = oldClaim()
    f.prepare('old-usage'); f.usage.get('old-usage')!.billingStatus = billingStatus
    const before = structuredClone([...f.rows.values()]), fees = structuredClone([...f.usage.values()])
    expect(await authenticateContinuityPhasePlan(f.tx, f.subject, f.plan)).toBe(true)
    expect(await readContinuityPhaseClaim(f.tx, f.subject, { plan: f.plan, chapterId: f.chapterId, phase: 'initial_review',
      operationRef: f.claim.operationRef, inputHash: f.claim.exactInputHash })).toBe(true)
    expect(await readContinuityPhaseClaim(f.tx, f.subject, { plan: f.plan, chapterId: f.chapterId, phase: 'sparse_repair',
      operationRef: 'new-request', inputHash: 'b'.repeat(64) })).toBe(false)
    expect(coordinator).not.toHaveProperty('claimContinuityPhase')
    expect([...f.rows.values()]).toEqual(before); expect([...f.usage.values()]).toEqual(fees)
    expect(f.usageCreate).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
  })
  it('cannot treat an unclaimed old plan as a new paid allowance', async () => {
    const f = oldClaim(false)
    expect(await authenticateContinuityPhasePlan(f.tx, f.subject, f.plan)).toBe(false)
    expect(await readContinuityPhaseClaim(f.tx, f.subject, { plan: f.plan, chapterId: f.chapterId, phase: 'initial_review',
      operationRef: 'new', inputHash: 'a'.repeat(64) })).toBe(false)
    expect(f.rows.size).toBe(0); expect(f.usageCreate).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled()
  })
  it.each(['foreign-run', 'planHash', 'phase', 'ordinal'] as const)('rejects an invalid historical %s claim', async kind => {
    const f = oldClaim(), row = f.rows.get(f.id)!
    if (kind === 'foreign-run') row.runId = 'another-task'
    else (row.metadata.continuityPhaseClaim as Record<string, unknown>)[kind] =
      kind === 'planHash' ? '0'.repeat(64) : kind === 'phase' ? 'sparse_repair' : 1
    const before = structuredClone([...f.rows.values()])
    expect(await authenticateContinuityPhasePlan(f.tx, f.subject, f.plan)).toBe(false)
    expect([...f.rows.values()]).toEqual(before); expect(fetch).not.toHaveBeenCalled()
  })
})
