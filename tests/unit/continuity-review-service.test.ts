import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Prisma } from '@prisma/client'
import { prisma, DataAccessError } from '../../api/lib/prisma.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { buildQualityEvidenceSources, locateQualityFindingSpans } from '../../api/lib/agent/quality-evidence.js'
import { bindContinuityOpinions, inspectContinuityOpinions, correctContinuitySourceIds, continuityFormatRecoveryPreservesOpinions,
  buildContinuitySnapshot, continuityReviewRequest, continuityReportResponseSchema, readContinuityRequestBilling, reviewContinuity,
  type ContinuityOpinion, type ContinuityReport } from '../../api/lib/agent/continuity-review.js'
import * as original from '../../api/lib/agent/original-request.js'
import * as humanity from '../../api/lib/agent/humanity-quality.js'
import * as locks from '../../api/lib/data/novel-write-lock.js'
import * as manuscript from '../../api/lib/agent/manuscript-scope.js'
import * as guard from '../../api/lib/agent/chapter-review-guard.js'
import * as mutation from '../../api/lib/agent/tools/chapter-mutation.js'
import * as internal from '../../api/lib/data/internal.js'
import * as flags from '../../api/lib/agent2-feature-flags.js'
import * as reviewCompletion from '../../api/lib/agent/review-completion.js'
import * as auxiliaryRuntime from '../../api/lib/agent/runtime-auxiliary-call.js'
import * as ai from '../../api/lib/ai-service.js'
import { beginTextRequest } from '../../api/lib/text-request-trace.js'
import type { ToolContext } from '../../api/lib/agent/tools/types.js'

const body = '账本写着三十四万元的一成是三千四百元。她把账本放回桌上。'
const identity = { userId: 'u', novelId: 'n', chapterId: 'c', chapterRevision: 4 }
const table = () => buildQualityEvidenceSources(identity, body)
const opinion = (id = table().entries[0].id.slice(0, 13)): ContinuityOpinion => ({ signal: 'object', severity: 'error',
  explanation: '同一句中的总额和十分之一相差一个数量级。', suggestion: '把十分之一修正为三万四千元。', evidence: [{ sourceId: id }] })
const source = () => ({ source: 'current' as const, content: body, table: table() })
afterEach(() => vi.restoreAllMocks())

describe('one ordinary continuity report', () => {
  it('binds one real fragment to a single-sentence arithmetic issue without inventing another quote', () => {
    const bound = bindContinuityOpinions([opinion()], [source()])
    expect(bound.unlocatedIndexes).toEqual([])
    expect(bound.findings).toHaveLength(1)
    expect(bound.findings[0]).toMatchObject({ severity: 'error', explanation: opinion().explanation, startOffset: 0,
      evidence: table().entries[0].text, references: [{ sourceId: table().entries[0].id, chapterId: 'c', revision: 4, quote: table().entries[0].text }] })
    expect(locateQualityFindingSpans(body, { sourceId: table().entries[0].id.slice(0, 13) }, table())).toEqual([{ start: table().entries[0].start, end: table().entries[0].end }])
  })
  it.each(['“她说："照原数记。"”', '她说：“照原数记。”', '她说："照原数记。"'])('uses source IDs rather than asking the model to recopy nested punctuation: %s', content => {
    const sources = buildQualityEvidenceSources(identity, content)
    const bound = bindContinuityOpinions([opinion(sources.entries[0].id.slice(0, 13))], [{ source: 'current', content, table: sources }])
    expect(bound.findings[0].evidence).toBe(content)
    expect(bound.unlocatedIndexes).toEqual([])
  })
  it('exposes only actual visible source IDs in the critic request and accepts no free manuscript quote field', () => {
    const request = continuityReviewRequest({ chapter: { id: 'c' }, original: { prompt: '检查本章' }, sources: [{ ...source(), chapterId: 'c', revision: 4, orderIndex: 1 }] } as Parameters<typeof continuityReviewRequest>[0])
    expect(request.content).toContain(table().entries[0].id.slice(0, 13))
    expect(request.content).not.toContain(table().entries[0].id)
    expect(continuityReportResponseSchema.safeParse({ findings: [opinion()] }).success).toBe(true)
    expect(continuityReportResponseSchema.safeParse({ findings: [{ ...opinion(), evidence: [{ sourceId: 'q123', quote: body }] }] }).success).toBe(false)
    expect(request.system).not.toContain('terminalCandidate')
  })
  it('does not bind a foreign chapter or revision source ID', () => {
    for (const changed of [{ ...identity, chapterId: 'foreign' }, { ...identity, chapterRevision: 5 }]) {
      const foreign = buildQualityEvidenceSources(changed, body)
      const bound = bindContinuityOpinions([opinion(foreign.entries[0].id.slice(0, 13))], [source()])
      expect(bound.findings).toEqual([]); expect(bound.unlocatedIndexes).toEqual([0])
    }
  })
  it('keeps all seven source-unlocated opinions and changes only their actual references', () => {
    const opinions = Array.from({ length: 7 }, (_, index) => ({ ...opinion('missing-' + index), explanation: '原意见' + index }))
    const parsed = inspectContinuityOpinions(JSON.stringify({ findings: opinions }))
    expect(parsed).toMatchObject({ structured: true, opinions })
    const repaired = correctContinuitySourceIds(parsed.opinions, [0, 1, 2, 3, 4, 5, 6], JSON.stringify({ corrections: opinions.map((_, index) => ({ index, evidence: opinion().evidence })) }))
    expect(repaired.map(({ evidence: _evidence, ...row }) => row)).toEqual(opinions.map(({ evidence: _evidence, ...row }) => row))
    expect(bindContinuityOpinions(repaired, [source()])).toMatchObject({ unlocatedIndexes: [], findings: { length: 7 } })
    expect(correctContinuitySourceIds(opinions, [0], '{"corrections":[]}')).toEqual(opinions)
    expect(correctContinuitySourceIds(opinions, [0], JSON.stringify({ corrections: [{ index: 0, evidence: opinion().evidence }, { index: 0, evidence: opinion('other').evidence }] }))).toEqual(opinions)
  })
  it('retains a recognizable opinion with missing source data and rejects a format recovery that deletes or downgrades it', () => {
    const original = { ...opinion(), evidence: undefined }
    expect(inspectContinuityOpinions(JSON.stringify({ findings: [original] })).opinions).toEqual([{ ...original, evidence: [] }])
    const before = inspectContinuityOpinions(JSON.stringify({ findings: [opinion(), { broken: true }] }))
    expect(continuityFormatRecoveryPreservesOpinions(before, inspectContinuityOpinions('{"findings":[]}'))).toBe(false)
    expect(continuityFormatRecoveryPreservesOpinions(before, inspectContinuityOpinions(JSON.stringify({ findings: [{ ...opinion(), severity: 'warning' }, opinion()] })))).toBe(false)
    expect(continuityFormatRecoveryPreservesOpinions(before, inspectContinuityOpinions(JSON.stringify({ findings: [opinion(), opinion()] })))).toBe(true)
  })
})

function nativeFee(status: 'succeeded' | 'failed' | 'unknown' | 'cancelled' = 'succeeded', httpStatus = 502) {
  const requestSnapshot = { provider: 'fixture', model: 'fixture', request: { endpoint: 'https://provider.invalid/v1/chat/completions', body: {} } }
  const measurement = { source: 'reported', promptTokens: 10, completionTokens: 3, cacheHitTokens: null, cacheMissTokens: null }
  const result = status === 'succeeded' ? { outcome: 'succeeded', result: { content: '{}', reasoning: '', finishReason: 'stop', toolCalls: [], usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13, promptCacheHitTokens: null, promptCacheMissTokens: null } } }
    : status === 'cancelled' ? { outcome: 'cancelled', result: { code: 'RUNTIME_PARENT_LEASE_LOST', dispatched: false } }
      : status === 'failed' ? { outcome: 'failed', result: { httpStatus } } : { outcome: 'unknown', result: { reason: 'transport_error' } }
  const receipt = { attemptId: 'attempt', revision: 1, ...measurement, observationHash: runtimeJson(measurement).hash, settlementStatus: 'settled' }
  const inputSnapshot = { kind: 'provider', action: 'continuity_critic', input: { request: requestSnapshot.request } }
  const attempt = { id: 'attempt', requestSnapshot, requestHash: runtimeJson(requestSnapshot).hash, result, resultHash: runtimeJson(result).hash, status,
    dispatchedAt: status === 'cancelled' ? null : new Date(), usageReceipt: status === 'unknown' || status === 'cancelled' ? null : receipt }
  const events = status === 'cancelled' ? [{ eventKey: 'provider.not_dispatched:attempt', type: 'provider.not_dispatched', payload: { attemptId: 'attempt', requestHash: attempt.requestHash,
    code: 'RUNTIME_PARENT_LEASE_LOST', resultHash: attempt.resultHash } }] : [{ eventKey: `result:attempt:${attempt.resultHash}`, type: 'provider.result.recorded', payload: {
    attemptId: 'attempt', status, resultHash: attempt.resultHash } }, { eventKey: 'settlement:op', type: 'credit.settled', payload: {} }]
  return { id: 'op', status, inputSnapshot, inputHash: runtimeJson(inputSnapshot).hash, attempts: [attempt], events }
}

describe('continuity accounting stays native when legacy usage is empty', () => {
  function db(operation: ReturnType<typeof nativeFee>, charge: unknown = { id: 'ledger' }) {
    return { aiUsageLog: { findMany: vi.fn().mockResolvedValue([]) }, agentOperation: { findMany: vi.fn().mockResolvedValue([operation]) },
      agentArtifact: { findMany: vi.fn().mockResolvedValue([]) }, creditLedgerEntry: { findUnique: vi.fn().mockResolvedValue(charge) } } as unknown as Prisma.TransactionClient
  }
  it.each(['succeeded', 'failed'] as const)('recognizes a fully settled %s receipt without new settlement', async status => {
    const value = await readContinuityRequestBilling(db(nativeFee(status)), { userId: 'u', novelId: 'n' }, { runIds: ['r'], chapter: { id: 'c' } })
    expect(value).toEqual({ known: true, hasRequest: true, usageIds: [], nativeReceiptIds: ['attempt'] })
  })
  it('does not infer zero charge from no AiUsageLog when native transport remains unknown', async () => {
    expect(await readContinuityRequestBilling(db(nativeFee('unknown'), null), { userId: 'u', novelId: 'n' }, { runIds: ['r'], chapter: { id: 'c' } })).toMatchObject({ known: false, hasRequest: true })
  })
  it.each(['operation-only', 'prepared-attempt'] as const)('recognizes actual unsent native %s without inventing settlement', async kind => {
    const op = nativeFee('unknown') as unknown as { status: string; attempts: Array<Record<string, unknown>>; events: unknown[] }
    op.status = 'prepared'; op.events = []
    if (kind === 'operation-only') op.attempts = []
    else Object.assign(op.attempts[0], { status: 'prepared', dispatchedAt: null, result: null, resultHash: null, usageReceipt: null })
    const store = db(op as unknown as ReturnType<typeof nativeFee>, null)
    expect(await readContinuityRequestBilling(store, { userId: 'u', novelId: 'n' }, { runIds: ['r'], chapter: { id: 'c' } }))
      .toEqual({ known: true, hasRequest: true, usageIds: [], nativeReceiptIds: [] })
    expect(store.creditLedgerEntry.findUnique).toHaveBeenCalledWith({ where: { idempotencyKey: 'operation:op' } })
    if (kind === 'prepared-attempt') {
      op.attempts[0].dispatchedAt = new Date()
      expect(await readContinuityRequestBilling(store, { userId: 'u', novelId: 'n' }, { runIds: ['r'], chapter: { id: 'c' } })).toMatchObject({ known: false })
    }
  })
  it('recognizes the actual not-dispatched receipt while preserving a pending usage contradiction', async () => {
    const op = nativeFee('cancelled')
    expect(await readContinuityRequestBilling(db(op, null), { userId: 'u', novelId: 'n' }, { runIds: ['r'], chapter: { id: 'c' } })).toMatchObject({ known: true })
    op.attempts[0].usageReceipt = nativeFee().attempts[0].usageReceipt
    expect(await readContinuityRequestBilling(db(op, null), { userId: 'u', novelId: 'n' }, { runIds: ['r'], chapter: { id: 'c' } })).toMatchObject({ known: false })
  })
  it('accepts a producer-confirmed HTTP rejection but does not treat quota/partial accounting as zero', async () => {
    const rejected = nativeFee('failed', 401); rejected.attempts[0].usageReceipt = null
    expect(await readContinuityRequestBilling(db(rejected, null), { userId: 'u', novelId: 'n' }, { runIds: ['r'], chapter: { id: 'c' } })).toMatchObject({ known: true })
    const quota = nativeFee('failed', 429); quota.attempts[0].usageReceipt!.settlementStatus = 'pending'
    expect(await readContinuityRequestBilling(db(quota, null), { userId: 'u', novelId: 'n' }, { runIds: ['r'], chapter: { id: 'c' } })).toMatchObject({ known: false })
  })
  it.each(['usage', 'result', 'ledger'] as const)('rejects an unmatched native %s receipt', async changed => {
    const op = nativeFee()
    if (changed === 'usage') op.attempts[0].usageReceipt!.observationHash = '0'.repeat(64)
    if (changed === 'result') op.attempts[0].resultHash = '0'.repeat(64)
    expect(await readContinuityRequestBilling(db(op, changed === 'ledger' ? null : { id: 'ledger' }), { userId: 'u', novelId: 'n' }, { runIds: ['r'], chapter: { id: 'c' } })).toMatchObject({ known: false })
  })
})

function runnerFixture() {
  const chapter = { id: 'c', authorId: 'u', novelId: 'n', title: '合成章', revision: 4, content: body, orderIndex: 1 }
  const compilation = { id: 'comp', userId: 'u', novelId: 'n', runId: 'r', chapterId: 'c', status: 'active', validation: {} as Record<string, unknown> }
  const artifacts = new Map<string, Record<string, unknown>>()
  const fees: Array<Record<string, unknown>> = [], operations: Array<ReturnType<typeof nativeFee>> = []
  vi.spyOn(original, 'readOriginalTaskRequest').mockResolvedValue({ taskId: 'task', prompt: '检查并修复本章', spec: null, sourceRunId: 'r', parentRunId: null })
  vi.spyOn(original, 'originalTaskRunIds').mockResolvedValue(['r'])
  vi.spyOn(humanity, 'resolveQualityChapterTarget').mockResolvedValue('c')
  vi.spyOn(humanity, 'qualityCompilationScope').mockResolvedValue({ runId: 'r' })
  vi.spyOn(locks, 'lockNovelActiveScope').mockResolvedValue(undefined)
  vi.spyOn(manuscript, 'assertAgentManuscriptCurrent').mockResolvedValue(undefined)
  vi.spyOn(prisma.chapter, 'findFirst').mockImplementation(async args => args?.where?.id === 'c' && args.where.authorId === 'u' ? { ...chapter } as never : null)
  vi.spyOn(prisma.chapter, 'findMany').mockResolvedValue([])
  vi.spyOn(prisma.storyCompilation, 'findFirst').mockImplementation(async args => args?.where?.userId === 'u' && args.where.novelId === 'n' ? { ...compilation } as never : null)
  vi.spyOn(prisma.storyCompilation, 'findUniqueOrThrow').mockImplementation(async () => ({ ...compilation } as never))
  vi.spyOn(prisma.storyCompilation, 'update').mockImplementation(async ({ data }) => { Object.assign(compilation, data); return { ...compilation } as never })
  vi.spyOn(prisma.agentArtifact, 'findUnique').mockImplementation(async ({ where }) => artifacts.get(where.id!) as never ?? null)
  vi.spyOn(prisma.agentArtifact, 'findMany').mockResolvedValue([])
  vi.spyOn(prisma.agentArtifact, 'create').mockImplementation(async ({ data }) => { const row = { ...data, updatedAt: new Date() }; artifacts.set(data.id!, row); return row as never })
  vi.spyOn(prisma.agentArtifact, 'update').mockImplementation(async ({ where, data }) => { const row = { ...artifacts.get(where.id!), ...data, updatedAt: new Date() }; artifacts.set(where.id!, row); return row as never })
  vi.spyOn(prisma.aiUsageLog, 'findMany').mockImplementation(async () => fees as never)
  vi.spyOn(prisma.agentOperation, 'findMany').mockImplementation(async () => operations as never)
  const sessionRead = vi.spyOn(prisma.agentSession, 'findUnique').mockResolvedValue({ sandboxMode: 'workspace', toolPolicy: { contentWrite: 'allow' } } as never)
  vi.spyOn(prisma.agentRunEvent, 'findFirst').mockResolvedValue(null)
  vi.spyOn(prisma.creditLedgerEntry, 'findUnique').mockResolvedValue(null)
  vi.spyOn(prisma, '$transaction').mockImplementation(async work => typeof work === 'function' ? work(prisma) : Promise.all(work) as never)
  const controller = new AbortController()
  const ctx: ToolContext = { userId: 'u', novelId: 'n', runId: 'r', sessionId: 's', chapterId: 'c', callId: 'call1', mode: 'build',
    creativeFreedom: 'stable', qualityMode: 'premium', signal: controller.signal, emit: () => {} }
  const requests: string[] = []
  const dispatch = (answer: (action: string) => string | Promise<string>) => async ({ action }: { action: string }) => {
    requests.push(action)
    const fee = { id: 'fee' + requests.length, usageSource: 'reported', billingStatus: 'settled', requestTokens: 10, responseTokens: 3, reservedCreditMilli: 0 }
    fees.push(fee)
    return { content: await answer(action), usageIds: [fee.id], billingKnown: true }
  }
  const report = () => (Array.from(artifacts.values()).at(-1)!.metadata as { continuityReport: ContinuityReport }).continuityReport
  return { chapter, compilation, artifacts, fees, operations, ctx, controller, requests, dispatch, report, sessionRead }
}

describe('known failure recovery preserves report and paid evidence', () => {
  it('runs the real legacy adapter with the admitted model and current evidence packet', async () => {
    const f = runnerFixture()
    f.ctx.modelRuntime = { tier: 'speed', multiplierBps: 10000, provider: 'fixture', modelName: 'fixture',
      baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture-only', reasoningEffort: 'high', reasoningEfforts: ['high'],
      reasoningParameterMode: 'native', thinkingEnabled: true, visionEnabled: false, contextWindowTokens: 128000 }
    const generate = vi.spyOn(ai, 'generateTextCompletion').mockImplementation(async (_system, content, options) => {
      await options.beforeProviderDispatch?.()
      expect(options).toMatchObject({ explicitModelSelection: true, userId: 'u', agentRunId: 'r', action: 'agent3ContinuityCritic',
        modelRuntime: { tier: 'speed', provider: 'fixture', modelName: 'fixture', reasoningEffort: 'high', thinkingEnabled: true } })
      const request = JSON.parse(content)
      expect(request).toMatchObject({ authorRequest: '检查并修复本章', currentChapter: 'c',
        sources: [{ chapterId: 'c', revision: 4, orderIndex: 1, source: 'current', content: body }] })
      for (const entry of table().entries) expect(request.sources[0].evidence).toContain(entry.id.slice(0, 13))
      f.fees.push({ id: 'legacy-fee', usageSource: 'reported', billingStatus: 'settled', requestTokens: 12, responseTokens: 8, reservedCreditMilli: 0 })
      const trace = beginTextRequest('legacy-fee').record; trace.status = 'terminal'; trace.billingKnown = true
      return '{"findings":[]}'
    })
    const result = await reviewContinuity(f.ctx, { compilationId: 'comp' }, { allowRepair: false })
    expect(result).toMatchObject({ reviewCompleted: true, summary: '连续性检查完成 · 0 错误 0 警告' })
    expect(generate).toHaveBeenCalledOnce()
    expect(f.report()).toMatchObject({ complete: true, billingKnown: true, rawResponses: ['{"findings":[]}'], usageIds: ['legacy-fee'] })
    expect(f.chapter.revision).toBe(4); expect(f.chapter.content).toBe(body)
  })
  it('resumes the same admitted native call interrupted before its first provider registration', async () => {
    const f = runnerFixture(), snapshot = await buildContinuitySnapshot(f.ctx, { compilationId: 'comp' })
    f.ctx.continuityNativeLease = { runId: 'r', userId: 'u' } as NonNullable<ToolContext['continuityNativeLease']>
    const id = runtimeJson({ kind: 'continuity-report', taskId: snapshot.original.taskId, chapterId: snapshot.chapter.id, contextHash: snapshot.contextHash }).hash
    f.artifacts.set(id, { id, runId: 'r', updatedAt: new Date(), metadata: { contextHash: snapshot.contextHash, callId: f.ctx.callId, nativeOperationId: 'original-operation', requestClosed: false } })
    const dispatch = f.dispatch(() => '{"findings":[]}')
    await expect(reviewContinuity({ ...f.ctx, callId: 'another-call' }, { compilationId: 'comp' }, { dispatch, resumeKnownRequest: 'original-operation' }))
      .rejects.toMatchObject({ code: 'AI_PROVIDER_BILLING_UNCONFIRMED' })
    expect(f.requests).toEqual([])
    await expect(reviewContinuity(f.ctx, { compilationId: 'comp' }, { dispatch, resumeKnownRequest: 'another-operation' }))
      .rejects.toMatchObject({ code: 'AI_PROVIDER_BILLING_UNCONFIRMED' })
    expect(f.requests).toEqual([])
    await expect(reviewContinuity(f.ctx, { compilationId: 'comp' }, { dispatch, resumeKnownRequest: 'original-operation' }))
      .resolves.toMatchObject({ reviewCompleted: true })
    expect(f.requests).toEqual(['agent3ContinuityCritic']); expect(f.fees).toHaveLength(1)
  })
  it.each(['before-child', 'settled-child'] as const)('recovers the original native repair interrupted at %s', async window => {
    const f = runnerFixture()
    f.ctx.continuityNativeLease = { runId: 'r', userId: 'u' } as NonNullable<ToolContext['continuityNativeLease']>
    await reviewContinuity(f.ctx, { compilationId: 'comp' }, { resumeKnownRequest: 'original-operation', allowRepair: false, dispatch: f.dispatch(() => JSON.stringify({ findings: [opinion()] })) })
    f.report().repairAttempted = true
    f.ctx.creativeFreedom = 'balanced'
    vi.spyOn(guard, 'readChapterReviewReadiness').mockResolvedValue(null)
    vi.spyOn(guard, 'probeChapterReviewRevision').mockResolvedValue({ open: true })
    vi.spyOn(humanity, 'buildHumanityQualityContext').mockResolvedValue({ chapter: { ...f.chapter, novel: {} }, profiles: [], anchors: [], recentChapters: [], chapterWritingBackground: [], originalRequest: '检查并修复本章' } as never)
    const write = vi.spyOn(mutation, 'updateOwnedChapterAtRevision').mockImplementation(async (_ctx, _expected, data) => {
      Object.assign(f.chapter, data, { revision: 5 }); return { ...f.chapter } as never
    })
    vi.spyOn(internal, 'recalculateNovelStats').mockResolvedValue(undefined)
    vi.spyOn(flags, 'isAgent2FeatureEnabled').mockReturnValue(false)
    const raw = JSON.stringify({ patches: [{ findingId: '0', replacement: table().entries[0].text.replace('三千四百元', '三万四千元') }] })
    const physical = { id: 'original-repair-fee', usageSource: 'reported', billingStatus: 'settled', requestTokens: 10, responseTokens: 3, reservedCreditMilli: 0 }
    if (window === 'settled-child') f.fees.push(physical)
    const dispatch = vi.fn(async ({ action }: { action: string }) => {
      expect(action).toBe('agent3ContinuityRevision')
      if (window === 'before-child') f.fees.push(physical)
      return { content: raw, usageIds: [physical.id], billingKnown: true }
    })
    const result = await reviewContinuity(f.ctx, { compilationId: 'comp' }, { resumeKnownRequest: 'original-operation', dispatch })
    expect(result).toMatchObject({ reviewCompleted: false, reviewOutcome: 'stale', display: { kind: 'chapterDiff', revision: 5 } })
    expect(dispatch).toHaveBeenCalledOnce(); expect(write).toHaveBeenCalledOnce()
    expect(f.fees).toHaveLength(2); expect(f.fees.filter(fee => fee.id === physical.id)).toEqual([physical])
    expect(f.report().rawResponses).toEqual([JSON.stringify({ findings: [opinion()] }), raw])
  })
  it.each(['read_only', 'content-denied', 'inline-child'] as const)('saves a report without purchasing repair in the current %s session', async policy => {
    const f = runnerFixture(); f.ctx.creativeFreedom = 'balanced'
    if (policy === 'inline-child') f.ctx.inlineChild = true
    f.sessionRead.mockResolvedValue({ sandboxMode: policy === 'read_only' ? 'read_only' : 'workspace',
      toolPolicy: { contentWrite: policy === 'content-denied' ? 'deny' : 'allow' } } as never)
    const result = await reviewContinuity(f.ctx, { compilationId: 'comp' }, { dispatch: f.dispatch(() => JSON.stringify({ findings: [opinion()] })) })
    expect(result).toMatchObject({ reviewCompleted: true, reviewOutcome: 'decision_required' }); expect(result.outcome).not.toBe('failed')
    expect(f.requests).toEqual(['agent3ContinuityCritic']); expect(f.chapter.revision).toBe(4)
  })
  it('retains the repair response and fee when the author makes the session read-only before CAS', async () => {
    const f = runnerFixture(); f.ctx.creativeFreedom = 'balanced'
    vi.spyOn(guard, 'readChapterReviewReadiness').mockResolvedValue(null)
    vi.spyOn(guard, 'probeChapterReviewRevision').mockResolvedValue({ open: true })
    vi.spyOn(humanity, 'buildHumanityQualityContext').mockResolvedValue({ chapter: { ...f.chapter, novel: {} }, profiles: [], anchors: [], recentChapters: [], chapterWritingBackground: [], originalRequest: '检查并修复本章' } as never)
    const write = vi.spyOn(mutation, 'updateOwnedChapterAtRevision')
    const raw = JSON.stringify({ patches: [{ findingId: '0', replacement: table().entries[0].text.replace('三千四百元', '三万四千元') }] })
    const result = await reviewContinuity(f.ctx, { compilationId: 'comp' }, { dispatch: f.dispatch(action => {
      if (action !== 'agent3ContinuityRevision') return JSON.stringify({ findings: [opinion()] })
      f.sessionRead.mockResolvedValue({ sandboxMode: 'read_only', toolPolicy: {} } as never)
      return raw
    }) })
    expect(result).toMatchObject({ outcome: 'failed', failureCode: 'REPAIR_NOT_AUTHORIZED', reviewCompleted: true })
    expect(write).not.toHaveBeenCalled(); expect(f.chapter.revision).toBe(4)
    expect(f.fees).toHaveLength(2); expect(f.report().rawResponses.at(-1)).toBe(raw)
  })
  it('recovers a known malformed report on the same manuscript without buying another blind critic', async () => {
    const f = runnerFixture()
    expect(await reviewContinuity(f.ctx, { compilationId: 'comp' }, { allowRepair: false, dispatch: f.dispatch(() => '{broken') })).toMatchObject({ outcome: 'failed' })
    expect(f.requests).toEqual(['agent3ContinuityCritic', 'agent3ContinuityFormatRecovery'])
    expect(await reviewContinuity({ ...f.ctx, callId: 'call2' }, { compilationId: 'comp' }, { allowRepair: false, dispatch: f.dispatch(() => '{"findings":[]}') })).toMatchObject({ reviewCompleted: true })
    expect(f.requests).toEqual(['agent3ContinuityCritic', 'agent3ContinuityFormatRecovery', 'agent3ContinuityFormatRecovery'])
    expect(f.report().history![0].rawResponses).toEqual(['{broken', '{broken'])
    expect(f.fees).toHaveLength(3)
  })
  it('keeps seven opinions when a later same-body correction provides actual visible IDs', async () => {
    const f = runnerFixture(), opinions = Array.from({ length: 7 }, (_, i) => ({ ...opinion('missing-' + i), explanation: '意见' + i }))
    await reviewContinuity(f.ctx, { compilationId: 'comp' }, { allowRepair: false, dispatch: f.dispatch(action => action === 'agent3ContinuityCritic' ? JSON.stringify({ findings: opinions }) : '{"corrections":[]}') })
    expect(f.report().opinions).toEqual(opinions)
    const second = await reviewContinuity({ ...f.ctx, callId: 'call2' }, { compilationId: 'comp' }, { allowRepair: false,
      dispatch: f.dispatch(() => JSON.stringify({ corrections: opinions.map((_, index) => ({ index, evidence: opinion().evidence })) })) })
    expect(second).toMatchObject({ reviewCompleted: true, reviewOutcome: 'decision_required' })
    expect(f.requests).toEqual(['agent3ContinuityCritic', 'agent3ContinuityEvidenceCorrection', 'agent3ContinuityEvidenceCorrection'])
    expect(f.report().opinions).toHaveLength(7)
    expect(f.report().findings).toHaveLength(7)
    expect(f.report().history![0].opinions).toEqual(opinions)
    expect(second.output).toContain('reportId=')
    expect(second.output).toContain(table().entries[0].text)
  })
  it.each(['stale', 'cancel', 'owner'] as const)('keeps the actual raw and fees when %s changes after the response', async changed => {
    const f = runnerFixture(), raw = JSON.stringify({ findings: [opinion()] }); let currentOwner = true
    f.ctx.assertCurrentExecution = async () => { if (!currentOwner) throw new DataAccessError(409, 'RUNTIME_PARENT_LEASE_LOST', '原owner已结束') }
    const result = reviewContinuity(f.ctx, { compilationId: 'comp' }, { allowRepair: false, dispatch: f.dispatch(() => {
      if (changed === 'stale') { f.chapter.revision++; f.chapter.content += '作者实际增补。' }
      if (changed === 'cancel') f.controller.abort(new Error('作者取消'))
      if (changed === 'owner') currentOwner = false
      return raw
    }) })
    await expect(result).rejects.toBeDefined()
    expect(f.report().rawResponses).toEqual([raw]); expect(f.report().usageIds).toEqual(['fee1'])
    expect(f.report().billingKnown).toBe(true); expect(f.report().complete).toBe(false)
    expect(f.compilation.validation).toEqual({})
    expect(f.requests).toHaveLength(1)
  })
  it('does not repeat a native unknown request merely because legacy usage is empty', async () => {
    const f = runnerFixture()
    const dispatch = vi.fn(async () => { f.operations.push(nativeFee('unknown')); throw new DataAccessError(409, 'RUNTIME_RECONCILIATION_REQUIRED', '原响应未知') })
    await expect(reviewContinuity(f.ctx, { compilationId: 'comp' }, { allowRepair: false, dispatch })).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
    await expect(reviewContinuity({ ...f.ctx, callId: 'call2' }, { compilationId: 'comp' }, { allowRepair: false, dispatch })).rejects.toMatchObject({ code: 'AI_PROVIDER_BILLING_UNCONFIRMED' })
    expect(dispatch).toHaveBeenCalledTimes(1); expect(f.fees).toEqual([]); expect(f.operations).toHaveLength(1)
  })
  it.each(['provider-failed', 'truncated'] as const)('replays the failed automatic repair receipt after %s without another request', async kind => {
    const f = runnerFixture(); f.ctx.creativeFreedom = 'balanced'
    vi.spyOn(guard, 'readChapterReviewReadiness').mockResolvedValue(null)
    vi.spyOn(guard, 'probeChapterReviewRevision').mockResolvedValue({ open: true })
    vi.spyOn(humanity, 'buildHumanityQualityContext').mockResolvedValue({ chapter: { ...f.chapter, novel: {} }, profiles: [], anchors: [], recentChapters: [], chapterWritingBackground: [], originalRequest: '检查并修复本章' } as never)
    const base = f.dispatch(action => { if (action === 'agent3ContinuityRevision') {
      if (kind === 'provider-failed') throw new DataAccessError(502, 'AI_PROVIDER_ERROR', '供应商已返回失败')
      return '{"patches":['
    } return JSON.stringify({ findings: [opinion()] }) })
    const dispatch = async (...args: Parameters<typeof base>) => ({ ...await base(...args),
      ...(kind === 'truncated' && args[0].action === 'agent3ContinuityRevision' ? { providerComplete: false } : {}) })
    const first = await reviewContinuity(f.ctx, { compilationId: 'comp' }, { dispatch })
    expect(first).toMatchObject({ outcome: 'failed', reviewCompleted: true })
    expect(f.report()).toMatchObject({ complete: true, repairAttempted: true, repairResult: first })
    const raw = structuredClone(f.report().rawResponses), fees = structuredClone(f.fees)
    const cached = await reviewContinuity({ ...f.ctx, callId: 'call2' }, { compilationId: 'comp' }, { dispatch })
    expect(cached).toEqual(first); expect(cached.outcome).toBe('failed'); expect(cached.output).toContain('自动修订未应用')
    expect(f.report().rawResponses).toEqual(raw); expect(f.fees).toEqual(fees)
    expect(f.requests).toEqual(['agent3ContinuityCritic', 'agent3ContinuityRevision'])
  })
  it('replays the original paid local patch after an effect rollback without buying a new repair', async () => {
    const f = runnerFixture(); f.ctx.creativeFreedom = 'balanced'
    vi.spyOn(guard, 'readChapterReviewReadiness').mockResolvedValue(null)
    vi.spyOn(guard, 'probeChapterReviewRevision').mockResolvedValue({ open: true })
    vi.spyOn(humanity, 'buildHumanityQualityContext').mockResolvedValue({ chapter: { ...f.chapter, novel: {} }, profiles: [], anchors: [], recentChapters: [], chapterWritingBackground: [], originalRequest: '检查并修复本章' } as never)
    const write = vi.spyOn(mutation, 'updateOwnedChapterAtRevision').mockImplementation(async (_ctx, expected, data) => {
      expect(expected.revision).toBe(4)
      Object.assign(f.chapter, data, { revision: 5 })
      return { ...f.chapter } as never
    })
    vi.spyOn(internal, 'recalculateNovelStats').mockResolvedValue(undefined)
    vi.spyOn(flags, 'isAgent2FeatureEnabled').mockReturnValue(false)
    const dispatch = f.dispatch(action => action === 'agent3ContinuityRevision'
      ? JSON.stringify({ patches: [{ findingId: '0', replacement: table().entries[0].text.replace('三千四百元', '三万四千元') }] }) : JSON.stringify({ findings: [opinion()] }))
    const applyRepair = vi.fn().mockRejectedValueOnce(new Error('synthetic-effect-rollback'))
      .mockImplementationOnce(async (_report, apply) => apply(prisma))
    await expect(reviewContinuity(f.ctx, { compilationId: 'comp' }, { dispatch, applyRepair })).rejects.toThrow('synthetic-effect-rollback')
    expect(f.report()).toMatchObject({ complete: true, repairAttempted: true, repairResponseIndex: 1 })
    expect(f.chapter.revision).toBe(4); expect(write).not.toHaveBeenCalled()
    const originalRaw = [...f.report().rawResponses], originalFees = [...f.fees]
    const recovered = await reviewContinuity({ ...f.ctx, callId: 'call2' }, { compilationId: 'comp' }, { dispatch, applyRepair })
    expect(recovered).toMatchObject({ reviewCompleted: false, reviewOutcome: 'stale', display: { kind: 'chapterDiff', revision: 5 } })
    expect(write).toHaveBeenCalledOnce(); expect(f.chapter.content).toBe(body.replace('三千四百元', '三万四千元'))
    expect(f.report().rawResponses).toEqual(originalRaw); expect(f.fees).toEqual(originalFees)
    expect(f.requests).toEqual(['agent3ContinuityCritic', 'agent3ContinuityRevision'])
  })
  it('returns the actual repair retain proposals without treating them as author decisions', async () => {
    const f = runnerFixture(); f.ctx.creativeFreedom = 'balanced'
    vi.spyOn(guard, 'readChapterReviewReadiness').mockResolvedValue(null)
    vi.spyOn(guard, 'probeChapterReviewRevision').mockResolvedValue({ open: true })
    vi.spyOn(humanity, 'buildHumanityQualityContext').mockResolvedValue({ chapter: { ...f.chapter, novel: {} }, profiles: [], anchors: [], recentChapters: [], chapterWritingBackground: [], originalRequest: '检查并修复本章' } as never)
    const result = await reviewContinuity(f.ctx, { compilationId: 'comp' }, { dispatch: f.dispatch(action => action === 'agent3ContinuityRevision'
      ? JSON.stringify({ patches: [], retainedFindings: [{ findingId: '0', reason: '需要作者核对人物是否在故意算错，当前没有安全替换。' }] }) : JSON.stringify({ findings: [opinion()] })) })
    expect(result).toMatchObject({ reviewCompleted: true, reviewOutcome: 'decision_required' })
    expect(result.output).toContain('修订保留建议'); expect(result.output).toContain('需要作者核对人物是否在故意算错')
    expect(f.report()).toMatchObject({ complete: true, repairAttempted: true, retainedProposals: [{ findingId: '0', reason: expect.any(String) }] })
    expect(f.chapter.revision).toBe(4)
  })
  it('does not repeat an unknown native repair even when the original report is complete', async () => {
    const f = runnerFixture(); f.ctx.creativeFreedom = 'balanced'
    vi.spyOn(guard, 'readChapterReviewReadiness').mockResolvedValue(null)
    vi.spyOn(guard, 'probeChapterReviewRevision').mockResolvedValue({ open: true })
    vi.spyOn(humanity, 'buildHumanityQualityContext').mockResolvedValue({ chapter: { ...f.chapter, novel: {} }, profiles: [], anchors: [], recentChapters: [], chapterWritingBackground: [], originalRequest: '检查并修复本章' } as never)
    const dispatch = f.dispatch(action => {
      if (action === 'agent3ContinuityRevision') { f.operations.push(nativeFee('unknown')); throw new DataAccessError(409, 'RUNTIME_RECONCILIATION_REQUIRED', '原修订响应未知') }
      return JSON.stringify({ findings: [opinion()] })
    })
    await expect(reviewContinuity(f.ctx, { compilationId: 'comp' }, { dispatch })).rejects.toMatchObject({ code: 'RUNTIME_RECONCILIATION_REQUIRED' })
    expect(f.report()).toMatchObject({ complete: true, repairAttempted: true, billingKnown: false })
    await expect(reviewContinuity({ ...f.ctx, callId: 'call2' }, { compilationId: 'comp' }, { dispatch })).rejects.toMatchObject({ code: 'AI_PROVIDER_BILLING_UNCONFIRMED' })
    expect(f.requests).toEqual(['agent3ContinuityCritic', 'agent3ContinuityRevision']); expect(f.chapter.revision).toBe(4)
  })
  it('does not certify a syntactically complete report from a truncated physical response', async () => {
    const f = runnerFixture(), base = f.dispatch(() => JSON.stringify({ findings: [opinion()] }))
    const result = await reviewContinuity(f.ctx, { compilationId: 'comp' }, { allowRepair: false,
      dispatch: async (...args) => ({ ...await base(...args), providerComplete: false }) })
    expect(result).toMatchObject({ outcome: 'failed', reviewCompleted: false })
    expect(f.report()).toMatchObject({ complete: false, opinions: [opinion()], incompleteResponses: [0, 1], billingKnown: true })
    expect(f.requests).toEqual(['agent3ContinuityCritic', 'agent3ContinuityFormatRecovery'])
  })
  it.each(['malformed', 'empty', 'same-text', 'cas-conflict'] as const)('returns an actual failed repair receipt for %s while keeping the complete report and raw', async kind => {
    const f = runnerFixture(); f.ctx.creativeFreedom = 'balanced'
    vi.spyOn(guard, 'readChapterReviewReadiness').mockResolvedValue(null)
    vi.spyOn(guard, 'probeChapterReviewRevision').mockResolvedValue({ open: true })
    vi.spyOn(humanity, 'buildHumanityQualityContext').mockResolvedValue({ chapter: { ...f.chapter, novel: {} }, profiles: [], anchors: [], recentChapters: [], chapterWritingBackground: [], originalRequest: '检查并修复本章' } as never)
    const write = vi.spyOn(mutation, 'updateOwnedChapterAtRevision').mockResolvedValue(null)
    const repair = kind === 'malformed' ? '{broken' : kind === 'empty' ? '{"patches":[]}'
      : JSON.stringify({ patches: [{ findingId: '0', replacement: kind === 'same-text' ? table().entries[0].text : table().entries[0].text.replace('三千四百元', '三万四千元') }] })
    const result = await reviewContinuity(f.ctx, { compilationId: 'comp' }, { dispatch: f.dispatch(action => action === 'agent3ContinuityRevision' ? repair : JSON.stringify({ findings: [opinion()] })) })
    expect(result).toMatchObject({ outcome: 'failed', reviewCompleted: true })
    expect(f.report()).toMatchObject({ complete: true, repairAttempted: true, rawResponses: [JSON.stringify({ findings: [opinion()] }), repair] })
    expect(f.chapter.revision).toBe(4); expect(f.chapter.content).toBe(body)
    expect(write).toHaveBeenCalledTimes(kind === 'cas-conflict' ? 1 : 0)
    expect(result.output).toContain('自动修订未应用')
  })
  it.each(['critic', 'format'] as const)('fences the current legacy owner immediately before the actual %s dispatch', async kind => {
    const f = runnerFixture(); let checks = 0, current = true
    f.ctx.assertCurrentExecution = async () => {
      if (!current) throw new DataAccessError(409, 'RUNTIME_PARENT_LEASE_LOST', '原owner已结束')
      if (++checks === (kind === 'critic' ? 1 : 3)) queueMicrotask(() => { current = false })
    }
    vi.spyOn(auxiliaryRuntime, 'resolveReviewModelRuntime').mockResolvedValue({ tier: 'speed', multiplierBps: 10000, provider: 'fixture', modelName: 'fixture',
      baseUrl: 'https://fixture.invalid', apiKey: 'fixture-only', reasoningEffort: 'high', reasoningEfforts: ['none', 'high'],
      reasoningParameterMode: 'native', thinkingEnabled: true, visionEnabled: false, contextWindowTokens: 128000 })
    const generate = vi.spyOn(reviewCompletion, 'generateReviewCompletion').mockImplementation(async () => {
      const fee = { id: 'fee-known', usageSource: 'reported', billingStatus: 'settled', requestTokens: 12, responseTokens: 8, reservedCreditMilli: 0 }
      f.fees.push(fee)
      const record = beginTextRequest(fee.id).record; record.status = 'terminal'; record.billingKnown = true
      return '{broken'
    })
    await expect(reviewContinuity(f.ctx, { compilationId: 'comp' }, { allowRepair: false })).rejects.toMatchObject({ code: 'RUNTIME_PARENT_LEASE_LOST' })
    expect(generate).toHaveBeenCalledTimes(kind === 'critic' ? 0 : 1)
    if (kind === 'critic') expect(f.compilation.validation).toEqual({})
    else expect(f.compilation.validation).toMatchObject({ independentCheck: 'unavailable', continuityReport: { complete: false } })
    expect(f.fees).toHaveLength(kind === 'critic' ? 0 : 1)
    expect(f.report().rawResponses).toEqual(kind === 'critic' ? [] : ['{broken'])
  })
})
