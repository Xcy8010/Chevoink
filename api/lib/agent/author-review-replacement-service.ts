import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { continueAgentLoopRunSchema } from '../../../shared/contracts/index.js'
import { creditModelTierSchema } from '../../../shared/contracts/credits.js'
import type { AgentReviewReplacementQuote, AgentReviewReplacementStatus } from '../../../shared/contracts/agent-review-replacement.js'
import { env } from '../../config/env.js'
import { DataAccessError, prisma } from '../prisma.js'
import { getModelTierRuntime } from '../credits.js'
import { resolveTokenPrice } from '../billing/resolve-token-price.js'
import { tokenPriceSchema } from '../billing/token-price.js'
import { priceTokenEvidence } from '../billing/reservation-policy.js'
import { MAX_CREDIT_STORAGE_INT } from '../billing/pricing.js'
import { generateTextCompletion } from '../ai-service.js'
import { createTextRequestTrace, withTextRequestTrace } from '../text-request-trace.js'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'
import { withUserRunLock } from './run-lock.js'
import { getActiveRun, hasActiveRunInSession } from './active-runs.js'
import { savedRunUsageSchema } from './checkpoint.js'
import { readOriginalTaskRequest, originalTaskRunIds } from './original-request.js'
import { assertAgentManuscriptCurrent } from './manuscript-scope.js'
import { analyzeDeterministicQuality, buildHumanityQualityContext, qualityReviewContextHash } from './humanity-quality.js'
import { buildQualityEvidenceSources } from './quality-evidence.js'
import { buildCriticInput, buildCriticSystem } from './tools/humanity-quality-tools.js'
import { estimateChatMessagesTokens, resolveDurableInputLimit } from './context-budget.js'
import { REVIEW_MAX_OUTPUT_TOKENS } from './review-completion.js'
import { runtimeJson } from './runtime-common.js'
import { MAIN_RUN_FILTER } from './runtime-child.js'
import { authorizeAuthorReviewReplacement, claimAuthorReviewReplacement, completeAuthorReviewReplacement,
  failAuthorReviewReplacement, readAuthorReviewReplacementStatus, validateClaimAuthorReviewReplacement, observeAuthorReviewResponse,
  type AuthorReviewReplacementAuthorization, type AuthorReviewReplacementStatus as DurableStatus } from './author-review-replacement.js'

type Selection = z.infer<typeof continueAgentLoopRunSchema>
type Subject = AuthorReviewReplacementAuthorization['subject']
type Claim = Awaited<ReturnType<typeof claimAuthorReviewReplacement>>
type Observed = Parameters<NonNullable<Parameters<typeof generateTextCompletion>[2]['onObservedCompletion']>>[0]
const purpose = 'chevoink-author-review-replacement-quote-v1'
const lifetimeMs = 5 * 60_000
const maximumTokenLength = 16_384
const jobs = new Map<string, Promise<void>>()
const identifier = z.string().min(1).max(64)
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const effort = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const modelSchema = z.object({ tier: creditModelTierSchema, customModelId: identifier.nullable(), reasoningEffort: effort,
  provider: z.string().min(1).max(256), modelName: z.string().min(1).max(512), multiplierBps: z.number().int().nonnegative().max(MAX_CREDIT_STORAGE_INT) }).strict()
const authorizationSchema = z.object({
  authorizationId: z.string().min(1).max(160), humanAuthorizationRef: z.string().min(1).max(160),
  authority: z.object({ source: z.literal('authenticated_author_action'), actorUserId: identifier, quoteNonce: z.string().uuid() }).strict(),
  subject: z.object({ userId: identifier, novelId: identifier, runId: identifier }).strict(), taskId: identifier,
  pending: z.object({ compilationId: identifier.nullable(), chapterId: identifier, revision: z.number().int().positive(),
    toolName: z.literal('quality_analyze'), callId: identifier }).strict(), originalUsageIds: z.array(identifier).length(1),
  expected: z.object({ currentRevision: z.number().int().positive(), currentContentHash: digest, qualityContextHash: digest,
    promptHash: digest, model: modelSchema, price: tokenPriceSchema }).strict(),
  conservativeInputTokenCeiling: z.number().int().positive().max(2147483647), maxOutputTokens: z.literal(REVIEW_MAX_OUTPUT_TOKENS),
  maxModelRequests: z.literal(1), maxCreditMilli: z.number().int().nonnegative().max(MAX_CREDIT_STORAGE_INT),
}).strict()
const payloadSchema = z.object({ version: z.literal(1), purpose: z.literal(purpose), expiresAt: z.number().int().positive(),
  authorization: authorizationSchema, binding: z.object({ runHash: digest, originalHash: digest, usageHash: digest, eventsHash: digest, runtimeHash: digest }).strict() }).strict()
type QuotePayload = z.infer<typeof payloadSchema>
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const hash = (value: unknown) => runtimeJson(JSON.parse(JSON.stringify(value))).hash
const runtimeFingerprint = (runtime: Awaited<ReturnType<typeof getModelTierRuntime>>) => hash({ ...runtime,
  modelName: runtime.modelName ?? env.aiTextModel, baseUrl: runtime.baseUrl ?? env.aiTextBaseUrl, apiKey: runtime.apiKey ?? env.aiTextApiKey })
const authorizationEventWhere = (runId: string, authorizationId: string): Prisma.AgentRunEventWhereInput => ({ runId,
  OR: [{ id: `ar${sha(`authorization:${authorizationId}`).slice(0, 60)}` },
    { type: 'review.replacement.authorized', payload: { path: ['value', 'authorizationId'], equals: authorizationId } }] })
function refuse(message: string): never { throw new DataAccessError(409, 'AUTHOR_REVIEW_REPLACEMENT_REFUSED', message) }
function signingSecret() {
  if (!env.authSessionSecret) throw new DataAccessError(503, 'AUTHOR_REVIEW_QUOTE_UNAVAILABLE', '检查报价服务尚未配置。')
  return env.authSessionSecret
}
function signature(encoded: string) { return createHmac('sha256', signingSecret()).update(`${purpose}.${encoded}`).digest('hex') }
function signed(payload: QuotePayload) {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const token = `${encoded}.${signature(encoded)}`
  if (token.length > maximumTokenLength) refuse('当前报价信息超过允许大小，未确认检查。')
  return token
}
function verified(token: string, userId: string, runId: string): QuotePayload {
  if (typeof token !== 'string' || token.length > maximumTokenLength || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/u.test(token)) refuse('检查报价凭证无效。')
  const [encoded, supplied] = token.split('.')
  if (!timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(signature(encoded), 'hex'))) refuse('检查报价签名不一致。')
  let decoded: unknown
  try { decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) } catch { refuse('检查报价凭证损坏。') }
  const parsed = payloadSchema.safeParse(decoded)
  if (!parsed.success) refuse('检查报价内容无效。')
  const payload = parsed.data, input = payload.authorization
  const expectedId = `author-review-replacement:${userId}:${input.authority.quoteNonce}`
  if (payload.expiresAt <= Date.now() || payload.expiresAt > Date.now() + lifetimeMs
    || input.subject.userId !== userId || input.subject.runId !== runId || input.authority.actorUserId !== userId
    || input.authorizationId !== expectedId || input.humanAuthorizationRef !== expectedId) refuse('报价已过期或不属于当前作者任务，请重新查看。')
  return payload
}

async function ownedRun(tx: Prisma.TransactionClient, userId: string, runId: string) {
  identifier.parse(userId); identifier.parse(runId)
  const run = await tx.agentRun.findFirst({ where: { id: runId, userId } })
  if (!run) throw new DataAccessError(404, 'RUN_NOT_FOUND', '任务不存在或不属于当前作者。')
  return run
}
async function stoppedRun(tx: Prisma.TransactionClient, userId: string, runId: string, locking: boolean) {
  let run = await ownedRun(tx, userId, runId)
  if (locking) {
    // Match the durable sidecar lock order; all effects stay in this transaction.
    await lockNovelActiveScope(tx, run.novelId)
    await tx.$queryRaw`SELECT id FROM agent_runs WHERE id = ${runId} AND user_id = ${userId} FOR UPDATE`
    await tx.$queryRaw`SELECT user_id FROM credit_accounts WHERE user_id = ${userId} FOR UPDATE`
    run = await ownedRun(tx, userId, runId)
  }
  if (run.engine !== 'loop' || run.runtimeProtocolVersion !== 0 || run.taskRootId || !['failed', 'paused'].includes(run.status)
    || record(run.usage).authorEnded !== undefined || getActiveRun(runId) || hasActiveRunInSession(run.sessionId)
    || await tx.agentRun.count({ where: { ...MAIN_RUN_FILTER, sessionId: run.sessionId, userId, id: { not: runId },
      status: { in: ['queued', 'running', 'awaiting_approval'] } } })
    || await tx.agentGoalExecution.findUnique({ where: { runId } })) refuse('任务仍在执行、已结束或不支持此独立检查，请保留原任务状态。')
  const latest = await tx.agentRun.findFirst({ where: { ...MAIN_RUN_FILTER, sessionId: run.sessionId }, orderBy: { createdAt: 'desc' }, select: { id: true } })
  if (latest?.id !== run.id) throw new DataAccessError(409, 'STALE_RESUME_TARGET', '当前会话已开始新任务，不能从旧入口购买检查。请刷新后查看最新任务。')
  if (locking) await assertAgentManuscriptCurrent(tx, { userId, runId, novelId: run.novelId })
  else {
    const novel = await tx.novel.findFirst({ where: { id: run.novelId, authorId: userId }, select: { manuscriptRevision: true } })
    if (!novel || run.manuscriptRevision !== novel.manuscriptRevision) refuse('稿件范围已变化，旧任务不能购买当前检查。')
  }
  return run
}
function inScope(spec: unknown, novelId: string, chapter: { id: string; orderIndex: number }) {
  const scope = record(record(spec).scope), writing = record(scope.writing)
  return scope.novelId === novelId && (writing.kind === 'bounded' ? Array.isArray(writing.targets) && writing.targets.some(item => {
    const target = record(item)
    return target.orderIndex === chapter.orderIndex && (target.chapterId == null || target.chapterId === chapter.id)
  }) : writing.kind === 'unbounded' || Array.isArray(scope.chapterIds) && scope.chapterIds.includes(chapter.id))
}

async function quoteFacts(tx: Prisma.TransactionClient, userId: string, runId: string, selection: Selection, nonce: string, locking: boolean) {
  const run = await stoppedRun(tx, userId, runId, locking), subject: Subject = { userId, runId, novelId: run.novelId }
  const saved = savedRunUsageSchema.safeParse(run.usage)
  if (!saved.success || saved.data.checkpoint?.version !== 2 || saved.data.checkpoint.controlPolicy !== 'until_completion') refuse('原检查点与预算无法核实。')
  const pendingChecks = (saved.data.checkpoint.pendingReviews ?? []).filter(item => item.toolName === 'quality_analyze')
  if (pendingChecks.length !== 1) refuse('没有唯一待确认的质量检查，不能重新派发。')
  const pending = pendingChecks[0]
  if (!pending.compilationId) refuse('原质量检查缺少任务编译身份。')
  const original = await readOriginalTaskRequest(tx, subject), lineage = await originalTaskRunIds(tx, subject, original)
  if (!original.prompt?.trim() || original.parentRunId !== null || original.sourceRunId !== runId
    || record(original.spec).controlPolicy !== 'until_completion') refuse('原始作者请求与执行范围无法核实。')
  const bundle = await buildHumanityQualityContext(userId, run.novelId, pending.chapterId, runId, tx)
  if (bundle.chapter.revision < pending.revision || bundle.compilation?.id !== pending.compilationId || bundle.compilation.status !== 'active'
    || !lineage.includes(bundle.compilation.runId ?? '') || !inScope(original.spec, run.novelId, bundle.chapter)) refuse('当前正文或编译不属于原作者任务。')
  const events = await tx.agentRunEvent.findMany({ where: { runId: { in: lineage }, type: { in: ['tool.call', 'tool.result'] },
    payload: { path: ['callId'], equals: pending.callId } }, orderBy: { seq: 'asc' } })
  const calls = events.filter(item => item.type === 'tool.call'), results = events.filter(item => item.type === 'tool.result')
  if (calls.length !== 1 || results.length !== 1) refuse('原质量检查缺少唯一调用与失败证据。')
  const call = calls[0], result = results[0], args = record(record(call.payload).args)
  if (call.runId !== runId || result.runId !== runId || result.seq <= call.seq || result.createdAt < call.createdAt
    || record(call.payload).toolName !== 'quality_analyze' || record(result.payload).toolName !== 'quality_analyze' || record(result.payload).ok !== false
    || !(args.chapterId === pending.chapterId || args.compilationId === pending.compilationId)
    || args.chapterId !== undefined && args.chapterId !== pending.chapterId || args.compilationId !== undefined && args.compilationId !== pending.compilationId) refuse('原检查调用与章节身份不一致。')
  const usages = await tx.aiUsageLog.findMany({ where: { userId, novelId: run.novelId, chapterId: pending.chapterId, targetId: pending.chapterId,
    action: 'agent3HumanityCritic', createdAt: { gte: call.createdAt, lte: result.createdAt } }, orderBy: { id: 'asc' } })
  if (usages.length !== 1 || usages[0].agentRunId !== null && !lineage.includes(usages[0].agentRunId)
    || usages[0].usageSource !== 'unknown' || usages[0].billingStatus !== 'pending_usage' || usages[0].requestTokens !== null
    || usages[0].responseTokens !== null || usages[0].reservedCreditMilli <= 0 || record(usages[0].billingEvidence).responseObserved !== false) refuse('原未知用量与预留无法唯一核实。')
  const tier = creditModelTierSchema.parse(selection.modelTier ?? run.modelTier)
  const customModelId = tier === 'custom' ? selection.customModelId ?? run.customModelId : null
  if (tier === 'custom' && !customModelId) refuse('当前选择缺少自定义模型身份。')
  const reasoningEffort = effort.parse(selection.reasoningEffort ?? run.reasoningEffort)
  const runtime = await getModelTierRuntime(tier, userId, customModelId, reasoningEffort)
  if (runtime.tier !== tier || runtime.reasoningEffort !== reasoningEffort) refuse('当前模型身份无法完整核实，未替换模型。')
  const model = modelSchema.parse({ tier, customModelId, reasoningEffort, provider: runtime.provider, modelName: runtime.modelName ?? env.aiTextModel, multiplierBps: runtime.multiplierBps })
  const price = tokenPriceSchema.parse(await resolveTokenPrice(tier, runtime.multiplierBps))
  if (price.modelTier !== tier || price.multiplierBps !== runtime.multiplierBps) refuse('当前模型与实际费率身份不一致，未创建报价。')
  const deterministic = analyzeDeterministicQuality(bundle.chapter.content, bundle.recentChapters.map(item => item.content))
  const sources = buildQualityEvidenceSources({ userId, novelId: run.novelId, chapterId: pending.chapterId, chapterRevision: bundle.chapter.revision }, bundle.chapter.content)
  const system = buildCriticSystem('balanced'), content = buildCriticInput(bundle, deterministic.metrics, sources)
  const messages = [{ role: 'system' as const, content: system }, { role: 'user' as const, content }]
  const inputLimit = resolveDurableInputLimit(runtime.contextWindowTokens ?? env.agentContextWindowTokens, REVIEW_MAX_OUTPUT_TOKENS)
  if (!inputLimit || estimateChatMessagesTokens(messages) > inputLimit) refuse('完整正文与上下文超过当前模型窗口，未截断输入或购买检查。')
  const inputTokenCeiling = Buffer.byteLength(JSON.stringify(messages), 'utf8') + 4096
  const maximumCreditMilli = priceTokenEvidence(price, inputTokenCeiling, REVIEW_MAX_OUTPUT_TOKENS, 0)
  const authorizationId = `author-review-replacement:${userId}:${nonce}`
  const authorization = authorizationSchema.parse({ authorizationId, humanAuthorizationRef: authorizationId,
    authority: { source: 'authenticated_author_action', actorUserId: userId, quoteNonce: nonce }, subject, taskId: original.taskId,
    pending, originalUsageIds: [usages[0].id], expected: { currentRevision: bundle.chapter.revision,
      currentContentHash: sha(bundle.chapter.content), qualityContextHash: qualityReviewContextHash(bundle), promptHash: sha(JSON.stringify({ system, content })), model, price },
    conservativeInputTokenCeiling: inputTokenCeiling, maxOutputTokens: REVIEW_MAX_OUTPUT_TOKENS, maxModelRequests: 1, maxCreditMilli: maximumCreditMilli })
  return { authorization, binding: { runHash: hash({ id: run.id, sessionId: run.sessionId, modelTier: run.modelTier,
    customModelId: run.customModelId, reasoningEffort: run.reasoningEffort, manuscriptRevision: run.manuscriptRevision,
    currentTurn: run.currentTurn, usage: run.usage, startRequest: run.startRequest, taskSpec: run.taskSpec, writingBindings: run.writingBindings }),
    originalHash: hash({ original, lineage: [...lineage].sort() }), usageHash: hash(usages), eventsHash: hash(events), runtimeHash: runtimeFingerprint(runtime) } }
}

/** Reads current facts and signs a short-lived price envelope; no authorization,
 * claim, usage reservation or provider request is created by this preview. */
export async function quoteAuthorReviewReplacement(userId: string, runId: string, selection: Selection = {}): Promise<AgentReviewReplacementQuote> {
  const parsed = continueAgentLoopRunSchema.strict().parse(selection), nonce = randomUUID()
  const facts = await prisma.$transaction(async tx => {
    const run = await ownedRun(tx, userId, runId), latest = await latestStatus(tx, { userId, runId, novelId: run.novelId })
    if (latest && ['authorized', 'claimed', 'waiting_usage'].includes(latest.status.status)) refuse('原检查已有待确认结果，请查看原状态；换报价不能再次派发。')
    return quoteFacts(tx, userId, runId, parsed, nonce, false)
  }, { isolationLevel: 'RepeatableRead' })
  const payload = payloadSchema.parse({ version: 1, purpose, expiresAt: Date.now() + lifetimeMs, ...facts })
  const { authorization: input } = payload, model = input.expected.model
  return { quoteToken: signed(payload), authorizationId: input.authorizationId, expiresAt: new Date(payload.expiresAt).toISOString(),
    chapterId: input.pending.chapterId, currentRevision: input.expected.currentRevision, maximumCreditMilli: input.maxCreditMilli,
    currentModel: { modelTier: model.tier, customModelId: model.customModelId, reasoningEffort: model.reasoningEffort,
      modelName: model.modelName, label: model.modelName, multiplierBps: model.multiplierBps } }
}
function statusDto(authorizationId: string, status: DurableStatus): AgentReviewReplacementStatus {
  if (status.status === 'complete') return { authorizationId, state: 'complete', reportId: status.reportId, message: '当前检查报告与费用已确认；报告仍可能要求修订。' }
  if (status.status === 'incomplete') return { authorizationId, state: 'incomplete', reportId: status.reportId, message: '本次检查未完整完成，原任务与账目保留；不会自动重发。' }
  if (status.status === 'claimed' && jobs.has(authorizationId)) return { authorizationId, state: 'running', reportId: status.reportId, message: '正在按已确认的当前模型检查。' }
  return { authorizationId, state: 'waiting_confirmation', reportId: status.reportId,
    message: status.status === 'waiting_usage' ? '当前报告已保存，实际费用尚未确认；原依赖保留，不会自动重发。' : '已领取的检查尚无可确认结果；原任务与账目保留，不会自动重发。' }
}
export async function getAuthorReviewReplacementStatus(userId: string, runId: string, authorizationId: string): Promise<AgentReviewReplacementStatus> {
  z.string().min(1).max(160).parse(authorizationId)
  return prisma.$transaction(async tx => {
    const run = await ownedRun(tx, userId, runId)
    const authorized = await tx.agentRunEvent.findFirst({ where: authorizationEventWhere(runId, authorizationId) })
    if (!authorized) {
      const laterEvidence = await tx.agentRunEvent.findFirst({ where: { runId, id: { in: ['claim', 'completion', 'failure'].map(kind => `ar${sha(`${kind}:${authorizationId}`).slice(0, 60)}`) } } })
      if (laterEvidence) refuse('已存在检查领取或结果证据，但授权记录无法核实；不能重发。')
      throw new DataAccessError(404, 'REVIEW_REPLACEMENT_NOT_FOUND', '此报价尚未确认领取检查，请重新查看当前报价。')
    }
    return statusDto(authorizationId, await readAuthorReviewReplacementStatus(tx, { userId, runId, novelId: run.novelId }, authorizationId))
  }, { isolationLevel: 'RepeatableRead' })
}
async function latestStatus(tx: Prisma.TransactionClient, subject: Subject) {
  const latest = await tx.agentRunEvent.findFirst({ where: { runId: subject.runId, type: 'review.replacement.authorized' }, orderBy: { seq: 'desc' } })
  if (!latest) return null
  const id = z.string().min(1).max(160).parse(record(record(latest.payload).value).authorizationId)
  return { authorizationId: id, status: await readAuthorReviewReplacementStatus(tx, subject, id) }
}
/** Restore polling after a lost HTTP response/navigation. This observes only
 * the latest owned durable authorization and can never recover a sender. */
export async function getLatestAuthorReviewReplacementStatus(userId: string, runId: string): Promise<AgentReviewReplacementStatus | null> {
  return prisma.$transaction(async tx => {
    const run = await ownedRun(tx, userId, runId), latest = await latestStatus(tx, { userId, runId, novelId: run.novelId })
    return latest ? statusDto(latest.authorizationId, latest.status) : null
  }, { isolationLevel: 'RepeatableRead' })
}

async function executeClaim(claim: Claim, expectedRuntimeHash: string) {
  const trace = createTextRequestTrace()
  let observed: Observed | undefined
  let failureCode = 'AUTHOR_REVIEW_REPLACEMENT_FAILED'
  try {
    const runtime = await getModelTierRuntime(claim.model.tier, claim.userId, claim.model.customModelId, claim.model.reasoningEffort)
    if (runtimeFingerprint(runtime) !== expectedRuntimeHash || hash({ tier: runtime.tier, customModelId: claim.model.customModelId, reasoningEffort: runtime.reasoningEffort,
      provider: runtime.provider, modelName: runtime.modelName ?? env.aiTextModel, multiplierBps: runtime.multiplierBps }) !== hash(claim.model)) refuse('派发前当前模型身份已变化，未替换模型。')
    await withTextRequestTrace(trace, () => generateTextCompletion(claim.system, claim.content, {
      userId: claim.userId, novelId: claim.novelId, agentRunId: claim.runId, chapterId: claim.chapterId,
      action: claim.action, targetType: claim.targetType, targetId: claim.newCallId, modelRuntime: runtime,
      explicitModelSelection: true, maxOutputTokens: claim.maxOutputTokens, signal: AbortSignal.timeout(env.aiTextTimeoutMs), temperature: 0.15,
      authorizedRequest: { price: claim.price, inputTokenCeiling: claim.conservativeInputTokenCeiling, maxCreditMilli: claim.maxCreditMilli,
        beforeDispatch: () => withUserRunLock(claim.userId, () => prisma.$transaction(async tx => {
          await stoppedRun(tx, claim.userId, claim.runId, true)
          if (runtimeFingerprint(await getModelTierRuntime(claim.model.tier, claim.userId, claim.model.customModelId, claim.model.reasoningEffort)) !== expectedRuntimeHash) refuse('派发前当前模型路由已变化。')
          await validateClaimAuthorReviewReplacement(tx, claim.authorizationId)
        }, { isolationLevel: 'Serializable' })) },
      onObservedCompletion: value => { observed = { ...value, toolCalls: [...value.toolCalls] } },
    }))
  } catch (error) { failureCode = error instanceof DataAccessError ? error.code.slice(0, 64) : failureCode }
  const raw = observed
  if (raw && trace.records.length === 1 && trace.records[0].usageId === raw.usageId) {
    const observation = { authorizationId: claim.authorizationId, newCallId: claim.newCallId,
      rawResponse: raw.content, finishReason: raw.finishReason, toolCalls: raw.toolCalls, newUsageIds: [raw.usageId] }
    // Commit the actual response independently before rechecking current text,
    // model and context. A later edit cannot roll this observation back.
    await prisma.$transaction(tx => observeAuthorReviewResponse(tx, observation), { isolationLevel: 'Serializable' })
    if (raw.transportComplete === false) {
      await prisma.$transaction(tx => failAuthorReviewReplacement(tx, claim.authorizationId, {
        failureCode, usageIds: [raw.usageId],
      }), { isolationLevel: 'Serializable' })
      return
    }
    try {
      await prisma.$transaction(tx => completeAuthorReviewReplacement(tx, observation), { isolationLevel: 'Serializable' })
    } catch (error) {
      if (!(error instanceof DataAccessError)) throw error
      await prisma.$transaction(tx => failAuthorReviewReplacement(tx, claim.authorizationId, {
        failureCode: error.code.slice(0, 64), usageIds: [raw.usageId],
      }), { isolationLevel: 'Serializable' })
    }
  } else await prisma.$transaction(tx => failAuthorReviewReplacement(tx, claim.authorizationId, { failureCode,
    usageIds: trace.records.slice(0, 1).map(row => row.usageId) }), { isolationLevel: 'Serializable' })
}

/** Only this authenticated, quote-bound command may create a new sender. The
 * durable claim commits before scheduling; replay and polling never send. */
export async function submitAuthorReviewReplacement(userId: string, runId: string, quoteToken: string): Promise<AgentReviewReplacementStatus> {
  const payload = verified(quoteToken, userId, runId), input = payload.authorization
  return withUserRunLock(userId, async () => {
    verified(quoteToken, userId, runId)
    const admitted = await prisma.$transaction(async tx => {
      const run = await ownedRun(tx, userId, runId)
      if (run.novelId !== input.subject.novelId) refuse('报价作品身份已变化。')
      await lockNovelActiveScope(tx, run.novelId)
      await tx.$queryRaw`SELECT id FROM agent_runs WHERE id = ${runId} AND user_id = ${userId} FOR UPDATE`
      const existing = await tx.agentRunEvent.findFirst({ where: authorizationEventWhere(runId, input.authorizationId) })
      if (existing) return { kind: 'status' as const, status: statusDto(input.authorizationId, await readAuthorReviewReplacementStatus(tx, input.subject, input.authorizationId)) }
      const selected = input.expected.model
      const facts = await quoteFacts(tx, userId, runId, continueAgentLoopRunSchema.parse({ modelTier: selected.tier, customModelId: selected.customModelId,
        reasoningEffort: selected.reasoningEffort }), input.authority.quoteNonce, true)
      if (hash(facts) !== hash({ authorization: input, binding: payload.binding })) refuse('正文、完整上下文、当前模型或正常价格已变化，请重新查看报价。')
      if (payload.expiresAt <= Date.now()) refuse('报价在确认前已过期，请重新查看当前报价。')
      if (run.modelTier !== selected.tier || run.customModelId !== selected.customModelId || run.reasoningEffort !== selected.reasoningEffort) {
        await tx.agentRun.update({ where: { id: runId }, data: { modelTier: selected.tier, customModelId: selected.customModelId, reasoningEffort: selected.reasoningEffort } })
      }
      const authorized = await authorizeAuthorReviewReplacement(tx, input as AuthorReviewReplacementAuthorization)
      if (authorized.status === 'replayed') return { kind: 'status' as const,
        status: statusDto(authorized.replacementReceipt.authorizationId, await readAuthorReviewReplacementStatus(tx, input.subject, authorized.replacementReceipt.authorizationId)) }
      return { kind: 'claim' as const, claim: await claimAuthorReviewReplacement(tx, input.authorizationId) }
    }, { isolationLevel: 'Serializable' })
    if (admitted.kind === 'status') return admitted.status
    const job = Promise.resolve().then(() => executeClaim(admitted.claim, payload.binding.runtimeHash)).catch(() => {
      // A persistence/transport ambiguity stays claimed. Never retry the sender
      // or manufacture a failure/zero bill after an unknown transaction outcome.
    }).finally(() => { if (jobs.get(input.authorizationId) === job) jobs.delete(input.authorizationId) })
    jobs.set(input.authorizationId, job)
    return { authorizationId: input.authorizationId, state: 'running', message: '已确认一次当前模型检查；原未知费用与任务预算保留。' }
  })
}
