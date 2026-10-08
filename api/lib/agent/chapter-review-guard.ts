import { Prisma } from '@prisma/client'
import { DataAccessError } from '../prisma.js'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'
import { continuityCheckRounds, continuityRepairRounds } from './story-compiler.js'
import { readOriginalTaskRequest, originalTaskRunIds, hasOriginalRepairAuthority } from './original-request.js'
import { activeChapterScope } from '../data/internal.js'
import { compilerContinuityCoverage, compilerContinuityCoverageMatches, currentCompilerContinuityAssessment, completeCompilerContinuityAssessment, continuityStoryInput } from './compiler-continuity-contract.js'
import { qualityReportCheckedCurrentContent, selectAutomaticQualityFindings, qualityAutoRepairPending } from './quality-report-contract.js'
import { continuityFindingInputSchema } from '../../../shared/contracts/story-compiler-contracts.js'
import { runtimeJson } from './runtime-common.js'

type ReviewStatus = 'complete' | 'missing' | 'stale' | 'incomplete'
// Prisma rows contain Dates; persist only JSON-safe finding data in the binding.
function qualityDecisionHash(findings: unknown[]) {
  return runtimeJson(JSON.parse(JSON.stringify(findings))).hash
}
export type ChapterReviewRevisionOptions = {
  requireQualityChannel?: boolean
  /** Pending quality has no persisted report yet; check required continuity
   * before paying for a repair, without treating candidates as a report. */
  requireCurrentContinuity?: boolean
  mutation?: 'replace' | 'range' | 'append'
  mergedBatch?: boolean
  after?: string
  editRanges?: Array<{ start: number; end: number; newText: string }>
  retainedFindings?: Array<{ source: 'continuity' | 'quality'; reportId: string; findingId: string; reason: string }>
  pendingQuality?: { compilationId: string; candidates: number }
}
export type ChapterReviewReadiness = {
  ready: boolean; checksRequired: boolean; compilationId: string; chapterId: string; revision: number
  continuity: ReviewStatus; quality: ReviewStatus; continuityErrorCount: number; qualityErrorCount: number
  qualityCandidateCount?: number
  continuityExhausted?: boolean
  qualityReportId: string | null; requiredTools: Array<{ name: 'continuity_validate' | 'quality_analyze'; args: { compilationId: string } }>
}

/** Only authenticated original human text may waive a delivery assessment. */
export function originalChapterReviewRequirements(original: { prompt: string | null; spec: unknown }) {
  const spec = original.spec && typeof original.spec === 'object' && !Array.isArray(original.spec) ? original.spec as Record<string, unknown> : null
  const writing = ['write', 'revise'].includes(String(spec?.intent)) && !['conversation_only', 'proposal_only'].includes(String(spec?.writingPacing))
    && ['balanced', 'premium'].includes(String(spec?.qualityMode))
  const clauses = original.prompt?.split(/[。！？!?；;\n，,]+/u) ?? []
  const waived = (kind: 'continuity' | 'quality') => clauses.some(clause =>
    !/(?:不要|不得|不能|不许|勿|不可|禁止)\s*(?:再)?\s*(?:跳过|省略|略过|取消)|(?:do not|don't|never|must not)\s+(?:skip|omit|bypass)/iu.test(clause)
    && !/(?:标题|章名|错别字|标点|单句|前文|前章|第[\d一二三四五六七八九十百千零〇两]+章)/u.test(clause)
    && /(?:不要|无需|不用|不必|跳过|不做|不进行|skip|do not|don't).{0,12}(?:检查|审查|审阅|评估|check|review)/iu.test(clause)
    && (/(?:不要|无需|不用|不必|跳过)(?:再|做|进行|任何|所有|全部|自动|额外|完整)*(?:检查|审查|审阅|评估)(?:了)?\s*$/u.test(clause)
      || /(?:skip|do not|don't).{0,8}(?:all|any).{0,8}(?:checks|reviews)/iu.test(clause)
      || (kind === 'quality' ? /质量|人类感|AI味|quality/iu : /连续性|连贯性|一致性|continuity/iu).test(clause)))
  return { continuity: writing && !waived('continuity'), quality: writing && !waived('quality') }
}

/** Server COMMIT proof preserves the exact reviewed bridge; it never rewrites
 * a critic's hash. Any subsequent story-state change invalidates this proof. */
export function terminalReviewStateHash(bridge: unknown, sceneTasks: unknown[]) {
  return runtimeJson({ bridge: continuityStoryInput(JSON.parse(JSON.stringify(bridge))), scenes: continuityStoryInput(JSON.parse(JSON.stringify(sceneTasks))) }).hash
}

/** Fresh current-state assessments take precedence over the original COMMIT
 * proof. The proof only preserves an assessment of the reviewed precommit
 * bridge; it must not hide a later read-only assessment of the terminal bridge. */
export function readCurrentCompilerContinuity(compilation: {
  status: string; stage: string; validation: unknown; preparedContext: unknown
  bridge: { targetRevision: number | null; committedAt: Date | null }; sceneTasks: Array<{ ordinal: number }>
}, chapter: { id: string; title?: string; revision: number; content: string; orderIndex: number }, source: unknown | null) {
  const validation = compilation.validation && typeof compilation.validation === 'object' && !Array.isArray(compilation.validation)
    ? compilation.validation as Record<string, unknown> : null
  const scenes = [...compilation.sceneTasks].sort((a, b) => a.ordinal - b.ordinal)
  const coverageFor = (bridge: unknown) => compilerContinuityCoverage({ chapter, bridge, sceneTasks: scenes, source,
    focus: typeof validation?.reviewFocus === 'string' ? validation.reviewFocus : undefined })
  const coverage = coverageFor(compilation.bridge)
  const assessment = currentCompilerContinuityAssessment(validation, chapter, coverage)
  if (assessment) return { assessment, coverage, checkedBridge: compilation.bridge }
  const context = compilation.preparedContext && typeof compilation.preparedContext === 'object' && !Array.isArray(compilation.preparedContext)
    ? compilation.preparedContext as Record<string, unknown> : null
  const proof = context?.terminalReviewProof && typeof context.terminalReviewProof === 'object' && !Array.isArray(context.terminalReviewProof)
    ? context.terminalReviewProof as Record<string, unknown> : null
  const proofCurrent = compilation.status === 'completed' && compilation.stage === 'commit' && compilation.bridge.targetRevision === chapter.revision
    && !!compilation.bridge.committedAt && context?.terminalContentHash === runtimeJson({ content: chapter.content }).hash
    && proof?.version === 1 && !!proof.checkedBridge && typeof proof.checkedBridge === 'object' && !Array.isArray(proof.checkedBridge)
    && proof.terminalStateHash === terminalReviewStateHash(compilation.bridge, scenes)
  const proofCoverage = proofCurrent ? coverageFor(proof!.checkedBridge) : null
  const proofAssessment = proofCoverage ? currentCompilerContinuityAssessment(validation, chapter, proofCoverage) : null
  return { assessment: proofAssessment, coverage: proofAssessment ? proofCoverage! : coverage,
    checkedBridge: proofAssessment ? proof!.checkedBridge : compilation.bridge }
}

/** A pure persisted-state read: no paid calls, reservations, repairs or counters.
 * Callers dispatch only the returned tools through the ordinary tool journal. */
export async function readChapterReviewReadiness(tx: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string }, compilationId?: string): Promise<ChapterReviewReadiness | null> {
  const original = await readOriginalTaskRequest(tx, subject)
  const runIds = await originalTaskRunIds(tx, subject, original)
  const compilation = await tx.storyCompilation.findFirst({ where: { userId: subject.userId, novelId: subject.novelId, runId: { in: runIds },
    ...(compilationId ? { id: compilationId } : {}), status: { in: ['active', 'completed'] } },
    include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  if (!compilation?.chapterId || !compilation.bridge) return null
  const chapter = await tx.chapter.findFirst({ where: { id: compilation.chapterId, authorId: subject.userId, ...activeChapterScope(subject.novelId) },
    select: { id: true, title: true, revision: true, content: true, orderIndex: true } })
  if (!chapter?.content.trim()) return null
  const source = compilation.bridge.fromChapterId ? await tx.chapter.findFirst({ where: { id: compilation.bridge.fromChapterId,
    ...activeChapterScope(subject.novelId) }, select: { id: true, revision: true, content: true } }) : null
  if (compilation.bridge.fromChapterId && source?.revision !== compilation.bridge.sourceRevision) {
    throw new DataAccessError(409, 'CONTINUITY_INPUT_STALE', '章节桥来源版本已变化，保留原编译与正文，不能自动重建或沿用旧检查交付。')
  }
  const requirements = originalChapterReviewRequirements(original)
  const validation = compilation.validation && typeof compilation.validation === 'object' && !Array.isArray(compilation.validation) ? compilation.validation : null
  const { assessment } = readCurrentCompilerContinuity({ ...compilation, bridge: compilation.bridge }, chapter, source)
  const validationStale = !!validation && (typeof validation.checkedChapterId === 'string' && validation.checkedChapterId !== chapter.id
    || typeof validation.checkedRevision === 'number' && validation.checkedRevision !== chapter.revision)
  const continuity: ReviewStatus = assessment ? 'complete' : !validation ? 'missing' : validationStale ? 'stale'
    : !completeCompilerContinuityAssessment(validation) ? 'incomplete' : 'stale'
  // Latest assessment wins. A failed later attempt must not resurrect an older
  // complete report, and repairedContentHash certifies no new critic call.
  const report = await tx.chapterQualityReport.findFirst({ where: { userId: subject.userId, novelId: subject.novelId, compilationId: compilation.id,
    chapterId: chapter.id, runId: { in: runIds } }, include: { findings: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  const metrics = report?.deterministicMetrics && typeof report.deterministicMetrics === 'object' && !Array.isArray(report.deterministicMetrics) ? report.deterministicMetrics : null
  const quality: ReviewStatus = report && qualityReportCheckedCurrentContent(report, chapter.revision, chapter.content) ? 'complete'
    : !report ? 'missing' : ['failed', 'analyzing'].includes(report.status) || metrics?.independentCheck !== 'complete'
      || typeof metrics.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(metrics.contentHash) ? 'incomplete' : 'stale'
  const requiredTools: ChapterReviewReadiness['requiredTools'] = []
  if (requirements.continuity && continuity !== 'complete') requiredTools.push({ name: 'continuity_validate', args: { compilationId: compilation.id } })
  if (requirements.quality && quality !== 'complete') requiredTools.push({ name: 'quality_analyze', args: { compilationId: compilation.id } })
  return { ready: !requiredTools.length, checksRequired: requirements.continuity || requirements.quality, compilationId: compilation.id,
    chapterId: chapter.id, revision: chapter.revision, continuity, quality, requiredTools,
    continuityExhausted: false,
    continuityErrorCount: assessment?.errorCount ?? 0, qualityErrorCount: quality === 'complete' ? report!.findings.filter(finding =>
      finding.severity === 'error' && finding.disposition !== 'repaired' && finding.authorFeedback !== 'rejected').length : 0,
    qualityCandidateCount: quality === 'complete' ? selectAutomaticQualityFindings(report!.findings).length : 0,
    qualityReportId: quality === 'complete' ? report!.id : null }
}

export function continuityDecisionBinding(compilationId: string, revision: number, validation: unknown) {
  const value = validation && typeof validation === 'object' && !Array.isArray(validation) ? validation as Record<string, unknown> : {}
  return `${compilationId}:r${revision}:${runtimeJson({ coverage: value.coverage ?? null, findings: value.findings ?? [],
    checkedChapterId: value.checkedChapterId ?? null, checkedRevision: value.checkedRevision ?? null }).hash}`
}

/** Ordinary manuscript tools use the original writing grant, not the paid
 * reviewer's repair allowance. Callers still fence the run, target and body CAS
 * in this transaction. Reviews certify only the body they actually checked. */
export async function assertChapterManuscriptRevision(tx: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string }, chapter: { id: string; revision: number },
  options: ChapterReviewRevisionOptions) {
  await lockNovelActiveScope(tx, subject.novelId)
  const original = await readOriginalTaskRequest(tx, subject)
  const runIds = await originalTaskRunIds(tx, subject, original)
  await tx.$queryRaw(Prisma.sql`SELECT id FROM story_compilations WHERE user_id = ${subject.userId}
    AND novel_id = ${subject.novelId} AND chapter_id = ${chapter.id} AND run_id IN (${Prisma.join(runIds)}) ORDER BY id FOR UPDATE`)
  const compilations = await tx.storyCompilation.findMany({ where: { userId: subject.userId, novelId: subject.novelId,
    chapterId: chapter.id, runId: { in: runIds } }, include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  const { readNewDraftRevision, readNewDraftWritingAuthority, prohibitsNewDraftRevision } = await import('./writing-scope.js')
  // Validate old receipts even though they are no longer a normal-write quota.
  const receipts = compilations.map(item => readNewDraftRevision(item.validation))
  const current = await tx.chapter.findFirst({ where: { id: chapter.id, revision: chapter.revision, authorId: subject.userId,
    ...activeChapterScope(subject.novelId) }, select: { id: true, title: true, revision: true, content: true, orderIndex: true } })
  if (!current) throw new DataAccessError(409, 'CHAPTER_REVISION_CONFLICT', '章节已变化或不属于当前作者作品，正文未写入。')
  const authority = await readNewDraftWritingAuthority(tx, subject, current)
  if (authority && receipts.some(receipt => receipt && (receipt.taskId !== authority.taskId || receipt.chapterId !== current.id))) {
    throw new DataAccessError(409, 'RUNTIME_RECEIPT_INVALID', '原新稿修订凭证不属于当前任务或章节，不能重绑授权。')
  }
  const reports = await tx.chapterQualityReport.findMany({ where: { userId: subject.userId, novelId: subject.novelId,
    chapterId: current.id, runId: { in: runIds } }, include: { findings: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  const reviewed = reports.length > 0 || compilations.some(item => continuityCheckRounds(item.validation) > 0
    || !!item.validation && typeof item.validation === 'object' && !Array.isArray(item.validation) && typeof item.validation.checkedRevision === 'number')
  const spec = original.spec && typeof original.spec === 'object' && !Array.isArray(original.spec) ? original.spec as Record<string, unknown> : null
  const prohibited = prohibitsNewDraftRevision(original.prompt) || Array.isArray(spec?.hardConstraints) && spec.hardConstraints.some(item =>
    !!item && typeof item === 'object' && 'text' in item && typeof item.text === 'string' && prohibitsNewDraftRevision(item.text))
  if (prohibited || (!authority && reviewed && !hasOriginalRepairAuthority(original.prompt))) {
    throw new DataAccessError(409, 'REPAIR_NOT_AUTHORIZED', '原始作者请求未授权改写该正文；检查报告不能扩大写入权限。')
  }
  const latest = compilations.find(item => item.status === 'active' && item.bridge && !item.bridge.committedAt)
  const quality = reports[0]
  if (options.retainedFindings?.length) {
    const source = latest?.bridge?.fromChapterId ? await tx.chapter.findFirst({ where: { id: latest.bridge.fromChapterId,
      ...activeChapterScope(subject.novelId) }, select: { id: true, revision: true, content: true } }) : null
    const continuity = latest?.bridge && (!latest.bridge.fromChapterId || source?.revision === latest.bridge.sourceRevision)
      ? readCurrentCompilerContinuity({ ...latest, bridge: latest.bridge }, current, source).assessment : null
    const qualityComplete = !!quality && qualityReportCheckedCurrentContent(quality, current.revision, current.content)
    const binding = latest ? continuityDecisionBinding(latest.id, current.revision, latest.validation) : null
    const continuityFindings = continuity && latest?.validation && typeof latest.validation === 'object' && !Array.isArray(latest.validation)
      && Array.isArray(latest.validation.findings) ? latest.validation.findings.map(item => continuityFindingInputSchema.parse(item)) : []
    const entries = [
      ...continuityFindings.map((finding, index) => ({ source: 'continuity' as const, reportId: binding!, findingId: String(index), required: finding.severity === 'error' })),
      ...(qualityComplete ? quality!.findings.map(finding => ({ source: 'quality' as const, reportId: quality!.id, findingId: finding.id,
        required: selectAutomaticQualityFindings(quality!.findings).some(item => item.id === finding.id) })) : []),
    ]
    const retained = options.retainedFindings
    const key = (item: { source: string; reportId: string; findingId: string }) => `${item.source}:${item.reportId}:${item.findingId}`
    if (new Set(retained.map(key)).size !== retained.length || retained.some(item => !item.reason.trim() || !entries.some(entry => key(entry) === key(item)))) {
      throw new DataAccessError(409, 'REVIEW_MERGED_REVISION_REQUIRED', '留置意见必须引用当前版本真实报告的意见并说明原因；旧报告、跨章或重复引用不允许写入。')
    }
    const requirements = originalChapterReviewRequirements(original)
    if (options.after === current.content && latest && (!requirements.continuity || continuity)
      && (!requirements.quality || qualityComplete && quality!.compilationId === latest.id)
      && entries.filter(entry => entry.required).every(entry => retained.some(item => key(item) === key(entry)))) {
      await tx.storyCompilation.update({ where: { id: latest.id }, data: { validation: {
        ...(latest.validation && typeof latest.validation === 'object' && !Array.isArray(latest.validation) ? latest.validation : {}),
        retainedReviewDecision: { version: 1, chapterId: current.id, revision: current.revision,
          contentHash: runtimeJson({ content: current.content }).hash, continuityBinding: binding,
          qualityReportId: qualityComplete ? quality!.id : null, qualityReportHash: qualityComplete ? qualityDecisionHash(quality!.findings) : null,
          findings: retained },
      } as Prisma.InputJsonValue } })
    }
  }
  // This historical receipt closes the bounded automatic-remediation decision,
  // not the author's writing grant. Only a real, successful CAS may mint it;
  // later writes preserve it and never alter paid/check counters or reports.
  if (authority && reviewed && latest && !receipts.some(Boolean) && options.after !== undefined && options.after !== current.content) {
    return async () => {
      await tx.storyCompilation.update({ where: { id: latest.id }, data: { validation: {
        ...(latest.validation && typeof latest.validation === 'object' && !Array.isArray(latest.validation) ? latest.validation : {}),
        newDraftRevision: { version: 1, taskId: authority.taskId, chapterId: current.id, compilationId: latest.id,
          checkedRevision: current.revision, beforeHash: runtimeJson({ content: current.content }).hash,
          afterHash: runtimeJson({ content: options.after! }).hash, retainedFindings: options.retainedFindings ?? [] },
      } as Prisma.InputJsonValue } })
    }
  }
}

/** A review cannot enlarge the author's request. Paid automatic repair and
 * read-only automatic reachability use this bounded decision guard. Ordinary
 * manuscript tools use their distinct server-only admission above.
 * It never promotes failed/stale reports into a current quality conclusion.
 * A fresh draft may spend one merged correction on either a current-version
 * factual error or a complete current quality report; strict-mode quality
 * repair declares itself so it never consumes the factual channel first. */
export async function assertChapterReviewRevision(
  tx: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string },
  chapter: { id: string; revision: number },
  options?: ChapterReviewRevisionOptions,
) {
  await lockNovelActiveScope(tx, subject.novelId)
  const original = await readOriginalTaskRequest(tx, subject)
  const runIds = await originalTaskRunIds(tx, subject, original)
  // Check/repair reservations also lock these rows. Read counters and preserve
  // their latest values before creating the CAS-bound consumption callback.
  await tx.$queryRaw(Prisma.sql`SELECT id FROM story_compilations WHERE user_id = ${subject.userId}
    AND novel_id = ${subject.novelId} AND chapter_id = ${chapter.id} AND run_id IN (${Prisma.join(runIds)}) ORDER BY id FOR UPDATE`)
  const compilations = await tx.storyCompilation.findMany({ where: {
    // Repreparing a compiler cannot erase the review that already drove a patch.
    runId: { in: runIds }, userId: subject.userId, novelId: subject.novelId, chapterId: chapter.id,
  }, include: { bridge: true, sceneTasks: { orderBy: { ordinal: 'asc' } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  const { readNewDraftRevision, readNewDraftWritingAuthority } = await import('./writing-scope.js')
  if (compilations.some(item => readNewDraftRevision(item.validation))) {
    throw new DataAccessError(409, 'REVIEW_AUTOMATION_STOPPED', '本任务新稿已处理过本轮自动修订决定，不再触发额外自动修订。原授权正文工具仍可依据当前正文连续修改；复核、父子任务或重新准备不能补充付费自动修订额度。剩余意见保持真实状态，不能宣称已通过。')
  }
  const reports = await tx.chapterQualityReport.findMany({ where: {
    userId: subject.userId, novelId: subject.novelId, chapterId: chapter.id, runId: { in: runIds },
  }, select: { chapterRevision: true, repairRound: true } })
  if (reports.some(report => report.repairRound >= 1)) {
    throw new DataAccessError(409, 'REVIEW_AUTOMATION_STOPPED', '本章已有一次付费自动修订，已停止追加自动修订。原授权正文工具仍可依据当前正文连续修改；换工具或重新准备不能补充付费自动修订额度，剩余意见不能冒充已通过。')
  }
  const validations = compilations.flatMap(item => {
    const value = item.validation
    return value && typeof value === 'object' && !Array.isArray(value) ? [value] : []
  })
  if (options?.requireCurrentContinuity && !options.mutation && !hasOriginalRepairAuthority(original.prompt)) {
    const current = await tx.chapter.findFirst({ where: { id: chapter.id, revision: chapter.revision, authorId: subject.userId,
      ...activeChapterScope(subject.novelId) }, select: { id: true, title: true, revision: true, content: true, orderIndex: true } })
    const authority = current?.content.trim() ? await readNewDraftWritingAuthority(tx, subject, current) : null
    if (authority && current && originalChapterReviewRequirements(original).continuity) {
      const bound = compilations.find(item => item.id === options.pendingQuality?.compilationId && item.status === 'active'
        && item.bridge && !item.bridge.committedAt)
      const source = bound?.bridge?.fromChapterId ? await tx.chapter.findFirst({ where: { id: bound.bridge.fromChapterId,
        ...activeChapterScope(subject.novelId) }, select: { id: true, revision: true, content: true } }) : null
      const complete = bound?.bridge && (!bound.bridge.fromChapterId || source?.revision === bound.bridge.sourceRevision)
        && readCurrentCompilerContinuity({ ...bound, bridge: bound.bridge }, current, source).assessment
      if (!complete) throw new DataAccessError(409, 'REVIEW_REPAIR_RECHECK_REQUIRED', '质量报告照常保存；同一编译的当前正文尚未完成原要求连续性检查，不预约或付费自动修订。先完成 continuity_validate，再根据全部当前报告合并一次尚未执行的授权修订；累计检查与用量记录保留。')
    }
  }
  const reviewed = reports.length > 0 || validations.some(value => continuityCheckRounds(value) > 0 || typeof value.checkedRevision === 'number')
  if (!reviewed) return
  if (!hasOriginalRepairAuthority(original.prompt)) {
    const current = await tx.chapter.findFirst({ where: { id: chapter.id, revision: chapter.revision,
      authorId: subject.userId, ...activeChapterScope(subject.novelId) }, select: { id: true, title: true, revision: true, content: true, orderIndex: true } })
    const authority = current?.content.trim() ? await readNewDraftWritingAuthority(tx, subject, current) : null
    // Only the latest report can drive this patch. A later failed check or a
    // reprepared compiler cannot resurrect an earlier complete assessment.
    const latest = compilations.find(item => {
      const value = item.validation
      return value && typeof value === 'object' && !Array.isArray(value)
        && (continuityCheckRounds(value) > 0 || typeof value.checkedRevision === 'number')
    })
    const value = latest?.validation
    const validation = value && typeof value === 'object' && !Array.isArray(value) ? value : null
    // A shape-free probe establishes reachability only. Actual manuscript CAS
    // requires all original delivery checks on this compilation/current body;
    // pending paid candidates can never certify a persisted assessment.
    const qualityReports = await tx.chapterQualityReport.findMany({
      where: { userId: subject.userId, novelId: subject.novelId, chapterId: chapter.id, runId: { in: runIds } },
      include: { findings: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    })
    const latestQuality = qualityReports[0]
    const decisionBound = latest ?? compilations.find(item => item.id === latestQuality?.compilationId)
    const decisionValidation = decisionBound?.validation && typeof decisionBound.validation === 'object' && !Array.isArray(decisionBound.validation)
      ? decisionBound.validation as Record<string, unknown> : null
    const decision = decisionValidation?.retainedReviewDecision as Record<string, unknown> | undefined
    if (current && decisionBound && decision?.chapterId === current.id && decision.revision === current.revision
      && decision.contentHash === runtimeJson({ content: current.content }).hash
      && decision.continuityBinding === continuityDecisionBinding(decisionBound.id, current.revision, decisionBound.validation)
      && decision.qualityReportId === (latestQuality && qualityReportCheckedCurrentContent(latestQuality, current.revision, current.content) ? latestQuality.id : null)
      && decision.qualityReportHash === (latestQuality && qualityReportCheckedCurrentContent(latestQuality, current.revision, current.content)
        ? qualityDecisionHash(latestQuality.findings) : null)) {
      throw new DataAccessError(409, 'REPAIR_NOT_AUTHORIZED', '当前全部候选已有逐项安全留置决定，正文未改变，原修订额度未消费；保留真实意见与原因交作者决定，不重复自动改写或宣称问题已解决。')
    }
    const assertMergedMutation = async (bound: typeof compilations[number]) => {
      if (!options?.mutation || !current || !authority) return
      const requirements = originalChapterReviewRequirements(original)
      const source = bound.bridge?.fromChapterId ? await tx.chapter.findFirst({ where: { id: bound.bridge.fromChapterId,
        ...activeChapterScope(subject.novelId) }, select: { id: true, revision: true, content: true } }) : null
      const continuity = bound.bridge && (!bound.bridge.fromChapterId || source?.revision === bound.bridge.sourceRevision)
        ? readCurrentCompilerContinuity({ ...bound, bridge: bound.bridge }, current, source).assessment : null
      const qualityComplete = latestQuality?.compilationId === bound.id
        && qualityReportCheckedCurrentContent(latestQuality, current.revision, current.content)
      if ((requirements.continuity && !continuity) || (requirements.quality && !qualityComplete)) {
        throw new DataAccessError(409, 'REVIEW_REPAIR_RECHECK_REQUIRED', '一次合并修订前必须完成同一编译、当前正文的全部原要求检查。保留正文与未消费的修订，补齐 continuity_validate 与 quality_analyze，再读取完整报告重新合并修订；不得沿用预先生成的改稿或重置次数。')
      }
      const candidates = (continuity?.errorCount ?? 0) + (qualityComplete ? selectAutomaticQualityFindings(latestQuality!.findings).length : 0)
      if (options.mutation === 'append' || (options.mutation === 'range' && !options.mergedBatch && candidates > 1)) {
        throw new DataAccessError(409, 'REVIEW_MERGED_REVISION_REQUIRED', '当前自动修订只允许一轮。读取当前正文与全部报告，核对证据，合并全部安全事实与质量修法，用一次 chapter_edit_range 的 patches 精确批量替换（最多8处），或一次 chapter_write 完整写入；不得逐次只修第一条。写入不证明全部意见已解决，不能据此宣称新版已检查通过。')
      }
      if (options.after !== undefined) {
        const before = current.content
        let start = 0, end = before.length, afterEnd = options.after.length
        while (start < end && start < afterEnd && before[start] === options.after[start]) start++
        while (end > start && afterEnd > start && before[end - 1] === options.after[afterEnd - 1]) { end--; afterEnd-- }
        const ranges = (options.editRanges ?? [{ start, end, newText: options.after.slice(start, afterEnd) }])
          .filter(range => before.slice(range.start, range.end) !== range.newText)
        const continuityBinding = continuityDecisionBinding(bound.id, current.revision, bound.validation)
        const entries = [
          ...(continuity && bound.validation && typeof bound.validation === 'object' && !Array.isArray(bound.validation)
            && Array.isArray(bound.validation.findings) ? bound.validation.findings.map(item => continuityFindingInputSchema.parse(item)) : []).flatMap((finding, index) => finding.severity === 'error' ? [{ source: 'continuity' as const,
            reportId: continuityBinding, findingId: String(index), evidence: finding.evidence, start: null as number | null, end: null as number | null }] : []),
          ...(qualityComplete ? selectAutomaticQualityFindings(latestQuality!.findings).map(finding => ({ source: 'quality' as const,
            reportId: latestQuality!.id, findingId: finding.id, evidence: finding.evidenceExcerpt, start: finding.startOffset, end: finding.endOffset })) : []),
        ]
        const retained = options.retainedFindings ?? []
        const keys = retained.map(item => `${item.source}:${item.reportId}:${item.findingId}`)
        if (new Set(keys).size !== keys.length || retained.some(item => !item.reason.trim() || !entries.some(entry =>
          entry.source === item.source && entry.reportId === item.reportId && entry.findingId === item.findingId))) {
          throw new DataAccessError(409, 'REVIEW_MERGED_REVISION_REQUIRED', '留置意见必须引用同一当前检查的真实意见，原因不能为空；旧报告、跨章或重复引用不允许写入。')
        }
        const covered = (entry: typeof entries[number]) => {
          if (entry.start !== null && entry.end !== null) return (options.editRanges ? ranges.some(range =>
            range.start < entry.end! && range.end > entry.start! && !range.newText.includes(entry.evidence))
            : !options.after!.includes(entry.evidence) && ranges.some(range => range.start < entry.end! && range.end > entry.start!))
          const quotes = [...entry.evidence.matchAll(/[“「『"‘]([^”」』"’]{2,360})[”」』"’]/gu)].map(match => match[1])
          if (before.includes(entry.evidence)) quotes.push(entry.evidence)
          return quotes.some(quote => {
            const offset = before.indexOf(quote)
            return offset >= 0 && before.indexOf(quote, offset + 1) < 0 && !options.after!.includes(quote)
              && ranges.some(range => range.start < offset + quote.length && range.end > offset)
          })
        }
        if (entries.some(entry => !covered(entry) && !retained.some(item => item.source === entry.source && item.reportId === entry.reportId && item.findingId === entry.findingId))) {
          throw new DataAccessError(409, 'REVIEW_MERGED_REVISION_REQUIRED', '一次合并修订须覆盖全部当前安全候选；没有原文可核验改动的意见，必须在 retainedFindings 引用当前检查绑定并写明具体留置原因。留置不清零事实错误，也不证明新版通过。')
        }
        if (before === options.after && retained.length) {
          await tx.storyCompilation.update({ where: { id: bound.id }, data: { validation: {
            ...(bound.validation && typeof bound.validation === 'object' && !Array.isArray(bound.validation) ? bound.validation : {}),
            retainedReviewDecision: { version: 1, chapterId: current.id, revision: current.revision,
              contentHash: runtimeJson({ content: before }).hash, continuityBinding, qualityReportId: qualityComplete ? latestQuality!.id : null,
              qualityReportHash: qualityComplete ? qualityDecisionHash(latestQuality!.findings) : null, findings: retained },
          } as Prisma.InputJsonValue } })
        }
      }
    }
    const findings = Array.isArray(validation?.findings) ? validation.findings.map(item => continuityFindingInputSchema.safeParse(item)) : null
    const errorCount = findings?.filter(item => item.success && item.data.severity === 'error').length ?? 0
    // A pending current-version factual error keeps the continuity channel open
    // for one merged correction; quality repair declares itself so it cannot
    // consume that channel before the facts are fixed.
    const factualWindow = !!latest && latest.status === 'active' && !!latest.bridge && !latest.bridge.committedAt
      && !!validation && validation.independentCheck === 'complete' && validation.checkedChapterId === current?.id
      && validation.checkedRevision === current?.revision && errorCount > 0 && validation.errorCount === errorCount
    if (!options?.requireQualityChannel && authority && current && compilations.every(item => continuityRepairRounds(item.validation) === 0)
      && latest?.status === 'active' && ['check', 'repair'].includes(latest.stage) && latest.bridge && !latest.bridge.committedAt
      && latest.bridge.toChapterId === current.id && latest.bridge.targetRevision === current.revision
      && latest.sceneTasks.length >= 1 && latest.sceneTasks.length <= 4
      && validation?.independentCheck === 'complete' && validation.checkedChapterId === current.id
      && validation.checkedRevision === current.revision && errorCount > 0 && validation.errorCount === errorCount
      && findings?.every(item => item.success)) {
      const source = latest.bridge.fromChapterId ? await tx.chapter.findFirst({ where: { id: latest.bridge.fromChapterId, ...activeChapterScope(subject.novelId) },
        select: { id: true, revision: true, content: true } }) : null
      const sourceCurrent = !latest.bridge.fromChapterId || source?.revision === latest.bridge.sourceRevision
      if (sourceCurrent && compilerContinuityCoverageMatches(validation.coverage, compilerContinuityCoverage({ chapter: current,
        bridge: latest.bridge, sceneTasks: latest.sceneTasks, source, focus: typeof validation.reviewFocus === 'string' ? validation.reviewFocus : undefined }))) {
        await assertMergedMutation(latest)
        // This closure is server-created and bound to the same transaction.
        // Call ONLY after its body CAS succeeds; failed CAS must not consume it.
        return async () => {
          await tx.storyCompilation.update({ where: { id: latest.id }, data: { validation: { ...validation,
            newDraftRevision: { version: 1, taskId: authority.taskId, chapterId: current.id, compilationId: latest.id, checkedRevision: current.revision,
              ...(options?.after !== undefined ? { beforeHash: runtimeJson({ content: current.content }).hash, afterHash: runtimeJson({ content: options.after }).hash,
                retainedFindings: options.retainedFindings ?? [] } : {}) },
          } as Prisma.InputJsonValue } })
        }
      }
    }
    if (authority && current && !factualWindow && compilations.every(item => continuityRepairRounds(item.validation) === 0)) {
      // The same merged correction also admits strict-mode quality advice: a
      // complete report bound to the active compilation may repair once, so
      // authored advice is applied instead of handed back unread.
      // Do not search past the newest assessment of this logical task/target:
      // a failed or still-running paid attempt cannot resurrect older advice.
      const quality = latestQuality && !!latestQuality.compilationId && latestQuality.repairRound === 0
        && qualityReportCheckedCurrentContent(latestQuality, current.revision, current.content)
        && selectAutomaticQualityFindings(latestQuality.findings).length > 0
        && (!!options?.mutation || qualityAutoRepairPending(latestQuality))
        && compilations.some(compilation => compilation.id === latestQuality.compilationId && compilation.status === 'active'
          && compilation.bridge && !compilation.bridge.committedAt) ? latestQuality : undefined
      // A pre-payment shape-free probe establishes reachability before the
      // report exists. Pending candidates are never a persisted assessment and
      // cannot authorize an actual mutation.
      const bound = quality ? compilations.find(item => item.id === quality.compilationId)!
        : !options?.mutation && options?.pendingQuality && options.pendingQuality.candidates > 0
          ? compilations.find(item => item.id === options.pendingQuality!.compilationId && item.status === 'active'
            && item.bridge && !item.bridge.committedAt)
          : undefined
      if (bound) {
        await assertMergedMutation(bound)
        return async () => {
          await tx.storyCompilation.update({ where: { id: bound.id }, data: { validation: {
            ...(bound.validation && typeof bound.validation === 'object' && !Array.isArray(bound.validation) ? bound.validation : {}),
            newDraftRevision: { version: 1, taskId: authority.taskId, chapterId: current.id, compilationId: bound.id, checkedRevision: current.revision,
              ...(options?.after !== undefined ? { beforeHash: runtimeJson({ content: current.content }).hash, afterHash: runtimeJson({ content: options.after }).hash,
                retainedFindings: options.retainedFindings ?? [] } : {}) },
          } as Prisma.InputJsonValue } })
        }
      }
    }
    if (authority && current && options?.mutation && compilations.every(item => continuityRepairRounds(item.validation) === 0)
      && latest?.status === 'active' && ['check', 'repair'].includes(latest.stage) && latest.bridge && !latest.bridge.committedAt) {
      await assertMergedMutation(latest)
    }
    if (authority && current && validation?.independentCheck === 'complete' && typeof validation.checkedRevision === 'number'
      && validation.checkedRevision < current.revision) {
      throw new DataAccessError(409, 'REVIEW_REPAIR_RECHECK_REQUIRED', `旧报告未检查当前 r${current.revision}，保留已保存正文，调用 continuity_validate 复核后再合并一次尚未执行的修订；不得重绑旧报告或增加自动修订次数。`)
    }
    throw new DataAccessError(409, 'REPAIR_NOT_AUTHORIZED', '本任务的原始作者请求未授权检查后改写正文，当前也没有可授权一次合并修订的完整证据（新稿通道需要当前版本、绑定活跃编译的完整检查与可修订候选）。保留连贯正文与报告，停止自动修订。如作者希望继续处理剩余意见，请在输入框重新发送一条明确指令（写明要处理的章节），系统将按新任务受理。')
  }
  const revisions = [...reports.map(item => item.chapterRevision), ...validations.flatMap(value =>
    typeof value.checkedRevision === 'number' && Number.isSafeInteger(value.checkedRevision) ? [value.checkedRevision] : [])]
  if (revisions.length && Math.max(...revisions) < chapter.revision) {
    throw new DataAccessError(409, 'REVIEW_REPAIR_RECHECK_REQUIRED', '这份检查报告后的修订已保存，旧报告不能继续驱动新版正文改写。将同一轮修改合并为一个完整补丁；保留当前稿件，在既有检查次数内复核，不能逐句重复修订。如作者希望继续处理剩余意见，请在输入框重新发送一条明确指令（写明要处理的章节），系统将按新任务受理。')
  }
}

/** Shared read-only probe for commit gates and pre-payment tool checks: it runs
 * the same admission checks and returns the rejection reason without ever
 * consuming the correction. Quality repair callers pass requireQualityChannel
 * so a pending factual error keeps its own channel; durable callers add
 * pendingQuality only to check pre-payment reachability. Actual mutations pass
 * their shape and require the final persisted assessments. */
export async function probeChapterReviewRevision(tx: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string }, chapter: { id: string; revision: number },
  options?: ChapterReviewRevisionOptions): Promise<{ open: true } | { open: false; code: string; message: string }> {
  try {
    await assertChapterReviewRevision(tx, subject, chapter, options)
    const original = await readOriginalTaskRequest(tx, subject)
    if (!hasOriginalRepairAuthority(original.prompt)) {
      // Closure evidence narrows automatic reachability only. It never adds
      // mutation authority, nor rejects a child merely for having a parent.
      const run = await tx.agentRun.findFirst({ where: { id: subject.runId, userId: subject.userId, novelId: subject.novelId },
        select: { mode: true, taskRootId: true, session: { select: { userId: true, novelId: true, sandboxMode: true, toolPolicy: true } } } })
      if (run?.session && (run.session.userId !== subject.userId || run.session.novelId !== subject.novelId)) {
        throw new DataAccessError(409, 'RUNTIME_SCOPE_MISMATCH', '当前会话归属无法核实，不能推断正文修订通道已关闭。')
      }
      const policy = run?.session.toolPolicy && typeof run.session.toolPolicy === 'object' && !Array.isArray(run.session.toolPolicy)
        ? run.session.toolPolicy as Record<string, unknown> : null
      let closed = run?.session.sandboxMode === 'read_only' || policy?.contentWrite === 'deny' || !!run && run.mode !== 'act'
      if (run?.taskRootId) {
        const { readExecutionStateInTransaction } = await import('./runtime-state.js')
        const { configuration } = await readExecutionStateInTransaction(tx, run.taskRootId)
        const contentWritable = ['chapter_write', 'chapter_edit_range'].some(name => configuration.tools.some(tool => tool.function.name === name)
          && configuration.toolAuthority.some(grant => grant.name === name && grant.permission !== 'deny'))
        // quality_analyze can itself execute its existing bounded auto-repair.
        // An inline quality child only saves reports, while a child with an
        // actual inherited chapter-writing grant remains legitimately open.
        const qualityWritable = configuration.creativeFreedom === 'balanced'
          && configuration.tools.some(tool => tool.function.name === 'quality_analyze')
          && configuration.toolAuthority.some(grant => grant.name === 'quality_analyze' && grant.permission === 'allow' && !grant.alwaysConfirm)
          && (await tx.agentChildExecutionGrant.findUnique({ where: { childRunId: subject.runId } }))?.kind !== 'inline'
          && (await readChapterReviewReadiness(tx, subject))?.continuityErrorCount === 0
        closed ||= configuration.mode !== 'build' || configuration.protectedChapterIds.includes(chapter.id)
          || (!contentWritable && !qualityWritable)
      }
      if (closed) return { open: false, code: 'REPAIR_NOT_AUTHORIZED', message: '当前服务端会话或原执行权限不允许自动写入此章；报告与真实剩余意见保留待审，正文未修改，不追加修订或宣称问题已解决。' }
    }
    return { open: true }
  } catch (error) {
    if (error instanceof DataAccessError && ['REPAIR_NOT_AUTHORIZED', 'REVIEW_AUTOMATION_STOPPED', 'REVIEW_REPAIR_RECHECK_REQUIRED', 'REVIEW_MERGED_REVISION_REQUIRED'].includes(error.code)) return { open: false, code: error.code, message: error.message }
    throw error
  }
}

/** Commit gates probe the same admission checks read-only before blocking a
 * terminal delivery: while a merged correction is still reachable the gate
 * holds the commit; once the channel is closed (consumed, exhausted or never
 * authorized) no tool can repair the remaining findings anymore, so the
 * "fix or hand it to the author" promise resolves to delivering with the
 * report. The CAS callback is deliberately dropped here. */
export async function isChapterRevisionChannelOpen(tx: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string }, chapter: { id: string; revision: number }): Promise<boolean> {
  return (await probeChapterReviewRevision(tx, subject, chapter)).open
}

/** Read-only tool feedback uses the same admission checks. The returned CAS
 * callback is deliberately never called here; feedback cannot consume a turn. */
export async function readChapterReviewRevisionGuidance(tx: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string }, chapter: { id: string; revision: number }) {
  try {
    await assertChapterManuscriptRevision(tx, subject, chapter, {})
    return '在原始作者写入授权内可连续修订本章；相关安全修法优先合并为 chapter_edit_range patches（每次最多8处），也可多次单片段替换或 chapter_write，每次使用当前正文与版本，不硬性限定一次调用。核对对象身份与逐字证据，报告不能扩大权限，不能机械照建议改剧情。不要求每次改文覆盖全部候选；未处理意见保留，可引用当前报告通过 retainedFindings 写明具体原因。留置、正文未变或写入均不表示意见已解决。全部修改后复核最终版本两类原要求检查，再提交终态；付费自动修订、检查次数与未知调用保护保持。'
  } catch (error) {
    if (error instanceof DataAccessError && ['REPAIR_NOT_AUTHORIZED', 'REVIEW_AUTOMATION_STOPPED', 'REVIEW_REPAIR_RECHECK_REQUIRED'].includes(error.code)) {
      return `${error.message}保留事实错误及其证据，当前版本不能宣称通过。`
    }
    throw error
  }
}
