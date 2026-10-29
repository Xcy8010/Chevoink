import { Prisma } from '@prisma/client'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { prisma, DataAccessError } from '../prisma.js'
import { activeChapterScope } from '../data/internal.js'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'
import { continuityFindingInputSchema, type ContinuityFindingInput } from '../../../shared/contracts/story-compiler-contracts.js'
import { buildQualityEvidenceSources, locateQualityFindingSpans, parseQualityJsonObject, renderQualityEvidenceSources, type QualityEvidenceSources } from './quality-evidence.js'
import { createTextRequestTrace, textRequestsFinished, withTextRequestTrace } from '../text-request-trace.js'
import { generateReviewCompletion, runReviewStep } from './review-completion.js'
import { resolveReviewModelRuntime } from './runtime-auxiliary-call.js'
import { readOriginalTaskRequest, originalTaskRunIds, originalRepairAuthority } from './original-request.js'
import { assertAgentManuscriptCurrent } from './manuscript-scope.js'
import { buildHumanityQualityContext, qualityCompilationScope, resolveQualityChapterTarget } from './humanity-quality.js'
import { readNewDraftWritingAuthority } from './writing-scope.js'
import { selectAutomaticQualityFindings } from './quality-report-contract.js'
import { parseQualityRepairResponse, partitionQualityRepairResponse, QUALITY_REPAIR_RETAIN_RULE } from './quality-repair-response.js'
import { runtimeJson } from './runtime-common.js'
import { isKnownTextRequestBilling } from './text-request-billing.js'
import type { ToolContext, ToolResult } from './tools/types.js'

const textHash = (text: string) => createHash('sha256').update(text).digest('hex')
const findingSchema = z.object({ signal: continuityFindingInputSchema.shape.signal, severity: continuityFindingInputSchema.shape.severity,
  explanation: z.string().min(1).max(1000), suggestion: z.string().min(1).max(1000),
  evidence: z.array(z.object({ sourceId: z.string().min(1).max(96) }).strict()).min(1).max(8) }).strict()
export const continuityReportResponseSchema = z.object({ findings: z.array(findingSchema) }).strict()
export type ContinuityOpinion = z.infer<typeof findingSchema>
type LocatedFinding = ContinuityFindingInput & { id: string; explanation: string; startOffset: number; endOffset: number;
  references: Array<{ sourceId: string; chapterId: string; revision: number; source: 'current' | 'previous'; start: number; end: number; quote: string }> }
export type ContinuityReport = { version: 1; id: string; taskId: string; chapterId: string; revision: number; contextHash: string;
  nativeOperationId?: string;
  focus?: string;
  sourceVersions?: Array<{ chapterId: string; revision: number; contentHash: string }>;
  contentHash: string; complete: boolean; findings: LocatedFinding[]; opinions: ContinuityOpinion[]; unlocatedIndexes: number[];
  rawResponses: string[]; usageIds: string[]; nativeReceiptIds?: string[]; billingKnown: boolean; repairAttempted?: boolean; repairResponseIndex?: number; repairResult?: ToolResult; repairFailure?: string;
  incompleteResponses?: number[];
  retainedProposals?: Array<{ findingId: string; reason: string }>;
  history?: Array<{ rawResponses: string[]; incompleteResponses?: number[]; usageIds: string[]; nativeReceiptIds?: string[]; opinions: ContinuityOpinion[]; complete: boolean; billingKnown: boolean; error?: string }> }
export type ContinuityReviewArgs = { chapterId?: string; compilationId?: string; focus?: string }
export type ContinuitySnapshot = Awaited<ReturnType<typeof buildContinuitySnapshot>>

/** A source-address error must not erase a recognizable editorial opinion. */
export function inspectContinuityOpinions(raw: string) {
  let rows: unknown[] | null = null
  try { const parsed = z.object({ findings: z.array(z.unknown()) }).safeParse(parseQualityJsonObject(raw, 'findings', 3)); if (parsed.success) rows = parsed.data.findings } catch { /* Keep the original response. */ }
  const recognized = (rows ?? []).flatMap((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return []
    const value = row as Record<string, unknown>, semantic = findingSchema.omit({ evidence: true }).safeParse({ signal: value.signal,
      severity: value.severity, explanation: value.explanation, suggestion: value.suggestion })
    if (!semantic.success) return []
    const evidence = findingSchema.shape.evidence.safeParse(value.evidence)
    return [{ index, opinion: { ...semantic.data, evidence: evidence.success ? evidence.data : [] } }]
  })
  return { rows, recognized, opinions: recognized.map(row => row.opinion), structured: rows !== null && recognized.length === rows.length }
}

export function continuityFormatRecoveryPreservesOpinions(before: ReturnType<typeof inspectContinuityOpinions>, after: ReturnType<typeof inspectContinuityOpinions>) {
  const semantic = ({ evidence: _evidence, ...opinion }: ContinuityOpinion) => opinion
  return after.structured && (!before.rows || before.rows.length === after.rows!.length && before.recognized.every(row =>
    runtimeJson(semantic(row.opinion)).hash === runtimeJson(semantic(after.opinions[row.index])).hash))
}

export function correctContinuitySourceIds(opinions: ContinuityOpinion[], invalidIndexes: number[], raw: string) {
  const corrected = [...opinions]
  try {
    const rows = z.object({ corrections: z.array(z.object({ index: z.number().int().nonnegative(), evidence: findingSchema.shape.evidence }).strict()) }).strict()
      .parse(parseQualityJsonObject(raw, 'corrections', 3)).corrections
    const duplicates = new Set(rows.filter((row, index) => rows.findIndex(other => other.index === row.index) !== index).map(row => row.index))
    for (const row of rows) if (invalidIndexes.includes(row.index) && !duplicates.has(row.index)) corrected[row.index] = { ...corrected[row.index], evidence: row.evidence }
  } catch { /* Original judgments remain intact. */ }
  return corrected
}

export async function buildContinuitySnapshot(ctx: Pick<ToolContext, 'userId' | 'novelId' | 'runId' | 'chapterId'>,
  args: ContinuityReviewArgs, db: Prisma.TransactionClient = prisma) {
  const chapterId = await resolveQualityChapterTarget({ userId: ctx.userId, novelId: ctx.novelId, runId: ctx.runId, ...args, fallbackChapterId: ctx.chapterId }, db)
  if (!chapterId) throw new DataAccessError(404, 'CHAPTER_NOT_FOUND', '没有可检查的当前章节正文。')
  const chapter = await db.chapter.findFirst({ where: { id: chapterId, authorId: ctx.userId, ...activeChapterScope(ctx.novelId) } })
  if (!chapter?.content.trim()) throw new DataAccessError(404, 'CHAPTER_NOT_FOUND', '没有可检查的当前章节正文。')
  const original = await readOriginalTaskRequest(db, ctx), runIds = await originalTaskRunIds(db, ctx, original)
  const [previous, compilation] = await Promise.all([
    db.chapter.findMany({ where: { authorId: ctx.userId, ...activeChapterScope(ctx.novelId), orderIndex: { lt: chapter.orderIndex } },
      orderBy: { orderIndex: 'desc' }, take: 3, select: { id: true, title: true, revision: true, content: true, orderIndex: true } }),
    db.storyCompilation.findFirst({ where: { userId: ctx.userId, novelId: ctx.novelId, chapterId, ...await qualityCompilationScope(db, ctx.userId, ctx.novelId, ctx.runId),
      ...(args.compilationId ? { id: args.compilationId } : {}), status: { in: ['active', 'completed'] } }, orderBy: { createdAt: 'desc' } }),
  ])
  if (args.compilationId && !compilation) throw new DataAccessError(409, 'COMPILATION_NOT_FOUND', '编译任务不属于当前章节与作者任务。')
  const sources = [chapter, ...previous].map(source => ({ chapterId: source.id, revision: source.revision, orderIndex: source.orderIndex,
    title: source.title, source: source.id === chapter.id ? 'current' as const : 'previous' as const, content: source.content,
    table: buildQualityEvidenceSources({ userId: ctx.userId, novelId: ctx.novelId, chapterId: source.id, chapterRevision: source.revision }, source.content) }))
  const contextHash = runtimeJson({ taskId: original.taskId, chapterId, sources: sources.map(source => ({ chapterId: source.chapterId,
    revision: source.revision, orderIndex: source.orderIndex, contentHash: source.table.contentHash })), authorRequest: original.prompt, focus: args.focus ?? null }).hash
  return { chapter, previous, compilation, original, runIds, sources, contextHash }
}

/** Only an actual table entry can supply evidence; explanations are opinions. */
export function bindContinuityOpinions(opinions: ContinuityOpinion[], sources: Array<{ source: 'current' | 'previous'; content: string; table: QualityEvidenceSources }>) {
  const findings: LocatedFinding[] = [], unlocatedIndexes: number[] = []
  for (const [index, opinion] of opinions.entries()) {
    const evidence = opinion.evidence.map(reference => {
      const matches = sources.flatMap(source => {
        const spans = locateQualityFindingSpans(source.content, { sourceId: reference.sourceId }, source.table)
        return spans.map(span => ({ ...span, source: source.source, quote: source.content.slice(span.start, span.end),
          sourceId: source.table.entries.find(entry => entry.start === span.start && entry.end === span.end)!.id,
          chapterId: source.table.identity.chapterId, revision: source.table.identity.chapterRevision }))
      })
      return matches.length === 1 ? matches[0] : null
    })
    const current = evidence.find(item => item?.source === 'current')
    if (!evidence.length || evidence.some(item => !item)) { unlocatedIndexes.push(index); continue }
    findings.push({ id: String(index), signal: opinion.signal, severity: opinion.severity, explanation: opinion.explanation,
      evidence: (current ?? evidence[0]!).quote, suggestion: `${opinion.explanation}\n${opinion.suggestion}`,
      startOffset: current?.start ?? -1, endOffset: current?.end ?? -1,
      sourceEvidence: evidence.map(item => ({ source: item!.source, quote: item!.quote })), references: evidence.map(item => item!) })
  }
  return { findings, unlocatedIndexes }
}

export function readContinuityReport(validation: unknown, chapter: { id: string; revision: number; content: string }, contextHash?: string): ContinuityReport | null {
  const value = validation && typeof validation === 'object' && !Array.isArray(validation) ? validation as Record<string, unknown> : {}
  const report = value.continuityReport as ContinuityReport | undefined
  return report?.version === 1 && report.chapterId === chapter.id && report.revision === chapter.revision
    && report.contentHash === textHash(chapter.content) && (contextHash === undefined || report.contextHash === contextHash) ? report : null
}

const criticSystem = `你是中文小说连续性编辑。完整阅读本章和实际前文，核查人物知识、时空、身体、物品、关系、动作归属与因果。
只报告有证据的具体矛盾，不把疑问、未解谜、风格偏好或作者计划当既定事实。每条意见选择本次表里的sourceId，不抄引文、不编编号；编号只证明位置，不证明意见正确。
一个真实原文片段即可支持一条具体矛盾意见；不要为凑引用数量选择无关段落。保留所有真实意见及严重度，不为通过删意见。解释与建议是意见，不是事实认证。
严格输出 ${JSON.stringify(z.toJSONSchema(continuityReportResponseSchema, { io: 'input' }))}`

export function continuityReviewRequest(snapshot: Pick<ContinuitySnapshot, 'chapter' | 'sources' | 'original'>, focus?: string) {
  return { system: criticSystem, content: JSON.stringify({ authorRequest: snapshot.original.prompt, focus: focus ?? null,
    currentChapter: snapshot.chapter.id, sources: snapshot.sources.map(source => ({ chapterId: source.chapterId, revision: source.revision,
      orderIndex: source.orderIndex, source: source.source, content: source.content, evidence: renderQualityEvidenceSources(source.table) })) }) }
}

async function assertCurrent(ctx: ToolContext, args: ContinuityReviewArgs, snapshot: ContinuitySnapshot, db: Prisma.TransactionClient = prisma) {
  ctx.signal.throwIfAborted()
  await assertAgentManuscriptCurrent(db, ctx)
  if (!ctx.durableCompiler && !ctx.continuityNativeLease) await ctx.assertCurrentExecution?.(db)
  const current = await buildContinuitySnapshot(ctx, args, db)
  if (current.contextHash !== snapshot.contextHash) throw new DataAccessError(409, 'CONTINUITY_INPUT_STALE', '正文或前文已变化，报告未绑定到新版本。')
}

async function savePhysicalReport(ctx: ToolContext, snapshot: ContinuitySnapshot, report: ContinuityReport, requestClosed = true) {
  // Save physical output independently of binding it to a current revision.
  // A stale/cancelled input may not lose a paid response or overwrite new prose.
  await prisma.agentArtifact.update({ where: { id: report.id }, data: { content: JSON.stringify(report), metadata: runtimeJson({
    continuityReport: report, requestClosed, callId: ctx.callId, contextHash: snapshot.contextHash,
    ...(report.nativeOperationId ? { nativeOperationId: report.nativeOperationId } : {}) }).value } })
}

async function saveReport(ctx: ToolContext, args: ContinuityReviewArgs, snapshot: ContinuitySnapshot, report: ContinuityReport, requestClosed = true) {
  await savePhysicalReport(ctx, snapshot, report, requestClosed)
  if (ctx.durableCompiler || ctx.continuityNativeLease) return // Native canonical writes use the admitted operation's one effect transaction.
  await prisma.$transaction(async tx => {
    await lockNovelActiveScope(tx, ctx.novelId)
    await assertCurrent(ctx, args, snapshot, tx)
    await bindContinuityReport(tx, snapshot, report)
  }, { timeout: 20000 })
}

export async function bindContinuityReport(tx: Prisma.TransactionClient, snapshot: ContinuitySnapshot, report: ContinuityReport) {
  if (snapshot.compilation) {
      const current = await tx.storyCompilation.findUniqueOrThrow({ where: { id: snapshot.compilation.id }, include: { bridge: true } })
      const previous = current.validation && typeof current.validation === 'object' && !Array.isArray(current.validation) ? current.validation : {}
      const prepared = current.preparedContext && typeof current.preparedContext === 'object' && !Array.isArray(current.preparedContext) ? current.preparedContext : {}
      const committed = current.status === 'completed' && current.stage === 'commit' && current.bridge?.committedAt
        && current.bridge.targetRevision === report.revision && prepared.terminalContentHash === runtimeJson({ content: snapshot.chapter.content }).hash
      await tx.storyCompilation.update({ where: { id: current.id }, data: { ...(committed ? {} : { stage: report.findings.length ? 'repair' : 'check' }), validation: runtimeJson({ ...previous,
        checkedChapterId: report.chapterId, checkedRevision: report.revision, checkedContent: snapshot.chapter.content,
        checkedAt: new Date().toISOString(), independentCheck: report.complete ? 'complete' : 'unavailable', findings: report.findings,
        reviewFocus: report.focus ?? null,
        errorCount: report.findings.filter(finding => finding.severity === 'error').length,
        warningCount: report.findings.filter(finding => finding.severity === 'warning').length, continuityReport: report }).value } })
  }
}

function reportResult(snapshot: ContinuitySnapshot, report: ContinuityReport, cached = false): ToolResult {
  const errors = report.findings.filter(finding => finding.severity === 'error').length, warnings = report.findings.length - errors
  return { ...(report.complete && report.billingKnown ? {} : { outcome: 'failed' as const, failureCode: report.billingKnown ? 'CONTINUITY_REPORT_INCOMPLETE' : 'AI_PROVIDER_BILLING_UNCONFIRMED' }),
    reviewCompleted: report.complete, reviewOutcome: !report.billingKnown ? 'provider_unresolved' : !report.complete ? 'evidence_repair_required' : report.findings.length ? 'decision_required' : 'complete',
    reviewRequestFinished: report.billingKnown ? { version: 1, chapterId: report.chapterId, revision: report.revision, contentHash: report.contentHash } : undefined,
    summary: report.complete ? `连续性检查完成 · ${errors} 错误 ${warnings} 警告` : '连续性报告未完成',
    output: `reportId=${report.id}；chapterId=${report.chapterId}；revision=${report.revision}\n所检 r${report.revision}${cached ? '复用已保存报告' : '已保存连续性报告'}：${errors} 个错误、${warnings} 个警告。${report.complete
      ? report.findings.length ? '报告已保存，以下问题待处理。' : '未发现连续性问题。'
      : `有 ${report.unlocatedIndexes.length} 条意见未定位，报告未完成。`}
${report.findings.map(finding => `[${finding.id}/${finding.severity}/${finding.signal}] ${finding.startOffset >= 0 ? `本章范围[${finding.startOffset},${finding.endOffset})` : '前文意见'}；原文：${JSON.stringify(finding.evidence)}\n证据：${JSON.stringify(finding.references)}\n解释：${finding.explanation}\n建议：${finding.suggestion}`).join('\n')}
${report.unlocatedIndexes.map(index => `未定位意见[${index}]：${JSON.stringify(report.opinions[index])}`).join('\n')}
${report.retainedProposals?.length ? `修订保留建议：${JSON.stringify(report.retainedProposals.map(item => ({ source: 'continuity', reportId: report.id, ...item })))}` : ''}
${report.repairFailure ? `报告已取得，自动修订未应用：${report.repairFailure}` : ''}`,
    display: { kind: 'storyCompiler', compilationId: snapshot.compilation?.id ?? '', phase: errors ? 'repair' : 'check', title: '连续性检查',
      detail: `${errors} 错误 · ${warnings} 警告`, errorCount: errors, warningCount: warnings,
      items: report.findings.map(finding => finding.explanation) } }
}

export type ContinuityDispatch = (request: { system: string; content: string; action: string }, assertCurrent: () => Promise<void>) => Promise<{ content: string; usageIds: string[]; nativeReceiptIds?: string[]; billingKnown: boolean; providerComplete?: boolean }>
export type ContinuityBilling = { known: boolean; hasRequest: boolean; usageIds: string[]; nativeReceiptIds: string[] }
export type ContinuityApplyRepair = (report: ContinuityReport, work: (tx: Prisma.TransactionClient) => Promise<ToolResult>) => Promise<ToolResult>

/** Physical accounting is adapter-specific. Empty legacy usage is never a
 * substitute for a native provider attempt or its settlement receipt. */
export async function readContinuityRequestBilling(db: Prisma.TransactionClient, ctx: Pick<ToolContext, 'userId' | 'novelId'>,
  snapshot: { runIds: string[]; chapter: { id: string } }, nativeActionPrefix: string | null = 'continuity_'): Promise<ContinuityBilling> {
  const [fees, operations, historical] = await Promise.all([
    db.aiUsageLog.findMany({ where: { userId: ctx.userId, novelId: ctx.novelId, agentRunId: { in: snapshot.runIds },
      chapterId: snapshot.chapter.id, action: { startsWith: 'agent3Continuity' } } }),
    db.agentOperation.findMany({ where: { originRunId: { in: snapshot.runIds }, kind: 'provider', ...(nativeActionPrefix ? { action: { startsWith: nativeActionPrefix } } : {}),
      taskRoot: { userId: ctx.userId, novelId: ctx.novelId } }, include: { attempts: { include: { usageReceipt: true } }, events: true } }),
    (await import('./continuity-history.js')).readHistoricalContinuityBilling(db, ctx, snapshot),
  ])
  let known = historical.known && fees.every(isKnownTextRequestBilling)
  const nativeReceiptIds: string[] = []
  for (const operation of operations) {
    if (!operation.inputSnapshot || runtimeJson(operation.inputSnapshot).hash !== operation.inputHash) { known = false; continue }
    const charge = await db.creditLedgerEntry.findUnique({ where: { idempotencyKey: `operation:${operation.id}` } })
    // The native producer persists prepared work before admitting HTTP. Resume
    // that same owned operation; an unsent preparation has no unknown response.
    if (operation.status === 'prepared' && !charge && (operation.attempts.length === 0 || operation.attempts.length === 1
      && operation.attempts[0].status === 'prepared' && !operation.attempts[0].dispatchedAt
      && !operation.attempts[0].resultHash && !operation.attempts[0].usageReceipt
      && operation.attempts[0].requestSnapshot && runtimeJson(operation.attempts[0].requestSnapshot).hash === operation.attempts[0].requestHash)) continue
    if (operation.attempts.length !== 1) { known = false; continue }
    const attempt = operation.attempts[0], usage = attempt.usageReceipt
    if (!attempt.requestSnapshot || runtimeJson(attempt.requestSnapshot).hash !== attempt.requestHash
      || !attempt.resultHash || runtimeJson(attempt.result).hash !== attempt.resultHash) { known = false; continue }
    const failed = z.object({ outcome: z.literal('failed'), result: z.object({ httpStatus: z.number().int(), code: z.literal('AI_PROVIDER_QUOTA_EXCEEDED').optional() }).strict() }).strict().safeParse(attempt.result)
    const resultEvent = operation.events.find(event => event.eventKey === `result:${attempt.id}:${attempt.resultHash}`)
    const failureRecorded = operation.status === 'failed' && attempt.status === 'failed' && !!attempt.dispatchedAt && failed.success
      && resultEvent?.type === 'provider.result.recorded' && runtimeJson(resultEvent.payload).hash === runtimeJson({
        attemptId: attempt.id, status: 'failed', resultHash: attempt.resultHash }).hash
    // Same confirmed HTTP rejection classification as beginDurableChat's
    // producer. A quota failure, partial usage or generic failure stays unknown.
    if (failureRecorded && !failed.data.result.code && !usage && !charge
      && [400, 401, 403, 404, 422, 429].includes(failed.data.result.httpStatus)) { nativeReceiptIds.push(attempt.id); continue }
    if (operation.status === 'cancelled' && attempt.status === 'cancelled' && !attempt.dispatchedAt) {
      const result = z.object({ outcome: z.literal('cancelled'), result: z.object({ code: z.string(), dispatched: z.literal(false) }) }).safeParse(attempt.result)
      const event = operation.events.find(event => event.eventKey === `provider.not_dispatched:${attempt.id}`)
      if (!result.success || usage || charge || event?.type !== 'provider.not_dispatched' || runtimeJson(event.payload).hash !== runtimeJson({
        attemptId: attempt.id, requestHash: attempt.requestHash, code: result.data.result.code, resultHash: attempt.resultHash }).hash) known = false
      else nativeReceiptIds.push(attempt.id)
      continue
    }
    const measurement = usage && { source: usage.source, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens,
      cacheHitTokens: usage.cacheHitTokens, cacheMissTokens: usage.cacheMissTokens }
    const settlement = operation.events.find(event => event.eventKey === `settlement:${operation.id}`)
    const status = failureRecorded ? 'failed' : 'succeeded'
    if (operation.status !== status || attempt.status !== status || !usage || usage.source !== 'reported'
      || usage.promptTokens === null || usage.completionTokens === null || usage.settlementStatus !== 'settled'
      || runtimeJson(measurement).hash !== usage.observationHash || !charge || !settlement
      || resultEvent?.type !== 'provider.result.recorded' || runtimeJson(resultEvent.payload).hash !== runtimeJson({
        attemptId: attempt.id, status, resultHash: attempt.resultHash }).hash) known = false
    else nativeReceiptIds.push(usage.attemptId)
  }
  return { known, hasRequest: historical.hasRequest || fees.length > 0 || operations.length > 0,
    usageIds: [...new Set([...fees.map(fee => fee.id), ...historical.usageIds])], nativeReceiptIds }
}

async function legacyDispatch(ctx: ToolContext, snapshot: ContinuitySnapshot, id: string): Promise<ContinuityDispatch> {
  const runtime = await resolveReviewModelRuntime({ ...ctx, task: 'continuity' })
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(env.aiTextTimeoutMs)])
  return async (request, current) => {
    await current()
    const trace = createTextRequestTrace()
    const content = await withTextRequestTrace(trace, () => runReviewStep(ctx.signal, signal, () => generateReviewCompletion(request.system, request.content,
      { modelRuntime: runtime, explicitModelSelection: true, signal, userId: ctx.userId, agentRunId: ctx.runId, action: request.action,
        novelId: ctx.novelId, chapterId: snapshot.chapter.id, targetType: 'continuity_report', targetId: id, temperature: 0.15,
        reasoningEffort: runtime.reasoningEffort, beforeProviderDispatch: async () => { await current() } }, current)))
    return { content, usageIds: trace.records.map(record => record.usageId), billingKnown: textRequestsFinished(trace) }
  }
}

/** One service for legacy tools and native adapters. Reports are cached by the
 * actual task/body/source context, never by a paid phase or a revision quota. */
export async function reviewContinuity(ctx: ToolContext, args: ContinuityReviewArgs,
  options: { snapshot?: ContinuitySnapshot; dispatch?: ContinuityDispatch; readBilling?: () => Promise<ContinuityBilling>; applyRepair?: ContinuityApplyRepair; allowRepair?: boolean; resumeKnownRequest?: string } = {}): Promise<ToolResult> {
  ctx.signal.throwIfAborted()
  const snapshot = options.snapshot ?? await buildContinuitySnapshot(ctx, args)
  const id = runtimeJson({ kind: 'continuity-report', taskId: snapshot.original.taskId, chapterId: snapshot.chapter.id, contextHash: snapshot.contextHash }).hash
  const saved = await prisma.agentArtifact.findUnique({ where: { id } })
  const metadata = saved?.metadata && typeof saved.metadata === 'object' && !Array.isArray(saved.metadata) ? saved.metadata as Record<string, unknown> : {}
  const previous = metadata.continuityReport as ContinuityReport | undefined
  const readBilling = options.readBilling ?? (() => readContinuityRequestBilling(prisma, ctx, snapshot))
  const billing = await readBilling()
  if (!billing.known) throw new DataAccessError(409, 'AI_PROVIDER_BILLING_UNCONFIRMED', '原连续性请求的用量或费用尚未确认，未重复请求。')
  if (previous?.complete) {
    ctx.signal.throwIfAborted()
    const cached = { ...previous, billingKnown: true }
    if (!previous.billingKnown) await prisma.agentArtifact.update({ where: { id }, data: { content: JSON.stringify(cached),
      metadata: runtimeJson({ ...metadata, continuityReport: cached }).value } })
    if (!ctx.durableCompiler && !ctx.continuityNativeLease) await prisma.$transaction(async tx => {
      await lockNovelActiveScope(tx, ctx.novelId)
      await assertCurrent(ctx, args, snapshot, tx)
      await bindContinuityReport(tx, snapshot, cached)
    }, { timeout: 20000 })
    if (cached.repairResult) return cached.repairResult
    return finishContinuityReview(ctx, args, snapshot, cached, { ...options, nativeOperationId: options.resumeKnownRequest,
      resumeRepair: !!options.resumeKnownRequest && !!ctx.continuityNativeLease && metadata.callId === ctx.callId
        && (metadata.nativeOperationId ?? cached.nativeOperationId) === options.resumeKnownRequest }, true)
  }
  if (saved && metadata.requestClosed !== true) {
    const callId = typeof metadata.callId === 'string' ? metadata.callId : null
    const ended = callId && await prisma.agentRunEvent.findFirst({ where: { runId: saved.runId, type: 'tool.result', createdAt: { gte: saved.updatedAt },
      AND: [{ payload: { path: ['callId'], equals: callId } }, { payload: { path: ['ok'], equals: false } }] } })
    const ownedNativeReplay = options.resumeKnownRequest && ctx.continuityNativeLease && metadata.callId === ctx.callId
      && (metadata.nativeOperationId ?? previous?.nativeOperationId) === options.resumeKnownRequest
    if (!ended && !ownedNativeReplay) throw new DataAccessError(409, 'AI_PROVIDER_BILLING_UNCONFIRMED', '原连续性请求尚未确认结束，未重复请求。')
  }
  const dispatch = options.dispatch ?? await legacyDispatch(ctx, snapshot, id)
  await assertCurrent(ctx, args, snapshot)
  const started = { contextHash: snapshot.contextHash, chapterId: snapshot.chapter.id, revision: snapshot.chapter.revision, callId: ctx.callId,
    ...(options.resumeKnownRequest ? { nativeOperationId: options.resumeKnownRequest } : {}),
    requestClosed: false, ...(previous ? { continuityReport: previous } : {}) }
  if (saved) await prisma.agentArtifact.update({ where: { id }, data: { metadata: runtimeJson(started).value } })
  else await prisma.agentArtifact.create({ data: { id, runId: ctx.runId, artifactType: 'continuityReview', title: '连续性检查', content: '检查请求已登记。', metadata: runtimeJson(started).value } })
  const history = previous ? [...(previous.history ?? []), { rawResponses: previous.rawResponses, usageIds: previous.usageIds,
    incompleteResponses: previous.incompleteResponses ?? [], nativeReceiptIds: previous.nativeReceiptIds ?? [], opinions: previous.opinions, complete: previous.complete, billingKnown: previous.billingKnown }] : []
  let report: ContinuityReport = { version: 1, id, taskId: snapshot.original.taskId, chapterId: snapshot.chapter.id, revision: snapshot.chapter.revision,
    ...(options.resumeKnownRequest ? { nativeOperationId: options.resumeKnownRequest } : {}),
    ...(args.focus ? { focus: args.focus } : {}),
    sourceVersions: snapshot.sources.map(source => ({ chapterId: source.chapterId, revision: source.revision, contentHash: source.table.contentHash })),
    contextHash: snapshot.contextHash, contentHash: textHash(snapshot.chapter.content), complete: false,
    opinions: previous?.opinions ?? [], findings: [], unlocatedIndexes: [], rawResponses: [], usageIds: [], billingKnown: true, history }
  let lastProviderComplete = true
  const call = async (system: string, content: string, action: string) => {
    const response = await dispatch({ system, content, action }, () => assertCurrent(ctx, args, snapshot))
    lastProviderComplete = response.providerComplete !== false
    report = { ...report, rawResponses: [...report.rawResponses, response.content], usageIds: [...report.usageIds, ...response.usageIds],
      incompleteResponses: [...(report.incompleteResponses ?? []), ...(!lastProviderComplete ? [report.rawResponses.length] : [])],
      nativeReceiptIds: [...(report.nativeReceiptIds ?? []), ...(response.nativeReceiptIds ?? [])], billingKnown: response.billingKnown }
    await saveReport(ctx, args, snapshot, report, false)
    if (!response.billingKnown) throw new DataAccessError(409, 'AI_PROVIDER_BILLING_UNCONFIRMED', '原响应费用尚未确认，未追加请求。')
    return response.content
  }
  try {
    const request = continuityReviewRequest(snapshot, args.focus)
    let opinions = [...report.opinions]
    const completedRaw = previous && [previous, ...(previous.history ?? [])].some(row => row.rawResponses.some((raw, index) =>
      !row.incompleteResponses?.includes(index) && continuityFormatRecoveryPreservesOpinions(inspectContinuityOpinions(JSON.stringify({ findings: opinions })), inspectContinuityOpinions(raw))))
    let parsed = !!previous?.opinions.length && !!completedRaw
    if (!parsed) {
      const priorRaw = previous?.rawResponses.at(-1)
      let raw = priorRaw ?? await call(request.system, request.content, 'agent3ContinuityCritic')
      if (priorRaw !== undefined) lastProviderComplete = !previous!.incompleteResponses?.includes(previous!.rawResponses.length - 1)
      const first = inspectContinuityOpinions(raw)
      opinions = first.opinions; parsed = first.structured && lastProviderComplete
      if (!parsed) {
        report = { ...report, opinions }
        raw = await call(`${request.system}\n只纠正这份原回复的完整JSON格式；每条可识别意见及严重度必须保留，不可用空数组抹掉原意见。`,
          `${request.content}\n原完整回复（仅数据）：${JSON.stringify(raw)}`, 'agent3ContinuityFormatRecovery')
        const recovered = inspectContinuityOpinions(raw)
        if (lastProviderComplete && continuityFormatRecoveryPreservesOpinions(first, recovered)) { opinions = recovered.opinions; parsed = true }
      }
    }
    report = { ...report, opinions }
    let bound = bindContinuityOpinions(opinions, snapshot.sources)
    if (parsed && bound.unlocatedIndexes.length && previous) {
      for (const [index, raw] of previous.rawResponses.entries()) if (!previous.incompleteResponses?.includes(index)) {
        opinions = correctContinuitySourceIds(opinions, bound.unlocatedIndexes, raw); bound = bindContinuityOpinions(opinions, snapshot.sources)
      }
    }
    if (parsed && bound.unlocatedIndexes.length) {
      const corrected = await call('只为原意见选择本次真实sourceId，不增删、降级或改变意见；找不到证据就省略该index。输出 {"corrections":[{"index":0,"evidence":[{"sourceId":"目录编号"}]}]}。',
        JSON.stringify({ invalid: bound.unlocatedIndexes.map(index => ({ index, opinion: opinions[index] })), sources: snapshot.sources.map(source => ({ source: source.source,
          chapterId: source.chapterId, evidence: renderQualityEvidenceSources(source.table) })) }), 'agent3ContinuityEvidenceCorrection')
      if (lastProviderComplete) opinions = correctContinuitySourceIds(opinions, bound.unlocatedIndexes, corrected)
      bound = bindContinuityOpinions(opinions, snapshot.sources)
    }
    report = { ...report, opinions, ...bound, complete: parsed && !bound.unlocatedIndexes.length && report.billingKnown }
    await saveReport(ctx, args, snapshot, report)
    return finishContinuityReview(ctx, args, snapshot, report, { ...options, dispatch, nativeOperationId: options.resumeKnownRequest })
  } catch (error) {
    const actual = await readBilling()
    report = { ...report, complete: false, billingKnown: actual.known,
      usageIds: [...new Set([...report.usageIds, ...actual.usageIds])], nativeReceiptIds: [...new Set([...(report.nativeReceiptIds ?? []), ...actual.nativeReceiptIds])],
      history: [...history, { rawResponses: report.rawResponses, incompleteResponses: report.incompleteResponses ?? [], usageIds: actual.usageIds, nativeReceiptIds: actual.nativeReceiptIds, opinions: report.opinions, complete: false,
        billingKnown: actual.known, error: error instanceof DataAccessError ? error.code : 'CONTINUITY_REQUEST_FAILED' }] }
    // Preserve an interrupted physical response even when cancellation/staleness
    // prevents attaching it to today's compilation.
    await prisma.agentArtifact.update({ where: { id }, data: { content: JSON.stringify(report), metadata: runtimeJson({ contextHash: snapshot.contextHash,
      callId: ctx.callId, requestClosed: true, continuityReport: report }).value } })
    throw error
  }
}

async function finishContinuityReview(ctx: ToolContext, args: ContinuityReviewArgs, snapshot: ContinuitySnapshot, report: ContinuityReport,
  options: { dispatch?: ContinuityDispatch; applyRepair?: ContinuityApplyRepair; allowRepair?: boolean; resumeRepair?: boolean; nativeOperationId?: string }, cached = false): Promise<ToolResult> {
  ctx.signal.throwIfAborted()
  if (report.repairResult?.outcome === 'failed') return report.repairResult
  const savedRepair = report.repairResponseIndex === undefined ? undefined : report.rawResponses[report.repairResponseIndex]
  if (!report.complete || report.repairAttempted && !savedRepair && !options.resumeRepair || options.allowRepair === false || ctx.mode !== 'build' || ctx.creativeFreedom !== 'balanced'
    || ctx.inlineChild || ctx.sandboxMode === 'read_only' || ctx.protectedChapterIds?.has(report.chapterId)) return reportResult(snapshot, report, cached)
  const { automaticChapterRevisionWritable } = await import('./tools/chapter-mutation.js')
  if (!await automaticChapterRevisionWritable(prisma, ctx)) return reportResult(snapshot, report, cached)
  const allowed = originalRepairAuthority(snapshot.original) || !!await readNewDraftWritingAuthority(prisma, ctx, snapshot.chapter)
  const selected = allowed ? selectAutomaticQualityFindings(report.findings.filter(finding => finding.startOffset >= 0 && finding.endOffset > finding.startOffset)) : []
  if (!selected.length) return reportResult(snapshot, report, cached)
  const { probeChapterReviewRevision, readChapterReviewReadiness } = await import('./chapter-review-guard.js')
  const review = snapshot.compilation ? await readChapterReviewReadiness(prisma, ctx, snapshot.compilation.id) : null
  if ((await import('./review-cycle.js')).verificationQualityAdviceRequiresDecision(review, selected)) return reportResult(snapshot, report, cached)
  const preflight = await prisma.$transaction(tx => probeChapterReviewRevision(tx, ctx,
    { id: snapshot.chapter.id, revision: snapshot.chapter.revision }, { mutation: 'replace' }))
  if (!preflight.open) return reportResult(snapshot, { ...report, repairFailure: preflight.message }, cached)
  const { buildQualityRepairContext } = await import('./tools/humanity-quality-tools.js')
  const writingContext = buildQualityRepairContext(await buildHumanityQualityContext(ctx.userId, ctx.novelId, snapshot.chapter.id, ctx.runId))
  // Same per-report local repair policy as humanity. This never blocks later
  // normal edits or checks of the actual new revision.
  const dispatch = savedRepair ? null : options.dispatch ?? await legacyDispatch(ctx, snapshot, report.id)
  if (!savedRepair) { report = { ...report, repairAttempted: true,
    ...(options.nativeOperationId ? { nativeOperationId: options.nativeOperationId } : {}) }; await saveReport(ctx, args, snapshot, report) }
  try {
  if (!savedRepair) {
  const response = await dispatch!({ action: 'agent3ContinuityRevision', system: `${QUALITY_REPAIR_RETAIN_RULE}\n输出 {"patches":[{"findingId":"0","replacement":"替换文本"}],"retainedFindings":[{"findingId":"1","reason":"保留理由"}]}。只替换列出的本章原文片段，不更改其他段落。`,
    content: JSON.stringify({ authorRequest: snapshot.original.prompt, writingContext, current: snapshot.chapter.content, findings: selected.map(finding => ({ findingId: finding.id, explanation: finding.explanation,
      suggestion: finding.suggestion, original: snapshot.chapter.content.slice(finding.startOffset, finding.endOffset) })) }) }, async () => {
    await assertCurrent(ctx, args, snapshot)
    if (!await automaticChapterRevisionWritable(prisma, ctx)) throw new DataAccessError(409, 'REPAIR_NOT_AUTHORIZED', '当前会话不允许改稿，正文未修改。')
  })
  report = { ...report, ...(response.providerComplete !== false ? { repairResponseIndex: report.rawResponses.length } : {}), rawResponses: [...report.rawResponses, response.content], usageIds: [...report.usageIds, ...response.usageIds],
    incompleteResponses: [...(report.incompleteResponses ?? []), ...(response.providerComplete === false ? [report.rawResponses.length] : [])],
    nativeReceiptIds: [...(report.nativeReceiptIds ?? []), ...(response.nativeReceiptIds ?? [])], billingKnown: response.billingKnown }
  await saveReport(ctx, args, snapshot, report)
  if (!response.billingKnown) throw new DataAccessError(409, 'AI_PROVIDER_BILLING_UNCONFIRMED', '修订响应的费用未确认，正文未应用。')
  if (response.providerComplete === false) throw new DataAccessError(409, 'CONTINUITY_REPORT_INCOMPLETE', '修订回复未完整返回，正文未应用。')
  }
  let patches: Array<{ findingId: string; replacement: string }> = []
  try { const partitioned = partitionQualityRepairResponse(parseQualityRepairResponse(parseQualityJsonObject(savedRepair ?? report.rawResponses[report.repairResponseIndex!], 'patches', 3)), selected.map(finding => finding.id))
    patches = partitioned.patches.map(patch => ({ findingId: patch.id, replacement: patch.replacement }))
    report = { ...report, retainedProposals: partitioned.retainedFindings.map(item => ({ findingId: item.id, reason: item.reason })) }
  } catch {
    throw new DataAccessError(409, 'CONTINUITY_REPAIR_FAILED', '修订回复未形成可验证的局部补丁；正文未改动，原意见及回复已保留。')
  }
  await saveReport(ctx, args, snapshot, report)
  if (!patches.length) {
    report = { ...report, repairFailure: '修订器没有提出安全且必要的局部替换，原意见保留待审。' }
    await saveReport(ctx, args, snapshot, report)
    if (report.retainedProposals?.length === selected.length) return reportResult(snapshot, report)
    throw new DataAccessError(409, 'CONTINUITY_REPAIR_FAILED', '修订回复未完整处理当前意见，正文未改动。')
  }
  const apply = async (tx: Prisma.TransactionClient) => {
    await lockNovelActiveScope(tx, ctx.novelId); await assertCurrent(ctx, args, snapshot, tx)
    if (!await automaticChapterRevisionWritable(tx, ctx)) throw new DataAccessError(409, 'REPAIR_NOT_AUTHORIZED', '当前会话不允许改稿，正文未修改。')
    const ranges = patches.map(patch => { const finding = selected.find(finding => finding.id === patch.findingId)!
      return { start: finding.startOffset, end: finding.endOffset, newText: patch.replacement } }).sort((a, b) => a.start - b.start)
    let after = snapshot.chapter.content
    for (const range of [...ranges].reverse()) after = after.slice(0, range.start) + range.newText + after.slice(range.end)
    if (after === snapshot.chapter.content) throw new DataAccessError(409, 'CONTINUITY_REPAIR_FAILED', '修订回复没有实际正文变化，原意见保留。')
    const { updateOwnedChapterAtRevision } = await import('./tools/chapter-mutation.js')
    const updated = await updateOwnedChapterAtRevision({ ...ctx, transaction: tx }, snapshot.chapter, { content: after, wordCount: after.length }, 'range', true, { editRanges: ranges })
    if (!updated) throw new DataAccessError(409, 'CHAPTER_REVISION_CONFLICT', '正文已变化，未应用旧修订。')
    await (await import('../data/internal.js')).recalculateNovelStats(tx, ctx.novelId)
    if ((await import('../agent2-feature-flags.js')).isAgent2FeatureEnabled('memory2', ctx.userId)) await (await import('./story-memory.js')).enqueueChapterMemoryExtraction({
      novelId: ctx.novelId, chapterId: updated.id, chapterRevision: updated.revision, before: snapshot.chapter.content, after }, tx)
    const { repairFailure: _failure, ...appliedReport } = report
    const checked = reportResult(snapshot, appliedReport)
    const result: ToolResult = { reviewCompleted: false, reviewOutcome: 'stale', reviewRequestFinished: checked.reviewRequestFinished,
      summary: `连续性检查完成 · 已局部修订至 r${updated.revision}，需复查`,
      output: `已局部修订 ${ranges.length} 处至 r${updated.revision}，需复查最终版的连续性与人类感质量。以下为改前 r${report.revision} 报告：\n${checked.output}`,
      display: { kind: 'chapterDiff', chapterId: updated.id, chapterTitle: updated.title, before: snapshot.chapter.content, after,
        appliedDirectly: true, revision: updated.revision }, snapshot: { target: 'chapter', targetId: updated.id, field: 'content', previousValue: snapshot.chapter.content } }
    await tx.agentArtifact.update({ where: { id: report.id }, data: { metadata: runtimeJson({ contextHash: snapshot.contextHash, callId: ctx.callId,
      requestClosed: true, continuityReport: { ...appliedReport, repairResult: result } }).value } })
    return result
  }
  return await (options.applyRepair ? options.applyRepair(report, apply) : prisma.$transaction(apply, { timeout: 20000 }))
  } catch (error) {
    const actual = await readContinuityRequestBilling(prisma, ctx, snapshot)
    const saved = await prisma.agentArtifact.findUnique({ where: { id: report.id } })
    const value = saved?.metadata && typeof saved.metadata === 'object' && !Array.isArray(saved.metadata) ? saved.metadata : {}
    const stored = value.continuityReport as ContinuityReport | undefined
    report = { ...(stored?.id === report.id && stored.contextHash === report.contextHash ? stored : report), repairAttempted: true, billingKnown: actual.known,
      repairFailure: error instanceof Error ? error.message : '自动修订未应用，原报告与正文保留。',
      history: [...(report.history ?? []), { rawResponses: report.rawResponses, usageIds: report.usageIds, nativeReceiptIds: report.nativeReceiptIds ?? [],
        opinions: report.opinions, complete: report.complete, billingKnown: actual.known, error: error instanceof DataAccessError ? error.code : 'CONTINUITY_REPAIR_FAILED' }] }
    const knownFailure = actual.known && !ctx.signal.aborted && error instanceof DataAccessError
      && !error.code.startsWith('RUNTIME_') && error.code !== 'AI_PROVIDER_BILLING_UNCONFIRMED'
    if (knownFailure) report = { ...report, repairResult: { ...reportResult(snapshot, report), outcome: 'failed', failureCode: error.code,
      summary: '连续性报告已保存 · 自动修订未应用' } }
    await savePhysicalReport(ctx, snapshot, report)
    if (!knownFailure) throw error
    return report.repairResult!
  }

}
