import type { Prisma } from '@prisma/client'
import { DataAccessError } from '../prisma.js'
import { lockNovelActiveScope } from '../data/novel-write-lock.js'
import { continuityCheckRounds, MAX_CONTINUITY_CHECKS } from './story-compiler.js'
import { readOriginalTaskRequest, originalTaskRunIds, hasOriginalRepairAuthority } from './original-request.js'

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
  const compilations = await tx.storyCompilation.findMany({ where: {
    // Repreparing a compiler cannot erase the review that already drove a patch.
    runId: { in: runIds }, userId: subject.userId, novelId: subject.novelId, chapterId: chapter.id,
  }, select: { validation: true } })
  if (compilations.some(item => continuityCheckRounds(item.validation) >= MAX_CONTINUITY_CHECKS)) {
    throw new DataAccessError(409, 'REVIEW_AUTOMATION_STOPPED', '本章自动检查次数已用完，已停止后续自动改稿。检查上限不是正文错误；保留当前正文和原报告，不能靠改一句、换工具、添加检查范围或续跑恢复次数。')
  }
  const reports = await tx.chapterQualityReport.findMany({ where: {
    userId: subject.userId, novelId: subject.novelId, chapterId: chapter.id, runId: { in: runIds },
  }, select: { chapterRevision: true, repairRound: true } })
  if (reports.some(report => report.repairRound >= 1)) {
    throw new DataAccessError(409, 'REVIEW_AUTOMATION_STOPPED', '本章已完成一次检查后的整体修订，已停止继续自动改稿。保留当前正文与剩余意见，不再通过通用写工具绕过修订次数边界。')
  }
  const validations = compilations.flatMap(item => {
    const value = item.validation
    return value && typeof value === 'object' && !Array.isArray(value) ? [value] : []
  })
  const reviewed = reports.length > 0 || validations.some(value => continuityCheckRounds(value) > 0 || typeof value.checkedRevision === 'number')
  if (!reviewed) return
  if (!hasOriginalRepairAuthority(original.prompt)) {
    throw new DataAccessError(409, 'REPAIR_NOT_AUTHORIZED', '本任务的原始作者请求未授权检查后改写正文。检查警告、建议、失败或旧意见都不授予改稿权限；保留连贯正文与报告，停止自动修订。')
  }
  const revisions = [...reports.map(item => item.chapterRevision), ...validations.flatMap(value =>
    typeof value.checkedRevision === 'number' && Number.isSafeInteger(value.checkedRevision) ? [value.checkedRevision] : [])]
  if (revisions.length && Math.max(...revisions) < chapter.revision) {
    throw new DataAccessError(409, 'REVIEW_REPAIR_RECHECK_REQUIRED', '这份检查报告后的修订已保存，旧报告不能继续驱动新版正文改写。将同一轮修改合并为一个完整补丁；保留当前稿件，在既有检查次数内复核，不能逐句重复修订。')
  }
}
