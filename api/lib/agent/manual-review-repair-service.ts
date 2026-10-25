import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import type { ManualReviewRepairPreview, ManualReviewRepairQuote, ManualReviewRepairStatus } from '../../../shared/contracts/manual-review-repair.js'
import { submitManualReviewRepairSchema } from '../../../shared/contracts/manual-review-repair.js'
import { creditModelTierSchema } from '../../../shared/contracts/credits.js'
import { env } from '../../config/env.js'
import { DataAccessError, prisma } from '../prisma.js'
import { getModelTierRuntime } from '../credits.js'
import { generateTextCompletion } from '../ai-service.js'
import { createTextRequestTrace, withTextRequestTrace } from '../text-request-trace.js'
import { tokenPriceSchema, frozenTokenPriceMatchesModel, type TokenPrice } from '../billing/token-price.js'
import { priceTokenEvidence } from '../billing/reservation-policy.js'
import { MAX_CREDIT_STORAGE_INT } from '../billing/pricing.js'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'
import { activeChapterScope } from '../data/internal.js'
import { assertAgentManuscriptCurrent } from './manuscript-scope.js'
import { withUserRunLock } from './run-lock.js'
import { getActiveRun, hasActiveRunInSession, registerActiveRun, deregisterActiveRun } from './active-runs.js'
import { savedRunUsageSchema } from './checkpoint.js'
import { readOriginalTaskRequest, originalTaskRunIds } from './original-request.js'
import { readTerminalCandidate } from './terminal-state-review.js'
import { readCompilerContinuitySource } from './compiler-continuity-source.js'
import { compilerContinuityCoverage, type CompilerContinuityCoverage } from './compiler-continuity-contract.js'
import { terminalEvidenceContext, terminalQuoteAddressVersion } from './terminal-evidence-context.js'
import { terminalCoverageInput, terminalCoverageProofs } from './terminal-fact-coverage.js'
import { attachTerminalProposalInput, terminalProposalTaskId } from './terminal-proposal-context.js'
import { buildContinuityReviewManifest, continuityReviewV4Request, inspectContinuityV4, type ContinuityV4Frozen } from './continuity-review-v4.js'
import { legacyAssessmentInputSchema, legacyContinuityAssessmentKey, readLegacyContinuityAssessment, bindLegacyContinuityAssessment,
  bindLegacyContinuityRequest, observeLegacyContinuityAssessment, continuityReassessmentCandidates, type LegacyAssessmentInput } from './assessment-response-lifecycle.js'
import { validateStoryContinuity } from './story-compiler.js'
import { chapterBridgeCommitTool } from './tools/story-compiler-tools.js'
import type { ToolContext } from './tools/types.js'
import { estimateChatMessagesTokens, resolveDurableInputLimit } from './context-budget.js'
import { REVIEW_MAX_OUTPUT_TOKENS } from './review-completion.js'
import { MAIN_RUN_FILTER } from './runtime-child.js'
import { readWritingScope } from './writing-scope.js'
import { isKnownTextRequestBilling, isKnownRejectedTextRequestAttempt } from './text-request-billing.js'
import { readRetiredReviewUsageIds } from './cancelled-review-recovery.js'
import { manualReviewRepairOperationId } from './manual-review-repair-contract.js'
import { appendManualRepairEvent, readManualRepairEvent, repairEventId, repairHash as hash, refuseManualRepair as refuse } from './manual-review-repair-store.js'

type Subject = { userId: string; novelId: string; runId: string }
type Runtime = Awaited<ReturnType<typeof getModelTierRuntime>>
type Observation = Parameters<NonNullable<Parameters<typeof generateTextCompletion>[2]['onObservedCompletion']>>[0]
type Model = { tier: Runtime['tier']; customModelId: string | null; reasoningEffort: Runtime['reasoningEffort']; provider: string; modelName: string; multiplierBps: number }
type Frozen = { version: 1; kind: 'manual_review_repair'; operationId: string; subject: Subject; taskId: string; failedAssessmentKey: string;
  source: { runId: string; callId: string }; originalInput: LegacyAssessmentInput; originalAudit: unknown; originalRawResponses: string[];
  input: LegacyAssessmentInput; review: ContinuityV4Frozen; model: Model; price: TokenPrice; runtimeHash: string;
  runHash: string; baselineUsage: Array<{ id: string; hash: string }>; contextHash: string; maxProviderDispatches: 1;
  inputTokenCeiling: number; maxCreditMilli: number; sessionId: string; focus: string; coverage: CompilerContinuityCoverage }
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const jobs = new Map<string, Promise<void>>()
const owners = new Map<string, { controller: AbortController; seq: number }>()
const purpose = 'manual-review-repair-once-v1', lifetimeMs = 5 * 60_000
const runtimeHash = (runtime: Runtime) => hash({ ...runtime, modelName: runtime.modelName ?? env.aiTextModel,
  baseUrl: runtime.baseUrl ?? env.aiTextBaseUrl, apiKey: runtime.apiKey ?? env.aiTextApiKey })
const quoteSchema = z.object({ version: z.literal(1), purpose: z.literal(purpose), expiresAt: z.number().int().positive(),
  mode: z.enum(['provider_once', 'apply_known_result']), recoveryHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  userId: z.string().min(1), runId: z.string().min(1), operationId: z.string().regex(/^mrr_[a-f0-9]{56}$/u), frozenHash: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()
function signature(value: string) {
  if (!env.authSessionSecret) throw new DataAccessError(503, 'MANUAL_REPAIR_QUOTE_UNAVAILABLE', '修复报价服务尚未配置。')
  return createHmac('sha256', env.authSessionSecret).update(`${purpose}.${value}`).digest('hex')
}
function sign(value: z.infer<typeof quoteSchema>) { const encoded = Buffer.from(JSON.stringify(value)).toString('base64url'); return `${encoded}.${signature(encoded)}` }
function verify(token: string, userId: string, runId: string) {
  if (typeof token !== 'string' || token.length > 16384 || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/u.test(token)) refuse('修复报价凭证无效。')
  const [encoded, supplied] = token.split('.')
  if (!timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(signature(encoded), 'hex'))) refuse('修复报价签名不一致。')
  let value: unknown
  try { value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) } catch { refuse('修复报价内容损坏。') }
  const parsed = quoteSchema.safeParse(value)
  if (!parsed.success || parsed.data.userId !== userId || parsed.data.runId !== runId
    || (parsed.data.mode === 'apply_known_result') !== (parsed.data.recoveryHash !== undefined)) refuse('修复报价不属于当前作者任务。')
  return parsed.data
}
async function owned(tx: Prisma.TransactionClient, userId: string, runId: string) {
  const run = await tx.agentRun.findFirst({ where: { id: runId, userId } })
  if (!run) throw new DataAccessError(404, 'RUN_NOT_FOUND', '任务不存在或不属于当前作者。')
  return run
}
async function lock(tx: Prisma.TransactionClient, subject: Subject) {
  await lockNovelActiveScope(tx, subject.novelId)
  await tx.$queryRaw`SELECT id FROM agent_runs WHERE id = ${subject.runId} AND user_id = ${subject.userId} FOR UPDATE`
}
async function recoveryBinding(tx: Prisma.TransactionClient, userId: string, runId: string) {
  const run = await owned(tx, userId, runId)
  const last = await tx.agentRunEvent.findFirst({ where: { runId }, orderBy: { seq: 'desc' }, select: { seq: true } })
  return hash({ runId, status: run.status, currentTurn: run.currentTurn, usage: run.usage, manuscriptRevision: run.manuscriptRevision,
    startRequest: run.startRequest, taskSpec: run.taskSpec, writingBindings: run.writingBindings, afterSeq: last?.seq ?? 0 })
}
function context(subject: Subject, frozen: Frozen, signal: AbortSignal): ToolContext {
  return { ...subject, sessionId: frozen.sessionId, chapterId: frozen.input.chapterId, callId: frozen.operationId,
    mode: 'build', creativeFreedom: 'balanced', qualityMode: 'premium', signal, emit: () => {} }
}

/** Complete read-only eligibility. No provider, reserve, admission or price
 * mutation; the current failed projection selects one immutable original pair. */
export async function buildManualReviewRepairFacts(tx: Prisma.TransactionClient, userId: string, runId: string, expected?: Frozen, recoveryRead = false): Promise<Frozen> {
  const run = await owned(tx, userId, runId), subject = { userId, runId, novelId: run.novelId }
  if (run.engine !== 'loop' || run.runtimeProtocolVersion !== 0 || run.taskRootId || record(run.usage).authorEnded !== undefined
    || !(expected ? run.status === 'running' || recoveryRead && ['paused', 'failed'].includes(run.status) : ['paused', 'failed'].includes(run.status))
    || !expected && (getActiveRun(runId) || hasActiveRunInSession(run.sessionId))
    || await tx.agentGoalExecution.findUnique({ where: { runId } })) refuse('当前任务不支持额外完整修复，或仍在执行。')
  const latest = await tx.agentRun.findFirst({ where: { sessionId: run.sessionId, ...MAIN_RUN_FILTER }, orderBy: { createdAt: 'desc' }, select: { id: true } })
  if (latest?.id !== runId || await tx.agentRun.count({ where: { sessionId: run.sessionId, id: { not: runId }, ...MAIN_RUN_FILTER,
    status: { in: ['queued', 'running', 'awaiting_approval'] } } })) refuse('当前会话已有其他任务，旧任务不能购买修复。')
  const novel = await tx.novel.findFirst({ where: { id: run.novelId, authorId: userId }, select: { manuscriptRevision: true } })
  if (!novel || novel.manuscriptRevision !== run.manuscriptRevision) refuse('当前稿件范围已变化。')
  const saved = savedRunUsageSchema.safeParse(run.usage)
  if (!saved.success || saved.data.checkpoint?.version !== 2 || saved.data.checkpoint.controlPolicy !== 'until_completion') refuse('原任务预算与检查点无法核实。')
  if (saved.data.checkpoint.pendingReviews?.length) refuse('原任务仍有待核请求，不能把额外修复用作未知请求恢复。')
  const original = await readOriginalTaskRequest(tx, subject), ids = await originalTaskRunIds(tx, subject, original)
  if (original.parentRunId || original.sourceRunId !== runId || !original.prompt?.trim() || record(original.spec).controlPolicy !== 'until_completion') refuse('原作者任务授权无法核实。')
  const compilations = await tx.storyCompilation.findMany({ where: { userId, novelId: run.novelId, runId: { in: ids }, status: 'active',
    chapter: { authorId: userId, ...activeChapterScope(run.novelId) } }, include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } }, chapter: true } })
  const eligible = compilations.filter(row => record(row.validation).independentCheck === 'unavailable'
    && typeof record(record(record(row.validation).continuityCriticResponse).assessmentRequest).key === 'string')
  if (eligible.length !== 1 || !eligible[0].chapter || !eligible[0].bridge) refuse('没有唯一绑定当前正文的失败完整复查。')
  const compilation = eligible[0], chapter = compilation.chapter!, bridge = compilation.bridge!, validation = record(compilation.validation)
  const writing = await readWritingScope(tx, subject)
  if (!['write', 'revise'].includes(String(record(writing.spec).intent)) || writing.writing?.kind !== 'bounded'
    || record(record(record(writing.spec).scope).authorEffects).manuscript === false
    || !writing.writing.targets.some(target => target.orderIndex === chapter.orderIndex
      && (target.chapterId ?? writing.bindings?.targets.find(binding => binding.orderIndex === target.orderIndex)?.chapterId) === chapter.id)) {
    refuse('当前章节不属于原作者明确绑定的写作目标。')
  }
  if (await tx.agentProviderAttempt.count({ where: { runId: { in: ids }, status: { in: ['prepared', 'dispatching', 'dispatched', 'unknown'] } } })) {
    refuse('原任务仍有未决供应商请求，先保留原结果核对。')
  }
  const chapterCompilations = await tx.storyCompilation.findMany({ where: { userId, novelId: run.novelId, runId: { in: ids }, chapterId: chapter.id }, select: { id: true } })
  const reviewUsage = await tx.aiUsageLog.findMany({ where: { userId, novelId: run.novelId, chapterId: chapter.id, AND: [
    { OR: [{ agentRunId: { in: ids } }, { targetType: 'story_compilation', targetId: { in: chapterCompilations.map(row => row.id) } }, { targetType: 'chapter', targetId: chapter.id }] },
    { OR: [{ action: { startsWith: 'agent3Continuity' } }, { action: { startsWith: 'agent3Humanity' } }] },
  ] } })
  const dispatch = expected ? await readManualRepairEvent(tx, runId, expected.operationId, 'dispatch') : null
  const preparedHere = expected ? reviewUsage.filter(row => !expected.baselineUsage.some(old => old.id === row.id)
    && row.agentRunId === runId && row.action === 'agent3ContinuityCritic' && row.targetType === 'story_compilation' && row.targetId === compilation.id
    && row.usageSource === 'prepared' && row.billingStatus === 'authorized_pending'
    && (!dispatch || dispatch.value.usageId === row.id)) : []
  const unknownReviews = reviewUsage.filter(row => !isKnownRejectedTextRequestAttempt(row)
    && !isKnownTextRequestBilling(row) && !preparedHere.some(prepared => prepared.id === row.id))
  const retired = unknownReviews.length ? await readRetiredReviewUsageIds(tx, subject, ids) : new Set<string>()
  if (preparedHere.length > 1 || unknownReviews.some(row => !retired.has(row.id))) {
    refuse('当前章节还有未核实的检查请求，未创建另一笔付费修复。')
  }
  const failedKey = String(record(record(validation.continuityCriticResponse).assessmentRequest).key)
  const reservations = await tx.agentArtifact.findMany({ where: { runId: { in: ids }, artifactType: 'continuityReview',
    metadata: { path: ['continuityAssessmentRequestKey'], equals: failedKey } }, take: 2 })
  const meta = record(reservations[0]?.metadata), parsed = legacyAssessmentInputSchema.safeParse(meta.input)
  if (reservations.length !== 1 || !parsed.success || typeof meta.callId !== 'string') refuse('原失败检查预约不唯一。')
  const oldInput = parsed.data, source = { runId: reservations[0].runId, callId: meta.callId }, oldCtx = { ...subject, ...source } as ToolContext
  if (oldInput.continuityManifest?.manualRepair || !oldInput.terminalCandidate || !oldInput.sourceScope || oldInput.targetType !== 'story_compilation'
    || oldInput.targetId !== compilation.id || oldInput.chapterId !== chapter.id || oldInput.revision !== chapter.revision
    || oldInput.bodies.current !== chapter.content || !chapter.content.trim() || oldInput.bodies.terminalEvidence?.verdictProtocol !== 6
    || oldInput.bodies.terminalEvidence.spanAddressProtocol !== 2 || legacyContinuityAssessmentKey(oldCtx, oldInput) !== failedKey
    || hash(readTerminalCandidate(validation)) !== hash(oldInput.terminalCandidate)) refuse('原失败检查不属于当前候选与完整正文。')
  const previous = await readLegacyContinuityAssessment(tx, oldCtx, oldInput)
  const oldAudit = bindLegacyContinuityAssessment(previous.inspected, oldCtx, oldInput).audit
  if (previous.inspected.complete || !previous.recoveryReady || !previous.billingKnown || !previous.providerComplete || !previous.slotUsed
    || hash(oldAudit) !== hash(validation.continuityCriticResponse)) refuse('原两次检查或费用尚未完全核实，不能购买修复。')
  const frames = await tx.agentArtifact.findMany({ where: { runId: source.runId, artifactType: 'continuityReview', metadata: { path: ['assessmentKey'], equals: failedKey } } })
  const originalRawResponses = ['first', 'reassessment'].map(stage => {
    const rows = frames.filter(row => record(row.metadata).stage === stage && typeof record(record(row.metadata).response).content === 'string')
    if (rows.length !== 1) refuse('原完整响应不唯一。')
    const raw: unknown = JSON.parse(String(record(record(rows[0].metadata).response).content))
    if (typeof raw !== 'string') refuse('原完整响应损坏。')
    return raw
  })
  const oldFindings = continuityReassessmentCandidates(originalRawResponses[0])
  if (!oldFindings || oldFindings.length > 30) refuse('原意见身份无法逐项保留。')
  const sourceChapter = await readCompilerContinuitySource(tx, subject, chapter, bridge.fromChapterId, 11)
  if (bridge.fromChapterId && sourceChapter?.revision !== bridge.sourceRevision || oldInput.bodies.previous !== (sourceChapter?.content ?? null)) refuse('原复查的完整来源已变化。')
  const focus = typeof validation.reviewFocus === 'string' ? validation.reviewFocus : ''
  const coverage = compilerContinuityCoverage({ chapter, bridge, sceneTasks: compilation.sceneTasks, source: sourceChapter, focus, terminalCandidate: oldInput.terminalCandidate }, 11)
  if (hash(coverage) !== oldInput.bindingHash || hash(coverage) !== hash(validation.coverage)) refuse('完整连续性检查范围已变化。')
  const evidence = attachTerminalProposalInput(terminalEvidenceContext(chapter, sourceChapter, 2, terminalQuoteAddressVersion(original.spec),
    terminalCoverageInput(original.spec, compilation.preparedContext, chapter, oldInput.terminalCandidate, 2, terminalCoverageProofs(sourceChapter, 2)), 6, 2),
    { taskId: terminalProposalTaskId(original.spec, original.taskId), preparedContext: compilation.preparedContext, validation, candidate: oldInput.terminalCandidate })
  if (hash(evidence) !== hash(oldInput.bodies.terminalEvidence)) refuse('持续事实、候选证明或待核提议已变化。')
  const baseline = await tx.aiUsageLog.findMany({ where: { userId, novelId: run.novelId,
    ...(expected ? { id: { in: expected.baselineUsage.map(row => row.id) } } : { agentRunId: { in: ids } }) }, orderBy: { id: 'asc' } })
  const payments = baseline.filter(row => previous.usageIds.includes(row.id))
  if (payments.length !== previous.usageIds.length) refuse('原费用与请求归属缺失。')
  const reasoningEffort = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).parse(run.reasoningEffort)
  const tier = creditModelTierSchema.parse(run.modelTier), runtime = await getModelTierRuntime(tier, userId, run.customModelId, reasoningEffort)
  const price = tokenPriceSchema.parse(payments[0].billingSnapshot)
  const model: Model = { tier, customModelId: run.customModelId, reasoningEffort: runtime.reasoningEffort, provider: runtime.provider,
    modelName: runtime.modelName ?? env.aiTextModel, multiplierBps: runtime.multiplierBps }
  if (model.reasoningEffort !== run.reasoningEffort || runtime.tier !== tier || !frozenTokenPriceMatchesModel(price, tier, model.multiplierBps)
    || payments.some(row => row.modelTier !== tier || row.modelName !== model.modelName || row.providerName !== model.provider
      || row.multiplierBps !== model.multiplierBps || hash(row.billingSnapshot) !== hash(price))) refuse('原模型或认证价格不能完整继承，未替换模型或猜价。')
  const operationId = manualReviewRepairOperationId(original.taskId, failedKey, { chapterId: chapter.id, revision: chapter.revision,
    bodyHash: sha(chapter.content), candidate: oldInput.terminalCandidate, source: sourceChapter, coverage: evidence.factCoverage, proposals: evidence.proposalChanges ?? null })
  const bodies = structuredClone(oldInput.bodies)
  const manifest = buildContinuityReviewManifest({ subject: { userId, novelId: subject.novelId, taskId: original.taskId, targetType: 'story_compilation',
    targetId: compilation.id, chapterId: chapter.id, revision: chapter.revision }, bodies, candidate: oldInput.terminalCandidate, sourceScope: oldInput.sourceScope,
    sourceHash: bodies.previous === null ? null : hash({ previous: bodies.previous, source: evidence.previous }), sourceVersions: { current: evidence.current, previous: evidence.previous },
    verifiedCoverage: evidence.factCoverage ?? null, draftProposals: evidence.proposalChanges ?? null,
    manualRepair: { version: 1, operationId, originalTaskId: original.taskId, failedAssessmentKey: failedKey,
      originalRawHashes: originalRawResponses.map(sha), originalFindings: oldFindings } })
  const review = { manifest, bodies, candidate: oldInput.terminalCandidate, sourceScope: oldInput.sourceScope }
  const request = continuityReviewV4Request(review, original.prompt, JSON.stringify({ currentBody: bodies.current, previousBody: bodies.previous,
    originalReadOnlyResponses: originalRawResponses, originalContext: oldInput.content }))
  const input: LegacyAssessmentInput = { ...oldInput, ...request, bodies, parserVersion: 9, reassessmentProtocol: 6, continuityManifest: manifest }
  const messages = [{ role: 'system' as const, content: request.system }, { role: 'user' as const, content: request.content }]
  const inputLimit = resolveDurableInputLimit(runtime.contextWindowTokens ?? env.agentContextWindowTokens, REVIEW_MAX_OUTPUT_TOKENS)
  if (!inputLimit || estimateChatMessagesTokens(messages) > inputLimit) refuse('完整检查材料超过原模型窗口，未截断或购买检查。')
  const inputTokenCeiling = Buffer.byteLength(JSON.stringify(messages), 'utf8') + 4096
  const maxCreditMilli = priceTokenEvidence(price, inputTokenCeiling, REVIEW_MAX_OUTPUT_TOKENS, 0)
  if (!Number.isSafeInteger(maxCreditMilli) || maxCreditMilli > MAX_CREDIT_STORAGE_INT) refuse('修复费用上限无法安全表示。')
  return { version: 1, kind: 'manual_review_repair', operationId, subject, taskId: original.taskId, failedAssessmentKey: failedKey, source,
    originalInput: oldInput, originalAudit: oldAudit, originalRawResponses, input, review, model, price, runtimeHash: runtimeHash(runtime),
    runHash: hash({ id: run.id, sessionId: run.sessionId, modelTier: run.modelTier, customModelId: run.customModelId, reasoningEffort: run.reasoningEffort,
      currentTurn: run.currentTurn, usage: Object.fromEntries(Object.entries(record(run.usage)).filter(([key]) => !['promptTokens', 'completionTokens', 'totalTokens'].includes(key))),
      startRequest: run.startRequest, taskSpec: run.taskSpec, writingBindings: run.writingBindings, manuscriptRevision: run.manuscriptRevision }),
    baselineUsage: baseline.map(row => ({ id: row.id, hash: hash(row) })), contextHash: hash({ compilation, sourceChapter, original }),
    maxProviderDispatches: 1, inputTokenCeiling, maxCreditMilli, sessionId: run.sessionId, focus, coverage }
}
const facts = buildManualReviewRepairFacts

async function claimApplyOwner(tx: Prisma.TransactionClient, frozen: Frozen) {
  const last = await tx.agentRunEvent.findFirst({ where: { runId: frozen.subject.runId }, orderBy: { seq: 'desc' }, select: { seq: true } })
  return appendManualRepairEvent(tx, frozen.subject.runId, `${frozen.operationId}:owner:${(last?.seq ?? 0) + 1}`, 'owner',
    { operationId: frozen.operationId, frozenHash: hash(frozen) })
}
async function currentOwner(tx: Prisma.TransactionClient, frozen: Frozen, controller: AbortController) {
  const owner = owners.get(frozen.operationId)
  const latest = await tx.agentRunEvent.findFirst({ where: { runId: frozen.subject.runId, type: 'review.manual_repair.owner',
    payload: { path: ['value', 'operationId'], equals: frozen.operationId } }, orderBy: { seq: 'desc' } })
  return owner?.controller === controller && latest?.seq === owner.seq && record(record(latest.payload).value).frozenHash === hash(frozen)
    && record(latest.payload).hash === hash(record(latest.payload).value)
}

async function status(tx: Prisma.TransactionClient, userId: string, runId: string, operationId: string): Promise<ManualReviewRepairStatus> {
  const run = await owned(tx, userId, runId)
  const grant = await readManualRepairEvent(tx, runId, operationId, 'authorized')
  if (!grant || grant.value.actorUserId !== userId) refuse('修复操作不属于当前作者任务。')
  const latestOutcome = await tx.agentRunEvent.findFirst({ where: { runId, type: { startsWith: 'review.manual_repair.finished_' },
    payload: { path: ['value', 'operationId'], equals: operationId } }, orderBy: { seq: 'desc' } })
  const outcome = latestOutcome ? await readManualRepairEvent(tx, runId, operationId, latestOutcome.type.slice('review.manual_repair.'.length)) : null
  if (jobs.has(operationId)) return { operationId, eventStartSeq: grant.row.seq - 1, state: 'running', reportId: null, terminalCommitted: false, needsContinuation: false, message: '正在核对已授权的完整修复。' }
  const result = outcome ? { operationId, ...outcome.value } as ManualReviewRepairStatus
    : { operationId, eventStartSeq: grant.row.seq - 1, state: 'unknown' as const, reportId: null, terminalCommitted: false, needsContinuation: false,
      message: '原修复结果尚未确认，保留请求等待核对，不会重复派发。' }
  // A process can die after the ordinary terminal transaction committed and
  // before writing its ancillary operation outcome. Read actual complete
  // delivery and this exact applied assessment rather than reopening a sender.
  if (run.status === 'completed') {
    const frozen = grant.value.frozen as Frozen, applied = await readManualRepairEvent(tx, runId, operationId, 'applied')
    if (applied?.value.terminalCommitted === true) {
      const received = await readLegacyContinuityAssessment(tx, context(frozen.subject, frozen, new AbortController().signal), frozen.input)
      const bound = bindLegacyContinuityAssessment(received.inspected, context(frozen.subject, frozen, new AbortController().signal), frozen.input)
      const writing = await import('./writing-scope.js')
      const delivery = await writing.readCompletedWritingDelivery(tx, frozen.subject) ?? await writing.readRecoveredChapterDelivery(tx, frozen.subject)
      if (received.inspected.complete && received.billingKnown && received.providerComplete && received.recoveryReady && delivery
        && hash(bound.audit) === applied.value.auditHash) return { operationId, eventStartSeq: grant.row.seq - 1, state: 'complete',
        reportId: frozen.input.targetId, terminalCommitted: true, needsContinuation: false, message: '完整修复与原章节交付已完成。' }
    }
    return result
  }
  if (result.state === 'complete') return result
  try {
    const frozen = grant.value.frozen as Frozen, run = await owned(tx, userId, runId)
    if (!['failed', 'paused'].includes(run.status) || record(run.usage).authorEnded !== undefined || getActiveRun(runId)
      || hasActiveRunInSession(run.sessionId)) return result
    const applied = await readManualRepairEvent(tx, runId, operationId, 'applied')
    if (applied?.value.terminalCommitted === true) {
      const writing = await import('./writing-scope.js')
      const delivery = await writing.readCompletedWritingDelivery(tx, frozen.subject) ?? await writing.readRecoveredChapterDelivery(tx, frozen.subject)
      return { ...result, canResume: !!delivery }
    }
    const received = await readLegacyContinuityAssessment(tx, context(frozen.subject, frozen, new AbortController().signal), frozen.input)
    if (received.inspected.complete && received.billingKnown && received.providerComplete && received.recoveryReady
      && hash(await facts(tx, userId, runId, frozen, true)) === hash(frozen)) return { ...result, canResume: true }
  } catch (error) { if (!(error instanceof DataAccessError || error instanceof z.ZodError)) throw error }
  return result
}

export async function readManualReviewRepair(userId: string, runId: string): Promise<ManualReviewRepairPreview> {
  return prisma.$transaction(async tx => {
    await owned(tx, userId, runId)
    const latest = await tx.agentRunEvent.findFirst({ where: { runId, type: 'review.manual_repair.authorized' }, orderBy: { seq: 'desc' } })
    if (latest) {
      const operationId = String(record(record(record(latest.payload).value).frozen).operationId)
      return { eligible: false, status: await status(tx, userId, runId, operationId), message: '原修复操作已存在。' }
    }
    try { await facts(tx, userId, runId); return { eligible: true, status: null, message: '可查看额外完整修复的费用。' } }
    catch (error) {
      if (error instanceof DataAccessError || error instanceof z.ZodError) return { eligible: false, status: null, message: '当前没有可明确修复的完整失败复查。' }
      throw error
    }
  })
}

export async function quoteManualReviewRepair(userId: string, runId: string): Promise<ManualReviewRepairQuote> {
  const quoted = await prisma.$transaction(async tx => {
    await owned(tx, userId, runId)
    const latest = await tx.agentRunEvent.findFirst({ where: { runId, type: 'review.manual_repair.authorized' }, orderBy: { seq: 'desc' } })
    if (latest) {
      const operationId = String(record(record(record(latest.payload).value).frozen).operationId)
      if (!(await status(tx, userId, runId, operationId)).canResume) refuse('原修复已使用唯一请求；当前只能等待核对，不能再购买同一检查。')
      const grant = await readManualRepairEvent(tx, runId, operationId, 'authorized')
      return { frozen: grant!.value.frozen as Frozen, recoveryOnly: true, recoveryHash: await recoveryBinding(tx, userId, runId) }
    }
    return { frozen: await facts(tx, userId, runId), recoveryOnly: false, recoveryHash: undefined }
  }), { frozen, recoveryOnly } = quoted, expiresAt = Date.now() + lifetimeMs
  return { operationId: frozen.operationId, quoteToken: sign({ version: 1, purpose, expiresAt, userId, runId, operationId: frozen.operationId, frozenHash: hash(frozen),
    mode: recoveryOnly ? 'apply_known_result' : 'provider_once', ...(quoted.recoveryHash ? { recoveryHash: quoted.recoveryHash } : {}) }),
    expiresAt: new Date(expiresAt).toISOString(), chapterId: frozen.input.chapterId, currentRevision: frozen.input.revision,
    model: { modelTier: frozen.model.tier, customModelId: frozen.model.customModelId, reasoningEffort: frozen.model.reasoningEffort,
      modelName: frozen.model.modelName, label: frozen.model.modelName }, maximumCreditMilli: recoveryOnly ? 0 : frozen.maxCreditMilli,
    maxProviderDispatches: recoveryOnly ? 0 : 1, ...(recoveryOnly ? { recoveryOnly: true } : {}) }
}

/** Claim is committed before the asynchronous sender is scheduled. A lost
 * process never recreates a sender; polling only observes durable evidence. */
export async function submitManualReviewRepair(userId: string, runId: string, body: z.infer<typeof submitManualReviewRepairSchema>): Promise<ManualReviewRepairStatus> {
  const input = submitManualReviewRepairSchema.parse(body), quote = verify(input.quoteToken, userId, runId)
  return withUserRunLock(userId, async () => {
    const admitted = await prisma.$transaction(async tx => {
      const run = await owned(tx, userId, runId); await lock(tx, { userId, runId, novelId: run.novelId })
      const prior = await readManualRepairEvent(tx, runId, quote.operationId, 'authorized')
      if (prior) {
        const current = await status(tx, userId, runId, quote.operationId)
        // A delayed duplicate of the paid intent is observation only. A stop
        // revokes its write continuation even when a complete raw arrived.
        if (quote.mode !== 'apply_known_result' || jobs.has(quote.operationId) || current.state === 'complete' || !['failed', 'paused'].includes(run.status)
          || record(run.usage).authorEnded !== undefined || getActiveRun(runId) || hasActiveRunInSession(run.sessionId)) return { kind: 'replay' as const, replay: current }
        if (quote.expiresAt <= Date.now() || quote.expiresAt > Date.now() + lifetimeMs || !current.canResume
          || quote.recoveryHash !== await recoveryBinding(tx, userId, runId)) refuse('当前离线续办凭据已失效，请重新查看已收到的结果。')
        const frozen = prior.value.frozen as Frozen
        if (frozen.subject.userId !== userId || frozen.subject.runId !== runId || prior.value.intent !== input.intent) refuse('原修复授权不属于当前作者。')
        await accountKnownUsage(tx, frozen)
        const applied = await readManualRepairEvent(tx, runId, frozen.operationId, 'applied')
        const ctx = context(frozen.subject, frozen, new AbortController().signal)
        let response: Observation | undefined
        if (!applied) {
          try {
            const known = await readLegacyContinuityAssessment(tx, ctx, frozen.input)
            if (!known.inspected.complete || !known.billingKnown || !known.providerComplete || !known.recoveryReady) return { kind: 'replay' as const, replay: current }
            const dispatch = await readManualRepairEvent(tx, runId, frozen.operationId, 'dispatch')
            response = { usageId: String(dispatch!.value.usageId), content: JSON.parse(known.inspected.audit.rawResponse.content) as string,
              finishReason: 'stop', toolCalls: [] }
          } catch (error) {
            if (error instanceof DataAccessError || error instanceof z.ZodError) return { kind: 'replay' as const, replay: current }
            throw error
          }
        }
        await assertAgentManuscriptCurrent(tx, frozen.subject)
        await tx.agentRun.update({ where: { id: runId }, data: { status: 'running', finishedAt: null, errorMessage: null } })
        if (!applied && hash(await facts(tx, userId, runId, frozen)) !== hash(frozen)) refuse('已收到的修复材料不再属于当前版本。')
        const owner = await claimApplyOwner(tx, frozen)
        return { kind: 'reconcile' as const, frozen, response, applied: !!applied?.value.terminalCommitted, ownerSeq: owner.seq }
      }
      if (quote.mode !== 'provider_once' || quote.expiresAt <= Date.now() || quote.expiresAt > Date.now() + lifetimeMs) refuse('报价已过期或用途不匹配，请重新查看当前费用。')
      const frozen = await facts(tx, userId, runId)
      if (frozen.operationId !== quote.operationId || hash(frozen) !== quote.frozenHash) refuse('正文、来源、原模型或费用已变化，请重新查看报价。')
      await assertAgentManuscriptCurrent(tx, frozen.subject)
      await appendManualRepairEvent(tx, runId, frozen.operationId, 'authorized', { intent: input.intent, actorUserId: userId, frozen })
      const ctx = context(frozen.subject, frozen, new AbortController().signal)
      await tx.agentArtifact.create({ data: { runId, artifactType: 'continuityReview', title: '作者单次完整修复授权', content: '保留原失败复查与全部账目；本次为明确授权的唯一完整检查。',
        metadata: { version: 1, continuityAssessmentRequestKey: legacyContinuityAssessmentKey(ctx, frozen.input), assessmentChapterId: frozen.input.chapterId,
          callId: frozen.operationId, input: JSON.parse(JSON.stringify(frozen.input)), admissionId: frozen.operationId, logicalKind: 'manual_review_repair' } } })
      await tx.agentRun.update({ where: { id: runId }, data: { status: 'running', finishedAt: null, errorMessage: null } })
      const owner = await claimApplyOwner(tx, frozen)
      return { kind: 'new' as const, frozen, ownerSeq: owner.seq }
    }, { isolationLevel: 'Serializable' })
    if (admitted.kind === 'replay') return admitted.replay
    const frozen = admitted.frozen, controller = new AbortController()
    owners.set(frozen.operationId, { controller, seq: admitted.ownerSeq })
    registerActiveRun(runId, { controller, userId, sessionId: frozen.sessionId })
    const job = Promise.resolve().then(() => admitted.kind === 'new' ? execute(frozen, controller)
      : admitted.response ? applyResponse(frozen, controller, admitted.response) : completeApplied(frozen, controller, admitted.applied)).catch(() => {
      // Unknown persistence/transport outcomes are never converted into a retry.
    }).finally(() => { jobs.delete(frozen.operationId); if (owners.get(frozen.operationId)?.controller === controller) owners.delete(frozen.operationId);
      if (getActiveRun(runId)?.controller === controller) deregisterActiveRun(runId) })
    jobs.set(frozen.operationId, job)
    return prisma.$transaction(tx => status(tx, userId, runId, frozen.operationId))
  })
}

async function assertCurrent(tx: Prisma.TransactionClient, frozen: Frozen, controller: AbortController) {
  controller.signal.throwIfAborted(); await lock(tx, frozen.subject)
  if (getActiveRun(frozen.subject.runId)?.controller !== controller || !await currentOwner(tx, frozen, controller)) refuse('修复执行所有者已失效。')
  await assertAgentManuscriptCurrent(tx, frozen.subject)
  if (hash(await facts(tx, frozen.subject.userId, frozen.subject.runId, frozen)) !== hash(frozen)) refuse('修复执行的作者授权、正文、来源或模型已变化。')
  controller.signal.throwIfAborted()
}

async function execute(frozen: Frozen, controller: AbortController) {
  const { subject, operationId } = frozen, trace = createTextRequestTrace(), ctx = context(subject, frozen, controller.signal)
  let observed: Observation | undefined
  try {
    const runtime = await getModelTierRuntime(frozen.model.tier, subject.userId, frozen.model.customModelId, frozen.model.reasoningEffort)
    if (runtimeHash(runtime) !== frozen.runtimeHash) refuse('原模型路由已变化，未替换模型。')
    await withTextRequestTrace(trace, () => generateTextCompletion(frozen.input.system, frozen.input.content, {
      ...subject, userId: subject.userId, novelId: subject.novelId, agentRunId: subject.runId, chapterId: frozen.input.chapterId,
      action: 'agent3ContinuityCritic', targetType: frozen.input.targetType, targetId: frozen.input.targetId, modelRuntime: runtime,
      explicitModelSelection: true, boundedReview: true, maxOutputTokens: REVIEW_MAX_OUTPUT_TOKENS, temperature: 0,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(env.aiTextTimeoutMs)]), responseFormat: 'json_object',
      authorizedRequest: { price: frozen.price, inputTokenCeiling: frozen.inputTokenCeiling, maxCreditMilli: frozen.maxCreditMilli,
        manualReviewRepairOperationId: frozen.operationId,
        beforeDispatch: () => prisma.$transaction(tx => assertCurrent(tx, frozen, controller), { isolationLevel: 'Serializable' }) },
      beforeProviderDispatch: usageId => prisma.$transaction(async tx => {
        await assertCurrent(tx, frozen, controller)
        if (await tx.agentRunEvent.findUnique({ where: { id: repairEventId(operationId, 'dispatch') } })) refuse('修复请求已派发或结果未知，不能再次发送。')
        await appendManualRepairEvent(tx, subject.runId, operationId, 'dispatch', { usageId, frozenHash: hash(frozen), maxProviderDispatches: 1 })
        await bindLegacyContinuityRequest(tx, ctx, frozen.input, usageId, 'first', () => assertCurrent(tx, frozen, controller))
      }, { isolationLevel: 'Serializable' }).then(() => {}),
      onObservedCompletion: value => { observed = { ...value, toolCalls: [...value.toolCalls] } },
    }))
  } catch { /* Preserve actual trace and raw below, including cancellation. */ }
  const response = observed
  if (response) await prisma.$transaction(async tx => {
    await lock(tx, subject)
    await observeLegacyContinuityAssessment(tx, ctx, frozen.input, response, [response.usageId], 'first')
  }, { isolationLevel: 'Serializable' })
  if (!response || trace.records.length !== 1 || trace.records[0].usageId !== response.usageId) {
    await stopIncomplete(frozen, controller, '原请求结果或用量尚未确认；未再次派发。', true)
    return
  }
  await applyResponse(frozen, controller, response)
}

async function accountKnownUsage(tx: Prisma.TransactionClient, frozen: Frozen) {
  if (await readManualRepairEvent(tx, frozen.subject.runId, frozen.operationId, 'usage_accounted')) return
  const dispatch = await readManualRepairEvent(tx, frozen.subject.runId, frozen.operationId, 'dispatch')
  if (!dispatch) return
  const paid = await tx.aiUsageLog.findFirst({ where: { id: String(dispatch.value.usageId), userId: frozen.subject.userId,
    novelId: frozen.subject.novelId, agentRunId: frozen.subject.runId } })
  if (!paid || paid.usageSource !== 'reported' || paid.requestTokens === null || paid.responseTokens === null
    || !Number.isSafeInteger(paid.requestTokens) || !Number.isSafeInteger(paid.responseTokens) || paid.requestTokens < 0 || paid.responseTokens < 0) return
  const run = await owned(tx, frozen.subject.userId, frozen.subject.runId), usage = savedRunUsageSchema.parse(run.usage)
  const totals = { promptTokens: usage.promptTokens + paid.requestTokens, completionTokens: usage.completionTokens + paid.responseTokens,
    totalTokens: usage.totalTokens + paid.requestTokens + paid.responseTokens }
  if (Object.values(totals).some(value => !Number.isSafeInteger(value))) refuse('实际用量累计超出安全范围，保留原回执待核对。')
  await tx.agentRun.update({ where: { id: run.id }, data: { usage: { ...record(run.usage), ...totals } } })
  await appendManualRepairEvent(tx, run.id, frozen.operationId, 'usage_accounted', { usageId: paid.id, requestTokens: paid.requestTokens, responseTokens: paid.responseTokens })
}

async function applyResponse(frozen: Frozen, controller: AbortController, response: Observation) {
  const { subject, operationId } = frozen, ctx = context(subject, frozen, controller.signal)
  try {
    const applied = await prisma.$transaction(async tx => {
      await assertCurrent(tx, frozen, controller)
      const assessed = await readLegacyContinuityAssessment(tx, ctx, frozen.input)
      if (!assessed.billingKnown || !assessed.providerComplete || !assessed.recoveryReady) refuse('修复响应或费用仍待核实。')
      const inspected = inspectContinuityV4(response.content, frozen.review, response.transportComplete !== false && response.finishReason === 'stop' && !response.toolCalls.length)
      if (!inspected.complete || !assessed.inspected.complete) refuse('本次完整修复响应未满足合同，唯一请求已使用。')
      const bound = bindLegacyContinuityAssessment(assessed.inspected, ctx, frozen.input)
      const report = await validateStoryContinuity({ ...subject, compilationId: frozen.input.targetId, findings: bound.findings,
        expectedChapterRevision: frozen.input.revision, expectedTerminalCandidateHash: hash(frozen.input.terminalCandidate),
        independentCheck: 'complete', terminalCandidate: frozen.input.terminalCandidate, continuityCriticResponse: bound.audit,
        coverage: frozen.coverage, focus: frozen.focus, signal: controller.signal }, tx)
      await accountKnownUsage(tx, frozen)
      const committed = await chapterBridgeCommitTool.execute({ ...ctx, transaction: tx }, { compilationId: frozen.input.targetId })
      await appendManualRepairEvent(tx, subject.runId, operationId, 'applied', { reportId: frozen.input.targetId, auditHash: hash(bound.audit),
        usageIds: [response.usageId], terminalCommitted: !!committed.requiredResult, independentCheck: report.independentCheck })
      controller.signal.throwIfAborted()
      return { terminalCommitted: !!committed.requiredResult }
    }, { isolationLevel: 'Serializable' })
    await completeApplied(frozen, controller, applied.terminalCommitted)
  } catch (error) {
    const paid = await prisma.$transaction(tx => tx.aiUsageLog.findFirst({ where: { id: response.usageId, userId: subject.userId, agentRunId: subject.runId } }))
    const unknown = !paid || paid.usageSource !== 'reported' || !['settled', 'exempt'].includes(paid.billingStatus ?? '')
    await stopIncomplete(frozen, controller, error instanceof DataAccessError ? error.message : '修复结果尚未完成当前版本核对，原记录保留。', unknown)
  }
}

async function completeApplied(frozen: Frozen, controller: AbortController, terminalCommitted: boolean) {
  controller.signal.throwIfAborted()
  const completed = terminalCommitted && await (await import('./loop.js')).finishManualReviewRepairWriting(frozen.subject, controller.signal, async tx => {
    await lock(tx, frozen.subject)
    controller.signal.throwIfAborted()
    const run = await owned(tx, frozen.subject.userId, frozen.subject.runId)
    if (run.status !== 'running' || record(run.usage).authorEnded !== undefined || !await currentOwner(tx, frozen, controller)) refuse('修复交付所有者或取消凭据已变化，未写入终态。')
  })
  await finish(frozen, controller, { operationId: frozen.operationId, eventStartSeq: 0, state: completed ? 'complete' : 'incomplete', reportId: frozen.input.targetId,
    terminalCommitted, needsContinuation: terminalCommitted && !completed,
    message: completed ? '完整修复与原章节交付已完成。' : '完整报告已保留，原任务仍有未满足的提交或交付条件。' })
}

async function finish(frozen: Frozen, controller: AbortController, result: ManualReviewRepairStatus) {
  await prisma.$transaction(async tx => {
    await lock(tx, frozen.subject)
    await accountKnownUsage(tx, frozen)
    if (!await currentOwner(tx, frozen, controller)) return
    const grant = await readManualRepairEvent(tx, frozen.subject.runId, frozen.operationId, 'authorized')
    const ownerSeq = owners.get(frozen.operationId)!.seq
    await appendManualRepairEvent(tx, frozen.subject.runId, frozen.operationId, `finished_${ownerSeq}`, { ...result, eventStartSeq: grant!.row.seq - 1 })
    if (getActiveRun(frozen.subject.runId)?.controller === controller) await tx.agentRun.updateMany({ where: { id: frozen.subject.runId, status: 'running' }, data: { status: 'paused' } })
  }, { isolationLevel: 'Serializable' })
}
async function stopIncomplete(frozen: Frozen, controller: AbortController, message: string, unknown: boolean) {
  await finish(frozen, controller, { operationId: frozen.operationId, eventStartSeq: 0, state: unknown ? 'unknown' : 'incomplete', reportId: null,
    terminalCommitted: false, needsContinuation: false, message })
}
