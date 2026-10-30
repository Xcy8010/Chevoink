import { createHash, randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import { available, fixture as durableFixture } from '../support/agent-durable-runtime-fixture.js'
import { prisma } from '../../api/lib/prisma.js'
import * as credits from '../../api/lib/credits.js'
import * as prices from '../../api/lib/billing/resolve-token-price.js'
import { FALLBACK_USAGE_POLICY, priceTokenEvidence } from '../../api/lib/billing/reservation-policy.js'
import { authorizeAuthorReviewReplacement, claimAuthorReviewReplacement, completeAuthorReviewReplacement,
  readAuthorReviewReplacements, validateClaimAuthorReviewReplacement, type AuthorReviewReplacementAuthorization } from '../../api/lib/agent/author-review-replacement.js'
import { observeAuthorReviewResponse, failAuthorReviewReplacement, readAuthorReviewReplacementStatus } from '../../api/lib/agent/author-review-replacement.js'
import { analyzeDeterministicQuality, buildHumanityQualityContext, qualityReviewContextHash } from '../../api/lib/agent/humanity-quality.js'
import { buildCriticInput, buildCriticSystem } from '../../api/lib/agent/tools/humanity-quality-tools.js'
import { buildQualityEvidenceSources } from '../../api/lib/agent/quality-evidence.js'
import { readReviewReceiptWait } from '../../api/lib/agent/review-resume-readiness.js'
import { generateTextCompletion } from '../../api/lib/ai-service.js'
import { runtimeJson } from '../../api/lib/agent/runtime-common.js'
import { createTextRequestTrace, withTextRequestTrace } from '../../api/lib/text-request-trace.js'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
type F = Parameters<Parameters<typeof durableFixture>[0]>[0]
const fixture: typeof durableFixture = (work, ...rest) => durableFixture(async f => {
  try { await work(f) } finally {
    await prisma.creditLedgerEntry.deleteMany({ where: { userId: f.userId } })
    await prisma.aiUsageLog.deleteMany({ where: { userId: f.userId } })
    await prisma.creditAccount.deleteMany({ where: { userId: f.userId } })
  }
}, ...rest)

async function prepare(f: F) {
  const runtime = { tier: 'standard' as const, provider: 'Xiaomi', modelName: 'mimo-v2.6-flash', baseUrl: 'https://provider.invalid/v1', apiKey: 'fixture',
    multiplierBps: 12000, reasoningEffort: 'medium' as const, reasoningEfforts: ['none', 'medium'] as Array<'none' | 'medium'>,
    reasoningParameterMode: 'native' as const, thinkingEnabled: false, visionEnabled: false, contextWindowTokens: null }
  vi.spyOn(credits, 'getModelTierRuntime').mockResolvedValue(runtime)
  const price = { version: 'credits-v1-exact' as const, modelTier: runtime.tier, multiplierBps: runtime.multiplierBps }
  vi.spyOn(prices, 'resolveTokenPrice').mockResolvedValue(price)
  await prisma.agentRun.update({ where: { id: f.runId }, data: { taskRootId: null, runtimeProtocolVersion: 0, status: 'failed',
    modelTier: 'standard', reasoningEffort: 'medium' } })
  const compilation = await prisma.storyCompilation.create({ data: { userId: f.userId, novelId: f.novelId, runId: f.runId,
    chapterId: f.chapterId, targetOrderIndex: 1, mode: 'premium', sourcePromptHash: sha('fixture'), preparedContext: {} } })
  const pending = { toolName: 'quality_analyze' as const, callId: `old_${randomUUID()}`, chapterId: f.chapterId, revision: 1, compilationId: compilation.id }
  const first = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 1, type: 'tool.call', payload: { callId: pending.callId,
    toolName: 'quality_analyze', args: { chapterId: f.chapterId, compilationId: compilation.id } } } })
  const oldUsage = await prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, chapterId: f.chapterId, targetType: 'chapter', targetId: f.chapterId,
    providerType: 'text', providerMode: 'platform', providerName: 'legacy-provider', modelName: 'legacy-model', action: 'agent3HumanityCritic',
    requestTokens: null, responseTokens: null, usageSource: 'unknown', billingStatus: 'pending_usage', reservedCreditMilli: 18023,
    billingSnapshot: { version: 'credits-v1-exact', modelTier: 'standard', multiplierBps: 12000 }, billingEvidence: { responseObserved: false }, durationMs: 0 } })
  const result = await prisma.agentRunEvent.create({ data: { runId: f.runId, seq: 2, type: 'tool.result', payload: {
    callId: pending.callId, toolName: 'quality_analyze', ok: false, failureCode: 'AI_PROVIDER_ERROR' } } })
  expect(oldUsage.createdAt >= first.createdAt && oldUsage.createdAt <= result.createdAt).toBe(true)
  const usage = { promptTokens: 500, completionTokens: 100, totalTokens: 600, checkpoint: { version: 2, controlPolicy: 'until_completion', origin: 'unknown_legacy',
    activeExecutionMs: 1000, stagnantBatches: 0, runStartedAt: Date.now(), resumeCount: 1, compactionCount: 1, maxTurns: 3, tokenBudget: 500,
    writeProgress: 1, writeBaseline: 0, readProgress: 2, readBaseline: 1, progressSignatures: [], reviewAttempts: ['original-attempt'],
    pendingReviews: [pending], inheritedTokens: 500, inheritedTurns: 1, manualResumeCount: 0 } }
  await prisma.agentRun.update({ where: { id: f.runId }, data: { currentTurn: 3, usage } })
  await prisma.creditAccount.create({ data: { userId: f.userId, dailyAllowanceMilli: 100000, periodStartedAt: new Date(), periodEndsAt: new Date(Date.now() + 86400000) } })
  const bundle = await buildHumanityQualityContext(f.userId, f.novelId, f.chapterId, f.runId)
  const deterministic = analyzeDeterministicQuality(bundle.chapter.content, bundle.recentChapters.map(row => row.content))
  const sources = buildQualityEvidenceSources({ userId: f.userId, novelId: f.novelId, chapterId: f.chapterId, chapterRevision: 1 }, bundle.chapter.content)
  const system = buildCriticSystem('balanced'), content = buildCriticInput(bundle, deterministic.metrics, sources)
  const quoteNonce = randomUUID(), authorizationId = `author-review-replacement:${f.userId}:${quoteNonce}`
  const input: AuthorReviewReplacementAuthorization = { authorizationId, humanAuthorizationRef: authorizationId,
    authority: { source: 'authenticated_author_action', actorUserId: f.userId, quoteNonce },
    subject: { userId: f.userId, novelId: f.novelId, runId: f.runId }, taskId: f.spec.id, pending, originalUsageIds: [oldUsage.id],
    expected: { currentRevision: 1, currentContentHash: sha(bundle.chapter.content), qualityContextHash: qualityReviewContextHash(bundle), promptHash: sha(JSON.stringify({ system, content })),
      model: { tier: runtime.tier, customModelId: null, reasoningEffort: runtime.reasoningEffort, provider: runtime.provider, modelName: runtime.modelName, multiplierBps: runtime.multiplierBps }, price },
    conservativeInputTokenCeiling: 35100, maxOutputTokens: 16384, maxModelRequests: 1, maxCreditMilli: priceTokenEvidence(price, 35100, 16384, 0) }
  const authorize = () => prisma.$transaction(tx => authorizeAuthorReviewReplacement(tx, input))
  const claim = () => prisma.$transaction(tx => claimAuthorReviewReplacement(tx, authorizationId))
  const read = () => prisma.$transaction(tx => readAuthorReviewReplacements(tx, input.subject, [pending]))
  const wait = () => prisma.$transaction(async tx => readReviewReceiptWait(tx, await tx.agentRun.findFirstOrThrow({
    where: { id: f.runId, userId: f.userId, novelId: f.novelId },
  })))
  async function preparedUsage(newCallId: string) {
    return prisma.aiUsageLog.create({ data: { userId: f.userId, novelId: f.novelId, chapterId: f.chapterId, agentRunId: f.runId,
      targetType: 'chapter', targetId: newCallId, providerType: 'text', providerMode: 'platform', providerName: runtime.provider, modelName: runtime.modelName,
      modelTier: runtime.tier, multiplierBps: runtime.multiplierBps, action: 'agent3HumanityAuthorReplacement', billingSnapshot: price,
      usageSource: 'prepared', billingStatus: 'authorized_pending', reservedCreditMilli: 0,
      billingEvidence: { policy: FALLBACK_USAGE_POLICY, inputEstimate: 1000, outputEstimate: 0, responseObserved: false }, durationMs: 0 } })
  }
  async function actualUsage(newCallId: string, known = true, preparedUsageId?: string) {
    const data: Prisma.AiUsageLogUncheckedCreateInput = { userId: f.userId, novelId: f.novelId, chapterId: f.chapterId, agentRunId: f.runId,
      targetType: 'chapter', targetId: newCallId, providerType: 'text', providerMode: 'platform', providerName: runtime.provider, modelName: runtime.modelName,
      modelTier: runtime.tier, multiplierBps: runtime.multiplierBps, action: 'agent3HumanityAuthorReplacement', billingSnapshot: price,
      usageSource: known ? 'reported' : 'unknown', billingStatus: known ? 'observed' : 'pending_usage',
      requestTokens: known ? 100 : null, responseTokens: known ? 10 : null, reservedCreditMilli: known ? 0 : 12,
      billingEvidence: { responseObserved: true }, durationMs: 0 }
    const log = preparedUsageId ? await prisma.aiUsageLog.update({ where: { id: preparedUsageId }, data }) : await prisma.aiUsageLog.create({ data })
    if (known) await credits.consumeTokenCredits({ userId: f.userId, usageLogId: log.id, requestTokens: 100, responseTokens: 10,
      modelTier: runtime.tier, multiplierBps: runtime.multiplierBps, referenceId: newCallId })
    return log.id
  }
  const complete = async (newCallId: string, usageId: string, rawResponse = '{"findings":[]}') => {
    const received = { authorizationId, newCallId, rawResponse, finishReason: 'stop', toolCalls: [], newUsageIds: [usageId] }
    await prisma.$transaction(tx => observeAuthorReviewResponse(tx, received))
    return prisma.$transaction(tx => completeAuthorReviewReplacement(tx, received))
  }
  return { input, authorize, claim, read, wait, actualUsage, preparedUsage, complete, oldUsage, usage, runtime }
}

describe.runIf(available)('persisted independent author-review dependency (real PG, no HTTP)', () => {
  it.each(['humanity-context.v5', 'humanity-context.v6'] as const)('preserves genuinely frozen %s authorizations and old unknown usage without upgrading their hashes', async protocol => fixture(async f => {
    const h = await prepare(f)
    const admitted = await h.authorize()
    const event = await prisma.agentRunEvent.findUniqueOrThrow({ where: { id: admitted.authorizationEventId } })
    const value = structuredClone((event.payload as Prisma.JsonObject).value) as Prisma.JsonObject
    // Fixture for an authorization persisted before prompt-protocol binding existed.
    delete value.criticPromptProtocol
    value.criticVersion = protocol === 'humanity-context.v5' ? 'humanity-critic.v5' : 'humanity-critic.v6'
    const bundle = await buildHumanityQualityContext(f.userId, f.novelId, f.chapterId, f.runId)
    const deterministic = analyzeDeterministicQuality(bundle.chapter.content, bundle.recentChapters.map(row => row.content))
    const sources = buildQualityEvidenceSources({ userId: f.userId, novelId: f.novelId, chapterId: f.chapterId, chapterRevision: 1 }, bundle.chapter.content)
    const system = buildCriticSystem('balanced', protocol), content = buildCriticInput(bundle, deterministic.metrics, sources, protocol)
    const expected = value.expected as Prisma.JsonObject
    expected.qualityContextHash = qualityReviewContextHash(bundle, protocol)
    expected.promptHash = sha(JSON.stringify({ system, content }))
    const historical = await prisma.agentRunEvent.update({ where: { id: event.id }, data: { payload: { value, hash: runtimeJson(value).hash } as Prisma.InputJsonValue } })
    const plan = await h.claim()
    expect(plan.system).toBe(system)
    expect(plan.content).toBe(content)
    const usageId = await h.actualUsage(plan.newCallId)
    const completed = await h.complete(plan.newCallId, usageId)
    expect(await prisma.chapterQualityReport.findUniqueOrThrow({ where: { id: completed.reportId } })).toMatchObject({
      criticVersion: value.criticVersion, deterministicMetrics: { criticPromptProtocol: protocol, qualityContextHash: expected.qualityContextHash },
    })
    expect(await h.read()).toHaveLength(1)
    expect(await prisma.agentRunEvent.findUniqueOrThrow({ where: { id: event.id } })).toEqual(historical)
    expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: h.oldUsage.id } })).toEqual(h.oldUsage)
  }))

  it('serializes concurrent claims, survives a process-style reread and preserves old unknown accounting', async () => fixture(async f => {
    const h = await prepare(f)
    await h.authorize()
    const claims = await Promise.allSettled([h.claim(), h.claim()])
    expect(claims.filter(row => row.status === 'fulfilled')).toHaveLength(1)
    expect(claims.filter(row => row.status === 'rejected')).toHaveLength(1)
    const plan = (claims.find(row => row.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof h.claim>>>).value
    expect(await h.read()).toEqual([])
    expect(await h.wait()).not.toBeNull()
    const prepared = await h.preparedUsage(plan.newCallId)
    await credits.reserveTokenCredits(f.userId, prepared.id, 1000, plan.maxOutputTokens, { price: h.input.expected.price,
      newCallId: plan.newCallId, runId: f.runId, novelId: f.novelId, chapterId: f.chapterId })
    expect((await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: prepared.id } })).reservedCreditMilli).toBeGreaterThan(0)
    await prisma.$transaction(tx => validateClaimAuthorReviewReplacement(tx, h.input.authorizationId))
    const usageId = await h.actualUsage(plan.newCallId, true, prepared.id)
    expect(await h.wait()).not.toBeNull()
    const completed = await h.complete(plan.newCallId, usageId)
    expect(await h.read()).toMatchObject([{ replacementReceipt: { status: 'author_replacement_review_complete', sourceReportId: completed.reportId,
      newUsageIds: [usageId], originalUsageIds: [h.oldUsage.id], originalRequestOutcome: 'unknown_preserved' } }])
    expect(await h.read()).toEqual(await h.read())
    expect(await h.wait()).toBeNull()
    expect(await prisma.aiUsageLog.findUnique({ where: { id: h.oldUsage.id } })).toEqual(h.oldUsage)
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })
    const current = run.usage as Prisma.JsonObject
    expect(run).toMatchObject({ status: 'failed', currentTurn: 3, modelTier: 'standard', reasoningEffort: 'medium' })
    expect(current.totalTokens).toBe(h.usage.totalTokens)
    expect((current.checkpoint as Prisma.JsonObject).tokenBudget).toBe(500)
    expect((current.checkpoint as Prisma.JsonObject).reviewAttempts).toHaveLength(2)
    expect(await prisma.chapter.findUnique({ where: { id: f.chapterId }, select: { content: true, revision: true } })).toEqual({ content: '原文', revision: 1 })
    expect(await prisma.creditLedgerEntry.findUnique({ where: { idempotencyKey: `usage:${usageId}` } })).toMatchObject({ deltaMilli: -priceTokenEvidence(h.input.expected.price, 100, 10) })
    const proof = await h.read(), resumed = JSON.parse(JSON.stringify(run.usage)) as Prisma.InputJsonObject
    const checkpoint = resumed.checkpoint as Prisma.InputJsonObject
    checkpoint.pendingReviews = []
    checkpoint.resumeCount = Number(checkpoint.resumeCount) + 1
    checkpoint.activeExecutionMs = Number(checkpoint.activeExecutionMs) + 100
    resumed.promptTokens = Number(resumed.promptTokens) + 1
    resumed.totalTokens = Number(resumed.totalTokens) + 1
    // Persist the ordinary resume states without invoking main-loop Continue,
    // native execution or a provider; the original dependency is already proven.
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'queued', currentTurn: 4, usage: resumed } })
    expect(await h.read()).toEqual(proof)
    expect(await h.wait()).toBeNull()
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'running', currentTurn: 5 } })
    expect(await h.read()).toEqual(proof)
    expect(await h.wait()).toBeNull()
    expect(await prisma.aiUsageLog.findUnique({ where: { id: h.oldUsage.id } })).toEqual(h.oldUsage)
  }))
  it('keeps actual incomplete or unknown-paid observations without releasing the dependency', async () => fixture(async f => {
    const h = await prepare(f)
    await h.authorize()
    const plan = await h.claim(), usageId = await h.actualUsage(plan.newCallId, false)
    const completed = await h.complete(plan.newCallId, usageId, '{"findings":[null]}')
    const report = await prisma.chapterQualityReport.findUniqueOrThrow({ where: { id: completed.reportId } })
    expect(report.status).toBe('failed')
    expect((report.deterministicMetrics as Prisma.JsonObject).criticResponse).toMatchObject({ rawResponse: { content: JSON.stringify('{"findings":[null]}'), complete: true } })
    expect(await h.read()).toEqual([])
    expect(await h.wait()).not.toBeNull()
    await expect(h.claim()).rejects.toThrow()
  }))
  it('rejects cancelled completion and body/context changes without creating a report or changing old usage', async () => fixture(async f => {
    const h = await prepare(f)
    await h.authorize()
    const plan = await h.claim(), usageId = await h.actualUsage(plan.newCallId)
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'cancelled' } })
    await expect(h.complete(plan.newCallId, usageId)).rejects.toThrow()
    await prisma.$transaction(tx => failAuthorReviewReplacement(tx, h.input.authorizationId, { failureCode: 'AUTHOR_REVIEW_REPLACEMENT_REFUSED', usageIds: [usageId] }))
    const observation = await prisma.agentRunEvent.findFirstOrThrow({ where: { runId: f.runId, type: 'review.replacement.observed' } })
    expect((observation.payload as Prisma.JsonObject).value).toMatchObject({ newUsageIds: [usageId], response: {
      encoding: 'json-string', content: JSON.stringify('{"findings":[]}'), contentHash: sha('{"findings":[]}'), finishReason: 'stop', toolCalls: [],
    } })
    expect(await prisma.chapterQualityReport.count({ where: { runId: f.runId } })).toBe(0)
    expect(await h.read()).toEqual([])
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'failed' } })
    await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '改变正文', revision: 2 } })
    await expect(h.complete(plan.newCallId, usageId)).rejects.toThrow()
    expect(await prisma.aiUsageLog.findUnique({ where: { id: h.oldUsage.id } })).toEqual(h.oldUsage)
    expect(await prisma.agentRunEvent.count({ where: { runId: f.runId, type: 'review.replacement.observed' } })).toBe(1)
    expect(await prisma.aiUsageLog.findUnique({ where: { id: usageId } })).toMatchObject({ usageSource: 'reported', billingStatus: 'settled', creditChargeMilli: 12 })
    expect(await prisma.chapterQualityReport.count({ where: { runId: f.runId } })).toBe(0)
  }))
  it('replays an actual complete report instead of purchasing the same manuscript under a new nonce', async () => fixture(async f => {
    const h = await prepare(f)
    await h.authorize()
    const plan = await h.claim(), usageId = await h.actualUsage(plan.newCallId)
    await h.complete(plan.newCallId, usageId)
    expect(await h.read()).toHaveLength(1)
    const nonce = randomUUID(), authorizationId = `author-review-replacement:${f.userId}:${nonce}`
    const replay = await prisma.$transaction(tx => authorizeAuthorReviewReplacement(tx, { ...h.input,
      authorizationId, humanAuthorizationRef: authorizationId, authority: { ...h.input.authority, quoteNonce: nonce } }))
    expect(replay.status).toBe('replayed')
    expect(await prisma.agentRunEvent.count({ where: { runId: f.runId, type: 'review.replacement.claimed' } })).toBe(1)
    expect(await prisma.agentRun.findUnique({ where: { id: f.runId } })).toMatchObject({ modelTier: 'standard', reasoningEffort: 'medium' })
    const log = await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: usageId } })
    expect(log).toMatchObject({ usageSource: 'reported', billingStatus: 'settled', creditChargeMilli: 12, reservedCreditMilli: 0 })
  }))
  it('binds a current r2 assessment without changing the original pending r1 request', async () => fixture(async f => {
    const h = await prepare(f)
    await prisma.chapter.update({ where: { id: f.chapterId }, data: { content: '她关上门。风吹动帘子。', revision: 2 } })
    const bundle = await buildHumanityQualityContext(f.userId, f.novelId, f.chapterId, f.runId)
    const deterministic = analyzeDeterministicQuality(bundle.chapter.content, bundle.recentChapters.map(row => row.content))
    const sources = buildQualityEvidenceSources({ userId: f.userId, novelId: f.novelId, chapterId: f.chapterId, chapterRevision: 2 }, bundle.chapter.content)
    const system = buildCriticSystem('balanced'), content = buildCriticInput(bundle, deterministic.metrics, sources)
    Object.assign(h.input.expected, { currentRevision: 2, currentContentHash: sha(bundle.chapter.content), qualityContextHash: qualityReviewContextHash(bundle),
      promptHash: sha(JSON.stringify({ system, content })) })
    await h.authorize()
    const plan = await h.claim(), usageId = await h.actualUsage(plan.newCallId)
    const completed = await h.complete(plan.newCallId, usageId)
    expect(await h.read()).toMatchObject([{ revision: 1, replacementReceipt: { currentRevision: 2, originalRequestOutcome: 'unknown_preserved' } }])
    expect(await prisma.chapterQualityReport.findUnique({ where: { id: completed.reportId } })).toMatchObject({ chapterRevision: 2 })
    const checkpoint = (await prisma.agentRun.findUniqueOrThrow({ where: { id: f.runId } })).usage as Prisma.JsonObject
    expect((checkpoint.checkpoint as Prisma.JsonObject).pendingReviews).toEqual([h.input.pending])
  }))
  it('exposes waiting_usage for a valid received report whose new bill remains unknown, without nonce bypass', async () => fixture(async f => {
    const h = await prepare(f)
    await h.authorize()
    const plan = await h.claim(), usageId = await h.actualUsage(plan.newCallId, false)
    const completed = await h.complete(plan.newCallId, usageId)
    expect(await prisma.chapterQualityReport.findUnique({ where: { id: completed.reportId } })).toMatchObject({ status: 'passed' })
    expect(await prisma.$transaction(tx => readAuthorReviewReplacementStatus(tx, h.input.subject, h.input.authorizationId))).toMatchObject({ status: 'waiting_usage' })
    expect(await h.read()).toEqual([])
    expect(await h.wait()).not.toBeNull()
    const nonce = randomUUID(), authorizationId = `author-review-replacement:${f.userId}:${nonce}`
    await expect(prisma.$transaction(tx => authorizeAuthorReviewReplacement(tx, { ...h.input,
      authorizationId, humanAuthorizationRef: authorizationId, authority: { ...h.input.authority, quoteNonce: nonce } }))).rejects.toThrow()
  }))
  it('persists a cancellation-time transport failure without resetting the task or old ledger', async () => fixture(async f => {
    const h = await prepare(f)
    await h.authorize()
    await h.claim()
    await prisma.agentRun.update({ where: { id: f.runId }, data: { status: 'cancelled' } })
    const failure = () => prisma.$transaction(tx => failAuthorReviewReplacement(tx, h.input.authorizationId, { failureCode: 'AI_PROVIDER_TIMEOUT', usageIds: [] }))
    expect(await failure()).toEqual(await failure())
    expect(await prisma.agentRunEvent.count({ where: { runId: f.runId, type: 'review.replacement.failed' } })).toBe(1)
    expect(await prisma.aiUsageLog.findUnique({ where: { id: h.oldUsage.id } })).toEqual(h.oldUsage)
    expect(await prisma.chapterQualityReport.count({ where: { runId: f.runId } })).toBe(0)
    await expect(h.claim()).rejects.toThrow()
  }))
  it('refuses ordinary reservation of an author-confirmed row unless its exact undispatched server proof is supplied', async () => fixture(async f => {
    const h = await prepare(f)
    await h.authorize()
    const plan = await h.claim(), prepared = await h.preparedUsage(plan.newCallId)
    await expect(credits.reserveTokenCredits(f.userId, prepared.id, 1000, plan.maxOutputTokens)).rejects.toThrow()
    expect(await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: prepared.id } })).toMatchObject({ reservedCreditMilli: 0, billingStatus: 'authorized_pending' })
    const proof = { price: h.input.expected.price, newCallId: plan.newCallId, runId: f.runId, novelId: f.novelId, chapterId: f.chapterId }
    await expect(credits.reserveTokenCredits(f.userId, prepared.id, 1000, plan.maxOutputTokens, { ...proof, runId: 'different-run' })).rejects.toThrow()
    await prisma.aiUsageLog.update({ where: { id: prepared.id }, data: { billingStatus: 'observed' } })
    await expect(credits.reserveTokenCredits(f.userId, prepared.id, 1000, plan.maxOutputTokens, proof)).rejects.toThrow()
    await prisma.aiUsageLog.update({ where: { id: prepared.id }, data: { billingStatus: 'authorized_pending', billingEvidence: {
      policy: FALLBACK_USAGE_POLICY, inputEstimate: 1000, outputEstimate: 1, responseObserved: true,
    } } })
    await expect(credits.reserveTokenCredits(f.userId, prepared.id, 1000, plan.maxOutputTokens, proof)).rejects.toThrow()
    expect((await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: prepared.id } })).reservedCreditMilli).toBe(0)
    expect(await prisma.creditLedgerEntry.count({ where: { userId: f.userId } })).toBe(0)
    expect(await prisma.aiUsageLog.findUnique({ where: { id: h.oldUsage.id } })).toEqual(h.oldUsage)
  }))
  it('uses actual text preparation, credit reservation and settlement with exactly one mocked provider request', async () => fixture(async f => {
    // Model availability gates are covered separately; the production prepare,
    // reservation, settlement and callback-validation paths remain real here.
    vi.spyOn(credits, 'assertCreditAccess').mockResolvedValue(undefined)
    try {
      const h = await prepare(f)
      await h.authorize()
      const plan = await h.claim(), trace = createTextRequestTrace()
      let observed: { usageId: string; content: string; finishReason: string | null; toolCalls: unknown[] } | undefined
      const provider = vi.fn(async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        expect(body.model).toBe(plan.model.modelName)
        expect(body.max_tokens ?? body.max_completion_tokens).toBe(plan.maxOutputTokens)
        expect(body.messages).toEqual([{ role: 'system', content: plan.system }, { role: 'user', content: plan.content }])
        expect(body.tools).toBeUndefined()
        return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"findings":[]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } })
      })
      vi.stubGlobal('fetch', provider)
      const beforeDispatch = vi.fn(async () => prisma.$transaction(async tx => {
        const row = await tx.aiUsageLog.findFirstOrThrow({ where: { userId: f.userId, agentRunId: f.runId, targetId: plan.newCallId } })
        expect(row).toMatchObject({ action: 'agent3HumanityAuthorReplacement', targetType: 'chapter', targetId: plan.newCallId,
          billingStatus: 'authorized_pending', usageSource: 'prepared', requestTokens: null, responseTokens: null, creditChargeMilli: 0 })
        expect(row.reservedCreditMilli).toBeGreaterThan(0)
        expect((row.billingEvidence as Prisma.JsonObject).responseObserved).toBe(false)
        await validateClaimAuthorReviewReplacement(tx, plan.authorizationId)
      }))
      const returned = await withTextRequestTrace(trace, () => generateTextCompletion(plan.system, plan.content, {
        userId: f.userId, novelId: f.novelId, chapterId: f.chapterId, agentRunId: f.runId,
        action: plan.action, targetType: plan.targetType, targetId: plan.newCallId, modelRuntime: h.runtime,
        explicitModelSelection: true, maxOutputTokens: plan.maxOutputTokens, signal: new AbortController().signal,
        authorizedRequest: { price: plan.price, inputTokenCeiling: plan.conservativeInputTokenCeiling,
          maxCreditMilli: plan.maxCreditMilli, beforeDispatch },
        onObservedCompletion: value => { observed = { ...value, toolCalls: [...value.toolCalls] } },
      }))
      expect(returned).toBe('{"findings":[]}')
      expect(provider).toHaveBeenCalledTimes(1)
      expect(beforeDispatch).toHaveBeenCalledTimes(1)
      expect(trace.records).toHaveLength(1)
      expect(trace.records[0]).toMatchObject({ status: 'terminal', billingKnown: true })
      if (!observed) throw new Error('Actual completion observer did not run')
      const actual = observed
      expect(actual).toMatchObject({ usageId: trace.records[0].usageId, content: returned, finishReason: 'stop', toolCalls: [] })
      const received = { authorizationId: plan.authorizationId, newCallId: plan.newCallId,
        rawResponse: actual.content, finishReason: actual.finishReason, toolCalls: actual.toolCalls, newUsageIds: [actual.usageId] }
      await prisma.$transaction(tx => observeAuthorReviewResponse(tx, received))
      await prisma.$transaction(tx => completeAuthorReviewReplacement(tx, received))
      expect(await h.read()).toHaveLength(1)
      expect(await h.wait()).toBeNull()
      expect(await prisma.aiUsageLog.findUnique({ where: { id: actual.usageId } })).toMatchObject({ usageSource: 'reported', billingStatus: 'settled',
        requestTokens: 100, responseTokens: 10, creditChargeMilli: 12, reservedCreditMilli: 0 })
      expect(await prisma.creditLedgerEntry.findUnique({ where: { idempotencyKey: `usage:${actual.usageId}` } })).toMatchObject({
        userId: f.userId, referenceId: plan.newCallId, sourceType: 'model_tokens', deltaMilli: -12 })
      expect(await prisma.aiUsageLog.findUnique({ where: { id: h.oldUsage.id } })).toEqual(h.oldUsage)
    } finally {
      vi.unstubAllGlobals()
    }
  }))
  it.each(['context', 'model', 'existing-report'])(
    'preserves a real late response independently when %s changed before report publication', async kind => fixture(async f => {
      const h = await prepare(f)
      await h.authorize()
      const plan = await h.claim(), usageId = await h.actualUsage(plan.newCallId), rawResponse = '{"findings":[]}\n\u0000late provider data'
      if (kind === 'context') await prisma.chapter.update({ where: { id: f.chapterId }, data: { title: 'changed quality context' } })
      if (kind === 'model') await prisma.agentRun.update({ where: { id: f.runId }, data: { modelTier: 'speed' } })
      if (kind === 'existing-report') await prisma.chapterQualityReport.create({ data: { userId: f.userId, novelId: f.novelId, runId: f.runId,
        compilationId: h.input.pending.compilationId, chapterId: f.chapterId, chapterRevision: 1, status: 'failed', deterministicMetrics: {}, criticVersion: 'humanity-critic.v5' } })
      const before = await prisma.aiUsageLog.findUniqueOrThrow({ where: { id: usageId } }), expectedReports = kind === 'existing-report' ? 1 : 0
      await expect(h.complete(plan.newCallId, usageId, rawResponse)).rejects.toThrow()
      await prisma.$transaction(tx => failAuthorReviewReplacement(tx, h.input.authorizationId, { failureCode: 'QUALITY_INPUT_STALE', usageIds: [usageId] }))
      const observation = await prisma.agentRunEvent.findFirstOrThrow({ where: { runId: f.runId, type: 'review.replacement.observed' } })
      expect((observation.payload as Prisma.JsonObject).value).toMatchObject({ newUsageIds: [usageId], response: {
        encoding: 'json-string', content: JSON.stringify(rawResponse), contentHash: sha(rawResponse), characterCount: rawResponse.length, finishReason: 'stop', toolCalls: [],
      } })
      expect(await prisma.chapterQualityReport.count({ where: { runId: f.runId } })).toBe(expectedReports)
      expect(await prisma.aiUsageLog.findUnique({ where: { id: usageId } })).toEqual(before)
      expect(await prisma.aiUsageLog.findUnique({ where: { id: h.oldUsage.id } })).toEqual(h.oldUsage)
      expect(await h.read()).toEqual([])
      expect(await prisma.$transaction(tx => readAuthorReviewReplacementStatus(tx, h.input.subject, h.input.authorizationId))).toMatchObject({ status: 'incomplete' })
      await expect(h.claim()).rejects.toThrow()
    }))
})
