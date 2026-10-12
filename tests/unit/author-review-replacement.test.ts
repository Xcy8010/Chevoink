import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FALLBACK_USAGE_POLICY, priceTokenEvidence } from '../../api/lib/billing/reservation-policy.js'
import { getModelTierRuntime } from '../../api/lib/credits.js'
import { resolveTokenPrice } from '../../api/lib/billing/resolve-token-price.js'
import { env } from '../../api/config/env.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { buildQualityEvidenceSources } from '../../api/lib/agent/quality-evidence.js'
import { authorizeAuthorReviewReplacement, claimAuthorReviewReplacement, completeAuthorReviewReplacement,
  observeAuthorReviewResponse, failAuthorReviewReplacement, readAuthorReviewReplacementStatus, readAuthorReviewReplacements, validateClaimAuthorReviewReplacement,
  type AuthorReviewReplacementAuthorization } from '../../api/lib/agent/author-review-replacement.js'

const mocks = vi.hoisted(() => ({ bundle: {} as Record<string, unknown>, original: {} as Record<string, unknown>, runtime: {} as Record<string, unknown>, price: {} as Record<string, unknown> }))
vi.mock('../../api/lib/agent/manuscript-scope.js', () => ({ assertAgentManuscriptCurrent: vi.fn(async () => {}) }))
vi.mock('../../api/lib/agent/original-request.js', () => ({ readOriginalTaskRequest: vi.fn(async () => mocks.original), originalTaskRunIds: vi.fn(async () => ['run']) }))
vi.mock('../../api/lib/credits.js', () => ({ getModelTierRuntime: vi.fn(async () => mocks.runtime) }))
vi.mock('../../api/lib/billing/resolve-token-price.js', () => ({ resolveTokenPrice: vi.fn(async () => mocks.price) }))
vi.mock('../../api/lib/agent/tools/humanity-quality-tools.js', () => ({ buildCriticSystem: () => 'system', buildCriticInput: () => JSON.stringify(mocks.bundle) }))
vi.mock('../../api/lib/agent/humanity-quality.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../api/lib/agent/humanity-quality.js')>()
  return { ...actual, buildHumanityQualityContext: vi.fn(async () => mocks.bundle),
    qualityReviewContextHash: (bundle: unknown) => sha(JSON.stringify(bundle)), analyzeDeterministicQuality: () => ({ metrics: {}, findings: [] }),
    getLatestQualityReport: async (_user: unknown, _novel: unknown, _chapter: unknown, tx: Prisma.TransactionClient) => tx.chapterQualityReport.findFirst({ orderBy: { createdAt: 'desc' } }),
    persistHumanityQualityReport: async (input: Parameters<typeof actual.persistHumanityQualityReport>[0], tx: Prisma.TransactionClient) => {
      const content = String((mocks.bundle.chapter as { content: string }).content)
      const prepared = actual.prepareQualityFindings(content, input.deterministicFindings, input.criticFindings, input.criticComplete === true, input.sources, 3)
      return tx.chapterQualityReport.create({ data: { ...input, id: 'report', chapterRevision: input.chapterRevision, repairRound: 0,
        status: !prepared.complete ? 'failed' : prepared.findings.some(row => row.severity !== 'advisory') ? 'needs_repair' : 'passed',
        deterministicMetrics: { ...input.deterministicMetrics, qualityContextHash: input.qualityContextHash, contentHash: sha(content),
          independentCheck: prepared.complete ? 'complete' : 'unavailable', droppedFindings: input.criticDropped,
          omittedFindings: prepared.omittedFindings, unlocatedFindings: prepared.unlocatedFindings, criticFindingCount: prepared.criticFindingCount,
          criticResponse: input.criticResponseDiagnostic, evidenceSourceTableHash: sha(JSON.stringify(input.sources)) },
        findings: prepared.findings.map((row, index) => ({ id: `finding${index}`, signal: row.signal, source: row.source, severity: row.severity,
          startOffset: row.start, endOffset: row.end, evidenceExcerpt: row.evidence, evidenceHash: sha(content.slice(row.start, row.end)),
          explanation: row.explanation, suggestion: row.suggestion, confidence: row.confidence })) } as never })
    } }
})
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
type Row = Record<string, unknown>
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return (value as Row[]).some(filter => matches(row, filter))
    if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      const op = value as Row, current = row[key]
      if ('path' in op) return (op.path as string[]).reduce<unknown>((item, field) => (item as Row)?.[field], current) === op.equals
      if ('in' in op) return (op.in as unknown[]).includes(current)
      if ('gt' in op) return Number(current) > Number(op.gt)
      return current === value
    }
    return row[key] === value
  })
}
function table(rows: Row[]) {
  const find = (args: { where?: Row; orderBy?: Row | Row[]; take?: number } = {}) => {
    let result = rows.filter(row => matches(row, args.where))
    const order = Array.isArray(args.orderBy) ? args.orderBy : args.orderBy ? [args.orderBy] : []
    result = [...result].sort((a, b) => {
      for (const part of order) for (const [key, direction] of Object.entries(part)) {
        const left = a[key], right = b[key]
        const compared = left instanceof Date && right instanceof Date ? left.getTime() - right.getTime() : String(left).localeCompare(String(right))
        if (compared) return direction === 'desc' ? -compared : compared
      }
      return 0
    })
    return args.take ? result.slice(0, args.take) : result
  }
  return { findMany: vi.fn(async (args = {}) => find(args)), findFirst: vi.fn(async (args = {}) => find(args)[0] ?? null),
    findUnique: vi.fn(async (args = {}) => find(args)[0] ?? null), findFirstOrThrow: vi.fn(async (args = {}) => { const row = find(args)[0]; if (!row) throw new Error('missing row'); return row }),
    count: vi.fn(async (args = {}) => find(args).length), aggregate: vi.fn(async (args = {}) => ({ _sum: { reservedCreditMilli: find(args).reduce((sum, row) => sum + Number(row.reservedCreditMilli ?? 0), 0) } })),
    create: vi.fn(async ({ data }: { data: Row }) => { const row = { createdAt: new Date(), ...data }; rows.push(row); return row }),
    update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => { const row = find({ where })[0]; Object.assign(row, data); return row }) }
}
function fixture() {
  const pending = { compilationId: 'comp', chapterId: 'chapter', revision: 4, toolName: 'quality_analyze' as const, callId: 'oldCall' }
  const subject = { userId: 'owner', novelId: 'novel', runId: 'run' }
  const originalUsage = { id: 'oldUsage', userId: 'owner', novelId: 'novel', chapterId: 'chapter', targetId: 'chapter', agentRunId: null,
    action: 'agent3HumanityCritic', createdAt: new Date(2000), usageSource: 'unknown', billingStatus: 'pending_usage', requestTokens: null, responseTokens: null,
    reservedCreditMilli: 18023, billingEvidence: { responseObserved: false }, billingSnapshot: { preserved: true } }
  const events: Row[] = [{ id: 'oldCallEvent', runId: 'run', seq: 1, type: 'tool.call', createdAt: new Date(1000),
    payload: { callId: 'oldCall', toolName: 'quality_analyze', args: { chapterId: 'chapter', compilationId: 'comp' } } },
  { id: 'oldResult', runId: 'run', seq: 2, type: 'tool.result', createdAt: new Date(3000), payload: { callId: 'oldCall', toolName: 'quality_analyze', ok: false } }]
  const usage: Row[] = [originalUsage], reports: Row[] = [], ledger: Row[] = [], goals: Row[] = []
  const checkpoint = { version: 2, controlPolicy: 'until_completion', origin: 'unknown_legacy', activeExecutionMs: 100, stagnantBatches: 0,
    runStartedAt: 1000, resumeCount: 2, compactionCount: 1, maxTurns: 7, tokenBudget: 500, writeProgress: 3, writeBaseline: 2,
    readProgress: 5, readBaseline: 4, progressSignatures: [], inheritedTokens: 123, inheritedTurns: 2, manualResumeCount: 0,
    reviewAttempts: ['preservedOldAttempt'], pendingReviews: [pending] }
  const run = { id: 'run', userId: 'owner', novelId: 'novel', status: 'failed', taskRootId: null, runtimeProtocolVersion: 0,
    currentTurn: 7, modelTier: 'standard', customModelId: null, reasoningEffort: 'medium', usage: { promptTokens: 500, completionTokens: 100, totalTokens: 600, checkpoint } }
  const account = { userId: 'owner', dailyAllowanceMilli: 100000, dailyUsedMilli: 0, bonusBalanceMilli: 0, suspendedAt: null }
  const tx = { $queryRaw: vi.fn(async () => [{ id: 'novel' }]), agentRun: table([run]), agentRunEvent: table(events), aiUsageLog: table(usage),
    agentGoalExecution: table(goals), creditAccount: table([account]), creditLedgerEntry: table(ledger), chapterQualityReport: table(reports) } as unknown as Prisma.TransactionClient
  mocks.bundle = { chapter: { id: 'chapter', revision: 4, content: '她关上门。风吹动帘子。', orderIndex: 5 }, compilation: { id: 'comp', runId: 'run', status: 'active', mode: 'premium' }, recentChapters: [] }
  mocks.original = { taskId: 'task', sourceRunId: 'run', parentRunId: null, spec: { controlPolicy: 'until_completion', scope: { novelId: 'novel', writing: { kind: 'bounded', targets: [{ orderIndex: 5, chapterId: null }] } } } }
  mocks.runtime = { tier: 'standard', reasoningEffort: 'medium', provider: 'Xiaomi', modelName: 'mimo-v2.6-flash', multiplierBps: 12000 }
  mocks.price = { version: 'credits-v1-exact', modelTier: 'standard', multiplierBps: 12000 }
  const authorizationId = 'author-review-replacement:owner:123e4567-e89b-42d3-a456-426614174000'
  const input: AuthorReviewReplacementAuthorization = { authorizationId, humanAuthorizationRef: authorizationId, subject, taskId: 'task', pending, originalUsageIds: ['oldUsage'],
    authority: { source: 'authenticated_author_action', actorUserId: 'owner', quoteNonce: '123e4567-e89b-42d3-a456-426614174000' },
    expected: { currentRevision: 4, currentContentHash: sha(String((mocks.bundle.chapter as Row).content)), qualityContextHash: sha(JSON.stringify(mocks.bundle)),
      promptHash: sha(JSON.stringify({ system: 'system', content: JSON.stringify(mocks.bundle) })),
      model: { ...mocks.runtime, customModelId: null } as AuthorReviewReplacementAuthorization['expected']['model'], price: mocks.price as AuthorReviewReplacementAuthorization['expected']['price'] },
    conservativeInputTokenCeiling: 35100, maxOutputTokens: 16384, maxModelRequests: 1, maxCreditMilli: priceTokenEvidence(mocks.price as never, 35100, 16384, 0) }
  const snapshot = JSON.stringify({ run, originalUsage })
  async function start() { await authorizeAuthorReviewReplacement(tx, input); return claimAuthorReviewReplacement(tx, input.authorizationId) }
  async function finish(rawResponse = '{"findings":[]}', finishReason: string | null = 'stop') {
    const plan = await start(), price = priceTokenEvidence(input.expected.price, 100, 10)
    usage.push({ id: 'newUsage', userId: 'owner', novelId: 'novel', chapterId: 'chapter', targetType: 'chapter', targetId: plan.newCallId,
      agentRunId: 'run', action: plan.action, providerType: 'text', providerName: 'Xiaomi', modelName: 'mimo-v2.6-flash', modelTier: 'standard', multiplierBps: 12000,
      billingSnapshot: JSON.parse(JSON.stringify(input.expected.price)), usageSource: 'reported', billingStatus: 'settled', reservedCreditMilli: 0, requestTokens: 100, responseTokens: 10,
      creditChargeMilli: price, createdAt: new Date(), durationMs: 0, promptCacheHitTokens: null, billingEvidence: { responseObserved: true } })
    ledger.push({ idempotencyKey: 'usage:newUsage', userId: 'owner', sourceType: 'model_tokens', kind: 'usage', referenceId: plan.newCallId,
      deltaMilli: -price, requestTokens: 100, responseTokens: 10, modelTier: 'standard', multiplierBps: 12000, metadata: null })
    const received = { authorizationId: input.authorizationId, newCallId: plan.newCallId, rawResponse, finishReason, toolCalls: [], newUsageIds: ['newUsage'] }
    await observeAuthorReviewResponse(tx, received)
    await completeAuthorReviewReplacement(tx, received)
    return plan
  }
  function prepared(newCallId: string, billingStatus = 'authorized_pending') {
    const row = { id: 'preparedUsage', userId: 'owner', novelId: 'novel', chapterId: 'chapter', targetType: 'chapter', targetId: newCallId,
      agentRunId: 'run', action: 'agent3HumanityAuthorReplacement', providerType: 'text', providerName: 'Xiaomi', modelName: 'mimo-v2.6-flash', modelTier: 'standard', multiplierBps: 12000,
      billingSnapshot: JSON.parse(JSON.stringify(input.expected.price)), usageSource: 'prepared', billingStatus, reservedCreditMilli: 120, requestTokens: null, responseTokens: null,
      turn: null, creditChargeMilli: 0, createdAt: new Date(), durationMs: 0, billingRetryAt: null,
      billingEvidence: { policy: FALLBACK_USAGE_POLICY, inputEstimate: 1000, outputEstimate: 0, responseObserved: false } }
    usage.push(row)
    return row
  }
  const read = () => readAuthorReviewReplacements(tx, subject, [pending])
  return { tx, input, subject, pending, events, usage, reports, ledger, goals, run, account, snapshot, start, finish, read, prepared }
}

beforeEach(() => vi.clearAllMocks())
describe('one independent author quality dependency', () => {
  it('restores only a real completed report, idempotently, preserving unknown charges and original budgets', async () => {
    const f = fixture(), old = JSON.stringify(f.usage[0]), before = JSON.parse(f.snapshot).run
    await f.finish()
    const receipts = await f.read()
    expect(receipts).toHaveLength(1)
    expect(receipts[0].replacementReceipt).toMatchObject({ status: 'author_replacement_review_complete', sourceCallId: 'oldCall', sourceResultId: 'oldResult',
      sourceReportId: 'report', newUsageIds: ['newUsage'], originalUsageIds: ['oldUsage'], originalRequestOutcome: 'unknown_preserved' })
    expect(await f.read()).toEqual(receipts)
    expect(JSON.stringify(f.usage[0])).toBe(old)
    expect(f.run.usage).toEqual({ ...before.usage, checkpoint: { ...before.usage.checkpoint,
      reviewAttempts: [...before.usage.checkpoint.reviewAttempts, `author-replacement:${sha(f.input.authorizationId)}`] } })
    expect(f.tx.agentRun.update).toHaveBeenCalledTimes(1)
    expect(f.tx.aiUsageLog.create).not.toHaveBeenCalled()
  })
  it('never interprets an unrelated/false event or report as replacement authority', async () => {
    const f = fixture()
    f.events.push({ runId: 'run', type: 'tool.result', payload: { value: { authorizationId: f.input.authorizationId, complete: true } } })
    expect(await f.read()).toEqual([])
    expect(f.tx.agentRun.findFirst).not.toHaveBeenCalled()
    await f.start()
    expect(await f.read()).toEqual([])
  })
  it('rejects a duplicated authorization and a claimed-but-resultless restart', async () => {
    const f = fixture()
    await f.start()
    await expect(authorizeAuthorReviewReplacement(f.tx, f.input)).rejects.toThrow('未决')
    await expect(claimAuthorReviewReplacement(f.tx, f.input.authorizationId)).rejects.toThrow('已领取')
    expect(await f.read()).toEqual([])
    expect(f.events.filter(row => row.type === 'review.replacement.claimed')).toHaveLength(1)
  })
  it('rejects relabelled IDs and never treats false consent as a zero-request no-op', async () => {
    const f = fixture()
    await expect(authorizeAuthorReviewReplacement(f.tx, { ...f.input, authorizationId: 'different' })).rejects.toThrow()
    await expect(authorizeAuthorReviewReplacement(f.tx, { ...f.input, humanAuthorizationRef: false } as never)).rejects.toThrow()
    expect(f.tx.agentRunEvent.create).not.toHaveBeenCalled()
  })
  it.each(['owner', 'novel', 'task', 'compilation', 'scope', 'revision', 'body', 'context', 'model', 'price', 'cancelled', 'running', 'goal', 'budget', 'credit', 'overcap', 'zerocap'])(
    'rejects %s before any claim or model request', async kind => {
      const f = fixture()
      if (kind === 'owner') f.input.subject.userId = 'foreign'
      if (kind === 'novel') f.input.subject.novelId = 'foreign'
      if (kind === 'task') f.input.taskId = 'foreign'
      if (kind === 'compilation') f.input.pending.compilationId = 'foreign'
      if (kind === 'scope') ((mocks.original.spec as Row).scope as Row).writing = { kind: 'bounded', targets: [{ orderIndex: 4 }] }
      if (kind === 'revision') (mocks.bundle.chapter as Row).revision = 5
      if (kind === 'body') (mocks.bundle.chapter as Row).content = '变化的正文'
      if (kind === 'context') mocks.bundle.feedback = ['changed']
      if (kind === 'model') mocks.runtime.modelName = 'foreign'
      if (kind === 'price') mocks.price.multiplierBps = 13000
      if (kind === 'cancelled') f.run.status = 'cancelled'
      if (kind === 'running') f.run.status = 'running'
      if (kind === 'goal') f.goals.push({ runId: 'run' })
      if (kind === 'budget') f.run.usage.checkpoint.controlPolicy = 'corrupt'
      if (kind === 'credit') f.account.dailyUsedMilli = 70000
      if (kind === 'overcap') f.input.conservativeInputTokenCeiling = 200000
      if (kind === 'zerocap') f.input.maxCreditMilli = 0
      await expect(authorizeAuthorReviewReplacement(f.tx, f.input)).rejects.toThrow()
      expect(f.tx.agentRunEvent.create).not.toHaveBeenCalled()
    })
  it('rechecks cancellation/context immediately before dispatch and commit', async () => {
    const f = fixture(), plan = await f.start()
    f.prepared(plan.newCallId)
    await validateClaimAuthorReviewReplacement(f.tx, f.input.authorizationId)
    f.run.status = 'cancelled'
    await expect(validateClaimAuthorReviewReplacement(f.tx, f.input.authorizationId)).rejects.toThrow()
    await expect(completeAuthorReviewReplacement(f.tx, { authorizationId: f.input.authorizationId, newCallId: plan.newCallId,
      rawResponse: '{"findings":[]}', finishReason: 'stop', toolCalls: [], newUsageIds: ['newUsage'] })).rejects.toThrow()
    expect(f.tx.chapterQualityReport.create).not.toHaveBeenCalled()
  })
  it('rejects changed counters between authorization and claim, with zero claimed dispatches', async () => {
    const f = fixture()
    await authorizeAuthorReviewReplacement(f.tx, f.input)
    f.run.currentTurn++
    await expect(claimAuthorReviewReplacement(f.tx, f.input.authorizationId)).rejects.toThrow()
    expect(f.events.filter(row => row.type === 'review.replacement.claimed')).toHaveLength(0)
  })
  it.each(['missing-report', 'newer-report', 'report-failed', 'report-edited', 'unknown-usage', 'estimated-usage', 'partial-charge', 'missing-ledger', 'second-usage',
    'old-ledger-changed', 'frozen-price-changed', 'counter-reset', 'active-time-reset', 'started-time-reset', 'missing-claim', 'missing-observation', 'false-completion', 'foreign-owner', 'foreign-pending'])(
    'does not emit dependency proof for %s', async kind => {
      const f = fixture()
      await f.finish()
      if (kind === 'missing-report') f.reports.splice(0)
      if (kind === 'newer-report') f.reports.push({ ...f.reports[0], id: 'newer', createdAt: new Date(Date.now() + 1) })
      if (kind === 'report-failed') f.reports[0].status = 'failed'
      if (kind === 'report-edited') (f.reports[0].deterministicMetrics as Row).droppedFindings = 1
      if (kind === 'unknown-usage') f.usage[1].usageSource = 'unknown'
      if (kind === 'estimated-usage') f.usage[1].usageSource = 'estimated'
      if (kind === 'partial-charge') f.usage[1].creditChargeMilli = 0
      if (kind === 'missing-ledger') f.ledger.splice(0)
      if (kind === 'second-usage') f.usage.push({ ...f.usage[1], id: 'otherUsage' })
      if (kind === 'old-ledger-changed') f.usage[0].reservedCreditMilli = 0
      if (kind === 'frozen-price-changed') (f.usage[1].billingSnapshot as Row).multiplierBps = 13000
      if (kind === 'counter-reset') f.run.usage.checkpoint.resumeCount = 0
      if (kind === 'active-time-reset') f.run.usage.checkpoint.activeExecutionMs = 0
      if (kind === 'started-time-reset') f.run.usage.checkpoint.runStartedAt++
      if (kind === 'missing-claim') f.events.splice(f.events.findIndex(row => row.type === 'review.replacement.claimed'), 1)
      if (kind === 'missing-observation') f.events.splice(f.events.findIndex(row => row.type === 'review.replacement.observed'), 1)
      if (kind === 'false-completion') (f.events.find(row => row.type === 'review.replacement.completed')!.payload as Row).value = { complete: true }
      if (kind === 'foreign-owner') f.subject.userId = 'foreign'
      if (kind === 'foreign-pending') f.pending.callId = 'foreign'
      expect(await f.read()).toEqual([])
    })
  it.each(['{"findings":[', '{"findings":[null]}', '{"findings":[{"signal":"explanation_echo","severity":"warning","quote":"不存在","explanation":"意见","suggestion":"建议","confidence":0.9}]}'])(
    'stores actual failed response audit and never certifies incomplete findings: %s', async raw => {
      const f = fixture()
      await f.finish(raw)
      expect(f.reports[0].status).toBe('failed')
      expect(((f.reports[0].deterministicMetrics as Row).criticResponse as Row).rawResponse).toMatchObject({ content: JSON.stringify(raw), complete: true })
      expect(await f.read()).toEqual([])
    })
  it('retains more than 36 distinct opinions without truncation or automatic repairs', async () => {
    const f = fixture(), sources = buildQualityEvidenceSources({ userId: 'owner', novelId: 'novel', chapterId: 'chapter', chapterRevision: 4 }, String((mocks.bundle.chapter as Row).content))
    const raw = JSON.stringify({ findings: Array.from({ length: 45 }, (_, index) => ({ signal: 'explanation_echo', severity: 'warning', sourceId: sources.entries[0].id,
      explanation: `意见${index}`, suggestion: `建议${index}`, confidence: 0.9 })) })
    await f.finish(raw)
    const report = f.reports[0], findings = report.findings as Row[]
    expect(findings).toHaveLength(1) // Same source/span is grouped; every judgment remains in the text.
    expect(String(findings[0].explanation)).toContain('意见44')
    expect(String(findings[0].suggestion)).toContain('建议44')
    expect(report.status).toBe('needs_repair')
    expect(await f.read()).toHaveLength(1)
    expect((report.deterministicMetrics as Row).omittedFindings).toBe(0)
    expect(f.run.usage.totalTokens).toBe(600)
  })
  it('detects missing findings even when forged completion hashes match a truncated report', async () => {
    const f = fixture()
    await f.finish(JSON.stringify({ findings: [{ signal: 'explanation_echo', severity: 'warning', quote: '她关上门。', explanation: '意见', suggestion: '建议', confidence: 0.9 }] }))
    const report = f.reports[0]
    report.findings = []
    const event = f.events.find(row => row.type === 'review.replacement.completed')!, payload = event.payload as Row, value = payload.value as Row
    const fields = ['id', 'userId', 'novelId', 'runId', 'compilationId', 'chapterId', 'chapterRevision', 'mode', 'status', 'repairRound', 'criticVersion', 'deterministicMetrics', 'findings']
    value.reportHash = runtimeJson(Object.fromEntries(fields.map(key => [key, report[key]]))).hash
    payload.hash = runtimeJson(value).hash
    expect(await f.read()).toEqual([])
  })
  it.each(['foreign-actor', 'client-source', 'codex-reference', 'mismatched-nonce', 'invalid-nonce', 'fixed-surcharge', 'unbounded-cap'])(
    'rejects unverified author authority or an unquoted price: %s', async kind => {
      const f = fixture()
      if (kind === 'foreign-actor') f.input.authority.actorUserId = 'foreign'
      if (kind === 'client-source') f.input.authority.source = 'client' as never
      if (kind === 'codex-reference') f.input.authorizationId = f.input.humanAuthorizationRef = 'codex:call_test'
      if (kind === 'mismatched-nonce') f.input.authority.quoteNonce = '123e4567-e89b-42d3-a456-426614174001'
      if (kind === 'invalid-nonce') f.input.authority.quoteNonce = 'clientbool'
      if (kind === 'fixed-surcharge') f.input.maxCreditMilli = 20000
      if (kind === 'unbounded-cap') f.input.maxCreditMilli = Infinity
      await expect(authorizeAuthorReviewReplacement(f.tx, f.input)).rejects.toThrow()
      expect(f.tx.agentRunEvent.create).not.toHaveBeenCalled()
    })
  it('uses the current quote above 20 Credits without inventing a fixed fee or surcharge', async () => {
    const f = fixture()
    f.input.conservativeInputTokenCeiling = 200000
    f.input.maxCreditMilli = priceTokenEvidence(f.input.expected.price, 200000, f.input.maxOutputTokens, 0)
    expect(f.input.maxCreditMilli).toBe(24000)
    await f.finish()
    expect(await f.read()).toHaveLength(1)
    expect(f.usage[1].creditChargeMilli).toBe(12)
  })
  it('binds a new current r5 report to r5 while preserving the unresolved original r4 request', async () => {
    const f = fixture()
    ;(mocks.bundle.chapter as Row).revision = 5
    f.input.expected.currentRevision = 5
    f.input.expected.qualityContextHash = sha(JSON.stringify(mocks.bundle))
    f.input.expected.promptHash = sha(JSON.stringify({ system: 'system', content: JSON.stringify(mocks.bundle) }))
    await f.finish()
    expect(f.reports[0].chapterRevision).toBe(5)
    expect(await f.read()).toMatchObject([{ revision: 4, replacementReceipt: { currentRevision: 5, sourceCallId: 'oldCall', originalRequestOutcome: 'unknown_preserved' } }])
  })
  it.each(['no-result', 'failed', 'unknown-fee'])(
    'rejects a new nonce for an existing %s request, including when the manuscript changes', async kind => {
      const f = fixture()
      if (kind === 'no-result') await f.start()
      else await f.finish(kind === 'failed' ? '{"findings":[null]}' : '{"findings":[]}')
      if (kind === 'unknown-fee') {
        f.usage[1].usageSource = 'unknown'
        ;(mocks.bundle.chapter as Row).revision = 5
        f.input.expected.currentRevision = 5
        f.input.expected.qualityContextHash = sha(JSON.stringify(mocks.bundle))
        f.input.expected.promptHash = sha(JSON.stringify({ system: 'system', content: JSON.stringify(mocks.bundle) }))
      }
      f.input.authority.quoteNonce = '123e4567-e89b-42d3-a456-426614174001'
      f.input.authorizationId = f.input.humanAuthorizationRef = `author-review-replacement:owner:${f.input.authority.quoteNonce}`
      await expect(authorizeAuthorReviewReplacement(f.tx, f.input)).rejects.toThrow()
      expect(f.events.filter(row => row.type === 'review.replacement.claimed')).toHaveLength(1)
    })
  it('replays a real completed report for a new nonce instead of purchasing the same input again', async () => {
    const f = fixture()
    await f.finish()
    f.input.authority.quoteNonce = '123e4567-e89b-42d3-a456-426614174001'
    f.input.authorizationId = f.input.humanAuthorizationRef = `author-review-replacement:owner:${f.input.authority.quoteNonce}`
    const result = await authorizeAuthorReviewReplacement(f.tx, f.input)
    expect(result).toMatchObject({ status: 'replayed', replacementReceipt: { sourceReportId: 'report', originalRequestOutcome: 'unknown_preserved' } })
    expect(f.events.filter(row => row.type === 'review.replacement.authorized')).toHaveLength(1)
    expect(f.events.filter(row => row.type === 'review.replacement.claimed')).toHaveLength(1)
  })
  it('keeps completion proof readable inside a normal queued/running continuation without granting another request', async () => {
    const f = fixture()
    await f.finish()
    f.run.status = 'running'
    f.run.currentTurn++
    f.run.usage.totalTokens += 10
    expect(await f.read()).toHaveLength(1)
    await expect(claimAuthorReviewReplacement(f.tx, f.input.authorizationId)).rejects.toThrow()
  })
  it('polls only owned persisted stages and marks complete only with a real report and ledger', async () => {
    const f = fixture()
    await authorizeAuthorReviewReplacement(f.tx, f.input)
    expect(await readAuthorReviewReplacementStatus(f.tx, f.subject, f.input.authorizationId)).toMatchObject({ status: 'authorized', reportId: null })
    await claimAuthorReviewReplacement(f.tx, f.input.authorizationId)
    expect(await readAuthorReviewReplacementStatus(f.tx, f.subject, f.input.authorizationId)).toMatchObject({ status: 'claimed', reportId: null })
    await expect(readAuthorReviewReplacementStatus(f.tx, { ...f.subject, userId: 'foreign' }, f.input.authorizationId)).rejects.toThrow()
    const complete = fixture()
    await complete.finish()
    const result = await readAuthorReviewReplacementStatus(complete.tx, complete.subject, complete.input.authorizationId)
    expect(result).toMatchObject({ status: 'complete', reportId: 'report', replacementReceipt: { originalRequestOutcome: 'unknown_preserved' } })
    expect(Object.keys(result)).toEqual(['newCallId', 'reportId', 'status', 'replacementReceipt'])
    complete.usage[1].usageSource = 'unknown'
    expect(await readAuthorReviewReplacementStatus(complete.tx, complete.subject, complete.input.authorizationId)).toMatchObject({ status: 'waiting_usage', reportId: 'report' })
  })
  it('records actual transport failure after cancellation without changing the old unknown usage or granting dispatch', async () => {
    const f = fixture(), oldUsage = JSON.stringify(f.usage[0])
    await f.start()
    f.run.status = 'cancelled'
    const result = await failAuthorReviewReplacement(f.tx, f.input.authorizationId, { failureCode: 'AI_PROVIDER_TIMEOUT', usageIds: [] })
    expect(await failAuthorReviewReplacement(f.tx, f.input.authorizationId, { failureCode: 'AI_PROVIDER_TIMEOUT', usageIds: [] })).toEqual(result)
    expect(await readAuthorReviewReplacementStatus(f.tx, f.subject, f.input.authorizationId)).toMatchObject({ status: 'incomplete', reportId: null })
    expect(await f.read()).toEqual([])
    expect(JSON.stringify(f.usage[0])).toBe(oldUsage)
    expect(f.events.filter(row => row.type === 'review.replacement.failed')).toHaveLength(1)
    expect(f.tx.chapterQualityReport.create).not.toHaveBeenCalled()
    await expect(validateClaimAuthorReviewReplacement(f.tx, f.input.authorizationId)).rejects.toThrow()
    await expect(claimAuthorReviewReplacement(f.tx, f.input.authorizationId)).rejects.toThrow()
  })
  it('refuses authorEnded and preserves the explicit end even when the stored run status is failed', async () => {
    const f = fixture()
    Object.assign(f.run.usage, { authorEnded: { fulfilled: false } })
    await expect(authorizeAuthorReviewReplacement(f.tx, f.input)).rejects.toThrow()
    expect(f.tx.agentRunEvent.create).not.toHaveBeenCalled()
  })
  it('does not buy a failed review again by increasing the revision while keeping identical manuscript text', async () => {
    const f = fixture()
    await f.finish('{"findings":[null]}')
    ;(mocks.bundle.chapter as Row).revision = 5
    f.input.expected.currentRevision = 5
    f.input.expected.qualityContextHash = sha(JSON.stringify(mocks.bundle))
    f.input.expected.promptHash = sha(JSON.stringify({ system: 'system', content: JSON.stringify(mocks.bundle) }))
    f.input.authority.quoteNonce = '123e4567-e89b-42d3-a456-426614174001'
    f.input.authorizationId = f.input.humanAuthorizationRef = `author-review-replacement:owner:${f.input.authority.quoteNonce}`
    await expect(authorizeAuthorReviewReplacement(f.tx, f.input)).rejects.toThrow('同一正文')
    expect(f.events.filter(row => row.type === 'review.replacement.authorized')).toHaveLength(1)
  })
  it.each(['authorized_pending', 'prepared'])('permits only the bound unused %s usage row at the actual beforeDispatch boundary', async status => {
    const f = fixture(), plan = await f.start()
    const row = f.prepared(plan.newCallId, status), snapshot = JSON.stringify(row)
    expect(plan.conservativeInputTokenCeiling).toBe(35100)
    await validateClaimAuthorReviewReplacement(f.tx, f.input.authorizationId)
    expect(JSON.stringify(row)).toBe(snapshot)
    expect(f.tx.aiUsageLog.update).not.toHaveBeenCalled()
    expect(f.events.filter(row => row.type === 'review.replacement.claimed')).toHaveLength(1)
  })
  it.each(['missing', 'duplicate', 'owner', 'run', 'chapter', 'action', 'target', 'model', 'price', 'unknown', 'observed', 'response', 'dispatch-evidence', 'tokens', 'charge', 'ledger', 'reservation'])(
    'refuses an invalid beforeDispatch usage row: %s', async kind => {
      const f = fixture(), plan = await f.start(), row = f.prepared(plan.newCallId)
      if (kind === 'missing') f.usage.pop()
      if (kind === 'duplicate') f.usage.push({ ...row, id: 'duplicate' })
      if (kind === 'owner') row.userId = 'foreign'
      if (kind === 'run') row.agentRunId = 'foreign'
      if (kind === 'chapter') row.chapterId = 'foreign'
      if (kind === 'action') row.action = 'foreign'
      if (kind === 'target') row.targetId = 'foreign'
      if (kind === 'model') row.modelName = 'foreign'
      if (kind === 'price') row.billingSnapshot.multiplierBps = 13000
      if (kind === 'unknown') row.usageSource = 'unknown'
      if (kind === 'observed') row.billingStatus = 'observed'
      if (kind === 'response') row.billingEvidence.responseObserved = true
      if (kind === 'dispatch-evidence') Object.assign(row.billingEvidence, { dispatched: true })
      if (kind === 'tokens') Object.assign(row, { requestTokens: 100 })
      if (kind === 'charge') row.creditChargeMilli = 1
      if (kind === 'ledger') f.ledger.push({ idempotencyKey: 'usage:preparedUsage' })
      if (kind === 'reservation') row.reservedCreditMilli = f.input.maxCreditMilli + 1
      await expect(validateClaimAuthorReviewReplacement(f.tx, f.input.authorizationId)).rejects.toThrow()
      expect(await f.read()).toEqual([])
    })
  it('refuses any existing new-call usage before claim, including an otherwise valid prepared row', async () => {
    const f = fixture(), authorized = await authorizeAuthorReviewReplacement(f.tx, f.input)
    f.prepared(authorized.newCallId)
    await expect(claimAuthorReviewReplacement(f.tx, f.input.authorizationId)).rejects.toThrow('账目')
    expect(f.events.filter(row => row.type === 'review.replacement.claimed')).toHaveLength(0)
  })
  it('preserves an authentic completed receipt through queued/running model selection, configuration and tariff changes', async () => {
    const f = fixture()
    await f.finish()
    const original = await f.read()
    f.run.status = 'queued'
    f.run.modelTier = 'speed'
    f.run.reasoningEffort = 'low'
    mocks.runtime = { tier: 'speed', provider: 'another-provider', modelName: 'new-selected-model', multiplierBps: 17000, reasoningEffort: 'low' }
    mocks.price = { version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 17000 }
    vi.mocked(getModelTierRuntime).mockClear()
    vi.mocked(resolveTokenPrice).mockClear()
    expect(await f.read()).toEqual(original)
    f.run.status = 'running'
    f.run.currentTurn++
    f.run.usage.totalTokens += 10
    expect(await f.read()).toEqual(original)
    expect(getModelTierRuntime).not.toHaveBeenCalled()
    expect(resolveTokenPrice).not.toHaveBeenCalled()
    expect(await readAuthorReviewReplacementStatus(f.tx, f.subject, f.input.authorizationId)).toMatchObject({ status: 'complete' })
  })
  it.each(['selection', 'config', 'price'])('still fences current %s changes before dispatch and report commit', async kind => {
    const f = fixture(), plan = await f.start()
    f.prepared(plan.newCallId)
    if (kind === 'selection') f.run.modelTier = 'speed'
    if (kind === 'config') mocks.runtime.modelName = 'changed'
    if (kind === 'price') mocks.price = { ...mocks.price, multiplierBps: 13000 }
    await expect(validateClaimAuthorReviewReplacement(f.tx, f.input.authorizationId)).rejects.toThrow()
    await expect(completeAuthorReviewReplacement(f.tx, { authorizationId: f.input.authorizationId, newCallId: plan.newCallId,
      rawResponse: '{"findings":[]}', finishReason: 'stop', toolCalls: [], newUsageIds: ['preparedUsage'] })).rejects.toThrow()
    expect(f.tx.chapterQualityReport.create).not.toHaveBeenCalled()
  })
  it('normalizes the null-name default speed runtime exactly like generateTextCompletion without changing its provider or price', async () => {
    const f = fixture()
    Object.assign(f.run, { modelTier: 'speed', reasoningEffort: 'high' })
    mocks.runtime = { tier: 'speed', reasoningEffort: 'high', provider: 'deepseek', modelName: null, multiplierBps: 10000 }
    mocks.price = { version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 }
    f.input.expected.model = { tier: 'speed', customModelId: null, reasoningEffort: 'high', provider: 'deepseek', modelName: env.aiTextModel, multiplierBps: 10000 }
    f.input.expected.price = mocks.price as never
    f.input.maxCreditMilli = priceTokenEvidence(f.input.expected.price, f.input.conservativeInputTokenCeiling, f.input.maxOutputTokens, 0)
    const plan = await f.start(), row = f.prepared(plan.newCallId)
    Object.assign(row, { providerName: 'deepseek', modelName: env.aiTextModel, modelTier: 'speed', multiplierBps: 10000 })
    expect(plan.model).toEqual(f.input.expected.model)
    expect(plan.price).toEqual(f.input.expected.price)
    await validateClaimAuthorReviewReplacement(f.tx, f.input.authorizationId)
    const charge = priceTokenEvidence(plan.price, 100, 10)
    Object.assign(row, { usageSource: 'reported', billingStatus: 'settled', reservedCreditMilli: 0, requestTokens: 100, responseTokens: 10,
      creditChargeMilli: charge, billingEvidence: { responseObserved: true } })
    f.ledger.push({ idempotencyKey: `usage:${row.id}`, userId: 'owner', sourceType: 'model_tokens', kind: 'usage', referenceId: plan.newCallId,
      deltaMilli: -charge, requestTokens: 100, responseTokens: 10, modelTier: 'speed', multiplierBps: 10000, metadata: null })
    const received = { authorizationId: f.input.authorizationId, newCallId: plan.newCallId,
      rawResponse: '{"findings":[]}', finishReason: 'stop', toolCalls: [], newUsageIds: [row.id] }
    await observeAuthorReviewResponse(f.tx, received)
    await completeAuthorReviewReplacement(f.tx, received)
    expect(await f.read()).toHaveLength(1)
    expect(f.usage[0].reservedCreditMilli).toBe(18023)
    expect(mocks.runtime).toMatchObject({ tier: 'speed', provider: 'deepseek', modelName: null, multiplierBps: 10000 })
  })
  it.each(['body', 'context', 'model', 'cancelled', 'existing-report'])(
    'durably retains a late real response after %s changes without publishing a report or mutating any bill', async kind => {
      const f = fixture(), plan = await f.start(), row = f.prepared(plan.newCallId)
      Object.assign(row, { usageSource: 'reported', billingStatus: 'settled', requestTokens: 100, responseTokens: 10, creditChargeMilli: 12,
        reservedCreditMilli: 0, billingEvidence: { responseObserved: true } })
      f.ledger.push({ idempotencyKey: `usage:${row.id}`, userId: 'owner', sourceType: 'model_tokens', kind: 'usage', referenceId: plan.newCallId,
        deltaMilli: -12, requestTokens: 100, responseTokens: 10, modelTier: 'standard', multiplierBps: 12000, metadata: null })
      if (kind === 'body') (mocks.bundle.chapter as Row).content = 'changed manuscript during HTTP'
      if (kind === 'context') mocks.bundle.feedback = ['changed during HTTP']
      if (kind === 'model') f.run.modelTier = 'speed'
      if (kind === 'cancelled') f.run.status = 'cancelled'
      if (kind === 'existing-report') f.reports.push({ id: 'concurrent-report', chapterRevision: 4, createdAt: new Date() })
      const original = JSON.stringify({ usage: f.usage, ledger: f.ledger, run: f.run }), rawResponse = '{"findings":[]}\n\u0000late actual response'
      const received = { authorizationId: f.input.authorizationId, newCallId: plan.newCallId, rawResponse, finishReason: 'stop', toolCalls: [], newUsageIds: [row.id] }
      const observed = await observeAuthorReviewResponse(f.tx, received)
      expect(await observeAuthorReviewResponse(f.tx, received)).toEqual(observed)
      await expect(completeAuthorReviewReplacement(f.tx, received)).rejects.toThrow()
      await failAuthorReviewReplacement(f.tx, f.input.authorizationId, { failureCode: 'QUALITY_INPUT_STALE', usageIds: [row.id] })
      const audit = f.events.find(event => event.type === 'review.replacement.observed')!, payload = (audit.payload as Row).value as Row
      expect(payload.response).toMatchObject({ encoding: 'json-string', content: JSON.stringify(rawResponse), contentHash: sha(rawResponse),
        characterCount: rawResponse.length, finishReason: 'stop', toolCalls: [] })
      expect((f.events.find(event => event.type === 'review.replacement.failed')!.payload as Row).value).toMatchObject({ observationEventId: observed.observationEventId })
      expect(f.events.filter(event => event.type === 'review.replacement.observed')).toHaveLength(1)
      expect(JSON.stringify({ usage: f.usage, ledger: f.ledger, run: f.run })).toBe(original)
      expect(f.tx.chapterQualityReport.create).not.toHaveBeenCalled()
      expect(await f.read()).toEqual([])
      expect(await readAuthorReviewReplacementStatus(f.tx, f.subject, f.input.authorizationId)).toMatchObject({ status: 'incomplete' })
      await expect(validateClaimAuthorReviewReplacement(f.tx, f.input.authorizationId)).rejects.toThrow()
      await expect(claimAuthorReviewReplacement(f.tx, f.input.authorizationId)).rejects.toThrow()
      await expect(observeAuthorReviewResponse(f.tx, { ...received, rawResponse: 'substituted response' })).rejects.toThrow('不能替换')
    })
  it.each(['missing', 'foreign', 'duplicate', 'old', 'wrong-call', 'wrong-action', 'wrong-provider', 'wrong-model', 'wrong-tier', 'wrong-multiplier', 'wrong-price'])(
    'refuses response observation without exactly one authenticated new usage: %s', async kind => {
      const f = fixture(), plan = await f.start(), row = f.prepared(plan.newCallId)
      const received = { authorizationId: f.input.authorizationId, newCallId: plan.newCallId, rawResponse: '{"findings":[]}', finishReason: 'stop', toolCalls: [], newUsageIds: [row.id] }
      if (kind === 'missing') f.usage.pop()
      if (kind === 'foreign') row.userId = 'foreign'
      if (kind === 'duplicate') f.usage.push({ ...row, id: 'duplicate' })
      if (kind === 'old') received.newUsageIds = ['oldUsage']
      if (kind === 'wrong-call') received.newCallId = 'unrelated-call'
      if (kind === 'wrong-action') row.action = 'unrelated-action'
      if (kind === 'wrong-provider') row.providerName = 'unrelated-provider'
      if (kind === 'wrong-model') row.modelName = 'unrelated-model'
      if (kind === 'wrong-tier') row.modelTier = 'speed'
      if (kind === 'wrong-multiplier') row.multiplierBps = 10000
      if (kind === 'wrong-price') row.billingSnapshot = { version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 }
      await expect(observeAuthorReviewResponse(f.tx, received)).rejects.toThrow()
      expect(f.events.filter(event => event.type === 'review.replacement.observed')).toHaveLength(0)
    })
  it('does not infer known tokens or billing from a preserved raw response', async () => {
    const f = fixture(), plan = await f.start(), row = f.prepared(plan.newCallId)
    Object.assign(row, { usageSource: 'unknown', billingStatus: 'pending_usage', requestTokens: null, responseTokens: null, reservedCreditMilli: 120 })
    const before = JSON.stringify(row), received = { authorizationId: f.input.authorizationId, newCallId: plan.newCallId,
      rawResponse: '{"findings":[]}', finishReason: 'stop', toolCalls: [], newUsageIds: [row.id] }
    await observeAuthorReviewResponse(f.tx, received)
    await completeAuthorReviewReplacement(f.tx, received)
    expect(JSON.stringify(row)).toBe(before)
    expect(await f.read()).toEqual([])
    expect(await readAuthorReviewReplacementStatus(f.tx, f.subject, f.input.authorizationId)).toMatchObject({ status: 'waiting_usage' })
  })
})
