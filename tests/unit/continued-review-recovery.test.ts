import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import type { AgentMessagePart } from '../../shared/contracts/index.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readContinuedReviewRecovery, readAuthorContinuedReviewUsageIds, readContinuedReviewDispatchWitness, readContinuedReviewRepairHandoff,
  continuedReviewAttemptKey, continuedReviewCallId } from '../../api/lib/agent/continued-review-recovery.js'
import { hasReconciledQualityRequest } from '../../api/lib/agent/quality-format-recovery.js'
const mocks = vi.hoisted(() => ({ original: {} as Record<string, unknown>, bundle: {} as Record<string, unknown>, admission: null as null | { id: string; at: Date } }))
vi.mock('../../api/lib/agent/original-request.js', () => ({ readOriginalTaskRequest: async () => mocks.original, originalTaskRunIds: async () => ['run'] }))
vi.mock('../../api/lib/agent/quality-review-admission.js', () => ({ readQualityReviewAdmission: async () => mocks.admission }))
vi.mock('../../api/lib/agent/humanity-quality.js', () => ({ HUMANITY_CRITIC_VERSION: 'current-test', buildHumanityQualityContext: async () => mocks.bundle,
  analyzeDeterministicQuality: () => ({ metrics: {}, findings: [] }), qualityReviewContextHash: (value: unknown) => JSON.stringify(value) }))
vi.mock('../../api/lib/agent/tools/humanity-quality-tools.js', () => ({ buildCriticSystem: () => 'full rules', buildCriticInput: () => JSON.stringify(mocks.bundle) }))
vi.mock('../../api/lib/agent/tools/story-compiler-tools.js', () => ({ continuityCriticSystem: 'full continuity rules' }))
type Row = Record<string, unknown>
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return (value as Row[]).some(filter => matches(row, filter))
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      const filter = value as Row, current = row[key]
      if ('in' in filter) return (filter.in as unknown[]).includes(current)
      if ('startsWith' in filter) return String(current).startsWith(String(filter.startsWith))
      if ('isNot' in filter) return current == null || !matches(current as Row, filter.isNot as Row)
      if ('gte' in filter || 'lte' in filter) return (!(filter.gte instanceof Date) || current instanceof Date && current >= filter.gte)
        && (!(filter.lte instanceof Date) || current instanceof Date && current <= filter.lte)
      if ('volume' === key) return matches(current as Row, filter)
    }
    return row[key] === value
  })
}
function table(rows: Row[]) {
  const find = (input: { where?: Row; take?: number } = {}) => rows.filter(row => matches(row, input.where)).slice(0, input.take ?? Infinity)
  return { findFirst: vi.fn(async (input = {}) => find(input)[0] ?? null), findMany: vi.fn(async (input = {}) => find(input)),
    findUnique: vi.fn(async (input = {}) => find(input)[0] ?? null),
    create: vi.fn(() => { throw new Error('reader must not write') }), update: vi.fn(() => { throw new Error('reader must not write') }) }
}
function fixture(toolName: 'quality_analyze' | 'continuity_validate' = 'quality_analyze') {
  const pending = { compilationId: 'comp', chapterId: 'chapter', revision: 3, toolName, callId: 'oldCall' }, subject = { userId: 'owner', novelId: 'novel', runId: 'run' }
  const run = { id: 'run', userId: 'owner', novelId: 'novel', sessionId: 'session', incomingChildGrant: null, taskRootId: null, runtimeProtocolVersion: 0, status: 'running', manuscriptRevision: 0,
    currentTurn: 42, usage: { totalTokens: 50000, checkpoint: { stagnantBatches: 9, reviewAttempts: ['old-claimed'], pendingReviews: [pending] } } }
  const chapter = { id: 'chapter', authorId: 'owner', novelId: 'novel', orderIndex: 5, revision: 4, content: '完整新正文', archivedAt: null, volume: { novelId: 'novel', archivedAt: null } }
  const events: Row[] = [{ id: 'old-call', runId: 'run', seq: 1, type: 'tool.call', createdAt: new Date(1000), payload: { callId: 'oldCall', toolName, args: { chapterId: 'chapter', compilationId: 'comp' } } },
    { id: 'old-result', runId: 'run', seq: 2, type: 'tool.result', createdAt: new Date(3000), payload: { callId: 'oldCall', toolName, ok: false, failureCode: 'AI_PROVIDER_TRANSPORT' } },
    { id: 'pause', runId: 'run', seq: 3, type: 'run.paused', createdAt: new Date(4000), payload: {} },
    { id: 'start', runId: 'run', seq: 4, type: 'run.started', createdAt: new Date(5000), payload: { authorContinue: { eventId: 'pause', afterSeq: 3 } } }]
  const usage = [{ id: 'unknown', userId: 'owner', novelId: 'novel', agentRunId: 'run', providerType: 'text', chapterId: 'chapter', targetId: 'chapter',
    action: toolName === 'quality_analyze' ? 'agent3HumanityCritic' : 'agent3ContinuityCritic', createdAt: new Date(2000), durationMs: 0,
    usageSource: 'unknown', billingStatus: 'pending_usage', requestTokens: null, responseTokens: null, reservedCreditMilli: 18023,
    billingSnapshot: { version: 'credits-v1-exact', modelTier: 'standard', multiplierBps: 12000 } }]
  const compilation = { id: 'comp', userId: 'owner', novelId: 'novel', runId: 'run', chapterId: 'chapter', status: 'active', bridge: null, sceneTasks: [] }
  const reports: Row[] = [], artifacts: Row[] = [], findings: Row[] = []
  const db = { agentRun: table([run]), novel: table([{ id: 'novel', authorId: 'owner', manuscriptRevision: 0 }]), agentGoalExecution: table([]),
    agentRunEvent: table(events), chapter: table([chapter]), storyCompilation: table([compilation]), aiUsageLog: table(usage), chapterQualityReport: table(reports),
    agentArtifact: table(artifacts), qualityFinding: table(findings) }
  mocks.original = { taskId: 'task', prompt: '完整原请求及写入范围', parentRunId: null, sourceRunId: 'run',
    spec: { scope: { novelId: 'novel', writing: { kind: 'bounded', targets: [{ orderIndex: 5 }] } } } }
  mocks.bundle = { chapter, compilation, originalRequest: mocks.original.prompt, recentChapters: [{ content: '完整前章' }] }
  mocks.admission = { id: 'author-continue:pause', at: new Date(5000) }
  const tx = db as unknown as Prisma.TransactionClient
  const read = (pendingInput = [pending]) => readContinuedReviewRecovery(tx, subject, pendingInput)
  const persist = (item: Awaited<ReturnType<typeof read>>[number]) => events.push({ id: 'audit', runId: 'run', seq: 5, type: 'review.reconciled', createdAt: new Date(6000),
    payload: { callId: item.callId, chapterId: item.chapterId, compilationId: item.compilationId, revision: item.revision, receipt: item.receipt } })
  return { tx, db, run, events, usage, reports, artifacts, findings, chapter, compilation, pending, subject, read, persist,
    snapshot: () => JSON.stringify({ run, events, usage, reports, compilation }) }
}
beforeEach(() => { vi.clearAllMocks() })
describe('ordinary Continue review retirement', () => {
  it.each(['quality_analyze', 'continuity_validate'] as const)('%s authenticates one prior failed request and leaves old usage/reserve/budget/stagnation intact', async toolName => {
    const f = fixture(toolName), before = f.snapshot(), rows = await f.read()
    expect(rows).toHaveLength(1)
    expect(rows[0].receipt).toMatchObject({ status: 'author_continued_review', usageOutcome: 'unknown_preserved', sourceCallId: 'oldCall',
      sourceResultId: 'old-result', admissionEventId: 'start', taskId: 'task', currentRevision: 4, usageIds: ['unknown'] })
    expect(rows[0].receipt.currentContextHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(rows[0].receipt).not.toHaveProperty('sourceReportId', expect.any(String))
    expect(await f.read()).toEqual(rows)
    expect(f.snapshot()).toBe(before)
    expect(f.db.aiUsageLog.update).not.toHaveBeenCalled(); expect(f.db.agentRun.update).not.toHaveBeenCalled()
  })
  it.each(['no-author', 'message-fallback', 'owner', 'scope', 'native', 'ended', 'post-start', 'wrong-target', 'duplicate', 'overlap', 'unmatched-usage', 'foreign-action', 'no-unknown', 'duplicate-primary'])(
    '%s cannot retire a request or authorize a fresh check', async kind => {
    const f = fixture()
    if (kind === 'no-author') mocks.admission = null
    if (kind === 'message-fallback') mocks.admission = { id: 'author-message:message', at: new Date(5000) }
    if (kind === 'owner') f.run.userId = 'other'
    if (kind === 'scope') (mocks.original.spec as Row).scope = { novelId: 'novel', writing: { kind: 'bounded', targets: [{ orderIndex: 6 }] } }
    if (kind === 'native') f.run.runtimeProtocolVersion = 1
    if (kind === 'ended') f.run.status = 'cancelled'
    if (kind === 'post-start') { f.events[0].createdAt = new Date(5100); f.events[1].createdAt = new Date(5200); f.events[0].seq = 5; f.events[1].seq = 6 }
    if (kind === 'wrong-target') (f.events[0].payload as Row).args = { chapterId: 'other' }
    if (kind === 'duplicate') f.events.push({ ...f.events[0], id: 'duplicate' })
    if (kind === 'overlap') f.events.push({ id: 'overlap', runId: 'run', seq: 0, type: 'tool.call', createdAt: new Date(900), payload: { callId: 'writer', toolName: 'chapter_write' } })
    if (kind === 'unmatched-usage') f.usage[0].createdAt = new Date(4500)
    if (kind === 'foreign-action') f.usage[0].action = 'agent3HumanityAuthorReplacement'
    if (kind === 'no-unknown') f.usage[0].usageSource = 'reported'
    if (kind === 'duplicate-primary') f.usage.push({ ...f.usage[0], id: 'duplicate-primary' })
    const before = f.snapshot()
    expect(await f.read()).toEqual([]); expect(f.snapshot()).toBe(before)
  })
  it('restores the same audit/key after checkpoint loss or repeated worker starts without creating a new call identity', async () => {
    const f = fixture(), [first] = await f.read()
    f.persist(first)
    f.events.push({ id: 'restart', runId: 'run', seq: 6, type: 'run.started', createdAt: new Date(7000), payload: { authorContinue: { eventId: 'pause', afterSeq: 5 } } })
    const [restored] = await f.read([])
    expect(restored).toMatchObject({ ...first, persisted: true })
    const key = continuedReviewAttemptKey(first.receipt, 'quality_analyze')
    expect(continuedReviewCallId(continuedReviewAttemptKey(restored.receipt, 'quality_analyze'))).toBe(continuedReviewCallId(key))
    expect(await readAuthorContinuedReviewUsageIds(f.tx, f.subject)).toEqual(new Set(['unknown']))
  })
  it.each(['body', 'original-context', 'prior-body', 'forged-audit'])('%s drift never mints a second key from the same author start', async kind => {
    const f = fixture(), [first] = await f.read(); f.persist(first)
    if (kind === 'body') f.chapter.content = '已变化正文'
    if (kind === 'original-context') mocks.bundle.originalRequest = '另一个作者要求'
    if (kind === 'prior-body') (mocks.bundle.recentChapters as Row[])[0].content = '已变化前章'
    if (kind === 'forged-audit') ((f.events[4].payload as Row).receipt as Row).admissionEventId = 'fake-start'
    expect(await f.read()).toEqual([])
    expect(await readAuthorContinuedReviewUsageIds(f.tx, f.subject)).toEqual(new Set(kind === 'forged-audit' ? [] : ['unknown']))
  })
  it('retains historical exact old-call execution exemption after a real r+1 edit without granting another dispatch or exempting new unknown usage', async () => {
    const f = fixture(), [first] = await f.read(); f.persist(first)
    f.chapter.content = '真实修补后的r5正文'; f.chapter.revision = 5
    mocks.bundle.originalRequest = '原任务的新当前完整上下文'
    f.usage.push({ ...f.usage[0], id: 'new-unknown', createdAt: new Date(7200) })
    const beforeUsage = JSON.stringify(f.usage)
    expect(await f.read([])).toEqual([])
    expect(await readAuthorContinuedReviewUsageIds(f.tx, f.subject)).toEqual(new Set(['unknown']))
    expect(JSON.stringify(f.usage)).toBe(beforeUsage)
  })
  it('keeps the authenticated old retirement after a later distinct author Continue without borrowing it for a new dispatch', async () => {
    const f = fixture(), [first] = await f.read(); f.persist(first)
    f.events.push({ id: 'later-pause', runId: 'run', seq: 6, type: 'run.paused', createdAt: new Date(7000), payload: {} },
      { id: 'later-start', runId: 'run', seq: 7, type: 'run.started', createdAt: new Date(8000), payload: { authorContinue: { eventId: 'later-pause', afterSeq: 6 } } })
    mocks.admission = { id: 'author-continue:later-pause', at: new Date(8000) }
    expect(await readAuthorContinuedReviewUsageIds(f.tx, f.subject)).toEqual(new Set(['unknown']))
    expect((await f.read([]))).toEqual([])
  })
  it('exempts only the old audited execution id, never a new unknown request after that author start', async () => {
    const f = fixture(), [first] = await f.read(); f.persist(first)
    const current = { ...f.pending, callId: continuedReviewCallId(continuedReviewAttemptKey(first.receipt, 'quality_analyze')) }
    f.events.push({ id: 'new-call', runId: 'run', seq: 6, type: 'tool.call', createdAt: new Date(7100), payload: { toolName: current.toolName, callId: current.callId, args: { chapterId: 'chapter', compilationId: 'comp' } } },
      { id: 'new-result', runId: 'run', seq: 7, type: 'tool.result', createdAt: new Date(7500), payload: { toolName: current.toolName, callId: current.callId, ok: false, failureCode: 'AI_PROVIDER_TRANSPORT' } })
    f.usage.push({ ...f.usage[0], id: 'new-unknown', createdAt: new Date(7200) })
    expect((await f.read([current])).some(item => item.callId === current.callId)).toBe(false)
    expect(await readAuthorContinuedReviewUsageIds(f.tx, f.subject)).toEqual(new Set(['unknown']))
    expect(f.usage.map(row => row.reservedCreditMilli)).toEqual([18023, 18023])
  })
  it('permits a fresh quality tool only for the exact prior failed report; it never resets its format claim', async () => {
    const f = fixture(), report = { id: 'failed-report', userId: 'owner', novelId: 'novel', runId: 'run', chapterId: 'chapter', chapterRevision: 3,
      status: 'failed', createdAt: new Date(2500), deterministicMetrics: { criticResponse: { callId: 'oldCall' }, formatRecovery: { state: 'claimed', key: 'old-format' } } }
    f.reports.push(report)
    const [first] = await f.read(); f.persist(first)
    expect(await hasReconciledQualityRequest(f.tx, f.subject, report)).toBe(true)
    expect(await hasReconciledQualityRequest(f.tx, f.subject, { ...report, id: 'other-report' })).toBe(false)
    expect(report.deterministicMetrics.formatRecovery).toEqual({ state: 'claimed', key: 'old-format' })
  })
  it.each(['body', 'context', 'admission', 'cancel', 'not-running'] as const)('the immediate dispatch witness denies %s drift after the first authenticated reader', async kind => {
    const f = fixture(), [item] = await f.read(); f.persist(item)
    if (kind === 'body') f.chapter.content = '其他作者窗口的变更'
    if (kind === 'context') mocks.bundle.originalRequest = '另一份请求'
    if (kind === 'admission') mocks.admission = { id: 'author-continue:other', at: new Date(8000) }
    if (kind === 'cancel') f.run.status = 'cancelled'
    if (kind === 'not-running') f.run.status = 'paused'
    expect(await readContinuedReviewDispatchWitness(f.tx, f.subject, item, 'new-call')).toBeNull()
    expect(f.db.aiUsageLog.create).not.toHaveBeenCalled(); expect(f.db.agentRun.update).not.toHaveBeenCalled()
  })
  async function repairedFixture(standalone = false) {
    const f = fixture()
    if (standalone) {
      ;(f.pending as Row).compilationId = null
      ;(f.events[0].payload as Row).args = { chapterId: 'chapter' }
    }
    ;(f.compilation as Row).bridge = { id: 'bridge', fromChapterId: null, toChapterId: 'chapter', targetRevision: 4 }
    const [item] = await f.read(); f.persist(item)
    const callId = continuedReviewCallId(continuedReviewAttemptKey(item.receipt, 'quality_analyze'))
    const witness = (await readContinuedReviewDispatchWitness(f.tx, f.subject, item, callId))!
    const before = f.chapter.content, after = '本调用实际原子修补的新正文'
    const sha = (text: string) => createHash('sha256').update(text).digest('hex')
    f.chapter.content = after; f.chapter.revision = 5
    ;(f.compilation.bridge as unknown as Row).targetRevision = 5
    const report: Row = { id: 'actual-report', userId: 'owner', novelId: 'novel', runId: 'run', chapterId: 'chapter', compilationId: 'comp',
      status: 'repaired', repairRound: 1, chapterRevision: 5, createdAt: new Date(witness.at.getTime() + 1), deterministicMetrics: {
        independentCheck: 'complete', contentHash: item.receipt.currentContentHash, qualityContextHash: witness.qualityContextHash,
        sourceRevision: 4, repairedContentHash: sha(after), criticResponse: { callId } } }
    f.reports.push(report)
    const artifact: Row = { id: 'repair-artifact', runId: 'run', artifactType: 'rewriteSelection', createdAt: new Date(witness.at.getTime() + 10),
      content: JSON.stringify([{ findingId: 'finding', replacement: after }]), metadata: { phase: 'humanity_revision_auto', reportId: report.id,
        sourceRevision: 4, targetRevision: 5, findingIds: ['finding'] } }
    f.artifacts.push(artifact)
    f.findings.push({ id: 'finding', reportId: report.id, userId: 'owner', novelId: 'novel', disposition: 'repaired', startOffset: 0, endOffset: before.length, evidenceHash: sha(before) })
    f.usage.push({ ...f.usage[0], id: 'current-paid-critic', usageSource: 'reported', billingStatus: 'settled', reservedCreditMilli: 0,
      requestTokens: 10, responseTokens: 2, createdAt: new Date(witness.at.getTime() + 2) } as typeof f.usage[number])
    const part: Extract<AgentMessagePart, { type: 'tool-call' }> = { type: 'tool-call', callId, toolName: 'quality_analyze', title: '质量检查', args: {}, status: 'success',
      snapshot: { target: 'chapter', targetId: 'chapter', field: 'content', previousValue: before },
      display: { kind: 'qualityReport', reportId: 'actual-report', chapterId: 'chapter', chapterRevision: 5, status: 'repaired', repairRound: 1, findings: [] } }
    const handoff = () => readContinuedReviewRepairHandoff(f.tx, f.subject, item, witness, part)
    return { f, item, witness, before, after, report, artifact, part, handoff }
  }
  it('hands off only the exact paid report/snapshot/atomic repair chain while old billing remains unknown and unchanged', async () => {
    const r = await repairedFixture(), beforeRows = JSON.stringify(r.f.usage), beforeEvents = JSON.stringify(r.f.events)
    expect(await r.handoff()).toMatchObject({ chapterId: 'chapter', beforeHash: expect.stringMatching(/^[a-f0-9]{64}$/u), afterHash: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    expect(await r.f.read([])).toEqual([])
    expect(await readAuthorContinuedReviewUsageIds(r.f.tx, r.f.subject)).toEqual(new Set(['unknown']))
    expect(JSON.stringify(r.f.usage)).toBe(beforeRows); expect(JSON.stringify(r.f.events)).toBe(beforeEvents)
    expect(r.f.db.aiUsageLog.update).not.toHaveBeenCalled(); expect(r.f.db.agentArtifact.create).not.toHaveBeenCalled()
  })
  it('binds a standalone old slot to the actual current compiled quality input without changing its null retirement identity', async () => {
    const r = await repairedFixture(true)
    expect(r.item.compilationId).toBeNull(); expect(r.witness.compilationId).toBe('comp')
    expect(await r.handoff()).toMatchObject({ chapterId: 'chapter' })
  })
  it('hands off a reported exempt current-model request without charging or rewriting its billing', async () => {
    const r = await repairedFixture()
    r.f.usage[1].billingStatus = 'exempt'
    const billing = JSON.stringify(r.f.usage)
    expect(await r.handoff()).toMatchObject({ chapterId: 'chapter' })
    expect(JSON.stringify(r.f.usage)).toBe(billing)
    expect(r.f.db.aiUsageLog.update).not.toHaveBeenCalled()
  })
  it.each(['missing-input', 'missing-output', 'fractional-input', 'negative-output', 'reserved', 'unknown-exempt', 'not-dispatched'] as const)(
    'an exempt %s record cannot certify the repair request', async kind => {
      const r = await repairedFixture(), usage = r.f.usage[1]
      usage.billingStatus = 'exempt'
      if (kind === 'missing-input') usage.requestTokens = null
      if (kind === 'missing-output') usage.responseTokens = null
      if (kind === 'fractional-input') usage.requestTokens = 1.5
      if (kind === 'negative-output') usage.responseTokens = -1
      if (kind === 'reserved') usage.reservedCreditMilli = 1
      if (kind === 'unknown-exempt') usage.usageSource = 'unknown'
      if (kind === 'not-dispatched') {
        usage.usageSource = 'unknown'; usage.billingStatus = 'not_dispatched'
        usage.requestTokens = null; usage.responseTokens = null
      }
      expect(await r.handoff()).toBe(false)
    })
  it.each(['other-call', 'other-report', 'no-snapshot', 'no-op', 'forged-after-hash', 'missing-artifact', 'other-artifact', 'wrong-patch', 'wrong-finding',
    'unknown-usage', 'pending-bill', 'other-context', 'original-scope', 'admission', 'cancel'] as const)('a %s cannot borrow a genuine repair to authorize handoff', async kind => {
    const r = await repairedFixture(), metrics = r.report.deterministicMetrics as Row
    if (kind === 'other-call') r.part.callId = 'other-call'
    if (kind === 'other-report' && r.part.display?.kind === 'qualityReport') r.part.display.reportId = 'other-report'
    if (kind === 'no-snapshot') delete r.part.snapshot
    if (kind === 'no-op') r.f.chapter.content = r.before
    if (kind === 'forged-after-hash') metrics.repairedContentHash = 'f'.repeat(64)
    if (kind === 'missing-artifact') r.f.artifacts.length = 0
    if (kind === 'other-artifact') (r.artifact.metadata as Row).reportId = 'other-report'
    if (kind === 'wrong-patch') r.artifact.content = JSON.stringify([{ findingId: 'finding', replacement: '不同正文' }])
    if (kind === 'wrong-finding') r.f.findings[0].disposition = 'pending'
    if (kind === 'unknown-usage') r.f.usage[1].usageSource = 'unknown'
    if (kind === 'pending-bill') r.f.usage[1].billingStatus = 'pending_settlement'
    if (kind === 'other-context') mocks.bundle.originalRequest = '另一个当前原始请求'
    if (kind === 'original-scope') (mocks.original.spec as Row).extraScope = '未经本次许可的变化'
    if (kind === 'admission') mocks.admission = { id: 'author-continue:other', at: new Date(8000) }
    if (kind === 'cancel') r.f.run.status = 'cancelled'
    expect(await r.handoff()).toBe(false)
  })
})
