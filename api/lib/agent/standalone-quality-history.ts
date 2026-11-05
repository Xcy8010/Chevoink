import type { Prisma } from '@prisma/client'
import { originalTaskRunIds, readOriginalTaskRequest } from './original-request.js'
import { REVIEW_REASSESSMENT_RULE } from './review-baseline.js'

/** Fresh critic input only. Deliberately outside the v14 bundle/hash: a saved
 * criticInput must resume byte for byte and a report cannot invalidate itself. */
export async function readStandalonePriorQualityJudgment(db: Prisma.TransactionClient,
  subject: { userId: string; novelId: string; runId: string }, chapter: { id: string; revision: number }) {
  const original = await readOriginalTaskRequest(db, subject), runIds = await originalTaskRunIds(db, subject, original)
  const report = await db.chapterQualityReport.findFirst({
    where: { userId: subject.userId, novelId: subject.novelId, chapterId: chapter.id, chapter: { authorId: subject.userId },
      runId: { in: runIds }, compilationId: null, status: { in: ['passed', 'needs_repair', 'repaired', 'stale'] },
      deterministicMetrics: { path: ['independentCheck'], equals: 'complete' },
      OR: [{ chapterRevision: { lt: chapter.revision } }, { chapterRevision: chapter.revision,
        AND: [{ deterministicMetrics: { path: ['sourceRevision'], lt: chapter.revision } }] }] },
    orderBy: [{ checkedAt: 'desc' }, { id: 'desc' }],
    select: { id: true, chapterRevision: true, status: true, deterministicMetrics: true,
      findings: { orderBy: [{ startOffset: 'asc' }, { id: 'asc' }], select: { id: true, signal: true, severity: true,
        startOffset: true, endOffset: true, evidenceExcerpt: true, explanation: true, suggestion: true,
        disposition: true, authorFeedback: true, feedbackReason: true } } },
  })
  if (!report) return null
  const metrics = report.deterministicMetrics && typeof report.deterministicMetrics === 'object' && !Array.isArray(report.deterministicMetrics) ? report.deterministicMetrics : {}
  const sourceRevision = typeof metrics.sourceRevision === 'number' ? metrics.sourceRevision : report.chapterRevision
  if (sourceRevision >= chapter.revision || metrics.independentCheck !== 'complete') return null
  return { taskId: original.taskId, reportId: report.id, reportRevision: report.chapterRevision, sourceRevision,
    sourceContentHash: typeof metrics.contentHash === 'string' ? metrics.contentHash : null,
    independentCheck: 'complete' as const, status: report.status, findings: report.findings,
    sourceContent: null, sourceContentStatus: 'not_recorded' as const }
}

export type StandalonePriorQualityJudgment = Awaited<ReturnType<typeof readStandalonePriorQualityJudgment>>
export function renderStandalonePriorQualityJudgment(judgment: StandalonePriorQualityJudgment): string {
  return judgment ? `${REVIEW_REASSESSMENT_RULE}\n同任务独立旧版质量判断（仅历史意见；处置不是当前复检；未保存的旧版全文保持未知）：${JSON.stringify(judgment)}` : ''
}
