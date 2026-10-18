import type { Prisma } from '@prisma/client'
import { prisma, DataAccessError } from '../prisma.js'
import { novelImportTransaction, type NovelImportHuman } from '../novel-import-service.js'
import { IMPORT_CLASSIFICATION_LIMITS, type ImportClassificationQuote, type ImportClassificationResult, type ImportClassificationSelection } from '../../../shared/contracts/novel-import-classification.js'

export interface ClassificationRow {
  id: string; jobId: string; userId: string; novelId: string; manifestRevision: number; manifestHash: string
  snapshotHash: string; fingerprint: string; quote: ImportClassificationQuote
  status: 'quoted' | 'pending' | 'succeeded' | 'failed'; result: ImportClassificationResult | null
  errorCode: string | null; expiresAt: Date; dispatchedAt: Date | null
  completedBatches: number; dispatchedBatches: number
  updatedAt: Date
}
export const classificationLiveStatuses = ['ready', 'needs_review', 'awaiting_confirmation']
export async function lockClassificationJob(tx: Prisma.TransactionClient, human: NovelImportHuman, jobId: string, selection: ImportClassificationSelection) {
  // A job-row lock serializes quote/claim/budget against cancellation and edits.
  await tx.$queryRaw`SELECT "id" FROM "novel_import_jobs" WHERE "id" = ${jobId} AND "userId" = ${human.userId} AND "novelId" = ${human.novelId} FOR UPDATE`
  const novel = await tx.novel.findFirst({ where: { id: human.novelId, authorId: human.userId }, select: { id: true } })
  const job = await tx.novelImportJob.findFirst({ where: { id: jobId, userId: human.userId, novelId: human.novelId } })
  if (!novel || !job) throw new DataAccessError(404, 'IMPORT_NOT_FOUND', '未找到导入任务。')
  if (!classificationLiveStatuses.includes(job.status) || job.expiresAt <= new Date() || job.manifestHash !== selection.manifestHash || job.manifestRevision !== selection.manifestRevision) throw new DataAccessError(409, 'IMPORT_CLASSIFICATION_STALE', '任务已取消、过期或预览变化，未应用分类。')
  return job
}
export async function findClassification(human: NovelImportHuman, jobId: string, id: string) {
  const rows = await prisma.$queryRaw<ClassificationRow[]>`SELECT * FROM "novel_import_classifications" WHERE "id" = ${id} AND "jobId" = ${jobId} AND "userId" = ${human.userId} AND "novelId" = ${human.novelId}`
  return rows[0]
}
export async function classificationRows(human: NovelImportHuman, jobId: string) {
  return prisma.$queryRaw<ClassificationRow[]>`SELECT * FROM "novel_import_classifications" WHERE "jobId" = ${jobId} AND "userId" = ${human.userId} AND "novelId" = ${human.novelId} ORDER BY "createdAt" ASC LIMIT 64`
}
export async function saveClassificationQuote(human: NovelImportHuman, jobId: string, quote: ImportClassificationQuote) {
  return novelImportTransaction(async tx => {
    await lockClassificationJob(tx, human, jobId, quote)
    const prior = await tx.$queryRaw<ClassificationRow[]>`SELECT * FROM "novel_import_classifications" WHERE "jobId" = ${jobId} AND "manifestRevision" = ${quote.manifestRevision}`
    if (prior[0] && prior[0].status !== 'quoted') throw new DataAccessError(409, 'IMPORT_CLASSIFICATION_ALREADY_REQUESTED', '此预览已发起分类，请读取已有结果；不会再次扣费。')
    const counts = await tx.$queryRaw<Array<{ total: bigint; dispatched: bigint }>>`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN "dispatchedAt" IS NOT NULL THEN ("quote"->>'batchCount')::int ELSE 0 END),0) AS dispatched FROM "novel_import_classifications" WHERE "jobId" = ${jobId}`
    if (Number(counts[0].dispatched) + quote.batchCount > IMPORT_CLASSIFICATION_LIMITS.dispatches || !prior.length && Number(counts[0].total) >= 64) throw new DataAccessError(429, 'IMPORT_CLASSIFICATION_BUDGET_REQUIRED', '本任务分类预算已用完，请手动分类；不会自动追加付费。')
    if (prior.length) await tx.$executeRaw`DELETE FROM "novel_import_classifications" WHERE "id" = ${prior[0].id} AND "status" = 'quoted'`
    await tx.$executeRaw`INSERT INTO "novel_import_classifications" ("id","jobId","userId","novelId","manifestRevision","manifestHash","snapshotHash","fingerprint","quote","expiresAt") VALUES (${quote.quoteId},${jobId},${human.userId},${human.novelId},${quote.manifestRevision},${quote.manifestHash},${quote.snapshotHash},${quote.fingerprint},${JSON.stringify(quote)}::jsonb,${new Date(quote.expiresAt)})`
    return quote
  })
}
export async function claimClassification(human: NovelImportHuman, jobId: string, quote: ImportClassificationQuote) {
  return novelImportTransaction(async tx => {
    const job = await lockClassificationJob(tx, human, jobId, quote)
    const rows = await tx.$queryRaw<ClassificationRow[]>`SELECT * FROM "novel_import_classifications" WHERE "id" = ${quote.quoteId} AND "jobId" = ${jobId} AND "userId" = ${human.userId} AND "novelId" = ${human.novelId} FOR UPDATE`
    const row = rows[0]
    if (!row || row.snapshotHash !== quote.snapshotHash || row.fingerprint !== quote.fingerprint) throw new DataAccessError(409, 'IMPORT_CLASSIFICATION_QUOTE_CHANGED', '报价已更新，请重新确认。')
    if (row.status !== 'quoted') return { row, dispatch: false, job }
    if (row.expiresAt <= new Date()) throw new DataAccessError(409, 'IMPORT_CLASSIFICATION_QUOTE_EXPIRED', '报价已过期，请重新获取并确认费用。')
    const counts = await tx.$queryRaw<Array<{ count: bigint }>>`SELECT COALESCE(SUM(("quote"->>'batchCount')::int),0) AS count FROM "novel_import_classifications" WHERE "jobId" = ${jobId} AND "dispatchedAt" IS NOT NULL`
    if (Number(counts[0].count) + quote.batchCount > IMPORT_CLASSIFICATION_LIMITS.dispatches) throw new DataAccessError(429, 'IMPORT_CLASSIFICATION_BUDGET_REQUIRED', '分类预算已用完，请手动分类。')
    const updated = await tx.$queryRaw<ClassificationRow[]>`UPDATE "novel_import_classifications" SET "status" = 'pending', "confirmedAt" = CURRENT_TIMESTAMP, "dispatchedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${row.id} AND "status" = 'quoted' RETURNING *`
    return { row: updated[0], dispatch: true, job }
  })
}
/** Persist a known paid result even when cancelled; applicability is independent.
 * An uncertain DB write can be replayed by reading this row, never by dispatch.
 */
export async function finishClassification(human: NovelImportHuman, row: ClassificationRow, result: ImportClassificationResult | null, errorCode: string | null) {
  const rows = await prisma.$queryRaw<ClassificationRow[]>`UPDATE "novel_import_classifications" SET "status" = ${errorCode ? 'failed' : 'succeeded'}, "result" = ${result ? JSON.stringify(result) : null}::jsonb, "errorCode" = ${errorCode}, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${row.id} AND "userId" = ${human.userId} AND "novelId" = ${human.novelId} AND "status" = 'pending' RETURNING *`
  return rows[0] ?? await findClassification(human, row.jobId, row.id) ?? row
}
export async function beginClassificationBatch(human: NovelImportHuman, row: ClassificationRow, index: number) {
  return novelImportTransaction(async tx => {
    await lockClassificationJob(tx, human, row.jobId, row)
    const count = await tx.$executeRaw`UPDATE "novel_import_classifications" SET "dispatchedBatches" = "dispatchedBatches" + 1, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${row.id} AND "status" = 'pending' AND "dispatchedBatches" = ${index} AND "dispatchedBatches" < ("quote"->>'batchCount')::int`
    if (count !== 1) throw new DataAccessError(409, 'IMPORT_CLASSIFICATION_ALREADY_REQUESTED', '此批次已派发，不会重复收费。')
  })
}
export async function saveClassificationProgress(human: NovelImportHuman, row: ClassificationRow, completed: number, result: ImportClassificationResult) {
  await prisma.$executeRaw`UPDATE "novel_import_classifications" SET "completedBatches" = ${completed}, "result" = ${JSON.stringify(result)}::jsonb, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${row.id} AND "userId" = ${human.userId} AND "novelId" = ${human.novelId} AND "status" = 'pending' AND "completedBatches" = ${completed - 1}`
}
