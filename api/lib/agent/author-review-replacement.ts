import { weightedRouteSelectionSchema, type WeightedRouteSelection } from '../../../shared/contracts/model-weighted-routes.js'
import { resolveWeightedModelRuntime } from '../model-weighted-routing.js'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { AgentRunEvent, AiUsageLog, Prisma } from '@prisma/client'
import type { AgentAuthorReviewReplacement, CreditModelTier, ModelReasoningEffort } from '../../../shared/contracts/index.js'
import { DataAccessError } from '../prisma.js'
import { getModelTierRuntime } from '../credits.js'
import { tokenPriceSchema, type TokenPrice } from '../billing/token-price.js'
import { resolveTokenPrice } from '../billing/resolve-token-price.js'
import { FALLBACK_USAGE_POLICY, priceTokenEvidence } from '../billing/reservation-policy.js'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'
import { savedRunUsageSchema, type PendingReviewCall } from './checkpoint.js'
import { assertAgentManuscriptCurrent } from './manuscript-scope.js'
import { readOriginalTaskRequest, originalTaskRunIds } from './original-request.js'
import { analyzeDeterministicQuality, buildHumanityQualityContext, getLatestQualityReport, HUMANITY_PROMPT_PROTOCOL, HUMANITY_CRITIC_VERSION, FROZEN_V5_HUMANITY_CRITIC_VERSION,
  persistHumanityQualityReport, prepareQualityFindings, qualityReviewContextHash } from './humanity-quality.js'
import { buildQualityEvidenceSources, inspectCorrectableCriticResponse } from './quality-evidence.js'
import { buildCriticInput, buildCriticSystem } from './tools/humanity-quality-tools.js'
import { runtimeJson } from './runtime-common.js'
import { creditModelTierSchema } from '../../../shared/contracts/credits.js'
import { estimateChatMessagesTokens } from './context-budget.js'
import { MAX_CREDIT_STORAGE_INT } from '../billing/pricing.js'
import { env } from '../../config/env.js'

type Subject = { userId: string; novelId: string; runId: string }
type Model = { weightedRoute?: WeightedRouteSelection; tier: CreditModelTier; customModelId: string | null; reasoningEffort: ModelReasoningEffort;
  provider: string; modelName: string; multiplierBps: number }
export type AuthorReviewReplacementAuthorization = {
  authorizationId: string; humanAuthorizationRef: string; subject: Subject; taskId: string;
  authority: { source: 'authenticated_author_action'; actorUserId: string; quoteNonce: string };
  pending: PendingReviewCall; originalUsageIds: string[];
  expected: { currentRevision: number; currentContentHash: string; qualityContextHash: string; promptHash: string; model: Model; price: TokenPrice };
  conservativeInputTokenCeiling: number; maxOutputTokens: number; maxModelRequests: 1; maxCreditMilli: number;
}
const action = 'agent3HumanityAuthorReplacement'
const eventTypes = { authorization: 'review.replacement.authorized', claim: 'review.replacement.claimed', observation: 'review.replacement.observed', completion: 'review.replacement.completed', failure: 'review.replacement.failed' } as const
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const hash = (value: unknown) => runtimeJson(json(value)).hash
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const eventId = (id: string, kind: keyof typeof eventTypes) => `ar${sha(`${kind}:${id}`).slice(0, 60)}`
const callId = (id: string) => `call_ar_${sha(id).slice(0, 40)}`
const marker = (id: string) => `author-replacement:${sha(id)}`
function reject(message: string): never { throw new DataAccessError(409, 'AUTHOR_REVIEW_REPLACEMENT_REFUSED', message) }
const idSchema = z.string().min(1).max(160)
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const pendingSchema = z.object({ compilationId: z.string().min(1).nullable(), chapterId: z.string().min(1), revision: z.number().int().positive(),
  toolName: z.literal('quality_analyze'), callId: z.string().min(1) }).strict()
const authorizationSchema = z.object({ authorizationId: idSchema, humanAuthorizationRef: z.string().startsWith('author-review-replacement:').max(160),
  authority: z.object({ source: z.literal('authenticated_author_action'), actorUserId: z.string().min(1).max(64), quoteNonce: z.string().uuid() }).strict(),
  subject: z.object({ userId: z.string().min(1), novelId: z.string().min(1), runId: z.string().min(1) }).strict(), taskId: z.string().min(1),
  pending: pendingSchema, originalUsageIds: z.array(z.string().min(1)).length(1),
  expected: z.object({ currentRevision: z.number().int().positive(), currentContentHash: digest, qualityContextHash: digest, promptHash: digest,
    model: z.object({ weightedRoute: weightedRouteSelectionSchema.optional(), tier: creditModelTierSchema, customModelId: z.string().nullable(),
      reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']), provider: z.string().min(1), modelName: z.string().min(1), multiplierBps: z.number().int().nonnegative() }).strict(), price: tokenPriceSchema }).strict(),
  conservativeInputTokenCeiling: z.number().int().positive().max(2147483647), maxOutputTokens: z.number().int().positive().max(16384),
  maxModelRequests: z.literal(1), maxCreditMilli: z.number().int().min(0).max(MAX_CREDIT_STORAGE_INT),
}).strict()
type Frozen = AuthorReviewReplacementAuthorization & { version: 1; newCallId: string; sourceCallEventId: string; sourceResultId: string;
  lineageIds: string[]; specHash: string; originalUsageHash: string; sourceEventsHash: string; budget: { currentTurn: number; usage: Prisma.JsonValue };
  criticPromptProtocol?: 'humanity-context.v5' | 'humanity-context.v6' | typeof HUMANITY_PROMPT_PROTOCOL;
  criticVersion: typeof HUMANITY_CRITIC_VERSION | typeof FROZEN_V5_HUMANITY_CRITIC_VERSION; baselineUsage: Array<{ id: string; hash: string }>; quotedMaximumCreditMilli: number }
type Completion = { version: 1; authorizationId: string; authorizationEventId: string; claimEventId: string; frozenHash: string;
  observationEventId: string; observationHash: string; newCallId: string; reportId: string; reportHash: string; responseHash: string; finishReason: string | null; toolCalls: number; newUsageIds: string[] }
export type AuthorReviewResponseObservation = { authorizationId: string; newCallId: string; rawResponse: string; finishReason: string | null;
  toolCalls: readonly unknown[]; newUsageIds: string[] }
const responseObservationInputSchema = z.object({ authorizationId: idSchema, newCallId: z.string().min(1), rawResponse: z.string().min(1),
  finishReason: z.string().nullable(), toolCalls: z.array(z.unknown()), newUsageIds: z.array(z.string().min(1).max(64)).length(1) }).strict()
const observationSchema = z.object({ version: z.literal(1), authorizationId: idSchema, authorizationEventId: z.string().min(1), claimEventId: z.string().min(1),
  frozenHash: digest, newCallId: z.string().min(1), newUsageIds: z.array(z.string().min(1).max(64)).length(1), response: z.object({
    encoding: z.literal('json-string'), content: z.string(), contentHash: digest, characterCount: z.number().int().positive(),
    finishReason: z.string().nullable(), toolCalls: z.array(z.unknown()),
  }).strict() }).strict()
const frozenSchema = authorizationSchema.extend({ version: z.literal(1), newCallId: z.string().min(1), sourceCallEventId: z.string().min(1),
  sourceResultId: z.string().min(1), lineageIds: z.array(z.string().min(1)).min(1), specHash: digest, originalUsageHash: digest, sourceEventsHash: digest,
  budget: z.object({ currentTurn: z.number().int().nonnegative(), usage: z.record(z.string(), z.unknown()) }).strict(),
  criticPromptProtocol: z.enum(['humanity-context.v5', 'humanity-context.v6', HUMANITY_PROMPT_PROTOCOL]).optional(),
  criticVersion: z.union([z.literal(HUMANITY_CRITIC_VERSION), z.literal(FROZEN_V5_HUMANITY_CRITIC_VERSION)]), baselineUsage: z.array(z.object({ id: z.string().min(1), hash: digest }).strict()).min(1),
  quotedMaximumCreditMilli: z.number().int().nonnegative().max(MAX_CREDIT_STORAGE_INT),
}).strict()
const completionSchema = z.object({ version: z.literal(1), authorizationId: idSchema, authorizationEventId: z.string().min(1),
  claimEventId: z.string().min(1), frozenHash: digest, newCallId: z.string().min(1), reportId: z.string().min(1), reportHash: digest,
  observationEventId: z.string().min(1), observationHash: digest,
  responseHash: digest, finishReason: z.string().nullable(), toolCalls: z.number().int().nonnegative(), newUsageIds: z.array(z.string().min(1)).length(1) }).strict()

async function append(tx: Prisma.TransactionClient, runId: string, id: string, type: string, value: unknown) {
  const payload = { value: json(value), hash: hash(value) }
  const last = await tx.agentRunEvent.findFirst({ where: { runId }, orderBy: { seq: 'desc' }, select: { seq: true } })
  return tx.agentRunEvent.create({ data: { id, runId, seq: (last?.seq ?? 0) + 1, type, payload: runtimeJson(payload).value } })
}
function unpack<T>(event: AgentRunEvent | null, id: string, kind: keyof typeof eventTypes): T {
  if (!event || event.id !== eventId(id, kind) || event.type !== eventTypes[kind]) reject('独立检查的持久证据缺失。')
  const payload = object(event.payload)
  if (!payload.value || payload.hash !== hash(payload.value)) reject('独立检查的持久证据损坏。')
  return payload.value as T
}
async function frozenFor(tx: Prisma.TransactionClient, authorizationId: string) {
  const event = await tx.agentRunEvent.findUnique({ where: { id: eventId(authorizationId, 'authorization') } })
  const frozen = frozenSchema.parse(unpack<Frozen>(event, authorizationId, 'authorization')) as Frozen
  if (!validAuthority(frozen) || frozen.authorizationId !== authorizationId || event!.runId !== frozen.subject.runId
    || frozen.newCallId !== callId(authorizationId)) reject('独立检查授权身份不一致。')
  return { frozen, event: event! }
}
function validAuthority(input: AuthorReviewReplacementAuthorization) {
  const reference = `author-review-replacement:${input.authority.actorUserId}:${input.authority.quoteNonce}`
  return input.authority.actorUserId === input.subject.userId && input.authorizationId === reference && input.humanAuthorizationRef === reference
}

async function lock(tx: Prisma.TransactionClient, subject: Subject) {
  await lockNovelActiveScope(tx, subject.novelId)
  await tx.$queryRaw`SELECT id FROM agent_runs WHERE id = ${subject.runId} AND user_id = ${subject.userId} FOR UPDATE`
  await assertAgentManuscriptCurrent(tx, subject)
}
function inScope(spec: unknown, novelId: string, chapter: { id: string; orderIndex: number }) {
  const scope = object(object(spec).scope), writing = object(scope.writing)
  return scope.novelId === novelId && (writing.kind === 'bounded' ? Array.isArray(writing.targets) && writing.targets.some(value => {
    const target = object(value)
    return target.orderIndex === chapter.orderIndex && (target.chapterId == null || target.chapterId === chapter.id)
  }) : writing.kind === 'unbounded' || Array.isArray(scope.chapterIds) && scope.chapterIds.includes(chapter.id))
}
function budgetPreserved(current: Prisma.JsonValue | null, frozen: Frozen, reading: boolean) {
  const saved = savedRunUsageSchema.safeParse(current), before = savedRunUsageSchema.safeParse(frozen.budget.usage)
  if (!saved.success || !before.success || !saved.data.checkpoint || !before.data.checkpoint) return false
  const now = saved.data.checkpoint, old = before.data.checkpoint, key = marker(frozen.authorizationId)
  if (!now.reviewAttempts?.includes(key) || (old.reviewAttempts ?? []).some(attempt => !now.reviewAttempts?.includes(attempt))) return false
  if (!reading) {
    const expected = json(frozen.budget.usage) as Prisma.JsonObject
    expected.checkpoint = { ...object(expected.checkpoint), reviewAttempts: [...(old.reviewAttempts ?? []), key] }
    return hash(current) === hash(expected)
  }
  // A subsequent normal Continue can consume the dependency. It cannot refill
  // stored budgets or erase the original attempt/consumption history.
  if (now.maxTurns !== old.maxTurns || now.tokenBudget !== old.tokenBudget || saved.data.totalTokens < before.data.totalTokens
    || saved.data.promptTokens < before.data.promptTokens || saved.data.completionTokens < before.data.completionTokens
    || now.version !== old.version || now.version === 2 && old.version === 2 && (now.origin !== old.origin || now.activeExecutionMs < old.activeExecutionMs)
    || now.runStartedAt > old.runStartedAt) return false
  return ['resumeCount', 'compactionCount', 'manualResumeCount', 'inheritedTokens', 'inheritedTurns', 'inheritedExecutionMs', 'reviewHandoffCount', 'writeProgress', 'readProgress'].every(key =>
    object(old)[key] === undefined || typeof object(now)[key] === 'number' && Number(object(now)[key]) >= Number(object(old)[key]))
}

/** Old authorizations predate a separate prompt version. Keep their original
 * v5/v6 inference; only newly admitted work binds the current prompt explicitly. */
function replacementPromptProtocol(frozen?: Pick<Frozen, 'criticVersion' | 'criticPromptProtocol'>) {
  return frozen?.criticPromptProtocol ?? (frozen ? frozen.criticVersion === FROZEN_V5_HUMANITY_CRITIC_VERSION
    ? 'humanity-context.v5' : 'humanity-context.v6' : HUMANITY_PROMPT_PROTOCOL)
}

async function current(tx: Prisma.TransactionClient, input: AuthorReviewReplacementAuthorization, frozen?: Frozen, reading = false) {
  const { subject, pending } = input
  const protocol = replacementPromptProtocol(frozen ?? ('criticVersion' in input ? input as Frozen : undefined))
  const run = await tx.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId } })
  if (!run || run.taskRootId || run.runtimeProtocolVersion !== 0 || (!reading && !['failed', 'paused'].includes(run.status))
    || ['completed', 'cancelled'].includes(run.status) || object(run.usage).authorEnded !== undefined
    || await tx.agentGoalExecution.findUnique({ where: { runId: run.id } })) reject('任务未停止、已结束或存在不支持的执行权限。')
  const saved = savedRunUsageSchema.safeParse(run.usage)
  if (!saved.success || saved.data.checkpoint?.version !== 2 || saved.data.checkpoint.controlPolicy !== 'until_completion') reject('原预算与检查点无法核实。')
  const original = await readOriginalTaskRequest(tx, subject), ids = await originalTaskRunIds(tx, subject, original)
  if (original.taskId !== input.taskId || object(original.spec).controlPolicy !== 'until_completion' || original.parentRunId !== null
    || original.sourceRunId !== subject.runId) reject('原作者任务身份或有效预算策略不一致。')
  if (!reading && !(saved.data.checkpoint.pendingReviews ?? []).some(item => hash(item) === hash(pending))) reject('原请求已不在待确认依赖中。')
  const bundle = await buildHumanityQualityContext(subject.userId, subject.novelId, pending.chapterId, subject.runId, tx)
  if (!inScope(original.spec, subject.novelId, bundle.chapter) || bundle.chapter.revision !== input.expected.currentRevision || input.expected.currentRevision < pending.revision
    || bundle.compilation?.id !== pending.compilationId || !bundle.compilation || !ids.includes(bundle.compilation.runId ?? '')
    || bundle.compilation.status !== 'active' || sha(bundle.chapter.content) !== input.expected.currentContentHash
    || qualityReviewContextHash(bundle, protocol) !== input.expected.qualityContextHash) reject('当前正文、完整上下文或原任务范围已变化。')
  const events = await tx.agentRunEvent.findMany({ where: { runId: { in: ids }, type: { in: ['tool.call', 'tool.result'] },
    payload: { path: ['callId'], equals: pending.callId } }, orderBy: { seq: 'asc' } })
  const calls = events.filter(event => event.type === 'tool.call'), results = events.filter(event => event.type === 'tool.result')
  if (calls.length !== 1 || results.length !== 1) reject('原请求缺少唯一实际调用与失败记录。')
  const call = calls[0], result = results[0], args = object(object(call.payload).args)
  if (call.runId !== subject.runId || result.runId !== call.runId || result.seq <= call.seq || result.createdAt < call.createdAt
    || object(call.payload).toolName !== 'quality_analyze' || object(result.payload).toolName !== 'quality_analyze' || object(result.payload).ok !== false
    || !(args.chapterId === pending.chapterId || args.compilationId === pending.compilationId)
    || args.chapterId !== undefined && args.chapterId !== pending.chapterId || args.compilationId !== undefined && args.compilationId !== pending.compilationId) reject('原请求的目标与失败身份不一致。')
  const oldUsage = await tx.aiUsageLog.findMany({ where: { userId: subject.userId, novelId: subject.novelId, id: { in: input.originalUsageIds } }, orderBy: { id: 'asc' } })
  if (oldUsage.length !== 1 || oldUsage.some(row => row.chapterId !== pending.chapterId || row.targetId !== pending.chapterId
    || row.agentRunId !== null && !ids.includes(row.agentRunId) || row.action !== 'agent3HumanityCritic'
    || row.createdAt < call.createdAt || row.createdAt > result.createdAt || row.usageSource !== 'unknown' || row.billingStatus !== 'pending_usage'
    || row.requestTokens !== null || row.responseTokens !== null || row.reservedCreditMilli <= 0 || object(row.billingEvidence).responseObserved !== false)) reject('原未知请求账目不匹配或已变化。')
  // A completed report/charge belongs to its frozen request. Later main-model
  // selection or tariff changes do not revoke those authenticated facts.
  const model = input.expected.model
  if (!reading) {
    if (run.modelTier !== model.tier || run.customModelId !== model.customModelId || run.reasoningEffort !== model.reasoningEffort) reject('任务的当前模型选择已变化。')
    const runtime = resolveWeightedModelRuntime(await getModelTierRuntime(model.tier, subject.userId, model.customModelId, model.reasoningEffort), model.weightedRoute)
    const liveModel: Model = { ...(runtime.weightedRoute ? { weightedRoute: runtime.weightedRoute } : {}), tier: runtime.tier, customModelId: model.customModelId, reasoningEffort: runtime.reasoningEffort,
      provider: runtime.provider, modelName: runtime.modelName ?? env.aiTextModel, multiplierBps: runtime.multiplierBps }
    if (hash(liveModel) !== hash(model) || hash(await resolveTokenPrice(model.tier, model.multiplierBps)) !== hash(input.expected.price)) reject('当前模型选择、配置或冻结费率已变化。')
  }
  const deterministic = analyzeDeterministicQuality(bundle.chapter.content, bundle.recentChapters.map(item => item.content))
  const sources = buildQualityEvidenceSources({ userId: subject.userId, novelId: subject.novelId, chapterId: pending.chapterId, chapterRevision: input.expected.currentRevision }, bundle.chapter.content)
  const system = buildCriticSystem('balanced', protocol), content = buildCriticInput(bundle, deterministic.metrics, sources, protocol)
  if (sha(JSON.stringify({ system, content })) !== input.expected.promptHash || input.conservativeInputTokenCeiling < estimateChatMessagesTokens([
    { role: 'system', content: system }, { role: 'user', content },
  ])) reject('实际提示词或保守输入上限不一致。')
  const quote = priceTokenEvidence(input.expected.price, input.conservativeInputTokenCeiling, input.maxOutputTokens, 0)
  if (quote !== input.maxCreditMilli || input.expected.price.modelTier !== model.tier || input.expected.price.multiplierBps !== model.multiplierBps) reject('授权金额与当前模型的正常输出上限报价不一致。')
  if (frozen && (frozen.specHash !== hash(original.spec) || hash([...ids].sort()) !== hash(frozen.lineageIds)
    || frozen.originalUsageHash !== hash(oldUsage) || frozen.sourceEventsHash !== hash(events)
    || frozen.sourceCallEventId !== call.id || frozen.sourceResultId !== result.id || frozen.quotedMaximumCreditMilli !== quote
    || run.currentTurn < frozen.budget.currentTurn || !budgetPreserved(run.usage, frozen, reading))) reject('原账目、任务或预算证据已变化。')
  return { run, original, ids, bundle, events, call, result, oldUsage, deterministic, sources, system, content, quote }
}

async function enoughCredit(tx: Prisma.TransactionClient, subject: Subject, quote: number) {
  if (quote === 0) return
  await tx.$queryRaw`SELECT user_id FROM credit_accounts WHERE user_id = ${subject.userId} FOR UPDATE`
  const account = await tx.creditAccount.findUnique({ where: { userId: subject.userId } })
  const held = await tx.aiUsageLog.aggregate({ where: { userId: subject.userId, reservedCreditMilli: { gt: 0 } }, _sum: { reservedCreditMilli: true } })
  if (!account || account.suspendedAt || ![account.dailyAllowanceMilli, account.dailyUsedMilli, account.bonusBalanceMilli].every(Number.isSafeInteger)
    || Math.max(0, account.dailyAllowanceMilli - account.dailyUsedMilli) + account.bonusBalanceMilli - (held._sum.reservedCreditMilli ?? 0) < quote) reject('当前真实可用额度不足，原未知预留与预算保留。')
}

/** Called only after the server verifies the authenticated actor and signed
 * quote. Never deserialize this authority tuple directly from a client/tool. */
export async function authorizeAuthorReviewReplacement(tx: Prisma.TransactionClient, trustedInput: AuthorReviewReplacementAuthorization) {
  const parsed = authorizationSchema.safeParse(trustedInput)
  if (!parsed.success) reject('独立检查授权字段无效。')
  const input = parsed.data as AuthorReviewReplacementAuthorization
  if (!validAuthority(input)) reject('作者身份与服务器生成的唯一报价确认编号不一致。')
  await lock(tx, input.subject)
  const live = await current(tx, input)
  const earlier = await tx.agentRunEvent.findMany({ where: { runId: input.subject.runId, type: eventTypes.authorization }, orderBy: { seq: 'asc' }, take: 101 })
  if (earlier.length > 100) reject('独立检查历史过多，必须先核对已有结果。')
  for (const old of earlier) {
    const id = object(object(old.payload).value).authorizationId
    if (typeof id !== 'string') reject('已有检查的授权证据损坏，不能重发。')
    const previous = await frozenFor(tx, id)
    if (hash(previous.frozen.subject) !== hash(input.subject) || previous.frozen.taskId !== input.taskId || hash(previous.frozen.pending) !== hash(input.pending)) continue
    const claimed = await tx.agentRunEvent.findUnique({ where: { id: eventId(id, 'claim') } })
    const completed = await tx.agentRunEvent.findUnique({ where: { id: eventId(id, 'completion') } })
    if (!claimed || !completed) reject('此原请求已有未决独立检查，换报价编号不能再次派发。')
    const claim = unpack<Record<string, unknown>>(claimed, id, 'claim')
    const completion = completionSchema.parse(unpack<Completion>(completed, id, 'completion'))
    if (claim.frozenHash !== hash(previous.frozen) || completion.frozenHash !== hash(previous.frozen)
      || claim.newCallId !== previous.frozen.newCallId || completion.newCallId !== previous.frozen.newCallId
      || completion.claimEventId !== claimed.id || claimed.runId !== old.runId || completed.runId !== old.runId
      || completed.seq <= claimed.seq || !await knownNewUsage(tx, previous.frozen, completion, claimed.createdAt, completed.createdAt)) reject('已有独立请求结果或费用仍未知，不能重复购买。')
    if (previous.frozen.expected.currentContentHash === input.expected.currentContentHash) {
      const receipt = (await readAuthorReviewReplacements(tx, input.subject, [input.pending])).find(row => row.replacementReceipt.authorizationId === id)?.replacementReceipt
      if (!receipt) reject('同一正文的独立检查已尝试但未完整完成，换编号不能重买。')
      return { status: 'replayed' as const, authorizationEventId: receipt.authorizationEventId, newCallId: receipt.newCallId, replacementReceipt: receipt }
    }
  }
  if (await tx.agentRunEvent.findUnique({ where: { id: eventId(input.authorizationId, 'authorization') } })) reject('此作者报价确认编号已使用。')
  const latest = await getLatestQualityReport(input.subject.userId, input.subject.novelId, input.pending.chapterId, tx, input.pending.compilationId)
  if (latest?.chapterRevision === input.expected.currentRevision) reject('当前版本已有报告；不能把新授权用于重买检查。')
  await enoughCredit(tx, input.subject, live.quote)
  const baseline = await tx.aiUsageLog.findMany({ where: { userId: input.subject.userId, novelId: input.subject.novelId,
    OR: [{ agentRunId: { in: live.ids } }, { targetId: { in: [input.pending.chapterId, input.pending.compilationId!] } }] }, orderBy: { id: 'asc' } })
  const frozen: Frozen = { ...input, version: 1, newCallId: callId(input.authorizationId), sourceCallEventId: live.call.id,
    sourceResultId: live.result.id, lineageIds: [...live.ids].sort(), specHash: hash(live.original.spec), sourceEventsHash: hash(live.events),
    originalUsageHash: hash(live.oldUsage), budget: { currentTurn: live.run.currentTurn, usage: live.run.usage! }, criticPromptProtocol: HUMANITY_PROMPT_PROTOCOL, criticVersion: HUMANITY_CRITIC_VERSION,
    baselineUsage: baseline.map(row => ({ id: row.id, hash: hash(row) })), quotedMaximumCreditMilli: live.quote }
  const event = await append(tx, input.subject.runId, eventId(input.authorizationId, 'authorization'), eventTypes.authorization, frozen)
  return { status: 'authorized' as const, authorizationEventId: event.id, newCallId: frozen.newCallId }
}

/** Commit this transaction BEFORE any HTTP. A claim with no result is unknown;
 * there is deliberately no recovery path that returns a second dispatch plan. */
export async function claimAuthorReviewReplacement(tx: Prisma.TransactionClient, authorizationId: string) {
  const { frozen, event } = await frozenFor(tx, authorizationId)
  await lock(tx, frozen.subject)
  if (await tx.agentRunEvent.findUnique({ where: { id: eventId(authorizationId, 'claim') } })) reject('作者许可已领取；缺少结果仍属未知，不能再派发。')
  if (await tx.aiUsageLog.count({ where: { targetId: frozen.newCallId } })) reject('领取前已有此独立请求的账目，不能再次派发。')
  const live = await current(tx, frozen)
  if (hash(live.run.usage) !== hash(frozen.budget.usage) || live.run.currentTurn !== frozen.budget.currentTurn) reject('领取前原预算或计数已变化。')
  const latest = await getLatestQualityReport(frozen.subject.userId, frozen.subject.novelId, frozen.pending.chapterId, tx, frozen.pending.compilationId)
  if (latest?.chapterRevision === frozen.expected.currentRevision) reject('领取前当前版本已经有报告。')
  await enoughCredit(tx, frozen.subject, live.quote)
  const claim = await append(tx, frozen.subject.runId, eventId(authorizationId, 'claim'), eventTypes.claim,
    { version: 1, authorizationId, authorizationEventId: event.id, frozenHash: hash(frozen), newCallId: frozen.newCallId })
  const usage = json(live.run.usage) as Prisma.JsonObject, checkpoint = object(usage.checkpoint)
  usage.checkpoint = { ...checkpoint, reviewAttempts: [...(checkpoint.reviewAttempts as string[] ?? []), marker(authorizationId)] }
  await tx.agentRun.update({ where: { id: frozen.subject.runId }, data: { usage: runtimeJson(usage).value } })
  return Object.freeze({ authorizationId, authorizationEventId: event.id, claimEventId: claim.id, newCallId: frozen.newCallId,
    system: live.system, content: live.content, promptHash: frozen.expected.promptHash,
    model: Object.freeze({ ...frozen.expected.model }), price: Object.freeze(json(frozen.expected.price)),
    action, targetType: 'chapter' as const, targetId: frozen.newCallId, ...frozen.subject, chapterId: frozen.pending.chapterId,
    maxOutputTokens: frozen.maxOutputTokens, maxModelRequests: 1 as const, maxCreditMilli: frozen.maxCreditMilli,
    conservativeInputTokenCeiling: frozen.conservativeInputTokenCeiling,
    quotedMaximumCreditMilli: live.quote })
}

/** Final read-only check immediately before the author's sole HTTP request.
 * This never returns an unclaimed plan or authorizes redispatch after a crash. */
export async function validateClaimAuthorReviewReplacement(tx: Prisma.TransactionClient, authorizationId: string) {
  const { frozen, event } = await frozenFor(tx, authorizationId)
  const claimed = await tx.agentRunEvent.findUnique({ where: { id: eventId(authorizationId, 'claim') } })
  const claim = unpack<Record<string, unknown>>(claimed, authorizationId, 'claim')
  if (claim.version !== 1 || claim.authorizationId !== authorizationId || claim.authorizationEventId !== event.id
    || claim.frozenHash !== hash(frozen) || claim.newCallId !== frozen.newCallId || claimed!.runId !== frozen.subject.runId
    || await tx.agentRunEvent.findUnique({ where: { id: eventId(authorizationId, 'completion') } })
    || await tx.agentRunEvent.findUnique({ where: { id: eventId(authorizationId, 'observation') } })
    || await tx.agentRunEvent.findUnique({ where: { id: eventId(authorizationId, 'failure') } })) reject('此领取已出现请求证据，不能再次派发。')
  const rows = await tx.aiUsageLog.findMany({ where: { targetId: frozen.newCallId } })
  if (rows.length !== 1) reject('此领取缺少唯一真实预备账目，不能派发。')
  {
    const row = rows[0], evidence = object(row.billingEvidence)
    if (row.userId !== frozen.subject.userId || row.novelId !== frozen.subject.novelId || row.chapterId !== frozen.pending.chapterId
      || row.agentRunId !== frozen.subject.runId || row.targetType !== 'chapter' || row.action !== action || row.providerType !== 'text'
      || row.providerName !== frozen.expected.model.provider || row.modelName !== frozen.expected.model.modelName
      || row.modelTier !== frozen.expected.model.tier || row.multiplierBps !== frozen.expected.model.multiplierBps
      || hash(row.billingSnapshot) !== hash(frozen.expected.price) || row.usageSource !== 'prepared' || !['authorized_pending', 'prepared'].includes(row.billingStatus ?? '')
      || row.requestTokens !== null || row.responseTokens !== null || row.turn !== null || row.creditChargeMilli !== 0 || row.durationMs !== 0
      || !Number.isSafeInteger(row.reservedCreditMilli) || row.reservedCreditMilli < 0 || row.reservedCreditMilli > frozen.maxCreditMilli
      || row.createdAt < claimed!.createdAt || row.billingRetryAt !== null
      || !Number.isSafeInteger(evidence.inputEstimate) || Number(evidence.inputEstimate) < 0 || Number(evidence.inputEstimate) > frozen.conservativeInputTokenCeiling
      || hash(evidence) !== hash({ policy: FALLBACK_USAGE_POLICY, inputEstimate: evidence.inputEstimate, outputEstimate: 0, responseObserved: false })
      || await tx.creditLedgerEntry.findUnique({ where: { idempotencyKey: `usage:${row.id}` } })) reject('预备账目已发送、已观察响应或不属于此冻结请求，不能派发。')
  }
  await current(tx, frozen, frozen)
}

function reportHash(report: NonNullable<Awaited<ReturnType<typeof getLatestQualityReport>>>) {
  return hash({ id: report.id, userId: report.userId, novelId: report.novelId, runId: report.runId, compilationId: report.compilationId,
    chapterId: report.chapterId, chapterRevision: report.chapterRevision, mode: report.mode, status: report.status, repairRound: report.repairRound,
    criticVersion: report.criticVersion, deterministicMetrics: report.deterministicMetrics,
    findings: [...report.findings].sort((a, b) => a.id.localeCompare(b.id)).map(row => ({ id: row.id, signal: row.signal, source: row.source,
      severity: row.severity, startOffset: row.startOffset, endOffset: row.endOffset, evidenceExcerpt: row.evidenceExcerpt,
      evidenceHash: row.evidenceHash, explanation: row.explanation, suggestion: row.suggestion, confidence: row.confidence })) })
}

function responseAudit(input: AuthorReviewResponseObservation) {
  return { encoding: 'json-string' as const, content: JSON.stringify(input.rawResponse), contentHash: sha(input.rawResponse),
    characterCount: input.rawResponse.length, finishReason: input.finishReason, toolCalls: json(input.toolCalls) }
}
async function observedFor(tx: Prisma.TransactionClient, frozen: Frozen, authorization: AgentRunEvent, claim: AgentRunEvent) {
  const event = await tx.agentRunEvent.findUnique({ where: { id: eventId(frozen.authorizationId, 'observation') } })
  const value = observationSchema.parse(unpack(event, frozen.authorizationId, 'observation'))
  if (value.authorizationId !== frozen.authorizationId || value.authorizationEventId !== authorization.id || value.claimEventId !== claim.id
    || value.frozenHash !== hash(frozen) || value.newCallId !== frozen.newCallId || event!.runId !== frozen.subject.runId
    || event!.seq <= claim.seq || event!.createdAt < claim.createdAt) reject('真实响应观察的独立领取绑定不一致。')
  const raw: unknown = JSON.parse(value.response.content)
  if (typeof raw !== 'string' || sha(raw) !== value.response.contentHash || raw.length !== value.response.characterCount) reject('真实响应观察的原文审计损坏。')
  return { event: event!, value }
}

/** Commit independently BEFORE validating current manuscript/model/report state.
 * A late real response is audit data, never permission to alter stale content. */
export async function observeAuthorReviewResponse(tx: Prisma.TransactionClient, input: AuthorReviewResponseObservation) {
  const parsed = responseObservationInputSchema.parse(input), { frozen, event } = await frozenFor(tx, parsed.authorizationId)
  await tx.$queryRaw`SELECT id FROM agent_runs WHERE id = ${frozen.subject.runId} AND user_id = ${frozen.subject.userId} FOR UPDATE`
  if (!await tx.agentRun.findFirst({ where: { id: frozen.subject.runId, userId: frozen.subject.userId, novelId: frozen.subject.novelId } })) reject('响应观察不属于原作者任务。')
  const claimed = await tx.agentRunEvent.findUnique({ where: { id: eventId(parsed.authorizationId, 'claim') } })
  const claim = unpack<Record<string, unknown>>(claimed, parsed.authorizationId, 'claim')
  if (claim.version !== 1 || claim.authorizationId !== parsed.authorizationId || claim.authorizationEventId !== event.id
    || claim.frozenHash !== hash(frozen) || claim.newCallId !== parsed.newCallId || parsed.newCallId !== frozen.newCallId
    || claimed!.runId !== frozen.subject.runId || claimed!.seq <= event.seq) reject('响应观察无法绑定唯一真实领取。')
  const usages = await tx.aiUsageLog.findMany({ where: { targetId: frozen.newCallId } })
  if (usages.length !== 1 || usages[0].id !== parsed.newUsageIds[0] || frozen.originalUsageIds.includes(usages[0].id)
    || usages[0].userId !== frozen.subject.userId || usages[0].novelId !== frozen.subject.novelId || usages[0].chapterId !== frozen.pending.chapterId
    || usages[0].agentRunId !== frozen.subject.runId || usages[0].targetType !== 'chapter' || usages[0].action !== action
    || usages[0].providerType !== 'text' || usages[0].providerName !== frozen.expected.model.provider || usages[0].modelName !== frozen.expected.model.modelName
    || usages[0].modelTier !== frozen.expected.model.tier || usages[0].multiplierBps !== frozen.expected.model.multiplierBps
    || hash(usages[0].billingSnapshot) !== hash(frozen.expected.price) || usages[0].createdAt < claimed!.createdAt) reject('响应观察缺少唯一属于此领取与冻结模型价格的真实新账目。')
  const value = { version: 1, authorizationId: parsed.authorizationId, authorizationEventId: event.id, claimEventId: claimed!.id,
    frozenHash: hash(frozen), newCallId: frozen.newCallId, newUsageIds: parsed.newUsageIds, response: responseAudit(parsed) }
  const existing = await tx.agentRunEvent.findUnique({ where: { id: eventId(parsed.authorizationId, 'observation') } })
  if (existing) {
    const saved = await observedFor(tx, frozen, event, claimed!)
    if (hash(saved.value) !== hash(value)) reject('此领取的实际响应已保存，不能替换原文或元数据。')
    return { observationEventId: saved.event.id }
  }
  const observed = await append(tx, frozen.subject.runId, eventId(parsed.authorizationId, 'observation'), eventTypes.observation, value)
  return { observationEventId: observed.id }
}

export async function completeAuthorReviewReplacement(tx: Prisma.TransactionClient, input: {
  authorizationId: string; newCallId: string; rawResponse: string; finishReason: string | null; toolCalls: readonly unknown[]; newUsageIds: string[];
}) {
  const { frozen, event } = await frozenFor(tx, input.authorizationId)
  await lock(tx, frozen.subject)
  const claimEvent = await tx.agentRunEvent.findUnique({ where: { id: eventId(input.authorizationId, 'claim') } })
  const claim = unpack<Record<string, unknown>>(claimEvent, input.authorizationId, 'claim')
  if (claim.authorizationEventId !== event.id || claim.frozenHash !== hash(frozen) || claim.newCallId !== input.newCallId
    || input.newCallId !== frozen.newCallId || claimEvent!.runId !== frozen.subject.runId) reject('检查结果不能绑定此唯一派发。')
  if (await tx.agentRunEvent.findUnique({ where: { id: eventId(input.authorizationId, 'completion') } })) reject('结果已保存；读取实际回执，不重复写入。')
  if (typeof input.rawResponse !== 'string' || !input.rawResponse.length || !Array.isArray(input.toolCalls)
    || input.newUsageIds.length !== 1 || new Set(input.newUsageIds).size !== 1 || input.newUsageIds.some(id => !id || frozen.originalUsageIds.includes(id))) reject('真实响应与独立用量身份缺失。')
  const observed = await observedFor(tx, frozen, event, claimEvent!)
  if (hash(observed.value.newUsageIds) !== hash(input.newUsageIds) || hash(observed.value.response) !== hash(responseAudit(input))) reject('报告提交与先前持久化的真实响应不一致。')
  const live = await current(tx, frozen, frozen)
  const latest = await getLatestQualityReport(frozen.subject.userId, frozen.subject.novelId, frozen.pending.chapterId, tx, frozen.pending.compilationId)
  if (latest?.chapterRevision === frozen.expected.currentRevision) reject('当前报告已变化，不能覆盖已有报告。')
  const inspected = inspectCorrectableCriticResponse(input.rawResponse, live.sources, input.finishReason === 'stop' && input.toolCalls.length === 0, 3)
  const prepared = prepareQualityFindings(live.bundle.chapter.content, live.deterministic.findings, inspected.findings, inspected.complete, live.sources, 3)
  const complete = inspected.complete && !inspected.diagnostic.droppedFindings && !inspected.diagnostic.invalidSources && !prepared.unlocatedFindings && !prepared.omittedFindings
  const report = await persistHumanityQualityReport({ ...frozen.subject, compilationId: frozen.pending.compilationId!, chapterId: frozen.pending.chapterId,
    chapterRevision: frozen.expected.currentRevision, mode: live.bundle.compilation!.mode, deterministicMetrics: live.deterministic.metrics,
    qualityContextHash: frozen.expected.qualityContextHash, criticVersion: frozen.criticVersion,
    criticPromptProtocol: replacementPromptProtocol(frozen), sources: live.sources,
    deterministicFindings: live.deterministic.findings, criticFindings: inspected.findings, criticComplete: complete,
    criticDropped: inspected.diagnostic.droppedFindings, criticResponseDiagnostic: { ...inspected.diagnostic, callId: frozen.newCallId } }, tx)
  const actual = await tx.chapterQualityReport.findFirstOrThrow({ where: { id: report.id }, include: { findings: true } })
  const completion: Completion = { version: 1, authorizationId: input.authorizationId, authorizationEventId: event.id, claimEventId: claimEvent!.id,
    observationEventId: observed.event.id, observationHash: hash(observed.value),
    frozenHash: hash(frozen), newCallId: frozen.newCallId, reportId: report.id, reportHash: reportHash(actual), responseHash: sha(input.rawResponse),
    finishReason: input.finishReason, toolCalls: input.toolCalls.length, newUsageIds: [...input.newUsageIds] }
  const completed = await append(tx, frozen.subject.runId, eventId(input.authorizationId, 'completion'), eventTypes.completion, completion)
  return { reportId: report.id, completionEventId: completed.id, reportStatus: report.status }
}

/** Preserve an actual transport failure without manufacturing a report, known
 * billing, or another dispatch allowance. This remains auditable after cancel. */
export async function failAuthorReviewReplacement(tx: Prisma.TransactionClient, authorizationId: string, input: { failureCode: string; usageIds: string[];
  observedResponse?: { content: string; finishReason: string | null; toolCalls: unknown[] } }) {
  const parsed = z.object({ failureCode: z.string().min(1).max(64), usageIds: z.array(z.string().min(1).max(64)).max(1),
    observedResponse: z.object({ content: z.string().min(1), finishReason: z.string().nullable(), toolCalls: z.array(z.unknown()) }).strict().optional() }).strict().parse(input)
  const { frozen, event } = await frozenFor(tx, authorizationId)
  if (parsed.observedResponse) await observeAuthorReviewResponse(tx, { authorizationId, newCallId: frozen.newCallId, rawResponse: parsed.observedResponse.content,
    finishReason: parsed.observedResponse.finishReason, toolCalls: parsed.observedResponse.toolCalls, newUsageIds: parsed.usageIds })
  await tx.$queryRaw`SELECT id FROM agent_runs WHERE id = ${frozen.subject.runId} AND user_id = ${frozen.subject.userId} FOR UPDATE`
  if (!await tx.agentRun.findFirst({ where: { id: frozen.subject.runId, userId: frozen.subject.userId, novelId: frozen.subject.novelId } })) reject('失败观察不属于当前作者任务。')
  const claimed = await tx.agentRunEvent.findUnique({ where: { id: eventId(authorizationId, 'claim') } })
  const claim = unpack<Record<string, unknown>>(claimed, authorizationId, 'claim')
  if (claim.frozenHash !== hash(frozen) || claim.authorizationEventId !== event.id || claim.newCallId !== frozen.newCallId || claimed!.runId !== frozen.subject.runId
    || await tx.agentRunEvent.findUnique({ where: { id: eventId(authorizationId, 'completion') } })) reject('实际请求已完成或失败观察的领取证据不一致。')
  const existing = await tx.agentRunEvent.findUnique({ where: { id: eventId(authorizationId, 'failure') } })
  if (existing) {
    unpack(existing, authorizationId, 'failure')
    return { failureEventId: existing.id }
  }
  if (parsed.usageIds.length) {
    const observed = await tx.aiUsageLog.findMany({ where: { id: { in: parsed.usageIds }, userId: frozen.subject.userId,
      novelId: frozen.subject.novelId, targetId: frozen.newCallId } })
    if (observed.length !== parsed.usageIds.length) reject('失败观察的用量不属于此独立请求。')
  }
  const observation = await tx.agentRunEvent.findUnique({ where: { id: eventId(authorizationId, 'observation') } })
  if (observation) {
    const saved = await observedFor(tx, frozen, event, claimed!)
    if (hash(saved.value.newUsageIds) !== hash(parsed.usageIds)) reject('失败审计的新账目与已保存响应观察不一致。')
  }
  const failed = await append(tx, frozen.subject.runId, eventId(authorizationId, 'failure'), eventTypes.failure,
    { version: 1, authorizationId, authorizationEventId: event.id, claimEventId: claimed!.id, frozenHash: hash(frozen), newCallId: frozen.newCallId,
      failureCode: parsed.failureCode, usageIds: parsed.usageIds, ...(observation ? { observationEventId: observation.id } : {}) })
  return { failureEventId: failed.id }
}

async function knownNewUsage(tx: Prisma.TransactionClient, frozen: Frozen, completion: Completion, claimedAt: Date, completedAt: Date) {
  const rows = await tx.aiUsageLog.findMany({ where: { userId: frozen.subject.userId, targetId: frozen.newCallId }, orderBy: { id: 'asc' } })
  if (rows.length !== 1 || completion.newUsageIds.length !== 1 || rows[0].id !== completion.newUsageIds[0]) return false
  const row: AiUsageLog = rows[0]
  if (row.novelId !== frozen.subject.novelId || row.chapterId !== frozen.pending.chapterId || row.agentRunId !== frozen.subject.runId
    || row.targetType !== 'chapter' || row.action !== action || row.providerType !== 'text' || row.providerName !== frozen.expected.model.provider
    || row.modelName !== frozen.expected.model.modelName || row.modelTier !== frozen.expected.model.tier || row.multiplierBps !== frozen.expected.model.multiplierBps
    || hash(row.billingSnapshot) !== hash(frozen.expected.price) || row.usageSource !== 'reported' || !['settled', 'exempt'].includes(row.billingStatus ?? '')
    || row.reservedCreditMilli !== 0 || row.requestTokens === null || row.responseTokens === null || row.requestTokens < 0 || row.responseTokens <= 0
    || !Number.isSafeInteger(row.requestTokens) || !Number.isSafeInteger(row.responseTokens) || row.requestTokens > frozen.conservativeInputTokenCeiling
    || row.responseTokens > frozen.maxOutputTokens || row.createdAt < claimedAt || row.createdAt > completedAt || row.durationMs < 0
    || row.createdAt.getTime() + row.durationMs > completedAt.getTime() || object(row.billingEvidence).responseObserved !== true) return false
  const expected = priceTokenEvidence(frozen.expected.price, row.requestTokens, row.responseTokens, row.promptCacheHitTokens)
  if (expected > frozen.maxCreditMilli || row.creditChargeMilli !== expected) return false
  const ledger = await tx.creditLedgerEntry.findUnique({ where: { idempotencyKey: `usage:${row.id}` } })
  if (expected === 0 && !ledger) return row.creditChargeMilli === 0 && frozen.expected.price.multiplierBps === 0
  return row.billingStatus === 'exempt' ? false : !!ledger && ledger.userId === frozen.subject.userId
    && ledger.sourceType === 'model_tokens' && ledger.kind === 'usage' && ledger.referenceId === frozen.newCallId && ledger.deltaMilli === -expected
    && ledger.requestTokens === row.requestTokens && ledger.responseTokens === row.responseTokens && ledger.modelTier === row.modelTier
    && ledger.multiplierBps === row.multiplierBps && object(ledger.metadata).estimated !== true
}

/** Pure dependency reader. Claims, prose and independent reports alone do not
 * prove completion, and this does not reconcile the old request's bill. */
export async function readAuthorReviewReplacements(tx: Prisma.TransactionClient, subject: Subject, pending: readonly PendingReviewCall[]) {
  const receipts: Array<PendingReviewCall & { replacementReceipt: AgentAuthorReviewReplacement }> = []
  if (!pending.some(item => item.toolName === 'quality_analyze')) return receipts
  const completed = await tx.agentRunEvent.findMany({ where: { runId: subject.runId, type: eventTypes.completion }, orderBy: { seq: 'asc' }, take: 101 })
  if (completed.length > 100 || !completed.length) return receipts
  const events = completed.filter(event => event.type === eventTypes.completion)
  for (const event of events) {
    try {
      const id = object(object(event.payload).value).authorizationId
      if (typeof id !== 'string') continue
      const { frozen, event: authorized } = await frozenFor(tx, id)
      const item = pending.find(item => hash(item) === hash(frozen.pending))
      if (!item || hash(subject) !== hash(frozen.subject)) continue
      const claimEvent = await tx.agentRunEvent.findUnique({ where: { id: eventId(id, 'claim') } })
      const completionEvent = await tx.agentRunEvent.findUnique({ where: { id: eventId(id, 'completion') } })
      const claim = unpack<Record<string, unknown>>(claimEvent, id, 'claim'), completion = completionSchema.parse(unpack<Completion>(completionEvent, id, 'completion'))
      if (claimEvent!.runId !== subject.runId || completionEvent!.runId !== subject.runId || claimEvent!.seq <= authorized.seq
        || completionEvent!.seq <= claimEvent!.seq || claimEvent!.createdAt < authorized.createdAt || completionEvent!.createdAt < claimEvent!.createdAt
        || claim.version !== 1 || claim.authorizationId !== id || claim.authorizationEventId !== authorized.id || claim.frozenHash !== hash(frozen)
        || claim.newCallId !== frozen.newCallId || completion.version !== 1 || completion.authorizationId !== id
        || completion.authorizationEventId !== authorized.id || completion.claimEventId !== claimEvent!.id || completion.frozenHash !== hash(frozen)
        || completion.newCallId !== frozen.newCallId || completion.finishReason !== 'stop' || completion.toolCalls !== 0) continue
      const observed = await observedFor(tx, frozen, authorized, claimEvent!)
      if (completion.observationEventId !== observed.event.id || completion.observationHash !== hash(observed.value)
        || observed.event.seq >= completionEvent!.seq || observed.event.createdAt > completionEvent!.createdAt
        || completion.responseHash !== observed.value.response.contentHash || completion.finishReason !== observed.value.response.finishReason
        || completion.toolCalls !== observed.value.response.toolCalls.length || hash(completion.newUsageIds) !== hash(observed.value.newUsageIds)) continue
      const live = await current(tx, frozen, frozen, true)
      const baseline = await tx.aiUsageLog.findMany({ where: { id: { in: frozen.baselineUsage.map(row => row.id) }, userId: subject.userId }, orderBy: { id: 'asc' } })
      if (hash(baseline.map(row => ({ id: row.id, hash: hash(row) }))) !== hash(frozen.baselineUsage)) continue
      const report = await getLatestQualityReport(subject.userId, subject.novelId, item.chapterId, tx, item.compilationId)
      const metrics = object(report?.deterministicMetrics), audit = object(metrics.criticResponse)
      if (!report || report.id !== completion.reportId || report.runId !== subject.runId || report.chapterRevision !== frozen.expected.currentRevision
        || report.compilationId !== item.compilationId || report.criticVersion !== frozen.criticVersion || report.repairRound !== 0
        || !['passed', 'needs_repair'].includes(report.status) || reportHash(report) !== completion.reportHash || report.createdAt < claimEvent!.createdAt
        || report.createdAt > completionEvent!.createdAt || metrics.independentCheck !== 'complete' || metrics.contentHash !== frozen.expected.currentContentHash
        || metrics.qualityContextHash !== frozen.expected.qualityContextHash || metrics.droppedFindings !== 0 || metrics.omittedFindings !== 0
        || metrics.unlocatedFindings !== 0 || audit.callId !== frozen.newCallId || audit.parserVersion !== 3 || audit.contentHash !== completion.responseHash
        || object(audit.rawResponse).complete !== true || object(audit.rawResponse).encoding !== 'json-string') continue
      const raw: unknown = JSON.parse(String(object(audit.rawResponse).content))
      if (typeof raw !== 'string' || sha(raw) !== completion.responseHash || JSON.stringify(raw) !== observed.value.response.content) continue
      const inspected = inspectCorrectableCriticResponse(raw, live.sources, true, 3)
      if (!inspected.complete || inspected.diagnostic.droppedFindings || inspected.diagnostic.invalidSources
        || !await knownNewUsage(tx, frozen, completion, claimEvent!.createdAt, completionEvent!.createdAt)) continue
      const prepared = prepareQualityFindings(live.bundle.chapter.content, live.deterministic.findings, inspected.findings, true, live.sources, 3)
      const expectedFindings = prepared.findings.map(row => ({ signal: row.signal, source: row.source, severity: row.severity, startOffset: row.start,
        endOffset: row.end, evidenceExcerpt: row.evidence, evidenceHash: sha(live.bundle.chapter.content.slice(row.start, row.end)),
        explanation: row.explanation, suggestion: row.suggestion, confidence: row.confidence }))
      const actualFindings = report.findings.map(row => ({ signal: row.signal, source: row.source, severity: row.severity, startOffset: row.startOffset,
        endOffset: row.endOffset, evidenceExcerpt: row.evidenceExcerpt, evidenceHash: row.evidenceHash,
        explanation: row.explanation, suggestion: row.suggestion, confidence: row.confidence }))
      const sortedHashes = (rows: unknown[]) => rows.map(hash).sort()
      if (!prepared.complete || prepared.unlocatedFindings || prepared.omittedFindings
        || hash(sortedHashes(expectedFindings)) !== hash(sortedHashes(actualFindings))
        || metrics.evidenceSourceTableHash !== sha(JSON.stringify(live.sources))) continue
      receipts.push({ ...item, replacementReceipt: { status: 'author_replacement_review_complete', sourceRunId: subject.runId,
        sourceCallId: item.callId, sourceResultId: frozen.sourceResultId, sourceReportId: report.id, newCallId: frozen.newCallId,
        authorizationId: id, authorizationEventId: authorized.id, completionEventId: completionEvent!.id, newUsageIds: [...completion.newUsageIds],
        originalUsageIds: [...frozen.originalUsageIds], originalRequestOutcome: 'unknown_preserved', currentRevision: frozen.expected.currentRevision,
        currentContentHash: frozen.expected.currentContentHash, qualityContextHash: frozen.expected.qualityContextHash } })
    } catch (error) {
      if (error instanceof DataAccessError || error instanceof SyntaxError || error instanceof z.ZodError) continue
      throw error
    }
  }
  return receipts
}

export type AuthorReviewReplacementStatus = { status: 'authorized' | 'claimed' | 'complete' | 'incomplete' | 'waiting_usage'; newCallId: string;
  reportId: string | null; replacementReceipt?: AgentAuthorReviewReplacement }

/** Owned polling facts only. No report content, raw provider response or payment
 * data is exposed, and a missing process-local sender never grants a retry. */
export async function readAuthorReviewReplacementStatus(tx: Prisma.TransactionClient, subject: Subject, authorizationId: string): Promise<AuthorReviewReplacementStatus> {
  const { frozen, event } = await frozenFor(tx, authorizationId)
  if (hash(subject) !== hash(frozen.subject) || !await tx.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId } })) reject('报价确认不属于当前作者任务。')
  const base = { newCallId: frozen.newCallId, reportId: null }
  const claimed = await tx.agentRunEvent.findUnique({ where: { id: eventId(authorizationId, 'claim') } })
  if (!claimed) return { ...base, status: 'authorized' }
  const claim = unpack<Record<string, unknown>>(claimed, authorizationId, 'claim')
  if (claim.version !== 1 || claim.authorizationId !== authorizationId || claim.authorizationEventId !== event.id
    || claim.frozenHash !== hash(frozen) || claim.newCallId !== frozen.newCallId || claimed.runId !== subject.runId || claimed.seq <= event.seq) reject('检查状态的领取证据损坏。')
  const completed = await tx.agentRunEvent.findUnique({ where: { id: eventId(authorizationId, 'completion') } })
  if (!completed) {
    const failed = await tx.agentRunEvent.findUnique({ where: { id: eventId(authorizationId, 'failure') } })
    if (failed) unpack(failed, authorizationId, 'failure')
    return { ...base, status: failed ? 'incomplete' : 'claimed' }
  }
  const completion = completionSchema.parse(unpack<Completion>(completed, authorizationId, 'completion'))
  if (completion.authorizationId !== authorizationId || completion.authorizationEventId !== event.id || completion.claimEventId !== claimed.id
    || completion.frozenHash !== hash(frozen) || completion.newCallId !== frozen.newCallId || completed.runId !== subject.runId || completed.seq <= claimed.seq) reject('检查状态的完成证据损坏。')
  const receipt = (await readAuthorReviewReplacements(tx, subject, [frozen.pending])).find(row => row.replacementReceipt.authorizationId === authorizationId)?.replacementReceipt
  if (receipt) return { newCallId: frozen.newCallId, reportId: receipt.sourceReportId, status: 'complete', replacementReceipt: receipt }
  const report = await tx.chapterQualityReport.findFirst({ where: { id: completion.reportId, userId: subject.userId, novelId: subject.novelId } })
  if (!report || report.status === 'failed' || report.status === 'stale' || !await knownNewUsage(tx, frozen, completion, claimed.createdAt, completed.createdAt)) {
    return { newCallId: frozen.newCallId, reportId: report?.id ?? null, status: report && ['passed', 'needs_repair'].includes(report.status) ? 'waiting_usage' : 'incomplete' }
  }
  return { newCallId: frozen.newCallId, reportId: report.id, status: 'incomplete' }
}
