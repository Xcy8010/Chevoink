import { Prisma } from '@prisma/client'
import { DataAccessError } from '../prisma.js'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'
import { continuityCheckRounds, continuityRepairRounds, MAX_CONTINUITY_CHECKS } from './story-compiler.js'
import { readOriginalTaskRequest, originalTaskRunIds, hasOriginalRepairAuthority } from './original-request.js'
import { activeChapterScope } from '../data/internal.js'
import { compilerContinuityCoverage, compilerContinuityCoverageMatches } from './compiler-continuity-contract.js'
import { continuityFindingInputSchema } from '../../../shared/contracts/story-compiler-contracts.js'

/** A review cannot enlarge the author's request. This guard runs in the same
 * manuscript transaction as CAS, for legacy, durable and quality repair writes.
 * It never promotes failed/stale reports into a current quality conclusion. */
export async function assertChapterReviewRevision(
  tx: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string },
  chapter: { id: string; revision: number },
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
  if (compilations.some(item => continuityCheckRounds(item.validation) >= MAX_CONTINUITY_CHECKS)) {
    throw new DataAccessError(409, 'REVIEW_AUTOMATION_STOPPED', '本章自动检查次数已用完，已停止后续自动改稿。检查上限不是正文错误；保留当前正文和原报告，不能靠改一句、换工具、添加检查范围或续跑恢复次数。如作者希望继续处理剩余意见，请在输入框重新发送一条明确指令（写明要处理的章节），系统将按新任务受理。')
  }
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
    const findings = Array.isArray(validation?.findings) ? validation.findings.map(item => continuityFindingInputSchema.safeParse(item)) : null
    const errorCount = findings?.filter(item => item.success && item.data.severity === 'error').length ?? 0
    if (authority && current && compilations.every(item => continuityRepairRounds(item.validation) === 0)
      && latest?.status === 'active' && latest.stage === 'check' && latest.bridge && !latest.bridge.committedAt
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
        // This closure is server-created and bound to the same transaction.
        // Call ONLY after its body CAS succeeds; failed CAS must not consume it.
        return async () => {
          await tx.storyCompilation.update({ where: { id: latest.id }, data: { validation: { ...validation,
            newDraftRevision: { version: 1, taskId: authority.taskId, chapterId: current.id, compilationId: latest.id, checkedRevision: current.revision },
          } as Prisma.InputJsonValue } })
        }
      }
    }
    throw new DataAccessError(409, 'REPAIR_NOT_AUTHORIZED', '本任务的原始作者请求未授权检查后改写正文。检查警告、建议、失败或旧意见都不授予改稿权限；保留连贯正文与报告，停止自动修订。如作者希望继续处理剩余意见，请在输入框重新发送一条明确指令（写明要处理的章节），系统将按新任务受理。')
  }
  const revisions = [...reports.map(item => item.chapterRevision), ...validations.flatMap(value =>
    typeof value.checkedRevision === 'number' && Number.isSafeInteger(value.checkedRevision) ? [value.checkedRevision] : [])]
  if (revisions.length && Math.max(...revisions) < chapter.revision) {
    throw new DataAccessError(409, 'REVIEW_REPAIR_RECHECK_REQUIRED', '这份检查报告后的修订已保存，旧报告不能继续驱动新版正文改写。将同一轮修改合并为一个完整补丁；保留当前稿件，在既有检查次数内复核，不能逐句重复修订。如作者希望继续处理剩余意见，请在输入框重新发送一条明确指令（写明要处理的章节），系统将按新任务受理。')
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
  try {
    await assertChapterReviewRevision(tx, subject, chapter)
    return true
  } catch (error) {
    if (error instanceof DataAccessError && ['REPAIR_NOT_AUTHORIZED', 'REVIEW_AUTOMATION_STOPPED', 'REVIEW_REPAIR_RECHECK_REQUIRED'].includes(error.code)) return false
    throw error
  }
}

/** Read-only tool feedback uses the same admission checks. The returned CAS
 * callback is deliberately never called here; feedback cannot consume a turn. */
export async function readChapterReviewRevisionGuidance(tx: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string }, chapter: { id: string; revision: number }) {
  try {
    const consume = await assertChapterReviewRevision(tx, subject, chapter)
    return consume
      ? '本章属于原写作任务新建目标，当前完整报告中的事实错误可作一次合并修订：先读取完整正文，一次校对全部错误的对象身份及原文引证，确认是同一对象同一维度的互斥事实；报告与 suggestion 不能代替原文事实，不机械照建议改剧情。将全部安全事实修法合并为一次 chapter_write 或一个覆盖相关段落的补丁，不能只修第一条再逐句追加。仅修事实，不追求零警告；一次修订后保留剩余意见交作者决定，复核或换工具不能增加次数。'
      : '仅在原请求明确授权的修订范围内合并修改；保留剩余意见交作者决定，不为零警告反复改写。'
  } catch (error) {
    if (error instanceof DataAccessError && ['REPAIR_NOT_AUTHORIZED', 'REVIEW_AUTOMATION_STOPPED', 'REVIEW_REPAIR_RECHECK_REQUIRED'].includes(error.code)) {
      return `${error.message}保留事实错误及其证据，当前版本不能宣称通过。`
    }
    throw error
  }
}
