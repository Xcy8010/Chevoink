import { createHash, createHmac } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthorReviewReplacementAuthorization, AuthorReviewReplacementStatus as CoreStatus } from '../../api/lib/agent/author-review-replacement.js'
import { quoteAuthorReviewReplacement, submitAuthorReviewReplacement, getAuthorReviewReplacementStatus, getLatestAuthorReviewReplacementStatus } from '../../api/lib/agent/author-review-replacement-service.js'
import { beginTextRequest } from '../../api/lib/text-request-trace.js'
import { priceTokenEvidence } from '../../api/lib/billing/reservation-policy.js'
import { env } from '../../api/config/env.js'
import { DataAccessError } from '../../api/lib/prisma.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'

type Row = Record<string, unknown>
const mocks = vi.hoisted(() => ({
  tx: null as unknown as Prisma.TransactionClient, transaction: vi.fn(), runtime: vi.fn(), price: vi.fn(), generate: vi.fn(),
  providerRequest: vi.fn(),
  authorize: vi.fn(), claim: vi.fn(), validate: vi.fn(), observe: vi.fn(), complete: vi.fn(), fail: vi.fn(), status: vi.fn(),
  run: {} as Row, otherRuns: [] as Row[], bundle: {} as Row, original: {} as Row, usage: [] as Row[], events: [] as Row[], novel: {} as Row,
  update: vi.fn(), active: false, claimCommitted: false, knownFees: true,
  authorizations: new Map<string, AuthorReviewReplacementAuthorization>(), statuses: new Map<string, CoreStatus>(),
}))
vi.mock('../../api/lib/prisma.js', () => ({ DataAccessError: class extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message) } },
  prisma: { $transaction: mocks.transaction } }))
vi.mock('../../api/lib/credits.js', () => ({ getModelTierRuntime: mocks.runtime }))
vi.mock('../../api/lib/billing/resolve-token-price.js', () => ({ resolveTokenPrice: mocks.price }))
vi.mock('../../api/lib/ai-service.js', () => ({ generateTextCompletion: mocks.generate }))
vi.mock('../../api/lib/agent/active-runs.js', () => ({ getActiveRun: () => mocks.active ? {} : undefined, hasActiveRunInSession: () => mocks.active }))
vi.mock('../../api/lib/data/novel-write-lock.js', () => ({ lockNovelActiveScope: vi.fn(async () => {}) }))
vi.mock('../../api/lib/agent/manuscript-scope.js', () => ({ assertAgentManuscriptCurrent: vi.fn(async () => {}) }))
vi.mock('../../api/lib/agent/original-request.js', () => ({ readOriginalTaskRequest: vi.fn(async () => mocks.original), originalTaskRunIds: vi.fn(async () => ['run']) }))
vi.mock('../../api/lib/agent/humanity-quality.js', () => ({
  buildHumanityQualityContext: vi.fn(async () => mocks.bundle), qualityReviewContextHash: (bundle: unknown) => createHash('sha256').update(JSON.stringify(bundle)).digest('hex'),
  analyzeDeterministicQuality: () => ({ metrics: {}, findings: [] }),
}))
vi.mock('../../api/lib/agent/quality-evidence.js', () => ({ buildQualityEvidenceSources: () => ({ protocol: 6, context: 'full sources' }) }))
vi.mock('../../api/lib/agent/tools/humanity-quality-tools.js', () => ({ buildCriticSystem: () => '完整检查规则', buildCriticInput: () => JSON.stringify(mocks.bundle) }))
vi.mock('../../api/lib/agent/review-completion.js', () => ({ REVIEW_MAX_OUTPUT_TOKENS: 16384 }))
vi.mock('../../api/lib/agent/author-review-replacement.js', () => ({ authorizeAuthorReviewReplacement: mocks.authorize,
  claimAuthorReviewReplacement: mocks.claim, validateClaimAuthorReviewReplacement: mocks.validate,
  completeAuthorReviewReplacement: mocks.complete, observeAuthorReviewResponse: mocks.observe,
  failAuthorReviewReplacement: mocks.fail, readAuthorReviewReplacementStatus: mocks.status }))

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return (value as Row[]).some(filter => matches(row, filter))
    if (value && typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value)) {
      const filter = value as Row, current = row[key]
      if ('path' in filter) return (filter.path as string[]).reduce<unknown>((found, part) => (found as Row)?.[part], current) === filter.equals
      if ('in' in filter) return (filter.in as unknown[]).includes(current)
      if ('not' in filter) return current !== filter.not
      if ('isNot' in filter) return current == null || !matches(current as Row, filter.isNot as Row)
      if ('gte' in filter || 'lte' in filter) return (!(filter.gte instanceof Date) || current instanceof Date && current >= filter.gte)
        && (!(filter.lte instanceof Date) || current instanceof Date && current <= filter.lte)
    }
    return row[key] === value
  })
}
const findRows = (rows: Row[]) => vi.fn(async ({ where = {} }: { where?: Row } = {}) => rows.filter(row => matches(row, where)))
const snapshot = () => JSON.stringify({ run: mocks.run, usage: mocks.usage, events: mocks.events })
const secret = 'synthetic-author-review-secret-at-least-32-characters'
const prefix = 'chevoink-author-review-replacement-quote-v1'
const originalSigningSecret = env.authSessionSecret
function decode(token: string): Row { return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')) as Row }
function resign(value: Row) {
  const encoded = Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encoded}.${createHmac('sha256', secret).update(`${prefix}.${encoded}`).digest('hex')}`
}
async function settled(authorizationId: string) {
  let result: Awaited<ReturnType<typeof getAuthorReviewReplacementStatus>> | undefined
  await vi.waitFor(async () => {
    result = await getAuthorReviewReplacementStatus('owner', 'run', authorizationId)
    expect(result.state).not.toBe('running')
  })
  return result!
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.active = false; mocks.claimCommitted = false; mocks.knownFees = true; mocks.otherRuns = []; mocks.authorizations.clear(); mocks.statuses.clear()
  env.authSessionSecret = secret
  const pending = { compilationId: 'comp', chapterId: 'chapter', revision: 4, toolName: 'quality_analyze', callId: 'oldCall' }
  mocks.run = { id: 'run', userId: 'owner', novelId: 'novel', sessionId: 'session', engine: 'loop', status: 'failed', taskRootId: null, incomingChildGrant: null, createdAt: new Date(1000),
    runtimeProtocolVersion: 0, modelTier: 'standard', customModelId: null, reasoningEffort: 'medium', manuscriptRevision: 0, currentTurn: 7,
    startRequest: { prompt: '检查原作品，第五章必须完整。' }, taskSpec: { id: 'task' }, writingBindings: {},
    usage: { promptTokens: 500, completionTokens: 100, totalTokens: 600, checkpoint: { version: 2, controlPolicy: 'until_completion',
      origin: 'unknown_legacy', activeExecutionMs: 100, stagnantBatches: 0, runStartedAt: 1000, resumeCount: 2, compactionCount: 1,
      maxTurns: 7, tokenBudget: 500, writeProgress: 3, writeBaseline: 2, readProgress: 5, readBaseline: 4, progressSignatures: [],
      inheritedTokens: 123, inheritedTurns: 2, manualResumeCount: 0, reviewAttempts: ['oldAttempt'], pendingReviews: [pending] } } }
  mocks.novel = { id: 'novel', authorId: 'owner', manuscriptRevision: 0 }
  mocks.original = { prompt: '检查原作品，第五章必须完整。', taskId: 'task', sourceRunId: 'run', parentRunId: null,
    spec: { controlPolicy: 'until_completion', scope: { novelId: 'novel', writing: { kind: 'bounded', targets: [{ orderIndex: 5 }] } } } }
  mocks.bundle = { chapter: { id: 'chapter', revision: 4, orderIndex: 5, title: '第五章', content: '她关上门。完整正文首尾。' },
    compilation: { id: 'comp', runId: 'run', status: 'active', bridge: {}, sceneTasks: [] }, recentChapters: [], originalRequest: mocks.original.prompt }
  mocks.events = [{ id: 'call-event', runId: 'run', seq: 1, type: 'tool.call', createdAt: new Date(1000),
    payload: { callId: 'oldCall', toolName: 'quality_analyze', args: { chapterId: 'chapter', compilationId: 'comp' } } },
  { id: 'result-event', runId: 'run', seq: 2, type: 'tool.result', createdAt: new Date(3000), payload: { callId: 'oldCall', toolName: 'quality_analyze', ok: false } }]
  mocks.usage = [{ id: 'oldUsage', userId: 'owner', novelId: 'novel', chapterId: 'chapter', targetId: 'chapter', agentRunId: null,
    action: 'agent3HumanityCritic', createdAt: new Date(2000), usageSource: 'unknown', billingStatus: 'pending_usage', requestTokens: null,
    responseTokens: null, reservedCreditMilli: 18023, billingEvidence: { responseObserved: false } }]
  mocks.runtime.mockResolvedValue({ tier: 'standard', provider: 'Xiaomi', modelName: 'mimo-v2.6-flash', baseUrl: 'https://api.xiaomimimo.com/v1',
    apiKey: 'synthetic-key-never-persist', reasoningEffort: 'medium', reasoningEfforts: ['none', 'medium'], multiplierBps: 12000, contextWindowTokens: 128000 })
  mocks.price.mockResolvedValue({ version: 'credits-v1-exact', modelTier: 'standard', multiplierBps: 12000 })
  mocks.update.mockImplementation(async ({ data }: { data: Row }) => { Object.assign(mocks.run, data); return mocks.run })
  const tx = { $queryRaw: vi.fn(async () => [{ id: 'novel' }]),
    agentRun: { findFirst: vi.fn(async ({ where, orderBy }: { where: Row; orderBy?: Row }) => {
      const rows = [mocks.run, ...mocks.otherRuns].filter(row => matches(row, where))
      if (orderBy?.createdAt === 'desc') rows.sort((left, right) => Number(right.createdAt) - Number(left.createdAt))
      return rows[0] ?? null
    }), count: vi.fn(async ({ where }: { where: Row }) => [mocks.run, ...mocks.otherRuns].filter(row => matches(row, where)).length), update: mocks.update },
    novel: { findFirst: vi.fn(async ({ where }: { where: Row }) => matches(mocks.novel, where) ? mocks.novel : null) },
    agentGoalExecution: { findUnique: vi.fn(async () => null) }, aiUsageLog: { findMany: findRows(mocks.usage) },
    agentRunEvent: { findMany: findRows(mocks.events), findFirst: vi.fn(async ({ where, orderBy }: { where: Row; orderBy?: Row }) => {
      const rows = mocks.events.filter(row => matches(row, where))
      if (orderBy?.seq === 'desc') rows.sort((left, right) => Number(right.seq) - Number(left.seq))
      return rows[0] ?? null
    }) } }
  mocks.tx = tx as unknown as Prisma.TransactionClient
  mocks.transaction.mockImplementation(async (work: (client: Prisma.TransactionClient) => Promise<unknown>) => {
    const value = await work(mocks.tx)
    if (value && typeof value === 'object' && (value as Row).kind === 'claim') mocks.claimCommitted = true
    return value
  })
  mocks.authorize.mockImplementation(async (_tx: Prisma.TransactionClient, input: AuthorReviewReplacementAuthorization) => {
    if (mocks.authorizations.size) throw new DataAccessError(409, 'AUTHOR_REVIEW_REPLACEMENT_REFUSED', 'Original dependency already has a claim')
    mocks.authorizations.set(input.authorizationId, input)
    mocks.events.push({ id: 'authorization-event', runId: input.subject.runId, seq: 3, type: 'review.replacement.authorized', payload: { value: input } })
    mocks.statuses.set(input.authorizationId, { status: 'authorized', newCallId: 'newCall', reportId: null })
    return { status: 'authorized', authorizationEventId: 'authorization-event', newCallId: 'newCall' }
  })
  mocks.claim.mockImplementation(async (_tx: Prisma.TransactionClient, id: string) => {
    const input = mocks.authorizations.get(id)!
    if (mocks.statuses.get(id)!.status !== 'authorized') throw new Error('double claim')
    mocks.statuses.set(id, { status: 'claimed', newCallId: 'newCall', reportId: null })
    return { authorizationId: id, ...input.subject, newCallId: 'newCall', action: 'agent3HumanityAuthorReplacement', targetType: 'chapter', targetId: 'newCall',
      chapterId: input.pending.chapterId, model: input.expected.model, price: input.expected.price, system: '完整检查规则', content: JSON.stringify(mocks.bundle),
      maxOutputTokens: input.maxOutputTokens, maxCreditMilli: input.maxCreditMilli, conservativeInputTokenCeiling: input.conservativeInputTokenCeiling }
  })
  mocks.validate.mockImplementation(async () => {})
  mocks.observe.mockResolvedValue({ observationEventId: 'observed-event' })
  mocks.complete.mockImplementation(async (_tx: Prisma.TransactionClient, input: { authorizationId: string; rawResponse: string; finishReason: string | null }) => {
    mocks.statuses.set(input.authorizationId, { status: input.finishReason !== 'stop' ? 'incomplete' : mocks.knownFees ? 'complete' : 'waiting_usage', newCallId: 'newCall', reportId: 'report' })
    return { reportId: 'report' }
  })
  mocks.fail.mockImplementation(async (_tx: Prisma.TransactionClient, id: string) => { mocks.statuses.set(id, { status: 'incomplete', newCallId: 'newCall', reportId: null }) })
  mocks.status.mockImplementation(async (_tx: Prisma.TransactionClient, subject: { userId: string; runId: string }, id: string) => {
    const input = mocks.authorizations.get(id)
    if (!input || input.subject.userId !== subject.userId || input.subject.runId !== subject.runId) throw new DataAccessError(409, 'AUTHOR_REVIEW_REPLACEMENT_REFUSED', 'wrong actor')
    return mocks.statuses.get(id)
  })
  mocks.generate.mockImplementation(async (_system: string, _content: string, options: Parameters<typeof import('../../api/lib/ai-service.js').generateTextCompletion>[2]) => {
    expect(mocks.claimCommitted).toBe(true)
    const { record } = beginTextRequest('newUsage')
    await options.authorizedRequest!.beforeDispatch()
    mocks.providerRequest()
    options.onObservedCompletion!({ usageId: 'newUsage', content: '{"findings":[]}', finishReason: 'stop', toolCalls: [] })
    record.status = mocks.knownFees ? 'terminal' : 'unknown'; record.billingKnown = mocks.knownFees
    if (!mocks.knownFees) throw new DataAccessError(409, 'TEXT_REQUEST_USAGE_UNCONFIRMED', 'actual fees unknown')
    return '{"findings":[]}'
  })
})
afterEach(() => { env.authSessionSecret = originalSigningSecret; vi.restoreAllMocks() })

describe('authenticated author review quote and sole sender', () => {
  it('fails closed when the existing session signing secret is absent before authorization or provider calls', async () => {
    env.authSessionSecret = ''
    await expect(quoteAuthorReviewReplacement('owner', 'run')).rejects.toMatchObject({ status: 503, code: 'AUTHOR_REVIEW_QUOTE_UNAVAILABLE' })
    expect(mocks.authorize).not.toHaveBeenCalled(); expect(mocks.claim).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
  })
  it('quotes full current input and normal selected-model maximum without writes, key disclosure or provider calls', async () => {
    const before = snapshot(), quote = await quoteAuthorReviewReplacement('owner', 'run')
    const payload = decode(quote.quoteToken), input = payload.authorization as unknown as AuthorReviewReplacementAuthorization
    const ceiling = Buffer.byteLength(JSON.stringify([{ role: 'system', content: '完整检查规则' }, { role: 'user', content: JSON.stringify(mocks.bundle) }]), 'utf8') + 4096
    expect(quote.currentModel).toMatchObject({ modelTier: 'standard', modelName: 'mimo-v2.6-flash', multiplierBps: 12000 })
    expect(quote.maximumCreditMilli).toBe(priceTokenEvidence(input.expected.price, ceiling, 16384, 0))
    expect(input.conservativeInputTokenCeiling).toBe(ceiling)
    expect(quote.maximumCreditMilli).not.toBe(20000)
    expect(JSON.stringify(payload)).not.toContain('synthetic-key-never-persist')
    expect(JSON.stringify(payload)).not.toContain('完整正文首尾')
    expect(JSON.stringify(payload)).not.toContain('完整检查规则')
    expect(Date.parse(quote.expiresAt) - Date.now()).toBeLessThanOrEqual(300000)
    expect(snapshot()).toBe(before)
    expect(mocks.authorize).not.toHaveBeenCalled(); expect(mocks.claim).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.generate).not.toHaveBeenCalled()
  })
  it('uses the admitted speed runtime server-default model for quote identity and the sole actual dispatch without changing tier/provider/price', async () => {
    mocks.run.modelTier = 'speed'; mocks.run.reasoningEffort = 'high'
    mocks.runtime.mockResolvedValue({ tier: 'speed', provider: 'deepseek', modelName: null, baseUrl: null, apiKey: null,
      reasoningEffort: 'high', reasoningEfforts: ['low', 'high', 'max'], multiplierBps: 10000, contextWindowTokens: 128000 })
    mocks.price.mockResolvedValue({ version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 })
    const quote = await quoteAuthorReviewReplacement('owner', 'run')
    const input = decode(quote.quoteToken).authorization as unknown as AuthorReviewReplacementAuthorization
    expect(quote.currentModel).toMatchObject({ modelTier: 'speed', modelName: env.aiTextModel, multiplierBps: 10000, reasoningEffort: 'high' })
    expect(input.expected.model).toEqual({ tier: 'speed', customModelId: null, provider: 'deepseek', modelName: env.aiTextModel,
      reasoningEffort: 'high', multiplierBps: 10000 })
    expect(quote.maximumCreditMilli).toBe(priceTokenEvidence(input.expected.price, input.conservativeInputTokenCeiling, 16384, 0))
    await submitAuthorReviewReplacement('owner', 'run', quote.quoteToken)
    expect((await settled(quote.authorizationId)).state).toBe('complete')
    expect(mocks.generate).toHaveBeenCalledOnce(); expect(mocks.providerRequest).toHaveBeenCalledOnce()
    expect(mocks.generate.mock.calls[0][2]).toMatchObject({ modelRuntime: { tier: 'speed', provider: 'deepseek', modelName: null, multiplierBps: 10000 },
      authorizedRequest: { price: { version: 'credits-v1-exact', modelTier: 'speed', multiplierBps: 10000 } } })
  })
  it.each(['quote', 'submit', 'dispatch'] as const)('refuses an older run at %s even when the newer same-session main run is already complete', async phase => {
    const quote = phase === 'quote' ? undefined : await quoteAuthorReviewReplacement('owner', 'run')
    const newer = { ...mocks.run, id: 'newer', createdAt: new Date(4000), status: 'completed' }
    if (phase === 'dispatch') {
      const generate = mocks.generate.getMockImplementation()!
      mocks.generate.mockImplementation(async (...args: unknown[]) => { mocks.otherRuns.push(newer); return generate(...args) })
      await submitAuthorReviewReplacement('owner', 'run', quote!.quoteToken)
      expect((await settled(quote!.authorizationId)).state).toBe('incomplete')
      expect(mocks.fail.mock.calls[0][2].failureCode).toBe('STALE_RESUME_TARGET')
      expect(mocks.complete).not.toHaveBeenCalled()
    } else {
      mocks.otherRuns.push(newer)
      await expect(phase === 'quote' ? quoteAuthorReviewReplacement('owner', 'run') : submitAuthorReviewReplacement('owner', 'run', quote!.quoteToken))
        .rejects.toMatchObject({ status: 409, code: 'STALE_RESUME_TARGET' })
      expect(mocks.authorize).not.toHaveBeenCalled(); expect(mocks.claim).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled()
    }
    expect(mocks.providerRequest).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.run.status).toBe('failed'); expect(mocks.usage[0].reservedCreditMilli).toBe(18023)
  })
  it('uses the same main-run filter as Continue so a newer private inline child does not make the original task stale', async () => {
    mocks.otherRuns.push({ ...mocks.run, id: 'inline-child', createdAt: new Date(4000), status: 'completed', incomingChildGrant: { kind: 'inline' } })
    const quote = await quoteAuthorReviewReplacement('owner', 'run')
    await submitAuthorReviewReplacement('owner', 'run', quote.quoteToken)
    expect((await settled(quote.authorizationId)).state).toBe('complete')
    expect(mocks.providerRequest).toHaveBeenCalledOnce()
  })
  it.each(['tampered', 'malformed', 'oversized', 'expired', 'owner', 'run', 'purpose'] as const)('%s quote is rejected before authorization, claim or provider', async kind => {
    const quote = await quoteAuthorReviewReplacement('owner', 'run'), before = snapshot()
    let token = quote.quoteToken
    if (kind === 'tampered') token = 'A' + token.slice(1)
    if (kind === 'malformed') token = 'invalid.signature'
    if (kind === 'oversized') token = 'x'.repeat(20000)
    if (kind === 'expired') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300001)
    if (kind === 'purpose') { const payload = decode(token); payload.purpose = 'auth-session'; token = resign(payload) }
    await expect(submitAuthorReviewReplacement(kind === 'owner' ? 'other' : 'owner', kind === 'run' ? 'other' : 'run', token)).rejects.toBeDefined()
    expect(snapshot()).toBe(before)
    expect(mocks.authorize).not.toHaveBeenCalled(); expect(mocks.claim).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.generate).not.toHaveBeenCalled()
  })
  it.each(['body', 'context', 'price', 'multiplier', 'provider', 'route', 'run-model', 'task', 'original-usage', 'old-call', 'pending', 'cancelled', 'active', 'manuscript'] as const)(
    '%s drift invalidates the signed quote without authorizing or sending', async kind => {
    const quote = await quoteAuthorReviewReplacement('owner', 'run')
    if (kind === 'body') (mocks.bundle.chapter as Row).content = '正文已经改变。'
    if (kind === 'context') mocks.bundle.originalRequest = '另一个作者上下文'
    if (kind === 'price') mocks.price.mockResolvedValue({ version: 'credits-v1-exact', modelTier: 'standard', multiplierBps: 15000 })
    if (kind === 'multiplier') mocks.runtime.mockResolvedValue({ ...(await mocks.runtime()), multiplierBps: 15000 })
    if (kind === 'provider') mocks.runtime.mockResolvedValue({ ...(await mocks.runtime()), provider: 'different-provider' })
    if (kind === 'route') mocks.runtime.mockResolvedValue({ ...(await mocks.runtime()), baseUrl: 'https://different-route.example/v1' })
    if (kind === 'run-model') mocks.run.modelTier = 'ultimate'
    if (kind === 'task') mocks.original.taskId = 'different-task'
    if (kind === 'original-usage') mocks.usage[0].reservedCreditMilli = 18024
    if (kind === 'old-call') (mocks.events[0].payload as Row).args = { chapterId: 'other' }
    if (kind === 'pending') ((mocks.run.usage as Row).checkpoint as Row).pendingReviews = []
    if (kind === 'cancelled') mocks.run.status = 'cancelled'
    if (kind === 'active') mocks.active = true
    if (kind === 'manuscript') mocks.novel.manuscriptRevision = 1
    const before = snapshot()
    if (kind === 'manuscript') vi.mocked((await import('../../api/lib/agent/manuscript-scope.js')).assertAgentManuscriptCurrent).mockRejectedValueOnce(new Error('manuscript changed'))
    await expect(submitAuthorReviewReplacement('owner', 'run', quote.quoteToken)).rejects.toBeDefined()
    expect(snapshot()).toBe(before)
    expect(mocks.authorize).not.toHaveBeenCalled(); expect(mocks.claim).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.generate).not.toHaveBeenCalled()
  })
  it('commits one claim and returns promptly while a concurrent duplicate reuses status and one current-model sender', async () => {
    const quote = await quoteAuthorReviewReplacement('owner', 'run'), originalUsage = JSON.stringify(mocks.usage), originalRun = JSON.stringify(mocks.run)
    let release: (() => void) | undefined
    const blocked = new Promise<void>(resolve => { release = resolve })
    const generate = mocks.generate.getMockImplementation()!
    mocks.generate.mockImplementation(async (...args: unknown[]) => { await blocked; return generate(...args) })
    const [first, second] = await Promise.all([submitAuthorReviewReplacement('owner', 'run', quote.quoteToken), submitAuthorReviewReplacement('owner', 'run', quote.quoteToken)])
    expect(first.state).toBe('running'); expect(second.state).toBe('running')
    expect(mocks.authorize).toHaveBeenCalledOnce(); expect(mocks.claim).toHaveBeenCalledOnce()
    release!()
    const done = await settled(quote.authorizationId)
    expect(done).toMatchObject({ state: 'complete', reportId: 'report' })
    expect(mocks.generate).toHaveBeenCalledOnce()
    expect(mocks.generate.mock.calls[0][2]).toMatchObject({ action: 'agent3HumanityAuthorReplacement', userId: 'owner', novelId: 'novel',
      agentRunId: 'run', chapterId: 'chapter', targetId: 'newCall', explicitModelSelection: true, maxOutputTokens: 16384,
      modelRuntime: { tier: 'standard', modelName: 'mimo-v2.6-flash', multiplierBps: 12000 },
      authorizedRequest: { maxCreditMilli: quote.maximumCreditMilli } })
    const replay = await submitAuthorReviewReplacement('owner', 'run', quote.quoteToken)
    expect(replay.state).toBe('complete'); expect(mocks.claim).toHaveBeenCalledOnce(); expect(mocks.generate).toHaveBeenCalledOnce()
    expect(JSON.stringify(mocks.usage)).toBe(originalUsage); expect(JSON.stringify(mocks.run)).toBe(originalRun)
  })
  it('binds an explicit new UI model in the same transaction and retains original counters/status', async () => {
    mocks.runtime.mockResolvedValue({ ...(await mocks.runtime()), tier: 'builtin_1234567890abcdef', multiplierBps: 17500 })
    mocks.price.mockResolvedValue({ version: 'credits-v1-exact', modelTier: 'builtin_1234567890abcdef', multiplierBps: 17500 })
    const beforeUsage = JSON.stringify(mocks.run.usage), quote = await quoteAuthorReviewReplacement('owner', 'run', { modelTier: 'builtin_1234567890abcdef' })
    await submitAuthorReviewReplacement('owner', 'run', quote.quoteToken)
    await settled(quote.authorizationId)
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({ where: { id: 'run' }, data: { modelTier: 'builtin_1234567890abcdef', customModelId: null, reasoningEffort: 'medium' } })
    expect(mocks.run.status).toBe('failed'); expect(mocks.run.currentTurn).toBe(7); expect(JSON.stringify(mocks.run.usage)).toBe(beforeUsage)
    expect(mocks.authorize.mock.calls[0][1].expected.model).toMatchObject({ tier: 'builtin_1234567890abcdef', multiplierBps: 17500 })
  })
  it('keeps actual raw report when fee confirmation fails and polling never sends or settles another request', async () => {
    mocks.knownFees = false
    const quote = await quoteAuthorReviewReplacement('owner', 'run')
    const secondQuote = await quoteAuthorReviewReplacement('owner', 'run')
    await submitAuthorReviewReplacement('owner', 'run', quote.quoteToken)
    expect((await settled(quote.authorizationId)).state).toBe('waiting_confirmation')
    expect(mocks.complete).toHaveBeenCalledOnce()
    expect(mocks.complete.mock.calls[0][1]).toMatchObject({ rawResponse: '{"findings":[]}', finishReason: 'stop', newUsageIds: ['newUsage'] })
    expect(mocks.fail).not.toHaveBeenCalled()
    for (let index = 0; index < 3; index++) expect((await getAuthorReviewReplacementStatus('owner', 'run', quote.authorizationId)).state).toBe('waiting_confirmation')
    await submitAuthorReviewReplacement('owner', 'run', quote.quoteToken)
    expect(mocks.generate).toHaveBeenCalledOnce(); expect(mocks.claim).toHaveBeenCalledOnce()
    await expect(quoteAuthorReviewReplacement('owner', 'run')).rejects.toBeDefined()
    await expect(submitAuthorReviewReplacement('owner', 'run', secondQuote.quoteToken)).rejects.toBeDefined()
    expect(mocks.generate).toHaveBeenCalledOnce()
  })
  it.each(['body', 'context', 'model', 'cancel', 'existing-report'])('commits the actual observation before a late %s rejection without buying another request', async scenario => {
    mocks.complete.mockRejectedValue(new DataAccessError(409, 'AUTHOR_REVIEW_REPLACEMENT_REFUSED', `late ${scenario}`))
    const quote = await quoteAuthorReviewReplacement('owner', 'run')
    await submitAuthorReviewReplacement('owner', 'run', quote.quoteToken)
    expect((await settled(quote.authorizationId)).state).toBe('incomplete')
    expect(mocks.observe).toHaveBeenCalledOnce()
    expect(mocks.observe.mock.calls[0][1]).toMatchObject({ authorizationId: quote.authorizationId,
      newCallId: 'newCall', rawResponse: '{"findings":[]}', finishReason: 'stop', toolCalls: [], newUsageIds: ['newUsage'] })
    expect(mocks.observe.mock.invocationCallOrder[0]).toBeLessThan(mocks.complete.mock.invocationCallOrder[0])
    expect(mocks.fail).toHaveBeenCalledExactlyOnceWith(mocks.tx, quote.authorizationId, {
      failureCode: 'AUTHOR_REVIEW_REPLACEMENT_REFUSED', usageIds: ['newUsage'],
    })
    await submitAuthorReviewReplacement('owner', 'run', quote.quoteToken)
    expect(mocks.providerRequest).toHaveBeenCalledOnce(); expect(mocks.generate).toHaveBeenCalledOnce()
  })
  it('an unknown report transaction outcome retains the independently committed observation without fabricating failure or redispatch', async () => {
    mocks.complete.mockRejectedValue(new Error('connection closed with unknown commit outcome'))
    const quote = await quoteAuthorReviewReplacement('owner', 'run')
    await submitAuthorReviewReplacement('owner', 'run', quote.quoteToken)
    expect((await settled(quote.authorizationId)).state).toBe('waiting_confirmation')
    expect(mocks.observe).toHaveBeenCalledOnce(); expect(mocks.fail).not.toHaveBeenCalled()
    await submitAuthorReviewReplacement('owner', 'run', quote.quoteToken)
    expect(mocks.generate).toHaveBeenCalledOnce()
  })
  it('retains actual length metadata as an incomplete report and never repairs or replays', async () => {
    mocks.generate.mockImplementation(async (_system: string, _content: string, options: Parameters<typeof import('../../api/lib/ai-service.js').generateTextCompletion>[2]) => {
      const { record } = beginTextRequest('newUsage')
      await options.authorizedRequest!.beforeDispatch()
      options.onObservedCompletion!({ usageId: 'newUsage', content: '{"findings":[]}', finishReason: 'length', toolCalls: [] })
      record.status = 'terminal'; record.billingKnown = true
      throw new DataAccessError(502, 'AI_PROVIDER_OUTPUT_LIMIT', 'actual output cap')
    })
    const quote = await quoteAuthorReviewReplacement('owner', 'run')
    await submitAuthorReviewReplacement('owner', 'run', quote.quoteToken)
    expect((await settled(quote.authorizationId)).state).toBe('incomplete')
    expect(mocks.complete.mock.calls[0][1].finishReason).toBe('length')
    await submitAuthorReviewReplacement('owner', 'run', quote.quoteToken)
    expect(mocks.generate).toHaveBeenCalledOnce(); expect(mocks.claim).toHaveBeenCalledOnce()
  })
  it('records one actual failure and leaves status reads and duplicate POST unable to dispatch again', async () => {
    mocks.generate.mockImplementation(async () => { beginTextRequest('newUsage'); throw new DataAccessError(502, 'AI_PROVIDER_TRANSPORT', 'actual transport failed') })
    const quote = await quoteAuthorReviewReplacement('owner', 'run')
    await submitAuthorReviewReplacement('owner', 'run', quote.quoteToken)
    expect((await settled(quote.authorizationId)).state).toBe('incomplete')
    expect(mocks.fail.mock.calls[0]).toEqual([mocks.tx, quote.authorizationId, { failureCode: 'AI_PROVIDER_TRANSPORT', usageIds: ['newUsage'] }])
    expect(mocks.complete).not.toHaveBeenCalled()
    await submitAuthorReviewReplacement('owner', 'run', quote.quoteToken)
    expect(mocks.generate).toHaveBeenCalledOnce(); expect(mocks.claim).toHaveBeenCalledOnce()
  })
  it('does not launch an already claimed operation after process-local sender state is gone', async () => {
    const quote = await quoteAuthorReviewReplacement('owner', 'run')
    const input = decode(quote.quoteToken).authorization as unknown as AuthorReviewReplacementAuthorization
    mocks.authorizations.set(input.authorizationId, input)
    mocks.statuses.set(input.authorizationId, { status: 'claimed', newCallId: 'newCall', reportId: null })
    mocks.events.push({ runId: 'run', type: 'review.replacement.authorized', payload: { value: input } })
    expect((await getAuthorReviewReplacementStatus('owner', 'run', input.authorizationId)).state).toBe('waiting_confirmation')
    expect(await getLatestAuthorReviewReplacementStatus('owner', 'run')).toMatchObject({ authorizationId: input.authorizationId, state: 'waiting_confirmation' })
    expect((await submitAuthorReviewReplacement('owner', 'run', quote.quoteToken)).state).toBe('waiting_confirmation')
    expect(mocks.claim).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled()
  })
  it('returns no latest status for an owned run without an authorization and denies another actor', async () => {
    expect(await getLatestAuthorReviewReplacementStatus('owner', 'run')).toBeNull()
    await expect(getLatestAuthorReviewReplacementStatus('other', 'run')).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' })
    expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.authorize).not.toHaveBeenCalled()
  })
  it('returns definitive not-found only before any authorization/claim, while corrupted claimed evidence cannot invite retry', async () => {
    const quote = await quoteAuthorReviewReplacement('owner', 'run')
    await expect(getAuthorReviewReplacementStatus('owner', 'run', quote.authorizationId)).rejects.toMatchObject({ status: 404, code: 'REVIEW_REPLACEMENT_NOT_FOUND' })
    const id = `ar${createHash('sha256').update(`claim:${quote.authorizationId}`).digest('hex').slice(0, 60)}`
    mocks.events.push({ id, runId: 'run', type: 'review.replacement.claimed', payload: {} })
    await expect(getAuthorReviewReplacementStatus('owner', 'run', quote.authorizationId)).rejects.toMatchObject({ status: 409, code: 'AUTHOR_REVIEW_REPLACEMENT_REFUSED' })
    expect(mocks.providerRequest).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled()
  })
  it('revalidates the current route at the sole dispatch boundary and preserves an unstarted failure without HTTP', async () => {
    const generate = mocks.generate.getMockImplementation()!
    mocks.generate.mockImplementation(async (...args: unknown[]) => {
      mocks.runtime.mockResolvedValue({ ...(await mocks.runtime()), baseUrl: 'https://changed-at-dispatch.example/v1' })
      return generate(...args)
    })
    const quote = await quoteAuthorReviewReplacement('owner', 'run')
    await submitAuthorReviewReplacement('owner', 'run', quote.quoteToken)
    expect((await settled(quote.authorizationId)).state).toBe('incomplete')
    expect(mocks.generate).toHaveBeenCalledOnce(); expect(mocks.providerRequest).not.toHaveBeenCalled()
    expect(mocks.complete).not.toHaveBeenCalled(); expect(mocks.fail).toHaveBeenCalledOnce()
  })
  it('restores the latest authorization rather than concealing a newer pending check with an older complete result', async () => {
    const quote = await quoteAuthorReviewReplacement('owner', 'run'), first = decode(quote.quoteToken).authorization as unknown as AuthorReviewReplacementAuthorization
    const second = structuredClone(first), nonce = '123e4567-e89b-42d3-a456-426614174000'
    second.authority.quoteNonce = nonce; second.authorizationId = `author-review-replacement:owner:${nonce}`; second.humanAuthorizationRef = second.authorizationId
    mocks.authorizations.set(first.authorizationId, first); mocks.authorizations.set(second.authorizationId, second)
    mocks.statuses.set(first.authorizationId, { status: 'complete', newCallId: 'firstCall', reportId: 'firstReport' })
    mocks.statuses.set(second.authorizationId, { status: 'claimed', newCallId: 'secondCall', reportId: null })
    mocks.events.push({ runId: 'run', seq: 3, type: 'review.replacement.authorized', payload: { value: first } },
      { runId: 'run', seq: 4, type: 'review.replacement.authorized', payload: { value: second } })
    expect(await getLatestAuthorReviewReplacementStatus('owner', 'run')).toMatchObject({ authorizationId: second.authorizationId, state: 'waiting_confirmation' })
    expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.claim).not.toHaveBeenCalled()
  })
  it('rejects cross-owner status access and refuses client permission flags in a quote request', async () => {
    const quote = await quoteAuthorReviewReplacement('owner', 'run')
    await expect(getAuthorReviewReplacementStatus('other', 'run', quote.authorizationId)).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' })
    await expect(quoteAuthorReviewReplacement('owner', 'run', { approved: true } as never)).rejects.toBeDefined()
    expect(mocks.authorize).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled()
  })
  it('keeps signed quote fingerprints canonical and independent of raw credentials', async () => {
    const quote = await quoteAuthorReviewReplacement('owner', 'run'), payload = decode(quote.quoteToken)
    const binding = payload.binding as Row
    expect(Object.values(binding)).toHaveLength(5)
    for (const digest of Object.values(binding)) expect(digest).toMatch(/^[a-f0-9]{64}$/u)
    expect(runtimeJson(payload).hash).toMatch(/^[a-f0-9]{64}$/u)
  })
})
