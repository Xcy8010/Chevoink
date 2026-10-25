import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

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
import { answerContinuitySupplementQuestion, assertContinuitySupplementTransport, authenticateContinuityPhasePlan,
  claimContinuityPhase, continuityModelPriceHash, continuitySupplementQuestionArgs, executeContinuitySupplementTool,
  canResumeUnsentContinuitySupplement,
  createContinuitySupplementUsage,
  persistContinuitySupplementQuestion, readContinuitySupplementState, reserveContinuitySupplementUsage,
  waitForContinuitySupplementAnswer } from '../../api/lib/agent/continuity-coordinator.js'
import type { buildContinuitySupplementQuestion } from '../../api/lib/agent/continuity-coordinator.js'
import { cancelAllQuestions, resolveQuestionAnswer } from '../../api/lib/agent/permissions.js'

type Question = Awaited<ReturnType<typeof buildContinuitySupplementQuestion>>
type Row = { id: string; runId: string; artifactType: string; metadata: Record<string, unknown>; content?: string }
const original = { taskId: 'original-task', sourceRunId: 'original-run', parentRunId: null, spec: { id: 'original-task' }, prompt: 'Review this chapter.' }

// The unit boundary models owned persisted rows; production question parsing,
// answer authentication, phase claims, transport guards and mailbox are real.
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
  const store = async () => persistContinuitySupplementQuestion(tx, subject, question)
  const answer = (text: string, extra = {}) => answerContinuitySupplementQuestion(tx, subject,
    { requestId: question.requestId, callId: question.callId, answer: text, ...extra })
  const rewrite = (change: (q: Question) => void) => {
    const next = structuredClone(question); change(next)
    const { requestHash: _hash, ...rest } = next; question = { ...rest, requestHash: runtimeJson(rest).hash }
    rows.get(question.requestId)!.metadata.continuitySupplementQuestion = question
  }
  const claim = (extra = {}, ownerSeq = subject.continuityOwnerSeq) => claimContinuityPhase(tx, { ...subject, continuityOwnerSeq: ownerSeq }, { plan, chapterId: input.chapterId, phase: 'full_reassessment',
    operationRef: frozen.originalAssessmentKey, inputHash: runtimeJson(input).hash, ownerEpoch: '7', ...extra })
  const transport = (extra = {}) => assertContinuitySupplementTransport(tx, { ...subject, requestId, chapterId: input.chapterId,
    targetId: input.targetId, system: input.system, content: input.content, model, price, inputTokenCeiling: frozen.inputTokenCeiling,
    maximumCreditMilli: frozen.maximumCreditMilli, maxOutputTokens: 16384, ...extra })
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
  const preparedData = (id: string): Prisma.AiUsageLogUncheckedCreateInput => ({ id, userId: subject.userId, novelId: subject.novelId,
    agentRunId: subject.runId, chapterId: input.chapterId, action: 'agent3ContinuityCritic', targetType: input.targetType,
    targetId: input.targetId, providerType: 'text', providerMode: 'custom', providerName: model.provider, modelTier: model.tier,
    modelName: model.modelName, multiplierBps: model.multiplierBps, billingSnapshot: price, usageSource: 'prepared',
    billingStatus: 'authorized_pending', requestTokens: null, responseTokens: null, durationMs: 0 })
  return { subject, tx, rows, run, owner, terminal, usage, artifacts, plan, frozen, providerAttempts: db.agentProviderAttempt,
    usageCreate: db.aiUsageLog.create, question: () => question, store, rewrite, answer, claim, transport, prepare, execution, preparedData }
}

beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw Error('Synthetic unit has no provider authority') })))
afterEach(() => { cancelAllQuestions('original-run'); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('supplemental continuity requires a genuine dedicated human answer', () => {
  it.each(['继续', 'Continue', 'Yes', 'Approve', 'arbitrary manuscript text'])('does not turn %s or an old Map answer into a grant', async text => {
    const f = fixture(); await f.store()
    expect(await answerContinuitySupplementQuestion(f.tx, f.subject, { callId: f.question().callId, answer: text })).toBeNull()
    await expect(f.answer(text)).rejects.toMatchObject({ code: 'CONTINUITY_PHASE_AUTHORITY_REQUIRED' })
    expect((await readContinuitySupplementState(f.tx, f.subject, f.frozen.originalAssessmentKey)).kind).toBe('no_authority')
    expect(f.rows.size).toBe(1); await expect(f.transport()).rejects.toBeDefined()
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each(['expired', 'wrong-call', 'new-owner', 'stopped', 'author-ended', 'cancelled-pause'] as const)('rejects a %s card without creating an answer', async scenario => {
    const f = fixture(); await f.store()
    if (scenario === 'expired') f.rewrite(q => { q.expiresAt = new Date(Date.now() - 1).toISOString() })
    if (scenario === 'new-owner') f.owner.seq++
    if (scenario === 'stopped') f.run.status = 'cancelled'
    if (scenario === 'author-ended') f.run.usage.authorEnded = true
    if (scenario === 'cancelled-pause') { f.run.status = 'paused'; f.terminal.payload.reason = 'user_stopped' }
    await expect(f.answer(f.question().accept, scenario === 'wrong-call' ? { callId: 'different-call' } : {})).rejects.toMatchObject({ code: 'CONTINUITY_PHASE_AUTHORITY_REQUIRED' })
    expect(f.rows.size).toBe(1)
    expect((await readContinuitySupplementState(f.tx, f.subject, f.frozen.originalAssessmentKey)).kind).toBe('no_authority')
  })
  it('keeps rejection immutable and a replay cannot replace it with acceptance', async () => {
    const f = fixture(); await f.store()
    expect(await f.answer(f.question().reject)).toMatchObject({ accepted: false, newAnswer: true })
    const before = structuredClone([...f.rows.values()])
    expect(await f.answer(f.question().accept)).toMatchObject({ accepted: false, newAnswer: false })
    expect([...f.rows.values()]).toEqual(before)
    expect((await readContinuitySupplementState(f.tx, f.subject, f.frozen.originalAssessmentKey)).kind).toBe('no_authority')
  })
  it('binds actor and every frozen field to the question hash', async () => {
    const f = fixture(); await f.store()
    expect(await answerContinuitySupplementQuestion(f.tx, { ...f.subject, userId: 'different-author' },
      { requestId: f.question().requestId, callId: f.question().callId, answer: f.question().accept })).toBeNull()
    const saved = f.rows.get(f.question().requestId)!.metadata.continuitySupplementQuestion as Question
    saved.frozen.maximumCreditMilli++
    expect(await f.answer(f.question().accept)).toBeNull()
    expect(f.rows.size).toBe(1)
  })
  it('persists exact approval once through the existing mailbox and does not wake it on replay after cancellation', async () => {
    const f = fixture(); await f.store()
    const args = await continuitySupplementQuestionArgs(f.tx, f.subject, f.question().requestId)
    const ctx = { ...f.subject, callId: f.question().callId, continuityQuestion: { requestId: args.requestId }, signal: new AbortController().signal } as ToolContext
    const pending = waitForContinuitySupplementAnswer(ctx, args)
    await vi.waitFor(() => expect(f.run.status).toBe('awaiting_approval'))
    expect(await f.answer(f.question().accept)).toMatchObject({ accepted: true, newAnswer: true })
    expect(resolveQuestionAnswer(f.subject.runId, ctx.callId, f.question().accept)).toBe(true)
    expect(await pending).toMatchObject({ summary: '已确认一次具体独立判断', display: { answer: f.question().accept } })
    expect(f.run.status).toBe('running')
    f.run.status = 'paused'; f.run.usage.authorEnded = true
    const before = structuredClone([...f.rows.values()])
    expect(await f.answer(f.question().accept)).toMatchObject({ accepted: true, newAnswer: false })
    expect(resolveQuestionAnswer(f.subject.runId, ctx.callId, f.question().accept)).toBe(false)
    expect(f.run.status).toBe('paused'); expect([...f.rows.values()]).toEqual(before)
  })
  it.each(['old-mailbox-only', 'unanswered'] as const)('does not infer consent from %s even when the card settles', async scenario => {
    const f = fixture(); await f.store()
    const args = await continuitySupplementQuestionArgs(f.tx, f.subject, f.question().requestId)
    const ctx = { ...f.subject, callId: f.question().callId, continuityQuestion: { requestId: args.requestId }, signal: new AbortController().signal } as ToolContext
    const pending = waitForContinuitySupplementAnswer(ctx, args)
    await vi.waitFor(() => expect(f.run.status).toBe('awaiting_approval'))
    if (scenario === 'old-mailbox-only') expect(resolveQuestionAnswer(f.subject.runId, ctx.callId, f.question().accept)).toBe(true)
    else cancelAllQuestions(f.subject.runId)
    expect(await pending).toMatchObject({ summary: '等待明确批准，未增加检查',
      display: scenario === 'unanswered' ? { unanswered: true } : { answer: f.question().accept } })
    expect((await readContinuitySupplementState(f.tx, f.subject, f.frozen.originalAssessmentKey)).kind).toBe('no_authority')
    await expect(f.claim()).rejects.toMatchObject({ code: 'CONTINUITY_PHASE_AUTHORITY_REQUIRED' })
    expect(f.rows.size).toBe(1)
  })
})

describe('one exact original supplemental phase crosses the paid transport boundary', () => {
  it.each(['model', 'price', 'cap', 'input-limit', 'body', 'target', 'output-limit'] as const)('rejects %s drift after the real grant and claim', async field => {
    const f = fixture(); await f.store(); await f.answer(f.question().accept); expect(await f.claim()).toBe(true)
    await expect(f.transport()).resolves.toMatchObject({ requestId: f.question().requestId })
    const drift = { model: { model: { ...f.frozen.model, modelName: 'replacement' } }, price: { price: { ...f.frozen.price, rateCardId: 'repriced' } },
      cap: { maximumCreditMilli: f.frozen.maximumCreditMilli + 1 }, 'input-limit': { inputTokenCeiling: f.frozen.inputTokenCeiling + 1 },
      body: { content: `${f.frozen.input.content} changed` }, target: { targetId: 'other-compilation' }, 'output-limit': { maxOutputTokens: 32768 } }[field]
    await expect(f.transport(drift)).rejects.toMatchObject({ code: 'CONTINUITY_PHASE_AUTHORITY_REQUIRED' })
  })
  it('authorizes only full reassessment; a new owner may reuse the grant but no prose, reverify or second physical usage', async () => {
    const f = fixture(); await f.store(); await f.answer(f.question().accept)
    for (const kind of ['prose_revision', 'reverify', 'sparse_repair'] as const) {
      const { hash: _hash, ...value } = f.plan, body = { ...value, phases: [{ kind, limit: 1, authoritySourceRef: `continuity-question:${f.question().requestId}` }] }
      expect(await authenticateContinuityPhasePlan(f.tx, f.subject, { ...body, hash: runtimeJson(body).hash })).toBe(false)
    }
    f.owner.seq = 8
    expect(await claimContinuityPhase(f.tx, { ...f.subject, continuityOwnerSeq: 8 }, { plan: f.plan, chapterId: f.frozen.input.chapterId,
      phase: 'full_reassessment', operationRef: f.frozen.originalAssessmentKey, inputHash: runtimeJson(f.frozen.input).hash, ownerEpoch: '8' })).toBe(true)
    expect(await f.claim({ ownerEpoch: '9' }).catch(() => 'old-owner-rejected')).toBe('old-owner-rejected')
    expect(await f.claim({}, 8)).toBe(false)
    const executionId = f.execution(8)
    f.prepare(); await reserveContinuitySupplementUsage(f.tx, f.subject.userId, 'new-usage', f.question().requestId, executionId)
    const before = structuredClone([...f.rows.values()])
    await reserveContinuitySupplementUsage(f.tx, f.subject.userId, 'new-usage', f.question().requestId, executionId)
    expect([...f.rows.values()]).toEqual(before)
    f.prepare('second-usage')
    await expect(reserveContinuitySupplementUsage(f.tx, f.subject.userId, 'second-usage', f.question().requestId, executionId)).rejects.toMatchObject({ code: 'CONTINUITY_PHASE_AUTHORITY_REQUIRED' })
    await expect(f.claim({ operationRef: 'changed-call-or-operation' }, 8)).rejects.toBeDefined()
  })
  it.each(['claim-only', 'dispatch-marker', 'usage-binding', 'orphan-prepared', 'native-unknown', 'expired', 'same-owner', 'current-execution'] as const)(
    'requires proven absence of every send window before a new owner resumes %s', async kind => {
    const f = fixture(); await f.store(); await f.answer(f.question().accept); await f.claim()
    const claims = structuredClone([...f.rows.values()].filter(row => row.metadata.continuityPhaseClaim))
    if (kind === 'dispatch-marker') {
      const id = runtimeJson({ kind: 'continuity_supplement_dispatch', originalFailedSubject: f.plan.supplementalSourceKey }).hash
      f.rows.set(id, { id, runId: f.subject.runId, artifactType: 'continuityReview', metadata: { version: 1,
        continuitySupplementDispatch: { requestId: f.question().requestId, requestHash: f.question().requestHash, callId: 'escaped-call',
          usageId: 'unknown-physical-usage', inputHash: runtimeJson(f.frozen.input).hash, at: new Date().toISOString() } } })
    }
    if (kind === 'usage-binding' || kind === 'orphan-prepared') {
      f.prepare()
      if (kind === 'usage-binding') await reserveContinuitySupplementUsage(f.tx, f.subject.userId, 'new-usage', f.question().requestId, f.execution(7))
    }
    if (kind === 'native-unknown') f.providerAttempts.count.mockResolvedValue(1)
    if (kind === 'expired') vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.question().expiresAt) + 1)
    f.owner.seq = kind === 'same-owner' ? 7 : 8
    if (kind === 'current-execution') f.execution(8)
    const resumed = { ...f.subject, continuityOwnerSeq: f.owner.seq }
    expect(await canResumeUnsentContinuitySupplement(f.tx, resumed, f.question())).toBe(kind === 'claim-only')
    expect((await readContinuitySupplementState(f.tx, resumed, f.frozen.originalAssessmentKey)).kind).toBe(kind === 'claim-only' ? 'authorized' : 'unknown')
    const writes = f.artifacts.create.mock.calls.length
    if (kind !== 'claim-only') for (const callId of ['duplicate-continue', 'worker-restart']) {
      const ctx = { ...resumed, callId, mode: 'build', signal: new AbortController().signal,
        continuitySupplement: { requestId: f.question().requestId, dispatchAllowed: true } } as ToolContext
      await expect(executeContinuitySupplementTool(ctx, { compilationId: f.frozen.input.targetId })).rejects.toMatchObject({ code: 'CONTINUITY_PHASE_AUTHORITY_REQUIRED' })
    }
    expect(f.artifacts.create).toHaveBeenCalledTimes(writes)
    expect([...f.rows.values()].filter(row => row.metadata.continuityPhaseClaim)).toEqual(claims)
    expect(f.usage.size).toBe(kind === 'usage-binding' || kind === 'orphan-prepared' ? 1 : 0)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('creates only the current execution usage atomically; late or duplicate preparation creates no orphan', async () => {
    const f = fixture(); await f.store(); await f.answer(f.question().accept); await f.claim()
    const oldExecution = f.execution(7, 'old-worker')
    f.owner.seq = 8
    const currentExecution = f.execution(8, 'current-worker')
    const input = { ...f.subject, requestId: f.question().requestId, executionId: oldExecution }
    await expect(createContinuitySupplementUsage(f.tx, input, f.preparedData('late-old-usage'))).rejects.toMatchObject({ code: 'CONTINUITY_PHASE_AUTHORITY_REQUIRED' })
    expect(f.usageCreate).not.toHaveBeenCalled(); expect(f.usage.size).toBe(0)
    await createContinuitySupplementUsage(f.tx, { ...input, executionId: currentExecution }, f.preparedData('only-usage'))
    const before = structuredClone([...f.rows.values()])
    await expect(createContinuitySupplementUsage(f.tx, { ...input, executionId: currentExecution }, f.preparedData('duplicate-usage'))).rejects.toMatchObject({ code: 'CONTINUITY_PHASE_AUTHORITY_REQUIRED' })
    expect(f.usageCreate).toHaveBeenCalledOnce(); expect([...f.usage.keys()]).toEqual(['only-usage'])
    expect([...f.rows.values()]).toEqual(before); expect(fetch).not.toHaveBeenCalled()
  })
})
