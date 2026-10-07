import { Prisma } from '@prisma/client'
import { DataAccessError } from '../prisma.js'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'
import { continuityCheckRounds, continuityRepairRounds, MAX_CONTINUITY_CHECKS } from './story-compiler.js'
import { readOriginalTaskRequest, originalTaskRunIds, hasOriginalRepairAuthority } from './original-request.js'
import { activeChapterScope } from '../data/internal.js'
import { compilerContinuityCoverage, compilerContinuityCoverageMatches, currentCompilerContinuityAssessment, completeCompilerContinuityAssessment, continuityStoryInput } from './compiler-continuity-contract.js'
import { qualityReportCheckedCurrentContent, selectAutomaticQualityFindings } from './quality-report-contract.js'
import { continuityFindingInputSchema } from '../../../shared/contracts/story-compiler-contracts.js'
import { runtimeJson } from './runtime-common.js'

type ReviewStatus = 'complete' | 'missing' | 'stale' | 'incomplete'
export type ChapterReviewRevisionOptions = {
  requireQualityChannel?: boolean
  /** Pending quality has no persisted report yet; check required continuity
   * before paying for a repair, without treating candidates as a report. */
  requireCurrentContinuity?: boolean
  mutation?: 'replace' | 'range' | 'append'
  pendingQuality?: { compilationId: string; candidates: number }
}
export type ChapterReviewReadiness = {
  ready: boolean; checksRequired: boolean; compilationId: string; chapterId: string; revision: number
  continuity: ReviewStatus; quality: ReviewStatus; continuityErrorCount: number; qualityErrorCount: number
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
  const continuity: ReviewStatus = assessment ? 'complete' : !validation ? 'missing' : !completeCompilerContinuityAssessment(validation) ? 'incomplete' : 'stale'
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
    continuityErrorCount: assessment?.errorCount ?? 0, qualityErrorCount: quality === 'complete' ? report!.findings.filter(finding =>
      finding.severity === 'error' && finding.disposition !== 'repaired' && finding.authorFeedback !== 'rejected').length : 0,
    qualityReportId: quality === 'complete' ? report!.id : null }
}

/** A review cannot enlarge the author's request. This guard runs in the same
 * manuscript transaction as CAS, for legacy, durable and quality repair writes.
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
    throw new DataAccessError(409, 'REVIEW_AUTOMATION_STOPPED', '本任务新稿已完成一次检查后的合并事实修订。保留当前正文和剩余意见，交作者决定；复核、换工具、父子任务或重新准备不能增加修订次数，不能宣称剩余问题已通过。如作者希望继续处理剩余意见，请在输入框重新发送一条明确指令（写明要处理的章节），系统将按新任务受理。')
  }
  const checksExhausted = compilations.some(item => continuityCheckRounds(item.validation) >= MAX_CONTINUITY_CHECKS)
  const reports = await tx.chapterQualityReport.findMany({ where: {
    userId: subject.userId, novelId: subject.novelId, chapterId: chapter.id, runId: { in: runIds },
  }, select: { chapterRevision: true, repairRound: true } })
  if (reports.some(report => report.repairRound >= 1)) {
    throw new DataAccessError(409, 'REVIEW_AUTOMATION_STOPPED', '本章已完成一次检查后的整体修订，已停止继续自动改稿。保留当前正文与剩余意见，不再通过通用写工具绕过修订次数边界。如作者希望继续处理剩余意见，请在输入框重新发送一条明确指令（写明要处理的章节），系统将按新任务受理。')
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
      if (!complete) throw new DataAccessError(409, 'REVIEW_REPAIR_RECHECK_REQUIRED', '质量报告照常保存；同一编译的当前正文尚未完成原要求连续性检查，不预约或付费自动修订。先在原检查次数内完成 continuity_validate，再根据全部当前报告合并一次尚未执行的授权修订。')
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
        throw new DataAccessError(409, 'REVIEW_REPAIR_RECHECK_REQUIRED', '一次合并修订前必须完成同一编译、当前正文的全部原要求检查。保留正文与未消费的修订，在原检查次数内补齐 continuity_validate 与 quality_analyze，再读取完整报告重新合并修订；不得沿用预先生成的改稿或重置次数。')
      }
      const candidates = (continuity?.errorCount ?? 0) + (qualityComplete ? selectAutomaticQualityFindings(latestQuality!.findings).length : 0)
      if (options.mutation === 'append' || (options.mutation === 'range' && candidates > 1)) {
        throw new DataAccessError(409, 'REVIEW_MERGED_REVISION_REQUIRED', '本章只有一次合并修订机会。先读取完整正文与全部当前报告，核对证据并合并全部安全修法，用一次 chapter_write 提交完整正文；不得只修第一条或追加片段。完整写入仅保证一次整体提交，不能据此宣称全部问题已修复。')
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
            newDraftRevision: { version: 1, taskId: authority.taskId, chapterId: current.id, compilationId: latest.id, checkedRevision: current.revision },
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
            newDraftRevision: { version: 1, taskId: authority.taskId, chapterId: current.id, compilationId: bound.id, checkedRevision: current.revision },
          } as Prisma.InputJsonValue } })
        }
      }
    }
    if (authority && current && options?.mutation && compilations.every(item => continuityRepairRounds(item.validation) === 0)
      && latest?.status === 'active' && ['check', 'repair'].includes(latest.stage) && latest.bridge && !latest.bridge.committedAt) {
      await assertMergedMutation(latest)
    }
    if (checksExhausted) throw new DataAccessError(409, 'REVIEW_AUTOMATION_STOPPED', '本章自动检查次数已用完，保留正文和原报告，不增加检查或修订次数。')
    if (authority && current && validation?.independentCheck === 'complete' && typeof validation.checkedRevision === 'number'
      && validation.checkedRevision < current.revision) {
      throw new DataAccessError(409, 'REVIEW_REPAIR_RECHECK_REQUIRED', `旧报告未检查当前 r${current.revision}，保留已保存正文，在原检查次数内调用 continuity_validate 复核后再合并一次尚未执行的修订；不得重绑旧报告或增加修订次数。`)
    }
    throw new DataAccessError(409, 'REPAIR_NOT_AUTHORIZED', '本任务的原始作者请求未授权检查后改写正文，当前也没有可授权一次合并修订的完整证据（新稿通道需要当前版本、绑定活跃编译的完整检查与可修订候选）。保留连贯正文与报告，停止自动修订。如作者希望继续处理剩余意见，请在输入框重新发送一条明确指令（写明要处理的章节），系统将按新任务受理。')
  }
  if (checksExhausted) throw new DataAccessError(409, 'REVIEW_AUTOMATION_STOPPED', '本章自动检查次数已用完，保留正文和原报告，不增加检查或修订次数。')
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
    const consume = await assertChapterReviewRevision(tx, subject, chapter)
    return consume
      ? '本章属于原写作任务新建目标，只能作一次合并修订：先完成当前正文的全部原要求检查，读取完整正文与全部报告，一次校对错误的对象身份及原文引证，确认是同一对象同一维度的互斥事实；报告与 suggestion 不能代替原文事实，不机械照建议改剧情。多项候选必须将全部安全事实与质量修法合并为一次 chapter_write 完整写入，不能只修第一条再逐句追加。完整写入不证明全部问题已修复，不追求零警告；一次修订后保留剩余意见交作者决定，复核或换工具不能增加次数。'
      : '仅在原请求明确授权的修订范围内合并修改；保留剩余意见交作者决定，不为零警告反复改写。'
  } catch (error) {
    if (error instanceof DataAccessError && ['REPAIR_NOT_AUTHORIZED', 'REVIEW_AUTOMATION_STOPPED', 'REVIEW_REPAIR_RECHECK_REQUIRED'].includes(error.code)) {
      return `${error.message}保留事实错误及其证据，当前版本不能宣称通过。`
    }
    throw error
  }
}
